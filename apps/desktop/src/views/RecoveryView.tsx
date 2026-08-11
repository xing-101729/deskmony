import { useEffect, useState } from "react";
import type { RecoveryGitStatusResult, RecoverySessionInfo } from "@deskmony/shared";
import { useRecoveryStore } from "../stores/recovery-store.js";
import { Dialog } from "../ui/Dialog.js";
import { Button } from "../ui/Button.js";
import { Badge } from "../ui/Badge.js";
import { Alert, EmptyState } from "../ui/Feedback.js";
import { Icon } from "../ui/icons.js";

interface RecoveryViewProps {
  onClose: () => void;
}

function formatTime(ts: number | undefined): string {
  if (!ts) return "未知";
  return new Date(ts).toLocaleString();
}

/**
 * S6(crash-recovery)L4 §5.2:「重跑」對髒 worktree 的強制流程——先顯示 diff,
 * 使用者二選一(保留/丟棄),丟棄需二次確認,之後才能重跑。**絕不讓「重跑」
 * 按鈕在髒 worktree 上直接生效**。
 */
function DirtyWorktreeResolver({ session, onResolved }: { session: RecoverySessionInfo; onResolved: () => void }): JSX.Element {
  const gitStatus = useRecoveryStore((s) => s.gitStatus);
  const resolveDirtyWorktree = useRecoveryStore((s) => s.resolveDirtyWorktree);
  const [result, setResult] = useState<RecoveryGitStatusResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void gitStatus(session.sessionId)
      .then(setResult)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.sessionId]);

  const handleKeep = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await resolveDirtyWorktree(session.sessionId, "keep");
      onResolved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleDiscard = async (): Promise<void> => {
    if (!window.confirm(`確定要丟棄「${session.sessionTitle}」worktree 內所有未提交的變更嗎?此操作無法復原(git reset --hard + git clean -fd)。`)) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await resolveDirtyWorktree(session.sessionId, "discard", true);
      onResolved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-2 rounded-md bg-warn/[0.06] p-2.5 text-xs">
      <p className="mb-1.5 flex items-center gap-1.5 font-medium text-warn">
        <Icon name="alert" size={13} /> worktree 有未提交的變更,重跑前必須先處理:
      </p>
      {loading && <p className="text-fg-faint">載入 diff 中…</p>}
      {error && <p className="text-danger">{error}</p>}
      {result && (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-canvas p-2 text-2xs text-fg-muted">
          {result.status || "(git status 無輸出)"}
          {"\n---\n"}
          {result.diff || "(git diff 無輸出——可能只有未追蹤的新檔案)"}
        </pre>
      )}
      <div className="mt-2 flex gap-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void handleKeep()}>
          保留(建 wip 分支並 commit)
        </Button>
        <Button size="sm" variant="danger" disabled={busy} onClick={() => void handleDiscard()}>
          丟棄變更
        </Button>
      </div>
    </div>
  );
}

function RecoveryRow({ session }: { session: RecoverySessionInfo }): JSX.Element {
  const continueSession = useRecoveryStore((s) => s.continueSession);
  const takeover = useRecoveryStore((s) => s.takeover);
  const rerun = useRecoveryStore((s) => s.rerun);
  const abandon = useRecoveryStore((s) => s.abandon);
  const gitStatus = useRecoveryStore((s) => s.gitStatus);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDirtyResolver, setShowDirtyResolver] = useState(false);
  const [mergeStatus, setMergeStatus] = useState<RecoveryGitStatusResult | null>(null);
  const [mergeStatusLoading, setMergeStatusLoading] = useState(false);

  const isMerging = session.task?.status === "merging";
  const worktreeMissing = session.workspace?.missing ?? false;
  const worktreeDirty = session.workspace?.hadUncommittedChanges ?? false;

  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleRerunClick = (): void => {
    if (worktreeMissing) return;
    if (worktreeDirty) {
      setShowDirtyResolver(true);
      return;
    }
    void run(() => rerun(session.sessionId));
  };

  const handleCheckGitStatus = async (): Promise<void> => {
    setMergeStatusLoading(true);
    try {
      const result = await gitStatus(session.sessionId);
      setMergeStatus(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setMergeStatusLoading(false);
    }
  };

  const handleAbandon = (): void => {
    if (!window.confirm(`確定要放棄「${session.sessionTitle}」嗎?session 會標記為已關閉,但任務與 worktree 都會保留,之後仍可從任務看板手動處理。`)) {
      return;
    }
    void run(() => abandon(session.sessionId));
  };

  return (
    <div className={`rounded-md p-3 ${isMerging ? "bg-danger/[0.06] ring-1 ring-danger/30" : "bg-surface"}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-fg">{session.sessionTitle}</p>
          <p className="mt-0.5 text-2xs text-fg-faint">
            {session.profileName ?? "(未知 profile)"} · 中斷於 {formatTime(session.interruptedAt)} · 最後活動 {formatTime(session.lastSeenAt)}
          </p>
          {session.task && (
            <p className="mt-1 flex flex-wrap items-center gap-1.5 text-2xs text-fg-muted">
              任務:{session.task.title}(狀態:{session.task.status})
              {isMerging && (
                <Badge tone="danger" icon="alert">
                  崩潰於合併中,git 可能處於中間狀態
                </Badge>
              )}
            </p>
          )}
          {session.workspace && (
            <p className="mt-1 text-2xs text-fg-faint">
              worktree:{session.workspace.branch}
              {worktreeMissing && <span className="ml-1 text-danger">(已遺失)</span>}
              {!worktreeMissing && worktreeDirty && <span className="ml-1 text-warn">(有未提交的變更)</span>}
              {!worktreeMissing && !worktreeDirty && <span className="ml-1 text-ok">(乾淨)</span>}
            </p>
          )}
        </div>
      </div>

      {error && <Alert tone="danger" className="mt-2">{error}</Alert>}

      {isMerging ? (
        // §5.3:merging 中崩潰——只提供「檢查 git 狀態」,不提供任何自動修復。
        <div className="mt-2">
          <Button size="sm" variant="outline" loading={mergeStatusLoading} className="hover:!border-danger hover:!text-danger" onClick={() => void handleCheckGitStatus()}>
            {mergeStatusLoading ? "查詢中…" : "檢查 git 狀態"}
          </Button>
          {mergeStatus && (
            <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-canvas p-2 text-2xs text-fg-muted">
              {mergeStatus.status || "(git status 無輸出,可能已經是乾淨狀態)"}
            </pre>
          )}
        </div>
      ) : (
        <div className="mt-2 flex flex-wrap gap-2">
          {/* §4.1:不支援「繼續」的後端,這個按鈕整個不出現(不是灰掉)。 */}
          {session.canContinue && (
            <Button size="sm" variant="primary" disabled={busy} title="重連後端 session,agent 記得先前脈絡" onClick={() => void run(() => continueSession(session.sessionId))}>
              繼續(保有記憶)
            </Button>
          )}
          <Button size="sm" variant="outline" disabled={busy} title="開新 session,注入摘要——agent 的腦是新的,只讀過筆記" onClick={() => void run(() => takeover(session.sessionId))}>
            接手(讀摘要重啟)
          </Button>
          {!worktreeMissing && (
            <Button size="sm" variant="outline" disabled={busy} title="worktree 必須乾淨才能重跑" onClick={handleRerunClick}>
              重跑…
            </Button>
          )}
          <Button size="sm" variant="ghost" disabled={busy} className="hover:!text-danger" onClick={handleAbandon}>
            放棄
          </Button>
        </div>
      )}

      {showDirtyResolver && <DirtyWorktreeResolver session={session} onResolved={() => setShowDirtyResolver(false)} />}
    </div>
  );
}

/**
 * S6(crash-recovery)L4 §5:復原視圖——列出所有 `interrupted` session,供人
 * 逐一分流(繼續/接手/重跑/放棄)。**入口是 App.tsx 的常駐提示條**,這個元件
 * 本身是被動的:不會自己彈出,也不會自動對任何一列採取行動(D3)。
 */
export function RecoveryView({ onClose }: RecoveryViewProps): JSX.Element {
  const sessions = useRecoveryStore((s) => s.sessions);
  const loading = useRecoveryStore((s) => s.loading);

  return (
    <Dialog
      title="復原:上次未被乾淨關閉的 session"
      description="子程序已隨 core 上次的中斷消失,agent 沒有記憶可自動續接——請逐一決定要繼續、接手、重跑,還是放棄"
      icon="alert"
      size="lg"
      onClose={onClose}
    >
      <div className="space-y-2">
        {loading && sessions.length === 0 && <p className="py-6 text-center text-xs text-fg-faint">載入中…</p>}
        {!loading && sessions.length === 0 && <EmptyState icon="check" title="目前沒有中斷的 session" compact />}
        {sessions.map((session) => (
          <RecoveryRow key={session.sessionId} session={session} />
        ))}
      </div>
    </Dialog>
  );
}
