import { z } from "zod";
import { CreateSessionInputSchema, SessionSchema, MessageRecordSchema } from "./session.js";
import { PromptInputSchema } from "./prompt.js";
import { DialogAnswerSchema, PermissionDecisionSchema, SessionEventEnvelopeSchema, SlashCommandInfoSchema } from "./events.js";
import { AgentSoftwareSchema, EffortLevelSchema, SessionPermissionModeSchema } from "./agent-launch.js";
import { AdapterCapabilitiesSchema } from "./adapter-capabilities.js";
import { AgentDetectionEntrySchema } from "./detect.js";
import { MaskedProviderPrefsSchema, ProviderPrefsPatchInputSchema } from "./provider-catalog.js";
import { ConfigSetFilePatchSchema, EffectiveCoreConfigSchema, PolicyAddRuleInputSchema, PolicyRuleSchema } from "./core-config.js";
import { NetworkAgentSummarySchema, NetworkSessionSummarySchema, ReadSessionResultSchema } from "./session-network.js";
import { RecoveryListResultSchema } from "./recovery.js";

/**
 * Gateway WS 訊息協議(ARCHITECTURE.md 3.2 節):
 *   - Client -> Server:request/response(帶關聯 id)
 *   - Server -> Client:除了 response,還會主動推播 event(session 狀態/agent 輸出)
 *
 * 採 discriminated union(method 為判別欄位),每個 method 有自己的 params/result 型別。
 */

// ---- Client Requests -------------------------------------------------

const baseRequest = { id: z.string() };

/** `session.forwardMessage` 的 `text` 字元上限(UI 轉傳的是畫面上單一氣泡的文字,實務上遠小於此)。 */
export const FORWARD_MESSAGE_MAX_CHARS = 100_000;

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
   * 連線是不是本機」的認知漂移——UI 純依此渲染(遠端隱藏 auto/YOLO/policy
   * 控制項),**安全仍由每次呼叫時的 `LOCAL_ONLY_METHODS` 檢查
   * 保證**(見 apps/core/src/gateway/ws-gateway.ts),這個方法只是讓 UI 顯示
   * 正確,不是安全邊界本身。`params` 刻意是空物件——`isLocal` 只能由 Core
   * 依連線本身判定(見 `GatewayCapabilitiesSchema` 註解),不接受任何呼叫端
   * 輸入。刻意獨立於 `auth`(不強制要求 client 一定要先呼叫 `auth` 才能拿到
   * capabilities——當 core 未設定 `DESKMONY_AUTH_TOKEN` 時,既有 client 完全
   * 跳過 `auth` 請求,見 apps/desktop/src/lib/gateway-client.ts 的 `connect()`),
   * 這裡多開一個不依賴認證流程的獨立入口。
   */
  z.object({ ...baseRequest, method: z.literal("gateway.capabilities"), params: z.object({}).default({}) }),
  /**
   * 2026-10-02(P2:移除 profile):`profile.list`/`profile.create`/`profile.delete` 已整個
   * 移除——session 直接以偵測到的 agent(providerId)建立,見 `CreateSessionInputSchema`;
   * 可用的 agent 清單來自 `env.detectAgents` + `settings.getProviderPrefs` 經
   * `resolveProviders()` 合併。**gateway 刻意沒有任何能新增任意 command 的方法**:
   * 唯一能把非偵測到的執行檔放進 `AgentCatalog` 的是 e2e 專用的環境變數
   * `DESKMONY_E2E_EXTRA_PROVIDERS`(只有啟動 core 的人能設,見
   * apps/core/src/agents/agent-catalog.ts)。
   */
  /**
   * 2026-10-02(P3:session 網路)——**五個 bridge 專用方法**(`agent.listForAgent`、`session.listForAgent`、
   * `session.readForAgent`、`session.createFromAgent`、`session.sendFromAgent`),對應 `list_agents`/
   * `list_sessions`/`read_session`/`create_session`/`send_to_session` 五個 MCP 工具
   * (packages/adapters/src/session-network-mcp.ts 的 in-process 版,與 mcp-bridge-server.ts 的 ACP 版)。
   *
   * ⚠️ **這五個方法只給 scoped MCP bridge token 用**:呼叫者 session 一律由 gateway 從 token 取
   * (`WsGateway.checkScopedGrantAccess()`),**參數裡沒有任何 caller/parent 欄位**——所以 agent 無法冒名
   * 別的 session(送出的 params 若夾帶多餘欄位會被 zod 丟掉)。一般連線(master token/免認證)呼叫會被
   * 拒絕(沒有呼叫者身分可取,fail-closed)。人類操作走 `session.create`/`session.sendPrompt`/
   * `session.forwardMessage`。
   *
   * `agent.listForAgent`:`AgentCatalog.listAvailable()` 的最小摘要(id/label/software/models/
   * defaultModelId/canUseTools),**不含** command/args/env——與 in-process 的
   * `SessionNetworkPort.listAgents()` 共用同一份映射(`AgentCatalog.summarizeAvailable()`)。
   */
  z.object({ ...baseRequest, method: z.literal("agent.listForAgent"), params: z.object({}).default({}) }),
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
  /**
   * 這輪(slash command)新增:查詢一個 session 目前已知的「/指令」清單(見
   * `packages/shared/src/events.ts` 的 `AvailableCommandsEventSchema`)。
   *
   * 比照 `cost.getSummary`(見下方 result schema 註解)而非只靠 `"session-event"`
   * push 頻道——三個後端的指令清單都是「spawn 前後推一次(+ ACP/claude-agent-sdk
   * 偶爾再推)」,SessionManager 端沒有把它寫進 DB,純 push 沒辦法讓「推播當下
   * 沒連上的 client」(app 重啟、開第二個視窗)事後補齊,而叫出 `/` 選單卻永遠
   * 是空清單正好是這個功能唯一的價值所在——這個 pull 方法只負責補齊「UI 開啟
   * 對話框當下」這一刻,之後仍靠既有的 push 事件即時更新。
   */
  z.object({
    ...baseRequest,
    method: z.literal("session.getSlashCommands"),
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
   * async-scribbling-llama.md Phase 7 新增:回覆一筆 `user-dialog-request`
   * (AskUserQuestion 的待答問題)。與上面的 `permission.resolve` 刻意不共用
   * 同一個 method——那是允許/拒絕的權限決策,這是「使用者選了哪個答案」,
   * 語意不同(見 `DialogAnswerSchema` 的完整說明)。**`sessionId` 必須明講**
   * (與 `permission.resolve` 不同,那裡的 `sessionId` 是 Core 端從
   * `PermissionGateway` 的暫存登記反查回來的——`user-dialog-request` 完全不
   * 經過 `PermissionGateway`,沒有那份登記可查,見 apps/core/src/session/
   * session-manager.ts 的 `resolveUserDialog()` 註解)。**不需要加進**
   * `LOCAL_ONLY_METHODS`——回答問題不是「放寬安全罩」的操作,沒有 auto/YOLO
   * 那種語意,遠端一般客戶端本來就該能回答(比照 `permission.resolve` 本身
   * 也不在那份清單裡的既有先例)。
   */
  z.object({
    ...baseRequest,
    method: z.literal("dialog.resolve"),
    params: z.object({ sessionId: z.string(), requestId: z.string(), result: DialogAnswerSchema }),
  }),
  /**
   * S7(auto-mode-and-yolo)L4 §2 新增:切換一個 session 的暫態權限模式
   * (auto/YOLO)。`mode: "auto-accept-all"` 時 Core 會設定 30 分鐘後惰性過期
   * (見 policy-engine_detail.md §6),`mode` 不含 hard-deny 相關語意——auto/
   * YOLO 都不能繞過 hard-deny,只差在是否繞過 config 的 deny-list(見
   * auto-mode-and-yolo_detail.md §2)。
   *
   * ⚠️ 2026-08-25 修訂(見 docs/DECISIONS.md §G):**本機與遠端皆可呼叫**——
   * 已從 `apps/core/src/gateway/ws-gateway.ts` 的 `LOCAL_ONLY_METHODS` 移除。
   * 這是使用者明確決定的翻案(原 F3/C6「遠端不可切 auto/YOLO」),不是疏漏。
   * hard-deny 仍是地板,見下方 `session.setTrueUnrestricted` 才是真正繞過
   * hard-deny 的開關,且需要先有這裡的 `"auto-accept-all"` 當前置條件。
   */
  z.object({
    ...baseRequest,
    method: z.literal("session.setPermissionMode"),
    params: z.object({ sessionId: z.string(), mode: SessionPermissionModeSchema }),
  }),
  /**
   * 2026-08-25 新增(見 docs/DECISIONS.md §G):在 YOLO 之上疊加「真.無限制」
   * ——`enabled:true` 時連 hard-deny 四類(force-push/讀秘密路徑/worktree 外
   * 刪除/非白名單外連)都會被繞過,見 apps/core/src/permissions/
   * policy-engine.ts 的 `decide()` 短路。**本機與遠端皆可呼叫**,這是使用者
   * 明確要求的能力(比照 `session.setPermissionMode`)。Core 端強制檢查:
   * `enabled:true` 時該 session 目前的 `permissionMode` 必須已經是
   * `"auto-accept-all"`,否則拋 `SESSION_TRUE_UNRESTRICTED_REQUIRES_YOLO`——
   * 不能讓呼叫端跳過 YOLO 直接開最高層級,`session.setPermissionMode`
   * 才是唯一能把 mode 帶到 `"auto-accept-all"` 的入口。`enabled:false` 永遠
   * 允許,不檢查前置條件(降級方向不該被擋)。啟用時會觸發稽核記錄與桌面推播
   * (見 apps/core/src/enforcement/notifier.ts 的 `deliverTrueUnrestrictedEnabled()`)。
   */
  z.object({
    ...baseRequest,
    method: z.literal("session.setTrueUnrestricted"),
    params: z.object({ sessionId: z.string(), enabled: z.boolean() }),
  }),
  /**
   * 2026-08-25 新增(見 docs/DECISIONS.md §G):新增一條政策允許清單規則
   * (「權限」設定頁的「單項選擇」功能)。**本機與遠端皆可呼叫**——政策編輯
   * 從這輪起不再是 local-only(見 `GatewayCapabilitiesSchema.canEditPolicy`
   * 修訂)。`params` 用 `PolicyAddRuleInputSchema`(不是 `PolicyRuleSchema`
   * 本身)——`id`/`addedBy`/`addedAt` 一律由 server 端生成/填入,不信任呼叫端
   * 提供的值(見 core-config.ts 該 schema 的說明)。
   */
  z.object({
    ...baseRequest,
    method: z.literal("policy.addRule"),
    params: PolicyAddRuleInputSchema,
  }),
  /**
   * 2026-08-25 新增:刪除一條政策允許清單規則(依 `id`,見 `PolicyRuleSchema.id`
   * 的穩定識別碼說明)。本機與遠端皆可呼叫,理由同 `policy.addRule`。刪除不存在
   * 的 `id` 不是錯誤——回傳 `removed:false`(見下方 `PolicyRemoveRuleResultSchema`),
   * 不拋例外(呼叫端可能剛好與另一個 client 同時操作同一份清單)。
   */
  z.object({
    ...baseRequest,
    method: z.literal("policy.removeRule"),
    params: z.object({ id: z.string() }),
  }),
  /**
   * 2026-08-25 新增:讀取目前完整的政策允許清單。**刻意獨立於**
   * `config.getEffective`(那個方法回傳的 `effective` 是 `WsGateway` 建構當下
   * 就凍結的 snapshot,沒有熱重載——見該方法註解——若權限頁的清單接
   * `config.getEffective`,使用者透過 `policy.addRule`/`removeRule` 改過之後
   * 清單不會更新,除非重啟 core)。這裡改讀
   * `apps/core/src/permissions/policy-engine.ts` 的 `PolicyEngine.getRules()`,
   * 反映的是目前真正在跑的 in-memory 規則陣列,`policy.addRule`/`removeRule`
   * 之後立即可見。`params` 刻意是空物件。
   */
  z.object({ ...baseRequest, method: z.literal("policy.listRules"), params: z.object({}).default({}) }),
  /** `list_sessions` 的 gateway 入口(見上方 `agent.listForAgent` 的說明):**所有** session 的摘要,不含對話內容。 */
  z.object({ ...baseRequest, method: z.literal("session.listForAgent"), params: z.object({}).default({}) }),
  /** `read_session` 的 gateway 入口:`limit` 預設 20、上限 100,每則 content 截斷到 4000 字元。 */
  z.object({
    ...baseRequest,
    method: z.literal("session.readForAgent"),
    params: z.object({ sessionId: z.string().min(1), limit: z.number().int().positive().optional() }),
  }),
  /**
   * `create_session` 的 gateway 入口。參數只有 agent/prompt/model/title/workingDir(`agent` = providerId);
   * 新 session 的 `parentSessionId` 由 core 以 token 綁定的呼叫者帶入(**不是參數**)。`workingDir` 省略時沿用
   * 呼叫者的資料夾。
   */
  z.object({
    ...baseRequest,
    method: z.literal("session.createFromAgent"),
    params: z.object({
      agent: z.string().min(1),
      prompt: z.string().min(1),
      model: z.string().optional(),
      title: z.string().optional(),
      workingDir: z.string().optional(),
    }),
  }),
  /** `send_to_session` 的 gateway 入口:對任一 session(不能是自己)送訊息,信封與鏈預算由 core 處理。 */
  z.object({
    ...baseRequest,
    method: z.literal("session.sendFromAgent"),
    params: z.object({ sessionId: z.string().min(1), message: z.string().min(1) }),
  }),
  /**
   * 2026-10-02(P3):UI 的「轉傳到…」——使用者把某個 session 的一則 assistant 訊息轉給另一個 session
   * (任一 session,不限父子)。目標收到的信封標明「使用者從 session X 轉來」,持久化訊息的
   * `origin.kind === "forward"`。這是**人類操作**:開一條新的訊息鏈(見 SessionManager 的鏈預算說明),
   * 不受先前 agent 間鏈熔斷的影響。
   *
   * 2026-10-03:`text` 就是使用者按下轉傳的那個氣泡**當下畫面上的文字**,core 不再回頭查原訊息(原本的
   * `messageId` 要對上 DB 那一筆,但桌面端串流中的訊息 id 是 adapter 的 messageId、對不上,只能靠內容
   * 比對去猜,ACP 一輪有多個氣泡時會猜錯而轉成整輪文字)。轉傳等同人類自己打字——使用者本來就能複製貼上
   * 任何文字給另一個 session,所以 core 只驗證 source/target 存在、target 可送達、不是轉給自己;不驗證
   * `text` 是不是 `sourceSessionId` 真的說過的話。`note` 是使用者選填的附註,接在 `text` 前面。
   * `text` 上限 `FORWARD_MESSAGE_MAX_CHARS`,超過由 schema 驗證直接拒絕(無效的請求格式)。
   */
  z.object({
    ...baseRequest,
    method: z.literal("session.forwardMessage"),
    params: z.object({
      sourceSessionId: z.string().min(1),
      targetSessionId: z.string().min(1),
      text: z.string().min(1).max(FORWARD_MESSAGE_MAX_CHARS),
      note: z.string().optional(),
    }),
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
   * `getEnabledModels` 回傳空陣列,呼叫端(SessionList/ChatView)
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
   * 「這個後端支不支援繼續」(見
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
  /** 「放棄」——session 標 `closed`(§5.2,同 S3b「回收 ≠ 丟棄」,對話紀錄保留)。
   *  2026-10-02:原本還有 `recovery.rerun`/`recovery.gitStatus`/
   *  `recovery.resolveDirtyWorktree`(任務 worktree 專用),已隨 task 一併移除。 */
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
    /** S11(Notification)新增:升級/熔斷需要帶外通知人類時推播(payload 見
     *  notification.ts 的 `EnforcementNotificationPushSchema`)——Core 是
     *  headless、沒有 Electron API,實際的原生系統通知由 desktop renderer
     *  收到這個 push 後呼叫 `deskmony:notify` IPC,交給 Electron 主行程觸發
     *  (見 apps/desktop/electron/main.ts、notification_detail.md §2.1)。 */
    "enforcement-notification",
    /**
     * 2026-10-02(P3):一則**別的 session 送來的**訊息(`origin` 有值的 user 訊息,見
     * `MessageOriginSchema`)剛被寫進某個 session 的歷史——payload 是 `SessionMessagePushSchema`。
     * 讓正在看那個 session 的 UI 即時顯示「來自 <title>」的訊息(人類自己輸入的訊息不走這條,
     * 桌面端是樂觀回顯)。取代 S12 的 `child-result`(「子完成 → 結果自動注入父」已整個移除)。
     */
    "session-message",
    /**
     * async-scribbling-llama.md Phase 7:一筆 `user-dialog-request` 被解決時
     * 推播給所有 client(payload 是下方 `UserDialogResolvedPushSchema`)——比照
     * `permission-resolved` 的既有理由(讓不是觸發解決的那個 client 也能同步
     * 讓 AskUserQuestionWidget 從 pendingUserDialogs 移除該筆待答狀態)。
     */
    "user-dialog-resolved",
    /**
     * 2026-08-25 新增:`policy.addRule`/`policy.removeRule` 成功後推播給所有
     * client(payload 見下方 `PolicyUpdatedPushSchema`)——讓其他已連線的 client
     * (第二個視窗、或現在也能編輯政策的遠端 client)即時看到允許清單變化,
     * 不用自己重新呼叫 `policy.listRules` 才發現。
     */
    "policy-updated",
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

/**
 * async-scribbling-llama.md Phase 7:`user-dialog-resolved` channel 的
 * payload——結構刻意比 `PermissionResolvedPushSchema` 簡單,**沒有 `source`
 * 欄位**:`permission-request` 有 user/timeout/policy 三種解決來源,但
 * `user-dialog-request` 完全不經過 `PermissionGateway` 的逾時機制、也不經過
 * `PolicyEngine`(見 apps/core/src/session/session-manager.ts 的
 * `consumeEvents()` 內 `"user-dialog-request"` case 註解),唯一的來源就是
 * 某個 client 呼叫了 `dialog.resolve`,不需要區分。
 */
export const UserDialogResolvedPushSchema = z.object({
  sessionId: z.string(),
  requestId: z.string(),
  result: DialogAnswerSchema,
});
export type UserDialogResolvedPush = z.infer<typeof UserDialogResolvedPushSchema>;

/** 2026-08-25 新增:`policy-updated` channel 的 payload。 */
export const PolicyUpdatedPushSchema = z.object({
  action: z.enum(["add", "remove"]),
  rule: PolicyRuleSchema,
});
export type PolicyUpdatedPush = z.infer<typeof PolicyUpdatedPushSchema>;

export const ServerMessageSchema = z.union([ServerResponseSchema, ServerPushSchema]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

// ---- Typed result shapes (used by both core & desktop for narrowing) ----

/**
 * S7(auto-mode-and-yolo)L4 §5.3:握手能力集——**由 Core 依連線本身(loopback
 * 正規化後比對)判定,絕不採信 client 自稱**。隧道連線(Tailscale/WireGuard
 * 等)不是 loopback,視為遠端——這是刻意的,隧道只解決傳輸安全,不代表操作者
 * 在本機(F1)。
 *
 * ⚠️ 2026-08-25 修訂(見 docs/DECISIONS.md §G):`canToggleAuto`/`canEnableYolo`/
 * `canEditPolicy` 三項**不再等於 `isLocal`**,改成恆為 `true`(使用者明確決定
 * 遠端與本機同等)。這裡的欄位
 * **仍然只是 UI 顯示用**,不是安全邊界本身——真正的把關在每次呼叫時 Gateway
 * 的伺服器端檢查(`LOCAL_ONLY_METHODS`、`session.setTrueUnrestricted` 的
 * mode 前置條件),即使這裡回傳的值被竄改,後端也不會因此放行。
 */
export const GatewayCapabilitiesSchema = z.object({
  /** 能否切換 session 的 auto 模式(`session.setPermissionMode` 設成 `"auto-accept-edits"`)。恆 `true`,見上方 2026-08-25 修訂說明。 */
  canToggleAuto: z.boolean(),
  /** 能否啟用 YOLO(`session.setPermissionMode` 設成 `"auto-accept-all"`)。恆 `true`,見上方 2026-08-25 修訂說明。 */
  canEnableYolo: z.boolean(),
  /** 能否編輯 policy 允許清單(`policy.addRule`/`removeRule`)。恆 `true`,見上方 2026-08-25 修訂說明。 */
  canEditPolicy: z.boolean(),
  /**
   * 2026-08-25 新增:能否啟用「真.無限制」層(`session.setTrueUnrestricted`)。
   * 目前恆為 `true`——這個能力沒有連線類型層面的門檻,真正的把關是每次呼叫時
   * 「該 session 是否已經是 `auto-accept-all`」的伺服器端檢查(見
   * `session.setTrueUnrestricted` 的 method 註解)。這個欄位存在只是比照
   * `canEditPolicy` 當初的先例(保留給未來真的需要按連線類型/安裝層級門檻時
   * 用),不代表現在真的有門檻。
   */
  canEnableTrueUnrestricted: z.boolean(),
  /**
   * 2026-08-25 新增:純顯示用——這個連線是否為遠端(`!isLocal`)。**不是**
   * gating 欄位(上面四個 `can*` 欄位才是),這個欄位單純讓 UI 知道要不要在
   * 危險操作的警告文案裡多提醒一句「你正在遠端啟用」。同樣由 Core 依連線本身
   * 判定,絕不採信 client 自稱。
   */
  isRemoteConnection: z.boolean(),
});
export type GatewayCapabilities = z.infer<typeof GatewayCapabilitiesSchema>;

/** `gateway.capabilities` 的回應。 */
export const GatewayCapabilitiesResultSchema = z.object({ capabilities: GatewayCapabilitiesSchema });

/** M5 Round A:`auth` request 的回應(認證成功時)。S7 這輪額外附上握手能力集
 *  (見上方 `GatewayCapabilitiesSchema`),與獨立的 `gateway.capabilities` 方法
 *  回傳相同的值——`auth` 附帶一份是為了少一次往返(client 若剛好會呼叫
 *  `auth`),`gateway.capabilities` 是保證一定能拿到的獨立入口(見該 case 註解)。 */
export const AuthResultSchema = z.object({ ok: z.literal(true), capabilities: GatewayCapabilitiesSchema });

/** P3:`agent.listForAgent` 的回應——見 `ClientRequestSchema` 對應
 *  case 的完整說明(最小揭露子集,不含 command/args/env)。 */
export const AgentListForAgentResultSchema = z.object({ agents: z.array(NetworkAgentSummarySchema) });
export const SessionListResultSchema = z.object({ sessions: z.array(SessionSchema) });
export const SessionCreateResultSchema = z.object({ session: SessionSchema });
export const SessionHistoryResultSchema = z.object({ messages: z.array(MessageRecordSchema) });
/**
 * 這輪(slash command)新增:`session.getSlashCommands` 的回應。**刻意帶
 * `observed` 而非只回一個陣列**——理由同 `UsageBadge` 既有的 `usageSeen`/
 * `contextSeen` 手法(見 `session-store.ts`):「這個 session 還沒收到過任何
 * 一次 `available-commands` 推播」跟「後端已經回報過、清單就是空的」必須是
 * UI 分得清楚的兩種狀態,都顯示成空清單會讓使用者以為這個後端不支援任何指令
 * (即使只是還沒連上、或這一輪根本沒有 skill/自訂 command)。
 */
export const SessionGetSlashCommandsResultSchema = z.object({
  commands: z.array(SlashCommandInfoSchema),
  observed: z.boolean(),
});
export const OkResultSchema = z.object({ ok: z.literal(true) });
/** M5 Round C:`session.setModel` 的回應——回傳更新後的完整 Session,讓呼叫端
 * 不需要等下一次 "session-updated" 推播就能立即拿到新的 `model` 值。 */
export const SessionSetModelResultSchema = z.object({ session: SessionSchema });
/** 比照上面的 `SessionSetModelResultSchema`:`session.setEffort` 的回應。 */
export const SessionSetEffortResultSchema = z.object({ session: SessionSchema });
/** S7:`session.setPermissionMode` 的回應——回傳套用後的模式與(若為 YOLO)
 *  到期時間戳,讓呼叫端不需要再等一次 "session-updated" 推播就能更新 UI。
 *  2026-08-25 新增 `trueUnrestricted`:切換 mode 一定會連帶清掉這個欄位(見
 *  session.ts 的 `Session.trueUnrestricted` 註解),一併回傳讓呼叫端一次拿到
 *  三個欄位,不需要再等 "session-updated" 推播才知道它被清掉了。 */
export const SessionSetPermissionModeResultSchema = z.object({
  mode: SessionPermissionModeSchema,
  yoloExpiresAt: z.number().optional(),
  trueUnrestricted: z.boolean().optional(),
});
/** 2026-08-25 新增:`session.setTrueUnrestricted` 的回應。 */
export const SessionSetTrueUnrestrictedResultSchema = z.object({ trueUnrestricted: z.boolean() });
/** 2026-08-25 新增:`policy.addRule` 的回應——回傳 server 端組好的完整規則
 *  (含生成的 `id`/`addedBy:"user"`/`addedAt`),呼叫端不需要再多一次
 *  `policy.listRules` 往返才知道最終存進去的內容。 */
export const PolicyAddRuleResultSchema = z.object({ rule: PolicyRuleSchema });
/** 2026-08-25 新增:`policy.removeRule` 的回應——`removed:false` 代表這個 id
 *  本來就不存在(不是錯誤,見該 method 的註解);`rule` 只在 `removed:true`
 *  時有值,回傳被刪掉的完整內容供 UI 顯示/undo 提示用。 */
export const PolicyRemoveRuleResultSchema = z.object({ removed: z.boolean(), rule: PolicyRuleSchema.optional() });
/** 2026-08-25 新增:`policy.listRules` 的回應。 */
export const PolicyListRulesResultSchema = z.object({ rules: z.array(PolicyRuleSchema) });
/**
 * `adapter.capabilities` 的回應(M2 Round B):讓 UI 在建立 session 前
 * (依 provider 的 `software`)或拿到 session 之後(依 `Session.adapterType`)
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
  day: RollupSnapshotSchema,
  /** 今天是否已觸發每日 kill-switch(所有 session 的新 prompt 都會被擋下)。 */
  dailyTripped: z.boolean(),
});
export type CostGetSummaryResult = z.infer<typeof CostGetSummaryResultSchema>;

// ---- S6(crash-recovery)result shapes -------------------------------------
export { RecoveryListResultSchema };
/** `recovery.continue` / `recovery.takeover` 都回傳更新後的完整 Session。 */
export const RecoverySessionResultSchema = z.object({ session: SessionSchema });
export const RecoveryAbandonResultSchema = z.object({ ok: z.literal(true) });

export { SessionEventEnvelopeSchema };

// ---- P3(session 網路)result shapes -----------------------------------------
/** `session.listForAgent` 的回應。 */
export const SessionListForAgentResultSchema = z.object({ sessions: z.array(NetworkSessionSummarySchema) });
/** `session.readForAgent` 的回應。 */
export const SessionReadForAgentResultSchema = ReadSessionResultSchema;
/** `session.createFromAgent` 的回應——只回新 session id(`create_session` 工具只需要這個)。 */
export const SessionCreateFromAgentResultSchema = z.object({ sessionId: z.string() });
/** `session.sendFromAgent` / `session.forwardMessage` 的回應。 */
export const SessionSendFromAgentResultSchema = z.object({ ok: z.literal(true) });
export const SessionForwardMessageResultSchema = z.object({ ok: z.literal(true) });

/**
 * `session-message` push 的 payload:別的 session 送來的訊息(`message.origin` 一定有值)剛被寫進
 * `sessionId` 的歷史。見上方 `ServerPushSchema.channel` 的說明。
 */
export const SessionMessagePushSchema = z.object({
  sessionId: z.string(),
  message: MessageRecordSchema,
});
export type SessionMessagePush = z.infer<typeof SessionMessagePushSchema>;
