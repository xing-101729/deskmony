#!/usr/bin/env node
/**
 * scripts/e2e-crash-recovery.mjs
 *
 * S6(crash-recovery / 崩潰復原:對帳 + 人工分流)端到端驗證,對應
 * docs/LAYER-4-detail-design/crash-recovery_detail.md §8 檢查清單最後一項。
 *
 * 沿用 scripts/e2e-cost-governor.mjs 的手法(真實 WS Gateway + fake ACP agent,
 * 決定性、不依賴真實模型行為),獨立可執行,不 import 其他 e2e 腳本。
 *
 * ⚠️ 本規格的驗收標準(見 crash-recovery_detail.md 開頭):**`closed` 與
 * `interrupted` 必須能被 e2e 明確區分**——這是測試 A 的核心,其餘測試建立在
 * 這個區分之上。
 *
 * 涵蓋:
 *   A. 核心驗收標準:正常關閉(優雅) → closed 且不出現在復原視圖;
 *      kill -9(強制終止) → interrupted 且出現在復原視圖;同時驗證
 *      idle/busy/waiting 三種狀態都算孤兒,error/closed 兩種既有終態不受對帳
 *      影響(§3)。
 *   B. §4.1:ACP 後端 canContinue=false,`recovery.continue` 明確拒絕(不靜默
 *      退化)。
 *   C. §5.2「放棄」:標記 closed,對話紀錄保留(回收 ≠ 丟棄)。
 *   D. §4.2「接手」:新 session + 注入摘要(只讀 DB,內容含關鍵欄位),
 *      舊 session 收尾成 closed。
 *
 * 2026-10-02(P1:移除 team/task/看板,見 docs/DECISIONS.md §H):原本的 E(髒
 * worktree 對「重跑」的強制流程)與 F(`merging` 中崩潰)是任務 git worktree
 * 專用機制,隨 task 一併移除;`recovery.rerun`/`recovery.gitStatus`/
 * `recovery.resolveDirtyWorktree` 三個方法也已不存在。
 *
 * 前置需求:`pnpm build` 已跑過。
 * 用法:node scripts/e2e-crash-recovery.mjs
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WRITE_FILE_PREFIX, SLEEP_TURN_PREFIX } from "./fake-acp-agent.mjs";
import { requireFreshBuild } from "./lib/require-fresh-build.mjs";

// 2026-09-04(稽核修補):在啟動 core 之前確認 dist/ 不比 src/ 舊。
// 這支 e2e 測的是編譯產物,忘記先 pnpm build 的話會安靜地驗證舊程式碼並全綠
// —— 見 scripts/lib/require-fresh-build.mjs 的完整說明。
requireFreshBuild();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const FAKE_AGENT_PATH = path.join(REPO_ROOT, "scripts", "fake-acp-agent.mjs");
const CORE_ENTRY = path.join(REPO_ROOT, "apps", "core", "dist", "index.js");
const GRACEFUL_BOOTSTRAP = path.join(REPO_ROOT, "scripts", "e2e-crash-recovery-graceful-bootstrap.mjs");
// better-sqlite3 不是這個 script 所在目錄的直接依賴,借用 apps/core 已安裝好的
// 那一份(實作當下的自行判斷,repo 外無紀錄)——只用來做測試專用的「插入既有 error/
// closed 紀錄」與偶爾的直接查詢,production 程式碼完全不受影響。
const BETTER_SQLITE3_PATH = path.join(REPO_ROOT, "apps", "core", "node_modules", "better-sqlite3", "lib", "index.js");

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
  constructor(url, token) {
    this.url = url;
    this.token = token;
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
    this.ws.addEventListener("message", (e) => this._handleMessage(e.data));
    if (this.token !== undefined) {
      await this.rpc("auth", { token: this.token });
    }
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
      } else if (msg.channel === "session-updated") {
        this.sessionUpdates.push(msg.payload);
      }
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

  waitFor(arr, predicate, timeoutMs, fromIndex = 0) {
    for (let i = fromIndex; i < arr.length; i++) {
      if (predicate(arr[i])) return Promise.resolve(arr[i]);
    }
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const poll = setInterval(() => {
        for (let i = fromIndex; i < arr.length; i++) {
          if (predicate(arr[i])) {
            clearInterval(poll);
            resolve(arr[i]);
            return;
          }
        }
        if (Date.now() - start > timeoutMs) {
          clearInterval(poll);
          reject(new Error(`等待逾時 (${timeoutMs}ms),目前筆數=${arr.length}`));
        }
      }, 50);
    });
  }

  waitForEvent(predicate, timeoutMs, fromIndex = 0) {
    return this.waitFor(this.events, predicate, timeoutMs, fromIndex);
  }
  waitForSessionUpdate(predicate, timeoutMs, fromIndex = 0) {
    return this.waitFor(this.sessionUpdates, predicate, timeoutMs, fromIndex);
  }
}

function startCore({ port, dataDir, homeDir, workspaceDir, extraEnv }) {
  const env = {
    ...process.env,
    DESKMONY_CORE_PORT: String(port),
    DESKMONY_DATA_DIR: dataDir,
    DESKMONY_HOME: homeDir,
    DESKMONY_WORKSPACE: workspaceDir,
    ...extraEnv,
  };
  const proc = spawn(process.execPath, [CORE_ENTRY], { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  proc.stdout.on("data", (chunk) => process.stdout.write(`[core:${port}] ${chunk}`));
  proc.stderr.on("data", (chunk) => process.stderr.write(`[core:${port}:err] ${chunk}`));
  return proc;
}

/** 見 e2e-crash-recovery-graceful-bootstrap.mjs 頂端註解——用 IPC 而非 OS 訊號
 *  可靠地觸發真正的優雅關閉 handler。 */
function startCoreGraceful({ port, dataDir, homeDir, workspaceDir, extraEnv }) {
  const env = {
    ...process.env,
    DESKMONY_CORE_PORT: String(port),
    DESKMONY_DATA_DIR: dataDir,
    DESKMONY_HOME: homeDir,
    DESKMONY_WORKSPACE: workspaceDir,
    ...extraEnv,
  };
  const proc = spawn(process.execPath, [GRACEFUL_BOOTSTRAP], {
    cwd: REPO_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  proc.stdout.on("data", (chunk) => process.stdout.write(`[core-graceful:${port}] ${chunk}`));
  proc.stderr.on("data", (chunk) => process.stderr.write(`[core-graceful:${port}:err] ${chunk}`));
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

/** 模擬崩潰(kill -9):見 bootstrap 檔案頂端註解的實測結論——在這台 Windows
 *  機器上,child_process 對子行程的 kill 一律等同無條件強制終止,子行程完全
 *  沒有機會執行自己的訊號 handler,這正是「崩潰」該有的行為。 */
async function killProcessTreeHard(proc) {
  if (!proc || proc.exitCode !== null || proc.killed) return;
  const exitPromise = new Promise((resolve) => proc.once("exit", resolve));
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      proc.kill("SIGKILL");
    }
  } catch {
    // ignore
  }
  await Promise.race([exitPromise, sleep(3000)]);
}

/** 送 IPC 訊息觸發真正的優雅關閉,等子行程自己 `process.exit(0)`。 */
async function gracefulShutdown(proc, timeoutMs = 10_000) {
  const exitPromise = new Promise((resolve) => proc.once("exit", resolve));
  proc.send("graceful-shutdown");
  const exited = await Promise.race([exitPromise.then(() => true), sleep(timeoutMs).then(() => false)]);
  return exited;
}

async function createAcpSession(client, workspaceDir, title, extra = {}) {
  const { profile } = await client.rpc("profile.create", {
    name: `E2E ${title}`,
    software: "acp",
    workingDir: workspaceDir,
    acpConfig: { command: process.execPath, args: [FAKE_AGENT_PATH] },
    permissionLevel: "always-ask",
    ...extra.profileFields,
  });
  const { session } = await client.rpc(
    "session.create",
    { agentProfileId: profile.id, workingDir: workspaceDir, title },
    30_000,
  );
  return { profileId: profile.id, sessionId: session.id };
}

function rmDirs(dirs) {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

/** 測試專用:直接開 sqlite 檔案插入一筆既有的 error/closed 紀錄——驗證對帳
 *  「只碰 idle/busy/waiting,不碰 error/closed」這個範圍界線本身(不能只靠
 *  正常流程走出 error/closed 狀態太麻煩且不夠決定性,直接插入最乾脆)。 */
async function insertSyntheticSessionRow(dataDir, { id, status }) {
  const { default: Database } = await import(pathToFileURL(BETTER_SQLITE3_PATH).href);
  const dbPath = path.join(dataDir, "deskmony.db");
  const db = new Database(dbPath);
  try {
    const now = Date.now();
    db.prepare(
      `INSERT INTO sessions (id, title, agent_profile_id, adapter_type, status, working_dir, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, `synthetic-${status}`, "synthetic-profile", "acp", status, "/tmp/synthetic", now, now);
  } finally {
    db.close();
  }
}

async function readAuditKinds(dataDir) {
  const { default: Database } = await import(pathToFileURL(BETTER_SQLITE3_PATH).href);
  const dbPath = path.join(dataDir, "deskmony.db");
  const db = new Database(dbPath);
  try {
    return db.prepare(`SELECT kind, reason, payload FROM enforcement_audit WHERE kind = 'recovery-reconcile'`).all();
  } finally {
    db.close();
  }
}

// =======================================================================
// A(核心驗收標準):正常關閉 → closed 且不出現在復原視圖;kill -9 →
// interrupted 且出現在復原視圖;idle/busy/waiting 皆算孤兒,error/closed 不變。
// =======================================================================
async function testShutdownVsCrash() {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-recov-a-data-"));
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-recov-a-home-"));
  const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-recov-a-ws-"));

  let coreA, coreB, client;
  try {
    // ---- 先起一個 core,建立 idle / busy / waiting 三種狀態的 session -----
    coreA = startCore({ port: 4380, dataDir, homeDir, workspaceDir });
    await waitForPort("ws://127.0.0.1:4380", 20_000);
    client = new MiniGatewayClient("ws://127.0.0.1:4380");
    await client.connect();

    // idle:送一個一般 prompt,等 completed。
    const { sessionId: idleId } = await createAcpSession(client, workspaceDir, "A-idle");
    const idleStart = client.events.length;
    await client.rpc("session.sendPrompt", { sessionId: idleId, prompt: { text: "hello" } });
    await client.waitForEvent((e) => e.sessionId === idleId && e.event.type === "completed", 15_000, idleStart);
    await sleep(200);

    // busy:送一個長睡眠回合,不等結束就讓它繼續掛著。
    const { sessionId: busyId } = await createAcpSession(client, workspaceDir, "A-busy");
    void client.rpc("session.sendPrompt", { sessionId: busyId, prompt: { text: `${SLEEP_TURN_PREFIX}${JSON.stringify({ ms: 60_000 })}` } });
    await client.waitForSessionUpdate((u) => u.id === busyId && u.status === "busy", 5_000);

    // waiting:觸發一個未分類的 escalate(default-deny 無規則命中),不回覆,
    // 留在 waiting。
    const { sessionId: waitingId } = await createAcpSession(client, workspaceDir, "A-waiting");
    const targetFile = path.join(workspaceDir, "a-waiting.txt");
    const posixPath = targetFile.split(path.sep).join("/");
    const waitingStart = client.events.length;
    await client.rpc("session.sendPrompt", {
      sessionId: waitingId,
      prompt: { text: `${WRITE_FILE_PREFIX}${JSON.stringify({ path: posixPath, content: "x" })}` },
    });
    await client.waitForEvent((e) => e.sessionId === waitingId && e.event.type === "permission-request", 15_000, waitingStart);
    await client.waitForSessionUpdate((u) => u.id === waitingId && u.status === "waiting", 5_000);

    // ---- kill -9(見 killProcessTreeHard 頂端註解:等同無條件強制終止,
    // shutdown handler 完全沒機會跑,這正是崩潰情境) ----
    client.close();
    await killProcessTreeHard(coreA);

    // 插入既有的 error/closed 紀錄,驗證對帳只碰 idle/busy/waiting。
    const syntheticErrorId = `synthetic-error-${randomUUID()}`;
    const syntheticClosedId = `synthetic-closed-${randomUUID()}`;
    await insertSyntheticSessionRow(dataDir, { id: syntheticErrorId, status: "error" });
    await insertSyntheticSessionRow(dataDir, { id: syntheticClosedId, status: "closed" });

    // ---- 重啟一個全新的 core,指向同一個 dataDir/homeDir → 觸發啟動對帳 ----
    coreB = startCore({ port: 4381, dataDir, homeDir, workspaceDir });
    await waitForPort("ws://127.0.0.1:4381", 20_000);
    const clientB = new MiniGatewayClient("ws://127.0.0.1:4381");
    await clientB.connect();

    const { sessions } = await clientB.rpc("session.list", {});
    const byId = Object.fromEntries(sessions.map((s) => [s.id, s]));

    const idleInterrupted = byId[idleId]?.status === "interrupted";
    const busyInterrupted = byId[busyId]?.status === "interrupted";
    const waitingInterrupted = byId[waitingId]?.status === "interrupted";
    const errorUnchanged = byId[syntheticErrorId]?.status === "error";
    const closedUnchanged = byId[syntheticClosedId]?.status === "closed";
    const timestampsPopulated =
      typeof byId[idleId]?.interruptedAt === "number" && typeof byId[idleId]?.lastSeenAt === "number";

    record(
      "A1(核心驗收標準:kill -9): idle/busy/waiting 三種狀態的 session 崩潰後重啟都被對帳標記為 interrupted;既有的 error/closed 紀錄不受影響;interruptedAt/lastSeenAt 有值",
      idleInterrupted && busyInterrupted && waitingInterrupted && errorUnchanged && closedUnchanged && timestampsPopulated,
      `idle=${byId[idleId]?.status}, busy=${byId[busyId]?.status}, waiting=${byId[waitingId]?.status}, ` +
        `error=${byId[syntheticErrorId]?.status}, closed=${byId[syntheticClosedId]?.status}, ` +
        `interruptedAt=${byId[idleId]?.interruptedAt}, lastSeenAt=${byId[idleId]?.lastSeenAt}`,
    );

    const { sessions: recoverySessions } = await clientB.rpc("recovery.list", {});
    const recoveryIds = new Set(recoverySessions.map((s) => s.sessionId));
    const allThreeInRecovery = recoveryIds.has(idleId) && recoveryIds.has(busyId) && recoveryIds.has(waitingId);
    const syntheticNotInRecovery = !recoveryIds.has(syntheticErrorId) && !recoveryIds.has(syntheticClosedId);
    const allCanContinueFalse = recoverySessions
      .filter((s) => recoveryIds.has(s.sessionId))
      .every((s) => s.canContinue === false); // ACP 後端,§4.1 查證結論:不支援「繼續」

    record(
      "A2(核心驗收標準:kill -9 → 出現在復原視圖): recovery.list 包含三個崩潰的 session,不包含既有 error/closed 紀錄,且 ACP 後端 canContinue 皆為 false",
      allThreeInRecovery && syntheticNotInRecovery && allCanContinueFalse,
      `recoveryIds=${[...recoveryIds].join(",")}, allCanContinueFalse=${allCanContinueFalse}`,
    );

    const auditRows = await readAuditKinds(dataDir);
    const auditRecorded = auditRows.length >= 1 && JSON.parse(auditRows[0].payload).count >= 3;
    record(
      "A3(§6.3 稽核): 啟動對帳寫入一筆 kind=recovery-reconcile 的 enforcement_audit 紀錄,count>=3",
      auditRecorded,
      `auditRows=${JSON.stringify(auditRows)}`,
    );

    clientB.close();
    await killProcessTreeHard(coreB);
    coreB = null;
  } catch (err) {
    record("A 執行過程發生未預期錯誤", false, String(err));
  } finally {
    client?.close();
    await killProcessTreeHard(coreA);
    if (coreB) await killProcessTreeHard(coreB);
  }

  rmDirs([dataDir, homeDir, workspaceDir]);
}

// =======================================================================
// A'(核心驗收標準的另一半):正常關閉(優雅) → closed,且不出現在復原視圖。
// =======================================================================
async function testGracefulShutdown() {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-recov-a2-data-"));
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-recov-a2-home-"));
  const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-recov-a2-ws-"));

  let coreC, coreD, client;
  try {
    coreC = startCoreGraceful({ port: 4382, dataDir, homeDir, workspaceDir });
    await waitForPort("ws://127.0.0.1:4382", 20_000);
    client = new MiniGatewayClient("ws://127.0.0.1:4382");
    await client.connect();

    const { sessionId } = await createAcpSession(client, workspaceDir, "A2-graceful");
    const startIdx = client.events.length;
    await client.rpc("session.sendPrompt", { sessionId, prompt: { text: "hello" } });
    await client.waitForEvent((e) => e.sessionId === sessionId && e.event.type === "completed", 15_000, startIdx);
    await sleep(200);

    client.close();
    const exitedCleanly = await gracefulShutdown(coreC, 10_000);
    coreC = null;

    coreD = startCore({ port: 4383, dataDir, homeDir, workspaceDir });
    await waitForPort("ws://127.0.0.1:4383", 20_000);
    const clientD = new MiniGatewayClient("ws://127.0.0.1:4383");
    await clientD.connect();

    const { sessions } = await clientD.rpc("session.list", {});
    const closedStatus = sessions.find((s) => s.id === sessionId)?.status;

    const { sessions: recoverySessions } = await clientD.rpc("recovery.list", {});
    const notInRecovery = !recoverySessions.some((s) => s.sessionId === sessionId);

    record(
      "A'(核心驗收標準:正常關閉 → closed 且不出現在復原視圖): 優雅關閉(process.emit('SIGTERM') 觸發真正的 shutdown handler)後子行程自行退出,重啟後該 session 狀態是 closed(不是 interrupted),recovery.list 不包含它",
      exitedCleanly && closedStatus === "closed" && notInRecovery,
      `exitedCleanly=${exitedCleanly}, status=${closedStatus}, notInRecovery=${notInRecovery}`,
    );

    clientD.close();
    await killProcessTreeHard(coreD);
    coreD = null;
  } catch (err) {
    record("A' 執行過程發生未預期錯誤", false, String(err));
  } finally {
    client?.close();
    if (coreC) await killProcessTreeHard(coreC);
    if (coreD) await killProcessTreeHard(coreD);
  }

  rmDirs([dataDir, homeDir, workspaceDir]);
}

// =======================================================================
// B + C + D:§4.1(continue 明確拒絕)/ §5.2(放棄,回收 ≠ 丟棄)/ §4.2(接手,
// 摘要內容)。三個動作互不影響,共用同一批崩潰後的 session,省一次崩潰流程。
// =======================================================================
async function testContinueAbandonTakeover() {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-recov-bcd-data-"));
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-recov-bcd-home-"));
  const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-recov-bcd-ws-"));

  let coreA, coreB, client;
  try {
    coreA = startCore({ port: 4384, dataDir, homeDir, workspaceDir });
    await waitForPort("ws://127.0.0.1:4384", 20_000);
    client = new MiniGatewayClient("ws://127.0.0.1:4384");
    await client.connect();

    const { sessionId: sessionForContinue } = await createAcpSession(client, workspaceDir, "B-continue-target");
    const { sessionId: sessionForAbandon } = await createAcpSession(client, workspaceDir, "C-abandon-target");
    const { sessionId: sessionForTakeover } = await createAcpSession(client, workspaceDir, "D-takeover-target");

    for (const sid of [sessionForContinue, sessionForAbandon, sessionForTakeover]) {
      const idx = client.events.length;
      await client.rpc("session.sendPrompt", { sessionId: sid, prompt: { text: "some prior work happened here" } });
      await client.waitForEvent((e) => e.sessionId === sid && e.event.type === "completed", 15_000, idx);
    }
    await sleep(200);

    client.close();
    await killProcessTreeHard(coreA);
    coreA = null;

    coreB = startCore({ port: 4385, dataDir, homeDir, workspaceDir });
    await waitForPort("ws://127.0.0.1:4385", 20_000);
    const clientB = new MiniGatewayClient("ws://127.0.0.1:4385");
    await clientB.connect();

    // ---- B: §4.1 continue 明確拒絕(ACP 不支援「繼續」)---------------------
    let continueRejected = false;
    let continueErr = "";
    try {
      await clientB.rpc("recovery.continue", { sessionId: sessionForContinue });
    } catch (err) {
      continueRejected = true;
      continueErr = String(err);
    }
    record(
      "B(§4.1: 不支援「繼續」的後端明確拒絕,不靜默退化): ACP 後端的 interrupted session 呼叫 recovery.continue 得到明確錯誤",
      continueRejected,
      `continueRejected=${continueRejected}, err=${continueErr}`,
    );

    // ---- C: §5.2 放棄——標記 closed,對話紀錄保留(驗證 session 本身的收尾
    // 語意 + 訊息歷史保留) ----
    await clientB.rpc("recovery.abandon", { sessionId: sessionForAbandon });
    const { sessions: afterAbandon } = await clientB.rpc("session.list", {});
    const abandonedStatus = afterAbandon.find((s) => s.id === sessionForAbandon)?.status;
    const { sessions: recoveryAfterAbandon } = await clientB.rpc("recovery.list", {});
    const abandonedGoneFromRecovery = !recoveryAfterAbandon.some((s) => s.sessionId === sessionForAbandon);
    const { messages: abandonedHistory } = await clientB.rpc("session.history", { sessionId: sessionForAbandon });
    const historyPreserved = abandonedHistory.length > 0; // DB 紀錄仍在,不是被 deleteSession() 那種整筆刪除

    record(
      "C(§5.2「放棄」= 回收 ≠ 丟棄): session 標記為 closed、離開復原視圖,但 session/messages 的 DB 紀錄仍保留(不是整筆刪除)",
      abandonedStatus === "closed" && abandonedGoneFromRecovery && historyPreserved,
      `status=${abandonedStatus}, goneFromRecovery=${abandonedGoneFromRecovery}, historyLen=${abandonedHistory.length}`,
    );

    // ---- D: §4.2 接手——新 session + 注入摘要(只讀 DB,不呼叫 LLM)--------
    const { session: newSession } = await clientB.rpc("recovery.takeover", { sessionId: sessionForTakeover });
    const titleMarksTakeover = newSession.title.includes("接手");
    const { messages: newHistory } = await clientB.rpc("session.history", { sessionId: newSession.id });
    const firstUserMsg = newHistory.find((m) => m.role === "user");
    const summaryLooksRight =
      Boolean(firstUserMsg) &&
      firstUserMsg.content.includes("【前次工作中斷】") &&
      firstUserMsg.content.includes("D-takeover-target") &&
      firstUserMsg.content.length <= 4000;
    const { sessions: recoveryAfterTakeover } = await clientB.rpc("recovery.list", {});
    const oldGoneFromRecovery = !recoveryAfterTakeover.some((s) => s.sessionId === sessionForTakeover);
    const { sessions: sessionsAfterTakeover } = await clientB.rpc("session.list", {});
    const oldClosed = sessionsAfterTakeover.find((s) => s.id === sessionForTakeover)?.status === "closed";

    record(
      "D(§4.2「接手」: 新 session + 注入摘要): 新 session 標題含「接手」、第一則 user 訊息是摘要(含【前次工作中斷】標頭與任務標題、長度 <=4000)、舊 session 收尾成 closed 並離開復原視圖",
      titleMarksTakeover && summaryLooksRight && oldGoneFromRecovery && oldClosed,
      `newTitle=${newSession.title}, summaryLen=${firstUserMsg?.content?.length}, oldClosed=${oldClosed}, oldGoneFromRecovery=${oldGoneFromRecovery}`,
    );

    clientB.close();
    await killProcessTreeHard(coreB);
    coreB = null;
  } catch (err) {
    record("B/C/D 執行過程發生未預期錯誤", false, String(err));
  } finally {
    client?.close();
    if (coreA) await killProcessTreeHard(coreA);
    if (coreB) await killProcessTreeHard(coreB);
  }

  rmDirs([dataDir, homeDir, workspaceDir]);
}

// =======================================================================
async function main() {
  if (!existsSync(CORE_ENTRY)) {
    console.error(`找不到 ${CORE_ENTRY} —— 請先執行 pnpm build`);
    process.exit(1);
  }

  console.log("=== S6 e2e:A(核心驗收標準 1/2 —— kill -9 → interrupted 且出現在復原視圖)===");
  await testShutdownVsCrash();

  console.log("\n=== S6 e2e:A'(核心驗收標準 2/2 —— 正常關閉 → closed 且不出現在復原視圖)===");
  await testGracefulShutdown();

  console.log("\n=== S6 e2e:B + C + D(continue 拒絕 / 放棄 / 接手)===");
  await testContinueAbandonTakeover();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n\n========== 總結:${results.length - failed.length}/${results.length} 通過 ==========`);
  for (const r of failed) {
    console.log(`  FAIL: ${r.name}`);
  }
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[e2e-crash-recovery] fatal:", err);
  process.exit(1);
});
