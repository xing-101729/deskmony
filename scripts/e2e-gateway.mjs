#!/usr/bin/env node
/**
 * scripts/e2e-gateway.mjs
 *
 * 端到端冒煙測試:直接透過 WS Gateway 打 apps/core(不經過 Electron UI),
 * 驗證 M1 review 修復的兩個 bug 在執行期確實有效:
 *
 *   1. 串流 messageId 修復(packages/adapters/src/claude-sdk-adapter.ts):
 *      同一則 assistant 訊息的所有 message-delta 事件必須共用同一個
 *      messageId(以 message_start 為邊界),最後一個 delta 帶 done:true。
 *   2. 權限逾時死鎖修復(apps/core/src/session/session-manager.ts):
 *      逾時回呼直接呼叫 adapter.resolvePermission 送出 deny,agent 不會
 *      永久卡在 waiting-permission。
 *
 * 用法:
 *   node scripts/e2e-gateway.mjs
 *
 * 前置需求:
 *   - pnpm build 已跑過(apps/core/dist/index.js 存在)
 *   - 本機有可用的 Claude Code 登入憑證(或 ANTHROPIC_API_KEY)
 *
 * 這支腳本會:
 *   - 啟動一個獨立的 apps/core process(專用 port + 專用 SQLite 資料目錄 +
 *     縮短的權限逾時,互不影響本機正在跑的 dev 環境)
 *   - 建一個暫存工作目錄跑對話 + 檔案寫入測試
 *   - 額外做一次 Electron 啟動冒煙測試(不操作 GUI)
 *   - 結束時清理 process 與暫存檔案
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  FAKE_ACP_REPLY_CHUNKS,
  WRITE_FILE_PREFIX,
  USAGE_UPDATE_PREFIX,
  AVAILABLE_COMMANDS_PREFIX,
  DIFF_CONTENT_PREFIX,
  CALL_BRIDGE_TOOL_PREFIX,
  REPORT_MCP_SERVERS_PREFIX,
  delayEchoMarker,
} from "./fake-acp-agent.mjs";
import { FAKE_OPENCODE_REPLY_CHUNKS, TOOL_CALL_PREFIX, SLOW_PREFIX, TEST_COMMANDS } from "./fake-opencode-server.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const CORE_PORT = 4319;
const PERMISSION_TIMEOUT_MS = 10_000; // 縮短逾時,測試逾時死鎖修復用
const CORE_ENTRY = path.join(REPO_ROOT, "apps", "core", "dist", "index.js");

// ---------------------------------------------------------------------
// M5 Round A 任務0:套件切分 —— `--only=deterministic` / `--only=model-behavior`
//
// 分類原則(對應 README「端到端冒煙測試」章節的完整說明):
//   - deterministic:結果不受「真實模型當輪自由選擇怎麼講/怎麼做」影響 ——
//     即使底層真的起了一個 Claude SDK session(例如步驟 3/4/6/13a/14a-e),
//     只要斷言的是「系統行為」(協定/事件順序、side effect 是否發生、
//     session 狀態機是否卡死、DB 是否落地)而不是「模型自由選擇的用詞/是否
//     照做」,就算 deterministic。
//   - model-behavior:斷言的是模型當輪的自由選擇(例如「模型是否照字面回覆
//     某段文字」「模型是否選擇呼叫某個工具」)——同樣的程式碼,同一個 prompt,
//     模型不同輪可能給出不同結果,不是 regression。
//
// 目前被標記 model-behavior 的檢查點與理由:
//   - 步驟3b:斷言模型「回覆內容大致符合預期」的軟性檢查,純粹是模型選擇的
//     措辭是否貼近期望文字,不影響步驟3主判定(分組/done/completed)。
//   - 步驟5:deny 路徑本身的系統行為(deny 之後不應該建立檔案、session 應
//     正常結束)其實是系統行為,但這個檢查點的預算依賴「模型收到 deny 後
//     是否會重試/换句話說法再問一次」——這是模型的自由選擇,决定了整個檢查
//     點在時間預算內能不能收斂,已實測連續執行時偶發單獨 FAIL(見 README
//     「e2e 的殘留 flakiness」),因此整組列為 model-behavior。
//   - 步驟13b:斷言「模型實際呼叫了 send_message 工具」,直接是模型的自由
//     選擇(模型當輪可能選擇不呼叫任何工具),已知 flake。
//   - 步驟14f:斷言「原本冗長任務確實被中斷」,依賴模型在送出 interrupt
//     前累積了多少內容、以及模型是否還在繼續原任務,屬於模型行為的時間點
//     巧合,不是系統本身的行為保證(系統保證是14c/14d/14e這三個硬性子步驟)。
//   - 步驟14g:斷言「後續 assistant 回覆提及注入的確認碼」,直接是模型是否
//     照字面回覆的自由選擇,已知 flake(比照步驟5/13)。
//   14c/14d/14e 雖然也依賴一個真實、正在忙碌中的 Claude SDK session,但斷言
//   的是「訊息是否被注入 session.history」「priority 是否被降級」「session
//   是否最終回到 idle」—— 這些是程式碼路徑本身的行為保證,不受模型是否遵從
//   指令影響,因此維持 deterministic。
// ---------------------------------------------------------------------
const CLI_ONLY_ARG = process.argv.find((a) => a.startsWith("--only="));
const ONLY_MODE = CLI_ONLY_ARG ? CLI_ONLY_ARG.slice("--only=".length).trim() : undefined;
if (ONLY_MODE && ONLY_MODE !== "deterministic" && ONLY_MODE !== "model-behavior") {
  console.error(`未知的 --only 值: "${ONLY_MODE}"(僅接受 deterministic / model-behavior)`);
  process.exit(1);
}
/** 目前模式是否應該執行/計入某個分類。ONLY_MODE 未設定時兩組都跑。 */
function shouldRun(category) {
  return !ONLY_MODE || ONLY_MODE === category;
}
/** 因 --only 過濾而整段略過某個分類獨有的測試區塊時,印一行說明,不寫入 results。 */
function skipNote(name, category) {
  console.log(`\n[SKIP] ${name}(--only=${ONLY_MODE},此檢查點屬於 ${category} 分組)`);
}

// ---------------------------------------------------------------------
// PASS/FAIL 記錄
// ---------------------------------------------------------------------
const results = [];
/**
 * @param {string} name
 * @param {boolean} ok
 * @param {string=} detail
 * @param {"deterministic"|"model-behavior"} [category="deterministic"]
 */
function record(name, ok, detail, category = "deterministic") {
  results.push({ name, ok, detail, category });
  const tag = ok ? "PASS" : "FAIL";
  const tagLine = category === "model-behavior" ? `[${tag}] [model-behavior]` : `[${tag}]`;
  console.log(`\n${tagLine} ${name}`);
  if (detail) console.log(`       ${detail}`);
}
function log(msg) {
  console.log(msg);
}

// ---------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function killProcessTree(proc, label) {
  if (!proc || proc.exitCode !== null || proc.killed) return;
  log(`[cleanup] 終止 ${label}(pid=${proc.pid}) ...`);
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      proc.kill("SIGTERM");
    }
  } catch (err) {
    log(`[cleanup] 終止 ${label} 時發生錯誤(忽略): ${err}`);
  }
  // 給一點時間讓 process 真的結束
  await sleep(500);
}

// ---------------------------------------------------------------------
// Core process 管理
// ---------------------------------------------------------------------
/**
 * @param {{port:number, dataDir:string, workspaceDir:string, permissionTimeoutMs:number,
 *   authToken?:string, bindHost?:string, extraEnv?:Record<string,string>}} opts
 *   `authToken`/`bindHost` 為 M5 Round A 新增(步驟17 認證測試用),只在提供
 *   時才覆寫對應環境變數,未提供時維持既有行為(免認證、預設綁定 127.0.0.1)。
 *   `extraEnv` 為 M5 Round B 新增(步驟18 安全強化測試用,例如覆寫
 *   DESKMONY_AUTH_RATE_LIMIT_MAX/DESKMONY_AUTH_RATE_LIMIT_COOLDOWN_MS 縮短
 *   rate limiting 冷卻期),原樣合併進子程序環境變數。
 */
function startCore({ port, dataDir, workspaceDir, permissionTimeoutMs, authToken, bindHost, extraEnv }) {
  const env = {
    ...process.env,
    DESKMONY_CORE_PORT: String(port),
    DESKMONY_DATA_DIR: dataDir,
    DESKMONY_WORKSPACE: workspaceDir,
    DESKMONY_PERMISSION_TIMEOUT_MS: String(permissionTimeoutMs),
    ...(extraEnv ?? {}),
  };
  if (authToken) env.DESKMONY_AUTH_TOKEN = authToken;
  if (bindHost) env.DESKMONY_BIND_HOST = bindHost;
  const proc = spawn(process.execPath, [CORE_ENTRY], {
    cwd: REPO_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (chunk) => process.stdout.write(`[core] ${chunk}`));
  proc.stderr.on("data", (chunk) => process.stderr.write(`[core:err] ${chunk}`));
  proc.on("exit", (code, signal) => {
    log(`[core] process exited (code=${code} signal=${signal})`);
  });
  return proc;
}

/** 等待一個 WebSocket 連線關閉(或已經是關閉狀態),逾時回傳 false。 */
function waitForWsClose(ws, timeoutMs) {
  return new Promise((resolve) => {
    if (!ws || ws.readyState === WebSocket.CLOSED) {
      resolve(true);
      return;
    }
    const t = setTimeout(() => resolve(false), timeoutMs);
    ws.addEventListener("close", () => {
      clearTimeout(t);
      resolve(true);
    });
  });
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

/**
 * 用 node:http 的低階 API 送出一個 GET request,`rawPath` 原封不動地當作
 * HTTP 請求行的 request-target 送出——**刻意不用** WHATWG `URL`/全域
 * `fetch()`:兩者在建構 URL 物件時都會依 RFC 3986 正規化路徑(把
 * `/../../package.json` 收斂成 `/package.json` 之後才發送請求),沒辦法真的
 * 把帶有 `..` 的原始路徑送到伺服器,無法用來測試伺服器端的目錄穿越防護
 * (見 apps/core/src/http/static-server.ts 的 resolveStaticFile())。
 * node:http 的 `http.request({ path })` 不會做這層正規化,`path` 是什麼字串
 * 就原樣寫進請求行,正好用來重現真實攻擊者可能送出的原始請求。
 */
function rawHttpGet(urlBase, rawPath, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlBase);
    const req = http.request(
      {
        host: u.hostname,
        port: u.port,
        path: rawPath,
        method: "GET",
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8"), headers: res.headers });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("request timeout")));
    req.on("error", reject);
    req.end();
  });
}

// ---------------------------------------------------------------------
// WS Gateway client
// ---------------------------------------------------------------------
class GatewayClient {
  constructor(url) {
    this.url = url;
    this.pendingRpc = new Map();
    /** @type {{sessionId:string, event:any, timestamp:number}[]} */
    this.events = [];
    this.sessionUpdates = [];
    this.waiters = [];
    /** @type {{sessionId:string, requestId:string, decision:string, source:string}[]} */
    this.permissionResolvedEvents = [];
    this.permissionResolvedWaiters = [];
    /** M4 Round A(步驟15):"task-updated" 推播(TaskService.emit → WsGateway.broadcast)。 */
    this.taskUpdates = [];
    this.taskUpdateWaiters = [];
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
      log("[ws] connection closed");
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
        else pending.reject(new Error(msg.error ?? "unknown gateway error"));
      }
      return;
    }
    if (msg.kind === "event") {
      if (msg.channel === "session-event") {
        this.events.push(msg.payload);
        for (const w of [...this.waiters]) w(msg.payload);
      } else if (msg.channel === "session-updated") {
        this.sessionUpdates.push(msg.payload);
      } else if (msg.channel === "permission-resolved") {
        this.permissionResolvedEvents.push(msg.payload);
        for (const w of [...this.permissionResolvedWaiters]) w(msg.payload);
      } else if (msg.channel === "task-updated") {
        this.taskUpdates.push(msg.payload);
        for (const w of [...this.taskUpdateWaiters]) w(msg.payload);
      }
      // session-list-updated: 不需要
    }
  }

  /** 等待符合 predicate 的 permission-resolved 推播(修復項目 3 用)。 */
  waitForPermissionResolved(predicate, timeoutMs) {
    const existing = this.permissionResolvedEvents.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.permissionResolvedWaiters = this.permissionResolvedWaiters.filter((w) => w !== waiter);
        reject(new Error(`等待 permission-resolved 事件逾時 (${timeoutMs}ms)`));
      }, timeoutMs);
      const waiter = (payload) => {
        if (predicate(payload)) {
          clearTimeout(t);
          this.permissionResolvedWaiters = this.permissionResolvedWaiters.filter((w) => w !== waiter);
          resolve(payload);
        }
      };
      this.permissionResolvedWaiters.push(waiter);
    });
  }

  /** 等待符合 predicate 的 task-updated 推播(步驟15用)。 */
  waitForTaskUpdate(predicate, timeoutMs) {
    const existing = this.taskUpdates.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.taskUpdateWaiters = this.taskUpdateWaiters.filter((w) => w !== waiter);
        reject(new Error(`等待 task-updated 事件逾時 (${timeoutMs}ms)`));
      }, timeoutMs);
      const waiter = (payload) => {
        if (predicate(payload)) {
          clearTimeout(t);
          this.taskUpdateWaiters = this.taskUpdateWaiters.filter((w) => w !== waiter);
          resolve(payload);
        }
      };
      this.taskUpdateWaiters.push(waiter);
    });
  }

  rpc(method, params, timeoutMs = 30_000) {
    const id = randomUUID();
    const payload = { id, method, params };
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
      this.ws.send(JSON.stringify(payload));
    });
  }

  /** 從 fromIndex(events 陣列 index)開始等待符合 predicate 的 session-event。 */
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
   * 送出一個 prompt,逐一消化該 session 之後的所有事件,直到 completed/error。
   * 遇到 permission-request 時呼叫 onPermission(event) 決定 allow/deny/ignore。
   */
  async drivePrompt(sessionId, text, { onPermission, timeoutMs = 90_000 } = {}) {
    const startIdx = this.events.length;
    await this.rpc("session.sendPrompt", { sessionId, prompt: { text } });
    let cursor = startIdx;
    const deadline = Date.now() + timeoutMs;
    const collected = [];
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`逾時等待 completed/error 事件(已收集 ${collected.length} 筆事件,text=${text.slice(0, 40)}...)`);
      }
      const ev = await this.waitForEvent((e) => e.sessionId === sessionId, remaining, cursor);
      cursor = this.events.indexOf(ev) + 1;
      collected.push(ev);
      if (ev.event.type === "permission-request" && onPermission) {
        const decision = await onPermission(ev.event);
        if (decision === "allow" || decision === "deny") {
          await this.rpc("permission.resolve", { requestId: ev.event.requestId, decision });
        }
        // decision === "ignore":刻意不回覆,測試逾時路徑
      } else if (ev.event.type === "completed" || ev.event.type === "error") {
        return { finalEvent: ev, collected };
      }
    }
  }
}

/**
 * 步驟 5(deny)與步驟 6(逾時)各自建立一個全新、獨立的 session,測完即刪除,
 * 不再與步驟 3/4 共用同一個 session(M2 Round A 步驟 0:e2e 穩定化)。
 *
 * 修復動機:先前 5 個小步驟(3/4/5/6/7)共用同一個 session,而步驟 5/6 是
 * 權限測試,依賴「真實模型在收到 deny 之後的行為」—— 模型偶爾會重試、
 * 換句話說法再問一次,甚至多問幾輪,導致單一步驟拖過時間預算。因為是
 * 同一個 session,一旦某步驟因此逾時,session 當下的串流/狀態機可能還卡在
 * 上一輪的尾巴,污染下一個共用同一個 session 的步驟,造成連鎖 FAIL(而非
 * 單一步驟的獨立 FAIL)。隔離成各自的 session 後,一步失敗不會波及其他
 * 步驟的判定,且測完立刻 delete,不留執行中的 session。
 */
async function withIsolatedSession(client, profile, workspaceDir, title, fn) {
  const created = await client.rpc(
    "session.create",
    { agentProfileId: profile.id, workingDir: workspaceDir, title },
    30_000,
  );
  const isolatedSessionId = created.session.id;
  try {
    return await fn(isolatedSessionId);
  } finally {
    try {
      await client.rpc("session.delete", { sessionId: isolatedSessionId });
    } catch (err) {
      log(`[cleanup] 刪除隔離 session(${title})時發生錯誤(忽略): ${err}`);
    }
  }
}

// ---------------------------------------------------------------------
// message-delta 分組驗證(修復 1)
// ---------------------------------------------------------------------
function analyzeMessageDeltas(collected) {
  const deltas = collected.filter((e) => e.event.type === "message-delta").map((e) => e.event);
  const groups = [];
  let current = null;
  let violation = null;
  for (const d of deltas) {
    if (!current || current.messageId !== d.messageId) {
      if (current && !current.done) {
        violation = `messageId 從 ${current.messageId} 換成 ${d.messageId} 時,前一組尚未收到 done:true`;
      }
      current = { messageId: d.messageId, text: "", done: false, count: 0 };
      groups.push(current);
    }
    current.text += d.delta;
    current.count += 1;
    if (d.done) current.done = true;
  }
  return { deltas, groups, violation };
}

// ---------------------------------------------------------------------
// diff 顯示驗證(Codex ACP 橋接切換 Phase 3,決定性測試,不依賴外部模型)
// ---------------------------------------------------------------------
/**
 * 驗證 `ToolResultEvent.structuredResult` 是否符合
 * `apps/desktop/src/views/chat/DiffHunkView.tsx` 的 `parseDiffResult()` 期待
 * 的形狀(`{filePath: string, structuredPatch: [{oldStart, oldLines,
 * newStart, newLines, lines: string[]}]}`),並把所有 hunk 的 `lines` 攤平
 * 抽出 "+"/"-" 開頭的行(去掉前綴)方便比對實際新增/刪除的內容。刻意**不**
 * 逐行斷言 hunk 是否含 `"\ No newline at end of file"` 這類中性 metadata
 * 行——那是 `diff` 套件(jsdiff)的既有輸出慣例,不是 AcpAdapter 自己的邏輯,
 * 鎖住它只會讓這個測試對套件版本升級過度敏感。回傳 `undefined` 代表形狀不符
 * (呼叫端據此視為「沒有可用的 diff 資訊」,等同 UI 端 `parseDiffResult()`
 * 回傳 `null` 時的 fallback 語意)。
 */
function summarizeStructuredPatch(structuredResult) {
  if (typeof structuredResult !== "object" || structuredResult === null) return undefined;
  const { filePath, structuredPatch } = structuredResult;
  if (typeof filePath !== "string" || !Array.isArray(structuredPatch)) return undefined;
  const added = [];
  const removed = [];
  for (const hunk of structuredPatch) {
    if (
      typeof hunk !== "object" ||
      hunk === null ||
      typeof hunk.oldStart !== "number" ||
      typeof hunk.oldLines !== "number" ||
      typeof hunk.newStart !== "number" ||
      typeof hunk.newLines !== "number" ||
      !Array.isArray(hunk.lines)
    ) {
      return undefined;
    }
    for (const line of hunk.lines) {
      if (typeof line !== "string") return undefined;
      if (line.startsWith("+")) added.push(line.slice(1));
      else if (line.startsWith("-")) removed.push(line.slice(1));
    }
  }
  return { filePath, added, removed, hunkCount: structuredPatch.length };
}

// ---------------------------------------------------------------------
// 步驟 9: AcpAdapter + fake ACP agent(決定性測試,不依賴外部模型)
// ---------------------------------------------------------------------
async function acpFakeAgentSmokeTest(client, workspaceDir) {
  const fakeAgentPath = path.join(REPO_ROOT, "scripts", "fake-acp-agent.mjs");
  let acpProfile;
  let acpSessionId;

  try {
    const created = await client.rpc("profile.create", {
      name: "E2E Fake ACP Agent",
      software: "acp",
      workingDir: workspaceDir,
      acpConfig: { command: process.execPath, args: [fakeAgentPath] },
    });
    acpProfile = created.profile;

    const sessionCreated = await client.rpc(
      "session.create",
      { agentProfileId: acpProfile.id, workingDir: workspaceDir, title: "e2e-acp-smoke" },
      30_000,
    );
    acpSessionId = sessionCreated.session.id;
    record(
      "步驟9a 建立 software=\"acp\" 的 AgentProfile + session(AdapterRegistry 選到 AcpAdapter)",
      true,
      `profileId=${acpProfile.id}, sessionId=${acpSessionId}`,
    );
  } catch (err) {
    record("步驟9a 建立 software=\"acp\" 的 AgentProfile + session", false, String(err));
    return; // 沒有 session 就無法跑後續子步驟
  }

  // ---- 9b: 一般 prompt,驗證串流事件轉換(message-delta 分組/done)+ completed ----
  try {
    const { finalEvent, collected } = await client.drivePrompt(acpSessionId, "hello there", {
      onPermission: async () => "deny", // 不應該觸發權限請求
      timeoutMs: 20_000,
    });
    const { deltas, groups, violation } = analyzeMessageDeltas(collected);
    const fullText = groups.map((g) => g.text).join("");
    const expectedText = FAKE_ACP_REPLY_CHUNKS.join("");
    const lastGroupDone = groups.length > 0 && groups[groups.length - 1].done === true;

    const ok =
      finalEvent.event.type === "completed" &&
      deltas.length > 0 &&
      !violation &&
      lastGroupDone &&
      fullText === expectedText;

    record(
      "步驟9b ACP 一般 prompt:session/update → message-delta 轉換正確 + completed",
      ok,
      violation
        ? `違規: ${violation}`
        : `fullText=${JSON.stringify(fullText)}(預期 ${JSON.stringify(expectedText)}), deltas=${deltas.length}, lastGroupDone=${lastGroupDone}, 最終事件=${finalEvent.event.type}`,
    );
  } catch (err) {
    record("步驟9b ACP 一般 prompt:session/update → message-delta 轉換正確 + completed", false, String(err));
  }

  // ---- 9c: 觸發寫檔 + permission allow ----
  try {
    const allowFile = path.join(workspaceDir, "acp-allow.txt");
    const allowFilePosix = allowFile.split(path.sep).join("/");
    const expectedContent = "ACP allow content";
    const writePrompt = `${WRITE_FILE_PREFIX}${JSON.stringify({ path: allowFilePosix, content: expectedContent })}`;

    let sawPermissionRequest = false;
    const { finalEvent, collected } = await client.drivePrompt(acpSessionId, writePrompt, {
      onPermission: async (ev) => {
        sawPermissionRequest = true;
        log(`       [acp] 收到 permission-request: tool=${ev.toolName}, desc=${ev.description ?? "(無)"}`);
        return "allow";
      },
      timeoutMs: 20_000,
    });

    const toolCallIdx = collected.findIndex((e) => e.event.type === "tool-call");
    const toolResultIdx = collected.findIndex((e) => e.event.type === "tool-result");
    const sawToolCall = toolCallIdx !== -1;
    const sawToolResult = toolResultIdx !== -1;
    const toolCallBeforeResult = sawToolCall && sawToolResult && toolCallIdx < toolResultIdx;
    const completedOk = finalEvent.event.type === "completed";
    const fileExists = existsSync(allowFile);
    const fileContent = fileExists ? readFileSync(allowFile, "utf8") : undefined;
    const contentOk = fileContent === expectedContent;

    record(
      "步驟9c ACP 權限 allow 路徑(tool-call → permission-request → tool-result,實際寫入檔案)",
      sawPermissionRequest && sawToolCall && sawToolResult && toolCallBeforeResult && completedOk && fileExists && contentOk,
      `permission-request=${sawPermissionRequest}, tool-call=${sawToolCall}(idx=${toolCallIdx}), tool-result=${sawToolResult}(idx=${toolResultIdx}), toolCallBeforeResult=${toolCallBeforeResult}, completed=${completedOk}, fileExists=${fileExists}, content=${JSON.stringify(fileContent)}`,
    );

    // ---- 9c-diff: 同一輪 tool-result 事件驗證 diff 顯示路徑 B(檔案快照
    // fallback,Codex ACP 橋接切換 Phase 3)—— handleWriteFile() 的 tool_call
    // 帶 kind:"edit"+locations,但 tool_call_update 完成時不附帶原生
    // type:"diff" 內容區塊(見 scripts/fake-acp-agent.mjs),AcpAdapter 必須
    // 靠自己在呼叫前後各讀一次檔案合成 structuredResult。這個檔案在呼叫前
    // 不存在,預期是一個「全新檔案」的全綠 hunk。 ----
    const toolResultEvent = sawToolResult ? collected[toolResultIdx].event : undefined;
    const diffSummary = summarizeStructuredPatch(toolResultEvent?.structuredResult);
    const diffPathOk = diffSummary?.filePath === allowFilePosix;
    const diffContentOk = diffSummary !== undefined && diffSummary.added.join("\n") === expectedContent && diffSummary.removed.length === 0;
    record(
      "步驟9c-diff ACP diff 顯示路徑 B(檔案快照 fallback):沒有原生 diff 區塊時 AcpAdapter 自行讀檔前後合成 structuredResult",
      diffSummary !== undefined && diffPathOk && diffContentOk,
      `structuredResult=${JSON.stringify(toolResultEvent?.structuredResult)}, 解析結果=${JSON.stringify(diffSummary)}, path 是否符合=${diffPathOk}, 內容是否符合(全新檔案、僅新增 ${JSON.stringify(expectedContent)})=${diffContentOk}`,
    );
  } catch (err) {
    record("步驟9c ACP 權限 allow 路徑", false, String(err));
  }

  // ---- 9d: 觸發寫檔 + permission deny ----
  try {
    const denyFile = path.join(workspaceDir, "acp-deny.txt");
    const denyFilePosix = denyFile.split(path.sep).join("/");
    const writePrompt = `${WRITE_FILE_PREFIX}${JSON.stringify({ path: denyFilePosix, content: "should not exist" })}`;

    let sawPermissionRequest = false;
    const { finalEvent, collected } = await client.drivePrompt(acpSessionId, writePrompt, {
      onPermission: async (ev) => {
        sawPermissionRequest = true;
        log(`       [acp] 收到 permission-request: tool=${ev.toolName}, desc=${ev.description ?? "(無)"}`);
        return "deny";
      },
      timeoutMs: 20_000,
    });

    const sawToolResult = collected.some((e) => e.event.type === "tool-result");
    const fileNotExists = !existsSync(denyFile);
    const completedOk = finalEvent.event.type === "completed";

    record(
      "步驟9d ACP 權限 deny 路徑(不寫檔、無 tool-result,正常 completed 結束該輪)",
      sawPermissionRequest && !sawToolResult && fileNotExists && completedOk,
      `permission-request=${sawPermissionRequest}, tool-result=${sawToolResult}, 檔案未建立=${fileNotExists}, 最終事件=${finalEvent.event.type}`,
    );
  } catch (err) {
    record("步驟9d ACP 權限 deny 路徑", false, String(err));
  }

  // ---- 9d2: diff 顯示路徑 A(原生 diff 內容區塊,Codex ACP 橋接切換 Phase 3)----
  try {
    const diffFilePosix = path.join(workspaceDir, "acp-diff-a.txt").split(path.sep).join("/");
    const oldText = "line1\nline2\nline3\n";
    const newText = "line1\nCHANGED\nline3\n";
    const diffPrompt = `${DIFF_CONTENT_PREFIX}${JSON.stringify({ path: diffFilePosix, oldText, newText })}`;

    const { finalEvent, collected } = await client.drivePrompt(acpSessionId, diffPrompt, {
      onPermission: async () => "deny", // 這個情境不觸發 session/request_permission
      timeoutMs: 20_000,
    });

    const toolResultIdx = collected.findIndex((e) => e.event.type === "tool-result");
    const sawToolResult = toolResultIdx !== -1;
    const completedOk = finalEvent.event.type === "completed";
    const toolResultEvent = sawToolResult ? collected[toolResultIdx].event : undefined;
    const diffSummary = summarizeStructuredPatch(toolResultEvent?.structuredResult);
    const diffPathOk = diffSummary?.filePath === diffFilePosix;
    // 對應 oldText/newText 的字面差異:第 2 行從 "line2" 換成 "CHANGED",
    // 第 1/3 行不變——預期恰好一個新增行、一個刪除行,不多不少。
    const diffContentOk =
      diffSummary !== undefined &&
      diffSummary.added.length === 1 &&
      diffSummary.added[0] === "CHANGED" &&
      diffSummary.removed.length === 1 &&
      diffSummary.removed[0] === "line2";

    record(
      "步驟9d2 ACP diff 顯示路徑 A(原生 ToolCallContent 的 type:\"diff\" 區塊,不觸碰真實檔案系統)",
      sawToolResult && completedOk && diffSummary !== undefined && diffPathOk && diffContentOk,
      `tool-result=${sawToolResult}, 完成=${completedOk}, structuredResult=${JSON.stringify(toolResultEvent?.structuredResult)}, 解析結果=${JSON.stringify(diffSummary)}, path 是否符合=${diffPathOk}, 內容是否符合(+CHANGED/-line2)=${diffContentOk}`,
    );
  } catch (err) {
    record("步驟9d2 ACP diff 顯示路徑 A", false, String(err));
  }

  // ---- 9e: 清理 ----
  try {
    await client.rpc("session.delete", { sessionId: acpSessionId });
    const listAfter = await client.rpc("session.list", {});
    const stillThere = listAfter.sessions.some((s) => s.id === acpSessionId);
    record("步驟9e ACP session.delete 清理成功(子程序與連線一併結束)", !stillThere, `刪除後 session.list 是否仍含此 session: ${stillThere}`);
  } catch (err) {
    record("步驟9e ACP session.delete 清理成功", false, String(err));
  }
}

/**
 * 等待某個 session 累積收到的 terminal-data 事件(依 client.events 陣列出現
 * 順序串接)符合 predicate(整段已收集文字)。做法比照 GatewayClient.drivePrompt
 * 對 events 陣列的 cursor 掃描方式,但判斷條件是「累積文字是否符合」而不是
 * 「單一事件的 type」—— pty 沒有回合邊界,不能沿用 drivePrompt。
 */
async function waitForTerminalText(client, sessionId, predicate, timeoutMs) {
  let combined = client.events
    .filter((e) => e.sessionId === sessionId && e.event.type === "terminal-data")
    .map((e) => e.event.data)
    .join("");
  if (predicate(combined)) return combined;

  let cursor = client.events.length;
  const deadline = Date.now() + timeoutMs;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`等待 terminal-data 內容逾時,目前已收集內容: ${JSON.stringify(combined)}`);
    }
    const ev = await client.waitForEvent(
      (e) => e.sessionId === sessionId && e.event.type === "terminal-data",
      remaining,
      cursor,
    );
    cursor = client.events.indexOf(ev) + 1;
    combined += ev.event.data;
    if (predicate(combined)) return combined;
  }
}

/**
 * 等待某個 session 收到一則 message-delta 事件,其 delta 內含指定子字串
 * (M3 Round A 步驟 12 用:fake ACP agent 的 DELAY_ECHO 回顯是單一 chunk,
 * 不需要像 waitForTerminalText 那樣累積多個片段)。用 substring 而不是
 * exact match,因為 MessageBus 注入時會在原始內容外包一層「來自 @X(角色)
 * 的訊息:」的格式化文字。
 */
async function waitForMessageContaining(client, sessionId, substring, timeoutMs) {
  return client.waitForEvent(
    (e) =>
      e.sessionId === sessionId &&
      e.event.type === "message-delta" &&
      typeof e.event.delta === "string" &&
      e.event.delta.includes(substring),
    timeoutMs,
  );
}

// ---------------------------------------------------------------------
// 步驟 12: MessageBus(M3 Round A,決定性測試,不依賴外部模型)
//
// 用兩個(後面再加一個)software="acp" 的 fake-acp-agent 成員組成一個 team,
// 全程透過 gateway 的 team.*/message.send 方法測試 MessageBus 的投遞策略
// (ARCHITECTURE.md 4.2 節):idle 立即注入、busy 排隊 + completed 後批次
// 注入、priority=interrupt 的 canInterrupt 權限檢查、無活躍 session 時留在
// Mailbox 並在 session 建立後補投。fake-acp-agent.mjs 的 DELAY_ECHO 標記
// (delayEchoMarker())讓它把「完整收到的 prompt」加上 "ECHO:" 前綴延遲回顯,
// 藉此驗證 MessageBus 注入的 prompt 確實送達,並用可控延遲製造 busy 視窗 ——
// 全程不叫任何真實模型,結果應為 100% 決定性。
// ---------------------------------------------------------------------
async function messageBusSmokeTest(client, workspaceDir) {
  const fakeAgentPath = path.join(REPO_ROOT, "scripts", "fake-acp-agent.mjs");
  const makeAcpProfileInput = (name) => ({
    name,
    software: "acp",
    workingDir: workspaceDir,
    acpConfig: { command: process.execPath, args: [fakeAgentPath] },
  });

  let teamId;
  let coderProfileId;
  let reviewerProfileId;
  let coderMemberId;
  let reviewerMemberId;
  let coderSessionId;
  let reviewerSessionId;
  let qaSessionId;

  // ---- 12a: 建 team + 兩個 acp fake-agent 成員與各自的 session ----
  try {
    const team = await client.rpc("team.create", { name: "E2E MessageBus Team" });
    teamId = team.team.id;

    const coderProfile = await client.rpc("profile.create", makeAcpProfileInput("E2E Bus Coder"));
    const reviewerProfile = await client.rpc("profile.create", makeAcpProfileInput("E2E Bus Reviewer"));
    coderProfileId = coderProfile.profile.id;
    reviewerProfileId = reviewerProfile.profile.id;

    const coderMember = await client.rpc("team.addMember", {
      teamId,
      agentProfileId: coderProfileId,
      name: "Coder",
      role: "Coder",
      canInterrupt: false,
    });
    const reviewerMember = await client.rpc("team.addMember", {
      teamId,
      agentProfileId: reviewerProfileId,
      name: "Reviewer",
      role: "Reviewer",
      canInterrupt: true,
    });
    coderMemberId = coderMember.member.id;
    reviewerMemberId = reviewerMember.member.id;

    const coderSession = await client.rpc(
      "session.create",
      { agentProfileId: coderProfileId, workingDir: workspaceDir, title: "e2e-bus-coder", teamMemberId: coderMemberId },
      30_000,
    );
    const reviewerSession = await client.rpc(
      "session.create",
      {
        agentProfileId: reviewerProfileId,
        workingDir: workspaceDir,
        title: "e2e-bus-reviewer",
        teamMemberId: reviewerMemberId,
      },
      30_000,
    );
    coderSessionId = coderSession.session.id;
    reviewerSessionId = reviewerSession.session.id;

    record(
      "步驟12a 建立 team + 兩個 acp fake-agent 成員與各自的 session(teamMemberId 綁定)",
      true,
      `teamId=${teamId}, coderMemberId=${coderMemberId}, reviewerMemberId=${reviewerMemberId}, coderSessionId=${coderSessionId}, reviewerSessionId=${reviewerSessionId}`,
    );
  } catch (err) {
    record("步驟12a 建立 team + 兩個 acp fake-agent 成員與各自的 session", false, String(err));
    return;
  }

  // ---- 12b: idle 成員立即注入 ----
  try {
    const content = `idle-test-${randomUUID()} ${delayEchoMarker(0)}`;
    const sendResult = await client.rpc("message.send", { teamId, to: "Coder", content, fromName: "Tester" });

    const ev = await waitForMessageContaining(client, coderSessionId, content, 15_000);
    const echoed = ev.event.delta;
    const wrapperOk = echoed.includes("來自 @Tester") && echoed.includes(content);
    // 2026-08-28:注入的 prompt 會附一句「回覆指引」。收訊者是 acp(有掛
    // team-bus 工具,見 SOFTWARE_WITH_TEAM_BUS),且發送者是人類(沒有對應的
    // TeamMember 可以被 send_message 指名),所以應該指引它用 broadcast——
    // 且**不可**出現「沒有團隊訊息工具」那句(那是給 opencode/pty 的,見 12f)。
    const replyHintOk = echoed.includes("broadcast") && !echoed.includes("沒有團隊訊息工具");

    const historyResult = await client.rpc("team.messages", { teamId });
    const persisted = historyResult.messages.find((m) => m.content === content);

    record(
      "步驟12b MessageBus:idle 成員立即以 prompt 注入(fake ACP agent 回顯驗證確實收到),且附上正確的回覆指引(acp 有 team-bus 工具 → 指引用 broadcast)",
      sendResult.delivered === "immediate" && wrapperOk && replyHintOk && Boolean(persisted) && persisted?.to === "Coder",
      `delivered=${sendResult.delivered}, replyHintOk=${replyHintOk}, echoed=${JSON.stringify(echoed)}, persisted=${JSON.stringify(persisted)}`,
    );
  } catch (err) {
    record("步驟12b MessageBus:idle 成員立即以 prompt 注入", false, String(err));
  }

  // ---- 12c: busy 成員排隊,completed 後批次合併注入 ----
  try {
    // 先讓 Reviewer 忙碌:直接送一個延遲 2500ms 才回覆的 prompt(不經過 bus),
    // session.sendPrompt 的 RPC 回應前就已經把狀態切成 busy(見
    // SessionManager.sendPrompt:persist + setStatus("busy") 都在 RPC 回應前 await 完)。
    const primeMarker = delayEchoMarker(2500);
    await client.rpc("session.sendPrompt", { sessionId: reviewerSessionId, prompt: { text: `priming ${primeMarker}` } });

    const msg1Content = `queued-1-${randomUUID()} ${delayEchoMarker(0)}`;
    const msg2Content = `queued-2-${randomUUID()} ${delayEchoMarker(0)}`;
    const send1 = await client.rpc("message.send", { teamId, to: "Reviewer", content: msg1Content, fromName: "Tester" });
    const send2 = await client.rpc("message.send", { teamId, to: "Reviewer", content: msg2Content, fromName: "Tester" });
    const queuedOk = send1.delivered === "queued" && send2.delivered === "queued";

    // 等 priming 那輪完成(~2.5s)、MessageBus 偵測到 idle 後應該批次注入上面
    // 兩則排隊訊息成單一 prompt,fake agent 會把整段批次 prompt 回顯。
    const batchEvent = await waitForMessageContaining(client, reviewerSessionId, msg2Content, 15_000);
    const batchText = batchEvent.event.delta;
    const batchOk = batchText.includes(msg1Content) && batchText.includes(msg2Content);

    record(
      "步驟12c MessageBus:busy 成員排隊(mailbox),回合 completed 轉 idle 後批次合併成單一 prompt 注入",
      queuedOk && batchOk,
      `send1.delivered=${send1.delivered}, send2.delivered=${send2.delivered}, batchText 片段=${JSON.stringify(batchText.slice(0, 220))}`,
    );
  } catch (err) {
    record("步驟12c MessageBus:busy 成員排隊,completed 後批次合併注入", false, String(err));
  }

  // ---- 12d: priority=interrupt 的 canInterrupt 權限檢查 ----
  try {
    // Coder(canInterrupt=false)嘗試 interrupt → 應被降級為 normal 並標註。
    const downgradeContent = `interrupt-downgrade-${randomUUID()} ${delayEchoMarker(0)}`;
    const downgradeResult = await client.rpc("message.send", {
      teamId,
      to: "Reviewer",
      content: downgradeContent,
      priority: "interrupt",
      fromName: "Coder",
    });

    // Reviewer(canInterrupt=true)使用 interrupt → 應維持 interrupt,不降級。
    const allowContent = `interrupt-allowed-${randomUUID()} ${delayEchoMarker(0)}`;
    const allowResult = await client.rpc("message.send", {
      teamId,
      to: "Coder",
      content: allowContent,
      priority: "interrupt",
      fromName: "Reviewer",
    });

    const downgradeOk =
      downgradeResult.downgraded === true &&
      downgradeResult.message.priority === "normal" &&
      typeof downgradeResult.message.note === "string" &&
      downgradeResult.message.note.includes("canInterrupt=false");
    const allowOk = allowResult.downgraded === false && allowResult.message.priority === "interrupt";

    record(
      "步驟12d MessageBus:priority=interrupt 權限檢查(canInterrupt=false 自動降級為 normal 並標註;canInterrupt=true 維持 interrupt)",
      downgradeOk && allowOk,
      `downgrade: downgraded=${downgradeResult.downgraded}, priority=${downgradeResult.message.priority}, note=${JSON.stringify(downgradeResult.message.note)}; allow: downgraded=${allowResult.downgraded}, priority=${allowResult.message.priority}`,
    );
  } catch (err) {
    record("步驟12d MessageBus:priority=interrupt 權限檢查", false, String(err));
  }

  // ---- 12e: 目標成員沒有活躍 session 時留在 Mailbox,session 建立後自動補投 ----
  try {
    const qaProfile = await client.rpc("profile.create", makeAcpProfileInput("E2E Bus QA"));
    const qaMember = await client.rpc("team.addMember", {
      teamId,
      agentProfileId: qaProfile.profile.id,
      name: "QA",
      role: "QA",
      canInterrupt: false,
    });

    const noSessionContent = `no-session-${randomUUID()} ${delayEchoMarker(0)}`;
    const noSessionResult = await client.rpc("message.send", {
      teamId,
      to: "QA",
      content: noSessionContent,
      fromName: "Tester",
    });

    const qaSession = await client.rpc(
      "session.create",
      { agentProfileId: qaProfile.profile.id, workingDir: workspaceDir, title: "e2e-bus-qa", teamMemberId: qaMember.member.id },
      30_000,
    );
    qaSessionId = qaSession.session.id;

    const flushedEvent = await waitForMessageContaining(client, qaSessionId, noSessionContent, 15_000);

    record(
      "步驟12e MessageBus:目標成員沒有活躍 session 時留在 Mailbox,session 建立後自動補投",
      noSessionResult.delivered === "no-session" && Boolean(flushedEvent),
      `delivered=${noSessionResult.delivered}, 補投內容片段=${JSON.stringify((flushedEvent?.event.delta ?? "").slice(0, 200))}`,
    );
  } catch (err) {
    record("步驟12e MessageBus:目標成員沒有活躍 session 時留在 Mailbox,session 建立後自動補投", false, String(err));
  }

  // ---- 12f: 回覆指引依收訊者的 software 而變(2026-08-28,使用者實測回報)----
  // 12b 已驗證正向情境(acp,有掛 team-bus → 指引呼叫 broadcast)。這裡驗證
  // **負向**情境:software="pty" 的成員架構上沒有任何工具通道(見
  // packages/adapters/src/pty-adapter.ts 檔頭),絕不能叫它去呼叫不存在的
  // 工具——否則它會反覆嘗試然後困惑地卡住(這正是這輪要修的真實問題)。
  // 用既有的 fake-pty-echo.mjs(步驟10 的同一支)把注入的 prompt 回顯出來,
  // 走 terminal-data 事件斷言,不依賴任何真實模型行為。
  let ptyBusSessionId;
  try {
    const ptyBusProfile = await client.rpc("profile.create", {
      name: "E2E Bus PTY Member",
      software: "pty",
      workingDir: workspaceDir,
      ptyConfig: { command: process.execPath, args: [path.join(REPO_ROOT, "scripts", "fake-pty-echo.mjs")] },
    });
    const ptyMember = await client.rpc("team.addMember", {
      teamId,
      agentProfileId: ptyBusProfile.profile.id,
      name: "PtyMember",
      role: "Coder",
      canInterrupt: false,
    });
    const ptySession = await client.rpc(
      "session.create",
      {
        agentProfileId: ptyBusProfile.profile.id,
        workingDir: workspaceDir,
        title: "e2e-bus-pty",
        teamMemberId: ptyMember.member.id,
      },
      30_000,
    );
    ptyBusSessionId = ptySession.session.id;

    await waitForTerminalText(client, ptyBusSessionId, (buf) => buf.includes("READY"), 15_000);

    const ptyContent = `pty-hint-${randomUUID().slice(0, 8)}`;
    await client.rpc("message.send", { teamId, to: "PtyMember", content: ptyContent, fromName: "Tester" });

    const terminalBuf = await waitForTerminalText(
      client,
      ptyBusSessionId,
      (buf) => buf.includes(ptyContent),
      15_000,
    );
    // 訊息本體照樣送達(pty 成員仍然收得到訊息,只是回不了話),但指引必須是
    // 「沒有工具」那句,且**絕不能**出現叫它呼叫 broadcast/send_message 的字樣。
    const contentDelivered = terminalBuf.includes(ptyContent);
    const saysNoTools = terminalBuf.includes("沒有團隊訊息工具");
    const noToolInstruction = !terminalBuf.includes("回覆請呼叫");

    record(
      "步驟12f MessageBus:回覆指引依收訊者 software 而變——pty 成員(架構上沒有工具通道)收到的是「沒有團隊訊息工具」的如實告知,不會被叫去呼叫不存在的工具",
      contentDelivered && saysNoTools && noToolInstruction,
      `contentDelivered=${contentDelivered}, saysNoTools=${saysNoTools}, noToolInstruction=${noToolInstruction}, ` +
        `terminal=${JSON.stringify(terminalBuf.slice(-400))}`,
    );
  } catch (err) {
    record("步驟12f MessageBus:回覆指引依收訊者 software 而變(pty 負向情境)", false, String(err));
  }

  // ---- 12g: 清理 ----
  const createdSessions = [coderSessionId, reviewerSessionId, qaSessionId, ptyBusSessionId].filter(Boolean);
  try {
    for (const sid of createdSessions) {
      try {
        await client.rpc("session.delete", { sessionId: sid });
      } catch (err) {
        log(`[cleanup] 刪除步驟12 session(${sid})時發生錯誤(忽略): ${err}`);
      }
    }
    const listAfter = await client.rpc("session.list", {});
    const stillThere = createdSessions.filter((sid) => listAfter.sessions.some((s) => s.id === sid));
    record(
      "步驟12g MessageBus 測試清理 session",
      stillThere.length === 0,
      `已嘗試刪除 ${createdSessions.length} 個 session,刪除後仍存在: ${JSON.stringify(stillThere)}`,
    );
  } catch (err) {
    record("步驟12f MessageBus 測試清理 session", false, String(err));
  }
}

// ---------------------------------------------------------------------
// 步驟 13: team-bus MCP 工具(M3 Round A,真實模型,允許軟性判定 —— 比照
// 步驟 5 的處理方式:模型偶發不呼叫工具視為已知 flake,如實記錄)
//
// 建一個含 Claude SDK 成員的 team,要求模型呼叫 send_message MCP 工具傳訊給
// "Reviewer",斷言 team_messages 出現該訊息且 to/content 正確。Reviewer 不
// 需要真的建立 session(send_message 只要求對方是已知的 team member 名稱),
// 這樣可以只驗證「工具呼叫 → MessageBus.sendMessage() → 落地 team_messages」
// 這條路徑,不受第二個 session 的模型行為影響。
// ---------------------------------------------------------------------
async function teamBusMcpToolSmokeTest(client, workspaceDir, defaultProfile) {
  let teamId;
  let coderSessionId;
  let repoDir;
  let taskId;
  const FIXED_TEXT = `STATUS_UPDATE_${randomUUID().slice(0, 8)}`;

  try {
    // S2(message-budget)L4 §2:send_message 現在需要發送者當下綁定一個進行中
    // 任務(assigned/in-progress/review/merging)才能推導出 contextId,否則
    // 一律拒收(見 apps/core/src/bus/message-bus.ts 的 `deriveContextId()`)。
    // 這個 team 需要真的 git repo 當 workingDir 才能 task.assign(比照步驟15a
    // 的既有先例,見上方 `runGitSync`/`taskWorkspaceSmokeTest`),否則13b(即使
    // 模型真的呼叫了 send_message)會被 contextId 推導拒收,把「已知 flake」
    // 變成「保證失敗」。
    const gitVersion = runGitSync(["--version"], process.cwd());
    if (gitVersion.status !== 0) {
      record("步驟13a(git 不可用,整個步驟略過)", false, `找不到可用的 git 執行檔: ${gitVersion.error ?? gitVersion.stderr}`);
      return;
    }
    repoDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-mcp-team-"));
    runGitSync(["init"], repoDir);
    runGitSync(["config", "user.email", "e2e@deskmony.local"], repoDir);
    runGitSync(["config", "user.name", "Deskmony E2E"], repoDir);
    writeFileSync(path.join(repoDir, "README.md"), "# e2e team-bus mcp repo\n", "utf8");
    runGitSync(["add", "."], repoDir);
    runGitSync(["commit", "-m", "initial commit"], repoDir);

    const team = await client.rpc("team.create", { name: "E2E MCP Team", workingDir: repoDir });
    teamId = team.team.id;

    // S8(agent-lifecycle):role="Coder" 預設推導為 lifecycle="ephemeral",而
    // ephemeral 成員被 `task.assign` 指派時 `TaskService.assignTask()` 會**自動
    // spawn 一個 session**(cwd = 剛建立的 worktree)。這個測試緊接著又自己
    // `session.create` 了一個掛在同一個 memberId 上的 session —— 於是同一個成員
    // 身上有兩個 session,但 `SessionManager.memberSessions` 是
    // `Map<memberId, sessionId>`(一個成員只記得住一個),後建立的把自動 spawn
    // 的那個蓋掉了。結果是收尾時 `task.delete` → `disposeSessionForMember()`
    // 只 dispose 得到後者,自動 spawn 的那個 session 沒人管、繼續佔住 worktree,
    // `git worktree remove` 失敗,worktree 每跑一次就殘留一份。
    // 明確指定 persistent 讓 assignTask() 略過自動 spawn(見
    // agent-lifecycle_detail.md §2.1「persistent:不做任何事」),回到「這個測試
    // 只需要一個自己建立的 session」的原意——比照步驟16 與 e2e-message-budget
    // 測試 B 的既有先例。這個測試要驗證的是 team-bus MCP 工具與 contextId 推導,
    // 與 lifecycle 無關。
    const coderMember = await client.rpc("team.addMember", {
      teamId,
      agentProfileId: defaultProfile.id,
      name: "Coder",
      role: "Coder",
      canInterrupt: false,
      lifecycle: "persistent",
    });
    await client.rpc("team.addMember", {
      teamId,
      agentProfileId: defaultProfile.id,
      name: "Reviewer",
      role: "Reviewer",
      canInterrupt: false,
    });

    // 建一個任務並指派給 coderMember(assigned 狀態,落在 §2「推導規則」允許
    // 的狀態集合內),讓 send_message/broadcast 的 contextId 能被推導出來。
    const task = await client.rpc("task.create", { teamId, title: "E2E MCP Task" });
    taskId = task.task.id; // 收尾要 task.delete 掉它才會清掉 worktree,見下方 cleanup 區塊
    await client.rpc("task.assign", { taskId, memberId: coderMember.member.id });

    const coderSession = await client.rpc(
      "session.create",
      {
        agentProfileId: defaultProfile.id,
        workingDir: workspaceDir,
        title: "e2e-mcp-coder",
        teamMemberId: coderMember.member.id,
      },
      30_000,
    );
    coderSessionId = coderSession.session.id;

    record(
      "步驟13a 建立含 Claude SDK 成員的 team + session(ClaudeAgentSdkAdapter 掛載 team-bus MCP)+ 指派任務(S2 contextId 推導所需)",
      true,
      `teamId=${teamId}, sessionId=${coderSessionId}, taskId=${taskId}`,
    );
  } catch (err) {
    record("步驟13a 建立含 Claude SDK 成員的 team + session", false, String(err));
    return;
  }

  // 13b:model-behavior —— 直接斷言「模型是否選擇呼叫 send_message 工具」,
  // 是模型的自由選擇,已知 flake(比照步驟5)。--only=deterministic 時整個
  // 跳過(不送出這個 prompt,不消耗一輪真實模型呼叫);13a 建立的 team/session
  // 仍會在 finally 被清理。
  if (shouldRun("model-behavior")) {
    try {
      const prompt =
        `請直接呼叫你被授予的 send_message 這個 MCP 工具(不要用其他方式、不要先說明、不要詢問我任何問題):` +
        `參數 to 設為 "Reviewer"、content 必須完全等於(不要加任何多餘文字或標點):${FIXED_TEXT}`;

      await client.drivePrompt(coderSessionId, prompt, {
        onPermission: async () => "allow", // team-bus 工具在 allowedTools 內,理論上不會觸發權限請求
        timeoutMs: 60_000,
      });

      // drivePrompt 收到 completed 時,工具呼叫(含 MessageBus.sendMessage 的
      // DB 寫入)理論上已在同一輪內完成,保守起見仍 poll 一小段時間。
      const deadline = Date.now() + 15_000;
      let found;
      while (Date.now() < deadline && !found) {
        const history = await client.rpc("team.messages", { teamId });
        found = history.messages.find((m) => m.to === "Reviewer" && m.content === FIXED_TEXT);
        if (!found) await sleep(500);
      }

      record(
        "步驟13b 模型實際呼叫 send_message 工具,team_messages 出現正確的 to/content(軟性判定,見下方 detail)",
        Boolean(found),
        found
          ? `已找到: ${JSON.stringify(found)}`
          : `逾時未在 team_messages 找到 to="Reviewer" content="${FIXED_TEXT}" 的訊息 —— 若模型這輪選擇不呼叫 send_message 工具屬已知 flake(比照步驟5的軟性判定),非 regression`,
        "model-behavior",
      );
    } catch (err) {
      record("步驟13b 模型實際呼叫 send_message 工具,team_messages 出現正確的 to/content", false, String(err), "model-behavior");
    }
  } else {
    skipNote("步驟13b 模型實際呼叫 send_message 工具", "model-behavior");
  }
  {
    // task.delete 要排在 session.delete 之前:任務指派給的是一個 lifecycle
    // 預設為 "ephemeral" 的成員,`TaskService.deleteTask()` 會先 dispose 該
    // 成員的 session、再由 WorkspaceManager 移除 worktree —— 這是唯一會清掉
    // worktree 的路徑。少了這一步,worktree 會留在
    // `<tmpdir>/.deskmony-worktrees/` 底下(它不在 repoDir 底下,見
    // apps/core/src/workspace/workspace-manager.ts 的 `createWorkspaceForTask()`),
    // 下面那個 rmSync(repoDir) 掃不到,每跑一次 e2e 就多積一份殘留。
    if (taskId) {
      try {
        await client.rpc("task.delete", { taskId });
      } catch (err) {
        log(`[cleanup] 刪除步驟13 任務(含 worktree)時發生錯誤(忽略): ${err}`);
      }
    }
    if (coderSessionId) {
      try {
        await client.rpc("session.delete", { sessionId: coderSessionId });
      } catch (err) {
        log(`[cleanup] 刪除步驟13 session 時發生錯誤(忽略): ${err}`);
      }
    }
    if (repoDir) {
      try {
        rmSync(repoDir, { recursive: true, force: true });
      } catch (err) {
        log(`[cleanup] 刪除步驟13 repoDir 時發生錯誤(忽略): ${err}`);
      }
    }
  }
}

// ---------------------------------------------------------------------
// 步驟 10: GenericPtyAdapter(fake pty echo,決定性測試,不依賴外部模型)
// ---------------------------------------------------------------------
async function ptyAdapterSmokeTest(client, workspaceDir) {
  const fakeEchoPath = path.join(REPO_ROOT, "scripts", "fake-pty-echo.mjs");
  let ptyProfile;
  let ptySessionId;

  // ---- 10a: capabilities 正確 + 建立 profile/session ----
  try {
    const capsResult = await client.rpc("adapter.capabilities", { software: "pty" });
    const caps = capsResult.capabilities;
    const capsOk =
      caps.streaming === false &&
      caps.toolEvents === false &&
      caps.permissionRequests === false &&
      caps.diff === false &&
      caps.interrupt === true &&
      caps.terminal === true;

    const created = await client.rpc("profile.create", {
      name: "E2E Fake PTY Agent",
      software: "pty",
      workingDir: workspaceDir,
      ptyConfig: { command: process.execPath, args: [fakeEchoPath] },
    });
    ptyProfile = created.profile;

    const sessionCreated = await client.rpc(
      "session.create",
      { agentProfileId: ptyProfile.id, workingDir: workspaceDir, title: "e2e-pty-smoke" },
      30_000,
    );
    ptySessionId = sessionCreated.session.id;

    record(
      "步驟10a GenericPtyAdapter capabilities 正確(terminal:true,其餘 false/interrupt:true)+ 建立 software=\"pty\" 的 profile/session",
      capsOk,
      `capabilities=${JSON.stringify(caps)}, profileId=${ptyProfile.id}, sessionId=${ptySessionId}`,
    );
  } catch (err) {
    record(
      "步驟10a GenericPtyAdapter capabilities 正確 + 建立 software=\"pty\" 的 profile/session",
      false,
      String(err),
    );
    return; // 沒有 session 就無法跑後續子步驟
  }

  // ---- 10b: sendPrompt 寫入一行文字 → terminal-data 事件正確回顯,靜止一段時間後自動轉回 idle ----
  try {
    await waitForTerminalText(client, ptySessionId, (buf) => buf.includes("READY"), 15_000);
    await client.rpc("session.sendPrompt", { sessionId: ptySessionId, prompt: { text: "hello-from-e2e" } });
    const combined = await waitForTerminalText(
      client,
      ptySessionId,
      (buf) => buf.includes("ECHO:hello-from-e2e"),
      15_000,
    );

    // PTY_IDLE_TIMEOUT_MS(apps/core/src/session/session-manager.ts)= 800ms,
    // 多等一段緩衝時間讓 SessionManager 的靜止計時器確實觸發。
    await sleep(1500);
    const listAfter = await client.rpc("session.list", {});
    const session = listAfter.sessions.find((s) => s.id === ptySessionId);

    record(
      "步驟10b pty sendPrompt → terminal-data 事件正確回顯 ECHO:,靜止後 SessionManager 自動轉回 idle",
      combined.includes("ECHO:hello-from-e2e") && session?.status === "idle",
      `session 狀態=${session?.status}, 收集內容片段=${JSON.stringify(combined.slice(-120))}`,
    );
  } catch (err) {
    record(
      "步驟10b pty sendPrompt → terminal-data 事件正確回顯,靜止後自動轉回 idle",
      false,
      String(err),
    );
  }

  // ---- 10c: interrupt() 送出 Ctrl+C(\x03),驗證子程序真的收到 SIGINT ----
  try {
    client.rpc("session.interrupt", { sessionId: ptySessionId }).catch(() => {});
    const combined = await waitForTerminalText(
      client,
      ptySessionId,
      (buf) => buf.includes("SIGINT-RECEIVED"),
      10_000,
    );
    record(
      "步驟10c pty interrupt() 送出 Ctrl+C(\\x03),子程序收到 SIGINT",
      combined.includes("SIGINT-RECEIVED"),
      `收集內容片段=${JSON.stringify(combined.slice(-120))}`,
    );
  } catch (err) {
    record("步驟10c pty interrupt() 送出 Ctrl+C(\\x03),子程序收到 SIGINT", false, String(err));
  }

  // ---- 10d: 子程序自行結束("exit")→ GenericPtyAdapter 送出 completed(exitCode=0) ----
  try {
    const startIdx = client.events.length;
    await client.rpc("session.sendPrompt", { sessionId: ptySessionId, prompt: { text: "exit" } });
    const finalEvent = await client.waitForEvent(
      (e) => e.sessionId === ptySessionId && (e.event.type === "completed" || e.event.type === "error"),
      15_000,
      startIdx,
    );
    record(
      "步驟10d pty 子程序自行 exit(exitCode=0)→ GenericPtyAdapter 送出 completed 事件並關閉 outputQueue",
      finalEvent.event.type === "completed",
      `最終事件=${finalEvent.event.type}`,
    );
  } catch (err) {
    record(
      "步驟10d pty 子程序自行 exit → GenericPtyAdapter 送出 completed(exitCode=0)",
      false,
      String(err),
    );
  }

  // ---- 10e: 清理 ----
  try {
    await client.rpc("session.delete", { sessionId: ptySessionId });
    const listAfter = await client.rpc("session.list", {});
    const stillThere = listAfter.sessions.some((s) => s.id === ptySessionId);
    record(
      "步驟10e pty session.delete 清理成功(GenericPtyAdapter.dispose 結束子程序)",
      !stillThere,
      `刪除後 session.list 是否仍含此 session: ${stillThere}`,
    );
  } catch (err) {
    record("步驟10e pty session.delete 清理成功", false, String(err));
  }
}

// ---------------------------------------------------------------------
// 步驟 24: OpenCodeAdapter(fake opencode server,決定性測試,不依賴真實
// opencode 執行檔、不依賴任何模型)
//
// 修復「opencode 只是把 TUI 塞進終端視圖」的問題:這輪補上 OpenCodeAdapter
// (packages/adapters/src/opencode-adapter.ts,HTTP + SSE 對接 opencode 的
// headless server API)。用 scripts/fake-opencode-server.mjs 當作
// software="opencode" 的 AgentProfile 啟動目標(node:http 實作與真實
// opencode serve 相同形狀的端點/SSE 事件,見該檔案頂端註解),驗證:
//   - AdapterRegistry 依 profile.software="opencode" 選到 OpenCodeAdapter、
//     capabilities() 據實回報。
//   - message.part.updated/message.part.delta → message-delta 轉換正確
//     (分組/done)、session.idle → completed。
//   - tool 呼叫 + permission.asked → allow/deny 兩條路徑(tool-call/
//     tool-result 事件轉換,比照步驟9c/9d 的 ACP 先例)。
//   - interrupt() 送出 /session/{id}/abort 後,原本忙碌中的回合確實收斂
//     (不會永久卡住),且 MessageAbortedError 不會被誤轉成 error 事件。
//   - session.setModel 對話中切換 model(這輪補上 OpenCodeAdapter.setModel()
//     的實作,見 packages/adapters/src/opencode-adapter.ts):session.model
//     欄位確實更新、下一則訊息實際送出的 model 欄位確實跟著換(靠
//     fake-opencode-server.mjs 這輪新增的 `[model:providerID/modelID]`
//     回覆前綴觀察,見該檔案協定說明)、非法格式(無 "/")會被明確拒絕。
//   - session.delete 清理成功(子程序與 SSE 連線一併結束)。
// ---------------------------------------------------------------------
async function opencodeAdapterSmokeTest(client, workspaceDir) {
  const fakeServerPath = path.join(REPO_ROOT, "scripts", "fake-opencode-server.mjs");
  let opencodeProfile;
  let opencodeSessionId;

  // ---- 24a: capabilities 正確 + 建立 profile/session ----
  try {
    const capsResult = await client.rpc("adapter.capabilities", { software: "opencode" });
    const caps = capsResult.capabilities;
    const capsOk =
      caps.streaming === true &&
      caps.toolEvents === true &&
      caps.permissionRequests === true &&
      caps.diff === false &&
      caps.interrupt === true &&
      caps.terminal === false;

    const created = await client.rpc("profile.create", {
      name: "E2E Fake OpenCode Agent",
      software: "opencode",
      workingDir: workspaceDir,
      opencodeConfig: { command: process.execPath, args: [fakeServerPath] },
    });
    opencodeProfile = created.profile;

    const sessionCreated = await client.rpc(
      "session.create",
      { agentProfileId: opencodeProfile.id, workingDir: workspaceDir, title: "e2e-opencode-smoke" },
      30_000,
    );
    opencodeSessionId = sessionCreated.session.id;

    record(
      "步驟24a OpenCodeAdapter capabilities 正確(streaming/toolEvents/permissionRequests/interrupt:true,diff/terminal:false)+ 建立 software=\"opencode\" 的 profile/session",
      capsOk,
      `capabilities=${JSON.stringify(caps)}, profileId=${opencodeProfile.id}, sessionId=${opencodeSessionId}`,
    );
  } catch (err) {
    record("步驟24a OpenCodeAdapter capabilities + 建立 profile/session", false, String(err));
    return; // 沒有 session 就無法跑後續子步驟
  }

  // ---- 24b: 一般 prompt → message.part.delta/updated 轉換成 message-delta(分組/done)+ completed ----
  try {
    const { finalEvent, collected } = await client.drivePrompt(opencodeSessionId, "hello there", {
      onPermission: async () => "deny", // 不應該觸發權限請求
      timeoutMs: 20_000,
    });
    const { deltas, groups, violation } = analyzeMessageDeltas(collected);
    const fullText = groups.map((g) => g.text).join("");
    const expectedText = FAKE_OPENCODE_REPLY_CHUNKS.join("");
    const lastGroupDone = groups.length > 0 && groups[groups.length - 1].done === true;

    const ok =
      finalEvent.event.type === "completed" &&
      deltas.length > 0 &&
      !violation &&
      lastGroupDone &&
      fullText === expectedText;

    record(
      "步驟24b OpenCode 一般 prompt:message.part.delta/updated → message-delta 轉換正確 + completed",
      ok,
      violation
        ? `違規: ${violation}`
        : `fullText=${JSON.stringify(fullText)}(預期 ${JSON.stringify(expectedText)}), deltas=${deltas.length}, lastGroupDone=${lastGroupDone}, 最終事件=${finalEvent.event.type}`,
    );
  } catch (err) {
    record("步驟24b OpenCode 一般 prompt:message-delta 轉換正確 + completed", false, String(err));
  }

  // ---- 24c: 工具呼叫 + permission allow ----
  try {
    let sawPermissionRequest = false;
    const { finalEvent, collected } = await client.drivePrompt(opencodeSessionId, `${TOOL_CALL_PREFIX} run echo`, {
      onPermission: async (ev) => {
        sawPermissionRequest = true;
        log(`       [opencode] 收到 permission-request: tool=${ev.toolName}, desc=${ev.description ?? "(無)"}`);
        return "allow";
      },
      timeoutMs: 20_000,
    });

    const toolCallIdx = collected.findIndex((e) => e.event.type === "tool-call");
    const toolResultIdx = collected.findIndex((e) => e.event.type === "tool-result");
    const sawToolCall = toolCallIdx !== -1;
    const sawToolResult = toolResultIdx !== -1;
    const toolCallBeforeResult = sawToolCall && sawToolResult && toolCallIdx < toolResultIdx;
    const toolResultNotError = sawToolResult && collected[toolResultIdx].event.isError === false;
    const completedOk = finalEvent.event.type === "completed";

    record(
      "步驟24c OpenCode 權限 allow 路徑(tool-call → permission-request → tool-result,非錯誤)",
      sawPermissionRequest && sawToolCall && sawToolResult && toolCallBeforeResult && toolResultNotError && completedOk,
      `permission-request=${sawPermissionRequest}, tool-call=${sawToolCall}(idx=${toolCallIdx}), tool-result=${sawToolResult}(idx=${toolResultIdx}), toolCallBeforeResult=${toolCallBeforeResult}, completed=${completedOk}`,
    );
  } catch (err) {
    record("步驟24c OpenCode 權限 allow 路徑", false, String(err));
  }

  // ---- 24d: 工具呼叫 + permission deny ----
  try {
    let sawPermissionRequest = false;
    const { finalEvent, collected } = await client.drivePrompt(opencodeSessionId, `${TOOL_CALL_PREFIX} run echo again`, {
      onPermission: async (ev) => {
        sawPermissionRequest = true;
        log(`       [opencode] 收到 permission-request: tool=${ev.toolName}, desc=${ev.description ?? "(無)"}`);
        return "deny";
      },
      timeoutMs: 20_000,
    });

    const sawToolResult = collected.some((e) => e.event.type === "tool-result");
    const completedOk = finalEvent.event.type === "completed";

    record(
      "步驟24d OpenCode 權限 deny 路徑(無 tool-result,正常 completed 結束該輪)",
      sawPermissionRequest && !sawToolResult && completedOk,
      `permission-request=${sawPermissionRequest}, tool-result=${sawToolResult}, 最終事件=${finalEvent.event.type}`,
    );
  } catch (err) {
    record("步驟24d OpenCode 權限 deny 路徑", false, String(err));
  }

  // ---- 24e: interrupt() → /session/{id}/abort,MessageAbortedError 不轉成 error、回合確實收斂 ----
  try {
    const startIdx = client.events.length;
    await client.rpc("session.sendPrompt", { sessionId: opencodeSessionId, prompt: { text: `${SLOW_PREFIX} counting` } });
    // 等一小段時間讓 fake server 先送出至少一個 message-delta,確認回合真的在進行中,
    // 才呼叫 interrupt()(比照步驟14 的既有先例:先確認忙碌中,再中斷)。
    await client.waitForEvent(
      (e) => e.sessionId === opencodeSessionId && e.event.type === "message-delta",
      10_000,
      startIdx,
    );
    await client.rpc("session.interrupt", { sessionId: opencodeSessionId }, 20_000);
    const finalEvent = await client.waitForEvent(
      (e) => e.sessionId === opencodeSessionId && (e.event.type === "completed" || e.event.type === "error"),
      20_000,
      startIdx,
    );
    record(
      "步驟24e OpenCode interrupt():送出 /session/{id}/abort 後回合確實收斂(MessageAbortedError 不轉成 error 事件)",
      finalEvent.event.type === "completed",
      `最終事件=${finalEvent.event.type}`,
    );
  } catch (err) {
    record("步驟24e OpenCode interrupt()", false, String(err));
  }

  // ---- 24f: session.setModel() 對話中切換 model ----
  // 這輪補上 OpenCodeAdapter.setModel() 的實作(見該檔案:opencode 沒有
  // 「設定當前 model」的獨立端點,做法是存成 session 內的覆寫,下一則
  // sendPrompt() 才真正送給 opencode)。斷言三件事:
  //   1. RPC 回應與之後的 session.list 查詢,session.model 都確實更新
  //      (比照步驟20b 對 claude-agent-sdk 的既有斷言方式)。
  //   2. 下一則訊息實際送給 fake server 的 model 欄位真的變了——這件事光看
  //      session.model 欄位無法證明(那只是 DB 落地值),必須靠
  //      fake-opencode-server.mjs 這輪新增的回覆前綴機制實際觀察「wire 上
  //      送出去的請求」才能證明,見該檔案協定說明。
  //   3. 傳入不合法格式(沒有 "/")會被明確拒絕,不可默默成功(比照
  //      步驟20d 對 acp/pty 的既有先例,但這裡是「格式不合法」而非
  //      「這個 adapter 完全不支援」)。
  try {
    const NEW_MODEL = "openai/gpt-5-mini";
    const setResult = await client.rpc("session.setModel", { sessionId: opencodeSessionId, model: NEW_MODEL });
    const listAfterSet = await client.rpc("session.list", {});
    const sessionRow = listAfterSet.sessions.find((s) => s.id === opencodeSessionId);
    const setModelOk = setResult.session.model === NEW_MODEL && sessionRow?.model === NEW_MODEL;

    const { finalEvent, collected } = await client.drivePrompt(opencodeSessionId, "hello after model switch", {
      onPermission: async () => "deny",
      timeoutMs: 20_000,
    });
    const { groups, violation } = analyzeMessageDeltas(collected);
    const fullText = groups.map((g) => g.text).join("");
    const expectedText = `[model:${NEW_MODEL}] ${FAKE_OPENCODE_REPLY_CHUNKS.join("")}`;
    const wireOk = !violation && finalEvent.event.type === "completed" && fullText === expectedText;

    let rejectedInvalid = false;
    let rejectionMessage;
    try {
      await client.rpc("session.setModel", { sessionId: opencodeSessionId, model: "not-a-valid-model" });
    } catch (err) {
      rejectedInvalid = true;
      rejectionMessage = String(err);
    }

    record(
      "步驟24f OpenCode session.setModel 對話中切換 model(session.model 更新 + 下一則訊息 wire 上的 model 欄位確實跟著換 + 非法格式被拒絕)",
      setModelOk && wireOk && rejectedInvalid,
      `setResult.session.model=${setResult.session.model}, session.list 查得=${sessionRow?.model}, ` +
        `換 model 後回覆=${JSON.stringify(fullText)}(預期 ${JSON.stringify(expectedText)}), ` +
        `非法格式是否被拒絕=${rejectedInvalid}${rejectionMessage ? `(${rejectionMessage})` : ""}`,
    );
  } catch (err) {
    record("步驟24f OpenCode session.setModel 對話中切換 model", false, String(err));
  }

  // ---- 24g: 清理 ----
  try {
    await client.rpc("session.delete", { sessionId: opencodeSessionId });
    const listAfter = await client.rpc("session.list", {});
    const stillThere = listAfter.sessions.some((s) => s.id === opencodeSessionId);
    record(
      "步驟24g OpenCode session.delete 清理成功(子程序與 SSE 連線一併結束)",
      !stillThere,
      `刪除後 session.list 是否仍含此 session: ${stillThere}`,
    );
  } catch (err) {
    record("步驟24g OpenCode session.delete 清理成功", false, String(err));
  }
}

// ---------------------------------------------------------------------
// 步驟 11: Windows .cmd spawn 修復迴歸測試(見 packages/adapters/src/acp-adapter.ts
// 的 resolveWindowsSpawnCommand())
// ---------------------------------------------------------------------
async function windowsCmdSpawnRegressionTest(client, workspaceDir) {
  if (process.platform !== "win32") {
    record(
      "步驟11 Windows .cmd spawn 修復迴歸測試(resolveWindowsSpawnCommand)",
      true,
      "非 Windows 平台,此修復只影響 Windows,略過(視為 PASS)",
    );
    return;
  }

  const fakeAgentPath = path.join(REPO_ROOT, "scripts", "fake-acp-agent.mjs");
  // 故意把 wrapper 放在「路徑含空白」的暫存目錄下:
  //   1. .cmd 副檔名必須用 shell:true 才能 spawn —— 修復前的 bug 是把
  //      `.cmd`(不論絕對或相對路徑)錯誤分類到 useShell:false 分支,
  //      Node 對不帶 shell 的 .cmd spawn 會直接丟 EINVAL(已在開發過程中
  //      用暫存 .cmd 重現過,見 packages/adapters/src/acp-adapter.ts 頂端
  //      resolveWindowsSpawnCommand() 的註解)。
  //   2. command 本身路徑含空白時,shell:true 下需要手動 quoting
  //      (quoteWindowsShellArg)才能正確 spawn,不會被 cmd.exe 依空白拆開。
  const wrapperDir = mkdtempSync(path.join(os.tmpdir(), "deskmony e2e cmd wrapper "));
  const wrapperPath = path.join(wrapperDir, "fake-acp-agent.cmd");
  writeFileSync(wrapperPath, `@echo off\r\n"${process.execPath}" "${fakeAgentPath}" %*\r\n`, "utf8");

  let sessionId;
  try {
    const profileCreated = await client.rpc("profile.create", {
      name: "E2E Windows .cmd Wrapper",
      software: "acp",
      workingDir: workspaceDir,
      // 額外帶一個含空白的 arg,一併驗證 args 陣列元素的 quoting。
      acpConfig: { command: wrapperPath, args: ["extra arg with spaces"] },
    });

    const sessionCreated = await client.rpc(
      "session.create",
      { agentProfileId: profileCreated.profile.id, workingDir: workspaceDir, title: "e2e-cmd-wrapper" },
      30_000,
    );
    sessionId = sessionCreated.session.id;

    const { finalEvent, collected } = await client.drivePrompt(sessionId, "hello there", {
      onPermission: async () => "deny",
      timeoutMs: 20_000,
    });
    const { deltas, groups, violation } = analyzeMessageDeltas(collected);
    const fullText = groups.map((g) => g.text).join("");
    const expectedText = FAKE_ACP_REPLY_CHUNKS.join("");

    record(
      "步驟11 Windows .cmd wrapper(含空白路徑)spawn 成功 + shell quoting 正確(修復1驗證)",
      finalEvent.event.type === "completed" && deltas.length > 0 && !violation && fullText === expectedText,
      `wrapperPath=${wrapperPath}, 最終事件=${finalEvent.event.type}, deltas=${deltas.length}, fullText=${JSON.stringify(fullText)}(預期 ${JSON.stringify(expectedText)})`,
    );
  } catch (err) {
    record(
      "步驟11 Windows .cmd wrapper(含空白路徑)spawn 成功 + shell quoting 正確(修復1驗證)",
      false,
      String(err),
    );
  } finally {
    if (sessionId) {
      try {
        await client.rpc("session.delete", { sessionId });
      } catch (err) {
        log(`[cleanup] 刪除 .cmd wrapper 迴歸測試 session 時發生錯誤(忽略): ${err}`);
      }
    }
    try {
      rmSync(wrapperDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

// ---------------------------------------------------------------------
// 步驟 14: MessageBus interrupt 時序修正驗證(M3 Round B 任務 3,真實模型,
// 允許軟性判定 —— 比照步驟 5/13)
//
// Round A review 待辦:MessageBus 的 interrupt 投遞路徑(deliverToMember)
// 修正前是 `this.sessionManager.interrupt(sessionId)` 不 await 就緊接著
// `await this.inject(...)` —— SDK 的 `Query.interrupt()`(sdk.d.ts 明載)是
// 非同步的,resolve 才代表「查詢確實停止處理、控制權交還呼叫端」,不 await
// 就注入下一個 prompt,理論上會與尚未真正停下的回合競爭。M3 Round B 已修正
// (`AgentAdapter.interrupt()` 改回傳 `Promise<void>`,
// `ClaudeAgentSdkAdapter.interrupt()`/`SessionManager.interrupt()`/
// `MessageBus.deliverToMember()` 全部串起來 await,見
// packages/adapters/src/claude-sdk-adapter.ts、
// apps/core/src/session/session-manager.ts、
// apps/core/src/bus/message-bus.ts)。這裡用「真實 Claude SDK session、真的
// 處於忙碌中」驗證修正後的路徑不會卡死、注入確實送達。
//
// 用兩個 team member:Worker 真的建立 session(忙碌的一方,也是這個修正真正
// 要驗證的路徑 —— ClaudeAgentSdkAdapter.interrupt() 作用在一個真的忙碌中的
// 真實 session 上);PM 只用來提供 canInterrupt=true 的身分送出 interrupt,
// 不需要真的建立 session —— resolvePriorityForSender() 只依名稱查
// TeamMember,不要求發送者本身有活躍 session(e2e 步驟12d 已用同一手法驗證
// 過這個機制),這裡沿用,把真實模型資源集中在被中斷的那一端。
//
// 判定拆成硬性(不依賴模型是否遵從指令,只依賴程式碼路徑本身沒有卡死/沒有
// 把訊息搞丟,應為決定性)與軟性(依賴模型是否確實照做,模型偶發不配合視為
// 已知 flake,如實記錄,不影響其他步驟判定)兩組。
// ---------------------------------------------------------------------
async function interruptTimingSmokeTest(client, workspaceDir, defaultProfile) {
  let teamId;
  let workerSessionId;
  const ACK_TOKEN = `ACK_${randomUUID().slice(0, 8)}`;

  // ---- 14a: 建立 team + Worker(真實 session)+ PM(canInterrupt=true,無 session)----
  try {
    const team = await client.rpc("team.create", { name: "E2E Interrupt Team" });
    teamId = team.team.id;

    const workerMember = await client.rpc("team.addMember", {
      teamId,
      agentProfileId: defaultProfile.id,
      name: "Worker",
      role: "Coder",
      canInterrupt: false,
    });
    await client.rpc("team.addMember", {
      teamId,
      agentProfileId: defaultProfile.id,
      name: "PM",
      role: "PM",
      canInterrupt: true,
    });

    const workerSession = await client.rpc(
      "session.create",
      {
        agentProfileId: defaultProfile.id,
        workingDir: workspaceDir,
        title: "e2e-interrupt-worker",
        teamMemberId: workerMember.member.id,
      },
      30_000,
    );
    workerSessionId = workerSession.session.id;

    record(
      "步驟14a 建立 team(Worker 有真實 Claude SDK session,PM canInterrupt=true 無 session)",
      true,
      `teamId=${teamId}, workerSessionId=${workerSessionId}`,
    );
  } catch (err) {
    record("步驟14a 建立 team(Worker 有真實 Claude SDK session,PM canInterrupt=true 無 session)", false, String(err));
    return;
  }

  // ---- 14b: 讓 Worker 開始一個冗長任務,確認真的在忙碌中串流 ----
  const longTaskStartIdx = client.events.length;
  try {
    const longPrompt =
      "請從 1 開始,一個數字接一個數字慢慢數到 100,每個數字單獨一行,並在每個數字後面附上一句話描述它的其中一個數學性質" +
      "(例如是否為質數、完全平方數、偶數或奇數等,每個數字挑一個性質簡短描述即可)。在數到 100 之前絕對不要停止," +
      "也不要事先說明或詢問我任何問題,直接開始輸出第一行。";
    await client.rpc("session.sendPrompt", { sessionId: workerSessionId, prompt: { text: longPrompt } });

    // 等到真的看到第一個 message-delta,確認這一輪真的開始串流(忙碌中),
    // 才有意義送出 interrupt —— 這是這個修正要驗證的真實競爭場景的前提。
    await client.waitForEvent(
      (e) => e.sessionId === workerSessionId && e.event.type === "message-delta",
      20_000,
      longTaskStartIdx,
    );
    // 讓它多累積一點內容再中斷,避免中斷得太早、與模型幾乎同時開始不具代表性。
    await sleep(1500);

    record(
      "步驟14b Worker 開始執行冗長任務,確認真的在忙碌中串流(已觀察到 message-delta)",
      true,
      "已觀察到至少一個 message-delta",
    );
  } catch (err) {
    record("步驟14b Worker 開始執行冗長任務,確認真的在忙碌中串流", false, String(err));
    if (workerSessionId) {
      try {
        await client.rpc("session.delete", { sessionId: workerSessionId });
      } catch {
        // ignore
      }
    }
    return;
  }

  const preInterrupt = analyzeMessageDeltas(client.events.filter((e) => e.sessionId === workerSessionId));
  const preInterruptText = preInterrupt.groups.map((g) => g.text).join("");
  const preInterruptGroupCount = preInterrupt.groups.length;

  // ---- 14c(硬性): PM(canInterrupt=true)送出 priority="interrupt" 訊息,未被降級 ----
  const interruptContent = `緊急插話:請立刻停止目前手邊的任務,改為只回覆這個確認碼,不要加任何其他文字或說明:${ACK_TOKEN}`;
  const interruptSentIdx = client.events.length;
  let sendResult;
  try {
    sendResult = await client.rpc("message.send", {
      teamId,
      to: "Worker",
      content: interruptContent,
      priority: "interrupt",
      fromName: "PM",
    });
    record(
      "步驟14c(硬性)PM(canInterrupt=true)送出 priority=\"interrupt\" 訊息,未被降級",
      sendResult.downgraded === false && sendResult.message.priority === "interrupt",
      `downgraded=${sendResult.downgraded}, priority=${sendResult.message.priority}`,
    );
  } catch (err) {
    record("步驟14c(硬性)PM 送出 priority=\"interrupt\" 訊息,未被降級", false, String(err));
    if (workerSessionId) {
      try {
        await client.rpc("session.delete", { sessionId: workerSessionId });
      } catch {
        // ignore
      }
    }
    return;
  }

  // ---- 14d(硬性): interrupt 訊息內容確實被注入(session.history 可證) ----
  // 這是修正後的路徑(await interrupt() 才 inject)是否成功走完的直接證據——
  // 不管模型後續怎麼回應,只要 MessageBus.deliverToMember() 的 interrupt 分支
  // 沒有卡死/丟例外,SessionManager.sendPrompt() 一定會先把這段格式化文字
  // persist 成一則 user 訊息(這件事發生在 adapter.sendPrompt() 之前,不受
  // 模型後續是否遵從指令影響)。
  let injectedFound;
  try {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && !injectedFound) {
      const historyAfterInject = await client.rpc("session.history", { sessionId: workerSessionId });
      injectedFound = historyAfterInject.messages.find((m) => m.role === "user" && m.content.includes(ACK_TOKEN));
      if (!injectedFound) await sleep(500);
    }
    record(
      "步驟14d(硬性)interrupt 訊息內容確實被注入(session.history 查得到對應 user 訊息)",
      Boolean(injectedFound),
      injectedFound
        ? `已找到: ${JSON.stringify(injectedFound.content).slice(0, 200)}`
        : "逾時未在 session.history 找到注入的 user 訊息(這會是 regression,不是模型行為 flake)",
    );
  } catch (err) {
    record("步驟14d(硬性)interrupt 訊息內容確實被注入(session.history 可證)", false, String(err));
  }

  // ---- 14e(硬性): session 沒有卡死,最終回到 idle ----
  let finalStatus;
  try {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const listResult = await client.rpc("session.list", {});
      const session = listResult.sessions.find((s) => s.id === workerSessionId);
      finalStatus = session?.status;
      if (finalStatus === "idle") break;
      await sleep(1000);
    }
    record(
      "步驟14e(硬性)session 沒有卡死,插話處理完後最終回到 idle(90s 內)",
      finalStatus === "idle",
      `最終狀態=${finalStatus}`,
    );
  } catch (err) {
    record("步驟14e(硬性)session 沒有卡死,最終回到 idle", false, String(err));
  }

  // ---- 14f(軟性): 原本冗長任務確實被中斷(而非自然跑完才處理插話) ----
  try {
    const postDeltas = analyzeMessageDeltas(client.events.filter((e) => e.sessionId === workerSessionId));
    const firstGroupAfter = postDeltas.groups[0];
    const originalGroupGrewALot = Boolean(firstGroupAfter) && firstGroupAfter.text.length > preInterruptText.length + 4000;
    const originalReachedEnd =
      Boolean(firstGroupAfter) &&
      (firstGroupAfter.text.includes("100.") || firstGroupAfter.text.includes("100、") || firstGroupAfter.text.includes("100 "));
    const likelyInterrupted = Boolean(firstGroupAfter) && !originalReachedEnd && !originalGroupGrewALot;
    record(
      "步驟14f(軟性)原本冗長任務確實被中斷(未跑完就停止,佐證 interrupt() 真的生效,而非自然完成後才處理插話)",
      likelyInterrupted,
      likelyInterrupted
        ? `中斷前長度=${preInterruptText.length}, 中斷後最終長度=${firstGroupAfter?.text.length ?? 0}, 未包含「100」`
        : `軟性判定 —— 模型這輪可能在送出 interrupt 前就已經跑得很快、或恰好完整跑完,屬已知 flake(比照步驟5/13),非 regression。preInterruptGroupCount=${preInterruptGroupCount}, 中斷後長度=${firstGroupAfter?.text.length ?? "N/A"}`,
      "model-behavior",
    );
  } catch (err) {
    record("步驟14f(軟性)原本冗長任務確實被中斷", false, String(err), "model-behavior");
  }

  // ---- 14g(軟性): 插話之後 assistant 有回覆確認碼(佐證「後續 assistant 回應提及該訊息」) ----
  // 註:14f/14g 不需要額外的模型呼叫(分析的是 14a-e 既有流程已經收集到的
  // 事件/等待既有進行中回合的後續事件),因此不論 --only 為何都照常執行,
  // 只是被歸類進 model-behavior 統計組、不影響 deterministic 組結論。
  try {
    const ackEvent = await client.waitForEvent(
      (e) => e.sessionId === workerSessionId && e.event.type === "message-delta" && e.event.delta.includes(ACK_TOKEN),
      45_000,
      interruptSentIdx,
    );
    record(
      "步驟14g(軟性)後續 assistant 回應提及注入的確認碼(佐證訊息確實被模型看到並處理)",
      Boolean(ackEvent),
      `已在後續回應中找到確認碼 ${ACK_TOKEN}`,
      "model-behavior",
    );
  } catch (err) {
    record(
      "步驟14g(軟性)後續 assistant 回應提及注入的確認碼",
      false,
      `逾時未在後續回應找到確認碼 —— 模型這輪可能選擇用自己的話回應而非照字面重複確認碼,屬已知 flake(比照步驟5/13,已有14d 的 session.history 決定性證據佐證訊息確實注入),非 regression: ${err}`,
      "model-behavior",
    );
  }

  // ---- 14h: 清理 ----
  try {
    await client.rpc("session.delete", { sessionId: workerSessionId });
    const listAfter = await client.rpc("session.list", {});
    const stillThere = listAfter.sessions.some((s) => s.id === workerSessionId);
    record("步驟14h 清理 session", !stillThere, `刪除後 session.list 是否仍含此 session: ${stillThere}`);
  } catch (err) {
    record("步驟14h 清理 session", false, String(err));
  }
}

// ---------------------------------------------------------------------
// 步驟 15: TaskService + WorkspaceManager(M4 Round A,決定性測試 —— 用真實
// git 子程序 + 真實的 team/task/member,不叫任何真實模型或 fake agent,
// 結果應為 100% 決定性)
//
// ⚠️ S8(agent-lifecycle)之後這個步驟**不再是「全程不建立任何 agent
// session」**:成員的 lifecycle 預設是 "ephemeral"(見 packages/shared/src/
// team.ts 的 `LifecycleSchema` 與 `lifecycle: LifecycleSchema.default("ephemeral")`),
// 而 `TaskService.assignTask()` 對 ephemeral 成員會自動 spawn 一個 session
// (docs/LAYER-4-detail-design/agent-lifecycle_detail.md §2.1)—— 也就是說
// 15b/15d 的每一次 task.assign 都會真的起一個 `claude` 子程序,cwd 就是剛
// 建立的 worktree。這**不影響決定性**(斷言的仍是 task/workspace/git 這些
// 系統行為,不碰模型講了什麼),但它是 15e「task.delete 清理 worktree」會
// 踩到子程序佔住目錄的原因,見 packages/adapters/src/claude-sdk-adapter.ts
// 的 `dispose()` 註解。原本寫在這裡的「全程不建立任何 agent session」是 S8
// 之前的前提,已經不成立。
//
// 涵蓋:
//   15a 準備一個真的 git repo(git init + 初始 commit)當 team workingDir。
//   15b task.create(backlog)→ task.assign(assigned,觸發 WorkspaceManager
//       建立 worktree)—— 斷言 worktree 目錄實際存在、`git worktree list`
//       看得到、分支命名正確。
//   15c 一個非法跳轉(assigned → done,跳過中間狀態)斷言被拒;接著走一條
//       合法路徑 assigned → in-progress → review → merging → done(比 e2e
//       任務描述列出的「assigned→in-progress→review→done」多了 merging 這一
//       步 —— TaskService 的狀態機依 ARCHITECTURE.md 第 5 節與這輪任務描述
//       第 2 節都明講 review 之後要先進 merging 才能到 done,review → done
//       本身在我們的合法轉換表裡就不存在,所以這裡改用真正合法、涵蓋完整
//       狀態機的路徑,而不是照抄任務描述裡可能省略了 merging 的那句話),
//       每一步都斷言狀態與 "task-updated" 推播。
//   15d report_status(帶 taskId)↔ task 狀態整合:透過這輪新增的
//       `message.reportStatus` gateway 方法(比照 M3 Round B「team.teammates」
//       的先例,包一層既有的 MessageBus.reportStatus() 邏輯給非 agent 呼叫端
//       用,詳見 packages/shared/src/gateway.ts 的註解)——
//         - 對映得到且轉換合法:任務狀態同步更新。
//         - 對映不到:只記錄訊息,任務狀態不變。
//         - taskId 指到的任務,回報者不是該任務的指派人:只記錄訊息,不更動。
//         - 不帶 taskId:行為與 M3 完全相同(訊息內容不含任務同步字樣)。
//   15e task.delete → 斷言 worktree 被清理(`git worktree list` 不再含它、
//       目錄從磁碟上移除、對應分支也被刪除)。
// ---------------------------------------------------------------------
function runGitSync(args, cwd) {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

async function taskWorkspaceSmokeTest(client) {
  const gitVersion = runGitSync(["--version"], process.cwd());
  if (gitVersion.status !== 0) {
    record(
      "步驟15 TaskService + WorkspaceManager(git 不可用,整個步驟略過)",
      false,
      `找不到可用的 git 執行檔: ${gitVersion.error ?? gitVersion.stderr}`,
    );
    return;
  }

  const repoDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-git-"));
  const worktreeRoot = path.join(path.dirname(repoDir), ".deskmony-worktrees");
  let teamId;
  let memberId;
  let task1Id;
  let task3Id;
  let task4Id;
  let task1WorktreePath;
  let task1Branch;
  let task3WorktreePath;
  let task3Branch;

  try {
    // ---- 15a: 真的 git repo(git init + 初始 commit)+ team + 成員 ----
    try {
      const initResult = runGitSync(["init"], repoDir);
      runGitSync(["config", "user.email", "e2e@deskmony.local"], repoDir);
      runGitSync(["config", "user.name", "Deskmony E2E"], repoDir);
      writeFileSync(path.join(repoDir, "README.md"), "# deskmony e2e task worktree repo\n", "utf8");
      runGitSync(["add", "."], repoDir);
      const commitResult = runGitSync(["commit", "-m", "initial commit"], repoDir);

      const team = await client.rpc("team.create", { name: "E2E Task Team", workingDir: repoDir });
      teamId = team.team.id;

      const profileCreated = await client.rpc("profile.create", {
        name: "E2E Task Member Profile",
        software: "claude-agent-sdk",
        workingDir: repoDir,
      });
      const member = await client.rpc("team.addMember", {
        teamId,
        agentProfileId: profileCreated.profile.id,
        name: "Coder",
        role: "Coder",
        canInterrupt: false,
      });
      memberId = member.member.id;

      record(
        // 成員刻意沿用預設的 lifecycle="ephemeral"(不像步驟16 明確指定
        // persistent)—— 15b/15d 的 task.assign 因此會自動 spawn session,
        // 這正是 15e 要驗證「dispose 後 worktree 真的能刪掉」的前提,見上方
        // 這個步驟開頭的 ⚠️ 說明。
        "步驟15a 準備真實 git repo(git init + 初始 commit)+ team + 成員(lifecycle 預設 ephemeral,assign 時會自動 spawn session)",
        initResult.status === 0 && commitResult.status === 0,
        `repoDir=${repoDir}, teamId=${teamId}, memberId=${memberId}, git init status=${initResult.status}, commit status=${commitResult.status}`,
      );
    } catch (err) {
      record("步驟15a 準備真實 git repo + team + 成員", false, String(err));
      return;
    }

    // ---- 15b: task.create(backlog) → task.assign(assigned,建立 worktree) ----
    try {
      const created = await client.rpc("task.create", { teamId, title: "E2E Task 1" });
      task1Id = created.task.id;
      const backlogOk = created.task.status === "backlog";
      const createPushOk = Boolean(
        await client.waitForTaskUpdate((t) => t.id === task1Id && t.status === "backlog", 5_000).catch(() => undefined),
      );

      const assignResult = await client.rpc("task.assign", { taskId: task1Id, memberId });
      task1WorktreePath = assignResult.workspace.worktreePath;
      task1Branch = assignResult.workspace.branch;

      const assignedOk =
        assignResult.task.status === "assigned" &&
        assignResult.task.assigneeMemberId === memberId &&
        assignResult.task.workspaceId === assignResult.workspace.id;
      const dirExists = existsSync(task1WorktreePath);
      const worktreeListOutput = runGitSync(["worktree", "list", "--porcelain"], repoDir).stdout ?? "";
      // `git worktree list --porcelain` 一律用 POSIX 風格正斜線輸出路徑(即使在
      // Windows 上),但 `task1WorktreePath` 是 `path.join()` 產生的、Windows 上
      // 會是反斜線 —— 比對前正規化成正斜線(比照既有步驟 4/9c 對 `targetFilePosix`
      // 的既有慣例),否則在 Windows 上永遠比不到,誤判為「worktree 沒被 git 認得」
      // (但目錄/git 本身其實都正確,純粹是這裡字串比對沒有正規化路徑分隔字元)。
      const listedInGit = worktreeListOutput.includes(task1WorktreePath.split(path.sep).join("/"));
      const branchOk = /^deskmony\/task-[0-9a-f]{8}$/.test(task1Branch);
      const assignPushOk = Boolean(
        await client.waitForTaskUpdate((t) => t.id === task1Id && t.status === "assigned", 5_000).catch(() => undefined),
      );

      record(
        "步驟15b task.create(backlog)→ task.assign(assigned,實際建立 git worktree)+ task-updated 推播",
        backlogOk && createPushOk && assignedOk && dirExists && listedInGit && branchOk && assignPushOk,
        `backlogOk=${backlogOk}, createPush=${createPushOk}, task.status=${assignResult.task.status}, assignPush=${assignPushOk}, ` +
          `worktreePath=${task1WorktreePath}, dirExists=${dirExists}, listedInGit=${listedInGit}, branch=${task1Branch}, branchOk=${branchOk}\n` +
          `git worktree list --porcelain:\n${worktreeListOutput}`,
      );
    } catch (err) {
      record("步驟15b task.create → task.assign", false, String(err));
    }

    // ---- 15c: 非法跳轉被拒 + 一條完整合法路徑(每步斷言狀態 + task-updated 推播) ----
    try {
      let illegalRejected = false;
      let illegalErrorMessage = "";
      try {
        await client.rpc("task.updateStatus", { taskId: task1Id, status: "done" });
      } catch (err) {
        illegalRejected = true;
        illegalErrorMessage = String(err);
      }

      const path15c = ["in-progress", "review", "merging", "done"];
      const stepResults = [];
      for (const status of path15c) {
        const result = await client.rpc("task.updateStatus", { taskId: task1Id, status });
        const pushed = await client.waitForTaskUpdate((t) => t.id === task1Id && t.status === status, 5_000).catch(() => undefined);
        stepResults.push({ status, actual: result.task.status, pushed: Boolean(pushed) });
      }
      const pathOk = stepResults.every((s) => s.status === s.actual && s.pushed);

      record(
        "步驟15c 非法跳轉(assigned→done)被拒 + 合法路徑 assigned→in-progress→review→merging→done(每步狀態 + task-updated 推播)",
        illegalRejected && pathOk,
        `illegalRejected=${illegalRejected}(${illegalErrorMessage}), steps=${JSON.stringify(stepResults)}`,
      );
    } catch (err) {
      record("步驟15c 非法跳轉被拒 + 合法路徑狀態流轉", false, String(err));
    }

    // ---- 15d: report_status(帶 taskId)↔ task 狀態整合 ----
    try {
      const task3Created = await client.rpc("task.create", { teamId, title: "E2E Task 3 (report_status)" });
      task3Id = task3Created.task.id;
      const task3Assigned = await client.rpc("task.assign", { taskId: task3Id, memberId });
      task3WorktreePath = task3Assigned.workspace.worktreePath;
      task3Branch = task3Assigned.workspace.branch;

      // (1) 對映得到 + 合法轉換:任務狀態應同步更新為 in-progress。
      const mappedReport = await client.rpc("message.reportStatus", {
        teamId,
        fromMemberId: memberId,
        status: "in-progress",
        summary: "開始動工",
        taskId: task3Id,
      });
      await client.waitForTaskUpdate((t) => t.id === task3Id && t.status === "in-progress", 5_000);
      const task3AfterMapped = await client.rpc("task.get", { taskId: task3Id });
      const mappedOk =
        mappedReport.message.content.includes("任務狀態已同步") && task3AfterMapped.task.status === "in-progress";

      // (2) 對映不到的自由文字:只記錄訊息,任務狀態不變。
      const unmappedReport = await client.rpc("message.reportStatus", {
        teamId,
        fromMemberId: memberId,
        status: "still writing tests, nothing conclusive yet",
        taskId: task3Id,
      });
      const task3AfterUnmapped = await client.rpc("task.get", { taskId: task3Id });
      const unmappedOk =
        unmappedReport.message.content.includes("任務狀態未同步") && task3AfterUnmapped.task.status === "in-progress";

      // (3) taskId 指到的任務,回報者不是該任務的指派人:只記錄訊息,不更動。
      const task4Created = await client.rpc("task.create", { teamId, title: "E2E Task 4 (unassigned)" });
      task4Id = task4Created.task.id;
      const notAssigneeReport = await client.rpc("message.reportStatus", {
        teamId,
        fromMemberId: memberId,
        status: "done",
        taskId: task4Id,
      });
      const task4AfterReport = await client.rpc("task.get", { taskId: task4Id });
      const notAssigneeOk =
        notAssigneeReport.message.content.includes("未被指派任務") && task4AfterReport.task.status === "backlog";

      // (4) 不帶 taskId:行為與 M3 完全相同(訊息內容不含任務同步字樣)。
      const noTaskIdReport = await client.rpc("message.reportStatus", {
        teamId,
        fromMemberId: memberId,
        status: "just a note",
      });
      const backwardCompatOk =
        !noTaskIdReport.message.content.includes("任務狀態已同步") &&
        !noTaskIdReport.message.content.includes("任務狀態未同步") &&
        noTaskIdReport.message.content === "[狀態回報] just a note";

      record(
        "步驟15d report_status(message.reportStatus)帶 taskId ↔ task 狀態整合(對映成功同步/對映不到不變/非指派人不變/不帶 taskId 向下相容)",
        mappedOk && unmappedOk && notAssigneeOk && backwardCompatOk,
        `mappedOk=${mappedOk}(${mappedReport.message.content}), unmappedOk=${unmappedOk}(${unmappedReport.message.content}), ` +
          `notAssigneeOk=${notAssigneeOk}(${notAssigneeReport.message.content}), backwardCompatOk=${backwardCompatOk}(${JSON.stringify(noTaskIdReport.message.content)})`,
      );
    } catch (err) {
      record("步驟15d report_status 帶 taskId ↔ task 狀態整合", false, String(err));
    }

    // ---- 15e: task.delete → worktree 被清理(git worktree list 不再含它、目錄移除、分支刪除) ----
    try {
      await client.rpc("task.delete", { taskId: task3Id });

      let getAfterDeleteRejected = false;
      try {
        await client.rpc("task.get", { taskId: task3Id });
      } catch {
        getAfterDeleteRejected = true;
      }

      const dirRemoved = !existsSync(task3WorktreePath);
      const worktreeListAfter = runGitSync(["worktree", "list", "--porcelain"], repoDir).stdout ?? "";
      const noLongerListed = !worktreeListAfter.includes(task3WorktreePath);
      const branchListAfter = runGitSync(["branch", "--list", task3Branch], repoDir).stdout ?? "";
      const branchRemoved = branchListAfter.trim().length === 0;

      record(
        "步驟15e task.delete 清理 worktree(目錄移除 + git worktree list 不再含它 + 分支刪除)+ 任務本身查不到",
        getAfterDeleteRejected && dirRemoved && noLongerListed && branchRemoved,
        `getAfterDeleteRejected=${getAfterDeleteRejected}, dirRemoved=${dirRemoved}(${task3WorktreePath}), noLongerListed=${noLongerListed}, branchRemoved=${branchRemoved}\n` +
          `git worktree list --porcelain(刪除後):\n${worktreeListAfter}`,
      );
    } catch (err) {
      record("步驟15e task.delete 清理 worktree", false, String(err));
    }
  } finally {
    // ---- 清理:task1(done,仍持有 worktree,見 workspace-manager.ts 說明:
    // 進入 done 不會自動清理,只有明確 delete 才清理)、task4(backlog,無
    // workspace)一併刪除;最後移除整個暫存 git repo 與 worktree 根目錄,
    // 確保這個步驟結束後無殘留 worktree/暫存 repo。 ----
    for (const taskId of [task1Id, task4Id]) {
      if (!taskId) continue;
      try {
        await client.rpc("task.delete", { taskId });
      } catch (err) {
        log(`[cleanup] 刪除步驟15任務(${taskId})時發生錯誤(忽略): ${err}`);
      }
    }
    try {
      rmSync(repoDir, { recursive: true, force: true });
    } catch (err) {
      log(`[cleanup] 刪除步驟15暫存 git repo(${repoDir})時發生錯誤(忽略): ${err}`);
    }
    try {
      rmSync(worktreeRoot, { recursive: true, force: true });
    } catch (err) {
      log(`[cleanup] 刪除步驟15 worktree 根目錄(${worktreeRoot})時發生錯誤(忽略): ${err}`);
    }
  }
}

// ---------------------------------------------------------------------
// 步驟 16: Review 合併流程 + request_review(M4 Round B,決定性測試 —— 全程
// 用真實 git 子程序 + 真實建立的 team/task/member 驅動,不建立任何 agent
// session、不叫任何真實模型或 fake agent,結果應為 100% 決定性)
//
// 涵蓋:
//   16a 合併成功路徑:assign 後在 worktree 實際做一個 commit → review →
//       merging → task.merge → 斷言 done、baseDir(主幹)git log 看得到這個
//       commit、分支已合併(git branch --merged)。
//   16b 合併衝突路徑(獨立的暫存 repo,避免弄髒 16a/16c/16d 共用的 repo):
//       baseDir 與 worktree 對同一個檔案做衝突變更 → task.merge 應失敗、任務
//       留在 merging、baseDir 乾淨(git merge --abort 生效,無殘留合併狀態)。
//   16c request_review(直接呼叫 message.reportStatus 對應的
//       message.requestReview gateway 方法 —— 這輪任務描述允許「fake ACP
//       成員或直接 gateway」,ClaudeAgentSdkAdapter 才會掛載 team-bus MCP,
//       用 fake agent 呼叫不到真正的 MCP 工具,直接打 gateway 才是決定性且
//       涵蓋同一段 MessageBus.requestReview() 實作的正確做法):斷言任務轉
//       review + reviewer 收到的訊息可從 team.messages 查得到。
//   16d agent 不能自己合併到 done:task2(16c 用過的任務)推進到 merging 後,
//       用 message.reportStatus(status: "done", taskId) 企圖繞過人類批准 ——
//       斷言任務仍留在 merging,回應訊息說明原因(需經 task.merge)。
//   16e task.delete 的 hadUncommittedChanges 旗標:worktree 有未 commit 的
//       變更時應回 true,乾淨的 worktree 應回 false。
// ---------------------------------------------------------------------
async function taskMergeReviewSmokeTest(client) {
  const gitVersion = runGitSync(["--version"], process.cwd());
  if (gitVersion.status !== 0) {
    record(
      "步驟16 Review 合併流程 + request_review(git 不可用,整個步驟略過)",
      false,
      `找不到可用的 git 執行檔: ${gitVersion.error ?? gitVersion.stderr}`,
    );
    return;
  }

  // ==== 16a / 16c / 16d / 16e:共用一個 repo + team(彼此不衝突,合併成功後
  // baseDir 仍然乾淨,可以繼續讓後面的子步驟使用同一個 team)====
  const repoDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-merge-"));
  const worktreeRoot = path.join(path.dirname(repoDir), ".deskmony-worktrees");
  let teamId;
  let coderId;
  let task1Id;
  let task2Id;

  try {
    // ---- 共用前置:git repo(明確指定初始分支名為 main,避免依賴這台機器
    // 的 git 全域設定 init.defaultBranch,讓這個步驟在任何機器上都決定性)
    // + team + 兩個成員(Coder / Reviewer,Reviewer 不建立 session)----
    try {
      const initResult = runGitSync(["init", "-b", "main"], repoDir);
      runGitSync(["config", "user.email", "e2e@deskmony.local"], repoDir);
      runGitSync(["config", "user.name", "Deskmony E2E"], repoDir);
      writeFileSync(path.join(repoDir, "README.md"), "# deskmony e2e merge repo\n", "utf8");
      runGitSync(["add", "."], repoDir);
      const commitResult = runGitSync(["commit", "-m", "initial commit"], repoDir);

      const team = await client.rpc("team.create", { name: "E2E Merge Team", workingDir: repoDir });
      teamId = team.team.id;

      const coderProfile = await client.rpc("profile.create", {
        name: "E2E Merge Coder Profile",
        software: "claude-agent-sdk",
        workingDir: repoDir,
      });
      // S8(agent-lifecycle):role="Coder" 預設推導為 lifecycle="ephemeral",
      // 但這個步驟(16a/16c/16d/16e)刻意讓同一個 memberId 掛著好幾個「尚未
      // 走到終態」的任務(task2 在 16d 之後仍停在 "merging",16e 才把它跟
      // task3/task4 一起指派給同一個 coderId)——這與 S8 的「一 member 一
      // session」約束互斥,但這個測試本來就與 lifecycle/session 生命週期無關
      // (純粹測 task/workspace/git merge 機制),明確指定 persistent 讓
      // TaskService.assignTask() 略過 ephemeral 專屬的自動 spawn/檢查(見
      // agent-lifecycle_detail.md §2.1「persistent:不做任何事」),恢復這個
      // 測試原本的行為。
      const coder = await client.rpc("team.addMember", {
        teamId,
        agentProfileId: coderProfile.profile.id,
        name: "Coder",
        role: "Coder",
        canInterrupt: false,
        lifecycle: "persistent",
      });
      coderId = coder.member.id;

      const reviewerProfile = await client.rpc("profile.create", {
        name: "E2E Merge Reviewer Profile",
        software: "claude-agent-sdk",
        workingDir: repoDir,
      });
      await client.rpc("team.addMember", {
        teamId,
        agentProfileId: reviewerProfile.profile.id,
        name: "Reviewer",
        role: "Reviewer",
        canInterrupt: false,
      });

      record(
        "步驟16 前置:git repo(main 分支) + team + Coder/Reviewer 成員(不建立任何 session)",
        initResult.status === 0 && commitResult.status === 0,
        `repoDir=${repoDir}, teamId=${teamId}, coderId=${coderId}, init status=${initResult.status}, commit status=${commitResult.status}`,
      );
    } catch (err) {
      record("步驟16 前置設置", false, String(err));
      return;
    }

    // ---- 16a: 合併成功路徑 ----
    try {
      const created = await client.rpc("task.create", { teamId, title: "E2E Merge Task 1" });
      task1Id = created.task.id;
      const assigned = await client.rpc("task.assign", { taskId: task1Id, memberId: coderId });
      const worktreePath = assigned.workspace.worktreePath;
      const branch = assigned.workspace.branch;

      // 在 worktree 裡實際做一個 commit(不是 core 自動做的,模擬 agent 真的完成了工作)。
      writeFileSync(path.join(worktreePath, "feature.txt"), "feature work\n", "utf8");
      runGitSync(["add", "."], worktreePath);
      const featureCommit = runGitSync(["commit", "-m", "add feature.txt"], worktreePath);

      await client.rpc("task.updateStatus", { taskId: task1Id, status: "in-progress" });
      await client.rpc("task.updateStatus", { taskId: task1Id, status: "review" });
      await client.rpc("task.updateStatus", { taskId: task1Id, status: "merging" });

      const mergeResult = await client.rpc("task.merge", { taskId: task1Id });
      const mergedOk = mergeResult.task.status === "done";

      const logOutput = runGitSync(["log", "--oneline", "--all"], repoDir).stdout ?? "";
      const commitVisibleOnMain = logOutput.includes("add feature.txt");
      const fileExistsOnMain = existsSync(path.join(repoDir, "feature.txt"));
      const branchMergedOutput = runGitSync(["branch", "--merged", "main"], repoDir).stdout ?? "";
      // `git branch --merged` 對「目前分支」用 `* ` 前綴,對「目前簽出在另一個
      // worktree 裡的分支」用 `+ ` 前綴(這裡的任務分支這時候還簽出在
      // worktreePath 這個 worktree 裡,worktree 要等外層清理階段的
      // task.delete 才會移除)——兩種前綴都要去掉才能正確比對分支名稱。
      const branchMerged = branchMergedOutput
        .split(/\r?\n/)
        .some((line) => line.trim().replace(/^[*+]\s*/, "") === branch);

      record(
        "步驟16a task.merge 合併成功(worktree 內真實 commit → review → merging → task.merge → done," +
          "baseDir git log 看得到 commit、分支已合併)",
        featureCommit.status === 0 && mergedOk && commitVisibleOnMain && fileExistsOnMain && branchMerged,
        `featureCommitStatus=${featureCommit.status}, mergeResult.task.status=${mergeResult.task.status}, ` +
          `commitVisibleOnMain=${commitVisibleOnMain}, fileExistsOnMain=${fileExistsOnMain}, branchMerged=${branchMerged}, branch=${branch}\n` +
          `git log --oneline --all(baseDir):\n${logOutput}`,
      );
    } catch (err) {
      record("步驟16a task.merge 合併成功路徑", false, String(err));
    }

    // ---- 16c: request_review(直接打 gateway 的 message.requestReview,決定性)----
    //
    // S5(dispose-gate)補充:這個任務必須帶一條會通過的 `acceptance`,
    // request_review(映射到 in-progress→review)才會被 S5 的驗收閘自動放行
    // ——沒有 acceptance 的任務現在會改成「等待人類核可」而不是直接推進(見
    // task-service.ts 的 applyHumanReviewGate()/dispose-gate-and-lead_detail.md
    // §1.2)。這是這輪(S5)刻意的行為變更,不是回歸:步驟16c 原本測的是
    // 「request_review 能推進任務進 review + reviewer 收到訊息」,加一條確定
    // 會 exit 0 的驗收指令維持這個斷言不變,同時額外驗證了 S5 的機器放行路徑
    // 對 request_review 這個入口同樣生效。
    const passCommand16c = `${JSON.stringify(process.execPath)} -e "process.exit(0)"`;
    try {
      const created = await client.rpc("task.create", {
        teamId,
        title: "E2E Merge Task 2 (request_review)",
        acceptance: { commands: [passCommand16c] },
      });
      task2Id = created.task.id;
      await client.rpc("task.assign", { taskId: task2Id, memberId: coderId });
      await client.rpc("task.updateStatus", { taskId: task2Id, status: "in-progress" });

      const reviewOutcome = await client.rpc("message.requestReview", {
        teamId,
        fromMemberId: coderId,
        to: "Reviewer",
        taskId: task2Id,
      });
      const task2AfterReview = await client.rpc("task.get", { taskId: task2Id });

      const taskMovedToReview =
        reviewOutcome.taskUpdated &&
        reviewOutcome.taskFromStatus === "in-progress" &&
        reviewOutcome.taskToStatus === "review" &&
        task2AfterReview.task.status === "review";
      const messageOk =
        reviewOutcome.message.to === "Reviewer" &&
        reviewOutcome.message.content.includes("請審查") &&
        reviewOutcome.message.content.includes("E2E Merge Task 2");

      const historyResult = await client.rpc("team.messages", { teamId });
      const messageInHistory = historyResult.messages.some(
        (m) => m.id === reviewOutcome.message.id && m.to === "Reviewer",
      );

      record(
        "步驟16c request_review(message.requestReview)推進任務進 review + reviewer 收到的訊息可從 team.messages 查得到",
        taskMovedToReview && messageOk && messageInHistory,
        `taskMovedToReview=${taskMovedToReview}(from=${reviewOutcome.taskFromStatus}, to=${reviewOutcome.taskToStatus}, ` +
          `task2.status=${task2AfterReview.task.status}), messageOk=${messageOk}(content=${reviewOutcome.message.content}), ` +
          `delivered=${reviewOutcome.delivered}, messageInHistory=${messageInHistory}`,
      );
    } catch (err) {
      record("步驟16c request_review", false, String(err));
    }

    // ---- 16d: agent 不能自己合併到 done ----
    try {
      if (!task2Id) throw new Error("task2Id 未建立(16c 失敗),無法測試 16d");
      // task2 目前應該是 review(16c 結果)——先合法推進到 merging,再嘗試用
      // report_status(done) 企圖繞過人類批准(task.merge)直接把任務標記完成。
      await client.rpc("task.updateStatus", { taskId: task2Id, status: "merging" });
      const bypassAttempt = await client.rpc("message.reportStatus", {
        teamId,
        fromMemberId: coderId,
        status: "done",
        taskId: task2Id,
      });
      const task2AfterBypass = await client.rpc("task.get", { taskId: task2Id });

      const stillMerging = task2AfterBypass.task.status === "merging";
      const explainedInMessage =
        bypassAttempt.message.content.includes("未同步") && bypassAttempt.message.content.includes("task.merge");

      record(
        "步驟16d agent 無法透過 report_status(done)自行把任務標記完成(仍留在 merging,需人類經 task.merge 走完最後一哩)",
        stillMerging && explainedInMessage,
        `stillMerging=${stillMerging}(task2.status=${task2AfterBypass.task.status}), explainedInMessage=${explainedInMessage}, ` +
          `message=${bypassAttempt.message.content}`,
      );
    } catch (err) {
      record("步驟16d agent 無法自行合併到 done", false, String(err));
    }

    // ---- 16e: task.delete 的 hadUncommittedChanges 旗標 ----
    let task3Id;
    let task4Id;
    try {
      // (1) worktree 有未 commit 的變更:應回 hadUncommittedChanges=true。
      const created3 = await client.rpc("task.create", { teamId, title: "E2E Merge Task 3 (uncommitted)" });
      task3Id = created3.task.id;
      const assigned3 = await client.rpc("task.assign", { taskId: task3Id, memberId: coderId });
      writeFileSync(path.join(assigned3.workspace.worktreePath, "scratch.txt"), "not committed\n", "utf8");
      const deleteResult3 = await client.rpc("task.delete", { taskId: task3Id });
      task3Id = undefined; // 已刪除,finally 不需要再刪一次

      // (2) worktree 乾淨、沒有任何變更:應回 hadUncommittedChanges=false。
      const created4 = await client.rpc("task.create", { teamId, title: "E2E Merge Task 4 (clean)" });
      task4Id = created4.task.id;
      await client.rpc("task.assign", { taskId: task4Id, memberId: coderId });
      const deleteResult4 = await client.rpc("task.delete", { taskId: task4Id });
      task4Id = undefined;

      record(
        "步驟16e task.delete 回應正確帶出 hadUncommittedChanges(worktree 有未 commit 變更 → true;乾淨 worktree → false)",
        deleteResult3.hadUncommittedChanges === true && deleteResult4.hadUncommittedChanges === false,
        `dirty.hadUncommittedChanges=${deleteResult3.hadUncommittedChanges}, clean.hadUncommittedChanges=${deleteResult4.hadUncommittedChanges}`,
      );
    } catch (err) {
      record("步驟16e task.delete hadUncommittedChanges 旗標", false, String(err));
    } finally {
      for (const id of [task3Id, task4Id]) {
        if (!id) continue;
        try {
          await client.rpc("task.delete", { taskId: id });
        } catch (err) {
          log(`[cleanup] 刪除步驟16e任務(${id})時發生錯誤(忽略): ${err}`);
        }
      }
    }
  } finally {
    // ---- 清理:task1(done,仍持有 worktree)、task2(merging)一併刪除;
    // 最後移除整個暫存 git repo 與 worktree 根目錄。----
    for (const taskId of [task1Id, task2Id]) {
      if (!taskId) continue;
      try {
        await client.rpc("task.delete", { taskId });
      } catch (err) {
        log(`[cleanup] 刪除步驟16任務(${taskId})時發生錯誤(忽略): ${err}`);
      }
    }
    try {
      rmSync(repoDir, { recursive: true, force: true });
    } catch (err) {
      log(`[cleanup] 刪除步驟16暫存 git repo(${repoDir})時發生錯誤(忽略): ${err}`);
    }
    try {
      rmSync(worktreeRoot, { recursive: true, force: true });
    } catch (err) {
      log(`[cleanup] 刪除步驟16 worktree 根目錄(${worktreeRoot})時發生錯誤(忽略): ${err}`);
    }
  }

  // ==== 16b: 合併衝突路徑(獨立的暫存 repo,避免弄髒上面共用的 repo)====
  const conflictRepoDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-conflict-"));
  const conflictWorktreeRoot = path.join(path.dirname(conflictRepoDir), ".deskmony-worktrees");
  let conflictTaskId;
  try {
    runGitSync(["init", "-b", "main"], conflictRepoDir);
    runGitSync(["config", "user.email", "e2e@deskmony.local"], conflictRepoDir);
    runGitSync(["config", "user.name", "Deskmony E2E"], conflictRepoDir);
    writeFileSync(path.join(conflictRepoDir, "conflict.txt"), "original\n", "utf8");
    runGitSync(["add", "."], conflictRepoDir);
    runGitSync(["commit", "-m", "initial commit"], conflictRepoDir);

    const team = await client.rpc("team.create", { name: "E2E Conflict Team", workingDir: conflictRepoDir });
    const conflictTeamId = team.team.id;
    const profileCreated = await client.rpc("profile.create", {
      name: "E2E Conflict Coder Profile",
      software: "claude-agent-sdk",
      workingDir: conflictRepoDir,
    });
    const member = await client.rpc("team.addMember", {
      teamId: conflictTeamId,
      agentProfileId: profileCreated.profile.id,
      name: "Coder",
      role: "Coder",
      canInterrupt: false,
    });

    const created = await client.rpc("task.create", { teamId: conflictTeamId, title: "E2E Conflict Task" });
    conflictTaskId = created.task.id;
    const assigned = await client.rpc("task.assign", { taskId: conflictTaskId, memberId: member.member.id });
    const worktreePath = assigned.workspace.worktreePath;
    const branch = assigned.workspace.branch;

    // worktree 上修改同一個檔案並 commit。
    writeFileSync(path.join(worktreePath, "conflict.txt"), "worktree change\n", "utf8");
    runGitSync(["add", "."], worktreePath);
    runGitSync(["commit", "-m", "worktree change"], worktreePath);

    // baseDir(主幹)上也修改同一個檔案並 commit,製造真正的合併衝突。
    writeFileSync(path.join(conflictRepoDir, "conflict.txt"), "main change\n", "utf8");
    runGitSync(["add", "."], conflictRepoDir);
    runGitSync(["commit", "-m", "main change"], conflictRepoDir);

    await client.rpc("task.updateStatus", { taskId: conflictTaskId, status: "in-progress" });
    await client.rpc("task.updateStatus", { taskId: conflictTaskId, status: "review" });
    await client.rpc("task.updateStatus", { taskId: conflictTaskId, status: "merging" });

    let mergeRejected = false;
    let mergeErrorMessage = "";
    try {
      await client.rpc("task.merge", { taskId: conflictTaskId });
    } catch (err) {
      mergeRejected = true;
      mergeErrorMessage = String(err);
    }

    const taskAfterConflict = await client.rpc("task.get", { taskId: conflictTaskId });
    const stillMerging = taskAfterConflict.task.status === "merging";

    const statusAfterConflict = runGitSync(["status", "--porcelain"], conflictRepoDir).stdout ?? "";
    const baseDirClean = statusAfterConflict.trim().length === 0;
    const mergeHeadPath = path.join(conflictRepoDir, ".git", "MERGE_HEAD");
    const noResidualMergeState = !existsSync(mergeHeadPath);

    record(
      "步驟16b task.merge 合併衝突自動 abort 還原(task.merge 失敗、任務留在 merging、baseDir 乾淨無殘留合併狀態)",
      mergeRejected && stillMerging && baseDirClean && noResidualMergeState,
      `mergeRejected=${mergeRejected}(${mergeErrorMessage}), stillMerging=${stillMerging}(status=${taskAfterConflict.task.status}), ` +
        `baseDirClean=${baseDirClean}, noResidualMergeState=${noResidualMergeState}, branch=${branch}\n` +
        `git status --porcelain(baseDir,合併失敗後):\n${statusAfterConflict}`,
    );
  } catch (err) {
    record("步驟16b task.merge 合併衝突路徑", false, String(err));
  } finally {
    if (conflictTaskId) {
      try {
        await client.rpc("task.delete", { taskId: conflictTaskId });
      } catch (err) {
        log(`[cleanup] 刪除步驟16b衝突任務時發生錯誤(忽略): ${err}`);
      }
    }
    try {
      rmSync(conflictRepoDir, { recursive: true, force: true });
    } catch (err) {
      log(`[cleanup] 刪除步驟16b暫存 git repo(${conflictRepoDir})時發生錯誤(忽略): ${err}`);
    }
    try {
      rmSync(conflictWorktreeRoot, { recursive: true, force: true });
    } catch (err) {
      log(`[cleanup] 刪除步驟16b worktree 根目錄(${conflictWorktreeRoot})時發生錯誤(忽略): ${err}`);
    }
  }
}

// ---------------------------------------------------------------------
// 步驟 29: usage-metering(S3a,決定性測試,不依賴任何真實模型)
//
// 29a-29c 全程用 scripts/fake-acp-agent.mjs 的 USAGE_UPDATE_PREFIX 模式(見該
// 檔案 handleUsageUpdate()),驗證 packages/adapters/src/acp-adapter.ts 的
// handleSessionUpdate() 對 "usage_update" 的轉換:
//   29a capabilities() 對 usage/context 兩項回報 "unknown"(§7.5 ④ 修正:
//       ACP 這一層無法靜態決定,要看被 spawn 的是哪個 agent)。
//   29b cost 有給:context-usage 逐次發(值正確)+ usage 在 completed 之前
//       補發一次(costAmount/costCurrency 正確)。
//   29c cost 從未回報過(這個連線整個 session 都沒有 cost):只有
//       context-usage,完全不發 usage 事件——這是 L4 §3 表格「cost 一直沒有
//       → 不猜、不估」的決定性驗證。
//   29d ClaudeAgentSdkAdapter 的用量路線(§7.5 ⑤)——**需要真實憑證**,見該
//       段落自己的說明。斷言的是「usage 事件有沒有發、欄位對不對、順序對不
//       對」這種系統行為,不是模型當輪講了什麼,故仍屬 deterministic 分組。
// ---------------------------------------------------------------------
async function usageMeteringSmokeTest(client, workspaceDir) {
  const fakeAgentPath = path.join(REPO_ROOT, "scripts", "fake-acp-agent.mjs");

  try {
    const caps = await client.rpc("adapter.capabilities", { software: "acp" });
    // §7.5 ④:這裡刻意斷言 "unknown" 而不是 "supported"。AcpAdapter 確實有
    // usage_update 的轉發邏輯(29b/29c 就是在驗證它),但「agent 會不會送這個
    // 通知」不是 adapter 能決定的——實測 Claude Code 經 bridge 一次都不送。
    // 回報 "supported" 會讓 UI 對那個 profile 顯示「有花費可看」然後永遠空著。
    const ok = caps.capabilities.usageReporting === "unknown" && caps.capabilities.contextReporting === "unknown";
    record(
      '步驟29a AcpAdapter capabilities() 回報 usageReporting="unknown"、contextReporting="unknown"(不對 UI 說謊,收斂交給實際收到的事件)',
      ok,
      JSON.stringify(caps.capabilities),
    );
  } catch (err) {
    record("步驟29a AcpAdapter capabilities usageReporting/contextReporting", false, String(err));
  }

  let sessionWithCost;
  try {
    const profileCreated = await client.rpc("profile.create", {
      name: "E2E Usage Metering (with cost)",
      software: "acp",
      workingDir: workspaceDir,
      acpConfig: { command: process.execPath, args: [fakeAgentPath] },
    });
    const sessionCreated = await client.rpc(
      "session.create",
      { agentProfileId: profileCreated.profile.id, workingDir: workspaceDir, title: "e2e-usage-with-cost" },
      30_000,
    );
    sessionWithCost = sessionCreated.session.id;

    const payload = { used: 1234, size: 200_000, cost: { amount: 0.0567, currency: "USD" } };
    const prompt = `${USAGE_UPDATE_PREFIX}${JSON.stringify(payload)}`;
    const { finalEvent, collected } = await client.drivePrompt(sessionWithCost, prompt, {
      onPermission: async () => "deny", // 不應該觸發權限請求
      timeoutMs: 20_000,
    });

    const contextEvent = collected.find((e) => e.event.type === "context-usage");
    const usageIdx = collected.findIndex((e) => e.event.type === "usage");
    const completedIdx = collected.findIndex((e) => e.event.type === "completed");
    const usageEvent = usageIdx !== -1 ? collected[usageIdx].event : undefined;

    const contextOk = Boolean(contextEvent && contextEvent.event.used === payload.used && contextEvent.event.size === payload.size);
    const usageOk = Boolean(
      usageEvent && usageEvent.costAmount === payload.cost.amount && usageEvent.costCurrency === payload.cost.currency,
    );
    const orderOk = usageIdx !== -1 && completedIdx !== -1 && usageIdx < completedIdx;

    record(
      "步驟29b ACP usage_update(有 cost):context-usage 正確轉發,usage 在 completed 之前補發一次且 costAmount/costCurrency 正確",
      contextOk && usageOk && orderOk && finalEvent.event.type === "completed",
      `context=${JSON.stringify(contextEvent?.event)}, usage=${JSON.stringify(usageEvent)}, usageIdx=${usageIdx}, completedIdx=${completedIdx}`,
    );
  } catch (err) {
    record("步驟29b ACP usage_update(有 cost)", false, String(err));
  } finally {
    if (sessionWithCost) {
      try {
        await client.rpc("session.delete", { sessionId: sessionWithCost });
      } catch (err) {
        log(`[cleanup] 刪除步驟29b session 時發生錯誤(忽略): ${err}`);
      }
    }
  }

  let sessionNoCost;
  try {
    const profileCreated = await client.rpc("profile.create", {
      name: "E2E Usage Metering (no cost)",
      software: "acp",
      workingDir: workspaceDir,
      acpConfig: { command: process.execPath, args: [fakeAgentPath] },
    });
    const sessionCreated = await client.rpc(
      "session.create",
      { agentProfileId: profileCreated.profile.id, workingDir: workspaceDir, title: "e2e-usage-no-cost" },
      30_000,
    );
    sessionNoCost = sessionCreated.session.id;

    const payload = { used: 500, size: 100_000 }; // 刻意不帶 cost
    const prompt = `${USAGE_UPDATE_PREFIX}${JSON.stringify(payload)}`;
    const { finalEvent, collected } = await client.drivePrompt(sessionNoCost, prompt, {
      onPermission: async () => "deny",
      timeoutMs: 20_000,
    });

    const contextEvent = collected.find((e) => e.event.type === "context-usage");
    const usageEvent = collected.find((e) => e.event.type === "usage");
    const contextOk = Boolean(contextEvent && contextEvent.event.used === payload.used && contextEvent.event.size === payload.size);

    record(
      "步驟29c ACP usage_update(從未回報 cost):只發 context-usage,完全不發 usage 事件(L4 §3:不猜、不估)",
      contextOk && !usageEvent && finalEvent.event.type === "completed",
      `context=${JSON.stringify(contextEvent?.event)}, usageEvent存在=${Boolean(usageEvent)}`,
    );
  } catch (err) {
    record("步驟29c ACP usage_update(從未回報 cost)", false, String(err));
  } finally {
    if (sessionNoCost) {
      try {
        await client.rpc("session.delete", { sessionId: sessionNoCost });
      } catch (err) {
        log(`[cleanup] 刪除步驟29c session 時發生錯誤(忽略): ${err}`);
      }
    }
  }

  // ---- 29d: ClaudeAgentSdkAdapter 的用量路線(§7.5 ⑤) ----
  //
  // ⚠️ 這個檢查點**必須跑真實的 Claude Code session**(與步驟 3/4/6/13/14/20
  // 相同的前置需求:本機有可用登入憑證或 ANTHROPIC_API_KEY),沒有 fake 版本
  // 可用——用量數字是 SDK 內部從真實 API 回應累計出來的,`scripts/` 底下的
  // 假後端(fake-acp-agent / fake-opencode-server)都不經過 claude-agent-sdk,
  // 造不出 `SDKResultMessage`。這是「經 ACP 拿不到用量、只能走 SDK」這個實測
  // 結論的直接代價,不是測試寫得不夠好。
  //
  // 斷言的是系統行為(事件有沒有發/欄位型別/與 completed 的先後),不是模型
  // 講了什麼,所以歸在 deterministic 分組:同樣的程式碼跑幾次結果都一樣,
  // 唯一會浮動的是金額本身的大小(故只斷言 > 0 與型別,不斷言具體數值)。
  try {
    const caps = await client.rpc("adapter.capabilities", { software: "claude-agent-sdk" });
    const capsOk =
      caps.capabilities.usageReporting === "supported" && caps.capabilities.contextReporting === "unsupported";
    record(
      '步驟29d-1 ClaudeAgentSdkAdapter capabilities() 回報 usageReporting="supported"(已接上 SDKResultMessage 轉發)、contextReporting="unsupported"(沒有 context gauge 來源,不猜)',
      capsOk,
      JSON.stringify(caps.capabilities),
    );
  } catch (err) {
    record("步驟29d-1 ClaudeAgentSdkAdapter capabilities usageReporting/contextReporting", false, String(err));
  }

  let sdkUsageSessionId;
  try {
    const profileCreated = await client.rpc("profile.create", {
      name: "E2E Usage Metering (claude-agent-sdk)",
      software: "claude-agent-sdk",
      workingDir: workspaceDir,
    });
    const sessionCreated = await client.rpc(
      "session.create",
      { agentProfileId: profileCreated.profile.id, workingDir: workspaceDir, title: "e2e-usage-sdk" },
      30_000,
    );
    sdkUsageSessionId = sessionCreated.session.id;

    const { finalEvent, collected } = await client.drivePrompt(
      sdkUsageSessionId,
      "請只回覆兩個字:收到",
      { onPermission: async () => "deny", timeoutMs: 120_000 }, // 這一輪不該需要任何工具
    );

    const usageIdx = collected.findIndex((e) => e.event.type === "usage");
    const endIdx = collected.findIndex((e) => e.event.type === "completed" || e.event.type === "error");
    const usageEvent = usageIdx !== -1 ? collected[usageIdx].event : undefined;

    // total_cost_usd 是**累計**值(已用真實憑證跑兩輪實測確認:0.157881 →
    // 0.16590749 單調遞增),幣別由欄位名稱固定為 USD。
    const costOk = Boolean(usageEvent && typeof usageEvent.costAmount === "number" && usageEvent.costAmount > 0);
    const currencyOk = usageEvent?.costCurrency === "USD";
    // token 明細取自 modelUsage(累計),不是頂層 usage(實測是 per-turn)——
    // 見 claude-sdk-adapter.ts 的 flushUsage() 註解。
    const tokensOk = Boolean(
      usageEvent &&
        typeof usageEvent.inputTokens === "number" &&
        typeof usageEvent.outputTokens === "number" &&
        typeof usageEvent.cacheReadTokens === "number" &&
        typeof usageEvent.cacheCreationTokens === "number" &&
        usageEvent.outputTokens > 0,
    );
    // 回合末順序:usage 必須在 completed/error 之前(與 AcpAdapter 的 flushUsage
    // 時序一致,UI 才不會先看到「回合結束」再跳出金額)。
    const orderOk = usageIdx !== -1 && endIdx !== -1 && usageIdx < endIdx;
    // 這個 session 全程只用一個 model ⇒ modelUsage 只有一個 key ⇒ 應該帶 model。
    const modelOk = typeof usageEvent?.model === "string" && usageEvent.model.length > 0;
    // context-usage 一個都不該有(contextReporting="unsupported" 的如實對照)。
    const noContextEvent = !collected.some((e) => e.event.type === "context-usage");

    record(
      "步驟29d-2 claude-agent-sdk 回合末發出 usage 事件(costAmount 累計$>0、costCurrency=USD、token 明細齊全、在 completed 之前、單一 model 時帶 model、且不發 context-usage)",
      costOk && currencyOk && tokensOk && orderOk && modelOk && noContextEvent && finalEvent.event.type === "completed",
      `usage=${JSON.stringify(usageEvent)}, usageIdx=${usageIdx}, endIdx=${endIdx}, ` +
        `costOk=${costOk}, currencyOk=${currencyOk}, tokensOk=${tokensOk}, orderOk=${orderOk}, modelOk=${modelOk}, ` +
        `noContextEvent=${noContextEvent}, final=${finalEvent.event.type}`,
    );
  } catch (err) {
    record("步驟29d-2 claude-agent-sdk 回合末 usage 事件", false, String(err));
  } finally {
    if (sdkUsageSessionId) {
      try {
        await client.rpc("session.delete", { sessionId: sdkUsageSessionId });
      } catch (err) {
        log(`[cleanup] 刪除步驟29d session 時發生錯誤(忽略): ${err}`);
      }
    }
  }
}

// ---------------------------------------------------------------------
// 步驟 31: slash command(這輪新增,決定性測試——斷言的是協定/事件轉換與
// 路由邏輯是否正確,不是模型自由選擇的用詞,即使 31f 底下真的起一個
// claude-agent-sdk session 也一樣,分類原則見上方步驟29
// usageMeteringSmokeTest() 的同一套先例)
//
//   31a ACP:capabilities().slashCommands === "unknown";session.getSlashCommands
//       在收到推播前回報 observed:false;送 AVAILABLE_COMMANDS_PREFIX prompt後,
//       available-commands 事件與 pull 兩者內容一致、observed 收斂成 true。
//   31b OpenCode:capabilities().slashCommands === "unknown";spawn 後(不需要
//       送任何 prompt)自動推播一次 available-commands,內容對應
//       fake-opencode-server.mjs 的 TEST_COMMANDS,argumentHint 依 hints
//       是否非空正確 coalesce。
//   31c OpenCode:送 "/greet world"(已知指令)真的打到 POST /session/{id}/command
//       (回覆帶 [command:greet args:world] 標記),不是 /message。
//   31d OpenCode:送 "/nonexistent-cmd hello"(/ 開頭但不是已知指令)仍照舊打到
//       /message(回覆是既有的 FAKE_OPENCODE_REPLY_CHUNKS,不含 [command:...] 標記)。
//   31e OpenCode:送 "/greeting hi"(已知指令 "greet" 的 prefix,但本身不是已知
//       指令全名)同樣落到 /message,不誤配——驗證比對邏輯是完整 token 相等,
//       不是 startsWith/prefix。
//   31f claude-agent-sdk(真實模型,見步驟29d 的同一套先例,判定的是系統行為
//       不是模型講什麼,故仍歸 deterministic):capabilities().slashCommands ===
//       "supported";spawn 後(不需要送任何 prompt)fire-and-forget 推播一次
//       available-commands,清單非空。
// ---------------------------------------------------------------------
async function slashCommandSmokeTest(client, workspaceDir) {
  const fakeAgentPath = path.join(REPO_ROOT, "scripts", "fake-acp-agent.mjs");
  const fakeOpencodeServerPath = path.join(REPO_ROOT, "scripts", "fake-opencode-server.mjs");

  // ---- 31a: ACP ----
  let acpSessionId;
  try {
    const caps = await client.rpc("adapter.capabilities", { software: "acp" });
    const capsOk = caps.capabilities.slashCommands === "unknown";

    const profileCreated = await client.rpc("profile.create", {
      name: "E2E Slash Command (acp)",
      software: "acp",
      workingDir: workspaceDir,
      acpConfig: { command: process.execPath, args: [fakeAgentPath] },
    });
    const sessionCreated = await client.rpc(
      "session.create",
      { agentProfileId: profileCreated.profile.id, workingDir: workspaceDir, title: "e2e-slash-acp" },
      30_000,
    );
    acpSessionId = sessionCreated.session.id;

    const beforePush = await client.rpc("session.getSlashCommands", { sessionId: acpSessionId });
    const beforeOk = beforePush.observed === false && beforePush.commands.length === 0;

    const payload = { commands: [{ name: "foo", description: "Foo cmd", hint: "<arg>" }, { name: "bar" }] };
    const prompt = `${AVAILABLE_COMMANDS_PREFIX}${JSON.stringify(payload)}`;
    const { finalEvent, collected } = await client.drivePrompt(acpSessionId, prompt, {
      onPermission: async () => "deny", // 不應該觸發權限請求
      timeoutMs: 20_000,
    });

    const commandsEvent = collected.find((e) => e.event.type === "available-commands");
    const foo = commandsEvent?.event.commands.find((c) => c.name === "foo");
    const bar = commandsEvent?.event.commands.find((c) => c.name === "bar");
    const eventOk = Boolean(
      commandsEvent &&
        commandsEvent.event.commands.length === 2 &&
        foo?.description === "Foo cmd" &&
        foo?.argumentHint === "<arg>" &&
        !bar?.description &&
        !bar?.argumentHint,
    );

    const afterPush = await client.rpc("session.getSlashCommands", { sessionId: acpSessionId });
    const afterOk = afterPush.observed === true && afterPush.commands.length === 2;

    record(
      '步驟31a ACP capabilities().slashCommands="unknown" + available_commands_update 正確轉發(REPLACE 語意、description/argumentHint coalescing)+ session.getSlashCommands pull 與 observed 收斂',
      capsOk && beforeOk && eventOk && afterOk && finalEvent.event.type === "completed",
      `caps=${JSON.stringify(caps.capabilities)}, before=${JSON.stringify(beforePush)}, event=${JSON.stringify(commandsEvent?.event)}, after=${JSON.stringify(afterPush)}`,
    );
  } catch (err) {
    record("步驟31a ACP slash command", false, String(err));
  } finally {
    if (acpSessionId) {
      try {
        await client.rpc("session.delete", { sessionId: acpSessionId });
      } catch (err) {
        log(`[cleanup] 刪除步驟31a session 時發生錯誤(忽略): ${err}`);
      }
    }
  }

  // ---- 31b-31e: OpenCode ----
  let opencodeSessionId;
  try {
    const caps = await client.rpc("adapter.capabilities", { software: "opencode" });
    const capsOk = caps.capabilities.slashCommands === "unknown";

    const profileCreated = await client.rpc("profile.create", {
      name: "E2E Slash Command (opencode)",
      software: "opencode",
      workingDir: workspaceDir,
      opencodeConfig: { command: process.execPath, args: [fakeOpencodeServerPath] },
    });
    const sessionCreated = await client.rpc(
      "session.create",
      { agentProfileId: profileCreated.profile.id, workingDir: workspaceDir, title: "e2e-slash-opencode" },
      30_000,
    );
    opencodeSessionId = sessionCreated.session.id;

    // spawn() 內已 await 過一次 GET /command 才回傳 handle(見
    // opencode-adapter.ts 的查證註解),event 這時多半已經在 client.events
    // 緩衝區裡,waitForEvent() 兩種情況都能處理(已存在的/之後才到的)。
    const commandsEvent = await client.waitForEvent(
      (e) => e.sessionId === opencodeSessionId && e.event.type === "available-commands",
      10_000,
    );
    const greet = commandsEvent.event.commands.find((c) => c.name === "greet");
    const noop = commandsEvent.event.commands.find((c) => c.name === "noop");
    const eventOk = Boolean(
      commandsEvent.event.commands.length === TEST_COMMANDS.length &&
        greet?.description === "fake greet command" &&
        greet?.argumentHint === "$ARGUMENTS" &&
        noop?.description === "fake no-arg command" &&
        !noop?.argumentHint,
    );

    const pulled = await client.rpc("session.getSlashCommands", { sessionId: opencodeSessionId });
    const pullOk = pulled.observed === true && pulled.commands.length === TEST_COMMANDS.length;

    record(
      '步驟31b OpenCode capabilities().slashCommands="unknown" + spawn 後自動推播 GET /command 結果(不需要送任何 prompt)+ argumentHint coalescing(有 hints 才給值)+ session.getSlashCommands pull',
      capsOk && eventOk && pullOk,
      `caps=${JSON.stringify(caps.capabilities)}, event=${JSON.stringify(commandsEvent.event)}, pulled=${JSON.stringify(pulled)}`,
    );
  } catch (err) {
    record("步驟31b OpenCode slash command 清單推播", false, String(err));
  }

  if (opencodeSessionId) {
    try {
      const { finalEvent, collected } = await client.drivePrompt(opencodeSessionId, "/greet world", {
        onPermission: async () => "deny",
        timeoutMs: 20_000,
      });
      const { groups, violation } = analyzeMessageDeltas(collected);
      const fullText = groups.map((g) => g.text).join("");
      const ok = finalEvent.event.type === "completed" && !violation && fullText.includes("[command:greet args:world]");
      record(
        '步驟31c OpenCode 送 "/greet world"(已知指令)打到 POST /session/{id}/command,不是 /message(回覆帶 [command:greet args:world] 標記)',
        ok,
        violation ? `違規: ${violation}` : `fullText=${JSON.stringify(fullText)}`,
      );
    } catch (err) {
      record("步驟31c OpenCode 已知指令路由到 /command", false, String(err));
    }

    try {
      const { finalEvent, collected } = await client.drivePrompt(opencodeSessionId, "/nonexistent-cmd hello", {
        onPermission: async () => "deny",
        timeoutMs: 20_000,
      });
      const { groups, violation } = analyzeMessageDeltas(collected);
      const fullText = groups.map((g) => g.text).join("");
      const ok =
        finalEvent.event.type === "completed" &&
        !violation &&
        !fullText.includes("[command:") &&
        fullText === FAKE_OPENCODE_REPLY_CHUNKS.join("");
      record(
        '步驟31d OpenCode 送 "/nonexistent-cmd hello"(/ 開頭但不是已知指令)仍照舊打到 /message,不誤傷既有行為',
        ok,
        violation ? `違規: ${violation}` : `fullText=${JSON.stringify(fullText)}`,
      );
    } catch (err) {
      record("步驟31d OpenCode 未知指令落回 /message", false, String(err));
    }

    try {
      const { finalEvent, collected } = await client.drivePrompt(opencodeSessionId, "/greeting hi", {
        onPermission: async () => "deny",
        timeoutMs: 20_000,
      });
      const { groups, violation } = analyzeMessageDeltas(collected);
      const fullText = groups.map((g) => g.text).join("");
      const ok =
        finalEvent.event.type === "completed" &&
        !violation &&
        !fullText.includes("[command:") &&
        fullText === FAKE_OPENCODE_REPLY_CHUNKS.join("");
      record(
        '步驟31e OpenCode 送 "/greeting hi"(已知指令 "greet" 的 prefix,非完整比對)不誤配,落回 /message',
        ok,
        violation ? `違規: ${violation}` : `fullText=${JSON.stringify(fullText)}`,
      );
    } catch (err) {
      record("步驟31e OpenCode prefix 不誤配", false, String(err));
    }

    try {
      await client.rpc("session.delete", { sessionId: opencodeSessionId });
    } catch (err) {
      log(`[cleanup] 刪除步驟31b-e session 時發生錯誤(忽略): ${err}`);
    }
  }

  // ---- 31f: claude-agent-sdk(真實模型,見步驟29d 的同一套先例)----
  let sdkSessionId;
  try {
    const caps = await client.rpc("adapter.capabilities", { software: "claude-agent-sdk" });
    const capsOk = caps.capabilities.slashCommands === "supported";

    const profileCreated = await client.rpc("profile.create", {
      name: "E2E Slash Command (claude-agent-sdk)",
      software: "claude-agent-sdk",
      workingDir: workspaceDir,
    });
    const sessionCreated = await client.rpc(
      "session.create",
      { agentProfileId: profileCreated.profile.id, workingDir: workspaceDir, title: "e2e-slash-sdk" },
      30_000,
    );
    sdkSessionId = sessionCreated.session.id;

    // 不需要送任何 prompt——`supportedCommands()` 是 spawn() 後 fire-and-forget
    // 呼叫的 CLI control-request(已用真實憑證實測不需要先送一輪對話,見
    // claude-sdk-adapter.ts 的查證註解),等這則 available-commands 事件即可。
    const commandsEvent = await client.waitForEvent(
      (e) => e.sessionId === sdkSessionId && e.event.type === "available-commands",
      30_000,
    );
    const eventOk = commandsEvent.event.commands.length > 0;

    const pulled = await client.rpc("session.getSlashCommands", { sessionId: sdkSessionId });
    const pullOk = pulled.observed === true && pulled.commands.length > 0;

    record(
      '步驟31f claude-agent-sdk capabilities().slashCommands="supported" + spawn 後 fire-and-forget 推播 supportedCommands() 結果(不需要送任何 prompt)+ session.getSlashCommands pull',
      capsOk && eventOk && pullOk,
      `caps=${JSON.stringify(caps.capabilities)}, commands數=${commandsEvent.event.commands.length}, pulled觀察=${pulled.observed}`,
    );
  } catch (err) {
    record("步驟31f claude-agent-sdk slash command 清單推播", false, String(err));
  } finally {
    if (sdkSessionId) {
      try {
        await client.rpc("session.delete", { sessionId: sdkSessionId });
      } catch (err) {
        log(`[cleanup] 刪除步驟31f session 時發生錯誤(忽略): ${err}`);
      }
    }
  }
}

// ---------------------------------------------------------------------
// 步驟 32: ACP scoped MCP bridge token(Phase 2,決定性測試,不依賴任何真實
// 模型/真實 codex-acp/gemini)。
//
// 核心手法:用 fake-acp-agent.mjs 建立真實的 `software:"acp"` session(團隊
// 成員或個人單機皆有),送出 `REPORT_MCP_SERVERS_PREFIX` 這個確定性 prompt,
// 讓假 agent 把它在 `session/new` 收到的 `mcpServers`(AcpAdapter.spawn() 真
// 的呼叫 `WsGateway.mintMcpBridgeToken()` 核發、透過 `SessionBuilder.
// withMcpServer()` 掛上的那組設定,含真實 scoped token)原樣回顯——藉此拿到
// 一個「真的由生產程式碼核發」的 token,而不是自己在測試裡憑空捏造一個假的
// grant。拿到之後分兩路驗證:
//   (a) 32b-32f:直接用這個 token 開一條新的 WS 連線(重用既有
//       `GatewayClient`),打各種白名單內/外、綁定範圍內/外、過期、撤銷後的
//       請求,決定性地驗證 apps/core/src/gateway/ws-gateway.ts 的
//       `checkScopedGrantAccess()`/`matchScopedToken()` 邏輯——這是最關鍵的
//       安全機制本身,不透過 MCP 協議繞一圈,斷言更直接、更快。
//   (b) 32g:用 `CALL_BRIDGE_TOOL_PREFIX` 讓假 agent **真的**把
//       mcp-bridge-server.ts 的編譯產物 spawn 成子行程,用真正的 MCP client
//       連上去呼叫一個工具——證明(a)驗證過的 token 真的能驅動完整的
//       ACP→bridge→WS→gateway→MessageBus 管線,產生真實可見的 side effect
//       (team_messages 多一筆),不是紙上談兵。
//
// `AcpAdapter` 的 `subagentPort` 這輪(見 apps/core/src/index.ts)已改成與
// `claudeAdapter` 共用同一個實例,全域生效——所以這裡建立的**任何** ACP
// session(不論有沒有 team)都會拿到 subagent 系列方法的授權,32d 特別驗證
// 「沒有 team 的 session,它的 token 確實拿不到 team-bus 系列方法」,確保
// scope 是真的照請求核發、不是無條件全授權。
// ---------------------------------------------------------------------

/** 把 `REPORT_MCP_SERVERS_PREFIX` 回覆的 `"MCP_SERVERS:[...]"` 文字轉成
 *  `{token, gatewayUrl, sessionId, teamId?, memberId?, subagentEnabled}`。
 *  沒有掛任何 MCP server 時(mcpServers 是空陣列)回傳 undefined。 */
function parseBridgeEnvFromReport(fullText) {
  const marker = "MCP_SERVERS:";
  const idx = fullText.indexOf(marker);
  if (idx === -1) return undefined;
  const mcpServers = JSON.parse(fullText.slice(idx + marker.length));
  if (!Array.isArray(mcpServers) || mcpServers.length === 0) return undefined;
  const server = mcpServers[0];
  const env = Object.fromEntries((server.env ?? []).map((e) => [e.name, e.value]));
  return {
    command: server.command,
    args: server.args ?? [],
    rawEnv: server.env ?? [],
    token: env.DESKMONY_MCP_BRIDGE_TOKEN,
    gatewayUrl: env.DESKMONY_MCP_BRIDGE_GATEWAY_URL,
    sessionId: env.DESKMONY_MCP_BRIDGE_SESSION_ID,
    teamId: env.DESKMONY_MCP_BRIDGE_TEAM_ID,
    memberId: env.DESKMONY_MCP_BRIDGE_MEMBER_ID,
    subagentEnabled: env.DESKMONY_MCP_BRIDGE_SUBAGENT_ENABLED === "1",
  };
}

/** 建一個 ACP session(fake-acp-agent.mjs),送出 REPORT_MCP_SERVERS_PREFIX,
 *  回傳解析後的 bridge env(見上方)——`undefined` 代表這個 session 沒有掛
 *  任何 MCP server(不應該發生,除非 tokenMinter/subagentPort 都沒注入)。 */
async function createAcpSessionAndGetBridgeEnv(client, acpProfileId, workspaceDir, title, teamMemberId) {
  const created = await client.rpc(
    "session.create",
    { agentProfileId: acpProfileId, workingDir: workspaceDir, title, ...(teamMemberId ? { teamMemberId } : {}) },
    30_000,
  );
  const sessionId = created.session.id;
  const { finalEvent, collected } = await client.drivePrompt(sessionId, REPORT_MCP_SERVERS_PREFIX, {
    onPermission: async () => "deny",
    timeoutMs: 20_000,
  });
  if (finalEvent.event.type !== "completed") {
    throw new Error(`REPORT_MCP_SERVERS 未正常 completed: ${JSON.stringify(finalEvent.event)}`);
  }
  const { groups } = analyzeMessageDeltas(collected);
  const fullText = groups.map((g) => g.text).join("");
  return { sessionId, bridgeEnv: parseBridgeEnvFromReport(fullText) };
}

/** 開一條新的 WS 連線,用給定的 token 認證。回傳 `{client, ok, error}`——
 *  認證失敗時 `ok:false`,`client` 仍然回傳(連線可能已被 server 端關閉,
 *  呼叫端不需要再手動 close)。 */
async function connectAndAuth(gatewayUrl, token) {
  const c = new GatewayClient(gatewayUrl);
  await c.connect();
  try {
    await c.rpc("auth", { token });
    return { client: c, ok: true };
  } catch (err) {
    return { client: c, ok: false, error: String(err) };
  }
}

async function scopedMcpBridgeTokenSmokeTest(client, workspaceDir) {
  const fakeAgentPath = path.join(REPO_ROOT, "scripts", "fake-acp-agent.mjs");

  // ---- 32a: 準備——team(Coder/Reviewer)+ ACP profile + 兩個 session
  //           (team 成員一個、沒有 team 的個人單機一個),各自取得真實核發的
  //           bridge env。----
  let teamId, coderMemberId, reviewerMemberId, teamSessionId, soloSessionId, repoDir, taskId;
  let teamBridgeEnv, soloBridgeEnv;
  try {
    const profileCreated = await client.rpc("profile.create", {
      name: "E2E Scoped MCP Bridge Token",
      software: "acp",
      workingDir: workspaceDir,
      acpConfig: { command: process.execPath, args: [fakeAgentPath] },
    });
    const acpProfileId = profileCreated.profile.id;

    // MessageBus.sendMessage()/broadcast() 的 contextId 推導(S2
    // message-budget)要求發送者當下有一個進行中的任務(assigned/
    // in-progress/review/merging),否則會被拒收(比照步驟13a 的既有先例)
    // ——這裡的 team 需要真的 git repo 當 workingDir 才能 task.assign。
    const gitVersion = runGitSync(["--version"], process.cwd());
    if (gitVersion.status !== 0) {
      record("步驟32(git 不可用,整個步驟略過)", false, `找不到可用的 git 執行檔: ${gitVersion.error ?? gitVersion.stderr}`);
      return;
    }
    repoDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-scoped-token-"));
    runGitSync(["init"], repoDir);
    runGitSync(["config", "user.email", "e2e@deskmony.local"], repoDir);
    runGitSync(["config", "user.name", "Deskmony E2E"], repoDir);
    writeFileSync(path.join(repoDir, "README.md"), "# e2e scoped mcp bridge token repo\n", "utf8");
    runGitSync(["add", "."], repoDir);
    runGitSync(["commit", "-m", "initial commit"], repoDir);

    const team = await client.rpc("team.create", { name: "E2E Scoped Token Team", workingDir: repoDir });
    teamId = team.team.id;
    const coder = await client.rpc("team.addMember", {
      teamId,
      agentProfileId: acpProfileId,
      name: "Coder",
      role: "Coder",
      canInterrupt: false,
      lifecycle: "persistent",
    });
    coderMemberId = coder.member.id;
    const reviewer = await client.rpc("team.addMember", {
      teamId,
      agentProfileId: acpProfileId,
      name: "Reviewer",
      role: "Reviewer",
      canInterrupt: false,
      lifecycle: "persistent",
    });
    reviewerMemberId = reviewer.member.id;

    // 指派一個任務給 coderMemberId(assigned 狀態),讓 message.sendMessage/
    // broadcast 的 contextId 能被推導出來(見上方註解)。
    const task = await client.rpc("task.create", { teamId, title: "E2E Scoped Token Task" });
    taskId = task.task.id;
    await client.rpc("task.assign", { taskId, memberId: coderMemberId });

    const teamResult = await createAcpSessionAndGetBridgeEnv(client, acpProfileId, workspaceDir, "e2e-scoped-team", coderMemberId);
    teamSessionId = teamResult.sessionId;
    teamBridgeEnv = teamResult.bridgeEnv;

    const soloResult = await createAcpSessionAndGetBridgeEnv(client, acpProfileId, workspaceDir, "e2e-scoped-solo", undefined);
    soloSessionId = soloResult.sessionId;
    soloBridgeEnv = soloResult.bridgeEnv;

    const ok =
      Boolean(teamBridgeEnv?.token) &&
      teamBridgeEnv.token.startsWith("dmbt_") &&
      teamBridgeEnv.teamId === teamId &&
      teamBridgeEnv.memberId === coderMemberId &&
      teamBridgeEnv.sessionId === teamSessionId &&
      teamBridgeEnv.subagentEnabled === true &&
      Boolean(soloBridgeEnv?.token) &&
      soloBridgeEnv.teamId === undefined &&
      soloBridgeEnv.sessionId === soloSessionId &&
      soloBridgeEnv.subagentEnabled === true;
    record(
      "步驟32a 建立 team 成員與個人單機兩種 ACP session,AcpAdapter.spawn() 真的核發 scoped token(dmbt_ 前綴)且內容正確綁定各自的 session/team/member",
      ok,
      `team=${JSON.stringify({ ...teamBridgeEnv, token: teamBridgeEnv?.token ? "(redacted)" : undefined })}, solo=${JSON.stringify({ ...soloBridgeEnv, token: soloBridgeEnv?.token ? "(redacted)" : undefined })}`,
    );
  } catch (err) {
    record("步驟32a 準備 team + 兩種 ACP session 並取得真實核發的 scoped token", false, String(err));
    return; // 後續子步驟都依賴這裡的結果,拿不到就整組略過。
  }

  // ---- 32b: 白名單內的方法(team-bus + subagent 兩類)用 team session 的
  //           token 呼叫,一律成功。----
  try {
    const { client: bridgeClient, ok: authOk } = await connectAndAuth(teamBridgeEnv.gatewayUrl, teamBridgeEnv.token);
    if (!authOk) throw new Error("scoped token 認證失敗,預期應該成功");

    const sendResult = await bridgeClient.rpc("message.sendMessage", {
      teamId,
      fromMemberId: coderMemberId,
      to: "Reviewer",
      content: "步驟32b 白名單內方法測試",
    });
    const listChildrenResult = await bridgeClient.rpc("session.listChildren", { parentSessionId: teamSessionId });
    const listProfilesResult = await bridgeClient.rpc("profile.listForSubagent", {});
    const teammatesResult = await bridgeClient.rpc("team.teammates", { teamId });

    bridgeClient.close();

    const ok =
      Boolean(sendResult?.message?.id) &&
      Array.isArray(listChildrenResult?.children) &&
      Array.isArray(listProfilesResult?.profiles) &&
      Array.isArray(teammatesResult?.teammates);
    record(
      "步驟32b scoped token 呼叫白名單內的方法(message.sendMessage/session.listChildren/profile.listForSubagent/team.teammates)全部成功",
      ok,
      `sendResult=${JSON.stringify(sendResult)}, listChildren=${JSON.stringify(listChildrenResult)}, listProfiles 數=${listProfilesResult?.profiles?.length}, teammates 數=${teammatesResult?.teammates?.length}`,
    );
  } catch (err) {
    record("步驟32b scoped token 呼叫白名單內方法全部成功", false, String(err));
  }

  // ---- 32c: 白名單外的方法一律被拒絕(errorCode 對應
  //           GATEWAY_SCOPED_TOKEN_FORBIDDEN,訊息含「無權呼叫」)。----
  try {
    const { client: bridgeClient, ok: authOk } = await connectAndAuth(teamBridgeEnv.gatewayUrl, teamBridgeEnv.token);
    if (!authOk) throw new Error("scoped token 認證失敗,預期應該成功");

    const forbiddenMethods = [
      ["session.create", { agentProfileId: "whatever", workingDir: workspaceDir }],
      ["profile.delete", { id: "whatever" }],
      ["config.setFile", { log: { level: "warn" } }],
      ["session.setPermissionMode", { sessionId: teamSessionId, mode: "auto-accept-all" }],
    ];
    const rejections = [];
    for (const [method, params] of forbiddenMethods) {
      try {
        await bridgeClient.rpc(method, params);
        rejections.push({ method, rejected: false });
      } catch (err) {
        rejections.push({ method, rejected: true, message: String(err) });
      }
    }
    bridgeClient.close();

    const ok = rejections.every((r) => r.rejected && r.message.includes("無權呼叫"));
    record(
      "步驟32c scoped token 呼叫白名單外的方法(session.create/profile.delete/config.setFile/session.setPermissionMode)全部被拒絕",
      ok,
      JSON.stringify(rejections),
    );
  } catch (err) {
    record("步驟32c scoped token 呼叫白名單外方法全部被拒絕", false, String(err));
  }

  // ---- 32d: 綁定範圍檢查——同樣是白名單內的方法,但參數指向別的
  //           session/team/member 時一律被拒絕。----
  try {
    const { client: bridgeClient, ok: authOk } = await connectAndAuth(teamBridgeEnv.gatewayUrl, teamBridgeEnv.token);
    if (!authOk) throw new Error("scoped token 認證失敗,預期應該成功");

    const otherTeam = await client.rpc("team.create", { name: "E2E Scoped Token Other Team" });
    const cases = [
      // teamId 對,但 fromMemberId 冒充 Reviewer(不是這個 token 綁定的 coderMemberId)。
      ["message.sendMessage", { teamId, fromMemberId: reviewerMemberId, to: "Coder", content: "冒名" }, "fromMemberId 不符"],
      // fromMemberId 對,但 teamId 指向別的 team。
      ["message.broadcast", { teamId: otherTeam.team.id, fromMemberId: coderMemberId, content: "冒名" }, "teamId 不符"],
      ["team.teammates", { teamId: otherTeam.team.id }, "teamId 不符(team.teammates)"],
      // parentSessionId 指向不是這個 token 綁定的 soloSessionId。
      ["session.listChildren", { parentSessionId: soloSessionId }, "parentSessionId 不符"],
      ["session.spawnChildForSubagent", { parentSessionId: soloSessionId, prompt: "冒名" }, "parentSessionId 不符(spawn)"],
    ];
    const rejections = [];
    for (const [method, params, label] of cases) {
      try {
        await bridgeClient.rpc(method, params);
        rejections.push({ label, rejected: false });
      } catch (err) {
        rejections.push({ label, rejected: true, message: String(err) });
      }
    }
    bridgeClient.close();

    const ok = rejections.every((r) => r.rejected && r.message.includes("不符"));
    record(
      "步驟32d scoped token 呼叫白名單內方法,但參數指向不屬於自己綁定的 session/team/member 時一律被拒絕(冒名防護)",
      ok,
      JSON.stringify(rejections),
    );
  } catch (err) {
    record("步驟32d scoped token 綁定範圍檢查(冒名防護)", false, String(err));
  }

  // ---- 32e: 沒有 team 的 session,它的 token 拿不到 team-bus 系列方法
  //           (即使 subagentPort 全域生效、team-bus 與 subagent 是各自獨立
  //           判斷的兩組範圍),但拿得到 subagent 系列方法。----
  try {
    const { client: bridgeClient, ok: authOk } = await connectAndAuth(soloBridgeEnv.gatewayUrl, soloBridgeEnv.token);
    if (!authOk) throw new Error("scoped token 認證失敗,預期應該成功");

    let teamBusRejected = false;
    try {
      await bridgeClient.rpc("message.sendMessage", { teamId, fromMemberId: coderMemberId, to: "Reviewer", content: "不該成功" });
    } catch (err) {
      teamBusRejected = String(err).includes("無權呼叫");
    }

    const listProfilesResult = await bridgeClient.rpc("profile.listForSubagent", {});
    bridgeClient.close();

    const ok = teamBusRejected && Array.isArray(listProfilesResult?.profiles);
    record(
      "步驟32e 沒有 team 的 ACP session,其 scoped token 呼叫 team-bus 方法(message.sendMessage)被拒絕,但 subagent 方法(profile.listForSubagent)仍然成功——scope 精確反映核發時的請求,不是全有全無",
      ok,
      `teamBusRejected=${teamBusRejected}, listProfiles 數=${listProfilesResult?.profiles?.length}`,
    );
  } catch (err) {
    record("步驟32e 無 team session 的 token 精確反映 scope(team-bus 拒絕/subagent 允許)", false, String(err));
  }

  // ---- 32f: session dispose 後,對應 token 立即失效(呼叫任何方法都被拒絕)。----
  try {
    // 用一個獨立的 session(不是 32a 那兩個,避免影響後面步驟還要用到
    // teamSessionId/soloSessionId)。
    const profileList = await client.rpc("profile.list", {});
    const acpProfile = profileList.profiles.find((p) => p.name === "E2E Scoped MCP Bridge Token");
    const { sessionId: disposableSessionId, bridgeEnv: disposableBridgeEnv } = await createAcpSessionAndGetBridgeEnv(
      client,
      acpProfile.id,
      workspaceDir,
      "e2e-scoped-dispose",
      undefined,
    );

    // 先確認 token 一開始確實可用(排除「本來就核發失敗」這個混淆變因)。
    const { client: beforeClient, ok: beforeOk } = await connectAndAuth(disposableBridgeEnv.gatewayUrl, disposableBridgeEnv.token);
    if (!beforeOk) throw new Error("dispose 前 scoped token 認證失敗,預期應該成功");
    await beforeClient.rpc("profile.listForSubagent", {});
    beforeClient.close();

    await client.rpc("session.delete", { sessionId: disposableSessionId });

    // session.delete 內部會 await adapter.dispose(handle)(見
    // SessionManager.deleteSession()),而 AcpAdapter.dispose() 會在其中同步
    // 呼叫 tokenMinter.revokeForSession()——RPC resolve 時撤銷理論上已完成,
    // 不需要額外等待;仍用一個新連線重新嘗試認證,確認被拒絕。
    const { client: afterClient, ok: afterOk, error: afterError } = await connectAndAuth(
      disposableBridgeEnv.gatewayUrl,
      disposableBridgeEnv.token,
    );
    afterClient.close();

    const ok = !afterOk && Boolean(afterError) && afterError.includes("認證失敗");
    record(
      "步驟32f session.delete(觸發 AcpAdapter.dispose())後,對應的 scoped token 立即失效,重新認證被拒絕",
      ok,
      `afterOk=${afterOk}, afterError=${afterError}`,
    );
  } catch (err) {
    record("步驟32f session dispose 後 token 立即失效", false, String(err));
  }

  // ---- 32f-2: 外部安全審查抓到的真實漏洞的迴歸測試(見
  //             checkScopedGrantAccess() 頂端註解)——32f 只驗證了「用同一個
  //             token 開全新連線重新認證」會被拒絕,**沒有**驗證「dispose 前
  //             就已經完成 auth handshake、且連線本身一直沒關」的既有連線,
  //             之後再送 request 是否也會被擋下。早期實作只檢查連線建立當下
  //             快取的 grant 物件(從未回頭查活著的 map),這個情境下撤銷完全
  //             不會生效,直到 token 的絕對 TTL(預設 24 小時)才會失效——不
  //             需要任何惡意行為,單純 dispose() 到子行程真的被殺掉之間的正常
  //             等待窗口就會踩到。這裡刻意讓 bridgeClient **在 dispose 之後才
  //             送出下一個 request**(不重新認證),驗證的是「同一條連線」而
  //             非「新連線」這個關鍵差異。 ----
  try {
    const profileList = await client.rpc("profile.list", {});
    const acpProfile = profileList.profiles.find((p) => p.name === "E2E Scoped MCP Bridge Token");
    const { sessionId: disposableSessionId2, bridgeEnv: disposableBridgeEnv2 } = await createAcpSessionAndGetBridgeEnv(
      client,
      acpProfile.id,
      workspaceDir,
      "e2e-scoped-dispose-live-conn",
      undefined,
    );

    const { client: bridgeClient, ok: authOk } = await connectAndAuth(disposableBridgeEnv2.gatewayUrl, disposableBridgeEnv2.token);
    if (!authOk) throw new Error("dispose 前 scoped token 認證失敗,預期應該成功");
    await bridgeClient.rpc("profile.listForSubagent", {}); // dispose 前:確認這條連線本來就能正常呼叫。

    await client.rpc("session.delete", { sessionId: disposableSessionId2 });

    // 關鍵:不重新連線/認證,直接用同一個(dispose 前就已認證過的)連線再送
    // 一次 request——這正是舊實作(只信任快取物件)會誤放行的情境。
    let liveConnRejected = false;
    let liveConnMessage = "";
    try {
      await bridgeClient.rpc("profile.listForSubagent", {});
    } catch (err) {
      liveConnRejected = true;
      liveConnMessage = String(err);
    }
    bridgeClient.close();

    const ok = liveConnRejected && liveConnMessage.includes("已撤銷或已過期");
    record(
      "步驟32f-2 session dispose 後,dispose 前就已認證完成、且連線本身沒關閉的既有連線,下一次請求也會被拒絕(不只擋新連線重新認證)",
      ok,
      `liveConnRejected=${liveConnRejected}, liveConnMessage=${liveConnMessage}`,
    );
  } catch (err) {
    record("步驟32f-2 session dispose 後,既有已認證連線的下一次請求被拒絕", false, String(err));
  }

  // ---- 32g: 端到端——真的透過 mcp-bridge-server.ts 子行程呼叫 MCP 工具,
  //           真的透過 WS 打回 gateway,真的觸發 MessageBus.sendMessage(),
  //           team_messages 真的多一筆。----
  try {
    const fixedContent = `步驟32g 端到端 bridge 工具呼叫 ${randomUUID()}`;
    const callPayload = { tool: "send_message", args: { to: "Reviewer", content: fixedContent } };
    const prompt = `${CALL_BRIDGE_TOOL_PREFIX}${JSON.stringify(callPayload)}`;
    const { finalEvent, collected } = await client.drivePrompt(teamSessionId, prompt, {
      onPermission: async () => "deny",
      timeoutMs: 30_000,
    });
    if (finalEvent.event.type !== "completed") {
      throw new Error(`ACP_CALL_BRIDGE_TOOL 未正常 completed: ${JSON.stringify(finalEvent.event)}`);
    }
    const { groups } = analyzeMessageDeltas(collected);
    const fullText = groups.map((g) => g.text).join("");
    const bridgeSucceeded = fullText.includes("BRIDGE_TOOL_RESULT:") && !fullText.includes("BRIDGE_TOOL_RESULT_ERROR");

    const deadline = Date.now() + 15_000;
    let found;
    while (Date.now() < deadline && !found) {
      const history = await client.rpc("team.messages", { teamId });
      found = history.messages.find((m) => m.to === "Reviewer" && m.content === fixedContent);
      if (!found) await sleep(500);
    }

    record(
      "步驟32g 端到端:fake-acp-agent 真的 spawn mcp-bridge-server.ts 子行程,用真正的 MCP client 呼叫 send_message 工具,經 WS 打回 gateway 後 team_messages 真的出現這筆訊息",
      bridgeSucceeded && Boolean(found),
      `bridgeReply=${JSON.stringify(fullText)}, foundInTeamMessages=${JSON.stringify(found)}`,
    );
  } catch (err) {
    record("步驟32g 端到端 mcp-bridge-server.ts 子行程真實呼叫", false, String(err));
  }

  // ---- 清理 ----
  // task.delete 要排在 session.delete 之前(比照步驟13a 的既有先例)——
  // coderMemberId 是 lifecycle:"persistent",不會被自動 dispose,但
  // task.delete 本身會清掉 worktree,遲於 session.delete 呼叫沒有順序上的
  // 風險,這裡仍維持與既有慣例一致的順序。
  if (taskId) {
    try {
      await client.rpc("task.delete", { taskId });
    } catch (err) {
      log(`[cleanup] 刪除步驟32任務(含 worktree)時發生錯誤(忽略): ${err}`);
    }
  }
  for (const sessionId of [teamSessionId, soloSessionId]) {
    if (!sessionId) continue;
    try {
      await client.rpc("session.delete", { sessionId });
    } catch (err) {
      log(`[cleanup] 刪除步驟32 session(${sessionId})時發生錯誤(忽略): ${err}`);
    }
  }
  if (repoDir) {
    try {
      rmSync(repoDir, { recursive: true, force: true });
    } catch (err) {
      log(`[cleanup] 刪除步驟32暫存 git repo(${repoDir})時發生錯誤(忽略): ${err}`);
    }
  }
}

// ---------------------------------------------------------------------
// 步驟 33: scoped MCP bridge token 的絕對過期時間保底(獨立 core 子程序,用
// DESKMONY_MCP_BRIDGE_TOKEN_TTL_MS 縮短到 300ms,決定性測試)。
// ---------------------------------------------------------------------
async function scopedTokenTtlSmokeTest() {
  if (!shouldRun("deterministic")) {
    skipNote("步驟33 scoped MCP bridge token 絕對過期", "deterministic");
    return;
  }

  const PORT = 4333;
  const url = `ws://localhost:${PORT}`;
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-token-ttl-data-"));
  const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-token-ttl-ws-"));
  const fakeAgentPath = path.join(REPO_ROOT, "scripts", "fake-acp-agent.mjs");
  let coreProc;
  let client;

  try {
    coreProc = startCore({
      port: PORT,
      dataDir,
      workspaceDir,
      permissionTimeoutMs: PERMISSION_TIMEOUT_MS,
      // 300ms 太短——光是 profile.create → session.create → 真的 spawn 一個
      // fake-acp-agent.mjs 子行程做 ACP initialize/session-new/prompt 握手
      // 拿到 bridgeEnv,實測就可能已經逼近甚至超過這個時間,導致「過期前」
      // 這個檢查點本身就先失敗(steps 32a 全程平均耗時觀察後訂出的值,留足
      // 安全邊際)。5 秒對這段初始化來說綽綽有餘,睡 6 秒確保跨過 TTL。
      extraEnv: { DESKMONY_MCP_BRIDGE_TOKEN_TTL_MS: "5000" },
    });
    await waitForPort(url, 20_000);
    client = new GatewayClient(url);
    await client.connect();

    const profileCreated = await client.rpc("profile.create", {
      name: "E2E Token TTL",
      software: "acp",
      workingDir: workspaceDir,
      acpConfig: { command: process.execPath, args: [fakeAgentPath] },
    });
    const { bridgeEnv } = await createAcpSessionAndGetBridgeEnv(client, profileCreated.profile.id, workspaceDir, "e2e-ttl", undefined);
    if (!bridgeEnv?.token) throw new Error("未能取得 scoped token(bridgeEnv 為空)");

    // ---- 33a: 過期前,一條已認證的連線正常可用。----
    const { client: bridgeClient, ok: authOk } = await connectAndAuth(bridgeEnv.gatewayUrl, bridgeEnv.token);
    if (!authOk) throw new Error("過期前 scoped token 認證失敗,預期應該成功");
    await bridgeClient.rpc("profile.listForSubagent", {});
    record("步驟33a scoped token 在 TTL 過期前,認證與方法呼叫皆正常", true);

    await sleep(6_000); // TTL 5000ms,睡到肯定已過期。

    // ---- 33b: 同一條(已認證的)連線,過期後下一次請求被拒絕——證明
    //           checkScopedGrantAccess() 對每一次請求都重新檢查過期時間,
    //           不是只在認證當下檢查一次。----
    let existingConnRejected = false;
    let existingConnMessage = "";
    try {
      await bridgeClient.rpc("profile.listForSubagent", {});
    } catch (err) {
      existingConnRejected = true;
      existingConnMessage = String(err);
    }
    bridgeClient.close();
    record(
      "步驟33b 已認證連線在 token 過期後,下一次請求被拒絕(每次請求都重新檢查過期時間,不只認證當下檢查一次)",
      existingConnRejected && existingConnMessage.includes("已過期"),
      existingConnMessage,
    );

    // ---- 33c: 過期後用同一個 token 重新認證(全新連線),也被拒絕。----
    const { client: freshClient, ok: freshOk, error: freshError } = await connectAndAuth(bridgeEnv.gatewayUrl, bridgeEnv.token);
    freshClient.close();
    record(
      "步驟33c token 過期後,用同一個 token 開全新連線重新認證也被拒絕",
      !freshOk && Boolean(freshError),
      `freshOk=${freshOk}, freshError=${freshError}`,
    );
  } catch (err) {
    record("步驟33 scoped MCP bridge token 絕對過期(整體設置失敗)", false, String(err));
  } finally {
    client?.close();
    await killProcessTree(coreProc, "core(步驟33 scoped token TTL)");
    try {
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(workspaceDir, { recursive: true, force: true });
    } catch (err) {
      log(`[cleanup] 刪除步驟33暫存目錄時發生錯誤(忽略): ${err}`);
    }
  }
}

// ---------------------------------------------------------------------
// 步驟 34: scoped MCP bridge token 與既有 DESKMONY_AUTH_TOKEN(master token)
// 認證機制的交互——確認這輪新增的程式碼完全不影響既有行為(獨立 core 子
// 程序,設定 DESKMONY_AUTH_TOKEN,決定性測試)。
// ---------------------------------------------------------------------
async function scopedTokenAuthInterplaySmokeTest() {
  if (!shouldRun("deterministic")) {
    skipNote("步驟34 scoped token 與 master token 認證交互", "deterministic");
    return;
  }

  const PORT = 4334;
  const url = `ws://localhost:${PORT}`;
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-token-interplay-data-"));
  const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-token-interplay-ws-"));
  const fakeAgentPath = path.join(REPO_ROOT, "scripts", "fake-acp-agent.mjs");
  const MASTER_TOKEN = `e2e-master-${randomUUID()}`;
  let coreProc;
  let client;

  try {
    coreProc = startCore({ port: PORT, dataDir, workspaceDir, permissionTimeoutMs: PERMISSION_TIMEOUT_MS, authToken: MASTER_TOKEN });
    await waitForPort(url, 20_000);
    client = new GatewayClient(url);
    await client.connect();
    await client.rpc("auth", { token: MASTER_TOKEN });

    const profileCreated = await client.rpc("profile.create", {
      name: "E2E Token Interplay",
      software: "acp",
      workingDir: workspaceDir,
      acpConfig: { command: process.execPath, args: [fakeAgentPath] },
    });
    const { bridgeEnv } = await createAcpSessionAndGetBridgeEnv(client, profileCreated.profile.id, workspaceDir, "e2e-interplay", undefined);
    if (!bridgeEnv?.token) throw new Error("未能取得 scoped token(bridgeEnv 為空)");

    // ---- 34a: 即使 core 已設定 DESKMONY_AUTH_TOKEN,scoped token 仍然能
    //           正常認證並受限於自己的白名單(不會被誤判成一般連線、也不會
    //           被要求改用 master token)。----
    {
      const { client: bridgeClient, ok: authOk } = await connectAndAuth(bridgeEnv.gatewayUrl, bridgeEnv.token);
      let listOk = false;
      let createRejected = false;
      if (authOk) {
        try {
          const r = await bridgeClient.rpc("profile.listForSubagent", {});
          listOk = Array.isArray(r?.profiles);
        } catch {
          // listOk 維持 false
        }
        try {
          await bridgeClient.rpc("session.create", { agentProfileId: profileCreated.profile.id, workingDir: workspaceDir });
        } catch (err) {
          createRejected = String(err).includes("無權呼叫");
        }
      }
      bridgeClient.close();
      record(
        "步驟34a 已設定 DESKMONY_AUTH_TOKEN 的 core 上,scoped token 仍能正常認證、白名單內方法成功、白名單外方法被拒絕",
        authOk && listOk && createRejected,
        `authOk=${authOk}, listOk=${listOk}, createRejected=${createRejected}`,
      );
    }

    // ---- 34b: 一個帶 scoped token 前綴、但不是真的核發過的偽造 token,
    //           不會被誤判成「未設定 master token」而放行,一律拒絕。----
    {
      const forged = `dmbt_${"0".repeat(64)}`;
      const { client: forgedClient, ok, error } = await connectAndAuth(bridgeEnv.gatewayUrl, forged);
      forgedClient.close();
      record(
        "步驟34b 帶 scoped token 前綴但從未核發過的偽造 token 一律被拒絕(不會誤判成 master token 未設定的免認證模式)",
        !ok && Boolean(error),
        `ok=${ok}, error=${error}`,
      );
    }

    // ---- 34c: master token 本身的既有行為完全不受影響——認證後可呼叫任何
    //           方法(不受這輪新增的白名單限制,因為 connState.scopedGrant
    //           對這種連線是 undefined)。----
    {
      const masterClient = new GatewayClient(url);
      await masterClient.connect();
      await masterClient.rpc("auth", { token: MASTER_TOKEN });
      const sessionsResult = await masterClient.rpc("session.list", {});
      masterClient.close();
      record(
        "步驟34c master token 認證後的連線,行為與這輪之前完全相同——可呼叫任何方法(不受 scoped token 白名單限制)",
        Array.isArray(sessionsResult?.sessions),
        `sessions 數=${sessionsResult?.sessions?.length}`,
      );
    }

    // ---- 34d: 錯誤的一般(非 scoped)token,既有的「認證失敗」行為不受影響。----
    {
      const wrongClient = new GatewayClient(url);
      await wrongClient.connect();
      let rejected = false;
      let message = "";
      try {
        await wrongClient.rpc("auth", { token: `wrong-${randomUUID()}` });
      } catch (err) {
        rejected = true;
        message = String(err);
      }
      wrongClient.close();
      record(
        "步驟34d 一般(非 dmbt_ 前綴)錯誤 token 在已設定 master token 的 core 上,既有的認證失敗行為不受影響",
        rejected && message.includes("認證失敗"),
        message,
      );
    }
  } catch (err) {
    record("步驟34 scoped token 與 master token 認證交互(整體設置失敗)", false, String(err));
  } finally {
    client?.close();
    await killProcessTree(coreProc, "core(步驟34 scoped token 與 master token 交互)");
    try {
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(workspaceDir, { recursive: true, force: true });
    } catch (err) {
      log(`[cleanup] 刪除步驟34暫存目錄時發生錯誤(忽略): ${err}`);
    }
  }
}

// ---------------------------------------------------------------------
// 步驟 30: 機器驗收閘(S4,決定性測試,真實 git 子程序 + 真實 node 子程序,
// 不依賴任何真實模型)
//
// 用 `node -e "process.exit(0/1)"` 當確定性指令(見 L4 §7 檢查清單),驗證:
//   30a-30c 定義驗收 → 跑 → 斷言 pass/fail(passed 路徑 + 依序執行遇到非 0
//       立即停止,後續指令不列入 perCommand)。
//   30d 無 acceptance → skippedReason "no-acceptance",不當成失敗。
//   30e 無 workspace(從未指派)→ skippedReason "workspace-missing"。
//   30f 逾時:timeoutMs 設得比指令實際耗時短 → timedOut:true、exitCode:null、
//       passed:false。
//   30g task.setAcceptance 事後設定/清除驗收條件。
//   30h 併發鎖:同一任務同時只能跑一次,重複請求得到明確錯誤;跑完之後鎖
//       釋放,可以再跑一次。
//   30i team-bus MCP 工具確實沒有任何寫入 acceptance 的入口(完整性紀律,
//       靜態檢查編譯產物的工具名稱清單)。
// ---------------------------------------------------------------------
async function acceptanceGateSmokeTest(client) {
  const gitVersion = runGitSync(["--version"], process.cwd());
  if (gitVersion.status !== 0) {
    record(
      "步驟30 機器驗收閘(git 不可用,整個步驟略過)",
      false,
      `找不到可用的 git 執行檔: ${gitVersion.error ?? gitVersion.stderr}`,
    );
    return;
  }

  const repoDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-acceptance-"));
  const worktreeRoot = path.join(path.dirname(repoDir), ".deskmony-worktrees");
  let teamId;
  let memberId;

  try {
    // ---- 30a: 準備 git repo + team + 成員(比照步驟15a)----
    try {
      const initResult = runGitSync(["init", "-b", "main"], repoDir);
      runGitSync(["config", "user.email", "e2e@deskmony.local"], repoDir);
      runGitSync(["config", "user.name", "Deskmony E2E"], repoDir);
      writeFileSync(path.join(repoDir, "README.md"), "# deskmony e2e acceptance repo\n", "utf8");
      runGitSync(["add", "."], repoDir);
      const commitResult = runGitSync(["commit", "-m", "initial commit"], repoDir);

      const team = await client.rpc("team.create", { name: "E2E Acceptance Team", workingDir: repoDir });
      teamId = team.team.id;

      const profileCreated = await client.rpc("profile.create", {
        name: "E2E Acceptance Member Profile",
        software: "claude-agent-sdk",
        workingDir: repoDir,
      });
      // S8(agent-lifecycle):同一個 memberId 在這個步驟(30b~30h)被重複指派
      // 到一連串永遠不會走到終態的任務(只 assign + runAcceptance,從不
      // updateStatus 到 done)——與步驟16 的理由完全相同,明確指定 persistent
      // 讓 assignTask() 略過 ephemeral 專屬的「一 member 一 session」檢查,
      // 這個測試本身測的是機器驗收閘,與 lifecycle 無關。
      const member = await client.rpc("team.addMember", {
        teamId,
        agentProfileId: profileCreated.profile.id,
        name: "Coder",
        role: "Coder",
        canInterrupt: false,
        lifecycle: "persistent",
      });
      memberId = member.member.id;

      record(
        "步驟30a 準備真實 git repo + team + 成員",
        initResult.status === 0 && commitResult.status === 0,
        `repoDir=${repoDir}, teamId=${teamId}, memberId=${memberId}`,
      );
    } catch (err) {
      record("步驟30a 準備真實 git repo + team + 成員", false, String(err));
      return;
    }

    const passCommand = `${JSON.stringify(process.execPath)} -e "process.exit(0)"`;
    const failCommand = `${JSON.stringify(process.execPath)} -e "process.exit(1)"`;

    // ---- 30b: 定義驗收(單條 pass 指令)→ task.assign → task.runAcceptance → passed:true ----
    try {
      const created = await client.rpc("task.create", {
        teamId,
        title: "E2E Acceptance Pass",
        acceptance: { commands: [passCommand] },
      });
      await client.rpc("task.assign", { taskId: created.task.id, memberId });
      const run = await client.rpc("task.runAcceptance", { taskId: created.task.id });

      const ok =
        run.result.passed === true &&
        run.result.perCommand.length === 1 &&
        run.result.perCommand[0].exitCode === 0 &&
        run.result.perCommand[0].timedOut === false &&
        !run.result.skippedReason;

      record(
        "步驟30b 定義驗收(單條 pass 指令)→ task.assign → task.runAcceptance → passed:true",
        ok,
        JSON.stringify(run.result),
      );
    } catch (err) {
      record("步驟30b 驗收 pass 路徑", false, String(err));
    }

    // ---- 30c: 兩條指令,第一條 fail → 立即停止,第二條不執行、不列入 perCommand ----
    try {
      const created = await client.rpc("task.create", {
        teamId,
        title: "E2E Acceptance Fail-Fast",
        acceptance: { commands: [failCommand, passCommand] },
      });
      await client.rpc("task.assign", { taskId: created.task.id, memberId });
      const run = await client.rpc("task.runAcceptance", { taskId: created.task.id });

      const ok =
        run.result.passed === false &&
        run.result.perCommand.length === 1 && // 第二條(pass)不應該被執行
        run.result.perCommand[0].exitCode === 1 &&
        !run.result.skippedReason;

      record(
        "步驟30c 依序執行:第一條指令非 0 → 立即停止,第二條指令不執行、不列入 perCommand,passed:false",
        ok,
        JSON.stringify(run.result),
      );
    } catch (err) {
      record("步驟30c 驗收 fail-fast 路徑", false, String(err));
    }

    // ---- 30d: 無 acceptance → skippedReason "no-acceptance",不當成失敗 ----
    try {
      const created = await client.rpc("task.create", { teamId, title: "E2E Acceptance None" });
      await client.rpc("task.assign", { taskId: created.task.id, memberId });
      const run = await client.rpc("task.runAcceptance", { taskId: created.task.id });

      const ok = run.result.skippedReason === "no-acceptance" && run.result.perCommand.length === 0;
      record(
        "步驟30d 任務無 acceptance → task.runAcceptance 回 skippedReason=\"no-acceptance\"(不是拋錯)",
        ok,
        JSON.stringify(run.result),
      );
    } catch (err) {
      record("步驟30d 無 acceptance 路徑", false, String(err));
    }

    // ---- 30e: 有 acceptance 但從未指派(無 workspace)→ skippedReason "workspace-missing" ----
    try {
      const created = await client.rpc("task.create", {
        teamId,
        title: "E2E Acceptance No Workspace",
        acceptance: { commands: [passCommand] },
      });
      // 刻意不呼叫 task.assign —— 這個任務永遠沒有 workspaceId。
      const run = await client.rpc("task.runAcceptance", { taskId: created.task.id });

      const ok = run.result.skippedReason === "workspace-missing" && run.result.passed === false;
      record(
        "步驟30e 任務有 acceptance 但未指派(無 workspace)→ skippedReason=\"workspace-missing\"",
        ok,
        JSON.stringify(run.result),
      );
    } catch (err) {
      record("步驟30e 無 workspace 路徑", false, String(err));
    }

    // ---- 30f: 逾時(timeoutMs 設得比指令實際耗時短)→ timedOut:true, exitCode:null ----
    try {
      const sleepCommand = `${JSON.stringify(process.execPath)} -e "setTimeout(() => {}, 5000)"`;
      const created = await client.rpc("task.create", {
        teamId,
        title: "E2E Acceptance Timeout",
        acceptance: { commands: [sleepCommand], timeoutMs: 800 },
      });
      await client.rpc("task.assign", { taskId: created.task.id, memberId });
      const run = await client.rpc("task.runAcceptance", { taskId: created.task.id }, 15_000);

      const cmd = run.result.perCommand[0];
      const ok =
        run.result.passed === false &&
        cmd?.timedOut === true &&
        cmd?.exitCode === null &&
        cmd.durationMs < 4_000; // 遠早於 5000ms 的 sleep 就該被 kill,證明真的逾時中止而非等它自然結束

      record(
        "步驟30f 逾時(timeoutMs 短於指令實際耗時)→ timedOut:true、exitCode:null、passed:false,且提前 kill(未等滿 5s)",
        ok,
        JSON.stringify(run.result),
      );
    } catch (err) {
      record("步驟30f 逾時路徑", false, String(err));
    }

    // ---- 30g: task.setAcceptance 事後設定/清除驗收條件 ----
    try {
      const created = await client.rpc("task.create", { teamId, title: "E2E Acceptance SetLater" });
      await client.rpc("task.assign", { taskId: created.task.id, memberId });

      const noneYet = await client.rpc("task.get", { taskId: created.task.id });
      const setResult = await client.rpc("task.setAcceptance", {
        taskId: created.task.id,
        acceptance: { commands: [passCommand] },
      });
      const afterSet = await client.rpc("task.get", { taskId: created.task.id });
      const runAfterSet = await client.rpc("task.runAcceptance", { taskId: created.task.id });

      const clearResult = await client.rpc("task.setAcceptance", { taskId: created.task.id, acceptance: undefined });
      const afterClear = await client.rpc("task.get", { taskId: created.task.id });

      const ok =
        noneYet.task.acceptance === undefined &&
        setResult.task.acceptance?.commands.length === 1 &&
        afterSet.task.acceptance?.commands.length === 1 &&
        runAfterSet.result.passed === true &&
        clearResult.task.acceptance === undefined &&
        afterClear.task.acceptance === undefined;

      record(
        "步驟30g task.setAcceptance 事後設定(task.get 讀回一致、runAcceptance 生效)與清除(acceptance 變回 undefined)",
        ok,
        `noneYet=${JSON.stringify(noneYet.task.acceptance)}, afterSet=${JSON.stringify(afterSet.task.acceptance)}, ` +
          `runAfterSet.passed=${runAfterSet.result.passed}, afterClear=${JSON.stringify(afterClear.task.acceptance)}`,
      );
    } catch (err) {
      record("步驟30g task.setAcceptance", false, String(err));
    }

    // ---- 30h: 併發鎖 —— 同一任務同時只能跑一次,重複請求得到明確錯誤;跑完後鎖釋放 ----
    try {
      const sleepCommand = `${JSON.stringify(process.execPath)} -e "setTimeout(() => process.exit(0), 3000)"`;
      const created = await client.rpc("task.create", {
        teamId,
        title: "E2E Acceptance Concurrency Lock",
        acceptance: { commands: [sleepCommand] },
      });
      await client.rpc("task.assign", { taskId: created.task.id, memberId });

      const firstCall = client.rpc("task.runAcceptance", { taskId: created.task.id }, 15_000);
      // 給第一個請求一點時間確保它已經真的開始跑、拿到鎖(避免兩個請求幾乎
      // 同時抵達 core 時的競態,讓這個檢查點決定性)。
      await sleep(300);
      let secondCallRejected = false;
      let secondCallError = "";
      try {
        await client.rpc("task.runAcceptance", { taskId: created.task.id }, 5_000);
      } catch (err) {
        secondCallRejected = true;
        secondCallError = String(err);
      }
      const firstResult = await firstCall;

      // 鎖釋放後,同一任務應該可以再跑一次。
      const thirdCall = await client.rpc("task.runAcceptance", { taskId: created.task.id }, 15_000);

      const ok =
        firstResult.result.passed === true &&
        secondCallRejected &&
        thirdCall.result.passed === true;

      record(
        "步驟30h 併發鎖:同一任務同時只能跑一次驗收(重複請求得到明確錯誤),跑完後鎖釋放、可再次執行",
        ok,
        `firstResult.passed=${firstResult.result.passed}, secondCallRejected=${secondCallRejected}(${secondCallError}), thirdCall.passed=${thirdCall.result.passed}`,
      );
    } catch (err) {
      record("步驟30h 併發鎖", false, String(err));
    }

    // ---- 30i: team-bus MCP 工具沒有任何寫入 acceptance 的入口(完整性紀律)----
    try {
      const mod = await import(pathToFileURL(path.join(REPO_ROOT, "packages", "adapters", "dist", "team-bus-mcp.js")).href);
      const toolNames = mod.TEAM_BUS_TOOL_NAMES;
      const expectedCount = 5; // send_message / broadcast / list_teammates / report_status / request_review
      const noAcceptanceTool = toolNames.every((name) => !/accept/i.test(name));

      record(
        "步驟30i team-bus MCP 工具清單(TEAM_BUS_TOOL_NAMES)不含任何 acceptance 相關工具(agent 無法自己寫入 acceptance)",
        Array.isArray(toolNames) && toolNames.length === expectedCount && noAcceptanceTool,
        `toolNames=${JSON.stringify(toolNames)}`,
      );
    } catch (err) {
      record("步驟30i team-bus MCP 工具清單檢查", false, String(err));
    }
  } finally {
    try {
      rmSync(repoDir, { recursive: true, force: true });
    } catch (err) {
      log(`[cleanup] 刪除步驟30暫存 git repo(${repoDir})時發生錯誤(忽略): ${err}`);
    }
    try {
      rmSync(worktreeRoot, { recursive: true, force: true });
    } catch (err) {
      log(`[cleanup] 刪除步驟30 worktree 根目錄(${worktreeRoot})時發生錯誤(忽略): ${err}`);
    }
  }
}

// ---------------------------------------------------------------------
// 步驟 19: 刪除對話(M5 Round C 功能2,決定性測試,不依賴任何真實模型)
//
// 對應 apps/desktop/src/stores/session-store.ts 新增的 `deleteSession()`
// action 所依賴的後端路徑——`session.create` 只是 spawn 一個 SDK `query()`
// process,不會發起任何真實模型呼叫(只有 `session.sendPrompt` 才會);這裡
// 完全不送出任何 prompt,純粹驗證 `session.list` → `session.delete` →
// `session.list` 的生命週期,結果 100% 決定性。
// ---------------------------------------------------------------------
async function sessionDeleteSmokeTest(client, workspaceDir, defaultProfile) {
  let sessionId;
  try {
    const created = await client.rpc(
      "session.create",
      { agentProfileId: defaultProfile.id, workingDir: workspaceDir, title: "e2e-step19-delete" },
      30_000,
    );
    sessionId = created.session.id;

    const listBefore = await client.rpc("session.list", {});
    const existsBefore = listBefore.sessions.some((s) => s.id === sessionId);

    await client.rpc("session.delete", { sessionId });
    const listAfter = await client.rpc("session.list", {});
    const existsAfter = listAfter.sessions.some((s) => s.id === sessionId);

    record(
      "步驟19 刪除對話:session.create → session.list 確認存在 → session.delete → session.list 確認不存在",
      existsBefore && !existsAfter,
      `刪除前存在=${existsBefore}, 刪除後存在=${existsAfter}, sessionId=${sessionId}`,
    );
    sessionId = undefined; // 已成功刪除,下面的 finally 不需要再刪一次
  } catch (err) {
    record(
      "步驟19 刪除對話:session.create → session.list 確認存在 → session.delete → session.list 確認不存在",
      false,
      String(err),
    );
  } finally {
    if (sessionId) {
      try {
        await client.rpc("session.delete", { sessionId });
      } catch (err) {
        log(`[cleanup] 刪除步驟19 session 時發生錯誤(忽略): ${err}`);
      }
    }
  }
}

// ---------------------------------------------------------------------
// 步驟 20: 對話中切換 model(M5 Round C 功能3,混合:20a-20d 決定性 / 20e
// 真實模型軟性判定)
//
// 20a-20d 只斷言系統行為(`session.model` 欄位是否確實更新、`session-updated`
// 推播是否同步、acp/pty 是否被明確拒絕),不依賴模型當輪的自由選擇,一律
// 執行(比照步驟13a/14a-e 的先例:混合步驟裡不涉及模型自由選擇的子步驟,
// 不論 `--only` 為何都照常計算)。20e 額外送一個 prompt 驗證換 model 後該
// session 仍能正常完成一輪對話,直接依賴真實模型是否配合,歸 model-behavior
// 組,只在 `--only=model-behavior`(或未指定 `--only`)時才送出這個額外的
// 模型呼叫。
// ---------------------------------------------------------------------
async function sessionSetModelSmokeTest(client, workspaceDir) {
  const FROM_MODEL = "claude-sonnet-5";
  const TO_MODEL = "claude-opus-4-8";
  let sdkProfileId;
  let sdkSessionId;

  // ---- 20a: 建立明確指定 model 的 claude-agent-sdk profile + session,驗證
  //           session.model 建立時預設等於 profile.model ----
  try {
    const profileCreated = await client.rpc("profile.create", {
      name: "E2E SetModel SDK Agent",
      software: "claude-agent-sdk",
      workingDir: workspaceDir,
      model: FROM_MODEL,
    });
    sdkProfileId = profileCreated.profile.id;

    const sessionCreated = await client.rpc(
      "session.create",
      { agentProfileId: sdkProfileId, workingDir: workspaceDir, title: "e2e-step20-setmodel" },
      30_000,
    );
    sdkSessionId = sessionCreated.session.id;

    const listAfterCreate = await client.rpc("session.list", {});
    const sessionRow = listAfterCreate.sessions.find((s) => s.id === sdkSessionId);

    record(
      "步驟20a session.create 時 session.model 預設等於 profile.model",
      sessionCreated.session.model === FROM_MODEL && sessionRow?.model === FROM_MODEL,
      `profile.model=${FROM_MODEL}, session.create 回應的 model=${sessionCreated.session.model}, session.list 查得的 model=${sessionRow?.model}`,
    );
  } catch (err) {
    record("步驟20a session.create 時 session.model 預設等於 profile.model", false, String(err));
    return; // 沒有 session 就無法跑後續子步驟
  }

  // ---- 20b: session.setModel 換成另一個 model,確認 session.model 已更新
  //           (RPC 回應與之後的 session.list 查詢皆一致)----
  try {
    const setResult = await client.rpc("session.setModel", { sessionId: sdkSessionId, model: TO_MODEL });
    const listAfterSet = await client.rpc("session.list", {});
    const sessionRow = listAfterSet.sessions.find((s) => s.id === sdkSessionId);

    record(
      "步驟20b session.setModel 換成新 model 後,session.model 欄位確實更新",
      setResult.session.model === TO_MODEL && sessionRow?.model === TO_MODEL,
      `setResult.session.model=${setResult.session.model}, session.list 查得的 model=${sessionRow?.model}`,
    );
  } catch (err) {
    record("步驟20b session.setModel 換成新 model 後,session.model 欄位確實更新", false, String(err));
  }

  // ---- 20c: session-updated 推播已同步(讓 UI 標題列可以即時反映新 model)----
  // 見 apps/core/src/session/session-manager.ts 的 setSessionModel()——
  // this.emit("session-updated", ...) 在回應這個 RPC 之前就已經 emit/broadcast
  // 完成(同一條連線訊息保序送達),所以這裡的 RPC 一旦 resolve,對應的推播
  // 理論上已經在 client.sessionUpdates 裡,不需要額外等待。
  {
    const pushed = client.sessionUpdates.find((s) => s.id === sdkSessionId && s.model === TO_MODEL);
    record(
      "步驟20c session.setModel 成功後,\"session-updated\" 推播同步帶出新 model(供 UI 標題列即時更新)",
      Boolean(pushed),
      pushed ? `pushed.model=${pushed.model}` : `未在 session-updated 推播歷史中找到 model=${TO_MODEL} 的更新`,
    );
  }

  // ---- 20d: acp/pty session 呼叫 session.setModel 應得到明確錯誤(不可默默
  //           成功)----
  const rejectionCases = [
    {
      software: "acp",
      configKey: "acpConfig",
      args: [path.join(REPO_ROOT, "scripts", "fake-acp-agent.mjs")],
    },
    {
      software: "pty",
      configKey: "ptyConfig",
      args: [path.join(REPO_ROOT, "scripts", "fake-pty-echo.mjs")],
    },
  ];
  for (const { software, configKey, args } of rejectionCases) {
    let rejectProfileId;
    let rejectSessionId;
    try {
      const profileCreated = await client.rpc("profile.create", {
        name: `E2E SetModel Reject (${software})`,
        software,
        workingDir: workspaceDir,
        [configKey]: { command: process.execPath, args },
      });
      rejectProfileId = profileCreated.profile.id;

      const sessionCreated = await client.rpc(
        "session.create",
        { agentProfileId: rejectProfileId, workingDir: workspaceDir, title: `e2e-step20d-${software}` },
        30_000,
      );
      rejectSessionId = sessionCreated.session.id;

      let rejected = false;
      let rejectionMessage;
      try {
        await client.rpc("session.setModel", { sessionId: rejectSessionId, model: TO_MODEL });
      } catch (err) {
        rejected = true;
        rejectionMessage = String(err);
      }

      record(
        `步驟20d session.setModel 對 software="${software}" session 應得到明確錯誤(不可默默成功)`,
        rejected,
        rejected ? `已明確拒絕: ${rejectionMessage}` : "未被拒絕 —— 這是 bug,acp/pty 不應該默默接受換 model 的請求",
      );
    } catch (err) {
      record(`步驟20d session.setModel 對 software="${software}" session 應得到明確錯誤`, false, String(err));
    } finally {
      if (rejectSessionId) {
        try {
          await client.rpc("session.delete", { sessionId: rejectSessionId });
        } catch (err) {
          log(`[cleanup] 刪除步驟20d(${software})session 時發生錯誤(忽略): ${err}`);
        }
      }
    }
  }

  // ---- 20e(model-behavior,軟性):換 model 後該 session 仍能正常完成一輪
  //           對話。硬性斷言只驗證「系統行為」(20a-20d),這裡額外驗證的是
  //           「模型這一輪是否真的配合、正常產出回覆」——依賴真實 API 是否
  //           認得 TO_MODEL 這個 id、額度/權限是否足夠等外部因素,歸類為
  //           model-behavior,失敗不影響 deterministic 組結論。----
  if (shouldRun("model-behavior")) {
    try {
      const expectedReply = "已切換模型測試成功";
      const prompt = `請只回覆這幾個字,不要加任何其他文字、標點或說明:${expectedReply}`;
      const { finalEvent, collected } = await client.drivePrompt(sdkSessionId, prompt, {
        onPermission: async () => "deny",
        timeoutMs: 90_000,
      });
      const { deltas, violation } = analyzeMessageDeltas(collected);
      const completedOk = finalEvent.event.type === "completed";

      record(
        "步驟20e(軟性)換 model 後該 session 仍能正常完成一輪對話",
        completedOk && deltas.length > 0 && !violation,
        `最終事件=${finalEvent.event.type}, deltas=${deltas.length}, violation=${violation ?? "(無)"}`,
        "model-behavior",
      );
    } catch (err) {
      record("步驟20e(軟性)換 model 後該 session 仍能正常完成一輪對話", false, String(err), "model-behavior");
    }
  } else {
    skipNote("步驟20e 換 model 後該 session 仍能正常完成一輪對話", "model-behavior");
  }

  // ---- 清理 ----
  if (sdkSessionId) {
    try {
      await client.rpc("session.delete", { sessionId: sdkSessionId });
    } catch (err) {
      log(`[cleanup] 刪除步驟20 session 時發生錯誤(忽略): ${err}`);
    }
  }
}

// ---------------------------------------------------------------------
// 步驟 21: 設定介面 —— agent 偵測(M5 Round D,決定性測試,不依賴任何真實模型)
//
// 分兩部分:
//   - 21a/21b:不透過 gateway,直接 dynamic import 編譯後的
//     apps/core/dist/detect/agent-detector.js,呼叫其中 export 的
//     `probeCommand()`/`detectAllAgents()` —— 驗證「探測邏輯本身」的確定性
//     行為(node 一定裝、亂數 bogus 命令一定沒裝、整體在合理時間內回覆、不會
//     被單一逾時卡住)。之所以直接 import 編譯產物、不透過 gateway 傳入
//     command 字串,是刻意避免在 gateway 層新增一個「可指定任意命令」的方法
//     ——那本身就是不必要的攻擊面(見 apps/core/src/detect/agent-detector.ts
//     頂端註解「安全設計」第1點)。
//   - 21c-21e:透過已經在跑的 core(與步驟1-20 共用同一個 client/core 子程序)
//     呼叫正式的 `env.detectAgents` gateway 方法,驗證回傳陣列的結構完整性、
//     一定包含 claude-agent-sdk 這個內嵌項(它不依賴任何外部 CLI)。刻意不
//     斷言任何特定外部 CLI(claude/gemini/opencode/codex/aider)是否真的裝
//     了 —— 那是「本機到底裝了什麼」,因機器而異,不是這支腳本該斷言的
//     決定性行為。
// ---------------------------------------------------------------------
async function agentDetectorProbeSmokeTest() {
  if (!shouldRun("deterministic")) {
    skipNote("步驟21a/21b agent-detector 探測邏輯本身(probeCommand/detectAllAgents)", "deterministic");
    return;
  }

  let detectorModule;
  try {
    const modulePath = path.join(REPO_ROOT, "apps", "core", "dist", "detect", "agent-detector.js");
    detectorModule = await import(pathToFileURL(modulePath).href);
  } catch (err) {
    record(
      "步驟21a/21b 載入 apps/core/dist/detect/agent-detector.js(需先 pnpm build)",
      false,
      String(err),
    );
    return;
  }

  // ---- 21a: node(core 本身正是用它跑起來的,必定存在)→ installed=true 且 version 非空 ----
  try {
    const result = await detectorModule.probeCommand("node");
    record(
      "步驟21a probeCommand(\"node\") → installed=true 且 version 非空(node 是執行 core 本身的必要條件,必定存在)",
      result.installed === true && typeof result.version === "string" && result.version.trim().length > 0,
      `result=${JSON.stringify(result)}`,
    );
  } catch (err) {
    record("步驟21a probeCommand(\"node\") → installed=true 且 version 非空", false, String(err));
  }

  // ---- 21b: 一個亂數 bogus 命令名 → installed=false,且在合理時間內回覆(逾時安全)----
  try {
    const bogusCommand = `deskmony-e2e-bogus-cmd-${randomUUID().slice(0, 8)}`;
    const start = Date.now();
    const result = await detectorModule.probeCommand(bogusCommand);
    const elapsedMs = Date.now() - start;
    record(
      "步驟21b probeCommand(亂數 bogus 命令) → installed=false,且在合理時間內回覆(逾時安全,不卡住整體偵測)",
      result.installed === false && elapsedMs < 10_000,
      `result=${JSON.stringify(result)}, elapsedMs=${elapsedMs}`,
    );
  } catch (err) {
    record("步驟21b probeCommand(亂數 bogus 命令) → installed=false", false, String(err));
  }

  // ---- 21b-2: detectAllAgents() 整體在合理時間內完成(即使 allowlist 內有
  //             找不到的命令,也不會被單一探測拖住整個流程)----
  try {
    const start = Date.now();
    const agents = await detectorModule.detectAllAgents();
    const elapsedMs = Date.now() - start;
    record(
      "步驟21b-2 detectAllAgents() 整體在合理時間內完成(逾時安全,不會被單一探測卡住整個偵測)",
      Array.isArray(agents) && agents.length > 0 && elapsedMs < 15_000,
      `agents.length=${agents.length}, elapsedMs=${elapsedMs}`,
    );
  } catch (err) {
    record("步驟21b-2 detectAllAgents() 整體在合理時間內完成", false, String(err));
  }
}

async function detectAgentsGatewaySmokeTest(client) {
  if (!shouldRun("deterministic")) {
    skipNote("步驟21c-21e env.detectAgents gateway 方法", "deterministic");
    return;
  }

  try {
    const result = await client.rpc("env.detectAgents", {}, 20_000);
    const agents = result?.agents;
    const isArray = Array.isArray(agents);

    record(
      "步驟21c env.detectAgents 回傳結構正確({ agents: [...] } 陣列)",
      isArray,
      `typeof result=${typeof result}, isArray=${isArray}, length=${agents?.length}`,
    );
    if (!isArray) return;

    const allEntriesValid = agents.every(
      (a) =>
        typeof a.key === "string" &&
        a.key.length > 0 &&
        typeof a.displayName === "string" &&
        typeof a.software === "string" &&
        typeof a.installed === "boolean" &&
        Array.isArray(a.models) &&
        a.models.every((m) => typeof m.id === "string" && typeof m.label === "string"),
    );
    record(
      "步驟21d env.detectAgents 每一項結構完整(key/displayName/software/installed:boolean/models 陣列)",
      allEntriesValid,
      `agents=${JSON.stringify(agents)}`,
    );

    // claude-agent-sdk 這輪起移除了寫死的 KNOWN_CLAUDE_MODELS fallback(見
    // agent-detector.ts detectClaudeAgentSdk() 註解:舊清單會過時、比不顯示
    // 更容易誤導使用者)——models 是否非空完全取決於這台跑 e2e 的機器有沒有
    // 設定 ANTHROPIC_API_KEY 且能成功查到 Anthropic Models API,不是決定性
    // 行為,不能再斷言 `models.length > 0`。改成只斷言結構本身(一定存在、
    // installed=true、models 一定是陣列),models 是否有內容不斷言。
    const sdkEntry = agents.find((a) => a.key === "claude-agent-sdk");
    const sdkOk =
      Boolean(sdkEntry) && sdkEntry.software === "claude-agent-sdk" && sdkEntry.installed === true && Array.isArray(sdkEntry.models);
    record(
      "步驟21e env.detectAgents 一定包含 claude-agent-sdk 內嵌項(installed=true,models 是陣列,不依賴任何外部 CLI;是否非空視本機是否有 ANTHROPIC_API_KEY 而定,不斷言)",
      sdkOk,
      `sdkEntry=${JSON.stringify(sdkEntry)}`,
    );
  } catch (err) {
    record("步驟21c-21e env.detectAgents gateway 方法", false, String(err));
  }
}

// ---------------------------------------------------------------------
// 步驟 22:「偵測項 → 可建立 (software,command) 映射」純函式
// (packages/shared/src/agent-target.ts,M5 Round E 新增,決定性測試,
// 不需要 core/gateway,直接 import 編譯產物驗證)
//
// 對應 ProfileCreateDialog.tsx 需求2「software 下拉只能選偵測到的項目,且
// 每個選項都必須映射到可建立的 (software, command)」——這裡驗證的正是那個
// 推導邏輯本身:claude-agent-sdk 內嵌項不需要 command;偵測分類為
// "opencode" 的項目這輪映射成 software="opencode"(OpenCodeAdapter 已實作,
// 見步驟24);key==="codex-acp" 的項目(Codex ACP 橋接切換 Phase 1 新增)映射
// 成 software="acp"(見 22b-3);其餘偵測分類(acp/codex/pty)一律預設映射成
// software="pty" + command=偵測到的路徑(codex 這個 software 分類值目前已無
// 任何偵測項會產生,型別上仍保留防禦性 fallback,不會產生
// software="codex" 這種 AdapterRegistry 建不起來的 profile);只有偵測分類
// 本身就是 "acp" 且 key !== "codex-acp" 的項目才有「進階:改用 ACP」的候選
// 可用(見 22d)。
// ---------------------------------------------------------------------
async function agentTargetDerivationSmokeTest() {
  if (!shouldRun("deterministic")) {
    skipNote("步驟22 偵測項 → 可建立 (software,command) 映射(packages/shared/src/agent-target.ts)", "deterministic");
    return;
  }

  let mod;
  try {
    const modulePath = path.join(REPO_ROOT, "packages", "shared", "dist", "agent-target.js");
    mod = await import(pathToFileURL(modulePath).href);
  } catch (err) {
    record("步驟22a 載入 packages/shared/dist/agent-target.js(需先 pnpm build)", false, String(err));
    return;
  }

  const makeEntry = (overrides) => ({
    key: "fixture",
    displayName: "Fixture",
    installed: true,
    models: [],
    ...overrides,
  });

  // ---- 22a: claude-agent-sdk 內嵌項 → software 固定 claude-agent-sdk,不需要 command ----
  try {
    const entry = makeEntry({ software: "claude-agent-sdk" });
    const target = mod.deriveDefaultAgentTarget(entry);
    record(
      '步驟22a deriveDefaultAgentTarget(claude-agent-sdk 內嵌項) → software="claude-agent-sdk",不需要 command',
      target.software === "claude-agent-sdk" && target.command === undefined,
      `target=${JSON.stringify(target)}`,
    );
  } catch (err) {
    record("步驟22a deriveDefaultAgentTarget(claude-agent-sdk 內嵌項)", false, String(err));
  }

  // ---- 22b: acp/codex/pty 這幾種偵測分類一律預設映射成 pty + command 非空
  //           —— software 一定是 claude-agent-sdk/acp/pty/opencode 之一
  //           (AdapterRegistry 實際註冊過的四種),不會是 codex(codex 目前
  //           仍無對應 adapter)----
  try {
    const classifications = ["acp", "codex", "pty"];
    const results = classifications.map((software) => {
      const entry = makeEntry({ software, path: `C:\\fake\\${software}.exe` });
      return { software, target: mod.deriveDefaultAgentTarget(entry) };
    });
    const validSoftwareSet = new Set(["claude-agent-sdk", "acp", "pty", "opencode"]);
    const allOk = results.every(
      (r) =>
        validSoftwareSet.has(r.target.software) &&
        r.target.software === "pty" &&
        typeof r.target.command === "string" &&
        r.target.command.length > 0,
    );
    record(
      '步驟22b deriveDefaultAgentTarget(外部 CLI:acp/codex/pty 分類)一律預設映射為 software="pty" 且 command 非空(不會產生建不起來的 codex profile)',
      allOk,
      `results=${JSON.stringify(results)}`,
    );
  } catch (err) {
    record("步驟22b deriveDefaultAgentTarget(外部 CLI 分類)一律映射為 pty", false, String(err));
  }

  // ---- 22b-2: opencode 分類這輪已經有真正的 adapter,映射成 software="opencode"
  //             本身(不再退化成 pty),command 帶入偵測到的路徑 ----
  try {
    const entry = makeEntry({ software: "opencode", path: "C:\\fake\\opencode.exe" });
    const target = mod.deriveDefaultAgentTarget(entry);
    record(
      '步驟22b-2 deriveDefaultAgentTarget(opencode 分類) → software="opencode"(OpenCodeAdapter 已實作,不再退化成 pty),command 非空',
      target.software === "opencode" && target.command === "C:\\fake\\opencode.exe",
      `target=${JSON.stringify(target)}`,
    );
  } catch (err) {
    record("步驟22b-2 deriveDefaultAgentTarget(opencode 分類)", false, String(err));
  }

  // ---- 22b-3: key==="codex-acp"(Codex ACP 橋接切換 Phase 1 新增)一律映射
  //             成 software="acp",不受 pty fallback 規則影響——即使 software
  //             欄位本身也已經是 "acp"(detectCodexAcp() 的實際回傳值),這裡
  //             刻意驗證的是「用 key 判斷」這條路徑本身有效,不是巧合命中
  //             既有的 acp 分類。command 帶入偵測到的路徑。----
  try {
    const entry = makeEntry({ key: "codex-acp", software: "acp", path: "C:\\fake\\node.exe" });
    const target = mod.deriveDefaultAgentTarget(entry);
    record(
      '步驟22b-3 deriveDefaultAgentTarget(key="codex-acp") → software="acp",command=偵測到的路徑',
      target.software === "acp" && target.command === "C:\\fake\\node.exe",
      `target=${JSON.stringify(target)}`,
    );
  } catch (err) {
    record('步驟22b-3 deriveDefaultAgentTarget(key="codex-acp")', false, String(err));
  }

  // ---- 22c: 沒有偵測到路徑的項目 → command 為 undefined(呼叫端只應讓
  //           installed=true 且有 path 的項目可被選取,這裡驗證推導函式本身
  //           不會憑空捏造一個 command)----
  try {
    const entry = makeEntry({ software: "pty", path: undefined, installed: false });
    const target = mod.deriveDefaultAgentTarget(entry);
    record(
      "步驟22c deriveDefaultAgentTarget(未偵測到 path 的項目) → command 為 undefined",
      target.software === "pty" && target.command === undefined,
      `target=${JSON.stringify(target)}`,
    );
  } catch (err) {
    record("步驟22c deriveDefaultAgentTarget(未偵測到 path 的項目)", false, String(err));
  }

  // ---- 22d: canUseAcpAdvanced/deriveAcpAdvancedTarget 只對偵測分類本身是
  //           "acp" 且有 path 的項目開放進階選項(opencode/codex/aider 沒有
  //           這個選項);key==="codex-acp" 這個特例即使 software==="acp" 也要
  //           被排除(Codex ACP 橋接切換 Phase 1 新增——預設已經是 acp 了,
  //           不需要多一個形同雞肋的「進階」選項,見 agent-target.ts
  //           canUseAcpAdvanced() 的排除條件)----
  try {
    const acpEntry = makeEntry({ software: "acp", path: "C:\\fake\\claude.exe" });
    const opencodeEntry = makeEntry({ software: "opencode", path: "C:\\fake\\opencode.exe" });
    const acpNoPathEntry = makeEntry({ software: "acp", path: undefined });
    const codexAcpEntry = makeEntry({ key: "codex-acp", software: "acp", path: "C:\\fake\\node.exe" });

    const acpAdvancedOk = mod.canUseAcpAdvanced(acpEntry) === true;
    const opencodeAdvancedOk = mod.canUseAcpAdvanced(opencodeEntry) === false;
    const acpNoPathOk = mod.canUseAcpAdvanced(acpNoPathEntry) === false;
    const codexAcpAdvancedOk = mod.canUseAcpAdvanced(codexAcpEntry) === false;

    const acpTarget = mod.deriveAcpAdvancedTarget(acpEntry);
    const acpTargetOk =
      acpTarget?.software === "acp" && typeof acpTarget.command === "string" && acpTarget.command.length > 0;
    const opencodeTargetUndefined = mod.deriveAcpAdvancedTarget(opencodeEntry) === undefined;
    const codexAcpTargetUndefined = mod.deriveAcpAdvancedTarget(codexAcpEntry) === undefined;

    record(
      "步驟22d canUseAcpAdvanced/deriveAcpAdvancedTarget 只對偵測分類本身是 acp 且有 path、key!==\"codex-acp\" 的項目開放「進階:改用 ACP」(opencode/codex/aider 沒有這個選項,codex-acp 預設已是 acp 故也排除)",
      acpAdvancedOk &&
        opencodeAdvancedOk &&
        acpNoPathOk &&
        codexAcpAdvancedOk &&
        acpTargetOk &&
        opencodeTargetUndefined &&
        codexAcpTargetUndefined,
      `acpAdvancedOk=${acpAdvancedOk}, opencodeAdvancedOk=${opencodeAdvancedOk}, acpNoPathOk=${acpNoPathOk}, codexAcpAdvancedOk=${codexAcpAdvancedOk}, acpTarget=${JSON.stringify(acpTarget)}, opencodeTargetUndefined=${opencodeTargetUndefined}, codexAcpTargetUndefined=${codexAcpTargetUndefined}`,
    );
  } catch (err) {
    record("步驟22d canUseAcpAdvanced/deriveAcpAdvancedTarget", false, String(err));
  }
}

// ---------------------------------------------------------------------
// 步驟 23:設定持久化(settings.getEnabledModels / settings.setEnabledModels,
// M5 Round E 新增,決定性測試,全程不叫任何真實模型)
//
// 獨立管理自己的 core 子程序(不與步驟1-16/21 共用),因為 23c 需要「用同一個
// DESKMONY_DATA_DIR 重啟一個全新 core 子程序」來證明設定真的落地 SQLite 檔案
// 而不是只存在記憶體——這與其他步驟共用 core 生命週期的假設衝突,獨立設置
// 比較乾淨。
// ---------------------------------------------------------------------
async function settingsPersistenceSmokeTest() {
  if (!shouldRun("deterministic")) {
    skipNote("步驟23 設定持久化(settings.getEnabledModels / setEnabledModels,DB 落地驗證)", "deterministic");
    return;
  }

  const PORT = 4324;
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-settings-data-"));
  const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-settings-ws-"));
  const url = `ws://localhost:${PORT}`;
  const chosenIds = ["claude-sonnet-5", "claude-opus-4-8"];
  let coreProc;
  let client;

  const sortedJson = (arr) => JSON.stringify([...arr].sort());

  try {
    coreProc = startCore({ port: PORT, dataDir, workspaceDir, permissionTimeoutMs: PERMISSION_TIMEOUT_MS });
    await waitForPort(url, 20_000);
    client = new GatewayClient(url);
    await client.connect();

    // ---- 23a: 未曾設定過時,約定「空陣列 = 全部啟用」----
    try {
      const result = await client.rpc("settings.getEnabledModels", {});
      record(
        "步驟23a 未曾呼叫 setEnabledModels 時,settings.getEnabledModels 回傳空陣列(約定:空陣列=全部啟用)",
        Array.isArray(result.enabledModelIds) && result.enabledModelIds.length === 0,
        `result=${JSON.stringify(result)}`,
      );
    } catch (err) {
      record("步驟23a 未設定時 settings.getEnabledModels 回傳空陣列", false, String(err));
    }

    // ---- 23b: setEnabledModels 後,同一條連線內 getEnabledModels 讀回一致 ----
    try {
      const setResult = await client.rpc("settings.setEnabledModels", { enabledModelIds: chosenIds });
      const getResult = await client.rpc("settings.getEnabledModels", {});
      const setOk = sortedJson(setResult.enabledModelIds) === sortedJson(chosenIds);
      const getOk = sortedJson(getResult.enabledModelIds) === sortedJson(chosenIds);
      record(
        "步驟23b settings.setEnabledModels 後,同一連線內 getEnabledModels 讀回一致",
        setOk && getOk,
        `setResult=${JSON.stringify(setResult)}, getResult=${JSON.stringify(getResult)}`,
      );
    } catch (err) {
      record("步驟23b setEnabledModels 後 getEnabledModels 讀回一致", false, String(err));
    }

    client.close();
    await killProcessTree(coreProc, "core(步驟23 設定持久化,第一個 core 進程)");
    coreProc = undefined;

    // ---- 23c: 用同一個 DESKMONY_DATA_DIR 重啟一個全新的 core 子程序,
    //           getEnabledModels 仍讀回相同的值 —— 證明真的落地 SQLite,不是
    //           只存在上一個 process 的記憶體。----
    coreProc = startCore({ port: PORT, dataDir, workspaceDir, permissionTimeoutMs: PERMISSION_TIMEOUT_MS });
    await waitForPort(url, 20_000);
    client = new GatewayClient(url);
    await client.connect();
    try {
      const result = await client.rpc("settings.getEnabledModels", {});
      const ok = sortedJson(result.enabledModelIds) === sortedJson(chosenIds);
      record(
        "步驟23c 重啟指向同一個 DESKMONY_DATA_DIR 的全新 core 子程序後,settings.getEnabledModels 仍讀回相同的值(證明真的落地 SQLite,不是記憶體)",
        ok,
        `result=${JSON.stringify(result)}`,
      );
    } catch (err) {
      record("步驟23c 重啟後 settings.getEnabledModels 仍讀回相同的值", false, String(err));
    }

    // ---- 23d: 全部勾選存回空陣列的情境(SettingsDialog 的 EnabledModelsEditor
    //           會這樣做)——setEnabledModels([]) 後應回到「全部啟用」語意。----
    try {
      await client.rpc("settings.setEnabledModels", { enabledModelIds: [] });
      const result = await client.rpc("settings.getEnabledModels", {});
      record(
        "步驟23d settings.setEnabledModels([]) 後,getEnabledModels 回傳空陣列(回到「全部啟用」語意)",
        Array.isArray(result.enabledModelIds) && result.enabledModelIds.length === 0,
        `result=${JSON.stringify(result)}`,
      );
    } catch (err) {
      record("步驟23d setEnabledModels([]) 後回到全部啟用語意", false, String(err));
    }
  } catch (err) {
    record("步驟23 設定持久化(整體設置失敗)", false, String(err));
  } finally {
    client?.close();
    await killProcessTree(coreProc, "core(步驟23 設定持久化)");
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    try {
      rmSync(workspaceDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

// ---------------------------------------------------------------------
// 步驟 25:provider 目錄「resolveProviders()」純函式
// (packages/shared/src/resolve-providers.ts、provider-catalog.ts,這輪
// provider 目錄重構新增,決定性測試,不需要 core/gateway,直接 import 編譯
// 產物驗證——比照步驟22 對 deriveDefaultAgentTarget() 的測法)
// ---------------------------------------------------------------------
async function resolveProvidersSmokeTest() {
  if (!shouldRun("deterministic")) {
    skipNote("步驟25 provider 目錄 resolveProviders() 純函式", "deterministic");
    return;
  }

  let resolveMod;
  let catalogMod;
  try {
    resolveMod = await import(pathToFileURL(path.join(REPO_ROOT, "packages", "shared", "dist", "resolve-providers.js")).href);
    catalogMod = await import(pathToFileURL(path.join(REPO_ROOT, "packages", "shared", "dist", "provider-catalog.js")).href);
  } catch (err) {
    record("步驟25a 載入 packages/shared/dist/{resolve-providers,provider-catalog}.js(需先 pnpm build)", false, String(err));
    return;
  }

  const { resolveProviders } = resolveMod;
  const { BUILTIN_PROVIDERS } = catalogMod;
  const VALID_SOFTWARE = new Set(["claude-agent-sdk", "acp", "pty", "opencode"]);

  // ---- 25a: BUILTIN_PROVIDERS 本身每一項的 software 一定是 AdapterRegistry
  //           實際註冊過的四種之一,絕不可能是 "codex" 這個 AgentSoftware 分類
  //           值(呼應步驟22 對 deriveDefaultAgentTarget() 的同一條原則,這裡是
  //           對 provider 目錄套用)——"aider" 這種目前沒有專屬 adapter 的
  //           provider 映射成 "pty";"codex" 這個 provider 這輪(Codex ACP
  //           橋接切換)起改映射成 "acp"(見 25k,透過
  //           `@agentclientprotocol/codex-acp` 橋接套件,不是直接映射成
  //           software="codex" 這個不存在的 adapter)。----
  try {
    const allValid = BUILTIN_PROVIDERS.every((p) => VALID_SOFTWARE.has(p.software));
    const noCodexSoftware = BUILTIN_PROVIDERS.every((p) => p.software !== "codex");
    record(
      '步驟25a BUILTIN_PROVIDERS 每一項的 software 皆為已註冊四種之一(不會產生 software="codex" 這種建不起來的組合)',
      allValid && noCodexSoftware,
      `softwares=${JSON.stringify(BUILTIN_PROVIDERS.map((p) => ({ id: p.id, software: p.software })))}`,
    );
  } catch (err) {
    record("步驟25a BUILTIN_PROVIDERS software 皆已註冊", false, String(err));
  }

  // claude-agent-sdk/claude-cli 這輪起 BUILTIN_PROVIDERS 的靜態 models 改成
  // CLAUDE_MODEL_ALIASES(opus/sonnet/haiku/fable 這幾個 claude CLI/SDK 原生
  // 支援、永遠指向「目前最新版」的別名,見 known-models.ts 該常數的完整理由
  // ——跟先前移除的 KNOWN_CLAUDE_MODELS 日期快照清單不是同一回事,不會過
  // 期),不再是 `[]`;這裡的 fixture 額外用兩個假 model 模擬「偵測到一份
  // 即時清單,合併在別名之後」,下方 25h/25i 用 baselineSdkModels(靜態別名
  // + fixture 偵測結果合併後的清單)當比對基準,不假設任何固定筆數。
  const fixtureDetection = [
    {
      key: "claude-agent-sdk",
      displayName: "SDK",
      software: "claude-agent-sdk",
      installed: true,
      models: [
        { id: "claude-opus-4-8", label: "Claude Opus 4.8" },
        { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
      ],
    },
    {
      key: "claude-code-cli",
      displayName: "Claude Code CLI",
      software: "acp",
      installed: true,
      path: "C:\\fake\\claude.exe",
      version: "1.2.3",
      models: [],
    },
    { key: "gemini-cli", displayName: "Gemini CLI", software: "acp", installed: false, models: [] },
    { key: "opencode-cli", displayName: "OpenCode", software: "opencode", installed: true, path: "C:\\fake\\opencode.exe", models: [] },
    // Codex ACP 橋接切換 Phase 1:偵測項改成 key="codex-acp"/software="acp",
    // path/args 模擬 detectCodexAcp() 真正的回傳形狀(process.execPath + 解析
    // 出來的橋接套件進入點路徑,見 apps/core/src/detect/agent-detector.ts)。
    // 25k 用這筆 fixture 驗證 resolveProviders() 把 detected.args 帶進
    // defaultArgs(取代目錄靜態預設),覆蓋 resolve-providers.ts 這輪新增的
    // `detected?.args ?? entry.defaultArgs` 那一行。
    {
      key: "codex-acp",
      displayName: "Codex",
      software: "acp",
      installed: true,
      path: "C:\\fake\\node.exe",
      args: ["C:\\fake\\codex-acp\\dist\\index.js"],
      models: [],
    },
    { key: "aider-cli", displayName: "Aider", software: "pty", installed: false, models: [] },
  ];

  // claude-agent-sdk 的「沒有使用者偏好時的基礎 model 清單」——靜態目錄本身是
  // CLAUDE_MODEL_ALIASES(見 provider-catalog.ts 該項註解),跟偵測結果
  // (fixtureDetection)以 id 去重合併(別名在前,偵測到的即時清單附加在
  // 後)。25h/25i 都要用這份基準做比對,在這裡算一次共用。
  const baselineSdkModels = resolveProviders(BUILTIN_PROVIDERS, fixtureDetection, {}).find(
    (p) => p.id === "claude-agent-sdk",
  ).models;

  // ---- 25b: 沒有任何使用者偏好時,resolveProviders() 的輸出一定也只會是
  //           已註冊四種之一(對整個合併輸出再次套用同一條規則,而不只是
  //           靜態目錄本身)。----
  try {
    const resolved = resolveProviders(BUILTIN_PROVIDERS, fixtureDetection, {});
    const allValid = resolved.every((p) => VALID_SOFTWARE.has(p.software));
    record(
      "步驟25b resolveProviders() 輸出的 software 一定是已註冊四種之一",
      allValid,
      `resolved=${JSON.stringify(resolved.map((p) => ({ id: p.id, software: p.software })))}`,
    );
  } catch (err) {
    record("步驟25b resolveProviders() 輸出 software 已註冊", false, String(err));
  }

  // ---- 25c: 未安裝的偵測項正確標示 installed=false、command=undefined
  //           (gemini 這裡故意設 installed:false,無 path)。----
  try {
    const resolved = resolveProviders(BUILTIN_PROVIDERS, fixtureDetection, {});
    const gemini = resolved.find((p) => p.id === "gemini");
    record(
      "步驟25c 未安裝的偵測項(gemini installed:false)→ resolveProviders() 標示 installed=false 且 command=undefined",
      gemini?.installed === false && gemini?.command === undefined,
      `gemini=${JSON.stringify(gemini)}`,
    );
  } catch (err) {
    record("步驟25c 未安裝偵測項標示正確", false, String(err));
  }

  // ---- 25d: 已安裝且偵測到路徑的項目 → installed=true,command=偵測到的路徑
  //           (claude-cli ← claude-code-cli 偵測項)。----
  try {
    const resolved = resolveProviders(BUILTIN_PROVIDERS, fixtureDetection, {});
    const claudeCli = resolved.find((p) => p.id === "claude-cli");
    record(
      "步驟25d 已安裝的偵測項(claude-code-cli)→ resolveProviders() 帶入 installed=true 與偵測到的完整路徑",
      claudeCli?.installed === true && claudeCli?.command === "C:\\fake\\claude.exe" && claudeCli?.detectedVersion === "1.2.3",
      `claudeCli=${JSON.stringify(claudeCli)}`,
    );
  } catch (err) {
    record("步驟25d 已安裝偵測項帶入路徑/版本", false, String(err));
  }

  // ---- 25e: custom-pty(無 detectKey)一律 installed=true、command=undefined,
  //           不受偵測結果影響(即使偵測陣列整個是空的)。----
  try {
    const resolved = resolveProviders(BUILTIN_PROVIDERS, [], {});
    const custom = resolved.find((p) => p.id === "custom-pty");
    record(
      "步驟25e custom-pty(無 detectKey)一律 installed=true 且 command=undefined,不受偵測結果影響",
      custom?.installed === true && custom?.command === undefined,
      `custom=${JSON.stringify(custom)}`,
    );
  } catch (err) {
    record("步驟25e custom-pty 不受偵測影響", false, String(err));
  }

  // ---- 25f: enabled/order/label 覆寫生效 ----
  try {
    const prefs = {
      gemini: { enabled: false, order: -100, label: "我的 Gemini" },
    };
    const resolved = resolveProviders(BUILTIN_PROVIDERS, fixtureDetection, prefs);
    const gemini = resolved.find((p) => p.id === "gemini");
    const isFirst = resolved[0]?.id === "gemini"; // order=-100 应排最前面
    record(
      "步驟25f 使用者偏好的 enabled/order/label 覆寫生效(gemini 停用、排序移到最前、label 改名)",
      gemini?.enabled === false && gemini?.order === -100 && gemini?.label === "我的 Gemini" && isFirst,
      `gemini=${JSON.stringify(gemini)}, firstId=${resolved[0]?.id}`,
    );
  } catch (err) {
    record("步驟25f enabled/order/label 覆寫生效", false, String(err));
  }

  // ---- 25g: models 整批取代(claude-agent-sdk 的 KNOWN_CLAUDE_MODELS 被
  //           pref.models 完全取代,不是合併)----
  try {
    const prefs = {
      "claude-agent-sdk": { models: [{ id: "only-model", label: "Only Model", isDefault: true }] },
    };
    const resolved = resolveProviders(BUILTIN_PROVIDERS, fixtureDetection, prefs);
    const sdk = resolved.find((p) => p.id === "claude-agent-sdk");
    record(
      "步驟25g pref.models 整批取代目錄預設模型清單(不是合併)",
      sdk?.models.length === 1 && sdk.models[0].id === "only-model" && sdk.defaultModelId === "only-model",
      `sdk=${JSON.stringify(sdk)}`,
    );
  } catch (err) {
    record("步驟25g models 整批取代", false, String(err));
  }

  // ---- 25h: additionalModels 合併(以 id 去重,使用者定義優先;既有 id 原地
  //           覆寫、新 id 附加在尾端;defaultModelId 隨新的 isDefault 標記
  //           移動)----
  //           注意:claude-agent-sdk 的「基礎」model 清單是 BUILTIN_PROVIDERS
  //           靜態的 CLAUDE_MODEL_ALIASES 跟 fixtureDetection 合併後的結果
  //          (見 provider-catalog.ts 該項註解),所以這裡先呼叫一次
  //           resolveProviders(prefs={}) 拿「沒有使用者偏好時的基礎清單」當
  //           作比對基準,不假設任何固定筆數/固定第一筆是哪個 id。
  try {
    const firstBuiltinModelId = baselineSdkModels[0].id; // 偵測結果第一個(目前 fixture 沒標 isDefault,故取第一個)
    const prefs = {
      "claude-agent-sdk": {
        additionalModels: [
          { id: firstBuiltinModelId, label: "使用者自訂標籤" }, // 覆寫既有 id,且不再帶 isDefault
          { id: "brand-new-model", label: "全新模型", isDefault: true }, // 新 id,標記為預設
        ],
      },
    };
    const resolved = resolveProviders(BUILTIN_PROVIDERS, fixtureDetection, prefs);
    const sdk = resolved.find((p) => p.id === "claude-agent-sdk");
    const expectedLength = baselineSdkModels.length + 1; // 一個原地覆寫 + 一個新增
    const overriddenModel = sdk.models.find((m) => m.id === firstBuiltinModelId);
    const newModelIndex = sdk.models.findIndex((m) => m.id === "brand-new-model");
    const overriddenIndex = sdk.models.findIndex((m) => m.id === firstBuiltinModelId);
    record(
      "步驟25h pref.additionalModels 以 id 去重合併(使用者定義優先覆寫既有項、新項附加在尾端),defaultModelId 隨新標記移動",
      sdk.models.length === expectedLength &&
        overriddenModel?.label === "使用者自訂標籤" &&
        newModelIndex === sdk.models.length - 1 &&
        overriddenIndex === 0 && // 原地覆寫,位置不變(仍是陣列第一個)
        sdk.defaultModelId === "brand-new-model",
      `sdk.models=${JSON.stringify(sdk.models)}, defaultModelId=${sdk.defaultModelId}`,
    );
  } catch (err) {
    record("步驟25h additionalModels 合併(id 去重、使用者優先)", false, String(err));
  }

  // ---- 25i: enabledModelIds 過濾(空陣列/省略 = 全部啟用,非空則只保留交集)----
  //           同 25h,基準清單改讀偵測結果(baselineSdkModels),不是靜態目錄。
  try {
    const keepId = baselineSdkModels[1]?.id ?? baselineSdkModels[0].id;
    const prefsFiltered = { "claude-agent-sdk": { enabledModelIds: [keepId] } };
    const prefsEmpty = { "claude-agent-sdk": { enabledModelIds: [] } };
    const resolvedFiltered = resolveProviders(BUILTIN_PROVIDERS, fixtureDetection, prefsFiltered);
    const resolvedEmpty = resolveProviders(BUILTIN_PROVIDERS, fixtureDetection, prefsEmpty);
    const sdkFiltered = resolvedFiltered.find((p) => p.id === "claude-agent-sdk");
    const sdkEmpty = resolvedEmpty.find((p) => p.id === "claude-agent-sdk");
    record(
      "步驟25i enabledModelIds 非空時只保留交集,空陣列時等同全部啟用",
      sdkFiltered.models.length === 1 &&
        sdkFiltered.models[0].id === keepId &&
        sdkEmpty.models.length === baselineSdkModels.length,
      `sdkFiltered.models=${JSON.stringify(sdkFiltered.models)}, sdkEmpty.models.length=${sdkEmpty.models.length}, baseline.length=${baselineSdkModels.length}`,
    );
  } catch (err) {
    record("步驟25i enabledModelIds 過濾", false, String(err));
  }

  // ---- 25j: 輸出依 order 排序(升冪)----
  try {
    const resolved = resolveProviders(BUILTIN_PROVIDERS, fixtureDetection, {});
    let sorted = true;
    for (let i = 1; i < resolved.length; i++) {
      if (resolved[i - 1].order > resolved[i].order) sorted = false;
    }
    record(
      "步驟25j resolveProviders() 輸出依 order 升冪排序",
      sorted,
      `orders=${JSON.stringify(resolved.map((p) => ({ id: p.id, order: p.order })))}`,
    );
  } catch (err) {
    record("步驟25j 輸出依 order 排序", false, String(err));
  }

  // ---- 25k: Codex ACP 橋接切換 Phase 1——codex provider 這輪起 software 改
  //           為 "acp",且 command/defaultArgs 必須反映 fixtureDetection 那筆
  //           codex-acp 偵測結果(detected.path/detected.args),不是目錄的
  //           靜態預設(BUILTIN_PROVIDERS 的 codex 項目本身刻意不寫
  //           defaultArgs,見 provider-catalog.ts)。覆蓋 resolve-providers.ts
  //           這輪新增的 `defaultArgs: detected?.args ?? entry.defaultArgs`
  //           那一行——沒有這筆斷言,那一行的邏輯完全沒有測試覆蓋率。----
  try {
    const resolved = resolveProviders(BUILTIN_PROVIDERS, fixtureDetection, {});
    const codex = resolved.find((p) => p.id === "codex");
    record(
      '步驟25k resolveProviders() 的 codex provider software="acp",command/defaultArgs 反映偵測結果的 path/args(不是目錄靜態預設)',
      codex?.software === "acp" &&
        codex?.installed === true &&
        codex?.command === "C:\\fake\\node.exe" &&
        Array.isArray(codex?.defaultArgs) &&
        codex.defaultArgs.length === 1 &&
        codex.defaultArgs[0] === "C:\\fake\\codex-acp\\dist\\index.js",
      `codex=${JSON.stringify(codex)}`,
    );
  } catch (err) {
    record("步驟25k resolveProviders() codex provider 反映 codex-acp 偵測結果", false, String(err));
  }
}

// ---------------------------------------------------------------------
// 步驟 26:per-provider 偏好持久化(settings.getProviderPrefs /
// settings.setProviderPrefs,這輪新增,決定性測試,全程不叫任何真實模型)
//
// 獨立管理自己的 core 子程序(比照步驟23 settingsPersistenceSmokeTest() 的
// 先例——26d 需要「用同一個 DESKMONY_DATA_DIR 重啟一個全新 core 子程序」證明
// 落地 SQLite)。
// ---------------------------------------------------------------------
async function providerPrefsPersistenceSmokeTest() {
  if (!shouldRun("deterministic")) {
    skipNote("步驟26 per-provider 偏好持久化(settings.getProviderPrefs / setProviderPrefs)", "deterministic");
    return;
  }

  const PORT = 4325;
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-providerprefs-data-"));
  const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-providerprefs-ws-"));
  const url = `ws://localhost:${PORT}`;
  let coreProc;
  let client;

  try {
    coreProc = startCore({ port: PORT, dataDir, workspaceDir, permissionTimeoutMs: PERMISSION_TIMEOUT_MS });
    await waitForPort(url, 20_000);
    client = new GatewayClient(url);
    await client.connect();

    // ---- 26a: 未曾設定過的 provider 不會出現在 getProviderPrefs 的稀疏 map 裡 ----
    try {
      const result = await client.rpc("settings.getProviderPrefs", {});
      record(
        "步驟26a 未曾呼叫 setProviderPrefs 時,getProviderPrefs 回傳的 prefs 不含 claude-cli(稀疏 map,未覆寫的維持目錄預設)",
        result.prefs && typeof result.prefs === "object" && !("claude-cli" in result.prefs),
        `result=${JSON.stringify(result)}`,
      );
    } catch (err) {
      record("步驟26a 未設定時 getProviderPrefs 不含該 provider", false, String(err));
    }

    // ---- 26b: setProviderPrefs 後,回應與同連線內 getProviderPrefs 都反映
    //           patch 的值,且 env 已遮罩(不是明文)----
    const secretValue = "sk-ant-topsecret-e2e-value";
    try {
      const setResult = await client.rpc("settings.setProviderPrefs", {
        providerId: "claude-cli",
        patch: { enabled: false, order: 5, label: "My Claude", env: { ANTHROPIC_API_KEY: secretValue } },
      });
      const getResult = await client.rpc("settings.getProviderPrefs", {});
      const setPref = setResult.prefs["claude-cli"];
      const getPref = getResult.prefs["claude-cli"];
      const fieldsOk =
        setPref?.enabled === false &&
        setPref?.order === 5 &&
        setPref?.label === "My Claude" &&
        getPref?.enabled === false &&
        getPref?.order === 5 &&
        getPref?.label === "My Claude";
      // 安全斷言核心:整個 response 不論序列化成什麼字串,都不可以含有明文 secretValue,
      // 且該 key 確實存在、但值必須是遮罩過的 "***"。
      const noPlaintextInSet = !JSON.stringify(setResult).includes(secretValue);
      const noPlaintextInGet = !JSON.stringify(getResult).includes(secretValue);
      const envMaskedOk = setPref?.env?.ANTHROPIC_API_KEY === "***" && getPref?.env?.ANTHROPIC_API_KEY === "***";
      record(
        "步驟26b settings.setProviderPrefs 後,回應與同連線內 getProviderPrefs 都反映 patch 值,且 env 已遮罩、回應中不含明文金鑰",
        fieldsOk && noPlaintextInSet && noPlaintextInGet && envMaskedOk,
        `setPref=${JSON.stringify(setPref)}, getPref=${JSON.stringify(getPref)}`,
      );
    } catch (err) {
      record("步驟26b setProviderPrefs 生效且 env 遮罩", false, String(err));
    }

    // ---- 26c: env 是淺層合併(新增另一個 key 後,原本的 key 仍保留)----
    try {
      const patchResult = await client.rpc("settings.setProviderPrefs", {
        providerId: "claude-cli",
        patch: { env: { ANOTHER_KEY: "another-secret-value" } },
      });
      const envKeys = Object.keys(patchResult.prefs["claude-cli"]?.env ?? {}).sort();
      record(
        "步驟26c env 是淺層合併(新增 ANOTHER_KEY 後,原本的 ANTHROPIC_API_KEY 仍保留,不會被整包覆寫掉)",
        JSON.stringify(envKeys) === JSON.stringify(["ANOTHER_KEY", "ANTHROPIC_API_KEY"]),
        `envKeys=${JSON.stringify(envKeys)}`,
      );
    } catch (err) {
      record("步驟26c env 淺層合併", false, String(err));
    }

    // ---- 26d: 舊版 settings.setEnabledModels/getEnabledModels 與新版
    //           settings.getProviderPrefs 讀寫同一份底層儲存(單一資料來源,
    //           不會漂移)----
    try {
      await client.rpc("settings.setEnabledModels", { enabledModelIds: ["claude-sonnet-5"] });
      const prefsResult = await client.rpc("settings.getProviderPrefs", {});
      const viaOldApi = await client.rpc("settings.getEnabledModels", {});
      const sdkPref = prefsResult.prefs["claude-agent-sdk"];
      record(
        "步驟26d 舊版 settings.setEnabledModels 寫入的值,透過新版 settings.getProviderPrefs 可讀到相同結果(單一資料來源)",
        JSON.stringify(sdkPref?.enabledModelIds) === JSON.stringify(["claude-sonnet-5"]) &&
          JSON.stringify(viaOldApi.enabledModelIds) === JSON.stringify(["claude-sonnet-5"]),
        `sdkPref=${JSON.stringify(sdkPref)}, viaOldApi=${JSON.stringify(viaOldApi)}`,
      );
    } catch (err) {
      record("步驟26d 新舊 API 讀寫同一份儲存", false, String(err));
    }

    client.close();
    await killProcessTree(coreProc, "core(步驟26 per-provider 偏好持久化,第一個 core 進程)");
    coreProc = undefined;

    // ---- 26e: 重啟指向同一個 DESKMONY_DATA_DIR 的全新 core 子程序後,所有
    //           偏好(含 env 的 key 名稱)仍讀回相同的值——證明真的落地
    //           SQLite,不是記憶體 ----
    coreProc = startCore({ port: PORT, dataDir, workspaceDir, permissionTimeoutMs: PERMISSION_TIMEOUT_MS });
    await waitForPort(url, 20_000);
    client = new GatewayClient(url);
    await client.connect();
    try {
      const result = await client.rpc("settings.getProviderPrefs", {});
      const claudeCli = result.prefs["claude-cli"];
      const envKeys = Object.keys(claudeCli?.env ?? {}).sort();
      const noPlaintext = !JSON.stringify(result).includes(secretValue);
      record(
        "步驟26e 重啟後(同一個 DESKMONY_DATA_DIR)settings.getProviderPrefs 仍讀回相同的 enabled/order/label/env key,且不含明文金鑰",
        claudeCli?.enabled === false &&
          claudeCli?.order === 5 &&
          claudeCli?.label === "My Claude" &&
          JSON.stringify(envKeys) === JSON.stringify(["ANOTHER_KEY", "ANTHROPIC_API_KEY"]) &&
          noPlaintext,
        `claudeCli=${JSON.stringify(claudeCli)}`,
      );
    } catch (err) {
      record("步驟26e 重啟後 getProviderPrefs 仍讀回相同的值", false, String(err));
    }
  } catch (err) {
    record("步驟26 per-provider 偏好持久化(整體設置失敗)", false, String(err));
  } finally {
    client?.close();
    await killProcessTree(coreProc, "core(步驟26 per-provider 偏好持久化)");
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    try {
      rmSync(workspaceDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

// ---------------------------------------------------------------------
// 步驟 27:舊版 enabledClaudeModelIds 向下相容遷移(這輪新增,決定性測試,
// 全程不叫任何真實模型)
//
// 直接用 @deskmony/db 的 createDb() 在 core 啟動**之前**,原地寫入舊格式的
// settings 列(模擬「這台機器先前跑過舊版 Deskmony,只有 enabledClaudeModelIds
// 這個扁平 key,完全沒有 providerPrefs」的既有資料),驗證啟動後
// migrateLegacyEnabledModelIds() 正確把它轉成新結構,且設定不遺失、遷移冪等
// (重複啟動 / 使用者之後修改都不會被遷移邏輯覆蓋回舊值)。
// ---------------------------------------------------------------------
async function legacyEnabledModelIdsMigrationSmokeTest() {
  if (!shouldRun("deterministic")) {
    skipNote("步驟27 舊版 enabledClaudeModelIds 向下相容遷移", "deterministic");
    return;
  }

  const PORT = 4326;
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-legacy-migrate-data-"));
  const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-legacy-migrate-ws-"));
  const url = `ws://localhost:${PORT}`;
  const legacyIds = ["claude-sonnet-5", "claude-opus-4-8"];
  let coreProc;
  let client;
  const sortedJson = (arr) => JSON.stringify([...arr].sort());

  try {
    // ---- 27a: 用 @deskmony/db 的 createDb() 原地寫入舊格式的 settings 列
    //           (不啟動 core,模擬舊版遺留的 DB 檔案)----
    try {
      const dbMod = await import(pathToFileURL(path.join(REPO_ROOT, "packages", "db", "dist", "client.js")).href);
      const dbPath = path.join(dataDir, "deskmony.db");
      const db = dbMod.createDb(dbPath);
      db.$client
        .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .run("enabledClaudeModelIds", JSON.stringify(legacyIds));
      db.$client.close();
      record("步驟27a 直接寫入舊格式 enabledClaudeModelIds settings 列(模擬舊版遺留 DB)", true);
    } catch (err) {
      record("步驟27a 寫入舊格式 settings 列", false, String(err));
      return;
    }

    // ---- 27b: 啟動 core(觸發 migrateLegacyEnabledModelIds()),舊版
    //           settings.getEnabledModels 應正確讀到遷移後的值 ----
    coreProc = startCore({ port: PORT, dataDir, workspaceDir, permissionTimeoutMs: PERMISSION_TIMEOUT_MS });
    await waitForPort(url, 20_000);
    client = new GatewayClient(url);
    await client.connect();
    try {
      const result = await client.rpc("settings.getEnabledModels", {});
      record(
        "步驟27b core 啟動後(觸發遷移),舊版 settings.getEnabledModels 讀到遷移後的值,設定不遺失",
        sortedJson(result.enabledModelIds) === sortedJson(legacyIds),
        `result=${JSON.stringify(result)}`,
      );
    } catch (err) {
      record("步驟27b 遷移後舊版 API 讀到正確值", false, String(err));
    }

    // ---- 27c: 新版 settings.getProviderPrefs 也能看到同一份已遷移的結構性
    //           資料(claude-agent-sdk.enabledModelIds),證明是真的搬進新結構,
    //           不是舊 API 恰好繞過遷移直接讀舊 key ----
    try {
      const result = await client.rpc("settings.getProviderPrefs", {});
      const sdkPref = result.prefs["claude-agent-sdk"];
      record(
        "步驟27c 遷移後,新版 settings.getProviderPrefs 的 claude-agent-sdk.enabledModelIds 等於舊資料(證明真的搬進新結構)",
        sdkPref && sortedJson(sdkPref.enabledModelIds) === sortedJson(legacyIds),
        `sdkPref=${JSON.stringify(sdkPref)}`,
      );
    } catch (err) {
      record("步驟27c 新版 API 看到遷移後的結構性資料", false, String(err));
    }

    client.close();
    await killProcessTree(coreProc, "core(步驟27 舊版遷移,第一次啟動)");
    coreProc = undefined;

    // ---- 27d: 重啟(同一個 DESKMONY_DATA_DIR,再次觸發
    //           migrateLegacyEnabledModelIds())——遷移冪等,不會重複處理或
    //           改變已遷移的值 ----
    coreProc = startCore({ port: PORT, dataDir, workspaceDir, permissionTimeoutMs: PERMISSION_TIMEOUT_MS });
    await waitForPort(url, 20_000);
    client = new GatewayClient(url);
    await client.connect();
    try {
      const result = await client.rpc("settings.getEnabledModels", {});
      record(
        "步驟27d 重啟(再次觸發遷移邏輯)後,值仍與遷移後一致(遷移冪等,不會重複處理或改變已遷移的值)",
        sortedJson(result.enabledModelIds) === sortedJson(legacyIds),
        `result=${JSON.stringify(result)}`,
      );
    } catch (err) {
      record("步驟27d 重啟後遷移冪等", false, String(err));
    }

    // ---- 27e: 使用者之後透過(新或舊)API 明確修改過,之後再重啟——遷移邏輯
    //           不可以把使用者的修改覆蓋回最初的舊值(冪等檢查必須認得出
    //           「已經有 enabledModelIds 欄位」而不僅僅是「已經遷移過」)----
    const userChangedIds = ["claude-haiku-4-5"];
    try {
      await client.rpc("settings.setEnabledModels", { enabledModelIds: userChangedIds });
    } catch (err) {
      record("步驟27e 使用者修改後的值(前置設定)", false, String(err));
    }
    client.close();
    await killProcessTree(coreProc, "core(步驟27 舊版遷移,第二次啟動)");
    coreProc = undefined;

    coreProc = startCore({ port: PORT, dataDir, workspaceDir, permissionTimeoutMs: PERMISSION_TIMEOUT_MS });
    await waitForPort(url, 20_000);
    client = new GatewayClient(url);
    await client.connect();
    try {
      const result = await client.rpc("settings.getEnabledModels", {});
      record(
        "步驟27e 使用者明確修改過設定後,即使再次重啟觸發遷移邏輯,也不會把值覆蓋回最初的舊資料(遷移只在欄位完全未設定時執行一次)",
        sortedJson(result.enabledModelIds) === sortedJson(userChangedIds),
        `result=${JSON.stringify(result)}`,
      );
    } catch (err) {
      record("步驟27e 遷移不覆蓋使用者之後的修改", false, String(err));
    }
  } catch (err) {
    record("步驟27 舊版 enabledClaudeModelIds 向下相容遷移(整體設置失敗)", false, String(err));
  } finally {
    client?.close();
    await killProcessTree(coreProc, "core(步驟27 舊版遷移)");
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    try {
      rmSync(workspaceDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

// ---------------------------------------------------------------------
// 步驟 28:M6 Round A —— 分層合併的設定檔(defaults → config.json → 環境變數,
// 決定性測試,全程不叫任何真實模型)。
//
// 全程用 `DESKMONY_HOME` 指到暫存目錄(絕不動到使用者真正的 `~/.deskmony`),
// 用 `buildCoreEnv()` 完全掌控子程序看到的環境變數(不透過既有的
// `startCore()` 輔助函式——那個函式為了既有測試的方便,會無條件帶入
// `DESKMONY_WORKSPACE`/`DESKMONY_PERMISSION_TIMEOUT_MS`,這裡需要精準控制
// 「哪些環境變數完全不存在」才能驗證 default/file/env 三層各自單獨生效)。
//
// **安全**:`DESKMONY_DATA_DIR` 在每一次子程序啟動都強制指到暫存目錄(即使
// 這個子測試的重點不是 dataDir 本身)——沒有這一條,沒設定檔/沒 env 覆寫時
// core 會真的在使用者機器的 `~/.deskmony` 建立/開啟 SQLite 檔案,這是絕對
// 不能發生的事。相對地,`workspace.defaultWorkingDir` 預設是 `os.homedir()`
// 這個純字串值(不會被拿去寫入任何檔案——只是存進 DB 的 profile.workingDir
// 欄位),讓它在 28a 維持真正預設、不覆寫,才能驗證「等同現行預設」。
// ---------------------------------------------------------------------

/** 完全掌控子程序看到的 `DESKMONY_*` 環境變數——先清掉繼承自這支腳本自身
 *  process.env 的所有 `DESKMONY_*`(理論上這支腳本從未 mutate 自己的
 *  `process.env`,這裡純粹是防禦性做法),再套用呼叫端指定的 overrides。 */
function buildCoreEnv(overrides) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("DESKMONY_")) delete env[key];
  }
  return { ...env, ...overrides };
}

function spawnCoreRaw(env) {
  const proc = spawn(process.execPath, [CORE_ENTRY], { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  proc.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
    process.stdout.write(`[core] ${chunk}`);
  });
  proc.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
    process.stderr.write(`[core:err] ${chunk}`);
  });
  return { proc, getStdout: () => stdout, getStderr: () => stderr };
}

/** 等待子程序以「非 0 結束碼」自然結束(設定驗證失敗的預期路徑),逾時視為
 *  「沒有如預期般拒絕啟動」,回傳 `{ code, timedOut }`。 */
function waitForExit(proc, timeoutMs) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ code: null, timedOut: true }), timeoutMs);
    proc.on("exit", (code) => {
      clearTimeout(t);
      resolve({ code, timedOut: false });
    });
  });
}

async function configLayeringSmokeTest() {
  if (!shouldRun("deterministic")) {
    skipNote("步驟28 分層合併的設定檔(defaults → config.json → 環境變數)", "deterministic");
    return;
  }

  const tmpHomeDirs = [];
  function mkTmpHome(prefix) {
    const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
    tmpHomeDirs.push(dir);
    return dir;
  }
  function writeConfigFile(homeDir, obj) {
    writeFileSync(path.join(homeDir, "config.json"), JSON.stringify(obj, null, 2), "utf8");
  }

  // ==== 28a: 沒有設定檔時,有效設定等同現行預設(見上方檔案頂端安全說明) ====
  {
    const PORT = 4327;
    const homeDir = mkTmpHome("deskmony-e2e-config-defaults-home-");
    const dataDir = mkTmpHome("deskmony-e2e-config-defaults-data-");
    let coreEntry;
    try {
      coreEntry = spawnCoreRaw(
        buildCoreEnv({
          DESKMONY_HOME: homeDir,
          DESKMONY_CORE_PORT: String(PORT),
          DESKMONY_DATA_DIR: dataDir, // 安全:絕不可讓沒設定的 dataDir 落到真正的 ~/.deskmony
        }),
      );
      const url = `ws://localhost:${PORT}`;
      await waitForPort(url, 20_000);
      const client = new GatewayClient(url);
      await client.connect();
      const { effective } = await client.rpc("config.getEffective", {});
      client.close();

      const expectedStaticDir = path.join(REPO_ROOT, "apps", "desktop", "dist");
      const ok =
        effective.daemon.bindHost.value === "127.0.0.1" &&
        effective.daemon.bindHost.source === "default" &&
        effective.daemon.permissionTimeoutMs.value === 300_000 &&
        effective.daemon.permissionTimeoutMs.source === "default" &&
        effective.daemon.authRateLimit.max.value === 5 &&
        effective.daemon.authRateLimit.max.source === "default" &&
        effective.daemon.authRateLimit.cooldownMs.value === 30_000 &&
        effective.daemon.authRateLimit.cooldownMs.source === "default" &&
        effective.workspace.defaultWorkingDir.value === os.homedir() &&
        effective.workspace.defaultWorkingDir.source === "default" &&
        effective.workspace.worktreesRoot.value === undefined &&
        effective.workspace.worktreesRoot.source === "default" &&
        effective.features.staticDir.value === expectedStaticDir &&
        effective.features.staticDir.source === "default" &&
        effective.log.level.value === "info" &&
        effective.log.level.source === "default" &&
        effective.version.value === 1;

      record(
        "步驟28a 沒有設定檔時,有效設定等同現行預設(bindHost/permissionTimeoutMs/authRateLimit/defaultWorkingDir/worktreesRoot/staticDir/log.level 皆為 default 來源且值與既有行為一致)",
        ok,
        `effective=${JSON.stringify(effective)}`,
      );
    } catch (err) {
      record("步驟28a 沒有設定檔時,有效設定等同現行預設", false, String(err));
    } finally {
      if (coreEntry) await killProcessTree(coreEntry.proc, "core(28a 無設定檔預設值)");
    }
  }

  // ==== 28b: 合併優先權三種情況(同一欄位:default only / file only / file+env)====
  // permissionTimeoutMs 有對應環境變數,可以驗證完整三層;log.level 沒有
  // 對應環境變數(見需求描述的環境變數清單),只驗證 default → file 兩層,
  // 兩者互補覆蓋了「env 必須贏過檔案」與「檔案必須贏過預設」兩條規則。
  {
    const PORT = 4328;
    const homeDir = mkTmpHome("deskmony-e2e-config-merge-home-");
    const dataDir = mkTmpHome("deskmony-e2e-config-merge-data-");
    const url = `ws://localhost:${PORT}`;
    let coreEntry;

    async function getEffective() {
      await waitForPort(url, 20_000);
      const client = new GatewayClient(url);
      await client.connect();
      const { effective } = await client.rpc("config.getEffective", {});
      client.close();
      return effective;
    }

    try {
      // ---- 28b-1: 兩個欄位都只有 default(尚未建立設定檔)----
      coreEntry = spawnCoreRaw(
        buildCoreEnv({ DESKMONY_HOME: homeDir, DESKMONY_CORE_PORT: String(PORT), DESKMONY_DATA_DIR: dataDir }),
      );
      const eff1 = await getEffective();
      await killProcessTree(coreEntry.proc, "core(28b-1 only default)");
      record(
        "步驟28b-1 合併優先權:only default(無設定檔、無環境變數)——permissionTimeoutMs=300000, log.level=info,來源皆為 default",
        eff1.daemon.permissionTimeoutMs.value === 300_000 &&
          eff1.daemon.permissionTimeoutMs.source === "default" &&
          eff1.log.level.value === "info" &&
          eff1.log.level.source === "default",
        `eff1.daemon.permissionTimeoutMs=${JSON.stringify(eff1.daemon.permissionTimeoutMs)}, eff1.log.level=${JSON.stringify(eff1.log.level)}`,
      );

      // ---- 28b-2: 只有設定檔(無環境變數)----
      writeConfigFile(homeDir, { version: 1, daemon: { permissionTimeoutMs: 99_999 }, log: { level: "warn" } });
      coreEntry = spawnCoreRaw(
        buildCoreEnv({ DESKMONY_HOME: homeDir, DESKMONY_CORE_PORT: String(PORT), DESKMONY_DATA_DIR: dataDir }),
      );
      const eff2 = await getEffective();
      await killProcessTree(coreEntry.proc, "core(28b-2 only file)");
      record(
        "步驟28b-2 合併優先權:only file(設定檔覆寫、無環境變數)——permissionTimeoutMs=99999, log.level=warn,來源皆為 file",
        eff2.daemon.permissionTimeoutMs.value === 99_999 &&
          eff2.daemon.permissionTimeoutMs.source === "file" &&
          eff2.log.level.value === "warn" &&
          eff2.log.level.source === "file",
        `eff2.daemon.permissionTimeoutMs=${JSON.stringify(eff2.daemon.permissionTimeoutMs)}, eff2.log.level=${JSON.stringify(eff2.log.level)}`,
      );

      // ---- 28b-3: 設定檔 + 環境變數(env 必須贏過檔案;log.level 沒有對應
      //             環境變數,維持 file 來源不受影響,證明 env 覆寫是逐欄位的,
      //             不是整份設定檔被環境變數整批蓋掉)----
      coreEntry = spawnCoreRaw(
        buildCoreEnv({
          DESKMONY_HOME: homeDir,
          DESKMONY_CORE_PORT: String(PORT),
          DESKMONY_DATA_DIR: dataDir,
          DESKMONY_PERMISSION_TIMEOUT_MS: "12345",
        }),
      );
      const eff3 = await getEffective();
      await killProcessTree(coreEntry.proc, "core(28b-3 file+env)");
      record(
        "步驟28b-3 合併優先權:file+env——permissionTimeoutMs 環境變數(12345)贏過設定檔(99999),來源=env;log.level 沒有對應環境變數,仍維持設定檔的值(warn)與來源(file)",
        eff3.daemon.permissionTimeoutMs.value === 12_345 &&
          eff3.daemon.permissionTimeoutMs.source === "env" &&
          eff3.log.level.value === "warn" &&
          eff3.log.level.source === "file",
        `eff3.daemon.permissionTimeoutMs=${JSON.stringify(eff3.daemon.permissionTimeoutMs)}, eff3.log.level=${JSON.stringify(eff3.log.level)}`,
      );
    } catch (err) {
      record("步驟28b 合併優先權三種情況(整體設置失敗)", false, String(err));
    } finally {
      if (coreEntry) await killProcessTree(coreEntry.proc, "core(28b 合併優先權,收尾)");
    }
  }

  // ==== 28c: 設定檔 JSON 語法錯誤 → 拒絕啟動,stderr 有明確訊息 ====
  {
    const PORT = 4329;
    const homeDir = mkTmpHome("deskmony-e2e-config-badjson-home-");
    const dataDir = mkTmpHome("deskmony-e2e-config-badjson-data-");
    writeFileSync(path.join(homeDir, "config.json"), "{ this is not valid JSON", "utf8");
    let coreEntry;
    try {
      coreEntry = spawnCoreRaw(
        buildCoreEnv({ DESKMONY_HOME: homeDir, DESKMONY_CORE_PORT: String(PORT), DESKMONY_DATA_DIR: dataDir }),
      );
      const exitInfo = await waitForExit(coreEntry.proc, 15_000);
      const stderr = coreEntry.getStderr();
      const hasClearError = /JSON/.test(stderr) && /設定檔/.test(stderr);
      record(
        "步驟28c 設定檔 JSON 語法錯誤 → 拒絕啟動(結束碼非 0)且 stderr 有明確訊息",
        !exitInfo.timedOut && exitInfo.code !== 0 && hasClearError,
        `exitCode=${exitInfo.code}, timedOut=${exitInfo.timedOut}, stderr 片段=${JSON.stringify(stderr.slice(0, 400))}`,
      );
    } catch (err) {
      record("步驟28c 設定檔 JSON 語法錯誤 → 拒絕啟動", false, String(err));
    } finally {
      // killProcessTree() 內建「已經結束就 no-op」的守門(見該函式頂端判斷),
      // 這裡不需要自己先判斷是否 timed out,直接呼叫最單純。
      if (coreEntry) await killProcessTree(coreEntry.proc, "core(28c JSON 語法錯誤)");
    }
  }

  // ==== 28d: 已知欄位型別錯誤(daemon.port 給字串)→ 拒絕啟動 ====
  {
    const PORT = 4329;
    const homeDir = mkTmpHome("deskmony-e2e-config-badtype-home-");
    const dataDir = mkTmpHome("deskmony-e2e-config-badtype-data-");
    writeConfigFile(homeDir, { version: 1, daemon: { port: "not-a-number" } });
    let coreEntry;
    try {
      coreEntry = spawnCoreRaw(
        buildCoreEnv({ DESKMONY_HOME: homeDir, DESKMONY_CORE_PORT: String(PORT), DESKMONY_DATA_DIR: dataDir }),
      );
      const exitInfo = await waitForExit(coreEntry.proc, 15_000);
      const stderr = coreEntry.getStderr();
      const hasClearError = /daemon\.port|port/.test(stderr) && /設定檔/.test(stderr);
      record(
        "步驟28d 設定檔已知欄位型別錯誤(daemon.port 給字串)→ 拒絕啟動且 stderr 含欄位相關訊息",
        !exitInfo.timedOut && exitInfo.code !== 0 && hasClearError,
        `exitCode=${exitInfo.code}, timedOut=${exitInfo.timedOut}, stderr 片段=${JSON.stringify(stderr.slice(0, 400))}`,
      );
    } catch (err) {
      record("步驟28d 設定檔已知欄位型別錯誤 → 拒絕啟動", false, String(err));
    } finally {
      if (coreEntry) await killProcessTree(coreEntry.proc, "core(28d 型別錯誤)");
    }
  }

  // ==== 28e: 未知欄位 → 可正常啟動並印警告(向前相容)====
  {
    const PORT = 4329;
    const homeDir = mkTmpHome("deskmony-e2e-config-unknownkey-home-");
    const dataDir = mkTmpHome("deskmony-e2e-config-unknownkey-data-");
    writeConfigFile(homeDir, { version: 1, totallyUnknownTopLevelField: true, daemon: { notARealDaemonField: 123 } });
    let coreEntry;
    try {
      coreEntry = spawnCoreRaw(
        buildCoreEnv({ DESKMONY_HOME: homeDir, DESKMONY_CORE_PORT: String(PORT), DESKMONY_DATA_DIR: dataDir }),
      );
      const url = `ws://localhost:${PORT}`;
      await waitForPort(url, 20_000);
      const stderr = coreEntry.getStderr();
      const hasWarning = /未知欄位/.test(stderr) && /totallyUnknownTopLevelField/.test(stderr) && /notARealDaemonField/.test(stderr);
      record(
        "步驟28e 設定檔含未知欄位 → 仍可正常啟動,且印出明確警告(逐一列出未知欄位路徑,向前相容)",
        hasWarning,
        `stderr 片段=${JSON.stringify(stderr.slice(0, 600))}`,
      );
    } catch (err) {
      record("步驟28e 設定檔含未知欄位 → 可正常啟動並印警告", false, String(err));
    } finally {
      if (coreEntry) await killProcessTree(coreEntry.proc, "core(28e 未知欄位)");
    }
  }

  // ==== 28f: 安全防線(a)——設定檔把 daemon.bindHost 設成對外位址,且無環境
  //           變數 token → 拒絕啟動(綁定安全檢查必須套用在合併後的設定上)====
  {
    const PORT = 4330;
    const homeDir = mkTmpHome("deskmony-e2e-config-bindsafety-home-");
    const dataDir = mkTmpHome("deskmony-e2e-config-bindsafety-data-");
    writeConfigFile(homeDir, { version: 1, daemon: { bindHost: "0.0.0.0" } });
    let coreEntry;
    try {
      coreEntry = spawnCoreRaw(
        buildCoreEnv({ DESKMONY_HOME: homeDir, DESKMONY_CORE_PORT: String(PORT), DESKMONY_DATA_DIR: dataDir }),
      );
      const exitInfo = await waitForExit(coreEntry.proc, 15_000);
      const stderr = coreEntry.getStderr();
      const hasClearError = /拒絕啟動/.test(stderr) && /DESKMONY_AUTH_TOKEN/.test(stderr);
      record(
        "步驟28f 安全防線(a):設定檔把 daemon.bindHost 設成 0.0.0.0、無環境變數 token → 拒絕啟動(綁定安全檢查套用在合併後的設定上,不是只看環境變數)",
        !exitInfo.timedOut && exitInfo.code !== 0 && hasClearError,
        `exitCode=${exitInfo.code}, timedOut=${exitInfo.timedOut}, stderr 片段=${JSON.stringify(stderr.slice(0, 400))}`,
      );
    } catch (err) {
      record("步驟28f 安全防線(a):設定檔 bindHost=0.0.0.0 無 token → 拒絕啟動", false, String(err));
    } finally {
      if (coreEntry) await killProcessTree(coreEntry.proc, "core(28f 綁定安全)");
    }
  }

  // ==== 28g/28h: 安全防線(b)——設定檔放入疑似 token 欄位 → 被忽略、印警告,
  //               且該值不會成為有效 token;28h 順便驗證 config.getEffective
  //               回傳內容不含任何 token(比照既有 env 遮罩的斷言方式)====
  {
    const PORT = 4331;
    const homeDir = mkTmpHome("deskmony-e2e-config-faketoken-home-");
    const dataDir = mkTmpHome("deskmony-e2e-config-faketoken-data-");
    const REAL_TOKEN = `e2e-real-token-${randomUUID()}`;
    const FAKE_FILE_TOKEN = `fake-file-token-${randomUUID()}`;
    writeConfigFile(homeDir, { version: 1, daemon: { authToken: FAKE_FILE_TOKEN } });
    let coreEntry;
    try {
      coreEntry = spawnCoreRaw(
        buildCoreEnv({
          DESKMONY_HOME: homeDir,
          DESKMONY_CORE_PORT: String(PORT),
          DESKMONY_DATA_DIR: dataDir,
          DESKMONY_AUTH_TOKEN: REAL_TOKEN,
        }),
      );
      const url = `ws://localhost:${PORT}`;
      await waitForPort(url, 20_000);
      const stderr = coreEntry.getStderr();
      const hasWarning = /疑似認證憑證|daemon\.authToken/.test(stderr);
      record(
        "步驟28g-1 設定檔出現疑似 token 的欄位(daemon.authToken)→ core 啟動時印出明確警告",
        hasWarning,
        `stderr 片段=${JSON.stringify(stderr.slice(0, 600))}`,
      );

      // 用設定檔裡的假 token 嘗試認證 → 必須失敗(它從未成為有效 token)。
      const fakeClient = new GatewayClient(url);
      await fakeClient.connect();
      let fakeAuthRejected = false;
      try {
        await fakeClient.rpc("auth", { token: FAKE_FILE_TOKEN });
      } catch (err) {
        fakeAuthRejected = /認證/.test(String(err));
      }
      fakeClient.close();
      record(
        "步驟28g-2 用設定檔裡疑似 token 的欄位值嘗試認證 → 被拒絕(該值從未成為有效 token)",
        fakeAuthRejected,
      );

      // 用真正的環境變數 token 認證 → 必須成功,證明認證仍然只認 env token。
      const realClient = new GatewayClient(url);
      await realClient.connect();
      const authResult = await realClient.rpc("auth", { token: REAL_TOKEN });
      const result = await realClient.rpc("profile.list", {});
      record(
        "步驟28g-3 用真正的 DESKMONY_AUTH_TOKEN(環境變數)認證 → 成功,證明認證仍然只認環境變數 token",
        authResult?.ok === true && Array.isArray(result.profiles),
        `authResult=${JSON.stringify(authResult)}`,
      );

      // 步驟28h:config.getEffective 回傳內容不含任何 token(整個 JSON 字串
      // 都不應該出現 REAL_TOKEN/FAKE_FILE_TOKEN 這兩個值)。
      const effectiveResult = await realClient.rpc("config.getEffective", {});
      const effectiveJson = JSON.stringify(effectiveResult);
      const leaksRealToken = effectiveJson.includes(REAL_TOKEN);
      const leaksFakeToken = effectiveJson.includes(FAKE_FILE_TOKEN);
      record(
        "步驟28h config.getEffective 回傳內容不含任何 token(真正的環境變數 token、設定檔裡疑似 token 的值皆不出現)",
        !leaksRealToken && !leaksFakeToken,
        `effective JSON 長度=${effectiveJson.length}, leaksRealToken=${leaksRealToken}, leaksFakeToken=${leaksFakeToken}`,
      );
      realClient.close();
    } catch (err) {
      record("步驟28g/28h 安全防線(b):設定檔疑似 token 欄位(整體設置失敗)", false, String(err));
    } finally {
      if (coreEntry) await killProcessTree(coreEntry.proc, "core(28g/28h 疑似 token 欄位)");
    }
  }

  // ==== 28i: config.setFile 只接受安全子集——daemon.bindHost/daemon.port 被
  //           拒;log.level 成功落地檔案,重啟後仍生效(且真的影響 console
  //           輸出的過濾,見 apps/core/src/config/load-config.ts 的
  //           applyConsoleLogLevel())====
  {
    const PORT = 4332;
    const homeDir = mkTmpHome("deskmony-e2e-config-setfile-home-");
    const dataDir = mkTmpHome("deskmony-e2e-config-setfile-data-");
    const url = `ws://localhost:${PORT}`;
    let coreEntry;
    try {
      coreEntry = spawnCoreRaw(
        buildCoreEnv({ DESKMONY_HOME: homeDir, DESKMONY_CORE_PORT: String(PORT), DESKMONY_DATA_DIR: dataDir }),
      );
      await waitForPort(url, 20_000);
      const client = new GatewayClient(url);
      await client.connect();

      // ---- 28i-1: 嘗試改 daemon.bindHost → 被拒(明確錯誤,協議層面就不允許)----
      let bindHostRejected = false;
      try {
        await client.rpc("config.setFile", { daemon: { bindHost: "0.0.0.0" } });
      } catch (err) {
        bindHostRejected = true;
        log(`       config.setFile(daemon.bindHost) 如預期被拒: ${err}`);
      }
      record("步驟28i-1 config.setFile 嘗試改 daemon.bindHost → 被拒(不在安全子集內)", bindHostRejected);

      // ---- 28i-2: 嘗試改 daemon.port → 被拒 ----
      let portRejected = false;
      try {
        await client.rpc("config.setFile", { daemon: { port: 9999 } });
      } catch (err) {
        portRejected = true;
        log(`       config.setFile(daemon.port) 如預期被拒: ${err}`);
      }
      record("步驟28i-2 config.setFile 嘗試改 daemon.port → 被拒(不在安全子集內)", portRejected);

      // ---- 28i-3: 改 log.level → 成功,回應標示需要重啟 ----
      const setResult = await client.rpc("config.setFile", { log: { level: "error" } });
      const setOk =
        setResult.ok === true &&
        setResult.changedFields.includes("log.level") &&
        setResult.requiresRestart === true;
      record(
        "步驟28i-3 config.setFile 改 log.level → 成功,回應標示 changedFields 含 log.level 且 requiresRestart=true",
        setOk,
        `setResult=${JSON.stringify(setResult)}`,
      );

      // ---- 28i-4: 設定檔本身確實落地(含 version/$schema)----
      const configPath = path.join(homeDir, "config.json");
      const writtenRaw = readFileSync(configPath, "utf8");
      const written = JSON.parse(writtenRaw);
      record(
        "步驟28i-4 config.setFile 寫入的設定檔含 version/$schema,且 log.level 落地為 error",
        written.version !== undefined && typeof written.$schema === "string" && written.log?.level === "error",
        `written=${JSON.stringify(written)}`,
      );

      client.close();
      await killProcessTree(coreEntry.proc, "core(28i 第一次啟動)");
      coreEntry = undefined;

      // ---- 28i-5: 重啟(同一個 DESKMONY_HOME)後,log.level 仍是 error(來源
      //             file),且真的影響 console 輸出(既有的「[core] 綁定位址」
      //             這類 info 等級訊息不再出現在 stdout)----
      const restarted = spawnCoreRaw(
        buildCoreEnv({ DESKMONY_HOME: homeDir, DESKMONY_CORE_PORT: String(PORT), DESKMONY_DATA_DIR: dataDir }),
      );
      coreEntry = restarted;
      await waitForPort(url, 20_000);
      // 給一點時間讓啟動階段的 console.log 全部有機會被印出(或被壓下)。
      await sleep(500);
      const restartClient = new GatewayClient(url);
      await restartClient.connect();
      const { effective: effectiveAfterRestart } = await restartClient.rpc("config.getEffective", {});
      restartClient.close();
      const stdoutAfterRestart = restarted.getStdout();
      const bindAddressLineSuppressed = !/\[core\] 綁定位址/.test(stdoutAfterRestart);
      record(
        "步驟28i-5 重啟後 log.level=error(來源 file)仍生效,且真的壓下 info 等級的既有 console.log 輸出(「[core] 綁定位址」不再出現在 stdout)",
        effectiveAfterRestart.log.level.value === "error" &&
          effectiveAfterRestart.log.level.source === "file" &&
          bindAddressLineSuppressed,
        `effective.log.level=${JSON.stringify(effectiveAfterRestart.log.level)}, bindAddressLineSuppressed=${bindAddressLineSuppressed}`,
      );
    } catch (err) {
      record("步驟28i config.setFile 安全子集(整體設置失敗)", false, String(err));
    } finally {
      if (coreEntry) await killProcessTree(coreEntry.proc, "core(28i config.setFile)");
    }
  }

  for (const dir of tmpHomeDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

// ---------------------------------------------------------------------
// 主測試流程
// ---------------------------------------------------------------------
async function main() {
  let coreProc;
  let client;
  let dataDir;
  let workspaceDir;
  let sessionId;

  log(
    `[mode] --only=${ONLY_MODE ?? "(未指定,兩組都跑)"} — deterministic 組` +
      `${shouldRun("deterministic") ? "(跑)" : "(略過)"},model-behavior 組${shouldRun("model-behavior") ? "(跑)" : "(略過)"}`,
  );

  try {
    dataDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-data-"));
    workspaceDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-ws-"));
    log(`[setup] dataDir = ${dataDir}`);
    log(`[setup] workspaceDir = ${workspaceDir}`);

    if (!existsSync(CORE_ENTRY)) {
      throw new Error(`找不到 ${CORE_ENTRY},請先執行 pnpm build`);
    }

    // ---- 步驟 1: 啟動 core ----
    coreProc = startCore({
      port: CORE_PORT,
      dataDir,
      workspaceDir,
      permissionTimeoutMs: PERMISSION_TIMEOUT_MS,
    });
    const gatewayUrl = `ws://localhost:${CORE_PORT}`;
    try {
      await waitForPort(gatewayUrl, 20_000);
      record("步驟1 啟動 core / gateway 監聽成功", true, gatewayUrl);
    } catch (err) {
      record("步驟1 啟動 core / gateway 監聽成功", false, String(err));
      throw err;
    }

    client = new GatewayClient(gatewayUrl);
    await client.connect();

    // ---- profile 檢查 ----
    const profileListResult = await client.rpc("profile.list", {});
    let profile = profileListResult.profiles.find((p) => p.id === "default-claude-code");
    if (!profile) {
      log("[setup] 找不到預設 profile,改用 profile.create 建立一個");
      const created = await client.rpc("profile.create", {
        name: "E2E Claude",
        software: "claude-agent-sdk",
        workingDir: workspaceDir,
      });
      profile = created.profile;
    }
    record("步驟1b profile.list 取得可用 AgentProfile", true, `profileId=${profile.id}`);

    // ---- 步驟 2: 建立 session ----
    let createResult;
    try {
      createResult = await client.rpc(
        "session.create",
        { agentProfileId: profile.id, workingDir: workspaceDir, title: "e2e-smoke" },
        30_000,
      );
      sessionId = createResult.session.id;
      record("步驟2 建立 session", true, `sessionId=${sessionId}, workingDir=${workspaceDir}`);
    } catch (err) {
      record("步驟2 建立 session", false, String(err));
      throw err;
    }

    // ---- 步驟 3: 基本對話 + 串流驗證 ----
    try {
      const expectedReply = "測試冒煙成功";
      const prompt = `請只回覆這五個字,不要加任何其他文字、標點或說明:${expectedReply}`;
      const { finalEvent, collected } = await client.drivePrompt(sessionId, prompt, {
        onPermission: async () => "deny", // 不應該觸發權限請求
        timeoutMs: 90_000,
      });

      if (finalEvent.event.type !== "completed") {
        throw new Error(`預期 completed,實際收到 ${finalEvent.event.type}: ${JSON.stringify(finalEvent.event)}`);
      }

      const { deltas, groups, violation } = analyzeMessageDeltas(collected);
      const messageIdSet = [...new Set(deltas.map((d) => d.messageId))];
      const lastGroupDone = groups.length > 0 && groups[groups.length - 1].done === true;
      const hasCompletedDone = collected.some((e) => e.event.type === "completed");
      const fullText = groups.map((g) => g.text).join("");

      log(`       messageId 集合: ${JSON.stringify(messageIdSet)}`);
      log(`       分組結果: ${JSON.stringify(groups.map((g) => ({ messageId: g.messageId, count: g.count, done: g.done, textLen: g.text.length })))}`);
      log(`       串接文字: ${JSON.stringify(fullText)}`);

      const ok =
        deltas.length > 0 &&
        !violation &&
        lastGroupDone &&
        hasCompletedDone &&
        fullText.trim().length > 0;

      record(
        "步驟3 串流 messageId 分組正確(修復1)+ done:true + completed",
        ok,
        violation ? `違規: ${violation}` : `deltas=${deltas.length}, groups=${groups.length}, lastGroupDone=${lastGroupDone}`,
      );

      const contentPlausible = fullText.includes(expectedReply) || fullText.replace(/[\s\p{P}]/gu, "").includes(expectedReply);
      record(
        "步驟3b 回覆內容大致符合預期(軟性檢查)",
        contentPlausible,
        contentPlausible ? undefined : `模型實際回覆: ${JSON.stringify(fullText)}(不影響 PASS 主判定,agent 措辭本就可能不完全照字面)`,
        "model-behavior",
      );

      // session.history 持久化驗證
      const history = await client.rpc("session.history", { sessionId });
      const hasUser = history.messages.some((m) => m.role === "user" && m.content === prompt);
      const hasAssistant = history.messages.some((m) => m.role === "assistant" && m.content.trim().length > 0);
      record(
        "步驟3c session.history 可查得 user/assistant 訊息",
        hasUser && hasAssistant,
        `hasUser=${hasUser}, hasAssistant=${hasAssistant}, 訊息數=${history.messages.length}`,
      );
    } catch (err) {
      record("步驟3 基本對話 + 串流驗證", false, String(err));
    }

    // ---- 步驟 4: 權限 allow 路徑 ----
    // deterministic:斷言的是系統行為(permission-request/tool-call/tool-result
    // 事件順序、side effect 檔案內容),prompt 措辭非常明確直接,不是模型自由
    // 選擇的軟性檢查。
    if (shouldRun("deterministic")) {
      try {
        const targetFile = path.join(workspaceDir, "test.txt");
        const targetFilePosix = targetFile.split(path.sep).join("/");
        const prompt = `請直接使用你的檔案寫入工具建立檔案,不要詢問我任何問題也不要先說明,直接執行:在路徑 ${targetFilePosix} 建立檔案,內容必須完全等於(不要加多餘換行或文字): Hello Deskmony`;

        let sawPermissionRequest = false;
        const { finalEvent, collected } = await client.drivePrompt(sessionId, prompt, {
          onPermission: async (ev) => {
            sawPermissionRequest = true;
            log(`       收到 permission-request: tool=${ev.toolName}, desc=${ev.description ?? "(無)"}`);
            return "allow";
          },
          timeoutMs: 90_000,
        });

        const toolCallIdx = collected.findIndex((e) => e.event.type === "tool-call");
        const toolResultIdx = collected.findIndex((e) => e.event.type === "tool-result");
        const sawToolCall = toolCallIdx !== -1;
        const sawToolResult = toolResultIdx !== -1;
        // 驗證修復項目 5(tool-call 漸進顯示)沒有破壞事件順序:tool-call 必須
        // 在對應的 tool-result 之前抵達(不論 tool-call 是提早送出的
        // content_block_start 版本,還是完整 assistant 訊息版本)。
        const toolCallBeforeResult = sawToolCall && sawToolResult && toolCallIdx < toolResultIdx;
        const completedOk = finalEvent.event.type === "completed";
        const fileExists = existsSync(targetFile);
        const fileContent = fileExists ? readFileSync(targetFile, "utf8").trim() : undefined;
        const contentOk = fileContent === "Hello Deskmony";

        record(
          "步驟4 權限 allow 路徑",
          sawPermissionRequest && sawToolCall && sawToolResult && toolCallBeforeResult && completedOk && fileExists && contentOk,
          `permission-request=${sawPermissionRequest}, tool-call=${sawToolCall}(idx=${toolCallIdx}), tool-result=${sawToolResult}(idx=${toolResultIdx}), toolCallBeforeResult=${toolCallBeforeResult}, completed=${completedOk}, fileExists=${fileExists}, content=${JSON.stringify(fileContent)}`,
        );
      } catch (err) {
        record("步驟4 權限 allow 路徑", false, String(err));
      }
    } else {
      skipNote("步驟4 權限 allow 路徑", "deterministic");
    }

    // ---- 步驟 5: 權限 deny 路徑(獨立 session,見 withIsolatedSession 註解)----
    // model-behavior:整個檢查點是否能在時間預算內收斂,依賴模型收到 deny
    // 後是否選擇重試/換句話說法再問一次(模型的自由選擇),已實測偶發單獨
    // FAIL(見 README「e2e 的殘留 flakiness」),整段獨立 session、獨立可略過。
    if (shouldRun("model-behavior")) {
      try {
        await withIsolatedSession(client, profile, workspaceDir, "e2e-step5-deny", async (denySessionId) => {
          const targetFile = path.join(workspaceDir, "denied.txt");
          const targetFilePosix = targetFile.split(path.sep).join("/");
          const prompt = `請直接使用你的檔案寫入工具建立檔案,不要詢問我任何問題也不要先說明,直接執行:在路徑 ${targetFilePosix} 建立檔案,內容為: should not exist`;

          let sawPermissionRequest = false;
          let permissionRequestCount = 0;
          // drivePrompt 對每個 permission-request 事件都會呼叫一次 onPermission
          // 並回覆 deny;若模型在收到 deny 後又追問一次(新的 requestId),迴圈
          // 會自然再收到一個 permission-request 事件、再次被這裡攔下回覆 deny,
          // 直到模型真正結束回合(completed/error)。
          const { finalEvent } = await client.drivePrompt(denySessionId, prompt, {
            onPermission: async (ev) => {
              sawPermissionRequest = true;
              permissionRequestCount += 1;
              log(`       收到 permission-request(第 ${permissionRequestCount} 次): tool=${ev.toolName}, desc=${ev.description ?? "(無)"}`);
              return "deny";
            },
            timeoutMs: 180_000,
          });

          const completedNormally = finalEvent.event.type === "completed" || finalEvent.event.type === "error";
          const fileNotExists = !existsSync(targetFile);

          record(
            "步驟5 權限 deny 路徑(獨立 session,不永久卡住,180s 內結束)",
            sawPermissionRequest && completedNormally && fileNotExists,
            `permission-request=${sawPermissionRequest}(共 ${permissionRequestCount} 次), 最終事件=${finalEvent.event.type}, 檔案未建立=${fileNotExists}, sessionId=${denySessionId}`,
            "model-behavior",
          );
        });
      } catch (err) {
        record("步驟5 權限 deny 路徑(獨立 session,不永久卡住,180s 內結束)", false, String(err), "model-behavior");
      }
    } else {
      skipNote("步驟5 權限 deny 路徑", "model-behavior");
    }

    // ---- 步驟 6: 逾時路徑(修復2驗證;獨立 session,見 withIsolatedSession 註解)----
    // deterministic:斷言的是 PermissionGateway 逾時後是否自動 deny + 推播
    // permission-resolved(source=timeout),與模型後續行為無關(這裡刻意
    // "ignore" 不回覆,逾時純粹是 core 端的計時器行為)。
    if (shouldRun("deterministic")) {
      try {
        await withIsolatedSession(client, profile, workspaceDir, "e2e-step6-timeout", async (timeoutSessionId) => {
        const targetFile = path.join(workspaceDir, "timeout.txt");
        const targetFilePosix = targetFile.split(path.sep).join("/");
        const prompt = `請直接使用你的檔案寫入工具建立檔案,不要詢問我任何問題也不要先說明,直接執行:在路徑 ${targetFilePosix} 建立檔案,內容為: should not exist either`;

        let sawPermissionRequest = false;
        let permissionRequestAt = 0;
        let timeoutRequestId;
        const budgetMs = PERMISSION_TIMEOUT_MS + 60_000; // 逾時秒數 + 緩衝

        const { finalEvent } = await client.drivePrompt(timeoutSessionId, prompt, {
          onPermission: async (ev) => {
            sawPermissionRequest = true;
            permissionRequestAt = Date.now();
            timeoutRequestId = ev.requestId;
            log(`       收到 permission-request(刻意不回覆,等待 core 端逾時 ~${PERMISSION_TIMEOUT_MS}ms): tool=${ev.toolName}`);
            return "ignore";
          },
          timeoutMs: budgetMs,
        });

        const elapsedFromPermission = permissionRequestAt ? Date.now() - permissionRequestAt : -1;
        const completedNormally = finalEvent.event.type === "completed" || finalEvent.event.type === "error";
        const fileNotExists = !existsSync(targetFile);
        const timedOutAsExpected = elapsedFromPermission >= PERMISSION_TIMEOUT_MS - 500; // 容忍些微誤差

        record(
          "步驟6 權限逾時自動 deny,agent 正常結束不永久懸置(修復2,獨立 session)",
          sawPermissionRequest && completedNormally && fileNotExists && timedOutAsExpected,
          `permission-request=${sawPermissionRequest}, 距逾時觸發耗時=${elapsedFromPermission}ms(逾時設定=${PERMISSION_TIMEOUT_MS}ms), 最終事件=${finalEvent.event.type}, 檔案未建立=${fileNotExists}, sessionId=${timeoutSessionId}`,
        );

        // 修復項目 3:逾時自動 deny 後,core 必須推播 permission-resolved(source=timeout),
        // 讓所有 client 的彈窗即使不是自己觸發解決的也能同步關閉。
        let permissionResolvedEvent;
        let permissionResolvedErr;
        try {
          permissionResolvedEvent = await client.waitForPermissionResolved(
            (p) => p.requestId === timeoutRequestId,
            10_000,
          );
        } catch (err) {
          permissionResolvedErr = err;
        }
        const permissionResolvedOk =
          Boolean(permissionResolvedEvent) &&
          permissionResolvedEvent.sessionId === timeoutSessionId &&
          permissionResolvedEvent.decision === "deny" &&
          permissionResolvedEvent.source === "timeout";
        record(
          "步驟6b 逾時後收到 permission-resolved(source=timeout)推播(修復3)",
          sawPermissionRequest && permissionResolvedOk,
          permissionResolvedErr
            ? String(permissionResolvedErr)
            : `payload=${JSON.stringify(permissionResolvedEvent)}`,
        );
      });
      } catch (err) {
        record("步驟6 權限逾時自動 deny,agent 正常結束不永久懸置(修復2,獨立 session)", false, String(err));
      }
    } else {
      skipNote("步驟6/6b 權限逾時路徑", "deterministic");
    }

    // ---- 步驟 7: 清理 session ----
    // deterministic:單純的 session.delete + session.list 確認,不涉及模型
    // 自由選擇。
    if (shouldRun("deterministic")) {
      try {
        await client.rpc("session.delete", { sessionId });
        const listAfter = await client.rpc("session.list", {});
        const stillThere = listAfter.sessions.some((s) => s.id === sessionId);
        record("步驟7 session.delete 清理成功", !stillThere, `刪除後 session.list 是否仍含此 session: ${stillThere}`);
      } catch (err) {
        record("步驟7 session.delete 清理成功", false, String(err));
      }
    } else {
      skipNote("步驟7 session.delete 清理成功", "deterministic");
    }

    // ---- 步驟 9: AcpAdapter(fake agent,不依賴外部模型的決定性測試)----
    // 用 scripts/fake-acp-agent.mjs 當作 software="acp" 的 AgentProfile 啟動
    // 目標,驗證 AdapterRegistry 依 profile.software 選到 AcpAdapter、ACP 的
    // session/update 通知轉譯成既有的 message-delta/tool-call/tool-result
    // AgentEvent、以及 requestPermission 的 allow/deny 兩條路徑 —— 全程不叫
    // 任何真實模型,結果 100% 決定性,不會像步驟 3-6 那樣受模型行為影響。
    if (shouldRun("deterministic")) {
      await acpFakeAgentSmokeTest(client, workspaceDir);
    } else {
      skipNote("步驟9 AcpAdapter(fake agent)", "deterministic");
    }

    // ---- 步驟 10: GenericPtyAdapter(M2 Round B,fake pty echo,決定性測試)----
    // 用 scripts/fake-pty-echo.mjs 當作 software="pty" 的 AgentProfile 啟動
    // 目標,驗證 capabilities()、terminal-data 事件直通、SessionManager 的
    // 靜止轉 idle 判斷、interrupt() 送出的 Ctrl+C 真的送達子程序、以及子程序
    // 自行結束時的 completed 事件 —— 全程不叫任何真實模型或外部 CLI。
    if (shouldRun("deterministic")) {
      await ptyAdapterSmokeTest(client, workspaceDir);
    } else {
      skipNote("步驟10 GenericPtyAdapter(fake pty echo)", "deterministic");
    }

    // ---- 步驟 24: OpenCodeAdapter(fake opencode server,決定性測試)----
    // 修復「opencode 只是 PTY 直通」的問題:這輪補上 OpenCodeAdapter(HTTP +
    // SSE),全程不叫任何真實 opencode 執行檔或模型,結果 100% 決定性。
    if (shouldRun("deterministic")) {
      await opencodeAdapterSmokeTest(client, workspaceDir);
    } else {
      skipNote("步驟24 OpenCodeAdapter(fake opencode server)", "deterministic");
    }

    // ---- 步驟 11: Windows .cmd spawn 修復迴歸測試(M2 Round B 任務 1)----
    if (shouldRun("deterministic")) {
      await windowsCmdSpawnRegressionTest(client, workspaceDir);
    } else {
      skipNote("步驟11 Windows .cmd spawn 修復迴歸測試", "deterministic");
    }

    // ---- 步驟 12: MessageBus(M3 Round A,fake ACP agent,決定性測試)----
    if (shouldRun("deterministic")) {
      await messageBusSmokeTest(client, workspaceDir);
    } else {
      skipNote("步驟12 MessageBus(fake ACP agent)", "deterministic");
    }

    // ---- 步驟 13: team-bus MCP 工具(M3 Round A,混合:13a 決定性 / 13b 真實
    // 模型軟性判定)—— 13a 本身建立 team + session 不依賴模型自由選擇,兩種
    // --only 模式都需要它(13b 依賴同一個 session);只有 13b 內部的實際
    // 模型呼叫會依 --only=model-behavior 才執行,見 teamBusMcpToolSmokeTest()。
    await teamBusMcpToolSmokeTest(client, workspaceDir, profile);

    // ---- 步驟 14: MessageBus interrupt 時序修正驗證(M3 Round B,混合:
    // 14a-14e 決定性 / 14f-14g 真實模型軟性判定)—— 14a-e 兩種 --only 模式
    // 都需要執行(14f/14g 是對同一輪已收集事件的事後分析,不需要額外的模型
    // 呼叫,因此一律計算,只是被歸類進 model-behavior 統計組,不影響
    // deterministic 組的結論),見 interruptTimingSmokeTest()。
    await interruptTimingSmokeTest(client, workspaceDir, profile);

    // ---- 步驟 15: TaskService + WorkspaceManager(M4 Round A,決定性測試,真實 git 子程序)----
    if (shouldRun("deterministic")) {
      await taskWorkspaceSmokeTest(client);
    } else {
      skipNote("步驟15 TaskService + WorkspaceManager", "deterministic");
    }

    // ---- 步驟 16: Review 合併流程 + request_review(M4 Round B,決定性測試,真實 git 子程序)----
    if (shouldRun("deterministic")) {
      await taskMergeReviewSmokeTest(client);
    } else {
      skipNote("步驟16 Review 合併流程 + request_review", "deterministic");
    }

    // ---- 步驟 29: usage-metering(S3a,決定性測試,不依賴任何真實模型)----
    if (shouldRun("deterministic")) {
      await usageMeteringSmokeTest(client, workspaceDir);
    } else {
      skipNote("步驟29 usage-metering(S3a)", "deterministic");
    }

    // ---- 步驟 31: slash command(這輪新增,決定性測試——見 slashCommandSmokeTest()
    // 頂端註解的分類原則,31f 雖然起真實 claude-agent-sdk session 仍歸類此組)----
    if (shouldRun("deterministic")) {
      await slashCommandSmokeTest(client, workspaceDir);
    } else {
      skipNote("步驟31 slash command", "deterministic");
    }

    // ---- 步驟 30: 機器驗收閘(S4,決定性測試,真實 git + node 子程序)----
    if (shouldRun("deterministic")) {
      await acceptanceGateSmokeTest(client);
    } else {
      skipNote("步驟30 機器驗收閘(S4)", "deterministic");
    }

    // ---- 步驟 32: ACP scoped MCP bridge token(Phase 2,決定性測試,不依賴
    // 任何真實模型/真實 codex-acp/gemini)----
    if (shouldRun("deterministic")) {
      await scopedMcpBridgeTokenSmokeTest(client, workspaceDir);
    } else {
      skipNote("步驟32 ACP scoped MCP bridge token", "deterministic");
    }
    // ---- 步驟 33/34: scoped token 絕對過期 + 與 master token 認證交互
    // (各自獨立 core 子程序,函式內部自行處理 --only 過濾)----
    await scopedTokenTtlSmokeTest();
    await scopedTokenAuthInterplaySmokeTest();

    // ---- 步驟 19: 刪除對話(M5 Round C 功能2,決定性測試,不依賴任何真實模型)----
    if (shouldRun("deterministic")) {
      await sessionDeleteSmokeTest(client, workspaceDir, profile);
    } else {
      skipNote("步驟19 刪除對話", "deterministic");
    }

    // ---- 步驟 20: 對話中切換 model(M5 Round C 功能3,混合:20a-20d 決定性 /
    // 20e 真實模型軟性判定)—— 20a-20d 兩種 --only 模式都需要執行(比照步驟
    // 13a/14a-e 的先例),只有 20e 內部的實際模型呼叫依 --only=model-behavior
    // 才執行,見 sessionSetModelSmokeTest()。
    await sessionSetModelSmokeTest(client, workspaceDir);

    // ---- 步驟 21: 設定介面 —— agent 偵測(M5 Round D,決定性測試,不依賴
    // 任何真實模型)。21a/21b 直接 import 編譯產物驗證探測邏輯本身,不需要
    // client;21c-21e 透過目前這條已認證/連線的 client 呼叫正式的
    // env.detectAgents 方法,見兩個函式頂端的分工說明。
    await agentDetectorProbeSmokeTest();
    await detectAgentsGatewaySmokeTest(client);

    // ---- 步驟 22: 「偵測項 → 可建立 (software,command) 映射」純函式(M5
    // Round E,決定性測試,不需要 client/core,直接 import 編譯產物)。----
    await agentTargetDerivationSmokeTest();

    // ---- 步驟 25: provider 目錄 resolveProviders() 純函式(這輪 provider
    // 目錄重構新增,決定性測試,不需要 client/core,直接 import 編譯產物)。----
    await resolveProvidersSmokeTest();
  } catch (err) {
    log(`[fatal] 主流程中止: ${err?.stack ?? err}`);
  } finally {
    client?.close();
    await killProcessTree(coreProc, "core");
    if (dataDir) {
      try {
        rmSync(dataDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    if (workspaceDir) {
      try {
        rmSync(workspaceDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }

  // ---- 步驟 8: Electron 啟動冒煙測試 ----
  // deterministic:只驗證 main process 存活 + core 子程序啟動 + gateway
  // 監聽成功 + 無致命錯誤,不涉及任何 agent/模型互動。
  if (shouldRun("deterministic")) {
    await electronSmokeTest();
  } else {
    skipNote("步驟8 Electron 啟動冒煙測試", "deterministic");
  }

  // ---- 步驟 17(M5 Round A 任務3,決定性測試,全程不叫任何真實模型)----
  // 認證(token-based)。獨立管理自己的 core 子程序(不與步驟1-16 共用),見
  // authGatewaySmokeTest() 內的分工說明。
  await authGatewaySmokeTest();

  // ---- 步驟 18(M5 Round B,決定性測試,全程不叫任何真實模型)----
  // 靜態網頁(任務1)+ 安全強化(任務3:timingSafeEqual/rate limiting)。
  // 獨立管理自己的 core 子程序,見 staticServerAndSecuritySmokeTest() 內的
  // 分工說明。
  await staticServerAndSecuritySmokeTest();

  // ---- 步驟 23(M5 Round E,決定性測試,全程不叫任何真實模型)----
  // 設定持久化:啟用哪些偵測到的 Claude model,DB 真的落地(重啟 core 子程序
  // 仍讀回一致)。獨立管理自己的 core 子程序,見 settingsPersistenceSmokeTest()
  // 內的分工說明。
  await settingsPersistenceSmokeTest();

  // ---- 步驟 26(這輪 provider 目錄重構新增,決定性測試,全程不叫任何真實
  // 模型)---- per-provider 偏好持久化 + env 遮罩,獨立管理自己的 core 子
  // 程序,見 providerPrefsPersistenceSmokeTest() 內的分工說明。
  await providerPrefsPersistenceSmokeTest();

  // ---- 步驟 27(這輪 provider 目錄重構新增,決定性測試,全程不叫任何真實
  // 模型)---- 舊版 enabledClaudeModelIds 向下相容遷移,獨立管理自己的 core
  // 子程序,見 legacyEnabledModelIdsMigrationSmokeTest() 內的分工說明。
  await legacyEnabledModelIdsMigrationSmokeTest();

  // ---- 步驟 28(M6 Round A 新增,決定性測試,全程不叫任何真實模型)----
  // 分層合併的設定檔(defaults → config.json → 環境變數):合併優先權、無
  // 設定檔時的相容性、錯誤處理(壞 JSON/型別錯誤/未知欄位)、兩條安全防線
  // (綁定安全套用合併後的值、疑似 token 欄位被忽略)、config.setFile 安全子集
  // ——獨立管理自己的 core 子程序,見 configLayeringSmokeTest() 內的分工說明。
  await configLayeringSmokeTest();

  // ---- 總結 ----
  // 任務0(e2e 套件切分):deterministic 組是驗收閘門(必須 100% PASS,
  // exitCode 只由這組決定),model-behavior 組只是觀察用 —— 失敗只印警告,
  // 不影響 exitCode。見檔案頂端 shouldRun()/record() 附近的分類理由說明,
  // 完整分類原則另見 README「端到端冒煙測試」章節。
  const deterministicResults = results.filter((r) => r.category !== "model-behavior");
  const modelBehaviorResults = results.filter((r) => r.category === "model-behavior");

  log("\n========== 測試總結:deterministic 組(驗收閘門,須 100% PASS)==========");
  for (const r of deterministicResults) {
    log(`[${r.ok ? "PASS" : "FAIL"}] ${r.name}`);
  }
  const deterministicFailCount = deterministicResults.filter((r) => !r.ok).length;
  log(
    `\ndeterministic 組共 ${deterministicResults.length} 項,PASS ${deterministicResults.length - deterministicFailCount}, FAIL ${deterministicFailCount}`,
  );

  log("\n========== 測試總結:model-behavior 組(觀察用,不影響結束碼)==========");
  if (modelBehaviorResults.length === 0) {
    log("(本次執行未跑 model-behavior 組任何檢查點,--only=deterministic 或尚未觸發)");
  }
  for (const r of modelBehaviorResults) {
    log(`[${r.ok ? "PASS" : "FAIL"}] ${r.name}`);
  }
  const modelBehaviorFailCount = modelBehaviorResults.filter((r) => !r.ok).length;
  if (modelBehaviorResults.length > 0) {
    log(
      `\nmodel-behavior 組共 ${modelBehaviorResults.length} 項,PASS ${modelBehaviorResults.length - modelBehaviorFailCount}, FAIL ${modelBehaviorFailCount}`,
    );
    if (modelBehaviorFailCount > 0) {
      log(
        `[警告] model-behavior 組有 ${modelBehaviorFailCount} 項 FAIL —— 這組斷言依賴真實模型當輪的自由選擇,` +
          `偶發 FAIL 屬已知 flake、不代表 regression(detail 已逐項標註原因),不影響本次執行的結束碼。`,
      );
    }
  }

  log(
    `\n========== 總計 ${results.length} 項(deterministic ${deterministicResults.length} + model-behavior ${modelBehaviorResults.length})==========`,
  );

  // 結束碼只由 deterministic 組決定 —— 這是任務0的核心要求:讓這支腳本能
  // 當作可靠的迴歸閘門,不因為模型當輪的自由選擇而讓 CI 誤判成 regression。
  process.exitCode = deterministicFailCount > 0 ? 1 : 0;
}

// ---------------------------------------------------------------------
// 步驟 17: 認證(M5 Round A 任務3,決定性測試,不依賴任何真實模型)
//
// 分工:17a(無 token)與 17b/17d(有 token)各自起一個獨立、專用的 core
// 子程序(專用 port + 專用 dataDir),不與步驟1-16 共用的那個 core 混用 ——
// 認證是連線層級的行為,獨立驗證比較乾淨,也不會影響步驟1-16 既有的判定。
// 17c 額外起一個「預期啟動失敗」的 core 子程序,驗證對外綁定 + 無 token 時
// 會被 apps/core/src/index.ts 的 validateBindSafety() 直接拒絕啟動。
// ---------------------------------------------------------------------
async function authGatewaySmokeTest() {
  if (!shouldRun("deterministic")) {
    skipNote("步驟17 認證(token-based)", "deterministic");
    return;
  }

  const AUTH_TOKEN = `e2e-token-${randomUUID()}`;
  const WRONG_TOKEN = `wrong-${randomUUID()}`;
  const NO_TOKEN_PORT = 4321;
  const TOKEN_PORT = 4322;
  const EXTERNAL_BIND_PORT = 4323;
  const tmpDirs = [];
  function mkTmp(prefix) {
    const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
    tmpDirs.push(dir);
    return dir;
  }

  // ---- 17a: 無 token 啟動,連線可直接發 request(向後相容)----
  let noTokenProc;
  try {
    noTokenProc = startCore({
      port: NO_TOKEN_PORT,
      dataDir: mkTmp("deskmony-e2e-auth-a-data-"),
      workspaceDir: mkTmp("deskmony-e2e-auth-a-ws-"),
      permissionTimeoutMs: PERMISSION_TIMEOUT_MS,
    });
    const url = `ws://localhost:${NO_TOKEN_PORT}`;
    await waitForPort(url, 20_000);
    const client = new GatewayClient(url);
    await client.connect();
    const result = await client.rpc("profile.list", {});
    record(
      "步驟17a 無 token 啟動:連線可直接發 request,無需認證(向後相容)",
      Array.isArray(result.profiles),
      `profiles 數=${result.profiles?.length}`,
    );
    client.close();
  } catch (err) {
    record("步驟17a 無 token 啟動:連線可直接發 request(向後相容)", false, String(err));
  } finally {
    await killProcessTree(noTokenProc, "core(17a 無 token)");
  }

  // ---- 17b/17d: 有 token 啟動 ----
  let tokenProc;
  try {
    tokenProc = startCore({
      port: TOKEN_PORT,
      dataDir: mkTmp("deskmony-e2e-auth-b-data-"),
      workspaceDir: mkTmp("deskmony-e2e-auth-b-ws-"),
      permissionTimeoutMs: PERMISSION_TIMEOUT_MS,
      authToken: AUTH_TOKEN,
    });
    const url = `ws://localhost:${TOKEN_PORT}`;
    await waitForPort(url, 20_000);

    // 17b-1: 未認證連線發 request(非 auth)被拒 —— 連線本身不需要立刻關閉,
    // 只要求求被明確拒絕(見 WsGateway.handleMessage() 的認證閘門)。
    try {
      const client = new GatewayClient(url);
      await client.connect();
      let rejected = false;
      let rejectMsg = "";
      try {
        await client.rpc("profile.list", {});
      } catch (err) {
        rejectMsg = String(err);
        rejected = /認證/.test(rejectMsg);
      }
      record(
        "步驟17b-1 有 token 啟動:未認證連線發 request 被拒",
        rejected,
        rejected ? rejectMsg : `request 未如預期被拒: ${rejectMsg || "(未拋出錯誤)"}`,
      );
      client.close();
    } catch (err) {
      record("步驟17b-1 有 token 啟動:未認證連線發 request 被拒", false, String(err));
    }

    // 17b-2: 認證後正常
    try {
      const client = new GatewayClient(url);
      await client.connect();
      const authResult = await client.rpc("auth", { token: AUTH_TOKEN });
      const result = await client.rpc("profile.list", {});
      record(
        "步驟17b-2 有 token 啟動:認證後可正常發送 request",
        authResult?.ok === true && Array.isArray(result.profiles),
        `authResult=${JSON.stringify(authResult)}, profiles 數=${result.profiles?.length}`,
      );
      client.close();
    } catch (err) {
      record("步驟17b-2 有 token 啟動:認證後可正常發送 request", false, String(err));
    }

    // 17b-3: 錯誤 token 被拒且連線關閉
    try {
      const client = new GatewayClient(url);
      await client.connect();
      let authRejected = false;
      let rejectMsg = "";
      try {
        await client.rpc("auth", { token: WRONG_TOKEN });
      } catch (err) {
        rejectMsg = String(err);
        authRejected = /認證/.test(rejectMsg);
      }
      const closed = await waitForWsClose(client.ws, 5_000);
      record(
        "步驟17b-3 有 token 啟動:錯誤 token 被拒且連線關閉",
        authRejected && closed,
        `authRejected=${authRejected}(${rejectMsg}), 連線已關閉=${closed}`,
      );
    } catch (err) {
      record("步驟17b-3 有 token 啟動:錯誤 token 被拒且連線關閉", false, String(err));
    }

    // 17b-4: 逾時未認證連線被關閉(core 端 AUTH_TIMEOUT_MS=5s,這裡等 8s 緩衝)
    try {
      const client = new GatewayClient(url);
      await client.connect();
      const closed = await waitForWsClose(client.ws, 8_000);
      record("步驟17b-4 有 token 啟動:逾時未認證連線被關閉", closed, `連線已關閉=${closed}`);
    } catch (err) {
      record("步驟17b-4 有 token 啟動:逾時未認證連線被關閉", false, String(err));
    }

    // 17d: 既有 e2e 腳本(這支腳本自身的 GatewayClient)支援帶 token 連線並
    // 正常運作 —— 認證後跑幾個具代表性的 RPC(建團隊 + 查詢),證明整條
    // request/response 路徑在認證開啟時依然正常。
    try {
      const client = new GatewayClient(url);
      await client.connect();
      await client.rpc("auth", { token: AUTH_TOKEN });
      const team = await client.rpc("team.create", { name: "E2E Auth Smoke Team" });
      const list = await client.rpc("team.list", {});
      // team.list 回傳 TeamWithMembers[](team 欄位是攤平的,不是巢狀
      // { team, members }),比對用 t.id,不是 t.team.id。
      const found = list.teams.some((t) => t.id === team.team.id);
      record(
        "步驟17d 既有 e2e 腳本(GatewayClient)支援帶 token 連線並正常運作",
        found,
        `teamId=${team.team.id}, found=${found}`,
      );
      client.close();
    } catch (err) {
      record("步驟17d 既有 e2e 腳本(GatewayClient)支援帶 token 連線並正常運作", false, String(err));
    }
  } catch (err) {
    record("步驟17b/17d 有 token 啟動(整體設置失敗)", false, String(err));
  } finally {
    await killProcessTree(tokenProc, "core(17b/17d 有 token)");
  }

  // ---- 17c: 綁定安全 —— 對外綁定但未設 token 時,core 啟動失敗並有明確錯誤訊息 ----
  try {
    const dataDir = mkTmp("deskmony-e2e-auth-c-data-");
    const proc = spawn(process.execPath, [CORE_ENTRY], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        DESKMONY_CORE_PORT: String(EXTERNAL_BIND_PORT),
        DESKMONY_DATA_DIR: dataDir,
        DESKMONY_WORKSPACE: os.tmpdir(),
        DESKMONY_BIND_HOST: "0.0.0.0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    const exitInfo = await new Promise((resolve) => {
      const t = setTimeout(() => resolve({ code: null, signal: null, timedOut: true }), 15_000);
      proc.on("exit", (code, signal) => {
        clearTimeout(t);
        resolve({ code, signal, timedOut: false });
      });
    });
    if (exitInfo.timedOut) {
      await killProcessTree(proc, "core(17c 對外綁定未設token,未如預期結束)");
    }
    const hasClearError = /拒絕啟動/.test(stderr) && /DESKMONY_AUTH_TOKEN/.test(stderr);
    record(
      "步驟17c 綁定安全:對外綁定(DESKMONY_BIND_HOST=0.0.0.0)但未設 token 時啟動失敗且有明確錯誤訊息",
      !exitInfo.timedOut && exitInfo.code === 1 && hasClearError,
      `exitCode=${exitInfo.code}, timedOut=${exitInfo.timedOut}, hasClearError=${hasClearError}, stderr 片段=${JSON.stringify(stderr.slice(0, 300))}`,
    );
  } catch (err) {
    record(
      "步驟17c 綁定安全:對外綁定未設 token 時啟動失敗且有明確錯誤訊息",
      false,
      String(err),
    );
  }

  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

// ---------------------------------------------------------------------
// 步驟 18: M5 Round B —— 靜態網頁(任務1)+ 安全強化(任務3),決定性測試,
// 全程不叫任何真實模型。
//
// 分工:
//   - 18a:啟動一個「已設定 AUTH_TOKEN」的 core(刻意如此,見下方),驗證
//     HTTP 靜態服務即使在認證已啟用時仍不需要 token 就能下載(靜態頁面本身
//     不是機敏資料),以及目錄穿越防護(原始 `..` 與 URL 編碼變體兩種)。
//   - 18b:同一個 core 上驗證 WS 仍然要求認證——聚焦在「HTTP 與 WS 共用
//     同一個 port,兩者互不干擾」這件事本身(帶錯 token/帶對 token 的完整
//     行為已由步驟17涵蓋,這裡不重複展開)。
//   - 18c:timingSafeEqual 的三種情況(不同長度錯誤 token / 同長度錯誤
//     token / 正確 token)都不丟例外、行為正確——不同長度與正確 token兩種
//     情況直接複用 18b 已經驗證過的連線,只補「同長度但錯誤」這一種。
//   - 18d:rate limiting,獨立一個 core(避免 18a-c 的認證失敗次數污染門檻
//     計算),縮短門檻/冷卻期(DESKMONY_AUTH_RATE_LIMIT_MAX/
//     DESKMONY_AUTH_RATE_LIMIT_COOLDOWN_MS)讓測試在合理時間內完成。
// ---------------------------------------------------------------------
async function staticServerAndSecuritySmokeTest() {
  if (!shouldRun("deterministic")) {
    skipNote("步驟18 靜態服務 + 安全強化(timingSafeEqual/rate limiting)", "deterministic");
    return;
  }

  const AUTH_TOKEN = `e2e-sec-token-${randomUUID()}`;
  const PORT_A = 4324;
  const PORT_D = 4325;
  const RATE_LIMIT_MAX = 3;
  const RATE_LIMIT_COOLDOWN_MS = 5_000;

  const tmpDirs = [];
  function mkTmp(prefix) {
    const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
    tmpDirs.push(dir);
    return dir;
  }

  // ---- 18a/18b/18c:共用一個 core(已設定 AUTH_TOKEN)----
  let procA;
  try {
    procA = startCore({
      port: PORT_A,
      dataDir: mkTmp("deskmony-e2e-sec-a-data-"),
      workspaceDir: mkTmp("deskmony-e2e-sec-a-ws-"),
      permissionTimeoutMs: PERMISSION_TIMEOUT_MS,
      authToken: AUTH_TOKEN,
    });
    const wsUrl = `ws://localhost:${PORT_A}`;
    const httpBase = `http://localhost:${PORT_A}`;
    await waitForPort(wsUrl, 20_000);

    // ---- 18a-1: GET / 回 200 HTML,即使 core 已啟用認證 ----
    try {
      const rootRes = await fetch(`${httpBase}/`);
      const rootText = await rootRes.text();
      record(
        "步驟18a-1 HTTP 靜態服務:GET / 回 200 HTML(即使 core 已啟用認證,靜態頁面仍不需 token)",
        rootRes.status === 200 && /<html/i.test(rootText),
        `status=${rootRes.status}, contentType=${rootRes.headers.get("content-type")}`,
      );
    } catch (err) {
      record("步驟18a-1 HTTP 靜態服務:GET / 回 200 HTML", false, String(err));
    }

    // ---- 18a-2: GET 一個實際存在的靜態資源回 200 ----
    try {
      const assetsDir = path.join(REPO_ROOT, "apps", "desktop", "dist", "assets");
      const jsFile = existsSync(assetsDir) ? readdirSync(assetsDir).find((f) => f.endsWith(".js")) : undefined;
      if (jsFile) {
        const assetRes = await fetch(`${httpBase}/assets/${jsFile}`);
        record(
          "步驟18a-2 HTTP 靜態服務:GET 存在的靜態資源回 200",
          assetRes.status === 200,
          `path=/assets/${jsFile}, status=${assetRes.status}`,
        );
      } else {
        record(
          "步驟18a-2 HTTP 靜態服務:GET 存在的靜態資源回 200",
          false,
          `找不到 ${assetsDir} 下的 .js 檔案,請確認 apps/desktop 已執行過 pnpm build`,
        );
      }
    } catch (err) {
      record("步驟18a-2 HTTP 靜態服務:GET 存在的靜態資源回 200", false, String(err));
    }

    // ---- 18a-3: 目錄穿越防護(原始 ".." 與 URL 編碼變體)----
    //
    // 注意判定條件:核心要求是「不得洩漏專案檔案內容」,不是「一律回傳非
    // 200」——resolveStaticFile() 的正規化(defense 第2層,見
    // apps/core/src/http/static-server.ts 頂端註解)是在一個虛擬絕對根目錄
    // 下對路徑做 path.posix.normalize(),數學上保證「不論幾層 `..`,結果都
    // 不可能跑到根目錄之上」——`/../../package.json` 會被正規化收斂成
    // `/package.json`,對應到 distDir 底下一個(通常不存在的)`package.json`,
    // 讀不到就照 SPA fallback 規則回傳 index.html(200)。這是**正確且安全**
    // 的行為(從未真的去讀 repo 根目錄的 package.json),只是不是用「非
    // 200」表達拒絕,而是用「重導向到不含機敏資料的 index.html」表達拒絕。
    // 反斜線混合變體會在 defense 第1層被直接攔下(400),兩種拒絕方式都
    // 滿足「不得洩漏檔案內容」,因此判定只看 `leaked`,`status` 只用來輔助
    // 排除真正的伺服器錯誤(例如 500 代表程式碼有未預期的例外)。
    const traversalCases = [
      { label: "原始相對路徑 /../../package.json", rawPath: "/../../package.json" },
      { label: "URL 編碼變體 /%2e%2e/%2e%2e/package.json", rawPath: "/%2e%2e/%2e%2e/package.json" },
      { label: "反斜線混合變體 /..\\..\\package.json", rawPath: "/..\\..\\package.json" },
    ];
    for (const { label, rawPath } of traversalCases) {
      try {
        const res = await rawHttpGet(httpBase, rawPath);
        const leaked = res.body.includes('"@deskmony/core"') || res.body.includes('"name": "deskmony"');
        const reasonableStatus = [200, 400, 403, 404].includes(res.status);
        record(
          `步驟18a-3 目錄穿越防護必須拒絕、不得洩漏專案檔案內容(${label})`,
          !leaked && reasonableStatus,
          `status=${res.status}, leaked=${leaked}, bodyPreview=${JSON.stringify(res.body.slice(0, 80))}`,
        );
      } catch (err) {
        record(`步驟18a-3 目錄穿越防護必須拒絕、不得洩漏專案檔案內容(${label})`, false, String(err));
      }
    }

    // ---- 18b: 同 port 上 HTTP 與 WS 並存,WS 仍要求認證 ----
    const WRONG_TOKEN_DIFF_LEN = `${AUTH_TOKEN}-extra-suffix-makes-it-longer`;
    try {
      const client = new GatewayClient(wsUrl);
      await client.connect();
      let rejected = false;
      try {
        await client.rpc("auth", { token: WRONG_TOKEN_DIFF_LEN });
      } catch (err) {
        rejected = /認證/.test(String(err));
      }
      const closed = await waitForWsClose(client.ws, 5_000);
      record(
        "步驟18b-1 同 port HTTP+WS 並存:WS 帶錯 token(長度不同)被拒",
        rejected && closed,
        `rejected=${rejected}, closed=${closed}`,
      );
    } catch (err) {
      record("步驟18b-1 同 port HTTP+WS 並存:WS 帶錯 token(長度不同)被拒", false, String(err));
    }

    let workingClient;
    try {
      workingClient = new GatewayClient(wsUrl);
      await workingClient.connect();
      const authResult = await workingClient.rpc("auth", { token: AUTH_TOKEN });
      const result = await workingClient.rpc("profile.list", {});
      record(
        "步驟18b-2 同 port HTTP+WS 並存:WS 帶對 token 可正常運作",
        authResult?.ok === true && Array.isArray(result.profiles),
        `authResult=${JSON.stringify(authResult)}, profiles 數=${result.profiles?.length}`,
      );
    } catch (err) {
      record("步驟18b-2 同 port HTTP+WS 並存:WS 帶對 token 可正常運作", false, String(err));
    } finally {
      workingClient?.close();
    }

    // ---- 18c: timingSafeEqual —— 同長度但內容錯誤的 token 必須正確拒絕、
    // 不丟例外(不同長度已由 18b-1 涵蓋,正確 token 已由 18b-2 涵蓋,三種
    // 情況合起來驗證同一段 timingSafeTokenEqual() 邏輯全部正確)。
    const lastChar = AUTH_TOKEN.slice(-1);
    const WRONG_TOKEN_SAME_LEN = AUTH_TOKEN.slice(0, -1) + (lastChar === "x" ? "y" : "x");
    try {
      const client = new GatewayClient(wsUrl);
      await client.connect();
      let rejected = false;
      try {
        await client.rpc("auth", { token: WRONG_TOKEN_SAME_LEN });
      } catch (err) {
        rejected = /認證/.test(String(err));
      }
      const closed = await waitForWsClose(client.ws, 5_000);
      record(
        "步驟18c timingSafeEqual:同長度但錯誤的 token 正確拒絕、不丟例外(伺服器未崩潰/斷線異常)",
        rejected && closed,
        `rejected=${rejected}, closed=${closed}`,
      );
    } catch (err) {
      record("步驟18c timingSafeEqual:同長度但錯誤的 token 正確拒絕、不丟例外", false, String(err));
    }
  } catch (err) {
    record("步驟18a/18b/18c 整體設置失敗", false, String(err));
  } finally {
    await killProcessTree(procA, "core(步驟18a/18b/18c)");
  }

  // ---- 18d: rate limiting(獨立一個 core,避免污染門檻計算)----
  let procD;
  try {
    procD = startCore({
      port: PORT_D,
      dataDir: mkTmp("deskmony-e2e-sec-d-data-"),
      workspaceDir: mkTmp("deskmony-e2e-sec-d-ws-"),
      permissionTimeoutMs: PERMISSION_TIMEOUT_MS,
      authToken: AUTH_TOKEN,
      extraEnv: {
        DESKMONY_AUTH_RATE_LIMIT_MAX: String(RATE_LIMIT_MAX),
        DESKMONY_AUTH_RATE_LIMIT_COOLDOWN_MS: String(RATE_LIMIT_COOLDOWN_MS),
      },
    });
    const wsUrl = `ws://localhost:${PORT_D}`;
    await waitForPort(wsUrl, 20_000);

    const wrongToken = `${AUTH_TOKEN}-wrong`;
    for (let i = 0; i < RATE_LIMIT_MAX; i++) {
      const c = new GatewayClient(wsUrl);
      await c.connect();
      try {
        await c.rpc("auth", { token: wrongToken });
      } catch {
        // 預期失敗,繼續累積失敗次數
      }
      await waitForWsClose(c.ws, 5_000);
    }

    // 門檻已達,冷卻期內即使這次帶「正確」token 也應該被拒(rate limiter 在
    // 比對 token 內容之前就先擋下來,見 ws-gateway.ts handleMessage())。
    try {
      const c = new GatewayClient(wsUrl);
      await c.connect();
      let authFailed = false;
      try {
        const res = await c.rpc("auth", { token: AUTH_TOKEN });
        authFailed = res?.ok !== true;
      } catch {
        authFailed = true;
      }
      const closed = await waitForWsClose(c.ws, 5_000);
      record(
        `步驟18d-1 rate limiting:連續 ${RATE_LIMIT_MAX} 次認證失敗後,冷卻期內即使帶正確 token 也被拒`,
        authFailed && closed,
        `authFailed=${authFailed}, closed=${closed}`,
      );
    } catch (err) {
      record("步驟18d-1 rate limiting:冷卻期內連正確 token 也被拒", false, String(err));
    }

    // 等冷卻期過後,恢復正常
    await sleep(RATE_LIMIT_COOLDOWN_MS + 2_000);
    try {
      const c = new GatewayClient(wsUrl);
      await c.connect();
      const authResult = await c.rpc("auth", { token: AUTH_TOKEN });
      record(
        "步驟18d-2 rate limiting:冷卻期過後恢復正常,正確 token 可再次通過認證",
        authResult?.ok === true,
        `authResult=${JSON.stringify(authResult)}`,
      );
      c.close();
    } catch (err) {
      record("步驟18d-2 rate limiting:冷卻期過後恢復正常", false, String(err));
    }
  } catch (err) {
    record("步驟18d rate limiting 整體設置失敗", false, String(err));
  } finally {
    await killProcessTree(procD, "core(步驟18d rate limiting)");
  }

  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

async function electronSmokeTest() {
  const electronExe = path.join(
    REPO_ROOT,
    "node_modules",
    ".pnpm",
    "electron@33.4.11",
    "node_modules",
    "electron",
    "dist",
    "electron.exe",
  );
  const desktopDir = path.join(REPO_ROOT, "apps", "desktop");

  if (!existsSync(electronExe)) {
    record("步驟8 Electron 啟動冒煙測試", false, `找不到 electron.exe: ${electronExe}`);
    return;
  }
  if (!existsSync(path.join(desktopDir, "dist-electron", "main.js"))) {
    record("步驟8 Electron 啟動冒煙測試", false, "找不到 apps/desktop/dist-electron/main.js,請先 pnpm build");
    return;
  }

  const ELECTRON_PORT = 4320;

  // 安全:Electron main 會用自己的環境變數 spawn core 子程序,若不覆寫
  // DESKMONY_DATA_DIR / DESKMONY_HOME,core 會落回真正的 `~/.deskmony`
  // (建立 deskmony.db,並讀取 M6 Round A 的 config.json)——e2e 絕不可動到
  // 開發者本機的家目錄,因此這裡與 startCore()/configLayeringSmokeTest() 一樣
  // 一律指到 mkdtempSync 暫存目錄,結束時清掉。
  const tmpDirs = [];
  function mkTmpDir(prefix) {
    const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
    tmpDirs.push(dir);
    return dir;
  }
  const homeDir = mkTmpDir("deskmony-e2e-electron-home-");
  const dataDir = mkTmpDir("deskmony-e2e-electron-data-");

  log(`\n[electron] 啟動 ${electronExe} . (cwd=${desktopDir}, port=${ELECTRON_PORT})`);
  log(`[electron] DESKMONY_HOME=${homeDir}`);
  log(`[electron] DESKMONY_DATA_DIR=${dataDir}`);

  let stdout = "";
  let stderr = "";
  let crashed = false;

  const proc = spawn(electronExe, ["."], {
    cwd: desktopDir,
    env: {
      ...process.env,
      DESKMONY_CORE_PORT: String(ELECTRON_PORT),
      DESKMONY_HOME: homeDir,
      DESKMONY_DATA_DIR: dataDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    proc.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(`[electron] ${text}`);
    });
    proc.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      process.stderr.write(`[electron:err] ${text}`);
    });
    proc.on("exit", (code, signal) => {
      log(`[electron] process exited early (code=${code} signal=${signal})`);
      crashed = true;
    });

    await sleep(20_000);

    const stillRunning = proc.exitCode === null && !proc.killed;
    const coreChildStarted = /starting core process/.test(stdout);
    // M5 Round A:WsGateway 的監聽 log 改印實際綁定位址(見
    // apps/core/src/gateway/ws-gateway.ts 的 listen()),不再固定印
    // "localhost" —— Electron 這裡沒有另外設定 DESKMONY_BIND_HOST,core 會用
    // apps/core/src/index.ts 的預設值 "127.0.0.1",所以這裡比對實際印出的值。
    const gatewayListening = new RegExp(`listening on ws://127\\.0\\.0\\.1:${ELECTRON_PORT}`).test(stdout);
    const hasFatalError = /Uncaught Exception|FATAL|app crashed/i.test(stdout + stderr);

    record(
      "步驟8 Electron 啟動冒煙測試(main process 存活 + core 子程序啟動 + 無致命錯誤)",
      stillRunning && !crashed && coreChildStarted && gatewayListening && !hasFatalError,
      `stillRunning=${stillRunning}, coreChildStarted=${coreChildStarted}, gatewayListening=${gatewayListening}, hasFatalError=${hasFatalError}`,
    );
  } finally {
    await killProcessTree(proc, "electron");
    for (const dir of tmpDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }
}

main();
