import { create } from "zustand";

/**
 * 主題(深色/淺色)——**純 UI 偏好**,不經過 gateway、不進 core 的設定檔:
 * 這是「這台裝置這個使用者看起來舒服」的層級,與 `config.setFile` 管的那些
 * 影響 core 行為的設定不同類,存 `localStorage` 即可(瀏覽器場景換裝置就重新
 * 選一次,Electron 場景等同永久記住)。
 *
 * 三態(`system` / `dark` / `light`):`system` 跟隨作業系統,而 Deskmony 是
 * 開發者工具——**預設 `dark`**(不是 `system`),因為淺色是刻意的選擇,不該因為
 * 使用者的 OS 恰好是淺色就被切走既有的深色體感。
 *
 * 實作上只做一件事:把解析後的結果寫進 `<html data-theme>`。所有顏色都是
 * `:root[data-theme]` 供給的 CSS 變數(見 src/index.css),因此不需要在任何
 * 元件掛 `dark:` variant,切換是整體且即時的。
 */
export type ThemePreference = "system" | "dark" | "light";
export type ResolvedTheme = "dark" | "light";

const STORAGE_KEY = "deskmony.theme";

function readStoredPreference(): ThemePreference {
  if (typeof localStorage === "undefined") return "dark";
  const raw = localStorage.getItem(STORAGE_KEY);
  return raw === "light" || raw === "dark" || raw === "system" ? raw : "dark";
}

function systemTheme(): ResolvedTheme {
  if (typeof window === "undefined" || !window.matchMedia) return "dark";
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function resolve(preference: ThemePreference): ResolvedTheme {
  return preference === "system" ? systemTheme() : preference;
}

function applyToDocument(theme: ResolvedTheme): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = theme;
  // Tailwind 的 `dark:` variant 仍以 class 判斷(darkMode: ["class", ...]),
  // 少數需要「只在深色下微調」的樣式才用得到,這裡一併同步。
  document.documentElement.classList.toggle("dark", theme === "dark");
}

interface ThemeState {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference: (preference: ThemePreference) => void;
  /** 在 dark ⇄ light 之間切換(以目前實際生效的結果為基準,不會停在 system)。 */
  toggle: () => void;
}

export const useTheme = create<ThemeState>((set, get) => ({
  preference: readStoredPreference(),
  resolved: resolve(readStoredPreference()),
  setPreference: (preference) => {
    const resolved = resolve(preference);
    if (typeof localStorage !== "undefined") localStorage.setItem(STORAGE_KEY, preference);
    applyToDocument(resolved);
    set({ preference, resolved });
  },
  toggle: () => get().setPreference(get().resolved === "dark" ? "light" : "dark"),
}));

/** 在 React 掛載前先把主題套上,避免第一帧閃一下錯誤的顏色(由 main.tsx 呼叫)。 */
export function initTheme(): void {
  const preference = readStoredPreference();
  applyToDocument(resolve(preference));
  if (typeof window !== "undefined" && window.matchMedia) {
    // 只有 preference === "system" 時才跟著 OS 變;明確選過深/淺色的人不該被改掉。
    window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
      const state = useTheme.getState();
      if (state.preference === "system") state.setPreference("system");
    });
  }
}
