import { z } from "zod";

/**
 * Task / Workspace(M4 Round A 新增)。
 * 對應 ARCHITECTURE.md 3.3 節 TaskService/WorkspaceManager、第 5 節「任務協作
 * 流程」狀態機、第 6 節 ERD(TASK/WORKSPACE)。
 *
 * 狀態機(對應 ARCHITECTURE.md 5 節的 mermaid stateDiagram,`apps/core/src/tasks/task-service.ts`
 * 的 `isValidTransition` 是唯一允許改變 `status` 的入口):
 *
 *   backlog → assigned          (指派給成員,觸發 WorkspaceManager 建立 worktree)
 *   assigned → in-progress
 *   in-progress → review
 *   review → in-progress        (退回)
 *   review → merging
 *   merging → done
 *   (backlog|assigned|in-progress|review|merging) → blocked
 *   blocked → <blockedFrom>     (回到進入 blocked 前的狀態,見下方 blockedFrom)
 *
 * `done`/自我迴圈以外沒有列出的組合一律視為非法跳轉,`TaskService.updateStatus()`
 * 會丟出明確錯誤(不做任意跳轉)。
 */
export const TaskStatusSchema = z.enum([
  "backlog",
  "assigned",
  "in-progress",
  "review",
  "merging",
  "done",
  "blocked",
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

/**
 * S4(機器驗收閘,切片:量測半、諮詢性)。對應
 * [S4 L4](../../../docs/LAYER-4-detail-design/acceptance-gate_detail.md) §1。
 * `undefined` = 這個任務沒有機器驗收條件(HLD A3 例外,退回人類判定)。
 *
 * **寫入路徑的完整性紀律(L4 §1)**:`acceptance` 只能由人透過 gateway 的
 * `task.create`/`task.setAcceptance` 設定——team-bus MCP 工具(見
 * packages/adapters/src/team-bus-mcp.ts 的 `send_message`/`broadcast`/
 * `list_teammates`/`report_status`/`request_review` 五個工具)完全沒有
 * 對應的寫入路徑,agent 無法自己塞一條 `"echo pass"` 來自我背書。
 */
export const TaskAcceptanceSchema = z.object({
  /** 依序執行,全部 exit 0 才算過。至少一條。 */
  commands: z.array(z.string().min(1)).min(1),
  /** 每條指令逾時(毫秒),預設見 apps/core/src/tasks/acceptance-runner.ts 的 DEFAULT_TIMEOUT_MS(10 分鐘)。 */
  timeoutMs: z.number().int().positive().optional(),
});
export type TaskAcceptance = z.infer<typeof TaskAcceptanceSchema>;

export const TaskSchema = z.object({
  id: z.string(),
  teamId: z.string(),
  title: z.string().min(1),
  description: z.string().optional(),
  status: TaskStatusSchema,
  /** 指派的 TeamMember.id;backlog 狀態下必為 undefined。 */
  assigneeMemberId: z.string().optional(),
  /** 指派後由 WorkspaceManager 建立的 Workspace.id(第 6 節 ERD「TASK ||--o| WORKSPACE」)。 */
  workspaceId: z.string().optional(),
  /** S4:機器驗收條件,見上方 `TaskAcceptanceSchema` 註解。 */
  acceptance: TaskAcceptanceSchema.optional(),
  /**
   * 只有 status === "blocked" 時有意義:記錄進入 blocked 前的狀態,供
   * "blocked → 回原狀態" 這個轉換使用。ARCHITECTURE.md 第 5 節狀態圖只畫了
   * `InProgress <-> Blocked`,這輪的任務描述把它放寬成「任意狀態都能進
   * blocked、也都要能回到原本那個狀態」,所以需要一個地方記住「原狀態」是
   * 什麼 —— 不能假設固定回到 in-progress。
   */
  blockedFrom: TaskStatusSchema.optional(),
  /**
   * S5(dispose-gate,見 ../../docs/LAYER-4-detail-design/dispose-gate-and-lead_detail.md
   * §1.2):agent 經 `report_status`/`request_review` 請求 `in-progress → review`、
   * 但此任務沒有 `acceptance`(或連續驗收失敗達上限)時,任務**維持**
   * `in-progress`、這個旗標設為 true,等待人類經 gateway 的
   * `task.approveReview` 核可才真正轉進 `review`——完成判定不能由 agent 自我
   * 背書(A3)。人類經 `task.updateStatus` 直接推進轉換**不受這個旗標影響**
   * (§1.1「只擋 agent 路徑」)。`.default(false)` 比照 `TeamMemberSchema.canInterrupt`
   * 的既有慣例。
   */
  awaitingHumanReview: z.boolean().default(false),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Task = z.infer<typeof TaskSchema>;

export const CreateTaskInputSchema = z.object({
  teamId: z.string(),
  title: z.string().min(1),
  description: z.string().optional(),
  /** S4:建立任務時可直接帶入機器驗收條件(人類設定,見 `TaskAcceptanceSchema` 註解)。 */
  acceptance: TaskAcceptanceSchema.optional(),
});
export type CreateTaskInput = z.infer<typeof CreateTaskInputSchema>;

export const AssignTaskInputSchema = z.object({
  taskId: z.string(),
  memberId: z.string(),
});
export type AssignTaskInput = z.infer<typeof AssignTaskInputSchema>;

export const UpdateTaskStatusInputSchema = z.object({
  taskId: z.string(),
  status: TaskStatusSchema,
});
export type UpdateTaskStatusInput = z.infer<typeof UpdateTaskStatusInputSchema>;

/**
 * S4:事後設定/清除一個既有任務的機器驗收條件。L4 §1 只寫「gateway 的
 * `task.create`/`task.update` 接受此欄位」,但這個 codebase 目前沒有通用的
 * `task.update` 方法(只有 `task.assign`/`task.updateStatus`/`task.merge`/
 * `task.delete` 各自窄範圍的方法)——這裡選擇新增一個一樣窄範圍、單一用途的
 * `task.setAcceptance`,而不是新開一個可以順便改 title/description 的通用
 * `task.update`(那會超出這輪任務的範圍,也不是 L4 明確定案的行為)。
 * `acceptance` 可省略以清除既有條件(退回人類判定)。
 */
export const SetTaskAcceptanceInputSchema = z.object({
  taskId: z.string(),
  acceptance: TaskAcceptanceSchema.optional(),
});
export type SetTaskAcceptanceInput = z.infer<typeof SetTaskAcceptanceInputSchema>;

/**
 * S4:`AcceptanceRunner.run()` 的執行結果(見
 * apps/core/src/tasks/acceptance-runner.ts)。放在 packages/shared 而不是
 * apps/core 本地 interface,理由同這個檔案其餘型別——需要經 WS Gateway
 * 序列化傳給 desktop UI,zod schema 當 single source of truth,兩邊不會漂移。
 */
export const AcceptanceCommandResultSchema = z.object({
  command: z.string(),
  /** null = 被 kill(逾時)。 */
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  durationMs: z.number(),
  /** 末段輸出(stdout+stderr 合併,末 8 KB,見 acceptance-runner.ts)。 */
  outputTail: z.string(),
});
export type AcceptanceCommandResult = z.infer<typeof AcceptanceCommandResultSchema>;

export const AcceptanceResultSchema = z.object({
  /** 全部 exit 0 且無逾時。 */
  passed: z.boolean(),
  perCommand: z.array(AcceptanceCommandResultSchema),
  startedAt: z.number(),
  finishedAt: z.number(),
  /** 未跑的原因(無 acceptance / worktree 遺失),passed 為 false 時可能有值。 */
  skippedReason: z.enum(["no-acceptance", "workspace-missing"]).optional(),
});
export type AcceptanceResult = z.infer<typeof AcceptanceResultSchema>;

/**
 * Workspace:一個任務綁定的 git worktree(ARCHITECTURE.md 3.3 節
 * WorkspaceManager、第 6 節 ERD)。`baseDir` 是 team 的 workingDir(必須是
 * git repo,見 WorkspaceManager 的檢查),`worktreePath`/`branch` 的佈局與
 * 命名規則見 `apps/core/src/workspace/workspace-manager.ts` 內的設計決策。
 */
export const WorkspaceSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  baseDir: z.string(),
  worktreePath: z.string(),
  branch: z.string(),
  createdAt: z.number(),
});
export type Workspace = z.infer<typeof WorkspaceSchema>;
