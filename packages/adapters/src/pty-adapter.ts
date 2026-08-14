import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import * as pty from "node-pty";
import type { IPty } from "node-pty";
import type { AgentEvent, AgentProfile, PromptInput } from "@deskmony/shared";
import { DeskmonyError, ErrorCodes } from "@deskmony/shared";
import type { AdapterCapabilities, AgentAdapter, AgentHandle, Workspace } from "./types.js";
import { AsyncQueue } from "./async-queue.js";

/**
 * GenericPtyAdapter — ARCHITECTURE.md 3.4 節「保底方案,無結構化事件,功能
 * 降級」的 PTY 直通 adapter(M2 Round B 新增)。用 `node-pty`
 * (node_modules 內 `typings/node-pty.d.ts` 為準)對任意互動式 CLI 開一個
 * 偽終端(Windows 走 ConPTY,POSIX 走真正的 pty),不解析輸出內容 —— 純粹
 * 把 raw bytes/文字轉成 `terminal-data` AgentEvent 直通給 UI(見
 * packages/shared/src/events.ts 對編碼選擇的說明)。
 *
 * 與 `ClaudeAgentSdkAdapter`/`AcpAdapter` 的關鍵差異:這兩者是「回合制」
 * (一輪 prompt → 一串結構化事件 → `completed`),而 pty 是一個連續、無回合
 * 邊界的終端 session ——`sendPrompt()` 只是把文字寫進 pty 的 stdin(視同
 * 使用者在鍵盤打字後按下 Enter),不代表任何語意上的「一輪對話結束」。
 * 因此這裡完全不送出 `message-delta`/`tool-call`/`tool-result`
 * /`permission-request` 事件,`capabilities()` 如實回報
 * (`streaming/toolEvents/permissionRequests/diff` 全為 false,只有
 * `interrupt`/`terminal` 為 true)。「這個 session 现在算不算 busy」交給
 * `SessionManager` 依輸出活動(收到 `terminal-data` 就延後 idle 的時間點)
 * 判斷,不是這個 adapter 的職責 —— 詳見 apps/core/src/session/session-manager.ts
 * 的設計說明。
 *
 * node-pty 安裝狀況(本機驗證,見 README「node-pty 安裝注意事項」):
 * `node-pty@1.1.0` 在 Windows x64 + Node 22 上透過官方 prebuilt 二進位
 * (`scripts/prebuild.js` 抓 GitHub release 的 `.node` 檔 + ConPTY 的
 * `conpty.dll`/`OpenConsole.exe`)安裝成功,**不需要**本機裝 MSVC build
 * tools 走 `node-gyp rebuild` 這條路(本機環境事實上也沒有裝 `cl.exe`,
 * 若真的需要 fallback 到 `node-gyp rebuild` 会直接失敗)。因此本檔案不含
 * `child_process` + 管道的降級實作 —— 若未來在某台機器上 prebuild 抓取失敗
 * 且本機也無法編譯,`import * as pty from "node-pty"` 會在 `apps/core`
 * 啟動時就直接丟出 module-not-found 錯誤(而不是靜默降級),需要另外處理
 * (例如包一層 dynamic import + try/catch,退化成僅回報 `capabilities().
 * terminal = false` 並在 spawn() 丟出清楚的錯誤訊息),不在本次改動範圍內。
 *
 * 已知限制 / TODO(M2 Round B 範圍):
 *  - 終端尺寸(`cols`/`rows`)只能在 spawn 當下透過 `AgentProfile.ptyConfig`
 *    決定,`AgentAdapter` 介面尚未有 `resize()` 方法,UI 端 xterm 視圖 resize
 *    不會回傳給後端的實際 pty(僅前端顯示跟著容器縮放,不影響 CLI 內部
 *    换行寬度判斷)。
 *  - **`kill()` 在無真實 Windows console 的情境下會印出一段無害但難看的
 *    stderr trace**(本機實測重現):`node-pty` 在 Windows 走預設的 ConPTY
 *    模式(`useConptyDll: false`,這裡刻意不改成 `true` —— 實測
 *    `useConptyDll: true` 在本機環境下反而導致子程序完全收不到/送不出
 *    資料,比預設模式更不可靠)時,`kill()` 內部會用 `child_process.fork()`
 *    另外啟動一個短命的診斷子程序(`node-pty/lib/conpty_console_list_agent.js`)
 *    去查詢「這個 console 上還掛著哪些其他程序」,查詢用的是 Win32
 *    `AttachConsole`/`GetConsoleProcessList`;`apps/core` 這種以
 *    `stdio:"pipe"` 背景執行、本身沒有附著在任何真實 Windows console 視窗
 *    上的程序,`AttachConsole` 會直接失敗,診斷子程序因此在自己的頂層丟出
 *    未捕捉例外並印出 stack trace 到它繼承的 stderr(也就是 `apps/core` 的
 *    stderr)。這個 trace **不影響**主程序:已用暫存腳本反覆驗證
 *    kill()/dispose() 後(1)outputQueue 正常關閉、(2)`tasklist` 確認沒有
 *    殘留的 node.exe 程序、(3)呼叫端(`GenericPtyAdapter.dispose()`)本身
 *    completes 正常。這是 `node-pty` 上游在無 console 環境下的已知行為,
 *    不是本專案引入的 bug,此處不嘗試 monkey-patch `node-pty` 內部模組去
 *    消音,只在此記錄、並在 README 對應章節提醒「apps/core 的終端輸出可能
 *    偶爾出現這段 AttachConsole failed 的 trace,可安全忽略」。
 *  - `interrupt()` 送出 `\x03`(Ctrl+C)這個慣例按鍵給前景程式,不是像
 *    ACP `session/cancel` 那樣有結構化的「取消」語意 —— 前景程式若不理會
 *    SIGINT/Ctrl+C(例如某些完全吃掉輸入的 TUI),這裡目前沒有更強的手段。
 *  - 只處理單一 pty 尺寸初始化,不支援之後動態切換 `useConpty`/编碼設定。
 */
export class GenericPtyAdapter implements AgentAdapter {
  private readonly sessions = new Map<string, InternalSession>();

  capabilities(): AdapterCapabilities {
    return {
      streaming: false,
      toolEvents: false,
      permissionRequests: false,
      diff: false,
      interrupt: true,
      terminal: true,
      // S3a(usage-metering)L4 §1 能力表:pty 是無結構化終端直通,連「usage」
      // 這個概念本身都不存在——這是**結構上**的不可能,不是「還沒接」,所以
      // 兩者一律 "unsupported"(三態裡最確定的那一態,永遠不會被觀察推翻)。
      usageReporting: "unsupported",
      contextReporting: "unsupported",
    };
  }

  async spawn(profile: AgentProfile, workspace: Workspace): Promise<AgentHandle> {
    const ptyConfig = profile.ptyConfig;
    if (!ptyConfig) {
      throw new DeskmonyError(
        ErrorCodes.ADAPTER_MISSING_CONFIG,
        { profileId: profile.id, software: "pty", configField: "command" },
        `AgentProfile "${profile.id}" 的 software="pty" 缺少 ptyConfig(command)`,
      );
    }

    const outputQueue = new AsyncQueue<AgentEvent>();

    let ptyProcess: IPty;
    try {
      // 這輪新增:profile.env 疊在 process.env 之上,ptyConfig.env(既有欄位)
      // 最優先——同 acp-adapter.ts 的合併順序說明。
      ptyProcess = pty.spawn(ptyConfig.command, ptyConfig.args ?? [], {
        cwd: workspace.path,
        env: { ...process.env, ...profile.env, ...ptyConfig.env } as Record<string, string>,
        cols: ptyConfig.cols ?? 80,
        rows: ptyConfig.rows ?? 24,
        name: "xterm-color",
      });
    } catch (err) {
      throw new DeskmonyError(
        "adapterProcess.spawnFailed",
        { software: "pty", command: ptyConfig.command, detail: err instanceof Error ? err.message : String(err) },
        `pty 子程序啟動失敗(command=${ptyConfig.command}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const handle: AgentHandle = { id: randomUUID(), profile, workspace };
    const internal: InternalSession = {
      handle,
      ptyProcess,
      outputQueue,
      exited: false,
    };
    this.sessions.set(handle.id, internal);

    ptyProcess.onData((chunk: string) => {
      outputQueue.push({ type: "terminal-data", data: chunk });
    });

    ptyProcess.onExit(({ exitCode, signal }: { exitCode: number; signal?: number }) => {
      internal.exited = true;
      if (exitCode === 0) {
        outputQueue.push({ type: "completed" });
      } else {
        outputQueue.push({
          type: "error",
          message: `pty 子程序已結束(exitCode=${exitCode}${signal !== undefined ? `, signal=${signal}` : ""})`,
        });
      }
      outputQueue.close();
    });

    return handle;
  }

  sendPrompt(handle: AgentHandle, prompt: PromptInput): void {
    const internal = this.mustGet(handle);
    // 直通終端:把文字當成使用者鍵盤輸入寫進 pty 的 stdin,附上 "\r"(Enter
    // 鍵在終端慣例送出的是 CR,不是 "\n" —— ConPTY/pty 底層的行編輯與回顯
    // 都是依 CR 判斷一行輸入結束)。
    internal.ptyProcess.write(`${prompt.text}\r`);
  }

  events(handle: AgentHandle): AsyncIterable<AgentEvent> {
    return this.mustGet(handle).outputQueue;
  }

  /**
   * Bug A 修正:原始鍵盤輸入直通,不附加 `\r`(與 `sendPrompt()` 的差異見
   * `AgentAdapter.writeInput` 介面註解)——xterm.js 的 `term.onData()` 送出的
   * 已經是完整的按鍵/轉義序列(含使用者自己按下 Enter 時的 `\r`),這裡原封
   * 不動寫進 pty 的 stdin。
   */
  writeInput(handle: AgentHandle, data: string): void {
    this.mustGet(handle).ptyProcess.write(data);
  }

  /**
   * Issue 1 修正之一:把 xterm.js 實際的顯示尺寸同步給底層 pty,讓
   * shell/TUI 程式依正確寬度換行、定位游標。已結束的 process 呼叫
   * `resize()` 會拋錯,吞掉即可(與 `interrupt()`/`killProcessTree()` 的
   * try/catch 一致的保守作法)。
   */
  resize(handle: AgentHandle, cols: number, rows: number): void {
    const internal = this.mustGet(handle);
    if (internal.exited) return;
    try {
      internal.ptyProcess.resize(cols, rows);
    } catch {
      // ignore — process 可能已經結束或底層 ConPTY 不接受這個尺寸
    }
  }

  /**
   * pty 的 `write()` 是同步呼叫(寫進子程序 stdin 的 buffer),沒有非同步的
   * 「已生效」回條 —— 前景程式是否/何時真的處理這個 Ctrl+C 完全不可觀察(見
   * class 頂端註解的已知限制)。這裡改成 `async` 只是為了滿足
   * `AgentAdapter.interrupt()` 介面新的 `Promise<void>` 簽章(M3 Round B,
   * 見 packages/adapters/src/types.ts),語意上等同立即 resolve,不是刻意
   * 忽略時序問題 —— pty 本來就沒有結構化的回合邊界可以等。
   */
  async interrupt(handle: AgentHandle): Promise<void> {
    const internal = this.mustGet(handle);
    if (internal.exited) return;
    internal.ptyProcess.write("\x03"); // Ctrl+C
  }

  async dispose(handle: AgentHandle): Promise<void> {
    const internal = this.sessions.get(handle.id);
    if (!internal) return;
    internal.outputQueue.close();
    this.killProcessTree(internal);
    this.sessions.delete(handle.id);
  }

  resolvePermission(): void {
    // GenericPtyAdapter 不會發出 permission-request 事件(capabilities().
    // permissionRequests === false),沒有東西可以回覆 —— 保留空實作以符合
    // AgentAdapter 介面。
  }

  /**
   * M5 Round C:pty 是無結構化的終端直通,連「model」這個概念本身都不存在
   * (終端裡跑的可能根本不是任何 LLM CLI)——明確拋出錯誤,不可靜默忽略成功
   * (見 packages/adapters/src/types.ts 的 `AgentAdapter.setModel()` 介面註解)。
   */
  async setModel(handle: AgentHandle): Promise<void> {
    this.mustGet(handle); // 驗證 handle 有效(未知 handle 仍應先報這個錯,而非「不支援」)
    throw new DeskmonyError(
      ErrorCodes.ADAPTER_UNSUPPORTED_OPERATION,
      { software: "pty", operation: "setModel" },
      'software="pty" 不支援變更 model(pty 是無結構化的終端直通,不存在「model」概念)',
    );
  }

  /**
   * 比照上面的 `setModel()`:pty 是無結構化的終端直通,連「思考程度」這個
   * 概念本身都不存在(終端裡跑的可能根本不是任何 LLM CLI)——明確拋出錯誤,
   * 不可靜默忽略成功(見 packages/adapters/src/types.ts 的
   * `AgentAdapter.setEffort()` 介面註解)。
   */
  async setEffort(handle: AgentHandle): Promise<void> {
    this.mustGet(handle); // 驗證 handle 有效(未知 handle 仍應先報這個錯,而非「不支援」)
    throw new DeskmonyError(
      ErrorCodes.ADAPTER_UNSUPPORTED_OPERATION,
      { software: "pty", operation: "setEffort" },
      'software="pty" 不支援變更思考程度(pty 是無結構化的終端直通,不存在「思考程度」概念)',
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

  private killProcessTree(internal: InternalSession): void {
    if (internal.exited) return;
    try {
      internal.ptyProcess.kill();
    } catch {
      // ignore — process 可能已經結束
    }
    // 額外保險:Windows 上 ConPTY 底層是用 Windows 的 pseudoconsole,
    // node-pty 的 kill() 理論上已經會關閉整個 console 連帶結束子程序樹,
    // 但為了與 acp-adapter.ts 的 killChild() 一致的保守作法,仍嘗試用
    // taskkill /T /F 補一刀(找不到 pid 或已結束時忽略錯誤)。
    if (process.platform === "win32" && internal.ptyProcess.pid) {
      spawnSync("taskkill", ["/pid", String(internal.ptyProcess.pid), "/T", "/F"], { stdio: "ignore" });
    }
  }
}

interface InternalSession {
  handle: AgentHandle;
  ptyProcess: IPty;
  outputQueue: AsyncQueue<AgentEvent>;
  exited: boolean;
}
