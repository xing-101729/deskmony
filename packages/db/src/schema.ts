import { sqliteTable, text, integer, real, primaryKey } from "drizzle-orm/sqlite-core";

/**
 * M1 資料表:sessions 與 messages(ARCHITECTURE.md 3.5 節、第 6 節 ERD 的 M1 子集)。
 *
 * 2026-10-02(P2:移除 profile,見 docs/DECISIONS.md §H):原本的 `agent_profiles` 表定義
 * 已移除。**這張表沒有被 DROP**——使用者既有 SQLite 檔案裡的表與資料原封不動留著,
 * 只有 `packages/db/src/client.ts` 的 `backfillLegacySessionsProvider()` 會用 raw SQL
 * 唯讀地讀它一次,把舊 session 補上自帶的 `provider_id`/`launch_*` 欄位。全新安裝不再建立它。
 *
 * 2026-10-02(P1:移除 team/task/看板,見 docs/DECISIONS.md §H):原本的 `teams`/
 * `team_members`/`team_messages`/`tasks`/`workspaces` 五張表定義已移除。**這些表
 * 沒有被 DROP**——使用者既有 SQLite 檔案裡的表與資料原封不動留著,只是不再有
 * 任何 drizzle 定義或程式碼讀寫它們(見 client.ts 檔頭說明)。
 */

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  title: text("title").notNull().default("新對話"),
  /**
   * 舊欄位(2026-10-02 P2 起不再是 profile id,原名 `agentProfileId`):`agent_profile_id` 在
   * 既有 DB 裡是 `NOT NULL`,SQLite 不能直接改約束,所以欄位保留——**新 session 寫入
   * `providerId` 當值**(只為滿足約束,沒有任何程式碼讀它);舊 session 這欄仍是當年的
   * profile id,僅供 `backfillLegacySessionsProvider()` 回填時對照。
   */
  legacyAgentProfileId: text("agent_profile_id").notNull(),
  /**
   * 2026-10-02(P2):這個 session 是用哪個 provider 目錄項目建立的(見
   * packages/shared/src/session.ts 的 `SessionSchema.providerId`)。nullable 只是為了讓
   * `ALTER TABLE ADD COLUMN` 補欄位時對舊列合法——啟動時的回填遷移之後一律非 NULL。
   * 既有 DB 靠 client.ts 的 `ensureSessionsLaunchColumns()` 冪等補欄位。
   */
  providerId: text("provider_id"),
  /**
   * 2026-10-02(P2):session 自帶的啟動資訊(`AgentLaunchSpec` 中 acp/pty/opencode 的
   * `command`/`args`;claude-agent-sdk 兩者皆 NULL,`launch_args` 是 JSON 字串陣列)。
   * 續接時先走 `AgentCatalog.buildLaunchSpec(providerId)`,provider 已不存在/未安裝時才
   * 退回 `adapterType + launch_command + launch_args`。**不存 env**(可能含 API key,
   * 每次 spawn 重新從 settings 讀)。
   */
  launchCommand: text("launch_command"),
  launchArgs: text("launch_args"),
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
  /**
   * async-scribbling-llama.md Phase 6:使用者訊息夾帶的圖片附件——
   * `PromptAttachment[]`(packages/shared/src/prompt.ts)序列化成的 JSON 字串,
   * 獨立欄位而非塞進 `content`(那欄位對 user 訊息就是純文字 prompt.text,
   * 混進附件需要內容嗅探才能分辨,獨立欄位零歧義)。Nullable——絕大多數訊息
   * (assistant/system/tool,以及沒有夾帶圖片的 user 訊息)這欄位是 NULL。
   * 既有的舊 DB 檔案靠 `packages/db/src/client.ts` 的
   * `ensureMessagesAttachmentsColumn()` 冪等 `ALTER TABLE` 補上。
   */
  attachments: text("attachments"),
  /**
   * 2026-10-02(P3:session 網路):這則 user 訊息是別的 session 送來的(`send_to_session`/`create_session`)
   * 或使用者從別的 session 轉傳來的——`MessageOrigin`(packages/shared/src/session.ts)序列化成的 JSON 字串。
   * `content` 存**原始 message 本體**,給 agent 看的信封樣板文字不落地(只在送進 adapter 那一刻組裝)。
   * Nullable——人類自己輸入的訊息與 assistant/system/tool 訊息都是 NULL。既有的舊 DB 檔案靠
   * `packages/db/src/client.ts` 的 `ensureMessagesOriginColumn()` 冪等 `ALTER TABLE` 補上。
   */
  origin: text("origin"),
  createdAt: integer("created_at").notNull(),
});

export type SessionRow = typeof sessions.$inferSelect;
export type NewSessionRow = typeof sessions.$inferInsert;
export type MessageRow = typeof messages.$inferSelect;
export type NewMessageRow = typeof messages.$inferInsert;

/**
 * settings(M5 Round E:「設定」介面的持久化 key/value store)。目前唯一的
 * 使用者是 apps/core/src/settings/settings-store.ts 的 `SettingsStore`
 * (啟用哪些偵測到的 Claude model,見該檔案 `ENABLED_CLAUDE_MODELS_KEY`),但
 * 刻意設計成通用的 `key TEXT PRIMARY KEY, value TEXT`(value 存 JSON 字串)
 * ——不是「一列存所有設定欄位」那種寬表,未來要新增其他偏好只需要多一個
 * key,不需要再一次 schema 遷移。比照 sessions 既有的
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
 * 也沒關係,單純圖查詢方便,不是 normalize 的資料庫設計)。
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
 * (只顯示最新值、reload 歸零),這裡補上治理所需的**權威持久層**——scope
 * (session/day;2026-10-02 起不再寫入 task scope,舊 DB 裡既有的 task 列留著不動)
 * 各自的累計花費/token,供每日
 * kill-switch(E3)門檻檢查與崩潰重啟後還原(見該文件 §6 失敗模式表)。
 *
 * 複合主鍵 `(scope, scopeId)`:`scope` 是 "session" | "day"
 * (`scopeId` 依序是 sessionId / 本地日期字串 "YYYY-MM-DD"),同一個
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
