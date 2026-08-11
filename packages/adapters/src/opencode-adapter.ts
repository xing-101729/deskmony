import { randomUUID } from "node:crypto";
import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import path from "node:path";
import type { AgentEvent, AgentProfile, PromptInput } from "@deskmony/shared";
import type { AdapterCapabilities, AgentAdapter, AgentHandle, Workspace } from "./types.js";
import { AsyncQueue } from "./async-queue.js";

/**
 * OpenCodeAdapter — 對接 opencode 的 headless server API(ARCHITECTURE.md
 * 3.4 節「OpenCodeAdapter | OpenCode 的 HTTP + SSE server API」,這輪補上
 * 一直沒實作的 adapter,修復「opencode 只是把 TUI 塞進終端視圖」的問題)。
 *
 * ---- 對接策略(**全部依實際執行 `opencode --help`/`opencode serve --help`
 * 與本機起一個真實 `opencode serve` process 觀察到的行為為準,不臆測**)----
 *
 *  - `opencode`(本機驗證版本 1.18.4)有一個原生子命令 `opencode serve`
 *    (`--port`/`--hostname`,預設 `--port 0` 隨機取一個 port、
 *    `--hostname 127.0.0.1`),啟動後會在 **stdout** 印出一行
 *    `opencode server listening on http://<host>:<port>`——這裡 spawn 子
 *    程序時固定帶 `serve --port 0 --hostname 127.0.0.1`(除非
 *    `profile.opencodeConfig.args` 有指定,見 `packages/shared/src/
 *    agent-profile.ts` 的 `OpencodeAgentConfigSchema` 註解:那是給
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
    };
  }

  async spawn(profile: AgentProfile, workspace: Workspace): Promise<AgentHandle> {
    const config = profile.opencodeConfig;
    if (!config) {
      throw new Error(`AgentProfile "${profile.id}" 的 software="opencode" 缺少 opencodeConfig(command)`);
    }

    const defaultServeArgs = ["serve", "--port", "0", "--hostname", "127.0.0.1"];
    const rawArgs = config.args && config.args.length > 0 ? config.args : defaultServeArgs;
    const { command, args, useShell } = resolveWindowsSpawnCommand(config.command, rawArgs);

    // 這輪新增:profile.env 疊在 process.env 之上,config.env(既有欄位)
    // 最優先——同 acp-adapter.ts 的合併順序說明。
    const child: OpencodeChildProcess = spawn(command, args, {
      cwd: workspace.path,
      env: { ...process.env, ...profile.env, ...config.env },
      stdio: ["ignore", "pipe", "pipe"],
      shell: useShell,
    });

    const spawnFailure = new Promise<never>((_, reject) => {
      child.once("error", (err) => {
        reject(new Error(`OpenCode server 子程序啟動失敗(command=${command}): ${err.message}`));
      });
    });
    spawnFailure.catch(() => {
      // 僅用於 Promise.race,避免 Node 印出 unhandled rejection 警告。
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      console.error(`[opencode-adapter] ${profile.name} stderr: ${chunk.toString().trimEnd()}`);
    });

    let baseUrl: string;
    try {
      baseUrl = await Promise.race([
        waitForListeningLine(child),
        spawnFailure,
        rejectAfter(SERVE_READY_TIMEOUT_MS, "等待 OpenCode server 印出監聽位址逾時"),
      ]);
      await Promise.race([
        waitForHealthy(baseUrl),
        spawnFailure,
        rejectAfter(HEALTH_POLL_TIMEOUT_MS, "等待 OpenCode server /global/health 就緒逾時"),
      ]);
    } catch (err) {
      this.killChild(child);
      throw err;
    }

    let opencodeSessionId: string;
    try {
      const created = await postJson<{ id: string }>(`${baseUrl}/session`, {});
      opencodeSessionId = created.id;
    } catch (err) {
      this.killChild(child);
      throw new Error(`OpenCode session 建立失敗: ${err instanceof Error ? err.message : String(err)}`);
    }

    const outputQueue = new AsyncQueue<AgentEvent>();
    const handle: AgentHandle = { id: randomUUID(), profile, workspace };
    const sseController = new AbortController();

    const internal: InternalSession = {
      handle,
      child,
      baseUrl,
      opencodeSessionId,
      outputQueue,
      partMeta: new Map(),
      toolMeta: new Map(),
      pendingPermissions: new Map(),
      erroredMessageIds: new Set(),
      busy: false,
      turnErrored: false,
      idleWaiters: [],
      sseController,
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

    return handle;
  }

  sendPrompt(handle: AgentHandle, prompt: PromptInput): void {
    const internal = this.mustGet(handle);
    internal.busy = true;
    internal.turnErrored = false;
    // model 解析優先序:`internal.modelOverride`(透過 setModel() 對話中途
    // 設定,見該方法)> `handle.profile.model`(profile 建立時挑選的
    // "providerID/modelID" 組合字串,見 ProfileCreateDialog.tsx 的送出邏輯)。
    // 兩者都用同一個 parseModelString() 從第一個 "/" 拆成 opencode 要求的
    // {providerID, modelID} 兩個欄位,隨 POST /session/{id}/message 一起送
    // 出——setModel() 本身只是把覆寫記在記憶體裡,並不會呼叫任何 opencode
    // API(沒有對應的端點),真正「生效」永遠是靠這裡讀到覆寫值的下一次
    // sendPrompt()。都沒有時完全不帶 model 欄位,交給 opencode 自己的預設。
    const modelField = internal.modelOverride ?? parseModelString(handle.profile.model);
    void postJson(`${internal.baseUrl}/session/${internal.opencodeSessionId}/message`, {
      parts: [{ type: "text", text: prompt.text }],
      ...(modelField ? { model: modelField } : {}),
    }).catch((err: unknown) => {
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
      await postJson(`${internal.baseUrl}/session/${internal.opencodeSessionId}/abort`, {});
    } catch {
      // 伺服器可能已經結束或本來就沒有進行中的回合,忽略。
    }
    await waitForIdle(internal, IDLE_WAIT_TIMEOUT_MS);
  }

  async dispose(handle: AgentHandle): Promise<void> {
    const internal = this.sessions.get(handle.id);
    if (!internal) return;
    // 懸置的權限請求(opencode 端 `permission.asked` 呼叫)若放著不管會讓
    // opencode 卡住等回覆——一律以「拒絕」收場後再清空(比照
    // AcpAdapter.dispose() 的既有做法)。
    for (const requestId of internal.pendingPermissions.keys()) {
      try {
        await postJson(`${internal.baseUrl}/permission/${requestId}/reply`, { reply: "reject" });
      } catch {
        // 伺服器即將被關閉,忽略。
      }
    }
    internal.pendingPermissions.clear();
    internal.sseController.abort();
    internal.outputQueue.close();
    this.killChild(internal.child);
    this.sessions.delete(handle.id);
  }

  resolvePermission(handle: AgentHandle, requestId: string, decision: "allow" | "deny"): void {
    const internal = this.mustGet(handle);
    if (!internal.pendingPermissions.has(requestId)) return;
    internal.pendingPermissions.delete(requestId);
    const reply = decision === "allow" ? "once" : "reject";
    void postJson(`${internal.baseUrl}/permission/${requestId}/reply`, { reply }).catch((err: unknown) => {
      internal.outputQueue.push({
        type: "error",
        message: "OpenCode permission/reply 送出失敗",
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
   * 無法解析(與 `parseModelString()` 判斷 `profile.model` 是否合法的規則
   * 完全一致)。刻意不做的部分:呼叫 `/config/providers`(或 `/provider`)
   * 驗證這組 providerID/modelID 是否真的存在——本檔案的對接策略一貫要求
   * 「以實際觀察到的 opencode 行為為準,不臆測」,這輪沒有機會對這兩個端點
   * 做本機驗證。若使用者傳入語法正確但實際不存在的 model,opencode 會在
   * 下一次 `POST /session/{id}/message` 時自行判定失敗,經由既有的
   * `message.updated` 錯誤事件轉發路徑浮現(見 `handleEvent()`)——與
   * 「`profile.model` 打錯字」的既有行為完全一致,不需要另外處理。
   */
  async setModel(handle: AgentHandle, model: string): Promise<void> {
    const internal = this.mustGet(handle);
    const parsed = parseModelString(model);
    if (!parsed) {
      throw new Error(
        `software="opencode" 的 model 必須是 "providerID/modelID" 形式(例如 ` +
          `"anthropic/claude-sonnet-4-20250514"),收到的值 "${model}" 無法解析`,
      );
    }
    internal.modelOverride = parsed;
  }

  private mustGet(handle: AgentHandle): InternalSession {
    const internal = this.sessions.get(handle.id);
    if (!internal) {
      throw new Error(`未知的 agent handle: ${handle.id}`);
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
    const res = await fetch(`${internal.baseUrl}/event`, { signal: internal.sseController.signal });
    if (!res.body) {
      throw new Error("OpenCode /event 回應沒有 body,無法讀取 SSE 串流");
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
    const sessionID = properties?.sessionID;
    if (sessionID !== undefined && sessionID !== internal.opencodeSessionId) return;

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
        internal.pendingPermissions.set(requestId, { toolCallId: tool?.callID });
        internal.outputQueue.push({
          type: "permission-request",
          requestId,
          toolName: toolMeta?.toolName ?? (properties?.permission as string | undefined) ?? "unknown",
          description: patterns && patterns.length > 0 ? `patterns: ${patterns.join(", ")}` : undefined,
        });
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
      let meta = internal.toolMeta.get(part.callID);
      if (!meta) {
        meta = { toolName: part.tool, emittedCall: false, emittedResult: false };
        internal.toolMeta.set(part.callID, meta);
      }
      if (!meta.emittedCall) {
        meta.emittedCall = true;
        internal.outputQueue.push({
          type: "tool-call",
          toolCallId: part.callID,
          toolName: part.tool,
          input: part.state.input,
        });
      }
      if (!meta.emittedResult && part.state.status === "completed") {
        meta.emittedResult = true;
        internal.outputQueue.push({
          type: "tool-result",
          toolCallId: part.callID,
          toolName: part.tool,
          output: part.state.output ?? (part.state.metadata as Record<string, unknown> | undefined)?.output,
          isError: false,
        });
      } else if (!meta.emittedResult && part.state.status === "error") {
        meta.emittedResult = true;
        internal.outputQueue.push({
          type: "tool-result",
          toolCallId: part.callID,
          toolName: part.tool,
          output: part.state.error,
          isError: true,
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
  emittedCall: boolean;
  emittedResult: boolean;
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

interface InternalSession {
  handle: AgentHandle;
  child: OpencodeChildProcess;
  baseUrl: string;
  opencodeSessionId: string;
  outputQueue: AsyncQueue<AgentEvent>;
  partMeta: Map<string, PartMeta>;
  toolMeta: Map<string, ToolMeta>;
  pendingPermissions: Map<string, PendingPermission>;
  erroredMessageIds: Set<string>;
  busy: boolean;
  /** 這一輪是否已經送出過 error(避免 markIdleIfBusy() 額外再送一次 completed)。 */
  turnErrored: boolean;
  idleWaiters: Array<() => void>;
  sseController: AbortController;
  /** setModel() 設定的覆寫值,優先於 handle.profile.model——見 setModel()/sendPrompt() 方法註解。 */
  modelOverride?: { providerID: string; modelID: string };
}

interface OpencodePart {
  id: string;
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
 *   - `AgentProfile.model`(建立 profile 時，`ProfileCreateDialog` 從
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

function rejectAfter(ms: number, message: string): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(message)), ms);
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

/** 輪詢 `/global/health` 直到回應 200(或逾時,由呼叫端的 Promise.race 把關)。 */
async function waitForHealthy(baseUrl: string): Promise<void> {
  for (;;) {
    try {
      const res = await fetch(`${baseUrl}/global/health`);
      if (res.ok) return;
    } catch {
      // 尚未接受連線,稍後重試。
    }
    await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_INTERVAL_MS));
  }
}

async function postJson<T = unknown>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`POST ${url} 失敗(status=${res.status}): ${text.slice(0, 500)}`);
  }
  return text.length > 0 ? (JSON.parse(text) as T) : (undefined as T);
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
