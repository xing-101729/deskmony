import type { Terminal } from "@xterm/xterm";

/**
 * xterm.js 的主題與字級換算——`views/TerminalView.tsx`(agent 本身就是終端程式的 PTY session 視圖)與右側面板的
 * Terminal 分頁(`views/panel/XtermTerminal.tsx`)共用,兩邊對「深淺主題切換、字級縮放」的處理才不會漂移。
 */

export type XtermTheme = NonNullable<ConstructorParameters<typeof Terminal>[0]>["theme"];

/** 兩個終端視圖共用的字型堆疊。 */
export const TERMINAL_FONT_FAMILY = "Cascadia Code, JetBrains Mono, Consolas, monospace";

/** 把 index.css 定義的 CSS 變數(RGB 通道值)解析成 xterm.js 能吃的 `rgb()`
 *  字串——xterm 用 canvas/webgl 繪製,`fillStyle` 不會像一般 DOM 那樣解析
 *  `var(--x)`,必須在這裡讀出目前生效的實際色值。深/淺主題切換時重新讀取一次
 *  即可(呼叫端訂閱 `useTheme` 的 effect)。 */
export function resolveTerminalTheme(): XtermTheme {
  const style = getComputedStyle(document.documentElement);
  const channel = (name: string): string => `rgb(${style.getPropertyValue(name).trim().split(/\s+/).join(" ")})`;
  return {
    background: channel("--c-canvas"),
    foreground: channel("--c-fg"),
    cursor: channel("--c-accent"),
    cursorAccent: channel("--c-canvas"),
    selectionBackground: channel("--c-line-strong"),
  };
}

/** xterm 用 canvas 繪製終端內容,字級是建構 `Terminal` 時給的 px 數字,不吃
 *  CSS rem——調整 ui/font-scale.ts 的 root font-size 不會讓它自動變大/變小
 *  (同一類問題見上方 resolveTerminalTheme() 的說明,那是顏色版本,這裡是
 *  字級版本)。這裡手動依目前的 root font-size 等比換算,維持「終端字級
 *  跟著 UI 其餘部分一起縮放」的目標。13 是原本寫死的字級,也就是 16px root
 *  (= font-scale 的 `md` 檔)時的基準值。 */
export const TERMINAL_BASE_FONT_PX = 13;

/** 依目前的 root font-size(px)換算 xterm 的字級。 */
export function terminalFontSizeFor(rootFontPx: number): number {
  return Math.round(TERMINAL_BASE_FONT_PX * (rootFontPx / 16));
}
