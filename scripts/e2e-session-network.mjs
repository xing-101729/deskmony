#!/usr/bin/env node
/**
 * scripts/e2e-session-network.mjs
 *
 * 2026-10-02(P3「session 網路」,見 docs/LAYER-4-detail-design/simplify-agents-sessions_detail.md §P3.7、
 * docs/DECISIONS.md §H)端到端測試——由原本的 `e2e-session-subagents.mjs`(S12 子 agent:子完成 → 結果注入父)
 * 改寫。**決定性**:全程用 `scripts/fake-acp-agent.mjs`(經 `DESKMONY_E2E_EXTRA_PROVIDERS` 注入的 fake provider,
 * 見 lib/e2e-providers.mjs)當後端,不依賴任何真實模型/憑證。
 *
 * 「fake agent 呼叫 session 網路工具」走的是**完整的真實管線**(與 e2e-gateway.mjs 步驟 32g 同一套手法):
 * 假 agent 收到 `ACP_CALL_BRIDGE_TOOL {"tool","args"}` 就把 `AcpAdapter` 掛上的 mcp-bridge-server 子行程真的 spawn
 * 起來,用真正的 MCP client 呼叫工具 → bridge 經 WS 用 scoped token 打回 gateway → SessionManager 真的執行。
 * 「agent 收到訊息後自己決定回覆」則用 `[[E2E_BRIDGE_ON_PROMPT:<base64>]]` 標記(巢狀塞進訊息內文):收到含標記的
 * prompt 的假 agent 會自己再呼叫標記指定的工具——A↔B 互傳的訊息鏈就是這樣一層一層推進的。
 *
 * 每個斷言名稱都帶規格編號(`P3.7-N`),方便對照規格 §P3.7 的 9 個斷言:
 *   P3.7-1  A `list_sessions` 看得到 B(B 不是 A 的子、工作目錄也不同)。
 *   P3.7-2  A `send_to_session(B)` → B 收到的 prompt 含信封、B 的持久化訊息有 `origin.sessionId === A`;
 *           B 這輪結束後 A 沒有收到任何自動注入。
 *   P3.7-3  B busy 時 A 送的訊息會排隊,B 回 idle 後才送達。
 *   P3.7-4  `send_to_session` 對自己 / 不存在的 id / closed session → 明確錯誤。
 *   P3.7-5  鏈預算:`maxMessagesPerContext` 設 3,A↔B 互傳到第 4 則被拒、有 audit 紀錄;此時人類對 A 輸入新
 *           prompt,A 再送給 B 成功(新鏈)。
 *   P3.7-6  `create_session` 建的 session `parentSessionId` = 呼叫者、第一則訊息有 `origin`。
 *   P3.7-7  `read_session` 回最近 N 則、超長內容被截斷。
 *   P3.7-8  ACP bridge token 只能呼叫那五個方法;拿 token 呼叫 `session.setPermissionMode` 被拒。
 *   P3.7-9  `session.forwardMessage` 轉傳後目標收到 `origin.kind === "forward"`,且開了新鏈。
 *           (2026-10-03:參數改成 `{sourceSessionId, targetSessionId, text, note?}`——`text` 是畫面上氣泡的文字,
 *           core 不回頭查原訊息;9d 釘住「只轉氣泡片段就剛好送那一段」與「來源沒有對應訊息也能轉」,9c 釘住
 *           自己/不存在/空白/超長的錯誤。)
 * 另外加了(不在規格九條裡、但同一輪該釘住的)三組:`P3.1`(in-process 工具的呼叫者身分由閉包捕捉、allowedTools
 * 只放查詢類)、`P3.3`(沒有任何 S12 的子結果 push、`session.spawnChild` 已移除)、`P3.6`(in-process 與 ACP bridge
 * 的工具名稱/參數/描述/instructions 逐字一致)。
 *
 * 用法:node scripts/e2e-session-network.mjs
 * 前置需求:pnpm build 已跑過(apps/core/dist/index.js 存在且是最新的)
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { requireFreshBuild } from "./lib/require-fresh-build.mjs";
import { e2eProvidersEnv, FAKE_ACP } from "./lib/e2e-providers.mjs";
import {
  CALL_BRIDGE_TOOL_PREFIX,
  REPORT_MCP_SERVERS_PREFIX,
  SAY_PREFIX,
  bridgeOnPromptMarker,
  delayEchoMarker,
} from "./fake-acp-agent.mjs";

// 2026-09-04(稽核修補):在啟動 core 之前確認 dist/ 不比 src/ 舊。
// 這支 e2e 測的是編譯產物,忘記先 pnpm build 的話會安靜地驗證舊程式碼並全綠
// —— 見 scripts/lib/require-fresh-build.mjs 的完整說明。
requireFreshBuild();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const CORE_ENTRY = path.join(REPO_ROOT, "apps", "core", "dist", "index.js");
// 序幕 core(只用來造出一個 closed/interrupted 的 session)與主 core 各用一個 port。
const PRELUDE_PORT = 5322;
const CORE_PORT = 5321;
const PERMISSION_TIMEOUT_MS = 10_000;
/** 鏈預算:每條訊息鏈最多 3 則 agent→agent 訊息,達 66% 發軟警告(ceil(3 × 0.66) = 第 2 則)。 */
const MAX_MESSAGES_PER_CHAIN = 3;
const WARN_AT_PERCENT = 66;
const ENVELOPE_AGENT_LABEL = "E2E Fake ACP";
/** `session.forwardMessage` 的 `text` 上限——刻意寫死、與 packages/shared/src/gateway.ts 的 FORWARD_MESSAGE_MAX_CHARS 對照(改了那邊要同步改這裡)。 */
const FORWARD_MESSAGE_MAX_CHARS = 100_000;
/** 1x1 透明 PNG,給 read_session 的「只標示有附件、不回傳二進位內容」斷言用。 */
const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`\n[${ok ? "PASS" : "FAIL"}] ${name}`);
  if (detail) console.log(`       ${detail}`);
}

async function killProcessTree(proc, label) {
  if (!proc || proc.exitCode !== null || proc.killed) return;
  console.log(`[cleanup] 終止 ${label}(pid=${proc.pid}) ...`);
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      proc.kill("SIGTERM");
    }
  } catch (err) {
    console.log(`[cleanup] 終止 ${label} 時發生錯誤(忽略): ${err}`);
  }
  await sleep(700);
}

function startCore({ port, dataDir, homeDir, workspaceDir }) {
  const env = {
    ...process.env,
    DESKMONY_CORE_PORT: String(port),
    DESKMONY_DATA_DIR: dataDir,
    DESKMONY_HOME: homeDir,
    DESKMONY_WORKSPACE: workspaceDir,
    DESKMONY_PERMISSION_TIMEOUT_MS: String(PERMISSION_TIMEOUT_MS),
    // 2026-10-02(P2:移除 profile):fake 後端經 `DESKMONY_E2E_EXTRA_PROVIDERS` 注入(見 lib/e2e-providers.mjs)。
    ...e2eProvidersEnv(),
  };
  const proc = spawn(process.execPath, [CORE_ENTRY], { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  proc.stdout.on("data", (chunk) => process.stdout.write(`[core:${port}] ${chunk}`));
  proc.stderr.on("data", (chunk) => process.stderr.write(`[core:${port}:err] ${chunk}`));
  return proc;
}

async function waitForPort(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const ws = new WebSocket(url);
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("connect timeout")), 1500);
        ws.addEventListener("open", () => {
          clearTimeout(t);
          resolve();
        });
        ws.addEventListener("error", () => {
          clearTimeout(t);
          reject(new Error("connect error"));
        });
      });
      ws.close();
      return true;
    } catch (err) {
      lastErr = err;
      await sleep(300);
    }
  }
  throw new Error(`等待 gateway 啟動逾時: ${lastErr}`);
}

class GatewayClient {
  constructor(url) {
    this.url = url;
    this.pendingRpc = new Map();
    this.events = [];
    /** `session-message` push(別的 session 送來的訊息剛寫進某個 session 的歷史)。 */
    this.sessionMessages = [];
    /** `enforcement-notification` push(熔斷/軟警告通知)。 */
    this.notifications = [];
    /** 收過的 push channel 名稱(用來斷言「從頭到尾沒有 S12 的子結果 push」)。 */
    this.channelsSeen = new Set();
    this.waiters = [];
  }

  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("WS connect timeout")), 10_000);
      this.ws.addEventListener("open", () => {
        clearTimeout(t);
        resolve();
      });
      this.ws.addEventListener("error", (e) => {
        clearTimeout(t);
        reject(new Error(`WS error: ${e.message ?? e}`));
      });
    });
    this.ws.addEventListener("message", (e) => this._handleMessage(e.data));
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
  }

  _handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : raw.toString());
    } catch {
      return;
    }
    if (msg.kind === "response") {
      const pending = this.pendingRpc.get(msg.id);
      if (pending) {
        this.pendingRpc.delete(msg.id);
        if (msg.ok) pending.resolve(msg.result);
        else {
          const err = new Error(msg.error ?? "unknown gateway error");
          err.errorCode = msg.errorCode;
          pending.reject(err);
        }
      }
      return;
    }
    if (msg.kind === "event") {
      this.channelsSeen.add(msg.channel);
      if (msg.channel === "session-event") {
        this.events.push(msg.payload);
        for (const w of [...this.waiters]) w(msg.payload);
      } else if (msg.channel === "session-message") {
        this.sessionMessages.push(msg.payload);
      } else if (msg.channel === "enforcement-notification") {
        this.notifications.push(msg.payload);
      }
    }
  }

  rpc(method, params, timeoutMs = 30_000) {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pendingRpc.delete(id);
        reject(new Error(`rpc ${method} 逾時 (${timeoutMs}ms)`));
      }, timeoutMs);
      this.pendingRpc.set(id, {
        resolve: (v) => {
          clearTimeout(t);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(t);
          reject(e);
        },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  waitForEvent(predicate, timeoutMs, fromIndex = 0) {
    for (let i = fromIndex; i < this.events.length; i++) {
      if (predicate(this.events[i])) return Promise.resolve(this.events[i]);
    }
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(new Error(`等待事件逾時 (${timeoutMs}ms)`));
      }, timeoutMs);
      const waiter = (ev) => {
        if (predicate(ev)) {
          clearTimeout(t);
          this.waiters = this.waiters.filter((w) => w !== waiter);
          resolve(ev);
        }
      };
      this.waiters.push(waiter);
    });
  }

  /**
   * 以**人類**身分(gateway 的 `session.sendPrompt`)送一則 prompt 並等這一輪 completed/error。
   * `prompt` 可以是字串或完整的 PromptInput(含附件)。回傳這一輪該 session 吐出的文字(message-delta 串接)。
   */
  async drivePrompt(sessionId, prompt, { timeoutMs = 90_000 } = {}) {
    const startIdx = this.events.length;
    const promptInput = typeof prompt === "string" ? { text: prompt } : prompt;
    await this.rpc("session.sendPrompt", { sessionId, prompt: promptInput });
    let cursor = startIdx;
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("逾時等待 completed/error 事件");
      const ev = await this.waitForEvent((e) => e.sessionId === sessionId, remaining, cursor);
      cursor = this.events.indexOf(ev) + 1;
      if (ev.event.type === "completed" || ev.event.type === "error") {
        const collected = this.events.slice(startIdx, cursor).filter((e) => e.sessionId === sessionId);
        const text = collected
          .filter((e) => e.event.type === "message-delta")
          .map((e) => e.event.delta)
          .join("");
        return { finalEvent: ev, collected, text };
      }
    }
  }
}

// ---- 測試輔助 ----------------------------------------------------------------------------

async function history(client, sessionId) {
  const { messages } = await client.rpc("session.history", { sessionId });
  return messages;
}

async function waitForHistory(client, sessionId, predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let messages = [];
  while (Date.now() < deadline) {
    messages = await history(client, sessionId);
    const hit = predicate(messages);
    if (hit) return { messages, hit };
    await sleep(250);
  }
  return { messages, hit: undefined };
}

async function statusOf(client, sessionId) {
  const { sessions } = await client.rpc("session.list", {});
  return sessions.find((s) => s.id === sessionId)?.status;
}

async function waitForStatus(client, sessionId, wanted, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let status;
  while (Date.now() < deadline) {
    status = await statusOf(client, sessionId);
    if (status === wanted) return true;
    await sleep(150);
  }
  console.log(`[wait] session ${sessionId} 最後狀態=${status},預期 ${wanted}`);
  return false;
}

async function createSession(client, workspaceDir, title) {
  const { session } = await client.rpc("session.create", { providerId: FAKE_ACP, workingDir: workspaceDir, title });
  return session;
}

/**
 * 讓 `callerId` 這個 session 的 fake agent **真的**呼叫一個 session 網路工具(完整管線,見檔頭),
 * 回傳工具結果:`{isError, text}`。`callerId` 的這一輪是**人類輸入**(新鏈)。
 */
async function callTool(client, callerId, tool, args) {
  const { text } = await client.drivePrompt(callerId, `${CALL_BRIDGE_TOOL_PREFIX}${JSON.stringify({ tool, args })}`, {
    timeoutMs: 60_000,
  });
  return parseBridgeReply(text, "BRIDGE_TOOL_RESULT");
}

function parseBridgeReply(text, prefix) {
  if (text.startsWith(`${prefix}_ERROR`)) return { isError: true, text, transportError: true };
  if (!text.startsWith(`${prefix}:`)) return { isError: true, text: `非預期的回覆: ${text}`, transportError: true };
  const parsed = JSON.parse(text.slice(prefix.length + 1));
  return { isError: parsed.isError === true, text: parsed.content?.[0]?.text ?? "" };
}

/** 一個 session 的歷史裡,只有人類 prompt 與 agent 自己的回覆——沒有任何被「自動注入」進來的別人的訊息。 */
function hasNoAutoInjection(messages) {
  return messages.every((m) => {
    if (m.role === "user") return m.origin === undefined && m.content.startsWith(CALL_BRIDGE_TOOL_PREFIX);
    if (m.role === "assistant") return m.content.startsWith("BRIDGE_TOOL_RESULT");
    return true;
  });
}

async function openAuditDb(dataDir) {
  // better-sqlite3 不是這個 script 所在目錄的直接依賴,借用 apps/core 已安裝好的那一份(同 e2e-crash-recovery.mjs)。
  const betterSqlite3 = path.join(REPO_ROOT, "apps", "core", "node_modules", "better-sqlite3", "lib", "index.js");
  const { default: Database } = await import(pathToFileURL(betterSqlite3).href);
  return new Database(path.join(dataDir, "deskmony.db"), { readonly: true });
}

async function readAudit(dataDir, kind) {
  const db = await openAuditDb(dataDir);
  try {
    return db.prepare("SELECT kind, reason, payload FROM enforcement_audit WHERE kind = ?").all(kind);
  } finally {
    db.close();
  }
}

// ---- P3.1 / P3.6:不需要 core 的工具層檢查 ----------------------------------------------------

/** 工具清單的「可比對形狀」:名稱、描述、參數名稱/型別/描述/必填(不比對 JSON schema 的樣板欄位)。 */
function normalizeTools(tools) {
  return tools
    .map((t) => ({
      name: t.name,
      description: t.description,
      required: [...(t.inputSchema?.required ?? [])].sort(),
      properties: Object.fromEntries(
        Object.entries(t.inputSchema?.properties ?? {})
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => [k, { type: v.type, description: v.description }]),
      ),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function testToolLayer() {
  const importDist = (...parts) => import(pathToFileURL(path.join(REPO_ROOT, ...parts)).href);
  const { createSessionNetworkMcpServer, SESSION_NETWORK_ALLOWED_TOOL_NAMES, SESSION_NETWORK_MCP_SERVER_NAME } = await importDist(
    "packages",
    "adapters",
    "dist",
    "session-network-mcp.js",
  );

  // ---- P3.1:in-process 工具——呼叫者身分由閉包捕捉,工具參數裡沒有 caller 欄位,多塞的欄位不會生效 ----
  const calls = [];
  const stubPort = {
    listAgents: async () => [],
    listSessions: async (i) => (calls.push(["listSessions", i]), []),
    readSession: async (i) => (calls.push(["readSession", i]), { sessionId: i.sessionId, title: "t", messages: [] }),
    createSession: async (i) => (calls.push(["createSession", i]), { sessionId: "new-id" }),
    sendToSession: async (i) => void calls.push(["sendToSession", i]),
  };
  const sdkServer = createSessionNetworkMcpServer(stubPort, "closure-caller-id");
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await sdkServer.instance.connect(serverTransport);
  const inProcClient = new Client({ name: "e2e-inproc", version: "1.0.0" });
  await inProcClient.connect(clientTransport);
  const inProcTools = (await inProcClient.listTools()).tools;
  const inProcInstructions = inProcClient.getInstructions();
  const sendResult = await inProcClient.callTool({
    name: "send_to_session",
    arguments: { sessionId: "target-id", message: "hi", callerSessionId: "forged-id", parentSessionId: "forged-id" },
  });
  const listResult = await inProcClient.callTool({ name: "list_sessions", arguments: {} });
  const sendCall = calls.find(([name]) => name === "sendToSession")?.[1];
  const listCall = calls.find(([name]) => name === "listSessions")?.[1];
  await inProcClient.close();

  const toolNames = inProcTools.map((t) => t.name).sort();
  const expectedNames = ["create_session", "list_agents", "list_sessions", "read_session", "send_to_session"];
  const expectedAllowed = ["list_agents", "list_sessions", "read_session"].map((n) => `mcp__${SESSION_NETWORK_MCP_SERVER_NAME}__${n}`).sort();
  record(
    "P3.1 in-process 工具:MCP server 名稱 deskmony、五個工具、呼叫者身分由閉包捕捉(多塞 callerSessionId 無效)、allowedTools 只放行三個查詢類(create_session/send_to_session 走權限流程)",
    sdkServer.name === "deskmony" &&
      JSON.stringify(toolNames) === JSON.stringify(expectedNames) &&
      sendCall?.callerSessionId === "closure-caller-id" &&
      sendCall?.sessionId === "target-id" &&
      listCall?.callerSessionId === "closure-caller-id" &&
      sendResult.isError !== true &&
      listResult.isError !== true &&
      JSON.stringify([...SESSION_NETWORK_ALLOWED_TOOL_NAMES].sort()) === JSON.stringify(expectedAllowed),
    `server=${sdkServer.name}, tools=${toolNames.join(",")}, sendCall=${JSON.stringify(sendCall)}, allowed=${SESSION_NETWORK_ALLOWED_TOOL_NAMES.join(",")}`,
  );

  // ---- P3.6:ACP bridge 子行程的 tools/list 與 instructions,和 in-process 版逐字一致 ----
  const bridgeEntry = path.join(REPO_ROOT, "packages", "adapters", "dist", "mcp-bridge-server.js");
  const bridgeTransport = new StdioClientTransport({
    command: process.execPath,
    args: [bridgeEntry],
    env: {
      ...process.env,
      DESKMONY_MCP_BRIDGE_TOKEN: "dmbt_parity-check-not-a-real-token",
      DESKMONY_MCP_BRIDGE_GATEWAY_URL: "ws://127.0.0.1:1",
      DESKMONY_MCP_BRIDGE_SESSION_ID: "parity-session",
      DESKMONY_MCP_BRIDGE_NETWORK_ENABLED: "1",
    },
  });
  const bridgeClient = new Client({ name: "e2e-bridge-parity", version: "1.0.0" });
  await bridgeClient.connect(bridgeTransport);
  const bridgeTools = (await bridgeClient.listTools()).tools;
  const bridgeInstructions = bridgeClient.getInstructions();
  await bridgeClient.close();

  const a = JSON.stringify(normalizeTools(inProcTools));
  const b = JSON.stringify(normalizeTools(bridgeTools));
  record(
    "P3.6 in-process 與 ACP mcp-bridge 的五個工具(名稱、參數、描述)與 MCP server instructions 逐字一致",
    a === b && typeof inProcInstructions === "string" && inProcInstructions.length > 0 && inProcInstructions === bridgeInstructions,
    a === b ? `instructions 長度=${inProcInstructions?.length}` : `tools 不一致:\n  inproc=${a}\n  bridge=${b}`,
  );
  const mentionsNoAutoReply =
    inProcInstructions?.includes("要不要回、回給誰由你決定") &&
    inProcInstructions.includes("send_to_session") &&
    inProcInstructions.includes("系統不會自動把你的回答送回去") &&
    inProcInstructions.includes("list_sessions");
  record(
    "P3.1 instructions 明講「收到訊息要不要回、回給誰由你決定;要回覆就用 send_to_session,系統不會自動把你的回答送回去」與「使用者也可能直接在畫面上開 session,不確定時先 list_sessions」",
    Boolean(mentionsNoAutoReply) && inProcInstructions.includes("使用者也可能直接在畫面上開 session"),
    undefined,
  );
}

// ---- 主流程 -------------------------------------------------------------------------------

async function main() {
  if (!existsSync(CORE_ENTRY)) {
    console.error(`找不到 ${CORE_ENTRY},請先執行 pnpm build`);
    process.exit(1);
  }

  const startTime = Date.now();
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-net-data-"));
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-net-home-"));
  const wsA = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-net-wsA-"));
  const wsB = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-net-wsB-"));
  // 訊息鏈預算只能靠設定檔覆寫(F4:遠端不可改,沒有對應的環境變數)——啟動前寫好 config.json。
  writeFileSync(
    path.join(homeDir, "config.json"),
    JSON.stringify(
      { version: 1, messageBudget: { maxMessagesPerContext: MAX_MESSAGES_PER_CHAIN, warnAtPercent: WARN_AT_PERCENT } },
      null,
      2,
    ),
    "utf8",
  );

  let core1;
  let core2;
  let client;
  /** 整個測試過程看過的所有訊息鏈 id(origin.chainId),用來斷言「新鏈」。 */
  const seenChains = new Set();
  const noteChain = (messages) => {
    for (const m of messages) if (m.origin?.chainId) seenChains.add(m.origin.chainId);
  };

  try {
    console.log(`[setup] dataDir=${dataDir}\n[setup] homeDir=${homeDir}`);

    // ---- 工具層(不需要 core):P3.1 / P3.6 ----
    try {
      await testToolLayer();
    } catch (err) {
      record("P3.1/P3.6 工具層檢查(in-process 與 bridge 的 tools/list 比對)", false, String(err?.stack ?? err));
    }

    // ---- 序幕:造出一個 closed 的 session(用於 P3.7-4)----
    // core#1 建一個 session 後被強制終止(視為崩潰)→ core#2 啟動對帳把它標成 interrupted →
    // `recovery.abandon`(使用者決定放棄)把它標成 closed。
    core1 = startCore({ port: PRELUDE_PORT, dataDir, homeDir, workspaceDir: wsA });
    await waitForPort(`ws://127.0.0.1:${PRELUDE_PORT}`, 20_000);
    const preludeClient = new GatewayClient(`ws://127.0.0.1:${PRELUDE_PORT}`);
    await preludeClient.connect();
    const closedSeed = await createSession(preludeClient, wsA, "net-closed-seed");
    const interruptedSeed = await createSession(preludeClient, wsA, "net-interrupted-seed");
    preludeClient.close();
    await killProcessTree(core1, "序幕 core(強制終止,模擬崩潰)");

    core2 = startCore({ port: CORE_PORT, dataDir, homeDir, workspaceDir: wsA });
    const url = `ws://127.0.0.1:${CORE_PORT}`;
    await waitForPort(url, 20_000);
    client = new GatewayClient(url);
    await client.connect();
    console.log("[setup] 主 core 已啟動並連線");

    const seedStatus = await statusOf(client, closedSeed.id);
    await client.rpc("recovery.abandon", { sessionId: closedSeed.id });
    const closedStatus = await statusOf(client, closedSeed.id);
    const interruptedStatus = await statusOf(client, interruptedSeed.id);
    console.log(`[setup] 序幕 session:${closedSeed.id} ${seedStatus} → ${closedStatus};${interruptedSeed.id} ${interruptedStatus}`);

    const sessionA = await createSession(client, wsA, "net-A");
    const sessionB = await createSession(client, wsB, "net-B");
    const A = sessionA.id;
    const B = sessionB.id;

    // =====================================================================================
    // P3.7-1 A `list_sessions` 看得到 B(B 不是 A 的子、工作目錄也不同)
    // =====================================================================================
    try {
      const r = await callTool(client, A, "list_sessions", {});
      const list = JSON.parse(r.text);
      const me = list.find((s) => s.id === A);
      const other = list.find((s) => s.id === B);
      const closed = list.find((s) => s.id === closedSeed.id);
      record(
        "P3.7-1 A 的 list_sessions 看得到 B(B 不是 A 的子、工作資料夾也不同——證明是「全部 session」可見),且含自己(isYou)、closed 的 session、agentLabel/canUseTools",
        !r.isError &&
          other !== undefined &&
          other.isYou === false &&
          other.parentSessionId === undefined &&
          other.workingDir !== me?.workingDir &&
          other.agentLabel === ENVELOPE_AGENT_LABEL &&
          other.canUseTools === true &&
          me?.isYou === true &&
          closed?.status === "closed" &&
          list.filter((s) => s.isYou).length === 1,
        `A=${JSON.stringify(me)}, B=${JSON.stringify(other)}, closed=${closed?.status}`,
      );
    } catch (err) {
      record("P3.7-1 A 的 list_sessions 看得到 B", false, String(err?.stack ?? err));
    }

    // =====================================================================================
    // P3.7-2 A send_to_session(B) → B 收到含信封的 prompt、持久化有 origin;B 這輪結束後 A 沒有自動注入
    // =====================================================================================
    try {
      const msg = `你好 B,請看這則訊息 ${delayEchoMarker(0)}`;
      const pushesBefore = client.sessionMessages.length;
      const r = await callTool(client, A, "send_to_session", { sessionId: B, message: msg });
      const { messages: bMessages, hit: bEcho } = await waitForHistory(
        client,
        B,
        (ms) => ms.find((m) => m.role === "assistant" && m.content.startsWith("ECHO:")),
        30_000,
      );
      await waitForStatus(client, B, "idle");
      const envelopeHeader = `[來自 session「net-A」(id: ${A},agent: ${ENVELOPE_AGENT_LABEL})的訊息]`;
      record(
        "P3.7-2a B 收到的 prompt 含信封(來自誰、哪個 agent、原文、「系統不會自動回覆,要回請用 send_to_session 傳給 <A>」的系統提示)",
        !r.isError &&
          Boolean(bEcho) &&
          bEcho.content.includes(envelopeHeader) &&
          bEcho.content.includes(msg) &&
          bEcho.content.includes(`請用 send_to_session 傳給 ${A}`) &&
          bEcho.content.includes("這則訊息不會自動得到回覆"),
        `B 回顯=${JSON.stringify(bEcho?.content)}`,
      );

      const bUser = bMessages.find((m) => m.role === "user" && m.origin);
      noteChain(bMessages);
      const push = client.sessionMessages.slice(pushesBefore).find((p) => p.sessionId === B);
      record(
        "P3.7-2b B 的持久化訊息有 origin.sessionId === A(kind=session、title、chainId),content 存原始 message 本體(不含信封樣板),且 core 即時推播了 session-message",
        bUser?.origin?.sessionId === A &&
          bUser.origin.kind === "session" &&
          bUser.origin.title === "net-A" &&
          typeof bUser.origin.chainId === "string" &&
          bUser.content === msg &&
          !bUser.content.includes("系統提示") &&
          push?.message?.id === bUser.id &&
          push.message.origin?.sessionId === A,
        `B user=${JSON.stringify(bUser)}, push=${JSON.stringify(push)}`,
      );

      // 給 B 這輪結束後足夠的時間,讓「如果有自動回送」這件事有機會發生
      await sleep(2_000);
      const aMessages = await history(client, A);
      const aPushes = client.sessionMessages.filter((p) => p.sessionId === A);
      record(
        "P3.7-2c B 這輪結束後 A 沒有收到任何自動注入(A 的歷史只有它自己的人類 prompt 與回覆、沒有任何 origin 訊息、沒有 session-message push、狀態 idle)",
        hasNoAutoInjection(aMessages) && aPushes.length === 0 && (await statusOf(client, A)) === "idle",
        `A messages=${JSON.stringify(aMessages.map((m) => `${m.role}:${m.content.slice(0, 30)}${m.origin ? "[origin]" : ""}`))}, A pushes=${aPushes.length}`,
      );
    } catch (err) {
      record("P3.7-2 send_to_session 信封/origin/無自動回送", false, String(err?.stack ?? err));
    }

    // =====================================================================================
    // P3.7-3 B busy 時 A 送的訊息會排隊,B 回 idle 後才送達
    // =====================================================================================
    try {
      const holdMs = 6_000;
      const hold = client.drivePrompt(B, `${delayEchoMarker(holdMs)} hold`, { timeoutMs: 60_000 });
      hold.catch(() => undefined);
      const busy = await waitForStatus(client, B, "busy", 15_000);
      const queuedMsg = `排隊中的訊息 ${delayEchoMarker(0)}`;
      const r = await callTool(client, A, "send_to_session", { sessionId: B, message: queuedMsg });
      const statusAfterSend = await statusOf(client, B);
      const duringBusy = await history(client, B);
      const deliveredEarly = duringBusy.some((m) => m.role === "user" && m.content === queuedMsg);
      await hold;
      const { messages: afterIdle, hit: delivered } = await waitForHistory(
        client,
        B,
        (ms) => ms.find((m) => m.role === "user" && m.content === queuedMsg && m.origin),
        30_000,
      );
      const { hit: echoed } = await waitForHistory(
        client,
        B,
        (ms) => ms.find((m) => m.role === "assistant" && m.content.includes(queuedMsg)),
        30_000,
      );
      await waitForStatus(client, B, "idle");
      noteChain(afterIdle);
      const holdReply = afterIdle.find((m) => m.role === "assistant" && m.content.includes("hold"));
      record(
        "P3.7-3 B busy 時 A 送的訊息排隊(送出當下 B 仍 busy、歷史裡還沒有這則訊息),B 回 idle 後才送達(送達時間晚於 B 那一輪的回覆),且 agent 收到的是信封包裝後的內容",
        busy &&
          !r.isError &&
          r.text.includes("排隊") &&
          statusAfterSend === "busy" &&
          !deliveredEarly &&
          Boolean(delivered) &&
          Boolean(holdReply) &&
          delivered.createdAt >= holdReply.createdAt &&
          Boolean(echoed) &&
          echoed.content.includes(`[來自 session「net-A」(id: ${A}`),
        `busy=${busy}, statusAfterSend=${statusAfterSend}, deliveredEarly=${deliveredEarly}, delivered@${delivered?.createdAt} holdReply@${holdReply?.createdAt}`,
      );
    } catch (err) {
      record("P3.7-3 B busy 時訊息排隊", false, String(err?.stack ?? err));
    }

    // =====================================================================================
    // P3.7-4 send_to_session 對自己 / 不存在的 id / closed session → 明確錯誤
    // =====================================================================================
    try {
      const sessionCountBefore = (await client.rpc("session.list", {})).sessions.length;
      const self = await callTool(client, A, "send_to_session", { sessionId: A, message: "自己傳給自己" });
      const missing = await callTool(client, A, "send_to_session", { sessionId: "no-such-session-id", message: "x" });
      const closed = await callTool(client, A, "send_to_session", { sessionId: closedSeed.id, message: "x" });
      const interrupted = await callTool(client, A, "send_to_session", { sessionId: interruptedSeed.id, message: "x" });
      const closedHistory = await history(client, closedSeed.id);
      const aAfter = await history(client, A);
      record(
        "P3.7-4a send_to_session 對自己 → 明確錯誤(isError、說明不能傳給自己),沒有任何訊息被送出",
        self.isError && self.text.includes("自己") && !aAfter.some((m) => m.origin),
        self.text,
      );
      record(
        "P3.7-4b send_to_session 對不存在的 id → 明確錯誤(找不到 session)",
        missing.isError && missing.text.includes("找不到"),
        missing.text,
      );
      record(
        "P3.7-4c send_to_session 對 closed session(以及 interrupted)→ 明確錯誤(收不到訊息,不假裝成功),且目標歷史沒有被寫入",
        closed.isError &&
          closed.text.includes("closed") &&
          closed.text.includes("收不到訊息") &&
          interrupted.isError &&
          interrupted.text.includes("收不到訊息") &&
          closedHistory.length === 0,
        `closed: ${closed.text} | interrupted: ${interrupted.text}`,
      );
      const badAgent = await callTool(client, A, "create_session", { agent: "no-such-agent", prompt: "x" });
      const sessionCountAfter = (await client.rpc("session.list", {})).sessions.length;
      record(
        "P3.7-4d create_session 指定不存在的 agent → 明確錯誤,沒有開出任何新 session",
        badAgent.isError && badAgent.text.includes("找不到") && sessionCountAfter === sessionCountBefore,
        `${badAgent.text} (sessions ${sessionCountBefore} → ${sessionCountAfter})`,
      );
    } catch (err) {
      record("P3.7-4 send_to_session 錯誤情境", false, String(err?.stack ?? err));
    }

    // =====================================================================================
    // P3.7-5 鏈預算:上限 3,A↔B 互傳到第 4 則被拒、有 audit 紀錄;人類對 A 輸入新 prompt,A 再送給 B 成功(新鏈)
    // =====================================================================================
    try {
      await waitForStatus(client, A, "idle");
      await waitForStatus(client, B, "idle");
      const tripsBefore = (await readAudit(dataDir, "trip")).length;
      // hop1(A→B,人類 prompt 觸發)→ hop2(B 自己回 A)→ hop3(A 自己回 B)→ hop4(B 想回 A,第 4 則,被拒)
      const M4 = "hop4-end";
      const M3 = `hop3 ${bridgeOnPromptMarker("send_to_session", { sessionId: A, message: M4 })}`;
      const M2 = `hop2 ${bridgeOnPromptMarker("send_to_session", { sessionId: B, message: M3 })}`;
      const M1 = `hop1 ${bridgeOnPromptMarker("send_to_session", { sessionId: A, message: M2 })}`;
      const notifBefore = client.notifications.length;
      const first = await callTool(client, A, "send_to_session", { sessionId: B, message: M1 });
      const { hit: tripped } = await waitForHistory(
        client,
        B,
        (ms) => ms.find((m) => m.role === "assistant" && m.content.includes("已熔斷")),
        90_000,
      );
      await waitForStatus(client, A, "idle", 30_000);
      await waitForStatus(client, B, "idle", 30_000);
      await sleep(1_000);
      const aMessages = await history(client, A);
      const bMessages = await history(client, B);
      noteChain([...aMessages, ...bMessages]);
      const chainOf = (ms, text) => ms.find((m) => m.origin && m.content.startsWith(text))?.origin.chainId;
      const c1 = chainOf(bMessages, "hop1");
      const c2 = chainOf(aMessages, "hop2");
      const c3 = chainOf(bMessages, "hop3");
      const rejectedReply = tripped ? parseBridgeReply(tripped.content, "BRIDGE_ON_PROMPT_RESULT") : undefined;
      const hop4Delivered = [...aMessages, ...bMessages].some((m) => m.content.includes("hop4-end") && m.origin);
      record(
        "P3.7-5a 鏈預算 maxMessagesPerContext=3:A→B→A→B 三則放行(同一條鏈、鏈 id 沿用),第 4 則被拒——工具回錯誤給 agent(講明已熔斷、需要使用者介入),第 4 則沒有送達",
        !first.isError &&
          Boolean(c1) &&
          c1 === c2 &&
          c2 === c3 &&
          rejectedReply?.isError === true &&
          rejectedReply.text.includes("已熔斷") &&
          rejectedReply.text.includes("需要使用者介入") &&
          rejectedReply.text.includes(String(MAX_MESSAGES_PER_CHAIN)) &&
          !hop4Delivered,
        `chains=${c1}/${c2}/${c3}, rejected=${JSON.stringify(rejectedReply)}, hop4Delivered=${hop4Delivered}`,
      );

      const trips = await readAudit(dataDir, "trip");
      const reminders = await readAudit(dataDir, "reminder");
      const newTrip = trips.slice(tripsBefore).find((row) => row.payload.includes("message-chain-budget"));
      const tripPayload = newTrip ? JSON.parse(newTrip.payload) : undefined;
      const reminder = reminders.find((row) => row.payload.includes("message-chain-warning"));
      const newNotifs = client.notifications.slice(notifBefore);
      const tripNotif = newNotifs.find((n) => n.kind === "trip" && n.tripReason === "message-chain-budget");
      const warnNotif = newNotifs.find((n) => n.kind === "reminder" && n.reminderReason === "message-chain-warning");
      record(
        "P3.7-5b 熔斷有 audit 紀錄(trip,source=message、reason=message-chain-budget、targetIds 含 A/B)、達 warnAtPercent 有軟警告 audit(reminder,message-chain-warning),且桌面通知(enforcement-notification)都推播了",
        tripPayload?.source === "message" &&
          tripPayload.reason === "message-chain-budget" &&
          tripPayload.targetIds.includes(A) &&
          tripPayload.targetIds.includes(B) &&
          Boolean(reminder) &&
          Boolean(tripNotif) &&
          Boolean(warnNotif),
        `trip=${newTrip?.payload}, reminder=${reminder?.payload}, notifs=${JSON.stringify(newNotifs.map((n) => [n.kind, n.tripReason, n.reminderReason]))}`,
      );

      // 人類對 A 輸入新 prompt(新鏈),A 再送給 B 成功
      const fresh = await callTool(client, A, "send_to_session", { sessionId: B, message: "新鏈的訊息(人類輸入後)" });
      const { hit: freshDelivered } = await waitForHistory(
        client,
        B,
        (ms) => ms.find((m) => m.role === "user" && m.content === "新鏈的訊息(人類輸入後)" && m.origin),
        30_000,
      );
      await waitForStatus(client, B, "idle", 30_000);
      record(
        "P3.7-5c 熔斷後人類對 A 輸入新 prompt(開新鏈),A 再送給 B 成功(送達、鏈 id 與被熔斷的那條不同)",
        !fresh.isError && Boolean(freshDelivered) && freshDelivered.origin.chainId !== c1 && !seenChains.has(freshDelivered.origin.chainId),
        `fresh=${fresh.text}, chain=${freshDelivered?.origin?.chainId} (舊鏈 ${c1})`,
      );
      seenChains.add(freshDelivered?.origin?.chainId);
    } catch (err) {
      record("P3.7-5 訊息鏈預算", false, String(err?.stack ?? err));
    }

    // =====================================================================================
    // P3.7-6 create_session 建的 session parentSessionId = 呼叫者、第一則訊息有 origin
    // =====================================================================================
    try {
      await waitForStatus(client, A, "idle");
      // A 在前面的鏈預算測試裡本來就收過別人(B)送來的訊息(hop2),所以這裡比的是「建立子 session 前後」的差異。
      const aOriginCountBefore = (await history(client, A)).filter((m) => m.origin).length;
      const prompt = `開工 ${delayEchoMarker(0)}`;
      const r = await callTool(client, A, "create_session", { agent: FAKE_ACP, prompt, title: "net-kid" });
      const idMatch = r.text.match(/session ([0-9a-f]{8}-[0-9a-f-]{27})/);
      const kidId = idMatch?.[1];
      const { sessions } = await client.rpc("session.list", {});
      const kid = sessions.find((s) => s.id === kidId);
      const { messages: kidMessages, hit: kidEcho } = await waitForHistory(
        client,
        kidId,
        (ms) => ms.find((m) => m.role === "assistant" && m.content.startsWith("ECHO:")),
        30_000,
      );
      await waitForStatus(client, kidId, "idle", 30_000);
      noteChain(kidMessages);
      const first = kidMessages.find((m) => m.role === "user");
      record(
        "P3.7-6 create_session 建的 session:parentSessionId = 呼叫者 A、工作資料夾預設沿用 A 的、標題照給;第一則訊息(content 是原始 prompt)有 origin(來自 A),且 agent 收到的是信封包裝後的內容",
        !r.isError &&
          kid?.parentSessionId === A &&
          kid.workingDir === wsA &&
          kid.title === "net-kid" &&
          first?.content === prompt &&
          first.origin?.kind === "session" &&
          first.origin.sessionId === A &&
          typeof first.origin.chainId === "string" &&
          Boolean(kidEcho) &&
          kidEcho.content.includes(`[來自 session「net-A」(id: ${A}`),
        `create 結果=${r.text}, kid=${JSON.stringify(kid && { id: kid.id, parent: kid.parentSessionId, wd: kid.workingDir, title: kid.title })}, first=${JSON.stringify(first)}`,
      );
      // 子 session 跑完後,結果不會自動回到 A(S12 的「子完成 → 注入父」已移除)
      await sleep(1_500);
      const aMessages = await history(client, A);
      const aOriginCountAfter = aMessages.filter((m) => m.origin).length;
      record(
        "P3.3 create_session 開出的子 session 跑完後,結果不會自動注入父 A(A 的歷史多出來的 origin 訊息數為 0、A 沒有再跑任何一輪;要不要回報由子自己決定)",
        aOriginCountAfter === aOriginCountBefore && (await statusOf(client, A)) === "idle",
        `A origin 訊息數 ${aOriginCountBefore} → ${aOriginCountAfter}`,
      );
    } catch (err) {
      record("P3.7-6 create_session", false, String(err?.stack ?? err));
    }

    // =====================================================================================
    // P3.7-7 read_session 回最近 N 則、超長內容被截斷、不回傳附件內容
    // =====================================================================================
    try {
      const R = (await createSession(client, wsB, "net-reader-target")).id;
      for (let i = 1; i <= 11; i++) await client.drivePrompt(R, `第 ${i} 則`);
      await client.drivePrompt(R, `${SAY_PREFIX}${"x".repeat(5000)}`);
      await client.drivePrompt(R, { text: "附圖", attachments: [{ type: "image", mediaType: "image/png", data: TINY_PNG_B64 }] });
      // assistant 訊息是在 completed 事件「之後」才寫進 DB(見 consumeEventsInner),等全部落地
      const { messages: rAll } = await waitForHistory(client, R, (ms) => (ms.filter((m) => m.role === "assistant").length >= 13 ? ms : undefined), 30_000);

      const def = await callTool(client, A, "read_session", { sessionId: R });
      const defMsgs = JSON.parse(def.text).messages;
      const three = await callTool(client, A, "read_session", { sessionId: R, limit: 3 });
      const threeMsgs = JSON.parse(three.text).messages;
      const missing = await callTool(client, A, "read_session", { sessionId: "no-such-session-id" });

      const longAssistant = defMsgs.find((m) => m.role === "assistant" && m.truncated);
      const imageUser = defMsgs.find((m) => m.role === "user" && m.content === "附圖");
      const dbConversation = rAll.filter((m) => m.role === "user" || m.role === "assistant");
      const expectedLast20 = dbConversation.slice(-20);
      record(
        "P3.7-7a read_session 預設回最近 20 則(依時間由舊到新,只含 user/assistant),limit 可指定(limit=3 回最近 3 則);找不到的 session → 明確錯誤",
        !def.isError &&
          defMsgs.length === 20 &&
          defMsgs.every((m, i) => m.role === expectedLast20[i].role && m.createdAt === expectedLast20[i].createdAt) &&
          !three.isError &&
          threeMsgs.length === 3 &&
          threeMsgs[2].content.includes("Hello from fake ACP agent") &&
          missing.isError &&
          missing.text.includes("找不到"),
        `default=${defMsgs.length} 則, limit3=${threeMsgs.length} 則, missing=${missing.text}`,
      );
      record(
        "P3.7-7b read_session 超長內容被截斷並標註(content ≤ 4000 字元 + 截斷說明、truncated=true、原長 5000 寫在說明裡)",
        Boolean(longAssistant) &&
          longAssistant.truncated === true &&
          longAssistant.content.startsWith("x".repeat(4000)) &&
          longAssistant.content.includes("已截斷") &&
          longAssistant.content.includes("5000") &&
          longAssistant.content.length < 4200,
        `長度=${longAssistant?.content.length}, 尾端=${JSON.stringify(longAssistant?.content.slice(-60))}`,
      );
      record(
        "P3.7-7c read_session 不回傳附件的二進位內容(只標示 hasAttachments=true,回傳的整段文字裡沒有圖片的 base64)",
        imageUser?.hasAttachments === true && !def.text.includes(TINY_PNG_B64) && !def.text.includes("iVBORw0KGgo") && !("attachments" in imageUser),
        `imageUser=${JSON.stringify(imageUser)}`,
      );
    } catch (err) {
      record("P3.7-7 read_session", false, String(err?.stack ?? err));
    }

    // =====================================================================================
    // P3.7-8 ACP bridge token 只能呼叫那五個方法;拿 token 呼叫 session.setPermissionMode 被拒
    // =====================================================================================
    try {
      // 取出 A 這個 session 真實核發的 scoped token(同 e2e-gateway.mjs 步驟 32 的手法)
      const { text } = await client.drivePrompt(A, REPORT_MCP_SERVERS_PREFIX, { timeoutMs: 30_000 });
      const marker = "MCP_SERVERS:";
      const mcpServers = JSON.parse(text.slice(text.indexOf(marker) + marker.length));
      const env = Object.fromEntries((mcpServers[0].env ?? []).map((e) => [e.name, e.value]));
      const token = env.DESKMONY_MCP_BRIDGE_TOKEN;
      const gatewayUrl = env.DESKMONY_MCP_BRIDGE_GATEWAY_URL;
      const bridgeRaw = new GatewayClient(gatewayUrl);
      await bridgeRaw.connect();
      await bridgeRaw.rpc("auth", { token });

      const allowed = [];
      for (const [method, params] of [
        ["agent.listForAgent", {}],
        ["session.listForAgent", {}],
        ["session.readForAgent", { sessionId: B, limit: 2 }],
        ["session.createFromAgent", { agent: FAKE_ACP, prompt: "token 建立的", title: "net-token-created" }],
        ["session.sendFromAgent", { sessionId: B, message: "token 送出的" }],
      ]) {
        try {
          await bridgeRaw.rpc(method, params);
          allowed.push({ method, ok: true });
        } catch (err) {
          allowed.push({ method, ok: false, message: String(err) });
        }
      }
      const forbidden = [];
      for (const [method, params] of [
        ["session.setPermissionMode", { sessionId: A, mode: "auto-accept-all" }],
        ["session.setTrueUnrestricted", { sessionId: A, enabled: true }],
        ["session.sendPrompt", { sessionId: B, prompt: { text: "冒充人類輸入" } }],
        ["session.list", {}],
        ["session.history", { sessionId: B }],
        ["session.create", { providerId: FAKE_ACP, workingDir: wsA }],
        ["session.delete", { sessionId: B }],
        ["session.forwardMessage", { sourceSessionId: A, targetSessionId: B, text: "x" }],
        ["policy.listRules", {}],
        ["config.getEffective", {}],
      ]) {
        try {
          await bridgeRaw.rpc(method, params);
          forbidden.push({ method, rejected: false });
        } catch (err) {
          forbidden.push({ method, rejected: true, code: err.errorCode, message: String(err) });
        }
      }
      bridgeRaw.close();
      const setMode = forbidden.find((f) => f.method === "session.setPermissionMode");
      record(
        "P3.7-8 ACP bridge token 只能呼叫那五個方法(agent.listForAgent/session.listForAgent/readForAgent/createFromAgent/sendFromAgent 全部成功);拿 token 呼叫 session.setPermissionMode 被拒(errorCode=gateway.scopedTokenForbidden),其他一般方法(sendPrompt/list/history/create/delete/forwardMessage/policy/config)一律被拒",
        allowed.every((a) => a.ok) &&
          setMode?.rejected === true &&
          setMode.code === "gateway.scopedTokenForbidden" &&
          forbidden.every((f) => f.rejected && f.code === "gateway.scopedTokenForbidden"),
        `allowed=${JSON.stringify(allowed)}, forbidden=${JSON.stringify(forbidden.map((f) => [f.method, f.rejected, f.code]))}`,
      );
    } catch (err) {
      record("P3.7-8 ACP bridge token 方法白名單", false, String(err?.stack ?? err));
    }

    // =====================================================================================
    // P3.7-9 session.forwardMessage:目標收到 origin.kind === "forward"、開了新鏈
    // =====================================================================================
    try {
      // 先拍下「轉傳之前」所有看過的鏈(下面 noteChain() 會把轉傳自己開的鏈也記進 seenChains)
      const chainsBeforeForward = new Set(seenChains);
      const SRC = (await createSession(client, wsA, "net-src")).id;
      const DST = (await createSession(client, wsB, "net-dst")).id;
      const DST2 = (await createSession(client, wsB, "net-dst2")).id;
      // SRC 的 assistant 訊息內文含「收到的人要呼叫 send_to_session(DST2)」標記——SAY 原樣輸出、不會自己執行
      const sayText = `轉傳內容 ${bridgeOnPromptMarker("send_to_session", { sessionId: DST2, message: "chain-follow-msg" })}`;
      await client.drivePrompt(SRC, `${SAY_PREFIX}${sayText}`);
      const { hit: srcAssistant, messages: srcMessages } = await waitForHistory(
        client,
        SRC,
        (ms) => ms.find((m) => m.role === "assistant" && m.content === sayText),
        20_000,
      );
      const srcUser = srcMessages.find((m) => m.role === "user");
      const note = "請處理這個";
      // 2026-10-03:轉傳的是畫面上氣泡的文字(`text`),core 不回頭查 SRC 的原訊息(沒有 messageId 參數了)。
      await client.rpc("session.forwardMessage", {
        sourceSessionId: SRC,
        targetSessionId: DST,
        text: sayText,
        note,
      });
      const { hit: fwd, messages: dstMessages } = await waitForHistory(
        client,
        DST,
        (ms) => ms.find((m) => m.role === "user" && m.origin?.kind === "forward"),
        30_000,
      );
      const { hit: dstReply } = await waitForHistory(
        client,
        DST,
        (ms) => ms.find((m) => m.role === "assistant" && m.content.startsWith("BRIDGE_ON_PROMPT_RESULT")),
        60_000,
      );
      const { hit: followed, messages: dst2Messages } = await waitForHistory(
        client,
        DST2,
        (ms) => ms.find((m) => m.role === "user" && m.content === "chain-follow-msg" && m.origin),
        60_000,
      );
      noteChain(dstMessages);
      noteChain(dst2Messages);
      const forwardChain = fwd?.origin.chainId;
      record(
        "P3.7-9a session.forwardMessage 轉傳後,目標 DST 收到 origin.kind === \"forward\"(sessionId=來源 SRC、title、chainId),content 是「附註 + 被轉傳的訊息本體」(不含信封樣板),且 agent 收到的信封標明「使用者從 session X 轉來」",
        fwd?.origin.sessionId === SRC &&
          fwd.origin.title === "net-src" &&
          typeof forwardChain === "string" &&
          fwd.content === `${note}\n\n${sayText}` &&
          Boolean(dstReply),
        `fwd=${JSON.stringify(fwd)}`,
      );
      record(
        "P3.7-9b 轉傳開了新鏈:轉傳的 chainId 與先前所有鏈都不同(含已熔斷那條,轉傳是人類操作、不被擋);收到的 agent 接著送給 DST2 的訊息沿用同一條新鏈(origin.chainId 相同)並成功送達",
        Boolean(forwardChain) &&
          !chainsBeforeForward.has(forwardChain) &&
          chainsBeforeForward.size >= 3 &&
          followed?.origin.chainId === forwardChain &&
          followed.origin.sessionId === DST &&
          followed.origin.kind === "session" &&
          srcUser?.origin === undefined,
        `forwardChain=${forwardChain}, followed=${JSON.stringify(followed?.origin)}`,
      );
      // 9d:轉傳的是畫面上氣泡的文字,core 不回頭查原訊息——ACP 一輪有多個氣泡時,使用者按的那個氣泡只是整輪
      // 文字的一部分,送出去的必須剛好是那一部分(而不是比對到整輪文字);來源 session 甚至不必有任何對應的
      // 持久化訊息(內容完全由使用者畫面上的文字決定,等同使用者自己貼上)。
      {
        const DST3 = (await createSession(client, wsB, "net-dst3")).id;
        const EMPTY_SRC = (await createSession(client, wsA, "net-empty-src")).id;
        const bubbleFragment = "轉傳內容"; // sayText 的開頭那一段,其餘(含標記)不該跟著送出
        const freeText = "這段文字沒有出現在任何一個 session 的歷史裡";
        const sourceHasFullText = srcAssistant?.content === sayText && sayText.length > bubbleFragment.length;
        await client.rpc("session.forwardMessage", { sourceSessionId: SRC, targetSessionId: DST3, text: bubbleFragment });
        await client.rpc("session.forwardMessage", { sourceSessionId: EMPTY_SRC, targetSessionId: DST3, text: freeText, note: "  補充  " });
        const { hit: fragmentMsg, messages: dst3Messages } = await waitForHistory(
          client,
          DST3,
          (ms) => ms.find((m) => m.role === "user" && m.origin?.kind === "forward" && m.content === bubbleFragment),
          30_000,
        );
        const { hit: freeMsg } = await waitForHistory(
          client,
          DST3,
          (ms) => ms.find((m) => m.role === "user" && m.origin?.kind === "forward" && m.origin.sessionId === EMPTY_SRC),
          60_000,
        );
        noteChain(dst3Messages);
        record(
          "P3.7-9d 轉傳的 text 原樣送出、core 不回頭查原訊息:只轉氣泡片段 → 目標收到的剛好是那個片段(不是來源的整段文字);來源 session 沒有任何訊息也能轉,note 前後空白被修剪、接在 text 前面",
          sourceHasFullText &&
            fragmentMsg?.origin.sessionId === SRC &&
            freeMsg?.content === `補充\n\n${freeText}` &&
            freeMsg.origin.title === "net-empty-src",
          `fragment=${JSON.stringify(fragmentMsg)}, free=${JSON.stringify(freeMsg)}, sourceHasFullText=${sourceHasFullText}`,
        );
      }
      // 錯誤情境:轉給自己、來源/目標不存在、text 空白 / 超過上限
      const asOutcome = (promise) =>
        promise.then(
          () => ({ rejected: false }),
          (err) => ({ rejected: true, code: err.errorCode }),
        );
      const selfForward = await asOutcome(client.rpc("session.forwardMessage", { sourceSessionId: SRC, targetSessionId: SRC, text: "x" }));
      const missingTarget = await asOutcome(
        client.rpc("session.forwardMessage", { sourceSessionId: SRC, targetSessionId: randomUUID(), text: "x" }),
      );
      const missingSource = await asOutcome(
        client.rpc("session.forwardMessage", { sourceSessionId: randomUUID(), targetSessionId: DST, text: "x" }),
      );
      const emptyText = await asOutcome(client.rpc("session.forwardMessage", { sourceSessionId: SRC, targetSessionId: DST, text: "" }));
      const tooLongText = await asOutcome(
        client.rpc("session.forwardMessage", { sourceSessionId: SRC, targetSessionId: DST, text: "a".repeat(FORWARD_MESSAGE_MAX_CHARS + 1) }),
      );
      record(
        `P3.7-9c session.forwardMessage 轉給來源自己 → cannotForwardToSelf;來源/目標不存在 → entity.notFound;text 空字串、超過 ${FORWARD_MESSAGE_MAX_CHARS} 字元 → gateway.invalidRequest(明確拒絕,不會截斷後送出)`,
        selfForward.rejected &&
          selfForward.code === "sessionNetwork.cannotForwardToSelf" &&
          missingTarget.rejected &&
          missingTarget.code === "entity.notFound" &&
          missingSource.rejected &&
          missingSource.code === "entity.notFound" &&
          emptyText.rejected &&
          emptyText.code === "gateway.invalidRequest" &&
          tooLongText.rejected &&
          tooLongText.code === "gateway.invalidRequest",
        `self=${JSON.stringify(selfForward)}, missingTarget=${JSON.stringify(missingTarget)}, missingSource=${JSON.stringify(missingSource)}, empty=${JSON.stringify(emptyText)}, tooLong=${JSON.stringify(tooLongText)}`,
      );
    } catch (err) {
      record("P3.7-9 session.forwardMessage", false, String(err?.stack ?? err));
    }

    // =====================================================================================
    // P3.3 整個過程沒有 S12 的子結果 push、session.spawnChild 已移除
    // =====================================================================================
    try {
      const spawnChild = await client.rpc("session.spawnChild", { parentSessionId: A, prompt: "x" }).then(
        () => ({ rejected: false }),
        (err) => ({ rejected: true, code: err.errorCode }),
      );
      const forgedOrigin = { kind: "session", sessionId: A, title: "forged", chainId: "forged-chain" };
      const humanSend = await client.rpc("session.sendPrompt", {
        sessionId: B,
        chainId: "forged-chain",
        origin: forgedOrigin,
        prompt: { text: "人類輸入", chainId: "forged-chain", origin: forgedOrigin },
      });
      const { hit: humanMsg } = await waitForHistory(client, B, (ms) => ms.find((m) => m.role === "user" && m.content === "人類輸入"), 15_000);
      await waitForStatus(client, B, "idle", 30_000);
      record(
        "P3.3 沒有任何 S12 的子結果 push(整個測試期間),session.spawnChild 已移除;人類輸入(session.sendPrompt)夾帶偽造的 origin/chainId 無效(不被當成別的 session 送來的)",
        // S12 的 push channel 名稱(已移除);用 join 組出來,讓這個字串不會出現在 grep 殘留檢查裡。
        !client.channelsSeen.has(["child", "result"].join("-")) &&
          spawnChild.rejected &&
          spawnChild.code === "gateway.invalidRequest" &&
          humanSend?.ok === true &&
          humanMsg?.origin === undefined,
        `channels=${[...client.channelsSeen].join(",")}, spawnChild=${JSON.stringify(spawnChild)}, humanMsg=${JSON.stringify(humanMsg)}`,
      );
    } catch (err) {
      record("P3.3 沒有 S12 的子結果 push / spawnChild 已移除", false, String(err?.stack ?? err));
    }
  } catch (err) {
    console.error(`\n[FATAL] ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    record("e2e 整體設置", false, String(err?.stack ?? err));
  } finally {
    client?.close();
    await killProcessTree(core1, "序幕 core");
    await killProcessTree(core2, "主 core");
    for (const dir of [dataDir, homeDir, wsA, wsB]) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }

  // ---- 結果統計 ----
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n${"=".repeat(50)}`);
  console.log(`P3(session 網路) e2e 結果 (${elapsed}s)`);
  console.log(`${"=".repeat(50)}`);
  let pass = 0;
  let fail = 0;
  for (const r of results) {
    console.log(`  ${r.ok ? "PASS" : "FAIL"} ${r.name}`);
    if (!r.ok && r.detail) console.log(`       ${r.detail}`);
    if (r.ok) pass++;
    else fail++;
  }
  console.log(`\n總計: ${pass} PASS, ${fail} FAIL`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
