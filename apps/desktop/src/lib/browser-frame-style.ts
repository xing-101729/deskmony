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
 * 停放中的 `<webview>` 要退出 Tab 順序(2026-10-21 P4b,10-23 修正):看不見的頁面不該被使用者按 Tab 聚焦進去(焦點進了 guest,之後的按鍵都被一個看不到的頁面吃掉)。
 * 停放時回 `-1`(`tabindex="-1"`:不在循序鍵盤導覽裡,但程式與 CDP 仍可聚焦它),可見時回 `undefined`(不設屬性,回到預設)。
 *
 * **為什麼是 `tabindex` 而不是 `inert`(以及這個決定的證據有多弱)**:最初的 Tab 防護是停放外框的 `inert`。實驗腳本(真 Electron,2026-10-23)驗過它:
 * `parked-inert` 5/5、Tab 進不去。但同一天驗證腳本在真 app 的停放階段 click(P-5a/P-5b)FAIL,當時歸因於 `inert` 而改用 tabindex。
 * **事後發現那兩個 FAIL 是驗證腳本自己的 bug**(用「累計的 click 事件數 + 1」比對頁面的點擊計數,頁面重新載入後計數歸零,所以完整執行的停放階段點擊一定比不上,
 * 與 inert 無關),而當時的對照(拿掉 inert、只跑 `--phase=parked`)同時改變了兩件事——所以「`inert` 會擋 CDP 點擊」**既沒有被證明、也沒有被推翻**,
 * 缺的是「inert 開著、只跑停放階段」(或修好腳本後的完整執行)那一次對照。目前採 `tabindex="-1"` 是協調者的決定:它只讓 webview 退出循序導覽,
 * 不影響它被程式/CDP 聚焦,是較保守的做法;但它**能不能擋住 Tab、會不會影響 CDP 點擊也都還沒在真 Electron 驗證**,
 * 實驗腳本 `scripts/spike/webview-offscreen.cjs` 的 `parked-tabindex` 與 `parked-inert` 兩個位置(各 5 項檢查加 Tab 檢查)就是用來比較這兩種防護的。
 */
export function browserWebviewTabIndex(rect: FrameRect | undefined): -1 | undefined {
  return rect === undefined ? -1 : undefined;
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
