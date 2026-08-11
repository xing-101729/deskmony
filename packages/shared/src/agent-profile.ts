import { z } from "zod";

/**
 * 支援的 agent 軟體種類(對應 ARCHITECTURE.md 3.4 節 Adapter Layer)。
 * M1 僅實作 claude-agent-sdk,其餘保留供 M2+ 使用。
 */
export const AgentSoftwareSchema = z.enum([
  "claude-agent-sdk",
  "acp",
  "opencode",
  "codex",
  "pty",
]);
export type AgentSoftware = z.infer<typeof AgentSoftwareSchema>;

/**
 * S7(auto-mode-and-yolo)L4 §1.1:**破壞性收窄**——移除 `auto-accept-all`。
 * YOLO(全繞過 config deny-list,見 auto-mode-and-yolo_detail.md §2)只能是
 * session 暫態(見下方 `SessionPermissionModeSchema`),**絕不可持久化**到
 * profile——否則 core 重啟後,一個原本只是「這次先不管我」的臨時決定,會在
 * 使用者毫無察覺的情況下變成永久生效的無人值守繞過,這正是 HLD §2 明講
 * 「YOLO 暫態、崩潰不復活」要防的事。
 *
 * 既有(收窄前)寫入過 `"auto-accept-all"` 的舊 DB 資料由
 * `packages/db/src/client.ts` 的遷移邏輯降級為 `"auto-accept-edits"`(見該檔案
 * `migrateAutoAcceptAllPermissionLevel()`,執行時 console.warn 列出被降級的
 * profile,不靜默)。
 */
export const PermissionLevelSchema = z.enum(["always-ask", "auto-accept-edits"]);
export type PermissionLevel = z.infer<typeof PermissionLevelSchema>;

/**
 * S7 L4 §1.1:session **暫態**可達的權限模式(含 YOLO)——只存在
 * `SessionManager` 記憶體(見 apps/core/src/session/session-manager.ts 的
 * `SessionPermissionState`),不落地 DB,也不是 `AgentProfile.permissionLevel`
 * 的合法值。一個 session 建立時的初值 = `profile.permissionLevel`(必為
 * `"always-ask"`/`"auto-accept-edits"` 之一),之後可透過
 * `session.setPermissionMode` gateway 方法(僅本機可呼叫,見
 * auto-mode-and-yolo_detail.md §5.1 的 `LOCAL_ONLY_METHODS`)提升到
 * `"auto-accept-all"`(YOLO),30 分鐘後惰性過期回落 `"always-ask"`。
 */
export const SessionPermissionModeSchema = z.enum(["always-ask", "auto-accept-edits", "auto-accept-all"]);
export type SessionPermissionMode = z.infer<typeof SessionPermissionModeSchema>;

/**
 * ACP(Agent Client Protocol)agent 的啟動方式(M2 Round A 新增)。
 * `AcpAdapter.spawn()` 會用這裡的 command/args/env 起一個子程序,經 stdio
 * 建立 ACP JSON-RPC 連線(見 packages/adapters/src/acp-adapter.ts)。
 */
export const AcpAgentConfigSchema = z.object({
  /** 子程序執行檔(可為 PATH 上的名稱,或絕對路徑) */
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  /** 會與 process.env 合併(此處設定的 key 優先) */
  env: z.record(z.string(), z.string()).optional(),
});
export type AcpAgentConfig = z.infer<typeof AcpAgentConfigSchema>;

/**
 * `software="pty"` 的 GenericPtyAdapter 啟動方式(M2 Round B 新增)。與
 * `AcpAgentConfigSchema` 同構(command/args/env),額外多了 `cols`/`rows`
 * 這兩個終端初始尺寸 —— pty 是「直通任意互動式 CLI 的終端」,沒有結構化的
 * session/update 協議可以告知 agent 終端大小,只能在 spawn 當下就決定
 * (未來若要支援 resize,需要另外擴充 AgentAdapter 介面,M2 Round B 範圍
 * 只做「固定尺寸 spawn」)。
 */
export const PtyAgentConfigSchema = z.object({
  /** 子程序執行檔(可為 PATH 上的名稱,或絕對路徑) */
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  /** 會與 process.env 合併(此處設定的 key 優先) */
  env: z.record(z.string(), z.string()).optional(),
  /** 終端欄數,預設 80(見 GenericPtyAdapter) */
  cols: z.number().int().positive().optional(),
  /** 終端行數,預設 24(見 GenericPtyAdapter) */
  rows: z.number().int().positive().optional(),
});
export type PtyAgentConfig = z.infer<typeof PtyAgentConfigSchema>;

/**
 * `software="opencode"` 的 OpenCodeAdapter 啟動方式(這輪新增,見
 * packages/adapters/src/opencode-adapter.ts 頂端對接策略註解)。
 *
 * `command` 是 `opencode` 執行檔(或 e2e 測試用的替身腳本)的完整路徑,由
 * `packages/shared/src/agent-target.ts` 的 `deriveDefaultAgentTarget()` 從
 * 偵測結果自動帶入,使用者不需要手動輸入(見 ProfileCreateDialog.tsx)。
 *
 * `args` **與 `AcpAgentConfigSchema`/`PtyAgentConfigSchema` 的語意不同**:
 * 那兩者的 `args` 是「附加在使用者指定 command 後面」的參數,原封不動傳給
 * `spawn()`;這裡的 `args`(若有提供且非空陣列)則是**完全取代**
 * `OpenCodeAdapter.spawn()` 原本會自動組出的 `["serve", "--port", "0",
 * "--hostname", "127.0.0.1"]` 這組固定參數 —— 因為真正對接 opencode 需要的
 * 是「用某個 port/host 啟動 headless server」這個特定子命令,不是任意透傳,
 * 一般情況下(`args` 省略)`OpenCodeAdapter` 會自己組出正確的 `serve` 參數,
 * 使用者/UI 完全不需要填這個欄位。這個逃生閥的唯一實際用途是
 * `scripts/fake-opencode-server.mjs`(e2e 決定性測試):它不是真的 opencode
 * 執行檔,不接受 `serve --port ...` 這組參數,而是直接被當成
 * `command=process.execPath, args=[fakeServerScriptPath]` 啟動,此時就需要
 * 完全取代預設參數,而不是附加在 `serve` 後面。
 */
export const OpencodeAgentConfigSchema = z.object({
  /** opencode 執行檔完整路徑(或 e2e 替身腳本的直譯器,見上方註解)。 */
  command: z.string().min(1),
  /** 見上方註解:提供時完全取代預設的 `serve` 參數,不是附加。 */
  args: z.array(z.string()).optional(),
  /** 會與 process.env 合併(此處設定的 key 優先) */
  env: z.record(z.string(), z.string()).optional(),
});
export type OpencodeAgentConfig = z.infer<typeof OpencodeAgentConfigSchema>;

/**
 * `software="acp"` 時必須提供 `acpConfig.command`,`software="pty"` 時必須
 * 提供 `ptyConfig.command`,其餘 software 不受影響。抽成獨立函式讓
 * `AgentProfileSchema` 與 `CreateAgentProfileInputSchema`(欄位集合不同,但都
 * 含 software/acpConfig/ptyConfig)可以共用同一條校驗規則。
 */
function refineAgentProfileConfig(
  value: {
    software: AgentSoftware;
    acpConfig?: AcpAgentConfig;
    ptyConfig?: PtyAgentConfig;
    opencodeConfig?: OpencodeAgentConfig;
  },
  ctx: z.RefinementCtx,
): void {
  if (value.software === "acp" && !value.acpConfig?.command) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'software="acp" 的 AgentProfile 必須提供 acpConfig.command',
      path: ["acpConfig", "command"],
    });
  }
  if (value.software === "pty" && !value.ptyConfig?.command) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'software="pty" 的 AgentProfile 必須提供 ptyConfig.command',
      path: ["ptyConfig", "command"],
    });
  }
  if (value.software === "opencode" && !value.opencodeConfig?.command) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'software="opencode" 的 AgentProfile 必須提供 opencodeConfig.command',
      path: ["opencodeConfig", "command"],
    });
  }
}

/**
 * AgentProfile:一個可被建立 session 的 agent 設定檔。
 * 對應 ARCHITECTURE.md 第 6 節 ERD 的 AGENT_PROFILE。
 *
 * 先以不含校驗規則的 ZodObject(`AgentProfileObjectSchema`)定義欄位,
 * 這樣 `CreateAgentProfileInputSchema` 才能對它呼叫 `.omit()`/`.partial()`
 * (`ZodEffects`— 也就是加了 `.superRefine()` 之後的型別 — 不支援這兩個
 * method);兩者各自在欄位集合底定後,才個別套用 `refineAcpConfig`。
 */
const AgentProfileObjectSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  role: z.string().default("Coder"),
  software: AgentSoftwareSchema,
  /**
   * 這輪新增(provider 目錄重構,見 packages/shared/src/provider-catalog.ts、
   * resolve-providers.ts):這個 profile 是從哪個 provider 目錄項目建立的
   * (`ProviderCatalogEntry.id`,例如 "claude-agent-sdk"、"gemini")。純粹是
   * 「這個 profile 的來源」這個中繼資訊——選填、不影響 `software`/
   * `*Config` 決定怎麼 spawn(那些欄位才是唯一權威來源),用途:
   *   1. UI(ChatView/ProfileCreateDialog)顯示「這個 session 屬於哪個
   *      provider」,以及「這個 provider 目前啟用哪些 model」時的查找 key。
   *   2. `SessionManager.createSession()` 依此查詢 provider 層級的預設 env
   *      (settings 的 per-provider 偏好,見 apps/core/src/settings/
   *      settings-store.ts 的 `getProviderEnv()`),與下方 `env` 合併
   *      (profile 自己的 env 優先覆寫 provider 層級預設)。
   * 沒有這個欄位的舊 profile(這輪之前建立的)一律視為「不屬於任何 provider
   * 目錄項目」,不會套用任何 provider 層級的預設 env——行為與這輪之前完全
   * 相同,不會因為這個新欄位而改變既有 profile 的 spawn 結果。
   */
  providerId: z.string().optional(),
  model: z.string().optional(),
  systemPrompt: z.string().optional(),
  mcpConfig: z.record(z.string(), z.unknown()).optional(),
  permissionLevel: PermissionLevelSchema.default("always-ask"),
  workingDir: z.string(),
  /**
   * 這輪新增:profile 層級的環境變數覆寫(對齊 Paseo「同一個 provider 建立
   * 多組不同憑證」的用法,例如兩個都用 claude-agent-sdk 的 profile 各自帶
   * 不同的 `ANTHROPIC_API_KEY`)。`SessionManager.createSession()` 會把這裡
   * 的值疊在 provider 層級預設 env 之上(見上方 `providerId` 註解),再傳給
   * adapter 的 `spawn()`——acp/pty/opencode 的 adapter 本身已經有
   * `*Config.env` 這個既有欄位,`profile.env` 是額外併入子程序環境的另一層
   * (見 packages/adapters 各 adapter 的 spawn() 實作),claude-agent-sdk 則是
   * 這輪才新增併入 SDK `Options.env` 的支援。
   *
   * 安全提醒(與 provider 層級 env 相同的取捨,見
   * apps/core/src/settings/settings-store.ts 頂端註解、README 對應章節):
   * 這裡可能含 API key,一律以明文存在本機 SQLite 的 agent_profiles 表,
   * gateway 透過 `profile.list`/`profile.create` 回傳完整 AgentProfile 時
   * **目前不遮罩**——這是刻意的取捨:profile 本來就是「使用者自己在這台機器
   * 建立、只給自己的 UI 讀」的資料,不像 provider 層級偏好那樣是「多個
   * client 都能查詢的共用設定」,遮罩需求的急迫性不同,見 README 說明。
   */
  env: z.record(z.string(), z.string()).optional(),
  /** software="acp" 時的子程序啟動設定,見 AcpAgentConfigSchema。 */
  acpConfig: AcpAgentConfigSchema.optional(),
  /** software="pty" 時的子程序啟動設定,見 PtyAgentConfigSchema。 */
  ptyConfig: PtyAgentConfigSchema.optional(),
  /** software="opencode" 時的子程序啟動設定,見 OpencodeAgentConfigSchema。 */
  opencodeConfig: OpencodeAgentConfigSchema.optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export const AgentProfileSchema = AgentProfileObjectSchema.superRefine(refineAgentProfileConfig);
export type AgentProfile = z.infer<typeof AgentProfileObjectSchema>;

export const CreateAgentProfileInputSchema = AgentProfileObjectSchema.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
})
  .partial({
    role: true,
    permissionLevel: true,
  })
  .superRefine(refineAgentProfileConfig);
export type CreateAgentProfileInput = z.infer<typeof CreateAgentProfileInputSchema>;
