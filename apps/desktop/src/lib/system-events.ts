import type { TFunction } from "i18next";

/**
 * 把 session `messages` 表 role="system" 的 content(或前端本地樂觀更新的
 * 同形狀字串)解成人類可讀文字。content 有兩種形狀:
 *   - JSON {event, params}(這輪新增):查 systemEvents namespace 翻譯。
 *   - 純文字(遷移前的既有歷史 row,或任何解析失敗的情況):原樣顯示——
 *     絕不因為看到舊資料就報錯或吞掉訊息。
 * 必須傳入呼叫端元件透過 useTranslation() 拿到的 t(不要裸 import i18next),
 * 這樣切換語言時已顯示的系統訊息才會立刻重新渲染,不會卡在載入當下的語言。
 *
 * `session.adapterError` 是特例:`params.message`/`params.detail` 是底層
 * adapter(Claude Code/Codex/OpenCode/PTY)的原始輸出,不是可翻譯的 UI 文字
 * ——只有 "[錯誤]" 這個標籤概念可翻譯(見 systemEvents.json 的
 * `session.adapterError.label`),訊息本身原樣接在標籤後面,不透過 i18next
 * 的插值塞進一個完整的翻譯句子範本(那樣等於把任意語言的內容硬套進另一個
 * 語言的句型)。
 */
export function resolveSystemEventText(raw: string, t: TFunction): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && typeof (parsed as { event?: unknown }).event === "string") {
      const { event, params } = parsed as { event: string; params?: Record<string, unknown> };
      if (event === "session.adapterError") {
        const label = t("systemEvents:session.adapterError.label", { defaultValue: "[錯誤]" });
        const message = String(params?.message ?? "");
        const detail = params?.detail ? `\n${String(params.detail)}` : "";
        return `${label} ${message}${detail}`;
      }
      return t(`systemEvents:${event}`, { ...params, defaultValue: raw });
    }
  } catch {
    // not JSON — pre-existing plain-text history row, or genuinely malformed; show as-is.
  }
  return raw;
}
