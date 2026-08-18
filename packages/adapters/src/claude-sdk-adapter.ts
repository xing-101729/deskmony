import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  McpServerConfig,
  ModelUsage,
  Options as SdkOptions,
  Query as SdkQuery,
  SDKMessage,
  SDKResultMessage,
  SDKUserMessage,
  PermissionResult,
} from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent, AgentProfile, DialogAnswer, EffortLevel } from "@deskmony/shared";
import type { PromptAttachment, PromptInput } from "@deskmony/shared";
import type { SubagentPort } from "@deskmony/shared";
import { DeskmonyError, ErrorCodes } from "@deskmony/shared";
import type { AdapterCapabilities, AgentAdapter, AgentHandle, ResumeOptions, TeamSpawnContext, Workspace } from "./types.js";
import { AsyncQueue } from "./async-queue.js";
import { killProcessTree, waitForChildExit } from "./child-process.js";
import { TEAM_BUS_MCP_SERVER_NAME, TEAM_BUS_TOOL_NAMES, createTeamBusMcpServer } from "./team-bus-mcp.js";
import { SUBAGENT_MCP_SERVER_NAME, SUBAGENT_ALLOWED_TOOL_NAMES, createSubagentMcpServer } from "./subagent-mcp.js";

/**
 * ClaudeAgentSdkAdapter — 使用 `@anthropic-ai/claude-agent-sdk` 的 `query()` API
 * 對接 Claude Code,實作 ARCHITECTURE.md 4.3 節的 AgentAdapter 介面。
 *
 * 對接策略(讀取 node_modules 內 sdk.d.ts 後確認):
 *  - `query({ prompt, options })` 回傳 `Query`,它同時是
 *    `AsyncGenerator<SDKMessage, void>`,並有 `interrupt()` / `close()` /
 *    `streamInput()` 等控制方法。
 *  - 要在同一個 session 內持續送出多輪 prompt,`prompt` 必須是
 *    `AsyncIterable<SDKUserMessage>`(streaming input mode),所以這裡用
 *    `AsyncQueue` 實作一個可持續 push 的輸入串流。
 *  - `options.canUseTool: CanUseTool` 是權限請求的唯一入口:每次工具呼叫前
 *    會被呼叫一次,必須回傳 `Promise<PermissionResult | null>`。我們在這裡
 *    把它轉成 `permission-request` AgentEvent 推播出去,並用一個
 *    `Map<requestId, resolver>` 掛起,等待外部呼叫 `resolvePermission()`。
 *  - `options.includePartialMessages: true` 讓 SDK 額外送出
 *    `type: 'stream_event'`(`SDKPartialAssistantMessage`),內含標準 Anthropic
 *    Messages API 的串流事件(`content_block_delta` 的 `text_delta` 等),
 *    用來做逐字串流顯示;`type: 'assistant'` 的完整訊息則用來抽取
 *    `tool_use` 區塊(避免自行組裝增量 JSON 的複雜度);`type: 'result'`
 *    的 `result` 欄位是該輪最終完整文字,用來當作 `completed` 事件的
 *    `finalText`。
 *
 * 已知限制 / TODO:
 *  - 尚未處理 `tool_use` 的 partial input(input_json_delta)增量顯示,
 *    工具呼叫事件目前只在完整 assistant 訊息抵達時一次性送出。
 *  - `SDKMessage` 是一個非常大的 union(讀取 sdk.d.ts 得知包含 40+ 種子
 *    type),此處只處理 M1 需要的子集,其餘型別以 default 分支忽略並保留
 *    TODO,未來可依需要擴充(例如 SDKPermissionDeniedMessage、
 *    SDKRateLimitEvent 等)。
 *
 * S6(crash-recovery)L4 §4.1 查證(讀 node_modules 內 sdk.d.ts 確認,不是猜):
 *  - `Options.resume?: string`——「Session ID to resume. Loads the
 *    conversation history from the specified session.」`query()` 的 session
 *    預設會落地到磁碟(`~/.claude/projects/<dir>/<sessionId>.jsonl`,見
 *    `deleteSession()`/`getSessionMessages()` 等匯出函式的官方註解),**不是**
 *    只存在該次 `query()` process 的記憶體裡 ⇒ 這是唯一一個真正查證到「磁碟
 *    持久化 session」能力的後端,`canContinue` 對這個 adapter 是 `true`。
 *  - session id 的來源:`SDKSystemMessage`(`type:'system', subtype:'init'`)
 *    帶有 `session_id: string`,這是這條連線最早、保證會出現的一則訊息,見
 *    `handleMessage()` 的 `case "system"`——捕捉它存進 `InternalSession.
 *    backendSessionId`,供 `getBackendSessionId()` 回傳。
 *  - `spawn()` 這輪新增 `resume?: ResumeOptions` 參數,有提供時把
 *    `resume.backendSessionId` 填進 `SdkOptions.resume`,SDK 會載入該 session
 *    的對話歷史繼續(對話上下文由 SDK 自己的磁碟檔案還原,不是這裡自己組
 *    歷史訊息塞回去)。
 *
 * async-scribbling-llama.md Phase 7(AskUserQuestion)機制查證——**已用真實
 * 憑證實測兩輪確認,不是猜測**:
 *  - 原先假設答案要走全新的 `Options.onUserDialog` + `Options.
 *    supportedDialogKinds`(`sdk.d.ts:1516-1551`)。實測推翻:接上驗證過正確
 *    的 `dialogKind`(`"permission_ask_user_question"`,已對照 `claude.exe`
 *    反組譯字串確認存在於 SDK 內部的 dialog 註冊表)後,兩輪、共兩次真實
 *    session 都 0 次觸發——這個 dialog-kind 路徑在目前這種 headless `query()`
 *    用法下結構上就是不會被使用。故**不接** `onUserDialog`/
 *    `supportedDialogKinds`,不寫死路碼。
 *  - 真正有效的答案通道其實一直都是下面這個既有的 `canUseTool`:`toolName
 *    === "AskUserQuestion"` 時特例攔截,**延後** resolve(不像其餘工具立刻
 *    resolve `{behavior:'allow'}`),掛進 `pendingAskUserQuestion`(比照
 *    `pendingPermissions` 的 Promise+Map 模式,但額外存原始 `input`——見下方
 *    `resolveUserDialog()` 需要 spread 回去)並推送 `user-dialog-request`
 *    事件。關鍵在 `PermissionResult` 的 `allow` 分支有個泛用欄位
 *    `updatedInput?: Record<string, unknown>`(`sdk.d.ts:2087-2092`),對
 *    `AskUserQuestion` 而言,工具自己的 input schema 身兼「答案容器」——
 *    `AskUserQuestionInput.answers?: {[question]: string}`(`sdk-tools.
 *    d.ts:2393-2398`,官方註解:「User answers collected by the permission
 *    component」)。實測驗證:單純 `resolve({behavior:'allow'})`(不帶
 *    `updatedInput`)是 no-op——`tool_result` 是字面字串「The user did not
 *    answer the questions.」,`answers` 回來是空物件,模型完全沒收到答案;
 *    改成 `resolve({behavior:'allow', updatedInput:{...input, answers}})`
 *    後,`tool_result` 變成「Your questions have been answered: ...」,模型
 *    下一輪清楚且正確地引用了餵進去的答案。
 *  - 逾時行為:SDK CLI 自己會在 idle 一段時間後,以等效於
 *    `{behavior:'allow', updatedInput:{...input, answers:{}}}` 的方式自動用
 *    空答案繼續(`AskUserQuestionOutput.afkTimeoutMs`)——`resolveUserDialog()`
 *    對 `"cancelled"` 沿用同一種「空答案」語意(而非 `deny`),`dispose()`
 *    清理未回答的項目時也是同一套邏輯,理由見各自方法的註解。
 */
export class ClaudeAgentSdkAdapter implements AgentAdapter {
  private readonly sessions = new Map<string, InternalSession>();
  // S12 Phase2 R2:spawn_subagent 的注入 port(apps/core 的 SessionManager 在
  // 啟動時用 setSubagentPort() 事後注入,比照 setTeamBus() 的「先建構、後注入」
  // 手法打破建構循環——adapter 建立時 core 的 SessionManager 還沒好)。
  private subagentPort?: SubagentPort;
  setSubagentPort(port: SubagentPort): void {
    this.subagentPort = port;
  }

  capabilities(): AdapterCapabilities {
    return {
      streaming: true,
      toolEvents: true,
      permissionRequests: true,
      diff: false,
      interrupt: true,
      terminal: false,
      // S3a(usage-metering)§7.5 ⑤:這輪**真的接上了** —— `handleMessage()` 的
      // `case "result":` 會在 completed/error 之前發出 `usage` 事件(見下方
      // `flushUsage()`)。資料來自 SDK 自己的 `SDKResultMessage`,不依賴任何
      // 外部 agent 的善意轉發,所以是確定的 "supported"(不是 "unknown")——
      // 這也是 Claude Code 這個後端**唯一**拿得到用量的路線(經 ACP bridge
      // 那條路實測完全不報,見 L4 §7)。
      usageReporting: "supported",
      // context 計量表仍然沒有來源:`SDKResultMessage` 給的是**累計**用量與
      // `modelUsage[].contextWindow`(窗口大小),但沒有「目前 context 裡有
      // 多少 token」這個 gauge 的直接欄位。可以從「最後一次請求的 input +
      // cache_read + cache_creation」反推,但那是推論不是來源給的值,這輪
      // 刻意不做(不猜、不估),如實回報 "unsupported"。
      contextReporting: "unsupported",
    };
  }

  async spawn(
    profile: AgentProfile,
    workspace: Workspace,
    team?: TeamSpawnContext,
    resume?: ResumeOptions,
  ): Promise<AgentHandle> {
    const handle: AgentHandle = { id: randomUUID(), profile, workspace };

    const inputQueue = new AsyncQueue<SDKUserMessage>();
    const outputQueue = new AsyncQueue<AgentEvent>();
    const pendingPermissions = new Map<
      string,
      (result: PermissionResult) => void
    >();
    // Phase 7:`AskUserQuestion` 專用的掛起 Map——與 `pendingPermissions` 同一種
    // Promise+Map 模式,但額外存原始 `input`(`resolveUserDialog()` 組
    // `updatedInput` 時需要 `{...input, answers}`,只有 resolver 函式不夠)。
    const pendingAskUserQuestion = new Map<
      string,
      { resolve: (result: PermissionResult) => void; input: Record<string, unknown> }
    >();

    // S8 迴歸修正(子程序外洩):SDK 沒有任何公開 API 可以拿到它 spawn 出來的
    // `claude` 子程序 handle/pid,而 `dispose()` 必須殺掉**整棵**子程序樹才能
    // 釋放 worktree —— `spawnClaudeCodeProcess` 是 SDK 官方提供的注入點(見
    // sdk.d.ts:`spawnClaudeCodeProcess?: (options: SpawnOptions) => SpawnedProcess`,
    // 且註解明講 `ChildProcess already satisfies this interface`),自己 spawn
    // 就自然握有 handle。除了「留下 handle」之外完全比照 SDK 內建的
    // `spawnLocalProcess()`:同樣的 command/args/cwd/env、同樣的
    // `stdio: pipe` 與 `windowsHide: true`、同樣把 SDK 轉送過來的 `signal`
    // 交給 spawn(該 signal 由 SDK 擁有,只在它自己的 graceful 收工窗口之後才
    // abort,見 sdk.d.ts 對 `SpawnOptions.signal` 的說明)。
    //
    // 唯一的副作用(如實記錄,不是沒注意到):SDK 只在「沒有自訂 spawner」時
    // 才會自動補一個 `--debug-file <暫存檔>` 參數(讀 sdk.mjs 的 initialize()
    // 確認),所以掛上這個 spawner 之後 CLI 不再自動寫那個 debug 檔。我們從未
    // 讀過它,而子程序的 stderr 改由下面自己接手轉印,診斷資訊沒有淨損失。
    let child: ChildProcess | undefined;

    const options: SdkOptions = {
      cwd: workspace.path,
      model: profile.model,
      effort: profile.effort,
      includePartialMessages: true,
      permissionMode: "default",
      spawnClaudeCodeProcess: (spawnOptions) => {
        const spawned = spawn(spawnOptions.command, spawnOptions.args, {
          cwd: spawnOptions.cwd,
          env: spawnOptions.env,
          stdio: ["pipe", "pipe", "pipe"],
          signal: spawnOptions.signal,
          windowsHide: true,
        });
        // SDK 內建的 spawn 會自己讀掉 stderr(拿來組錯誤訊息的 tail);換成自訂
        // spawner 之後沒有人讀它,pipe 緩衝區(預設 64KB)填滿就會**卡住**
        // 子程序的寫入 —— 這裡必須自己排掉。內容轉給 console.error,與
        // acp-adapter.ts 對 ACP agent stderr 的既有作法一致(不靜默丟棄,
        // 子程序的錯誤輸出仍看得到)。
        spawned.stderr?.on("data", (chunk: Buffer) => {
          const text = chunk.toString().trimEnd();
          if (text) console.error(`[claude-sdk-adapter] ${profile.name} stderr: ${text}`);
        });
        spawned.stderr?.on("error", () => {
          // 子程序已結束時讀取 stderr 可能報錯,忽略。
        });
        child = spawned;
        return spawned;
      },
      // 這輪新增(provider 目錄重構):`profile.env`(provider 層級預設 +
      // profile 自己的覆寫,已由 SessionManager.createSession() 合併好)併入
      // SDK 子程序的環境變數(見 sdk.d.ts 對 `Options.env` 的官方註解——設定
      // 這個欄位會**整個取代**子程序環境,不會自動 merge process.env,故這裡
      // 手動 `...process.env` 展開,子程序仍會繼承 PATH/HOME 等既有變數)。
      // 沒有任何 provider/profile env 時(最常見情況)刻意省略這個欄位,讓
      // SDK 沿用「省略時繼承 process.env」的預設行為,不改變既有 profile 的
      // spawn 結果。
      ...(profile.env && Object.keys(profile.env).length > 0 ? { env: { ...process.env, ...profile.env } } : {}),
      // S6(crash-recovery)L4 §4.1:「繼續(保有記憶)」——見檔案頂端查證說明。
      ...(resume ? { resume: resume.backendSessionId } : {}),
      // S8(agent-lifecycle)L4 §3.2 修正實作:`profile.systemPrompt` 在這輪之前
      // **從未被任何 adapter 轉發過**(查證:acp-adapter.ts/opencode-adapter.ts/
      // pty-adapter.ts 均無 systemPrompt 相關程式碼)——是一個存在於 schema/DB/
      // UI,但完全不會真的送到任何被 spawn 的 agent 的欄位。S8 的「筆記指路」
      // (SessionManager.prepareSpawnProfile() 把 `.deskmony/notes/` 指路段落
      // 附加在 `profile.systemPrompt` 尾端)若這裡不接上,整段機制就只是把文字
      // 寫進一個沒人讀的欄位,等於沒有指路——這裡補上轉發,讓它至少對這個
      // (最主要、也是官方推薦給長命 agent 的)adapter 生效。
      //
      // 用 SDK 的 `{ type: 'preset', preset: 'claude_code', append }` 形式而
      // **不是**直接 `systemPrompt: profile.systemPrompt`(純字串會整個取代
      // Claude Code 的預設系統提示,等於讓「順便設定過 systemPrompt」的既有
      // profile 突然失去所有預設工具/行為指引,是遠超本輪範圍的行為變動)——
      // `append` 保留預設提示,只追加自訂內容,這才是這個欄位原本應有的語意
      // (使用者過去設定它從未生效,現在生效時,選最小驚訝的解讀:附加而非取代)。
      ...(profile.systemPrompt
        ? { systemPrompt: { type: "preset", preset: "claude_code", append: profile.systemPrompt } }
        : {}),
      canUseTool: async (toolName, input, callOptions) => {
        const requestId = callOptions.requestId;
        // Phase 7:`AskUserQuestion` 特例——見檔案頂端「機制查證」段落的完整
        // 理由。**不**立刻 resolve;改成掛進 pendingAskUserQuestion 並推送
        // `user-dialog-request` 事件,由 `resolveUserDialog()` 之後才真正
        // resolve 這個 Promise。
        if (toolName === "AskUserQuestion") {
          return new Promise<PermissionResult>((resolve) => {
            pendingAskUserQuestion.set(requestId, { resolve, input });
            outputQueue.push({
              type: "user-dialog-request",
              requestId,
              toolUseID: callOptions.toolUseID,
              questions: input.questions,
            });
          });
        }
        return new Promise<PermissionResult>((resolve) => {
          pendingPermissions.set(requestId, resolve);
          outputQueue.push({
            type: "permission-request",
            requestId,
            toolName,
            input,
            description: callOptions.description ?? callOptions.title,
          });
        });
      },
    };

    // M3 Round A:session 屬於某個 team 成員時,掛載內建的 team-bus MCP
    // server(見 packages/adapters/src/team-bus-mcp.ts),讓這個 agent 拿到
    // send_message/broadcast/list_teammates/report_status 四個工具。這幾個
    // 工具只是傳訊/查詢,不涉及檔案/指令執行,額外放進 allowedTools 讓它們
    // 略過 canUseTool 的權限彈窗(ARCHITECTURE.md 4.1 節「內建 team-bus MCP
    // server」—— 純粹的平台內部管線,不需要每次都要人類核可)。
    // S12 Phase2 R2:改成累積式掛載——team 與 subagent 各自獨立判斷,兩者皆
    // 有時同時掛上(各自獨立,不互相影響)。
    const mcpServers: Record<string, McpServerConfig> = {};
    const allowedTools: string[] = [];
    if (team) {
      mcpServers[TEAM_BUS_MCP_SERVER_NAME] = createTeamBusMcpServer(team);
      allowedTools.push(...TEAM_BUS_TOOL_NAMES);
    }
    if (this.subagentPort) {
      // handle.id(= 這個 session 的 id)在 spawn() 開頭就已產生(line 101),
      // 這裡閉包捕捉當作 parentSessionId,agent 無法覆寫。
      mcpServers[SUBAGENT_MCP_SERVER_NAME] = createSubagentMcpServer(this.subagentPort, handle.id);
      // list_profiles/list_subagents 是純查詢,自動放行;spawn_subagent/
      // send_to_subagent 刻意 **不** 放進 allowedTools —— 見 §4「權限」(兩者
      // 都會讓某個 session 多跑一輪、燒 token,必須走權限彈窗)。
      allowedTools.push(...SUBAGENT_ALLOWED_TOOL_NAMES);
    }
    if (Object.keys(mcpServers).length > 0) {
      options.mcpServers = mcpServers;
      options.allowedTools = allowedTools;
    }

    const sdkQuery: SdkQuery = query({ prompt: inputQueue, options });

    const internal: InternalSession = {
      handle,
      inputQueue,
      outputQueue,
      pendingPermissions,
      pendingAskUserQuestion,
      sdkQuery,
      // `query()` 到這裡已經同步建好 transport 並呼叫過 spawnClaudeCodeProcess,
      // 所以 `child` 這時已經有值;萬一 SDK 之後改成延後 spawn,這裡拿到
      // undefined 也只是退回「沒有 handle 可殺」的舊行為,不會壞掉。
      getChild: () => child,
      currentMessageId: null,
      backendSessionId: undefined,
    };
    this.sessions.set(handle.id, internal);

    // 背景迴圈:把 SDK 的訊息串流轉成 AgentEvent 並 push 進 outputQueue。
    void this.consume(internal).catch((err: unknown) => {
      outputQueue.push({
        type: "error",
        message: "Claude Agent SDK 串流中斷",
        detail: err instanceof Error ? err.message : String(err),
      });
    });

    return handle;
  }

  /**
   * async-scribbling-llama.md Phase 6:`prompt.attachments` 有圖片/文件變體
   * 時,`message.content` 從純字串換成標準 Anthropic `MessageParam` 的
   * content-block 陣列(`TextBlockParam` + `ImageBlockParam[]` +
   * `DocumentBlockParam[]`,讀 `node_modules` 內 `@anthropic-ai/sdk` 的
   * `messages.d.ts` 查證過 `SDKUserMessage.message: MessageParam`、
   * `MessageParam.content: string | Array<ContentBlockParam>`,`ContentBlock
   * Param` 這個聯集型別本身就包含 `DocumentBlockParam`——與 Phase 5 接收方向
   * 的 `ToolImage.tsx`/`parseImageBlock()` 讀的是同一個 `Base64ImageSource`
   * 形狀 `{type:"base64", media_type, data}`,這裡是對稱的送出方向)。文件
   * 附件的 `DocumentBlockParam.source` 只認 `Base64PDFSource`(PDF)與
   * `PlainTextSource`(純文字,`data` 要明文不是 base64)兩種——見 prompt.ts
   * 的 `PromptDocumentAttachmentSchema` 註解,`data` 在 wire 上一律 base64,
   * text/plain 這裡要先 decode 回明文才能塞進 `PlainTextSource.data`。沒有
   * 任何附件時維持原本的純字串,不改變既有行為。`{type:"file"}` 附件變體
   * (仍是死程式碼,見 prompt.ts)被下面的 filter 自然排除,不會送給模型。
   */
  sendPrompt(handle: AgentHandle, prompt: PromptInput): void {
    const internal = this.mustGet(handle);
    const imageAttachments = (prompt.attachments ?? []).filter(
      (a): a is Extract<PromptAttachment, { type: "image" }> => a.type === "image",
    );
    const documentAttachments = (prompt.attachments ?? []).filter(
      (a): a is Extract<PromptAttachment, { type: "document" }> => a.type === "document",
    );
    const userMessage: SDKUserMessage = {
      type: "user",
      message: {
        role: "user",
        content:
          imageAttachments.length === 0 && documentAttachments.length === 0
            ? prompt.text
            : [
                { type: "text", text: prompt.text },
                ...imageAttachments.map((a) => ({
                  type: "image" as const,
                  source: { type: "base64" as const, media_type: a.mediaType, data: a.data },
                })),
                ...documentAttachments.map((a) => ({
                  type: "document" as const,
                  title: a.name,
                  source:
                    a.mediaType === "application/pdf"
                      ? { type: "base64" as const, media_type: "application/pdf" as const, data: a.data }
                      : {
                          type: "text" as const,
                          media_type: "text/plain" as const,
                          data: Buffer.from(a.data, "base64").toString("utf-8"),
                        },
                })),
              ],
      },
      parent_tool_use_id: null,
    };
    internal.inputQueue.push(userMessage);
  }

  events(handle: AgentHandle): AsyncIterable<AgentEvent> {
    const internal = this.mustGet(handle);
    return internal.outputQueue;
  }

  /**
   * M3 Round B 修正(interrupt 時序 race,見 packages/adapters/src/types.ts
   * 的 `AgentAdapter.interrupt()` 註解):`Query.interrupt()`
   * (`node_modules` 內 `sdk.d.ts` 明載)回傳的 `Promise` 在「查詢確實停止
   * 處理、控制權交還呼叫端」時才 resolve,不是單純送出中斷請求就算數 ——
   * 修正前這裡是 `void internal.sdkQuery.interrupt()`(fire-and-forget),
   * 呼叫端(MessageBus)緊接著就 await 注入新 prompt,可能與尚未真正停下的
   * 回合競爭。這裡改成 `await`,把「中斷確實生效」這個保證往外傳遞。
   */
  async interrupt(handle: AgentHandle): Promise<void> {
    const internal = this.mustGet(handle);
    await internal.sdkQuery.interrupt();
  }

  /**
   * S8 迴歸修正(子程序外洩 —— e2e-gateway 步驟 15e「task.delete 清理 worktree」
   * 唯一的 deterministic FAIL)。
   *
   * 修正前這裡只呼叫 `Query.close()` 就 resolve。`close()` 的官方文件雖然寫著
   * 「terminate the underlying process」,但**實際行為並非同步終止**(讀 sdk.mjs
   * 內 `ProcessTransport.close()` 確認,不是猜):它只做 `stdin.end()`(送 EOF,
   * 請 CLI 自己收工),然後排一個 `unref()` 過的計時器,Windows 上要**再等
   * 2 秒 + 5 秒**才會真的 `kill('SIGKILL')`。
   *
   * 更關鍵的是「殺誰」:`claude` 子程序自己還會為每個設定好的 MCP server 再開
   * 一個行程(實測一次 spawn 就多出 codebase-memory-mcp.exe / uvx.exe / uv.exe /
   * plane-mcp-server.exe / python.exe … 一整棵樹),這些孫程序**同樣繼承了
   * cwd = 任務 worktree**,而 SDK 從頭到尾只碰得到直接子程序。實測:`close()`
   * 之後 `claude.exe` 約 1 秒內結束,但整個 worktree 目錄要到約 3 秒才真正
   * 可刪 —— 撐著不放的是那些比父程序晚死的孫程序。呼叫端
   * (TaskService.deleteTask → WorkspaceManager.removeWorkspace)的重試窗口
   * 只有 1.8 秒,於是 `git worktree remove` 撞上 `Permission denied` /
   * `EBUSY: resource busy or locked`。這在 S8 之前不會發生 —— S8 讓
   * `assignTask()` 自動 spawn session,worktree 才第一次被子程序當成 cwd 佔住,
   * 把這個既有的外洩暴露出來。
   *
   * 修正後的順序(順序本身就是修正的一部分):
   *   1. `sdkQuery.close()` —— 先讓 SDK 做完它自己那份清理(pending 控制請求、
   *      MCP transport、stdin EOF),不繞過它。
   *   2. **立刻**殺整棵子程序樹。`taskkill /T` 是靠當下的父子關係找出整棵樹的,
   *      所以必須趁 `claude.exe` 還活著時下手 —— 它一旦自己先結束,那些 MCP
   *      孫程序就成了孤兒,再也找不回來。步驟 1 只是送出 EOF,同一個 tick 內
   *      子程序絕不可能已經結束,樹是完整的。
   *   3. 等直接子程序真正 exit(上限 3 秒;逾時就放棄等待、不丟錯,讓呼叫端
   *      既有的重試機制接手,絕不因為等不到而卡住 dispose)。
   */
  async dispose(handle: AgentHandle): Promise<void> {
    const internal = this.sessions.get(handle.id);
    if (!internal) return;
    // 尚未被回覆的權限請求(canUseTool 的 Promise)若放著不管會永久懸置 ——
    // 一律以 deny 收場後再清空,避免呼叫端(SDK 內部)卡住等不到結果。
    for (const resolver of internal.pendingPermissions.values()) {
      resolver({ behavior: "deny", message: "session 已關閉" });
    }
    internal.pendingPermissions.clear();
    // Phase 7:尚未回答的 AskUserQuestion 同樣是一個未 resolve 的 canUseTool
    // Promise,放著不管會讓 SDK 的 query() 永久卡住等一個不會再來的回覆——但
    // **不能**沿用上面 pendingPermissions 的 deny 收場(那是「使用者拒絕了此
    // 工具呼叫」的權限語意,AskUserQuestion 不是權限決策,見
    // resolveUserDialog() 的完整理由)。這裡改用同一套「空答案」語意,與
    // resolveUserDialog() 的 "cancelled" 分支一致。
    for (const pending of internal.pendingAskUserQuestion.values()) {
      pending.resolve({ behavior: "allow", updatedInput: { ...pending.input, answers: {} } });
    }
    internal.pendingAskUserQuestion.clear();
    internal.inputQueue.close();
    internal.outputQueue.close();
    try {
      internal.sdkQuery.close();
    } catch {
      // ignore — process 可能已經結束
    }
    const child = internal.getChild();
    if (child) {
      killProcessTree(child);
      await waitForChildExit(child, 3_000);
    }
    this.sessions.delete(handle.id);
  }

  /**
   * M5 Round C:直接呼叫 SDK 的 `Query.setModel()`(見 packages/adapters/src/
   * types.ts 的 `AgentAdapter.setModel()` 介面註解、`sdk.d.ts` 內
   * `Query.setModel(model?: string): Promise<void>` 的官方文件)。因為
   * `spawn()` 一律用 streaming input mode(`AsyncQueue` 當 `prompt`),這個
   * 呼叫在任何時間點(包含目前正忙碌處理上一輪的情況)都合法,不需要
   * dispose 現有連線或重新 spawn,對話上下文原封不動保留。
   */
  async setModel(handle: AgentHandle, model: string): Promise<void> {
    const internal = this.mustGet(handle);
    await internal.sdkQuery.setModel(model);
  }

  /**
   * 比照上面的 `setModel()`:直接呼叫 SDK 的
   * `Query.applyFlagSettings({ effortLevel })`(見 packages/adapters/src/
   * types.ts 的 `AgentAdapter.setEffort()` 介面註解、`sdk.d.ts` 內
   * `applyFlagSettings()` 的官方文件)。同樣不需要 dispose 現有連線或重新
   * spawn,對話上下文原封不動保留。
   */
  async setEffort(handle: AgentHandle, effort: EffortLevel): Promise<void> {
    const internal = this.mustGet(handle);
    await internal.sdkQuery.applyFlagSettings({ effortLevel: effort });
  }

  resolvePermission(handle: AgentHandle, requestId: string, decision: "allow" | "deny"): void {
    const internal = this.mustGet(handle);
    const resolver = internal.pendingPermissions.get(requestId);
    if (!resolver) return;
    internal.pendingPermissions.delete(requestId);
    if (decision === "allow") {
      resolver({ behavior: "allow" });
    } else {
      resolver({ behavior: "deny", message: "使用者拒絕了此工具呼叫" });
    }
  }

  /**
   * async-scribbling-llama.md Phase 7:回覆一筆先前透過 `user-dialog-request`
   * 事件發出的 `AskUserQuestion`。**唯一真正有效的回傳通道是這個 canUseTool
   * Promise 本身**(見檔案頂端「機制查證」段落,不是走 onUserDialog)——
   * `"completed"` 時把使用者選的答案透過 `updatedInput.answers` 餵回去;
   * `"cancelled"` 時故意給空答案物件而非 `deny`:比照 SDK 自己在 idle 逾時後
   * 的行為(等效於 `{behavior:'allow', updatedInput:{...input,
   * answers:{}}}`),讓模型收到的 `tool_result` 文字與 SDK 原生逾時一致——
   * `deny` 會產生語意不同的文字(「使用者拒絕了此工具呼叫」),讓模型誤以為
   * 是被權限系統擋下,而不是使用者選擇略過作答。
   */
  resolveUserDialog(handle: AgentHandle, requestId: string, result: DialogAnswer): void {
    const internal = this.mustGet(handle);
    const pending = internal.pendingAskUserQuestion.get(requestId);
    if (!pending) return;
    internal.pendingAskUserQuestion.delete(requestId);
    const answers = result.behavior === "completed" ? result.result.answers : {};
    pending.resolve({ behavior: "allow", updatedInput: { ...pending.input, answers } });
  }

  /** S6(crash-recovery)L4 §4.1:見檔案頂端查證說明與 `types.ts` 的介面註解。 */
  getBackendSessionId(handle: AgentHandle): string | undefined {
    return this.sessions.get(handle.id)?.backendSessionId;
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

  private async consume(internal: InternalSession): Promise<void> {
    const { sdkQuery, outputQueue } = internal;
    for await (const message of sdkQuery) {
      this.handleMessage(internal, message);
    }
    outputQueue.close();
  }

  private handleMessage(internal: InternalSession, message: SDKMessage): void {
    const { outputQueue } = internal;

    switch (message.type) {
      case "stream_event": {
        const event = message.event as {
          type: string;
          delta?: { type: string; text?: string };
          content_block?: { type: string; id?: string; name?: string; input?: unknown };
        };
        // 注意:每一個 stream_event 的 uuid 都不同(實測 7 events = 7 uuids),
        // 不能直接當 messageId 用,否則 UI 會把每個 delta 切成獨立訊息。
        // 以 message_start 當作一則 assistant 訊息的邊界,期間共用同一個 id。
        if (event.type === "message_start") {
          internal.currentMessageId = message.uuid;
        } else if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
          // tool-call 漸進顯示(最小版):在區塊剛開始(工具實際執行前)就提早
          // 送出一個 tool-call 事件,讓 UI 能立刻顯示「執行中」。此時 SDK 尚未
          // 送出完整 input(要靠逐步累積的 input_json_delta,故意不處理,超出
          // 最小版範圍),所以 input 先給 undefined。等 "assistant" case 的完整
          // 訊息抵達時會再送一次帶完整 input 的 tool-call 事件,UI(upsertToolItem)
          // 以 toolCallId 做 upsert,兩次事件會自動合併成同一筆。
          outputQueue.push({
            type: "tool-call",
            toolCallId: String(event.content_block.id ?? randomUUID()),
            toolName: String(event.content_block.name ?? "unknown"),
            input: undefined,
          });
        } else if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
          const messageId = internal.currentMessageId ?? message.uuid;
          internal.currentMessageId = messageId;
          outputQueue.push({
            type: "message-delta",
            messageId,
            role: "assistant",
            delta: event.delta.text ?? "",
            done: false,
          });
        } else if (event.type === "message_stop" && internal.currentMessageId) {
          outputQueue.push({
            type: "message-delta",
            messageId: internal.currentMessageId,
            role: "assistant",
            delta: "",
            done: true,
          });
          internal.currentMessageId = null;
        }
        break;
      }

      case "assistant": {
        // 完整訊息抵達:掃描 tool_use 區塊,發出 tool-call 事件。
        // 文字內容已由 stream_event 逐字送出,這裡不重覆送出文字。
        const content = message.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (isRecord(block) && block.type === "tool_use") {
              outputQueue.push({
                type: "tool-call",
                toolCallId: String(block.id ?? randomUUID()),
                toolName: String(block.name ?? "unknown"),
                input: block.input,
              });
            }
          }
        }
        if (message.error) {
          outputQueue.push({
            type: "error",
            message: `Assistant 訊息錯誤: ${message.error}`,
          });
        }
        break;
      }

      case "user": {
        // 工具執行結果會以 user 訊息(role: user, content: tool_result[])回傳給模型。
        const content = message.message?.content;
        if (Array.isArray(content)) {
          // async-scribbling-llama.md Phase 4:`message.tool_use_result` 型別上
          // 是單一 `unknown`,SDK 文件說「以對應 tool_use 的名稱為 key」但沒有
          // 說清楚一個 user 訊息含多個 tool_result block(平行工具呼叫)時它
          // 對應哪一個。已用真實憑證起 session 實測(sequential Write→Edit、
          // 刻意要求「平行」的 Bash x2、Write 覆寫既有檔、刻意要求「平行」的
          // Read x3——共 4 組情境、7 次工具呼叫),這個 CLI/SDK 版本
          // (claude-agent-sdk 0.3.215)無一例外把每個工具呼叫拆成各自獨立的
          // assistant/user 訊息對,`content` 陣列從未觀察到超過一個
          // tool_result block。但無法保證未來版本、MCP 工具或其他情境永遠
          // 如此,所以仍照 Phase 4 計畫的保守原則:只在這個訊息剛好只有一個
          // tool_result block 時才附加 structuredResult,超過一個(未來若真的
          // 發生)寧可不附加、讓 UI fallback 回原本的 JSON 顯示,不猜測歸屬。
          const toolResultCount = content.filter((block) => isRecord(block) && block.type === "tool_result").length;
          const structuredResult = toolResultCount === 1 ? message.tool_use_result : undefined;
          for (const block of content) {
            if (isRecord(block) && block.type === "tool_result") {
              outputQueue.push({
                type: "tool-result",
                toolCallId: String(block.tool_use_id ?? ""),
                toolName: "",
                output: block.content,
                isError: Boolean(block.is_error),
                structuredResult,
              });
            }
          }
        }
        break;
      }

      case "result": {
        // S3a(usage-metering)§7.5 ⑤:回合末先發用量,再發 completed/error
        // ——與 AcpAdapter.consume() 的「flushUsage() 在 completed 之前」時序
        // 一致。`result` 訊息是這個 SDK 的回合末信號,success 與各種錯誤收場
        // (error_during_execution / error_max_turns / ...)的型別上**都**帶
        // 用量欄位,所以這一條路徑同時涵蓋正常結束與 error/interrupt 收場,
        // 不需要另一條路徑。
        //
        // ⚠️ 但「有欄位」不等於「有值」:實測 interrupt 收場拿到的是
        // `subtype:"error_during_execution"` + `total_cost_usd: 0` +
        // `modelUsage: {}`(該回合被中止,SDK 沒有結算任何用量)。這種空殼
        // result 由 flushUsage() 內的防線擋下不發,見該函式註解。
        this.flushUsage(internal, message);
        if (message.subtype === "success") {
          outputQueue.push({
            type: "completed",
            finalText: message.result,
            durationMs: message.duration_ms,
          });
        } else {
          outputQueue.push({
            type: "error",
            message: `執行結束於錯誤狀態: ${message.subtype}`,
            detail: message.errors?.join("\n"),
          });
        }
        break;
      }

      case "system":
        // 涵蓋 SDKSystemMessage(init)與 SDKCompactBoundaryMessage(subtype
        // 'compact_boundary')— 聊天流程本身 M1 尚未需要處理,但 S6
        // (crash-recovery)這輪新增:'init' 帶的 session_id 是這個後端唯一的
        // 磁碟持久化 session 識別碼,捕捉起來供 `getBackendSessionId()` 回傳
        // (見檔案頂端 §4.1 查證說明)。
        if (message.subtype === "init") {
          internal.backendSessionId = message.session_id;
        }
        break;

      default:
        // SDKMessage 是很大的 union(見上方 TODO 說明),其餘子型別
        // 目前不影響 M1 聊天流程,故略過不轉發。
        break;
    }
  }

  /**
   * S3a(usage-metering)§7.5 ⑤:把 `SDKResultMessage` 的用量欄位轉成
   * `UsageEvent`(packages/shared/src/events.ts,**schema 不變**)。
   *
   * ⚠️ **累計語意的來源選擇(已用真實憑證跑兩輪實測確認,不是照著型別名稱猜)**:
   * `UsageEventSchema` 的契約是「累計、同一條連線內單調遞增」,而
   * `SDKResultMessage` 上的三組數字**語意並不一致**——
   *
   *   | 欄位 | 實測(同一個 query() 連跑兩輪) | 累計? |
   *   |---|---|---|
   *   | `total_cost_usd` | 0.157881 → 0.16590749 | ✅ 累計 |
   *   | `usage`(頂層) | in 2/out 3 → in 2/out 3 | ❌ **只是「這一輪」** |
   *   | `modelUsage[m]` | in 2/out 3 → in 4/out 6 | ✅ 累計 |
   *
   * 所以 token 明細取自 `modelUsage`(跨 model 加總)而**不是**頂層 `usage`
   * ——把 per-turn 的數字填進一個宣告為累計的欄位,就是換一種方式對消費端
   * 說謊(第二輪的 UI 會顯示「累計只用了 2 個 input token」)。`total_cost_usd`
   * 本身已是累計,直接用。
   *
   * `model`:只有在整個 session 自始至終只用過一個 model 時才填(`modelUsage`
   * 恰好一個 key)。中途 `setModel()` 換過 model 時,這一筆累計值橫跨多個
   * model,填任何一個都是錯的 ⇒ 留 undefined。
   *
   * ⚠️ **「這則 result 根本沒有用量資訊」的防線(實測踩到,不是防禦性想像)**:
   * 用真實憑證測 interrupt 路徑時拿到的是
   * `{ subtype: "error_during_execution", total_cost_usd: 0, modelUsage: {} }`
   * ——回合被中止,SDK 沒有結算任何用量(另外也觀察過一則 `subtype:"success"`
   * 但同樣 0 + 空 modelUsage 的 result)。這種空殼 result **不發** `usage`
   * 事件:`costAmount` 是**累計**值,消費端規則是「直接覆寫顯示最新值」,
   * 發一個 0 出去會把先前累積的真實金額瞬間洗成 $0.0000 —— 使用者每按一次
   * 「中斷」就看到花費歸零。「來源這次什麼都沒給」的正解是沉默(與 §3 表格
   * 「cost 一直沒有 → 不發 usage 事件」同一條原則),不是發一個看起來像真的
   * 的 0。
   *
   * 未驗證的邊界:無法從單次觀察區分「錯誤收場的 result 一律回報 0」與「這條
   * session 當下的累計本來就是 0(該回合中止前沒花到錢)」。兩者對這裡的行為
   * 沒有差別(都被上面這條防線擋下),故不再追測,但若之後要做 S3b 的權威
   * rollup,這個區別需要重新確認。
   */
  private flushUsage(internal: InternalSession, message: SDKResultMessage): void {
    const tokens = aggregateModelUsage(message.modelUsage);
    const modelKeys = Object.keys(message.modelUsage ?? {});
    if (modelKeys.length === 0 && !message.total_cost_usd) return; // 完全沒有用量資訊 ⇒ 沉默
    internal.outputQueue.push({
      type: "usage",
      costAmount: message.total_cost_usd,
      costCurrency: "USD", // total_cost_usd 的欄位名稱本身就固定了幣別
      ...tokens,
      ...(modelKeys.length === 1 ? { model: modelKeys[0] } : {}),
    });
  }
}

/**
 * 把 `modelUsage`(每個 model 一筆**累計**用量)加總成單一組 token 明細。
 * 全部欄位都缺(`modelUsage` 是空物件——理論上不會,但 SDK 沒有型別層級的
 * 保證)時回傳空物件,讓 `UsageEvent` 的這些欄位維持 undefined,**不編造成 0**
 * (見 `UsageEventSchema` 的欄位註解:來源沒給就是 undefined)。
 */
function aggregateModelUsage(modelUsage: Record<string, ModelUsage> | undefined): {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
} {
  const entries = Object.values(modelUsage ?? {});
  if (entries.length === 0) return {};
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  for (const u of entries) {
    inputTokens += u.inputTokens ?? 0;
    outputTokens += u.outputTokens ?? 0;
    cacheReadTokens += u.cacheReadInputTokens ?? 0;
    cacheCreationTokens += u.cacheCreationInputTokens ?? 0;
  }
  return { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens };
}

interface InternalSession {
  handle: AgentHandle;
  inputQueue: AsyncQueue<SDKUserMessage>;
  outputQueue: AsyncQueue<AgentEvent>;
  pendingPermissions: Map<string, (result: PermissionResult) => void>;
  /** Phase 7:見 `canUseTool` 內對應特例、`resolveUserDialog()`、`dispose()` 的說明。 */
  pendingAskUserQuestion: Map<string, { resolve: (result: PermissionResult) => void; input: Record<string, unknown> }>;
  sdkQuery: SdkQuery;
  /** SDK 的 `claude` 子程序 handle(見 `spawn()` 內 spawnClaudeCodeProcess 的說明)。 */
  getChild: () => ChildProcess | undefined;
  currentMessageId: string | null;
  /** S6(crash-recovery)L4 §4.1:見檔案頂端查證說明。 */
  backendSessionId: string | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
