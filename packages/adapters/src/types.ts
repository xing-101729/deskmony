import type { AgentEvent, AgentProfile, EffortLevel, PromptInput, TeamBusPort } from "@deskmony/shared";
import type { AdapterCapabilities } from "@deskmony/shared";

/**
 * AgentAdapter 介面(ARCHITECTURE.md 4.3 節)。
 *
 * 與文件中的 TypeScript 片段相比,多了 `resolvePermission` —— 這是把
 * 「adapter 發出 permission-request 事件 → 等待外部(PermissionGateway/UI)回覆」
 * 這條路徑補完所必要的方法,文件 4.3 節文字本身也提到「等待外部回覆」,
 * 但介面片段本身未列出對應方法,此處視為必要的實作細節補充。
 */
export type { AdapterCapabilities };

export interface Workspace {
  /** 工作目錄的絕對路徑 */
  path: string;
}

/**
 * M3 Round A:session 建立時若屬於某個 team 成員,`SessionManager` 會把這個
 * context 傳給 `AgentAdapter.spawn()`。`ClaudeAgentSdkAdapter` 用它掛載
 * team-bus MCP 工具(見 packages/adapters/src/team-bus-mcp.ts);其餘 adapter
 * (ACP/PTY)這輪不掛 MCP,可以忽略這個參數。
 *
 * `bus` 是 `TeamBusPort`(定義在 packages/shared,而非 apps/core 的
 * MessageBus 具體類別)—— 依賴方向規則:packages/* 不得 import apps/*,
 * 這裡只依賴介面,實例由 apps/core 在建立 session 時注入(見
 * apps/core/src/session/session-manager.ts 的 setTeamBus()/teamBus 欄位)。
 */
export interface TeamSpawnContext {
  teamId: string;
  memberId: string;
  memberName: string;
  memberRole: string;
  bus: TeamBusPort;
}

/**
 * spawn() 回傳的輕量控制代碼。實際的 process/連線狀態由各 adapter 內部管理,
 * 呼叫端(SessionManager)只需要拿著這個 handle 呼叫其餘介面方法。
 */
export interface AgentHandle {
  id: string;
  profile: AgentProfile;
  workspace: Workspace;
}

/**
 * S6(crash-recovery)新增:「繼續(保有記憶)」用的 resume 提示,見
 * crash-recovery_detail.md §4.1——只有查證過確實支援磁碟持久化 session 的
 * adapter 才會使用這個參數(目前只有 `ClaudeAgentSdkAdapter`,見該檔案頂端
 * 對 `@anthropic-ai/claude-agent-sdk` 的 `resume` 選項查證)。其餘 adapter
 * 的 `spawn()` 簽章不需要加這個參數(TS 允許實作端接受比介面宣告更少的參數,
 * 呼叫端永遠不會對不支援的 adapter 傳這個值,見 apps/core/src/session/
 * session-manager.ts 的 `continueSession()`)。
 */
export interface ResumeOptions {
  /** `getBackendSessionId()` 先前回傳的值。 */
  backendSessionId: string;
}

export interface AgentAdapter {
  capabilities(): AdapterCapabilities;
  spawn(profile: AgentProfile, workspace: Workspace, team?: TeamSpawnContext, resume?: ResumeOptions): Promise<AgentHandle>;
  sendPrompt(handle: AgentHandle, prompt: PromptInput): void;
  /** AgentEvent = 訊息增量 | 工具呼叫 | 權限請求 | 完成 | 錯誤 */
  events(handle: AgentHandle): AsyncIterable<AgentEvent>;
  /**
   * 中斷目前回合。回傳的 Promise 在「中斷確實生效、控制權已交還呼叫端」時才
   * resolve(M3 Round B 修正,見 apps/core/src/bus/message-bus.ts 頂端註解的
   * 「interrupt 時序」設計決策)——呼叫端(尤其是 MessageBus 的 interrupt
   * 投遞路徑)必須先 await 這個 Promise 完成,才能安全地注入下一個 prompt,
   * 否則會與尚未真正停下的回合競爭(race)。各 adapter 對「生效」的定義依其
   * 協議能力而異(ClaudeAgentSdkAdapter 用 SDK 官方文件明載語意的
   * `Query.interrupt()` Promise;AcpAdapter/GenericPtyAdapter 沒有對應的
   * 「確認生效」回條,只能盡力而為地 await 送出動作本身完成,細節見各自
   * 檔案內的實作註解)。
   */
  interrupt(handle: AgentHandle): Promise<void>;
  dispose(handle: AgentHandle): Promise<void>;
  /** 回覆一個先前透過 permission-request 事件發出的請求 */
  resolvePermission(handle: AgentHandle, requestId: string, decision: "allow" | "deny"): void;
  /**
   * 變更此 session 後續使用的 model(M5 Round C:對話中換 model)。
   *
   * 調查結論(讀取 node_modules 內 `@anthropic-ai/claude-agent-sdk` 的
   * `sdk.d.ts` 後確認,見 `claude-sdk-adapter.ts` 頂端對接策略註解的延伸
   * 說明):SDK 的 `Query` 物件本身就提供 `setModel(model?: string):
   * Promise<void>`——「Change the model used for subsequent responses.
   * Only available in streaming input mode.」`ClaudeAgentSdkAdapter`
   * 一律用 streaming input(`AsyncQueue` 當 `prompt`),因此可以直接呼叫
   * 這個方法,不需要 dispose 現有 query 後重新 spawn,對話上下文(歷史
   * 訊息、SDK 內部 session 狀態)完全不受影響地保留 —— 這是比「dispose +
   * respawn」更好的方案,故採用之。
   *
   * `OpenCodeAdapter` 沒有 SDK 這種官方支援的「設定當前 model」方法——
   * opencode 的 model 是每則訊息各自可選的 `{providerID,modelID}` 欄位
   * (`POST /session/{id}/message` body 的一部分),不是一個獨立可設定的
   * 狀態。做法是把解析後的值存成 session 內的覆寫,下一則 `sendPrompt()`
   * 才真正送給 opencode(細節與取捨見 `opencode-adapter.ts` 的
   * `setModel()`/`parseModelString()` 註解)——呼叫這個方法後「立即」只代表
   * 覆寫已記錄,並不保證 opencode 真的認得這個 model,不合法的值會在下一輪
   * 對話透過既有的錯誤事件路徑浮現。
   *
   * ACP/PTY 協議本身沒有對應的「呼叫端指定 model」機制(ACP 的
   * `session/new`/`session/prompt` 沒有 model 參數,model 完全由被 spawn
   * 出來的那個外部 agent/CLI 自行決定與管理;PTY 更只是無結構化的終端
   * 直通,連「model」這個概念本身都不存在)——`AcpAdapter`/`GenericPtyAdapter`
   * 一律丟出明確錯誤,不可靜默忽略成功(呼叫端 `SessionManager.
   * setSessionModel()` 會讓這個錯誤原樣傳給 gateway 呼叫端)。
   */
  setModel(handle: AgentHandle, model: string): Promise<void>;
  /**
   * 變更此 session 後續使用的 effort(思考程度)。
   *
   * 調查結論(讀取 node_modules 內 `@anthropic-ai/claude-agent-sdk` 的
   * `sdk.d.ts` 後確認,見 `claude-sdk-adapter.ts` 頂端對接策略註解的延伸
   * 說明):執行中的 `Query` 物件提供 `applyFlagSettings({ effortLevel })`,
   * 是 SDK 正式公開(非 deprecated)的 API,`ClaudeAgentSdkAdapter` 直接呼叫
   * 這個方法,不需要 dispose/respawn,對話上下文完全不受影響地保留。
   * `'max'` 是 session-scoped(只在這個 session 生效,不會持久化到 settings
   * 檔案,見 sdk.d.ts 對 `applyFlagSettings()` 的說明)。
   *
   * `OpenCodeAdapter`/`AcpAdapter`/`GenericPtyAdapter` 都沒有查到對應的
   * reasoning-effort 機制(不像 model 那樣 opencode 至少有 per-message 欄位
   * 可以模擬覆寫)——三者一律丟出明確錯誤,不可靜默忽略成功(呼叫端
   * `SessionManager.setSessionEffort()` 會讓這個錯誤原樣傳給 gateway 呼叫端)。
   */
  setEffort(handle: AgentHandle, effort: EffortLevel): Promise<void>;
  /**
   * 原始 byte/字元級輸入直通(對應 Bug A 修正:xterm.js 的 `term.onData()`)。
   * 與 `sendPrompt()` 的差異——`sendPrompt()` 是「送一整行文字,語意上等同
   * 使用者打完字按下 Enter」(內部會補上 `\r`);這裡是「逐鍵直通,不附加
   * 任何字元」,讓方向鍵/Tab/Esc 等轉義序列(interactive TUI 選單操作所需)
   * 能原封不動送進 pty 的 stdin。只有 `GenericPtyAdapter` 實作;其餘 adapter
   * (ACP/claude-agent-sdk)沒有「原始終端輸入」這個概念,保持 `undefined`
   * (呼叫端須用 `?.` 呼叫,見 apps/core/src/session/session-manager.ts 的
   * `writeTerminalInput()`)。
   */
  writeInput?(handle: AgentHandle, data: string): void;
  /**
   * 通知底層 pty 實際的終端尺寸變更(對應 Issue 1 修正之一:PTY 一直固定在
   * spawn 當下的 `cols: 80, rows: 24`,從未依 xterm.js 的 fit 結果同步,導致
   * shell/TUI 程式以錯誤寬度換行、游標定位跑掉)。只有 `GenericPtyAdapter`
   * 實作;其餘 adapter 沒有「終端尺寸」概念,保持 `undefined`。
   */
  resize?(handle: AgentHandle, cols: number, rows: number): void;
  /**
   * S6(crash-recovery)新增:回傳這個 handle 對應的後端持久化 session 識別碼
   * ——只有查證過真的有磁碟持久化能力的 adapter 才實作(目前只有
   * `ClaudeAgentSdkAdapter`,見該檔案內對 SDK `resume` 選項的查證說明)。
   * 回傳 `undefined` 代表「這個 adapter 不支援,或這個 session 還沒捕捉到值」
   * ——兩種情況呼叫端(SessionManager)都一律視為「這條 session 目前無法
   * 『繼續』,只能『接手』」,不強行區分(crash-recovery_detail.md §4.1「查不到
   * 就標不支援」的同一種保守原則)。其餘 adapter(ACP/OpenCode/PTY)保持
   * `undefined`(不實作這個方法)。
   */
  getBackendSessionId?(handle: AgentHandle): string | undefined;
}
