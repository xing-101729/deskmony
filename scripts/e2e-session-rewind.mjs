#!/usr/bin/env node
/**
 * scripts/e2e-session-rewind.mjs
 *
 * 2026-10-16(訊息 hover 動作列:倒回 / 分支)端到端驗證:`session.rewind` 把對話倒回到某則使用者訊息送出之前
 * (M 及之後全部移除、agent 換成全新的後端對話、M 之前的對話改成文字紀錄附在下一則 prompt 前面、model / 思考程度保留、
 * 只倒對話不碰檔案);`session.fork` 建一個新 session、複製 M 之前的訊息、原 session 完全不動。
 *
 * 全部走假後端(決定性,不需要任何憑證):scripts/fake-acp-agent.mjs(`--resume` 宣告能接回,用來證明倒回**不會**接回舊的後端對話;
 * `--config-options` 回報 model / 思考程度選項;`REVIVE_REPORT_MARKER` 讓 agent 回報它自己收到的完整 prompt 與記憶)、
 * fake-opencode-server.mjs、fake-pty-echo.mjs。假後端把每個 ACP 呼叫 / HTTP 路由寫進 `calls.log`。
 *
 * 一次只開一個 core(降低機器負載):階段 1 的 core 跑完所有「core 活著」的情境後正常關閉;階段 2 在同一個 data dir 重啟,
 * 測沒有 runtime 的 session;階段 3 把階段 2 的 core 強制殺掉(崩潰)後再重啟,測 interrupted 的 session。
 *
 * 涵蓋:
 *   A   倒回到中間的訊息(provider 宣告 session/resume,但倒回不得接回):DB 只剩 M 之前 + 一則系統說明;回傳 M 的原文;agent 走
 *       session/new(沒有 session/resume);下一則 prompt 前面附了只含 M 之前的紀錄(說明用 rewind 的措辭),只附一次;DB 存的
 *       使用者訊息是原文;後端識別碼換成新的;兩個 client 都收到 session-history-reset 推播。
 *   B   倒回到第一則訊息:沒有任何先前對話 → 不附紀錄、系統說明 = rewoundFresh。
 *   C   model / 思考程度保留(--config-options):倒回後 session 的 model/effort 不變,fake agent 端也被重新套用;之後從這個 session 分支,
 *       新 session 同樣帶著 model/effort。
 *   D   分支:新 session(同 provider / 資料夾、標題 = 原標題 + 後綴、標題來源沿用)、M 之前的訊息逐欄位複製(順序、createdAt、role、content)、
 *       最後一則是系統說明、新 agent 的第一則 prompt 附了(只含 M 之前、fork 措辭的)紀錄;原 session 的歷史與狀態完全不變;自訂後綴;
 *       分支第一則訊息 = 不附紀錄;超長標題截短;標題來源 auto 沿用。
 *   E   busy 時倒回 / 分支一律被拒(sessionHistory.busy),什麼都不動;idle 後可以。
 *   F   PTY(終端程式)被拒(sessionHistory.unsupported)。
 *   G   messageId 不屬於這個 session / 不存在 / 是 assistant、system、別的 session 轉傳來的訊息 → 明確的錯誤碼。
 *   H   client 指定 messageId:DB 的 id 就是它;重複的 id 得到 session.messageIdConflict(不是 SQLite 錯誤),agent 沒收到第二次;
 *       用它倒回成功(剛送出的訊息可以倒回)。
 *   I   OpenCode(HTTP):倒回後開新的 opencode session(POST /session),不沿用舊的。
 *   O   排序:history 與倒回切點用同一個 (created_at, rowid) 鍵——created_at 與寫入順序不一致的 session、created_at 全部相同的 session
 *       (改 DB 製造)。這一組會在 getHistory 少了 ORDER BY 時失敗。
 *   R   沒有 runtime(core 重啟後 closed)倒回:只改 DB、不啟動 agent、狀態維持 closed、後端識別碼清掉;下一則訊息自動復活走
 *       session/new(不是 session/resume),紀錄只含 M 之前,措辭是 rewind 的(不是「app 重新開啟」)。
 *   U   interrupted(崩潰後)倒回:狀態維持 interrupted、復原視圖 canContinue 變 false(後端識別碼清了,不能再接回含被移除內容的舊對話)、
 *       直接送訊息仍能復活。
 *
 * scoped MCP bridge token 不能呼叫 session.rewind / session.fork,在 scripts/e2e-session-network.mjs 的 P3.7-8 驗證。
 *
 * 前置需求:`pnpm build` 已跑過。用法:node scripts/e2e-session-rewind.mjs [名稱片段...]
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { FAKE_ACP_REPLY_CHUNKS, REPORT_CONFIG_PREFIX, REVIVE_REPORT_MARKER, SLEEP_TURN_PREFIX } from "./fake-acp-agent.mjs";
import { requireFreshBuild } from "./lib/require-fresh-build.mjs";
import { e2eProvidersEnv, FAKE_ACP, FAKE_OPENCODE, FAKE_PTY } from "./lib/e2e-providers.mjs";

requireFreshBuild();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const CORE_ENTRY = path.join(REPO_ROOT, "apps", "core", "dist", "index.js");
const GRACEFUL_BOOTSTRAP = path.join(REPO_ROOT, "scripts", "e2e-crash-recovery-graceful-bootstrap.mjs");
const ACP_SCRIPT = path.join(REPO_ROOT, "scripts", "fake-acp-agent.mjs");
// better-sqlite3 不是這個 script 所在目錄的直接依賴,借用 apps/core 已安裝好的那一份(同 e2e-agent-catalog.mjs)。
const BETTER_SQLITE3_PATH = path.join(REPO_ROOT, "apps", "core", "node_modules", "better-sqlite3", "lib", "index.js");

const FAKE_ACP_REPLY = FAKE_ACP_REPLY_CHUNKS.join("");
const TRANSCRIPT_HEADER = "【Deskmony 補充的先前對話】";
const NEW_MESSAGE_HEADER = "【使用者的新訊息】";

const PROVIDER_RESUME = "e2e-fake-acp-resume";
const PROVIDER_OPT = "e2e-fake-acp-opt";
const EXTRA_PROVIDERS = [
  { id: PROVIDER_RESUME, label: "E2E Fake ACP (--resume)", software: "acp", command: process.execPath, args: [ACP_SCRIPT, "--resume"] },
  {
    id: PROVIDER_OPT,
    label: "E2E Fake ACP (--config-options)",
    software: "acp",
    command: process.execPath,
    args: [ACP_SCRIPT, "--config-options"],
    supportsModelSelection: true,
    supportsEffortSelection: true,
    optionsAfterStart: true,
  },
];

const WANT_MODEL = "fake/gamma"; // 預設是 fake/beta
const WANT_EFFORT = "max";

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`\n${ok ? "PASS" : "FAIL"} ${name}`);
  if (detail) console.log(`       ${detail}`);
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function clip(text, n = 160) {
  const s = String(text);
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

// =======================================================================
class MiniGatewayClient {
  constructor(url) {
    this.url = url;
    this.pendingRpc = new Map();
    this.events = [];
    this.historyResets = [];
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
    this.ws.addEventListener("message", (e) => this.handleMessage(e.data));
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
  }

  handleMessage(raw) {
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
      if (msg.channel === "session-event") this.events.push(msg.payload);
      else if (msg.channel === "session-history-reset") this.historyResets.push(msg.payload);
    }
  }

  rpc(method, params, timeoutMs = 60_000) {
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

  waitFor(arr, predicate, timeoutMs, fromIndex = 0) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        for (let i = fromIndex; i < arr.length; i++) {
          if (predicate(arr[i])) return arr[i];
        }
        return undefined;
      };
      const found = check();
      if (found) return resolve(found);
      const poll = setInterval(() => {
        const hit = check();
        if (hit) {
          clearInterval(poll);
          resolve(hit);
        } else if (Date.now() - start > timeoutMs) {
          clearInterval(poll);
          reject(new Error(`等待逾時 (${timeoutMs}ms),目前筆數=${arr.length}`));
        }
      }, 40);
    });
  }
}

// ---- core 行程 -----------------------------------------------------------

let portCounter = 4960;
function nextPort() {
  return portCounter++;
}

function startCore({ port, dataDir, homeDir, workspaceDir, extraEnv }) {
  const env = {
    ...process.env,
    DESKMONY_CORE_PORT: String(port),
    DESKMONY_DATA_DIR: dataDir,
    DESKMONY_HOME: homeDir,
    DESKMONY_WORKSPACE: workspaceDir,
    ...e2eProvidersEnv(EXTRA_PROVIDERS),
    ...extraEnv,
  };
  // 一律走 graceful bootstrap(有 IPC 通道):要正常關閉時送 "graceful-shutdown";要模擬崩潰時直接殺行程樹。
  const proc = spawn(process.execPath, [GRACEFUL_BOOTSTRAP], { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
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

/** 模擬崩潰(kill -9)。 */
async function killProcessTreeHard(proc) {
  if (!proc || proc.exitCode !== null || proc.killed) return;
  const exitPromise = new Promise((resolve) => proc.once("exit", resolve));
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
    else proc.kill("SIGKILL");
  } catch {
    // ignore
  }
  await Promise.race([exitPromise, sleep(3000)]);
}

async function gracefulShutdown(proc, timeoutMs = 20_000) {
  const exitPromise = new Promise((resolve) => proc.once("exit", resolve));
  proc.send("graceful-shutdown");
  return Promise.race([exitPromise.then(() => true), sleep(timeoutMs).then(() => false)]);
}

function newDirs(tag) {
  const make = (kind) => mkdtempSync(path.join(os.tmpdir(), `deskmony-e2e-rewind-${tag}-${kind}-`));
  const dirs = { dataDir: make("data"), homeDir: make("home"), workspaceDir: make("ws"), stateDir: make("state") };
  dirs.cleanup = () => {
    for (const dir of [dirs.dataDir, dirs.homeDir, dirs.workspaceDir, dirs.stateDir]) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  };
  return dirs;
}

/** 起一個 core(同一組 dirs)並連線。回傳 `{ proc, client, url }`。 */
async function boot(dirs) {
  const port = nextPort();
  const proc = startCore({
    port,
    dataDir: dirs.dataDir,
    homeDir: dirs.homeDir,
    workspaceDir: dirs.workspaceDir,
    extraEnv: { FAKE_ACP_STATE_DIR: dirs.stateDir, FAKE_OPENCODE_STATE_DIR: dirs.stateDir },
  });
  const url = `ws://127.0.0.1:${port}`;
  await waitForPort(url, 30_000);
  const client = new MiniGatewayClient(url);
  await client.connect();
  return { proc, client, url };
}

// ---- 共用操作 ------------------------------------------------------------

async function createSession(client, providerId, workspaceDir, title) {
  const { session } = await client.rpc("session.create", { providerId, workingDir: workspaceDir, title }, 60_000);
  return session.id;
}

/** 送一則 prompt(可指定 messageId),等這一輪結束,回傳 agent 的回覆文字。 */
async function turn(client, sessionId, text, { messageId, timeoutMs = 60_000 } = {}) {
  const from = client.events.length;
  await client.rpc("session.sendPrompt", { sessionId, prompt: { text }, ...(messageId ? { messageId } : {}) }, timeoutMs);
  const done = await client.waitFor(
    client.events,
    (e) => e.sessionId === sessionId && (e.event.type === "completed" || e.event.type === "error"),
    timeoutMs,
    from,
  );
  const reply = client.events
    .slice(from)
    .filter((e) => e.sessionId === sessionId && e.event.type === "message-delta")
    .map((e) => e.event.delta)
    .join("");
  return { reply, final: done.event };
}

/** 送出結尾是 REVIVE_REPORT_MARKER 的 prompt,解出 agent 回報的「它自己的記憶」與收到的完整 prompt。 */
async function report(client, sessionId, label) {
  const text = `${label} ${REVIVE_REPORT_MARKER}`;
  const { reply, final } = await turn(client, sessionId, text);
  if (!reply.startsWith("REVIVE_REPORT:")) throw new Error(`非預期的回覆(${final.type}): ${reply.slice(0, 200)}`);
  return { sent: text, report: JSON.parse(reply.slice("REVIVE_REPORT:".length)) };
}

async function getSession(client, sessionId) {
  const { sessions } = await client.rpc("session.list", {});
  return sessions.find((s) => s.id === sessionId);
}

async function waitSession(client, sessionId, predicate, timeoutMs = 15_000) {
  const start = Date.now();
  for (;;) {
    const s = await getSession(client, sessionId);
    if (s && predicate(s)) return s;
    if (Date.now() - start > timeoutMs) return s; // 讓呼叫端的斷言失敗並印出目前狀態
    await sleep(100);
  }
}

async function getHistory(client, sessionId) {
  return (await client.rpc("session.history", { sessionId })).messages;
}

function noticeEvents(messages) {
  return messages
    .filter((m) => m.role === "system")
    .map((m) => {
      try {
        return JSON.parse(m.content);
      } catch {
        return { event: m.content };
      }
    });
}

/** 預期 rpc 被拒絕,回傳 `{ rejected, code }`。 */
async function expectReject(promise) {
  try {
    await promise;
    return { rejected: false };
  } catch (err) {
    return { rejected: true, code: err.errorCode, message: String(err?.message ?? err) };
  }
}

/** calls.log(假後端寫的 JSON lines)。 */
function readCalls(dirs) {
  const file = path.join(dirs.stateDir, "calls.log");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}
const pidsOf = (calls) => new Set(calls.map((c) => c.pid));
const callsSince = (dirs, pidsBefore) => readCalls(dirs).filter((c) => !pidsBefore.has(c.pid));
const callNames = (calls) => calls.map((c) => c.call);

const TURNS = ["第一輪:蘋果", "第二輪:香蕉", "第三輪:櫻桃"];
const ROLE_ORDER = (messages) => messages.map((m) => m.role).join(",");

/** 用 better-sqlite3 直接改 DB(core 必須已經關閉)。 */
async function withDb(dirs, fn) {
  const { default: Database } = await import(pathToFileURL(BETTER_SQLITE3_PATH).href);
  const db = new Database(path.join(dirs.dataDir, "deskmony.db"));
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

// =======================================================================
// 階段 1:core 活著的情境
// =======================================================================
const sessionsForLater = {};

async function phaseLive(dirs, filters) {
  const want = (name) => filters.length === 0 || filters.some((f) => name.includes(f));
  let c;
  let second;
  try {
    c = await boot(dirs);
    second = new MiniGatewayClient(c.url);
    await second.connect();
    const { client } = c;

    // ---- A:倒回到中間 ----------------------------------------------------
    if (want("A")) {
      const A = await createSession(client, PROVIDER_RESUME, dirs.workspaceDir, "rw-mid");
      for (const t of TURNS) await turn(client, A, t);
      const hist0 = await getHistory(client, A);
      const users0 = hist0.filter((m) => m.role === "user");
      const before = await getSession(client, A);
      const pids0 = pidsOf(readCalls(dirs));
      const resetFrom = client.historyResets.length;
      const resetFrom2 = second.historyResets.length;
      const res = await client.rpc("session.rewind", { sessionId: A, messageId: users0[1].id }, 60_000);
      const hist1 = await getHistory(client, A);
      const notices = noticeEvents(hist1);
      record(
        "A1 倒回到第二則使用者訊息:回傳 M 的原文、session 回到 idle;DB 只剩 M 之前的兩則(id 不變)+ 一則系統說明 rewoundFromTranscript(2 則)",
        res.message.content === TURNS[1] &&
          res.session.id === A &&
          res.session.status === "idle" &&
          ROLE_ORDER(hist1) === "user,assistant,system" &&
          hist1[0].id === hist0[0].id &&
          hist1[1].id === hist0[1].id &&
          hist1[0].content === TURNS[0] &&
          !JSON.stringify(hist1).includes("香蕉") &&
          !JSON.stringify(hist1).includes("櫻桃") &&
          notices.length === 1 &&
          notices[0].event === "session.rewoundFromTranscript" &&
          notices[0].params?.count === 2,
        `returned=${clip(res.message.content, 30)}, status=${res.session.status}, roles=${ROLE_ORDER(hist1)}, notices=${JSON.stringify(notices)}`,
      );
      await client.waitFor(client.historyResets, (p) => p.sessionId === A, 5000, resetFrom).catch(() => undefined);
      await second.waitFor(second.historyResets, (p) => p.sessionId === A, 5000, resetFrom2).catch(() => undefined);
      record(
        "A2 兩個 client 都收到 session-history-reset 推播(其他視窗會重新載入)",
        client.historyResets.slice(resetFrom).some((p) => p.sessionId === A) && second.historyResets.slice(resetFrom2).some((p) => p.sessionId === A),
        `client=${client.historyResets.length - resetFrom}, second=${second.historyResets.length - resetFrom2}`,
      );
      const afterRewind = await getSession(client, A);
      const newCalls = callsSince(dirs, pids0);
      record(
        "A3 agent 重新啟動走 session/new(provider 宣告了 session/resume,倒回也不得接回含被移除內容的舊對話);後端識別碼換成新的",
        JSON.stringify(callNames(newCalls)) === JSON.stringify(["initialize", "session/new"]) &&
          typeof afterRewind?.backendSessionId === "string" &&
          afterRewind.backendSessionId !== before.backendSessionId &&
          afterRewind.backendSessionId === newCalls[1].sessionId,
        `calls=${JSON.stringify(newCalls)}, old=${before.backendSessionId}, new=${afterRewind?.backendSessionId}`,
      );
      const { sent, report: rep } = await report(client, A, "接著聊");
      record(
        "A4 下一則 prompt 前面附了只含 M 之前的對話紀錄(rewind 措辭,不是「app 重新開啟」),結尾是使用者的新訊息;agent 自己的記憶是空的(讀紀錄,不是記得)",
        rep.prompt.startsWith(TRANSCRIPT_HEADER) &&
          rep.prompt.includes("倒回") &&
          !rep.prompt.includes("app 重新開啟") &&
          rep.prompt.includes(`使用者: ${TURNS[0]}`) &&
          rep.prompt.includes(`assistant: ${FAKE_ACP_REPLY}`) &&
          !rep.prompt.includes("香蕉") &&
          !rep.prompt.includes("櫻桃") &&
          rep.prompt.endsWith(`${NEW_MESSAGE_HEADER}\n${sent}`) &&
          rep.priorPrompts.length === 0 &&
          rep.agentSessionId === afterRewind.backendSessionId,
        `prompt=${clip(rep.prompt, 360)}, priorPrompts=${JSON.stringify(rep.priorPrompts)}`,
      );
      const second1 = await report(client, A, "再問一次");
      const hist2 = await getHistory(client, A);
      record(
        "A5 紀錄只附一次(第二則 prompt 原樣送達);DB 存的使用者訊息是原文,沒有被塞對話紀錄",
        second1.report.prompt === second1.sent &&
          hist2.filter((m) => m.role === "user").map((m) => m.content).join("|") === [TURNS[0], sent, second1.sent].join("|") &&
          !hist2.some((m) => m.role === "user" && m.content.includes(TRANSCRIPT_HEADER)),
        `users=${JSON.stringify(hist2.filter((m) => m.role === "user").map((m) => clip(m.content, 40)))}`,
      );
      sessionsForLater.A = A;
    }

    // ---- B:倒回到第一則 --------------------------------------------------
    if (want("B")) {
      const B = await createSession(client, PROVIDER_RESUME, dirs.workspaceDir, "rw-first");
      for (const t of TURNS.slice(0, 2)) await turn(client, B, t);
      const hist0 = await getHistory(client, B);
      const res = await client.rpc("session.rewind", { sessionId: B, messageId: hist0.find((m) => m.role === "user").id }, 60_000);
      const hist1 = await getHistory(client, B);
      const { sent, report: rep } = await report(client, B, "全新開始");
      record(
        "B 倒回到第一則訊息:回傳第一則的原文;DB 只剩一則系統說明 rewoundFresh;下一則 prompt 原樣送達(沒有紀錄可附),agent 的記憶是空的",
        res.message.content === TURNS[0] &&
          ROLE_ORDER(hist1) === "system" &&
          noticeEvents(hist1)[0].event === "session.rewoundFresh" &&
          rep.prompt === sent &&
          rep.priorPrompts.length === 0,
        `notices=${JSON.stringify(noticeEvents(hist1))}, promptIsOriginal=${rep.prompt === sent}, prior=${JSON.stringify(rep.priorPrompts)}`,
      );
    }

    // ---- C:model / 思考程度保留 + 從這個 session 分支 ----------------------
    if (want("C")) {
      const C = await createSession(client, PROVIDER_OPT, dirs.workspaceDir, "rw-options");
      await waitSession(client, C, (s) => s.options?.model);
      await client.rpc("session.setModel", { sessionId: C, model: WANT_MODEL });
      await waitSession(client, C, (s) => s.options?.model?.current === WANT_MODEL);
      await client.rpc("session.setEffort", { sessionId: C, effort: WANT_EFFORT });
      await waitSession(client, C, (s) => s.options?.effort?.current === WANT_EFFORT);
      for (const t of TURNS.slice(0, 2)) await turn(client, C, t);
      const hist0 = await getHistory(client, C);
      const res = await client.rpc("session.rewind", { sessionId: C, messageId: hist0.filter((m) => m.role === "user")[1].id }, 60_000);
      const revived = await waitSession(client, C, (s) => s.options?.model?.current === WANT_MODEL && s.options?.effort?.current === WANT_EFFORT);
      await report(client, C, "套用設定後"); // 先用掉紀錄:下面的 REPORT_CONFIG_PREFIX 必須在 prompt 開頭才認得
      const agentCfg = JSON.parse((await turn(client, C, REPORT_CONFIG_PREFIX)).reply.replace(/^CONFIG:/, ""));
      record(
        "C1 倒回後 model / 思考程度保留:session.model/effort 不變;fake agent 重啟後回到預設,實際是 Deskmony 重新套用(session/set_config_option:model 先、思考程度後)",
        res.session.model === WANT_MODEL &&
          res.session.effort === WANT_EFFORT &&
          revived?.model === WANT_MODEL &&
          revived?.effort === WANT_EFFORT &&
          agentCfg?.model === WANT_MODEL &&
          agentCfg?.effort === WANT_EFFORT &&
          JSON.stringify(agentCfg?.setCalls?.map((x) => [x.configId, x.value])) === JSON.stringify([["llm", WANT_MODEL], ["think", WANT_EFFORT]]),
        `result=${res.session.model}/${res.session.effort}, session=${revived?.model}/${revived?.effort}, agent=${JSON.stringify(agentCfg)}`,
      );
      // 從這個 session 分支:新 session 也帶著 model / 思考程度
      const hist1 = await getHistory(client, C);
      const forkTarget = hist1.filter((m) => m.role === "user").at(-1);
      const forked = await client.rpc("session.fork", { sessionId: C, messageId: forkTarget.id }, 60_000);
      const forkedNow = await waitSession(client, forked.session.id, (s) => s.model === WANT_MODEL && s.effort === WANT_EFFORT);
      record(
        "C2 從這個 session 分支:新 session 同 provider,model / 思考程度也是 gamma / max(fork 重新套用,不是預設)",
        forked.session.providerId === PROVIDER_OPT && forkedNow?.model === WANT_MODEL && forkedNow?.effort === WANT_EFFORT,
        `forked=${forkedNow?.providerId} ${forkedNow?.model}/${forkedNow?.effort}`,
      );
    }

    // ---- D:分支 ----------------------------------------------------------
    if (want("D")) {
      const D = await createSession(client, FAKE_ACP, dirs.workspaceDir, "fork-src");
      for (const t of TURNS) await turn(client, D, t);
      const histOrig = await getHistory(client, D);
      const usersOrig = histOrig.filter((m) => m.role === "user");
      const origSession = await getSession(client, D);
      const sessionCountBefore = (await client.rpc("session.list", {})).sessions.length;
      const res = await client.rpc("session.fork", { sessionId: D, messageId: usersOrig[1].id }, 60_000);
      const F = res.session.id;
      const sessionCountAfter = (await client.rpc("session.list", {})).sessions.length;
      record(
        "D1 分支:建了新 session(同 provider / 資料夾 / idle),標題 = 原標題 + 「(分支)」,標題來源沿用(user),不掛在原 session 底下;回傳 M 的原文",
        F !== D &&
          sessionCountAfter === sessionCountBefore + 1 &&
          res.session.title === "fork-src (分支)" &&
          res.session.titleSource === "user" &&
          res.session.providerId === FAKE_ACP &&
          res.session.workingDir === dirs.workspaceDir &&
          res.session.status === "idle" &&
          res.session.parentSessionId === undefined &&
          res.message.content === TURNS[1],
        `title=${res.session.title}/${res.session.titleSource}, status=${res.session.status}, parent=${res.session.parentSessionId}`,
      );
      const forkHist = await getHistory(client, F);
      const copied = forkHist.slice(0, -1);
      const expectedCopied = histOrig.slice(0, 2);
      const sameFields = (a, b) => a.role === b.role && a.content === b.content && a.createdAt === b.createdAt && JSON.stringify(a.origin) === JSON.stringify(b.origin) && JSON.stringify(a.attachments) === JSON.stringify(b.attachments);
      const forkNotice = noticeEvents(forkHist).at(-1);
      record(
        "D2 新 session 的歷史 = 原 session 中 M 之前的訊息(順序、role、content、createdAt 逐一相同,id 是新的)+ 最後一則系統說明 forkedFromTranscript(2 則,帶原標題)",
        copied.length === 2 &&
          copied.every((m, i) => sameFields(m, expectedCopied[i]) && m.id !== expectedCopied[i].id && m.sessionId === F) &&
          forkHist.at(-1).role === "system" &&
          forkNotice.event === "session.forkedFromTranscript" &&
          forkNotice.params?.count === 2 &&
          forkNotice.params?.title === "fork-src",
        `roles=${ROLE_ORDER(forkHist)}, notice=${JSON.stringify(forkNotice)}`,
      );
      const histAfter = await getHistory(client, D);
      const origAfter = await getSession(client, D);
      record(
        "D3 原 session 完全不變:歷史(含 id)逐字相同、狀態 idle、後端識別碼沒變",
        JSON.stringify(histAfter) === JSON.stringify(histOrig) && origAfter?.status === "idle" && origAfter?.backendSessionId === origSession?.backendSessionId,
        `sameHistory=${JSON.stringify(histAfter) === JSON.stringify(histOrig)}, status=${origAfter?.status}`,
      );
      const { sent, report: rep } = await report(client, F, "分支後的第一則");
      record(
        "D4 新 agent 的第一則 prompt 前面附了紀錄(fork 措辭、只含 M 之前),agent 的記憶是空的,ACP session 與原 session 的不同",
        rep.prompt.startsWith(TRANSCRIPT_HEADER) &&
          rep.prompt.includes("分支出這個新對話") &&
          rep.prompt.includes(`使用者: ${TURNS[0]}`) &&
          !rep.prompt.includes("香蕉") &&
          !rep.prompt.includes("櫻桃") &&
          rep.prompt.endsWith(`${NEW_MESSAGE_HEADER}\n${sent}`) &&
          rep.priorPrompts.length === 0 &&
          rep.agentSessionId !== origSession?.backendSessionId,
        `prompt=${clip(rep.prompt, 360)}`,
      );
      const custom = await client.rpc("session.fork", { sessionId: D, messageId: usersOrig[2].id, titleSuffix: " (fork) " }, 60_000);
      record("D5 自訂後綴(桌面端傳目前語言的字串):標題 = 原標題 + 後綴(空白已整理)", custom.session.title === "fork-src (fork)", `title=${custom.session.title}`);
      const first = await client.rpc("session.fork", { sessionId: D, messageId: usersOrig[0].id }, 60_000);
      const firstHist = await getHistory(client, first.session.id);
      const firstReport = await report(client, first.session.id, "從頭分支");
      record(
        "D6 在第一則訊息分支:沒有東西可複製,歷史只有一則系統說明 forkedFresh;第一則 prompt 原樣送達(不附紀錄)",
        ROLE_ORDER(firstHist) === "system" &&
          noticeEvents(firstHist)[0].event === "session.forkedFresh" &&
          first.message.content === TURNS[0] &&
          firstReport.report.prompt === firstReport.sent &&
          firstReport.report.priorPrompts.length === 0,
        `notices=${JSON.stringify(noticeEvents(firstHist))}`,
      );
      await client.rpc("session.rename", { sessionId: D, title: "長".repeat(100) });
      const longFork = await client.rpc("session.fork", { sessionId: D, messageId: usersOrig[1].id }, 60_000);
      const longChars = Array.from(longFork.session.title).length;
      record(
        "D7 原標題已達 100 字上限:分支標題截短後仍 ≤ 100 字、以後綴結尾、標題來源維持 user",
        longChars <= 100 && longFork.session.title.endsWith("(分支)") && longFork.session.titleSource === "user",
        `chars=${longChars}, source=${longFork.session.titleSource}`,
      );
      const auto = await client.rpc("session.autoTitle", { sessionId: D }, 90_000);
      const autoFork = await client.rpc("session.fork", { sessionId: D, messageId: usersOrig[1].id }, 60_000);
      record(
        "D8 標題來源 auto 的 session 分支後仍是 auto(標題 = AI 取的名字 + 後綴)",
        auto.session.titleSource === "auto" && autoFork.session.titleSource === "auto" && autoFork.session.title === `${auto.session.title} (分支)`,
        `auto=${auto.session.titleSource}/${auto.session.title}, fork=${autoFork.session.titleSource}/${autoFork.session.title}`,
      );
      sessionsForLater.D = D;
    }

    // ---- E:busy 時被拒 ---------------------------------------------------
    if (want("E")) {
      const E = await createSession(client, FAKE_ACP, dirs.workspaceDir, "rw-busy");
      await turn(client, E, TURNS[0]);
      const histE = await getHistory(client, E);
      const target = histE.find((m) => m.role === "user");
      await client.rpc("session.sendPrompt", { sessionId: E, prompt: { text: `${SLEEP_TURN_PREFIX}${JSON.stringify({ ms: 60_000 })}` } });
      await waitSession(client, E, (s) => s.status === "busy");
      const histBusy = await getHistory(client, E);
      const rewindBusy = await expectReject(client.rpc("session.rewind", { sessionId: E, messageId: target.id }));
      const forkBusy = await expectReject(client.rpc("session.fork", { sessionId: E, messageId: target.id }));
      const histBusyAfter = await getHistory(client, E);
      record(
        "E1 busy 時倒回與分支都被拒(sessionHistory.busy),歷史沒有任何變動",
        rewindBusy.rejected && rewindBusy.code === "sessionHistory.busy" && forkBusy.rejected && forkBusy.code === "sessionHistory.busy" && JSON.stringify(histBusy) === JSON.stringify(histBusyAfter),
        `rewind=${rewindBusy.code}, fork=${forkBusy.code}`,
      );
      await client.rpc("session.interrupt", { sessionId: E });
      await waitSession(client, E, (s) => s.status === "idle", 20_000);
      const rewindIdle = await expectReject(client.rpc("session.rewind", { sessionId: E, messageId: target.id }, 60_000));
      record("E2 idle 之後同一個倒回成功", !rewindIdle.rejected, JSON.stringify(rewindIdle));
    }

    // ---- F:PTY 被拒 ------------------------------------------------------
    if (want("F")) {
      const P = await createSession(client, FAKE_PTY, dirs.workspaceDir, "rw-pty");
      await client.rpc("session.sendPrompt", { sessionId: P, prompt: { text: "hello-pty" } });
      const histP = await getHistory(client, P);
      const userMsg = histP.find((m) => m.role === "user");
      const rewindPty = await expectReject(client.rpc("session.rewind", { sessionId: P, messageId: userMsg?.id ?? randomUUID() }));
      const forkPty = await expectReject(client.rpc("session.fork", { sessionId: P, messageId: userMsg?.id ?? randomUUID() }));
      const sessionsNow = (await client.rpc("session.list", {})).sessions.filter((s) => s.providerId === FAKE_PTY);
      record(
        "F PTY(終端程式)倒回與分支都被拒(sessionHistory.unsupported),沒有多出新 session",
        rewindPty.rejected && rewindPty.code === "sessionHistory.unsupported" && forkPty.rejected && forkPty.code === "sessionHistory.unsupported" && sessionsNow.length === 1,
        `rewind=${rewindPty.code}, fork=${forkPty.code}, ptySessions=${sessionsNow.length}`,
      );
    }

    // ---- G:messageId 不合法 ----------------------------------------------
    if (want("G")) {
      const A = sessionsForLater.A ?? (await createSession(client, FAKE_ACP, dirs.workspaceDir, "rw-invalid-a"));
      const D = sessionsForLater.D ?? (await createSession(client, FAKE_ACP, dirs.workspaceDir, "rw-invalid-d"));
      if (!sessionsForLater.A) await turn(client, A, TURNS[0]);
      if (!sessionsForLater.D) await turn(client, D, TURNS[0]);
      const histA = await getHistory(client, A);
      const histD = await getHistory(client, D);
      const dUser = histD.find((m) => m.role === "user");
      const dAssistant = histD.find((m) => m.role === "assistant");
      const aSystem = histA.find((m) => m.role === "system");
      // 別的 session 轉傳來的訊息(有 origin):D 收到 A 轉來的一則
      await client.rpc("session.forwardMessage", { sourceSessionId: A, targetSessionId: D, text: "從 A 轉來的訊息" });
      const forwarded = await (async () => {
        for (let i = 0; i < 100; i++) {
          const h = await getHistory(client, D);
          const hit = h.find((m) => m.origin);
          if (hit) return hit;
          await sleep(100);
        }
        return undefined;
      })();
      await waitSession(client, D, (s) => s.status === "idle", 20_000); // 轉傳會讓 D 的 agent 跑一輪
      const cases = [
        ["別的 session 的訊息 id", () => client.rpc("session.rewind", { sessionId: A, messageId: dUser.id }), "sessionHistory.messageNotFound"],
        ["不存在的 id", () => client.rpc("session.rewind", { sessionId: A, messageId: randomUUID() }), "sessionHistory.messageNotFound"],
        ["assistant 訊息", () => client.rpc("session.rewind", { sessionId: D, messageId: dAssistant.id }), "sessionHistory.messageNotRewindable"],
        ["system 訊息", () => client.rpc("session.fork", { sessionId: A, messageId: aSystem?.id ?? randomUUID() }), aSystem ? "sessionHistory.messageNotRewindable" : "sessionHistory.messageNotFound"],
        ["別的 session 轉傳來的訊息", () => client.rpc("session.rewind", { sessionId: D, messageId: forwarded?.id ?? randomUUID() }), "sessionHistory.messageNotRewindable"],
        ["不存在的 session", () => client.rpc("session.rewind", { sessionId: randomUUID(), messageId: randomUUID() }), "entity.notFound"],
      ];
      const outcomes = [];
      // 逐一執行(lazy):事先建好的 promise 在被 await 之前就 reject 會變成 unhandled rejection
      for (const [label, run, code] of cases) outcomes.push({ label, code, got: await expectReject(run()) });
      const histDAfter = await getHistory(client, D);
      record(
        "G messageId 不屬於這個 session / 不存在 / 是 assistant、system 或別的 session 轉傳來的訊息 / session 不存在:一律明確的錯誤碼,D 的歷史沒有被動到",
        forwarded !== undefined &&
          outcomes.every((o) => o.got.rejected && o.got.code === o.code) &&
          histDAfter.length === histD.length + 2, // 轉傳來的 user 訊息 + agent 的回覆
        outcomes.map((o) => `${o.label}=${o.got.code}`).join("; "),
      );
    }

    // ---- H:client 指定 messageId ------------------------------------------
    if (want("H")) {
      const H = await createSession(client, FAKE_ACP, dirs.workspaceDir, "rw-message-id");
      const other = await createSession(client, FAKE_ACP, dirs.workspaceDir, "rw-message-id-other");
      const mid = randomUUID();
      await turn(client, H, TURNS[0], { messageId: mid });
      const histH = await getHistory(client, H);
      const dup = await expectReject(client.rpc("session.sendPrompt", { sessionId: H, prompt: { text: "重複的 id" }, messageId: mid }));
      const dupOther = await expectReject(client.rpc("session.sendPrompt", { sessionId: other, prompt: { text: "別的 session 用同一個 id" }, messageId: mid }));
      const bad = await expectReject(client.rpc("session.sendPrompt", { sessionId: H, prompt: { text: "壞的 id" }, messageId: "not-a-uuid" }));
      await sleep(400); // 讓任何(不該發生的)第二次送出有時間變成 busy
      const histH2 = await getHistory(client, H);
      const sH = await getSession(client, H);
      record(
        "H1 client 指定的 messageId 就是 DB 的 messages.id;同一個 id 再送(同 session 或別的 session)得到 session.messageIdConflict,不是 SQLite 錯誤,什麼都沒送給 agent、沒有寫 DB;格式不對被 schema 擋下",
        histH.find((m) => m.role === "user")?.id === mid &&
          dup.rejected && dup.code === "session.messageIdConflict" &&
          dupOther.rejected && dupOther.code === "session.messageIdConflict" &&
          bad.rejected &&
          JSON.stringify(histH2) === JSON.stringify(histH) &&
          sH?.status === "idle" &&
          (await getHistory(client, other)).length === 0,
        `dup=${dup.code}, dupOther=${dupOther.code}, bad=${bad.code}, history=${ROLE_ORDER(histH2)}, status=${sH?.status}`,
      );
      const res = await client.rpc("session.rewind", { sessionId: H, messageId: mid }, 60_000);
      record(
        "H2 剛送出的訊息(client 自己產生的 id)可以直接倒回:回傳原文、歷史只剩系統說明",
        res.message.content === TURNS[0] && ROLE_ORDER(await getHistory(client, H)) === "system",
        `returned=${clip(res.message.content, 30)}`,
      );
    }

    // ---- I:OpenCode ------------------------------------------------------
    if (want("I")) {
      const I = await createSession(client, FAKE_OPENCODE, dirs.workspaceDir, "rw-opencode");
      for (const t of TURNS.slice(0, 2)) await turn(client, I, t);
      const before = await getSession(client, I);
      const hist0 = await getHistory(client, I);
      const pids0 = pidsOf(readCalls(dirs));
      await client.rpc("session.rewind", { sessionId: I, messageId: hist0.filter((m) => m.role === "user")[1].id }, 60_000);
      const { sent, report: rep } = await report(client, I, "接著聊");
      const newCalls = callsSince(dirs, pids0);
      record(
        "I OpenCode:倒回後新的 server 開新的 opencode session(POST /session),不沿用舊的(沒有 GET /session/:id hit);紀錄只含 M 之前",
        callNames(newCalls).includes("POST /session") &&
          !callNames(newCalls).includes("GET /session/:id hit") &&
          rep.agentSessionId !== before.backendSessionId &&
          rep.priorPrompts.length === 0 &&
          rep.prompt.startsWith(TRANSCRIPT_HEADER) &&
          rep.prompt.includes(`使用者: ${TURNS[0]}`) &&
          !rep.prompt.includes("香蕉") &&
          rep.prompt.endsWith(`${NEW_MESSAGE_HEADER}\n${sent}`),
        `calls=${JSON.stringify(callNames(newCalls))}, prompt=${clip(rep.prompt, 240)}`,
      );
    }

    // ---- 為階段 2 / 3 備料 -------------------------------------------------
    if (want("R") || want("O") || want("U")) {
      const def = await createSession(client, PROVIDER_RESUME, dirs.workspaceDir, "rw-stopped");
      for (const t of TURNS) await turn(client, def, t);
      const ord = await createSession(client, PROVIDER_RESUME, dirs.workspaceDir, "rw-order");
      for (const t of TURNS.slice(0, 2)) await turn(client, ord, t);
      const tie = await createSession(client, PROVIDER_RESUME, dirs.workspaceDir, "rw-tie");
      for (const t of TURNS.slice(0, 2)) await turn(client, tie, t);
      const intr = await createSession(client, PROVIDER_RESUME, dirs.workspaceDir, "rw-interrupted");
      for (const t of TURNS.slice(0, 2)) await turn(client, intr, t);
      Object.assign(sessionsForLater, { def, ord, tie, intr });
    }
  } catch (err) {
    record("階段 1 執行過程發生未預期錯誤", false, String(err?.stack ?? err));
  } finally {
    second?.close();
    c?.client.close();
    if (c) {
      const exited = await gracefulShutdown(c.proc);
      if (!exited) await killProcessTreeHard(c.proc);
    }
  }
}

// =======================================================================
// 階段 2:同一個 data dir 重啟(session 都是 closed,沒有 runtime)
// =======================================================================
async function phaseStopped(dirs, filters) {
  const want = (name) => filters.length === 0 || filters.some((f) => name.includes(f));
  const { def, ord, tie, intr } = sessionsForLater;
  if (!def || !ord || !tie || !intr) return;

  // 改 DB 製造排序情境(core 已關閉)。ord:created_at 與寫入順序不一致;tie:全部同一毫秒。
  const prepared = await withDb(dirs, (db) => {
    const rows = (sid) => db.prepare("SELECT rowid AS rid, id, role FROM messages WHERE session_id = ? ORDER BY rowid").all(sid);
    const setTime = db.prepare("UPDATE messages SET created_at = ? WHERE id = ?");
    const ordRows = rows(ord); // [u1, a1, u2, a2]
    [1000, 1500, 1400, 2000].forEach((t, i) => setTime.run(t, ordRows[i].id));
    const tieRows = rows(tie);
    tieRows.forEach((r) => setTime.run(5000, r.id));
    return { ordRows, tieRows, defBackend: db.prepare("SELECT backend_session_id AS id FROM sessions WHERE id = ?").get(def)?.id };
  });

  let c;
  let crashed = false;
  try {
    c = await boot(dirs);
    const { client } = c;

    if (want("O")) {
      const ordHist = await getHistory(client, ord);
      const ordExpected = [prepared.ordRows[0].id, prepared.ordRows[2].id, prepared.ordRows[1].id, prepared.ordRows[3].id]; // 依 created_at:1000, 1400, 1500, 2000
      record(
        "O1 history 的順序是 (created_at, rowid):created_at 與寫入順序不一致時照 created_at 排(user1 → user2 → assistant1 → assistant2)",
        JSON.stringify(ordHist.map((m) => m.id)) === JSON.stringify(ordExpected),
        `got=${ordHist.map((m) => `${m.role}@${m.createdAt}`).join(" ")}`,
      );
      const tieHist = await getHistory(client, tie);
      record(
        "O2 created_at 全部相同時用 rowid(寫入順序)當次排序鍵",
        JSON.stringify(tieHist.map((m) => m.id)) === JSON.stringify(prepared.tieRows.map((r) => r.id)),
        `got=${tieHist.map((m) => m.role).join(",")}`,
      );
      // 倒回切點用同一個鍵:ord 在 user2(created_at 1400)倒回 → 留下 created_at < 1400 的只有 user1;assistant1(1500)雖然寫入得早,
      // 依時間在 M 之後,一起移除
      const pids0 = pidsOf(readCalls(dirs));
      const ordUsers = ordHist.filter((m) => m.role === "user");
      const ordRes = await client.rpc("session.rewind", { sessionId: ord, messageId: ordUsers[1].id }, 60_000);
      const ordAfter = await getHistory(client, ord);
      record(
        "O3 倒回切點用同一個排序鍵:ord 在 user2(1400)倒回,只剩 created_at 比它早的 user1;寫入得比它早、但時間在它之後的 assistant1(1500)一起被移除",
        ordRes.message.content === TURNS[1] && ROLE_ORDER(ordAfter) === "user,system" && ordAfter[0].id === prepared.ordRows[0].id,
        `roles=${ROLE_ORDER(ordAfter)}`,
      );
      const tieUsers = tieHist.filter((m) => m.role === "user");
      await client.rpc("session.rewind", { sessionId: tie, messageId: tieUsers[1].id }, 60_000);
      const tieAfter = await getHistory(client, tie);
      record(
        "O4 created_at 全部相同時,倒回依 rowid 切:在 user2 倒回剩下 user1、assistant1(+ 系統說明),沒有把同一毫秒的 user1/assistant1 誤刪或誤留 user2/assistant2",
        ROLE_ORDER(tieAfter) === "user,assistant,system" && tieAfter[0].id === prepared.tieRows[0].id && tieAfter[1].id === prepared.tieRows[1].id,
        `roles=${ROLE_ORDER(tieAfter)}`,
      );
      record("O5 沒有 runtime 的 session 倒回不會啟動 agent(沒有新的 agent 行程)", callsSince(dirs, pids0).length === 0, `newCalls=${callsSince(dirs, pids0).length}`);
    }

    if (want("R")) {
      const histDef = await getHistory(client, def);
      const before = await getSession(client, def);
      const pids0 = pidsOf(readCalls(dirs));
      const res = await client.rpc("session.rewind", { sessionId: def, messageId: histDef.filter((m) => m.role === "user")[2].id }, 60_000);
      const histAfter = await getHistory(client, def);
      const after = await getSession(client, def);
      record(
        "R1 core 重啟後(closed、沒有 runtime)倒回:狀態維持 closed、不啟動 agent、後端識別碼清掉(舊的含被移除的內容,不能再被接回)、DB 剩 M 之前 4 則 + 系統說明 rewoundDeferred",
        before?.status === "closed" &&
          before?.backendSessionId === prepared.defBackend &&
          res.session.status === "closed" &&
          after?.status === "closed" &&
          after?.backendSessionId === undefined &&
          callsSince(dirs, pids0).length === 0 &&
          ROLE_ORDER(histAfter) === "user,assistant,user,assistant,system" &&
          noticeEvents(histAfter).at(-1).event === "session.rewoundDeferred" &&
          res.message.content === TURNS[2],
        `status=${after?.status}, backend=${after?.backendSessionId}, newCalls=${callsSince(dirs, pids0).length}, roles=${ROLE_ORDER(histAfter)}`,
      );
      const { sent, report: rep } = await report(client, def, "復活後");
      const newCalls = callsSince(dirs, pids0);
      const revivedSession = await getSession(client, def);
      record(
        "R2 下一則訊息自動復活:agent 走 session/new(provider 宣告了 session/resume,但後端識別碼已清,不得接回);紀錄只含 M 之前、措辭是 rewind(倒回)而不是「app 重新開啟」;agent 記憶是空的",
        JSON.stringify(callNames(newCalls)) === JSON.stringify(["initialize", "session/new"]) &&
          rep.prompt.startsWith(TRANSCRIPT_HEADER) &&
          rep.prompt.includes("倒回") &&
          !rep.prompt.includes("app 重新開啟") &&
          rep.prompt.includes(`使用者: ${TURNS[1]}`) &&
          !rep.prompt.includes("櫻桃") &&
          rep.prompt.endsWith(`${NEW_MESSAGE_HEADER}\n${sent}`) &&
          rep.priorPrompts.length === 0 &&
          revivedSession?.status === "idle" &&
          revivedSession?.backendSessionId === rep.agentSessionId,
        `calls=${JSON.stringify(callNames(newCalls))}, prompt=${clip(rep.prompt, 300)}`,
      );
      const second = await report(client, def, "再來一次");
      record("R3 紀錄只附一次;之後的訊息原樣送達", second.report.prompt === second.sent, `promptIsOriginal=${second.report.prompt === second.sent}`);
    }

    if (want("U")) {
      // 讓 intr 有 runtime(復活),然後強制殺掉 core:重啟後它會是 interrupted
      await report(client, intr, "復活一下");
      client.close();
      await killProcessTreeHard(c.proc);
      crashed = true;
    }
  } catch (err) {
    record("階段 2 執行過程發生未預期錯誤", false, String(err?.stack ?? err));
  } finally {
    c?.client.close();
    if (c && !crashed) {
      const exited = await gracefulShutdown(c.proc);
      if (!exited) await killProcessTreeHard(c.proc);
    }
  }
  return crashed;
}

// =======================================================================
// 階段 3:崩潰後重啟(interrupted)
// =======================================================================
async function phaseInterrupted(dirs) {
  const { intr } = sessionsForLater;
  let c;
  try {
    c = await boot(dirs);
    const { client } = c;
    const before = await getSession(client, intr);
    const listBefore = (await client.rpc("recovery.list", {})).sessions.find((r) => r.sessionId === intr);
    const hist0 = await getHistory(client, intr);
    const pids0 = pidsOf(readCalls(dirs));
    const res = await client.rpc("session.rewind", { sessionId: intr, messageId: hist0.filter((m) => m.role === "user")[1].id }, 60_000);
    const after = await getSession(client, intr);
    const listAfter = (await client.rpc("recovery.list", {})).sessions.find((r) => r.sessionId === intr);
    const continueAttempt = await expectReject(client.rpc("recovery.continue", { sessionId: intr }, 60_000));
    record(
      "U1 崩潰後(interrupted)倒回:狀態維持 interrupted、不啟動 agent;復原視圖的 canContinue 由 true 變 false,「繼續」被拒(舊的後端對話含被移除的內容,不能再被接回)",
      before?.status === "interrupted" &&
        listBefore?.canContinue === true &&
        res.session.status === "interrupted" &&
        after?.status === "interrupted" &&
        listAfter?.canContinue === false &&
        continueAttempt.rejected &&
        callsSince(dirs, pids0).length === 0,
      `before=${before?.status}/${listBefore?.canContinue}, after=${after?.status}/${listAfter?.canContinue}, continue=${continueAttempt.code}`,
    );
    const { sent, report: rep } = await report(client, intr, "直接送訊息");
    const newCalls = callsSince(dirs, pids0);
    record(
      "U2 直接送訊息仍能復活:走 session/new、紀錄只含 M 之前(rewind 措辭)",
      JSON.stringify(callNames(newCalls)) === JSON.stringify(["initialize", "session/new"]) &&
        rep.prompt.includes(`使用者: ${TURNS[0]}`) &&
        !rep.prompt.includes("香蕉") &&
        rep.prompt.includes("倒回") &&
        rep.prompt.endsWith(`${NEW_MESSAGE_HEADER}\n${sent}`),
      `calls=${JSON.stringify(callNames(newCalls))}, prompt=${clip(rep.prompt, 240)}`,
    );
  } catch (err) {
    record("階段 3 執行過程發生未預期錯誤", false, String(err?.stack ?? err));
  } finally {
    c?.client.close();
    if (c) {
      const exited = await gracefulShutdown(c.proc);
      if (!exited) await killProcessTreeHard(c.proc);
    }
  }
}

// =======================================================================
const filters = process.argv.slice(2);
const dirs = newDirs("all");
try {
  await phaseLive(dirs, filters);
  const crashed = await phaseStopped(dirs, filters);
  if (crashed) await phaseInterrupted(dirs);
} finally {
  dirs.cleanup();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${"=".repeat(70)}\n總結:${results.length - failed.length}/${results.length} 通過`);
if (failed.length > 0) {
  console.log("失敗項目:");
  for (const f of failed) console.log(`  - ${f.name}`);
}
process.exit(failed.length > 0 ? 1 : 0);
