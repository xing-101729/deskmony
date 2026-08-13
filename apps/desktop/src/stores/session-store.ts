import { create } from "zustand";
import {
  type AdapterCapabilities,
  type AgentDetectionEntry,
  type AgentOverride,
  type AgentProfile,
  type AgentSoftware,
  type CapabilitySupport,
  type ConfigSetFilePatchInput,
  type CreateAgentProfileInput,
  type EffectiveCoreConfig,
  type EffortLevel,
  type EnforcementNotificationPush,
  type GatewayCapabilities,
  type KnownClaudeModel,
  type MessageRecord,
  type PermissionRequestEvent,
  type PermissionResolvedPush,
  type PolicyRule,
  type ProviderModel,
  type ProviderPrefs,
  type ProviderPrefsPatchInput,
  type ResolvedProvider,
  type Session,
  type SessionEventEnvelope,
  type SessionPermissionMode,
  type CostGetSummaryResult,
  AdapterCapabilitiesResultSchema,
  BUILTIN_PROVIDERS,
  CLAUDE_MODEL_ALIASES,
  ConfigGetEffectiveResultSchema,
  ConfigSetFileResultSchema,
  CostGetSummaryResultSchema,
  DetectAgentsResultSchema,
  EnforcementNotificationPushSchema,
  formatEnforcementNotificationText,
  GatewayCapabilitiesResultSchema,
  mergeModelsById,
  ProfileCreateResultSchema,
  ProfileListResultSchema,
  resolveCapabilitySupport,
  resolveProviders,
  SessionCreateResultSchema,
  SessionHistoryResultSchema,
  SessionListResultSchema,
  SessionSetEffortResultSchema,
  SessionSetModelResultSchema,
  SessionSetPermissionModeResultSchema,
  SettingsGetEnabledModelsResultSchema,
  SettingsGetProviderPrefsResultSchema,
  SettingsSetEnabledModelsResultSchema,
  SettingsSetProviderPrefsResultSchema,
} from "@deskmony/shared";
import { GatewayClient } from "../lib/gateway-client.js";

/** UI 用的聊天時間軸項目(把持久化的 MessageRecord 與即時串流事件合併呈現)。 */
export type ChatItem =
  | { kind: "user"; id: string; content: string; createdAt: number }
  | { kind: "assistant"; id: string; content: string; createdAt: number; streaming: boolean }
  | {
      kind: "tool";
      id: string;
      toolName: string;
      input?: unknown;
      output?: unknown;
      isError: boolean;
      status: "running" | "done";
      createdAt: number;
    }
  | { kind: "system"; id: string; content: string; createdAt: number };

export interface PendingPermission extends PermissionRequestEvent {
  sessionId: string;
}

/**
 * S3a(usage-metering)L4 §4:每個 session 的用量顯示狀態,純 ephemeral(不落地,
 * reload 歸零,見 apps/core/src/session/session-manager.ts 完全沒有把 usage/
 * context-usage 事件寫進 SQLite——這是切片的刻意決定)。
 *   - `costAmount`/`costCurrency`:累計花費(`usage` 事件),已經是累計值,
 *     直接覆寫顯示最新值即可,不需要加總。
 *   - `contextUsed`/`contextSize`:context 窗口使用率(`context-usage` 事件,
 *     gauge),永遠直接覆寫,不套用「新值 < 舊值 = 重置」規則(那條規則只
 *     適用於累計值,gauge 本來就會變小,見 L4 §4)。
 */
export interface SessionUsage {
  costAmount?: number;
  costCurrency?: string;
  contextUsed?: number;
  contextSize?: number;
  /**
   * S3a §7.5 ④(三態能力收斂):這條 session **收到過** `usage` /
   * `context-usage` 事件——與「事件裡有沒有值」是兩件事(ACP 的 `usage` 事件
   * 可能整包沒有 cost),所以不能用 `costAmount !== undefined` 代替。這是把
   * `capabilities()` 宣告的 `"unknown"` 收斂成 `"supported"` 的唯一證據,見
   * `resolveCapabilitySupport()` 與下方 `selectUsageReporting()`。
   *
   * 純 ephemeral,與其餘欄位同命:reload 後回到「沒觀察到」,能力也就退回
   * `"unknown"`(對 UI 而言就是先不顯示,直到下一輪事件抵達)——這是切片
   * 不落地用量的必然後果,不是 bug。
   */
  usageSeen?: boolean;
  contextSeen?: boolean;
}

interface SessionStoreState {
  status: "connecting" | "open" | "closed";
  profiles: AgentProfile[];
  sessions: Session[];
  currentSessionId: string | null;
  itemsBySession: Record<string, ChatItem[]>;
  pendingPermissions: PendingPermission[];
  /** S3a(usage-metering)L4 §4:每個 session 目前的用量顯示狀態,見
   * `SessionUsage` 型別註解——純 ephemeral,不落地。 */
  sessionUsage: Record<string, SessionUsage>;
  /** 每個 software 對應 adapter 的能力(M2 Round B),SessionView 依此決定
   * 渲染聊天串流視圖還是 xterm 終端視圖。用 software 當 key 快取,同一個
   * software 的能力集合不會因 session 不同而改變。 */
  capabilitiesBySoftware: Partial<Record<AgentSoftware, AdapterCapabilities>>;
  /** M5 Round D:`env.detectAgents` 的偵測結果快取(見 SettingsDialog.tsx、
   * ChatView.tsx 的 ModelControl)。初始為空陣列(尚未偵測過),`connect()`
   * 時會 fire-and-forget 呼叫一次 `detectAgents()`,失敗時維持空陣列 ——
   * 讀取端(ChatView 的 model 下拉,見 `selectEnabledClaudeModels()`)遇到
   * 空陣列會安全地顯示「目前沒有可選 model」,不阻塞任何畫面、也不會拿一份
   * 寫死的舊清單充數。 */
  detectedAgents: AgentDetectionEntry[];
  detectingAgents: boolean;
  /**
   * M5 Round E(需求4):「設定」介面持久化的「啟用哪些偵測到的 Claude
   * model」偏好(見 apps/core/src/settings/settings-store.ts)。**空陣列 =
   * 全部啟用**(未曾設定過,或已連線但尚未載入完成時的初始值)——讀取端
   * 一律透過下方 `selectEnabledClaudeModels()` 這個共用 selector 取得「實際
   * 要顯示的清單」,不要直接讀這個欄位就判斷要不要顯示某個 model,避免
   * ProfileCreateDialog 與 ChatView 各自複寫一份判斷邏輯而漂移。
   */
  enabledModelIds: string[];
  /**
   * 這輪新增(provider 目錄重構):`settings.getProviderPrefs` 的快取(見
   * packages/shared/src/provider-catalog.ts、apps/core/src/settings/
   * settings-store.ts)。**注意:這裡的 `env` 一律是遮罩過的**(值固定是
   * `"***"`,只有 key 名稱是真的)——UI 只能拿它顯示「已設定哪些 key」,
   * 絕不能把這裡讀到的值當作真正的 env 拿去做任何事(見
   * ProfileCreateDialog/SettingsDialog 的 env 編輯器實作說明)。初始為空
   * 物件(尚未載入 = 全部 provider 皆維持 BUILTIN_PROVIDERS 目錄預設值)。
   */
  providerPrefs: Record<string, ProviderPrefs>;
  /**
   * M6 Round A 新增:「全域設定」的分層合併結果快照(`config.getEffective`,
   * 見 packages/shared/src/core-config.ts、apps/core/src/config/
   * load-config.ts)。`null` = 尚未載入成功(初始狀態,或 RPC 失敗——
   * SettingsDialog 對 `null` 顯示「載入中/失敗」,不阻塞其餘畫面)。
   */
  effectiveConfig: EffectiveCoreConfig | null;
  /**
   * S3b(CostGovernor):`cost.getSummary` 的快取,per session(見
   * apps/core/src/cost/cost-governor.ts 的 `getSummary()`)。**純 ephemeral**
   * ——與 `sessionUsage` 一樣不落地,由 `fetchCostSummary()` 主動拉取(這輪
   * 沒有對應的 server push channel,見該方法註解的取捨說明)。
   */
  costSummaryBySession: Record<string, CostGetSummaryResult>;
  /**
   * S7(auto-mode-and-yolo)L4 §5.3:握手能力集——`connect()` 呼叫一次
   * `gateway.capabilities`(獨立於 `auth`,見 lib/gateway-client.ts 的
   * `configure()`/`connect()`:未設定 `authToken` 時完全跳過 `auth` 請求,故
   * 不能只靠 `auth` 回應拿 capabilities)。初始值全 `false`(最保守:尚未確認
   * 是本機連線前,不顯示任何 auto/YOLO/policy/profile 管理控制項)。 */
  gatewayCapabilities: GatewayCapabilities;

  connect: () => void;
  refreshProfiles: () => Promise<void>;
  refreshSessions: () => Promise<void>;
  /** 這輪新增最後一個選填參數 `agentOverride`——不落地新 profile,就這一次
   *  建立臨時覆寫要用的 agent software/model(見 packages/shared/src/
   *  session.ts 的 `AgentOverrideSchema` 註解)。 */
  createSession: (
    agentProfileId: string,
    workingDir: string,
    title?: string,
    teamMemberId?: string,
    agentOverride?: AgentOverride,
  ) => Promise<void>;
  createProfile: (input: CreateAgentProfileInput) => Promise<AgentProfile>;
  deleteProfile: (id: string) => Promise<void>;
  selectSession: (sessionId: string) => Promise<void>;
  /**
   * 刪除一個對話(功能2)。呼叫 `session.delete` 後從本地 `sessions`/
   * `itemsBySession` 移除;若刪的是目前選取的 session,`currentSessionId`
   * 改選剩餘 session 的第一個(並載入它的 history),沒有剩餘的就設為
   * `null`。
   *
   * 與 "session-list-updated" 推播的競態說明(見 apps/core/src/session/
   * session-manager.ts 的 `deleteSession()`——DB 刪除 + emit 都在回應這個
   * RPC 之前完成):core 端會在送出這個 RPC 的回應**之前**先廣播
   * "session-list-updated",同一條 WS 連線上訊息保序送達,所以呼叫端會先
   * 收到那個推播(觸發 `refreshSessions()`,此時 DB 已不含這個 session,
   * 拿到的清單自然也不含它),RPC 的 response 才會抵達。也就是說,執行到這
   * 裡的 `set()` 時,`state.sessions` 通常已經不含被刪除的 session ——
   * 這裡的 filter/delete 是冪等的收尾(找不到就是 no-op),不會與推播路徑
   * 打架或造成畫面閃爍。
   */
  deleteSession: (sessionId: string) => Promise<void>;
  /** S12 Phase2 R3:從一個既有 session 開子 agent —— agentProfileId 由呼叫端
   *  (SpawnChildDialog)指定,預設值是父 session 自己的 profile,但使用者可以
   *  改選別的(這輪新增,不再寫死繼承)。呼叫既有 `session.spawnChild` RPC。
   *  `agentOverride` 選填,語意同 `createSession()`。 */
  spawnChild: (
    parentSessionId: string,
    prompt: string,
    agentProfileId: string,
    title?: string,
    agentOverride?: AgentOverride,
  ) => Promise<void>;
  sendPrompt: (text: string) => Promise<void>;
  /** 給 TerminalView 用:把一行原始文字寫進 pty session 的 stdin,不經過
   * ChatItem 時間軸(pty 不是回合制聊天,見 GenericPtyAdapter 的設計說明)。 */
  sendTerminalInput: (text: string) => void;
  /** Bug A 修正:給 TerminalView 的 xterm `term.onData()` 用,逐鍵/逐段原始
   * 輸入直通(不附加 `\r`),與 `sendTerminalInput` 的「整行」語意不同,見
   * apps/core/src/session/session-manager.ts 的 `writeTerminalInput()` 註解。 */
  sendTerminalRawInput: (data: string) => void;
  /** Issue 1 修正之一:把 xterm.js 實際尺寸同步給後端 pty,見
   * apps/core/src/session/session-manager.ts 的 `resizeTerminal()` 註解。 */
  resizeTerminal: (sessionId: string, cols: number, rows: number) => void;
  interrupt: () => void;
  /**
   * S7 L4 §1.3:`rememberRule` 提供時,連同這次的 decision 一起送給 Core——
   * Core 端會做 escalate-strong 的強制檢查(見 apps/core/src/session/
   * session-manager.ts 的 `resolvePermission()`),UI 這裡只需要負責「不要對
   * strong 請求顯示永遠允許的選項」(見 PermissionModal.tsx),不需要也不應該
   * 自己重複判斷 strong 再決定要不要傳 rememberRule——雙重把關,Core 端才是
   * 權威。
   */
  resolvePermission: (requestId: string, decision: "allow" | "deny", rememberRule?: PolicyRule) => void;
  /**
   * S7:切換目前 session 的暫態權限模式(auto/YOLO)。**遠端連線呼叫這個方法
   * 會被 Gateway 擋下**(見 `gatewayCapabilities.canToggleAuto`/`canEnableYolo`
   * ——UI 應先依此隱藏切換按鈕,但即使按鈕沒隱藏,Core 端仍會拒絕,見
   * ws-gateway.ts 的 `LOCAL_ONLY_METHODS`)。
   */
  setSessionPermissionMode: (sessionId: string, mode: SessionPermissionMode) => Promise<void>;
  /** 查詢(並快取)某個 software 的 adapter 能力。 */
  fetchCapabilities: (software: AgentSoftware) => Promise<AdapterCapabilities | undefined>;
  /**
   * M5 Round D:呼叫 `env.detectAgents` 重新偵測本機已裝的 agent 軟體 +
   * 可用 model,更新 `detectedAgents`(SettingsDialog 的「重新偵測」按鈕、
   * `connect()` 時的自動探測都呼叫這個)。偵測失敗(例如尚未連線)時安靜地
   * 保留舊值,不拋出——呼叫端若需要顯示錯誤,可自行 catch(SettingsDialog
   * 這麼做;`connect()` 內的 fire-and-forget 呼叫則直接忽略)。
   */
  detectAgents: () => Promise<void>;
  /**
   * 對話中切換 model(功能3):呼叫 gateway 的 `session.setModel`。只有
   * `software="claude-agent-sdk"` 的 session 支援,acp/pty 呼叫這個方法
   * 會讓回傳的 Promise reject(core 端的 AcpAdapter/GenericPtyAdapter 明確
   * 拋錯,不會靜默成功),呼叫端(ChatView)需自行 catch 並顯示錯誤。
   */
  setSessionModel: (sessionId: string, model: string) => Promise<void>;
  /**
   * 比照上面的 `setSessionModel()`:對話中切換思考程度,呼叫 gateway 的
   * `session.setEffort`。只有 `software="claude-agent-sdk"` 的 session 支援,
   * 其餘 adapter 呼叫這個方法會讓回傳的 Promise reject,呼叫端(ChatView)
   * 需自行 catch 並顯示錯誤。
   */
  setSessionEffort: (sessionId: string, effort: EffortLevel) => Promise<void>;
  /**
   * M5 Round E(需求4):載入目前啟用的 model 偏好(`settings.getEnabledModels`)。
   * `connect()` 會呼叫一次;SettingsDialog 儲存成功後也會呼叫(見
   * `setEnabledModels()`)以確保同一份 store 狀態,ProfileCreateDialog/
   * ChatView 兩個 model picker 共用、不會漂移。失敗時安靜保留舊值(通常是
   * 初始的空陣列 = 全部啟用),不阻塞畫面。
   */
  loadEnabledModels: () => Promise<void>;
  /**
   * 儲存「啟用哪些 model」偏好(`settings.setEnabledModels`),成功後立即用
   * 回傳值更新本地狀態(不需要再呼叫一次 `loadEnabledModels()`)。呼叫端
   * (SettingsDialog)需自行 catch 錯誤並顯示。
   */
  setEnabledModels: (enabledModelIds: string[]) => Promise<void>;
  /** 載入目前所有已顯式覆寫過的 per-provider 偏好(`settings.getProviderPrefs`)。
   *  `connect()` 會呼叫一次;`setProviderPrefs()` 成功後也會重新整份設定,
   *  確保 ProfileCreateDialog/SettingsDialog/ChatView 共用同一份 store 狀態。
   *  失敗時安靜保留舊值(通常是初始空物件 = 全部維持目錄預設)。 */
  loadProviderPrefs: () => Promise<void>;
  /** 對單一 provider 的偏好送出**部分欄位 patch**(見 apps/core/src/settings/
   *  settings-store.ts 的 `patchProviderPrefs()` 完整合併語意——`env` 是淺層
   *  合併,其餘欄位提供時整批覆寫)。成功後用回傳值(遮罩過)更新本地狀態。 */
  setProviderPrefs: (providerId: string, patch: ProviderPrefsPatchInput) => Promise<void>;
  /** M6 Round A:載入目前的「全域設定」有效值快照(`config.getEffective`)。
   *  `connect()` 會呼叫一次;`setConfigFile()` 成功後**不會**自動重新呼叫這個
   *  ——寫入設定檔不會熱重載,`effectiveConfig` 在重啟 core 前仍會顯示舊值,
   *  這是刻意的(見 SettingsDialog 顯示「需重啟才會生效」的提示)。 */
  loadEffectiveConfig: () => Promise<void>;
  /**
   * S3b(CostGovernor):拉取一個 session 目前的成本累計/門檻狀態
   * (`cost.getSummary`),供 `CostSummaryBadge` 顯示任務/每日預算餘量與是否
   * 已 tripped。**用輪詢,不是 server push**——usage 事件本身已經高頻經
   * `session-event` 推播,再開一條「rollup 變了就推播」的 channel 只是把同一
   * 個事實存兩份(見 `RealNotifier`/`sessionUsage` 既有的取捨慣例);呼叫端
   * (ChatView)在切換 session、以及收到這條 session 的 `usage` 事件時各拉一次
   * 即可,不需要長駐計時器輪詢。失敗時安靜保留舊值,不阻塞畫面。
   */
  fetchCostSummary: (sessionId: string) => Promise<void>;
  /**
   * M6 Round A:把安全子集的欄位 patch 寫進 `<DESKMONY_HOME>/config.json`
   * (`config.setFile`)。**不會**修改 `daemon.port`/`daemon.bindHost`——那兩個
   * 欄位不在協議允許的 patch 形狀裡,呼叫端(SettingsDialog)也不會顯示它們
   * 的編輯 UI(只顯示唯讀值 + 說明)。回傳值(`changedFields`/
   * `requiresRestart`)交給呼叫端自行顯示提示。
   */
  setConfigFile: (patch: ConfigSetFilePatchInput) => Promise<{ changedFields: string[]; requiresRestart: boolean }>;
  /** S7:載入(並快取)握手能力集,見上方 `gatewayCapabilities` 欄位註解。
   *  `connect()` 呼叫一次;失敗時安靜保留舊值(初始全 `false`,最保守)。 */
  loadGatewayCapabilities: () => Promise<void>;
}

/**
 * M3 Round B:匯出這個模組層級的 singleton,讓 team-store.ts 共用同一條 WS
 * 連線(而不是另開一條連線)—— gateway 本身允許多個 client 連線,但 renderer
 * 端沒有理由開兩條,徒增重連/事件去重的複雜度。team-store.ts 只讀
 * `client.call()`/`client.onPush()`,不會改動這裡的連線生命週期管理
 * (`connect()`/`disconnect()` 仍只由 App.tsx 透過 session-store 呼叫一次)。
 *
 * M5 Round B(任務2):`window.deskmony` 存在時(Electron)沿用既有行為,
 * 建構子直接拿到 gatewayUrl/authToken。瀏覽器場景下 `window.deskmony` 不
 * 存在,url 預設空字串——`GatewayClient.connect()` 對空字串會直接視為關閉
 * 狀態、不嘗試連線(見該檔案內註解),真正的目標由 App.tsx 在使用者透過
 * `views/ConnectScreen.tsx` 驗證成功後呼叫 `client.configure(url, token)`
 * 設定,才會真的呼叫 `connect()`。
 */
export const client = new GatewayClient(window.deskmony?.gatewayUrl ?? "", window.deskmony?.authToken);

/**
 * pty session 的終端輸出(`terminal-data` 事件)不進入 zustand 的響應式狀態
 * ——量大、高頻(逐字元回顯),若每個 chunk 都觸發一次 store 更新,會讓
 * SessionList/其他訂閱者跟著白白重新渲染。這裡改用模組層級的
 * pub-sub(`onTerminalData`)讓 `TerminalView` 直接把資料 imperative 地寫進
 * xterm.js 的 buffer,不經過 React 的 re-render 流程;另外保留一個有上限的
 * 純記憶體 ring buffer(`terminalBufferBySession`,只在 renderer 記憶體內,
 * 不落地、不經過 core 持久化)方便使用者切換 session 分頁後回來時還能看到
 * 最近的輸出,而不是每次切換就整個清空(這與 core 端「不持久化逐筆 chunk」
 * 的決定不衝突 —— 那是指 SQLite,不是 renderer 的暫存記憶體)。
 */
const TERMINAL_BUFFER_MAX_CHARS = 200_000;
const terminalBufferBySession = new Map<string, string>();
type TerminalDataListener = (sessionId: string, data: string) => void;
const terminalDataListeners = new Set<TerminalDataListener>();

export function getTerminalBuffer(sessionId: string): string {
  return terminalBufferBySession.get(sessionId) ?? "";
}

export function onTerminalData(listener: TerminalDataListener): () => void {
  terminalDataListeners.add(listener);
  return () => terminalDataListeners.delete(listener);
}

function appendTerminalData(sessionId: string, data: string): void {
  const existing = terminalBufferBySession.get(sessionId) ?? "";
  let next = existing + data;
  if (next.length > TERMINAL_BUFFER_MAX_CHARS) {
    next = next.slice(next.length - TERMINAL_BUFFER_MAX_CHARS);
  }
  terminalBufferBySession.set(sessionId, next);
  for (const listener of terminalDataListeners) listener(sessionId, data);
}

/**
 * M5 Round E(需求4):「目前實際要顯示的已啟用 Claude model 清單」的唯一
 * 資料流入口——ProfileCreateDialog(選 model 建 profile)與 ChatView 的
 * `ModelControl`(對話中切換 model)都必須呼叫這個 selector,不要各自實作
 * 一份判斷邏輯,否則兩處對「設定改了之後該顯示哪些 model」的認知會漂移。
 *
 * 這輪起**不再讀寫死的 `KNOWN_CLAUDE_MODELS`**(該清單會隨 Anthropic 發布新
 * model/棄用舊 model 而過時,見 apps/core/src/detect/agent-detector.ts
 * `detectClaudeAgentSdk()` 同一輪的理由)——改讀 `detectedAgents` 裡
 * `key==="claude-agent-sdk"` 這筆的 `models`(即時查詢 Anthropic Models API
 * 拿到的清單,查不到就是空陣列,見該函式的 fail-soft 設計)。
 *
 * 語意:`enabledModelIds` 空陣列時視為「全部啟用」,回傳偵測到的完整清單;
 * 非空時只回傳交集(依偵測清單原本的順序,忽略 `enabledModelIds` 內任何不
 * 存在於偵測清單的 id)。
 *
 * 這輪起:即時查詢清單(`sdkEntry?.models`)之上疊了 `CLAUDE_MODEL_ALIASES`
 * 當底線(見 known-models.ts 的檔案註解——這些是 claude CLI/SDK 原生支援、
 * 永遠指向「目前最新版」的別名,不是會過期的日期快照 model ID)。沒有
 * `ANTHROPIC_API_KEY`(只用 `claude login` 本機登入)時即時查詢必定拿不到
 * 清單,過去這裡會直接回傳空陣列、選單完全空白;現在至少還有這幾個別名可
 * 選。真的查得到即時清單時,即時清單附加在別名之後(`mergeModelsById` 以
 * id 去重,別名的 id 如 "opus" 不會跟即時清單的日期快照 id 撞名,兩者並存,
 * 不互相覆蓋)。
 */
export function selectEnabledClaudeModels(detectedAgents: AgentDetectionEntry[], enabledModelIds: string[]): KnownClaudeModel[] {
  const sdkEntry = detectedAgents.find((a) => a.key === "claude-agent-sdk");
  const detected = sdkEntry?.models ?? [];
  const withAliasFloor = mergeModelsById(CLAUDE_MODEL_ALIASES, detected);
  if (enabledModelIds.length === 0) return withAliasFloor;
  const enabled = new Set(enabledModelIds);
  return withAliasFloor.filter((m) => enabled.has(m.id));
}

/**
 * 這輪新增(provider 目錄重構):「目前的 provider 目錄解析結果」的唯一入口
 * ——ProfileCreateDialog(選 provider 建 profile)與 SettingsDialog(provider
 * 管理)都必須呼叫這個 selector,不要各自重新呼叫 `resolveProviders()`,避免
 * 兩處對「合併偵測結果 + 使用者偏好」的認知漂移(呼應 `selectEnabledClaudeModels()`
 * 既有的單一資料流原則)。
 *
 * 注意:輸入的 `providerPrefs` 是 gateway 回傳的**遮罩版**(env 值固定
 * `"***"`)——`resolveProviders()` 本身對 `env` 完全不關心(它只影響
 * `models`/`enabled`/`order`/`label`,不讀 `env`),所以拿遮罩版本來算完全
 * 沒問題;只是產出的 `ResolvedProvider` 不含任何 env 資訊可用(UI 需要顯示
 * "已設定哪些 key" 時,直接讀 `providerPrefs[id]?.env` 的 key 名稱)。
 */
export function selectResolvedProviders(
  detectedAgents: AgentDetectionEntry[],
  providerPrefs: Record<string, ProviderPrefs>,
): ResolvedProvider[] {
  return resolveProviders(BUILTIN_PROVIDERS, detectedAgents, providerPrefs);
}

/**
 * 「這個 profile 應該顯示哪些可選 model」的唯一入口——同時涵蓋:
 *   - 這輪之後建立、帶 `providerId` 的新 profile:讀該 provider 目前已啟用的
 *     模型清單(`resolveProviders()` 已經套用 `enabledModelIds` 過濾)。
 *   - 這輪之前建立、沒有 `providerId` 的舊 profile:退回舊行為——
 *     `software==="claude-agent-sdk"` 用 `selectEnabledClaudeModels()`,其餘
 *     一律回傳空陣列(與過去 ChatView/ProfileCreateDialog 只支援 Claude
 *     model 選單的既有行為一致,不改變舊 profile 的既有觀感)。
 */
export function selectProviderModels(
  profile: Pick<AgentProfile, "providerId" | "software"> | undefined,
  detectedAgents: AgentDetectionEntry[],
  providerPrefs: Record<string, ProviderPrefs>,
  enabledModelIds: string[],
): ProviderModel[] {
  if (!profile) return [];
  if (profile.providerId) {
    const resolved = selectResolvedProviders(detectedAgents, providerPrefs);
    const provider = resolved.find((p) => p.id === profile.providerId);
    if (provider) return provider.models;
  }
  if (profile.software === "claude-agent-sdk") return selectEnabledClaudeModels(detectedAgents, enabledModelIds);
  return [];
}

/**
 * S3a §7.5 ④:「這條 session 到底該不該顯示用量區塊」的唯一入口——ChatView
 * (累計 $ 徽章)與 SessionList(context 使用率徽章)都必須走這兩個 selector,
 * 不要各自判斷,否則兩處對「unknown 要不要顯示」的認知會漂移(呼應
 * `selectEnabledClaudeModels()` 既有的單一資料流原則)。
 *
 * 收斂規則見 packages/shared 的 `resolveCapabilitySupport()`:靜態宣告 +
 * 「這條 session 實際收到過該事件沒有」。三態各自的 UI 意義:
 *
 *   - `"supported"`:**顯示**用量區塊。還沒有值時顯示 `—` 佔位(這個後端確定
 *     會報,只是還沒送到,佔位是誠實的「等待中」而不是空值)。
 *   - `"unknown"` / `"unsupported"`:**完全不渲染**。這正是這輪要修掉的謊——
 *     ACP + Claude Code 的組合永遠不會有值,先畫一個空欄位等於告訴使用者
 *     「這裡有花費可看」然後永遠空著。
 *
 * `capabilities` 為 undefined(能力查詢還沒回來/失敗)時 `resolveCapabilitySupport()`
 * 會給 `"unknown"` ⇒ 一樣不顯示,能力抵達後的下一次渲染自然補上,不阻塞畫面
 * (與 SessionView 對 capabilities 未抵達的處理一致)。
 */
export function selectUsageReporting(
  capabilities: AdapterCapabilities | undefined,
  usage: SessionUsage | undefined,
): CapabilitySupport {
  return resolveCapabilitySupport(capabilities?.usageReporting, Boolean(usage?.usageSeen));
}

export function selectContextReporting(
  capabilities: AdapterCapabilities | undefined,
  usage: SessionUsage | undefined,
): CapabilitySupport {
  return resolveCapabilitySupport(capabilities?.contextReporting, Boolean(usage?.contextSeen));
}

function upsertToolItem(
  items: ChatItem[],
  toolCallId: string,
  patch: Partial<Extract<ChatItem, { kind: "tool" }>>,
  createdAt: number,
): ChatItem[] {
  const idx = items.findIndex((item) => item.kind === "tool" && item.id === toolCallId);
  if (idx === -1) {
    items.push({
      kind: "tool",
      id: toolCallId,
      toolName: "",
      isError: false,
      status: "running",
      createdAt,
      ...patch,
    });
    return items;
  }
  const existing = items[idx] as Extract<ChatItem, { kind: "tool" }>;
  items[idx] = { ...existing, ...patch };
  return items;
}

function messageRecordsToItems(messages: MessageRecord[]): ChatItem[] {
  const items: ChatItem[] = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      items.push({ kind: "user", id: msg.id, content: msg.content, createdAt: msg.createdAt });
    } else if (msg.role === "assistant") {
      items.push({ kind: "assistant", id: msg.id, content: msg.content, createdAt: msg.createdAt, streaming: false });
    } else if (msg.role === "system") {
      items.push({ kind: "system", id: msg.id, content: msg.content, createdAt: msg.createdAt });
    } else if (msg.role === "tool") {
      try {
        const parsed = JSON.parse(msg.content) as {
          kind: "call" | "result";
          toolCallId: string;
          toolName: string;
          input?: unknown;
          output?: unknown;
          isError?: boolean;
        };
        if (parsed.kind === "call") {
          upsertToolItem(
            items,
            parsed.toolCallId,
            { toolName: parsed.toolName, input: parsed.input, status: "running" },
            msg.createdAt,
          );
        } else {
          upsertToolItem(
            items,
            parsed.toolCallId,
            { toolName: parsed.toolName, output: parsed.output, isError: Boolean(parsed.isError), status: "done" },
            msg.createdAt,
          );
        }
      } catch {
        // 忽略無法解析的舊資料
      }
    }
  }
  return items;
}

export const useSessionStore = create<SessionStoreState>((set, get) => ({
  status: "connecting",
  profiles: [],
  sessions: [],
  currentSessionId: null,
  itemsBySession: {},
  pendingPermissions: [],
  sessionUsage: {},
  capabilitiesBySoftware: {},
  detectedAgents: [],
  detectingAgents: false,
  enabledModelIds: [],
  providerPrefs: {},
  effectiveConfig: null,
  costSummaryBySession: {},
  gatewayCapabilities: { canToggleAuto: false, canEnableYolo: false, canEditPolicy: false, canManageProfiles: false },

  connect: () => {
    client.onStatus((status) => set({ status }));
    client.onPush((push) => {
      if (push.channel === "session-event") {
        handleSessionEvent(set, get, push.payload as SessionEventEnvelope);
      } else if (push.channel === "session-updated") {
        const session = push.payload as Session;
        set((state) => ({
          sessions: state.sessions.some((s) => s.id === session.id)
            ? state.sessions.map((s) => (s.id === session.id ? session : s))
            : [...state.sessions, session],
        }));
      } else if (push.channel === "session-list-updated") {
        void get().refreshSessions();
      } else if (push.channel === "permission-resolved") {
        handlePermissionResolved(set, push.payload as PermissionResolvedPush);
      } else if (push.channel === "enforcement-notification") {
        handleEnforcementNotification(push.payload as EnforcementNotificationPush);
      }
    });
    client.connect();
    void get().refreshProfiles();
    void get().refreshSessions();
    void get().detectAgents();
    void get().loadEnabledModels();
    void get().loadProviderPrefs();
    void get().loadEffectiveConfig();
    void get().loadGatewayCapabilities();
  },

  refreshProfiles: async () => {
    const raw = await client.call("profile.list", {});
    const { profiles } = ProfileListResultSchema.parse(raw);
    set({ profiles });
    // 預先把目前所有 profile 用到的 software 能力都查一遍、快取起來,
    // SessionView 才能在使用者選到某個 session 的當下就同步讀到快取,不用
    // 每次切換 session 都先等一次 RPC 往返才知道要渲染哪種視圖。
    for (const software of new Set(profiles.map((p) => p.software))) {
      void get().fetchCapabilities(software);
    }
  },

  refreshSessions: async () => {
    const raw = await client.call("session.list", {});
    const { sessions } = SessionListResultSchema.parse(raw);
    set({ sessions });
  },

  fetchCapabilities: async (software) => {
    const cached = get().capabilitiesBySoftware[software];
    if (cached) return cached;
    try {
      const raw = await client.call("adapter.capabilities", { software });
      const { capabilities } = AdapterCapabilitiesResultSchema.parse(raw);
      set((state) => ({
        capabilitiesBySoftware: { ...state.capabilitiesBySoftware, [software]: capabilities },
      }));
      return capabilities;
    } catch {
      // Gateway 尚未連線或查詢失敗:回傳 undefined,呼叫端(SessionView)會
      // 安全地退回聊天視圖,不阻塞畫面。
      return undefined;
    }
  },

  detectAgents: async () => {
    set({ detectingAgents: true });
    try {
      const raw = await client.call("env.detectAgents", {});
      const { agents } = DetectAgentsResultSchema.parse(raw);
      set({ detectedAgents: agents });
    } catch {
      // 尚未連線/RPC 失敗:保留舊值(通常是初始的空陣列),讀取端(ChatView
      // 的 model 下拉、SettingsDialog)遇到空陣列會安全地顯示「目前沒有可選
      // model」或「尚未偵測」,不阻塞畫面,也不會拿一份寫死的舊清單充數。
    } finally {
      set({ detectingAgents: false });
    }
  },

  createSession: async (agentProfileId, workingDir, title, teamMemberId, agentOverride) => {
    const raw = await client.call("session.create", { agentProfileId, workingDir, title, teamMemberId, agentOverride });
    const { session } = SessionCreateResultSchema.parse(raw);
    set((state) => ({
      sessions: [...state.sessions, session],
      currentSessionId: session.id,
      itemsBySession: { ...state.itemsBySession, [session.id]: [] },
    }));
    void get().fetchCapabilities(session.adapterType);
  },

  spawnChild: async (parentSessionId, prompt, agentProfileId, title, agentOverride) => {
    const parent = get().sessions.find((s) => s.id === parentSessionId);
    if (!parent) return;
    const raw = await client.call("session.spawnChild", {
      parentSessionId,
      agentProfileId,
      prompt,
      title,
      agentOverride,
    });
    const { session } = SessionCreateResultSchema.parse(raw);
    set((state) => ({
      sessions: [...state.sessions, session],
      itemsBySession: { ...state.itemsBySession, [session.id]: [] },
    }));
    void get().fetchCapabilities(session.adapterType);
  },

  createProfile: async (input) => {
    const raw = await client.call("profile.create", input);
    const { profile } = ProfileCreateResultSchema.parse(raw);
    set((state) => ({ profiles: [...state.profiles, profile] }));
    void get().fetchCapabilities(profile.software);
    return profile;
  },

  deleteProfile: async (id) => {
    await client.call("profile.delete", { id });
    set((state) => ({ profiles: state.profiles.filter((p) => p.id !== id) }));
  },

  selectSession: async (sessionId) => {
    set({ currentSessionId: sessionId });
    const raw = await client.call("session.history", { sessionId });
    const { messages } = SessionHistoryResultSchema.parse(raw);
    set((state) => ({
      itemsBySession: { ...state.itemsBySession, [sessionId]: messageRecordsToItems(messages) },
    }));
  },

  sendPrompt: async (text) => {
    const sessionId = get().currentSessionId;
    if (!sessionId) return;
    set((state) => ({
      itemsBySession: {
        ...state.itemsBySession,
        [sessionId]: [
          ...(state.itemsBySession[sessionId] ?? []),
          { kind: "user", id: crypto.randomUUID(), content: text, createdAt: Date.now() },
        ],
      },
    }));
    await client.call("session.sendPrompt", { sessionId, prompt: { text } });
  },

  sendTerminalInput: (text) => {
    const sessionId = get().currentSessionId;
    if (!sessionId) return;
    void client.call("session.sendPrompt", { sessionId, prompt: { text } });
  },

  sendTerminalRawInput: (data) => {
    const sessionId = get().currentSessionId;
    if (!sessionId) return;
    void client.call("session.terminalInput", { sessionId, data });
  },

  resizeTerminal: (sessionId, cols, rows) => {
    void client.call("session.resizeTerminal", { sessionId, cols, rows });
  },

  interrupt: () => {
    const sessionId = get().currentSessionId;
    if (!sessionId) return;
    void client.call("session.interrupt", { sessionId });
  },

  resolvePermission: (requestId, decision, rememberRule) => {
    void client.call("permission.resolve", { requestId, decision, rememberRule });
    set((state) => ({
      pendingPermissions: state.pendingPermissions.filter((p) => p.requestId !== requestId),
    }));
  },

  setSessionPermissionMode: async (sessionId, mode) => {
    const raw = await client.call("session.setPermissionMode", { sessionId, mode });
    const { mode: appliedMode, yoloExpiresAt } = SessionSetPermissionModeResultSchema.parse(raw);
    // 樂觀地立即更新本地 sessions 陣列(不等下一次 "session-updated" 推播)
    // ——即使晚一點推播抵達,內容會是一樣的值,不會互相打架。
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === sessionId ? { ...s, permissionMode: appliedMode, yoloExpiresAt } : s,
      ),
    }));
  },

  deleteSession: async (sessionId) => {
    await client.call("session.delete", { sessionId });
    const wasCurrent = get().currentSessionId === sessionId;
    set((state) => {
      const sessions = state.sessions.filter((s) => s.id !== sessionId);
      const itemsBySession = { ...state.itemsBySession };
      delete itemsBySession[sessionId];
      return {
        sessions,
        itemsBySession,
        currentSessionId: wasCurrent ? null : state.currentSessionId,
      };
    });
    if (wasCurrent) {
      const next = get().sessions[0];
      if (next) {
        await get().selectSession(next.id);
      }
    }
  },

  setSessionModel: async (sessionId, model) => {
    const raw = await client.call("session.setModel", { sessionId, model });
    const { session } = SessionSetModelResultSchema.parse(raw);
    set((state) => ({
      sessions: state.sessions.some((s) => s.id === session.id)
        ? state.sessions.map((s) => (s.id === session.id ? session : s))
        : [...state.sessions, session],
      // 本地立即補一則系統訊息(後端已經把同樣內容的訊息 persist 到 DB,見
      // SessionManager.setSessionModel()),讓使用者不需要等下一次
      // selectSession() 重新載入 history 就能立刻看到「換過 model」的提示。
      itemsBySession: {
        ...state.itemsBySession,
        [sessionId]: [
          ...(state.itemsBySession[sessionId] ?? []),
          {
            kind: "system",
            id: crypto.randomUUID(),
            content: `已切換模型至 ${model},後續對話由新模型接續`,
            createdAt: Date.now(),
          },
        ],
      },
    }));
  },

  setSessionEffort: async (sessionId, effort) => {
    const raw = await client.call("session.setEffort", { sessionId, effort });
    const { session } = SessionSetEffortResultSchema.parse(raw);
    set((state) => ({
      sessions: state.sessions.some((s) => s.id === session.id)
        ? state.sessions.map((s) => (s.id === session.id ? session : s))
        : [...state.sessions, session],
      // 比照上面的 setSessionModel():本地立即補一則系統訊息(後端已經把
      // 同樣內容的訊息 persist 到 DB,見 SessionManager.setSessionEffort())。
      itemsBySession: {
        ...state.itemsBySession,
        [sessionId]: [
          ...(state.itemsBySession[sessionId] ?? []),
          {
            kind: "system",
            id: crypto.randomUUID(),
            content: `已切換思考程度至 ${effort},後續對話由新設定接續`,
            createdAt: Date.now(),
          },
        ],
      },
    }));
  },

  loadEnabledModels: async () => {
    try {
      const raw = await client.call("settings.getEnabledModels", {});
      const { enabledModelIds } = SettingsGetEnabledModelsResultSchema.parse(raw);
      set({ enabledModelIds });
    } catch {
      // 尚未連線/RPC 失敗:保留舊值(初始為空陣列 = 全部啟用),讀取端
      // (selectEnabledClaudeModels)會安全地退回顯示偵測到的清單全部
      // (detectedAgents 內 claude-agent-sdk 的 models,可能是空陣列)。
    }
  },

  setEnabledModels: async (enabledModelIds) => {
    const raw = await client.call("settings.setEnabledModels", { enabledModelIds });
    const parsed = SettingsSetEnabledModelsResultSchema.parse(raw);
    set({ enabledModelIds: parsed.enabledModelIds });
  },

  loadProviderPrefs: async () => {
    try {
      const raw = await client.call("settings.getProviderPrefs", {});
      const { prefs } = SettingsGetProviderPrefsResultSchema.parse(raw);
      set({ providerPrefs: prefs });
    } catch {
      // 尚未連線/RPC 失敗:保留舊值(初始為空物件 = 全部維持目錄預設)。
    }
  },

  setProviderPrefs: async (providerId, patch) => {
    const raw = await client.call("settings.setProviderPrefs", { providerId, patch });
    const { prefs } = SettingsSetProviderPrefsResultSchema.parse(raw);
    set({ providerPrefs: prefs });
  },

  loadEffectiveConfig: async () => {
    try {
      const raw = await client.call("config.getEffective", {});
      const { effective } = ConfigGetEffectiveResultSchema.parse(raw);
      set({ effectiveConfig: effective });
    } catch {
      // 尚未連線/RPC 失敗:保留舊值(初始為 null),SettingsDialog 顯示
      // 「載入中/尚未連線」,不阻塞其餘畫面。
    }
  },

  fetchCostSummary: async (sessionId) => {
    try {
      const raw = await client.call("cost.getSummary", { sessionId });
      const summary = CostGetSummaryResultSchema.parse(raw);
      set((state) => ({ costSummaryBySession: { ...state.costSummaryBySession, [sessionId]: summary } }));
    } catch {
      // 尚未連線/RPC 失敗:保留舊值,不阻塞畫面(同 fetchCapabilities 既有慣例)。
    }
  },

  setConfigFile: async (patch) => {
    const raw = await client.call("config.setFile", patch);
    const parsed = ConfigSetFileResultSchema.parse(raw);
    return { changedFields: parsed.changedFields, requiresRestart: parsed.requiresRestart };
  },

  loadGatewayCapabilities: async () => {
    try {
      const raw = await client.call("gateway.capabilities", {});
      const { capabilities } = GatewayCapabilitiesResultSchema.parse(raw);
      set({ gatewayCapabilities: capabilities });
    } catch {
      // 尚未連線/RPC 失敗:保留舊值(初始全 false,最保守——寧可誤判成遠端
      // 而隱藏控制項,也不要誤判成本機而顯示出使用者按了會被拒絕的按鈕)。
    }
  },
}));

/**
 * 收到 core 推播的 `permission-resolved` 事件時,把該筆請求從 pendingPermissions
 * 移除 —— 涵蓋「不是自己這個 client 觸發的解決」情境(逾時自動 deny、或未來
 * 多 client 下另一個 client 先回覆了),避免彈窗殘留在畫面上。若是逾時自動
 * deny,額外在該 session 的聊天串加一則 system 訊息告知使用者。
 */
function handlePermissionResolved(
  set: (fn: (state: SessionStoreState) => Partial<SessionStoreState>) => void,
  payload: PermissionResolvedPush,
): void {
  set((state) => {
    const next: Partial<SessionStoreState> = {
      pendingPermissions: state.pendingPermissions.filter((p) => p.requestId !== payload.requestId),
    };
    if (payload.source === "timeout") {
      const items = [...(state.itemsBySession[payload.sessionId] ?? [])];
      items.push({
        kind: "system",
        id: crypto.randomUUID(),
        content: "權限請求已逾時,自動拒絕",
        createdAt: Date.now(),
      });
      next.itemsBySession = { ...state.itemsBySession, [payload.sessionId]: items };
    }
    return next;
  });
}

/**
 * S11(Notification)新增:收到 `"enforcement-notification"` push 後,只在
 * Electron 場景(`window.deskmony?.notify` 存在)呼叫 IPC 觸發原生桌面通知
 * ——純瀏覽器 client 沒有這個橋接,靜靜略過(見 global.d.ts 的
 * `notify?`/`onNotificationClick?` 註解:webhook 通道不受這個限制,browser
 * client 仍然可能透過 webhook 被通知到,只是沒有桌面彈窗)。title/body 用
 * `formatEnforcementNotificationText()` 算,單一份格式邏輯(見
 * packages/shared/src/notification.ts 頂端說明,避免 core/desktop 各寫一份
 * 而漂移)。這裡不驗證 payload 是否經過 zod 解析失敗就整批丟棄——
 * `EnforcementNotificationPushSchema.parse()` 丟例外時讓呼叫端的 try/catch
 * 之外的邏輯自然中止,不影響其餘 push 的處理(`onPush` 的其他 channel 分支
 * 不受影響,因為都在同一個 if/else if 鏈,parse 例外只會讓這個分支中止)。
 */
function handleEnforcementNotification(rawPayload: unknown): void {
  if (!window.deskmony?.notify) return;
  let payload: EnforcementNotificationPush;
  try {
    payload = EnforcementNotificationPushSchema.parse(rawPayload);
  } catch {
    return;
  }
  const { title, body } = formatEnforcementNotificationText(payload);
  void window.deskmony.notify({ title, body, sessionId: payload.sessionId });
}

function handleSessionEvent(
  set: (fn: (state: SessionStoreState) => Partial<SessionStoreState>) => void,
  get: () => SessionStoreState,
  envelope: SessionEventEnvelope,
): void {
  const { sessionId, event } = envelope;

  if (event.type === "terminal-data") {
    // pty 直通輸出:刻意不走 zustand 的 set()(見上方 appendTerminalData 的
    // 註解),避免高頻小片段輸出拖垮整個 store 的 re-render。
    appendTerminalData(sessionId, event.data);
    return;
  }

  // S3a(usage-metering)L4 §4:usage/context-usage 兩種事件只更新
  // `sessionUsage`,不進 `itemsBySession` 的聊天時間軸(這不是一則對話訊息)。
  // 兩者都是「直接覆寫最新值」語意(累計值本身已經是累計,gauge 本來就該
  // 覆寫,見 SessionUsage 型別註解),故不需要走下面 switch 那種需要找索引
  // 累加的邏輯,提前 return。
  if (event.type === "usage") {
    set((state) => ({
      sessionUsage: {
        ...state.sessionUsage,
        [sessionId]: {
          ...state.sessionUsage[sessionId],
          costAmount: event.costAmount,
          costCurrency: event.costCurrency,
          // 收到事件本身就是「這個後端會報 usage」的證據,與 payload 有沒有
          // cost 無關(見 SessionUsage.usageSeen 註解)。
          usageSeen: true,
        },
      },
    }));
    // S3b(CostGovernor):這條 session 的 rollup 剛剛可能變了(core 端的
    // `CostGovernor.recordUsage()` 與這個事件是同一個來源),順便拉一次最新的
    // 成本摘要——見 `fetchCostSummary()` 註解「用輪詢,不是 server push」。
    // fire-and-forget,失敗不影響這個事件本身的處理。
    void get().fetchCostSummary(sessionId);
    return;
  }
  if (event.type === "context-usage") {
    set((state) => ({
      sessionUsage: {
        ...state.sessionUsage,
        [sessionId]: {
          ...state.sessionUsage[sessionId],
          contextUsed: event.used,
          contextSize: event.size,
          contextSeen: true,
        },
      },
    }));
    return;
  }

  set((state) => {
    const items = [...(state.itemsBySession[sessionId] ?? [])];

    switch (event.type) {
      case "message-delta": {
        const idx = items.findIndex((item) => item.kind === "assistant" && item.id === event.messageId);
        if (idx === -1) {
          items.push({
            kind: "assistant",
            id: event.messageId,
            content: event.delta,
            createdAt: envelope.timestamp,
            streaming: !event.done,
          });
        } else {
          const existing = items[idx] as Extract<ChatItem, { kind: "assistant" }>;
          items[idx] = {
            ...existing,
            content: existing.content + event.delta,
            streaming: !event.done,
          };
        }
        break;
      }
      case "tool-call": {
        upsertToolItem(
          items,
          event.toolCallId,
          { toolName: event.toolName, input: event.input, status: "running" },
          envelope.timestamp,
        );
        break;
      }
      case "tool-result": {
        upsertToolItem(
          items,
          event.toolCallId,
          { output: event.output, isError: event.isError, status: "done" },
          envelope.timestamp,
        );
        break;
      }
      case "permission-request": {
        const pending: PendingPermission = { ...event, sessionId };
        return {
          itemsBySession: { ...state.itemsBySession, [sessionId]: items },
          pendingPermissions: [...state.pendingPermissions, pending],
        };
      }
      case "completed": {
        // message-delta 的 done:true 已經把 streaming 標記關掉;這裡不用額外處理內容,
        // 只是保險起見再次確保最後一則 assistant 訊息不是 streaming 狀態。
        const lastAssistantIdx = [...items].reverse().findIndex((item) => item.kind === "assistant");
        if (lastAssistantIdx !== -1) {
          const realIdx = items.length - 1 - lastAssistantIdx;
          const existing = items[realIdx] as Extract<ChatItem, { kind: "assistant" }>;
          items[realIdx] = { ...existing, streaming: false };
        }
        break;
      }
      case "error": {
        items.push({
          kind: "system",
          id: crypto.randomUUID(),
          content: `[錯誤] ${event.message}`,
          createdAt: envelope.timestamp,
        });
        break;
      }
    }

    return { itemsBySession: { ...state.itemsBySession, [sessionId]: items } };
  });
}
