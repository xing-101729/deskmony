import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import path from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import type { AgentEvent, AgentProfile, PromptInput } from "@deskmony/shared";
import type { AdapterCapabilities, AgentAdapter, AgentHandle, Workspace } from "./types.js";
import { AsyncQueue } from "./async-queue.js";
import { killProcessTree, waitForChildExit } from "./child-process.js";

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
 *    failed 時)→ `tool-result`。ACP 明確帶 `messageId`(不像 Claude SDK
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
 *  - `session/update` 的 `plan`/`plan_update`/`available_commands_update`/
 *    `current_mode_update`/`config_option_update`/`session_info_update`/
 *    `usage_update`/`agent_thought_chunk`/`user_message_chunk` 尚未有對應的
 *    AgentEvent 型別(見 packages/shared/src/events.ts),先略過不轉發。
 *  - `diff` 能力回報為 false:ACP 的 `ToolCallContent` 雖然有 `type: "diff"`,
 *    但這裡尚未解析轉發,如實回報避免 UI 誤判。
 *  - `fs.readTextFile`/`fs.writeTextFile`/`terminal.*` 皆回報不支援
 *    (`clientCapabilities` 對應欄位為 false/未設定),agent 若呼叫這些方法
 *    會由 ACP 底層回 JSON-RPC method-not-found。
 */
export class AcpAdapter implements AgentAdapter {
  private readonly sessions = new Map<string, InternalSession>();

  capabilities(): AdapterCapabilities {
    return {
      streaming: true,
      toolEvents: true,
      permissionRequests: true,
      diff: false,
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
    };
  }

  async spawn(profile: AgentProfile, workspace: Workspace): Promise<AgentHandle> {
    const acpConfig = profile.acpConfig;
    if (!acpConfig) {
      throw new Error(`AgentProfile "${profile.id}" 的 software="acp" 缺少 acpConfig(command)`);
    }

    const { command, args, useShell } = resolveWindowsSpawnCommand(acpConfig.command, acpConfig.args ?? []);
    // 這輪新增:`profile.env`(provider 層級預設 + profile 自己的覆寫,已由
    // SessionManager.createSession() 合併好,見該檔案內的說明)疊在
    // process.env 之上,`acpConfig.env`(既有欄位,呼叫端在 profile 建立時
    // 針對這個 adapter 特別設定的值)最優先——維持這個既有欄位一直以來的
    // "最終覆寫" 語意不變,只是多了 profile.env 這一個中間層。
    const child = spawn(command, args, {
      cwd: workspace.path,
      env: { ...process.env, ...profile.env, ...acpConfig.env },
      stdio: ["pipe", "pipe", "pipe"],
      shell: useShell,
    });

    // child 啟動失敗(command 找不到等)會觸發 "error" 而不是 reject 某個
    // promise;把它轉成一個會 reject 的 promise,跟 initialize/newSession
    // 用 Promise.race 賽跑,避免無限期卡在等待子程序回應。
    const spawnFailure = new Promise<never>((_, reject) => {
      child.once("error", (err) => {
        reject(new Error(`ACP agent 子程序啟動失敗(command=${command}): ${err.message}`));
      });
    });
    spawnFailure.catch(() => {
      // 僅用於 Promise.race,避免 Node 印出 unhandled rejection 警告。
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      console.error(`[acp-adapter] ${profile.name} stderr: ${chunk.toString().trimEnd()}`);
    });

    const outputQueue = new AsyncQueue<AgentEvent>();
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

      const session = await Promise.race([
        connection.agent.buildSession(workspace.path).start(),
        spawnFailure,
      ]);

      const handle: AgentHandle = { id: randomUUID(), profile, workspace };
      const internal: InternalSession = {
        handle,
        child,
        connection,
        session,
        outputQueue,
        pendingPermissions,
        toolTitles: new Map(),
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
    // 佔用 —— 若 dispose() 在此之前就 resolve,呼叫端(TaskService.deleteTask →
    // WorkspaceManager.removeWorkspace)會立刻 `git worktree remove`,撞上
    // `Permission denied` / `EBUSY: resource busy or locked`。
    // S8 讓 assignTask() 自動 spawn session 之後,worktree 首次會被子程序佔住,
    // 這個既有的時序漏洞才被 e2e-gateway 步驟 15e 暴露出來。
    // 這裡等子程序真正 exit(上限 3 秒;逾時就放棄等待,讓呼叫端既有的重試機制
    // 接手,絕不因為等不到而卡住 dispose)。
    await waitForChildExit(internal.child, 3_000);
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
    throw new Error('software="acp" 不支援變更 model(model 由外部 agent/CLI 自行管理,ACP 協議未提供對應機制)');
  }

  private mustGet(handle: AgentHandle): InternalSession {
    const internal = this.sessions.get(handle.id);
    if (!internal) {
      throw new Error(`未知的 agent handle: ${handle.id}`);
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
      this.handleSessionUpdate(internal, message.notification.update);
    }
    outputQueue.close();
  }

  private handleSessionUpdate(internal: InternalSession, update: acp.SessionUpdate): void {
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        this.pushTextChunk(internal, update);
        break;
      case "tool_call":
        internal.toolTitles.set(update.toolCallId, update.title);
        internal.outputQueue.push({
          type: "tool-call",
          toolCallId: update.toolCallId,
          toolName: update.title,
          input: update.rawInput,
        });
        break;
      case "tool_call_update":
        if (update.status === "completed" || update.status === "failed") {
          internal.outputQueue.push({
            type: "tool-result",
            toolCallId: update.toolCallId,
            toolName: internal.toolTitles.get(update.toolCallId) ?? update.title ?? "",
            output: update.rawOutput ?? update.content,
            isError: update.status === "failed",
          });
        }
        break;
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
      default:
        // user_message_chunk / agent_thought_chunk / plan* / 其餘擴充型別:
        // M2 Round A 的 AgentEvent 尚未涵蓋,略過不轉發(見上方 class 註解的 TODO)。
        break;
    }
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
  currentMessageId: string | null;
  /**
   * S3a(usage-metering)L4 §2:最近一次從 `usage_update` 拿到的累計花費
   * (`cost` 存在時才更新)。`undefined` 代表這個連線至今尚未收到過 `cost`
   * ——ACP 的 `cost` 是 optional,可能整個 session 都不回報。
   */
  lastCost?: { amount: number; currency: string };
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
 * (例如 `&`/`|`/`^` 等),ACP profile 的 command/args 屬於使用者自行設定的
 * 受信任本機設定,不是任意外部輸入。
 */
function quoteWindowsShellArg(value: string): string {
  if (value.length === 0) return '""';
  if (!/[\s"]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}
