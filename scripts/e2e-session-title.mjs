#!/usr/bin/env node
/**
 * scripts/e2e-session-title.mjs
 *
 * 2026-10-06:session 手動改名 + AI 自動命名的決定性端到端測試(fake ACP agent / fake OpenCode server / fake PTY,
 * 不依賴任何真實模型)。
 *
 *   U. 純函式(packages/shared/src/session-title.ts):手動標題的正規化與長度、AI 輸出的清理、截取首句、命名請求的
 *      組裝與解析。
 *   M. 遷移:舊 DB(sessions 沒有 title_source)啟動後回填——「新對話」→ default、其他 → user;重啟不會改掉已有的值。
 *   A. `session.rename`:正規化(換行/前後空白)、1–100 字(以 code point 計)、明確錯誤碼、titleSource 變 user、
 *      推播 `session-updated`、session 不在執行中也能改。
 *   B. 第一則人類輸入後自動命名(fake ACP,臨時 session):標題 = agent 回的(清理後)、titleSource auto;主 session 的
 *      歷史/事件沒有多出任何東西;第二則輸入不會再命名;臨時 session 被 `session/close`。
 *   C. 使用者改過的標題 AI 不覆蓋:先改名再送第一則 → 不命名;命名進行中(卡住)使用者改名 → 逾時退回的結果不套用。
 *   D. 退回截取首句:臨時對話嘗試用工具(權限被拒、工具沒跑、主 session 沒收到權限請求)、逾時、拒答、PTY。
 *   E. OpenCode(HTTP):臨時 session(沒有 parentID)→ 標題、用量計入成本 rollup、`DELETE` 掉;嘗試用工具 → reject + 退回;
 *      失敗 → 退回。
 *   F. `session.autoTitle`(「AI 重新命名」):覆蓋使用者取的標題、歷史不變;沒有文字訊息 → 錯誤碼;PTY → fallback;
 *      找不到 session → 錯誤碼。
 *   G. `create_session` 工具開的 session → titleSource user,不自動命名。
 *
 * 用法:node scripts/e2e-session-title.mjs(前置需求:pnpm build)。
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireFreshBuild } from "./lib/require-fresh-build.mjs";
import { e2eProvidersEnv, FAKE_ACP, FAKE_OPENCODE, FAKE_PTY } from "./lib/e2e-providers.mjs";
import {
  TITLE_MODE_HANG,
  TITLE_MODE_REFUSE,
  TITLE_MODE_TOOL,
  TITLE_TOOL_MARKER_FILE,
  fakeTitleFor,
} from "./lib/fake-title-modes.mjs";
import { CALL_BRIDGE_TOOL_PREFIX, FAKE_ACP_REPLY_CHUNKS, REPORT_SESSIONS_PREFIX as ACP_REPORT_SESSIONS } from "./fake-acp-agent.mjs";
import {
  FAKE_OPENCODE_REPLY_CHUNKS,
  FAKE_TITLE_USAGE,
  REPORT_SESSIONS_PREFIX as OPENCODE_REPORT_SESSIONS,
} from "./fake-opencode-server.mjs";

requireFreshBuild();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const CORE_ENTRY = path.join(REPO_ROOT, "apps", "core", "dist", "index.js");
const SHARED_TITLE = path.join(REPO_ROOT, "packages", "shared", "dist", "session-title.js");
const BETTER_SQLITE3_PATH = path.join(REPO_ROOT, "apps", "core", "node_modules", "better-sqlite3", "lib", "index.js");
/** 避開其他 e2e 用過的 port(4740/4745/4748/4750 是 opencode/agent-env 那幾支)。 */
const PORT = 4755;
/** 命名臨時對話的逾時(core 讀 DESKMONY_TITLE_TIMEOUT_MS,只給 e2e 用),「卡住」的情境不用真的等 60 秒。 */
const TITLE_TIMEOUT_MS = 2_500;

const {
  DEFAULT_SESSION_TITLE,
  SESSION_TITLE_MAX_CHARS,
  TITLE_REQUEST_HEADER,
  buildTitleRequestPrompt,
  checkManualTitle,
  fallbackTitleFromText,
  parseTitleRequestPrompt,
  sanitizeGeneratedTitle,
} = await import(pathToFileURL(SHARED_TITLE).href);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function killProcessTree(proc, label) {
  if (!proc || proc.exitCode !== null || proc.killed) return;
  console.log(`[cleanup] 終止 ${label}(pid=${proc.pid}) ...`);
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
    else proc.kill("SIGTERM");
  } catch (err) {
    console.log(`[cleanup] 終止 ${label} 時發生錯誤(忽略): ${err}`);
  }
  await sleep(500);
}

/** 四個環境變數一起隔離(只設其中幾個會讀到開發者真實的 ~/.deskmony)。 */
function startCore(dirs) {
  const env = {
    ...process.env,
    DESKMONY_CORE_PORT: String(PORT),
    DESKMONY_HOME: dirs.homeDir,
    DESKMONY_DATA_DIR: dirs.dataDir,
    DESKMONY_WORKSPACE: dirs.workspaceDir,
    DESKMONY_TITLE_TIMEOUT_MS: String(TITLE_TIMEOUT_MS),
    ...e2eProvidersEnv(),
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

class GatewayClient {
  constructor(url) {
    this.url = url;
    this.pendingRpc = new Map();
    /** session-event 推播的 envelope。 */
    this.events = [];
    /** session-updated 推播的 Session。 */
    this.sessionUpdates = [];
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
        else {
          const err = new Error(msg.error ?? "unknown gateway error");
          err.code = msg.errorCode;
          err.params = msg.errorParams;
          pending.reject(err);
        }
      }
      return;
    }
    if (msg.kind === "event") {
      if (msg.channel === "session-event") {
        this.events.push(msg.payload);
        for (const w of [...this.waiters]) w(msg.payload);
      } else if (msg.channel === "session-updated") {
        this.sessionUpdates.push(msg.payload);
      }
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

  /** 送一則人類輸入,等這一輪的 completed/error,回傳這一輪的文字。 */
  async drivePrompt(sessionId, text, timeoutMs = 30_000) {
    const startIdx = this.events.length;
    await this.rpc("session.sendPrompt", { sessionId, prompt: { text } });
    const end = await this.waitForEvent(
      (e) => e.sessionId === sessionId && (e.event.type === "completed" || e.event.type === "error"),
      timeoutMs,
      startIdx,
    );
    const endIdx = this.events.indexOf(end);
    const turnText = this.events
      .slice(startIdx, endIdx + 1)
      .filter((e) => e.sessionId === sessionId && e.event.type === "message-delta")
      .map((e) => e.event.delta)
      .join("");
    return { end: end.event, text: turnText };
  }
}

async function getSession(client, sessionId) {
  const { sessions } = await client.rpc("session.list", {});
  return sessions.find((s) => s.id === sessionId);
}

/** 輪詢 session.list 直到 predicate 成立(或逾時,回傳最後一次讀到的值)。 */
async function waitForSession(client, sessionId, predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let session;
  while (Date.now() < deadline) {
    session = await getSession(client, sessionId);
    if (session && predicate(session)) return session;
    await sleep(100);
  }
  return session;
}

async function history(client, sessionId) {
  const { messages } = await client.rpc("session.history", { sessionId });
  return messages;
}

/** 對話歷史只剩 user/assistant 的 [role, content] 對(tool/system 另外看)。 */
function chatPairs(messages) {
  return messages.filter((m) => m.role === "user" || m.role === "assistant").map((m) => [m.role, m.content]);
}

/** 命名臨時對話有沒有漏進主 session:這個 session 的所有事件裡,不該出現命名指示、假標題、權限請求。 */
function leakReport(client, sessionId) {
  const events = client.events.filter((e) => e.sessionId === sessionId);
  const text = events.filter((e) => e.event.type === "message-delta").map((e) => e.event.delta).join("");
  return {
    leakedText: text.includes(TITLE_REQUEST_HEADER) || text.includes("假標題") || text.includes("Title:") || text.includes("TOOL-RAN") || text.includes("工具被拒"),
    permissionRequests: events.filter((e) => e.event.type === "permission-request").length,
    toolCalls: events.filter((e) => e.event.type === "tool-call").length,
    wentWaiting: client.sessionUpdates.some((s) => s.id === sessionId && s.status === "waiting"),
  };
}

/** 送回報指令(fake 的 REPORT_SESSIONS),解析 `SESSIONS:` JSON。 */
async function fakeReport(client, sessionId, prefix) {
  const { text } = await client.drivePrompt(sessionId, prefix);
  const idx = text.indexOf("SESSIONS:");
  return idx === -1 ? undefined : JSON.parse(text.slice(idx + "SESSIONS:".length));
}

function errorCodeOf(promise) {
  return promise.then(
    () => "(沒有丟錯)",
    (err) => err.code ?? `(沒有 errorCode:${err.message})`,
  );
}

function tmpDirs(tag) {
  return {
    homeDir: mkdtempSync(path.join(os.tmpdir(), `deskmony-e2e-title-${tag}-home-`)),
    dataDir: mkdtempSync(path.join(os.tmpdir(), `deskmony-e2e-title-${tag}-data-`)),
    workspaceDir: mkdtempSync(path.join(os.tmpdir(), `deskmony-e2e-title-${tag}-ws-`)),
  };
}

/** M:用「沒有 title_source 欄位」的 schema(其餘與目前相同)先建好 DB,放兩個舊 session。 */
async function seedLegacyDb(dataDir, workspaceDir) {
  const { default: Database } = await import(pathToFileURL(BETTER_SQLITE3_PATH).href);
  const db = new Database(path.join(dataDir, "deskmony.db"));
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '新對話', agent_profile_id TEXT NOT NULL, provider_id TEXT,
      launch_command TEXT, launch_args TEXT, adapter_type TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'idle',
      working_dir TEXT NOT NULL, last_error TEXT, model TEXT, effort TEXT, interrupted_at INTEGER, last_seen_at INTEGER,
      backend_session_id TEXT, parent_session_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
  `);
  const insert = db.prepare(
    "INSERT INTO sessions (id, title, agent_profile_id, provider_id, adapter_type, status, working_dir, created_at, updated_at) VALUES (?, ?, ?, ?, 'acp', 'closed', ?, ?, ?)",
  );
  const now = Date.now();
  insert.run("legacy-default", DEFAULT_SESSION_TITLE, FAKE_ACP, FAKE_ACP, workspaceDir, now, now);
  insert.run("legacy-named", "舊的自訂標題", FAKE_ACP, FAKE_ACP, workspaceDir, now, now);
  db.close();
}

async function readTitleSources(dataDir) {
  const { default: Database } = await import(pathToFileURL(BETTER_SQLITE3_PATH).href);
  const db = new Database(path.join(dataDir, "deskmony.db"), { readonly: true });
  try {
    return Object.fromEntries(db.prepare("SELECT id, title_source FROM sessions").all().map((r) => [r.id, r.title_source]));
  } finally {
    db.close();
  }
}

async function main() {
  if (!existsSync(CORE_ENTRY)) {
    console.error(`找不到 ${CORE_ENTRY},請先執行 pnpm build`);
    process.exit(1);
  }
  const startTime = Date.now();
  const results = [];
  function record(name, ok, detail) {
    results.push({ name, ok, detail });
    console.log(`\n[${ok ? "PASS" : "FAIL"}] ${name}`);
    if (detail) console.log(`       ${detail}`);
  }
  async function step(name, fn) {
    try {
      await fn();
    } catch (err) {
      record(name, false, String(err?.stack ?? err));
    }
  }

  // ---- U. 純函式 ----------------------------------------------------------------------------
  {
    const a = checkManualTitle("  新名字\n第二行\t ");
    const b = checkManualTitle(" \n\t ");
    const c = checkManualTitle("字".repeat(SESSION_TITLE_MAX_CHARS));
    const d = checkManualTitle("😀".repeat(SESSION_TITLE_MAX_CHARS + 1));
    record(
      "U1 手動標題:換行/控制字元換成空白並去頭尾空白、空白 → empty、100 個字可以、101 個(以 code point 計,emoji 算 1)→ tooLong",
      a.ok && a.title === "新名字 第二行" && !b.ok && b.reason === "empty" && c.ok && !d.ok && d.reason === "tooLong" && d.length === 101,
      JSON.stringify({ a, b, c: c.ok, d }),
    );
    const cases = [
      ["**Title:** 「季度報表整理」\n多餘的說明", "季度報表整理"],
      ['<think>先想一下……</think>\n"Fix login bug."', "Fix login bug"],
      ["標題:資料庫索引策略。", "資料庫索引策略"],
      ["# 重構登入流程", "重構登入流程"],
      ["\n\n   \n", undefined],
      ["一".repeat(60), `${"一".repeat(39)}…`],
    ];
    const got = cases.map(([raw]) => sanitizeGeneratedTitle(raw));
    record(
      "U2 AI 輸出清理:拿掉 <think>、markdown、Title:/標題: 前綴、外層引號與尾端標點、只取第一行、超過 40 字截斷加「…」、空白 → undefined",
      cases.every(([, expected], i) => got[i] === expected),
      JSON.stringify(got),
    );
    const longLine = "幫我寫一個 Python 腳本把 CSV 轉成 JSON 並且處理各種編碼問題";
    const f1 = fallbackTitleFromText(`\n\n## ${longLine}\n第二行`);
    const f2 = fallbackTitleFromText("   \n  ");
    const f3 = fallbackTitleFromText("**修正** `login` 的 bug。");
    // 30 個字的上限:前 29 個字(去掉尾端空白)+「…」。
    const expectedF1 = `${Array.from(longLine).slice(0, 29).join("").trimEnd()}…`;
    record(
      "U3 截取首句:第一個非空白行、去掉 markdown 標記與尾端標點、超過 30 字截斷加「…」;沒有文字 → undefined",
      f1 === expectedF1 && Array.from(f1).length <= 30 && f2 === undefined && f3 === "修正 login 的 bug",
      JSON.stringify({ f1, f2, f3 }),
    );
    const prompt = buildTitleRequestPrompt({ firstMessage: "  第一則\n訊息  ", firstReply: "回覆" });
    record(
      "U4 命名請求:開頭是 TITLE_REQUEST_HEADER、parse 取回引用的第一則訊息;一般文字不會被認成命名請求",
      prompt.startsWith(TITLE_REQUEST_HEADER) &&
        parseTitleRequestPrompt(prompt)?.firstMessage === "第一則\n訊息" &&
        parseTitleRequestPrompt(`hello ${TITLE_REQUEST_HEADER}`) === undefined,
      JSON.stringify(parseTitleRequestPrompt(prompt)),
    );
  }

  const dirs = tmpDirs("main");
  await seedLegacyDb(dirs.dataDir, dirs.workspaceDir);
  let coreProc;
  let client;
  /** 最後重啟 core 前,記下各情境 session 的 id 與 titleSource,重啟後比對。 */
  const persisted = {};

  try {
    coreProc = startCore(dirs);
    const gatewayUrl = `ws://127.0.0.1:${PORT}`;
    await waitForPort(gatewayUrl, 20_000);
    client = new GatewayClient(gatewayUrl);
    await client.connect();

    // ---- M. 遷移 ----------------------------------------------------------------------------
    await step("M1 遷移", async () => {
      const def = await getSession(client, "legacy-default");
      const named = await getSession(client, "legacy-named");
      const raw = await readTitleSources(dirs.dataDir);
      record(
        "M1 舊 DB(sessions 沒有 title_source)啟動後補欄位並回填:「新對話」→ default、其他 → user(API 與 DB 一致)",
        def?.titleSource === "default" && named?.titleSource === "user" && raw["legacy-default"] === "default" && raw["legacy-named"] === "user",
        JSON.stringify({ api: [def?.titleSource, named?.titleSource], db: raw }),
      );
    });

    // ---- A. session.rename -------------------------------------------------------------------
    let renameTarget;
    await step("A 改名", async () => {
      const { session: untitled } = await client.rpc("session.create", { providerId: FAKE_ACP, workingDir: dirs.workspaceDir });
      const { session: titled } = await client.rpc("session.create", { providerId: FAKE_ACP, workingDir: dirs.workspaceDir, title: "我的標題" });
      const { session: blank } = await client.rpc("session.create", { providerId: FAKE_ACP, workingDir: dirs.workspaceDir, title: "   " });
      record(
        "A1 沒給標題 → 預設標題 + titleSource default;明確給標題 → user;只有空白的標題視同沒給",
        untitled.title === DEFAULT_SESSION_TITLE && untitled.titleSource === "default" && titled.titleSource === "user" && titled.title === "我的標題" && blank.titleSource === "default",
        JSON.stringify([untitled.title, untitled.titleSource, titled.titleSource, blank.title, blank.titleSource]),
      );
      renameTarget = untitled.id;
      const updatesBefore = client.sessionUpdates.length;
      const { session: renamed } = await client.rpc("session.rename", { sessionId: untitled.id, title: "  客戶需求\n訪談整理  " });
      await sleep(200);
      const pushed = client.sessionUpdates.slice(updatesBefore).find((s) => s.id === untitled.id && s.title === "客戶需求 訪談整理");
      const listed = await getSession(client, untitled.id);
      record(
        "A2 改名:正規化(換行換成空白、去頭尾空白)、titleSource 變 user、回應/推播 session-updated/session.list 三者一致",
        renamed.title === "客戶需求 訪談整理" && renamed.titleSource === "user" && pushed?.titleSource === "user" && listed?.title === renamed.title,
        JSON.stringify({ renamed: [renamed.title, renamed.titleSource], pushed: Boolean(pushed), listed: listed?.title }),
      );
      const codes = await Promise.all([
        errorCodeOf(client.rpc("session.rename", { sessionId: untitled.id, title: " \n " })),
        errorCodeOf(client.rpc("session.rename", { sessionId: untitled.id, title: "長".repeat(SESSION_TITLE_MAX_CHARS + 1) })),
        errorCodeOf(client.rpc("session.rename", { sessionId: "no-such-session", title: "x" })),
      ]);
      const ok100 = await client.rpc("session.rename", { sessionId: blank.id, title: "長".repeat(SESSION_TITLE_MAX_CHARS) });
      record(
        "A3 驗證與錯誤碼:空白 → session.titleEmpty、101 字 → session.titleTooLong、找不到 → entity.notFound;剛好 100 字可以",
        codes[0] === "session.titleEmpty" && codes[1] === "session.titleTooLong" && codes[2] === "entity.notFound" && ok100.session.title.length === SESSION_TITLE_MAX_CHARS,
        JSON.stringify(codes),
      );
      const closedRename = await client.rpc("session.rename", { sessionId: "legacy-default", title: "已關閉的也能改" });
      record(
        "A4 session 不在執行中(closed)也能改名(純 DB 欄位)",
        closedRename.session.title === "已關閉的也能改" && closedRename.session.titleSource === "user",
        JSON.stringify([closedRename.session.status, closedRename.session.titleSource]),
      );
      persisted.renamed = { id: untitled.id, title: "客戶需求 訪談整理", titleSource: "user" };
    });

    // ---- B. ACP 第一則人類輸入後自動命名 ---------------------------------------------------------
    await step("B ACP 自動命名", async () => {
      const message = "幫我整理季度報表然後寄給主管";
      const { session } = await client.rpc("session.create", { providerId: FAKE_ACP, workingDir: dirs.workspaceDir });
      const { text } = await client.drivePrompt(session.id, message);
      const titled = await waitForSession(client, session.id, (s) => s.titleSource === "auto");
      record(
        "B1 第一則人類輸入後自動命名:用同一個 agent 的臨時對話產生,標題 = agent 回的(清掉 markdown/前綴/引號/第二行)、titleSource auto",
        titled?.title === fakeTitleFor(message) && titled?.titleSource === "auto",
        JSON.stringify([titled?.title, titled?.titleSource, fakeTitleFor(message)]),
      );
      const pairs = chatPairs(await history(client, session.id));
      const leak = leakReport(client, session.id);
      record(
        "B2 主 session 沒有多一輪:歷史只有那一則 user + 一則 assistant(內容就是這一輪的回覆),事件裡沒有命名指示/假標題",
        JSON.stringify(pairs) === JSON.stringify([["user", message], ["assistant", FAKE_ACP_REPLY_CHUNKS.join("")]]) &&
          text === FAKE_ACP_REPLY_CHUNKS.join("") && !leak.leakedText && leak.permissionRequests === 0,
        JSON.stringify({ pairs, leak }),
      );
      await client.drivePrompt(session.id, "第二則訊息");
      await sleep(600);
      const after = await getSession(client, session.id);
      const report = await fakeReport(client, session.id, ACP_REPORT_SESSIONS);
      const titleSessions = (report ?? []).filter((s) => s.kind === "title");
      record(
        "B3 第二則人類輸入不會再命名(titleSource 已是 auto);fake agent 只開過一個臨時 session,而且被 session/close 關掉",
        after?.title === fakeTitleFor(message) && titleSessions.length === 1 && titleSessions[0].closed === true && titleSessions[0].prompts === 1,
        JSON.stringify({ title: after?.title, report }),
      );
      persisted.auto = { id: session.id, title: fakeTitleFor(message), titleSource: "auto" };
    });

    // ---- C. 使用者改過的標題 AI 不覆蓋 ------------------------------------------------------------
    let userTitledId;
    await step("C 使用者改過不覆蓋", async () => {
      const { session } = await client.rpc("session.create", { providerId: FAKE_ACP, workingDir: dirs.workspaceDir });
      await client.rpc("session.rename", { sessionId: session.id, title: "使用者取的名字" });
      await client.drivePrompt(session.id, "這則訊息不該被拿去命名");
      await sleep(1_000);
      const after = await getSession(client, session.id);
      const report = await fakeReport(client, session.id, ACP_REPORT_SESSIONS);
      record(
        "C1 先手動改名再送第一則:不自動命名(標題與 titleSource 不變、agent 沒有開任何臨時 session)",
        after?.title === "使用者取的名字" && after?.titleSource === "user" && (report ?? []).every((s) => s.kind !== "title"),
        JSON.stringify({ title: after?.title, titleSource: after?.titleSource, report }),
      );
      userTitledId = session.id;

      // 命名進行中(agent 卡住)使用者改名 → 逾時退回截取首句的結果不得覆蓋使用者的名字。
      const { session: racing } = await client.rpc("session.create", { providerId: FAKE_ACP, workingDir: dirs.workspaceDir });
      await client.drivePrompt(racing.id, `命名期間被改名\n${TITLE_MODE_HANG}`);
      await sleep(300);
      await client.rpc("session.rename", { sessionId: racing.id, title: "搶先改的名字" });
      await sleep(TITLE_TIMEOUT_MS + 1_500);
      const raced = await getSession(client, racing.id);
      record(
        "C2 命名進行中使用者手動改名:之後產生的結果(逾時退回)不套用,以使用者的為準",
        raced?.title === "搶先改的名字" && raced?.titleSource === "user",
        JSON.stringify([raced?.title, raced?.titleSource]),
      );
    });

    // ---- D. 退回截取首句 ---------------------------------------------------------------------
    await step("D1 工具", async () => {
      const ws = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-title-tool-"));
      const message = `請幫我分析這份日誌檔的錯誤\n${TITLE_MODE_TOOL}`;
      const { session } = await client.rpc("session.create", { providerId: FAKE_ACP, workingDir: ws });
      await client.drivePrompt(session.id, message);
      const titled = await waitForSession(client, session.id, (s) => s.titleSource === "auto");
      await sleep(500);
      const leak = leakReport(client, session.id);
      const report = await fakeReport(client, session.id, ACP_REPORT_SESSIONS);
      const titleSession = (report ?? []).find((s) => s.kind === "title");
      record(
        "D1 臨時對話嘗試用工具:工具沒有執行(標記檔不存在)、它的權限請求被直接拒絕且沒有轉給主 session(沒有 permission-request、沒進 waiting)、退回截取首句",
        titled?.title === fallbackTitleFromText(message) &&
          !existsSync(path.join(ws, TITLE_TOOL_MARKER_FILE)) &&
          leak.permissionRequests === 0 && leak.toolCalls === 0 && !leak.wentWaiting && !leak.leakedText &&
          titleSession?.permissionOutcomes.length >= 1 && titleSession.permissionOutcomes.every((o) => o === "deny") && titleSession.closed === true,
        JSON.stringify({ title: titled?.title, leak, titleSession }),
      );
      try { rmSync(ws, { recursive: true, force: true }); } catch {}
    });

    await step("D2 逾時", async () => {
      const message = `整理會議記錄重點\n${TITLE_MODE_HANG}`;
      const { session } = await client.rpc("session.create", { providerId: FAKE_ACP, workingDir: dirs.workspaceDir });
      const started = Date.now();
      await client.drivePrompt(session.id, message);
      const titled = await waitForSession(client, session.id, (s) => s.titleSource === "auto", TITLE_TIMEOUT_MS + 8_000);
      const elapsed = Date.now() - started;
      const pairs = chatPairs(await history(client, session.id));
      const report = await fakeReport(client, session.id, ACP_REPORT_SESSIONS);
      const titleSession = (report ?? []).find((s) => s.kind === "title");
      record(
        `D2 agent 一直不回:${TITLE_TIMEOUT_MS}ms 逾時後退回截取首句;臨時 session 被取消並關閉;主 session 照常回覆`,
        titled?.title === "整理會議記錄重點" && elapsed >= TITLE_TIMEOUT_MS && titleSession?.cancelled >= 1 && titleSession?.closed === true &&
          JSON.stringify(pairs.slice(0, 2)) === JSON.stringify([["user", message], ["assistant", FAKE_ACP_REPLY_CHUNKS.join("")]]),
        JSON.stringify({ title: titled?.title, elapsed, titleSession }),
      );
    });

    await step("D3 拒答", async () => {
      const message = `寫一首關於秋天的詩\n${TITLE_MODE_REFUSE}`;
      const { session } = await client.rpc("session.create", { providerId: FAKE_ACP, workingDir: dirs.workspaceDir });
      await client.drivePrompt(session.id, message);
      const titled = await waitForSession(client, session.id, (s) => s.titleSource === "auto");
      const after = await getSession(client, session.id);
      record(
        "D3 臨時對話拒答(stopReason refusal):退回截取首句,主 session 沒有變成 error",
        titled?.title === "寫一首關於秋天的詩" && after?.status === "idle",
        JSON.stringify([titled?.title, after?.status]),
      );
    });

    let ptySessionId;
    await step("D4 PTY", async () => {
      const { session } = await client.rpc("session.create", { providerId: FAKE_PTY, workingDir: dirs.workspaceDir });
      ptySessionId = session.id;
      await client.rpc("session.sendPrompt", { sessionId: session.id, prompt: { text: "echo pty 也要有標題" } });
      const titled = await waitForSession(client, session.id, (s) => s.titleSource === "auto");
      record(
        "D4 PTY(沒有臨時對話的能力):直接退回截取首句",
        titled?.title === "echo pty 也要有標題",
        JSON.stringify([titled?.title, titled?.titleSource]),
      );
    });

    // ---- E. OpenCode(HTTP)----------------------------------------------------------------
    await step("E1 OpenCode 自動命名", async () => {
      const message = "設計資料庫的索引策略與遷移步驟";
      const { session } = await client.rpc("session.create", { providerId: FAKE_OPENCODE, workingDir: dirs.workspaceDir });
      const { text } = await client.drivePrompt(session.id, message);
      const titled = await waitForSession(client, session.id, (s) => s.titleSource === "auto");
      const pairs = chatPairs(await history(client, session.id));
      const leak = leakReport(client, session.id);
      record(
        "E1 OpenCode:同一個伺服器開臨時 session 產生標題(清掉使用者自己那則 part 與多餘內容);主 session 歷史/事件沒有多出任何東西",
        titled?.title === fakeTitleFor(message) &&
          JSON.stringify(pairs) === JSON.stringify([["user", message], ["assistant", FAKE_OPENCODE_REPLY_CHUNKS.join("")]]) &&
          text === FAKE_OPENCODE_REPLY_CHUNKS.join("") && !leak.leakedText,
        JSON.stringify({ title: titled?.title, pairs, leak }),
      );
      await sleep(300);
      const summary = await client.rpc("cost.getSummary", { sessionId: session.id });
      record(
        "E2 命名臨時對話的用量(這次的總量)計入該 session 的成本 rollup(主對話本身不回報用量)",
        Math.abs(summary.session.costAmount - FAKE_TITLE_USAGE.cost) < 1e-9 &&
          summary.session.inputTokens === FAKE_TITLE_USAGE.tokens.input && summary.session.outputTokens === FAKE_TITLE_USAGE.tokens.output,
        JSON.stringify(summary.session),
      );
      const report = await fakeReport(client, session.id, OPENCODE_REPORT_SESSIONS);
      const titleSessions = (report ?? []).filter((s) => s.kind === "title");
      record(
        "E3 臨時 session 建立時沒有 parentID(不會被當成主 session 的 subagent)、用完就 DELETE",
        titleSessions.length === 1 && titleSessions[0].parentID === null && titleSessions[0].deleted === true,
        JSON.stringify(report),
      );
    });

    await step("E4 OpenCode 工具", async () => {
      const ws = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-title-octool-"));
      const message = `重構登入流程\n${TITLE_MODE_TOOL}`;
      const { session } = await client.rpc("session.create", { providerId: FAKE_OPENCODE, workingDir: ws });
      await client.drivePrompt(session.id, message);
      const titled = await waitForSession(client, session.id, (s) => s.titleSource === "auto");
      await sleep(500);
      const leak = leakReport(client, session.id);
      const report = await fakeReport(client, session.id, OPENCODE_REPORT_SESSIONS);
      const titleSession = (report ?? []).find((s) => s.kind === "title");
      record(
        "E4 OpenCode 臨時對話嘗試用工具:權限請求被直接 reject(沒轉給主 session、沒進 waiting)、工具沒執行、退回截取首句、臨時 session 被刪",
        titled?.title === "重構登入流程" && !existsSync(path.join(ws, TITLE_TOOL_MARKER_FILE)) &&
          leak.permissionRequests === 0 && !leak.wentWaiting && !leak.leakedText &&
          JSON.stringify(titleSession?.permissionReplies) === JSON.stringify(["reject"]) && titleSession?.deleted === true,
        JSON.stringify({ title: titled?.title, leak, titleSession }),
      );
      try { rmSync(ws, { recursive: true, force: true }); } catch {}
    });

    await step("E5 OpenCode 失敗", async () => {
      const message = `把測試覆蓋率補到八成\n${TITLE_MODE_REFUSE}`;
      const { session } = await client.rpc("session.create", { providerId: FAKE_OPENCODE, workingDir: dirs.workspaceDir });
      await client.drivePrompt(session.id, message);
      const titled = await waitForSession(client, session.id, (s) => s.titleSource === "auto");
      const after = await getSession(client, session.id);
      record(
        "E5 OpenCode 臨時對話失敗(session.error):退回截取首句,主 session 沒有變成 error",
        titled?.title === "把測試覆蓋率補到八成" && after?.status === "idle",
        JSON.stringify([titled?.title, after?.status]),
      );
    });

    // ---- F. session.autoTitle(「AI 重新命名」)-------------------------------------------------
    await step("F autoTitle", async () => {
      const before = await history(client, userTitledId);
      const result = await client.rpc("session.autoTitle", { sessionId: userTitledId }, 20_000);
      const after = await history(client, userTitledId);
      record(
        "F1 AI 重新命名:即使是使用者取的標題也照使用者的要求重新產生(method agent、applied、titleSource auto),對話歷史一則都沒多",
        result.method === "agent" && result.applied === true && result.session.titleSource === "auto" &&
          result.session.title === fakeTitleFor("這則訊息不該被拿去命名") && after.length === before.length,
        JSON.stringify({ result: [result.method, result.applied, result.session.title], before: before.length, after: after.length }),
      );
      const { session: empty } = await client.rpc("session.create", { providerId: FAKE_ACP, workingDir: dirs.workspaceDir });
      const codes = await Promise.all([
        errorCodeOf(client.rpc("session.autoTitle", { sessionId: empty.id })),
        errorCodeOf(client.rpc("session.autoTitle", { sessionId: "no-such-session" })),
      ]);
      const pty = await client.rpc("session.autoTitle", { sessionId: ptySessionId });
      record(
        "F2 沒有文字訊息 → session.autoTitleNoContent、找不到 → entity.notFound;PTY → method fallback",
        codes[0] === "session.autoTitleNoContent" && codes[1] === "entity.notFound" && pty.method === "fallback" && pty.session.title === "echo pty 也要有標題",
        JSON.stringify({ codes, pty: [pty.method, pty.session.title] }),
      );
    });

    // ---- G. create_session 工具開的 session ------------------------------------------------------
    await step("G create_session", async () => {
      const { session: caller } = await client.rpc("session.create", { providerId: FAKE_ACP, workingDir: dirs.workspaceDir, title: "呼叫者" });
      const args = { agent: FAKE_ACP, prompt: "子任務:整理待辦清單" };
      const { text } = await client.drivePrompt(caller.id, `${CALL_BRIDGE_TOOL_PREFIX}${JSON.stringify({ tool: "create_session", args })}`, 60_000);
      const { sessions } = await client.rpc("session.list", {});
      const child = sessions.find((s) => s.parentSessionId === caller.id);
      await sleep(1_000);
      const childAfter = child ? await getSession(client, child.id) : undefined;
      record(
        "G create_session 工具開的 session:titleSource user(標題沿用「<呼叫者>」開的 session),第一則訊息之後也不自動命名",
        child?.titleSource === "user" && childAfter?.title === "「呼叫者」開的 session" && childAfter?.titleSource === "user",
        JSON.stringify({ reply: text.slice(0, 120), child: [child?.title, child?.titleSource], after: [childAfter?.title, childAfter?.titleSource] }),
      );
    });

    // ---- M2. 重啟後保留 --------------------------------------------------------------------
    await step("M2 重啟", async () => {
      client.close();
      await killProcessTree(coreProc, "core");
      coreProc = startCore(dirs);
      await waitForPort(gatewayUrl, 20_000);
      client = new GatewayClient(gatewayUrl);
      await client.connect();
      const renamed = await getSession(client, persisted.renamed.id);
      const auto = await getSession(client, persisted.auto.id);
      const legacy = await getSession(client, "legacy-named");
      record(
        "M2 重啟 core(遷移再跑一次)不會改掉已有的標題來源:user/auto/舊資料的 user 都保留",
        renamed?.title === persisted.renamed.title && renamed?.titleSource === "user" &&
          auto?.title === persisted.auto.title && auto?.titleSource === "auto" && legacy?.titleSource === "user",
        JSON.stringify({ renamed: [renamed?.title, renamed?.titleSource], auto: [auto?.title, auto?.titleSource], legacy: legacy?.titleSource }),
      );
    });
  } catch (err) {
    console.error(`\n[FATAL] ${err instanceof Error ? err.stack : String(err)}`);
    record("setup", false, String(err));
  } finally {
    if (client) client.close();
    await killProcessTree(coreProc, "core");
    for (const dir of Object.values(dirs)) {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n${"=".repeat(50)}`);
  console.log(`session 標題 e2e 結果 (${elapsed}s)`);
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
