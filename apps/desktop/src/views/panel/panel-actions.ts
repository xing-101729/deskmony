import { useSessionStore } from "../../stores/session-store.js";
import { usePanelStore } from "../../stores/panel-store.js";
import { useTerminalStore } from "../../stores/terminal-store.js";
import { TERMINAL_TAB_ID } from "./panel-tabs.js";

/**
 * 面板的幾個動作(2026-10-20):快捷鍵(`mod+j`、`ctrl+\``)、命令面板與標頭切換鈕共用同一份實作——
 * 用 `getState()` 讀 store,不依賴任何元件的 hook,所以 App 層的快捷鍵 handler 與命令面板都能直接呼叫。
 */

/** 把鍵盤焦點交給目前 session 的目前終端(沒有終端時由 TerminalTab 的自動建立負責,建好會自己要焦點)。 */
function focusActiveTerminal(): void {
  const sessionId = useSessionStore.getState().currentSessionId;
  if (!sessionId) return;
  const terminal = useTerminalStore.getState();
  const activeId = terminal.activeBySession[sessionId];
  if (activeId) terminal.requestFocus(activeId);
}

/** `mod+j`:開/關面板。打開時若目前分頁是 Terminal,焦點交給終端。 */
export function togglePanel(): void {
  const panel = usePanelStore.getState();
  const willOpen = !panel.open;
  panel.toggle();
  if (willOpen && panel.tab === TERMINAL_TAB_ID) focusActiveTerminal();
}

/** `ctrl+\``:開面板並切到 Terminal 分頁(沒有終端就自動建一個)。 */
export function openTerminalPanel(): void {
  usePanelStore.getState().openTab(TERMINAL_TAB_ID);
  focusActiveTerminal();
}

/** 命令面板的「新終端」:開面板、切到 Terminal 分頁、在目前 session 再開一個終端。 */
export function openNewTerminal(): void {
  const sessionId = useSessionStore.getState().currentSessionId;
  usePanelStore.getState().openTab(TERMINAL_TAB_ID);
  if (!sessionId) return;
  // createTerminal 會同步上鎖(`creating`),TerminalTab 的「清單是空的就自動建一個」看到鎖就不會再開第二個。
  useTerminalStore
    .getState()
    .createTerminal(sessionId)
    .catch(() => undefined); // 失敗原因在 store 的 lastError,TerminalTab 顯示
}
