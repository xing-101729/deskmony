import { useEffect, useMemo, useState } from "react";
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

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString("zh-TW", { hour12: false });
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
 */
function promptForAcceptanceCommands(existing: Task["acceptance"]): string[] | null {
  const existingText = existing?.commands.join(ACCEPTANCE_COMMAND_SEPARATOR) ?? "";
  const input = window.prompt(
    `設定機器驗收指令(多條用 "${ACCEPTANCE_COMMAND_SEPARATOR}" 分隔,依序執行,全部 exit 0 才算通過;留空清除驗收條件):`,
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
  return (
    <div className="mt-2 border-t border-line-subtle pt-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {task.acceptance ? (
          <Badge icon="checklist" title={task.acceptance.commands.join("\n")}>
            驗收 {task.acceptance.commands.length} 條
          </Badge>
        ) : (
          <span className="text-2xs text-fg-faint">未定義驗收條件</span>
        )}
        <Button size="xs" variant="ghost" onClick={() => void onEdit()}>
          設定驗收
        </Button>
        <Button size="xs" variant="ghost" icon="play" loading={running} disabled={!task.acceptance} onClick={() => void onRun()}>
          {running ? "驗收執行中" : "跑驗收"}
        </Button>
        {result && !result.skippedReason && (
          <Badge tone={result.passed ? "ok" : "danger"} icon={result.passed ? "check" : "x"}>
            {result.passed ? "通過" : "未通過"}
          </Badge>
        )}
        {result?.skippedReason === "workspace-missing" && <Badge tone="warn">尚無 worktree,無法執行</Badge>}
      </div>
      {result && result.perCommand.length > 0 && (
        <details className="mt-1.5 rounded-md border border-line-subtle bg-canvas/60 text-2xs">
          <summary className="cursor-pointer select-none px-2 py-1 text-fg-muted">
            驗收結果詳情({result.perCommand.length}/{task.acceptance?.commands.length ?? result.perCommand.length} 條已執行)
          </summary>
          <div className="max-h-48 space-y-1.5 overflow-y-auto border-t border-line-subtle px-2 py-1.5">
            {result.perCommand.map((cmd, idx) => (
              <div key={idx} className="rounded border border-line-subtle p-1.5">
                <div className="flex flex-wrap items-center gap-1.5 font-mono tabular text-fg-soft">
                  <span className={cmd.timedOut || cmd.exitCode !== 0 ? "text-danger" : "text-ok"}>
                    {cmd.timedOut ? "TIMEOUT" : `exit ${cmd.exitCode}`}
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
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative mb-2 overflow-hidden rounded-md bg-surface pl-2.5 pr-2 py-2 text-xs shadow-panel">
      <span className={`absolute inset-y-0 left-0 w-[3px] ${meta.rail}`} aria-hidden="true" />
      <div className="mb-1 flex items-start justify-between gap-2">
        <span className="font-medium leading-snug text-fg">{task.title}</span>
        <IconButton icon="trash" aria-label="刪除任務" title="刪除任務" size="xs" disabled={busy} className="-mr-1 -mt-0.5 hover:!text-danger" onClick={() => void run(onDelete)} />
      </div>
      {task.description && <p className="mb-1.5 whitespace-pre-wrap text-2xs leading-relaxed text-fg-muted">{task.description}</p>}
      <div className="flex flex-wrap items-center gap-1.5">
        {assigneeName && <Meta icon="user">{assigneeName}</Meta>}
        {branch && <Meta icon="branch" mono>{branch}</Meta>}
        {task.status === "blocked" && task.blockedFrom && <Badge tone="warn">封鎖前:{task.blockedFrom}</Badge>}
        <span className="ml-auto tabular text-2xs text-fg-faint">{formatTime(task.updatedAt)}</span>
      </div>

      {/* S5(dispose-gate)L4 §4:agent 請求送審但沒有機器驗收條件(或連續驗收
          失敗達上限)時,tryApplyReportStatus() 設 awaitingHumanReview 並
          escalate——這裡讓人類直接核可,不需要另外去翻通知或 log。 */}
      {task.awaitingHumanReview && (
        <div className="mt-1.5 flex items-center justify-between gap-2 rounded-md bg-accent/10 px-2 py-1.5">
          <span className="flex items-center gap-1 text-2xs text-accent">
            <Icon name="clock" size={12} /> 等待你核可進入 review
          </span>
          <Button size="xs" variant="accentSoft" disabled={busy} onClick={() => void run(onApproveReview)}>
            核准進入 review
          </Button>
        </div>
      )}

      {error && <Alert tone="danger" className="mt-1.5">{error}</Alert>}

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {task.status === "backlog" && (
          <>
            <Select aria-label="指派成員" value={assignMemberId} onChange={(e) => setAssignMemberId(e.target.value)} className="!h-6 w-28 !text-2xs">
              <option value="">選擇成員…</option>
              {memberOptions.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </Select>
            <Button size="xs" variant="accentSoft" disabled={!assignMemberId || busy} onClick={() => void run(() => onAssign(assignMemberId))}>
              指派
            </Button>
          </>
        )}
        {task.status === "assigned" && (
          <Button size="xs" variant="accentSoft" disabled={busy} onClick={() => void run(() => onUpdateStatus("in-progress"))}>
            開始
          </Button>
        )}
        {task.status === "in-progress" && (
          <Button size="xs" variant="accentSoft" disabled={busy} onClick={() => void run(onAdvanceToReview)}>
            送審
          </Button>
        )}
        {task.status === "review" && (
          <>
            <Button size="xs" variant="outline" disabled={busy} onClick={() => void run(() => onUpdateStatus("in-progress"))} className="hover:!border-warn hover:!text-warn">
              退回
            </Button>
            <Button size="xs" variant="accentSoft" disabled={busy} onClick={() => void run(() => onUpdateStatus("merging"))}>
              通過,進入合併
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
              const ok = window.confirm(
                `確定要把分支 "${branch ?? task.workspaceId ?? "?"}" 合併回主幹並完成任務嗎?\n這會實際執行 git merge --no-ff,若有衝突會自動還原(git merge --abort)並顯示錯誤。`,
              );
              if (!ok) return;
              void run(onMerge);
            }}
          >
            批准合併
          </Button>
        )}
        {task.status === "blocked" && task.blockedFrom && (
          <Button size="xs" variant="accentSoft" disabled={busy} onClick={() => void run(() => onUpdateStatus(task.blockedFrom as TaskStatus))}>
            解除封鎖(回到 {task.blockedFrom})
          </Button>
        )}
        {BLOCKABLE_STATUSES.includes(task.status) && (
          <Button size="xs" variant="outline" disabled={busy} onClick={() => void run(() => onUpdateStatus("blocked"))} className="hover:!border-warn hover:!text-warn">
            封鎖
          </Button>
        )}
      </div>

      <AcceptancePanel task={task} result={acceptanceResult} running={acceptanceRunning} onRun={() => run(onRunAcceptance)} onEdit={onEditAcceptance} />
    </div>
  );
}

export function TaskBoardView({ onOpenSidebar }: { onOpenSidebar: () => void }): JSX.Element {
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

  const team = teams.find((t) => t.id === currentTeamId);
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
      setError(err instanceof Error ? err.message : String(err));
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
        setWarning(`任務「${task.title}」驗收未通過,仍已移至 review(切片為諮詢性,不阻擋轉換)。`);
      }
    } catch (err) {
      console.warn(`[acceptance] 送審前跑驗收失敗(忽略,不擋轉換): ${err instanceof Error ? err.message : String(err)}`);
    }
    await updateStatus(task.id, "review");
  };

  const handleEditAcceptance = async (task: Task): Promise<void> => {
    const commands = promptForAcceptanceCommands(task.acceptance);
    if (commands === null) return;
    await setAcceptance(task.id, commands.length > 0 ? { commands } : undefined);
  };

  const handleDelete = async (task: Task): Promise<void> => {
    const ok = window.confirm(`確定要刪除任務「${task.title}」嗎?若已建立 worktree,會一併強制刪除,無法復原。`);
    if (!ok) return;
    const result = await deleteTask(task.id);
    if (result.hadUncommittedChanges) {
      setWarning(`任務「${task.title}」的 worktree 內有未 commit 的變更,已隨刪除操作一併強制清除,無法復原。`);
    }
  };

  if (teams.length === 0) {
    return (
      <main className="flex h-full flex-1 flex-col bg-canvas">
        <MobileBar onOpenSidebar={onOpenSidebar} />
        <EmptyState
          icon="board"
          title="尚未建立任何團隊"
          description="任務看板需要先建立一個團隊、加入至少一位成員,才能建立與指派任務。"
          action={
            <Button variant="primary" icon="plus" onClick={() => setManagementOpen(true)}>
              建立團隊
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
          title="請選擇一個團隊"
          action={
            <div className="flex flex-wrap justify-center gap-2">
              {teams.map((t) => (
                <Button key={t.id} variant="outline" onClick={() => void selectTeam(t.id)}>
                  {t.name}
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
          <IconButton icon="menu" aria-label="開啟側欄" onClick={onOpenSidebar} className="sm:hidden" />
          <h1 className="truncate text-sm font-semibold text-fg">{team.name}</h1>
          <Select aria-label="切換團隊" value={team.id} onChange={(e) => void selectTeam(e.target.value)} className="!h-6 !text-2xs">
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex flex-shrink-0 items-center gap-1.5">
          <Button size="sm" variant="primary" icon="plus" onClick={() => setComposerOpen((open) => !open)}>
            新任務
          </Button>
          <Button size="sm" variant="outline" icon="users" onClick={() => setManagementOpen(true)}>
            團隊管理
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
              <Input value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder="新任務標題" className="w-56" />
              <Input value={newDescription} onChange={(e) => setNewDescription(e.target.value)} placeholder="描述(選填)" className="w-64" />
              <Input
                value={newAcceptanceText}
                onChange={(e) => setNewAcceptanceText(e.target.value)}
                placeholder="驗收指令(選填,多條用 ; 分隔)"
                mono
                title="機器驗收指令(S4):每條指令依序執行,全部 exit 0 才算通過,留空 = 無機器驗收(退回人類判定)"
                className="w-56"
              />
              <Button variant="primary" size="sm" loading={creating} disabled={!newTitle.trim()} onClick={() => void handleCreate()}>
                {creating ? "建立中…" : "建立"}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setComposerOpen(false)}>
                取消
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
                {tasksByStatus[status].length === 0 && <p className="mt-3 text-center text-2xs text-fg-faint">無任務</p>}
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
            封鎖(Blocked) · {tasksByStatus.blocked.length}
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
  return (
    <div className="flex flex-shrink-0 items-center border-b border-line-subtle px-2 py-1.5 sm:hidden">
      <IconButton icon="menu" aria-label="開啟側欄" onClick={onOpenSidebar} />
    </div>
  );
}
