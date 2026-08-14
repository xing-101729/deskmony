import { z } from "zod";
import { CreateSessionInputSchema, SessionSchema, MessageRecordSchema, SpawnChildSessionInputSchema } from "./session.js";
import { PromptInputSchema } from "./prompt.js";
import { PermissionDecisionSchema, SessionEventEnvelopeSchema } from "./events.js";
import {
  AgentProfileSchema,
  AgentSoftwareSchema,
  CreateAgentProfileInputSchema,
  EffortLevelSchema,
  SessionPermissionModeSchema,
} from "./agent-profile.js";
import { AdapterCapabilitiesSchema } from "./adapter-capabilities.js";
import { AgentDetectionEntrySchema } from "./detect.js";
import { MaskedProviderPrefsSchema, ProviderPrefsPatchInputSchema } from "./provider-catalog.js";
import { ConfigSetFilePatchSchema, EffectiveCoreConfigSchema } from "./core-config.js";
import {
  AddTeamMemberInputSchema,
  CreateTeamInputSchema,
  MessagePrioritySchema,
  TeamMemberSchema,
  TeamMessageSchema,
  TeamSchema,
  TeamWithMembersSchema,
} from "./team.js";
import { TeammateInfoSchema } from "./team-bus.js";
import {
  AcceptanceResultSchema,
  AssignTaskInputSchema,
  CreateTaskInputSchema,
  SetTaskAcceptanceInputSchema,
  TaskSchema,
  TaskStatusSchema,
  UpdateTaskStatusInputSchema,
  WorkspaceSchema,
} from "./task.js";
import {
  RecoveryGitStatusResultSchema,
  RecoveryListResultSchema,
  RecoveryResolveDirtyWorktreeInputSchema,
  RecoveryResolveDirtyWorktreeResultSchema,
} from "./recovery.js";

/**
 * Gateway WS 訊息協議(ARCHITECTURE.md 3.2 節):
 *   - Client -> Server:request/response(帶關聯 id)
 *   - Server -> Client:除了 response,還會主動推播 event(session 狀態/agent 輸出)
 *
 * 採 discriminated union(method 為判別欄位),每個 method 有自己的 params/result 型別。
 */

// ---- Client Requests -------------------------------------------------

const baseRequest = { id: z.string() };

export const ClientRequestSchema = z.discriminatedUnion("method", [
  /**
   * M5 Round A 新增:token-based 認證(見 apps/core/src/gateway/ws-gateway.ts
   * 頂端註解、README「認證(token-based)」章節的完整設計取捨)。只有在 core
   * 啟動時設定了 DESKMONY_AUTH_TOKEN 才需要——client 連上後必須把這個當作
   * "第一則訊息"送出,帶正確 token 才能繼續發送其他 request;未設定 token
   * 時(向下相容本機開發),呼叫這個方法一律直接成功(見 WsGateway 的
   * 判斷)。刻意選擇「連線後的第一則訊息」而非 Sec-WebSocket-Protocol 或
   * URL query string 傳遞 token,理由見 README 對應章節。
   *
   * ⚠️ 修正(原為 `z.string().min(1)`):`token` 刻意**不要求非空**——
   * ConnectScreen.tsx 明講「伺服器未啟用認證則留空」,client 端(見
   * gateway-client.ts 的 `probeGatewayConnection()`)因此會送出 `token: ""`。
   * `.min(1)` 會讓這則請求在 schema 驗證這關就被拒絕(`too_small`),連
   * WsGateway 內「未設定 authToken 時 auth 一律直接成功」這條既有的向下相容
   * 判斷都碰不到,UI 端看到的是一個誤導的「認證失敗:token 不正確」——使用者
   * 完全照著畫面指示操作(留空),卻被回報成憑證錯誤。空字串本身不會削弱
   * 安全性:core 若真的設定了 authToken,`timingSafeTokenEqual()` 的長度檢查
   * 一樣會讓空字串比對失敗(見 ws-gateway.ts),真正的認證判斷不依賴這裡的
   * schema 下限。
   */
  z.object({ ...baseRequest, method: z.literal("auth"), params: z.object({ token: z.string() }) }),
  /**
   * S7(auto-mode-and-yolo)L4 §5.3 新增:握手能力集,消除 UI/Gateway 對「這個
   * 連線是不是本機」的認知漂移——UI 純依此渲染(遠端隱藏 auto/YOLO/policy/
   * profile 管理控制項),**安全仍由每次呼叫時的 `LOCAL_ONLY_METHODS` 檢查
   * 保證**(見 apps/core/src/gateway/ws-gateway.ts),這個方法只是讓 UI 顯示
   * 正確,不是安全邊界本身。`params` 刻意是空物件——`isLocal` 只能由 Core
   * 依連線本身判定(見 `GatewayCapabilitiesSchema` 註解),不接受任何呼叫端
   * 輸入。刻意獨立於 `auth`(不強制要求 client 一定要先呼叫 `auth` 才能拿到
   * capabilities——當 core 未設定 `DESKMONY_AUTH_TOKEN` 時,既有 client 完全
   * 跳過 `auth` 請求,見 apps/desktop/src/lib/gateway-client.ts 的 `connect()`),
   * 這裡多開一個不依賴認證流程的獨立入口。
   */
  z.object({ ...baseRequest, method: z.literal("gateway.capabilities"), params: z.object({}).default({}) }),
  z.object({ ...baseRequest, method: z.literal("profile.list"), params: z.object({}).default({}) }),
  z.object({ ...baseRequest, method: z.literal("profile.create"), params: CreateAgentProfileInputSchema }),
  z.object({ ...baseRequest, method: z.literal("profile.delete"), params: z.object({ id: z.string() }) }),
  z.object({ ...baseRequest, method: z.literal("session.list"), params: z.object({}).default({}) }),
  z.object({ ...baseRequest, method: z.literal("session.create"), params: CreateSessionInputSchema }),
  z.object({
    ...baseRequest,
    method: z.literal("session.sendPrompt"),
    params: z.object({ sessionId: z.string(), prompt: PromptInputSchema }),
  }),
  z.object({
    ...baseRequest,
    method: z.literal("session.interrupt"),
    params: z.object({ sessionId: z.string() }),
  }),
  /**
   * Bug A 修正:原始鍵盤輸入直通(見 packages/adapters/src/types.ts 的
   * `AgentAdapter.writeInput` 介面註解)。與既有 `session.sendPrompt` 的差異
   * ——這裡的 `data` 逐鍵/逐段原封不動送進 pty 的 stdin,不附加 `\r`,用來
   * 讓方向鍵/Tab/Esc 等轉義序列能操作 interactive TUI 選單。只有
   * `software="pty"` 的 session 有意義(`SessionManager.writeTerminalInput()`
   * 對其餘 session 是 no-op,見該方法註解)。
   */
  z.object({
    ...baseRequest,
    method: z.literal("session.terminalInput"),
    params: z.object({ sessionId: z.string(), data: z.string() }),
  }),
  /**
   * Issue 1 修正之一:把 xterm.js 實際的顯示尺寸(cols/rows)同步給底層 pty
   * (見 packages/adapters/src/types.ts 的 `AgentAdapter.resize` 介面註解)。
   * 只有 `software="pty"` 的 session 有意義。
   */
  z.object({
    ...baseRequest,
    method: z.literal("session.resizeTerminal"),
    params: z.object({
      sessionId: z.string(),
      cols: z.number().int().positive(),
      rows: z.number().int().positive(),
    }),
  }),
  z.object({
    ...baseRequest,
    method: z.literal("session.history"),
    params: z.object({ sessionId: z.string() }),
  }),
  z.object({
    ...baseRequest,
    method: z.literal("session.delete"),
    params: z.object({ sessionId: z.string() }),
  }),
  /**
   * M5 Round C 新增:對話中切換 model(見 apps/core/src/session/
   * session-manager.ts 的 `SessionManager.setSessionModel()`、
   * packages/adapters/src/types.ts 的 `AgentAdapter.setModel()` 介面註解)。
   * `software="claude-agent-sdk"` 與 `"opencode"` 的 session 支援;acp/pty
   * 呼叫這個方法會得到明確的錯誤(而不是默默成功),見對應 adapter 的實作。
   */
  z.object({
    ...baseRequest,
    method: z.literal("session.setModel"),
    params: z.object({ sessionId: z.string(), model: z.string().min(1) }),
  }),
  /**
   * 比照上面的 `session.setModel`:對話中切換 effort(思考程度,見
   * apps/core/src/session/session-manager.ts 的
   * `SessionManager.setSessionEffort()`、packages/adapters/src/types.ts 的
   * `AgentAdapter.setEffort()` 介面註解)。只有 `software="claude-agent-sdk"`
   * 的 session 支援;其餘 adapter 呼叫這個方法會得到明確的錯誤。
   */
  z.object({
    ...baseRequest,
    method: z.literal("session.setEffort"),
    params: z.object({ sessionId: z.string(), effort: EffortLevelSchema }),
  }),
  z.object({
    ...baseRequest,
    method: z.literal("permission.resolve"),
    params: PermissionDecisionSchema,
  }),
  /**
   * S7(auto-mode-and-yolo)L4 §2 新增:切換一個 session 的暫態權限模式
   * (auto/YOLO)。**遠端一律拒絕**(見 apps/core/src/gateway/ws-gateway.ts 的
   * `LOCAL_ONLY_METHODS`)——這是「使用者能放寬安全限制」的操作,只能由本機
   * 操作者觸發(F3/F4)。`mode: "auto-accept-all"` 時 Core 會設定 30 分鐘後
   * 惰性過期(見 policy-engine_detail.md §6),`mode` 不含 hard-deny 相關語意
   * ——auto/YOLO 都不能繞過 hard-deny,只差在是否繞過 config 的 deny-list
   * (見 auto-mode-and-yolo_detail.md §2)。
   */
  z.object({
    ...baseRequest,
    method: z.literal("session.setPermissionMode"),
    params: z.object({ sessionId: z.string(), mode: SessionPermissionModeSchema }),
  }),
  /**
   * S12(session-subagent):從一個既有的 parent session 建立 child subagent
   * session。params 為 SpawnChildSessionInputSchema(含 parentSessionId/
   * agentProfileId/workingDir?/title?/prompt)。child session completed 時
   * 會自動透過 "child-result" push 回傳結果。
   */
  z.object({
    ...baseRequest,
    method: z.literal("session.spawnChild"),
    params: SpawnChildSessionInputSchema,
  }),
  z.object({
    ...baseRequest,
    method: z.literal("adapter.capabilities"),
    params: z.object({ software: AgentSoftwareSchema }),
  }),
  /**
   * M5 Round D 新增:「設定」介面用來偵測本機已裝哪些 agent 軟體、各自的
   * 版本/路徑,以及(盡力而為)可用的 model 清單(見 apps/core/src/detect/
   * agent-detector.ts 的完整安全設計 —— 只探測寫死的 allowlist 命令,一律
   * `execFile` 陣列參數 + 逾時,不接受也不會執行任何外部傳入的命令字串)。
   * `params` 刻意是空物件(不接受任何輸入)—— 這個方法的安全性完全建立在
   * 「不吃任何呼叫端參數」這一點上,不需要、也不應該讓呼叫端指定要探測什麼。
   */
  z.object({ ...baseRequest, method: z.literal("env.detectAgents"), params: z.object({}).default({}) }),
  /**
   * M5 Round E 新增:「設定」介面的「啟用哪些偵測到的 model」偏好(見
   * apps/core/src/settings/settings-store.ts 的 `SettingsStore`)。目前唯一
   * 適用的偵測項是 `claude-agent-sdk`(models = 即時查詢 Anthropic Models API
   * 拿到的清單,查不到就是空陣列,見 agent-detector.ts 的
   * `detectClaudeAgentSdk()`)——其餘 software 的 model 由外部工具自管,沒有
   * 「啟用/停用」的概念。
   *
   * 語意約定(務必與 SettingsGetEnabledModelsResultSchema 的註解保持一致):
   * **空陣列 = 全部啟用**。未曾呼叫過 `settings.setEnabledModels` 時,
   * `getEnabledModels` 回傳空陣列,呼叫端(ProfileCreateDialog/ChatView)
   * 一律把「空陣列」解讀為「沒有限制,顯示偵測到的 model 全部」,而不是
   * 「一個都不啟用」——這樣預設值(尚未進過設定頁面)才會是「目前查得到的
   * model 都可以選」,符合使用者的直覺。
   */
  z.object({ ...baseRequest, method: z.literal("settings.getEnabledModels"), params: z.object({}).default({}) }),
  z.object({
    ...baseRequest,
    method: z.literal("settings.setEnabledModels"),
    params: z.object({ enabledModelIds: z.array(z.string()) }),
  }),
  /**
   * 這輪新增(provider 目錄重構):per-provider 偏好的一般化版本,取代/擴充
   * 上面兩個只給 claude-agent-sdk 的 `settings.getEnabledModels`/
   * `setEnabledModels`(那兩個方法**保留**,現在改為底層都讀寫同一份
   * per-provider 偏好儲存的 `claude-agent-sdk` 這一項,見
   * apps/core/src/settings/settings-store.ts 的 `getEnabledClaudeModelIds()`/
   * `setEnabledClaudeModelIds()` 實作——單一資料來源,不會漂移)。
   *
   * `settings.getProviderPrefs` 回傳目前**已顯式設定過**的 provider 偏好
   * (稀疏 map,key 是 provider id;未出現在 map 裡的 provider 代表「維持
   * BUILTIN_PROVIDERS 的目錄預設值,尚未被使用者覆寫過」)。
   *
   * `settings.setProviderPrefs` 對單一 provider 的偏好做**部分欄位合併**
   * (patch semantics,不是整包取代):`enabled`/`order`/`label` 提供時直接
   * 覆寫;`env` 提供時**淺層合併**進既有 env(只覆寫/新增 patch 裡出現的
   * key,其餘既有 key 保留——因為 client 讀到的 env 一律是遮罩過的值,無法
   * 安全地整包重送,見下方 `MaskedProviderPrefsSchema` 註解);`models`/
   * `additionalModels`/`enabledModelIds` 提供時整批取代(見
   * packages/shared/src/provider-catalog.ts 的 `ProviderPrefsSchema` 完整
   * 語意說明)。
   *
   * 安全:兩個方法的回傳值(`prefs`)一律經過遮罩(env 只回傳 key 名稱,值
   * 固定回傳 "***",見 apps/core/src/settings/settings-store.ts 的
   * `maskProviderPrefsMap()`)——這是刻意的安全邊界,避免任何連上 gateway 的
   * client(不只是建立這筆偏好的那個 client)都能讀走 API key 明文,見
   * README「provider 偏好與 env 的安全取捨」章節。
   */
  z.object({ ...baseRequest, method: z.literal("settings.getProviderPrefs"), params: z.object({}).default({}) }),
  z.object({
    ...baseRequest,
    method: z.literal("settings.setProviderPrefs"),
    params: z.object({ providerId: z.string().min(1), patch: ProviderPrefsPatchInputSchema }),
  }),
  /**
   * M6 Round A 新增:「全域設定」的分層合併結果(defaults → config.json →
   * 環境變數,見 packages/shared/src/core-config.ts、apps/core/src/config/
   * load-config.ts)。`params` 刻意是空物件——`getEffective` 只回傳這個 core
   * process 啟動時就已經解析好的快照(不做熱重載,見下方 `config.setFile`
   * 註解),不需要任何輸入。
   *
   * **安全**:回傳值一律不含 `DESKMONY_AUTH_TOKEN`(這份設定完全沒有任何
   * token 欄位,見 core-config.ts 頂端「安全決定」說明)。
   */
  z.object({ ...baseRequest, method: z.literal("config.getEffective"), params: z.object({}).default({}) }),
  /**
   * M6 Round A 新增:把安全子集的欄位覆寫寫進 `<DESKMONY_HOME>/config.json`
   * (檔案不存在時會建立,含 `version`/`$schema`)。**刻意不允許**
   * `daemon.port`/`daemon.bindHost`(見 `ConfigSetFilePatchSchema` 的完整安全
   * 說明——這兩個欄位決定 core 的網路曝露面,只能靠本機手動編輯設定檔改)。
   * 寫入後**不做熱重載**——回傳值只回報「已寫入哪些欄位、需要重啟 core 才會
   * 生效」,呼叫端(SettingsDialog)需自行顯示「請重啟 core」的提示。
   */
  z.object({ ...baseRequest, method: z.literal("config.setFile"), params: ConfigSetFilePatchSchema }),
  // ---- M3 Round A: TeamManager + MessageBus -----------------------------
  z.object({ ...baseRequest, method: z.literal("team.create"), params: CreateTeamInputSchema }),
  z.object({ ...baseRequest, method: z.literal("team.list"), params: z.object({}).default({}) }),
  z.object({ ...baseRequest, method: z.literal("team.addMember"), params: AddTeamMemberInputSchema }),
  z.object({
    ...baseRequest,
    method: z.literal("team.removeMember"),
    params: z.object({ teamId: z.string(), memberId: z.string() }),
  }),
  z.object({
    ...baseRequest,
    method: z.literal("team.messages"),
    params: z.object({ teamId: z.string(), limit: z.number().int().positive().optional() }),
  }),
  /**
   * M3 Round B 新增:團隊管理 UI 顯示成員清單目前 session 狀態用。直接複用
   * `MessageBus.listTeammates()`(原本只給 team-bus MCP 的 `list_teammates`
   * 工具內部呼叫,見 apps/core/src/bus/message-bus.ts)——同一份邏輯、同一個
   * 資料來源,這裡只是多開一個 gateway 入口給 UI(非 agent)呼叫,不重複實作。
   */
  z.object({
    ...baseRequest,
    method: z.literal("team.teammates"),
    params: z.object({ teamId: z.string() }),
  }),
  /** 人類在團隊群聊視圖插話用。 */
  z.object({
    ...baseRequest,
    method: z.literal("message.send"),
    params: z.object({
      teamId: z.string(),
      to: z.string().min(1),
      content: z.string().min(1),
      priority: MessagePrioritySchema.optional(),
      /** 顯示用的發送者名稱,預設 "Human"。若剛好與某個 TeamMember 同名,
       *  priority="interrupt" 時仍會依該成員的 canInterrupt 決定是否降級
       *  (見 apps/core/src/bus/message-bus.ts 的 resolvePriorityForSender)。 */
      fromName: z.string().min(1).optional(),
    }),
  }),
  /**
   * M4 Round A 新增:比照 M3 Round B「team.teammates」的先例(多開一個 gateway
   * 入口給非 agent 呼叫端使用同一份既有邏輯,不重複實作)—— `MessageBus.reportStatus()`
   * 原本只給 team-bus 的 `report_status` MCP 工具呼叫(只有 software=
   * "claude-agent-sdk" 的成員能呼叫工具),ACP/PTY 成員完全沒有回報狀態的
   * 管道。這個方法讓任何呼叫端(UI、或這次 e2e 用來對 report_status↔task
   * 整合做決定性測試)可以代表一個已知的 team member 回報狀態,走的是與
   * MCP 工具完全相同的 `MessageBus.reportStatus()` 實作(含這輪新增的
   * taskId → TaskService 整合),見 apps/core/src/bus/message-bus.ts。
   */
  z.object({
    ...baseRequest,
    method: z.literal("message.reportStatus"),
    params: z.object({
      teamId: z.string(),
      fromMemberId: z.string(),
      status: z.string().min(1),
      summary: z.string().optional(),
      taskId: z.string().optional(),
    }),
  }),
  /**
   * M4 Round B 新增:`request_review` MCP 工具(ARCHITECTURE.md 4.1 節列出、
   * M3/M4 Round A 備註都明講「這輪先不做」的那個工具)的 gateway 對應入口 ——
   * 比照 `message.reportStatus` 的先例,多開一個非 agent 呼叫端也能用的入口
   * (UI、或 e2e 決定性測試不依賴真實模型的呼叫路徑),走完全相同的
   * `MessageBus.requestReview()` 實作。
   */
  z.object({
    ...baseRequest,
    method: z.literal("message.requestReview"),
    params: z.object({
      teamId: z.string(),
      fromMemberId: z.string(),
      to: z.string().min(1),
      taskId: z.string().optional(),
    }),
  }),
  /**
   * S2(message-budget)新增:比照 `message.reportStatus`/`message.requestReview`
   * 的既有先例(見上方兩者的註解)——`MessageBus.sendMessage()`/`broadcast()`
   * (team-bus 的 `send_message`/`broadcast` 工具)原本只能透過真正的
   * Claude Agent SDK session 呼叫(team-bus MCP server 只掛載在
   * `ClaudeAgentSdkAdapter`,見 packages/adapters/src/team-bus-mcp.ts),沒有
   * 任何不依賴真實模型的決定性呼叫路徑可以測試 contextId 推導/訊息預算閘
   * (message-budget_detail.md §7 檢查清單的 e2e 項目)。這裡多開兩個入口,
   * `fromMemberId` 一律代表一個**已知的 team member**(不是 agent 自報,呼叫
   * 端本身要嘛是人類/UI,要嘛是本來就知道自己是誰的 e2e 測試),走與 team-bus
   * MCP 工具完全相同的 `MessageBus.sendMessage()`/`broadcast()` 實作,包含
   * S2 這輪新增的 contextId 推導與預算檢查——**不是**繞過閘門的後門。
   */
  z.object({
    ...baseRequest,
    method: z.literal("message.sendMessage"),
    params: z.object({
      teamId: z.string(),
      fromMemberId: z.string(),
      to: z.string().min(1),
      content: z.string().min(1),
      priority: MessagePrioritySchema.optional(),
    }),
  }),
  z.object({
    ...baseRequest,
    method: z.literal("message.broadcast"),
    params: z.object({
      teamId: z.string(),
      fromMemberId: z.string(),
      content: z.string().min(1),
      priority: MessagePrioritySchema.optional(),
    }),
  }),
  /**
   * S2(message-budget)新增:團隊群聊視圖顯示「這個 context 目前用了多少
   * 訊息額度、是否已 trip」用(見 message-budget_detail.md §7 檢查清單「UI
   * 群聊視圖:顯示 context 與額度餘量;trip 狀態」),直接複用
   * `MessageBus.getContextBudgetStatus()`。
   */
  z.object({
    ...baseRequest,
    method: z.literal("message.getContextBudget"),
    params: z.object({ contextId: z.string() }),
  }),
  // ---- M4 Round A: TaskService + WorkspaceManager -----------------------
  z.object({ ...baseRequest, method: z.literal("task.create"), params: CreateTaskInputSchema }),
  z.object({ ...baseRequest, method: z.literal("task.list"), params: z.object({ teamId: z.string() }) }),
  z.object({ ...baseRequest, method: z.literal("task.get"), params: z.object({ taskId: z.string() }) }),
  z.object({ ...baseRequest, method: z.literal("task.assign"), params: AssignTaskInputSchema }),
  z.object({ ...baseRequest, method: z.literal("task.updateStatus"), params: UpdateTaskStatusInputSchema }),
  z.object({ ...baseRequest, method: z.literal("task.delete"), params: z.object({ taskId: z.string() }) }),
  /**
   * M4 Round B 新增:「人類批准合併」的唯一實際執行 git merge 的入口(見
   * apps/core/src/tasks/task-service.ts 的 mergeAndComplete()、
   * apps/core/src/workspace/workspace-manager.ts 的 mergeWorkspace())。要求
   * 任務現狀必須是 "merging",合併衝突或其他錯誤會讓這個 RPC 直接失敗
   * (ok:false),任務狀態維持在 "merging" 不變。
   */
  z.object({ ...baseRequest, method: z.literal("task.merge"), params: z.object({ taskId: z.string() }) }),
  /**
   * M4 Round B 新增:查詢單一 workspace(任務看板 UI 顯示每個任務綁定的
   * worktree 分支名稱用,見 apps/desktop/src/stores/task-store.ts)。
   */
  z.object({ ...baseRequest, method: z.literal("workspace.get"), params: z.object({ workspaceId: z.string() }) }),
  /**
   * S4(機器驗收閘)新增:事後設定/清除一個既有任務的機器驗收條件(見
   * task.ts 的 `SetTaskAcceptanceInputSchema` 註解——只能由人類/UI 呼叫,
   * team-bus MCP 工具沒有對應入口,完整性紀律見該檔案說明)。
   */
  z.object({ ...baseRequest, method: z.literal("task.setAcceptance"), params: SetTaskAcceptanceInputSchema }),
  /**
   * S4(機器驗收閘)新增:跑一個任務的機器驗收(見
   * apps/core/src/tasks/task-service.ts 的 `runAcceptance()`、
   * apps/core/src/tasks/acceptance-runner.ts 的 `AcceptanceRunner`)。切片是
   * **諮詢性**——這個方法本身完全不擋任何狀態轉換,純粹跑指令回結果,由
   * 呼叫端(UI)自行決定要不要理會(見 acceptance-gate_detail.md §0/§4)。
   * 沒有 `acceptance` 時回 `{ passed: false, skippedReason: "no-acceptance" }`,
   * 不當成失敗。
   */
  z.object({ ...baseRequest, method: z.literal("task.runAcceptance"), params: z.object({ taskId: z.string() }) }),
  /**
   * S5(dispose-gate)新增:人類核可一個「沒有機器驗收條件(或連續驗收失敗達
   * 上限)、正在等待人類核可」的任務進入 review(見
   * apps/core/src/tasks/task-service.ts 的 `approveReview()`、
   * docs/LAYER-4-detail-design/dispose-gate-and-lead_detail.md §1.2/§4)。
   * 只有 `Task.awaitingHumanReview === true` 的任務能呼叫,否則明確拋錯。
   * **本機/遠端皆可**——這不是安全罩設定,是日常操作(L4 §4 檢查清單)。
   */
  z.object({ ...baseRequest, method: z.literal("task.approveReview"), params: z.object({ taskId: z.string() }) }),
  /**
   * S3b(CostGovernor)新增:查詢一個 session 目前的成本累計與門檻狀態(見
   * apps/core/src/cost/cost-governor.ts 的 `getSummary()`,對應
   * cost-governor_detail.md §7「UI:CostView」)。UI 搭配 `config.getEffective`
   * 回傳的 `budget` 區塊(門檻本身)與 `adapter.capabilities` 的
   * `usageReporting` 三態(這個後端到底量不量測得到花費,見
   * adapter-capabilities.ts)一起決定要顯示什麼——這個方法本身只回傳「目前
   * 累計到多少」,不含「這個後端能不能量測」的判斷(那是 capabilities 的
   * 職責,避免同一個事實在兩個地方各自表述而漂移)。
   */
  z.object({ ...baseRequest, method: z.literal("cost.getSummary"), params: z.object({ sessionId: z.string() }) }),
  // ---- S6(crash-recovery)新增:對帳 + 人工分流(見
  // docs/LAYER-4-detail-design/crash-recovery_detail.md §5)------------------
  /**
   * 復原視圖的資料來源——列出所有 `status === "interrupted"` 的 session,含
   * 各自綁定的任務/worktree 狀態與「這個後端支不支援繼續」(見
   * packages/shared/src/recovery.ts 的 `RecoverySessionInfoSchema`)。`params`
   * 刻意是空物件——一律回傳全部(§6:大量孤兒時**對帳**批次處理不阻塞啟動,
   * 但這裡的清單本身沒有分頁,復原視圖本身的分頁留給 UI 端做,見該 case 的
   * gateway 實作註解)。
   */
  z.object({ ...baseRequest, method: z.literal("recovery.list"), params: z.object({}).default({}) }),
  /**
   * 「繼續(保有記憶)」——只有 `RecoverySessionInfo.canContinue === true` 時
   * UI 才會顯示這個按鈕(§4.1),但 Core 端仍會重新驗證一次(不信任 client
   * 端的舊快照),不支援時明確拋錯,不靜默退化成「接手」。
   */
  z.object({ ...baseRequest, method: z.literal("recovery.continue"), params: z.object({ sessionId: z.string() }) }),
  /** 「接手(讀摘要重啟)」——一律可用(§5.2),見 RecoveryService.takeover()。 */
  z.object({ ...baseRequest, method: z.literal("recovery.takeover"), params: z.object({ sessionId: z.string() }) }),
  /**
   * 「重跑」前查看 worktree 現況——回傳 `git status --porcelain` + `git diff`
   * (§5.2「先顯示 diff」)。`merging` 崩潰的任務改查 `baseDir`(§5.3「檢查 git
   * 狀態」,不提供任何自動修復)。
   */
  z.object({ ...baseRequest, method: z.literal("recovery.gitStatus"), params: z.object({ sessionId: z.string() }) }),
  /**
   * 對髒 worktree 的強制前置流程(§5.2):`action: "keep"` 建 wip 分支並
   * commit;`action: "discard"` 執行 `git reset --hard` + `git clean -fd`,
   * 必須帶 `confirmDiscard: true`(二次確認)否則拒絕——**絕不默默丟棄**。
   */
  z.object({
    ...baseRequest,
    method: z.literal("recovery.resolveDirtyWorktree"),
    params: RecoveryResolveDirtyWorktreeInputSchema,
  }),
  /**
   * 「重跑」——要求 worktree 目前必須乾淨(呼叫前應已呼叫過
   * `recovery.resolveDirtyWorktree` 處理過,或這條 session 原本就沒有 worktree/
   * worktree 本來就乾淨)。**絕不默默在髒 worktree 上重跑**——髒時直接拋出
   * 明確錯誤,不自動處理。
   */
  z.object({ ...baseRequest, method: z.literal("recovery.rerun"), params: z.object({ sessionId: z.string() }) }),
  /** 「放棄」——session 標 `closed`;worktree/任務一律保留(§5.2,同 S3b「回收 ≠ 丟棄」)。 */
  z.object({ ...baseRequest, method: z.literal("recovery.abandon"), params: z.object({ sessionId: z.string() }) }),
]);
export type ClientRequest = z.infer<typeof ClientRequestSchema>;
export type ClientRequestMethod = ClientRequest["method"];

// ---- Server Responses --------------------------------------------------

export const ServerResponseSchema = z.object({
  kind: z.literal("response"),
  id: z.string(),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().optional(),
  /**
   * i18n 專案新增(見 packages/shared/src/errors.ts 的 `DeskmonyError`):
   * `error` 欄位維持原樣(既有慣例,失敗時一律有值的純文字訊息,向下相容不動)
   * ——`errorCode`/`errorParams` 是額外疊加的結構化資訊,只有拋出端是
   * `DeskmonyError` 時才會有值。舊版 core(尚未升級)回傳的 response 天生不帶
   * 這兩個欄位,前端(見 apps/desktop/src/lib/error-i18n.ts)在缺值時一律退回
   * 顯示 `error` 這個純文字訊息,不會壞掉。
   */
  errorCode: z.string().optional(),
  errorParams: z.record(z.unknown()).optional(),
});
export type ServerResponse = z.infer<typeof ServerResponseSchema>;

// ---- Server Push Events -------------------------------------------------

export const ServerPushSchema = z.object({
  kind: z.literal("event"),
  channel: z.enum([
    "session-event",
    "session-updated",
    "session-list-updated",
    "permission-resolved",
    /** M3 Round A:一筆 TeamMessage 被 MessageBus 持久化時推播給所有 client
     * (ARCHITECTURE.md 4.2 節「所有訊息同步寫入 Event Log,並推播到 UI 的
     * 團隊群聊視圖」)。群聊 UI 本身留給 Round B,這輪只確保 payload 送達。 */
    "team-message",
    /** M4 Round A:一個任務的狀態(或指派/刪除相關欄位)變更時推播給所有
     * client(ARCHITECTURE.md 3.1 節「任務看板」M4 消費這個 channel;看板 UI
     * 本身留給 Round B,這輪只確保 payload 送達)。 */
    "task-updated",
    /** M4 Round B 新增:任務被 task.delete 刪除時推播(payload:
     * `{ id: string; teamId: string }`)—— "task-updated" 只在任務仍然存在、
     * 欄位變更時觸發,刪除是另一種語意,看板 UI 需要明確訊號才能把已刪除的
     * 任務從畫面上移除。 */
    "task-deleted",
    /** S11(Notification)新增:升級/熔斷需要帶外通知人類時推播(payload 見
     *  notification.ts 的 `EnforcementNotificationPushSchema`)——Core 是
     *  headless、沒有 Electron API,實際的原生系統通知由 desktop renderer
     *  收到這個 push 後呼叫 `deskmony:notify` IPC,交給 Electron 主行程觸發
     *  (見 apps/desktop/electron/main.ts、notification_detail.md §2.1)。 */
    "enforcement-notification",
    /**
     * S12(session-subagent):child subagent session 完成時推播結果給所有
     * client——payload 是 `ChildResultPushSchema`(含 parentSessionId/
     * childSessionId/childTitle/finalText/ts)。
     */
    "child-result",
  ]),
  payload: z.unknown(),
});
export type ServerPush = z.infer<typeof ServerPushSchema>;

/**
 * `permission-resolved` channel 的 payload:一筆權限請求被解決(不論是使用者
 * 在 UI 按下允許/拒絕、PermissionGateway 逾時自動 deny,或 S1 PolicyEngine
 * 自動放行/拒絕)時推播給所有 client,用來讓 UI 主動關閉對應的彈窗(即使不是
 * 自己觸發的解決)。
 *
 * `source: "policy"`(S1 新增):`decide()` 判定為 allow/deny 時直接呼叫
 * `adapter.resolvePermission()`,完全不經過 `waiting` 狀態(見
 * docs/LAYER-4-detail-design/policy-engine_detail.md §0)——UI 仍然需要知道
 * 「這筆請求已經被解決」,只是來源不是使用者手動點擊,也不是逾時,而是政策
 * 引擎自動判定。
 */
export const PermissionResolvedPushSchema = z.object({
  sessionId: z.string(),
  requestId: z.string(),
  decision: z.enum(["allow", "deny"]),
  source: z.enum(["user", "timeout", "policy"]),
});
export type PermissionResolvedPush = z.infer<typeof PermissionResolvedPushSchema>;

export const ServerMessageSchema = z.union([ServerResponseSchema, ServerPushSchema]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

// ---- Typed result shapes (used by both core & desktop for narrowing) ----

/**
 * S7(auto-mode-and-yolo)L4 §5.3:握手能力集,四項皆等於 `isLocal`(見
 * apps/core/src/gateway/ws-gateway.ts 的 `WsGateway.buildCapabilities()`)——
 * **由 Core 依連線本身(loopback 正規化後比對)判定,絕不採信 client 自稱**。
 * 隧道連線(Tailscale/WireGuard 等)不是 loopback,視為遠端——這是刻意的,
 * 隧道只解決傳輸安全,不代表操作者在本機(F1/F3)。
 */
export const GatewayCapabilitiesSchema = z.object({
  /** 能否切換 session 的 auto 模式(`session.setPermissionMode` 設成 `"auto-accept-edits"`)。 */
  canToggleAuto: z.boolean(),
  /** 能否啟用 YOLO(`session.setPermissionMode` 設成 `"auto-accept-all"`)。 */
  canEnableYolo: z.boolean(),
  /** 能否編輯 policy(目前 policy 完全不能透過任何 gateway 方法遠端編輯,見
   *  core-config.ts 的 `ConfigSetFilePatchSchema` 說明——這個欄位純粹給 UI
   *  預留未來若開放本機 policy 編輯介面時使用,現況恆與 isLocal 一致)。 */
  canEditPolicy: z.boolean(),
  /** 能否管理 agent profile(`profile.create`,之後的 `profile.update`/`delete`)。 */
  canManageProfiles: z.boolean(),
});
export type GatewayCapabilities = z.infer<typeof GatewayCapabilitiesSchema>;

/** `gateway.capabilities` 的回應。 */
export const GatewayCapabilitiesResultSchema = z.object({ capabilities: GatewayCapabilitiesSchema });

/** M5 Round A:`auth` request 的回應(認證成功時)。S7 這輪額外附上握手能力集
 *  (見上方 `GatewayCapabilitiesSchema`),與獨立的 `gateway.capabilities` 方法
 *  回傳相同的值——`auth` 附帶一份是為了少一次往返(client 若剛好會呼叫
 *  `auth`),`gateway.capabilities` 是保證一定能拿到的獨立入口(見該 case 註解)。 */
export const AuthResultSchema = z.object({ ok: z.literal(true), capabilities: GatewayCapabilitiesSchema });

export const ProfileListResultSchema = z.object({ profiles: z.array(AgentProfileSchema) });
export const ProfileCreateResultSchema = z.object({ profile: AgentProfileSchema });
export const ProfileDeleteResultSchema = z.object({ ok: z.literal(true) });
export const SessionListResultSchema = z.object({ sessions: z.array(SessionSchema) });
export const SessionCreateResultSchema = z.object({ session: SessionSchema });
export const SessionHistoryResultSchema = z.object({ messages: z.array(MessageRecordSchema) });
export const OkResultSchema = z.object({ ok: z.literal(true) });
/** M5 Round C:`session.setModel` 的回應——回傳更新後的完整 Session,讓呼叫端
 * 不需要等下一次 "session-updated" 推播就能立即拿到新的 `model` 值。 */
export const SessionSetModelResultSchema = z.object({ session: SessionSchema });
/** 比照上面的 `SessionSetModelResultSchema`:`session.setEffort` 的回應。 */
export const SessionSetEffortResultSchema = z.object({ session: SessionSchema });
/** S7:`session.setPermissionMode` 的回應——回傳套用後的模式與(若為 YOLO)
 *  到期時間戳,讓呼叫端不需要再等一次 "session-updated" 推播就能更新 UI。 */
export const SessionSetPermissionModeResultSchema = z.object({
  mode: SessionPermissionModeSchema,
  yoloExpiresAt: z.number().optional(),
});
/**
 * `adapter.capabilities` 的回應(M2 Round B):讓 UI 在建立 session 前
 * (依 `AgentProfile.software`)或拿到 session 之後(依 `Session.adapterType`)
 * 查詢對應 adapter 的能力,決定要渲染聊天串流視圖還是 xterm 終端視圖
 * (ARCHITECTURE.md 3.4 節「能力探測 + 優雅降級」)。
 */
export const AdapterCapabilitiesResultSchema = z.object({ capabilities: AdapterCapabilitiesSchema });

/**
 * M5 Round D:`env.detectAgents` 的回應 —— 一份陣列,每項是一個已知 agent
 * 軟體(或內嵌的 claude-agent-sdk)的偵測結果(見 packages/shared/src/detect.ts
 * 的 `AgentDetectionEntrySchema`)。陣列順序:`claude-agent-sdk` 這個內嵌項
 * 固定排第一個(見 apps/core/src/detect/agent-detector.ts 的
 * `detectAllAgents()`),其餘依 allowlist 宣告順序。
 */
export const DetectAgentsResultSchema = z.object({ agents: z.array(AgentDetectionEntrySchema) });

/**
 * M5 Round E:`settings.getEnabledModels` / `settings.setEnabledModels` 的回應
 * ——見上方 `ClientRequestSchema` 內對應 case 的「空陣列 = 全部啟用」約定。
 * `setEnabledModels` 回傳更新後的完整清單,讓呼叫端(SettingsDialog)不需要
 * 再多一次 RPC 往返確認寫入成功的值。
 */
export const SettingsGetEnabledModelsResultSchema = z.object({ enabledModelIds: z.array(z.string()) });
export const SettingsSetEnabledModelsResultSchema = z.object({ enabledModelIds: z.array(z.string()) });

/**
 * 這輪新增:`settings.getProviderPrefs`/`settings.setProviderPrefs` 的回應
 * ——`prefs` 一律是遮罩過的(見 provider-catalog.ts 的
 * `MaskedProviderPrefsSchema`、上方 `ClientRequestSchema` 對應 case 的完整
 * 安全說明)。`setProviderPrefs` 回傳 patch 之後的**完整**偏好 map,呼叫端
 * 不需要再多一次 `getProviderPrefs` 往返確認寫入結果。
 */
export const SettingsGetProviderPrefsResultSchema = z.object({
  prefs: z.record(z.string(), MaskedProviderPrefsSchema),
});
export const SettingsSetProviderPrefsResultSchema = z.object({
  prefs: z.record(z.string(), MaskedProviderPrefsSchema),
});

/**
 * M6 Round A:`config.getEffective` 的回應——見上方 `ClientRequestSchema` 對應
 * case 的完整說明。`config.setFile` 的回應報告「這次實際寫入了哪些欄位」
 * (dot-path 字串,例如 `"log.level"`)與「是否需要重啟 core 才會生效」——
 * 這輪固定是 `true`(沒有做熱重載,見上方 case 註解),欄位保留 boolean 而不是
 * 寫死常數,是為了未來若真的做了熱重載時協議不必變動。
 */
export const ConfigGetEffectiveResultSchema = z.object({ effective: EffectiveCoreConfigSchema });
export const ConfigSetFileResultSchema = z.object({
  ok: z.literal(true),
  changedFields: z.array(z.string()),
  requiresRestart: z.boolean(),
});

// ---- M3 Round A: Team / MessageBus result shapes -------------------------
export const TeamCreateResultSchema = z.object({ team: TeamSchema });
export const TeamListResultSchema = z.object({ teams: z.array(TeamWithMembersSchema) });
export const TeamAddMemberResultSchema = z.object({ member: TeamMemberSchema });
export const TeamMessagesResultSchema = z.object({ messages: z.array(TeamMessageSchema) });
export const TeamTeammatesResultSchema = z.object({ teammates: z.array(TeammateInfoSchema) });
export const MessageSendResultSchema = z.object({
  message: TeamMessageSchema,
  delivered: z.enum(["immediate", "queued", "no-session"]),
  downgraded: z.boolean(),
});

export const MessageReportStatusResultSchema = z.object({ message: TeamMessageSchema });

/** M4 Round B:message.requestReview 的回應(見 apps/core/src/bus/message-bus.ts 的 RequestReviewOutcome)。 */
export const MessageRequestReviewResultSchema = z.object({
  message: TeamMessageSchema,
  delivered: z.enum(["immediate", "queued", "no-session"]),
  downgraded: z.boolean(),
  taskUpdated: z.boolean(),
  taskFromStatus: TaskStatusSchema.optional(),
  taskToStatus: TaskStatusSchema.optional(),
  taskSkippedReason: z.string().optional(),
});

/** S2(message-budget):`message.sendMessage`/`message.broadcast` 的回應,
 *  形狀與 `message.send`(人類插話)的 `MessageSendResultSchema` 相同,直接
 *  複用。 */
export const MessageSendMessageResultSchema = MessageSendResultSchema;
export const MessageBroadcastResultSchema = MessageSendResultSchema;

/** S2(message-budget):`message.getContextBudget` 的回應,見
 *  `MessageBus.getContextBudgetStatus()`。 */
export const MessageGetContextBudgetResultSchema = z.object({
  contextId: z.string(),
  count: z.number().int().nonnegative(),
  max: z.number().int().positive(),
  tripped: z.boolean(),
});

// ---- M4 Round A: TaskService / WorkspaceManager result shapes -------------
export const TaskCreateResultSchema = z.object({ task: TaskSchema });
export const TaskListResultSchema = z.object({ tasks: z.array(TaskSchema) });
export const TaskGetResultSchema = z.object({ task: TaskSchema });
export const TaskAssignResultSchema = z.object({ task: TaskSchema, workspace: WorkspaceSchema });
export const TaskUpdateStatusResultSchema = z.object({ task: TaskSchema });
/** M4 Round B:task.merge 的回應 —— 成功時任務一定是 "done"(mergeAndComplete 的保證)。 */
export const TaskMergeResultSchema = z.object({ task: TaskSchema });
/** M4 Round B:task.delete 的回應多了 hadUncommittedChanges(見 WorkspaceManager.removeWorkspace)。 */
export const TaskDeleteResultSchema = z.object({ ok: z.literal(true), hadUncommittedChanges: z.boolean() });
/** M4 Round B:workspace.get 的回應。 */
export const WorkspaceGetResultSchema = z.object({ workspace: WorkspaceSchema });
/** M4 Round B:task-deleted server push 的 payload。 */
export const TaskDeletedPushSchema = z.object({ id: z.string(), teamId: z.string() });
/** S4:task.setAcceptance 的回應——回傳更新後的完整 Task。 */
export const TaskSetAcceptanceResultSchema = z.object({ task: TaskSchema });
/** S4:task.runAcceptance 的回應——見 `AcceptanceResultSchema`(task.ts)完整欄位說明。 */
export const TaskRunAcceptanceResultSchema = z.object({ result: AcceptanceResultSchema });
/** S5(dispose-gate):task.approveReview 的回應——回傳轉入 review 後的完整 Task。 */
export const TaskApproveReviewResultSchema = z.object({ task: TaskSchema });

/**
 * S3b(CostGovernor):`cost.getSummary` 的回應——見
 * apps/core/src/cost/cost-governor.ts 的 `CostGovernor.getSummary()`。
 * `costCurrency` 為 `undefined` 代表這個 scope 至今沒有任何一筆 usage 事件帶過
 * 金額(可能後端只給 token,或這個後端完全不報 usage,見
 * `AdapterCapabilitiesSchema.usageReporting`)——UI 應顯示 token 數而非 "$0"。
 */
const RollupSnapshotSchema = z.object({
  costAmount: z.number(),
  costCurrency: z.string().optional(),
  inputTokens: z.number(),
  outputTokens: z.number(),
});
export const CostGetSummaryResultSchema = z.object({
  session: RollupSnapshotSchema,
  task: z
    .object({
      taskId: z.string(),
      title: z.string(),
      rollup: RollupSnapshotSchema,
      /** 這個任務是否已觸發任務預算 trip(後續 prompt 已被擋下)。 */
      tripped: z.boolean(),
    })
    .optional(),
  day: RollupSnapshotSchema,
  /** 今天是否已觸發每日 kill-switch(所有 session 的新 prompt 都會被擋下)。 */
  dailyTripped: z.boolean(),
});
export type CostGetSummaryResult = z.infer<typeof CostGetSummaryResultSchema>;

// ---- S6(crash-recovery)result shapes -------------------------------------
export { RecoveryListResultSchema, RecoveryGitStatusResultSchema, RecoveryResolveDirtyWorktreeResultSchema };
/** `recovery.continue` / `recovery.takeover` / `recovery.rerun` 都回傳更新後的完整 Session。 */
export const RecoverySessionResultSchema = z.object({ session: SessionSchema });
export const RecoveryAbandonResultSchema = z.object({ ok: z.literal(true) });

export { SessionEventEnvelopeSchema };

/**
 * S12(session-subagent):`session.spawnChild` 的回應——回傳建立的 child
 * Session 物件。
 */
export const SpawnChildSessionResultSchema = z.object({ session: SessionSchema });

/**
 * S12(session-subagent):"child-result" push 的 payload——child session 完成
 * 時推播,含 parentSessionId/childSessionId/childTitle/finalText/ts。
 */
export const ChildResultPushSchema = z.object({
  parentSessionId: z.string(),
  childSessionId: z.string(),
  childTitle: z.string(),
  finalText: z.string(),
  ts: z.number(),
});
export type ChildResultPush = z.infer<typeof ChildResultPushSchema>;
