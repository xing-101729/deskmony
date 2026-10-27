import fs from "node:fs";
import path from "node:path";
import { toolInputFieldValues } from "@deskmony/shared";

/**
 * tool-input.ts(S1:PolicyEngine + hard-deny 共用的工具呼叫輸入解析)。
 *
 * 指令/路徑候選的抽取(含 codex 的 `arguments` 外殼)在 packages/shared/src/tool-input.ts——桌面彈窗與 CLI 的
 * 「永遠允許」規則候選(shared 的 remember-rule.ts)也用同一份,UI 提議的規則才比對得到它自己的請求。這裡留下只有 core 需要的部分:host 候選(要用 `URL`
 * 解析,shared 的編譯設定不含 Node/DOM 型別)與 realpath/路徑邊界判斷(要用 `node:fs`)。猜不到一律回傳空陣列,
 * 呼叫端把「猜不到」導向「不 match」(見 shared 那份檔頭的說明)。
 */

/** 常見的「host/URL」欄位名稱(網路類工具)。 */
const HOST_KEYS = ["host", "hostname"];
const URL_KEYS = ["url", "uri", "endpoint"];

/** 從工具呼叫的 input 猜測「目標 host」候選清單(網路類),各層、各欄位都收。猜不到回傳空陣列。 */
export function extractHostCandidates(input: unknown): string[] {
  const out = toolInputFieldValues(input, HOST_KEYS);
  for (const value of toolInputFieldValues(input, URL_KEYS)) {
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
