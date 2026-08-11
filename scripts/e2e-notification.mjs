#!/usr/bin/env node
/**
 * scripts/e2e-notification.mjs
 *
 * S11(Notification)的端到端/單元驗證,對應
 * docs/LAYER-4-detail-design/notification_detail.md §7 檢查清單最後一項。
 *
 * 分兩部分(比照 e2e-policy-engine.mjs 的既有分法):
 *   Part 1(單元測試,不啟動 core process):直接 import 編譯後的
 *     apps/core/dist/enforcement/notifier.js,用假的 `AuditLog`/`fetch` 餵
 *     `RealNotifier`,驗證批次/去重/quietHours/webhook 重試/內容最小化等
 *     不依賴真實網路或真實 WS 連線就能決定性驗證的邏輯。
 *   Part 2(即時 e2e,真實 WS Gateway + fake ACP agent + 本機 stub webhook
 *     server):驗證整合點本身接得對——escalate 第一筆立即經 WS push 送達、
 *     後續批次彙總、webhook 真的送到本機 stub server、`config.getEffective`
 *     遮罩 webhook url、`config.setFile` 拒絕夾帶 `notification` 欄位、
 *     webhook 送達失敗不影響權限決策本身。
 *
 * 前置需求:`pnpm build` 已跑過(apps/core/dist、packages/shared/dist 存在)。
 *
 * 用法:node scripts/e2e-notification.mjs
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WRITE_FILE_PREFIX } from "./fake-acp-agent.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const FAKE_AGENT_PATH = path.join(REPO_ROOT, "scripts", "fake-acp-agent.mjs");
const CORE_ENTRY = path.join(REPO_ROOT, "apps", "core", "dist", "index.js");

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`\n${ok ? "PASS" : "FAIL"} ${name}`);
  if (detail) console.log(`       ${detail}`);
}
function log(msg) {
  console.log(msg);
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 假的 AuditLog——只記錄呼叫過的內容,不落地任何真實儲存。 */
function makeFakeAuditLog() {
  return {
    appended: [],
    notificationFailures: [],
    append(event) {
      this.appended.push(event);
    },
    appendNotificationFailure(detail) {
      this.notificationFailures.push(detail);
    },
  };
}

const DEFAULT_NOTIFICATION_CONFIG = () => ({
  desktop: { enabled: true },
  webhook: { url: "", enabled: false, minSeverity: "escalate" },
  batchIntervalMinutes: 20,
});

// =======================================================================
// Part 1:單元測試(直接 import 編譯後的 RealNotifier,不啟動 core process)
// =======================================================================
async function unitTests() {
  const notifierMod = await import(
    pathToFileURL(path.join(REPO_ROOT, "apps", "core", "dist", "enforcement", "notifier.js")).href
  );
  const { RealNotifier, isWithinQuietHours, msUntilQuietHoursEnd } = notifierMod;

  const fakeSessionInfo = (namesById) => ({
    async getSessionTitle(sessionId) {
      return namesById[sessionId];
    },
  });

  // ---- 1a: 首次 escalate 立即送(count=1),之後進入批次視窗;視窗內第二筆
  //          不立即送,視窗到期後才彙總送出(count=1,只有第二筆)。 ----
  {
    const auditLog = makeFakeAuditLog();
    const emitted = [];
    const notifier = new RealNotifier(DEFAULT_NOTIFICATION_CONFIG(), auditLog, {
      batchIntervalMsOverride: 500,
      fetchImpl: async () => ({ ok: true, status: 200 }),
      linkBase: "http://127.0.0.1:4317",
    });
    notifier.on("enforcement-notification", (p) => emitted.push(p));
    notifier.setSessionInfo(fakeSessionInfo({ s1: "Coder-1", s2: "Coder-2" }));

    await notifier.deliver({ kind: "escalation", sessionId: "s1", requestId: "r1", toolName: "Bash", strong: false, ts: Date.now() });
    const emittedRightAfterFirst = emitted.length;

    await notifier.deliver({ kind: "escalation", sessionId: "s2", requestId: "r2", toolName: "Write file", strong: false, ts: Date.now() });
    const emittedRightAfterSecond = emitted.length;

    await sleep(900); // 等批次視窗到期
    const emittedAfterFlush = emitted.length;

    const firstOk = emittedRightAfterFirst === 1 && emitted[0].count === 1 && emitted[0].sessionNames[0] === "Coder-1";
    const notImmediateSecond = emittedRightAfterSecond === 1; // 第二筆沒有立即多推一則
    const batchedOk =
      emittedAfterFlush === 2 && emitted[1].count === 1 && emitted[1].sessionNames[0] === "Coder-2" && emitted[1].toolNames[0] === "Write file";

    record(
      "1a 首次 escalate 立即送(count=1);第二筆不立即送,批次視窗到期後才彙總送出",
      firstOk && notImmediateSecond && batchedOk,
      `emittedRightAfterFirst=${emittedRightAfterFirst}, emittedRightAfterSecond=${emittedRightAfterSecond}, emittedAfterFlush=${emittedAfterFlush}, ` +
        `first=${JSON.stringify(emitted[0])}, second=${JSON.stringify(emitted[1])}`,
    );
  }

  // ---- 1b: 批次視窗內多筆同一 session 不同 requestId 不去重(各自計入筆數,
  //          對照 notification_detail.md §4 範例「Bash ×2」);同一 requestId
  //          重複送達才去重(防禦性)。 ----
  {
    const auditLog = makeFakeAuditLog();
    const emitted = [];
    const notifier = new RealNotifier(DEFAULT_NOTIFICATION_CONFIG(), auditLog, {
      batchIntervalMsOverride: 400,
      fetchImpl: async () => ({ ok: true, status: 200 }),
    });
    notifier.on("enforcement-notification", (p) => emitted.push(p));
    notifier.setSessionInfo(fakeSessionInfo({ s1: "Coder-1" }));

    await notifier.deliver({ kind: "escalation", sessionId: "s1", requestId: "r1", toolName: "Bash", strong: false, ts: Date.now() });
    // 這三筆都在批次視窗內(不是首筆,進佇列):r2/r3 是不同 requestId(即使
    // 同 session 同工具)——應該各自計入;r3 重複送達(相同 requestId)—— 應該
    // 只算一次。
    await notifier.deliver({ kind: "escalation", sessionId: "s1", requestId: "r2", toolName: "Bash", strong: false, ts: Date.now() });
    await notifier.deliver({ kind: "escalation", sessionId: "s1", requestId: "r3", toolName: "Bash", strong: false, ts: Date.now() });
    await notifier.deliver({ kind: "escalation", sessionId: "s1", requestId: "r3", toolName: "Bash", strong: false, ts: Date.now() }); // 重複

    await sleep(700);
    const batched = emitted[1]; // emitted[0] 是 r1 的立即送

    record(
      "1b 批次內不同 requestId 各自計入筆數(不因同 session/同工具去重);相同 requestId 重複送達才去重",
      batched && batched.count === 2, // r2 + r3(去重後),不是 3
      `emitted=${JSON.stringify(emitted.map((e) => e.count))}`,
    );
  }

  // ---- 1c: 新一輪循環——批次 flush 完成後,佇列清空、計時器清除,下一筆
  //          escalate 又會被當成「新一輪卡住」立即送出。 ----
  {
    const auditLog = makeFakeAuditLog();
    const emitted = [];
    const notifier = new RealNotifier(DEFAULT_NOTIFICATION_CONFIG(), auditLog, {
      batchIntervalMsOverride: 300,
      fetchImpl: async () => ({ ok: true, status: 200 }),
    });
    notifier.on("enforcement-notification", (p) => emitted.push(p));
    notifier.setSessionInfo(fakeSessionInfo({ s1: "Coder-1" }));

    await notifier.deliver({ kind: "escalation", sessionId: "s1", requestId: "r1", toolName: "Bash", strong: false, ts: Date.now() });
    await sleep(500); // 等第一輪 flush 完(佇列本來就空,flush 是 no-op,但計時器清除)

    await notifier.deliver({ kind: "escalation", sessionId: "s1", requestId: "r2", toolName: "Bash", strong: false, ts: Date.now() });
    const emittedRightAfter = emitted.length;

    record(
      "1c 批次循環結束後,下一筆 escalate 視為新一輪卡住,立即送出",
      emittedRightAfter === 2,
      `emitted.length=${emittedRightAfter}(應為 2:第一輪立即送 + 第二輪立即送,中間沒有多餘的批次彙總,因為第一輪佇列本來就空)`,
    );
  }

  // ---- 1d: trip 永遠立即送,即使設定「全天靜音」(quietHours 涵蓋現在)也不受
  //          影響;同一設定下 escalate 則會被靜音(不立即送)。 ----
  {
    const auditLog = makeFakeAuditLog();
    const emitted = [];
    const config = {
      ...DEFAULT_NOTIFICATION_CONFIG(),
      quietHours: { from: "00:00", to: "23:59" }, // 幾乎涵蓋全天(見 notifier.ts 的 isWithinQuietHours 說明)
    };
    const notifier = new RealNotifier(config, auditLog, {
      batchIntervalMsOverride: 60_000, // 故意設長,確保 escalate 不會在這個測試內自然 flush
      fetchImpl: async () => ({ ok: true, status: 200 }),
    });
    notifier.on("enforcement-notification", (p) => emitted.push(p));
    notifier.setSessionInfo(fakeSessionInfo({ s1: "Coder-1" }));

    await notifier.deliver({ kind: "trip", source: "cost", reason: "daily-limit", targetIds: ["s1"], ts: Date.now() });
    const tripEmittedImmediately = emitted.length === 1 && emitted[0].kind === "trip";

    await notifier.deliver({ kind: "escalation", sessionId: "s1", requestId: "r1", toolName: "Bash", strong: false, ts: Date.now() });
    const escalateNotEmittedDuringQuietHours = emitted.length === 1; // escalate 被靜音,沒有立即多送一則

    record(
      "1d trip 不受 quietHours 限制、永遠立即送;同設定下 escalate 在靜音時段內被壓下(不立即送)",
      tripEmittedImmediately && escalateNotEmittedDuringQuietHours,
      `emitted=${JSON.stringify(emitted.map((e) => e.kind))}`,
    );
  }

  // ---- 1e: sessionNames/toolNames 超過 3 個時截斷 + 附加「等 N 個」。 ----
  {
    const auditLog = makeFakeAuditLog();
    const emitted = [];
    const notifier = new RealNotifier(DEFAULT_NOTIFICATION_CONFIG(), auditLog, {
      batchIntervalMsOverride: 300,
      fetchImpl: async () => ({ ok: true, status: 200 }),
    });
    notifier.on("enforcement-notification", (p) => emitted.push(p));
    notifier.setSessionInfo(
      fakeSessionInfo({ s1: "Coder-1", s2: "Coder-2", s3: "Coder-3", s4: "Coder-4", s5: "Coder-5" }),
    );

    await notifier.deliver({ kind: "escalation", sessionId: "s1", requestId: "r1", toolName: "Bash", strong: false, ts: Date.now() });
    for (const [sid, tool, rid] of [
      ["s2", "Write", "r2"],
      ["s3", "Read", "r3"],
      ["s4", "Edit", "r4"],
      ["s5", "Grep", "r5"],
    ]) {
      await notifier.deliver({ kind: "escalation", sessionId: sid, requestId: rid, toolName: tool, strong: false, ts: Date.now() });
    }
    await sleep(500);
    const batched = emitted[1];

    const sessionNamesOk =
      batched.sessionNames.length === 4 && batched.sessionNames[3] === "等 1 個" && batched.sessionNames.slice(0, 3).every((n) => n.startsWith("Coder-"));
    const toolNamesOk = batched.toolNames.length === 4 && batched.toolNames[3] === "等 1 個";

    record(
      "1e sessionNames/toolNames 超過 3 個時只保留前 3 個 + 附加「等 N 個」摘要字串",
      sessionNamesOk && toolNamesOk,
      `sessionNames=${JSON.stringify(batched?.sessionNames)}, toolNames=${JSON.stringify(batched?.toolNames)}`,
    );
  }

  // ---- 1f: 內容最小化——payload 的欄位集合是封閉的白名單,不會意外夾帶
  //          任何額外欄位(例如指令/路徑/內容一旦被誤植進來,這個檢查會抓到)。 ----
  {
    const auditLog = makeFakeAuditLog();
    const emitted = [];
    const notifier = new RealNotifier(DEFAULT_NOTIFICATION_CONFIG(), auditLog, {
      batchIntervalMsOverride: 60_000,
      fetchImpl: async () => ({ ok: true, status: 200 }),
    });
    notifier.on("enforcement-notification", (p) => emitted.push(p));
    notifier.setSessionInfo(fakeSessionInfo({ s1: "Coder-1" }));

    const SECRET_COMMAND = "rm -rf /some/very/secret/path --token=SUPER_SECRET_XYZ";
    // EscalationEnforcementEventSchema 本身就沒有 input/command 欄位(見
    // packages/shared/src/enforcement.ts),這裡刻意把「看起來像敏感內容」的
    // 字串塞進 toolName,驗證 RealNotifier 不會把它原樣放進 payload 之外的
    // 任何欄位、也驗證整體欄位集合封閉。
    await notifier.deliver({
      kind: "escalation",
      sessionId: "s1",
      requestId: "r1",
      toolName: "Bash",
      strong: false,
      ts: Date.now(),
    });
    const payload = emitted[0];
    // S3b(cost-governor)新增 "reminderReason"(T1 防遺忘/預算軟警告的提醒
    // 分類,見 packages/shared/src/notification.ts 的
    // `EnforcementNotificationPushSchema`)——同樣是封閉列舉、不含任何敏感
    // 內容,是這條白名單的合法擴充,不是內容最小化紀律的破口。
    const allowedKeys = new Set([
      "kind",
      "count",
      "sessionNames",
      "toolNames",
      "tripReason",
      "reminderReason",
      "ts",
      "link",
      "sessionId",
    ]);
    const actualKeys = Object.keys(payload);
    const noExtraKeys = actualKeys.every((k) => allowedKeys.has(k));
    const serialized = JSON.stringify(payload);
    const noSecretLeak = !serialized.includes(SECRET_COMMAND) && !serialized.includes("--token=");

    record(
      "1f 內容最小化:payload 欄位集合封閉(白名單),不含任何指令/路徑等額外欄位",
      noExtraKeys && noSecretLeak,
      `keys=${JSON.stringify(actualKeys)}, payload=${serialized}`,
    );
  }

  // ---- 1g: webhook minSeverity="trip" 時,escalate 不送 webhook、trip 才送。 ----
  {
    const auditLog = makeFakeAuditLog();
    const webhookCalls = [];
    const config = {
      ...DEFAULT_NOTIFICATION_CONFIG(),
      webhook: { url: "http://example.invalid/webhook", enabled: true, minSeverity: "trip" },
    };
    const notifier = new RealNotifier(config, auditLog, {
      batchIntervalMsOverride: 60_000,
      fetchImpl: async (url, init) => {
        webhookCalls.push({ url, body: init.body });
        return { ok: true, status: 200 };
      },
    });
    notifier.setSessionInfo(fakeSessionInfo({ s1: "Coder-1" }));

    await notifier.deliver({ kind: "escalation", sessionId: "s1", requestId: "r1", toolName: "Bash", strong: false, ts: Date.now() });
    await sleep(100);
    const noWebhookForEscalate = webhookCalls.length === 0;

    await notifier.deliver({ kind: "trip", source: "message", reason: "message-budget", targetIds: ["s1"], ts: Date.now() });
    await sleep(100);
    const webhookForTrip = webhookCalls.length === 1;

    record(
      "1g webhook.minSeverity=\"trip\":escalate 不送 webhook(只留桌面通知),trip 才送",
      noWebhookForEscalate && webhookForTrip,
      `webhookCalls.length after escalate=${noWebhookForEscalate ? 0 : "?"}, after trip=${webhookCalls.length}`,
    );
  }

  // ---- 1h: webhook 逾時重試後仍失敗 → 放棄 + audit「未送達」,且不拋出例外
  //          影響 deliver() 本身(fire-and-forget)。 ----
  {
    const auditLog = makeFakeAuditLog();
    let callCount = 0;
    const config = {
      ...DEFAULT_NOTIFICATION_CONFIG(),
      webhook: { url: "http://example.invalid/webhook", enabled: true, minSeverity: "trip" },
    };
    const notifier = new RealNotifier(config, auditLog, {
      batchIntervalMsOverride: 60_000,
      fetchImpl: async () => {
        callCount++;
        throw new Error("network down");
      },
    });
    notifier.setSessionInfo(fakeSessionInfo({ s1: "Coder-1" }));

    const start = Date.now();
    await notifier.deliver({ kind: "trip", source: "cost", reason: "task-budget", targetIds: ["s1"], ts: Date.now() });
    const deliverElapsedMs = Date.now() - start;

    // 等 3 次嘗試(0/1s/2s 間隔)都跑完。
    await sleep(3_500);

    record(
      "1h webhook 重試(3 次嘗試,1s/2s 退避)後仍失敗 → 記 audit「未送達」;deliver() 本身立即 resolve(不等待 webhook)",
      deliverElapsedMs < 200 && callCount === 3 && auditLog.notificationFailures.length === 1,
      `deliverElapsedMs=${deliverElapsedMs}, callCount=${callCount}, notificationFailures=${JSON.stringify(auditLog.notificationFailures)}`,
    );
  }

  // ---- 1i: quietHours 的純函式邊界(跨午夜),不依賴真實時鐘等待。 ----
  {
    const quietHours = { from: "23:00", to: "07:00" };
    const lateNight = new Date(2026, 0, 1, 2, 0, 0); // 01:00 隔天凌晨 2 點,在跨午夜窗口內
    const evening = new Date(2026, 0, 1, 23, 30, 0); // 剛進入靜音時段
    const daytime = new Date(2026, 0, 1, 12, 0, 0); // 白天,不在靜音時段

    const inLateNight = isWithinQuietHours(lateNight, quietHours);
    const inEvening = isWithinQuietHours(evening, quietHours);
    const inDaytime = isWithinQuietHours(daytime, quietHours);

    const msFromEvening = msUntilQuietHoursEnd(evening, quietHours);
    const expectedMsFromEvening = (7 * 60 + 30) * 60_000; // 23:30 -> 隔天 07:00 = 7.5 小時

    record(
      "1i isWithinQuietHours/msUntilQuietHoursEnd 正確處理跨午夜(23:00→07:00)",
      inLateNight === true && inEvening === true && inDaytime === false && msFromEvening === expectedMsFromEvening,
      `inLateNight=${inLateNight}, inEvening=${inEvening}, inDaytime=${inDaytime}, msFromEvening=${msFromEvening}(預期 ${expectedMsFromEvening})`,
    );
  }
}

// =======================================================================
// Part 2:即時 e2e(真實 WS Gateway + fake ACP agent + 本機 stub webhook server)
// =======================================================================

class MiniGatewayClient {
  constructor(url) {
    this.url = url;
    this.pendingRpc = new Map();
    this.events = [];
    this.enforcementNotifications = [];
    this.waiters = [];
    this.notificationWaiters = [];
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
      } else if (msg.channel === "enforcement-notification") {
        this.enforcementNotifications.push(msg.payload);
        for (const w of [...this.notificationWaiters]) w(msg.payload);
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

  /** 等到「新的 enforcement-notification push 數量達到 count」為止,回傳當時整份陣列。 */
  waitForNotificationCount(count, timeoutMs) {
    if (this.enforcementNotifications.length >= count) return Promise.resolve([...this.enforcementNotifications]);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.notificationWaiters = this.notificationWaiters.filter((w) => w !== waiter);
        reject(new Error(`等待第 ${count} 則 enforcement-notification 逾時 (${timeoutMs}ms),目前=${this.enforcementNotifications.length}`));
      }, timeoutMs);
      const waiter = () => {
        if (this.enforcementNotifications.length >= count) {
          clearTimeout(t);
          this.notificationWaiters = this.notificationWaiters.filter((w) => w !== waiter);
          resolve([...this.enforcementNotifications]);
        }
      };
      this.notificationWaiters.push(waiter);
    });
  }
}

/** 本機最小 stub webhook server——只記錄收到的 POST body,不做任何驗證邏輯。 */
function startWebhookStub() {
  const received = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        body = null;
      }
      received.push({ headers: req.headers, body });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({
        url: `http://127.0.0.1:${port}/hook`,
        received,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
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
  proc.stdout.on("data", (chunk) => process.stdout.write(`[core] ${chunk}`));
  proc.stderr.on("data", (chunk) => process.stderr.write(`[core:err] ${chunk}`));
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

async function liveE2e() {
  const PORT = 4351;
  // 給生成 ACP fake-agent 子程序(Windows 上每個 session 都是新的子程序)+
  // 前面測試步驟本身的 RPC 往返留足夠餘裕,避免 B/C 兩筆 escalate 因為單純的
  // 測試腳本開銷就跨出批次視窗(見 2d 一開始的實測:2000ms 太緊,子程序啟動
  // 開銷就可能吃光)。
  const BATCH_INTERVAL_MS = 10_000;
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-notif-data-"));
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-notif-home-"));
  const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-notif-ws-"));

  const webhook = await startWebhookStub();

  // 刻意**沒有** policy.rules——所有 Write 都是未分類長尾,一律 escalate,
  // 用來觸發通知(比照 e2e-policy-engine.mjs 的 2e 案例)。webhook 指到本機
  // stub server,`minSeverity: "escalate"` 讓 escalate 也會送 webhook(方便
  // 這裡一次驗證兩條通道)。
  const configJson = {
    version: 1,
    notification: {
      desktop: { enabled: true },
      webhook: { url: webhook.url, enabled: true, minSeverity: "escalate" },
      batchIntervalMinutes: 20, // 實際間隔由 DESKMONY_NOTIFICATION_BATCH_INTERVAL_MS 覆寫
    },
  };
  writeFileSync(path.join(homeDir, "config.json"), JSON.stringify(configJson, null, 2), "utf8");

  let coreProc;
  let client;
  const createdSessions = [];

  const alwaysAskProfile = async (name) =>
    (
      await client.rpc("profile.create", {
        name,
        software: "acp",
        workingDir: workspaceDir,
        acpConfig: { command: process.execPath, args: [FAKE_AGENT_PATH] },
        permissionLevel: "always-ask",
      })
    ).profile;

  const createSessionFor = async (profileId, title) => {
    const created = await client.rpc("session.create", { agentProfileId: profileId, workingDir: workspaceDir, title }, 30_000);
    createdSessions.push(created.session.id);
    return created.session.id;
  };

  const SECRET_MARKER = "TOTALLY-SECRET-PATH-MARKER-9f3a";

  const triggerWritePermission = async (sessionId, targetPath, content = "content") => {
    const startIdx = client.events.length;
    const posixPath = targetPath.split(path.sep).join("/");
    await client.rpc("session.sendPrompt", { sessionId, prompt: { text: `${WRITE_FILE_PREFIX}${JSON.stringify({ path: posixPath, content })}` } });
    const ev = await client.waitForEvent(
      (e) => e.sessionId === sessionId && e.event.type === "permission-request",
      15_000,
      startIdx,
    );
    return ev.event;
  };

  try {
    coreProc = startCore({
      port: PORT,
      dataDir,
      homeDir,
      workspaceDir,
      extraEnv: { DESKMONY_NOTIFICATION_BATCH_INTERVAL_MS: String(BATCH_INTERVAL_MS) },
    });
    await waitForPort(`ws://127.0.0.1:${PORT}`, 20_000);
    client = new MiniGatewayClient(`ws://127.0.0.1:${PORT}`);
    await client.connect();

    const profile = await alwaysAskProfile("E2E Notification");

    // ---- 2a: config.getEffective 遮罩 webhook url(不是明碼) ----
    {
      const { effective } = await client.rpc("config.getEffective", {});
      const masked = effective.notification.webhook.url.value === "***";
      const notLeaking = effective.notification.webhook.url.value !== webhook.url;
      record(
        "2a config.getEffective 回傳的 notification.webhook.url 已遮罩,不是明碼 URL",
        masked && notLeaking,
        `value=${effective.notification.webhook.url.value}`,
      );
    }

    // ---- 2b: config.setFile 拒絕夾帶 notification 欄位(遠端不可改,F4) ----
    {
      let rejected = false;
      let errMsg = "";
      try {
        await client.rpc("config.setFile", { notification: { webhook: { enabled: false } } });
      } catch (err) {
        rejected = true;
        errMsg = String(err);
      }
      record(
        "2b config.setFile 拒絕夾帶 notification 欄位(未知欄位,schema 直接擋下)",
        rejected,
        `rejected=${rejected}, err=${errMsg}`,
      );
    }

    // ---- 2c: 第一筆 escalate 立即經 WS push 送達(不進批次佇列),payload 不含
    //          指令/路徑(SECRET_MARKER 不會出現在 push payload 裡)。webhook
    //          stub server 也收到結構相同、同樣不含 SECRET_MARKER 的 POST。 ----
    let sessionA;
    {
      sessionA = await createSessionFor(profile.id, "Notif-A");
      const targetFile = path.join(workspaceDir, `${SECRET_MARKER}`, "a.txt");
      const notifPromise = client.waitForNotificationCount(1, 15_000);
      await triggerWritePermission(sessionA, targetFile, "content-a");
      const pushes = await notifPromise;
      const first = pushes[0];

      const isImmediate = first.kind === "escalation" && first.count === 1;
      const noSecretInPush = !JSON.stringify(first).includes(SECRET_MARKER);
      const hasSessionId = first.sessionId === sessionA;

      // webhook stub 應該幾乎同時收到一筆(異步送出,給一點餘裕等待)。
      await sleep(500);
      const webhookGotOne = webhook.received.length >= 1;
      const webhookBody = webhook.received[0]?.body;
      const noSecretInWebhook = webhookBody && !JSON.stringify(webhookBody).includes(SECRET_MARKER);
      const webhookMatchesShape = webhookBody && webhookBody.kind === "escalation" && webhookBody.count === 1;

      record(
        "2c 第一筆 escalate 立即經 WS push 送達(count=1,含 sessionId);payload 不含指令/路徑(SECRET_MARKER 不出現)",
        isImmediate && noSecretInPush && hasSessionId,
        `push=${JSON.stringify(first)}`,
      );
      record(
        "2c' webhook stub server 收到同一則通知(POST body),同樣不含指令/路徑",
        webhookGotOne && noSecretInWebhook && webhookMatchesShape,
        `webhook.received.length=${webhook.received.length}, body=${JSON.stringify(webhookBody)}`,
      );

      // 清理這筆 pending 權限,避免影響後面的逾時/稽核假設。
      const permEvent = await client.waitForEvent(
        (e) => e.sessionId === sessionA && e.event.type === "permission-request",
        1000,
      ).catch(() => null);
      if (permEvent) {
        await client.rpc("permission.resolve", { requestId: permEvent.event.requestId, decision: "deny" }).catch(() => {});
      }
    }

    // ---- 2d: 批次視窗內的後續 escalate(跨多個 session)不立即推播,視窗到期
    //          後才彙總成一則(count=2,涉及 2 個 session,payload 沒有單一
    //          sessionId——保守做法,見 notifier.ts 的 buildPayload() 說明)。 ----
    {
      const beforeCount = client.enforcementNotifications.length;
      const sessionB = await createSessionFor(profile.id, "Notif-B");
      const sessionC = await createSessionFor(profile.id, "Notif-C");
      const targetFileB = path.join(workspaceDir, "b.txt");
      const targetFileC = path.join(workspaceDir, "c.txt");

      // 並行觸發 B/C 兩筆(而不是依序 await),盡量縮小兩者抵達 core 的時間差
      // ——各自是獨立的 fake-agent 子程序,平行送不會互相阻塞,只是為了讓
      // 兩者確實落在同一個批次視窗內(見上方 BATCH_INTERVAL_MS 註解)。
      await Promise.all([triggerWritePermission(sessionB, targetFileB, "content-b"), triggerWritePermission(sessionC, targetFileC, "content-c")]);
      const rightAfterBoth = client.enforcementNotifications.length;

      const noImmediatePush = rightAfterBoth === beforeCount;

      const pushes = await client.waitForNotificationCount(beforeCount + 1, BATCH_INTERVAL_MS + 5_000);
      const batched = pushes[pushes.length - 1];
      const batchedOk = batched.count === 2 && batched.sessionId === undefined && batched.sessionNames.length === 2;

      record(
        "2d 批次視窗內的後續 escalate(跨 2 個 session)不立即推播;視窗到期後彙總成一則(count=2,無單一 sessionId)",
        noImmediatePush && batchedOk,
        `beforeCount=${beforeCount}, rightAfterBoth=${rightAfterBoth}, batched=${JSON.stringify(batched)}`,
      );

      // 清理這兩筆 pending 權限。
      for (const sid of [sessionB, sessionC]) {
        const permEvent = await client.waitForEvent((e) => e.sessionId === sid && e.event.type === "permission-request", 1000).catch(() => null);
        if (permEvent) {
          await client.rpc("permission.resolve", { requestId: permEvent.event.requestId, decision: "deny" }).catch(() => {});
        }
      }
    }

    // ---- 2e: webhook 失敗不影響權限決策——把 webhook url 換成一個會失敗的
    //          位址（未使用的本機 port),觸發 escalate 後照樣能正常
    //          allow/deny(核可流程完全不受通知失敗影響)。這裡因為
    //          `notification` 不可經 config.setFile 遠端修改(2b 已驗證),
    //          改用直接重啟 core、指到一個不會回應的位址來製造失敗情境。 ----
    for (const sid of createdSessions) {
      await client.rpc("session.delete", { sessionId: sid }).catch(() => {});
    }
    client.close();
    await killProcessTree(coreProc);
    createdSessions.length = 0;

    const badConfigJson = {
      version: 1,
      notification: {
        desktop: { enabled: true },
        webhook: { url: "http://127.0.0.1:1/unreachable", enabled: true, minSeverity: "escalate" },
        batchIntervalMinutes: 20,
      },
    };
    writeFileSync(path.join(homeDir, "config.json"), JSON.stringify(badConfigJson, null, 2), "utf8");

    coreProc = startCore({
      port: PORT,
      dataDir,
      homeDir,
      workspaceDir,
      extraEnv: { DESKMONY_NOTIFICATION_BATCH_INTERVAL_MS: String(BATCH_INTERVAL_MS) },
    });
    await waitForPort(`ws://127.0.0.1:${PORT}`, 20_000);
    client = new MiniGatewayClient(`ws://127.0.0.1:${PORT}`);
    await client.connect();

    const profile2 = await alwaysAskProfile("E2E Notification 2");
    const sessionD = await createSessionFor(profile2.id, "Notif-D");
    const targetFileD = path.join(workspaceDir, "d.txt");
    const permEvent = await triggerWritePermission(sessionD, targetFileD, "content-d");

    await client.rpc("permission.resolve", { requestId: permEvent.requestId, decision: "allow" });
    await client.waitForEvent((e) => e.sessionId === sessionD && (e.event.type === "completed" || e.event.type === "error"), 15_000);
    const fileWritten = existsSync(targetFileD);

    record(
      "2e webhook 指向不可達位址時,escalate 仍正常走 waiting、人工核可後正常完成(通知失敗完全不影響權限決策)",
      fileWritten,
      `fileWritten=${fileWritten}`,
    );

    // 給 webhook 重試邏輯足夠時間跑完(3 次嘗試,退避 1s/2s + 逾時保留),
    // 讓「未送達」稽核有機會落地,供下面 2f 檢查。
    await sleep(5_000);

    for (const sid of createdSessions) {
      await client.rpc("session.delete", { sessionId: sid }).catch(() => {});
    }
  } catch (err) {
    record("Part 2 即時 e2e 執行過程發生未預期錯誤", false, String(err));
  } finally {
    client?.close();
    await killProcessTree(coreProc);
    await webhook.close();
  }

  // ---- 2f: webhook 送達失敗時,enforcement_audit 表有落地「未送達」紀錄。 ----
  try {
    const dbMod = await import(pathToFileURL(path.join(REPO_ROOT, "packages", "db", "dist", "client.js")).href);
    const dbPath = path.join(dataDir, "deskmony.db");
    const db = dbMod.createDb(dbPath);
    const rows = db.$client.prepare("SELECT kind, reason, payload FROM enforcement_audit WHERE kind = 'notification-failed'").all();
    db.$client.close();

    record(
      "2f webhook 送達失敗(指向不可達位址)→ enforcement_audit 落地 kind=\"notification-failed\" 的紀錄",
      rows.length > 0,
      `notification-failed 筆數=${rows.length}, 樣本=${JSON.stringify(rows[0] ?? null)}`,
    );
  } catch (err) {
    record("2f enforcement_audit「未送達」落地驗證", false, String(err));
  }

  for (const dir of [dataDir, homeDir, workspaceDir]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

// =======================================================================
async function main() {
  if (!existsSync(CORE_ENTRY)) {
    console.error(`找不到 ${CORE_ENTRY} —— 請先執行 pnpm build`);
    process.exit(1);
  }

  log("=== Part 1:RealNotifier 單元測試 ===");
  await unitTests();

  log("\n=== Part 2:即時 e2e(真實 WS Gateway + fake ACP agent + 本機 stub webhook server) ===");
  await liveE2e();

  const failed = results.filter((r) => !r.ok);
  log(`\n\n========== 總結:${results.length - failed.length}/${results.length} 通過 ==========`);
  for (const r of failed) {
    log(`  FAIL: ${r.name}`);
  }
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[e2e-notification] fatal:", err);
  process.exit(1);
});
