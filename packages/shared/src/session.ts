import { z } from "zod";
import { AgentSoftwareSchema, EffortLevelSchema, SessionPermissionModeSchema } from "./agent-launch.js";
import { PromptAttachmentSchema } from "./prompt.js";

/**
 * Session 狀態機:idle / busy / waiting(等待權限回覆) / error。
 * 對應 ARCHITECTURE.md 3.3 節 SessionManager 與第 6 節 ERD SESSION.status。
 *
 * S6(crash-recovery)新增兩個**終態**(見
 * docs/LAYER-4-detail-design/crash-recovery_detail.md §1):
 *   - `closed`:優雅關閉時主動標記(見 apps/core/src/session/
 *     session-manager.ts 的 `shutdownAll()`)——啟動對帳據此判斷「這不是崩潰」。
 *   - `interrupted`:啟動對帳(`reconcileOnStartup()`)發現的孤兒——子程序已隨
 *     core 消失,等人在復原視圖分流(繼續/接手/放棄)。
 */
export const SessionStatusSchema = z.enum(["idle", "busy", "waiting", "error", "closed", "interrupted"]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

/**
 * 2026-10-06:標題從哪來(三態的完整語意見 session-title.ts 檔頭)。`user` 之後 AI 絕不自動覆蓋。
 */
export const SessionTitleSourceSchema = z.enum(["default", "auto", "user"]);
export type SessionTitleSource = z.infer<typeof SessionTitleSourceSchema>;

/** `session.autoTitle` 實際用的命名方式:`agent` = session 自己的 agent 在臨時對話裡產生;`fallback` = 截取第一則訊息的第一行。 */
export const SessionTitleMethodSchema = z.enum(["agent", "fallback"]);
export type SessionTitleMethod = z.infer<typeof SessionTitleMethodSchema>;

export const SessionSchema = z.object({
  id: z.string(),
  title: z.string().default("新對話"),
  /**
   * 2026-10-06:標題來源(見 `SessionTitleSourceSchema`)。舊資料由 packages/db/src/client.ts 的啟動遷移回填:
   * 標題是「新對話」→ `default`,其他 → `user`(不知道當年是誰取的,一律當成使用者取的、不自動覆蓋)。
   */
  titleSource: SessionTitleSourceSchema.default("default"),
  /**
   * 2026-10-02(P2:移除 profile):這個 session 是用哪個 provider 目錄項目
   * (`ProviderCatalogEntry.id`,例如 "claude-agent-sdk"、"codex"、"opencode")建立的。
   * 取代過去的 `agentProfileId`。舊 session 由 `packages/db/src/client.ts` 的啟動遷移回填:
   * 能對應到 profile 的用 profile 的 providerId,否則是 `"claude-agent-sdk"`
   * (software 為 claude-agent-sdk)、`"legacy-<software>"`,或找不到 profile 時的
   * `"legacy-unknown"`——這些 `legacy-*` 值不在 provider 目錄裡,UI 顯示時直接當成
   * 標籤文字、續接時退回 session 自己存的 `launch_command`/`launch_args`。
   */
  providerId: z.string(),
  adapterType: AgentSoftwareSchema,
  status: SessionStatusSchema,
  workingDir: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  lastError: z.string().optional(),
  /**
   * session 級別的 model(M5 Round C:對話中切換 model)。建立時取自
   * `CreateSessionInput.model`(沒給時用 provider 明確標記 `isDefault` 的 model,
   * 都沒有就維持 undefined,見 `AgentCatalog.buildLaunchSpec()`);之後可透過
   * `session.setModel` gateway 方法變更,`adapterType === "claude-agent-sdk"`
   * 與 `"opencode"` 的 session 支援(見 packages/adapters/src/types.ts 的
   * `AgentAdapter.setModel()` 介面註解——兩者實作方式不同:前者呼叫 SDK
   * 官方的 `Query.setModel()`,後者是 adapter 內部的 session 覆寫,下一則
   * 訊息才真正生效)。acp/pty session 呼叫這個方法會得到明確錯誤。這個欄位
   * 可能是 `undefined`(建立時沒指定 model、由 agent 自己決定)—— UI 應標示
   * 「(由 agent 管理)」。
   */
  model: z.string().optional(),
  /**
   * session 級別的 effort(思考程度),比照上面的 `model` 欄位。建立時取自
   * `CreateSessionInput.effort`(見 `SessionManager.createSession()`);之後可
   * 透過 `session.setEffort` gateway 方法變更,只有 `adapterType ===
   * "claude-agent-sdk"` 的 session 支援(見 packages/adapters/src/types.ts 的
   * `AgentAdapter.setEffort()` 介面註解——呼叫 SDK 的
   * `Query.applyFlagSettings({ effortLevel })`)。其餘 adapter(含 opencode)
   * 呼叫這個方法會得到明確錯誤。這個欄位可能是 `undefined` —— UI 應視為
   * 「(未指定,使用 CLI 預設)」。
   */
  effort: EffortLevelSchema.optional(),
  /**
   * S7(auto-mode-and-yolo):這個 session 目前的權限模式(auto/YOLO)——**純
   * ephemeral**,只存在 `SessionManager` 記憶體(見 apps/core/src/session/
   * session-manager.ts 的 `SessionPermissionState`),不落地 DB,`sessionToRow()`/
   * `rowToSession()` 完全不碰這兩個欄位,`SessionManager` 在每次回傳 Session
   * 物件前才即時補上(見該檔案的 `attachPermissionState()`)。省略/undefined
   * 理論上不會出現(SessionManager 一律補上),UI 若真的收到 undefined 應視為
   * `"always-ask"`,不要顯示任何 auto/YOLO 標記。
   */
  permissionMode: SessionPermissionModeSchema.optional(),
  /** 只有 `permissionMode === "auto-accept-all"` 時有值:YOLO 到期時間戳
   *  (epoch ms)——過了這個時間,下一次權限決策前的惰性檢查會自動回落
   *  `"always-ask"`(見 policy-engine_detail.md §6:惰性檢查,不用計時器)。 */
  yoloExpiresAt: z.number().optional(),
  /**
   * 2026-08-25 新增(見 docs/DECISIONS.md §G):疊在 YOLO 之上的「真.無限制」
   * 層——開啟時連 hard-deny 四類(force-push/讀秘密路徑/worktree 外刪除/
   * 非白名單外連)都會被繞過。跟 `permissionMode`/`yoloExpiresAt` 同一個
   * ephemeral 待遇:只存 `SessionManager` 記憶體,不落地 DB,`SessionManager`
   * 在每次回傳 Session 物件前即時補上。只有 `permissionMode ===
   * "auto-accept-all"` 時可能為 `true`——mode 降級(含 YOLO 30 分鐘惰性到期)
   * 會連帶清掉這個欄位,見 session-manager.ts 的 `checkAndExpireYolo()`/
   * `setSessionPermissionMode()` 都建構全新 state 物件,不沿用舊值。
   */
  trueUnrestricted: z.boolean().optional(),
  /**
   * S6(crash-recovery)新增:對帳標記的時間(epoch ms)——只有
   * `status === "interrupted"` 時有意義,見 crash-recovery_detail.md §1。
   */
  interruptedAt: z.number().optional(),
  /**
   * S6 新增:這個 session 最後一次狀態變更的時間戳(epoch ms)——每次
   * `SessionManager.setStatus()` 都會更新,供復原視圖顯示「中斷前最後活動」
   * (crash-recovery_detail.md §1)。與既有的 `updatedAt` 目前總是同值,獨立
   * 拉出這個欄位是為了讓語意明確(`updatedAt` 是通用時間戳,`lastSeenAt` 專門
   * 給復原視圖用,未來若 `updatedAt` 的用途擴大也不會互相牽動)。
   */
  lastSeenAt: z.number().optional(),
  /**
   * S6 新增(§4.1 查證後的實作):後端自己的持久化 session 識別碼——只有
   * `adapterType === "claude-agent-sdk"` 會填(見
   * packages/adapters/src/claude-sdk-adapter.ts 對 `@anthropic-ai/
   * claude-agent-sdk` 的 `resume` 選項查證),用於「繼續(保有記憶)」時重連
   * 磁碟持久化的既有 session。ACP/OpenCode/PTY 這個欄位恆為 undefined(見
   * crash-recovery_detail.md §4.1 表格的查證結論——不可猜,查不到就不承諾)。
   */
  backendSessionId: z.string().optional(),
  /**
   * 這個 session 是從哪個 session 底下開出來的(`create_session` 工具,或使用者在畫面上
   * 從某個 session 底下開新 session)——**只用於 UI 巢狀顯示與溯源**,不代表任何權限或
   * 回報關係(2026-10-02 P3:所有 session 互相可見、互相可傳訊息,不限父子)。根 session 為 undefined。
   */
  parentSessionId: z.string().optional(),
});
export type Session = z.infer<typeof SessionSchema>;

/**
 * 2026-10-02(P2:移除 profile):session 直接以「偵測到的 agent(providerId)+
 * model」建立,不再有 `agentProfileId`/`agentOverride`(`AgentOverrideSchema` 已整個
 * 移除)。啟動資訊(command/args)由 core 的 `AgentCatalog.buildLaunchSpec()` 依
 * `providerId` 組出——**gateway 不接受任何 command/args 參數**,否則等於遠端可執行
 * 任意程式。
 */
export const CreateSessionInputSchema = z.object({
  /** `BUILTIN_PROVIDERS` 的 id(例如 "claude-agent-sdk"、"codex"、"opencode")。 */
  providerId: z.string().min(1),
  /** 省略時用該 provider 明確標記 `isDefault` 的 model;都沒有就由 agent 自己決定。 */
  model: z.string().optional(),
  /** 只有 claude-agent-sdk 有意義(見 `EffortLevelSchema` 註解)。 */
  effort: EffortLevelSchema.optional(),
  workingDir: z.string(),
  /** 明確給了(非空白)標題 → `titleSource: "user"`,不會自動命名;省略 → 預設標題,第一則人類輸入後自動命名。 */
  title: z.string().optional(),
  /**
   * 掛在哪個 session 底下顯示(UI 巢狀 + 溯源,見 `Session.parentSessionId`)。使用者從畫面
   * 「在這個 session 底下開新 session」時帶入;agent 用 `create_session` 建立時由 core 以呼叫者
   * 身分帶入(不是工具參數)。(2026-10-02:原本還有 `teamMemberId`——team 已移除,見 DECISIONS §H。)
   */
  parentSessionId: z.string().optional(),
});
export type CreateSessionInput = z.infer<typeof CreateSessionInputSchema>;

/**
 * 訊息角色與持久化訊息紀錄(對應 ERD MESSAGE,單一 session 內的
 * user/assistant/system/tool 對話紀錄)。
 */
export const MessageRoleSchema = z.enum(["user", "assistant", "system", "tool"]);
export type MessageRole = z.infer<typeof MessageRoleSchema>;

/**
 * 2026-10-02(P3:session 網路,見 docs/LAYER-4-detail-design/simplify-agents-sessions_detail.md §P3.2):
 * 一則 user 訊息的**來源標記**——這則訊息不是人類在這個 session 的輸入框打的,而是別的 session 送來的。
 *   - `session`:別的 session 的 agent 用 `send_to_session` / `create_session` 送來的。
 *   - `forward`:使用者在畫面上把別的 session 的某則 assistant 訊息「轉傳到…」過來的。
 * `sessionId`/`title` 是**送出方**(快照:title 是送出當下的標題,送出方之後改名或被刪除不影響顯示);
 * `chainId` 是這則訊息所屬的訊息鏈(只用於鏈預算斷路器與除錯,見 SessionManager)。
 *
 * ⚠️ **只有 core 能設這個欄位**:`session.sendPrompt` 的 schema 不收 `origin`/`chainId`,gateway 的任何 client
 * 都不能偽造「這是別的 session 送來的」(否則人類輸入可以假冒成 agent 訊息、也能指定鏈 id 繞過鏈預算)。
 */
export const MessageOriginSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("session"), sessionId: z.string(), title: z.string(), chainId: z.string() }),
  z.object({ kind: z.literal("forward"), sessionId: z.string(), title: z.string(), chainId: z.string() }),
]);
export type MessageOrigin = z.infer<typeof MessageOriginSchema>;

export const MessageRecordSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  role: MessageRoleSchema,
  /**
   * 對 `role === "user"` 且有 `origin` 的訊息,這裡存的是**原始 message 本體**(送出方寫的內容),
   * 不含給 agent 看的信封樣板文字——信封只在送進 adapter 那一刻才組裝(見 SessionManager)。
   */
  content: z.string(),
  createdAt: z.number(),
  /** 見 `MessageOriginSchema`。人類在這個 session 輸入的訊息、assistant/system/tool 訊息沒有這個欄位。 */
  origin: MessageOriginSchema.optional(),
  /**
   * async-scribbling-llama.md Phase 6:使用者傳送訊息時夾帶的圖片(只有
   * `role === "user"` 的紀錄可能有值)。持久化在獨立的 `messages.attachments`
   * TEXT 欄位(JSON 陣列),不塞進既有的 `content`——那個欄位對 user 訊息就是
   * 純文字 `prompt.text`,混進附件需要靠內容嗅探才能分辨,見
   * packages/db/src/schema.ts 的 `messages.attachments` 欄位註解與
   * packages/db/src/client.ts 的 `ensureMessagesAttachmentsColumn()`。
   */
  attachments: z.array(PromptAttachmentSchema).optional(),
});
export type MessageRecord = z.infer<typeof MessageRecordSchema>;
