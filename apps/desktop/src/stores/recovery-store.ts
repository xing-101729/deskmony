import { create } from "zustand";
import {
  type RecoveryGitStatusResult,
  type RecoverySessionInfo,
  RecoveryAbandonResultSchema,
  RecoveryGitStatusResultSchema,
  RecoveryListResultSchema,
  RecoveryResolveDirtyWorktreeResultSchema,
  RecoverySessionResultSchema,
} from "@deskmony/shared";
import { client } from "./session-store.js";

/**
 * recovery-store(S6:崩潰復原):`recovery.*` 系列 gateway method 的狀態,獨立
 * 於 session-store/team-store/task-store 之外,比照那幾個 store 的既有慣例
 * ——共用同一條 WS 連線(`client`),各自獨立 subscribe `onPush`,不互相依賴
 * 對方的 store 狀態。
 *
 * §5.4「入口是常駐提示條,不是強制彈窗」:`sessions.length > 0` 是 App.tsx
 * 常駐提示條的唯一判斷依據——這個 store 不自己決定要不要彈窗,純粹提供資料,
 * UI 層決定呈現方式。
 */
interface RecoveryStoreState {
  sessions: RecoverySessionInfo[];
  loading: boolean;
  initialized: boolean;

  init: () => void;
  refresh: () => Promise<void>;
  continueSession: (sessionId: string) => Promise<void>;
  takeover: (sessionId: string) => Promise<void>;
  rerun: (sessionId: string) => Promise<void>;
  abandon: (sessionId: string) => Promise<void>;
  gitStatus: (sessionId: string) => Promise<RecoveryGitStatusResult>;
  resolveDirtyWorktree: (sessionId: string, action: "keep" | "discard", confirmDiscard?: boolean) => Promise<void>;
}

export const useRecoveryStore = create<RecoveryStoreState>((set, get) => ({
  sessions: [],
  loading: false,
  initialized: false,

  init: () => {
    if (get().initialized) return;
    set({ initialized: true });
    // 沒有專屬的 "recovery-*" push channel(見 packages/shared/src/gateway.ts
    // 的既有 ServerPushSchema——這輪刻意不新增,因為 `session-updated`/
    // `session-list-updated` 已經涵蓋所有會改變 `interrupted` 集合的動作:
    // `continueSession`/`abandon` 都會 emit "session-updated",
    // `takeover`/`rerun` 建立新 session 會 emit "session-list-updated")。
    // 收到任一個就重新拉一次完整清單。
    client.onPush((push) => {
      if (push.channel === "session-updated" || push.channel === "session-list-updated") {
        void get().refresh();
      }
    });
    void get().refresh();
  },

  refresh: async () => {
    set({ loading: true });
    try {
      const raw = await client.call("recovery.list", {});
      const { sessions } = RecoveryListResultSchema.parse(raw);
      set({ sessions });
    } catch {
      // 尚未連線/RPC 失敗:保留舊值,不阻塞畫面(同其餘 store 的既有慣例)。
    } finally {
      set({ loading: false });
    }
  },

  continueSession: async (sessionId) => {
    const raw = await client.call("recovery.continue", { sessionId });
    RecoverySessionResultSchema.parse(raw);
    await get().refresh();
  },

  takeover: async (sessionId) => {
    const raw = await client.call("recovery.takeover", { sessionId });
    RecoverySessionResultSchema.parse(raw);
    await get().refresh();
  },

  rerun: async (sessionId) => {
    const raw = await client.call("recovery.rerun", { sessionId });
    RecoverySessionResultSchema.parse(raw);
    await get().refresh();
  },

  abandon: async (sessionId) => {
    const raw = await client.call("recovery.abandon", { sessionId });
    RecoveryAbandonResultSchema.parse(raw);
    await get().refresh();
  },

  gitStatus: async (sessionId) => {
    const raw = await client.call("recovery.gitStatus", { sessionId });
    return RecoveryGitStatusResultSchema.parse(raw);
  },

  resolveDirtyWorktree: async (sessionId, action, confirmDiscard) => {
    const raw = await client.call("recovery.resolveDirtyWorktree", { sessionId, action, confirmDiscard });
    RecoveryResolveDirtyWorktreeResultSchema.parse(raw);
    await get().refresh();
  },
}));
