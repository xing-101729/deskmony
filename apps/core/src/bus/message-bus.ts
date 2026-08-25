import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { and, eq, isNull } from "drizzle-orm";
import type { NexusDb } from "@deskmony/db";
import { teamMessages as teamMessagesTable } from "@deskmony/db";
import type {
  MessageBudgetConfig,
  MessagePriority,
  RequestReviewOutcome,
  Session,
  TaskStatus,
  TeamBusPort,
  TeamBusSendOutcome,
  TeamMember,
  TeamMessage,
  TeammateInfo,
} from "@deskmony/shared";
import { DeskmonyError, ErrorCodes } from "@deskmony/shared";
import type { ProfileStore } from "../profiles.js";
import type { TeamManager } from "../team/team-manager.js";
import type { SessionManager } from "../session/session-manager.js";
import type { TaskService } from "../tasks/task-service.js";
import type { AuditLog } from "../enforcement/audit-log.js";
import type { Notifier } from "../enforcement/notifier.js";
import { enforcementTrip } from "../enforcement/trip.js";

/**
 * MessageBus(ARCHITECTURE.md 第 4 節「Agent 互相傳訊機制」核心模組)。
 *
 * 投遞策略(4.2 節):
 *   收訊 → 持久化到 team_messages → 推播 "team-message" 給所有 client →
 *   依目標成員的 session 狀態決定投遞:
 *     - idle      → 立即以 prompt 注入(「來自 @X(角色)的訊息:...」)
 *     - busy      → 進 Mailbox 排隊,session 回合結束(idle)後批次注入
 *     - interrupt → 僅發送者對應的 TeamMember.canInterrupt 為 true 才允許,
 *                   先 adapter.interrupt() 再注入;無權限則降級為 normal 並
 *                   在訊息紀錄標註(見 resolvePriorityForSender)
 *     - 無活躍 session → 留在 Mailbox,session 建立後補投(見
 *       SessionManager 的 "member-session-ready" 事件)
 *
 * 依賴方向:MessageBus 依賴 SessionManager(查詢 session 狀態、呼叫
 * sendPrompt/interrupt),但 SessionManager 不依賴 MessageBus —— 兩者透過
 * `SessionManager` 既有的 EventEmitter 事件解耦(`session-updated`、
 * `member-session-ready`),避免建構子互相依賴的循環(apps/core/src/index.ts
 * 的建構順序:先建 SessionManager,再建 MessageBus,再用
 * `sessionManager.setTeamBus(messageBus)` 回頭注入 TeamBusPort)。
 *
 * ---- S2(message-budget,第三條斷路器)在既有投遞策略前加的兩道閘 ----
 * 見 docs/LAYER-4-detail-design/message-budget_detail.md(以下簡稱 L4)。這輪
 * **不重寫**上面的投遞策略,只做兩件事:
 *
 *   1. **contextId 綁定(L4 §2)**:`sendMessage`/`broadcast`/`requestReview`
 *      在真的持久化訊息之前,由 `deriveContextId()` 依發送者(`fromMemberId`)
 *      當下綁定的任務推導出 `contextId`——**agent 完全無法指定**(MCP 工具
 *      簽章本來就沒有這個參數),推不出來(沒有進行中的任務)一律拒收。這是
 *      本 spec 最重要的完整性要求:讓被管制的對象自己申報管制欄位,等於
 *      讓它換個 id 就能重置預算,與 C3(政策 agent 不可寫)/S4(acceptance
 *      agent 不可寫)是同一種漏洞形狀。
 *   2. **context 訊息數上限(L4 §3/§4)**:每個 contextId 的 `source="agent"`
 *      訊息數超過 `messageBudgetConfig.maxMessagesPerContext` 時,`trip`(共用
 *      底座,通知 + 稽核,比照 S3b `CostGovernor` 的先例)並拒收該 context
 *      後續的 `sendMessage`/`broadcast`/`requestReview`——但 **`report_status`/
 *      `list_teammates` 完全不受影響**(只斷橫向訊息,不斷縱向工作進度,見
 *      L4 §4)。拒收本身不計入預算,但同一 context 高頻拒收(每 10 次)會再
 *      發一次通知,避免 agent 卡在重試迴圈裡卻沒人注意到。
 *
 * `reportStatus()`/`sendHumanMessage()` 產生的訊息**不參與**這兩道閘——
 * `contextId` 固定填哨兵值 `"legacy"`(比照遷移前舊資料的語意,見
 * packages/db/src/schema.ts 的 `teamMessages` 註解),理由見 L4 §4「trip 後
 * 只斷訊息,不斷工作」與檔案最終報告的「自行判斷」章節。
 *
 * ---- S2:Mailbox 改由 DB 驅動(L4 §5)----
 * 舊版用 `Map<memberId, TeamMessage[]>` 當 Mailbox 的權威來源,崩潰後這個
 * Map 會隨行程消失,但訊息本身已經 persist 到 `team_messages`——變成「訊息
 * 還在,但『沒送達』這個事實不見了」,那則訊息永遠不會被投遞。這輪把權威
 * 來源換成 DB 的 `delivered_at IS NULL`(見 schema.ts):
 *   - 待投遞的訊息不再存進任何記憶體結構,`deliverToMember()`/
 *     `flushPendingForMember()` 全部改成查 DB。
 *   - 真正注入(`sessionManager.sendPrompt()`)成功後,才在**同一個
 *     better-sqlite3 transaction** 內把這批訊息的 `delivered_at` 一併標記
 *     (`injectAndMarkDelivered()`)——`sendPrompt()` 拋錯就完全不標記,訊息
 *     留在 Mailbox 下次重試(L4 §5.2)。崩潰重啟後未標記的訊息自然還在,
 *     `flushMailbox`/`member-session-ready` 事件觸發的補投照常運作,不需要
 *     任何額外復原邏輯。
 *   - 同一個 member 的「查詢待投遞 → 注入 → 標記」這一整套動作用
 *     `withMemberLock()` 序列化(見該方法註解),避免「插入新訊息時剛好
 *     session 轉 idle 觸發 flushMailbox」這種併發路徑重複撈到同一批還沒被
 *     標記的訊息,造成同一則訊息被注入兩次。
 *   - `broadcast()`(agent 對全隊廣播)與 `sendHumanMessage()` 的 broadcast
 *     分支,都改成**展開成 N 筆**(每個收件者各自一筆 `to_target`,見 L4
 *     §5.1)——單一 `delivered_at` 欄位表達不了「A 收到了、B 還沒」,展開成
 *     N 筆後每筆的送達狀態各自獨立,查詢也不需要對 `to_target === "broadcast"`
 *     特例處理。`reportStatus()` 的 `to: "broadcast"` 訊息是例外:它從來不
 *     觸發任何投遞(見該方法既有註解「不觸發投遞」),不展開,直接標記為
 *     立即已送達(不進 Mailbox)。
 *
 * 迴圈保護(既有,S2 沒有動):
 *   - 注入本身是呼叫 `SessionManager.sendPrompt()`,等同一般使用者 prompt,
 *     不會反過來呼叫 `bus.sendMessage()`,所以不會形成自我觸發的迴圈
 *     (除非 agent 在收到注入後自己主動又呼叫 send_message/broadcast 工具,
 *     那是預期中的正常對話——**這正是 S2 訊息預算存在的理由**)。
 */

/** L4 §6:同一 context 高頻拒收(agent 卡在重試迴圈)時,每幾次拒收再發一次通知。 */
const RETRY_STORM_NOTIFY_EVERY = 10;

/** 訊息無法關聯到任何進行中任務時的拒收錯誤(L4 §2「零個 → 拒收」)。 */
class NoContextTaskError extends Error {}

/** context 訊息預算已用盡時的拒收錯誤(L4 §4,錯誤訊息需明確可理解)。 */
class MessageBudgetExceededError extends Error {}

export class MessageBus extends EventEmitter implements TeamBusPort {
  /** memberId -> 序列化「查待投遞 → 注入 → 標記已送達」這套動作的鎖(見檔案
   *  頂端「Mailbox 改由 DB 驅動」說明的併發保護)。 */
  private readonly mailboxLocks = new Map<string, Promise<unknown>>();
  /** 已經觸發訊息預算 trip 的 contextId——**已 trip 的不自動恢復**(fail-safe,
   *  同 CostGovernor 的 `trippedTasks`),只能靠人類調高預算並重啟 core 後由
   *  `initialize()` 重新評估。 */
  private readonly trippedContexts = new Set<string>();
  /** 每個已 trip 的 context 累積被拒收的次數,達到 `RETRY_STORM_NOTIFY_EVERY`
   *  的倍數時再發一次通知(L4 §6)。 */
  private readonly rejectionCounts = new Map<string, number>();

  constructor(
    private readonly db: NexusDb,
    private readonly teamManager: TeamManager,
    private readonly sessionManager: SessionManager,
    private readonly profiles: ProfileStore,
    /** M4 Round A:選填 —— report_status 帶 taskId 時用來嘗試同步任務狀態
     * (見 reportStatus() 下方註解)。維持選填是為了不強迫既有建構順序,但
     * apps/core/src/index.ts 目前一律會傳入。S2:`sendMessage`/`broadcast`/
     * `requestReview` 的 contextId 推導也依賴這裡——未注入時一律視為「推導
     * 不出來」而拒收(fail-safe,見 `deriveContextId()`)。 */
    private readonly taskService: TaskService | undefined,
    /** S2(message-budget):訊息數上限設定(見 packages/shared/src/core-config.ts
     *  的 `MessageBudgetConfigSchema`)——`ConfigSetFilePatchSchema` 刻意不含
     *  這個區塊(F4,遠端不可改),只能靠本機設定檔 + 重啟 core 調整。 */
    private readonly messageBudgetConfig: MessageBudgetConfig,
    private readonly auditLog: AuditLog,
    private readonly notifier: Notifier,
  ) {
    super();

    this.sessionManager.on("session-updated", (session: Session) => {
      if (session.status !== "idle") return;
      const memberId = this.sessionManager.getMemberIdForSession(session.id);
      if (!memberId) return;
      void this.flushMailbox(memberId);
    });

    this.sessionManager.on("member-session-ready", (payload: { memberId: string; sessionId: string }) => {
      void this.flushMailbox(payload.memberId);
    });
  }

  /**
   * S2:core 啟動時呼叫一次(比照 `CostGovernor.initialize()` 的先例,見
   * apps/core/src/cost/cost-governor.ts)——從 DB 重新計算每個 context 目前的
   * `source="agent"` 訊息數,還原 `trippedContexts`。**不能只從空白狀態開始**:
   * 若崩潰前某個 context 早就已經 trip,重啟後這個記憶體狀態會消失,`legacy`
   * 以外的下一筆訊息會被誤判成「還沒超標」而放行,等於每次重啟都免費多送一
   * 則訊息、變相重置預算的一個縫隙(違反「agent 無法透過任何路徑重置或繞過
   * context 預算」這個驗收核心)。
   */
  async initialize(): Promise<void> {
    const rows = await this.db
      .select({ contextId: teamMessagesTable.contextId, source: teamMessagesTable.source })
      .from(teamMessagesTable)
      .all();
    const counts = new Map<string, number>();
    for (const row of rows) {
      if (row.source !== "agent") continue;
      if (row.contextId === "legacy") continue;
      counts.set(row.contextId, (counts.get(row.contextId) ?? 0) + 1);
    }
    for (const [contextId, count] of counts) {
      if (count >= this.messageBudgetConfig.maxMessagesPerContext) {
        this.trippedContexts.add(contextId);
      }
    }
  }

  // ---- TeamBusPort(agent 端,經 team-bus MCP 工具呼叫)-------------------

  async sendMessage(input: {
    teamId: string;
    fromMemberId: string;
    to: string;
    content: string;
    priority?: MessagePriority;
  }): Promise<TeamBusSendOutcome> {
    const fromMember = await this.mustGetMember(input.fromMemberId, input.teamId);

    if (input.to === "broadcast") {
      return this.deliverBroadcast(fromMember, input.content, input.priority ?? "normal");
    }

    const targetMember = await this.teamManager.findMemberByName(input.teamId, input.to);
    if (!targetMember) {
      throw new DeskmonyError(
        ErrorCodes.ENTITY_NOT_FOUND,
        { entityType: "teamMember", id: input.to },
        `team 內找不到成員 "${input.to}"`,
      );
    }

    const contextId = await this.deriveContextId(fromMember.id);
    await this.assertContextNotTripped(contextId);

    const { priority, note } = await this.resolvePriorityForSender(
      input.teamId,
      fromMember.name,
      input.priority ?? "normal",
    );
    const message = await this.persistAndPush({
      teamId: input.teamId,
      from: fromMember.name,
      fromRole: fromMember.role,
      to: targetMember.name,
      content: input.content,
      priority,
      source: "agent",
      note,
      contextId,
    });
    await this.checkThresholdAfterPersist(contextId);
    const delivered = await this.deliverToMember(targetMember, message);
    return { message, delivered, downgraded: Boolean(note) };
  }

  async broadcast(input: {
    teamId: string;
    fromMemberId: string;
    content: string;
    priority?: MessagePriority;
  }): Promise<TeamBusSendOutcome> {
    const fromMember = await this.mustGetMember(input.fromMemberId, input.teamId);
    return this.deliverBroadcast(fromMember, input.content, input.priority ?? "normal");
  }

  async listTeammates(input: { teamId: string; requestingMemberId: string }): Promise<TeammateInfo[]> {
    const members = await this.teamManager.getTeamMembers(input.teamId);
    const result: TeammateInfo[] = [];
    for (const member of members) {
      const profile = await this.profiles.get(member.agentProfileId);
      const sessionId = this.sessionManager.getSessionIdForMember(member.id);
      const session = sessionId ? await this.sessionManager.getSession(sessionId) : undefined;
      result.push({
        memberId: member.id,
        name: member.name,
        role: member.role,
        software: profile?.software ?? "claude-agent-sdk",
        canInterrupt: member.canInterrupt,
        hasActiveSession: Boolean(session),
        status: session?.status,
      });
    }
    return result;
  }

  /**
   * 寫入一筆狀態訊息,不觸發投遞(不打斷隊友的 session,見 class 頂端註解)。
   * M4 Round A:若帶 `taskId`,委派給 `TaskService.tryApplyReportStatus()`
   * 嘗試把 `status` 對映到任務狀態機並同步更新(該方法本身保證不拋錯誤,
   * 對映不到/成員不是指派人/非法轉換都只回傳 `skippedReason`);結果會附加
   * 在這則訊息的內容裡(讓團隊群聊視圖/歷史紀錄看得到「有沒有真的同步」),
   * 不影響訊息本身一定會被記錄這件事 —— 保持向後相容:不帶 taskId、或未注入
   * `taskService`(理論上 apps/core/src/index.ts 一律會注入)時,行為與 M3
   * 完全相同。
   *
   * S2:**刻意不套用 contextId 推導/預算閘**(L4 §4「trip 後只斷訊息,不斷
   * 工作 —— report_status 不受影響」)——這裡的訊息固定 `contextId: "legacy"`,
   * 不參與訊息預算計算,也不會因為某個 context 已經 trip 而被拒收。
   */
  async reportStatus(input: {
    teamId: string;
    fromMemberId: string;
    status: string;
    summary?: string;
    taskId?: string;
  }): Promise<TeamMessage> {
    const fromMember = await this.mustGetMember(input.fromMemberId, input.teamId);
    let content = input.summary ? `[狀態回報] ${input.status}: ${input.summary}` : `[狀態回報] ${input.status}`;

    if (input.taskId && this.taskService) {
      const outcome = await this.taskService.tryApplyReportStatus(fromMember.id, input.taskId, input.status);
      content += outcome.updated
        ? `(任務狀態已同步: ${outcome.fromStatus} → ${outcome.toStatus})`
        : `(任務狀態未同步: ${outcome.skippedReason})`;
    }

    // 不觸發投遞的訊息(to="broadcast" 且從不進入 deliverToMembers)本來就不會
    // 有人去查它的 Mailbox 狀態,直接標記立即已送達,維持「delivered_at IS
    // NULL = 還在 Mailbox 中待投遞」這個語意的單純性(見檔案頂端說明)。
    return this.persistAndPush({
      teamId: input.teamId,
      from: fromMember.name,
      fromRole: fromMember.role,
      to: "broadcast",
      content,
      priority: "normal",
      source: "agent",
      contextId: "legacy",
      deliveredAt: Date.now(),
    });
  }

  /**
   * M4 Round B:`request_review`(ARCHITECTURE.md 4.1 節列出、4.4/5.1 節備註
   * 明講「這輪先不做」的那個工具,補上)。語意上等同
   * `reportStatus({status: "review", taskId})` + `sendMessage({to: reviewer, ...})`
   * 的組合,但意圖明確,呼叫端不需要自己組出審查請求措辭或分別呼叫兩個工具。
   * 實作直接複用既有邏輯,不重新發明:
   *   - 帶 `taskId` 時委派給 `TaskService.tryApplyReportStatus()`(與
   *     `reportStatus()` 完全相同的規則 —— 對映不到/不是指派人/非法轉換都不
   *     報錯,只記錄原因,"done" 一樣被擋下來,雖然這裡固定傳 "review" 不會
   *     真的撞到那個限制)。
   *   - 通知訊息走既有的 `persistAndPush` + `deliverToMember`(與
   *     `sendMessage` 相同的持久化/推播/投遞路徑),固定 `priority: "normal"`
   *     ——審查請求不是緊急插話,沒有必要支援 interrupt。
   *   - 附上任務標題與分支名稱(透過 `TaskService.getTaskBranch()`)讓
   *     reviewer 收到的訊息裡有足夠上下文,不用另外去查任務看板。
   *
   * S2:`request_review` 天然帶 context(L4 §2)——帶 `taskId` 時直接用它當
   * `contextId`,但**仍須驗證該 taskId 確實指派給發送者,否則拒收**(不限制
   * 任務當下狀態,L4 只要求驗證指派關係)。不帶 `taskId` 時退回與
   * `sendMessage` 相同的一般規則(依 session 當下綁定的任務推導)。這則訊息
   * 語意上仍是「一則會送到 reviewer 手上的 peer 訊息」,套用與 `sendMessage`
   * 完全相同的預算閘(推不出 context 拒收、context 已 trip 拒收、送出後計入
   * 預算)——否則 agent 大可在 `send_message` 被擋下之後,改用
   * `request_review` 當作繞過預算的後門,violate 驗收核心①。
   */
  async requestReview(input: {
    teamId: string;
    fromMemberId: string;
    to: string;
    taskId?: string;
  }): Promise<RequestReviewOutcome> {
    const fromMember = await this.mustGetMember(input.fromMemberId, input.teamId);
    const targetMember = await this.teamManager.findMemberByName(input.teamId, input.to);
    if (!targetMember) {
      throw new DeskmonyError(
        ErrorCodes.ENTITY_NOT_FOUND,
        { entityType: "teamMember", id: input.to },
        `team 內找不到成員 "${input.to}"`,
      );
    }

    const contextId = await this.deriveContextIdForRequestReview(fromMember.id, input.taskId);
    await this.assertContextNotTripped(contextId);

    let taskUpdated = false;
    let taskFromStatus: TaskStatus | undefined;
    let taskToStatus: TaskStatus | undefined;
    let taskSkippedReason: string | undefined;
    let taskLabel = "";

    if (input.taskId && this.taskService) {
      const task = await this.taskService.getTask(input.taskId);
      if (task) {
        const branch = await this.taskService.getTaskBranch(input.taskId);
        taskLabel = ` 任務「${task.title}」${branch ? `(分支: ${branch})` : ""}`;
      }
      const outcome = await this.taskService.tryApplyReportStatus(fromMember.id, input.taskId, "review");
      taskUpdated = outcome.updated;
      taskFromStatus = outcome.fromStatus;
      taskToStatus = outcome.toStatus;
      taskSkippedReason = outcome.skippedReason;
    }

    const content = `[請求審查] 請審查${taskLabel || "我的工作"}`;
    const message = await this.persistAndPush({
      teamId: input.teamId,
      from: fromMember.name,
      fromRole: fromMember.role,
      to: targetMember.name,
      content,
      priority: "normal",
      source: "agent",
      contextId,
    });
    await this.checkThresholdAfterPersist(contextId);
    const delivered = await this.deliverToMember(targetMember, message);
    return { message, delivered, downgraded: false, taskUpdated, taskFromStatus, taskToStatus, taskSkippedReason };
  }

  // ---- 人類插話(gateway 的 message.send,見 apps/core/src/gateway/ws-gateway.ts)----

  /**
   * S2:人類插話**不參與**訊息預算(L4 §3「只計 agent 發的(source='agent'),
   * 人類插話不佔額度」),`contextId` 固定填 `"legacy"`。broadcast 分支比照
   * `deliverBroadcast()` 展開成 N 筆(見檔案頂端「Mailbox 改由 DB 驅動」說明
   * ——這條分支會真的呼叫 `deliverToMembers()` 觸發投遞,單一 `to_target=
   * "broadcast"` 的舊寫法會讓這些訊息永遠無法被任何 per-member 的 Mailbox
   * 查詢撈到,`delivered_at` 就會永遠卡在 NULL)。
   */
  async sendHumanMessage(input: {
    teamId: string;
    to: string;
    content: string;
    priority?: MessagePriority;
    fromName?: string;
  }): Promise<TeamBusSendOutcome> {
    const team = await this.teamManager.getTeam(input.teamId);
    if (!team) {
      throw new DeskmonyError(
        ErrorCodes.ENTITY_NOT_FOUND,
        { entityType: "team", id: input.teamId },
        `找不到 team: ${input.teamId}`,
      );
    }
    const fromName = input.fromName?.trim() || "Human";
    const requested = input.priority ?? "normal";
    // 人類插話沒有對應的 TeamMember 概念,但若 fromName 剛好與某個成員同名,
    // 仍套用同一套 canInterrupt 檢查(見 resolvePriorityForSender);一般情況
    // (fromName 找不到對應成員)則直接放行 —— 人類是最終決策者(架構文件
    // 第 10 節「人類永遠在迴路中」)。
    const { priority, note } = await this.resolvePriorityForSender(input.teamId, fromName, requested);
    const fromRole = (await this.teamManager.findMemberByName(input.teamId, fromName))?.role ?? "人類";

    if (input.to === "broadcast") {
      const members = await this.teamManager.getTeamMembers(input.teamId);
      if (members.length === 0) {
        const message = await this.persistAndPush({
          teamId: input.teamId,
          from: fromName,
          fromRole,
          to: "broadcast",
          content: input.content,
          priority,
          source: "human",
          note,
          contextId: "legacy",
          deliveredAt: Date.now(),
        });
        return { message, delivered: "no-session", downgraded: Boolean(note) };
      }
      let lastMessage: TeamMessage | undefined;
      let anyImmediate = false;
      let anyQueued = false;
      for (const member of members) {
        const message = await this.persistAndPush({
          teamId: input.teamId,
          from: fromName,
          fromRole,
          to: member.name,
          content: input.content,
          priority,
          source: "human",
          note,
          contextId: "legacy",
        });
        lastMessage = message;
        const result = await this.deliverToMember(member, message);
        if (result === "immediate") anyImmediate = true;
        if (result === "queued") anyQueued = true;
      }
      const delivered = anyImmediate ? "immediate" : anyQueued ? "queued" : "no-session";
      return { message: lastMessage!, delivered, downgraded: Boolean(note) };
    }

    const targetMember = await this.teamManager.findMemberByName(input.teamId, input.to);
    if (!targetMember) {
      throw new DeskmonyError(
        ErrorCodes.ENTITY_NOT_FOUND,
        { entityType: "teamMember", id: input.to },
        `team 內找不到成員 "${input.to}"`,
      );
    }
    const message = await this.persistAndPush({
      teamId: input.teamId,
      from: fromName,
      fromRole,
      to: targetMember.name,
      content: input.content,
      priority,
      source: "human",
      note,
      contextId: "legacy",
    });
    const delivered = await this.deliverToMember(targetMember, message);
    return { message, delivered, downgraded: Boolean(note) };
  }

  /** team.messages 歷史查詢(gateway 用)。 */
  async getMessages(teamId: string, limit?: number): Promise<TeamMessage[]> {
    const rows = await this.db.select().from(teamMessagesTable).where(eq(teamMessagesTable.teamId, teamId)).all();
    const sorted = rows.map(rowToMessage).sort((a, b) => a.timestamp - b.timestamp);
    return limit ? sorted.slice(-limit) : sorted;
  }

  /**
   * S2:供 gateway/UI 查詢一個 context 目前的訊息預算狀態(團隊群聊視圖顯示
   * 額度餘量/trip 狀態用,見 message-budget_detail.md §7 檢查清單「UI 群聊
   * 視圖:顯示 context 與額度餘量;trip 狀態」)。
   */
  async getContextBudgetStatus(contextId: string): Promise<{ contextId: string; count: number; max: number; tripped: boolean }> {
    const count = await this.countAgentMessagesInContext(contextId);
    return { contextId, count, max: this.messageBudgetConfig.maxMessagesPerContext, tripped: this.trippedContexts.has(contextId) };
  }

  // ---- 內部邏輯 -----------------------------------------------------------

  private async mustGetMember(memberId: string, teamId: string): Promise<TeamMember> {
    const member = await this.teamManager.getMember(memberId);
    if (!member) {
      throw new DeskmonyError(
        ErrorCodes.ENTITY_NOT_FOUND,
        { entityType: "teamMember", id: memberId },
        `未知的 team member: ${memberId}`,
      );
    }
    if (member.teamId !== teamId) {
      throw new DeskmonyError(
        "message.memberTeamMismatch",
        { memberId, teamId },
        `team member ${memberId} 不屬於 team ${teamId}`,
      );
    }
    return member;
  }

  // ---- S2:contextId 推導 + 預算閘(L4 §2/§3/§4)---------------------------

  /**
   * L4 §2「推導規則(釘死)」:用 `TaskService` 查
   * `assigneeMemberId === fromMemberId` 且狀態 ∈ {assigned, in-progress,
   * review, merging} 的任務——恰好一個就用它;多於一個取 `updatedAt` 最新的
   * 一筆(保守且可預期);零個(或 `taskService` 根本沒被注入)一律拒收,
   * **絕不給預設值**。讓 agent 自己填 contextId 等於讓被管制的對象自己申報
   * 管制欄位,這裡連「找不到就給一個 fallback context」都不做,同一種紀律。
   */
  private async deriveContextId(fromMemberId: string): Promise<string> {
    const task = await this.taskService?.getMessageContextTaskForMember(fromMemberId);
    if (!task) {
      throw new NoContextTaskError(
        "此訊息無法送出:訊息必須關聯到一個進行中的任務(狀態為 assigned/in-progress/review/merging)," +
          "你目前沒有這樣的任務。",
      );
    }
    return task.id;
  }

  /**
   * L4 §2:`request_review(taskId, to)` 天然帶 context(= 該 taskId),但仍須
   * 驗證該 taskId 確實指派給發送者,否則拒收。不帶 `taskId` 時退回與
   * `sendMessage` 相同的一般規則(`deriveContextId()`)——這是 L4 文字沒有
   * 明講、這輪保守決定的行為(見最終報告「自行判斷」章節):`taskId` 本來就是
   * `request_review` 的選填參數,沒有理由讓「沒帶 taskId」的呼叫繞過整套
   * contextId 推導與預算閘。
   */
  private async deriveContextIdForRequestReview(fromMemberId: string, taskId: string | undefined): Promise<string> {
    if (!taskId) {
      return this.deriveContextId(fromMemberId);
    }
    const task = await this.taskService?.getTask(taskId);
    if (!task || task.assigneeMemberId !== fromMemberId) {
      throw new NoContextTaskError(`任務 ${taskId} 目前未指派給你,無法以此任務作為訊息 context,訊息已拒收。`);
    }
    return task.id;
  }

  /**
   * 送出前的閘:這個 context 若已經 trip 過,直接拒收(L4 §4)。**拒收本身
   * 不計入預算**(不會再多 persist 一筆),但同一 context 高頻拒收(每
   * `RETRY_STORM_NOTIFY_EVERY` 次)會再發一次通知——agent 可能卡在重試迴圈
   * 裡卻沒有人注意到(L4 §6)。
   */
  private async assertContextNotTripped(contextId: string): Promise<void> {
    if (!this.trippedContexts.has(contextId)) return;
    const count = await this.countAgentMessagesInContext(contextId);
    await this.maybeNotifyRetryStorm(contextId);
    throw new MessageBudgetExceededError(
      `此任務的訊息額度已用盡(${count}/${this.messageBudgetConfig.maxMessagesPerContext}),已通知人類。` +
        "你仍可繼續工作與回報狀態(report_status),但暫時無法傳訊給隊友,直到人類調高預算上限。",
    );
  }

  private async maybeNotifyRetryStorm(contextId: string): Promise<void> {
    const next = (this.rejectionCounts.get(contextId) ?? 0) + 1;
    this.rejectionCounts.set(contextId, next);
    if (next % RETRY_STORM_NOTIFY_EVERY !== 0) return;
    await enforcementTrip({
      source: "message",
      reason: "message-budget",
      targetIds: [contextId],
      auditLog: this.auditLog,
      notifier: this.notifier,
      interrupt: false,
    });
  }

  /**
   * 訊息真的持久化之後呼叫,依最新計數決定是否越線觸發 trip(比照
   * `CostGovernor.checkTaskThreshold()` 的先例:pre-check 只看「是否已 trip」
   * 這個旗標,真正的門檻判斷發生在記錄之後)。同一個 context 只會 trip 一次
   * (`trippedContexts` 已有就不重複觸發),之後每次超線送出都改由
   * `assertContextNotTripped()` 在下一次呼叫時擋下。
   */
  private async checkThresholdAfterPersist(contextId: string): Promise<void> {
    if (this.trippedContexts.has(contextId)) return;
    const count = await this.countAgentMessagesInContext(contextId);
    if (count < this.messageBudgetConfig.maxMessagesPerContext) return;
    this.trippedContexts.add(contextId);
    await enforcementTrip({
      source: "message",
      reason: "message-budget",
      targetIds: [contextId],
      auditLog: this.auditLog,
      notifier: this.notifier,
      // L4 §4:訊息熔斷只斷訊息,不斷工作——不 interrupt 任何 session。
      interrupt: false,
    });
  }

  private async countAgentMessagesInContext(contextId: string): Promise<number> {
    const rows = await this.db
      .select({ id: teamMessagesTable.id })
      .from(teamMessagesTable)
      .where(and(eq(teamMessagesTable.contextId, contextId), eq(teamMessagesTable.source, "agent")))
      .all();
    return rows.length;
  }

  // ---- 投遞(既有邏輯,S2 只把 Mailbox 換成 DB 驅動)------------------------

  private async deliverBroadcast(
    fromMember: TeamMember,
    content: string,
    requestedPriority: MessagePriority,
  ): Promise<TeamBusSendOutcome> {
    const contextId = await this.deriveContextId(fromMember.id);
    await this.assertContextNotTripped(contextId);

    const { priority, note } = await this.resolvePriorityForSender(fromMember.teamId, fromMember.name, requestedPriority);
    const members = await this.teamManager.getTeamMembers(fromMember.teamId);
    const others = members.filter((m) => m.id !== fromMember.id);

    if (others.length === 0) {
      // 沒有其他收件者:仍記一筆(稽核/群聊歷史可見),但沒有人要投遞,直接
      // 標記立即已送達(不進 Mailbox,語意同 reportStatus() 的處理)。
      const message = await this.persistAndPush({
        teamId: fromMember.teamId,
        from: fromMember.name,
        fromRole: fromMember.role,
        to: "broadcast",
        content,
        priority,
        source: "agent",
        note,
        contextId,
        deliveredAt: Date.now(),
      });
      await this.checkThresholdAfterPersist(contextId);
      return { message, delivered: "no-session", downgraded: Boolean(note) };
    }

    // L4 §5.1:展開成 N 筆(每個收件者各自一筆 to_target),天然放大消耗
    // 這個 context 的預算——broadcast 風暴會比一對一訊息更快撞上上限。
    let lastMessage: TeamMessage | undefined;
    let anyImmediate = false;
    let anyQueued = false;
    for (const member of others) {
      const message = await this.persistAndPush({
        teamId: fromMember.teamId,
        from: fromMember.name,
        fromRole: fromMember.role,
        to: member.name,
        content,
        priority,
        source: "agent",
        note,
        contextId,
      });
      lastMessage = message;
      const result = await this.deliverToMember(member, message);
      if (result === "immediate") anyImmediate = true;
      if (result === "queued") anyQueued = true;
    }
    await this.checkThresholdAfterPersist(contextId);
    const delivered = anyImmediate ? "immediate" : anyQueued ? "queued" : "no-session";
    return { message: lastMessage!, delivered, downgraded: Boolean(note) };
  }

  /**
   * priority="interrupt" 的授權檢查:依「發送者名稱是否對應這個 team 內一個
   * TeamMember、且該成員 canInterrupt 為 true」判斷。之所以用名稱查找而不是
   * 只吃 fromMemberId,是因為人類插話(sendHumanMessage)沒有 memberId,但
   * 若人類刻意以某個成員的名義發送(fromName 撞名),仍套用同一套規則 ——
   * 單一 source of truth,agent 與人類共用同一段邏輯(見 class 頂端註解)。
   * 找不到對應成員(一般人類插話的情況)則不受限制,直接放行。
   */
  private async resolvePriorityForSender(
    teamId: string,
    fromName: string,
    requested: MessagePriority,
  ): Promise<{ priority: MessagePriority; note?: string }> {
    if (requested !== "interrupt") return { priority: requested };
    const member = await this.teamManager.findMemberByName(teamId, fromName);
    if (!member) {
      return { priority: "interrupt" };
    }
    if (member.canInterrupt) {
      return { priority: "interrupt" };
    }
    return {
      priority: "normal",
      note: `發送者 "${fromName}" 對應的 team member 無 interrupt 權限(canInterrupt=false),已自動降級為 normal`,
    };
  }

  private async persistAndPush(
    fields: Omit<TeamMessage, "id" | "timestamp"> & { contextId: string },
  ): Promise<TeamMessage> {
    const message: TeamMessage = { ...fields, id: randomUUID(), timestamp: Date.now() };
    await this.db.insert(teamMessagesTable).values(messageToRow(message)).run();
    this.emit("team-message", message);
    return message;
  }

  /**
   * 依目標成員目前的 session 狀態決定投遞方式。S2:訊息本身已經以
   * `delivered_at IS NULL` 的狀態 persist(見呼叫端的 `persistAndPush()`),
   * 這裡只決定「要不要現在就注入」——不注入時什麼都不用做,訊息已經自然待在
   * DB 驅動的 Mailbox 裡(不再需要額外的記憶體 `enqueue()`)。
   */
  private async deliverToMember(member: TeamMember, message: TeamMessage): Promise<TeamBusSendOutcome["delivered"]> {
    const session = await this.resolveSessionForDelivery(member, message.teamId);
    if (!session) return "no-session";
    const sessionId = session.id;

    if (message.priority === "interrupt") {
      return this.withMemberLock(member.id, async () => {
        // M3 Round B 修正(Round A review 待辦):修正前這裡是
        // `this.sessionManager.interrupt(sessionId)`(不 await)緊接著就
        // `await this.inject(...)` —— SDK 的 `interrupt()` 是非同步的(見
        // sdk.d.ts:resolve 才代表「查詢確實停止處理、控制權交還呼叫端」),
        // 不 await 就注入下一個 prompt,會與尚未真正停下的回合競爭
        // (真實忙碌的 SDK session 上,注入的 prompt 可能在舊回合完全停止前
        // 就被送進 input queue)。現在 `SessionManager.interrupt()` 回傳
        // Promise,這裡 await 它再注入,消除這個 race(e2e 步驟 14 驗證)。
        await this.sessionManager.interrupt(sessionId);
        await this.injectAndMarkDelivered(sessionId, [message]);
        return "immediate" as const;
      });
    }

    if (session.status === "idle") {
      const delivered = await this.flushPendingForMember(member.id, member.teamId, member.name);
      // 理論上 session 剛判斷 idle,`flushPendingForMember()` 幾乎必然把這則
      // (以及可能殘留的其他待投遞)訊息一起送出;若在取得鎖之前 session 狀態
      // 又變化(極端競態),就如實回報成 "queued"(訊息仍安好地留在 Mailbox)。
      return delivered ? "immediate" : "queued";
    }

    return "queued";
  }

  /**
   * 查出 member 目前綁定的 session。長命(persistent)成員沒有 session 時視為
   * 「該在線卻還沒上線」,自動建立一個(理由見 docs/LAYER-3-hld/
   * agent-lifecycle_hld.md §2.0「長命 = 為了在線可達,不是為了記憶」——這裡只是
   * 補上文件本來就要求的行為)。短命(ephemeral)成員維持原設計:不在線是刻意
   * 允許的狀態(同文件 §3「worker 不在線完全可接受,訊息落 Mailbox」),不自動
   * 建,留給任務指派或人工「建立 session」處理。
   *
   * workingDir 取不到(team 與 profile 都沒設定)或 `createSession()` 本身失敗
   * (例如 adapter spawn 失敗)時,靜默降級回 `undefined`——呼叫端會如實回報
   * "no-session",訊息安全留在 Mailbox,不讓自動上線的失敗變成整個 sendMessage
   * 的硬錯誤。
   */
  private async resolveSessionForDelivery(member: TeamMember, teamId: string): Promise<Session | undefined> {
    const existingId = this.sessionManager.getSessionIdForMember(member.id);
    if (existingId) return this.sessionManager.getSession(existingId);
    if (member.lifecycle !== "persistent") return undefined;

    return this.withMemberLock(member.id, async () => {
      // 鎖內重查一次:避免兩則訊息幾乎同時抵達、都看到「沒有 session」而各自
      // 建立一個(同一手法比照 flushPendingForMember 對 mailboxLocks 的用法)。
      const raceCheckId = this.sessionManager.getSessionIdForMember(member.id);
      if (raceCheckId) return this.sessionManager.getSession(raceCheckId);

      const [team, profile] = await Promise.all([
        this.teamManager.getTeam(teamId),
        this.profiles.get(member.agentProfileId),
      ]);
      const workingDir = team?.workingDir || profile?.workingDir;
      if (!workingDir) return undefined;

      try {
        return await this.sessionManager.createSession({
          title: `${member.name}(自動上線)`,
          agentProfileId: member.agentProfileId,
          workingDir,
          teamMemberId: member.id,
        });
      } catch {
        return undefined;
      }
    });
  }

  /**
   * 序列化同一個 member 的「查待投遞 → 注入 → 標記已送達」——避免「插入新
   * 訊息時剛好 session 轉 idle 觸發 flushMailbox」這種併發路徑重複撈到同一批
   * 還沒被標記的訊息,造成同一則訊息被注入兩次(見檔案頂端「Mailbox 改由 DB
   * 驅動」說明)。比照 `CostGovernor.withLock()` 的既有手法,但這裡是
   * per-member 各自一把鎖,不是全域單一鎖。
   */
  private async withMemberLock<T>(memberId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.mailboxLocks.get(memberId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(fn);
    this.mailboxLocks.set(
      memberId,
      run.catch(() => undefined),
    );
    return run;
  }

  /**
   * DB 驅動的 Mailbox 查詢(L4 §5 的權威來源):這個成員目前所有
   * `delivered_at IS NULL` 的訊息,依 `timestamp` 排序。**必須同時過濾
   * `teamId`**——`to_target` 只是成員名稱,同名成員可能存在於不同 team(舊版
   * 記憶體 `Map<memberId, TeamMessage[]>` 是用全域唯一的 `memberId` 當 key,
   * 天生不會跨 team 撞名;換成 DB 查詢後若只比對名稱字串,理論上會把 A team
   * 的「Reviewer」的待投遞訊息誤投給 B team 同名的「Reviewer」——這裡用
   * `teamId` 把查詢範圍收回單一 team,維持與舊版相同的隔離保證)。
   */
  private async getPendingMailboxMessages(teamId: string, memberName: string): Promise<TeamMessage[]> {
    const rows = await this.db
      .select()
      .from(teamMessagesTable)
      .where(
        and(
          eq(teamMessagesTable.teamId, teamId),
          eq(teamMessagesTable.toTarget, memberName),
          isNull(teamMessagesTable.deliveredAt),
        ),
      )
      .all();
    return rows.map(rowToMessage).sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * session 目前 idle 時嘗試把這個 member 的所有待投遞訊息一次撈出、注入、
   * 標記已送達。回傳是否真的注入了任何訊息(false = 沒有待投遞訊息,或取得
   * 鎖時 session 已經不是 idle)。
   */
  private async flushPendingForMember(memberId: string, teamId: string, memberName: string): Promise<boolean> {
    return this.withMemberLock(memberId, async () => {
      const sessionId = this.sessionManager.getSessionIdForMember(memberId);
      if (!sessionId) return false;
      const session = await this.sessionManager.getSession(sessionId);
      if (!session || session.status !== "idle") return false;
      const pending = await this.getPendingMailboxMessages(teamId, memberName);
      if (pending.length === 0) return false;
      await this.injectAndMarkDelivered(sessionId, pending);
      return true;
    });
  }

  /** `session-updated`(轉 idle)/ `member-session-ready` 事件觸發的既有補投路徑。 */
  private async flushMailbox(memberId: string): Promise<void> {
    const member = await this.teamManager.getMember(memberId);
    if (!member) return;
    await this.flushPendingForMember(memberId, member.teamId, member.name);
  }

  /**
   * L4 §5.2 交易一致性:`sendPrompt()` 成功回傳後,才在同一個
   * better-sqlite3 transaction 內把這批訊息全部標記為已送達。若
   * `sendPrompt()` 拋錯(例如 session 已消失、或被 CostGovernor 擋下),
   * **完全不標記**,原樣往外拋,訊息留在 Mailbox(`delivered_at` 仍是
   * NULL)下次重試——不會出現「注入成功但標記失敗」導致重啟後重複投遞的
   * 情況,也不會出現「注入失敗卻被標記成已送達」導致訊息憑空消失的情況。
   */
  private async injectAndMarkDelivered(sessionId: string, messages: TeamMessage[]): Promise<void> {
    if (messages.length === 0) return;
    const text = formatInjectedPrompt(messages);
    await this.sessionManager.sendPrompt(sessionId, { text });
    const now = Date.now();
    const ids = messages.map((m) => m.id);
    this.db.transaction((tx) => {
      for (const id of ids) {
        tx.update(teamMessagesTable).set({ deliveredAt: now }).where(eq(teamMessagesTable.id, id)).run();
      }
    });
  }
}

function formatInjectedPrompt(messages: TeamMessage[]): string {
  if (messages.length === 1) {
    return formatSingle(messages[0]);
  }
  const lines = messages.map((m, i) => `${i + 1}. ${formatSingle(m)}`);
  return `你收到 ${messages.length} 則隊友訊息(session 忙碌時累積,現在一次補上):\n${lines.join("\n")}`;
}

function formatSingle(m: TeamMessage): string {
  const roleLabel = m.fromRole ? `(${m.fromRole})` : "";
  const broadcastLabel = m.to === "broadcast" ? "[廣播] " : "";
  const downgradeLabel = m.note ? `[${m.note}] ` : "";
  return `${downgradeLabel}${broadcastLabel}來自 @${m.from}${roleLabel} 的訊息:${m.content}`;
}

function rowToMessage(row: typeof teamMessagesTable.$inferSelect): TeamMessage {
  return {
    id: row.id,
    teamId: row.teamId,
    from: row.fromName,
    fromRole: row.fromRole ?? undefined,
    to: row.toTarget,
    content: row.content,
    priority: row.priority as TeamMessage["priority"],
    timestamp: row.timestamp,
    source: row.source as TeamMessage["source"],
    note: row.note ?? undefined,
    contextId: row.contextId,
    deliveredAt: row.deliveredAt ?? undefined,
  };
}

function messageToRow(message: TeamMessage): typeof teamMessagesTable.$inferInsert {
  return {
    id: message.id,
    teamId: message.teamId,
    fromName: message.from,
    fromRole: message.fromRole ?? null,
    toTarget: message.to,
    content: message.content,
    priority: message.priority,
    timestamp: message.timestamp,
    source: message.source,
    note: message.note ?? null,
    contextId: message.contextId,
    deliveredAt: message.deliveredAt ?? null,
  };
}
