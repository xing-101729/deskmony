/**
 * Browser 分頁 webview 外框的樣式(2026-10-21,見 docs/LAYER-4-detail-design/side-panel_detail.md §P3.2、§P3 實作備註)。
 *
 * 抽成沒有任何 import 的純函式,是為了讓 `scripts/e2e-side-panel-pure.mjs` 直接用 Node 載入、鎖住「停放方式」這個決定——
 * 它是 P4(agent 對使用者看不到的 session 截圖)能不能成立的前提,不能被不小心改回去。
 *
 * ## 為什麼停放時是「fixed 0,0 / 1024×768 / opacity 0 / z-index -1」,而不是移到畫面外
 *
 * P3.3 實驗(Electron 44,真機)的結果:外框停在 `left: -20000px` 時 CDP `Page.captureScreenshot` **逾時**(其餘四項都過);
 * `opacity: 0` 疊在不透明內容後面則 5/5 通過。推測原因(未另外驗證):完全在視口外的表面不會被合成出畫面,而 `opacity: 0` 的元素仍在視口內、
 * 仍會被合成(只是看不到)。所以停放的 webview 必須**留在視口內**、用 `opacity: 0` 讓它看不見,並用負 z-index 沉到 app 外殼(`.app-shell`,
 * 不透明的 `bg-canvas`,在流內、不是 positioned)的背景之下——就算 opacity 之外還有任何東西想畫出來,也會被外殼的不透明背景蓋住。
 *
 * **不要**用 `visibility: hidden` 或 `display: none`:兩者都會讓 webview 不再被繪製,等於把上面的問題找回來。
 * 停放時固定尺寸 1024×768,頁面的 viewport 不會因為被收起而縮成 0。
 *
 * 可見時照舊:`position: fixed` 疊在 Browser 分頁回報的 slot 上,z-index 45(面板與覆蓋層是 z-40、所有對話框 z-50 以上)。
 */

/** webview 可見時的 z-index:在面板(含覆蓋層模式)z-40 之上、所有對話框(`ui/Dialog.tsx` z-50、命令面板 z-[60])之下。 */
export const BROWSER_Z_INDEX = 45;
/** 停放時的 z-index:負值——沉在根層疊脈絡裡 app 外殼的不透明背景之下。 */
export const BROWSER_PARKED_Z_INDEX = -1;
/** 停放時的固定尺寸(頁面的 viewport 不隨收起而縮小)。 */
export const BROWSER_PARKED_WIDTH = 1024;
export const BROWSER_PARKED_HEIGHT = 768;

export interface FrameRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 外框的樣式(結構上相容於 React 的 `CSSProperties`;這裡不 import React 型別以保持零 import)。 */
export interface BrowserFrameStyle {
  position: "fixed";
  left: number;
  top: number;
  width: number;
  height: number;
  zIndex: number;
  opacity: number;
  overflow: "hidden";
  background: string;
  pointerEvents: "auto" | "none";
}

/**
 * 停放中的外框要加 `inert`(2026-10-21,P4b):看不見的頁面不該被使用者按 Tab 聚焦進去(焦點進了 guest,之後的按鍵都被一個看不到的頁面吃掉)。
 * `inert` 只影響**使用者在 host 端的互動與焦點**,不影響繪製(不像 `visibility: hidden`/`display: none`)、也不影響 CDP 對 guest 的輸入與截圖
 * (CDP 的輸入事件直接送進 guest 的 render widget,不經 host DOM 的命中測試)——**後一點沒有實測**,`scripts/spike/webview-offscreen.cjs` 的
 * `parked-inert` 位置就是為了在真 Electron 驗證它;驗證不過就拿掉這個函式的回傳(改回 false)即可,不影響其他行為。
 * 可見時拿掉。
 */
export function browserFrameInert(rect: FrameRect | undefined): boolean {
  return rect === undefined;
}

/**
 * @param rect 目前 session 的 Browser 分頁 slot(viewport 座標);`undefined` = 沒有 slot(面板關著、不在 Browser 分頁、不是目前 session)→ 停放。
 * @param pointerLock 拖拉面板寬度中:可見的 webview 也暫時不吃滑鼠事件。
 */
export function browserFrameStyle(rect: FrameRect | undefined, pointerLock: boolean): BrowserFrameStyle {
  if (!rect) {
    return {
      position: "fixed",
      left: 0,
      top: 0,
      width: BROWSER_PARKED_WIDTH,
      height: BROWSER_PARKED_HEIGHT,
      zIndex: BROWSER_PARKED_Z_INDEX,
      opacity: 0,
      overflow: "hidden",
      background: "#fff",
      pointerEvents: "none",
    };
  }
  return {
    position: "fixed",
    left: rect.x,
    top: rect.y,
    width: rect.width,
    height: rect.height,
    zIndex: BROWSER_Z_INDEX,
    opacity: 1,
    overflow: "hidden",
    background: "#fff",
    pointerEvents: pointerLock ? "none" : "auto",
  };
}
