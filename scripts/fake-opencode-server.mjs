#!/usr/bin/env node
/**
 * scripts/fake-opencode-server.mjs
 *
 * 給 scripts/e2e-gateway.mjs 使用的最小 opencode headless server 替身——用
 * node 內建的 `node:http` 模組實作
 * `packages/adapters/src/opencode-adapter.ts` 實際依賴的那個端點/事件子集
 * (端點形狀依本機真實 `opencode serve`(版本 1.18.4)的 `GET /doc` OpenAPI
 * 文件與實際 SSE 事件觀察結果為準,見該檔案頂端對接策略註解),讓
 * `OpenCodeAdapter` 有**完全不依賴真實 opencode 執行檔、不依賴任何模型**的
 * 決定性測試:建 session → 送 prompt → 斷言收到 message-delta/completed →
 * 工具呼叫 + 權限請求 → interrupt → dispose 清理。
 *
 * 啟動方式:比照 fake-acp-agent.mjs / fake-pty-echo.mjs 的先例,被
 * `OpenCodeAdapter.spawn()` 當成 `profile.opencodeConfig.command=
 * process.execPath, args=[thisFilePath]` 啟動(`OpencodeAgentConfigSchema.
 * args` 非空時會完全取代預設的 `serve --port 0 --hostname 127.0.0.1`,見
 * packages/shared/src/agent-profile.ts 的註解)——不接受任何命令列參數,
 * 監聽 port 由 `net.Server.listen(0)` 隨機選定,啟動後在 stdout 印出與真實
 * opencode 相同格式的 `opencode server listening on http://127.0.0.1:<port>`
 * 這一行,讓 `OpenCodeAdapter` 的 port 探測邏輯不需要區分真假伺服器。
 *
 * 協定(僅供本腳本與 e2e-gateway.mjs 之間使用,非 opencode 官方 API 的一部分):
 *   - 一般 prompt:固定回覆 FAKE_OPENCODE_REPLY_CHUNKS 串接而成的文字,拆成
 *     多個 `message.part.delta` 事件送出(同一個 partID),驗證
 *     message-delta 轉換是否正確、`completed` 事件是否正確送達。若請求 body
 *     帶了 `model` 欄位(`OpenCodeAdapter.sendPrompt()`/`setModel()` 的
 *     覆寫,見該檔案),回覆文字前面會多一段 `[model:providerID/modelID]`
 *     標記——只用來讓 e2e(步驟24f)斷言「setModel() 之後,實際送出的請求
 *     真的帶新 model」,沒有帶 model 的既有呼叫方式完全不受影響。
 *   - 若 prompt 文字以 TOOL_CALL_PREFIX 開頭:送出 `message.part.updated`
 *     (tool part,status:"pending"),再送 `permission.asked`,等待對應的
 *     `POST /permission/{id}/reply`:
 *       - reply === "once":送出 tool part(status:"completed",帶
 *         output),再送一段結束文字,最後 idle。
 *       - reply === "reject":不送 tool-result,只送一段「已拒絕」文字,
 *         直接 idle(語意比照 fake-acp-agent.mjs 的 deny 路徑)。
 *   - 若 prompt 文字以 SLOW_PREFIX 開頭:延遲送出一串較長的 message.part.
 *     delta(每段間隔 SLOW_CHUNK_INTERVAL_MS),模擬「回合還在進行中」,讓
 *     e2e 有時間視窗呼叫 `POST /session/{id}/abort` 測試 interrupt() ——
 *     收到 abort 後,立刻停止後續 chunk、送出帶 `MessageAbortedError` 的
 *     `message.updated`,再送 idle。
 *   - 這輪(slash command)新增:`GET /command` 回傳 TEST_COMMANDS(固定測試
 *     清單,形狀比照本機真實 `opencode serve`(1.18.7)`GET /command` 的
 *     `Command[]`,見 packages/adapters/src/opencode-adapter.ts 檔案頂端查證
 *     段落);`POST /session/{id}/command`(body `{command, arguments}`)回覆
 *     文字前面帶一段 `[command:X args:Y]` 可觀察標記(比照既有 `[model:...]`
 *     手法),只用來讓 e2e(步驟31)斷言「送 /已知指令 真的打到這支端點,
 *     且 body 形狀正確」,不影響既有 `/message` 端點的行為。
 */

import http from "node:http";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

export const FAKE_OPENCODE_REPLY_CHUNKS = ["Hello", " from", " fake", " OpenCode", " server"];
export const TOOL_CALL_PREFIX = "OPENCODE_TOOL_CALL";
export const SLOW_PREFIX = "OPENCODE_SLOW";
export const SLOW_CHUNK_COUNT = 20;
export const SLOW_CHUNK_INTERVAL_MS = 300;
/**
 * 這輪(slash command)新增:`GET /command` 的固定測試清單——`"greet"` 帶
 * `hints`(模擬有 argument 佔位符的指令),`"noop"` 不帶(模擬無參數指令),
 * 涵蓋 `mapOpencodeCommands()` 的 coalescing 分支(見 opencode-adapter.ts)。
 */
export const TEST_COMMANDS = [
  { name: "greet", description: "fake greet command", source: "command", template: "Say hello to $ARGUMENTS", hints: ["$ARGUMENTS"] },
  { name: "noop", description: "fake no-arg command", source: "command", template: "Do nothing", hints: [] },
];

const sessions = new Map(); // sessionId -> { aborted: boolean, pendingPermission: Map<id, resolve> }
/** @type {Set<http.ServerResponse>} */
const sseClients = new Set();

function broadcast(type, properties) {
  const evt = { id: `evt_${randomUUID()}`, type, properties };
  const frame = `data: ${JSON.stringify(evt)}\n\n`;
  for (const res of sseClients) {
    res.write(frame);
  }
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

/** 送出一則 assistant 訊息的 text part(先建立空字串 part,再逐段 delta,最後標記 time.end)。 */
async function streamTextReply(sessionId, messageId, chunks, { chunkDelayMs = 5 } = {}) {
  const partId = `prt_${randomUUID()}`;
  broadcast("message.part.updated", {
    sessionID: sessionId,
    part: { id: partId, messageID: messageId, sessionID: sessionId, type: "text", text: "", time: { start: Date.now() } },
  });
  let acc = "";
  for (const chunk of chunks) {
    acc += chunk;
    broadcast("message.part.delta", { sessionID: sessionId, messageID: messageId, partID: partId, field: "text", delta: chunk });
    if (chunkDelayMs > 0) await delay(chunkDelayMs);
  }
  broadcast("message.part.updated", {
    sessionID: sessionId,
    part: { id: partId, messageID: messageId, sessionID: sessionId, type: "text", text: acc, time: { start: Date.now(), end: Date.now() } },
  });
  return partId;
}

async function handlePrompt(sessionId, text, model) {
  const session = sessions.get(sessionId);
  const userMessageId = `msg_${randomUUID()}`;
  const assistantMessageId = `msg_${randomUUID()}`;
  broadcast("message.updated", { sessionID: sessionId, info: { id: userMessageId, role: "user", sessionID: sessionId } });
  // 真實回報的 bug 迴歸模擬:opencode 對使用者自己送出的訊息一樣會建立 text part
  // 並廣播 message.part.updated(`/event` 是全域 SSE,不分 user/assistant)——這裡
  // 補上模擬同一個行為(部件內容就是使用者剛送出的 `text`,建立當下就是完整內容,
  // 沒有串流過程,故 time.start/end 同時給值),讓下面 24b/24f 既有的「回覆全文須與
  // 預期完全相符」斷言真的能涵蓋這個情境(見 packages/adapters/src/opencode-adapter.ts
  // handlePartUpdated() 的 role 過濾修復——沒有這段模擬,fake server 永遠不會觸發
  // 這個 bug,既有測試就算 adapter 忘記過濾使用者訊息 part 也發現不了)。
  broadcast("message.part.updated", {
    sessionID: sessionId,
    part: { id: `prt_${randomUUID()}`, messageID: userMessageId, sessionID: sessionId, type: "text", text, time: { start: Date.now(), end: Date.now() } },
  });
  broadcast("session.status", { sessionID: sessionId, status: { type: "busy" } });
  broadcast("message.updated", { sessionID: sessionId, info: { id: assistantMessageId, role: "assistant", sessionID: sessionId } });

  if (text.startsWith(SLOW_PREFIX)) {
    session.aborted = false;
    // 真實 opencode 實測:一個 text part 的「建立」事件(message.part.updated,
    // 帶空字串)一定先於它的 message.part.delta 到達——OpenCodeAdapter 的
    // advanceTextPart() 依此順序防禦性地忽略未知 partId 的 delta(避免對
    // 型別不明的 part 誤發 message-delta),這裡必須先送一次建立事件,否則
    // 之後的 delta 全部會被 adapter 正確地丟棄,永遠等不到 message-delta。
    const slowPartId = `prt_${randomUUID()}`;
    session.slowPartId = slowPartId;
    broadcast("message.part.updated", {
      sessionID: sessionId,
      part: { id: slowPartId, messageID: assistantMessageId, sessionID: sessionId, type: "text", text: "", time: { start: Date.now() } },
    });
    for (let i = 0; i < SLOW_CHUNK_COUNT; i++) {
      if (session.aborted) break;
      broadcast("message.part.delta", {
        sessionID: sessionId,
        messageID: assistantMessageId,
        partID: slowPartId,
        field: "text",
        delta: `chunk${i} `,
      });
      await delay(SLOW_CHUNK_INTERVAL_MS);
    }
    if (session.aborted) {
      broadcast("message.updated", {
        sessionID: sessionId,
        info: { id: assistantMessageId, role: "assistant", sessionID: sessionId, error: { name: "MessageAbortedError", data: { message: "Aborted" } } },
      });
    } else {
      broadcast("message.updated", { sessionID: sessionId, info: { id: assistantMessageId, role: "assistant", sessionID: sessionId } });
    }
    session.slowPartId = undefined;
  } else if (text.startsWith(TOOL_CALL_PREFIX)) {
    const callId = `call_${randomUUID()}`;
    broadcast("message.part.updated", {
      sessionID: sessionId,
      part: { id: `prt_${randomUUID()}`, messageID: assistantMessageId, sessionID: sessionId, type: "tool", callID: callId, tool: "bash", state: { status: "pending", input: {}, raw: "" } },
    });
    const requestId = `per_${randomUUID()}`;
    const replyPromise = new Promise((resolve) => {
      session.pendingPermission.set(requestId, resolve);
    });
    broadcast("permission.asked", {
      id: requestId,
      sessionID: sessionId,
      permission: "bash",
      patterns: ["echo *"],
      metadata: {},
      always: [],
      tool: { messageID: assistantMessageId, callID: callId },
    });
    const reply = await replyPromise;
    if (reply === "once" || reply === "always") {
      broadcast("message.part.updated", {
        sessionID: sessionId,
        part: {
          id: `prt_${randomUUID()}`,
          messageID: assistantMessageId,
          sessionID: sessionId,
          type: "tool",
          callID: callId,
          tool: "bash",
          state: { status: "completed", input: { command: "echo hello-fake-opencode" }, output: "hello-fake-opencode\n", metadata: { output: "hello-fake-opencode\n", exit: 0 }, time: { start: Date.now(), end: Date.now() } },
        },
      });
      await streamTextReply(sessionId, assistantMessageId, ["Done", " running", " the", " command."]);
    } else {
      await streamTextReply(sessionId, assistantMessageId, ["Permission", " denied,", " not", " running."]);
    }
    broadcast("message.updated", { sessionID: sessionId, info: { id: assistantMessageId, role: "assistant", sessionID: sessionId } });
  } else {
    // `model` 有值時(POST /session/{id}/message body 的 model 欄位,見
    // OpenCodeAdapter.sendPrompt()/setModel())在回覆前面加一段可觀察的
    // 標記——只用來讓 e2e(步驟24f)能斷言「收到的 model 欄位真的變了」,
    // 不影響既有沒有帶 model 的呼叫(該分支維持與之前完全相同的純文字回覆)。
    const chunks = model
      ? [`[model:${model.providerID}/${model.modelID}] `, ...FAKE_OPENCODE_REPLY_CHUNKS]
      : FAKE_OPENCODE_REPLY_CHUNKS;
    await streamTextReply(sessionId, assistantMessageId, chunks);
    broadcast("message.updated", { sessionID: sessionId, info: { id: assistantMessageId, role: "assistant", sessionID: sessionId } });
  }

  broadcast("session.status", { sessionID: sessionId, status: { type: "idle" } });
  broadcast("session.idle", { sessionID: sessionId });
  return { info: { id: assistantMessageId, role: "assistant", sessionID: sessionId }, parts: [] };
}

/**
 * 這輪(slash command)新增:`POST /session/{id}/command` 的最小實作——與
 * `handlePrompt()` 平行但簡化(不需要涵蓋 tool-call/slow 這些既有分支的
 * 排列組合,那些已由 `handlePrompt()` 涵蓋),回覆文字帶一段可觀察標記
 * (`[command:X args:Y]`),見檔頭註解。
 */
async function handleCommand(sessionId, command, args) {
  const userMessageId = `msg_${randomUUID()}`;
  const assistantMessageId = `msg_${randomUUID()}`;
  broadcast("message.updated", { sessionID: sessionId, info: { id: userMessageId, role: "user", sessionID: sessionId } });
  broadcast("session.status", { sessionID: sessionId, status: { type: "busy" } });
  broadcast("message.updated", { sessionID: sessionId, info: { id: assistantMessageId, role: "assistant", sessionID: sessionId } });

  await streamTextReply(sessionId, assistantMessageId, [`[command:${command} args:${args}]`]);
  broadcast("message.updated", { sessionID: sessionId, info: { id: assistantMessageId, role: "assistant", sessionID: sessionId } });

  broadcast("session.status", { sessionID: sessionId, status: { type: "idle" } });
  broadcast("session.idle", { sessionID: sessionId });
  return { info: { id: assistantMessageId, role: "assistant", sessionID: sessionId }, parts: [] };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://internal");
  void route(req, res, url).catch((err) => {
    try {
      sendJson(res, 500, { error: String(err) });
    } catch {
      // response 可能已經送出,忽略
    }
  });
});

async function route(req, res, url) {
  if (req.method === "GET" && url.pathname === "/global/health") {
    sendJson(res, 200, { healthy: true, version: "0.0.0-fake" });
    return;
  }

  if (req.method === "GET" && url.pathname === "/command") {
    sendJson(res, 200, TEST_COMMANDS);
    return;
  }

  if (req.method === "GET" && url.pathname === "/event") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(`data: ${JSON.stringify({ id: `evt_${randomUUID()}`, type: "server.connected", properties: {} })}\n\n`);
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  if (req.method === "POST" && url.pathname === "/session") {
    const id = `ses_${randomUUID()}`;
    sessions.set(id, { aborted: false, pendingPermission: new Map() });
    sendJson(res, 200, { id, directory: process.cwd() });
    return;
  }

  const messageMatch = url.pathname.match(/^\/session\/([^/]+)\/message$/);
  if (req.method === "POST" && messageMatch) {
    const sessionId = messageMatch[1];
    if (!sessions.has(sessionId)) {
      sendJson(res, 404, { error: "session not found" });
      return;
    }
    const body = await readJsonBody(req);
    const parts = Array.isArray(body.parts) ? body.parts : [];
    const text = parts
      .filter((p) => p && p.type === "text")
      .map((p) => p.text)
      .join("");
    const result = await handlePrompt(sessionId, text, body.model);
    sendJson(res, 200, result);
    return;
  }

  const commandMatch = url.pathname.match(/^\/session\/([^/]+)\/command$/);
  if (req.method === "POST" && commandMatch) {
    const sessionId = commandMatch[1];
    if (!sessions.has(sessionId)) {
      sendJson(res, 404, { error: "session not found" });
      return;
    }
    const body = await readJsonBody(req);
    if (typeof body.command !== "string" || typeof body.arguments !== "string") {
      sendJson(res, 400, { error: "command/arguments required" });
      return;
    }
    const result = await handleCommand(sessionId, body.command, body.arguments);
    sendJson(res, 200, result);
    return;
  }

  const abortMatch = url.pathname.match(/^\/session\/([^/]+)\/abort$/);
  if (req.method === "POST" && abortMatch) {
    const sessionId = abortMatch[1];
    const session = sessions.get(sessionId);
    if (!session) {
      sendJson(res, 404, { error: "session not found" });
      return;
    }
    session.aborted = true;
    sendJson(res, 200, true);
    return;
  }

  const permissionMatch = url.pathname.match(/^\/permission\/([^/]+)\/reply$/);
  if (req.method === "POST" && permissionMatch) {
    const requestId = permissionMatch[1];
    const body = await readJsonBody(req);
    for (const session of sessions.values()) {
      const resolve = session.pendingPermission.get(requestId);
      if (resolve) {
        session.pendingPermission.delete(requestId);
        resolve(body.reply);
        break;
      }
    }
    sendJson(res, 200, true);
    return;
  }

  sendJson(res, 404, { error: `no such route: ${req.method} ${url.pathname}` });
}

// 只有「被當成獨立程序直接執行」時才真的開始監聽(即 OpenCodeAdapter.spawn()
// 啟動這支腳本的情境)。scripts/e2e-gateway.mjs 也會 `import` 這個檔案來取用
// FAKE_OPENCODE_REPLY_CHUNKS / TOOL_CALL_PREFIX / SLOW_PREFIX 等常數(維持
// prompt 文字與這支伺服器的實際判斷邏輯同一個 source of truth),那種情況下
// 不能連帶在 e2e 腳本自己的 process 裡開一個 listening server —— 一個已綁定的
// net.Server 是 libuv 的 active handle,會讓 e2e 腳本跑完所有檢查點、印完
// 「總計 N 項」總結之後仍然不會自己結束(必須手動 taskkill)。比照
// fake-acp-agent.mjs 底部同樣的 isMainModule 守衛。
const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  server.listen(0, "127.0.0.1", () => {
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    process.stdout.write(`opencode server listening on http://127.0.0.1:${port}\n`);
  });

  process.on("SIGTERM", () => process.exit(0));
  process.on("SIGINT", () => process.exit(0));
}
