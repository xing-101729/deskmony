#!/usr/bin/env node
/**
 * scripts/e2e-agent-env.mjs
 *
 * 2026-10-05(安全):agent 子行程的環境變數裡**不得**有 Deskmony 自己的憑證。
 *
 * ---- 修的是什麼 --------------------------------------------------------
 *
 * 桌面殼一律把 `DESKMONY_AUTH_TOKEN`(主認證 token)設進環境再啟動 core,四個 adapter 原本又都把 `process.env` 整份
 * 展開給 agent 子行程(Claude SDK 在沒有 provider env 時乾脆省略 `env`、讓 SDK 繼承整份)。於是真實 app 裡**任何 agent 的
 * bash 都讀得到主 token**,拿它連上 gateway 就能核准自己的權限請求、把自己切成 YOLO/真.無限制、新增政策 allowlist——
 * 整個安全罩 agent 自己就能拆。修法:packages/adapters/src/agent-env.ts 的 `buildAgentChildEnv()`,四個 adapter 全部改用,
 * 最後一步無條件刪除 denylist(`DESKMONY_AUTH_TOKEN`、`DESKMONY_MCP_BRIDGE_*`、繼承來的 `OPENCODE_SERVER_PASSWORD/USERNAME`)。
 *
 * ---- 這支測什麼 --------------------------------------------------------
 *
 * 一個 core 以**設了 `DESKMONY_AUTH_TOKEN`** 的環境啟動(e2e client 要先 `auth` 才能用——也證明前提成立,不是空洞的通過),
 * 環境裡另外放了「不該外洩」的假值(MCP bridge 的三個變數、opencode 伺服器密碼);使用者還在 provider 環境變數裡自己填了一份
 * `DESKMONY_AUTH_TOKEN`。fake 後端子行程**只回報「環境裡有沒有這個變數」**(絕不回顯值——回覆會進 history/log):
 *
 *   AE1  前提:core 真的有開認證(沒帶 token 的連線被拒、帶對的 e2e client 才能用)。
 *   AE2  `buildAgentChildEnv()` 本身:denylist 全中(含不分大小寫的變體)、疊上去的 layer 也擋不住 denylist(使用者在 provider env
 *        填主 token 照樣被刪)、其他變數與 PATH 保留、後面的 layer 蓋前面的、不改動 `process.env` 與傳入的 layer。
 *   AE3  ACP(一般 agent):子行程環境沒有 denylist 任何一項,但 provider env 的其他變數與 PATH 照常有(沒有矯枉過正)。
 *   AE4  ACP:bridge 子行程**仍拿得到**它的 scoped token(fake agent 真的 spawn bridge、`list_sessions` 成功)——
 *        證明 bridge 靠的是 `session/new` 的 `mcpServers[].env`,不是 agent 環境的繼承。
 *   AE5  ACP(family=opencode):同樣沒有 `DESKMONY_*`;`opencode acp` 行程自己的伺服器密碼是 Deskmony 新產生的(不是從父行程繼承來的假值)。
 *   AE6  OpenCode(HTTP):子行程環境沒有 `DESKMONY_*`;伺服器密碼是 Deskmony 新產生的(不是繼承值);`mcp.deskmony.environment`
 *        仍含 scoped token,而且**用那份環境真的 spawn bridge、`list_sessions` 成功**(HTTP 的 bridge 是 opencode 依設定啟動的)。
 *   AE7  PTY:終端 agent 的環境沒有 denylist 任何一項(含 `OPENCODE_SERVER_*`)。
 *   AE8  Claude SDK:scripts/probe-claude-sdk-env.mjs 攔截 `ClaudeAgentSdkAdapter` 真正 spawn `claude` 時的 `env`——
 *        一律明確傳入(不再省略讓 SDK 繼承),且沒有 denylist 任何一項、provider env 與 PATH 還在。本機沒登入、不能用真模型,
 *        所以這條**只涵蓋「adapter 傳給 claude 子行程的環境」**,不涵蓋 claude 子行程之後自己再開的行程。
 *   AE9  core 的 log 裡沒有主 token 的值(診斷輸出不外洩)。
 *
 * 全程只啟動一個 core(外加一個探針行程),DESKMONY_HOME/DATA_DIR/WORKSPACE/CORE_PORT 四個都指向暫存目錄,並在繼續之前確認 core
 * 印出的 SQLite 路徑真的在暫存目錄底下。**所有憑證值都是這支測試產生的假值。**
 *
 * 前置需求:`pnpm build` 已跑過。
 * 用法:node scripts/e2e-agent-env.mjs
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { REPORT_ENV_PREFIX as OPENCODE_REPORT_ENV, REPORT_PRESENCE_PREFIX as OPENCODE_REPORT_PRESENCE } from "./fake-opencode-server.mjs";
import {
  REPORT_ENV_PREFIX as ACP_REPORT_ENV,
  REPORT_PRESENCE_PREFIX as ACP_REPORT_PRESENCE,
  CALL_BRIDGE_TOOL_PREFIX,
} from "./fake-acp-agent.mjs";
import { requireFreshBuild } from "./lib/require-fresh-build.mjs";
import { e2eProvidersEnv, fakeAcpOpencodeProvider, FAKE_OPENCODE, FAKE_ACP, FAKE_ACP_OPENCODE, FAKE_PTY } from "./lib/e2e-providers.mjs";

requireFreshBuild();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const CORE_ENTRY = path.join(REPO_ROOT, "apps", "core", "dist", "index.js");
const ADAPTERS_ENTRY = path.join(REPO_ROOT, "packages", "adapters", "dist", "index.js");
const PROBE_SCRIPT = path.join(__dirname, "probe-claude-sdk-env.mjs");
/** 避開其他 e2e 用過的 port(見 e2e-cli.mjs 檔頭的盤點;4740/4745 是 opencode 兩支)。 */
const PORT = 4748;

/** 不得出現在任何 agent 子行程環境裡的 Deskmony 憑證(opencode 伺服器密碼另外依 backend 處理,見各測試)。 */
const DESKMONY_SECRET_NAMES = [
  "DESKMONY_AUTH_TOKEN",
  "DESKMONY_MCP_BRIDGE_TOKEN",
  "DESKMONY_MCP_BRIDGE_GATEWAY_URL",
  "DESKMONY_MCP_BRIDGE_SESSION_ID",
  "DESKMONY_MCP_BRIDGE_NETWORK_ENABLED",
];
const OPENCODE_SERVER_NAMES = ["OPENCODE_SERVER_PASSWORD", "OPENCODE_SERVER_USERNAME"];
/** provider env 裡我們自己加的、**應該**傳得進去的對照變數。 */
const PASSTHROUGH_NAME = "E2E_ENV_PASSTHROUGH";

/** 這支測試產生的假憑證(隨機,每次不同;不是任何真實憑證)。 */
const MASTER_TOKEN = `e2e-master-${randomBytes(16).toString("hex")}`;
const AMBIENT = {
  DESKMONY_MCP_BRIDGE_TOKEN: `ambient-bridge-${randomBytes(8).toString("hex")}`,
  DESKMONY_MCP_BRIDGE_GATEWAY_URL: "ws://127.0.0.1:1",
  DESKMONY_MCP_BRIDGE_SESSION_ID: "ambient-session-id",
  DESKMONY_MCP_BRIDGE_NETWORK_ENABLED: "1",
  OPENCODE_SERVER_PASSWORD: `ambient-opencode-pw-${randomBytes(8).toString("hex")}`,
  OPENCODE_SERVER_USERNAME: "ambient-opencode-user",
};
/** 使用者在設定頁的 provider 環境變數裡自己填了主 token(沒有任何正當理由讓 agent 拿到,所以一樣要被刪)。 */
const USER_TYPED_PROVIDER_ENV = { DESKMONY_AUTH_TOKEN: `user-typed-${randomBytes(8).toString("hex")}`, [PASSTHROUGH_NAME]: "1" };

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`\n${ok ? "PASS" : "FAIL"} ${name}`);
  if (detail) console.log(`       ${detail}`);
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
const sha256 = (s) => createHash("sha256").update(s).digest("hex");

// =======================================================================
class TimelineClient {
  constructor(url) {
    this.url = url;
    this.pendingRpc = new Map();
    this.timeline = [];
  }

  async connect(token) {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`WS connect timeout (${this.url})`)), 10_000);
      this.ws.addEventListener("open", () => {
        clearTimeout(t);
        resolve();
      });
      this.ws.addEventListener("error", (e) => {
        clearTimeout(t);
        reject(new Error(`WS error (${this.url}): ${e.message ?? e}`));
      });
    });
    this.ws.addEventListener("message", (e) => this._handleMessage(e.data));
    if (token !== undefined) await this.rpc("auth", { token });
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
        else pending.reject(new Error(msg.error ?? "unknown gateway error"));
      }
      return;
    }
    if (msg.kind === "event") this.timeline.push({ channel: msg.channel, payload: msg.payload });
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

  waitFor(predicate, timeoutMs, fromIndex = 0) {
    const scan = () => {
      for (let i = fromIndex; i < this.timeline.length; i++) {
        if (predicate(this.timeline[i])) return { entry: this.timeline[i], index: i };
      }
      return undefined;
    };
    const found = scan();
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const poll = setInterval(() => {
        const hit = scan();
        if (hit) {
          clearInterval(poll);
          resolve(hit);
        } else if (Date.now() - start > timeoutMs) {
          clearInterval(poll);
          reject(new Error(`等待逾時 (${timeoutMs}ms),timeline 筆數=${this.timeline.length}`));
        }
      }, 25);
    });
  }
}

const isSessionEvent = (entry, sessionId, type) =>
  entry.channel === "session-event" && entry.payload.sessionId === sessionId && entry.payload.event.type === type;
const isTurnEnd = (entry, sessionId) => isSessionEvent(entry, sessionId, "completed") || isSessionEvent(entry, sessionId, "error");

// =======================================================================
/** core 的 stdout/stderr 全部累積在這(AE9 要掃有沒有洩漏主 token)。 */
let coreOutput = "";

function startCore({ dataDir, homeDir, workspaceDir, authReportFile }) {
  const env = {
    ...process.env,
    DESKMONY_CORE_PORT: String(PORT),
    DESKMONY_DATA_DIR: dataDir,
    DESKMONY_HOME: homeDir,
    DESKMONY_WORKSPACE: workspaceDir,
    ...e2eProvidersEnv([fakeAcpOpencodeProvider()]),
    FAKE_OPENCODE_AUTH_REPORT_FILE: authReportFile,
    // 這支測試的前提:真實桌面 app 裡 core 就是帶著主認證 token 啟動的;環境裡另外有不該外洩的其他 Deskmony/opencode 憑證。
    DESKMONY_AUTH_TOKEN: MASTER_TOKEN,
    ...AMBIENT,
  };
  // 決定性:不能讓執行這支測試的 shell 剛好有這些變數。
  delete env.OPENCODE_CONFIG_CONTENT;
  delete env.FAKE_OPENCODE_DISABLE_AUTH;
  const proc = spawn(process.execPath, [CORE_ENTRY], { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdoutBuffer = "";
  const dbPathPromise = new Promise((resolve) => {
    proc.stdout.on("data", (chunk) => {
      process.stdout.write(`[core:${PORT}] ${chunk}`);
      coreOutput += chunk.toString();
      stdoutBuffer += chunk.toString();
      const m = stdoutBuffer.match(/\[db\] using sqlite file at (.+)/);
      if (m) resolve(m[1].trim());
    });
  });
  proc.stderr.on("data", (chunk) => {
    process.stderr.write(`[core:${PORT}:err] ${chunk}`);
    coreOutput += chunk.toString();
  });
  return { proc, dbPathPromise };
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
      return;
    } catch (err) {
      lastErr = err;
      await sleep(300);
    }
  }
  throw new Error(`等待 gateway 啟動逾時: ${lastErr}`);
}

/** 只砍這支測試自己 spawn 的那一個 core(連同它的子程序樹),絕不 blanket kill。 */
async function killProcessTree(proc) {
  if (!proc || proc.exitCode !== null || proc.killed) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      proc.kill("SIGTERM");
    }
  } catch {
    // ignore
  }
  await sleep(500);
}

// =======================================================================
/** 建 session →(呼叫端的 body)→ 刪 session。 */
async function withSession(client, providerId, workspaceDir, title, body) {
  const {
    session: { id: sessionId },
  } = await client.rpc("session.create", { providerId, workingDir: workspaceDir, title }, 30_000);
  try {
    return await body(sessionId);
  } finally {
    await client.rpc("session.delete", { sessionId }, 15_000).catch(() => undefined);
  }
}

/** 送一則 prompt、等這一輪結束,回傳這一輪之後 history 裡所有 assistant 文字(串起來)。 */
async function drive(client, sessionId, text, timeoutMs = 30_000) {
  const from = client.timeline.length;
  await client.rpc("session.sendPrompt", { sessionId, prompt: { text } });
  await client.waitFor((e) => isTurnEnd(e, sessionId), timeoutMs, from);
  const { messages } = await client.rpc("session.history", { sessionId });
  return messages.filter((m) => m.role === "assistant").map((m) => m.content).join("\n");
}

function parsePresence(text) {
  const m = /PRESENCE:(\{.*?\})/s.exec(text);
  if (!m) throw new Error(`回覆裡找不到 PRESENCE:{...}: ${text.slice(0, 200)}`);
  return JSON.parse(m[1]);
}

const presenceNames = (extra = []) => [...DESKMONY_SECRET_NAMES, ...extra, PASSTHROUGH_NAME, "PATH"].join(",");
const allFalse = (presence, names) => names.every((n) => presence[n] === false);

async function setProviderEnv(client, providerId, env) {
  await client.rpc("settings.setProviderPrefs", { providerId, patch: { env } });
}

/** 用 bridge 設定(command + environment)真的 spawn 一個 mcp-bridge-server 子行程並呼叫 `list_sessions`。 */
async function callBridgeListSessions(command, args, environment) {
  const transport = new StdioClientTransport({ command, args, env: environment });
  const mcpClient = new Client({ name: "e2e-agent-env", version: "1.0.0" });
  try {
    await mcpClient.connect(transport);
    const result = await mcpClient.callTool({ name: "list_sessions", arguments: {} });
    return { isError: result.isError === true, text: result.content?.[0]?.text ?? "" };
  } finally {
    await mcpClient.close().catch(() => undefined);
  }
}

// =======================================================================
async function testPremise() {
  // 不帶 token 的連線不能用——證明 core 真的帶著主 token 啟動(否則後面「agent 環境沒有 token」是空洞的通過)。
  const anon = new TimelineClient(`ws://127.0.0.1:${PORT}`);
  await anon.connect(undefined);
  let anonRejected = false;
  try {
    await anon.rpc("session.list", {}, 5_000);
  } catch {
    anonRejected = true;
  }
  anon.close();
  const wrong = new TimelineClient(`ws://127.0.0.1:${PORT}`);
  let wrongRejected = false;
  try {
    await wrong.connect(`wrong-${randomUUID()}`);
  } catch {
    wrongRejected = true;
  }
  wrong.close();
  record(
    "AE1 前提:core 以 DESKMONY_AUTH_TOKEN 啟動——沒帶 token、帶錯 token 的連線都被拒(之後的 e2e client 帶對的 token 才能用)",
    anonRejected && wrongRejected,
    `anonRejected=${anonRejected}, wrongRejected=${wrongRejected}`,
  );
}

async function testBuildAgentChildEnv() {
  const { buildAgentChildEnv, AGENT_ENV_DENY_NAMES, AGENT_ENV_DENY_PREFIXES } = await import(pathToFileURL(ADAPTERS_ENTRY).href);
  const planted = {
    DESKMONY_AUTH_TOKEN: "unit-master",
    DESKMONY_MCP_BRIDGE_TOKEN: "unit-bridge",
    DESKMONY_MCP_BRIDGE_ANYTHING_ELSE: "unit-bridge-x",
    OPENCODE_SERVER_PASSWORD: "unit-oc-pw",
    OPENCODE_SERVER_USERNAME: "unit-oc-user",
    // 大小寫變體:Windows 的環境變數不分大小寫,`{ ...process.env }` 卻保留原本的大小寫(POSIX 上則是不同的兩個變數)
    Deskmony_Auth_Token: "unit-master-mixed-case",
    deskmony_mcp_bridge_session_id: "unit-session-lower",
    E2E_UNIT_KEEP: "keep-me",
  };
  // 先整份快照(Windows 上大小寫變體與原名是同一個變數,逐鍵存取會互相覆蓋)、全部放完才還原。
  const original = { ...process.env };
  const plantedUpper = new Set(Object.keys(planted).map((k) => k.toUpperCase()));
  for (const [k, v] of Object.entries(planted)) process.env[k] = v;
  const layerA = Object.freeze({ E2E_UNIT_LAYER: "a", E2E_UNIT_OVERRIDE: "from-a", DESKMONY_AUTH_TOKEN: "layer-a-master" });
  const layerB = Object.freeze({ E2E_UNIT_OVERRIDE: "from-b", DESKMONY_MCP_BRIDGE_TOKEN: "layer-b-bridge" });
  let env;
  let envNoLayers;
  try {
    env = buildAgentChildEnv(layerA, undefined, layerB);
    envNoLayers = buildAgentChildEnv();
  } finally {
    for (const k of Object.keys(process.env)) {
      if (plantedUpper.has(k.toUpperCase())) delete process.env[k];
    }
    for (const [k, v] of Object.entries(original)) {
      if (plantedUpper.has(k.toUpperCase())) process.env[k] = v;
    }
  }
  const upperKeys = (e) => Object.keys(e).map((k) => k.toUpperCase());
  const leaked = (e) => upperKeys(e).filter((k) => AGENT_ENV_DENY_NAMES.includes(k) || AGENT_ENV_DENY_PREFIXES.some((p) => k.startsWith(p)));
  const ok =
    // denylist 全中(含大小寫變體、含 layer 裡塞進來的)
    leaked(env).length === 0 &&
    leaked(envNoLayers).length === 0 &&
    // 其他變數保留、PATH 保留、後面的 layer 蓋前面的、undefined layer 略過
    env.E2E_UNIT_KEEP === "keep-me" &&
    env.E2E_UNIT_LAYER === "a" &&
    env.E2E_UNIT_OVERRIDE === "from-b" &&
    upperKeys(env).includes("PATH") &&
    // 沒動到 process.env 與 layer
    process.env.DESKMONY_AUTH_TOKEN === original.DESKMONY_AUTH_TOKEN &&
    process.env.E2E_UNIT_KEEP === undefined &&
    layerA.DESKMONY_AUTH_TOKEN === "layer-a-master" &&
    layerB.DESKMONY_MCP_BRIDGE_TOKEN === "layer-b-bridge" &&
    // denylist 的內容(釘住:有人悄悄移掉任何一項,這裡會紅)
    ["DESKMONY_AUTH_TOKEN", "OPENCODE_SERVER_PASSWORD", "OPENCODE_SERVER_USERNAME"].every((n) => AGENT_ENV_DENY_NAMES.includes(n)) &&
    AGENT_ENV_DENY_PREFIXES.includes("DESKMONY_MCP_BRIDGE_");
  record(
    "AE2 buildAgentChildEnv():denylist 全中(含不分大小寫變體、layer 裡塞進來的 DESKMONY_AUTH_TOKEN)、其他變數與 PATH 保留、後面的 layer 蓋前面的、不動 process.env 與 layer",
    ok,
    `leaked(env)=${JSON.stringify(leaked(env))}, leaked(noLayers)=${JSON.stringify(leaked(envNoLayers))}, keep=${env.E2E_UNIT_KEEP}, override=${env.E2E_UNIT_OVERRIDE}`,
  );
}

async function testAcpGeneric(client, workspaceDir) {
  await setProviderEnv(client, FAKE_ACP, USER_TYPED_PROVIDER_ENV);
  const presence = await withSession(client, FAKE_ACP, workspaceDir, "ae3", async (sessionId) => {
    const text = await drive(client, sessionId, `${ACP_REPORT_PRESENCE}${presenceNames(OPENCODE_SERVER_NAMES)}`);
    return parsePresence(text);
  });
  record(
    "AE3 ACP(一般 agent):子行程環境沒有 DESKMONY_AUTH_TOKEN/DESKMONY_MCP_BRIDGE_*/OPENCODE_SERVER_*(使用者在 provider env 自己填的主 token 也被刪),provider env 的其他變數與 PATH 照常有",
    allFalse(presence, [...DESKMONY_SECRET_NAMES, ...OPENCODE_SERVER_NAMES]) && presence[PASSTHROUGH_NAME] === true && presence.PATH === true,
    JSON.stringify(presence),
  );
}

async function testAcpBridgeStillWorks(client, workspaceDir) {
  await withSession(client, FAKE_ACP, workspaceDir, "ae4", async (sessionId) => {
    const text = await drive(client, sessionId, `${CALL_BRIDGE_TOOL_PREFIX}${JSON.stringify({ tool: "list_sessions", args: {} })}`, 60_000);
    let list = [];
    let parseError;
    try {
      const parsed = JSON.parse(text.slice("BRIDGE_TOOL_RESULT:".length));
      list = JSON.parse(parsed.content?.[0]?.text ?? "[]");
      if (parsed.isError) parseError = parsed.content?.[0]?.text;
    } catch (err) {
      parseError = `${String(err)}: ${text.slice(0, 200)}`;
    }
    const me = Array.isArray(list) ? list.find((s) => s.id === sessionId) : undefined;
    record(
      "AE4 ACP:agent 環境沒有 token,bridge 子行程仍拿得到它自己的 scoped token(靠 session/new 的 mcpServers[].env)——真的 spawn bridge、list_sessions 成功且 isYou 是這個 session",
      parseError === undefined && me?.isYou === true,
      parseError ?? `me=${JSON.stringify(me)}`,
    );
  });
}

async function testAcpOpencodeFamily(client, workspaceDir, serverPasswordShaOf) {
  await setProviderEnv(client, FAKE_ACP_OPENCODE, USER_TYPED_PROVIDER_ENV);
  await withSession(client, FAKE_ACP_OPENCODE, workspaceDir, "ae5", async (sessionId) => {
    const presence = parsePresence(await drive(client, sessionId, `${ACP_REPORT_PRESENCE}${presenceNames()}`));
    const envText = await drive(client, sessionId, ACP_REPORT_ENV);
    const m = /ENV:(\{.*\})/s.exec(envText);
    const serverAuth = m ? JSON.parse(m[1]).serverAuth : null;
    record(
      "AE5 ACP(family=opencode):子行程環境沒有 DESKMONY_*;`opencode acp` 行程自己的伺服器密碼是 Deskmony 新產生的(長度 43、使用者名稱 deskmony,不是啟動 core 的 shell 裡那個繼承值)",
      allFalse(presence, DESKMONY_SECRET_NAMES) &&
        serverAuth !== null &&
        serverAuth.username === "deskmony" &&
        serverAuth.passwordLength === 43 &&
        serverAuth.passwordSha256 !== serverPasswordShaOf.ambient,
      `presence=${JSON.stringify(presence)}, serverAuth.username=${serverAuth?.username}, len=${serverAuth?.passwordLength}`,
    );
  });
}

async function testOpencodeHttp(client, workspaceDir, authReportFile, serverPasswordShaOf) {
  await setProviderEnv(client, FAKE_OPENCODE, USER_TYPED_PROVIDER_ENV);
  const { readFileSync } = await import("node:fs");
  await withSession(client, FAKE_OPENCODE, workspaceDir, "ae6", async (sessionId) => {
    const presence = parsePresence(await drive(client, sessionId, `${OPENCODE_REPORT_PRESENCE}${presenceNames(OPENCODE_SERVER_NAMES)}`));
    // fake 的認證報告檔:最後一個 start 是這個 session 的 opencode 子行程拿到的伺服器密碼(測試專用旁路,見 fake-opencode-server.mjs 檔頭)。
    const starts = readFileSync(authReportFile, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((e) => e.kind === "start");
    const lastStart = starts[starts.length - 1];
    const passwordIsFresh = Boolean(lastStart) && typeof lastStart.password === "string" && lastStart.password.length === 43 && sha256(lastStart.password) !== serverPasswordShaOf.ambient;

    const envText = await drive(client, sessionId, OPENCODE_REPORT_ENV);
    const m = /ENV:(\{.*\})/s.exec(envText);
    const config = m ? JSON.parse(JSON.parse(m[1]).OPENCODE_CONFIG_CONTENT ?? "null") : null;
    const mcp = config?.mcp?.deskmony;

    record(
      "AE6a OpenCode(HTTP):子行程環境沒有 DESKMONY_AUTH_TOKEN/DESKMONY_MCP_BRIDGE_*;opencode 行程自己的伺服器密碼是 Deskmony 新產生的(不是繼承值)——該行程需要它,agent 的 bash 環境另由 opencode 外掛濾掉(見 e2e-opencode-permissions.mjs 與 docs/DECISIONS.md §J)",
      allFalse(presence, DESKMONY_SECRET_NAMES) &&
        presence.OPENCODE_SERVER_PASSWORD === true &&
        presence[PASSTHROUGH_NAME] === true &&
        presence.PATH === true &&
        passwordIsFresh,
      `presence=${JSON.stringify(presence)}, passwordIsFresh=${passwordIsFresh}`,
    );

    // bridge 的環境是 `mcp.deskmony.environment` 明確交給 opencode 的——拿它真的 spawn 一個 bridge,證明 token 沒有因為濾掉繼承而斷掉。
    let bridge;
    try {
      bridge = mcp ? await callBridgeListSessions(mcp.command[0], mcp.command.slice(1), mcp.environment) : { isError: true, text: "沒有 mcp.deskmony" };
    } catch (err) {
      bridge = { isError: true, text: String(err) };
    }
    let me;
    try {
      me = JSON.parse(bridge.text).find((s) => s.id === sessionId);
    } catch {
      // 保持 undefined
    }
    record(
      "AE6b OpenCode(HTTP):`mcp.deskmony.environment` 仍含 scoped token(DESKMONY_MCP_BRIDGE_TOKEN),用那份環境真的 spawn bridge、list_sessions 成功且 isYou 是這個 session",
      Boolean(mcp?.environment?.DESKMONY_MCP_BRIDGE_TOKEN) && !bridge.isError && me?.isYou === true,
      bridge.isError ? bridge.text.slice(0, 200) : `me=${JSON.stringify(me)}`,
    );
  });
}

async function testPty(client, workspaceDir) {
  await setProviderEnv(client, FAKE_PTY, USER_TYPED_PROVIDER_ENV);
  await withSession(client, FAKE_PTY, workspaceDir, "ae7", async (sessionId) => {
    // ConPTY 會在 80 欄折行、回顯輸入、夾控制碼——先去掉控制碼與換行再比對。
    const ptyText = () =>
      client.timeline
        .filter((e) => isSessionEvent(e, sessionId, "terminal-data"))
        .map((e) => e.payload.event.data)
        .join("")
        .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
        .replace(/\x1b\][^\x07]*\x07/g, "")
        .replace(/[\r\n]/g, "");
    const waitText = async (re, timeoutMs) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const m = re.exec(ptyText());
        if (m) return m;
        await sleep(100);
      }
      throw new Error(`等待終端輸出逾時: ${re}; 目前=${JSON.stringify(ptyText().slice(-200))}`);
    };
    await waitText(/READY/, 20_000);
    await client.rpc("session.sendPrompt", { sessionId, prompt: { text: `REPORT_PRESENCE:${presenceNames(OPENCODE_SERVER_NAMES)}` } });
    const m = await waitText(/PRESENCE:(\{[^}]*\})/, 20_000);
    const presence = JSON.parse(m[1]);
    record(
      "AE7 PTY:終端 agent 的環境沒有 DESKMONY_AUTH_TOKEN/DESKMONY_MCP_BRIDGE_*/OPENCODE_SERVER_*(使用者在 provider env 自己填的主 token 也被刪),provider env 的其他變數與 PATH 照常有",
      allFalse(presence, [...DESKMONY_SECRET_NAMES, ...OPENCODE_SERVER_NAMES]) && presence[PASSTHROUGH_NAME] === true && presence.PATH === true,
      JSON.stringify(presence),
    );
  });
}

async function testClaudeSdkProbe() {
  const probeCwd = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-agent-env-probe-"));
  const env = { ...process.env, DESKMONY_AUTH_TOKEN: MASTER_TOKEN, ...AMBIENT, Deskmony_Mcp_Bridge_Extra_Variant: "mixed-case-variant" };
  const names = [...DESKMONY_SECRET_NAMES, ...OPENCODE_SERVER_NAMES, "DESKMONY_MCP_BRIDGE_EXTRA_VARIANT", PASSTHROUGH_NAME, "PATH"].join(",");
  try {
    const run = spawnSync(process.execPath, [PROBE_SCRIPT, ADAPTERS_ENTRY, names, probeCwd], { env, encoding: "utf8", timeout: 90_000 });
    const m = /PROBE_RESULT:(\{.*\})/.exec(run.stdout ?? "");
    if (!m) throw new Error(`探針沒有輸出結果(exit=${run.status}): ${(run.stdout ?? "").slice(-300)} ${(run.stderr ?? "").slice(-300)}`);
    const result = JSON.parse(m[1]);
    const secretNames = [...DESKMONY_SECRET_NAMES, ...OPENCODE_SERVER_NAMES, "DESKMONY_MCP_BRIDGE_EXTRA_VARIANT"];
    record(
      "AE8 Claude SDK:adapter 真正 spawn `claude` 時一律明確傳入 env(不再省略讓 SDK 繼承整份 process.env),沒有 DESKMONY_AUTH_TOKEN/DESKMONY_MCP_BRIDGE_*(含大小寫變體)/OPENCODE_SERVER_*,provider env 與 PATH 還在(涵蓋範圍:adapter 傳給 claude 子行程的環境;本機沒登入,不跑真模型)",
      result.envProvided === true && allFalse(result.presence, secretNames) && result.presence[PASSTHROUGH_NAME] === true && result.presence.PATH === true,
      JSON.stringify(result),
    );
  } finally {
    try {
      rmSync(probeCwd, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

// =======================================================================
async function main() {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-agent-env-data-"));
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-agent-env-home-"));
  const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-agent-env-ws-"));
  const authReportDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-agent-env-auth-"));
  const authReportFile = path.join(authReportDir, "fake-opencode-auth-report.jsonl");
  const serverPasswordShaOf = { ambient: sha256(AMBIENT.OPENCODE_SERVER_PASSWORD) };

  let core;
  let client;
  try {
    core = startCore({ dataDir, homeDir, workspaceDir, authReportFile });
    const dbPath = await Promise.race([core.dbPathPromise, sleep(20_000).then(() => undefined)]);
    const normalize = (p) => path.resolve(p).toLowerCase();
    if (!dbPath || !normalize(dbPath).startsWith(normalize(dataDir))) {
      // 隔離失敗:立刻停掉,不要讓後面的 session.create 寫進別人的 DB。
      throw new Error(`core 的 SQLite 路徑不在暫存目錄底下(${dbPath ?? "沒印出來"},預期在 ${dataDir} 底下)——已中止`);
    }
    await waitForPort(`ws://127.0.0.1:${PORT}`, 20_000);

    console.log("=== AE1:前提(core 真的有開認證)===");
    await testPremise();
    client = new TimelineClient(`ws://127.0.0.1:${PORT}`);
    await client.connect(MASTER_TOKEN);

    console.log("\n=== AE2:buildAgentChildEnv() ===");
    await testBuildAgentChildEnv();

    console.log("\n=== AE3-AE5:ACP ===");
    await testAcpGeneric(client, workspaceDir);
    await testAcpBridgeStillWorks(client, workspaceDir);
    await testAcpOpencodeFamily(client, workspaceDir, serverPasswordShaOf);

    console.log("\n=== AE6:OpenCode(HTTP)===");
    await testOpencodeHttp(client, workspaceDir, authReportFile, serverPasswordShaOf);

    console.log("\n=== AE7:PTY ===");
    await testPty(client, workspaceDir);

    console.log("\n=== AE8:Claude SDK(攔截 spawn 的 env)===");
    await testClaudeSdkProbe();

    record(
      "AE9 core 的 log 裡沒有主 token 與使用者在 provider env 填的 token 的值(診斷輸出不外洩)",
      !coreOutput.includes(MASTER_TOKEN) && !coreOutput.includes(USER_TYPED_PROVIDER_ENV.DESKMONY_AUTH_TOKEN),
      "掃描 core 的 stdout/stderr 全文",
    );
  } catch (err) {
    record("執行過程發生未預期錯誤", false, err instanceof Error ? err.stack : String(err));
  } finally {
    client?.close();
    await killProcessTree(core?.proc);
    for (const dir of [dataDir, homeDir, workspaceDir, authReportDir]) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n\n========== 總結:${results.length - failed.length}/${results.length} 通過 ==========`);
  for (const r of failed) {
    console.log(`  FAIL: ${r.name}`);
  }
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[e2e-agent-env] fatal:", err);
  process.exit(1);
});
