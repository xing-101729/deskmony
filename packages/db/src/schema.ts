import { sqliteTable, text, integer, real, primaryKey } from "drizzle-orm/sqlite-core";

/**
 * M1 資料表:sessions 與 messages(ARCHITECTURE.md 3.5 節、第 6 節 ERD 的 M1 子集)。
 * M3 Round A:新增 agent_profiles(AgentProfile 落地成資料表,取代 M1 的
 * 純記憶體 ProfileStore)、teams / team_members / team_messages(TeamManager
 * + MessageBus,見 apps/core/src/team、apps/core/src/bus)。
 */

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  title: text("title").notNull().default("新對話"),
  agentProfileId: text("agent_profile_id").notNull(),
  adapterType: text("adapter_type").notNull(),
  status: text("status").notNull().default("idle"),
  workingDir: text("working_dir").notNull(),
  lastError: text("last_error"),
  /**
   * M5 Round C:session 級別的 model 覆寫(nullable —— 舊 session、或
   * acp/pty session 這個欄位可能是 NULL,見 packages/shared/src/session.ts
   * 的 `SessionSchema.model` 註解)。既有的舊 DB 檔案需要靠
   * `packages/db/src/client.ts` 的 `ensureSessionsModelColumn()` 冪等
   * `ALTER TABLE` 補上這個欄位(`CREATE TABLE IF NOT EXISTS` 對已存在的表
   * 不會補欄位)。
   */
  model: text("model"),
  /**
   * 比照上面的 `model` 欄位:session 級別的 effort(思考程度)覆寫(nullable,
   * 見 packages/shared/src/session.ts 的 `SessionSchema.effort` 註解)。既有的
   * 舊 DB 檔案靠 `packages/db/src/client.ts` 的 `ensureSessionsEffortColumn()`
   * 冪等 `ALTER TABLE` 補上。
   */
  effort: text("effort"),
  /**
   * S6(crash-recovery):對帳標記的時間 / 最後一次狀態變更時間 / 後端持久化
   * session 識別碼(見 packages/shared/src/session.ts 的 `SessionSchema`
   * 對應欄位註解)。既有的舊 DB 檔案靠 `packages/db/src/client.ts` 的
   * `ensureSessionsRecoveryColumns()` 冪等 `ALTER TABLE` 補上。
   */
  interruptedAt: integer("interrupted_at"),
  lastSeenAt: integer("last_seen_at"),
  backendSessionId: text("backend_session_id"),
  /**
   * S9(session-subagent):parent session id(nullable —— 根 session 無 parent,
   * 子 session 才有值)。既有的舊 DB 檔案靠 `packages/db/src/client.ts` 的
   * `ensureSessionsParentColumn()` 冪等 `ALTER TABLE` 補上這個欄位。
   */
  parentSessionId: text("parent_session_id"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  role: text("role").notNull(),
  content: text("content").notNull(),
  createdAt: integer("created_at").notNull(),
});

export type SessionRow = typeof sessions.$inferSelect;
export type NewSessionRow = typeof sessions.$inferInsert;
export type MessageRow = typeof messages.$inferSelect;
export type NewMessageRow = typeof messages.$inferInsert;

/**
 * agent_profiles(M3 Round A):AgentProfile 落地成資料表,取代 M1 的純記憶體
 * ProfileStore(README 已知限制:「profile 僅記憶體,core 重啟後消失」)。
 * mcpConfig/acpConfig/ptyConfig 是巢狀物件,以 JSON 字串存放(比照
 * drizzle-orm 對 SQLite 沒有原生 JSON 欄位型別時的常見作法)。
 */
export const agentProfiles = sqliteTable("agent_profiles", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  role: text("role").notNull().default("Coder"),
  software: text("software").notNull(),
  /** 這輪新增(provider 目錄重構):`ProviderCatalogEntry.id`,見
   *  packages/shared/src/agent-profile.ts 的 `AgentProfileObjectSchema.providerId`
   *  註解。既有的舊 DB 檔案靠 `packages/db/src/client.ts` 的
   *  `ensureAgentProfilesProviderColumnsColumn()` 冪等 `ALTER TABLE` 補上。 */
  providerId: text("provider_id"),
  model: text("model"),
  effort: text("effort"),
  systemPrompt: text("system_prompt"),
  mcpConfig: text("mcp_config"),
  permissionLevel: text("permission_level").notNull().default("always-ask"),
  workingDir: text("working_dir").notNull(),
  /** 這輪新增:profile 層級的 env 覆寫(JSON 字串),見
   *  packages/shared/src/agent-profile.ts 的 `AgentProfileObjectSchema.env` 註解。 */
  env: text("env"),
  acpConfig: text("acp_config"),
  ptyConfig: text("pty_config"),
  /** software="opencode" 時的子程序啟動設定(這輪新增,見 OpencodeAgentConfigSchema)。 */
  opencodeConfig: text("opencode_config"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
export type AgentProfileRow = typeof agentProfiles.$inferSelect;
export type NewAgentProfileRow = typeof agentProfiles.$inferInsert;

/** teams(M3 Round A):TeamManager,見 apps/core/src/team/team-manager.ts。 */
export const teams = sqliteTable("teams", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  workingDir: text("working_dir"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
export type TeamRow = typeof teams.$inferSelect;
export type NewTeamRow = typeof teams.$inferInsert;

/**
 * team_members(M3 Round A):引用 agent_profiles.id,name 在同一個 team 內
 * 唯一(MessageBus 用 name 比對 send_message 的 to / @mention)。
 */
export const teamMembers = sqliteTable("team_members", {
  id: text("id").primaryKey(),
  teamId: text("team_id").notNull(),
  agentProfileId: text("agent_profile_id").notNull(),
  name: text("name").notNull(),
  role: text("role").notNull(),
  canInterrupt: integer("can_interrupt").notNull().default(0),
  /** S8(agent-lifecycle):"persistent" | "ephemeral",見
   *  packages/shared/src/team.ts 的 `LifecycleSchema` 註解。既有的舊 DB 檔案
   *  靠 `packages/db/src/client.ts` 的 `ensureTeamMembersLifecycleColumn()`
   *  冪等 `ALTER TABLE` 補上,一律預設 `'ephemeral'`(遷移只改預設值,不改變
   *  正在跑的東西,見 agent-lifecycle_detail.md §1「遷移」)。 */
  lifecycle: text("lifecycle").notNull().default("ephemeral"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
export type TeamMemberRow = typeof teamMembers.$inferSelect;
export type NewTeamMemberRow = typeof teamMembers.$inferInsert;

/**
 * team_messages(M3 Round A):MessageBus 收到的每一則訊息(agent 互傳或人類
 * 插話)都會先落地在這裡,再依投遞策略決定要不要立即注入 / 進 Mailbox 排隊
 * (見 apps/core/src/bus/message-bus.ts,對應 ARCHITECTURE.md 4.2 節)。
 *
 * S2(message-budget)新增兩欄(見
 * docs/LAYER-4-detail-design/message-budget_detail.md §1):
 *   - `deliveredAt`:null = 尚未送達(即在 Mailbox 中,DB 是這個事實的**權威
 *     來源**,取代原本只在記憶體的 `Map<memberId, TeamMessage[]>`——崩潰重啟後
 *     `deliveredAt IS NULL` 的訊息自然還在,不需要額外復原邏輯)。既有的舊 DB
 *     檔案靠 `packages/db/src/client.ts` 的 `ensureTeamMessagesBudgetColumns()`
 *     冪等 `ALTER TABLE` 補上,並**只在這次遷移當下**把所有既有列標記為已送達
 *     (`deliveredAt = timestamp`)——絕不能是「每次啟動都執行」的無條件
 *     UPDATE,否則會把當時真正待投遞的訊息也一併誤標成已送達(見該函式註解)。
 *   - `contextId`:訊息所屬的 task context(agent 端一律由 Core 依 session 當下
 *     綁定的任務自動推導,agent 無法指定,見 message-bus.ts 的
 *     `deriveContextId()`)。舊資料(遷移當下已存在的列)填哨兵值 `"legacy"`,
 *     不參與訊息預算計算。
 */
export const teamMessages = sqliteTable("team_messages", {
  id: text("id").primaryKey(),
  teamId: text("team_id").notNull(),
  fromName: text("from_name").notNull(),
  fromRole: text("from_role"),
  toTarget: text("to_target").notNull(),
  content: text("content").notNull(),
  priority: text("priority").notNull(),
  timestamp: integer("timestamp").notNull(),
  source: text("source").notNull(),
  note: text("note"),
  /** S2:null = 尚未送達(Mailbox 中的權威狀態)。 */
  deliveredAt: integer("delivered_at"),
  /** S2:所屬任務 context id;"legacy" = 遷移前的舊資料,不參與預算計算。 */
  contextId: text("context_id").notNull().default("legacy"),
});
export type TeamMessageRow = typeof teamMessages.$inferSelect;
export type NewTeamMessageRow = typeof teamMessages.$inferInsert;

/**
 * tasks(M4 Round A):TaskService,見 apps/core/src/tasks/task-service.ts,對應
 * ARCHITECTURE.md 3.3 節 TaskService、第 5 節「任務協作流程」狀態機、第 6 節
 * ERD 的 TASK。欄位比 ERD 描述的最小集合(id/title/status/assigneeId)多兩個:
 *   - `workspace_id`:綁定的 WORKSPACE(第 6 節 ERD「TASK ||--o| WORKSPACE」)。
 *   - `blocked_from`:只有 status = "blocked" 時有意義,記錄進入 blocked 前的
 *     狀態,供 TaskService.isValidTransition 判斷「blocked → 回原狀態」這個
 *     ARCHITECTURE.md 第 5 節狀態圖沒有明講存放位置、但語意上必須有地方記錄
 *     的資訊(見 task-service.ts 內完整設計說明)。
 */
export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  teamId: text("team_id").notNull(),
  title: text("title").notNull(),
  description: text("description"),
  status: text("status").notNull().default("backlog"),
  assigneeMemberId: text("assignee_member_id"),
  workspaceId: text("workspace_id"),
  blockedFrom: text("blocked_from"),
  /**
   * S4(機器驗收閘):`TaskAcceptance` 的 JSON 字串,null = 無機器驗收(退回
   * 人類判定)。比照 agent_profiles 巢狀物件欄位的既有慣例(JSON 字串存放,
   * 見上方 agentProfiles 的 mcpConfig/acpConfig 等欄位註解)。既有 row 會是
   * NULL(見 client.ts 的 `ensureTasksAcceptanceColumn()` 遷移),無破壞性。
   */
  acceptance: text("acceptance"),
  /**
   * S5(dispose-gate):任務完成判定沒有機器驗收條件(或連續驗收失敗達上限)
   * 時,任務維持 `in-progress` 並設這個旗標,等待人類經 `task.approveReview`
   * 核可才轉進 `review`(見 apps/core/src/tasks/task-service.ts 的
   * `applyHumanReviewGate()`)。0/1 存 SQLite,比照 `team_members.can_interrupt`
   * 既有慣例(不用 `{ mode: "boolean" }`,讀寫端各自用 `Boolean()`/`? 1 : 0`
   * 轉換,見 team-manager.ts 的 rowToMember/memberToRow)。既有 row 會是 0
   * (見 client.ts 的 `ensureTasksAwaitingHumanReviewColumn()` 遷移),無破壞性。
   */
  awaitingHumanReview: integer("awaiting_human_review").notNull().default(0),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
export type TaskRow = typeof tasks.$inferSelect;
export type NewTaskRow = typeof tasks.$inferInsert;

/**
 * workspaces(M4 Round A):WorkspaceManager,見
 * apps/core/src/workspace/workspace-manager.ts。每一列對應一個任務綁定的
 * git worktree(baseDir = team.workingDir,worktreePath/branch 見
 * WorkspaceManager 內的佈局/命名設計決策)。
 */
export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull(),
  baseDir: text("base_dir").notNull(),
  worktreePath: text("worktree_path").notNull(),
  branch: text("branch").notNull(),
  createdAt: integer("created_at").notNull(),
});
export type WorkspaceRow = typeof workspaces.$inferSelect;
export type NewWorkspaceRow = typeof workspaces.$inferInsert;

/**
 * settings(M5 Round E:「設定」介面的持久化 key/value store)。目前唯一的
 * 使用者是 apps/core/src/settings/settings-store.ts 的 `SettingsStore`
 * (啟用哪些偵測到的 Claude model,見該檔案 `ENABLED_CLAUDE_MODELS_KEY`),但
 * 刻意設計成通用的 `key TEXT PRIMARY KEY, value TEXT`(value 存 JSON 字串)
 * ——不是「一列存所有設定欄位」那種寬表,未來要新增其他偏好只需要多一個
 * key,不需要再一次 schema 遷移。比照 sessions/agent_profiles 既有的
 * "CREATE TABLE IF NOT EXISTS" 自我修復策略(見 packages/db/src/client.ts),
 * 這是全新的表、不含需要對舊 DB 補欄位的既有資料,所以不需要
 * `ensureXxxColumn()` 那種 ALTER TABLE 遷移。
 */
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});
export type SettingsRow = typeof settings.$inferSelect;
export type NewSettingsRow = typeof settings.$inferInsert;

/**
 * enforcement_audit(S1:PolicyEngine + Enforcement 底座,見
 * docs/LAYER-4-detail-design/policy-engine_detail.md §5.1):append-only,只
 * INSERT、永不 UPDATE/DELETE——記錄所有權限決策/升級(之後 S2/S3b 的訊息/
 * 成本熔斷 trip 事件也會落在同一張表,見 `packages/shared/src/enforcement.ts`
 * 的 `EnforcementEvent` schema)。這是安全稽核的最低要求(DECISIONS.md D5),
 * 不因通知/UI 是否有人看而省略。
 *
 * 欄位設計:`sessionId`/`requestId`/`toolName`/`effect`/`reason` 是最常被查詢
 * 的欄位,獨立拉出來(nullable——`trip` 事件沒有 sessionId/requestId/toolName/
 * effect,只有 reason);`payload` 存完整事件的 JSON 字串(含上述欄位重複一份
 * 也沒關係,單純圖查詢方便,不是 normalize 的資料庫設計),比照
 * agent_profiles 的 mcpConfig 等既有慣例。
 */
export const enforcementAudit = sqliteTable("enforcement_audit", {
  id: text("id").primaryKey(),
  ts: integer("ts").notNull(),
  kind: text("kind").notNull(),
  sessionId: text("session_id"),
  requestId: text("request_id"),
  toolName: text("tool_name"),
  effect: text("effect"),
  reason: text("reason"),
  payload: text("payload"),
});
export type EnforcementAuditRow = typeof enforcementAudit.$inferSelect;
export type NewEnforcementAuditRow = typeof enforcementAudit.$inferInsert;

/**
 * usage_rollup(S3b:CostGovernor,見
 * docs/LAYER-4-detail-design/cost-governor_detail.md §1):S3a 是 ephemeral
 * (只顯示最新值、reload 歸零),這裡補上治理所需的**權威持久層**——三個
 * scope(session/task/day)各自的累計花費/token,供任務預算(E2)、每日
 * kill-switch(E3)門檻檢查與崩潰重啟後還原(見該文件 §6 失敗模式表)。
 *
 * 複合主鍵 `(scope, scopeId)`:`scope` 是 "session" | "task" | "day"
 * (`scopeId` 依序是 sessionId / taskId / 本地日期字串 "YYYY-MM-DD"),同一個
 * scope+scopeId 只會有一列,`CostGovernor` 用 select-then-update-or-insert
 * 的方式維護(見 apps/core/src/cost/cost-governor.ts),不是 append-only 事件
 * 記錄(這裡要的是「目前累計到多少」,不是「發生過哪些事件」,append-only 的
 * 稽核需求已經有 `enforcement_audit` 表)。
 *
 * `costCurrency` 允許 NULL——這個 scope 目前為止收到的 usage 事件可能從未帶過
 * `costAmount`(例如後端只給 token,見 `UsageEventSchema.costAmount` 的
 * optional 註解),此時 `costAmount` 維持 0、`costCurrency` 維持 NULL,不編造
 * 成 "USD"(不猜價)。全新的表,不含需要對舊 DB 補欄位的既有資料,不需要
 * `ensureXxxColumn()` 遷移(比照 `settings` 表的既有慣例,見上方註解)。
 */
export const usageRollup = sqliteTable(
  "usage_rollup",
  {
    scope: text("scope").notNull(),
    scopeId: text("scope_id").notNull(),
    costAmount: real("cost_amount").notNull().default(0),
    costCurrency: text("cost_currency"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.scope, table.scopeId] }),
  }),
);
export type UsageRollupRow = typeof usageRollup.$inferSelect;
export type NewUsageRollupRow = typeof usageRollup.$inferInsert;
