import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import {
  buildAgentChildEnv,
  registerChild,
  spawnShellPty,
  unregisterChild,
  type ShellPty,
} from "@deskmony/adapters";
import {
  DeskmonyError,
  TERMINAL_BUFFER_MAX_CHARS,
  TERMINAL_MAX_GLOBAL,
  TERMINAL_MAX_PER_SESSION,
  type Session,
  type TerminalAttachResult,
  type TerminalInfo,
  type TerminalOutputPush,
  type TerminalUpdatedPush,
} from "@deskmony/shared";
import type { AuditLog } from "../enforcement/audit-log.js";

/**
 * TerminalManager(2026-10-20,右側面板 Terminal 分頁,見 docs/LAYER-4-detail-design/side-panel_detail.md §P1.1、
 * docs/DECISIONS.md §L.1):session 底下的獨立 shell 終端。
 *
 * 與 `GenericPtyAdapter`(`software="pty"` 的 session 本身就是一個終端程式)無關:這裡的終端掛在**任何** session
 * 底下,cwd = 該 session 的工作資料夾,session 刪除時一併關掉(index.ts 訂閱 `SessionManager` 的 `"session-deleted"`),
 * core 重啟後不保留(不持久化)。
 *
 * ## 安全
 *
 * 終端是**完全不經政策引擎**的執行路徑,而且遠端 client 也能開(使用者明確的選擇,DECISIONS §L.1)。所以:
 *  - shell 的環境變數一律經 `buildAgentChildEnv()`——使用者在終端裡自己跑 `claude` 之類的 CLI 時,子行程不該繼承
 *    `DESKMONY_AUTH_TOKEN`(拿到它就等於使用者本人);
 *  - 使用者要求的開/關都寫稽核(`appendTerminalSession`),記錄來源是不是遠端;
 *  - 這個類別不認得 scoped bridge token——gateway 的方法白名單本來就不含 `terminal.*`,agent 永遠開不了終端。
 *
 * ## 輸出與 attach 的一致性
 *
 * pty 的輸出先累積在 `pending`,約 16 ms 後合併成**一個**片段:拿到單調遞增的 `seq`(每個終端各自從 1 起算)、
 * 進環狀緩衝、再 emit `"terminal-output"`。`attach()` 只回傳**已經 flush 過**的片段與最後一個 `seq`,還沒 flush 的
 * 輸出之後會以更大的 `seq` 推出去——client 先訂閱 push、再 attach,丟掉 `seq <= 回傳 seq` 的 push,就不會重複或遺漏
 * (見 `TerminalOutputPushSchema`)。刻意**不**在 attach 裡強制 flush:那會讓「回傳的 seq」與「已經送出的 push」
 * 在 attach 回應之前就先到達 client,多一個要處理的時序。
 */

/** 同一個終端輸出合併的視窗(毫秒)。 */
const OUTPUT_COALESCE_MS = 16;
const COLS_MIN = 2;
const COLS_MAX = 500;
const ROWS_MIN = 1;
const ROWS_MAX = 300;

export interface TerminalSessionLookup {
  getSession(sessionId: string): Promise<Session | undefined>;
}

/** 發出請求的那條連線的來源(稽核用)。 */
export interface TerminalRequestOrigin {
  remote: boolean;
  remoteAddress: string;
}

interface OutputChunk {
  seq: number;
  data: string;
}

interface TerminalRecord {
  info: TerminalInfo;
  pty: ShellPty;
  chunks: OutputChunk[];
  bufferedChars: number;
  seq: number;
  pending: string;
  flushTimer: ReturnType<typeof setTimeout> | undefined;
  /** `close()` 已經開始:shell 結束事件不再當成「自己結束」處理。 */
  closing: boolean;
  exited: boolean;
}

interface ResolvedShell {
  file: string;
  args: string[];
  name: string;
}

function findOnPath(fileName: string): string | undefined {
  const pathValue = process.env.PATH ?? process.env.Path ?? "";
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, fileName);
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    } catch {
      // ignore — 無法存取的目錄直接略過
    }
  }
  return undefined;
}

/**
 * 第一版不提供設定:Windows 先找 PATH 上的 `pwsh.exe`,沒有就 `powershell.exe`(`-NoLogo`);其他平台用 `$SHELL`,
 * 沒有就 `/bin/bash`。
 */
export function resolveShell(): ResolvedShell {
  if (process.platform === "win32") {
    const file = findOnPath("pwsh.exe") ?? findOnPath("powershell.exe") ?? "powershell.exe";
    return { file, args: ["-NoLogo"], name: path.basename(file, path.extname(file)).toLowerCase() };
  }
  const file = process.env.SHELL || "/bin/bash";
  return { file, args: [], name: path.basename(file) };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

export class TerminalManager extends EventEmitter {
  private readonly terminals = new Map<string, TerminalRecord>();
  /** 每個 session 累計開過幾個終端——預設標題的序號只增不減(關掉 1 號之後新開的是 3 號,不會撞名)。 */
  private readonly titleCounters = new Map<string, number>();

  constructor(
    private readonly sessions: TerminalSessionLookup,
    private readonly auditLog: AuditLog,
  ) {
    super();
  }

  async create(
    input: { sessionId: string; cols: number; rows: number },
    origin: TerminalRequestOrigin,
  ): Promise<TerminalInfo> {
    const session = await this.sessions.getSession(input.sessionId);
    if (!session) {
      throw new DeskmonyError("terminal.sessionNotFound", { sessionId: input.sessionId }, `找不到 session: ${input.sessionId}`);
    }
    const cwd = session.workingDir;
    let cwdOk = false;
    try {
      cwdOk = statSync(cwd).isDirectory();
    } catch {
      cwdOk = false;
    }
    if (!cwdOk) {
      throw new DeskmonyError("terminal.cwdMissing", { sessionId: session.id, cwd }, `session 的工作資料夾不存在:${cwd}`);
    }

    // 上限檢查與下面的 spawn/登記之間沒有 await,所以並行的兩個 create 不會一起擠過上限。
    let inSession = 0;
    for (const rec of this.terminals.values()) if (rec.info.sessionId === session.id) inSession += 1;
    if (inSession >= TERMINAL_MAX_PER_SESSION) {
      throw new DeskmonyError(
        "terminal.limitReached",
        { scope: "session", limit: TERMINAL_MAX_PER_SESSION, perSession: TERMINAL_MAX_PER_SESSION, global: TERMINAL_MAX_GLOBAL },
        `這個 session 最多同時開 ${TERMINAL_MAX_PER_SESSION} 個終端`,
      );
    }
    if (this.terminals.size >= TERMINAL_MAX_GLOBAL) {
      throw new DeskmonyError(
        "terminal.limitReached",
        { scope: "global", limit: TERMINAL_MAX_GLOBAL, perSession: TERMINAL_MAX_PER_SESSION, global: TERMINAL_MAX_GLOBAL },
        `全部 session 加起來最多同時開 ${TERMINAL_MAX_GLOBAL} 個終端`,
      );
    }

    const shell = resolveShell();
    const cols = clamp(input.cols, COLS_MIN, COLS_MAX);
    const rows = clamp(input.rows, ROWS_MIN, ROWS_MAX);
    let shellPty: ShellPty;
    try {
      shellPty = spawnShellPty({
        file: shell.file,
        args: shell.args,
        cwd,
        // 見檔頭「安全」:濾掉 Deskmony 內部憑證。
        env: buildAgentChildEnv({ TERM: "xterm-256color", COLORTERM: "truecolor" }),
        cols,
        rows,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new DeskmonyError("terminal.spawnFailed", { shell: shell.name, detail }, `無法啟動 ${shell.name}:${detail}`);
    }

    const ordinal = (this.titleCounters.get(session.id) ?? 0) + 1;
    this.titleCounters.set(session.id, ordinal);
    const record: TerminalRecord = {
      info: {
        id: randomUUID(),
        sessionId: session.id,
        title: `${shell.name} ${ordinal}`,
        shell: shell.name,
        cwd,
        cols,
        rows,
        createdAt: Date.now(),
      },
      pty: shellPty,
      chunks: [],
      bufferedChars: 0,
      seq: 0,
      pending: "",
      flushTimer: undefined,
      closing: false,
      exited: false,
    };
    this.terminals.set(record.info.id, record);

    shellPty.onData((data) => this.handleData(record, data));
    shellPty.onExit(({ exitCode }) => this.handleExit(record, exitCode));
    // 崩潰後的孤兒回收(child-registry.ts):shell 本身登記;非同步、不 await。
    void registerChild(shellPty.pid, `terminal:${shell.name}`, () => record.exited);

    this.auditLog.appendTerminalSession({
      action: "create",
      terminalId: record.info.id,
      sessionId: session.id,
      shell: shell.name,
      remote: origin.remote,
      remoteAddress: origin.remoteAddress,
      ts: Date.now(),
    });
    const info = this.snapshot(record);
    this.emit("terminal-updated", { terminal: info } satisfies TerminalUpdatedPush);
    return info;
  }

  async list(sessionId: string): Promise<TerminalInfo[]> {
    const session = await this.sessions.getSession(sessionId);
    if (!session) {
      throw new DeskmonyError("terminal.sessionNotFound", { sessionId }, `找不到 session: ${sessionId}`);
    }
    return [...this.terminals.values()].filter((rec) => rec.info.sessionId === sessionId).map((rec) => this.snapshot(rec));
  }

  attach(terminalId: string): TerminalAttachResult {
    const record = this.mustGet(terminalId);
    const last = record.chunks[record.chunks.length - 1];
    return {
      terminal: this.snapshot(record),
      buffer: record.chunks.map((chunk) => chunk.data).join(""),
      seq: last?.seq ?? 0,
    };
  }

  /** 已結束的 shell 收到輸入就吞掉(UI 此時顯示「程序已結束」與重新啟動鈕,不會再送輸入)。 */
  input(terminalId: string, data: string): void {
    const record = this.mustGet(terminalId);
    if (record.exited) return;
    try {
      record.pty.write(data);
    } catch {
      // ignore — 行程剛好在這一刻結束
    }
  }

  resize(terminalId: string, cols: number, rows: number): void {
    const record = this.mustGet(terminalId);
    record.info.cols = clamp(cols, COLS_MIN, COLS_MAX);
    record.info.rows = clamp(rows, ROWS_MIN, ROWS_MAX);
    if (!record.exited) record.pty.resize(record.info.cols, record.info.rows);
  }

  /**
   * 結束 shell(含子程序樹)、從清單移除、發 `terminal-updated`(`closed: true`)。先移除再等行程消失——UI 立刻能
   * 把分頁收掉;`pty.kill()` 在行程確認消失(或逾時)後才 resolve,所以 RPC 的回應反映真實狀態。
   * `origin` 有值 = 使用者要求的關閉,寫稽核;session 刪除/core 關閉連帶關掉的不帶(見 `TerminalSessionDetail`)。
   */
  async close(terminalId: string, origin?: TerminalRequestOrigin): Promise<void> {
    const record = this.mustGet(terminalId);
    await this.closeRecord(record, origin);
  }

  /** `SessionManager` 的 `"session-deleted"`:關掉該 session 底下全部終端。 */
  async closeSession(sessionId: string): Promise<void> {
    const records = [...this.terminals.values()].filter((rec) => rec.info.sessionId === sessionId);
    this.titleCounters.delete(sessionId);
    await Promise.all(records.map((rec) => this.closeRecord(rec)));
  }

  /** core 關閉時呼叫。 */
  async closeAll(): Promise<void> {
    await Promise.all([...this.terminals.values()].map((rec) => this.closeRecord(rec)));
  }

  private async closeRecord(record: TerminalRecord, origin?: TerminalRequestOrigin): Promise<void> {
    if (record.closing) return;
    record.closing = true;
    this.flush(record);
    this.terminals.delete(record.info.id);
    if (origin) {
      this.auditLog.appendTerminalSession({
        action: "close",
        terminalId: record.info.id,
        sessionId: record.info.sessionId,
        shell: record.info.shell,
        remote: origin.remote,
        remoteAddress: origin.remoteAddress,
        ts: Date.now(),
      });
    }
    this.emit("terminal-updated", { terminal: { ...this.snapshot(record), closed: true } } satisfies TerminalUpdatedPush);
    await record.pty.kill();
    unregisterChild(record.pty.pid);
  }

  private mustGet(terminalId: string): TerminalRecord {
    const record = this.terminals.get(terminalId);
    if (!record) {
      throw new DeskmonyError("terminal.notFound", { terminalId }, `找不到終端: ${terminalId}`);
    }
    return record;
  }

  private snapshot(record: TerminalRecord): TerminalInfo {
    return { ...record.info };
  }

  private handleData(record: TerminalRecord, data: string): void {
    if (record.closing) return;
    record.pending += data;
    record.flushTimer ??= setTimeout(() => this.flush(record), OUTPUT_COALESCE_MS);
  }

  private flush(record: TerminalRecord): void {
    if (record.flushTimer) {
      clearTimeout(record.flushTimer);
      record.flushTimer = undefined;
    }
    if (record.pending.length === 0) return;
    const data = record.pending;
    record.pending = "";
    record.seq += 1;
    const chunk: OutputChunk = { seq: record.seq, data };
    record.chunks.push(chunk);
    record.bufferedChars += data.length;
    // 環狀緩衝:超過上限就丟最舊的片段;單一片段本身就超過上限時只留尾巴。
    while (record.bufferedChars > TERMINAL_BUFFER_MAX_CHARS && record.chunks.length > 1) {
      record.bufferedChars -= record.chunks.shift()!.data.length;
    }
    if (record.chunks.length === 1 && record.bufferedChars > TERMINAL_BUFFER_MAX_CHARS) {
      const only = record.chunks[0];
      only.data = only.data.slice(only.data.length - TERMINAL_BUFFER_MAX_CHARS);
      record.bufferedChars = only.data.length;
    }
    this.emit("terminal-output", {
      terminalId: record.info.id,
      sessionId: record.info.sessionId,
      seq: chunk.seq,
      data,
    } satisfies TerminalOutputPush);
  }

  /** shell 自己結束(使用者打了 `exit`):留在清單裡、帶 `exitCode`,等使用者關掉或重新啟動。 */
  private handleExit(record: TerminalRecord, exitCode: number | null): void {
    record.exited = true;
    if (record.closing) return; // `close()` 會自己處理收尾
    this.flush(record);
    record.info.exitCode = exitCode;
    unregisterChild(record.pty.pid);
    this.emit("terminal-updated", { terminal: this.snapshot(record) } satisfies TerminalUpdatedPush);
  }
}
