#!/usr/bin/env node
/**
 * scripts/e2e-agent-options.mjs
 *
 * 2026-10-06(各 agent 選 model 與思考程度)的決定性 e2e。「這個 session 能選哪些 model / 思考程度」改成向 agent 本身
 * 查詢(見 packages/shared/src/session-options.ts),這支用 fake 後端驗證整條路徑,不需要任何真實模型:
 *
 *   A. 純函式:ACP `configOptions` → `SessionOptions`(依 category 認、攤平分組、忽略無關選項與 boolean)、
 *      `providerEffortChoices()`、(2026-10-16)沒有選項時控制項顯示什麼的判斷 `providerEffortSelectionState()` /
 *      `effortUnavailableInSession()`、`opencode models --verbose` 的解析。
 *   B. ACP(fake-acp-agent.mjs `--config-options`):建立後回報選項並寫回 session 的 model/effort;對話中換 model
 *      (思考程度跟著換清單)、換思考程度;值真的送到 agent(agent 回報自己的設定);不合法 / 不提供的值回明確錯誤
 *      且 agent 沒收到;agent 主動送 `config_option_update`;記住 provider 上次的選擇、下次建立自動套用(做不到就略過);
 *      建立時明確指定(做不到就建立失敗、不留 session)。
 *      B9:自動命名的臨時對話(另開 session/new)與選項並存——主 session 的選項/設定不被動到,臨時 session 不套用記住的選擇。
 *   C. 不回報選項的 ACP agent(標準 fake ACP):沒有選項、換 model/思考程度與建立時指定都回明確錯誤。
 *   D. OpenCode HTTP(fake-opencode-server.mjs `--variants`):思考程度 = 目前 model 的 variants;選了之後下一則訊息
 *      wire 上真的帶 `variant`;換 model 時不再適用的 variant 被清掉;建立時指定(核對 provider 目錄的 model 清單)。
 *   E. 沒有 `/config/providers` 的 OpenCode(標準 fake):不能選思考程度(明確錯誤),既有的換 model 照舊。
 *
 * 一個 core(port 4760),fake 後端經 `DESKMONY_E2E_EXTRA_PROVIDERS` 注入(見 lib/e2e-providers.mjs)。
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CONFIG_UPDATE_PREFIX, FAKE_ACP_CONFIG_MODELS, REPORT_CONFIG_PREFIX, REPORT_SESSIONS_PREFIX } from "./fake-acp-agent.mjs";
import { fakeTitleFor } from "./lib/fake-title-modes.mjs";
import { requireFreshBuild } from "./lib/require-fresh-build.mjs";
import {
  e2eProvidersEnv,
  FAKE_ACP,
  FAKE_ACP_OPTIONS,
  FAKE_OPENCODE,
  FAKE_OPENCODE_VARIANTS,
  fakeAcpOptionsProvider,
  fakeOpencodeVariantsProvider,
} from "./lib/e2e-providers.mjs";

requireFreshBuild();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const CORE_PORT = 4760;
const CORE_ENTRY = path.join(REPO_ROOT, "apps", "core", "dist", "index.js");
const distUrl = (...p) => pathToFileURL(path.join(REPO_ROOT, ...p)).href;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function killProcessTree(proc, label) {
  if (!proc || proc.exitCode !== null || proc.killed) return;
  console.log(`[cleanup] 終止 ${label}(pid=${proc.pid}) ...`);
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      proc.kill("SIGTERM");
    }
  } catch (err) {
    console.log(`[cleanup] 終止 ${label} 時發生錯誤(忽略): ${err}`);
  }
  await sleep(500);
}

/** 四個環境變數一起隔離(只設其中幾個會讀到開發者真實的 ~/.deskmony)。 */
function startCore(port, homeDir, dataDir, workspaceDir) {
  const env = {
    ...process.env,
    DESKMONY_CORE_PORT: String(port),
    DESKMONY_HOME: homeDir,
    DESKMONY_DATA_DIR: dataDir,
    DESKMONY_WORKSPACE: workspaceDir,
    ...e2eProvidersEnv([fakeAcpOptionsProvider(), fakeOpencodeVariantsProvider()]),
  };
  const proc = spawn(process.execPath, [CORE_ENTRY], { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  proc.stdout.on("data", (chunk) => process.stdout.write(`[core] ${chunk}`));
  proc.stderr.on("data", (chunk) => process.stderr.write(`[core:err] ${chunk}`));
  proc.on("exit", (code, signal) => console.log(`[core] process exited (code=${code} signal=${signal})`));
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
        ws.addEventListener("open", () => { clearTimeout(t); resolve(); });
        ws.addEventListener("error", () => { clearTimeout(t); reject(new Error("connect error")); });
      });
      ws.close();
      return;
    } catch (err) { lastErr = err; await sleep(300); }
  }
  throw new Error(`等待 gateway 啟動逾時: ${lastErr}`);
}

class GatewayError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

class GatewayClient {
  constructor(url) {
    this.url = url;
    this.pendingRpc = new Map();
    this.events = [];
    this.waiters = [];
  }

  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("WS connect timeout")), 10_000);
      this.ws.addEventListener("open", () => { clearTimeout(t); resolve(); });
      this.ws.addEventListener("error", (e) => { clearTimeout(t); reject(new Error(`WS error: ${e.message ?? e}`)); });
    });
    this.ws.addEventListener("message", (e) => this._handleMessage(e.data));
  }

  close() { try { this.ws?.close(); } catch {} }

  _handleMessage(raw) {
    let msg;
    try { msg = JSON.parse(typeof raw === "string" ? raw : raw.toString()); } catch { return; }
    if (msg.kind === "response") {
      const pending = this.pendingRpc.get(msg.id);
      if (pending) {
        this.pendingRpc.delete(msg.id);
        if (msg.ok) pending.resolve(msg.result);
        else pending.reject(new GatewayError(msg.error ?? "unknown gateway error", msg.errorCode));
      }
      return;
    }
    if (msg.kind === "event" && msg.channel === "session-event") {
      this.events.push(msg.payload);
      for (const w of [...this.waiters]) w(msg.payload);
    }
  }

  rpc(method, params, timeoutMs = 30_000) {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pendingRpc.delete(id); reject(new Error(`rpc ${method} 逾時 (${timeoutMs}ms)`)); }, timeoutMs);
      this.pendingRpc.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  waitForEvent(predicate, timeoutMs, fromIndex = 0) {
    for (let i = fromIndex; i < this.events.length; i++) {
      if (predicate(this.events[i])) return Promise.resolve(this.events[i]);
    }
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.waiters = this.waiters.filter((w) => w !== waiter); reject(new Error(`等待事件逾時 (${timeoutMs}ms)`)); }, timeoutMs);
      const waiter = (ev) => { if (predicate(ev)) { clearTimeout(t); this.waiters = this.waiters.filter((w) => w !== waiter); resolve(ev); } };
      this.waiters.push(waiter);
    });
  }
}

async function getSession(client, sessionId) {
  const { sessions } = await client.rpc("session.list", {});
  return sessions.find((s) => s.id === sessionId);
}

/** 輪詢到 `predicate(session)` 成立(agent 回報的選項是建立/切換之後非同步送到的)。逾時回最後一次讀到的值。 */
async function waitForSession(client, sessionId, predicate, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  let session;
  while (Date.now() < deadline) {
    session = await getSession(client, sessionId);
    if (session && predicate(session)) return session;
    await sleep(100);
  }
  return session;
}

/** 送一則訊息、等這一輪結束,回傳這一輪 assistant 的完整文字。 */
async function promptText(client, sessionId, text) {
  const startIdx = client.events.length;
  await client.rpc("session.sendPrompt", { sessionId, prompt: { text } });
  const end = await client.waitForEvent(
    (e) => e.sessionId === sessionId && (e.event.type === "completed" || e.event.type === "error"),
    20_000,
    startIdx,
  );
  const textOut = client.events
    .slice(startIdx)
    .filter((e) => e.sessionId === sessionId && e.event.type === "message-delta")
    .map((e) => e.event.delta)
    .join("");
  if (end.event.type === "error") throw new Error(`回合錯誤: ${end.event.message} ${end.event.detail ?? ""}`);
  return textOut;
}

/** fake ACP agent 回報自己實際的設定(`ACP_REPORT_CONFIG`)。 */
async function agentConfig(client, sessionId) {
  const text = await promptText(client, sessionId, REPORT_CONFIG_PREFIX);
  const m = /CONFIG:(.*)$/s.exec(text);
  return m ? JSON.parse(m[1]) : undefined;
}

/** 呼叫預期會失敗的 RPC,回傳錯誤碼(成功則回 "(沒有失敗)")。 */
async function errorCodeOf(promise) {
  try {
    await promise;
    return "(沒有失敗)";
  } catch (err) {
    return err?.code ?? `(無錯誤碼) ${String(err)}`;
  }
}

const values = (option) => option?.choices.map((c) => c.value);
const sameList = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function main() {
  if (!existsSync(CORE_ENTRY)) {
    console.error(`找不到 ${CORE_ENTRY},請先執行 pnpm build`);
    process.exit(1);
  }

  const homeDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-options-home-"));
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-options-data-"));
  const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-options-ws-"));

  let coreProc;
  let client;
  const startTime = Date.now();
  const results = [];

  function record(name, ok, detail) {
    results.push({ name, ok, detail });
    console.log(`\n[${ok ? "PASS" : "FAIL"}] ${name}`);
    if (detail) console.log(`       ${detail}`);
  }

  // ======================= A. 純函式 =======================
  try {
    const { acpSessionOptions } = await import(distUrl("packages", "adapters", "dist", "agent-options.js"));
    const options = acpSessionOptions([
      { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "build", options: [{ value: "build", name: "build" }] },
      { id: "fast", name: "Fast", type: "boolean", currentValue: true },
      {
        id: "llm",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "p/b",
        options: [{ group: "p", name: "Provider", options: [{ value: "p/a", name: "A" }, { value: "p/b", name: "B", description: "bee" }] }],
      },
      // 沒有 category 的 select 以常見 id 認(ACP 規格:category 只是 UX 提示,client 不得依賴)。
      { id: "reasoning_effort", name: "Effort", type: "select", currentValue: "high", options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }] },
    ]);
    const ok =
      sameList(values(options.model), ["p/a", "p/b"]) &&
      options.model.current === "p/b" &&
      options.model.choices[1].label === "Provider / B" &&
      options.model.choices[1].description === "bee" &&
      sameList(values(options.effort), ["low", "high"]) &&
      options.effort.current === "high" &&
      sameList(Object.keys(options), ["model", "effort"]);
    const none = acpSessionOptions([{ id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "x", options: [{ value: "x", name: "x" }] }]);
    record(
      "A1 ACP configOptions → SessionOptions:依 category 認、攤平分組並加組名、沒有 category 時以常見 id 認、忽略 mode 與 boolean;沒有就是空物件",
      ok && Object.keys(none).length === 0,
      JSON.stringify({ options, none }),
    );
  } catch (err) {
    record("A1 ACP configOptions 轉換", false, String(err));
  }

  try {
    const { providerEffortChoices } = await import(distUrl("packages", "shared", "dist", "index.js"));
    const claude = { supportsEffortSelection: true, efforts: ["low", "max"], models: [{ id: "opus", label: "opus" }] };
    const oc = { supportsEffortSelection: true, models: [{ id: "a/x", label: "x", efforts: [] }, { id: "a/y", label: "y", efforts: ["low", "high"] }] };
    const acpLike = { supportsEffortSelection: true, models: [] };
    const aider = { supportsEffortSelection: false, efforts: ["low"], models: [] };
    const got = {
      claudeNoModel: providerEffortChoices(claude, undefined),
      claudeModel: providerEffortChoices(claude, "opus"),
      ocY: providerEffortChoices(oc, "a/y"),
      ocX: providerEffortChoices(oc, "a/x"),
      ocNone: providerEffortChoices(oc, undefined),
      acp: providerEffortChoices(acpLike, undefined),
      aider: providerEffortChoices(aider, undefined),
    };
    record(
      "A2 providerEffortChoices():固定清單(Claude)、model 自己的清單(OpenCode,可能是空的)、建立前不知道 → undefined、不支援 → undefined",
      sameList(got.claudeNoModel, ["low", "max"]) && sameList(got.claudeModel, ["low", "max"]) && sameList(got.ocY, ["low", "high"]) &&
        sameList(got.ocX, []) && got.ocNone === undefined && got.acp === undefined && got.aider === undefined,
      JSON.stringify(got),
    );
  } catch (err) {
    record("A2 providerEffortChoices", false, String(err));
  }

  // 2026-10-16:思考程度控制項「沒有選項時顯示什麼」的判斷(桌面端建立選單與對話標題列共用,見 resolve-providers.ts)。
  // 使用者回報「opencode 沒辦法選思考程度」:預設 model big-pickle 沒有 variants,控制項整個消失,不知道換 model 才能選。
  try {
    const { providerEffortSelectionState, effortUnavailableInSession } = await import(distUrl("packages", "shared", "dist", "index.js"));
    const claude = { supportsEffortSelection: true, supportsModelSelection: true, efforts: ["low", "max"], models: [{ id: "opus", label: "opus" }] };
    const oc = {
      supportsEffortSelection: true,
      supportsModelSelection: true,
      models: [
        { id: "a/none", label: "none", efforts: [] },
        { id: "a/y", label: "y", efforts: ["low", "high"] },
        { id: "a/unknown", label: "unknown" },
      ],
    };
    const ocNoDetection = { supportsEffortSelection: true, supportsModelSelection: true, models: [] };
    const codexLike = { supportsEffortSelection: true, supportsModelSelection: true, models: [{ id: "gpt", label: "gpt" }] };
    const pty = { supportsEffortSelection: false, supportsModelSelection: false, models: [] };
    const state = (p, m) => providerEffortSelectionState(p, m).kind;
    const got = {
      claudeDefault: state(claude, undefined),
      claudeModel: state(claude, "opus"),
      ocDefault: state(oc, undefined),
      ocWithVariants: providerEffortSelectionState(oc, "a/y"),
      ocNone: state(oc, "a/none"),
      ocUnknown: state(oc, "a/unknown"),
      ocNoDetection: state(ocNoDetection, undefined),
      codexLike: state(codexLike, undefined),
      pty: state(pty, undefined),
    };
    record(
      "A2b providerEffortSelectionState():Claude 固定清單照舊、OpenCode 沒選 model → pickModelFirst、選了沒有 variants 的 → modelHasNone、有 → choices;" +
        "model 沒有思考程度資訊 / 沒有偵測到 model 清單 / codex 這類沒有 per-model 資訊 / 不支援 → none(不顯示)",
      got.claudeDefault === "choices" && got.claudeModel === "choices" && got.ocDefault === "pickModelFirst" &&
        got.ocWithVariants.kind === "choices" && sameList(got.ocWithVariants.choices, ["low", "high"]) && got.ocNone === "modelHasNone" &&
        got.ocUnknown === "none" && got.ocNoDetection === "none" && got.codexLike === "none" && got.pty === "none",
      JSON.stringify(got),
    );

    const ocSupports = { supportsEffortSelection: true };
    const withEffort = { model: { current: "a/y", choices: [{ value: "a/y", label: "y" }] }, effort: { current: "low", choices: [{ value: "low", label: "low" }] } };
    const noEffort = { model: { current: "opencode/big-pickle", choices: [{ value: "opencode/big-pickle", label: "big-pickle" }] } };
    const gotSession = {
      withEffort: effortUnavailableInSession(ocSupports, withEffort),
      noEffort: effortUnavailableInSession(ocSupports, noEffort),
      emptyOptions: effortUnavailableInSession(ocSupports, {}),
      emptyChoices: effortUnavailableInSession(ocSupports, { effort: { choices: [] } }),
      notReported: effortUnavailableInSession(ocSupports, undefined),
      providerNoSupport: effortUnavailableInSession({ supportsEffortSelection: false }, noEffort),
      providerGone: effortUnavailableInSession(undefined, noEffort),
    };
    record(
      "A2c effortUnavailableInSession():agent 回報過選項但沒有思考程度(含 {}、空清單)→ true;有選項 / 還沒回報(ACP 剛啟動、PTY、已結束)/ provider 不支援 / provider 不在目錄 → false",
      gotSession.noEffort && gotSession.emptyOptions && gotSession.emptyChoices && !gotSession.withEffort && !gotSession.notReported &&
        !gotSession.providerNoSupport && !gotSession.providerGone,
      JSON.stringify(gotSession),
    );
  } catch (err) {
    record("A2b/A2c 思考程度控制項的顯示判斷", false, String(err));
  }

  try {
    const { parseModelsOutput } = await import(distUrl("apps", "core", "dist", "detect", "agent-detector.js"));
    // 照 opencode 1.18.7 `opencode models --verbose` 的實際格式(id 行 + 縮排 2 格、第 0 欄 `}` 結尾的 JSON)。
    const verbose = [
      "opencode/big-pickle",
      "{",
      '  "id": "big-pickle",',
      '  "limit": {',
      '    "context": 200000',
      "  },",
      '  "variants": {}',
      "}",
      "openai/gpt-5.4",
      "{",
      '  "id": "gpt-5.4",',
      '  "variants": {',
      '    "low": {',
      '      "reasoningEffort": "low"',
      "    },",
      '    "high": {',
      '      "reasoningEffort": "high"',
      "    }",
      "  }",
      "}",
      "google/broken",
      "{",
      '  "id": oops',
      "}",
      "",
    ].join("\r\n");
    const plain = "opencode/big-pickle\nopenai/gpt-5.4\nWARN something\n";
    const v = parseModelsOutput(verbose);
    const p = parseModelsOutput(plain);
    record(
      "A3 opencode models --verbose 解析:每個 model 的 variants 變成 efforts(沒有 = 空陣列、JSON 壞掉 = 不知道);純文字格式照舊",
      sameList(v.map((m) => m.id), ["opencode/big-pickle", "openai/gpt-5.4", "google/broken"]) &&
        sameList(v[0].efforts, []) && sameList(v[1].efforts, ["low", "high"]) && v[2].efforts === undefined &&
        sameList(p.map((m) => m.id), ["opencode/big-pickle", "openai/gpt-5.4"]) && p.every((m) => m.efforts === undefined),
      JSON.stringify({ v, p }),
    );
  } catch (err) {
    record("A3 opencode models --verbose 解析", false, String(err));
  }

  const createdIds = [];
  try {
    coreProc = startCore(CORE_PORT, homeDir, dataDir, workspaceDir);
    const gatewayUrl = `ws://localhost:${CORE_PORT}`;
    await waitForPort(gatewayUrl, 20_000);
    client = new GatewayClient(gatewayUrl);
    await client.connect();

    const create = async (params) => {
      const { session } = await client.rpc("session.create", { workingDir: workspaceDir, ...params }, 30_000);
      createdIds.push(session.id);
      return session;
    };

    // ======================= B. ACP agent 回報 configOptions =======================
    let acpId;
    try {
      acpId = (await create({ providerId: FAKE_ACP_OPTIONS, title: "e2e-options-acp" })).id;
      const s = await waitForSession(client, acpId, (x) => x.options?.model);
      const modelLabels = s?.options?.model?.choices.map((c) => c.label);
      record(
        "B1 ACP 建立後回報選項:session.options 有 model(分組攤平)與目前 model 的思考程度,目前值寫回 session.model/effort;無關的 mode 不出現",
        sameList(values(s?.options?.model), FAKE_ACP_CONFIG_MODELS.map((m) => m.value)) &&
          modelLabels?.[0] === "Fake / Fake Alpha" &&
          s.options.model.current === "fake/beta" &&
          sameList(values(s.options.effort), ["low", "high"]) &&
          s.options.effort.choices[0].label === "LOW" &&
          s.model === "fake/beta" &&
          s.effort === "low" &&
          sameList(Object.keys(s.options), ["model", "effort"]),
        JSON.stringify({ model: s?.model, effort: s?.effort, options: s?.options }),
      );
    } catch (err) {
      record("B1 ACP 建立後回報選項", false, String(err));
    }

    try {
      const result = await client.rpc("session.setModel", { sessionId: acpId, model: "fake/gamma" });
      const s = await waitForSession(client, acpId, (x) => x.options?.model?.current === "fake/gamma");
      const cfg = await agentConfig(client, acpId);
      record(
        "B2 ACP 對話中換 model:走 session/set_config_option(agent 收到 llm=fake/gamma、之後的回合用的是新 model);可選的思考程度換成新 model 的,agent 重設的目前值寫回 session.effort",
        result.session.model === "fake/gamma" &&
          s?.model === "fake/gamma" &&
          sameList(values(s?.options?.effort), ["minimal", "medium", "max"]) &&
          s.effort === "minimal" &&
          cfg?.model === "fake/gamma" &&
          cfg?.effort === "minimal" &&
          cfg?.setCalls.some((c) => c.configId === "llm" && c.value === "fake/gamma"),
        JSON.stringify({ session: { model: s?.model, effort: s?.effort, effortOptions: values(s?.options?.effort) }, agent: cfg }),
      );
    } catch (err) {
      record("B2 ACP 對話中換 model", false, String(err));
    }

    try {
      const result = await client.rpc("session.setEffort", { sessionId: acpId, effort: "max" });
      const s = await waitForSession(client, acpId, (x) => x.options?.effort?.current === "max");
      const cfg = await agentConfig(client, acpId);
      record(
        "B3 ACP 對話中換思考程度:走 session/set_config_option(configId 是 agent 自己的 think,不是寫死的 id);agent 之後的回合用的是 max",
        result.session.effort === "max" && s?.effort === "max" && cfg?.effort === "max" &&
          cfg?.setCalls.some((c) => c.configId === "think" && c.value === "max"),
        JSON.stringify({ session: s?.effort, agent: cfg }),
      );
    } catch (err) {
      record("B3 ACP 對話中換思考程度", false, String(err));
    }

    try {
      const before = (await agentConfig(client, acpId))?.setCalls.length;
      const badEffort = await errorCodeOf(client.rpc("session.setEffort", { sessionId: acpId, effort: "low" }));
      const badModel = await errorCodeOf(client.rpc("session.setModel", { sessionId: acpId, model: "fake/nope" }));
      const after = await agentConfig(client, acpId);
      const s = await getSession(client, acpId);
      record(
        "B4 ACP 不在 agent 清單裡的值回明確錯誤(agent.invalidEffort / agent.invalidModel),agent 根本沒收到、session 設定不變",
        badEffort === "agent.invalidEffort" && badModel === "agent.invalidModel" && after?.setCalls.length === before &&
          after?.model === "fake/gamma" && after?.effort === "max" && s?.model === "fake/gamma" && s?.effort === "max",
        JSON.stringify({ badEffort, badModel, before, after: after?.setCalls.length, session: { model: s?.model, effort: s?.effort } }),
      );
    } catch (err) {
      record("B4 ACP 不合法的值", false, String(err));
    }

    try {
      await client.rpc("session.setModel", { sessionId: acpId, model: "fake/alpha" });
      const s = await waitForSession(client, acpId, (x) => x.options?.model?.current === "fake/alpha");
      const noEffort = await errorCodeOf(client.rpc("session.setEffort", { sessionId: acpId, effort: "max" }));
      record(
        "B5 ACP 換到沒有思考程度的 model:思考程度選項消失、session.effort 清掉;這時換思考程度回 agent.effortNotOffered",
        s?.options?.effort === undefined && s?.effort === undefined && noEffort === "agent.effortNotOffered",
        JSON.stringify({ options: s?.options && Object.keys(s.options), effort: s?.effort, noEffort }),
      );
    } catch (err) {
      record("B5 ACP 換到沒有思考程度的 model", false, String(err));
    }

    try {
      await promptText(client, acpId, `${CONFIG_UPDATE_PREFIX}${JSON.stringify({ model: "fake/beta", effort: "high" })}`);
      const s = await waitForSession(client, acpId, (x) => x.options?.model?.current === "fake/beta");
      record(
        "B6 ACP agent 主動送 config_option_update:session.options 與 model/effort 跟著更新",
        s?.model === "fake/beta" && s?.effort === "high" && sameList(values(s?.options?.effort), ["low", "high"]),
        JSON.stringify({ model: s?.model, effort: s?.effort, options: s?.options }),
      );
    } catch (err) {
      record("B6 ACP config_option_update", false, String(err));
    }

    // 記住上次的選擇:使用者在 acpId 上最後選的 model 是 fake/alpha(B5)、思考程度是 max(B3)。B6 是 agent 自己改的,不算。
    try {
      const second = await create({ providerId: FAKE_ACP_OPTIONS, title: "e2e-options-acp-remember-1" });
      const s1 = await waitForSession(client, second.id, (x) => x.options?.model);
      const cfg1 = await agentConfig(client, second.id);
      // 再換成 gamma + medium,第三個 session 應該兩個都套用。
      await client.rpc("session.setModel", { sessionId: second.id, model: "fake/gamma" });
      await waitForSession(client, second.id, (x) => x.options?.model?.current === "fake/gamma");
      await client.rpc("session.setEffort", { sessionId: second.id, effort: "medium" });
      const third = await create({ providerId: FAKE_ACP_OPTIONS, title: "e2e-options-acp-remember-2" });
      const s2 = await waitForSession(client, third.id, (x) => x.options?.model);
      const cfg2 = await agentConfig(client, third.id);
      record(
        "B7 記住 provider 上次的選擇並在建立後自動套用:上次的 model(alpha)套用、上次的思考程度(max)alpha 沒有就略過(建立不失敗);" +
          "改成 gamma + medium 後,下一個 session 兩個都套用(在第一則訊息之前就送給 agent);agent 自己改的(B6)不算使用者的選擇",
        s1?.model === "fake/alpha" && s1?.effort === undefined && cfg1?.model === "fake/alpha" &&
          s2?.model === "fake/gamma" && s2?.effort === "medium" && cfg2?.model === "fake/gamma" && cfg2?.effort === "medium",
        JSON.stringify({ first: { model: s1?.model, effort: s1?.effort, agent: cfg1 }, second: { model: s2?.model, effort: s2?.effort, agent: cfg2 } }),
      );
    } catch (err) {
      record("B7 記住 provider 上次的選擇", false, String(err));
    }

    try {
      const explicit = await create({ providerId: FAKE_ACP_OPTIONS, model: "fake/beta", effort: "high", title: "e2e-options-acp-explicit" });
      const s = await waitForSession(client, explicit.id, (x) => x.options?.model);
      const cfg = await agentConfig(client, explicit.id);
      const before = (await client.rpc("session.list", {})).sessions.length;
      const badModel = await errorCodeOf(client.rpc("session.create", { providerId: FAKE_ACP_OPTIONS, workingDir: workspaceDir, model: "fake/nope" }));
      const badEffort = await errorCodeOf(
        client.rpc("session.create", { providerId: FAKE_ACP_OPTIONS, workingDir: workspaceDir, model: "fake/alpha", effort: "max" }),
      );
      const after = (await client.rpc("session.list", {})).sessions.length;
      record(
        "B8 建立時明確指定:套用指定值(蓋過記住的選擇);agent 不提供的 model / 思考程度 → 建立失敗(agent.invalidModel / agent.effortNotOffered),不留下 session",
        s?.model === "fake/beta" && s?.effort === "high" && cfg?.model === "fake/beta" && cfg?.effort === "high" &&
          badModel === "agent.invalidModel" && badEffort === "agent.effortNotOffered" && after === before,
        JSON.stringify({ session: { model: s?.model, effort: s?.effort }, agent: cfg, badModel, badEffort, before, after }),
      );
    } catch (err) {
      record("B8 建立時明確指定", false, String(err));
    }

    // 2026-10-06:兩個功能的交會點——自動命名會在**同一條 ACP 連線**另開臨時 session(`session/new`),那個 session 的回應也帶
    // configOptions;選項是依 sessionId 分流的,臨時 session 不得動到主 session 的選項/設定,也不得被套用「記住的上次選擇」。
    // (真實 Codex 的同一流程本機實測過:命名後主 session 的 model/思考程度/選項清單都沒變。)
    try {
      const untitled = await create({ providerId: FAKE_ACP_OPTIONS });
      const before = await waitForSession(client, untitled.id, (x) => x.options?.model);
      const message = "選項與命名並存的第一則訊息";
      await promptText(client, untitled.id, message);
      const named = await waitForSession(client, untitled.id, (x) => x.titleSource === "auto", 15_000);
      // 命名完成之後才查報告(報告本身是一則人類輸入,不能搶在第一則之前)。
      const reportText = await promptText(client, untitled.id, REPORT_SESSIONS_PREFIX);
      const idx = reportText.indexOf("SESSIONS:");
      const report = idx === -1 ? [] : JSON.parse(reportText.slice(idx + "SESSIONS:".length));
      const titleSessions = report.filter((r) => r.kind === "title");
      const mainSessions = report.filter((r) => r.kind === "main");
      const cfg = await agentConfig(client, untitled.id);
      const after = await getSession(client, untitled.id);
      record(
        "B9 自動命名(臨時 session/new)與選項並存:標題由臨時對話產生;主 session 的 model/思考程度/選項清單沒被動到(仍是 B8 記住的 beta + high);" +
          "agent 只開了一個臨時 session、沒對它送過 set_config_option;主 session 的 set_config_option 只有建立時套用記住的那一次",
        named?.title === fakeTitleFor(message) && named?.titleSource === "auto" &&
          before?.model === "fake/beta" && before?.effort === "high" &&
          after?.model === "fake/beta" && after?.effort === "high" &&
          after?.options?.model?.current === "fake/beta" && after?.options?.effort?.current === "high" &&
          sameList(values(after?.options?.model), FAKE_ACP_CONFIG_MODELS.map((m) => m.value)) &&
          sameList(values(after?.options?.effort), ["low", "high"]) &&
          titleSessions.length === 1 && titleSessions[0].setConfigCalls === 0 &&
          mainSessions.length === 1 && mainSessions[0].setConfigCalls === 1 &&
          cfg?.setCalls.length === 1 && cfg.setCalls[0].configId === "think" && cfg.setCalls[0].value === "high",
        JSON.stringify({ title: named?.title, titleSource: named?.titleSource, before: [before?.model, before?.effort], after: { model: after?.model, effort: after?.effort, options: after?.options }, report, setCalls: cfg?.setCalls }),
      );
    } catch (err) {
      record("B9 自動命名與選項並存", false, String(err));
    }

    // ======================= C. 不回報選項的 ACP agent =======================
    try {
      const plain = await create({ providerId: FAKE_ACP, title: "e2e-options-acp-plain" });
      const s = await waitForSession(client, plain.id, (x) => x.options !== undefined);
      const setModel = await errorCodeOf(client.rpc("session.setModel", { sessionId: plain.id, model: "x" }));
      const setEffort = await errorCodeOf(client.rpc("session.setEffort", { sessionId: plain.id, effort: "high" }));
      record(
        "C1 不回報 configOptions 的 ACP agent:session.options 是空的(UI 不顯示選擇器);換 model/思考程度回 agent.modelNotOffered / agent.effortNotOffered",
        s?.options !== undefined && Object.keys(s.options).length === 0 && setModel === "agent.modelNotOffered" &&
          setEffort === "agent.effortNotOffered",
        JSON.stringify({ options: s?.options, setModel, setEffort }),
      );
    } catch (err) {
      record("C1 不回報選項的 ACP agent", false, String(err));
    }

    // ======================= D. OpenCode HTTP variants =======================
    let ocId;
    try {
      ocId = (await create({ providerId: FAKE_OPENCODE_VARIANTS, title: "e2e-options-oc" })).id;
      const s = await waitForSession(client, ocId, (x) => x.options !== undefined);
      record(
        "D1 OpenCode 建立後回報思考程度:沒指定 model 時用 opencode 設定的預設 model(fake/model-b)的 variants,目前值未指定;不回報 model 選項(model 清單沿用 provider 目錄)",
        sameList(values(s?.options?.effort), ["low", "high"]) && s.options.effort.current === undefined && s.options.model === undefined &&
          s.effort === undefined,
        JSON.stringify({ options: s?.options, effort: s?.effort }),
      );
    } catch (err) {
      record("D1 OpenCode 建立後回報思考程度", false, String(err));
    }

    try {
      const result = await client.rpc("session.setEffort", { sessionId: ocId, effort: "high" });
      const text = await promptText(client, ocId, "hello with effort");
      const s = await getSession(client, ocId);
      record(
        "D2 OpenCode 換思考程度:下一則訊息 wire 上真的帶 variant=high(沒指定 model 就不帶 model)",
        result.session.effort === "high" && s?.effort === "high" && s?.options?.effort?.current === "high" &&
          text.startsWith("[variant:high] ") && !text.includes("[model:"),
        JSON.stringify({ text, effort: s?.effort }),
      );
    } catch (err) {
      record("D2 OpenCode 換思考程度", false, String(err));
    }

    try {
      await client.rpc("session.setModel", { sessionId: ocId, model: "fake/model-c" });
      const s = await waitForSession(client, ocId, (x) => sameList(values(x.options?.effort), ["minimal", "max"]));
      const text1 = await promptText(client, ocId, "after model switch");
      await client.rpc("session.setEffort", { sessionId: ocId, effort: "max" });
      const text2 = await promptText(client, ocId, "after effort switch");
      record(
        "D3 OpenCode 換 model:新 model 沒有的 variant(high)被清掉、思考程度清單換成新 model 的;之後選 max,wire 上 model 與 variant 都對",
        s?.effort === undefined && text1.startsWith("[model:fake/model-c] ") && !text1.includes("[variant:") &&
          text2.startsWith("[model:fake/model-c] [variant:max] "),
        JSON.stringify({ effort: s?.effort, effortOptions: values(s?.options?.effort), text1, text2 }),
      );
    } catch (err) {
      record("D3 OpenCode 換 model", false, String(err));
    }

    try {
      await client.rpc("session.setModel", { sessionId: ocId, model: "fake/model-a" });
      const s = await waitForSession(client, ocId, (x) => x.options !== undefined && x.options.effort === undefined);
      const noEffort = await errorCodeOf(client.rpc("session.setEffort", { sessionId: ocId, effort: "max" }));
      const badModel = await errorCodeOf(client.rpc("session.setModel", { sessionId: ocId, model: "fake/zzz" }));
      const badEffortValue = await errorCodeOf(
        client.rpc("session.setModel", { sessionId: ocId, model: "fake/model-b" }).then(() => client.rpc("session.setEffort", { sessionId: ocId, effort: "max" })),
      );
      record(
        "D4 OpenCode:沒有 variants 的 model 不能選思考程度(agent.effortNotOffered);不在清單裡的 model(agent.invalidModel)與 variant(agent.invalidEffort)回明確錯誤",
        s?.options?.effort === undefined && noEffort === "agent.effortNotOffered" && badModel === "agent.invalidModel" &&
          badEffortValue === "agent.invalidEffort",
        JSON.stringify({ noEffort, badModel, badEffortValue }),
      );
    } catch (err) {
      record("D4 OpenCode 不合法的值", false, String(err));
    }

    try {
      const explicit = await create({ providerId: FAKE_OPENCODE_VARIANTS, model: "fake/model-b", effort: "high", title: "e2e-options-oc-explicit" });
      const text = await promptText(client, explicit.id, "first prompt");
      const before = (await client.rpc("session.list", {})).sessions.length;
      const badEffort = await errorCodeOf(
        client.rpc("session.create", { providerId: FAKE_OPENCODE_VARIANTS, workingDir: workspaceDir, model: "fake/model-b", effort: "max" }),
      );
      const after = (await client.rpc("session.list", {})).sessions.length;
      record(
        "D5 OpenCode 建立時指定 model + 思考程度:第一則訊息就帶 model 與 variant;provider 目錄裡那個 model 沒有的思考程度 → agent.invalidEffort,不 spawn、不留 session",
        explicit.model === "fake/model-b" && explicit.effort === "high" && text.startsWith("[model:fake/model-b] [variant:high] ") &&
          badEffort === "agent.invalidEffort" && after === before,
        JSON.stringify({ model: explicit.model, effort: explicit.effort, text, badEffort, before, after }),
      );
    } catch (err) {
      record("D5 OpenCode 建立時指定", false, String(err));
    }

    // ======================= E. 沒有 /config/providers 的 OpenCode =======================
    try {
      const old = await create({ providerId: FAKE_OPENCODE, title: "e2e-options-oc-old" });
      await promptText(client, old.id, "warm up");
      const s = await getSession(client, old.id);
      const noEffort = await errorCodeOf(client.rpc("session.setEffort", { sessionId: old.id, effort: "high" }));
      await client.rpc("session.setModel", { sessionId: old.id, model: "openai/gpt-5-mini" });
      const text = await promptText(client, old.id, "after switch");
      record(
        "E1 查不到 /config/providers 的 OpenCode(舊版):沒有選項、選思考程度回 agent.effortNotOffered;換 model 維持舊行為(不驗證、下一則訊息帶新 model)",
        s?.options === undefined && noEffort === "agent.effortNotOffered" && text.startsWith("[model:openai/gpt-5-mini] "),
        JSON.stringify({ options: s?.options, noEffort, text }),
      );
    } catch (err) {
      record("E1 沒有 /config/providers 的 OpenCode", false, String(err));
    }
  } catch (err) {
    console.error(`\n[FATAL] ${err instanceof Error ? err.message : String(err)}`);
    record("setup", false, String(err));
  } finally {
    if (client) {
      for (const sessionId of createdIds) {
        try { await client.rpc("session.delete", { sessionId }, 15_000); } catch {}
      }
      client.close();
    }
    await killProcessTree(coreProc, "core");
    for (const dir of [homeDir, dataDir, workspaceDir]) {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n${"=".repeat(50)}`);
  console.log(`agent model/思考程度 e2e 結果 (${elapsed}s)`);
  console.log(`${"=".repeat(50)}`);
  let pass = 0;
  let fail = 0;
  for (const r of results) {
    console.log(`  ${r.ok ? "PASS" : "FAIL"} ${r.name}`);
    if (r.ok) pass++; else fail++;
  }
  console.log(`\n總計: ${pass} PASS, ${fail} FAIL`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
