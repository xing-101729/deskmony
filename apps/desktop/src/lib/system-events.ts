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
      if (event === "session.sendFailed") {
        // 2026-10-15:`session.sendPrompt` 被 core 拒絕(agent 重新啟動失敗、預算擋下……)時由 session-store 在本地插入的提示
        // (不落地)。params 帶的是那個 DeskmonyError 的 code/errorParams/message——渲染時才用 `errors:<code>` 翻譯(和
        // translateError() 同一套規則),所以使用者切換語言時這行也跟著換。
        const label = t("systemEvents:session.sendFailed.label", { defaultValue: "[訊息未送出]" });
        const message = String(params?.message ?? "");
        const code = typeof params?.code === "string" ? params.code : undefined;
        const errorParams =
          params?.errorParams && typeof params.errorParams === "object" ? (params.errorParams as Record<string, unknown>) : {};
        const reason = code ? t(`errors:${code}`, { ...errorParams, defaultValue: message }) : message;
        return `${label} ${reason}`;
      }
      return t(`systemEvents:${event}`, { ...params, defaultValue: raw });
    }
  } catch {
    // not JSON — pre-existing plain-text history row, or genuinely malformed; show as-is.
  }
  return raw;
}

/** 系統訊息泡泡的色調:`info` 一般說明、`warn` 需要使用者留意、`danger` 錯誤。 */
export type SystemEventTone = "info" | "warn" | "danger";

/**
 * 2026-10-15:原本所有系統訊息一律用錯誤的紅色底(`danger`)。agent 重新啟動後的說明不是錯誤——原生接回/沒有東西要補是一般
 * 資訊(`info`),只能靠對話紀錄接續/沒有記憶是使用者該留意的(`warn`:agent 讀的是紀錄,不是真的記得)。其餘事件維持原本的
 * `danger`(不在這次改動範圍內重新設計)。
 */
export function systemEventTone(raw: string): SystemEventTone {
  try {
    const parsed: unknown = JSON.parse(raw);
    const event = parsed && typeof parsed === "object" ? (parsed as { event?: unknown }).event : undefined;
    switch (event) {
      case "session.revivedResumed":
      case "session.revivedFresh":
      case "session.continuedAfterInterrupt":
        return "info";
      case "session.revivedFromTranscript":
      case "session.revivedFromTranscriptTruncated":
      case "session.revivedWithoutMemory":
      // agent 自己停止執行:不是使用者做錯了什麼,下一則訊息就會重新啟動它——要留意,但不是錯誤。
      case "session.agentStopped":
        return "warn";
    }
  } catch {
    // 不是 JSON(遷移前的純文字歷史)——維持預設色調。
  }
  return "danger";
}
