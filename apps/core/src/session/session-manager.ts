import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, access, writeFile } from "node:fs/promises";
import path from "node:path";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { NexusDb } from "@deskmony/db";
import { sessions as sessionsTable, messages as messagesTable } from "@deskmony/db";
import type { AdapterRegistry, AgentAdapter, AgentHandle } from "@deskmony/adapters";
import {
  DeskmonyError,
  ErrorCodes,
  type AdapterCapabilities,
  type AgentLaunchSpec,
  type AgentSoftware,
  type CreateSessionInput,
  type DialogAnswer,
  type EffortLevel,
  type MessageBudgetConfig,
  type MessageOrigin,
  type MessageRecord,
  type NetworkSessionSummary,
  type PermissionResolvedPush,
  type PolicyAddRuleInput,
  type PolicyRule,
  type PolicyUpdatedPush,
  type PromptAttachment,
  type PromptInput,
  type ReadSessionResult,
  type Session,
  type SessionEventEnvelope,
  type SessionPermissionMode,
  type SessionStatus,
  type SlashCommandInfo,
  type UserDialogResolvedPush,
  MessageOriginSchema,
  READ_SESSION_DEFAULT_LIMIT,
  READ_SESSION_MAX_CONTENT_CHARS,
  READ_SESSION_MAX_LIMIT,
  softwareCanUseTools,
} from "@deskmony/shared";
import { storedLaunchFromSpec, type AgentCatalog, type StoredLaunchInfo } from "../agents/agent-catalog.js";
import type { PermissionGateway } from "../permissions/permission-gateway.js";
import { getProviderEnv, type SettingsStore } from "../settings/settings-store.js";
import type { PolicyEngine, PermissionRequest, ExecContext } from "../permissions/policy-engine.js";
import type { AuditLog } from "../enforcement/audit-log.js";
import type { Notifier } from "../enforcement/notifier.js";
import { appendPolicyRule, removePolicyRule as removePolicyRuleFile } from "../config/config-file-writer.js";
import type { TurnLimiter } from "../cost/turn-limiter.js";
import type { CostGovernor } from "../cost/cost-governor.js";
import { MessageChainBudget } from "./message-chain-budget.js";
import { buildEnvelopeForOrigin } from "./session-envelope.js";
import {
  DEFAULT_YOLO_DURATION_MS as YOLO_DEFAULT,
  SessionPermissionCoordinator,
  type SessionPermissionState,
} from "./session-permission-coordinator.js";

/**
 * 2026-09-04(稽核修補,拆 God object 第一塊):`DEFAULT_YOLO_DURATION_MS` 與
 * `SessionPermissionState` 已搬到 `./session-permission-coordinator.ts` ——
 * 它們屬於權限狀態機,不屬於 session 生命週期。這裡原樣 re-export,讓既有的
 * `from "./session-manager.js"` 匯入點不需要跟著改。
 */
export { DEFAULT_YOLO_DURATION_MS } from "./session-permission-coordinator.js";
export type { SessionPermissionState } from "./session-permission-coordinator.js";

/**
 * S7 L4 §2.1:`ExecContext` 的 `attended`/`local` 兩個欄位是**環境事實**,
 * 唯一知道這件事的是 Gateway(它才看得到有哪些 WS 連線、來源是不是
 * loopback)。但 SessionManager 建構時 Gateway 還不存在(Gateway 的建構子
 * 需要 SessionManager),所以這裡只宣告一個**最小介面**,由
 * `apps/core/src/index.ts` 在 Gateway 建好之後用 `setClientPresence()` 事後
 * 注入——「先建構、事後用 setter 注入」的解耦手法,不製造
 * 建構子循環依賴,也讓 SessionManager 不需要 import `WsGateway`。
 *
 * 實作見 `apps/core/src/gateway/ws-gateway.ts` 的同名方法(含「不確定時倒向
 * 哪一邊」的完整理由)。
 */
export interface ClientPresencePort {
  /** 現在有沒有任何「看得到權限彈窗」的 client 連線中?→ `ExecContext.attended` */
  hasConnectedClient(): boolean;
  /** 現在有沒有任何**遠端**(非 loopback)client 連線中?→ `ExecContext.local` 的補數 */
  hasRemoteClient(): boolean;
}

/**
 * pty session(`capabilities().terminal === true`)沒有回合邊界 ——
 * `GenericPtyAdapter` 只會持續送出 `terminal-data`,不會像
 * `ClaudeAgentSdkAdapter`/`AcpAdapter` 那樣在一輪結束時送出 `completed`。
 * `sendPrompt()` 後先進入 busy,之後每收到一次 `terminal-data` 就把這個
 * 「靜止計時器」延後;超過這段時間沒有新輸出,才視為這一輪「大致執行完了」
 * 並轉回 idle。這是活動量測(activity-based quiescence)的簡化實作,不是
 * 真正理解終端輸出語意(pty 無法知道「這個 CLI 是不是還在等你按下一個
 * 鍵」),詳見 README 對應章節的設計說明。
 */
const PTY_IDLE_TIMEOUT_MS = 800;

/**
 * S8 L4 §3.1:專案筆記的約定位置——**相對於 session 的 workingDir**(筆記隨專案
 * 進 git,見 agent-lifecycle_detail.md §3.1)。⚠️ 這與家目錄的 `~/.deskmony/`(S1 hard-deny
 * 的政策/設定目錄)完全是兩回事,不可混淆——這裡一律是 workingDir 底下的相對
 * 路徑,不會、也不該指到家目錄。
 */
const NOTES_DIR_SEGMENTS = [".deskmony", "notes"] as const;

/** §3.1:確保 `<workingDir>/.deskmony/notes/` 存在,且至少有一個空的
 *  `team.md`——避免 agent 因為路徑不存在而困惑(§3.2)。**只建立目錄結構,
 *  絕不讀取/回傳其內容**——內容留給 agent 自己用既有的檔案工具讀寫,平台只
 *  負責「指路」(§3.2「指路而非注入內容」的核心紀律)。失敗時只記警告,不
 *  阻擋 session 啟動(筆記慣例是加分項,不是啟動的硬性前提)。 */
async function ensureNotesDir(workingDir: string): Promise<void> {
  const notesDir = path.join(workingDir, ...NOTES_DIR_SEGMENTS);
  await mkdir(notesDir, { recursive: true });
  const teamMdPath = path.join(notesDir, "team.md");
  try {
    await access(teamMdPath);
  } catch {
    await writeFile(teamMdPath, "# 團隊筆記\n\n(尚無內容)\n", "utf-8");
  }
}

/** §3.2:附加(不取代)在 systemPrompt 尾端的「指路」段落,文字比照 L4 規格。
 *  2026-10-02(P2):措辭改成不提 team 的中性說法(團隊/team 概念已隨 P1 移除);`team.md`
 *  這個檔名為了相容既有專案目錄仍然會被建立(見 `ensureNotesDir()`),但指路文字不再點名它。 */
function buildNotesPointerBlock(displayName: string): string {
  return [
    "【專案筆記】",
    "這個專案的筆記位於 .deskmony/notes/(相對於工作目錄):",
    "- 該目錄下的共用筆記(例如既有的 team.md):跨 session 共用的專案慣例與決策紀錄",
    `- ${displayName}.md:你這個 agent 的個人筆記`,
    "開始工作前先讀取相關筆記;學到值得跨任務保留的結論時,寫回筆記。",
    "筆記會進 git,請像寫程式碼一樣審慎。",
  ].join("\n");
}

/** 個人筆記的檔名(`<name>.md`)用 provider 的顯示名稱——不能含檔名非法字元。 */
function toNoteFileName(label: string): string {
  const cleaned = label.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").trim();
  return cleaned.length > 0 ? cleaned : "agent";
}

function withNotesPointer(existingSystemPrompt: string | undefined, displayName: string): string {
  const block = buildNotesPointerBlock(displayName);
  return existingSystemPrompt && existingSystemPrompt.trim().length > 0
    ? `${existingSystemPrompt}\n\n${block}`
    : block;
}

/**
 * 排在某個 session 身上、等它下一次 idle 才送的跨 session 訊息(見 `SessionManager.pendingIdleInjection`)。
 * `text` 是原始 message 本體(不含信封);`origin` 決定信封樣板與 UI 的「來自 <title>」標籤。
 */
interface PendingNetworkMessage {
  text: string;
  origin: MessageOrigin;
  chainId: string;
}

/** 一次 prompt 投遞帶的鏈/來源資訊(人類輸入只有 `chainId`;跨 session 訊息另帶 `origin` 與原始本體)。 */
interface PromptDelivery {
  chainId: string;
  /** 有值 = 這是別的 session 送來的(或使用者轉傳的)訊息,持久化時存在 `messages.origin`。 */
  origin?: MessageOrigin;
  /** 持久化用的原始 message 本體(送給 adapter 的是信封包裝後的 `prompt.text`)。省略時存 `prompt.text`。 */
  persistedText?: string;
}

interface RuntimeState {
  handle: AgentHandle;
  /** 這個 session 建立時依 spec.software 從 AdapterRegistry 選出的 adapter 實例。
   * 後續 sendPrompt/interrupt/resolvePermission/dispose 都必須透過它,不能假設
   * 全 core 只有單一 adapter(M2 Round A:多 adapter 並存,見 AdapterRegistry)。 */
  adapter: AgentAdapter;
  /** 累積中的 assistant 訊息文字(用於 completed 事件缺少 finalText 時的備援)。 */
  streamingText: string;
  /** 只有 terminal 能力的 adapter(pty)才會用到,見 PTY_IDLE_TIMEOUT_MS 說明。 */
  ptyIdleTimer?: ReturnType<typeof setTimeout>;
  /** S1(PolicyEngine)新增:這個 session 的 `providerId`/`workingDir`,
   * 供 permission-request 事件到達時組裝 `PermissionRequest`(providerId 供
   * 規則 scope 精確比對、workingDir 當作 hard-deny 的 worktree 邊界)——直接存
   * 在 RuntimeState 上,避免每次權限請求都多一次 DB 查詢 session 記錄。`ExecContext` 的三個欄位**不**來自這裡,見
   * `buildExecContext()`。(2026-10-02 P2:原本是 `agentProfileId`,權限判斷那段還要多查一次
   * `profiles.get()` 取 role——profile 移除後都不需要了。) */
  providerId: string;
  workingDir: string;
  /** S6(crash-recovery)L4 §4.1:這條 session 的後端持久化 session 識別碼
   *  (捕捉到之前是 undefined)——見 `persistBackendSessionId()`。 */
  backendSessionId?: string;
  /**
   * 2026-10-02(P3:session 網路):這個 session **目前這一輪**是被哪條訊息鏈觸發的(見
   * `message-chain-budget.ts`)。人類 prompt 開始處理時換成新鏈;收到帶 chain 的跨 session 訊息開始處理時設成
   * 那條鏈。agent 這一輪經 create_session/send_to_session 送出的訊息沿用它。只存記憶體,不落地。
   */
  currentChainId?: string;
  /**
   * 這輪(slash command)新增:這個 session 目前已知的 "/" 指令清單快取(見
   * `consumeEvents()` 的 `"available-commands"` case、`getSlashCommands()`)。
   * 純記憶體快取,不寫 DB——比照 `backendSessionId`/`streamingText` 的既有
   * 規模,core 行程重啟就重新來過。`undefined` 代表這個 session 至今**還沒
   * 收到過**任何一次 `available-commands` 事件(與下面 `slashCommandsObserved`
   * 搭配使用,理由見 `getSlashCommands()`)。
   */
  slashCommands?: SlashCommandInfo[];
  /** 見上方 `slashCommands` 註解——`true` 代表至少收到過一次推播(即使清單是
   *  空的),用來讓 `session.getSlashCommands` 的回應區分「還不知道」與「已
   *  確認是空清單」,對齊既有 usage/context-usage 事件的 observed 慣例。 */
  slashCommandsObserved: boolean;
  /**
   * 2026-09-17:已經計入回合硬上限、已經寫進 DB,但還沒收到 tool-result 的工具
   * 呼叫,key 是 toolCallId。`consumeEventsInner()` 的 `"tool-call"` case 靠它分辨
   * 「一次新的工具呼叫」與「同一個呼叫補上更完整的資訊」。
   *
   * `tool-call` 事件實際上是「以 toolCallId 為鍵的 upsert」——桌面端
   * `upsertToolItem()` 一直是這樣合併的,而有兩個 adapter 會對同一個呼叫送不只
   * 一次:
   *   - claude-sdk-adapter.ts:`content_block_start` 先送一次(input 還不知道),
   *     完整 assistant 訊息抵達時再送一次帶完整 input 的。
   *   - opencode-adapter.ts:tool part `pending` 時先送一次(opencode 這時 input
   *     一律是 `{}`),`running` 帶完整參數時再送一次。
   * core 過去對每個事件都 `recordToolCall()` + insert 一筆 row:Claude 的每次工具
   * 呼叫在回合硬上限裡被算兩次、歷史裡多一筆沒有 input 的 row;OpenCode 則是
   * adapter 只送 pending 那一次,歷史裡的 input 全部是 `{}`。
   *
   * 生命週期刻意收窄,不是整個 session 永久去重:收到該 toolCallId 的
   * tool-result 就移除,回合結束(completed/error,與 `turnLimiter.endTurn()`
   * 同一個位置)整個清空。去重只涵蓋「一個呼叫從開始到有結果」這段期間——後端
   * 在之後的步驟或回合重複使用同一個 id,那就是新的一次呼叫,照樣計數,不會變成
   * 繞過斷路器的缺口。
   */
  openToolCalls: Map<string, OpenToolCall>;
}

/** `RuntimeState.openToolCalls` 的值:那筆 `tool` 訊息的 row id,與目前已寫進
 *  DB 的 toolName/input(補資訊時拿來合併,不需要回頭讀 DB)。 */
interface OpenToolCall {
  rowId: string;
  toolName: string;
  input: unknown;
}

/**
 * ============================================================================
 * 拆解進度與剩餘計畫(2026-09-04 稽核修補)
 * ============================================================================
 *
 * 2026-09-03 的反方稽核把這個類別判定為典型 God object(當時 2,153 行、至少
 * 11 種職責),並指出**當時找到的最嚴重幾個 bug 全部出在這裡,不是巧合**:
 * 當一個類別同時是「事件迴圈」「狀態機」「政策引擎協調者」「多個斷路器的
 * 掛勾點」,任何一處遺漏都會淹沒在其他職責的程式碼裡。
 *
 * ---- 已完成 ----------------------------------------------------------------
 *
 * ✅ **權限/政策狀態機** → `./session-permission-coordinator.ts`
 *    `permissionState` Map + 模式切換 + 政策規則 CRUD + ExecContext 組裝 +
 *    YOLO 惰性過期。對外只需要四個回呼(是非題與通知),介面夠窄。
 *    抽出後 e2e 斷言全數通過,行為零漂移。
 *
 * ---- 已移除 ----------------------------------------------------------------
 *
 * 2026-10-02(P1:移除 team/task/看板,見 docs/DECISIONS.md §H):原本評估後
 * 「刻意不拆」的 **context checkpoint 重啟**(`performContextCheckpointRestart()`
 * 一帶)是 persistent team member 專屬機制——觸發條件是「session 綁定了
 * lifecycle=persistent 的 team member」,team 移除後沒有任何 session 能觸發它,
 * 整套(閾值判斷、寫筆記 prompt、respawn + 摘要)一併移除。
 *
 * ---- 剩餘的縫,依「介面寬度 ÷ 價值」排序 --------------------------------------
 *
 * 1. **SessionNetwork**(原 SubagentOrchestrator,2026-10-02 P3 起):`listSessionsForAgent` /
 *    `readSessionForAgent` / `createSessionFromAgent` / `sendToSessionFromAgent` / `forwardMessage` /
 *    `pendingIdleInjection` 佇列與 flush / 訊息鏈追蹤(鏈預算與信封已各自抽成 `message-chain-budget.ts`、
 *    `session-envelope.ts`)。介面中等寬(需要 spawnNewSession/sendPrompt/runtime 查詢),
 *    但職責邊界清楚,是下一個最值得動的。
 *
 * 2. **PTY 活動量測**:`scheduleIdleIfTerminal` / `clearPtyIdleTimer`。
 *    很小、很獨立,但價值也小 —— 適合順手做,不值得單獨排一輪。
 *
 * 3. **SessionEventRouter**(`consumeEventsInner()` 的 240 行 switch)。
 *    這是最大的一塊,也是最誘人的一塊,但它是所有副作用的分派中樞 ——
 *    在 1 做完之前動它,只會把耦合搬進一個新檔案。**建議最後做,不是最先做。**
 *
 * 每一步都應該比照這次:只搬不改、抽完立刻跑 `pnpm test:e2e` 確認全部斷言
 * 全綠。重構與修 bug 混在同一輪,會讓「測試掛了是搬壞的還是改壞的」無法區分。
 * ============================================================================
 *
 * SessionManager(ARCHITECTURE.md 3.3 節):
 *   「對每個 agent 成員建立/恢復/中斷 session;維護 session 狀態機
 *    (idle / busy / waiting-permission / error)」
 *
 * M2 Round A:一個 session 對應一個 AgentAdapter handle,但 adapter 種類依
 * `AgentLaunchSpec.software` 從建構子注入的 `AdapterRegistry` 動態選擇(M1 時
 * 是固定的單一 ClaudeAgentSdkAdapter)。session 中斷後重啟需要重新 spawn
 * (尚未支援 SDK 的 resume/continue)。
 */
export class SessionManager extends EventEmitter {
  private runtime = new Map<string, RuntimeState>();
  /**
   * 2026-09-04(稽核修補,拆 God object 第一塊):權限/政策狀態機。
   *
   * 原本是這個類別直接持有的 `permissionState` Map 加上六個方法;現在整塊
   * 搬到 `./session-permission-coordinator.ts`,這裡只保留一個實例。
   * 在建構子裡建立(不是建構子參數)——它需要的回呼(`isSessionRunning` 等)
   * 都指回這個類別自己,由外部注入反而會製造循環。
   */
  private readonly permissions: SessionPermissionCoordinator;
  /** S7 L4 §2.1:透過 `setClientPresence()` 事後注入(Gateway 的建構子需要
   *  SessionManager,不能反過來在建構子要求 Gateway)。
   *  見 `ClientPresencePort` 型別註解與 `buildExecContext()`。 */
  private clientPresence: ClientPresencePort | undefined;
  /**
   * S3b(CostGovernor)新增:`status === "waiting"` 的 session 各自進入
   * waiting 的時間戳(epoch ms)——`WaitingWatchdog` 的 T1/T2 掛起處理需要
   * 「等了多久」這個資訊,見 cost-governor_detail.md §4。用 presence-in-map
   * 判斷「是否已經在追蹤這次 waiting」,不依賴 `setStatus()` 知道前一個狀態
   * (見 `setStatus()` 內的寫入邏輯)。session 刪除時一併清除(見
   * `deleteSession()`),避免無限增長。
   */
  private readonly waitingSince = new Map<string, number>();

  /**
   * 目標 session 正忙(busy/waiting)時,暫存要在它下一次 `completed` 空檔送達的跨 session 訊息
   * (`send_to_session`/`create_session`/UI 轉傳),等到那個空檔才真正送出(見 `deliverNetworkMessage()` 與
   * consumeEvents 的 completed case)——同一個 session 可累積多筆,每次 flush 只送一筆。
   * 元素是 `{text, origin, chainId}`:`text` 是**原始 message 本體**,信封在送進 adapter 那一刻才由
   * `session-envelope.ts` 依 `origin` 組裝;`chainId` 讓這則訊息被處理時沿用它所屬的訊息鏈。
   * 純記憶體——core 重啟即遺失(D4 Mailbox 持久化已撤銷,見 docs/DECISIONS.md §H)。
   * 清理慣例:session 結束/重啟時清除(見 deleteSession/shutdownAll/reclaimSession,經
   * `clearPerSessionState()`),避免無限增長。
   */
  private readonly pendingIdleInjection = new Map<string, PendingNetworkMessage[]>();
  /** 訊息鏈預算(第三條斷路器),見 `message-chain-budget.ts`。 */
  private readonly chainBudget: MessageChainBudget;

  constructor(
    private readonly adapters: AdapterRegistry,
    private readonly db: NexusDb,
    /**
     * 2026-10-02(P2:移除 profile):取代原本的 `ProfileStore`。`createSession()`/
     * `continueSession()` 等所有 spawn 路徑都向它要 `AgentLaunchSpec`(見
     * apps/core/src/agents/agent-catalog.ts)。
     */
    private readonly catalog: AgentCatalog,
    private readonly permissionGateway: PermissionGateway,
    /**
     * 這輪新增(provider 目錄重構):spawn 前依 `spec.providerId` 查詢 provider 層級的
     * env(settings 的 per-provider 偏好,見下方 `prepareSpawnSpec()`)。
     */
    private readonly settingsStore: SettingsStore,
    /**
     * S1(PolicyEngine)新增:見 docs/LAYER-4-detail-design/policy-engine_detail.md
     * §0 的整合點——`permission-request` case 在 `setStatus("waiting")` 之前
     * 呼叫 `policyEngine.decide()`,allow/deny 完全不進 waiting。`auditLog`/
     * `notifier` 是 S1 grill 定案的 Enforcement 底座(見該文件 §5):
     * `auditLog` 一律記錄(含自動放行),`notifier` 這輪是 S1 stub(見
     * apps/core/src/enforcement/notifier.ts),S11 才接真通道。
     */
    private readonly policyEngine: PolicyEngine,
    private readonly auditLog: AuditLog,
    private readonly notifier: Notifier,
    /**
     * S7(auto-mode-and-yolo)新增:`<DESKMONY_HOME>/config.json` 的絕對路徑
     * ——`resolvePermission()` 處理 `rememberRule` 時,透過
     * `config-file-writer.ts` 的 `appendPolicyRule()` 寫入這個檔案(與
     * `WsGateway` 的 `config.setFile` 走同一個檔案,但刻意繞過那條「安全子集」
     * patch 通道,見 `appendPolicyRule()` 頂端說明)。
     */
    private readonly configPath: string,
    /**
     * S3b(CostGovernor)新增:回合硬上限(不依賴 usage,§0.1 的重點,見
     * apps/core/src/cost/turn-limiter.ts)。`sendPrompt()`/`consumeEvents()`
     * 依此起訖回合、記錄 tool-call 次數。
     */
    private readonly turnLimiter: TurnLimiter,
    /**
     * S3b(CostGovernor)新增:每日 kill-switch(見
     * apps/core/src/cost/cost-governor.ts)。`sendPrompt()` 送出前先問
     * `checkSendPromptAllowed()`,`consumeEvents()` 收到 `usage` 事件時轉發給
     * `recordUsage()`。
     */
    private readonly costGovernor: CostGovernor,
    /**
     * 2026-10-02(P3):訊息鏈預算設定(`config.messageBudget`,見 `MessageBudgetConfigSchema`——鍵名沿用,
     * 意義改成「每條訊息鏈」的訊息數上限)。
     */
    messageBudget: MessageBudgetConfig,
    /** S7:YOLO 存活時間,見上方 `DEFAULT_YOLO_DURATION_MS` 註解。 */
    private readonly yoloDurationMs: number = YOLO_DEFAULT,
  ) {
    super();
    this.chainBudget = new MessageChainBudget(messageBudget, auditLog, notifier, () => this.referencedChainIds());
    this.permissions = new SessionPermissionCoordinator({
      policyEngine,
      auditLog,
      notifier,
      configPath,
      yoloDurationMs,
      // 這四個回呼就是 coordinator 對 SessionManager 的全部需求(見該檔案
      // 頂端「依賴倒轉的方式」)——刻意收斂成是非題與通知,不遞交整份
      // runtime/db,否則只是把耦合換個地方藏。
      isSessionRunning: (sessionId) => this.runtime.has(sessionId),
      onSessionStateChanged: (sessionId) => {
        void this.getSession(sessionId).then((session) => {
          if (session) this.emit("session-updated", session);
        });
      },
      emitPolicyUpdated: (push) => this.emit("policy-updated", push),
      hasConnectedClient: () => this.clientPresence?.hasConnectedClient() ?? false,
      hasRemoteClient: () => this.clientPresence?.hasRemoteClient() ?? false,
    });
  }

  /** S7 L4 §2.1:apps/core/src/index.ts 建立好 WsGateway 後回頭注入。
   *  未注入時的行為見 `buildExecContext()`。 */
  setClientPresence(presence: ClientPresencePort): void {
    this.clientPresence = presence;
  }

  async listSessions(): Promise<Session[]> {
    const rows = await this.db.select().from(sessionsTable).all();
    return rows.map((row) => this.permissions.attachTo(rowToSession(row)));
  }

  /** S6(crash-recovery):復原視圖的資料來源之一,見 `RecoveryService.list()`。 */
  async listInterruptedSessions(): Promise<Session[]> {
    const rows = await this.db.select().from(sessionsTable).where(eq(sessionsTable.status, "interrupted")).all();
    return rows.map((row) => this.permissions.attachTo(rowToSession(row)));
  }

  /**
   * S6(crash-recovery)新增:「放棄」——標 `closed`(不是 `error`,因為這不是
   * 執行失敗,是人類主動決定不處理這條中斷的 session),**對話紀錄一律
   * 保留**(不自動刪,同 S3b T2「回收 ≠ 丟棄」的既有語意)。
   */
  async abandonInterruptedSession(sessionId: string): Promise<void> {
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new DeskmonyError(ErrorCodes.ENTITY_NOT_FOUND, { entityType: "session", id: sessionId }, `找不到 session: ${sessionId}`);
    }
    if (session.status !== "interrupted") {
      throw new DeskmonyError(
        "sessionManager.abandonRequiresInterrupted",
        { sessionId, status: session.status },
        `session ${sessionId} 目前狀態是 "${session.status}",不是 "interrupted",無法「放棄」`,
      );
    }
    await this.setStatus(sessionId, "closed");
    this.emit("session-list-updated");
  }

  async getHistory(sessionId: string): Promise<MessageRecord[]> {
    const rows = await this.db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.sessionId, sessionId))
      .all();
    return rows
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((row) => ({
        id: row.id,
        sessionId: row.sessionId,
        role: row.role as MessageRecord["role"],
        content: row.content,
        createdAt: row.createdAt,
        // async-scribbling-llama.md Phase 6:`row.attachments` 是我們自己在
        // persistMessage() 寫入的 JSON.stringify(PromptAttachment[])(或
        // NULL),不需要像 gateway 邊界那樣做 zod 防禦性驗證——同 `row.role as
        // MessageRecord["role"]` 這行既有的信任層級。
        attachments: row.attachments
          ? (JSON.parse(row.attachments) as NonNullable<MessageRecord["attachments"]>)
          : undefined,
        origin: parseOrigin(row.origin),
      }));
  }

  /**
   * 2026-10-02(P2:移除 profile):session 直接以偵測到的 agent(`providerId`)+ model 建立。
   * 啟動資訊(command/args)由 `AgentCatalog.buildLaunch()` 組出——找不到/未安裝/已停用時
   * 丟 `DeskmonyError`(`agent.notFound`/`agent.notInstalled`/`agent.disabled`)。
   * 權限模式一律從 `"always-ask"` 開始(原本取自 profile.permissionLevel,現在沒有 profile 了);
   * 既有的 session 級 auto/YOLO 切換不變。
   */
  async createSession(input: CreateSessionInput): Promise<Session> {
    const { spec, label } = await this.catalog.buildLaunch(input.providerId, input.model, input.effort);
    return this.spawnNewSession(spec, label, {
      workingDir: input.workingDir,
      title: input.title,
      parentSessionId: input.parentSessionId,
    });
  }

  /**
   * 真正 spawn 一個新 adapter handle、寫 DB、登記 runtime 的共用路徑——`createSession()`、
   * `createSessionFromAgent()`、`takeoverWithSummary()` 都走這裡。
   */
  private async spawnNewSession(
    spec: AgentLaunchSpec,
    label: string,
    opts: { workingDir: string; title?: string; parentSessionId?: string },
  ): Promise<Session> {
    // S8(agent-lifecycle)L4 §3.2:provider env 合併 + `.deskmony/notes/` 確保存在 +
    // systemPrompt 附加「指路」段落,三件事都收斂到 `prepareSpawnSpec()`。
    const effectiveSpec = await this.prepareSpawnSpec(spec, opts.workingDir, toNoteFileName(label));

    const adapter = this.adapters.get(spec.software);
    const handle = await adapter.spawn(effectiveSpec, { path: opts.workingDir });

    const providerId = spec.providerId ?? spec.software;
    const now = Date.now();
    const session: Session = {
      id: handle.id,
      title: opts.title ?? "新對話",
      providerId,
      adapterType: spec.software,
      status: "idle",
      workingDir: opts.workingDir,
      createdAt: now,
      updatedAt: now,
      // M5 Round C:session 級別的 model/effort 取自建立參數(`AgentCatalog.buildLaunch()` 已套用
      // 「沒給就用 provider 明確標記的預設 model、否則維持 undefined」與「effort 只有
      // claude-agent-sdk 有意義」的規則),不臆測任何預設值。
      model: spec.model,
      effort: spec.effort,
      // 從哪個 session 底下開出來的(只用於 UI 巢狀顯示與溯源)
      parentSessionId: opts.parentSessionId,
    };

    await this.db.insert(sessionsTable).values(sessionToRow(session, storedLaunchFromSpec(spec))).run();
    this.runtime.set(session.id, {
      handle,
      adapter,
      streamingText: "",
      providerId,
      workingDir: opts.workingDir,
      slashCommandsObserved: false,
      openToolCalls: new Map(),
    });
    // S7:一律從 "always-ask" 開始(見上方 createSession() 說明)。
    this.permissions.initialize(session.id, "always-ask");

    void this.consumeEvents(session.id);

    this.emit("session-list-updated");
    return this.permissions.attachTo(session);
  }

  /**
   * 2026-09-04(稽核修補):per-session 序列化。
   *
   * `sendPrompt()` 內部是「檢查預算 → await 持久化 → await 設狀態 → 起算回合
   * → 送給 adapter」,中間有多個 await 缺口,而三條路徑會併發打進來:
   * 使用者連點兩次送出、兩個 client 同時操作同一個 session、以及
   * 程式化的訊息注入撞上手動輸入(`deliverNetworkMessage()` 本身就是
   * 「先讀狀態、再送」的 check-then-act)。兩次呼叫都會通過各自的預算檢查、
   * 都 persist、都呼叫 `adapter.sendPrompt()`,底層收到兩個幾乎同時的 prompt,
   * 行為未定義。鎖收斂在 `sendPromptSerialized()` 這個**唯一的共同入口**(人類輸入與跨 session 投遞都經過它)。
   */
  private readonly sendPromptLocks = new Map<string, Promise<unknown>>();

  /**
   * **人類輸入**(gateway 的 `session.sendPrompt`、recovery 接手的第一則摘要等):開啟一條**新的訊息鏈**。
   *
   * 2026-10-02(P3):人類輸入與跨 session 投遞(`deliverNetworkMessage()`)在這裡分流——兩者共用同一個
   * 序列化入口(`sendPromptSerialized()`,per-session 鎖),差別只在帶進去的 `PromptDelivery`:
   *   - 人類輸入:`chainId` = **新產生**的 uuid,沒有 `origin`。gateway 的 client 不能指定 chainId/origin
   *     (`session.sendPrompt` 的 schema 根本不收這兩個欄位),所以人類輸入不可能被偽造成「別的 session 送來的」,
   *     也不可能挑一條現成的鏈來繞過鏈預算。
   *   - 跨 session 投遞:沿用訊息自己帶的 `chainId` 與 `origin`(只有 core 內部能組出來)。
   */
  async sendPrompt(sessionId: string, prompt: PromptInput): Promise<void> {
    return this.sendPromptSerialized(sessionId, prompt, { chainId: randomUUID() });
  }

  private async sendPromptSerialized(sessionId: string, prompt: PromptInput, delivery: PromptDelivery): Promise<void> {
    const previous = this.sendPromptLocks.get(sessionId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(() => this.sendPromptInner(sessionId, prompt, delivery));
    this.sendPromptLocks.set(
      sessionId,
      run.catch(() => undefined),
    );
    // 刻意不在這裡清 Map(那需要判斷「我是不是最後一環」,而那個判斷本身就是
    // 另一個 race)。清理跟著 session 生命週期走,見 `deleteSession()` 等處
    // 一併呼叫的 `clearPerSessionState()` —— 與 `waitingSince`/`permissionState`
    // 這些 per-session Map 的既有慣例一致。
    return (await run) as void;
  }

  private async sendPromptInner(sessionId: string, prompt: PromptInput, delivery: PromptDelivery): Promise<void> {
    const runtime = this.runtime.get(sessionId);
    if (!runtime) {
      throw new DeskmonyError(ErrorCodes.SESSION_NOT_RUNNING, { sessionId }, `session 尚未啟動或已結束: ${sessionId}`);
    }

    // S3b(CostGovernor)L4 §2/§3.3:每日 kill-switch 越線後,只擋
    // 「後續 prompt」——這裡是唯一的送出前檢查點(gateway 的 `session.
    // sendPrompt` 與跨 session 的訊息投遞都走這個方法,見 cost-governor.ts
    // 頂端「halt 粒度」說明)。**不擋已經在跑的回合**,故意不在這裡呼叫
    // `interrupt()`。
    const budgetCheck = await this.costGovernor.checkSendPromptAllowed();
    if (!budgetCheck.allowed) {
      // i18n 專案:`budgetCheck.reason` 是 CostGovernor(不在這個批次的改動範圍
      // 內)組好的完整中文句子,不是 code+params 結構——這裡先用一個一次性
      // code 包起來、把整句塞進 `reason` 參數(等於原樣直通,不強行翻譯這句話
      // 本身),避免這裡替 CostGovernor 的錯誤文案瞎猜對應的 ErrorCodes.BUDGET_*
      // 分類。理想的後續修正是讓 CostGovernor.checkSendPromptAllowed() 改回傳
      // 結構化的 code/params(它產生的兩種情況剛好對應既有的
      // ErrorCodes.BUDGET_DAILY_LIMIT),屆時這裡可以直接
      // 原樣往外傳、不再需要這層包裝(這是一項已知待辦,說明見上方)。
      const reason = budgetCheck.reason ?? "此 session 已被成本斷路器擋下,無法送出新的 prompt";
      throw new DeskmonyError("sessionManager.promptBlockedByBudget", { reason }, reason);
    }

    // 這一輪屬於哪條訊息鏈:人類輸入 = 剛產生的新鏈;跨 session 訊息 = 訊息自己帶的鏈(見 `PromptDelivery`)。
    // agent 這一輪經 create_session/send_to_session 送出的訊息會沿用它(`chainOfCaller()`)。
    runtime.currentChainId = delivery.chainId;

    const persisted = await this.persistMessageRow(
      sessionId,
      "user",
      delivery.persistedText ?? prompt.text,
      prompt.attachments,
      delivery.origin,
    );
    // 別的 session 送來的訊息:通知所有 client(讓正在看這條 session 的 UI 即時顯示「來自 <title>」)。
    // 人類自己輸入的不推播——桌面端是樂觀回顯。
    if (delivery.origin) this.emit("session-message", { sessionId, message: persisted });
    await this.setStatus(sessionId, "busy");
    // S3b:回合開始,見 turn-limiter.ts 的 `startTurn()` 註解——不依賴 usage,
    // 對所有 adapter 種類(含 pty)一律起算。
    this.turnLimiter.startTurn(sessionId);

    runtime.adapter.sendPrompt(runtime.handle, prompt);
    this.scheduleIdleIfTerminal(sessionId, runtime);
  }

  /**
   * Bug A 修正:原始鍵盤輸入直通(見 packages/adapters/src/types.ts 的
   * `AgentAdapter.writeInput` 介面註解)。刻意**不**呼叫 `persistMessage()`
   * ——逐鍵輸入不是一則聊天訊息,寫進歷史只會污染 session 記錄(對照
   * `sendPrompt()` 會 persist 整行文字這點,語意上完全不同)。
   *
   * 只有實作了 `writeInput()` 的 adapter(目前只有 `GenericPtyAdapter`)才會
   * 真的把資料寫進去;其餘 adapter 該方法是 `undefined`,`?.` 呼叫直接
   * no-op——沒有「未知 session」以外的錯誤語意需要呈現給呼叫端(呼叫端只有
   * TerminalView,只會在 pty session 上呼叫)。
   */
  writeTerminalInput(sessionId: string, data: string): void {
    const runtime = this.runtime.get(sessionId);
    if (!runtime) return;
    runtime.adapter.writeInput?.(runtime.handle, data);
    this.scheduleIdleIfTerminal(sessionId, runtime);
  }

  /**
   * Issue 1 修正之一:把 xterm.js 實際的顯示尺寸同步給底層 pty(見
   * packages/adapters/src/types.ts 的 `AgentAdapter.resize` 介面註解)。與
   * `writeTerminalInput()` 一樣,只有實作了 `resize()` 的 adapter 才會真的
   * 生效,其餘 adapter no-op。這不算「輸出活動」,不觸發
   * `scheduleIdleIfTerminal()`。
   */
  resizeTerminal(sessionId: string, cols: number, rows: number): void {
    const runtime = this.runtime.get(sessionId);
    if (!runtime) return;
    runtime.adapter.resize?.(runtime.handle, cols, rows);
  }

  /** 查詢某個 software 對應 adapter 的能力(M2 Round B,供 gateway 的
   * `adapter.capabilities` 方法使用,UI 依此決定聊天視圖或終端視圖)。 */
  getCapabilities(software: AgentSoftware): AdapterCapabilities {
    return this.adapters.get(software).capabilities();
  }

  /**
   * 這輪(slash command)新增:查詢一個 session 目前已知的 "/" 指令清單(見
   * `RuntimeState.slashCommands`/`consumeEvents()` 的 `"available-commands"`
   * case)。供 gateway 的 `session.getSlashCommands` 方法使用——這是純 push
   * 推播之外補的 pull 入口,理由見 `packages/shared/src/gateway.ts` 的
   * `session.getSlashCommands` 註解(reconnect/多視窗會錯過 push 的缺口)。
   *
   * **不要求 session 目前是「執行中」的**——與 `setSessionModel()` 等「必須
   * 操作活著的 adapter」的方法不同,這裡純粹讀取一份記憶體快取,session 還沒
   * spawn、已經 dispose,或這個 adapter 從未推播過,都只是回傳
   * `{commands: [], observed: false}`,不視為錯誤——語意上與「session 執行中
   * 但還沒收到推播」完全相同(對呼叫端 UI 而言都是「目前不知道有什麼指令可
   * 用」,不需要為兩種情況分別處理)。
   */
  getSlashCommands(sessionId: string): { commands: SlashCommandInfo[]; observed: boolean } {
    const runtime = this.runtime.get(sessionId);
    if (!runtime) return { commands: [], observed: false };
    return { commands: runtime.slashCommands ?? [], observed: runtime.slashCommandsObserved };
  }

  /**
   * M3 Round B 修正(interrupt 時序 race):改成回傳 Promise 並 await
   * adapter 的 `interrupt()`(見 packages/adapters/src/types.ts 的介面註解)
   * ——呼叫端必須等這裡 resolve 才能安全地注入
   * 下一個 prompt,否則會與尚未真正停下的回合競爭。
   */
  async interrupt(sessionId: string): Promise<void> {
    const runtime = this.runtime.get(sessionId);
    if (!runtime) return;
    await runtime.adapter.interrupt(runtime.handle);
  }

  /**
   * S7(auto-mode-and-yolo)L4 §4/§1.3:`rememberRule` 若提供,先做 Core 端強制
   * 檢查(C4 紀律③,不可省、不能只靠 UI 不顯示)——若這筆 `requestId` 當初是
   * escalate-strong,一律拒絕連同 rememberRule 一起套用(只忽略 rememberRule
   * 這部分,`decision` 本身仍照常套用,agent 不因為這個檢查而卡住)。通過檢查
   * 後,`PolicyEngine.addRule()`(in-memory 立即生效)與
   * `appendPolicyRule()`(寫回 config.json,重啟後一致)一起做,兩者不可只做
   * 一邊(見 policy-engine.ts 的 `addRule()` 註解)。
   */
  resolvePermission(
    /**
     * 2026-09-04(稽核修補):新增的第一參數。過去這個值是從
     * `permissionGateway.resolve(requestId)` 反查回來的,而那份登記用的是會
     * 跨 session 碰撞的單鍵——決策因此可能被套用到**另一條 session** 的工具
     * 呼叫上。完整說明見 `packages/shared/src/events.ts` 的
     * `PermissionDecisionSchema.sessionId`。
     */
    sessionId: string,
    requestId: string,
    decision: "allow" | "deny",
    rememberRule?: PolicyRule,
  ): void {
    const resolved = this.permissionGateway.resolve(sessionId, requestId);
    if (!resolved) return;
    const { strong } = resolved;
    const runtime = this.runtime.get(sessionId);
    if (!runtime) return;

    if (rememberRule !== undefined) {
      if (strong) {
        // C4 紀律③:escalate-strong 絕不可提供「永遠允許」——這裡是不可省的
        // Core 端強制檢查(不只是 UI 不顯示這個按鈕),即使 client 是被動過手腳
        // 的 UI 或惡意呼叫端,一律拒絕寫入,只印警告,不讓這次的 decision 因此
        // 失敗(agent 仍然拿到這次的 allow/deny,只是不會被記成永久規則)。
        console.warn(
          `[enforcement][security] 拒絕:escalate-strong 請求(requestId=${requestId}, session=${sessionId})` +
            "帶 rememberRule,已忽略(僅套用本次 decision,不寫入 policy;這通常代表 UI bug 或惡意 client)。",
        );
      } else {
        // 2026-08-25 補的既有缺口(見 docs/DECISIONS.md §G):`addedBy`/`id`
        // 這兩個欄位過去從未被任何程式碼真正設過值(schema 裡定義了但沒人
        // 填)——這裡補上,讓新的「權限」設定頁清單能顯示正確來源(這條規則是
        // 從對話框「永遠允許」按出來的,不是設定頁手動新增的),也讓
        // `policy.removeRule` 之後有穩定 id 可以定位到這一條。不覆寫呼叫端
        // 已經帶了 id 的情況(理論上不會發生,`PermissionModal.tsx` 目前不會
        // 自己組 id,這裡是防禦性寫法)。
        const finalizedRule: PolicyRule = {
          ...rememberRule,
          id: rememberRule.id ?? randomUUID(),
          addedBy: "ui-remember",
          addedAt: rememberRule.addedAt ?? Date.now(),
        };
        this.policyEngine.addRule(finalizedRule);
        try {
          appendPolicyRule(this.configPath, finalizedRule);
        } catch (err) {
          console.error(
            `[policy] rememberRule 寫入 config.json 失敗(in-memory 已生效,但重啟後會與這次的行為不一致): ${String(err)}`,
          );
        }
      }
    }

    runtime.adapter.resolvePermission(runtime.handle, requestId, decision);
    this.emitPermissionResolved({ sessionId, requestId, decision, source: "user" });
  }

  /**
   * async-scribbling-llama.md Phase 7:回覆一筆 `user-dialog-request`
   * (AskUserQuestion 的待答問題)。比照上面的 `resolvePermission()`,但**沒有**
   * `rememberRule`/strong 判斷——這不是一個權限決策(見 packages/shared/src/
   * events.ts 的 `UserDialogRequestEventSchema`/`DialogAnswerSchema` 註解),
   * 沒有「記住規則」或「hard-deny 降級確認」的概念可套用。`sessionId` 必須由
   * 呼叫端提供,不像 `resolvePermission()` 能從 `permissionGateway.
   * resolve(requestId)` 反查——`user-dialog-request` 完全不經過
   * `PermissionGateway` 的登記(見下方 `consumeEvents()` 的
   * `"user-dialog-request"` case 註解)。
   */
  resolveUserDialog(sessionId: string, requestId: string, result: DialogAnswer): void {
    const runtime = this.runtime.get(sessionId);
    if (!runtime) return;
    runtime.adapter.resolveUserDialog?.(runtime.handle, requestId, result);
    const payload: UserDialogResolvedPush = { sessionId, requestId, result };
    this.emit("user-dialog-resolved", payload);
  }

  /**
   * ---- 權限/政策:委派給 SessionPermissionCoordinator ---------------------
   *
   * 2026-09-04(稽核修補,拆 God object 第一塊):以下六個方法的實作已搬到
   * `./session-permission-coordinator.ts`。這裡保留同名的薄委派,理由是
   * `WsGateway` 的 dispatch 直接呼叫這些方法名,把它們一起改掉會讓這一輪的
   * diff 同時橫跨「搬程式碼」與「改呼叫端」兩件事 —— 一旦測試掛了就分不清是
   * 哪一件造成的。等這塊穩定之後,gateway 可以改成直接持有 coordinator,
   * 這幾個委派再一併移除。
   */
  setSessionPermissionMode(sessionId: string, mode: SessionPermissionMode): SessionPermissionState {
    return this.permissions.setMode(sessionId, mode);
  }

  setTrueUnrestricted(sessionId: string, enabled: boolean, isRemote: boolean): SessionPermissionState {
    return this.permissions.setTrueUnrestricted(sessionId, enabled, isRemote);
  }

  addPolicyRule(input: PolicyAddRuleInput, isRemote: boolean): PolicyRule {
    return this.permissions.addRule(input, isRemote);
  }

  removePolicyRule(id: string, isRemote: boolean): PolicyRule | undefined {
    return this.permissions.removeRule(id, isRemote);
  }

  listPolicyRules(): PolicyRule[] {
    return this.permissions.listRules();
  }

  /**
   * M5 Round C:對話中切換 model(見 packages/adapters/src/types.ts 的
   * `AgentAdapter.setModel()` 介面註解)。`ClaudeAgentSdkAdapter.setModel()`
   * 直接呼叫 SDK 的 `Query.setModel()`,對話上下文原封不動保留,不需要
   * dispose/respawn;`OpenCodeAdapter.setModel()` 則是把值存成 session 內的
   * 覆寫,下一則訊息才真正送給 opencode(opencode 沒有對應的「設定當前
   * model」端點,見該檔案 `setModel()` 的實作註解)——兩種實作方式不同,但
   * 對這裡呼叫端而言是同一個 await 得到 resolve/reject 的介面,不需要分流
   * 處理。
   *
   * 要求 session 目前必須是「執行中」的(`this.runtime` 有對應的
   * RuntimeState)——沒有 runtime 就沒有 adapter handle 可以呼叫
   * `setModel()`,也沒有任何"目前正在跑的 model"這個概念可言,直接視為
   * 錯誤(不像 title 這種純 DB 欄位可以在 session 不在跑的情況下更新)。
   *
   * ACP/PTY 的 adapter 實作會讓 `runtime.adapter.setModel()` 直接丟出明確
   * 錯誤(見對應 adapter 檔案),這裡不特別攔截、原樣往外傳——呼叫端
   * (gateway)會收到 `ok:false` + 明確的錯誤訊息,不會誤以為成功。
   */
  async setSessionModel(sessionId: string, model: string): Promise<Session> {
    const runtime = this.runtime.get(sessionId);
    if (!runtime) {
      throw new DeskmonyError(
        ErrorCodes.SESSION_NOT_RUNNING,
        { sessionId },
        `session 尚未啟動或已結束,無法切換 model: ${sessionId}`,
      );
    }

    await runtime.adapter.setModel(runtime.handle, model);

    const updatedAt = Date.now();
    await this.db.update(sessionsTable).set({ model, updatedAt }).where(eq(sessionsTable.id, sessionId)).run();
    // 在聊天串留一則系統訊息,讓使用者(即使是之後重新載入 history)也能
    // 看到「這裡換過 model」的紀錄,呼應 ARCHITECTURE 對話延續性的要求。
    // i18n 專案:改存 JSON 結構化事件({event, params}),不再存預先渲染好
    // 的中文句子——前端(apps/desktop/src/lib/system-events.ts 的
    // resolveSystemEventText())在渲染當下才查 systemEvents namespace 翻譯,
    // event key 字串("session.modelSwitched")與 apps/desktop/src/stores/
    // session-store.ts 的樂觀本地更新必須完全一致,兩邊才會渲染出同樣的結果。
    await this.persistMessage(sessionId, "system", JSON.stringify({ event: "session.modelSwitched", params: { model } }));

    const session = await this.getSession(sessionId);
    if (!session) {
      throw new DeskmonyError(ErrorCodes.ENTITY_NOT_FOUND, { entityType: "session", id: sessionId }, `session 不存在: ${sessionId}`);
    }
    this.emit("session-updated", session);
    return session;
  }

  /**
   * 比照上面的 `setSessionModel()`:對話中切換 effort(思考程度,見
   * packages/adapters/src/types.ts 的 `AgentAdapter.setEffort()` 介面註解)。
   * `ClaudeAgentSdkAdapter.setEffort()` 呼叫 SDK 的
   * `Query.applyFlagSettings({ effortLevel })`,對話上下文原封不動保留,不需要
   * dispose/respawn。只有 `software="claude-agent-sdk"` 驗證得到這個能力(見
   * packages/shared/src/agent-launch.ts 的 `EffortLevelSchema` 註解)——其餘
   * adapter(含 opencode)的 `setEffort()` 會直接丟出明確錯誤,這裡不特別
   * 攔截、原樣往外傳,呼叫端(gateway)會收到 `ok:false` + 明確的錯誤訊息,
   * 不會誤以為成功。
   *
   * 要求 session 目前必須是「執行中」的(`this.runtime` 有對應的
   * RuntimeState)——理由同 `setSessionModel()`。
   */
  async setSessionEffort(sessionId: string, effort: EffortLevel): Promise<Session> {
    const runtime = this.runtime.get(sessionId);
    if (!runtime) {
      throw new DeskmonyError(
        ErrorCodes.SESSION_NOT_RUNNING,
        { sessionId },
        `session 尚未啟動或已結束,無法切換思考程度: ${sessionId}`,
      );
    }

    await runtime.adapter.setEffort(runtime.handle, effort);

    const updatedAt = Date.now();
    await this.db.update(sessionsTable).set({ effort, updatedAt }).where(eq(sessionsTable.id, sessionId)).run();
    // 在聊天串留一則系統訊息,比照 setSessionModel() 的既有作法(見該方法內
    // 「改存 JSON 結構化事件」的說明,event key 同樣要與 session-store.ts 的
    // 樂觀本地更新一致)。
    await this.persistMessage(sessionId, "system", JSON.stringify({ event: "session.effortSwitched", params: { effort } }));

    const session = await this.getSession(sessionId);
    if (!session) {
      throw new DeskmonyError(ErrorCodes.ENTITY_NOT_FOUND, { entityType: "session", id: sessionId }, `session 不存在: ${sessionId}`);
    }
    this.emit("session-updated", session);
    return session;
  }

  // ==========================================================================================
  // 2026-10-02(P3:session 網路)——取代 S12 的 spawnChild / spawnChildFromTool / sendToChildFromTool /
  // listChildrenFromTool 與「子 completed → 結果注入父」(見 docs/DECISIONS.md §H、
  // docs/LAYER-4-detail-design/simplify-agents-sessions_detail.md §P3)。
  //
  // 下面六個方法是 session 網路的 core 端實作,**呼叫者身分一律由呼叫端(adapter 閉包 / gateway 的 bridge token)
  // 提供,不是 agent 能填的參數**:
  //   list_agents → (AgentCatalog.summarizeAvailable)   list_sessions → listSessionsForAgent
  //   read_session → readSessionForAgent                create_session → createSessionFromAgent
  //   send_to_session → sendToSessionFromAgent          UI 轉傳 → forwardMessage
  //
  // **沒有任何自動回送**(使用者定案):B 收到 A 的訊息、這輪結束後,系統不會把 B 的回答送回 A。
  // 要回覆,B 必須自己呼叫 send_to_session。所以 consumeEvents 的 `completed` 案例裡不再有任何
  // 「把結果注入別的 session」的程式碼——那裡只剩「flush 排在自己身上的待送訊息」。
  // ==========================================================================================

  /** providerId → 顯示名稱(含使用者在偏好裡改的 label);查不到的 providerId 就用它本身。 */
  private async agentLabelOf(providerId: string, labels?: Map<string, string>): Promise<string> {
    const map = labels ?? (await this.catalog.labelsById());
    return map.get(providerId) ?? providerId;
  }

  /**
   * `list_sessions`:**所有** session(不限父子、不限工作目錄)的摘要,不含對話內容。
   * `isYou` 標出呼叫者自己;`canUseTools` = 對方能不能主動回話(只有 claude-agent-sdk 與 acp 能)。
   */
  async listSessionsForAgent(callerSessionId: string): Promise<NetworkSessionSummary[]> {
    const [all, labels] = await Promise.all([this.listSessions(), this.catalog.labelsById()]);
    return all.map((s) => ({
      id: s.id,
      title: s.title,
      providerId: s.providerId,
      agentLabel: labels.get(s.providerId) ?? s.providerId,
      model: s.model,
      status: s.status,
      workingDir: s.workingDir,
      parentSessionId: s.parentSessionId,
      isYou: s.id === callerSessionId,
      canUseTools: softwareCanUseTools(s.adapterType),
    }));
  }

  /**
   * `read_session`:目標 session 最近 `limit` 則對話訊息(預設 20、上限 100),每則 content 截斷到
   * 4000 字元並標註。
   *   - 只回 `user`/`assistant` 兩種角色:`tool` 訊息是工具呼叫/結果的原始 JSON(可能很大、與「這個 session
   *     在聊什麼」無關),`system` 是內部事件 JSON(切換 model、權限逾時…)——都不是 agent 想讀的對話。
   *   - **不回傳附件的二進位內容**,只標示 `hasAttachments`(SQL 只問 `attachments IS NOT NULL`,
   *     連附件的 base64 都不讀進記憶體)。
   *   - 任何 session 都能讀(所有 session 互相可見,Q4 定案),包含呼叫者自己。
   */
  async readSessionForAgent(input: { callerSessionId: string; sessionId: string; limit?: number }): Promise<ReadSessionResult> {
    const target = await this.getSession(input.sessionId);
    if (!target) {
      throw new DeskmonyError(ErrorCodes.ENTITY_NOT_FOUND, { entityType: "session", id: input.sessionId }, `找不到 session: ${input.sessionId}`);
    }
    const limit = Math.min(Math.max(Math.trunc(input.limit ?? READ_SESSION_DEFAULT_LIMIT), 1), READ_SESSION_MAX_LIMIT);
    const rows = await this.db
      .select({
        role: messagesTable.role,
        content: messagesTable.content,
        createdAt: messagesTable.createdAt,
        origin: messagesTable.origin,
        hasAttachments: sql<number>`(${messagesTable.attachments} IS NOT NULL)`,
      })
      .from(messagesTable)
      .where(and(eq(messagesTable.sessionId, input.sessionId), inArray(messagesTable.role, ["user", "assistant"])))
      // 同一毫秒寫入的訊息(假 agent 或很快的回覆,user 與 assistant 常常同一個 createdAt)
      // 只靠 createdAt 排序時 SQLite 不保證先後,會讀出「先回答、後提問」。用寫入順序 rowid
      // (messages 是 TEXT 主鍵表,仍有隱含 rowid)當次排序,與 getHistory() 的穩定排序結果一致。
      .orderBy(desc(messagesTable.createdAt), sql`rowid DESC`)
      .limit(limit)
      .all();
    const messages = rows.reverse().map((row) => {
      const truncated = truncateForNetwork(row.content);
      const origin = parseOrigin(row.origin);
      return {
        role: row.role as MessageRecord["role"],
        content: truncated.content,
        createdAt: row.createdAt,
        ...(origin ? { origin } : {}),
        ...(truncated.truncated ? { truncated: true } : {}),
        ...(row.hasAttachments ? { hasAttachments: true } : {}),
      };
    });
    return { sessionId: target.id, title: target.title, messages };
  }

  /**
   * 目標 session 現在能不能收訊息?`closed`/`error`/`interrupted`(含 runtime 已不在)→ 明確報錯,
   * **不假裝成功**(否則送訊息的 agent 會誤以為對方收到了)。
   */
  private assertDeliverable(target: Session): void {
    if (target.status === "closed" || target.status === "error" || target.status === "interrupted") {
      throw new DeskmonyError(
        "sessionNetwork.targetUnavailable",
        { sessionId: target.id, title: target.title, status: target.status },
        `session ${target.id}(「${target.title}」)目前狀態是「${target.status}」,收不到訊息`,
      );
    }
    if (!this.runtime.has(target.id)) {
      throw new DeskmonyError(
        ErrorCodes.SESSION_NOT_RUNNING,
        { sessionId: target.id },
        `session ${target.id}(「${target.title}」)目前沒有在執行中(可能已被回收或關閉),無法送出訊息`,
      );
    }
  }

  /**
   * 呼叫者**這一輪**所屬的訊息鏈 id(agent 經 create_session/send_to_session 送出的訊息沿用它)。
   * 每一輪都由 `sendPrompt*` 起頭並設定 `currentChainId`,所以正常情況一定有值;萬一沒有(不應該發生),
   * 當場開一條新鏈並記下來,而不是讓鏈追蹤出現缺口。
   */
  private chainOfCaller(callerSessionId: string): string {
    const runtime = this.runtime.get(callerSessionId);
    if (!runtime) {
      throw new DeskmonyError(ErrorCodes.SESSION_NOT_RUNNING, { sessionId: callerSessionId }, `呼叫者 session 目前沒有在執行中: ${callerSessionId}`);
    }
    if (!runtime.currentChainId) runtime.currentChainId = randomUUID();
    return runtime.currentChainId;
  }

  /** 鏈預算被擋下時丟給 agent 的錯誤——訊息要講明「已熔斷、需要使用者介入」,agent 才知道該停手。 */
  private chainBudgetError(limit: number): DeskmonyError {
    return new DeskmonyError(
      "sessionNetwork.chainBudgetExceeded",
      { limit },
      `這條對話鏈已達訊息上限 ${limit}(messageBudget.maxMessagesPerContext),已熔斷,需要使用者介入——` +
        "請不要再用 send_to_session / create_session 繼續這條對話鏈,把目前狀況告訴使用者並等他的指示" +
        "(使用者在畫面上輸入新訊息就會開啟新的對話鏈)。",
    );
  }

  /**
   * `send_to_session`:對任一 session(不能是自己)送訊息。驗證順序刻意如下:
   *   1. 目標是呼叫者自己 → 明確報錯(自己對自己傳訊息只會造成無限迴圈)。
   *   2. 找不到目標 → 明確報錯(打錯 id,或已被刪除)。
   *   3. 目標 closed/error/interrupted/runtime 不在 → 明確報錯,不假裝成功。
   *   4. 鏈預算(`MessageChainBudget.admit()`)——達上限 → 錯誤回給 agent + `enforcementTrip()`。
   * 全部通過才真的投遞:目標 idle 立刻送、busy/waiting 排進 `pendingIdleInjection` 等它這輪結束。
   * **投遞之後什麼都不會自動回來**。
   */
  async sendToSessionFromAgent(input: { callerSessionId: string; sessionId: string; message: string }): Promise<void> {
    if (input.sessionId === input.callerSessionId) {
      throw new DeskmonyError(
        "sessionNetwork.cannotSendToSelf",
        { sessionId: input.sessionId },
        "不能用 send_to_session 傳訊息給自己(要找其他 session 請先 list_sessions)",
      );
    }
    const target = await this.getSession(input.sessionId);
    if (!target) {
      throw new DeskmonyError(ErrorCodes.ENTITY_NOT_FOUND, { entityType: "session", id: input.sessionId }, `找不到 session: ${input.sessionId}(請先 list_sessions 確認 id)`);
    }
    this.assertDeliverable(target);
    const caller = await this.getSession(input.callerSessionId);
    if (!caller) {
      throw new DeskmonyError(ErrorCodes.ENTITY_NOT_FOUND, { entityType: "session", id: input.callerSessionId }, `找不到呼叫者 session: ${input.callerSessionId}`);
    }

    const chainId = this.chainOfCaller(input.callerSessionId);
    const admission = await this.chainBudget.admit(chainId, [input.callerSessionId, input.sessionId]);
    if (!admission.ok) throw this.chainBudgetError(admission.limit);

    await this.deliverNetworkMessage(input.sessionId, {
      text: input.message,
      origin: { kind: "session", sessionId: caller.id, title: caller.title, chainId },
      chainId,
    });
  }

  /**
   * `create_session`:建一個新 session(`parentSessionId` = 呼叫者,只為 UI 巢狀顯示與溯源——不代表任何權限或回報
   * 關係),並把 `prompt` 以信封當第一則訊息送出(它從信封就知道是誰開的)。`workingDir` 省略時沿用呼叫者的。
   * 順序:先驗證 agent(`buildLaunch()` 找不到/未安裝/已停用就丟錯,不佔鏈預算、不 spawn 任何東西)→ 鏈預算 →
   * spawn → 送第一則訊息。鏈預算已達上限時**不會**開出新 session(否則失控的 agent 會不斷 spawn 行程)。
   */
  async createSessionFromAgent(input: {
    callerSessionId: string;
    agent: string;
    prompt: string;
    model?: string;
    title?: string;
    workingDir?: string;
  }): Promise<{ sessionId: string }> {
    const caller = await this.getSession(input.callerSessionId);
    if (!caller) {
      throw new DeskmonyError(ErrorCodes.ENTITY_NOT_FOUND, { entityType: "session", id: input.callerSessionId }, `找不到呼叫者 session: ${input.callerSessionId}`);
    }
    const { spec, label } = await this.catalog.buildLaunch(input.agent, input.model);

    const chainId = this.chainOfCaller(input.callerSessionId);
    const admission = await this.chainBudget.admit(chainId, [input.callerSessionId]);
    if (!admission.ok) throw this.chainBudgetError(admission.limit);

    const created = await this.spawnNewSession(spec, label, {
      title: input.title ?? `「${caller.title}」開的 session`,
      workingDir: input.workingDir ?? caller.workingDir,
      parentSessionId: caller.id,
    });
    try {
      await this.deliverNetworkMessage(created.id, {
        text: input.prompt,
        origin: { kind: "session", sessionId: caller.id, title: caller.title, chainId },
        chainId,
      });
    } catch (err) {
      throw new DeskmonyError(
        "sessionNetwork.createdButNotDelivered",
        { sessionId: created.id, detail: err instanceof Error ? err.message : String(err) },
        `已建立 session ${created.id},但第一則訊息送出失敗: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return { sessionId: created.id };
  }

  /**
   * UI「轉傳到…」(`session.forwardMessage`):使用者把 `sourceSessionId` 畫面上某個氣泡的文字(`text`)轉給
   * 任一個其他 session。**人類操作**:開一條**新的訊息鏈**(`origin.kind === "forward"`),不計入鏈預算、不會
   * 被先前 agent 間的鏈熔斷擋下。`note`(使用者選填的附註)接在被轉傳內容前面,一起當成這則訊息的本體。
   *
   * 不回頭查原訊息:`text` 是使用者在畫面上看到並按下轉傳的那段文字,等同使用者自己複製貼上——core 只驗證
   * source/target 存在、target 可送達、不是轉給自己,不去核對 `text` 是不是 source 真的說過的話。過去用
   * messageId 回查持久化訊息,但串流中的訊息 id 是 adapter 的 messageId、對不上 DB 那一筆,只能靠內容比對
   * 去猜,ACP 一輪有多個氣泡(多個 assistant 訊息)時會猜錯、轉成整輪文字。長度上限由 gateway 的 schema 把關
   * (`FORWARD_MESSAGE_MAX_CHARS`)。
   */
  async forwardMessage(input: {
    sourceSessionId: string;
    targetSessionId: string;
    text: string;
    note?: string;
  }): Promise<void> {
    if (input.sourceSessionId === input.targetSessionId) {
      throw new DeskmonyError("sessionNetwork.cannotForwardToSelf", { sessionId: input.sourceSessionId }, "不能把訊息轉傳給來源 session 自己");
    }
    const [source, target] = await Promise.all([this.getSession(input.sourceSessionId), this.getSession(input.targetSessionId)]);
    if (!source) {
      throw new DeskmonyError(ErrorCodes.ENTITY_NOT_FOUND, { entityType: "session", id: input.sourceSessionId }, `找不到來源 session: ${input.sourceSessionId}`);
    }
    if (!target) {
      throw new DeskmonyError(ErrorCodes.ENTITY_NOT_FOUND, { entityType: "session", id: input.targetSessionId }, `找不到目標 session: ${input.targetSessionId}`);
    }
    this.assertDeliverable(target);

    const note = input.note?.trim();
    const chainId = randomUUID();
    await this.deliverNetworkMessage(target.id, {
      text: note ? `${note}\n\n${input.text}` : input.text,
      origin: { kind: "forward", sessionId: source.id, title: source.title, chainId },
      chainId,
    });
  }

  /**
   * 目前**還被引用**的訊息鏈 id:某個 session runtime 的 `currentChainId`,或某筆待送佇列訊息帶的 chainId。
   * `MessageChainBudget` 用它丟掉已經沒有任何 session 在上面的鏈(避免計數無限增長)。
   */
  private referencedChainIds(): ReadonlySet<string> {
    const ids = new Set<string>();
    for (const runtime of this.runtime.values()) {
      if (runtime.currentChainId) ids.add(runtime.currentChainId);
    }
    for (const queue of this.pendingIdleInjection.values()) {
      for (const item of queue) ids.add(item.chainId);
    }
    return ids;
  }

  async deleteSession(sessionId: string): Promise<void> {
    const runtime = this.runtime.get(sessionId);
    if (runtime) {
      if (runtime.ptyIdleTimer) clearTimeout(runtime.ptyIdleTimer);
      await runtime.adapter.dispose(runtime.handle);
      this.runtime.delete(sessionId);
    }
    await this.db.delete(messagesTable).where(eq(messagesTable.sessionId, sessionId)).run();
    await this.db.delete(sessionsTable).where(eq(sessionsTable.id, sessionId)).run();
    this.permissions.clear(sessionId); // S7:避免 Map 隨 session 生命週期無限增長。
    this.waitingSince.delete(sessionId); // S3b:同上,避免無限增長。
    this.clearPerSessionState(sessionId); // 同上,避免無限增長(含待送佇列與訊息鏈狀態)。
    this.emit("session-list-updated");
  }

  /** S3b(CostGovernor):目前所有仍在跑(`this.runtime` 有對應 handle)的
   *  sessionId——`CostGovernor` 的每日 kill-switch 要 interrupt 全部。 */
  listActiveSessionIds(): string[] {
    return [...this.runtime.keys()];
  }

  /** S3b(CostGovernor):目前所有 `status === "waiting"` 的 session,含各自
   *  進入 waiting 的時間戳——`WaitingWatchdog` 的 T1/T2 掃描用。 */
  listWaitingSessions(): Array<{ sessionId: string; waitingSince: number }> {
    return [...this.waitingSince.entries()].map(([sessionId, since]) => ({ sessionId, waitingSince: since }));
  }

  /**
   * S3b(CostGovernor)T2(HLD §4「資源回收」):真正 dispose 這個 session 的
   * adapter 子程序、釋放資源,但**保留** DB 裡的 session/messages 記錄(與
   * `deleteSession()` 不同——那個方法連 DB 記錄都刪,這裡刻意只清 in-memory
   * runtime,對話紀錄仍保留,人回來後可以看到完整歷史紀錄
   * 並決定續/棄,同 S6 復原視圖的既有 UX,見 cost-governor_detail.md §4「回收
   * ≠ 丟棄」)。
   *
   * 回收後這個 session 在 `this.runtime` 裡已經不存在,`sendPrompt()`/
   * `interrupt()` 等方法會如常丟出「session 尚未啟動或已結束」的錯誤——這正是
   * 「需要人工重新建立 session 才能續行」的預期行為,不需要新增一個
   * `SessionStatus` 列舉值(`SessionStatusSchema` 目前只有 idle/busy/
   * waiting/error 四種,見 packages/shared/src/session.ts)。這裡把 DB 狀態
   * 設成既有的 `"error"`,`lastError` 說明原因,是目前 schema 下最貼近語意的
   * 選擇(實作當下的自行判斷,repo 外無紀錄)。
   */
  async reclaimSession(sessionId: string): Promise<void> {
    const runtime = this.runtime.get(sessionId);
    if (!runtime) return; // 已經不在跑(例如剛好被使用者手動刪除),視為已完成。
    if (runtime.ptyIdleTimer) clearTimeout(runtime.ptyIdleTimer);
    await runtime.adapter.dispose(runtime.handle);
    this.runtime.delete(sessionId);
    this.turnLimiter.endTurn(sessionId);
    this.clearPerSessionState(sessionId); // 避免無限增長(含待送佇列與訊息鏈狀態)。
    await this.setStatus(
      sessionId,
      "error",
      "已閒置等待超過 72 小時,資源已自動回收(子程序已釋放);對話紀錄仍保留,可重新建立 session 續行或放棄此 session",
    );
  }

  /** S6(crash-recovery)L4 §4.1:見上方 `consumeEvents()` 內的呼叫點註解。 */
  private async persistBackendSessionId(sessionId: string, backendSessionId: string): Promise<void> {
    await this.db.update(sessionsTable).set({ backendSessionId }).where(eq(sessionsTable.id, sessionId)).run();
  }

  /**
   * S6(crash-recovery)L4 §3:啟動對帳——在 `apps/core/src/index.ts` 的
   * `main()` 建完所有服務、**開 gateway 之前**呼叫一次。找出 DB 裡「沒被乾淨
   * 收尾」的 session(`idle`/`busy`/`waiting` 三種狀態),它們的子程序必然已
   * 隨 core 上次崩潰而消失,標記成 `interrupted` 供人在復原視圖分流。
   *
   * **`idle` 也算孤兒**:`idle` 只代表「上一輪結束了」,子程序仍活著等下一個
   * prompt——core 一死它也沒了,同樣是孤兒(見 crash-recovery_detail.md §3)。
   * `error`/`closed` 不動(前者已是失敗終態,後者是正常關閉的乾淨收尾)。
   *
   * 呼叫時機保證 `this.runtime` 必然是空的(還沒有任何 session 被 spawn 過),
   * 所以這裡直接批次操作 DB,不需要透過 `setStatus()`(那個方法還會 emit
   * "session-updated",但此時還沒有任何 gateway/client 存在,emit 沒有意義,
   * 也沒必要為每一筆孤兒各別查一次 `getSession()`)。
   *
   * DB 損毀時,下面的 `db.select()`/`db.update()` 會直接拋出例外,原樣往外
   * 傳——`main()` 沒有 catch,交給既有的 `main().catch()` 統一報錯 +
   * `process.exit(1)`(同 config 損毀的既有作風,見 crash-recovery_detail.md
   * §6「對帳時 DB 損毀 → 啟動失敗並明確報錯,不帶著壞資料啟動」)。
   */
  async reconcileOnStartup(): Promise<{ count: number; sessionIds: string[] }> {
    const rows = await this.db.select().from(sessionsTable).all();
    const orphanStatuses = new Set<string>(["idle", "busy", "waiting"]);
    const orphans = rows.filter((row) => orphanStatuses.has(row.status));
    const now = Date.now();
    for (const row of orphans) {
      await this.db
        .update(sessionsTable)
        .set({ status: "interrupted", interruptedAt: now, lastSeenAt: now, updatedAt: now })
        .where(eq(sessionsTable.id, row.id))
        .run();
    }
    return { count: orphans.length, sessionIds: orphans.map((row) => row.id) };
  }

  /**
   * S6(crash-recovery)L4 §2:優雅關閉收尾——`apps/core/src/index.ts` 的
   * shutdown handler 呼叫,對每個仍在跑(`this.runtime` 有對應 handle)的
   * session:dispose adapter 子程序、DB 狀態標成 `closed`。**這是
   * `closed`/`interrupted` 能被明確區分的關鍵**——沒被這個方法標記到的
   * session,下次啟動會被 `reconcileOnStartup()` 視為崩潰。
   *
   * 平行處理(`Promise.all`)而非依序迴圈:呼叫端(index.ts)會用 `Promise.race`
   * 包一個 5 秒逾時,平行處理讓「盡量多收尾幾個」在時間有限的情況下更有機會
   * 達成(見 crash-recovery_detail.md §2「寧可留下孤兒被對帳,也不要卡住不
   * 關」——逾時後沒收尾到的那些,下次啟動會被正確地視為崩潰,方向是安全的)。
   *
   * 單一 session 的 dispose 失敗不影響其餘 session 的收尾(try/catch 包住,
   * 失敗仍然繼續把 DB 標成 closed——**優先保證「不是崩潰」這個分類正確**,
   * dispose 失敗頂多留下一個沒被清乾淨的子程序,不影響下次啟動的對帳分類)。
   */
  async shutdownAll(): Promise<void> {
    const ids = [...this.runtime.keys()];
    await Promise.all(
      ids.map(async (id) => {
        const runtime = this.runtime.get(id);
        if (!runtime) return;
        if (runtime.ptyIdleTimer) clearTimeout(runtime.ptyIdleTimer);
        try {
          await runtime.adapter.dispose(runtime.handle);
        } catch (err) {
          console.error(`[session-manager] shutdown 時 dispose session ${id} 失敗(忽略,仍標記為 closed): ${String(err)}`);
        }
        this.runtime.delete(id);
        this.turnLimiter.endTurn(id);
        this.clearPerSessionState(id); // 避免無限增長(含待送佇列與訊息鏈狀態)。
        try {
          await this.setStatus(id, "closed");
        } catch (err) {
          console.error(`[session-manager] shutdown 時標記 session ${id} 為 closed 失敗: ${String(err)}`);
        }
      }),
    );
  }

  /**
   * S6(crash-recovery)L4 §4:「繼續(保有記憶)」——只有 `adapterType ===
   * "claude-agent-sdk"` 且已捕捉過 `backendSessionId` 的 `interrupted` session
   * 才能呼叫(見 `RecoveryService.continueSession()` 的前置檢查;這裡仍重新
   * 檢查一次,不信任呼叫端已經驗證過)。
   *
   * 與 `createSession()` 的關鍵差異:**沿用既有的 DB session id**(不是
   * `handle.id`)——`this.runtime` 這次改用既有的 `sessionId` 當 key(見下方
   * `this.runtime.set(sessionId, ...)`),讓 `messages` 表的既有歷史紀錄自然
   * 延續在同一個 session 底下,UI 不需要切換到一個新的聊天串。`consumeEvents()`
   * 本身不需要任何修改就能重用——它只依賴 `this.runtime.get(sessionId)`,不
   * 關心這個 key 背後的 handle 是不是重新 spawn 出來的。
   */
  async continueSession(sessionId: string): Promise<Session> {
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new DeskmonyError(ErrorCodes.ENTITY_NOT_FOUND, { entityType: "session", id: sessionId }, `找不到 session: ${sessionId}`);
    }
    if (session.status !== "interrupted") {
      throw new DeskmonyError(
        "sessionManager.continueRequiresInterrupted",
        { sessionId, status: session.status },
        `session ${sessionId} 目前狀態是 "${session.status}",不是 "interrupted",無法「繼續」`,
      );
    }
    if (session.adapterType !== "claude-agent-sdk" || !session.backendSessionId) {
      throw new DeskmonyError(
        "sessionManager.continueUnsupportedBackend",
        { sessionId, adapterType: session.adapterType },
        `session ${sessionId} 的後端(${session.adapterType})不支援「繼續(保有記憶)」,或這條 session 崩潰前還沒捕捉到後端 session 識別碼,請改用「接手」`,
      );
    }

    // 2026-10-02(P2:移除 profile):一律從 session 自己的資料重建啟動規格——先用 providerId 走
    // `AgentCatalog.buildLaunchSpec(providerId, session.model, session.effort)`,provider 已不存在/
    // 未安裝時退回 `adapterType + launch_command + launch_args`,**不再讀 agent_profiles 表**。
    // (同時修掉舊設計的一個既有 bug:用 agentOverride 建的 session,續接時會 `profiles.get()` 讀回
    // base profile,換回錯的 agent。)
    const { spec, label } = await this.catalog.buildLaunchSpecForSession(session, await this.getStoredLaunch(sessionId));
    const effectiveSpec = await this.prepareSpawnSpec(spec, session.workingDir, toNoteFileName(label));

    const adapter = this.adapters.get(spec.software);
    // `sessionId`:沿用既有的 DB session id 當 handle.id(見 `ResumeOptions.sessionId`)——session 網路工具的
    // 呼叫者身分是 adapter 以 handle.id 閉包捕捉的,必須等於這條 session 的 id。
    const handle = await adapter.spawn(effectiveSpec, { path: session.workingDir }, {
      backendSessionId: session.backendSessionId,
      sessionId,
    });

    this.runtime.set(sessionId, {
      handle,
      adapter,
      streamingText: "",
      providerId: session.providerId,
      workingDir: session.workingDir,
      backendSessionId: session.backendSessionId,
      slashCommandsObserved: false,
      openToolCalls: new Map(),
    });
    this.permissions.initialize(sessionId, "always-ask");

    await this.db
      .update(sessionsTable)
      .set({ status: "idle", interruptedAt: null, lastSeenAt: Date.now(), updatedAt: Date.now() })
      .where(eq(sessionsTable.id, sessionId))
      .run();
    // i18n 專案:改存 JSON 結構化事件,理由同 setSessionModel() 內的說明。
    await this.persistMessage(
      sessionId,
      "system",
      JSON.stringify({ event: "session.continuedAfterInterrupt" }),
    );

    void this.consumeEvents(sessionId);
    this.emit("session-list-updated");

    const updated = await this.getSession(sessionId);
    if (!updated) {
      throw new DeskmonyError(
        "sessionManager.vanishedDuringContinue",
        { sessionId },
        `session ${sessionId} 於「繼續」流程中意外消失`,
      );
    }
    this.emit("session-updated", updated);
    return updated;
  }

  /**
   * S6(crash-recovery)L4 §4.2:「接手(讀摘要重啟)」——開一個全新的 session
   * (不重用舊的 DB row/handle),再把摘要文字當作**第一則 prompt** 送給這個全新的 agent
   * (見 `RecoveryService.takeover()` 內對摘要組裝與「為什麼用 sendPrompt 而不是只存進 DB
   * 歷史」的完整說明)。這裡只是把「新 session + 送出摘要」包成一個方法,實際的摘要文字組裝
   * (只讀 DB + git,不呼叫 LLM)在 `RecoveryService` 完成。
   *
   * 2026-10-02(P2):新 session 的 agent 從**舊 session 自己的資料**重建(同
   * `continueSession()`):providerId + model/effort,provider 已不在偵測清單時退回
   * `adapterType + launch_*`——所以 ACP 的 session 接手後 `adapterType` 仍是 acp。
   */
  async takeoverWithSummary(source: Session, title: string, summary: string): Promise<Session> {
    const { spec, label } = await this.catalog.buildLaunchSpecForSession(source, await this.getStoredLaunch(source.id));
    const session = await this.spawnNewSession(spec, label, { workingDir: source.workingDir, title });
    await this.sendPrompt(session.id, { text: summary });
    return session;
  }

  /** session 列自己存的 `launch_command`/`launch_args`(續接/接手的退路,見 `AgentCatalog.buildLaunchSpecForSession()`)。 */
  private async getStoredLaunch(sessionId: string): Promise<StoredLaunchInfo> {
    const rows = await this.db.select().from(sessionsTable).where(eq(sessionsTable.id, sessionId)).all();
    const row = rows[0];
    if (!row) return {};
    let args: string[] | undefined;
    if (row.launchArgs) {
      try {
        const parsed: unknown = JSON.parse(row.launchArgs);
        if (Array.isArray(parsed) && parsed.every((a) => typeof a === "string")) args = parsed as string[];
      } catch {
        // 壞掉的 JSON 當作沒有 args(command 仍可用)——不讓續接因此多一種失敗模式。
      }
    }
    return { command: row.launchCommand ?? undefined, args };
  }

  /**
   * S8 L4 §3.2:任何一次真正 spawn 新 adapter handle 之前都要做的兩件事——
   * (1) provider 層級的 env(settings 的 per-provider 偏好,**每次 spawn 重新讀,不落地**)
   *     併進 `spec.env`;
   * (2) 確保 `.deskmony/notes/` 存在(§3.1,失敗不阻擋啟動,只記警告),並把「指路」段落
   *     設成 `spec.systemPrompt`(§3.2,**不**讀取筆記內容塞進去)。
   * 2026-10-02(P2):原本的 `prepareSpawnProfile()`——profile 自己的 `env`/`systemPrompt` 已不存在,
   * 只剩 provider 層級 env 與指路段落。
   */
  private async prepareSpawnSpec(spec: AgentLaunchSpec, workingDir: string, displayName: string): Promise<AgentLaunchSpec> {
    const providerEnv = spec.providerId ? await getProviderEnv(this.settingsStore, spec.providerId) : {};
    const mergedEnv = { ...providerEnv, ...spec.env };
    const withEnv = Object.keys(mergedEnv).length > 0 ? { ...spec, env: mergedEnv } : spec;

    await ensureNotesDir(workingDir).catch((err) => {
      console.warn(
        `[agent-lifecycle] 建立 .deskmony/notes/(${workingDir})失敗,不影響 session 啟動,` +
          `但 systemPrompt 附加的指路段落可能指向一個尚未建立的目錄: ${err instanceof Error ? err.message : String(err)}`,
      );
    });

    return { ...withEnv, systemPrompt: withNotesPointer(withEnv.systemPrompt, displayName) };
  }

  /**
   * 2026-09-04(稽核修補):`consumeEventsInner()` 的錯誤圍籬。
   *
   * 三個呼叫點都是 `void this.consumeEvents(...)`(fire-and-forget,因為這是一條
   * 要跑到 session 結束的長命迴圈,呼叫端不能 await 它)。在補這道圍籬之前,
   * 迴圈內任何一次 `await this.persistMessage(...)`/DB 寫入
   * 拋錯,都會變成 unhandled rejection —— 在 Node ≥ 20 底下**直接終止整個 core**,
   * 連帶炸掉所有其他的 session。`apps/core/src/index.ts` 那道全域兜底
   * 是最後防線;這裡才是就地、能講清楚是哪一條 session 出事的正確位置。
   *
   * 刻意**不**在迴圈內逐事件 try/catch 之後繼續跑:一次未預期的例外之後,這條
   * session 的內部狀態(runtime、turn、權限等待中的請求)已經無法保證一致,
   * 假裝沒事繼續消費下一個事件等於把不一致藏起來。改成沿用這個檔案既有的
   * adapter 錯誤慣例——寫一則 `session.adapterError` 系統訊息 + 把 session 標成
   * `"error"` ——讓使用者在 UI 上**看得到**這條 session 死了、為什麼死,
   * 而不是看著一條再也不會更新、狀態卻停在 busy 的對話。
   */
  private async consumeEvents(sessionId: string): Promise<void> {
    try {
      await this.consumeEventsInner(sessionId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[session-manager] session ${sessionId} 的事件迴圈因未預期例外中止(core 不會因此退出):`,
        err instanceof Error ? err.stack : err,
      );
      // 收尾本身也可能失敗(例如例外的成因就是 DB 掛了)——絕不能讓錯誤處理
      // 又拋一次,那會把這道圍籬原本要防的 unhandled rejection 再造出來。
      try {
        await this.persistMessage(
          sessionId,
          "system",
          JSON.stringify({
            event: "session.adapterError",
            params: { message, detail: "event-loop-aborted" },
          }),
        );
        await this.setStatus(sessionId, "error", message);
      } catch (cleanupErr) {
        console.error(
          `[session-manager] session ${sessionId} 標記 error 狀態時再次失敗(已放棄):`,
          cleanupErr instanceof Error ? cleanupErr.stack : cleanupErr,
        );
      }
    }
  }

  private async consumeEventsInner(sessionId: string): Promise<void> {
    const runtime = this.runtime.get(sessionId);
    if (!runtime) return;

    for await (const event of runtime.adapter.events(runtime.handle)) {
      const envelope: SessionEventEnvelope = {
        sessionId,
        event,
        timestamp: Date.now(),
      };

      // S6(crash-recovery)L4 §4.1:惰性捕捉後端持久化 session 識別碼——只在
      // 還沒捕捉到時才查詢(`getBackendSessionId?.()` 對不支援的 adapter 恆
      // 回傳 undefined,一次額外的 Map.get() 呼叫,成本可忽略)。捕捉到之後
      // 立刻寫回 DB,讓即使緊接著就崩潰,"繼續" 也還有機會可用。
      if (!runtime.backendSessionId) {
        const captured = runtime.adapter.getBackendSessionId?.(runtime.handle);
        if (captured) {
          runtime.backendSessionId = captured;
          void this.persistBackendSessionId(sessionId, captured).catch((err) => {
            console.error(`[session-manager] 寫入 backendSessionId(${sessionId}) 失敗(不影響本次對話,只影響之後的「繼續」能力): ${String(err)}`);
          });
        }
      }
      // S7(auto-mode-and-yolo)L4 §1.2:`permission-request` 事件的 `strong`
      // 欄位要等 `decide()` 跑完才知道(是否為 hard-deny 降級的強確認)——
      // adapter 產生的原始事件不可能知道這件事(那是 PolicyEngine 的判斷)。
      // 這裡刻意**不**在這裡無條件廣播,改由下面 `case "permission-request"`
      // 算出 `strong` 後,用補上這個欄位的 envelope 廣播,UI 才能收到正確值。
      // 其餘事件類型維持原本「收到就立刻廣播」不變。
      if (event.type !== "permission-request") {
        this.emit("session-event", envelope);
      }

      switch (event.type) {
        case "message-delta": {
          await this.ensureBusy(sessionId);
          runtime.streamingText += event.delta;
          break;
        }
        case "tool-call": {
          /**
           * 2026-09-17:同一個 toolCallId 第二次以後的 tool-call 是「補資訊」,不是
           * 新的工具呼叫(見 `RuntimeState.openToolCalls` 的完整說明)。
           *
           * 為什麼在 core 依 toolCallId 去重,而不是另外兩條路:
           *   - 讓 adapter 等 input 齊了才送唯一一次(opencode 等到 `running`):
           *     泡泡要等模型把參數串流完才出現(大檔 write/edit 可以是好幾秒);
           *     更糟的是 opencode 實測 `running` 與 `permission.asked`/
           *     `question.asked` 誰先到不固定,晚到的那次 tool-call 會經過
           *     `ensureBusy()`,把正在等人回覆的 waiting 翻回 busy(`waitingSince`
           *     也跟著被清掉,T1/T2 掛起處理就看不到這條 session)。
           *   - 另開一種「只補 input」的事件型別:shared schema、CLI、TUI、桌面端
           *     的 switch 全部要改,而桌面端本來就以 toolCallId upsert 合併重複的
           *     tool-call(claude-sdk-adapter 從 M1 起就這樣送)——core 是唯一沒有
           *     跟上這個語意的消費端,補在這裡改動面最小。
           *
           * ⚠️ 對 Claude session 的回合硬上限是**有意的語意修正**,不是順手放寬:
           * 修正前 Claude 每次工具呼叫送兩個 tool-call、被算兩次,`maxToolCalls`
           * 預設 200 實際約第 101 次呼叫就 trip;修正後回到設定值本身。雙倍計數
           * 不是設計:content_block_start 那次提早送出是 M1 只為了 UI 顯示加的
           * (docs/DEVLOG.md 有記),S3b 加回合上限時沒注意到這個交互作用——
           * config 欄位名、ARCHITECTURE.md 與 cost-governor_detail.md §2 的表格、
           * 通知文字講的都是「工具呼叫次數」;e2e-cost-governor 只用每個呼叫送
           * 一次的 ACP 假 agent,所以一直沒浮現。想要更緊的上限應該調低設定值,
           * 而不是依賴某個 adapter 剛好多送一次事件。
           */
          const open = runtime.openToolCalls.get(event.toolCallId);
          if (!open) {
            await this.ensureBusy(sessionId);
            // S3b(CostGovernor)§3:回合硬上限的其中一個維度——不依賴 usage,
            // 對所有 adapter 一律計數,每個工具呼叫(toolCallId 第一次出現)計一次。
            // `recordToolCall()` 內部同步判斷是否超標,超標時自己觸發 trip +
            // interrupt(fire-and-forget,不阻塞這個事件迴圈繼續讀取後續事件)。
            this.turnLimiter.recordToolCall(sessionId);
            const rowId = await this.persistMessage(
              sessionId,
              "tool",
              JSON.stringify({
                kind: "call",
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                input: event.input,
              }),
            );
            runtime.openToolCalls.set(event.toolCallId, { rowId, toolName: event.toolName, input: event.input });
          } else {
            // 補資訊:不計數、不 `ensureBusy()`(補上 input 不代表 agent 有了新
            // 進展,見上方),就地更新同一筆 row——歷史裡每個工具呼叫只有一筆
            // call 記錄,位置(createdAt)維持第一次出現的時間。後到的事件沒帶
            // input/toolName 時保留已知值,不讓一次較空的重送把已經落地的參數洗掉。
            const toolName = event.toolName || open.toolName;
            const input = event.input !== undefined ? event.input : open.input;
            if (toolName !== open.toolName || input !== open.input) {
              open.toolName = toolName;
              open.input = input;
              await this.updateMessageContent(
                open.rowId,
                JSON.stringify({ kind: "call", toolCallId: event.toolCallId, toolName, input }),
              );
            }
          }
          break;
        }
        case "tool-result": {
          // 這個呼叫已經有結果,移出 openToolCalls:之後同一個 toolCallId 再出現
          // 就是後端重複使用 id 的新呼叫,照樣計數(見 RuntimeState.openToolCalls)。
          runtime.openToolCalls.delete(event.toolCallId);
          await this.ensureBusy(sessionId);
          await this.persistMessage(
            sessionId,
            "tool",
            JSON.stringify({
              kind: "result",
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              output: event.output,
              isError: event.isError,
              structuredResult: event.structuredResult,
            }),
          );
          break;
        }
        case "permission-request": {
          // S1(PolicyEngine)整合點,務必在 `setStatus("waiting")` **之前**呼叫
          // `decide()`(見 policy-engine_detail.md §0):allow/deny 的自動決策
          // 完全不進 waiting 狀態,agent 不停頓,這正是 default-deny 之外
          // 「allowlist 換取自主」的價值所在。若先進 waiting 再放行,等於白做。

          // S7(auto-mode-and-yolo)L4 §6:YOLO 30 分鐘惰性過期——**每次
          // decide() 前檢查**,不用計時器。過期時回落 always-ask,在聊天串
          // 留一則系統訊息(近似 HLD 說的「發通知」)+ 廣播 session-updated
          // 讓所有 client 的常駐標記立刻消失,不用等使用者手動重新整理。
          const { state: permState, justExpired } = this.permissions.checkAndExpireYolo(sessionId);
          if (justExpired) {
            console.warn(`[auto-mode] session ${sessionId} 的 YOLO(auto-accept-all)已到期(30 分鐘),自動回落 always-ask`);
            // i18n 專案:改存 JSON 結構化事件,理由同 setSessionModel() 內的說明。
            await this.persistMessage(sessionId, "system", JSON.stringify({ event: "session.yoloExpired" }));
            const updated = await this.getSession(sessionId);
            if (updated) this.emit("session-updated", updated);
          }

          const ctx = this.permissions.buildExecContext(permState);
          const permissionReq: PermissionRequest = {
            sessionId,
            requestId: event.requestId,
            toolName: event.toolName,
            input: event.input,
            workingDir: runtime.workingDir,
            providerId: runtime.providerId,
          };
          const decision = this.policyEngine.decide(permissionReq, ctx);
          const strong = decision.effect === "escalate-strong";
          // 現在才廣播 permission-request 事件——補上剛算出來的 strong,見上方
          // 迴圈頂端「刻意不在這裡無條件廣播」的說明。allow/deny 的情況也照樣
          // 廣播這個事件(與收窄前的既有行為一致:UI 的 pendingPermissions 會
          // 短暫收到又立刻被隨後的 permission-resolved 推播移除)。
          this.emit("session-event", { ...envelope, event: { ...event, strong } });

          const decisionTs = Date.now();
          this.auditLog.append({
            kind: "decision",
            sessionId,
            requestId: event.requestId,
            toolName: event.toolName,
            effect: decision.effect,
            reason: decision.reason,
            ts: decisionTs,
          });

          if (decision.effect === "allow" || decision.effect === "deny") {
            runtime.adapter.resolvePermission(runtime.handle, event.requestId, decision.effect);
            this.emitPermissionResolved({ sessionId, requestId: event.requestId, decision: decision.effect, source: "policy" });
            break; // 不進 waiting,agent 不停頓。
          }

          // escalate / escalate-strong:維持既有 waiting + register 路徑,逾時
          // 語意見 §6(attended → 短逾時 deny;非 attended → 不設計時器)。
          // (`strong` 已在上面算好,見廣播 permission-request 事件那段。)
          this.auditLog.append({
            kind: "escalation",
            sessionId,
            requestId: event.requestId,
            toolName: event.toolName,
            strong,
            ts: decisionTs,
          });
          void this.notifier
            .deliver({ kind: "escalation", sessionId, requestId: event.requestId, toolName: event.toolName, strong, ts: decisionTs })
            .catch((err) => {
              // Notification 送不出去不影響任何決策——稽核已經記錄,逾時行為
              // 照常(見 policy-engine_detail.md §6 失敗模式表)。
              console.error(`[enforcement] notifier.deliver 失敗(不影響升級流程): ${String(err)}`);
            });

          await this.setStatus(sessionId, "waiting");
          const timeoutMs = ctx.attended ? this.permissionGateway.defaultTimeoutMs : null;
          this.permissionGateway.register(sessionId, event.requestId, strong, timeoutMs, (sid, requestId) => {
            // 逾時自動拒絕,避免 agent 永遠卡在 waiting(只有 attended 才會走到
            // 這裡——非 attended 時 timeoutMs 為 null,PermissionGateway 不設
            // 計時器,這個回呼永遠不會被呼叫,見 §6)。
            // 不能走 this.resolvePermission():gateway 逾時前已刪除該筆 pending,
            // resolve() 會查不到而提前 return,adapter 的 deny 永遠不會送出,
            // SDK 的 canUseTool promise 將永久懸置(SDK 明言 fail-closed、無 deadline)。
            const rt = this.runtime.get(sid);
            if (rt) rt.adapter.resolvePermission(rt.handle, requestId, "deny");
            void this.setStatus(sid, "busy");
            this.emitPermissionResolved({ sessionId: sid, requestId, decision: "deny", source: "timeout" });
          });
          break;
        }
        /**
         * async-scribbling-llama.md Phase 7:`AskUserQuestion` 的待答問題。
         * 刻意**不**比照上面 `"permission-request"` 呼叫 `PolicyEngine.
         * decide()`、不查 YOLO/auto-mode、不寫 audit log、不註冊
         * `permissionGateway` 的逾時機制——這不是一個權限決策(見
         * packages/shared/src/events.ts 的 `UserDialogRequestEventSchema`
         * 註解:政策引擎管的是「要不要放行一個工具呼叫」,`AskUserQuestion`
         * 本身從未被擋下,只是需要使用者提供答案才能完成)。SDK 自己會
         * bound 等待時間(idle 逾時後以空答案繼續,見 claude-sdk-adapter.ts
         * 檔案頂端「機制查證」段落),不需要 Deskmony 重做一套逾時追蹤。
         * 事件本身已經在上面(迴圈頂端)無條件廣播過(只有
         * `"permission-request"` 被排除在外),這裡只需要把狀態轉成
         * waiting——既有的 `ensureBusy()` 會在後續事件(例如答案送出後的
         * tool-result)自動把狀態轉回 busy,不需要額外處理。
         */
        case "user-dialog-request": {
          await this.setStatus(sessionId, "waiting");
          break;
        }
        case "completed": {
          this.clearPtyIdleTimer(runtime);
          const finalText = event.finalText ?? runtime.streamingText;
          if (finalText) {
            await this.persistMessage(sessionId, "assistant", finalText);
          }
          runtime.streamingText = "";
          await this.setStatus(sessionId, "idle");
          // S3b:回合正常結束,清除回合硬上限的狀態(見 turn-limiter.ts 的
          // `endTurn()` 註解)。openToolCalls 跟著一起清(見 RuntimeState 註解)。
          this.turnLimiter.endTurn(sessionId);
          runtime.openToolCalls.clear();

          // 2026-10-02(P3):**沒有任何自動回送**——這一輪結束後,系統不會把結果送給任何別的 session
          // (S12 的「子 completed → 結果注入父」與 `child-result` push 已整個移除,見 docs/DECISIONS.md §H)。
          // 要回覆誰由 agent 自己用 send_to_session 決定。
          //
          // 這裡只做一件事:flush 排在**自己**身上的待送跨 session 訊息(它正忙時別人送來、排隊等它有空的)
          // ——一次只送一筆(其餘等下一輪 completed,避免把多筆塞成一個回合)。
          this.flushPendingNetworkMessage(sessionId);
          break;
        }
        case "error": {
          this.clearPtyIdleTimer(runtime);
          // i18n 專案:`event.message`/`event.detail` 是底層 adapter(Claude
          // Code/Codex/OpenCode/PTY)的原始輸出,不是可翻譯的 UI 文字——只有
          // "[錯誤]" 這個標籤概念可翻譯,訊息本身原樣存進 params,由前端
          // apps/desktop/src/lib/system-events.ts 的 resolveSystemEventText()
          // 在渲染時組回 `label + message + detail`,不強行塞進翻譯後的句子
          // 範本(見該檔案內的完整說明)。
          await this.persistMessage(
            sessionId,
            "system",
            JSON.stringify({ event: "session.adapterError", params: { message: event.message, detail: event.detail ?? null } }),
          );
          await this.setStatus(sessionId, "error", event.message);
          runtime.streamingText = "";
          // S3b:回合以錯誤/interrupt 收場,同樣視為回合結束。
          this.turnLimiter.endTurn(sessionId);
          runtime.openToolCalls.clear();
          break;
        }
        case "terminal-data": {
          // pty 直通輸出:量大且無結構化語意,不逐筆持久化(見
          // packages/shared/src/events.ts 的 TerminalDataEventSchema 註解),
          // 只透過上方已經 emit 的 "session-event" 直通轉發給 UI。這裡只需要
          // 做兩件事:(1) 若目前狀態不是 busy(理論上不會是 waiting,pty 不會
          // 發 permission-request,但保險起見仍檢查),補回 busy;(2) 視為一次
          // 「輸出活動」,延後靜止計時器(見 PTY_IDLE_TIMEOUT_MS 說明)。
          await this.ensureBusy(sessionId);
          this.scheduleIdleIfTerminal(sessionId, runtime);
          break;
        }
        /**
         * S3b(CostGovernor)新增:累計花費/token(S3a 的 `UsageEvent`)。轉發給
         * `CostGovernor.recordUsage()` 做權威 rollup + 門檻檢查(見
         * cost-governor.ts)。**刻意不 await**——usage 記錄與門檻檢查不應該
         * 拖慢這個事件迴圈讀取後續事件的速度(trip 動作本身是背景執行的
         * fire-and-forget,同 `turnLimiter.recordToolCall()` 的既有模式)。
         * `envelope.timestamp` 是這個事件抵達 core 的時間戳,決定「日」的歸屬
         * (§1「跨日瞬間」:以事件 ts 歸屬,不因處理延遲跨錯日)。
         */
        case "usage": {
          void this.costGovernor.recordUsage(sessionId, event, envelope.timestamp).catch((err) => {
            console.error(`[cost-governor] recordUsage(${sessionId}) 失敗: ${String(err)}`);
          });
          break;
        }
        /**
         * 這輪(slash command)新增:快取這個 session 目前的 "/" 指令清單
         * (`session.getSlashCommands` pull 方法讀的就是這裡,見該方法註解)。
         * **REPLACE 語意**——整份覆蓋 `runtime.slashCommands`,不累加,對齊
         * 三個來源adapter「清單有變動就整份重推」的既有語意(見 events.ts 的
         * `AvailableCommandsEventSchema` 註解)。這個事件不需要持久化、不影響
         * CostGovernor/TurnLimiter/session 狀態機,純粹是記憶體快取更新。
         */
        case "available-commands": {
          runtime.slashCommands = event.commands;
          runtime.slashCommandsObserved = true;
          break;
        }
      }
    }
  }

  /**
   * session 結束/重啟時清除 per-session 暫態,避免 Map 隨 session 生命週期無限增長
   * (比照既有 `permissionState`/`waitingSince` 的清理慣例)。
   *
   * 2026-09-04(稽核修補):`sendPrompt()` 的 per-session 鎖鏈在這裡清 ——
   * 由所有 dispose/delete/重啟路徑共用同一個清理點,不必各自記得。
   * (2026-10-02:原本同一個方法還清 context checkpoint 的三組暫態,
   * 該機制已隨 team 一併移除。)
   * 2026-10-02(P3):一併清掉這個 session 的**待送跨 session 佇列**,並重算還被引用的訊息鏈、丟掉其餘鏈的
   * 計數(這個 session 可能是某條鏈上最後一個還在的參與者)。呼叫時機:`this.runtime` 已經刪掉這條 session。
   */
  private clearPerSessionState(sessionId: string): void {
    this.sendPromptLocks.delete(sessionId);
    this.pendingIdleInjection.delete(sessionId);
    this.chainBudget.prune(this.referencedChainIds());
  }

  /**
   * 把一則**跨 session 訊息**(`send_to_session`/`create_session` 的第一則/UI 轉傳)投遞給某個 session:
   * 目標 idle 就立刻送(此刻才用 `session-envelope.ts` 組信封——持久化的 content 存原始本體),
   * busy/waiting 就排進 `pendingIdleInjection` 等它下一次 completed 空檔 flush(見 consumeEvents 的 completed case)。
   *
   * 與舊的 `deliverPromptWhenIdle()` 的差異:
   *   - 目標 runtime 已不存在 → **丟錯誤**,不再靜默丟棄(呼叫端要能據此回報「沒送到」,不得假裝成功)。
   *   - 立即送出時 `sendPrompt` 內建的成本斷路器可能拒絕 → 同樣往外丟,讓 agent 看到明確原因;
   *     排隊後由 flush 路徑投遞時失敗,則由 flush 呼叫端 catch + `console.warn`(那時已經沒有人能接這個錯誤)。
   */
  private async deliverNetworkMessage(sessionId: string, item: PendingNetworkMessage): Promise<void> {
    if (!this.runtime.has(sessionId)) {
      throw new DeskmonyError(ErrorCodes.SESSION_NOT_RUNNING, { sessionId }, `session 尚未啟動或已結束: ${sessionId}`);
    }
    const target = await this.getSession(sessionId);
    if (target?.status === "idle") {
      const sender = await this.getSession(item.origin.sessionId);
      const agentLabel = sender ? await this.agentLabelOf(sender.providerId) : "unknown";
      await this.sendPromptSerialized(
        sessionId,
        { text: buildEnvelopeForOrigin(item.origin, agentLabel, item.text) },
        { chainId: item.chainId, origin: item.origin, persistedText: item.text },
      );
      return;
    }
    const queue = this.pendingIdleInjection.get(sessionId) ?? [];
    queue.push(item);
    this.pendingIdleInjection.set(sessionId, queue);
  }

  /**
   * 這個 session 剛回到 idle(`completed` 事件,或 pty 的靜止計時器):把排在它身上的下一筆待送跨 session 訊息
   * 投遞出去(一次一筆)。投遞失敗(例如每日成本斷路器擋下)時沒有人能接這個錯誤——只記警告。
   */
  private flushPendingNetworkMessage(sessionId: string): void {
    const queue = this.pendingIdleInjection.get(sessionId);
    if (!queue || queue.length === 0) return;
    const item = queue.shift()!;
    if (queue.length === 0) this.pendingIdleInjection.delete(sessionId);
    void this.deliverNetworkMessage(sessionId, item).catch((err) => {
      console.warn(`[session-network] 投遞排隊中的訊息給 session ${sessionId} 失敗(忽略): ${String(err)}`);
    });
  }

  /**
   * pty session 專用的「靜止後轉 idle」計時器(見 PTY_IDLE_TIMEOUT_MS 上方
   * 說明)。非 terminal 能力的 adapter(capabilities().terminal === false)
   * 呼叫這個方法是 no-op —— 這些 adapter 本來就會自己送出 completed/error
   * 事件來結束一輪,不需要活動量測的簡化判斷。
   */
  private scheduleIdleIfTerminal(sessionId: string, runtime: RuntimeState): void {
    if (!runtime.adapter.capabilities().terminal) return;
    this.clearPtyIdleTimer(runtime);
    runtime.ptyIdleTimer = setTimeout(() => {
      runtime.ptyIdleTimer = undefined;
      // 2026-10-02(P3):pty 沒有 "completed" 事件,轉回 idle 之後就是它「有空」的時刻——flush 排在它身上的
      // 待送跨 session 訊息(pty 只能收訊息、不能主動傳,見 simplify-agents-sessions_detail.md §P3.6)。
      void this.setStatus(sessionId, "idle").then(() => this.flushPendingNetworkMessage(sessionId));
      // S3b:pty 沒有 "completed"/"error" 事件標誌回合結束(見檔案頂端
      // PTY_IDLE_TIMEOUT_MS 說明——靜止判定是這類 adapter 唯一的「回合結束」
      // 訊號),這裡是 pty 版本的 `turnLimiter.endTurn()` 呼叫點。
      this.turnLimiter.endTurn(sessionId);
    }, PTY_IDLE_TIMEOUT_MS);
    runtime.ptyIdleTimer.unref?.();
  }

  private clearPtyIdleTimer(runtime: RuntimeState): void {
    if (runtime.ptyIdleTimer) {
      clearTimeout(runtime.ptyIdleTimer);
      runtime.ptyIdleTimer = undefined;
    }
  }

  /** 廣播一筆權限請求已被解決(使用者回覆或逾時自動 deny),讓所有 client 的彈窗同步關閉。 */
  private emitPermissionResolved(payload: PermissionResolvedPush): void {
    this.emit("permission-resolved", payload);
  }

  private async ensureBusy(sessionId: string): Promise<void> {
    const session = await this.getSession(sessionId);
    if (session && session.status === "waiting") {
      await this.setStatus(sessionId, "busy");
    }
  }

  /** 公開:查詢單一 session 的目前狀態(idle/busy/...),例如投遞訊息前決定要立即送還是排隊。 */
  async getSession(sessionId: string): Promise<Session | undefined> {
    const rows = await this.db.select().from(sessionsTable).where(eq(sessionsTable.id, sessionId)).all();
    return rows[0] ? this.permissions.attachTo(rowToSession(rows[0])) : undefined;
  }

  private async setStatus(sessionId: string, status: SessionStatus, lastError?: string): Promise<void> {
    // S3b(CostGovernor)§4:進入/離開 waiting 的時間戳記錄——見上方
    // `waitingSince` 欄位註解。用「是否已經追蹤這次 waiting」而非「前一個
    // 狀態是什麼」判斷,避免這個方法需要額外查詢舊狀態。
    if (status === "waiting") {
      if (!this.waitingSince.has(sessionId)) this.waitingSince.set(sessionId, Date.now());
    } else {
      this.waitingSince.delete(sessionId);
    }
    const updatedAt = Date.now();
    await this.db
      .update(sessionsTable)
      // S6(crash-recovery)L4 §1:`lastSeenAt` 每次狀態變更都更新(供復原視圖
      // 顯示「中斷前最後活動」)。`interruptedAt` 只在對帳(`reconcileOnStartup()`)
      // 或「重跑」失敗兜底時才會被設值(見那兩處的直接 db.update),這裡一律
      // 清成 null——任何經由 `setStatus()` 的正常狀態轉換都代表這條 session
      // 已經不再是「等人分流的孤兒」了。
      .set({ status, updatedAt, lastError: lastError ?? null, lastSeenAt: updatedAt, interruptedAt: null })
      .where(eq(sessionsTable.id, sessionId))
      .run();
    const session = await this.getSession(sessionId);
    if (session) {
      this.emit("session-updated", session);
    }
  }

  /**
   * async-scribbling-llama.md Phase 6:第四個選填參數 `attachments`——目前
   * 只有 `case "session.sendPrompt"`(見上方 `sendPrompt()`)會傳非空值,其餘
   * 呼叫點(tool-call/tool-result/system/assistant 訊息)維持不變,`undefined`
   * 時存 `null`,對齊 `messages.attachments` 的 nullable 語意(見
   * packages/db/src/schema.ts 的欄位註解)。
   *
   * 2026-10-02(P3):第五個選填參數 `origin`——只有跨 session 訊息(`send_to_session`/`create_session`/
   * UI 轉傳)才會有值,存 `messages.origin`(JSON);`content` 存的是**原始 message 本體**,信封不落地。
   */
  private async persistMessage(
    sessionId: string,
    role: MessageRecord["role"],
    content: string,
    attachments?: PromptAttachment[],
    origin?: MessageOrigin,
  ): Promise<string> {
    // 2026-09-17:回傳 row id——`"tool-call"` case 補資訊時要就地更新同一筆
    // (見 `updateMessageContent()`),其餘呼叫點照舊忽略回傳值。
    return (await this.persistMessageRow(sessionId, role, content, attachments, origin)).id;
  }

  /** 同 `persistMessage()`,但回傳完整的 `MessageRecord`(`session-message` push 要把這筆原樣推給 client)。 */
  private async persistMessageRow(
    sessionId: string,
    role: MessageRecord["role"],
    content: string,
    attachments?: PromptAttachment[],
    origin?: MessageOrigin,
  ): Promise<MessageRecord> {
    const row = {
      id: randomUUID(),
      sessionId,
      role,
      content,
      attachments: attachments && attachments.length > 0 ? JSON.stringify(attachments) : null,
      origin: origin ? JSON.stringify(origin) : null,
      createdAt: Date.now(),
    };
    await this.db.insert(messagesTable).values(row).run();
    return {
      id: row.id,
      sessionId,
      role,
      content,
      createdAt: row.createdAt,
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
      ...(origin ? { origin } : {}),
    };
  }

  /**
   * 2026-09-17:就地改寫一筆訊息的 content——目前唯一的用途是同一個工具呼叫補上
   * 完整 input(見 `RuntimeState.openToolCalls`)。刻意不動 `createdAt`:歷史
   * (`getHistory()` 依 createdAt 排序)裡這筆 call 要留在工具呼叫**開始**的位置,
   * 不能因為參數晚到,就排到這段期間寫入的其他訊息(例如權限逾時的系統訊息)
   * 之後。
   */
  private async updateMessageContent(messageId: string, content: string): Promise<void> {
    await this.db.update(messagesTable).set({ content }).where(eq(messagesTable.id, messageId)).run();
  }
}

/** `messages.origin` 欄位(JSON 字串或 NULL)→ `MessageOrigin`;壞掉的資料當作沒有來源,不讓讀歷史因此失敗。 */
function parseOrigin(raw: string | null | undefined): MessageOrigin | undefined {
  if (!raw) return undefined;
  try {
    const parsed = MessageOriginSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `read_session` 的單則內容截斷:超過 `READ_SESSION_MAX_CONTENT_CHARS` 就只留前面那段並**標註**(內文結尾 +
 * `truncated: true`)。不切在 surrogate pair 中間(否則會留下一個壞掉的半個字元)。
 */
function truncateForNetwork(content: string): { content: string; truncated: boolean } {
  if (content.length <= READ_SESSION_MAX_CONTENT_CHARS) return { content, truncated: false };
  let end = READ_SESSION_MAX_CONTENT_CHARS;
  const last = content.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return {
    content: `${content.slice(0, end)}\n…(內容已截斷:原長 ${content.length} 字元,只顯示前 ${end} 字元)`,
    truncated: true,
  };
}

function rowToSession(row: typeof sessionsTable.$inferSelect): Session {
  return {
    id: row.id,
    title: row.title,
    // 啟動時的回填遷移之後 provider_id 一律非 NULL;型別上仍是 nullable,保險起見給 legacy-unknown。
    providerId: row.providerId ?? "legacy-unknown",
    adapterType: row.adapterType as Session["adapterType"],
    status: row.status as SessionStatus,
    workingDir: row.workingDir,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastError: row.lastError ?? undefined,
    model: row.model ?? undefined,
    effort: (row.effort ?? undefined) as Session["effort"],
    interruptedAt: row.interruptedAt ?? undefined,
    lastSeenAt: row.lastSeenAt ?? undefined,
    backendSessionId: row.backendSessionId ?? undefined,
    parentSessionId: row.parentSessionId ?? undefined,
  };
}

function sessionToRow(session: Session, launch: StoredLaunchInfo): typeof sessionsTable.$inferInsert {
  return {
    id: session.id,
    title: session.title,
    // `agent_profile_id` 在既有 DB 是 NOT NULL,無法改約束,新 session 寫入 providerId 當值(見 schema.ts 的
    // legacyAgentProfileId 註解);真正的資料在 provider_id/launch_command/launch_args。
    legacyAgentProfileId: session.providerId,
    providerId: session.providerId,
    launchCommand: launch.command ?? null,
    launchArgs: launch.args ? JSON.stringify(launch.args) : null,
    adapterType: session.adapterType,
    status: session.status,
    workingDir: session.workingDir,
    lastError: session.lastError ?? null,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    model: session.model ?? null,
    effort: session.effort ?? null,
    interruptedAt: session.interruptedAt ?? null,
    lastSeenAt: session.lastSeenAt ?? null,
    backendSessionId: session.backendSessionId ?? null,
    parentSessionId: session.parentSessionId ?? null,
  };
}
