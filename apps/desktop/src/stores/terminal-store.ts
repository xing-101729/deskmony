import { create } from "zustand";
import {
  TerminalAttachResultSchema,
  TerminalCreateResultSchema,
  TerminalListResultSchema,
  TerminalOutputPushSchema,
  TerminalUpdatedPushSchema,
  type TerminalAttachResult,
  type TerminalInfo,
  type TerminalOutputPush,
} from "@deskmony/shared";
import { client } from "./session-store.js";

/**
 * 右側面板 Terminal 分頁的狀態(2026-10-20,見 docs/LAYER-4-detail-design/side-panel_detail.md §P1.4)。
 *
 * - **終端清單**進 zustand(量小、要驅動分頁列的重新渲染)。
 * - **終端輸出**(`terminal-output` push)不進響應式 state:量大、高頻,比照 `session-store.ts` 的 `onTerminalData` 作法,
 *   用模組層級的 pub/sub(`onTerminalOutput`)讓每個 xterm 實例直接 imperative 寫入,不經過 React 的重新渲染。
 *   完整的歷史由 core 持有(512 KB 環狀緩衝,`terminal.attach` 取回),renderer 這邊不另外保留一份。
 */

// ---- 輸出 pub/sub ---------------------------------------------------------------------------------

type OutputListener = (push: TerminalOutputPush) => void;
const outputListeners = new Set<OutputListener>();

export function onTerminalOutput(listener: OutputListener): () => void {
  ensureTerminalSubscriptions();
  outputListeners.add(listener);
  return () => outputListeners.delete(listener);
}

// ---- store ----------------------------------------------------------------------------------------

interface TerminalState {
  /** 每個 session 目前的終端(只有 `loaded[sessionId]` 為 true 的才是完整清單)。 */
  terminalsBySession: Record<string, TerminalInfo[]>;
  loaded: Record<string, boolean>;
  activeBySession: Record<string, string>;
  /** 這個 session 正在開新終端(`terminal.create` 往返中)——自動建立與手動建立共用,避免同時開出兩個。 */
  creating: Record<string, boolean>;
  /** WS 重連一次就加一:每個掛著的 xterm 看到變化就 reset 並重新 attach(斷線期間的輸出 push 已遺失)。 */
  epoch: number;
  /** 要把鍵盤焦點交給哪個終端(新建立/使用者用快捷鍵叫出面板);xterm 實例拿到焦點後呼叫 `clearFocus()`。 */
  focusTerminalId: string | undefined;
  /** 最近一次建立/關閉終端失敗的原因(原樣的 Error,UI 用 `translateError()` 翻譯);`undefined` = 沒有。 */
  lastError: unknown;

  loadTerminals: (sessionId: string) => Promise<TerminalInfo[]>;
  createTerminal: (sessionId: string, size?: { cols: number; rows: number }) => Promise<TerminalInfo | undefined>;
  closeTerminal: (terminalId: string) => Promise<void>;
  /** 重新啟動 = 關掉舊的、在同一個 session 建新的(新的排在最後、成為目前分頁)。 */
  restartTerminal: (terminal: TerminalInfo, size?: { cols: number; rows: number }) => Promise<void>;
  setActive: (sessionId: string, terminalId: string) => void;
  requestFocus: (terminalId: string) => void;
  clearFocus: () => void;
  clearError: () => void;
  /** session 被刪除:丟掉它的所有終端狀態(core 那邊已一併關掉)。 */
  forgetSession: (sessionId: string) => void;
}

const DEFAULT_SIZE = { cols: 80, rows: 24 };

export const useTerminalStore = create<TerminalState>((set, get) => ({
  terminalsBySession: {},
  loaded: {},
  activeBySession: {},
  creating: {},
  epoch: 0,
  focusTerminalId: undefined,
  lastError: undefined,

  loadTerminals: async (sessionId) => {
    ensureTerminalSubscriptions();
    const raw = await client.call("terminal.list", { sessionId });
    const { terminals } = TerminalListResultSchema.parse(raw);
    set((state) => {
      const active = state.activeBySession[sessionId];
      return {
        terminalsBySession: { ...state.terminalsBySession, [sessionId]: terminals },
        loaded: { ...state.loaded, [sessionId]: true },
        activeBySession: {
          ...state.activeBySession,
          ...(terminals.length === 0
            ? {}
            : { [sessionId]: terminals.some((t) => t.id === active) ? active : terminals[terminals.length - 1].id }),
        },
      };
    });
    return terminals;
  },

  createTerminal: async (sessionId, size = DEFAULT_SIZE) => {
    ensureTerminalSubscriptions();
    // 同步先上鎖:自動建立(面板打開到 Terminal 分頁、清單是空的)與使用者手動建立可能在同一個 tick 觸發。
    if (get().creating[sessionId]) return undefined;
    set((state) => ({ creating: { ...state.creating, [sessionId]: true }, lastError: undefined }));
    try {
      // 先確保清單載入過:否則「新終端的 terminal-updated push」會因為這個 session 還沒載入而被忽略。
      if (!get().loaded[sessionId]) await get().loadTerminals(sessionId);
      const raw = await client.call("terminal.create", { sessionId, cols: size.cols, rows: size.rows });
      const { terminal } = TerminalCreateResultSchema.parse(raw);
      applyTerminalUpdate(terminal);
      set((state) => ({
        activeBySession: { ...state.activeBySession, [sessionId]: terminal.id },
        focusTerminalId: terminal.id,
      }));
      return terminal;
    } catch (err) {
      set({ lastError: err });
      throw err;
    } finally {
      set((state) => ({ creating: { ...state.creating, [sessionId]: false } }));
    }
  },

  closeTerminal: async (terminalId) => {
    try {
      await client.call("terminal.close", { terminalId });
    } catch (err) {
      // 已經不存在(例如別的 client 剛關掉)就當作成功,其餘照實顯示。
      if (!(err instanceof Error && "code" in err && (err as { code?: string }).code === "terminal.notFound")) {
        set({ lastError: err });
        throw err;
      }
    }
    // 先樂觀地移除;`terminal-updated`(closed)push 到達時 `applyTerminalUpdate` 是冪等的。
    applyTerminalUpdate({ id: terminalId, closed: true } as TerminalInfo);
  },

  restartTerminal: async (terminal, size) => {
    const { sessionId } = terminal;
    const index = (get().terminalsBySession[sessionId] ?? []).findIndex((t) => t.id === terminal.id);
    await get().closeTerminal(terminal.id);
    const created = await get().createTerminal(sessionId, size);
    if (!created || index < 0) return;
    // 「在同一位置建新的」:core 的清單依建立順序,新的會排在最後;分頁列的順序是 client 端的呈現,把新的搬回舊的位置
    // (重新載入清單時回到 core 的建立順序,不影響功能)。
    set((state) => {
      const list = state.terminalsBySession[sessionId];
      const fresh = list?.find((t) => t.id === created.id);
      if (!list || !fresh) return state;
      const others = list.filter((t) => t.id !== created.id);
      const at = Math.min(index, others.length);
      return { terminalsBySession: { ...state.terminalsBySession, [sessionId]: [...others.slice(0, at), fresh, ...others.slice(at)] } };
    });
  },

  setActive: (sessionId, terminalId) =>
    set((state) => ({ activeBySession: { ...state.activeBySession, [sessionId]: terminalId } })),
  requestFocus: (terminalId) => set({ focusTerminalId: terminalId }),
  clearFocus: () => set({ focusTerminalId: undefined }),
  clearError: () => set({ lastError: undefined }),

  forgetSession: (sessionId) =>
    set((state) => {
      const { [sessionId]: _t, ...terminalsBySession } = state.terminalsBySession;
      const { [sessionId]: _l, ...loaded } = state.loaded;
      const { [sessionId]: _a, ...activeBySession } = state.activeBySession;
      return { terminalsBySession, loaded, activeBySession };
    }),
}));

/** `terminal-updated` push(與樂觀更新共用):`closed` 的移除、其餘依 id 新增/取代。只處理已載入過清單的 session。 */
function applyTerminalUpdate(terminal: TerminalInfo): void {
  useTerminalStore.setState((state) => {
    // closed 的 push 只保證帶 id 與 sessionId;樂觀更新只有 id——兩種都要能找到它屬於哪個 session。
    const sessionId =
      terminal.sessionId ??
      Object.keys(state.terminalsBySession).find((sid) => state.terminalsBySession[sid].some((t) => t.id === terminal.id));
    if (!sessionId || !state.loaded[sessionId]) return state;
    const current = state.terminalsBySession[sessionId] ?? [];
    let next: TerminalInfo[];
    if (terminal.closed) {
      next = current.filter((t) => t.id !== terminal.id);
    } else if (current.some((t) => t.id === terminal.id)) {
      next = current.map((t) => (t.id === terminal.id ? terminal : t));
    } else {
      next = [...current, terminal];
    }
    if (next.length === current.length && !terminal.closed && next.every((t, i) => t === current[i])) return state;
    const active = state.activeBySession[sessionId];
    const activeStillThere = next.some((t) => t.id === active);
    const activeBySession = { ...state.activeBySession };
    if (!activeStillThere) {
      if (next.length > 0) activeBySession[sessionId] = next[next.length - 1].id;
      else delete activeBySession[sessionId];
    }
    return { terminalsBySession: { ...state.terminalsBySession, [sessionId]: next }, activeBySession };
  });
}

// ---- push 訂閱(整個 renderer 只訂一次)-----------------------------------------------------------

let subscribed = false;

/** 第一次用到終端時才訂閱(`client` 是 session-store 的 singleton,連線生命週期由 App 管理)。 */
export function ensureTerminalSubscriptions(): void {
  if (subscribed) return;
  subscribed = true;
  client.onPush((push) => {
    if (push.channel === "terminal-output") {
      const parsed = TerminalOutputPushSchema.safeParse(push.payload);
      if (!parsed.success) return;
      for (const listener of outputListeners) listener(parsed.data);
    } else if (push.channel === "terminal-updated") {
      const parsed = TerminalUpdatedPushSchema.safeParse(push.payload);
      if (parsed.success) applyTerminalUpdate(parsed.data.terminal);
    }
  });
  // 斷線期間 core 推播的輸出與狀態變化都已遺失:清單標成未載入、epoch 加一,掛著的 xterm 與 SidePanel 各自重新 attach/載入。
  client.onReconnected(() => {
    useTerminalStore.setState((state) => ({ loaded: {}, epoch: state.epoch + 1, creating: {} }));
  });
}

/** 一個 xterm 實例用:attach 並回傳結果(schema 驗證過)。 */
export async function attachTerminal(terminalId: string): Promise<TerminalAttachResult> {
  const raw = await client.call("terminal.attach", { terminalId });
  return TerminalAttachResultSchema.parse(raw);
}

/** 一個 xterm 實例用:送鍵盤輸入(超過 core 單次上限的貼上分段送)。 */
export async function sendTerminalInput(terminalId: string, data: string, chunkChars = 60_000): Promise<void> {
  for (let offset = 0; offset < data.length; offset += chunkChars) {
    await client.call("terminal.input", { terminalId, data: data.slice(offset, offset + chunkChars) });
  }
}

export async function resizeTerminal(terminalId: string, cols: number, rows: number): Promise<void> {
  await client.call("terminal.resize", { terminalId, cols, rows });
}
