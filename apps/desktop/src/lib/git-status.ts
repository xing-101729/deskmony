/**
 * `git status --porcelain=v1` 的 XY 狀態 → Changes 分頁的徽章(2026-10-20,右側面板 P2)。**純函式、沒有任何 import**
 * (`scripts/e2e-side-panel-pure.mjs` 直接用 Node 載入這個 .ts 驗證)。
 */

export type GitStatusTone = "ok" | "info" | "danger" | "accent" | "warn";

export interface GitStatusBadge {
  /** 徽章上顯示的單一字元:`M`/`A`/`D`/`R`/`C`/`U`/`?`。 */
  letter: string;
  tone: GitStatusTone;
}

const TONE: Record<string, GitStatusTone> = { M: "info", A: "ok", "?": "ok", D: "danger", R: "accent", C: "accent", U: "warn", T: "info" };

/** 一個檔案的代表狀態:衝突(任一邊 `U`、或 `AA`/`DD`)> 未追蹤 > 工作樹有變就看工作樹 > 否則看已暫存的。 */
export function gitStatusBadge(index: string, worktree: string): GitStatusBadge {
  const conflicted = index === "U" || worktree === "U" || (index === "A" && worktree === "A") || (index === "D" && worktree === "D");
  const letter = conflicted ? "U" : index === "?" ? "?" : worktree.trim() ? worktree : index.trim() ? index : "M";
  return { letter, tone: TONE[letter] ?? "info" };
}

/** 工具提示用的原始 XY(`" M"` → `"·M"`,空白換成中點方便閱讀)。 */
export function gitStatusCode(index: string, worktree: string): string {
  const show = (c: string): string => (c.trim() ? c : "·");
  return `${show(index)}${show(worktree)}`;
}
