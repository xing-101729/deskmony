/**
 * tool-input.ts:從工具呼叫的 input 猜出指令/路徑候選值。
 *
 * core 的政策引擎(hard-deny 與 config 規則比對,apps/core/src/permissions/)與「永遠允許」的規則候選
 * (remember-rule.ts,桌面端彈窗與 CLI/TUI 共用)用同一份:UI 提議的規則要比對得到它自己的那個請求,兩邊對
 * 「input 裡哪些是指令、哪些是路徑」的認定必須一致。2026-10-22 之前桌面端與 CLI 各抄一份欄位清單,已經漂移過
 * (都少了 OpenCode 的 `filepath`)。這裡只放純函式——桌面端 renderer 也會載入,不能用 Node 模組。
 *
 * **誠實的限制**:`AgentEvent`(permission-request)的 `input` 欄位型別是
 * `z.unknown()`(見 events.ts)——三個後端(Claude Agent SDK / ACP / OpenCode)
 * 各自把不同形狀的工具參數塞進這裡:
 *   - Claude Agent SDK:canonical 工具名(`"Write"`/`"Bash"`/...)+ 官方定義的
 *     input 形狀(`file_path`/`command`/...)。
 *   - ACP:`toolName` 是 agent 自己取的**人類可讀標題**(例如 fake-acp-agent
 *     的 `"Write file"`),`input` 是 `toolCall.rawInput`——沒有任何跨後端保證
 *     的欄位命名(見 packages/adapters/src/acp-adapter.ts 對 `permission-request`
 *     的組裝)。
 * 因此這裡的欄位名稱清單是 **best-effort 的啟發式**,不是型別安全的解析——
 * 猜不到就回傳空陣列,呼叫端必須把「猜不到」導向「不 match」而不是「當作已確認安全」,
 * 維持 fail-safe 方向(見 docs/LAYER-4-detail-design/policy-engine_detail.md §3「判定失敗時的方向」)。
 *
 * 每個 `extract*Candidates()` 都回傳**所有**猜得到的值(各層、各欄位依序),不是只取第一個:
 * hard-deny 要每一個都檢查,config 規則依 effect 決定要「全部」還是「任一」符合(見
 * apps/core/src/permissions/policy-engine.ts 的 `ruleMatches()`)。只取第一個的話,一個無害的欄位就能
 * 把同一個 input 裡危險的那一個遮住。
 */

/** 常見的「指令字串」欄位名稱(Bash 類工具)。 */
const COMMAND_KEYS = ["command", "cmd", "script"];

/** 常見的「目標路徑」欄位名稱(檔案類工具)。 */
// `filepath`(全小寫):OpenCode 的 `permission.asked` 在工具 part 的完整 input 還沒收到時,退而求其次用的
// metadata(實測 edit 是 `{filepath, diff}`),見 packages/adapters/src/opencode-adapter.ts。
// `source`/`destination`(2026-10-22):參考實作 filesystem MCP 的 `move_file`(搬走 = 來源那一端也被改動,所以兩端都要檢查)。
// 名稱很通用,別的工具拿來放非路徑的字串(例如 `source: "web"`)時會被當成相對 workingDir 的路徑——落在 worktree 內,
// hard-deny 不會因此誤擋;對 config 規則只會讓 allow 更難命中、deny 更容易命中。
const PATH_KEYS = ["file_path", "filePath", "filepath", "path", "notebook_path", "directory", "dir_path", "target_path", "source", "destination"];

/** 值是路徑**陣列**的欄位:filesystem MCP 的 `read_multiple_files {paths: [...]}`。陣列裡不是字串的元素略過。 */
const PATH_LIST_KEYS = ["paths"];

function asRecord(input: unknown): Record<string, unknown> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  return input as Record<string, unknown>;
}

/**
 * 工具參數所在的物件層:最外層,加上 `arguments` 欄位(是物件時)那一層。
 *
 * 2026-10-22:codex-acp(1.13.1)把工具真正的參數包在 `arguments` 裡——MCP 工具的 rawInput 是
 * `{server, tool, arguments}`(dist 的 `createMcpRawInput()`),其餘 function call 是 `{name, arguments}`、
 * dynamic tool 是 `{arguments}`。只看最外層的話,hard-deny 對 codex 的 MCP 工具(例如 filesystem MCP 的
 * `read_file {path: "~/.ssh/id_rsa"}`、fetch MCP 的 `{url}`)什麼都看不到,auto 模式下直接落到「未分類
 * 中間地帶自動放行」。
 *
 * 只解**一層**、不遞迴:Claude Agent SDK 的 MCP 工具 input 本來就是參數物件本身,解一層正好讓 codex 跟它
 * 看到同樣深度的欄位。更深的物件是工具的資料(文件內容、表單欄位…),不是它要碰的路徑/網址——遞迴進去
 * 會讓 hard-deny 這個不可學習的地板開始誤擋,而經常誤喊的地板會讓人習慣性略過真正該看的那幾次。
 * 不要求旁邊有 `server`/`tool`:codex 的三種外殼都該看,別的後端剛好有物件型 `arguments` 參數時多檢查一層,
 * 只會讓 hard-deny 更嚴、config 規則依 effect 往安全側偏(見 policy-engine.ts 的 `ruleMatches()`)。
 * `arguments` 是字串(未解析的 JSON)時看不進去,維持「猜不到」。
 */
function inputLayers(input: unknown): Record<string, unknown>[] {
  const top = asRecord(input);
  if (!top) return [];
  const nested = asRecord(top.arguments);
  return nested ? [top, nested] : [top];
}

/** 各層(最外層 + `arguments` 外殼,見 `inputLayers()`)裡這些欄位的非空字串值,依層、依欄位順序。 */
export function toolInputFieldValues(input: unknown, keys: readonly string[]): string[] {
  const out: string[] = [];
  for (const layer of inputLayers(input)) {
    for (const key of keys) {
      const value = layer[key];
      if (typeof value === "string" && value.length > 0) out.push(value);
    }
  }
  return out;
}

/** 從工具呼叫的 input 猜測「指令字串」候選清單(Bash 類)。猜不到回傳空陣列。 */
export function extractCommandCandidates(input: unknown): string[] {
  return toolInputFieldValues(input, COMMAND_KEYS);
}

/** 從工具呼叫的 input 猜測「目標路徑」候選清單(檔案類),可能同時命中多個
 *  (例如同一個 input 物件裡剛好有 `path` 也有 `directory`)。猜不到回傳空陣列。 */
export function extractPathCandidates(input: unknown): string[] {
  const out = toolInputFieldValues(input, PATH_KEYS);
  for (const layer of inputLayers(input)) {
    for (const key of PATH_LIST_KEYS) {
      const value = layer[key];
      if (!Array.isArray(value)) continue;
      for (const item of value) if (typeof item === "string" && item.length > 0) out.push(item);
    }
  }
  return out;
}
