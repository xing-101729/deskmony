import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { AcceptanceResult, Task, TaskStatus } from "@deskmony/shared";
import { useTeamStore } from "../stores/team-store.js";
import { useTaskStore } from "../stores/task-store.js";
import { TeamManagementDialog } from "./TeamManagementDialog.js";
import { Button, IconButton } from "../ui/Button.js";
import { Input, Select } from "../ui/Field.js";
import { Badge, Meta } from "../ui/Badge.js";
import { Alert, EmptyState } from "../ui/Feedback.js";
import { Icon } from "../ui/icons.js";
import { taskStatusMeta } from "../ui/status.js";
import { useLocale } from "../ui/locale.js";
import { formatDateTime } from "../lib/format-datetime.js";
import type { Locale } from "../lib/locale-storage.js";
import { translateError } from "../lib/error-i18n.js";

/**
 * TaskBoardView(M4 Round B):任務看板 —— 欄位對應 TaskService 的狀態機:
 *   Backlog → Assigned → In-Progress → Review → Merging → Done
 * `blocked` 不是這條主線上的一個欄位(任意狀態都能被打斷進 blocked),這裡改用
 * 獨立的「封鎖」區塊呈現,每張卡片標示 blockedFrom(進入 blocked 前的狀態)。
 *
 * 狀態推進一律用按鈕(只提供 isValidTransition() 允許的操作),不做拖拉。
 * "核准合併"(task.merge)是唯一真正觸發 git merge 的入口,按鈕只出現在
 * merging 欄位,點擊前顯示分支名稱與確認對話框。
 */

const COLUMN_ORDER: TaskStatus[] = ["backlog", "assigned", "in-progress", "review", "merging", "done"];

const BLOCKABLE_STATUSES: TaskStatus[] = ["backlog", "assigned", "in-progress", "review", "merging"];

/** i18n 專案新增:改用 formatDateTime()(見 lib/format-datetime.ts)取代原本
 *  硬編 "zh-TW" 的 `.toLocaleString()`——這是全 app 3 處硬編 locale 呼叫點之一
 *  (另兩處分別在 TeamChatView.tsx 與已由前一批次處理的 RecoveryView.tsx)。 */
function formatTime(ts: number, locale: Locale): string {
  return formatDateTime(ts, locale, { hour12: false });
}

/**
 * S4(機器驗收閘,切片:量測半、諮詢性)。多條指令的分隔字元——刻意選用 `;`
 * 而不是換行:`window.prompt()` 與建立任務表單都是原生單行輸入,選 `;` 是因為
 * shell 指令本身很少會在字面上用到它。
 */
const ACCEPTANCE_COMMAND_SEPARATOR = ";";

function splitAcceptanceCommandsInput(text: string): string[] {
  return text
    .split(ACCEPTANCE_COMMAND_SEPARATOR)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * 「設定驗收指令」用原生 `window.prompt()`——比照既有風格,這是一個低頻、單一
 * 欄位的輸入動作,不值得為它新增一個 dialog 元件。
 *
 * i18n 專案新增:這是模組層級的純函式(非 React 元件),沒有 hook 可用——`t`
 * 由呼叫端(TaskBoardView 元件本體的 handleEditAcceptance())傳入,比照
 * lib/error-i18n.ts 的 translateError() 慣例。
 */
function promptForAcceptanceCommands(existing: Task["acceptance"], t: TFunction): string[] | null {
  const existingText = existing?.commands.join(ACCEPTANCE_COMMAND_SEPARATOR) ?? "";
  const input = window.prompt(
    t("taskBoard:acceptancePrompt.message", { separator: ACCEPTANCE_COMMAND_SEPARATOR }),
    existingText,
  );
  if (input === null) return null;
  return splitAcceptanceCommandsInput(input);
}

/** S4:pass/fail 徽章 + 逐條指令結果面板。 */
function AcceptancePanel({
  task,
  result,
  running,
  onRun,
  onEdit,
}: {
  task: Task;
  result: AcceptanceResult | undefined;
  running: boolean;
  onRun: () => Promise<void>;
  onEdit: () => Promise<void>;
}): JSX.Element {
  const { t } = useTranslation(["taskBoard"]);
  return (
    <div className="mt-2 border-t border-line-subtle pt-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {task.acceptance ? (
          <Badge icon="checklist" title={task.acceptance.commands.join("\n")}>
            {t("taskBoard:acceptance.countBadge", { count: task.acceptance.commands.length })}
          </Badge>
        ) : (
          <span className="text-2xs text-fg-faint">{t("taskBoard:acceptance.undefined")}</span>
        )}
        <Button size="xs" variant="ghost" onClick={() => void onEdit()}>
          {t("taskBoard:acceptance.edit")}
        </Button>
        <Button size="xs" variant="ghost" icon="play" loading={running} disabled={!task.acceptance} onClick={() => void onRun()}>
          {running ? t("taskBoard:acceptance.running") : t("taskBoard:acceptance.run")}
        </Button>
        {result && !result.skippedReason && (
          <Badge tone={result.passed ? "ok" : "danger"} icon={result.passed ? "check" : "x"}>
            {result.passed ? t("taskBoard:acceptance.passed") : t("taskBoard:acceptance.failed")}
          </Badge>
        )}
        {result?.skippedReason === "workspace-missing" && <Badge tone="warn">{t("taskBoard:acceptance.workspaceMissing")}</Badge>}
      </div>
      {result && result.perCommand.length > 0 && (
        <details className="mt-1.5 rounded-md border border-line-subtle bg-canvas/60 text-2xs">
          <summary className="cursor-pointer select-none px-2 py-1 text-fg-muted">
            {t("taskBoard:acceptance.detailsSummary", {
              done: result.perCommand.length,
              total: task.acceptance?.commands.length ?? result.perCommand.length,
            })}
          </summary>
          <div className="max-h-48 space-y-1.5 overflow-y-auto border-t border-line-subtle px-2 py-1.5">
            {result.perCommand.map((cmd, idx) => (
              <div key={idx} className="rounded border border-line-subtle p-1.5">
                <div className="flex flex-wrap items-center gap-1.5 font-mono tabular text-fg-soft">
                  <span className={cmd.timedOut || cmd.exitCode !== 0 ? "text-danger" : "text-ok"}>
                    {cmd.timedOut ? t("taskBoard:acceptance.timedOut") : t("taskBoard:acceptance.exitCode", { code: cmd.exitCode })}
                  </span>
                  <span className="text-fg-faint">{cmd.durationMs}ms</span>
                  <span className="truncate text-fg-muted">{cmd.command}</span>
                </div>
                {cmd.outputTail && (
                  <pre className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap break-all font-mono text-2xs text-fg-faint">
                    {cmd.outputTail}
                  </pre>
                )}
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

interface TaskCardProps {
  task: Task;
  assigneeName: string | undefined;
  branch: string | undefined;
  memberOptions: { id: string; name: string }[];
  onAssign: (memberId: string) => Promise<void>;
  onUpdateStatus: (status: TaskStatus) => Promise<void>;
  onMerge: () => Promise<void>;
  onDelete: () => Promise<void>;
  onAdvanceToReview: () => Promise<void>;
  acceptanceResult: AcceptanceResult | undefined;
  acceptanceRunning: boolean;
  onRunAcceptance: () => Promise<void>;
  onEditAcceptance: () => Promise<void>;
  onApproveReview: () => Promise<void>;
}

function TaskCard({
  task,
  assigneeName,
  branch,
  memberOptions,
  onAssign,
  onUpdateStatus,
  onMerge,
  onDelete,
  onAdvanceToReview,
  acceptanceResult,
  acceptanceRunning,
  onRunAcceptance,
  onEditAcceptance,
  onApproveReview,
}: TaskCardProps): JSX.Element {
  const { t } = useTranslation(["taskBoard", "common"]);
  const locale = useLocale((s) => s.locale);
  const [assignMemberId, setAssignMemberId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const meta = taskStatusMeta(task.status);

  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(translateError(err, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative mb-2 overflow-hidden rounded-md bg-surface pl-2.5 pr-2 py-2 text-xs shadow-panel">
      <span className={`absolute inset-y-0 left-0 w-[3px] ${meta.rail}`} aria-hidden="true" />
      <div className="mb-1 flex items-start justify-between gap-2">
        <span className="font-medium leading-snug text-fg">{task.title}</span>
        <IconButton
          icon="trash"
          aria-label={t("taskBoard:card.deleteTaskAriaLabel")}
          title={t("taskBoard:card.deleteTaskAriaLabel")}
          size="xs"
          disabled={busy}
          className="-mr-1 -mt-0.5 hover:!text-danger"
          onClick={() => void run(onDelete)}
        />
      </div>
      {task.description && <p className="mb-1.5 whitespace-pre-wrap text-2xs leading-relaxed text-fg-muted">{task.description}</p>}
      <div className="flex flex-wrap items-center gap-1.5">
        {assigneeName && <Meta icon="user">{assigneeName}</Meta>}
        {branch && <Meta icon="branch" mono>{branch}</Meta>}
        {task.status === "blocked" && task.blockedFrom && (
          <Badge tone="warn">{t("taskBoard:card.blockedFromBadge", { status: task.blockedFrom })}</Badge>
        )}
        <span className="ml-auto tabular text-2xs text-fg-faint">{formatTime(task.updatedAt, locale)}</span>
      </div>

      {/* S5(dispose-gate)L4 §4:agent 請求送審但沒有機器驗收條件(或連續驗收
          失敗達上限)時,tryApplyReportStatus() 設 awaitingHumanReview 並
          escalate——這裡讓人類直接核可,不需要另外去翻通知或 log。 */}
      {task.awaitingHumanReview && (
        <div className="mt-1.5 flex items-center justify-between gap-2 rounded-md bg-accent/10 px-2 py-1.5">
          <span className="flex items-center gap-1 text-2xs text-accent">
            <Icon name="clock" size={12} /> {t("taskBoard:card.awaitingApproval")}
          </span>
          <Button size="xs" variant="accentSoft" disabled={busy} onClick={() => void run(onApproveReview)}>
            {t("taskBoard:card.approveReview")}
          </Button>
        </div>
      )}

      {error && <Alert tone="danger" className="mt-1.5">{error}</Alert>}

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {task.status === "backlog" && (
          <>
            <Select
              aria-label={t("taskBoard:card.assignMemberAriaLabel")}
              value={assignMemberId}
              onChange={(e) => setAssignMemberId(e.target.value)}
              className="!h-6 w-28 !text-2xs"
            >
              <option value="">{t("taskBoard:card.selectMemberOption")}</option>
              {memberOptions.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </Select>
            <Button size="xs" variant="accentSoft" disabled={!assignMemberId || busy} onClick={() => void run(() => onAssign(assignMemberId))}>
              {t("taskBoard:card.assign")}
            </Button>
          </>
        )}
        {task.status === "assigned" && (
          <Button size="xs" variant="accentSoft" disabled={busy} onClick={() => void run(() => onUpdateStatus("in-progress"))}>
            {t("taskBoard:card.start")}
          </Button>
        )}
        {task.status === "in-progress" && (
          <Button size="xs" variant="accentSoft" disabled={busy} onClick={() => void run(onAdvanceToReview)}>
            {t("taskBoard:card.submitForReview")}
          </Button>
        )}
        {task.status === "review" && (
          <>
            <Button
              size="xs"
              variant="outline"
              disabled={busy}
              onClick={() => void run(() => onUpdateStatus("in-progress"))}
              className="hover:!border-warn hover:!text-warn"
            >
              {t("taskBoard:card.reject")}
            </Button>
            <Button size="xs" variant="accentSoft" disabled={busy} onClick={() => void run(() => onUpdateStatus("merging"))}>
              {t("taskBoard:card.approveMergeTransition")}
            </Button>
          </>
        )}
        {task.status === "merging" && (
          <Button
            size="xs"
            variant="secondary"
            className="!bg-ok/12 !text-ok hover:!bg-ok/20"
            disabled={busy}
            onClick={() => {
              const ok = window.confirm(t("taskBoard:card.confirmMerge", { branch: branch ?? task.workspaceId ?? "?" }));
              if (!ok) return;
              void run(onMerge);
            }}
          >
            {t("taskBoard:card.approveMerge")}
          </Button>
        )}
        {task.status === "blocked" && task.blockedFrom && (
          <Button size="xs" variant="accentSoft" disabled={busy} onClick={() => void run(() => onUpdateStatus(task.blockedFrom as TaskStatus))}>
            {t("taskBoard:card.unblock", { status: task.blockedFrom })}
          </Button>
        )}
        {BLOCKABLE_STATUSES.includes(task.status) && (
          <Button size="xs" variant="outline" disabled={busy} onClick={() => void run(() => onUpdateStatus("blocked"))} className="hover:!border-warn hover:!text-warn">
            {t("taskBoard:card.block")}
          </Button>
        )}
      </div>

      <AcceptancePanel task={task} result={acceptanceResult} running={acceptanceRunning} onRun={() => run(onRunAcceptance)} onEdit={onEditAcceptance} />
    </div>
  );
}

export function TaskBoardView({ onOpenSidebar }: { onOpenSidebar: () => void }): JSX.Element {
  const { t } = useTranslation(["taskBoard", "common"]);
  const teams = useTeamStore((s) => s.teams);
  const currentTeamId = useTeamStore((s) => s.currentTeamId);
  const selectTeam = useTeamStore((s) => s.selectTeam);

  const tasksByTeam = useTaskStore((s) => s.tasksByTeam);
  const workspacesById = useTaskStore((s) => s.workspacesById);
  const initTasks = useTaskStore((s) => s.init);
  const loadTasks = useTaskStore((s) => s.loadTasks);
  const createTask = useTaskStore((s) => s.createTask);
  const assignTask = useTaskStore((s) => s.assignTask);
  const updateStatus = useTaskStore((s) => s.updateStatus);
  const mergeTask = useTaskStore((s) => s.mergeTask);
  const deleteTask = useTaskStore((s) => s.deleteTask);
  const acceptanceResultsByTask = useTaskStore((s) => s.acceptanceResultsByTask);
  const runningAcceptanceTaskIds = useTaskStore((s) => s.runningAcceptanceTaskIds);
  const setAcceptance = useTaskStore((s) => s.setAcceptance);
  const runAcceptance = useTaskStore((s) => s.runAcceptance);
  const approveReview = useTaskStore((s) => s.approveReview);

  const [managementOpen, setManagementOpen] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newAcceptanceText, setNewAcceptanceText] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  useEffect(() => {
    initTasks();
  }, [initTasks]);

  useEffect(() => {
    if (currentTeamId) void loadTasks(currentTeamId);
  }, [currentTeamId, loadTasks]);

  const team = teams.find((t2) => t2.id === currentTeamId);
  const tasks = currentTeamId ? (tasksByTeam[currentTeamId] ?? []) : [];

  const memberOptions = useMemo(
    () => (team ? team.members.map((m) => ({ id: m.id, name: m.name })) : []),
    [team],
  );
  const memberNameById = useMemo(() => {
    const map: Record<string, string> = {};
    for (const m of team?.members ?? []) map[m.id] = m.name;
    return map;
  }, [team]);

  const tasksByStatus = useMemo(() => {
    const map: Record<TaskStatus, Task[]> = {
      backlog: [],
      assigned: [],
      "in-progress": [],
      review: [],
      merging: [],
      done: [],
      blocked: [],
    };
    for (const task of tasks) map[task.status].push(task);
    return map;
  }, [tasks]);

  const handleCreate = async (): Promise<void> => {
    if (!currentTeamId || !newTitle.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const commands = splitAcceptanceCommandsInput(newAcceptanceText);
      await createTask({
        teamId: currentTeamId,
        title: newTitle.trim(),
        description: newDescription.trim() || undefined,
        acceptance: commands.length > 0 ? { commands } : undefined,
      });
      setNewTitle("");
      setNewDescription("");
      setNewAcceptanceText("");
      setComposerOpen(false);
    } catch (err) {
      setError(translateError(err, t));
    } finally {
      setCreating(false);
    }
  };

  /**
   * S4 L4 §4:「拖向 review」——UI 在送出 `task.updateStatus(→review)` 之前
   * 先呼叫 `task.runAcceptance`;不論結果都繼續送出轉換,失敗只跳警告。
   */
  const handleAdvanceToReview = async (task: Task): Promise<void> => {
    try {
      const result = await runAcceptance(task.id);
      if (!result.skippedReason && !result.passed) {
        setWarning(t("taskBoard:advanceWarning", { title: task.title }));
      }
    } catch (err) {
      // i18n 專案新增:這是開發者向 console 輸出的除錯訊息,不是使用者看到的
      // UI 文字——比照 lib/gateway-client.ts 既有 console.error 的既有慣例,
      // 維持中文、不納入這批次的翻譯範圍。
      console.warn(`[acceptance] 送審前跑驗收失敗(忽略,不擋轉換): ${err instanceof Error ? err.message : String(err)}`);
    }
    await updateStatus(task.id, "review");
  };

  const handleEditAcceptance = async (task: Task): Promise<void> => {
    const commands = promptForAcceptanceCommands(task.acceptance, t);
    if (commands === null) return;
    await setAcceptance(task.id, commands.length > 0 ? { commands } : undefined);
  };

  const handleDelete = async (task: Task): Promise<void> => {
    const ok = window.confirm(t("taskBoard:card.confirmDelete", { title: task.title }));
    if (!ok) return;
    const result = await deleteTask(task.id);
    if (result.hadUncommittedChanges) {
      setWarning(t("taskBoard:card.deleteHadUncommittedWarning", { title: task.title }));
    }
  };

  if (teams.length === 0) {
    return (
      <main className="flex h-full flex-1 flex-col bg-canvas">
        <MobileBar onOpenSidebar={onOpenSidebar} />
        <EmptyState
          icon="board"
          title={t("taskBoard:empty.noTeamTitle")}
          description={t("taskBoard:empty.noTeamDescription")}
          action={
            <Button variant="primary" icon="plus" onClick={() => setManagementOpen(true)}>
              {t("taskBoard:empty.createTeam")}
            </Button>
          }
        />
        {managementOpen && <TeamManagementDialog onClose={() => setManagementOpen(false)} />}
      </main>
    );
  }

  if (!team) {
    return (
      <main className="flex h-full flex-1 flex-col bg-canvas">
        <MobileBar onOpenSidebar={onOpenSidebar} />
        <EmptyState
          icon="board"
          title={t("taskBoard:empty.selectTeamTitle")}
          action={
            <div className="flex flex-wrap justify-center gap-2">
              {teams.map((teamOption) => (
                <Button key={teamOption.id} variant="outline" onClick={() => void selectTeam(teamOption.id)}>
                  {teamOption.name}
                </Button>
              ))}
            </div>
          }
        />
      </main>
    );
  }

  return (
    <main className="flex h-full flex-1 flex-col bg-canvas">
      <header className="flex flex-shrink-0 items-center justify-between gap-2 border-b border-line-subtle px-3 py-2 sm:px-4">
        <div className="flex min-w-0 items-center gap-2">
          <IconButton icon="menu" aria-label={t("taskBoard:sidebar.openAriaLabel")} onClick={onOpenSidebar} className="sm:hidden" />
          <h1 className="truncate text-sm font-semibold text-fg">{team.name}</h1>
          <Select aria-label={t("taskBoard:header.switchTeamAriaLabel")} value={team.id} onChange={(e) => void selectTeam(e.target.value)} className="!h-6 !text-2xs">
            {teams.map((teamOption) => (
              <option key={teamOption.id} value={teamOption.id}>
                {teamOption.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex flex-shrink-0 items-center gap-1.5">
          <Button size="sm" variant="primary" icon="plus" onClick={() => setComposerOpen((open) => !open)}>
            {t("taskBoard:header.newTask")}
          </Button>
          <Button size="sm" variant="outline" icon="users" onClick={() => setManagementOpen(true)}>
            {t("taskBoard:header.teamManagement")}
          </Button>
        </div>
      </header>

      {(composerOpen || error || warning) && (
        <div className="flex-shrink-0 space-y-2 border-b border-line-subtle px-3 py-2 sm:px-4">
          {error && <Alert tone="danger">{error}</Alert>}
          {warning && (
            <Alert tone="warn" onDismiss={() => setWarning(null)}>
              {warning}
            </Alert>
          )}
          {composerOpen && (
            <div className="flex flex-wrap items-center gap-2">
              <Input value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder={t("taskBoard:composer.titlePlaceholder")} className="w-56" />
              <Input
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
                placeholder={t("taskBoard:composer.descriptionPlaceholder")}
                className="w-64"
              />
              <Input
                value={newAcceptanceText}
                onChange={(e) => setNewAcceptanceText(e.target.value)}
                placeholder={t("taskBoard:composer.acceptancePlaceholder", { separator: ACCEPTANCE_COMMAND_SEPARATOR })}
                mono
                title={t("taskBoard:composer.acceptanceTitle")}
                className="w-56"
              />
              <Button variant="primary" size="sm" loading={creating} disabled={!newTitle.trim()} onClick={() => void handleCreate()}>
                {creating ? t("taskBoard:composer.creating") : t("taskBoard:composer.create")}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setComposerOpen(false)}>
                {t("common:cancel")}
              </Button>
            </div>
          )}
        </div>
      )}

      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-3">
        {COLUMN_ORDER.map((status) => {
          const meta = taskStatusMeta(status);
          return (
            <div key={status} className="flex w-64 flex-shrink-0 flex-col">
              <div className="flex h-7 flex-shrink-0 items-center gap-1.5 px-1">
                <span className={`h-1.5 w-1.5 rounded-full ${meta.rail}`} />
                <span className="text-2xs font-semibold uppercase tracking-[0.06em] text-fg-subtle">{meta.code}</span>
                <span className="tabular text-2xs text-fg-faint">{tasksByStatus[status].length}</span>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto rounded-lg bg-surface/40 p-1.5">
                {tasksByStatus[status].length === 0 && <p className="mt-3 text-center text-2xs text-fg-faint">{t("taskBoard:column.empty")}</p>}
                {tasksByStatus[status].map((task) => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    assigneeName={task.assigneeMemberId ? memberNameById[task.assigneeMemberId] : undefined}
                    branch={task.workspaceId ? workspacesById[task.workspaceId]?.branch : undefined}
                    memberOptions={memberOptions}
                    onAssign={(memberId) => assignTask({ taskId: task.id, memberId })}
                    onUpdateStatus={(newStatus) => updateStatus(task.id, newStatus)}
                    onMerge={() => mergeTask(task.id)}
                    onDelete={() => handleDelete(task)}
                    onAdvanceToReview={() => handleAdvanceToReview(task)}
                    acceptanceResult={acceptanceResultsByTask[task.id]}
                    acceptanceRunning={runningAcceptanceTaskIds.has(task.id)}
                    onRunAcceptance={() => runAcceptance(task.id).then(() => undefined)}
                    onEditAcceptance={() => handleEditAcceptance(task)}
                    onApproveReview={() => approveReview(task.id).then(() => undefined)}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {tasksByStatus.blocked.length > 0 && (
        <div className="flex-shrink-0 border-t border-line-subtle bg-danger/[0.04] p-3">
          <div className="mb-1.5 flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-[0.06em] text-danger">
            <Icon name="alert" size={12} />
            {t("taskBoard:blockedSection.heading", { count: tasksByStatus.blocked.length })}
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {tasksByStatus.blocked.map((task) => (
              <TaskCard
                key={task.id}
                task={task}
                assigneeName={task.assigneeMemberId ? memberNameById[task.assigneeMemberId] : undefined}
                branch={task.workspaceId ? workspacesById[task.workspaceId]?.branch : undefined}
                memberOptions={memberOptions}
                onAssign={(memberId) => assignTask({ taskId: task.id, memberId })}
                onUpdateStatus={(newStatus) => updateStatus(task.id, newStatus)}
                onMerge={() => mergeTask(task.id)}
                onDelete={() => handleDelete(task)}
                onAdvanceToReview={() => handleAdvanceToReview(task)}
                acceptanceResult={acceptanceResultsByTask[task.id]}
                acceptanceRunning={runningAcceptanceTaskIds.has(task.id)}
                onRunAcceptance={() => runAcceptance(task.id).then(() => undefined)}
                onEditAcceptance={() => handleEditAcceptance(task)}
                onApproveReview={() => approveReview(task.id).then(() => undefined)}
              />
            ))}
          </div>
        </div>
      )}

      {managementOpen && <TeamManagementDialog onClose={() => setManagementOpen(false)} />}
    </main>
  );
}

function MobileBar({ onOpenSidebar }: { onOpenSidebar: () => void }): JSX.Element {
  const { t } = useTranslation(["taskBoard"]);
  return (
    <div className="flex flex-shrink-0 items-center border-b border-line-subtle px-2 py-1.5 sm:hidden">
      <IconButton icon="menu" aria-label={t("taskBoard:sidebar.openAriaLabel")} onClick={onOpenSidebar} />
    </div>
  );
}
