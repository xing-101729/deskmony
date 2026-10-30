#!/usr/bin/env node
/**
 * scripts/e2e-prompt-size.mjs
 *
 * 2026-10-30:`sendPromptMessageBytes()`(packages/shared/src/gateway.ts)。桌面 composer 送出前拿它跟
 * `GATEWAY_MAX_MESSAGE_BYTES` 比,超過就不送——否則 core 的 `maxPayload` 以 1009 關閉連線,使用者只看到斷線重連,
 * 訊息直接不見。
 *
 * 核心斷言:對各種 prompt,真的經 `GatewayClient.call("session.sendPrompt", …)` 送出去的那串文字(假 WebSocket
 * 攔下)的 UTF-8 位元組數 ≤ 估計值 ≤ 實際值 + 外殼預留。只會高估才擋得住;高估的量有上限,才不會誤擋合法訊息。
 * params 的形狀照 apps/desktop/src/stores/session-store.ts 的 `sendPrompt()` action:`{ sessionId, prompt, messageId }`。
 *
 * 單元層級,不啟動 core,一兩秒(要組幾個 60 MB 上下的字串)。前置需求:pnpm build(載入 packages/shared、
 * packages/client 的 dist)。
 *
 * 用法:node scripts/e2e-prompt-size.mjs
 */

import path from "node:path";
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireFreshBuild } from "./lib/require-fresh-build.mjs";

requireFreshBuild();

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const load = (rel) => import(pathToFileURL(path.join(REPO_ROOT, rel)).href);
const { GATEWAY_MAX_MESSAGE_BYTES, SEND_PROMPT_ENVELOPE_RESERVE_BYTES, sendPromptMessageBytes } = await load(
  "packages/shared/dist/index.js",
);
const { GatewayClient } = await load("packages/client/dist/index.js");

/** apps/desktop/src/views/ChatView.tsx 的 `MAX_ATTACHMENT_BYTES`(單一附件上限;那個檔案載入不了,這裡照抄)。 */
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
  if (detail) console.log(`       ${detail}`);
}

// ---- 假 WebSocket:攔下 GatewayClient 實際送出的字串,每個 request 都回成功 ----

const sent = [];
const listeners = { open: [], close: [], error: [], message: [] };
const fakeWs = {
  readyState: 0,
  send(data) {
    sent.push(data);
    const id = /^\{"id":"([^"]+)"/.exec(data)?.[1];
    setTimeout(() => {
      for (const l of listeners.message) l({ data: JSON.stringify({ kind: "response", id, ok: true, result: {} }) });
    }, 0);
  },
  close() {},
  addEventListener(type, l) {
    listeners[type].push(l);
  },
  removeEventListener(type, l) {
    listeners[type] = listeners[type].filter((x) => x !== l);
  },
};
const client = new GatewayClient("ws://fake", undefined, () => {
  setTimeout(() => {
    for (const l of listeners.open) l({});
  }, 0);
  return fakeWs;
});
client.connect();

/** 照桌面送出的形狀走一次 `session.sendPrompt`,回傳實際送出的位元組數。 */
async function wireBytes(prompt) {
  sent.length = 0;
  await client.call("session.sendPrompt", { sessionId: randomUUID(), prompt, messageId: randomUUID() });
  if (sent.length !== 1) throw new Error(`預期送出 1 則訊息,實際 ${sent.length}`);
  return Buffer.byteLength(sent[0], "utf8");
}

/**
 * 估計值與實際值的關係:不低估,且高估不超過外殼預留。外加一條更緊的:扣掉外殼預留後,剩下的正好是 prompt 本體
 * 序列化後的位元組數——不然多位元組字元少算幾百 bytes 會被 4 KiB 的預留吸收,上面那條抓不到。
 */
async function boundFailure(label, prompt) {
  const estimate = sendPromptMessageBytes(prompt);
  const actual = await wireBytes(prompt);
  const promptBytes = Buffer.byteLength(JSON.stringify(prompt), "utf8");
  return actual <= estimate && estimate - actual <= SEND_PROMPT_ENVELOPE_RESERVE_BYTES && estimate - SEND_PROMPT_ENVELOPE_RESERVE_BYTES === promptBytes
    ? null
    : `${label}:估計 ${estimate},實際 ${actual}(差 ${estimate - actual}),prompt 本體 ${promptBytes}`;
}

const b64 = (bytes) => randomBytes(bytes).toString("base64");

// ---- S1:各種形狀——估計值不低估、高估不超過外殼預留 ----
{
  const table = [
    ["純 ASCII 文字", { text: "hello world" }],
    ["中文 + emoji(surrogate pair)", { text: "幫我看這張圖 🙂👨‍👩‍👧 これは日本語" }],
    ["需要 JSON 跳脫的字元(引號、反斜線、換行、tab、控制字元)", { text: 'a "quoted" \\path\\ \n\r\t \u0001\u001f end' }],
    ["落單的 surrogate(JSON.stringify 會轉成 \\uXXXX)", { text: "lone \ud800 high, lone \udc00 low, swapped \udc00\ud800" }],
    ["大段中文(每字 3 bytes,少算的量遠超過外殼預留)", { text: "中".repeat(20_000) }],
    ["大段 emoji(每個 4 bytes)", { text: "🙂".repeat(10_000) }],
    ["大段需要跳脫的字元(引號 2 bytes、控制字元 6 bytes)", { text: '"'.repeat(5_000) + "\u0001".repeat(5_000) }],
    ["空附件陣列", { text: "x", attachments: [] }],
    ["一張圖片", { text: "看圖", attachments: [{ type: "image", mediaType: "image/png", data: b64(30_000) }] }],
    [
      "PDF + 純文字文件(檔名含引號、中文、emoji)",
      {
        text: "兩份文件",
        attachments: [
          { type: "document", mediaType: "application/pdf", name: '報告 "最終版" 📄.pdf', data: b64(50_001) },
          { type: "document", mediaType: "text/plain", name: "notes\\draft.txt", data: b64(2) },
        ],
      },
    ],
    ["檔案路徑變體", { text: "x", attachments: [{ type: "file", path: "C:\\Users\\某人\\a.txt" }] }],
  ];
  const failures = [];
  for (const [label, prompt] of table) {
    const failure = await boundFailure(label, prompt);
    if (failure) failures.push(failure);
  }
  record(
    `S1 ${table.length} 種形狀(跳脫字元、多位元組、落單 surrogate、各種附件)的估計值都不低估、高估不超過 ${SEND_PROMPT_ENVELOPE_RESERVE_BYTES} bytes,prompt 本體算得精確`,
    failures.length === 0,
    failures.join(";") || undefined,
  );
}

// ---- S2:隨機 prompt(混雜所有難算的字元)——同一個關係 ----
{
  const pool = ["a", "Z", "0", " ", '"', "\\", "/", "\n", "\t", "\u0000", "\u007f", "é", "ß", "中", "語", "€", "🙂", "𝄞", "\ud800", "\udc00", "\u2028"];
  const randomText = (n) => Array.from({ length: n }, () => pool[randomInt(pool.length)]).join("");
  const failures = [];
  const ROUNDS = 300;
  for (let round = 0; round < ROUNDS; round++) {
    const attachments = Array.from({ length: randomInt(4) }, () =>
      randomInt(2) === 0
        ? { type: "image", mediaType: "image/webp", data: b64(randomInt(3000)) }
        : { type: "document", mediaType: "text/plain", name: randomText(randomInt(1, 30)), data: b64(randomInt(3000)) },
    );
    const prompt = { text: randomText(randomInt(1, randomInt(10) === 0 ? 6000 : 400)), ...(randomInt(3) === 0 ? {} : { attachments }) };
    const failure = await boundFailure(`第 ${round} 輪 ${JSON.stringify(prompt.text).slice(0, 60)}`, prompt);
    if (failure) failures.push(failure);
  }
  record(`S2 ${ROUNDS} 輪隨機 prompt 都符合同一個關係`, failures.length === 0, failures.slice(0, 3).join(";") || undefined);
}

// ---- S3:原始問題——4 個上限大小的附件送得出去,5 個擋下來 ----
{
  const maxAttachment = (i) => ({ type: "document", mediaType: "application/pdf", name: `big-${i}.pdf`, data: Buffer.alloc(MAX_ATTACHMENT_BYTES).toString("base64") });
  const four = sendPromptMessageBytes({ text: "四個", attachments: [0, 1, 2, 3].map(maxAttachment) });
  const five = sendPromptMessageBytes({ text: "五個", attachments: [0, 1, 2, 3, 4].map(maxAttachment) });
  const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1);
  record(
    "S3 4 個 10 MB 附件在上限內、5 個超過上限(過去 5 個會被 core 以 1009 斷線)",
    four <= GATEWAY_MAX_MESSAGE_BYTES && five > GATEWAY_MAX_MESSAGE_BYTES,
    `4 個 ${mb(four)} MB、5 個 ${mb(five)} MB,上限 ${mb(GATEWAY_MAX_MESSAGE_BYTES)} MB`,
  );
}

// ---- S4:邊界——估計值剛好等於上限(桌面用 `>` 判斷,這種會送出)時,實際送出的不超過 `maxPayload` ----
{
  const prompt = { text: "邊界", attachments: [{ type: "image", mediaType: "image/png", data: "" }] };
  prompt.attachments[0].data = "A".repeat(GATEWAY_MAX_MESSAGE_BYTES - sendPromptMessageBytes(prompt));
  const estimate = sendPromptMessageBytes(prompt);
  const actual = await wireBytes(prompt);
  record(
    "S4 估計值剛好等於上限的訊息,實際送出的位元組數不超過 GATEWAY_MAX_MESSAGE_BYTES(ws 只拒絕 > maxPayload 的訊息)",
    estimate === GATEWAY_MAX_MESSAGE_BYTES && actual <= GATEWAY_MAX_MESSAGE_BYTES,
    `估計 ${estimate},實際 ${actual},上限 ${GATEWAY_MAX_MESSAGE_BYTES}`,
  );
}

// ---- S5:不改動傳進來的 prompt(桌面送出被擋下時,輸入框與附件要原樣留著) ----
{
  const data = b64(1000);
  const prompt = { text: "x", attachments: [{ type: "image", mediaType: "image/gif", data }] };
  const before = JSON.stringify(prompt);
  sendPromptMessageBytes(prompt);
  record("S5 估算不改動傳入的 prompt 與附件", JSON.stringify(prompt) === before && prompt.attachments[0].data === data);
}

client.disconnect();

const failed = results.filter((r) => !r.ok);
console.log(`\n========== 總結:${results.length - failed.length}/${results.length} 通過 ==========`);
for (const f of failed) console.log(`  FAIL: ${f.name}`);
process.exit(failed.length > 0 ? 1 : 0);
