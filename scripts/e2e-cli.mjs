#!/usr/bin/env node
/**
 * scripts/e2e-cli.mjs
 *
 * `apps/cli`(`deskmony` 指令列介面)端到端驗證,對應
 * docs/LAYER-3-hld/cli_hld.md §9(驗收清單,十項)。§9 原文只說「必須涵蓋」
 * 十項,底下逐一對應成一個 `record()`,好讓「第幾項對到哪一行程式碼」一眼
 * 看完。
 *
 * 與其餘 e2e 套件最大的不同:其餘套件都是**直接**當 gateway 的 client(自己
 * 建 WS 連線、自己送 RPC),這支測的是**子程序**——用 `spawnSync` 執行編譯後
 * 的 `apps/cli/dist/bin.js`,像使用者在終端機打 `node apps/cli/dist/bin.js
 * ...` 一樣,斷言真正的 stdout/stderr/退出碼。理由見 HLD §1:CLI 不是第二個
 * orchestrator,它只是 gateway 的又一個 client——如果不透過真正的子程序邊界
 * 測,像「有沒有印出 ANSI 色碼」「stdin 讀 CRLF 對不對」「退出碼是不是
 * `process.exitCode` 設對了」這幾件事根本測不到,直接 import CLI 的原始碼
 * 函式來呼叫,驗證的是完全不同的東西。
 *
 * ⚠️ 兩個容易踩的陷阱(已經在 HLD §13 用一次性探針對真的 core 查證過,這裡
 * 直接沿用結論,不是紙上推論):
 *
 *   1. §13.4:**權限被拒絕後,agent 一樣送出 `completed` 事件,不是
 *      `error`。** 案例 7 因此是整支測試裡最重要的一項——它是刻意設計來抓
 *      「只看事件文字就 exit 0」這種錯誤實作的陷阱,斷言的重點永遠是
 *      `spawnSync(...).status`(見下面 `runCli()` 的回傳值),絕不是「stderr
 *      裡有沒有某段文字」反推出來的退出碼。任務描述原話:「Always capture
 *      the real exit code from spawnSync(...).status. Never infer it.」
 *      這支檔案裡每一個 `record()` 的判斷式都直接比對 `result.status`,沒有
 *      任何一處用文字內容去猜退出碼。
 *   2. 案例 4(token 錯誤):**斷言的是「輸出裡不得出現 token 字串」,不是
 *      「有沒有印出某種通用錯誤訊息」**——這是一個真正的資安要求(把使用者
 *      打錯的 token 印回終端機/log,是資訊外洩,即使那個 token 本來就是錯
 *      的也一樣:很多使用者會把「錯誤的那個」跟「正確的那個」記混,或者
 *      log 本身就可能被別人看到)。
 *
 * ---- port 配置 ----------------------------------------------------------
 *
 * `grep -noE "port: ?[0-9]{4}|PORT = [0-9]{4}" scripts/*.mjs` 過一輪既有
 * e2e,佔用的區段是:4319-4334(e2e-gateway)、4341-4344(auto-mode-yolo)、
 * 4351(notification)、4360-4364(cost-governor)、4370-4376(message-budget)、
 * 4380-4389(crash-recovery)、4700-4705(agent-lifecycle)、4710-4713
 * (lead-gate)、5321(session-subagents)。4720/4721 兩個都不在其中,選用:
 *   - 4720:一般(無認證)core,案例 5/6/7/8/9/10 共用。
 *   - 4721:啟用 `DESKMONY_AUTH_TOKEN` 的 core,只給案例 4 用。
 * （`run-e2e.mjs` 依序、不平行執行各支套件,port 其實不必跨檔案互斥;獨立
 * 挑一段空的純粹是比照既有慣例,方便單獨執行這支檔案時不會跟其他仍在跑的
 * 套件衝突。）
 *
 * 前置需求:`pnpm build` 已跑過(`apps/cli/dist/bin.js` 存在且是最新的——見
 * scripts/lib/require-fresh-build.mjs 的 `@deskmony/cli` 項目)。
 * 用法:node scripts/e2e-cli.mjs
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WRITE_FILE_PREFIX } from "./fake-acp-agent.mjs";
import { requireFreshBuild } from "./lib/require-fresh-build.mjs";

// 2026-09-04(稽核修補)引入的守門員,2026-09-09 補上 @deskmony/cli 項目
// ——見 scripts/lib/require-fresh-build.mjs。忘記先 pnpm build 的話,這裡會
// 直接中止,而不是安靜地拿舊版 dist/bin.js 測出一片綠燈。
requireFreshBuild();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const FAKE_AGENT_PATH = path.join(REPO_ROOT, "scripts", "fake-acp-agent.mjs");
const CORE_ENTRY = path.join(REPO_ROOT, "apps", "core", "dist", "index.js");
const CLI_ENTRY = path.join(REPO_ROOT, "apps", "cli", "dist", "bin.js");

/** 見檔頭「port 配置」——4700-4713 已被 agent-lifecycle/lead-gate 佔用。 */
const PORT_MAIN = 4720;
const PORT_AUTH = 4721;

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
// 以下四個 helper(MiniGatewayClient/startCore/waitForPort/killProcessTreeHard)
// 逐字沿用 scripts/e2e-agent-lifecycle.mjs 的既有寫法(已經被其他六支測試
// 驗證過的手法)——這支檔案只用 MiniGatewayClient 做一件事:呼叫
// `profile.create` 建立 CLI 要用的 ACP profile(Phase 1 的 CLI 命令表面刻意
// 不提供 `profile create`,見 apps/cli/src/commands/profile.ts 的檔頭註解),
// 其餘所有動作都改成呼叫真正的 CLI 子程序,不再直接用這個 client 送指令。
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

// =======================================================================
// 執行編譯後的 CLI 本體 —— 這支測試唯一真正的「受測物件」。
// =======================================================================

/**
 * CLI 子程序不需要、也不該繼承開發者終端機裡殘留的 `DESKMONY_*`/`NO_COLOR`
 * ——HLD §2 的優先序是「旗標 > 環境變數 > 預設」,這支測試只透過旗標表達
 * 意圖,刻意把環境變數這個輸入來源整個拔掉,好讓結果不會因為執行測試的機器
 * 環境不同而跟著變。
 */
const STRIPPED_ENV_KEYS = [
  "DESKMONY_URL",
  "DESKMONY_AUTH_TOKEN",
  "DESKMONY_CORE_PORT",
  "DESKMONY_BIND_HOST",
  "DESKMONY_DATA_DIR",
  "DESKMONY_HOME",
  "DESKMONY_WORKSPACE",
  "NO_COLOR",
];
function cleanCliEnv() {
  const env = { ...process.env };
  for (const key of STRIPPED_ENV_KEYS) delete env[key];
  return env;
}

/**
 * `node apps/cli/dist/bin.js <args>` —— **不是** `deskmony` 這個 shim。
 * cli_hld.md §15 已經查證過:這個 repo 裡 `deskmony` 根本不在 PATH 上
 * (pnpm 只在依賴該套件的 package 底下建 `.bin` shim,不會放進 workspace
 * 根目錄),「這支程式本身對不對」跟「安裝流程有沒有把它放上 PATH」是兩個
 * 獨立的關注點——後者是 README/HLD §15 的文件責任,不該混進這支 e2e。
 *
 * 一律用 `.status`(spawnSync 回報的真實退出碼)當判斷依據,絕不用「有沒有
 * 印出某段文字」反推——見檔頭「陷阱 1」的完整說明。
 */
function runCli(args, { input, timeoutMs = 20_000 } = {}) {
  const result = spawnSync(process.execPath, [CLI_ENTRY, ...args], {
    cwd: REPO_ROOT,
    env: cleanCliEnv(),
    input,
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
  });
  return {
    status: result.status,
    signal: result.signal,
    error: result.error,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

// =======================================================================
// 案例 1/2/3(HLD §9):純旗標解析與連線失敗訊息,不需要真的啟動 core。
// =======================================================================
function testCase1VersionAndHelp() {
  const versionResult = runCli(["--version"]);
  const helpResult = runCli(["--help"]);
  // HLD §2 的完整指令表面——逐一比對子字串,而不是整段比對,避免措辭微調
  // 就打斷這支測試(這裡在乎的是「有沒有列出」,不是「排版長怎樣」)。
  const requiredSubstrings = ["chat", "run", "serve", "session list", "session rm", "profile list", "doctor", "config show"];
  const missing = requiredSubstrings.filter((s) => !helpResult.stdout.includes(s));
  const ok = versionResult.status === 0 && helpResult.status === 0 && missing.length === 0;
  record(
    "案例 1(--version / --help → 退出碼 0,--help 列出所有子指令)",
    ok,
    `version.status=${versionResult.status}, help.status=${helpResult.status}, ` +
      `version.stdout=${JSON.stringify(versionResult.stdout.trim())}, help 缺少的子指令=${JSON.stringify(missing)}`,
  );
}

function testCase2UnknownFlag() {
  const result = runCli(["--this-flag-does-not-exist-xyz"]);
  const ok = result.status === 2 && result.stderr.includes("--help");
  record(
    "案例 2(未知旗標 → 退出碼 2,錯誤訊息指向 --help)",
    ok,
    `status=${result.status}, stderr=${JSON.stringify(result.stderr.trim())}`,
  );
}

function testCase3UnreachableUrl() {
  // port 9(歷史上的 discard 服務)在一般開發機/CI runner 上必定沒有東西在
  // 聽,connect.ts 的探測會在 CONNECT_TIMEOUT_MS(5000ms)內以連線被拒收場。
  const result = runCli(["--url", "ws://127.0.0.1:9", "session", "list"], { timeoutMs: 15_000 });
  const ok = result.status === 3 && result.stderr.includes("deskmony serve");
  record(
    "案例 3(連不上的 URL → 退出碼 3,訊息含可執行指引「deskmony serve」)",
    ok,
    `status=${result.status}, stderr=${JSON.stringify(result.stderr.trim())}`,
  );
}

// =======================================================================
// 案例 5/6/7/8/9/10:共用同一個一般(無認證)core + 同一個 ACP profile。
//
// 執行順序刻意是 6 → 5:案例 5(session list --json)的驗收要求「session
// 存在之後,解析出來的物件要通過 SessionSchema」,所以先跑案例 6(run
// "hello")造出一個 session,案例 5 才有東西可驗證,而不是驗證一個空陣列。
// =======================================================================
async function testMainCoreCases() {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-cli-main-data-"));
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-cli-main-home-"));
  const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-cli-main-ws-"));
  const url = `ws://127.0.0.1:${PORT_MAIN}`;

  let core;
  let gwClient;
  try {
    core = startCore({ port: PORT_MAIN, dataDir, homeDir, workspaceDir });
    await waitForPort(url, 20_000);
    gwClient = new MiniGatewayClient(url);
    await gwClient.connect();
    const profile = await createAcpProfile(gwClient, "E2E CLI ACP Profile", workspaceDir);

    const commonArgs = ["--url", url, "--profile", profile.id, "--cwd", workspaceDir, "--timeout", "15000"];

    // ---- 案例 6:run "hello" -------------------------------------------
    const runHello = runCli([...commonArgs, "run", "hello"], { timeoutMs: 30_000 });
    record(
      '案例 6(run "hello" → 退出碼 0,stdout 含 fake agent 的固定回覆)',
      runHello.status === 0 && runHello.stdout.includes("Hello from fake ACP agent"),
      `status=${runHello.status}, stdout=${JSON.stringify(runHello.stdout.slice(0, 200))}`,
    );

    // ---- 案例 5:session list --json,驗證每一行都通過 SessionSchema -------
    // 比照既有 e2e 慣例(見 scripts/e2e-gateway.mjs 對 packages/shared/dist/*
    // 的載入方式):動態 import 編譯產物,不是 import "@deskmony/shared"
    // ——這個 repo 的 pnpm workspace 沒有把任何 @deskmony/* 套件 hoist 到
    // 根目錄 node_modules,scripts/ 底下用 bare specifier 會直接找不到模組。
    const sessionModUrl = pathToFileURL(path.join(REPO_ROOT, "packages", "shared", "dist", "session.js")).href;
    const { SessionSchema } = await import(sessionModUrl);

    const listResult = runCli(["--url", url, "session", "list", "--json"], { timeoutMs: 15_000 });
    const lines = listResult.stdout
      .replace(/\r/g, "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    let allJson = true;
    let allValid = true;
    const invalidReasons = [];
    for (const line of lines) {
      let obj;
      try {
        obj = JSON.parse(line);
      } catch (err) {
        allJson = false;
        invalidReasons.push(`JSON.parse 失敗: ${String(err)}`);
        continue;
      }
      const parsed = SessionSchema.safeParse(obj);
      if (!parsed.success) {
        allValid = false;
        invalidReasons.push(parsed.error.message);
      }
    }
    record(
      "案例 5(session list --json → 每行合法 JSON,且解析後的物件通過 SessionSchema)",
      listResult.status === 0 && allJson && allValid && lines.length > 0,
      `status=${listResult.status}, 行數=${lines.length}, allJson=${allJson}, allValid=${allValid}` +
        (invalidReasons.length > 0 ? `, 原因=${JSON.stringify(invalidReasons.slice(0, 3))}` : ""),
    );

    // ---- 案例 7:run 遇到 ACP_WRITE_FILE 的 permission-request,非互動一律
    //      拒絕 → 退出碼 4,且檔案真的沒有落地(HLD §13.4 的陷阱)-----------
    // 目標路徑刻意放在 session 的 workingDir(= workspaceDir)之下,避免誤觸
    // hard-deny 的「worktree 外寫入」分類(那會走一條完全不同的拒絕路徑,
    // 不是這裡要驗證的「CLI 在非互動模式下自動拒絕 permission-request」)——
    // 比照既有 e2e(e2e-policy-engine.mjs 等)的 posixPath 轉換慣例。
    const targetPath = path.join(workspaceDir, "e2e-cli-should-not-exist.txt");
    const posixPath = targetPath.split(path.sep).join("/");
    const writePrompt = `${WRITE_FILE_PREFIX}${JSON.stringify({ path: posixPath, content: "hi" })}`;
    const runWrite = runCli([...commonArgs, "run", writePrompt], { timeoutMs: 30_000 });
    record(
      "案例 7(run 遇到 permission-request 且非互動 → 退出碼 4,被拒工具印在 stderr,檔案未落地;不是靠事件文字反推)",
      runWrite.status === 4 && runWrite.stderr.includes("Write file") && !existsSync(targetPath),
      `status=${runWrite.status}, fileExists=${existsSync(targetPath)}, stderr=${JSON.stringify(runWrite.stderr.slice(0, 300))}`,
    );

    // ---- 案例 8:run - 從 stdin 讀(內含 CRLF)→ 與案例 6 同樣結果 ----------
    // 用意:驗證 `readPromptFromStdin()` 的 `.replace(/\r\n/g, "\n")` 不會把
    // 一個多行、CRLF 結尾的 prompt 讀壞——fake agent 的預設回覆(handleEcho）
    // 不看 prompt 內容,所以這裡驗證的是「stdin/CRLF 沒有讓整條路徑掛掉」,
    // 不是「內容被逐字元比對」。
    const stdinPrompt = "hello\r\nfrom\r\ne2e-cli-stdin\r\n";
    const runStdin = runCli([...commonArgs, "run", "-"], { timeoutMs: 30_000, input: stdinPrompt });
    record(
      "案例 8(run - 從 stdin 讀,CRLF 換行 → 與案例 6 同樣結果)",
      runStdin.status === 0 && runStdin.stdout.includes("Hello from fake ACP agent"),
      `status=${runStdin.status}, stdout=${JSON.stringify(runStdin.stdout.slice(0, 200))}`,
    );

    // ---- 案例 9:--no-color → stdout/stderr 完全不含 ESC(0x1b)------------
    // spawnSync 的管線本來就不是 TTY,resolveColor() 預設就會關閉顏色,所以
    // 這項斷言的「防守方向」其實是防未來有人在別處誤開色彩(例如某個分支
    // 忘記檢查 --no-color、改成無條件輸出 SGR 碼)——照著任務描述的字面要求
    // 斷言,不做更多。
    const runNoColor = runCli([...commonArgs, "--no-color", "run", "hello-nocolor-check"], { timeoutMs: 30_000 });
    const hasEsc = runNoColor.stdout.includes("\x1b") || runNoColor.stderr.includes("\x1b");
    record(
      "案例 9(--no-color → stdout 與 stderr 都不含 0x1b)",
      runNoColor.status === 0 && !hasEsc,
      `status=${runNoColor.status}, hasEsc=${hasEsc}`,
    );

    // ---- 案例 10:doctor → 退出碼恆為 0,輸出提到 gateway 連線狀態 ---------
    const doctorResult = runCli(["--url", url, "doctor"]);
    record(
      "案例 10(doctor → 退出碼 0,輸出含 gateway 連線狀態)",
      doctorResult.status === 0 && doctorResult.stdout.includes("連線狀態") && doctorResult.stdout.includes("已連線"),
      `status=${doctorResult.status}, stdout=${JSON.stringify(doctorResult.stdout.slice(0, 300))}`,
    );

    gwClient.close();
    await killProcessTreeHard(core);
    core = null;
  } catch (err) {
    record("案例 5/6/7/8/9/10(共用主 core)執行過程發生未預期錯誤", false, String(err));
  } finally {
    gwClient?.close();
    if (core) await killProcessTreeHard(core);
  }

  rmDirs([dataDir, homeDir, workspaceDir]);
}

// =======================================================================
// 案例 4:token 錯誤 → 退出碼 3,且 token 字串絕不能出現在輸出裡。獨立的
// 第二個、啟用 DESKMONY_AUTH_TOKEN 的 core——不能沿用上面的一般 core。
// =======================================================================
async function testCase4WrongToken() {
  const REAL_TOKEN = "e2e-cli-real-secret-9f3a1c";
  const WRONG_TOKEN = "e2e-cli-wrong-token-1b2c7d";
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-cli-auth-data-"));
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-cli-auth-home-"));
  const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-cli-auth-ws-"));
  const url = `ws://127.0.0.1:${PORT_AUTH}`;

  let core;
  try {
    core = startCore({ port: PORT_AUTH, dataDir, homeDir, workspaceDir, extraEnv: { DESKMONY_AUTH_TOKEN: REAL_TOKEN } });
    await waitForPort(url, 20_000);

    const result = runCli(["--url", url, "--token", WRONG_TOKEN, "session", "list"], { timeoutMs: 15_000 });
    const combined = `${result.stdout}\n${result.stderr}`;
    const noTokenLeak = !combined.includes(REAL_TOKEN) && !combined.includes(WRONG_TOKEN);

    record(
      "案例 4(錯誤的 --token 對上啟用認證的 core → 退出碼 3,且輸出不得出現任何 token 字串)",
      result.status === 3 && noTokenLeak,
      `status=${result.status}, tokenLeak=${!noTokenLeak}, stderr=${JSON.stringify(result.stderr.trim())}`,
    );

    await killProcessTreeHard(core);
    core = null;
  } catch (err) {
    record("案例 4 執行過程發生未預期錯誤", false, String(err));
  } finally {
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
  if (!existsSync(CLI_ENTRY)) {
    console.error(`找不到 ${CLI_ENTRY} —— 請先執行 pnpm build`);
    process.exit(1);
  }

  console.log("=== CLI e2e:案例 1-3(純旗標解析/連線失敗訊息,不需要 core)===");
  testCase1VersionAndHelp();
  testCase2UnknownFlag();
  testCase3UnreachableUrl();

  console.log("\n=== CLI e2e:案例 5/6/7/8/9/10(真的 headless core + fake ACP agent)===");
  await testMainCoreCases();

  console.log("\n=== CLI e2e:案例 4(token 錯誤,獨立的第二個啟用認證的 core)===");
  await testCase4WrongToken();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n\n========== 總結:${results.length - failed.length}/${results.length} 通過 ==========`);
  for (const r of failed) {
    console.log(`  FAIL: ${r.name}`);
  }
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[e2e-cli] fatal:", err);
  process.exit(1);
});
