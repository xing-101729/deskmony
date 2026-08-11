import { z } from "zod";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { RequestReviewOutcome, TeamBusSendOutcome } from "@deskmony/shared";
import type { TeamSpawnContext } from "./types.js";

/**
 * team-bus MCP server(ARCHITECTURE.md 4.1 節):薄薄一層 MCP 工具,實際邏輯
 * 全部委派給注入的 `TeamSpawnContext.bus`(apps/core 的 MessageBus 實作,見
 * README/ARCHITECTURE.md 依賴方向規則:packages/adapters 不得 import
 * apps/core,只依賴 `@deskmony/shared` 的 `TeamBusPort` 介面)。
 *
 * 對接策略(讀取 node_modules 內 `@anthropic-ai/claude-agent-sdk/sdk.d.ts` 確認):
 *  - `createSdkMcpServer({ name, tools })` 回傳 `McpSdkServerConfigWithInstance`
 *    (`{ type: "sdk", name, instance }`),可以直接放進 `Options.mcpServers`
 *    這個 record(`ClaudeAgentSdkAdapter.spawn()` 負責)。
 *  - `tool(name, description, zodRawShape, handler)` 建立單一工具定義,
 *    `handler` 回傳 `Promise<CallToolResult>`(`{ content: [...] }`)。
 *  - MCP 工具的完整名稱是 `mcp__<server>__<tool>`(讀取 sdk.d.ts 對
 *    `disallowedTools`/`toolAliases` 欄位註解確認的命名慣例),
 *    `TEAM_BUS_TOOL_NAMES` 匯出給 `ClaudeAgentSdkAdapter` 組 `allowedTools`,
 *    讓這些內部訊息工具自動略過 canUseTool 權限彈窗(純訊息傳遞,不涉及
 *    檔案/指令執行,不需要人類逐次核可)。
 */
export const TEAM_BUS_MCP_SERVER_NAME = "team-bus";

const TEAM_BUS_TOOL_LOCAL_NAMES = [
  "send_message",
  "broadcast",
  "list_teammates",
  "report_status",
  "request_review",
] as const;

export const TEAM_BUS_TOOL_NAMES = TEAM_BUS_TOOL_LOCAL_NAMES.map(
  (name) => `mcp__${TEAM_BUS_MCP_SERVER_NAME}__${name}`,
);

export function createTeamBusMcpServer(context: TeamSpawnContext): McpSdkServerConfigWithInstance {
  const { bus, teamId, memberId } = context;

  return createSdkMcpServer({
    name: TEAM_BUS_MCP_SERVER_NAME,
    version: "1.0.0",
    instructions:
      "與同一個 team 的隊友互傳訊息:send_message 傳給特定隊友、broadcast 對全隊廣播、" +
      "list_teammates 查詢隊友名單與目前狀態、report_status 回報自己的任務狀態。" +
      "訊息不會立刻打斷對方 —— 對方忙碌時會排隊,回合結束後批次送達;" +
      "priority=\"interrupt\" 只有被授權的角色才有效,否則會自動降級為 normal。",
    tools: [
      tool(
        "send_message",
        '傳送一則訊息給指定隊友(依名稱,例如 "Reviewer")。priority 預設 normal;' +
          "interrupt 只有被授權(canInterrupt)的成員才有效,否則會自動降級為 normal 並在紀錄中標註。",
        {
          to: z.string().min(1).describe("目標隊友的名稱(team member name)"),
          content: z.string().min(1).describe("訊息內容"),
          priority: z.enum(["normal", "interrupt"]).optional().describe('"normal"(預設)或 "interrupt"'),
        },
        async (args) => {
          const outcome = await bus.sendMessage({
            teamId,
            fromMemberId: memberId,
            to: args.to,
            content: args.content,
            priority: args.priority,
          });
          return { content: [{ type: "text" as const, text: summarizeOutcome(outcome) }] };
        },
      ),
      tool(
        "broadcast",
        "對整個 team 廣播一則訊息(自己以外的所有成員)。",
        {
          content: z.string().min(1).describe("廣播內容"),
          priority: z.enum(["normal", "interrupt"]).optional(),
        },
        async (args) => {
          const outcome = await bus.broadcast({
            teamId,
            fromMemberId: memberId,
            content: args.content,
            priority: args.priority,
          });
          return { content: [{ type: "text" as const, text: summarizeOutcome(outcome) }] };
        },
      ),
      tool(
        "list_teammates",
        "查詢目前 team 的隊友名單、角色、canInterrupt 權限、綁定的 agent 軟體與目前 session 狀態。",
        {},
        async () => {
          const teammates = await bus.listTeammates({ teamId, requestingMemberId: memberId });
          return { content: [{ type: "text" as const, text: JSON.stringify(teammates, null, 2) }] };
        },
      ),
      tool(
        "report_status",
        "回報自己目前的任務狀態,寫入 team 訊息紀錄(團隊群聊視圖可見)。" +
          "選填 taskId:若提供且你是該任務的指派人,status 會嘗試對映到任務狀態機" +
          "(backlog/assigned/in-progress/review/merging/done/blocked 或常見同義詞," +
          "例如 reviewing/completed)並同步更新任務狀態;對映不到或不是合法的狀態轉換時" +
          "只會記錄這則訊息,不會更動任務狀態、也不會報錯。不會打斷隊友的 session。",
        {
          status: z.string().min(1).describe("狀態,例如 in-progress / reviewing / done / blocked"),
          summary: z.string().optional().describe("簡短說明"),
          taskId: z.string().optional().describe("選填:要同步更新狀態的任務 id(你必須是該任務的指派人)"),
        },
        async (args) => {
          const message = await bus.reportStatus({
            teamId,
            fromMemberId: memberId,
            status: args.status,
            summary: args.summary,
            taskId: args.taskId,
          });
          return { content: [{ type: "text" as const, text: `狀態已回報: ${message.content}` }] };
        },
      ),
      tool(
        "request_review",
        "請求指定隊友(reviewer)審查你的工作。等同 report_status(status: \"review\") + send_message(reviewer, " +
          '"請審查...") 的組合,但語意明確。選填 taskId:若提供且你是該任務的指派人,會嘗試把任務推進 review ' +
          "狀態(規則與 report_status 相同,對映不到/不是指派人/非法轉換都只記錄訊息、不報錯);審查通過後的" +
          "合併需要人類經任務看板批准(task.merge),你無法透過任何工具自己把任務標記完成。",
        {
          to: z.string().min(1).describe("審查者(reviewer)的隊友名稱"),
          taskId: z.string().optional().describe("選填:要推進到 review 狀態的任務 id(你必須是該任務的指派人)"),
        },
        async (args) => {
          const outcome = await bus.requestReview({
            teamId,
            fromMemberId: memberId,
            to: args.to,
            taskId: args.taskId,
          });
          return { content: [{ type: "text" as const, text: summarizeReviewOutcome(outcome) }] };
        },
      ),
    ],
  });
}

function summarizeOutcome(outcome: TeamBusSendOutcome): string {
  const deliveryLabel =
    outcome.delivered === "immediate"
      ? "已立即送達(對方目前 idle 或已 interrupt)"
      : outcome.delivered === "queued"
        ? "已排入對方 mailbox(對方目前忙碌,回合結束後會批次收到)"
        : "對方目前沒有活躍 session,已留在 mailbox,等對方 session 建立後補投";
  const downgradeLabel = outcome.downgraded ? "(注意:interrupt 權限不足,已自動降級為 normal)" : "";
  return `訊息已送出(id=${outcome.message.id})。收件對象: ${outcome.message.to}。投遞狀態: ${deliveryLabel}${downgradeLabel}`;
}

function summarizeReviewOutcome(outcome: RequestReviewOutcome): string {
  const taskLabel = outcome.taskUpdated
    ? `任務狀態已同步: ${outcome.taskFromStatus} → ${outcome.taskToStatus}`
    : `任務狀態未同步: ${outcome.taskSkippedReason ?? "(未帶 taskId)"}`;
  return `${summarizeOutcome(outcome)}。${taskLabel}`;
}
