import {
  DeskmonyError,
  ErrorCodes,
  type CreateSessionInput,
  type RecoveryGitStatusResult,
  type RecoveryResolveDirtyWorktreeInput,
  type RecoveryResolveDirtyWorktreeResult,
  type RecoverySessionInfo,
  type Session,
  type Task,
  type Workspace,
} from "@deskmony/shared";
import type { SessionManager } from "../session/session-manager.js";
import type { ProfileStore } from "../profiles.js";
import type { TeamManager } from "../team/team-manager.js";
import type { TaskService } from "../tasks/task-service.js";
import type { WorkspaceManager } from "../workspace/workspace-manager.js";

/**
 * RecoveryService(S6:崩潰復原,見
 * docs/LAYER-4-detail-design/crash-recovery_detail.md §5)。
 *
 * 職責:組裝復原視圖需要的資料(§5.1)、執行人類選擇的四種分流動作(§3.1/
 * §5.2「繼續 / 接手 / 重跑 / 放棄」)。**這是應用層的組合邏輯**,不擁有任何
 * 狀態本身——實際的 session/worktree/任務操作都委派給既有的
 * `SessionManager`/`WorkspaceManager`/`TaskService`/`TeamManager`,這裡只負責
 * 串起來(同一種分層方式見 `MessageBus`/`CostGovernor` 對既有模組的組合)。
 *
 * **D3(明令禁止自動續接)在這裡的落實**:五個方法(`list`/`continueSession`/
 * `takeover`/`rerun`/`abandon`)全部要求呼叫端明確指定 `sessionId` 並主動呼叫
 * ——這個類別本身完全沒有任何背景計時器/自動觸發邏輯,**人不點,什麼都不會
 * 發生**。
 *
 * ---- 「session ↔ team member ↔ task」的反查(已知限制,見最終報告)----
 *
 * `SessionManager` 的 `memberSessions`/`sessionMembers`(session 建立時是哪個
 * team member)**只存在記憶體**,core 重啟後(啟動對帳跑完時)這個對應已經
 * 遺失——`sessions` 表本身沒有任何欄位記錄「這是哪個 team member 的
 * session」。這裡改用 `sessions.agentProfileId`(有持久化)反查
 * `TeamManager.findMemberByAgentProfileId()`,再查該 member 目前指派的任務
 * (`TaskService.getActiveTaskForMember()`)——這是一個**盡力而為的啟發式
 * 推論**(假設一個 agentProfileId 只被一個 team member 引用),不是 schema
 * 層級的保證,也不適用於「不屬於任何 team 的 ad-hoc session」(這種 session
 * 在復原視圖裡會顯示,但沒有 `task`/`workspace` 欄位)。
 */
export class RecoveryService {
  constructor(
    private readonly sessionManager: SessionManager,
    private readonly profiles: ProfileStore,
    private readonly teamManager: TeamManager,
    private readonly taskService: TaskService,
    private readonly workspaceManager: WorkspaceManager,
  ) {}

  /** §5.1:復原視圖的資料來源。 */
  async list(): Promise<RecoverySessionInfo[]> {
    const sessions = await this.sessionManager.listInterruptedSessions();
    const results: RecoverySessionInfo[] = [];
    for (const session of sessions) {
      const { task, workspace } = await this.resolveContext(session);
      const profile = await this.profiles.get(session.agentProfileId);

      let workspaceInfo: RecoverySessionInfo["workspace"];
      if (workspace) {
        const missing = !this.workspaceManager.worktreeExists(workspace);
        const hadUncommittedChanges = missing ? false : await this.workspaceManager.isDirty(workspace).catch(() => false);
        workspaceInfo = {
          workspaceId: workspace.id,
          worktreePath: workspace.worktreePath,
          branch: workspace.branch,
          missing,
          hadUncommittedChanges,
        };
      }

      results.push({
        sessionId: session.id,
        sessionTitle: session.title,
        profileName: profile?.name,
        status: "interrupted",
        interruptedAt: session.interruptedAt,
        lastSeenAt: session.lastSeenAt,
        task: task ? { id: task.id, title: task.title, status: task.status } : undefined,
        workspace: workspaceInfo,
        canContinue: computeCanContinue(session),
      });
    }
    return results;
  }

  /** §4:「繼續(保有記憶)」——直接委派給 `SessionManager.continueSession()`,那裡有完整的前置檢查。 */
  async continueSession(sessionId: string): Promise<Session> {
    return this.sessionManager.continueSession(sessionId);
  }

  /**
   * §4.2:「接手(讀摘要重啟)」——組出摘要(只讀 DB + git,不呼叫 LLM,見
   * `buildTakeoverSummary()`),開一個全新 session 並把摘要當作第一則 prompt
   * 送出,再把舊的中斷 session 收尾成 `closed`(離開復原視圖——它已經被人類
   * 處理過了)。
   */
  async takeover(sessionId: string): Promise<Session> {
    const session = await this.mustGetInterrupted(sessionId);
    const { task, workspace } = await this.resolveContext(session);
    const member = await this.teamManager.findMemberByAgentProfileId(session.agentProfileId);
    const summary = await this.buildTakeoverSummary(session, task, workspace);

    const input: CreateSessionInput = {
      title: `${session.title}(接手)`,
      agentProfileId: session.agentProfileId,
      workingDir: session.workingDir,
      teamMemberId: member?.id,
    };
    const newSession = await this.sessionManager.takeoverWithSummary(input, summary);
    await this.sessionManager.abandonInterruptedSession(sessionId);
    return newSession;
  }

  /**
   * §3.1/§5.2:「重跑」——要求 worktree(若有)目前必須乾淨,否則直接拋出
   * 明確錯誤(絕不默默在髒 worktree 上重跑),引導呼叫端先用
   * `gitStatus()`/`resolveDirtyWorktree()` 處理。開一個全新 session(**不**
   * 注入摘要——與「接手」的差異:重跑是全新嘗試,不是接續半成品),再把舊的
   * 中斷 session 收尾成 `closed`。
   */
  async rerun(sessionId: string): Promise<Session> {
    const session = await this.mustGetInterrupted(sessionId);
    const { workspace } = await this.resolveContext(session);

    if (workspace) {
      if (!this.workspaceManager.worktreeExists(workspace)) {
        throw new DeskmonyError(
          ErrorCodes.RECOVERY_WORKTREE_LOST,
          { worktreePath: workspace.worktreePath },
          `worktree 已遺失(${workspace.worktreePath}),無法重跑,請改用「放棄」`,
        );
      }
      const dirty = await this.workspaceManager.isDirty(workspace);
      if (dirty) {
        throw new DeskmonyError(
          "recovery.worktreeDirty",
          { worktreePath: workspace.worktreePath },
          `worktree(${workspace.worktreePath})有未提交的變更,請先呼叫「檢查變更」查看 diff,並選擇「保留」(建 wip 分支)或「丟棄」處理乾淨後再重跑——絕不默默在髒 worktree 上重跑`,
        );
      }
    }

    const member = await this.teamManager.findMemberByAgentProfileId(session.agentProfileId);
    const newSession = await this.sessionManager.createSession({
      title: `${session.title}(重跑)`,
      agentProfileId: session.agentProfileId,
      workingDir: session.workingDir,
      teamMemberId: member?.id,
    });
    await this.sessionManager.abandonInterruptedSession(sessionId);
    return newSession;
  }

  /** §5.2:「放棄」——session 標 `closed`;worktree/任務一律保留(同 S3b T2「回收 ≠ 丟棄」)。 */
  async abandon(sessionId: string): Promise<void> {
    await this.sessionManager.abandonInterruptedSession(sessionId);
  }

  /**
   * §5.2/§5.3:查看 git 狀態——一般情況查 worktree(給「重跑」前的 diff 檢視
   * 用);`task.status === "merging"` 時改查 `baseDir`(§5.3「崩潰於合併中」的
   * 「檢查 git 狀態」,merge 是在 baseDir 執行的,不是 worktree)。
   */
  async gitStatus(sessionId: string): Promise<RecoveryGitStatusResult> {
    const session = await this.mustGetInterrupted(sessionId);
    const { task, workspace } = await this.resolveContext(session);
    if (!workspace) {
      throw new DeskmonyError(
        "recovery.sessionMissingWorkspace",
        { sessionId },
        `session ${sessionId} 沒有綁定 workspace,沒有 git 狀態可查`,
      );
    }
    const target: "worktree" | "baseDir" = task?.status === "merging" ? "baseDir" : "worktree";
    const dir = target === "baseDir" ? workspace.baseDir : workspace.worktreePath;
    if (target === "worktree" && !this.workspaceManager.worktreeExists(workspace)) {
      throw new DeskmonyError(
        ErrorCodes.RECOVERY_WORKTREE_LOST,
        { worktreePath: workspace.worktreePath },
        `worktree 已遺失(${workspace.worktreePath})`,
      );
    }
    const { status, diff } = await this.workspaceManager.statusAndDiff(dir);
    return { target, status, diff };
  }

  /** §5.2:「重跑」前對髒 worktree 的強制處理——保留(wip 分支)或丟棄(需二次確認)。 */
  async resolveDirtyWorktree(input: RecoveryResolveDirtyWorktreeInput): Promise<RecoveryResolveDirtyWorktreeResult> {
    const session = await this.mustGetInterrupted(input.sessionId);
    const { task, workspace } = await this.resolveContext(session);
    if (!workspace) {
      throw new DeskmonyError(
        "recovery.sessionMissingWorkspace",
        { sessionId: input.sessionId },
        `session ${input.sessionId} 沒有綁定 workspace`,
      );
    }
    if (!this.workspaceManager.worktreeExists(workspace)) {
      throw new DeskmonyError(
        ErrorCodes.RECOVERY_WORKTREE_LOST,
        { worktreePath: workspace.worktreePath },
        `worktree 已遺失(${workspace.worktreePath})`,
      );
    }

    if (input.action === "keep") {
      const wipBranch = `wip/recovery-${task?.id ?? session.id}-${formatWipTimestamp(Date.now())}`;
      await this.workspaceManager.commitDirtyToWipBranch(workspace, wipBranch);
      return { ok: true, action: "keep", wipBranch };
    }

    // action === "discard":需要明確二次確認,這個動作會永久刪除未 commit 的變更。
    if (!input.confirmDiscard) {
      throw new DeskmonyError(
        ErrorCodes.RECOVERY_DISCARD_CONFIRM_REQUIRED,
        undefined,
        "丟棄變更需要明確二次確認(confirmDiscard: true)——這個動作會永久刪除 worktree 內未提交的變更,不可還原",
      );
    }
    await this.workspaceManager.discardDirty(workspace);
    return { ok: true, action: "discard" };
  }

  /** 見類別頂端「session ↔ team member ↔ task 的反查」說明。 */
  private async resolveContext(session: Session): Promise<{ task?: Task; workspace?: Workspace }> {
    const member = await this.teamManager.findMemberByAgentProfileId(session.agentProfileId);
    if (!member) return {};
    const task = await this.taskService.getActiveTaskForMember(member.id);
    if (!task?.workspaceId) return { task };
    const workspace = await this.workspaceManager.getWorkspace(task.workspaceId);
    return { task, workspace };
  }

  private async mustGetInterrupted(sessionId: string): Promise<Session> {
    const session = await this.sessionManager.getSession(sessionId);
    if (!session) {
      throw new DeskmonyError(ErrorCodes.ENTITY_NOT_FOUND, { entityType: "session", id: sessionId }, `找不到 session: ${sessionId}`);
    }
    if (session.status !== "interrupted") {
      throw new DeskmonyError(
        "recovery.sessionNotInterrupted",
        { sessionId, status: session.status },
        `session ${sessionId} 目前狀態是 "${session.status}",不是 "interrupted"`,
      );
    }
    return session;
  }

  /**
   * §4.2:「接手」注入的摘要內容——**只讀 DB 與 git,不呼叫 LLM**(避免復原
   * 本身變成一次昂貴的推論)。上限 4000 字元,超過時從最舊的對話開始截斷
   * (見 `buildSummaryText()`)。
   */
  private async buildTakeoverSummary(session: Session, task: Task | undefined, workspace: Workspace | undefined): Promise<string> {
    const headerLines: string[] = ["【前次工作中斷】"];
    headerLines.push(`任務:${task?.title ?? session.title}`);
    const interruptedAtText = session.interruptedAt ? new Date(session.interruptedAt).toISOString() : "未知";
    headerLines.push(`狀態:中斷於 ${session.status},時間 ${interruptedAtText}`);

    if (workspace) {
      try {
        const missing = !this.workspaceManager.worktreeExists(workspace);
        if (missing) {
          headerLines.push("已變更檔案:(worktree 已遺失,無法讀取)");
        } else {
          const { status } = await this.workspaceManager.statusAndDiff(workspace.worktreePath);
          const changedFiles = status
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
            .slice(0, 20);
          headerLines.push(`已變更檔案:${changedFiles.length > 0 ? changedFiles.join("; ") : "(無)"}`);
        }
      } catch (err) {
        headerLines.push(`已變更檔案:(讀取失敗: ${err instanceof Error ? err.message : String(err)})`);
      }
    }

    const history = await this.sessionManager.getHistory(session.id);
    const conversational = history.filter((m) => m.role === "user" || m.role === "assistant");
    // 「最多 3 輪」:取最後 6 則 user/assistant 訊息(粗略對應 3 輪一問一答,
    // 不保證嚴格配對——若最後幾則恰好都是同一角色連續出現,仍以「最後 6 則」
    // 為準,不特別偵測配對關係,保持實作單純)。
    const lastMessages = conversational.slice(-6);
    const conversationLines = lastMessages.map((m) => `${m.role === "user" ? "使用者" : "assistant"}: ${m.content}`);

    return buildSummaryText(headerLines.join("\n"), conversationLines);
  }
}

/** §4.1:目前唯一支援「繼續(保有記憶)」的後端——見查證結論。 */
function computeCanContinue(session: Session): boolean {
  return session.adapterType === "claude-agent-sdk" && Boolean(session.backendSessionId);
}

const SUMMARY_CHAR_LIMIT = 4000;

/** 上限 4000 字元,超過從最舊的對話開始截斷(§4.2)。 */
function buildSummaryText(header: string, conversationLines: string[]): string {
  let convo = [...conversationLines];
  const render = (): string => [header, "最後對話(最多 3 輪):", ...(convo.length > 0 ? convo : ["(無)"])].join("\n");
  let text = render();
  while (text.length > SUMMARY_CHAR_LIMIT && convo.length > 0) {
    convo = convo.slice(1);
    text = render();
  }
  if (text.length > SUMMARY_CHAR_LIMIT) {
    text = text.slice(0, SUMMARY_CHAR_LIMIT);
  }
  return text;
}

/** `wip/recovery-<taskId>-<yyyymmddHHmm>`(§5.2)。 */
function formatWipTimestamp(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}`;
}
