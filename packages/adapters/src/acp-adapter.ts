import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import { Readable, Writable } from "node:stream";
import path from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import { structuredPatch } from "diff";
import type { AgentEvent, AgentLaunchSpec, McpBridgeTokenPort, PromptInput, SessionNetworkPort, SlashCommandInfo } from "@deskmony/shared";
import { DeskmonyError, ErrorCodes } from "@deskmony/shared";
import type { AdapterCapabilities, AgentAdapter, AgentHandle, Workspace } from "./types.js";
import { AsyncQueue } from "./async-queue.js";
import { registerChild, registerChildDescendants, unregisterChild } from "./child-registry.js";
import { killProcessTree, waitForChildExit } from "./child-process.js";
import { mintMcpBridgeLaunch } from "./mcp-bridge-launch.js";
import { buildOpencodeConfigContent, OPENCODE_CONFIG_CONTENT_ENV } from "./opencode-config.js";
import { applyOpencodeServerAuth } from "./opencode-server-auth.js";
import { buildAgentChildEnv } from "./agent-env.js";

/**
 * AcpAdapter — 對接 [Agent Client Protocol](https://agentclientprotocol.com)
 * 的 AgentAdapter 實作(ARCHITECTURE.md 3.4 節「一個 adapter 吃多家」)。
 *
 * 對接策略(讀取 node_modules 內 `@agentclientprotocol/sdk@1.2.1` 的
 * `dist/acp.d.ts`、`dist/schema/types.gen.d.ts` 與官方 examples 後確認):
 *  - 這裡扮演 ACP 的 **Client** 角色(agent 是被我們 spawn 出來的子程序)。
 *    用 `acp.client({ name }).onRequest(...).connect(stream)` 建立連線,
 *    `stream` 由 `acp.ndJsonStream()` 包裝子程序的 stdin/stdout(換行分隔
 *    JSON,經 `node:stream/web` 的 `Writable.toWeb`/`Readable.toWeb` 轉接)。
 *  - 連線建立後依序送出 `initialize` 請求、`buildSession(cwd).start()`
 *    (對應 `session/new`),取得的 `ActiveSession` 提供 `prompt()` 送出
 *    使用者訊息、`nextUpdate()` 逐一取出 `session/update` 通知(或該輪
 *    prompt 結束的 `stop` 訊息)。
 *  - `session/update` 的 `agent_message_chunk` → `message-delta`;
 *    `tool_call` → `tool-call`;`tool_call_update`(status 為 completed/
 *    failed 時)→ `tool-result`;`tool_call_update` 帶來新的非空 `rawInput`
 *    (OpenCode 在 `tool_call` 只給 `{}`,真參數隨後才到)時,先對同一個
 *    toolCallId 補送一次 `tool-call`(見 handleSessionUpdate())。ACP 明確帶 `messageId`(不像 Claude SDK
 *    需要自行從 `message_start`/`message_stop` 推斷邊界),但仍比照
 *    ClaudeAgentSdkAdapter 的作法,在 messageId 切換或該輪 `stop` 時補送
 *    一次 `done:true` 的空 delta,確保串流分組規則一致。
 *  - Client 端註冊 `session/request_permission` 的 handler,轉成
 *    `permission-request` AgentEvent 並用 `Map<requestId, resolver>` 掛起,
 *    等待外部呼叫 `resolvePermission()`(語意對齊 ClaudeAgentSdkAdapter 的
 *    `canUseTool`)。ACP 的回覆需要從 agent 提供的 `options`(每個都是
 *    `allow_once`/`allow_always`/`reject_once`/`reject_always` 之一)裡選一個
 *    `optionId`,而不是單純的 boolean,所以要記住每筆請求當下的 `options`。
 *  - `interrupt()` 對應 `session/cancel` 通知;`dispose()` 關閉 ACP 連線、
 *    結束子程序,並讓所有懸置的權限請求以「挑一個 reject 系列的 option
 *    (找不到就回 cancelled)」收場,不讓 agent 的 `requestPermission` 呼叫
 *    永久卡住。
 *
 * 已知限制 / TODO(M2 Round A 範圍):
 *  - 只處理 `ContentBlock.type === "text"`,image/audio/resource(_link)
 *    尚未轉發。
 *  - `session/update` 的 `plan`/`plan_update`/`current_mode_update`/
 *    `config_option_update`/`session_info_update`/`agent_thought_chunk`/
 *    `user_message_chunk` 尚未有對應的 AgentEvent 型別(見
 *    packages/shared/src/events.ts),先略過不轉發。`usage_update` 已在 S3a
 *    (usage-metering)接上(見下方 `handleSessionUpdate()`),
 *    `available_commands_update` 已在這輪(slash command)接上,這裡的清單
 *    同步移除,避免文件與程式碼漂移。
 *  - `diff` 能力(Codex ACP 橋接切換 Phase 3 起回報為 true):
 *    `resolveDiffStructuredResult()` 用兩條路徑合成
 *    `ToolResultEvent.structuredResult`(消費端是既有機制,見
 *    `apps/desktop/src/views/chat/DiffHunkView.tsx` 的 `parseDiffResult()`,
 *    這裡不需要新增任何 AgentEvent 型別)——路徑 A 優先讀取原生
 *    `ToolCallContent` 的 `type: "diff"` 區塊(`{path, oldText, newText}`,
 *    已讀 `@agentclientprotocol/sdk@1.2.1` 的
 *    `dist/schema/types.gen.d.ts` 確認形狀);路徑 A 沒命中時退而求其次走
 *    路徑 B(檔案快照 fallback,對應 `docs/DECISIONS.md` B2):`tool_call`
 *    建立時若 `kind === "edit"` 且 `locations` 有值,先讀一次檔案「呼叫前」
 *    內容存進 `InternalSession.pendingFileSnapshots`,對應的
 *    `tool_call_update` 完成(`completed`/`failed`)時重讀一次同一個檔案當
 *    「呼叫後」,兩者交給 `diff` 套件的 `structuredPatch()` 合成 hunk。讀檔
 *    失敗(檔案不存在以外的錯誤)一律優雅放棄,不影響其餘事件推送。
 *  - `fs.readTextFile`/`fs.writeTextFile`/`terminal.*` 皆回報不支援
 *    (`clientCapabilities` 對應欄位為 false/未設定),agent 若呼叫這些方法
 *    會由 ACP 底層回 JSON-RPC method-not-found。
 */
export class AcpAdapter implements AgentAdapter {
  private readonly sessions = new Map<string, InternalSession>();

  // Phase 2(ACP 掛載 session 網路 MCP 工具):`sessionNetworkPort` 完全比照
  // `ClaudeAgentSdkAdapter` 既有的 `setSessionNetworkPort()` 模式——apps/core 的
  // SessionManager 在啟動時用 setter 事後注入(adapter 建構當下 core 的
  // SessionManager 還沒好,打破建構循環,見 claude-sdk-adapter.ts 同名欄位的
  // 註解)。ACP 這邊 port 本身只當「要不要掛載」的開關(真正的工作由 bridge 子行程經 gateway 打回 core)。
  // `tokenMinter` 是第二個事後注入依賴——見
  // packages/shared/src/mcp-bridge-auth.ts 的 `McpBridgeTokenPort` 完整背景
  // 說明,實例由 apps/core 的 WsGateway 提供。兩者都是 **可選**:`spawn()`
  // 只在 `sessionNetworkPort` 已注入、且 `tokenMinter` 也已注入時,才會核發 token、
  // 掛載 mcp-bridge-server.ts——兩者缺一,行為與這輪之前完全相同(不核發 token、
  // 不多一個子行程)。
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
      // Codex ACP 橋接切換 Phase 3 起改為 true:見下方 resolveDiffStructuredResult()
      // /findDiffBlock()/resolveEditSnapshotPath() 與 handleSessionUpdate() 的
      // "tool_call"/"tool_call_update" case——diff 重建邏輯完全自包含在這個
      // adapter 內部,路徑 A(原生 ToolCallContent 的 type:"diff" 區塊)是額外
      // 加分,路徑 B(檔案快照 fallback:tool_call 建立時、tool_call_update
      // 完成時各讀一次目標檔案內容,不是呼叫外部 `git diff` 指令)保底,兩者
      // 都不依賴被 spawn 的 agent 是否主動配合。這與 `claude-sdk-adapter.ts`
      // 的 `slashCommands: "supported"` 是同一種判斷標準——"adapter 自己保證
      // 做得到",不是"不確定,要看對方送不送事件",所以是單純的 `true`,不需要
      // 像 usageReporting/slashCommands 那樣三態(那些欄位的不確定性來自
      // 「事件會不會被外部 agent 主動送出」,這裡的重建邏輯不假外求,唯一的
      // 失敗模式是讀檔失敗,發生時已經妥善 fallback 成「不附加
      // structuredResult」,不是回報能力卻做不到)。
      //
      // 這個值刻意跟 `claude-sdk-adapter.ts` 的 `diff: false` 不一致——不是
      // 沒同步、是真的不同:那邊的 diff 顯示是被動轉發 SDK 附帶的
      // `structuredPatch`(只在模型剛好呼叫 Edit/Write、且該訊息剛好只有一個
      // tool_result block 時才有,見該檔案 `case "user":` 的 toolResultCount
      // 判斷),沒有這裡路徑 B 這種主動重建的保底,覆蓋率結構上較低——是這輪
      // 計畫「誠實的天花板」一節明確接受的既有落差,不是需要一併修正的不一致。
      diff: true,
      interrupt: true,
      terminal: false,
      // S3a(usage-metering)§7.5 ④ 修正:這兩項**只能是 "unknown"**。
      //
      // 修正前這裡無條件回報 `true`,理由是「handleSessionUpdate() 的
      // "usage_update" case 一律轉發」——但那只證明「**如果** agent 送了這個
      // 通知,我們會正確轉發」,完全不保證 agent 會送。已實測(L4 §7,真實
      // Claude Code 2.1.199 + @zed-industries/claude-code-acp@0.16.2):Claude
      // Code 經 bridge 從頭到尾送 0 個 `usage_update`,而且是結構性的(bridge
      // 的 `case "result":` 把 SDK 給的 total_cost_usd/usage/modelUsage 全部
      // 丟棄,程式碼裡根本沒有送出這個通知的路徑)。同一個 adapter 換成
      // Gemini CLI 則可能照送。
      //
      // ⇒ ACP 這一層真正的事實是「**要連上線、跑過一輪才知道**」,而這正是
      // `"unknown"` 的語意。收斂由消費端用「這條 session 有沒有實際收到過
      // usage/context-usage 事件」完成(見 packages/shared/src/
      // adapter-capabilities.ts 的 `resolveCapabilitySupport()`),在收斂之前
      // UI 不得對使用者宣稱有花費可看。
      usageReporting: "unknown",
      contextReporting: "unknown",
      // 這輪(slash command)新增:同上面 usageReporting/contextReporting 的
      // 理由——要連上線、看實際 spawn 出來的是哪個 ACP agent 才知道會不會送
      // `available_commands_update`(已查證 `@agentclientprotocol/sdk@1.2.1`
      // 型別上這是一個 optional 的 session/update 變體,agent 不一定會送)。
      slashCommands: "unknown",
    };
  }

  async spawn(launch: AgentLaunchSpec, workspace: Workspace): Promise<AgentHandle> {
    const acpConfig = launch.acpConfig;
    const agentLabel = launch.providerId ?? "acp";
    if (!acpConfig) {
      throw new DeskmonyError(
        ErrorCodes.ADAPTER_MISSING_CONFIG,
        { providerId: agentLabel, software: "acp", configField: "command" },
        `agent "${agentLabel}" 的 software="acp" 缺少 acpConfig(command)`,
      );
    }

    // Phase 2(ACP 掛載 session 網路 MCP 工具):`AgentHandle.id` 提前在
    // 這裡生成(這輪之前是等 ACP handshake 成功後才在下面產生)——scoped
    // token 需要綁定「這一個 session」,但核發時機必須在
    // `buildSession().withMcpServer()` 之前(掛進 `session/new` 請求的
    // `mcpServers` 欄位),比 handshake 完成、正式建立 `AgentHandle` 都早,
    // 所以提前生成這個 id,下面 `const handle: AgentHandle = { id: handleId,
    // ... }` 沿用同一個值。
    const handleId = randomUUID();

    const { command, args, useShell } = resolveWindowsSpawnCommand(acpConfig.command, acpConfig.args ?? []);

    // Phase 2:this.sessionNetworkPort(已注入)存在時,核發 scoped token 並算出
    // 要掛載的 mcp-bridge-server.ts 設定——ACP 只有一個統一的 bridge
    // 子行程(見 mcp-bridge-server.ts 檔頭註解),不像 claude-agent-sdk 是
    // in-process 的 MCP server。沒有 sessionNetworkPort 時直接回傳 undefined,
    // 不核發任何 token、不掛任何 MCP server。
    // 2026-10-03:**提前到 spawn 子程序之前**——opencode 家族要在子程序的環境變數裡預先放行三個查詢工具,
    // 必須先知道 bridge 有沒有掛上。核發之後任何一步失敗都要撤銷(見下方 spawn 例外與 catch)。
    const bridgeLaunch = mintMcpBridgeLaunch(
      { sessionNetworkPort: this.sessionNetworkPort, tokenMinter: this.tokenMinter },
      handleId,
      "acp-adapter",
    );

    // `launch.env`(provider 層級 env,由 SessionManager.prepareSpawnSpec() 從
    // settings 讀出併好)疊在 process.env 之上,`acpConfig.env`(既有欄位)最優先
    // ——維持這個既有欄位一直以來的「最終覆寫」語意不變。
    // 2026-10-05(安全):最後一律濾掉 Deskmony 內部憑證(主認證 token、MCP bridge 的 scoped token……)——
    // 否則 agent 的 bash 讀得到 `DESKMONY_AUTH_TOKEN`,連上 gateway 就能自己核准權限/切 YOLO,等於自己拆掉安全罩。
    // bridge 需要的值是下面 `session/new` 的 `mcpServers[].env` 明確交給 bridge 的,不靠繼承。見 agent-env.ts。
    const childEnv: NodeJS.ProcessEnv = buildAgentChildEnv(launch.env, acpConfig.env);
    if (launch.family === "opencode") {
      // opencode 預設所有工具權限都是 allow、不經過 Deskmony 的政策引擎——一律改成全部 ask(default-deny)。
      // 完整理由、設定寫法與實測依據見 opencode-config.ts。掛了 bridge 時三個唯讀查詢工具預先放行。
      childEnv[OPENCODE_CONFIG_CONTENT_ENV] = buildOpencodeConfigContent(childEnv[OPENCODE_CONFIG_CONTENT_ENV], {
        sessionNetwork: bridgeLaunch ? {} : undefined,
        // opencode acp 不會轉發 subagent 子 session 的權限請求 → 子 session 卡死,只能不讓它用 subagent(見該選項註解)。
        denySubagents: true,
      });
      // 2026-10-03(安全):**`opencode acp` 也會在 loopback 開 HTTP 伺服器**(實測 1.18.7:聽 `127.0.0.1:4096`——opencode 的
      // 預設 port,被占用才改隨機;預設無認證,不帶標頭 `GET /config` 回 200)——本機其他程序可以替它核准權限請求、讀設定裡的 token。ACP 這條路
      // Deskmony 不需要打它的 HTTP API(全走 stdio),所以只要設一組隨機密碼讓別人進不去,回傳的標頭值用不到、直接丟棄。
      // 實測帶了密碼 `opencode acp` 照常運作(initialize/session/new/session/prompt 都正常)。理由與覆蓋規則見 opencode-server-auth.ts。
      applyOpencodeServerAuth(childEnv);
    }
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(command, args, {
        cwd: workspace.path,
        env: childEnv,
        stdio: ["pipe", "pipe", "pipe"],
        shell: useShell,
      });
    } catch (err) {
      // spawn 本身同步丟例外(例如 Windows 上 `.cmd` 沒走 shell 的 EINVAL):token 已核發,不能留成孤兒。
      if (bridgeLaunch) this.tokenMinter?.revokeForSession(handleId);
      throw err;
    }
    // 2026-09-04(稽核修補):登記 pid,讓 core 若非正常終止,下次啟動時能回收
    // 這個孤兒。見 packages/adapters/src/child-registry.ts。
    registerChild(child.pid, `acp:${command}`);

    // child 啟動失敗(command 找不到等)會觸發 "error" 而不是 reject 某個
    // promise;把它轉成一個會 reject 的 promise,跟 initialize/newSession
    // 用 Promise.race 賽跑,避免無限期卡在等待子程序回應。
    const spawnFailure = new Promise<never>((_, reject) => {
      child.once("error", (err) => {
        reject(
          new DeskmonyError(
            "adapterProcess.spawnFailed",
            { software: "acp", command, detail: err.message },
            `ACP agent 子程序啟動失敗(command=${command}): ${err.message}`,
          ),
        );
      });
    });
    spawnFailure.catch(() => {
      // 僅用於 Promise.race,避免 Node 印出 unhandled rejection 警告。
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      console.error(`[acp-adapter] ${agentLabel} stderr: ${chunk.toString().trimEnd()}`);
    });

    const outputQueue = new AsyncQueue<AgentEvent>({
      // 2026-09-04(稽核修補):緩衝溢位不靜默丟資料,至少讓它在 log 裡看得見。
      // 見 packages/adapters/src/async-queue.ts 的 DEFAULT_MAX_BUFFERED 註解。
      onOverflow: (dropped) =>
        console.error(
          `[acp] 事件緩衝溢位,已丟棄最舊的 ${dropped} 筆事件 —— 代表這條 session 的產出速度` +
            "遠超過下游消費速度(失控迴圈?超大 tool_result?)。丟舊留新是刻意的:" +
            "否則 completed 事件永遠進不來,session 會卡在 busy。",
        ),
    });
    const pendingPermissions = new Map<string, PendingPermission>();

    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    );

    const clientApp = acp
      .client({ name: "deskmony" })
      .onRequest(acp.methods.client.session.requestPermission, (ctx) => {
        return new Promise<acp.RequestPermissionResponse>((resolve) => {
          const requestId = String(ctx.requestId);
          pendingPermissions.set(requestId, { resolve, options: ctx.params.options });
          outputQueue.push({
            type: "permission-request",
            requestId,
            toolName: ctx.params.toolCall.title ?? ctx.params.toolCall.toolCallId,
            input: ctx.params.toolCall.rawInput,
            description: ctx.params.toolCall.title ?? undefined,
          });
        });
      });

    const connection = clientApp.connect(stream);

    // MCP server 名稱與 in-process 版一致(`deskmony`),agent 看到的工具全名才會是 `mcp__deskmony__<name>`。
    const bridgeMcpServer: acp.McpServer | undefined = bridgeLaunch
      ? {
          name: "deskmony",
          command: bridgeLaunch.command,
          args: bridgeLaunch.args,
          env: Object.entries(bridgeLaunch.env).map(([name, value]) => ({ name, value })),
        }
      : undefined;

    try {
      await Promise.race([
        connection.agent.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
        }),
        spawnFailure,
      ]);

      let sessionBuilder = connection.agent.buildSession(workspace.path);
      if (bridgeMcpServer) {
        sessionBuilder = sessionBuilder.withMcpServer(bridgeMcpServer);
      }
      const session = await Promise.race([sessionBuilder.start(), spawnFailure]);

      // 2026-09-17:handshake 與 session/new 都成功 = 真正的 agent 行程一定已經在
      // 回應了。`child.pid` 可能只是外殼 —— `.cmd` shim 的 cmd.exe、`.ps1` 的
      // powershell.exe,或 codex-acp 那種 node → node(launcher)→ codex.exe 三層
      // (見 codex-acp-locator.ts)。外殼比 agent 先死時,只登記外殼的話下次啟動就
      // 回收不到真正的 agent,所以把它底下當下的子孫也登記起來。刻意不 await
      // (查詢要 1 秒多)。見 child-registry.ts 的 registerChildDescendants()。
      void registerChildDescendants(child.pid);

      const handle: AgentHandle = { id: handleId, launch, workspace };
      const internal: InternalSession = {
        handle,
        child,
        connection,
        session,
        outputQueue,
        pendingPermissions,
        toolTitles: new Map(),
        toolInputs: new Map(),
        currentMessageId: null,
      };
      this.sessions.set(handle.id, internal);

      child.on("exit", (code, signal) => {
        if (!this.sessions.has(handle.id)) return; // dispose() 已經處理過
        outputQueue.push({
          type: "error",
          message: `ACP agent 子程序已結束(code=${code ?? "null"}, signal=${signal ?? "null"})`,
        });
        outputQueue.close();
      });

      void this.consume(internal).catch((err: unknown) => {
        outputQueue.push({
          type: "error",
          message: "ACP session 更新迴圈中斷",
          detail: err instanceof Error ? err.message : String(err),
        });
      });

      return handle;
    } catch (err) {
      // Phase 2:handshake/session/new 失敗時,若已核發過 token,一併撤銷,
      // 避免留下一個永遠用不到的孤兒 grant(不影響既有 TTL 保底,只是提早
      // 清理——這個 session 從未真正建立成功,不會有任何子行程用得到它)。
      if (bridgeMcpServer) {
        this.tokenMinter?.revokeForSession(handleId);
      }
      try {
        connection.close();
      } catch {
        // ignore
      }
      this.killChild(child);
      throw err;
    }
  }

  sendPrompt(handle: AgentHandle, prompt: PromptInput): void {
    const internal = this.mustGet(handle);
    void internal.session.prompt(prompt.text).catch((err: unknown) => {
      internal.outputQueue.push({
        type: "error",
        message: "ACP session/prompt 失敗",
        detail: err instanceof Error ? err.message : String(err),
      });
    });
  }

  events(handle: AgentHandle): AsyncIterable<AgentEvent> {
    return this.mustGet(handle).outputQueue;
  }

  /**
   * ACP 的 `session/cancel` 是單向 notification,協議本身沒有「取消已生效」
   * 的回條(不像 ClaudeAgentSdkAdapter 的 `Query.interrupt()` 有明確語意的
   * resolve 時機,見 packages/adapters/src/types.ts 的 `AgentAdapter.interrupt()`
   * 介面註解)。這裡盡力而為:await notify() 本身送達(stdio 寫入完成),
   * 這只保證「取消請求已送出」,不保證 agent 端已經真正停止該輪 —— 是這個
   * adapter 在 ACP 協議限制下能提供的最佳保證,記錄在此供之後如果 ACP 協議
   * 新增回條時參考。
   */
  async interrupt(handle: AgentHandle): Promise<void> {
    const internal = this.mustGet(handle);
    try {
      await internal.connection.agent.notify(acp.methods.agent.session.cancel, {
        sessionId: internal.session.sessionId,
      });
    } catch {
      // 連線可能已經關閉,忽略。
    }
  }

  async dispose(handle: AgentHandle): Promise<void> {
    const internal = this.sessions.get(handle.id);
    if (!internal) return;
    // Phase 2:這個 session 若曾核發過 scoped MCP bridge token(見 spawn() 的
    // `mintMcpBridgeLaunch()`),session 結束時必須讓它立即失效——不能變成
    // 孤兒憑證一直有效到 24 小時 TTL 才過期。`revokeMcpBridgeTokensForSession()`
    // 對「這個 session 根本沒核發過 token」是安全的 no-op(見
    // apps/core/src/gateway/ws-gateway.ts 的實作),不需要先判斷有沒有核發過。
    this.tokenMinter?.revokeForSession(handle.id);
    // 懸置的權限請求(agent 端 requestPermission 呼叫的 Promise)若放著不管
    // 會讓 agent 子程序永久卡住等回應 —— 一律以「拒絕」收場後再清空。
    for (const pending of internal.pendingPermissions.values()) {
      pending.resolve(buildPermissionResponse(pending.options, "deny"));
    }
    internal.pendingPermissions.clear();
    internal.lastCost = undefined;
    internal.outputQueue.close();
    try {
      internal.session.dispose();
    } catch {
      // ignore
    }
    try {
      internal.connection.close();
    } catch {
      // ignore
    }
    this.killChild(internal.child);
    // S8 迴歸修正:`killChild()` 只是「送出終止指令」,不保證子程序已經真的死掉。
    // 在 Windows 上,行程要再過數十毫秒才會釋放它對 cwd(= 任務 worktree)的
    // 佔用 —— 若 dispose() 在此之前就 resolve,呼叫端(原任務刪除流程,
    // 2026-10-02 已移除,見 docs/DECISIONS.md §H)會立刻 `git worktree remove`,撞上
    // `Permission denied` / `EBUSY: resource busy or locked`。這個時序漏洞當時是
    // 由 e2e-gateway 步驟 15e 暴露出來的,修正本身(等子程序真正退出)仍然有效。
    // 這裡等子程序真正 exit(上限 3 秒;逾時就放棄等待,讓呼叫端既有的重試機制
    // 接手,絕不因為等不到而卡住 dispose)。
    await waitForChildExit(internal.child, 3_000);
    // 2026-09-04(稽核修補):已乾淨收掉,不需要下次啟動時回收。
    unregisterChild(internal.child.pid);
    this.sessions.delete(handle.id);
  }

  resolvePermission(handle: AgentHandle, requestId: string, decision: "allow" | "deny"): void {
    const internal = this.mustGet(handle);
    const pending = internal.pendingPermissions.get(requestId);
    if (!pending) return;
    internal.pendingPermissions.delete(requestId);
    pending.resolve(buildPermissionResponse(pending.options, decision));
  }

  /**
   * M5 Round C:ACP 協議的 `session/new`/`session/prompt` 沒有 model 參數,
   * model 完全由被 spawn 出來的外部 agent/CLI 自行決定與管理,呼叫端(我們)
   * 沒有介面可以介入——明確拋出錯誤,不可靜默忽略成功(見
   * packages/adapters/src/types.ts 的 `AgentAdapter.setModel()` 介面註解)。
   */
  async setModel(handle: AgentHandle): Promise<void> {
    this.mustGet(handle); // 驗證 handle 有效(未知 handle 仍應先報這個錯,而非「不支援」)
    throw new DeskmonyError(
      ErrorCodes.ADAPTER_UNSUPPORTED_OPERATION,
      { software: "acp", operation: "setModel" },
      'software="acp" 不支援變更 model(model 由外部 agent/CLI 自行管理,ACP 協議未提供對應機制)',
    );
  }

  /**
   * 比照上面的 `setModel()`:ACP 協議的 `session/new`/`session/prompt` 沒有
   * effort/reasoning 參數,思考程度完全由被 spawn 出來的外部 agent/CLI 自行
   * 決定與管理,呼叫端(我們)沒有介面可以介入——明確拋出錯誤,不可靜默
   * 忽略成功(見 packages/adapters/src/types.ts 的 `AgentAdapter.setEffort()`
   * 介面註解)。
   */
  async setEffort(handle: AgentHandle): Promise<void> {
    this.mustGet(handle); // 驗證 handle 有效(未知 handle 仍應先報這個錯,而非「不支援」)
    throw new DeskmonyError(
      ErrorCodes.ADAPTER_UNSUPPORTED_OPERATION,
      { software: "acp", operation: "setEffort" },
      'software="acp" 不支援變更思考程度(思考程度由外部 agent/CLI 自行管理,ACP 協議未提供對應機制)',
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

  /**
   * shell:true 時 child.pid 是 cmd.exe 的 pid,直接 kill() 殺不到底下真正的
   * agent 程序 —— 一律走共用的 `killProcessTree()`(Windows 上是
   * `taskkill /T /F`,與 scripts/e2e-gateway.mjs 的 killProcessTree 作法一致)。
   */
  private killChild(child: ChildProcessWithoutNullStreams): void {
    killProcessTree(child);
  }

  private async consume(internal: InternalSession): Promise<void> {
    const { session, outputQueue } = internal;
    for (;;) {
      let message: acp.ActiveSessionMessage;
      try {
        message = await session.nextUpdate();
      } catch {
        // 連線已關閉(dispose() 或子程序結束) —— 結束迴圈。
        break;
      }
      if (message.kind === "stop") {
        this.flushCurrentMessage(internal);
        // S3a(usage-metering)L4 §2:回合末發一次累計花費,在 completed/error
        // 事件之前——涵蓋 refusal(錯誤收場)與 cancelled(session/cancel
        // 觸發的 interrupt 收場,兩者都會走到這個分支,見 StopReason 型別)兩種
        // 「以 error/interrupt 收場」的情況,盡力補發 internal.lastCost。
        this.flushUsage(internal);
        if (message.stopReason === "refusal") {
          outputQueue.push({
            type: "error",
            message: `ACP agent 拒絕執行此回合(stopReason=refusal)`,
          });
        } else {
          outputQueue.push({ type: "completed" });
        }
        continue;
      }
      // Codex ACP 橋接切換 Phase 3(diff 顯示):handleSessionUpdate() 的
      // "tool_call"/"tool_call_update" case 這輪起需要 await 檔案讀取(路徑 B
      // 的 before/after 快照,見該方法與 resolveDiffStructuredResult() 註解)
      // ——改成 await 確保同一個 toolCallId 的 tool_call → tool_call_update
      // 一定依序處理完才讀下一則 session/update,不會有「快照還沒讀完,
      // completed 就先到」的競速。其餘不需要 async 工作的 case(文字增量、
      // usage_update 等)只是多一次 microtask 排程,不影響既有行為。
      await this.handleSessionUpdate(internal, message.notification.update);
    }
    outputQueue.close();
  }

  private async handleSessionUpdate(internal: InternalSession, update: acp.SessionUpdate): Promise<void> {
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        this.pushTextChunk(internal, update);
        break;
      case "tool_call": {
        internal.toolTitles.set(update.toolCallId, update.title);
        // 記下這次送出的 input,`tool_call_update` 補送參數時才分得出「帶來新資訊」
        // 還是「只是把同一份再報一次」(見下方 "tool_call_update" case 的註解)。
        internal.toolInputs.set(update.toolCallId, serializeToolInput(update.rawInput));
        internal.outputQueue.push({
          type: "tool-call",
          toolCallId: update.toolCallId,
          toolName: update.title,
          input: update.rawInput,
        });
        // diff 顯示路徑 B(檔案快照 fallback)前半段:見 resolveEditSnapshotPath()
        // 的查證註解——只有「kind === "edit" 且有 locations」時才值得預先讀檔。
        // `pendingFileSnapshots` 是 InternalSession 上的**選填**欄位(故意不放進
        // spawn() 建立 internal 物件時的初始化清單,這輪不動 spawn() 的簽章或
        // 內容,避免跟同時進行的 subagent MCP 掛載那個 Phase 衝突),
        // 這裡用 `??=` 在第一次真的需要時才 lazily 建立。
        const snapshotPath = resolveEditSnapshotPath(update.kind, update.locations, internal.handle.workspace.path);
        if (snapshotPath) {
          const before = await readFileSnapshot(snapshotPath);
          // undefined = 讀檔失敗(非「檔案不存在」的其他錯誤,見
          // readFileSnapshot() 註解)——放棄這次快照,不寫入 Map,tool_call_update
          // 完成時會因為找不到 pending entry 而自然 fallback 成「兩條路徑都沒
          // 命中」,不會拋錯或中斷事件推送。
          if (before !== undefined) {
            (internal.pendingFileSnapshots ??= new Map()).set(update.toolCallId, { path: snapshotPath, before });
          }
        }
        break;
      }
      case "tool_call_update": {
        const terminal = update.status === "completed" || update.status === "failed";
        // 補送工具參數。OpenCode(1.18.7 實測)的 `tool_call`(`pending`)帶的
        // `rawInput` 是空物件 `{}` 佔位,真正的參數要到後續的 `tool_call_update`
        // (`in_progress`,完成時的 `completed` 也會再帶一次)才有。過去只在
        // `tool_call` 送一次 `tool-call`、`tool_call_update` 完全不讀 `rawInput`,
        // 所以工具確實收到參數(例如 `send_to_session` 的訊息真的送達),歷史與 UI
        // 卻都記成 `"input":{}`。
        //
        // 修法是同一個 toolCallId 再送一次 `tool-call`(補資訊,語意見
        // `ToolCallEventSchema` 註解):core 依 toolCallId 就地更新那筆 call 且不
        // 重複計入回合硬上限,桌面端以 toolCallId upsert。條件刻意用「input 有內容
        // 且與上次送出的不同」而不看 status——`in_progress` 的 update 帶參數也要送,
        // 而 codex 之類每次 update 都把同一份 `rawInput` 原樣再報的 agent 不會因此
        // 每則 update 多一個事件。必須排在同一個呼叫的 `tool-result` 之前
        // (core 在收到 result 後就把 toolCallId 視為已結束,之後再來一個 `tool-call`
        // 會被當成新的呼叫重複計數),所以終態之後 `toolInputs` 記成 `null`、不再補送。
        const lastInput = internal.toolInputs.get(update.toolCallId);
        if (lastInput !== null && isInformativeToolInput(update.rawInput)) {
          const serialized = serializeToolInput(update.rawInput);
          if (serialized !== lastInput) {
            // update 帶了新 title 就更新記下的 title(tool-result 的 toolName 也會跟著用它),
            // 否則沿用 `tool_call` 時記下的。
            const toolName = update.title || internal.toolTitles.get(update.toolCallId) || "";
            if (toolName) internal.toolTitles.set(update.toolCallId, toolName);
            internal.toolInputs.set(update.toolCallId, serialized);
            internal.outputQueue.push({
              type: "tool-call",
              toolCallId: update.toolCallId,
              toolName,
              input: update.rawInput,
            });
          }
        }
        if (terminal) {
          // 終態:同一個 toolCallId 之後不會再有合法的 update(見
          // `resolveDiffStructuredResult()` 註解)。改記成 `null` 而不是刪除——
          // 刪掉的話,萬一後端終態之後又送一則帶 `rawInput` 的 update,會被當成「從沒
          // 送過」而補送,在 core 變成一次多餘的新呼叫。順手把可能很大的參數字串釋放掉。
          internal.toolInputs.set(update.toolCallId, null);
          const structuredResult = await this.resolveDiffStructuredResult(internal, update);
          internal.outputQueue.push({
            type: "tool-result",
            toolCallId: update.toolCallId,
            toolName: internal.toolTitles.get(update.toolCallId) ?? update.title ?? "",
            output: update.rawOutput ?? update.content,
            isError: update.status === "failed",
            // undefined 時完全不附加這個欄位(而不是顯式 `structuredResult:
            // undefined`)——比照 events.ts 對 `z.unknown().optional()` 的既有
            // 慣例,消費端(DiffHunkView.parseDiffResult())兩者處理結果相同,
            // 但省略更貼近「這個 adapter 這次沒有 diff 資訊可給」的語意。
            ...(structuredResult ? { structuredResult } : {}),
          });
        }
        break;
      }
      /**
       * S3a(usage-metering)L4 §2:ACP 的 `UsageUpdate = { used, size, cost? }`
       * ——`used`/`size` 是 context 窗口計量表(gauge,每次都發,便宜且 S8 的
       * context 閾值判斷需要它),`cost` 是可能缺席的累計花費,先存起來,實際
       * 發送 `usage` 事件的時機是回合末(見上方 consume() 迴圈的 flushUsage()
       * 呼叫),不是每次 usage_update 都發(L4 §2:Phase 1 才會改成逐次發)。
       */
      case "usage_update": {
        const u = update;
        internal.outputQueue.push({ type: "context-usage", used: u.used, size: u.size });
        if (u.cost) {
          internal.lastCost = { amount: u.cost.amount, currency: u.cost.currency };
        }
        break;
      }
      /**
       * 這輪(slash command)新增:agent 主動告知/更新可用的 "/" 指令清單
       * (已查證 `@agentclientprotocol/sdk@1.2.1` 的 `AvailableCommandsUpdate =
       * { availableCommands: Array<AvailableCommand> }`)。**REPLACE 語意**
       * ——`availableCommands` 每次都是完整清單,不是增量,原樣整份轉發即可,
       * 見 events.ts 的 `AvailableCommandsEventSchema` 註解。
       */
      case "available_commands_update":
        internal.outputQueue.push({ type: "available-commands", commands: mapAvailableCommands(update.availableCommands) });
        break;
      default:
        // user_message_chunk / agent_thought_chunk / plan* / 其餘擴充型別:
        // M2 Round A 的 AgentEvent 尚未涵蓋,略過不轉發(見上方 class 註解的 TODO)。
        break;
    }
  }

  /**
   * Codex ACP 橋接切換 Phase 3(diff 顯示):completed/failed 的
   * `tool_call_update` 嘗試合成 `ToolResultEvent.structuredResult`。路徑 A
   * (原生 diff 內容區塊)優先於路徑 B(檔案快照 fallback)——見檔案開頭 class
   * 註解與 `capabilities()` 的 `diff: true` 理由段落。回傳 `undefined` 代表
   * 兩條路徑都沒有命中(或路徑 B 讀檔失敗),呼叫端維持現有行為,不附加
   * `structuredResult`。
   *
   * 不論最終走哪條路徑,這個 `toolCallId` 的 `pendingFileSnapshots` entry
   * 到這裡都已經沒用了——`completed`/`failed` 是 `ToolCallStatus` 的終態
   * (已讀 types.gen.d.ts 確認 `ToolCallStatus = "pending" | "in_progress" |
   * "completed" | "failed"`,ACP 協議不會再對同一個 toolCallId 送出新的
   * `tool_call_update`),故統一在此刪除,避免長時間 session 的
   * `pendingFileSnapshots`(存的是檔案全文,不是短字串)只增不減。
   */
  private async resolveDiffStructuredResult(
    internal: InternalSession,
    update: acp.ToolCallUpdate,
  ): Promise<DiffStructuredResult | undefined> {
    const pending = internal.pendingFileSnapshots?.get(update.toolCallId);
    internal.pendingFileSnapshots?.delete(update.toolCallId);

    const diffBlock = findDiffBlock(update.content);
    if (diffBlock) {
      // Diff.oldText 是 `string | null | undefined`——`null`/缺席代表「呼叫前
      // 不存在這個檔案」(已讀 types.gen.d.ts 的欄位註解「The original content
      // (None for new files)」確認),與路徑 B 對 ENOENT 的處理(視為空字串)
      // 語意一致,故同樣 coalesce 成 `""`。
      return buildDiffStructuredResult(diffBlock.path, diffBlock.oldText ?? "", diffBlock.newText);
    }

    if (!pending) return undefined;
    const after = await readFileSnapshot(pending.path);
    if (after === undefined) return undefined; // 讀檔失敗(非 ENOENT):優雅放棄,見 readFileSnapshot() 註解
    return buildDiffStructuredResult(pending.path, pending.before, after);
  }

  private pushTextChunk(
    internal: InternalSession,
    update: { content: acp.ContentBlock; messageId?: string | null },
  ): void {
    if (update.content.type !== "text") return; // image/audio/resource(_link):M2 Round A 尚未處理
    const incomingId = update.messageId ?? internal.currentMessageId ?? randomUUID();
    if (internal.currentMessageId && internal.currentMessageId !== incomingId) {
      internal.outputQueue.push({
        type: "message-delta",
        messageId: internal.currentMessageId,
        role: "assistant",
        delta: "",
        done: true,
      });
    }
    internal.currentMessageId = incomingId;
    internal.outputQueue.push({
      type: "message-delta",
      messageId: incomingId,
      role: "assistant",
      delta: update.content.text,
      done: false,
    });
  }

  private flushCurrentMessage(internal: InternalSession): void {
    if (internal.currentMessageId) {
      internal.outputQueue.push({
        type: "message-delta",
        messageId: internal.currentMessageId,
        role: "assistant",
        delta: "",
        done: true,
      });
      internal.currentMessageId = null;
    }
  }

  /**
   * S3a(usage-metering)L4 §2/§3:回合末(completed/refusal/cancelled 共用的
   * "stop" 分支)發出目前累計花費。`internal.lastCost` 從未被設過(這個後端
   * 一直沒有回報過 `cost`,ACP 的 `cost` 是 optional)時什麼都不做——切片
   * 刻意不猜、不估(見 L4 §3 的表格:「cost 一直沒有 → 不發 usage 事件」)。
   */
  private flushUsage(internal: InternalSession): void {
    if (!internal.lastCost) return;
    internal.outputQueue.push({
      type: "usage",
      costAmount: internal.lastCost.amount,
      costCurrency: internal.lastCost.currency,
    });
  }
}

interface PendingPermission {
  resolve: (response: acp.RequestPermissionResponse) => void;
  options: acp.PermissionOption[];
}

interface InternalSession {
  handle: AgentHandle;
  child: ChildProcessWithoutNullStreams;
  connection: acp.ClientConnection;
  session: acp.ActiveSession;
  outputQueue: AsyncQueue<AgentEvent>;
  pendingPermissions: Map<string, PendingPermission>;
  /** toolCallId -> 建立時的 title,tool_call_update 有時不會重複帶 title。 */
  toolTitles: Map<string, string>;
  /**
   * toolCallId -> 最近一次送出 `tool-call` 事件時的 input(JSON 字串),
   * `tool_call_update` 靠它判斷要不要補送參數(見 handleSessionUpdate() 的註解)。
   * 呼叫進入終態(completed/failed)後記成 `null`:不再補送。
   */
  toolInputs: Map<string, string | null>;
  currentMessageId: string | null;
  /**
   * S3a(usage-metering)L4 §2:最近一次從 `usage_update` 拿到的累計花費
   * (`cost` 存在時才更新)。`undefined` 代表這個連線至今尚未收到過 `cost`
   * ——ACP 的 `cost` 是 optional,可能整個 session 都不回報。
   */
  lastCost?: { amount: number; currency: string };
  /**
   * Codex ACP 橋接切換 Phase 3(diff 顯示)路徑 B(檔案快照 fallback)用:
   * toolCallId -> 該工具呼叫執行前讀到的檔案內容快照
   * (`resolveEditSnapshotPath()` 判斷為檔案編輯類、且成功讀到內容時才會有
   * 記錄)。`tool_call_update` 完成時若這裡有對應記錄、且路徑 A(原生 diff
   * 內容區塊)沒有命中,就重新讀一次同一個檔案當作 after,合成 diff——見
   * `resolveDiffStructuredResult()`。用完(不論成功與否)一律刪除對應
   * entry,避免長時間 session 累積大量檔案全文在記憶體裡。
   *
   * **選填、預設不存在**(而不是比照 `toolTitles` 在 `spawn()` 建構
   * `InternalSession` 時就初始化成空 Map)——這輪明確不動 `spawn()` 的簽章或
   * 內容(避免跟同時進行的「ACP 掛載 subagent MCP」那個 Phase 的
   * 改動衝突),改成在 `handleSessionUpdate()` 第一次真的需要寫入時用
   * `??=` lazily 建立,行為上與「一開始就是空 Map」完全等價。
   */
  pendingFileSnapshots?: Map<string, { path: string; before: string }>;
}

/**
 * `apps/desktop/src/views/chat/DiffHunkView.tsx` 的 `parseDiffResult()`
 * 期待的 `ToolResultEvent.structuredResult` 形狀——這裡不 import 那個檔案
 * (packages/* 不得依賴 apps/*,見 packages/adapters/src/types.ts 開頭的既有
 * 依賴方向規則),純粹複製欄位名稱維持形狀一致。`structuredPatch` 元素形狀
 * 直接借用 `diff` 套件 `structuredPatch()` 回傳值的 `hunks` 元素型別
 * (`ReturnType` 取的是這個多載函式的最後一個簽章,即下面
 * `buildDiffStructuredResult()` 實際呼叫的那個),不手動重複宣告欄位,兩邊
 * 型別自動保持同步。
 */
interface DiffStructuredResult {
  filePath: string;
  structuredPatch: ReturnType<typeof structuredPatch>["hunks"];
}

/**
 * 在一組 `ToolCallContent[]` 裡找第一個 `type:"diff"` 的區塊。已讀
 * node_modules 內 `@agentclientprotocol/sdk@1.2.1` 的
 * `dist/schema/types.gen.d.ts` 確認:
 *   `ToolCallContent = (Content & {type:"content"}) | (Diff & {type:"diff"})
 *                     | (Terminal & {type:"terminal"})`
 *   `Diff = { path: string; oldText?: string | null; newText: string;
 *             _meta?: {[key:string]: unknown} | null }`
 * `_meta` 是 ACP 的通用擴充欄位,這個 adapter 其餘地方一律不處理,這裡比照
 * 辦理。一則 `tool_call_update` 的 `content?: Array<ToolCallContent> | null`
 * 理論上可以同時帶多個 content block,但 `DiffResult`/
 * `ToolResultEvent.structuredResult` 的既有形狀只能表達單一檔案的 diff,取
 * 第一個命中的 `type:"diff"` 區塊即可,不嘗試合併多個。
 */
/**
 * `rawInput` 是否帶有實際內容:`undefined`/`null`/空物件/空陣列/空字串都是「還不知道
 * 參數」的佔位(OpenCode 的 `tool_call` 就是送 `{}`),不值得補送一次 `tool-call`。
 * 一個真的不帶參數的工具,input 停在第一次送的 `{}` 即可,不受影響。
 */
function isInformativeToolInput(input: unknown): boolean {
  if (input === undefined || input === null) return false;
  if (typeof input === "string") return input.length > 0;
  if (Array.isArray(input)) return input.length > 0;
  if (typeof input === "object") return Object.keys(input).length > 0;
  return true;
}

/** 供「這次的 input 和上次送出的一樣嗎」比對用;`rawInput` 來自 JSON-RPC,必定可序列化。 */
function serializeToolInput(input: unknown): string {
  return JSON.stringify(input) ?? "undefined";
}

function findDiffBlock(content: acp.ToolCallContent[] | null | undefined): acp.Diff | undefined {
  return content?.find((c): c is acp.Diff & { type: "diff" } => c.type === "diff");
}

/**
 * 把一組 before/after 全文丟進 `diff` 套件的 `structuredPatch()` 合成
 * `DiffHunkView.parseDiffResult()` 期待的 hunk 陣列。已讀 node_modules 內
 * `diff@9.0.0`(`packages/adapters/package.json` 這輪新增的相依,無需
 * `@types/diff`——這個套件自 v5 起自帶型別宣告,`package.json` 的 `exports`/
 * `types` 欄位都指向套件自己的 `.d.ts`)的
 * `libesm/patch/create.d.ts`/`libesm/types.d.ts` 確認:
 *   - 簽章:`structuredPatch(oldFileName, newFileName, oldStr, newStr,
 *     oldHeader?, newHeader?, options?): StructuredPatch`——後三個參數全部
 *     optional,四參數呼叫合法。
 *   - `StructuredPatch.hunks` 元素形狀是 `{oldStart, oldLines, newStart,
 *     newLines, lines: string[]}`——與 `DiffHunkView.DiffHunk` 逐欄位同名同
 *     型別,不需要任何欄位改名/轉換。
 *   - 實測(node 腳本直接呼叫,結果記錄於此,腳本本身已刪除未進版控):
 *     `lines` 陣列每個元素已經帶好 `+`/`-`/`(空白)` 前綴(新增行 `+xxx`、
 *     刪除行 `-xxx`、context 行 ` xxx`,以及 `\ No newline at end of file`
 *     這種以反斜線開頭的中性 metadata 行),與 `DiffLine`
 *     (`DiffHunkView.tsx`)靠 `line.charAt(0)` 判斷顏色的既有邏輯完全吻合,
 *     不需要額外加前綴。
 *   - `oldStr` 為空字串(新建檔案)時,`hunks` 是單一個 `oldStart:1,
 *     oldLines:0` 的全綠 hunk;`newStr` 為空字串(檔案被刪除)時反過來全紅;
 *     兩者相同或都空時 `hunks` 是空陣列(對應 `DiffHunkView` 的「沒有變更」
 *     分支)。
 */
function buildDiffStructuredResult(filePath: string, oldText: string, newText: string): DiffStructuredResult {
  const patch = structuredPatch(filePath, filePath, oldText, newText);
  return { filePath, structuredPatch: patch.hunks };
}

/**
 * 路徑 B(檔案快照 fallback)第一步:判斷一個剛建立的 `tool_call` 是否值得
 * 在執行前先讀一次目標檔案內容。已讀 types.gen.d.ts 確認
 * `ToolKind = "read" | "edit" | "delete" | "move" | "search" | "execute" |
 * "think" | "fetch" | "switch_mode" | "other"`——只在 `kind === "edit"`(語意
 * 上唯一對應「這個工具呼叫的目的是修改檔案內容」的值;"delete"/"move" 是
 * 結構性操作而非內容變更,合成 content diff 沒有意義;"read"/"search" 等
 * 即使帶 `locations` 也只是「牽涉到」而非「即將修改」該檔案,若照樣預先讀檔
 * 會讓每個帶 location 的唯讀工具呼叫都多一次不必要的檔案 I/O)且 `locations`
 * 至少有一筆記錄時才觸發。
 *
 * 刻意不嘗試從 `rawInput`(型別是 `unknown`,沒有跨工具通用的欄位名稱可言)
 * 猜測路徑——`locations` 是 ACP 協議明訂、有型別保證的欄位
 * (`ToolCallLocation = {path: string; line?: number | null; _meta?: ...}`),
 * `rawInput` 的形狀完全由個別工具自訂,沒有穩定可靠的方式能通用地抽出
 * 「檔案路徑」。多個 `locations` 時只取第一筆——`DiffResult`/
 * `ToolResultEvent.structuredResult` 的既有形狀只支援單一檔案。
 *
 * **安全審查補強**:`locations[0].path` 完全由被 spawn 的外部 ACP agent
 * (codex-acp/gemini)回報,不是 Deskmony 自己產生的值。這裡新增
 * `workspaceRoot` 參數、用 `isWithinWorkspace()` 把它限制在這個 session 自己
 * 的 workspace 目錄內才會去讀——真正透過 `Edit`/`Write` 一類受權限政策管控
 * 的工具去改動 workspace 外的檔案,理當會先經過 `permission-request`(見
 * `canUseTool`/policy-engine.ts 的既有把關,含 `~/.ssh`/`.env`/憑證庫等秘密
 * 路徑的硬性 deny,docs/DECISIONS.md C5);但這裡的檔案快照走的是另一條路徑
 * ——由 `tool_call`/`tool_call_update` 這個**通知**(不是需要核可的請求)驅動,
 * 結構上完全繞過那層審核。即使被 spawn 的 agent 本來就有相同 OS 使用者權限
 * 能直接讀那些檔案(這裡不是在擋一個「原本讀不到」的能力),把 workspace
 * 外的內容順手讀出來、diff 過後推播並落地存進聊天紀錄,仍然是這條新路徑不該
 * 額外多開的門,故加上邊界檢查,對齊既有「未分類/未審視過的操作預設不做」
 * 這條原則(DECISIONS C2)。
 */
function resolveEditSnapshotPath(
  kind: acp.ToolKind | null | undefined,
  locations: acp.ToolCallLocation[] | null | undefined,
  workspaceRoot: string,
): string | undefined {
  if (kind !== "edit") return undefined;
  const candidate = locations?.[0]?.path;
  if (!candidate || !isWithinWorkspace(candidate, workspaceRoot)) return undefined;
  return candidate;
}

/**
 * `candidatePath` 是否落在 `workspaceRoot` 目錄之內(含 workspaceRoot 本身)。
 * 兩者都先 `path.resolve()` 正規化(處理 `..`/相對路徑),再用 `path.relative()`
 * 判斷——結果以 `..` 開頭代表跳出目錄樹;Windows 上兩個路徑分屬不同磁碟機
 * (例如 root 在 `C:\...`、candidate 在 `D:\...`)時 `path.relative()` 會直接
 * 回傳一個絕對路徑而非以 `..` 開頭的相對路徑,故額外用 `path.isAbsolute()`
 * 補這個情況,兩個條件缺一不可。
 */
function isWithinWorkspace(candidatePath: string, workspaceRoot: string): boolean {
  const root = path.resolve(workspaceRoot);
  const resolved = path.resolve(root, candidatePath);
  const relative = path.relative(root, resolved);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * 讀取檔案目前內容,供路徑 B 的 before/after 快照使用。`ENOENT`(檔案不
 * 存在)視為合法情況——快照前讀到 ENOENT 代表這是一個「即將被建立」的新
 * 檔案,回傳空字串,比照 `diff` 套件與路徑 A(`Diff.oldText` 的 `null`/
 * 缺席同樣代表新檔案)對「新檔案」的一致慣例;其餘錯誤(權限不足、路徑其實
 * 是目錄等)一律回傳 `undefined`,呼叫端據此放棄這次快照,不讓一次讀檔失敗
 * 中斷整個 session/update 事件推送迴圈(`NodeJS.ErrnoException.code` 的查法
 * 比照 apps/core/src/config/load-config.ts 的既有慣例)。
 */
async function readFileSnapshot(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    return undefined;
  }
}

function pickPermissionOptionId(
  options: acp.PermissionOption[],
  decision: "allow" | "deny",
): string | undefined {
  const preferredKinds: acp.PermissionOptionKind[] =
    decision === "allow" ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
  for (const kind of preferredKinds) {
    const found = options.find((o) => o.kind === kind);
    if (found) return found.optionId;
  }
  return options[0]?.optionId;
}

function buildPermissionResponse(
  options: acp.PermissionOption[],
  decision: "allow" | "deny",
): acp.RequestPermissionResponse {
  const optionId = pickPermissionOptionId(options, decision);
  return optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } };
}

/**
 * 這輪(slash command)新增:`AvailableCommand{name,description,input?:{hint}}`
 * → `SlashCommandInfo`。**`description` 在 ACP 型別上是必填字串,不是
 * optional**(已讀 `@agentclientprotocol/sdk@1.2.1` 的型別宣告確認),但可能是
 * 空字串,故用 `|| undefined` coalescing,避免 UI 顯示一段空白說明文字。
 */
function mapAvailableCommands(commands: acp.AvailableCommand[]): SlashCommandInfo[] {
  return commands.map((c) => ({
    name: c.name,
    description: c.description || undefined,
    argumentHint: c.input?.hint || undefined,
  }));
}

/**
 * Windows 上,PATH 內以 `.cmd`/`.bat` 包裝的執行檔(例如 npm/npx 全域安裝的
 * shim,像 `gemini.cmd`)不是原生 PE 執行檔,`child_process.spawn` 在不帶
 * `shell: true` 的情況下無法直接執行它們 —— 較新版本的 Node.js(修補
 * CVE-2024-27980 之後)會在偵測到目標是 `.cmd`/`.bat` 時直接丟出
 * `EINVAL`,而不是像舊行為那樣靜默失敗或退化。這裡曾經有一個 bug:舊版
 * `resolveWindowsSpawnCommand()` 用一個正規式同時比對副檔名與
 * `path.isAbsolute()`,導致 `.cmd`/`.bat`(不論絕對或相對路徑)被錯誤分類到
 * `useShell: false` 分支,實際 spawn 時必定丟出 `EINVAL`(已用暫存 `.cmd`
 * wrapper 重現,見 acpFakeAgentSmokeTest 旁的 `.cmd` shim e2e 案例)。
 *
 * 修正後的分類規則(依副檔名優先判斷,不再讓「是否為絕對路徑」蓋過副檔名):
 *   - `.ps1`:一律不使用 `shell: true`(PowerShell 執行原則/單引號轉義在
 *     `cmd.exe` 之下規則複雜、容易出錯),改為直接呼叫
 *     `powershell.exe -NoProfile -ExecutionPolicy Bypass -File <script> <args...>`
 *     —— `powershell.exe` 本身是原生執行檔,不需要 shell,且 Node 在
 *     `shell: false` 時會自動幫每個 args 陣列元素做正確的 Windows 命令列
 *     跳脫(已實測驗證:含空白的參數會被正確還原成單一參數,不會被
 *     `cmd.exe` 的天真空白分割打散)。
 *   - `.cmd` / `.bat`:必須 `shell: true` 才能正確 spawn。Node 的
 *     `shell: true` 在 Windows 上*不會*自動幫 args 陣列的每個元素加引號
 *     (實測:含空白的參數會被 `cmd.exe` 依空白拆成多個參數),所以這裡手動
 *     用 `quoteWindowsShellArg()` 幫 command 與每個 arg 加上雙引號(必要時
 *     才加,並跳脫內部雙引號),涵蓋「command 本身路徑含空白目錄」與「args
 *     含空白」兩種情況。
 *   - `.exe`,或副檔名為空但已是絕對路徑(視為原生執行檔):不需要 shell。
 *   - 其餘(副檔名不明的 PATH 相對名稱,例如使用者只填 `"gemini"`,實際
 *     PATH 上解析到的是 `gemini.cmd`):spawn 前無法確定真正副檔名,沿用
 *     `shell: true` 交給 `cmd.exe` 依 `PATHEXT` 規則解析(維持與 M2 Round A
 *     相同的既有行為),同樣做手動 quoting。
 *
 * 非 Windows 平台一律不需要 shell、不需要額外 quoting(POSIX shell 語意不同,
 * `child_process.spawn` 在 `shell: false` 時已經是安全的做法)。
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

  // .cmd / .bat,或副檔名不明的 PATH 相對名稱:都需要 shell:true 才能正確
  // 解析執行,且都需要手動 quoting(見上方函式註解)。
  return {
    command: quoteWindowsShellArg(command),
    args: args.map(quoteWindowsShellArg),
    useShell: true,
  };
}

/**
 * 幫一個字串在需要時加上雙引號,供 `shell: true` 下傳給 `cmd.exe` 的
 * command/args 使用(Node 在 shell 模式不會自動處理這件事,見上方函式註解)。
 * 只處理「含空白字元或雙引號時才加引號」與「內部雙引號用兩個雙引號跳脫」
 * 這兩條 `cmd.exe` 的基本規則,不是完整的 `cmd.exe` metacharacter 跳脫
 * (例如 `&`/`|`/`^` 等),ACP agent 的 command/args 屬於使用者自行設定的
 * 受信任本機設定,不是任意外部輸入。
 */
function quoteWindowsShellArg(value: string): string {
  if (value.length === 0) return '""';
  if (!/[\s"]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}
