import { z } from "zod";
import { TaskStatusSchema } from "./task.js";

/**
 * S6(crash-recovery)復原視圖的資料形狀(見
 * docs/LAYER-4-detail-design/crash-recovery_detail.md §5.1)。
 *
 * 單獨開一個檔案(而不是塞進 session.ts/task.ts)——這組型別橫跨 session/
 * task/workspace 三個既有領域,是「對帳結果」的組裝視圖,不屬於任何一個既有
 * 領域模型本身。
 */

/**
 * 一筆中斷 session 對應的任務資訊(找不到對應任務時,`recovery.list` 整個
 * `task` 欄位省略,見 RecoveryService 的組裝邏輯——不是每個 session 都綁定
 * 任務)。
 */
export const RecoveryTaskInfoSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: TaskStatusSchema,
});
export type RecoveryTaskInfo = z.infer<typeof RecoveryTaskInfoSchema>;

/**
 * 一筆中斷 session 對應的 workspace(worktree)資訊。`missing: true` 代表
 * worktree 已被外部刪除(§6 失敗模式表)——此時 `hadUncommittedChanges` 恆為
 * `false`(無法判斷,不可能判斷出「有」,保守回報「否」而不是編造)。
 */
export const RecoveryWorkspaceInfoSchema = z.object({
  workspaceId: z.string(),
  worktreePath: z.string(),
  branch: z.string(),
  missing: z.boolean(),
  hadUncommittedChanges: z.boolean(),
});
export type RecoveryWorkspaceInfo = z.infer<typeof RecoveryWorkspaceInfoSchema>;

/** `recovery.list` 單筆項目。 */
export const RecoverySessionInfoSchema = z.object({
  sessionId: z.string(),
  sessionTitle: z.string(),
  profileName: z.string().optional(),
  status: z.literal("interrupted"),
  interruptedAt: z.number().optional(),
  lastSeenAt: z.number().optional(),
  task: RecoveryTaskInfoSchema.optional(),
  workspace: RecoveryWorkspaceInfoSchema.optional(),
  /**
   * §4.1:這條 session 的後端是否支援「繼續(保有記憶)」——**查證結論,不是
   * UI 猜的**,見 crash-recovery_detail.md §4.1 表格。目前恆等於
   * `adapterType === "claude-agent-sdk" && backendSessionId 存在`。UI 只顯示
   * 這裡回報為 `true` 的那個「繼續」按鈕,`false` 時**整個按鈕不出現**(不是
   * 灰掉,見 §4.1「避免使用者以為是暫時性問題」)。
   */
  canContinue: z.boolean(),
});
export type RecoverySessionInfo = z.infer<typeof RecoverySessionInfoSchema>;

export const RecoveryListResultSchema = z.object({ sessions: z.array(RecoverySessionInfoSchema) });

/**
 * `recovery.gitStatus`:給復原視圖顯示 diff / `merging` 崩潰時「檢查 git
 * 狀態」用(§5.2/§5.3)。`target` 說明這次查的是 worktree 還是 baseDir——
 * `merging` 崩潰時查的是 `baseDir`(mergeWorkspace() 的 git merge 是在 baseDir
 * 執行的,不是 worktree,見 apps/core/src/workspace/workspace-manager.ts),
 * 其餘情況查 `worktreePath`。
 */
export const RecoveryGitStatusResultSchema = z.object({
  target: z.enum(["worktree", "baseDir"]),
  /** `git status --porcelain` 原始輸出。 */
  status: z.string(),
  /** `git diff` 原始輸出(只有 target === "worktree" 時才有意義地反映未 commit
   *  的變更;`merging` 情境下這欄位可能是空字串,UI 應優先看 `status`)。 */
  diff: z.string(),
});
export type RecoveryGitStatusResult = z.infer<typeof RecoveryGitStatusResultSchema>;

/** `recovery.resolveDirtyWorktree`:見 crash-recovery_detail.md §5.2「重跑前強制處理髒 worktree」。 */
export const RecoveryResolveDirtyWorktreeInputSchema = z.object({
  sessionId: z.string(),
  action: z.enum(["keep", "discard"]),
  /** `action === "discard"` 時必須明確為 `true`(二次確認),否則拒絕執行
   *  (`git reset --hard` + `git clean -fd` 會真的刪資料)。 */
  confirmDiscard: z.boolean().optional(),
});
export type RecoveryResolveDirtyWorktreeInput = z.infer<typeof RecoveryResolveDirtyWorktreeInputSchema>;

export const RecoveryResolveDirtyWorktreeResultSchema = z.object({
  ok: z.literal(true),
  action: z.enum(["keep", "discard"]),
  /** `action === "keep"` 時,實際建立的 wip 分支名稱。 */
  wipBranch: z.string().optional(),
});
export type RecoveryResolveDirtyWorktreeResult = z.infer<typeof RecoveryResolveDirtyWorktreeResultSchema>;
