import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { eq } from "drizzle-orm";
import type { NexusDb } from "@deskmony/db";
import { tasks as tasksTable } from "@deskmony/db";
import {
  DeskmonyError,
  ErrorCodes,
  type AcceptanceResult,
  type AssignTaskInput,
  type CreateSessionInput,
  type CreateTaskInput,
  type Session,
  type Task,
  type TaskAcceptance,
  type TaskStatus,
  type Workspace,
} from "@deskmony/shared";
import type { TeamManager } from "../team/team-manager.js";
import type { WorkspaceManager } from "../workspace/workspace-manager.js";
import type { Notifier } from "../enforcement/notifier.js";
import { AcceptanceRunner } from "./acceptance-runner.js";

/**
 * S5(dispose-gate)L4 §3:同一任務連續驗收失敗達這個次數後,直接拒絕、不再
 * 呼叫 `AcceptanceRunner`——每次跑驗收都有真實成本(可能是 `pnpm test`/CI 等
 * 級的耗時操作),agent 若卡在「送審 → 失敗 → 立刻重送」的迴圈,會無謂燒掉
 * 大量算力。達到上限後改為 escalate 給人類(見 `applyAcceptanceRunGate()`)。
 */
const MAX_CONSECUTIVE_ACCEPTANCE_FAILURES = 3;

/**
 * S8(agent-lifecycle)L4 §2.1:`assignTask()`/`updateStatus()`/`deleteTask()`
 * 需要對 ephemeral member 自動 spawn/dispose session,但 `SessionManager` 的
 * 建構子需要 `CostGovernor`,而 `CostGovernor` 的建構子需要 `TaskService`
 * ——三者之間有循環依賴(見 apps/core/src/index.ts 的建構順序說明)。與既有的
 * `turnLimiter.setSessionControl()`/`costGovernor.setSessionControl()` 同一個
 * 「先建構、事後用 setter 打破循環」手法:這裡只宣告 `TaskService` 需要的最小
 * 介面(不是整個 `SessionManager`),由 `apps/core/src/index.ts` 在
 * `SessionManager` 建好之後注入。
 */
export interface TaskSessionControlPort {
  /** 某個 team member 目前是否有活躍 session(§2.1「已有活躍 session → 拒絕指派」)。 */
  getSessionIdForMember(memberId: string): string | undefined;
  /** ephemeral member 指派任務時自動 spawn(§2.1)。 */
  createSession(input: CreateSessionInput): Promise<Session>;
  /** ephemeral member 的任務進入終態時自動 dispose(§2.2)——冪等,找不到活躍
   *  session 時視為已完成,不拋錯。 */
  disposeSessionForMember(memberId: string): Promise<void>;
}

/**
 * TaskService(ARCHITECTURE.md 3.3 節):
 *   「任務建立、指派給 agent、狀態流轉、驗收流程」
 *
 * 狀態機(ARCHITECTURE.md 第 5 節「任務協作流程」+ 這輪任務描述放寬的
 * blocked 規則,見 packages/shared/src/task.ts 的 TaskStatusSchema 註解):
 *
 *   backlog → assigned          (指派時觸發 WorkspaceManager 建立 worktree,見 assignTask())
 *   assigned → in-progress
 *   in-progress → review
 *   review → in-progress        (退回)
 *   review → merging
 *   merging → done
 *   (backlog|assigned|in-progress|review|merging) → blocked
 *   blocked → <task.blockedFrom>(回到進入 blocked 前的狀態)
 *
 * `isValidTransition()` 是唯一允許改變 `status` 的判斷式,非法跳轉一律丟出
 * 明確錯誤(不做「有找到目標狀態字串就放行」這種寬鬆處理)。
 *
 * M4 Round B 補充:`isValidTransition()` 允許 `merging → done` 這件事本身沒變
 * (`updateStatus()` 依然是唯一改變 `status` 的判斷式),但這輪新增了
 * `mergeAndComplete()` 作為「merging → done」實際上唯一應該被使用的路徑 ——
 * 它在呼叫 `updateStatus(taskId, "done")` 之前,會先真的執行
 * `WorkspaceManager.mergeWorkspace()`(git merge)並要求成功。理論上還是可以
 * 繞過 `mergeAndComplete()`、直接呼叫 `updateStatus(taskId, "done")` 讓狀態
 * 變成 done 而不做真正的合併 —— 這裡刻意不在 `updateStatus()` 本身加上這個
 * 限制(那會讓 `updateStatus()` 承擔它不該管的「是否真的合併了」語意),而是
 * 在唯一允許呼叫 `updateStatus(..., "done")` 的兩個地方分別把關:
 *   1. `mergeAndComplete()` 本身保證「先合併成功才轉 done」。
 *   2. `tryApplyReportStatus()`(agent 端 report_status/request_review 的
 *      唯一入口)明確擋掉 "done" 這個目標,agent 沒有任何合法路徑能讓任務
 *      自己變成 done ——所有能觸發 `updateStatus(taskId, "done")` 的 gateway
 *      方法只剩 `task.updateStatus`(人類/UI 直接呼叫,略過真正合併,屬於
 *      「進階使用者自行負責」的既有行為,任務描述並未要求連這條路也鎖死)與
 *      `task.merge`(這輪新增,唯一會先真的執行 git merge 的路徑)。
 */

/** 除了 "blocked" 以外,每個狀態允許前進到哪些狀態(不含 blocked 分支,見下方 isValidTransition)。 */
const FORWARD_TRANSITIONS: Record<Exclude<TaskStatus, "blocked">, TaskStatus[]> = {
  backlog: ["assigned"],
  assigned: ["in-progress"],
  "in-progress": ["review"],
  review: ["in-progress", "merging"],
  merging: ["done"],
  done: [],
};

/** 哪些狀態可以被打斷進入 blocked —— done(終態)與 blocked 自己不行。 */
const BLOCKABLE_STATUSES: TaskStatus[] = ["backlog", "assigned", "in-progress", "review", "merging"];

/**
 * `report_status` MCP 工具的 `status` 自由文字 → TaskStatus 的對映表
 * (apps/core/src/bus/message-bus.ts 的 reportStatus() 呼叫 tryApplyReportStatus()
 * 時使用)。刻意保守:只收錄 TaskStatus 本身與少數常見同義詞,查不到就視為
 * 「無法對映」,不做更聰明的模糊比對 —— report_status 的 status 欄位本來就是
 * agent 自由填寫的敘述性文字(例如 "reviewing PR #12"),硬要對映任意字串
 * 風險比效益高。
 *
 * M4 Round B 補充:表裡仍然保留 "done"/"completed"/"complete"/"finished" 這幾個
 * 對映到 TaskStatus "done" 的別名(mapReportStatusToTaskStatus 本身不變),
 * 但 `tryApplyReportStatus()` 會在對映結果是 "done" 時明確擋下來、不套用
 * ——「done 只能由人類經 task.merge 觸發真正的 git 合併」是這輪新增的把關點
 * (見下方 tryApplyReportStatus 內的說明與 WorkspaceManager.mergeWorkspace/
 * TaskService.mergeAndComplete),擋在套用階段而不是拿掉別名本身,是因為
 * "done" 依然是這個字串合法的對映目標(語意上沒有錯),只是「report_status
 * 這個管道不被允許把任務直接標記完成」,兩件事分開表達比較清楚。
 */
const REPORT_STATUS_ALIASES: Record<string, TaskStatus> = {
  backlog: "backlog",
  assigned: "assigned",
  "in-progress": "in-progress",
  "in_progress": "in-progress",
  inprogress: "in-progress",
  review: "review",
  reviewing: "review",
  "in-review": "review",
  merging: "merging",
  merge: "merging",
  done: "done",
  completed: "done",
  complete: "done",
  finished: "done",
  blocked: "blocked",
  block: "blocked",
};

export function mapReportStatusToTaskStatus(statusText: string): TaskStatus | undefined {
  return REPORT_STATUS_ALIASES[statusText.trim().toLowerCase()];
}

function isValidTransition(current: TaskStatus, target: TaskStatus, blockedFrom: TaskStatus | undefined): boolean {
  if (current === target) return false;
  if (target === "blocked") {
    return BLOCKABLE_STATUSES.includes(current);
  }
  if (current === "blocked") {
    return target === blockedFrom;
  }
  return FORWARD_TRANSITIONS[current].includes(target);
}

/** tryApplyReportStatus() 的結果,供 MessageBus.reportStatus() 組裝人類可讀的回饋文字。 */
export interface ReportStatusOutcome {
  updated: boolean;
  fromStatus?: TaskStatus;
  toStatus?: TaskStatus;
  /** updated === false 時,說明為什麼沒有更新(找不到任務/成員不是指派人/對映不到/非法轉換)。 */
  skippedReason?: string;
}

export class TaskService extends EventEmitter {
  /**
   * S4(機器驗收閘,切片):純執行、無狀態機知識的 Runner(見
   * apps/core/src/tasks/acceptance-runner.ts 頂端註解)。內部用 `taskId` 加鎖
   * ——這裡是 process 內唯一一個 instance,所有任務共用,鎖才有意義。
   */
  private readonly acceptanceRunner = new AcceptanceRunner();

  /** S8:見上方 `TaskSessionControlPort` 註解——事後由 index.ts 注入。 */
  private sessionControl: TaskSessionControlPort | undefined;

  /**
   * S5(dispose-gate):升級「等待人類核可」給人類(§1.2「無 acceptance →
   * 人判」、§3「連續驗收失敗 → 通知人類」)——沿用 S1 的 Enforcement 底座
   * (`Notifier`),不新建一套通知機制。與 `sessionControl` 同樣的「先建構、
   * 事後用 setter 注入」手法(apps/core/src/index.ts 建構 TaskService 時
   * `RealNotifier` 還沒建好)。
   */
  private notifier: Notifier | undefined;

  /**
   * S5(dispose-gate)L4 §3:同一任務連續驗收失敗的次數,key = taskId。**刻意
   * 用 process 記憶體、不落地 DB**——這是這輪的保守選擇之一(見本檔案交付
   * 報告):最壞情況只是「core 重啟後這個計數器歸零,多讓 agent 白跑最多 3
   * 次真正的驗收」,不是安全性錯誤(agent 仍然過不了真正的驗收閘,也仍然拿
   * 不到自我背書的能力),換來不需要為一個純粹的重試節流計數器新增 schema
   * 遷移。任務進終態或驗收改變後應該讓計數器歸零,見下方各呼叫點。
   */
  private readonly acceptanceFailureStreak = new Map<string, number>();

  constructor(
    private readonly db: NexusDb,
    private readonly teamManager: TeamManager,
    private readonly workspaceManager: WorkspaceManager,
  ) {
    super();
  }

  /** S8:apps/core/src/index.ts 建好 SessionManager 後回頭注入(比照既有的
   *  `setTeamBus()`/`setClientPresence()` 手法)。 */
  setSessionControl(sessionControl: TaskSessionControlPort): void {
    this.sessionControl = sessionControl;
  }

  /** S5:apps/core/src/index.ts 建好 `RealNotifier` 後回頭注入,見上方
   *  `notifier` 欄位註解。 */
  setNotifier(notifier: Notifier): void {
    this.notifier = notifier;
  }

  async createTask(input: CreateTaskInput): Promise<Task> {
    const team = await this.teamManager.getTeam(input.teamId);
    if (!team) {
      throw new DeskmonyError(
        ErrorCodes.ENTITY_NOT_FOUND,
        { entityType: "team", id: input.teamId },
        `找不到 team: ${input.teamId}`,
      );
    }
    const now = Date.now();
    const task: Task = {
      id: randomUUID(),
      teamId: input.teamId,
      title: input.title,
      description: input.description,
      status: "backlog",
      // S4:建立時可直接帶入機器驗收條件(人類設定,見
      // packages/shared/src/task.ts 的 `TaskAcceptanceSchema` 完整性紀律說明)。
      acceptance: input.acceptance,
      // S5:新任務一律從「沒有在等待人類核可」開始。
      awaitingHumanReview: false,
      createdAt: now,
      updatedAt: now,
    };
    await this.db.insert(tasksTable).values(taskToRow(task)).run();
    this.emit("task-updated", task);
    return task;
  }

  /**
   * S4:事後設定/清除一個既有任務的機器驗收條件(見
   * packages/shared/src/task.ts 的 `SetTaskAcceptanceInputSchema` 註解——
   * 這個 codebase 沒有通用的 `task.update`,選擇新增一個一樣窄範圍的方法)。
   * 只能由人類經 gateway 的 `task.setAcceptance` 呼叫;team-bus MCP 工具沒有
   * 對應的入口(完整性紀律,見 packages/adapters/src/team-bus-mcp.ts)。
   */
  async setAcceptance(taskId: string, acceptance: TaskAcceptance | undefined): Promise<Task> {
    const task = await this.mustGetTask(taskId);
    const updated: Task = { ...task, acceptance, updatedAt: Date.now() };
    await this.db.update(tasksTable).set(taskToRow(updated)).where(eq(tasksTable.id, task.id)).run();
    this.emit("task-updated", updated);
    // S5:驗收條件本身變了,之前針對舊條件累積的連續失敗次數不該繼續沿用
    // ——歸零,讓下一次送審重新從第 1 次算起(見 class 頂端
    // `acceptanceFailureStreak` 註解)。
    this.acceptanceFailureStreak.delete(taskId);
    return updated;
  }

  /**
   * S4:跑這個任務的機器驗收(見 acceptance-runner.ts 的 `AcceptanceRunner`)。
   *
   * **刻意不碰 `updateStatus()`**(見本檔案頂端 class 註解「M4 Round B 補充」
   * 段落引用的既有哲學,以及
   * [S4 L4](../../../../docs/LAYER-4-detail-design/acceptance-gate_detail.md)
   * §0 的完整說明):`updateStatus()` 只管「狀態轉換合不合法」,不該承擔
   * 「驗收有沒有過」這種語意檢查。這個方法純粹回傳結果給呼叫端(gateway/UI)
   * 自行決定要不要理會——切片是**諮詢性**的,不擋任何狀態轉換,Phase 2 真的
   * 要做 Gate 時,裁決邏輯要收斂到 gateway 的 `task.updateStatus`(唯一對外
   * 入口),而不是這裡或 `updateStatus()` 內部。
   */
  async runAcceptance(taskId: string): Promise<AcceptanceResult> {
    const task = await this.mustGetTask(taskId);
    const workspace = task.workspaceId ? await this.workspaceManager.getWorkspace(task.workspaceId) : undefined;
    return this.acceptanceRunner.run(task, workspace);
  }

  async listTasks(teamId: string): Promise<Task[]> {
    const rows = await this.db.select().from(tasksTable).where(eq(tasksTable.teamId, teamId)).all();
    return rows.map(rowToTask).sort((a, b) => a.createdAt - b.createdAt);
  }

  async getTask(taskId: string): Promise<Task | undefined> {
    const rows = await this.db.select().from(tasksTable).where(eq(tasksTable.id, taskId)).all();
    return rows[0] ? rowToTask(rows[0]) : undefined;
  }

  /**
   * S3b(CostGovernor)新增:查詢一個 team member 目前指派的任務(用於 usage
   * delta 的任務歸屬,見 cost-governor_detail.md §1「依 session 當下綁定的
   * task」)。**不限定 teamId**——`assigneeMemberId` 本身就是 team member 的
   * 唯一 id,不需要額外的 teamId 過濾;一個成員理論上同時只會被指派一個未完成
   * 任務(`assignTask()` 是唯一寫入 `assigneeMemberId` 的地方,沒有「一人多
   * 任務」的併發指派路徑),但仍防禦性地排除 `"done"`(任務已結束就不該再吃
   * 之後的 usage delta)並在有多筆時取 `updatedAt` 最新的一筆。找不到回傳
   * `undefined`(session 未綁任務,delta 只計入 session/day 層級)。
   */
  async getActiveTaskForMember(memberId: string): Promise<Task | undefined> {
    const rows = await this.db.select().from(tasksTable).where(eq(tasksTable.assigneeMemberId, memberId)).all();
    const active = rows.map(rowToTask).filter((task) => task.status !== "done");
    if (active.length === 0) return undefined;
    return active.reduce((latest, task) => (task.updatedAt > latest.updatedAt ? task : latest));
  }

  /**
   * S2(message-budget)新增:查詢一個 team member 目前可用於訊息 contextId
   * 推導的任務(見 docs/LAYER-4-detail-design/message-budget_detail.md §2「推導
   * 規則(釘死)」)。**刻意採用比 `getActiveTaskForMember()`(S3b 用,只排除
   * "done")更窄的狀態集合**——只有 `{assigned, in-progress, review, merging}`
   * 這幾個「正在被積極處理」的狀態才算:`backlog`(尚未真正指派工作,理論上
   * `assigneeMemberId` 也不會是 backlog 任務)與 `blocked`(暫停中)都不算,
   * 語意上一個進了 blocked 的任務不該讓 agent 繼續用它當 context 發送新的
   * 協作訊息。找不到符合的任務回傳 `undefined`(呼叫端 MessageBus 依此拒收,
   * 見 message-budget_detail.md §2「零個 → 拒收」)。
   *
   * 多於一個時取 `updatedAt` 最新的一筆(§2「多於一個 → 取 updatedAt 最新
   * 者(保守且可預期);S8 之後若允許一 member 多任務,此處需重新設計」)。
   */
  async getMessageContextTaskForMember(memberId: string): Promise<Task | undefined> {
    const rows = await this.db.select().from(tasksTable).where(eq(tasksTable.assigneeMemberId, memberId)).all();
    const eligible = rows
      .map(rowToTask)
      .filter(
        (task) =>
          task.status === "assigned" ||
          task.status === "in-progress" ||
          task.status === "review" ||
          task.status === "merging",
      );
    if (eligible.length === 0) return undefined;
    return eligible.reduce((latest, task) => (task.updatedAt > latest.updatedAt ? task : latest));
  }

  /**
   * backlog → assigned:指派給一個 team member,並同步透過 WorkspaceManager
   * 建立這個任務專屬的 git worktree(ARCHITECTURE.md 第 5 節「指派給成員
   * (自動建立 git worktree)」)。member 必須屬於同一個 team;team 必須設有
   * `workingDir` 且該目錄是 git repo(否則 WorkspaceManager 會丟出明確錯誤,
   * 見 workspace-manager.ts 的 assertIsGitRepo)。
   */
  async assignTask(input: AssignTaskInput): Promise<{ task: Task; workspace: Workspace }> {
    const task = await this.mustGetTask(input.taskId);
    if (!isValidTransition(task.status, "assigned", task.blockedFrom)) {
      throw new DeskmonyError(
        ErrorCodes.TASK_INVALID_TRANSITION,
        { from: task.status, to: "assigned", taskId: task.id },
        `不合法的任務狀態轉換: ${task.status} → assigned(taskId=${task.id})`,
      );
    }

    const member = await this.teamManager.getMember(input.memberId);
    if (!member || member.teamId !== task.teamId) {
      throw new DeskmonyError(
        "task.memberNotInTeam",
        { memberId: input.memberId, taskId: task.id },
        `成員 ${input.memberId} 不屬於任務 ${task.id} 所在的 team`,
      );
    }

    const team = await this.teamManager.getTeam(task.teamId);
    if (!team) {
      throw new DeskmonyError(
        ErrorCodes.ENTITY_NOT_FOUND,
        { entityType: "team", id: task.teamId },
        `找不到 team: ${task.teamId}`,
      );
    }
    if (!team.workingDir) {
      throw new DeskmonyError(
        "task.teamMissingWorkingDir",
        { teamId: team.id, teamName: team.name },
        `team "${team.name}" 未設定 workingDir,無法建立任務 worktree 隔離`,
      );
    }

    const workspace = await this.workspaceManager.createWorkspaceForTask({
      taskId: task.id,
      baseDir: team.workingDir,
    });

    // S8(agent-lifecycle)L4 §2.1:ephemeral member 指派時自動 spawn session;
    // persistent member 什麼都不做(長命 session 由人或團隊啟動時建立,見
    // agent-lifecycle_detail.md §2.1)。**這裡的檢查/spawn 都在「任務狀態實際
    // 寫進 DB」之前**——失敗時只需要回滾剛建立的 workspace,任務本身從未離開
    // 原本的狀態,天然滿足「整個指派回滾、任務退回 backlog」的要求(§2.1「失敗
    // 處理」),不需要額外的復原邏輯。
    if (member.lifecycle === "ephemeral") {
      if (!this.sessionControl) {
        // 理論上不會發生——index.ts 一定會呼叫 setSessionControl()。防禦性地
        // 視為錯誤並回滾,而不是靜默略過自動 spawn(那會留下「已指派但沒有
        // agent」的半狀態,正是 §2.1 要避免的)。
        await this.rollbackWorkspace(workspace);
        throw new DeskmonyError(
          "task.sessionControlNotReady",
          undefined,
          "內部錯誤:SessionManager 尚未就緒,無法為 ephemeral 成員自動建立 session(指派已回滾)",
        );
      }

      const existingSessionId = this.sessionControl.getSessionIdForMember(member.id);
      if (existingSessionId) {
        await this.rollbackWorkspace(workspace);
        const existingTask = await this.getActiveTaskForMember(member.id);
        throw new DeskmonyError(
          "task.memberAlreadyAssigned",
          { memberName: member.name, existingTaskTitle: existingTask?.title, sessionId: existingSessionId },
          `成員 "${member.name}" 目前已在任務${existingTask ? ` "${existingTask.title}"` : ""}上,一個成員同時只能承接一個任務` +
            `(session ${existingSessionId} 仍在使用中)`,
        );
      }

      try {
        await this.sessionControl.createSession({
          title: `${member.name}: ${task.title}`,
          agentProfileId: member.agentProfileId,
          workingDir: workspace.worktreePath,
          teamMemberId: member.id,
        });
      } catch (err) {
        await this.rollbackWorkspace(workspace);
        const detail = err instanceof Error ? err.message : String(err);
        throw new DeskmonyError(
          "task.sessionAutoCreateFailed",
          { memberName: member.name, detail },
          `成員 "${member.name}" 的 session 自動建立失敗,指派已整個回滾(任務退回 backlog、workspace 已清除): ${detail}`,
        );
      }
    }

    const updated: Task = {
      ...task,
      status: "assigned",
      assigneeMemberId: member.id,
      workspaceId: workspace.id,
      updatedAt: Date.now(),
    };
    await this.db.update(tasksTable).set(taskToRow(updated)).where(eq(tasksTable.id, task.id)).run();
    this.emit("task-updated", updated);
    return { task: updated, workspace };
  }

  /** §2.1 失敗回滾用:清掉剛建立、還沒有任何任務狀態依賴它的 workspace。
   *  刪分支(理由同 `deleteTask()`——這個 workspace 從未真正被使用過,分支
   *  沒有保留的理由)。回滾本身失敗只記警告,不蓋掉呼叫端原本要拋出的錯誤
   *  (回滾是盡力而為的清理,不應該讓「清理失敗」掩蓋「指派失敗」這個主因)。 */
  private async rollbackWorkspace(workspace: Workspace): Promise<void> {
    try {
      await this.workspaceManager.removeWorkspace(workspace, { deleteBranch: true });
    } catch (err) {
      console.error(
        `[task-service] 指派失敗回滾 workspace(${workspace.id})失敗,worktree 可能殘留,需人工清理: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** 一般狀態轉換入口(assign 以外的所有轉換都走這裡,含 blocked 進出)。 */
  async updateStatus(taskId: string, newStatus: TaskStatus): Promise<Task> {
    const task = await this.mustGetTask(taskId);
    if (!isValidTransition(task.status, newStatus, task.blockedFrom)) {
      throw new DeskmonyError(
        ErrorCodes.TASK_INVALID_TRANSITION,
        { from: task.status, to: newStatus, taskId: task.id },
        `不合法的任務狀態轉換: ${task.status} → ${newStatus}(taskId=${task.id})`,
      );
    }
    const updated: Task = {
      ...task,
      status: newStatus,
      blockedFrom: newStatus === "blocked" ? task.status : undefined,
      updatedAt: Date.now(),
    };
    await this.db.update(tasksTable).set(taskToRow(updated)).where(eq(tasksTable.id, task.id)).run();
    this.emit("task-updated", updated);
    // S8(agent-lifecycle)L4 §2.2:任務進入終態("done")→ ephemeral member 的
    // session 自動 dispose。**"blocked" 刻意不 dispose**——它可能回到
    // in-progress,長期 blocked 由 S3b 的 T2 資源回收處理(既有機制,這裡不
    // 重複實作,見 agent-lifecycle_detail.md §2.2)。"review"/"merging" 也不
    // dispose(可能被退回)。
    if (newStatus === "done") {
      await this.disposeEphemeralMemberSession(updated);
    }
    return updated;
  }

  /** S8 L4 §2.2:任務終態(done/人工放棄)→ 若指派人是 ephemeral member,
   *  dispose 其 session(釋放子程序,DB session 標 closed,見
   *  session-manager.ts 的 `disposeSessionForMember()`)。**盡力而為、不拋錯**
   *  ——dispose 失敗只記稽核警告,session 留著不算災難(§5「任務 done 但
   *  dispose 失敗」:下次指派前 `assignTask()` 會先檢查該 member 是否已有
   *  活躍 session)。 */
  private async disposeEphemeralMemberSession(task: Task): Promise<void> {
    if (!task.assigneeMemberId) return;
    const member = await this.teamManager.getMember(task.assigneeMemberId);
    if (!member || member.lifecycle !== "ephemeral") return;
    if (!this.sessionControl) return; // 理論上不會發生,見 constructor 上方註解。
    try {
      await this.sessionControl.disposeSessionForMember(member.id);
    } catch (err) {
      console.error(
        `[task-service] 任務 ${task.id} 進入終態後,dispose 成員 "${member.name}" 的 session 失敗` +
          `(session 會留著,不算災難,下次指派前 assignTask() 會先檢查): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * 刪除任務:若已綁定 workspace,先透過 WorkspaceManager 清理 worktree(強制
   * `git worktree remove --force` + 刪除對應分支 —— 任務本身都要被刪除了,
   * 分支沒有保留的理由,這點跟 updateStatus 到 "done" 時刻意**不**清理
   * worktree 的設計不同,見 workspace-manager.ts 的說明),再刪除任務紀錄。
   *
   * M4 Round B:回傳 `hadUncommittedChanges`(委派自
   * `WorkspaceManager.removeWorkspace()`)——刪除本身不會因為 worktree 裡還有
   * 未 commit 的變更而被擋下(呼叫這個方法就代表呼叫端已經決定要刪),但讓
   * gateway/UI 能事後警告使用者「剛剛刪掉的 worktree 裡其實還有沒存的變更」。
   * 同時 emit "task-deleted"(帶 id/teamId)—— 這是刪除操作原本沒有對應
   * server push 的補洞:`task-updated` 只在「任務仍然存在、欄位變更」時觸發,
   * 刪除是另一種語意(任務不再存在),UI(看板)需要一個明確訊號才能把已刪除
   * 的任務從畫面上移除,而不是誤把「查不到」當成網路問題重試。
   */
  async deleteTask(taskId: string): Promise<{ hadUncommittedChanges: boolean }> {
    const task = await this.mustGetTask(taskId);
    // S8 L4 §2.2:人工放棄(deleteTask)同樣是終態,ephemeral member 的 session
    // 一併 dispose(見 disposeEphemeralMemberSession() 註解)。在刪除任務記錄
    // 之前呼叫,此時 task.assigneeMemberId 仍然可讀。
    await this.disposeEphemeralMemberSession(task);
    let hadUncommittedChanges = false;
    if (task.workspaceId) {
      const workspace = await this.workspaceManager.getWorkspace(task.workspaceId);
      if (workspace) {
        const result = await this.workspaceManager.removeWorkspace(workspace, { deleteBranch: true });
        hadUncommittedChanges = result.hadUncommittedChanges;
      }
    }
    await this.db.delete(tasksTable).where(eq(tasksTable.id, taskId)).run();
    this.emit("task-deleted", { id: task.id, teamId: task.teamId });
    // S5:任務都刪了,殘留的連續驗收失敗計數沒有意義,清掉避免無界成長。
    this.acceptanceFailureStreak.delete(taskId);
    return { hadUncommittedChanges };
  }

  /**
   * M4 Round B:「Merging --> Done : worktree 合併回主幹」這句話這輪才真正
   * 落地(M4 Round A 備註明講「這輪沒有自動化實作」)。**這是整個系統裡唯一
   * 真正執行 `git merge` 的入口**——只被 `task.merge` gateway 方法呼叫,而
   * `task.merge` 是人類從 UI 觸發的動作(見 README「人類批准合併」章節、
   * WsGateway 的 task.merge case)。刻意獨立於 `updateStatus()` 之外、不是
   * 單純呼叫 `updateStatus(taskId, "done")`:
   *   - 要求現狀必須是 "merging"(不能繞過中間狀態,`isValidTransition` 本身
   *     也只允許 merging → done,這裡再做一次語意更明確的檢查與錯誤訊息)。
   *   - 呼叫 `WorkspaceManager.mergeWorkspace()` 執行真正的 `git merge`;若
   *     合併衝突(拋出 `MergeConflictError`)或任何其他錯誤,原樣往外拋 ——
   *     刻意不 catch、不呼叫 `updateStatus()`,任務狀態維持在 "merging"
   *     (不 emit 任何 task-updated),讓使用者可以看著錯誤訊息(含衝突檔案
   *     清單)決定下一步。
   *   - 只有合併真的成功,才呼叫既有的 `updateStatus()` 轉進 "done"(沿用
   *     既有的合法轉換檢查與 task-updated 推播,不重複實作狀態轉換邏輯)。
   */
  async mergeAndComplete(taskId: string): Promise<Task> {
    const task = await this.mustGetTask(taskId);
    if (task.status !== "merging") {
      throw new DeskmonyError(
        "task.mergeRequiresMergingStatus",
        { status: task.status, taskId: task.id },
        `只有狀態為 merging 的任務才能執行合併(目前狀態: ${task.status}, taskId=${task.id})`,
      );
    }
    if (!task.workspaceId) {
      throw new DeskmonyError("task.noWorkspaceToMerge", { taskId: task.id }, `任務 ${task.id} 沒有綁定 workspace,無法合併`);
    }
    const workspace = await this.workspaceManager.getWorkspace(task.workspaceId);
    if (!workspace) {
      throw new DeskmonyError(
        ErrorCodes.ENTITY_NOT_FOUND,
        { entityType: "workspace", id: task.workspaceId },
        `找不到任務 ${task.id} 綁定的 workspace: ${task.workspaceId}`,
      );
    }
    await this.workspaceManager.mergeWorkspace(workspace);
    return this.updateStatus(taskId, "done");
  }

  /**
   * 查詢一個任務綁定的 workspace 分支名稱(找不到回傳 undefined)。給
   * `MessageBus.requestReview()` 用 —— 通知 reviewer 時附上分支名稱,不需要
   * 讓 MessageBus 直接依賴 WorkspaceManager(依賴方向維持 TaskService 是
   * 唯一同時認識 Task 與 Workspace 的模組)。
   */
  async getTaskBranch(taskId: string): Promise<string | undefined> {
    const task = await this.getTask(taskId);
    if (!task?.workspaceId) return undefined;
    const workspace = await this.workspaceManager.getWorkspace(task.workspaceId);
    return workspace?.branch;
  }

  /**
   * report_status 工具帶 taskId 時的整合邏輯(見
   * apps/core/src/bus/message-bus.ts 的 reportStatus()、
   * packages/adapters/src/team-bus-mcp.ts 的 report_status 工具描述)。
   * 刻意「盡力而為、絕不拋錯誤」—— 呼叫端只需要把結果文字化附加到訊息內容,
   * 不應該因為任務狀態機的限制讓 report_status 這個純訊息回報工具失敗。
   */
  async tryApplyReportStatus(memberId: string, taskId: string, statusText: string): Promise<ReportStatusOutcome> {
    const task = await this.getTask(taskId);
    if (!task) {
      return { updated: false, skippedReason: `找不到任務 ${taskId}` };
    }
    if (task.assigneeMemberId !== memberId) {
      return { updated: false, skippedReason: `此成員未被指派任務 ${taskId},不同步狀態` };
    }
    const mapped = mapReportStatusToTaskStatus(statusText);
    if (!mapped) {
      return { updated: false, skippedReason: `狀態文字 "${statusText}" 無法對映到任務狀態,僅記錄訊息` };
    }
    if (mapped === "done") {
      // M4 Round B 把關點:agent 無法透過 report_status(或包裝它的
      // request_review)把任務直接標記完成 —— "done" 只能由人類經
      // task.merge 觸發真正的 git 合併後才會轉換(見 mergeAndComplete() 的
      // 說明)。這裡刻意在套用階段擋下來,而不是把 "done" 從
      // REPORT_STATUS_ALIASES 拿掉(那樣會讓 mapReportStatusToTaskStatus 對
      // "done"/"completed" 這些字面上完全合理的詞回報「無法對映」,語意上
      // 反而更令人困惑)。
      return {
        updated: false,
        skippedReason:
          `"done" 狀態需要人類透過 task.merge 執行實際合併後才會轉換 —— agent 無法透過 report_status 直接把任務標記完成,僅記錄訊息`,
      };
    }
    if (mapped === task.status) {
      return { updated: false, skippedReason: `任務已經是 ${mapped} 狀態` };
    }
    if (mapped === "review") {
      // S5(dispose-gate)L4 §1.1:只擋 agent 這條路徑(report_status/
      // request_review 都經由這個方法),gateway 的 task.updateStatus(人類
      // /UI 直接呼叫)不會經過這裡,維持諮詢、不受這道閘影響——理由見
      // apps/core/src/tasks/task-service.ts 頂端 class 註解引用的既有哲學,
      // 以及 dispose-gate-and-lead_detail.md §1.1「為何只擋 agent 路徑」。
      return this.applyReviewAcceptanceGate(task);
    }
    try {
      const updated = await this.updateStatus(taskId, mapped);
      return { updated: true, fromStatus: task.status, toStatus: updated.status };
    } catch (err) {
      return {
        updated: false,
        skippedReason: `不合法的狀態轉換 ${task.status} → ${mapped}(${err instanceof Error ? err.message : String(err)}),僅記錄訊息`,
      };
    }
  }

  /**
   * S5(dispose-gate)L4 §1.2:agent 請求 `in-progress → review` 的裁決規則:
   *   - 先確認轉換本身合法(狀態機層級,與其餘轉換共用同一個 `isValidTransition`)。
   *   - 有 `acceptance` → 交給 `applyAcceptanceRunGate()`(機器判)。
   *   - 無 `acceptance` → 交給 `applyHumanReviewGate()`(人判)。
   */
  private async applyReviewAcceptanceGate(task: Task): Promise<ReportStatusOutcome> {
    if (!isValidTransition(task.status, "review", task.blockedFrom)) {
      return { updated: false, skippedReason: `不合法的任務狀態轉換 ${task.status} → review,僅記錄訊息` };
    }
    if (task.acceptance) {
      return this.applyAcceptanceRunGate(task);
    }
    return this.applyHumanReviewGate(task);
  }

  /**
   * S5 L4 §1.2「有 acceptance → 機器判」+ §3「連續失敗 3 次 → 直接拒絕不再跑
   * Runner」。**streak 只在這個方法內增減**:pass 時歸零,fail 時 +1,達上限
   * 時直接短路(不呼叫 `runAcceptance()`),見 class 頂端
   * `MAX_CONSECUTIVE_ACCEPTANCE_FAILURES`/`acceptanceFailureStreak` 註解。
   */
  private async applyAcceptanceRunGate(task: Task): Promise<ReportStatusOutcome> {
    const streak = this.acceptanceFailureStreak.get(task.id) ?? 0;
    if (streak >= MAX_CONSECUTIVE_ACCEPTANCE_FAILURES) {
      return {
        updated: false,
        skippedReason:
          `此任務的機器驗收已連續失敗 ${streak} 次,為避免無謂消耗資源(每次驗收都有真實成本),` +
          `已停止自動重跑驗收,任務維持 in-progress。請等待人類檢查程式碼或調整/移除驗收條件後再處理` +
          `(人類可透過 task.runAcceptance 手動重新確認,或直接以 task.updateStatus 轉入 review)。`,
      };
    }

    let result: AcceptanceResult;
    try {
      result = await this.runAcceptance(task.id);
    } catch (err) {
      // AcceptanceRunner 的併發鎖(同一任務已有一次驗收在執行中)—— 這不是
      // 「驗收失敗」,不計入連續失敗次數,原樣回報讓 agent 知道稍後再試。
      return {
        updated: false,
        skippedReason: `驗收目前正在執行中,請稍候再試(${err instanceof Error ? err.message : String(err)})`,
      };
    }

    if (result.passed) {
      this.acceptanceFailureStreak.delete(task.id);
      const updated = await this.updateStatus(task.id, "review");
      return { updated: true, fromStatus: task.status, toStatus: updated.status };
    }

    const newStreak = streak + 1;
    this.acceptanceFailureStreak.set(task.id, newStreak);
    const message = buildAcceptanceFailureMessage(result);
    if (newStreak >= MAX_CONSECUTIVE_ACCEPTANCE_FAILURES) {
      await this.escalateForHumanReview(task, "acceptance-failure-streak");
      return {
        updated: false,
        skippedReason: `${message} 已連續失敗 ${newStreak} 次,之後將不再自動重跑驗收,已通知人類介入。`,
      };
    }
    return { updated: false, skippedReason: message };
  }

  /**
   * S5 L4 §1.2「無 acceptance → 人判」:任務維持 in-progress、設
   * `awaitingHumanReview`,發 escalation(走 S1 底座 + S11 通知),等人類經
   * `task.approveReview` 核可。**無人值守時不逾時拒絕**——這裡完全不設置任何
   * 計時器,一直等,由 S3b 的 T1/T2(WaitingWatchdog)兜底(比照 S11 §4 的
   * 既有語意)。已經在等待中的重複請求不重複 escalate(避免同一任務洗版通知)。
   */
  private async applyHumanReviewGate(task: Task): Promise<ReportStatusOutcome> {
    if (task.awaitingHumanReview) {
      return {
        updated: false,
        skippedReason: "此任務已經在等待人類核可進入 review,不需要重複請求;你可以繼續補充,或等待人類處理。",
      };
    }
    const updated: Task = { ...task, awaitingHumanReview: true, updatedAt: Date.now() };
    await this.db.update(tasksTable).set(taskToRow(updated)).where(eq(tasksTable.id, task.id)).run();
    this.emit("task-updated", updated);
    await this.escalateForHumanReview(updated, "no-acceptance");
    return {
      updated: false,
      skippedReason: "此任務未定義機器驗收條件,已請求人類核可。你可以繼續補充或等待。",
    };
  }

  /** S5:走 S1 的 Enforcement 底座(Notifier)升級給人類,見 class 頂端
   *  `notifier` 欄位註解。**盡力而為、不拋錯**——通知失敗不該讓「已經正確
   *  設定 awaitingHumanReview」這件事回頭失敗,只記警告。 */
  private async escalateForHumanReview(
    task: Task,
    reason: "no-acceptance" | "acceptance-failure-streak",
  ): Promise<void> {
    if (!this.notifier) return; // 理論上不會發生,見 index.ts 的 setNotifier() 呼叫點。
    try {
      await this.notifier.deliver({
        kind: "task-review",
        taskId: task.id,
        teamId: task.teamId,
        taskTitle: task.title,
        reason,
        ts: Date.now(),
      });
    } catch (err) {
      console.error(
        `[task-service] 任務 ${task.id} 的「等待人類核可」通知送達失敗(不影響 awaitingHumanReview 已經設定這件事): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /**
   * S5(dispose-gate)新增:人類核可一個「無 acceptance(或連續驗收失敗)、
   * 正在等待人類核可」的任務,真正轉進 review(見 gateway 的
   * `task.approveReview`)。只有 `awaitingHumanReview === true` 的任務能呼叫
   * ——這防止對一個根本沒有卡在這道閘上的任務誤呼叫,產生「核可了什麼」語意
   * 不清的情況。清掉旗標後委派給既有的 `updateStatus()`(沿用同一套合法轉換
   * 檢查與 task-updated 推播,不重複實作狀態轉換邏輯)。
   */
  async approveReview(taskId: string): Promise<Task> {
    const task = await this.mustGetTask(taskId);
    if (!task.awaitingHumanReview) {
      throw new DeskmonyError(
        "task.notAwaitingReview",
        { taskId: task.id },
        `任務 ${task.id} 目前沒有在等待人類核可進入 review(awaitingHumanReview=false)`,
      );
    }
    const cleared: Task = { ...task, awaitingHumanReview: false, updatedAt: Date.now() };
    await this.db.update(tasksTable).set(taskToRow(cleared)).where(eq(tasksTable.id, task.id)).run();
    return this.updateStatus(taskId, "review");
  }

  private async mustGetTask(taskId: string): Promise<Task> {
    const task = await this.getTask(taskId);
    if (!task) {
      throw new DeskmonyError(ErrorCodes.ENTITY_NOT_FOUND, { entityType: "task", id: taskId }, `找不到任務: ${taskId}`);
    }
    return task;
  }
}

/**
 * S5 L4 §1.3:「回給 agent 的錯誤必須可理解」——用最後一條(即真正失敗的那條,
 * 依 AcceptanceRunner §3「前一條非 0 就立即停止」的保證,`perCommand` 陣列的
 * 最後一筆就是失敗者)指令的 exit code/是否逾時 + outputTail 組成人類可讀訊息,
 * 格式對應 dispose-gate-and-lead_detail.md §1.3 給的範例文案。
 */
function buildAcceptanceFailureMessage(result: AcceptanceResult): string {
  const last = result.perCommand[result.perCommand.length - 1];
  if (!last) {
    return `驗收未通過(${result.skippedReason ?? "沒有任何指令被執行"})。任務維持 in-progress。`;
  }
  const exitDesc = last.timedOut ? "逾時" : `exit ${last.exitCode}`;
  return `驗收未通過(\`${last.command}\` ${exitDesc})。任務維持 in-progress。輸出末段:\n${last.outputTail}`;
}

function rowToTask(row: typeof tasksTable.$inferSelect): Task {
  return {
    id: row.id,
    teamId: row.teamId,
    title: row.title,
    description: row.description ?? undefined,
    status: row.status as TaskStatus,
    assigneeMemberId: row.assigneeMemberId ?? undefined,
    workspaceId: row.workspaceId ?? undefined,
    blockedFrom: (row.blockedFrom as TaskStatus | null) ?? undefined,
    // S4:acceptance 存成 JSON 字串(比照 agent_profiles 巢狀物件欄位的既有
    // 慣例),row.acceptance 為 null/未設定時整個欄位是 undefined。
    acceptance: row.acceptance ? (JSON.parse(row.acceptance) as TaskAcceptance) : undefined,
    // S5:0/1 → boolean,比照 team-manager.ts 的 canInterrupt 既有慣例。
    awaitingHumanReview: Boolean(row.awaitingHumanReview),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function taskToRow(task: Task): typeof tasksTable.$inferInsert {
  return {
    id: task.id,
    teamId: task.teamId,
    title: task.title,
    description: task.description ?? null,
    status: task.status,
    assigneeMemberId: task.assigneeMemberId ?? null,
    workspaceId: task.workspaceId ?? null,
    blockedFrom: task.blockedFrom ?? null,
    acceptance: task.acceptance ? JSON.stringify(task.acceptance) : null,
    awaitingHumanReview: task.awaitingHumanReview ? 1 : 0,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}
