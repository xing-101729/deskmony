import { useCallback, useEffect, useMemo, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { client, providerLabelOf, selectAvailableProviders, useSessionStore } from "./stores/session-store.js";
import { useRecoveryStore } from "./stores/recovery-store.js";
import { SessionList } from "./views/SessionList.js";
import { SessionView } from "./views/SessionView.js";
import { PermissionModal } from "./views/PermissionModal.js";
import { ConnectScreen } from "./views/ConnectScreen.js";
import { SettingsDialog } from "./views/SettingsDialog.js";
import { RecoveryView } from "./views/RecoveryView.js";
import { CommandPalette, type Command } from "./views/CommandPalette.js";
import { clearSavedConnection } from "./lib/connection-config.js";
import { Button, Spinner } from "./ui/Button.js";
import { Icon } from "./ui/icons.js";
import { MOD_LABEL, useHotkeys } from "./ui/hotkeys.js";
import { sessionStatusMeta } from "./ui/status.js";
import { useTheme } from "./ui/theme.js";
import { useFontScale } from "./ui/font-scale.js";
import { ErrorBoundary } from "./ui/ErrorBoundary.js";
import { ConfirmDialogHost } from "./ui/ConfirmDialog.js";
import { shortenPath } from "./lib/workspaces.js";
import { translateError } from "./lib/error-i18n.js";
import {
  loadNewSessionSelection,
  reconcileSelection,
  saveNewSessionSelection,
  type NewSessionSelection,
} from "./lib/new-session-selection.js";

/**
 * M5 Round B(任務2):Electron renderer 由 preload.ts 透過 `contextBridge`
 * 曝露 `window.deskmony`(gatewayUrl/authToken),純瀏覽器分頁沒有這個橋接
 * ——用它的有無判斷目前是 Electron 殼還是瀏覽器 client。模組層級常數(不是
 * state):這個判斷在整個 app 生命週期內不會改變。
 */
const hasElectronBridge = typeof window !== "undefined" && Boolean(window.deskmony);

/**
 * ---------------------------------------------------------------------------
 * App 外殼(UI/UX 改版:資訊架構重整)
 * ---------------------------------------------------------------------------
 *
 * 改版前:一條頂列同時擠了連線狀態、產品名、中斷提示、三個視圖切換鈕、設定、
 * 登出;側欄只有一條扁平的 session 清單。(2026-10-02:三個視圖裡的團隊群聊與
 * 任務看板已移除,見 docs/DECISIONS.md §H,只剩 session 視圖,視圖切換整個拿掉。)問題是「導覽」與「狀態」混在同一列,
 * 而永遠健康的東西(連線正常)卻永久佔著位置。
 *
 * 改版後(對齊 Linear / Cursor 的作法):
 *   - **導覽全部進側欄**(見 views/SessionList.tsx):工作區 → session,
 *     形成可掃視的階層;視圖自己的標頭負責「這個畫面的」標題
 *     與動作,不再與全域導覽競爭。
 *   - **頂部不再有常駐列**:改成「只有異常時才出現」的提示條(連線中斷、有
 *     中斷的 session 待分流)。健康狀態下整個垂直空間都留給內容——這是提高
 *     資訊密度最直接的一刀。連線正常時的狀態指示縮成側欄標頭的一個圓點。
 *   - **命令面板(⌘K)+ 全域快捷鍵**:所有導覽與常用動作都能不碰滑鼠完成。
 *
 * 行為完全不變:Electron 自動連線、瀏覽器先走 ConnectScreen、通知點擊聚焦
 * session、所有彈窗的觸發條件都與改版前一致。
 */
export default function App(): JSX.Element {
  const { t } = useTranslation(["app", "common"]);
  const connect = useSessionStore((s) => s.connect);
  const status = useSessionStore((s) => s.status);
  const sessions = useSessionStore((s) => s.sessions);
  const detectedAgents = useSessionStore((s) => s.detectedAgents);
  const providerPrefs = useSessionStore((s) => s.providerPrefs);
  const effectiveConfig = useSessionStore((s) => s.effectiveConfig);
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const selectSession = useSessionStore((s) => s.selectSession);
  const createSession = useSessionStore((s) => s.createSession);
  const initRecovery = useRecoveryStore((s) => s.init);
  const interruptedSessions = useRecoveryStore((s) => s.sessions);
  const themePreference = useTheme((s) => s.preference);
  const resolvedTheme = useTheme((s) => s.resolved);
  const toggleTheme = useTheme((s) => s.toggle);
  const increaseFontScale = useFontScale((s) => s.increase);
  const decreaseFontScale = useFontScale((s) => s.decrease);
  const resetFontScale = useFontScale((s) => s.reset);

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [browserReady, setBrowserReady] = useState(hasElectronBridge);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  /**
   * 2026-10-02(P2:移除 profile):建立 session 用的 agent/model/effort/資料夾選擇——取代原本的
   * 「選哪個 profile」。改版時從 SessionList 提升到這一層,因為有**三個**入口會用到它(側欄的
   * 「新對話」按鈕、`⌘N`、命令面板的「新對話」指令),必須共用同一份選擇,否則⌘N 建出來的 session
   * 會與側欄下拉顯示的不一致。上次的選擇存 localStorage(見 lib/new-session-selection.ts),下次開 app 還原。
   */
  const [selection, setSelection] = useState<NewSessionSelection>(loadNewSessionSelection);
  const [creatingSession, setCreatingSession] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    if (!hasElectronBridge) return; // 瀏覽器場景:等 ConnectScreen 驗證成功才連線
    connect();
    initRecovery();
  }, [connect, initRecovery]);

  /**
   * S11(Notification):使用者點擊桌面原生通知後,main process 透過
   * `deskmony:notification-clicked` 把對應的 `sessionId` 轉發過來——聚焦到
   * 那個 session。純瀏覽器場景沒有
   * `onNotificationClick`,這個 effect 直接 no-op。
   */
  useEffect(() => {
    const unsubscribe = window.deskmony?.onNotificationClick?.((sessionId) => {
      void useSessionStore.getState().selectSession(sessionId);
    });
    return unsubscribe;
  }, []);

  // 偵測結果是非同步載入的;把(可能過時的)選擇對齊到「現在真的可用」的 agent 清單——被停用/移除的 agent
  // 會自動退回第一個可用的(邏輯等同改版前「profile 不再存在時自動選第一筆」)。
  const availableProviders = useMemo(
    () => selectAvailableProviders(detectedAgents, providerPrefs),
    [detectedAgents, providerPrefs],
  );
  const effectiveSelection = useMemo(
    () => reconcileSelection(selection, availableProviders),
    [selection, availableProviders],
  );
  const handleChangeSelection = useCallback((next: NewSessionSelection): void => {
    setSelection(next);
    saveNewSessionSelection(next);
  }, []);

  /** 新對話預設的工作資料夾:使用者在選單裡指定的 > core 的 `workspace.defaultWorkingDir` > 目前 session 的資料夾。 */
  const defaultWorkingDir = effectiveConfig?.workspace.defaultWorkingDir.value ?? "";
  const resolveWorkingDir = useCallback(
    (): string =>
      effectiveSelection.workingDir.trim() ||
      defaultWorkingDir ||
      sessions.find((x) => x.id === currentSessionId)?.workingDir ||
      "",
    [currentSessionId, defaultWorkingDir, effectiveSelection.workingDir, sessions],
  );

  const handleCreateSession = useCallback(async (): Promise<void> => {
    const providerId = availableProviders.find((p) => p.id === effectiveSelection.providerId)?.id;
    const workingDir = resolveWorkingDir();
    if (!providerId || !workingDir) return;
    setCreatingSession(true);
    setCreateError(null);
    try {
      await createSession({
        providerId,
        workingDir,
        title: t("app:sessionDefaultTitle", { n: sessions.length + 1 }),
        model: effectiveSelection.model || undefined,
        effort: effectiveSelection.effort || undefined,
      });
    } catch (err) {
      // agent 沒裝/被停用/啟動失敗等:顯示在側欄「新對話」按鈕下方,不要讓 promise 無聲地 reject。
      setCreateError(translateError(err, t));
    } finally {
      setCreatingSession(false);
    }
  }, [availableProviders, createSession, effectiveSelection, resolveWorkingDir, sessions.length, t]);

  const handleConnected = (url: string, token: string): void => {
    client.configure(url, token);
    connect();
    initRecovery();
    setBrowserReady(true);
  };

  const handleLogout = (): void => {
    clearSavedConnection();
    // 整頁重新整理回到最單純的初始狀態(WS 連線正確關閉、各個 store 的殘留
    // 資料一併清空),比逐一手動重置每個 store 簡單可靠。
    window.location.reload();
  };

  /** ⌥↑/⌥↓:在側欄目前排序下切換上一個/下一個 session(不碰滑鼠巡邏 agent)。 */
  const cycleSession = useCallback(
    (delta: number): void => {
      const ordered = sessions.slice().sort((a, b) => b.updatedAt - a.updatedAt);
      if (ordered.length === 0) return;
      const index = ordered.findIndex((s) => s.id === currentSessionId);
      const next = ordered[(index + delta + ordered.length) % ordered.length];
      void selectSession(next.id);
    },
    [currentSessionId, selectSession, sessions],
  );

  useHotkeys(
    useMemo(
      () => [
        { combo: "mod+k", handler: () => setPaletteOpen(true), allowInTerminal: true },
        { combo: "mod+shift+p", handler: () => setPaletteOpen(true), allowInTerminal: true },
        { combo: "mod+b", handler: () => setSidebarCollapsed((collapsed) => !collapsed) },
        { combo: "mod+n", handler: () => void handleCreateSession() },
        { combo: "mod+,", handler: () => setSettingsOpen(true) },
        { combo: "alt+arrowdown", handler: () => cycleSession(1), allowInTerminal: true },
        { combo: "alt+arrowup", handler: () => cycleSession(-1), allowInTerminal: true },
        // 字級調整:這三組組合鍵在終端裡沒有 readline/既定終端語意(不像
        // ui/hotkeys.ts 檔頭註解警告的 Ctrl+K/B/N 那樣被終端本身佔用),而
        // 「正在看終端輸出時調整字級」恰好是最常見的使用情境之一,所以明確
        // 允許終端聚焦時也生效。
        { combo: "mod+=", handler: () => increaseFontScale(), allowInTerminal: true },
        { combo: "mod+-", handler: () => decreaseFontScale(), allowInTerminal: true },
        { combo: "mod+0", handler: () => resetFontScale(), allowInTerminal: true },
      ],
      [cycleSession, decreaseFontScale, handleCreateSession, increaseFontScale, resetFontScale],
    ),
  );

  /** 命令面板的指令清單——每一項都對應畫面上原本就存在的入口,不新增能力。
   *  i18n 專案新增:`t` 進入依賴陣列(比照 PermissionModal.tsx 的
   *  buildRememberCandidates() 慣例)——語言切換時 useTranslation() 回傳的 `t`
   *  參考會變,連帶讓這個 useMemo 重新計算,指令清單才會即時換語言。 */
  const commands = useMemo<Command[]>(() => {
    const list: Command[] = [
      {
        id: "action:new-session",
        group: t("app:commands.groupActions"),
        title: t("app:commands.newSession.title"),
        subtitle: availableProviders.some((p) => p.id === effectiveSelection.providerId)
          ? t("app:commands.newSession.subtitleWithAgent", {
              name: providerLabelOf(effectiveSelection.providerId, detectedAgents, providerPrefs),
            })
          : t("app:commands.newSession.subtitleNoAgent"),
        icon: "plus",
        hint: `${MOD_LABEL}N`,
        keywords: t("app:commands.newSession.keywords"),
        run: () => void handleCreateSession(),
      },
      {
        id: "action:settings",
        group: t("app:commands.groupActions"),
        title: t("app:commands.settings.title"),
        subtitle: t("app:commands.settings.subtitle"),
        icon: "settings",
        hint: `${MOD_LABEL},`,
        keywords: t("app:commands.settings.keywords"),
        run: () => setSettingsOpen(true),
      },
      {
        id: "action:toggle-sidebar",
        group: t("app:commands.groupActions"),
        title: sidebarCollapsed ? t("app:commands.toggleSidebar.show") : t("app:commands.toggleSidebar.hide"),
        icon: "sidebar",
        hint: `${MOD_LABEL}B`,
        keywords: t("app:commands.toggleSidebar.keywords"),
        run: () => setSidebarCollapsed((collapsed) => !collapsed),
      },
      {
        id: "action:toggle-theme",
        group: t("app:commands.groupActions"),
        title: resolvedTheme === "dark" ? t("app:commands.toggleTheme.toLight") : t("app:commands.toggleTheme.toDark"),
        icon: resolvedTheme === "dark" ? "sun" : "moon",
        keywords: t("app:commands.toggleTheme.keywords"),
        run: () => toggleTheme(),
      },
      {
        id: "action:font-size-increase",
        group: t("app:commands.groupActions"),
        title: t("app:commands.fontSize.increase.title"),
        icon: "type",
        hint: `${MOD_LABEL}+`,
        keywords: t("app:commands.fontSize.increase.keywords"),
        run: () => increaseFontScale(),
      },
      {
        id: "action:font-size-decrease",
        group: t("app:commands.groupActions"),
        title: t("app:commands.fontSize.decrease.title"),
        icon: "type",
        hint: `${MOD_LABEL}-`,
        keywords: t("app:commands.fontSize.decrease.keywords"),
        run: () => decreaseFontScale(),
      },
      {
        id: "action:font-size-reset",
        group: t("app:commands.groupActions"),
        title: t("app:commands.fontSize.reset.title"),
        icon: "type",
        hint: `${MOD_LABEL}0`,
        keywords: t("app:commands.fontSize.reset.keywords"),
        run: () => resetFontScale(),
      },
    ];

    if (interruptedSessions.length > 0) {
      list.push({
        id: "action:recovery",
        group: t("app:commands.groupActions"),
        title: t("app:commands.recovery.title", { count: interruptedSessions.length }),
        icon: "alert",
        keywords: t("app:commands.recovery.keywords"),
        run: () => setRecoveryOpen(true),
      });
    }

    if (!hasElectronBridge) {
      list.push({
        id: "action:logout",
        group: t("app:commands.groupActions"),
        title: t("app:commands.logout.title"),
        subtitle: t("app:commands.logout.subtitle"),
        icon: "logout",
        tone: "danger",
        keywords: t("app:commands.logout.keywords"),
        run: handleLogout,
      });
    }

    for (const session of sessions.slice().sort((a, b) => b.updatedAt - a.updatedAt)) {
      list.push({
        id: `session:${session.id}`,
        group: t("app:commands.groupSessions"),
        title: session.title,
        subtitle: shortenPath(session.workingDir ?? ""),
        status: sessionStatusMeta(session.status),
        keywords: `${session.adapterType} ${session.workingDir ?? ""}`,
        run: () => {
          void selectSession(session.id);
        },
      });
    }

    return list;
  }, [
    decreaseFontScale,
    handleCreateSession,
    increaseFontScale,
    interruptedSessions.length,
    resetFontScale,
    resolvedTheme,
    selectSession,
    availableProviders,
    detectedAgents,
    effectiveSelection.providerId,
    providerPrefs,
    sessions,
    sidebarCollapsed,
    toggleTheme,
    t,
  ]);

  if (!hasElectronBridge && !browserReady) {
    return <ConnectScreen onConnected={handleConnected} />;
  }

  return (
    <div className="app-shell flex w-screen flex-col overflow-hidden bg-canvas text-fg antialiased">
      {/*
        連線異常提示條:**只有不健康時才出現**(改版前不論狀態都佔著頂列一格)。
        連線正常時的指示縮成側欄標頭的綠點,零成本。
      */}
      {status !== "open" && (
        <div
          className={`flex flex-shrink-0 animate-slide-down items-center gap-2 px-3 py-1.5 text-xs ${
            status === "connecting" ? "bg-warn/12 text-warn" : "bg-danger/12 text-danger"
          }`}
          role="status"
        >
          {status === "connecting" ? <Spinner size={12} /> : <Icon name="alert" size={13} />}
          {status === "connecting" ? t("app:connectionBanner.connecting") : t("app:connectionBanner.disconnected")}
        </div>
      )}

      {/*
        S6(crash-recovery)L4 §5.4:「入口是常駐提示條,不是強制彈窗」——有
        `interrupted` session 時這條提示持續可見,點擊才開啟復原視圖。改版把它從
        頂列的一顆小膠囊改成整條提示條:這是「需要人介入」的訊號,原本混在一排
        小按鈕裡太容易被忽略,而它的代價只在真的有中斷 session 時才付出。
      */}
      {interruptedSessions.length > 0 && (
        <div className="flex flex-shrink-0 animate-slide-down items-center gap-2 bg-warn/12 px-3 py-1.5 text-xs text-warn">
          <Icon name="alert" size={13} />
          <span className="min-w-0 flex-1 truncate">
            {/* i18n 專案新增:用 Trans 而非 t() 字串——原本的視覺設計要求數字
                本身用 tabular/半粗體樣式跟句子其餘部分區隔開,Trans 讓翻譯後的
                句子仍能把 <strong> 包住的片段對應回這個樣式節點,不必為了改用
                t() 而犧牲既有視覺效果(見 react-i18next 官方 Trans 用法)。 */}
            <Trans
              i18nKey="app:interruptedBanner.message"
              values={{ count: interruptedSessions.length }}
              components={{ strong: <span className="tabular font-semibold" /> }}
            />
          </span>
          <Button size="xs" variant="secondary" onClick={() => setRecoveryOpen(true)}>
            {t("app:interruptedBanner.action")}
          </Button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {sidebarOpen && (
          <div
            className="fixed inset-0 z-30 bg-scrim/50 sm:hidden"
            onClick={() => setSidebarOpen(false)}
            aria-hidden="true"
          />
        )}
        <SessionList
          mobileOpen={sidebarOpen}
          onCloseMobile={() => setSidebarOpen(false)}
          collapsed={sidebarCollapsed}
          onToggleCollapsed={() => setSidebarCollapsed((collapsed) => !collapsed)}
          connectionStatus={status}
          selection={selection}
          onChangeSelection={handleChangeSelection}
          defaultWorkingDir={defaultWorkingDir}
          onCreateSession={() => void handleCreateSession()}
          creatingSession={creatingSession}
          createError={createError}
          onDismissCreateError={() => setCreateError(null)}
          onOpenPalette={() => setPaletteOpen(true)}
          onOpenSettings={() => setSettingsOpen(true)}
          themePreference={themePreference}
          resolvedTheme={resolvedTheme}
          onToggleTheme={toggleTheme}
          onLogout={hasElectronBridge ? undefined : handleLogout}
        />
        {/*
          2026-09-04(稽核修補):每個主要視圖各自包一層 ErrorBoundary。
          這一層才是有價值的隔離 —— 一個 session 的聊天內容(渲染的是 agent
          產生的不可信 markdown/工具輸出)炸掉時,側邊欄、指令面板、其他視圖
          仍然可用。`resetKey` 綁 currentSessionId:切到別的 session 會自動清掉
          錯誤狀態,不會一路卡著同一張錯誤畫面。
        */}
        <ErrorBoundary label="聊天視圖" resetKey={currentSessionId ?? ""}>
          <SessionView onOpenSidebar={() => setSidebarOpen(true)} />
        </ErrorBoundary>
      </div>

      {/* 對話框各自也包一層:一個對話框壞掉不該把底下的主畫面一起帶走。 */}
      <ErrorBoundary label="權限請求">
        <PermissionModal />
      </ErrorBoundary>
      {settingsOpen && (
        <ErrorBoundary label="設定">
          <SettingsDialog onClose={() => setSettingsOpen(false)} />
        </ErrorBoundary>
      )}
      {recoveryOpen && (
        <ErrorBoundary label="崩潰復原">
          <RecoveryView onClose={() => setRecoveryOpen(false)} />
        </ErrorBoundary>
      )}
      {paletteOpen && <CommandPalette commands={commands} onClose={() => setPaletteOpen(false)} />}
      {/* 放最後:確認框可能從上面任何一個對話框裡叫出來(例如復原視圖),要疊在它們上面。 */}
      <ErrorBoundary label="確認框">
        <ConfirmDialogHost />
      </ErrorBoundary>
    </div>
  );
}
