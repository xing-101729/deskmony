import type { TFunction } from "i18next";
import { DeskmonyError } from "@deskmony/shared";

/**
 * 取代散落在多個 view 的 `err instanceof Error ? err.message : String(err)`
 * pattern。`t` 必須從呼叫端元件的 `useTranslation()` 拿(不要直接 import
 * i18next 單例的裸 t)——這樣呼叫端元件才會在使用者切換語言時正確重新渲染。
 */
export function translateError(err: unknown, t: TFunction): string {
  if (err instanceof DeskmonyError) {
    return t(`errors:${err.code}`, { ...err.params, defaultValue: err.message });
  }
  return err instanceof Error ? err.message : String(err);
}
