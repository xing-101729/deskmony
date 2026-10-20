import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { useSessionStore } from "../../stores/session-store.js";
import { usePanelStore } from "../../stores/panel-store.js";
import { useTerminalStore } from "../../stores/terminal-store.js";
import { IconButton } from "../../ui/Button.js";
import { Icon } from "../../ui/icons.js";
import { useFontScale } from "../../ui/font-scale.js";
import { PANEL_MIN_WIDTH, PANEL_SM_BREAKPOINT_PX, computePanelLayout } from "../../lib/panel-layout.js";
import { PANEL_TABS } from "./panel-tabs.js";

/** 目前視窗/版面的量測值(餵給 `computePanelLayout()`)。 */
interface Measured {
  areaWidth: number;
  viewportWidth: number;
  rootFontPx: number;
  smUp: boolean;
}

function measureLayout(aside: HTMLElement | null): Measured {
  const root = parseFloat(getComputedStyle(document.documentElement).fontSize);
  return {
    // aside 的父層是 App.tsx 裡「聊天視圖 + 面板」共用的那個容器——它的寬度就是側欄佔掉之後**實際剩下**的寬度
    // (側欄展開/收合寬度不同、字級縮放也會改變,都已經反映在這個量測值裡,不必寫死任何側欄寬度)。
    areaWidth: aside?.parentElement?.clientWidth ?? window.innerWidth,
    viewportWidth: window.innerWidth,
    rootFontPx: Number.isFinite(root) && root > 0 ? root : 16,
    smUp: window.matchMedia(`(min-width: ${PANEL_SM_BREAKPOINT_PX}px)`).matches,
  };
}

function sameMeasured(a: Measured, b: Measured): boolean {
  return a.areaWidth === b.areaWidth && a.viewportWidth === b.viewportWidth && a.rootFontPx === b.rootFontPx && a.smUp === b.smUp;
}

/**
 * 右側面板外殼(2026-10-20,見 docs/LAYER-4-detail-design/side-panel_detail.md §P1.3)。
 *
 * 放在 `App.tsx` 主 flex 列裡、`SessionView` 右邊(外層自己包一層 ErrorBoundary,與聊天視圖互不拖累)。面板內容**永遠
 * 對應「目前選取的 session」**;沒有選取 session 時顯示空狀態。分頁列由 `PANEL_TABS` 註冊陣列產生。
 *
 * - **寬度可拖拉**(左緣把手):最小 320 px;最大 = min(視窗寬度 70%, 實際量到的可用寬度 − 聊天視圖最小寬度 22rem),
 *   拖拉同樣受這個上限限制;開/關、**偏好**寬度、目前分頁存 localStorage(見 `panel-store.ts`),空間變大時偏好寬度會恢復。
 *   版面計算見 `lib/panel-layout.ts`。
 * - **覆蓋層**:視窗在 `sm` 以下,或連「聊天最小寬度 + 面板最小寬度 320」都放不下時,面板改成全螢幕覆蓋層(附關閉鈕),不硬擠。
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

  // ---- 版面量測:aside 掛上(開啟)時同步量一次(useLayoutEffect,畫面繪製前就修正完),之後視窗大小、容器大小
  // (側欄展開/收合會改變它)、字級變動都重新量。量到的值不變就不 setState(避免無謂的重新渲染)。----
  const asideRef = useRef<HTMLElement>(null);
  const rootFontPx = useFontScale((s) => s.rootFontPx);
  const [measured, setMeasured] = useState<Measured>(() => ({
    areaWidth: window.innerWidth,
    viewportWidth: window.innerWidth,
    rootFontPx: 16,
    smUp: window.innerWidth >= PANEL_SM_BREAKPOINT_PX,
  }));
  const mounted = open && Boolean(activeTab);
  const remeasure = useCallback((): void => {
    const next = measureLayout(asideRef.current);
    setMeasured((prev) => (sameMeasured(prev, next) ? prev : next));
  }, []);
  useLayoutEffect(() => {
    if (!mounted) return;
    remeasure();
    const container = asideRef.current?.parentElement;
    const observer = new ResizeObserver(remeasure);
    if (container) observer.observe(container);
    window.addEventListener("resize", remeasure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", remeasure);
    };
  }, [mounted, remeasure, rootFontPx]);

  const layout = computePanelLayout({ ...measured, preferredWidth: width });

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
      // 面板貼著視窗右緣,寬度 = 面板右緣到游標的距離;超過目前版面允許的上限就停在上限(偏好寬度存的是被限制後的值)。
      const right = asideRef.current?.getBoundingClientRect().right ?? window.innerWidth;
      setWidth(Math.min(layout.maxWidth, right - event.clientX));
    },
    [setWidth, layout.maxWidth],
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
      if (event.key === "ArrowLeft") setWidth(Math.min(layout.maxWidth, layout.width + 24));
      else if (event.key === "ArrowRight") setWidth(Math.min(layout.maxWidth, layout.width - 24));
      else return;
      event.preventDefault();
    },
    [setWidth, layout.maxWidth, layout.width],
  );

  if (!open || !activeTab) return null;

  const overlay = layout.mode === "overlay";
  const ActiveComponent = activeTab.Component;

  return (
    <aside
      ref={asideRef}
      aria-label={t("sidePanel:title")}
      data-panel-mode={layout.mode}
      style={overlay ? undefined : { width: layout.width }}
      className={
        overlay
          ? "fixed inset-0 z-40 flex min-h-0 flex-col bg-canvas"
          : "relative flex min-h-0 flex-shrink-0 flex-col border-l border-line-subtle bg-canvas"
      }
    >
      {!overlay && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t("sidePanel:resize")}
          aria-valuemin={PANEL_MIN_WIDTH}
          aria-valuemax={layout.maxWidth}
          aria-valuenow={layout.width}
          tabIndex={0}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onKeyDown={handleKeyDown}
          className="focus-ring absolute -left-1 top-0 z-10 h-full w-2 cursor-col-resize touch-none transition-colors hover:bg-accent/40"
        />
      )}

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
