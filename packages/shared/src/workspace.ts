import { z } from "zod";

/**
 * 右側面板 Changes / Files 分頁的唯讀 workspace 查詢(2026-10-20,見 docs/LAYER-4-detail-design/side-panel_detail.md §P2、
 * docs/DECISIONS.md §L.1)。root = session 的工作資料夾(realpath);所有 `path` 參數都是**相對 root、以 `/` 分隔**的字串,
 * 空字串 = root 本身。路徑安全的規則與理由見 apps/core/src/workspace/workspace-paths.ts。
 *
 * 這個檔案不 import `node:*`(會被 apps/desktop 的瀏覽器 bundle 引入,同 terminal.ts)。
 */

/** `workspace.listDir` 單一資料夾最多回傳幾筆(超過的 `truncated: true`)。 */
export const WORKSPACE_LIST_MAX_ENTRIES = 2000;
/** `workspace.readFile` 文字內容上限(位元組,超過截斷並 `truncated: true`)。 */
export const WORKSPACE_READ_TEXT_MAX_BYTES = 1024 * 1024;
/** `workspace.readFile` 圖片上限(位元組,超過回 `tooLarge`)。 */
export const WORKSPACE_READ_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
/** 判斷「這是二進位檔」只看檔案開頭這麼多位元組有沒有 NUL。 */
export const WORKSPACE_BINARY_SNIFF_BYTES = 8 * 1024;
/** `workspace.gitStatus` 最多回傳幾個檔案(超過的 `truncated: true`)。 */
export const WORKSPACE_GIT_STATUS_MAX_FILES = 5000;
/** `workspace.gitDiff` 的 diff 文字上限(位元組,超過截斷並 `truncated: true`)。 */
export const WORKSPACE_GIT_DIFF_MAX_BYTES = 512 * 1024;

export const WorkspaceEntrySchema = z.object({
  name: z.string(),
  /** `symlink` 包含 Windows 的 junction;只標示、不跟進(`size`/`mtimeMs` 是連結本身的)。 */
  type: z.enum(["file", "dir", "symlink"]),
  size: z.number(),
  mtimeMs: z.number(),
});
export type WorkspaceEntry = z.infer<typeof WorkspaceEntrySchema>;

export const WorkspaceListDirResultSchema = z.object({
  /** 資料夾在前、名稱排序;隱藏 `.git`。 */
  entries: z.array(WorkspaceEntrySchema),
  truncated: z.boolean(),
});
export type WorkspaceListDirResult = z.infer<typeof WorkspaceListDirResultSchema>;

export const WorkspaceReadFileResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), content: z.string(), size: z.number(), truncated: z.boolean() }),
  z.object({ kind: z.literal("image"), mime: z.string(), dataBase64: z.string(), size: z.number() }),
  z.object({ kind: z.literal("binary"), size: z.number() }),
  z.object({ kind: z.literal("tooLarge"), size: z.number() }),
]);
export type WorkspaceReadFileResult = z.infer<typeof WorkspaceReadFileResultSchema>;

/**
 * `git status --porcelain=v1` 的 XY 狀態各一個字元(`index` = X、`worktree` = Y):` `(無)、`M`、`A`、`D`、`R`、`C`、`U`、
 * `?`(未追蹤,兩欄都是 `?`)、`!`。路徑相對於 session 的工作資料夾(工作資料夾是 repo 的子資料夾時已去掉前綴)。
 */
export const WorkspaceGitFileSchema = z.object({
  path: z.string(),
  /** rename/copy 的舊路徑。 */
  oldPath: z.string().optional(),
  index: z.string(),
  worktree: z.string(),
});
export type WorkspaceGitFile = z.infer<typeof WorkspaceGitFileSchema>;

export const WorkspaceGitStatusResultSchema = z.object({
  isRepo: z.boolean(),
  /** 分支名;detached HEAD 或不是 repo 時 `null`。 */
  branch: z.string().nullable(),
  files: z.array(WorkspaceGitFileSchema),
  truncated: z.boolean(),
});
export type WorkspaceGitStatusResult = z.infer<typeof WorkspaceGitStatusResultSchema>;

/** 與 desktop `views/chat/DiffHunkView.tsx` 的 `DiffHunk`(SDK `structuredPatch` 的形狀)相同,可以直接餵給它。 */
export const WorkspaceDiffHunkSchema = z.object({
  oldStart: z.number(),
  oldLines: z.number(),
  newStart: z.number(),
  newLines: z.number(),
  lines: z.array(z.string()),
});
export type WorkspaceDiffHunk = z.infer<typeof WorkspaceDiffHunkSchema>;

export const WorkspaceGitDiffResultSchema = z.object({
  hunks: z.array(WorkspaceDiffHunkSchema),
  /** 二進位檔(沒有文字 hunk 可顯示)。 */
  binary: z.boolean(),
  truncated: z.boolean(),
});
export type WorkspaceGitDiffResult = z.infer<typeof WorkspaceGitDiffResultSchema>;
