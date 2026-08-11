import { create } from "zustand";
import {
  type AcceptanceResult,
  type AssignTaskInput,
  type CreateTaskInput,
  type Task,
  type TaskAcceptance,
  type TaskStatus,
  type Workspace,
  TaskApproveReviewResultSchema,
  TaskAssignResultSchema,
  TaskCreateResultSchema,
  TaskDeleteResultSchema,
  TaskListResultSchema,
  TaskMergeResultSchema,
  TaskRunAcceptanceResultSchema,
  TaskSetAcceptanceResultSchema,
  TaskUpdateStatusResultSchema,
  WorkspaceGetResultSchema,
} from "@deskmony/shared";
import { client } from "./session-store.js";

/**
 * task-store(M4 Round B):任務看板(Kanban)用的狀態,獨立於 session-store /
 * team-store 之外(對應不同的資料維度 —— 這裡管的是每個 team 底下的任務清單
 * 與其綁定的 workspace)。共用同一條 WS 連線(見 session-store.ts 匯出的
 * `client`),各自獨立 subscribe `onPush`,不互相依賴對方的 store 狀態(比照
 * team-store.ts 的既有慣例)。
 */
interface TaskStoreState {
  tasksByTeam: Record<string, Task[]>;
  /** 依 Workspace.id 快取,任務卡片顯示分支名稱用(見 task.workspaceId)。 */
  workspacesById: Record<string, Workspace>;
  /**
   * S4(機器驗收閘,切片):每個任務最近一次 `task.runAcceptance` 的結果,依
   * taskId 快取。**純 ephemeral**(不落地,同 S3a 的 sessionUsage——reload
   * 歸零),見 acceptance-gate_detail.md §5「最近一次結果的 pass/fail 徽章
   * (ephemeral,同 S3a 不落地)」。
   */
  acceptanceResultsByTask: Record<string, AcceptanceResult>;
  /** 目前正在跑驗收的 taskId 集合(避免同一張卡片重複點擊送出併發請求,對應
   *  apps/core/src/tasks/acceptance-runner.ts 的 taskId 鎖——UI 端提前擋一次,
   *  core 端仍是最終把關,兩邊不衝突)。 */
  runningAcceptanceTaskIds: Set<string>;
  initialized: boolean;

  init: () => void;
  loadTasks: (teamId: string) => Promise<void>;
  createTask: (input: CreateTaskInput) => Promise<Task>;
  assignTask: (input: AssignTaskInput) => Promise<void>;
  updateStatus: (taskId: string, status: TaskStatus) => Promise<void>;
  /** 人類批准合併(task.merge):唯一真正觸發 git merge 的路徑,見
   * apps/core/src/tasks/task-service.ts 的 mergeAndComplete()。 */
  mergeTask: (taskId: string) => Promise<void>;
  deleteTask: (taskId: string) => Promise<{ hadUncommittedChanges: boolean }>;
  fetchWorkspace: (workspaceId: string) => Promise<Workspace | undefined>;
  /** S4:事後設定/清除一個既有任務的機器驗收條件(`task.setAcceptance`)。 */
  setAcceptance: (taskId: string, acceptance: TaskAcceptance | undefined) => Promise<Task>;
  /** S4:跑一個任務的機器驗收(`task.runAcceptance`),切片是諮詢性——回傳值
   *  由呼叫端自行決定要不要理會,這個方法本身不擋任何狀態轉換。 */
  runAcceptance: (taskId: string) => Promise<AcceptanceResult>;
  /** S5(dispose-gate):人類核可一個「沒有機器驗收條件(或連續驗收失敗)、
   *  正在等待人類核可」的任務,真正轉進 review(`task.approveReview`)。 */
  approveReview: (taskId: string) => Promise<Task>;
}

function upsertTask(list: Task[], task: Task): Task[] {
  const idx = list.findIndex((t) => t.id === task.id);
  if (idx === -1) return [...list, task];
  const next = [...list];
  next[idx] = task;
  return next;
}

export const useTaskStore = create<TaskStoreState>((set, get) => ({
  tasksByTeam: {},
  workspacesById: {},
  acceptanceResultsByTask: {},
  runningAcceptanceTaskIds: new Set(),
  initialized: false,

  init: () => {
    if (get().initialized) return;
    set({ initialized: true });

    client.onPush((push) => {
      if (push.channel === "task-updated") {
        const task = push.payload as Task;
        set((state) => ({
          tasksByTeam: {
            ...state.tasksByTeam,
            [task.teamId]: upsertTask(state.tasksByTeam[task.teamId] ?? [], task),
          },
        }));
        if (task.workspaceId) void get().fetchWorkspace(task.workspaceId);
      } else if (push.channel === "task-deleted") {
        const payload = push.payload as { id: string; teamId: string };
        set((state) => ({
          tasksByTeam: {
            ...state.tasksByTeam,
            [payload.teamId]: (state.tasksByTeam[payload.teamId] ?? []).filter((t) => t.id !== payload.id),
          },
        }));
      }
    });
  },

  loadTasks: async (teamId) => {
    const raw = await client.call("task.list", { teamId });
    const { tasks } = TaskListResultSchema.parse(raw);
    set((state) => ({ tasksByTeam: { ...state.tasksByTeam, [teamId]: tasks } }));
    for (const task of tasks) {
      if (task.workspaceId) void get().fetchWorkspace(task.workspaceId);
    }
  },

  createTask: async (input) => {
    const raw = await client.call("task.create", input);
    const { task } = TaskCreateResultSchema.parse(raw);
    // "task-updated" 推播也會補上同一筆(見 TaskService.createTask 的
    // this.emit),這裡直接先寫一份,讓呼叫端(表單送出當下)不用等推播往返。
    set((state) => ({
      tasksByTeam: { ...state.tasksByTeam, [task.teamId]: upsertTask(state.tasksByTeam[task.teamId] ?? [], task) },
    }));
    return task;
  },

  assignTask: async (input) => {
    const raw = await client.call("task.assign", input);
    const { task, workspace } = TaskAssignResultSchema.parse(raw);
    set((state) => ({
      tasksByTeam: { ...state.tasksByTeam, [task.teamId]: upsertTask(state.tasksByTeam[task.teamId] ?? [], task) },
      workspacesById: { ...state.workspacesById, [workspace.id]: workspace },
    }));
  },

  updateStatus: async (taskId, status) => {
    const raw = await client.call("task.updateStatus", { taskId, status });
    const { task } = TaskUpdateStatusResultSchema.parse(raw);
    set((state) => ({
      tasksByTeam: { ...state.tasksByTeam, [task.teamId]: upsertTask(state.tasksByTeam[task.teamId] ?? [], task) },
    }));
  },

  mergeTask: async (taskId) => {
    const raw = await client.call("task.merge", { taskId });
    const { task } = TaskMergeResultSchema.parse(raw);
    set((state) => ({
      tasksByTeam: { ...state.tasksByTeam, [task.teamId]: upsertTask(state.tasksByTeam[task.teamId] ?? [], task) },
    }));
  },

  deleteTask: async (taskId) => {
    const raw = await client.call("task.delete", { taskId });
    // "task-deleted" 推播會負責把它從 tasksByTeam 移除(避免這裡與推播重複
    // 處理、順序不一致,比照 team-store.ts sendTeamMessage 的既有慣例),這裡
    // 只解析回應,把 hadUncommittedChanges 回傳給呼叫端決定要不要顯示警告。
    return TaskDeleteResultSchema.parse(raw);
  },

  setAcceptance: async (taskId, acceptance) => {
    const raw = await client.call("task.setAcceptance", { taskId, acceptance });
    const { task } = TaskSetAcceptanceResultSchema.parse(raw);
    // "task-updated" 推播也會補上同一筆(見 TaskService.setAcceptance 的
    // this.emit),這裡直接先寫一份,比照 createTask/assignTask 的既有慣例。
    set((state) => ({
      tasksByTeam: { ...state.tasksByTeam, [task.teamId]: upsertTask(state.tasksByTeam[task.teamId] ?? [], task) },
    }));
    return task;
  },

  runAcceptance: async (taskId) => {
    set((state) => ({ runningAcceptanceTaskIds: new Set(state.runningAcceptanceTaskIds).add(taskId) }));
    try {
      const raw = await client.call("task.runAcceptance", { taskId });
      const { result } = TaskRunAcceptanceResultSchema.parse(raw);
      set((state) => ({
        acceptanceResultsByTask: { ...state.acceptanceResultsByTask, [taskId]: result },
      }));
      return result;
    } finally {
      set((state) => {
        const next = new Set(state.runningAcceptanceTaskIds);
        next.delete(taskId);
        return { runningAcceptanceTaskIds: next };
      });
    }
  },

  approveReview: async (taskId) => {
    const raw = await client.call("task.approveReview", { taskId });
    const { task } = TaskApproveReviewResultSchema.parse(raw);
    // "task-updated" 推播也會補上同一筆,這裡直接先寫一份,比照
    // createTask/assignTask/setAcceptance 的既有慣例。
    set((state) => ({
      tasksByTeam: { ...state.tasksByTeam, [task.teamId]: upsertTask(state.tasksByTeam[task.teamId] ?? [], task) },
    }));
    return task;
  },

  fetchWorkspace: async (workspaceId) => {
    const cached = get().workspacesById[workspaceId];
    if (cached) return cached;
    try {
      const raw = await client.call("workspace.get", { workspaceId });
      const { workspace } = WorkspaceGetResultSchema.parse(raw);
      set((state) => ({ workspacesById: { ...state.workspacesById, [workspaceId]: workspace } }));
      return workspace;
    } catch {
      return undefined;
    }
  },
}));
