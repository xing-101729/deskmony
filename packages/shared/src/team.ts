import { z } from "zod";

/**
 * Team / TeamMember / TeamMessage(M3 Round A 新增)。
 * 對應 ARCHITECTURE.md 3.3 節 TeamManager、第 4 節「Agent 互相傳訊機制」、
 * 第 6 節 ERD(TEAM / AGENT_PROFILE / MESSAGE)。
 *
 * 設計取捨:
 *  - `TeamMember` 引用既有的 `AgentProfile`(透過 `agentProfileId`),不重複
 *    儲存 software/model 等設定 —— 同一個 profile 理論上可以被多個 team
 *    member 引用(例如同一顆 Claude Code profile 在不同 team 各自扮演不同
 *    角色)。`name`/`role` 是這個 team 情境下的顯示名稱與角色(預設沿用
 *    profile 的 name/role,但可覆寫),`name` 是 @mention 與 MessageBus
 *    投遞目標比對用的識別字串,同一個 team 內必須唯一。
 *  - `canInterrupt` 決定這個成員送出 priority="interrupt" 的訊息時是否真的
 *    會觸發 adapter.interrupt() +立即注入,而不是被降級為 normal(見
 *    ARCHITECTURE.md 4.2 節、apps/core/src/bus/message-bus.ts)。
 */
export const TeamSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  /** 選填:團隊預設工作目錄,供之後建立成員 session 時參考(非強制)。 */
  workingDir: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Team = z.infer<typeof TeamSchema>;

export const CreateTeamInputSchema = z.object({
  name: z.string().min(1),
  workingDir: z.string().optional(),
});
export type CreateTeamInput = z.infer<typeof CreateTeamInputSchema>;

/**
 * S8(agent-lifecycle):`persistent` = 長命(為了「在線可達」,不是為了記憶,
 * 見 docs/LAYER-3-hld/agent-lifecycle_hld.md §2.0);`ephemeral` = 隨任務生滅。
 * 預設由 role 推導(見下方 `deriveLifecycleFromRole()`),可明確覆寫。
 */
export const LifecycleSchema = z.enum(["persistent", "ephemeral"]);
export type Lifecycle = z.infer<typeof LifecycleSchema>;

/**
 * S8 L4 §1.1:role 含這些關鍵字(不分大小寫)→ 推導為 `persistent`(協調者
 * 必須隨時能回應隊友);其餘 → `ephemeral`(純執行的 task worker)。這是
 * **預設值**,`AddTeamMemberInput.lifecycle` 明確提供時一律優先採用。
 */
const PERSISTENT_ROLE_KEYWORDS = ["lead", "pm", "架構", "協調"];

export function deriveLifecycleFromRole(role: string): Lifecycle {
  const lower = role.toLowerCase();
  return PERSISTENT_ROLE_KEYWORDS.some((keyword) => lower.includes(keyword.toLowerCase()))
    ? "persistent"
    : "ephemeral";
}

export const TeamMemberSchema = z.object({
  id: z.string(),
  teamId: z.string(),
  agentProfileId: z.string(),
  /** team 內唯一的顯示名稱,MessageBus 用它比對 send_message(to) 與 @mention。 */
  name: z.string().min(1),
  role: z.string().min(1),
  canInterrupt: z.boolean().default(false),
  /** S8(agent-lifecycle):見上方 `LifecycleSchema` 註解。`.default("ephemeral")`
   *  只是 zod parse 的保底值(理論上 TeamManager.addMember() 一律會明確算出
   *  這個值,不依賴這裡的 default 生效,見 team-manager.ts)。 */
  lifecycle: LifecycleSchema.default("ephemeral"),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type TeamMember = z.infer<typeof TeamMemberSchema>;

export const AddTeamMemberInputSchema = z.object({
  teamId: z.string(),
  agentProfileId: z.string(),
  /** 未提供時預設沿用對應 AgentProfile 的 name。 */
  name: z.string().min(1).optional(),
  /** 未提供時預設沿用對應 AgentProfile 的 role。 */
  role: z.string().min(1).optional(),
  canInterrupt: z.boolean().optional(),
  /** S8:未提供時由 `deriveLifecycleFromRole(role)` 推導(見 team-manager.ts 的 addMember())。 */
  lifecycle: LifecycleSchema.optional(),
});
export type AddTeamMemberInput = z.infer<typeof AddTeamMemberInputSchema>;

export const TeamWithMembersSchema = TeamSchema.extend({
  members: z.array(TeamMemberSchema),
});
export type TeamWithMembers = z.infer<typeof TeamWithMembersSchema>;

/** 對應 ARCHITECTURE.md 4.2 節投遞策略:normal 排隊/立即注入,interrupt 需 canInterrupt 授權。 */
export const MessagePrioritySchema = z.enum(["normal", "interrupt"]);
export type MessagePriority = z.infer<typeof MessagePrioritySchema>;

/** 訊息來源:agent 主動呼叫 team-bus MCP 工具、或 human 透過群聊插話(message.send)。 */
export const MessageSourceSchema = z.enum(["agent", "human"]);
export type MessageSource = z.infer<typeof MessageSourceSchema>;

export const TeamMessageSchema = z.object({
  id: z.string(),
  teamId: z.string(),
  /** 發送者的 team member 名稱,或人類插話時的自訂名稱(預設 "Human")。 */
  from: z.string(),
  /** 發送者的角色標籤,純粹用於注入 prompt 時的顯示(「來自 @X(角色)的訊息」),
   *  人類插話時通常是 "人類" 或未設定。 */
  fromRole: z.string().optional(),
  /** 目標成員名稱,或 "broadcast"。 */
  to: z.string(),
  content: z.string(),
  priority: MessagePrioritySchema,
  timestamp: z.number(),
  source: MessageSourceSchema,
  /** 系統標註,例如 interrupt 權限不足被自動降級為 normal 時的說明文字。 */
  note: z.string().optional(),
  /**
   * S2(message-budget):這則訊息所屬的 task context id——agent 發送的訊息
   * (`sendMessage`/`broadcast`/`requestReview`)由 Core 依發送者當下綁定的
   * 任務自動推導,agent 無法指定(見 apps/core/src/bus/message-bus.ts 的
   * `deriveContextId()`)。`"legacy"` = 遷移前的舊資料,或 human/report_status
   * 這類不參與訊息預算計算的訊息(見 message-budget_detail.md §2)。
   */
  contextId: z.string(),
  /** S2:null/undefined = 尚未送達(Mailbox 中的權威狀態,見
   *  message-budget_detail.md §5)。有值 = 已成功注入該 session 的時間戳。 */
  deliveredAt: z.number().optional(),
});
export type TeamMessage = z.infer<typeof TeamMessageSchema>;
