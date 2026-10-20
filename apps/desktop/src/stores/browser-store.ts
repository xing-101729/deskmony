import { create } from "zustand";
import { browserPartitionForSession, isExternallyOpenableUrl } from "../../electron/browser-rules.js";

/**
 * 右側面板 Browser 分頁的狀態與動作(2026-10-20,見 docs/LAYER-4-detail-design/side-panel_detail.md §P3.2)。
 *
 * ## 為什麼 webview 不放在分頁元件裡
 *
 * `<webview>` 的 DOM 節點**一旦建立就不能搬家**(re-parent 會讓頁面重新載入、登入狀態與捲動位置全部重來),也不能因為切換分頁而條件式卸載。
 * 但 `SidePanel` 關著時回 `null`、切換 session 時以 `key` 重新掛載分頁——放在分頁元件裡的東西會跟著消失。所以:
 *  - webview 由 App 層的 `BrowserHost`(`views/panel/BrowserHost.tsx`,portal 到 `document.body`)持有,每個 session 一個,建立後從不搬動;
 *  - `BrowserTab` 只渲染一個**佔位 slot**,把 slot 的位置/大小報進這個 store(`setSlot`);
 *  - `BrowserHost` 用 `position: fixed` 把「目前 session」的 webview 疊到 slot 上,其餘的(以及 slot 不存在——面板關著、不在 Browser 分頁——時目前的)
 *    移到畫面外並保持固定尺寸。
 *
 * 這個 store 只放「畫面需要的狀態」;webview 元素本身(指令式操作:`loadURL`/`goBack`…)放在模組層級的 `elements` Map,不進 zustand。
 */

/** 這個 webview 的最小介面(Electron `WebviewTag` 實際用到的那一小塊;不 import electron 型別,以免 DOM 與 Node 的全域型別打架)。 */
export interface WebviewElement extends HTMLElement {
  src: string;
  loadURL(url: string): Promise<void>;
  goBack(): void;
  goForward(): void;
  reload(): void;
  stop(): void;
  canGoBack(): boolean;
  canGoForward(): boolean;
  getURL(): string;
  getTitle(): string;
  getWebContentsId(): number;
}

export interface SlotRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PageFailure {
  code: number;
  description: string;
  url: string;
}

export interface BrowserPageState {
  /** `dom-ready` 之後才能呼叫 webview 的方法(之前呼叫會拋錯)。 */
  ready: boolean;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  webContentsId: number | undefined;
  /** 主框架載入失敗(不含使用者/程式主動中止:`ERR_ABORTED`)。 */
  failure: PageFailure | undefined;
  /** 頁面的 render 行程當掉了。 */
  crashed: boolean;
}

const BLANK_PAGE: BrowserPageState = {
  ready: false,
  url: "",
  title: "",
  loading: false,
  canGoBack: false,
  canGoForward: false,
  webContentsId: undefined,
  failure: undefined,
  crashed: false,
};

interface BrowserStore {
  /** 已經建立 webview 的 session(依建立順序)——**只增不減**,除非 session 被刪除(`discard`)。 */
  created: string[];
  pages: Record<string, BrowserPageState>;
  /** Browser 分頁目前顯示的佔位 slot(面板關著/不在 Browser 分頁時是 `undefined`)。 */
  slot: { sessionId: string; rect: SlotRect } | undefined;
  /** 拖拉面板寬度時為真:webview 暫時不吃滑鼠事件(否則游標移到 guest 上,pointer capture 在跨行程時抓不住,拖拉會中斷)。 */
  pointerLock: boolean;

  /** 第一次打開某 session 的 Browser 分頁時才建立它的 webview(P3 規格)。 */
  ensure: (sessionId: string) => void;
  /** session 被刪除:移除它的 webview 與狀態,並清掉它的瀏覽器 partition(cookie/storage/快取)。 */
  discard: (sessionId: string) => void;
  setSlot: (slot: { sessionId: string; rect: SlotRect } | undefined) => void;
  setPointerLock: (locked: boolean) => void;
  patchPage: (sessionId: string, patch: Partial<BrowserPageState>) => void;
}

export const useBrowserStore = create<BrowserStore>((set, get) => ({
  created: [],
  pages: {},
  slot: undefined,
  pointerLock: false,

  ensure: (sessionId) => {
    if (get().created.includes(sessionId)) return;
    // session id 不是合法的 partition 名稱(正常是 UUID,不會發生)就不建立:不「清理」成別的名稱,以免兩個 session 共用登入狀態。
    if (browserPartitionForSession(sessionId) === undefined) return;
    set((state) => ({ created: [...state.created, sessionId], pages: { ...state.pages, [sessionId]: { ...BLANK_PAGE } } }));
  },

  discard: (sessionId) => {
    if (!get().created.includes(sessionId)) return;
    set((state) => {
      const { [sessionId]: _removed, ...pages } = state.pages;
      return {
        created: state.created.filter((id) => id !== sessionId),
        pages,
        slot: state.slot?.sessionId === sessionId ? undefined : state.slot,
      };
    });
    elements.delete(sessionId);
    void window.deskmony?.browserClearPartition?.(sessionId).catch(() => undefined);
  },

  setSlot: (slot) => set({ slot }),
  setPointerLock: (pointerLock) => set({ pointerLock }),
  patchPage: (sessionId, patch) =>
    set((state) => (state.pages[sessionId] ? { pages: { ...state.pages, [sessionId]: { ...state.pages[sessionId], ...patch } } } : state)),
}));

// ---- webview 元素的指令式操作 ------------------------------------------------------------------------

const elements = new Map<string, WebviewElement>();

/** 目前這個 renderer 有沒有 Browser 分頁的能力:Electron 殼才有 `<webview>`(純瀏覽器 client 的 `window.deskmony` 是 `undefined`)。 */
export function isBrowserSupported(): boolean {
  return typeof window !== "undefined" && Boolean(window.deskmony?.browserOpenExternal);
}

/** 由 `BrowserHost` 的 webview 元件在掛上/卸載時呼叫。回傳取消註冊與拆掉事件監聽的函式。 */
export function registerWebview(sessionId: string, element: WebviewElement): () => void {
  elements.set(sessionId, element);
  const readNavigation = (): Partial<BrowserPageState> => {
    try {
      return { url: element.getURL(), title: element.getTitle(), canGoBack: element.canGoBack(), canGoForward: element.canGoForward() };
    } catch {
      return {}; // dom-ready 之前這些方法會拋錯
    }
  };
  const patch = (partial: Partial<BrowserPageState>): void => useBrowserStore.getState().patchPage(sessionId, partial);
  const on = (name: string, listener: (event: Event) => void): (() => void) => {
    element.addEventListener(name, listener);
    return () => element.removeEventListener(name, listener);
  };
  const listeners = [
    on("dom-ready", () => {
      let webContentsId: number | undefined;
      try {
        webContentsId = element.getWebContentsId();
      } catch {
        webContentsId = undefined;
      }
      patch({ ready: true, webContentsId, crashed: false, ...readNavigation() });
    }),
    on("did-start-loading", () => patch({ loading: true, failure: undefined })),
    on("did-stop-loading", () => patch({ loading: false, ...readNavigation() })),
    on("did-navigate", (event) => patch({ ...readNavigation(), url: (event as Event & { url?: string }).url ?? element.src })),
    on("did-navigate-in-page", (event) => {
      const { url, isMainFrame } = event as Event & { url?: string; isMainFrame?: boolean };
      if (isMainFrame !== false && url) patch({ ...readNavigation(), url });
    }),
    on("page-title-updated", (event) => patch({ title: (event as Event & { title?: string }).title ?? "" })),
    on("did-fail-load", (event) => {
      const { errorCode, errorDescription, validatedURL, isMainFrame } = event as Event & {
        errorCode?: number;
        errorDescription?: string;
        validatedURL?: string;
        isMainFrame?: boolean;
      };
      // -3 = ERR_ABORTED:使用者按了停止或又導到別處,不是失敗。
      if (isMainFrame === false || errorCode === -3 || errorCode === undefined) return;
      patch({ loading: false, failure: { code: errorCode, description: errorDescription ?? "", url: validatedURL ?? "" } });
    }),
    on("render-process-gone", () => patch({ crashed: true, loading: false })),
  ];
  return () => {
    for (const off of listeners) off();
    if (elements.get(sessionId) === element) elements.delete(sessionId);
  };
}

function pageOf(sessionId: string): BrowserPageState | undefined {
  return useBrowserStore.getState().pages[sessionId];
}

/** 導覽到(已經過 `normalizeAddressInput()` 驗證的)網址。`dom-ready` 之前用 `src` 屬性,之後用 `loadURL()`。 */
export function browserNavigate(sessionId: string, url: string): void {
  const element = elements.get(sessionId);
  if (!element) return;
  if (pageOf(sessionId)?.ready) {
    // 又導到別處會讓前一次載入以 ERR_ABORTED 結束(promise reject),不是錯誤。
    void element.loadURL(url).catch(() => undefined);
  } else {
    element.src = url;
  }
}

function guarded(sessionId: string, action: (element: WebviewElement) => void): void {
  const element = elements.get(sessionId);
  if (!element || !pageOf(sessionId)?.ready) return;
  try {
    action(element);
  } catch {
    // webview 剛好在這一刻被銷毀/尚未就緒
  }
}

export const browserBack = (sessionId: string): void => guarded(sessionId, (el) => el.goBack());
export const browserForward = (sessionId: string): void => guarded(sessionId, (el) => el.goForward());
export const browserReload = (sessionId: string): void => guarded(sessionId, (el) => el.reload());
export const browserStop = (sessionId: string): void => guarded(sessionId, (el) => el.stop());

/** 用外部瀏覽器開目前的網址(main 只接受 http(s))。 */
export function browserOpenExternal(sessionId: string): void {
  const url = pageOf(sessionId)?.url;
  if (!url || !isExternallyOpenableUrl(url)) return;
  void window.deskmony?.browserOpenExternal?.(url).catch(() => undefined);
}

/** 開這個 session 瀏覽器的開發者工具(main 會驗證 webContentsId 確實是本視窗的 webview)。 */
export function browserOpenDevTools(sessionId: string): void {
  const id = pageOf(sessionId)?.webContentsId;
  if (id === undefined) return;
  void window.deskmony?.browserOpenDevTools?.(id).catch(() => undefined);
}
