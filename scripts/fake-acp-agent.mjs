#!/usr/bin/env node
/**
 * scripts/fake-acp-agent.mjs
 *
 * 給 scripts/e2e-gateway.mjs 步驟 9 使用的最小 ACP(Agent Client Protocol)
 * agent —— 不呼叫任何真實模型 API,行為完全確定性,讓
 * packages/adapters/src/acp-adapter.ts 的事件轉換與權限請求路徑可以在沒有
 * Claude Code 登入憑證的情況下被重複、穩定地驗證(不像既有的 12 項 e2e
 * 依賴真實模型行為,可能因模型措辭/重試而 flaky)。
 *
 * 用官方 `@agentclientprotocol/sdk` 的 agent 端建構器 API(`acp.agent()`)
 * 實作,寫法對照 node_modules 內
 * `@agentclientprotocol/sdk/dist/examples/agent.js`(官方範例,已編譯的
 * 版本,讀取後確認欄位名稱與呼叫方式)。
 *
 * 啟動方式:透過 stdio 建立 ACP JSON-RPC 連線,不接受命令列參數 —— 由
 * AcpAdapter.spawn() 依 AgentProfile.acpConfig(command/args/env)啟動這支
 * 腳本本身(例如 command=process.execPath, args=[thisFilePath])。
 *
 * 協定(僅供本腳本與 e2e-gateway.mjs 步驟 9 之間使用,非 ACP 標準的一部分):
 *   - 一般 prompt:固定回覆 FAKE_ACP_REPLY_CHUNKS 串接而成的文字,拆成多段
 *     `agent_message_chunk` 送出(同一個 messageId),用來驗證
 *     message-delta 分組/done/completed 事件轉換是否正確。
 *   - 若 prompt 文字以 WRITE_FILE_PREFIX("ACP_WRITE_FILE ")開頭,其後接一段
 *     JSON `{"path": "...", "content": "...", "delayMs"?: number}`
 *     (`delayMs` 選填,S7 L4 §2.1 的「無人值守」e2e 用:先延遲再開始整個寫檔
 *      流程,讓測試腳本有時間在 `session/request_permission` 送達 core **之前**
 *      把自己的 WS 連線關掉,誠實地製造出「decide() 當下一個 client 都沒連著」
 *      的情境——那正是 `ExecContext.attended` 的唯一判定來源,不可偽造):
 *       1. 送出一則 `tool_call`(kind: "edit", status: "pending")
 *       2. 呼叫 `session/request_permission`,提供 allow_once / reject_once
 *          兩個選項
 *       3. 選了 "allow":實際寫入檔案,送出 `tool_call_update`
 *          (status: "completed"),再送一句完成訊息,以 end_turn 結束。
 *       4. 選了 "deny"(或 outcome 為 cancelled):不寫檔、不送
 *          `tool_call_update`,直接以 end_turn 結束這一輪。
 *   - 若 prompt 文字內含 DELAY_ECHO_MARKER 樣式(M3 Round A,e2e 步驟 12
 *     MessageBus 測試用,見 scripts/e2e-gateway.mjs):延遲指定毫秒數後,
 *     把「完整收到的 prompt 文字」原封不動回顯(前綴 "ECHO:")。用來驗證
 *     MessageBus 注入的 prompt 確實送達目標 session(用 substring 搜尋,不是
 *     startsWith——MessageBus 會在原始內容外包一層「來自 @X(角色)的訊息:」
 *     的格式化文字,marker 仍會保留在包裹後的字串中間),以及用可控制的
 *     延遲時間製造「session 目前 busy」的測試窗口。
 *   - 若 prompt 文字以 USAGE_UPDATE_PREFIX("ACP_USAGE_UPDATE ")開頭,其後接
 *     一段 JSON `{"used": number, "size": number, "cost"?: {"amount": number,
 *     "currency": string}}`(S3a usage-metering,e2e 步驟 29 用,見
 *     scripts/e2e-gateway.mjs):送出一則 `session/update` 通知,
 *     `sessionUpdate: "usage_update"`,`cost` 有給才附帶(模擬「這個後端
 *     不一定回報 cost」的真實不確定性,見 packages/adapters/src/acp-adapter.ts
 *     handleSessionUpdate() 的 "usage_update" case),再回一句簡短訊息並以
 *     end_turn 結束——用來在沒有真實 Claude Code 後端的情況下,決定性地驗證
 *     AcpAdapter 對 usage_update 的事件轉換(context-usage 逐次發、cost 存在
 *     時累計進 lastCost、回合末補發 usage)。
 *   - 若 prompt 文字以 MANY_TOOL_CALLS_PREFIX("ACP_MANY_TOOL_CALLS ")開頭,
 *     其後接一段 JSON `{"count": number}`(S3b cost-governor 的
 *     `TurnLimiter` e2e 用,見 scripts/e2e-cost-governor.mjs):在**同一輪**
 *     內連續送出 `count` 則 `tool_call` 通知(不經過權限請求——`tool_call`
 *     本身不觸發 `session/request_permission`,見
 *     packages/adapters/src/acp-adapter.ts 的 `handleSessionUpdate()`),藉此
 *     在單一回合裡製造大量 `tool-call` AgentEvent,決定性地驗證回合硬上限的
 *     「工具呼叫次數」維度——不需要真實模型自己決定要呼叫幾次工具。
 *   - 若 prompt 文字以 SLEEP_TURN_PREFIX("ACP_SLEEP_TURN ")開頭,其後接一段
 *     JSON `{"ms": number}`:單純睡滿 `ms` 毫秒後才結束這一輪,且這個睡眠會
 *     隨這個 session 的 `abort` signal 一起被取消(`session/cancel` 通知
 *     抵達時)——用來決定性地驗證回合硬上限的「時間」維度,以及
 *     `TurnLimiter` 觸發的 `interrupt()`(= ACP 的 `session/cancel`)真的能讓
 *     這個假 agent 提早結束回合,而不是一路睡到底才發現已經被中斷。
 *   - 若 prompt 文字以 AVAILABLE_COMMANDS_PREFIX("ACP_AVAILABLE_COMMANDS ")
 *     開頭,其後接一段 JSON `{"commands": [{"name": string, "description"?:
 *     string, "hint"?: string}]}`(這輪 slash command,e2e 步驟 31 用,見
 *     scripts/e2e-gateway.mjs):送出一則 `session/update` 通知,
 *     `sessionUpdate: "available_commands_update"`,`hint` 有給才組進
 *     `input: {hint}`(模擬「並非每個指令都有 argument hint」的真實情況,見
 *     packages/adapters/src/acp-adapter.ts `mapAvailableCommands()` 的
 *     coalescing 處理),再回一句簡短訊息並以 end_turn 結束——用來在沒有真實
 *     ACP agent 的情況下,決定性地驗證 AcpAdapter 對 available_commands_update
 *     的事件轉換。
 *   - 若 prompt 文字以 DIFF_CONTENT_PREFIX("ACP_DIFF_CONTENT ")開頭,其後接
 *     一段 JSON `{"path": string, "oldText"?: string, "newText": string}`
 *     (Codex ACP 橋接切換 Phase 3「diff 顯示」路徑 A 的 e2e 用,見
 *     scripts/e2e-gateway.mjs):送出 `tool_call`(kind: "edit",
 *     **刻意不帶 `locations`**,好讓這個情境只可能命中路徑 A、不可能誤觸路徑
 *     B 的檔案快照 fallback,兩條路徑的測試訊號才不會混在一起),再送
 *     `tool_call_update`(status: "completed",`content: [{type:"diff", path,
 *     oldText, newText}]`)——不實際寫入任何檔案(純粹測試
 *     session/update → AgentEvent 的轉換邏輯,見
 *     packages/adapters/src/acp-adapter.ts 的 `findDiffBlock()`/
 *     `buildDiffStructuredResult()`),用來在沒有真實 ACP agent 的情況下,
 *     決定性地驗證 AcpAdapter 對原生 diff 內容區塊的重建結果。
 *   - 若 prompt 文字以 CALL_BRIDGE_TOOL_PREFIX("ACP_CALL_BRIDGE_TOOL ")開頭,
 *     其後接一段 JSON `{"tool": string, "args": object}`(Phase 2 scoped MCP
 *     bridge token 的 e2e 用,見 scripts/e2e-gateway.mjs):**真的**把
 *     `session/new` 請求裡收到的 `mcpServers[0]`(`AcpAdapter.spawn()` 透過
 *     `SessionBuilder.withMcpServer()` 掛上的 mcp-bridge-server.ts 設定,見
 *     `newSession()` 如何把它存進 `this.sessions`)當成一個 `StdioServerParameters`
 *     spawn 成真正的子行程,用 `@modelcontextprotocol/sdk` 的 `Client` +
 *     `StdioClientTransport` 連上去、呼叫 `tool` 這個工具、把回傳的
 *     `CallToolResult` 轉成一則 `agent_message_chunk`
 *     (`"BRIDGE_TOOL_RESULT:" + JSON.stringify(result)`)送回去,再關閉這個
 *     client。這是**決定性**的(完全由這支腳本的程式碼決定要不要呼叫、呼叫
 *     哪個工具,不依賴任何真實模型的自由選擇),但走的是完整的真實管線:
 *     AcpAdapter 核發的 scoped token → 真的透過 WS 打回 gateway → 真的觸發
 *     TeamBusPort/SubagentPort 對應的方法——見
 *     packages/adapters/src/mcp-bridge-server.ts 的完整安全/協定說明。
 *     `mcpServers` 陣列為空(這個 session 沒有掛任何 MCP server,例如沒有
 *     team/subagentPort 的一般 ACP session)時,回覆一則固定的錯誤文字
 *     `"BRIDGE_TOOL_RESULT_ERROR: no mcpServers configured"`,不嘗試 spawn
 *     任何東西。
 */

import * as acp from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";
import { writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export const FAKE_ACP_REPLY_CHUNKS = ["Hello", " from", " fake ACP agent"];
export const WRITE_FILE_PREFIX = "ACP_WRITE_FILE ";
/** S3a(usage-metering)e2e 用,見檔頭註解。 */
export const USAGE_UPDATE_PREFIX = "ACP_USAGE_UPDATE ";
/** S3b(cost-governor)TurnLimiter e2e 用,見檔頭註解。 */
export const MANY_TOOL_CALLS_PREFIX = "ACP_MANY_TOOL_CALLS ";
/** S3b(cost-governor)TurnLimiter e2e 用,見檔頭註解。 */
export const SLEEP_TURN_PREFIX = "ACP_SLEEP_TURN ";
/** 這輪(slash command)e2e 用,見檔頭註解。 */
export const AVAILABLE_COMMANDS_PREFIX = "ACP_AVAILABLE_COMMANDS ";
/** Codex ACP 橋接切換 Phase 3(diff 顯示)路徑 A e2e 用,見檔頭註解。 */
export const DIFF_CONTENT_PREFIX = "ACP_DIFF_CONTENT ";
/** Phase 2(ACP scoped MCP bridge token)e2e 用,見檔頭註解。 */
export const CALL_BRIDGE_TOOL_PREFIX = "ACP_CALL_BRIDGE_TOOL ";
/**
 * Phase 2 e2e 用(不接受任何參數,純字面比對):把這個 session 於
 * `session/new` 收到的完整 `mcpServers` 陣列(含 `AcpAdapter.spawn()` 核發的
 * scoped token 本身,見 `newSession()`)原樣 JSON 化回顯。給
 * scripts/e2e-gateway.mjs 用來取出**真實核發**的 token/gatewayUrl,直接用
 * `GatewayClient` 對 gateway 做低階的白名單/綁定範圍/過期/撤銷決定性測試
 * (不透過 MCP 協議本身走一輪——那部分由 `CALL_BRIDGE_TOOL_PREFIX` 涵蓋),
 * 兩者互補,合起來涵蓋「token 核發的內容正確」與「token 真的能驅動完整
 * MCP 管線」兩個不同的斷言面向。
 */
export const REPORT_MCP_SERVERS_PREFIX = "ACP_REPORT_MCP_SERVERS";
/** 建構出一段「延遲 delayMs 毫秒後把整段 prompt 文字回顯」的標記文字。 */
export function delayEchoMarker(delayMs) {
  return `[[E2E_DELAY_ECHO:${delayMs}]]`;
}
const DELAY_ECHO_PATTERN = /\[\[E2E_DELAY_ECHO:(\d+)\]\]/;

class FakeAcpAgent {
  constructor() {
    /** @type {Map<string, { abort: AbortController | null }>} */
    this.sessions = new Map();
  }

  async initialize() {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: { loadSession: false },
    };
  }

  async newSession(params) {
    const sessionId = randomUUID();
    // Phase 2(ACP scoped MCP bridge token)e2e 用:把這次 `session/new` 請求
    // 帶的 `mcpServers`(AcpAdapter.spawn() 透過 `SessionBuilder.
    // withMcpServer()` 掛上的設定,見檔頭註解)存起來,供
    // `handleCallBridgeTool()` 之後真的拿去 spawn 成子行程。沒有掛任何
    // server 時(這個 session 沒有 team/subagentPort)是空陣列,不是
    // undefined(見 NewSessionRequest.mcpServers 的型別——必填欄位)。
    this.sessions.set(sessionId, { abort: null, mcpServers: params?.mcpServers ?? [] });
    return { sessionId };
  }

  async authenticate() {
    return {};
  }

  async setSessionMode() {
    return {};
  }

  cancel(params) {
    this.sessions.get(params.sessionId)?.abort?.abort();
  }

  async prompt(params, cx) {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw new Error(`未知的 ACP session: ${params.sessionId}`);
    }

    const text = extractText(params.prompt);
    const abort = new AbortController();
    session.abort = abort;

    try {
      if (DELAY_ECHO_PATTERN.test(text)) {
        await this.handleDelayEcho(params.sessionId, text, cx);
      } else if (text.startsWith(WRITE_FILE_PREFIX)) {
        await this.handleWriteFile(params.sessionId, text.slice(WRITE_FILE_PREFIX.length), cx);
      } else if (text.startsWith(USAGE_UPDATE_PREFIX)) {
        await this.handleUsageUpdate(params.sessionId, text.slice(USAGE_UPDATE_PREFIX.length), cx);
      } else if (text.startsWith(MANY_TOOL_CALLS_PREFIX)) {
        await this.handleManyToolCalls(params.sessionId, text.slice(MANY_TOOL_CALLS_PREFIX.length), cx);
      } else if (text.startsWith(SLEEP_TURN_PREFIX)) {
        await this.handleSleepTurn(params.sessionId, text.slice(SLEEP_TURN_PREFIX.length), abort, cx);
      } else if (text.startsWith(AVAILABLE_COMMANDS_PREFIX)) {
        await this.handleAvailableCommands(params.sessionId, text.slice(AVAILABLE_COMMANDS_PREFIX.length), cx);
      } else if (text.startsWith(DIFF_CONTENT_PREFIX)) {
        await this.handleDiffContent(params.sessionId, text.slice(DIFF_CONTENT_PREFIX.length), cx);
      } else if (text.startsWith(CALL_BRIDGE_TOOL_PREFIX)) {
        await this.handleCallBridgeTool(params.sessionId, text.slice(CALL_BRIDGE_TOOL_PREFIX.length), cx);
      } else if (text === REPORT_MCP_SERVERS_PREFIX) {
        await this.handleReportMcpServers(params.sessionId, cx);
      } else {
        await this.handleEcho(params.sessionId, cx);
      }
    } finally {
      session.abort = null;
    }

    return { stopReason: abort.signal.aborted ? "cancelled" : "end_turn" };
  }

  async handleEcho(sessionId, cx) {
    const messageId = randomUUID();
    for (const chunk of FAKE_ACP_REPLY_CHUNKS) {
      await cx.notify(acp.methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId,
          content: { type: "text", text: chunk },
        },
      });
    }
  }

  /** 見檔頭註解:延遲後把完整收到的 prompt 文字加上 "ECHO:" 前綴回顯。 */
  async handleDelayEcho(sessionId, text, cx) {
    const match = text.match(DELAY_ECHO_PATTERN);
    const delayMs = match ? Number(match[1]) : 0;
    if (delayMs > 0) {
      await delay(delayMs);
    }
    const messageId = randomUUID();
    await cx.notify(acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId,
        content: { type: "text", text: `ECHO:${text}` },
      },
    });
  }

  /** S3a(usage-metering)e2e 用,見檔頭註解:送一則 usage_update,cost 有給才附帶。 */
  async handleUsageUpdate(sessionId, rawJson, cx) {
    const { used, size, cost } = JSON.parse(rawJson);
    await cx.notify(acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "usage_update",
        used,
        size,
        ...(cost ? { cost } : {}),
      },
    });

    const messageId = randomUUID();
    await cx.notify(acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId,
        content: { type: "text", text: "usage reported" },
      },
    });
  }

  /** 這輪(slash command)e2e 用,見檔頭註解:送一則 available_commands_update,`hint` 有給才組進 `input`。 */
  async handleAvailableCommands(sessionId, rawJson, cx) {
    const { commands } = JSON.parse(rawJson);
    await cx.notify(acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: commands.map((c) => ({
          name: c.name,
          description: c.description ?? "",
          ...(c.hint ? { input: { hint: c.hint } } : {}),
        })),
      },
    });

    const messageId = randomUUID();
    await cx.notify(acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId,
        content: { type: "text", text: "commands reported" },
      },
    });
  }

  /**
   * Codex ACP 橋接切換 Phase 3(diff 顯示)路徑 A e2e 用,見檔頭註解:送出
   * 一則帶原生 `type:"diff"` content block 的 `tool_call_update`,不觸碰真實
   * 檔案系統。`tool_call` 刻意不帶 `locations`,確保這個情境不會意外也命中
   * 路徑 B(檔案快照 fallback)。
   */
  async handleDiffContent(sessionId, rawJson, cx) {
    const { path: diffPath, oldText, newText } = JSON.parse(rawJson);
    const toolCallId = `diff-${randomUUID()}`;

    await cx.notify(acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId,
        title: "Apply patch",
        kind: "edit",
        status: "pending",
        rawInput: { path: diffPath },
      },
    });

    await cx.notify(acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "completed",
        content: [
          {
            type: "diff",
            path: diffPath,
            ...(oldText !== undefined ? { oldText } : {}),
            newText,
          },
        ],
        rawOutput: { success: true },
      },
    });

    const messageId = randomUUID();
    await cx.notify(acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId,
        content: { type: "text", text: "diff reported" },
      },
    });
  }

  /**
   * Phase 2(ACP scoped MCP bridge token)e2e 用,見檔頭註解:真的把
   * `session/new` 收到的 `mcpServers[0]` 當成 `StdioServerParameters` spawn
   * 成子行程,用真正的 MCP client 連上去呼叫一個工具,把結果回顯成訊息。
   * `mcpServers` 為空時不嘗試 spawn 任何東西,直接回覆固定的錯誤文字——見
   * 檔頭註解對這個分支的完整說明。
   */
  async handleCallBridgeTool(sessionId, rawJson, cx) {
    const session = this.sessions.get(sessionId);
    const { tool: toolName, args } = JSON.parse(rawJson);
    const mcpServer = session?.mcpServers?.[0];
    const messageId = randomUUID();

    if (!mcpServer) {
      await cx.notify(acp.methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId,
          content: { type: "text", text: "BRIDGE_TOOL_RESULT_ERROR: no mcpServers configured" },
        },
      });
      return;
    }

    // `schema.McpServerStdio` 的 `env` 是 `Array<{name, value}>`(ACP 協議的
    // wire 形狀),`StdioClientTransport`(MCP SDK 的 client-side transport,
    // 自己會 spawn 子行程並接管它的 stdio)要的是 `Record<string,string>`
    // ——這裡做形狀轉換,不改變任何實際的 key/value。
    const env = Object.fromEntries((mcpServer.env ?? []).map((e) => [e.name, e.value]));
    const transport = new StdioClientTransport({
      command: mcpServer.command,
      args: mcpServer.args ?? [],
      env: { ...process.env, ...env },
    });
    const client = new Client({ name: "deskmony-fake-acp-agent-bridge-client", version: "1.0.0" });

    let resultText;
    try {
      await client.connect(transport);
      const result = await client.callTool({ name: toolName, arguments: args ?? {} });
      resultText = `BRIDGE_TOOL_RESULT:${JSON.stringify(result)}`;
    } catch (err) {
      resultText = `BRIDGE_TOOL_RESULT_ERROR: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      try {
        await client.close();
      } catch {
        // ignore
      }
    }

    await cx.notify(acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId,
        content: { type: "text", text: resultText },
      },
    });
  }

  /** Phase 2 e2e 用,見 REPORT_MCP_SERVERS_PREFIX 的檔頭/常數註解。 */
  async handleReportMcpServers(sessionId, cx) {
    const session = this.sessions.get(sessionId);
    const messageId = randomUUID();
    await cx.notify(acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId,
        content: { type: "text", text: `MCP_SERVERS:${JSON.stringify(session?.mcpServers ?? [])}` },
      },
    });
  }

  /**
   * S3b(cost-governor)TurnLimiter e2e 用,見檔頭註解:在同一輪內連續送出
   * `count` 則 `tool_call` 通知。`delayMs`(選填)在每次通知之間插入延遲,
   * 讓 core 端「第 N 次工具呼叫超標 → interrupt()」有時間真的在這個迴圈**中途**
   * 生效(每次迴圈都檢查 `abort.signal.aborted` 提早跳出),而不是整批瞬間
   * 送完才讓 core 事後才發現——用來決定性地證明 interrupt 真的中斷了正在
   * 進行的回合,不只是「core 決定要中斷但 agent 根本沒感覺到」。
   */
  async handleManyToolCalls(sessionId, rawJson, cx) {
    const { count, delayMs } = JSON.parse(rawJson);
    const session = this.sessions.get(sessionId);
    for (let i = 0; i < count; i++) {
      if (session?.abort?.signal.aborted) break;
      await cx.notify(acp.methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: `bulk-${i}-${randomUUID()}`,
          title: `BulkTool-${i}`,
          kind: "other",
          status: "completed",
          rawInput: { index: i },
        },
      });
      if (typeof delayMs === "number" && delayMs > 0) {
        try {
          await delay(delayMs, undefined, { signal: session?.abort?.signal });
        } catch {
          break;
        }
      }
    }
    if (session?.abort?.signal.aborted) return;
    const messageId = randomUUID();
    await cx.notify(acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId,
        content: { type: "text", text: `已送出 ${count} 次工具呼叫` },
      },
    });
  }

  /** S3b(cost-governor)TurnLimiter e2e 用,見檔頭註解:睡滿 `ms` 毫秒(可被
   *  `abort` 提早取消)後才結束這一輪。 */
  async handleSleepTurn(sessionId, rawJson, abort, cx) {
    const { ms } = JSON.parse(rawJson);
    try {
      await delay(ms, undefined, { signal: abort.signal });
    } catch {
      // 被 abort(session/cancel 抵達)提早中止——正常路徑,不視為錯誤。
      return;
    }
    const messageId = randomUUID();
    await cx.notify(acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId,
        content: { type: "text", text: `睡了 ${ms}ms 後正常結束` },
      },
    });
  }

  async handleWriteFile(sessionId, rawJson, cx) {
    const { path: targetPath, content, delayMs } = JSON.parse(rawJson);
    // 見檔頭註解:選填的前置延遲,給 e2e 腳本製造「權限請求送達 core 時,
    // 一個 client 都沒連著」的時間窗。
    if (typeof delayMs === "number" && delayMs > 0) {
      await delay(delayMs);
    }
    const messageId = randomUUID();

    await cx.notify(acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId,
        content: { type: "text", text: "好的,準備寫入檔案。" },
      },
    });

    const toolCallId = `write-${randomUUID()}`;
    await cx.notify(acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId,
        title: "Write file",
        kind: "edit",
        status: "pending",
        locations: [{ path: targetPath }],
        rawInput: { path: targetPath, content },
      },
    });

    const permissionResponse = await cx.request(acp.methods.client.session.requestPermission, {
      sessionId,
      toolCall: {
        toolCallId,
        title: "Write file",
        kind: "edit",
        status: "pending",
        rawInput: { path: targetPath, content },
      },
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "deny", name: "Reject", kind: "reject_once" },
      ],
    });

    const outcome = permissionResponse.outcome;
    const allowed = outcome.outcome === "selected" && outcome.optionId === "allow";

    if (!allowed) {
      // 拒絕(或使用者取消):不寫檔、不送 tool_call_update,直接結束這一輪。
      return;
    }

    writeFileSync(targetPath, content, "utf8");

    await cx.notify(acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "completed",
        rawOutput: { success: true },
      },
    });

    await cx.notify(acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId,
        content: { type: "text", text: "已完成寫入。" },
      },
    });
  }
}

function extractText(prompt) {
  const blocks = Array.isArray(prompt) ? prompt : [prompt];
  return blocks
    .filter((block) => block && block.type === "text")
    .map((block) => block.text)
    .join("");
}

async function main() {
  const input = Writable.toWeb(process.stdout);
  const output = Readable.toWeb(process.stdin);
  const stream = acp.ndJsonStream(input, output);
  const agent = new FakeAcpAgent();

  acp
    .agent({ name: "deskmony-fake-acp-agent" })
    .onRequest(acp.methods.agent.initialize, () => agent.initialize())
    .onRequest(acp.methods.agent.session.new, (ctx) => agent.newSession(ctx.params))
    .onRequest(acp.methods.agent.authenticate, () => agent.authenticate())
    .onRequest(acp.methods.agent.session.setMode, () => agent.setSessionMode())
    .onRequest(acp.methods.agent.session.prompt, (ctx) => agent.prompt(ctx.params, ctx.client))
    .onNotification(acp.methods.agent.session.cancel, (ctx) => agent.cancel(ctx.params))
    .connect(stream);
}

// 只有「被當成獨立程序直接執行」時才啟動 stdio 連線(即 AcpAdapter.spawn()
// 啟動這支腳本的情境)。scripts/e2e-gateway.mjs 也會 `import` 這個檔案來
// 取用 FAKE_ACP_REPLY_CHUNKS / WRITE_FILE_PREFIX 常數(維持 prompt 文字與
// 這支 agent 的實際判斷邏輯同一個 source of truth),那種情況下不能連帶
// 把 e2e 腳本自己的 stdin/stdout 接管走。
const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((err) => {
    console.error("[fake-acp-agent] fatal:", err);
    process.exit(1);
  });
}
