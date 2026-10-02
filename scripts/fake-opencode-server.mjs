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
 * `OpenCodeAdapter.spawn()` 當成 `launch.opencodeConfig.command=
 * process.execPath, args=[thisFilePath]` 啟動(`OpencodeAgentConfigSchema.
 * args` 非空時會完全取代預設的 `serve --port 0 --hostname 127.0.0.1`,見
 * packages/shared/src/agent-launch.ts 的註解;2026-10-02 P2 起經 core 的
 * `DESKMONY_E2E_EXTRA_PROVIDERS` 注入,見 scripts/lib/e2e-providers.mjs)——不接受任何命令列參數,
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
 *   - 若 prompt 文字以 TOOL_CALL_PREFIX 開頭:照真實 opencode 1.18.7 實測到的
 *     形狀(2026-09-17,見 packages/adapters/src/opencode-adapter.ts 檔頭
 *     `type==="tool"` 的實測紀錄)送出一個 bash 工具——整個生命週期同一個
 *     `part.id`:tool part `pending`(`input:{}`、`raw:""`,參數還沒串流完)→
 *     `running`(帶完整 input TOOL_CALL_INPUT)→ `permission.asked`,等待對應的
 *     `POST /permission/{id}/reply`。prompt 內含 TOOL_CALL_ASK_FIRST_MARKER 時
 *     `permission.asked` 改排在 `running` 之前(真實 opencode 兩種順序都會出現,
 *     `question` 工具實測就是先問;給 e2e-opencode-tool-input.mjs 驗證「晚到的
 *     input 不會把 waiting 翻回 busy」)。
 *       - reply === "once":`running` 帶 metadata 重送一次(真實 opencode 執行
 *         期間會這樣推即時輸出),再送 `completed`(帶 output),再送一段結束
 *         文字,最後 idle。
 *       - reply === "reject":不送 tool-result,只送一段「已拒絕」文字,
 *         直接 idle(語意比照 fake-acp-agent.mjs 的 deny 路徑)。
 *   - 若 prompt 文字以 MANY_TOOL_CALLS_PREFIX 開頭(2026-09-17 新增):其後接
 *     JSON `{"count": number, "delayMs"?: number}`,連續送出 `count` 個不需要
 *     權限的工具呼叫,每個都是 pending → running(input 為
 *     `manyToolCallInput(i)`)→ completed。給 e2e-opencode-tool-input.mjs 驗證
 *     回合硬上限對每個工具只計一次(比照 fake-acp-agent.mjs 的
 *     MANY_TOOL_CALLS_PREFIX)。兩個工具之間檢查 abort,收到就停下來送
 *     `MessageAbortedError`。
 *   - 若 prompt 文字以 SLOW_PREFIX 開頭:延遲送出一串較長的 message.part.
 *     delta(每段間隔 SLOW_CHUNK_INTERVAL_MS),模擬「回合還在進行中」,讓
 *     e2e 有時間視窗呼叫 `POST /session/{id}/abort` 測試 interrupt() ——
 *     收到 abort 後,立刻停止後續 chunk、送出帶 `MessageAbortedError` 的
 *     `message.updated`,再送 idle。
 *   - 若 prompt 文字以 QUESTION_PREFIX 開頭(2026-09-17 新增,給
 *     e2e-opencode-question.mjs):照真實 opencode 1.18.7 實測到的順序送出
 *     `question` 工具 part(pending,input `{}`)→ `question.asked`(題目為
 *     TEST_QUESTIONS)→ part(running),然後等待:
 *       - `POST /question/{id}/reply`:送 `question.replied` + part
 *         (completed,`metadata.answers` 就是收到的陣列),再送一段
 *         `[answers:<收到的 JSON>]` 文字——讓 e2e 能斷言 wire 上實際送出的
 *         答案陣列(比照既有 `[model:...]` 手法),最後 idle。
 *       - `POST /question/{id}/reject`:送 `question.rejected` + part(error),
 *         直接 idle(真實 opencode 被 reject 後回合就結束)。
 *       - `POST /session/{id}/abort`:**不送** `question.rejected`,只送 part
 *         (error,「Tool execution aborted」)+ 帶 `MessageAbortedError` 的
 *         `message.updated`,再 idle——與真實 opencode 的 abort 行為一致。
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
/** TOOL_CALL_PREFIX 流程裡 `running`/`completed` 帶的完整參數(`pending` 一律是 `{}`)。 */
export const TOOL_CALL_INPUT = { command: "echo hello-fake-opencode" };
/** prompt 內含這段文字時,`permission.asked` 排在 `running` 之前(見檔頭協定說明)。 */
export const TOOL_CALL_ASK_FIRST_MARKER = "[ask-before-running]";
export const MANY_TOOL_CALLS_PREFIX = "OPENCODE_MANY_TOOL_CALLS";
/** MANY_TOOL_CALLS_PREFIX 流程第 i 個工具的完整參數——e2e 用同一個函式算預期值。 */
export function manyToolCallInput(index) {
  return { command: `echo many-tool-${index}` };
}
export const SLOW_PREFIX = "OPENCODE_SLOW";
export const SLOW_CHUNK_COUNT = 20;
export const SLOW_CHUNK_INTERVAL_MS = 300;
export const QUESTION_PREFIX = "OPENCODE_QUESTION";
/**
 * 2026-09-17 新增:`question.asked` 帶的固定題目,形狀照抄真實 opencode 1.18.7
 * 的事件(`multiple`/`custom` 省略即預設值)。第二題 `multiple: true`,讓 e2e
 * 涵蓋多選答案拆回 label 陣列的路徑。
 */
export const TEST_QUESTIONS = [
  {
    question: "Which color do you prefer?",
    header: "Color",
    options: [
      { label: "Red", description: "Choose red" },
      { label: "Blue", description: "Choose blue" },
    ],
  },
  {
    question: "Which features should be enabled?",
    header: "Features",
    options: [
      { label: "Alpha", description: "Feature alpha" },
      { label: "Beta", description: "Feature beta" },
      { label: "Gamma", description: "Feature gamma" },
    ],
    multiple: true,
  },
];
/**
 * 這輪(slash command)新增:`GET /command` 的固定測試清單——`"greet"` 帶
 * `hints`(模擬有 argument 佔位符的指令),`"noop"` 不帶(模擬無參數指令),
 * 涵蓋 `mapOpencodeCommands()` 的 coalescing 分支(見 opencode-adapter.ts)。
 */
export const TEST_COMMANDS = [
  { name: "greet", description: "fake greet command", source: "command", template: "Say hello to $ARGUMENTS", hints: ["$ARGUMENTS"] },
  { name: "noop", description: "fake no-arg command", source: "command", template: "Do nothing", hints: [] },
];

const sessions = new Map(); // sessionId -> { aborted: boolean, pendingPermission: Map<id, resolve>, pendingQuestion: Map<id, resolve> }
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
    // 真實 opencode 整個工具生命週期共用同一個 part.id(2026-09-17 實測;在這之前
    // 這裡 pending/completed 各用一個隨機 id,不符合實際形狀)。
    const partId = `prt_${randomUUID()}`;
    const toolPart = (state) => ({ id: partId, messageID: assistantMessageId, sessionID: sessionId, type: "tool", callID: callId, tool: "bash", state });
    const start = Date.now();
    broadcast("message.part.updated", { sessionID: sessionId, part: toolPart({ status: "pending", input: {}, raw: "" }) });
    const requestId = `per_${randomUUID()}`;
    const replyPromise = new Promise((resolve) => {
      session.pendingPermission.set(requestId, resolve);
    });
    const sendRunning = () =>
      broadcast("message.part.updated", { sessionID: sessionId, part: toolPart({ status: "running", input: TOOL_CALL_INPUT, time: { start } }) });
    const askPermission = () =>
      broadcast("permission.asked", {
        id: requestId,
        sessionID: sessionId,
        permission: "bash",
        patterns: ["echo *"],
        metadata: {},
        always: [],
        tool: { messageID: assistantMessageId, callID: callId },
      });
    if (text.includes(TOOL_CALL_ASK_FIRST_MARKER)) {
      askPermission();
      sendRunning();
    } else {
      sendRunning();
      askPermission();
    }
    const reply = await replyPromise;
    if (reply === "once" || reply === "always") {
      const output = "hello-fake-opencode\n";
      broadcast("message.part.updated", {
        sessionID: sessionId,
        part: toolPart({ status: "running", input: TOOL_CALL_INPUT, metadata: { output, description: "" }, time: { start } }),
      });
      broadcast("message.part.updated", {
        sessionID: sessionId,
        part: toolPart({ status: "completed", input: TOOL_CALL_INPUT, output, metadata: { output, exit: 0 }, title: "echo", time: { start, end: Date.now() } }),
      });
      await streamTextReply(sessionId, assistantMessageId, ["Done", " running", " the", " command."]);
    } else {
      await streamTextReply(sessionId, assistantMessageId, ["Permission", " denied,", " not", " running."]);
    }
    broadcast("message.updated", { sessionID: sessionId, info: { id: assistantMessageId, role: "assistant", sessionID: sessionId } });
  } else if (text.startsWith(QUESTION_PREFIX)) {
    const callId = `call_${randomUUID()}`;
    const partId = `prt_${randomUUID()}`;
    const toolPart = (state) => ({ id: partId, messageID: assistantMessageId, sessionID: sessionId, type: "tool", callID: callId, tool: "question", state });
    broadcast("message.part.updated", { sessionID: sessionId, part: toolPart({ status: "pending", input: {}, raw: "" }) });
    const requestId = `que_${randomUUID()}`;
    const outcomePromise = new Promise((resolve) => {
      session.pendingQuestion.set(requestId, resolve);
    });
    broadcast("question.asked", {
      id: requestId,
      sessionID: sessionId,
      questions: TEST_QUESTIONS,
      tool: { messageID: assistantMessageId, callID: callId },
    });
    const input = { questions: TEST_QUESTIONS };
    const start = Date.now();
    broadcast("message.part.updated", { sessionID: sessionId, part: toolPart({ status: "running", input, time: { start } }) });

    const outcome = await outcomePromise;
    session.pendingQuestion.delete(requestId);
    if (outcome.kind === "reply") {
      broadcast("question.replied", { sessionID: sessionId, requestID: requestId, answers: outcome.answers });
      const formatted = TEST_QUESTIONS.map(
        (q, i) => `"${q.question}"="${outcome.answers[i]?.length ? outcome.answers[i].join(", ") : "Unanswered"}"`,
      ).join(", ");
      broadcast("message.part.updated", {
        sessionID: sessionId,
        part: toolPart({
          status: "completed",
          input,
          output: `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`,
          title: `Asked ${TEST_QUESTIONS.length} questions`,
          metadata: { answers: outcome.answers, truncated: false },
          time: { start, end: Date.now() },
        }),
      });
      await streamTextReply(sessionId, assistantMessageId, [`[answers:${JSON.stringify(outcome.answers)}]`]);
      broadcast("message.updated", { sessionID: sessionId, info: { id: assistantMessageId, role: "assistant", sessionID: sessionId } });
    } else if (outcome.kind === "reject") {
      broadcast("question.rejected", { sessionID: sessionId, requestID: requestId });
      broadcast("message.part.updated", {
        sessionID: sessionId,
        part: toolPart({ status: "error", input, error: "The user dismissed this question", time: { start, end: Date.now() } }),
      });
      broadcast("message.updated", { sessionID: sessionId, info: { id: assistantMessageId, role: "assistant", sessionID: sessionId } });
    } else {
      broadcast("message.part.updated", {
        sessionID: sessionId,
        part: toolPart({ status: "error", input, error: "Tool execution aborted", metadata: { interrupted: true }, time: { start, end: Date.now() } }),
      });
      broadcast("message.updated", {
        sessionID: sessionId,
        info: { id: assistantMessageId, role: "assistant", sessionID: sessionId, error: { name: "MessageAbortedError", data: { message: "Aborted" } } },
      });
    }
  } else if (text.startsWith(MANY_TOOL_CALLS_PREFIX)) {
    const { count, delayMs = 0 } = JSON.parse(text.slice(MANY_TOOL_CALLS_PREFIX.length));
    session.aborted = false;
    for (let i = 0; i < count; i++) {
      if (session.aborted) break;
      const callId = `call_${randomUUID()}`;
      const partId = `prt_${randomUUID()}`;
      const toolPart = (state) => ({ id: partId, messageID: assistantMessageId, sessionID: sessionId, type: "tool", callID: callId, tool: "bash", state });
      const input = manyToolCallInput(i);
      const start = Date.now();
      const output = `many-tool-${i}\n`;
      broadcast("message.part.updated", { sessionID: sessionId, part: toolPart({ status: "pending", input: {}, raw: "" }) });
      broadcast("message.part.updated", { sessionID: sessionId, part: toolPart({ status: "running", input, time: { start } }) });
      broadcast("message.part.updated", {
        sessionID: sessionId,
        part: toolPart({ status: "completed", input, output, metadata: { output, exit: 0 }, title: "echo", time: { start, end: Date.now() } }),
      });
      if (delayMs > 0) await delay(delayMs);
    }
    if (session.aborted) {
      broadcast("message.updated", {
        sessionID: sessionId,
        info: { id: assistantMessageId, role: "assistant", sessionID: sessionId, error: { name: "MessageAbortedError", data: { message: "Aborted" } } },
      });
    } else {
      await streamTextReply(sessionId, assistantMessageId, ["Ran", " all", " tools."]);
      broadcast("message.updated", { sessionID: sessionId, info: { id: assistantMessageId, role: "assistant", sessionID: sessionId } });
    }
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
    sessions.set(id, { aborted: false, pendingPermission: new Map(), pendingQuestion: new Map() });
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
    for (const resolve of session.pendingQuestion.values()) resolve({ kind: "abort" });
    sendJson(res, 200, true);
    return;
  }

  const questionMatch = url.pathname.match(/^\/question\/([^/]+)\/(reply|reject)$/);
  if (req.method === "POST" && questionMatch) {
    const [, requestId, action] = questionMatch;
    const body = await readJsonBody(req);
    // 比照真實 opencode 的 schema 驗證:answers 必須是 string[][],否則 400。
    if (
      action === "reply" &&
      !(Array.isArray(body.answers) && body.answers.every((a) => Array.isArray(a) && a.every((v) => typeof v === "string")))
    ) {
      sendJson(res, 400, { error: "answers must be string[][]" });
      return;
    }
    for (const session of sessions.values()) {
      const resolve = session.pendingQuestion.get(requestId);
      if (resolve) {
        resolve(action === "reply" ? { kind: "reply", answers: body.answers } : { kind: "reject" });
        sendJson(res, 200, true);
        return;
      }
    }
    sendJson(res, 404, { _tag: "QuestionNotFoundError", requestID: requestId, message: "question not found" });
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
