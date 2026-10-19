/**
 * Session 標題(2026-10-06:手動改名 + AI 自動命名)的共用常數與純函式。
 *
 * 刻意**不 import zod 或任何 node:* 模組**:core(驗證、組命名指示、清理 AI 輸出)、桌面端(輸入框長度上限)與
 * scripts/ 底下的假後端(辨認「這是一則命名請求」)都直接用這個檔案,假後端是以獨立行程載入
 * `packages/shared/dist/session-title.js` 的,越輕越好。`titleSource` 的 zod schema 放在 session.ts。
 *
 * 標題來源(`Session.titleSource`)三態:
 *   - `default`:還是預設標題(`DEFAULT_SESSION_TITLE`),第一則人類輸入送出後會自動命名。
 *   - `auto`:自動命名的結果(用 session 自己的 agent 在臨時對話裡產生,失敗就退回截取第一則訊息的第一行)。
 *   - `user`:使用者手動改過,或建立時就明確給了標題(UI 帶 title、`create_session` 工具)——**之後 AI 絕不自動覆蓋**,
 *     只有使用者自己按「AI 重新命名」才會換掉。
 */

/** 新 session 沒給標題時的預設值(DB 欄位的 DEFAULT 也是這個字串;舊資料遷移靠它判斷 `default`)。 */
export const DEFAULT_SESSION_TITLE = "新對話";

/** 手動改名的長度上限(以 Unicode code point 計,中文一字、emoji 一個都算 1)。 */
export const SESSION_TITLE_MAX_CHARS = 100;

/** AI 產生的標題清理後的上限——指示裡要求 30 字以內,這裡留一點餘裕給不太聽話的 model,超過就截斷加「…」。 */
export const GENERATED_TITLE_MAX_CHARS = 40;

/** 退回「截取第一則訊息第一行」時的上限。 */
export const FALLBACK_TITLE_MAX_CHARS = 30;

/** 命名用的臨時對話最多等多久(逾時就退回截取首句,絕不影響主 session)。 */
export const TITLE_GENERATION_TIMEOUT_MS = 60_000;

/** 命名指示裡引用的訊息各自最多帶多少字元(太長的第一則訊息只取開頭,避免臨時對話白白燒 token)。 */
const TITLE_REQUEST_MESSAGE_MAX_CHARS = 2_000;
const TITLE_REQUEST_REPLY_MAX_CHARS = 1_000;

/**
 * 命名指示的第一行。假後端(scripts/fake-acp-agent.mjs、fake-opencode-server.mjs)靠它辨認「這是一則命名請求」,
 * 所以是 export 的單一來源,不在兩邊各寫一份字面值。
 *
 * 指示用英文寫:它是給各家 agent 的 model 看的(Claude、OpenCode 的免費模型、Codex……),英文指示對各家最穩;
 * 「依使用者的語言命名」寫在規則裡,標題本身的語言跟著使用者的訊息走。
 */
export const TITLE_REQUEST_HEADER = "Write a short title for the conversation below.";

const MESSAGE_OPEN = "<<<";
const MESSAGE_CLOSE = ">>>";

/** 以 code point 計算長度(`"😀".length === 2`,但它是一個字)。 */
export function countTitleChars(text: string): number {
  return Array.from(text).length;
}

/** 截到 `max` 個 code point,有截掉就補「…」(總長仍不超過 `max`)。 */
export function truncateTitle(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return `${chars.slice(0, Math.max(1, max - 1)).join("").trimEnd()}…`;
}

/** 換行、tab 等控制字元換成空白(標題是單行顯示)。 */
function replaceControlChars(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ");
}

/**
 * 手動改名的檢查:換行/控制字元換成空白、去頭尾空白後,必須是 1–`SESSION_TITLE_MAX_CHARS` 個字。
 * 回傳正規化後的標題,或失敗原因(core 依此丟 `session.titleEmpty` / `session.titleTooLong`)。
 */
export function checkManualTitle(
  raw: string,
): { ok: true; title: string } | { ok: false; reason: "empty" } | { ok: false; reason: "tooLong"; length: number } {
  const title = replaceControlChars(raw).trim();
  if (title.length === 0) return { ok: false, reason: "empty" };
  const length = countTitleChars(title);
  if (length > SESSION_TITLE_MAX_CHARS) return { ok: false, reason: "tooLong", length };
  return { ok: true, title };
}

/** 去掉 markdown 標記、引號、頭尾標點這類「不是標題內容」的東西,並把連續空白收成一個。 */
function stripDecorations(line: string): string {
  let text = line
    // 行首的 markdown:標題 #、引言 >、清單 - * + 1.、粗體/程式碼標記
    .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, "")
    .replace(/[*_`~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  // 成對的外層引號/括號(可能不只一層)
  for (let i = 0; i < 3; i++) {
    const unwrapped = text.replace(/^["'“”‘’「『《〈【(\[]+|["'“”‘’」』》〉】)\]]+$/g, "").trim();
    if (unwrapped === text) break;
    text = unwrapped;
  }
  // 尾端句號類標點(標題不需要)
  return text.replace(/[。.!！?？,，、;；:：]+$/u, "").trim();
}

/**
 * 退回方案:取第一則訊息的第一個非空白行,清理後截到 `FALLBACK_TITLE_MAX_CHARS`。
 * 沒有任何文字(例如只有附件)時回傳 undefined——呼叫端維持原標題。
 */
export function fallbackTitleFromText(text: string): string | undefined {
  for (const line of text.split(/\r?\n/)) {
    const cleaned = stripDecorations(replaceControlChars(line));
    if (cleaned.length > 0) return truncateTitle(cleaned, FALLBACK_TITLE_MAX_CHARS);
  }
  return undefined;
}

/** 常見的「標題:」前綴(各語言),model 不聽話加上去時拿掉。 */
const TITLE_PREFIX_PATTERN = /^(?:title|session title|標題|标题|題名|タイトル|título|titulo|제목)\s*[:：]\s*/i;

/**
 * 清理 agent 在臨時對話裡回的標題:拿掉 `<think>…</think>` 這類推理標記、取第一個非空白行、去掉「Title:」前綴與
 * 外層引號/尾端標點,截到 `GENERATED_TITLE_MAX_CHARS`。清理後是空的回傳 undefined(呼叫端退回截取首句)。
 */
export function sanitizeGeneratedTitle(raw: string): string | undefined {
  const withoutThinking = raw.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, "");
  for (const line of withoutThinking.split(/\r?\n/)) {
    // 先拿掉 markdown(`**Title:** 標題` 這種),再拿前綴,再清一次前綴後面殘留的引號/標點。
    const cleaned = stripDecorations(replaceControlChars(line));
    const unprefixed = stripDecorations(cleaned.replace(TITLE_PREFIX_PATTERN, ""));
    if (unprefixed.length > 0) return truncateTitle(unprefixed, GENERATED_TITLE_MAX_CHARS);
  }
  return undefined;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/**
 * 送進臨時對話的命名指示。`firstMessage` 是使用者的第一則訊息;手動「AI 重新命名」既有 session 時可以多帶
 * `firstReply`(agent 的第一則回覆),讓標題貼近對話實際在做的事。
 */
export function buildTitleRequestPrompt(input: { firstMessage: string; firstReply?: string }): string {
  const lines = [
    TITLE_REQUEST_HEADER,
    "Rules:",
    "- Use the same language as the user's message (for example, Traditional Chinese if the user wrote in Traditional Chinese).",
    '- At most 30 characters (about 6 words in English). No quotes, no trailing punctuation, no prefix such as "Title:".',
    "- Reply with the title only. Do not use any tools, do not ask questions, do not explain.",
    "",
    "User's first message:",
    MESSAGE_OPEN,
    clip(input.firstMessage.trim(), TITLE_REQUEST_MESSAGE_MAX_CHARS),
    MESSAGE_CLOSE,
  ];
  if (input.firstReply && input.firstReply.trim().length > 0) {
    lines.push("", "Assistant's first reply:", MESSAGE_OPEN, clip(input.firstReply.trim(), TITLE_REQUEST_REPLY_MAX_CHARS), MESSAGE_CLOSE);
  }
  return lines.join("\n");
}

/**
 * `buildTitleRequestPrompt()` 的反向:這段文字是不是命名請求、引用的使用者訊息是什麼。給假後端用
 * (它們依引用訊息裡的測試標記決定要回標題、嘗試用工具、卡住還是失敗)。
 */
export function parseTitleRequestPrompt(text: string): { firstMessage: string } | undefined {
  if (!text.startsWith(TITLE_REQUEST_HEADER)) return undefined;
  const start = text.indexOf(`${MESSAGE_OPEN}\n`);
  if (start === -1) return undefined;
  const end = text.indexOf(`\n${MESSAGE_CLOSE}`, start);
  if (end === -1) return undefined;
  return { firstMessage: text.slice(start + MESSAGE_OPEN.length + 1, end) };
}
