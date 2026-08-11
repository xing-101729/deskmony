#!/usr/bin/env node
/**
 * scripts/e2e-auto-mode-yolo.mjs
 *
 * S7(Auto Mode / YOLO / 遠端能力矩陣)的端到端驗證,對應
 * docs/LAYER-4-detail-design/auto-mode-and-yolo_detail.md §6 檢查清單最後一項。
 *
 * 沿用 scripts/e2e-policy-engine.mjs 的手法(真實 WS Gateway + fake ACP
 * agent,決定性、不依賴真實模型行為)——這裡不 import 那個檔案(它是腳本,
 * 沒有 export),而是複製同一套精簡 client/spawn 邏輯(維持獨立可執行)。
 *
 * 涵蓋(§6 清單 + 使用者特別點名的三個關鍵案例):
 *   A. session.setPermissionMode 把 auto/YOLO 接上真值——中間地帶自動放行
 *   B. auto 仍受 config deny-list 約束;YOLO 跳過 config deny-list
 *   C. 【關鍵】hard-deny 在 YOLO 下仍 deny(不降級、不放行)
 *   D. YOLO 30 分鐘(這裡用 DESKMONY_YOLO_DURATION_MS 縮短)惰性過期回落 always-ask
 *   E. 【關鍵】遠端連線呼叫 LOCAL_ONLY_METHODS(以 session.setPermissionMode
 *      為例)被拒;本機連線(即使 bindHost=0.0.0.0)正常。
 *      E-4/E-5(S7 L4 §2.1 的 `local` 修正):**有遠端 client 連線中時**,
 *      hard-deny 不降級為 escalate-strong(直接 deny);遠端斷線後恢復降級。
 *   F. 【關鍵】escalate-strong 請求帶 rememberRule 被 Core 拒絕(decision 仍套用,
 *      但規則不寫入/不生效);一般 escalate 帶 rememberRule 正常寫入
 *      config.json 且 in-memory 立即生效
 *   G. 握手能力集(gateway.capabilities)依 isLocal 正確回報
 *   H. DB 遷移:舊資料 permission_level="auto-accept-all" 被降級為
 *      "auto-accept-edits",且 console.warn 有印
 *
 * 前置需求:`pnpm build` 已跑過。
 * 用法:node scripts/e2e-auto-mode-yolo.mjs
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
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
function skipNote(name, reason) {
  results.push({ name, ok: true, skipped: true });
  console.log(`\nSKIP ${name}`);
  if (reason) console.log(`       ${reason}`);
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
    this.permissionResolvedEvents = [];
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
      const authResult = await this.rpc("auth", { token: this.token });
      this.capabilities = authResult.capabilities;
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
      } else if (msg.channel === "permission-resolved") {
        this.permissionResolvedEvents.push(msg.payload);
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
      const start = Date.now();
      const poll = setInterval(() => {
        for (let i = fromIndex; i < this.events.length; i++) {
          if (predicate(this.events[i])) {
            clearInterval(poll);
            resolve(this.events[i]);
            return;
          }
        }
        if (Date.now() - start > timeoutMs) {
          clearInterval(poll);
          reject(new Error(`等待事件逾時 (${timeoutMs}ms)`));
        }
      }, 50);
    });
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
  let stdout = "";
  let stderr = "";
  proc.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
    process.stdout.write(`[core:${port}] ${chunk}`);
  });
  proc.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
    process.stderr.write(`[core:${port}:err] ${chunk}`);
  });
  proc.getStdout = () => stdout;
  proc.getStderr = () => stderr;
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

/** 找一個非 loopback 的 IPv4 位址,供 §E 的「遠端連線」測試使用——真的透過
 *  自己的實體/虛擬網卡位址連回自己,而不是偽造 remoteAddress,誠實地驗證
 *  `isLoopbackAddress()` 這條判斷本身(見 apps/core/src/gateway/ws-gateway.ts)。
 *  找不到(例如沙箱環境只剩 loopback)就回傳 undefined,呼叫端要 skip。 */
function findNonLoopbackIPv4() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] ?? []) {
      if (net.family === "IPv4" && !net.internal) {
        return net.address;
      }
    }
  }
  return undefined;
}

// =======================================================================
async function testAutoAndYolo() {
  const PORT = 4341;
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-yolo-data-"));
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-yolo-home-"));
  const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-yolo-ws-"));
  const outsideDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-yolo-outside-"));
  const deniedSubDir = path.join(workspaceDir, "denied-sub");
  const unclassifiedSubDir = path.join(workspaceDir, "unclassified-sub");
  mkdirSync(deniedSubDir, { recursive: true });
  mkdirSync(unclassifiedSubDir, { recursive: true });

  const configPath = path.join(homeDir, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        version: 1,
        policy: {
          rules: [{ tool: "Write file", when: { pathUnder: deniedSubDir }, effect: "deny" }],
          allowedHosts: [],
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  let coreProc;
  let client;
  const createdSessions = [];

  const createAttendedSession = async (title) => {
    const { profile } = await client.rpc("profile.create", {
      name: `E2E ${title}`,
      software: "acp",
      workingDir: workspaceDir,
      acpConfig: { command: process.execPath, args: [FAKE_AGENT_PATH] },
      permissionLevel: "always-ask",
    });
    const { session } = await client.rpc("session.create", { agentProfileId: profile.id, workingDir: workspaceDir, title }, 30_000);
    createdSessions.push(session.id);
    return session.id;
  };

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

  const waitCompleted = (sessionId) =>
    client.waitForEvent((e) => e.sessionId === sessionId && (e.event.type === "completed" || e.event.type === "error"), 15_000);

  try {
    coreProc = startCore({ port: PORT, dataDir, homeDir, workspaceDir });
    await waitForPort(`ws://127.0.0.1:${PORT}`, 20_000);
    client = new MiniGatewayClient(`ws://127.0.0.1:${PORT}`);
    await client.connect();

    // ---- A: session.setPermissionMode → auto,未分類長尾自動放行(不進 waiting)----
    {
      const sessionId = await createAttendedSession("A-auto-allows-unclassified");
      const setResult = await client.rpc("session.setPermissionMode", { sessionId, mode: "auto-accept-edits" });
      const modeSetCorrectly = setResult.mode === "auto-accept-edits" && setResult.yoloExpiresAt === undefined;

      const updatesBefore = client.sessionUpdates.length;
      const targetFile = path.join(unclassifiedSubDir, "a-auto-allow.txt");
      const permEvent = await triggerWritePermission(sessionId, targetFile);
      await waitCompleted(sessionId);
      await sleep(300);

      const wentWaiting = client.sessionUpdates.slice(updatesBefore).some((u) => u.id === sessionId && u.status === "waiting");
      const resolvedAllow = client.permissionResolvedEvents.some(
        (r) => r.requestId === permEvent.requestId && r.decision === "allow" && r.source === "policy",
      );
      const fileWritten = existsSync(targetFile);

      record(
        "A: session.setPermissionMode(auto-accept-edits) 接上真值 → 未分類請求自動放行,不進 waiting",
        modeSetCorrectly && !wentWaiting && resolvedAllow && fileWritten,
        `modeSetCorrectly=${modeSetCorrectly}, wentWaiting=${wentWaiting}, resolvedAllow=${resolvedAllow}, fileWritten=${fileWritten}`,
      );
    }

    // ---- B1: auto(非 YOLO)仍受 config deny-list 約束 ----
    {
      const sessionId = await createAttendedSession("B1-auto-respects-config-deny");
      await client.rpc("session.setPermissionMode", { sessionId, mode: "auto-accept-edits" });

      const targetFile = path.join(deniedSubDir, "b1-should-stay-denied.txt");
      const permEvent = await triggerWritePermission(sessionId, targetFile);
      await waitCompleted(sessionId);
      await sleep(300);

      const resolvedDeny = client.permissionResolvedEvents.some(
        (r) => r.requestId === permEvent.requestId && r.decision === "deny" && r.source === "policy",
      );
      const fileNotWritten = !existsSync(targetFile);

      record(
        "B1: auto(非 YOLO)仍受 config deny-list 約束 → 命中 deny 規則的請求維持 deny",
        resolvedDeny && fileNotWritten,
        `resolvedDeny=${resolvedDeny}, fileNotWritten=${fileNotWritten}`,
      );
    }

    // ---- B2: YOLO 跳過 config deny-list(同一條規則,YOLO 下改為 allow)----
    {
      const sessionId = await createAttendedSession("B2-yolo-skips-config-deny");
      const setResult = await client.rpc("session.setPermissionMode", { sessionId, mode: "auto-accept-all" });
      const yoloExpiresSet = typeof setResult.yoloExpiresAt === "number" && setResult.yoloExpiresAt > Date.now();

      const targetFile = path.join(deniedSubDir, "b2-yolo-bypasses.txt");
      const permEvent = await triggerWritePermission(sessionId, targetFile);
      await waitCompleted(sessionId);
      await sleep(300);

      const resolvedAllow = client.permissionResolvedEvents.some(
        (r) => r.requestId === permEvent.requestId && r.decision === "allow" && r.source === "policy",
      );
      const fileWritten = existsSync(targetFile);

      record(
        "B2: YOLO(auto-accept-all)跳過同一條 config deny 規則 → 改為自動放行,且 setPermissionMode 回傳 yoloExpiresAt",
        yoloExpiresSet && resolvedAllow && fileWritten,
        `yoloExpiresSet=${yoloExpiresSet}, resolvedAllow=${resolvedAllow}, fileWritten=${fileWritten}`,
      );
    }

    // ---- C(關鍵案例①):hard-deny 在 YOLO 下仍 deny ----
    {
      const sessionId = await createAttendedSession("C-harddeny-under-yolo-still-deny");
      await client.rpc("session.setPermissionMode", { sessionId, mode: "auto-accept-all" });

      const targetFile = path.join(outsideDir, "c-escape-under-yolo.txt");
      const permEvent = await triggerWritePermission(sessionId, targetFile);
      await waitCompleted(sessionId);
      await sleep(300);

      const resolvedDeny = client.permissionResolvedEvents.some(
        (r) => r.requestId === permEvent.requestId && r.decision === "deny" && r.source === "policy",
      );
      const fileNotWritten = !existsSync(targetFile);
      const listAfter = await client.rpc("session.list", {});
      const neverWaiting = listAfter.sessions.find((s) => s.id === sessionId)?.status !== "waiting";

      record(
        "【關鍵】C: hard-deny(worktree 外寫入)在 YOLO 開啟時仍 deny——不降級成 escalate-strong、不放行、不進 waiting",
        resolvedDeny && fileNotWritten && neverWaiting,
        `resolvedDeny=${resolvedDeny}, fileNotWritten=${fileNotWritten}, neverWaiting=${neverWaiting}`,
      );
    }

    // ---- F1(關鍵案例③):escalate-strong 請求帶 rememberRule 被 Core 拒絕 ----
    let strongRuleTargetFile;
    {
      const sessionId = await createAttendedSession("F1-strong-rememberRule-rejected");
      // 不開 auto/YOLO(維持 always-ask,attended=true,autoMode=false)——
      // hard-deny 命中時走「本機+attended+非autoMode」的 escalate-strong 分支。
      strongRuleTargetFile = path.join(outsideDir, "f1-escape-strong.txt");
      const permEvent = await triggerWritePermission(sessionId, strongRuleTargetFile);

      // 驗證這筆請求確實帶著 strong:true 廣播給 UI(見
      // session-manager.ts 的「補上剛算出來的 strong」那段)。
      const strongFlagCorrect = permEvent.strong === true;

      // 嘗試帶 rememberRule 一起 allow——Core 端必須忽略 rememberRule(C4 紀律③),
      // 但這次的 decision(allow)仍要照常套用,agent 不因此卡住。
      const attemptedRule = { tool: "Write file", when: { pathUnder: outsideDir }, effect: "allow" };
      await client.rpc("permission.resolve", { requestId: permEvent.requestId, decision: "allow", rememberRule: attemptedRule });
      await waitCompleted(sessionId);
      await sleep(300);

      const fileWrittenThisTime = existsSync(strongRuleTargetFile); // 這次的 allow 決定仍應生效

      record(
        "【關鍵】F1: escalate-strong 請求(strong:true 已正確帶到 UI)帶 rememberRule 呼叫 permission.resolve → 這次 decision 正常套用(檔案寫入),但規則不得被記住",
        strongFlagCorrect && fileWrittenThisTime,
        `strongFlagCorrect=${strongFlagCorrect}, fileWrittenThisTime=${fileWrittenThisTime}`,
      );
    }

    // ---- F2:驗證 F1 的 rememberRule 確實沒有生效——同一條路徑,全新 session,
    //          應該再次 escalate-strong(而不是被「記住的規則」自動放行)----
    {
      const sessionId = await createAttendedSession("F2-verify-strong-rule-not-remembered");
      const targetFile = path.join(outsideDir, "f2-same-dir-should-still-escalate.txt");
      const permEvent = await triggerWritePermission(sessionId, targetFile);
      await sleep(500);
      const listAfter = await client.rpc("session.list", {});
      const wentWaiting = listAfter.sessions.find((s) => s.id === sessionId)?.status === "waiting";

      await client.rpc("permission.resolve", { requestId: permEvent.requestId, decision: "deny" });
      await waitCompleted(sessionId).catch(() => {});

      // 也直接讀 config.json,確認 F1 的 rememberRule 真的沒被寫進去。
      const configRaw = JSON.parse(readFileSync(configPath, "utf8"));
      const rules = configRaw.policy?.rules ?? [];
      const ruleWasWritten = rules.some((r) => r.tool === "Write file" && r.when?.pathUnder === outsideDir && r.effect === "allow");

      record(
        "【關鍵】F2: F1 的 rememberRule 確認沒有生效——同目錄下一個全新 session 仍會 escalate-strong(走 waiting),config.json 也沒有寫入那條規則",
        wentWaiting && !ruleWasWritten,
        `wentWaiting=${wentWaiting}, ruleWasWritten=${ruleWasWritten}`,
      );
    }

    // ---- F3:一般 escalate(非 strong)帶 rememberRule → Core 端接受,
    //          in-memory 立即生效(同 session 內第二次同類請求直接 allow),
    //          且寫回 config.json ----
    {
      const sessionId = await createAttendedSession("F3-normal-rememberRule-applies");
      const targetDir = path.join(unclassifiedSubDir, "f3-remember-dir");
      mkdirSync(targetDir, { recursive: true });
      const firstFile = path.join(targetDir, "first.txt");
      const permEvent = await triggerWritePermission(sessionId, firstFile);
      const notStrong = permEvent.strong !== true;

      const rule = { tool: "Write file", when: { pathUnder: targetDir }, effect: "allow" };
      await client.rpc("permission.resolve", { requestId: permEvent.requestId, decision: "allow", rememberRule: rule });
      await waitCompleted(sessionId);
      await sleep(300);
      const firstFileWritten = existsSync(firstFile);

      // 同一個 session 再送一次同目錄下的請求——應該直接 allow,不再 waiting
      // (in-memory PolicyEngine.addRule() 立即生效,不需要重啟 core)。
      const updatesBefore = client.sessionUpdates.length;
      const secondFile = path.join(targetDir, "second.txt");
      const secondEvent = await triggerWritePermission(sessionId, secondFile);
      await waitCompleted(sessionId);
      await sleep(300);
      const secondWentWaiting = client.sessionUpdates.slice(updatesBefore).some((u) => u.id === sessionId && u.status === "waiting");
      const secondResolvedAllow = client.permissionResolvedEvents.some(
        (r) => r.requestId === secondEvent.requestId && r.decision === "allow" && r.source === "policy",
      );
      const secondFileWritten = existsSync(secondFile);

      const configRaw = JSON.parse(readFileSync(configPath, "utf8"));
      const rules = configRaw.policy?.rules ?? [];
      const ruleWrittenToConfig = rules.some((r) => r.tool === "Write file" && r.when?.pathUnder === targetDir && r.effect === "allow");

      record(
        "F3: 一般 escalate 帶 rememberRule → Core 接受,in-memory 立即生效(同 session 第二次同類請求直接 allow,不進 waiting)且寫回 config.json",
        notStrong && firstFileWritten && !secondWentWaiting && secondResolvedAllow && secondFileWritten && ruleWrittenToConfig,
        `notStrong=${notStrong}, firstFileWritten=${firstFileWritten}, secondWentWaiting=${secondWentWaiting}, ` +
          `secondResolvedAllow=${secondResolvedAllow}, secondFileWritten=${secondFileWritten}, ruleWrittenToConfig=${ruleWrittenToConfig}`,
      );
    }

    for (const sid of createdSessions) {
      try {
        await client.rpc("session.delete", { sessionId: sid });
      } catch {
        // ignore
      }
    }
  } catch (err) {
    record("A-F 主要情境執行過程發生未預期錯誤", false, String(err));
  } finally {
    client?.close();
    await killProcessTree(coreProc);
  }

  for (const dir of [dataDir, homeDir, workspaceDir, outsideDir]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

// =======================================================================
// D: YOLO 30 分鐘惰性過期——用 DESKMONY_YOLO_DURATION_MS 縮短成幾秒,獨立
//    core 實例,避免影響上面測試的時序假設。
// =======================================================================
async function testYoloExpiry() {
  const PORT = 4342;
  const YOLO_DURATION_MS = 1500;
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-yolo-expiry-data-"));
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-yolo-expiry-home-"));
  const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-yolo-expiry-ws-"));
  const unclassifiedSubDir = path.join(workspaceDir, "unclassified-sub");
  mkdirSync(unclassifiedSubDir, { recursive: true });

  let coreProc;
  let client;
  try {
    coreProc = startCore({
      port: PORT,
      dataDir,
      homeDir,
      workspaceDir,
      extraEnv: { DESKMONY_YOLO_DURATION_MS: String(YOLO_DURATION_MS) },
    });
    await waitForPort(`ws://127.0.0.1:${PORT}`, 20_000);
    client = new MiniGatewayClient(`ws://127.0.0.1:${PORT}`);
    await client.connect();

    const { profile } = await client.rpc("profile.create", {
      name: "E2E YOLO Expiry",
      software: "acp",
      workingDir: workspaceDir,
      acpConfig: { command: process.execPath, args: [FAKE_AGENT_PATH] },
      permissionLevel: "always-ask",
    });
    const { session } = await client.rpc("session.create", { agentProfileId: profile.id, workingDir: workspaceDir, title: "D-yolo-expiry" }, 30_000);
    const sessionId = session.id;

    const setResult = await client.rpc("session.setPermissionMode", { sessionId, mode: "auto-accept-all" });
    const yoloArmed = typeof setResult.yoloExpiresAt === "number";

    await sleep(YOLO_DURATION_MS + 800); // 超過縮短後的存活時間

    // 惰性檢查只在 decide() 前發生——送一個會觸發 permission-request 的 prompt
    // 才會真的觸發過期回落。
    const startIdx = client.events.length;
    const targetFile = path.join(unclassifiedSubDir, "d-after-expiry.txt");
    const posixPath = targetFile.split(path.sep).join("/");
    await client.rpc("session.sendPrompt", { sessionId, prompt: { text: `${WRITE_FILE_PREFIX}${JSON.stringify({ path: posixPath, content: "x" })}` } });

    // 過期後回落 always-ask(attended)——這次請求應該重新 escalate(走
    // waiting),而不是繼續被自動放行。
    const permEnvelope = await client.waitForEvent(
      (e) => e.sessionId === sessionId && e.event.type === "permission-request",
      15_000,
      startIdx,
    );
    const permEvent = permEnvelope.event;
    await sleep(500);
    const listAfter = await client.rpc("session.list", {});
    const sessionAfter = listAfter.sessions.find((s) => s.id === sessionId);
    const wentWaiting = sessionAfter?.status === "waiting";
    const modeReportedAsAlwaysAsk = sessionAfter?.permissionMode === "always-ask" || sessionAfter?.permissionMode === undefined;

    // 清理:手動 resolve。
    await client.rpc("permission.resolve", { requestId: permEvent.requestId, decision: "deny" });
    await client
      .waitForEvent((e) => e.sessionId === sessionId && (e.event.type === "completed" || e.event.type === "error"), 15_000)
      .catch(() => {});

    record(
      `D: YOLO 惰性過期(縮短為 ${YOLO_DURATION_MS}ms 測試)——過期後下一次 decide() 前偵測到並回落 always-ask,該次請求重新 escalate(走 waiting),Session.permissionMode 也回報 always-ask`,
      yoloArmed && wentWaiting && modeReportedAsAlwaysAsk,
      `yoloArmed=${yoloArmed}, wentWaiting=${wentWaiting}(status=${sessionAfter?.status}), permissionMode=${sessionAfter?.permissionMode}`,
    );
  } catch (err) {
    record("D: YOLO 惰性過期 執行過程發生未預期錯誤", false, String(err));
  } finally {
    client?.close();
    await killProcessTree(coreProc);
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
// E(關鍵案例②)+ G:遠端連線呼叫 LOCAL_ONLY_METHODS 被拒;本機連線(即使
//    bindHost=0.0.0.0)正常;gateway.capabilities 依 isLocal 正確回報。
// =======================================================================
async function testRemoteRejection() {
  const remoteIp = findNonLoopbackIPv4();
  if (!remoteIp) {
    skipNote(
      "【關鍵】E/G: 遠端連線呼叫 LOCAL_ONLY_METHODS 被拒 + 握手能力集",
      "這台機器找不到非 loopback 的 IPv4 位址(os.networkInterfaces() 只有 internal/沒有介面),無法誠實地模擬真正的遠端連線,略過(不偽造 remoteAddress——isLocal 的唯一判斷來源就是這個)。",
    );
    return;
  }

  const PORT = 4343;
  const TOKEN = "e2e-remote-token";
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-remote-data-"));
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-remote-home-"));
  const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-remote-ws-"));
  /** E-4/E-5 用:worktree 之外的目錄(寫入這裡必定命中 hard-deny)。 */
  const outsideDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-remote-outside-"));

  let coreProc;
  let localClient;
  let remoteClient;
  try {
    // 對外綁定(0.0.0.0)+ token——比照 apps/core/src/index.ts 的
    // validateBindSafety() 要求。
    coreProc = startCore({
      port: PORT,
      dataDir,
      homeDir,
      workspaceDir,
      extraEnv: { DESKMONY_BIND_HOST: "0.0.0.0", DESKMONY_AUTH_TOKEN: TOKEN },
    });
    await waitForPort(`ws://127.0.0.1:${PORT}`, 20_000);

    localClient = new MiniGatewayClient(`ws://127.0.0.1:${PORT}`, TOKEN);
    await localClient.connect();
    remoteClient = new MiniGatewayClient(`ws://${remoteIp}:${PORT}`, TOKEN);
    await remoteClient.connect();

    // ---- G: 握手能力集依 isLocal 正確回報 ----
    const localCapsViaAuth = localClient.capabilities;
    const remoteCapsViaAuth = remoteClient.capabilities;
    const localCapsViaMethod = (await localClient.rpc("gateway.capabilities", {})).capabilities;
    const remoteCapsViaMethod = (await remoteClient.rpc("gateway.capabilities", {})).capabilities;

    record(
      "G: 握手能力集(auth 回應 + 獨立的 gateway.capabilities)依 isLocal 正確回報——本機連線全 true,遠端連線(經真實非 loopback 位址連入)全 false",
      localCapsViaAuth?.canToggleAuto === true &&
        localCapsViaAuth?.canEnableYolo === true &&
        localCapsViaMethod?.canToggleAuto === true &&
        remoteCapsViaAuth?.canToggleAuto === false &&
        remoteCapsViaAuth?.canEnableYolo === false &&
        remoteCapsViaMethod?.canToggleAuto === false,
      `localCapsViaAuth=${JSON.stringify(localCapsViaAuth)}, remoteCapsViaAuth=${JSON.stringify(remoteCapsViaAuth)}, ` +
        `localCapsViaMethod=${JSON.stringify(localCapsViaMethod)}, remoteCapsViaMethod=${JSON.stringify(remoteCapsViaMethod)}`,
    );

    // 建一個 session 供下面的 setPermissionMode 呼叫用(用本機連線建立,
    // profile.create/session.create 本身不是這次要測的重點)。
    const { profile } = await localClient.rpc("profile.create", {
      name: "E2E Remote Reject",
      software: "acp",
      workingDir: workspaceDir,
      acpConfig: { command: process.execPath, args: [FAKE_AGENT_PATH] },
      permissionLevel: "always-ask",
    });
    const { session } = await localClient.rpc("session.create", { agentProfileId: profile.id, workingDir: workspaceDir, title: "E-remote" }, 30_000);

    // ---- E(關鍵)-1: 遠端連線呼叫 session.setPermissionMode 被拒 ----
    let remoteRejected = false;
    let remoteErrorMsg = "";
    try {
      await remoteClient.rpc("session.setPermissionMode", { sessionId: session.id, mode: "auto-accept-all" });
    } catch (err) {
      remoteRejected = true;
      remoteErrorMsg = String(err);
    }

    // ---- E-2: 同一個方法,本機連線(即使 core 綁在 0.0.0.0)正常成功 ----
    let localSucceeded = false;
    try {
      const r = await localClient.rpc("session.setPermissionMode", { sessionId: session.id, mode: "auto-accept-edits" });
      localSucceeded = r.mode === "auto-accept-edits";
    } catch (err) {
      localSucceeded = false;
    }

    record(
      "【關鍵】E: 遠端連線(經真實非 loopback IP 連入,即使 bindHost=0.0.0.0)呼叫 session.setPermissionMode(LOCAL_ONLY_METHODS)被拒;本機連線同一方法正常成功——這是唯一的安全保證,不是 UI 隱藏按鈕",
      remoteRejected && localSucceeded,
      `remoteRejected=${remoteRejected}(${remoteErrorMsg}), localSucceeded=${localSucceeded}`,
    );

    // ---- E-3: config.setFile 也是 LOCAL_ONLY_METHODS 之一,一併驗證遠端被拒。 ----
    let configSetFileRejected = false;
    try {
      await remoteClient.rpc("config.setFile", { log: { level: "warn" } });
    } catch {
      configSetFileRejected = true;
    }
    record(
      "E-3: 遠端連線呼叫 config.setFile 同樣被拒(LOCAL_ONLY_METHODS 清單裡的另一個方法)",
      configSetFileRejected,
      `configSetFileRejected=${configSetFileRejected}`,
    );

    // ---- 共用小工具:用本機連線送出寫檔 prompt 並等到 permission-request ----
    const triggerWrite = async (sessionId, targetPath) => {
      const startIdx = localClient.events.length;
      const posixPath = targetPath.split(path.sep).join("/");
      await localClient.rpc("session.sendPrompt", {
        sessionId,
        prompt: { text: `${WRITE_FILE_PREFIX}${JSON.stringify({ path: posixPath, content: "x" })}` },
      });
      const ev = await localClient.waitForEvent(
        (e) => e.sessionId === sessionId && e.event.type === "permission-request",
        15_000,
        startIdx,
      );
      return ev.event;
    };
    const newAlwaysAskSession = async (title) => {
      const { session: s } = await localClient.rpc(
        "session.create",
        { agentProfileId: profile.id, workingDir: workspaceDir, title },
        30_000,
      );
      return s.id;
    };

    // ---- E-4(關鍵案例③,S7 L4 §2.1 的 `local` 修正):**只要有任何遠端
    //      client 連線中**,hard-deny 就不得降級為 escalate-strong,一律直接
    //      deny。這個 session 是本機連線建立的、維持 always-ask
    //      (autoMode=false)、而且本機 client 也還連著(attended=true)——
    //      「本機 + attended + 非 autoMode」本來正是唯一能降級的組合,唯一把
    //      它擋下來的因素就是那條遠端連線。
    //
    //      理由(§2.1):permission-request 不綁定單一 WS 連線,無法問「這一筆
    //      是誰送的」,而遠端可能就是那個會去點「仍要允許」的人 ⇒ 寧可嚴、
    //      不可寬。修正前 `local` 恆為 true,遠端看得到 escalate-strong 彈窗
    //      並能直接核可,這正是實作回報的最大落差。 ----
    {
      const sessionId = await newAlwaysAskSession("E4-harddeny-with-remote-connected");
      const targetFile = path.join(outsideDir, "e4-escape-with-remote.txt");
      const permEvent = await triggerWrite(sessionId, targetFile);
      await localClient
        .waitForEvent((e) => e.sessionId === sessionId && (e.event.type === "completed" || e.event.type === "error"), 15_000)
        .catch(() => {});
      await sleep(300);

      const notStrong = permEvent.strong !== true;
      const resolvedDeny = localClient.permissionResolvedEvents.some(
        (r) => r.requestId === permEvent.requestId && r.decision === "deny" && r.source === "policy",
      );
      const listAfter = await localClient.rpc("session.list", {});
      const neverWaiting = listAfter.sessions.find((s) => s.id === sessionId)?.status !== "waiting";
      const fileNotWritten = !existsSync(targetFile);

      record(
        "【關鍵】E-4: 有遠端 client 連線中時,hard-deny **不降級**為 escalate-strong——即使本機 client 也連著、也沒開 auto,一律直接 deny(不進 waiting、strong 不為 true、檔案未寫入)",
        notStrong && resolvedDeny && neverWaiting && fileNotWritten,
        `notStrong=${notStrong}(strong=${permEvent.strong}), resolvedDeny=${resolvedDeny}, neverWaiting=${neverWaiting}, fileNotWritten=${fileNotWritten}`,
      );
    }

    // ---- E-5(E-4 的對照組):把遠端連線關掉之後,同一個情境恢復成
    //      escalate-strong(走 waiting、strong:true)。兩者唯一的差別就是那條
    //      遠端連線——證明 E-4 的 deny 確實來自 `local` 判定,而不是別的因素。 ----
    {
      remoteClient.close();
      await sleep(800); // 等 core 端處理完 WS close(clients map 移除)

      const sessionId = await newAlwaysAskSession("E5-harddeny-remote-disconnected");
      const targetFile = path.join(outsideDir, "e5-escape-local-only.txt");
      const permEvent = await triggerWrite(sessionId, targetFile);
      await sleep(500);

      const listAfter = await localClient.rpc("session.list", {});
      const wentWaiting = listAfter.sessions.find((s) => s.id === sessionId)?.status === "waiting";
      const isStrong = permEvent.strong === true;

      await localClient.rpc("permission.resolve", { requestId: permEvent.requestId, decision: "deny" }).catch(() => {});
      await localClient
        .waitForEvent((e) => e.sessionId === sessionId && (e.event.type === "completed" || e.event.type === "error"), 15_000)
        .catch(() => {});

      record(
        "E-5(E-4 對照組): 遠端 client 斷線後,同一個 hard-deny 情境恢復降級為 escalate-strong(走 waiting、strong:true)——證明 E-4 的直接 deny 確實由「有遠端連線」造成",
        wentWaiting && isStrong,
        `wentWaiting=${wentWaiting}, isStrong=${isStrong}(strong=${permEvent.strong})`,
      );
    }
  } catch (err) {
    record("E/G 執行過程發生未預期錯誤", false, String(err));
  } finally {
    localClient?.close();
    remoteClient?.close();
    await killProcessTree(coreProc);
  }

  for (const dir of [dataDir, homeDir, workspaceDir, outsideDir]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

// =======================================================================
// H: DB 遷移——舊資料 permission_level="auto-accept-all" 被降級為
//    "auto-accept-edits",且 console.warn 有印(不可靜默)。
// =======================================================================
async function testDbMigration() {
  const dbDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-migration-"));
  const dbPath = path.join(dbDir, "deskmony.db");

  try {
    // 先開一次資料庫,讓 createDb() 的 CREATE TABLE IF NOT EXISTS 建好 schema,
    // 再透過 drizzle 暴露的底層 better-sqlite3 handle(`.$client`)塞一筆
    // 「舊值」進去,模擬升級前的資料——刻意不透過 ProfileStore/zod(那條路徑
    // 現在已經拒絕 "auto-accept-all",無法用來製造這筆舊資料;直接寫 SQL 才能
    // 誠實模擬「這是升級前就存在的資料列」)。
    const dbMod = await import(pathToFileURL(path.join(REPO_ROOT, "packages", "db", "dist", "client.js")).href);
    const firstOpen = dbMod.createDb(dbPath);
    const now = Date.now();
    firstOpen.$client
      .prepare(
        `INSERT INTO agent_profiles (id, name, role, software, permission_level, working_dir, created_at, updated_at)
         VALUES (?, ?, 'Coder', 'claude-agent-sdk', 'auto-accept-all', ?, ?, ?)`,
      )
      .run("legacy-profile-1", "舊 YOLO Profile", os.tmpdir(), now, now);
    firstOpen.$client.close();

    // 攔截 console.warn,確認遷移時真的有印警告(不可靜默)。
    const warnCalls = [];
    const originalWarn = console.warn;
    console.warn = (...args) => {
      warnCalls.push(args.join(" "));
      originalWarn(...args);
    };
    let migratedDb;
    try {
      migratedDb = dbMod.createDb(dbPath); // 這次會跑 migrateAutoAcceptAllPermissionLevel()
    } finally {
      console.warn = originalWarn;
    }

    const rows = migratedDb.$client.prepare("SELECT id, permission_level FROM agent_profiles WHERE id = ?").all("legacy-profile-1");
    migratedDb.$client.close();

    const downgraded = rows.length === 1 && rows[0].permission_level === "auto-accept-edits";
    const warnedAboutProfile = warnCalls.some((line) => line.includes("legacy-profile-1") && line.includes("auto-accept-edits"));
    const warnedAtAll = warnCalls.length > 0;

    record(
      "H: DB 遷移——permission_level='auto-accept-all' 的舊 profile 被降級為 'auto-accept-edits',且 console.warn 有列出該 profile(不可靜默)",
      downgraded && warnedAboutProfile && warnedAtAll,
      `downgraded=${downgraded}, warnedAtAll=${warnedAtAll}, warnedAboutProfile=${warnedAboutProfile}, warnCalls=${JSON.stringify(warnCalls)}`,
    );

    // 冪等驗證:再開一次,這次不應該再有任何降級警告(已經沒有 auto-accept-all 資料列)。
    const warnCalls2 = [];
    console.warn = (...args) => warnCalls2.push(args.join(" "));
    let secondOpen;
    try {
      secondOpen = dbMod.createDb(dbPath);
    } finally {
      console.warn = originalWarn;
    }
    secondOpen.$client.close();
    const idempotent = !warnCalls2.some((line) => line.includes("auto-accept-all"));
    record("H-2: DB 遷移冪等——再次開啟同一個 DB,已經沒有舊資料可降級,不會重複印警告", idempotent, `warnCalls2=${JSON.stringify(warnCalls2)}`);
  } catch (err) {
    record("H: DB 遷移 執行過程發生未預期錯誤", false, String(err));
  }

  try {
    rmSync(dbDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

// =======================================================================
// I: 破壞性 schema 收窄——CreateAgentProfileInputSchema(profile.create)不再
//    接受 permissionLevel:"auto-accept-all"(協議層面就拒絕,不是執行期才發現)。
// =======================================================================
async function testSchemaNarrowing() {
  const PORT = 4344;
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-schema-data-"));
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-schema-home-"));
  const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-schema-ws-"));

  let coreProc;
  let client;
  try {
    coreProc = startCore({ port: PORT, dataDir, homeDir, workspaceDir });
    await waitForPort(`ws://127.0.0.1:${PORT}`, 20_000);
    client = new MiniGatewayClient(`ws://127.0.0.1:${PORT}`);
    await client.connect();

    let rejected = false;
    try {
      await client.rpc("profile.create", {
        name: "Should Be Rejected",
        software: "acp",
        workingDir: workspaceDir,
        acpConfig: { command: process.execPath, args: [FAKE_AGENT_PATH] },
        permissionLevel: "auto-accept-all",
      });
    } catch {
      rejected = true;
    }

    record(
      "I: PermissionLevelSchema 收窄——profile.create 帶 permissionLevel:\"auto-accept-all\" 在協議層面直接被拒(zod 驗證失敗),不是「建立後才發現行為怪怪的」",
      rejected,
      `rejected=${rejected}`,
    );
  } catch (err) {
    record("I 執行過程發生未預期錯誤", false, String(err));
  } finally {
    client?.close();
    await killProcessTree(coreProc);
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

  console.log("=== S7 e2e:A-F(auto/YOLO 主要行為 + 關鍵案例①③)===");
  await testAutoAndYolo();

  console.log("\n=== S7 e2e:D(YOLO 30 分鐘惰性過期,縮短測試)===");
  await testYoloExpiry();

  console.log("\n=== S7 e2e:E/G(關鍵案例② 遠端 LOCAL_ONLY_METHODS + 握手能力集)===");
  await testRemoteRejection();

  console.log("\n=== S7 e2e:H(DB 遷移)===");
  await testDbMigration();

  console.log("\n=== S7 e2e:I(schema 收窄)===");
  await testSchemaNarrowing();

  const failed = results.filter((r) => !r.ok);
  const skipped = results.filter((r) => r.skipped);
  console.log(`\n\n========== 總結:${results.length - failed.length}/${results.length} 通過(其中 ${skipped.length} 筆 skip)==========`);
  for (const r of failed) {
    console.log(`  FAIL: ${r.name}`);
  }
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[e2e-auto-mode-yolo] fatal:", err);
  process.exit(1);
});
