export type Locale = "zh-Hant" | "en" | "ja" | "es";
export const LOCALES: readonly Locale[] = ["zh-Hant", "en", "ja", "es"];
export const DEFAULT_LOCALE: Locale = "zh-Hant";
const STORAGE_KEY = "deskmony.locale";

export function readStoredLocale(): Locale {
  if (typeof localStorage === "undefined") return DEFAULT_LOCALE;
  const raw = localStorage.getItem(STORAGE_KEY);
  return (LOCALES as readonly string[]).includes(raw ?? "") ? (raw as Locale) : DEFAULT_LOCALE;
}

export function writeStoredLocale(locale: Locale): void {
  if (typeof localStorage !== "undefined") localStorage.setItem(STORAGE_KEY, locale);
}
