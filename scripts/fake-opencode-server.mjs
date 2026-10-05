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
 *     2026-10-03:prompt 內含 `[command:<指令>]` 時,TOOL_CALL_PREFIX 流程的 bash 指令改用它(預設
 *     TOOL_CALL_INPUT.command)——給 e2e-opencode-permissions.mjs 送出 `git push --force` 這類會被 hard-deny
 *     擋下的指令,驗證 permission-request 帶著工具參數進政策引擎。`permission.asked` 的 `patterns`/`metadata`
 *     照真實 opencode 1.18.7 實測的形狀(bash:`patterns:[指令]`、`metadata:{command}`)。
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
 *   - 若 prompt 文字以 REPORT_ENV_PREFIX 開頭(2026-10-03,給 e2e-opencode-permissions.mjs):回覆
 *     `ENV:` + JSON(`{ OPENCODE_CONFIG_CONTENT: <子行程環境變數原始字串,沒有則 null> }`)——讓 e2e 斷言
 *     Deskmony 啟動 opencode 子行程時注入的設定(所有工具 ask、與使用者既有值的合併、session 網路 MCP 設定)。
 *   - 若 prompt 文字以 SUBAGENT_PERMISSION_PREFIX 開頭(2026-10-03):模擬 `task` 工具建立的 subagent 子 session——
 *     先送一個「不相干的陌生 session」的 `permission.asked`(Deskmony 不能轉發,否則等於替別人的 session 作答),
 *     再送 `session.created`(`info.parentID` = 本 session)、子 session 的一段文字(不能混進本 session 的對話)、
 *     子 session 的 bash `permission.asked`(`sessionID` 是子 session,真實 opencode 實測就是這樣),等
 *     `POST /permission/{id}/reply`,最後回覆 `[child-reply:<reply>]` 與 `[stranger-reply:<有沒有被回覆>]`。
 *   - 2026-10-03(安全:認證):**真的檢查 HTTP basic auth**,行為比照真實 opencode 1.18.7 實測——收到的 `OPENCODE_SERVER_PASSWORD`
 *     (及 `OPENCODE_SERVER_USERNAME`,預設 `opencode`)有設時,**所有端點(含 SSE `/event`、`/global/health`)**沒帶或帶錯的
 *     `Authorization: Basic ...` 一律回 401;沒設密碼就不鎖(真實 opencode 的「unsecured」行為——所以 adapter 若忘了設密碼,
 *     e2e 會從報告檔看到密碼是 null)。這樣所有走這支 fake 的既有 e2e 同時驗證了「adapter 對 opencode 的**每個**請求都有帶認證」。
 *     另外有兩個只給 e2e 用的旁路(都由啟動 core 的測試設在環境變數,不是 gateway 能設的):
 *       - `FAKE_OPENCODE_AUTH_REPORT_FILE`:啟動時附加一行 JSON `{kind:"start",pid,baseUrl,username,password}`(測試要比對「每次
 *         spawn 密碼都不同、夠長」,並掃描 log/history/推播有沒有洩漏這個密碼——所以密碼**不能**走回覆文字,只能走這個測試專用的檔案),
 *         之後每個被擋下的請求附加 `{kind:"rejected",pid,method,path}`(測試斷言只有 adapter 的健全性探測被擋、真正的請求零被擋)。
 *       - `FAKE_OPENCODE_DISABLE_AUTH=1`:即使有密碼也不檢查,模擬「不認 OPENCODE_SERVER_PASSWORD 的舊版 opencode」,
 *         給 e2e 驗證 adapter 的「伺服器沒鎖」警告。
 *     `GET /config` 回傳子行程收到的 `OPENCODE_CONFIG_CONTENT`(解析後),模擬真實 opencode 會把含 scoped bridge token 的
 *     設定吐給任何讀得到它的人——e2e 用它證明「不帶認證讀不到」。
 *   - 這輪(slash command)新增:`GET /command` 回傳 TEST_COMMANDS(固定測試
 *     清單,形狀比照本機真實 `opencode serve`(1.18.7)`GET /command` 的
 *     `Command[]`,見 packages/adapters/src/opencode-adapter.ts 檔案頂端查證
 *     段落);`POST /session/{id}/command`(body `{command, arguments}`)回覆
 *     文字前面帶一段 `[command:X args:Y]` 可觀察標記(比照既有 `[model:...]`
 *     手法),只用來讓 e2e(步驟31)斷言「送 /已知指令 真的打到這支端點,
 *     且 body 形狀正確」,不影響既有 `/message` 端點的行為。
 */

import http from "node:http";
import { appendFileSync } from "node:fs";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

export const FAKE_OPENCODE_REPLY_CHUNKS = ["Hello", " from", " fake", " OpenCode", " server"];
export const TOOL_CALL_PREFIX = "OPENCODE_TOOL_CALL";
/** TOOL_CALL_PREFIX 流程裡 `running`/`completed` 帶的完整參數(`pending` 一律是 `{}`)。 */
export const TOOL_CALL_INPUT = { command: "echo hello-fake-opencode" };
/** prompt 內含這段文字時,`permission.asked` 排在 `running` 之前(見檔頭協定說明)。 */
export const TOOL_CALL_ASK_FIRST_MARKER = "[ask-before-running]";
/** prompt 內含 `[command:<指令>]` 時覆寫 TOOL_CALL_PREFIX 流程的 bash 指令,見檔頭。 */
export const TOOL_CALL_COMMAND_PATTERN = /\[command:([^\]]+)\]/;
export const REPORT_ENV_PREFIX = "OPENCODE_REPORT_ENV";
export const SUBAGENT_PERMISSION_PREFIX = "OPENCODE_SUBAGENT_PERMISSION";
/** SUBAGENT_PERMISSION_PREFIX 流程裡子 session 說的話(e2e 斷言它**不會**出現在本 session 的對話)。 */
export const SUBAGENT_CHILD_TEXT = "CHILD-SESSION-SECRET-TEXT";
/** 子 session 的 bash 指令(permission-request 要帶著它進政策引擎)。 */
export const SUBAGENT_CHILD_COMMAND = "echo from-subagent";
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
    // 2026-10-03:`[command:<指令>]` 覆寫指令(見檔頭)。沒有時就是原本的 TOOL_CALL_INPUT,既有 e2e 不受影響。
    const commandOverride = TOOL_CALL_COMMAND_PATTERN.exec(text)?.[1];
    const toolInput = commandOverride ? { command: commandOverride } : TOOL_CALL_INPUT;
    broadcast("message.part.updated", { sessionID: sessionId, part: toolPart({ status: "pending", input: {}, raw: "" }) });
    const requestId = `per_${randomUUID()}`;
    const replyPromise = new Promise((resolve) => {
      session.pendingPermission.set(requestId, resolve);
    });
    const sendRunning = () =>
      broadcast("message.part.updated", { sessionID: sessionId, part: toolPart({ status: "running", input: toolInput, time: { start } }) });
    const askPermission = () =>
      broadcast("permission.asked", {
        id: requestId,
        sessionID: sessionId,
        permission: "bash",
        // 真實 opencode 1.18.7 實測形狀:bash 的 patterns 是指令本身,metadata 是 {command}。
        patterns: [toolInput.command],
        metadata: { command: toolInput.command },
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
        part: toolPart({ status: "running", input: toolInput, metadata: { output, description: "" }, time: { start } }),
      });
      broadcast("message.part.updated", {
        sessionID: sessionId,
        part: toolPart({ status: "completed", input: toolInput, output, metadata: { output, exit: 0 }, title: "echo", time: { start, end: Date.now() } }),
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
  } else if (text.startsWith(REPORT_ENV_PREFIX)) {
    // 2026-10-03:回顯子行程收到的 OPENCODE_CONFIG_CONTENT(原始字串),見檔頭。
    const raw = process.env.OPENCODE_CONFIG_CONTENT;
    await streamTextReply(sessionId, assistantMessageId, [`ENV:${JSON.stringify({ OPENCODE_CONFIG_CONTENT: raw ?? null })}`]);
    broadcast("message.updated", { sessionID: sessionId, info: { id: assistantMessageId, role: "assistant", sessionID: sessionId } });
  } else if (text.startsWith(SUBAGENT_PERMISSION_PREFIX)) {
    // 2026-10-03:subagent 子 session 的權限請求,見檔頭。
    const strangerSessionId = `ses_${randomUUID()}`;
    const childSessionId = `ses_${randomUUID()}`;
    const strangerRequestId = `per_${randomUUID()}`;
    const childRequestId = `per_${randomUUID()}`;
    const strangerReply = new Promise((resolve) => session.pendingPermission.set(strangerRequestId, resolve));
    const childReply = new Promise((resolve) => session.pendingPermission.set(childRequestId, resolve));
    // 1) 陌生 session(不是本 session、也不是它的子孫)的權限請求——不能被轉發。
    broadcast("permission.asked", {
      id: strangerRequestId,
      sessionID: strangerSessionId,
      permission: "bash",
      patterns: ["echo stranger"],
      metadata: { command: "echo stranger" },
      always: [],
      tool: { messageID: `msg_${randomUUID()}`, callID: `call_${randomUUID()}` },
    });
    // 2) 子 session 建立(parentID 指向本 session),以及它說的一段話(不能混進本 session 的對話)。
    broadcast("session.created", { sessionID: childSessionId, info: { id: childSessionId, parentID: sessionId, title: "subagent" } });
    broadcast("message.part.updated", {
      sessionID: childSessionId,
      part: { id: `prt_${randomUUID()}`, messageID: `msg_${randomUUID()}`, sessionID: childSessionId, type: "text", text: SUBAGENT_CHILD_TEXT, time: { start: Date.now(), end: Date.now() } },
    });
    // 3) 子 session 的 bash 權限請求(sessionID 是子 session;它的 tool part 不會轉發,所以 Deskmony 只能靠 metadata 知道指令)。
    broadcast("permission.asked", {
      id: childRequestId,
      sessionID: childSessionId,
      permission: "bash",
      patterns: [SUBAGENT_CHILD_COMMAND],
      metadata: { command: SUBAGENT_CHILD_COMMAND },
      always: [],
      tool: { messageID: `msg_${randomUUID()}`, callID: `call_${randomUUID()}` },
    });
    const reply = await childReply;
    // 給陌生請求一點時間——若 Deskmony 錯誤地轉發並回覆了它,`strangerReply` 會在這段期間 resolve。
    const strangerGotReply = await Promise.race([strangerReply.then(() => true), delay(1500).then(() => false)]);
    session.pendingPermission.delete(strangerRequestId);
    await streamTextReply(sessionId, assistantMessageId, [`[child-reply:${reply}] [stranger-reply:${strangerGotReply}]`]);
    broadcast("message.updated", { sessionID: sessionId, info: { id: assistantMessageId, role: "assistant", sessionID: sessionId } });
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

/** 2026-10-03:認證設定(見檔頭)。沒有密碼 = 不鎖(真實 opencode 的行為);`FAKE_OPENCODE_DISABLE_AUTH=1` = 有密碼也不檢查(舊版模擬)。 */
const SERVER_PASSWORD = process.env.OPENCODE_SERVER_PASSWORD || undefined;
const SERVER_USERNAME = process.env.OPENCODE_SERVER_USERNAME || "opencode";
const AUTH_ENFORCED = SERVER_PASSWORD !== undefined && process.env.FAKE_OPENCODE_DISABLE_AUTH !== "1";
const AUTH_REPORT_FILE = process.env.FAKE_OPENCODE_AUTH_REPORT_FILE || undefined;

function sha256(text) {
  return createHash("sha256").update(text).digest();
}

/** `Authorization: Basic base64(user:pass)` 是否等於這個伺服器的憑證(比對雜湊,避免長度差異洩漏)。 */
function isAuthorized(req) {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Basic ")) return false;
  const expected = `${SERVER_USERNAME}:${SERVER_PASSWORD}`;
  const given = Buffer.from(header.slice("Basic ".length), "base64").toString("utf8");
  return timingSafeEqual(sha256(given), sha256(expected));
}

function appendAuthReport(record) {
  if (!AUTH_REPORT_FILE) return;
  try {
    appendFileSync(AUTH_REPORT_FILE, `${JSON.stringify({ pid: process.pid, ...record })}\n`);
  } catch {
    // 測試專用旁路,寫不進去就算了(e2e 會從缺少紀錄看出來)。
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://internal");
  if (AUTH_ENFORCED && !isAuthorized(req)) {
    // 比照真實 opencode:所有端點(含 SSE、health)一律擋,不洩漏任何資訊。
    appendAuthReport({ kind: "rejected", method: req.method, path: url.pathname });
    res.writeHead(401, { "content-type": "application/json", "www-authenticate": 'Basic realm="Secure Area"' });
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return;
  }
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

  // 2026-10-03:真實 opencode 的 `GET /config` 會吐出完整設定(含 `mcp.deskmony.environment` 的 scoped bridge token)——
  // 沒有認證時等於把 token 給任何本機程序;e2e 用它證明有認證之後讀不到。
  if (req.method === "GET" && url.pathname === "/config") {
    let config = {};
    try {
      config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? "{}");
    } catch {
      // 設定壞掉就回空物件
    }
    sendJson(res, 200, config);
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
    appendAuthReport({
      kind: "start",
      baseUrl: `http://127.0.0.1:${port}`,
      username: SERVER_USERNAME,
      // 刻意把密碼原文寫進測試專用的報告檔(只有 e2e 設了 FAKE_OPENCODE_AUTH_REPORT_FILE 才會寫),見檔頭。沒收到密碼時是 null。
      password: SERVER_PASSWORD ?? null,
      enforced: AUTH_ENFORCED,
    });
  });

  process.on("SIGTERM", () => process.exit(0));
  process.on("SIGINT", () => process.exit(0));
}
