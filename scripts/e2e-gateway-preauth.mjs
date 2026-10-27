#!/usr/bin/env node
/**
 * scripts/e2e-gateway-preauth.mjs
 *
 * 2026-10-27:WS gateway 在認證之前不得讓 core 做昂貴的解析(GHSA-mrhx-c7xc-m3w5 的實際暴露面)。
 *
 * ---- 背景 ----------------------------------------------------------------
 *
 * 修正前 `handleMessage()` 對**每一則**訊息先跑完整的 `ClientRequestSchema.parse()`,認證閘門在那之後;
 * `WebSocketServer` 沒設 `maxPayload`(ws 預設 100 MiB)。zod 3 對陣列每個不合格的元素各產生一個 issue,
 * `settings.setEnabledModels` 的 `enabledModelIds` 又是不設上限的 `z.array(z.string())`——實測 1M 個元素
 * (payload 1.9 MB)heap 多 ~265 MB,而 `err.message`(189 MB 的整份 issue 清單)會被原封不動地放進錯誤回應的
 * `detail`。100 MiB 的 payload 外推約 50M 個 issue → core OOM;開了 `DESKMONY_BIND_HOST` 遠端存取時,
 * 網路上的人不用 token 就能打掛 core。
 *
 * ---- 驗什麼 --------------------------------------------------------------
 *
 * 一個 core,以設了 `DESKMONY_AUTH_TOKEN` 的環境啟動(只有這種模式才有「尚未認證」的連線;對外綁定必須設 token,
 * 見 apps/core/src/index.ts 的 `validateBindSafety()`)。不建 session、不啟動任何 agent。
 *
 *   GP1  前提:未認證的 `session.list` 被拒、帶錯 token 的 auth 被拒並關閉連線。
 *   GP2  未認證、64 KiB 以內、塞了 25,000 個不合格元素的 `settings.setEnabledModels` → `AUTH_NOT_YET_AUTHENTICATED`
 *        (不是 `GATEWAY_INVALID_REQUEST`——代表完整 schema 根本沒跑),回應不到 1 KB;同一條連線之後仍能用正確 token 認證。
 *        修正前:`GATEWAY_INVALID_REQUEST`,`detail` 是好幾 MB 的 issue 清單。
 *   GP3  未認證的 `auth` 本身格式不對(`token` 是 25,000 個元素的陣列)→ `GATEWAY_INVALID_REQUEST`,`detail` 只有一個 issue。
 *   GP4  未認證、帶 `dmbt_` 前綴的假 scoped token → 仍走 scoped token 那條路徑被拒(錯誤訊息是 scoped 的那一句)並關閉連線。
 *   GP5  未認證、超過 64 KiB 的訊息(200,000 個元素)→ 不解析就以 1009 關閉連線,沒有任何回應。
 *   GP6  已認證、50,000 個不合格元素 → `GATEWAY_INVALID_REQUEST`,`detail` 只列前幾個 issue 並註明總數,回應不到 3 KB。
 *        修正前:`detail` 約 7 MB。
 *   GP7  `maxPayload`:raw socket 送一個宣稱長度為 `GATEWAY_MAX_MESSAGE_BYTES + 1` 的 frame header(不送 body)→ ws 讀到
 *        header 就以 1009 關閉。修正前(100 MiB 預設值)這個長度合法,server 會一直等 body,這裡等不到關閉。
 *   GP8  已認證、帶兩個上限大小(10 MB → base64 約 14 MB)附件的 `session.sendPrompt`(約 28 MB)→ 通過 ws 與 schema,
 *        由 dispatch 回「session 沒在跑」——上限沒有把合法的大訊息擋掉。
 *   GP9  上面這些之後 core 仍正常:新連線帶正確 token 認證、`session.list` 成功。
 *
 * core 的 DESKMONY_HOME/DATA_DIR/WORKSPACE/CORE_PORT 都指向暫存目錄;只砍自己 spawn 的那個 core。
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import os from "node:os";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireFreshBuild } from "./lib/require-fresh-build.mjs";
import { e2eProvidersEnv } from "./lib/e2e-providers.mjs";

requireFreshBuild();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const CORE_ENTRY = path.join(REPO_ROOT, "apps", "core", "dist", "index.js");
const SHARED_ENTRY = path.join(REPO_ROOT, "packages", "shared", "dist", "index.js");
/** 避開其他 e2e 用過的 port(見 e2e-cli.mjs 檔頭的盤點;47xx 已用到 4760)。 */
const PORT = 4765;
const WS_URL = `ws://127.0.0.1:${PORT}`;
const MASTER_TOKEN = `e2e-preauth-${randomBytes(16).toString("hex")}`;

const { ErrorCodes, GATEWAY_MAX_MESSAGE_BYTES } = await import(pathToFileURL(SHARED_ENTRY).href);

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `\n      ${detail}` : ""}`);
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 數字陣列的 JSON(每個元素 "0,",每個都不是 string——zod 會各產生一個 issue)。 */
const badArray = (n) => new Array(n).fill(0);

// =======================================================================
/**
 * 最小的 WS client:記下每則回應的原始大小與連線關閉的 code/reason。用 Node 內建的 WebSocket(不帶 Origin,
 * 比照桌面殼以外的非瀏覽器 client)。
 */
class Conn {
  constructor() {
    this.pending = new Map();
    this.closed = undefined;
    this.closeWaiters = [];
  }

  async open() {
    this.ws = new WebSocket(WS_URL);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`WS connect timeout (${WS_URL})`)), 10_000);
      this.ws.addEventListener("open", () => {
        clearTimeout(t);
        resolve();
      });
      this.ws.addEventListener("error", (e) => {
        clearTimeout(t);
        reject(new Error(`WS error (${WS_URL}): ${e.message ?? e}`));
      });
    });
    this.ws.addEventListener("message", (e) => {
      const text = typeof e.data === "string" ? e.data : Buffer.from(e.data).toString();
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      if (msg.kind !== "response") return;
      const waiter = this.pending.get(msg.id);
      if (waiter) {
        this.pending.delete(msg.id);
        waiter({ response: msg, bytes: Buffer.byteLength(text) });
      }
    });
    this.ws.addEventListener("close", (e) => {
      this.closed = { code: e.code, reason: e.reason };
      for (const waiter of this.pending.values()) waiter({ closed: this.closed });
      this.pending.clear();
      for (const w of this.closeWaiters) w(this.closed);
      this.closeWaiters = [];
    });
    return this;
  }

  /** 送出原始文字,等對應 id 的回應或連線關閉(先到的那個)。 */
  request(id, text, timeoutMs = 15_000) {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        resolve({ timeout: true });
      }, timeoutMs);
      this.pending.set(id, (outcome) => {
        clearTimeout(t);
        resolve(outcome);
      });
      this.ws.send(text);
    });
  }

  rpc(method, params, timeoutMs) {
    const id = randomUUID();
    return this.request(id, JSON.stringify({ id, method, params }), timeoutMs);
  }

  waitClosed(timeoutMs) {
    if (this.closed) return Promise.resolve(this.closed);
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(undefined), timeoutMs);
      this.closeWaiters.push((c) => {
        clearTimeout(t);
        resolve(c);
      });
    });
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
  }
}

const fmt = (outcome) =>
  outcome.timeout
    ? "逾時(沒有回應也沒有關閉)"
    : outcome.closed
      ? `連線關閉 code=${outcome.closed.code} reason=${outcome.closed.reason}`
      : `ok=${outcome.response.ok} errorCode=${outcome.response.errorCode} bytes=${outcome.bytes} error=${String(outcome.response.error).slice(0, 160)}`;

// =======================================================================
function startCore({ dataDir, homeDir, workspaceDir }) {
  const env = {
    ...process.env,
    DESKMONY_CORE_PORT: String(PORT),
    DESKMONY_DATA_DIR: dataDir,
    DESKMONY_HOME: homeDir,
    DESKMONY_WORKSPACE: workspaceDir,
    DESKMONY_AUTH_TOKEN: MASTER_TOKEN,
    ...e2eProvidersEnv(),
  };
  const proc = spawn(process.execPath, [CORE_ENTRY], { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdoutBuffer = "";
  const dbPathPromise = new Promise((resolve) => {
    proc.stdout.on("data", (chunk) => {
      process.stdout.write(`[core:${PORT}] ${chunk}`);
      stdoutBuffer += chunk.toString();
      const m = stdoutBuffer.match(/\[db\] using sqlite file at (.+)/);
      if (m) resolve(m[1].trim());
    });
  });
  proc.stderr.on("data", (chunk) => process.stderr.write(`[core:${PORT}:err] ${chunk}`));
  return { proc, dbPathPromise };
}

async function waitForPort(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const c = await new Conn().open();
      c.close();
      return;
    } catch (err) {
      lastErr = err;
      await sleep(300);
    }
  }
  throw new Error(`等待 gateway 啟動逾時: ${lastErr}`);
}

/** 只砍這支測試自己 spawn 的那一個 core(連同它的子程序樹),絕不 blanket kill。 */
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

async function authed() {
  const c = await new Conn().open();
  const out = await c.rpc("auth", { token: MASTER_TOKEN });
  if (!out.response?.ok) throw new Error(`正確 token 認證失敗:${fmt(out)}`);
  return c;
}

// =======================================================================
async function testPremise() {
  const anon = await new Conn().open();
  const listed = await anon.rpc("session.list", {});
  anon.close();
  const wrong = await new Conn().open();
  const wrongAuth = await wrong.rpc("auth", { token: `wrong-${randomUUID()}` });
  const wrongClosed = await wrong.waitClosed(5_000);
  record(
    "GP1 前提:core 以 DESKMONY_AUTH_TOKEN 啟動——未認證的 session.list 被拒、帶錯 token 的 auth 被拒並關閉連線",
    listed.response?.errorCode === ErrorCodes.AUTH_NOT_YET_AUTHENTICATED &&
      wrongAuth.response?.errorCode === ErrorCodes.AUTH_INVALID_TOKEN &&
      wrongClosed?.code === 1008,
    `session.list: ${fmt(listed)} / 錯 token: ${fmt(wrongAuth)} / close=${wrongClosed?.code}`,
  );
}

async function testPreAuthSmallBadArray() {
  const c = await new Conn().open();
  const id = randomUUID();
  const text = JSON.stringify({ id, method: "settings.setEnabledModels", params: { enabledModelIds: badArray(25_000) } });
  const out = await c.request(id, text);
  const authAfter = c.closed ? undefined : await c.rpc("auth", { token: MASTER_TOKEN });
  c.close();
  record(
    "GP2 未認證、64 KiB 以內、25,000 個不合格元素 → 解析前就回 AUTH_NOT_YET_AUTHENTICATED(回應 < 1 KB),同一條連線之後仍能用正確 token 認證",
    text.length <= 64 * 1024 &&
      out.response?.errorCode === ErrorCodes.AUTH_NOT_YET_AUTHENTICATED &&
      out.response?.id === id &&
      out.bytes < 1024 &&
      authAfter?.response?.ok === true,
    `payload=${text.length} bytes / ${fmt(out)} / 之後的 auth: ${authAfter ? fmt(authAfter) : "連線已關閉"}`,
  );
}

async function testPreAuthMalformedAuth() {
  const c = await new Conn().open();
  const id = randomUUID();
  const out = await c.request(id, JSON.stringify({ id, method: "auth", params: { token: badArray(25_000) } }));
  c.close();
  const detail = out.response?.errorParams?.detail ?? "";
  record(
    "GP3 未認證的 auth 本身格式不對(token 是 25,000 個元素的陣列)→ GATEWAY_INVALID_REQUEST,detail 只有一個 issue",
    out.response?.errorCode === ErrorCodes.GATEWAY_INVALID_REQUEST &&
      detail.includes("params.token") &&
      !detail.includes("more issues") &&
      out.bytes < 1024,
    `${fmt(out)} / detail=${JSON.stringify(detail)}`,
  );
}

async function testPreAuthFakeScopedToken() {
  const c = await new Conn().open();
  const out = await c.rpc("auth", { token: `dmbt_${randomBytes(32).toString("hex")}` });
  const closed = await c.waitClosed(5_000);
  record(
    "GP4 未認證、帶 dmbt_ 前綴的假 scoped token → 仍由 scoped token 那條路徑拒絕(不是 master token 的比對)並關閉連線",
    out.response?.errorCode === ErrorCodes.AUTH_INVALID_TOKEN && String(out.response?.error).includes("scoped") && closed?.code === 1008,
    `${fmt(out)} / close=${closed?.code}`,
  );
}

async function testPreAuthOversized() {
  const c = await new Conn().open();
  const id = randomUUID();
  const text = JSON.stringify({ id, method: "settings.setEnabledModels", params: { enabledModelIds: badArray(200_000) } });
  const started = Date.now();
  const out = await c.request(id, text);
  const elapsed = Date.now() - started;
  record(
    "GP5 未認證、超過 64 KiB 的訊息(200,000 個元素)→ 不解析、不回應,直接以 1009 關閉連線",
    out.closed?.code === 1009 && !out.response,
    `payload=${text.length} bytes / ${fmt(out)} / ${elapsed}ms`,
  );
}

async function testAuthedBadArrayDetail() {
  const c = await authed();
  const out = await c.rpc("settings.setEnabledModels", { enabledModelIds: badArray(50_000) });
  c.close();
  const detail = out.response?.errorParams?.detail ?? "";
  record(
    "GP6 已認證、50,000 個不合格元素 → GATEWAY_INVALID_REQUEST,detail 只列前幾個 issue 並註明其餘數量(回應 < 3 KB)",
    out.response?.errorCode === ErrorCodes.GATEWAY_INVALID_REQUEST &&
      detail.includes("params.enabledModelIds.0") &&
      detail.includes("(+49997 more issues)") &&
      detail.length <= 1_001 &&
      out.bytes < 3 * 1024,
    `${fmt(out)} / detail=${JSON.stringify(detail.slice(0, 300))}`,
  );
}

/**
 * 自己做 WS 握手,再送一個宣稱 payload 長度為 `length` 的 binary frame header(不送 body),回傳 server 送來的
 * close frame 的 code;`timeoutMs` 內沒關就回傳 undefined。不配置任何大 buffer。
 */
function sendOversizedFrameHeader(length, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(PORT, "127.0.0.1");
    let buffered = Buffer.alloc(0);
    let upgraded = false;
    const finish = (value) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    socket.on("error", (err) => {
      clearTimeout(timer);
      if (upgraded) resolve(undefined);
      else reject(err);
    });
    socket.on("connect", () => {
      socket.write(
        [
          "GET / HTTP/1.1",
          `Host: 127.0.0.1:${PORT}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
          "Sec-WebSocket-Version: 13",
          "",
          "",
        ].join("\r\n"),
      );
    });
    socket.on("data", (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (!upgraded) {
        const end = buffered.indexOf("\r\n\r\n");
        if (end < 0) return;
        const head = buffered.subarray(0, end).toString();
        if (!head.startsWith("HTTP/1.1 101")) {
          clearTimeout(timer);
          socket.destroy();
          reject(new Error(`WS 握手失敗:${head.split("\r\n")[0]}`));
          return;
        }
        upgraded = true;
        buffered = buffered.subarray(end + 4);
        // FIN + binary;MASK + 64-bit 長度;4 bytes mask key。之後不送 body。
        const header = Buffer.alloc(14);
        header[0] = 0x82;
        header[1] = 0x80 | 127;
        header.writeBigUInt64BE(BigInt(length), 2);
        randomBytes(4).copy(header, 10);
        socket.write(header);
      }
      // server → client 的 frame 不加 mask;close frame = 0x88、長度、2 bytes code。
      if (buffered.length >= 4 && buffered[0] === 0x88) finish(buffered.readUInt16BE(2));
    });
  });
}

async function testMaxPayload() {
  const length = GATEWAY_MAX_MESSAGE_BYTES + 1;
  const code = await sendOversizedFrameHeader(length, 5_000);
  record(
    `GP7 maxPayload:frame header 宣稱 ${length} bytes(GATEWAY_MAX_MESSAGE_BYTES + 1,低於 ws 預設的 100 MiB)→ 讀到 header 就以 1009 關閉`,
    GATEWAY_MAX_MESSAGE_BYTES < 100 * 1024 * 1024 && code === 1009,
    `GATEWAY_MAX_MESSAGE_BYTES=${GATEWAY_MAX_MESSAGE_BYTES} / close code=${code ?? "5 秒內沒有關閉"}`,
  );
}

async function testLargeLegitMessage() {
  const c = await authed();
  // 桌面端單一附件上限 10 MB(ChatView.tsx 的 MAX_ATTACHMENT_BYTES),base64 之後約 14 MB。
  const data = Buffer.alloc(10 * 1024 * 1024, 0x41).toString("base64");
  const attachment = { type: "image", mediaType: "image/png", data };
  const sessionId = `e2e-missing-${randomUUID()}`;
  const id = randomUUID();
  const text = JSON.stringify({
    id,
    method: "session.sendPrompt",
    params: { sessionId, prompt: { text: "hi", attachments: [attachment, attachment] } },
  });
  const out = await c.request(id, text, 60_000);
  c.close();
  record(
    "GP8 已認證、兩個上限大小附件的 session.sendPrompt(約 28 MB)→ 通過 ws 與 schema,由 dispatch 回 session 沒在跑(SESSION_NOT_RUNNING)",
    out.response?.ok === false && out.response?.errorCode === ErrorCodes.SESSION_NOT_RUNNING,
    `payload=${text.length} bytes / ${fmt(out)}`,
  );
}

async function testStillHealthy() {
  const c = await authed();
  const out = await c.rpc("session.list", {});
  c.close();
  record("GP9 上面這些之後 core 仍正常:新連線帶正確 token 認證、session.list 成功", out.response?.ok === true, fmt(out));
}

// =======================================================================
async function main() {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-preauth-data-"));
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-preauth-home-"));
  const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-preauth-ws-"));

  let core;
  try {
    core = startCore({ dataDir, homeDir, workspaceDir });
    const dbPath = await Promise.race([core.dbPathPromise, sleep(20_000).then(() => undefined)]);
    const normalize = (p) => path.resolve(p).toLowerCase();
    if (!dbPath || !normalize(dbPath).startsWith(normalize(dataDir))) {
      throw new Error(`core 的 SQLite 路徑不在暫存目錄底下(${dbPath ?? "沒印出來"},預期在 ${dataDir} 底下)——已中止`);
    }
    await waitForPort(20_000);

    await testPremise();
    await testPreAuthSmallBadArray();
    await testPreAuthMalformedAuth();
    await testPreAuthFakeScopedToken();
    await testPreAuthOversized();
    await testAuthedBadArrayDetail();
    await testMaxPayload();
    await testLargeLegitMessage();
    await testStillHealthy();
  } catch (err) {
    record("執行過程發生未預期錯誤", false, err instanceof Error ? err.stack : String(err));
  } finally {
    await killProcessTree(core?.proc);
    for (const dir of [dataDir, homeDir, workspaceDir]) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n\n========== 總結:${results.length - failed.length}/${results.length} 通過 ==========`);
  for (const r of failed) console.log(`  FAIL: ${r.name}`);
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[e2e-gateway-preauth] fatal:", err);
  process.exit(1);
});
