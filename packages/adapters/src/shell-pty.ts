import { spawn } from "node:child_process";
import * as pty from "node-pty";
import type { IPty } from "node-pty";

/**
 * shell-pty.ts(2026-10-20,右側面板 Terminal 分頁,見 docs/LAYER-4-detail-design/side-panel_detail.md §P1.1):
 * 替 `apps/core` 的 `TerminalManager` 開一個**獨立的 shell 偽終端**。
 *
 * 為什麼放在 adapters、不讓 core 直接 `import "node-pty"`:node-pty 是 `packages/adapters` 的相依(原生模組,
 * 打包時只有它一處需要處理,見 scripts/bundle-core.mjs 對 node-pty 的說明),core 沒有宣告它——在 core 再加一份
 * 直接相依會多一個要維護的版本與打包路徑。這裡只暴露最小介面,core 不必認得 `IPty`。
 *
 * 與 `GenericPtyAdapter`(pty-adapter.ts)的差別:那個是「agent 本身就是一個終端程式」、掛在 `AgentAdapter` 介面下;
 * 這裡是 session 底下額外開的 shell,沒有 AgentEvent、沒有 capabilities,只有原始的輸入輸出。node-pty 的呼叫方式
 * (Windows 走預設 ConPTY、`kill()` 之後再補一刀 `taskkill /T /F`)比照 pty-adapter.ts,差別只在終止是**非同步**的
 * (`kill()` 回傳的 Promise 在行程確實消失後才 resolve)——同步的 `spawnSync("taskkill")` 在 WMI 變慢的機器上會把
 * 整個 core 的事件迴圈卡住(見 child-registry.ts「登記不能卡住事件迴圈」的同一類問題),而關閉終端是使用者在 UI
 * 上隨手按的動作,不能讓它凍住所有連線。
 */

export interface ShellPtySpawnOptions {
  /** 可執行檔(建議給絕對路徑)。 */
  file: string;
  args: string[];
  cwd: string;
  /** 完整的子行程環境。呼叫端負責濾掉 Deskmony 內部憑證(`buildAgentChildEnv()`)。 */
  env: NodeJS.ProcessEnv;
  cols: number;
  rows: number;
}

export interface ShellPty {
  readonly pid: number;
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: { exitCode: number | null }) => void): void;
  write(data: string): void;
  /** 已結束的行程呼叫會被吞掉(底層會拋錯,與 pty-adapter.ts 的 `resize()` 同樣保守)。 */
  resize(cols: number, rows: number): void;
  /**
   * 終止 shell **連同它的子程序樹**。resolve 時行程已確認消失(或 `timeoutMs` 到了仍放棄等待——不丟錯,
   * fail-safe 方向同 `child-process.ts` 的 `waitForChildExit()`)。重複呼叫是安全的。
   *
   * ⚠️ **shell 已經結束(`onExit` 觸發過)就完全不碰那個 pid**:不 `ptyProcess.kill()`、不 `taskkill`、不 `process.kill`。
   * 使用者在 shell 裡打 `exit` 之後終端會留在清單裡,可能隔很久才按關閉——那時作業系統早就可能把同一個 pid
   * 配給別的程式(Windows 的 pid 回收很快),此時 `isPidAlive(pid)` 回 true,但活著的是**無關的行程**,
   * `taskkill /pid X /T /F` 會把它連同整棵子程序樹殺掉。
   */
  kill(timeoutMs?: number): Promise<void>;
}

/** 這個 pid 的行程還在不在。`EPERM` 代表存在但不屬於我們(這裡不會發生,保守視為活著)。 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** 非同步 `taskkill /T /F`:最多等 `timeoutMs`,逾時就放棄(不讓一個卡住的 taskkill 卡住呼叫端)。 */
function taskkillTree(pid: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    let child: ReturnType<typeof spawn> | undefined;
    try {
      // `windowsHide`:打包版 core 沒有主控台,不帶這個旗標 taskkill 可能閃出主控台視窗(同 child-process.ts)。
      child = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } catch {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      try {
        child?.kill();
      } catch {
        // ignore
      }
      done();
    }, timeoutMs);
    timer.unref?.();
    child.once("exit", done);
    child.once("error", done);
  });
}

export function spawnShellPty(options: ShellPtySpawnOptions): ShellPty {
  // 縱深防禦:node-pty 組環境字串時會把值是 undefined 的鍵變成字面的 "undefined"(變數「存在」且值是 "undefined"),
  // 對只看「變數存不存在」的程式(例如 Electron 的 ELECTRON_RUN_AS_NODE)與刪掉它完全不是同一件事——這裡一律濾掉。
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(options.env)) {
    if (typeof value === "string") env[name] = value;
  }
  const ptyProcess: IPty = pty.spawn(options.file, options.args, {
    cwd: options.cwd,
    env,
    cols: options.cols,
    rows: options.rows,
    name: "xterm-256color",
  });
  const pid = ptyProcess.pid;
  let exited = false;
  ptyProcess.onExit(() => {
    exited = true;
  });

  let killing: Promise<void> | undefined;
  const doKill = async (timeoutMs: number): Promise<void> => {
    // 已經結束的 shell:pid 可能已被別的行程重用,絕不能動(見 `ShellPty.kill()` 的說明)。
    if (exited || !isPidAlive(pid)) return;
    try {
      ptyProcess.kill();
    } catch {
      // ignore — 行程可能已經結束
    }
    if (process.platform === "win32") {
      await taskkillTree(pid, Math.min(timeoutMs, 10_000));
    }
    const deadline = Date.now() + timeoutMs;
    let escalated = false;
    // 迴圈途中 shell 結束(`onExit` 到了)就停:之後 pid 活著不代表還是我們的 shell,也不能再對它送訊號。
    while (!exited && isPidAlive(pid) && Date.now() < deadline) {
      // POSIX:shell 是它那個 session/行程群組的首領(node-pty 用 setsid 開的),SIGHUP 沒收乾淨的話,
      // 約一秒後改對整個行程群組送 SIGKILL。Windows 的 taskkill /T /F 本來就是強制的。
      if (process.platform !== "win32" && !escalated && deadline - Date.now() < timeoutMs - 1_000) {
        escalated = true;
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          // ignore
        }
      }
      await sleep(50);
    }
  };

  return {
    pid,
    onData: (listener) => {
      ptyProcess.onData(listener);
    },
    onExit: (listener) => {
      ptyProcess.onExit(({ exitCode }) => listener({ exitCode: typeof exitCode === "number" ? exitCode : null }));
    },
    write: (data) => ptyProcess.write(data),
    resize: (cols, rows) => {
      if (exited) return;
      try {
        ptyProcess.resize(cols, rows);
      } catch {
        // ignore — process 可能已經結束或底層 ConPTY 不接受這個尺寸
      }
    },
    kill: (timeoutMs = 3_000) => {
      killing ??= doKill(timeoutMs);
      return killing;
    },
  };
}
