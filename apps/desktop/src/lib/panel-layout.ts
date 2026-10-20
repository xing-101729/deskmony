/**
 * 右側面板的版面計算(2026-10-20,見 docs/LAYER-4-detail-design/side-panel_detail.md §P1.3)。
 *
 * **純函式、沒有任何 import**:`scripts/e2e-side-panel-pure.mjs` 直接用 Node 載入這個 .ts 驗證(同 lib/chat-groups.ts 的慣例),
 * 不需要 React/DOM。量版面(`SidePanel.tsx` 用 ResizeObserver 量)與算寬度分開,這裡只負責算。
 *
 * 規則:
 *  - 面板最窄 `PANEL_MIN_WIDTH`(320 px);
 *  - 聊天/終端視圖(`SessionView`)至少保留 `PANEL_CHAT_MIN_REM`(22rem,預設字級 = 352 px)——**「可用寬度」是實際量到的**
 *    「聊天視圖 + 面板」共用的區域寬度(側欄展開/收合寬度不同,也會被切換,所以不寫死側欄寬度);
 *  - 面板最寬 = min(視窗寬度 70%, 可用寬度 − 聊天最小寬度);
 *  - 偏好寬度夾在 [最窄, 最寬] 之間(偏好照舊存 localStorage,空間變大時自然恢復);
 *  - 連最窄的面板都放不下(最寬 < 最窄),或視窗在 `sm`(640 px)以下 → 改成全螢幕覆蓋層,不硬擠。
 */

export const PANEL_MIN_WIDTH = 320;
export const PANEL_DEFAULT_WIDTH = 480;
/** 面板寬度不超過視窗寬度的這個比例。 */
export const PANEL_MAX_WIDTH_RATIO = 0.7;
/** 聊天/終端視圖在面板以側欄形式顯示時至少保留的寬度(rem,跟著使用者的字級偏好縮放)。 */
export const PANEL_CHAT_MIN_REM = 22;
/** Tailwind 的 `sm` 斷點:以下一律是全螢幕覆蓋層。 */
export const PANEL_SM_BREAKPOINT_PX = 640;

export interface PanelLayoutInput {
  /** 「聊天視圖 + 面板」共用區域的實際寬度(px,= 主列寬度減去側欄實際佔的寬度)。 */
  areaWidth: number;
  viewportWidth: number;
  /** `<html>` 目前的 font-size(px),換算 `PANEL_CHAT_MIN_REM`。 */
  rootFontPx: number;
  /** 視窗是否達到 `sm` 斷點。 */
  smUp: boolean;
  /** 使用者偏好的寬度(localStorage 裡的值)。 */
  preferredWidth: number;
}

export interface PanelLayout {
  /** `side`:並排在聊天視圖右邊;`overlay`:全螢幕覆蓋層。 */
  mode: "side" | "overlay";
  /** `side` 模式的實際寬度(px);`overlay` 模式沒有意義(0)。 */
  width: number;
  /** 目前版面允許的最大面板寬度(px,可能小於 `PANEL_MIN_WIDTH`——那就是 `overlay`)。拖拉把手用它限制。 */
  maxWidth: number;
}

export function computePanelLayout(input: PanelLayoutInput): PanelLayout {
  const byViewport = Math.floor(input.viewportWidth * PANEL_MAX_WIDTH_RATIO);
  const byChatMin = Math.floor(input.areaWidth - PANEL_CHAT_MIN_REM * input.rootFontPx);
  const maxWidth = Math.min(byViewport, byChatMin);
  if (!input.smUp || maxWidth < PANEL_MIN_WIDTH) {
    return { mode: "overlay", width: 0, maxWidth };
  }
  const preferred = Number.isFinite(input.preferredWidth) ? input.preferredWidth : PANEL_DEFAULT_WIDTH;
  return {
    mode: "side",
    width: Math.min(maxWidth, Math.max(PANEL_MIN_WIDTH, Math.round(preferred))),
    maxWidth,
  };
}
