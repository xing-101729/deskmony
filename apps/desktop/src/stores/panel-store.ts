import { create } from "zustand";
import { PANEL_DEFAULT_WIDTH, PANEL_MAX_WIDTH_RATIO, PANEL_MIN_WIDTH } from "../lib/panel-layout.js";

/**
 * 右側面板的外殼狀態(2026-10-20,見 docs/LAYER-4-detail-design/side-panel_detail.md §P1.3):開/關、寬度、目前分頁。
 *
 * 存 localStorage(讀寫都包 try/catch——無痕視窗、被封鎖的網站資料或預覽截圖環境下存取器本身可能丟例外,
 * 此時退回預設值照常運作,只是不記得)。**分頁 id 刻意用 `string`**:合法的分頁由 `views/panel/panel-tabs.tsx` 的
 * 註冊陣列決定,這裡不依賴它(避免 store ↔ 元件的循環引用),由 `SidePanel` 在渲染時把不認得的 id(例如舊版存下來、
 * 之後被移除的分頁,或純瀏覽器 client 上不可用的分頁)退回第一個可用分頁。
 */

const STORAGE_KEY = "deskmony.sidePanel.v1";

/**
 * 存下來的**偏好**寬度夾在 [320, 視窗 70%]。實際顯示的寬度還要再受「聊天視圖至少保留 22rem」限制(`lib/panel-layout.ts`
 * 的 `computePanelLayout()`,依實際量到的版面算)——偏好不被那個限制改寫,空間變大時會恢復。
 */
export function clampPanelWidth(width: number): number {
  if (!Number.isFinite(width)) return PANEL_DEFAULT_WIDTH;
  const viewport = typeof window !== "undefined" ? window.innerWidth : 1280;
  const max = Math.max(PANEL_MIN_WIDTH, Math.floor(viewport * PANEL_MAX_WIDTH_RATIO));
  return Math.min(max, Math.max(PANEL_MIN_WIDTH, Math.round(width)));
}

interface PersistedPanelState {
  open: boolean;
  width: number;
  tab: string;
}

function loadPersisted(): PersistedPanelState {
  const fallback: PersistedPanelState = { open: false, width: PANEL_DEFAULT_WIDTH, tab: "terminal" };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<PersistedPanelState>;
    return {
      open: parsed.open === true,
      width: typeof parsed.width === "number" ? clampPanelWidth(parsed.width) : fallback.width,
      tab: typeof parsed.tab === "string" && parsed.tab ? parsed.tab : fallback.tab,
    };
  } catch {
    return fallback;
  }
}

function persist(state: PersistedPanelState): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // ignore — 存不進去就只是下次不記得
  }
}

interface PanelState extends PersistedPanelState {
  toggle: () => void;
  setOpen: (open: boolean) => void;
  /** 開面板並切到指定分頁(快捷鍵、命令面板、其他視圖的入口共用)。 */
  openTab: (tab: string) => void;
  setTab: (tab: string) => void;
  setWidth: (width: number) => void;
}

export const usePanelStore = create<PanelState>((set, get) => {
  const initial = loadPersisted();
  const update = (patch: Partial<PersistedPanelState>): void => {
    set(patch);
    const { open, width, tab } = get();
    persist({ open, width, tab });
  };
  return {
    ...initial,
    toggle: () => update({ open: !get().open }),
    setOpen: (open) => update({ open }),
    openTab: (tab) => update({ open: true, tab }),
    setTab: (tab) => update({ tab }),
    setWidth: (width) => update({ width: clampPanelWidth(width) }),
  };
});
