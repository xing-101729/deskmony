#!/usr/bin/env node
/**
 * scripts/fake-acp-agent.mjs
 *
 * 給 scripts/e2e-gateway.mjs 步驟 9 使用的最小 ACP(Agent Client Protocol)
 * agent —— 不呼叫任何真實模型 API,行為完全確定性,讓
 * packages/adapters/src/acp-adapter.ts 的事件轉換與權限請求路徑可以在沒有
 * Claude Code 登入憑證的情況下被重複、穩定地驗證(不像既有的 12 項 e2e
 * 依賴真實模型行為,可能因模型措辭/重試而 flaky)。
 *
 * 用官方 `@agentclientprotocol/sdk` 的 agent 端建構器 API(`acp.agent()`)
 * 實作,寫法對照 node_modules 內
 * `@agentclientprotocol/sdk/dist/examples/agent.js`(官方範例,已編譯的
 * 版本,讀取後確認欄位名稱與呼叫方式)。
 *
 * 啟動方式:透過 stdio 建立 ACP JSON-RPC 連線,不接受命令列參數 —— 由
 * AcpAdapter.spawn() 依 AgentLaunchSpec.acpConfig(command/args/env)啟動這支
 * 腳本本身(例如 command=process.execPath, args=[thisFilePath])。2026-10-02(P2:移除 profile)
 * 起,e2e 經 core 的環境變數 `DESKMONY_E2E_EXTRA_PROVIDERS` 把這組 command/args 注入
 * `AgentCatalog`(見 scripts/lib/e2e-providers.mjs),session 用 `providerId:"e2e-fake-acp"` 建立。
 *
 * 協定(僅供本腳本與 e2e-gateway.mjs 步驟 9 之間使用,非 ACP 標準的一部分):
 *   - 一般 prompt:固定回覆 FAKE_ACP_REPLY_CHUNKS 串接而成的文字,拆成多段
 *     `agent_message_chunk` 送出(同一個 messageId),用來驗證
 *     message-delta 分組/done/completed 事件轉換是否正確。
 *   - 若 prompt 文字以 WRITE_FILE_PREFIX("ACP_WRITE_FILE ")開頭,其後接一段
 *     JSON `{"path": "...", "content": "...", "delayMs"?: number}`
 *     (`delayMs` 選填,S7 L4 §2.1 的「無人值守」e2e 用:先延遲再開始整個寫檔
 *      流程,讓測試腳本有時間在 `session/request_permission` 送達 core **之前**
 *      把自己的 WS 連線關掉,誠實地製造出「decide() 當下一個 client 都沒連著」
 *      的情境——那正是 `ExecContext.attended` 的唯一判定來源,不可偽造):
 *       1. 送出一則 `tool_call`(kind: "edit", status: "pending")
 *       2. 呼叫 `session/request_permission`,提供 allow_once / reject_once
 *          兩個選項
 *       3. 選了 "allow":實際寫入檔案,送出 `tool_call_update`
 *          (status: "completed"),再送一句完成訊息,以 end_turn 結束。
 *       4. 選了 "deny"(或 outcome 為 cancelled):不寫檔、不送
 *          `tool_call_update`,直接以 end_turn 結束這一輪。
 *   - 若 prompt 文字內含 DELAY_ECHO_MARKER 樣式:延遲指定毫秒數後,
 *     把「完整收到的 prompt 文字」原封不動回顯(前綴 "ECHO:")。用來驗證
 *     注入的 prompt 確實送達目標 session(用 substring 搜尋,不是
 *     startsWith——注入時可能在原始內容外包一層格式化文字,marker 仍會保留在
 *     包裹後的字串中間),以及用可控制的延遲時間製造「session 目前 busy」的
 *     測試窗口。(原本的使用者是 2026-10-02 已移除的團隊訊息 e2e;P3 的 session
 *     互傳訊息 e2e 預期會再用到。)
 *   - 若 prompt 文字以 USAGE_UPDATE_PREFIX("ACP_USAGE_UPDATE ")開頭,其後接
 *     一段 JSON `{"used": number, "size": number, "cost"?: {"amount": number,
 *     "currency": string}}`(S3a usage-metering,e2e 步驟 29 用,見
 *     scripts/e2e-gateway.mjs):送出一則 `session/update` 通知,
 *     `sessionUpdate: "usage_update"`,`cost` 有給才附帶(模擬「這個後端
 *     不一定回報 cost」的真實不確定性,見 packages/adapters/src/acp-adapter.ts
 *     handleSessionUpdate() 的 "usage_update" case),再回一句簡短訊息並以
 *     end_turn 結束——用來在沒有真實 Claude Code 後端的情況下,決定性地驗證
 *     AcpAdapter 對 usage_update 的事件轉換(context-usage 逐次發、cost 存在
 *     時累計進 lastCost、回合末補發 usage)。
 *   - 若 prompt 文字以 MANY_TOOL_CALLS_PREFIX("ACP_MANY_TOOL_CALLS ")開頭,
 *     其後接一段 JSON `{"count": number}`(S3b cost-governor 的
 *     `TurnLimiter` e2e 用,見 scripts/e2e-cost-governor.mjs):在**同一輪**
 *     內連續送出 `count` 則 `tool_call` 通知(不經過權限請求——`tool_call`
 *     本身不觸發 `session/request_permission`,見
 *     packages/adapters/src/acp-adapter.ts 的 `handleSessionUpdate()`),藉此
 *     在單一回合裡製造大量 `tool-call` AgentEvent,決定性地驗證回合硬上限的
 *     「工具呼叫次數」維度——不需要真實模型自己決定要呼叫幾次工具。
 *   - 若 prompt 文字以 SLEEP_TURN_PREFIX("ACP_SLEEP_TURN ")開頭,其後接一段
 *     JSON `{"ms": number}`:單純睡滿 `ms` 毫秒後才結束這一輪,且這個睡眠會
 *     隨這個 session 的 `abort` signal 一起被取消(`session/cancel` 通知
 *     抵達時)——用來決定性地驗證回合硬上限的「時間」維度,以及
 *     `TurnLimiter` 觸發的 `interrupt()`(= ACP 的 `session/cancel`)真的能讓
 *     這個假 agent 提早結束回合,而不是一路睡到底才發現已經被中斷。
 *   - 若 prompt 文字以 AVAILABLE_COMMANDS_PREFIX("ACP_AVAILABLE_COMMANDS ")
 *     開頭,其後接一段 JSON `{"commands": [{"name": string, "description"?:
 *     string, "hint"?: string}]}`(這輪 slash command,e2e 步驟 31 用,見
 *     scripts/e2e-gateway.mjs):送出一則 `session/update` 通知,
 *     `sessionUpdate: "available_commands_update"`,`hint` 有給才組進
 *     `input: {hint}`(模擬「並非每個指令都有 argument hint」的真實情況,見
 *     packages/adapters/src/acp-adapter.ts `mapAvailableCommands()` 的
 *     coalescing 處理),再回一句簡短訊息並以 end_turn 結束——用來在沒有真實
 *     ACP agent 的情況下,決定性地驗證 AcpAdapter 對 available_commands_update
 *     的事件轉換。
 *   - 若 prompt 文字以 DIFF_CONTENT_PREFIX("ACP_DIFF_CONTENT ")開頭,其後接
 *     一段 JSON `{"path": string, "oldText"?: string, "newText": string}`
 *     (Codex ACP 橋接切換 Phase 3「diff 顯示」路徑 A 的 e2e 用,見
 *     scripts/e2e-gateway.mjs):送出 `tool_call`(kind: "edit",
 *     **刻意不帶 `locations`**,好讓這個情境只可能命中路徑 A、不可能誤觸路徑
 *     B 的檔案快照 fallback,兩條路徑的測試訊號才不會混在一起),再送
 *     `tool_call_update`(status: "completed",`content: [{type:"diff", path,
 *     oldText, newText}]`)——不實際寫入任何檔案(純粹測試
 *     session/update → AgentEvent 的轉換邏輯,見
 *     packages/adapters/src/acp-adapter.ts 的 `findDiffBlock()`/
 *     `buildDiffStructuredResult()`),用來在沒有真實 ACP agent 的情況下,
 *     決定性地驗證 AcpAdapter 對原生 diff 內容區塊的重建結果。
 *   - 若 prompt 文字以 CALL_BRIDGE_TOOL_PREFIX("ACP_CALL_BRIDGE_TOOL ")開頭,
 *     其後接一段 JSON `{"tool": string, "args": object}`(Phase 2 scoped MCP
 *     bridge token 的 e2e 用,見 scripts/e2e-gateway.mjs):**真的**把
 *     `session/new` 請求裡收到的 `mcpServers[0]`(`AcpAdapter.spawn()` 透過
 *     `SessionBuilder.withMcpServer()` 掛上的 mcp-bridge-server.ts 設定,見
 *     `newSession()` 如何把它存進 `this.sessions`)當成一個 `StdioServerParameters`
 *     spawn 成真正的子行程,用 `@modelcontextprotocol/sdk` 的 `Client` +
 *     `StdioClientTransport` 連上去、呼叫 `tool` 這個工具、把回傳的
 *     `CallToolResult` 轉成一則 `agent_message_chunk`
 *     (`"BRIDGE_TOOL_RESULT:" + JSON.stringify(result)`)送回去,再關閉這個
 *     client。這是**決定性**的(完全由這支腳本的程式碼決定要不要呼叫、呼叫
 *     哪個工具,不依賴任何真實模型的自由選擇),但走的是完整的真實管線:
 *     AcpAdapter 核發的 scoped token → 真的透過 WS 打回 gateway → 真的觸發
 *     SessionManager 對應的方法(session 網路五個工具)——見
 *     packages/adapters/src/mcp-bridge-server.ts 的完整安全/協定說明。
 *     `mcpServers` 陣列為空(這個 session 沒有掛任何 MCP server,例如沒有
 *     subagentPort 的一般 ACP session)時,回覆一則固定的錯誤文字
 *     `"BRIDGE_TOOL_RESULT_ERROR: no mcpServers configured"`,不嘗試 spawn
 *     任何東西。
 *   - 若 prompt 文字**任何位置**含 BRIDGE_ON_PROMPT_PATTERN 標記
 *     `[[E2E_BRIDGE_ON_PROMPT:<base64>]]`(2026-10-02,P3 session 網路 e2e 用,見
 *     scripts/e2e-session-network.mjs):`<base64>` 是 `{"tool": string, "args": object}` 的 JSON 以 base64
 *     編碼(base64 不含 `]`,所以標記可以巢狀塞進另一則訊息的內文而不會截斷)。這個 agent 收到含標記的
 *     prompt 時,**自己**用 `CALL_BRIDGE_TOOL_PREFIX` 那條完全相同的真實管線(spawn mcp-bridge 子行程 → scoped
 *     token → gateway)呼叫該工具,把結果回成 `BRIDGE_ON_PROMPT_RESULT:` + JSON。用來決定性地模擬「agent 收到訊息後
 *     自己決定回覆(send_to_session)」——A↔B 互傳的訊息鏈就是靠這個巢狀標記一層一層推進的,不依賴任何真實模型。
 *     標記是明確的、由測試腳本逐字組出來的,不是「看起來像指令的自然語言」,所以不會誤觸。
 *   - 若 prompt 文字以 SAY_PREFIX("ACP_SAY ")開頭:原封不動把其後的文字當成這一輪的回覆(不加任何前綴、
 *     **不**解讀裡面的標記)——e2e 用它造出「內文含 BRIDGE_ON_PROMPT 標記的 assistant 訊息」,再被「轉傳到…」
 *     給另一個 session,驗證轉傳開的新鏈會被收到的 agent 沿用。
 *   - 若 prompt 文字等於 UPSERT_TOOL_CALLS_PREFIX("ACP_UPSERT_TOOL_CALLS",
 *     不接受任何參數)(CLI/TUI「同一個 toolCallId 只印一行」的 e2e 用,見
 *     scripts/e2e-cli.mjs 的案例 11 與 scripts/e2e-cli-tui.mjs 的案例 9f):
 *     在同一輪裡送出兩個工具,涵蓋 `ToolCallEventSchema` 的 upsert 語意
 *     (同一個 `toolCallId` 可以來不只一次)的兩條路徑——
 *       1. `UpsertTool`:同一個 toolCallId 送**兩則** `tool_call` 通知,第一則
 *          不帶 `rawInput`(對應 claude-sdk-adapter 在 `content_block_start`
 *          時 input 還在串流、只能先送 `input: undefined` 的那一次,以及
 *          opencode-adapter 的 `pending`),第二則帶完整 `rawInput`(對應那兩
 *          個 adapter 之後「參數齊了再送一次」的那一次),最後一則
 *          `tool_call_update`(completed)。
 *          ⚠️ 送兩則 `tool_call`(而不是用 `tool_call_update` 更新)**不是**
 *          標準 ACP 的用法——標準做法(真實 OpenCode 就是這樣)是第二次改用
 *          帶 `rawInput` 的 `tool_call_update`,`AcpAdapter.handleSessionUpdate()`
 *          也會把它補送成第二個 `tool-call` 事件,那條路徑由下面的
 *          OPENCODE_TOOL_CALLS_PREFIX 涵蓋。這裡保留送兩則 `tool_call` 的寫法,
 *          是因為 CLI/TUI 的 e2e 要驗的是 AgentEvent 層的 upsert 規則,兩種 ACP
 *          寫法在 AgentEvent 層長得一樣,維持原樣就不必改動既有斷言。
 *       2. `NoInputTool`:只送一則不帶 `rawInput` 的 `tool_call`,接著直接
 *          `tool_call_update`(completed)——**永遠等不到 input** 的工具
 *          (被中斷的工具,或 `tool_call` 本來就沒帶 `rawInput` 的真實 ACP
 *          agent)。CLI/TUI 不能因為「等帶 input 的那次」而讓這種工具整行
 *          消失,必須在 tool-result 抵達時補印。
 *     兩個工具都是 `kind: "other"` 且不帶 `locations`,確保不會意外命中
 *     `resolveEditSnapshotPath()` 的檔案快照路徑(那是 diff 顯示路徑 B,與
 *     這個情境無關)。
 *   - 若 prompt 文字以 OPENCODE_TOOL_CALLS_PREFIX("ACP_OPENCODE_TOOL_CALLS ")
 *     開頭,其後接一段 JSON `{"count": number}`(2026-10-03,e2e-opencode-tool-input.mjs
 *     的 E 組用):在同一輪裡送出 `count` 個**照真實 OpenCode(1.18.7)順序**的
 *     工具呼叫——先 `tool_call`(`pending`,`rawInput: {}` 佔位),再
 *     `tool_call_update`(`in_progress`,**第一次帶真正的參數**,同時帶一個和
 *     `tool_call` 不同的 title),再一則 `in_progress` 把同一份參數原樣重報
 *     (adapter 不能因此多送事件),最後 `tool_call_update`(`completed`,`rawInput`
 *     再帶一次同一份)。每個工具的參數是 `opencodeToolInput(i)`、title 分別是
 *     `OPENCODE_TOOL_PENDING_TITLE` / `opencodeToolRunningTitle(i)`,e2e 直接 import,
 *     不在兩邊各寫一份字面值。用來決定性地驗證 AcpAdapter 會把 `tool_call_update`
 *     帶來的參數補送成同一個 toolCallId 的第二個 `tool-call` 事件,而 core 不重複
 *     計數(`count` 個工具只計 `count` 次)。
 *   - 若 prompt 文字等於 EMPTY_RESULT_TOOL_NAME_PREFIX
 *     ("ACP_EMPTY_RESULT_TOOL_NAME",不接受任何參數)(CLI/TUI「工具失敗那
 *     一行要有工具名稱」的 e2e 用,見 scripts/e2e-cli.mjs 的案例 12 與
 *     scripts/e2e-cli-tui.mjs 的案例 9j/9k):在同一輪裡送出兩個**失敗**的
 *     工具,兩個的 `tool-result` AgentEvent 都帶**空字串** `toolName`——那正是
 *     packages/adapters/src/claude-sdk-adapter.ts 組 `tool-result` 時寫死的形狀
 *     (`toolName: ""`,真正的名字只有 `tool-call` 事件帶,見
 *     apps/desktop/src/stores/session-store.ts 的 `upsertToolItem()`)。CLI/TUI
 *     過去直接拿它組「<工具名稱> 執行失敗」,於是每個 Claude session 的工具
 *     失敗都渲染成開頭少一個主詞的「  !  執行失敗:...」。
 *       1. `FailingUpsertTool`:先一則帶 `rawInput` 的 `tool_call`(呼叫那一行
 *          會在這時候就印出來),再一則**標題是空字串**的 `tool_call`,最後
 *          `tool_call_update`(status: "failed")——涵蓋「呼叫那行已經印過」的
 *          路徑,錯誤行的名字只能從 tracker 記下的名字來。
 *       2. `FailingNoInputTool`:兩則 `tool_call` 都不帶 `rawInput`(第二則標題
 *          同樣是空字串),再 `tool_call_update`(status: "failed")——涵蓋
 *          「呼叫那行是到 tool-result 才補印」的路徑,補印行與錯誤行都要有名字。
 *     ⚠️ 那則「標題是空字串的第二個 `tool_call`」是這個 fixture 的**裝置**,
 *     不是真實 ACP agent 的行為:`AcpAdapter` 會把 `tool_call` 的 title 記進
 *     `internal.toolTitles`,並在 `tool_call_update` 時拿來補 `tool-result` 的
 *     `toolName`(見 packages/adapters/src/acp-adapter.ts 的
 *     `handleSessionUpdate()`),所以純 ACP 路徑**不可能**自己產生空的 result
 *     `toolName`。但要驗的是 CLI/TUI 那條**與 adapter 無關**的渲染規則(它們
 *     收到的是 AgentEvent,不是 ACP 通知),而在沒有真實 Claude 憑證的情況下,
 *     唯一能把那個 AgentEvent 形狀餵給**真正的 CLI 子程序**的方法就是讓這個
 *     假 agent 把 title 蓋成空字串——與上面 UPSERT_TOOL_CALLS 送兩則
 *     `tool_call` 是同一種取捨,理由見該段的 ⚠️。
 */

import * as acp from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";
import { writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export const FAKE_ACP_REPLY_CHUNKS = ["Hello", " from", " fake ACP agent"];
export const WRITE_FILE_PREFIX = "ACP_WRITE_FILE ";
/** S3a(usage-metering)e2e 用,見檔頭註解。 */
export const USAGE_UPDATE_PREFIX = "ACP_USAGE_UPDATE ";
/** S3b(cost-governor)TurnLimiter e2e 用,見檔頭註解。 */
export const MANY_TOOL_CALLS_PREFIX = "ACP_MANY_TOOL_CALLS ";
/** S3b(cost-governor)TurnLimiter e2e 用,見檔頭註解。 */
export const SLEEP_TURN_PREFIX = "ACP_SLEEP_TURN ";
/** 這輪(slash command)e2e 用,見檔頭註解。 */
export const AVAILABLE_COMMANDS_PREFIX = "ACP_AVAILABLE_COMMANDS ";
/** Codex ACP 橋接切換 Phase 3(diff 顯示)路徑 A e2e 用,見檔頭註解。 */
export const DIFF_CONTENT_PREFIX = "ACP_DIFF_CONTENT ";
/** Phase 2(ACP scoped MCP bridge token)e2e 用,見檔頭註解。 */
export const CALL_BRIDGE_TOOL_PREFIX = "ACP_CALL_BRIDGE_TOOL ";
/**
 * Phase 2 e2e 用(不接受任何參數,純字面比對):把這個 session 於
 * `session/new` 收到的完整 `mcpServers` 陣列(含 `AcpAdapter.spawn()` 核發的
 * scoped token 本身,見 `newSession()`)原樣 JSON 化回顯。給
 * scripts/e2e-gateway.mjs 用來取出**真實核發**的 token/gatewayUrl,直接用
 * `GatewayClient` 對 gateway 做低階的白名單/綁定範圍/過期/撤銷決定性測試
 * (不透過 MCP 協議本身走一輪——那部分由 `CALL_BRIDGE_TOOL_PREFIX` 涵蓋),
 * 兩者互補,合起來涵蓋「token 核發的內容正確」與「token 真的能驅動完整
 * MCP 管線」兩個不同的斷言面向。
 */
export const REPORT_MCP_SERVERS_PREFIX = "ACP_REPORT_MCP_SERVERS";
/**
 * 2026-10-03 e2e 用(不接受任何參數,純字面比對):回覆 `ENV:` + JSON(`{ OPENCODE_CONFIG_CONTENT: <這個子行程收到的原始
 * 字串,沒有則 null> }`)。給 scripts/e2e-opencode-permissions.mjs 斷言 Deskmony 啟動 `opencode acp` 這一家(provider 目錄
 * 的 `family: "opencode"`)時注入的「所有工具 ask」設定,以及其他 ACP agent **沒有**被注入(對照組)。
 */
export const REPORT_ENV_PREFIX = "ACP_REPORT_ENV";
/**
 * 2026-10-03(安全:認證):`ENV:` 回覆多一個 `serverAuth`——子行程收到的 `OPENCODE_SERVER_PASSWORD`/`OPENCODE_SERVER_USERNAME`
 * 的**描述**(沒收到密碼是 null;有收到是 `{username, passwordLength, passwordSha256}`)。刻意**不回顯密碼本身**:回覆會進
 * `session.history`,而 e2e 要斷言密碼不會出現在對話裡;雜湊足夠讓測試判斷「每次 spawn 都不同」(256 bit 隨機值的雜湊不洩漏什麼)。
 * `opencode acp` 實測會在 loopback 開 HTTP 伺服器(固定 4096、預設無認證),所以 Deskmony 對 opencode 家族的 ACP 子行程也要設密碼,
 * 見 packages/adapters/src/opencode-server-auth.ts。
 */
function describeServerAuth() {
  const password = process.env.OPENCODE_SERVER_PASSWORD;
  if (password === undefined) return null;
  return {
    username: process.env.OPENCODE_SERVER_USERNAME ?? null,
    passwordLength: password.length,
    passwordSha256: createHash("sha256").update(password).digest("hex"),
  };
}
/**
 * 2026-10-05(安全:agent 子行程環境不得含 Deskmony 憑證)e2e 用:`ACP_REPORT_PRESENCE:<逗號分隔的變數名稱>` →
 * 回覆 `PRESENCE:` + JSON(`{ <名稱>: boolean }`)——**只回報這個子行程的環境裡「有沒有」這個變數(不分大小寫比對,
 * Windows 的環境變數不分大小寫),絕不回顯值**:回覆會進 `session.history`/log,而 e2e 要斷言 token 不會出現在那裡。
 * 給 scripts/e2e-agent-env.mjs 斷言 `DESKMONY_AUTH_TOKEN`/`DESKMONY_MCP_BRIDGE_*` 沒有被繼承進 agent 的環境。
 */
export const REPORT_PRESENCE_PREFIX = "ACP_REPORT_PRESENCE:";
/** 回報 `names` 各自在 `process.env` 裡是否存在(不分大小寫);給三支 fake 後端共用的語意(見 fake-opencode-server/fake-pty-echo)。 */
function describePresence(namesCsv) {
  const upperKeys = new Set(Object.keys(process.env).map((k) => k.toUpperCase()));
  return Object.fromEntries(
    namesCsv
      .split(",")
      .map((n) => n.trim())
      .filter(Boolean)
      .map((name) => [name, upperKeys.has(name.toUpperCase())]),
  );
}
/** P3(session 網路)e2e 用,見檔頭註解:把其後的文字原樣當成這一輪的回覆。 */
export const SAY_PREFIX = "ACP_SAY ";
/** P3(session 網路)e2e 用,見檔頭註解:prompt 任何位置含這個標記就自己呼叫 bridge 工具。 */
const BRIDGE_ON_PROMPT_PATTERN = /\[\[E2E_BRIDGE_ON_PROMPT:([A-Za-z0-9+/=]+)\]\]/;
/** 建構出一段「收到這則 prompt 的 agent 要呼叫 bridge 工具 `tool`(帶 `args`)」的標記文字。 */
export function bridgeOnPromptMarker(tool, args) {
  return `[[E2E_BRIDGE_ON_PROMPT:${Buffer.from(JSON.stringify({ tool, args }), "utf8").toString("base64")}]]`;
}
/** CLI/TUI「同一個 toolCallId 只印一行」e2e 用(不接受參數),見檔頭註解。 */
export const UPSERT_TOOL_CALLS_PREFIX = "ACP_UPSERT_TOOL_CALLS";
/** 上面那一輪用到的固定字串——e2e 直接 import,不在兩邊各寫一份字面值。 */
export const UPSERT_TOOL_TITLE = "UpsertTool";
export const NO_INPUT_TOOL_TITLE = "NoInputTool";
export const UPSERT_TOOL_COMMAND = "echo upsert-input-arrived";
export const UPSERT_DONE_TEXT = "upsert tool calls sent";
/** e2e-opencode-tool-input.mjs E 組用:照真實 OpenCode 的 ACP 通知順序送工具呼叫,見檔頭註解。 */
export const OPENCODE_TOOL_CALLS_PREFIX = "ACP_OPENCODE_TOOL_CALLS ";
/** 上面那一輪用到的固定字串/參數——e2e 直接 import,不在兩邊各寫一份字面值。 */
export const OPENCODE_TOOL_PENDING_TITLE = "opencode_tool";
export const opencodeToolRunningTitle = (index) => `opencode_tool_running_${index}`;
export const opencodeToolInput = (index) => ({ message: `opencode-style-input-${index}`, limit: index + 10 });
/** CLI/TUI「工具失敗那一行要有工具名稱」e2e 用(不接受參數),見檔頭註解。 */
export const EMPTY_RESULT_TOOL_NAME_PREFIX = "ACP_EMPTY_RESULT_TOOL_NAME";
/** 上面那一輪用到的固定字串——e2e 直接 import,不在兩邊各寫一份字面值。 */
export const FAILING_UPSERT_TOOL_TITLE = "FailingUpsertTool";
export const FAILING_NO_INPUT_TOOL_TITLE = "FailingNoInputTool";
export const FAILING_TOOL_COMMAND = "echo will-fail";
export const FAILING_TOOL_ERROR_TEXT = "boom";
export const EMPTY_RESULT_DONE_TEXT = "failing tool calls sent";
/** 建構出一段「延遲 delayMs 毫秒後把整段 prompt 文字回顯」的標記文字。 */
export function delayEchoMarker(delayMs) {
  return `[[E2E_DELAY_ECHO:${delayMs}]]`;
}
const DELAY_ECHO_PATTERN = /\[\[E2E_DELAY_ECHO:(\d+)\]\]/;

class FakeAcpAgent {
  constructor() {
    /** @type {Map<string, { abort: AbortController | null }>} */
    this.sessions = new Map();
  }

  async initialize() {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: { loadSession: false },
    };
  }

  async newSession(params) {
    const sessionId = randomUUID();
    // Phase 2(ACP scoped MCP bridge token)e2e 用:把這次 `session/new` 請求
    // 帶的 `mcpServers`(AcpAdapter.spawn() 透過 `SessionBuilder.
    // withMcpServer()` 掛上的設定,見檔頭註解)存起來,供
    // `handleCallBridgeTool()` 之後真的拿去 spawn 成子行程。沒有掛任何
    // server 時(這個 session 沒有 subagentPort)是空陣列,不是
    // undefined(見 NewSessionRequest.mcpServers 的型別——必填欄位)。
    this.sessions.set(sessionId, { abort: null, mcpServers: params?.mcpServers ?? [] });
    return { sessionId };
  }

  async authenticate() {
    return {};
  }

  async setSessionMode() {
    return {};
  }

  cancel(params) {
    this.sessions.get(params.sessionId)?.abort?.abort();
  }

  async prompt(params, cx) {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw new Error(`未知的 ACP session: ${params.sessionId}`);
    }

    const text = extractText(params.prompt);
    const abort = new AbortController();
    session.abort = abort;

    try {
      // 2026-10-02(P3):呼叫 bridge 工具的三條路徑**排在最前面**——它們的內文(`message` 參數、巢狀標記)本來就會
      // 含 `[[E2E_DELAY_ECHO:...]]` 這類標記,先比對 DELAY_ECHO 的話,A 的「呼叫 send_to_session」prompt 會被當成
      // 回顯而不是真的呼叫工具。
      if (text.startsWith(CALL_BRIDGE_TOOL_PREFIX)) {
        await this.handleCallBridgeTool(params.sessionId, text.slice(CALL_BRIDGE_TOOL_PREFIX.length), cx);
      } else if (text.startsWith(SAY_PREFIX)) {
        await this.handleSay(params.sessionId, text.slice(SAY_PREFIX.length), cx);
      } else if (BRIDGE_ON_PROMPT_PATTERN.test(text)) {
        await this.handleBridgeOnPrompt(params.sessionId, text, cx);
      } else if (DELAY_ECHO_PATTERN.test(text)) {
        await this.handleDelayEcho(params.sessionId, text, cx);
      } else if (text.startsWith(WRITE_FILE_PREFIX)) {
        await this.handleWriteFile(params.sessionId, text.slice(WRITE_FILE_PREFIX.length), cx);
      } else if (text.startsWith(USAGE_UPDATE_PREFIX)) {
        await this.handleUsageUpdate(params.sessionId, text.slice(USAGE_UPDATE_PREFIX.length), cx);
      } else if (text.startsWith(MANY_TOOL_CALLS_PREFIX)) {
        await this.handleManyToolCalls(params.sessionId, text.slice(MANY_TOOL_CALLS_PREFIX.length), cx);
      } else if (text.startsWith(SLEEP_TURN_PREFIX)) {
        await this.handleSleepTurn(params.sessionId, text.slice(SLEEP_TURN_PREFIX.length), abort, cx);
      } else if (text.startsWith(AVAILABLE_COMMANDS_PREFIX)) {
        await this.handleAvailableCommands(params.sessionId, text.slice(AVAILABLE_COMMANDS_PREFIX.length), cx);
      } else if (text.startsWith(DIFF_CONTENT_PREFIX)) {
        await this.handleDiffContent(params.sessionId, text.slice(DIFF_CONTENT_PREFIX.length), cx);
      } else if (text.startsWith(OPENCODE_TOOL_CALLS_PREFIX)) {
        await this.handleOpencodeToolCalls(params.sessionId, text.slice(OPENCODE_TOOL_CALLS_PREFIX.length), cx);
      } else if (text === UPSERT_TOOL_CALLS_PREFIX) {
        await this.handleUpsertToolCalls(params.sessionId, cx);
      } else if (text === EMPTY_RESULT_TOOL_NAME_PREFIX) {
        await this.handleEmptyResultToolName(params.sessionId, cx);
      } else if (text === REPORT_MCP_SERVERS_PREFIX) {
        await this.handleReportMcpServers(params.sessionId, cx);
      } else if (text === REPORT_ENV_PREFIX) {
        await this.handleReportEnv(params.sessionId, cx);
      } else if (text.startsWith(REPORT_PRESENCE_PREFIX)) {
        await this.handleReportPresence(params.sessionId, text.slice(REPORT_PRESENCE_PREFIX.length), cx);
      } else {
        await this.handleEcho(params.sessionId, cx);
      }
    } finally {
      session.abort = null;
    }

    return { stopReason: abort.signal.aborted ? "cancelled" : "end_turn" };
  }

  async handleEcho(sessionId, cx) {
    const messageId = randomUUID();
    for (const chunk of FAKE_ACP_REPLY_CHUNKS) {
      await cx.notify(acp.methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId,
          content: { type: "text", text: chunk },
        },
      });
    }
  }

  /** 見檔頭註解:延遲後把完整收到的 prompt 文字加上 "ECHO:" 前綴回顯。 */
  async handleDelayEcho(sessionId, text, cx) {
    const match = text.match(DELAY_ECHO_PATTERN);
    const delayMs = match ? Number(match[1]) : 0;
    if (delayMs > 0) {
      await delay(delayMs);
    }
    const messageId = randomUUID();
    await cx.notify(acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId,
        content: { type: "text", text: `ECHO:${text}` },
      },
    });
  }

  /** S3a(usage-metering)e2e 用,見檔頭註解:送一則 usage_update,cost 有給才附帶。 */
  async handleUsageUpdate(sessionId, rawJson, cx) {
    const { used, size, cost } = JSON.parse(rawJson);
    await cx.notify(acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "usage_update",
        used,
        size,
        ...(cost ? { cost } : {}),
      },
    });

    const messageId = randomUUID();
    await cx.notify(acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId,
        content: { type: "text", text: "usage reported" },
      },
    });
  }

  /** 這輪(slash command)e2e 用,見檔頭註解:送一則 available_commands_update,`hint` 有給才組進 `input`。 */
  async handleAvailableCommands(sessionId, rawJson, cx) {
    const { commands } = JSON.parse(rawJson);
    await cx.notify(acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: commands.map((c) => ({
          name: c.name,
          description: c.description ?? "",
          ...(c.hint ? { input: { hint: c.hint } } : {}),
        })),
      },
    });

    const messageId = randomUUID();
    await cx.notify(acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId,
        content: { type: "text", text: "commands reported" },
      },
    });
  }

  /**
   * Codex ACP 橋接切換 Phase 3(diff 顯示)路徑 A e2e 用,見檔頭註解:送出
   * 一則帶原生 `type:"diff"` content block 的 `tool_call_update`,不觸碰真實
   * 檔案系統。`tool_call` 刻意不帶 `locations`,確保這個情境不會意外也命中
   * 路徑 B(檔案快照 fallback)。
   */
  async handleDiffContent(sessionId, rawJson, cx) {
    const { path: diffPath, oldText, newText } = JSON.parse(rawJson);
    const toolCallId = `diff-${randomUUID()}`;

    await cx.notify(acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId,
        title: "Apply patch",
        kind: "edit",
        status: "pending",
        rawInput: { path: diffPath },
      },
    });

    await cx.notify(acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "completed",
        content: [
          {
            type: "diff",
            path: diffPath,
            ...(oldText !== undefined ? { oldText } : {}),
            newText,
          },
        ],
        rawOutput: { success: true },
      },
    });

    const messageId = randomUUID();
    await cx.notify(acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId,
        content: { type: "text", text: "diff reported" },
      },
    });
  }

  /**
   * Phase 2(ACP scoped MCP bridge token)e2e 用,見檔頭註解:真的把
   * `session/new` 收到的 `mcpServers[0]` 當成 `StdioServerParameters` spawn
   * 成子行程,用真正的 MCP client 連上去呼叫一個工具,把結果回顯成訊息。
   * `mcpServers` 為空時不嘗試 spawn 任何東西,直接回覆固定的錯誤文字——見
   * 檔頭註解對這個分支的完整說明。
   */
  async handleCallBridgeTool(sessionId, rawJson, cx) {
    const { tool: toolName, args } = JSON.parse(rawJson);
    await this.runBridgeTool(sessionId, toolName, args, cx, "BRIDGE_TOOL_RESULT");
  }

  /** P3 e2e 用,見檔頭 BRIDGE_ON_PROMPT_PATTERN 註解:收到含標記的 prompt,自己呼叫標記裡指定的 bridge 工具。 */
  async handleBridgeOnPrompt(sessionId, text, cx) {
    const match = text.match(BRIDGE_ON_PROMPT_PATTERN);
    const { tool: toolName, args } = JSON.parse(Buffer.from(match[1], "base64").toString("utf8"));
    await this.runBridgeTool(sessionId, toolName, args, cx, "BRIDGE_ON_PROMPT_RESULT");
  }

  /** P3 e2e 用,見檔頭 SAY_PREFIX 註解:原封不動把 `text` 當成這一輪的回覆。 */
  async handleSay(sessionId, text, cx) {
    await cx.notify(acp.methods.client.session.update, {
      sessionId,
      update: { sessionUpdate: "agent_message_chunk", messageId: randomUUID(), content: { type: "text", text } },
    });
  }

  /** `handleCallBridgeTool()` 與 `handleBridgeOnPrompt()` 共用:真的 spawn bridge 子行程並呼叫一個工具。 */
  async runBridgeTool(sessionId, toolName, args, cx, resultPrefix) {
    const session = this.sessions.get(sessionId);
    const mcpServer = session?.mcpServers?.[0];
    const messageId = randomUUID();

    if (!mcpServer) {
      await cx.notify(acp.methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId,
          content: { type: "text", text: `${resultPrefix}_ERROR: no mcpServers configured` },
        },
      });
      return;
    }

    // `schema.McpServerStdio` 的 `env` 是 `Array<{name, value}>`(ACP 協議的
    // wire 形狀),`StdioClientTransport`(MCP SDK 的 client-side transport,
    // 自己會 spawn 子行程並接管它的 stdio)要的是 `Record<string,string>`
    // ——這裡做形狀轉換,不改變任何實際的 key/value。
    const env = Object.fromEntries((mcpServer.env ?? []).map((e) => [e.name, e.value]));
    const transport = new StdioClientTransport({
      command: mcpServer.command,
      args: mcpServer.args ?? [],
      env: { ...process.env, ...env },
    });
    const client = new Client({ name: "deskmony-fake-acp-agent-bridge-client", version: "1.0.0" });

    let resultText;
    try {
      await client.connect(transport);
      const result = await client.callTool({ name: toolName, arguments: args ?? {} });
      resultText = `${resultPrefix}:${JSON.stringify(result)}`;
    } catch (err) {
      resultText = `${resultPrefix}_ERROR: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      try {
        await client.close();
      } catch {
        // ignore
      }
    }

    await cx.notify(acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId,
        content: { type: "text", text: resultText },
      },
    });
  }

  /** 2026-10-03 e2e 用,見 REPORT_ENV_PREFIX 的常數註解。 */
  async handleReportEnv(sessionId, cx) {
    const messageId = randomUUID();
    await cx.notify(acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId,
        content: { type: "text", text: `ENV:${JSON.stringify({ OPENCODE_CONFIG_CONTENT: process.env.OPENCODE_CONFIG_CONTENT ?? null, serverAuth: describeServerAuth() })}` },
      },
    });
  }

  /** 2026-10-05 e2e 用,見 REPORT_PRESENCE_PREFIX 的常數註解。 */
  async handleReportPresence(sessionId, namesCsv, cx) {
    await cx.notify(acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: randomUUID(),
        content: { type: "text", text: `PRESENCE:${JSON.stringify(describePresence(namesCsv))}` },
      },
    });
  }

  /** Phase 2 e2e 用,見 REPORT_MCP_SERVERS_PREFIX 的檔頭/常數註解。 */
  async handleReportMcpServers(sessionId, cx) {
    const session = this.sessions.get(sessionId);
    const messageId = randomUUID();
    await cx.notify(acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId,
        content: { type: "text", text: `MCP_SERVERS:${JSON.stringify(session?.mcpServers ?? [])}` },
      },
    });
  }

  /**
   * CLI/TUI「同一個 toolCallId 只印一行」的 e2e 用,見檔頭註解:同一輪裡送出
   * 兩個工具,分別重現 upsert 的兩條路徑(先無 input 後補 input / 永遠沒有
   * input)。刻意固定不帶延遲——這一輪要驗的是「幾行」,不是時序。
   */
  async handleUpsertToolCalls(sessionId, cx) {
    const upsertId = `upsert-${randomUUID()}`;

    // 路徑 1 第一次:input 未知(= claude-sdk-adapter 的 content_block_start)。
    await cx.notify(acp.methods.client.session.update, {
      sessionId,
      update: { sessionUpdate: "tool_call", toolCallId: upsertId, title: UPSERT_TOOL_TITLE, kind: "other", status: "pending" },
    });
    // 路徑 1 第二次:同一個 id,這次帶完整 input(= 完整 assistant 訊息抵達)。
    // `command` 是 render.ts 的 COMMAND_KEYS 之一,所以摘要會變成
    // 「<工具名稱> <指令>」——e2e 就是靠這個字串分辨「印出來的是帶參數的那一
    // 行」還是「光禿禿的那一行」。
    await cx.notify(acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: upsertId,
        title: UPSERT_TOOL_TITLE,
        kind: "other",
        status: "in_progress",
        rawInput: { command: UPSERT_TOOL_COMMAND },
      },
    });
    await cx.notify(acp.methods.client.session.update, {
      sessionId,
      update: { sessionUpdate: "tool_call_update", toolCallId: upsertId, status: "completed", rawOutput: { ok: true } },
    });

    // 路徑 2:從頭到尾沒有 input,只有 tool_call + tool_call_update。
    const noInputId = `noinput-${randomUUID()}`;
    await cx.notify(acp.methods.client.session.update, {
      sessionId,
      update: { sessionUpdate: "tool_call", toolCallId: noInputId, title: NO_INPUT_TOOL_TITLE, kind: "other", status: "pending" },
    });
    await cx.notify(acp.methods.client.session.update, {
      sessionId,
      update: { sessionUpdate: "tool_call_update", toolCallId: noInputId, status: "completed", rawOutput: { ok: true } },
    });

    const messageId = randomUUID();
    await cx.notify(acp.methods.client.session.update, {
      sessionId,
      update: { sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text: UPSERT_DONE_TEXT } },
    });
  }

  /**
   * 見檔頭註解的 OPENCODE_TOOL_CALLS_PREFIX:`count` 個照真實 OpenCode ACP 順序的工具呼叫
   * (`tool_call` 帶 `{}` 佔位 → `tool_call_update` in_progress 才帶真參數 → 重報同一份 →
   * completed 再帶一次)。`kind: "other"` 且不帶 `locations`,不會碰到 diff 的檔案快照路徑。
   */
  async handleOpencodeToolCalls(sessionId, rawJson, cx) {
    const { count } = JSON.parse(rawJson);
    for (let i = 0; i < count; i++) {
      const toolCallId = `opencode-style-${i}-${randomUUID()}`;
      const input = opencodeToolInput(i);
      await cx.notify(acp.methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId,
          title: OPENCODE_TOOL_PENDING_TITLE,
          kind: "other",
          status: "pending",
          rawInput: {},
        },
      });
      await cx.notify(acp.methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId,
          title: opencodeToolRunningTitle(i),
          status: "in_progress",
          rawInput: input,
        },
      });
      // 同一份參數原樣重報:adapter 不能因此再多送一個 tool-call 事件。
      await cx.notify(acp.methods.client.session.update, {
        sessionId,
        update: { sessionUpdate: "tool_call_update", toolCallId, status: "in_progress", rawInput: input },
      });
      await cx.notify(acp.methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: "completed",
          rawInput: input,
          rawOutput: { ok: true, index: i },
        },
      });
    }
    await cx.notify(acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId: randomUUID(),
        content: { type: "text", text: `opencode-style tool calls sent: ${count}` },
      },
    });
  }

  /**
   * 見檔頭註解:兩個**失敗**的工具,兩個的 `tool-result` 都帶空字串 `toolName`。
   * 每個工具的第二則 `tool_call` 標題刻意是空字串——那是把 `AcpAdapter` 的
   * `internal.toolTitles` 蓋掉、讓它在 `tool_call_update` 時補不出名字的唯一
   * 手段(這個 fixture 的裝置,不是真實 agent 的行為,理由見檔頭註解的 ⚠️)。
   * 這一則本身不會在 CLI/TUI 多印一行:同一個 toolCallId 已經被
   * `createToolCallLineTracker()` 的規則 1 收斂掉了。
   */
  async handleEmptyResultToolName(sessionId, cx) {
    const sendCall = (toolCallId, title, rawInput) =>
      cx.notify(acp.methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId,
          title,
          kind: "other",
          status: rawInput ? "in_progress" : "pending",
          ...(rawInput ? { rawInput } : {}),
        },
      });
    const sendFailed = (toolCallId) =>
      cx.notify(acp.methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: "failed",
          rawOutput: { error: FAILING_TOOL_ERROR_TEXT },
        },
      });

    // 路徑 1:呼叫那一行在第一則就印出來了(帶 rawInput),錯誤行的名字只能
    // 從 tracker 宣告時記下的名字來。
    const upsertId = `fail-upsert-${randomUUID()}`;
    await sendCall(upsertId, FAILING_UPSERT_TOOL_TITLE, { command: FAILING_TOOL_COMMAND });
    await sendCall(upsertId, "", undefined);
    await sendFailed(upsertId);

    // 路徑 2:從頭到尾沒有 rawInput,呼叫那一行要到 tool-result 才補印——補印
    // 行與錯誤行都要有名字。
    const noInputId = `fail-noinput-${randomUUID()}`;
    await sendCall(noInputId, FAILING_NO_INPUT_TOOL_TITLE, undefined);
    await sendCall(noInputId, "", undefined);
    await sendFailed(noInputId);

    const messageId = randomUUID();
    await cx.notify(acp.methods.client.session.update, {
      sessionId,
      update: { sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text: EMPTY_RESULT_DONE_TEXT } },
    });
  }

  /**
   * S3b(cost-governor)TurnLimiter e2e 用,見檔頭註解:在同一輪內連續送出
   * `count` 則 `tool_call` 通知。`delayMs`(選填)在每次通知之間插入延遲,
   * 讓 core 端「第 N 次工具呼叫超標 → interrupt()」有時間真的在這個迴圈**中途**
   * 生效(每次迴圈都檢查 `abort.signal.aborted` 提早跳出),而不是整批瞬間
   * 送完才讓 core 事後才發現——用來決定性地證明 interrupt 真的中斷了正在
   * 進行的回合,不只是「core 決定要中斷但 agent 根本沒感覺到」。
   */
  async handleManyToolCalls(sessionId, rawJson, cx) {
    const { count, delayMs } = JSON.parse(rawJson);
    const session = this.sessions.get(sessionId);
    for (let i = 0; i < count; i++) {
      if (session?.abort?.signal.aborted) break;
      await cx.notify(acp.methods.client.session.update, {
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: `bulk-${i}-${randomUUID()}`,
          title: `BulkTool-${i}`,
          kind: "other",
          status: "completed",
          rawInput: { index: i },
        },
      });
      if (typeof delayMs === "number" && delayMs > 0) {
        try {
          await delay(delayMs, undefined, { signal: session?.abort?.signal });
        } catch {
          break;
        }
      }
    }
    if (session?.abort?.signal.aborted) return;
    const messageId = randomUUID();
    await cx.notify(acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId,
        content: { type: "text", text: `已送出 ${count} 次工具呼叫` },
      },
    });
  }

  /** S3b(cost-governor)TurnLimiter e2e 用,見檔頭註解:睡滿 `ms` 毫秒(可被
   *  `abort` 提早取消)後才結束這一輪。 */
  async handleSleepTurn(sessionId, rawJson, abort, cx) {
    const { ms } = JSON.parse(rawJson);
    try {
      await delay(ms, undefined, { signal: abort.signal });
    } catch {
      // 被 abort(session/cancel 抵達)提早中止——正常路徑,不視為錯誤。
      return;
    }
    const messageId = randomUUID();
    await cx.notify(acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId,
        content: { type: "text", text: `睡了 ${ms}ms 後正常結束` },
      },
    });
  }

  async handleWriteFile(sessionId, rawJson, cx) {
    const { path: targetPath, content, delayMs } = JSON.parse(rawJson);
    // 見檔頭註解:選填的前置延遲,給 e2e 腳本製造「權限請求送達 core 時,
    // 一個 client 都沒連著」的時間窗。
    if (typeof delayMs === "number" && delayMs > 0) {
      await delay(delayMs);
    }
    const messageId = randomUUID();

    await cx.notify(acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId,
        content: { type: "text", text: "好的,準備寫入檔案。" },
      },
    });

    const toolCallId = `write-${randomUUID()}`;
    await cx.notify(acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId,
        title: "Write file",
        kind: "edit",
        status: "pending",
        locations: [{ path: targetPath }],
        rawInput: { path: targetPath, content },
      },
    });

    const permissionResponse = await cx.request(acp.methods.client.session.requestPermission, {
      sessionId,
      toolCall: {
        toolCallId,
        title: "Write file",
        kind: "edit",
        status: "pending",
        rawInput: { path: targetPath, content },
      },
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "deny", name: "Reject", kind: "reject_once" },
      ],
    });

    const outcome = permissionResponse.outcome;
    const allowed = outcome.outcome === "selected" && outcome.optionId === "allow";

    if (!allowed) {
      // 拒絕(或使用者取消):不寫檔、不送 tool_call_update,直接結束這一輪。
      return;
    }

    writeFileSync(targetPath, content, "utf8");

    await cx.notify(acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: "completed",
        rawOutput: { success: true },
      },
    });

    await cx.notify(acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId,
        content: { type: "text", text: "已完成寫入。" },
      },
    });
  }
}

function extractText(prompt) {
  const blocks = Array.isArray(prompt) ? prompt : [prompt];
  return blocks
    .filter((block) => block && block.type === "text")
    .map((block) => block.text)
    .join("");
}

async function main() {
  const input = Writable.toWeb(process.stdout);
  const output = Readable.toWeb(process.stdin);
  const stream = acp.ndJsonStream(input, output);
  const agent = new FakeAcpAgent();

  acp
    .agent({ name: "deskmony-fake-acp-agent" })
    .onRequest(acp.methods.agent.initialize, () => agent.initialize())
    .onRequest(acp.methods.agent.session.new, (ctx) => agent.newSession(ctx.params))
    .onRequest(acp.methods.agent.authenticate, () => agent.authenticate())
    .onRequest(acp.methods.agent.session.setMode, () => agent.setSessionMode())
    .onRequest(acp.methods.agent.session.prompt, (ctx) => agent.prompt(ctx.params, ctx.client))
    .onNotification(acp.methods.agent.session.cancel, (ctx) => agent.cancel(ctx.params))
    .connect(stream);
}

// 只有「被當成獨立程序直接執行」時才啟動 stdio 連線(即 AcpAdapter.spawn()
// 啟動這支腳本的情境)。scripts/e2e-gateway.mjs 也會 `import` 這個檔案來
// 取用 FAKE_ACP_REPLY_CHUNKS / WRITE_FILE_PREFIX 常數(維持 prompt 文字與
// 這支 agent 的實際判斷邏輯同一個 source of truth),那種情況下不能連帶
// 把 e2e 腳本自己的 stdin/stdout 接管走。
const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main().catch((err) => {
    console.error("[fake-acp-agent] fatal:", err);
    process.exit(1);
  });
}
