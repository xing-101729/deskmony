#!/usr/bin/env node
/**
 * scripts/e2e-agent-lifecycle.mjs
 *
 * S8(agent-lifecycle / Agent 生命週期 + 外部記憶(檔案層))端到端驗證,對應
 * docs/LAYER-4-detail-design/agent-lifecycle_detail.md §6 檢查清單。
 *
 * 2026-10-02(P1:移除 team/task/看板,見 docs/DECISIONS.md §H):這支原本的
 * A–F 六組測試(lifecycle 推導、任務指派時自動 spawn/dispose、spawn 失敗回滾、
 * Mailbox 補投、persistent 成員的 context checkpoint 重啟、長命成員收訊息自動
 * 建 session)**全部是 team/task 專屬機制**,隨功能一併移除。這裡只留下仍然成立、
 * 與 team 無關的那一塊:§3.1「外部記憶(檔案層)」——任何 session 啟動時,
 * `<workingDir>/.deskmony/notes/` 都會自動建立並放一份 `team.md` 佔位檔,而且
 * **絕不覆蓋**使用者/agent 已經寫過的內容。
 *
 * 沿用 scripts/e2e-crash-recovery.mjs 的手法(真實 WS Gateway + fake ACP agent,
 * 決定性、不依賴真實模型行為),獨立可執行,不 import 其他 e2e 腳本。
 *
 * 涵蓋:
 *   A. §3.1:session.create 後,workingDir 底下出現 `.deskmony/notes/team.md`
 *      (內容為佔位文字),session 正常進入 idle。
 *   B. §3.1「只指路、不碰內容」:`.deskmony/notes/team.md` 已存在且有使用者內容時,
 *      再開 session 不會覆蓋它。
 *
 * 前置需求:`pnpm build` 已跑過。
 * 用法:node scripts/e2e-agent-lifecycle.mjs
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { requireFreshBuild } from "./lib/require-fresh-build.mjs";
import { e2eProvidersEnv, FAKE_ACP } from "./lib/e2e-providers.mjs";

// 2026-09-04(稽核修補):在啟動 core 之前確認 dist/ 不比 src/ 舊。
// 這支 e2e 測的是編譯產物,忘記先 pnpm build 的話會安靜地驗證舊程式碼並全綠
// —— 見 scripts/lib/require-fresh-build.mjs 的完整說明。
requireFreshBuild();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
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

function startCore({ port, dataDir, homeDir, workspaceDir, extraEnv }) {
  const env = {
    ...process.env,
    DESKMONY_CORE_PORT: String(port),
    DESKMONY_DATA_DIR: dataDir,
    DESKMONY_HOME: homeDir,
    DESKMONY_WORKSPACE: workspaceDir,
    // 2026-10-02(P2:移除 profile):fake 後端經 `DESKMONY_E2E_EXTRA_PROVIDERS` 注入(見 lib/e2e-providers.mjs)。
    ...e2eProvidersEnv(),
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


// =======================================================================
// A + B:§3.1 外部記憶(檔案層)——`.deskmony/notes/` 自動建立,且不覆蓋既有內容。
// =======================================================================
async function testNotesDir() {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-life-data-"));
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-life-home-"));
  const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-life-ws-"));
  const projectA = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-life-proj-a-"));
  const projectB = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-life-proj-b-"));

  let core, client;
  try {
    core = startCore({ port: 4700, dataDir, homeDir, workspaceDir });
    await waitForPort("ws://127.0.0.1:4700", 20_000);
    client = new MiniGatewayClient("ws://127.0.0.1:4700");
    await client.connect();

    // ---- A ---------------------------------------------------------------
    const notesPathA = path.join(projectA, ".deskmony", "notes", "team.md");
    const existedBefore = existsSync(notesPathA);
    const { session: sessionA } = await client.rpc("session.create", {
      providerId: FAKE_ACP,
      workingDir: projectA,
      title: "notes-A",
    });
    const createdA = existsSync(notesPathA);
    const contentA = createdA ? readFileSync(notesPathA, "utf8") : "";
    const { sessions } = await client.rpc("session.list", {});
    const listedA = sessions.find((s) => s.id === sessionA.id);
    record(
      "A(§3.1 `.deskmony/notes/` 自動建立): session.create 後 workingDir 底下出現 .deskmony/notes/team.md(佔位內容),session 正常建立",
      !existedBefore && createdA && contentA.includes("團隊筆記") && Boolean(listedA) && listedA.status === "idle",
      `path=${notesPathA}, existedBefore=${existedBefore}, created=${createdA}, status=${listedA?.status}`,
    );

    // ---- B ---------------------------------------------------------------
    const notesDirB = path.join(projectB, ".deskmony", "notes");
    mkdirSync(notesDirB, { recursive: true });
    const notesPathB = path.join(notesDirB, "team.md");
    const customContent = "# 我自己寫的筆記\n\n不要被覆蓋。\n";
    writeFileSync(notesPathB, customContent, "utf8");
    await client.rpc("session.create", { providerId: FAKE_ACP, workingDir: projectB, title: "notes-B" });
    const afterB = readFileSync(notesPathB, "utf8");
    record(
      "B(§3.1 只指路、不碰內容): team.md 已存在且有內容時,再開 session 不會覆蓋它",
      afterB === customContent,
      `unchanged=${afterB === customContent}`,
    );

    client.close();
    await killProcessTreeHard(core);
    core = null;
  } catch (err) {
    record("A/B 執行過程發生未預期錯誤", false, String(err));
  } finally {
    client?.close();
    if (core) await killProcessTreeHard(core);
  }

  rmDirs([dataDir, homeDir, workspaceDir, projectA, projectB]);
}

// =======================================================================
async function main() {
  if (!existsSync(CORE_ENTRY)) {
    console.error(`找不到 ${CORE_ENTRY} —— 請先執行 pnpm build`);
    process.exit(1);
  }

  console.log("=== S8 e2e:A/B(§3.1 外部記憶(檔案層):notes 自動建立、不覆蓋既有內容)===");
  await testNotesDir();

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
