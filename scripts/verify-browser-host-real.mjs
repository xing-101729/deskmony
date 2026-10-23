#!/usr/bin/env node
/**
 * scripts/verify-browser-host-real.mjs
 *
 * 2026-10-21(右側面板 P4b):**對一個已經在跑的真 Deskmony 桌面 app(dev 模式)驗證 agent 瀏覽器工具的整條路徑**——
 * 真的 `mcp-bridge-server` 子行程 + MCP client(和 ACP/OpenCode 的 agent 一樣的管線)→ core 的 `BrowserRelay` → **桌面 app 的 renderer
 * (host)→ main 的 `browserExec` 執行器 → CDP 操作真的 `<webview>`**。`scripts/e2e-side-panel-browser.mjs` 只用假 host 驗到 core 這一半;
 * 這支腳本驗另一半(只有真 Electron 才驗得到的事),**不是 `pnpm test` 的一部分**。
 *
 * **這支腳本不啟動 Electron**。你要先自己啟動 app(指令見下面,或不帶參數執行腳本會印出),再用 `--core-port`/`--token` 指到它。
 *
 * ## 準備(另開一個終端機;PowerShell,從 repo 根目錄)
 *   pnpm build
 *   New-Item -ItemType Directory -Force D:\tmp\verify-browser-ws | Out-Null
 *   $env:DESKMONY_CORE_PORT = "4890"
 *   $env:DESKMONY_AUTH_TOKEN = "verify-browser-token"
 *   $env:DESKMONY_HOME = "D:\tmp\verify-browser-home"          # 隔離:不碰你平常的資料(HOME/DATA_DIR/WORKSPACE/PORT 要一起設)
 *   $env:DESKMONY_DATA_DIR = "D:\tmp\verify-browser-data"
 *   $env:DESKMONY_WORKSPACE = "D:\tmp\verify-browser-ws"
 *   $env:DESKMONY_E2E_EXTRA_PROVIDERS = (node scripts/verify-browser-host-real.mjs --print-env)   # 提供 fake ACP provider
 *   pnpm --filter @deskmony/desktop run electron
 * app 開起來、看得到 session 清單之後,在**另一個**終端機:
 *   node scripts/verify-browser-host-real.mjs --core-port=4890 --token=verify-browser-token
 *
 * ## 它做什麼
 *  1. 連到 core(`auth` 用 master token),建兩個用 fake ACP provider 的 session:`verify-browser (agent)` 與 `verify-browser (other)`;
 *     用 `REPORT_MCP_SERVERS_PREFIX` 技巧拿到 agent session 真實核發的 scoped bridge token,開真的 `mcp-bridge-server` + MCP client。
 *  2. 在本機(127.0.0.1、隨機 port)開一個測試頁:按鈕(點擊次數)、輸入框(內容與送出)、連結、每 0.5 秒變動的文字、很長的頁面(捲動)。
 *     頁面把每個事件 POST 回這支腳本,**驗證都看頁面真實的狀態**,不只看工具的回傳值。
 *  3. 「可見」階段(你先在 app 裡選取 `verify-browser (agent)` session;建議把右側面板關著——可以順便驗自動打開面板),依序呼叫七個工具:
 *       navigate → screenshot(存到 <out-dir>\verify-browser-*.jpg)→ read_page(text + interactive)→ click(ref 一次、x/y 一次)→
 *       type + submit → press_key → scroll → 導覽到外部網站被拒 → 連結導覽 + ref 過期 + 上一頁/重新整理 → 載入失敗。
 *  4. 「停放」階段(腳本會暫停,請你在 app 裡**關掉右側面板,或改選 `verify-browser (other)`**,讓那個 webview 看不到):
 *     再做 screenshot、click(ref 與 x/y)、type、scroll——這是 P3.3 實驗之後最重要的一項(停放中的 webview 還能不能被 CDP 操作,
 *     含停放時 webview 的 `tabindex="-1"` 有沒有破壞它)。
 *     注意:2026-10-23 第一次真機完整執行時,停放階段的 P-5a/P-5b(click)FAIL,當時歸因於停放外框的 `inert`;事後發現是**這支腳本自己的 bug**
 *     (用「累計的 click 事件數 + 1」比對頁面的點擊計數,頁面重新載入後計數歸零,所以停放階段的點擊一定比不上),見 `expectOneClick()` 的註解。
 *     那次的對照(拿掉 inert 後只跑 `--phase=parked` 就全過)同時改變了兩件事,所以**沒有證明 inert 會擋 CDP 點擊**。
 *  5. 每一步印 PASS/FAIL;最後印總結與一份**需要你目視確認的 UI 清單**;清理:刪掉兩個 session(app 會連同它們的 webview 一起移除)、
 *     關掉 MCP bridge、關掉測試頁伺服器。
 *
 * ## 選項
 *   --core-port=<n> / --token=<t>   也可用環境變數 DESKMONY_CORE_PORT / DESKMONY_AUTH_TOKEN,或依序給兩個位置參數
 *   --out-dir=<dir>                 截圖存放處(預設 D:\tmp,不存在則用系統暫存目錄)
 *   --phase=all|visible|parked      只跑一個階段(parked = 假設你已經把 webview 停放好;預設 all)
 *   --no-prompt                     不暫停(所有階段連續執行;停放階段不會自動停放,通常只有 --phase=visible 時有意義)
 *   --keep                          結束時不刪除建立的 session(方便事後用 app 檢查)
 *   --print-env                     只印出 DESKMONY_E2E_EXTRA_PROVIDERS 的 JSON(給上面的 PowerShell 指令用)然後結束
 * 結束碼:0 = 全部 PASS;1 = 有 FAIL;2 = 設定/連線階段就失敗(沒跑到驗證)。
 */

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { e2eProvidersEnv, FAKE_ACP } from "./lib/e2e-providers.mjs";
import { REPORT_MCP_SERVERS_PREFIX } from "./fake-acp-agent.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const BRIDGE_ENTRY = path.join(REPO_ROOT, "packages", "adapters", "dist", "mcp-bridge-server.js");
const IS_WIN = process.platform === "win32";

const BROWSER_TOOLS = ["browser_navigate", "browser_screenshot", "browser_read_page", "browser_click", "browser_type", "browser_press_key", "browser_scroll"];
const EXTERNAL_URL = "https://not-allowed.deskmony-verify.invalid/";
/** 一定連不上的本機網址(port 1 沒有人聽)。 */
const REFUSED_URL = "http://127.0.0.1:1/";

// ---- 參數 ---------------------------------------------------------------------------------

function parseArgs(argv) {
  const flags = new Map();
  const positional = [];
  for (const arg of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    if (m) flags.set(m[1], m[2] ?? "true");
    else positional.push(arg);
  }
  return {
    corePort: Number(flags.get("core-port") ?? positional[0] ?? process.env.DESKMONY_CORE_PORT ?? NaN),
    token: flags.get("token") ?? positional[1] ?? process.env.DESKMONY_AUTH_TOKEN,
    outDir: flags.get("out-dir"),
    phase: flags.get("phase") ?? "all",
    noPrompt: flags.has("no-prompt"),
    keep: flags.has("keep"),
    printEnv: flags.has("print-env"),
  };
}

const args = parseArgs(process.argv.slice(2));

if (args.printEnv) {
  // 只印 JSON、不帶任何其他輸出:給 `$env:DESKMONY_E2E_EXTRA_PROVIDERS = (node ... --print-env)` 用。
  process.stdout.write(`${e2eProvidersEnv().DESKMONY_E2E_EXTRA_PROVIDERS}\n`);
  process.exit(0);
}

function printLaunchHelp() {
  console.log(`
如何啟動要被驗證的 dev app(另開一個終端機;本腳本不會啟動 Electron):
  pnpm build
  New-Item -ItemType Directory -Force D:\\tmp\\verify-browser-ws | Out-Null
  $env:DESKMONY_CORE_PORT = "4890"
  $env:DESKMONY_AUTH_TOKEN = "verify-browser-token"
  $env:DESKMONY_HOME = "D:\\tmp\\verify-browser-home"
  $env:DESKMONY_DATA_DIR = "D:\\tmp\\verify-browser-data"
  $env:DESKMONY_WORKSPACE = "D:\\tmp\\verify-browser-ws"
  $env:DESKMONY_E2E_EXTRA_PROVIDERS = (node scripts/verify-browser-host-real.mjs --print-env)
  pnpm --filter @deskmony/desktop run electron
app 開起來之後:
  node scripts/verify-browser-host-real.mjs --core-port=4890 --token=verify-browser-token
`);
}

if (!Number.isInteger(args.corePort) || args.corePort <= 0) {
  console.error("缺少 --core-port=<n>(或環境變數 DESKMONY_CORE_PORT)。");
  printLaunchHelp();
  process.exit(2);
}
if (!["all", "visible", "parked"].includes(args.phase)) {
  console.error(`--phase 只能是 all、visible 或 parked(收到 ${args.phase})`);
  process.exit(2);
}

// ---- 小工具 -------------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const textOf = (res) => res.content?.filter((c) => c.type === "text").map((c) => c.text).join("\n") ?? "";

const results = [];
function record(id, ok, label, detail) {
  results.push({ id, ok, label });
  console.log(`\n[${ok ? "PASS" : "FAIL"}] ${id} ${label}`);
  if (detail) console.log(`       ${detail}`);
}

const truncate = (text, max) => (text.length > max ? `${text.slice(0, max)}…(+${text.length - max} 字)` : text);

/** 所有工具呼叫(MCP 工具與 scoped RPC)的紀錄:任何一步 FAIL 時印出那一步期間的呼叫,不用再猜當時發生了什麼。 */
const callLog = [];
/** 測試頁伺服器(main() 啟動後設定):FAIL 診斷會印頁面最後回報的版面與最近的事件。 */
let pageServerRef;

/** 步驟 FAIL 時印出的原始資料:那一步期間的工具呼叫(參數、isError、回傳文字前 300 字)、步驟自己附的 `raw`、頁面的版面與最近事件。 */
function dumpFailure(id, raw, fromIndex) {
  const lines = [];
  for (const call of callLog.slice(fromIndex).slice(-8)) lines.push(`call ${call.name} ${JSON.stringify(call.args ?? {})} → ${call.summary}`);
  if (raw !== undefined) lines.push(`raw: ${truncate(JSON.stringify(raw), 1500)}`);
  if (pageServerRef) {
    lines.push(`頁面最後回報的版面: ${JSON.stringify(pageServerRef.latestLayout() ?? null)}`);
    lines.push(`頁面最近的事件: ${JSON.stringify(pageServerRef.events.slice(-8).map(({ at: _at, ...rest }) => rest))}`);
  }
  console.log(`       --- ${id} 失敗時的原始資料 ---`);
  for (const line of lines) console.log(`       ${line}`);
}

/** 一個驗證步驟:`fn` 回 `{ok, detail, raw?}`,丟例外算 FAIL(把訊息印出來);FAIL 時一律再印 `dumpFailure()` 的原始資料。 */
async function step(id, label, fn) {
  const fromIndex = callLog.length;
  try {
    const { ok, detail, raw } = await fn();
    record(id, ok, label, detail);
    if (!ok) dumpFailure(id, raw, fromIndex);
    return ok;
  } catch (err) {
    record(id, false, label, `例外: ${err instanceof Error ? err.message : String(err)}`);
    dumpFailure(id, undefined, fromIndex);
    return false;
  }
}

/** 頁面文字結果(`browser_read_page`/`browser_screenshot` 的文字部分)開頭的 url / title 兩行。 */
function pageHeader(text) {
  return { url: /^url: (.*)$/m.exec(text)?.[1], title: /^title: (.*)$/m.exec(text)?.[1] };
}

function resolveOutDir() {
  const candidates = [args.outDir, IS_WIN ? "D:\\tmp" : undefined, os.tmpdir()].filter(Boolean);
  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      return dir;
    } catch {
      // 試下一個
    }
  }
  throw new Error("找不到可以寫入截圖的資料夾(試過 --out-dir、D:\\tmp、系統暫存目錄)");
}

/** 從 JPEG 檔頭讀像素尺寸(找 SOF 標記),不依賴任何影像套件。 */
function jpegSize(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return undefined;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = buf[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) {
      i += marker === 0xff ? 1 : 2;
      continue;
    }
    const length = buf.readUInt16BE(i + 2);
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    i += 2 + length;
  }
  return undefined;
}

/** read_page(interactive)的 MCP 文字 → 元素陣列。 */
function parseInteractive(text) {
  const m = /互動元素:\n([\s\S]*)$/.exec(text);
  if (!m) return undefined;
  try {
    const parsed = JSON.parse(m[1]);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function jsonOf(res) {
  try {
    return JSON.parse(textOf(res));
  } catch {
    return undefined;
  }
}

async function pause(message) {
  if (args.noPrompt) {
    console.log(`\n(--no-prompt,不暫停)${message}`);
    return;
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await new Promise((resolve) => {
    const timer = setTimeout(
      () => {
        rl.close();
        console.log("\n(等待超過 5 分鐘,繼續)");
        resolve();
      },
      5 * 60 * 1000,
    );
    rl.on("close", () => {
      clearTimeout(timer);
      resolve();
    });
    rl.question(`\n>>> ${message}\n    完成後按 Enter 繼續 ... `, () => {
      clearTimeout(timer);
      rl.close();
      resolve();
    });
  });
}

// ---- gateway 連線(最小版:rpc、事件、送 prompt)-------------------------------------------------

class GatewayConn {
  constructor(url) {
    this.url = url;
    this.pending = new Map();
    this.events = [];
    this.waiters = [];
  }

  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`連不上 ${this.url}(10 秒)`)), 10_000);
      this.ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      });
      this.ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error(`連不上 ${this.url}——app 啟動了嗎?port 對嗎?`));
      });
    });
    this.ws.addEventListener("message", (event) => this.onMessage(event.data));
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      // 忽略
    }
  }

  onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : raw.toString());
    } catch {
      return;
    }
    if (msg.kind === "response") {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (msg.ok) pending.resolve(msg.result);
      else {
        const err = new Error(msg.error ?? "unknown gateway error");
        err.errorCode = msg.errorCode;
        pending.reject(err);
      }
    } else if (msg.kind === "event" && msg.channel === "session-event") {
      this.events.push(msg.payload);
      for (const waiter of [...this.waiters]) waiter(msg.payload);
    }
  }

  rpc(method, params, timeoutMs = 30_000) {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`rpc ${method} 逾時(${timeoutMs} ms)`));
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
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** `rpc()` 的不丟例外版:`{ok:true,result}` 或 `{ok:false,code,message}`(code 是 core 回的 errorCode)。 */
  async tryRpc(method, params, timeoutMs) {
    try {
      return { ok: true, result: await this.rpc(method, params, timeoutMs) };
    } catch (err) {
      return { ok: false, code: err.errorCode, message: String(err.message ?? err) };
    }
  }

  waitForEvent(predicate, timeoutMs, fromIndex = 0) {
    for (let i = fromIndex; i < this.events.length; i++) if (predicate(this.events[i])) return Promise.resolve(this.events[i]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(new Error(`等待事件逾時(${timeoutMs} ms)`));
      }, timeoutMs);
      const waiter = (event) => {
        if (!predicate(event)) return;
        clearTimeout(timer);
        this.waiters = this.waiters.filter((w) => w !== waiter);
        resolve(event);
      };
      this.waiters.push(waiter);
    });
  }

  /** 以人類身分送一則 prompt,等這一輪 completed/error,回傳這一輪吐出的文字。 */
  async drivePrompt(sessionId, text, timeoutMs = 60_000) {
    const startIdx = this.events.length;
    await this.rpc("session.sendPrompt", { sessionId, prompt: { text } });
    let cursor = startIdx;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("逾時等待 completed/error 事件");
      const event = await this.waitForEvent((e) => e.sessionId === sessionId, remaining, cursor);
      cursor = this.events.indexOf(event) + 1;
      if (event.event.type === "completed" || event.event.type === "error") {
        return this.events
          .slice(startIdx, cursor)
          .filter((e) => e.sessionId === sessionId && e.event.type === "message-delta")
          .map((e) => e.event.delta)
          .join("");
      }
    }
  }
}

/** 取出某個 session 真實核發的 scoped bridge token 與 bridge 子行程的環境變數(同 e2e-session-network.mjs 的手法)。 */
async function bridgeEnvOf(conn, sessionId) {
  const text = await conn.drivePrompt(sessionId, REPORT_MCP_SERVERS_PREFIX, 30_000);
  const marker = "MCP_SERVERS:";
  const at = text.indexOf(marker);
  if (at < 0) throw new Error(`fake ACP agent 沒有回報 MCP servers(收到: ${text.slice(0, 200)})`);
  const mcpServers = JSON.parse(text.slice(at + marker.length));
  return Object.fromEntries((mcpServers[0].env ?? []).map((e) => [e.name, e.value]));
}

async function openBridge(env) {
  if (!fs.existsSync(BRIDGE_ENTRY)) throw new Error(`找不到 ${BRIDGE_ENTRY},請先 pnpm build`);
  const transport = new StdioClientTransport({ command: process.execPath, args: [BRIDGE_ENTRY], env: { ...process.env, ...env } });
  const client = new Client({ name: "verify-browser-host", version: "1.0.0" });
  await client.connect(transport);
  return {
    async listTools() {
      return (await client.listTools()).tools;
    },
    async call(name, toolArgs = {}) {
      return await client.callTool({ name, arguments: toolArgs }, undefined, { timeout: 60_000 });
    },
    async close() {
      await client.close().catch(() => undefined);
    },
  };
}

// ---- 測試頁伺服器 -----------------------------------------------------------------------------

const NONCE = randomUUID().slice(0, 8);

const TEST_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Deskmony verify page</title>
<style>
body{margin:0;font:16px sans-serif;background:#fff;color:#111}
#info{position:absolute;left:30px;top:16px;margin:0;font-size:18px}
#status{position:absolute;left:30px;top:56px;margin:0;font-size:14px}
#tick{position:absolute;left:30px;top:96px;margin:0}
#btn{position:absolute;left:30px;top:150px;width:220px;height:56px;font-size:18px;background:#d22;color:#fff;border:0}
#f{position:absolute;left:30px;top:240px;margin:0}
#inp{width:300px;height:34px;font-size:16px;box-sizing:border-box}
#lnk{position:absolute;left:30px;top:310px;font-size:18px}
#spacer{position:absolute;left:0;top:400px;width:1px;height:3000px}
#bottom{position:absolute;left:30px;top:3500px}
</style></head><body>
<h2 id="info">VERIFY_PAGE_@NONCE@</h2>
<p id="status">clicks:0</p>
<p id="tick">tick:0</p>
<button id="btn" type="button">Click me</button>
<form id="f"><input id="inp" type="text" aria-label="Verify input" autocomplete="off"></form>
<a id="lnk" href="/page2">Go to page two</a>
<div id="spacer"></div><p id="bottom">BOTTOM_MARKER</p>
<script>
function send(o){ try { fetch("/__event", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(o), keepalive: true }); } catch (e) {} }
var clicks = 0;
// 點擊計數寫在 #status,**不要動 #info**:#info 的 VERIFY_PAGE_<nonce> 是「現在還在測試頁上」的標記,後面的步驟(V-9)靠它確認頁面沒被動到。
// (第一版把計數寫進 #info,第一次點擊之後標記就消失了,V-9 因此誤判 FAIL——那是腳本的錯,不是產品的錯。)
document.getElementById("btn").addEventListener("click", function () { clicks++; document.getElementById("status").textContent = "clicks:" + clicks; send({ type: "click", n: clicks }); });
var inp = document.getElementById("inp");
inp.addEventListener("input", function () { send({ type: "input", value: inp.value }); });
document.getElementById("f").addEventListener("submit", function (e) { e.preventDefault(); send({ type: "submit", value: inp.value }); });
document.addEventListener("keydown", function (e) { send({ type: "keydown", key: e.key }); }, true);
window.addEventListener("scroll", function () { send({ type: "scroll", y: Math.round(window.scrollY) }); }, { passive: true });
var t = 0; setInterval(function () { t++; document.getElementById("tick").textContent = "tick:" + t; }, 500);
function report() {
  var b = document.getElementById("btn").getBoundingClientRect();
  var i = inp.getBoundingClientRect();
  send({ type: "layout", w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio, btn: { x: b.left + b.width / 2, y: b.top + b.height / 2 }, inp: { x: i.left + i.width / 2, y: i.top + i.height / 2 } });
}
window.addEventListener("load", report);
window.addEventListener("resize", report);
</script></body></html>`.replace("@NONCE@", NONCE);

const PAGE_TWO = `<!doctype html><html><head><meta charset="utf-8"><title>Deskmony verify page two</title></head>
<body style="font:18px sans-serif"><h2>VERIFY_PAGE_TWO</h2>
<script>try { fetch("/__event", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "page2" }), keepalive: true }); } catch (e) {}</script></body></html>`;

/** 啟動測試頁伺服器;`events` 是頁面回報的事件(依序),`hits` 是各路徑被請求的次數。 */
function startPageServer() {
  const events = [];
  const hits = {};
  const waiters = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    hits[url.pathname] = (hits[url.pathname] ?? 0) + 1;
    res.setHeader("Cache-Control", "no-store");
    if (req.method === "POST" && url.pathname === "/__event") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        try {
          const event = { ...JSON.parse(Buffer.concat(chunks).toString("utf8")), at: Date.now() };
          events.push(event);
          for (const waiter of [...waiters]) waiter(event);
        } catch {
          // 壞掉的事件就忽略
        }
        res.statusCode = 204;
        res.end();
      });
      return;
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    if (url.pathname === "/") res.end(TEST_PAGE);
    else if (url.pathname === "/page2") res.end(PAGE_TWO);
    else {
      res.statusCode = 404;
      res.end("not found");
    }
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({
        port,
        url: `http://127.0.0.1:${port}/`,
        events,
        hits,
        mark: () => events.length,
        /** 等到 `from` 之後出現符合條件的事件(逾時回 undefined)。 */
        waitFor(predicate, timeoutMs, from = 0) {
          for (let i = from; i < events.length; i++) if (predicate(events[i])) return Promise.resolve(events[i]);
          return new Promise((resolveWait) => {
            const timer = setTimeout(() => {
              waiters.splice(waiters.indexOf(waiter), 1);
              resolveWait(undefined);
            }, timeoutMs);
            const waiter = (event) => {
              if (!predicate(event)) return;
              clearTimeout(timer);
              waiters.splice(waiters.indexOf(waiter), 1);
              resolveWait(event);
            };
            waiters.push(waiter);
          });
        },
        latestLayout: () => [...events].reverse().find((e) => e.type === "layout"),
        close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
      });
    });
  });
}

// ---- 驗證流程 -------------------------------------------------------------------------------

/** noHost 之類的失敗最常見的原因,印出來教使用者。 */
function explainHostFailure(text) {
  if (/browser\.noHost|沒有開著|桌面 app/.test(text)) {
    return "(core 沒有已註冊的 host:桌面 app 的 renderer 要連上 core 並呼叫 browser.registerHost——確認 app 是這個 core 的 app、而且是含 P4b 的版本)";
  }
  return "";
}

async function main() {
  const outDir = resolveOutDir();
  const url = `ws://127.0.0.1:${args.corePort}`;
  const cleanups = [];
  let exitCode = 0;
  printLaunchHelp();
  console.log(`[setup] core = ${url}   截圖資料夾 = ${outDir}   階段 = ${args.phase}   測試頁 nonce = ${NONCE}`);

  let conn;
  let sessionA;
  let sessionB;
  let bridge;
  let scoped;
  let page;
  try {
    // ---- 連線、建 session、拿 bridge env ----
    conn = new GatewayConn(url);
    await conn.connect();
    cleanups.push(() => conn.close());
    if (args.token) await conn.rpc("auth", { token: args.token });
    const workDir = path.join(os.tmpdir(), "deskmony-verify-browser");
    fs.mkdirSync(workDir, { recursive: true });
    const create = async (title) => {
      const res = await conn.tryRpc("session.create", { providerId: FAKE_ACP, workingDir: workDir, title });
      if (!res.ok) {
        throw new Error(
          `建立 session 失敗(${res.code ?? ""} ${res.message}):app 是用 DESKMONY_E2E_EXTRA_PROVIDERS 啟動的嗎?(上面有指令;沒有它就沒有 fake ACP provider)`,
        );
      }
      return res.result.session;
    };
    sessionA = await create("verify-browser (agent)");
    sessionB = await create("verify-browser (other)");
    console.log(`[setup] sessions: agent=${sessionA.id}  other=${sessionB.id}`);

    const env = await bridgeEnvOf(conn, sessionA.id);
    bridge = await openBridge(env);
    cleanups.push(() => bridge.close());
    const scopedConn = new GatewayConn(env.DESKMONY_MCP_BRIDGE_GATEWAY_URL);
    await scopedConn.connect();
    await scopedConn.rpc("auth", { token: env.DESKMONY_MCP_BRIDGE_TOKEN });
    cleanups.push(() => scopedConn.close());
    // 用 scoped token 直接打 gateway:拿得到 errorCode(MCP 工具只回錯誤文字);呼叫也記進 callLog。
    scoped = {
      tryRpc: async (method, params, timeoutMs) => {
        const res = await scopedConn.tryRpc(method, params, timeoutMs);
        callLog.push({ name: `rpc ${method}`, args: params, summary: res.ok ? `ok ${truncate(JSON.stringify(res.result ?? null), 300)}` : `error code=${res.code} message=${JSON.stringify(truncate(String(res.message), 300))}` });
        return res;
      },
    };
    page = await startPageServer();
    pageServerRef = page;
    cleanups.push(() => page.close());
    console.log(`[setup] 測試頁: ${page.url}`);

    const tools = (await bridge.listTools()).map((t) => t.name);
    const missing = BROWSER_TOOLS.filter((name) => !tools.includes(name));
    record(
      "V-0",
      missing.length === 0 && env.DESKMONY_MCP_BRIDGE_BROWSER_ENABLED === "1",
      "真的 mcp-bridge-server 掛了七個瀏覽器工具(DESKMONY_MCP_BRIDGE_BROWSER_ENABLED=1)",
      missing.length ? `缺少: ${missing.join(", ")}` : `tools: ${tools.join(", ")}`,
    );
    if (missing.length) throw new Error("bridge 沒有瀏覽器工具(features.agentBrowserTools 被關了?)");

    // 一個工具呼叫(MCP)→ { res, text, isError }
    const tool = async (name, toolArgs) => {
      const res = await bridge.call(name, toolArgs);
      const text = textOf(res);
      const images = res.content?.filter((c) => c.type === "image").length ?? 0;
      callLog.push({
        name,
        args: toolArgs,
        summary: `isError=${res.isError === true}${images ? ` images=${images}` : ""} text=${JSON.stringify(truncate(text, 300))}`,
      });
      return { res, text, isError: res.isError === true };
    };
    // 取一張截圖:存檔、解析尺寸、跟頁面回報的 viewport 比對比例。
    const takeScreenshot = async (label) => {
      const { res, text, isError } = await tool("browser_screenshot");
      if (isError) return { ok: false, error: text };
      const image = res.content.find((c) => c.type === "image");
      if (!image) return { ok: false, error: `沒有 image content: ${text.slice(0, 200)}` };
      const buf = Buffer.from(image.data, "base64");
      const file = path.join(outDir, `verify-browser-${label}.jpg`);
      fs.writeFileSync(file, buf);
      return { ok: true, buf, file, size: jpegSize(buf), text, mimeType: image.mimeType };
    };
    const interactive = async () => {
      const { text, isError } = await tool("browser_read_page", { mode: "interactive" });
      return { text, isError, elements: isError ? undefined : parseInteractive(text) };
    };
    const findEl = (elements, role, nameRe) => elements?.find((e) => e.role === role && nameRe.test(e.name));
    /**
     * `mark` 之後頁面回報的 click 事件:等到第一個(最多 4 秒),再多等一下,確認只有一個(重複點擊也算錯)。
     * **不要用頁面的點擊計數 `n` 去比對**:頁面重新載入(導覽、reload)時計數歸零,而這支腳本的事件紀錄是整個執行期間累計的——
     * 第一版用「累計的 click 事件數 + 1」當預期的 n,停放階段(頁面在 P-1 重新載入過)的點擊就算真的送達也一定比不上,P-5a/P-5b 因此必定 FAIL。
     */
    const expectOneClick = async (mark) => {
      const first = await page.waitFor((e) => e.type === "click", 4000, mark);
      if (first) await sleep(300);
      const events = page.events.slice(mark).filter((e) => e.type === "click").map(({ at: _at, ...rest }) => rest);
      return { count: events.length, events };
    };

    // 一個階段的全部步驟。`phase` 是 "visible" 或 "parked"(只影響編號與檔名)。
    const runPhase = async (phase) => {
      const P = phase === "visible" ? "V" : "P";
      const first = phase === "visible";

      // ---- navigate ----
      const navMark = page.mark();
      await step(`${P}-1`, "browser_navigate 到本機測試頁:載入完成、標題正確、頁面真的向測試伺服器要了資料並回報版面", async () => {
        const { text, isError } = await tool("browser_navigate", { url: page.url });
        const result = isError ? undefined : JSON.parse(text);
        const layout = await page.waitFor((e) => e.type === "layout", 8000, navMark);
        return {
          ok: !isError && result?.loaded === true && result?.title === "Deskmony verify page" && layout !== undefined,
          detail: isError ? `${text} ${explainHostFailure(text)}` : `result=${text.replace(/\s+/g, " ")} layout=${JSON.stringify(layout)}`,
        };
      });

      // ---- screenshot ----
      await step(`${P}-2`, "browser_screenshot:回 JPEG、長邊 ≤ 1568、存檔(請目視確認不是空白)、圖片比例與頁面 viewport 一致", async () => {
        const shot = await takeScreenshot(`${phase}-screenshot`);
        if (!shot.ok) return { ok: false, detail: shot.error };
        const layout = page.latestLayout();
        const longest = Math.max(shot.size?.width ?? 0, shot.size?.height ?? 0);
        const ratioW = layout ? shot.size.width / layout.w : NaN;
        const ratioH = layout ? shot.size.height / layout.h : NaN;
        const consistent = layout && Math.abs(ratioW - ratioH) / ratioW < 0.01;
        return {
          ok: shot.mimeType === "image/jpeg" && shot.size !== undefined && longest > 0 && longest <= 1568 && Boolean(consistent),
          detail: `file=${shot.file} (${shot.buf.length} bytes) image=${shot.size?.width}x${shot.size?.height} viewport=${layout?.w}x${layout?.h} dpr=${layout?.dpr} ratio=${ratioW.toFixed(3)}/${ratioH.toFixed(3)}`,
        };
      });

      // ---- read_page text ----
      await step(`${P}-3`, "browser_read_page(text):含頁面文字、有「不可信資料」標示;隔一下再讀,每 0.5 秒變動的文字有變(是即時頁面)", async () => {
        const a = await tool("browser_read_page", { mode: "text" });
        await sleep(1300);
        const b = await tool("browser_read_page", { mode: "text" });
        const tick = (t) => Number(/tick:(\d+)/.exec(t)?.[1] ?? NaN);
        return {
          ok: !a.isError && a.text.includes(`VERIFY_PAGE_${NONCE}`) && a.text.includes("不可信資料") && tick(b.text) > tick(a.text),
          detail: a.isError ? a.text : `tick ${tick(a.text)} -> ${tick(b.text)}`,
        };
      });

      // ---- read_page interactive ----
      let elements;
      await step(`${P}-4`, "browser_read_page(interactive):列出按鈕、輸入框、連結(ref/role/name/href)", async () => {
        const read = await interactive();
        elements = read.elements;
        const btn = findEl(elements, "button", /Click me/);
        const input = findEl(elements, "textbox", /Verify input/);
        const link = findEl(elements, "link", /Go to page two/);
        return {
          ok: Boolean(btn && input && link && link.href === `${page.url}page2`),
          detail: read.isError ? read.text : `elements=${JSON.stringify(elements)}`,
        };
      });
      const btnRef = findEl(elements, "button", /Click me/)?.ref;

      // ---- click by ref ----
      await step(`${P}-5a`, "browser_click(ref):按鈕的 click handler 真的被觸發(頁面回報 click)", async () => {
        if (!btnRef) return { ok: false, detail: "沒有按鈕的 ref(上一步失敗)" };
        const mark = page.mark();
        const { text, isError } = await tool("browser_click", { ref: btnRef });
        const landed = await expectOneClick(mark);
        return {
          ok: !isError && landed.count === 1,
          detail: isError ? text : `result=${text.replace(/\s+/g, " ")} 這次點擊之後頁面回報的 click 事件=${JSON.stringify(landed.events)}`,
          raw: { clickResult: { isError, text: truncate(text, 300) }, landed },
        };
      });

      // ---- click by x/y(要先截圖;x/y 是截圖上的像素座標)----
      await step(`${P}-5b`, "browser_click(x/y):依截圖上按鈕中心的像素座標點擊,頁面回報 click", async () => {
        const shot = await takeScreenshot(`${phase}-click-xy`);
        if (!shot.ok) return { ok: false, detail: shot.error };
        const layout = page.latestLayout();
        if (!layout || !shot.size) return { ok: false, detail: "沒有頁面版面或截圖尺寸" };
        const x = Math.round((layout.btn.x * shot.size.width) / layout.w);
        const y = Math.round((layout.btn.y * shot.size.height) / layout.h);
        const mark = page.mark();
        const { text, isError } = await tool("browser_click", { x, y });
        const landed = await expectOneClick(mark);
        return {
          ok: !isError && landed.count === 1,
          detail: isError
            ? text
            : `按鈕中心 css=(${layout.btn.x.toFixed(1)},${layout.btn.y.toFixed(1)}) → 截圖像素 (${x},${y})(圖 ${shot.size.width}x${shot.size.height} / viewport ${layout.w}x${layout.h});這次點擊之後頁面回報的 click 事件=${JSON.stringify(landed.events)}`,
          raw: { clickResult: { isError, text: truncate(text, 300) }, landed, layout },
        };
      });

      // ---- type + submit ----
      await step(`${P}-6`, "browser_type(ref + submit):文字真的進了輸入框、Enter 送出了表單(頁面回報 input 與 submit)", async () => {
        const read = await interactive();
        const input = findEl(read.elements, "textbox", /Verify input/);
        if (!input) return { ok: false, detail: `找不到輸入框的 ref: ${read.text.slice(0, 200)}` };
        // 每個階段一開始都重新導覽到測試頁(P-1/V-1),輸入框一定是空的,所以送出的內容要**完全等於**輸入的文字。
        const mark = page.mark();
        const text = first ? "hello deskmony" : "parked deskmony";
        const { text: out, isError } = await tool("browser_type", { text, ref: input.ref, submit: true });
        const submit = await page.waitFor((e) => e.type === "submit", 4000, mark);
        const inputEvent = await page.waitFor((e) => e.type === "input", 1000, mark);
        return {
          ok: !isError && submit?.value === text && inputEvent !== undefined,
          detail: isError ? out : `submit=${JSON.stringify(submit)} lastInput=${JSON.stringify(inputEvent)}`,
        };
      });

      // ---- press_key ----
      await step(`${P}-7`, "browser_press_key:Escape 到達頁面(keydown)、Backspace 刪掉輸入框最後一個字元", async () => {
        const mark = page.mark();
        const esc = await tool("browser_press_key", { key: "Escape" });
        const keydown = await page.waitFor((e) => e.type === "keydown" && e.key === "Escape", 3000, mark);
        const lastValue = [...page.events].reverse().find((e) => e.type === "submit")?.value ?? "";
        const markBackspace = page.mark();
        const bs = await tool("browser_press_key", { key: "Backspace" });
        const input = await page.waitFor((e) => e.type === "input", 3000, markBackspace);
        return {
          ok: !esc.isError && !bs.isError && keydown !== undefined && input?.value === lastValue.slice(0, -1),
          detail: `Escape keydown=${JSON.stringify(keydown)};Backspace 之後 input=${JSON.stringify(input)}(預期 ${JSON.stringify(lastValue.slice(0, -1))})`,
        };
      });

      // ---- scroll(以及捲動之後舊截圖失效)----
      await step(`${P}-8`, "browser_scroll:向下捲動頁面真的捲了(scroll 事件 y>0),向上捲回 0;捲動之後用 x/y 點擊要先重新截圖(browser.noScreenshot)", async () => {
        const mark = page.mark();
        const down = await tool("browser_scroll", { direction: "down" });
        const scrolledDown = await page.waitFor((e) => e.type === "scroll" && e.y > 0, 4000, mark);
        const stale = await scoped.tryRpc("browser.clickForAgent", { x: 10, y: 10 });
        const markUp = page.mark();
        const up = await tool("browser_scroll", { direction: "up", amount: 5 });
        const scrolledUp = await page.waitFor((e) => e.type === "scroll" && e.y === 0, 4000, markUp);
        return {
          ok: !down.isError && !up.isError && scrolledDown !== undefined && scrolledUp !== undefined && !stale.ok && stale.code === "browser.noScreenshot",
          detail: `down→y=${scrolledDown?.y} up→y=${scrolledUp?.y};捲動後 x/y 點擊 → ${stale.ok ? "意外成功" : stale.code}`,
        };
      });

      // ---- 導覽政策(core 擋下,host 完全不會被打擾)----
      if (first) {
        await step("V-9", "導覽到外部網站(不在 allowedHosts)與 file: 都被拒絕(browser.hostNotAllowed / browser.unsupportedScheme),頁面沒被動到", async () => {
          const ext = await scoped.tryRpc("browser.navigateForAgent", { url: EXTERNAL_URL });
          const file = await scoped.tryRpc("browser.navigateForAgent", { url: "file:///C:/Windows/win.ini" });
          const still = await tool("browser_read_page", { mode: "text" });
          // 「頁面沒被動到」用三個獨立的訊號:讀頁面沒有錯誤、url 還是測試頁、文字裡還有 #info 的 nonce 標記
          // (標記只有頁面重新載入或換頁才會變;點擊計數寫在 #status,不會動它)。
          const header = pageHeader(still.text);
          const readOk = !still.isError;
          const urlOk = header.url === page.url;
          const nonceOk = still.text.includes(`VERIFY_PAGE_${NONCE}`);
          return {
            ok: !ext.ok && ext.code === "browser.hostNotAllowed" && !file.ok && file.code === "browser.unsupportedScheme" && readOk && urlOk && nonceOk,
            detail: `外部 → ${ext.ok ? "意外成功" : ext.code};file: → ${file.ok ? "意外成功" : file.code};讀頁面 isError=${still.isError} url=${header.url} title=${header.title} 含 nonce 標記=${nonceOk}`,
            raw: {
              ext,
              file,
              still: { isError: still.isError, url: header.url, title: header.title, expectedUrl: page.url, text: truncate(still.text, 300) },
            },
          };
        });

        // ---- 連結導覽 + ref 過期 + 上一頁/重新整理 ----
        await step("V-10", "點連結導覽到第二頁(ref)→ 舊 ref 過期(browser.staleRef)→ 上一頁回到測試頁 → 重新整理會再向伺服器要一次", async () => {
          const read = await interactive();
          const link = findEl(read.elements, "link", /Go to page two/);
          if (!link) return { ok: false, detail: "找不到連結的 ref" };
          const mark = page.mark();
          const click = await tool("browser_click", { ref: link.ref });
          const two = await page.waitFor((e) => e.type === "page2", 6000, mark);
          const stale = await scoped.tryRpc("browser.clickForAgent", { ref: link.ref });
          const back = await tool("browser_navigate", { action: "back" });
          const backResult = back.isError ? undefined : JSON.parse(back.text);
          const hitsBefore = page.hits["/"] ?? 0;
          const reload = await tool("browser_navigate", { action: "reload" });
          const reloaded = (page.hits["/"] ?? 0) > hitsBefore;
          return {
            ok:
              !click.isError &&
              two !== undefined &&
              !stale.ok &&
              stale.code === "browser.staleRef" &&
              !back.isError &&
              backResult?.url === page.url &&
              !reload.isError &&
              reloaded,
            detail: `點連結 → page2 事件=${two !== undefined};舊 ref → ${stale.ok ? "意外成功" : stale.code};back → ${backResult?.url};reload 伺服器請求數 ${hitsBefore}→${page.hits["/"] ?? 0}`,
          };
        });

        // ---- 載入失敗 ----
        await step("V-11", "導覽到一定連不上的本機網址 → browser.navigationFailed(帶錯誤說明);之後可以回到測試頁", async () => {
          const failed = await scoped.tryRpc("browser.navigateForAgent", { url: REFUSED_URL }, 40_000);
          const back = await tool("browser_navigate", { url: page.url });
          return {
            ok: !failed.ok && failed.code === "browser.navigationFailed" && !back.isError,
            detail: `連不上 → ${failed.ok ? "意外成功" : `${failed.code}: ${failed.message}`};回到測試頁 → ${back.isError ? back.text : "ok"}`,
          };
        });
      }
    };

    // ---- 可見階段 ----
    if (args.phase === "all" || args.phase === "visible") {
      await pause(
        `在 app 左側 session 清單選取「verify-browser (agent)」。建議把右側面板先關掉(Ctrl+J)——第一個瀏覽器指令會讓面板自動打開並切到 Browser 分頁(也順便驗這個行為)。\n    接下來的「可見」階段,請你看著 app 的右側面板。`,
      );
      console.log("\n===== 可見階段 =====");
      await runPhase("visible");
    }

    // ---- 停放階段 ----
    if (args.phase === "all" || args.phase === "parked") {
      await pause(
        `現在請把那個 webview 「藏起來」:在 app 裡**關掉右側面板(Ctrl+J)**,或**改選「verify-browser (other)」這個 session**。\n    (停放中的 webview 使用者看不到,但 agent 還是要能截圖、點擊、輸入。)`,
      );
      console.log("\n===== 停放階段 =====");
      // 讓頁面重新量一次 viewport,確認真的停放了(停放的 webview 是 1024x768)。
      await sleep(600);
      const layout = page.latestLayout();
      const parked = layout && layout.w === 1024 && layout.h === 768;
      console.log(
        `[info] 頁面最後回報的 viewport = ${layout ? `${layout.w}x${layout.h}` : "(還沒有)"}:${
          parked ? "是停放的 1024x768" : "不是 1024x768——webview 可能還看得到(面板還開著且停在 Browser 分頁?);下面的結果仍然有效,但不是在驗停放"
        }`,
      );
      await runPhase("parked");
    }
  } catch (err) {
    exitCode = 2;
    console.log(`\n[ABORT] ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    // ---- 清理 ----
    if (conn && !args.keep) {
      for (const session of [sessionA, sessionB]) {
        if (!session) continue;
        const res = await conn.tryRpc("session.delete", { sessionId: session.id }, 15_000);
        console.log(`[cleanup] 刪除 session ${session.id}: ${res.ok ? "ok" : `${res.code ?? ""} ${res.message}`}`);
      }
    } else if (args.keep) {
      console.log(`[cleanup] --keep:保留 session agent=${sessionA?.id} other=${sessionB?.id}(要自己刪)`);
    }
    for (const fn of cleanups.reverse()) {
      try {
        await fn();
      } catch {
        // 忽略
      }
    }
  }

  // ---- 總結 ----
  const failed = results.filter((r) => !r.ok);
  console.log("\n==== 總結 ====");
  for (const r of results) console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.id}  ${r.label}`);
  console.log(`\n${results.length - failed.length} PASS / ${failed.length} FAIL(共 ${results.length} 步)`);
  console.log(`截圖在 ${outDir}\\verify-browser-*.jpg——請**目視確認**可見階段與停放階段的截圖都不是空白、內容是測試頁(紅色按鈕、輸入框)。`);
  console.log(`
需要你在 app 裡目視確認的 UI(腳本看不到):
  [ ] agent 操作期間,Browser 分頁的標題列變成「agent 正在操作瀏覽器 · <最近的動作>」(底色是強調色),最後一個動作結束後約 8 秒消失
  [ ] Browser 分頁標籤上有一個小圓點(即使你停在 Terminal 等其他分頁也看得到)
  [ ] 聊天標頭的面板開關鈕右上角有小圓點、提示文字帶最近的動作(面板關著時也看得到)
  [ ] 面板原本關著、目前選取的是 verify-browser (agent) 時,第一個指令讓面板自動打開並切到 Browser 分頁;之後你手動關掉面板,下一個指令(8 秒內)不會又把它彈出來
  [ ] 指示出現/消失時,webview 的位置與大小沒有跳動(標題列沒有多一列)
  [ ] 停放階段你切回 verify-browser (agent) + 開 Browser 分頁:頁面還在(沒重新載入)、剛剛輸入的文字還在
  [ ] 停放階段按 Tab:焦點不會跑進看不見的頁面(webview 的 tabindex=-1);回到可見後 Tab 可以進頁面
  [ ] 截圖之後你手動拖拉面板寬度(webview 尺寸變了)→ 再叫 agent 用 x/y 點擊,會得到 browser.staleScreenshot(這項腳本無法自動觸發)
`);
  if (exitCode === 0 && failed.length > 0) exitCode = 1;
  return exitCode;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(2);
  });
