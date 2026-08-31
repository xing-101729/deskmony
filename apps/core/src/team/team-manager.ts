import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { NexusDb } from "@deskmony/db";
import {
  teamMembers as teamMembersTable,
  teamMessages as teamMessagesTable,
  teams as teamsTable,
} from "@deskmony/db";
import {
  deriveLifecycleFromRole,
  DeskmonyError,
  ErrorCodes,
  type AddTeamMemberInput,
  type CreateTeamInput,
  type Team,
  type TeamMember,
  type TeamWithMembers,
} from "@deskmony/shared";
import type { ProfileStore } from "../profiles.js";

/**
 * `deleteTeam()` 需要的最小外部能力。**刻意只宣告用得到的方法,不是整個
 * `TaskService`/`SessionManager`** —— `TaskService` 的建構子本來就依賴
 * `TeamManager`(見 task-service.ts),反向直接依賴會形成循環。這裡沿用這個
 * 專案既有的「先建構、事後用 setter 打破循環」手法(比照
 * `TaskService.setSessionControl()` / `MessageBus` 的 `setTeamBus()`),由
 * apps/core/src/index.ts 在三者都建好之後回頭注入。
 */
export interface TeamCascadePort {
  /** 這個 team 底下的所有任務(要逐一刪掉,連同各自的 git worktree)。 */
  listTasks(teamId: string): Promise<{ id: string; title: string }[]>;
  /** 走既有的刪除路徑——它同時處理 worktree 移除與 ephemeral session dispose,
   *  這裡刻意複用而不是自己重寫一份清理邏輯。 */
  deleteTask(taskId: string): Promise<{ hadUncommittedChanges: boolean }>;
  /** 某個成員目前綁定的 sessionId(用來統計「這次中止了幾個 agent」)。 */
  getSessionIdForMember(memberId: string): string | undefined;
  /** 冪等:找不到活躍 session 時視為已完成,不拋錯。 */
  disposeSessionForMember(memberId: string): Promise<void>;
}

/**
 * TeamManager(ARCHITECTURE.md 3.3 節「團隊 CRUD、AgentProfile...」的團隊/
 * 成員半部分;AgentProfile 本身仍由 ProfileStore 管理,見 M3 Round A)。
 *
 * 設計取捨:
 *  - `TeamMember` 只是「AgentProfile 在某個 team 裡的一個角色卡」——
 *    引用既有的 agentProfileId,不複製 profile 的 software/model 等設定。
 *  - `name` 在同一個 team 內必須唯一(MessageBus 用它比對 send_message 的
 *    to 與 @mention),`addMember()` 會做這個檢查。
 */
export class TeamManager {
  private cascade: TeamCascadePort | undefined;

  constructor(
    private readonly db: NexusDb,
    private readonly profiles: ProfileStore,
  ) {}

  /** 見 `TeamCascadePort`:apps/core/src/index.ts 在 TaskService/SessionManager
   *  都建好之後回頭注入。 */
  setCascade(cascade: TeamCascadePort): void {
    this.cascade = cascade;
  }

  async createTeam(input: CreateTeamInput): Promise<Team> {
    const now = Date.now();
    const team: Team = {
      id: randomUUID(),
      name: input.name,
      workingDir: input.workingDir,
      createdAt: now,
      updatedAt: now,
    };
    await this.db.insert(teamsTable).values(teamToRow(team)).run();
    return team;
  }

  async listTeams(): Promise<TeamWithMembers[]> {
    const teamRows = await this.db.select().from(teamsTable).all();
    const memberRows = await this.db.select().from(teamMembersTable).all();
    return teamRows.map((row) => {
      const team = rowToTeam(row);
      const members = memberRows.filter((m) => m.teamId === team.id).map(rowToMember);
      return { ...team, members };
    });
  }

  async getTeam(teamId: string): Promise<Team | undefined> {
    const rows = await this.db.select().from(teamsTable).where(eq(teamsTable.id, teamId)).all();
    return rows[0] ? rowToTeam(rows[0]) : undefined;
  }

  async addMember(input: AddTeamMemberInput): Promise<TeamMember> {
    const team = await this.getTeam(input.teamId);
    if (!team) {
      throw new DeskmonyError(
        ErrorCodes.ENTITY_NOT_FOUND,
        { entityType: "team", id: input.teamId },
        `找不到 team: ${input.teamId}`,
      );
    }
    const profile = await this.profiles.get(input.agentProfileId);
    if (!profile) {
      throw new DeskmonyError(
        ErrorCodes.ENTITY_NOT_FOUND,
        { entityType: "agentProfile", id: input.agentProfileId },
        `找不到 agent profile: ${input.agentProfileId}`,
      );
    }

    const now = Date.now();
    const role = input.role ?? profile.role;
    const member: TeamMember = {
      id: randomUUID(),
      teamId: input.teamId,
      agentProfileId: input.agentProfileId,
      name: input.name ?? profile.name,
      role,
      canInterrupt: input.canInterrupt ?? false,
      // S8(agent-lifecycle)L4 §1.1:明確提供時優先採用,否則由 role 推導
      // (「是否需隨時回應」,不是「是否需要記憶」,見 deriveLifecycleFromRole()
      // 註解與 docs/LAYER-3-hld/agent-lifecycle_hld.md §2.0)。
      lifecycle: input.lifecycle ?? deriveLifecycleFromRole(role),
      createdAt: now,
      updatedAt: now,
    };

    const nameTaken = await this.findMemberByName(input.teamId, member.name);
    if (nameTaken) {
      throw new DeskmonyError(
        "team.memberNameTaken",
        { teamName: team.name, memberName: member.name },
        `team "${team.name}" 內已存在同名成員: "${member.name}"(成員名在同一 team 內必須唯一,MessageBus 靠它比對 @mention)`,
      );
    }

    await this.db.insert(teamMembersTable).values(memberToRow(member)).run();
    return member;
  }

  /**
   * 刪除整個 team,連同成員、群聊訊息、任務。**破壞性操作**,順序刻意如下:
   *
   *   1. 先刪任務(走 `TaskService.deleteTask()`)——它會移除任務的 git
   *      worktree 並 dispose ephemeral member 的 session。**必須在刪成員之前**:
   *      `deleteTask()` 內部要靠 `task.assigneeMemberId` 反查成員才能
   *      dispose,成員先沒了就查不到,會留下孤兒 session(還在跑的 agent 沒人
   *      關得掉)。
   *   2. 再 dispose 每個成員**剩下的**活躍 session ——步驟 1 只處理得到有
   *      指派任務的 ephemeral 成員;長命成員(以及沒有任務的成員)的 session
   *      要在這裡收掉,否則同樣變成孤兒。
   *   3. 最後才刪 DB 記錄(訊息 → 成員 → team 本身)。
   *
   * **worktree 內有未提交變更不會中止刪除**,而是如實回報在
   * `tasksWithUncommittedChanges` —— 比照 `task.delete` 既有的
   * `hadUncommittedChanges` 語意:是否要為此收手是人類的判斷,UI 負責在按下
   * 刪除之前就問清楚,core 這層不自作主張。
   *
   * 未注入 `cascade`(理論上 apps/core/src/index.ts 一律會注入)時直接拒絕,
   * **不退化成「只刪 DB 記錄」**——那會留下還在跑的 agent 與磁碟上的 worktree,
   * 是比明確報錯更糟的半完成狀態(同 TaskService 對 `sessionControl` 的處理)。
   */
  async deleteTeam(teamId: string): Promise<{
    deletedTasks: number;
    deletedMembers: number;
    disposedSessions: number;
    tasksWithUncommittedChanges: string[];
  }> {
    const team = await this.getTeam(teamId);
    if (!team) {
      throw new DeskmonyError(
        ErrorCodes.ENTITY_NOT_FOUND,
        { entityType: "team", id: teamId },
        `找不到 team: ${teamId}`,
      );
    }
    if (!this.cascade) {
      throw new DeskmonyError(
        "team.cascadeNotReady",
        { teamId },
        "內部錯誤:TaskService/SessionManager 尚未就緒,無法安全刪除 team(避免留下還在跑的 agent 與殘留 worktree)",
      );
    }
    const cascade = this.cascade;

    // ---- 1. 任務(連同 worktree、ephemeral session)----
    const tasks = await cascade.listTasks(teamId);
    const tasksWithUncommittedChanges: string[] = [];
    let deletedTasks = 0;
    for (const task of tasks) {
      const { hadUncommittedChanges } = await cascade.deleteTask(task.id);
      deletedTasks += 1;
      if (hadUncommittedChanges) tasksWithUncommittedChanges.push(task.title);
    }

    // ---- 2. 成員剩下的活躍 session ----
    const members = await this.getTeamMembers(teamId);
    let disposedSessions = 0;
    for (const member of members) {
      if (cascade.getSessionIdForMember(member.id)) {
        await cascade.disposeSessionForMember(member.id);
        disposedSessions += 1;
      }
    }

    // ---- 3. DB 記錄 ----
    await this.db.delete(teamMessagesTable).where(eq(teamMessagesTable.teamId, teamId)).run();
    await this.db.delete(teamMembersTable).where(eq(teamMembersTable.teamId, teamId)).run();
    await this.db.delete(teamsTable).where(eq(teamsTable.id, teamId)).run();

    return { deletedTasks, deletedMembers: members.length, disposedSessions, tasksWithUncommittedChanges };
  }

  async removeMember(teamId: string, memberId: string): Promise<void> {
    await this.db
      .delete(teamMembersTable)
      .where(and(eq(teamMembersTable.teamId, teamId), eq(teamMembersTable.id, memberId)))
      .run();
  }

  async getMember(memberId: string): Promise<TeamMember | undefined> {
    const rows = await this.db
      .select()
      .from(teamMembersTable)
      .where(eq(teamMembersTable.id, memberId))
      .all();
    return rows[0] ? rowToMember(rows[0]) : undefined;
  }

  async getTeamMembers(teamId: string): Promise<TeamMember[]> {
    const rows = await this.db
      .select()
      .from(teamMembersTable)
      .where(eq(teamMembersTable.teamId, teamId))
      .all();
    return rows.map(rowToMember);
  }

  async findMemberByName(teamId: string, name: string): Promise<TeamMember | undefined> {
    const members = await this.getTeamMembers(teamId);
    return members.find((m) => m.name === name);
  }

  /**
   * S6(crash-recovery)新增:用 `agentProfileId` 反查 team member——啟動對帳
   * 後,`SessionManager` 的 `memberSessions`/`sessionMembers` 這兩個「session
   * ↔ team member」的對應**只存在記憶體**(見 session-manager.ts 的欄位註解),
   * core 重啟後這個關聯會遺失。復原視圖需要把一筆孤兒 session 關聯回它原本
   * 的任務,只能靠 `sessions.agentProfileId`(有持久化)反查對應的 team
   * member,再查該 member 目前指派的任務(`TaskService.getActiveTaskForMember()`)。
   *
   * **已知限制(自行判斷,已列入最終報告)**:schema 沒有強制「一個
   * agentProfileId 只能被一個 team member 引用」,這是盡力而為的啟發式推論
   * ——多筆符合時取第一筆。實務上 `TeamManagementDialog` 建立成員時一律綁定
   * 一個未被使用過的 profile,不構成問題,但這不是 schema 層級的保證。
   */
  async findMemberByAgentProfileId(agentProfileId: string): Promise<TeamMember | undefined> {
    const rows = await this.db
      .select()
      .from(teamMembersTable)
      .where(eq(teamMembersTable.agentProfileId, agentProfileId))
      .all();
    return rows[0] ? rowToMember(rows[0]) : undefined;
  }
}

function rowToTeam(row: typeof teamsTable.$inferSelect): Team {
  return {
    id: row.id,
    name: row.name,
    workingDir: row.workingDir ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function teamToRow(team: Team): typeof teamsTable.$inferInsert {
  return {
    id: team.id,
    name: team.name,
    workingDir: team.workingDir ?? null,
    createdAt: team.createdAt,
    updatedAt: team.updatedAt,
  };
}

function rowToMember(row: typeof teamMembersTable.$inferSelect): TeamMember {
  return {
    id: row.id,
    teamId: row.teamId,
    agentProfileId: row.agentProfileId,
    name: row.name,
    role: row.role,
    canInterrupt: Boolean(row.canInterrupt),
    lifecycle: (row.lifecycle as TeamMember["lifecycle"]) ?? "ephemeral",
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function memberToRow(member: TeamMember): typeof teamMembersTable.$inferInsert {
  return {
    id: member.id,
    teamId: member.teamId,
    agentProfileId: member.agentProfileId,
    name: member.name,
    role: member.role,
    canInterrupt: member.canInterrupt ? 1 : 0,
    lifecycle: member.lifecycle,
    createdAt: member.createdAt,
    updatedAt: member.updatedAt,
  };
}
