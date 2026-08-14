import { create } from "zustand";
import i18n from "../i18n.js";
import { type Locale, readStoredLocale, writeStoredLocale } from "../lib/locale-storage.js";

function applyToDocument(locale: Locale): void {
  if (typeof document === "undefined") return;
  document.documentElement.lang = locale;
}

interface LocaleState {
  locale: Locale;
  setLocale: (locale: Locale) => void;
}

export const useLocale = create<LocaleState>((set) => ({
  locale: readStoredLocale(),
  setLocale: (locale) => {
    writeStoredLocale(locale);
    applyToDocument(locale);
    void i18n.changeLanguage(locale);
    set({ locale });
  },
}));

/** 在 React 掛載前套用 <html lang>,比照 theme.ts 的 initTheme()。 */
export function initLocale(): void {
  applyToDocument(readStoredLocale());
}
