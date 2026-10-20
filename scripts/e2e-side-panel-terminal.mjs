#!/usr/bin/env node
/**
 * scripts/e2e-side-panel-terminal.mjs
 *
 * 2026-10-20(右側面板 P1:Terminal 分頁,見 docs/LAYER-4-detail-design/side-panel_detail.md §P1.5、
 * docs/DECISIONS.md §L.1)端到端測試。**決定性**:隔離的 core(**帶 `DESKMONY_AUTH_TOKEN` 啟動**,真實桌面 app 的 core
 * 就是這樣)+ fake ACP agent 建 session;終端是真的 shell(Windows 的 pwsh/powershell、其他平台的 `$SHELL`)。
 *
 * 用 shell 自己印出的值驗證,而不是靠「輸入的回顯」——輸入的字串本身也會出現在 shell 的輸出裡,所以標記一律拆成兩段、
 * 由 shell 在輸出時才拼起來(例如 `echo ("MK_" + "abc")` 輸入裡是分開的、輸出才是 `MK_abc`)。
 *
 *   ST-1   terminal.create:回傳 TerminalInfo、收到 terminal-updated、cwd 是 session 的工作資料夾(shell 自己印的 cwd 也是)、
 *          尺寸照給、第二個終端標題序號遞增。
 *   ST-2   送 echo 標記 → terminal-output 收到;attach 的 buffer 與「seq <= 回傳 seq 的 push 串起來」逐字相同、seq 連續從 1 起算。
 *   ST-3   終端環境:DESKMONY_AUTH_TOKEN 與環境裡殘留的 DESKMONY_MCP_BRIDGE_* 都是空的(主 token 沒有出現在任何輸出),TERM 正確。
 *   ST-4   resize 成功並夾在範圍內;input 超過 64 KB 被拒(gateway.invalidRequest)。
 *   ST-5   shell 自己結束(exit 3):留在清單、exitCode=3、收到 terminal-updated(非 closed)。
 *   ST-6   close:收到 closed:true、shell 的 pid 已不存在、清單移除、再 attach → terminal.notFound。
 *   ST-7   刪除 session → 它的終端全部關閉(closed:true、pid 不存在)、不影響別的 session 的終端。
 *   ST-8   上限:同一 session 第 9 個被拒(terminal.limitReached)。
 *   ST-9   不存在的 terminalId / sessionId 的錯誤碼。
 *   ST-10  scoped bridge token 呼叫任何 terminal.* 被拒(gateway.scopedTokenForbidden);scoped 連線收不到 terminal-output 與 terminal-updated,
 *          同一批事件一般連線收得到。
 *   ST-11  稽核表有 terminal-session 的 create/close(remote=false、來源位址、session id);session 刪除連帶關閉與 shell 自己結束不記。
 *   ST-12  core 重啟後終端清單是空的(不持久化);工作資料夾不存在 → terminal.cwdMissing。
 *
 * 用法:node scripts/e2e-side-panel-terminal.mjs
 * 前置需求:pnpm build 已跑過(dist 是最新的)
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireFreshBuild } from "./lib/require-fresh-build.mjs";
import { e2eProvidersEnv, FAKE_ACP } from "./lib/e2e-providers.mjs";
import { REPORT_MCP_SERVERS_PREFIX } from "./fake-acp-agent.mjs";

requireFreshBuild();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const CORE_ENTRY = path.join(REPO_ROOT, "apps", "core", "dist", "index.js");
/** 避開其他 e2e 用過的 port(見 e2e-cli.mjs 檔頭的盤點;4840/4841 沒人用)。 */
const PORT_A = 4840;
const PORT_B = 4841;
const IS_WIN = process.platform === "win32";
const MASTER_TOKEN = `e2e-master-${randomBytes(16).toString("hex")}`;
/** 環境裡殘留的 bridge 憑證(假的)——終端裡必須看不到。 */
const AMBIENT_BRIDGE_TOKEN = `ambient-bridge-${randomBytes(8).toString("hex")}`;
const INPUT_MAX_CHARS = 65_536;
const SESSION_LIMIT = 8;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`\n[${ok ? "PASS" : "FAIL"}] ${name}`);
  if (detail) console.log(`       ${detail}`);
}

async function waitUntil(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = await predicate();
    if (hit) return hit;
    await sleep(40);
  }
  throw new Error(`等待逾時(${timeoutMs}ms):${label}`);
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

async function killProcessTree(proc, label) {
  if (!proc || proc.exitCode !== null || proc.killed) return;
  console.log(`[cleanup] 終止 ${label}(pid=${proc.pid}) ...`);
  try {
    if (IS_WIN) spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
    else proc.kill("SIGKILL");
  } catch (err) {
    console.log(`[cleanup] 終止 ${label} 時發生錯誤(忽略): ${err}`);
  }
  await sleep(700);
}

function startCore({ port, dataDir, homeDir, workspaceDir }) {
  const env = {
    ...process.env,
    DESKMONY_CORE_PORT: String(port),
    DESKMONY_DATA_DIR: dataDir,
    DESKMONY_HOME: homeDir,
    DESKMONY_WORKSPACE: workspaceDir,
    ...e2eProvidersEnv(),
    // 前提:真實桌面 app 裡 core 就是帶著主認證 token 啟動的;另外環境裡有一個殘留的 bridge 憑證。
    DESKMONY_AUTH_TOKEN: MASTER_TOKEN,
    DESKMONY_MCP_BRIDGE_TOKEN: AMBIENT_BRIDGE_TOKEN,
  };
  const proc = spawn(process.execPath, [CORE_ENTRY], { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  proc.stdout.on("data", (chunk) => process.stdout.write(`[core:${port}] ${chunk}`));
  proc.stderr.on("data", (chunk) => process.stderr.write(`[core:${port}:err] ${chunk}`));
  return proc;
}

async function waitForPort(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const ws = new WebSocket(url);
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("connect timeout")), 1500);
        ws.addEventListener("open", () => {
          clearTimeout(t);
          resolve();
        });
        ws.addEventListener("error", () => {
          clearTimeout(t);
          reject(new Error("connect error"));
        });
      });
      ws.close();
      return true;
    } catch (err) {
      lastErr = err;
      await sleep(300);
    }
  }
  throw new Error(`等待 gateway 啟動逾時: ${lastErr}`);
}

class GatewayClient {
  constructor(url) {
    this.url = url;
    this.pendingRpc = new Map();
    /** 所有 push(依到達順序)。 */
    this.pushes = [];
    /** terminalId → [{seq, data}](依到達順序)。 */
    this.chunks = new Map();
    /** terminalId → 最新一筆 terminal-updated 的 terminal。 */
    this.updates = [];
  }

  async connect(token) {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("WS connect timeout")), 10_000);
      this.ws.addEventListener("open", () => {
        clearTimeout(t);
        resolve();
      });
      this.ws.addEventListener("error", (e) => {
        clearTimeout(t);
        reject(new Error(`WS error: ${e.message ?? e}`));
      });
    });
    this.ws.addEventListener("message", (e) => this._handleMessage(e.data));
    if (token !== undefined) await this.rpc("auth", { token });
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
  }

  _handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : raw.toString());
    } catch {
      return;
    }
    if (msg.kind === "response") {
      const pending = this.pendingRpc.get(msg.id);
      if (pending) {
        this.pendingRpc.delete(msg.id);
        if (msg.ok) pending.resolve(msg.result);
        else {
          const err = new Error(msg.error ?? "unknown gateway error");
          err.errorCode = msg.errorCode;
          err.errorParams = msg.errorParams;
          pending.reject(err);
        }
      }
      return;
    }
    if (msg.kind === "event") {
      this.pushes.push({ channel: msg.channel, payload: msg.payload });
      if (msg.channel === "terminal-output") {
        const list = this.chunks.get(msg.payload.terminalId) ?? [];
        list.push({ seq: msg.payload.seq, data: msg.payload.data });
        this.chunks.set(msg.payload.terminalId, list);
      } else if (msg.channel === "terminal-updated") {
        this.updates.push(msg.payload.terminal);
      }
    }
  }

  rpc(method, params, timeoutMs = 30_000) {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pendingRpc.delete(id);
        reject(new Error(`rpc ${method} 逾時 (${timeoutMs}ms)`));
      }, timeoutMs);
      this.pendingRpc.set(id, {
        resolve: (v) => {
          clearTimeout(t);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(t);
          reject(e);
        },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** 這個終端到目前為止收到的所有輸出(依 seq 串起來)。 */
  outputOf(terminalId) {
    return (this.chunks.get(terminalId) ?? []).map((c) => c.data).join("");
  }

  /** 這個終端最近一次 terminal-updated 的內容。 */
  lastUpdateOf(terminalId) {
    return [...this.updates].reverse().find((t) => t.id === terminalId);
  }

  /** 等一個 session 這一輪 completed/error,回傳這一輪的文字(同 e2e-session-network.mjs 的 drivePrompt,精簡版)。 */
  async drivePrompt(sessionId, text, timeoutMs = 60_000) {
    const start = this.pushes.length;
    await this.rpc("session.sendPrompt", { sessionId, prompt: { text } });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const mine = this.pushes.slice(start).filter((p) => p.channel === "session-event" && p.payload.sessionId === sessionId);
      if (mine.some((p) => p.payload.event.type === "completed" || p.payload.event.type === "error")) {
        return mine
          .filter((p) => p.payload.event.type === "message-delta")
          .map((p) => p.payload.event.delta)
          .join("");
      }
      await sleep(50);
    }
    throw new Error("逾時等待 completed/error 事件");
  }
}

/** 對 rpc 的結果做「被拒絕」的分類,回傳錯誤碼(沒被拒絕回 undefined)。 */
async function rejectionCode(promise) {
  try {
    await promise;
    return undefined;
  } catch (err) {
    return err.errorCode ?? `no-code:${err.message}`;
  }
}

// ---- 跨平台的 shell 指令(輸出才會拼出標記,輸入的回顯裡是拆開的)--------------------------------------------
const cmd = {
  marker: (a, b) => (IS_WIN ? `echo ("${a}" + "${b}")` : `echo ${a}""${b}`),
  pid: () => (IS_WIN ? `echo ("SHELL" + "PID=" + $PID)` : `echo SHELL""PID=$`),
  cwd: () => (IS_WIN ? `echo ("CWD" + "_IS=" + (Get-Location).Path)` : `echo CWD""_IS=$PWD`),
  term: () => (IS_WIN ? `echo ("TERM" + "_IS=" + $env:TERM)` : `echo TERM""_IS=$TERM`),
  envProbe: (name, tag) =>
    IS_WIN
      ? `if ($env:${name}) { echo ("LEAKED_" + "${tag}") } else { echo ("EMPTY_" + "${tag}") }`
      : `if [ -n "$${name}" ]; then echo LEAKED_""${tag}; else echo EMPTY_""${tag}; fi`,
  exit: (code) => `exit ${code}`,
};

/** 對終端送一行指令(補 `\r`)並等輸出出現指定的正規表示式,回傳第一個 match。 */
async function runInTerminal(client, terminalId, line, regex, timeoutMs = 30_000) {
  await client.rpc("terminal.input", { terminalId, data: `${line}\r` });
  let match;
  await waitUntil(
    () => {
      match = client.outputOf(terminalId).match(regex);
      return match;
    },
    timeoutMs,
    `終端輸出出現 ${regex}`,
  );
  return match;
}

async function readAudit(dataDir, kind) {
  // better-sqlite3 不是這個 script 所在目錄的直接依賴,借用 apps/core 已安裝好的那一份(同 e2e-session-network.mjs)。
  const betterSqlite3 = path.join(REPO_ROOT, "apps", "core", "node_modules", "better-sqlite3", "lib", "index.js");
  const { default: Database } = await import(pathToFileURL(betterSqlite3).href);
  const db = new Database(path.join(dataDir, "deskmony.db"), { readonly: true });
  try {
    return db
      .prepare("SELECT kind, session_id AS sessionId, reason, payload FROM enforcement_audit WHERE kind = ?")
      .all(kind)
      .map((row) => ({ ...row, detail: JSON.parse(row.payload) }));
  } finally {
    db.close();
  }
}

function sameDir(a, b) {
  const norm = (p) => path.resolve(p).replace(/[\\/]+$/, "");
  return IS_WIN ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
}

// ---- 主流程 -------------------------------------------------------------------------------

async function main() {
  if (!existsSync(CORE_ENTRY)) {
    console.error(`找不到 ${CORE_ENTRY},請先執行 pnpm build`);
    process.exit(1);
  }
  const startTime = Date.now();
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-term-data-"));
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-term-home-"));
  const ws1 = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-term-ws1-"));
  const ws2 = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-term-ws2-"));
  const ws3 = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-term-ws3-"));
  const ws4 = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-term-ws4-"));

  let coreA;
  let coreB;
  let client;
  let control;
  let scoped;
  let client2;
  /** 測試途中開的所有終端(結尾保險:萬一哪一步中途失敗,最後統一收掉,避免殘留 shell)。 */
  const openedTerminalIds = new Set();
  let coreAKilled = false;

  try {
    console.log(`[setup] dataDir=${dataDir}\n[setup] homeDir=${homeDir}`);
    coreA = startCore({ port: PORT_A, dataDir, homeDir, workspaceDir: ws1 });
    const urlA = `ws://127.0.0.1:${PORT_A}`;
    await waitForPort(urlA, 20_000);
    client = new GatewayClient(urlA);
    await client.connect(MASTER_TOKEN);
    control = new GatewayClient(urlA); // 對照組:另一條一般連線,同樣收得到 push
    await control.connect(MASTER_TOKEN);
    console.log("[setup] core 已啟動並連線(帶主 token)");

    const mk = async (dir, title) => (await client.rpc("session.create", { providerId: FAKE_ACP, workingDir: dir, title })).session;
    const S1 = await mk(ws1, "term-1");
    const S2 = await mk(ws2, "term-2");
    const S3 = await mk(ws3, "term-3");
    const S4 = await mk(ws4, "term-4");
    const createTerm = async (sessionId, cols = 100, rows = 30) => {
      const { terminal } = await client.rpc("terminal.create", { sessionId, cols, rows });
      openedTerminalIds.add(terminal.id);
      return terminal;
    };
    const shellPidOf = async (terminalId) => {
      const m = await runInTerminal(client, terminalId, cmd.pid(), /SHELLPID=(\d+)/);
      return Number(m[1]);
    };

    // ===================================================================================
    // ST-1 create
    // ===================================================================================
    let t1;
    let t1Pid;
    try {
      const pushesBefore = client.updates.length;
      t1 = await createTerm(S1.id, 120, 30);
      const created = client.updates.slice(pushesBefore).find((t) => t.id === t1.id && !t.closed);
      const cwdMatch = await runInTerminal(client, t1.id, cmd.cwd(), IS_WIN ? /CWD_IS=([A-Za-z]:[^\r\n]+)/ : /CWD_IS=(\/[^\r\n]+)/);
      const t1b = await createTerm(S1.id, 80, 24);
      record(
        "ST-1 terminal.create:回傳 TerminalInfo(sessionId、cwd = session 工作資料夾、尺寸照給、title 為「<shell> <序號>」且第二個遞增)、收到 terminal-updated、shell 自己印的 cwd 也是工作資料夾",
        t1.sessionId === S1.id &&
          sameDir(t1.cwd, S1.workingDir) &&
          t1.cols === 120 &&
          t1.rows === 30 &&
          typeof t1.id === "string" &&
          typeof t1.createdAt === "number" &&
          t1.closed === undefined &&
          t1.exitCode === undefined &&
          t1.title === `${t1.shell} 1` &&
          t1b.title === `${t1b.shell} 2` &&
          Boolean(created) &&
          sameDir(cwdMatch[1].trim(), S1.workingDir),
        `t1=${JSON.stringify(t1)}, t1b.title=${t1b.title}, shell cwd=${cwdMatch[1]}`,
      );
      await client.rpc("terminal.close", { terminalId: t1b.id });
    } catch (err) {
      record("ST-1 terminal.create", false, String(err?.stack ?? err));
    }

    // ===================================================================================
    // ST-2 輸出 + attach 的 seq 一致性
    // ===================================================================================
    try {
      const a = `MK_${randomBytes(4).toString("hex")}`;
      const b = randomBytes(4).toString("hex");
      await runInTerminal(client, t1.id, cmd.marker(a, b), new RegExp(`${a}${b}`));
      const controlSaw = await waitUntil(() => control.outputOf(t1.id).includes(`${a}${b}`), 10_000, "另一條連線也收到標記");
      const attached = await client.rpc("terminal.attach", { terminalId: t1.id });
      const mine = client.chunks.get(t1.id) ?? [];
      const upto = mine.filter((c) => c.seq <= attached.seq);
      const contiguous = mine.every((c, i) => c.seq === i + 1);
      const joined = upto.map((c) => c.data).join("");
      record(
        "ST-2 輸出:標記從 terminal-output 收到(兩條連線都有);attach 的 buffer 含標記,且與「seq <= 回傳 seq 的 push 串起來」逐字相同、seq 從 1 連續遞增",
        controlSaw === true &&
          attached.buffer.includes(`${a}${b}`) &&
          attached.terminal.id === t1.id &&
          attached.seq >= 1 &&
          contiguous &&
          joined === attached.buffer,
        `attach.seq=${attached.seq}, pushes=${mine.length}, buffer長度=${attached.buffer.length}, joined長度=${joined.length}, contiguous=${contiguous}`,
      );
      t1Pid = await shellPidOf(t1.id);
    } catch (err) {
      record("ST-2 輸出與 attach", false, String(err?.stack ?? err));
    }

    // ===================================================================================
    // ST-3 環境變數
    // ===================================================================================
    try {
      const token = await runInTerminal(client, t1.id, cmd.envProbe("DESKMONY_AUTH_TOKEN", "A"), /(LEAKED_A|EMPTY_A)/);
      const bridge = await runInTerminal(client, t1.id, cmd.envProbe("DESKMONY_MCP_BRIDGE_TOKEN", "B"), /(LEAKED_B|EMPTY_B)/);
      const term = await runInTerminal(client, t1.id, cmd.term(), /TERM_IS=([^\r\n]*)/);
      const everything = client.outputOf(t1.id);
      record(
        "ST-3 終端環境變數:DESKMONY_AUTH_TOKEN 與環境裡殘留的 DESKMONY_MCP_BRIDGE_TOKEN 在終端裡都是空的(經 buildAgentChildEnv()),主 token/殘留 bridge token 沒有出現在任何輸出;TERM=xterm-256color",
        token[1] === "EMPTY_A" &&
          bridge[1] === "EMPTY_B" &&
          !everything.includes(MASTER_TOKEN) &&
          !everything.includes(AMBIENT_BRIDGE_TOKEN) &&
          term[1].trim() === "xterm-256color",
        `token=${token[1]}, bridge=${bridge[1]}, TERM=${JSON.stringify(term[1])}`,
      );
    } catch (err) {
      record("ST-3 終端環境變數", false, String(err?.stack ?? err));
    }

    // ===================================================================================
    // ST-4 resize / input 上限
    // ===================================================================================
    try {
      const r1 = await client.rpc("terminal.resize", { terminalId: t1.id, cols: 100, rows: 40 });
      const l1 = (await client.rpc("terminal.list", { sessionId: S1.id })).terminals.find((t) => t.id === t1.id);
      await client.rpc("terminal.resize", { terminalId: t1.id, cols: 9999, rows: 9999 });
      const l2 = (await client.rpc("terminal.list", { sessionId: S1.id })).terminals.find((t) => t.id === t1.id);
      await client.rpc("terminal.resize", { terminalId: t1.id, cols: 1, rows: 1 });
      const l3 = (await client.rpc("terminal.list", { sessionId: S1.id })).terminals.find((t) => t.id === t1.id);
      await client.rpc("terminal.resize", { terminalId: t1.id, cols: 100, rows: 30 });
      const tooBig = await rejectionCode(client.rpc("terminal.input", { terminalId: t1.id, data: "x".repeat(INPUT_MAX_CHARS + 1) }));
      const emptyInput = await rejectionCode(client.rpc("terminal.input", { terminalId: t1.id, data: "" }));
      record(
        "ST-4 resize 成功並夾在 cols 2–500、rows 1–300;input 超過 64 KB(65537 字元)被拒(gateway.invalidRequest)",
        r1.ok === true &&
          l1?.cols === 100 &&
          l1.rows === 40 &&
          l2?.cols === 500 &&
          l2.rows === 300 &&
          l3?.cols === 2 &&
          l3.rows === 1 &&
          tooBig === "gateway.invalidRequest" &&
          emptyInput === undefined,
        `resize=${JSON.stringify([l1?.cols, l1?.rows])}/${JSON.stringify([l2?.cols, l2?.rows])}/${JSON.stringify([l3?.cols, l3?.rows])}, tooBig=${tooBig}`,
      );
    } catch (err) {
      record("ST-4 resize/input 上限", false, String(err?.stack ?? err));
    }

    // ===================================================================================
    // ST-5 shell 自己結束
    // ===================================================================================
    let t5;
    let t5Pid;
    try {
      t5 = await createTerm(S1.id);
      t5Pid = await shellPidOf(t5.id);
      await client.rpc("terminal.input", { terminalId: t5.id, data: `${cmd.exit(3)}\r` });
      const exited = await waitUntil(() => {
        const u = client.lastUpdateOf(t5.id);
        return u && u.exitCode !== undefined ? u : undefined;
      }, 20_000, "shell 結束後收到帶 exitCode 的 terminal-updated");
      const listed = (await client.rpc("terminal.list", { sessionId: S1.id })).terminals.find((t) => t.id === t5.id);
      const inputAfter = await rejectionCode(client.rpc("terminal.input", { terminalId: t5.id, data: "echo hi\r" }));
      await waitUntil(() => !pidAlive(t5Pid), 10_000, "shell 結束後 pid 消失");
      record(
        "ST-5 shell 自己結束(exit 3):留在清單裡、exitCode=3、收到 terminal-updated(沒有 closed);對已結束的終端送 input 不報錯(吞掉)",
        exited.exitCode === 3 && exited.closed === undefined && listed?.exitCode === 3 && inputAfter === undefined,
        `update=${JSON.stringify(exited)}, listed.exitCode=${listed?.exitCode}, inputAfter=${inputAfter}`,
      );
      await client.rpc("terminal.close", { terminalId: t5.id });
    } catch (err) {
      record("ST-5 shell 自己結束", false, String(err?.stack ?? err));
    }

    // ===================================================================================
    // ST-6 close
    // ===================================================================================
    try {
      const before = client.updates.length;
      await client.rpc("terminal.close", { terminalId: t1.id });
      const closedPush = client.updates.slice(before).find((t) => t.id === t1.id && t.closed === true);
      await waitUntil(() => !pidAlive(t1Pid), 10_000, "close 後 shell 的 pid 消失");
      const listed = (await client.rpc("terminal.list", { sessionId: S1.id })).terminals;
      const attachAfter = await rejectionCode(client.rpc("terminal.attach", { terminalId: t1.id }));
      record(
        "ST-6 close:收到 terminal-updated(closed:true)、shell 的 pid 已不存在、從清單移除、再 attach → terminal.notFound",
        Boolean(closedPush) && !pidAlive(t1Pid) && !listed.some((t) => t.id === t1.id) && attachAfter === "terminal.notFound",
        `pid=${t1Pid}, closedPush=${Boolean(closedPush)}, listed=${listed.length}, attachAfter=${attachAfter}`,
      );
    } catch (err) {
      record("ST-6 close", false, String(err?.stack ?? err));
    }

    // ===================================================================================
    // ST-7 刪除 session → 它的終端全部關閉
    // ===================================================================================
    let s2Terminals = [];
    try {
      const a = await createTerm(S2.id);
      const b = await createTerm(S2.id);
      const keep = await createTerm(S3.id); // 別的 session 的終端不受影響
      s2Terminals = [a, b];
      const pids = [await shellPidOf(a.id), await shellPidOf(b.id)];
      const keepPid = await shellPidOf(keep.id);
      const before = client.updates.length;
      await client.rpc("session.delete", { sessionId: S2.id });
      await waitUntil(() => pids.every((pid) => !pidAlive(pid)), 20_000, "刪除 session 後它的終端 pid 全部消失");
      const closedIds = new Set(client.updates.slice(before).filter((t) => t.closed === true).map((t) => t.id));
      const listAfter = await rejectionCode(client.rpc("terminal.list", { sessionId: S2.id }));
      const keepList = (await client.rpc("terminal.list", { sessionId: S3.id })).terminals;
      record(
        "ST-7 刪除 session → 它的終端全部關閉(closed:true、pid 不存在),別的 session 的終端不受影響",
        closedIds.has(a.id) && closedIds.has(b.id) && pids.every((pid) => !pidAlive(pid)) && listAfter === "terminal.sessionNotFound" && keepList.some((t) => t.id === keep.id) && pidAlive(keepPid),
        `pids=${pids.join(",")}, closed=${[...closedIds].length}, listAfter=${listAfter}, keepAlive=${pidAlive(keepPid)}`,
      );
      await client.rpc("terminal.close", { terminalId: keep.id });
    } catch (err) {
      record("ST-7 刪除 session 連帶關閉終端", false, String(err?.stack ?? err));
    }

    // ===================================================================================
    // ST-8 上限
    // ===================================================================================
    try {
      const made = [];
      for (let i = 0; i < SESSION_LIMIT; i++) made.push(await createTerm(S3.id, 80, 24));
      const ninth = await rejectionCode(client.rpc("terminal.create", { sessionId: S3.id, cols: 80, rows: 24 }));
      // 別的 session 不受每個 session 的上限影響
      const other = await createTerm(S4.id, 80, 24);
      record(
        `ST-8 上限:同一 session 開滿 ${SESSION_LIMIT} 個後第 9 個被拒(terminal.limitReached),別的 session 仍可開`,
        made.length === SESSION_LIMIT && ninth === "terminal.limitReached" && Boolean(other.id),
        `ninth=${ninth}`,
      );
      await Promise.all([...made, other].map((t) => client.rpc("terminal.close", { terminalId: t.id })));
    } catch (err) {
      record("ST-8 上限", false, String(err?.stack ?? err));
    }

    // ===================================================================================
    // ST-9 錯誤碼
    // ===================================================================================
    try {
      const nope = "00000000-0000-4000-8000-000000000000";
      const codes = {
        attach: await rejectionCode(client.rpc("terminal.attach", { terminalId: nope })),
        input: await rejectionCode(client.rpc("terminal.input", { terminalId: nope, data: "x" })),
        resize: await rejectionCode(client.rpc("terminal.resize", { terminalId: nope, cols: 80, rows: 24 })),
        close: await rejectionCode(client.rpc("terminal.close", { terminalId: nope })),
        createNoSession: await rejectionCode(client.rpc("terminal.create", { sessionId: nope, cols: 80, rows: 24 })),
        listNoSession: await rejectionCode(client.rpc("terminal.list", { sessionId: nope })),
      };
      record(
        "ST-9 不存在的 terminalId → terminal.notFound(attach/input/resize/close);不存在的 sessionId → terminal.sessionNotFound(create/list)",
        codes.attach === "terminal.notFound" &&
          codes.input === "terminal.notFound" &&
          codes.resize === "terminal.notFound" &&
          codes.close === "terminal.notFound" &&
          codes.createNoSession === "terminal.sessionNotFound" &&
          codes.listNoSession === "terminal.sessionNotFound",
        JSON.stringify(codes),
      );
    } catch (err) {
      record("ST-9 錯誤碼", false, String(err?.stack ?? err));
    }

    // ===================================================================================
    // ST-10 scoped bridge token
    // ===================================================================================
    try {
      // 取出 S1 這個 session 真實核發的 scoped token(同 e2e-session-network.mjs 的手法)
      const text = await client.drivePrompt(S1.id, REPORT_MCP_SERVERS_PREFIX, 30_000);
      const marker = "MCP_SERVERS:";
      const mcpServers = JSON.parse(text.slice(text.indexOf(marker) + marker.length));
      const env = Object.fromEntries((mcpServers[0].env ?? []).map((e) => [e.name, e.value]));
      scoped = new GatewayClient(env.DESKMONY_MCP_BRIDGE_GATEWAY_URL);
      await scoped.connect(env.DESKMONY_MCP_BRIDGE_TOKEN);
      const probeTerm = await createTerm(S1.id, 80, 24);
      const forbiddenCalls = {
        create: await rejectionCode(scoped.rpc("terminal.create", { sessionId: S1.id, cols: 80, rows: 24 })),
        list: await rejectionCode(scoped.rpc("terminal.list", { sessionId: S1.id })),
        attach: await rejectionCode(scoped.rpc("terminal.attach", { terminalId: probeTerm.id })),
        input: await rejectionCode(scoped.rpc("terminal.input", { terminalId: probeTerm.id, data: "echo pwned\r" })),
        resize: await rejectionCode(scoped.rpc("terminal.resize", { terminalId: probeTerm.id, cols: 80, rows: 24 })),
        close: await rejectionCode(scoped.rpc("terminal.close", { terminalId: probeTerm.id })),
      };
      const a = `SC_${randomBytes(4).toString("hex")}`;
      const b = randomBytes(4).toString("hex");
      await runInTerminal(client, probeTerm.id, cmd.marker(a, b), new RegExp(`${a}${b}`));
      await sleep(800);
      const stillThere = (await client.rpc("terminal.list", { sessionId: S1.id })).terminals.some((t) => t.id === probeTerm.id);
      const scopedTerminalPushes = scoped.pushes.filter((p) => p.channel === "terminal-output" || p.channel === "terminal-updated").length;
      const controlSaw = control.outputOf(probeTerm.id).includes(`${a}${b}`);
      record(
        "ST-10 scoped bridge token 呼叫任何 terminal.*(create/list/attach/input/resize/close)都被拒(gateway.scopedTokenForbidden)、終端沒被動到;scoped 連線一則 terminal-output/terminal-updated 都收不到(同一批輸出一般連線收得到)",
        Object.values(forbiddenCalls).every((code) => code === "gateway.scopedTokenForbidden") &&
          stillThere &&
          scoped.pushes.length === 0 &&
          scopedTerminalPushes === 0 &&
          controlSaw &&
          !client.outputOf(probeTerm.id).includes("pwned\r\n"),
        `forbidden=${JSON.stringify(forbiddenCalls)}, scoped push 總數=${scoped.pushes.length}, controlSaw=${controlSaw}`,
      );
      await client.rpc("terminal.close", { terminalId: probeTerm.id });
    } catch (err) {
      record("ST-10 scoped bridge token", false, String(err?.stack ?? err));
    }

    // ===================================================================================
    // ST-11 稽核
    // ===================================================================================
    try {
      const rows = await readAudit(dataDir, "terminal-session");
      const creates = rows.filter((r) => r.detail.action === "create");
      const closes = rows.filter((r) => r.detail.action === "close");
      const t1Create = creates.find((r) => r.detail.terminalId === t1.id);
      const t1Close = closes.find((r) => r.detail.terminalId === t1.id);
      const t5Create = creates.find((r) => r.detail.terminalId === t5.id);
      const t5Close = closes.find((r) => r.detail.terminalId === t5.id);
      const s2Creates = creates.filter((r) => s2Terminals.some((t) => t.id === r.detail.terminalId));
      const s2Closes = closes.filter((r) => s2Terminals.some((t) => t.id === r.detail.terminalId));
      record(
        "ST-11 稽核表有 terminal-session 的 create/close(session id、shell、remote=false、來源位址 127.0.0.1);session 刪除連帶關閉的終端只有 create、沒有 close;shell 自己結束不另記(之後使用者按關閉才有一筆 close)",
        Boolean(t1Create) &&
          Boolean(t1Close) &&
          t1Create.sessionId === S1.id &&
          t1Create.detail.sessionId === S1.id &&
          t1Create.detail.shell === t1.shell &&
          t1Create.detail.remote === false &&
          t1Create.detail.remoteAddress === "127.0.0.1" &&
          t1Close.detail.remote === false &&
          t1Close.detail.remoteAddress === "127.0.0.1" &&
          typeof t1Create.detail.ts === "number" &&
          Boolean(t5Create) &&
          closes.filter((r) => r.detail.terminalId === t5.id).length === 1 &&
          Boolean(t5Close) &&
          s2Creates.length === 2 &&
          s2Closes.length === 0,
        `rows=${rows.length}(create ${creates.length}/close ${closes.length}), t1Create=${JSON.stringify(t1Create?.detail)}`,
      );
    } catch (err) {
      record("ST-11 稽核", false, String(err?.stack ?? err));
    }

    // ===================================================================================
    // ST-12 core 重啟:不保留;工作資料夾不存在 → cwdMissing
    // ===================================================================================
    try {
      const survivor = await createTerm(S1.id, 80, 24); // 故意留一個開著,core 被強制終止
      client.close();
      control.close();
      scoped?.close();
      await killProcessTree(coreA, "主 core(強制終止,模擬崩潰;shell 隨行程樹一起消失)");
      coreAKilled = true;
      rmSync(ws4, { recursive: true, force: true }); // S4 的工作資料夾消失(此時沒有任何行程佔著它)
      coreB = startCore({ port: PORT_B, dataDir, homeDir, workspaceDir: ws1 });
      const urlB = `ws://127.0.0.1:${PORT_B}`;
      await waitForPort(urlB, 20_000);
      client2 = new GatewayClient(urlB);
      await client2.connect(MASTER_TOKEN);
      const listAfter = await client2.rpc("terminal.list", { sessionId: S1.id });
      const attachAfter = await rejectionCode(client2.rpc("terminal.attach", { terminalId: survivor.id }));
      const missing = await rejectionCode(client2.rpc("terminal.create", { sessionId: S4.id, cols: 80, rows: 24 }));
      record(
        "ST-12 core 重啟後終端清單是空的(不持久化,舊 terminalId → terminal.notFound);session 的工作資料夾不存在 → terminal.cwdMissing",
        listAfter.terminals.length === 0 && attachAfter === "terminal.notFound" && missing === "terminal.cwdMissing",
        `list=${listAfter.terminals.length}, attach=${attachAfter}, create(無資料夾)=${missing}`,
      );
    } catch (err) {
      record("ST-12 core 重啟", false, String(err?.stack ?? err));
    }
  } catch (err) {
    console.error(`\n[FATAL] ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    record("e2e 整體設置", false, String(err?.stack ?? err));
  } finally {
    // 保險:任何還開著的終端都收掉(core A 還活著時;已經收過的 id 會得到 terminal.notFound,忽略)。
    if (client && !coreAKilled) {
      await Promise.allSettled([...openedTerminalIds].map((id) => client.rpc("terminal.close", { terminalId: id }, 5_000)));
    }
    client?.close();
    control?.close();
    scoped?.close();
    client2?.close();
    await killProcessTree(coreA, "主 core");
    await killProcessTree(coreB, "重啟後的 core");
    for (const dir of [dataDir, homeDir, ws1, ws2, ws3, ws4]) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }

  // ---- 結果統計 ----
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n${"=".repeat(50)}`);
  console.log(`P1(面板終端) e2e 結果 (${elapsed}s)`);
  console.log(`${"=".repeat(50)}`);
  let pass = 0;
  let fail = 0;
  for (const r of results) {
    console.log(`  ${r.ok ? "PASS" : "FAIL"} ${r.name}`);
    if (!r.ok && r.detail) console.log(`       ${r.detail}`);
    if (r.ok) pass++;
    else fail++;
  }
  console.log(`\n總計: ${pass} PASS, ${fail} FAIL`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
