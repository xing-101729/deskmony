#!/usr/bin/env node
/**
 * scripts/e2e-agent-catalog.mjs
 *
 * 2026-10-02(P2「移除 profile」)新增,對應 docs/LAYER-4-detail-design/simplify-agents-sessions_detail.md
 * §P2.2/§P2.3/§P2.7:session 直接以「偵測到的 agent(providerId)」建立,不再有 profile。
 *
 * **為什麼這支是獨立的決定性 e2e(而不只是加在 e2e-gateway.mjs)**:`e2e-gateway.mjs` 需要真實 Claude 憑證、
 * 不在 `pnpm test` 裡(見 scripts/run-e2e.mjs 檔頭);而 §P2.7 要求的五個新斷言——含需要「停 core → 重啟 →
 * 續接重建」與「舊 schema DB → 啟動遷移」的兩個——全部都能用 fake backend 決定性地驗證,放在會被 `pnpm test`/CI
 * 跑到的地方才有意義。(§P2.7 的 #1/#2/#5 也同步加在 e2e-gateway.mjs 的步驟 36,那支是人工跑的。)
 *
 * 涵蓋:
 *   A. `AgentCatalog` 單元測試(直接 import 編譯產物,不啟動 core):provider → 啟動規格的映射(各 software)、
 *      找不到/未安裝/已停用/custom-pty 已移除的錯誤碼、model/effort 的忽略規則、偵測快取的等待語意
 *      (不需要偵測的 provider 不被拖慢)、`DESKMONY_E2E_EXTRA_PROVIDERS` 的解析(壞掉的 JSON 只 console.error、
 *      與內建重複的 id 被略過)、`buildLaunchSpecForSession()` 的退路(provider 不存在 → 用 session 存的 launch_*)。
 *   B. 即時 e2e(§P2.7 #1 #2 #5 + 安全):`session.create({providerId:"claude-agent-sdk"})` 不需要 profile 就成功、
 *      回傳 `providerId`;不存在的 providerId 回明確錯誤碼 `agent.notFound`;gateway 上 `profile.*` 已不存在(unknown
 *      method);**gateway 不接受任何 command/args**(帶了也被忽略,啟動方式只由 provider 決定);壞掉的
 *      `DESKMONY_E2E_EXTRA_PROVIDERS` 不會讓 core 起不來。
 *   C. 【§P2.7 #3】續接重建:用 ACP provider 建 session → kill -9 core → 重啟 → 接手(`recovery.takeover`,
 *      ACP 後端唯一能重新 spawn 既有 session 的路徑;`recovery.continue` 只支援 claude-agent-sdk)後
 *      `adapterType` 仍是 `acp`(不是 claude-agent-sdk)、`providerId` 不變、新 session 真的能跑;再把 core 重啟成
 *      「provider 已不在偵測清單」(沒設 extras)——接手仍成功,證明退回的是 session 自己存的
 *      `adapterType + launch_command + launch_args`,而且 `agent_profiles` 表完全沒被讀(它根本不存在)。
 *   D. 【§P2.7 #4】舊資料遷移:先用**舊 schema**塞一筆 `agent_profiles` + 指向它的 `sessions`(`provider_id`
 *      欄位不存在)→ 啟動 core → 該 session 的 `providerId`/`launch_*` 已回填;含「profile 缺失 → legacy-unknown」、
 *      「agentOverride 換過 agent 的 session → 不採用 base profile 的 launch(舊設計的既有 bug)」兩個邊界;
 *      `agent_profiles` 的內容完全沒被改動(只讀);再啟動一次遷移冪等。
 *
 * 前置需求:`pnpm build` 已跑過。
 * 用法:node scripts/e2e-agent-catalog.mjs
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { FAKE_ACP_REPLY_CHUNKS } from "./fake-acp-agent.mjs";
import { requireFreshBuild } from "./lib/require-fresh-build.mjs";
import { e2eProvidersEnv, FAKE_ACP, FAKE_OPENCODE, FAKE_PTY, E2E_PROVIDERS_ENV_NAME } from "./lib/e2e-providers.mjs";

// 在啟動 core 之前確認 dist/ 不比 src/ 舊(見 scripts/lib/require-fresh-build.mjs)。
requireFreshBuild();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const CORE_ENTRY = path.join(REPO_ROOT, "apps", "core", "dist", "index.js");
const FAKE_ACP_PATH = path.join(REPO_ROOT, "scripts", "fake-acp-agent.mjs");
// better-sqlite3 不是這個 script 所在目錄的直接依賴,借用 apps/core 已安裝好的那一份(同 e2e-crash-recovery.mjs)。
const BETTER_SQLITE3_PATH = path.join(REPO_ROOT, "apps", "core", "node_modules", "better-sqlite3", "lib", "index.js");
const FAKE_REPLY = FAKE_ACP_REPLY_CHUNKS.join("");

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`\n${ok ? "PASS" : "FAIL"} ${name}`);
  if (detail) console.log(`       ${detail}`);
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
const importDist = (...parts) => import(pathToFileURL(path.join(REPO_ROOT, ...parts)).href);

// =======================================================================
// 共用:gateway client / core 啟停
// =======================================================================
class MiniGatewayClient {
  constructor(url) {
    this.url = url;
    this.pendingRpc = new Map();
    this.events = [];
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
        else pending.reject(Object.assign(new Error(msg.error ?? "unknown gateway error"), { errorCode: msg.errorCode, errorParams: msg.errorParams }));
      }
      return;
    }
    if (msg.kind === "event" && msg.channel === "session-event") this.events.push(msg.payload);
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
          reject(new Error(`等待事件逾時 (${timeoutMs}ms),目前筆數=${this.events.length}`));
        }
      }, 50);
    });
  }

  /** 接手出來的新 session 會先送「摘要」當第一則 prompt——等那一輪結束,再讓測試自己的 prompt 接著跑(否則兩輪的串流文字會混在一起)。 */
  waitFirstTurn(sessionId, timeoutMs = 20_000) {
    return this.waitForEvent((e) => e.sessionId === sessionId && (e.event.type === "completed" || e.event.type === "error"), timeoutMs);
  }

  /** 送一個 prompt,等這一輪 completed/error,回傳這輪串流出來的完整文字與最終事件。 */
  async runPrompt(sessionId, text, timeoutMs = 20_000) {
    const startIdx = this.events.length;
    await this.rpc("session.sendPrompt", { sessionId, prompt: { text } });
    const end = await this.waitForEvent((e) => e.sessionId === sessionId && (e.event.type === "completed" || e.event.type === "error"), timeoutMs, startIdx);
    const reply = this.events
      .slice(startIdx)
      .filter((e) => e.sessionId === sessionId && e.event.type === "message-delta")
      .map((e) => e.event.delta)
      .join("");
    return { final: end.event, reply };
  }
}

/** 啟動 core 子行程;`extraEnv` 排在 e2eProvidersEnv() 之後,可以覆寫(例如設成空字串 = 沒有任何測試 provider)。 */
function startCore({ port, dataDir, homeDir, workspaceDir, extraEnv }) {
  const env = {
    ...process.env,
    DESKMONY_CORE_PORT: String(port),
    DESKMONY_DATA_DIR: dataDir,
    DESKMONY_HOME: homeDir,
    DESKMONY_WORKSPACE: workspaceDir,
    ...e2eProvidersEnv(),
    ...extraEnv,
  };
  const proc = spawn(process.execPath, [CORE_ENTRY], { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  const out = { text: "" };
  proc.stdout.on("data", (chunk) => {
    out.text += chunk.toString();
    process.stdout.write(`[core:${port}] ${chunk}`);
  });
  proc.stderr.on("data", (chunk) => {
    out.text += chunk.toString();
    process.stderr.write(`[core:${port}:err] ${chunk}`);
  });
  return { proc, out };
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

/** 模擬崩潰(kill -9)。 */
async function killHard(core) {
  const proc = core?.proc;
  if (!proc || proc.exitCode !== null || proc.killed) return;
  const exitPromise = new Promise((resolve) => proc.once("exit", resolve));
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
    else proc.kill("SIGKILL");
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

function tmpDirs(prefix) {
  return {
    dataDir: mkdtempSync(path.join(os.tmpdir(), `deskmony-e2e-catalog-${prefix}-data-`)),
    homeDir: mkdtempSync(path.join(os.tmpdir(), `deskmony-e2e-catalog-${prefix}-home-`)),
    workspaceDir: mkdtempSync(path.join(os.tmpdir(), `deskmony-e2e-catalog-${prefix}-ws-`)),
  };
}

async function openSqlite(dataDir) {
  const { default: Database } = await import(pathToFileURL(BETTER_SQLITE3_PATH).href);
  return new Database(path.join(dataDir, "deskmony.db"));
}

// =======================================================================
// A. AgentCatalog 單元測試
// =======================================================================
async function catalogUnitTests() {
  const { AgentCatalog, parseExtraProviders, storedLaunchFromSpec, E2E_EXTRA_PROVIDERS_ENV } = await importDist("apps", "core", "dist", "agents", "agent-catalog.js");
  const shared = await importDist("packages", "shared", "dist", "index.js");

  const detection = [
    { key: "claude-agent-sdk", displayName: "Claude Agent SDK", software: "claude-agent-sdk", installed: true, models: [] },
    { key: "claude-code-cli", displayName: "Claude Code CLI", software: "acp", installed: true, version: "9.9.9", path: "C:\\fake\\claude.exe", models: [] },
    { key: "gemini-cli", displayName: "Gemini", software: "acp", installed: true, path: "C:\\fake\\gemini.cmd", models: [] },
    {
      key: "opencode-cli",
      displayName: "OpenCode",
      software: "opencode",
      installed: true,
      path: "C:\\fake\\opencode.exe",
      models: [{ id: "anthropic/claude-x", label: "claude-x" }],
    },
    { key: "codex-acp", displayName: "Codex", software: "acp", installed: true, path: process.execPath, args: ["C:\\fake\\codex-acp.js"], models: [] },
    { key: "aider-cli", displayName: "Aider", software: "pty", installed: true, path: "C:\\fake\\aider.exe", models: [] },
  ];
  const fakeSettings = (prefs) => {
    const map = new Map(prefs ? [["providerPrefs", JSON.stringify(prefs)]] : []);
    return { get: async (k) => map.get(k), set: async (k, v) => void map.set(k, v) };
  };
  const catalogWith = (opts = {}) => new AgentCatalog(fakeSettings(opts.prefs), { detect: async () => opts.detection ?? detection, extraProvidersJson: opts.extra });
  const code = async (p) => {
    try {
      await p;
      return undefined;
    } catch (err) {
      return err?.code;
    }
  };

  // ---- A1:各 software 的啟動規格映射 ----
  try {
    const c = catalogWith();
    const sdk = await c.buildLaunchSpec("claude-agent-sdk", "opus", "high");
    const sdkNoModel = await c.buildLaunchSpec("claude-agent-sdk");
    const gemini = await c.buildLaunchSpec("gemini");
    const oc = await c.buildLaunchSpec("opencode", "anthropic/claude-x");
    const ocAcp = await c.buildLaunchSpec("opencode-acp");
    const codex = await c.buildLaunchSpec("codex");
    const cli = await c.buildLaunchSpec("claude-cli", "sonnet");
    const cliNoModel = await c.buildLaunchSpec("claude-cli");
    const aider = await c.buildLaunchSpec("aider");
    const ok =
      sdk.software === "claude-agent-sdk" && sdk.providerId === "claude-agent-sdk" && sdk.model === "opus" && sdk.effort === "high" && !sdk.acpConfig && !sdk.ptyConfig &&
      sdkNoModel.model === undefined && sdkNoModel.effort === undefined &&
      gemini.software === "acp" && gemini.acpConfig?.command === "C:\\fake\\gemini.cmd" && JSON.stringify(gemini.acpConfig?.args) === '["--acp"]' &&
      oc.software === "opencode" && oc.opencodeConfig?.command === "C:\\fake\\opencode.exe" && oc.opencodeConfig?.args === undefined && oc.model === "anthropic/claude-x" &&
      ocAcp.software === "acp" && ocAcp.acpConfig?.command === "C:\\fake\\opencode.exe" && JSON.stringify(ocAcp.acpConfig?.args) === '["acp"]' &&
      codex.software === "acp" && codex.acpConfig?.command === process.execPath && JSON.stringify(codex.acpConfig?.args) === JSON.stringify(["C:\\fake\\codex-acp.js"]) &&
      cli.software === "pty" && cli.ptyConfig?.command === "C:\\fake\\claude.exe" && JSON.stringify(cli.ptyConfig?.args) === '["--model","sonnet"]' &&
      cliNoModel.ptyConfig?.args === undefined &&
      aider.software === "pty" && aider.ptyConfig?.command === "C:\\fake\\aider.exe";
    record(
      "A1 AgentCatalog.buildLaunchSpec():claude-agent-sdk 不需 command;gemini/opencode-acp/codex 映射成 acp(帶各自的 args,codex 用偵測到的橋接進入點);opencode 映射成 opencode(args 不覆寫);claude-cli/aider 映射成 pty(claude-cli 的 model 烤進 --model)",
      ok,
      JSON.stringify({ sdk, gemini, oc, ocAcp, codex, cli, aider }),
    );
  } catch (err) {
    record("A1 buildLaunchSpec 映射", false, String(err));
  }

  // ---- A2:錯誤碼 ----
  try {
    const c = catalogWith();
    const missing = await code(c.buildLaunchSpec("不存在的"));
    const customPty = await code(c.buildLaunchSpec("custom-pty")); // 已從 BUILTIN_PROVIDERS 移除(§P2.2)
    const notInstalled = await code(catalogWith({ detection: detection.filter((d) => d.key !== "gemini-cli") }).buildLaunchSpec("gemini"));
    const disabled = await code(catalogWith({ prefs: { gemini: { enabled: false } } }).buildLaunchSpec("gemini"));
    const sdkDisabled = await code(catalogWith({ prefs: { "claude-agent-sdk": { enabled: false } } }).buildLaunchSpec("claude-agent-sdk"));
    record(
      "A2 找不到/custom-pty(已移除)→ agent.notFound;未偵測到 → agent.notInstalled;被停用(含 claude-agent-sdk)→ agent.disabled",
      missing === "agent.notFound" && customPty === "agent.notFound" && notInstalled === "agent.notInstalled" && disabled === "agent.disabled" && sdkDisabled === "agent.disabled",
      `missing=${missing}, custom-pty=${customPty}, notInstalled=${notInstalled}, disabled=${disabled}, sdkDisabled=${sdkDisabled}`,
    );
    record(
      "A2b custom-pty 已不在 BUILTIN_PROVIDERS(新模型的前提是「從電腦找到的 agent」)",
      !shared.BUILTIN_PROVIDERS.some((p) => p.id === "custom-pty"),
      `ids=${JSON.stringify(shared.BUILTIN_PROVIDERS.map((p) => p.id))}`,
    );
  } catch (err) {
    record("A2 錯誤碼", false, String(err));
  }

  // ---- A3:model/effort 的忽略規則 ----
  try {
    const c = catalogWith();
    const codex = await c.buildLaunchSpec("codex", "gpt-whatever", "max"); // supportsModelSelection=false、非 sdk
    const gemini = await c.buildLaunchSpec("gemini", "some-model", "low"); // supportsModelSelection=true 但 effort 只有 sdk
    // 預設 model:opencode 的 `opencode models` 清單沒有任何 isDefault 標記 → 不退回第一項(否則會悄悄換掉使用者的預設)
    const ocDefault = await c.buildLaunchSpec("opencode");
    const withDefault = catalogWith({ prefs: { opencode: { models: [{ id: "a/x", label: "x" }, { id: "a/y", label: "y", isDefault: true }] } } });
    const ocFlagged = await withDefault.buildLaunchSpec("opencode");
    record(
      "A3 不支援選 model 的 provider(codex)忽略 model、非 claude-agent-sdk 忽略 effort;沒給 model 時只用 provider 明確標記 isDefault 的 model(不退回清單第一項)",
      codex.model === undefined && codex.effort === undefined && gemini.model === "some-model" && gemini.effort === undefined &&
        ocDefault.model === undefined && ocFlagged.model === "a/y",
      `codex=${JSON.stringify({ m: codex.model, e: codex.effort })}, gemini=${JSON.stringify({ m: gemini.model, e: gemini.effort })}, ocDefault=${ocDefault.model}, ocFlagged=${ocFlagged.model}`,
    );
  } catch (err) {
    record("A3 model/effort 規則", false, String(err));
  }

  // ---- A4:偵測快取的等待語意 ----
  try {
    let detectCalls = 0;
    const slowDetect = async () => {
      detectCalls++;
      await sleep(700);
      return detection;
    };
    const c = new AgentCatalog(fakeSettings(), { detect: slowDetect });
    c.startBackgroundDetection(); // 不 await、不阻塞
    const t0 = Date.now();
    const sdk = await c.buildLaunchSpec("claude-agent-sdk"); // 不需要偵測結果 → 不該等
    const sdkMs = Date.now() - t0;
    const gemini = await c.buildLaunchSpec("gemini"); // 需要 → 等那一次偵測(不是回錯)
    const geminiMs = Date.now() - t0;
    const redetected = await c.detectAgents(); // 重新偵測 + 更新快取
    record(
      "A4 偵測快取:背景偵測不阻塞;claude-agent-sdk 不等偵測;外部 CLI 的 buildLaunchSpec 會 await 那一次偵測而不是回錯;detectAgents() 重新偵測並回傳",
      sdk.software === "claude-agent-sdk" && sdkMs < 400 && gemini.acpConfig?.command === "C:\\fake\\gemini.cmd" && geminiMs >= 500 && detectCalls === 2 && redetected.length === detection.length,
      `sdkMs=${sdkMs}, geminiMs=${geminiMs}, detectCalls=${detectCalls}`,
    );
  } catch (err) {
    record("A4 偵測快取", false, String(err));
  }

  // ---- A5:DESKMONY_E2E_EXTRA_PROVIDERS 的解析與併入 ----
  try {
    const errors = [];
    const originalError = console.error;
    console.error = (...args) => errors.push(args.join(" "));
    let brokenJson;
    let notArray;
    let mixed;
    try {
      brokenJson = parseExtraProviders("{not json");
      notArray = parseExtraProviders('{"id":"x"}');
      mixed = parseExtraProviders(
        JSON.stringify([
          { id: "e2e-x", label: "X", software: "acp", command: "node", args: ["a.js"] }, // 合法(models/supportsModelSelection/order 省略)
          { id: "e2e-nocommand", label: "N", software: "acp" }, // 缺 command
          { id: "gemini", label: "偷換內建", software: "pty", command: "evil" }, // 與內建重複
          { id: "e2e-badsoftware", label: "B", software: "codex", command: "node" }, // software 不是已註冊的四種
          { id: "e2e-x", label: "重複", software: "acp", command: "node" }, // 與前一個重複
        ]),
      );
    } finally {
      console.error = originalError;
    }
    const empty = parseExtraProviders(undefined);
    const emptyString = parseExtraProviders("  ");
    const c = catalogWith({ extra: JSON.stringify([{ id: "e2e-x", label: "X", software: "acp", command: "node", args: ["a.js"] }]) });
    const available = await c.listAvailable();
    const extra = available.find((p) => p.id === "e2e-x");
    const spec = await c.buildLaunchSpec("e2e-x");
    const summary = (await c.summarizeAvailable()).find((p) => p.id === "e2e-x");
    record(
      "A5 DESKMONY_E2E_EXTRA_PROVIDERS:壞掉的 JSON/非陣列只 console.error 並忽略(不丟例外);缺 command/與內建或彼此重複的 id/software 不合法的元素被略過;合法的併入 catalog 當已安裝 provider,啟動規格帶它的 command/args;摘要不含 command/args",
      brokenJson.length === 0 && notArray.length === 0 && empty.length === 0 && emptyString.length === 0 &&
        mixed.length === 1 && mixed[0].entry.id === "e2e-x" && mixed[0].entry.models.length === 0 && mixed[0].entry.supportsModelSelection === false &&
        errors.length >= 5 &&
        extra?.installed === true && extra?.command === "node" &&
        spec.acpConfig?.command === "node" && JSON.stringify(spec.acpConfig?.args) === '["a.js"]' &&
        Boolean(summary) && !("command" in summary) && !("args" in summary) && E2E_EXTRA_PROVIDERS_ENV === "DESKMONY_E2E_EXTRA_PROVIDERS",
      `mixed=${mixed.length}, errors=${errors.length}, summary=${JSON.stringify(summary)}`,
    );
  } catch (err) {
    record("A5 extra providers 解析", false, String(err));
  }

  // ---- A6:buildLaunchSpecForSession 的退路 ----
  try {
    const c = catalogWith();
    // provider 還在 → 走目錄(model/effort 取自 session)
    const viaCatalog = await c.buildLaunchSpecForSession({ providerId: "gemini", adapterType: "acp" }, {});
    // provider 不存在 → 退回 adapterType + launch_command + launch_args
    const fallback = await c.buildLaunchSpecForSession({ providerId: "legacy-acp", adapterType: "acp", model: "m" }, { command: "C:\\old\\agent.exe", args: ["--x"] });
    // 目錄裡的 software 對不上 session 的 adapterType(目錄版本間改過)→ 也退回 session 存的
    const mismatch = await c.buildLaunchSpecForSession({ providerId: "gemini", adapterType: "pty" }, { command: "C:\\old\\gemini.exe" });
    // claude-agent-sdk 不需要 command,即使 provider 是 legacy-unknown 也能重建
    const sdkLegacy = await c.buildLaunchSpecForSession({ providerId: "legacy-unknown", adapterType: "claude-agent-sdk", model: "opus" }, {});
    // 退路也沒有 → 明確報錯
    const noLaunch = await code(c.buildLaunchSpecForSession({ providerId: "legacy-unknown", adapterType: "acp" }, {}));
    const stored = storedLaunchFromSpec(await c.buildLaunchSpec("gemini"));
    record(
      "A6 buildLaunchSpecForSession():provider 在 → 走目錄;provider 不存在/software 對不上 → 退回 session 存的 launch;claude-agent-sdk 不需要 command;沒有任何退路 → agent.launchInfoMissing;storedLaunchFromSpec 只取 command/args(不含 env)",
      viaCatalog.spec.acpConfig?.command === "C:\\fake\\gemini.cmd" &&
        fallback.spec.software === "acp" && fallback.spec.acpConfig?.command === "C:\\old\\agent.exe" && JSON.stringify(fallback.spec.acpConfig?.args) === '["--x"]' && fallback.spec.model === "m" &&
        mismatch.spec.software === "pty" && mismatch.spec.ptyConfig?.command === "C:\\old\\gemini.exe" &&
        sdkLegacy.spec.software === "claude-agent-sdk" && sdkLegacy.spec.model === "opus" &&
        noLaunch === "agent.launchInfoMissing" &&
        stored.command === "C:\\fake\\gemini.cmd" && JSON.stringify(stored.args) === '["--acp"]',
      JSON.stringify({ viaCatalog: viaCatalog.spec.acpConfig, fallback: fallback.spec.acpConfig, mismatch: mismatch.spec.ptyConfig, noLaunch, stored }),
    );
  } catch (err) {
    record("A6 buildLaunchSpecForSession", false, String(err));
  }
}

// =======================================================================
// B. 即時 e2e:§P2.7 #1 #2 #5 + gateway 不接受 command + 壞掉的 extras 不讓 core 起不來
// =======================================================================
async function gatewayChecks() {
  const dirs = tmpDirs("gw");
  const PORT = 4395;
  let core;
  let client;
  const created = [];
  try {
    core = startCore({ port: PORT, ...dirs });
    await waitForPort(`ws://127.0.0.1:${PORT}`, 20_000);
    client = new MiniGatewayClient(`ws://127.0.0.1:${PORT}`);
    await client.connect();

    // ---- #1 ----
    {
      const res = await client.rpc("session.create", { providerId: "claude-agent-sdk", workingDir: dirs.workspaceDir, title: "B1" }, 30_000);
      created.push(res.session.id);
      const listed = (await client.rpc("session.list", {})).sessions.find((s) => s.id === res.session.id);
      record(
        "B1【§P2.7 #1】session.create({providerId:\"claude-agent-sdk\"}) 不需要任何 profile 就成功,回傳的 session 有 providerId/adapterType,且沒有 agentProfileId;session.list 讀回同樣的值",
        res.session.providerId === "claude-agent-sdk" && res.session.adapterType === "claude-agent-sdk" && !("agentProfileId" in res.session) &&
          listed?.providerId === "claude-agent-sdk" && listed?.adapterType === "claude-agent-sdk",
        `session=${JSON.stringify({ providerId: res.session.providerId, adapterType: res.session.adapterType })}`,
      );
    }

    // ---- #2 ----
    {
      const failures = {};
      for (const providerId of ["不存在的", "custom-pty"]) {
        try {
          await client.rpc("session.create", { providerId, workingDir: dirs.workspaceDir }, 30_000);
          failures[providerId] = { rejected: false };
        } catch (err) {
          failures[providerId] = { rejected: true, code: err.errorCode, params: err.errorParams, message: err.message };
        }
      }
      const sessionsAfter = (await client.rpc("session.list", {})).sessions.length;
      record(
        "B2【§P2.7 #2】session.create 對不存在的 providerId(含已移除的 custom-pty)回明確錯誤碼 agent.notFound(帶 providerId 參數與可讀訊息),且不建立任何 session",
        Object.values(failures).every((f) => f.rejected && f.code === "agent.notFound") &&
          failures["不存在的"].params?.providerId === "不存在的" && failures["不存在的"].message.includes("不存在的") &&
          sessionsAfter === created.length,
        JSON.stringify(failures),
      );
    }

    // ---- #5 ----
    {
      const outcomes = [];
      for (const [method, params] of [["profile.list", {}], ["profile.create", { name: "x", software: "acp", workingDir: "." }], ["profile.delete", { id: "x" }]]) {
        try {
          await client.rpc(method, params);
          outcomes.push({ method, rejected: false });
        } catch (err) {
          outcomes.push({ method, rejected: true, code: err.errorCode });
        }
      }
      record(
        "B3【§P2.7 #5】gateway 上 profile.list/create/delete 已不存在(unknown method → gateway.invalidRequest)",
        outcomes.every((o) => o.rejected && o.code === "gateway.invalidRequest"),
        JSON.stringify(outcomes),
      );
    }

    // ---- gateway 不接受 command/args ----
    {
      const res = await client.rpc(
        "session.create",
        {
          providerId: FAKE_ACP,
          workingDir: dirs.workspaceDir,
          title: "B4",
          command: "definitely-not-a-real-binary-xyz",
          args: ["--evil"],
          acpConfig: { command: "definitely-not-a-real-binary-xyz" },
        },
        30_000,
      );
      created.push(res.session.id);
      const { final, reply } = await client.runPrompt(res.session.id, "hello");
      record(
        "B4 gateway 不接受任何 command/args:session.create 帶 command/args/acpConfig 被忽略,啟動方式只由 provider 決定(session 仍用 fake ACP agent 跑完一輪,回覆是 fake agent 的固定文字)",
        res.session.adapterType === "acp" && res.session.providerId === FAKE_ACP && final.type === "completed" && reply === FAKE_REPLY,
        `adapterType=${res.session.adapterType}, final=${final.type}, reply=${JSON.stringify(reply)}`,
      );
    }

    // ---- 三個 fake provider 的 software 映射 ----
    {
      const pty = await client.rpc("session.create", { providerId: FAKE_PTY, workingDir: dirs.workspaceDir, title: "B5-pty" }, 30_000);
      const oc = await client.rpc("session.create", { providerId: FAKE_OPENCODE, workingDir: dirs.workspaceDir, title: "B5-opencode", model: "fake/model-a" }, 30_000);
      created.push(pty.session.id, oc.session.id);
      record(
        "B5 fake provider 的 software 映射:e2e-fake-pty → pty、e2e-fake-opencode → opencode(帶 model);session 記下 providerId 與 model",
        pty.session.adapterType === "pty" && pty.session.providerId === FAKE_PTY && oc.session.adapterType === "opencode" && oc.session.model === "fake/model-a",
        `pty=${pty.session.adapterType}, opencode=${oc.session.adapterType}/${oc.session.model}`,
      );
    }

    for (const id of created) {
      try {
        await client.rpc("session.delete", { sessionId: id });
      } catch {
        // ignore
      }
    }
  } catch (err) {
    record("B 即時 gateway 檢查執行過程發生未預期錯誤", false, String(err));
  } finally {
    client?.close();
    await killHard(core);
  }

  // ---- 壞掉的 DESKMONY_E2E_EXTRA_PROVIDERS 不會讓 core 起不來 ----
  let core2;
  let client2;
  try {
    core2 = startCore({ port: PORT + 1, ...dirs, extraEnv: { [E2E_PROVIDERS_ENV_NAME]: "{this is not json" } });
    await waitForPort(`ws://127.0.0.1:${PORT + 1}`, 20_000);
    client2 = new MiniGatewayClient(`ws://127.0.0.1:${PORT + 1}`);
    await client2.connect();
    const sdk = await client2.rpc("session.create", { providerId: "claude-agent-sdk", workingDir: dirs.workspaceDir }, 30_000);
    let fakeCode;
    try {
      await client2.rpc("session.create", { providerId: FAKE_ACP, workingDir: dirs.workspaceDir }, 30_000);
    } catch (err) {
      fakeCode = err.errorCode;
    }
    record(
      "B6 DESKMONY_E2E_EXTRA_PROVIDERS 壞掉(不是合法 JSON):core 仍然正常啟動(只 console.error),內建 provider 照常可用,測試 provider 不存在(agent.notFound)",
      Boolean(sdk.session.id) && fakeCode === "agent.notFound" && core2.out.text.includes("不是合法的 JSON"),
      `sdkSession=${sdk.session.id}, fakeCode=${fakeCode}, 有錯誤訊息=${core2.out.text.includes("不是合法的 JSON")}`,
    );
  } catch (err) {
    record("B6 壞掉的 extras 不讓 core 起不來", false, String(err));
  } finally {
    client2?.close();
    await killHard(core2);
  }

  rmDirs(Object.values(dirs));
}

// =======================================================================
// C. 【§P2.7 #3】續接重建
// =======================================================================
async function rebuildAfterRestart() {
  const dirs = tmpDirs("rebuild");
  const P = 4397;
  let coreA;
  let coreB;
  let coreC;
  let client;
  try {
    // ---- 1) core A:用 ACP provider 建兩個 session,各跑一輪,然後 kill -9 ----
    coreA = startCore({ port: P, ...dirs });
    await waitForPort(`ws://127.0.0.1:${P}`, 20_000);
    client = new MiniGatewayClient(`ws://127.0.0.1:${P}`);
    await client.connect();
    const s1 = (await client.rpc("session.create", { providerId: FAKE_ACP, workingDir: dirs.workspaceDir, title: "C-takeover-1" }, 30_000)).session;
    const s2 = (await client.rpc("session.create", { providerId: FAKE_ACP, workingDir: dirs.workspaceDir, title: "C-takeover-2" }, 30_000)).session;
    for (const s of [s1, s2]) await client.runPrompt(s.id, "some prior work");
    client.close();
    await killHard(coreA);
    coreA = null;

    // session 自己的資料已存好 launch 資訊(不含 env)
    {
      const db = await openSqlite(dirs.dataDir);
      const row = db.prepare("SELECT provider_id, adapter_type, launch_command, launch_args, agent_profile_id FROM sessions WHERE id = ?").get(s1.id);
      const profilesTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_profiles'").get();
      db.close();
      record(
        "C0 新 session 自帶啟動資訊:provider_id/adapter_type/launch_command/launch_args 都已寫入(launch_args 是 JSON 陣列),全新安裝沒有 agent_profiles 表;舊的 agent_profile_id 欄位(NOT NULL,無法改約束)只放 providerId",
        row?.provider_id === FAKE_ACP && row?.adapter_type === "acp" && row?.launch_command === process.execPath &&
          JSON.stringify(JSON.parse(row?.launch_args ?? "null")) === JSON.stringify([FAKE_ACP_PATH]) && row?.agent_profile_id === FAKE_ACP && !profilesTable,
        JSON.stringify(row),
      );
    }

    // ---- 2) core B(同樣的 extras):接手 → 仍是 acp ----
    coreB = startCore({ port: P + 1, ...dirs });
    await waitForPort(`ws://127.0.0.1:${P + 1}`, 20_000);
    client = new MiniGatewayClient(`ws://127.0.0.1:${P + 1}`);
    await client.connect();
    const recoveryList = (await client.rpc("recovery.list", {})).sessions;
    const info1 = recoveryList.find((r) => r.sessionId === s1.id);
    const takeover1 = (await client.rpc("recovery.takeover", { sessionId: s1.id }, 40_000)).session;
    await client.waitFirstTurn(takeover1.id);
    const run1 = await client.runPrompt(takeover1.id, "continue the work");
    record(
      "C1【§P2.7 #3】重啟後接手(recovery.takeover):新 session 的 adapterType 仍是 acp(不是 claude-agent-sdk)、providerId 不變、真的能跑一輪(回覆是 fake ACP agent 的固定文字);復原視圖顯示的 agent 名稱是 provider label",
      takeover1.adapterType === "acp" && takeover1.providerId === FAKE_ACP && takeover1.id !== s1.id &&
        run1.final.type === "completed" && run1.reply === FAKE_REPLY && info1?.agentLabel === "E2E Fake ACP" && info1?.canContinue === false,
      `takeover.adapterType=${takeover1.adapterType}, providerId=${takeover1.providerId}, reply=${JSON.stringify(run1.reply)}, agentLabel=${info1?.agentLabel}`,
    );
    // ACP 後端不支援「繼續(保有記憶)」,明確拒絕(沿用既有保證)
    let continueCode;
    try {
      await client.rpc("recovery.continue", { sessionId: s2.id });
    } catch (err) {
      continueCode = err.errorCode;
    }
    record("C1b ACP session 的 recovery.continue 仍然明確拒絕(只有 claude-agent-sdk + backendSessionId 能「繼續」)", continueCode === "sessionManager.continueUnsupportedBackend", `code=${continueCode}`);
    client.close();
    await killHard(coreB);
    coreB = null;

    // ---- 3) core C:provider 已不在偵測清單(沒有 extras)→ 接手仍然成功(退回 session 自己存的 launch_*)----
    coreC = startCore({ port: P + 2, ...dirs, extraEnv: { [E2E_PROVIDERS_ENV_NAME]: "" } });
    await waitForPort(`ws://127.0.0.1:${P + 2}`, 20_000);
    client = new MiniGatewayClient(`ws://127.0.0.1:${P + 2}`);
    await client.connect();
    let createCode;
    try {
      await client.rpc("session.create", { providerId: FAKE_ACP, workingDir: dirs.workspaceDir }, 30_000);
    } catch (err) {
      createCode = err.errorCode;
    }
    const info2 = (await client.rpc("recovery.list", {})).sessions.find((r) => r.sessionId === s2.id);
    const takeover2 = (await client.rpc("recovery.takeover", { sessionId: s2.id }, 40_000)).session;
    await client.waitFirstTurn(takeover2.id);
    const run2 = await client.runPrompt(takeover2.id, "continue the work again");
    record(
      "C2 provider 已不在偵測清單(core 重啟時沒有 extras):新建 session 回 agent.notFound,但接手既有 session 仍成功——退回 session 自己存的 adapterType + launch_command + launch_args,新 session 仍是 acp、providerId 不變、真的能跑;復原視圖的 agent 名稱退回 providerId",
      createCode === "agent.notFound" && takeover2.adapterType === "acp" && takeover2.providerId === FAKE_ACP &&
        run2.final.type === "completed" && run2.reply === FAKE_REPLY && info2?.agentLabel === FAKE_ACP,
      `createCode=${createCode}, takeover.adapterType=${takeover2.adapterType}, reply=${JSON.stringify(run2.reply)}, agentLabel=${info2?.agentLabel}`,
    );
    // 接手出來的新 session 同樣自帶 launch 資訊(下一次崩潰後還能接手)
    {
      const db = await openSqlite(dirs.dataDir);
      const row = db.prepare("SELECT provider_id, launch_command, launch_args FROM sessions WHERE id = ?").get(takeover2.id);
      db.close();
      record(
        "C3 退回 launch_* 重建出來的新 session 也自帶同樣的 provider_id/launch_command/launch_args(下一輪崩潰後仍可接手)",
        row?.provider_id === FAKE_ACP && row?.launch_command === process.execPath && JSON.stringify(JSON.parse(row?.launch_args ?? "null")) === JSON.stringify([FAKE_ACP_PATH]),
        JSON.stringify(row),
      );
    }
    for (const id of [takeover2.id]) {
      try {
        await client.rpc("session.delete", { sessionId: id });
      } catch {
        // ignore
      }
    }
  } catch (err) {
    record("C 續接重建執行過程發生未預期錯誤", false, err?.stack ?? String(err));
  } finally {
    client?.close();
    for (const core of [coreA, coreB, coreC]) await killHard(core);
  }
  rmDirs(Object.values(dirs));
}

// =======================================================================
// D. 【§P2.7 #4】舊資料遷移
// =======================================================================
async function legacyMigration() {
  const dirs = tmpDirs("legacy");
  const P = 4400;
  const dbPath = path.join(dirs.dataDir, "deskmony.db");

  // 用**舊 schema**(P2 之前的 CREATE TABLE:sessions 沒有 provider_id/launch_* 欄位、agent_profiles 完整)建 DB。
  const { default: Database } = await import(pathToFileURL(BETTER_SQLITE3_PATH).href);
  const old = new Database(dbPath);
  old.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '新對話', agent_profile_id TEXT NOT NULL, adapter_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'idle', working_dir TEXT NOT NULL, last_error TEXT, model TEXT, effort TEXT,
      interrupted_at INTEGER, last_seen_at INTEGER, backend_session_id TEXT, parent_session_id TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, attachments TEXT, created_at INTEGER NOT NULL
    );
    CREATE TABLE agent_profiles (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'Coder', software TEXT NOT NULL, provider_id TEXT,
      model TEXT, effort TEXT, system_prompt TEXT, mcp_config TEXT, permission_level TEXT NOT NULL DEFAULT 'always-ask',
      working_dir TEXT NOT NULL, env TEXT, acp_config TEXT, pty_config TEXT, opencode_config TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
  `);
  const now = Date.now();
  const insertProfile = old.prepare(
    `INSERT INTO agent_profiles (id, name, role, software, provider_id, model, system_prompt, permission_level, working_dir, env, acp_config, pty_config, opencode_config, created_at, updated_at)
     VALUES (@id, @name, 'Coder', @software, @provider_id, @model, @system_prompt, 'always-ask', @working_dir, @env, @acp_config, @pty_config, @opencode_config, @now, @now)`,
  );
  const profile = (o) => ({ provider_id: null, model: null, system_prompt: "舊的 systemPrompt", env: JSON.stringify({ SECRET: "keep-me" }), acp_config: null, pty_config: null, opencode_config: null, working_dir: dirs.workspaceDir, now, ...o });
  insertProfile.run(profile({ id: "p-acp", name: "舊 ACP", software: "acp", acp_config: JSON.stringify({ command: process.execPath, args: [FAKE_ACP_PATH] }) }));
  insertProfile.run(profile({ id: "p-gemini", name: "舊 Gemini", software: "acp", provider_id: "gemini", acp_config: JSON.stringify({ command: process.execPath, args: [FAKE_ACP_PATH, "--acp"] }) }));
  insertProfile.run(profile({ id: "p-pty", name: "舊 PTY", software: "pty", pty_config: JSON.stringify({ command: "C:\\old\\tool.exe", args: ["-x"] }) }));
  insertProfile.run(profile({ id: "p-sdk", name: "舊 SDK", software: "claude-agent-sdk", model: "opus" }));
  const insertSession = old.prepare(
    `INSERT INTO sessions (id, title, agent_profile_id, adapter_type, status, working_dir, model, created_at, updated_at)
     VALUES (@id, @title, @profile, @adapter, @status, @working_dir, @model, @now, @now)`,
  );
  const session = (o) => ({ working_dir: dirs.workspaceDir, status: "idle", model: null, now, ...o });
  insertSession.run(session({ id: "s-acp", title: "舊 ACP session", profile: "p-acp", adapter: "acp" }));
  insertSession.run(session({ id: "s-gemini", title: "舊 Gemini session", profile: "p-gemini", adapter: "acp" }));
  insertSession.run(session({ id: "s-pty", title: "舊 PTY session", profile: "p-pty", adapter: "pty" }));
  insertSession.run(session({ id: "s-sdk", title: "舊 SDK session", profile: "p-sdk", adapter: "claude-agent-sdk", model: "opus" }));
  insertSession.run(session({ id: "s-orphan", title: "profile 已被刪的 session", profile: "p-deleted", adapter: "acp" }));
  // 舊設計下用 agentOverride 換過 agent 的 session:base profile 是 claude-agent-sdk,session 實際跑的是 acp。
  insertSession.run(session({ id: "s-override", title: "agentOverride 換過 agent 的 session", profile: "p-sdk", adapter: "acp" }));
  insertSession.run(session({ id: "s-closed", title: "已關閉的舊 session", profile: "p-acp", adapter: "acp", status: "closed" }));
  // 讓「provider 在目錄裡、但現在不可用」的情境與這台機器有沒有裝 gemini 無關:用設定(settings 表,
  // 舊 DB 本來就有這張表)把 gemini 停用——續接/接手時 buildLaunchSpec 回 agent.disabled → 退回 session 自己存的 launch_*。
  old.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  old.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("providerPrefs", JSON.stringify({ gemini: { enabled: false } }));
  const profilesBefore = JSON.stringify(old.prepare("SELECT * FROM agent_profiles ORDER BY id").all());
  old.close();

  let core1;
  let core2;
  let client;
  try {
    core1 = startCore({ port: P, ...dirs });
    await waitForPort(`ws://127.0.0.1:${P}`, 20_000);
    client = new MiniGatewayClient(`ws://127.0.0.1:${P}`);
    await client.connect();

    const sessions = (await client.rpc("session.list", {})).sessions;
    const byId = Object.fromEntries(sessions.map((s) => [s.id, s]));
    const db = await openSqlite(dirs.dataDir);
    const launch = (id) => db.prepare("SELECT provider_id, launch_command, launch_args FROM sessions WHERE id = ?").get(id);
    const l = Object.fromEntries(["s-acp", "s-gemini", "s-pty", "s-sdk", "s-orphan", "s-override", "s-closed"].map((id) => [id, launch(id)]));
    const argsOf = (row) => (row?.launch_args ? JSON.parse(row.launch_args) : null);

    record(
      "D1【§P2.7 #4】舊資料遷移:舊 schema 的 session(provider_id 欄位原本不存在)→ 啟動 core 後 session.list 的 providerId、DB 的 launch_command/launch_args 已回填(profile 有 provider_id 用它;沒有 → claude-agent-sdk / legacy-<software>;launch 取自 acp_config/pty_config)",
      byId["s-acp"]?.providerId === "legacy-acp" && l["s-acp"].launch_command === process.execPath && JSON.stringify(argsOf(l["s-acp"])) === JSON.stringify([FAKE_ACP_PATH]) &&
        byId["s-gemini"]?.providerId === "gemini" && JSON.stringify(argsOf(l["s-gemini"])) === JSON.stringify([FAKE_ACP_PATH, "--acp"]) &&
        byId["s-pty"]?.providerId === "legacy-pty" && l["s-pty"].launch_command === "C:\\old\\tool.exe" && JSON.stringify(argsOf(l["s-pty"])) === '["-x"]' &&
        byId["s-sdk"]?.providerId === "claude-agent-sdk" && l["s-sdk"].launch_command === null && l["s-sdk"].launch_args === null &&
        byId["s-closed"]?.providerId === "legacy-acp",
      JSON.stringify(l),
    );
    record(
      "D2 邊界:profile 已被刪的 session → legacy-unknown 且不填 launch;agentOverride 換過 agent 的 session(profile.software ≠ session.adapter_type)→ 不採用 base profile 的 provider/launch(舊設計續接會換回錯的 agent 的既有 bug),providerId=legacy-acp、不填 launch",
      byId["s-orphan"]?.providerId === "legacy-unknown" && l["s-orphan"].launch_command === null &&
        byId["s-override"]?.providerId === "legacy-acp" && l["s-override"].launch_command === null && l["s-override"].launch_args === null,
      `orphan=${JSON.stringify(l["s-orphan"])}, override=${JSON.stringify(l["s-override"])}`,
    );

    // 回填出來的 launch 資訊真的能用:接手 s-acp(舊 profile 沒有 provider_id → legacy-acp,provider 不在目錄 → 用 launch_*)
    const takeover = (await client.rpc("recovery.takeover", { sessionId: "s-acp" }, 40_000)).session;
    await client.waitFirstTurn(takeover.id);
    const run = await client.runPrompt(takeover.id, "hello from the migrated session");
    // 接手 s-gemini:profile 的 provider_id=gemini 在目錄裡,但被設定停用(上面種的 settings)→ agent.disabled → 退回回填的 launch(指向 fake ACP)
    const takeoverGemini = (await client.rpc("recovery.takeover", { sessionId: "s-gemini" }, 40_000)).session;
    await client.waitFirstTurn(takeoverGemini.id);
    const runGemini = await client.runPrompt(takeoverGemini.id, "hello gemini");
    // 沒有任何 launch 資訊的 legacy session:接手明確報錯(不是靜默換成別的 agent)
    let orphanCode;
    try {
      await client.rpc("recovery.takeover", { sessionId: "s-orphan" }, 40_000);
    } catch (err) {
      orphanCode = err.errorCode;
    }
    const list = (await client.rpc("recovery.list", {})).sessions;
    record(
      "D3 回填的 launch 資訊真的能用:接手舊 ACP session(legacy-acp)與舊 gemini session(provider 在目錄但不可用)都成功,新 session 是 acp、providerId 保留、跑得起來;沒有任何 launch 資訊的 legacy-unknown session 接手 → 明確錯誤 agent.launchInfoMissing",
      takeover.adapterType === "acp" && takeover.providerId === "legacy-acp" && run.final.type === "completed" && run.reply === FAKE_REPLY &&
        takeoverGemini.adapterType === "acp" && takeoverGemini.providerId === "gemini" && runGemini.reply === FAKE_REPLY &&
        orphanCode === "agent.launchInfoMissing" &&
        list.some((r) => r.sessionId === "s-orphan" && r.agentLabel === "legacy-unknown"),
      `takeover=${takeover.adapterType}/${takeover.providerId}, gemini=${takeoverGemini.adapterType}/${takeoverGemini.providerId}, orphanCode=${orphanCode}`,
    );
    db.close();

    // 唯讀:agent_profiles 完全沒被改動(內容逐欄位相同,表還在)
    {
      const dbR = await openSqlite(dirs.dataDir);
      const profilesAfter = JSON.stringify(dbR.prepare("SELECT * FROM agent_profiles ORDER BY id").all());
      dbR.close();
      record(
        "D4 舊資料遷移只讀 agent_profiles:表與每一列的每個欄位(含 env/systemPrompt/permission_level)與遷移前逐字相同,沒有任何刪改",
        profilesAfter === profilesBefore,
        profilesAfter === profilesBefore ? "identical" : `before=${profilesBefore}\nafter=${profilesAfter}`,
      );
    }

    client.close();
    await killHard(core1);
    core1 = null;

    // 冪等:再啟動一次(新增了新 session,舊的已回填),不重複回填、不改值
    core2 = startCore({ port: P + 1, ...dirs });
    await waitForPort(`ws://127.0.0.1:${P + 1}`, 20_000);
    client = new MiniGatewayClient(`ws://127.0.0.1:${P + 1}`);
    await client.connect();
    const sessions2 = (await client.rpc("session.list", {})).sessions;
    const byId2 = Object.fromEntries(sessions2.map((s) => [s.id, s]));
    record(
      "D5 遷移冪等:再啟動一次——不再有「舊 session 回填」的訊息、既有 session 的 providerId 不變",
      !core2.out.text.includes("舊 session 回填") && byId2["s-acp"]?.providerId === "legacy-acp" && byId2["s-gemini"]?.providerId === "gemini" && byId2["s-orphan"]?.providerId === "legacy-unknown",
      `回填訊息出現=${core2.out.text.includes("舊 session 回填")}`,
    );
  } catch (err) {
    record("D 舊資料遷移執行過程發生未預期錯誤", false, err?.stack ?? String(err));
  } finally {
    client?.close();
    await killHard(core1);
    await killHard(core2);
  }
  rmDirs(Object.values(dirs));
}

// =======================================================================
async function main() {
  if (!existsSync(CORE_ENTRY)) {
    console.error(`找不到 ${CORE_ENTRY} —— 請先執行 pnpm build`);
    process.exit(1);
  }

  console.log("=== A. AgentCatalog 單元測試 ===");
  await catalogUnitTests();

  console.log("\n=== B. 即時 e2e:session 以 providerId 建立 / 錯誤碼 / profile.* 已移除 / gateway 不接受 command ===");
  await gatewayChecks();

  console.log("\n=== C. 續接重建:重啟後接手仍是 ACP(含 provider 已不在偵測清單的退路) ===");
  await rebuildAfterRestart();

  console.log("\n=== D. 舊資料遷移:舊 schema 的 agent_profiles + sessions → 回填 provider/launch ===");
  await legacyMigration();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n\n========== 總結:${results.length - failed.length}/${results.length} 通過 ==========`);
  for (const r of failed) console.log(`  FAIL: ${r.name}`);
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[e2e-agent-catalog] fatal:", err);
  process.exit(1);
});
