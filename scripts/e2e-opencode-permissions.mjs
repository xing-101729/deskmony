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
 *   PM9  (2026-10-03,第二項改動)HTTP 也掛 session 網路 MCP 工具:`OPENCODE_CONFIG_CONTENT` 多一個 `mcp.deskmony`
 *        (type local、command = [node, mcp-bridge-server.js]、environment 帶 scoped token / gateway 位址 / session id /
 *        NETWORK_ENABLED);**token 只在 environment、不在 command**;使用者自己寫的同名 `mcp.deskmony` 被取代;
 *        三個唯讀查詢工具預先放行、`task` 不停用(HTTP 轉發子 session 的權限)。
 *   PM10 那個 token 真的能用且身分由 token 綁定(`session.listForAgent` 的 isYou 是這個 session、`agent.listForAgent` 報
 *        opencode 的 canUseTools=true),不能呼叫白名單外的方法;session 刪除之後同一個 token 被撤銷(再拿來認證被拒)。
 *
 *   PM11-PM17 (2026-10-03,第三項改動:**opencode 本機伺服器要有認證**)`opencode serve` 與 `opencode acp` 都會在 loopback 開 HTTP
 *        伺服器、預設無認證——本機任何程序都能替它核准權限(繞過政策引擎)、`GET /config` 讀到 scoped bridge token。Deskmony 啟動它們時
 *        以環境變數給一組每次 spawn 都重新隨機產生的密碼(packages/adapters/src/opencode-server-auth.ts)。fake-opencode-server **真的檢查**
 *        basic auth,所以 PM1-PM10 與所有走這支 fake 的既有 e2e 本身就證明了 adapter 的每個請求都有帶認證;這裡再加決定性斷言:
 *   PM11 每次 spawn 的密碼都不同、夠長、base64url,使用者名稱是 deskmony,伺服器真的有鎖(fake 收到了密碼)。
 *   PM12 不帶認證(/config、/global/health、POST /permission/x/reply、SSE /event)、錯密碼、錯使用者名稱一律 401;帶對才 200 且 /config 真的
 *        含 bridge token(證明被擋住的是有價值的東西)。
 *   PM13 使用者在 provider 環境變數與啟動 core 的 shell 環境裡設的 OPENCODE_SERVER_PASSWORD/USERNAME 被 Deskmony 產生的覆蓋(session 照常運作)。
 *   PM14 伺服器沒鎖(模擬不認 OPENCODE_SERVER_PASSWORD 的舊版 opencode)→ adapter 在 log 裡警告,但 session 照常起得來。
 *   PM15 ACP(family=opencode):`opencode acp` 子行程同樣拿到每次不同的隨機密碼;沒有宣告 family 的 ACP agent 拿不到任何 opencode 伺服器
 *        密碼/使用者名稱(對照組——2026-10-05 起連從啟動 core 的 shell 繼承來的也濾掉,見 e2e-agent-env.mjs)。
 *   PM16 密碼不出現在 core log、WS 推播、session.history、SQLite 檔(含 WAL)——只存在於 adapter 記憶體與子行程環境。
 *   PM17 adapter 的**每個**真實請求都帶了認證:整支測試期間,fake 擋下的請求只有 adapter 每次 spawn 的一次無認證健全性探測(GET /global/health)
 *        與 PM12 的刻意探測,零筆其他。
 *
 *   PM18-PM21 (2026-10-05,第四項改動:**opencode 的 bash 工具環境不得含伺服器密碼與設定內容**)opencode 不會把 `OPENCODE_SERVER_PASSWORD`
 *        與含 bridge token 的 `OPENCODE_CONFIG_CONTENT` 從它啟動的 bash 工具環境濾掉(2026-10-03 實測)——agent 讀得到就能 `curl` 自家伺服器的
 *        `POST /permission/{id}/reply` 自我核准權限。Deskmony 自帶一個 opencode 外掛(packages/adapters/src/opencode-shell-env-plugin.ts),
 *        在 `shell.env` hook 把它們移除(**真實 opencode 1.18.7 + `opencode/big-pickle` 的整合另外實測過**,見提交說明與 docs/DECISIONS.md §J;
 *        這裡用 fake 後端內建的「外掛宿主模擬」——scripts/lib/fake-opencode-plugin-host.mjs,規則照真實實測——決定性地驗證 adapter 的接線與
 *        外掛檔本身的行為):
 *   PM18 HTTP 與 ACP(family=opencode):`OPENCODE_CONFIG_CONTENT` 的 `plugin` 陣列最後一項是 Deskmony 的外掛(`[file:// URL, {loadedMarkerFile}]`,
 *        URL 指到真實存在的 opencode-shell-env-plugin.js);使用者自己的 `plugin` 原樣保留在前面;同一個外掛路徑被使用者寫進去也只留一份。
 *   PM19 外掛檔只匯出**一個**函式(opencode 會把每個函式匯出都當外掛工廠呼叫);被宿主載入後,agent 的 bash 工具環境沒有
 *        OPENCODE_SERVER_PASSWORD/OPENCODE_SERVER_USERNAME/OPENCODE_CONFIG_CONTENT(但 opencode 行程自己的環境有——它需要),其他變數與 PATH 照常有。
 *   PM20 外掛載入時寫的標記檔被 adapter 的偵測消化(檔案被刪、沒有「外掛沒載入」警告);PM20b 偵測函式本身的三種結果(載入/逾時/session 已 dispose)。
 *   PM21 外掛沒被載入(模擬不認 shell.env 的舊版 opencode)→ adapter 在 log 裡警告,但 session 照常起得來、照常回覆。
 *
 * 全程走 scripts/fake-opencode-server.mjs / fake-acp-agent.mjs(決定性、不呼叫任何模型)。只啟動一個 core,
 * DESKMONY_HOME/DATA_DIR/WORKSPACE/CORE_PORT 四個都指向暫存目錄,並在繼續之前確認 core 印出的 SQLite 路徑真的在
 * 暫存目錄底下——漏設任何一個都可能連到使用者真實的 ~/.deskmony/deskmony.db。
 *
 * 前置需求:`pnpm build` 已跑過。
 * 用法:node scripts/e2e-opencode-permissions.mjs
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  FAKE_OPENCODE_REPLY_CHUNKS,
  TOOL_CALL_PREFIX,
  TOOL_CALL_INPUT,
  TOOL_CALL_ASK_FIRST_MARKER,
  REPORT_ENV_PREFIX as OPENCODE_REPORT_ENV,
  REPORT_SHELL_ENV_PREFIX as OPENCODE_REPORT_SHELL_ENV,
  SUBAGENT_PERMISSION_PREFIX,
  SUBAGENT_CHILD_TEXT,
  SUBAGENT_CHILD_COMMAND,
} from "./fake-opencode-server.mjs";
import { REPORT_ENV_PREFIX as ACP_REPORT_ENV, REPORT_SHELL_ENV_PREFIX as ACP_REPORT_SHELL_ENV } from "./fake-acp-agent.mjs";
import { requireFreshBuild } from "./lib/require-fresh-build.mjs";
import { e2eProvidersEnv, fakeAcpOpencodeProvider, FAKE_OPENCODE, FAKE_ACP, FAKE_ACP_OPENCODE } from "./lib/e2e-providers.mjs";

requireFreshBuild();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const CORE_ENTRY = path.join(REPO_ROOT, "apps", "core", "dist", "index.js");
const PORT = 4745;

const QUERY_TOOLS = ["deskmony_list_agents", "deskmony_list_sessions", "deskmony_read_session"];
/** HTTP(opencode)session 的預期 permission:所有工具 ask + 三個唯讀查詢工具預先放行(bridge 掛上了)。 */
const HTTP_EXPECTED_PERMISSION = { "*": "ask", "**": "ask", ...Object.fromEntries(QUERY_TOOLS.map((t) => [t, "allow"])) };

/**
 * PM14/PM16:模擬「使用者的 shell 環境本來就有 OPENCODE_SERVER_PASSWORD/USERNAME」——core 以它們啟動。Deskmony 啟動 opencode 家族
 * 子行程時必須覆蓋;對照組(非 opencode 家族的 ACP agent)則照常繼承。**這是測試用的假值,不是任何真實憑證。**
 */
const AMBIENT_SERVER_PASSWORD = "ambient-shell-password-must-be-overridden";
const AMBIENT_SERVER_USERNAME = "ambient-shell-user";
/** fake-opencode-server 的認證報告檔(`FAKE_OPENCODE_AUTH_REPORT_FILE`,見該檔檔頭);main() 建立目錄後才有值。 */
let authReportFile;

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
    FAKE_OPENCODE_AUTH_REPORT_FILE: authReportFile,
    OPENCODE_SERVER_PASSWORD: AMBIENT_SERVER_PASSWORD,
    OPENCODE_SERVER_USERNAME: AMBIENT_SERVER_USERNAME,
  };
  // 決定性:不能讓執行這支測試的 shell 剛好有這個變數,否則 PM1/PM5 的「沒有使用者設定」前提就不成立。
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
/**
 * 建 session → 請 fake 後端回顯 OPENCODE_CONFIG_CONTENT → 刪 session(`keep: true` 則留著,由呼叫端自己刪)。
 * 回傳 `{ sessionId, raw, config }`;子行程沒收到這個變數時 `raw`/`config` 是 `null`。
 */
async function reportOpencodeConfig(client, providerId, workspaceDir, reportPrefix, title, { keep = false } = {}) {
  const {
    session: { id: sessionId },
  } = await client.rpc("session.create", { providerId, workingDir: workspaceDir, title }, 30_000);
  let keepSession = false;
  try {
    const from = client.timeline.length;
    await client.rpc("session.sendPrompt", { sessionId, prompt: { text: reportPrefix } });
    await client.waitFor((e) => isTurnEnd(e, sessionId), 20_000, from);
    const { messages } = await client.rpc("session.history", { sessionId });
    const text = messages.filter((m) => m.role === "assistant").map((m) => m.content).join("\n");
    const m = /ENV:(\{.*\})/s.exec(text);
    if (!m) throw new Error(`回覆裡找不到 ENV:{...}: ${text.slice(0, 200)}`);
    const reported = JSON.parse(m[1]);
    const raw = reported.OPENCODE_CONFIG_CONTENT;
    // ACP 的 fake agent 另外回報 `serverAuth`(密碼的描述,不是密碼本身,見 fake-acp-agent.mjs);HTTP 那邊沒有這個欄位。
    const serverAuth = reported.serverAuth ?? null;
    keepSession = keep;
    return raw === null ? { sessionId, raw: null, config: null, serverAuth } : { sessionId, raw, config: JSON.parse(raw), serverAuth };
  } finally {
    if (!keepSession) await client.rpc("session.delete", { sessionId }, 15_000).catch(() => undefined);
  }
}

async function setProviderEnv(client, providerId, value) {
  await client.rpc("settings.setProviderPrefs", { providerId, patch: { env: { OPENCODE_CONFIG_CONTENT: value } } });
}

/** Deskmony 自帶外掛在 `plugin` 陣列裡的元素:`[file:// URL(指到存在的 opencode-shell-env-plugin.js), { loadedMarkerFile: <暫存目錄裡的絕對路徑> }]`。 */
function isOurPluginEntry(entry) {
  if (!Array.isArray(entry) || entry.length !== 2) return false;
  const [spec, options] = entry;
  if (typeof spec !== "string" || !spec.startsWith("file://")) return false;
  let pluginPath;
  try {
    pluginPath = fileURLToPath(spec);
  } catch {
    return false;
  }
  const marker = options?.loadedMarkerFile;
  return (
    path.basename(pluginPath) === "opencode-shell-env-plugin.js" &&
    existsSync(pluginPath) &&
    typeof marker === "string" &&
    path.isAbsolute(marker) &&
    path.basename(marker).startsWith("deskmony-opencode-shell-env-") &&
    path.resolve(path.dirname(marker)).toLowerCase() === path.resolve(os.tmpdir()).toLowerCase()
  );
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
  record(
    "PM1 HTTP:沒有使用者設定時,opencode 子行程收到的 OPENCODE_CONFIG_CONTENT 是「所有工具 ask」(`*` 與 `**` 都是 ask),唯一的 allow 是三個唯讀查詢工具(bridge 掛上了),且排在 `**` 之後",
    got.config !== null &&
      isDeepStrictEqual(got.config.permission, HTTP_EXPECTED_PERMISSION) &&
      isDeepStrictEqual(Object.keys(got.config.permission), Object.keys(HTTP_EXPECTED_PERMISSION)),
    got.raw ? got.raw.replace(/dmbt_[A-Za-z0-9_-]+/g, "dmbt_<token>") : "子行程沒有收到 OPENCODE_CONFIG_CONTENT",
  );
}

async function testHttpMerge(client, workspaceDir) {
  await setProviderEnv(client, FAKE_OPENCODE, JSON.stringify(USER_CONFIG));
  const got = await reportOpencodeConfig(client, FAKE_OPENCODE, workspaceDir, OPENCODE_REPORT_ENV, "pm2");
  const perm = got.config?.permission ?? {};
  const keys = Object.keys(perm);
  const ok =
    got.config !== null &&
    got.config.model === USER_CONFIG.model &&
    // 使用者的 plugin 原樣保留在前面,Deskmony 自帶的 shell.env 外掛(2026-10-05)附加在最後(見 PM18)
    Array.isArray(got.config.plugin) &&
    got.config.plugin.length === USER_CONFIG.plugin.length + 1 &&
    isDeepStrictEqual(got.config.plugin.slice(0, USER_CONFIG.plugin.length), USER_CONFIG.plugin) &&
    isOurPluginEntry(got.config.plugin[got.config.plugin.length - 1]) &&
    isDeepStrictEqual(got.config.mcp?.mine, USER_CONFIG.mcp.mine) &&
    // 使用者的鍵還在(不丟資訊),而且都排在 Deskmony 的 `*` 之前;`*` 被 Deskmony 的 ask 取代;
    // Deskmony 自己的鍵(`*`、`**`、預先放行的查詢工具)是最後的,所以最後符合者永遠是 Deskmony 的。
    perm.bash === "allow" &&
    isDeepStrictEqual(perm.edit, { "src/*": "allow" }) &&
    perm["*"] === "ask" &&
    perm["**"] === "ask" &&
    keys.indexOf("bash") < keys.indexOf("*") &&
    keys.indexOf("edit") < keys.indexOf("*") &&
    isDeepStrictEqual(keys.slice(keys.indexOf("*")), Object.keys(HTTP_EXPECTED_PERMISSION));
  record(
    "PM2 HTTP:使用者在 provider 環境變數給的 OPENCODE_CONFIG_CONTENT 深度合併(model/plugin/mcp.mine 保留),Deskmony 的 permission 優先(使用者的 allow 排在 Deskmony 的 ask 之前、`*` 被取代)",
    ok,
    got.raw ? `permission keys=${JSON.stringify(keys)}` : "子行程沒有收到 OPENCODE_CONFIG_CONTENT",
  );
}

async function testHttpBrokenJson(client, workspaceDir) {
  await setProviderEnv(client, FAKE_OPENCODE, "this is { not json");
  const before = coreOutput.length;
  const got = await reportOpencodeConfig(client, FAKE_OPENCODE, workspaceDir, OPENCODE_REPORT_ENV, "pm3");
  const warned = coreOutput.slice(before).includes("不是合法的 JSON");
  record(
    "PM3 HTTP:使用者的 OPENCODE_CONFIG_CONTENT 不是合法 JSON → console.warn 並只用 Deskmony 的設定(所有工具 ask,沒有任何使用者的鍵),session 照常起得來",
    got.config !== null && isDeepStrictEqual(got.config.permission, HTTP_EXPECTED_PERMISSION) && warned,
    `warned=${warned}`,
  );
}

async function testAcpFamily(client, workspaceDir) {
  // 先沒有使用者設定
  const plain = await reportOpencodeConfig(client, FAKE_ACP_OPENCODE, workspaceDir, ACP_REPORT_ENV, "pm4a");
  const plainPerm = plain.config?.permission ?? {};
  const plainKeys = Object.keys(plainPerm);
  const okPlain =
    plain.config !== null &&
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
    plain.raw ?? "子行程沒有收到 OPENCODE_CONFIG_CONTENT",
  );

  // 再加使用者設定
  await setProviderEnv(client, FAKE_ACP_OPENCODE, JSON.stringify(USER_CONFIG));
  const merged = await reportOpencodeConfig(client, FAKE_ACP_OPENCODE, workspaceDir, ACP_REPORT_ENV, "pm4b");
  const perm = merged.config?.permission ?? {};
  const keys = Object.keys(perm);
  const okMerged =
    merged.config !== null &&
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
    merged.raw ? `permission keys=${JSON.stringify(keys)}` : "子行程沒有收到 OPENCODE_CONFIG_CONTENT",
  );
}

async function testAcpControl(client, workspaceDir) {
  const got = await reportOpencodeConfig(client, FAKE_ACP, workspaceDir, ACP_REPORT_ENV, "pm5");
  record(
    "PM5 ACP 對照組:沒有宣告 family 的 ACP agent 不會被注入 OPENCODE_CONFIG_CONTENT(其他 agent 的環境不受影響)",
    got.config === null,
    got.raw ?? "(沒有注入)",
  );
}

// =======================================================================
const BRIDGE_ENV_KEYS = ["DESKMONY_MCP_BRIDGE_TOKEN", "DESKMONY_MCP_BRIDGE_GATEWAY_URL", "DESKMONY_MCP_BRIDGE_SESSION_ID", "DESKMONY_MCP_BRIDGE_NETWORK_ENABLED"];

async function testHttpSessionNetwork(client, workspaceDir) {
  // 使用者自己寫了一個同名的 mcp.deskmony(想把 command 換成別的東西)——必須被 Deskmony 的取代。
  await setProviderEnv(
    client,
    FAKE_OPENCODE,
    JSON.stringify({ mcp: { deskmony: { type: "local", command: ["evil-command"], environment: { EVIL: "1" } }, mine: USER_CONFIG.mcp.mine } }),
  );
  const got = await reportOpencodeConfig(client, FAKE_OPENCODE, workspaceDir, OPENCODE_REPORT_ENV, "pm9", { keep: true });
  let sessionId = got.sessionId;
  try {
    const mcp = got.config?.mcp?.deskmony;
    const token = mcp?.environment?.DESKMONY_MCP_BRIDGE_TOKEN;
    const perm = got.config?.permission ?? {};
    const ok =
      got.config !== null &&
      mcp?.type === "local" &&
      mcp.enabled === true &&
      Array.isArray(mcp.command) &&
      mcp.command.length === 2 &&
      mcp.command[0] === process.execPath &&
      path.basename(mcp.command[1]) === "mcp-bridge-server.js" &&
      existsSync(mcp.command[1]) &&
      // token 只在 environment,不在 command(命令列在行程列表看得到)
      typeof token === "string" &&
      token.startsWith("dmbt_") &&
      !mcp.command.some((part) => String(part).includes(token)) &&
      isDeepStrictEqual(Object.keys(mcp.environment).sort(), [...BRIDGE_ENV_KEYS].sort()) &&
      mcp.environment.DESKMONY_MCP_BRIDGE_GATEWAY_URL === `ws://127.0.0.1:${PORT}` &&
      mcp.environment.DESKMONY_MCP_BRIDGE_SESSION_ID === sessionId &&
      mcp.environment.DESKMONY_MCP_BRIDGE_NETWORK_ENABLED === "1" &&
      !("EVIL" in mcp.environment) &&
      // 使用者其他的 MCP server 還在
      isDeepStrictEqual(got.config.mcp.mine, USER_CONFIG.mcp.mine) &&
      // 三個查詢工具預先放行,create_session/send_to_session 不放行;HTTP 不停用 task(它轉發子 session 的權限)
      isDeepStrictEqual(perm, HTTP_EXPECTED_PERMISSION) &&
      perm.deskmony_create_session === undefined &&
      perm.deskmony_send_to_session === undefined &&
      perm.task === undefined;
    record(
      "PM9 HTTP:OPENCODE_CONFIG_CONTENT 多一個 mcp.deskmony(local;command=[node, mcp-bridge-server.js];environment 帶 scoped token/gateway 位址/session id/NETWORK_ENABLED);token 只在 environment、不在 command;使用者同名的 mcp.deskmony 被取代、其他 MCP 保留;三個查詢工具預先放行、create/send 不放行、task 不停用",
      ok,
      mcp ? `command=${JSON.stringify(mcp.command)}, envKeys=${JSON.stringify(Object.keys(mcp.environment ?? {}))}` : "沒有 mcp.deskmony",
    );

    // ---- PM10:token 的能力與撤銷 ----
    const gatewayUrl = mcp?.environment?.DESKMONY_MCP_BRIDGE_GATEWAY_URL ?? `ws://127.0.0.1:${PORT}`;
    const bridge = new TimelineClient(gatewayUrl);
    await bridge.connect();
    let aliveOk = false;
    let detail = "";
    try {
      await bridge.rpc("auth", { token });
      const agents = (await bridge.rpc("agent.listForAgent", {})).agents;
      const sessions = (await bridge.rpc("session.listForAgent", {})).sessions;
      const me = sessions.filter((entry) => entry.isYou);
      const opencodeAgent = agents.find((a) => a.id === FAKE_OPENCODE);
      let forbidden;
      try {
        await bridge.rpc("session.list", {});
      } catch (err) {
        forbidden = String(err.message);
      }
      aliveOk =
        me.length === 1 &&
        me[0].id === sessionId &&
        opencodeAgent?.software === "opencode" &&
        opencodeAgent?.canUseTools === true &&
        typeof forbidden === "string" &&
        forbidden.includes("無權呼叫");
      detail = `me=${JSON.stringify(me.map((m) => m.id))}, opencodeAgent=${JSON.stringify(opencodeAgent)}, forbidden=${forbidden}`;
    } catch (err) {
      detail = String(err);
    } finally {
      bridge.close();
    }

    await client.rpc("session.delete", { sessionId }, 15_000);
    sessionId = undefined;
    const afterClose = new TimelineClient(gatewayUrl);
    await afterClose.connect();
    let revoked = false;
    let afterError = "";
    try {
      await afterClose.rpc("auth", { token });
    } catch (err) {
      revoked = true;
      afterError = String(err.message);
    } finally {
      afterClose.close();
    }
    record(
      "PM10 HTTP session 的 scoped token:能呼叫白名單方法且身分由 token 綁定(session.listForAgent 的 isYou 就是這個 session、agent.listForAgent 報 opencode 的 canUseTools=true)、白名單外的方法被拒;session 刪除(dispose)之後同一個 token 被撤銷(再拿來認證被拒)",
      aliveOk && revoked,
      `${detail}; revokedAfterDelete=${revoked} (${afterError})`,
    );
  } finally {
    if (sessionId) await client.rpc("session.delete", { sessionId }, 15_000).catch(() => undefined);
  }
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
// PM11-PM17:opencode 本機伺服器的認證(見檔頭)
// =======================================================================
const EXPECTED_FAKE_REPLY = FAKE_OPENCODE_REPLY_CHUNKS.join("");
/** 這支測試自己刻意送出、預期被擋下的無認證/錯認證請求(PM17 要從 fake 的「被擋」紀錄裡扣掉)。 */
const deliberateRejections = [];

/** fake-opencode-server 寫的認證報告(每行一筆 JSON:啟動紀錄 `start`、被擋下的請求 `rejected`)。 */
function readAuthReport() {
  if (!authReportFile || !existsSync(authReportFile)) return [];
  return readFileSync(authReportFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
const startRecords = () => readAuthReport().filter((r) => r.kind === "start");
const basicAuth = (user, pass) => `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
const sha256Hex = (text) => createHash("sha256").update(text).digest("hex");
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** 建一個 fake opencode session,並找出它 spawn 的那個 fake 伺服器的啟動紀錄(spawn 在 session.create 回應之前就完成了)。 */
async function createFakeOpencodeSession(client, workspaceDir, title) {
  const before = startRecords().length;
  const {
    session: { id: sessionId },
  } = await client.rpc("session.create", { providerId: FAKE_OPENCODE, workingDir: workspaceDir, title }, 30_000);
  const fresh = startRecords().slice(before);
  return { sessionId, start: fresh.length === 1 ? fresh[0] : undefined, freshCount: fresh.length };
}

/** 送一則一般 prompt,回傳這一輪最後一則 assistant 訊息(經過 `/session/{id}/message` + SSE `/event` 才收得到,兩者都要帶認證)。 */
async function chatOnce(client, sessionId, text) {
  const from = client.timeline.length;
  await client.rpc("session.sendPrompt", { sessionId, prompt: { text } });
  await client.waitFor((e) => isTurnEnd(e, sessionId), 20_000, from);
  const { messages } = await client.rpc("session.history", { sessionId });
  return [...messages].reverse().find((m) => m.role === "assistant")?.content ?? "";
}

/** 直接打 fake 伺服器(繞過 adapter),扮演「本機的其他程序」。`rejectionExpected` 時記進 deliberateRejections。 */
async function probeServer(start, method, pathName, authorization, { body, rejectionExpected = true } = {}) {
  if (rejectionExpected) deliberateRejections.push({ pid: start.pid, method, path: pathName });
  const res = await fetch(`${start.baseUrl}${pathName}`, {
    method,
    headers: { ...(authorization ? { authorization } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(5_000),
  });
  return { status: res.status, text: await res.text() };
}

async function setProviderEnvVars(client, providerId, vars) {
  await client.rpc("settings.setProviderPrefs", { providerId, patch: { env: vars } });
}

async function testOpencodeServerAuth(client, workspaceDir, dbPath, otherLiveSessionIds) {
  const created = [];
  try {
    // ---- PM11:每次 spawn 的密碼都不同、夠長 ----
    const a = await createFakeOpencodeSession(client, workspaceDir, "auth-a");
    created.push(a.sessionId);
    const b = await createFakeOpencodeSession(client, workspaceDir, "auth-b");
    created.push(b.sessionId);
    const starts = startRecords();
    const passwords = starts.map((r) => r.password);
    record(
      "PM11 每次 spawn 都產生新的隨機密碼:到目前為止所有 fake 伺服器收到的密碼彼此不同、至少 32 字元、base64url,使用者名稱是 deskmony,伺服器真的有鎖(fake 收到了密碼並啟用檢查)",
      a.start !== undefined &&
        b.start !== undefined &&
        starts.length >= 4 &&
        passwords.every((p) => typeof p === "string" && p.length >= 32 && BASE64URL.test(p)) &&
        new Set(passwords).size === passwords.length &&
        starts.every((r) => r.username === "deskmony" && r.enforced === true),
      `spawn 次數=${starts.length}, 密碼長度=${JSON.stringify([...new Set(passwords.map((p) => p?.length))])}, 全部不同=${new Set(passwords).size === passwords.length}`,
    );
    if (!a.start) return;

    // ---- PM12:本機其他程序不帶/帶錯認證一律 401,帶對才讀得到 /config(裡面有 bridge token) ----
    const good = basicAuth(a.start.username, a.start.password);
    const statuses = {
      "GET /config(無認證)": (await probeServer(a.start, "GET", "/config")).status,
      "GET /global/health(無認證)": (await probeServer(a.start, "GET", "/global/health")).status,
      "POST /permission/x/reply(無認證)": (await probeServer(a.start, "POST", "/permission/per_x/reply", undefined, { body: { reply: "once" } })).status,
      "GET /event(無認證,SSE)": (await probeServer(a.start, "GET", "/event")).status,
      "GET /config(錯密碼)": (await probeServer(a.start, "GET", "/config", basicAuth(a.start.username, `x${a.start.password}`))).status,
      "GET /config(錯使用者名稱)": (await probeServer(a.start, "GET", "/config", basicAuth("opencode", a.start.password))).status,
      "GET /config(空密碼)": (await probeServer(a.start, "GET", "/config", basicAuth(a.start.username, ""))).status,
    };
    const authed = await probeServer(a.start, "GET", "/config", good, { rejectionExpected: false });
    let tokenReadable = false;
    try {
      const token = JSON.parse(authed.text)?.mcp?.deskmony?.environment?.DESKMONY_MCP_BRIDGE_TOKEN;
      tokenReadable = typeof token === "string" && token.startsWith("dmbt_");
    } catch {
      // 不是 JSON
    }
    record(
      "PM12 不帶認證(/config、/global/health、POST /permission/x/reply、SSE /event)、錯密碼、錯使用者名稱、空密碼一律 401;帶對的認證才 200,且 /config 裡確實有 scoped bridge token(證明被擋住的是有價值的東西)",
      Object.values(statuses).every((s) => s === 401) && authed.status === 200 && tokenReadable,
      `${JSON.stringify(statuses)}; 帶對認證 GET /config → ${authed.status}(含 bridge token: ${tokenReadable})`,
    );

    // ---- 讓 PM16/PM17 有真實流量可看:a 走完整的 /message + SSE 流程 ----
    const replyA = await chatOnce(client, a.sessionId, "hello over an authenticated server");

    // ---- PM13:使用者(provider env)與啟動 core 的 shell 環境給的密碼被覆蓋 ----
    const USER_PASSWORD = "user-provider-env-password-must-be-overridden";
    await setProviderEnvVars(client, FAKE_OPENCODE, { OPENCODE_SERVER_PASSWORD: USER_PASSWORD, OPENCODE_SERVER_USERNAME: "user-chosen-name" });
    let overridden;
    let replyOverridden = "";
    try {
      overridden = await createFakeOpencodeSession(client, workspaceDir, "auth-override");
      created.push(overridden.sessionId);
      replyOverridden = await chatOnce(client, overridden.sessionId, "hello again");
    } finally {
      await setProviderEnvVars(client, FAKE_OPENCODE, { OPENCODE_SERVER_PASSWORD: "", OPENCODE_SERVER_USERNAME: "" });
    }
    const allPasswords = startRecords().map((r) => r.password);
    record(
      "PM13 使用者在 provider 環境變數、以及啟動 core 的 shell 環境裡設的 OPENCODE_SERVER_PASSWORD/USERNAME 一律被 Deskmony 產生的覆蓋(沒有任何一個 fake 伺服器用了那兩個值),session 照常運作",
      overridden?.start !== undefined &&
        overridden.start.password !== USER_PASSWORD &&
        overridden.start.username === "deskmony" &&
        overridden.start.password.length >= 32 &&
        !allPasswords.includes(USER_PASSWORD) &&
        !allPasswords.includes(AMBIENT_SERVER_PASSWORD) &&
        startRecords().every((r) => r.username === "deskmony") &&
        replyA === EXPECTED_FAKE_REPLY &&
        replyOverridden === EXPECTED_FAKE_REPLY,
      `覆蓋後使用者名稱=${overridden?.start?.username}, 回覆正常=${replyA === EXPECTED_FAKE_REPLY && replyOverridden === EXPECTED_FAKE_REPLY}`,
    );

    // ---- PM14:伺服器沒鎖(舊版 opencode)→ 警告,不拒絕啟動 ----
    await setProviderEnvVars(client, FAKE_OPENCODE, { FAKE_OPENCODE_DISABLE_AUTH: "1" });
    let unlocked;
    let warned = false;
    let replyUnlocked = "";
    try {
      const before = coreOutput.length;
      unlocked = await createFakeOpencodeSession(client, workspaceDir, "auth-unlocked");
      created.push(unlocked.sessionId);
      warned = coreOutput.slice(before).includes("沒有要求認證");
      replyUnlocked = await chatOnce(client, unlocked.sessionId, "hello unlocked");
    } finally {
      await setProviderEnvVars(client, FAKE_OPENCODE, { FAKE_OPENCODE_DISABLE_AUTH: "0" });
    }
    record(
      "PM14 伺服器沒有要求認證(模擬不認 OPENCODE_SERVER_PASSWORD 的舊版 opencode)時,adapter 在 log 裡警告,但 session 照常起得來、能對話",
      unlocked?.start?.enforced === false && warned && replyUnlocked === EXPECTED_FAKE_REPLY,
      `warned=${warned}, enforced=${unlocked?.start?.enforced}`,
    );

    // ---- PM15:ACP(family=opencode)同樣拿到隨機密碼;對照組不被動到 ----
    await setProviderEnvVars(client, FAKE_ACP_OPENCODE, { OPENCODE_SERVER_PASSWORD: USER_PASSWORD, OPENCODE_SERVER_USERNAME: "user-chosen-name" });
    let acp1;
    let acp2;
    try {
      acp1 = await reportOpencodeConfig(client, FAKE_ACP_OPENCODE, workspaceDir, ACP_REPORT_ENV, "pm15a");
      acp2 = await reportOpencodeConfig(client, FAKE_ACP_OPENCODE, workspaceDir, ACP_REPORT_ENV, "pm15b");
    } finally {
      await setProviderEnvVars(client, FAKE_ACP_OPENCODE, { OPENCODE_SERVER_PASSWORD: "", OPENCODE_SERVER_USERNAME: "" });
    }
    const control = await reportOpencodeConfig(client, FAKE_ACP, workspaceDir, ACP_REPORT_ENV, "pm15c");
    const acpAuth = [acp1.serverAuth, acp2.serverAuth];
    record(
      "PM15 ACP(family=opencode):`opencode acp` 子行程同樣拿到隨機密碼(使用者名稱 deskmony、至少 32 字元、兩次 spawn 不同、覆蓋使用者與 shell 環境給的值);沒有宣告 family 的 ACP agent 拿不到任何 opencode 伺服器密碼/使用者名稱(連 core 的 shell 環境裡繼承來的也被濾掉,2026-10-05)",
      acpAuth.every((x) => x !== null && x.username === "deskmony" && x.passwordLength >= 32) &&
        acpAuth[0].passwordSha256 !== acpAuth[1].passwordSha256 &&
        acpAuth.every((x) => x.passwordSha256 !== sha256Hex(USER_PASSWORD) && x.passwordSha256 !== sha256Hex(AMBIENT_SERVER_PASSWORD)) &&
        // 對照組:不是 opencode 家族的 agent 完全不該拿到 opencode 伺服器的認證(2026-10-05:buildAgentChildEnv() 的 denylist)。
        control.serverAuth === null,
      `acp 密碼長度=${JSON.stringify(acpAuth.map((x) => x?.passwordLength))}, 兩次不同=${acpAuth[0]?.passwordSha256 !== acpAuth[1]?.passwordSha256}, 對照組拿到的認證=${JSON.stringify(control.serverAuth)}`,
    );

    // ---- PM16:密碼沒有洩漏到 log、推播、對話紀錄、DB ----
    const secrets = [...new Set(startRecords().map((r) => r.password).filter(Boolean))];
    const needles = secrets.flatMap((password) => [password, Buffer.from(`deskmony:${password}`).toString("base64")]);
    const targets = [
      ["core log", coreOutput],
      ["WS 推播", JSON.stringify(client.timeline)],
    ];
    for (const sessionId of [...created, ...otherLiveSessionIds]) {
      const { messages } = await client.rpc("session.history", { sessionId });
      targets.push([`session.history(${sessionId.slice(0, 8)})`, JSON.stringify(messages)]);
    }
    const dbFiles = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].filter((f) => existsSync(f));
    for (const file of dbFiles) targets.push([`SQLite 檔 ${path.basename(file)}`, readFileSync(file).toString("latin1")]);
    const leaked = targets.filter(([, content]) => needles.some((needle) => content.includes(needle))).map(([name]) => name);
    record(
      "PM16 密碼(及 Authorization 的 base64 形式)不出現在 core log、WS 推播、任何 session 的 history、SQLite 檔(含 WAL)——只存在於 adapter 記憶體與子行程環境",
      secrets.length >= 5 && dbFiles.length >= 1 && leaked.length === 0,
      `檢查了 ${secrets.length} 組密碼 × ${targets.length} 個位置(含 ${dbFiles.length} 個 DB 檔),洩漏位置=${JSON.stringify(leaked)}`,
    );

    // ---- PM17:adapter 的每個真實請求都帶了認證(必須最後做:要涵蓋整支測試期間的所有請求) ----
    const report = readAuthReport();
    const expectedRejected = [
      // adapter 每次 spawn(且伺服器有鎖)刻意不帶認證打一次 /global/health,確認認證真的生效。
      ...report.filter((r) => r.kind === "start" && r.enforced).map((r) => `${r.pid} GET /global/health`),
      ...deliberateRejections.map((r) => `${r.pid} ${r.method} ${r.path}`),
    ].sort();
    const actualRejected = report
      .filter((r) => r.kind === "rejected")
      .map((r) => `${r.pid} ${r.method} ${r.path}`)
      .sort();
    record(
      "PM17 adapter 的每個真實請求都帶了認證:整支測試期間(session 建立、/message、SSE /event、權限回覆、dispose 清理……)fake 擋下的請求只有 adapter 每次 spawn 的一次無認證健全性探測(GET /global/health)與 PM12 的刻意探測,零筆其他",
      actualRejected.length > 0 && isDeepStrictEqual(actualRejected, expectedRejected),
      `被擋下 ${actualRejected.length} 筆,預期 ${expectedRejected.length} 筆(spawn 探測 ${report.filter((r) => r.kind === "start" && r.enforced).length} + 刻意探測 ${deliberateRejections.length})`,
    );
  } finally {
    for (const sessionId of created) await client.rpc("session.delete", { sessionId }, 15_000).catch(() => undefined);
  }
}

// =======================================================================
/** 送一則 prompt、等這一輪結束,回傳這一輪的 assistant 文字(串起來)。 */
async function driveText(client, sessionId, text, timeoutMs = 20_000) {
  const from = client.timeline.length;
  await client.rpc("session.sendPrompt", { sessionId, prompt: { text } });
  await client.waitFor((e) => isTurnEnd(e, sessionId), timeoutMs, from);
  const { messages } = await client.rpc("session.history", { sessionId });
  return messages.filter((m) => m.role === "assistant").map((m) => m.content).join("\n");
}

async function withOpenSession(client, providerId, workspaceDir, title, sessionIds, body) {
  const {
    session: { id: sessionId },
  } = await client.rpc("session.create", { providerId, workingDir: workspaceDir, title }, 30_000);
  sessionIds.push(sessionId);
  return body(sessionId);
}

const SHELL_ENV_NAMES = ["OPENCODE_SERVER_PASSWORD", "OPENCODE_SERVER_USERNAME", "OPENCODE_CONFIG_CONTENT", "E2E_SHELL_KEEP", "PATH"];

async function testShellEnvPlugin(client, workspaceDir) {
  const backends = [
    { label: "HTTP(opencode)", providerId: FAKE_OPENCODE, configPrefix: OPENCODE_REPORT_ENV, shellPrefix: OPENCODE_REPORT_SHELL_ENV },
    { label: "ACP(family=opencode)", providerId: FAKE_ACP_OPENCODE, configPrefix: ACP_REPORT_ENV, shellPrefix: ACP_REPORT_SHELL_ENV },
  ];
  const sessionIds = [];
  try {
    // ---- PM18:plugin 陣列 ----
    const pluginFacts = [];
    for (const { label, providerId, configPrefix } of backends) {
      await setProviderEnvVars(client, providerId, { OPENCODE_CONFIG_CONTENT: "", E2E_SHELL_KEEP: "1" });
      const plain = await reportOpencodeConfig(client, providerId, workspaceDir, configPrefix, "pm18a");
      const ourEntry = plain.config?.plugin?.[0];
      // 使用者自己的 plugin(含「同一個外掛路徑」)
      await setProviderEnvVars(client, providerId, {
        OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugin: [ourEntry?.[0] ?? "x", "user-plugin", ["user-tuple-plugin", { a: 1 }]] }),
      });
      const merged = await reportOpencodeConfig(client, providerId, workspaceDir, configPrefix, "pm18b");
      const mergedPlugins = merged.config?.plugin ?? [];
      pluginFacts.push({
        label,
        plainOk: Array.isArray(plain.config?.plugin) && plain.config.plugin.length === 1 && isOurPluginEntry(ourEntry),
        mergedOk:
          mergedPlugins.length === 3 &&
          mergedPlugins[0] === "user-plugin" &&
          isDeepStrictEqual(mergedPlugins[1], ["user-tuple-plugin", { a: 1 }]) &&
          isOurPluginEntry(mergedPlugins[2]) &&
          // 使用者寫進去的同一個外掛路徑只留一份(附加在最後的那份)
          mergedPlugins.filter((p) => (Array.isArray(p) ? p[0] : p) === ourEntry?.[0]).length === 1,
      });
      await setProviderEnvVars(client, providerId, { OPENCODE_CONFIG_CONTENT: "" });
    }
    record(
      "PM18 HTTP 與 ACP(family=opencode):`OPENCODE_CONFIG_CONTENT` 的 plugin 陣列最後一項是 Deskmony 的外掛([file:// URL(指到存在的 opencode-shell-env-plugin.js), {loadedMarkerFile}]);使用者自己的 plugin(字串與元組)原樣保留在前面、同一個外掛路徑只留一份",
      pluginFacts.every((f) => f.plainOk && f.mergedOk),
      JSON.stringify(pluginFacts),
    );

    // ---- PM19:外掛檔本身 + 宿主載入後的 shell 環境 ----
    const pluginModule = await import(pathToFileURL(path.join(REPO_ROOT, "packages", "adapters", "dist", "opencode-shell-env-plugin.js")).href);
    const exportNames = Object.keys(pluginModule);
    const shellFacts = [];
    for (const { label, providerId, shellPrefix } of backends) {
      const got = await withOpenSession(client, providerId, workspaceDir, "pm19", sessionIds, async (sessionId) => {
        const text = await driveText(client, sessionId, `${shellPrefix}${SHELL_ENV_NAMES.join(",")}`);
        const m = /SHELLENV:(\{.*\})/s.exec(text);
        if (!m) throw new Error(`回覆裡找不到 SHELLENV:{...}: ${text.slice(0, 200)}`);
        return JSON.parse(m[1]);
      });
      shellFacts.push({
        label,
        ok:
          // opencode 行程自己的環境有(它需要)——所以「shell 裡沒有」是外掛濾掉的、不是本來就沒有
          got.process.OPENCODE_SERVER_PASSWORD === true &&
          got.process.OPENCODE_SERVER_USERNAME === true &&
          got.process.OPENCODE_CONFIG_CONTENT === true &&
          got.shell.OPENCODE_SERVER_PASSWORD === false &&
          got.shell.OPENCODE_SERVER_USERNAME === false &&
          got.shell.OPENCODE_CONFIG_CONTENT === false &&
          // 其他變數(provider env 給的)與 PATH 照常有,沒有矯枉過正
          got.shell.E2E_SHELL_KEEP === true &&
          got.shell.PATH === true &&
          isDeepStrictEqual(got.pluginsLoaded, ["opencode-shell-env-plugin.js#DeskmonyOpencodeShellEnvPlugin"]) &&
          got.pluginErrors.length === 0,
        detail: got,
      });
    }
    record(
      "PM19 外掛檔只匯出一個函式(opencode 會把每個函式匯出都當外掛工廠呼叫);被宿主載入後 agent 的 bash 工具環境沒有 OPENCODE_SERVER_PASSWORD/OPENCODE_SERVER_USERNAME/OPENCODE_CONFIG_CONTENT(opencode 行程自己的環境有),其他變數與 PATH 照常有",
      exportNames.length === 1 && typeof pluginModule[exportNames[0]] === "function" && shellFacts.every((f) => f.ok),
      `exports=${JSON.stringify(exportNames)}; ${JSON.stringify(shellFacts)}`,
    );

    // ---- PM20:載入標記檔被消化 ----
    const markerFacts = [];
    for (const { label, providerId, configPrefix } of backends) {
      const logFrom = coreOutput.length;
      const got = await reportOpencodeConfig(client, providerId, workspaceDir, configPrefix, "pm20", { keep: true });
      sessionIds.push(got.sessionId);
      const marker = got.config?.plugin?.[got.config.plugin.length - 1]?.[1]?.loadedMarkerFile;
      // fake 後端啟動時載入外掛(外掛因此寫了標記檔);adapter 在 session 建立之後的背景輪詢會看到並刪掉它。
      const deadline = Date.now() + 4_000;
      while (typeof marker === "string" && existsSync(marker) && Date.now() < deadline) await sleep(100);
      markerFacts.push({
        label,
        consumed: typeof marker === "string" && !existsSync(marker),
        noWarning: !coreOutput.slice(logFrom).includes("沒有載入 Deskmony 的外掛"),
      });
    }
    record(
      "PM20 外掛載入時寫的標記檔被 adapter 的偵測消化(檔案被刪、沒有「外掛沒載入」警告)——HTTP 與 ACP 都是",
      markerFacts.every((f) => f.consumed && f.noWarning),
      JSON.stringify(markerFacts),
    );

    // ---- PM20b:偵測函式本身的語意(直接呼叫編譯後的函式,不經 core)----
    {
      const { prepareOpencodeShellEnvPlugin, watchOpencodeShellEnvPluginLoaded, discardOpencodeShellEnvPluginMarker } = await import(
        pathToFileURL(path.join(REPO_ROOT, "packages", "adapters", "dist", "index.js")).href
      );
      const { writeFileSync } = await import("node:fs");
      const warnings = [];
      const origWarn = console.warn;
      console.warn = (...a) => warnings.push(a.join(" "));
      let loadedResult;
      let missingResult;
      let cancelledResult;
      let markerAfterLoaded;
      let markerAfterMissing;
      let markerAfterCancelled;
      let warnedOnLoaded;
      let warnedOnCancelled;
      try {
        const launchA = prepareOpencodeShellEnvPlugin("e2e", "unit-a");
        writeFileSync(launchA.markerFile, "{}");
        loadedResult = await watchOpencodeShellEnvPluginLoaded(launchA, "e2e", "unit-a", { timeoutMs: 1_000, pollMs: 20 });
        markerAfterLoaded = existsSync(launchA.markerFile);
        warnedOnLoaded = warnings.length;

        const launchB = prepareOpencodeShellEnvPlugin("e2e", "unit-b");
        missingResult = await watchOpencodeShellEnvPluginLoaded(launchB, "e2e", "unit-b", { timeoutMs: 300, pollMs: 20 });
        markerAfterMissing = existsSync(launchB.markerFile);
        const warnedOnMissing = warnings.length - warnedOnLoaded;

        const launchC = prepareOpencodeShellEnvPlugin("e2e", "unit-c");
        writeFileSync(launchC.markerFile, "{}");
        cancelledResult = await watchOpencodeShellEnvPluginLoaded(launchC, "e2e", "unit-c", { timeoutMs: 1_000, pollMs: 20, isCancelled: () => true });
        markerAfterCancelled = existsSync(launchC.markerFile);
        warnedOnCancelled = warnings.length - warnedOnLoaded - warnedOnMissing;

        // discard 對 undefined 是安全的 no-op
        discardOpencodeShellEnvPluginMarker(undefined);

        record(
          "PM20b 載入標記檔的偵測:標記檔在 → true 且檔案被刪、不警告;逾時沒出現 → false 並警告「opencode 沒有載入 Deskmony 的外掛」;session 已被 dispose(isCancelled)→ false、不警告、標記檔也清掉",
          loadedResult === true &&
            markerAfterLoaded === false &&
            warnedOnLoaded === 0 &&
            missingResult === false &&
            markerAfterMissing === false &&
            warnedOnMissing === 1 &&
            warnings.some((w) => w.includes("沒有載入 Deskmony 的外掛")) &&
            cancelledResult === false &&
            markerAfterCancelled === false &&
            warnedOnCancelled === 0,
          `loaded=${loadedResult}/markerLeft=${markerAfterLoaded}/warns=${warnedOnLoaded}; missing=${missingResult}/warns=${warnedOnMissing}; cancelled=${cancelledResult}/markerLeft=${markerAfterCancelled}/warns=${warnedOnCancelled}`,
        );
      } finally {
        console.warn = origWarn;
      }
    }

    // ---- PM21:外掛沒被載入 → 警告,但 session 照常 ----
    await setProviderEnvVars(client, FAKE_OPENCODE, { FAKE_OPENCODE_SKIP_PLUGINS: "1" });
    let skipped;
    try {
      const logFrom = coreOutput.length;
      skipped = await withOpenSession(client, FAKE_OPENCODE, workspaceDir, "pm21", sessionIds, async (sessionId) => {
        const reply = await driveText(client, sessionId, "hello without the plugin");
        const shellText = await driveText(client, sessionId, `${OPENCODE_REPORT_SHELL_ENV}${SHELL_ENV_NAMES.join(",")}`);
        const parsed = JSON.parse(/SHELLENV:(\{.*\})/s.exec(shellText)?.[1] ?? "null");
        // adapter 的偵測最多等 10 秒才警告
        const deadline = Date.now() + 15_000;
        while (!coreOutput.slice(logFrom).includes("沒有載入 Deskmony 的外掛") && Date.now() < deadline) await sleep(200);
        return { reply, parsed, warned: coreOutput.slice(logFrom).includes("沒有載入 Deskmony 的外掛") };
      });
    } finally {
      await setProviderEnvVars(client, FAKE_OPENCODE, { FAKE_OPENCODE_SKIP_PLUGINS: "" });
    }
    record(
      "PM21 外掛沒被載入(模擬不認 shell.env 的舊版 opencode)→ adapter 在 log 裡警告「opencode 沒有載入 Deskmony 的外掛」,但 session 照常起得來、照常回覆",
      skipped.warned &&
        skipped.reply.includes(FAKE_OPENCODE_REPLY_CHUNKS.join("")) &&
        skipped.parsed?.pluginsLoaded?.length === 0 &&
        // 沒外掛 = shell 環境沒被濾(證明警告說的風險是真的,也證明 PM19 的「沒有」確實是外掛的功勞)
        skipped.parsed?.shell?.OPENCODE_SERVER_PASSWORD === true,
      `warned=${skipped.warned}, reply=${JSON.stringify(skipped.reply.slice(0, 60))}, pluginsLoaded=${JSON.stringify(skipped.parsed?.pluginsLoaded)}`,
    );
  } finally {
    for (const sessionId of sessionIds) {
      await client.rpc("session.delete", { sessionId }, 15_000).catch(() => undefined);
    }
  }
}

// =======================================================================
async function main() {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-oc-perm-data-"));
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-oc-perm-home-"));
  const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-oc-perm-ws-"));
  const authReportDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-oc-perm-auth-"));
  authReportFile = path.join(authReportDir, "fake-opencode-auth-report.jsonl");

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

    console.log("=== PM1-PM3、PM9-PM10:HTTP(opencode)啟動時注入的設定與 session 網路 MCP ===");
    await testHttpDefault(client, workspaceDir);
    await testHttpMerge(client, workspaceDir);
    await testHttpBrokenJson(client, workspaceDir);
    await testHttpSessionNetwork(client, workspaceDir);

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

    console.log("\n=== PM11-PM17:opencode 本機伺服器的認證 ===");
    await testOpencodeServerAuth(client, workspaceDir, dbPath, [httpSessionId]);

    console.log("\n=== PM18-PM21:opencode 外掛(shell.env)===");
    await testShellEnvPlugin(client, workspaceDir);
  } catch (err) {
    record("執行過程發生未預期錯誤", false, err instanceof Error ? err.stack : String(err));
  } finally {
    // 先讓 adapter 正常收掉 fake server 子程序,再停 core。
    for (const sessionId of sessionIds) {
      await client?.rpc("session.delete", { sessionId }, 15_000).catch(() => undefined);
    }
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
  console.error("[e2e-opencode-permissions] fatal:", err);
  process.exit(1);
});
