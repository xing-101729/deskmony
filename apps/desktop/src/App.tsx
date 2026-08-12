import { useCallback, useEffect, useMemo, useState } from "react";
import type { AgentOverride } from "@deskmony/shared";
import { client, useSessionStore } from "./stores/session-store.js";
import { useTeamStore } from "./stores/team-store.js";
import { useRecoveryStore } from "./stores/recovery-store.js";
import { SessionList } from "./views/SessionList.js";
import { SessionView } from "./views/SessionView.js";
import { TeamChatView } from "./views/TeamChatView.js";
import { TaskBoardView } from "./views/TaskBoardView.js";
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
import { shortenPath } from "./lib/workspaces.js";

export type ViewMode = "session" | "team-chat" | "task-board";

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
 * 登出;側欄只有一條扁平的 session 清單。問題是「導覽」與「狀態」混在同一列,
 * 而永遠健康的東西(連線正常)卻永久佔著位置。
 *
 * 改版後(對齊 Linear / Cursor 的作法):
 *   - **導覽全部進側欄**(見 views/SessionList.tsx):視圖切換 → 工作區 →
 *     session,形成三層可掃視的階層;每個視圖自己的標頭負責「這個畫面的」標題
 *     與動作,不再與全域導覽競爭。
 *   - **頂部不再有常駐列**:改成「只有異常時才出現」的提示條(連線中斷、有
 *     中斷的 session 待分流)。健康狀態下整個垂直空間都留給內容——這是提高
 *     資訊密度最直接的一刀。連線正常時的狀態指示縮成側欄標頭的一個圓點。
 *   - **命令面板(⌘K)+ 全域快捷鍵**:所有導覽與常用動作都能不碰滑鼠完成。
 *
 * 行為完全不變:Electron 自動連線、瀏覽器先走 ConnectScreen、通知點擊聚焦
 * session、三個視圖與所有彈窗的觸發條件都與改版前一致。
 */
export default function App(): JSX.Element {
  const connect = useSessionStore((s) => s.connect);
  const status = useSessionStore((s) => s.status);
  const sessions = useSessionStore((s) => s.sessions);
  const profiles = useSessionStore((s) => s.profiles);
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const selectSession = useSessionStore((s) => s.selectSession);
  const createSession = useSessionStore((s) => s.createSession);
  const initTeams = useTeamStore((s) => s.init);
  const initRecovery = useRecoveryStore((s) => s.init);
  const interruptedSessions = useRecoveryStore((s) => s.sessions);
  const themePreference = useTheme((s) => s.preference);
  const resolvedTheme = useTheme((s) => s.resolved);
  const toggleTheme = useTheme((s) => s.toggle);

  const [viewMode, setViewMode] = useState<ViewMode>("session");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [browserReady, setBrowserReady] = useState(hasElectronBridge);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [profileDialogOpen, setProfileDialogOpen] = useState(false);
  /**
   * 建立 session 用的 profile 選擇 —— 改版時從 SessionList 提升到這一層,因為
   * 現在有**兩個**入口會用到它(側欄的「新對話」按鈕、命令面板的「新對話」
   * 指令),兩者必須共用同一個「目前選了哪個 profile」,否則⌘N 建出來的 session
   * 會與側欄下拉顯示的不一致。
   */
  const [selectedProfileId, setSelectedProfileId] = useState<string>("");
  const [creatingSession, setCreatingSession] = useState(false);

  useEffect(() => {
    if (!hasElectronBridge) return; // 瀏覽器場景:等 ConnectScreen 驗證成功才連線
    connect();
    initTeams();
    initRecovery();
  }, [connect, initTeams, initRecovery]);

  /**
   * S11(Notification):使用者點擊桌面原生通知後,main process 透過
   * `deskmony:notification-clicked` 把對應的 `sessionId` 轉發過來——切回
   * 「Session 視圖」並聚焦到那個 session。純瀏覽器場景沒有
   * `onNotificationClick`,這個 effect 直接 no-op。
   */
  useEffect(() => {
    const unsubscribe = window.deskmony?.onNotificationClick?.((sessionId) => {
      setViewMode("session");
      void useSessionStore.getState().selectSession(sessionId);
    });
    return unsubscribe;
  }, []);

  // profiles 是非同步載入的;第一次拿到清單、或目前選取的 profile 不再存在時,
  // 自動選第一筆(邏輯與改版前 SessionList 內的同名 effect 相同)。
  useEffect(() => {
    if (profiles.length === 0) return;
    if (!selectedProfileId || !profiles.some((p) => p.id === selectedProfileId)) {
      setSelectedProfileId(profiles[0].id);
    }
  }, [profiles, selectedProfileId]);

  const selectedProfile = profiles.find((p) => p.id === selectedProfileId);

  /** agentOverride 選填——⌘N/命令面板呼叫時省略(維持既有「一鍵用目前 profile
   *  建立」的快速路徑不變);SessionList 的「進階」揭露區展開並選了覆寫時,由
   *  按鈕點擊那條路徑帶入,見該檔案 onCreateSession 的呼叫處。 */
  const handleCreateSession = useCallback(
    async (agentOverride?: AgentOverride): Promise<void> => {
      const profile = selectedProfile ?? profiles[0];
      if (!profile) return;
      setCreatingSession(true);
      try {
        await createSession(profile.id, profile.workingDir, `對話 ${sessions.length + 1}`, undefined, agentOverride);
        setViewMode("session");
      } finally {
        setCreatingSession(false);
      }
    },
    [createSession, profiles, selectedProfile, sessions.length],
  );

  const handleConnected = (url: string, token: string): void => {
    client.configure(url, token);
    connect();
    initTeams();
    initRecovery();
    setBrowserReady(true);
  };

  const handleLogout = (): void => {
    clearSavedConnection();
    // 整頁重新整理回到最單純的初始狀態(WS 連線正確關閉、session/team/task
    // 三個 store 的殘留資料一併清空),比逐一手動重置每個 store 簡單可靠。
    window.location.reload();
  };

  /** ⌥↑/⌥↓:在側欄目前排序下切換上一個/下一個 session(不碰滑鼠巡邏 agent)。 */
  const cycleSession = useCallback(
    (delta: number): void => {
      const ordered = sessions.slice().sort((a, b) => b.updatedAt - a.updatedAt);
      if (ordered.length === 0) return;
      const index = ordered.findIndex((s) => s.id === currentSessionId);
      const next = ordered[(index + delta + ordered.length) % ordered.length];
      setViewMode("session");
      void selectSession(next.id);
    },
    [currentSessionId, selectSession, sessions],
  );

  useHotkeys(
    useMemo(
      () => [
        { combo: "mod+k", handler: () => setPaletteOpen(true), allowInTerminal: true },
        { combo: "mod+shift+p", handler: () => setPaletteOpen(true), allowInTerminal: true },
        { combo: "mod+1", handler: () => setViewMode("session") },
        { combo: "mod+2", handler: () => setViewMode("team-chat") },
        { combo: "mod+3", handler: () => setViewMode("task-board") },
        { combo: "mod+b", handler: () => setSidebarCollapsed((collapsed) => !collapsed) },
        { combo: "mod+n", handler: () => void handleCreateSession() },
        { combo: "mod+,", handler: () => setSettingsOpen(true) },
        { combo: "alt+arrowdown", handler: () => cycleSession(1), allowInTerminal: true },
        { combo: "alt+arrowup", handler: () => cycleSession(-1), allowInTerminal: true },
      ],
      [cycleSession, handleCreateSession],
    ),
  );

  /** 命令面板的指令清單——每一項都對應畫面上原本就存在的入口,不新增能力。 */
  const commands = useMemo<Command[]>(() => {
    const list: Command[] = [
      {
        id: "view:session",
        group: "前往",
        title: "Session 視圖",
        icon: "message",
        hint: `${MOD_LABEL}1`,
        keywords: "session chat 對話",
        run: () => setViewMode("session"),
      },
      {
        id: "view:team-chat",
        group: "前往",
        title: "團隊群聊",
        icon: "users",
        hint: `${MOD_LABEL}2`,
        keywords: "team chat 群聊 訊息",
        run: () => setViewMode("team-chat"),
      },
      {
        id: "view:task-board",
        group: "前往",
        title: "任務看板",
        icon: "board",
        hint: `${MOD_LABEL}3`,
        keywords: "task board kanban 任務",
        run: () => setViewMode("task-board"),
      },
      {
        id: "action:new-session",
        group: "動作",
        title: "新對話",
        subtitle: selectedProfile ? `使用 Profile:${selectedProfile.name}` : "尚無可用的 Agent Profile",
        icon: "plus",
        hint: `${MOD_LABEL}N`,
        keywords: "new session create 建立 對話",
        run: () => void handleCreateSession(),
      },
      {
        id: "action:new-profile",
        group: "動作",
        title: "建立 Agent Profile",
        icon: "sparkle",
        keywords: "profile agent provider 建立",
        run: () => setProfileDialogOpen(true),
      },
      {
        id: "action:settings",
        group: "動作",
        title: "設定",
        subtitle: "全域設定 · 通知 · Provider 管理",
        icon: "settings",
        hint: `${MOD_LABEL},`,
        keywords: "settings config provider model 設定",
        run: () => setSettingsOpen(true),
      },
      {
        id: "action:toggle-sidebar",
        group: "動作",
        title: sidebarCollapsed ? "顯示側欄" : "收合側欄",
        icon: "sidebar",
        hint: `${MOD_LABEL}B`,
        keywords: "sidebar 側欄 collapse",
        run: () => setSidebarCollapsed((collapsed) => !collapsed),
      },
      {
        id: "action:toggle-theme",
        group: "動作",
        title: resolvedTheme === "dark" ? "切換為淺色主題" : "切換為深色主題",
        icon: resolvedTheme === "dark" ? "sun" : "moon",
        keywords: "theme dark light 主題 深色 淺色",
        run: () => toggleTheme(),
      },
    ];

    if (interruptedSessions.length > 0) {
      list.push({
        id: "action:recovery",
        group: "動作",
        title: `復原中斷的 session(${interruptedSessions.length})`,
        icon: "alert",
        keywords: "recovery crash 中斷 復原",
        run: () => setRecoveryOpen(true),
      });
    }

    if (!hasElectronBridge) {
      list.push({
        id: "action:logout",
        group: "動作",
        title: "登出",
        subtitle: "清除已儲存的 token 並回到連線畫面",
        icon: "logout",
        tone: "danger",
        keywords: "logout signout 登出",
        run: handleLogout,
      });
    }

    for (const session of sessions.slice().sort((a, b) => b.updatedAt - a.updatedAt)) {
      list.push({
        id: `session:${session.id}`,
        group: "對話",
        title: session.title,
        subtitle: shortenPath(session.workingDir ?? ""),
        status: sessionStatusMeta(session.status),
        keywords: `${session.adapterType} ${session.workingDir ?? ""}`,
        run: () => {
          setViewMode("session");
          void selectSession(session.id);
        },
      });
    }

    return list;
  }, [
    handleCreateSession,
    interruptedSessions.length,
    resolvedTheme,
    selectSession,
    selectedProfile,
    sessions,
    sidebarCollapsed,
    toggleTheme,
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
          {status === "connecting" ? "正在連線到 Deskmony Core…" : "與 Deskmony Core 的連線已中斷,正在自動重試…"}
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
            上次未被乾淨關閉,有 <span className="tabular font-semibold">{interruptedSessions.length}</span>{" "}
            個 session 需要人工分流(繼續 / 接手 / 重跑 / 放棄)
          </span>
          <Button size="xs" variant="secondary" onClick={() => setRecoveryOpen(true)}>
            開始分流
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
          viewMode={viewMode}
          onChangeView={setViewMode}
          connectionStatus={status}
          selectedProfileId={selectedProfileId}
          onSelectProfile={setSelectedProfileId}
          onCreateSession={(override) => void handleCreateSession(override)}
          creatingSession={creatingSession}
          profileDialogOpen={profileDialogOpen}
          onSetProfileDialogOpen={setProfileDialogOpen}
          onOpenPalette={() => setPaletteOpen(true)}
          onOpenSettings={() => setSettingsOpen(true)}
          themePreference={themePreference}
          resolvedTheme={resolvedTheme}
          onToggleTheme={toggleTheme}
          onLogout={hasElectronBridge ? undefined : handleLogout}
        />
        {viewMode === "session" && <SessionView onOpenSidebar={() => setSidebarOpen(true)} />}
        {viewMode === "team-chat" && <TeamChatView onOpenSidebar={() => setSidebarOpen(true)} />}
        {viewMode === "task-board" && <TaskBoardView onOpenSidebar={() => setSidebarOpen(true)} />}
      </div>

      <PermissionModal />
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
      {recoveryOpen && <RecoveryView onClose={() => setRecoveryOpen(false)} />}
      {paletteOpen && <CommandPalette commands={commands} onClose={() => setPaletteOpen(false)} />}
    </div>
  );
}
