import type { MessageOrigin } from "@deskmony/shared";

/**
 * session-envelope.ts(2026-10-02,P3「session 網路」新增,見
 * docs/LAYER-4-detail-design/simplify-agents-sessions_detail.md §P3.2)。
 *
 * 跨 session 訊息送進目標 session 的 **prompt 文字**要帶一層信封,讓收到的 agent 知道:
 *   1. 這不是使用者打的字,是別的 session(或使用者轉傳)來的;
 *   2. 是誰、哪個 agent;
 *   3. **這則訊息不會自動得到回覆**——要不要回、回給誰由它自己決定,要回就用 `send_to_session`。
 *
 * **信封只給 agent 看**:持久化的 `messages.content` 存的是**原始 message 本體**(連同 `origin` 欄位),
 * 信封只在送進 adapter 的那一刻才由這裡組裝——所以 UI 顯示「來自 <title>」標籤 + 本體,不會看到樣板文字,
 * 之後若要調整樣板文字也不必改任何歷史資料。純函式、沒有副作用,方便單元測試。
 */

/** 標題可能含換行/「」,壓成單行避免破壞信封第一行的格式(只影響給 agent 看的那一行,不改任何儲存的資料)。 */
function oneLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, " ").trim();
}

export interface EnvelopeSender {
  sessionId: string;
  title: string;
  /** 送出方的 agent 顯示名稱(providerId 對應的 label;找不到就是 providerId 本身)。 */
  agentLabel: string;
}

/** `send_to_session`/`create_session` 的信封(規格 §P3.2 的樣板,逐字)。 */
export function buildSessionEnvelope(sender: EnvelopeSender, message: string): string {
  return [
    `[來自 session「${oneLine(sender.title)}」(id: ${sender.sessionId},agent: ${oneLine(sender.agentLabel)})的訊息]`,
    message,
    "",
    "—",
    `(系統提示:這則訊息不會自動得到回覆。若你要回應,請用 send_to_session 傳給 ${sender.sessionId},或任何其他合適的 session。)`,
  ].join("\n");
}

/**
 * UI「轉傳到…」的信封:標明是**使用者**從 session X 轉來(不是那個 session 的 agent 直接寫給你的)。
 * `message` 是被轉傳的 assistant 訊息(含使用者選填的附註,見 SessionManager.forwardMessage)。
 */
export function buildForwardEnvelope(sender: EnvelopeSender, message: string): string {
  return [
    `[使用者從 session「${oneLine(sender.title)}」(id: ${sender.sessionId},agent: ${oneLine(sender.agentLabel)})轉來的訊息]`,
    message,
    "",
    "—",
    `(系統提示:這是使用者從另一個 session 轉來的內容,那個 session 的 agent 並不知道你收到了它,也不會自動得到你的回覆。` +
      `要不要回應、回給誰由你決定;若要回覆那個 session,請用 send_to_session 傳給 ${sender.sessionId},或任何其他合適的 session。)`,
  ].join("\n");
}

/** 依 `origin.kind` 選信封——佇列裡的訊息只存 `{text, origin}`,送進 adapter 那一刻才呼叫這個。 */
export function buildEnvelopeForOrigin(origin: MessageOrigin, agentLabel: string, message: string): string {
  const sender: EnvelopeSender = { sessionId: origin.sessionId, title: origin.title, agentLabel };
  return origin.kind === "forward" ? buildForwardEnvelope(sender, message) : buildSessionEnvelope(sender, message);
}
