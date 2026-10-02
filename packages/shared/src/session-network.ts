import { z } from "zod";
import { MessageOriginSchema, MessageRoleSchema, SessionStatusSchema } from "./session.js";

/**
 * session-network.ts(2026-10-02,P3「session 網路」新增,取代 S12 的 `subagent.ts`;見
 * docs/LAYER-4-detail-design/simplify-agents-sessions_detail.md §P3、docs/DECISIONS.md §H)。
 *
 * 每個能掛工具的 session(claude-agent-sdk、acp)都有五個工具(MCP server 名稱 `deskmony`):
 * `list_agents` / `list_sessions` / `read_session` / `create_session` / `send_to_session`。
 * 這裡定義:
 *   - `SessionNetworkPort`:讓 `packages/adapters` 的 in-process MCP 工具(`session-network-mcp.ts`)能請
 *     core 做事,而不需要 import `apps/core`(依賴方向規則:packages/* 不得 import apps/*)。實例由
 *     `apps/core/src/index.ts` 注入。ACP 那邊走 `mcp-bridge-server.ts` → gateway 的五個 `*ForAgent`/
 *     `*FromAgent` 方法,回應形狀用下面的 zod schema 在 runtime 解析。
 *   - 五個工具回傳資料的形狀(`Network*Summary`)。
 *
 * **呼叫者身分(`callerSessionId`)永遠不是工具參數**:in-process 由 adapter 以自己的 handle.id 閉包捕捉,
 * ACP 由 bridge token 綁定(gateway 從 token 取,方法參數不收)——agent 無法冒名別的 session。
 */
export interface SessionNetworkPort {
  /** `list_agents`:`AgentCatalog.listAvailable()` 的最小摘要(不含 command/args/env)。 */
  listAgents(): Promise<NetworkAgentSummary[]>;

  /** `list_sessions`:**所有** session(不限父子、不限工作目錄),不含對話內容。`isYou` 標出呼叫者自己。 */
  listSessions(input: { callerSessionId: string }): Promise<NetworkSessionSummary[]>;

  /** `read_session`:目標 session 最近 `limit` 則訊息(預設 20、上限 100),每則 content 截斷到 4000 字元。 */
  readSession(input: { callerSessionId: string; sessionId: string; limit?: number }): Promise<ReadSessionResult>;

  /**
   * `create_session`:建一個新 session(`parentSessionId` = 呼叫者,只為 UI 巢狀顯示與溯源),並把 `prompt`
   * 以信封送出。`workingDir` 省略時沿用呼叫者的。回傳新 session id。
   */
  createSession(input: {
    callerSessionId: string;
    agent: string;
    prompt: string;
    model?: string;
    title?: string;
    workingDir?: string;
  }): Promise<{ sessionId: string }>;

  /**
   * `send_to_session`:對任一 session(不能是自己)送訊息,以信封包裝。目標 idle 立刻送;busy/waiting 排進佇列。
   * 目標不存在 / closed / error / runtime 不在 → 丟明確錯誤,不假裝成功。**不會有任何自動回送**——收到的
   * agent 自己決定要不要回、回給誰。
   */
  sendToSession(input: { callerSessionId: string; sessionId: string; message: string }): Promise<void>;
}

/**
 * 這個 software 的 session 能不能掛 MCP 工具、主動傳訊息?只有 `claude-agent-sdk`(in-process MCP)與 `acp`
 * (mcp-bridge 子行程)能;OpenCode(HTTP adapter 沒有掛 MCP,見 simplify-agents-sessions_detail.md「不做」)與 PTY 只能**收**。
 * `list_agents`/`list_sessions` 的 `canUseTools` 就是這個值。
 */
export function softwareCanUseTools(software: string): boolean {
  return software === "claude-agent-sdk" || software === "acp";
}

/** `read_session` 的預設/上限則數,與每則 content 的字元上限。in-process 與 gateway 兩條路徑共用。 */
export const READ_SESSION_DEFAULT_LIMIT = 20;
export const READ_SESSION_MAX_LIMIT = 100;
export const READ_SESSION_MAX_CONTENT_CHARS = 4000;

/**
 * `list_agents` 的一筆。`canUseTools` = software 是 `claude-agent-sdk` 或 `acp`(只有這兩種能掛 MCP 工具、
 * 能主動傳訊息;OpenCode(HTTP)與 PTY 只能**收**訊息,回不了話——agent 看到 false 就知道對方不會主動回覆)。
 */
export const NetworkAgentSummarySchema = z.object({
  /** providerId——`create_session` 的 `agent` 參數就是填這個值。 */
  id: z.string(),
  label: z.string(),
  software: z.string(),
  models: z.array(z.object({ id: z.string(), label: z.string() })),
  defaultModelId: z.string().optional(),
  canUseTools: z.boolean(),
});
export type NetworkAgentSummary = z.infer<typeof NetworkAgentSummarySchema>;

/** `list_sessions` 的一筆。不含對話內容(要看用 `read_session`)。 */
export const NetworkSessionSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  providerId: z.string(),
  /** providerId 對應的顯示名稱(找不到時就是 providerId 本身)。 */
  agentLabel: z.string(),
  model: z.string().optional(),
  status: SessionStatusSchema,
  workingDir: z.string(),
  parentSessionId: z.string().optional(),
  /** 這筆就是呼叫者自己。 */
  isYou: z.boolean(),
  /** 同 `NetworkAgentSummary.canUseTools`:false = 它收得到訊息但回不了話。 */
  canUseTools: z.boolean(),
});
export type NetworkSessionSummary = z.infer<typeof NetworkSessionSummarySchema>;

/** `read_session` 的一則訊息。content 超過上限會被截斷並標註(`truncated: true` + 內文結尾的說明)。 */
export const NetworkMessageSummarySchema = z.object({
  role: MessageRoleSchema,
  content: z.string(),
  createdAt: z.number(),
  origin: MessageOriginSchema.optional(),
  truncated: z.boolean().optional(),
  /** 這則訊息夾帶了附件——**不回傳附件的二進位內容**,只標示有附件。 */
  hasAttachments: z.boolean().optional(),
});
export type NetworkMessageSummary = z.infer<typeof NetworkMessageSummarySchema>;

export const ReadSessionResultSchema = z.object({
  sessionId: z.string(),
  title: z.string(),
  /** 由舊到新,最多 `limit` 則。 */
  messages: z.array(NetworkMessageSummarySchema),
});
export type ReadSessionResult = z.infer<typeof ReadSessionResultSchema>;
