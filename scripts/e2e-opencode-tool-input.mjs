#!/usr/bin/env node
/**
 * scripts/e2e-opencode-tool-input.mjs
 *
 * 2026-09-17:OpenCode 工具呼叫的 input 與回合硬上限計數。
 *
 * ---- 修的是什麼 --------------------------------------------------------
 *
 * 真實 opencode(1.18.7 實測)的 tool part 第一次推播一定是 `pending`,input 是
 * `{}` 佔位,完整參數要到 `running` 才出現。`OpenCodeAdapter` 過去只在第一次看到
 * 工具時送一次 tool-call,所以桌面端每個 OpenCode 工具泡泡都沒有參數,
 * `session-manager` 寫進 DB 的 call 記錄全部是 `"input":{}`。
 *
 * 修法是 adapter 補送第二次 tool-call(同一個 toolCallId、帶完整 input),core
 * 依 toolCallId 把第二次當成補資訊(見 apps/core/src/session/session-manager.ts
 * 的 `RuntimeState.openToolCalls`)。這支測試把那套語意的三個承諾各自釘住:
 *
 *   A. 補送的 input 是真的參數:live 事件、`session.history` 都要看得到,且歷史
 *      裡每個工具只有一筆 call(就地更新,不是多插一筆)。
 *      (A 用「permission.asked 先到、running 後到」的順序,B 用實測 bash 的
 *      「running 先到」順序,兩種 opencode 都會送。)
 *   A'. 補送不會把 waiting 翻回 busy:`permission.asked` 先到時 session 已經在等人
 *      回覆,晚到的 input 若經過 `ensureBusy()` 就會蓋掉 waiting。
 *   C/D. 回合硬上限對每個工具只計一次:`maxToolCalls = 3`,送 3 個工具不能 trip
 *      (每個工具兩個 tool-call 事件,逐事件計數會在第 2 個工具就 trip),送 4 個
 *      必須 trip(去重不能把真的呼叫也吃掉)。兩者合起來把「每個工具計幾次」夾在
 *      剛好 1。
 *
 * claude-sdk-adapter 對同一個工具也是先送 input=undefined、再送完整 input,走的是
 * core 同一段程式碼;沒有不需要真實憑證的 Claude 假後端,由這裡的 OpenCode 流程
 * 代為涵蓋。
 *
 *   E. (2026-10-03)OpenCode 經 ACP(`opencode acp`,provider `opencode-acp`)的同一個問題:
 *      ACP 的 `tool_call`(`pending`)給的 `rawInput` 是 `{}` 佔位,真參數要到後續的
 *      `tool_call_update`(`in_progress`)才帶,而 `AcpAdapter` 過去完全不讀 update 的
 *      `rawInput`,於是 MCP 工具(例如 `deskmony_send_to_session`)明明收到了參數,歷史與 UI
 *      裡那筆呼叫卻是 `"input":{}`。這組用 fake ACP agent 照真實 OpenCode 的通知順序送工具
 *      呼叫(scripts/fake-acp-agent.mjs 的 `ACP_OPENCODE_TOOL_CALLS`):
 *        E1  live:同一個 toolCallId 兩次 tool-call(`{}` → 真參數,title 跟著更新),後面
 *            重報同一份參數的 update 不再多送事件;歷史每個工具一筆 call、帶真參數,
 *            `maxToolCalls = 3` 送 3 個不 trip(每個工具只計一次)。
 *        E2  同一個上限送 4 個 → 必須 trip(補送不能把真的呼叫吃掉)。
 *
 * 全程走 scripts/fake-opencode-server.mjs(決定性、不呼叫任何模型)。只啟動一個
 * core,DESKMONY_HOME/DATA_DIR/WORKSPACE/CORE_PORT 四個都指向暫存目錄,並在繼續
 * 之前確認 core 印出的 SQLite 路徑真的在暫存目錄底下——漏設任何一個都可能連到
 * 使用者真實的 ~/.deskmony/deskmony.db。
 *
 * 前置需求:`pnpm build` 已跑過。
 * 用法:node scripts/e2e-opencode-tool-input.mjs
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  TOOL_CALL_PREFIX,
  TOOL_CALL_INPUT,
  TOOL_CALL_ASK_FIRST_MARKER,
  MANY_TOOL_CALLS_PREFIX,
  manyToolCallInput,
} from "./fake-opencode-server.mjs";
import {
  OPENCODE_TOOL_CALLS_PREFIX,
  OPENCODE_TOOL_PENDING_TITLE,
  opencodeToolRunningTitle,
  opencodeToolInput,
} from "./fake-acp-agent.mjs";
import { requireFreshBuild } from "./lib/require-fresh-build.mjs";
import { e2eProvidersEnv, FAKE_OPENCODE, FAKE_ACP } from "./lib/e2e-providers.mjs";

requireFreshBuild();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const CORE_ENTRY = path.join(REPO_ROOT, "apps", "core", "dist", "index.js");
const PORT = 4390;
/** 刻意設小:C 送剛好這麼多個工具、D 多送一個,見檔頭。 */
const TURN_MAX_TOOL_CALLS = 3;
/** 收到補送的 tool-call 之後,給 core 把這個事件處理完的時間——若有 bug,翻回 busy 的
 *  session-updated 推播會在這段期間出現(core 端是幾毫秒內的事)。 */
const STATUS_SETTLE_MS = 500;
/** C 回合結束後等多久確認「沒有 trip」:trip 是先 await interrupt 再發通知,給足餘裕。 */
const NO_TRIP_SETTLE_MS = 2_000;

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
/** 所有推播依抵達順序放進同一條 timeline——A' 要比較 session-updated 與
 *  session-event 的先後,分開存會失去這個資訊。 */
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
const isStatusPush = (entry, sessionId, status) =>
  entry.channel === "session-updated" && entry.payload.id === sessionId && entry.payload.status === status;

/** timeline[from, to) 之間這個 session 的 tool-call 事件,依 toolCallId 分組(保留抵達順序)。 */
function toolCallEventsById(client, sessionId, from, to) {
  const byId = new Map();
  for (const entry of client.timeline.slice(from, to)) {
    if (!isSessionEvent(entry, sessionId, "tool-call")) continue;
    const ev = entry.payload.event;
    if (!byId.has(ev.toolCallId)) byId.set(ev.toolCallId, []);
    byId.get(ev.toolCallId).push(ev);
  }
  return byId;
}

/** `session.history` 裡某個 toolCallId 的 tool 訊息(已 parse),分成 call/result。 */
async function historyRowsFor(client, sessionId, toolCallId) {
  const { messages } = await client.rpc("session.history", { sessionId });
  const rows = messages
    .filter((m) => m.role === "tool")
    .map((m) => {
      try {
        return JSON.parse(m.content);
      } catch {
        return undefined;
      }
    })
    .filter((row) => row && row.toolCallId === toolCallId);
  return { calls: rows.filter((r) => r.kind === "call"), results: rows.filter((r) => r.kind === "result") };
}

// =======================================================================
function startCore({ dataDir, homeDir, workspaceDir }) {
  const env = {
    ...process.env,
    DESKMONY_CORE_PORT: String(PORT),
    DESKMONY_DATA_DIR: dataDir,
    DESKMONY_HOME: homeDir,
    DESKMONY_WORKSPACE: workspaceDir,
    // 2026-10-02(P2:移除 profile):fake 後端經 `DESKMONY_E2E_EXTRA_PROVIDERS` 注入(見 lib/e2e-providers.mjs)。
    ...e2eProvidersEnv(),
  };
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
// A + A':permission.asked 先到、running 後到。
// =======================================================================
async function testAskBeforeRunning(client, sessionId) {
  const from = client.timeline.length;
  await client.rpc("session.sendPrompt", {
    sessionId,
    prompt: { text: `${TOOL_CALL_PREFIX} ${TOOL_CALL_ASK_FIRST_MARKER} run echo` },
  });

  const permission = await client.waitFor((e) => isSessionEvent(e, sessionId, "permission-request"), 15_000, from);
  const update = await client.waitFor(
    (e) => isSessionEvent(e, sessionId, "tool-call") && e.payload.event.input !== undefined,
    15_000,
    from,
  );
  await sleep(STATUS_SETTLE_MS);
  const settledAt = client.timeline.length;
  const waiting = client.timeline.slice(from, settledAt).findIndex((e) => isStatusPush(e, sessionId, "waiting"));
  const waitingIdx = waiting === -1 ? -1 : from + waiting;
  const flippedToBusy =
    waitingIdx !== -1 && client.timeline.slice(waitingIdx + 1, settledAt).some((e) => isStatusPush(e, sessionId, "busy"));
  const { sessions } = await client.rpc("session.list", {});
  const statusBeforeReply = sessions.find((s) => s.id === sessionId)?.status;

  await client.rpc("permission.resolve", { sessionId, requestId: permission.entry.payload.event.requestId, decision: "allow" });
  const end = await client.waitFor((e) => isTurnEnd(e, sessionId), 15_000, from);

  const toolCallId = update.entry.payload.event.toolCallId;
  const events = toolCallEventsById(client, sessionId, from, end.index).get(toolCallId) ?? [];
  const history = await historyRowsFor(client, sessionId, toolCallId);

  record(
    "A1(先問後 running)live:同一個 toolCallId 送兩次 tool-call,第一次 input 未知(undefined,不是 {}),第二次是完整參數",
    events.length === 2 && events[0].input === undefined && isDeepStrictEqual(events[1].input, TOOL_CALL_INPUT),
    `events=${JSON.stringify(events.map((e) => e.input ?? "(undefined)"))}`,
  );
  record(
    "A'(先問後 running)補送的 input 不把 waiting 翻回 busy:waiting 推播先於補送事件,之後到回覆前沒有 busy 推播,session.list 仍是 waiting",
    waitingIdx !== -1 && waitingIdx < update.index && !flippedToBusy && statusBeforeReply === "waiting",
    `waitingIdx=${waitingIdx}, updateIdx=${update.index}, flippedToBusy=${flippedToBusy}, statusBeforeReply=${statusBeforeReply}`,
  );
  record(
    "A2(先問後 running)歷史:這個工具只有一筆 call 且 input 是真實參數(就地更新,不是多插一筆),一筆 result,回合 completed",
    history.calls.length === 1 &&
      isDeepStrictEqual(history.calls[0].input, TOOL_CALL_INPUT) &&
      history.results.length === 1 &&
      end.entry.payload.event.type === "completed",
    `calls=${JSON.stringify(history.calls)}, results=${history.results.length}, 回合結束=${end.entry.payload.event.type}`,
  );
}

// =======================================================================
// B:running 先到、permission.asked 後到(本機實測 bash 的順序)。
// =======================================================================
async function testRunningBeforeAsk(client, sessionId) {
  const from = client.timeline.length;
  await client.rpc("session.sendPrompt", { sessionId, prompt: { text: `${TOOL_CALL_PREFIX} run echo` } });
  const permission = await client.waitFor((e) => isSessionEvent(e, sessionId, "permission-request"), 15_000, from);
  await client.rpc("permission.resolve", { sessionId, requestId: permission.entry.payload.event.requestId, decision: "allow" });
  const end = await client.waitFor((e) => isTurnEnd(e, sessionId), 15_000, from);

  const byId = toolCallEventsById(client, sessionId, from, end.index);
  const [toolCallId, events] = [...byId.entries()][0] ?? [undefined, []];
  const history = toolCallId ? await historyRowsFor(client, sessionId, toolCallId) : { calls: [], results: [] };

  record(
    "B(running 先於 permission.asked)live 兩次 tool-call(undefined → 完整參數),歷史一筆 call 帶真實參數 + 一筆 result",
    byId.size === 1 &&
      events.length === 2 &&
      events[0].input === undefined &&
      isDeepStrictEqual(events[1].input, TOOL_CALL_INPUT) &&
      history.calls.length === 1 &&
      isDeepStrictEqual(history.calls[0].input, TOOL_CALL_INPUT) &&
      history.results.length === 1 &&
      end.entry.payload.event.type === "completed",
    `工具數=${byId.size}, events=${JSON.stringify(events.map((e) => e.input ?? "(undefined)"))}, calls=${JSON.stringify(history.calls)}, results=${history.results.length}`,
  );
}

// =======================================================================
// C + D:回合硬上限每個工具只計一次。
// =======================================================================
async function runManyToolCalls(client, sessionId, count) {
  const from = client.timeline.length;
  await client.rpc("session.sendPrompt", {
    sessionId,
    prompt: { text: `${MANY_TOOL_CALLS_PREFIX}${JSON.stringify({ count })}` },
  });
  const end = await client.waitFor((e) => isTurnEnd(e, sessionId), 15_000, from);
  return { from, end };
}

const isTurnLimitTrip = (entry, sessionId) =>
  entry.channel === "enforcement-notification" &&
  entry.payload.kind === "trip" &&
  entry.payload.tripReason === "turn-limit" &&
  entry.payload.sessionId === sessionId;

async function testTurnLimitCountsEachToolOnce(client, sessionId) {
  // ---- C:剛好 maxToolCalls 個工具 → 不能 trip ----
  {
    const { from, end } = await runManyToolCalls(client, sessionId, TURN_MAX_TOOL_CALLS);
    await sleep(NO_TRIP_SETTLE_MS);
    const tripped = client.timeline.slice(from).some((e) => isTurnLimitTrip(e, sessionId));
    const byId = toolCallEventsById(client, sessionId, from, end.index);
    const twoEventsEach = [...byId.values()].every(
      (events) => events.length === 2 && events[0].input === undefined && events[1].input !== undefined,
    );

    const { messages } = await client.rpc("session.history", { sessionId });
    const callRows = messages
      .filter((m) => m.role === "tool")
      .map((m) => JSON.parse(m.content))
      .filter((row) => row.kind === "call" && byId.has(row.toolCallId));
    const everyInputPersistedOnce = Array.from({ length: TURN_MAX_TOOL_CALLS }, (_, i) => manyToolCallInput(i)).every(
      (expected) => callRows.filter((row) => isDeepStrictEqual(row.input, expected)).length === 1,
    );

    record(
      `C 回合硬上限 maxToolCalls=${TURN_MAX_TOOL_CALLS},送 ${TURN_MAX_TOOL_CALLS} 個工具(每個 2 個 tool-call 事件,共 ${TURN_MAX_TOOL_CALLS * 2} 個)→ 不 trip,回合正常 completed;歷史每個工具一筆 call、各帶自己的真實參數`,
      !tripped &&
        end.entry.payload.event.type === "completed" &&
        byId.size === TURN_MAX_TOOL_CALLS &&
        twoEventsEach &&
        callRows.length === TURN_MAX_TOOL_CALLS &&
        everyInputPersistedOnce,
      `tripped=${tripped}, 回合結束=${end.entry.payload.event.type}, 工具數=${byId.size}, 每個兩次事件=${twoEventsEach}, callRows=${callRows.length}, 參數各一筆=${everyInputPersistedOnce}`,
    );
  }

  // ---- D:多一個 → 必須 trip ----
  {
    const { from } = await runManyToolCalls(client, sessionId, TURN_MAX_TOOL_CALLS + 1);
    const trip = await client.waitFor((e) => isTurnLimitTrip(e, sessionId), 10_000, from).catch(() => undefined);
    record(
      `D 同一個上限送 ${TURN_MAX_TOOL_CALLS + 1} 個工具 → 收到 turn-limit trip 通知(去重沒有把真的呼叫吃掉)`,
      Boolean(trip),
      `trip=${trip ? JSON.stringify(trip.entry.payload) : "(沒收到)"}`,
    );
  }
}

// =======================================================================
// E:OpenCode 經 ACP——`tool_call` 帶 `{}`、真參數在 `tool_call_update` 才到。
// =======================================================================
async function runOpencodeStyleToolCalls(client, sessionId, count) {
  const from = client.timeline.length;
  await client.rpc("session.sendPrompt", {
    sessionId,
    prompt: { text: `${OPENCODE_TOOL_CALLS_PREFIX}${JSON.stringify({ count })}` },
  });
  return from;
}

async function testAcpToolInputFromUpdate(client, sessionId) {
  // ---- E1:剛好 maxToolCalls 個工具 → 不 trip,每個工具的真參數都落地 ----
  {
    const from = await runOpencodeStyleToolCalls(client, sessionId, TURN_MAX_TOOL_CALLS);
    const end = await client.waitFor((e) => isTurnEnd(e, sessionId), 15_000, from);
    await sleep(NO_TRIP_SETTLE_MS);
    const tripped = client.timeline.slice(from).some((e) => isTurnLimitTrip(e, sessionId));
    const byId = toolCallEventsById(client, sessionId, from, end.index);
    const ids = [...byId.keys()];

    // live:每個工具剛好兩次 tool-call——`{}` 佔位 + 補送的真參數(title 跟著 update 走);
    // 兩則重報同一份參數的 update(in_progress、completed)不能讓事件變多。
    const liveOk =
      ids.length === TURN_MAX_TOOL_CALLS &&
      ids.every((id, i) => {
        const events = byId.get(id);
        return (
          events.length === 2 &&
          events[0].toolName === OPENCODE_TOOL_PENDING_TITLE &&
          isDeepStrictEqual(events[0].input, {}) &&
          events[1].toolName === opencodeToolRunningTitle(i) &&
          isDeepStrictEqual(events[1].input, opencodeToolInput(i))
        );
      });

    // 歷史:每個工具一筆 call(就地更新、不是多插一筆)、input 是真參數、toolName 是新 title,
    // 一筆 result。
    let historyOk = ids.length > 0;
    const historyDetail = [];
    for (const [i, id] of ids.entries()) {
      const { calls, results: resultRows } = await historyRowsFor(client, sessionId, id);
      const ok =
        calls.length === 1 &&
        isDeepStrictEqual(calls[0].input, opencodeToolInput(i)) &&
        calls[0].toolName === opencodeToolRunningTitle(i) &&
        resultRows.length === 1;
      historyOk = historyOk && ok;
      historyDetail.push(`#${i}: calls=${calls.length}, input=${JSON.stringify(calls[0]?.input)}, results=${resultRows.length}`);
    }

    record(
      `E1(ACP,OpenCode 順序)live:每個工具兩次 tool-call({} → 真參數,重報同一份不再多送);歷史每個工具一筆 call 帶真實參數;maxToolCalls=${TURN_MAX_TOOL_CALLS} 送 ${TURN_MAX_TOOL_CALLS} 個不 trip(每個工具只計一次)`,
      !tripped && end.entry.payload.event.type === "completed" && liveOk && historyOk,
      `tripped=${tripped}, 回合結束=${end.entry.payload.event.type}, 工具數=${ids.length}, live=${liveOk} ${JSON.stringify(ids.map((id) => byId.get(id).map((e) => e.input)))}, 歷史=${historyDetail.join(" | ")}`,
    );
  }

  // ---- E2:多一個 → 必須 trip ----
  {
    const from = await runOpencodeStyleToolCalls(client, sessionId, TURN_MAX_TOOL_CALLS + 1);
    const trip = await client.waitFor((e) => isTurnLimitTrip(e, sessionId), 10_000, from).catch(() => undefined);
    record(
      `E2(ACP,OpenCode 順序)同一個上限送 ${TURN_MAX_TOOL_CALLS + 1} 個工具 → 收到 turn-limit trip 通知(補送沒有把真的呼叫吃掉)`,
      Boolean(trip),
      `trip=${trip ? JSON.stringify(trip.entry.payload) : "(沒收到)"}`,
    );
  }
}

// =======================================================================
async function main() {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-oc-input-data-"));
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-oc-input-home-"));
  const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-oc-input-ws-"));
  // budget 只能靠設定檔(遠端不可改,見 e2e-cost-governor.mjs 的 writeConfigWithBudget 說明)。
  writeFileSync(
    path.join(homeDir, "config.json"),
    JSON.stringify(
      { version: 1, budget: { warnAtPercent: 80, turn: { maxToolCalls: TURN_MAX_TOOL_CALLS, maxDurationMs: 600_000 } } },
      null,
      2,
    ),
    "utf8",
  );

  let core;
  let client;
  let sessionId;
  let acpSessionId;
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

    // bash 的 permission-request 要真的升級給人(進 waiting),A' 才有東西可驗——新 session 一律從
    // always-ask 開始(2026-10-02 P2:不再有 profile.permissionLevel)。
    ({ session: { id: sessionId } } = await client.rpc(
      "session.create",
      { providerId: FAKE_OPENCODE, workingDir: workspaceDir, title: "e2e-opencode-tool-input" },
      30_000,
    ));

    console.log("=== A / A':permission.asked 先到、running 後到 ===");
    await testAskBeforeRunning(client, sessionId);
    console.log("\n=== B:running 先到、permission.asked 後到 ===");
    await testRunningBeforeAsk(client, sessionId);
    console.log("\n=== C / D:回合硬上限每個工具只計一次 ===");
    await testTurnLimitCountsEachToolOnce(client, sessionId);

    // E 用另一個 session(D 已經讓上面那個 session 被回合上限中斷了)。
    console.log("\n=== E:OpenCode 經 ACP——真參數在 tool_call_update 才到 ===");
    ({ session: { id: acpSessionId } } = await client.rpc(
      "session.create",
      { providerId: FAKE_ACP, workingDir: workspaceDir, title: "e2e-opencode-tool-input-acp" },
      30_000,
    ));
    await testAcpToolInputFromUpdate(client, acpSessionId);
  } catch (err) {
    record("執行過程發生未預期錯誤", false, err instanceof Error ? err.stack : String(err));
  } finally {
    // 先讓 adapter 正常收掉 fake server 子程序,再停 core。
    if (client && sessionId) {
      await client.rpc("session.delete", { sessionId }, 15_000).catch(() => undefined);
    }
    if (client && acpSessionId) {
      await client.rpc("session.delete", { sessionId: acpSessionId }, 15_000).catch(() => undefined);
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
  console.error("[e2e-opencode-tool-input] fatal:", err);
  process.exit(1);
});
