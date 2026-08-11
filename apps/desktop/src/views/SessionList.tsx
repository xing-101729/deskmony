import { useMemo, useState } from "react";
import type { Session } from "@deskmony/shared";
import { useSessionStore, selectContextReporting } from "../stores/session-store.js";
import { ProfileCreateDialog } from "./ProfileCreateDialog.js";
import type { ViewMode } from "../App.js";
import { Icon, type IconName } from "../ui/icons.js";
import { Button, IconButton, Kbd } from "../ui/Button.js";
import { Field, Input, Select, Textarea } from "../ui/Field.js";
import { StatusDot, Meta } from "../ui/Badge.js";
import { Alert, EmptyState } from "../ui/Feedback.js";
import { Dialog } from "../ui/Dialog.js";
import { sessionStatusMeta, softwareLabel } from "../ui/status.js";
import { MOD_LABEL } from "../ui/hotkeys.js";
import type { ThemePreference, ResolvedTheme } from "../ui/theme.js";
import { groupSessionsByWorkspace } from "../lib/workspaces.js";

/**
 * S3a(usage-metering)L4 §4:「SessionList 每列顯示 context 使用率(如 32%)」。
 * size 為 0 時避免除以 0。
 */
function formatContextUsage(usage: { contextUsed?: number; contextSize?: number } | undefined): string | undefined {
  if (!usage || usage.contextUsed === undefined || !usage.contextSize) return undefined;
  const pct = Math.round((usage.contextUsed / usage.contextSize) * 100);
  return `${pct}%`;
}

interface NavItem {
  mode: ViewMode;
  label: string;
  icon: IconName;
  hint: string;
}

const NAV_ITEMS: NavItem[] = [
  { mode: "session", label: "Session", icon: "message", hint: `${MOD_LABEL}1` },
  { mode: "team-chat", label: "團隊群聊", icon: "users", hint: `${MOD_LABEL}2` },
  { mode: "task-board", label: "任務看板", icon: "board", hint: `${MOD_LABEL}3` },
];

const connectionMeta: Record<string, { label: string; dot: string }> = {
  open: { label: "已連線", dot: "bg-ok" },
  connecting: { label: "連線中…", dot: "bg-warn" },
  closed: { label: "已斷線", dot: "bg-danger" },
};

interface SessionListProps {
  mobileOpen: boolean;
  onCloseMobile: () => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  viewMode: ViewMode;
  onChangeView: (mode: ViewMode) => void;
  connectionStatus: string;
  selectedProfileId: string;
  onSelectProfile: (id: string) => void;
  onCreateSession: () => void;
  creatingSession: boolean;
  profileDialogOpen: boolean;
  onSetProfileDialogOpen: (open: boolean) => void;
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
 *      垂直的導覽項目(Linear「Issues / Projects / Views」式的階層,而不是
 *      水平分頁鈕)——這讓側欄從「只是 session 清單」升格成整個 app 的導覽
 *      骨幹,頂部因此完全空出來給內容用。
 *   2. **工作區分組**:`groupSessionsByWorkspace()`(lib/workspaces.ts)依
 *      `session.workingDir` 把 session 分堆,每組是一個可摺疊的區塊,標題列
 *      顯示工作區名稱 + 「有幾個在等你」的計數——這是「同時開多個專案」的
 *      power user 最需要的資訊架構,原本的扁平清單完全沒有這層。
 *   3. **可收合成圖示列**:比照 VS Code/Cursor 的 activity bar,`collapsed`
 *      時只留圖示,滑鼠 hover 用 `title` 顯示文字(⌘B 切換)。
 *
 * 「+ Profile」與「+ 新對話」的邏輯與改版前完全相同,只是版面重排;
 * `ProfileCreateDialog` 的開關狀態改由 App.tsx 持有(命令面板也能觸發同一個
 * 對話框),這裡透過 props 收放。
 */
export function SessionList({
  mobileOpen,
  onCloseMobile,
  collapsed,
  onToggleCollapsed,
  viewMode,
  onChangeView,
  connectionStatus,
  selectedProfileId,
  onSelectProfile,
  onCreateSession,
  creatingSession,
  profileDialogOpen,
  onSetProfileDialogOpen,
  onOpenPalette,
  onOpenSettings,
  themePreference,
  resolvedTheme,
  onToggleTheme,
  onLogout,
}: SessionListProps): JSX.Element {
  const sessions = useSessionStore((s) => s.sessions);
  const profiles = useSessionStore((s) => s.profiles);
  const sessionUsage = useSessionStore((s) => s.sessionUsage);
  const capabilitiesBySoftware = useSessionStore((s) => s.capabilitiesBySoftware);
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const selectSession = useSessionStore((s) => s.selectSession);
  const deleteSession = useSessionStore((s) => s.deleteSession);
  const [collapsedWorkspaces, setCollapsedWorkspaces] = useState<Set<string>>(new Set());
  const [spawnParent, setSpawnParent] = useState<Session | null>(null);

  const selectedProfile = profiles.find((p) => p.id === selectedProfileId);
  const workspaces = useMemo(() => groupSessionsByWorkspace(sessions), [sessions]);
  const conn = connectionMeta[connectionStatus] ?? connectionMeta.closed;

  /**
   * 刪除對話:原生 `confirm()` 二次確認(既有作法維持不變)——低頻、不可逆但
   * 影響範圍單一的操作,原生確認框已足夠。`stopPropagation()` 避免同時觸發
   * 外層的 selectSession()。
   */
  const handleDelete = (sessionId: string, title: string): void => {
    if (!window.confirm(`確定要刪除對話「${title}」嗎?此操作無法復原。`)) return;
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
            onChangeView("session");
            void selectSession(session.id);
            onCloseMobile();
          }}
          className="focus-ring min-w-0 flex-1 rounded-md py-1.5 pl-2 pr-1 text-left"
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
                <Meta mono title="context 窗口使用率(S3a usage-metering)">
                  ctx {contextPct}
                </Meta>
              </>
            )}
          </div>
        </button>
        <IconButton
          icon="branch"
          aria-label="開子 agent"
          title="開一個子 agent 執行子任務"
          size="xs"
          className="my-auto opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
          onClick={(e) => {
            e.stopPropagation();
            setSpawnParent(session);
          }}
        />
        <IconButton
          icon="trash"
          aria-label="刪除對話"
          title="刪除對話"
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
        <IconButton icon="sidebar" aria-label="展開側欄" onClick={onToggleCollapsed} className="mb-2" />
        <div className="flex flex-1 flex-col items-center gap-1">
          {NAV_ITEMS.map((item) => (
            <IconButton
              key={item.mode}
              icon={item.icon}
              aria-label={`${item.label}(${item.hint})`}
              title={`${item.label}(${item.hint})`}
              active={viewMode === item.mode}
              size="md"
              onClick={() => onChangeView(item.mode)}
            />
          ))}
        </div>
        <div className="flex flex-col items-center gap-1">
          <IconButton icon="search" aria-label="命令面板" title={`命令面板(${MOD_LABEL}K)`} onClick={onOpenPalette} />
          <IconButton icon="settings" aria-label="設定" onClick={onOpenSettings} />
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
          <IconButton icon="sidebar" aria-label="收合側欄" title={`收合側欄(${MOD_LABEL}B)`} onClick={onToggleCollapsed} className="hidden sm:inline-flex" />
          <IconButton icon="x" aria-label="關閉側欄" onClick={onCloseMobile} className="sm:hidden" />
        </div>
      </div>

      {/* ---- 命令面板觸發 ---- */}
      <div className="flex-shrink-0 px-2 pb-2">
        <button
          type="button"
          onClick={onOpenPalette}
          className="focus-ring flex h-7 w-full items-center gap-1.5 rounded-md border border-line bg-surface px-2 text-xs text-fg-faint transition hover:border-line-strong hover:text-fg-subtle"
        >
          <Icon name="search" size={12} />
          <span className="flex-1 text-left">搜尋或執行指令…</span>
          <Kbd>{MOD_LABEL}K</Kbd>
        </button>
      </div>

      {/* ---- 主導覽 ---- */}
      <nav className="flex-shrink-0 space-y-0.5 px-2 pb-2">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.mode}
            type="button"
            onClick={() => {
              onChangeView(item.mode);
              onCloseMobile();
            }}
            className={`focus-ring flex h-7 w-full items-center gap-2 rounded-md px-2 text-xs font-medium transition ${
              viewMode === item.mode ? "bg-accent/12 text-accent" : "text-fg-muted hover:bg-surface hover:text-fg"
            }`}
          >
            <Icon name={item.icon} size={14} />
            <span className="flex-1 text-left">{item.label}</span>
            {item.mode === "session" && sessions.length > 0 && (
              <span className="tabular text-2xs text-fg-faint">{sessions.length}</span>
            )}
          </button>
        ))}
      </nav>

      <div className="mx-3 mb-2 h-px flex-shrink-0 bg-line-subtle" />

      {/* ---- Profile + 新對話 ---- */}
      <div className="flex-shrink-0 space-y-1.5 px-2 pb-2">
        <Select
          aria-label="選擇 Agent Profile"
          value={selectedProfileId}
          onChange={(e) => onSelectProfile(e.target.value)}
          disabled={profiles.length === 0}
        >
          {profiles.length === 0 && <option value="">(尚無 Profile)</option>}
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}({softwareLabel(p.software)})
            </option>
          ))}
        </Select>
        <div className="flex gap-1.5">
          <Button
            variant="primary"
            size="sm"
            icon="plus"
            block
            loading={creatingSession}
            disabled={!selectedProfile}
            onClick={onCreateSession}
            title={`新對話(${MOD_LABEL}N)`}
          >
            {creatingSession ? "建立中…" : "新對話"}
          </Button>
          <IconButton
            icon="sparkle"
            aria-label="建立 Agent Profile"
            title="建立 Agent Profile"
            variant="outline"
            onClick={() => onSetProfileDialogOpen(true)}
          />
        </div>
      </div>

      {/* ---- 工作區分組的 session 清單 ---- */}
      <div className="flex-1 space-y-2.5 overflow-y-auto px-2 pb-2 pt-1">
        {sessions.length === 0 && (
          <EmptyState icon="message" title="尚無任何對話" description="點擊上方「新對話」開始與 agent 互動。" compact />
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
                    <span className="h-1.5 w-1.5 flex-shrink-0 animate-breathe rounded-full bg-warn" title="有 session 等待授權" />
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
      <div className="flex flex-shrink-0 items-center gap-0.5 border-t border-line-subtle px-2 py-1.5">
        <IconButton
          icon={resolvedTheme === "dark" ? "moon" : "sun"}
          aria-label="切換主題"
          title={themePreference === "system" ? "主題:跟隨系統(點擊切換)" : resolvedTheme === "dark" ? "深色主題(點擊切換為淺色)" : "淺色主題(點擊切換為深色)"}
          onClick={onToggleTheme}
        />
        <IconButton icon="settings" aria-label="設定" title={`設定(${MOD_LABEL},)`} onClick={onOpenSettings} />
        {onLogout && (
          <IconButton icon="logout" aria-label="登出" title="登出" className="ml-auto hover:!text-danger" onClick={onLogout} />
        )}
      </div>

      {profileDialogOpen && (
        <ProfileCreateDialog
          onClose={() => onSetProfileDialogOpen(false)}
          onCreated={(profileId) => onSelectProfile(profileId)}
          defaultWorkingDir={selectedProfile?.workingDir ?? ""}
        />
      )}

      {spawnParent && <SpawnChildDialog session={spawnParent} onClose={() => setSpawnParent(null)} />}
    </aside>
  );
}

/** S12 Phase2 R3:從選定的 session 開一個子 agent 的極簡對話框。 */
function SpawnChildDialog({ session, onClose }: { session: Session; onClose: () => void }): JSX.Element {
  const spawnChild = useSessionStore((s) => s.spawnChild);
  const [prompt, setPrompt] = useState("");
  const [title, setTitle] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (): Promise<void> => {
    setError(null);
    setSubmitting(true);
    try {
      await spawnChild(session.id, prompt.trim(), title.trim() || undefined);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      title={`在「${session.title}」底下開子 agent`}
      description="給子 agent 一段任務 prompt,child 沿用父 session 的 agent profile(software/model)。"
      icon="branch"
      size="md"
      onClose={onClose}
      footer={
        <div className="flex w-full justify-end gap-2">
          <Button variant="secondary" disabled={submitting} onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" disabled={!prompt.trim() || submitting} loading={submitting} onClick={() => void handleSubmit()}>
            {submitting ? "建立中…" : "開子 agent"}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <Field label="任務 prompt">
          <Textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={5} placeholder="描述這個子 agent 要執行的任務…" autoFocus />
        </Field>
        <Field label="標題(選填)">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例如:Rerun 這個 UI slice 的驗收" />
        </Field>
        {error && <Alert tone="danger">{error}</Alert>}
      </div>
    </Dialog>
  );
}
