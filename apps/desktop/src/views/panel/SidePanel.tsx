import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { useSessionStore } from "../../stores/session-store.js";
import { clampPanelWidth, usePanelStore } from "../../stores/panel-store.js";
import { useTerminalStore } from "../../stores/terminal-store.js";
import { IconButton } from "../../ui/Button.js";
import { Icon } from "../../ui/icons.js";
import { PANEL_TABS } from "./panel-tabs.js";

/**
 * 右側面板外殼(2026-10-20,見 docs/LAYER-4-detail-design/side-panel_detail.md §P1.3)。
 *
 * 放在 `App.tsx` 主 flex 列裡、`SessionView` 右邊(外層自己包一層 ErrorBoundary,與聊天視圖互不拖累)。面板內容**永遠
 * 對應「目前選取的 session」**;沒有選取 session 時顯示空狀態。分頁列由 `PANEL_TABS` 註冊陣列產生。
 *
 * - **寬度可拖拉**(左緣把手):最小 320 px、最大視窗寬度 70%;開/關、寬度、目前分頁存 localStorage(見 `panel-store.ts`)。
 * - **窄螢幕**(`sm` 以下):面板改成全螢幕覆蓋層,附關閉鈕。
 * - 關著時整個不渲染(其中的 xterm 一併 dispose;重新打開時 attach,core 有緩衝)。
 */
export function SidePanel(): JSX.Element | null {
  const { t } = useTranslation(["sidePanel"]);
  const open = usePanelStore((s) => s.open);
  const width = usePanelStore((s) => s.width);
  const tabId = usePanelStore((s) => s.tab);
  const setOpen = usePanelStore((s) => s.setOpen);
  const setTab = usePanelStore((s) => s.setTab);
  const setWidth = usePanelStore((s) => s.setWidth);
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const sessions = useSessionStore((s) => s.sessions);
  const forgetTerminalSession = useTerminalStore((s) => s.forgetSession);

  const session = sessions.find((s) => s.id === currentSessionId);
  const tabs = useMemo(() => PANEL_TABS.filter((tab) => tab.isAvailable()), []);
  const activeTab = tabs.find((tab) => tab.id === tabId) ?? tabs[0];

  // 視窗縮小時,70% 的上限跟著變——只重新渲染一次讓 `clampPanelWidth()` 以新的視窗寬度重算(不改存下來的偏好寬度)。
  const [, setViewportTick] = useState(0);
  useEffect(() => {
    const onResize = (): void => setViewportTick((n) => n + 1);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // session 被刪除:丟掉它的終端狀態(core 已一併關掉,不然 store 裡的 Map 只增不減)。
  const knownSessionIds = useMemo(() => new Set(sessions.map((s) => s.id)), [sessions]);
  useEffect(() => {
    const { terminalsBySession } = useTerminalStore.getState();
    for (const id of Object.keys(terminalsBySession)) {
      if (!knownSessionIds.has(id)) forgetTerminalSession(id);
    }
  }, [knownSessionIds, forgetTerminalSession]);

  // ---- 左緣拖拉把手 ----
  const dragRef = useRef<{ pointerId: number } | null>(null);
  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>): void => {
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId };
    event.preventDefault();
  }, []);
  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      if (!dragRef.current || dragRef.current.pointerId !== event.pointerId) return;
      // 面板貼著視窗右緣,寬度 = 視窗右緣到游標的距離。
      setWidth(window.innerWidth - event.clientX);
    },
    [setWidth],
  );
  const handlePointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>): void => {
    if (dragRef.current?.pointerId === event.pointerId) {
      dragRef.current = null;
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);
  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>): void => {
      // 把手也能用鍵盤調整(往左 = 變寬)。
      if (event.key === "ArrowLeft") setWidth(width + 24);
      else if (event.key === "ArrowRight") setWidth(width - 24);
      else return;
      event.preventDefault();
    },
    [setWidth, width],
  );

  if (!open || !activeTab) return null;

  const effectiveWidth = clampPanelWidth(width);
  const ActiveComponent = activeTab.Component;

  return (
    <aside
      aria-label={t("sidePanel:title")}
      // `--panel-w` 只在 sm 以上生效(窄螢幕是全螢幕覆蓋層,寬度 = 整個視窗)。
      style={{ "--panel-w": `${effectiveWidth}px` } as CSSProperties}
      className="fixed inset-0 z-40 flex min-h-0 flex-col bg-canvas sm:relative sm:inset-auto sm:z-auto sm:w-[var(--panel-w)] sm:flex-shrink-0 sm:border-l sm:border-line-subtle"
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t("sidePanel:resize")}
        aria-valuenow={effectiveWidth}
        tabIndex={0}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onKeyDown={handleKeyDown}
        className="focus-ring absolute -left-1 top-0 z-10 hidden h-full w-2 cursor-col-resize touch-none transition-colors hover:bg-accent/40 sm:block"
      />

      <header className="flex flex-shrink-0 items-center gap-1 border-b border-line-subtle px-2 py-1.5">
        <div role="tablist" className="flex min-w-0 flex-1 items-center gap-0.5">
          {tabs.map((tab) => {
            const selected = tab.id === activeTab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => setTab(tab.id)}
                className={`focus-ring inline-flex h-6 items-center gap-1.5 rounded px-2.5 text-xs font-medium transition ${
                  selected ? "bg-surface-2 text-fg shadow-panel" : "text-fg-subtle hover:text-fg-soft"
                }`}
              >
                <Icon name={tab.icon} size={13} />
                {t(tab.titleKey)}
              </button>
            );
          })}
        </div>
        <IconButton icon="x" aria-label={t("sidePanel:close")} title={t("sidePanel:close")} onClick={() => setOpen(false)} />
      </header>

      <div className="min-h-0 flex-1">
        {session ? (
          // key={session.id}:切換 session 時整個分頁重新掛載(xterm dispose、切回來再 attach),分頁不必自己處理重置。
          <ActiveComponent key={session.id} session={session} visible />
        ) : (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-fg-subtle">
            {t("sidePanel:noSession")}
          </div>
        )}
      </div>
    </aside>
  );
}
