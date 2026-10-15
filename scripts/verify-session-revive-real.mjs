#!/usr/bin/env node
/**
 * scripts/verify-session-revive-real.mjs
 *
 * 2026-10-15:session 自動復活的**真實 agent 手動驗證**(不是 `pnpm test` 的一部分——會呼叫真實模型、花真的錢,
 * 需要本機已登入的 agent;決定性的假後端版本是 e2e-session-revive.mjs)。
 *
 * 對一個 provider 做:建 session → 送「請記住:我的幸運數字是 7391。只回覆 OK」→ 走 `shutdownAll()` 的正常關閉 → 用同樣的隔離目錄重啟 core
 * → 對同一個 session 送「我的幸運數字是多少?只回答數字」→ 確認回答包含暗號;並印出走的是哪條路(從 core 的 log 與 DB 裡的系統說明判斷)。
 *
 * 隔離:core 的 `DESKMONY_HOME` / `DESKMONY_DATA_DIR` / `DESKMONY_WORKSPACE` / `DESKMONY_CORE_PORT` 全部指到暫存目錄與專用 port,
 * 啟動後檢查 log 第一行 `[db] using sqlite file at ...` 真的在暫存目錄——不是的話立刻停掉,絕不碰使用者真實的 ~/.deskmony。
 * 只會殺它自己啟動的 core 行程(用 PID),不會碰使用者桌面 app 的 core。
 *
 * 用法:node scripts/verify-session-revive-real.mjs <providerId> [port] [暫存根目錄] [bogus-backend-id]
 *   model=<id> effort=<值>:建立後、送第一則訊息前用 session.setModel / session.setEffort 換成這組(非預設)選擇,重啟復活後
 *     檢查 `Session.options` 的目前值還是這組、model/effort 沒被重設,並且 agent 仍然記得暗號。例:
 *     `node scripts/verify-session-revive-real.mjs codex 4911 D:\\tmp model=gpt-5.6-luna effort=low`
 *   bogus-backend-id:兩個 core 之間把 DB 裡的後端識別碼改成一個不存在的值,模擬「agent 那邊的歷史已經不在」——驗證退回
 *     對話紀錄的路(真實 agent 讀到 Deskmony 附上的紀錄後能不能答出暗號)。
 *   providerId:`codex`(ACP)、`opencode`(HTTP)、`claude-agent-sdk`、`opencode-acp`、`gemini`……(provider 目錄裡的 id)
 *   port:預設 4911(請用 4911~4919 的專用 port)
 * 前置需求:`pnpm build` 已跑過。
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const CORE_ENTRY = path.join(REPO_ROOT, "apps", "core", "dist", "index.js");

const providerId = process.argv[2];
const basePort = Number(process.argv[3] ?? 4911);
const tmpRoot = process.argv[4] ?? os.tmpdir();
const extraArgs = process.argv.slice(5);
const bogusBackendId = extraArgs.includes("bogus-backend-id");
const wantModel = extraArgs.find((a) => a.startsWith("model="))?.slice("model=".length);
const wantEffort = extraArgs.find((a) => a.startsWith("effort="))?.slice("effort=".length);
if (!providerId || !Number.isInteger(basePort) || basePort < 4911 || basePort > 4918) {
  console.error("用法: node scripts/verify-session-revive-real.mjs <providerId> [port 4911~4918] [暫存根目錄]");
  process.exit(2);
}

// 2026-10-15:原本用「暗號」,gpt-5.6-luna 會把它當機密拒答("我不能透露暗號")——那是模型行為,不是記憶問題;改用中性的事實。
const SECRET = "7391";
const FIRST_PROMPT = `請記住:我的幸運數字是 ${SECRET}。只回覆 OK`;
const SECOND_PROMPT = "我的幸運數字是多少？只回答數字";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (...args) => console.log(`[verify:${providerId}]`, ...args);

mkdirSync(tmpRoot, { recursive: true });
const root = mkdtempSync(path.join(tmpRoot, `real-revive-${providerId.replace(/[^a-z0-9-]/gi, "_")}-`));
const dirs = {
  dataDir: path.join(root, "data"),
  homeDir: path.join(root, "home"),
  workspaceDir: path.join(root, "workspace"),
};
for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
// 讓 workspace 看起來像一個普通的小專案(有些 agent 會讀目錄)。
writeFileSync(path.join(dirs.workspaceDir, "README.md"), "# scratch workspace for session-revive verification\n", "utf8");

// 啟動殼:收到 IPC 訊息就 emit SIGTERM,走 index.ts 真正的 shutdown handler(→ shutdownAll())。見 e2e-crash-recovery-graceful-bootstrap.mjs。
const wrapper = path.join(root, "core-wrapper.mjs");
writeFileSync(
  wrapper,
  `process.on("message", (m) => { if (m === "graceful-shutdown") process.emit("SIGTERM"); });\nawait import(${JSON.stringify(pathToFileURL(CORE_ENTRY).href)});\n`,
  "utf8",
);

class Client {
  constructor(url) {
    this.url = url;
    this.pending = new Map();
    this.events = [];
  }
  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("WS connect timeout")), 10_000);
      this.ws.addEventListener("open", () => (clearTimeout(t), resolve()));
      this.ws.addEventListener("error", () => (clearTimeout(t), reject(new Error("WS error"))));
    });
    this.ws.addEventListener("message", (e) => {
      const msg = JSON.parse(typeof e.data === "string" ? e.data : e.data.toString());
      if (msg.kind === "response") {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(Object.assign(new Error(msg.error ?? "gateway error"), { errorCode: msg.errorCode }));
      } else if (msg.kind === "event" && msg.channel === "session-event") {
        this.events.push(msg.payload);
      }
    });
  }
  rpc(method, params, timeoutMs = 120_000) {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => (this.pending.delete(id), reject(new Error(`rpc ${method} 逾時`))), timeoutMs);
      this.pending.set(id, { resolve: (v) => (clearTimeout(t), resolve(v)), reject: (e) => (clearTimeout(t), reject(e)) });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() {
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }
}

/** 啟動一個隔離的 core;確認 DB 在暫存目錄之後才回傳。 */
async function bootCore(port) {
  const lines = [];
  const proc = spawn(process.execPath, [wrapper], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DESKMONY_HOME: dirs.homeDir,
      DESKMONY_DATA_DIR: dirs.dataDir,
      DESKMONY_WORKSPACE: dirs.workspaceDir,
      DESKMONY_CORE_PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const onData = (chunk) => {
    for (const line of chunk.toString().split(/\r?\n/)) if (line.trim()) lines.push(line);
  };
  proc.stdout.on("data", onData);
  proc.stderr.on("data", onData);

  // 第一行 `[db] using sqlite file at ...` 必須指向暫存目錄。
  const deadline = Date.now() + 30_000;
  let dbLine;
  while (Date.now() < deadline && !dbLine) {
    dbLine = lines.find((l) => l.includes("[db] using sqlite file at"));
    if (!dbLine) await sleep(100);
  }
  const expected = path.resolve(dirs.dataDir).toLowerCase();
  if (!dbLine || !path.resolve(dbLine.split("sqlite file at ")[1].trim()).toLowerCase().startsWith(expected)) {
    spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
    throw new Error(`core 的 DB 沒有指向隔離目錄,已停止。log: ${dbLine ?? "(沒有 [db] 那一行)"}`);
  }
  log(`core pid=${proc.pid} port=${port} → ${dbLine.trim()}`);

  for (;;) {
    if (Date.now() > deadline + 30_000) throw new Error("等待 gateway 逾時");
    try {
      const client = new Client(`ws://127.0.0.1:${port}`);
      await client.connect();
      return { proc, client, lines };
    } catch {
      await sleep(300);
    }
  }
}

async function turn(client, sessionId, text, timeoutMs = 240_000) {
  const from = client.events.length;
  await client.rpc("session.sendPrompt", { sessionId, prompt: { text } }, timeoutMs);
  const start = Date.now();
  for (;;) {
    const done = client.events.slice(from).find((e) => e.sessionId === sessionId && (e.event.type === "completed" || e.event.type === "error"));
    if (done) {
      const reply = client.events
        .slice(from)
        .filter((e) => e.sessionId === sessionId && e.event.type === "message-delta")
        .map((e) => e.event.delta)
        .join("");
      return { reply, final: done.event };
    }
    if (Date.now() - start > timeoutMs) throw new Error("等待這一輪結束逾時");
    await sleep(100);
  }
}

async function shutdownGracefully(proc) {
  const exited = new Promise((resolve) => proc.once("exit", (code) => resolve(code)));
  proc.send("graceful-shutdown");
  const code = await Promise.race([exited, sleep(30_000).then(() => "timeout")]);
  return code;
}

let core;
let failed = true;
try {
  // ---------------------------------------------------------------- 第一個 core:建 session、送暗號
  core = await bootCore(basePort);
  const { session } = await core.client.rpc("session.create", {
    providerId,
    workingDir: dirs.workspaceDir,
    title: `real-revive-${providerId}`, // 明確給標題,避免第一則訊息觸發 AI 自動命名(多花一次推論)
  });
  log(`session=${session.id} adapterType=${session.adapterType} model=${session.model ?? "(agent 預設)"}`);
  {
    // ACP 的選項要等 session 開起來才知道(options 在記憶體裡,稍後才到);沒指定要換的值時也印出來,方便挑合法的值。
    const listOptions = async () => (await core.client.rpc("session.list", {})).sessions.find((x) => x.id === session.id);
    const waitMs = wantModel || wantEffort ? 10_000 : 3_000;
    for (let i = 0; i < waitMs / 100 && !(await listOptions())?.options?.model && !(await listOptions())?.options?.effort; i++) await sleep(100);
    const initial = await listOptions();
    log(`建立後 options: model=${initial?.options?.model?.current} (${initial?.options?.model?.choices?.map((c) => c.value).join(",")}) effort=${initial?.options?.effort?.current} (${initial?.options?.effort?.choices?.map((c) => c.value).join(",")})`);
    if (!wantModel && !wantEffort) {
      // 不換,只看選項。
    } else {
    if (wantModel) await core.client.rpc("session.setModel", { sessionId: session.id, model: wantModel });
    if (wantEffort) await core.client.rpc("session.setEffort", { sessionId: session.id, effort: wantEffort });
    await sleep(500);
    const changed = await listOptions();
    log(`換成非預設後: session.model=${changed?.model} session.effort=${changed?.effort}; options.model=${changed?.options?.model?.current} options.effort=${changed?.options?.effort?.current}`);
    }
  }
  const first = await turn(core.client, session.id, FIRST_PROMPT);
  log(`第一輪(${first.final.type}) agent 回覆: ${JSON.stringify(first.reply)}`);
  if (first.final.type !== "completed") throw new Error(`第一輪沒有正常結束: ${JSON.stringify(first.final)}`);
  await sleep(1500); // 讓 backendSessionId 的寫入落地
  const { sessions: before } = await core.client.rpc("session.list", {});
  const beforeInfo = before.find((s) => s.id === session.id);
  log(`關閉前: status=${beforeInfo.status} backendSessionId=${beforeInfo.backendSessionId ?? "(尚未捕捉)"}`);

  core.client.close();
  const exitCode = await shutdownGracefully(core.proc);
  log(`正常關閉(shutdownAll) exit=${exitCode}; core log 含 "shutting down": ${core.lines.some((l) => l.includes("shutting down"))}`);
  core = undefined;

  if (bogusBackendId) {
    // better-sqlite3 不是這支腳本的直接依賴,借用 apps/core 已安裝好的那一份(同 e2e-crash-recovery.mjs)。
    const { default: Database } = await import(
      pathToFileURL(path.join(REPO_ROOT, "apps", "core", "node_modules", "better-sqlite3", "lib", "index.js")).href
    );
    const db = new Database(path.join(dirs.dataDir, "deskmony.db"));
    db.prepare("UPDATE sessions SET backend_session_id = ? WHERE id = ?").run(`bogus-${randomUUID()}`, session.id);
    db.close();
    log("已把 DB 裡的後端識別碼改成不存在的值(模擬 agent 那邊的歷史已不在)");
  }

  // ---------------------------------------------------------------- 第二個 core:同樣的隔離目錄,重啟
  core = await bootCore(basePort + 1);
  const { sessions: after } = await core.client.rpc("session.list", {});
  const reopened = after.find((s) => s.id === session.id);
  log(`重啟後: status=${reopened?.status}(預期 closed) backendSessionId=${reopened?.backendSessionId ?? "(無)"}`);
  log(`重啟後復活前: options=${JSON.stringify(reopened?.options ?? null)}(純記憶體,預期是空的) model=${reopened?.model} effort=${reopened?.effort}`);
  const mark = core.lines.length;
  const second = await turn(core.client, session.id, SECOND_PROMPT);
  log(`第二輪(${second.final.type}) agent 回覆: ${JSON.stringify(second.reply)}`);
  const hasSecret = second.reply.includes(SECRET);

  const { messages } = await core.client.rpc("session.history", { sessionId: session.id });
  const notices = messages.filter((m) => m.role === "system").map((m) => m.content);
  const pathLines = core.lines
    .slice(mark - 40 < 0 ? 0 : mark - 40)
    .filter((l) => /acp-adapter|opencode-adapter|claude-sdk-adapter|session-manager\].*重新啟動/.test(l));
  log("走的路 — core log:");
  for (const l of pathLines) log("   ", l.length > 220 ? `${l.slice(0, 220)}…` : l);
  log(`走的路 — 對話裡的系統說明: ${notices.join(" | ")}`);
  log(`DB 訊息順序(重複重播的歷史會讓這串變長): ${messages.map((m) => m.role).join(",")}`);
  log(`DB 的 assistant 訊息: ${JSON.stringify(messages.filter((m) => m.role === "assistant").map((m) => m.content))}`);
  const userMessages = messages.filter((m) => m.role === "user").map((m) => m.content);
  log(`DB 的使用者訊息(必須是原文): ${JSON.stringify(userMessages)}`);
  const originals = userMessages[0] === FIRST_PROMPT && userMessages[1] === SECOND_PROMPT;
  log(`結論: 回答包含暗號=${hasSecret}; 使用者訊息維持原文=${originals}; session 最終狀態=${(await core.client.rpc("session.list", {})).sessions.find((s) => s.id === session.id)?.status}`);
  let optionsOk = true;
  if (wantModel || wantEffort) {
    let revived;
    for (let i = 0; i < 100; i++) {
      revived = (await core.client.rpc("session.list", {})).sessions.find((x) => x.id === session.id);
      if (revived?.options && (!wantModel || !revived.options.model || revived.options.model.current === wantModel) && (!wantEffort || revived.options.effort?.current === wantEffort)) break;
      await sleep(100);
    }
    log(`復活後: session.model=${revived?.model} session.effort=${revived?.effort}; options.model=${revived?.options?.model?.current} options.effort=${revived?.options?.effort?.current}`);
    // OpenCode(HTTP)不回報 model 選項(只有思考程度),所以 options.model 可能不存在:有就必須等於,沒有就只看 session.model。
    optionsOk =
      (!wantModel || (revived?.model === wantModel && (!revived.options?.model || revived.options.model.current === wantModel))) &&
      (!wantEffort || (revived?.effort === wantEffort && revived.options?.effort?.current === wantEffort));
    log(`model/effort 保留=${optionsOk}`);
    const setLines = core.lines.filter((l) => /set_config_option|session\/set|記住的/.test(l));
    for (const l of setLines) log("   ", l.length > 200 ? `${l.slice(0, 200)}…` : l);
  }
  failed = !(hasSecret && originals && optionsOk && second.final.type === "completed");

  // 收尾:先 session.delete 讓 adapter 收掉 agent 子行程,再停 core。
  await core.client.rpc("session.delete", { sessionId: session.id });
  core.client.close();
  const exit2 = await shutdownGracefully(core.proc);
  log(`收尾: session 已刪除, core exit=${exit2}`);
  core = undefined;
} catch (err) {
  console.error(`[verify:${providerId}] 失敗:`, err?.stack ?? err);
} finally {
  if (core) {
    core.client.close();
    spawnSync("taskkill", ["/pid", String(core.proc.pid), "/T", "/F"], { stdio: "ignore" });
  }
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
console.log(failed ? `[verify:${providerId}] 結果: FAIL` : `[verify:${providerId}] 結果: PASS`);
process.exit(failed ? 1 : 0);
