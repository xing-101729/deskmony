import type { Locale } from "./locale-storage.js";

const INTL_LOCALE: Record<Locale, string> = {
  "zh-Hant": "zh-TW",
  en: "en-US",
  ja: "ja-JP",
  es: "es-ES",
};

export function formatDateTime(ts: number, locale: Locale, options?: Intl.DateTimeFormatOptions): string {
  return new Date(ts).toLocaleString(INTL_LOCALE[locale], options);
}

export function formatTimeOnly(ts: number, locale: Locale, options?: Intl.DateTimeFormatOptions): string {
  return new Date(ts).toLocaleTimeString(INTL_LOCALE[locale], { hour12: false, ...options });
}
