#!/usr/bin/env node
/**
 * scripts/e2e-opencode-question.mjs
 *
 * 2026-09-17:OpenCode 的 `question` 工具(模型向使用者提問)端到端測試。
 *
 * 背景:2026-09-16 使用者回報「model 提出問題要使用者回答時,不會有介面顯示」。
 * 查證結果是 `OpenCodeAdapter` 完全沒有處理 `question.asked` 事件——UI 收不到
 * 任何待答請求,opencode 那邊的工具一直等,直到使用者自己中斷。這支測試把修正後
 * 的整條路徑釘住:adapter 轉發 `user-dialog-request` → gateway `dialog.resolve`
 * → adapter 回 `POST /question/{id}/reply` → 工具結果帶回答案。
 *
 * 走的是與 desktop 完全相同的 gateway 路徑(session-event push、`dialog.resolve`
 * RPC、`user-dialog-resolved` push),後端是 scripts/fake-opencode-server.mjs
 * (事件順序照抄真實 opencode 1.18.7 實測結果,見該檔案與 opencode-adapter.ts
 * 檔頭「提問」段落),不依賴真實 opencode 或任何模型。
 *
 *   A. 回答:題目形狀正規化(multiSelect/custom)、toolUseID 對得上先前的
 *      tool-call、session 進入 waiting、wire 上的答案陣列(含自行輸入、多選拆回
 *      label)、tool-result 的 structuredResult、user-dialog-resolved 推播、回到 idle。
 *   B. 略過:每題送空陣列(不是 reject),回合照常 completed。
 *   C. 回答前中斷:工具以錯誤收場但仍帶題目;之後才送達的 dialog.resolve 不會
 *      再打 opencode(不產生 error 事件)。
 *   D. 有待答問題時刪除 session:不會卡住。
 *
 * 用法:
 *   node scripts/e2e-opencode-question.mjs
 *
 * 前置需求:pnpm build 已跑過。
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { QUESTION_PREFIX, TEST_QUESTIONS } from "./fake-opencode-server.mjs";
import { requireFreshBuild } from "./lib/require-fresh-build.mjs";
import { e2eProvidersEnv, FAKE_OPENCODE } from "./lib/e2e-providers.mjs";

requireFreshBuild();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const CORE_PORT = 4740;
const CORE_ENTRY = path.join(REPO_ROOT, "apps", "core", "dist", "index.js");
const [Q_COLOR, Q_FEATURES] = TEST_QUESTIONS.map((q) => q.question);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function killProcessTree(proc, label) {
  if (!proc || proc.exitCode !== null || proc.killed) return;
  console.log(`[cleanup] 終止 ${label}(pid=${proc.pid}) ...`);
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      proc.kill("SIGTERM");
    }
  } catch (err) {
    console.log(`[cleanup] 終止 ${label} 時發生錯誤(忽略): ${err}`);
  }
  await sleep(500);
}

/** 四個環境變數一起隔離(只設其中幾個會讀到開發者真實的 ~/.deskmony)。 */
function startCore(port, homeDir, dataDir, workspaceDir) {
  const env = {
    ...process.env,
    DESKMONY_CORE_PORT: String(port),
    DESKMONY_HOME: homeDir,
    DESKMONY_DATA_DIR: dataDir,
    DESKMONY_WORKSPACE: workspaceDir,
    // 2026-10-02(P2:移除 profile):fake 後端經 `DESKMONY_E2E_EXTRA_PROVIDERS` 注入(見 lib/e2e-providers.mjs)。
    ...e2eProvidersEnv(),
  };
  const proc = spawn(process.execPath, [CORE_ENTRY], { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  proc.stdout.on("data", (chunk) => process.stdout.write(`[core] ${chunk}`));
  proc.stderr.on("data", (chunk) => process.stderr.write(`[core:err] ${chunk}`));
  proc.on("exit", (code, signal) => console.log(`[core] process exited (code=${code} signal=${signal})`));
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
        ws.addEventListener("open", () => { clearTimeout(t); resolve(); });
        ws.addEventListener("error", () => { clearTimeout(t); reject(new Error("connect error")); });
      });
      ws.close();
      return;
    } catch (err) { lastErr = err; await sleep(300); }
  }
  throw new Error(`等待 gateway 啟動逾時: ${lastErr}`);
}

class GatewayClient {
  constructor(url) {
    this.url = url;
    this.pendingRpc = new Map();
    /** session-event 推播的 envelope。 */
    this.events = [];
    /** user-dialog-resolved 推播的 payload。 */
    this.dialogResolved = [];
    this.waiters = [];
  }

  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("WS connect timeout")), 10_000);
      this.ws.addEventListener("open", () => { clearTimeout(t); resolve(); });
      this.ws.addEventListener("error", (e) => { clearTimeout(t); reject(new Error(`WS error: ${e.message ?? e}`)); });
    });
    this.ws.addEventListener("message", (e) => this._handleMessage(e.data));
  }

  close() { try { this.ws?.close(); } catch {} }

  _handleMessage(raw) {
    let msg;
    try { msg = JSON.parse(typeof raw === "string" ? raw : raw.toString()); } catch { return; }
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
      } else if (msg.channel === "user-dialog-resolved") {
        this.dialogResolved.push(msg.payload);
      }
    }
  }

  rpc(method, params, timeoutMs = 30_000) {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pendingRpc.delete(id); reject(new Error(`rpc ${method} 逾時 (${timeoutMs}ms)`)); }, timeoutMs);
      this.pendingRpc.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  waitForEvent(predicate, timeoutMs, fromIndex = 0) {
    for (let i = fromIndex; i < this.events.length; i++) {
      if (predicate(this.events[i])) return Promise.resolve(this.events[i]);
    }
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.waiters = this.waiters.filter((w) => w !== waiter); reject(new Error(`等待事件逾時 (${timeoutMs}ms)`)); }, timeoutMs);
      const waiter = (ev) => { if (predicate(ev)) { clearTimeout(t); this.waiters = this.waiters.filter((w) => w !== waiter); resolve(ev); } };
      this.waiters.push(waiter);
    });
  }
}

async function sessionStatus(client, sessionId) {
  const { sessions } = await client.rpc("session.list", {});
  return sessions.find((s) => s.id === sessionId)?.status;
}

async function waitForStatus(client, sessionId, expected, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  let status;
  while (Date.now() < deadline) {
    status = await sessionStatus(client, sessionId);
    if (status === expected) return status;
    await sleep(100);
  }
  return status;
}

/** 送出提問 prompt,等到 `user-dialog-request`。回傳該事件、同一題的 tool-call 事件與起點 index。 */
async function askQuestion(client, sessionId, label) {
  const startIdx = client.events.length;
  await client.rpc("session.sendPrompt", { sessionId, prompt: { text: `${QUESTION_PREFIX} ${label}` } });
  const dialogEv = await client.waitForEvent(
    (e) => e.sessionId === sessionId && e.event.type === "user-dialog-request",
    15_000,
    startIdx,
  );
  const dialogIdx = client.events.indexOf(dialogEv);
  const toolCallIdx = client.events.findIndex(
    (e, i) => i >= startIdx && e.sessionId === sessionId && e.event.type === "tool-call" && e.event.toolName === "question",
  );
  return { startIdx, dialog: dialogEv.event, dialogIdx, toolCall: client.events[toolCallIdx]?.event, toolCallIdx };
}

async function waitForTurnEnd(client, sessionId, startIdx) {
  return client.waitForEvent(
    (e) => e.sessionId === sessionId && (e.event.type === "completed" || e.event.type === "error"),
    15_000,
    startIdx,
  );
}

function assistantText(client, sessionId, startIdx) {
  return client.events
    .slice(startIdx)
    .filter((e) => e.sessionId === sessionId && e.event.type === "message-delta")
    .map((e) => e.event.delta)
    .join("");
}

function toolResultOf(client, sessionId, startIdx, toolCallId) {
  return client.events
    .slice(startIdx)
    .find((e) => e.sessionId === sessionId && e.event.type === "tool-result" && e.event.toolCallId === toolCallId)?.event;
}

async function main() {
  if (!existsSync(CORE_ENTRY)) {
    console.error(`找不到 ${CORE_ENTRY},請先執行 pnpm build`);
    process.exit(1);
  }

  const homeDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-question-home-"));
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-question-data-"));
  const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-question-ws-"));

  let coreProc;
  let client;
  const startTime = Date.now();
  const results = [];

  function record(name, ok, detail) {
    results.push({ name, ok, detail });
    console.log(`\n[${ok ? "PASS" : "FAIL"}] ${name}`);
    if (detail) console.log(`       ${detail}`);
  }

  try {
    coreProc = startCore(CORE_PORT, homeDir, dataDir, workspaceDir);
    const gatewayUrl = `ws://localhost:${CORE_PORT}`;
    await waitForPort(gatewayUrl, 20_000);
    client = new GatewayClient(gatewayUrl);
    await client.connect();

    const { session } = await client.rpc("session.create", {
      providerId: FAKE_OPENCODE,
      workingDir: workspaceDir,
      title: "e2e-opencode-question",
    });
    const sessionId = session.id;
    console.log(`[setup] sessionId=${sessionId}`);

    // ---- A. 回答 ----
    try {
      const { startIdx, dialog, dialogIdx, toolCall, toolCallIdx } = await askQuestion(client, sessionId, "answer");

      const q = Array.isArray(dialog.questions) ? dialog.questions : [];
      const shapeOk =
        q.length === 2 &&
        q[0].question === Q_COLOR &&
        q[0].header === "Color" &&
        q[0].multiSelect === false &&
        q[1].multiSelect === true &&
        q.every((x) => x.custom === true) &&
        JSON.stringify(q[0].options) === JSON.stringify(TEST_QUESTIONS[0].options);
      record(
        "A1 question.asked 轉成 user-dialog-request,題目正規化(multiple→multiSelect、custom 預設允許)",
        shapeOk,
        `questions=${JSON.stringify(dialog.questions)}`,
      );

      record(
        "A2 toolUseID 對得上先前送出的 question tool-call(UI 靠它把表單接到對話串裡)",
        toolCall !== undefined && toolCallIdx < dialogIdx && dialog.toolUseID === toolCall.toolCallId,
        `toolUseID=${dialog.toolUseID}, tool-call=${toolCall?.toolCallId}(idx ${toolCallIdx} vs dialog idx ${dialogIdx})`,
      );

      const waiting = await waitForStatus(client, sessionId, "waiting");
      record("A3 待答期間 session.status = waiting", waiting === "waiting", `status=${waiting}`);

      const answers = { [Q_COLOR]: "Purple, but lighter", [Q_FEATURES]: "Alpha, Gamma" };
      await client.rpc("dialog.resolve", {
        sessionId,
        requestId: dialog.requestId,
        result: { behavior: "completed", result: { answers } },
      });
      const endEv = await waitForTurnEnd(client, sessionId, startIdx);

      const text = assistantText(client, sessionId, startIdx);
      const expectedWire = `[answers:${JSON.stringify([["Purple, but lighter"], ["Alpha", "Gamma"]])}]`;
      record(
        "A4 wire 上送給 opencode 的答案:自行輸入整串一個答案、多選拆回 label 陣列",
        text === expectedWire && endEv.event.type === "completed",
        `回覆=${JSON.stringify(text)}(預期 ${JSON.stringify(expectedWire)}), 最終事件=${endEv.event.type}`,
      );

      const result = toolResultOf(client, sessionId, startIdx, dialog.toolUseID);
      const sr = result?.structuredResult;
      record(
        "A5 tool-result 帶 {questions, answers}(已答畫面與 reload 後的歷史靠它顯示)",
        result?.isError === false &&
          JSON.stringify(sr?.answers) === JSON.stringify(answers) &&
          Array.isArray(sr?.questions) &&
          sr.questions.length === 2 &&
          sr.questions[1].multiSelect === true,
        `tool-result=${JSON.stringify(result)}`,
      );

      const pushed = client.dialogResolved.find((p) => p.sessionId === sessionId && p.requestId === dialog.requestId);
      record("A6 其他 client 收得到 user-dialog-resolved 推播", pushed !== undefined, `payload=${JSON.stringify(pushed)}`);

      const idle = await waitForStatus(client, sessionId, "idle");
      record("A7 回答後回合結束,session 回到 idle", idle === "idle", `status=${idle}`);
    } catch (err) {
      record("A 回答", false, String(err));
    }

    // ---- B. 略過 ----
    try {
      const { startIdx, dialog } = await askQuestion(client, sessionId, "skip");
      await client.rpc("dialog.resolve", { sessionId, requestId: dialog.requestId, result: { behavior: "cancelled" } });
      const endEv = await waitForTurnEnd(client, sessionId, startIdx);
      const text = assistantText(client, sessionId, startIdx);
      const result = toolResultOf(client, sessionId, startIdx, dialog.toolUseID);
      record(
        "B 略過:每題送空陣列(不是 reject),模型照常繼續、回合 completed",
        text === `[answers:${JSON.stringify([[], []])}]` &&
          endEv.event.type === "completed" &&
          result?.isError === false &&
          JSON.stringify(result?.structuredResult?.answers) === "{}",
        `回覆=${JSON.stringify(text)}, 最終事件=${endEv.event.type}, tool-result=${JSON.stringify(result)}`,
      );
    } catch (err) {
      record("B 略過", false, String(err));
    }

    // ---- C. 回答前中斷 ----
    try {
      const { startIdx, dialog } = await askQuestion(client, sessionId, "interrupt");
      await client.rpc("session.interrupt", { sessionId }, 20_000);
      const endEv = await waitForTurnEnd(client, sessionId, startIdx);
      const result = toolResultOf(client, sessionId, startIdx, dialog.toolUseID);
      record(
        "C1 中斷:工具以錯誤收場但仍帶題目,回合 completed(不是 error)",
        endEv.event.type === "completed" &&
          result?.isError === true &&
          result?.output === "Tool execution aborted" &&
          Array.isArray(result?.structuredResult?.questions),
        `最終事件=${endEv.event.type}, tool-result=${JSON.stringify(result)}`,
      );

      // 使用者在畫面還沒更新前按下送出:adapter 已經清掉這筆待答,不該再打
      // opencode(打了會拿到 404,轉成 error 事件把 session 標成 error)。
      const afterIdx = client.events.length;
      await client.rpc("dialog.resolve", {
        sessionId,
        requestId: dialog.requestId,
        result: { behavior: "completed", result: { answers: { [Q_COLOR]: "Red" } } },
      });
      await sleep(1_000);
      const lateError = client.events.slice(afterIdx).find((e) => e.sessionId === sessionId && e.event.type === "error");
      const status = await sessionStatus(client, sessionId);
      record(
        "C2 中斷後才送達的 dialog.resolve 是 no-op(沒有 error 事件,session 維持 idle)",
        lateError === undefined && status === "idle",
        `error=${JSON.stringify(lateError?.event)}, status=${status}`,
      );
    } catch (err) {
      record("C 回答前中斷", false, String(err));
    }

    // ---- D. 有待答問題時刪除 session ----
    try {
      await askQuestion(client, sessionId, "delete");
      const started = Date.now();
      await client.rpc("session.delete", { sessionId }, 15_000);
      const { sessions } = await client.rpc("session.list", {});
      record(
        "D 有待答問題時 session.delete 不會卡住",
        !sessions.some((s) => s.id === sessionId),
        `耗時 ${Date.now() - started}ms`,
      );
    } catch (err) {
      record("D 有待答問題時刪除 session", false, String(err));
    }
  } catch (err) {
    console.error(`\n[FATAL] ${err instanceof Error ? err.message : String(err)}`);
    record("setup", false, String(err));
  } finally {
    if (client) client.close();
    await killProcessTree(coreProc, "core");
    for (const dir of [homeDir, dataDir, workspaceDir]) {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n${"=".repeat(50)}`);
  console.log(`OpenCode question e2e 結果 (${elapsed}s)`);
  console.log(`${"=".repeat(50)}`);
  let pass = 0;
  let fail = 0;
  for (const r of results) {
    console.log(`  ${r.ok ? "PASS" : "FAIL"} ${r.name}`);
    if (r.ok) pass++; else fail++;
  }
  console.log(`\n總計: ${pass} PASS, ${fail} FAIL`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
