import { randomUUID } from "node:crypto";
import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import path from "node:path";
import type { AgentEvent, AgentLaunchSpec, DialogAnswer, McpBridgeTokenPort, PromptInput, SessionNetworkPort, SlashCommandInfo } from "@deskmony/shared";
import { DeskmonyError, ErrorCodes } from "@deskmony/shared";
import type { AdapterCapabilities, AgentAdapter, AgentHandle, Workspace } from "./types.js";
import { AsyncQueue } from "./async-queue.js";
import { registerChild, registerChildDescendants, unregisterChild } from "./child-registry.js";
import { waitForChildExit } from "./child-process.js";
import { mintMcpBridgeLaunch } from "./mcp-bridge-launch.js";
import { buildOpencodeConfigContent, OPENCODE_CONFIG_CONTENT_ENV } from "./opencode-config.js";
import { applyOpencodeServerAuth } from "./opencode-server-auth.js";
import { buildAgentChildEnv } from "./agent-env.js";

/**
 * OpenCodeAdapter — 對接 opencode 的 headless server API(ARCHITECTURE.md
 * 3.4 節「OpenCodeAdapter | OpenCode 的 HTTP + SSE server API」,這輪補上
 * 一直沒實作的 adapter,修復「opencode 只是把 TUI 塞進終端視圖」的問題)。
 *
 * ---- 對接策略(**全部依實際執行 `opencode --help`/`opencode serve --help`
 * 與本機起一個真實 `opencode serve` process 觀察到的行為為準,不臆測**)----
 *
 *  - `opencode`(本機驗證版本 1.18.4)有一個原生子命令 `opencode serve`
 *    (`--port`/`--hostname`,預設 `--port 0`——**不是純隨機**:2026-10-03 用 1.18.7 實測,它先試 opencode 的預設 port
 *    4096,被占用才改隨機,所以第一個伺服器的位址是可預測的(見下方「認證」段落)、
 *    `--hostname 127.0.0.1`),啟動後會在 **stdout** 印出一行
 *    `opencode server listening on http://<host>:<port>`——這裡 spawn 子
 *    程序時固定帶 `serve --port 0 --hostname 127.0.0.1`(除非
 *    `launch.opencodeConfig.args` 有指定,見 `packages/shared/src/
 *    agent-launch.ts` 的 `OpencodeAgentConfigSchema` 註解:那是給
 *    `scripts/fake-opencode-server.mjs` 用的逃生閥,一般情況下不需要填),
 *    再解析這行 stdout 取得實際綁定的 base URL。
 *  - 伺服器提供 `GET /doc` 的 OpenAPI 3.1 文件與 `GET /global/health`
 *    健康檢查(`{healthy:true, version}`)——spawn() 在解析出 base URL 後,
 *    額外輪詢一次 `/global/health` 才視為就緒,避免 stdout 那行印出瞬間到
 *    HTTP server 真正接受連線之間的極短暫競態。
 *  - Session 生命週期:`POST /session`(body 可為空物件)建立一個 opencode
 *    session,回傳 `{id, directory, ...}`——**沒有帶 `directory` 參數時,
 *    session 的工作目錄就是 opencode server process 本身的 cwd**(本機
 *    實測驗證),因此這裡 spawn 子程序時把 `cwd` 設成 `workspace.path`
 *    (與 AcpAdapter/GenericPtyAdapter 的既有慣例一致),不需要額外在
 *    `POST /session` 帶查詢參數。
 *  - 送出訊息:`POST /session/{id}/message`,body
 *    `{parts:[{type:"text", text}]}`——這支 API 會**阻塞直到該輪真正完成**
 *    才回應(本機實測:回應內容是完整的最終 assistant 訊息 + parts),但
 *    同一時間 `GET /event` 這條 SSE 連線會即時推播該輪的中間過程事件
 *    (見下方事件轉換說明)。這裡的策略是:`sendPrompt()` 不等待這個 POST
 *    resolve(它本身回傳 void,呼叫端也不需要等),真正的串流顯示與回合
 *    邊界完全交給已經常駐訂閱的 SSE 連線處理;POST 失敗時才轉成 `error`
 *    AgentEvent。
 *  - 事件串流:`GET /event`(全域,不分 session)是一個 SSE 端點,每個
 *    frame 是 `data: {"id":"evt_...","type":"...","properties":{...}}`。
 *    本機用一個不觸發任何工具呼叫的簡單 prompt、以及一個觸發 `bash` 工具的
 *    prompt 各實測一次,觀察到與這個 adapter 相關的事件類型:
 *      - `session.status`(`properties.status.type` 為 `"busy"`/`"idle"`)、
 *        `session.idle`:用來判斷「這一輪真的結束了」,轉成 `completed`
 *        AgentEvent(忙碌→閒置的轉換點,見 `markIdleIfBusy()`)。
 *      - `message.updated`:`properties.info.role==="assistant"` 且帶
 *        `error` 欄位時,代表這輪失敗(`error.name` 例如
 *        `"MessageAbortedError"`——這是 `interrupt()` 呼叫 `/session/{id}
 *        /abort` 之後的**預期**結果,不當成 `error` AgentEvent 轉發,只有
 *        非中斷造成的錯誤才轉發一次 `error`)。
 *      - `message.part.updated`:每個 part 有一個穩定的 `part.id`。
 *        `type==="text"` 的 part 帶完整的**目前累積文字**(不是增量),
 *        `type==="reasoning"` 同樣結構但這裡刻意不轉發(如同 ACP/Claude SDK
 *        adapter 都不轉發思考過程文字);`type==="tool"` 帶 `callID`/`tool`/
 *        `state`(`status` 為 `pending`→`running`→`completed`/`error`)。
 *        2026-09-17 用本機 opencode 1.18.7 + `opencode/big-pickle` 跑一次需要
 *        權限(`permission.bash:"ask"`)的 bash 呼叫實測:整個生命週期是**同一個
 *        `part.id`**;`pending` 的 state 是 `{status, input:{}, raw:""}`——
 *        **input 永遠是 `{}` 佔位**,模型還在串流參數;約 140ms 後 `running`
 *        才帶完整 input(`{command:"echo …"}`),接著才是 `permission.asked`;
 *        回覆之後 `running` 又帶著 `metadata`(即時輸出)重送了兩次,最後
 *        `completed`。`running` 與 `*.asked` 的先後不固定——同日另一次對
 *        `question` 工具的實測(同版本、同 model)順序是 `pending` →
 *        `question.asked` → `running`:工具 execute 一開始就發問,比 opencode
 *        發布 running 還快。tool-call 事件怎麼送,見 `handlePartUpdated()`。
 *      - `message.part.delta`:`properties.field==="text"` 時帶**真正的
 *        增量**片段(`properties.delta`)。實測發現:輸出夠短時(例如單一
 *        英文字 "pong")完全不會有 `message.part.delta` 事件,`message.part.
 *        updated` 會直接從空字串跳到最終全文——因此這裡統一用每個 text part
 *        「目前已確認的累積文字」(`partMeta.text`,不只是長度,是完整字串,
 *        見 `advanceTextPart()` 頂端註解說明為什麼只存長度不夠)當高水位,
 *        不論是從 `part.delta` 或 `part.updated` 拿到新內容,一律只轉發
 *        「還沒送出過的部分」——`part.updated` 用長度比較(它帶的是完整快照,
 *        可以直接切 suffix),`part.delta` 用內容比較(`meta.text.endsWith
 *        (delta)`,它只帶片段本身,沒有絕對位置可切)——兩種事件來源不論
 *        實際到達順序為何都不會造成重複的 `message-delta`。
 *      - `permission.asked`:對應「這個 session 需要人類授權」,轉成
 *        `permission-request` AgentEvent;`permission.replied` 不需要轉發
 *        (我們自己呼叫 `resolvePermission()` 才會送出回覆,回覆本身的推播
 *        對我們沒有額外資訊)。
 *      - `question.asked`:模型呼叫 opencode 內建的 `question` 工具向使用者
 *        提問,轉成 `user-dialog-request` AgentEvent(見下方「提問」段落)。
 *        在這之前這個事件完全沒有被接,模型一發問,UI 看不到任何選項、回合
 *        就永遠卡在那個工具上——2026-09-16 使用者實際踩到,DB 裡留下的是一個
 *        卡了 2.5 分鐘後被中斷的 `question` 工具呼叫。
 *    `message-delta` 的 `messageId` 這裡刻意用 **opencode 的 `part.id`**,
 *    不是 opencode 的 `message.id`——一則 assistant 訊息在 opencode 裡可能
 *    由多個 text part 組成(例如「文字 → 呼叫工具 → 文字」),用 part id
 *    當作我們自己 AgentEvent 的 `messageId` 才能讓每個文字段落各自成為一組
 *    獨立、有清楚 `done:true` 邊界的訊息,與 ACP/Claude SDK adapter「一則
 *    assistant 訊息 = 一組串流」的既有語意最接近。
 *  - 中斷:`POST /session/{id}/abort`(本機實測:立即回應 `true`,實際中斷
 *    生效——SSE 收到帶 `MessageAbortedError` 的 `message.updated` 與隨後的
 *    `session.idle`——則是稍後才到)。`interrupt()` 送出這個請求後,額外
 *    best-effort 等待內部追蹤的 busy 旗標變成 false(有逾時,避免 opencode
 *    行為超出預期時永久卡住,語意與 AcpAdapter 的「盡力而為」註解一致)。
 *  - 權限回覆:`POST /permission/{requestId}/reply`,body
 *    `{reply:"once"|"always"|"reject"}`——`resolvePermission()` 的
 *    `allow`/`deny` 分別對應 `"once"`/`"reject"`(`"always"` 是「記住這個
 *    決定」的進階選項,目前 UI 沒有對應的操作,不使用)。
 *  - **認證(2026-10-03,安全;理由與實測見 `opencode-server-auth.ts` 檔頭)**:`opencode serve` 預設**沒有任何認證**,
 *    本機任何程序掃到 loopback port 就能 `POST /permission/{id}/reply` 替它核准權限(繞過政策引擎)、`GET /config` 讀到
 *    `mcp.deskmony.environment` 裡的 scoped bridge token、對 session 送 prompt。所以 `spawn()` 每次都產生一組新的隨機密碼,
 *    以 `OPENCODE_SERVER_PASSWORD`(+ 明確的 `OPENCODE_SERVER_USERNAME`)**環境變數**交給子行程(不放 command args;
 *    覆蓋使用者設的同名變數),opencode 的 basic auth 就會對所有端點(含 SSE `/event`、`/global/health`)要求
 *    `Authorization: Basic ...`——實測無標頭或密碼錯一律 401。這個 adapter 打 opencode 的每一個請求都帶這個標頭:
 *    `waitForHealthy()`(`/global/health`)、`postJson()`(`/session`、`/session/{id}/message|command|abort`、
 *    `/permission/{id}/reply`、`/question/{id}/reply|reject`,含 `dispose()` 的清理呼叫)、`getJson()`(`/command`)、
 *    `consumeEvents()`(`GET /event` SSE)——全都經過 `authHeaders()`,`authorization` 是這些函式的必填參數(漏帶 = 編譯錯誤)。
 *    密碼只留在記憶體(`InternalSession.authorization`),不寫 log、不寫 DB、不進任何 AgentEvent。`spawn()` 在就緒後另外
 *    不帶標頭探測一次,伺服器仍回 2xx(= 這個 opencode 版本不認那個環境變數)就 `console.warn`,不拒絕啟動
 *    (見 `warnIfServerUnsecured()`)。`opencode acp` 那條路同理(它也開 HTTP 伺服器),見 acp-adapter.ts。
 *  - 提問(2026-09-17 用本機 opencode 1.18.7 + `opencode/big-pickle` 真實跑過
 *    「回答 / 空答案 / reject / abort」四種情境確認,不是讀文件猜的):
 *      - 事件順序:tool part(`tool:"question"`,`status:"pending"`,input `{}`)
 *        → `question.asked`(`properties` = `{id:"que_…", sessionID,
 *        questions:[{question, header, options:[{label, description}],
 *        multiple?, custom?}], tool?:{messageID, callID}}`)→ tool part
 *        `running`(這時 input 才有完整的 `questions`)。`tool.callID` 就是
 *        tool part 的 `callID`,拿來當 `toolUseID`,UI 靠它把表單接到對話串裡
 *        那筆工具呼叫上。
 *      - 回覆:`POST /question/{requestID}/reply`,body `{answers: string[][]}`
 *        (依題目順序、每題一個 label 陣列)→ `question.replied` → tool part
 *        `completed`,`metadata.answers` 就是剛送出的陣列,`output` 是
 *        `User has answered your questions: "<題目>"="<a, b>". …`。
 *      - 每題送空陣列:output 變成 `"<題目>"="Unanswered"`,**模型照常繼續**——
 *        UI 的「略過」用這個,與 claude-agent-sdk adapter 對 `cancelled` 送
 *        空答案(不是拒絕)是同一個語意,見 `resolveUserDialog()`。
 *      - `POST /question/{requestID}/reject`:`question.rejected` → tool part
 *        `error`(「The user dismissed this question」)→ **回合直接結束**。只在
 *        `dispose()` 收尾、或題目形狀無法辨識時使用。
 *      - `POST /session/{id}/abort`:**不會**送 `question.rejected`,tool part
 *        直接變 `error`(「Tool execution aborted」)——所以清理待答狀態不能只
 *        靠 `question.replied`/`rejected`,tool part 進入終態時也要清,見
 *        `handlePartUpdated()`。
 *      - 題目的 `custom` 省略代表「可以自行輸入答案」:工具說明明講「custom
 *        開著(預設)時會自動附上 Type your own answer 選項,不要自己放
 *        Other」,`options` 也沒有最少幾個的限制——UI 一定要提供自由輸入,
 *        不然模型刻意不列 Other 的問題會變成答不了。
 *
 * ---- capabilities() 據實回報 ----
 *  - `streaming`/`toolEvents`/`permissionRequests`:true(上述事件轉換都有
 *    真實對應)。
 *  - `diff`:false——opencode 有 `session.diff` 事件與 `/vcs/diff` 端點,但
 *    這輪沒有解析轉發(如實回報,避免 UI 誤判,與 AcpAdapter 目前的
 *    `diff:false` 一致的保守做法)。
 *  - `interrupt`:true(見上方)。`terminal`:false(這不是 PTY 直通)。
 *
 * ---- 已知限制 / TODO ----
 *  - `setModel()`(對話中途換 model)已實作,但用的是「session 記憶體內的
 *    覆寫值,下一則訊息才套用」這個折衷方案——opencode 沒有「設定當前
 *    model」的獨立端點可呼叫,也沒有機會本機驗證 `/provider`/
 *    `/config/providers` 這兩個端點的實際形狀(見檔案開頭的對接策略,一貫
 *    要求「以實際觀察到的行為為準,不臆測」),所以不驗證這組
 *    providerID/modelID 是否真的存在。完整取捨說明見 `setModel()` 方法本身
 *    的註解。
 *  - **每個 session 各自 spawn 一個獨立的 `opencode serve` 子程序**(與
 *    AcpAdapter/GenericPtyAdapter 每個 session 各自 spawn 一個子程序的既有
 *    模式一致,換取實作簡單、session 之間互不干擾),而非在這個 adapter
 *    內部共用一個常駐 server process、多個 session 共享——本機實測單一
 *    `opencode serve` process 常駐記憶體約 300–600MB,session 數量多時會
 *    比共用 server 更耗資源。未來若要優化,可以考慮 adapter 內部維護一個
 *    共用 server(按 `workspace.path` 用 `?directory=` 查詢參數區分不同
 *    session 的工作目錄),但那需要額外處理「最後一個 session dispose 時
 *    才真正結束共用 server」的參照計數,這輪不做,先以正確性與一致性優先。
 *  - `message.part.updated` 中 `type` 為 `"step-start"`/`"step-finish"`/
 *    `"patch"`/`"file"`/`"agent"`/`"subtask"` 的 part 尚未有對應的
 *    `AgentEvent` 型別(見 packages/shared/src/events.ts),與 AcpAdapter 對
 *    `plan`/`agent_thought_chunk` 等擴充型別的既有做法一致,略過不轉發。
 *
 * Windows 注意:opencode 全域安裝是 `.cmd` shim(`where opencode` 實測
 * 回傳 `opencode` 與 `opencode.cmd` 兩個候選),spawn 前的指令解析比照
 * `acp-adapter.ts` 既有的 `resolveWindowsSpawnCommand()`(這裡獨立複製一份
 * 而非 import——該函式在原檔案未 export,見該檔案內完整規則說明)。
 */

const SERVE_READY_TIMEOUT_MS = 15_000;
const HEALTH_POLL_TIMEOUT_MS = 8_000;
const HEALTH_POLL_INTERVAL_MS = 250;
const IDLE_WAIT_TIMEOUT_MS = 15_000;
const LISTENING_LINE_PATTERN = /listening on (https?:\/\/\S+)/i;

type OpencodeChildProcess = ChildProcessByStdio<null, Readable, Readable>;

export class OpenCodeAdapter implements AgentAdapter {
  private readonly sessions = new Map<string, InternalSession>();

  // 2026-10-03:掛載 session 網路 MCP 工具(`list_agents`/`list_sessions`/`read_session`/`create_session`/
  // `send_to_session`),讓 OpenCode(HTTP)session 也能主動傳訊息。**完全比照 `AcpAdapter`**(同一個 bridge 子行程
  // `mcp-bridge-server.ts`、同樣的 scoped token 與環境變數,見 mcp-bridge-launch.ts),差別只在掛法:ACP 經
  // `session/new` 的 `mcpServers`,這裡寫進 `OPENCODE_CONFIG_CONTENT` 的 `mcp.deskmony`(type "local")。
  // 兩個依賴都由 apps/core 事後注入(adapter 建構時 SessionManager/WsGateway 還不存在,見 acp-adapter.ts 同名欄位的說明);
  // **缺一就不掛載**(不核發 token、不多一個子行程),行為與這個欄位出現之前完全相同。
  private sessionNetworkPort?: SessionNetworkPort;
  setSessionNetworkPort(port: SessionNetworkPort): void {
    this.sessionNetworkPort = port;
  }
  private tokenMinter?: McpBridgeTokenPort;
  setTokenMinter(minter: McpBridgeTokenPort): void {
    this.tokenMinter = minter;
  }

  capabilities(): AdapterCapabilities {
    return {
      streaming: true,
      toolEvents: true,
      permissionRequests: true,
      diff: false,
      interrupt: true,
      terminal: false,
      // S3a(usage-metering):這輪沒有在 handleEvent()/handlePartUpdated()
      // 新增任何 usage/context 事件轉發,如實回報 "unsupported",避免 UI 誤判
      // (呼應既有 `diff` 欄位的慣例)。**不是 "unknown"**——"unknown" 的語意是
      // 「adapter 會轉發,但資料來不來由外部 agent 決定」;這裡連轉發程式碼都
      // 沒有,不管後端送什麼都不可能變成事件,所以答案是確定的「不會報」。
      usageReporting: "unsupported",
      contextReporting: "unsupported",
      // 這輪(slash command)新增:**不是 "supported"**——opencode 是使用者自帶、
      // 版本不受 Deskmony 控制的外部 CLI(本機驗證版本 1.18.7 確實有
      // `GET /command`,但不能保證使用者實際指到的版本一定有這支端點),故三態
      // 宣告為 "unknown",實際結果依 `spawn()` 內那次 `GET /command` 是否成功
      // 收斂(見該處呼叫點註解)。
      slashCommands: "unknown",
    };
  }

  async spawn(launch: AgentLaunchSpec, workspace: Workspace): Promise<AgentHandle> {
    const config = launch.opencodeConfig;
    const agentLabel = launch.providerId ?? "opencode";
    if (!config) {
      throw new DeskmonyError(
        ErrorCodes.ADAPTER_MISSING_CONFIG,
        { providerId: agentLabel, software: "opencode", configField: "command" },
        `agent "${agentLabel}" 的 software="opencode" 缺少 opencodeConfig(command)`,
      );
    }

    const defaultServeArgs = ["serve", "--port", "0", "--hostname", "127.0.0.1"];
    const rawArgs = config.args && config.args.length > 0 ? config.args : defaultServeArgs;
    const { command, args, useShell } = resolveWindowsSpawnCommand(config.command, rawArgs);

    // `AgentHandle.id` 提前在這裡生成(同 acp-adapter.ts 的做法):scoped token 要綁定「這一個 session」,而核發必須在
    // spawn 子程序之前(token 要放進子程序的 OPENCODE_CONFIG_CONTENT)。session 網路工具的**呼叫者身分**由 token 綁定的
    // 這個 id 決定,不是任何工具參數——所以它必須等於 SessionManager 登記的 session id(= handle.id)。
    const handleId = randomUUID();
    const bridgeLaunch = mintMcpBridgeLaunch(
      { sessionNetworkPort: this.sessionNetworkPort, tokenMinter: this.tokenMinter },
      handleId,
      "opencode-adapter",
    );
    // 核發之後的任何一步失敗都要撤銷,不留孤兒 token(24 小時 TTL 只是保底)。
    const revokeBridgeToken = (): void => {
      if (bridgeLaunch) this.tokenMinter?.revokeForSession(handleId);
    };

    // launch.env(provider 層級 env)疊在 process.env 之上,config.env(既有欄位)
    // 最優先——同 acp-adapter.ts 的合併順序說明。
    // 2026-10-05(安全):最後一律濾掉 Deskmony 內部憑證(含繼承來的 OPENCODE_SERVER_PASSWORD——下面 applyOpencodeServerAuth()
    // 會設這個 opencode 行程自己的新密碼,必須在這之後)。完整理由見 agent-env.ts。
    const childEnv: NodeJS.ProcessEnv = buildAgentChildEnv(launch.env, config.env);
    // 2026-10-03(安全):opencode 預設所有工具權限都是 allow,只有它自己設定裡標成 "ask" 的才會發
    // `permission.asked`——不處理的話 bash/edit/webfetch/MCP 工具**完全不經過** Deskmony 的政策引擎
    // (default-deny、hard-deny 四類、auto/YOLO 全部失效)。這裡一律注入「所有工具都 ask」的設定,
    // 與使用者既有的 OPENCODE_CONFIG_CONTENT 深度合併(Deskmony 優先)。完整理由與實測見 opencode-config.ts。
    // 這個 adapter 就是 opencode(software="opencode"),不需要看 launch.family。
    // 掛了 bridge 時:session 網路 MCP server(名稱 `deskmony`,工具全名 `deskmony_<name>`)寫進同一份設定,
    // 三個唯讀查詢工具預先放行。token 只放 `environment`,**不放 command**(命令列在行程列表看得到)。
    childEnv[OPENCODE_CONFIG_CONTENT_ENV] = buildOpencodeConfigContent(childEnv[OPENCODE_CONFIG_CONTENT_ENV], {
      sessionNetwork: bridgeLaunch
        ? { localMcpServer: { command: [bridgeLaunch.command, ...bridgeLaunch.args], environment: bridgeLaunch.env } }
        : undefined,
    });
    // 2026-10-03(安全):**這個 opencode 伺服器要有認證**。`opencode serve` 預設完全不鎖,本機任何程序掃到 loopback port 就能
    // 替它核准權限請求(繞過政策引擎)、`GET /config` 讀到上面的 scoped bridge token。這裡每次 spawn 產生一組新的隨機密碼,
    // 以環境變數(不是 command args)交給子行程——**在所有使用者 env 合併完之後才設,所以覆蓋**使用者自己設的同名變數。
    // 回傳值是之後每個請求要帶的 `Authorization: Basic ...`,只留在記憶體(InternalSession.authorization)。完整理由見 opencode-server-auth.ts。
    const authorization = applyOpencodeServerAuth(childEnv);
    let child: OpencodeChildProcess;
    try {
      child = spawn(command, args, {
        cwd: workspace.path,
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"],
        shell: useShell,
      });
    } catch (err) {
      // spawn 本身同步丟例外(例如 Windows 上 `.cmd` 沒走 shell 的 EINVAL):token 已核發,不能留成孤兒。
      revokeBridgeToken();
      throw err;
    }
    // 2026-09-04(稽核修補):見 child-registry.ts。
    registerChild(child.pid, `opencode:${command}`);

    const spawnFailure = new Promise<never>((_, reject) => {
      child.once("error", (err) => {
        reject(
          new DeskmonyError(
            "adapterProcess.spawnFailed",
            { software: "opencode", command, detail: err.message },
            `OpenCode server 子程序啟動失敗(command=${command}): ${err.message}`,
          ),
        );
      });
    });
    spawnFailure.catch(() => {
      // 僅用於 Promise.race,避免 Node 印出 unhandled rejection 警告。
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      console.error(`[opencode-adapter] ${agentLabel} stderr: ${chunk.toString().trimEnd()}`);
    });

    let baseUrl: string;
    try {
      baseUrl = await Promise.race([
        waitForListeningLine(child),
        spawnFailure,
        rejectAfter(
          SERVE_READY_TIMEOUT_MS,
          "opencode.listenTimeout",
          { timeoutMs: SERVE_READY_TIMEOUT_MS },
          "等待 OpenCode server 印出監聽位址逾時",
        ),
      ]);
      await Promise.race([
        waitForHealthy(baseUrl, authorization),
        spawnFailure,
        rejectAfter(
          HEALTH_POLL_TIMEOUT_MS,
          "opencode.healthTimeout",
          { timeoutMs: HEALTH_POLL_TIMEOUT_MS },
          "等待 OpenCode server /global/health 就緒逾時",
        ),
      ]);
      // 認證有沒有真的生效:不帶標頭打一次,仍回 2xx 就是這個 opencode 版本不認 OPENCODE_SERVER_PASSWORD(或改了名稱)。
      // 只警告、不拒絕啟動——見 warnIfServerUnsecured() 的取捨說明。
      await warnIfServerUnsecured(baseUrl, agentLabel);
    } catch (err) {
      this.killChild(child);
      revokeBridgeToken();
      throw err;
    }

    // 2026-09-17:Windows 上 `child.pid` 通常只是 cmd.exe(opencode 全域安裝是
    // `.cmd` shim,見檔案頂端「Windows 注意」),真正吃 300–600MB 的 opencode.exe
    // 是它底下的子程序。只登記 cmd.exe 的話,core 非正常終止之後 cmd.exe 一不在,
    // 下次啟動的回收就會把 opencode.exe 當成「已經不在」跳過 —— 使用者機器上實際
    // 發生過。`/global/health` 已經回應 = 真正的 server 行程一定已經存在,這時把
    // wrapper 底下的子孫也登記起來。刻意不 await:查詢要 1 秒多,不該拖慢 session
    // 建立;查不到只是少一層保護。見 child-registry.ts 的 registerChildDescendants()。
    void registerChildDescendants(child.pid);

    let opencodeSessionId: string;
    try {
      const created = await postJson<{ id: string }>(`${baseUrl}/session`, {}, authorization);
      opencodeSessionId = created.id;
    } catch (err) {
      this.killChild(child);
      revokeBridgeToken();
      throw new DeskmonyError(
        "opencode.sessionCreateFailed",
        { detail: err instanceof Error ? err.message : String(err) },
        `OpenCode session 建立失敗: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // 這輪(slash command)新增:取得這個 opencode server process 的 "/" 指令
    // 清單(已本機實測 `GET /command` 回傳 `Command[]`,見檔案頂端查證段落)。
    // **必須 `await`,不可 fire-and-forget**——與 claude-agent-sdk/ACP 不同,
    // opencode 的 `sendPrompt()` 需要靠這份清單決定要打 `/message` 還是
    // `/command` 端點(兩者已實測不是同義詞,見下方 `sendPrompt()` 註解),若
    // 這裡用 fire-and-forget、使用者的第一則訊息剛好是指令,查詢還沒回來時
    // `sendPrompt()` 就會誤判成一般文字,重現查證段落裡發現的既有 bug。
    // 失敗時**不拋錯、不影響 spawn()**——這個查詢失敗只代表這個 session 不會
    // 有 "/" 指令支援(退化成這個功能出現之前的既有行為),不該讓整個 session
    // 起不來;也**不**推播 `available-commands` 事件(維持 capabilities 的
    // "unknown" 未收斂狀態是誠實的——查詢失敗代表「不知道」,不是「確認為
    // 空清單」,兩者語意不同,見 events.ts 的 SlashCommandInfoSchema 附近註解)。
    let availableCommands = new Map<string, OpencodeCommand>();
    let availableCommandsFetched = false;
    try {
      const commands = await getJson<OpencodeCommand[]>(`${baseUrl}/command`, authorization);
      availableCommands = new Map(commands.map((c) => [c.name, c]));
      availableCommandsFetched = true;
    } catch (err) {
      console.error(
        `[opencode-adapter] ${agentLabel} GET /command 失敗(不影響對話,只影響 "/" 指令與選單): ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const outputQueue = new AsyncQueue<AgentEvent>({
      // 2026-09-04(稽核修補):緩衝溢位不靜默丟資料,至少讓它在 log 裡看得見。
      // 見 packages/adapters/src/async-queue.ts 的 DEFAULT_MAX_BUFFERED 註解。
      onOverflow: (dropped) =>
        console.error(
          `[opencode] 事件緩衝溢位,已丟棄最舊的 ${dropped} 筆事件 —— 代表這條 session 的產出速度` +
            "遠超過下游消費速度(失控迴圈?超大 tool_result?)。丟舊留新是刻意的:" +
            "否則 completed 事件永遠進不來,session 會卡在 busy。",
        ),
    });
    const handle: AgentHandle = { id: handleId, launch, workspace };
    const sseController = new AbortController();

    const internal: InternalSession = {
      handle,
      child,
      baseUrl,
      authorization,
      opencodeSessionId,
      childSessionIds: new Set(),
      outputQueue,
      partMeta: new Map(),
      toolMeta: new Map(),
      pendingPermissions: new Map(),
      pendingQuestions: new Map(),
      erroredMessageIds: new Set(),
      messageRoles: new Map(),
      busy: false,
      turnErrored: false,
      idleWaiters: [],
      sseController,
      availableCommands,
    };
    this.sessions.set(handle.id, internal);

    child.on("exit", (code, signal) => {
      if (!this.sessions.has(handle.id)) return; // dispose() 已經處理過
      outputQueue.push({
        type: "error",
        message: `OpenCode server 子程序已結束(code=${code ?? "null"}, signal=${signal ?? "null"})`,
      });
      outputQueue.close();
    });

    void this.consumeEvents(internal).catch((err: unknown) => {
      if (sseController.signal.aborted) return; // dispose() 主動關閉,非錯誤
      outputQueue.push({
        type: "error",
        message: "OpenCode /event 串流中斷",
        detail: err instanceof Error ? err.message : String(err),
      });
    });

    // 這輪(slash command)新增:上面的 GET /command 查詢成功時才推播——見該
    // 呼叫點註解,查詢失敗維持沉默(不編造一份空清單)。opencode 沒有「清單
    // 變動」推播事件(只有執行後才發的 command.executed 稽核事件,見檔案頂端
    // 查證段落),清單在這個 server process 生命週期內是靜態的,這裡推播一次
    // 就是這個 session 僅有的一次 available-commands 事件。
    if (availableCommandsFetched) {
      outputQueue.push({ type: "available-commands", commands: mapOpencodeCommands(availableCommands) });
    }

    return handle;
  }

  sendPrompt(handle: AgentHandle, prompt: PromptInput): void {
    const internal = this.mustGet(handle);
    internal.busy = true;
    internal.turnErrored = false;

    // 這輪(slash command)新增:偵測開頭 "/已知指令名稱"——**完整比對整個
    // 第一個 token,不是 prefix**(例如已知指令 "review" 不可誤配到使用者
    // 打的 "/review-all"),命中才改走 opencode 專門的
    // POST /session/{id}/command 端點,否則(包括「不是 / 開頭」與「/ 開頭但
    // 不是任何已知指令」兩種情況)完全比照既有行為走下面的 /message 端點,
    // 不影響「剛好用 / 開頭的一般文字」這種既有情境。
    //
    // **已實測(見檔案頂端查證段落)兩個端點不是同義詞**:對 /message 送純
    // 文字 "/review test-arg-abc",opencode 原封不動存成字面文字,完全沒有
    // 展開成該指令的 template——不做這個判斷的話,使用者手動打的 "/指令"
    // 只會變成一段令人困惑的字面文字送給模型,不會真的觸發那個指令。
    const commandMatch = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(prompt.text);
    const commandName = commandMatch?.[1];
    if (commandName !== undefined && internal.availableCommands.has(commandName)) {
      // 刻意不帶 model 欄位:OpenAPI 文件上 POST /session/{id}/command 的
      // `model` 是純字串,型別上與 /message 既有使用的 {providerID,modelID}
      // 物件形狀不同,這輪沒有機會實測這支端點真正接受的字串格式(對接策略
      // 一貫要求「以實際觀察到的行為為準,不臆測」)——setModel() 覆寫對
      // 指令呼叫暫不生效,是刻意縮小的範圍,不是遺漏。
      void postJson(
        `${internal.baseUrl}/session/${internal.opencodeSessionId}/command`,
        { command: commandName, arguments: commandMatch?.[2] ?? "" },
        internal.authorization,
      ).catch((err: unknown) => {
        internal.outputQueue.push({
          type: "error",
          message: "OpenCode session/command 送出失敗",
          detail: err instanceof Error ? err.message : String(err),
        });
      });
      return;
    }

    // model 解析優先序:`internal.modelOverride`(透過 setModel() 對話中途
    // 設定,見該方法)> `handle.launch.model`(建立 session 時挑選的
    // "providerID/modelID" 組合字串,來自 `opencode models` 偵測清單)。
    // 兩者都用同一個 parseModelString() 從第一個 "/" 拆成 opencode 要求的
    // {providerID, modelID} 兩個欄位,隨 POST /session/{id}/message 一起送
    // 出——setModel() 本身只是把覆寫記在記憶體裡,並不會呼叫任何 opencode
    // API(沒有對應的端點),真正「生效」永遠是靠這裡讀到覆寫值的下一次
    // sendPrompt()。都沒有時完全不帶 model 欄位,交給 opencode 自己的預設。
    const modelField = internal.modelOverride ?? parseModelString(handle.launch.model);
    void postJson(
      `${internal.baseUrl}/session/${internal.opencodeSessionId}/message`,
      {
        parts: [{ type: "text", text: prompt.text }],
        ...(modelField ? { model: modelField } : {}),
      },
      internal.authorization,
    ).catch((err: unknown) => {
      internal.outputQueue.push({
        type: "error",
        message: "OpenCode session/message 送出失敗",
        detail: err instanceof Error ? err.message : String(err),
      });
    });
  }

  events(handle: AgentHandle): AsyncIterable<AgentEvent> {
    return this.mustGet(handle).outputQueue;
  }

  /**
   * `POST /session/{id}/abort` 本機實測會立即回應(代表中斷請求已送達並開始
   * 生效),但真正「這一輪徹底結束、可以安全注入下一個 prompt」要等 SSE
   * 送來 `session.status`(idle)/`session.idle`。這裡在送出 abort 後
   * best-effort 等待內部追蹤的 busy 旗標翻成 false(有逾時保護,語意比照
   * AcpAdapter「盡力而為」的既有註解)。
   */
  async interrupt(handle: AgentHandle): Promise<void> {
    const internal = this.mustGet(handle);
    try {
      await postJson(`${internal.baseUrl}/session/${internal.opencodeSessionId}/abort`, {}, internal.authorization);
    } catch {
      // 伺服器可能已經結束或本來就沒有進行中的回合,忽略。
    }
    await waitForIdle(internal, IDLE_WAIT_TIMEOUT_MS);
  }

  async dispose(handle: AgentHandle): Promise<void> {
    const internal = this.sessions.get(handle.id);
    if (!internal) return;
    // 這個 session 若曾核發過 scoped MCP bridge token(見 spawn()),結束時必須讓它立即失效——不能變成孤兒憑證
    // 一直有效到 24 小時 TTL 才過期。對「沒核發過」是安全的 no-op(見 ws-gateway.ts 的 revokeMcpBridgeTokensForSession)。
    this.tokenMinter?.revokeForSession(handle.id);
    // 懸置的權限請求(opencode 端 `permission.asked` 呼叫)若放著不管會讓
    // opencode 卡住等回覆——一律以「拒絕」收場後再清空(比照
    // AcpAdapter.dispose() 的既有做法)。
    for (const requestId of internal.pendingPermissions.keys()) {
      try {
        await postJson(`${internal.baseUrl}/permission/${requestId}/reply`, { reply: "reject" }, internal.authorization);
      } catch {
        // 伺服器即將被關閉,忽略。
      }
    }
    internal.pendingPermissions.clear();
    // 待答的提問同理:opencode 那邊的 `question` 工具會一直等下去。這裡用 reject
    // 而不是空答案——session 都要關了,沒有「讓模型繼續下一步」的必要。
    for (const requestId of internal.pendingQuestions.keys()) {
      try {
        await postJson(`${internal.baseUrl}/question/${requestId}/reject`, {}, internal.authorization);
      } catch {
        // 伺服器即將被關閉,忽略。
      }
    }
    internal.pendingQuestions.clear();
    internal.sseController.abort();
    internal.outputQueue.close();
    this.killChild(internal.child);
    /**
     * 2026-09-04(稽核修補):等子程序真正 exit 才回報 dispose 完成。
     *
     * `claude-sdk-adapter` 與 `acp-adapter` 早就有這一步(各自 `dispose()` 內
     * 的 `waitForChildExit(child, 3_000)`),而這個 adapter 與 `pty-adapter`
     * 沒有 —— 同一個介面的四個實作行為不一致,是最容易長出 bug 的地方。
     *
     * 為什麼要等:「送出終止指令」不等於「子程序已經死掉」。在 Windows 上
     * 行程要再過一小段時間才釋放它對 cwd(= 任務 worktree)的佔用,而呼叫端
     * (原任務刪除流程(2026-10-02 已移除,見 docs/DECISIONS.md §H))緊接著就會
     * `git worktree remove`,撞上 `EBUSY`/`Permission denied`。呼叫端當時
     * 有約 1.8 秒的重試窗口可以補救,但那比這裡主動等的 3 秒短 —— 在子程序退出
     * 較慢的機器上,opencode/pty 因此比另外兩個 adapter 更容易真的觸發
     * `workspace.cleanupFailed`。
     *
     * 逾時不丟錯(見 `waitForChildExit()` 註解),fail-safe 方向。
     */
    await waitForChildExit(internal.child, 3_000);
    // 2026-09-04(稽核修補):已乾淨收掉,不需要下次啟動時回收。
    unregisterChild(internal.child.pid);
    this.sessions.delete(handle.id);
  }

  resolvePermission(handle: AgentHandle, requestId: string, decision: "allow" | "deny"): void {
    const internal = this.mustGet(handle);
    if (!internal.pendingPermissions.has(requestId)) return;
    internal.pendingPermissions.delete(requestId);
    const reply = decision === "allow" ? "once" : "reject";
    void postJson(`${internal.baseUrl}/permission/${requestId}/reply`, { reply }, internal.authorization).catch((err: unknown) => {
      internal.outputQueue.push({
        type: "error",
        message: "OpenCode permission/reply 送出失敗",
        detail: err instanceof Error ? err.message : String(err),
      });
    });
  }

  /**
   * 回覆一筆 `question.asked`(見檔案頂端「提問」段落)。`completed` 與
   * `cancelled` 都走 `/reply`:略過作答時每題送空陣列,opencode 會把它寫成
   * 「Unanswered」讓模型繼續——不走 `/reject`,那會直接結束這一輪,與
   * claude-agent-sdk adapter 對同一個 `cancelled` 的處理(空答案、不是拒絕)
   * 語意不一致。
   */
  resolveUserDialog(handle: AgentHandle, requestId: string, result: DialogAnswer): void {
    const internal = this.mustGet(handle);
    const pending = internal.pendingQuestions.get(requestId);
    if (!pending) return;
    internal.pendingQuestions.delete(requestId);
    const answers = pending.questions.map((q) =>
      result.behavior === "completed" ? toOpencodeAnswer(q, result.result.answers[q.question]) : [],
    );
    void postJson(`${internal.baseUrl}/question/${requestId}/reply`, { answers }, internal.authorization).catch((err: unknown) => {
      internal.outputQueue.push({
        type: "error",
        message: "OpenCode question/reply 送出失敗",
        detail: err instanceof Error ? err.message : String(err),
      });
    });
  }

  /**
   * opencode 沒有 SDK 那種官方支援的「設定當前 model」方法(見本檔案頂端
   * 對接策略註解):model 是每則訊息各自可選的 `{providerID,modelID}` 欄位
   * (`POST /session/{id}/message` body 的一部分),不是一個獨立可設定的
   * 狀態。這裡的作法:把 `model` 解析成 `{providerID,modelID}` 後存進
   * `internal.modelOverride`,`sendPrompt()` 送下一則訊息時會優先讀這個值
   * (見該方法)——覆寫在這個方法 resolve 的當下就已經生效(保證下一次
   * sendPrompt() 會用到,不需要、也沒有 API 可以呼叫去讓它「立即」生效),
   * 符合 `AgentAdapter.setModel()` 介面註解「不可靜默忽略成功」的要求。
   *
   * 唯一會拋錯的情況是 `model` 本身不是合法的 "providerID/modelID" 形狀,
   * 無法解析(與 `parseModelString()` 判斷 `launch.model` 是否合法的規則
   * 完全一致)。刻意不做的部分:呼叫 `/config/providers`(或 `/provider`)
   * 驗證這組 providerID/modelID 是否真的存在——本檔案的對接策略一貫要求
   * 「以實際觀察到的 opencode 行為為準,不臆測」,這輪沒有機會對這兩個端點
   * 做本機驗證。若使用者傳入語法正確但實際不存在的 model,opencode 會在
   * 下一次 `POST /session/{id}/message` 時自行判定失敗,經由既有的
   * `message.updated` 錯誤事件轉發路徑浮現(見 `handleEvent()`)——與
   * 「`launch.model` 打錯字」的既有行為完全一致,不需要另外處理。
   */
  async setModel(handle: AgentHandle, model: string): Promise<void> {
    const internal = this.mustGet(handle);
    const parsed = parseModelString(model);
    if (!parsed) {
      throw new DeskmonyError(
        "opencode.invalidModelFormat",
        { model },
        `software="opencode" 的 model 必須是 "providerID/modelID" 形式(例如 ` +
          `"anthropic/claude-sonnet-4-20250514"),收到的值 "${model}" 無法解析`,
      );
    }
    internal.modelOverride = parsed;
  }

  /**
   * 思考程度(reasoning effort)——與上面的 `setModel()`**不同**,這裡**不**
   * 採用「存進 session 覆寫、下一則訊息才生效」的 workaround:沒有查證到
   * opencode API(`POST /session/{id}/message` 或其他端點)有任何
   * reasoning-effort 相關欄位或機制可用(見本檔案頂端對接策略「以實際觀察到
   * 的行為為準,不臆測」的一貫要求),不可臆測一個不存在的能力。明確拋出
   * 錯誤,不可靜默忽略成功(見 packages/adapters/src/types.ts 的
   * `AgentAdapter.setEffort()` 介面註解)。
   */
  async setEffort(handle: AgentHandle): Promise<void> {
    this.mustGet(handle); // 驗證 handle 有效(未知 handle 仍應先報這個錯,而非「不支援」)
    throw new DeskmonyError(
      ErrorCodes.ADAPTER_UNSUPPORTED_OPERATION,
      { software: "opencode", operation: "setEffort" },
      'software="opencode" 不支援變更思考程度(未查得到 opencode 有對應的 reasoning-effort 機制)',
    );
  }

  private mustGet(handle: AgentHandle): InternalSession {
    const internal = this.sessions.get(handle.id);
    if (!internal) {
      throw new DeskmonyError(
        ErrorCodes.ADAPTER_UNKNOWN_HANDLE,
        { handleId: handle.id },
        `未知的 agent handle: ${handle.id}`,
      );
    }
    return internal;
  }

  private killChild(child: OpencodeChildProcess): void {
    if (child.exitCode !== null || child.killed) return;
    if (process.platform === "win32") {
      // shell:true 時 child.pid 是 cmd.exe 的 pid,直接 kill() 殺不到底下真正
      // 的 opencode 程序;用 taskkill /T 連同子程序樹一起結束(與
      // acp-adapter.ts/pty-adapter.ts 的既有做法一致)。
      if (child.pid) {
        spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      }
    } else {
      child.kill("SIGTERM");
    }
  }

  /** 持續讀取 `GET /event` 這條 SSE 連線,轉譯成 AgentEvent 並 push 進 outputQueue。 */
  private async consumeEvents(internal: InternalSession): Promise<void> {
    const res = await fetch(`${internal.baseUrl}/event`, {
      headers: authHeaders(internal.authorization),
      signal: internal.sseController.signal,
    });
    if (!res.ok) {
      // 認證被拒(401)或其他錯誤:不能把一個錯誤回應當成 SSE 串流讀(會靜靜地讀到 EOF、session 卡在永遠收不到事件)。
      throw new DeskmonyError(
        "opencode.requestFailed",
        { url: `${internal.baseUrl}/event`, status: res.status },
        `GET ${internal.baseUrl}/event 失敗(status=${res.status})`,
      );
    }
    if (!res.body) {
      throw new DeskmonyError(
        "opencode.eventStreamMissingBody",
        undefined,
        "OpenCode /event 回應沒有 body,無法讀取 SSE 串流",
      );
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary: number;
        while ((boundary = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const evt = parseSseEvent(frame);
          if (evt) this.handleEvent(internal, evt);
        }
      }
    } catch (err) {
      if (internal.sseController.signal.aborted) return; // dispose() 主動關閉,非錯誤
      throw err;
    }
    internal.outputQueue.close();
  }

  private handleEvent(internal: InternalSession, evt: OpencodeEvent): void {
    const properties = evt.properties as Record<string, unknown> | undefined;

    // 2026-10-03:追蹤這個 session 底下的 **subagent 子 session**(`task` 工具會建立
    // `parentID` 指向呼叫者的子 session,實測 `session.created` 一定先於子 session 的任何事件)。
    // 為什麼要管:所有工具現在都是 ask,subagent 裡的 bash/edit 一樣會發 `permission.asked`,但 `sessionID` 是
    // **子 session 的**——下面的 sessionID 過濾若直接丟掉,opencode 會永遠等一個沒人回的權限,subagent 就卡死
    // (改成全 ask 之前這些操作靜默放行,不會碰到這個問題)。
    if (evt.type === "session.created" || evt.type === "session.updated") {
      const info = properties?.info as { id?: string; parentID?: string } | undefined;
      if (info?.id && info.parentID && (info.parentID === internal.opencodeSessionId || internal.childSessionIds.has(info.parentID))) {
        internal.childSessionIds.add(info.id);
      }
    }

    const sessionID = properties?.sessionID;
    if (sessionID !== undefined && sessionID !== internal.opencodeSessionId) {
      // 子 session 只轉發**權限請求**——它們的文字/工具事件不該混進這個 session 的對話串。
      const isChildPermission =
        evt.type === "permission.asked" && typeof sessionID === "string" && internal.childSessionIds.has(sessionID);
      if (!isChildPermission) return;
    }

    switch (evt.type) {
      case "session.status": {
        const status = properties?.status as { type?: string } | undefined;
        if (status?.type === "busy") {
          internal.busy = true;
        } else if (status?.type === "idle") {
          this.markIdleIfBusy(internal);
        }
        break;
      }
      case "session.idle":
        this.markIdleIfBusy(internal);
        break;
      case "message.updated": {
        const info = properties?.info as
          | { id?: string; role?: string; error?: { name?: string; data?: { message?: string } } }
          | undefined;
        // Bug 修復:記錄每個 opencode messageID 對應的 role(user/assistant),供
        // handlePartUpdated() 判斷一個 text part 究竟屬於使用者自己的訊息還是
        // assistant 的回覆——見該方法內的檢查與註解。
        if (info?.id && info.role) {
          internal.messageRoles.set(info.id, info.role);
        }
        if (
          info?.role === "assistant" &&
          info.error &&
          info.error.name !== "MessageAbortedError" &&
          info.id &&
          !internal.erroredMessageIds.has(info.id)
        ) {
          internal.erroredMessageIds.add(info.id);
          internal.turnErrored = true;
          internal.outputQueue.push({
            type: "error",
            message: `OpenCode 回合失敗: ${info.error.name ?? "未知錯誤"}`,
            detail: info.error.data?.message,
          });
        }
        break;
      }
      case "message.part.updated": {
        const part = properties?.part as OpencodePart | undefined;
        if (part) this.handlePartUpdated(internal, part);
        break;
      }
      case "message.part.delta": {
        const field = properties?.field;
        const partId = properties?.partID as string | undefined;
        const delta = properties?.delta as string | undefined;
        if (field === "text" && partId && delta) {
          this.advanceTextPart(internal, partId, delta);
        }
        break;
      }
      case "permission.asked": {
        const requestId = properties?.id as string | undefined;
        if (!requestId) break;
        const tool = properties?.tool as { callID?: string } | undefined;
        const toolMeta = tool?.callID ? internal.toolMeta.get(tool.callID) : undefined;
        const patterns = properties?.patterns as string[] | undefined;
        // 2026-10-03:**帶上工具參數**。PolicyEngine 的 hard-deny(worktree 外寫入、讀秘密路徑、危險 git、
        // 非白名單外連)與 allowlist 規則全靠 `input` 判斷——沒有 input 它們只能「猜不到 → 不命中」,
        // auto/YOLO 模式下 `git push --force` 就會被當成未分類操作自動放行。優先用工具 part 的完整 input
        // (`running` 帶的,bash 是 {command}、edit/read 是 {filePath,...}、webfetch 是 {url,...});
        // 還沒收到(running 排在 permission.asked 之後)或是 subagent 子 session 的工具(它們的 part 不轉發)時,
        // 退而用 `permission.asked` 自己的 metadata(實測 bash 是 {command}、edit 是 {filepath, diff})。
        const metadata = properties?.metadata as Record<string, unknown> | undefined;
        const input = toolMeta?.input ?? (metadata && Object.keys(metadata).length > 0 ? metadata : undefined);
        internal.pendingPermissions.set(requestId, { toolCallId: tool?.callID });
        internal.outputQueue.push({
          type: "permission-request",
          requestId,
          toolName: toolMeta?.toolName ?? (properties?.permission as string | undefined) ?? "unknown",
          input,
          description: patterns && patterns.length > 0 ? `patterns: ${patterns.join(", ")}` : undefined,
        });
        break;
      }
      case "question.asked": {
        const requestId = properties?.id as string | undefined;
        if (!requestId) break;
        const questions = normalizeOpencodeQuestions(properties?.questions);
        if (!questions) {
          // opencode 自己會先用 schema 驗過工具參數,理論上到不了這裡;萬一將來
          // 形狀變了,寧可 reject 讓這一輪結束(對話串會看到工具失敗),也不要
          // 發一個 UI 畫不出來的請求、讓回合無聲無息地卡住。
          console.error(`[opencode-adapter] question.asked 的 questions 形狀無法辨識,已 reject: ${JSON.stringify(properties?.questions)}`);
          void postJson(`${internal.baseUrl}/question/${requestId}/reject`, {}, internal.authorization).catch(() => {});
          break;
        }
        const tool = properties?.tool as { callID?: string } | undefined;
        internal.pendingQuestions.set(requestId, { questions, toolCallId: tool?.callID });
        internal.outputQueue.push({
          type: "user-dialog-request",
          requestId,
          // 沒有 `tool`(不是由工具呼叫發起的提問)時對話串裡沒有可以對上的工具
          // 項目,UI 會改在對話串底部顯示,見 PendingUserDialogsDock。
          toolUseID: tool?.callID ?? requestId,
          questions,
        });
        break;
      }
      case "question.replied":
      case "question.rejected": {
        // 我們自己回覆時已經刪過了;這裡處理的是被別的 client(例如同時連著這個
        // server 的 opencode TUI)回覆掉的情況。
        const requestId = properties?.requestID as string | undefined;
        if (requestId) internal.pendingQuestions.delete(requestId);
        break;
      }
      default:
        // server.connected / plugin.added / session.updated / session.diff /
        // permission.replied 等其餘事件目前不影響串流顯示,略過不轉發(見
        // class 頂端註解的「已知限制」)。
        break;
    }
  }

  private handlePartUpdated(internal: InternalSession, part: OpencodePart): void {
    if (part.type === "text" || part.type === "reasoning") {
      // Bug 修復:`message.part.updated`/`message.part.delta` 是全域 SSE 事件(不分
      // user/assistant),使用者自己送出的訊息一樣會建立 text part 並觸發這個事件
      // ——沒有這道檢查的話,使用者剛輸入的文字會被誤判成 assistant 輸出,原封不動
      // 轉成 message-delta 疊進回覆泡泡(MessageDeltaEventSchema.role 只允許
      // "assistant",見 packages/shared/src/events.ts,語意上不該收到 user 的內容)。
      // role 來自 handleEvent() 的 message.updated 分支記錄的 messageRoles;只在
      // **確定**是 user 訊息時才跳過——role 尚未知道時維持原行為繼續轉發,避免
      // message.updated 與 message.part.updated 兩者到達順序萬一不如預期時誤殺真正
      // 的 assistant 串流(對稱於 ACP adapter 靠協定本身的 agent_message_chunk /
      // user_message_chunk 區分,見 acp-adapter.ts handleSessionUpdate())。
      if (part.messageID && internal.messageRoles.get(part.messageID) === "user") return;
      let meta = internal.partMeta.get(part.id);
      if (!meta) {
        meta = { type: part.type, text: "", done: false };
        internal.partMeta.set(part.id, meta);
      }
      if (part.type === "text") {
        // `part.text` 是「目前累積全文」的快照（見 class 頂端註解），與
        // `message.part.delta` 共用同一個 `meta.text` 高水位——只有當這個
        // 快照比目前已知的還長時，才把「新增的後綴」當成尚未送出過的內容轉發
        // 並推進高水位；快照比已知內容短或相等（例如一個較舊、姍姍來遲的
        // 快照，或內容已經透過 delta 事件送過）一律視為過期/重複，不重發、
        // 也不縮短已知長度——這樣無論 message.part.updated 與 message.part.
        // delta 兩種事件的實際到達順序為何，同一段文字都只會被轉發一次
        // （見 advanceTextPart() 另一半的對稱處理）。
        const fullText = part.text ?? "";
        if (fullText.length > meta.text.length) {
          const suffix = fullText.slice(meta.text.length);
          internal.outputQueue.push({ type: "message-delta", messageId: part.id, role: "assistant", delta: suffix, done: false });
          meta.text = fullText;
        }
      }
      if (part.time?.end !== undefined && !meta.done) {
        meta.done = true;
        if (part.type === "text") {
          internal.outputQueue.push({ type: "message-delta", messageId: part.id, role: "assistant", delta: "", done: true });
        }
      }
      return;
    }

    if (part.type === "tool" && part.callID && part.tool && part.state) {
      /**
       * 2026-09-17 修正:過去只在第一次看到這個 callID 時送一次 tool-call,而第一次
       * 幾乎一定是 `pending`,input 是 opencode 的 `{}` 佔位(見 class 頂端實測
       * 紀錄)——桌面端每個 OpenCode 工具泡泡都沒有參數,core 寫進 DB 的也全是
       * `"input":{}`。
       *
       * 現在分兩次送,同一個 toolCallId:
       *   1. 第一次看到就送(不等 input),UI 立刻出現「執行中」泡泡、core 在這裡
       *      計入回合硬上限。input 未知時給 `undefined` 而不是 `{}`——`{}` 會被
       *      當成「這個工具沒有參數」顯示、落地,正是這次修的 bug。
       *   2. 第一次進入 `running`/`completed` 時補送一次帶完整 input 的 tool-call。
       * core 把第 2 次當成「補資訊」:不重複計數、就地更新同一筆 row、不經過
       * ensureBusy()(`running` 可能排在 `permission.asked` 之後,那時翻回 busy 會
       * 蓋掉 waiting);桌面端照舊以 toolCallId upsert。這與 claude-sdk-adapter
       * 在 content_block_start 提早送出是同一套語意,取捨見
       * apps/core/src/session/session-manager.ts 的 `RuntimeState.openToolCalls`。
       *
       * 為什麼不乾脆等到 `running` 才送唯一一次:泡泡要等參數串流完才出現(大檔
       * write/edit 可以好幾秒),而且那次事件在 core 會經過 ensureBusy(),遇到
       * 先到的 permission.asked 就把 waiting 翻回 busy。
       *
       * 只把 `running`/`completed` 帶的 input 當真:沒經過 running 就直接 `error`
       * 的,是參數串流到一半被 abort/出錯,opencode 收尾時把 pending 原樣改成
       * error,input 仍是那個 `{}`。`running` 執行期間會帶著 metadata 重送好幾次,
       * input 不會再變,`inputEmitted` 確保只補一次。
       */
      const inputKnown = part.state.status === "running" || part.state.status === "completed";
      let meta = internal.toolMeta.get(part.callID);
      if (!meta) {
        meta = { toolName: part.tool, inputEmitted: inputKnown, emittedResult: false, input: inputKnown ? part.state.input : undefined };
        internal.toolMeta.set(part.callID, meta);
        internal.outputQueue.push({
          type: "tool-call",
          toolCallId: part.callID,
          toolName: part.tool,
          input: inputKnown ? part.state.input : undefined,
        });
      } else if (!meta.inputEmitted && inputKnown) {
        meta.inputEmitted = true;
        // 名稱以 running 這次為準:opencode 在參數解析完成時會重寫 `tool` 欄位
        // (讀原始碼的推論,例如無效呼叫被修補成別的工具;實測的 bash 沒有改名)。
        // 沒改名時這行是 no-op;有改名時 permission.asked 查到的名稱才會跟著對。
        meta.toolName = part.tool;
        meta.input = part.state.input;
        internal.outputQueue.push({
          type: "tool-call",
          toolCallId: part.callID,
          toolName: part.tool,
          input: part.state.input,
        });
      }
      if (part.state.status === "completed" || part.state.status === "error") {
        // abort 不會送 `question.rejected`(見檔案頂端「提問」段落),工具進入終態
        // 就代表這一題再也答不了了。
        for (const [requestId, pending] of internal.pendingQuestions) {
          if (pending.toolCallId === part.callID) internal.pendingQuestions.delete(requestId);
        }
      }
      if (!meta.emittedResult && part.state.status === "completed") {
        meta.emittedResult = true;
        internal.outputQueue.push({
          type: "tool-result",
          toolCallId: part.callID,
          toolName: part.tool,
          output: part.state.output ?? (part.state.metadata as Record<string, unknown> | undefined)?.output,
          isError: false,
          structuredResult: part.tool === "question" ? questionStructuredResult(part.state) : undefined,
        });
      } else if (!meta.emittedResult && part.state.status === "error") {
        meta.emittedResult = true;
        internal.outputQueue.push({
          type: "tool-result",
          toolCallId: part.callID,
          toolName: part.tool,
          output: part.state.error,
          isError: true,
          structuredResult: part.tool === "question" ? questionStructuredResult(part.state) : undefined,
        });
      }
      return;
    }
    // step-start / step-finish / patch / file / agent / subtask:尚未有對應的
    // AgentEvent 型別,略過不轉發(見 class 頂端註解的「已知限制」)。
  }

  /**
   * `message.part.delta` 的處理——與 handlePartUpdated() 共用同一個
   * `meta.text` 高水位，讓兩種事件來源無論實際到達順序為何都不會重複轉發
   * 同一段文字（修復「回應內容重複」的 bug，見本檔案頂端「已知限制」上方
   * 這輪修復的說明）：
   *
   * 早先的版本只追蹤「已知長度」（`textLength`），`message.part.delta` 到達
   * 時無條件把 `delta` 原封不動轉發、並把長度加上 `delta.length`——這個假設
   * 只有在「delta 一定是尚未出現過的新內容」時才成立。但 opencode 的
   * `message.part.updated` 快照與 `message.part.delta` 增量，兩者理論上描述
   * 的是同一份底層文字的不同觀測角度，沒有任何文件保證的到達順序（`GET
   * /event` 雖然是單一 SSE 連線、TCP 保證 byte 順序，但 opencode 伺服器端
   * 產生這兩種事件的內部時序本身沒有強制關係)——一旦某個片段先被
   * `message.part.updated` 的全文快照涵蓋、之後才收到描述同一片段的
   * `message.part.delta`（或反過來），舊版就會把同一段文字送出兩次，UI 端
   * 因為兩次 `message-delta` 用同一個 `messageId`（見 session-store.ts 的
   * `content: existing.content + event.delta`）而直接疊加在同一個訊息泡泡
   * 內，呈現成「內容重複」。
   *
   * 修法：`delta` 事件本身不帶「這是文字的第幾個字元開始」這種絕對位置
   * 資訊，沒辦法比照 handlePartUpdated() 直接用長度切 suffix；改用「內容
   * 比對」達到等價的高水位語意——若目前已確認的累積文字（`meta.text`）
   * 结尾已經是這個 delta 片段（`meta.text.endsWith(delta)`），代表這段內容
   * 已經透過另一條路徑（多半是先到的 message.part.updated 快照）送出過，
   * 直接忽略、不重複轉發、也不重複累加；否則才是真正尚未送出過的新內容，
   * 轉發並累加進 `meta.text`。這個判斷不依賴兩種事件的到達順序——不論先到
   * 哪一種，同一段文字都只會被判定為「已知」一次。
   */
  private advanceTextPart(internal: InternalSession, partId: string, delta: string): void {
    const meta = internal.partMeta.get(partId);
    // part 的「建立」事件(message.part.updated)理論上一定先於它的
    // message.part.delta 到達(本機實測順序一致);防禦性地忽略未知 partId,
    // 避免對一個型別不明的 part(可能是 reasoning)誤發 message-delta。
    if (!meta || meta.type !== "text") return;
    if (delta.length === 0) return;
    if (meta.text.endsWith(delta)) return; // 已經透過另一種事件來源送出過的重複內容,略過。
    internal.outputQueue.push({ type: "message-delta", messageId: partId, role: "assistant", delta, done: false });
    meta.text += delta;
  }

  /** 忙碌→閒置的轉換點(見 class 頂端註解):flush 尚未收到 done 的 text part,轉成 completed/略過(若這輪已經送過 error)。 */
  private markIdleIfBusy(internal: InternalSession): void {
    if (!internal.busy) return; // 已經處理過這次轉換(session.status 與 session.idle 常常成對送達)
    internal.busy = false;
    for (const [partId, meta] of internal.partMeta.entries()) {
      if (meta.type === "text" && !meta.done) {
        meta.done = true;
        internal.outputQueue.push({ type: "message-delta", messageId: partId, role: "assistant", delta: "", done: true });
      }
    }
    if (!internal.turnErrored) {
      internal.outputQueue.push({ type: "completed" });
    }
    internal.turnErrored = false;
    const waiters = internal.idleWaiters;
    internal.idleWaiters = [];
    for (const resolve of waiters) resolve();
  }
}

interface ToolMeta {
  toolName: string;
  /** 已經送過帶完整 input 的 tool-call(見 handlePartUpdated() 的兩段式說明)。 */
  inputEmitted: boolean;
  emittedResult: boolean;
  /** 已知的完整 input(`running`/`completed` 帶的);`permission.asked` 轉成 permission-request 時要一起帶上。 */
  input?: unknown;
}

interface PartMeta {
  type: "text" | "reasoning";
  /**
   * 這個 text part 目前「已確認的累積文字」——不只是長度，是完整字串本身
   * （見下方 handlePartUpdated()/advanceTextPart() 的說明：只存長度沒辦法
   * 判斷 message.part.delta 送來的片段是不是已經被 message.part.updated
   * 的全文快照涵蓋過的重複內容，必須比對實際內容）。
   */
  text: string;
  done: boolean;
}

interface PendingPermission {
  toolCallId?: string;
}

/**
 * `user-dialog-request.questions` 的形狀(見 packages/shared/src/events.ts 的
 * `UserDialogRequestEventSchema` 註解)——對齊 claude-agent-sdk 的
 * `AskUserQuestionInput.questions`,讓 UI 只需要認一種形狀。
 */
interface DialogQuestion {
  question: string;
  header: string;
  options: Array<{ label: string; description: string }>;
  multiSelect: boolean;
  /** `false` 時不提供自由輸入;opencode 省略這個欄位代表允許。 */
  custom: boolean;
}

interface PendingQuestion {
  questions: DialogQuestion[];
  toolCallId?: string;
}

interface InternalSession {
  handle: AgentHandle;
  child: OpencodeChildProcess;
  baseUrl: string;
  /**
   * 呼叫這個 session 的 opencode 伺服器要帶的 `Authorization` 標頭值(`Basic ...`),見 opencode-server-auth.ts。
   * **秘密**:只留在記憶體,不寫 log、不進 DB、不進任何 AgentEvent;所有請求都必須經過下面的 postJson/getJson/authHeaders。
   */
  authorization: string;
  opencodeSessionId: string;
  /** `task` 工具(subagent)建立的子 session id(含孫 session),見 handleEvent() 開頭的說明。 */
  childSessionIds: Set<string>;
  outputQueue: AsyncQueue<AgentEvent>;
  partMeta: Map<string, PartMeta>;
  toolMeta: Map<string, ToolMeta>;
  pendingPermissions: Map<string, PendingPermission>;
  /** `question.asked` 的 requestId -> 待答內容,見 `resolveUserDialog()`。 */
  pendingQuestions: Map<string, PendingQuestion>;
  erroredMessageIds: Set<string>;
  /** opencode messageID -> role("user"/"assistant"/...),由 message.updated 事件
   *  填入——見 handlePartUpdated() 用它過濾使用者自己訊息的 part。 */
  messageRoles: Map<string, string>;
  busy: boolean;
  /** 這一輪是否已經送出過 error(避免 markIdleIfBusy() 額外再送一次 completed)。 */
  turnErrored: boolean;
  idleWaiters: Array<() => void>;
  sseController: AbortController;
  /** setModel() 設定的覆寫值,優先於 handle.launch.model——見 setModel()/sendPrompt() 方法註解。 */
  modelOverride?: { providerID: string; modelID: string };
  /**
   * 這輪(slash command)新增:spawn() 時 `GET /command` 查到的指令清單,key
   * 為指令名稱——`sendPrompt()` 靠它判斷開頭 "/word" 是否命中已知指令、要不要
   * 改走 POST /session/{id}/command。查詢失敗時維持空 Map(見 spawn() 內查詢
   * 失敗分支的註解),不影響一般 /message 路徑。
   */
  availableCommands: Map<string, OpencodeCommand>;
}

/**
 * 這輪(slash command)新增:`GET /command`(本機實測 opencode 1.18.7)回傳的
 * `Command` 形狀——只宣告這裡實際用到的欄位(比照既有 `OpencodePart` 的
 * 既有風格),完整形狀見檔案頂端查證段落。
 */
interface OpencodeCommand {
  name: string;
  description?: string;
  hints?: string[];
}

interface OpencodePart {
  id: string;
  /** 這個 part 所屬的 opencode message id——用來反查 InternalSession.messageRoles
   *  判斷這個 part 是 user 還是 assistant 的訊息,見 handlePartUpdated()。 */
  messageID?: string;
  type: string;
  text?: string;
  time?: { start?: number; end?: number };
  callID?: string;
  tool?: string;
  state?: {
    status?: string;
    input?: unknown;
    output?: string;
    error?: string;
    metadata?: unknown;
  };
}

interface OpencodeEvent {
  id?: string;
  type: string;
  properties?: unknown;
}

function waitForIdle(internal: InternalSession, timeoutMs: number): Promise<void> {
  if (!internal.busy) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    internal.idleWaiters.push(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * 把一個扁平字串拆成 opencode `POST /session/{id}/message` body 要求的
 * `{providerID, modelID}` 兩個欄位。兩種呼叫來源共用這個函式：
 *   - `AgentLaunchSpec.model`(建立 session 時，SessionList 從
 *     `opencode models` 偵測結果挑出的 "providerID/modelID" 組合，見
 *     provider-catalog.ts/resolve-providers.ts 的模型偵測流程)。
 *   - `setModel()` 收到的、對話中途要換的 model 字串(來源同上——UI 選單的
 *     選項本來就是同一份偵測清單，見 ChatView.tsx 的 ModelControl)。
 * 只切第一個 "/"（modelID 本身可能含 "/"，例如某些 provider 的模型 id），
 * 沒有 "/" 或是空字串一律回傳 undefined——`sendPrompt()` 視為「不帶 model
 * 欄位，交給 opencode 自己的預設」，`setModel()` 則視為輸入不合法，拋出
 * 錯誤而非靜默忽略(見該方法註解)。
 */
function parseModelString(model: string | undefined): { providerID: string; modelID: string } | undefined {
  if (!model) return undefined;
  const slashIndex = model.indexOf("/");
  if (slashIndex <= 0 || slashIndex === model.length - 1) return undefined;
  return { providerID: model.slice(0, slashIndex), modelID: model.slice(slashIndex + 1) };
}

/**
 * opencode 的 `QuestionInfo[]`(`multiple?`/`custom?` 皆可省略、`options` 沒有
 * 最少個數)轉成 `DialogQuestion[]`。只擋 UI 真的畫不出來的形狀(不是陣列、
 * 題目或選項 label 不是字串),其餘缺的欄位補預設值。
 */
function normalizeOpencodeQuestions(raw: unknown): DialogQuestion[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const questions: DialogQuestion[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) return undefined;
    const { question, header, options, multiple, custom } = entry as Record<string, unknown>;
    if (typeof question !== "string" || !Array.isArray(options)) return undefined;
    const normalizedOptions: DialogQuestion["options"] = [];
    for (const option of options) {
      if (typeof option !== "object" || option === null) return undefined;
      const { label, description } = option as Record<string, unknown>;
      if (typeof label !== "string") return undefined;
      normalizedOptions.push({ label, description: typeof description === "string" ? description : "" });
    }
    questions.push({
      question,
      header: typeof header === "string" ? header : "",
      options: normalizedOptions,
      multiSelect: multiple === true,
      custom: custom !== false,
    });
  }
  return questions;
}

/**
 * `DialogAnswer` 的答案是「題目文字 -> 字串」(多選以 ", " 串接,對齊
 * claude-agent-sdk),opencode 要每題一個 label 陣列。整串剛好是一個選項、或
 * 拆開後每段都是選項時還原成陣列;其餘(含使用者自行輸入的答案)整串當成一個
 * 答案。兩種寫法模型看到的文字相同(opencode 自己也是用 ", " 串接),差別只在
 * opencode 記下的 `metadata.answers`。
 */
function toOpencodeAnswer(question: DialogQuestion, text: string | undefined): string[] {
  if (!text) return [];
  const labels = new Set(question.options.map((option) => option.label));
  if (labels.has(text)) return [text];
  const parts = text.split(", ");
  return parts.every((part) => labels.has(part)) ? parts : [text];
}

/**
 * `question` 工具的 `structuredResult`:組成與 claude-agent-sdk
 * `AskUserQuestionOutput` 相同的 `{questions, answers}`,UI 的已答模式因此不必
 * 分辨後端,也不必在意 tool-call 的 input 有沒有補送到(見 `handlePartUpdated()`
 * 的兩段式說明)。沒作答的題目不放進 `answers`,UI 會顯示「未作答」。
 */
function questionStructuredResult(
  state: NonNullable<OpencodePart["state"]>,
): { questions: DialogQuestion[]; answers: Record<string, string> } | undefined {
  const questions = normalizeOpencodeQuestions((state.input as { questions?: unknown } | undefined)?.questions);
  if (!questions) return undefined;
  const rawAnswers = (state.metadata as { answers?: unknown } | undefined)?.answers;
  const answers: Record<string, string> = {};
  if (Array.isArray(rawAnswers)) {
    questions.forEach((q, index) => {
      const selected = rawAnswers[index];
      if (!Array.isArray(selected)) return;
      const texts = selected.filter((value): value is string => typeof value === "string" && value.length > 0);
      if (texts.length > 0) answers[q.question] = texts.join(", ");
    });
  }
  return { questions, answers };
}

function rejectAfter(
  ms: number,
  code: string,
  params: Record<string, unknown> | undefined,
  fallbackMessage: string,
): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new DeskmonyError(code, params, fallbackMessage)), ms);
  });
}

/** 從子程序 stdout 解析 "listening on http://host:port" 這一行,取得 base URL(去除尾端斜線)。 */
function waitForListeningLine(child: OpencodeChildProcess): Promise<string> {
  return new Promise((resolve) => {
    let buffer = "";
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString();
      const match = buffer.match(LISTENING_LINE_PATTERN);
      if (match) {
        child.stdout?.off("data", onData);
        resolve(match[1].replace(/\/$/, ""));
      }
    };
    child.stdout?.on("data", onData);
  });
}

/**
 * 對 opencode 伺服器發的**每一個**請求都要帶的標頭(2026-10-03:伺服器有 basic auth,見 opencode-server-auth.ts)。
 * 這個檔案裡所有打 opencode 伺服器的 `fetch` 只有四處——waitForHealthy()、postJson()、getJson()、SSE 的 consumeEvents()——
 * 全都經過這個函式;`authorization` 在這幾個函式都是**必填參數**,漏帶會是編譯錯誤。
 * (warnIfServerUnsecured() 刻意不帶:它就是要驗證「不帶標頭會被擋」。)
 */
function authHeaders(authorization: string, extra?: Record<string, string>): Record<string, string> {
  return { ...extra, authorization };
}

/** 輪詢 `/global/health` 直到回應 200(或逾時,由呼叫端的 Promise.race 把關)。 */
async function waitForHealthy(baseUrl: string, authorization: string): Promise<void> {
  for (;;) {
    try {
      const res = await fetch(`${baseUrl}/global/health`, { headers: authHeaders(authorization) });
      if (res.ok) return;
      // 401 = 密碼對不上(例如這個 opencode 版本改了認證方式),重試也不會好,但讓呼叫端的逾時去收尾(錯誤訊息一致)。
    } catch {
      // 尚未接受連線,稍後重試。
    }
    await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_INTERVAL_MS));
  }
}

/**
 * 不帶認證打一次 `/global/health`,確認 `OPENCODE_SERVER_PASSWORD` 真的有生效(實測 1.18.7:帶了密碼之後無標頭 → 401)。
 * 仍回 2xx 代表這個 opencode 版本不認那個環境變數(或將來改了名稱),伺服器是**沒鎖**的——`console.warn` 讓它在 log 裡看得見。
 *
 * 為什麼只警告、不拒絕啟動:拒絕等於舊版 opencode 的使用者整個 OpenCode 功能壞掉,而 Deskmony 又沒辦法替 opencode 補上認證;
 * 但靜默放過是更糟的選項——這道鎖原本就是為了擋「本機其他程序繞過權限引擎」,失效時至少要有跡可循。連線錯誤一律忽略
 * (這只是事後的健全性檢查,不能讓它的任何失敗影響 session 建立)。
 */
async function warnIfServerUnsecured(baseUrl: string, agentLabel: string): Promise<void> {
  try {
    const res = await fetch(`${baseUrl}/global/health`);
    if (res.ok) {
      console.warn(
        `[opencode-adapter] 警告:${agentLabel} 的 OpenCode server 沒有要求認證(不帶認證的請求得到 ${res.status})——這個 opencode 版本` +
          "可能不支援 OPENCODE_SERVER_PASSWORD。本機其他程序可以直接呼叫它:替它核准權限請求(繞過政策引擎)、讀取設定裡的 session 網路 token。請升級 opencode。",
      );
    }
  } catch {
    // 只是健全性檢查,忽略。
  }
}

async function postJson<T = unknown>(url: string, body: unknown, authorization: string): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: authHeaders(authorization, { "content-type": "application/json" }),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new DeskmonyError(
      "opencode.requestFailed",
      { url, status: res.status, detail: text.slice(0, 500) },
      `POST ${url} 失敗(status=${res.status}): ${text.slice(0, 500)}`,
    );
  }
  return text.length > 0 ? (JSON.parse(text) as T) : (undefined as T);
}

/** 這輪(slash command)新增:比照上面 postJson() 的既有錯誤處理風格,補一個 GET 版本。 */
async function getJson<T = unknown>(url: string, authorization: string): Promise<T> {
  const res = await fetch(url, { headers: authHeaders(authorization) });
  const text = await res.text();
  if (!res.ok) {
    throw new DeskmonyError(
      "opencode.requestFailed",
      { url, status: res.status, detail: text.slice(0, 500) },
      `GET ${url} 失敗(status=${res.status}): ${text.slice(0, 500)}`,
    );
  }
  return text.length > 0 ? (JSON.parse(text) as T) : (undefined as T);
}

/**
 * 這輪(slash command)新增:`OpencodeCommand` → `SlashCommandInfo`。opencode
 * 的 `hints` 是 template 佔位符 token 陣列(例如 `["$ARGUMENTS"]`),不是人類
 * 可讀的提示文字(不像 claude-agent-sdk 的 `argumentHint`/ACP 的
 * `input.hint`),如實映射、不強行美化——見 events.ts 對應型別的註解。
 */
function mapOpencodeCommands(commands: Map<string, OpencodeCommand>): SlashCommandInfo[] {
  return Array.from(commands.values()).map((c) => ({
    name: c.name,
    description: c.description || undefined,
    argumentHint: c.hints && c.hints.length > 0 ? c.hints.join(" ") : undefined,
  }));
}

/** 解析一個以雙換行分隔的 SSE frame,取出 `data:` 那幾行拼起來的 JSON。 */
function parseSseEvent(frame: string): OpencodeEvent | undefined {
  const dataLines = frame
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).replace(/^ /, ""));
  if (dataLines.length === 0) return undefined;
  try {
    return JSON.parse(dataLines.join("\n")) as OpencodeEvent;
  } catch {
    return undefined;
  }
}

/**
 * Windows 上,PATH 內以 `.cmd`/`.bat` 包裝的執行檔(例如 npm 全域安裝的
 * `opencode.cmd`)不是原生 PE 執行檔,`child_process.spawn` 在不帶
 * `shell: true` 的情況下無法直接執行它們——完整規則與理由見
 * `packages/adapters/src/acp-adapter.ts` 的 `resolveWindowsSpawnCommand()`
 * 頂端註解(該函式未 export,這裡複製一份同樣的邏輯,維持獨立、避免跨檔案
 * private 依賴)。
 */
function resolveWindowsSpawnCommand(
  command: string,
  args: string[],
): { command: string; args: string[]; useShell: boolean } {
  if (process.platform !== "win32") {
    return { command, args, useShell: false };
  }

  const ext = path.extname(command).toLowerCase();

  if (ext === ".ps1") {
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", command, ...args],
      useShell: false,
    };
  }

  if (ext === ".exe" || (ext === "" && path.isAbsolute(command))) {
    return { command, args, useShell: false };
  }

  return {
    command: quoteWindowsShellArg(command),
    args: args.map(quoteWindowsShellArg),
    useShell: true,
  };
}

function quoteWindowsShellArg(value: string): string {
  if (value.length === 0) return '""';
  if (!/[\s"]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}
