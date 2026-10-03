#!/usr/bin/env node
/**
 * scripts/e2e-opencode-permissions.mjs
 *
 * 2026-10-03:OpenCode session 的工具呼叫一律要經過 Deskmony 的權限引擎(default-deny)。
 *
 * ---- 修的是什麼 --------------------------------------------------------
 *
 * Deskmony 的核心設計是 default-deny 政策引擎(docs/DECISIONS.md §C):Claude SDK 與一般 ACP agent 的每個工具呼叫
 * 都會變成 `permission-request`,由 `PolicyEngine.decide()` 裁決。但 **opencode 預設所有權限都是 allow**,只有它
 * 自己設定裡標成 "ask" 的工具才會發權限請求——使用者的 opencode 設定通常沒有 `permission` 段,所以 OpenCode session
 * 跑 bash/edit/webfetch/MCP 工具時完全不經過政策引擎(hard-deny 四類形同虛設)。
 *
 * 修法:Deskmony 啟動 opencode 子行程時(`opencode`(HTTP)與 `opencode-acp` 兩種 provider),透過環境變數
 * `OPENCODE_CONFIG_CONTENT` 注入「所有工具都 ask」的設定(packages/adapters/src/opencode-config.ts;寫法與實測依據
 * 見該檔頭)。這支測試用 fake 後端把行為釘住——**真實 opencode 的實測**(always-ask 下 bash 真的跳出
 * permission-request)另外手動跑過,見提交說明。
 *
 *   PM1  HTTP:沒有使用者設定時,子行程收到的 `OPENCODE_CONFIG_CONTENT` 是「所有工具 ask」(`*` 與 `**` 都是 ask)。
 *   PM2  HTTP:使用者在 provider 環境變數裡給了自己的 `OPENCODE_CONFIG_CONTENT` → 深度合併(使用者的其他鍵保留),
 *        **Deskmony 的 permission 優先**:使用者寫的 `{"bash":"allow","*":"allow"}` 排在 Deskmony 的 ask **之前**
 *        (opencode 是最後符合者生效,所以最後生效的仍是 ask)。
 *   PM3  HTTP:使用者的值不是合法 JSON → console.warn 並只用 Deskmony 的,session 照常起得來。
 *   PM4  ACP(`family: "opencode"` 的 provider):同樣注入;另外三個唯讀查詢工具預先放行、`task` 工具停用
 *        (`opencode acp` 不轉發 subagent 子 session 的權限請求,實測會卡死),`create_session`/`send_to_session` 不放行。
 *   PM5  ACP 對照組:沒有宣告 `family` 的 ACP agent **不會**被注入(其他 agent 不受影響)。
 *   PM6  HTTP:permission-request 帶著工具參數(PolicyEngine 的 hard-deny/allowlist 全靠 input 判斷)——
 *        `running` 先到(用工具 part 的 input)與 `permission.asked` 先到(退而用它的 metadata)兩種順序都要有。
 *   PM7  端到端:YOLO(auto-accept-all)下,帶 `git push --force` 的 bash 被 hard-deny 擋下(source=policy、deny),
 *        一般指令照常自動放行——證明 hard-deny 對 OpenCode 真的生效,不只是「有發 permission-request」。
 *   PM8  subagent:`task` 工具建立的子 session 發的 `permission.asked`(sessionID 是子 session)會被轉發給 Deskmony
 *        裁決(否則 opencode 永遠等一個沒人回的權限,subagent 卡死);子 session 的文字不混進本 session 的對話;
 *        **不相干的陌生 session** 的權限請求不轉發、不替它作答。
 *
 * 全程走 scripts/fake-opencode-server.mjs / fake-acp-agent.mjs(決定性、不呼叫任何模型)。只啟動一個 core,
 * DESKMONY_HOME/DATA_DIR/WORKSPACE/CORE_PORT 四個都指向暫存目錄,並在繼續之前確認 core 印出的 SQLite 路徑真的在
 * 暫存目錄底下——漏設任何一個都可能連到使用者真實的 ~/.deskmony/deskmony.db。
 *
 * 前置需求:`pnpm build` 已跑過。
 * 用法:node scripts/e2e-opencode-permissions.mjs
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  TOOL_CALL_PREFIX,
  TOOL_CALL_INPUT,
  TOOL_CALL_ASK_FIRST_MARKER,
  REPORT_ENV_PREFIX as OPENCODE_REPORT_ENV,
  SUBAGENT_PERMISSION_PREFIX,
  SUBAGENT_CHILD_TEXT,
  SUBAGENT_CHILD_COMMAND,
} from "./fake-opencode-server.mjs";
import { REPORT_ENV_PREFIX as ACP_REPORT_ENV } from "./fake-acp-agent.mjs";
import { requireFreshBuild } from "./lib/require-fresh-build.mjs";
import { e2eProvidersEnv, fakeAcpOpencodeProvider, FAKE_OPENCODE, FAKE_ACP, FAKE_ACP_OPENCODE } from "./lib/e2e-providers.mjs";

requireFreshBuild();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const CORE_ENTRY = path.join(REPO_ROOT, "apps", "core", "dist", "index.js");
const PORT = 4745;

const QUERY_TOOLS = ["deskmony_list_agents", "deskmony_list_sessions", "deskmony_read_session"];

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`\n${ok ? "PASS" : "FAIL"} ${name}`);
  if (detail) console.log(`       ${detail}`);
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// =======================================================================
class TimelineClient {
  constructor(url) {
    this.url = url;
    this.pendingRpc = new Map();
    this.timeline = [];
  }

  async connect() {
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
    if (msg.kind === "event") {
      this.timeline.push({ channel: msg.channel, payload: msg.payload });
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

  /** 從 fromIndex 起找第一筆符合的推播,回傳 `{ entry, index }`。 */
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
const isPermissionResolved = (entry, sessionId) => entry.channel === "permission-resolved" && entry.payload.sessionId === sessionId;

// =======================================================================
/** core 的 stdout/stderr 全部累積在這(PM3 要看 console.warn 有沒有印)。 */
let coreOutput = "";

function startCore({ dataDir, homeDir, workspaceDir }) {
  const env = {
    ...process.env,
    DESKMONY_CORE_PORT: String(PORT),
    DESKMONY_DATA_DIR: dataDir,
    DESKMONY_HOME: homeDir,
    DESKMONY_WORKSPACE: workspaceDir,
    ...e2eProvidersEnv([fakeAcpOpencodeProvider()]),
  };
  // 決定性:不能讓執行這支測試的 shell 剛好有這個變數,否則 PM1/PM5 的「沒有使用者設定」前提就不成立。
  delete env.OPENCODE_CONFIG_CONTENT;
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
/** 建 session → 請 fake 後端回顯 OPENCODE_CONFIG_CONTENT → 刪 session。回傳 `null`(子行程沒收到這個變數)或 `{ raw, config }`。 */
async function reportOpencodeConfig(client, providerId, workspaceDir, reportPrefix, title) {
  const {
    session: { id: sessionId },
  } = await client.rpc("session.create", { providerId, workingDir: workspaceDir, title }, 30_000);
  try {
    const from = client.timeline.length;
    await client.rpc("session.sendPrompt", { sessionId, prompt: { text: reportPrefix } });
    await client.waitFor((e) => isTurnEnd(e, sessionId), 20_000, from);
    const { messages } = await client.rpc("session.history", { sessionId });
    const text = messages.filter((m) => m.role === "assistant").map((m) => m.content).join("\n");
    const m = /ENV:(\{.*\})/s.exec(text);
    if (!m) throw new Error(`回覆裡找不到 ENV:{...}: ${text.slice(0, 200)}`);
    const raw = JSON.parse(m[1]).OPENCODE_CONFIG_CONTENT;
    return raw === null ? null : { raw, config: JSON.parse(raw) };
  } finally {
    await client.rpc("session.delete", { sessionId }, 15_000).catch(() => undefined);
  }
}

async function setProviderEnv(client, providerId, value) {
  await client.rpc("settings.setProviderPrefs", { providerId, patch: { env: { OPENCODE_CONFIG_CONTENT: value } } });
}

const USER_CONFIG = {
  model: "user/model",
  plugin: ["user-plugin"],
  mcp: { mine: { type: "local", command: ["my-mcp"], enabled: true } },
  // 使用者自己寫的「全放行」:Deskmony 的 ask 必須排在它們之後才會贏(opencode 是最後符合者生效)。
  permission: { bash: "allow", "*": "allow", edit: { "src/*": "allow" } },
};

// =======================================================================
async function testHttpDefault(client, workspaceDir) {
  const got = await reportOpencodeConfig(client, FAKE_OPENCODE, workspaceDir, OPENCODE_REPORT_ENV, "pm1");
  const keys = got ? Object.keys(got.config.permission ?? {}) : [];
  record(
    "PM1 HTTP:沒有使用者設定時,opencode 子行程收到的 OPENCODE_CONFIG_CONTENT 是「所有工具 ask」(`*` 與 `**` 都是 ask,沒有任何 allow)",
    got !== null &&
      isDeepStrictEqual(got.config.permission, { "*": "ask", "**": "ask" }) &&
      keys.length === 2,
    got ? got.raw : "子行程沒有收到 OPENCODE_CONFIG_CONTENT",
  );
}

async function testHttpMerge(client, workspaceDir) {
  await setProviderEnv(client, FAKE_OPENCODE, JSON.stringify(USER_CONFIG));
  const got = await reportOpencodeConfig(client, FAKE_OPENCODE, workspaceDir, OPENCODE_REPORT_ENV, "pm2");
  const perm = got?.config.permission ?? {};
  const keys = Object.keys(perm);
  const lastKey = keys[keys.length - 1];
  const ok =
    got !== null &&
    got.config.model === USER_CONFIG.model &&
    isDeepStrictEqual(got.config.plugin, USER_CONFIG.plugin) &&
    isDeepStrictEqual(got.config.mcp?.mine, USER_CONFIG.mcp.mine) &&
    // 使用者的鍵還在(不丟資訊),而且都排在 Deskmony 的 `**` 之前;`*` 被 Deskmony 的 ask 取代。
    perm.bash === "allow" &&
    isDeepStrictEqual(perm.edit, { "src/*": "allow" }) &&
    perm["*"] === "ask" &&
    perm["**"] === "ask" &&
    lastKey === "**" &&
    keys.indexOf("bash") < keys.indexOf("**") &&
    keys.indexOf("edit") < keys.indexOf("**");
  record(
    "PM2 HTTP:使用者在 provider 環境變數給的 OPENCODE_CONFIG_CONTENT 深度合併(model/plugin/mcp.mine 保留),Deskmony 的 permission 優先(使用者的 allow 排在 Deskmony 的 `**` ask 之前、`*` 被取代)",
    ok,
    got ? `permission keys=${JSON.stringify(keys)}, raw=${got.raw}` : "子行程沒有收到 OPENCODE_CONFIG_CONTENT",
  );
}

async function testHttpBrokenJson(client, workspaceDir) {
  await setProviderEnv(client, FAKE_OPENCODE, "this is { not json");
  const before = coreOutput.length;
  const got = await reportOpencodeConfig(client, FAKE_OPENCODE, workspaceDir, OPENCODE_REPORT_ENV, "pm3");
  const warned = coreOutput.slice(before).includes("不是合法的 JSON");
  record(
    "PM3 HTTP:使用者的 OPENCODE_CONFIG_CONTENT 不是合法 JSON → console.warn 並只用 Deskmony 的設定(所有工具 ask),session 照常起得來",
    got !== null && isDeepStrictEqual(got.config, { permission: { "*": "ask", "**": "ask" } }) && warned,
    `warned=${warned}, raw=${got?.raw}`,
  );
}

async function testAcpFamily(client, workspaceDir) {
  // 先沒有使用者設定
  const plain = await reportOpencodeConfig(client, FAKE_ACP_OPENCODE, workspaceDir, ACP_REPORT_ENV, "pm4a");
  const plainPerm = plain?.config.permission ?? {};
  const plainKeys = Object.keys(plainPerm);
  const okPlain =
    plain !== null &&
    plainPerm["*"] === "ask" &&
    plainPerm["**"] === "ask" &&
    QUERY_TOOLS.every((t) => plainPerm[t] === "allow" && plainKeys.indexOf(t) > plainKeys.indexOf("**")) &&
    plainPerm.task === "deny" &&
    plainKeys.indexOf("task") > plainKeys.indexOf("**") &&
    // create_session / send_to_session 不預先放行(走一般的 default-deny:always-ask 會跳確認,auto/YOLO 自動放行)
    plainPerm.deskmony_create_session === undefined &&
    plainPerm.deskmony_send_to_session === undefined &&
    // ACP 的 MCP server 經 session/new 掛載,不寫進這份設定
    plain.config.mcp === undefined;
  record(
    "PM4a ACP(family=opencode):注入所有工具 ask;三個唯讀查詢工具(list_agents/list_sessions/read_session)預先放行且排在 `**` 之後;task(subagent)停用;create_session/send_to_session 不放行;mcp 不寫進設定",
    okPlain,
    plain ? plain.raw : "子行程沒有收到 OPENCODE_CONFIG_CONTENT",
  );

  // 再加使用者設定
  await setProviderEnv(client, FAKE_ACP_OPENCODE, JSON.stringify(USER_CONFIG));
  const merged = await reportOpencodeConfig(client, FAKE_ACP_OPENCODE, workspaceDir, ACP_REPORT_ENV, "pm4b");
  const perm = merged?.config.permission ?? {};
  const keys = Object.keys(perm);
  const okMerged =
    merged !== null &&
    merged.config.model === USER_CONFIG.model &&
    isDeepStrictEqual(merged.config.mcp?.mine, USER_CONFIG.mcp.mine) &&
    perm.bash === "allow" &&
    perm["*"] === "ask" &&
    perm["**"] === "ask" &&
    keys.indexOf("bash") < keys.indexOf("**") &&
    keys.indexOf("edit") < keys.indexOf("**") &&
    QUERY_TOOLS.every((t) => perm[t] === "allow") &&
    perm.task === "deny";
  record(
    "PM4b ACP(family=opencode):使用者既有的 OPENCODE_CONFIG_CONTENT 同樣深度合併,Deskmony 的 permission 優先",
    okMerged,
    merged ? `permission keys=${JSON.stringify(keys)}` : "子行程沒有收到 OPENCODE_CONFIG_CONTENT",
  );
}

async function testAcpControl(client, workspaceDir) {
  const got = await reportOpencodeConfig(client, FAKE_ACP, workspaceDir, ACP_REPORT_ENV, "pm5");
  record(
    "PM5 ACP 對照組:沒有宣告 family 的 ACP agent 不會被注入 OPENCODE_CONFIG_CONTENT(其他 agent 的環境不受影響)",
    got === null,
    got ? got.raw : "(沒有注入)",
  );
}

// =======================================================================
async function permissionRequestInput(client, sessionId, promptText) {
  const from = client.timeline.length;
  await client.rpc("session.sendPrompt", { sessionId, prompt: { text: promptText } });
  const req = await client.waitFor((e) => isSessionEvent(e, sessionId, "permission-request"), 15_000, from);
  const event = req.entry.payload.event;
  await client.rpc("permission.resolve", { sessionId, requestId: event.requestId, decision: "allow" });
  await client.waitFor((e) => isTurnEnd(e, sessionId), 15_000, from);
  return event;
}

async function testPermissionRequestInput(client, sessionId) {
  const runningFirst = await permissionRequestInput(client, sessionId, `${TOOL_CALL_PREFIX} run echo`);
  const askFirst = await permissionRequestInput(client, sessionId, `${TOOL_CALL_PREFIX} ${TOOL_CALL_ASK_FIRST_MARKER} run echo`);
  record(
    "PM6 HTTP:permission-request 帶著工具參數——running 先到(用工具 part 的 input)與 permission.asked 先到(退而用它的 metadata)都是 {command}",
    runningFirst.toolName === "bash" &&
      isDeepStrictEqual(runningFirst.input, TOOL_CALL_INPUT) &&
      askFirst.toolName === "bash" &&
      isDeepStrictEqual(askFirst.input, { command: TOOL_CALL_INPUT.command }),
    JSON.stringify({ runningFirst: runningFirst.input, askFirst: askFirst.input }),
  );
}

async function testHardDenyEndToEnd(client, sessionId) {
  await client.rpc("session.setPermissionMode", { sessionId, mode: "auto-accept-all" });

  const run = async (command) => {
    const from = client.timeline.length;
    await client.rpc("session.sendPrompt", { sessionId, prompt: { text: `${TOOL_CALL_PREFIX} [command:${command}]` } });
    const resolved = await client.waitFor((e) => isPermissionResolved(e, sessionId), 15_000, from);
    await client.waitFor((e) => isTurnEnd(e, sessionId), 15_000, from);
    const { messages } = await client.rpc("session.history", { sessionId });
    const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant")?.content ?? "";
    return { ...resolved.entry.payload, lastAssistant };
  };

  const dangerous = await run("git push --force origin main");
  const benign = await run("echo hello");
  record(
    "PM7 端到端:YOLO 下帶 `git push --force` 的 OpenCode bash 被 hard-deny 擋下(source=policy、deny,fake 後端收到 reject);一般指令照常自動放行(allow)——證明 permission-request 的 input 真的進了政策引擎",
    dangerous.decision === "deny" &&
      dangerous.source === "policy" &&
      dangerous.lastAssistant.includes("Permission denied") &&
      benign.decision === "allow" &&
      benign.source === "policy" &&
      benign.lastAssistant.includes("Done running the command"),
    JSON.stringify({ dangerous: { d: dangerous.decision, s: dangerous.source, t: dangerous.lastAssistant }, benign: { d: benign.decision, s: benign.source, t: benign.lastAssistant } }),
  );
}

async function testSubagentChildPermission(client, sessionId) {
  const from = client.timeline.length;
  await client.rpc("session.sendPrompt", { sessionId, prompt: { text: SUBAGENT_PERMISSION_PREFIX } });
  const req = await client.waitFor((e) => isSessionEvent(e, sessionId, "permission-request"), 15_000, from);
  const event = req.entry.payload.event;
  await client.rpc("permission.resolve", { sessionId, requestId: event.requestId, decision: "allow" });
  await client.waitFor((e) => isTurnEnd(e, sessionId), 20_000, from);
  const requests = client.timeline.slice(from).filter((e) => isSessionEvent(e, sessionId, "permission-request"));
  const { messages } = await client.rpc("session.history", { sessionId });
  const assistantText = messages.filter((m) => m.role === "assistant").map((m) => m.content).join("\n");
  record(
    "PM8 subagent:子 session 的 permission.asked 被轉發給 Deskmony 裁決(toolName=bash、input={command},回覆送回 opencode);子 session 的文字不混進本 session 的對話;不相干的陌生 session 的權限請求不轉發、也沒有被回覆",
    event.toolName === "bash" &&
      isDeepStrictEqual(event.input, { command: SUBAGENT_CHILD_COMMAND }) &&
      requests.length === 1 &&
      assistantText.includes("[child-reply:once]") &&
      assistantText.includes("[stranger-reply:false]") &&
      !assistantText.includes(SUBAGENT_CHILD_TEXT),
    JSON.stringify({ requestCount: requests.length, toolName: event.toolName, input: event.input, assistantText }),
  );
}

// =======================================================================
async function main() {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-oc-perm-data-"));
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-oc-perm-home-"));
  const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-oc-perm-ws-"));

  let core;
  let client;
  const sessionIds = [];
  try {
    core = startCore({ dataDir, homeDir, workspaceDir });
    const dbPath = await Promise.race([core.dbPathPromise, sleep(20_000).then(() => undefined)]);
    const normalize = (p) => path.resolve(p).toLowerCase();
    if (!dbPath || !normalize(dbPath).startsWith(normalize(dataDir))) {
      // 隔離失敗:立刻停掉,不要讓後面的 session.create 寫進別人的 DB。
      throw new Error(`core 的 SQLite 路徑不在暫存目錄底下(${dbPath ?? "沒印出來"},預期在 ${dataDir} 底下)——已中止`);
    }
    await waitForPort(`ws://127.0.0.1:${PORT}`, 20_000);
    client = new TimelineClient(`ws://127.0.0.1:${PORT}`);
    await client.connect();

    console.log("=== PM1-PM3:HTTP(opencode)啟動時注入的設定 ===");
    await testHttpDefault(client, workspaceDir);
    await testHttpMerge(client, workspaceDir);
    await testHttpBrokenJson(client, workspaceDir);

    console.log("\n=== PM4-PM5:ACP(family=opencode)與對照組 ===");
    await testAcpFamily(client, workspaceDir);
    await testAcpControl(client, workspaceDir);

    console.log("\n=== PM6-PM8:HTTP 的 permission-request ===");
    const {
      session: { id: httpSessionId },
    } = await client.rpc("session.create", { providerId: FAKE_OPENCODE, workingDir: workspaceDir, title: "e2e-oc-perm" }, 30_000);
    sessionIds.push(httpSessionId);
    await testPermissionRequestInput(client, httpSessionId);
    await testSubagentChildPermission(client, httpSessionId);
    // PM7 會把 session 切到 YOLO,放最後。
    await testHardDenyEndToEnd(client, httpSessionId);
  } catch (err) {
    record("執行過程發生未預期錯誤", false, err instanceof Error ? err.stack : String(err));
  } finally {
    // 先讓 adapter 正常收掉 fake server 子程序,再停 core。
    for (const sessionId of sessionIds) {
      await client?.rpc("session.delete", { sessionId }, 15_000).catch(() => undefined);
    }
    client?.close();
    await killProcessTree(core?.proc);
    for (const dir of [dataDir, homeDir, workspaceDir]) {
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
  console.error("[e2e-opencode-permissions] fatal:", err);
  process.exit(1);
});
