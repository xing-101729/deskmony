import { z } from "zod";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { SessionNetworkPort } from "@deskmony/shared";

/**
 * session-network-mcp.ts(2026-10-02,P3「session 網路」,取代 S12 的 `subagent-mcp.ts`;見
 * docs/LAYER-4-detail-design/simplify-agents-sessions_detail.md §P3.1)。
 *
 * 每個 `ClaudeAgentSdkAdapter` session 掛一個 in-process 的 MCP server(名稱 `deskmony`,工具全名
 * `mcp__deskmony__<name>`),五個工具:`list_agents` / `list_sessions` / `read_session` / `create_session` /
 * `send_to_session`。ACP 版本是 `mcp-bridge-server.ts`(獨立子行程,經 gateway 打回 core)——**工具名稱、參數
 * schema、描述文字與這個檔案逐字一致**(刻意複製文字而非抽出共用常數,理由見 mcp-bridge-server.ts 檔頭;
 * `scripts/e2e-session-network.mjs` 有一個斷言直接比對兩邊的 tools/list 與 instructions,漂移會被抓到)。
 * 維護時調整其中一邊的文字,務必同步另一邊。
 *
 * **核心語意(使用者親自定案,不得偏離)**:
 *   1. **沒有任何自動回送**——B 收到 A 的訊息、這輪結束後,系統不會把 B 的回答送回 A。要回覆,B 必須自己呼叫
 *      `send_to_session`。(S12 的「子完成 → 結果注入父」整個移除。)
 *   2. **所有 session 互相可見**,不限父子、不限工作目錄。
 */

export const SESSION_NETWORK_MCP_SERVER_NAME = "deskmony";

const SESSION_NETWORK_TOOL_LOCAL_NAMES = [
  "list_agents",
  "list_sessions",
  "read_session",
  "create_session",
  "send_to_session",
] as const;
export const SESSION_NETWORK_TOOL_NAMES = SESSION_NETWORK_TOOL_LOCAL_NAMES.map(
  (name) => `mcp__${SESSION_NETWORK_MCP_SERVER_NAME}__${name}`,
);

/**
 * 三個查詢類工具(list_agents/list_sessions/read_session)是純查詢,可以放進 allowedTools 自動放行;
 * `create_session`/`send_to_session` 刻意 **不** 在這裡——兩者都會讓某個 session 多跑一輪(新起 session
 * 或讓既有 session 多花一輪 token),必須走既有權限彈窗(見 claude-sdk-adapter.ts §4「權限」的既有設計,
 * 不因為這次新增而鬆動)。
 */
export const SESSION_NETWORK_ALLOWED_TOOL_NAMES = [
  `mcp__${SESSION_NETWORK_MCP_SERVER_NAME}__list_agents`,
  `mcp__${SESSION_NETWORK_MCP_SERVER_NAME}__list_sessions`,
  `mcp__${SESSION_NETWORK_MCP_SERVER_NAME}__read_session`,
];

function textResult(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) };
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * `callerSessionId` 由呼叫端(ClaudeAgentSdkAdapter)以自己的 handle.id 閉包捕捉帶入——工具參數裡沒有任何
 * caller/parent 欄位,agent 無法冒名別的 session。
 */
export function createSessionNetworkMcpServer(
  port: SessionNetworkPort,
  callerSessionId: string,
): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: SESSION_NETWORK_MCP_SERVER_NAME,
    version: "1.0.0",
    instructions:
      "這組工具讓你看到這台電腦上 Deskmony 裡的**所有** session(不限你自己開的、不限工作資料夾),並對它們傳訊息。" +
      "list_agents:查詢目前有哪些 agent 可以用來開新 session。" +
      "list_sessions:列出所有 session(id/標題/agent/model/狀態/工作資料夾/是否是你自己/對方能不能主動回話),不含對話內容。" +
      "**使用者也可能直接在畫面上開 session**——你的對話歷史完全不會出現任何紀錄,所以只要被問到「現在有哪些 session/" +
      "某個 session 在做什麼」、或你需要找一個 session 的 id,而你自己不確定,先呼叫 list_sessions 確認,不要憑對話歷史猜測。" +
      "read_session:讀某個 session 最近的對話內容。" +
      "create_session:用某個 agent 開一個新 session 並送出第一則訊息(它看不到你的對話,prompt 要寫清楚)。" +
      "send_to_session:對任一 session(不能是你自己)送一則訊息;對方正忙時會排隊,等它目前這輪結束後才送達。" +
      "**系統不會自動回送任何東西**:你送出訊息後,系統不會等對方、也不會把對方的回答帶回給你——對方要不要回、回給誰,由對方自己決定。" +
      "同樣地,**收到別的 session 的訊息時(訊息開頭會標明來自哪個 session),要不要回、回給誰由你決定;" +
      "要回覆就用 send_to_session,系統不會自動把你的回答送回去**。回覆對象也不一定是寄件者,可以是任何合適的 session。",
    tools: [
      tool(
        "list_agents",
        "查詢目前可用的 agent(id/label/software/models/defaultModelId/canUseTools),決定 create_session 要用哪一個。" +
          "id 就是 create_session 的 agent 參數。canUseTools=false 的 agent(終端機型,例如 Claude Code CLI、Aider)收得到訊息," +
          "但不能主動傳訊息,所以不會回覆你。",
        {},
        async () => {
          try {
            const agents = await port.listAgents();
            return textResult(JSON.stringify(agents, null, 2));
          } catch (err) {
            return textResult(errorText(err), true);
          }
        },
      ),
      tool(
        "list_sessions",
        "列出 Deskmony 裡所有的 session(不論是誰開的、不論工作資料夾),每筆含 id/標題/providerId/agentLabel/model/" +
          "狀態(idle/busy/waiting/error/closed/interrupted)/工作資料夾/parentSessionId/isYou(是不是你自己)/" +
          "canUseTools(對方能不能主動回話)。不含對話內容(要看請用 read_session)。使用者也可能直接在畫面上開 session," +
          "你的對話歷史完全不會有紀錄——不確定有哪些 session、或要找 send_to_session 需要的 id 時,先呼叫這個,不要憑對話歷史猜測。",
        {},
        async () => {
          try {
            const sessions = await port.listSessions({ callerSessionId });
            return textResult(JSON.stringify(sessions, null, 2));
          } catch (err) {
            return textResult(errorText(err), true);
          }
        },
      ),
      tool(
        "read_session",
        "讀取某個 session 最近的對話內容(只含 user/assistant 訊息,不含工具呼叫細節與系統事件),每則含 " +
          "role/content/createdAt/origin(若是別的 session 送來的)。" +
          "limit 選填:最近幾則,預設 20、上限 100;每則 content 超過 4000 字元會被截斷並標註。" +
          "附件(圖片/檔案)不會回傳內容,只標示 hasAttachments。",
        {
          sessionId: z.string().min(1).describe("要讀取的 session id(list_sessions 回傳的 id)"),
          limit: z.number().int().positive().optional().describe("選填:最近幾則,預設 20、上限 100"),
        },
        async (args) => {
          try {
            const result = await port.readSession({ callerSessionId, sessionId: args.sessionId, limit: args.limit });
            return textResult(JSON.stringify(result, null, 2));
          } catch (err) {
            return textResult(errorText(err), true);
          }
        },
      ),
      tool(
        "create_session",
        "用指定的 agent 開一個新 session,並把 prompt 當第一則訊息送過去(信封會標明是你開的)。" +
          "prompt 是給新 session 的完整任務描述(它看不到你的對話歷史,要寫清楚);agent 填 list_agents 回傳的 id;" +
          "model 選填(從該 agent 的 models 挑,省略時用 agent 預設);title 選填,只是顯示名稱;" +
          "workingDir 選填,省略時沿用你自己的工作資料夾。回傳新 session 的 id。" +
          "新 session 會掛在你底下顯示,但它跟其他 session 一樣平等:它跑完後系統不會自動把結果帶回給你——" +
          "它自己決定要不要回報,你也可以用 read_session 去看它的對話。",
        {
          agent: z.string().min(1).describe("要使用的 agent id(list_agents 回傳的 id)"),
          prompt: z.string().min(1).describe("給新 session 的完整任務描述(它看不到你的對話歷史,要寫清楚)"),
          model: z.string().optional().describe("選填:要使用的 model id(list_agents 回傳該 agent 的 models 之一)"),
          title: z.string().optional().describe("選填:新 session 的顯示名稱"),
          workingDir: z.string().optional().describe("選填:新 session 的工作資料夾,省略時沿用你自己的"),
        },
        async (args) => {
          try {
            const { sessionId } = await port.createSession({
              callerSessionId,
              agent: args.agent,
              prompt: args.prompt,
              model: args.model,
              title: args.title,
              workingDir: args.workingDir,
            });
            return textResult(
              `已建立 session ${sessionId} 並送出第一則訊息。系統不會自動把它的結果帶回給你——它自己決定要不要回報,你也可以用 read_session 去看。`,
            );
          } catch (err) {
            return textResult(errorText(err), true);
          }
        },
      ),
      tool(
        "send_to_session",
        "對任一 session(不能是你自己)送出一則訊息,訊息會以信封包裝,標明是你送的。sessionId 用 list_sessions 回傳的 id。" +
          "若對方目前正忙,訊息會排隊,等它目前這輪結束後才送達;對方不存在/已關閉/出錯/不在執行中會明確報錯。" +
          "**系統不會自動把對方的回答送回給你**——對方要不要回、回給誰由它自己決定;你想知道結果時," +
          "等它用 send_to_session 傳給你,或用 read_session 去看它的對話。",
        {
          sessionId: z.string().min(1).describe("目標 session 的 id(list_sessions 回傳的 id),不能是你自己"),
          message: z.string().min(1).describe("要送出的訊息內容"),
        },
        async (args) => {
          try {
            await port.sendToSession({ callerSessionId, sessionId: args.sessionId, message: args.message });
            return textResult(
              `已送出訊息給 session ${args.sessionId}。若它目前正忙,訊息會排隊等它這輪結束後送達;系統不會自動把它的回答帶回給你。`,
            );
          } catch (err) {
            return textResult(errorText(err), true);
          }
        },
      ),
    ],
  });
}
