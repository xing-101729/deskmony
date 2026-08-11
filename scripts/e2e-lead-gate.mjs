#!/usr/bin/env node
/**
 * scripts/e2e-lead-gate.mjs
 *
 * S5(dispose-gate-and-lead / Lead(AgentProfile)+ dispose-gate)端到端驗證,對應
 * docs/LAYER-4-detail-design/dispose-gate-and-lead_detail.md §4 檢查清單。
 *
 * 沿用 scripts/e2e-agent-lifecycle.mjs 的手法(真實 WS Gateway + fake ACP agent,
 * 決定性、不依賴真實模型行為),獨立可執行,不 import 其他 e2e 腳本(只 import
 * scripts/fake-acp-agent.mjs 的路徑常數,比照既有慣例)。
 *
 * ⚠️ 本規格的三個驗收核心(見 dispose-gate-and-lead_detail.md 開頭):
 *   ① agent 自稱完成必須過機器驗收或人類核可,無法自我背書
 *      —— 測試 A(有 acceptance,通過/失敗都由機器裁決)、B(無 acceptance,
 *      掛起等人類經 task.approveReview 核可)。
 *   ② 既有的「done 需人類經 task.merge 合併」把關點不可退步 —— 測試 D。
 *   ③ Lead 的智慧全在 prompt,Core 不得出現任何排程/編排演算法 —— 這是靜態
 *      設計檢查(見本檔案最下方的檢查清單註記),不是可執行的斷言,e2e 只能
 *      驗證行為面(閘的裁決規則),程式碼面由 code review 把關。
 *
 * 涵蓋(對應 L4 §4 e2e 檢查清單逐項):
 *   A. 有 acceptance 且通過 → agent report_status(review)自動放行進 review;
 *      有 acceptance 但失敗 → 拒絕,任務維持 in-progress,錯誤訊息含輸出末段。
 *   B. 無 acceptance → awaitingHumanReview=true,不進 review,發 escalation;
 *      人類 task.approveReview 後才進 review(用 request_review 工具走這條路,
 *      涵蓋 report_status 之外的第二個 agent 入口)。
 *   C. 連續 3 次驗收失敗 → 第 4 次直接拒絕、不再呼叫 AcceptanceRunner(用一個
 *      會留下真實副作用的指令決定性驗證 Runner 真的沒有被呼叫第 4 次,不只是
 *      比對錯誤文字)。
 *   D. 人類經 task.updateStatus 走同一個 in-progress→review 轉換 → 不受閘影響
 *      (維持諮詢,即使任務沒有 acceptance 也直接放行);agent 仍無法透過
 *      report_status 把任務變成 done(既有把關點不可退步)。
 *
 * 前置需求:`pnpm build` 已跑過。
 * 用法:node scripts/e2e-lead-gate.mjs
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

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
}

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

function initGitRepo(repoDir) {
  runGitSync(["init"], repoDir);
  runGitSync(["config", "user.email", "e2e@deskmony.local"], repoDir);
  runGitSync(["config", "user.name", "Deskmony E2E"], repoDir);
  spawnSync(process.execPath, ["-e", "require('fs').writeFileSync(process.argv[1], '# repo\\n')", path.join(repoDir, "README.md")]);
  runGitSync(["add", "."], repoDir);
  runGitSync(["commit", "-m", "initial commit"], repoDir);
}

async function createAcpProfile(client, name, workingDir) {
  const { profile } = await client.rpc("profile.create", {
    name,
    software: "acp",
    workingDir,
    acpConfig: { command: process.execPath, args: [FAKE_AGENT_PATH] },
    permissionLevel: "always-ask",
  });
  return profile;
}

/** 建一個 team + profile + 一位 ephemeral(Coder)worker,回傳可重複使用的 context。 */
async function setupTeamWithWorker(client, teamName, repoDir, workerName) {
  const { team } = await client.rpc("team.create", { name: teamName, workingDir: repoDir });
  const profile = await createAcpProfile(client, `${teamName} Profile`, repoDir);
  const { member: worker } = await client.rpc("team.addMember", {
    teamId: team.id,
    agentProfileId: profile.id,
    name: workerName,
    role: "Coder",
  });
  return { team, profile, worker };
}

/** 建立任務、指派給 worker(自動 spawn)、推進到 in-progress(人類/UI 動作,
 *  這一步刻意用 task.updateStatus,不受 S5 閘影響——閘只擋 in-progress→review)。 */
async function createInProgressTask(client, teamId, workerId, title, acceptance) {
  const { task } = await client.rpc("task.create", { teamId, title, acceptance });
  await client.rpc("task.assign", { taskId: task.id, memberId: workerId });
  await client.rpc("task.updateStatus", { taskId: task.id, status: "in-progress" });
  return task;
}

// =======================================================================
// A:有 acceptance ——通過 → 自動放行進 review;失敗 → 拒絕,任務維持
// in-progress,錯誤訊息含輸出末段。
// =======================================================================
async function testAcceptanceRunGate() {
  const gitVersion = runGitSync(["--version"], process.cwd());
  if (gitVersion.status !== 0) {
    record("A: 驗收機器裁決(git 不可用,整個步驟略過)", false, `找不到可用的 git 執行檔: ${gitVersion.error ?? gitVersion.stderr}`);
    return;
  }

  const dataDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-gate-a-data-"));
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-gate-a-home-"));
  const repoDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-gate-a-repo-"));

  let core, client;
  try {
    initGitRepo(repoDir);
    core = startCore({ port: 4710, dataDir, homeDir, workspaceDir: repoDir });
    await waitForPort("ws://127.0.0.1:4710", 20_000);
    client = new MiniGatewayClient("ws://127.0.0.1:4710");
    await client.connect();

    const { team, worker: workerPass } = await setupTeamWithWorker(client, "E2E Gate Team A", repoDir, "WorkerPass");

    // ---- A1: 有 acceptance 且通過 → 自動放行進 review --------------------
    const passCmd = process.platform === "win32" ? 'node -e "process.exit(0)"' : "node -e 'process.exit(0)'";
    const taskPass = await createInProgressTask(client, team.id, workerPass.id, "A1-pass", { commands: [passCmd] });

    const outcomePass = await client.rpc("message.reportStatus", {
      teamId: team.id,
      fromMemberId: workerPass.id,
      status: "review",
      taskId: taskPass.id,
    });
    const { task: taskPassAfter } = await client.rpc("task.get", { taskId: taskPass.id });
    const passAdvanced = taskPassAfter.status === "review";
    const passContentOk = outcomePass.message.content.includes("已同步") && outcomePass.message.content.includes("review");

    record(
      "A1(§1.2「有 acceptance 且通過 → 自動放行」): agent report_status(review) 在驗收通過後,任務自動轉進 review,不需要人類介入",
      passAdvanced && passContentOk,
      `task.status=${taskPassAfter.status}, content=${outcomePass.message.content}`,
    );

    // ---- A2: 有 acceptance 但失敗 → 拒絕,任務維持 in-progress,錯誤含輸出末段 --
    const { member: workerFail2 } = await client.rpc("team.addMember", {
      teamId: team.id,
      agentProfileId: (await client.rpc("profile.list", {})).profiles[0].id,
      name: "WorkerFail",
      role: "Coder",
    });
    const failCmd =
      process.platform === "win32"
        ? 'node -e "console.log(\'boom-marker-xyz\'); process.exit(1)"'
        : "node -e \"console.log('boom-marker-xyz'); process.exit(1)\"";
    const taskFail = await createInProgressTask(client, team.id, workerFail2.id, "A2-fail", { commands: [failCmd] });

    const outcomeFail = await client.rpc("message.reportStatus", {
      teamId: team.id,
      fromMemberId: workerFail2.id,
      status: "review",
      taskId: taskFail.id,
    });
    const { task: taskFailAfter } = await client.rpc("task.get", { taskId: taskFail.id });
    const failStayedInProgress = taskFailAfter.status === "in-progress";
    const failMsgHasOutputTail =
      outcomeFail.message.content.includes("驗收未通過") &&
      outcomeFail.message.content.includes("in-progress") &&
      outcomeFail.message.content.includes("boom-marker-xyz");

    record(
      "A2(§1.2/§1.3「有 acceptance 但失敗 → 拒絕」): agent report_status(review) 被拒絕,任務維持 in-progress,回應含可理解的錯誤(驗收未通過 + 輸出末段)",
      failStayedInProgress && failMsgHasOutputTail,
      `task.status=${taskFailAfter.status}, content=${outcomeFail.message.content}`,
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

  rmDirs([dataDir, homeDir, repoDir]);
}

// =======================================================================
// B:無 acceptance → awaitingHumanReview=true,不進 review,發 escalation;
// 人類 task.approveReview 核可後才進 review。用 request_review 工具(而非
// report_status)走這條路,涵蓋 agent 的第二個入口。
// =======================================================================
async function testNoAcceptanceHumanApproval() {
  const gitVersion = runGitSync(["--version"], process.cwd());
  if (gitVersion.status !== 0) {
    record("B: 無 acceptance 人類核可(git 不可用,整個步驟略過)", false, `找不到可用的 git 執行檔: ${gitVersion.error ?? gitVersion.stderr}`);
    return;
  }

  const dataDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-gate-b-data-"));
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-gate-b-home-"));
  const repoDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-gate-b-repo-"));

  let core, client;
  try {
    initGitRepo(repoDir);
    core = startCore({ port: 4711, dataDir, homeDir, workspaceDir: repoDir });
    await waitForPort("ws://127.0.0.1:4711", 20_000);
    client = new MiniGatewayClient("ws://127.0.0.1:4711");
    await client.connect();

    const { team, worker } = await setupTeamWithWorker(client, "E2E Gate Team B", repoDir, "Worker");
    // reviewer 只是 request_review 工具語意上需要的一個「收件人」,不需要真的
    // 做任何事。
    const { member: reviewer } = await client.rpc("team.addMember", {
      teamId: team.id,
      agentProfileId: (await client.rpc("profile.list", {})).profiles[0].id,
      name: "Reviewer",
      role: "Reviewer",
    });

    const task = await createInProgressTask(client, team.id, worker.id, "B-no-acceptance", undefined);

    const outcome1 = await client.rpc("message.requestReview", {
      teamId: team.id,
      fromMemberId: worker.id,
      to: reviewer.name,
      taskId: task.id,
    });
    const notUpdated = outcome1.taskUpdated === false;
    const skippedMentionsHumanReview =
      (outcome1.taskSkippedReason ?? "").includes("已請求人類核可") || (outcome1.taskSkippedReason ?? "").includes("未定義機器驗收條件");

    const { task: taskAfterRequest } = await client.rpc("task.get", { taskId: task.id });
    const awaitingSet = taskAfterRequest.awaitingHumanReview === true;
    const stillInProgress = taskAfterRequest.status === "in-progress";

    record(
      "B1(§1.2「無 acceptance → 人判」,經 request_review 工具): agent 請求送審後,任務維持 in-progress、awaitingHumanReview=true,不自動進 review",
      notUpdated && skippedMentionsHumanReview && awaitingSet && stillInProgress,
      `taskUpdated=${outcome1.taskUpdated}, skippedReason=${outcome1.taskSkippedReason}, awaitingHumanReview=${taskAfterRequest.awaitingHumanReview}, status=${taskAfterRequest.status}`,
    );

    // 重複請求 → 不重複觸發(idempotent 訊息,不是報錯)。
    const outcome2 = await client.rpc("message.requestReview", {
      teamId: team.id,
      fromMemberId: worker.id,
      to: reviewer.name,
      taskId: task.id,
    });
    const idempotentMessage = (outcome2.taskSkippedReason ?? "").includes("不需要重複請求");
    record(
      "B2(重複請求送審,不重複 escalate): 第二次 request_review 回報「不需要重複請求」,任務狀態不變",
      idempotentMessage,
      `skippedReason=${outcome2.taskSkippedReason}`,
    );

    // 人類核可:task.approveReview → 真正轉進 review。
    const { task: approvedTask } = await client.rpc("task.approveReview", { taskId: task.id });
    const approvedIntoReview = approvedTask.status === "review" && approvedTask.awaitingHumanReview === false;
    record(
      "B3(§4「task.approveReview」): 人類核可後,任務真正轉進 review 且 awaitingHumanReview 清除",
      approvedIntoReview,
      `status=${approvedTask.status}, awaitingHumanReview=${approvedTask.awaitingHumanReview}`,
    );

    // 對一個沒有在等待核可的任務呼叫 approveReview → 明確拒絕(不是靜默 no-op)。
    let rejectedSecondApprove = false;
    try {
      await client.rpc("task.approveReview", { taskId: task.id });
    } catch {
      rejectedSecondApprove = true;
    }
    record(
      "B4(task.approveReview 防禦性檢查): 對一個目前沒有在等待核可的任務呼叫 approveReview,被明確拒絕",
      rejectedSecondApprove,
      `rejected=${rejectedSecondApprove}`,
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

  rmDirs([dataDir, homeDir, repoDir]);
}

// =======================================================================
// C:連續 3 次驗收失敗 → 第 4 次直接拒絕、不再呼叫 AcceptanceRunner。用一個
// 會在每次真正執行時對一個 marker 檔案 append 一個字元的指令,決定性驗證
// Runner 是否真的被呼叫(而不只是比對錯誤文字)。
// =======================================================================
async function testConsecutiveFailureShortCircuit() {
  const gitVersion = runGitSync(["--version"], process.cwd());
  if (gitVersion.status !== 0) {
    record("C: 連續失敗短路(git 不可用,整個步驟略過)", false, `找不到可用的 git 執行檔: ${gitVersion.error ?? gitVersion.stderr}`);
    return;
  }

  const dataDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-gate-c-data-"));
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-gate-c-home-"));
  const repoDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-gate-c-repo-"));
  const markerPath = path.join(os.tmpdir(), `deskmony-e2e-gate-c-marker-${randomUUID().slice(0, 8)}.txt`);

  let core, client;
  try {
    initGitRepo(repoDir);
    core = startCore({ port: 4712, dataDir, homeDir, workspaceDir: repoDir });
    await waitForPort("ws://127.0.0.1:4712", 20_000);
    client = new MiniGatewayClient("ws://127.0.0.1:4712");
    await client.connect();

    const { team, worker } = await setupTeamWithWorker(client, "E2E Gate Team C", repoDir, "Worker");

    // 每次真正執行都會對 markerPath append 一個 "x",然後 exit 1(永遠失敗)。
    // 外層用雙引號包住 `node -e "..."`(cmd.exe/sh 都支援,比照上面 A2 測試
    // 已驗證可行的寫法),內層 JS 字串用單引號——Node 的 fs API 在 Windows
    // 上也接受正斜線路徑,轉成正斜線可以完全避開反斜線轉義問題。
    const markerPathForCommand = markerPath.split(path.sep).join("/");
    const failCmd = `node -e "require('fs').appendFileSync('${markerPathForCommand}', 'x'); process.exit(1)"`;
    const task = await createInProgressTask(client, team.id, worker.id, "C-always-fail", { commands: [failCmd] });

    const readMarkerCount = () => {
      if (!existsSync(markerPath)) return 0;
      return readFileSync(markerPath, "utf8").length;
    };

    const outcomes = [];
    for (let i = 0; i < 4; i++) {
      const outcome = await client.rpc("message.reportStatus", {
        teamId: team.id,
        fromMemberId: worker.id,
        status: "review",
        taskId: task.id,
      });
      outcomes.push({ attempt: i + 1, content: outcome.message.content, markerCountAfter: readMarkerCount() });
    }

    const { task: taskAfter } = await client.rpc("task.get", { taskId: task.id });
    const stillInProgress = taskAfter.status === "in-progress";

    // 前 3 次都應該真的跑過 Runner(marker 遞增到 3),第 4 次應該完全沒有
    // 再遞增(仍是 3)——這是「不再呼叫 AcceptanceRunner」的決定性證據,不只是
    // 比對錯誤文字。
    const ranExactlyThreeTimes = outcomes[2].markerCountAfter === 3 && outcomes[3].markerCountAfter === 3;

    const thirdMentionsEscalation =
      outcomes[2].content.includes("已連續失敗") && outcomes[2].content.includes("已通知人類介入");
    const fourthMentionsShortCircuit =
      outcomes[3].content.includes("已停止自動重跑驗收") || outcomes[3].content.includes("為避免無謂消耗資源");

    record(
      "C(§3「連續 3 次驗收失敗 → 直接拒絕不再跑 Runner」): 前 3 次確實各執行一次驗收(marker 遞增至 3),第 4 次不再執行(marker 仍是 3),任務全程維持 in-progress,第 3 次的回應提及已通知人類、第 4 次提及已停止自動重跑",
      stillInProgress && ranExactlyThreeTimes && thirdMentionsEscalation && fourthMentionsShortCircuit,
      `markerCounts=${outcomes.map((o) => o.markerCountAfter).join(",")}, status=${taskAfter.status}, attempt3=${outcomes[2].content}, attempt4=${outcomes[3].content}`,
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

  rmDirs([dataDir, homeDir, repoDir]);
  try {
    rmSync(markerPath, { force: true });
  } catch {
    // ignore
  }
}

// =======================================================================
// D:人類經 task.updateStatus 走同一個 in-progress→review 轉換 → 不受閘影響
// (即使任務沒有 acceptance 也直接放行,維持諮詢);agent 仍無法透過
// report_status 把任務變成 done(既有把關點不可退步)。
// =======================================================================
async function testHumanPathUnaffectedAndDoneStillBlocked() {
  const gitVersion = runGitSync(["--version"], process.cwd());
  if (gitVersion.status !== 0) {
    record("D: 人類路徑不受閘影響(git 不可用,整個步驟略過)", false, `找不到可用的 git 執行檔: ${gitVersion.error ?? gitVersion.stderr}`);
    return;
  }

  const dataDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-gate-d-data-"));
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-gate-d-home-"));
  const repoDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-gate-d-repo-"));

  let core, client;
  try {
    initGitRepo(repoDir);
    core = startCore({ port: 4713, dataDir, homeDir, workspaceDir: repoDir });
    await waitForPort("ws://127.0.0.1:4713", 20_000);
    client = new MiniGatewayClient("ws://127.0.0.1:4713");
    await client.connect();

    const { team, worker } = await setupTeamWithWorker(client, "E2E Gate Team D", repoDir, "Worker");

    // D1:沒有 acceptance 的任務,人類直接呼叫 task.updateStatus(→review)
    // ——不經過 tryApplyReportStatus,閘完全不介入,應該直接成功。
    const task = await createInProgressTask(client, team.id, worker.id, "D-human-path", undefined);
    const { task: afterHumanUpdate } = await client.rpc("task.updateStatus", { taskId: task.id, status: "review" });
    const humanPathSucceeded = afterHumanUpdate.status === "review" && afterHumanUpdate.awaitingHumanReview === false;

    record(
      "D1(§1.1「只擋 agent 路徑」): 人類經 task.updateStatus 把沒有 acceptance 的任務從 in-progress 推進到 review,不受閘影響、不設 awaitingHumanReview,直接成功",
      humanPathSucceeded,
      `status=${afterHumanUpdate.status}, awaitingHumanReview=${afterHumanUpdate.awaitingHumanReview}`,
    );

    // D2:既有把關點——agent 無法經 report_status 把任務標記 done(不論驗收
    // 閘;這條規則在 tryApplyReportStatus 對 "done" 目標的檢查更早,根本不會
    // 走到 S5 這輪新增的 review 分支)。
    await client.rpc("task.updateStatus", { taskId: task.id, status: "merging" });
    const doneOutcome = await client.rpc("message.reportStatus", {
      teamId: team.id,
      fromMemberId: worker.id,
      status: "done",
      taskId: task.id,
    });
    const { task: taskAfterDoneAttempt } = await client.rpc("task.get", { taskId: task.id });
    const stillNotDone = taskAfterDoneAttempt.status === "merging";
    const doneMessageMentionsMerge = doneOutcome.message.content.includes("task.merge");

    record(
      "D2(既有把關點不可退步): agent 經 report_status(done) 無法把任務標記完成,錯誤提及需要人類經 task.merge,任務狀態不變",
      stillNotDone && doneMessageMentionsMerge,
      `status=${taskAfterDoneAttempt.status}, content=${doneOutcome.message.content}`,
    );

    // D3:真正完成 —— 人類經 task.merge 才轉 done(既有路徑,回歸測試)。
    const { task: mergedTask } = await client.rpc("task.merge", { taskId: task.id });
    record(
      "D3(既有路徑回歸測試): 人類經 task.merge 才能讓任務真正變成 done",
      mergedTask.status === "done",
      `status=${mergedTask.status}`,
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

  rmDirs([dataDir, homeDir, repoDir]);
}

// =======================================================================
async function main() {
  if (!existsSync(CORE_ENTRY)) {
    console.error(`找不到 ${CORE_ENTRY} —— 請先執行 pnpm build`);
    process.exit(1);
  }

  console.log("=== S5 e2e:A(§1.2 有 acceptance ——通過自動放行/失敗拒絕)===");
  await testAcceptanceRunGate();

  console.log("\n=== S5 e2e:B(§1.2 無 acceptance ——掛起等人類核可,task.approveReview)===");
  await testNoAcceptanceHumanApproval();

  console.log("\n=== S5 e2e:C(§3 連續 3 次驗收失敗 → 第 4 次直接拒絕,不再跑 Runner)===");
  await testConsecutiveFailureShortCircuit();

  console.log("\n=== S5 e2e:D(§1.1 人類路徑不受閘影響;既有「done 需人類合併」把關點不可退步)===");
  await testHumanPathUnaffectedAndDoneStillBlocked();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n\n========== 總結:${results.length - failed.length}/${results.length} 通過 ==========`);
  for (const r of failed) {
    console.log(`  FAIL: ${r.name}`);
  }
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[e2e-lead-gate] fatal:", err);
  process.exit(1);
});
