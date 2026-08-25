import { z } from "zod";
import { AgentSoftwareSchema, EffortLevelSchema, SessionPermissionModeSchema } from "./agent-profile.js";
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
 *     core 消失,等人在復原視圖分流(繼續/接手/重跑/放棄)。
 */
export const SessionStatusSchema = z.enum(["idle", "busy", "waiting", "error", "closed", "interrupted"]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const SessionSchema = z.object({
  id: z.string(),
  title: z.string().default("新對話"),
  agentProfileId: z.string(),
  adapterType: AgentSoftwareSchema,
  status: SessionStatusSchema,
  workingDir: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  lastError: z.string().optional(),
  /**
   * session 級別的 model 覆寫(M5 Round C:對話中切換 model)。建立時預設取自
   * `AgentProfile.model`(見 `SessionManager.createSession()`);之後可透過
   * `session.setModel` gateway 方法變更,`adapterType === "claude-agent-sdk"`
   * 與 `"opencode"` 的 session 支援(見 packages/adapters/src/types.ts 的
   * `AgentAdapter.setModel()` 介面註解——兩者實作方式不同:前者呼叫 SDK
   * 官方的 `Query.setModel()`,後者是 adapter 內部的 session 覆寫,下一則
   * 訊息才真正生效)。acp/pty session 呼叫這個方法會得到明確錯誤。舊 session
   * (建立於這個欄位存在之前)這個欄位可能是 `undefined` —— UI 應 fallback
   * 顯示 profile 的 model,或標示「(由 agent 管理)」。
   */
  model: z.string().optional(),
  /**
   * session 級別的 effort(思考程度)覆寫,比照上面的 `model` 欄位。建立時預設
   * 取自 `AgentProfile.effort`(見 `SessionManager.createSession()`);之後可
   * 透過 `session.setEffort` gateway 方法變更,只有 `adapterType ===
   * "claude-agent-sdk"` 的 session 支援(見 packages/adapters/src/types.ts 的
   * `AgentAdapter.setEffort()` 介面註解——呼叫 SDK 的
   * `Query.applyFlagSettings({ effortLevel })`)。其餘 adapter(含 opencode)
   * 呼叫這個方法會得到明確錯誤。舊 session(建立於這個欄位存在之前)這個欄位
   * 可能是 `undefined` —— UI 應 fallback 顯示 profile 的 effort,或視為
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
   * S12(session-subagent):這個 session 的 parent session id——只有
   * 子 session(subagent)有值,根 session 為 undefined。
   */
  parentSessionId: z.string().optional(),
});
export type Session = z.infer<typeof SessionSchema>;

/**
 * 這輪新增:建立 session 時,除了套用 agentProfile,也能就這一次建立臨時
 * 覆寫要用的 agent software/model——不落地成新的 AgentProfile 記錄(profile
 * 本身還是 permissionLevel/systemPrompt/env/workingDir 的權威來源),純粹是
 * 「這次 spawn 用這個 software/model 而不是 profile 原本設定的那個」。
 *
 * 語意刻意設計成「部分覆寫、以 software 是否提供分流」(見
 * apps/core/src/session/session-manager.ts 的 `applyAgentOverride()`):
 *   - 只給 `model`(省略 `software`):software/command/args 全部沿用
 *     profile 原本的設定,只換 model——對應 UI「不換 agent,只想換個更省成本
 *     的 model」這個最常見的情境。
 *   - 給了 `software`:整批取代該 software 對應的 config(acpConfig/
 *     ptyConfig/opencodeConfig 三選一,其餘設回 undefined,不與 profile 原本
 *     的舊 config 混用)——`command`/`args` 由前端從 `resolveProviders()`
 *     解析出的已知(已偵測到、免手動輸入)provider 帶入,見
 *     apps/desktop/src/lib/agent-override.ts 的 `buildAgentOverride()`。
 */
export const AgentOverrideSchema = z.object({
  software: AgentSoftwareSchema.optional(),
  /** 對應 ProviderCatalogEntry.id,純中繼資訊(顯示/env 查找用),不影響 spawn。 */
  providerId: z.string().optional(),
  /** 只在提供 `software` 時有意義(claude-agent-sdk 不需要 command)。 */
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  model: z.string().optional(),
  effort: EffortLevelSchema.optional(),
});
export type AgentOverride = z.infer<typeof AgentOverrideSchema>;

export const CreateSessionInputSchema = z.object({
  title: z.string().optional(),
  agentProfileId: z.string(),
  workingDir: z.string(),
  /**
   * M3 Round A:若這個 session 屬於某個 team 的成員,傳入該 TeamMember.id ——
   * `SessionManager.createSession()` 會依此向 TeamManager 查出 team/member
   * 資訊,建立 session 時把 team context 傳給 adapter.spawn()(目前只有
   * `ClaudeAgentSdkAdapter` 會據此掛載 team-bus MCP 工具,見
   * packages/adapters/src/team-bus-mcp.ts),並讓 MessageBus 能把這個
   * session 登記為該成員的投遞目標。
   */
  teamMemberId: z.string().optional(),
  /**
   * S12(session-subagent):建立子 session 時帶入 parent session id。
   */
  parentSessionId: z.string().optional(),
  /** 見 `AgentOverrideSchema` 註解。 */
  agentOverride: AgentOverrideSchema.optional(),
});
export type CreateSessionInput = z.infer<typeof CreateSessionInputSchema>;

/**
 * S12(session-subagent):spawn child session 的輸入參數。
 * parentSessionId 與 agentProfileId 為必填,其餘選填;child 的 adapter
 * 取自 agentProfile 的 software。
 */
export const SpawnChildSessionInputSchema = z.object({
  parentSessionId: z.string(),
  agentProfileId: z.string(),
  /** 省略時沿用父 session 的 workingDir。 */
  workingDir: z.string().optional(),
  title: z.string().optional(),
  /** 建立子 session 後立即送出的第一段 prompt（子 agent 的任務）。 */
  prompt: z.string().min(1),
  /** 見 `AgentOverrideSchema` 註解。 */
  agentOverride: AgentOverrideSchema.optional(),
});
export type SpawnChildSessionInput = z.infer<typeof SpawnChildSessionInputSchema>;

/**
 * 訊息角色與持久化訊息紀錄(對應 ERD MESSAGE,M1 簡化為單一 session 內的
 * user/assistant/system 對話紀錄,不含跨 agent 傳訊 - 那是 M3 MessageBus 的範疇)。
 */
export const MessageRoleSchema = z.enum(["user", "assistant", "system", "tool"]);
export type MessageRole = z.infer<typeof MessageRoleSchema>;

export const MessageRecordSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  role: MessageRoleSchema,
  content: z.string(),
  createdAt: z.number(),
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
