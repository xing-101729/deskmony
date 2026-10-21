#!/usr/bin/env node
/**
 * scripts/e2e-side-panel-browser.mjs
 *
 * 2026-10-21(右側面板 P4a:agent 瀏覽器工具 = MCP 工具 + core 轉送 + 政策,見 docs/LAYER-4-detail-design/side-panel_detail.md §P4a.4、
 * docs/DECISIONS.md §L.2)端到端測試。**決定性**:隔離的 core + fake ACP agent 建 session(拿它真實核發的 scoped bridge token)+
 * 一個**假的 browser host**(WS client,`browser.registerHost` 之後對每個 `browser-command` 回固定結果並記錄收到的指令)。
 * 真正的 host 是桌面 app 的 renderer,P4b 才實作。
 *
 * 工具用兩種方式驅動:(a)**真的 `mcp-bridge-server` 子行程 + MCP client**(跟 ACP/OpenCode 的 agent 一樣走完整管線,
 * 驗工具輸出的格式);(b)直接用同一個 scoped token 對 gateway 打 `browser.*ForAgent`(MCP 工具只回錯誤文字,要驗 `errorCode` 只能走這條)。
 *
 *   BR-1   `browser_navigate` 到 localhost:host 收到指令(op/sessionId/網址),工具回傳 host 的結果。
 *   BR-1b  loopback 的各種寫法(localhost/大小寫、127.0.0.0/8、`127.1`、`0x7f.0.0.1`、`2130706433`、`[::1]`、`*.localhost`)放行,
 *          送給 host 的是**正規化後的 href**;長得像 loopback 的外部網站(`localhost.evil.test`、`127.0.0.1.evil.test`、userinfo 把戲、
 *          `[::ffff:7f00:1]`、`0.0.0.0`、內網 IP)一律 `browser.hostNotAllowed`,**host 一個指令都收不到**。
 *   BR-2   外部網站不在 allowedHosts → `browser.hostNotAllowed`(訊息教 agent 怎麼轉告使用者放行)、host 沒收到;
 *          加進 `policy.allowedHosts`(不分大小寫、完全比對 hostname)重啟 core 後放行,其他主機仍被擋;
 *          session 開著「真.無限制」時放行、關掉後又被擋。
 *   BR-3   `file:`/`javascript:`/`data:`/`ftp:`/`chrome:`/`view-source:`/`blob:`(含大小寫、換行穿插的變體)→ `browser.unsupportedScheme`;
 *          不是完整網址、url 與 action 同時給或都沒給 → `browser.invalidArgs`;以上 host 都沒收到。
 *   BR-4   沒有 host → `browser.noHost`;指令送出後 host 斷線 → `browser.hostDisconnected`;host 不回 → `browser.timeout`
 *          (用環境變數縮短);逾時之後才到的結果被忽略;斷線後重新註冊可以繼續用;新 host 取代舊 host。
 *   BR-5   `browser-command` 只送到 host 連線:另一條一般連線與 scoped 連線一則都收不到(scoped 連線連任何 push 都沒有)。
 *   BR-6   非 host 連線送 `browser.commandResult`(即使 commandId 是真的)、host 送錯的/已結束的 commandId → 被忽略(`accepted:false`),
 *          等待中的指令不受影響,最後由真的 host 回的結果完成。
 *   BR-7   scoped token 呼叫 `browser.registerHost`/`browser.commandResult` → `gateway.scopedTokenForbidden`;一般連線呼叫
 *          `browser.*ForAgent` → `gateway.bridgeTokenRequired`;指令的 sessionId 只能是 token 綁定的那個(參數多塞 sessionId 無效)。
 *   BR-8   `browser_screenshot` 回 MCP image content(JPEG base64)加一段文字(url、標題、截圖尺寸、座標說明)。
 *   BR-9   host 回傳的結果被驗證:形狀不對 → `browser.invalidResult`;截圖超過 5 MB → `browser.resultTooLarge`;
 *          host 回報的已知錯誤碼原樣轉給 agent(`browser.staleRef`/`browser.staleScreenshot`…)、不認得的 → `browser.hostError`;
 *          超過 `maxChars` 的頁面文字由 core 截斷。
 *   BR-10  同一個 session 的指令依序(第一個還沒回,第二個不會送給 host);不同 session 互不阻塞。
 *   BR-11  真的 `@deskmony/client` 的 GatewayClient 當 host:收得到 `browser-command` push(不會因為不認得的 channel 出錯)並能回結果。
 *   BR-12  `features.agentBrowserTools: false`:bridge 沒有瀏覽器環境旗標、tools/list 只有五個 session 網路工具(與 in-process 一致),
 *          scoped token 呼叫 `browser.*ForAgent` 被拒;預設(true)時 effective config 為 true;`config.setFile` 接受這個欄位。
 *
 * 用法:node scripts/e2e-side-panel-browser.mjs
 * 前置需求:pnpm build 已跑過(dist 是最新的)。
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { requireFreshBuild } from "./lib/require-fresh-build.mjs";
import { e2eProvidersEnv, FAKE_ACP } from "./lib/e2e-providers.mjs";
import { REPORT_MCP_SERVERS_PREFIX } from "./fake-acp-agent.mjs";

requireFreshBuild();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const CORE_ENTRY = path.join(REPO_ROOT, "apps", "core", "dist", "index.js");
const BRIDGE_ENTRY = path.join(REPO_ROOT, "packages", "adapters", "dist", "mcp-bridge-server.js");
/** 避開其他 e2e 用過的 port(4870–4872 留給 review);兩個 core 依序使用,不同時存在。 */
const PORT = 4885;
const PORT_OFF = 4887;
const IS_WIN = process.platform === "win32";
/** 用環境變數縮短的逾時(core 預設是導覽 30 秒、其他 15 秒)。 */
const NAVIGATE_TIMEOUT_MS = 2500;
const COMMAND_TIMEOUT_MS = 1500;
/** 一張假的 JPEG(內容不重要,core 只看 base64 的大小;MCP image content 原樣帶過)。 */
const FAKE_JPEG_B64 =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/yQALCAABAAEBAREA/8wABgAQEAX/2gAIAQEAAD8A0s8g/9k=";

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
    if (IS_WIN) spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
    else proc.kill("SIGKILL");
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
    DESKMONY_BROWSER_NAVIGATE_TIMEOUT_MS: String(NAVIGATE_TIMEOUT_MS),
    DESKMONY_BROWSER_COMMAND_TIMEOUT_MS: String(COMMAND_TIMEOUT_MS),
    ...e2eProvidersEnv(),
  };
  const proc = spawn(process.execPath, [CORE_ENTRY], { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  const logs = [];
  proc.stdout.on("data", (chunk) => {
    logs.push(String(chunk));
    process.stdout.write(`[core:${port}] ${chunk}`);
  });
  proc.stderr.on("data", (chunk) => {
    logs.push(String(chunk));
    process.stderr.write(`[core:${port}:err] ${chunk}`);
  });
  proc.collectedLogs = () => logs.join("");
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

/** 一條 gateway 連線(一般連線、scoped 連線、假 host 都用它;記下所有收到的 push)。 */
class GatewayClient {
  constructor(url) {
    this.url = url;
    this.pendingRpc = new Map();
    this.events = [];
    this.pushCount = 0;
    this.pushChannels = [];
    this.waiters = [];
    this.closed = false;
    /** 假 host 用:收到 `browser-command` push 時呼叫(`(command) => void`)。 */
    this.onBrowserCommand = undefined;
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
    this.ws.addEventListener("close", () => {
      this.closed = true;
    });
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
          err.errorParams = msg.errorParams;
          pending.reject(err);
        }
      }
      return;
    }
    if (msg.kind === "event") {
      this.pushCount += 1;
      this.pushChannels.push(msg.channel);
      if (msg.channel === "session-event") {
        this.events.push(msg.payload);
        for (const w of [...this.waiters]) w(msg.payload);
      } else if (msg.channel === "browser-command") {
        this.onBrowserCommand?.(msg.payload);
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

  /** `rpc()` 的不丟例外版:`{ok:true,result}` 或 `{ok:false,code,message}`。 */
  async tryRpc(method, params, timeoutMs) {
    try {
      return { ok: true, result: await this.rpc(method, params, timeoutMs) };
    } catch (err) {
      return { ok: false, code: err.errorCode, message: String(err.message ?? err), params: err.errorParams };
    }
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

  /** 以人類身分送一則 prompt 並等這一輪 completed/error,回傳這一輪吐出的文字。 */
  async drivePrompt(sessionId, text, timeoutMs = 60_000) {
    const startIdx = this.events.length;
    await this.rpc("session.sendPrompt", { sessionId, prompt: { text } });
    let cursor = startIdx;
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("逾時等待 completed/error 事件");
      const ev = await this.waitForEvent((e) => e.sessionId === sessionId, remaining, cursor);
      cursor = this.events.indexOf(ev) + 1;
      if (ev.event.type === "completed" || ev.event.type === "error") {
        return this.events
          .slice(startIdx, cursor)
          .filter((e) => e.sessionId === sessionId && e.event.type === "message-delta")
          .map((e) => e.event.delta)
          .join("");
      }
    }
  }
}

/**
 * 假的 browser host:一條已註冊的 gateway 連線。對每個 `browser-command` 先記錄,再由 `handler(command)` 決定怎麼回:
 *   - 回傳 `{ result }` → `ok:true`;`{ error: {code, message} }` → `ok:false`;`"silent"` → 不回(等逾時/斷線/測試自己回)。
 * 預設 handler 對每個 op 回一個形狀正確的結果。
 */
class FakeHost {
  constructor(url) {
    this.conn = new GatewayClient(url);
    this.commands = [];
    this.handler = defaultHostHandler;
    this.conn.onBrowserCommand = (command) => {
      this.commands.push(command);
      void this._respond(command);
    };
  }

  async connectAndRegister() {
    await this.conn.connect();
    await this.conn.rpc("browser.registerHost", {});
    return this;
  }

  async _respond(command) {
    let outcome;
    try {
      outcome = await this.handler(command, this);
    } catch (err) {
      outcome = { error: { code: "browser.hostError", message: String(err) } };
    }
    if (outcome === "silent" || outcome === undefined) return;
    await this.reply(command.commandId, outcome);
  }

  /** 回報某個指令的結果;回傳 gateway 的 `{accepted}`。 */
  async reply(commandId, outcome) {
    const params = outcome.error ? { commandId, ok: false, error: outcome.error } : { commandId, ok: true, result: outcome.result };
    return await this.conn.tryRpc("browser.commandResult", params);
  }

  close() {
    this.conn.close();
  }

  /** 等到收到至少 `count` 個指令(含已經收到的)。 */
  async waitForCommands(count, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (this.commands.length < count && Date.now() < deadline) await sleep(25);
    return this.commands.length >= count;
  }
}

function defaultHostHandler(command) {
  const a = command.args;
  switch (command.op) {
    case "navigate":
      return { result: { url: a.url ?? `http://localhost/${a.action}`, title: `Fake page for ${a.url ?? a.action}`, loaded: true } };
    case "screenshot":
      return { result: { mimeType: "image/jpeg", data: FAKE_JPEG_B64, width: 800, height: 600, url: "http://localhost/shot", title: "Shot page" } };
    case "readPage":
      return a.mode === "interactive"
        ? {
            result: {
              mode: "interactive",
              url: "http://localhost/",
              title: "Fake",
              truncated: false,
              elements: [{ ref: "e1", role: "link", name: "Docs", href: "http://localhost/docs" }],
            },
          }
        : { result: { mode: "text", url: "http://localhost/", title: "Fake", text: "hello from the fake page", truncated: false } };
    case "click":
      return { result: { url: "http://localhost/after-click", title: "After click" } };
    default:
      return { result: {} };
  }
}

// ---- MCP bridge 子行程(真的 mcp-bridge-server + MCP client)-----------------------------------

async function openBridge(env) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [BRIDGE_ENTRY], env: { ...process.env, ...env } });
  const client = new Client({ name: "e2e-browser-bridge", version: "1.0.0" });
  await client.connect(transport);
  return {
    client,
    async listTools() {
      return (await client.listTools()).tools;
    },
    async call(name, args = {}) {
      const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 60_000 });
      return res;
    },
    async close() {
      await client.close().catch(() => undefined);
    },
  };
}

const textOf = (res) => res.content?.filter((c) => c.type === "text").map((c) => c.text).join("\n") ?? "";

// ---- session 與 scoped token -------------------------------------------------------------------

async function createSession(client, workspaceDir, title) {
  const { session } = await client.rpc("session.create", { providerId: FAKE_ACP, workingDir: workspaceDir, title });
  return session;
}

/** 取出某個 session 真實核發的 scoped bridge token 與 bridge 子行程的環境變數(同 e2e-session-network.mjs 的手法)。 */
async function bridgeEnvOf(client, sessionId) {
  const text = await client.drivePrompt(sessionId, REPORT_MCP_SERVERS_PREFIX, 30_000);
  const marker = "MCP_SERVERS:";
  const mcpServers = JSON.parse(text.slice(text.indexOf(marker) + marker.length));
  return Object.fromEntries((mcpServers[0].env ?? []).map((e) => [e.name, e.value]));
}

/** 用 scoped token 認證的一條連線(之後可直接呼叫 `browser.*ForAgent`)。 */
async function scopedConnection(env) {
  const conn = new GatewayClient(env.DESKMONY_MCP_BRIDGE_GATEWAY_URL);
  await conn.connect();
  await conn.rpc("auth", { token: env.DESKMONY_MCP_BRIDGE_TOKEN });
  return conn;
}

/** 在「這一刻」之後 `ms` 內,host 有沒有收到新指令(用來斷言「host 完全收不到」)。 */
async function hostGotNothingFor(host, ms, action) {
  const before = host.commands.length;
  const out = await action();
  await sleep(ms);
  return { gotNothing: host.commands.length === before, out };
}

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

const BROWSER_TOOLS = ["browser_click", "browser_navigate", "browser_press_key", "browser_read_page", "browser_screenshot", "browser_scroll", "browser_type"];
const NETWORK_TOOLS = ["create_session", "list_agents", "list_sessions", "read_session", "send_to_session"];

// ---- 主流程 -------------------------------------------------------------------------------

async function main() {
  if (!existsSync(CORE_ENTRY)) {
    console.error(`找不到 ${CORE_ENTRY},請先執行 pnpm build`);
    process.exit(1);
  }
  const startTime = Date.now();
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-br-data-"));
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-br-home-"));
  const wsA = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-br-wsA-"));
  const wsB = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-br-wsB-"));
  const offData = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-br-off-data-"));
  const offHome = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-br-off-home-"));
  const offWs = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-br-off-ws-"));
  const url = `ws://127.0.0.1:${PORT}`;

  let core;
  let coreOff;
  const conns = [];
  const bridges = [];
  const track = (c) => (conns.push(c), c);

  try {
    console.log(`[setup] dataDir=${dataDir}\n[setup] homeDir=${homeDir}`);
    core = startCore({ port: PORT, dataDir, homeDir, workspaceDir: wsA });
    await waitForPort(url, 30_000);

    const client = track(new GatewayClient(url));
    await client.connect();
    const SA = (await createSession(client, wsA, "br-A")).id;
    const SB = (await createSession(client, wsB, "br-B")).id;
    const envA = await bridgeEnvOf(client, SA);
    const envB = await bridgeEnvOf(client, SB);
    const scopedA = track(await scopedConnection(envA));
    const scopedB = track(await scopedConnection(envB));
    // 對照組:另一條一般連線(整個測試期間都連著,收 push)。
    const control = track(new GatewayClient(url));
    await control.connect();

    // 假 host 登記之前先確認:沒有 host → browser.noHost
    {
      const r = await scopedA.tryRpc("browser.screenshotForAgent", {});
      record(
        "BR-4a 沒有任何 host 時,agent 的瀏覽器工具回 browser.noHost(訊息教 agent 轉告使用者開桌面 app)",
        !r.ok && r.code === "browser.noHost" && /桌面 app/.test(r.message),
        JSON.stringify(r),
      );
    }

    let host = await new FakeHost(url).connectAndRegister();
    track(host.conn);

    // =====================================================================================
    // BR-1 + BR-8:真的 mcp-bridge 子行程 + MCP client(完整管線)
    // =====================================================================================
    try {
      const bridgeA = await openBridge(envA);
      bridges.push(bridgeA);
      const tools = (await bridgeA.listTools()).map((t) => t.name).sort();
      const target = "http://localhost:5555/a?x=1";
      const res = await bridgeA.call("browser_navigate", { url: target });
      const cmd = host.commands.at(-1);
      let parsed;
      try {
        parsed = JSON.parse(textOf(res));
      } catch {
        parsed = undefined;
      }
      record(
        "BR-1 bridge 掛了瀏覽器七個工具(加上 session 網路五個);browser_navigate 到 localhost → host 收到 {op:navigate, sessionId=呼叫者, args.url=網址},工具回傳 host 的結果",
        JSON.stringify(tools) === JSON.stringify([...NETWORK_TOOLS, ...BROWSER_TOOLS].sort()) &&
          envA.DESKMONY_MCP_BRIDGE_BROWSER_ENABLED === "1" &&
          cmd?.op === "navigate" &&
          cmd.sessionId === SA &&
          cmd.args.url === target &&
          res.isError !== true &&
          parsed?.url === target &&
          parsed.loaded === true &&
          parsed.title === `Fake page for ${target}`,
        `tools=${tools.join(",")}, cmd=${JSON.stringify(cmd)}, result=${textOf(res)}`,
      );

      const shot = await bridgeA.call("browser_screenshot", {});
      const image = shot.content?.find((c) => c.type === "image");
      const caption = shot.content?.find((c) => c.type === "text")?.text ?? "";
      record(
        "BR-8 browser_screenshot 回 MCP image content(JPEG base64 原樣)加一段文字:url、標題、截圖像素尺寸、「browser_click 的 x/y 是這張截圖的像素座標」",
        shot.isError !== true &&
          image?.mimeType === "image/jpeg" &&
          image.data === FAKE_JPEG_B64 &&
          caption.includes("http://localhost/shot") &&
          caption.includes("Shot page") &&
          caption.includes("800×600") &&
          caption.includes("browser_click 的 x/y") &&
          caption.includes("像素座標"),
        `content types=${shot.content?.map((c) => c.type).join(",")}, caption=${caption}`,
      );

      // 其他工具的輸出格式與參數轉送
      const read = await bridgeA.call("browser_read_page", {});
      const inter = await bridgeA.call("browser_read_page", { mode: "interactive" });
      const click = await bridgeA.call("browser_click", { ref: "e1" });
      const type = await bridgeA.call("browser_type", { text: "hello", submit: true });
      const key = await bridgeA.call("browser_press_key", { key: "Enter" });
      const scroll = await bridgeA.call("browser_scroll", { direction: "down", amount: 2 });
      const last = (n) => host.commands.slice(-n);
      const [cRead, cInter, cClick, cType, cKey, cScroll] = last(6);
      record(
        "BR-1c 其餘工具:read_page(text 帶「不可信資料」標示、interactive 列出元素)、click、type、press_key、scroll 的參數原樣送給 host、結果有格式化",
        textOf(read).includes("不可信") &&
          textOf(read).includes("hello from the fake page") &&
          textOf(inter).includes('"ref": "e1"') &&
          textOf(inter).includes("不可信") &&
          JSON.parse(textOf(click)).url === "http://localhost/after-click" &&
          textOf(type).includes("5 個字元") &&
          textOf(key).includes("Enter") &&
          textOf(scroll).includes("下") &&
          cRead.op === "readPage" &&
          cInter.args.mode === "interactive" &&
          cClick.op === "click" &&
          cClick.args.ref === "e1" &&
          cType.op === "type" &&
          cType.args.text === "hello" &&
          cType.args.submit === true &&
          cKey.op === "pressKey" &&
          cKey.args.key === "Enter" &&
          cScroll.op === "scroll" &&
          cScroll.args.direction === "down" &&
          cScroll.args.amount === 2 &&
          [read, inter, click, type, key, scroll].every((r) => r.isError !== true),
        undefined,
      );
    } catch (err) {
      record("BR-1/BR-8 bridge 完整管線", false, String(err?.stack ?? err));
    }

    // =====================================================================================
    // BR-1b loopback 的各種寫法放行(送出正規化 href)、長得像 loopback 的外部網站一律被擋
    // =====================================================================================
    try {
      const allowedUrls = [
        "http://localhost/",
        "http://LOCALHOST:3000/Path?q=1#frag",
        "http://127.0.0.1:8080/",
        "http://127.9.9.9/",
        "http://127.1/",
        "http://0x7f.0.0.1/",
        "http://2130706433/",
        "http://[::1]:5173/",
        "http://[0:0:0:0:0:0:0:1]/",
        "http://app.localhost/",
        "https://sub.dev.localhost:8443/x",
      ];
      const forwarded = [];
      for (const u of allowedUrls) {
        const before = host.commands.length;
        const r = await scopedA.tryRpc("browser.navigateForAgent", { url: u });
        const cmd = host.commands[before];
        forwarded.push({ u, ok: r.ok, sent: cmd?.args?.url, expected: new URL(u).href });
      }
      record(
        "BR-1b loopback 的各種寫法(localhost/大小寫、127.0.0.0/8、127.1、0x7f.0.0.1、2130706433、[::1]、*.localhost)都放行,送給 host 的是正規化後的 href(檢查與送出是同一個字串)",
        forwarded.every((f) => f.ok && f.sent === f.expected),
        JSON.stringify(forwarded.filter((f) => !f.ok || f.sent !== f.expected)),
      );

      const deniedUrls = [
        "http://localhost.evil.test/",
        "http://127.0.0.1.evil.test/",
        "http://evil.test/",
        "http://localhost@evil.test/",
        "http://evil.test\\@localhost/",
        "http://evil.test#@localhost/",
        "http://[::ffff:7f00:1]/",
        "http://0.0.0.0/",
        "http://10.0.0.5/",
        "http://192.168.1.1/",
        "http://localhost./",
        "https://notlocalhost/",
        "http://localhost.localdomain/",
      ];
      const denied = [];
      for (const u of deniedUrls) {
        const { gotNothing, out } = await hostGotNothingFor(host, 60, () => scopedA.tryRpc("browser.navigateForAgent", { url: u }));
        denied.push({ u, code: out.code, gotNothing });
      }
      record(
        "BR-1b 長得像 loopback 的外部網站(localhost.evil.test、127.0.0.1.evil.test、userinfo 把戲、反斜線、[::ffff:7f00:1]、0.0.0.0、內網 IP、結尾點、無點主機名)一律 browser.hostNotAllowed,host 一個指令都收不到",
        denied.every((d) => d.code === "browser.hostNotAllowed" && d.gotNothing),
        JSON.stringify(denied.filter((d) => d.code !== "browser.hostNotAllowed" || !d.gotNothing)),
      );
    } catch (err) {
      record("BR-1b loopback 判斷", false, String(err?.stack ?? err));
    }

    // =====================================================================================
    // BR-2 外部網站不在 allowedHosts(此時 allowedHosts 為空)
    // =====================================================================================
    try {
      const { gotNothing, out: r } = await hostGotNothingFor(host, 100, () =>
        scopedA.tryRpc("browser.navigateForAgent", { url: "https://Example.COM/page" }),
      );
      record(
        "BR-2a 外部網站不在 allowedHosts → browser.hostNotAllowed(params.host 是小寫主機名),訊息教 agent 轉告使用者:把主機加進 ~/.deskmony/config.json 的 policy.allowedHosts;host 沒收到指令;core log 留下拒絕紀錄(含 session、原因)",
        !r.ok &&
          r.code === "browser.hostNotAllowed" &&
          r.params?.host === "example.com" &&
          r.message.includes("policy.allowedHosts") &&
          r.message.includes("~/.deskmony/config.json") &&
          r.message.includes("example.com") &&
          gotNothing &&
          core.collectedLogs().includes(`拒絕導覽(session=${SA})`) &&
          core.collectedLogs().includes("example.com"),
        JSON.stringify(r),
      );

      // 真.無限制:YOLO 之上疊加後放行,關掉又被擋
      await client.rpc("session.setPermissionMode", { sessionId: SA, mode: "auto-accept-all" });
      const yoloOnly = await scopedA.tryRpc("browser.navigateForAgent", { url: "https://example.com/yolo" });
      await client.rpc("session.setTrueUnrestricted", { sessionId: SA, enabled: true });
      const before = host.commands.length;
      const unrestricted = await scopedA.tryRpc("browser.navigateForAgent", { url: "https://example.com/unrestricted" });
      const sentUrl = host.commands[before]?.args?.url;
      const otherSession = await scopedB.tryRpc("browser.navigateForAgent", { url: "https://example.com/other-session" });
      await client.rpc("session.setTrueUnrestricted", { sessionId: SA, enabled: false });
      const afterOff = await scopedA.tryRpc("browser.navigateForAgent", { url: "https://example.com/off" });
      await client.rpc("session.setPermissionMode", { sessionId: SA, mode: "always-ask" });
      record(
        "BR-2c session 開著「真.無限制」時外部網站放行(只有 YOLO 不夠、也不影響別的 session),關掉之後又被擋",
        !yoloOnly.ok &&
          yoloOnly.code === "browser.hostNotAllowed" &&
          unrestricted.ok &&
          sentUrl === "https://example.com/unrestricted" &&
          !otherSession.ok &&
          otherSession.code === "browser.hostNotAllowed" &&
          !afterOff.ok &&
          afterOff.code === "browser.hostNotAllowed",
        JSON.stringify({ yoloOnly, unrestricted, otherSession, afterOff }),
      );
    } catch (err) {
      record("BR-2 外部網站規則", false, String(err?.stack ?? err));
    }

    // =====================================================================================
    // BR-3 不是 http(s)、不是完整網址、參數不合法 → host 沒收到
    // =====================================================================================
    try {
      const badSchemes = [
        "file:///C:/Windows/win.ini",
        "file:///etc/passwd",
        "javascript:alert(1)",
        "JAVASCRIPT:alert(1)",
        "java\nscript:alert(1)",
        "data:text/html,<p>x</p>",
        "ftp://example.com/x",
        "chrome://gpu",
        "view-source:http://localhost/",
        "blob:http://localhost/abc",
        "about:blank",
      ];
      const schemeResults = [];
      for (const u of badSchemes) {
        const { gotNothing, out } = await hostGotNothingFor(host, 40, () => scopedA.tryRpc("browser.navigateForAgent", { url: u }));
        schemeResults.push({ u, code: out.code, gotNothing });
      }
      const invalid = [];
      for (const [label, params] of [
        ["不是完整網址", { url: "example.com" }],
        ["url 與 action 同時給", { url: "http://localhost/", action: "reload" }],
        ["都沒給", {}],
      ]) {
        const { gotNothing, out } = await hostGotNothingFor(host, 40, () => scopedA.tryRpc("browser.navigateForAgent", params));
        invalid.push({ label, code: out.code, gotNothing });
      }
      const clickInvalid = [];
      for (const [label, params] of [
        ["ref 與座標同時給", { ref: "e1", x: 1, y: 2 }],
        ["只給 x", { x: 5 }],
        ["都沒給", {}],
      ]) {
        const { gotNothing, out } = await hostGotNothingFor(host, 40, () => scopedA.tryRpc("browser.clickForAgent", params));
        clickInvalid.push({ label, code: out.code, gotNothing });
      }
      record(
        "BR-3 file:/javascript:/data:/ftp:/chrome:/view-source:/blob:/about:blank(含大小寫、換行穿插)→ browser.unsupportedScheme;不是完整網址、url+action 同時給/都沒給、click 的 ref 與座標不二擇一 → browser.invalidArgs;以上 host 都沒收到",
        schemeResults.every((s) => s.code === "browser.unsupportedScheme" && s.gotNothing) &&
          invalid.every((s) => s.code === "browser.invalidArgs" && s.gotNothing) &&
          clickInvalid.every((s) => s.code === "browser.invalidArgs" && s.gotNothing),
        JSON.stringify({ schemeResults: schemeResults.filter((s) => s.code !== "browser.unsupportedScheme" || !s.gotNothing), invalid, clickInvalid }),
      );
      // back/forward/reload 不帶網址、不受主機規則影響
      const nav = await scopedA.tryRpc("browser.navigateForAgent", { action: "back" });
      const cmd = host.commands.at(-1);
      record(
        "BR-3b navigate 的 action(back/forward/reload)直接送給 host(不帶 url、不受主機規則影響)",
        nav.ok && cmd.op === "navigate" && cmd.args.action === "back" && cmd.args.url === undefined,
        JSON.stringify({ nav, cmd }),
      );
    } catch (err) {
      record("BR-3 scheme/參數檢查", false, String(err?.stack ?? err));
    }

    // =====================================================================================
    // BR-5 browser-command 只送到 host 連線;scoped 連線連任何 push 都沒有
    // =====================================================================================
    try {
      await scopedA.rpc("browser.scrollForAgent", { direction: "down" });
      await scopedB.rpc("browser.scrollForAgent", { direction: "up", amount: 3 });
      await sleep(400);
      record(
        "BR-5 browser-command 只送到 host 連線:另一條一般連線一則 browser-command 都沒收到(但收得到別的 push,證明它有在收)、兩條 scoped 連線連任何 push 都是 0",
        host.conn.pushChannels.filter((c) => c === "browser-command").length === host.commands.length &&
          host.commands.length > 10 &&
          !control.pushChannels.includes("browser-command") &&
          control.pushCount > 0 &&
          scopedA.pushCount === 0 &&
          scopedB.pushCount === 0,
        `host browser-command=${host.commands.length}, control push=${control.pushCount}(${[...new Set(control.pushChannels)].join(",")}), scopedA=${scopedA.pushCount}, scopedB=${scopedB.pushCount}`,
      );
    } catch (err) {
      record("BR-5 targeted push", false, String(err?.stack ?? err));
    }

    // =====================================================================================
    // BR-6 非 host 連線 / 錯的 commandId 的 browser.commandResult 被忽略
    // =====================================================================================
    try {
      host.handler = (command) => (command.args.mode === "text" && command.args.maxChars === 77 ? "silent" : defaultHostHandler(command));
      const base6 = host.commands.length;
      const pendingCall = scopedA.tryRpc("browser.readPageForAgent", { mode: "text", maxChars: 77 }, 20_000);
      await host.waitForCommands(base6 + 1);
      const held = host.commands[base6];
      const forged = { mode: "text", url: "http://evil/", title: "FORGED", text: "forged-by-impostor", truncated: false };
      const impostor = await control.tryRpc("browser.commandResult", { commandId: held.commandId, ok: true, result: forged });
      const wrongId = await host.reply("00000000-0000-4000-8000-000000000000", { result: forged });
      const settledEarly = await Promise.race([pendingCall.then(() => true), sleep(400).then(() => false)]);
      const real = await host.reply(held.commandId, {
        result: { mode: "text", url: "http://localhost/", title: "REAL", text: "real-from-host", truncated: false },
      });
      const final = await pendingCall;
      const replay = await host.reply(held.commandId, { result: forged });
      host.handler = defaultHostHandler;
      record(
        "BR-6 非 host 連線送 browser.commandResult(commandId 是真的)→ accepted:false、host 送不存在的 commandId → accepted:false、等待中的指令沒被它們完成;之後真的 host 回的結果才完成它;已結束的 commandId 重送也被忽略;core log 有 warning",
        impostor.ok &&
          impostor.result.accepted === false &&
          wrongId.ok &&
          wrongId.result.accepted === false &&
          settledEarly === false &&
          real.ok &&
          real.result.accepted === true &&
          final.ok &&
          final.result.title === "REAL" &&
          final.result.text === "real-from-host" &&
          replay.ok &&
          replay.result.accepted === false &&
          core.collectedLogs().includes("忽略來自非 host 連線的 browser.commandResult") &&
          core.collectedLogs().includes("忽略未知或已結束的 commandId"),
        JSON.stringify({ impostor, wrongId, settledEarly, real, final, replay }),
      );
    } catch (err) {
      record("BR-6 commandResult 驗證", false, String(err?.stack ?? err));
    }

    // =====================================================================================
    // BR-7 scoped token 不能註冊 host / 回結果;一般連線不能呼叫 ForAgent;sessionId 只由 token 決定
    // =====================================================================================
    try {
      const reg = await scopedA.tryRpc("browser.registerHost", {});
      const res = await scopedA.tryRpc("browser.commandResult", { commandId: randomUUID(), ok: true, result: {} });
      const normalCall = await control.tryRpc("browser.screenshotForAgent", {});
      const normalNavigate = await control.tryRpc("browser.navigateForAgent", { url: "http://localhost/" });
      // 多塞 sessionId 無效:指令的 sessionId 永遠是 token 綁定的 SB
      const before = host.commands.length;
      const forgedParams = await scopedB.tryRpc("browser.clickForAgent", { x: 3, y: 4, sessionId: SA });
      const cmd = host.commands[before];
      // host 仍然是原本那個(scoped 的註冊嘗試沒有取代它)
      const stillWorks = await scopedA.tryRpc("browser.scrollForAgent", { direction: "up" });
      record(
        "BR-7 scoped token 呼叫 browser.registerHost/browser.commandResult 被拒(gateway.scopedTokenForbidden)、host 沒被取代;一般連線呼叫 browser.*ForAgent 被拒(gateway.bridgeTokenRequired);指令的 sessionId 只能是 token 綁定的那個(參數多塞 sessionId 無效)",
        !reg.ok &&
          reg.code === "gateway.scopedTokenForbidden" &&
          !res.ok &&
          res.code === "gateway.scopedTokenForbidden" &&
          !normalCall.ok &&
          normalCall.code === "gateway.bridgeTokenRequired" &&
          !normalNavigate.ok &&
          normalNavigate.code === "gateway.bridgeTokenRequired" &&
          forgedParams.ok &&
          cmd?.sessionId === SB &&
          cmd.args.sessionId === undefined &&
          stillWorks.ok,
        JSON.stringify({ reg, res, normalCall, normalNavigate, cmdSession: cmd?.sessionId, expected: SB, stillWorks }),
      );
    } catch (err) {
      record("BR-7 權限", false, String(err?.stack ?? err));
    }

    // =====================================================================================
    // BR-9 host 回傳結果的驗證
    // =====================================================================================
    try {
      const run = async (handler, call) => {
        host.handler = handler;
        try {
          return await call();
        } finally {
          host.handler = defaultHostHandler;
        }
      };
      const badShape = await run(() => ({ result: { url: 123 } }), () => scopedA.tryRpc("browser.navigateForAgent", { url: "http://localhost/" }));
      const hugeData = "A".repeat(Math.ceil(((5 * 1024 * 1024 + 4096) * 4) / 3));
      const hugeShot = await run(
        () => ({ result: { mimeType: "image/jpeg", data: hugeData, width: 10, height: 10, url: "http://localhost/", title: "t" } }),
        () => scopedA.tryRpc("browser.screenshotForAgent", {}, 60_000),
      );
      const staleRef = await run(
        () => ({ error: { code: "browser.staleRef", message: "ref e1 已過期" } }),
        () => scopedA.tryRpc("browser.clickForAgent", { ref: "e1" }),
      );
      const stale = await run(
        () => ({ error: { code: "browser.staleScreenshot", message: "viewport 已變" } }),
        () => scopedA.tryRpc("browser.clickForAgent", { x: 1, y: 1 }),
      );
      const unknownCode = await run(
        () => ({ error: { code: "browser.somethingNew", message: "奇怪的失敗" } }),
        () => scopedA.tryRpc("browser.typeForAgent", { text: "x" }),
      );
      const hostile = await run(
        () => ({ error: { code: "gateway.scopedTokenForbidden", message: "冒充別的錯誤碼" } }),
        () => scopedA.tryRpc("browser.pressKeyForAgent", { key: "Tab" }),
      );
      const longText = await run(
        () => ({ result: { mode: "text", url: "http://localhost/", title: "long", text: "x".repeat(5000), truncated: false } }),
        () => scopedA.tryRpc("browser.readPageForAgent", { mode: "text", maxChars: 100 }),
      );
      const manyElements = await run(
        () => ({
          result: {
            mode: "interactive",
            url: "http://localhost/",
            title: "many",
            truncated: false,
            elements: Array.from({ length: 800 }, (_, i) => ({ ref: `e${i}`, role: "link", name: `n${i}` })),
          },
        }),
        () => scopedA.tryRpc("browser.readPageForAgent", { mode: "interactive" }),
      );
      record(
        "BR-9 host 結果被驗證:形狀不對 → browser.invalidResult;截圖超過 5 MB → browser.resultTooLarge;host 的已知錯誤碼(staleRef/staleScreenshot)原樣轉給 agent、不認得的(含冒充 gateway 的錯誤碼)→ browser.hostError;超過 maxChars 的文字與超過 500 個的互動元素由 core 截斷並標 truncated",
        !badShape.ok &&
          badShape.code === "browser.invalidResult" &&
          !hugeShot.ok &&
          hugeShot.code === "browser.resultTooLarge" &&
          !staleRef.ok &&
          staleRef.code === "browser.staleRef" &&
          staleRef.message.includes("ref e1 已過期") &&
          !stale.ok &&
          stale.code === "browser.staleScreenshot" &&
          !unknownCode.ok &&
          unknownCode.code === "browser.hostError" &&
          unknownCode.message.includes("奇怪的失敗") &&
          !hostile.ok &&
          hostile.code === "browser.hostError" &&
          longText.ok &&
          longText.result.text.length === 100 &&
          longText.result.truncated === true &&
          manyElements.ok &&
          manyElements.result.elements.length === 500 &&
          manyElements.result.truncated === true,
        JSON.stringify({
          badShape: badShape.code,
          hugeShot: hugeShot.code,
          staleRef: staleRef.code,
          stale: stale.code,
          unknownCode: unknownCode.code,
          hostile: hostile.code,
          longText: longText.ok && [longText.result.text.length, longText.result.truncated],
          manyElements: manyElements.ok && [manyElements.result.elements.length, manyElements.result.truncated],
        }),
      );
    } catch (err) {
      record("BR-9 結果驗證", false, String(err?.stack ?? err));
    }

    // =====================================================================================
    // BR-10 同一個 session 依序、不同 session 互不阻塞
    // =====================================================================================
    try {
      const releases = new Map();
      host.handler = (command) => {
        if (command.args.mode === "text" && String(command.args.maxChars).startsWith("9")) {
          // maxChars=9001/9002/9003 的指令由測試手動放行
          return new Promise((resolve) => releases.set(command.args.maxChars, () => resolve(defaultHostHandler(command))));
        }
        return defaultHostHandler(command);
      };
      const base = host.commands.length;
      const p1 = scopedA.tryRpc("browser.readPageForAgent", { mode: "text", maxChars: 9001 }, 20_000);
      await host.waitForCommands(base + 1);
      const p2 = scopedA.tryRpc("browser.readPageForAgent", { mode: "text", maxChars: 9002 }, 20_000);
      await sleep(300);
      const secondSentEarly = host.commands.length > base + 1;
      // 不同 session(B)在 A 還卡著時照常完成
      const otherDone = await scopedB.tryRpc("browser.scrollForAgent", { direction: "down" }, 5000);
      releases.get(9001)();
      const r1 = await p1;
      await host.waitForCommands(base + 3);
      const orderOk = host.commands[base].args.maxChars === 9001 && host.commands[base + 2].args.maxChars === 9002;
      releases.get(9002)();
      const r2 = await p2;
      host.handler = defaultHostHandler;
      record(
        "BR-10 同一個 session 的指令依序執行(第一個還沒回,第二個不會送給 host;回了才送);另一個 session 的指令在這期間不被阻塞",
        secondSentEarly === false && otherDone.ok && r1.ok && r2.ok && orderOk,
        `secondSentEarly=${secondSentEarly}, otherDone=${otherDone.ok}, order=${host.commands.slice(base).map((c) => `${c.sessionId === SA ? "A" : "B"}:${c.op}:${c.args.maxChars ?? ""}`).join(" ")}`,
      );
    } catch (err) {
      record("BR-10 排隊", false, String(err?.stack ?? err));
    }

    // =====================================================================================
    // BR-4 逾時 / 斷線 / 重新註冊 / 取代
    // =====================================================================================
    try {
      // 逾時:其他指令 1.5 秒、導覽 2.5 秒
      host.handler = () => "silent";
      const t0 = Date.now();
      const shotTimeout = await scopedA.tryRpc("browser.screenshotForAgent", {});
      const shotMs = Date.now() - t0;
      const t1 = Date.now();
      const navTimeout = await scopedA.tryRpc("browser.navigateForAgent", { url: "http://localhost:1/slow" });
      const navMs = Date.now() - t1;
      const lateCommand = host.commands.at(-1);
      const late = await host.reply(lateCommand.commandId, { result: { url: "http://localhost:1/slow", title: "late", loaded: true } });
      record(
        "BR-4b host 不回 → browser.timeout(其他指令 ~1.5 秒、導覽 ~2.5 秒,用 DESKMONY_BROWSER_*_TIMEOUT_MS 縮短);逾時之後才到的結果被忽略(accepted:false)",
        !shotTimeout.ok &&
          shotTimeout.code === "browser.timeout" &&
          shotMs >= COMMAND_TIMEOUT_MS - 200 &&
          shotMs < COMMAND_TIMEOUT_MS + 2500 &&
          !navTimeout.ok &&
          navTimeout.code === "browser.timeout" &&
          navMs >= NAVIGATE_TIMEOUT_MS - 200 &&
          navMs < NAVIGATE_TIMEOUT_MS + 2500 &&
          late.ok &&
          late.result.accepted === false,
        JSON.stringify({ shotTimeout: shotTimeout.code, shotMs, navTimeout: navTimeout.code, navMs, late }),
      );

      // 逾時之後同一個 session 的下一個指令可以照常執行(佇列沒有被卡住)
      host.handler = defaultHostHandler;
      const afterTimeout = await scopedA.tryRpc("browser.scrollForAgent", { direction: "down" });

      // 指令送出後 host 斷線 → 未完成的全部 hostDisconnected(含還在排隊的),之後沒有 host → noHost
      host.handler = (command) => (command.op === "screenshot" || command.op === "scroll" ? "silent" : defaultHostHandler(command));
      const base = host.commands.length;
      const inFlight = scopedA.tryRpc("browser.screenshotForAgent", {}, 20_000);
      await host.waitForCommands(base + 1);
      const queued = scopedA.tryRpc("browser.scrollForAgent", { direction: "up" }, 20_000); // 同 session,排在後面
      const otherSessionInFlight = scopedB.tryRpc("browser.scrollForAgent", { direction: "down" }, 20_000);
      await sleep(200);
      host.close();
      const [r1, r2, r3] = await Promise.all([inFlight, queued, otherSessionInFlight]);
      await sleep(300);
      const noHost = await scopedA.tryRpc("browser.screenshotForAgent", {});
      record(
        "BR-4c 指令送出後 host 斷線 → 未完成的全部(送出的、排隊的、別的 session 的)以 browser.hostDisconnected 收場;之後再呼叫 → browser.noHost",
        afterTimeout.ok &&
          [r1, r2, r3].every((r) => !r.ok && r.code === "browser.hostDisconnected") &&
          !noHost.ok &&
          noHost.code === "browser.noHost",
        JSON.stringify({ afterTimeout: afterTimeout.ok, r1: r1.code, r2: r2.code, r3: r3.code, noHost: noHost.code }),
      );

      // 斷線後重新註冊(新的連線)可以繼續用
      const host2 = track(await new FakeHost(url).connectAndRegister());
      const again = await scopedA.tryRpc("browser.navigateForAgent", { url: "http://localhost:2/again" });
      // 新 host 取代舊 host:舊 host(仍連著)還沒回的指令 → hostDisconnected;舊 host 的結果被忽略
      host2.handler = () => "silent";
      const pendingOnHost2 = scopedA.tryRpc("browser.screenshotForAgent", {}, 20_000);
      await host2.waitForCommands(host2.commands.length + 1);
      const held2 = host2.commands.at(-1);
      const host3 = track(await new FakeHost(url).connectAndRegister());
      const replaced = await pendingOnHost2;
      const staleReply = await host2.reply(held2.commandId, { result: {} });
      const onHost3 = await scopedA.tryRpc("browser.navigateForAgent", { url: "http://localhost:3/on-host3" });
      record(
        "BR-4d 斷線後重新註冊可以繼續用;再有一個 host 註冊時以最後一個為準——被取代的 host 還沒回的指令 → browser.hostDisconnected、它之後送的結果被忽略、新指令只送給新 host",
        again.ok &&
          again.result.url === "http://localhost:2/again" &&
          !replaced.ok &&
          replaced.code === "browser.hostDisconnected" &&
          staleReply.ok &&
          staleReply.result.accepted === false &&
          onHost3.ok &&
          host3.commands.at(-1)?.args?.url === "http://localhost:3/on-host3" &&
          !host2.commands.some((c) => c.args?.url === "http://localhost:3/on-host3"),
        JSON.stringify({ again: again.ok, replaced: replaced.code, staleReply, onHost3: onHost3.ok }),
      );
      host2.close();
      host = host3;
    } catch (err) {
      record("BR-4 逾時/斷線/重新註冊", false, String(err?.stack ?? err));
    }

    // =====================================================================================
    // BR-11 真的 @deskmony/client 的 GatewayClient 當 host
    // =====================================================================================
    try {
      host.close();
      await sleep(300);
      const { GatewayClient: RealGatewayClient } = await import(
        pathToFileURL(path.join(REPO_ROOT, "packages", "client", "dist", "index.js")).href
      );
      const real = new RealGatewayClient(url);
      const pushes = [];
      real.onPush((push) => pushes.push(push));
      real.connect();
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("真 client 連線逾時")), 10_000);
        real.onStatus((status) => {
          if (status === "open") {
            clearTimeout(t);
            resolve();
          }
        });
      });
      await real.call("browser.registerHost", {});
      const pending = scopedA.tryRpc("browser.navigateForAgent", { url: "http://localhost:4/real-client" }, 20_000);
      const deadline = Date.now() + 5000;
      while (!pushes.some((p) => p.channel === "browser-command") && Date.now() < deadline) await sleep(25);
      const push = pushes.find((p) => p.channel === "browser-command");
      const answered = await real.call("browser.commandResult", {
        commandId: push.payload.commandId,
        ok: true,
        result: { url: push.payload.args.url, title: "from real client", loaded: true },
      });
      const out = await pending;
      real.disconnect();
      record(
        "BR-11 真的 @deskmony/client GatewayClient 當 host:收得到 browser-command push(channel 與 payload 完整、client 沒有因為這個新 channel 出錯)、能用 browser.commandResult 回結果,agent 端拿到它的結果",
        push?.payload?.op === "navigate" &&
          push.payload.sessionId === SA &&
          push.payload.args.url === "http://localhost:4/real-client" &&
          answered?.accepted === true &&
          out.ok &&
          out.result.title === "from real client",
        JSON.stringify({ push: push?.payload, answered, out }),
      );
    } catch (err) {
      record("BR-11 真 client 當 host", false, String(err?.stack ?? err));
    }

    // =====================================================================================
    // BR-12(預設為 true 的部分)effective config、config.setFile
    // =====================================================================================
    try {
      const { effective } = await client.rpc("config.getEffective", {});
      const patched = await client.rpc("config.setFile", { features: { agentBrowserTools: false } });
      const fileConfig = JSON.parse(readFileSync(path.join(homeDir, "config.json"), "utf8"));
      record(
        "BR-12a 預設 features.agentBrowserTools = true(source=default);config.setFile 接受這個欄位(changedFields 含它、寫進 config.json、requiresRestart)",
        effective.features.agentBrowserTools.value === true &&
          effective.features.agentBrowserTools.source === "default" &&
          patched.ok === true &&
          patched.changedFields.includes("features.agentBrowserTools") &&
          patched.requiresRestart === true &&
          fileConfig.features?.agentBrowserTools === false,
        JSON.stringify({ effective: effective.features.agentBrowserTools, patched, fileConfig }),
      );
    } catch (err) {
      record("BR-12a effective config", false, String(err?.stack ?? err));
    }

    // =====================================================================================
    // BR-2b 重啟 core(policy.allowedHosts 只吃啟動時的設定):加進 allowedHosts 後放行、其他主機仍被擋
    // =====================================================================================
    conns.splice(0).forEach((c) => c.close());
    for (const b of bridges.splice(0)) await b.close();
    await killProcessTree(core, "core");
    writeFileSync(
      path.join(homeDir, "config.json"),
      JSON.stringify({ version: 1, policy: { allowedHosts: ["Allowed.Example.TEST", "[::1]"] } }, null, 2),
      "utf8",
    );
    core = startCore({ port: PORT, dataDir, homeDir, workspaceDir: wsA });
    await waitForPort(url, 30_000);
    try {
      const client2 = track(new GatewayClient(url));
      await client2.connect();
      const S2 = (await createSession(client2, wsA, "br-allowed")).id;
      const env2 = await bridgeEnvOf(client2, S2);
      const scoped2 = track(await scopedConnection(env2));
      const host2 = track(await new FakeHost(url).connectAndRegister());
      const okAllowed = await scoped2.tryRpc("browser.navigateForAgent", { url: "https://allowed.example.test/path" });
      const okUpper = await scoped2.tryRpc("browser.navigateForAgent", { url: "http://ALLOWED.EXAMPLE.TEST:8080/" });
      const { gotNothing, out: stillDenied } = await hostGotNothingFor(host2, 100, () =>
        scoped2.tryRpc("browser.navigateForAgent", { url: "https://other.example.test/" }),
      );
      const { gotNothing: noSubdomain, out: subdomain } = await hostGotNothingFor(host2, 100, () =>
        scoped2.tryRpc("browser.navigateForAgent", { url: "https://evil.allowed.example.test/" }),
      );
      const { effective } = await client2.rpc("config.getEffective", {});
      record(
        "BR-2b 把主機加進 policy.allowedHosts(不分大小寫)並重啟 core 後放行,送給 host 的是正規化後的網址;其他主機與它的子網域仍被擋(完全比對 hostname)、host 沒收到;effective config 的 allowedHosts 來源是 file",
        okAllowed.ok &&
          okAllowed.result.url === "https://allowed.example.test/path" &&
          okUpper.ok &&
          host2.commands.some((c) => c.args.url === "http://allowed.example.test:8080/") &&
          !stillDenied.ok &&
          stillDenied.code === "browser.hostNotAllowed" &&
          gotNothing &&
          !subdomain.ok &&
          subdomain.code === "browser.hostNotAllowed" &&
          noSubdomain &&
          effective.policy.allowedHosts.source === "file",
        JSON.stringify({ okAllowed, okUpper: okUpper.ok, stillDenied: stillDenied.code, subdomain: subdomain.code }),
      );
    } catch (err) {
      record("BR-2b allowedHosts 放行", false, String(err?.stack ?? err));
    }

    // =====================================================================================
    // BR-12 features.agentBrowserTools: false(另一個 core)
    // =====================================================================================
    try {
      writeFileSync(path.join(offHome, "config.json"), JSON.stringify({ version: 1, features: { agentBrowserTools: false } }, null, 2), "utf8");
      coreOff = startCore({ port: PORT_OFF, dataDir: offData, homeDir: offHome, workspaceDir: offWs });
      const urlOff = `ws://127.0.0.1:${PORT_OFF}`;
      await waitForPort(urlOff, 30_000);
      const clientOff = track(new GatewayClient(urlOff));
      await clientOff.connect();
      const SO = (await createSession(clientOff, offWs, "br-off")).id;
      const envOff = await bridgeEnvOf(clientOff, SO);
      const scopedOff = track(await scopedConnection(envOff));
      const hostOff = track(await new FakeHost(urlOff).connectAndRegister());
      const bridgeOff = await openBridge(envOff);
      bridges.push(bridgeOff);
      const offTools = await bridgeOff.listTools();
      const offInstructions = bridgeOff.client.getInstructions();
      const navigate = await scopedOff.tryRpc("browser.navigateForAgent", { url: "http://localhost/" });
      const shot = await scopedOff.tryRpc("browser.screenshotForAgent", {});
      const { effective } = await clientOff.rpc("config.getEffective", {});

      // in-process 版(沒有注入 BrowserPort)與 bridge(沒有瀏覽器旗標)的 tools/list、instructions 逐字一致
      const { createSessionNetworkMcpServer } = await import(
        pathToFileURL(path.join(REPO_ROOT, "packages", "adapters", "dist", "session-network-mcp.js")).href
      );
      const stubPort = {
        listAgents: async () => [],
        listSessions: async () => [],
        readSession: async () => ({ sessionId: "x", title: "t", messages: [] }),
        createSession: async () => ({ sessionId: "x" }),
        sendToSession: async () => undefined,
      };
      const sdkServer = createSessionNetworkMcpServer(stubPort, "caller");
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await sdkServer.instance.connect(st);
      const inproc = new Client({ name: "e2e-off-inproc", version: "1.0.0" });
      await inproc.connect(ct);
      const inprocTools = (await inproc.listTools()).tools;
      const inprocInstructions = inproc.getInstructions();
      await inproc.close();

      record(
        "BR-12b features.agentBrowserTools=false:effective config 為 false(source=file);bridge 沒有瀏覽器環境旗標、tools/list 只有五個 session 網路工具且與 in-process 版逐字一致(instructions 也沒有瀏覽器段落);scoped token 呼叫 browser.*ForAgent 被拒(gateway.scopedTokenForbidden)、host 沒收到任何指令",
        effective.features.agentBrowserTools.value === false &&
          effective.features.agentBrowserTools.source === "file" &&
          envOff.DESKMONY_MCP_BRIDGE_BROWSER_ENABLED === undefined &&
          JSON.stringify(offTools.map((t) => t.name).sort()) === JSON.stringify(NETWORK_TOOLS) &&
          JSON.stringify(normalizeTools(offTools)) === JSON.stringify(normalizeTools(inprocTools)) &&
          offInstructions === inprocInstructions &&
          !String(offInstructions).includes("browser_navigate") &&
          !navigate.ok &&
          navigate.code === "gateway.scopedTokenForbidden" &&
          !shot.ok &&
          shot.code === "gateway.scopedTokenForbidden" &&
          hostOff.commands.length === 0,
        JSON.stringify({ tools: offTools.map((t) => t.name), navigate: navigate.code, shot: shot.code, hostCommands: hostOff.commands.length }),
      );
    } catch (err) {
      record("BR-12b features.agentBrowserTools=false", false, String(err?.stack ?? err));
    }
  } catch (err) {
    console.error(`\n[FATAL] ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    record("e2e 整體設置", false, String(err?.stack ?? err));
  } finally {
    for (const c of conns) c.close();
    for (const b of bridges) await b.close();
    await killProcessTree(core, "core");
    await killProcessTree(coreOff, "core(off)");
    for (const dir of [dataDir, homeDir, wsA, wsB, offData, offHome, offWs]) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n${"=".repeat(50)}`);
  console.log(`P4a(agent 瀏覽器工具) e2e 結果 (${elapsed}s)`);
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
