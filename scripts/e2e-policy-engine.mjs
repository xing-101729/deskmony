#!/usr/bin/env node
/**
 * scripts/e2e-policy-engine.mjs
 *
 * S1(PolicyEngine + Enforcement 底座)的端到端/單元驗證,對應
 * docs/LAYER-4-detail-design/policy-engine_detail.md §8 檢查清單最後一項。
 *
 * 分兩部分:
 *   Part 1(單元測試,不啟動 core process):直接 import 編譯後的
 *     apps/core/dist/permissions/policy-engine.js / hard-deny.js,測試
 *     `decide()` 的優先序、比對規則細節,以及 `ExecContext` 各種組合下的
 *     hard-deny 行為(直接餵 ExecContext,不需要真實 gateway 造出該情境)。
 *   Part 2(即時 e2e,透過真實 WS Gateway + fake ACP agent):驗證整合點
 *     本身接得對——allow/deny 自動放行完全不進 waiting、hard-deny 在
 *     「本機+attended」降級為 escalate-strong(仍走 waiting)、hard-deny 在
 *     autoMode 開啟時直接 deny(不進 waiting)、未分類長尾 escalate、
 *     **無 client 連線(無人值守)時 escalate 掛起且不因逾時被 deny**、
 *     有 client 連線時逾時仍 deny、決策落地 enforcement_audit 表。
 *
 * S7 L4 §2.1(2026-07-28 設計修正)之後,`attended` 由「**是否有 client 連線
 * 中**」推導,不再是 `autoMode` 的補數——Part 2 的 2f/2g 就是這個 2×2 的兩個
 * 「未開 auto」象限,靠真的把 WS 連線關掉/接著來製造,不偽造任何欄位。
 *
 * 前置需求:`pnpm build` 已跑過(apps/core/dist、packages/db/dist 存在)。
 *
 * 用法:node scripts/e2e-policy-engine.mjs
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
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
function log(msg) {
  console.log(msg);
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// =======================================================================
// Part 1:單元測試(直接 import 編譯後的模組,不啟動 core process)
// =======================================================================
async function unitTests() {
  const policyEngineMod = await import(
    pathToFileURL(path.join(REPO_ROOT, "apps", "core", "dist", "permissions", "policy-engine.js")).href
  );
  const { PolicyEngine } = policyEngineMod;

  const workingDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-policy-unit-ws-"));
  const outsideDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-policy-unit-outside-"));

  const baseReq = (overrides) => ({
    sessionId: "s1",
    requestId: randomUUID(),
    toolName: "Write",
    input: { file_path: path.join(workingDir, "ok.txt"), content: "x" },
    workingDir,
    ...overrides,
  });

  // ---- 1a: 空政策 + 未分類 → escalate(default-deny) ----
  {
    const engine = new PolicyEngine({ rules: [], allowedHosts: [] });
    const decision = engine.decide(baseReq({ toolName: "SomeUnknownTool", input: {} }), {
      attended: true,
      local: true,
      autoMode: false,
    });
    record(
      "1a 空政策 + 未分類工具 → escalate(default-deny)",
      decision.effect === "escalate",
      `effect=${decision.effect}, reason=${decision.reason}`,
    );
  }

  // ---- 1b:config allow 規則命中 → allow ----
  {
    const engine = new PolicyEngine({
      rules: [{ tool: "Bash", when: { commandEquals: "pnpm test" }, effect: "allow" }],
      allowedHosts: [],
    });
    const decision = engine.decide(
      baseReq({ toolName: "Bash", input: { command: "pnpm test" } }),
      { attended: true, local: true, autoMode: false },
    );
    record("1b config allow 規則(commandEquals 完整比對)命中 → allow", decision.effect === "allow", `effect=${decision.effect}`);
  }

  // ---- 1c:commandMatches 自動包 ^...$,「npm test」規則不得放行「npm test; rm -rf /」----
  {
    const engine = new PolicyEngine({
      rules: [{ tool: "Bash", when: { commandMatches: "npm test" }, effect: "allow" }],
      allowedHosts: [],
    });
    const safeDecision = engine.decide(baseReq({ toolName: "Bash", input: { command: "npm test" } }), {
      attended: true,
      local: true,
      autoMode: false,
    });
    const dangerDecision = engine.decide(
      baseReq({ toolName: "Bash", input: { command: "npm test; rm -rf /" } }),
      { attended: true, local: true, autoMode: false },
    );
    record(
      "1c commandMatches 強制 ^...$ 完整匹配:「npm test」放行,但不放行「npm test; rm -rf /」",
      safeDecision.effect === "allow" && dangerDecision.effect !== "allow",
      `safe=${safeDecision.effect}, danger=${dangerDecision.effect}(danger 應為 escalate,不可為 allow)`,
    );
  }

  // ---- 1d:pathUnder 以路徑分隔符為界,`/a/b` 不得比對到 `/a/bc` ----
  {
    const boundaryDir = path.join(workingDir, "a", "b");
    mkdirSync(boundaryDir, { recursive: true });
    const siblingDir = path.join(workingDir, "a", "bc");
    mkdirSync(siblingDir, { recursive: true });

    const engine = new PolicyEngine({
      rules: [{ tool: "Write", when: { pathUnder: boundaryDir }, effect: "allow" }],
      allowedHosts: [],
    });
    const insideDecision = engine.decide(
      baseReq({ toolName: "Write", input: { file_path: path.join(boundaryDir, "f.txt") } }),
      { attended: true, local: true, autoMode: false },
    );
    const siblingDecision = engine.decide(
      baseReq({ toolName: "Write", input: { file_path: path.join(siblingDir, "f.txt") } }),
      { attended: true, local: true, autoMode: false },
    );
    record(
      "1d pathUnder 以路徑分隔符為界:.../a/b 下的檔案 allow,.../a/bc(同前綴但非子目錄)不 allow",
      insideDecision.effect === "allow" && siblingDecision.effect !== "allow",
      `inside=${insideDecision.effect}, sibling=${siblingDecision.effect}(sibling 應為 escalate)`,
    );
  }

  // ---- 1e:規則依序比對,第一個 match 決定(deny 排在前面優先於後面的 allow)----
  {
    const engine = new PolicyEngine({
      rules: [
        { tool: "Write", when: { pathUnder: workingDir }, effect: "deny" },
        { tool: "Write", when: { pathUnder: workingDir }, effect: "allow" },
      ],
      allowedHosts: [],
    });
    const decision = engine.decide(baseReq(), { attended: true, local: true, autoMode: false });
    record(
      "1e 規則陣列順序決定優先序:deny 規則排前面時,即使後面有更寬鬆的 allow 規則也是 deny",
      decision.effect === "deny" && decision.matchedRule === 0,
      `effect=${decision.effect}, matchedRule=${decision.matchedRule}`,
    );
  }

  // ---- 1f:hard-deny(worktree 外寫入)命中時,即使 autoMode=true 也絕不 allow ----
  //         四種 ExecContext 組合一次驗完(單元層級最省事;其中幾種也在 Part 2
  //         以真實連線狀態驗證,見 2c/2d 與 e2e-auto-mode-yolo 的 E-4)。
  {
    const engine = new PolicyEngine({ rules: [], allowedHosts: [] });
    const escapeReq = baseReq({ toolName: "Write", input: { file_path: path.join(outsideDir, "escape.txt") } });

    const remoteOrAutoDecision = engine.decide(escapeReq, { attended: true, local: false, autoMode: true });
    const localAutoDecision = engine.decide(escapeReq, { attended: true, local: true, autoMode: true });
    const localAttendedDecision = engine.decide(escapeReq, { attended: true, local: true, autoMode: false });
    const localUnattendedDecision = engine.decide(escapeReq, { attended: false, local: true, autoMode: false });

    const ok =
      remoteOrAutoDecision.effect === "deny" &&
      localAutoDecision.effect === "deny" && // 本機+attended 但 autoMode=true → 仍硬 deny,autoMode 優先於 attended
      localAttendedDecision.effect === "escalate-strong" && // 唯一能降級的組合(本機+attended+非 autoMode)
      localUnattendedDecision.effect === "deny"; // 保守:本機但沒人看 → 硬 deny(見最終報告的自行判斷說明)

    record(
      "1f hard-deny(worktree 外寫入)命中時,任何 autoMode/遠端組合都絕不 allow;只有「本機+attended」降級為 escalate-strong",
      ok,
      `remote-or-auto=${remoteOrAutoDecision.effect}, local+autoMode=${localAutoDecision.effect}, ` +
        `local+attended=${localAttendedDecision.effect}, local+unattended=${localUnattendedDecision.effect}`,
    );
  }

  // ---- 1g:autoMode 中間地帶自動放行,但不影響 hard-deny/config deny 優先序 ----
  {
    const engine = new PolicyEngine({ rules: [], allowedHosts: [] });
    const decision = engine.decide(baseReq({ toolName: "SomeUnknownTool", input: {} }), {
      attended: false,
      local: true,
      autoMode: true,
    });
    record(
      "1g autoMode=true 時,未分類長尾(非 hard-deny)自動放行",
      decision.effect === "allow",
      `effect=${decision.effect}`,
    );
  }

  // ---- 1h:input 猜不到路徑/指令(判定失敗)→ 不 hard-deny、不 allow,落到 escalate ----
  {
    const engine = new PolicyEngine({ rules: [], allowedHosts: [] });
    const decision = engine.decide(baseReq({ toolName: "Write", input: { totallyUnknownField: 123 } }), {
      attended: true,
      local: true,
      autoMode: false,
    });
    record(
      "1h 猜不到路徑欄位(判定失敗)→ escalate(不 fail-open 成 allow,也不誤判成 hard-deny)",
      decision.effect === "escalate",
      `effect=${decision.effect}`,
    );
  }

  // ---- 1i:S7 L4 §2.1 修正的核心——`attended` 與 `autoMode` 正交,
  //          「無人值守 + 未開 auto」這個象限必須落到 escalate(而不是被自動
  //          放行)。修正前這個組合根本不可能出現(attended 是 autoMode 的
  //          補數),第 5 步的 escalate + S1 L4 §6 的「不逾時 deny」因此變成
  //          死碼——這條斷言就是在守住那個象限不再被消滅。 ----
  {
    const engine = new PolicyEngine({ rules: [], allowedHosts: [] });
    const req = baseReq({ toolName: "SomeUnknownTool", input: {} });
    const unattendedNoAuto = engine.decide(req, { attended: false, local: true, autoMode: false });
    const unattendedWithAuto = engine.decide(req, { attended: false, local: true, autoMode: true });
    const attendedNoAuto = engine.decide(req, { attended: true, local: true, autoMode: false });
    const attendedWithAuto = engine.decide(req, { attended: true, local: true, autoMode: true });

    record(
      "1i attended × autoMode 的 2×2 完整可達(S7 L4 §2.1 修正):未開 auto 時,不論有沒有人在,未分類請求都是 escalate;開了 auto 才自動放行",
      unattendedNoAuto.effect === "escalate" &&
        attendedNoAuto.effect === "escalate" &&
        unattendedWithAuto.effect === "allow" &&
        attendedWithAuto.effect === "allow",
      `unattended+noAuto=${unattendedNoAuto.effect}(必須是 escalate,這是被救回來的象限), ` +
        `attended+noAuto=${attendedNoAuto.effect}, unattended+auto=${unattendedWithAuto.effect}, attended+auto=${attendedWithAuto.effect}`,
    );
  }

  rmSync(workingDir, { recursive: true, force: true });
  rmSync(outsideDir, { recursive: true, force: true });
}

// =======================================================================
// Part 2:即時 e2e(真實 WS Gateway + fake ACP agent + 真實 SQLite 稽核表)
// =======================================================================

class MiniGatewayClient {
  constructor(url) {
    this.url = url;
    this.pendingRpc = new Map();
    this.events = [];
    this.sessionUpdates = [];
    this.waiters = [];
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
      } else if (msg.channel === "session-updated") {
        this.sessionUpdates.push(msg.payload);
      } else if (msg.channel === "permission-resolved") {
        this.permissionResolvedEvents = this.permissionResolvedEvents ?? [];
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
}

function startCore({ port, dataDir, homeDir, workspaceDir, permissionTimeoutMs }) {
  const env = {
    ...process.env,
    DESKMONY_CORE_PORT: String(port),
    DESKMONY_DATA_DIR: dataDir,
    DESKMONY_HOME: homeDir,
    DESKMONY_WORKSPACE: workspaceDir,
    DESKMONY_PERMISSION_TIMEOUT_MS: String(permissionTimeoutMs),
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
  const PORT = 4331;
  const PERMISSION_TIMEOUT_MS = 3000; // 縮短逾時,測試「attended 才逾時」用
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-policy-data-"));
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-policy-home-"));
  const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-policy-ws-"));
  const outsideWorktreeDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-policy-outside-"));

  const allowedSubDir = path.join(workspaceDir, "allowed-sub");
  const deniedSubDir = path.join(workspaceDir, "denied-sub");
  const unclassifiedSubDir = path.join(workspaceDir, "unclassified-sub");
  mkdirSync(allowedSubDir, { recursive: true });
  mkdirSync(deniedSubDir, { recursive: true });
  mkdirSync(unclassifiedSubDir, { recursive: true });

  // 這輪測試唯一使用到的 policy 規則:deny 規則放在陣列前端(比照「寫入時
  // unshift」的既有慣例),allow 規則放後面——驗證「第一個 match 決定」不會
  // 被陣列順序以外的邏輯干擾。fake-acp-agent 的 Write 工具 toolName 是固定的
  // 人類標題 "Write file"(見 acp-adapter.ts),用 pathUnder 區分 allow/deny。
  const configJson = {
    version: 1,
    policy: {
      rules: [
        { tool: "Write file", when: { pathUnder: deniedSubDir }, effect: "deny" },
        { tool: "Write file", when: { pathUnder: allowedSubDir }, effect: "allow" },
      ],
      allowedHosts: [],
    },
  };
  writeFileSync(path.join(homeDir, "config.json"), JSON.stringify(configJson, null, 2), "utf8");

  let coreProc;
  let client;
  // S7 L4 §2.1 之後,profile.permissionLevel 只決定 session 暫態的**初值**
  // (⇒ `ExecContext.autoMode`),**不再**決定 `attended`——後者只看「現在有沒
  // 有 client 連線中」。所以這兩個 helper 的差別純粹是 autoMode 開/關。
  const alwaysAskProfileFor = async (name) =>
    client.rpc("profile.create", {
      name,
      software: "acp",
      workingDir: workspaceDir,
      acpConfig: { command: process.execPath, args: [FAKE_AGENT_PATH] },
      permissionLevel: "always-ask", // autoMode = false
    });
  const autoModeProfileFor = async (name) =>
    client.rpc("profile.create", {
      name,
      software: "acp",
      workingDir: workspaceDir,
      acpConfig: { command: process.execPath, args: [FAKE_AGENT_PATH] },
      // S7(auto-mode-and-yolo)L4 §1.1 收窄了 PermissionLevelSchema,移除
      // "auto-accept-all"(YOLO 現在只能是 session 暫態,見
      // packages/shared/src/agent-profile.ts),所以「開著 auto 的 session」
      // 這裡用 "auto-accept-edits" 當初值,不必額外呼叫 setPermissionMode。
      permissionLevel: "auto-accept-edits", // autoMode = true
    });

  const createdSessions = [];
  const createSessionFor = async (profileId, title) => {
    const created = await client.rpc("session.create", { agentProfileId: profileId, workingDir: workspaceDir, title }, 30_000);
    createdSessions.push(created.session.id);
    return created.session.id;
  };

  /** 只送出寫檔 prompt,**不**等待 permission-request(2f 用:送出後要先把
   *  WS 連線關掉,讓權限請求在「沒有任何 client 連線」的狀態下抵達 core)。
   *  `delayMs` 由 fake-acp-agent 端消化,見該檔案的 handleWriteFile()。 */
  const sendWritePrompt = async (sessionId, targetPath, { content = "content", delayMs } = {}) => {
    const posixPath = targetPath.split(path.sep).join("/");
    await client.rpc("session.sendPrompt", {
      sessionId,
      prompt: { text: `${WRITE_FILE_PREFIX}${JSON.stringify({ path: posixPath, content, ...(delayMs ? { delayMs } : {}) })}` },
    });
  };

  /** 送出一個會觸發 permission-request 的寫檔 prompt,回傳 { requestId, event }。 */
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
    coreProc = startCore({ port: PORT, dataDir, homeDir, workspaceDir, permissionTimeoutMs: PERMISSION_TIMEOUT_MS });
    await waitForPort(`ws://localhost:${PORT}`, 20_000);
    client = new MiniGatewayClient(`ws://localhost:${PORT}`);
    await client.connect();

    const attendedProfile = (await alwaysAskProfileFor("E2E Policy AlwaysAsk")).profile;
    const autoModeProfile = (await autoModeProfileFor("E2E Policy AutoMode")).profile;

    // ---- 2a: config allow 規則命中 → 自動放行,完全不進 waiting,source="policy" ----
    {
      const sessionId = await createSessionFor(attendedProfile.id, "2a-allow");
      const updatesBefore = client.sessionUpdates.length;
      const targetFile = path.join(allowedSubDir, "allow-me.txt");
      const permEvent = await triggerWritePermission(sessionId, targetFile, "allow content");

      await client.waitForEvent(
        (e) => e.sessionId === sessionId && (e.event.type === "completed" || e.event.type === "error"),
        15_000,
      );
      await sleep(300); // 讓 permission-resolved / session-updated 推播都送達

      const wentWaiting = client.sessionUpdates
        .slice(updatesBefore)
        .some((u) => u.id === sessionId && u.status === "waiting");
      const resolvedPolicy = (client.permissionResolvedEvents ?? []).some(
        (r) => r.sessionId === sessionId && r.requestId === permEvent.requestId && r.decision === "allow" && r.source === "policy",
      );
      const fileWritten = existsSync(targetFile);

      record(
        "2a config allow 規則:自動放行、完全不進 waiting、permission-resolved.source=\"policy\"、檔案確實寫入",
        !wentWaiting && resolvedPolicy && fileWritten,
        `wentWaiting=${wentWaiting}, resolvedPolicy=${resolvedPolicy}, fileWritten=${fileWritten}`,
      );
    }

    // ---- 2b: config deny 規則命中 → 自動拒絕,完全不進 waiting,不寫檔 ----
    {
      const sessionId = await createSessionFor(attendedProfile.id, "2b-deny");
      const updatesBefore = client.sessionUpdates.length;
      const targetFile = path.join(deniedSubDir, "deny-me.txt");
      const permEvent = await triggerWritePermission(sessionId, targetFile, "deny content");

      await client.waitForEvent(
        (e) => e.sessionId === sessionId && (e.event.type === "completed" || e.event.type === "error"),
        15_000,
      );
      await sleep(300);

      const wentWaiting = client.sessionUpdates
        .slice(updatesBefore)
        .some((u) => u.id === sessionId && u.status === "waiting");
      const resolvedPolicy = (client.permissionResolvedEvents ?? []).some(
        (r) => r.sessionId === sessionId && r.requestId === permEvent.requestId && r.decision === "deny" && r.source === "policy",
      );
      const fileNotWritten = !existsSync(targetFile);

      record(
        "2b config deny 規則:自動拒絕、完全不進 waiting、permission-resolved.source=\"policy\"、檔案未寫入",
        !wentWaiting && resolvedPolicy && fileNotWritten,
        `wentWaiting=${wentWaiting}, resolvedPolicy=${resolvedPolicy}, fileNotWritten=${fileNotWritten}`,
      );
    }

    // ---- 2c: hard-deny(worktree 外寫入)+ 本機 + attended → escalate-strong,
    //          仍走 waiting(不是自動 deny,人可以強確認),手動 resolve 清理 ----
    {
      const sessionId = await createSessionFor(attendedProfile.id, "2c-harddeny-attended");
      const targetFile = path.join(outsideWorktreeDir, "escape-attended.txt");
      const permEvent = await triggerWritePermission(sessionId, targetFile);

      await sleep(500);
      const listAfter = await client.rpc("session.list", {});
      const session = listAfter.sessions.find((s) => s.id === sessionId);
      const wentWaiting = session?.status === "waiting";

      await client.rpc("permission.resolve", { requestId: permEvent.requestId, decision: "deny" });
      await client.waitForEvent(
        (e) => e.sessionId === sessionId && (e.event.type === "completed" || e.event.type === "error"),
        15_000,
      );
      const fileNotWritten = !existsSync(targetFile);

      record(
        "2c hard-deny(worktree 外寫入)+ 本機 + attended → escalate-strong,走 waiting(唯一能人工強確認的組合)",
        wentWaiting && fileNotWritten,
        `wentWaiting=${wentWaiting}(session.status=${session?.status}), fileNotWritten=${fileNotWritten}`,
      );
    }

    // ---- 2d: hard-deny(worktree 外寫入)+ 本機 + autoMode 開啟 → 直接 deny,
    //          不進 waiting。**autoMode 優先於 attended**:即使此刻有 client
    //          連著(attended=true),開了 auto 就不降級成 escalate-strong
    //          (C6:auto 開著時硬性類仍是硬地板,見 policy-engine.ts 第 1 步)。
    //          S7 L4 §2.1 修正前這條測的是「非 attended」,修正後 attended 不
    //          再由 profile 決定,同一個 session 改由 autoMode 這條分支命中。 ----
    {
      const sessionId = await createSessionFor(autoModeProfile.id, "2d-harddeny-automode");
      const updatesBefore = client.sessionUpdates.length;
      const targetFile = path.join(outsideWorktreeDir, "escape-automode.txt");
      const permEvent = await triggerWritePermission(sessionId, targetFile);

      await client.waitForEvent(
        (e) => e.sessionId === sessionId && (e.event.type === "completed" || e.event.type === "error"),
        15_000,
      );
      await sleep(300);

      const wentWaiting = client.sessionUpdates
        .slice(updatesBefore)
        .some((u) => u.id === sessionId && u.status === "waiting");
      const resolvedPolicy = (client.permissionResolvedEvents ?? []).some(
        (r) => r.sessionId === sessionId && r.requestId === permEvent.requestId && r.decision === "deny" && r.source === "policy",
      );
      const fileNotWritten = !existsSync(targetFile);

      record(
        "2d hard-deny(worktree 外寫入)+ 本機 + autoMode 開啟 → 直接 deny(不降級為 escalate-strong),不進 waiting",
        !wentWaiting && resolvedPolicy && fileNotWritten,
        `wentWaiting=${wentWaiting}, resolvedPolicy=${resolvedPolicy}, fileNotWritten=${fileNotWritten}`,
      );
    }

    // ---- 2e: 未分類長尾(非 hard-deny、無 config 規則命中)→ escalate,走 waiting ----
    {
      const sessionId = await createSessionFor(attendedProfile.id, "2e-escalate-unclassified");
      const targetFile = path.join(unclassifiedSubDir, "unclassified.txt");
      const permEvent = await triggerWritePermission(sessionId, targetFile);

      await sleep(500);
      const listAfter = await client.rpc("session.list", {});
      const session = listAfter.sessions.find((s) => s.id === sessionId);
      const wentWaiting = session?.status === "waiting";

      await client.rpc("permission.resolve", { requestId: permEvent.requestId, decision: "deny" });
      await client.waitForEvent(
        (e) => e.sessionId === sessionId && (e.event.type === "completed" || e.event.type === "error"),
        15_000,
      );

      record(
        "2e 未分類長尾(不命中 hard-deny/config 規則)→ escalate,走 waiting",
        wentWaiting,
        `session.status(升級當下)=${session?.status}`,
      );
    }

    // ---- 2f【S7 L4 §2.1 修正後救回來的象限】:**無 client 連線 + 未開 auto**
    //          → 未分類請求走 escalate 掛起等人,且**不因逾時被 deny**
    //          (S1 L4 §6 / S11 §4:「沒人回應 ≠ 拒絕」,不該讓整晚工作白費)。
    //
    //          修正前這個象限根本不存在(attended 是 autoMode 的補數 ⇒
    //          attended=false 必然 autoMode=true ⇒ 未分類請求在 decide() 第 4
    //          步就被自動放行),`PermissionGateway.register(timeoutMs=null)`
    //          那條分支因此是死碼。這裡誠實地把 WS 連線**真的關掉**來製造
    //          「沒人看得到彈窗」——不偽造任何欄位,因為連線狀態就是 attended
    //          的唯一判定來源(見 ws-gateway.ts 的 hasConnectedClient())。
    //
    //          時序:sendPrompt(帶 delayMs)→ 立刻關閉 WS → fake agent 延遲後
    //          才送出權限請求 ⇒ decide() 當下 hasConnectedClient() === false。
    {
      const PROMPT_DELAY_MS = 2500;
      const sessionId = await createSessionFor(attendedProfile.id, "2f-unattended-hangs");
      const targetFile = path.join(unclassifiedSubDir, "unattended-hangs.txt");
      await sendWritePrompt(sessionId, targetFile, { delayMs: PROMPT_DELAY_MS });

      // 關閉唯一的 client 連線,並確認 core 端真的處理完 close(留餘裕)。
      client.close();
      await sleep(500);

      // 等到「權限請求已抵達 + 遠超過 attended 的逾時時間」都過去為止。若
      // 修正沒生效(仍設了計時器),這段時間內就會被逾時 deny。
      await sleep(PROMPT_DELAY_MS + PERMISSION_TIMEOUT_MS + 2500);

      // 重新連上,直接看 DB 裡的 session 狀態(逾時 deny 會把它推回 busy →
      // completed/idle,所以「仍是 waiting」就是「沒有被逾時 deny」的鐵證)。
      client = new MiniGatewayClient(`ws://localhost:${PORT}`);
      await client.connect();
      const listAfter = await client.rpc("session.list", {});
      const session = listAfter.sessions.find((s) => s.id === sessionId);
      const stillWaiting = session?.status === "waiting";
      const fileNotWritten = !existsSync(targetFile);

      record(
        "【修正後救回的象限】2f 無 client 連線(無人值守)+ 未開 auto:未分類請求走 escalate 掛起,超過逾時時間仍維持 waiting——不因沒人回應而被 deny",
        stillWaiting && fileNotWritten,
        `stillWaiting=${stillWaiting}(session.status=${session?.status},等了 ${PROMPT_DELAY_MS + PERMISSION_TIMEOUT_MS + 3000}ms,逾時設定=${PERMISSION_TIMEOUT_MS}ms), fileNotWritten=${fileNotWritten}`,
      );
      // 這筆 pending 請求刻意不 resolve(它就該一直掛著)——直接刪 session
      // 清理,adapter handle 會一併 dispose。
      await client.rpc("session.delete", { sessionId }).catch(() => {});
    }

    // ---- 2g(2f 的對照組,既有行為不可退步):**有 client 連線 + 未開 auto**
    //          → 逐筆問,逾時 5 分鐘(這裡縮短為 PERMISSION_TIMEOUT_MS)後
    //          deny。與 2f 唯一的差別就是「此刻有沒有人看得到彈窗」。 ----
    {
      const sessionId = await createSessionFor(attendedProfile.id, "2g-attended-timeout-deny");
      const targetFile = path.join(unclassifiedSubDir, "attended-timeout.txt");
      const permEvent = await triggerWritePermission(sessionId, targetFile);

      await sleep(500);
      const listDuring = await client.rpc("session.list", {});
      const wentWaiting = listDuring.sessions.find((s) => s.id === sessionId)?.status === "waiting";

      // 刻意不回應,等逾時自動 deny(source="timeout")。
      await sleep(PERMISSION_TIMEOUT_MS + 1500);
      const timedOutDeny = (client.permissionResolvedEvents ?? []).some(
        (r) => r.sessionId === sessionId && r.requestId === permEvent.requestId && r.decision === "deny" && r.source === "timeout",
      );
      const fileNotWritten = !existsSync(targetFile);

      record(
        "2g 有 client 連線(attended)+ 未開 auto:未分類請求走 escalate(waiting),逾時未回應 → 自動 deny(source=\"timeout\"),既有行為不變",
        wentWaiting && timedOutDeny && fileNotWritten,
        `wentWaiting=${wentWaiting}, timedOutDeny=${timedOutDeny}, fileNotWritten=${fileNotWritten}`,
      );
    }

    // 清理所有 session。
    for (const sid of createdSessions) {
      try {
        await client.rpc("session.delete", { sessionId: sid });
      } catch {
        // ignore
      }
    }
  } catch (err) {
    record("Part 2 即時 e2e 執行過程發生未預期錯誤", false, String(err));
  } finally {
    client?.close();
    await killProcessTree(coreProc);
  }

  // ---- 2h: enforcement_audit 表有落地(core process 已結束,直接開 sqlite 檔讀取)----
  try {
    const dbMod = await import(pathToFileURL(path.join(REPO_ROOT, "packages", "db", "dist", "client.js")).href);
    const dbPath = path.join(dataDir, "deskmony.db");
    const db = dbMod.createDb(dbPath);
    const rows = db.$client.prepare("SELECT kind, session_id, tool_name, effect, reason FROM enforcement_audit").all();
    db.$client.close();

    const decisionRows = rows.filter((r) => r.kind === "decision");
    const escalationRows = rows.filter((r) => r.kind === "escalation");
    const hasAllowRow = decisionRows.some((r) => r.effect === "allow");
    const hasDenyRow = decisionRows.some((r) => r.effect === "deny");
    const hasEscalateRow = decisionRows.some((r) => r.effect === "escalate" || r.effect === "escalate-strong");

    record(
      "2h enforcement_audit 表落地:decision/escalation 事件都有寫入(含自動放行,append-only)",
      rows.length > 0 && hasAllowRow && hasDenyRow && hasEscalateRow && escalationRows.length > 0,
      `總筆數=${rows.length}, decision=${decisionRows.length}(allow=${hasAllowRow}, deny=${hasDenyRow}, escalate 系=${hasEscalateRow}), escalation=${escalationRows.length}`,
    );
  } catch (err) {
    record("2h enforcement_audit 表落地驗證", false, String(err));
  }

  for (const dir of [dataDir, homeDir, workspaceDir, outsideWorktreeDir]) {
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

  log("=== Part 1:PolicyEngine 單元測試 ===");
  await unitTests();

  log("\n=== Part 2:即時 e2e(真實 WS Gateway + fake ACP agent) ===");
  await liveE2e();

  const failed = results.filter((r) => !r.ok);
  log(`\n\n========== 總結:${results.length - failed.length}/${results.length} 通過 ==========`);
  for (const r of failed) {
    log(`  FAIL: ${r.name}`);
  }
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[e2e-policy-engine] fatal:", err);
  process.exit(1);
});
