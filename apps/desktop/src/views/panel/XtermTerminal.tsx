import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { TerminalInfo, TerminalOutputPush } from "@deskmony/shared";
import {
  attachTerminal,
  onTerminalOutput,
  resizeTerminal,
  sendTerminalInput,
  useTerminalStore,
} from "../../stores/terminal-store.js";
import { Button } from "../../ui/Button.js";
import { useTheme } from "../../ui/theme.js";
import { useFontScale } from "../../ui/font-scale.js";
import { TERMINAL_FONT_FAMILY, resolveTerminalTheme, terminalFontSizeFor } from "../../ui/xterm-theme.js";
import { translateError } from "../../lib/error-i18n.js";

/** 回報給 core 的尺寸 debounce(視窗/面板寬度連續拖動時不要每個像素都打一次 WS),比照 `TerminalView`。 */
const RESIZE_DEBOUNCE_MS = 100;

/**
 * 一個面板終端對應的 xterm 實例(2026-10-20,見 docs/LAYER-4-detail-design/side-panel_detail.md §P1.4)。
 *
 * **資料流**(與 `TerminalView` 的差異:那邊的歷史在 renderer 記憶體,這裡的歷史在 core):
 *   1. 先訂閱 `terminal-output` push——attach 往返期間到達的輸出先排進佇列;
 *   2. `terminal.attach` 取回 core 的環狀緩衝與最後一個 `seq`,寫進 xterm;
 *   3. 佇列與之後的即時輸出只寫 `seq` 比 attach 回傳的大的(`seq <=` 的已經在緩衝裡),不重複、不遺漏。
 * WS 重連(`epoch` 變動)時整個重來:reset → 重新訂閱/attach——斷線期間的輸出 push 已經遺失,core 的緩衝才是真相。
 *
 * **可見性**:同一個 session 內切換終端分頁時**只隱藏、不 dispose**(`visible=false` 時外層用 `hidden` 隱藏),
 * 隱藏中容器尺寸是 0,不能 fit(會算出 NaN/0 欄)——可見時才 fit 並回報尺寸。
 * 輸入框直通:`term.onData` 逐段原樣送進 shell(含方向鍵等轉義序列),不在本地回顯,由 shell 自己回顯。
 */
export function XtermTerminal({ terminal, visible }: { terminal: TerminalInfo; visible: boolean }): JSX.Element {
  const { t } = useTranslation(["sidePanel", "errors"]);
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const lastSentSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const epoch = useTerminalStore((s) => s.epoch);
  const focusTerminalId = useTerminalStore((s) => s.focusTerminalId);
  const restartTerminal = useTerminalStore((s) => s.restartTerminal);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);

  const terminalId = terminal.id;

  /** 把容器目前的大小算成欄列、套給 xterm,再(debounce 後)回報給 core。不可見/尺寸為 0 時什麼都不做。 */
  const fitAndReport = useCallback((): void => {
    const term = termRef.current;
    const fit = fitRef.current;
    const host = hostRef.current;
    if (!term || !fit || !host || !visibleRef.current) return;
    if (host.clientWidth === 0 || host.clientHeight === 0) return;
    try {
      fit.fit();
    } catch {
      return; // 容器剛好在這一刻被卸載/隱藏
    }
    const { cols, rows } = term;
    if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
    resizeTimerRef.current = setTimeout(() => {
      const last = lastSentSizeRef.current;
      if (last && last.cols === cols && last.rows === rows) return;
      lastSentSizeRef.current = { cols, rows };
      void resizeTerminal(terminalId, cols, rows).catch(() => undefined);
    }, RESIZE_DEBOUNCE_MS);
  }, [terminalId]);

  // 建立 xterm 實例(這個元件存活期間只建一次;切換 session 時外層以 key 卸載整批,見 TerminalTab)。
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      fontFamily: TERMINAL_FONT_FAMILY,
      // 字級用 getState() 讀「掛載當下」的值,字級之後的變動由下面訂閱 rootFontPx 的 effect 套用(理由同 TerminalView)。
      fontSize: terminalFontSizeFor(useFontScale.getState().rootFontPx),
      cursorBlink: true,
      scrollback: 5_000,
      theme: resolveTerminalTheme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;

    const dataDisposable = term.onData((data) => {
      void sendTerminalInput(terminalId, data).catch(() => undefined);
    });
    const resizeObserver = new ResizeObserver(() => fitAndReport());
    resizeObserver.observe(host);
    fitAndReport();

    return () => {
      resizeObserver.disconnect();
      dataDisposable.dispose();
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [terminalId, fitAndReport]);

  // 訂閱輸出並 attach;WS 重連(epoch 變動)時整個重來。
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    let cancelled = false;
    let ready = false;
    let lastSeq = 0;
    const queued: TerminalOutputPush[] = [];
    term.reset();
    setAttachError(null);

    const unsubscribe = onTerminalOutput((push) => {
      if (push.terminalId !== terminalId) return;
      if (!ready) {
        queued.push(push);
        return;
      }
      if (push.seq <= lastSeq) return;
      lastSeq = push.seq;
      term.write(push.data);
    });

    attachTerminal(terminalId).then(
      (result) => {
        if (cancelled) return;
        if (result.buffer) term.write(result.buffer);
        lastSeq = result.seq;
        for (const push of queued) {
          if (push.seq <= lastSeq) continue;
          lastSeq = push.seq;
          term.write(push.data);
        }
        queued.length = 0;
        ready = true;
        // 新的 attach:core 記的尺寸可能是別的 client 設的,強制重新回報一次。
        lastSentSizeRef.current = null;
        fitAndReport();
      },
      (err: unknown) => {
        if (!cancelled) setAttachError(translateError(err, t));
      },
    );

    return () => {
      cancelled = true;
      unsubscribe();
    };
    // `t` 不放進依賴:語言切換不該讓終端整個 reset;錯誤訊息只在 attach 失敗那一刻翻譯。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalId, epoch, fitAndReport]);

  // 變成可見(切回這個分頁、面板被打開)時:容器剛從 display:none 回來,重新 fit 並回報。
  useEffect(() => {
    if (visible) fitAndReport();
  }, [visible, fitAndReport]);

  // 要求焦點(新建立的終端、使用者用快捷鍵叫出面板)——不是每次切 session 都搶走聊天輸入框的焦點。
  useEffect(() => {
    if (focusTerminalId !== terminalId || !visible) return;
    termRef.current?.focus();
    useTerminalStore.getState().clearFocus();
  }, [focusTerminalId, terminalId, visible]);

  // 主題切換(深色 ⇄ 淺色):canvas 繪製不會自動跟著 CSS 變數變化,見 xterm-theme.ts。
  const resolvedTheme = useTheme((s) => s.resolved);
  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = resolveTerminalTheme();
  }, [resolvedTheme]);

  // 字級變動:除了 fontSize 還要重新 fit 並回報(每個字元的像素寬度變了,欄數跟著變),理由同 TerminalView。
  const rootFontPx = useFontScale((s) => s.rootFontPx);
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontSize = terminalFontSizeFor(rootFontPx);
    fitAndReport();
  }, [rootFontPx, fitAndReport]);

  const exited = terminal.exitCode !== undefined;
  const handleRestart = async (): Promise<void> => {
    setRestarting(true);
    try {
      const term = termRef.current;
      await restartTerminal(terminal, term ? { cols: term.cols, rows: term.rows } : undefined);
    } catch {
      // 失敗原因已寫進 store 的 lastError,由 TerminalTab 顯示
    } finally {
      setRestarting(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 bg-canvas p-2">
        {/* data-terminal-surface:ui/hotkeys.ts 的 insideTerminal() 靠它判斷焦點在終端裡(Ctrl 系組合鍵讓給 shell)。 */}
        <div ref={hostRef} data-terminal-surface className="h-full w-full" />
      </div>
      {attachError && (
        <div className="flex-shrink-0 border-t border-line-subtle bg-danger/10 px-3 py-1.5 text-xs text-danger" role="alert">
          {attachError}
        </div>
      )}
      {exited && (
        <div className="flex flex-shrink-0 items-center gap-2 border-t border-line-subtle bg-surface px-3 py-1.5 text-xs text-fg-muted">
          <span className="min-w-0 flex-1 truncate">
            {terminal.exitCode === null
              ? t("sidePanel:terminal.exitedUnknown")
              : t("sidePanel:terminal.exited", { code: terminal.exitCode })}
          </span>
          <Button size="xs" variant="secondary" disabled={restarting} onClick={() => void handleRestart()}>
            {t("sidePanel:terminal.restart")}
          </Button>
        </div>
      )}
    </div>
  );
}
