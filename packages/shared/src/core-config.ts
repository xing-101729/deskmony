import { z } from "zod";

/**
 * core-config.ts(M6 Round A 新增):把 core 目前散落在環境變數的設定改成
 * 「分層合併的設定檔」,設計移植自 Paseo 的全域設定(`~/.paseo/config.json`,
 * 合併順序 defaults → config.json → 環境變數 → CLI flags)—— Deskmony 沒有 CLI
 * flags,合併順序是 **defaults → config.json → 環境變數**,見
 * apps/core/src/config/load-config.ts 的完整合併邏輯與 README「全域設定」章節。
 *
 * 這裡只定義「形狀」(zod schema + 型別 + OS 無關的預設值)。這個檔案刻意
 * **不 import 任何 `node:*` 內建模組**——`packages/shared` 會被 `apps/desktop`
 * 的 Vite 瀏覽器 bundle 一併打包(見 `apps/desktop/src/stores/session-store.ts`
 * 對本套件其餘 export 的既有用法),若這裡引入 `node:os`/`node:path`,瀏覽器
 * build 會直接失敗。因此:
 *   - 與作業系統路徑無關的欄位(`daemon.*`、`log.level`、`version`)在這裡就有
 *     具體的靜態預設值(`PURE_DEFAULT_CORE_CONFIG`)。
 *   - 依賴 `os.homedir()`/monorepo 佈局的欄位(`workspace.defaultWorkingDir`、
 *     `data.dataDir`、`features.staticDir`)在這裡的型別是 `string | undefined`
 *     ——`undefined` 是合法的「尚未被檔案/環境變數覆寫,維持既有動態計算」
 *     狀態,實際計算落在 `apps/core/src/config/load-config.ts`(該檔案可以
 *     自由 import `node:os`/`node:path`,因為它只給 `apps/core` 這個 Node
 *     process 使用,不會被打進瀏覽器 bundle)。
 *
 * ---- 安全決定(review 會嚴查,務必維持,詳見 README「為何刻意不把 token
 * 放進設定檔」章節)----
 * `DESKMONY_AUTH_TOKEN` **不是**這份設定檔的欄位,也**永遠不會**是——Deskmony
 * 的認證是共享 bearer token 用 `timingSafeEqual` 比對(見
 * apps/core/src/gateway/ws-gateway.ts),不是 Paseo 那種存 bcrypt 雜湊再逐次
 * 比對雜湊的模型,存雜湊會改變比對模型本身,不是這輪要做的事。因此:
 *   - 這裡的 schema 完全沒有任何 `authToken`/`token` 欄位。
 *   - `apps/core/src/config/load-config.ts` 對設定檔內容做「已知欄位型別
 *     驗證」時,任何看起來像 token 的未知欄位(例如 `daemon.authToken`)一律
 *     被歸類為「未知欄位」,忽略且印出明確警告——絕不會被解析成任何有效值。
 */

// ---- log ------------------------------------------------------------------

/** 只做最小的「哪個等級以上才印」,不引入檔案輪替等新基礎設施(見上方檔案
 *  頂端說明)。`apps/core/src/config/load-config.ts` 的 `applyConsoleLogLevel()`
 *  依此覆寫 `console.log`/`console.warn` 成 no-op(`console.error` 永遠保留,
 *  確保致命錯誤一定看得到)。 */
export const LogLevelSchema = z.enum(["info", "warn", "error"]);
export type LogLevel = z.infer<typeof LogLevelSchema>;

// ---- daemon -----------------------------------------------------------------

export const AuthRateLimitConfigSchema = z
  .object({
    /** 對應 `DESKMONY_AUTH_RATE_LIMIT_MAX`(見 apps/core/src/gateway/ws-gateway.ts
     *  的 `AuthRateLimiter`)。 */
    max: z.number().int().positive(),
    /** 對應 `DESKMONY_AUTH_RATE_LIMIT_COOLDOWN_MS`。 */
    cooldownMs: z.number().int().positive(),
  })
  .strict();
export type AuthRateLimitConfig = z.infer<typeof AuthRateLimitConfigSchema>;

export const DaemonConfigSchema = z
  .object({
    /** 對應 `DESKMONY_CORE_PORT`。 */
    port: z.number().int().positive(),
    /** 對應 `DESKMONY_BIND_HOST`。**安全關鍵**:`validateBindSafety()` 必須看
     *  這個「合併後」的值,不能只看環境變數(見 README「綁定安全檢查用合併後
     *  的值」章節)——這是這輪新增設定檔後,防止「使用者改設定檔就意外把
     *  無認證的 core 曝露到區網」的關鍵防線。 */
    bindHost: z.string().min(1),
    /** 對應 `DESKMONY_PERMISSION_TIMEOUT_MS`。 */
    permissionTimeoutMs: z.number().int().positive(),
    authRateLimit: AuthRateLimitConfigSchema,
  })
  .strict();
export type DaemonConfig = z.infer<typeof DaemonConfigSchema>;

// ---- workspace --------------------------------------------------------------

export const WorkspaceConfigSchema = z
  .object({
    /**
     * 對應 `DESKMONY_WORKSPACE`。這個欄位在「合併後」的 `CoreConfig`/
     * `EffectiveCoreConfig` 一定有值(`load-config.ts` 的 `loadConfig()` 保證
     * ——沒設定檔/沒環境變數時退回 `os.homedir()`,對應既有行為),因此這裡是
     * **必填**(不是 `.optional()`)——`config.json` 檔案本身允許省略這個欄位
     * (見下方 `CoreConfigFileSchema = CoreConfigSchema.deepPartial()`,那裡會
     * 讓每一層欄位都變成 optional,包含這個),兩者並不衝突。
     */
    defaultWorkingDir: z.string().min(1),
    /**
     * 這輪新增:`WorkspaceManager` 原本把任務 worktree 寫死在
     * `dirname(baseDir)/.deskmony-worktrees`(見 apps/core/src/workspace/
     * workspace-manager.ts 頂端註解)。省略 = **維持既有這個動態算法**(不是
     * 「沒有 worktree root」),提供時整批取代成固定目錄(所有 team 的 baseDir
     * 都共用同一個 worktree root)。沒有對應的環境變數(這輪只開放設定檔/
     * gateway `config.setFile` 可覆寫,見 README)。
     */
    worktreesRoot: z.string().min(1).optional(),
  })
  .strict();
export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>;

// ---- data ---------------------------------------------------------------

export const DataConfigSchema = z
  .object({
    /** 對應 `DESKMONY_DATA_DIR`。與 `workspace.defaultWorkingDir` 同理,合併後
     *  一定有值(退回 `~/.deskmony`),這裡是必填;`config.json` 本身仍可省略
     *  (見下方 `CoreConfigFileSchema`)。 */
    dataDir: z.string().min(1),
  })
  .strict();
export type DataConfig = z.infer<typeof DataConfigSchema>;

// ---- features -----------------------------------------------------------

export const FeaturesConfigSchema = z
  .object({
    /** 對應 `DESKMONY_STATIC_DIR`。省略 = 維持既有依 monorepo 佈局推算的預設值。 */
    staticDir: z.string().min(1).optional(),
  })
  .strict();
export type FeaturesConfig = z.infer<typeof FeaturesConfigSchema>;

// ---- log ------------------------------------------------------------------

export const LogConfigSchema = z
  .object({
    level: LogLevelSchema,
  })
  .strict();
export type LogConfig = z.infer<typeof LogConfigSchema>;

// ---- policy(S1:PolicyEngine,見 docs/LAYER-4-detail-design/policy-engine_detail.md)----

/**
 * 政策規則的細化條件——全部滿足(AND)才算這條規則 match(見
 * apps/core/src/permissions/policy-engine.ts 的 `decide()`)。
 */
export const PolicyRuleWhenSchema = z
  .object({
    /** Bash 類:對指令字串做完整比對(trim 後),非部分比對——這是「永遠允許」
     *  UI 動作預設寫入的最窄形式。 */
    commandEquals: z.string().optional(),
    /** Bash 類:正規表達式,PolicyEngine 比對時**自動包 `^...$` 強制完整匹配**
     *  ——避免 `npm test` 這種 pattern 意外放行 `npm test; rm -rf /`。 */
    commandMatches: z.string().optional(),
    /** 檔案類:路徑必須位於此前綴之下,兩邊都會 realpath 解析符號連結後再比對
     *  (防 symlink 逃逸),並以路徑分隔符為界。 */
    pathUnder: z.string().optional(),
  })
  .strict();
export type PolicyRuleWhen = z.infer<typeof PolicyRuleWhenSchema>;

/** 限定某個 agent profile / role 才適用這條規則(Phase 1 不做繼承,只做精確比對)。 */
export const PolicyRuleScopeSchema = z
  .object({
    profileId: z.string().optional(),
    role: z.string().optional(),
  })
  .strict();
export type PolicyRuleScope = z.infer<typeof PolicyRuleScopeSchema>;

export const PolicyRuleSchema = z
  .object({
    /**
     * 2026-08-25 新增(見 docs/DECISIONS.md §G):穩定識別碼,供
     * `policy.removeRule` 精確定位單一規則(陣列 index 會因為其他規則新增/
     * 刪除而位移,不能拿來當長期參照)。舊規則(這個欄位新增前就已寫入
     * config.json 的)沒有這個值——Core 啟動時由
     * `config-file-writer.ts` 的 `backfillPolicyRuleIds()` 補上並整批寫回,
     * 之後就恆有值,這裡維持 optional 只是為了讓「檔案裡剛好還沒補過」這個
     * 短暫狀態型別上合法,不代表這個欄位長期允許缺席。
     */
    id: z.string().optional(),
    /** 工具名;`"*"` 表示任意工具。 */
    tool: z.string(),
    when: PolicyRuleWhenSchema.optional(),
    effect: z.enum(["allow", "deny"]),
    scope: PolicyRuleScopeSchema.optional(),
    /** UI「永遠允許」寫入時記錄來源,供稽核。 */
    addedBy: z.enum(["user", "ui-remember"]).optional(),
    addedAt: z.number().optional(),
  })
  .strict();
export type PolicyRule = z.infer<typeof PolicyRuleSchema>;

/**
 * 2026-08-25 新增:`policy.addRule` 的輸入形狀——**刻意不是** `PolicyRuleSchema`
 * 本身,拿掉 `id`/`addedBy`/`addedAt` 三個欄位,server 端一律自己生成/填入
 * (見 apps/core/src/session/session-manager.ts 的 `addPolicyRule()`),不信任
 * 呼叫端送來的值——`id` 若讓 client 自訂可能與既有規則衝突,`addedBy`/`addedAt`
 * 若讓 client 自訂就失去稽核意義(client 可以偽稱是很久以前加的、或偽稱是
 * `"user"` 手動加的)。
 */
export const PolicyAddRuleInputSchema = PolicyRuleSchema.omit({ id: true, addedBy: true, addedAt: true });
export type PolicyAddRuleInput = z.infer<typeof PolicyAddRuleInputSchema>;

export const PolicyConfigSchema = z
  .object({
    /** 依序比對,第一個 match 決定結果;寫入時 deny 規則一律 unshift 到陣列
     *  前端,確保先於 allow 比對(見 policy-engine_detail.md §2)。 */
    rules: z.array(PolicyRuleSchema).default([]),
    /**
     * hard-deny「非白名單外連」類使用(見 apps/core/src/permissions/
     * hard-deny.ts):網路類工具的目標 host 必須在此清單內,預設空陣列 = 全擋。
     * 這個欄位與 `rules` 一樣屬於安全罩本身的設定,遠端不可修改(F4,見下方
     * `ConfigSetFilePatchSchema` 不含 `policy` 的說明)。
     */
    allowedHosts: z.array(z.string()).default([]),
  })
  .strict();
export type PolicyConfig = z.infer<typeof PolicyConfigSchema>;

// ---- notification(S11:Notification,見 docs/LAYER-4-detail-design/notification_detail.md)----

/** §2.1:桌面系統通知(經 WS push 給 renderer,由 Electron 主行程觸發原生
 *  `Notification`)。headless core(無 Electron client 連線)時這個開關本身
 *  沒有效果(沒有 client 可以收 push),不需要另外判斷——見 RealNotifier。 */
export const NotificationDesktopConfigSchema = z.object({ enabled: z.boolean() }).strict();
export type NotificationDesktopConfig = z.infer<typeof NotificationDesktopConfigSchema>;

/**
 * §2.2/§5:webhook 通道。`url` **視同憑證**——`config.getEffective` 回傳給
 * client 前必須遮罩(見 apps/core/src/gateway/ws-gateway.ts 的
 * `maskEffectiveConfigForClient()`),且**不得**出現在 `ConfigSetFilePatchSchema`
 * 安全子集內(見下方該 schema 的說明,F4,與 `policy` 同等對待)。
 * `minSeverity`:"escalate" = escalate 與 trip 都送 webhook;"trip" = 只有
 * trip 才送 webhook(escalate 只留桌面通知)。**只影響 webhook 通道**——
 * `desktop.enabled` 是獨立開關,不受這個欄位限制(trip/escalate 只要
 * `desktop.enabled` 為真就都會嘗試推播桌面通知)。
 */
export const NotificationWebhookConfigSchema = z
  .object({
    /** 空字串 = 未設定(不送 webhook,即使 enabled=true)。 */
    url: z.string().default(""),
    enabled: z.boolean().default(false),
    minSeverity: z.enum(["escalate", "trip"]).default("escalate"),
  })
  .strict();
export type NotificationWebhookConfig = z.infer<typeof NotificationWebhookConfigSchema>;

/** §3:靜音時段,24h 制 "HH:mm"。只壓 escalate,不壓 trip(見 RealNotifier)。
 *  允許跨午夜(`from > to`,例如 23:00→07:00),由 RealNotifier 的
 *  `isWithinQuietHours()` 正確處理跨日判斷。 */
export const NotificationQuietHoursConfigSchema = z.object({ from: z.string(), to: z.string() }).strict();
export type NotificationQuietHoursConfig = z.infer<typeof NotificationQuietHoursConfigSchema>;

export const NotificationConfigSchema = z
  .object({
    desktop: NotificationDesktopConfigSchema.default({ enabled: true }),
    webhook: NotificationWebhookConfigSchema.default({ url: "", enabled: false, minSeverity: "escalate" }),
    /** escalate 的批次彙總間隔(分鐘)。trip 不受此限,必送不節流(見
     *  notification_detail.md §3)。 */
    batchIntervalMinutes: z.number().int().positive().default(20),
    quietHours: NotificationQuietHoursConfigSchema.optional(),
  })
  .strict();
export type NotificationConfig = z.infer<typeof NotificationConfigSchema>;

// ---- budget(S3b:CostGovernor,見 docs/LAYER-4-detail-design/cost-governor_detail.md)----

/**
 * 任務層級預算(HLD E2)。**兩個欄位都選填**——`undefined` = 這一層沒有上限
 * (只有 `warnAtPercent` 之外完全不擋)。這是這輪的自行判斷(L4 沒有給出具體
 * 數字預設值,只說「保守預設、要開大得有意識地開」,見 cost-governor_hld.md
 * §3):比照 `回合硬上限`(§3 明訂寬鬆預設,理由是「太緊會打斷合法工作,失去
 * 信任就會直接關掉」)的同一個哲學——**沒有根據地發明一個任意的低額美金數字
 * 當預設值**,一來會讓幾乎所有使用者一開機就被卡住(對「保守」的字面理解是
 * 「限制」,但沒有根據的限制本身就是一種謊言,見 core-config.ts 對 `不猜價`
 * 的一貫要求),二來這個數字本身就是「猜測」——與 `不猜價` 的紀律矛盾。真正
 * 不依賴 usage 的兜底是 `turn`(下方,永遠寬鬆啟用),任務/每日預算保持
 * `undefined`(不啟用)直到使用者明確設定,才是誠實的保守(不假裝有保護)。
 */
export const BudgetTaskConfigSchema = z
  .object({
    maxCostUsd: z.number().positive().optional(),
    maxTokens: z.number().int().positive().optional(),
  })
  .strict();
export type BudgetTaskConfig = z.infer<typeof BudgetTaskConfigSchema>;

/** 每日/全域 kill-switch(HLD E3)。語意與 `BudgetTaskConfigSchema` 相同,見其註解。 */
export const BudgetDailyConfigSchema = z
  .object({
    maxCostUsd: z.number().positive().optional(),
    maxTokens: z.number().int().positive().optional(),
  })
  .strict();
export type BudgetDailyConfig = z.infer<typeof BudgetDailyConfigSchema>;

/**
 * 回合硬上限(HLD §3.1(C)、L4 §0.1/§3)——**不依賴 usage**,是「Claude Code 經
 * ACP」這類完全拿不到用量資料的後端**唯一**的保護,優先序最高。**必填**且
 * 預設寬鬆(30 分鐘 / 200 次工具呼叫,見 `PURE_DEFAULT_CORE_CONFIG.budget`)
 * ——這是防失控,不是防正常長任務,太緊會打斷合法工作。
 */
export const BudgetTurnConfigSchema = z
  .object({
    maxDurationMs: z.number().int().positive(),
    maxToolCalls: z.number().int().positive(),
  })
  .strict();
export type BudgetTurnConfig = z.infer<typeof BudgetTurnConfigSchema>;

/**
 * 單一 model 的定價覆寫(HLD §3.2「雙軌」的 token→$ 換算表)。**刻意沒有內建
 * 任何預設定價**(見下方 `PURE_DEFAULT_CORE_CONFIG.budget.modelPricing` 的
 * `{}`)——這輪沒有可靠管道驗證 Anthropic/其他供應商目前的真實定價,寫死一份
 * 可能過時或錯誤的價格表,比完全沒有這個功能更危險(使用者會相信一個錯的
 * 金額),違反「不猜價」的紀律(見 cost-governor_detail.md §6 失敗模式表)。
 * 只有使用者透過這裡明確覆寫的 model 才會被換算成 $;查無定價的 model 一律
 * 退回 `budget.task/daily.maxTokens` 的 token 上限(雙軌設計本身保證「永遠有
 * 一條線」,見 HLD §3.2)。
 */
export const BudgetModelPricingSchema = z
  .object({
    inputPerMTokUsd: z.number().nonnegative(),
    outputPerMTokUsd: z.number().nonnegative(),
  })
  .strict();
export type BudgetModelPricing = z.infer<typeof BudgetModelPricingSchema>;

export const BudgetConfigSchema = z
  .object({
    task: BudgetTaskConfigSchema.default({}),
    daily: BudgetDailyConfigSchema.default({}),
    turn: BudgetTurnConfigSchema,
    /** 軟警告門檻(百分比,0-100)。達到後只發通知,不 halt。 */
    warnAtPercent: z.number().min(0).max(100),
    modelPricing: z.record(z.string(), BudgetModelPricingSchema).default({}),
  })
  .strict();
export type BudgetConfig = z.infer<typeof BudgetConfigSchema>;

// ---- messageBudget(S2:訊息預算 + Mailbox 持久化,第三條斷路器,見
// docs/LAYER-4-detail-design/message-budget_detail.md §3)----

/**
 * 每個 task context 的訊息數上限(A5 後半、message-budget_detail.md §3)——
 * Phase 2 唯一主防線,hop 深度 / A↔B 頻率 / broadcast 冷卻全部延後(理由見該
 * 文件 §3.1:訊息數是所有失控形態的共同表徵,簡單、無法繞過、一定會斷)。
 *
 * **與 `budget`(CostGovernor)同等對待**:agent 不可寫(家目錄在 worktree
 * 外)、遠端不可改(見下方 `ConfigSetFilePatchSchema` 刻意不含這個欄位的說明,
 * F4)——這是安全罩本身的設定,不是使用者體驗偏好。
 *
 * `maxMessagesPerContext` 預設 50:一個任務的正常協作往返(交辦/澄清/review
 * 意見/修正回報)量級在 10–20 則,50 給 2–3 倍餘裕,又能在失控迴圈跑掉前斷掉
 * (見該文件 §3「預設值 50 的理由」)。`warnAtPercent` 比照 `BudgetConfigSchema`
 * 同名欄位的形狀(L4 §3 的 config 區塊明訂這個欄位),但這輪**沒有**對應的軟
 * 警告通知實作(`EnforcementEvent` 的 `reminder` kind 目前 `source` 只收斂
 * `"cost"`,見 packages/shared/src/enforcement.ts——擴充它需要新的、這輪 L4
 * 文字完全沒描述行為的設計決定,保守起見這輪只落地欄位本身,不擅自發明行為,
 * 見最終報告「自行判斷」章節)。
 */
export const MessageBudgetConfigSchema = z
  .object({
    maxMessagesPerContext: z.number().int().positive().default(50),
    warnAtPercent: z.number().default(80),
  })
  .strict();
export type MessageBudgetConfig = z.infer<typeof MessageBudgetConfigSchema>;

// ---- 頂層 CoreConfig ----------------------------------------------------

/** 目前唯一存在的設定檔格式版本。這個專案還沒有跨版本遷移的需求,先固定 1,
 *  未來若格式變動再擴充遷移邏輯。接受數字 `1` 或字串 `"1"` 兩種寫法(使用者
 *  手寫 JSON 時兩種都很常見,不強制哪一種)。 */
export const CORE_CONFIG_VERSION = 1 as const;
export const CoreConfigVersionSchema = z.union([z.literal(1), z.literal("1")]);

export const CoreConfigSchema = z
  .object({
    /** 可選,讓編輯器用 `$schema` 指到 `docs/deskmony.config.v1.json` 取得
     *  自動補全(見 README「JSON schema」章節)。純粹給編輯器用,不參與任何
     *  驗證邏輯,也不影響合併結果。 */
    $schema: z.string().optional(),
    version: CoreConfigVersionSchema,
    daemon: DaemonConfigSchema,
    workspace: WorkspaceConfigSchema,
    data: DataConfigSchema,
    features: FeaturesConfigSchema,
    log: LogConfigSchema,
    /**
     * S1(PolicyEngine)新增:default-deny 政策規則,存 `~/.deskmony/config.json`
     * ——**agent 不可寫**(家目錄在 worktree 外)、**遠端不可改**(見下方
     * `ConfigSetFilePatchSchema` 刻意不含這個欄位的說明,與 `daemon.port`/
     * `bindHost` 同等對待,F4)。`.default({ rules: [], allowedHosts: [] })`
     * 讓沒有這個區塊的舊設定檔/全新安裝行為等同「空政策」(全部 escalate,
     * fail-safe,見 policy-engine_detail.md §6 失敗模式)。
     */
    policy: PolicyConfigSchema.default({ rules: [], allowedHosts: [] }),
    /**
     * S11(Notification)新增:升級/熔斷的帶外送達設定,存
     * `~/.deskmony/config.json`——**agent 不可寫**(家目錄在 worktree 外,同
     * `policy` 紀律)、**遠端不可改**(見下方 `ConfigSetFilePatchSchema` 刻意
     * 不含這個欄位的說明,F4:webhook url 是「能對外送資料」的能力,遠端可改
     * 等同允許把資料導向任意端點)。`.default(...)` 讓沒有這個區塊的舊設定檔/
     * 全新安裝行為等同「桌面通知開、webhook 關」。
     */
    notification: NotificationConfigSchema.default({
      desktop: { enabled: true },
      webhook: { url: "", enabled: false, minSeverity: "escalate" },
      batchIntervalMinutes: 20,
    }),
    /**
     * S3b(CostGovernor)新增:成本治理三層上限(見
     * docs/LAYER-4-detail-design/cost-governor_detail.md §2)。**agent 不可寫**
     * (家目錄在 worktree 外)、**遠端不可改**(見下方 `ConfigSetFilePatchSchema`
     * 刻意不含這個欄位的說明,與 `policy`/`notification` 同等對待,F4)。
     * `.default(...)` 讓沒有這個區塊的舊設定檔/全新安裝行為等同「只有回合
     * 硬上限生效(30分/200次工具呼叫),任務/每日預算不啟用」。
     */
    budget: BudgetConfigSchema.default({
      task: {},
      daily: {},
      turn: { maxDurationMs: 30 * 60_000, maxToolCalls: 200 },
      warnAtPercent: 80,
      modelPricing: {},
    }),
    /**
     * S2(message-budget)新增:訊息預算上限(見
     * docs/LAYER-4-detail-design/message-budget_detail.md §3)。**agent 不可寫**
     * (家目錄在 worktree 外)、**遠端不可改**(見下方 `ConfigSetFilePatchSchema`
     * 刻意不含這個欄位的說明,與 `policy`/`notification`/`budget` 同等對待,
     * F4)。`.default(...)` 讓沒有這個區塊的舊設定檔/全新安裝行為等同
     * `maxMessagesPerContext=50`。
     */
    messageBudget: MessageBudgetConfigSchema.default({ maxMessagesPerContext: 50, warnAtPercent: 80 }),
  })
  .strict();
export type CoreConfig = z.infer<typeof CoreConfigSchema>;

/**
 * 與作業系統路徑無關欄位的靜態預設值(見上方檔案頂端說明)——
 * `apps/core/src/config/load-config.ts` 的 `computeDefaultCoreConfig()` 以此為
 * 基礎,再補上 `workspace.defaultWorkingDir`/`data.dataDir`/
 * `features.staticDir` 這三個依賴 `os.homedir()`/monorepo 佈局的預設值。
 * 這些數字必須與 apps/core 目前的既有行為完全一致(見 apps/core/src/index.ts
 * 舊版直接讀 env 的預設值、apps/core/src/permissions/permission-gateway.ts 的
 * `DEFAULT_TIMEOUT_MS`、apps/core/src/gateway/ws-gateway.ts 的
 * `DEFAULT_AUTH_FAILURE_LIMIT`/`DEFAULT_AUTH_FAILURE_COOLDOWN_MS`)——這是
 * 「沒有設定檔時,行為必須與現在完全相同」這條相容性底線的一部分。
 */
export const PURE_DEFAULT_CORE_CONFIG = {
  version: CORE_CONFIG_VERSION,
  daemon: {
    port: 4317,
    bindHost: "127.0.0.1",
    permissionTimeoutMs: 300_000,
    authRateLimit: { max: 5, cooldownMs: 30_000 },
  },
  log: { level: "info" as LogLevel },
  // S1:沒有設定檔時的政策 = 空(rules:[] 全部落到 default-deny escalate,
  // allowedHosts:[] 全擋網路類 hard-deny),與「沒有設定檔行為不變」的相容性
  // 底線一致(policy 是全新欄位,舊行為本來就是無條件轉人,見 permission-gateway.ts)。
  policy: { rules: [], allowedHosts: [] },
  // S11(Notification):沒有設定檔時 = 桌面通知開、webhook 關(見
  // notification_detail.md §1 的預設值)。
  notification: {
    desktop: { enabled: true },
    webhook: { url: "", enabled: false, minSeverity: "escalate" as const },
    batchIntervalMinutes: 20,
  },
  // S3b(CostGovernor):沒有設定檔時 = 只有回合硬上限生效(寬鬆預設,見
  // `BudgetTurnConfigSchema` 註解),任務/每日預算不啟用(誠實的保守,不發明
  // 任意數字,見 `BudgetTaskConfigSchema` 註解)。
  budget: {
    task: {},
    daily: {},
    turn: { maxDurationMs: 30 * 60_000, maxToolCalls: 200 },
    warnAtPercent: 80,
    modelPricing: {},
  },
  // S2(message-budget):沒有設定檔時 = maxMessagesPerContext=50(見
  // `MessageBudgetConfigSchema` 註解的「預設值 50 的理由」)。
  messageBudget: {
    maxMessagesPerContext: 50,
    warnAtPercent: 80,
  },
} as const;

// ---- 設定檔驗證用的「深度 partial」schema ---------------------------------

/**
 * 使用者手寫的 `config.json` 允許只填部分欄位——每一層都是 optional(zod v3
 * 的 `.deepPartial()`,`.strict()` 仍然保留在每一層,未知欄位不會被這個
 * schema 接受,見 apps/core/src/config/load-config.ts 對「未知欄位」的獨立
 * 前置掃描與警告邏輯,那一步比這裡的型別驗證先發生)。
 */
export const CoreConfigFileSchema = CoreConfigSchema.deepPartial();
export type CoreConfigFileInput = z.infer<typeof CoreConfigFileSchema>;

// ---- config.setFile 的「安全子集」patch schema -----------------------------

/**
 * `settings.setFile`(gateway 的 `config.setFile` 方法)只允許覆寫的安全子集
 * ——**刻意不含** `daemon.port`/`daemon.bindHost`(見 README「哪些欄位不可經
 * gateway 修改與原因」):這兩個欄位決定 core 的網路曝露面,若允許任何已連上
 * gateway 的 client 遠端修改,等同讓一個已認證的 client 有能力把 core 改成
 * 對外綁定卻不需要重新輸入 token 就生效(下次重啟才生效,但仍是遠端就能觸發
 * 曝露面變更的攻擊面),必須留給本機手動編輯設定檔。
 *
 * 每一層都 `.strict()`——呼叫端若嘗試夾帶 `daemon.port`/`daemon.bindHost`
 * 這類不在允許清單內的欄位,zod 在 `ClientRequestSchema.parse()` 這一步就會
 * 直接拋出明確錯誤(未知欄位),不會走到 dispatch 邏輯。
 */
export const ConfigSetFileDaemonPatchSchema = z
  .object({
    permissionTimeoutMs: z.number().int().positive().optional(),
    authRateLimit: z
      .object({
        max: z.number().int().positive().optional(),
        cooldownMs: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/**
 * patch 語意——每個欄位都選填(與 `WorkspaceConfigSchema`/`FeaturesConfigSchema`
 * 不同,那兩個是「合併後一定有值」的必填欄位,這裡刻意獨立定義,不直接
 * alias,避免耦合:patch 只需要覆寫使用者這次想改的欄位,其餘沿用設定檔既有
 * 內容,見 apps/core/src/config/config-file-writer.ts 的 `deepMerge()`)。
 */
export const ConfigSetFileWorkspacePatchSchema = z
  .object({
    defaultWorkingDir: z.string().min(1).optional(),
    worktreesRoot: z.string().min(1).optional(),
  })
  .strict();
export const ConfigSetFileFeaturesPatchSchema = z
  .object({ staticDir: z.string().min(1).optional() })
  .strict();
export const ConfigSetFileLogPatchSchema = z
  .object({ level: LogLevelSchema.optional() })
  .strict();

/**
 * **F4(安全罩遠端不可停用)**:這裡刻意**不含 `policy`**——`policy.rules`/
 * `policy.allowedHosts` 是 default-deny 安全罩的地基本身,與 `daemon.port`/
 * `bindHost` 同等對待,只能靠本機手動編輯 `~/.deskmony/config.json` 修改,
 * 不允許任何已連上 gateway 的 client(即使已認證)透過 `config.setFile` 遠端
 * 放寬/收緊政策。新增欄位時務必維持這條——這是 review 會嚴查的安全決定
 * (見 packages/shared/src/core-config.ts 頂端「安全決定」慣例、
 * docs/DECISIONS.md §F4)。
 *
 * S11(Notification)新增:這裡同樣刻意**不含 `notification`**——
 * `notification.webhook.url` 是「能對外送資料」的能力,與 `policy` 同等對待
 * (見 notification_detail.md §1/§7 檢查清單第 1 項):只能靠本機手動編輯
 * `~/.deskmony/config.json` 修改,不提供任何 gateway RPC 遠端/UI 寫入路徑
 * (`SettingsDialog.tsx` 的通知設定區塊只唯讀顯示 `config.getEffective` 的
 * 快照,webhook url 且已遮罩,不提供輸入框——見該元件註解)。
 */
export const ConfigSetFilePatchSchema = z
  .object({
    daemon: ConfigSetFileDaemonPatchSchema.optional(),
    workspace: ConfigSetFileWorkspacePatchSchema.optional(),
    features: ConfigSetFileFeaturesPatchSchema.optional(),
    log: ConfigSetFileLogPatchSchema.optional(),
  })
  .strict();
export type ConfigSetFilePatchInput = z.infer<typeof ConfigSetFilePatchSchema>;

// ---- 有效設定(合併後)+ 來源標記 -------------------------------------------

/** 單一欄位的來源:這個值最終是從哪一層合併結果決定的。分層合併(defaults →
 *  config.json → 環境變數)最有價值的可觀察性——使用者才知道「我改了設定檔
 *  卻沒生效,是因為被環境變數蓋掉」(見 README「gateway/UI 的來源標記」)。 */
export const ConfigSourceSchema = z.enum(["default", "file", "env"]);
export type ConfigSource = z.infer<typeof ConfigSourceSchema>;

function effectiveFieldSchema<T extends z.ZodTypeAny>(value: T) {
  return z.object({ value, source: ConfigSourceSchema }).strict();
}

export const EffectiveCoreConfigSchema = z
  .object({
    version: effectiveFieldSchema(z.number()),
    daemon: z
      .object({
        port: effectiveFieldSchema(z.number()),
        bindHost: effectiveFieldSchema(z.string()),
        permissionTimeoutMs: effectiveFieldSchema(z.number()),
        authRateLimit: z
          .object({
            max: effectiveFieldSchema(z.number()),
            cooldownMs: effectiveFieldSchema(z.number()),
          })
          .strict(),
      })
      .strict(),
    workspace: z
      .object({
        defaultWorkingDir: effectiveFieldSchema(z.string()),
        /** 可能是 undefined(維持既有動態算法,見上方 WorkspaceConfigSchema 註解)。 */
        worktreesRoot: effectiveFieldSchema(z.string().optional()),
      })
      .strict(),
    data: z.object({ dataDir: effectiveFieldSchema(z.string()) }).strict(),
    features: z
      .object({ staticDir: effectiveFieldSchema(z.string().optional()) })
      .strict(),
    log: z.object({ level: effectiveFieldSchema(LogLevelSchema) }).strict(),
    policy: z
      .object({
        rules: effectiveFieldSchema(z.array(PolicyRuleSchema)),
        allowedHosts: effectiveFieldSchema(z.array(z.string())),
      })
      .strict(),
    /**
     * S11(Notification)新增。**安全關鍵**:`webhook.url` 的值在
     * `config.getEffective` 回傳給 client 前必須遮罩(見 apps/core/src/
     * gateway/ws-gateway.ts 的 `maskEffectiveConfigForClient()`)——這裡的型別
     * 仍是 `z.string()`(遮罩後的值,例如 `"***"`,也是合法字串),遮罩發生在
     * dispatch 那一層,不在這個 schema 本身(比照 `maskProviderPrefsMap()` 的
     * 既有慣例:遮罩只在「回傳給 client」這一步做,不污染型別定義)。
     */
    notification: z
      .object({
        desktop: z.object({ enabled: effectiveFieldSchema(z.boolean()) }).strict(),
        webhook: z
          .object({
            url: effectiveFieldSchema(z.string()),
            enabled: effectiveFieldSchema(z.boolean()),
            minSeverity: effectiveFieldSchema(z.enum(["escalate", "trip"])),
          })
          .strict(),
        batchIntervalMinutes: effectiveFieldSchema(z.number()),
        quietHours: effectiveFieldSchema(NotificationQuietHoursConfigSchema.optional()),
      })
      .strict(),
    /**
     * S3b(CostGovernor)新增。UI(CostView/session 標頭)靠這裡讀取目前生效的
     * 上限,搭配 §0.2 的「此後端無法量測花費」判斷(usageReporting 三態,見
     * adapter-capabilities.ts)決定要不要顯示/如何顯示。不含任何機敏資料,不
     * 需要遮罩(與 `policy` 同等對待,只是「唯讀顯示」而非「webhook url 這種
     * 憑證」)。
     */
    budget: z
      .object({
        task: z
          .object({
            maxCostUsd: effectiveFieldSchema(z.number().optional()),
            maxTokens: effectiveFieldSchema(z.number().optional()),
          })
          .strict(),
        daily: z
          .object({
            maxCostUsd: effectiveFieldSchema(z.number().optional()),
            maxTokens: effectiveFieldSchema(z.number().optional()),
          })
          .strict(),
        turn: z
          .object({
            maxDurationMs: effectiveFieldSchema(z.number()),
            maxToolCalls: effectiveFieldSchema(z.number()),
          })
          .strict(),
        warnAtPercent: effectiveFieldSchema(z.number()),
        modelPricing: effectiveFieldSchema(z.record(z.string(), BudgetModelPricingSchema)),
      })
      .strict(),
    /**
     * S2(message-budget)新增。UI(團隊群聊視圖)靠這裡讀取目前生效的訊息數
     * 上限,不含任何機敏資料,不需要遮罩(與 `budget` 同等對待)。
     */
    messageBudget: z
      .object({
        maxMessagesPerContext: effectiveFieldSchema(z.number()),
        warnAtPercent: effectiveFieldSchema(z.number()),
      })
      .strict(),
  })
  .strict();
export type EffectiveCoreConfig = z.infer<typeof EffectiveCoreConfigSchema>;
