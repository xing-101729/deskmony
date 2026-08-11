import { create } from "zustand";
import {
  type AddTeamMemberInput,
  type CreateTeamInput,
  type MessagePriority,
  type TeamMessage,
  type TeamWithMembers,
  type TeammateInfo,
  MessageGetContextBudgetResultSchema,
  MessageSendResultSchema,
  TeamAddMemberResultSchema,
  TeamCreateResultSchema,
  TeamListResultSchema,
  TeamMessagesResultSchema,
  TeamTeammatesResultSchema,
} from "@deskmony/shared";
import { client } from "./session-store.js";

/**
 * team-store(M3 Round B):團隊管理 + 團隊群聊視圖共用的狀態,獨立於
 * session-store 之外(對應不同的資料維度 —— session-store 管的是單一
 * session 的聊天時間軸,這裡管的是整個 team 的成員清單與群聊訊息流)。
 *
 * 共用同一條 WS 連線(見 session-store.ts 匯出的 `client`),但各自獨立
 * subscribe `onPush`,不互相依賴對方的 store 狀態。
 */
/** S2(message-budget):`message.getContextBudget` 的回應快取,見
 *  `MessageBus.getContextBudgetStatus()`。 */
interface ContextBudgetStatus {
  count: number;
  max: number;
  tripped: boolean;
}

interface TeamStoreState {
  teams: TeamWithMembers[];
  currentTeamId: string | null;
  messagesByTeam: Record<string, TeamMessage[]>;
  teammatesByTeam: Record<string, TeammateInfo[]>;
  /** S2:contextId -> 目前額度用量(團隊群聊視圖顯示「context 與額度餘量;
   *  trip 狀態」用,見 docs/LAYER-4-detail-design/message-budget_detail.md §7)。 */
  contextBudgets: Record<string, ContextBudgetStatus>;
  initialized: boolean;

  init: () => void;
  refreshTeams: () => Promise<void>;
  createTeam: (input: CreateTeamInput) => Promise<void>;
  addMember: (input: AddTeamMemberInput) => Promise<void>;
  removeMember: (teamId: string, memberId: string) => Promise<void>;
  selectTeam: (teamId: string) => Promise<void>;
  refreshTeammates: (teamId: string) => Promise<void>;
  sendTeamMessage: (input: {
    teamId: string;
    to: string;
    content: string;
    priority?: MessagePriority;
    fromName?: string;
  }) => Promise<void>;
  /** S2:查詢並快取一個 contextId 目前的訊息額度狀態;"legacy"(不參與預算
   *  計算的訊息)刻意不查,呼叫端(TeamChatView)本來就會先過濾掉。 */
  refreshContextBudget: (contextId: string) => Promise<void>;
}

export const useTeamStore = create<TeamStoreState>((set, get) => ({
  teams: [],
  currentTeamId: null,
  messagesByTeam: {},
  teammatesByTeam: {},
  contextBudgets: {},
  initialized: false,

  init: () => {
    if (get().initialized) return;
    set({ initialized: true });

    client.onPush((push) => {
      if (push.channel === "team-message") {
        const message = push.payload as TeamMessage;
        set((state) => {
          const existing = state.messagesByTeam[message.teamId] ?? [];
          if (existing.some((m) => m.id === message.id)) return {};
          return {
            messagesByTeam: { ...state.messagesByTeam, [message.teamId]: [...existing, message] },
          };
        });
      } else if (push.channel === "session-updated" || push.channel === "session-list-updated") {
        // 成員 session 狀態可能因此改變(idle/busy/... 或新建立/刪除),
        // 重新整理目前正在檢視的 team 的成員狀態。
        const teamId = get().currentTeamId;
        if (teamId) void get().refreshTeammates(teamId);
      }
    });

    void get().refreshTeams();
  },

  refreshTeams: async () => {
    const raw = await client.call("team.list", {});
    const { teams } = TeamListResultSchema.parse(raw);
    set({ teams });
  },

  createTeam: async (input) => {
    const raw = await client.call("team.create", input);
    const { team } = TeamCreateResultSchema.parse(raw);
    await get().refreshTeams();
    set({ currentTeamId: team.id });
    await get().selectTeam(team.id);
  },

  addMember: async (input) => {
    const raw = await client.call("team.addMember", input);
    TeamAddMemberResultSchema.parse(raw);
    await get().refreshTeams();
    await get().refreshTeammates(input.teamId);
  },

  removeMember: async (teamId, memberId) => {
    await client.call("team.removeMember", { teamId, memberId });
    await get().refreshTeams();
    await get().refreshTeammates(teamId);
  },

  selectTeam: async (teamId) => {
    set({ currentTeamId: teamId });
    const raw = await client.call("team.messages", { teamId });
    const { messages } = TeamMessagesResultSchema.parse(raw);
    set((state) => ({ messagesByTeam: { ...state.messagesByTeam, [teamId]: messages } }));
    await get().refreshTeammates(teamId);
  },

  refreshTeammates: async (teamId) => {
    const raw = await client.call("team.teammates", { teamId });
    const { teammates } = TeamTeammatesResultSchema.parse(raw);
    set((state) => ({ teammatesByTeam: { ...state.teammatesByTeam, [teamId]: teammates } }));
  },

  sendTeamMessage: async (input) => {
    const raw = await client.call("message.send", input);
    // 訊息本身會透過 "team-message" 推播抵達(persistAndPush 在
    // deliverToMember 之前就 emit,見 apps/core/src/bus/message-bus.ts),
    // 這裡解析回應只是為了讓呼叫端(表單送出當下)能立即拿到錯誤或降級提示,
    // 不需要手動把訊息塞進 messagesByTeam(避免與推播重複、順序不一致)。
    MessageSendResultSchema.parse(raw);
  },

  refreshContextBudget: async (contextId) => {
    if (contextId === "legacy") return;
    const raw = await client.call("message.getContextBudget", { contextId });
    const status = MessageGetContextBudgetResultSchema.parse(raw);
    set((state) => ({
      contextBudgets: {
        ...state.contextBudgets,
        [contextId]: { count: status.count, max: status.max, tripped: status.tripped },
      },
    }));
  },
}));
