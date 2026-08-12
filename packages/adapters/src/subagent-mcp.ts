import { z } from "zod";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { SubagentPort } from "@deskmony/shared";

export const SUBAGENT_MCP_SERVER_NAME = "subagent";

const SUBAGENT_TOOL_LOCAL_NAMES = ["spawn_subagent", "send_to_subagent", "list_subagents", "list_profiles"] as const;
export const SUBAGENT_TOOL_NAMES = SUBAGENT_TOOL_LOCAL_NAMES.map((name) => `mcp__${SUBAGENT_MCP_SERVER_NAME}__${name}`);

/** list_profiles/list_subagents 是純查詢,比照 team-bus-mcp.ts 的
 *  list_teammates,可以放進 allowedTools 自動放行;spawn_subagent/
 *  send_to_subagent 刻意 **不** 在這裡——兩者都會讓某個 session 多跑一輪
 *  (前者是新起子程序,後者是讓既有子 agent 多花一輪 token),必須走既有
 *  權限彈窗(見 claude-sdk-adapter.ts §4「權限」的既有設計,不因為這次新增
 *  查詢/追加訊息工具而鬆動)。 */
export const SUBAGENT_ALLOWED_TOOL_NAMES = [
  `mcp__${SUBAGENT_MCP_SERVER_NAME}__list_profiles`,
  `mcp__${SUBAGENT_MCP_SERVER_NAME}__list_subagents`,
];

/** parentSessionId 由呼叫端(ClaudeAgentSdkAdapter)以自己的 handle.id 帶入,
 *  閉包捕捉,agent 無法覆寫(工具參數只有 prompt/title/profileId,或
 *  childSessionId/message)。 */
export function createSubagentMcpServer(port: SubagentPort, parentSessionId: string): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: SUBAGENT_MCP_SERVER_NAME,
    version: "1.0.0",
    instructions:
      "spawn_subagent:開一個子 agent 去做一段被明確界定的子任務,預設沿用你自己的" +
      "agent profile;也可以先呼叫 list_profiles 查詢目前有哪些 profile 可選,自行" +
      "決定要用哪一個(例如用更適合的 model 處理某段子任務)。" +
      "子 agent 跑完後,它的結果會自動出現在你的對話裡,你再據此繼續。" +
      "適合把一個大任務切成可並行/可獨立完成的小塊分出去。" +
      "send_to_subagent:對一個你已經開過的子 agent 追加訊息(不開新的子任務)," +
      "適合追加指示、回答它可能留下的問題、或給更多脈絡。" +
      "list_subagents:查詢你名下目前有哪些子 agent(id/標題/狀態/軟體/model)。" +
      "**你的子 agent 不一定是你自己 spawn_subagent 開的**——使用者也可能直接在" +
      "畫面上手動開一個掛在你底下,你的對話歷史完全不會出現任何紀錄。所以只要被問到" +
      "「你的子 agent/subagent 現在如何、用什麼 model」之類的問題、而你自己不記得有" +
      "開過,先呼叫 list_subagents 確認,不要憑對話歷史猜測或宣稱不知道。",
    tools: [
      tool(
        "list_profiles",
        "查詢目前可用的 agent profile(id/name/software/model/role),決定 spawn_subagent 要用哪一個。",
        {},
        async () => {
          const profiles = await port.listProfiles();
          return { content: [{ type: "text" as const, text: JSON.stringify(profiles, null, 2) }] };
        },
      ),
      tool(
        "list_subagents",
        "查詢你名下目前有哪些子 agent(不論是你自己用 spawn_subagent 開的,還是使用者" +
          "直接在畫面上手動開、掛在你底下的),每筆含 id/標題/狀態(idle/busy/waiting/" +
          "error 等)/軟體/model。用來回答「你的子 agent 現在狀態如何/用什麼 model」" +
          "這類問題,或在你自己不記得 childSessionId 時,找出 send_to_subagent 需要的 id。",
        {},
        async () => {
          const children = await port.listChildren({ parentSessionId });
          return { content: [{ type: "text" as const, text: JSON.stringify(children, null, 2) }] };
        },
      ),
      tool(
        "spawn_subagent",
        "開一個子 agent 去執行一段子任務。prompt 是給子 agent 的完整任務描述;" +
          "title 選填,只是顯示名稱;profileId 選填,指定要用哪個 agent profile 建立" +
          "子 agent(呼叫 list_profiles 查詢可用選項)。省略 profileId 時沿用你自己的" +
          "profile。回傳子 session id;子完成後結果會自動注入你的對話。",
        {
          prompt: z.string().min(1).describe("給子 agent 的完整任務描述(它看不到你的對話歷史,要寫清楚)"),
          title: z.string().optional().describe("選填:子 agent 的顯示名稱"),
          profileId: z
            .string()
            .optional()
            .describe("選填:子 agent 要使用的 agent profile id(呼叫 list_profiles 查詢)。省略時沿用你自己的 profile。"),
        },
        async (args) => {
          const { childSessionId } = await port.spawnChild({
            parentSessionId,
            prompt: args.prompt,
            title: args.title,
            agentProfileId: args.profileId,
          });
          return { content: [{ type: "text" as const, text: `已建立子 agent(session ${childSessionId})。它跑完後結果會自動出現在這裡。` }] };
        },
      ),
      tool(
        "send_to_subagent",
        "對一個你先前用 spawn_subagent 開過的子 agent 送出後續訊息(追加指示、回答它的" +
          "問題、給更多脈絡等),不會建立新的子 agent。childSessionId 用 spawn_subagent" +
          "回傳的那個 session id——只能對你自己開過的子 agent 送訊息,對別的 sessionId" +
          "會被拒絕。若子 agent 目前正忙,這則訊息會排隊,等它目前這輪結束後才送達。" +
          "它處理完後,結果一樣會自動出現在你的對話裡。",
        {
          childSessionId: z.string().min(1).describe("目標子 agent 的 session id(spawn_subagent 回傳的那個)"),
          message: z.string().min(1).describe("要送給子 agent 的訊息內容"),
        },
        async (args) => {
          await port.sendToChild({ parentSessionId, childSessionId: args.childSessionId, message: args.message });
          return {
            content: [
              {
                type: "text" as const,
                text: `已送出訊息給子 agent(session ${args.childSessionId})。若它目前正忙,訊息會排隊等它這輪結束後送達;結果一樣會自動出現在你的對話裡。`,
              },
            ],
          };
        },
      ),
    ],
  });
}
