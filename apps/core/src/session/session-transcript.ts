/**
 * session-transcript.ts(2026-10-15,session 自動復活):後端沒辦法原生接回先前對話時的**退路**——
 * 把 Deskmony 自己存在 DB 裡的先前對話(user/assistant 文字),組成一段精簡的對話紀錄,附在送給新後端的
 * **第一則** prompt 最前面,讓 agent 讀過紀錄後能接續脈絡。
 *
 * 這是「讀紀錄接續」,不是「記得」:agent 不會有先前的工具呼叫結果、檔案內容、思考過程,所以紀錄開頭明講這是
 * Deskmony 在 app 重新開啟後補上的,UI 也會在對話裡留系統訊息告訴使用者同一件事(見 `session.revivedFromTranscript`)。
 * 用在 DB 儲存內容**不變**的前提下:使用者訊息在 DB 一律是原文(`delivery.persistedText`),這段文字只存在於送給 adapter
 * 的那一次 prompt 裡,不落地。
 *
 * 與 `RecoveryService.buildTakeoverSummary()`(「接手」的摘要)的差異:那個是人在復原視圖明確選擇「換一個全新的腦」、
 * 只帶最後約 3 輪、上限 4000 字元;這裡是 agent 在**同一個 session** 裡被悄悄換掉後端,要盡量保住脈絡,所以涵蓋整段
 * 對話(上限 `TRANSCRIPT_MAX_CHARS`,從最舊的開始截掉並註明),格式也不同。
 *
 * 純函式、不碰 DB——撈資料的部分在 `SessionManager`。
 */

/** 對話紀錄區塊(含說明文字與前後框線)的字元上限。 */
export const TRANSCRIPT_MAX_CHARS = 12_000;

/** 撈 DB 時最多取幾則 user/assistant 訊息(多取一則用來判斷「還有更舊的」);超過上限的字元預算前就會先被截掉。 */
export const TRANSCRIPT_MAX_MESSAGES = 400;

export interface TranscriptMessage {
  role: "user" | "assistant";
  content: string;
  /** 這則 user 訊息是別的 session 送來的/使用者轉傳的(不是使用者在這個 session 親自輸入的)。 */
  fromOtherSession?: boolean;
  /** 這則訊息夾帶了附件(內容不附進紀錄,只標一個記號)。 */
  hasAttachments?: boolean;
}

export interface BuiltTranscript {
  /** 要附在 prompt 前面的完整區塊(不含使用者的新訊息)。 */
  text: string;
  /** 實際放進區塊的訊息則數。 */
  includedCount: number;
  /** 因長度限制被省略的較早訊息則數(DB 裡更舊、根本沒撈出來的不計入,見 `olderNotLoaded`)。 */
  omittedCount: number;
  /** 有沒有任何內容被截掉(字元預算不夠,或撈出來的訊息之前還有更舊的)。 */
  truncated: boolean;
}

const FRAME_START = "--- 先前對話開始 ---";
const FRAME_END = "--- 先前對話結束 ---";
const NEW_MESSAGE_HEADER = "【使用者的新訊息】";
const TRIM_NOTE = "…(這則訊息太長,只保留結尾)\n";

function roleLabel(message: TranscriptMessage): string {
  if (message.role === "assistant") return "assistant";
  return message.fromOtherSession ? "使用者(轉自其他 session 的訊息)" : "使用者";
}

function renderEntry(message: TranscriptMessage): string | undefined {
  const content = message.content.trim();
  if (content.length === 0 && !message.hasAttachments) return undefined;
  const attachmentMark = message.hasAttachments ? "(附件內容未附上)" : "";
  return `${roleLabel(message)}: ${content}${attachmentMark ? ` ${attachmentMark}` : ""}`.trimEnd();
}

/** 完整區塊;`note` 是截斷說明(沒有截斷時為空字串)。 */
function frame(body: string, note: string): string {
  return [
    "【Deskmony 補充的先前對話】",
    "Deskmony(管理這個對話的桌面程式)在 app 重新開啟後重新啟動了你,你原本的對話狀態沒有保留。" +
      "下面是這個 session 先前的對話紀錄,由 Deskmony 補上,讓你接續脈絡:只含使用者的訊息與你當時的文字回覆," +
      "不含工具呼叫與其結果、檔案內容。請把它當作背景資料,不要逐字複述,也不必特別說明你讀過它;直接回應最後面的新訊息。" +
      note,
    FRAME_START,
    body,
    FRAME_END,
  ].join("\n");
}

function omittedNote(omittedCount: number, olderNotLoaded: boolean): string {
  if (omittedCount === 0 && !olderNotLoaded) return "";
  const what = olderNotLoaded ? "更早的若干則" : `較早的 ${omittedCount} 則`;
  return `(${what}訊息因長度限制已省略。)`;
}

/** 避免把字串切在 surrogate pair 中間(留下半個字元)。 */
function sliceTailSafe(text: string, keep: number): string {
  let start = text.length - keep;
  if (start <= 0) return text;
  const code = text.charCodeAt(start);
  if (code >= 0xdc00 && code <= 0xdfff) start += 1; // 落在低位 surrogate 上 = 切到 pair 中間,往後讓一格
  return text.slice(start);
}

/**
 * 組對話紀錄區塊。`messages` 由舊到新;沒有任何可用的文字訊息 → `undefined`(沒有東西可補)。
 *
 * 長度上限 `maxChars` 涵蓋整個區塊(說明文字 + 框線 + 內容)。放不下時**從最舊的訊息開始丟**,並在說明文字裡註明;
 * 連最新的一則都放不下就只保留它的結尾(最新的內容最能接上使用者的新訊息)。
 * `olderNotLoaded`:呼叫端撈出來的訊息之前,DB 裡還有更舊的(沒撈進來)——也要註明有截斷。
 */
export function buildTranscript(
  messages: TranscriptMessage[],
  options: { maxChars?: number; olderNotLoaded?: boolean } = {},
): BuiltTranscript | undefined {
  const maxChars = options.maxChars ?? TRANSCRIPT_MAX_CHARS;
  const olderNotLoaded = options.olderNotLoaded === true;
  const entries = messages.map(renderEntry).filter((e): e is string => e !== undefined);
  if (entries.length === 0) return undefined;

  // 說明文字的長度先用「最長的截斷說明」預留,內容預算 = 上限 - 框架 - 預留。
  const reserve = Math.max(frame("", omittedNote(entries.length, true)).length, frame("", omittedNote(entries.length, false)).length);
  const budget = Math.max(maxChars - reserve, 0);

  // 從最新往舊收,收到放不下為止。每則之間隔一個空行(2 個換行字元)。
  const kept: string[] = [];
  let used = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const cost = entries[i].length + (kept.length > 0 ? 2 : 0);
    if (used + cost > budget) break;
    kept.unshift(entries[i]);
    used += cost;
  }

  let omittedCount = entries.length - kept.length;
  if (kept.length === 0) {
    // 連最新的一則都放不下:只留它的結尾。
    const newest = entries[entries.length - 1];
    const room = Math.max(budget - TRIM_NOTE.length, 0);
    kept.push(`${TRIM_NOTE}${sliceTailSafe(newest, room)}`);
    omittedCount = entries.length - 1;
  }

  const truncated = omittedCount > 0 || olderNotLoaded || kept[0].startsWith(TRIM_NOTE);
  const text = frame(kept.join("\n\n"), omittedNote(omittedCount, olderNotLoaded));
  return { text, includedCount: kept.length, omittedCount, truncated };
}

/** 把對話紀錄區塊接到使用者的新訊息前面,組成實際送給 agent 的 prompt 文字。 */
export function prependTranscript(transcript: string, promptText: string): string {
  return `${transcript}\n\n${NEW_MESSAGE_HEADER}\n${promptText}`;
}

/**
 * 這則 prompt 是不是 slash command("/compact"、"/review ...")?agent 靠「開頭是 /指令」辨識它,前面多塞了對話紀錄就不再是
 * 指令了——這種 prompt 不附紀錄,紀錄留給下一則一般訊息。
 */
export function looksLikeSlashCommand(promptText: string): boolean {
  return /^\/\S/.test(promptText);
}
