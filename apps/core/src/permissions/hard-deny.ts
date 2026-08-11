import os from "node:os";
import path from "node:path";
import {
  extractCommandFromInput,
  extractHostFromInput,
  extractPathCandidates,
  isPathUnder,
  resolveRealpathBestEffort,
} from "./tool-input.js";

/**
 * hard-deny.ts(S1:內建、config 不可關閉的硬性 deny 類 — F4)。
 *
 * 對應 docs/LAYER-4-detail-design/policy-engine_detail.md §3。四類:
 *   1. worktree 外寫入/刪除
 *   2. 讀秘密路徑(~/.ssh、~/.aws、~/.deskmony、`**​/.env*`、`**​/id_rsa*`、`**​/credentials`)
 *   3. force-push / 危險 git
 *   4. 非白名單外連
 *
 * **判定失敗的方向**:任何「無法確定是否命中」的情況(路徑解析失敗、指令
 * 無法解析、猜不到 toolName 屬於哪一類)⇒ **不視為 hard-deny**(`matched:
 * false`),但呼叫端(policy-engine.ts 的 `decide()`)在這裡回傳 false 之後,
 * 仍然會依序比對 config 規則 → autoMode → 最終落到 `escalate`(default-deny)。
 * 也就是說「判定不出來」只代表**不會被這個函式擋下**,不代表會被放行——真正
 * 保證安全方向的是呼叫端的 default-deny 兜底,這個函式本身只需要對「猜得到」
 * 的情況做出正確判斷即可,不需要也不應該用臆測把它硬套進某一類(見下方各
 * 判定函式對「猜不到」的處理)。
 */

export type HardDenyCategory = "worktree-escape" | "secret-path" | "dangerous-git" | "non-allowlisted-network";

export interface HardDenyResult {
  matched: boolean;
  category?: HardDenyCategory;
  reason: string;
}

export interface HardDenyCheckInput {
  toolName: string;
  input: unknown;
  /** 這個 session 的 worktree 邊界——Phase 1 用 `Session.workingDir`(建立
   *  session 時傳給 adapter.spawn() 的 cwd)近似 HLD 說的
   *  `workspace.worktreePath`(見 policy-engine.ts 的 `PermissionRequest.workingDir`
   *  欄位註解:目前 codebase 的 session 不一定綁定 WorkspaceManager 建立的
   *  git worktree,`workingDir` 是唯一在 session 層級一定拿得到的邊界)。 */
  workingDir: string;
  /** `policy.allowedHosts`(見 core-config.ts),預設空 = 全擋。 */
  allowedHosts: string[];
}

/** 工具名裡含這些關鍵字(不分大小寫)才視為「會修改/刪除檔案系統」的操作——
 *  worktree-escape 只對這類工具的路徑做檢查,單純讀取(Read/Glob/Grep)不算,
 *  避免「讀取 worktree 外的檔案」被誤判成「worktree 外寫入/刪除」這個更嚴重
 *  的分類(讀取仍會受 §3 第 2 類「讀秘密路徑」與 default-deny 兜底,不是沒有
 *  防護,只是分類不同)。best-effort,見 ACP `toolName` 是人類標題的限制。 */
const MUTATING_TOOL_KEYWORDS = ["write", "edit", "delete", "remove", "mkdir", "move", "rename", "create"];

function isMutatingToolName(toolName: string): boolean {
  const lower = toolName.toLowerCase();
  return MUTATING_TOOL_KEYWORDS.some((kw) => lower.includes(kw));
}

/** ~/.ssh、~/.aws、~/.deskmony(整個目錄樹)+ `**​/.env*`、`**​/id_rsa*`、
 *  `**​/credentials`(任何深度)。 */
function isSecretPath(rawPath: string, baseDir: string): boolean {
  const resolved = resolveRealpathBestEffort(rawPath, baseDir);
  const home = os.homedir();

  for (const dirName of [".ssh", ".aws", ".deskmony"]) {
    const boundary = resolveRealpathBestEffort(path.join(home, dirName));
    if (isPathUnder(resolved, boundary)) return true;
  }

  const segments = resolved.split(/[\\/]+/).filter(Boolean);
  for (const seg of segments) {
    if (/^\.env/i.test(seg)) return true;
    if (/^id_rsa/i.test(seg)) return true;
    if (/^credentials$/i.test(seg)) return true;
  }
  return false;
}

/**
 * 危險 git 的指令 regex——刻意**不加 `^...$` 錨定**(與 policy-engine.ts 對
 * 使用者 allowlist 的 `commandMatches` 相反):hard-deny 要抓的是「即使藏在
 * 一長串 `cd /tmp && git push --force` 這種複合指令裡」也要命中,錨定完整
 * 匹配反而會讓攻擊者用一個無關前綴就繞過。這是刻意的不對稱設計——allowlist
 * 錨定是為了不誤放行,hard-deny 不錨定是為了不漏擋。
 */
const DANGEROUS_GIT_PATTERNS: { category: string; pattern: RegExp }[] = [
  { category: "force-push", pattern: /\bgit\s+push\b[^\n]*(--force\b|\s-f\b)/i },
  { category: "delete-remote-branch", pattern: /\bgit\s+push\b[^\n]*--delete\b/i },
  { category: "force-delete-branch", pattern: /\bgit\s+branch\b[^\n]*\s-D\b/i },
];

export function checkHardDeny(req: HardDenyCheckInput): HardDenyResult {
  // 1) worktree 外寫入/刪除——只檢查「猜得到路徑」且「猜得到是 mutating 工具」
  //    的情況,兩者缺一都視為猜不到(不 matched,落到 default-deny 兜底)。
  if (isMutatingToolName(req.toolName)) {
    const candidates = extractPathCandidates(req.input);
    if (candidates.length > 0) {
      const boundary = resolveRealpathBestEffort(req.workingDir);
      for (const rawPath of candidates) {
        const resolved = resolveRealpathBestEffort(rawPath, req.workingDir);
        if (!isPathUnder(resolved, boundary)) {
          return {
            matched: true,
            category: "worktree-escape",
            reason: `工具 ${req.toolName} 的目標路徑 "${rawPath}"(解析後 ${resolved})不在 worktree(${boundary})之下`,
          };
        }
      }
    }
  }

  // 2) 讀秘密路徑——不分讀寫,任何工具只要路徑猜得到都檢查。
  for (const rawPath of extractPathCandidates(req.input)) {
    if (isSecretPath(rawPath, req.workingDir)) {
      return {
        matched: true,
        category: "secret-path",
        reason: `工具 ${req.toolName} 的目標路徑 "${rawPath}" 命中秘密路徑規則(~/.ssh、~/.aws、~/.deskmony、.env*、id_rsa*、credentials)`,
      };
    }
  }

  // 3) force-push / 危險 git——只對猜得到「指令字串」的工具做 regex 掃描
  //    (見 policy-engine_detail.md §2「shell 的誠實限制」:這裡的 pattern 只
  //    擋明顯的意外,擋不住 `bash -c`/`$()`/base64 刻意繞過)。
  const command = extractCommandFromInput(req.input);
  if (command !== undefined) {
    for (const { category, pattern } of DANGEROUS_GIT_PATTERNS) {
      if (pattern.test(command)) {
        return {
          matched: true,
          category: "dangerous-git",
          reason: `指令 "${command}" 命中危險 git pattern(${category})`,
        };
      }
    }
  }

  // 4) 非白名單外連——只對猜得到 host 的工具檢查,allowedHosts 預設空 = 全擋。
  const host = extractHostFromInput(req.input);
  if (host !== undefined) {
    const allowed = req.allowedHosts.some((h) => h.toLowerCase() === host.toLowerCase());
    if (!allowed) {
      return {
        matched: true,
        category: "non-allowlisted-network",
        reason: `工具 ${req.toolName} 的目標 host "${host}" 不在 policy.allowedHosts 內`,
      };
    }
  }

  return { matched: false, reason: "未命中任何 hard-deny 規則(不代表放行,仍會落到 policy-engine 的 default-deny 兜底)" };
}
