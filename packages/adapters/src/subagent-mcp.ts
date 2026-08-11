import { z } from "zod";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { SubagentPort } from "@deskmony/shared";

export const SUBAGENT_MCP_SERVER_NAME = "subagent";
export const SUBAGENT_TOOL_NAMES = [`mcp__${SUBAGENT_MCP_SERVER_NAME}__spawn_subagent`];

/** parentSessionId 由呼叫端(ClaudeAgentSdkAdapter)以自己的 handle.id 帶入,
 *  閉包捕捉,agent 無法覆寫(工具參數只有 prompt/title)。 */
export function createSubagentMcpServer(port: SubagentPort, parentSessionId: string): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: SUBAGENT_MCP_SERVER_NAME,
    version: "1.0.0",
    instructions:
      "spawn_subagent:開一個子 agent(用你自己的設定)去做一段被明確界定的子任務。" +
      "子 agent 跑完後,它的結果會自動出現在你的對話裡,你再據此繼續。" +
      "適合把一個大任務切成可並行/可獨立完成的小塊分出去。",
    tools: [
      tool(
        "spawn_subagent",
        "開一個子 agent 去執行一段子任務。prompt 是給子 agent 的完整任務描述;" +
          "title 選填,只是顯示名稱。回傳子 session id;子完成後結果會自動注入你的對話。",
        {
          prompt: z.string().min(1).describe("給子 agent 的完整任務描述(它看不到你的對話歷史,要寫清楚)"),
          title: z.string().optional().describe("選填:子 agent 的顯示名稱"),
        },
        async (args) => {
          const { childSessionId } = await port.spawnChild({ parentSessionId, prompt: args.prompt, title: args.title });
          return { content: [{ type: "text" as const, text: `已建立子 agent(session ${childSessionId})。它跑完後結果會自動出現在這裡。` }] };
        },
      ),
    ],
  });
}
