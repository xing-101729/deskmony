#!/usr/bin/env node
/**
 * scripts/e2e-agent-lifecycle.mjs
 *
 * S8(agent-lifecycle / Agent 生命週期 + 外部記憶(檔案層))端到端驗證,對應
 * docs/LAYER-4-detail-design/agent-lifecycle_detail.md §6 檢查清單。
 *
 * 沿用 scripts/e2e-crash-recovery.mjs 的手法(真實 WS Gateway + fake ACP agent,
 * 決定性、不依賴真實模型行為),獨立可執行,不 import 其他 e2e 腳本(只 import
 * scripts/fake-acp-agent.mjs 的常數,比照既有慣例)。
 *
 * ⚠️ 本規格的兩個驗收核心(見 agent-lifecycle_detail.md 開頭):
 *   ①ephemeral 的 spawn/dispose 全自動,且失敗可回滾 —— 測試 A(生命週期推導)、
 *     B(自動 spawn/dispose + blocked 不 dispose + 拒絕重複指派)、C(spawn 失敗
 *     整個回滾)。
 *   ②長命 agent 的 context 不再是空頭承諾(能 checkpoint 重啟,§4.2)—— 測試 E。
 *
 * 涵蓋:
 *   A. §1.1:lifecycle 預設推導(role 關鍵字)+ 明確覆寫。
 *   B. §2.1/§2.2:指派時自動 spawn;任務 done 自動 dispose;blocked 不 dispose；
 *      同一 ephemeral member 被指派第二個任務 → 拒絕;§3.1 `.deskmony/notes/`
 *      自動建立。
 *   C. §2.1「失敗處理」:spawn 失敗 → 整個指派回滾(任務退回 backlog、無殘留
 *      workspace/worktree)。
 *   D. §4(HLD)/S2 既有機制:訊息送給已 dispose 的 member → 留 Mailbox,下次
 *      該 member 被重新指派任務(自動 respawn)時補投。
 *   E. §4.2:長命(persistent)member 的 context 使用率達 85% → 觸發「寫筆記」
 *      prompt → 該回合結束後走「接手」(沿用同一個 DB session id)→ 只觸發一次。
 *
 * 前置需求:`pnpm build` 已跑過。
 * 用法:node scripts/e2e-agent-lifecycle.mjs
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmdirSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { USAGE_UPDATE_PREFIX } from "./fake-acp-agent.mjs";

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
}

/** 輪詢一個非同步條件直到成立或逾時——用來等待「一連串事件驅動的內部流程」
 *  (checkpoint 重啟、mailbox 補投)跑完,不依賴固定的 sleep 時間。 */
async function waitUntil(fn, { timeoutMs = 20_000, intervalMs = 200 } = {}) {
  const start = Date.now();
  let lastResult;
  while (Date.now() - start < timeoutMs) {
    lastResult = await fn();
    if (lastResult) return lastResult;
    await sleep(intervalMs);
  }
  throw new Error(`waitUntil 逾時(${timeoutMs}ms)`);
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

function rmDirs(dirs) {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

/**
 * 清掉這個測試自己建立的任務 worktree。
 *
 * task.assign 建立的 worktree **不在** repoDir 底下,而是
 * `<repoDir 的上層>/.deskmony-worktrees/<repoDir 名稱>-task-<8 碼>`(見
 * apps/core/src/workspace/workspace-manager.ts 的 `createWorkspaceForTask()`),
 * 所以 `rmDirs([dataDir, homeDir, repoDir])` 掃不到它們,每跑一次就在系統暫存
 * 目錄留下殘留。這些測試收尾時已經先 kill 掉 core,gateway 不在了,沒辦法走
 * `task.delete` 那條正規路徑 —— 直接用檔案系統清理,與 `rmDirs()` 同一個層級。
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

function initGitRepo(repoDir) {
  runGitSync(["init"], repoDir);
  runGitSync(["config", "user.email", "e2e@deskmony.local"], repoDir);
  runGitSync(["config", "user.name", "Deskmony E2E"], repoDir);
  spawnSync(process.execPath, ["-e", "require('fs').writeFileSync(process.argv[1], '# repo\\n')", path.join(repoDir, "README.md")]);
  runGitSync(["add", "."], repoDir);
  runGitSync(["commit", "-m", "initial commit"], repoDir);
}

async function createAcpProfile(client, name, workingDir, acpConfigOverride) {
  const { profile } = await client.rpc("profile.create", {
    name,
    software: "acp",
    workingDir,
    acpConfig: acpConfigOverride ?? { command: process.execPath, args: [FAKE_AGENT_PATH] },
    permissionLevel: "always-ask",
  });
  return profile;
}

// =======================================================================
// A:§1.1 lifecycle 預設推導(role 關鍵字,不分大小寫)+ 明確覆寫。
// =======================================================================
async function testLifecycleDerivation() {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-life-a-data-"));
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-life-a-home-"));
  const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-life-a-ws-"));

  let core, client;
  try {
    core = startCore({ port: 4700, dataDir, homeDir, workspaceDir });
    await waitForPort("ws://127.0.0.1:4700", 20_000);
    client = new MiniGatewayClient("ws://127.0.0.1:4700");
    await client.connect();

    const { team } = await client.rpc("team.create", { name: "E2E Lifecycle Team A" });
    const profile = await createAcpProfile(client, "E2E Lifecycle Profile A", workspaceDir);

    const cases = [
      { role: "Coder", lifecycle: undefined, expected: "ephemeral" },
      { role: "Reviewer", lifecycle: undefined, expected: "ephemeral" },
      { role: "Lead", lifecycle: undefined, expected: "persistent" },
      { role: "Backend PM", lifecycle: undefined, expected: "persistent" },
      { role: "架構師", lifecycle: undefined, expected: "persistent" },
      { role: "協調者", lifecycle: undefined, expected: "persistent" },
      { role: "Coder", lifecycle: "persistent", expected: "persistent" }, // 明確覆寫
      { role: "Lead", lifecycle: "ephemeral", expected: "ephemeral" }, // 明確覆寫
    ];

    let allOk = true;
    const detailParts = [];
    for (const c of cases) {
      const { member } = await client.rpc("team.addMember", {
        teamId: team.id,
        agentProfileId: profile.id,
        name: `Member-${randomUUID().slice(0, 8)}`,
        role: c.role,
        lifecycle: c.lifecycle,
      });
      const ok = member.lifecycle === c.expected;
      allOk = allOk && ok;
      detailParts.push(`role="${c.role}"${c.lifecycle ? `(覆寫=${c.lifecycle})` : ""}→${member.lifecycle}(期望${c.expected})${ok ? "" : " ✗"}`);
    }

    record(
      "A(§1.1 lifecycle 推導 + 覆寫): role 含 lead/pm/架構/協調(不分大小寫)→ persistent,其餘 → ephemeral;明確提供時優先採用",
      allOk,
      detailParts.join("; "),
    );

    client.close();
    await killProcessTreeHard(core);
    core = null;
  } catch (err) {
    record("A 執行過程發生未預期錯誤", false, String(err));
  } finally {
    client?.close();
    if (core) await killProcessTreeHard(core);
  }

  rmDirs([dataDir, homeDir, workspaceDir]);
}

// =======================================================================
// B:§2.1/§2.2/§3.1 —— 自動 spawn/dispose、blocked 不 dispose、拒絕重複指派、
// `.deskmony/notes/` 自動建立。
// =======================================================================
async function testEphemeralLifecycle() {
  const gitVersion = runGitSync(["--version"], process.cwd());
  if (gitVersion.status !== 0) {
    record("B: ephemeral 生命週期(git 不可用,整個步驟略過)", false, `找不到可用的 git 執行檔: ${gitVersion.error ?? gitVersion.stderr}`);
    return;
  }

  const dataDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-life-b-data-"));
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-life-b-home-"));
  const repoDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-life-b-repo-"));

  let core, client;
  try {
    initGitRepo(repoDir);

    core = startCore({ port: 4701, dataDir, homeDir, workspaceDir: repoDir });
    await waitForPort("ws://127.0.0.1:4701", 20_000);
    client = new MiniGatewayClient("ws://127.0.0.1:4701");
    await client.connect();

    const { team } = await client.rpc("team.create", { name: "E2E Lifecycle Team B", workingDir: repoDir });
    const profile = await createAcpProfile(client, "E2E Lifecycle Profile B", repoDir);

    const { member: workerA } = await client.rpc("team.addMember", {
      teamId: team.id,
      agentProfileId: profile.id,
      name: "WorkerA",
      role: "Coder",
    });
    const { member: workerB } = await client.rpc("team.addMember", {
      teamId: team.id,
      agentProfileId: profile.id,
      name: "WorkerB",
      role: "Coder",
    });
    const { member: workerC } = await client.rpc("team.addMember", {
      teamId: team.id,
      agentProfileId: profile.id,
      name: "WorkerC",
      role: "Coder",
    });

    // ---- B1: 指派時自動 spawn(不呼叫 session.create)---------------------
    const { task: taskA } = await client.rpc("task.create", { teamId: team.id, title: "B1-auto-spawn" });
    const assignedA = await client.rpc("task.assign", { taskId: taskA.id, memberId: workerA.id });
    const { teammates: teammatesAfterAssignA } = await client.rpc("team.teammates", { teamId: team.id });
    const workerATeammate = teammatesAfterAssignA.find((t) => t.memberId === workerA.id);
    const autoSpawnedA = workerATeammate?.hasActiveSession === true;

    // 用 workingDir(= 這個任務專屬的 worktree 路徑)比對,而不是 agentProfileId
    // ——workerA/B/C 共用同一個 profile,agentProfileId 無法唯一識別是哪個
    // member 的 session;worktree 路徑對每個任務都是唯一的。
    const { sessions: sessionsAfterAssignA } = await client.rpc("session.list", {});
    const sessionA = sessionsAfterAssignA.find((s) => s.workingDir === assignedA.workspace.worktreePath && s.status !== "closed");

    record(
      "B1(§2.1 指派時自動 spawn): task.assign 後,ephemeral member 立刻擁有活躍 session,完全不需要呼叫 session.create",
      autoSpawnedA && Boolean(sessionA),
      `hasActiveSession=${workerATeammate?.hasActiveSession}, sessionFound=${Boolean(sessionA)}`,
    );

    // ---- B2(§3.1): `.deskmony/notes/` 自動建立 --------------------------
    const worktreePathA = assignedA.workspace.worktreePath;
    const notesTeamMdPath = path.join(worktreePathA, ".deskmony", "notes", "team.md");
    const notesDirCreated = existsSync(notesTeamMdPath);
    record(
      "B2(§3.1 `.deskmony/notes/` 自動建立): spawn 後 worktree 內出現 .deskmony/notes/team.md",
      notesDirCreated,
      `path=${notesTeamMdPath}, exists=${notesDirCreated}`,
    );

    // ---- B3: 任務 done → 自動 dispose ------------------------------------
    await client.rpc("task.updateStatus", { taskId: taskA.id, status: "in-progress" });
    await client.rpc("task.updateStatus", { taskId: taskA.id, status: "review" });
    await client.rpc("task.updateStatus", { taskId: taskA.id, status: "merging" });
    await client.rpc("task.merge", { taskId: taskA.id });

    const { teammates: teammatesAfterDone } = await client.rpc("team.teammates", { teamId: team.id });
    const workerATeammateAfterDone = teammatesAfterDone.find((t) => t.memberId === workerA.id);
    const disposedAfterDone = workerATeammateAfterDone?.hasActiveSession === false;

    const { sessions: sessionsAfterDone } = await client.rpc("session.list", {});
    const sessionAAfterDone = sessionsAfterDone.find((s) => s.id === sessionA?.id);
    const closedNotDeleted = sessionAAfterDone?.status === "closed";
    const { messages: historyPreserved } = await client.rpc("session.history", { sessionId: sessionA.id });

    record(
      "B3(§2.2 任務 done → 自動 dispose): dispose 後 member 不再有活躍 session,但 session/messages 記錄仍保留(標 closed,不是刪除)",
      disposedAfterDone && closedNotDeleted && Array.isArray(historyPreserved),
      `hasActiveSession=${workerATeammateAfterDone?.hasActiveSession}, sessionStatus=${sessionAAfterDone?.status}, historyLen=${historyPreserved?.length}`,
    );

    // ---- B4: blocked 不 dispose ------------------------------------------
    const { task: taskB } = await client.rpc("task.create", { teamId: team.id, title: "B4-blocked-no-dispose" });
    await client.rpc("task.assign", { taskId: taskB.id, memberId: workerB.id });
    await client.rpc("task.updateStatus", { taskId: taskB.id, status: "in-progress" });
    await client.rpc("task.updateStatus", { taskId: taskB.id, status: "blocked" });

    const { teammates: teammatesAfterBlocked } = await client.rpc("team.teammates", { teamId: team.id });
    const workerBTeammate = teammatesAfterBlocked.find((t) => t.memberId === workerB.id);
    const stillActiveWhenBlocked = workerBTeammate?.hasActiveSession === true;

    record(
      "B4(§2.2「blocked 不 dispose」): 任務進入 blocked 後,ephemeral member 的 session 仍然活躍(未被 dispose)",
      stillActiveWhenBlocked,
      `hasActiveSession=${workerBTeammate?.hasActiveSession}`,
    );

    // ---- B5: 同一 ephemeral member 被指派第二個任務 → 拒絕 -----------------
    const { task: taskC1 } = await client.rpc("task.create", { teamId: team.id, title: "B5-first" });
    await client.rpc("task.assign", { taskId: taskC1.id, memberId: workerC.id });

    const { task: taskC2 } = await client.rpc("task.create", { teamId: team.id, title: "B5-second" });
    let rejectedSecondAssign = false;
    let rejectMessage = "";
    try {
      await client.rpc("task.assign", { taskId: taskC2.id, memberId: workerC.id });
    } catch (err) {
      rejectedSecondAssign = true;
      rejectMessage = String(err);
    }
    const { task: taskC2AfterReject } = await client.rpc("task.get", { taskId: taskC2.id });
    const secondTaskStillBacklog = taskC2AfterReject.status === "backlog" && !taskC2AfterReject.workspaceId;

    record(
      "B5(§2.1「一 member 一 session」拒絕重複指派): 第二次指派被拒絕,且第二個任務仍停留在 backlog、未綁定 workspace",
      rejectedSecondAssign && secondTaskStillBacklog,
      `rejected=${rejectedSecondAssign}, err=${rejectMessage}, taskC2.status=${taskC2AfterReject.status}`,
    );

    client.close();
    await killProcessTreeHard(core);
    core = null;
  } catch (err) {
    record("B 執行過程發生未預期錯誤", false, String(err));
  } finally {
    client?.close();
    if (core) await killProcessTreeHard(core);
  }

  rmTaskWorktrees(repoDir); // 見該函式註解:worktree 不在 repoDir 底下
  rmDirs([dataDir, homeDir, repoDir]);
}

// =======================================================================
// C:§2.1「失敗處理」—— spawn 失敗時整個指派回滾(任務退回 backlog、無殘留
// workspace/worktree)。用一個保證啟動失敗的 acpConfig.command 決定性地觸發
// spawn 失敗(不依賴真實模型/網路)。
// =======================================================================
async function testSpawnFailureRollback() {
  const gitVersion = runGitSync(["--version"], process.cwd());
  if (gitVersion.status !== 0) {
    record("C: spawn 失敗回滾(git 不可用,整個步驟略過)", false, `找不到可用的 git 執行檔: ${gitVersion.error ?? gitVersion.stderr}`);
    return;
  }

  const dataDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-life-c-data-"));
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-life-c-home-"));
  const repoDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-life-c-repo-"));

  let core, client;
  try {
    initGitRepo(repoDir);

    core = startCore({ port: 4702, dataDir, homeDir, workspaceDir: repoDir });
    await waitForPort("ws://127.0.0.1:4702", 20_000);
    client = new MiniGatewayClient("ws://127.0.0.1:4702");
    await client.connect();

    const { team } = await client.rpc("team.create", { name: "E2E Lifecycle Team C", workingDir: repoDir });
    // 保證啟動失敗:command 指向一個不存在的執行檔(ENOENT),AcpAdapter.spawn()
    // 會把子程序的 "error" 事件轉成一個會 reject 的 promise(見
    // packages/adapters/src/acp-adapter.ts 頂端「child 啟動失敗」註解)。
    const brokenProfile = await createAcpProfile(client, "E2E Broken Profile", repoDir, {
      command: "deskmony-e2e-this-command-does-not-exist-xyz",
      args: [],
    });
    const { member: brokenWorker } = await client.rpc("team.addMember", {
      teamId: team.id,
      agentProfileId: brokenProfile.id,
      name: "BrokenWorker",
      role: "Coder",
    });

    const { task } = await client.rpc("task.create", { teamId: team.id, title: "C-spawn-failure" });
    let assignRejected = false;
    let assignErr = "";
    try {
      await client.rpc("task.assign", { taskId: task.id, memberId: brokenWorker.id });
    } catch (err) {
      assignRejected = true;
      assignErr = String(err);
    }

    const { task: taskAfterFailure } = await client.rpc("task.get", { taskId: task.id });
    const rolledBackToBacklog = taskAfterFailure.status === "backlog" && !taskAfterFailure.workspaceId;

    const worktreeList = runGitSync(["worktree", "list", "--porcelain"], repoDir);
    const worktreeEntries = worktreeList.stdout.split(/\r?\n\r?\n/).filter((chunk) => chunk.trim().length > 0);
    const noResidualWorktree = worktreeEntries.length === 1; // 只剩主 worktree(baseDir 本身)

    const { teammates } = await client.rpc("team.teammates", { teamId: team.id });
    const brokenWorkerTeammate = teammates.find((t) => t.memberId === brokenWorker.id);
    const noSessionLeftBehind = brokenWorkerTeammate?.hasActiveSession === false;

    record(
      "C(§2.1「spawn 失敗 → 整個指派回滾」): task.assign 被拒絕,任務退回 backlog 且未綁定 workspace,worktree 無殘留,member 沒有殘留 session",
      assignRejected && rolledBackToBacklog && noResidualWorktree && noSessionLeftBehind,
      `rejected=${assignRejected}, err=${assignErr}, task.status=${taskAfterFailure.status}, worktreeEntries=${worktreeEntries.length}, hasActiveSession=${brokenWorkerTeammate?.hasActiveSession}`,
    );

    client.close();
    await killProcessTreeHard(core);
    core = null;
  } catch (err) {
    record("C 執行過程發生未預期錯誤", false, String(err));
  } finally {
    client?.close();
    if (core) await killProcessTreeHard(core);
  }

  rmTaskWorktrees(repoDir); // 見該函式註解:worktree 不在 repoDir 底下
  rmDirs([dataDir, homeDir, repoDir]);
}

// =======================================================================
// D:訊息送給已 dispose 的 ephemeral member → 留 Mailbox(S2 既有機制),
// 下次該 member 被重新指派任務(自動 respawn)時補投。
// =======================================================================
async function testMailboxRequeueOnRespawn() {
  const gitVersion = runGitSync(["--version"], process.cwd());
  if (gitVersion.status !== 0) {
    record("D: mailbox 補投(git 不可用,整個步驟略過)", false, `找不到可用的 git 執行檔: ${gitVersion.error ?? gitVersion.stderr}`);
    return;
  }

  const dataDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-life-d-data-"));
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-life-d-home-"));
  const repoDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-life-d-repo-"));

  let core, client;
  try {
    initGitRepo(repoDir);

    core = startCore({ port: 4703, dataDir, homeDir, workspaceDir: repoDir });
    await waitForPort("ws://127.0.0.1:4703", 20_000);
    client = new MiniGatewayClient("ws://127.0.0.1:4703");
    await client.connect();

    const { team } = await client.rpc("team.create", { name: "E2E Lifecycle Team D", workingDir: repoDir });
    const profile = await createAcpProfile(client, "E2E Lifecycle Profile D", repoDir);

    const { member: sender } = await client.rpc("team.addMember", {
      teamId: team.id,
      agentProfileId: profile.id,
      name: "Sender",
      role: "Coder",
    });
    const { member: recipient } = await client.rpc("team.addMember", {
      teamId: team.id,
      agentProfileId: profile.id,
      name: "Recipient",
      role: "Coder",
    });

    // sender 需要一個「進行中」的任務,send_message 的 contextId 推導才不會拒收
    // (S2 既有規則,見 message-bus.ts 的 deriveContextId())。
    const { task: senderTask } = await client.rpc("task.create", { teamId: team.id, title: "D-sender-task" });
    await client.rpc("task.assign", { taskId: senderTask.id, memberId: sender.id });

    // recipient 先被指派一個任務(自動 spawn),再走到 done(自動 dispose),
    // 讓它「目前沒有活躍 session」。
    const { task: recipientTask1 } = await client.rpc("task.create", { teamId: team.id, title: "D-recipient-task-1" });
    await client.rpc("task.assign", { taskId: recipientTask1.id, memberId: recipient.id });
    await client.rpc("task.updateStatus", { taskId: recipientTask1.id, status: "in-progress" });
    await client.rpc("task.updateStatus", { taskId: recipientTask1.id, status: "review" });
    await client.rpc("task.updateStatus", { taskId: recipientTask1.id, status: "merging" });
    await client.rpc("task.merge", { taskId: recipientTask1.id });

    const { teammates: teammatesBeforeSend } = await client.rpc("team.teammates", { teamId: team.id });
    const recipientDisposed = teammatesBeforeSend.find((t) => t.memberId === recipient.id)?.hasActiveSession === false;

    const marker = `mailbox-requeue-marker-${randomUUID().slice(0, 8)}`;
    const sendResult = await client.rpc("message.sendMessage", {
      teamId: team.id,
      fromMemberId: sender.id,
      to: recipient.name,
      content: marker,
    });
    // recipient 已被 dispose(§2.2),`SessionManager.getSessionIdForMember()`
    // 查不到任何 session id ⇒ MessageBus.deliverToMember() 如實回報
    // "no-session"(不是 "queued"——那是「session 存在但忙碌」的情況;這裡是
    // 「連 session 都不存在」,見 message-bus.ts 的 deliverToMember() 註解)。
    // 兩者對訊息本身的結果是一樣的:都留在 DB 驅動的 Mailbox 裡等補投。
    const notDeliveredWhileDisposed = sendResult.delivered === "no-session";

    const { messages: messagesBeforeRespawn } = await client.rpc("team.messages", { teamId: team.id });
    const markerMsgBefore = messagesBeforeRespawn.find((m) => m.content === marker);
    const notYetDelivered = markerMsgBefore && markerMsgBefore.deliveredAt === undefined;

    // 重新指派任務給 recipient → 自動 respawn → 觸發 S2 既有的 mailbox 補投
    // (member-session-ready 事件,見 message-bus.ts constructor)。
    const { task: recipientTask2 } = await client.rpc("task.create", { teamId: team.id, title: "D-recipient-task-2" });
    await client.rpc("task.assign", { taskId: recipientTask2.id, memberId: recipient.id });

    const delivered = await waitUntil(async () => {
      const { messages } = await client.rpc("team.messages", { teamId: team.id });
      const msg = messages.find((m) => m.content === marker);
      return msg && msg.deliveredAt !== undefined ? msg : undefined;
    }, { timeoutMs: 15_000 }).catch(() => undefined);

    record(
      "D(訊息送給已 dispose 的 member → 留 Mailbox,下次 spawn 補投,S2 既有機制): 送出時 recipient 已無活躍 session(delivered=no-session,未送達);重新指派任務自動 respawn 後,訊息被補投(deliveredAt 從無到有)",
      recipientDisposed && notDeliveredWhileDisposed && Boolean(notYetDelivered) && Boolean(delivered),
      `recipientDisposed=${recipientDisposed}, delivered=${sendResult.delivered}, notYetDelivered=${Boolean(notYetDelivered)}, finallyDelivered=${Boolean(delivered)}`,
    );

    client.close();
    await killProcessTreeHard(core);
    core = null;
  } catch (err) {
    record("D 執行過程發生未預期錯誤", false, String(err));
  } finally {
    client?.close();
    if (core) await killProcessTreeHard(core);
  }

  rmTaskWorktrees(repoDir); // 見該函式註解:worktree 不在 repoDir 底下
  rmDirs([dataDir, homeDir, repoDir]);
}

// =======================================================================
// E:§4.2 —— 長命(persistent)member 的 context 使用率達 85% → 觸發「寫筆記」
// prompt → 該回合結束後走「接手」(沿用同一個 DB session id)→ 只觸發一次。
// =======================================================================
async function testContextCheckpointRestart() {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-life-e-data-"));
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-life-e-home-"));
  const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-life-e-ws-"));

  let core, client;
  try {
    core = startCore({ port: 4704, dataDir, homeDir, workspaceDir });
    await waitForPort("ws://127.0.0.1:4704", 20_000);
    client = new MiniGatewayClient("ws://127.0.0.1:4704");
    await client.connect();

    const { team } = await client.rpc("team.create", { name: "E2E Lifecycle Team E", workingDir: workspaceDir });
    const profile = await createAcpProfile(client, "E2E Lead Profile", workspaceDir);
    const { member: lead } = await client.rpc("team.addMember", {
      teamId: team.id,
      agentProfileId: profile.id,
      name: "Lead",
      role: "Lead", // → persistent(§1.1 推導)
    });

    // persistent member:session 由人/團隊手動建立(§2.1「persistent:不做任何事」),
    // 這裡直接呼叫 session.create(比照 TeamManagementDialog 的「建立 session」按鈕)。
    const { session } = await client.rpc(
      "session.create",
      { agentProfileId: profile.id, workingDir: workspaceDir, title: "Lead Session", teamMemberId: lead.id },
      30_000,
    );
    const originalSessionId = session.id;

    // §3.1/§3.2:.deskmony/notes/ 應該已經在 spawn 時建立。
    const notesTeamMdPath = path.join(workspaceDir, ".deskmony", "notes", "team.md");
    const notesDirCreated = existsSync(notesTeamMdPath);
    record(
      "E0(§3.1 `.deskmony/notes/` 自動建立,persistent member): session.create 後立即出現 .deskmony/notes/team.md",
      notesDirCreated,
      `path=${notesTeamMdPath}, exists=${notesDirCreated}`,
    );

    // 送出一則帶 usage_update(used/size=91%)的 prompt,觸發 §4.2 的 checkpoint
    // 流程(context-usage 事件由 fake-acp-agent.mjs 依 USAGE_UPDATE_PREFIX 送出)。
    const usagePayload = JSON.stringify({ used: 91, size: 100 });
    await client.rpc("session.sendPrompt", { sessionId: originalSessionId, prompt: { text: `${USAGE_UPDATE_PREFIX}${usagePayload}` } });

    // 等待整個 checkpoint 流程跑完:寫筆記 prompt → 完成 → dispose 舊 handle →
    // 重新 spawn(沿用同一個 sessionId)→ system 訊息 → 送出摘要 → 完成。
    const checkpointHappened = await waitUntil(async () => {
      const { messages } = await client.rpc("session.history", { sessionId: originalSessionId });
      const systemMsg = messages.find((m) => m.role === "system" && m.content.includes("[S8] context 使用率已達閾值"));
      return systemMsg ? messages : undefined;
    }, { timeoutMs: 25_000 }).catch(() => undefined);

    if (!checkpointHappened) {
      record("E(§4.2 context checkpoint 重啟)", false, "等待 checkpoint 完成逾時,見上方 core log");
    } else {
      // 用「訊息本身以『你的 context 即將用盡』開頭」辨識「寫筆記」prompt——
      // 不能用 includes() 寬鬆比對:checkpoint 重啟後送出的摘要文字
      // (buildContextCheckpointSummary())的「最後對話(最多 3 輪)」區塊會把
      // 上一輪的完整對話(含這則「寫筆記」prompt 本身)原文引用進去,所以
      // includes() 會把摘要也誤算成第二則「寫筆記」prompt——這不是重複觸發
      // 的 bug,只是摘要天生會引用最近幾則對話,用 startsWith() 才能正確只
      // 抓到「寫筆記」prompt 這則訊息本身。
      const notePromptMsgs = checkpointHappened.filter(
        (m) => m.role === "user" && m.content.startsWith("你的 context 即將用盡"),
      );
      const systemMsgs = checkpointHappened.filter((m) => m.role === "system" && m.content.includes("[S8] context 使用率已達閾值"));
      const onlyTriggeredOnce = notePromptMsgs.length === 1 && systemMsgs.length === 1;

      // 沿用同一個 DB session id(不是 RecoveryService.takeover() 那種開新 session)。
      const { sessions } = await client.rpc("session.list", {});
      const sameSessionId = sessions.some((s) => s.id === originalSessionId);
      const stillIdleEventually = await waitUntil(async () => {
        const { sessions: latestSessions } = await client.rpc("session.list", {});
        const s = latestSessions.find((x) => x.id === originalSessionId);
        return s?.status === "idle" ? s : undefined;
      }, { timeoutMs: 15_000 }).catch(() => undefined);

      record(
        "E(§4.2 長命 agent 的 context checkpoint 重啟): context 達 85% 後觸發寫筆記 prompt,回合結束後自動接手重啟(沿用同一個 DB session id),且整個流程只觸發一次(寫筆記 prompt 與 [S8] 系統訊息都恰好各一則)",
        onlyTriggeredOnce && sameSessionId && Boolean(stillIdleEventually),
        `notePromptCount=${notePromptMsgs.length}, systemMsgCount=${systemMsgs.length}, sameSessionId=${sameSessionId}, finalStatus=${stillIdleEventually?.status}`,
      );
    }

    client.close();
    await killProcessTreeHard(core);
    core = null;
  } catch (err) {
    record("E 執行過程發生未預期錯誤", false, String(err));
  } finally {
    client?.close();
    if (core) await killProcessTreeHard(core);
  }

  rmDirs([dataDir, homeDir, workspaceDir]);
}

// =======================================================================
async function main() {
  if (!existsSync(CORE_ENTRY)) {
    console.error(`找不到 ${CORE_ENTRY} —— 請先執行 pnpm build`);
    process.exit(1);
  }

  console.log("=== S8 e2e:A(§1.1 lifecycle 預設推導 + 明確覆寫)===");
  await testLifecycleDerivation();

  console.log("\n=== S8 e2e:B(§2.1/§2.2/§3.1 自動 spawn/dispose、blocked 不 dispose、拒絕重複指派、notes 自動建立)===");
  await testEphemeralLifecycle();

  console.log("\n=== S8 e2e:C(§2.1 spawn 失敗 → 整個指派回滾)===");
  await testSpawnFailureRollback();

  console.log("\n=== S8 e2e:D(訊息送給已 dispose 的 member → Mailbox → 下次 spawn 補投)===");
  await testMailboxRequeueOnRespawn();

  console.log("\n=== S8 e2e:E(§4.2 長命 agent 的 context checkpoint 重啟,只觸發一次)===");
  await testContextCheckpointRestart();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n\n========== 總結:${results.length - failed.length}/${results.length} 通過 ==========`);
  for (const r of failed) {
    console.log(`  FAIL: ${r.name}`);
  }
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[e2e-agent-lifecycle] fatal:", err);
  process.exit(1);
});
