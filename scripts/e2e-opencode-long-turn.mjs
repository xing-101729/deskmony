#!/usr/bin/env node
/**
 * scripts/e2e-opencode-long-turn.mjs
 *
 * 2026-10-05:OpenCode(HTTP)一輪工作超過約 5 分鐘不得跳出假的「送出失敗」錯誤。
 *
 * ---- 修的是什麼 --------------------------------------------------------
 *
 * `OpenCodeAdapter` 過去用 `POST /session/{id}/message` 送 prompt。那支 API 會**阻塞到整輪結束才回應**,而 Node 內建
 * `fetch`(undici)的 `headersTimeout` 預設是 300 秒——所以一輪超過約 5 分鐘(寫程式、跑測試很常見),這個還沒回應的 POST
 * 就以 `fetch failed`(`cause.code === "UND_ERR_HEADERS_TIMEOUT"`)失敗,adapter 因此送出**假的** `error` 事件
 * (「OpenCode session/message 送出失敗」),但 opencode 其實還在跑、SSE 也照常送事件,回合接著正常完成。
 * (真實 opencode 1.18.7 實測:330 秒的 bash 工具,錯誤在約 304 秒冒出、回合約 342 秒才 completed。)
 *
 * 修法:優先用立即回 204 的 `POST /session/{id}/prompt_async`(body 與 `/message` 相同,事件一樣走 SSE);舊版 opencode
 * 沒有這個端點(404)就退回 `/message`,退路上把 undici 的等待逾時當成正常、不送 `error`;`/command`(沒有非阻塞版本)同理。
 * 因為 `prompt_async` 一律 204,「回合跑不起來」(例如 model 不存在)的錯誤只剩 SSE `session.error` 一條路,adapter 因此
 * 新增了 `session.error` 的處理(一輪只報一個 `error`)——否則那種失敗會變成靜默的 completed。
 *
 * ---- 這支測試釘住的承諾 -------------------------------------------------
 *
 * 全程走 scripts/fake-opencode-server.mjs(決定性、不呼叫任何模型,**不用真的等 300 秒**):
 *
 *   L1  一般情況:prompt 打的是 `prompt_async`(不是 `/message`),回合 completed、回覆正確、沒有 error。
 *   L2  `/message` 與 `/command` 永遠不回應(`FAKE_OPENCODE_MESSAGE_HANG=1`,模擬長回合):adapter 照樣走 `prompt_async`,
 *       回合正常 completed、**沒有 error 事件**(含事後靜置期間)、歷史裡沒有 `session.adapterError`;斜線指令(沒有非阻塞
 *       端點)也正常完成、不報錯。
 *   L3  舊版 opencode(`prompt_async` 回 404):退回 `/message`,session 之後不再重試 `prompt_async`;`/message` 永遠不回應時
 *       回合仍正常完成、沒有 error;`/message` 正常回應時照常運作。
 *   L4  其他錯誤照舊送 `error`:`prompt_async` 回 500 → 「session/prompt_async 送出失敗」且**不**退回 `/message`(只有 404
 *       才退);退路上的 `/message` 回 500 → 「session/message 送出失敗」。
 *   L5  回合跑不起來(壞 model):`prompt_async` 回 204,錯誤只走 SSE `session.error`——**剛好一個** `error`(idle 之後
 *       才到的第二個 `session.error` 不再報)、沒有 completed;同一個 session 下一輪正常。
 *   L6  單元層:undici 等待逾時的分類函式 `isUndiciWaitTimeout()`(不真的等 300 秒)。
 *   L7  adapter 層(在這支測試自己的行程裡直接跑 `OpenCodeAdapter` + fake server,並把 `fetch` 換成會在等了一下之後
 *       丟出 undici 形狀的錯誤——`TypeError("fetch failed")` + `cause.code === "UND_ERR_HEADERS_TIMEOUT"`):退路上
 *       `/message` 與 `/command` 遇到這個錯誤 → 不送 `error`、回合照常由 SSE 收尾;同樣的 `fetch failed` 但原因是
 *       連線被重設(`ECONNRESET`)→ 仍然送 `error`。這是對「真的等滿 300 秒」最接近的決定性替身。
 *
 * 只啟動一個 core,DESKMONY_HOME/DATA_DIR/WORKSPACE/CORE_PORT 四個都指向暫存目錄,並在繼續之前確認 core 印出的 SQLite
 * 路徑真的在暫存目錄底下——漏設任何一個都可能連到使用者真實的 ~/.deskmony/deskmony.db。
 *
 * 前置需求:`pnpm build` 已跑過。
 * 用法:node scripts/e2e-opencode-long-turn.mjs
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { FAKE_OPENCODE_REPLY_CHUNKS, SESSION_ERROR_PREFIX, SESSION_ERROR_MESSAGE } from "./fake-opencode-server.mjs";
import { requireFreshBuild } from "./lib/require-fresh-build.mjs";
import { e2eProvidersEnv, FAKE_OPENCODE } from "./lib/e2e-providers.mjs";

requireFreshBuild();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const CORE_ENTRY = path.join(REPO_ROOT, "apps", "core", "dist", "index.js");
const ADAPTERS_ENTRY = path.join(REPO_ROOT, "packages", "adapters", "dist", "index.js");
/** 避開其他 e2e 用過的 port(見 e2e-cli.mjs 檔頭的盤點;4740/4745/4748 是 opencode 與 agent-env)。 */
const PORT = 4750;
const EXPECTED_REPLY = FAKE_OPENCODE_REPLY_CHUNKS.join("");
/** 回合結束後靜置多久,確認沒有「遲到的」error(adapter 若誤報,事件會在這段期間冒出來)。 */
const SETTLE_MS = 1_500;
const TURN_TIMEOUT_MS = 15_000;

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

// =======================================================================
let requestLogFile;

function startCore({ dataDir, homeDir, workspaceDir }) {
  const env = {
    ...process.env,
    DESKMONY_CORE_PORT: String(PORT),
    DESKMONY_DATA_DIR: dataDir,
    DESKMONY_HOME: homeDir,
    DESKMONY_WORKSPACE: workspaceDir,
    ...e2eProvidersEnv(),
    FAKE_OPENCODE_REQUEST_LOG_FILE: requestLogFile,
  };
  // 決定性:執行這支測試的 shell 若剛好設了這些旁路,前提就不成立——統一清掉,各測試自己用 provider 環境變數開關。
  for (const name of Object.keys(env)) {
    if (name.startsWith("FAKE_OPENCODE_") && name !== "FAKE_OPENCODE_REQUEST_LOG_FILE") delete env[name];
  }
  const proc = spawn(process.execPath, [CORE_ENTRY], { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdoutBuffer = "";
  const dbPathPromise = new Promise((resolve) => {
    proc.stdout.on("data", (chunk) => {
      process.stdout.write(`[core:${PORT}] ${chunk}`);
      stdoutBuffer += chunk.toString();
      const m = stdoutBuffer.match(/\[db\] using sqlite file at (.+)/);
      if (m) resolve(m[1].trim());
    });
  });
  proc.stderr.on("data", (chunk) => process.stderr.write(`[core:${PORT}:err] ${chunk}`));
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
/** fake 伺服器的 request log(每行 `{kind:"request", pid, endpoint}`),依到達順序。 */
function readRequests() {
  if (!existsSync(requestLogFile)) return [];
  return readFileSync(requestLogFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line).endpoint);
}

async function setFakeModes(client, vars) {
  // 沒列出的旁路一律清成空字串(= 關閉),避免上一個測試的設定漏到這一個。
  const all = {
    FAKE_OPENCODE_MESSAGE_HANG: "",
    FAKE_OPENCODE_NO_PROMPT_ASYNC: "",
    FAKE_OPENCODE_PROMPT_HTTP_STATUS: "",
    ...vars,
  };
  await client.rpc("settings.setProviderPrefs", { providerId: FAKE_OPENCODE, patch: { env: all } });
}

async function createSession(client, workspaceDir, title) {
  const {
    session: { id },
  } = await client.rpc("session.create", { providerId: FAKE_OPENCODE, workingDir: workspaceDir, title }, 30_000);
  return id;
}

/**
 * 送一則 prompt,等這個 session 的回合結束事件(completed 或 error),再靜置 SETTLE_MS 讓遲到的事件(例如誤報的 error)冒出來。
 * 回傳 `{ end, events, requests }`:events = 這一輪(送出之後)這個 session 的所有 session-event。
 */
async function runTurn(client, sessionId, text, { settleMs = SETTLE_MS } = {}) {
  const from = client.timeline.length;
  const requestsBefore = readRequests().length;
  await client.rpc("session.sendPrompt", { sessionId, prompt: { text } });
  const end = await client.waitFor((e) => isTurnEnd(e, sessionId), TURN_TIMEOUT_MS, from);
  await sleep(settleMs);
  const events = client.timeline
    .slice(from)
    .filter((e) => e.channel === "session-event" && e.payload.sessionId === sessionId)
    .map((e) => e.payload.event);
  return { end: end.entry.payload.event, events, requests: readRequests().slice(requestsBefore) };
}

async function lastAssistantText(client, sessionId) {
  const { messages } = await client.rpc("session.history", { sessionId });
  return messages.filter((m) => m.role === "assistant").at(-1)?.content;
}

async function adapterErrorRows(client, sessionId) {
  const { messages } = await client.rpc("session.history", { sessionId });
  return messages.filter((m) => m.role === "system" && String(m.content).includes("session.adapterError"));
}

const errorsOf = (events) => events.filter((e) => e.type === "error");
const completedCount = (events) => events.filter((e) => e.type === "completed").length;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// =======================================================================
// L1:一般情況走 prompt_async。
// =======================================================================
async function testDefaultUsesPromptAsync(client, workspaceDir) {
  await setFakeModes(client, {});
  const sessionId = await createSession(client, workspaceDir, "long-turn-L1");
  const first = await runTurn(client, sessionId, "hello");
  const reply = await lastAssistantText(client, sessionId);
  const second = await runTurn(client, sessionId, "hello again");
  record(
    "L1 一般 prompt 打的是 POST /session/{id}/prompt_async(連續兩輪都是,沒有碰 /message),回合 completed、回覆正確、沒有 error",
    same(first.requests, ["prompt_async"]) &&
      same(second.requests, ["prompt_async"]) &&
      first.end.type === "completed" &&
      second.end.type === "completed" &&
      errorsOf(first.events).length === 0 &&
      errorsOf(second.events).length === 0 &&
      reply === EXPECTED_REPLY,
    `第一輪端點=${JSON.stringify(first.requests)}, 第二輪端點=${JSON.stringify(second.requests)}, 結束=${first.end.type}/${second.end.type}, 回覆=${JSON.stringify(reply)}`,
  );
  await client.rpc("session.delete", { sessionId }, 15_000).catch(() => undefined);
}

// =======================================================================
// L2:/message、/command 永遠不回應。
// =======================================================================
async function testBlockingEndpointsNeverRespond(client, workspaceDir) {
  await setFakeModes(client, { FAKE_OPENCODE_MESSAGE_HANG: "1" });
  const sessionId = await createSession(client, workspaceDir, "long-turn-L2");
  try {
    const turn = await runTurn(client, sessionId, "hello");
    const reply = await lastAssistantText(client, sessionId);
    const adapterErrors = await adapterErrorRows(client, sessionId);
    record(
      "L2a /message 永遠不回應(模擬長回合):adapter 走 prompt_async、回合正常 completed、回覆正確、沒有 error 事件(含靜置期間)、歷史沒有 session.adapterError",
      same(turn.requests, ["prompt_async"]) &&
        turn.end.type === "completed" &&
        errorsOf(turn.events).length === 0 &&
        adapterErrors.length === 0 &&
        reply === EXPECTED_REPLY,
      `端點=${JSON.stringify(turn.requests)}, 結束=${turn.end.type}, error 數=${errorsOf(turn.events).length}, adapterError 列數=${adapterErrors.length}, 回覆=${JSON.stringify(reply)}`,
    );

    // 斜線指令沒有非阻塞端點(只能打 /command):這個端點永遠不回應時,回合照樣由 SSE 收尾、不報錯。
    const command = await runTurn(client, sessionId, "/greet world");
    const commandReply = await lastAssistantText(client, sessionId);
    const adapterErrorsAfter = await adapterErrorRows(client, sessionId);
    record(
      "L2b /command 永遠不回應:斜線指令仍打到 /command、回合由 SSE 收尾 completed(回覆帶 [command:greet args:world])、沒有 error 事件、沒有 session.adapterError",
      same(command.requests, ["command"]) &&
        command.end.type === "completed" &&
        errorsOf(command.events).length === 0 &&
        adapterErrorsAfter.length === 0 &&
        commandReply === "[command:greet args:world]",
      `端點=${JSON.stringify(command.requests)}, 結束=${command.end.type}, error 數=${errorsOf(command.events).length}, 回覆=${JSON.stringify(commandReply)}`,
    );
  } finally {
    await client.rpc("session.delete", { sessionId }, 15_000).catch(() => undefined);
  }
}

// =======================================================================
// L3:舊版 opencode(prompt_async 404)退回 /message。
// =======================================================================
async function testFallbackToMessage(client, workspaceDir) {
  // ---- L3a:退路上的 /message 永遠不回應 ----
  await setFakeModes(client, { FAKE_OPENCODE_NO_PROMPT_ASYNC: "1", FAKE_OPENCODE_MESSAGE_HANG: "1" });
  const hangSession = await createSession(client, workspaceDir, "long-turn-L3a");
  try {
    const first = await runTurn(client, hangSession, "hello fallback");
    const second = await runTurn(client, hangSession, "hello fallback again");
    const reply = await lastAssistantText(client, hangSession);
    const adapterErrors = await adapterErrorRows(client, hangSession);
    record(
      "L3a prompt_async 回 404(舊版 opencode)→ 退回 /message;之後同一個 session 不再試 prompt_async;/message 永遠不回應時回合仍由 SSE 收尾、沒有 error",
      same(first.requests, ["prompt_async-404", "message"]) &&
        same(second.requests, ["message"]) &&
        first.end.type === "completed" &&
        second.end.type === "completed" &&
        errorsOf(first.events).length === 0 &&
        errorsOf(second.events).length === 0 &&
        adapterErrors.length === 0 &&
        reply === EXPECTED_REPLY,
      `第一輪端點=${JSON.stringify(first.requests)}, 第二輪端點=${JSON.stringify(second.requests)}, 結束=${first.end.type}/${second.end.type}, error 數=${errorsOf(first.events).length + errorsOf(second.events).length}, 回覆=${JSON.stringify(reply)}`,
    );
  } finally {
    await client.rpc("session.delete", { sessionId: hangSession }, 15_000).catch(() => undefined);
  }

  // ---- L3b:退路上的 /message 正常(阻塞到回合結束才回應)----
  await setFakeModes(client, { FAKE_OPENCODE_NO_PROMPT_ASYNC: "1" });
  const normalSession = await createSession(client, workspaceDir, "long-turn-L3b");
  try {
    const turn = await runTurn(client, normalSession, "hello legacy");
    const reply = await lastAssistantText(client, normalSession);
    record(
      "L3b 舊版 opencode(沒有 prompt_async)的 /message 照常運作:回合 completed、回覆正確、沒有 error",
      same(turn.requests, ["prompt_async-404", "message"]) &&
        turn.end.type === "completed" &&
        errorsOf(turn.events).length === 0 &&
        reply === EXPECTED_REPLY,
      `端點=${JSON.stringify(turn.requests)}, 結束=${turn.end.type}, 回覆=${JSON.stringify(reply)}`,
    );
  } finally {
    await client.rpc("session.delete", { sessionId: normalSession }, 15_000).catch(() => undefined);
  }
}

// =======================================================================
// L4:其他錯誤照舊送 error。
// =======================================================================
async function testOtherErrorsStillReported(client, workspaceDir) {
  // ---- L4a:prompt_async 回 500 ----
  await setFakeModes(client, { FAKE_OPENCODE_PROMPT_HTTP_STATUS: "500" });
  const asyncSession = await createSession(client, workspaceDir, "long-turn-L4a");
  try {
    const turn = await runTurn(client, asyncSession, "hello", { settleMs: 500 });
    const errors = errorsOf(turn.events);
    record(
      "L4a prompt_async 回 500(真的失敗,不是 404)→ 送出 error「OpenCode session/prompt_async 送出失敗」(detail 帶狀態碼),而且不退回 /message",
      turn.end.type === "error" &&
        errors.length === 1 &&
        errors[0].message === "OpenCode session/prompt_async 送出失敗" &&
        String(errors[0].detail).includes("500") &&
        same(turn.requests, ["prompt_async"]),
      `結束=${turn.end.type}, errors=${JSON.stringify(errors)}, 端點=${JSON.stringify(turn.requests)}`,
    );
  } finally {
    await client.rpc("session.delete", { sessionId: asyncSession }, 15_000).catch(() => undefined);
  }

  // ---- L4b:退路上的 /message 回 500 ----
  await setFakeModes(client, { FAKE_OPENCODE_NO_PROMPT_ASYNC: "1", FAKE_OPENCODE_PROMPT_HTTP_STATUS: "500" });
  const messageSession = await createSession(client, workspaceDir, "long-turn-L4b");
  try {
    const turn = await runTurn(client, messageSession, "hello", { settleMs: 500 });
    const errors = errorsOf(turn.events);
    record(
      "L4b 退路上的 /message 回 500 → 照舊送出 error「OpenCode session/message 送出失敗」(只有等待逾時才被當成正常)",
      turn.end.type === "error" &&
        errors.length === 1 &&
        errors[0].message === "OpenCode session/message 送出失敗" &&
        String(errors[0].detail).includes("500") &&
        same(turn.requests, ["prompt_async-404", "message"]),
      `結束=${turn.end.type}, errors=${JSON.stringify(errors)}, 端點=${JSON.stringify(turn.requests)}`,
    );
  } finally {
    await client.rpc("session.delete", { sessionId: messageSession }, 15_000).catch(() => undefined);
  }
}

// =======================================================================
// L5:回合跑不起來(壞 model)——錯誤只走 SSE session.error。
// =======================================================================
async function testSessionErrorOverSse(client, workspaceDir) {
  await setFakeModes(client, {});
  const sessionId = await createSession(client, workspaceDir, "long-turn-L5");
  try {
    const turn = await runTurn(client, sessionId, `${SESSION_ERROR_PREFIX} bad model`);
    const errors = errorsOf(turn.events);
    record(
      "L5a 回合跑不起來(prompt_async 回 204、錯誤只走 SSE session.error):剛好一個 error「OpenCode 回合失敗: UnknownError」帶第一個 session.error 的訊息(idle 之後第二個 session.error 不再報)、沒有 completed、不是靜默成功",
      same(turn.requests, ["prompt_async"]) &&
        turn.end.type === "error" &&
        errors.length === 1 &&
        errors[0].message === "OpenCode 回合失敗: UnknownError" &&
        errors[0].detail === SESSION_ERROR_MESSAGE &&
        completedCount(turn.events) === 0,
      `端點=${JSON.stringify(turn.requests)}, 結束=${turn.end.type}, errors=${JSON.stringify(errors)}, completed 數=${completedCount(turn.events)}`,
    );

    const next = await runTurn(client, sessionId, "hello after the failed turn");
    const reply = await lastAssistantText(client, sessionId);
    record(
      "L5b 失敗的回合之後,同一個 session 的下一輪正常(completed、沒有 error、回覆正確——上一輪的失敗旗標不會漏到這一輪)",
      next.end.type === "completed" && errorsOf(next.events).length === 0 && reply === EXPECTED_REPLY,
      `結束=${next.end.type}, error 數=${errorsOf(next.events).length}, 回覆=${JSON.stringify(reply)}`,
    );
  } finally {
    await client.rpc("session.delete", { sessionId }, 15_000).catch(() => undefined);
  }
}

// =======================================================================
// L6:undici 等待逾時的分類函式(單元層)。
// =======================================================================
async function testWaitTimeoutClassifier() {
  const { isUndiciWaitTimeout } = await import(pathToFileURL(ADAPTERS_ENTRY).href);
  /** 照 Node 內建 fetch 的形狀:TypeError("fetch failed"),底層錯誤在 cause 上。 */
  const fetchFailed = (causeCode) => {
    const cause = Object.assign(new Error(`undici: ${causeCode}`), { code: causeCode });
    return new TypeError("fetch failed", { cause });
  };
  const cyclic = new Error("cyclic");
  cyclic.cause = cyclic;
  const deep = new TypeError("fetch failed", {
    cause: new Error("wrapper", { cause: Object.assign(new Error("inner"), { code: "UND_ERR_BODY_TIMEOUT" }) }),
  });

  const timeouts = {
    "headers 逾時(fetch failed + cause.code=UND_ERR_HEADERS_TIMEOUT)": fetchFailed("UND_ERR_HEADERS_TIMEOUT"),
    "body 逾時(cause.code=UND_ERR_BODY_TIMEOUT)": fetchFailed("UND_ERR_BODY_TIMEOUT"),
    "code 在錯誤本身(沒包 cause)": Object.assign(new Error("x"), { code: "UND_ERR_HEADERS_TIMEOUT" }),
    "code 在更深的 cause 鏈上": deep,
  };
  const notTimeouts = {
    "連線被拒(ECONNREFUSED)": fetchFailed("ECONNREFUSED"),
    "連線被重設(ECONNRESET)": fetchFailed("ECONNRESET"),
    "連線逾時(UND_ERR_CONNECT_TIMEOUT:連都連不上,是真的失敗)": fetchFailed("UND_ERR_CONNECT_TIMEOUT"),
    "socket 被對方關閉(UND_ERR_SOCKET)": fetchFailed("UND_ERR_SOCKET"),
    "沒有 cause 的 fetch failed": new TypeError("fetch failed"),
    "一般 Error": new Error("boom"),
    "HTTP 500 的 DeskmonyError 形狀(有 code 但不是逾時)": Object.assign(new Error("POST 失敗(status=500)"), { code: "opencode.requestFailed" }),
    "循環的 cause 鏈(不得卡住)": cyclic,
    undefined: undefined,
    null: null,
    字串: "UND_ERR_HEADERS_TIMEOUT",
  };

  const wrongTimeouts = Object.entries(timeouts).filter(([, err]) => isUndiciWaitTimeout(err) !== true).map(([name]) => name);
  const wrongOthers = Object.entries(notTimeouts).filter(([, err]) => isUndiciWaitTimeout(err) !== false).map(([name]) => name);
  record(
    "L6 isUndiciWaitTimeout():UND_ERR_HEADERS_TIMEOUT/UND_ERR_BODY_TIMEOUT(含包在 fetch failed 的 cause、更深的 cause 鏈)→ true;連線被拒/重設/連線逾時/一般錯誤/非錯誤物件/循環 cause → false",
    wrongTimeouts.length === 0 && wrongOthers.length === 0,
    `應為 true 卻不是=${JSON.stringify(wrongTimeouts)}, 應為 false 卻不是=${JSON.stringify(wrongOthers)}`,
  );
}

// =======================================================================
// L7:adapter 層——undici 等待逾時錯誤的處理。
// =======================================================================
/** undici 形狀的 fetch 失敗:`TypeError("fetch failed")`,真正的原因在 `cause.code`。 */
function undiciFetchFailed(causeCode) {
  return new TypeError("fetch failed", { cause: Object.assign(new Error(`undici: ${causeCode}`), { code: causeCode }) });
}

/**
 * 在這個行程裡跑 `OpenCodeAdapter`(搭 fake server,`env` 是給 fake 的旁路),把符合 `failUrlPattern` 的 POST 變成
 * 「請求真的送出去了(fake 照常跑那一輪、事件走 SSE),但回應等不到、一會兒之後 fetch 以 `causeCode` 失敗」,
 * 回傳 `{ events, requestsFailed }`。其他請求(健康檢查、SSE、/command 清單……)原樣放行。
 */
async function runAdapterWithFailingPost({ failUrlPattern, causeCode, promptText, fakeEnv, workspaceDir }) {
  const { OpenCodeAdapter } = await import(pathToFileURL(ADAPTERS_ENTRY).href);
  const realFetch = globalThis.fetch;
  let failedRequests = 0;
  globalThis.fetch = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (init?.method === "POST" && failUrlPattern.test(url)) {
      failedRequests += 1;
      // 請求照送(fake 的 /message、/command 在 HANG 模式下會執行該輪、但永遠不回應),這個 promise 一直懸著到 dispose 殺掉 fake。
      void realFetch(input, init).catch(() => undefined);
      return new Promise((_, reject) => setTimeout(() => reject(undiciFetchFailed(causeCode)), 300));
    }
    return realFetch(input, init);
  };
  const adapter = new OpenCodeAdapter();
  const events = [];
  let handle;
  try {
    handle = await adapter.spawn(
      {
        software: "opencode",
        providerId: "e2e-long-turn-direct",
        opencodeConfig: { command: process.execPath, args: [path.join(__dirname, "fake-opencode-server.mjs")] },
        env: fakeEnv,
      },
      { path: workspaceDir },
    );
    void (async () => {
      for await (const ev of adapter.events(handle)) events.push(ev);
    })().catch(() => undefined);
    adapter.sendPrompt(handle, { text: promptText });
    const deadline = Date.now() + TURN_TIMEOUT_MS;
    while (Date.now() < deadline && !events.some((e) => e.type === "completed" || e.type === "error")) await sleep(25);
    await sleep(SETTLE_MS);
  } finally {
    if (handle) await adapter.dispose(handle).catch(() => undefined);
    globalThis.fetch = realFetch;
  }
  return { events, failedRequests };
}

async function testAdapterUndiciTimeout(workspaceDir) {
  const hangFallback = { FAKE_OPENCODE_NO_PROMPT_ASYNC: "1", FAKE_OPENCODE_MESSAGE_HANG: "1" };
  const replyOf = (events) => events.filter((e) => e.type === "message-delta").map((e) => e.delta).join("");

  // ---- L7a:退路上的 /message 等不到回應、被 undici 逾時放棄 → 不是錯誤 ----
  const a = await runAdapterWithFailingPost({
    failUrlPattern: new RegExp("/session/[^/]+/message$"),
    causeCode: "UND_ERR_HEADERS_TIMEOUT",
    promptText: "hello",
    fakeEnv: hangFallback,
    workspaceDir,
  });
  record(
    "L7a 退路上的 /message 因 UND_ERR_HEADERS_TIMEOUT 失敗(fetch failed)→ 不送 error 事件,回合照常由 SSE 收尾 completed、回覆完整(舊版在這裡送出假的「送出失敗: fetch failed」)",
    a.failedRequests === 1 &&
      a.events.filter((e) => e.type === "error").length === 0 &&
      a.events.filter((e) => e.type === "completed").length === 1 &&
      replyOf(a.events) === EXPECTED_REPLY,
    `被換成逾時的 POST 數=${a.failedRequests}, error 數=${a.events.filter((e) => e.type === "error").length}, completed 數=${a.events.filter((e) => e.type === "completed").length}, 回覆=${JSON.stringify(replyOf(a.events))}`,
  );

  // ---- L7b:同樣是 fetch failed,但原因是連線被重設 → 真的失敗 ----
  const b = await runAdapterWithFailingPost({
    failUrlPattern: new RegExp("/session/[^/]+/message$"),
    causeCode: "ECONNRESET",
    promptText: "hello",
    fakeEnv: hangFallback,
    workspaceDir,
  });
  const bErrors = b.events.filter((e) => e.type === "error");
  record(
    "L7b 同樣的 fetch failed、但原因是 ECONNRESET(不是等待逾時)→ 仍然送出 error「OpenCode session/message 送出失敗」(只有 headers/body 等待逾時被當成正常)",
    b.failedRequests === 1 && bErrors.length === 1 && bErrors[0].message === "OpenCode session/message 送出失敗" && bErrors[0].detail === "fetch failed",
    `error=${JSON.stringify(bErrors)}`,
  );

  // ---- L7c:斜線指令(只有 /command,沒有非阻塞端點)等太久 → 不是錯誤 ----
  const c = await runAdapterWithFailingPost({
    failUrlPattern: new RegExp("/session/[^/]+/command$"),
    causeCode: "UND_ERR_BODY_TIMEOUT",
    promptText: "/greet world",
    fakeEnv: { FAKE_OPENCODE_MESSAGE_HANG: "1" },
    workspaceDir,
  });
  record(
    "L7c /command 因 UND_ERR_BODY_TIMEOUT 失敗 → 不送 error 事件,回合照常由 SSE 收尾 completed(回覆帶 [command:greet args:world])",
    c.failedRequests === 1 &&
      c.events.filter((e) => e.type === "error").length === 0 &&
      c.events.filter((e) => e.type === "completed").length === 1 &&
      replyOf(c.events) === "[command:greet args:world]",
    `被換成逾時的 POST 數=${c.failedRequests}, error 數=${c.events.filter((e) => e.type === "error").length}, completed 數=${c.events.filter((e) => e.type === "completed").length}, 回覆=${JSON.stringify(replyOf(c.events))}`,
  );
}

// =======================================================================
async function main() {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-oc-long-data-"));
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-oc-long-home-"));
  const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-oc-long-ws-"));
  requestLogFile = path.join(dataDir, "fake-opencode-requests.jsonl");
  // 決定性:執行這支測試的 shell 若剛好設了 fake 的旁路,前提就不成立(L7 的 adapter 在這個行程裡直接 spawn fake,會繼承到)。
  for (const name of Object.keys(process.env)) {
    if (name.startsWith("FAKE_OPENCODE_")) delete process.env[name];
  }

  let core;
  let client;
  try {
    console.log("=== L6:undici 等待逾時的分類函式(單元層)===");
    await testWaitTimeoutClassifier();
    console.log("\n=== L7:adapter 層——undici 等待逾時錯誤的處理 ===");
    await testAdapterUndiciTimeout(workspaceDir);

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

    console.log("\n=== L1:一般情況走 prompt_async ===");
    await testDefaultUsesPromptAsync(client, workspaceDir);
    console.log("\n=== L2:/message、/command 永遠不回應 ===");
    await testBlockingEndpointsNeverRespond(client, workspaceDir);
    console.log("\n=== L3:舊版 opencode(prompt_async 404)退回 /message ===");
    await testFallbackToMessage(client, workspaceDir);
    console.log("\n=== L4:其他錯誤照舊送 error ===");
    await testOtherErrorsStillReported(client, workspaceDir);
    console.log("\n=== L5:回合跑不起來——錯誤只走 SSE session.error ===");
    await testSessionErrorOverSse(client, workspaceDir);
  } catch (err) {
    record("執行過程發生未預期錯誤", false, err instanceof Error ? err.stack : String(err));
  } finally {
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
  console.error("[e2e-opencode-long-turn] fatal:", err);
  process.exit(1);
});
