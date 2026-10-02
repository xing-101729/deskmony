#!/usr/bin/env node
/**
 * mcp-bridge-server.ts(ACP 掛載 session 網路 MCP 工具,Phase 2;2026-10-02 P3 起工具是
 * `list_agents`/`list_sessions`/`read_session`/`create_session`/`send_to_session` 五個)。
 *
 * (2026-10-02:原本還有一組團隊訊息工具——send_message/broadcast/list_teammates/
 * report_status/request_review 五個——隨 team 一併移除,見 docs/DECISIONS.md §H;
 * 原 S12 的 subagent 四件套也在 P3 換成 session 網路。)
 *
 * **獨立的 entry point,不是被 import 的 library 程式碼**——比照
 * `@agentclientprotocol/codex-acp` 那種「自己有進入點」的套件形狀(見
 * `packages/adapters/src/codex-acp-locator.ts` 的查證註解)。`package.json`
 * 的 `bin` 欄位指到編譯後的 `dist/mcp-bridge-server.js`,但實際上這裡從不透過
 * `bin`/`require.resolve()` 解析——`AcpAdapter.spawn()` 直接用
 * `import.meta.url` 算出這個檔案編譯後在 `dist/` 底下的**同目錄**路徑(見
 * `acp-adapter.ts` 的 `resolveMcpBridgeServerEntry()`),因為這是本套件自己的
 * 檔案,不是外部套件,不需要 Node 模組解析機制。
 *
 * ## 為什麼需要這個檔案(而不是直接沿用 session-network-mcp.ts)
 *
 * `ClaudeAgentSdkAdapter` 用 `@anthropic-ai/claude-agent-sdk` 的
 * `createSdkMcpServer()` 掛載 session 網路工具——**in-process**:工具
 * handler 直接閉包捕捉 `SessionNetworkPort` 實例,同一個 process 內
 * 呼叫,不需要任何認證機制。但 `@agentclientprotocol/sdk` 的 `SessionBuilder.
 * withMcpServer()` 只接受 `schema.McpServer`(stdio/http/sse/acp 四種「外部
 * 行程/端點」形式,見 `acp-adapter.ts` 查證註解),不支援閉包捕捉——ACP agent
 * 只知道「照這個 command/args/env 去 spawn 一個子行程,把它當 MCP server
 * 用」,agent 才是真正 spawn 這個檔案的人(`AcpAdapter` 只是透過 ACP 協議
 * *告知* agent 要這麼做,不是自己直接 spawn 它——見 acp-adapter.ts 對這一點
 * 的完整說明)。這個檔案就是那個「外部行程」:一個真正的 MCP stdio server,
 * 用 `@modelcontextprotocol/sdk`(**注意不是** `@anthropic-ai/claude-agent-sdk`
 * 內附的那份,見 packages/adapters/package.json 這輪新增的直接相依——已確認
 * `@modelcontextprotocol/sdk@1.29.0` 雖然透過 `@anthropic-ai/claude-agent-sdk`
 * 的相依鏈間接存在於這個 monorepo 的 pnpm store,但**沒有被任何 package 直接
 * 宣告**,pnpm 預設的 strict node_modules 下無法被這個 package 直接
 * `import` 到,必須自己宣告)實作。
 *
 * 每個工具 handler 不再直接呼叫 `port`,而是對 gateway 發一個 WS RPC
 * 呼叫(見下方 `BridgeGatewayClient`),把結果轉成 MCP 的 `CallToolResult`。
 *
 * ## 安全模型(務必完整讀過,這是整個 Phase 2 最重要的部分)
 *
 * 這個行程是由**外部、LLM 控制**的 codex-acp/gemini 行程**間接**(透過 ACP
 * 協議告知後,agent 自己決定何時、如何 spawn)拉起的孫行程——env/args 有被
 * 檢視的可能性。絕不能把 apps/core 完整存取權的 `DESKMONY_AUTH_TOKEN` 交給它。
 * 這裡改用一個**限定範圍(只能操作核發時綁定的那一個 session)、有時效
 * (見 `apps/core/src/gateway/ws-gateway.ts` 的
 * `DEFAULT_MCP_BRIDGE_TOKEN_TTL_MS`)**的 scoped token,透過**環境變數**
 * (不是 CLI args——args 在行程列表裡通常比 env 更容易被其他本機行程看到,
 * 尤其是 Windows 的 `tasklist`/工作管理員預設就會顯示完整命令列)傳給這個
 * 行程。核發/驗證/失效邏輯全在 `apps/core/src/gateway/ws-gateway.ts`
 * (`mintMcpBridgeToken()`/`checkScopedGrantAccess()`/
 * `revokeMcpBridgeTokensForSession()`),這裡只是單純的 client。
 *
 * **呼叫者身分(哪個 session 在呼叫)只由 token 決定**:P3 的五個 gateway 方法
 * (`agent.listForAgent`/`session.listForAgent`/`session.readForAgent`/`session.createFromAgent`/
 * `session.sendFromAgent`)的參數裡**沒有**任何 caller/parent 欄位,gateway 從 token 取綁定的 session id。
 * 這個行程連自己是哪個 session 都不需要告訴 gateway,也就無從冒名別人。
 *
 * ## 環境變數(全部由 `AcpAdapter.spawn()` 透過
 * `SessionBuilder.withMcpServer({..., env})` 設定,見該檔案)
 *
 *   - `DESKMONY_MCP_BRIDGE_TOKEN`(必要):scoped token。
 *   - `DESKMONY_MCP_BRIDGE_GATEWAY_URL`(必要):gateway 的 WS 位址
 *     (`ws://127.0.0.1:<port>`,或 bindHost 是特定區網位址時的那個位址,見
 *     `resolveMcpBridgeConnectHost()`)。
 *   - `DESKMONY_MCP_BRIDGE_SESSION_ID`(必要):這個 ACP session 自己的
 *     `AgentHandle.id`——僅供啟動檢查/除錯;**不會**被當成任何 RPC 參數送出(身分一律由 token 決定)。
 *   - `DESKMONY_MCP_BRIDGE_NETWORK_ENABLED`(選填,值為 `"1"` 時才生效):
 *     有值時才註冊 session 網路五個工具。
 *
 * 若 `DESKMONY_MCP_BRIDGE_NETWORK_ENABLED` 不是 `"1"`,這個 server 會啟動成
 * 一個**沒有任何工具**的 MCP server(理論上不會發生:`AcpAdapter.spawn()` 只在
 * 有 `sessionNetworkPort` 時才會掛載這個 server,見該檔案)。
 *
 * ## 工具描述文字與 session-network-mcp.ts 的關係
 *
 * 這裡的 5 個工具(名稱、參數 schema、`description` 文案)與 MCP server `instructions`
 * 刻意與 `session-network-mcp.ts` **逐字一致**,避免使用者/模型對同一組工具
 * 在不同 adapter 下看到不一致的說明。**刻意選擇複製文字而非抽出共用常數**
 * ——那個檔案 import `@anthropic-ai/claude-agent-sdk` 的 `createSdkMcpServer`/
 * `tool`,若這個檔案改成從那裡 import 純文字常數,仍會在模組載入時把
 * 整個 `@anthropic-ai/claude-agent-sdk`(以及它带的 `@modelcontextprotocol/sdk`
 * 另一份拷貝)一併載入這個原本應該輕量、快速啟動的橋接子行程,且會讓兩個
 * 「本來互相獨立、服務不同 adapter」的檔案產生不必要的耦合。維護時若調整了
 * 其中一邊的描述文字,記得同步另一邊——`scripts/e2e-session-network.mjs` 有一個斷言
 * 直接比對兩邊的 tools/list 與 instructions,漂移會讓 `pnpm test` 失敗。
 */

import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { NetworkAgentSummary, NetworkSessionSummary, ReadSessionResult } from "@deskmony/shared";

/** 與 in-process 版(session-network-mcp.ts 的 `SESSION_NETWORK_MCP_SERVER_NAME`)同名,工具全名才會一致(`mcp__deskmony__<name>`)。 */
const MCP_BRIDGE_SERVER_NAME = "deskmony";

/** 與 session-network-mcp.ts 的 `instructions` 逐字一致(見檔頭「工具描述文字」說明)。 */
const SESSION_NETWORK_INSTRUCTIONS =
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
  "要回覆就用 send_to_session,系統不會自動把你的回答送回去**。回覆對象也不一定是寄件者,可以是任何合適的 session。";


/**
 * Gateway 的 wire protocol(見 packages/shared/src/gateway.ts、
 * apps/core/src/gateway/ws-gateway.ts):request 是 `{id, method, params}`
 * (沒有 `kind` 包裝,與 response/push 不同),response 是
 * `{kind:"response", id, ok, result?, error?, errorCode?}`。這裡的實作對照
 * `scripts/e2e-gateway.mjs` 的 `GatewayClient`(同一份 wire protocol 的另一個
 * 消費端),但這裡是給生產環境用的真正 client,不是測試替身。
 */
interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

class BridgeGatewayClient {
  private ws: WebSocket | undefined;
  private connecting: Promise<WebSocket> | undefined;
  private readonly pending = new Map<string, PendingRpc>();

  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  /** 惰性建立連線 + 認證,建立好後重複使用(同一個 ACP session 存活期間可能
   *  呼叫多次工具),斷線時下一次呼叫會自動重新連線。 */
  private async ensureConnected(): Promise<WebSocket> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return this.ws;
    if (!this.connecting) this.connecting = this.connect();
    try {
      return await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }

  private connect(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(this.url);
      ws.addEventListener("message", (event: MessageEvent) => this.handleMessage(event.data));
      ws.addEventListener("close", () => {
        this.ws = undefined;
        // 尚未 resolve 過的 pending RPC(含這次連線流程本身的 "auth" 請求)
        // 一律以連線已斷收場,避免呼叫端永久卡在等待。
        for (const pending of this.pending.values()) {
          pending.reject(new Error("MCP bridge 與 gateway 的連線已斷開"));
        }
        this.pending.clear();
      });
      ws.addEventListener("error", () => {
        if (!settled) {
          settled = true;
          reject(new Error(`MCP bridge 無法連線 gateway(${this.url})`));
        }
      });
      ws.addEventListener("open", () => {
        void (async () => {
          try {
            // 一律先送 auth、等回覆成功後才視為「可以送真正的 RPC」——不依賴
            // gateway 端「同一批同步處理的訊息,認證 flag 一定先設好」這種
            // 實作細節上的時序巧合,寧可多一次往返也要明確等待。
            await this.rpcOn(ws, "auth", { token: this.token });
            this.ws = ws;
            settled = true;
            resolve(ws);
          } catch (err) {
            settled = true;
            try {
              ws.close();
            } catch {
              // ignore
            }
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        })();
      });
    });
  }

  private handleMessage(raw: unknown): void {
    let msg: { kind?: string; id?: string; ok?: boolean; result?: unknown; error?: string; errorCode?: string };
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : String(raw));
    } catch {
      return;
    }
    // 只處理 response(`{kind:"response", ...}`);push 事件(`{kind:"event"}`)
    // 這個 bridge 不需要訂閱,忽略即可。
    if (msg.kind !== "response" || typeof msg.id !== "string") return;
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    if (msg.ok) {
      pending.resolve(msg.result);
    } else {
      pending.reject(new Error(msg.error ?? `gateway 回應失敗(errorCode=${msg.errorCode ?? "unknown"})`));
    }
  }

  private rpcOn(ws: WebSocket, method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC "${method}" 逾時(${timeoutMs}ms)`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async call<T = unknown>(method: string, params: unknown): Promise<T> {
    const ws = await this.ensureConnected();
    return (await this.rpcOn(ws, method, params)) as T;
  }
}

function textResult(text: string, isError = false): CallToolResult {
  return { content: [{ type: "text", text }], isError };
}

/** 與 session-network-mcp.ts 的 `errorText()` 相同——工具失敗時把 gateway 回的錯誤訊息原樣交給 agent。 */
function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 註冊 session 網路 5 個工具(list_agents/list_sessions/read_session/create_session/send_to_session)——
 * 呼叫者身分由 token 在 gateway 端決定,這裡送出的 RPC 參數裡沒有任何 caller/parent 欄位,agent 無法覆寫。
 */
function registerSessionNetworkTools(server: McpServer, client: BridgeGatewayClient): void {
  server.registerTool(
    "list_agents",
    {
      description:
        "查詢目前可用的 agent(id/label/software/models/defaultModelId/canUseTools),決定 create_session 要用哪一個。" +
        "id 就是 create_session 的 agent 參數。canUseTools=false 的 agent(OpenCode HTTP、終端機型)收得到訊息," +
        "但不能主動傳訊息,所以不會回覆你。",
      inputSchema: {},
    },
    async () => {
      try {
        const { agents } = await client.call<{ agents: NetworkAgentSummary[] }>("agent.listForAgent", {});
        return textResult(JSON.stringify(agents, null, 2));
      } catch (err) {
        return textResult(errorText(err), true);
      }
    },
  );

  server.registerTool(
    "list_sessions",
    {
      description:
        "列出 Deskmony 裡所有的 session(不論是誰開的、不論工作資料夾),每筆含 id/標題/providerId/agentLabel/model/" +
        "狀態(idle/busy/waiting/error/closed/interrupted)/工作資料夾/parentSessionId/isYou(是不是你自己)/" +
        "canUseTools(對方能不能主動回話)。不含對話內容(要看請用 read_session)。使用者也可能直接在畫面上開 session," +
        "你的對話歷史完全不會有紀錄——不確定有哪些 session、或要找 send_to_session 需要的 id 時,先呼叫這個,不要憑對話歷史猜測。",
      inputSchema: {},
    },
    async () => {
      try {
        const { sessions } = await client.call<{ sessions: NetworkSessionSummary[] }>("session.listForAgent", {});
        return textResult(JSON.stringify(sessions, null, 2));
      } catch (err) {
        return textResult(errorText(err), true);
      }
    },
  );

  server.registerTool(
    "read_session",
    {
      description:
        "讀取某個 session 最近的對話內容(只含 user/assistant 訊息,不含工具呼叫細節與系統事件),每則含 " +
        "role/content/createdAt/origin(若是別的 session 送來的)。" +
        "limit 選填:最近幾則,預設 20、上限 100;每則 content 超過 4000 字元會被截斷並標註。" +
        "附件(圖片/檔案)不會回傳內容,只標示 hasAttachments。",
      inputSchema: {
        sessionId: z.string().min(1).describe("要讀取的 session id(list_sessions 回傳的 id)"),
        limit: z.number().int().positive().optional().describe("選填:最近幾則,預設 20、上限 100"),
      },
    },
    async (args) => {
      try {
        const result = await client.call<ReadSessionResult>("session.readForAgent", {
          sessionId: args.sessionId,
          limit: args.limit,
        });
        return textResult(JSON.stringify(result, null, 2));
      } catch (err) {
        return textResult(errorText(err), true);
      }
    },
  );

  server.registerTool(
    "create_session",
    {
      description:
        "用指定的 agent 開一個新 session,並把 prompt 當第一則訊息送過去(信封會標明是你開的)。" +
        "prompt 是給新 session 的完整任務描述(它看不到你的對話歷史,要寫清楚);agent 填 list_agents 回傳的 id;" +
        "model 選填(從該 agent 的 models 挑,省略時用 agent 預設);title 選填,只是顯示名稱;" +
        "workingDir 選填,省略時沿用你自己的工作資料夾。回傳新 session 的 id。" +
        "新 session 會掛在你底下顯示,但它跟其他 session 一樣平等:它跑完後系統不會自動把結果帶回給你——" +
        "它自己決定要不要回報,你也可以用 read_session 去看它的對話。",
      inputSchema: {
        agent: z.string().min(1).describe("要使用的 agent id(list_agents 回傳的 id)"),
        prompt: z.string().min(1).describe("給新 session 的完整任務描述(它看不到你的對話歷史,要寫清楚)"),
        model: z.string().optional().describe("選填:要使用的 model id(list_agents 回傳該 agent 的 models 之一)"),
        title: z.string().optional().describe("選填:新 session 的顯示名稱"),
        workingDir: z.string().optional().describe("選填:新 session 的工作資料夾,省略時沿用你自己的"),
      },
    },
    async (args) => {
      try {
        const { sessionId } = await client.call<{ sessionId: string }>("session.createFromAgent", {
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
  );

  server.registerTool(
    "send_to_session",
    {
      description:
        "對任一 session(不能是你自己)送出一則訊息,訊息會以信封包裝,標明是你送的。sessionId 用 list_sessions 回傳的 id。" +
        "若對方目前正忙,訊息會排隊,等它目前這輪結束後才送達;對方不存在/已關閉/出錯/不在執行中會明確報錯。" +
        "**系統不會自動把對方的回答送回給你**——對方要不要回、回給誰由它自己決定;你想知道結果時," +
        "等它用 send_to_session 傳給你,或用 read_session 去看它的對話。",
      inputSchema: {
        sessionId: z.string().min(1).describe("目標 session 的 id(list_sessions 回傳的 id),不能是你自己"),
        message: z.string().min(1).describe("要送出的訊息內容"),
      },
    },
    async (args) => {
      try {
        await client.call("session.sendFromAgent", { sessionId: args.sessionId, message: args.message });
        return textResult(
          `已送出訊息給 session ${args.sessionId}。若它目前正忙,訊息會排隊等它這輪結束後送達;系統不會自動把它的回答帶回給你。`,
        );
      } catch (err) {
        return textResult(errorText(err), true);
      }
    },
  );
}

async function main(): Promise<void> {
  const token = process.env.DESKMONY_MCP_BRIDGE_TOKEN;
  const gatewayUrl = process.env.DESKMONY_MCP_BRIDGE_GATEWAY_URL;
  const sessionId = process.env.DESKMONY_MCP_BRIDGE_SESSION_ID;

  if (!token || !gatewayUrl || !sessionId) {
    // 沒有這三個環境變數就完全無法運作——`AcpAdapter.spawn()` 一定會設定
    // 好才掛載這個 server,若真的走到這裡,通常代表設定被上層的 ACP agent
    // 動過手腳,或是這支腳本被誤用(不是被 AcpAdapter 依原本的方式 spawn)。
    // 立刻失敗、明確印出原因,不要靜默啟動一個完全不能用的 MCP server。
    console.error(
      "[mcp-bridge-server] 缺少必要的環境變數(DESKMONY_MCP_BRIDGE_TOKEN / " +
        "DESKMONY_MCP_BRIDGE_GATEWAY_URL / DESKMONY_MCP_BRIDGE_SESSION_ID),無法啟動。",
    );
    process.exit(1);
  }

  const networkEnabled = process.env.DESKMONY_MCP_BRIDGE_NETWORK_ENABLED === "1";

  const client = new BridgeGatewayClient(gatewayUrl, token);
  const server = new McpServer(
    { name: MCP_BRIDGE_SERVER_NAME, version: "1.0.0" },
    { instructions: SESSION_NETWORK_INSTRUCTIONS },
  );

  let mountedAny = false;
  if (networkEnabled) {
    registerSessionNetworkTools(server, client);
    mountedAny = true;
  }
  if (!mountedAny) {
    // 理論上不會發生(見上方檔頭註解),但若真的走到這裡,寧可啟動一個沒有
    // 工具的 server(agent 呼叫 `initialize`/`tools/list` 仍會成功,只是拿到
    // 空清單),也不要整個 process 直接 exit——那樣反而可能讓 agent 誤以為
    // 是連線失敗而重試,而不是「這次真的沒有工具可用」。
    console.error("[mcp-bridge-server] 警告:沒有任何 session 網路範圍可掛載,啟動成一個沒有工具的 MCP server。");
  }

  await server.connect(new StdioServerTransport());
}

/**
 * 比照 fake-acp-agent.mjs 的既有慣例(同一種寫法,見該檔案最底部):只有
 * 「被當成獨立行程直接執行」時才啟動 stdio server——這支檔案理論上不會被
 * 其他程式碼 `import`(它是純粹的 bin entry),但保留這個保護,行為上更貼近
 * 既有慣例、也讓未來若有測試需要 `import` 這個檔案取用型別/常數時不會意外把
 * stdin/stdout 接管走。
 */
const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((err: unknown) => {
    console.error("[mcp-bridge-server] fatal:", err);
    process.exit(1);
  });
}
