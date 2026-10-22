import fs from "node:fs";
import path from "node:path";

/**
 * tool-input.ts(S1:PolicyEngine + hard-deny 共用的工具呼叫輸入解析)。
 *
 * **誠實的限制**:`AgentEvent`(permission-request)的 `input` 欄位型別是
 * `z.unknown()`(見 packages/shared/src/events.ts)——三個後端(Claude Agent
 * SDK / ACP / OpenCode)各自把不同形狀的工具參數塞進這裡:
 *   - Claude Agent SDK:canonical 工具名(`"Write"`/`"Bash"`/...)+ 官方定義的
 *     input 形狀(`file_path`/`command`/...)。
 *   - ACP:`toolName` 是 agent 自己取的**人類可讀標題**(例如 fake-acp-agent
 *     的 `"Write file"`),`input` 是 `toolCall.rawInput`——沒有任何跨後端保證
 *     的欄位命名(見 packages/adapters/src/acp-adapter.ts 對 `permission-request`
 *     的組裝)。
 * 因此這裡的欄位名稱清單是 **best-effort 的啟發式**,不是型別安全的解析——
 * 猜不到就回傳空陣列,呼叫端(hard-deny.ts/policy-engine.ts)必須
 * 把「猜不到」導向「不 match」而不是「當作已確認安全」,維持 fail-safe 方向
 * (見 policy-engine_detail.md §3「判定失敗時的方向」)。
 *
 * 每個 `extract*Candidates()` 都回傳**所有**猜得到的值(各層、各欄位依序),不是只取第一個:
 * hard-deny 要每一個都檢查,config 規則依 effect 決定要「全部」還是「任一」符合(見
 * policy-engine.ts 的 `ruleMatches()`)。只取第一個的話,一個無害的欄位就能把同一個 input 裡
 * 危險的那一個遮住。
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

/** 常見的「host/URL」欄位名稱(網路類工具)。 */
const HOST_KEYS = ["host", "hostname"];
const URL_KEYS = ["url", "uri", "endpoint"];

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

/** 各層裡這些欄位的非空字串值,依層、依欄位順序。 */
function stringValues(input: unknown, keys: readonly string[]): string[] {
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
  return stringValues(input, COMMAND_KEYS);
}

/** 從工具呼叫的 input 猜測「目標路徑」候選清單(檔案類),可能同時命中多個
 *  (例如同一個 input 物件裡剛好有 `path` 也有 `directory`)。猜不到回傳空陣列。 */
export function extractPathCandidates(input: unknown): string[] {
  const out = stringValues(input, PATH_KEYS);
  for (const layer of inputLayers(input)) {
    for (const key of PATH_LIST_KEYS) {
      const value = layer[key];
      if (!Array.isArray(value)) continue;
      for (const item of value) if (typeof item === "string" && item.length > 0) out.push(item);
    }
  }
  return out;
}

/** 從工具呼叫的 input 猜測「目標 host」候選清單(網路類)。猜不到回傳空陣列。 */
export function extractHostCandidates(input: unknown): string[] {
  const out = stringValues(input, HOST_KEYS);
  for (const value of stringValues(input, URL_KEYS)) {
    try {
      out.push(new URL(value).hostname);
    } catch {
      // 不是合法 URL,無法判斷 host——不列入候選(呼叫端視為「猜不到」,
      // 不視為「已核可的 host」)。
    }
  }
  return out;
}

/**
 * 盡力把路徑解析成 realpath(防 symlink 逃逸,見 policy-engine_detail.md §2)。
 *
 * 檔案類工具的目標路徑經常是**尚未存在的新檔案**(例如 Write 建立新檔),
 * `fs.realpathSync()` 對不存在的路徑會直接拋例外——這裡改成由最深路徑往上找
 * 第一個「存在」的祖先目錄,對那個存在的祖先做 realpath(防止它本身是指向
 * worktree 外的符號連結),再把原本不存在的尾段路徑片段原樣接回去。
 *
 * 找不到任何存在的祖先(理論上不會發生,檔案系統根目錄一定存在)時放棄
 * realpath,回傳單純 `path.resolve()` 的結果——呼叫端仍會用它做前綴比對,
 * 不是「放棄檢查」,只是少了 symlink 防護這一層。
 */
export function resolveRealpathBestEffort(rawPath: string, baseDir?: string): string {
  const absolute = path.isAbsolute(rawPath) ? rawPath : path.resolve(baseDir ?? process.cwd(), rawPath);
  const suffixSegments: string[] = [];
  let current = absolute;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const real = fs.realpathSync(current);
      return suffixSegments.length > 0 ? path.join(real, ...suffixSegments.reverse()) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        // 已到根目錄仍不存在——放棄 realpath,回傳原始 resolve 結果。
        return absolute;
      }
      suffixSegments.push(path.basename(current));
      current = parent;
    }
  }
}

/** Windows 檔案系統多半不分大小寫,比對前正規化大小寫,避免 `C:\Foo` 與
 *  `c:\foo` 被誤判為不同路徑而放過 escape。 */
function normalizeForCompare(p: string): string {
  const normalized = path.normalize(p);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/**
 * `child` 是否位於 `parent` 之下(或就是 `parent` 本身),**以路徑分隔符為界**
 * ——`/a/b` 不得比對到 `/a/bc`(見 policy-engine_detail.md §2)。呼叫端應先對
 * 兩邊都呼叫 `resolveRealpathBestEffort()`。
 */
export function isPathUnder(child: string, parent: string): boolean {
  const c = normalizeForCompare(child);
  const p = normalizeForCompare(parent);
  if (c === p) return true;
  const withSep = p.endsWith(path.sep) ? p : p + path.sep;
  return c.startsWith(withSep);
}
