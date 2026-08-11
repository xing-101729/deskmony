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
 * 猜不到就回傳 `undefined`/空陣列,呼叫端(hard-deny.ts/policy-engine.ts)必須
 * 把「猜不到」導向「不 match」而不是「當作已確認安全」,維持 fail-safe 方向
 * (見 policy-engine_detail.md §3「判定失敗時的方向」)。
 */

/** 常見的「指令字串」欄位名稱(Bash 類工具),依序嘗試。 */
const COMMAND_KEYS = ["command", "cmd", "script"];

/** 常見的「目標路徑」欄位名稱(檔案類工具),依序嘗試,可能同時命中多個
 *  (例如同一個 input 物件裡剛好有 `path` 也有 `directory`)。 */
const PATH_KEYS = ["file_path", "filePath", "path", "notebook_path", "directory", "dir_path", "target_path"];

/** 常見的「host/URL」欄位名稱(網路類工具)。 */
const HOST_KEYS = ["host", "hostname"];
const URL_KEYS = ["url", "uri", "endpoint"];

function asRecord(input: unknown): Record<string, unknown> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  return input as Record<string, unknown>;
}

/** 從工具呼叫的 input 猜測「指令字串」(Bash 類)。猜不到回傳 undefined。 */
export function extractCommandFromInput(input: unknown): string | undefined {
  const obj = asRecord(input);
  if (!obj) return undefined;
  for (const key of COMMAND_KEYS) {
    const value = obj[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/** 從工具呼叫的 input 猜測「目標路徑」候選清單(檔案類)。猜不到回傳空陣列。 */
export function extractPathCandidates(input: unknown): string[] {
  const obj = asRecord(input);
  if (!obj) return [];
  const out: string[] = [];
  for (const key of PATH_KEYS) {
    const value = obj[key];
    if (typeof value === "string" && value.length > 0) out.push(value);
  }
  return out;
}

/** 從工具呼叫的 input 猜測「目標 host」(網路類)。猜不到回傳 undefined。 */
export function extractHostFromInput(input: unknown): string | undefined {
  const obj = asRecord(input);
  if (!obj) return undefined;
  for (const key of HOST_KEYS) {
    const value = obj[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  for (const key of URL_KEYS) {
    const value = obj[key];
    if (typeof value === "string" && value.length > 0) {
      try {
        return new URL(value).hostname;
      } catch {
        // 不是合法 URL,無法判斷 host——維持 undefined(呼叫端視為「猜不到」,
        // 不視為「已核可的 host」)。
      }
    }
  }
  return undefined;
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
