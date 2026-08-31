#!/usr/bin/env node
/**
 * scripts/e2e-message-budget.mjs
 *
 * S2(訊息預算 + Mailbox 持久化,第三條斷路器)端到端驗證,對應
 * docs/LAYER-4-detail-design/message-budget_detail.md §7 檢查清單最後一項。
 *
 * 沿用 scripts/e2e-cost-governor.mjs / scripts/e2e-policy-engine.mjs 的手法
 * (真實 WS Gateway + fake ACP agent,決定性、不依賴真實模型行為),獨立可
 * 執行,不 import 其他 e2e 腳本。
 *
 * 全程透過 gateway RPC 直接呼叫 `MessageBus.sendMessage()`/`broadcast()`
 * (`message.sendMessage`/`message.broadcast`,這輪新增,見
 * packages/shared/src/gateway.ts)——team-bus MCP 工具只掛載在真實的 Claude
 * Agent SDK session 上,沒有不依賴真實模型的決定性呼叫路徑,這正是這兩個
 * gateway 入口存在的理由(比照 `message.reportStatus`/`message.requestReview`
 * 的既有先例)。
 *
 * 涵蓋(§7 檢查清單「e2e」項目逐一對應):
 *   A.(2026-08-28 更新)未綁任務時 sendMessage/broadcast 不再拒收,改落一個
 *      穩定、Core 推導、agent 無法指定的 per-member contextId(不同 member
 *      彼此隔離、依然受既有訊息數上限管制——見 message-bus.ts 頂端「2026-08-28
 *      補充」說明,原因是使用者實測發現原本的「一律拒收」連帶擋住了沒有任務
 *      在身的成員回覆人類/隊友隨口訊息的正常情境)
 *   B. agent 無法偽造 contextId(gateway 參數多塞 contextId 完全無效;換了
 *      綁定的任務,下一則訊息的 contextId 自動跟著換,不需要、也無法由呼叫端
 *      指定)
 *   C. 超過上限 → trip + 拒收,但 report_status 仍可用、session 未 halt
 *   D. broadcast 展開成 N 筆,放大消耗額度(agent 端 `broadcast()`)
 *   E. 人類插話 broadcast 也展開成 N 筆並且全部送達(這輪把 `to:"broadcast"`
 *      的投遞路徑整個換掉,原本完全沒有 e2e 覆蓋,這裡補上)
 *   F. 遷移:舊資料(pre-S2 schema)一律標記為已送達,不會一次全灌給 agent
 *   G. 崩潰重啟後未送達訊息仍被投遞(`delivered_at IS NULL` 存活),且不重複
 *      投遞
 *
 * 前置需求:`pnpm build` 已跑過。
 * 用法:node scripts/e2e-message-budget.mjs
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmdirSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { delayEchoMarker } from "./fake-acp-agent.mjs";

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
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function runGitSync(args, cwd) {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

// =======================================================================
class MiniGatewayClient {
  constructor(url, token) {
    this.url = url;
    this.token = token;
    this.pendingRpc = new Map();
    this.events = [];
    this.sessionUpdates = [];
    this.enforcementNotifications = [];
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
      } else if (msg.channel === "enforcement-notification") {
        this.enforcementNotifications.push(msg.payload);
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
      // 刻意用原始物件送出(不經過 zod schema 限制)——測試 B 需要能夠在
      // params 裡多塞一個 gateway schema 沒有定義的欄位(例如 contextId),
      // 驗證即使真的送到 wire 上也完全不會被 MessageBus 採用。
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
  waitForEnforcementNotification(predicate, timeoutMs, fromIndex = 0) {
    return this.waitFor(this.enforcementNotifications, predicate, timeoutMs, fromIndex);
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

/** 寫一份帶 `messageBudget` 區塊的 config.json——這個區塊只能靠設定檔覆寫
 *  (F4,遠端不可改,見 packages/shared/src/core-config.ts 的
 *  `ConfigSetFilePatchSchema` 刻意不含 `messageBudget` 的說明),沒有對應的
 *  環境變數,只能在啟動前寫好這個檔案。 */
function writeConfigWithMessageBudget(configPath, maxMessagesPerContext) {
  writeFileSync(
    configPath,
    JSON.stringify({ version: 1, messageBudget: { maxMessagesPerContext, warnAtPercent: 80 } }, null, 2),
    "utf8",
  );
}

function initGitRepo(repoDir) {
  runGitSync(["init"], repoDir);
  runGitSync(["config", "user.email", "e2e@deskmony.local"], repoDir);
  runGitSync(["config", "user.name", "Deskmony E2E"], repoDir);
  writeFileSync(path.join(repoDir, "README.md"), "# e2e message-budget repo\n", "utf8");
  runGitSync(["add", "."], repoDir);
  return runGitSync(["commit", "-m", "initial commit"], repoDir);
}

/**
 * 清掉這個測試自己建立的任務 worktree。
 *
 * task.assign 建立的 worktree **不在** repoDir 底下,而是
 * `<repoDir 的上層>/.deskmony-worktrees/<repoDir 名稱>-task-<8 碼>`(見
 * apps/core/src/workspace/workspace-manager.ts 的 `createWorkspaceForTask()`),
 * 所以各測試收尾時的 `rmSync([dataDir, homeDir, repoDir])` 掃不到它們,每跑一次
 * 就在系統暫存目錄留下殘留。這幾個測試收尾時已經先 kill 掉 core,gateway 不在了,
 * 沒辦法走 `task.delete` 那條正規路徑 —— 直接用檔案系統清理。
 *
 * ⚠️ `.deskmony-worktrees` 這個根目錄是**所有** e2e 共用的(都在 os.tmpdir()
 * 底下),絕不能整個刪掉:可能有另一支 e2e 正在跑。這裡只刪前綴對得上這個
 * repoDir 的項目,根目錄則只在「刪完之後恰好是空的」時才順手移除。
 */
function rmTaskWorktrees(repoDir) {
  const root = path.join(path.dirname(repoDir), ".deskmony-worktrees");
  if (!existsSync(root)) return;
  const prefix = `${path.basename(repoDir)}-task-`;
  let entries;
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.startsWith(prefix)) continue;
    try {
      rmSync(path.join(root, name), { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  try {
    if (readdirSync(root).length === 0) rmdirSync(root);
  } catch {
    // 還有別的測試的 worktree 在裡面(或剛好有人在用),留著即可。
  }
}

async function createAcpProfile(client, workspaceDir, name) {
  const { profile } = await client.rpc("profile.create", {
    name,
    software: "acp",
    workingDir: workspaceDir,
    acpConfig: { command: process.execPath, args: [FAKE_AGENT_PATH] },
  });
  return profile;
}

async function waitForMessageContaining(client, sessionId, substring, timeoutMs) {
  return client.waitForEvent(
    (e) =>
      e.sessionId === sessionId &&
      e.event.type === "message-delta" &&
      typeof e.event.delta === "string" &&
      e.event.delta.includes(substring),
    timeoutMs,
  );
}

// =======================================================================
// A: 未綁任務 → sendMessage / broadcast 皆拒收;但 report_status 完全不受影響。
// =======================================================================
async function testNoTaskOwnBudget() {
  const gitVersion = runGitSync(["--version"], process.cwd());
  if (gitVersion.status !== 0) {
    record("A(git 不可用,整個步驟略過)", false, `找不到可用的 git 執行檔: ${gitVersion.error ?? gitVersion.stderr}`);
    return;
  }

  const PORT = 4370;
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-msgbudget-a-data-"));
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-msgbudget-a-home-"));
  const repoDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-msgbudget-a-repo-"));
  const configPath = path.join(homeDir, "config.json");
  // 夠大讓 A1 的 3 則(send1/send2/broadcast)不會提前撞頂,又夠小讓 A2 能在
  // 幾則之內把它送到頂驗證確實會 trip。
  const MAX = 5;
  writeConfigWithMessageBudget(configPath, MAX);

  let coreProc;
  let client;
  try {
    initGitRepo(repoDir);
    coreProc = startCore({ port: PORT, dataDir, homeDir, workspaceDir: repoDir });
    await waitForPort(`ws://127.0.0.1:${PORT}`, 20_000);
    client = new MiniGatewayClient(`ws://127.0.0.1:${PORT}`);
    await client.connect();

    const team = await client.rpc("team.create", { name: "E2E MsgBudget A Team", workingDir: repoDir });
    const teamId = team.team.id;
    const profile = await createAcpProfile(client, repoDir, "E2E MsgBudget A Profile");
    const { member } = await client.rpc("team.addMember", {
      teamId,
      agentProfileId: profile.id,
      name: "NoTaskMember",
      role: "Coder",
      canInterrupt: false,
    });
    const { member: otherMember } = await client.rpc("team.addMember", {
      teamId,
      agentProfileId: profile.id,
      name: "OtherNoTaskMember",
      role: "Coder",
      canInterrupt: false,
    });
    await client.rpc("team.addMember", {
      teamId,
      agentProfileId: profile.id,
      name: "Target",
      role: "Coder",
      canInterrupt: false,
    });

    // ---- A1: 沒有綁定任何進行中任務 → 不再拒收,落一個穩定的 per-member
    // contextId(同一 member 重複使用同一個桶;broadcast 也走同一套推導)----
    const expectedContextId = `member:${member.id}`;
    const send1 = await client.rpc("message.sendMessage", { teamId, fromMemberId: member.id, to: "Target", content: "hello" });
    const send2 = await client.rpc("message.sendMessage", { teamId, fromMemberId: member.id, to: "Target", content: "hello again" });
    const contextIdStableAcrossSends = send1.message.contextId === expectedContextId && send2.message.contextId === expectedContextId;

    let broadcastOk = false;
    let broadcastContextId;
    try {
      const broadcastResult = await client.rpc("message.broadcast", { teamId, fromMemberId: member.id, content: "hello all" });
      broadcastOk = true;
      broadcastContextId = broadcastResult.message.contextId;
    } catch {
      broadcastOk = false;
    }

    // 不同、同樣沒有任務的成員 → 各自獨立的桶,不會互相混在一起。
    const otherSend = await client.rpc("message.sendMessage", { teamId, fromMemberId: otherMember.id, to: "Target", content: "hi from other" });
    const isolatedPerMember = otherSend.message.contextId === `member:${otherMember.id}` && otherSend.message.contextId !== expectedContextId;

    // report_status 完全不受影響,固定走 "legacy"、不佔用任何 per-member 額度。
    let reportStatusOk = false;
    try {
      const { message } = await client.rpc("message.reportStatus", {
        teamId,
        fromMemberId: member.id,
        status: "in-progress",
        summary: "still working without any bound task",
      });
      reportStatusOk = Boolean(message) && message.contextId === "legacy";
    } catch {
      reportStatusOk = false;
    }

    record(
      "A1: 沒有進行中任務時,send_message/broadcast 不再拒收,改落一個穩定、Core 推導、agent 無法指定的 per-member contextId(同一 member 重複使用同一個桶,不同 member 彼此隔離);report_status 不受影響",
      contextIdStableAcrossSends && broadcastOk && broadcastContextId === expectedContextId && isolatedPerMember && reportStatusOk,
      `send1.contextId=${send1.message.contextId}(應=${expectedContextId}), send2.contextId=${send2.message.contextId}, ` +
        `broadcastOk=${broadcastOk}(contextId=${broadcastContextId}), otherMember.contextId=${otherSend.message.contextId}, reportStatusOk=${reportStatusOk}`,
    );

    // ---- A2: 無任務的 per-member 桶依然受既有訊息數上限管制,不是繞過 S2 的
    // 後門。動態查目前已用額度、精準補到頂,不寫死 A1 究竟消耗了幾則(對 A1
    // 之後的改動更不脆弱)。----
    const budgetBefore = await client.rpc("message.getContextBudget", { contextId: expectedContextId });
    const remaining = MAX - budgetBefore.count;
    for (let i = 0; i < remaining; i++) {
      await client.rpc("message.sendMessage", { teamId, fromMemberId: member.id, to: "Target", content: `fill-${i}` });
    }

    let overLimitRejected = false;
    let overLimitErr = "";
    try {
      await client.rpc("message.sendMessage", { teamId, fromMemberId: member.id, to: "Target", content: "over-limit" });
    } catch (err) {
      overLimitRejected = true;
      overLimitErr = String(err);
    }
    const overLimitErrClear = overLimitErr.includes("額度已用盡") && overLimitErr.includes(`${MAX}/${MAX}`);

    // otherMember 的桶完全獨立,只送過 1 則(離 MAX 還遠),不受 member 觸發
    // trip 的牽連,應該仍能正常送出。
    let otherStillOk = false;
    try {
      await client.rpc("message.sendMessage", { teamId, fromMemberId: otherMember.id, to: "Target", content: "still fine" });
      otherStillOk = true;
    } catch {
      otherStillOk = false;
    }

    record(
      "A2: 無任務的 per-member contextId 依然受既有訊息數上限管制(不是繞過 S2 的無限暢聊後門)——補到上限後 send_message 明確拒收;其他成員各自獨立的桶不受牽連",
      overLimitRejected && overLimitErrClear && otherStillOk,
      `budgetBefore=${JSON.stringify(budgetBefore)}, overLimitRejected=${overLimitRejected}(${overLimitErr}), otherStillOk=${otherStillOk}`,
    );
  } catch (err) {
    record("A 執行過程發生未預期錯誤", false, String(err));
  } finally {
    client?.close();
    await killProcessTree(coreProc);
  }

  rmTaskWorktrees(repoDir); // 見該函式註解:worktree 不在 repoDir 底下
  for (const dir of [dataDir, homeDir, repoDir]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

// =======================================================================
// B: contextId 完全由 Core 依綁定任務推導——wire 上多塞的 contextId 無效;
//    換了綁定的任務,下一則訊息的 contextId 自動跟著換,agent 沒有任何方式
//    指定或重置它。
// =======================================================================
async function testContextCannotBeSpoofed() {
  const gitVersion = runGitSync(["--version"], process.cwd());
  if (gitVersion.status !== 0) {
    record("B(git 不可用,整個步驟略過)", false, `找不到可用的 git 執行檔: ${gitVersion.error ?? gitVersion.stderr}`);
    return;
  }

  const PORT = 4371;
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-msgbudget-b-data-"));
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-msgbudget-b-home-"));
  const repoDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-msgbudget-b-repo-"));

  let coreProc;
  let client;
  try {
    initGitRepo(repoDir);
    coreProc = startCore({ port: PORT, dataDir, homeDir, workspaceDir: repoDir });
    await waitForPort(`ws://127.0.0.1:${PORT}`, 20_000);
    client = new MiniGatewayClient(`ws://127.0.0.1:${PORT}`);
    await client.connect();

    const team = await client.rpc("team.create", { name: "E2E MsgBudget B Team", workingDir: repoDir });
    const teamId = team.team.id;
    const profile = await createAcpProfile(client, repoDir, "E2E MsgBudget B Profile");
    // S8(agent-lifecycle):role="Coder" 預設推導為 lifecycle="ephemeral"
    // (見 packages/shared/src/team.ts 的 deriveLifecycleFromRole()),而 S8 對
    // ephemeral member 新增了「一 member 一 session」的指派時檢查——這個測試
    // 的目的(驗證 contextId 隨「目前綁定的任務」自動切換,§2「多於一個 →
    // 取 updatedAt 最新者」)需要**同一個 member 同時掛兩個任務**,這與 S8
    // 的 ephemeral 約束互斥,但與 lifecycle 本身無關(S8 只對 ephemeral 做
    // 這個檢查,見 agent-lifecycle_detail.md §2.1「persistent:不做任何事」)
    // ——明確指定 lifecycle="persistent",讓這個 member 略過該檢查,恢復這個
    // 測試原本要驗證的行為,不需要改動 S8 的約束本身。
    const { member: coder } = await client.rpc("team.addMember", {
      teamId,
      agentProfileId: profile.id,
      name: "Coder",
      role: "Coder",
      canInterrupt: false,
      lifecycle: "persistent",
    });
    await client.rpc("team.addMember", {
      teamId,
      agentProfileId: profile.id,
      name: "Target",
      role: "Coder",
      canInterrupt: false,
    });

    const task1 = await client.rpc("task.create", { teamId, title: "Task 1" });
    await client.rpc("task.assign", { taskId: task1.task.id, memberId: coder.id });

    // ---- B1: 即使 wire 上夾帶一個 gateway schema 沒有定義的 contextId 欄位,
    // 持久化的訊息 contextId 仍然是 Core 依真正綁定任務推導出來的值,不是
    // 呼叫端塞的那個假值。MCP 工具簽章本來就沒有這個參數,這裡額外驗證即使
    // 有辦法把多餘欄位塞進 wire 層的 JSON-RPC 請求,也完全不會被
    // `MessageBus.sendMessage()` 採用(它的 TS 簽章與實作根本不會讀取這個
    // 欄位)。 ----
    const send1 = await client.rpc("message.sendMessage", {
      teamId,
      fromMemberId: coder.id,
      to: "Target",
      content: "msg-1",
      contextId: "EVIL_SPOOFED_CONTEXT", // 不在 gateway schema 定義內
    });
    const contextId1Correct = send1.message.contextId === task1.task.id && send1.message.contextId !== "EVIL_SPOOFED_CONTEXT";

    // ---- B2: 換了綁定的任務(指派第二個任務給同一個 member,狀態機保證取
    // updatedAt 最新者),下一則訊息的 contextId 自動跟著換 —— 不需要、也
    // 無法由呼叫端指定。 ----
    const task2 = await client.rpc("task.create", { teamId, title: "Task 2" });
    await client.rpc("task.assign", { taskId: task2.task.id, memberId: coder.id });

    const send2 = await client.rpc("message.sendMessage", { teamId, fromMemberId: coder.id, to: "Target", content: "msg-2" });
    const contextId2Correct = send2.message.contextId === task2.task.id && send2.message.contextId !== task1.task.id;

    record(
      "B: contextId 完全由 Core 依當下綁定任務推導——wire 上多塞的 contextId 被忽略;改指派新任務後,下一則訊息自動換成新 contextId,agent 無法指定或重置",
      contextId1Correct && contextId2Correct,
      `send1.contextId=${send1.message.contextId}(應=${task1.task.id}), send2.contextId=${send2.message.contextId}(應=${task2.task.id})`,
    );
  } catch (err) {
    record("B 執行過程發生未預期錯誤", false, String(err));
  } finally {
    client?.close();
    await killProcessTree(coreProc);
  }

  rmTaskWorktrees(repoDir); // 見該函式註解:worktree 不在 repoDir 底下
  for (const dir of [dataDir, homeDir, repoDir]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

// =======================================================================
// C: 超過上限 → trip + 拒收,但 report_status 仍可用、session 未 halt。
// =======================================================================
async function testBudgetTripKeepsWorking() {
  const gitVersion = runGitSync(["--version"], process.cwd());
  if (gitVersion.status !== 0) {
    record("C(git 不可用,整個步驟略過)", false, `找不到可用的 git 執行檔: ${gitVersion.error ?? gitVersion.stderr}`);
    return;
  }

  const PORT = 4372;
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-msgbudget-c-data-"));
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-msgbudget-c-home-"));
  const repoDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-msgbudget-c-repo-"));
  const configPath = path.join(homeDir, "config.json");
  const MAX = 3;
  writeConfigWithMessageBudget(configPath, MAX);

  let coreProc;
  let client;
  try {
    initGitRepo(repoDir);
    coreProc = startCore({ port: PORT, dataDir, homeDir, workspaceDir: repoDir });
    await waitForPort(`ws://127.0.0.1:${PORT}`, 20_000);
    client = new MiniGatewayClient(`ws://127.0.0.1:${PORT}`);
    await client.connect();

    const team = await client.rpc("team.create", { name: "E2E MsgBudget C Team", workingDir: repoDir });
    const teamId = team.team.id;
    const profile = await createAcpProfile(client, repoDir, "E2E MsgBudget C Profile");
    const { member: coder } = await client.rpc("team.addMember", {
      teamId,
      agentProfileId: profile.id,
      name: "Coder",
      role: "Coder",
      canInterrupt: false,
    });
    await client.rpc("team.addMember", {
      teamId,
      agentProfileId: profile.id,
      name: "Target",
      role: "Coder",
      canInterrupt: false,
    });

    const task = await client.rpc("task.create", { teamId, title: "Task budget" });
    await client.rpc("task.assign", { taskId: task.task.id, memberId: coder.id });

    // 先送滿 MAX 則(3則)——第 3 則送出後應該觸發 trip(checkThresholdAfterPersist
    // 在「已經越線」的那一則之後才觸發,見 message-bus.ts)。
    for (let i = 0; i < MAX; i++) {
      await client.rpc("message.sendMessage", { teamId, fromMemberId: coder.id, to: "Target", content: `msg-${i}` });
    }

    const notification = await client
      .waitForEnforcementNotification((n) => n.kind === "trip" && n.tripReason === "message-budget", 5_000)
      .catch(() => undefined);
    const tripNotified = Boolean(notification);

    // 第 4 則(已越線)應被拒收,錯誤訊息需明確可理解。
    let rejected = false;
    let rejectErr = "";
    try {
      await client.rpc("message.sendMessage", { teamId, fromMemberId: coder.id, to: "Target", content: "msg-over-limit" });
    } catch (err) {
      rejected = true;
      rejectErr = String(err);
    }
    const rejectErrClear = rejectErr.includes("額度已用盡") && rejectErr.includes(`${MAX}/${MAX}`);

    // report_status 仍可用,不受訊息預算影響。
    let reportStatusOk = false;
    try {
      const { message } = await client.rpc("message.reportStatus", {
        teamId,
        fromMemberId: coder.id,
        status: "in-progress",
        summary: "still going despite message budget trip",
      });
      reportStatusOk = Boolean(message);
    } catch {
      reportStatusOk = false;
    }

    // session 未 halt:建一個真正的 session,trip 後仍能正常送 prompt 並完成
    // 回合(不是被擋、也沒有被 interrupt)。
    const { session } = await client.rpc(
      "session.create",
      { agentProfileId: profile.id, workingDir: repoDir, title: "C-not-halted", teamMemberId: coder.id },
      30_000,
    );
    const marker = delayEchoMarker(0);
    const promptContent = `still-working-${randomUUID()} ${marker}`;
    await client.rpc("session.sendPrompt", { sessionId: session.id, prompt: { text: promptContent } });
    const echoEvent = await waitForMessageContaining(client, session.id, promptContent, 15_000).catch(() => undefined);
    const sessionNotHalted = Boolean(echoEvent);
    const sessionStatusAfter = (await client.rpc("session.list", {})).sessions.find((s) => s.id === session.id)?.status;

    // 拒收本身不計入預算:再拒收幾次後,context 的 agent 訊息數應該仍停在 MAX
    // (不是 MAX+N)。
    for (let i = 0; i < 3; i++) {
      try {
        await client.rpc("message.sendMessage", { teamId, fromMemberId: coder.id, to: "Target", content: `retry-${i}` });
      } catch {
        // 預期拒收
      }
    }
    const budgetStatus = await client.rpc("message.getContextBudget", { contextId: task.task.id });
    const rejectionsNotCounted = budgetStatus.count === MAX && budgetStatus.tripped === true;

    record(
      "C: context 訊息數達上限(3)→ trip + 通知(reason=message-budget),越線後 send_message 明確拒收(訊息含『額度已用盡 3/3』);report_status 不受影響、可正常建立新 session 並完成回合(未被 halt);拒收本身不計入預算(重試 3 次後 count 仍是 3)",
      tripNotified && rejected && rejectErrClear && reportStatusOk && sessionNotHalted && rejectionsNotCounted,
      `tripNotified=${tripNotified}, rejected=${rejected}, rejectErr=${rejectErr}, reportStatusOk=${reportStatusOk}, ` +
        `sessionNotHalted=${sessionNotHalted}, sessionStatusAfter=${sessionStatusAfter}, budgetStatus=${JSON.stringify(budgetStatus)}`,
    );
  } catch (err) {
    record("C 執行過程發生未預期錯誤", false, String(err));
  } finally {
    client?.close();
    await killProcessTree(coreProc);
  }

  rmTaskWorktrees(repoDir); // 見該函式註解:worktree 不在 repoDir 底下
  for (const dir of [dataDir, homeDir, repoDir]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

// =======================================================================
// D: broadcast 展開成 N 筆,放大消耗額度(agent 端 broadcast()）。
// =======================================================================
async function testBroadcastAmplifiesBudget() {
  const gitVersion = runGitSync(["--version"], process.cwd());
  if (gitVersion.status !== 0) {
    record("D(git 不可用,整個步驟略過)", false, `找不到可用的 git 執行檔: ${gitVersion.error ?? gitVersion.stderr}`);
    return;
  }

  const PORT = 4373;
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-msgbudget-d-data-"));
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-msgbudget-d-home-"));
  const repoDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-msgbudget-d-repo-"));
  const configPath = path.join(homeDir, "config.json");
  const MAX = 5;
  writeConfigWithMessageBudget(configPath, MAX);

  let coreProc;
  let client;
  try {
    initGitRepo(repoDir);
    coreProc = startCore({ port: PORT, dataDir, homeDir, workspaceDir: repoDir });
    await waitForPort(`ws://127.0.0.1:${PORT}`, 20_000);
    client = new MiniGatewayClient(`ws://127.0.0.1:${PORT}`);
    await client.connect();

    const team = await client.rpc("team.create", { name: "E2E MsgBudget D Team", workingDir: repoDir });
    const teamId = team.team.id;
    const profile = await createAcpProfile(client, repoDir, "E2E MsgBudget D Profile");
    const { member: coder } = await client.rpc("team.addMember", {
      teamId,
      agentProfileId: profile.id,
      name: "Coder",
      role: "Coder",
      canInterrupt: false,
    });
    // 兩個收件者(broadcast 對象),沒有 session 也沒關係(no-session 一樣算
    // 一筆訊息、一樣計入預算,見 L4 §5.1)。
    await client.rpc("team.addMember", { teamId, agentProfileId: profile.id, name: "R1", role: "Coder", canInterrupt: false });
    await client.rpc("team.addMember", { teamId, agentProfileId: profile.id, name: "R2", role: "Coder", canInterrupt: false });

    const task = await client.rpc("task.create", { teamId, title: "Task broadcast" });
    await client.rpc("task.assign", { taskId: task.task.id, memberId: coder.id });

    // 第一次 broadcast:2 個收件者 → 2 筆,count=2(< MAX=5),不觸發 trip。
    await client.rpc("message.broadcast", { teamId, fromMemberId: coder.id, content: "broadcast-1" });
    const historyAfterFirst = await client.rpc("team.messages", { teamId });
    const firstBroadcastRows = historyAfterFirst.messages.filter((m) => m.content === "broadcast-1");
    const firstExpandedCorrectly =
      firstBroadcastRows.length === 2 && new Set(firstBroadcastRows.map((m) => m.to)).size === 2 &&
      firstBroadcastRows.every((m) => m.contextId === task.task.id);

    const statusAfterFirst = await client.rpc("message.getContextBudget", { contextId: task.task.id });

    // 第二次 broadcast:再 2 筆 → count=4(仍 < 5)。
    await client.rpc("message.broadcast", { teamId, fromMemberId: coder.id, content: "broadcast-2" });
    // 第三次:單一 sendMessage 補一則 → count=5,達到 MAX,觸發 trip。
    await client.rpc("message.sendMessage", { teamId, fromMemberId: coder.id, to: "R1", content: "final-to-trip" });

    const notification = await client
      .waitForEnforcementNotification((n) => n.kind === "trip" && n.tripReason === "message-budget", 5_000)
      .catch(() => undefined);
    const tripNotified = Boolean(notification);

    const statusAfterTrip = await client.rpc("message.getContextBudget", { contextId: task.task.id });

    record(
      "D: agent broadcast() 展開成 N 筆(每個收件者各自一筆,contextId 一致)、天然放大消耗 context 訊息額度——兩次 2 人 broadcast + 一則單訊息剛好把 5 則上限用完並觸發 trip",
      firstExpandedCorrectly && statusAfterFirst.count === 2 && tripNotified && statusAfterTrip.count === MAX && statusAfterTrip.tripped,
      `firstExpandedCorrectly=${firstExpandedCorrectly}, statusAfterFirst=${JSON.stringify(statusAfterFirst)}, ` +
        `tripNotified=${tripNotified}, statusAfterTrip=${JSON.stringify(statusAfterTrip)}`,
    );
  } catch (err) {
    record("D 執行過程發生未預期錯誤", false, String(err));
  } finally {
    client?.close();
    await killProcessTree(coreProc);
  }

  rmTaskWorktrees(repoDir); // 見該函式註解:worktree 不在 repoDir 底下
  for (const dir of [dataDir, homeDir, repoDir]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

// =======================================================================
// E: 人類插話 broadcast 也展開成 N 筆,且全部送達(這條路徑這輪整個換掉,
//    原本完全沒有 e2e 覆蓋)。人類插話不計入訊息預算(source="human")。
// =======================================================================
async function testHumanBroadcastExpansion() {
  const PORT = 4374;
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-msgbudget-e-data-"));
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-msgbudget-e-home-"));
  const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-msgbudget-e-ws-"));

  let coreProc;
  let client;
  try {
    coreProc = startCore({ port: PORT, dataDir, homeDir, workspaceDir });
    await waitForPort(`ws://127.0.0.1:${PORT}`, 20_000);
    client = new MiniGatewayClient(`ws://127.0.0.1:${PORT}`);
    await client.connect();

    const team = await client.rpc("team.create", { name: "E2E MsgBudget E Team" });
    const teamId = team.team.id;
    const profile = await createAcpProfile(client, workspaceDir, "E2E MsgBudget E Profile");
    const { member: m1 } = await client.rpc("team.addMember", { teamId, agentProfileId: profile.id, name: "M1", role: "Coder", canInterrupt: false });
    const { member: m2 } = await client.rpc("team.addMember", { teamId, agentProfileId: profile.id, name: "M2", role: "Coder", canInterrupt: false });

    const { session: s1 } = await client.rpc(
      "session.create",
      { agentProfileId: profile.id, workingDir: workspaceDir, title: "E-m1", teamMemberId: m1.id },
      30_000,
    );
    const { session: s2 } = await client.rpc(
      "session.create",
      { agentProfileId: profile.id, workingDir: workspaceDir, title: "E-m2", teamMemberId: m2.id },
      30_000,
    );

    const marker = delayEchoMarker(0);
    const content = `human-broadcast-${randomUUID()} ${marker}`;
    const sendResult = await client.rpc("message.send", { teamId, to: "broadcast", content, fromName: "Human" });

    const echo1 = await waitForMessageContaining(client, s1.id, content, 15_000);
    const echo2 = await waitForMessageContaining(client, s2.id, content, 15_000);

    const history = await client.rpc("team.messages", { teamId });
    const rows = history.messages.filter((m) => m.content === content);
    const expandedCorrectly =
      rows.length === 2 &&
      rows.every((m) => m.source === "human" && m.contextId === "legacy") &&
      new Set(rows.map((m) => m.to)).size === 2;
    const notCountedInBudget = expandedCorrectly; // source="human",contextId="legacy",不會被任何 context 預算計入。

    record(
      "E: 人類插話 broadcast(message.send, to='broadcast')展開成 N 筆(每個收件者各自一筆),兩個收件者都真的收到注入的 prompt,且這些訊息不參與訊息預算(source=human, contextId=legacy)",
      Boolean(echo1) && Boolean(echo2) && expandedCorrectly && sendResult.message && notCountedInBudget,
      `rows=${JSON.stringify(rows.map((r) => ({ to: r.to, source: r.source, contextId: r.contextId })))}`,
    );
  } catch (err) {
    record("E 執行過程發生未預期錯誤", false, String(err));
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
// F: 遷移——pre-S2 schema 的舊資料一律標記為已送達,不會一次全灌給 agent。
// =======================================================================
async function testMigrationBackfill() {
  const PORT = 4375;
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-msgbudget-f-data-"));
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-msgbudget-f-home-"));
  const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-msgbudget-f-ws-"));

  let coreProc;
  let client;
  const legacyTeamId = randomUUID();
  const legacyMemberName = "LegacyReceiver";
  const legacyMessageIds = [];

  try {
    // ---- 手動用 pre-S2 schema(沒有 delivered_at/context_id 欄位)建立
    // team_messages 表並塞入舊資料,模擬「升級前就存在的 DB 檔案」。用
    // createRequire 從 packages/db 的 node_modules 解析 better-sqlite3
    // (根目錄本身沒有直接依賴這個套件,見 packages/db/package.json)。
    const require = createRequire(path.join(REPO_ROOT, "packages", "db", "package.json"));
    const Database = require("better-sqlite3");
    if (!existsSync(dataDir)) {
      // mkdtempSync 已經建立,這裡防禦性檢查。
    }
    const dbPath = path.join(dataDir, "deskmony.db");
    const rawDb = new Database(dbPath);
    rawDb.exec(`
      CREATE TABLE team_messages (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        from_name TEXT NOT NULL,
        from_role TEXT,
        to_target TEXT NOT NULL,
        content TEXT NOT NULL,
        priority TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        source TEXT NOT NULL,
        note TEXT
      );
    `);
    const insert = rawDb.prepare(
      "INSERT INTO team_messages (id, team_id, from_name, from_role, to_target, content, priority, timestamp, source, note) " +
        "VALUES (?, ?, ?, ?, ?, ?, 'normal', ?, 'agent', NULL)",
    );
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      const id = randomUUID();
      legacyMessageIds.push(id);
      insert.run(id, legacyTeamId, "OldSender", "Coder", legacyMemberName, `legacy-message-${i}`, now - (5 - i) * 1000);
    }
    rawDb.close();

    // ---- 啟動 core,期待 `ensureTeamMessagesBudgetColumns()` 補欄位並回填 ----
    coreProc = startCore({ port: PORT, dataDir, homeDir, workspaceDir });
    await waitForPort(`ws://127.0.0.1:${PORT}`, 20_000);
    client = new MiniGatewayClient(`ws://127.0.0.1:${PORT}`);
    await client.connect();

    const history = await client.rpc("team.messages", { teamId: legacyTeamId });
    const legacyRows = history.messages.filter((m) => legacyMessageIds.includes(m.id));
    const allBackfilled =
      legacyRows.length === 5 &&
      legacyRows.every((m) => typeof m.deliveredAt === "number" && m.deliveredAt > 0 && m.contextId === "legacy");

    // ---- 建立一個真正名為 "LegacyReceiver" 的 team member + session,確認
    // 這些已經標記為已送達的舊訊息**不會**被一次灌進新 session(它們的
    // delivered_at 已經非 NULL,DB 驅動的 Mailbox 查詢天生就不會撈到它們)。
    const team2 = await client.rpc("team.create", { name: "E2E MsgBudget F Team 2" });
    const profile = await createAcpProfile(client, workspaceDir, "E2E MsgBudget F Profile");
    const { member } = await client.rpc("team.addMember", {
      teamId: team2.team.id,
      agentProfileId: profile.id,
      name: legacyMemberName,
      role: "Coder",
      canInterrupt: false,
    });
    const startIdx = client.events.length;
    const { session } = await client.rpc(
      "session.create",
      { agentProfileId: profile.id, workingDir: workspaceDir, title: "F-legacy-receiver", teamMemberId: member.id },
      30_000,
    );
    // 給 flushMailbox 一點時間(即使真的誤觸發也會在這個視窗內看到);由於這
    // 個新 team 的 teamId 與 legacyTeamId 不同,即使 delivered_at 沒有被正確
    // 回填,`getPendingMailboxMessages()` 現在也已經同時比對 teamId(見
    // message-bus.ts),理論上也不會被撈到——這裡主要驗證「舊資料已標記為
    // 已送達」本身(上面 allBackfilled),這一段是額外的行為保險。
    await sleep(1_500);
    const injectedLegacyContent = client.events
      .slice(startIdx)
      .some((e) => e.sessionId === session.id && e.event.type === "message-delta" && typeof e.event.delta === "string" && e.event.delta.includes("legacy-message-"));

    record(
      "F: pre-S2 schema 的舊 team_messages 資料升級後一律標記為已送達(delivered_at 非 NULL、context_id='legacy'),且不會被當成待投遞訊息灌給任何新建立的 session(no message-storm)",
      allBackfilled && !injectedLegacyContent,
      `legacyRows=${JSON.stringify(legacyRows.map((r) => ({ id: r.id, deliveredAt: r.deliveredAt, contextId: r.contextId })))}, injectedLegacyContent=${injectedLegacyContent}`,
    );
  } catch (err) {
    record("F 執行過程發生未預期錯誤", false, String(err));
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
// G: 崩潰重啟後未送達訊息仍被投遞(delivered_at IS NULL 存活),且不重複投遞。
// =======================================================================
async function testCrashRecoveryMailbox() {
  const PORT = 4376;
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-msgbudget-g-data-"));
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-msgbudget-g-home-"));
  const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-msgbudget-g-ws-"));

  let coreProc1;
  let coreProc2;
  let coreProc3;
  let client;
  const marker = delayEchoMarker(0);
  const content = `crash-recovery-${randomUUID()} ${marker}`;

  try {
    // ---- 生命週期一:sender 綁定任務、送一則訊息給「目前沒有 session」的
    // Receiver → 訊息 persist、delivered_at 應為 NULL(留在 DB 驅動的
    // Mailbox 中)。 ----
    coreProc1 = startCore({ port: PORT, dataDir, homeDir, workspaceDir });
    await waitForPort(`ws://127.0.0.1:${PORT}`, 20_000);
    client = new MiniGatewayClient(`ws://127.0.0.1:${PORT}`);
    await client.connect();

    const gitVersion = runGitSync(["--version"], process.cwd());
    if (gitVersion.status !== 0) {
      record("G(git 不可用,整個步驟略過)", false, `找不到可用的 git 執行檔: ${gitVersion.error ?? gitVersion.stderr}`);
      return;
    }
    const repoDir = path.join(workspaceDir, "repo");
    mkdirSync(repoDir, { recursive: true });
    initGitRepo(repoDir);

    const team = await client.rpc("team.create", { name: "E2E MsgBudget G Team", workingDir: repoDir });
    const teamId = team.team.id;
    const profile = await createAcpProfile(client, repoDir, "E2E MsgBudget G Profile");
    const { member: sender } = await client.rpc("team.addMember", {
      teamId,
      agentProfileId: profile.id,
      name: "Sender",
      role: "Coder",
      canInterrupt: false,
    });
    const { member: receiver } = await client.rpc("team.addMember", {
      teamId,
      agentProfileId: profile.id,
      name: "Receiver",
      role: "Coder",
      canInterrupt: false,
    });
    const task = await client.rpc("task.create", { teamId, title: "G task" });
    await client.rpc("task.assign", { taskId: task.task.id, memberId: sender.id });

    const sendResult = await client.rpc("message.sendMessage", { teamId, fromMemberId: sender.id, to: "Receiver", content });
    const messageId = sendResult.message.id;
    const initiallyPending = sendResult.delivered === "no-session" && !sendResult.message.deliveredAt;

    const beforeCrash = await client.rpc("team.messages", { teamId });
    const rowBeforeCrash = beforeCrash.messages.find((m) => m.id === messageId);
    const stillPendingBeforeCrash = Boolean(rowBeforeCrash) && !rowBeforeCrash.deliveredAt;

    client.close();
    await killProcessTree(coreProc1); // 模擬崩潰(直接砍行程,不走優雅關閉)。

    // ---- 生命週期二:重啟(同一份 dataDir/homeDir),確認訊息還在、依然
    // 標記為未送達(不遺失、遷移不會誤標)。建立 Receiver 的 session,觸發
    // "member-session-ready" 補投,確認訊息真的被注入。 ----
    coreProc2 = startCore({ port: PORT, dataDir, homeDir, workspaceDir });
    await waitForPort(`ws://127.0.0.1:${PORT}`, 20_000);
    client = new MiniGatewayClient(`ws://127.0.0.1:${PORT}`);
    await client.connect();

    const afterRestart = await client.rpc("team.messages", { teamId });
    const rowAfterRestart = afterRestart.messages.find((m) => m.id === messageId);
    const notLostAfterRestart = Boolean(rowAfterRestart) && !rowAfterRestart.deliveredAt;

    const { session } = await client.rpc(
      "session.create",
      { agentProfileId: profile.id, workingDir: repoDir, title: "G-receiver", teamMemberId: receiver.id },
      30_000,
    );
    const echoEvent = await waitForMessageContaining(client, session.id, content, 15_000).catch(() => undefined);
    const redeliveredAfterRestart = Boolean(echoEvent);

    await sleep(500);
    const afterDelivery = await client.rpc("team.messages", { teamId });
    const rowAfterDelivery = afterDelivery.messages.find((m) => m.id === messageId);
    const markedDeliveredAfterInjection = Boolean(rowAfterDelivery?.deliveredAt);

    // 不重複投遞(這次生命週期內):同一個 sessionId 上,含這則訊息內容的
    // message-delta 事件應該恰好出現一次。
    const occurrencesThisLifetime = client.events.filter(
      (e) => e.sessionId === session.id && e.event.type === "message-delta" && typeof e.event.delta === "string" && e.event.delta.includes(content),
    ).length;
    const deliveredExactlyOnceThisLifetime = occurrencesThisLifetime === 1;

    client.close();
    await killProcessTree(coreProc2);

    // ---- 生命週期三:再次重啟,確認已標記送達的訊息不會被重複投遞(這裡
    // session 已刪除、Receiver 沒有活躍 session,重啟本身不該對這則訊息做
    // 任何事——它已經 delivered_at 非 NULL,DB 驅動的 Mailbox 查詢天生就不
    // 會再撈到它)。 ----
    coreProc3 = startCore({ port: PORT, dataDir, homeDir, workspaceDir });
    await waitForPort(`ws://127.0.0.1:${PORT}`, 20_000);
    client = new MiniGatewayClient(`ws://127.0.0.1:${PORT}`);
    await client.connect();
    const afterSecondRestart = await client.rpc("team.messages", { teamId });
    const rowAfterSecondRestart = afterSecondRestart.messages.find((m) => m.id === messageId);
    const stillExactlyOneRowAfterSecondRestart =
      afterSecondRestart.messages.filter((m) => m.id === messageId).length === 1 && Boolean(rowAfterSecondRestart?.deliveredAt);

    record(
      "G: 崩潰(直接砍行程)後重啟,`delivered_at IS NULL` 的訊息自然存活(不遺失)、建立目標 session 後被自動補投(注入內容確實送達,且同一次生命週期內恰好投遞一次,未重複);訊息被標記已送達後,再次重啟不會被誤判成待投遞而重新灌入(仍然只有一筆紀錄)",
      initiallyPending &&
        stillPendingBeforeCrash &&
        notLostAfterRestart &&
        redeliveredAfterRestart &&
        markedDeliveredAfterInjection &&
        deliveredExactlyOnceThisLifetime &&
        stillExactlyOneRowAfterSecondRestart,
      `initiallyPending=${initiallyPending}, stillPendingBeforeCrash=${stillPendingBeforeCrash}, notLostAfterRestart=${notLostAfterRestart}, ` +
        `redeliveredAfterRestart=${redeliveredAfterRestart}, markedDeliveredAfterInjection=${markedDeliveredAfterInjection}, ` +
        `occurrencesThisLifetime=${occurrencesThisLifetime}, stillExactlyOneRowAfterSecondRestart=${stillExactlyOneRowAfterSecondRestart}`,
    );
  } catch (err) {
    record("G 執行過程發生未預期錯誤", false, String(err));
  } finally {
    client?.close();
    await killProcessTree(coreProc1);
    await killProcessTree(coreProc2);
    await killProcessTree(coreProc3);
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

  console.log("=== S2 e2e:A(未綁任務 → per-member 獨立 contextId,不再拒收)===");
  await testNoTaskOwnBudget();

  console.log("\n=== S2 e2e:B(contextId 無法偽造/由 Core 推導)===");
  await testContextCannotBeSpoofed();

  console.log("\n=== S2 e2e:C(超過上限 → trip + 拒收,但工作/report_status 不受影響)===");
  await testBudgetTripKeepsWorking();

  console.log("\n=== S2 e2e:D(agent broadcast 展開成 N 筆,放大消耗額度)===");
  await testBroadcastAmplifiesBudget();

  console.log("\n=== S2 e2e:E(人類插話 broadcast 展開成 N 筆,不計入預算)===");
  await testHumanBroadcastExpansion();

  console.log("\n=== S2 e2e:F(遷移:舊資料標為已送達,不會一次全灌)===");
  await testMigrationBackfill();

  console.log("\n=== S2 e2e:G(崩潰重啟後未送達訊息仍被投遞,且不重複投遞)===");
  await testCrashRecoveryMailbox();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n\n========== 總結:${results.length - failed.length}/${results.length} 通過 ==========`);
  for (const r of failed) {
    console.log(`  FAIL: ${r.name}`);
  }
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[e2e-message-budget] fatal:", err);
  process.exit(1);
});
