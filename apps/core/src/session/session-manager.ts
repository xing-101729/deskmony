import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, access, writeFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import type { NexusDb } from "@deskmony/db";
import { sessions as sessionsTable, messages as messagesTable } from "@deskmony/db";
import type { AdapterRegistry, AgentAdapter, AgentHandle, TeamSpawnContext } from "@deskmony/adapters";
import type {
  AdapterCapabilities,
  AgentOverride,
  AgentProfile,
  AgentSoftware,
  CreateSessionInput,
  EffortLevel,
  MessageRecord,
  PermissionResolvedPush,
  PolicyRule,
  PromptInput,
  Session,
  SessionEventEnvelope,
  SessionPermissionMode,
  SessionStatus,
  SpawnChildSessionInput,
  SubagentChildSummary,
  TeamBusPort,
} from "@deskmony/shared";
import type { ProfileStore } from "../profiles.js";
import type { PermissionGateway } from "../permissions/permission-gateway.js";
import type { TeamManager } from "../team/team-manager.js";
import { getProviderEnv, type SettingsStore } from "../settings/settings-store.js";
import type { PolicyEngine, PermissionRequest, ExecContext } from "../permissions/policy-engine.js";
import type { AuditLog } from "../enforcement/audit-log.js";
import type { Notifier } from "../enforcement/notifier.js";
import { appendPolicyRule } from "../config/config-file-writer.js";
import type { TurnLimiter } from "../cost/turn-limiter.js";
import type { CostGovernor } from "../cost/cost-governor.js";

/**
 * S7(auto-mode-and-yolo)L4 §2:YOLO(`"auto-accept-all"`)的存活時間——過了
 * 這段時間,下一次權限決策前的惰性檢查會自動回落 `"always-ask"`(見
 * `checkAndExpireYolo()`)。**用惰性檢查、不用計時器**(L4 §2「過期檢查時機:
 * 每次 decide() 前惰性檢查」)。
 *
 * 可由 `DESKMONY_YOLO_DURATION_MS` 環境變數覆寫,**純粹是為了 e2e 測試能在
 * 合理時間內驗證「30 分鐘後過期」這條規則**,不是使用者可調整的偏好——這個
 * 值本身不落地任何設定檔(不像 `daemon.permissionTimeoutMs` 那樣走
 * config.json 分層合併),與 `DESKMONY_AUTH_TOKEN` 一樣是刻意留在
 * `apps/core/src/index.ts` 之外的環境變數讀取(見該檔案「唯一例外」的說明,
 * 這裡是第二個例外,理由相同:不該被任何 client 或設定檔遠端/本機改動,
 * 只給啟動這個 process 的人用)。
 */
export const DEFAULT_YOLO_DURATION_MS = 30 * 60_000;

/** S7:一個 session 目前的暫態權限模式(auto/YOLO)——只存在記憶體,不落地
 *  DB(見 packages/shared/src/agent-profile.ts 的 `SessionPermissionModeSchema`
 *  註解)。`yoloExpiresAt` 只有 `mode === "auto-accept-all"` 時有值。 */
export interface SessionPermissionState {
  mode: SessionPermissionMode;
  yoloExpiresAt?: number;
}

/**
 * S7 L4 §2.1:`ExecContext` 的 `attended`/`local` 兩個欄位是**環境事實**,
 * 唯一知道這件事的是 Gateway(它才看得到有哪些 WS 連線、來源是不是
 * loopback)。但 SessionManager 建構時 Gateway 還不存在(Gateway 的建構子
 * 需要 SessionManager),所以這裡只宣告一個**最小介面**,由
 * `apps/core/src/index.ts` 在 Gateway 建好之後用 `setClientPresence()` 事後
 * 注入——與既有的 `setTeamBus()` 完全同一個解耦手法(見該方法註解),不製造
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
 * S8(agent-lifecycle)L4 §4.2:長命 agent 的 context 使用率達此比例時,觸發
 * 「寫筆記 + checkpoint 重啟」——留 15% 給「寫筆記」這輪本身用。訊號來源是
 * S3a 的 `context-usage` 事件(`used`/`size`),**只對 Claude SDK 這類真的會
 * 送這個事件的後端生效**——ACP 經 Claude Code bridge 結構上不會送(見
 * docs/LAYER-4-detail-design/usage-metering_detail.md §7),那類後端完全不會
 * 走到這裡,UI 端的誠實揭露見 apps/desktop/src/views/TeamManagementDialog.tsx。
 */
const CONTEXT_CHECKPOINT_THRESHOLD = 0.85;

/**
 * S8 L4 §3.1:團隊/個人筆記的約定位置——**相對於 session 的 workingDir**(對
 * persistent 的協調者是 team.workingDir 本身,對 ephemeral worker 是該任務的
 * worktree;worktree 若日後 merge 回主幹,筆記也隨之進入 review/diff 流程,見
 * agent-lifecycle_detail.md §3.1)。⚠️ 這與家目錄的 `~/.deskmony/`(S1 hard-deny
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

/** §3.2:附加(不取代)在 systemPrompt 尾端的「指路」段落,文字比照 L4 規格。 */
function buildNotesPointerBlock(displayName: string): string {
  return [
    "【團隊記憶】",
    "你的團隊筆記位於 .deskmony/notes/(相對於工作目錄):",
    "- team.md:全隊共用的專案慣例與決策紀錄",
    `- ${displayName}.md:你的個人筆記`,
    "開始工作前先讀取相關筆記;學到值得跨任務保留的結論時,寫回筆記。",
    "筆記會進 git,請像寫程式碼一樣審慎。",
  ].join("\n");
}

function withNotesPointer(existingSystemPrompt: string | undefined, displayName: string): string {
  const block = buildNotesPointerBlock(displayName);
  return existingSystemPrompt && existingSystemPrompt.trim().length > 0
    ? `${existingSystemPrompt}\n\n${block}`
    : block;
}

/**
 * §4.2「接手」摘要文字的截斷規則——與 `RecoveryService`(apps/core/src/
 * recovery/recovery-service.ts)的 `buildSummaryText()` 是同一套規則(上限
 * 4000 字元,超過從最舊的對話開始截斷),這裡獨立一份小副本:
 * `RecoveryService` 依賴 `SessionManager`,這裡不能反向 import 造成循環依賴。
 */
const CHECKPOINT_SUMMARY_CHAR_LIMIT = 4000;
function buildCheckpointSummaryText(header: string, conversationLines: string[]): string {
  let convo = [...conversationLines];
  const render = (): string => [header, "最後對話(最多 3 輪):", ...(convo.length > 0 ? convo : ["(無)"])].join("\n");
  let text = render();
  while (text.length > CHECKPOINT_SUMMARY_CHAR_LIMIT && convo.length > 0) {
    convo = convo.slice(1);
    text = render();
  }
  if (text.length > CHECKPOINT_SUMMARY_CHAR_LIMIT) {
    text = text.slice(0, CHECKPOINT_SUMMARY_CHAR_LIMIT);
  }
  return text;
}

interface RuntimeState {
  handle: AgentHandle;
  /** 這個 session 建立時依 profile.software 從 AdapterRegistry 選出的 adapter 實例。
   * 後續 sendPrompt/interrupt/resolvePermission/dispose 都必須透過它,不能假設
   * 全 core 只有單一 adapter(M2 Round A:多 adapter 並存,見 AdapterRegistry)。 */
  adapter: AgentAdapter;
  /** 累積中的 assistant 訊息文字(用於 completed 事件缺少 finalText 時的備援)。 */
  streamingText: string;
  /** 只有 terminal 能力的 adapter(pty)才會用到,見 PTY_IDLE_TIMEOUT_MS 說明。 */
  ptyIdleTimer?: ReturnType<typeof setTimeout>;
  /** M3 Round A:若這個 session 是某個 team 成員建立的,記錄對應的 TeamMember.id
   * (供 MessageBus 反查、session 刪除時清理 member↔session 對應)。 */
  teamMemberId?: string;
  /** S1(PolicyEngine)新增:這個 session 建立時的 `AgentProfile.id`/`workingDir`,
   * 供 permission-request 事件到達時組裝 `PermissionRequest`(profileId/role 供
   * 規則 scope 精確比對、workingDir 當作 hard-deny 的 worktree 邊界)——直接存
   * 在 RuntimeState 上,避免每次權限請求都多一次 DB 查詢 session 記錄(比照既有
   * teamMemberId 的做法)。`ExecContext` 的三個欄位**不**來自這裡,見
   * `buildExecContext()`。 */
  agentProfileId: string;
  workingDir: string;
  /** S6(crash-recovery)L4 §4.1:這條 session 的後端持久化 session 識別碼
   *  (捕捉到之前是 undefined)——見 `persistBackendSessionId()`。 */
  backendSessionId?: string;
  /** S12(session-subagent):若這個 session 是 child subagent,記錄 parent
   *  session id——child session completed 時用來向上回傳結果。 */
  parentSessionId?: string;
}

/**
 * SessionManager(ARCHITECTURE.md 3.3 節):
 *   「對每個 agent 成員建立/恢復/中斷 session;維護 session 狀態機
 *    (idle / busy / waiting-permission / error)」
 *
 * M2 Round A:一個 session 對應一個 AgentAdapter handle,但 adapter 種類依
 * `AgentProfile.software` 從建構子注入的 `AdapterRegistry` 動態選擇(M1 時
 * 是固定的單一 ClaudeAgentSdkAdapter)。session 中斷後重啟需要重新 spawn
 * (尚未支援 SDK 的 resume/continue)。
 */
export class SessionManager extends EventEmitter {
  private runtime = new Map<string, RuntimeState>();
  /** M3 Round A:TeamMember.id -> 目前綁定的 sessionId(反向 map 見 sessionMembers)。 */
  private memberSessions = new Map<string, string>();
  private sessionMembers = new Map<string, string>();
  /** S7(auto-mode-and-yolo):每個 session 的暫態權限模式(auto/YOLO)——見
   *  `SessionPermissionState` 型別註解,**刻意不落地 DB**(HLD §2:崩潰/重啟
   *  不復活,回落 `profile.permissionLevel`)。session 刪除時一併清除(見
   *  `deleteSession()`),避免無限增長。 */
  private permissionState = new Map<string, SessionPermissionState>();
  /** 透過 setTeamBus() 事後注入(見 apps/core/src/index.ts 的建構順序說明:
   * MessageBus 的建構子需要 SessionManager,SessionManager 也需要把
   * TeamBusPort 傳給 adapter.spawn(),兩者互相依賴,用 setter 打破循環)。 */
  private teamBus: TeamBusPort | undefined;
  /** S7 L4 §2.1:透過 `setClientPresence()` 事後注入(理由同上方 teamBus:
   *  Gateway 的建構子需要 SessionManager,不能反過來在建構子要求 Gateway)。
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
   * S8(agent-lifecycle)L4 §4.2:context checkpoint 重啟的暫態(全部只存在
   * 記憶體,session 結束/重啟時清除,見 `clearContextCheckpointState()`)——
   *   - `contextCheckpointTriggered`:這個 sessionId 這一輪成長週期是否已經
   *     觸發過(§4.2「同一個 session 只觸發一次,避免重啟迴圈」);checkpoint
   *     重啟成功後會刪掉,讓下一輪成長週期能再次觸發(「重啟後是新 session,
   *     計數歸零」)。
   *   - `contextCheckpointPendingNote`:threshold 命中當下這個 session 正忙
   *     (busy/waiting),記下要送出的「寫筆記」prompt 文字,等目前這輪
   *     `completed` 後才送出(不能在忙碌時插隊送出第二個 prompt)。
   *   - `contextCheckpointAwaitingRestart`:「寫筆記」prompt 已送出,等它的
   *     `completed` 事件抵達後才真正執行 checkpoint 重啟。
   */
  private readonly contextCheckpointTriggered = new Set<string>();
  private readonly contextCheckpointPendingNote = new Map<string, string>();
  private readonly contextCheckpointAwaitingRestart = new Set<string>();

  /**
   * S12 Phase2 R1+R4:任一 session 正忙(busy/waiting)時,暫存要在它下一次
   * `completed` 空檔送達的訊息文字,等到那個空檔才真正送出(見
   * `deliverPromptWhenIdle()` 與 consumeEvents 的 completed case)——同一個
   * session 可累積多筆,每次 flush 只送一筆。這個 Map 的 key 只是「目前要
   * 送訊息的目標 session」,不特別區分父/子,兩個方向共用同一套機制:
   *   - R1:子完成時把結果注入父(key = 父 sessionId)。
   *   - R4:`send_to_subagent` 工具把父的追加訊息送給子(key = 子 sessionId)。
   * 比照 `contextCheckpointPendingNote` 的清理慣例:session 結束/重啟時清除
   * (見 deleteSession/disposeSessionForMember/shutdownAll/reclaimSession),
   * 避免無限增長。
   */
  private readonly pendingIdleInjection = new Map<string, string[]>();

  constructor(
    private readonly adapters: AdapterRegistry,
    private readonly db: NexusDb,
    private readonly profiles: ProfileStore,
    private readonly permissionGateway: PermissionGateway,
    private readonly teamManager: TeamManager,
    /**
     * 這輪新增(provider 目錄重構):`createSession()` 依 `profile.providerId`
     * 查詢 provider 層級的預設 env(settings 的 per-provider 偏好),疊在
     * `profile.env` 之下(profile 自己的 env 優先覆寫,見下方 createSession()
     * 內的合併邏輯與 packages/shared/src/agent-profile.ts 的 `providerId`/
     * `env` 欄位註解)。
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
     * S3b(CostGovernor)新增:任務預算/每日 kill-switch(見
     * apps/core/src/cost/cost-governor.ts)。`sendPrompt()` 送出前先問
     * `checkSendPromptAllowed()`,`consumeEvents()` 收到 `usage` 事件時轉發給
     * `recordUsage()`。
     */
    private readonly costGovernor: CostGovernor,
    /** S7:YOLO 存活時間,見上方 `DEFAULT_YOLO_DURATION_MS` 註解。 */
    private readonly yoloDurationMs: number = DEFAULT_YOLO_DURATION_MS,
  ) {
    super();
  }

  /** 見上方 teamBus 欄位註解:apps/core/src/index.ts 建立好 MessageBus 後回頭注入。 */
  setTeamBus(bus: TeamBusPort): void {
    this.teamBus = bus;
  }

  /** S7 L4 §2.1:apps/core/src/index.ts 建立好 WsGateway 後回頭注入(比照
   *  `setTeamBus()`)。未注入時的行為見 `buildExecContext()`。 */
  setClientPresence(presence: ClientPresencePort): void {
    this.clientPresence = presence;
  }

  /** 某個 team member 目前綁定的 sessionId(供 MessageBus 決定投遞策略)。 */
  getSessionIdForMember(memberId: string): string | undefined {
    return this.memberSessions.get(memberId);
  }

  /** 某個 sessionId 屬於哪個 team member(供 MessageBus 監聽 session-updated 時反查)。 */
  getMemberIdForSession(sessionId: string): string | undefined {
    return this.sessionMembers.get(sessionId);
  }

  async listSessions(): Promise<Session[]> {
    const rows = await this.db.select().from(sessionsTable).all();
    return rows.map((row) => this.attachPermissionState(rowToSession(row)));
  }

  /** S6(crash-recovery):復原視圖的資料來源之一,見 `RecoveryService.list()`。 */
  async listInterruptedSessions(): Promise<Session[]> {
    const rows = await this.db.select().from(sessionsTable).where(eq(sessionsTable.status, "interrupted")).all();
    return rows.map((row) => this.attachPermissionState(rowToSession(row)));
  }

  /**
   * S6(crash-recovery)新增:「放棄」——標 `closed`(不是 `error`,因為這不是
   * 執行失敗,是人類主動決定不處理這條中斷的 session),**worktree/任務一律
   * 保留**(不自動刪,同 S3b T2「回收 ≠ 丟棄」的既有語意)。
   */
  async abandonInterruptedSession(sessionId: string): Promise<void> {
    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error(`找不到 session: ${sessionId}`);
    }
    if (session.status !== "interrupted") {
      throw new Error(`session ${sessionId} 目前狀態是 "${session.status}",不是 "interrupted",無法「放棄」`);
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
      }));
  }

  async createSession(input: CreateSessionInput): Promise<Session> {
    const profile = await this.profiles.get(input.agentProfileId);
    if (!profile) {
      throw new Error(`找不到 agent profile: ${input.agentProfileId}`);
    }

    // M3 Round A:若這個 session 屬於某個 team 成員,查出 member 資訊,建立
    // team context 傳給 adapter.spawn()(目前只有 ClaudeAgentSdkAdapter 會
    // 據此掛載 team-bus MCP 工具,見 packages/adapters/src/team-bus-mcp.ts;
    // ACP/PTY 這輪不掛,單純忽略這個參數)。
    let member: Awaited<ReturnType<TeamManager["getMember"]>> | undefined;
    let teamContext: TeamSpawnContext | undefined;
    if (input.teamMemberId) {
      member = await this.teamManager.getMember(input.teamMemberId);
      if (!member) {
        throw new Error(`找不到 team member: ${input.teamMemberId}`);
      }
      if (this.teamBus) {
        teamContext = {
          teamId: member.teamId,
          memberId: member.id,
          memberName: member.name,
          memberRole: member.role,
          bus: this.teamBus,
        };
      }
    }

    // 這輪新增:agentOverride 有提供時,套用出一份「這次真正要拿去 spawn」的
    // profile 形狀(不寫回 DB,base profile 記錄本身不變),見
    // `applyAgentOverride()` 的完整說明。沒有 override 時原樣等於 profile。
    const overriddenProfile = this.applyAgentOverride(profile, input.agentOverride);

    // S8(agent-lifecycle)L4 §3.2:env 合併 + `.deskmony/notes/` 確保存在 +
    // systemPrompt 附加「指路」段落,三件事都收斂到 `prepareSpawnProfile()`
    // (`performContextCheckpointRestart()` 的 respawn 路徑共用同一份邏輯,
    // 避免兩處各自维护一份而漂移)。
    const effectiveProfile = await this.prepareSpawnProfile(overriddenProfile, input.workingDir, member?.name ?? profile.name);

    const adapter = this.adapters.get(overriddenProfile.software);
    const handle = await adapter.spawn(effectiveProfile, { path: input.workingDir }, teamContext);

    const now = Date.now();
    const session: Session = {
      id: handle.id,
      title: input.title ?? "新對話",
      // agentProfileId 仍指回 base profile(provenance/permissionLevel 等的
      // 權威來源不變),adapterType/model 則反映套用 override 之後的最終值。
      agentProfileId: profile.id,
      adapterType: overriddenProfile.software,
      status: "idle",
      workingDir: input.workingDir,
      createdAt: now,
      updatedAt: now,
      // M5 Round C:session 級別的 model 預設取自 profile.model(profile 本身
      // 沒設定時維持 undefined,不臆測一個預設值——UI fallback 顯示邏輯見
      // packages/shared/src/session.ts 的 SessionSchema.model 註解)。這輪起
      // 若有 agentOverride.model 則反映覆寫後的值(overriddenProfile.model)。
      model: overriddenProfile.model,
      // 比照上面的 model:session 級別的 effort 預設取自 profile.effort,若有
      // agentOverride.effort 則反映覆寫後的值(overriddenProfile.effort)。
      effort: overriddenProfile.effort,
      // S9:建立子 session 時帶入 parent id
      parentSessionId: input.parentSessionId,
    };

    await this.db.insert(sessionsTable).values(sessionToRow(session)).run();
    this.runtime.set(session.id, {
      handle,
      adapter,
      streamingText: "",
      teamMemberId: member?.id,
      agentProfileId: profile.id,
      workingDir: input.workingDir,
      parentSessionId: input.parentSessionId,
    });
    if (member) {
      this.memberSessions.set(member.id, session.id);
      this.sessionMembers.set(session.id, member.id);
    }
    // S7:初值 = profile.permissionLevel(必為 "always-ask"/"auto-accept-edits"
    // 之一,見 PermissionLevelSchema 收窄後的定義,不可能是 YOLO)。
    this.permissionState.set(session.id, { mode: profile.permissionLevel });

    void this.consumeEvents(session.id);

    this.emit("session-list-updated");
    if (member) {
      this.emit("member-session-ready", { memberId: member.id, sessionId: session.id });
    }
    return this.attachPermissionState(session);
  }

  async sendPrompt(sessionId: string, prompt: PromptInput): Promise<void> {
    const runtime = this.runtime.get(sessionId);
    if (!runtime) {
      throw new Error(`session 尚未啟動或已結束: ${sessionId}`);
    }

    // S3b(CostGovernor)L4 §2/§3.3:任務預算/每日 kill-switch 越線後,只擋
    // 「後續 prompt」——這裡是唯一的送出前檢查點(gateway 的 `session.
    // sendPrompt` 與 MessageBus 的訊息注入都走這個方法,見 cost-governor.ts
    // 頂端「halt 粒度」說明)。**不擋已經在跑的回合**,故意不在這裡呼叫
    // `interrupt()`。
    const budgetCheck = await this.costGovernor.checkSendPromptAllowed(sessionId);
    if (!budgetCheck.allowed) {
      throw new Error(budgetCheck.reason ?? "此 session 已被成本斷路器擋下,無法送出新的 prompt");
    }

    await this.persistMessage(sessionId, "user", prompt.text);
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
   * M3 Round B 修正(interrupt 時序 race):改成回傳 Promise 並 await
   * adapter 的 `interrupt()`(見 packages/adapters/src/types.ts 的介面註解、
   * apps/core/src/bus/message-bus.ts 的 `deliverToMember()`)——呼叫端(尤其
   * 是 MessageBus 的 interrupt 投遞路徑)必須等這裡 resolve 才能安全地注入
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
  resolvePermission(requestId: string, decision: "allow" | "deny", rememberRule?: PolicyRule): void {
    const resolved = this.permissionGateway.resolve(requestId);
    if (!resolved) return;
    const { sessionId, strong } = resolved;
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
        this.policyEngine.addRule(rememberRule);
        try {
          appendPolicyRule(this.configPath, rememberRule);
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
   * S7:切換一個 session 的暫態權限模式(auto/YOLO)。**遠端一律拒絕**——這個
   * 檢查在 gateway 層(`LOCAL_ONLY_METHODS`,見 ws-gateway.ts),這裡不重複
   * 判斷連線來源(SessionManager 本身不知道是哪個連線呼叫的)。
   * `mode === "auto-accept-all"` 時設定 30 分鐘後過期(惰性檢查,不用計時器,
   * 見 `checkAndExpireYolo()`)。
   */
  setSessionPermissionMode(sessionId: string, mode: SessionPermissionMode): SessionPermissionState {
    if (!this.runtime.has(sessionId)) {
      throw new Error(`session 尚未啟動或已結束,無法設定權限模式: ${sessionId}`);
    }
    const state: SessionPermissionState = { mode };
    if (mode === "auto-accept-all") {
      state.yoloExpiresAt = Date.now() + this.yoloDurationMs;
    }
    this.permissionState.set(sessionId, state);
    // 讓所有已連線的 client(含觸發這次呼叫的那個)都能立即更新 UI 顯示的
    // 常駐標記(HLD §2.2 補償防護),不需要等下一次剛好有權限請求才會反映。
    void this.getSession(sessionId).then((session) => {
      if (session) this.emit("session-updated", session);
    });
    return state;
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
      throw new Error(`session 尚未啟動或已結束,無法切換 model: ${sessionId}`);
    }

    await runtime.adapter.setModel(runtime.handle, model);

    const updatedAt = Date.now();
    await this.db.update(sessionsTable).set({ model, updatedAt }).where(eq(sessionsTable.id, sessionId)).run();
    // 在聊天串留一則系統訊息,讓使用者(即使是之後重新載入 history)也能
    // 看到「這裡換過 model」的紀錄,呼應 ARCHITECTURE 對話延續性的要求。
    await this.persistMessage(sessionId, "system", `已切換模型至 ${model},後續對話由新模型接續`);

    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error(`session 不存在: ${sessionId}`);
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
   * packages/shared/src/agent-profile.ts 的 `EffortLevelSchema` 註解)——其餘
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
      throw new Error(`session 尚未啟動或已結束,無法切換思考程度: ${sessionId}`);
    }

    await runtime.adapter.setEffort(runtime.handle, effort);

    const updatedAt = Date.now();
    await this.db.update(sessionsTable).set({ effort, updatedAt }).where(eq(sessionsTable.id, sessionId)).run();
    // 在聊天串留一則系統訊息,比照 setSessionModel() 的既有作法。
    await this.persistMessage(sessionId, "system", `已切換思考程度至 ${effort},後續對話由新設定接續`);

    const session = await this.getSession(sessionId);
    if (!session) {
      throw new Error(`session 不存在: ${sessionId}`);
    }
    this.emit("session-updated", session);
    return session;
  }

  /**
   * S12(session-subagent):在一個既有 session 底下 spawn 一個子 session,
   * 並立即送出第一段 prompt。子 session 跑完(completed)時,會把結果回報
   * 回父 session(見 consumeEvents 的 completed case)。父 session 必須
   * 目前正在跑(runtime 有對應 handle)。
   */
  async spawnChild(input: SpawnChildSessionInput): Promise<Session> {
    const parent = await this.getSession(input.parentSessionId);
    if (!parent) throw new Error(`找不到父 session: ${input.parentSessionId}`);
    const child = await this.createSession({
      title: input.title ?? `子 agent（${parent.title}）`,
      agentProfileId: input.agentProfileId,
      workingDir: input.workingDir ?? parent.workingDir,
      parentSessionId: input.parentSessionId,
      agentOverride: input.agentOverride,
    });
    await this.sendPrompt(child.id, { text: input.prompt });
    return child;
  }

  /** S12 Phase2 R2:給 `spawn_subagent` MCP 工具用——預設用父 session 自己的
   *  profile spawn 子 session;agent 也可以透過 `list_profiles` 查詢後,自行指定
   *  agentProfileId 改用別的 profile(這輪新增,讓 agent 能自己決定要不要換一個
   *  profile,而不是永遠被迫繼承父 session)。agentProfileId 若指定但不存在,
   *  沿用 `spawnChild()`→`createSession()` 既有的驗證,直接拋錯讓 agent 看到
   *  明確訊息(不在這裡重複驗證)。找不到父 session 時也拋錯(工具端會把錯誤
   *  回給 agent)。 */
  async spawnChildFromTool(input: {
    parentSessionId: string;
    prompt: string;
    title?: string;
    agentProfileId?: string;
  }): Promise<{ childSessionId: string }> {
    const parent = await this.getSession(input.parentSessionId);
    if (!parent) throw new Error(`找不到父 session: ${input.parentSessionId}`);
    const child = await this.spawnChild({
      parentSessionId: input.parentSessionId,
      agentProfileId: input.agentProfileId ?? parent.agentProfileId,
      prompt: input.prompt,
      title: input.title,
    });
    return { childSessionId: child.id };
  }

  /**
   * S12 Phase2 R4:給 `send_to_subagent` MCP 工具用——對一個「已經是這個
   * parentSessionId 的子 session」送出後續訊息(追加指示,不是開新的子任務)。
   * 兩層檢查,順序刻意如下:
   *   1. 找不到 childSessionId 對應的 session → 明確報錯(可能打錯 id,或那個
   *      session 早就被 `deleteSession()` 硬刪了)。
   *   2. 那個 session 存在,但 `parentSessionId` 不等於呼叫端帶入的
   *      parentSessionId → 拒絕(**授權檢查**:防止父 agent 對不是自己開的
   *      子 session 下指令——不管是完全無關的 session,還是自己的祖父/兄弟
   *      session,一律只認「直接子」這一層關係,同 `spawnChildFromTool()` 的
   *      冒名防護精神)。
   *   3. 通過授權檢查,但那個子 session 目前沒有在跑(`this.runtime` 沒有它
   *      ——可能已被 S3b 的 72 小時資源回收站起,或已 `disposeSessionForMember`)
   *      → 明確報錯,而不是讓 `deliverPromptWhenIdle()` 靜默丟棄訊息卻讓這個
   *      工具呼叫看起來像成功了(那樣 agent 會誤以為訊息真的送到了)。
   * 通過三層檢查後才真的呼叫 `deliverPromptWhenIdle()`——子忙碌中會排隊,
   * 不會打斷它正在處理的回合;結果一樣經由既有的 completed → child-result
   * 機制自動回報給父,這裡不需要回傳值。
   */
  async sendToChildFromTool(input: { parentSessionId: string; childSessionId: string; message: string }): Promise<void> {
    const child = await this.getSession(input.childSessionId);
    if (!child) throw new Error(`找不到子 session: ${input.childSessionId}`);
    if (child.parentSessionId !== input.parentSessionId) {
      throw new Error(`session ${input.childSessionId} 不是你的子 session,無法送出訊息`);
    }
    if (!this.runtime.has(input.childSessionId)) {
      throw new Error(`子 session ${input.childSessionId} 目前沒有在執行中(可能已被回收或關閉),無法送出訊息`);
    }
    await this.deliverPromptWhenIdle(input.childSessionId, input.message);
  }

  /**
   * S12 Phase2 R5:給 `list_subagents` MCP 工具用——回傳這個 parentSessionId
   * 自己名下的子 session(不管是 agent 自己呼叫 spawn_subagent 開的,還是
   * 使用者透過 UI「開子 agent」手動開的——後者 agent 完全沒有被告知,這個
   * 查詢是它唯一能發現「自己名下其實有一個子」的方式)。直接複用
   * `listSessions()`(R3 UI 的 SessionList 巢狀顯示本身就是同一份資料的
   * client 端 filter,見 apps/desktop/src/views/SessionList.tsx),避免另開
   * 一條 DB 查詢路徑。只回傳決策/回答問題需要的最小欄位,不含 workingDir/
   * agentProfileId 等內部細節(同 `listProfiles()` 的最小揭露原則)。
   */
  async listChildrenFromTool(parentSessionId: string): Promise<SubagentChildSummary[]> {
    const all = await this.listSessions();
    return all
      .filter((s) => s.parentSessionId === parentSessionId)
      .map((s) => ({ id: s.id, title: s.title, status: s.status, software: s.adapterType, model: s.model }));
  }

  async deleteSession(sessionId: string): Promise<void> {
    const runtime = this.runtime.get(sessionId);
    if (runtime) {
      if (runtime.ptyIdleTimer) clearTimeout(runtime.ptyIdleTimer);
      await runtime.adapter.dispose(runtime.handle);
      this.runtime.delete(sessionId);
      if (runtime.teamMemberId) {
        this.memberSessions.delete(runtime.teamMemberId);
        this.sessionMembers.delete(sessionId);
      }
    }
    await this.db.delete(messagesTable).where(eq(messagesTable.sessionId, sessionId)).run();
    await this.db.delete(sessionsTable).where(eq(sessionsTable.id, sessionId)).run();
    this.permissionState.delete(sessionId); // S7:避免 Map 隨 session 生命週期無限增長。
    this.waitingSince.delete(sessionId); // S3b:同上,避免無限增長。
    this.clearContextCheckpointState(sessionId); // S8:同上,避免無限增長。
    this.pendingIdleInjection.delete(sessionId); // S12 Phase2:同上,避免無限增長。
    this.emit("session-list-updated");
  }

  /**
   * S8(agent-lifecycle)L4 §2.2:ephemeral member 的任務進入終態時,
   * `TaskService` 呼叫這個方法自動 dispose——只釋放子程序、把 DB 狀態標
   * `closed`,**保留** session/messages 記錄(與 `deleteSession()` 不同,那個
   * 方法連 DB 記錄都刪)。找不到活躍 session 時視為冪等的「已經完成」,不拋錯
   * ——`TaskService` 對這個方法的呼叫本身就是「盡力而為」(見該檔案
   * `disposeEphemeralMemberSession()` 的說明)。
   */
  async disposeSessionForMember(memberId: string): Promise<void> {
    const sessionId = this.memberSessions.get(memberId);
    if (!sessionId) return;
    const runtime = this.runtime.get(sessionId);
    if (runtime) {
      if (runtime.ptyIdleTimer) this.clearPtyIdleTimer(runtime);
      await runtime.adapter.dispose(runtime.handle);
      this.runtime.delete(sessionId);
      this.turnLimiter.endTurn(sessionId);
    }
    this.memberSessions.delete(memberId);
    this.sessionMembers.delete(sessionId);
    this.clearContextCheckpointState(sessionId);
    this.pendingIdleInjection.delete(sessionId); // S12 Phase2:同 clearContextCheckpointState,避免無限增長。
    await this.setStatus(sessionId, "closed");
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
   * runtime,任務仍留 blocked、worktree 仍保留,人回來後可以看到完整歷史紀錄
   * 並決定續/棄,同 S6 復原視圖的既有 UX,見 cost-governor_detail.md §4「回收
   * ≠ 丟棄」)。
   *
   * 回收後這個 session 在 `this.runtime` 裡已經不存在,`sendPrompt()`/
   * `interrupt()` 等方法會如常丟出「session 尚未啟動或已結束」的錯誤——這正是
   * 「需要人工重新建立 session 才能續行」的預期行為,不需要新增一個
   * `SessionStatus` 列舉值(`SessionStatusSchema` 目前只有 idle/busy/
   * waiting/error 四種,見 packages/shared/src/session.ts)。這裡把 DB 狀態
   * 設成既有的 `"error"`,`lastError` 說明原因,是目前 schema 下最貼近語意的
   * 選擇(自行判斷,見最終報告)。
   */
  async reclaimSession(sessionId: string): Promise<void> {
    const runtime = this.runtime.get(sessionId);
    if (!runtime) return; // 已經不在跑(例如剛好被使用者手動刪除),視為已完成。
    if (runtime.ptyIdleTimer) clearTimeout(runtime.ptyIdleTimer);
    await runtime.adapter.dispose(runtime.handle);
    this.runtime.delete(sessionId);
    this.turnLimiter.endTurn(sessionId);
    if (runtime.teamMemberId) {
      this.memberSessions.delete(runtime.teamMemberId);
      this.sessionMembers.delete(sessionId);
    }
    this.clearContextCheckpointState(sessionId); // S8:避免無限增長,理由同 disposeSessionForMember()。
    this.pendingIdleInjection.delete(sessionId); // S12 Phase2:同上,避免無限增長。
    await this.setStatus(
      sessionId,
      "error",
      "已閒置等待超過 72 小時,資源已自動回收(子程序已釋放);任務與 worktree 仍保留,可重新建立 session 續行或放棄此任務",
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
        if (runtime.teamMemberId) {
          this.memberSessions.delete(runtime.teamMemberId);
          this.sessionMembers.delete(id);
        }
        this.clearContextCheckpointState(id); // S8:避免無限增長,理由同 disposeSessionForMember()。
        this.pendingIdleInjection.delete(id); // S12 Phase2:同上,避免無限增長。
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
      throw new Error(`找不到 session: ${sessionId}`);
    }
    if (session.status !== "interrupted") {
      throw new Error(`session ${sessionId} 目前狀態是 "${session.status}",不是 "interrupted",無法「繼續」`);
    }
    if (session.adapterType !== "claude-agent-sdk" || !session.backendSessionId) {
      throw new Error(
        `session ${sessionId} 的後端(${session.adapterType})不支援「繼續(保有記憶)」,或這條 session 崩潰前還沒捕捉到後端 session 識別碼,請改用「接手」`,
      );
    }

    const profile = await this.profiles.get(session.agentProfileId);
    if (!profile) {
      throw new Error(`找不到 session ${sessionId} 對應的 agent profile: ${session.agentProfileId}`);
    }

    const adapter = this.adapters.get(profile.software);
    const handle = await adapter.spawn(profile, { path: session.workingDir }, undefined, {
      backendSessionId: session.backendSessionId,
    });

    this.runtime.set(sessionId, {
      handle,
      adapter,
      streamingText: "",
      agentProfileId: profile.id,
      workingDir: session.workingDir,
      backendSessionId: session.backendSessionId,
    });
    this.permissionState.set(sessionId, { mode: profile.permissionLevel });

    await this.db
      .update(sessionsTable)
      .set({ status: "idle", interruptedAt: null, lastSeenAt: Date.now(), updatedAt: Date.now() })
      .where(eq(sessionsTable.id, sessionId))
      .run();
    await this.persistMessage(sessionId, "system", "已透過「繼續」重新連上後端 session(保有先前記憶),core 先前的一次中斷已結束");

    void this.consumeEvents(sessionId);
    this.emit("session-list-updated");

    const updated = await this.getSession(sessionId);
    if (!updated) throw new Error(`session ${sessionId} 於「繼續」流程中意外消失`);
    this.emit("session-updated", updated);
    return updated;
  }

  /**
   * S6(crash-recovery)L4 §4.2:「接手(讀摘要重啟)」——開一個全新的 session
   * (呼叫既有的 `createSession()`,不重用舊的 DB row/handle),再把摘要文字
   * 當作**第一則 prompt** 送給這個全新的 agent(見 `RecoveryService.takeover()`
   * 內對摘要組裝與「為什麼用 sendPrompt 而不是只存進 DB 歷史」的完整說明)。
   * 這裡只是把「新 session + 送出摘要」包成一個方法,實際的摘要文字組裝
   * (只讀 DB + git,不呼叫 LLM)在 `RecoveryService` 完成。
   */
  async takeoverWithSummary(input: CreateSessionInput, summary: string): Promise<Session> {
    const session = await this.createSession(input);
    await this.sendPrompt(session.id, { text: summary });
    return session;
  }

  /**
   * S8 L4 §3.2:任何一次真正 spawn 新 adapter handle 之前都要做的三件事——
   * (1) provider 層級預設 env 疊上 profile 自己的 env(既有邏輯,這輪從
   * `createSession()` 搬過來,供 checkpoint 重啟的 respawn 路徑共用);
   * (2) 確保 `.deskmony/notes/` 存在(§3.1,失敗不阻擋啟動,只記警告);
   * (3) 在 systemPrompt 尾端附加「指路」段落(§3.2,**不是**取代原本的
   * systemPrompt,也**不**讀取筆記內容塞進去)。
   */
  /**
   * 這輪新增:套用 `CreateSessionInput.agentOverride`/`SpawnChildSessionInput.
   * agentOverride`(見 packages/shared/src/session.ts 的 `AgentOverrideSchema`
   * 註解)——回傳一份「這次真正要拿去 spawn」的 profile 形狀物件,**不**寫回
   * DB(base profile 記錄本身不變,覆寫只影響這一次 spawn)。
   *
   *   - 沒有 override:原樣回傳 profile。
   *   - override.software 省略:software 沒變,只換 model——acpConfig/
   *     ptyConfig/opencodeConfig 沿用 profile 原本的(舊 config 仍然對得上
   *     沒變的 software)。
   *   - override.software 有提供且與 profile 原本不同:整批取代該 software
   *     對應的那個 config 欄位(用 override.command/args),其餘兩個 config
   *     欄位設回 undefined——避免 profile 原本 software 的舊 config 殘留在
   *     錯的欄位裡造成混淆;此時要求 override.command 必須提供(除非新
   *     software 是不需要 command 的 claude-agent-sdk),否則直接拋錯,不臆測
   *     一個空字串 command 讓錯誤延後到 adapter.spawn() 才發作。
   */
  private applyAgentOverride(profile: AgentProfile, override: AgentOverride | undefined): AgentProfile {
    if (!override) return profile;
    const software = override.software ?? profile.software;
    const softwareChanged = override.software !== undefined && override.software !== profile.software;
    if (softwareChanged && software !== "claude-agent-sdk" && !override.command) {
      throw new Error(`agentOverride.software="${software}" 需要一併提供 command`);
    }
    return {
      ...profile,
      software,
      providerId: override.providerId ?? (softwareChanged ? undefined : profile.providerId),
      model: override.model ?? profile.model,
      effort: override.effort ?? profile.effort,
      acpConfig: software === "acp" ? (softwareChanged ? { command: override.command!, args: override.args } : profile.acpConfig) : undefined,
      ptyConfig: software === "pty" ? (softwareChanged ? { command: override.command!, args: override.args } : profile.ptyConfig) : undefined,
      opencodeConfig: software === "opencode" ? (softwareChanged ? { command: override.command! } : profile.opencodeConfig) : undefined,
    };
  }

  private async prepareSpawnProfile(profile: AgentProfile, workingDir: string, displayName: string): Promise<AgentProfile> {
    const providerEnv = profile.providerId ? await getProviderEnv(this.settingsStore, profile.providerId) : {};
    const mergedEnv = { ...providerEnv, ...profile.env };
    const withEnv = Object.keys(mergedEnv).length > 0 ? { ...profile, env: mergedEnv } : profile;

    await ensureNotesDir(workingDir).catch((err) => {
      console.warn(
        `[agent-lifecycle] 建立 .deskmony/notes/(${workingDir})失敗,不影響 session 啟動,` +
          `但 systemPrompt 附加的指路段落可能指向一個尚未建立的目錄: ${err instanceof Error ? err.message : String(err)}`,
      );
    });

    return { ...withEnv, systemPrompt: withNotesPointer(withEnv.systemPrompt, displayName) };
  }

  private async consumeEvents(sessionId: string): Promise<void> {
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
          await this.ensureBusy(sessionId);
          // S3b(CostGovernor)§3:回合硬上限的其中一個維度——不依賴 usage,
          // 對所有 adapter 一律計數。`recordToolCall()` 內部同步判斷是否超標,
          // 超標時自己觸發 trip + interrupt(fire-and-forget,不阻塞這個事件
          // 迴圈繼續讀取後續事件)。
          this.turnLimiter.recordToolCall(sessionId);
          await this.persistMessage(
            sessionId,
            "tool",
            JSON.stringify({
              kind: "call",
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              input: event.input,
            }),
          );
          break;
        }
        case "tool-result": {
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
          const { state: permState, justExpired } = this.checkAndExpireYolo(sessionId);
          if (justExpired) {
            console.warn(`[auto-mode] session ${sessionId} 的 YOLO(auto-accept-all)已到期(30 分鐘),自動回落 always-ask`);
            await this.persistMessage(sessionId, "system", "YOLO(30 分鐘)已到期,已自動回落為一般權限確認模式");
            const updated = await this.getSession(sessionId);
            if (updated) this.emit("session-updated", updated);
          }

          const profile = await this.profiles.get(runtime.agentProfileId);
          const ctx = this.buildExecContext(permState);
          const permissionReq: PermissionRequest = {
            sessionId,
            requestId: event.requestId,
            toolName: event.toolName,
            input: event.input,
            workingDir: runtime.workingDir,
            profileId: runtime.agentProfileId,
            role: profile?.role,
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
        case "completed": {
          this.clearPtyIdleTimer(runtime);
          const finalText = event.finalText ?? runtime.streamingText;
          if (finalText) {
            await this.persistMessage(sessionId, "assistant", finalText);
          }
          runtime.streamingText = "";
          await this.setStatus(sessionId, "idle");
          // S3b:回合正常結束,清除回合硬上限的狀態(見 turn-limiter.ts 的
          // `endTurn()` 註解)。
          this.turnLimiter.endTurn(sessionId);

          // S12(session-subagent):若這是子 session,把這一輪的最終結果
          // 回報回父 session: (1) emit "child-result" 讓所有 client 即時看到
          // (UI 用,payload 形狀不變) (2) 取代原本 persist 一則 system 歷史
          // 訊息——把結果當 prompt 注入父 session(sendPrompt 本身會 persist
          // 一則 user 訊息,父歷史一樣看得到)。
          if (runtime.parentSessionId && finalText) {
            const parentId = runtime.parentSessionId;
            const childTitle = (await this.getSession(sessionId))?.title ?? sessionId;
            this.emit("child-result", {
              parentSessionId: parentId,
              childSessionId: sessionId,
              childTitle,
              finalText,
              ts: Date.now(),
            });
            const injectText = `[子 agent「${childTitle}」完成回報]\n${finalText}\n\n請根據以上子 agent 的結果繼續你的工作。`;
            await this.deliverPromptWhenIdle(parentId, injectText);
          }

          // S8(agent-lifecycle)L4 §4.2:「等該回合結束(completed)」的落地
          // 位置——若這一輪之前因為 context 閾值命中而被記下「等空檔送出寫
          // 筆記 prompt」,現在就是那個空檔;若這一輪本身就是「寫筆記」那個
          // prompt 的回合,現在才真正執行 checkpoint 重啟。兩者互斥(同一個
          // session 不會同時有這兩筆記錄),用 if/else if 表達。
          {
            const pendingNote = this.contextCheckpointPendingNote.get(sessionId);
            if (pendingNote !== undefined) {
              this.contextCheckpointPendingNote.delete(sessionId);
              this.contextCheckpointAwaitingRestart.add(sessionId);
              this.sendPrompt(sessionId, { text: pendingNote }).catch((err) => {
                this.contextCheckpointAwaitingRestart.delete(sessionId);
                this.contextCheckpointTriggered.delete(sessionId);
                console.error(
                  `[agent-lifecycle] 回合結束後送出「寫筆記」prompt 失敗(session ${sessionId}),本輪 checkpoint 重啟放棄: ${String(err)}`,
                );
              });
            } else if (this.contextCheckpointAwaitingRestart.has(sessionId)) {
              this.contextCheckpointAwaitingRestart.delete(sessionId);
              this.performContextCheckpointRestart(sessionId).catch((err) => {
                console.error(
                  `[agent-lifecycle] context checkpoint 重啟失敗(session ${sessionId}),session 維持原狀,` +
                    `context 可能持續累積: ${err instanceof Error ? err.message : String(err)}`,
                );
              });
            }
          }

          // S12 Phase2 R1+R4:這個 session 自己這一輪結束(回到 idle),flush
          // 排在它身上待送的訊息(R1:子回報給父的注入;R4:send_to_subagent
          // 排隊等它有空的訊息)——一次只送一筆(其餘等下一輪 completed,避免
          // 把多筆塞成一個回合)。與上方 checkpoint pending/awaiting-restart
          // 邏輯**互不干擾**,刻意用獨立的 if,不塞進同一個 if/else if 鏈。
          {
            const pendingInjection = this.pendingIdleInjection.get(sessionId);
            if (pendingInjection && pendingInjection.length > 0) {
              const injectText = pendingInjection.shift()!;
              if (pendingInjection.length === 0) this.pendingIdleInjection.delete(sessionId);
              void this.deliverPromptWhenIdle(sessionId, injectText);
            }
          }
          break;
        }
        case "error": {
          this.clearPtyIdleTimer(runtime);
          await this.persistMessage(sessionId, "system", `[錯誤] ${event.message}${event.detail ? `\n${event.detail}` : ""}`);
          await this.setStatus(sessionId, "error", event.message);
          runtime.streamingText = "";
          // S3b:回合以錯誤/interrupt 收場,同樣視為回合結束。
          this.turnLimiter.endTurn(sessionId);
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
         * S8(agent-lifecycle)L4 §4.2:context 窗口使用率 gauge(S3a 的
         * `ContextUsageEvent`)。**刻意不 await**——理由同上方 "usage" case,
         * 判斷/送出「寫筆記」prompt 是背景執行的 fire-and-forget,不阻塞這個
         * 事件迴圈讀取後續事件。
         */
        case "context-usage": {
          this.handleContextUsage(sessionId, runtime, event.used, event.size).catch((err) => {
            console.error(`[agent-lifecycle] 處理 context-usage(${sessionId}) 失敗: ${err instanceof Error ? err.message : String(err)}`);
          });
          break;
        }
      }
    }
  }

  /**
   * S8 L4 §4.2:threshold 判斷 + 觸發「寫筆記」prompt(忙碌時先記下,等
   * `completed` 才送出,見 consumeEvents() 的 "completed" case)。**只對
   * lifecycle === "persistent" 的 team member session 生效**——ephemeral
   * worker 靠任務終態 dispose(§2.2),不需要這條 mid-task 的 checkpoint 機制
   * (這是 L4 沒有逐字寫死、但依 HLD §2.2 標題「長命 agent 的 context 閾值
   * 重啟」推斷的判斷,見最終報告「自行判斷」清單)。
   */
  private async handleContextUsage(sessionId: string, runtime: RuntimeState, used: number, size: number): Promise<void> {
    if (!(size > 0)) return; // 防禦:避免除以 0 或負值資料。
    if (used / size < CONTEXT_CHECKPOINT_THRESHOLD) return;
    if (!runtime.teamMemberId) return; // 沒有 team member 就沒有 lifecycle 概念可判斷,也沒有「你的名字」可指路。
    if (this.contextCheckpointTriggered.has(sessionId)) return; // §4.2:同一個 session 只觸發一次。

    const member = await this.teamManager.getMember(runtime.teamMemberId);
    if (!member || member.lifecycle !== "persistent") return;

    this.contextCheckpointTriggered.add(sessionId);
    console.warn(
      `[agent-lifecycle] session ${sessionId}(成員「${member.name}」)context 使用率達 ${((used / size) * 100).toFixed(1)}%` +
        `(≥ ${(CONTEXT_CHECKPOINT_THRESHOLD * 100).toFixed(0)}%),已觸發 checkpoint 重啟前置:要求寫入筆記`,
    );

    const notePrompt =
      "你的 context 即將用盡。請把本次工作中值得跨任務保留的結論寫進 " +
      `.deskmony/notes/${member.name}.md,只回覆「已寫入」即可。`;

    const session = await this.getSession(sessionId);
    if (!session) {
      this.contextCheckpointTriggered.delete(sessionId);
      return;
    }

    if (session.status === "idle") {
      this.contextCheckpointAwaitingRestart.add(sessionId);
      try {
        await this.sendPrompt(sessionId, { text: notePrompt });
      } catch (err) {
        this.contextCheckpointAwaitingRestart.delete(sessionId);
        this.contextCheckpointTriggered.delete(sessionId);
        console.error(
          `[agent-lifecycle] 送出「寫筆記」prompt 失敗(session ${sessionId}),本輪 checkpoint 重啟放棄,context 持續累積: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } else {
      // 目前這輪還在跑(busy/waiting),不能插隊送出第二個 prompt——記下來,
      // 等 consumeEvents() 的 "completed" case 偵測到才送出。
      this.contextCheckpointPendingNote.set(sessionId, notePrompt);
    }
  }

  /**
   * S8 L4 §4.2:「呼叫 S6 既有的接手流程(新 session + 摘要),沿用同一個 DB
   * session id」——與 `RecoveryService.takeover()` 的關鍵差異:那裡開一個
   * **全新** sessionId(離開復原視圖的「舊 session」語意);這裡是長命 agent
   * 的例行維護,**沿用既有 sessionId**,UI 上仍是同一張聊天/同一個成員,不需要
   * 人切換分頁。做法比照 `continueSession()`:`this.runtime` 用既有的
   * sessionId 當 key,但這裡沒有 backend resume 訊號可用(§4.1),一律是全新
   * 的 adapter handle(不嘗試恢復對話記憶——知識已經寫進筆記檔案,重啟不損失
   * 知識,只損失未寫下的隱性 context,見 agent-lifecycle_detail.md §2.2)。
   */
  private async performContextCheckpointRestart(sessionId: string): Promise<void> {
    const session = await this.getSession(sessionId);
    if (!session) return;
    const runtime = this.runtime.get(sessionId);
    if (!runtime || !runtime.teamMemberId) return;
    const member = await this.teamManager.getMember(runtime.teamMemberId);
    if (!member) return;
    const profile = await this.profiles.get(runtime.agentProfileId);
    if (!profile) {
      console.error(`[agent-lifecycle] checkpoint 重啟失敗:找不到 profile ${runtime.agentProfileId}(session ${sessionId})`);
      return;
    }

    // 只讀 DB,不呼叫 LLM(比照 RecoveryService.buildTakeoverSummary() 的既有原則)。
    const summary = await this.buildContextCheckpointSummary(sessionId, member.name);

    if (runtime.ptyIdleTimer) this.clearPtyIdleTimer(runtime);
    try {
      await runtime.adapter.dispose(runtime.handle);
    } catch (err) {
      console.error(`[agent-lifecycle] checkpoint 重啟:dispose 舊 handle 失敗(繼續重啟新 handle): ${err instanceof Error ? err.message : String(err)}`);
    }
    this.turnLimiter.endTurn(sessionId);

    const teamContext: TeamSpawnContext | undefined = this.teamBus
      ? { teamId: member.teamId, memberId: member.id, memberName: member.name, memberRole: member.role, bus: this.teamBus }
      : undefined;
    const finalProfile = await this.prepareSpawnProfile(profile, session.workingDir, member.name);
    const adapter = this.adapters.get(profile.software);
    const handle = await adapter.spawn(finalProfile, { path: session.workingDir }, teamContext);

    this.runtime.set(sessionId, {
      handle,
      adapter,
      streamingText: "",
      teamMemberId: member.id,
      agentProfileId: profile.id,
      workingDir: session.workingDir,
    });
    // memberSessions/sessionMembers 的 key/value 不變(同一 member ↔ 同一
    // sessionId),不需要更新。
    this.permissionState.set(sessionId, { mode: profile.permissionLevel });

    await this.persistMessage(
      sessionId,
      "system",
      "[S8] context 使用率已達閾值,已自動 checkpoint 重啟(讀取先前對話摘要延續,沿用同一個 session)",
    );
    await this.setStatus(sessionId, "idle");

    void this.consumeEvents(sessionId);
    this.emit("session-list-updated");

    // §4.2「重啟後是新 session,計數歸零」——刪掉觸發旗標,讓下一輪 context
    // 成長仍能再次觸發(不是永久只觸發一次,而是「這一輪成長週期只觸發一次」)。
    this.contextCheckpointTriggered.delete(sessionId);

    await this.sendPrompt(sessionId, { text: summary });
  }

  /** §4.2 摘要組裝——只讀 DB(對話歷史),不呼叫 LLM。與
   *  `RecoveryService.buildTakeoverSummary()` 的差異:這裡不是崩潰復原,沒有
   *  git diff 可讀(persistent 的協調者通常不綁定單一 workspace),只帶最近
   *  對話 + 指回筆記檔案的提醒。 */
  private async buildContextCheckpointSummary(sessionId: string, memberName: string): Promise<string> {
    const header = [
      "【Context Checkpoint 重啟】",
      `你先前的 session 因為 context 使用率過高已自動重啟。知識已寫入 .deskmony/notes/${memberName}.md,` +
        "請先讀取該筆記與 team.md 了解目前狀態,再繼續工作。",
    ].join("\n");

    const history = await this.getHistory(sessionId);
    const conversational = history.filter((m) => m.role === "user" || m.role === "assistant");
    const lastMessages = conversational.slice(-6);
    const conversationLines = lastMessages.map((m) => `${m.role === "user" ? "使用者" : "assistant"}: ${m.content}`);

    return buildCheckpointSummaryText(header, conversationLines);
  }

  // S12: no disposeChildSession — child sessions remain idle after completed,
  // runtime stays alive for further conversation (Phase 2 may add dispose).

  /** S8:session 結束/重啟時清除 checkpoint 暫態,避免三個 Map/Set 隨 session
   *  生命週期無限增長(比照既有 `permissionState`/`waitingSince` 的清理慣例)。 */
  private clearContextCheckpointState(sessionId: string): void {
    this.contextCheckpointTriggered.delete(sessionId);
    this.contextCheckpointPendingNote.delete(sessionId);
    this.contextCheckpointAwaitingRestart.delete(sessionId);
  }

  /**
   * S12 Phase2 R1+R4:把一段文字當作下一則 prompt 投遞給某個 session ——
   * 目標 idle 就立刻 `sendPrompt`,busy/waiting 就排進 `pendingIdleInjection`
   * 等它下一次 completed 空檔 flush(見 consumeEvents 的 completed case);
   * 目標 runtime 已不存在(已刪/已 dispose)時丟棄,不報錯。`sendPrompt`
   * 內建的成本斷路器可能拒絕 → try/catch 吞掉只 console.warn,不讓它炸掉
   * 呼叫端(子的 completed 事件迴圈,或 `send_to_subagent` 工具的呼叫鏈)。
   *
   * R1(子完成後把結果注入父)與 R4(`send_to_subagent` 把父的追加訊息送給
   * 已存在的子)共用這個方法 —— 差別只在呼叫端傳入的 sessionId 是父還是子,
   * 對這個方法而言兩者是同一種操作:「送一則 prompt 給某個 session,尊重它
   * 目前是否忙碌」。
   */
  private async deliverPromptWhenIdle(sessionId: string, text: string): Promise<void> {
    const targetRuntime = this.runtime.get(sessionId);
    if (!targetRuntime) return; // 目標已結束,丟棄
    const target = await this.getSession(sessionId);
    if (target?.status === "idle") {
      try {
        await this.sendPrompt(sessionId, { text });
      } catch (err) {
        console.warn(`[session-subagent] 投遞訊息給 session ${sessionId} 失敗(忽略): ${String(err)}`);
      }
    } else {
      const q = this.pendingIdleInjection.get(sessionId) ?? [];
      q.push(text);
      this.pendingIdleInjection.set(sessionId, q);
    }
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
      void this.setStatus(sessionId, "idle");
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

  /** 公開:MessageBus 需要查詢目標成員 session 的目前狀態(idle/busy/...)決定投遞策略。 */
  async getSession(sessionId: string): Promise<Session | undefined> {
    const rows = await this.db.select().from(sessionsTable).where(eq(sessionsTable.id, sessionId)).all();
    return rows[0] ? this.attachPermissionState(rowToSession(rows[0])) : undefined;
  }

  /**
   * S7:把目前的暫態權限模式(auto/YOLO)補到一個 Session 物件上,供所有對外
   * 回傳 Session 的路徑(`getSession()`/`listSessions()`/`createSession()`)共用
   * ——單一組裝點,避免各呼叫端各自忘記補這兩個欄位而漂移。**刻意不在這裡做
   * YOLO 過期的惰性檢查**(那個檢查只在 `checkAndExpireYolo()` 被呼叫的地方
   * ——也就是每次真正 `decide()` 之前——才會發生並跟著發通知,見 L4 §6「過期
   * 檢查時機」;這裡單純讀取當下記憶體裡的值,可能在真正過期後的幾分鐘內仍
   * 顯示舊狀態,直到下一次權限請求觸發檢查為止,這是規格選定的行為,不是
   * bug)。
   */
  private attachPermissionState(session: Session): Session {
    const state = this.permissionState.get(session.id);
    if (!state) return session;
    return { ...session, permissionMode: state.mode, yoloExpiresAt: state.yoloExpiresAt };
  }

  /**
   * S7 L4 §2.1:組出餵給 `PolicyEngine.decide()` 的 `ExecContext`。
   *
   * **三個欄位來自三個不同的來源,彼此正交**——這是 2026-07-28 修正的設計
   * 錯誤:初版把 `attended` 寫成 `autoMode` 的補數(`mode === "always-ask"`),
   * 等於把 2×2 壓成 1×2 ⇒ `attended=false` 必然 `autoMode=true` ⇒ 未分類請求
   * 一律在 `decide()` 第 4 步被自動放行,永遠走不到第 5 步的 escalate ⇒ S1 L4
   * §6 與 S11 §4 定案的「無人值守時掛起等人、不逾時 deny」變成死碼。而那條
   * 規則存在的理由(「沒人回應 ≠ 拒絕」)專為**「無人值守 + 未開 auto」**這個
   * 象限而設計,恰恰被那個公式消滅。
   *
   * | | 未開 auto | 已開 auto |
   * |---|---|---|
   * | 有 client 連線 | 逐筆問;逾時 deny | 中間地帶自動放行 |
   * | 無 client 連線 | **escalate 掛起等你回來(不逾時 deny)** | 中間地帶自動放行 |
   *
   * - `attended` = **環境事實**:現在有沒有人看得到彈窗(Gateway 才知道)。
   * - `autoMode` = **政策設定**:使用者是否預先授權(session 暫態,與 attended
   *   完全獨立)。
   * - `local` = **保守的整體判定**:只要有任何遠端 client 連線中就視為非
   *   local。permission-request 不綁定單一 WS 連線,無法問「這一筆是誰送的」;
   *   遠端可能就是那個會去點「仍要允許」的人,fail-safe 方向要求寧可嚴、不可
   *   寬(這同時補上「auto 已開著時,遠端看到的 escalate-strong 仍被當本機
   *   處理」這個落差)。
   *
   * **未注入 `ClientPresencePort` 時**(理論上只有「沒有 Gateway 的 headless
   * 組裝」才會發生,index.ts 一定會注入):`attended=false` + `local=true`
   * ——也就是「一個 client 都沒有」的退化讀法,而這個組合**不可能**產生
   * escalate-strong(第 1 步只有 `local && attended && !autoMode` 才降級),
   * 忘記接線的失敗方向因此是安全的(hard-deny 一律直接 deny)。
   *
   * **這是決策當下的瞬時快照**:`attended` 只影響這一筆請求註冊時要不要設逾時
   * 計時器,之後 client 斷線/連上都不會回頭改寫已經註冊的那一筆(見
   * `consumeEvents()` 的 `permissionGateway.register()` 呼叫處)。
   */
  private buildExecContext(state: SessionPermissionState): ExecContext {
    return {
      attended: this.clientPresence?.hasConnectedClient() ?? false,
      local: !(this.clientPresence?.hasRemoteClient() ?? false),
      autoMode: state.mode !== "always-ask",
      // YOLO 與一般 auto 唯一的差別:是否連 config 的 deny-list 也繞過
      // (見 policy-engine.ts 的 decide() 註解)。
      yolo: state.mode === "auto-accept-all",
    };
  }

  /**
   * S7 L4 §6:YOLO 30 分鐘惰性過期檢查——純粹的「檢查 + 必要時就地降級」,
   * 不做任何 I/O/emit(那些副作用由呼叫端在 `justExpired` 為 true 時自行處理,
   * 見 `consumeEvents()` 的 `permission-request` case)。找不到任何暫態記錄
   * (理論上不會發生,`createSession()` 一定會設)時保守視為 `"always-ask"`。
   */
  private checkAndExpireYolo(sessionId: string): { state: SessionPermissionState; justExpired: boolean } {
    const state = this.permissionState.get(sessionId) ?? { mode: "always-ask" as const };
    if (state.mode === "auto-accept-all" && state.yoloExpiresAt !== undefined && Date.now() >= state.yoloExpiresAt) {
      const downgraded: SessionPermissionState = { mode: "always-ask" };
      this.permissionState.set(sessionId, downgraded);
      return { state: downgraded, justExpired: true };
    }
    return { state, justExpired: false };
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

  private async persistMessage(sessionId: string, role: MessageRecord["role"], content: string): Promise<void> {
    const row = {
      id: randomUUID(),
      sessionId,
      role,
      content,
      createdAt: Date.now(),
    };
    await this.db.insert(messagesTable).values(row).run();
  }
}

function rowToSession(row: typeof sessionsTable.$inferSelect): Session {
  return {
    id: row.id,
    title: row.title,
    agentProfileId: row.agentProfileId,
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

function sessionToRow(session: Session): typeof sessionsTable.$inferInsert {
  return {
    id: session.id,
    title: session.title,
    agentProfileId: session.agentProfileId,
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
