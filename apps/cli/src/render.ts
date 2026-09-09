import type { AgentEvent, PolicyRule, SessionEventEnvelope } from "@deskmony/shared";

/**
 * 事件 → 終端輸出,以及色彩/ASCII 降級,全部集中在這個檔案(HLD §4.2 對
 * render.ts 的定位)。沒有任何一行直接判斷 `process.stdout.isTTY`/
 * `NO_COLOR`——那些判斷已經在 args.ts 的 `resolveColor()` 做完一次,這裡
 * 只信任呼叫端傳進來的 `color: boolean`,避免同一個判斷邏輯散落在多個
 * 檔案裡漂移。
 */

// ---- 色彩(HLD §7:不用 chalk,直接寫 SGR 碼) -----------------------------

const SGR = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
} as const;

type SgrCode = keyof typeof SGR;

export function paint(text: string, code: SgrCode, color: boolean): string {
  if (!color) return text;
  return `${SGR[code]}${text}${SGR.reset}`;
}

/**
 * HLD §7:「一律只用 ASCII(`->`、`*`、`|`)當結構符號」——cmd.exe 在
 * cp950/cp437 這類非 UTF-8 codepage 下,Unicode 框線字元與 emoji 會變亂碼,
 * 而 Node 沒有可靠的方式在啟動當下探測目前的 console codepage 是什麼
 * (`chcp` 需要另外 spawn 一個子程序,且結果在 CI/非互動環境下不一定有
 * 意義)。與其賭一個偵測不準的分支,不如整個 CLI 的結構符號一律固定用
 * ASCII——這是 args.ts 的 `--ascii` 旗標目前恆為 no-op 的原因,見該檔案
 * 對這個旗標的完整說明。
 */
const ARROW = "->";

// ---- 已知輸入鍵(§13.3 陷阱:絕不能只顯示 description) --------------------

/**
 * 與 apps/desktop/src/views/PermissionModal.tsx 的 `COMMAND_KEYS`/
 * `PATH_KEYS` **刻意維持同一份清單**(手動同步,不是 import——CLI 不依賴
 * apps/desktop,兩邊各自是獨立的 client,見 cli_hld.md §4.2 的套件邊界)。
 * 兩處讀的是同一個 `PermissionRequestEvent.input`(同一個 gateway 事件),
 * 「認得哪些鍵、優先顯示哪個」理應完全一致——不然使用者在桌面殼按「永遠
 * 允許」記住的規則範圍,會跟在 CLI 裡看到的提示文字對不上。若之後
 * `PermissionModal.tsx` 那份清單改了,這裡也要跟著改。
 */
const COMMAND_KEYS = ["command", "cmd", "script"];
const PATH_KEYS = ["file_path", "filePath", "path", "notebook_path", "directory", "dir_path", "target_path"];
/** 這幾個不影響「永遠允許」規則要多窄(見 buildNarrowestRememberRule()),
 *  純粹是讓提示訊息對更多常見工具(WebFetch/Grep/Write 的 content)更有
 *  資訊量,滿足 §13.3「絕不能只顯示 description」的精神。 */
const EXTRA_DISPLAY_KEYS: Array<{ key: string; label: string }> = [
  { key: "url", label: "URL" },
  { key: "pattern", label: "Pattern" },
  { key: "content", label: "內容" },
  { key: "prompt", label: "Prompt" },
];

function asRecord(input: unknown): Record<string, unknown> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  return input as Record<string, unknown>;
}

function firstStringByKeys(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen)}...(已截斷,原長度 ${s.length})`;
}

function safeJsonStringify(input: unknown): string {
  if (input === undefined) return "(無)";
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

/**
 * §13.3 的陷阱修正:把 `unknown` 的工具輸入,轉成「認得的鍵優先單獨顯示,
 * 其餘 JSON 截斷」的多行文字——用在互動式權限提示(prompt.ts)與非互動模式
 * 被拒絕時印到 stderr 的訊息(commands/run.ts),兩處共用同一份邏輯,確保
 * 「使用者在互動模式看到的提示」與「腳本在非互動模式讀到的拒絕原因」內容
 * 一致。
 *
 * 絕不回傳只有 description 可用的結果——找不到任何已知鍵時,退回完整
 * (截斷過的)JSON,而不是放棄顯示。
 */
export function summarizeToolInputLines(input: unknown, maxFieldLen = 300): string[] {
  const obj = asRecord(input);
  if (!obj) return [`參數:${truncate(safeJsonStringify(input), maxFieldLen)}`];

  const lines: string[] = [];
  const command = firstStringByKeys(obj, COMMAND_KEYS);
  if (command !== undefined) lines.push(`指令:${truncate(command, maxFieldLen)}`);
  const filePath = firstStringByKeys(obj, PATH_KEYS);
  if (filePath !== undefined) lines.push(`路徑:${filePath}`);
  for (const { key, label } of EXTRA_DISPLAY_KEYS) {
    const value = obj[key];
    if (typeof value === "string" && value.length > 0) {
      lines.push(`${label}:${truncate(value, maxFieldLen)}`);
    }
  }
  if (lines.length === 0) {
    lines.push(`參數:${truncate(safeJsonStringify(input), maxFieldLen)}`);
  }
  return lines;
}

/** `tool-call` 事件的單行摘要(HLD §5:「  -> <toolName> <單行摘要>」)。 */
export function summarizeToolCallOneLine(toolName: string, input: unknown): string {
  const obj = asRecord(input);
  if (!obj) return toolName;
  const command = firstStringByKeys(obj, COMMAND_KEYS);
  if (command !== undefined) return `${toolName} ${truncate(command, 120)}`;
  const filePath = firstStringByKeys(obj, PATH_KEYS);
  if (filePath !== undefined) return `${toolName} ${filePath}`;
  if (input === undefined) return toolName;
  return `${toolName} ${truncate(safeJsonStringify(input), 120)}`;
}

function dirnameOf(p: string): string {
  const normalized = p.replace(/\\/g, "/").replace(/\/+$/, "");
  const idx = normalized.lastIndexOf("/");
  if (idx <= 0) return normalized.startsWith("/") ? "/" : normalized;
  return normalized.slice(0, idx);
}

/**
 * 「永遠允許(最窄規則)」——與 apps/desktop/src/views/PermissionModal.tsx
 * 的 `buildRememberCandidates()` 選出的**第一個(預設)候選**規則刻意採用
 * 完全相同的邏輯(HLD §6:「[A] 只送最窄的規則,與 PermissionModal.tsx 的
 * 預設一致」):
 *   1. 有 command 類的鍵 → `commandEquals`(完整比對這一次的指令字串)。
 *   2. 沒有 command、但有 path 類的鍵 → `pathUnder`(這個檔案所在的目錄,
 *      不是檔案本身——目錄前綴比對比「只允許這一個檔名」更常用,也是
 *      PermissionModal.tsx 選的預設候選)。
 *   3. 都沒有 → 對這個工具整體放行(`{tool, effect:"allow"}`,不帶
 *      `when`)。
 * CLI 不提供 PermissionModal.tsx 那個「commandMatches 前綴規則」的第二個
 * candidate 選項——單鍵互動(見 prompt.ts)沒有位置放「選單」,Phase 1 只
 * 給預設(最窄)這一種,想要更寬的規則仍然可以到桌面殼的「權限」設定頁
 * 手動加。
 */
export function buildNarrowestRememberRule(toolName: string, input: unknown): PolicyRule {
  const obj = asRecord(input);
  const command = obj ? firstStringByKeys(obj, COMMAND_KEYS) : undefined;
  if (command !== undefined) {
    return { tool: toolName, when: { commandEquals: command }, effect: "allow" };
  }
  const filePath = obj ? firstStringByKeys(obj, PATH_KEYS) : undefined;
  if (filePath !== undefined) {
    return { tool: toolName, when: { pathUnder: dirnameOf(filePath) }, effect: "allow" };
  }
  return { tool: toolName, effect: "allow" };
}

// ---- 換行狀態追蹤 ---------------------------------------------------------

/**
 * `message-delta` 是不帶結尾換行的片段串流,但接下來要印的東西(tool-call
 * 摘要行、下一個提示符、`completed` 之後的收尾)幾乎都假設「目前在一行的
 * 開頭」。與其每個呼叫點各自猜「上一次寫的東西結尾是不是換行」,集中記在
 * 這裡一次:所有經過這個 tracker 的 stdout 寫入都會更新狀態,`ensureNewline()`
 * 只在真的需要時才補一個 `\n`,不會製造多餘的空行。
 */
export function createStdoutTracker(): { write: (text: string) => void; ensureNewline: () => void } {
  let endsWithNewline = true;
  return {
    write(text: string): void {
      if (text.length === 0) return;
      process.stdout.write(text);
      endsWithNewline = text.endsWith("\n");
    },
    ensureNewline(): void {
      if (!endsWithNewline) {
        process.stdout.write("\n");
        endsWithNewline = true;
      }
    },
  };
}

// ---- --json(NDJSON) ------------------------------------------------------

/**
 * HLD §5:「`--json` 是 NDJSON(每行一個 JSON 物件),不是最後吐一顆大
 * JSON——串流場景下前者才可用」。刻意攤平 `sessionId`/`timestamp` 與
 * `event` 的欄位到同一層(而不是巢狀 `{sessionId, event: {...}}`)——消費端
 * 多半用 `jq 'select(.type=="message-delta") | .delta'` 這類單層路徑,少一層
 * 巢狀比較好寫。`type` 來自 `event` 本身的判別欄位,攤平後不會與
 * `sessionId`/`timestamp` 撞名。
 */
export function formatEventNdjson(envelope: SessionEventEnvelope): string {
  return JSON.stringify({ sessionId: envelope.sessionId, timestamp: envelope.timestamp, ...envelope.event });
}

// ---- 互動/預設(pretty)輸出:HLD §5 表格 ----------------------------------

export interface PrettyRenderOptions {
  color: boolean;
  verbose: boolean;
}

/**
 * 把一個 `AgentEvent` 轉成要寫進 stdout 的文字(不含前面提到的 permission-
 * request——那個需要問答,交給 prompt.ts 處理,這裡只負責「不需要人回應」
 * 的事件)。回傳 `undefined` 代表這個事件在目前設定下不印任何東西(例如
 * 非 --verbose 時的 usage/context-usage、非 isError 的 tool-result)。
 *
 * 不含 `completed`/`error`——這兩個是「這一輪結束」的訊號,呼叫端(run.ts/
 * chat.ts)要另外做退出碼/REPL 收尾判斷(見 §13.4/§13.5 的陷阱),不是單純
 * 的「印一行字」,故意不塞進這個以字串為回傳值的通用函式。
 */
export function renderAgentEventPretty(event: AgentEvent, opts: PrettyRenderOptions): string | undefined {
  switch (event.type) {
    case "message-delta":
      return event.delta;
    case "tool-call":
      return `  ${ARROW} ${summarizeToolCallOneLine(event.toolName, event.input)}\n`;
    case "tool-result":
      if (!event.isError) return undefined;
      return `  ${paint("!", "red", opts.color)} ${event.toolName} 執行失敗${
        event.output !== undefined ? `:${truncate(safeJsonStringify(event.output), 200)}` : ""
      }\n`;
    case "usage":
      if (!opts.verbose) return undefined;
      return `  ${paint("*", "dim", opts.color)} usage: ${
        event.costAmount !== undefined ? `${event.costAmount}${event.costCurrency ?? ""}` : "(無金額回報)"
      }${event.inputTokens !== undefined ? ` in=${event.inputTokens}` : ""}${
        event.outputTokens !== undefined ? ` out=${event.outputTokens}` : ""
      }\n`;
    case "context-usage":
      if (!opts.verbose) return undefined;
      return `  ${paint("*", "dim", opts.color)} context: ${event.used}/${event.size}\n`;
    case "terminal-data":
      return event.data;
    case "available-commands":
    case "user-dialog-request":
    case "permission-request":
    case "completed":
    case "error":
      return undefined;
  }
}

/** `error` 事件(HLD §5:「印到 stderr,退出碼 1」——這裡只管格式化文字,
 *  退出碼由呼叫端決定)。 */
export function renderErrorEvent(message: string, detail: string | undefined, color: boolean): string {
  const head = paint(`[deskmony] agent 回報錯誤:${message}`, "red", color);
  return detail ? `${head}\n${detail}\n` : `${head}\n`;
}

// ---- 純文字表格(session list / profile list 共用) -------------------------

/**
 * 沒有終端機寬度偵測、沒有斷詞換行——刻意簡單:每欄取這一欄所有值裡最長
 * 的寬度(上限 `maxColWidth`,超過的截斷),欄與欄之間用兩個空白分隔(不用
 * `|` 這種需要對齊的視覺框線,窄終端機/欄位長度差很多時,框線反而比純
 * 空白更容易看起來歪掉)。回傳陣列(每個元素一行),由呼叫端決定怎麼印。
 */
export function renderTable(headers: string[], rows: string[][], maxColWidth = 40): string[] {
  const widths = headers.map((h, i) => {
    const longest = rows.reduce((max, row) => Math.max(max, (row[i] ?? "").length), h.length);
    return Math.min(longest, maxColWidth);
  });
  const formatRow = (cells: string[]): string =>
    cells
      .map((cell, i) => {
        const w = widths[i] ?? 0;
        const truncated = cell.length > w ? `${cell.slice(0, Math.max(0, w - 3))}...` : cell;
        return truncated.padEnd(w);
      })
      .join("  ")
      .trimEnd();
  return [formatRow(headers), ...rows.map(formatRow)];
}
