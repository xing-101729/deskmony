import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { Session } from "@deskmony/shared";
import { useSessionStore, selectContextReporting, selectAvailableProviders } from "../stores/session-store.js";
import { AgentPicker } from "./AgentPicker.js";
import { Icon } from "../ui/icons.js";
import { Button, IconButton, Kbd } from "../ui/Button.js";
import { Field, Input, Textarea } from "../ui/Field.js";
import { StatusDot, Meta } from "../ui/Badge.js";
import { Alert, EmptyState } from "../ui/Feedback.js";
import { Dialog } from "../ui/Dialog.js";
import { sessionStatusMeta, softwareLabel } from "../ui/status.js";
import { MOD_LABEL } from "../ui/hotkeys.js";
import type { ThemePreference, ResolvedTheme } from "../ui/theme.js";
import { useLocale } from "../ui/locale.js";
import { LOCALES, type Locale } from "../lib/locale-storage.js";
import { FONT_SCALES, useFontScale } from "../ui/font-scale.js";
import { groupSessionsByWorkspace } from "../lib/workspaces.js";
import { translateError } from "../lib/error-i18n.js";
import { reconcileSelection, type NewSessionSelection } from "../lib/new-session-selection.js";

/**
 * S3a(usage-metering)L4 §4:「SessionList 每列顯示 context 使用率(如 32%)」。
 * size 為 0 時避免除以 0。
 */
function formatContextUsage(usage: { contextUsed?: number; contextSize?: number } | undefined): string | undefined {
  if (!usage || usage.contextUsed === undefined || !usage.contextSize) return undefined;
  const pct = Math.round((usage.contextUsed / usage.contextSize) * 100);
  return `${pct}%`;
}

/** 非文字樣式——`label` 拆出去用 i18next 動態查,這裡只留圓點顏色。 */
const CONNECTION_DOT: Record<string, string> = {
  open: "bg-ok",
  connecting: "bg-warn",
  closed: "bg-danger",
};

/** i18n 專案新增:比照 ui/status.ts 的 sessionStatusMeta() 作法——`label` 不能
 *  再是模組載入當下就算好的靜態字串(否則語言切換後永遠停在第一次載入時的
 *  語言),改成純函式,由呼叫端(SessionList 元件本體)把 useTranslation() 拿
 *  到的 `t` 傳進來,在使用當下才查表(比照 lib/error-i18n.ts 的
 *  translateError() 慣例,不直接 import i18next 單例——這個檔案是元件檔,
 *  有 hook 可用)。 */
function connectionMeta(status: string, t: TFunction): { label: string; dot: string } {
  const key = status in CONNECTION_DOT ? status : "closed";
  return { label: t(`sessionList:connection.${key}`), dot: CONNECTION_DOT[key] };
}

interface SessionListProps {
  mobileOpen: boolean;
  onCloseMobile: () => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  connectionStatus: string;
  /** 2026-10-02(P2:移除 profile):「新對話」選的 agent/model/effort/資料夾,由 App.tsx 持有
   *  (⌘N/命令面板共用同一份,上次的選擇存 localStorage)。 */
  selection: NewSessionSelection;
  onChangeSelection: (next: NewSessionSelection) => void;
  /** core 的預設工作資料夾(資料夾欄位留空時實際會用的值,只當 placeholder 顯示)。 */
  defaultWorkingDir: string;
  onCreateSession: () => void;
  creatingSession: boolean;
  /** 建立失敗(agent 沒裝/被停用/啟動失敗…)的訊息,顯示在「新對話」按鈕下方。 */
  createError: string | null;
  onDismissCreateError: () => void;
  onOpenPalette: () => void;
  onOpenSettings: () => void;
  themePreference: ThemePreference;
  resolvedTheme: ResolvedTheme;
  onToggleTheme: () => void;
  onLogout?: () => void;
}

/**
 * ---------------------------------------------------------------------------
 * 側欄(UI/UX 改版:承接原本頂列的導覽責任 + 新增工作區分組)
 * ---------------------------------------------------------------------------
 *
 * 這是這輪改版變動最大的檔案,一次做了三件事(對應題目「強化 Sidebar 階層」
 * 「支援多工作區」「Agent 狀態一眼可辨識」):
 *
 *   1. **導覽收斂到側欄**:原本在 App.tsx 頂列的三個視圖切換鈕搬進來,變成
 *      垂直的導覽項目——這讓側欄從「只是 session 清單」升格成整個 app 的導覽
 *      骨幹,頂部因此完全空出來給內容用。(2026-10-02:團隊群聊與任務看板視圖
 *      已移除,見 docs/DECISIONS.md §H,只剩 session 視圖,導覽項目整個拿掉。)
 *   2. **工作區分組**:`groupSessionsByWorkspace()`(lib/workspaces.ts)依
 *      `session.workingDir` 把 session 分堆,每組是一個可摺疊的區塊,標題列
 *      顯示工作區名稱 + 「有幾個在等你」的計數——這是「同時開多個專案」的
 *      power user 最需要的資訊架構,原本的扁平清單完全沒有這層。
 *   3. **可收合成圖示列**:比照 VS Code/Cursor 的 activity bar,`collapsed`
 *      時只留圖示,滑鼠 hover 用 `title` 顯示文字(⌘B 切換)。
 *
 * 2026-10-02(P2:移除 profile):頂部的「選 profile」下拉 + 「+ Profile」/刪除 profile 兩顆鈕整個換成
 * `AgentPicker`(agent 下拉 + model 下拉 + effort + 資料夾)+「新對話」鈕;選擇狀態由 App.tsx 持有。
 */
export function SessionList({
  mobileOpen,
  onCloseMobile,
  collapsed,
  onToggleCollapsed,
  connectionStatus,
  selection,
  onChangeSelection,
  defaultWorkingDir,
  onCreateSession,
  creatingSession,
  createError,
  onDismissCreateError,
  onOpenPalette,
  onOpenSettings,
  themePreference,
  resolvedTheme,
  onToggleTheme,
  onLogout,
}: SessionListProps): JSX.Element {
  const { t } = useTranslation(["sessionList", "common"]);
  const sessions = useSessionStore((s) => s.sessions);
  const sessionUsage = useSessionStore((s) => s.sessionUsage);
  const capabilitiesBySoftware = useSessionStore((s) => s.capabilitiesBySoftware);
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const selectSession = useSessionStore((s) => s.selectSession);
  const deleteSession = useSessionStore((s) => s.deleteSession);
  const detectedAgents = useSessionStore((s) => s.detectedAgents);
  const providerPrefs = useSessionStore((s) => s.providerPrefs);
  const [collapsedWorkspaces, setCollapsedWorkspaces] = useState<Set<string>>(new Set());
  const [spawnParent, setSpawnParent] = useState<Session | null>(null);

  // 有沒有「現在真的能開 session」的 agent——沒有時「新對話」鈕停用(AgentPicker 會顯示說明 + 重新偵測)。
  const availableProviders = useMemo(
    () => selectAvailableProviders(detectedAgents, providerPrefs),
    [detectedAgents, providerPrefs],
  );
  const workspaces = useMemo(
    () => groupSessionsByWorkspace(sessions, t("sessionList:unnamedWorkspace")),
    [sessions, t],
  );
  const conn = connectionMeta(connectionStatus, t);

  /**
   * 刪除對話:原生 `confirm()` 二次確認(既有作法維持不變)——低頻、不可逆但
   * 影響範圍單一的操作,原生確認框已足夠。`stopPropagation()` 避免同時觸發
   * 外層的 selectSession()。
   */
  const handleDelete = (sessionId: string, title: string): void => {
    if (!window.confirm(t("sessionList:confirmDeleteSession", { title }))) return;
    void deleteSession(sessionId);
  };

  const toggleWorkspace = (key: string): void => {
    setCollapsedWorkspaces((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  /** S12 Phase2 R3:單一 session 列(頂層與縮排的子 session 共用同一份 JSX,
   *  只是子列多 `pl-4` 縮排 + 標題前綴 `↳`)。 */
  const renderSessionRow = (session: Session, isChild: boolean): JSX.Element => {
    const meta = sessionStatusMeta(session.status);
    const contextPct =
      selectContextReporting(capabilitiesBySoftware[session.adapterType], sessionUsage[session.id]) === "supported"
        ? (formatContextUsage(sessionUsage[session.id]) ?? "—")
        : undefined;
    return (
      <div
        key={session.id}
        className={`group flex items-stretch gap-0.5 rounded-md transition ${isChild ? "pl-4" : ""} ${
          session.id === currentSessionId ? "bg-surface-2" : "hover:bg-surface"
        }`}
      >
        <button
          type="button"
          onClick={() => {
            void selectSession(session.id);
            onCloseMobile();
          }}
          className="focus-ring min-w-0 flex-1 rounded-md py-2 pl-2.5 pr-1 text-left"
        >
          <div className="flex items-center gap-1.5">
            <StatusDot meta={meta} />
            <span className={`truncate text-xs ${session.id === currentSessionId ? "font-medium text-fg" : "text-fg-soft"}`}>
              {isChild && <span className="text-fg-faint">↳ </span>}
              {session.title}
            </span>
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 pl-3">
            <Meta className="text-fg-faint">{meta.label}</Meta>
            <span className="text-fg-faint">·</span>
            <Meta mono>{softwareLabel(session.adapterType)}</Meta>
            {contextPct && (
              <>
                <span className="text-fg-faint">·</span>
                <Meta mono title={t("sessionList:contextUsageTitle")}>
                  ctx {contextPct}
                </Meta>
              </>
            )}
          </div>
        </button>
        <IconButton
          icon="branch"
          aria-label={t("sessionList:spawnChildAriaLabel")}
          title={t("sessionList:spawnChildTitle")}
          size="xs"
          className="my-auto opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
          onClick={(e) => {
            e.stopPropagation();
            setSpawnParent(session);
          }}
        />
        <IconButton
          icon="trash"
          aria-label={t("sessionList:deleteSessionAriaLabel")}
          title={t("sessionList:deleteSessionAriaLabel")}
          size="xs"
          className="my-auto mr-1 opacity-0 hover:!text-danger focus-visible:opacity-100 group-hover:opacity-100"
          onClick={(e) => {
            e.stopPropagation();
            handleDelete(session.id, session.title);
          }}
        />
      </div>
    );
  };

  if (collapsed) {
    return (
      <aside className="hidden w-13 flex-shrink-0 flex-col items-center border-r border-line-subtle bg-panel py-2 sm:flex">
        <IconButton icon="sidebar" aria-label={t("sessionList:expandSidebarAriaLabel")} onClick={onToggleCollapsed} className="mb-2" />
        <div className="flex flex-1 flex-col items-center gap-1" />
        <div className="flex flex-col items-center gap-1">
          <IconButton
            icon="search"
            aria-label={t("sessionList:commandPaletteAriaLabel")}
            title={`${t("sessionList:commandPaletteAriaLabel")}(${MOD_LABEL}K)`}
            onClick={onOpenPalette}
          />
          <IconButton icon="settings" aria-label={t("sessionList:settingsAriaLabel")} onClick={onOpenSettings} />
          <span className={`h-1.5 w-1.5 rounded-full ${conn.dot}`} title={conn.label} />
        </div>
      </aside>
    );
  }

  return (
    <aside
      className={`fixed inset-y-0 left-0 z-40 flex h-full w-64 flex-shrink-0 flex-col border-r border-line-subtle bg-panel transition-transform duration-200 sm:static sm:z-auto sm:translate-x-0 ${
        mobileOpen ? "translate-x-0" : "-translate-x-full"
      }`}
    >
      {/* ---- 品牌 / 連線狀態 / 收合 ---- */}
      <div className="flex h-11 flex-shrink-0 select-chrome items-center gap-2 px-3">
        <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${conn.dot}`} title={conn.label} />
        <span className="truncate text-sm font-semibold tracking-tight text-fg">Deskmony</span>
        <div className="ml-auto flex items-center gap-0.5">
          <IconButton
            icon="sidebar"
            aria-label={t("sessionList:collapseSidebarAriaLabel")}
            title={`${t("sessionList:collapseSidebarAriaLabel")}(${MOD_LABEL}B)`}
            onClick={onToggleCollapsed}
            className="hidden sm:inline-flex"
          />
          <IconButton icon="x" aria-label={t("sessionList:closeSidebarAriaLabel")} onClick={onCloseMobile} className="sm:hidden" />
        </div>
      </div>

      {/* ---- 命令面板觸發 ---- */}
      <div className="flex-shrink-0 px-2 pb-2">
        <button
          type="button"
          onClick={onOpenPalette}
          className="focus-ring flex h-7 w-full items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 text-xs text-fg-faint transition hover:border-line-strong hover:text-fg-subtle"
        >
          <Icon name="search" size={12} />
          <span className="flex-1 text-left">{t("sessionList:paletteTriggerLabel")}</span>
          <Kbd>{MOD_LABEL}K</Kbd>
        </button>
      </div>

      <div className="mx-3 mb-2 h-px flex-shrink-0 bg-line-subtle" />

      {/* ---- Agent / model 選單 + 新對話 ---- */}
      <div className="flex-shrink-0 space-y-1.5 px-2 pb-2">
        <AgentPicker
          selection={selection}
          onChange={onChangeSelection}
          compact
          showWorkingDir
          defaultWorkingDir={defaultWorkingDir}
        />
        <Button
          variant="primary"
          size="sm"
          icon="plus"
          block
          loading={creatingSession}
          disabled={availableProviders.length === 0}
          onClick={() => {
            onDismissCreateError();
            onCreateSession();
          }}
          title={`${t("sessionList:newSessionButton")}(${MOD_LABEL}N)`}
        >
          {creatingSession ? t("sessionList:creating") : t("sessionList:newSessionButton")}
        </Button>
        {createError && (
          <Alert tone="danger" onDismiss={onDismissCreateError}>
            {createError}
          </Alert>
        )}
      </div>

      {/* ---- 工作區分組的 session 清單 ---- */}
      <div className="flex-1 space-y-2.5 overflow-y-auto px-2 pb-2 pt-1">
        {sessions.length === 0 && (
          <EmptyState
            icon="message"
            title={t("sessionList:emptyTitle")}
            description={t("sessionList:emptyDescription")}
            compact
          />
        )}
        {workspaces.map((workspace) => {
          const isCollapsed = collapsedWorkspaces.has(workspace.key);
          return (
            <div key={workspace.key}>
              {/* 只有多於一個工作區時才顯示分組標題——單一專案場景維持原本的
                  純清單感,不強加一層永遠只有一個成員的分組視覺。 */}
              {workspaces.length > 1 && (
                <button
                  type="button"
                  onClick={() => toggleWorkspace(workspace.key)}
                  title={workspace.path}
                  className="focus-ring flex h-6 w-full items-center gap-1 rounded px-1 text-left transition hover:bg-surface"
                >
                  <Icon
                    name="chevron-right"
                    size={11}
                    className={`flex-shrink-0 text-fg-faint transition-transform ${isCollapsed ? "" : "rotate-90"}`}
                  />
                  <Icon name="folder" size={11} className="flex-shrink-0 text-fg-faint" />
                  <span className="min-w-0 flex-1 truncate text-2xs font-semibold uppercase tracking-[0.04em] text-fg-subtle">
                    {workspace.name}
                  </span>
                  {workspace.waitingCount > 0 && (
                    <span
                      className="h-1.5 w-1.5 flex-shrink-0 animate-breathe rounded-full bg-warn"
                      title={t("sessionList:waitingForAuthTitle")}
                    />
                  )}
                  <span className="tabular flex-shrink-0 text-2xs text-fg-faint">{workspace.sessions.length}</span>
                </button>
              )}
              {!isCollapsed && (
                <div className="mt-0.5 space-y-0.5">
                  {(() => {
                    // S12 Phase2 R3:先渲染頂層(parentSessionId 為空),每個頂層底下
                    // 緊接著縮排渲染它的子 session。父不在本組/不存在的孤兒子要退化成
                    // 頂層列補渲染,不可消失(用 renderedIds 去重,避免同一 session 畫兩次)。
                    const all = workspace.sessions;
                    const renderedIds = new Set<string>();
                    const order: { session: Session; isChild: boolean }[] = [];
                    for (const s of all.filter((s) => !s.parentSessionId)) {
                      order.push({ session: s, isChild: false });
                      renderedIds.add(s.id);
                      for (const child of all.filter((c) => c.parentSessionId === s.id)) {
                        order.push({ session: child, isChild: true });
                        renderedIds.add(child.id);
                      }
                    }
                    for (const s of all) {
                      if (!renderedIds.has(s.id)) {
                        order.push({ session: s, isChild: false });
                        renderedIds.add(s.id);
                      }
                    }
                    return order.map(({ session, isChild }) => renderSessionRow(session, isChild));
                  })()}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* ---- 底部工具列 ---- */}
      <div className="flex flex-shrink-0 items-center gap-0.5 border-t border-line-subtle px-2.5 py-2">
        <IconButton
          icon={resolvedTheme === "dark" ? "moon" : "sun"}
          aria-label={t("sessionList:toggleThemeAriaLabel")}
          title={
            themePreference === "system"
              ? t("sessionList:theme.system")
              : resolvedTheme === "dark"
                ? t("sessionList:theme.darkClickForLight")
                : t("sessionList:theme.lightClickForDark")
          }
          onClick={onToggleTheme}
        />
        <LanguageSwitcher />
        <FontScaleSwitcher />
        <IconButton
          icon="settings"
          aria-label={t("sessionList:settingsAriaLabel")}
          title={`${t("sessionList:settingsAriaLabel")}(${MOD_LABEL},)`}
          onClick={onOpenSettings}
        />
        {onLogout && (
          <IconButton
            icon="logout"
            aria-label={t("sessionList:logoutAriaLabel")}
            title={t("sessionList:logoutAriaLabel")}
            className="ml-auto hover:!text-danger"
            onClick={onLogout}
          />
        )}
      </div>

      {spawnParent && <SpawnChildDialog session={spawnParent} onClose={() => setSpawnParent(null)} />}
    </aside>
  );
}

/** 4 個語言各自的顯示名稱——用該語言自己的文字寫(中文/English/日本語/
 *  Español),這是專有名詞(語言名稱本身),不透過 i18next 翻譯。 */
const LANGUAGE_NAMES: Record<Locale, string> = {
  "zh-Hant": "中文",
  en: "English",
  ja: "日本語",
  es: "Español",
};

/**
 * 語言切換器——底部工具列的一顆 IconButton,點擊展開一個極簡的清單選單。
 *
 * 這裡沒有沿用 CommandPalette.tsx(全螢幕 modal + ModalPortal)或
 * Dialog.tsx(置中對話框)的樣式,兩者都是給「有明確標題/內容」的較重量級
 * 彈窗用的;這只是 4 個選項的小選單,比照一般 UI 慣例做成錨定在按鈕旁的
 * absolute 定位小面板,搭配一個鋪滿全螢幕的透明按鈕當「點外面關閉」的判定
 * (寫法上與 CommandPalette 的背景 `onMouseDown` 關閉判斷同樣目的,只是這裡
 * 不需要真的畫一層背景遮罩)。
 */
function LanguageSwitcher(): JSX.Element {
  const { t } = useTranslation(["sessionList"]);
  const locale = useLocale((s) => s.locale);
  const setLocale = useLocale((s) => s.setLocale);
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <IconButton
        icon="command"
        aria-label={t("sessionList:languageSwitcher.toggleLabel")}
        title={t("sessionList:languageSwitcher.toggleLabel")}
        active={open}
        onClick={() => setOpen((v) => !v)}
      />
      {open && (
        <>
          {/* 點外面關閉——這裡不需要 CommandPalette 那種 target===currentTarget
              判斷,因為選單本身是這層的手足節點而非子節點,這一層背後沒有
              任何東西可點。 */}
          <div className="fixed inset-0 z-40" onMouseDown={() => setOpen(false)} />
          <div
            role="menu"
            aria-label={t("sessionList:languageSwitcher.menuLabel")}
            className="absolute bottom-full left-0 z-50 mb-1 w-28 overflow-hidden rounded-md border border-line-subtle bg-panel py-1 shadow-overlay"
          >
            {LOCALES.map((l) => (
              <button
                key={l}
                type="button"
                role="menuitemradio"
                aria-checked={l === locale}
                onClick={() => {
                  setLocale(l);
                  setOpen(false);
                }}
                className={`flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left text-xs transition hover:bg-surface ${
                  l === locale ? "font-medium text-fg" : "text-fg-soft"
                }`}
              >
                {LANGUAGE_NAMES[l]}
                {l === locale && <Icon name="check" size={11} className="text-accent" />}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * 字級切換器——側欄底部工具列緊接在 LanguageSwitcher 旁邊的另一顆
 * IconButton,樣式與互動完全比照上面的 LanguageSwitcher(錨定在按鈕旁的小
 * 選單,不是 CommandPalette/Dialog 那種全螢幕或置中的重量級彈窗):同樣只是
 * 4 個選項的極簡選單,沒有理由自己另外發明一套樣式。
 *
 * 與 LanguageSwitcher 的差異只有一點:選項標籤(小/預設/大/特大)要透過
 * i18next 查表(`sessionList:fontScale.options.*`)。LANGUAGE_NAMES 是語言
 * 自己的專有名詞、刻意不翻譯,但字級檔位的說明文字是一般 UI 文案,理當跟著
 * 使用者選的介面語言走。
 */
function FontScaleSwitcher(): JSX.Element {
  const { t } = useTranslation(["sessionList"]);
  const scale = useFontScale((s) => s.scale);
  const setScale = useFontScale((s) => s.setScale);
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <IconButton
        icon="type"
        aria-label={t("sessionList:fontScale.toggleLabel")}
        title={t("sessionList:fontScale.toggleLabel")}
        active={open}
        onClick={() => setOpen((v) => !v)}
      />
      {open && (
        <>
          {/* 點外面關閉——理由同 LanguageSwitcher 的同名遮罩。 */}
          <div className="fixed inset-0 z-40" onMouseDown={() => setOpen(false)} />
          <div
            role="menu"
            aria-label={t("sessionList:fontScale.menuLabel")}
            className="absolute bottom-full left-0 z-50 mb-1 w-28 overflow-hidden rounded-md border border-line-subtle bg-panel py-1 shadow-overlay"
          >
            {FONT_SCALES.map((s) => (
              <button
                key={s}
                type="button"
                role="menuitemradio"
                aria-checked={s === scale}
                onClick={() => {
                  setScale(s);
                  setOpen(false);
                }}
                className={`flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left text-xs transition hover:bg-surface ${
                  s === scale ? "font-medium text-fg" : "text-fg-soft"
                }`}
              >
                {t(`sessionList:fontScale.options.${s}`)}
                {s === scale && <Icon name="check" size={11} className="text-accent" />}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * S12 Phase2 R3:從選定的 session 開一個子 agent 的極簡對話框。
 * 2026-10-02(P2:移除 profile):agent/model/effort 改用與側欄「新對話」同一組 `AgentPicker`
 * (預設帶入父 session 自己的 agent 與 model——父的 provider 已不可用時退回第一個可用的);
 * 送出時由 core 端依選擇組啟動規格,子 session 的資料夾沿用父的。
 */
function SpawnChildDialog({ session, onClose }: { session: Session; onClose: () => void }): JSX.Element {
  const { t } = useTranslation(["sessionList", "common"]);
  const spawnChild = useSessionStore((s) => s.spawnChild);
  const detectedAgents = useSessionStore((s) => s.detectedAgents);
  const providerPrefs = useSessionStore((s) => s.providerPrefs);
  const [prompt, setPrompt] = useState("");
  const [title, setTitle] = useState("");
  const [selection, setSelection] = useState<NewSessionSelection>({
    providerId: session.providerId,
    model: session.model ?? "",
    effort: session.effort ?? "",
    workingDir: "",
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const availableProviders = useMemo(
    () => selectAvailableProviders(detectedAgents, providerPrefs),
    [detectedAgents, providerPrefs],
  );
  const effective = useMemo(() => reconcileSelection(selection, availableProviders), [selection, availableProviders]);
  const hasAgent = availableProviders.some((p) => p.id === effective.providerId);

  const handleSubmit = async (): Promise<void> => {
    setError(null);
    setSubmitting(true);
    try {
      await spawnChild(
        session.id,
        prompt.trim(),
        { providerId: effective.providerId, model: effective.model || undefined, effort: effective.effort || undefined },
        title.trim() || undefined,
      );
      onClose();
    } catch (err) {
      setError(translateError(err, t));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      title={t("sessionList:spawnChildDialog.title", { title: session.title })}
      description={t("sessionList:spawnChildDialog.description")}
      icon="branch"
      size="md"
      onClose={onClose}
      footer={
        <div className="flex w-full justify-end gap-2">
          <Button variant="secondary" disabled={submitting} onClick={onClose}>
            {t("common:cancel")}
          </Button>
          <Button variant="primary" disabled={!prompt.trim() || !hasAgent || submitting} loading={submitting} onClick={() => void handleSubmit()}>
            {submitting ? t("sessionList:creating") : t("sessionList:spawnChildDialog.submit")}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <AgentPicker selection={selection} onChange={setSelection} />
        <Field label={t("sessionList:spawnChildDialog.promptLabel")}>
          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={5}
            placeholder={t("sessionList:spawnChildDialog.promptPlaceholder")}
            autoFocus
          />
        </Field>
        <Field label={t("sessionList:spawnChildDialog.titleFieldLabel")}>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("sessionList:spawnChildDialog.titlePlaceholder")} />
        </Field>
        {error && <Alert tone="danger">{error}</Alert>}
      </div>
    </Dialog>
  );
}
