#!/usr/bin/env node
/**
 * scripts/e2e-session-subagents.mjs
 *
 * S12(session-subagent)端到端測試:驗證 child subagent session 的
 * 建立(含 prompt)→ completed → child-result push → 結果被當 prompt 注入
 * 父 session(父據此又跑一輪、最終回到 idle)完整生命週期**且 child 不被
 * auto-dispose**,全程不依賴真實模型。
 *
 * 使用 software="acp" + scripts/fake-acp-agent.mjs 做決定性後端。
 *
 * 用法:
 *   node scripts/e2e-session-subagents.mjs
 *
 * 前置需求:
 *   - pnpm build 已跑過(apps/core/dist/index.js 存在)
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const CORE_PORT = 5321;
const PERMISSION_TIMEOUT_MS = 10_000;
const CORE_ENTRY = path.join(REPO_ROOT, "apps", "core", "dist", "index.js");
const FAKE_ACP_REPLY_TEXT = "Hello from fake ACP agent";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * S12 Phase2 用:等父 session 歷史出現「注入的子結果」(一則含 `子 agent` 與
 * 子 finalText 的 user 訊息),且它後面緊接著出現一則 assistant 回覆(代表注入
 * 的 prompt 真的餵給了父、父據此又跑了一輪)。用 poll 而非 drivePrompt——注入
 * 是由 core 內部觸發的,不走 gateway 的 sendPrompt。回傳命中時該兩則訊息。
 */
async function waitForParentInjection(client, parentId, finalText, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { messages } = await client.rpc("session.history", { sessionId: parentId });
    const userIdx = messages.findIndex(
      (m) => m.role === "user" && m.content.includes("子 agent") && m.content.includes(finalText),
    );
    if (userIdx >= 0) {
      const assistantAfter = messages.slice(userIdx + 1).find((m) => m.role === "assistant");
      if (assistantAfter) return { userMsg: messages[userIdx], assistantAfter };
    }
    await sleep(250);
  }
  return { userMsg: undefined, assistantAfter: undefined };
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

function startCore(port, dataDir, workspaceDir) {
  const env = {
    ...process.env,
    DESKMONY_CORE_PORT: String(port),
    DESKMONY_DATA_DIR: dataDir,
    DESKMONY_WORKSPACE: workspaceDir,
    DESKMONY_PERMISSION_TIMEOUT_MS: String(PERMISSION_TIMEOUT_MS),
  };
  const proc = spawn(process.execPath, [CORE_ENTRY], { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  proc.stdout.on("data", (chunk) => process.stdout.write(`[core] ${chunk}`));
  proc.stderr.on("data", (chunk) => process.stderr.write(`[core:err] ${chunk}`));
  proc.on("exit", (code, signal) => {
    console.log(`[core] process exited (code=${code} signal=${signal})`);
  });
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
      return true;
    } catch (err) { lastErr = err; await sleep(300); }
  }
  throw new Error(`等待 gateway 啟動逾時: ${lastErr}`);
}

class GatewayClient {
  constructor(url) {
    this.url = url;
    this.pendingRpc = new Map();
    this.events = [];
    this.childResults = [];
    this.waiters = [];
    this.childResultWaiters = [];
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
      } else if (msg.channel === "child-result") {
        this.childResults.push(msg.payload);
        for (const w of [...this.childResultWaiters]) w(msg.payload);
      }
    }
  }

  rpc(method, params, timeoutMs = 30_000) {
    const id = randomUUID();
    const payload = { id, method, params };
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pendingRpc.delete(id); reject(new Error(`rpc ${method} 逾時 (${timeoutMs}ms)`)); }, timeoutMs);
      this.pendingRpc.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      this.ws.send(JSON.stringify(payload));
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

  waitForChildResult(timeoutMs = 30_000) {
    if (this.childResults.length > 0) return Promise.resolve(this.childResults[0]);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { reject(new Error(`等待 child-result 事件逾時 (${timeoutMs}ms)`)); }, timeoutMs);
      const waiter = (payload) => { clearTimeout(t); resolve(payload); };
      this.childResultWaiters.push(waiter);
    });
  }

  async drivePrompt(sessionId, text, { onPermission, timeoutMs = 90_000 } = {}) {
    const startIdx = this.events.length;
    await this.rpc("session.sendPrompt", { sessionId, prompt: { text } });
    let cursor = startIdx;
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`逾時等待 completed/error 事件`);
      const ev = await this.waitForEvent((e) => e.sessionId === sessionId, remaining, cursor);
      cursor = this.events.indexOf(ev) + 1;
      if (ev.event.type === "permission-request" && onPermission) {
        const decision = await onPermission(ev.event);
        if (decision === "allow" || decision === "deny") {
          await this.rpc("permission.resolve", { requestId: ev.event.requestId, decision });
        }
      } else if (ev.event.type === "completed" || ev.event.type === "error") {
        return { finalEvent: ev, collected: this.events.slice(startIdx, cursor) };
      }
    }
  }
}

async function main() {
  if (!existsSync(CORE_ENTRY)) {
    console.error(`找不到 ${CORE_ENTRY},請先執行 pnpm build`);
    process.exit(1);
  }

  const dataDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-s12-data-"));
  const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-s12-ws-"));
  const fakeAgentPath = path.join(REPO_ROOT, "scripts", "fake-acp-agent.mjs");

  let coreProc;
  let client;
  let parentId;
  let childId;

  const startTime = Date.now();
  const results = [];

  function record(name, ok, detail) {
    results.push({ name, ok, detail });
    const tag = ok ? "PASS" : "FAIL";
    console.log(`\n[${tag}] ${name}`);
    if (detail) console.log(`       ${detail}`);
  }

  try {
    console.log(`[setup] dataDir = ${dataDir}`);
    console.log(`[setup] workspaceDir = ${workspaceDir}`);
    console.log(`[setup] fake-acp-agent = ${fakeAgentPath}`);

    // ---- 啟動 core ----
    coreProc = startCore(CORE_PORT, dataDir, workspaceDir);
    const gatewayUrl = `ws://localhost:${CORE_PORT}`;
    await waitForPort(gatewayUrl, 20_000);

    // ---- 連線 ----
    client = new GatewayClient(gatewayUrl);
    await client.connect();
    console.log("[setup] WS connected");

    // ---- 建立 fake-acp-agent 的 AgentProfile (software="acp") ----
    const { profile } = await client.rpc("profile.create", {
      name: "E2E S12 Parent",
      software: "acp",
      workingDir: workspaceDir,
      acpConfig: { command: process.execPath, args: [fakeAgentPath] },
    });
    record("建立 AgentProfile(software=acp)", true, `profileId=${profile.id}`);

    // ---- 建立 parent session ----
    const parentCreated = await client.rpc("session.create", {
      agentProfileId: profile.id,
      workingDir: workspaceDir,
      title: "e2e-s12-parent",
    });
    parentId = parentCreated.session.id;
    record("建立 parent session,parentSessionId 為 undefined(頂層)",
      parentCreated.session.parentSessionId === undefined,
      `sessionId=${parentId}, parentSessionId=${parentCreated.session.parentSessionId}`);

    // ---- 監聽 child-result ----
    const childResultPromise = client.waitForChildResult(30_000);

    // ---- session.spawnChild (一次呼叫含 prompt) ----
    let spawned;
    try {
      spawned = await client.rpc("session.spawnChild", {
        parentSessionId: parentId,
        agentProfileId: profile.id,
        prompt: "請執行 E2E 測試任務",
      });
      childId = spawned.session.id;
      // 斷言 A: child.parentSessionId === parentId
      // 斷言 B: child.id !== parentId
      const okA = spawned.session.parentSessionId === parentId;
      const okB = spawned.session.id !== parentId;
      record(
        `斷言 A/B: spawnChild 回傳 child, parentSessionId 正確, id 不同`,
        okA && okB,
        `childId=${childId}, parentSessionId=${spawned.session.parentSessionId}`,
      );
    } catch (err) {
      record(`斷言 A/B: spawnChild`, false, String(err));
      throw err;
    }

    // ---- 等待 child-result push (逾時 15s) ----
    let childResultPayload;
    try {
      childResultPayload = await childResultPromise;
      // 斷言 C: payload.parentSessionId === parentId
      // 斷言 D: payload.childSessionId === childId
      // 斷言 E: payload.finalText 含 "Hello from fake ACP agent"
      const okC = childResultPayload.parentSessionId === parentId;
      const okD = childResultPayload.childSessionId === childId;
      const okE = typeof childResultPayload.finalText === "string" &&
                  childResultPayload.finalText.includes(FAKE_ACP_REPLY_TEXT);
      record(
        `斷言 C/D/E: child-result push 形狀正確, finalText 含 "${FAKE_ACP_REPLY_TEXT}"`,
        okC && okD && okE,
        `payload=${JSON.stringify(childResultPayload)}`,
      );
    } catch (err) {
      record(`斷言 C/D/E: child-result push`, false, String(err));
    }

    // ---- 斷言 F: 子結果被注入父 session → 父歷史出現含子 finalText 的
    // user 訊息 + 父隨後又產生 assistant 回覆 ----
    try {
      const { userMsg, assistantAfter } = await waitForParentInjection(client, parentId, FAKE_ACP_REPLY_TEXT, 15_000);
      const okF = !!userMsg && !!assistantAfter;
      record(
        "斷言 F: 子結果被注入父 session → 父歷史含「子 agent」+子 finalText 的 user 訊息,且父隨後又產生 assistant 回覆",
        okF,
        userMsg
          ? `user.content=${JSON.stringify(userMsg.content)}, assistant.content=${JSON.stringify(assistantAfter?.content)}`
          : "父歷史未出現注入的 user 訊息(或尚未等到後續 assistant 回覆)",
      );
    } catch (err) {
      record("斷言 F: 子結果注入父 session", false, String(err));
    }

    // ---- 斷言 G: session.list 同時含 parent 與 child, child 非 auto-dispose ----
    try {
      const { sessions } = await client.rpc("session.list", {});
      const parentInList = sessions.find((s) => s.id === parentId);
      const childInList = sessions.find((s) => s.id === childId);
      const okG = parentInList && childInList &&
                  childInList.parentSessionId === parentId &&
                  childInList.status === "idle";
      record(
        "斷言 G: session.list 同時含 parent 與 child, child.status=idle(未被 auto-dispose)",
        okG,
        `parent=${!!parentInList}, child=${!!childInList}, status=${childInList?.status}`,
      );
    } catch (err) {
      record("斷言 G: session.list 含 parent+child", false, String(err));
    }

    // ---- 斷言 H: 沒有建立任何 team/task ----
    try {
      const { teams } = await client.rpc("team.list", {});
      const { sessions } = await client.rpc("session.list", {});
      // 確認 session 清單裡 parent 與 child 都在
      const parentOk = sessions.some((s) => s.id === parentId);
      const childOk = sessions.some((s) => s.id === childId);
      const okH = teams.length === 0 && parentOk && childOk;
      record(
        "斷言 H: 沒有建立任何 team/task, parent 與 child 均在 session.list 中",
        okH,
        `teams=${teams.length}`,
      );
    } catch (err) {
      record("斷言 H: 無 team/task", false, String(err));
    }

    // ---- 斷言 I: 最終父 session 回到 idle(注入後不會無限迴圈/卡 busy) ----
    try {
      const deadline = Date.now() + 10_000;
      let parentStatus;
      while (Date.now() < deadline) {
        const { sessions } = await client.rpc("session.list", {});
        parentStatus = sessions.find((s) => s.id === parentId)?.status;
        if (parentStatus === "idle") break;
        await sleep(250);
      }
      const okI = parentStatus === "idle";
      record(
        "斷言 I: 最終父 session 回到 idle(注入沒有造成無限迴圈/卡在 busy)",
        okI,
        `parent.status=${parentStatus}`,
      );
    } catch (err) {
      record("斷言 I: 父 session 回到 idle", false, String(err));
    }
  } catch (err) {
    console.error(`\n[FATAL] ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    if (client) client.close();
    await killProcessTree(coreProc, "core");
    try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
    try { rmSync(workspaceDir, { recursive: true, force: true }); } catch {}
  }

  // ---- 結果統計 ----
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n${"=".repeat(50)}`);
  console.log(`S12(session-subagent) e2e 結果 (${elapsed}s)`);
  console.log(`${"=".repeat(50)}`);
  let pass = 0;
  let fail = 0;
  for (const r of results) {
    console.log(`  ${r.ok ? "PASS" : "FAIL"} ${r.name}`);
    if (r.detail) console.log(`       ${r.detail}`);
    if (r.ok) pass++; else fail++;
  }
  console.log(`\n總計: ${pass} PASS, ${fail} FAIL`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
