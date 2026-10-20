import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useTerminalStore } from "../../stores/terminal-store.js";
import { Button, IconButton, Spinner } from "../../ui/Button.js";
import { Icon } from "../../ui/icons.js";
import { useFontScale } from "../../ui/font-scale.js";
import { terminalFontSizeFor } from "../../ui/xterm-theme.js";
import { translateError } from "../../lib/error-i18n.js";
import { XtermTerminal } from "./XtermTerminal.js";
import type { PanelTabProps } from "./panel-tabs.js";

/** 新終端的初始尺寸:用面板內容區的大小估算欄列(之後 xterm 掛上去會 fit 並回報精確值),量不到就用傳統的 80×24。 */
function estimateTerminalSize(body: HTMLElement | null): { cols: number; rows: number } {
  const fontPx = terminalFontSizeFor(useFontScale.getState().rootFontPx);
  if (!body || body.clientWidth === 0 || body.clientHeight === 0) return { cols: 80, rows: 24 };
  const cols = Math.floor((body.clientWidth - 16) / (fontPx * 0.6));
  const rows = Math.floor((body.clientHeight - 16) / (fontPx * 1.25));
  return { cols: Math.min(300, Math.max(20, cols)), rows: Math.min(100, Math.max(5, rows)) };
}

/**
 * 面板的 Terminal 分頁(2026-10-20,見 docs/LAYER-4-detail-design/side-panel_detail.md §P1.4)。
 *
 * - 目前 session 的所有終端各一個子分頁(標題、× 關閉),「+」新增;**同一個 session 內切換子分頁只隱藏、不 dispose**
 *   (`XtermTerminal` 全部保持掛載,非目前的包在 `hidden` 裡)。外層(`SidePanel`)以 `key={sessionId}` 掛載這個元件,
 *   所以**切換 session 時整批卸載**(dispose xterm),切回來再 attach(core 有 512 KB 緩衝)。
 * - 面板打開到這個分頁、但該 session 還沒有終端時**自動建一個**。只在「面板剛可見」的那一次自動建立:使用者自己關掉
 *   最後一個終端之後不會立刻又彈出一個(那會讓「關掉」變成無法達成),空狀態有「新增終端」按鈕。
 */
export function TerminalTab({ session, visible }: PanelTabProps): JSX.Element {
  const { t } = useTranslation(["sidePanel", "errors"]);
  const sessionId = session.id;
  const terminals = useTerminalStore((s) => s.terminalsBySession[sessionId]);
  const loaded = useTerminalStore((s) => s.loaded[sessionId] === true);
  const activeId = useTerminalStore((s) => s.activeBySession[sessionId]);
  const creating = useTerminalStore((s) => s.creating[sessionId] === true);
  const lastError = useTerminalStore((s) => s.lastError);
  const loadTerminals = useTerminalStore((s) => s.loadTerminals);
  const createTerminal = useTerminalStore((s) => s.createTerminal);
  const closeTerminal = useTerminalStore((s) => s.closeTerminal);
  const setActive = useTerminalStore((s) => s.setActive);
  const clearError = useTerminalStore((s) => s.clearError);

  const bodyRef = useRef<HTMLDivElement>(null);
  const autoCreateAttemptedRef = useRef(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const list = terminals ?? [];

  // 清單還沒載入(剛掛上、或 WS 重連把 loaded 清掉)就載入。失敗不會自動重試(依賴不變),由使用者按「重試」。
  const load = useCallback((): void => {
    setLoadError(null);
    loadTerminals(sessionId).catch((err: unknown) => setLoadError(translateError(err, t)));
    // `t` 不放進依賴:語言切換不該重新載入清單。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, loadTerminals]);
  useEffect(() => {
    if (!loaded) load();
  }, [loaded, load]);

  const create = useCallback((): void => {
    createTerminal(sessionId, estimateTerminalSize(bodyRef.current)).catch(() => undefined); // 失敗原因在 store 的 lastError
  }, [createTerminal, sessionId]);

  // 面板可見、清單載入完且是空的 → 自動建一個(每次「變成可見」最多一次)。
  useEffect(() => {
    if (!visible) {
      autoCreateAttemptedRef.current = false;
      return;
    }
    if (!loaded || creating || autoCreateAttemptedRef.current || list.length > 0) return;
    autoCreateAttemptedRef.current = true;
    create();
  }, [visible, loaded, creating, list.length, create]);

  const errorText = loadError ?? (lastError !== undefined ? translateError(lastError, t) : null);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-shrink-0 items-center gap-1 border-b border-line-subtle px-2 py-1">
        <div role="tablist" aria-label={t("sidePanel:terminal.tabsLabel")} className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {list.map((terminal) => {
            const selected = terminal.id === activeId;
            const exited = terminal.exitCode !== undefined;
            return (
              <div
                key={terminal.id}
                className={`flex h-6 flex-shrink-0 items-center rounded text-xs transition ${
                  selected ? "bg-surface-2 text-fg shadow-panel" : "text-fg-subtle hover:text-fg-soft"
                }`}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  title={terminal.cwd}
                  onClick={() => setActive(sessionId, terminal.id)}
                  className="focus-ring h-full max-w-[9rem] truncate rounded-l pl-2 pr-1"
                >
                  {terminal.title}
                  {exited && <span className="ml-1 text-fg-faint">·</span>}
                </button>
                <button
                  type="button"
                  aria-label={t("sidePanel:terminal.close", { title: terminal.title })}
                  title={t("sidePanel:terminal.close", { title: terminal.title })}
                  onClick={() => void closeTerminal(terminal.id).catch(() => undefined)}
                  className="focus-ring flex h-full w-5 items-center justify-center rounded-r text-fg-faint hover:text-danger"
                >
                  <Icon name="x" size={11} />
                </button>
              </div>
            );
          })}
        </div>
        <IconButton
          icon="plus"
          aria-label={t("sidePanel:terminal.new")}
          title={t("sidePanel:terminal.new")}
          disabled={creating}
          onClick={create}
        />
      </div>

      {errorText && (
        <div className="flex flex-shrink-0 items-center gap-2 border-b border-line-subtle bg-danger/10 px-3 py-1.5 text-xs text-danger" role="alert">
          <span className="min-w-0 flex-1 break-words">{errorText}</span>
          <Button
            size="xs"
            variant="secondary"
            onClick={() => {
              clearError();
              if (loadError) load();
            }}
          >
            {loadError ? t("sidePanel:retry") : t("sidePanel:dismiss")}
          </Button>
        </div>
      )}

      <div ref={bodyRef} className="relative min-h-0 flex-1">
        {list.map((terminal) => (
          <div key={terminal.id} className={terminal.id === activeId ? "h-full" : "hidden"}>
            <XtermTerminal terminal={terminal} visible={visible && terminal.id === activeId} />
          </div>
        ))}
        {list.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-fg-subtle">
            {!loaded || creating ? (
              <Spinner size={16} />
            ) : (
              <>
                <p className="text-sm">{t("sidePanel:terminal.empty")}</p>
                <Button size="sm" variant="secondary" onClick={create}>
                  {t("sidePanel:terminal.new")}
                </Button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
