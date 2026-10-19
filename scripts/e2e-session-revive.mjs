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
 *   M   model / 思考程度跟著復活(與 fix/codex-model-effort 整合,見 fake-acp-agent.mjs 的 `--config-options`):重啟前用
 *       `session.setModel` / `setEffort` 換成非預設值 → 正常關閉 → 重啟 → 送訊息復活後,`Session.options` 回來(純記憶體,重啟後
 *       復活前是空的)、目前值還是重啟前選的值;fake agent 重啟後一律回到預設設定(模擬真實 agent 不記得),所以這證明的是 Deskmony
 *       自己把記住的選擇重新套用(`session/set_config_option` 真的被呼叫)。涵蓋 ACP resume / load / 退回新對話,以及 OpenCode
 *       (沿用既有 opencode session、opencode 那邊 session 已不在)——OpenCode 靠回覆前面的 `[model:…] [variant:…]` 標記斷言 wire 上真的帶了。
 *   K   Claude Agent SDK:本機沒登入也能驗(spawn 攔截探針,見 probe-claude-sdk-resume.mjs)——對話檔還在才帶 `--resume=<id>`、
 *       不在就開全新對話並回報 `resumed:false`、handle.id 沿用 Deskmony session id。
 *   S   core 沒重啟、**agent 行程自己結束**(在 core 執行中直接殺掉假後端的行程,pid 取自 calls.log):修正前 runtime 留著已死的
 *       handle,人類訊息送進死掉的 adapter 就消失了、session 卡在 busy/idle。現在事件串流結束時 core 收掉 runtime(session 轉 error、
 *       留 `session.agentStopped` 說明),下一則人類訊息走同一個 respawnRuntime() 自動重新啟動:
 *         S1-S4 ACP(支援 resume)閒置時被殺 → error + 說明、不自己重啟;send_to_session 仍然報錯、不喚醒;送訊息 → 只 spawn 一個
 *               新行程、session/resume 接回、agent 原生記得;之後的訊息直接送給同一個 agent(不重複 spawn)。
 *         S5-S6 ACP(不支援接回)回合進行中(busy)被殺 → 不卡 busy;連按兩次送出只 spawn 一次、退回對話紀錄、兩則都有回覆。
 *         S7    OpenCode:server 行程被殺 → 送訊息後重新啟動 server、沿用同一個 opencode session。
 *         S8    Claude Agent SDK(探針,見 probe-claude-sdk-exit.mjs):CLI 子行程以非 0 結束時 adapter 的事件串流送出 error 並結束
 *               (修正前永遠不結束,core 偵測不到)。
 *   S9-S12 agent 在等使用者回覆(waiting)時不在了:修正前 PermissionGateway 的待決項目(連同逾時計時器)與 UI 的彈窗永遠不會
 *       被清掉,按「允許/拒絕」也沒反應(`resolvePermission()` 找不到 runtime 直接 return)、client 收不到 permission-resolved。
 *         S9-S10 ACP 權限請求等回覆時行程被殺 → permission-resolved(deny、source=agent-stopped);復活後對舊請求按允許沒有作用、
 *               等過舊請求的逾時時間也沒有逾時推播(計時器清掉了)。
 *         S11   OpenCode 提問(user-dialog-request,不經過 PermissionGateway)等回答時 server 被殺 → user-dialog-resolved(cancelled)。
 *         S12   等權限回覆時刪除 session → 同樣收到 permission-resolved(agent-stopped)。
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
  REPORT_CONFIG_PREFIX,
  REVIVE_REPORT_MARKER,
  SLEEP_TURN_PREFIX,
  WRITE_FILE_PREFIX,
} from "./fake-acp-agent.mjs";
import { QUESTION_PREFIX } from "./fake-opencode-server.mjs";
import { requireFreshBuild } from "./lib/require-fresh-build.mjs";
import { e2eProvidersEnv, fakeOpencodeVariantsProvider, FAKE_ACP, FAKE_OPENCODE, FAKE_OPENCODE_VARIANTS, FAKE_PTY } from "./lib/e2e-providers.mjs";

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
/** 會回報 configOptions 的 fake ACP(model / 思考程度可選,同 e2e-providers.mjs 的 fakeAcpOptionsProvider)+ 接回旗標。 */
function acpOptionsProvider(id, flags) {
  return { ...acpProvider(id, ["--config-options", ...flags]), supportsModelSelection: true, supportsEffortSelection: true, optionsAfterStart: true };
}
const PROVIDER_OPT_RESUME = "e2e-fake-acp-opt-resume";
const PROVIDER_OPT_LOAD = "e2e-fake-acp-opt-load";
const PROVIDER_OPT_NEW = "e2e-fake-acp-opt-new";
const EXTRA_PROVIDERS = [
  acpProvider(PROVIDER_RESUME, ["--resume"]),
  acpProvider(PROVIDER_LOAD, ["--load"]),
  acpProvider(PROVIDER_RESUME_FORGET, ["--resume", "--forget"]),
  acpProvider(PROVIDER_LOAD_FORGET, ["--load", "--forget"]),
  acpOptionsProvider(PROVIDER_OPT_RESUME, ["--resume"]),
  acpOptionsProvider(PROVIDER_OPT_LOAD, ["--load"]),
  acpOptionsProvider(PROVIDER_OPT_NEW, []),
  fakeOpencodeVariantsProvider(),
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
    this.sessionMessages = [];
    this.permissionResolved = [];
    this.userDialogResolved = [];
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
      else if (msg.channel === "session-message") this.sessionMessages.push(msg.payload);
      else if (msg.channel === "permission-resolved") this.permissionResolved.push(msg.payload);
      else if (msg.channel === "user-dialog-resolved") this.userDialogResolved.push(msg.payload);
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
// M:model / 思考程度跟著復活
// =======================================================================
const WANT_MODEL = "fake/gamma"; // 預設是 fake/beta(思考程度 low/high);gamma 的思考程度是 minimal/medium/max
const WANT_EFFORT = "max";

async function waitSession(client, sessionId, predicate, timeoutMs = 15_000) {
  const start = Date.now();
  for (;;) {
    const s = await getSession(client, sessionId);
    if (s && predicate(s)) return s;
    if (Date.now() - start > timeoutMs) return s; // 讓呼叫端的斷言失敗並印出目前狀態,而不是在這裡丟一個沒有內容的逾時
    await sleep(100);
  }
}

/** ACP:重啟前換成非預設的 model + 思考程度 → 正常關閉 → 重啟 → 送訊息復活 → 選擇還在,且 fake agent 真的被重新設定。 */
async function acpOptionsScenario(tag, providerId, expectedRestoreCalls) {
  const dirs = newDirs(tag);
  let c1;
  let c2;
  const label = `M-${tag}`;
  try {
    c1 = await boot(dirs, { graceful: true });
    const sid = await createSession(c1.client, providerId, dirs.workspaceDir, `revive-${tag}`);
    const initial = await waitSession(c1.client, sid, (s) => s.options?.model);
    await c1.client.rpc("session.setModel", { sessionId: sid, model: WANT_MODEL });
    await waitSession(c1.client, sid, (s) => s.options?.model?.current === WANT_MODEL);
    await c1.client.rpc("session.setEffort", { sessionId: sid, effort: WANT_EFFORT });
    const before = await waitSession(c1.client, sid, (s) => s.options?.effort?.current === WANT_EFFORT);
    await turn(c1.client, sid, SECRET_PROMPT);
    const pidsBefore = pidsOf(readCalls(dirs));
    c1.client.close();
    await gracefulShutdown(c1.proc);
    c1 = undefined;

    c2 = await boot(dirs, { graceful: true });
    const closed = await getSession(c2.client, sid);
    record(
      `${label}-1 重啟前:預設是 fake/beta,換成 ${WANT_MODEL} / ${WANT_EFFORT} 後 Session.options 與 model/effort 都是新值;重啟後復活前 session 是 closed、options 是空的(純記憶體),model/effort 仍是存下來的值`,
      initial?.options?.model?.current === "fake/beta" &&
        before?.options?.model?.current === WANT_MODEL && before?.model === WANT_MODEL && before?.effort === WANT_EFFORT &&
        closed?.status === "closed" && closed?.options === undefined && closed?.model === WANT_MODEL && closed?.effort === WANT_EFFORT,
      `initial=${initial?.options?.model?.current}, before=${before?.model}/${before?.effort}, closed=${JSON.stringify({ status: closed?.status, options: closed?.options, model: closed?.model, effort: closed?.effort })}`,
    );

    const { sent, report: rep } = await report(c2.client, sid, "復活後");
    const revived = await waitSession(c2.client, sid, (s) => s.options?.model?.current === WANT_MODEL && s.options?.effort?.current === WANT_EFFORT);
    const newCalls = callsSince(dirs, pidsBefore);
    const agentCfg = JSON.parse((await turn(c2.client, sid, REPORT_CONFIG_PREFIX)).reply.replace(/^CONFIG:/, ""));
    const optionValues = (opt) => opt?.choices?.map((c) => c.value) ?? [];
    record(
      `${label}-2 復活後 Session.options 存在,目前 model/思考程度 = 重啟前設定的值,選項清單是該 model 的(minimal/medium/max),選的值也寫回 session.model/effort;走的路 = ${expectedRestoreCalls.join(" → ")}`,
      JSON.stringify(callNames(newCalls)) === JSON.stringify(expectedRestoreCalls) &&
        revived?.options?.model?.current === WANT_MODEL &&
        revived?.options?.effort?.current === WANT_EFFORT &&
        JSON.stringify(optionValues(revived?.options?.effort)) === JSON.stringify(["minimal", "medium", "max"]) &&
        revived?.model === WANT_MODEL && revived?.effort === WANT_EFFORT &&
        rep.prompt.includes(sent),
      `calls=${JSON.stringify(callNames(newCalls))}, options=${JSON.stringify({ model: revived?.options?.model?.current, effort: revived?.options?.effort?.current })}, session=${revived?.model}/${revived?.effort}`,
    );
    record(
      `${label}-3 這是 Deskmony 重新套用的,不是 agent 記得:fake agent 重啟後回到預設(fake/beta),agent 端實際的設定是被 session/set_config_option 改成記住的值(model 先、思考程度後)`,
      agentCfg?.model === WANT_MODEL && agentCfg?.effort === WANT_EFFORT &&
        JSON.stringify(agentCfg?.setCalls?.map((c) => [c.configId, c.value])) === JSON.stringify([["llm", WANT_MODEL], ["think", WANT_EFFORT]]),
      `agent=${JSON.stringify(agentCfg)}`,
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

/** OpenCode(HTTP):model 與思考程度(variant)隨每則訊息送出——復活後第一則訊息的 wire 上就要帶記住的值。 */
async function opencodeOptionsScenario(tag, { forget }) {
  const dirs = newDirs(tag);
  let c1;
  let c2;
  const label = `M-${tag}`;
  try {
    c1 = await boot(dirs, { graceful: true });
    const sid = await createSession(c1.client, FAKE_OPENCODE_VARIANTS, dirs.workspaceDir, `revive-${tag}`);
    await c1.client.rpc("session.setModel", { sessionId: sid, model: "fake/model-b" });
    await c1.client.rpc("session.setEffort", { sessionId: sid, effort: "high" });
    const before = await waitSession(c1.client, sid, (s) => s.options?.effort?.current === "high");
    const first = await turn(c1.client, sid, SECRET_PROMPT);
    const pidsBefore = pidsOf(readCalls(dirs));
    c1.client.close();
    await gracefulShutdown(c1.proc);
    c1 = undefined;

    c2 = await boot(dirs, { graceful: true, extraEnv: forget ? { FAKE_OPENCODE_FORGET: "1" } : {} });
    const closed = await getSession(c2.client, sid);
    const second = await turn(c2.client, sid, "復活後的普通訊息");
    const revived = await waitSession(c2.client, sid, (s) => s.options?.effort?.current === "high");
    const newCalls = callsSince(dirs, pidsBefore);
    const expectedCalls = forget ? ["GET /session/:id miss", "POST /session"] : ["GET /session/:id hit"];
    record(
      `${label} OpenCode${forget ? "(opencode 那邊的 session 已不在 → 新建 + 對話紀錄)" : "(沿用既有 opencode session)"}:重啟前 model-b / high 的 wire 標記;復活前 options 為空;復活後第一則訊息的 wire 上帶 [model:fake/model-b] [variant:high]、Session.options 的目前思考程度是 high、model/effort 沒被重設`,
      first.reply.startsWith("[model:fake/model-b] [variant:high] ") &&
        before?.model === "fake/model-b" &&
        closed?.status === "closed" && closed?.options === undefined && closed?.effort === "high" &&
        JSON.stringify(callNames(newCalls)) === JSON.stringify(expectedCalls) &&
        second.reply.startsWith("[model:fake/model-b] [variant:high] ") &&
        revived?.options?.effort?.current === "high" &&
        JSON.stringify(revived?.options?.effort?.choices?.map((c) => c.value)) === JSON.stringify(["low", "high"]) &&
        revived?.model === "fake/model-b" && revived?.effort === "high",
      `first=${clip(first.reply, 60)}, second=${clip(second.reply, 60)}, calls=${JSON.stringify(callNames(newCalls))}, closed=${JSON.stringify({ status: closed?.status, options: closed?.options, effort: closed?.effort })}, revived=${JSON.stringify({ model: revived?.model, effort: revived?.effort, options: revived?.options })}`,
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
      "K Claude SDK:後端對話檔還在 → spawn 帶 --resume=<id>、handle.resumed=true;對話檔不在 → 不帶 --resume(不讓 CLI 在第一則訊息才報錯)、resumed=false;沒有後端識別碼 → 不帶 --resume;三種情況 handle.id 都沿用 Deskmony session id,命令列都保留 session 的 --model / --effort",
      result.existing.resumeArg === result.sessionId &&
        result.existing.resumed === true &&
        result.existing.handleId === "deskmony-session-A" &&
        result.missing.resumeArg === null &&
        result.missing.resumed === false &&
        result.missing.handleId === "deskmony-session-B" &&
        result.noBackendId.resumeArg === null &&
        result.noBackendId.handleId === "deskmony-session-C" &&
        [result.existing, result.missing, result.noBackendId].every((r) => r.spawnObserved) &&
        // 復活保留 session 記住的 model / 思考程度(三種情況命令列都帶著)。
        [result.existing, result.missing, result.noBackendId].every((r) => r.modelArg === "sonnet" && r.effortArg === "high"),
      JSON.stringify(result),
    );
  } catch (err) {
    record("K 執行過程發生未預期錯誤", false, String(err?.stack ?? err));
  } finally {
    dirs.cleanup();
  }
}

// =======================================================================
// S:core 沒重啟、agent 行程自己結束(崩潰/被殺)→ 下一則人類訊息自動重新啟動
// =======================================================================
/** 在 core 執行中殺掉一個 agent 行程(模擬崩潰/被殺)——只殺這個 pid 底下的行程樹,絕不碰 core。 */
function killAgentProcess(pid) {
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
  else process.kill(pid, "SIGKILL");
}

/** calls.log 裡唯一的 agent 行程 pid(scenario 到這裡只建了一個 session)。 */
function onlyAgentPid(dirs) {
  const pids = [...pidsOf(readCalls(dirs))];
  if (pids.length !== 1) throw new Error(`預期只有一個 agent 行程,calls.log 有 ${pids.length} 個: ${pids.join(",")}`);
  return pids[0];
}

/** 系統說明的 event 名稱,不含 adapter 自己回報的錯誤(`session.adapterError`——子行程 exit 與連線關閉誰先到不固定,有沒有那一則不一定)。 */
function noticesWithoutAdapterErrors(messages) {
  return noticeEvents(messages)
    .map((e) => e.event)
    .filter((event) => event !== "session.adapterError");
}

/** agent 行程被殺之後:等 session 轉成 error,並確認「agent 已停止」說明有寫進 DB、也即時推給 client。 */
async function waitAgentStopped(client, sessionId, pushFrom) {
  const stopped = await waitStatus(client, sessionId, "error", 15_000);
  const history = await getHistory(client, sessionId);
  const pushed = client.sessionMessages
    .slice(pushFrom)
    .some((p) => p.sessionId === sessionId && p.message.role === "system" && p.message.content.includes("session.agentStopped"));
  return { stopped, history, pushed };
}

async function testAgentCrashWhileIdle() {
  const dirs = newDirs("crash-idle");
  let c;
  try {
    c = await boot(dirs);
    const sid = await createSession(c.client, PROVIDER_RESUME, dirs.workspaceDir, "revive-crash-idle");
    await turn(c.client, sid, SECRET_PROMPT);
    const before = await waitStatus(c.client, sid, "idle", 10_000);
    const agentPid = onlyAgentPid(dirs);
    const pidsBefore = pidsOf(readCalls(dirs));
    const pushFrom = c.client.sessionMessages.length;

    killAgentProcess(agentPid);
    const { stopped, history: stoppedHistory, pushed } = await waitAgentStopped(c.client, sid, pushFrom);
    await sleep(800); // 給「不該發生的自動重啟」一點時間現形
    const stoppedNotices = noticesWithoutAdapterErrors(stoppedHistory);
    record(
      "S1 core 執行中 agent 行程(閒置時)被殺:session 轉成 error、對話裡留一則 session.agentStopped 說明(寫進 DB 也即時推給 client);沒有任何東西自己把 agent 重新啟動",
      stopped.status === "error" &&
        JSON.stringify(stoppedNotices) === JSON.stringify(["session.agentStopped"]) &&
        pushed &&
        callsSince(dirs, pidsBefore).length === 0,
      `status=${stopped.status}, notices=${noticeEvents(stoppedHistory).map((e) => e.event).join(",")}, pushed=${pushed}, newCalls=${callsSince(dirs, pidsBefore).length}`,
    );

    // ---- 跨 session 的 send_to_session 仍然不能喚醒它 ----
    const callerId = await createSession(c.client, FAKE_ACP, dirs.workspaceDir, "revive-crash-caller");
    const pidsWithCaller = pidsOf(readCalls(dirs));
    const targetHistoryLength = (await getHistory(c.client, sid)).length;
    const { reply } = await turn(
      c.client,
      callerId,
      `${CALL_BRIDGE_TOOL_PREFIX}${JSON.stringify({ tool: "send_to_session", args: { sessionId: sid, message: "你還在嗎?" } })}`,
    );
    await sleep(500);
    const parsed = reply.startsWith("BRIDGE_TOOL_RESULT:") ? JSON.parse(reply.slice("BRIDGE_TOOL_RESULT:".length)) : undefined;
    const targetAfterNetwork = await getSession(c.client, sid);
    const targetHistoryAfterNetwork = await getHistory(c.client, sid);
    record(
      "S2 別的 agent 用 send_to_session 傳給 agent 已停止的 session:明確錯誤(isError)、目標仍是 error、沒有啟動任何新的 agent 行程、目標的對話沒有被寫入",
      parsed?.isError === true &&
        targetAfterNetwork?.status === "error" &&
        callsSince(dirs, pidsWithCaller).length === 0 &&
        targetHistoryAfterNetwork.length === targetHistoryLength,
      `isError=${parsed?.isError}, text=${clip(parsed?.content?.[0]?.text ?? reply, 140)}, status=${targetAfterNetwork?.status}, newCalls=${callsSince(dirs, pidsWithCaller).length}, history ${targetHistoryLength}→${targetHistoryAfterNetwork.length}`,
    );

    // ---- 人類直接送訊息:自動重新啟動並回覆 ----
    const { sent, report: rep } = await report(c.client, sid, "崩潰之後你還記得什麼?");
    const newCalls = callsSince(dirs, pidsWithCaller);
    record(
      "S3 同一個 session 直接送訊息 → 自動重新啟動並收到回覆:只啟動一個新 agent 行程,走 session/resume 接回崩潰前的 ACP session(掛上 session 網路 MCP server);agent 原生記得崩潰前的 prompt,收到的是原文",
      JSON.stringify(callNames(newCalls)) === JSON.stringify(["initialize", "session/resume"]) &&
        pidsOf(newCalls).size === 1 &&
        newCalls[1].sessionId === before.backendSessionId &&
        newCalls[1].mcpServers === 1 &&
        rep.agentSessionId === before.backendSessionId &&
        rep.priorPrompts.length === 1 &&
        rep.priorPrompts[0] === SECRET_PROMPT &&
        rep.prompt === sent,
      `calls=${JSON.stringify(newCalls)}, priorPrompts=${JSON.stringify(rep.priorPrompts)}, promptIsOriginal=${rep.prompt === sent}`,
    );

    const history = await getHistory(c.client, sid);
    const sentIndex = history.findIndex((m) => m.role === "user" && m.content === sent);
    const stoppedIndex = history.findIndex((m) => m.role === "system" && m.content.includes("session.agentStopped"));
    const tail = history.slice(sentIndex).map((m) => (m.role === "system" ? JSON.parse(m.content).event : m.role));
    const after = await getSession(c.client, sid);
    const pidsAfterRevive = pidsOf(readCalls(dirs));
    const second = await report(c.client, sid, "再問一次");
    record(
      "S4 對話順序 = 「agent 已停止」說明 → 使用者新訊息 → session.revivedResumed → agent 回覆;復活後 idle、權限重設 always-ask、後端識別碼不變;下一則訊息直接送給同一個 agent(沒有再 spawn),它記得前兩則",
      stoppedIndex >= 0 &&
        stoppedIndex < sentIndex &&
        JSON.stringify(tail) === JSON.stringify(["user", "session.revivedResumed", "assistant"]) &&
        after?.status === "idle" &&
        after?.permissionMode === "always-ask" &&
        after?.backendSessionId === before.backendSessionId &&
        callsSince(dirs, pidsAfterRevive).length === 0 &&
        second.report.agentSessionId === before.backendSessionId &&
        JSON.stringify(second.report.priorPrompts) === JSON.stringify([SECRET_PROMPT, sent]),
      `tail=${tail.join(",")}, status=${after?.status}, permissionMode=${after?.permissionMode}, callsAfterRevive=${callsSince(dirs, pidsAfterRevive).length}, priorPrompts=${JSON.stringify(second.report.priorPrompts.map((p) => clip(p, 30)))}`,
    );
  } catch (err) {
    record("S1-S4 執行過程發生未預期錯誤", false, String(err?.stack ?? err));
  } finally {
    c?.client.close();
    await killProcessTreeHard(c?.proc);
    dirs.cleanup();
  }
}

async function testAgentCrashMidTurn() {
  const dirs = newDirs("crash-busy");
  let c;
  try {
    c = await boot(dirs);
    const sid = await createSession(c.client, FAKE_ACP, dirs.workspaceDir, "revive-crash-busy");
    await turn(c.client, sid, SECRET_PROMPT);
    const agentPid = onlyAgentPid(dirs);
    const pidsBefore = pidsOf(readCalls(dirs));
    const sleepPrompt = `${SLEEP_TURN_PREFIX}${JSON.stringify({ ms: 60_000 })}`;
    await c.client.rpc("session.sendPrompt", { sessionId: sid, prompt: { text: sleepPrompt } });
    const busy = await waitStatus(c.client, sid, "busy", 10_000);
    const pushFrom = c.client.sessionMessages.length;

    killAgentProcess(agentPid);
    const { stopped, history: stoppedHistory, pushed } = await waitAgentStopped(c.client, sid, pushFrom);
    record(
      "S5 回合進行中(busy)agent 行程被殺:session 不會卡在 busy——轉成 error 並留下 session.agentStopped 說明",
      busy.status === "busy" &&
        stopped.status === "error" &&
        JSON.stringify(noticesWithoutAdapterErrors(stoppedHistory)) === JSON.stringify(["session.agentStopped"]) &&
        pushed,
      `busy=${busy.status}, status=${stopped.status}, notices=${noticeEvents(stoppedHistory).map((e) => e.event).join(",")}, pushed=${pushed}`,
    );

    // ---- 崩潰後連按兩次送出:只重新啟動一次 ----
    const from = c.client.events.length;
    const settled = await Promise.allSettled([
      c.client.rpc("session.sendPrompt", { sessionId: sid, prompt: { text: "崩潰後連按一" } }, 60_000),
      c.client.rpc("session.sendPrompt", { sessionId: sid, prompt: { text: "崩潰後連按二" } }, 60_000),
    ]);
    const start = Date.now();
    while (c.client.events.slice(from).filter((e) => e.sessionId === sid && e.event.type === "completed").length < 2) {
      if (Date.now() - start > 60_000) throw new Error("崩潰後的兩輪沒有都結束");
      await sleep(80);
    }
    const after = await waitStatus(c.client, sid, "idle", 10_000);
    const newCalls = callsSince(dirs, pidsBefore);
    const history = await getHistory(c.client, sid);
    const userMessages = history.filter((m) => m.role === "user").map((m) => m.content);
    const notices = noticesWithoutAdapterErrors(history);
    record(
      "S6 崩潰後連按兩次送出:兩次都成功、只啟動一個新 agent 行程(1 次 initialize、1 次 session/new——不支援接回的 agent 退回對話紀錄)、說明 = agentStopped → revivedFromTranscript(只有一則復活說明)、兩則都得到回覆,最後回到 idle",
      settled.every((r) => r.status === "fulfilled") &&
        JSON.stringify(callNames(newCalls)) === JSON.stringify(["initialize", "session/new"]) &&
        pidsOf(newCalls).size === 1 &&
        JSON.stringify(notices) === JSON.stringify(["session.agentStopped", "session.revivedFromTranscript"]) &&
        JSON.stringify(userMessages) === JSON.stringify([SECRET_PROMPT, sleepPrompt, "崩潰後連按一", "崩潰後連按二"]) &&
        after.status === "idle",
      `settled=${settled.map((r) => r.status).join(",")}, calls=${JSON.stringify(callNames(newCalls))}, notices=${notices.join(",")}, users=${userMessages.length}, status=${after.status}`,
    );
  } catch (err) {
    record("S5-S6 執行過程發生未預期錯誤", false, String(err?.stack ?? err));
  } finally {
    c?.client.close();
    await killProcessTreeHard(c?.proc);
    dirs.cleanup();
  }
}

async function testOpencodeServerCrash() {
  const dirs = newDirs("crash-opencode");
  let c;
  try {
    c = await boot(dirs);
    const sid = await createSession(c.client, FAKE_OPENCODE, dirs.workspaceDir, "revive-crash-opencode");
    await turn(c.client, sid, SECRET_PROMPT);
    const before = await waitStatus(c.client, sid, "idle", 10_000);
    const serverPid = onlyAgentPid(dirs);
    const pidsBefore = pidsOf(readCalls(dirs));
    const pushFrom = c.client.sessionMessages.length;

    killAgentProcess(serverPid);
    const { stopped, pushed } = await waitAgentStopped(c.client, sid, pushFrom);
    const { sent, report: rep } = await report(c.client, sid, "server 重啟之後還記得嗎?");
    const newCalls = callsSince(dirs, pidsBefore);
    const history = await getHistory(c.client, sid);
    const notices = noticesWithoutAdapterErrors(history);
    const after = await getSession(c.client, sid);
    record(
      "S7 OpenCode:server 行程在 core 執行中被殺 → error + agentStopped 說明;送訊息 → 重新啟動一個 server、用 GET /session/{id} 沿用同一個 opencode session(沒有 POST /session),server 原生記得、收到原文;說明 = agentStopped → revivedResumed;回到 idle",
      stopped.status === "error" &&
        pushed &&
        JSON.stringify(callNames(newCalls)) === JSON.stringify(["GET /session/:id hit"]) &&
        pidsOf(newCalls).size === 1 &&
        rep.agentSessionId === before.backendSessionId &&
        rep.priorPrompts[0] === SECRET_PROMPT &&
        rep.prompt === sent &&
        JSON.stringify(notices) === JSON.stringify(["session.agentStopped", "session.revivedResumed"]) &&
        after?.status === "idle" &&
        after?.backendSessionId === before.backendSessionId,
      `status=${stopped.status}, calls=${JSON.stringify(callNames(newCalls))}, notices=${notices.join(",")}, priorPrompts=${JSON.stringify(rep.priorPrompts)}, after=${after?.status}`,
    );
  } catch (err) {
    record("S7 執行過程發生未預期錯誤", false, String(err?.stack ?? err));
  } finally {
    c?.client.close();
    await killProcessTreeHard(c?.proc);
    dirs.cleanup();
  }
}

async function testClaudeExitProbe() {
  const dirs = newDirs("claude-exit");
  try {
    const probe = spawnSync(
      process.execPath,
      [
        path.join(REPO_ROOT, "scripts", "probe-claude-sdk-exit.mjs"),
        path.join(REPO_ROOT, "packages", "adapters", "dist", "index.js"),
        path.join(dirs.workspaceDir, "claude-ws"),
        path.join(dirs.homeDir, "claude-config"),
      ],
      { encoding: "utf8", timeout: 60_000 },
    );
    const line = (probe.stdout ?? "").split(/\r?\n/).find((l) => l.startsWith("PROBE_RESULT:"));
    if (!line) throw new Error(`探針沒有輸出結果: ${clip(probe.stderr ?? "", 300)}`);
    const result = JSON.parse(line.slice("PROBE_RESULT:".length));
    const error = result.events.find((e) => e.type === "error");
    record(
      "S8 Claude SDK:CLI 子行程以非 0 結束時,adapter 的事件串流送出 error(帶 SDK 的「exited with code 1」)並結束——core 才偵測得到 agent 已停止(修正前串流永遠不結束)",
      result.spawnObserved === true && result.ended === true && typeof error?.detail === "string" && error.detail.includes("exited with code 1"),
      JSON.stringify(result),
    );
  } catch (err) {
    record("S8 執行過程發生未預期錯誤", false, String(err?.stack ?? err));
  } finally {
    dirs.cleanup();
  }
}

// =======================================================================
// S9-S12:agent 在等使用者回覆(waiting)時不在了 → 待決的權限請求 / 提問一起收掉
// =======================================================================
/** S9/S10 的權限逾時(attended)。夠長,不會在殺掉 agent 之前先觸發;S10 會等過這個時間,確認舊請求的計時器真的清掉了。 */
const WAITING_PERMISSION_TIMEOUT_MS = 12_000;

/** 讓 fake ACP agent 對工作目錄裡的一個檔案發出寫檔權限請求,等到 core 廣播 permission-request、session 進入 waiting。 */
async function askWritePermission(client, sessionId, targetPath) {
  const from = client.events.length;
  const posixPath = targetPath.split(path.sep).join("/");
  await client.rpc("session.sendPrompt", {
    sessionId,
    prompt: { text: `${WRITE_FILE_PREFIX}${JSON.stringify({ path: posixPath, content: "should never be written" })}` },
  });
  const request = await client.waitFor(client.events, (e) => e.sessionId === sessionId && e.event.type === "permission-request", 15_000, from);
  const waiting = await waitStatus(client, sessionId, "waiting", 10_000);
  return { requestId: request.event.requestId, waiting };
}

const resolvedPushesFor = (client, sessionId, requestId) =>
  client.permissionResolved.filter((p) => p.sessionId === sessionId && p.requestId === requestId);

async function testAgentCrashWhileWaitingPermission() {
  const dirs = newDirs("crash-waiting");
  let c;
  try {
    c = await boot(dirs, { extraEnv: { DESKMONY_PERMISSION_TIMEOUT_MS: String(WAITING_PERMISSION_TIMEOUT_MS) } });
    const sid = await createSession(c.client, FAKE_ACP, dirs.workspaceDir, "revive-crash-waiting");
    await turn(c.client, sid, SECRET_PROMPT);
    const agentPid = onlyAgentPid(dirs);
    const pidsBefore = pidsOf(readCalls(dirs));
    const target = path.join(dirs.workspaceDir, "crash-waiting.txt");
    const { requestId, waiting } = await askWritePermission(c.client, sid, target);
    const requestedAt = Date.now();
    const resolvedFrom = c.client.permissionResolved.length;
    const pushFrom = c.client.sessionMessages.length;

    killAgentProcess(agentPid);
    const resolved = await c.client.waitFor(
      c.client.permissionResolved,
      (p) => p.sessionId === sid && p.requestId === requestId,
      15_000,
      resolvedFrom,
    );
    const resolvedAfterMs = Date.now() - requestedAt;
    const { stopped, history: stoppedHistory, pushed } = await waitAgentStopped(c.client, sid, pushFrom);
    record(
      "S9 agent 在等權限回覆(waiting)時行程被殺:所有 client 收到這筆請求的 permission-resolved(deny、source=agent-stopped)關閉彈窗;session 轉 error 並留下 session.agentStopped 說明;檔案沒有被寫入",
      waiting.status === "waiting" &&
        resolved.decision === "deny" &&
        resolved.source === "agent-stopped" &&
        resolvedAfterMs < WAITING_PERMISSION_TIMEOUT_MS &&
        stopped.status === "error" &&
        JSON.stringify(noticesWithoutAdapterErrors(stoppedHistory)) === JSON.stringify(["session.agentStopped"]) &&
        pushed &&
        !existsSync(target),
      `waiting=${waiting.status}, resolved=${JSON.stringify(resolved)} (${resolvedAfterMs}ms after the request), status=${stopped.status}, notices=${noticeEvents(stoppedHistory).map((e) => e.event).join(",")}, pushed=${pushed}, fileWritten=${existsSync(target)}`,
    );

    // ---- 人類送訊息讓 agent 復活之後:舊的請求什麼都沒留下 ----
    const { reply } = await turn(c.client, sid, "剛才那個寫檔請求不用了,回個話就好");
    const revived = await waitStatus(c.client, sid, "idle", 10_000);
    const newCalls = callsSince(dirs, pidsBefore);
    // 錯過推播、畫面上還留著彈窗的 client 對舊請求按「允許」:core 已經沒有這筆登記,不會轉給復活的新 agent、也不會再推播一次
    await c.client.rpc("permission.resolve", { sessionId: sid, requestId, decision: "allow" });
    // 等過舊請求的逾時時間:計時器有清掉的話,不會再冒出一筆 source=timeout 的 permission-resolved
    await sleep(Math.max(0, requestedAt + WAITING_PERMISSION_TIMEOUT_MS + 1_500 - Date.now()));
    const pushes = resolvedPushesFor(c.client, sid, requestId);
    const after = await getSession(c.client, sid);
    record(
      "S10 送訊息 → agent 復活並回覆(只 spawn 一個新行程)、回到 idle;之後對舊請求按「允許」沒有任何作用(不轉給新 agent、不再推播),等過舊請求的逾時時間也沒有逾時推播——這筆請求從頭到尾只收到一次 permission-resolved;狀態維持 idle,檔案沒有被寫入",
      reply === FAKE_ACP_REPLY &&
        revived.status === "idle" &&
        pidsOf(newCalls).size === 1 &&
        pushes.length === 1 &&
        pushes[0].source === "agent-stopped" &&
        after?.status === "idle" &&
        !existsSync(target),
      `reply=${clip(reply, 60)}, revived=${revived.status}, newAgentPids=${pidsOf(newCalls).size}, pushesForOldRequest=${JSON.stringify(pushes)}, after=${after?.status}, fileWritten=${existsSync(target)}`,
    );
  } catch (err) {
    record("S9-S10 執行過程發生未預期錯誤", false, String(err?.stack ?? err));
  } finally {
    c?.client.close();
    await killProcessTreeHard(c?.proc);
    dirs.cleanup();
  }
}

async function testOpencodeCrashWhileQuestion() {
  const dirs = newDirs("crash-question");
  let c;
  try {
    c = await boot(dirs);
    const sid = await createSession(c.client, FAKE_OPENCODE, dirs.workspaceDir, "revive-crash-question");
    await turn(c.client, sid, SECRET_PROMPT);
    const serverPid = onlyAgentPid(dirs);
    const from = c.client.events.length;
    await c.client.rpc("session.sendPrompt", { sessionId: sid, prompt: { text: `${QUESTION_PREFIX} crash` } });
    const dialog = await c.client.waitFor(c.client.events, (e) => e.sessionId === sid && e.event.type === "user-dialog-request", 15_000, from);
    const { requestId } = dialog.event;
    const waiting = await waitStatus(c.client, sid, "waiting", 10_000);
    const dialogFrom = c.client.userDialogResolved.length;
    const pushFrom = c.client.sessionMessages.length;

    killAgentProcess(serverPid);
    const resolved = await c.client.waitFor(
      c.client.userDialogResolved,
      (p) => p.sessionId === sid && p.requestId === requestId,
      15_000,
      dialogFrom,
    );
    const { stopped, pushed } = await waitAgentStopped(c.client, sid, pushFrom);
    const { reply } = await turn(c.client, sid, "問題不用回答了");
    const revived = await waitStatus(c.client, sid, "idle", 10_000);
    const pushes = c.client.userDialogResolved.filter((p) => p.sessionId === sid && p.requestId === requestId);
    record(
      "S11 OpenCode:server 在等使用者回答提問(waiting)時被殺 → 所有 client 收到 user-dialog-resolved(cancelled)收掉待答表單;session 轉 error + agentStopped 說明;送訊息後復活、回到 idle,這筆提問只收到一次推播",
      waiting.status === "waiting" &&
        resolved.result?.behavior === "cancelled" &&
        stopped.status === "error" &&
        pushed &&
        reply.length > 0 &&
        revived.status === "idle" &&
        pushes.length === 1,
      `waiting=${waiting.status}, resolved=${JSON.stringify(resolved)}, status=${stopped.status}, pushed=${pushed}, reply=${clip(reply, 60)}, revived=${revived.status}, pushes=${pushes.length}`,
    );
  } catch (err) {
    record("S11 執行過程發生未預期錯誤", false, String(err?.stack ?? err));
  } finally {
    c?.client.close();
    await killProcessTreeHard(c?.proc);
    dirs.cleanup();
  }
}

async function testDeleteWhileWaitingPermission() {
  const dirs = newDirs("delete-waiting");
  let c;
  try {
    c = await boot(dirs);
    const sid = await createSession(c.client, FAKE_ACP, dirs.workspaceDir, "revive-delete-waiting");
    const target = path.join(dirs.workspaceDir, "delete-waiting.txt");
    const { requestId, waiting } = await askWritePermission(c.client, sid, target);
    const resolvedFrom = c.client.permissionResolved.length;

    await c.client.rpc("session.delete", { sessionId: sid });
    const resolved = await c.client
      .waitFor(c.client.permissionResolved, (p) => p.sessionId === sid && p.requestId === requestId, 10_000, resolvedFrom)
      .catch(() => undefined);
    const listed = await getSession(c.client, sid);
    record(
      "S12 session 在等權限回覆(waiting)時被刪除:所有 client 收到這筆請求的 permission-resolved(deny、source=agent-stopped)關閉彈窗;session 已不在清單、檔案沒有被寫入",
      waiting.status === "waiting" && resolved?.decision === "deny" && resolved?.source === "agent-stopped" && !listed && !existsSync(target),
      `waiting=${waiting.status}, resolved=${JSON.stringify(resolved)}, stillListed=${Boolean(listed)}, fileWritten=${existsSync(target)}`,
    );
  } catch (err) {
    record("S12 執行過程發生未預期錯誤", false, String(err?.stack ?? err));
  } finally {
    c?.client.close();
    await killProcessTreeHard(c?.proc);
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
  ["options-resume", () => acpOptionsScenario("opt-resume", PROVIDER_OPT_RESUME, ["initialize", "session/resume"])],
  ["options-load", () => acpOptionsScenario("opt-load", PROVIDER_OPT_LOAD, ["initialize", "session/load", "session/load.replayed"])],
  ["options-transcript", () => acpOptionsScenario("opt-new", PROVIDER_OPT_NEW, ["initialize", "session/new"])],
  ["options-opencode-reuse", () => opencodeOptionsScenario("opt-oc-reuse", { forget: false })],
  ["options-opencode-recreate", () => opencodeOptionsScenario("opt-oc-recreate", { forget: true })],
  ["crash-idle", () => testAgentCrashWhileIdle()],
  ["crash-busy", () => testAgentCrashMidTurn()],
  ["crash-opencode", () => testOpencodeServerCrash()],
  ["crash-claude", () => testClaudeExitProbe()],
  ["crash-waiting-permission", () => testAgentCrashWhileWaitingPermission()],
  ["crash-waiting-question", () => testOpencodeCrashWhileQuestion()],
  ["delete-waiting", () => testDeleteWhileWaitingPermission()],
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
