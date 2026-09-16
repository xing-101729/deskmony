import { create } from "zustand";

/**
 * UI 字級(root rem 縮放)——跟 src/ui/theme.ts 的主題偏好同一類東西:**純
 * UI 偏好**,不經過 gateway、不進 core 的設定檔。理由完全相同:這是「這台
 * 裝置這個使用者看的字多大」的層級,與 `config.setFile` 管的那些影響 core
 * 行為(agent 怎麼跑、權限怎麼判)的設定不同類,存 `localStorage` 即可(瀏覽器
 * 場景換裝置就重新選一次,Electron 場景等同永久記住)。
 *
 * 選「調整 `<html>` 的 root font-size,靠 rem 帶動整個設計系統跟著縮放」,
 * 而不是 Electron 的 `webFrame.setZoomFactor()`:這個 app 是 Electron + 瀏覽器
 * 雙載體(見 apps/desktop 的 gateway 架構,純瀏覽器分頁沒有 `webFrame` 這個
 * API),zoom 只能在其中一個載體生效;rem 是純 CSS 機制,兩個載體都吃。
 * 實作上只做一件事:把 `<html>` 的 inline `font-size` 換成對應的 px 值——
 * Tailwind 的 spacing/sizing 刻度本來就是 rem-based(見 tailwind.config.js
 * 2026-09 的 fontSize/spacing 註解),root font-size 一變,文字、padding、
 * gap、icon(見 ui/icons.tsx)全部等比跟著變,不必在每個元件自己處理縮放。
 *
 * 兩種載體的按鍵乾淨程度不一樣:Electron 視窗裡 `mod+=`/`mod+-`/`mod+0`
 * 這三組快捷鍵是乾淨的(見 electron/main.ts 的 `installApplicationMenu()`——
 * 已把預設選單裡撞鍵的 `resetzoom`/`zoomin`/`zoomout` 三個 role 拿掉);但
 * 純瀏覽器分頁(gateway/遠端存取場景)沒有這層保護,Ctrl/Cmd+=/-/0 在瀏覽器
 * 是瀏覽器本身的頁面縮放快捷鍵,由瀏覽器 chrome 處理、頁面 JavaScript 無從
 * `preventDefault()`,因此瀏覽器分頁裡這三組鍵一樣會疊加瀏覽器自己的縮放,
 * 這是 app 內部無法修的載體限制。真正不看載體、一律可靠的調整入口是側欄
 * 底部的字級切換器(見 views/SessionList.tsx 的 `FontScaleSwitcher`)與
 * command palette 裡的對應項目(見 App.tsx 的 `action:font-size-*` 指令)。
 */
export type FontScale = "sm" | "md" | "lg" | "xl";
export const FONT_SCALES: readonly FontScale[] = ["sm", "md", "lg", "xl"];

/** 四檔對應的 root font-size(px)。`md` = 16px 是「與加入這個功能之前的 UI
 *  像素級完全相同」的基準(見 index.css 的 `html { font-size: 16px }` 錨點),
 *  其餘三檔以此為中心各退/進兩級。 */
const ROOT_FONT_PX: Record<FontScale, number> = { sm: 14, md: 16, lg: 18, xl: 20 };

/** 供「自己管字級、不吃 CSS rem」的元件換算用——目前只有 xterm.js(canvas
 *  繪製,見 views/TerminalView.tsx 的 `TERMINAL_BASE_FONT_PX` 換算)需要,
 *  未來若有類似的 canvas/SVG 字級也走同一個對照表,不要各自硬編一份。 */
export function getRootFontPx(scale: FontScale): number {
  return ROOT_FONT_PX[scale];
}

const STORAGE_KEY = "deskmony.fontScale";

function isFontScale(value: string | null): value is FontScale {
  return (FONT_SCALES as readonly string[]).includes(value ?? "");
}

function readStoredScale(): FontScale {
  if (typeof localStorage === "undefined") return "md";
  const raw = localStorage.getItem(STORAGE_KEY);
  return isFontScale(raw) ? raw : "md";
}

function applyToDocument(scale: FontScale): void {
  if (typeof document === "undefined") return;
  document.documentElement.style.fontSize = `${ROOT_FONT_PX[scale]}px`;
}

interface FontScaleState {
  scale: FontScale;
  /** 目前生效的 root font-size(px)——訂閱這個欄位的元件(例如
   *  TerminalView.tsx)不必自己重算 ROOT_FONT_PX 對照表。 */
  rootFontPx: number;
  setScale: (scale: FontScale) => void;
  /** 放大一階(已在 `xl` 則不動,不循環回 `sm`)。 */
  increase: () => void;
  /** 縮小一階(已在 `sm` 則不動,不循環回 `xl`)。 */
  decrease: () => void;
  /** 回到 `md`(= 16px,與加入這個功能之前的 UI 像素級完全相同)。 */
  reset: () => void;
}

export const useFontScale = create<FontScaleState>((set, get) => ({
  scale: readStoredScale(),
  rootFontPx: getRootFontPx(readStoredScale()),
  setScale: (scale) => {
    if (typeof localStorage !== "undefined") localStorage.setItem(STORAGE_KEY, scale);
    applyToDocument(scale);
    set({ scale, rootFontPx: getRootFontPx(scale) });
  },
  increase: () => {
    const index = FONT_SCALES.indexOf(get().scale);
    if (index < FONT_SCALES.length - 1) get().setScale(FONT_SCALES[index + 1]);
  },
  decrease: () => {
    const index = FONT_SCALES.indexOf(get().scale);
    if (index > 0) get().setScale(FONT_SCALES[index - 1]);
  },
  reset: () => get().setScale("md"),
}));

/** 在 React 掛載前先把字級套上,避免第一帧用瀏覽器預設字級畫一次、下一輪
 *  render 才跳成使用者選的字級(比照 theme.ts 的 `initTheme()` 既有慣例)。 */
export function initFontScale(): void {
  applyToDocument(readStoredScale());
}
