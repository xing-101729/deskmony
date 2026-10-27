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

/**
 * 2026-10-16(訊息 hover 動作列):訊息時間戳的精簡顯示——今天只顯示時:分;同一年的其他天顯示月/日 + 時:分;
 * 跨年再加上年。24 小時制(`hourCycle: "h23"`,不用 `hour12: false`:en-US 的後者會把午夜顯示成 24:05)。
 * `now` 只給測試/呼叫端統一基準用。
 */
export function formatMessageTime(ts: number, locale: Locale, now: number = Date.now()): string {
  const date = new Date(ts);
  const today = new Date(now);
  const hourMinute = { hour: "2-digit", minute: "2-digit", hourCycle: "h23" } as const;
  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString(INTL_LOCALE[locale], hourMinute);
  }
  const sameYear = date.getFullYear() === today.getFullYear();
  return date.toLocaleString(INTL_LOCALE[locale], {
    ...(sameYear ? {} : { year: "numeric" }),
    month: "numeric",
    day: "numeric",
    ...hourMinute,
  });
}

/** 訊息時間戳的完整日期時間(tooltip 用):年月日、星期、時分秒。 */
export function formatMessageTimeFull(ts: number, locale: Locale): string {
  return new Date(ts).toLocaleString(INTL_LOCALE[locale], {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
}
