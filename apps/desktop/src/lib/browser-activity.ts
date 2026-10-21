/**
 * browser-activity.ts(2026-10-21,右側面板 P4b):agent 正在操作某個 session 的瀏覽器時,UI 要顯示的「最近一個動作」與兩個小決定。
 * 沒有任何 import(同 `lib/panel-layout.ts` 的慣例),`scripts/e2e-side-panel-pure.mjs` 直接用 Node 載入測試。
 *
 * 動作描述只回 **i18n key + 參數**(`sidePanel:browser.agent.actions.<key>`),不直接組句子——四個語系各自翻譯。
 * 參數刻意不含敏感內容:輸入的文字只顯示字元數(不顯示內容)、網址只顯示 host + 路徑(不含帳密、查詢字串、片段)。
 */

export interface ActionDescriptor {
  /** `sidePanel:browser.agent.actions.<key>`。 */
  key: string;
  params: Record<string, string | number>;
}

/** agent 操作結束後,指示與最近一個動作再留這麼久才消失(讓使用者來得及看到「剛剛發生了什麼」)。 */
export const ACTIVITY_LINGER_MS = 8_000;

const URL_DISPLAY_MAX = 60;

/** 網址的顯示形式:`host/path`(不含 scheme、帳密、查詢字串、片段),太長以刪節號截斷;解析不了就取前面一段。 */
export function shortUrlForDisplay(raw: unknown): string {
  const text = typeof raw === "string" ? raw : "";
  let shown = text;
  try {
    const parsed = new URL(text);
    shown = `${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`;
  } catch {
    // 不是合法網址:原樣(截短)
  }
  return shown.length > URL_DISPLAY_MAX ? `${shown.slice(0, URL_DISPLAY_MAX - 1)}…` : shown;
}

/** core 送來的 `browser-command` 的 op + args → 要顯示的動作。 */
export function describeBrowserAction(op: string, args: unknown): ActionDescriptor {
  const a: Record<string, unknown> = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
  switch (op) {
    case "navigate":
      if (a.action === "back" || a.action === "forward" || a.action === "reload") return { key: a.action, params: {} };
      return { key: "navigate", params: { url: shortUrlForDisplay(a.url) } };
    case "screenshot":
      return { key: "screenshot", params: {} };
    case "readPage":
      return { key: a.mode === "interactive" ? "readInteractive" : "readText", params: {} };
    case "click":
      if (typeof a.ref === "string") return { key: "clickRef", params: { ref: a.ref.slice(0, 20) } };
      return { key: "clickPoint", params: { x: typeof a.x === "number" ? Math.round(a.x) : 0, y: typeof a.y === "number" ? Math.round(a.y) : 0 } };
    case "type":
      return { key: a.submit === true ? "typeSubmit" : "type", params: { count: typeof a.text === "string" ? [...a.text].length : 0 } };
    case "pressKey":
      return { key: "pressKey", params: { key: typeof a.key === "string" ? a.key.slice(0, 20) : "" } };
    case "scroll":
      return { key: a.direction === "up" ? "scrollUp" : "scrollDown", params: {} };
    default:
      return { key: "unknown", params: { op: String(op).slice(0, 20) } };
  }
}

/**
 * 要不要自動打開面板:只有「這個 session 是目前選取的」+「面板關著」+「這是一段操作的開頭」(上一段已經結束超過 `ACTIVITY_LINGER_MS`、
 * 紀錄已被清掉)才開。使用者在操作進行中把面板關掉,不會被下一個指令又彈出來;面板開著但停在別的分頁時也不搶走他正在看的分頁。
 */
export function shouldAutoOpenPanel(input: { isCurrentSession: boolean; panelOpen: boolean; hasRecentActivity: boolean }): boolean {
  return input.isCurrentSession && !input.panelOpen && !input.hasRecentActivity;
}
