import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { getTerminalBuffer, onTerminalData, useSessionStore } from "../stores/session-store.js";
import { IconButton } from "../ui/Button.js";
import { Badge } from "../ui/Badge.js";
import { useTheme } from "../ui/theme.js";

/** 把 index.css 定義的 CSS 變數(RGB 通道值)解析成 xterm.js 能吃的 `rgb()`
 *  字串——xterm 用 canvas/webgl 繪製,`fillStyle` 不會像一般 DOM 那樣解析
 *  `var(--x)`,必須在這裡讀出目前生效的實際色值。深/淺主題切換時重新讀取一次
 *  即可(見下方訂閱 `useTheme` 的 effect)。 */
function resolveTerminalTheme(): NonNullable<ConstructorParameters<typeof Terminal>[0]>["theme"] {
  const style = getComputedStyle(document.documentElement);
  const channel = (name: string): string => `rgb(${style.getPropertyValue(name).trim().split(/\s+/).join(" ")})`;
  return {
    background: channel("--c-canvas"),
    foreground: channel("--c-fg"),
    cursor: channel("--c-accent"),
    cursorAccent: channel("--c-canvas"),
    selectionBackground: channel("--c-line-strong"),
  };
}

/**
 * TerminalView — GenericPtyAdapter(`capabilities().terminal === true`)的
 * 終端直通視圖(ARCHITECTURE.md 3.1 節「內嵌終端(xterm.js)」、3.4 節
 * 「能力探測 + 優雅降級」)。與 ChatView 的差異:
 *   - 不解析 `terminal-data` 事件內容,直接餵給 xterm.js 的 `Terminal.write()`
 *     (見 stores/session-store.ts 的 `onTerminalData` pub-sub,刻意繞過
 *     zustand 的響應式 state,避免高頻小片段輸出拖垮整個 store)。
 *   - 輸入框送出的是「原始一行文字」(`sendTerminalInput`),不是結構化的
 *     聊天訊息 —— 語意上等同使用者在終端機鍵盤打字後按下 Enter。
 *   - 沒有「訊息串流中/完成」的概念,只有 session.status 的
 *     idle/busy(由 apps/core 依輸出活動量測簡化判斷,見
 *     apps/core/src/session/session-manager.ts 的 PTY_IDLE_TIMEOUT_MS 說明)。
 */
export function TerminalView({ onOpenSidebar }: { onOpenSidebar: () => void }): JSX.Element {
  const { t } = useTranslation(["terminal", "common"]);
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const sessions = useSessionStore((s) => s.sessions);
  const sendTerminalInput = useSessionStore((s) => s.sendTerminalInput);
  const sendTerminalRawInput = useSessionStore((s) => s.sendTerminalRawInput);
  const resizeTerminal = useSessionStore((s) => s.resizeTerminal);
  const interrupt = useSessionStore((s) => s.interrupt);

  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [draft, setDraft] = useState("");

  // Issue 1 修正之一:目前 session 的 id 用 ref 追蹤(而非直接讀 closure 裡的
  // `currentSessionId`),因為 resize 相關的 callback(window resize handler、
  // ResizeObserver callback)是在掛載 effect(`[]` deps)裡註冊、存活期間跨越
  // session 切換,若直接 closure 捕捉會抓到掛載當下(可能是 null)的值。
  const currentSessionIdRef = useRef<string | null>(currentSessionId);
  currentSessionIdRef.current = currentSessionId;

  // Issue 1 修正之一:debounce + 去重送出的「最後一次通報給後端的尺寸」,
  // 避免視窗連續 resize 時對 WS 連線送出大量 session.resizeTerminal 呼叫。
  const lastSentSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const resizeDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reportResize = (): void => {
    const term = termRef.current;
    const sessionId = currentSessionIdRef.current;
    if (!term || !sessionId) return;
    const { cols, rows } = term;
    if (resizeDebounceRef.current) clearTimeout(resizeDebounceRef.current);
    resizeDebounceRef.current = setTimeout(() => {
      const last = lastSentSizeRef.current;
      if (last && last.cols === cols && last.rows === rows) return;
      lastSentSizeRef.current = { cols, rows };
      resizeTerminal(sessionId, cols, rows);
    }, 100);
  };

  const session = sessions.find((s) => s.id === currentSessionId);

  // 建立 xterm 實例(整個 TerminalView 存活期間只建立一次,切換 session 時
  // 用 clear() + 重寫 buffer,不整個銷毀重建,避免 DOM 抖動)。
  useEffect(() => {
    if (!containerRef.current) return;
    const term = new Terminal({
      // Issue 1 修正之二:移除 convertEol(預設值就是 false,見 xterm.js
      // ITerminalOptions 型別定義)。真正的 pty 已經會送出正確的 "\r\n" 換行
      // ——開著 convertEol 等於把單獨的 "\n" 也硬轉成 "\r\n",對已經是
      // "\r\n" 的輸出沒差,但會破壞仰賴「裸 \n 不移動游標水平位置」語意的
      // TUI 程式(游標定位類 escape sequence 因此跑位,對應「格式跑掉」的
      // 使用者回報)。
      fontFamily: "Cascadia Code, JetBrains Mono, Consolas, monospace",
      fontSize: 13,
      cursorBlink: true,
      theme: resolveTerminalTheme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;
    reportResize();

    // Bug A 修正:xterm 的 onData 是唯一的「使用者在終端裡實際打字/按鍵」
    // 事件來源,逐段(可能是單一字元,也可能是一段轉義序列,例如方向鍵的
    // "\x1b[A")原封不動送給後端,不在本地額外 echo——PTY 自己會把輸入
    // 透過既有的 terminal-data 事件回顯回來(見下面訂閱 onTerminalData 的
    // effect,以及 GenericPtyAdapter 的行編輯/回顯完全由子程序/ConPTY 決定
    // 這個既有設計),這裡本地再 write() 一次會造成每個字元顯示兩次。
    const dataDisposable = term.onData((data) => sendTerminalRawInput(data));

    const handleResize = (): void => {
      fit.fit();
      reportResize();
    };
    window.addEventListener("resize", handleResize);
    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(containerRef.current);

    return () => {
      window.removeEventListener("resize", handleResize);
      resizeObserver.disconnect();
      dataDisposable.dispose();
      if (resizeDebounceRef.current) clearTimeout(resizeDebounceRef.current);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, []);

  // 切換 session:清空畫面,重新寫入該 session 目前保留的緩衝內容(見
  // getTerminalBuffer 的說明,只是 renderer 端的暫存,不是持久化)。
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.reset();
    if (currentSessionId) {
      term.write(getTerminalBuffer(currentSessionId));
    }
    fitRef.current?.fit();
    // 切換 session 等同換了一個全新的後端 pty(spawn 時固定用預設
    // cols:80/rows:24,見 pty-adapter.ts),即使本地 xterm 尺寸與前一個
    // session 相同,也必須重新通報一次,所以這裡重置「上次已送出的尺寸」
    // 記錄,強制 reportResize() 不因為「數值沒變」而跳過送出。
    lastSentSizeRef.current = null;
    reportResize();
  }, [currentSessionId]);

  // 訂閱即時 terminal-data 事件,直接寫入 xterm(不經過 React state)。
  useEffect(() => {
    return onTerminalData((sessionId, data) => {
      if (sessionId !== currentSessionId) return;
      termRef.current?.write(data);
    });
  }, [currentSessionId]);

  // 主題切換(深色 ⇄ 淺色)時,重新解析 CSS 變數並套用給 xterm——canvas 繪製
  // 不會自動跟著 CSS 變數變化,見上方 resolveTerminalTheme() 的說明。
  const resolvedTheme = useTheme((s) => s.resolved);
  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = resolveTerminalTheme();
  }, [resolvedTheme]);

  const handleSend = (): void => {
    if (!currentSessionId) return;
    sendTerminalInput(draft);
    setDraft("");
  };

  if (!currentSessionId || !session) {
    return (
      <main className="flex h-full flex-1 flex-col bg-canvas">
        <div className="flex flex-shrink-0 items-center border-b border-line-subtle px-2 py-1.5 sm:hidden">
          <IconButton icon="menu" aria-label={t("terminal:openSidebar")} onClick={onOpenSidebar} />
        </div>
        <div className="flex flex-1 items-center justify-center text-fg-subtle">
          <p className="text-sm">{t("terminal:selectOrCreate")}</p>
        </div>
      </main>
    );
  }

  const busy = session.status === "busy";

  return (
    <main className="flex h-full flex-1 flex-col bg-canvas">
      <header className="flex flex-shrink-0 items-center justify-between gap-2 border-b border-line-subtle px-4 py-2.5 sm:px-5">
        <IconButton icon="menu" aria-label={t("terminal:openSidebar")} onClick={onOpenSidebar} className="sm:hidden" />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold text-fg">{session.title}</h1>
          <p className="mt-0.5 flex items-center gap-1.5 text-2xs text-fg-faint" title={session.workingDir}>
            <Badge tone="accent" icon="terminal">{t("terminal:directTerminal")}</Badge>
            <span className="truncate">{session.workingDir}</span>
          </p>
        </div>
        <IconButton
          icon="pause"
          aria-label={t("terminal:interrupt")}
          title={t("terminal:interrupt")}
          variant="outline"
          disabled={!busy}
          onClick={interrupt}
          className="flex-shrink-0 hover:!border-danger hover:!text-danger"
        />
      </header>

      {/* M5 Round B(任務2,響應式):overflow-auto(而非 overflow-hidden)——
          xterm 的 fit addon 會依容器寬度調整欄數,但視窗極窄時仍可能有內容
          比容器寬(例如既有的長輸出未隨視窗縮小重新換行),允許捲動至少不破版。 */}
      <div className="min-h-0 flex-1 overflow-auto bg-canvas p-3">
        <div ref={containerRef} data-terminal-surface className="h-full w-full" />
      </div>

      <div className="flex-shrink-0 border-t border-line-subtle p-3 sm:p-4">
        <div className="flex items-center gap-2 rounded-lg border border-line bg-surface p-2 transition focus-within:border-accent/60 focus-within:ring-2 focus-within:ring-accent/20">
          <span className="pl-1.5 font-mono text-xs text-fg-faint">$</span>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder={t("terminal:inputPlaceholder")}
            className="flex-1 bg-transparent px-1 py-1 font-mono text-sm text-fg outline-none placeholder:text-fg-faint"
          />
          <IconButton icon="play" aria-label={t("terminal:send")} variant="primary" size="md" onClick={handleSend} />
        </div>
      </div>
    </main>
  );
}
