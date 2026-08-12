import { z } from "zod";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { SubagentPort } from "@deskmony/shared";

export const SUBAGENT_MCP_SERVER_NAME = "subagent";

const SUBAGENT_TOOL_LOCAL_NAMES = ["spawn_subagent", "list_profiles"] as const;
export const SUBAGENT_TOOL_NAMES = SUBAGENT_TOOL_LOCAL_NAMES.map((name) => `mcp__${SUBAGENT_MCP_SERVER_NAME}__${name}`);

/** list_profiles 是純查詢,比照 team-bus-mcp.ts 的 list_teammates,可以放進
 *  allowedTools 自動放行;spawn_subagent 刻意 **不** 在這裡——它會起子程序、燒
 *  token,必須走既有權限彈窗(見 claude-sdk-adapter.ts §4「權限」的既有設計,
 *  不因為這次新增查詢工具而鬆動)。 */
export const SUBAGENT_ALLOWED_TOOL_NAMES = [`mcp__${SUBAGENT_MCP_SERVER_NAME}__list_profiles`];

/** parentSessionId 由呼叫端(ClaudeAgentSdkAdapter)以自己的 handle.id 帶入,
 *  閉包捕捉,agent 無法覆寫(工具參數只有 prompt/title/profileId)。 */
export function createSubagentMcpServer(port: SubagentPort, parentSessionId: string): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: SUBAGENT_MCP_SERVER_NAME,
    version: "1.0.0",
    instructions:
      "spawn_subagent:開一個子 agent 去做一段被明確界定的子任務,預設沿用你自己的" +
      "agent profile;也可以先呼叫 list_profiles 查詢目前有哪些 profile 可選,自行" +
      "決定要用哪一個(例如用更適合的 model 處理某段子任務)。" +
      "子 agent 跑完後,它的結果會自動出現在你的對話裡,你再據此繼續。" +
      "適合把一個大任務切成可並行/可獨立完成的小塊分出去。",
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
    ],
  });
}
