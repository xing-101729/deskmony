#!/usr/bin/env node
/**
 * scripts/e2e-cost-governor.mjs
 *
 * S3b(CostGovernor / 成本治理,第三條斷路器)端到端驗證,對應
 * docs/LAYER-4-detail-design/cost-governor_detail.md §7 檢查清單最後一項。
 *
 * 沿用 scripts/e2e-policy-engine.mjs / scripts/e2e-auto-mode-yolo.mjs 的手法
 * (真實 WS Gateway + fake ACP agent,決定性、不依賴真實模型行為),獨立可
 * 執行,不 import 其他 e2e 腳本。
 *
 * ⚠️ §0 的核心結論:Claude Code 經 ACP 完全拿不到用量資料,回合硬上限是這類
 * 後端**唯一**的保護。這份 e2e 刻意全程用 ACP 假 agent(`software: "acp"`)
 * 測試,不是疏漏——這正是在驗證「一個從頭到尾不回報任何 usage/cost 的後端,
 * 依然被回合硬上限保護」這個最重要的宣稱(見測試 A 最後的「不報 usage 的
 * 後端只有回合上限生效」斷言)。任務預算/每日 kill-switch 兩項則利用假 agent
 * 既有的 `ACP_USAGE_UPDATE` 指令(S3a e2e 已有的機制)決定性地灌入假造的
 * `cost`,不需要真實模型/API 金鑰。
 *
 * 涵蓋(§7 檢查清單「e2e」項目逐一對應):
 *   A. 回合硬上限:工具呼叫次數超標 → 立即 interrupt(§0.1 優先項目)
 *   B. 回合硬上限:時間超標 → 立即 interrupt
 *   C. 任務預算超標 → 擋後續 prompt,不打斷已結束的回合
 *   D. 每日 kill-switch → 全部 session interrupt,且擋後續 prompt
 *   E. T1 防遺忘(waiting 超過短版 T1)→ 只發通知,不 halt
 *   F. T2 資源回收(waiting 超過短版 T2)→ 真 trip,dispose 子程序(session 狀態
 *      變成 error,DB 記錄保留)
 *   G(附掛在 A 之後):不報 usage 的後端只有回合上限生效——`cost.getSummary`
 *      顯示這個 session 從未有過任何 cost/token 累計,但仍然被回合上限攔下。
 *
 * 前置需求:`pnpm build` 已跑過。
 * 用法:node scripts/e2e-cost-governor.mjs
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { WRITE_FILE_PREFIX, USAGE_UPDATE_PREFIX, MANY_TOOL_CALLS_PREFIX, SLEEP_TURN_PREFIX } from "./fake-acp-agent.mjs";

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
    this.permissionResolvedEvents = [];
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
      } else if (msg.channel === "permission-resolved") {
        this.permissionResolvedEvents.push(msg.payload);
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

/** 寫一份帶 `budget` 區塊的 config.json——`budget` 只能靠設定檔覆寫(F4,遠端
 *  不可改,見 packages/shared/src/core-config.ts 的 `ConfigSetFilePatchSchema`
 *  刻意不含 `budget` 的說明),沒有對應的環境變數,只能在啟動前寫好這個檔案。 */
/**
 * 清掉這個測試自己建立的任務 worktree。
 *
 * task.assign 建立的 worktree **不在** repoDir 底下,而是
 * `<repoDir 的上層>/.deskmony-worktrees/<repoDir 名稱>-task-<8 碼>`(見
 * apps/core/src/workspace/workspace-manager.ts 的 `createWorkspaceForTask()`),
 * 所以收尾的 `rmSync([dataDir, homeDir, repoDir])` 掃不到它們,每跑一次就在
 * 系統暫存目錄留下殘留。這個測試收尾時已經先 kill 掉 core,gateway 不在了,
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

function writeConfigWithBudget(configPath, budget) {
  // `warnAtPercent` 是 `BudgetConfigSchema` 的必填欄位(沒有 `.default()`,見
  // packages/shared/src/core-config.ts)——這裡統一補上預設值 80,呼叫端只需要
  // 指定這次測試真正關心的欄位(task/daily/turn)。
  writeFileSync(configPath, JSON.stringify({ version: 1, budget: { warnAtPercent: 80, ...budget } }, null, 2), "utf8");
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
    { agentProfileId: profile.id, workingDir: workspaceDir, title, teamMemberId: extra.teamMemberId },
    30_000,
  );
  return { profileId: profile.id, sessionId: session.id };
}

// =======================================================================
// A + G:回合硬上限——工具呼叫次數超標 → 立即 interrupt;順便驗證「這個 session
// 從未回報過任何 usage/cost,仍然被回合上限攔下」(§0.1 最重要的宣稱)。
// =======================================================================
async function testTurnLimitToolCalls() {
  const PORT = 4360;
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-cost-a-data-"));
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-cost-a-home-"));
  const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-cost-a-ws-"));
  const configPath = path.join(homeDir, "config.json");
  // maxDurationMs 刻意設很大,確保這次測試只會撞到「工具呼叫次數」這個維度,
  // 不會被時間維度(測試 B)提前攔截而混淆歸因。
  writeConfigWithBudget(configPath, { turn: { maxToolCalls: 5, maxDurationMs: 600_000 } });

  let coreProc;
  let client;
  try {
    coreProc = startCore({ port: PORT, dataDir, homeDir, workspaceDir });
    await waitForPort(`ws://127.0.0.1:${PORT}`, 20_000);
    client = new MiniGatewayClient(`ws://127.0.0.1:${PORT}`);
    await client.connect();

    // 先確認這個後端(software="acp")的 usageReporting 三態的確不是
    // "supported"(見 packages/shared/src/adapter-capabilities.ts)——這是
    // 「不報 usage 的後端」這個前提本身要先站得住腳,不是憑空假設。
    const { capabilities } = await client.rpc("adapter.capabilities", { software: "acp" });
    const usageNotSupported = capabilities.usageReporting !== "supported";

    const { sessionId } = await createAcpSession(client, workspaceDir, "A-turn-limit-toolcalls");

    const startIdx = client.events.length;
    // 20 次工具呼叫(> maxToolCalls=5),每次間隔 150ms,給 core 端「第 6 次超標
    // → interrupt()」足夠時間在迴圈中途真的生效(見 fake-acp-agent.mjs 的
    // `handleManyToolCalls` 註解)。
    await client.rpc("session.sendPrompt", {
      sessionId,
      prompt: { text: `${MANY_TOOL_CALLS_PREFIX}${JSON.stringify({ count: 20, delayMs: 150 })}` },
    });

    // 回合結束(不論是自然結束或被 interrupt 提早結束,見 acp-adapter.ts:
    // cancelled 收場一樣推播 "completed")。
    await client.waitForEvent((e) => e.sessionId === sessionId && (e.event.type === "completed" || e.event.type === "error"), 15_000);
    await sleep(300);

    const toolCallCount = client.events.filter((e) => e.sessionId === sessionId && e.event.type === "tool-call").length;
    const stoppedEarly = toolCallCount < 20 && toolCallCount >= 5;

    const notification = await client
      .waitForEnforcementNotification(
        (n) => n.kind === "trip" && n.tripReason === "turn-limit" && n.sessionId === sessionId,
        5_000,
      )
      .catch(() => undefined);
    const tripNotified = Boolean(notification);

    record(
      "A: 回合硬上限——單一回合工具呼叫次數超標(5)→ 立即 interrupt,提早結束回合(實際只送出少於 20 次工具呼叫)且收到 trip 通知(reason=turn-limit)",
      usageNotSupported && stoppedEarly && tripNotified,
      `usageReporting=${capabilities.usageReporting}, toolCallCount=${toolCallCount}(應 <20 且 >=5), tripNotified=${tripNotified}`,
    );

    // ---- G:不報 usage 的後端只有回合上限生效 ----------------------------
    // 這個 session 從頭到尾沒有送過任何 usage_update/cost,`cost.getSummary`
    // 的 session rollup 應該完全是空的(costCurrency undefined、金額/token
    // 皆為 0)——但它依然被回合上限攔下(上面的 A 已證明)。兩者合在一起才是
    // 完整的宣稱:「這類後端『量不到』不代表『沒有保護』」。
    const summary = await client.rpc("cost.getSummary", { sessionId });
    const noUsageEverRecorded =
      summary.session.costCurrency === undefined && summary.session.costAmount === 0 && summary.session.inputTokens === 0;

    record(
      "G(不報 usage 的後端只有回合上限生效):這個 session 的 cost rollup 完全空白(從未回報過任何花費/token),但上面的 A 已證明它依然被回合硬上限攔下——證明「量不到 = 沒有 usage 保護,但回合上限仍生效」",
      noUsageEverRecorded,
      `session rollup=${JSON.stringify(summary.session)}`,
    );
  } catch (err) {
    record("A/G 執行過程發生未預期錯誤", false, String(err));
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
// B:回合硬上限——時間超標 → 立即 interrupt。
// =======================================================================
async function testTurnLimitDuration() {
  const PORT = 4361;
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-cost-b-data-"));
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-cost-b-home-"));
  const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-cost-b-ws-"));
  const configPath = path.join(homeDir, "config.json");
  // maxToolCalls 刻意設很大,確保只撞到時間維度。
  writeConfigWithBudget(configPath, { turn: { maxToolCalls: 100_000, maxDurationMs: 1_200 } });

  let coreProc;
  let client;
  try {
    coreProc = startCore({
      port: PORT,
      dataDir,
      homeDir,
      workspaceDir,
      // 定時檢查間隔縮短為 300ms(預設 10 秒太長,e2e 不可能真的等),見
      // apps/core/src/index.ts 的 `DESKMONY_TURN_LIMITER_CHECK_INTERVAL_MS`。
      extraEnv: { DESKMONY_TURN_LIMITER_CHECK_INTERVAL_MS: "300" },
    });
    await waitForPort(`ws://127.0.0.1:${PORT}`, 20_000);
    client = new MiniGatewayClient(`ws://127.0.0.1:${PORT}`);
    await client.connect();

    const { sessionId } = await createAcpSession(client, workspaceDir, "B-turn-limit-duration");

    const start = Date.now();
    // 睡 30 秒——若沒被中斷,遠超過測試逾時;maxDurationMs=1200ms + 檢查間隔
    // 300ms 應該在 ~1.5-2 秒內就被 interrupt。
    await client.rpc("session.sendPrompt", { sessionId, prompt: { text: `${SLEEP_TURN_PREFIX}${JSON.stringify({ ms: 30_000 })}` } });

    await client.waitForEvent((e) => e.sessionId === sessionId && (e.event.type === "completed" || e.event.type === "error"), 10_000);
    const elapsedMs = Date.now() - start;
    const stoppedEarly = elapsedMs < 10_000; // 遠早於 30 秒的睡眠時長

    const notification = await client
      .waitForEnforcementNotification(
        (n) => n.kind === "trip" && n.tripReason === "turn-limit" && n.sessionId === sessionId,
        5_000,
      )
      .catch(() => undefined);
    const tripNotified = Boolean(notification);

    record(
      "B: 回合硬上限——單一回合耗時超標(maxDurationMs=1200ms)→ 立即 interrupt,30 秒的睡眠回合提早結束(實際耗時遠短於 30 秒)且收到 trip 通知(reason=turn-limit)",
      stoppedEarly && tripNotified,
      `elapsedMs=${elapsedMs}(應遠小於 30000), tripNotified=${tripNotified}`,
    );
  } catch (err) {
    record("B 執行過程發生未預期錯誤", false, String(err));
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
// C:任務預算超標 → 擋後續 prompt,不打斷已結束的回合。
// =======================================================================
async function testTaskBudget() {
  const gitVersion = runGitSync(["--version"], process.cwd());
  if (gitVersion.status !== 0) {
    record("C: 任務預算(git 不可用,整個步驟略過)", false, `找不到可用的 git 執行檔: ${gitVersion.error ?? gitVersion.stderr}`);
    return;
  }

  const PORT = 4362;
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-cost-c-data-"));
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-cost-c-home-"));
  const repoDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-cost-c-repo-"));
  const configPath = path.join(homeDir, "config.json");
  writeConfigWithBudget(configPath, { task: { maxCostUsd: 1 }, turn: { maxToolCalls: 100_000, maxDurationMs: 600_000 } });

  let coreProc;
  let client;
  try {
    runGitSync(["init"], repoDir);
    runGitSync(["config", "user.email", "e2e@deskmony.local"], repoDir);
    runGitSync(["config", "user.name", "Deskmony E2E"], repoDir);
    writeFileSync(path.join(repoDir, "README.md"), "# e2e cost-governor task-budget repo\n", "utf8");
    runGitSync(["add", "."], repoDir);
    runGitSync(["commit", "-m", "initial commit"], repoDir);

    coreProc = startCore({ port: PORT, dataDir, homeDir, workspaceDir: repoDir });
    await waitForPort(`ws://127.0.0.1:${PORT}`, 20_000);
    client = new MiniGatewayClient(`ws://127.0.0.1:${PORT}`);
    await client.connect();

    const team = await client.rpc("team.create", { name: "E2E Cost Team", workingDir: repoDir });
    const { profile } = await client.rpc("profile.create", {
      name: "E2E Cost Member Profile",
      software: "acp",
      workingDir: repoDir,
      acpConfig: { command: process.execPath, args: [FAKE_AGENT_PATH] },
    });
    const { member } = await client.rpc("team.addMember", {
      teamId: team.team.id,
      agentProfileId: profile.id,
      name: "Coder",
      role: "Coder",
      canInterrupt: false,
    });
    const { task } = await client.rpc("task.create", { teamId: team.team.id, title: "E2E Cost Task" });
    await client.rpc("task.assign", { taskId: task.id, memberId: member.id });

    const { session } = await client.rpc(
      "session.create",
      { agentProfileId: profile.id, workingDir: repoDir, title: "C-task-budget", teamMemberId: member.id },
      30_000,
    );
    const sessionId = session.id;

    // 灌一筆假造的 cost(2.0 USD > maxCostUsd=1)——用既有的 ACP_USAGE_UPDATE
    // 指令(S3a e2e 既有機制),不需要真實模型/API 金鑰。
    const startIdx = client.events.length;
    await client.rpc("session.sendPrompt", {
      sessionId,
      prompt: { text: `${USAGE_UPDATE_PREFIX}${JSON.stringify({ used: 1000, size: 100_000, cost: { amount: 2, currency: "USD" } })}` },
    });
    // 這個回合應該正常結束(不被打斷)——等到 agent 自己送出的 "usage reported"
    // 訊息完整送達,證明回合沒有被腰斬。
    const chunkEvent = await client.waitForEvent(
      (e) => e.sessionId === sessionId && e.event.type === "message-delta" && e.event.delta === "usage reported",
      15_000,
      startIdx,
    );
    await client.waitForEvent((e) => e.sessionId === sessionId && (e.event.type === "completed" || e.event.type === "error"), 15_000);
    const turnNotCutShort = Boolean(chunkEvent); // 完整訊息送達,代表回合走完全程,沒被 interrupt() 腰斬

    const notification = await client
      .waitForEnforcementNotification((n) => n.kind === "trip" && n.tripReason === "task-budget", 5_000)
      .catch(() => undefined);
    const tripNotified = Boolean(notification);

    // 後續 prompt 應該被擋下(擋的是「後續」,不是這次已經結束的回合)。
    let blocked = false;
    let blockedErr = "";
    try {
      await client.rpc("session.sendPrompt", { sessionId, prompt: { text: "hello again" } });
    } catch (err) {
      blocked = true;
      blockedErr = String(err);
    }

    const summary = await client.rpc("cost.getSummary", { sessionId });
    const taskTripped = summary.task?.tripped === true;

    record(
      "C: 任務預算超標(maxCostUsd=1,灌入 cost=2)→ 觸發的這次回合正常走完全程(不打斷已結束的回合)、收到 trip 通知(reason=task-budget)、cost.getSummary 回報 task.tripped=true,且後續 sendPrompt 被擋下",
      turnNotCutShort && tripNotified && taskTripped && blocked,
      `turnNotCutShort=${turnNotCutShort}, tripNotified=${tripNotified}, taskTripped=${taskTripped}, blocked=${blocked}(${blockedErr})`,
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
// D:每日 kill-switch → 全部 session interrupt,且擋後續 prompt。
// =======================================================================
async function testDailyKillSwitch() {
  const PORT = 4363;
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-cost-d-data-"));
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-cost-d-home-"));
  const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-cost-d-ws-"));
  const configPath = path.join(homeDir, "config.json");
  writeConfigWithBudget(configPath, { daily: { maxCostUsd: 1 }, turn: { maxToolCalls: 100_000, maxDurationMs: 600_000 } });

  let coreProc;
  let client;
  try {
    coreProc = startCore({ port: PORT, dataDir, homeDir, workspaceDir });
    await waitForPort(`ws://127.0.0.1:${PORT}`, 20_000);
    client = new MiniGatewayClient(`ws://127.0.0.1:${PORT}`);
    await client.connect();

    // session1:觸發者,只送一次 usage_update 就結束。
    const { sessionId: sessionId1 } = await createAcpSession(client, workspaceDir, "D-daily-trigger");
    // session2:先跑一個長睡眠回合(30 秒),驗證「全部 interrupt」真的涵蓋
    // 這條完全無關的 session,不是只影響觸發者自己。
    const { sessionId: sessionId2 } = await createAcpSession(client, workspaceDir, "D-daily-bystander");
    const bystanderStart = Date.now();
    void client.rpc("session.sendPrompt", { sessionId: sessionId2, prompt: { text: `${SLEEP_TURN_PREFIX}${JSON.stringify({ ms: 30_000 })}` } });
    await client.waitForEvent((e) => e.sessionId === sessionId2 && e.event.type === "message-delta", 200).catch(() => {});
    await sleep(500); // 讓 session2 真的進入 busy、睡眠開始

    await client.rpc("session.sendPrompt", {
      sessionId: sessionId1,
      prompt: { text: `${USAGE_UPDATE_PREFIX}${JSON.stringify({ used: 1000, size: 100_000, cost: { amount: 2, currency: "USD" } })}` },
    });
    await client.waitForEvent((e) => e.sessionId === sessionId1 && (e.event.type === "completed" || e.event.type === "error"), 15_000);

    // session2(旁觀者)應該被全部 interrupt 波及,提早結束(遠早於 30 秒)。
    await client.waitForEvent((e) => e.sessionId === sessionId2 && (e.event.type === "completed" || e.event.type === "error"), 10_000);
    const bystanderElapsedMs = Date.now() - bystanderStart;
    const bystanderStoppedEarly = bystanderElapsedMs < 10_000;

    const notification = await client
      .waitForEnforcementNotification((n) => n.kind === "trip" && n.tripReason === "daily-limit", 5_000)
      .catch(() => undefined);
    const tripNotified = Boolean(notification);
    const targetsBothSessions =
      Boolean(notification) &&
      (notification.sessionId === undefined || notification.count >= 2) && // 見 §4.1:多個 session 時不給單一 sessionId
      notification.count >= 2;

    // 兩條 session 的後續 prompt 都應該被擋下(今日 kill-switch 已觸發)。
    let session1Blocked = false;
    let session2Blocked = false;
    try {
      await client.rpc("session.sendPrompt", { sessionId: sessionId1, prompt: { text: "again" } });
    } catch {
      session1Blocked = true;
    }
    try {
      await client.rpc("session.sendPrompt", { sessionId: sessionId2, prompt: { text: "again" } });
    } catch {
      session2Blocked = true;
    }

    const summary = await client.rpc("cost.getSummary", { sessionId: sessionId1 });
    const dailyTripped = summary.dailyTripped === true;

    record(
      "D: 每日 kill-switch(maxCostUsd=1,灌入 cost=2)→ 全部 session interrupt(含完全無關的旁觀者 session,其 30 秒睡眠回合被提早打斷)、收到 trip 通知(reason=daily-limit,count>=2)、cost.getSummary 回報 dailyTripped=true,且兩條 session 的後續 prompt 皆被擋下",
      bystanderStoppedEarly && tripNotified && targetsBothSessions && dailyTripped && session1Blocked && session2Blocked,
      `bystanderElapsedMs=${bystanderElapsedMs}(應遠小於 30000), tripNotified=${tripNotified}, notification.count=${notification?.count}, ` +
        `dailyTripped=${dailyTripped}, session1Blocked=${session1Blocked}, session2Blocked=${session2Blocked}`,
    );
  } catch (err) {
    record("D 執行過程發生未預期錯誤", false, String(err));
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
// E + F:掛起處理——T1(防遺忘,只通知不 halt)/ T2(資源回收,真 trip)。
// =======================================================================
async function testWaitingWatchdog() {
  const PORT = 4364;
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-cost-ef-data-"));
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-cost-ef-home-"));
  const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-cost-ef-ws-"));

  let coreProc;
  let client;
  try {
    coreProc = startCore({
      port: PORT,
      dataDir,
      homeDir,
      workspaceDir,
      extraEnv: {
        // T1=800ms、T2=2000ms、掃描間隔=300ms——比照既有 DESKMONY_YOLO_DURATION_MS
        // 的既有慣例,純粹讓 e2e 能在合理時間內驗證,不落地任何設定檔。
        DESKMONY_WAITING_T1_MS: "800",
        DESKMONY_WAITING_T2_MS: "2000",
        DESKMONY_WAITING_SCAN_INTERVAL_MS: "300",
      },
    });
    await waitForPort(`ws://127.0.0.1:${PORT}`, 20_000);
    client = new MiniGatewayClient(`ws://127.0.0.1:${PORT}`);
    await client.connect();

    const { sessionId } = await createAcpSession(client, workspaceDir, "EF-waiting-watchdog");

    // 觸發一筆未分類的 escalate(default-deny,沒有任何 policy 規則命中)→
    // 走 waiting,且不主動 resolve,讓它一直掛在那裡給 T1/T2 抓。
    const startIdx = client.events.length;
    const targetFile = path.join(workspaceDir, "ef-waiting.txt");
    const posixPath = targetFile.split(path.sep).join("/");
    await client.rpc("session.sendPrompt", {
      sessionId,
      prompt: { text: `${WRITE_FILE_PREFIX}${JSON.stringify({ path: posixPath, content: "x" })}` },
    });
    await client.waitForEvent((e) => e.sessionId === sessionId && e.event.type === "permission-request", 15_000, startIdx);
    await client.waitForSessionUpdate((u) => u.id === sessionId && u.status === "waiting", 5_000);

    // ---- E: T1(800ms)→ 只發通知,session 仍維持 waiting(不 halt)----
    const t1Notification = await client
      .waitForEnforcementNotification((n) => n.kind === "reminder" && n.reminderReason === "waiting-ttl", 5_000)
      .catch(() => undefined);
    const t1Notified = Boolean(t1Notification);
    const stillWaitingAfterT1 = (await client.rpc("session.list", {})).sessions.find((s) => s.id === sessionId)?.status === "waiting";

    record(
      "E: T1 防遺忘(waiting 超過 800ms 短版 T1)→ 只發 reminder 通知(不是 trip),session 仍維持 waiting(未被 halt)",
      t1Notified && stillWaitingAfterT1,
      `t1Notified=${t1Notified}, stillWaitingAfterT1=${stillWaitingAfterT1}`,
    );

    // ---- F: T2(2000ms)→ 真 trip,dispose 子程序,session 狀態變成 error ----
    const t2Notification = await client
      .waitForEnforcementNotification((n) => n.kind === "trip" && n.tripReason === "waiting-ttl", 8_000)
      .catch(() => undefined);
    const t2Tripped = Boolean(t2Notification);
    await sleep(500);
    const sessionAfterT2 = (await client.rpc("session.list", {})).sessions.find((s) => s.id === sessionId);
    const reclaimedToError = sessionAfterT2?.status === "error" && (sessionAfterT2?.lastError ?? "").includes("回收");

    // 子程序已經被 dispose、runtime 已移除——sendPrompt 應得到明確錯誤(而非
    // 靜默失敗),證明「需要人工重新建立 session 才能續行」這個預期行為。
    let sendPromptFailsAfterReclaim = false;
    try {
      await client.rpc("session.sendPrompt", { sessionId, prompt: { text: "should fail" } });
    } catch {
      sendPromptFailsAfterReclaim = true;
    }

    // session 記錄本身(DB)仍然保留——不是被 deleteSession() 那種連 DB 都清掉
    // 的刪除(HLD §4「回收 ≠ 丟棄」)。
    const sessionStillListed = Boolean(sessionAfterT2);

    record(
      "F: T2 資源回收(waiting 超過 2000ms 短版 T2)→ 真 trip(收到 trip 通知,reason=waiting-ttl),session 狀態變成 error(lastError 說明已回收)、子程序已釋放(sendPrompt 明確失敗),但 session 記錄本身仍保留(回收 ≠ 丟棄)",
      t2Tripped && reclaimedToError && sendPromptFailsAfterReclaim && sessionStillListed,
      `t2Tripped=${t2Tripped}, status=${sessionAfterT2?.status}, lastError=${sessionAfterT2?.lastError}, ` +
        `sendPromptFailsAfterReclaim=${sendPromptFailsAfterReclaim}, sessionStillListed=${sessionStillListed}`,
    );
  } catch (err) {
    record("E/F 執行過程發生未預期錯誤", false, String(err));
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

  console.log("=== S3b e2e:A + G(回合硬上限:工具呼叫次數 + 不報 usage 的後端只有回合上限生效)===");
  await testTurnLimitToolCalls();

  console.log("\n=== S3b e2e:B(回合硬上限:時間)===");
  await testTurnLimitDuration();

  console.log("\n=== S3b e2e:C(任務預算超標,只擋後續 prompt)===");
  await testTaskBudget();

  console.log("\n=== S3b e2e:D(每日 kill-switch,全部 interrupt)===");
  await testDailyKillSwitch();

  console.log("\n=== S3b e2e:E + F(掛起處理:T1 防遺忘 / T2 資源回收)===");
  await testWaitingWatchdog();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n\n========== 總結:${results.length - failed.length}/${results.length} 通過 ==========`);
  for (const r of failed) {
    console.log(`  FAIL: ${r.name}`);
  }
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[e2e-cost-governor] fatal:", err);
  process.exit(1);
});
