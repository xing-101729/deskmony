import { z } from "zod";

/**
 * S6(crash-recovery)復原視圖的資料形狀(見
 * docs/LAYER-4-detail-design/crash-recovery_detail.md §5.1)。
 *
 * 2026-10-02(P1:移除 team/task/看板,見 docs/DECISIONS.md §H):原本的
 * `task`/`workspace` 欄位(中斷 session 綁定的任務與 git worktree 狀態),以及
 * `recovery.gitStatus`/`recovery.resolveDirtyWorktree`/`recovery.rerun` 三個
 * 任務 worktree 專用的方法與其輸入/輸出型別已一併移除。復原視圖只剩 session
 * 對帳:interrupted → 繼續/接手/放棄。
 */

/** `recovery.list` 單筆項目。 */
export const RecoverySessionInfoSchema = z.object({
  sessionId: z.string(),
  sessionTitle: z.string(),
  /** 2026-10-02(P2:移除 profile):原本的 `profileName`,現在是 session 的 agent 顯示名
   *  (provider label;provider 已不在目錄裡時退回 session 存的 providerId)。 */
  agentLabel: z.string().optional(),
  status: z.literal("interrupted"),
  interruptedAt: z.number().optional(),
  lastSeenAt: z.number().optional(),
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
