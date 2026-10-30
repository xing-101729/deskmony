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
 *   GP9  上面這些之後 core 仍正常:新連線帶正確 token 認證、`session.list` 成功(最後才跑)。
 *
 * 2026-10-30:已認證的連線(含持 scoped bridge token 的 agent 子行程)原本仍能讓 zod 逐元素產生 issue,數量只受
 * `maxPayload` 限制(64 MiB 的 `[0,0,…]` 約 32M 個)。core 現在 `JSON.parse` 之後先數陣列元素 + 物件屬性,超過
 * `GATEWAY_MAX_REQUEST_JSON_VALUES` 就不交給 zod:
 *
 *   GP10 已認證、`GATEWAY_MAX_REQUEST_JSON_VALUES + 1` 個不合格元素 → `GATEWAY_INVALID_REQUEST`,`detail` 是 JSON 值
 *        上限那一句,不是 zod 的 issue 摘要(代表 zod 沒跑)。修正前:`(+99998 more issues)`。
 *   GP11 同上,但多出來的值放在一個有 `GATEWAY_MAX_REQUEST_JSON_VALUES + 1` 個屬性的物件裡(走訪的物件分支)。
 *   (GP6 的 50,000 個元素在上限以內,仍由 zod 回報——上限沒有擋到正常大小的請求。)
 *
 * 2026-10-30:未認證連線的名額(`PRE_AUTH_MAX_CONNECTIONS` 等,見 ws-gateway.ts)。上面 GP5 的 64 KiB 檢查要等 ws 收完
 * 整則訊息,ws 先照 `maxPayload` 收進記憶體——沒有名額上限時,N 條未認證連線就能讓 core 暫存 N × 64 MiB。
 *
 *   GP12 非本機來源:從 127.0.0.2、127.0.0.3……連進來(core 只把 127.0.0.1 / ::1 當本機,見 `isLoopbackAddress()`)。
 *        同一個位址佔滿 4 條後第 5 條被拒(HTTP 429),其他位址不受影響;非本機合計 12 條後新位址也被拒(503),
 *        本機仍連得進來並能認證。平台不能用 127.0.0.2 當來源位址(macOS 預設)時略過。
 *   GP13 本機 16 條未認證連線佔滿名額 → 下一個升級請求被拒(503),Node 內建 WebSocket 也連不上。
 *   GP14 其中一條認證成功 → 名額立刻歸還:新的升級請求被接受,接受之後名額又滿(帳目精確)。
 *   GP15 其中一條未認證連線關閉 → 名額歸還,新的升級請求被接受。
 *   GP16 其餘未認證連線被 core 逾時關閉(1008)→ 名額全部歸還(已認證那條不佔名額):又能開滿 16 條,第 17 條被拒。
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
import { allocatePort, guardCorePort } from "./lib/e2e-ports.mjs";
import { e2eProvidersEnv } from "./lib/e2e-providers.mjs";

requireFreshBuild();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const CORE_ENTRY = path.join(REPO_ROOT, "apps", "core", "dist", "index.js");
const SHARED_ENTRY = path.join(REPO_ROOT, "packages", "shared", "dist", "index.js");
/** 2026-10-27:動態挑選,不再寫死——多個 worktree 同時跑 e2e 時才不會連到別人的 core(見 lib/e2e-ports.mjs)。 */
const PORT = await allocatePort();
const WS_URL = `ws://127.0.0.1:${PORT}`;
const MASTER_TOKEN = `e2e-preauth-${randomBytes(16).toString("hex")}`;

const { ErrorCodes, GATEWAY_MAX_MESSAGE_BYTES, GATEWAY_MAX_REQUEST_JSON_VALUES } = await import(
  pathToFileURL(SHARED_ENTRY).href
);

/** 與 apps/core/src/gateway/ws-gateway.ts 的同名常數同值(core 不匯出它們),改了要一起改。 */
const PRE_AUTH_MAX_CONNECTIONS = 16;
const PRE_AUTH_MAX_REMOTE_CONNECTIONS = 12;
const PRE_AUTH_MAX_CONNECTIONS_PER_REMOTE_ADDRESS = 4;

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
  guardCorePort(proc, PORT);
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

/** WS 升級請求(不帶 Origin,比照非瀏覽器 client)。 */
function upgradeRequest() {
  return [
    "GET / HTTP/1.1",
    `Host: 127.0.0.1:${PORT}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
    "Sec-WebSocket-Version: 13",
    "",
    "",
  ].join("\r\n");
}

/**
 * 自己做 WS 握手,回傳 server 回應的 HTTP 狀態。升級成功(101)時一併回傳仍開著的 socket——它佔著一個未認證名額,
 * 呼叫端用完要 `destroy()`(它不會回 close frame,留著的話 core 逾時後還要再等 30 秒的關閉握手才歸還名額)。
 * `localAddress` 指定來源位址(GP12 用 127.0.0.x 模擬非本機來源)。
 */
function rawUpgrade({ localAddress } = {}, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ port: PORT, host: "127.0.0.1", localAddress });
    let buffered = Buffer.alloc(0);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`WS 握手逾時(${timeoutMs}ms)`));
    }, timeoutMs);
    socket.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    socket.on("connect", () => socket.write(upgradeRequest()));
    socket.on("data", function onData(chunk) {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf("\r\n\r\n");
      if (end < 0) return;
      clearTimeout(timer);
      socket.off("data", onData);
      const statusLine = buffered.subarray(0, end).toString().split("\r\n")[0];
      const status = Number(statusLine.split(" ")[1]);
      if (status === 101) {
        resolve({ status, statusLine, socket });
      } else {
        socket.destroy();
        resolve({ status, statusLine });
      }
    });
  });
}

/**
 * 重試 `rawUpgrade()` 直到升級成功或逾時,回傳最後一次的結果。名額是在 core 處理到連線關閉時才歸還,client 這邊看到
 * 關閉的當下 core 可能還差幾毫秒——用在「關閉之後應該能再連」的地方。
 */
async function rawUpgradeWithin(timeoutMs, options) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const outcome = await rawUpgrade(options);
    if (outcome.status === 101 || Date.now() >= deadline) return outcome;
    await sleep(100);
  }
}

/** 同上,但開的是 `Conn`(之後要送 auth 或等 core 逾時關閉的連線)。 */
async function openConnWithin(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await new Conn().open();
    } catch (err) {
      if (Date.now() >= deadline) throw err;
      await sleep(100);
    }
  }
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
    socket.on("connect", () => socket.write(upgradeRequest()));
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

/** 已認證的連線送 `params`,回傳結果與 detail;用來驗證 JSON 值上限在 zod 之前就擋下。 */
async function authedOverBudget(params) {
  const c = await authed();
  const id = randomUUID();
  const text = JSON.stringify({ id, method: "settings.setEnabledModels", params });
  const started = Date.now();
  const out = await c.request(id, text);
  const elapsed = Date.now() - started;
  c.close();
  const detail = out.response?.errorParams?.detail ?? "";
  const ok =
    out.response?.errorCode === ErrorCodes.GATEWAY_INVALID_REQUEST &&
    detail.includes(`超過 ${GATEWAY_MAX_REQUEST_JSON_VALUES} 個 JSON 值`) &&
    !detail.includes("more issues") &&
    out.bytes < 1024;
  return { ok, info: `payload=${text.length} bytes / ${fmt(out)} / ${elapsed}ms / detail=${JSON.stringify(detail.slice(0, 200))}` };
}

async function testAuthedArrayOverBudget() {
  const n = GATEWAY_MAX_REQUEST_JSON_VALUES + 1;
  const { ok, info } = await authedOverBudget({ enabledModelIds: badArray(n) });
  record(`GP10 已認證、${n} 個不合格元素(超過 JSON 值上限)→ zod 不解析,detail 是上限那一句(回應 < 1 KB)`, ok, info);
}

async function testAuthedObjectOverBudget() {
  const n = GATEWAY_MAX_REQUEST_JSON_VALUES + 1;
  const junk = {};
  for (let i = 0; i < n; i++) junk[`k${i}`] = 0;
  const { ok, info } = await authedOverBudget({ enabledModelIds: [], junk });
  record(`GP11 已認證、一個有 ${n} 個屬性的物件 → 同樣在 zod 之前擋下`, ok, info);
}

async function testRemoteAddressCaps() {
  const sockets = [];
  let local;
  const upgradeFrom = async (localAddress) => {
    const outcome = await rawUpgrade({ localAddress });
    if (outcome.socket) sockets.push(outcome.socket);
    return outcome.status;
  };
  try {
    const perAddress = PRE_AUTH_MAX_CONNECTIONS_PER_REMOTE_ADDRESS;
    const hosts = Array.from({ length: Math.ceil(PRE_AUTH_MAX_REMOTE_CONNECTIONS / perAddress) }, (_, i) => `127.0.0.${i + 2}`);
    const [hostA, ...otherHosts] = hosts;

    const fromA = [];
    try {
      fromA.push(await upgradeFrom(hostA));
    } catch (err) {
      if (err?.code === "EADDRNOTAVAIL") {
        console.log(`SKIP  GP12 這個平台不能用 ${hostA} 當來源位址(${err.code}),略過非本機來源的名額檢查`);
        return;
      }
      throw err;
    }
    while (fromA.length < perAddress) fromA.push(await upgradeFrom(hostA));
    const overA = await upgradeFrom(hostA);
    let remote = fromA.length;
    const fromOthers = [];
    for (const host of otherHosts) {
      for (let i = 0; i < perAddress && remote < PRE_AUTH_MAX_REMOTE_CONNECTIONS; i++, remote++) {
        fromOthers.push(await upgradeFrom(host));
      }
    }
    record(
      `GP12a 同一個非本機位址佔滿 ${perAddress} 條未認證連線後,下一條被拒(429);其他非本機位址不受影響`,
      fromA.every((s) => s === 101) && overA === 429 && fromOthers.every((s) => s === 101),
      `${hostA}: ${fromA.join(",")} → 第 ${perAddress + 1} 條 ${overA} / ${otherHosts.join("、")}: ${fromOthers.join(",")}`,
    );

    const overflowHost = `127.0.0.${hosts.length + 2}`;
    const overRemote = await upgradeFrom(overflowHost);
    local = await openConnWithin(3_000);
    const localAuth = await local.rpc("auth", { token: MASTER_TOKEN });
    record(
      `GP12b 非本機未認證連線合計 ${PRE_AUTH_MAX_REMOTE_CONNECTIONS} 條後,沒用過的位址也被拒(503);本機仍連得進來並能認證`,
      remote === PRE_AUTH_MAX_REMOTE_CONNECTIONS && overRemote === 503 && localAuth.response?.ok === true,
      `非本機 ${remote} 條 / ${overflowHost}: ${overRemote} / 本機 auth: ${fmt(localAuth)}`,
    );
  } finally {
    for (const socket of sockets) socket.destroy();
    local?.close();
  }
}

async function testPreAuthConnectionCap() {
  const held = [];
  const sockets = [];
  const keep = (outcome) => {
    if (outcome.socket) sockets.push(outcome.socket);
    return outcome.status;
  };
  try {
    const started = Date.now();
    for (let i = 0; i < PRE_AUTH_MAX_CONNECTIONS; i++) held.push(await openConnWithin(3_000));
    const openedIn = Date.now() - started;
    const overRaw = keep(await rawUpgrade());
    const overWs = await new Conn().open().then(
      (c) => {
        held.push(c);
        return "opened";
      },
      () => "rejected",
    );
    record(
      `GP13 本機 ${PRE_AUTH_MAX_CONNECTIONS} 條未認證連線佔滿名額 → 下一個升級請求被拒(503),Node 內建 WebSocket 也連不上`,
      overRaw === 503 && overWs === "rejected",
      `開 ${PRE_AUTH_MAX_CONNECTIONS} 條花了 ${openedIn}ms / raw: ${overRaw} / WebSocket: ${overWs}`,
    );

    // 用最後開的兩條:離 core 的認證逾時最遠。
    const authedConn = held[PRE_AUTH_MAX_CONNECTIONS - 1];
    const closedConn = held[PRE_AUTH_MAX_CONNECTIONS - 2];
    const authOut = await authedConn.rpc("auth", { token: MASTER_TOKEN });
    const afterAuth = keep(await rawUpgrade());
    const fullAgain = keep(await rawUpgrade());
    record(
      "GP14 其中一條認證成功 → 名額立刻歸還:新的升級請求被接受,接受之後名額又滿",
      authOut.response?.ok === true && afterAuth === 101 && fullAgain === 503,
      `auth: ${fmt(authOut)} / 之後: ${afterAuth} / 再一條: ${fullAgain}`,
    );

    closedConn.close();
    const closed = await closedConn.waitClosed(5_000);
    const afterClose = keep(await rawUpgradeWithin(3_000));
    record(
      "GP15 其中一條未認證連線關閉 → 名額歸還,新的升級請求被接受",
      Boolean(closed) && afterClose === 101,
      `close=${closed?.code ?? "5 秒內沒關"} / 之後: ${afterClose}`,
    );

    // 自己做握手的 socket 不會回 close frame,先收掉;剩下的 Conn 等 core 的認證逾時(5 秒)關閉。
    for (const socket of sockets.splice(0)) socket.destroy();
    const waiting = held.slice(0, PRE_AUTH_MAX_CONNECTIONS - 2);
    const timedOut = await Promise.all(waiting.map((c) => c.waitClosed(15_000)));
    const refill = [];
    for (let i = 0; i < PRE_AUTH_MAX_CONNECTIONS; i++) refill.push(keep(await rawUpgradeWithin(3_000)));
    const overRefill = keep(await rawUpgrade());
    record(
      `GP16 其餘未認證連線被 core 逾時關閉(1008)→ 名額全部歸還(已認證那條不佔名額):又能開滿 ${PRE_AUTH_MAX_CONNECTIONS} 條,下一條被拒`,
      timedOut.every((c) => c?.code === 1008) &&
        !authedConn.closed &&
        refill.every((s) => s === 101) &&
        overRefill === 503,
      `逾時關閉: ${timedOut.map((c) => c?.code ?? "沒關").join(",")} / 已認證那條仍開著: ${!authedConn.closed} / ` +
        `重開: ${refill.join(",")} / 再一條: ${overRefill}`,
    );
  } finally {
    for (const socket of sockets) socket.destroy();
    for (const c of held) c.close();
  }
  // GP9 接著要開新連線:等 core 處理完上面這些關閉。
  (await rawUpgradeWithin(3_000)).socket?.destroy();
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
    await testAuthedArrayOverBudget();
    await testAuthedObjectOverBudget();
    await testRemoteAddressCaps();
    await testPreAuthConnectionCap();
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
