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
   * UI 猜的**,見 crash-recovery_detail.md §4.1 表格。恆等於
   * `softwareCanResumeBackend(adapterType) && backendSessionId 存在`(2026-10-15 起不再限定
   * claude-agent-sdk:ACP 與 OpenCode 也會把後端 session id 存下來並嘗試接回,PTY 沒有後端 session 可接)。
   * 「繼續」是**盡力接回**:後端那邊的對話已經不在(agent 清掉了歷史、不支援 resume/load)時,會改用
   * Deskmony 存的對話紀錄接續,並在對話裡留一則系統訊息說明——所以這裡的 `true` 代表「有機會原生接回、
   * 且一定能繼續」,不是保證 agent 真的記得。UI 只顯示這裡回報為 `true` 的那個「繼續」按鈕,`false` 時
   * **整個按鈕不出現**(不是灰掉,見 §4.1「避免使用者以為是暫時性問題」)。
   */
  canContinue: z.boolean(),
});
export type RecoverySessionInfo = z.infer<typeof RecoverySessionInfoSchema>;

/**
 * 這個 software 的 session 有沒有後端持久化的對話可以接回?`claude-agent-sdk`(SDK 的 `resume`)、`acp`
 * (`session/resume` / `session/load`)與 `opencode`(opencode 把 session 存在磁碟,沿用同一個 session id)有;
 * PTY 是一個終端程序,沒有「後端 session」這個概念,重新啟動就是全新的程序。
 *
 * 兩處共用同一個答案:`RecoveryService` 的 `canContinue`,以及 `SessionManager` 重新啟動 session 時
 * 要不要帶 `ResumeOptions.backendSessionId` 給 adapter。
 */
export function softwareCanResumeBackend(software: string): boolean {
  return software === "claude-agent-sdk" || software === "acp" || software === "opencode";
}

export const RecoveryListResultSchema = z.object({ sessions: z.array(RecoverySessionInfoSchema) });
