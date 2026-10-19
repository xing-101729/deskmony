import type { ChatItem } from "../stores/session-store.js";

/**
 * 2026-10-16:把對話串裡**連續**的工具呼叫收成一組(UI 上疊成一張可展開的卡片,見
 * views/chat/ToolCallGroup.tsx)。
 *
 * 為什麼要有這層:agent 一次問答常常連續呼叫十幾次工具(codex 光是 Guardian Review 就夾在每個 MCP 呼叫之間),
 * 以前每個呼叫都是一張獨立卡片,把真正的回覆擠到很下面。
 *
 * 這個檔案**刻意只有型別 import**(`import type` 編譯後整行消失):分組是純函式,
 * `scripts/e2e-chat-groups.mjs` 直接用 Node 載入這份 .ts 來測,不能牽出 React / zustand / i18next。
 * 所以「哪些工具要獨立顯示」(提問工具,`isQuestionToolName`,放在同樣零依賴的 lib/question-tools.ts)由呼叫端傳進來,
 * 而不是在這裡 import——Node 直接跑 .ts 時不會幫 `./x.js` 找到 `./x.ts`,這個檔案不能有執行期的相對 import。
 */

export type ToolItem = Extract<ChatItem, { kind: "tool" }>;

/** 渲染單位:一則原樣渲染的訊息,或一組(≥ 2 個)連續工具呼叫。 */
export type ChatEntry =
  | { type: "item"; key: string; item: ChatItem }
  | { type: "toolGroup"; key: string; items: ToolItem[] };

/** 內容(去掉空白後)是空的 assistant 訊息。 */
function isBlankAssistant(item: ChatItem): boolean {
  return item.kind === "assistant" && item.content.trim() === "";
}

function itemEntry(item: ChatItem): ChatEntry {
  return { type: "item", key: item.id, item };
}

/**
 * 把時間軸切成渲染單位。規則:
 *
 *   - 連續的 `kind: "tool"` 歸成一組;遇到 user / system / 有內容的 assistant 就斷開。
 *   - `isInteractiveTool(toolName)` 為真的工具(互動式提問,要使用者作答)**不進組**,獨立顯示並斷開前後的組——
 *     收進摺疊裡,使用者就看不到那張要他回答的表單了。
 *   - 只有 1 個工具的「組」不成組,照原樣當一則訊息(沒有額外外框)。
 *   - 組的 key 是第一個工具的 id(`tool-group:<id>`):新工具加進來、串流更新時 key 不變,
 *     元件的展開狀態才不會被重置。
 *
 * **空的 assistant 訊息不會把組切斷。** 串流途中 agent 常在工具之間吐出內容為空(或只有空白)的訊息——
 * ACP 的空 text chunk、Claude 的空 `text_delta`、OpenCode 剛建立還沒有文字的 text part,store 都會為它們建一則
 * `content: ""` 的 assistant item(以 messageId 為 key,位置固定)。這些訊息在歷史重載後不存在(沒有內容就不落地),
 * 若讓它們切斷組,同一串工具在串流當下是好幾個單張卡片、重載之後卻變成一組,畫面會前後不一致;而且它們本身只渲染成
 * 一個空氣泡,沒有任何資訊量。所以:
 *   - 夾在兩個可入組工具**之間**的空訊息 → 吸收掉(不出現在輸出裡,組也不含它)。
 *   - 在一串工具**尾端**、後面不是工具的空訊息 → 照原位置、原樣輸出在組之後。這是「agent 正要開始回覆」
 *     的游標(streaming 中、還沒有第一個字),保留既有的畫面行為;之後它長出內容就是一般的 assistant 訊息。
 *   - 在一串工具**之前**的空訊息 → 本來就不在 run 裡,原樣輸出。
 */
export function groupChatItems(
  items: readonly ChatItem[],
  isInteractiveTool: (toolName: string) => boolean,
): ChatEntry[] {
  const entries: ChatEntry[] = [];
  let run: ToolItem[] = [];
  /** run 尾端累積的空 assistant:後面接到工具就丟掉(吸收),否則在 run 結算後原樣補出。 */
  let blanks: ChatItem[] = [];

  const flush = (): void => {
    if (run.length >= 2) {
      entries.push({ type: "toolGroup", key: `tool-group:${run[0].id}`, items: run });
    } else if (run.length === 1) {
      entries.push(itemEntry(run[0]));
    }
    for (const blank of blanks) entries.push(itemEntry(blank));
    run = [];
    blanks = [];
  };

  for (const item of items) {
    if (item.kind === "tool" && !isInteractiveTool(item.toolName)) {
      run.push(item);
      blanks = [];
      continue;
    }
    if (run.length > 0 && isBlankAssistant(item)) {
      blanks.push(item);
      continue;
    }
    flush();
    entries.push(itemEntry(item));
  }
  flush();
  return entries;
}

/**
 * 摘要列用的工具名:`mcp.deskmony.send_to_session`(codex/ACP)與 `mcp__deskmony__send_to_session`
 * (Claude)都只留最後一段 `send_to_session`——前綴對同一個 session 來說每個都一樣,留著只會把摘要擠滿。
 * 只處理 `mcp.` / `mcp__` 開頭的:ACP 的工具名是 agent 自訂的自由字串(例如 "Read package.json"),
 * 不能看到句點就切。
 */
export function shortToolName(toolName: string): string {
  const name = toolName || "tool";
  const prefix = /^mcp(\.|__)/.exec(name);
  if (!prefix) return name;
  const rest = name.slice(prefix[0].length);
  const sep = prefix[1];
  const idx = rest.lastIndexOf(sep);
  const last = idx >= 0 ? rest.slice(idx + sep.length) : rest;
  return last || name;
}

export interface ToolGroupSummary {
  total: number;
  /** 依首次出現順序去重後的(縮短過的)工具名。 */
  names: string[];
  runningCount: number;
  /** 目前正在跑的工具名(多個同時跑時取最後一個,也就是最新開始的);沒有執行中的則為 undefined。 */
  runningName: string | undefined;
  /** 已結束且失敗的個數(`ToolCallBubble` 同樣只在不是 running 時才看 isError)。 */
  failedCount: number;
  /** 彙總狀態:有任何一個執行中 → running;否則有失敗 → failed;否則 done。 */
  status: "running" | "failed" | "done";
}

export function summarizeToolGroup(items: readonly ToolItem[]): ToolGroupSummary {
  const names: string[] = [];
  let runningCount = 0;
  let runningName: string | undefined;
  let failedCount = 0;
  for (const item of items) {
    const name = shortToolName(item.toolName);
    if (!names.includes(name)) names.push(name);
    if (item.status === "running") {
      runningCount++;
      runningName = name;
    } else if (item.isError) {
      failedCount++;
    }
  }
  return {
    total: items.length,
    names,
    runningCount,
    runningName,
    failedCount,
    status: runningCount > 0 ? "running" : failedCount > 0 ? "failed" : "done",
  };
}

/**
 * `ToolCallGroup` 的 memo 比較函式:逐一比 item 引用。
 *
 * `groupChatItems()` 每次 `items` 變動(串流中每個 token 都會)都重新算一遍,每個組的 `items` 陣列都是新建的——
 * 預設的淺比較會永遠判定「props 變了」,等於 memo 白包。但 store 裡的 ChatItem 是 immutable(每次更新都建新物件),
 * 所以「長度相同且每個位置的引用相同」就代表這組內容完全沒變,可以跳過重繪。
 */
export function sameToolItems(a: readonly ToolItem[], b: readonly ToolItem[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
