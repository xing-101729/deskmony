import { BrowserCommandPushSchema } from "@deskmony/shared";
import { describeBrowserAction, shouldAutoOpenPanel } from "../../lib/browser-activity.js";
import { READY_WAIT_MS, runBrowserCommand, type HostFlowDeps, type HostOutcome } from "../../lib/browser-host-flow.js";
import { client, useSessionStore } from "../../stores/session-store.js";
import { usePanelStore } from "../../stores/panel-store.js";
import { isBrowserSupported, useBrowserStore, waitForBrowserReady } from "../../stores/browser-store.js";
import { openBrowserPanel } from "./panel-actions.js";

/**
 * 桌面 app 當「agent 瀏覽器指令的執行端(host)」的接線(2026-10-21,右側面板 P4b;契約見 docs/LAYER-4-detail-design/side-panel_detail.md §P4a 實作備註)。
 * 決策邏輯(順序、失敗怎麼回報)在 `lib/browser-host-flow.ts`(純函式,有測試);這裡只把它接到真的 store、WS client 與 IPC。
 *
 * 流程:每次 WS 連線開啟(含重新連上)都呼叫 `browser.registerHost`;core 之後把 agent 的瀏覽器指令以 `browser-command` push 只送給這條連線。
 * 每個指令:確認 session 存在 → 顯示「agent 操作中」指示(必要時自動打開面板)→ 確保那個 session 的 webview 已建立並 `dom-ready`
 * (使用者從沒打開過 Browser 分頁也一樣)→ 經 IPC 交給 main 的執行器(`electron/browser-executor.ts`)→ 把結果以 `browser.commandResult` 回給 core。
 * 只有 Electron 殼(有 `<webview>` 與 `browserExec` IPC)才會註冊成 host。
 */

/** 確保 session 的 webview 存在且 `dom-ready`,回傳它的 webContentsId。 */
async function ensureGuest(sessionId: string): Promise<number> {
  useBrowserStore.getState().ensure(sessionId);
  if (!useBrowserStore.getState().created.includes(sessionId)) throw new Error("這個 session 無法建立瀏覽器(session id 不合法)");
  return await waitForBrowserReady(sessionId, READY_WAIT_MS);
}

async function reply(commandId: string, outcome: HostOutcome): Promise<void> {
  try {
    await client.call(
      "browser.commandResult",
      outcome.ok ? { commandId, ok: true, result: outcome.result } : { commandId, ok: false, error: outcome.error },
    );
  } catch (err) {
    // 連線剛好斷了、或指令已經在 core 端逾時(commandId 不再等待):沒有人可以通知,留個紀錄就好。
    console.warn("[browser-host] 回報指令結果失敗:", err instanceof Error ? err.message : err);
  }
}

const deps: HostFlowDeps = {
  parseCommand: (raw) => {
    const parsed = BrowserCommandPushSchema.safeParse(raw);
    return parsed.success ? parsed.data : undefined;
  },
  sessionExists: (sessionId) => useSessionStore.getState().sessions.some((s) => s.id === sessionId),
  hadActivity: (sessionId) => useBrowserStore.getState().agentActivity[sessionId] !== undefined,
  beginActivity: (sessionId, op, args) => useBrowserStore.getState().beginAgentAction(sessionId, describeBrowserAction(op, args)),
  endActivity: (sessionId) => useBrowserStore.getState().endAgentAction(sessionId),
  shouldAutoOpen: (sessionId, hadActivity) =>
    shouldAutoOpenPanel({
      isCurrentSession: useSessionStore.getState().currentSessionId === sessionId,
      panelOpen: usePanelStore.getState().open,
      hasRecentActivity: hadActivity,
    }),
  openPanel: openBrowserPanel,
  sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  ensureGuest,
  isCrashed: (sessionId) => useBrowserStore.getState().pages[sessionId]?.crashed === true,
  get exec() {
    return window.deskmony?.browserExec;
  },
  reply,
};

/**
 * 啟動 host 功能(由 `BrowserHost` 在 App 層掛載時呼叫一次;回傳停止函式)。
 * 純瀏覽器 client(沒有 `window.deskmony`)與舊版殼(沒有 `browserExec`)什麼都不做。
 */
export function startBrowserHost(): () => void {
  if (!isBrowserSupported() || typeof window.deskmony?.browserExec !== "function") return () => undefined;

  const register = (): void => {
    client.call("browser.registerHost", {}).catch((err: unknown) => {
      // 例如連到的是遠端 core(`browser.registerNotAllowed`:只收本機連線)——此時 agent 的瀏覽器工具會回 browser.noHost,不影響其他功能。
      console.warn("[browser-host] 註冊成瀏覽器執行端失敗:", err instanceof Error ? err.message : err);
    });
  };
  // 每次連線開啟都要重新註冊(core 以「連線」為單位記 host;斷線自動註銷)。App 啟動時連線可能早已開啟,所以掛上時先看一次。
  const offStatus = client.onStatus((status) => {
    if (status === "open") register();
  });
  if (useSessionStore.getState().status === "open") register();
  const offPush = client.onPush((push) => {
    if (push.channel === "browser-command") void runBrowserCommand(deps, push.payload);
  });
  return () => {
    offStatus();
    offPush();
  };
}
