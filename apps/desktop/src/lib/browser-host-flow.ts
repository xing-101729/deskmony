/**
 * browser-host-flow.ts(2026-10-21,右側面板 P4b):桌面 app 收到一個 agent 的 `browser-command` 之後要做哪些事、依什麼順序、
 * 各種失敗怎麼回報——**決策邏輯**。沒有任何 import(同 `lib/panel-layout.ts` 的慣例),所有會碰到 store/WS/IPC 的動作都經 `HostFlowDeps` 注入,
 * `scripts/e2e-side-panel-pure.mjs` 用假的 deps 直接用 Node 載入測試;真正的接線在 `views/panel/browser-host.ts`。
 *
 * 原則:core 在等結果(逾時 15 秒、導覽 30 秒),所以**有 commandId 就一定回一個結果**——壞掉的 payload、找不到 session、webview 起不來、
 * IPC 失敗、執行器回傳怪東西,一律回 `browser.hostError`,不讓 core 乾等。整個流程**永遠不丟例外**。
 */

export type HostOutcome = { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } };

export interface HostCommand {
  commandId: string;
  sessionId: string;
  op: string;
  args: unknown;
}

/** 等 webview 準備好(dom-ready)的上限。比 core 的逾時小得多:正常情況下 webview 幾百毫秒內就 dom-ready。 */
export const READY_WAIT_MS = 5_000;
/** 自動打開面板後等這麼久,讓 slot 回報位置、webview 從停放位置移進面板——之後的截圖/viewport 量測才是面板開著的樣子。 */
export const AUTO_OPEN_SETTLE_MS = 300;
export const HOST_ERROR_CODE = "browser.hostError";
/** `BrowserHostErrorSchema` 的上限(code 100、message 2000)。 */
const ERROR_CODE_MAX = 100;
const ERROR_MESSAGE_MAX = 2000;

export function failure(code: string, message: string): HostOutcome {
  return { ok: false, error: { code: code.slice(0, ERROR_CODE_MAX), message: message.slice(0, ERROR_MESSAGE_MAX) } };
}

export const hostFailure = (message: string): HostOutcome => failure(HOST_ERROR_CODE, message);

/** payload 壞到驗證不過時,盡量還是挖出 commandId 好回一個錯誤。 */
export function commandIdOf(raw: unknown): string | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const id = (raw as { commandId?: unknown }).commandId;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/** main 的執行器回傳的東西 → `HostOutcome`。形狀不對(舊版/壞掉的 main)一律當 `browser.hostError`;錯誤的 code/message 一律截到 schema 上限內。 */
export function normalizeExecOutcome(value: unknown): HostOutcome {
  if (typeof value === "object" && value !== null) {
    const outcome = value as { ok?: unknown; result?: unknown; error?: unknown };
    if (outcome.ok === true) return { ok: true, result: outcome.result };
    if (outcome.ok === false && typeof outcome.error === "object" && outcome.error !== null) {
      const error = outcome.error as { code?: unknown; message?: unknown };
      return failure(typeof error.code === "string" && error.code ? error.code : HOST_ERROR_CODE, typeof error.message === "string" ? error.message : "");
    }
  }
  return hostFailure("瀏覽器執行端回傳的結果格式不對");
}

export interface HostFlowDeps {
  /** 驗證 `browser-command` 的 payload(zod schema);不合法回 `undefined`。 */
  parseCommand(raw: unknown): HostCommand | undefined;
  /** 這個 session 在桌面 app 的清單裡嗎(已刪除或啟動時清單還沒載入 = 否)。 */
  sessionExists(sessionId: string): boolean;
  /** 這個 session 之前已經有「agent 操作中」的指示(正在或剛剛操作過)嗎——在 `beginActivity` **之前**問。 */
  hadActivity(sessionId: string): boolean;
  beginActivity(sessionId: string, op: string, args: unknown): void;
  endActivity(sessionId: string): void;
  /** 要不要自動打開面板(目前 session + 面板關著 + 一段操作的開頭)。 */
  shouldAutoOpen(sessionId: string, hadActivity: boolean): boolean;
  openPanel(): void;
  sleep(ms: number): Promise<void>;
  /** 確保 webview 存在且 dom-ready,回傳 webContentsId。失敗就 reject(訊息會原樣回報給 agent)。 */
  ensureGuest(sessionId: string): Promise<number>;
  isCrashed(sessionId: string): boolean;
  /** main 的 `browserExec` IPC;舊版殼沒有就是 `undefined`。 */
  exec: ((webContentsId: number, op: string, args: unknown) => Promise<unknown>) | undefined;
  /** 回報結果給 core(`browser.commandResult`)。 */
  reply(commandId: string, outcome: HostOutcome): Promise<void>;
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

async function executeOnGuest(deps: HostFlowDeps, command: HostCommand): Promise<HostOutcome> {
  if (!deps.exec) return hostFailure("這個桌面 app 沒有瀏覽器執行端");
  let webContentsId: number;
  try {
    webContentsId = await deps.ensureGuest(command.sessionId);
  } catch (err) {
    return hostFailure(messageOf(err));
  }
  // 頁面的 render 行程當掉了(webview 上會顯示「頁面當掉了」):對一個沒有畫面的頁面下指令沒有意義。
  if (deps.isCrashed(command.sessionId)) return hostFailure("這個頁面的 render 行程已經當掉。請 browser_navigate 重新載入頁面再試。");
  try {
    return normalizeExecOutcome(await deps.exec(webContentsId, command.op, command.args));
  } catch (err) {
    // main 拒絕(呼叫者不是主視窗、webContentsId 不是這個視窗的 webview——例如 webview 剛好被銷毀)或 IPC 本身失敗。
    return hostFailure(messageOf(err));
  }
}

/** 處理一個 `browser-command` push。永遠不丟例外。 */
export async function runBrowserCommand(deps: HostFlowDeps, raw: unknown): Promise<void> {
  const safeReply = async (commandId: string, outcome: HostOutcome): Promise<void> => {
    try {
      await deps.reply(commandId, outcome);
    } catch {
      // 連線剛好斷了、或指令已在 core 端逾時:沒有人可以通知。
    }
  };

  const command = deps.parseCommand(raw);
  if (!command) {
    const commandId = commandIdOf(raw);
    if (commandId) await safeReply(commandId, hostFailure("不認得的瀏覽器指令(op 或參數不合法)"));
    return;
  }

  // session 不在清單裡:不為它建立 webview——BrowserHost 會把「不在清單裡」的 session 的 webview 清掉。
  if (!deps.sessionExists(command.sessionId)) {
    await safeReply(command.commandId, hostFailure("桌面 app 找不到這個 session(它可能已被刪除,或清單還在載入)。請稍後再試。"));
    return;
  }

  const hadActivity = deps.hadActivity(command.sessionId);
  let outcome: HostOutcome;
  try {
    deps.beginActivity(command.sessionId, command.op, command.args);
    try {
      if (deps.shouldAutoOpen(command.sessionId, hadActivity)) {
        deps.openPanel();
        await deps.sleep(AUTO_OPEN_SETTLE_MS);
      }
      outcome = await executeOnGuest(deps, command);
    } finally {
      deps.endActivity(command.sessionId);
    }
  } catch (err) {
    outcome = hostFailure(messageOf(err));
  }
  await safeReply(command.commandId, outcome);
}
