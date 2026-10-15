#!/usr/bin/env node
/**
 * scripts/e2e-session-revive.mjs
 *
 * 2026-10-15(session 自動復活)端到端驗證:app 關閉/崩潰重開之後,使用者對**沒有活 runtime** 的 session
 * (closed / interrupted)送訊息,core 要透明地重新啟動 agent 並把訊息送達,盡量保留上下文;復原視圖的
 * 「繼續(保有記憶)」對 ACP / OpenCode 也要可用,兩條路徑共用同一個重新啟動流程。
 *
 * 根因(修復前):重開後 `SessionManager.runtime` 是空的,`sendPrompt()` 一律丟 `SESSION_NOT_RUNNING`,桌面端把
 * rejection 吞掉——使用者只看到自己那則訊息,agent 什麼都沒回。
 *
 * 全部走假後端(決定性,不需要任何憑證):scripts/fake-acp-agent.mjs(加了 `--resume` / `--load` / `--forget` 旗標與
 * `FAKE_ACP_STATE_DIR` 持久化,見該檔檔頭「2026-10-15」)與 scripts/fake-opencode-server.mjs(加了
 * `FAKE_OPENCODE_STATE_DIR` / `FAKE_OPENCODE_FORGET`)。假後端把每個 ACP 呼叫 / HTTP 路由寫進 `calls.log`,本測試靠它斷言
 * 「走了哪條路」(resume / load / 新對話 / 沿用 opencode session)與「agent 行程啟動了幾次」;靠 `REVIVE_REPORT_MARKER`
 * 讓 agent 回報**它自己**的記憶(收過哪些 prompt),區分「agent 真的記得」與「agent 只是讀了 Deskmony 附的對話紀錄」。
 *
 * 涵蓋:
 *   R   正常關閉 → 同一個 data dir 重啟 core → 對 closed session sendPrompt 自動復活;agent 宣告 session/resume 時走 resume
 *       (mcpServers 照樣掛上),agent 原生記得先前的 prompt、收到的 prompt 沒有被塞對話紀錄,系統說明是 revivedResumed。
 *   L   agent 只宣告 loadSession:走 session/load,agent 會在回應前重播整段歷史——重播**絕不**進 core 的事件串流與 DB
 *       (沒有重複的 user/assistant 訊息、沒有 tool 訊息)。
 *   N   agent 完全不支援接回(預設假 agent):退回 session/new + 對話紀錄——紀錄只附在第一則 prompt 前面、DB 存的使用者訊息是原文、
 *       後端識別碼更新成新的 ACP session id、系統說明明講「讀紀錄接續」。
 *   F   agent 宣告能接回、但它那邊的歷史已不在(resume / load 都試):接回失敗不能讓這次送出失敗,退回新對話 + 對話紀錄。
 *   D   連按兩次送出:只 spawn 一次 agent(每 session 的鎖涵蓋重新啟動)。
 *   C   kill -9 → interrupted:復原視圖 canContinue=true;「繼續」走同一個流程(原生接回 / 退回對話紀錄);直接送訊息
 *       也能把 interrupted 的 session 救回來。
 *   O   OpenCode(HTTP):沿用既有 opencode session(GET /session/{id} 命中);opencode 那邊的 session 已不在 → 新建 + 對話紀錄。
 *   P   PTY:重新啟動、系統說明「不保留記憶」、**不**把對話紀錄灌進終端。
 *   E   重新啟動失敗(agent 起不來):送出得到明確錯誤、DB 狀態還原成 closed(不卡 busy)、使用者訊息沒有被寫進去,之後修好還能用。
 *   X   agent 透過 send_to_session 傳給已關閉的 session:維持明確報錯,**不**自動 spawn。
 *   K   Claude Agent SDK:本機沒登入也能驗(spawn 攔截探針,見 probe-claude-sdk-resume.mjs)——對話檔還在才帶 `--resume=<id>`、
 *       不在就開全新對話並回報 `resumed:false`、handle.id 沿用 Deskmony session id。
 *
 * 前置需求:`pnpm build` 已跑過。用法:node scripts/e2e-session-revive.mjs
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  CALL_BRIDGE_TOOL_PREFIX,
  FAKE_ACP_REPLY_CHUNKS,
  REPLAY_FILLER_PER_TURN,
  REPLAY_MARKER,
  REVIVE_REPORT_MARKER,
} from "./fake-acp-agent.mjs";
import { requireFreshBuild } from "./lib/require-fresh-build.mjs";
import { e2eProvidersEnv, FAKE_ACP, FAKE_OPENCODE, FAKE_PTY } from "./lib/e2e-providers.mjs";

requireFreshBuild();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const CORE_ENTRY = path.join(REPO_ROOT, "apps", "core", "dist", "index.js");
const GRACEFUL_BOOTSTRAP = path.join(REPO_ROOT, "scripts", "e2e-crash-recovery-graceful-bootstrap.mjs");
const ACP_SCRIPT = path.join(REPO_ROOT, "scripts", "fake-acp-agent.mjs");

const FAKE_ACP_REPLY = FAKE_ACP_REPLY_CHUNKS.join("");
const TRANSCRIPT_HEADER = "【Deskmony 補充的先前對話】";
const NEW_MESSAGE_HEADER = "【使用者的新訊息】";

const PROVIDER_RESUME = "e2e-fake-acp-resume";
const PROVIDER_LOAD = "e2e-fake-acp-load";
const PROVIDER_RESUME_FORGET = "e2e-fake-acp-resume-forget";
const PROVIDER_LOAD_FORGET = "e2e-fake-acp-load-forget";

function acpProvider(id, flags) {
  return { id, label: `E2E Fake ACP (${flags.join(" ") || "none"})`, software: "acp", command: process.execPath, args: [ACP_SCRIPT, ...flags] };
}
const EXTRA_PROVIDERS = [
  acpProvider(PROVIDER_RESUME, ["--resume"]),
  acpProvider(PROVIDER_LOAD, ["--load"]),
  acpProvider(PROVIDER_RESUME_FORGET, ["--resume", "--forget"]),
  acpProvider(PROVIDER_LOAD_FORGET, ["--load", "--forget"]),
];

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
class MiniGatewayClient {
  constructor(url) {
    this.url = url;
    this.pendingRpc = new Map();
    this.events = [];
    this.sessionUpdates = [];
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
      else if (msg.channel === "session-updated") this.sessionUpdates.push(msg.payload);
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

let portCounter = 4930;
function nextPort() {
  return portCounter++;
}

function startCore({ port, dataDir, homeDir, workspaceDir, extraEnv, graceful }) {
  const env = {
    ...process.env,
    DESKMONY_CORE_PORT: String(port),
    DESKMONY_DATA_DIR: dataDir,
    DESKMONY_HOME: homeDir,
    DESKMONY_WORKSPACE: workspaceDir,
    ...e2eProvidersEnv(EXTRA_PROVIDERS),
    ...extraEnv,
  };
  // graceful:經 IPC 觸發真正的優雅關閉 handler(見 e2e-crash-recovery-graceful-bootstrap.mjs 頂端說明)。
  const proc = spawn(process.execPath, [graceful ? GRACEFUL_BOOTSTRAP : CORE_ENTRY], {
    cwd: REPO_ROOT,
    env,
    stdio: graceful ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"],
  });
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

/** 模擬崩潰(kill -9),見 e2e-crash-recovery.mjs 的 killProcessTreeHard()。 */
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

async function gracefulShutdown(proc, timeoutMs = 15_000) {
  const exitPromise = new Promise((resolve) => proc.once("exit", resolve));
  proc.send("graceful-shutdown");
  return Promise.race([exitPromise.then(() => true), sleep(timeoutMs).then(() => false)]);
}

// ---- 一個 scenario 的暫存目錄與 core 開關 -------------------------------------

function newDirs(tag) {
  const make = (kind) => mkdtempSync(path.join(os.tmpdir(), `deskmony-e2e-revive-${tag}-${kind}-`));
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

/** 起一個 core(同一組 dirs)並連線。`graceful` = 之後用 IPC 優雅關閉。 */
async function boot(dirs, { graceful = false, extraEnv = {} } = {}) {
  const port = nextPort();
  const proc = startCore({
    port,
    dataDir: dirs.dataDir,
    homeDir: dirs.homeDir,
    workspaceDir: dirs.workspaceDir,
    graceful,
    extraEnv: { FAKE_ACP_STATE_DIR: dirs.stateDir, FAKE_OPENCODE_STATE_DIR: dirs.stateDir, ...extraEnv },
  });
  await waitForPort(`ws://127.0.0.1:${port}`, 30_000);
  const client = new MiniGatewayClient(`ws://127.0.0.1:${port}`);
  await client.connect();
  return { proc, client, port };
}

async function createSession(client, providerId, workspaceDir, title) {
  const { session } = await client.rpc("session.create", { providerId, workingDir: workspaceDir, title }, 60_000);
  return session.id;
}

/** 送一則 prompt,等這一輪結束,回傳 agent 的回覆文字。 */
async function turn(client, sessionId, text, timeoutMs = 60_000) {
  const from = client.events.length;
  await client.rpc("session.sendPrompt", { sessionId, prompt: { text } }, timeoutMs);
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

/** 送出結尾是 REVIVE_REPORT_MARKER 的 prompt,解出 agent 回報的「它自己的記憶」。 */
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

async function waitStatus(client, sessionId, status, timeoutMs = 15_000) {
  const start = Date.now();
  for (;;) {
    const s = await getSession(client, sessionId);
    if (s?.status === status) return s;
    if (Date.now() - start > timeoutMs) throw new Error(`session 狀態沒有變成 ${status}(目前 ${s?.status})`);
    await sleep(100);
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

/** 比 `pidsBefore` 之後才出現的行程寫的紀錄。 */
function callsSince(dirs, pidsBefore) {
  return readCalls(dirs).filter((c) => !pidsBefore.has(c.pid));
}
const pidsOf = (calls) => new Set(calls.map((c) => c.pid));
const callNames = (calls) => calls.map((c) => c.call);

function clip(text, n = 160) {
  const s = String(text);
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

const SECRET_PROMPT = "請記住暗號是 紫色長頸鹿,只回覆 OK";

// =======================================================================
// R:agent 宣告 session/resume → 走 resume,原生記得,沒有對話紀錄
// =======================================================================
async function testResume() {
  const dirs = newDirs("resume");
  let c1;
  let c2;
  try {
    c1 = await boot(dirs, { graceful: true });
    const sid = await createSession(c1.client, PROVIDER_RESUME, dirs.workspaceDir, "revive-resume");
    await turn(c1.client, sid, SECRET_PROMPT);
    const before = await getSession(c1.client, sid);
    const pidsBefore = pidsOf(readCalls(dirs));
    c1.client.close();
    const exited = await gracefulShutdown(c1.proc);
    c1 = undefined;

    c2 = await boot(dirs, { graceful: true });
    const closed = await getSession(c2.client, sid);
    record(
      "R1 正常關閉 → 重啟:session 是 closed,還沒有任何新的 agent 行程(自動復活是在人類送訊息時才發生)",
      exited && closed?.status === "closed" && callsSince(dirs, pidsBefore).length === 0 && typeof before?.backendSessionId === "string",
      `exited=${exited}, status=${closed?.status}, backendSessionId=${before?.backendSessionId}, newCalls=${callsSince(dirs, pidsBefore).length}`,
    );

    const { sent, report: rep } = await report(c2.client, sid, "你還記得什麼?");
    const after = await getSession(c2.client, sid);
    const newCalls = callsSince(dirs, pidsBefore);
    record(
      "R2 對 closed session sendPrompt → 自動復活並收到回覆;agent 走 session/resume(沒有 session/new)、掛上同一個 session 網路 MCP server、接回原本的 ACP session id",
      JSON.stringify(callNames(newCalls)) === JSON.stringify(["initialize", "session/resume"]) &&
        newCalls[1].sessionId === before.backendSessionId &&
        newCalls[1].mcpServers === 1 &&
        rep.agentSessionId === before.backendSessionId,
      `calls=${JSON.stringify(newCalls)}`,
    );
    record(
      "R3 原生接回:agent 自己的記憶裡有重啟前的 prompt;它收到的 prompt 就是使用者輸入的原文(沒有被塞對話紀錄)",
      rep.priorPrompts.length === 1 && rep.priorPrompts[0] === SECRET_PROMPT && rep.prompt === sent && !rep.prompt.includes(TRANSCRIPT_HEADER),
      `priorPrompts=${JSON.stringify(rep.priorPrompts)}, promptIsOriginal=${rep.prompt === sent}`,
    );

    const history = await getHistory(c2.client, sid);
    const roles = history.map((m) => m.role);
    const events = noticeEvents(history).map((e) => e.event);
    record(
      "R4 DB:使用者訊息是原文;順序 = 舊對話 → 使用者新訊息 → 系統說明(session.revivedResumed)→ agent 回覆;只有一則系統說明",
      JSON.stringify(roles) === JSON.stringify(["user", "assistant", "user", "system", "assistant"]) &&
        history[0].content === SECRET_PROMPT &&
        history[2].content === sent &&
        JSON.stringify(events) === JSON.stringify(["session.revivedResumed"]),
      `roles=${roles.join(",")}, events=${events.join(",")}`,
    );
    record(
      "R5 復活後 session 回到 idle、權限模式重設為 always-ask(沒有悄悄沿用/提高)、後端識別碼不變",
      after?.status === "idle" && after?.permissionMode === "always-ask" && after?.backendSessionId === before.backendSessionId,
      `status=${after?.status}, permissionMode=${after?.permissionMode}, backendSessionId=${after?.backendSessionId}`,
    );
  } catch (err) {
    record("R 執行過程發生未預期錯誤", false, String(err?.stack ?? err));
  } finally {
    c1?.client.close();
    c2?.client.close();
    await killProcessTreeHard(c1?.proc);
    await killProcessTreeHard(c2?.proc);
    dirs.cleanup();
  }
}

// =======================================================================
// L:agent 只宣告 loadSession → 走 session/load;重播歷史絕不進事件串流/DB
// =======================================================================
async function testLoadReplay() {
  const dirs = newDirs("load");
  let c1;
  let c2;
  try {
    c1 = await boot(dirs, { graceful: true });
    const sid = await createSession(c1.client, PROVIDER_LOAD, dirs.workspaceDir, "revive-load");
    const turns = ["第一輪:蘋果", "第二輪:香蕉", "第三輪:櫻桃"];
    for (const text of turns) await turn(c1.client, sid, text);
    const before = await getSession(c1.client, sid);
    const pidsBefore = pidsOf(readCalls(dirs));
    c1.client.close();
    await gracefulShutdown(c1.proc);
    c1 = undefined;

    c2 = await boot(dirs, { graceful: true });
    // 重播若漏進事件串流,agent 的回覆會夾著重播文字而解析不出報告——照樣往下做 L2 的洩漏斷言,讓失敗訊息指向真正的原因。
    let sent;
    let rep;
    let reportError;
    try {
      ({ sent, report: rep } = await report(c2.client, sid, "接著聊"));
    } catch (err) {
      reportError = err;
    }
    await sleep(300); // 讓任何晚到的(不該出現的)重播事件有機會抵達
    const newCalls = callsSince(dirs, pidsBefore);
    const replayed = newCalls.find((c) => c.call === "session/load.replayed");
    record(
      `L1 走 session/load(沒有 session/new);假 agent 在回應前真的重播了歷史(3 輪 × ${4 + REPLAY_FILLER_PER_TURN} 個 session/update)`,
      JSON.stringify(callNames(newCalls)) === JSON.stringify(["initialize", "session/load", "session/load.replayed"]) &&
        newCalls[1].sessionId === before.backendSessionId &&
        newCalls[1].mcpServers === 1 &&
        replayed?.updates === 3 * (4 + REPLAY_FILLER_PER_TURN),
      `calls=${JSON.stringify(newCalls)}`,
    );

    const leakedEvents = c2.client.events.filter((e) => JSON.stringify(e).includes(REPLAY_MARKER));
    const history = await getHistory(c2.client, sid);
    const leakedHistory = history.filter((m) => m.content.includes(REPLAY_MARKER));
    const count = (role) => history.filter((m) => m.role === role).length;
    record(
      "L2 重播不得當成新事件送出:core 的事件串流沒有任何重播內容;DB 沒有重複的 user/assistant 訊息、沒有重播出來的 tool 訊息(3 輪舊對話 + 1 輪新對話 = 4 user / 4 assistant / 0 tool)",
      leakedEvents.length === 0 && leakedHistory.length === 0 && count("user") === 4 && count("assistant") === 4 && count("tool") === 0,
      `leakedEvents=${leakedEvents.length}, leakedHistory=${leakedHistory.length}, user=${count("user")}, assistant=${count("assistant")}, tool=${count("tool")}${reportError ? `, reportError=${clip(reportError.message, 120)}` : ""}`,
    );
    record(
      "L3 load 接回後 agent 原生記得三輪舊對話,收到的 prompt 是使用者原文,系統說明是 revivedResumed",
      rep !== undefined &&
        rep.priorPrompts.length === 3 && rep.priorPrompts.every((p, i) => p === turns[i]) && rep.prompt === sent &&
        JSON.stringify(noticeEvents(history).map((e) => e.event)) === JSON.stringify(["session.revivedResumed"]),
      `priorPrompts=${JSON.stringify(rep?.priorPrompts)}`,
    );
  } catch (err) {
    record("L 執行過程發生未預期錯誤", false, String(err?.stack ?? err));
  } finally {
    c1?.client.close();
    c2?.client.close();
    await killProcessTreeHard(c1?.proc);
    await killProcessTreeHard(c2?.proc);
    dirs.cleanup();
  }
}

// =======================================================================
// N:agent 不支援接回 → session/new + 對話紀錄(只附一次、DB 存原文)
// F:agent 宣告能接回但歷史已不在 → 接回失敗不讓送出失敗,同樣退回對話紀錄
// =======================================================================
/** N 與 F 共用的斷言:退回新對話 + 對話紀錄。`attemptedCall` = 新 agent 行程應該先嘗試的接回呼叫(N 為 undefined)。 */
async function transcriptFallbackScenario(tag, providerId, attemptedCall) {
  const dirs = newDirs(tag);
  let c1;
  let c2;
  const label = attemptedCall ? `F(${attemptedCall} 失敗)` : "N(不支援接回)";
  try {
    c1 = await boot(dirs, { graceful: true });
    const sid = await createSession(c1.client, providerId, dirs.workspaceDir, `revive-${tag}`);
    await turn(c1.client, sid, SECRET_PROMPT);
    const before = await getSession(c1.client, sid);
    const pidsBefore = pidsOf(readCalls(dirs));
    c1.client.close();
    await gracefulShutdown(c1.proc);
    c1 = undefined;

    c2 = await boot(dirs, { graceful: true });
    const { sent, report: rep } = await report(c2.client, sid, "剛才的暗號是什麼?");
    const newCalls = callsSince(dirs, pidsBefore);
    const expectedCalls = ["initialize", ...(attemptedCall ? [attemptedCall] : []), "session/new"];
    record(
      `${label}-1 這次送出成功(沒有因為接回失敗而失敗),新 agent 行程的呼叫順序 = ${expectedCalls.join(" → ")}`,
      JSON.stringify(callNames(newCalls)) === JSON.stringify(expectedCalls),
      `calls=${JSON.stringify(callNames(newCalls))}`,
    );

    const transcriptOk =
      rep.prompt.startsWith(TRANSCRIPT_HEADER) &&
      rep.prompt.includes(`使用者: ${SECRET_PROMPT}`) &&
      rep.prompt.includes(`assistant: ${FAKE_ACP_REPLY}`) &&
      rep.prompt.includes("--- 先前對話開始 ---") &&
      rep.prompt.includes("--- 先前對話結束 ---") &&
      rep.prompt.endsWith(`${NEW_MESSAGE_HEADER}\n${sent}`);
    record(
      `${label}-2 新後端的第一則 prompt 前面附了對話紀錄(Deskmony 補上的說明 + 舊的 user/assistant 文字 + 使用者的新訊息);agent 自己的記憶是空的(它是讀紀錄,不是記得)`,
      transcriptOk && rep.priorPrompts.length === 0,
      `priorPrompts=${JSON.stringify(rep.priorPrompts)}, prompt=${clip(rep.prompt, 400)}`,
    );

    const history = await getHistory(c2.client, sid);
    const userMessages = history.filter((m) => m.role === "user").map((m) => m.content);
    const events = noticeEvents(history);
    const notice = events.find((e) => e.event === "session.revivedFromTranscript");
    record(
      `${label}-3 DB 存的使用者訊息維持原文(沒有被塞對話紀錄);系統說明 = revivedFromTranscript(2 則訊息)`,
      JSON.stringify(userMessages) === JSON.stringify([SECRET_PROMPT, sent]) &&
        !history.some((m) => m.role === "user" && m.content.includes(TRANSCRIPT_HEADER)) &&
        notice?.params?.count === 2 &&
        events.length === 1,
      `userMessages=${JSON.stringify(userMessages.map((m) => clip(m, 50)))}, events=${JSON.stringify(events)}`,
    );

    const afterFirst = await getSession(c2.client, sid);
    const second = await report(c2.client, sid, "再問一次");
    record(
      `${label}-4 對話紀錄只附一次:第二則 prompt 原樣送達;後端識別碼更新成新的 ACP session id(舊的已失效,不能留著)`,
      second.report.prompt === second.sent &&
        second.report.agentSessionId === rep.agentSessionId &&
        afterFirst?.backendSessionId === rep.agentSessionId &&
        rep.agentSessionId !== before.backendSessionId,
      `old=${before.backendSessionId}, new=${rep.agentSessionId}, persisted=${afterFirst?.backendSessionId}`,
    );
  } catch (err) {
    record(`${label} 執行過程發生未預期錯誤`, false, String(err?.stack ?? err));
  } finally {
    c1?.client.close();
    c2?.client.close();
    await killProcessTreeHard(c1?.proc);
    await killProcessTreeHard(c2?.proc);
    dirs.cleanup();
  }
}

// =======================================================================
// D:連按兩次送出 → 只 spawn 一次
// =======================================================================
async function testDoubleSend() {
  const dirs = newDirs("double");
  let c1;
  let c2;
  try {
    c1 = await boot(dirs, { graceful: true });
    const sid = await createSession(c1.client, PROVIDER_RESUME, dirs.workspaceDir, "revive-double");
    await turn(c1.client, sid, SECRET_PROMPT);
    const pidsBefore = pidsOf(readCalls(dirs));
    c1.client.close();
    await gracefulShutdown(c1.proc);
    c1 = undefined;

    c2 = await boot(dirs, { graceful: true });
    const from = c2.client.events.length;
    const results2 = await Promise.allSettled([
      c2.client.rpc("session.sendPrompt", { sessionId: sid, prompt: { text: "連按一" } }, 60_000),
      c2.client.rpc("session.sendPrompt", { sessionId: sid, prompt: { text: "連按二" } }, 60_000),
    ]);
    // 兩輪都要結束(第二則在第一輪還在跑時送進去,agent 依序處理)。
    const start = Date.now();
    while (c2.client.events.slice(from).filter((e) => e.sessionId === sid && e.event.type === "completed").length < 2) {
      if (Date.now() - start > 60_000) throw new Error("兩輪沒有都結束");
      await sleep(80);
    }
    await sleep(200);
    const newCalls = callsSince(dirs, pidsBefore);
    const history = await getHistory(c2.client, sid);
    const notices = noticeEvents(history).map((e) => e.event);
    record(
      "D 連按兩次送出:兩次都成功、只啟動一個新 agent 行程(1 次 initialize、1 次 session/resume)、只有一則復活說明、兩則使用者訊息都送達",
      results2.every((r) => r.status === "fulfilled") &&
        newCalls.filter((c) => c.call === "initialize").length === 1 &&
        newCalls.filter((c) => c.call === "session/resume").length === 1 &&
        pidsOf(newCalls).size === 1 &&
        notices.length === 1 &&
        history.filter((m) => m.role === "user").map((m) => m.content).join("|") === [SECRET_PROMPT, "連按一", "連按二"].join("|"),
      `settled=${results2.map((r) => r.status).join(",")}, calls=${JSON.stringify(callNames(newCalls))}, notices=${notices.join(",")}`,
    );
  } catch (err) {
    record("D 執行過程發生未預期錯誤", false, String(err?.stack ?? err));
  } finally {
    c1?.client.close();
    c2?.client.close();
    await killProcessTreeHard(c1?.proc);
    await killProcessTreeHard(c2?.proc);
    dirs.cleanup();
  }
}

// =======================================================================
// C:kill -9 → interrupted:復原視圖「繼續」(ACP)走同一個流程;直接送訊息也能救回 interrupted
// =======================================================================
async function testRecoveryContinue() {
  const dirs = newDirs("continue");
  let c1;
  let c2;
  try {
    c1 = await boot(dirs);
    const resumable = await createSession(c1.client, PROVIDER_RESUME, dirs.workspaceDir, "revive-continue-resume");
    const plain = await createSession(c1.client, FAKE_ACP, dirs.workspaceDir, "revive-continue-plain");
    const direct = await createSession(c1.client, PROVIDER_RESUME, dirs.workspaceDir, "revive-direct-send");
    for (const sid of [resumable, plain, direct]) await turn(c1.client, sid, SECRET_PROMPT);
    const pidsBefore = pidsOf(readCalls(dirs));
    c1.client.close();
    await killProcessTreeHard(c1.proc); // 崩潰:shutdown handler 沒機會跑
    c1 = undefined;

    c2 = await boot(dirs);
    const { sessions: recovery } = await c2.client.rpc("recovery.list", {});
    const info = (sid) => recovery.find((r) => r.sessionId === sid);
    record(
      "C1 崩潰後三個 ACP session 都是 interrupted、出現在復原視圖,且 canContinue=true(ACP 現在也能繼續;後端 session id 在 spawn 完就寫進 DB)",
      [resumable, plain, direct].every((sid) => info(sid)?.canContinue === true),
      `canContinue=${[resumable, plain, direct].map((sid) => info(sid)?.canContinue).join(",")}`,
    );

    // ---- 「繼續」:後端支援 resume → 原生接回 ----
    const continued = (await c2.client.rpc("recovery.continue", { sessionId: resumable }, 60_000)).session;
    const callsAfterContinue = callsSince(dirs, pidsBefore);
    const hist1 = await getHistory(c2.client, resumable);
    const r1 = await report(c2.client, resumable, "繼續之後");
    record(
      "C2 復原視圖「繼續」(後端支援 resume):session 回到 idle、走 session/resume、系統說明 = continuedAfterInterrupt;之後的訊息 agent 原生記得先前的 prompt、沒有被塞對話紀錄",
      continued.status === "idle" &&
        callsAfterContinue.some((c) => c.call === "session/resume" && c.sessionId === continued.backendSessionId) &&
        JSON.stringify(noticeEvents(hist1).map((e) => e.event)) === JSON.stringify(["session.continuedAfterInterrupt"]) &&
        r1.report.priorPrompts[0] === SECRET_PROMPT &&
        r1.report.prompt === r1.sent,
      `status=${continued.status}, notices=${noticeEvents(hist1).map((e) => e.event).join(",")}, priorPrompts=${JSON.stringify(r1.report.priorPrompts)}`,
    );

    // ---- 「繼續」:後端不支援 resume → 退回對話紀錄(仍然成功,說明據實);紀錄附在下一則訊息 ----
    const continuedPlain = (await c2.client.rpc("recovery.continue", { sessionId: plain }, 60_000)).session;
    const hist2 = await getHistory(c2.client, plain);
    const r2 = await report(c2.client, plain, "繼續之後(退回紀錄)");
    record(
      "C3 復原視圖「繼續」(後端不支援 resume):仍然成功回到 idle,系統說明據實(revivedFromTranscript),對話紀錄附在下一則訊息前面、DB 存原文",
      continuedPlain.status === "idle" &&
        noticeEvents(hist2).some((e) => e.event === "session.revivedFromTranscript") &&
        r2.report.prompt.startsWith(TRANSCRIPT_HEADER) &&
        r2.report.prompt.endsWith(`${NEW_MESSAGE_HEADER}\n${r2.sent}`) &&
        (await getHistory(c2.client, plain)).filter((m) => m.role === "user").at(-1).content === r2.sent,
      `status=${continuedPlain.status}, notices=${noticeEvents(hist2).map((e) => e.event).join(",")}`,
    );

    // ---- 不按「繼續」,直接在聊天框送訊息:interrupted 的 session 一樣自動復活 ----
    const sessionDirect = await getSession(c2.client, direct);
    const r3 = await report(c2.client, direct, "直接送出");
    const afterDirect = await getSession(c2.client, direct);
    record(
      "C4 interrupted 的 session 不經復原視圖、直接送訊息:自動復活並收到回覆(原生接回),狀態回到 idle 且 interruptedAt 清掉",
      sessionDirect?.status === "interrupted" &&
        r3.report.priorPrompts[0] === SECRET_PROMPT &&
        r3.report.prompt === r3.sent &&
        afterDirect?.status === "idle" &&
        afterDirect?.interruptedAt === undefined,
      `before=${sessionDirect?.status}, after=${afterDirect?.status}`,
    );
  } catch (err) {
    record("C 執行過程發生未預期錯誤", false, String(err?.stack ?? err));
  } finally {
    c1?.client.close();
    c2?.client.close();
    await killProcessTreeHard(c1?.proc);
    await killProcessTreeHard(c2?.proc);
    dirs.cleanup();
  }
}

// =======================================================================
// O:OpenCode(HTTP)——沿用既有 opencode session / 那邊的 session 已不在 → 新建 + 對話紀錄
// =======================================================================
async function openCodeScenario(tag, { forget }) {
  const dirs = newDirs(tag);
  let c1;
  let c2;
  const label = forget ? "O2(opencode 那邊的 session 已不在)" : "O1(沿用既有 opencode session)";
  try {
    c1 = await boot(dirs, { graceful: true });
    const sid = await createSession(c1.client, FAKE_OPENCODE, dirs.workspaceDir, `revive-${tag}`);
    await turn(c1.client, sid, SECRET_PROMPT);
    const before = await getSession(c1.client, sid);
    const pidsBefore = pidsOf(readCalls(dirs));
    c1.client.close();
    await gracefulShutdown(c1.proc);
    c1 = undefined;

    c2 = await boot(dirs, { graceful: true, extraEnv: forget ? { FAKE_OPENCODE_FORGET: "1" } : {} });
    const { sent, report: rep } = await report(c2.client, sid, "剛才的暗號是什麼?");
    const newCalls = callsSince(dirs, pidsBefore);
    const history = await getHistory(c2.client, sid);
    const events = noticeEvents(history);
    const after = await getSession(c2.client, sid);

    if (!forget) {
      record(
        `${label}:新的 opencode server 用 GET /session/{id} 確認它還在、沿用同一個 session(沒有 POST /session);server 原生記得先前的 prompt,收到的是原文`,
        JSON.stringify(callNames(newCalls)) === JSON.stringify(["GET /session/:id hit"]) &&
          rep.agentSessionId === before.backendSessionId &&
          rep.priorPrompts[0] === SECRET_PROMPT &&
          rep.prompt === sent &&
          JSON.stringify(events.map((e) => e.event)) === JSON.stringify(["session.revivedResumed"]) &&
          after?.backendSessionId === before.backendSessionId,
        `calls=${JSON.stringify(callNames(newCalls))}, events=${events.map((e) => e.event).join(",")}`,
      );
    } else {
      record(
        `${label}:GET /session/{id} 404 → 開新的 opencode session(POST /session)並退回對話紀錄;DB 存原文;後端識別碼更新成新的`,
        JSON.stringify(callNames(newCalls)) === JSON.stringify(["GET /session/:id miss", "POST /session"]) &&
          rep.priorPrompts.length === 0 &&
          rep.prompt.startsWith(TRANSCRIPT_HEADER) &&
          rep.prompt.includes(`使用者: ${SECRET_PROMPT}`) &&
          rep.prompt.endsWith(`${NEW_MESSAGE_HEADER}\n${sent}`) &&
          history.filter((m) => m.role === "user").at(-1).content === sent &&
          events.some((e) => e.event === "session.revivedFromTranscript") &&
          after?.backendSessionId === rep.agentSessionId &&
          rep.agentSessionId !== before.backendSessionId,
        `calls=${JSON.stringify(callNames(newCalls))}, events=${events.map((e) => e.event).join(",")}, prompt=${clip(rep.prompt, 200)}`,
      );
    }
  } catch (err) {
    record(`${label} 執行過程發生未預期錯誤`, false, String(err?.stack ?? err));
  } finally {
    c1?.client.close();
    c2?.client.close();
    await killProcessTreeHard(c1?.proc);
    await killProcessTreeHard(c2?.proc);
    dirs.cleanup();
  }
}

// =======================================================================
// P:PTY——重新啟動、不保留記憶、不把對話紀錄灌進終端
// =======================================================================
async function testPty() {
  const dirs = newDirs("pty");
  let c1;
  let c2;
  try {
    c1 = await boot(dirs, { graceful: true });
    const sid = await createSession(c1.client, FAKE_PTY, dirs.workspaceDir, "revive-pty");
    await c1.client.rpc("session.sendPrompt", { sessionId: sid, prompt: { text: "before-restart" } });
    await c1.client.waitFor(
      c1.client.events,
      (e) => e.sessionId === sid && e.event.type === "terminal-data" && e.event.data.includes("ECHO:before-restart"),
      15_000,
    );
    await waitStatus(c1.client, sid, "idle", 10_000);
    c1.client.close();
    await gracefulShutdown(c1.proc);
    c1 = undefined;

    c2 = await boot(dirs, { graceful: true });
    const closed = await getSession(c2.client, sid);
    const from = c2.client.events.length;
    await c2.client.rpc("session.sendPrompt", { sessionId: sid, prompt: { text: "after-restart" } }, 60_000);
    await c2.client.waitFor(
      c2.client.events,
      (e) => e.sessionId === sid && e.event.type === "terminal-data" && e.event.data.includes("ECHO:after-restart"),
      15_000,
      from,
    );
    const terminalText = c2.client.events
      .slice(from)
      .filter((e) => e.sessionId === sid && e.event.type === "terminal-data")
      .map((e) => e.event.data)
      .join("");
    const afterIdle = await waitStatus(c2.client, sid, "idle", 10_000);
    const history = await getHistory(c2.client, sid);
    record(
      "P PTY:closed 的終端 session 送訊息 → 重新啟動(新的終端程序、READY 再出現一次)並送達;系統說明 = revivedWithoutMemory;對話紀錄沒有被灌進終端(沒有 Deskmony 補充的說明、沒有舊訊息)",
      closed?.status === "closed" &&
        terminalText.includes("READY") &&
        terminalText.includes("ECHO:after-restart") &&
        !terminalText.includes("Deskmony") &&
        !terminalText.includes("before-restart") &&
        afterIdle.status === "idle" &&
        JSON.stringify(noticeEvents(history).map((e) => e.event)) === JSON.stringify(["session.revivedWithoutMemory"]),
      `status=${closed?.status}, notices=${noticeEvents(history).map((e) => e.event).join(",")}, terminal=${clip(JSON.stringify(terminalText), 200)}`,
    );
  } catch (err) {
    record("P 執行過程發生未預期錯誤", false, String(err?.stack ?? err));
  } finally {
    c1?.client.close();
    c2?.client.close();
    await killProcessTreeHard(c1?.proc);
    await killProcessTreeHard(c2?.proc);
    dirs.cleanup();
  }
}

// =======================================================================
// E:重新啟動失敗 → 明確錯誤、狀態還原(不卡 busy)、使用者訊息沒寫進去、之後修好還能用
// =======================================================================
async function testReviveFailure() {
  const dirs = newDirs("fail");
  let c1;
  let c2;
  let c3;
  try {
    c1 = await boot(dirs, { graceful: true });
    const sid = await createSession(c1.client, PROVIDER_RESUME, dirs.workspaceDir, "revive-fail");
    await turn(c1.client, sid, SECRET_PROMPT);
    c1.client.close();
    await gracefulShutdown(c1.proc);
    c1 = undefined;

    // core 重啟時,這個 provider 的執行檔指到一個不存在的腳本 → agent 一啟動就結束,initialize 失敗。
    const broken = [{ id: PROVIDER_RESUME, label: "broken", software: "acp", command: process.execPath, args: [path.join(dirs.workspaceDir, "does-not-exist.mjs")] }];
    c2 = await boot(dirs, { graceful: true, extraEnv: { DESKMONY_E2E_EXTRA_PROVIDERS: JSON.stringify(broken) } });
    const beforeHistory = await getHistory(c2.client, sid);
    const statusUpdatesFrom = c2.client.sessionUpdates.length;
    let errorCode;
    let errorMessage;
    try {
      await c2.client.rpc("session.sendPrompt", { sessionId: sid, prompt: { text: "這次應該送不出去" } }, 60_000);
    } catch (err) {
      errorCode = err.errorCode;
      errorMessage = err.message;
    }
    const afterFail = await getSession(c2.client, sid);
    const afterHistory = await getHistory(c2.client, sid);
    const sawBusy = c2.client.sessionUpdates.slice(statusUpdatesFrom).some((u) => u.id === sid && u.status === "busy");
    record(
      "E1 重新啟動失敗:sendPrompt 回明確錯誤(帶 errorCode);復活期間狀態曾顯示 busy,失敗後還原成 closed(不卡 busy、沒有殘留 lastError);使用者訊息與系統說明都沒有寫進 DB",
      typeof errorCode === "string" &&
        errorCode.length > 0 &&
        Boolean(errorMessage) &&
        sawBusy &&
        afterFail?.status === "closed" &&
        afterFail?.lastError === undefined &&
        afterHistory.length === beforeHistory.length,
      `errorCode=${errorCode}, message=${clip(errorMessage ?? "", 120)}, sawBusy=${sawBusy}, status=${afterFail?.status}, history ${beforeHistory.length}→${afterHistory.length}`,
    );
    c2.client.close();
    await gracefulShutdown(c2.proc);
    c2 = undefined;

    // 修好之後(正常的 provider)同一個 session 還能用——失敗沒有把它弄壞。
    c3 = await boot(dirs, { graceful: true });
    const { sent, report: rep } = await report(c3.client, sid, "修好之後");
    record(
      "E2 失敗沒有弄壞 session:換回正常的 provider 重啟後,同一個 session 再送訊息就成功復活(原生接回)",
      rep.priorPrompts[0] === SECRET_PROMPT && rep.prompt === sent,
      `priorPrompts=${JSON.stringify(rep.priorPrompts)}`,
    );
  } catch (err) {
    record("E 執行過程發生未預期錯誤", false, String(err?.stack ?? err));
  } finally {
    for (const c of [c1, c2, c3]) {
      c?.client.close();
      await killProcessTreeHard(c?.proc);
    }
    dirs.cleanup();
  }
}

// =======================================================================
// X:agent 用 send_to_session 傳給已關閉的 session → 維持明確報錯,不自動 spawn
// =======================================================================
async function testNetworkDoesNotRevive() {
  const dirs = newDirs("network");
  let c1;
  let c2;
  try {
    c1 = await boot(dirs, { graceful: true });
    const closedId = await createSession(c1.client, PROVIDER_RESUME, dirs.workspaceDir, "revive-network-closed");
    await turn(c1.client, closedId, SECRET_PROMPT);
    c1.client.close();
    await gracefulShutdown(c1.proc);
    c1 = undefined;

    c2 = await boot(dirs, { graceful: true });
    const callerId = await createSession(c2.client, FAKE_ACP, dirs.workspaceDir, "revive-network-caller");
    const pidsAfterCaller = pidsOf(readCalls(dirs));
    const { reply } = await turn(
      c2.client,
      callerId,
      `${CALL_BRIDGE_TOOL_PREFIX}${JSON.stringify({ tool: "send_to_session", args: { sessionId: closedId, message: "你好?" } })}`,
    );
    await sleep(500);
    const parsed = reply.startsWith("BRIDGE_TOOL_RESULT:") ? JSON.parse(reply.slice("BRIDGE_TOOL_RESULT:".length)) : undefined;
    const target = await getSession(c2.client, closedId);
    const targetHistory = await getHistory(c2.client, closedId);
    const newCalls = callsSince(dirs, pidsAfterCaller);
    record(
      "X agent 的 send_to_session 傳給 closed 的 session:維持明確錯誤(isError),目標仍是 closed、沒有新的 agent 行程被啟動、目標的對話沒有被寫入任何東西",
      parsed?.isError === true &&
        target?.status === "closed" &&
        newCalls.length === 0 &&
        targetHistory.length === 2,
      `isError=${parsed?.isError}, text=${clip(parsed?.content?.[0]?.text ?? reply, 140)}, targetStatus=${target?.status}, newCalls=${newCalls.length}, targetHistory=${targetHistory.length}`,
    );
  } catch (err) {
    record("X 執行過程發生未預期錯誤", false, String(err?.stack ?? err));
  } finally {
    c1?.client.close();
    c2?.client.close();
    await killProcessTreeHard(c1?.proc);
    await killProcessTreeHard(c2?.proc);
    dirs.cleanup();
  }
}

// =======================================================================
// K:Claude Agent SDK 的接回(探針,不需要登入)
// =======================================================================
async function testClaudeResumeProbe() {
  const dirs = newDirs("claude");
  try {
    const probe = spawnSync(
      process.execPath,
      [
        path.join(REPO_ROOT, "scripts", "probe-claude-sdk-resume.mjs"),
        path.join(REPO_ROOT, "packages", "adapters", "dist", "index.js"),
        path.join(dirs.workspaceDir, "claude-ws"),
        path.join(dirs.homeDir, "claude-config"),
      ],
      { encoding: "utf8", timeout: 90_000 },
    );
    const line = (probe.stdout ?? "").split(/\r?\n/).find((l) => l.startsWith("PROBE_RESULT:"));
    if (!line) throw new Error(`探針沒有輸出結果: ${clip(probe.stderr ?? "", 300)}`);
    const result = JSON.parse(line.slice("PROBE_RESULT:".length));
    record(
      "K Claude SDK:後端對話檔還在 → spawn 帶 --resume=<id>、handle.resumed=true;對話檔不在 → 不帶 --resume(不讓 CLI 在第一則訊息才報錯)、resumed=false;沒有後端識別碼 → 不帶 --resume;三種情況 handle.id 都沿用 Deskmony session id",
      result.existing.resumeArg === result.sessionId &&
        result.existing.resumed === true &&
        result.existing.handleId === "deskmony-session-A" &&
        result.missing.resumeArg === null &&
        result.missing.resumed === false &&
        result.missing.handleId === "deskmony-session-B" &&
        result.noBackendId.resumeArg === null &&
        result.noBackendId.handleId === "deskmony-session-C" &&
        [result.existing, result.missing, result.noBackendId].every((r) => r.spawnObserved),
      JSON.stringify(result),
    );
  } catch (err) {
    record("K 執行過程發生未預期錯誤", false, String(err?.stack ?? err));
  } finally {
    dirs.cleanup();
  }
}

// =======================================================================
// 可以只跑名稱含這些片段的 scenario:node scripts/e2e-session-revive.mjs load double
const filters = process.argv.slice(2);
const scenarios = [
  ["resume", () => testResume()],
  ["load", () => testLoadReplay()],
  ["fallback-none", () => transcriptFallbackScenario("none", FAKE_ACP, undefined)],
  ["fallback-resume-forget", () => transcriptFallbackScenario("resume-forget", PROVIDER_RESUME_FORGET, "session/resume")],
  ["fallback-load-forget", () => transcriptFallbackScenario("load-forget", PROVIDER_LOAD_FORGET, "session/load")],
  ["double", () => testDoubleSend()],
  ["continue", () => testRecoveryContinue()],
  ["opencode-resume", () => openCodeScenario("opencode-resume", { forget: false })],
  ["opencode-forget", () => openCodeScenario("opencode-forget", { forget: true })],
  ["pty", () => testPty()],
  ["failure", () => testReviveFailure()],
  ["network", () => testNetworkDoesNotRevive()],
  ["claude", () => testClaudeResumeProbe()],
];
for (const [name, run] of scenarios) {
  if (filters.length === 0 || filters.some((f) => name.includes(f))) await run();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${"=".repeat(70)}\n總結:${results.length - failed.length}/${results.length} 通過`);
if (failed.length > 0) {
  console.log("失敗項目:");
  for (const f of failed) console.log(`  - ${f.name}`);
}
process.exit(failed.length > 0 ? 1 : 0);
