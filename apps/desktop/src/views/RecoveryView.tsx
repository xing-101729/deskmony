import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { RecoveryGitStatusResult, RecoverySessionInfo } from "@deskmony/shared";
import { useRecoveryStore } from "../stores/recovery-store.js";
import { Dialog } from "../ui/Dialog.js";
import { Button } from "../ui/Button.js";
import { Badge } from "../ui/Badge.js";
import { Alert, EmptyState } from "../ui/Feedback.js";
import { Icon } from "../ui/icons.js";
import { useLocale } from "../ui/locale.js";
import { formatDateTime } from "../lib/format-datetime.js";
import type { Locale } from "../lib/locale-storage.js";
import { translateError } from "../lib/error-i18n.js";

interface RecoveryViewProps {
  onClose: () => void;
}

/** i18n 專案新增:改用 formatDateTime()(見 lib/format-datetime.ts)取代原本
 *  沒帶 locale 參數的裸 `.toLocaleString()`——這支是全 app 唯一一處這種寫法
 *  (其餘兩處硬編 "zh-TW" 的呼叫點在其他檔案,不在這批次範圍內)。無時間戳
 *  時顯示的文字改由呼叫端傳入(元件內用 t("common:unknown")),這裡維持是
 *  不依賴 React context 的純函式。 */
function formatTime(ts: number | undefined, locale: Locale, unknownLabel: string): string {
  if (!ts) return unknownLabel;
  return formatDateTime(ts, locale);
}

/**
 * S6(crash-recovery)L4 §5.2:「重跑」對髒 worktree 的強制流程——先顯示 diff,
 * 使用者二選一(保留/丟棄),丟棄需二次確認,之後才能重跑。**絕不讓「重跑」
 * 按鈕在髒 worktree 上直接生效**。
 */
function DirtyWorktreeResolver({ session, onResolved }: { session: RecoverySessionInfo; onResolved: () => void }): JSX.Element {
  const { t } = useTranslation(["recovery", "common"]);
  const gitStatus = useRecoveryStore((s) => s.gitStatus);
  const resolveDirtyWorktree = useRecoveryStore((s) => s.resolveDirtyWorktree);
  const [result, setResult] = useState<RecoveryGitStatusResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void gitStatus(session.sessionId)
      .then(setResult)
      .catch((err: unknown) => setError(translateError(err, t)))
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
      setError(translateError(err, t));
    } finally {
      setBusy(false);
    }
  };

  const handleDiscard = async (): Promise<void> => {
    if (!window.confirm(t("recovery:confirmDiscard", { title: session.sessionTitle }))) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await resolveDirtyWorktree(session.sessionId, "discard", true);
      onResolved();
    } catch (err) {
      setError(translateError(err, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-2 rounded-md bg-warn/[0.06] p-2.5 text-xs">
      <p className="mb-1.5 flex items-center gap-1.5 font-medium text-warn">
        <Icon name="alert" size={13} /> {t("recovery:dirtyResolver.heading")}
      </p>
      {loading && <p className="text-fg-faint">{t("recovery:dirtyResolver.loadingDiff")}</p>}
      {error && <p className="text-danger">{error}</p>}
      {result && (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-canvas p-2 text-2xs text-fg-muted">
          {result.status || t("recovery:dirtyResolver.noStatusOutput")}
          {"\n---\n"}
          {result.diff || t("recovery:dirtyResolver.noDiffOutput")}
        </pre>
      )}
      <div className="mt-2 flex gap-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void handleKeep()}>
          {t("recovery:dirtyResolver.keep")}
        </Button>
        <Button size="sm" variant="danger" disabled={busy} onClick={() => void handleDiscard()}>
          {t("recovery:dirtyResolver.discard")}
        </Button>
      </div>
    </div>
  );
}

function RecoveryRow({ session }: { session: RecoverySessionInfo }): JSX.Element {
  const { t } = useTranslation(["recovery", "common"]);
  const locale = useLocale((s) => s.locale);
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
      setError(translateError(err, t));
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
      setError(translateError(err, t));
    } finally {
      setMergeStatusLoading(false);
    }
  };

  const handleAbandon = (): void => {
    if (!window.confirm(t("recovery:confirmAbandon", { title: session.sessionTitle }))) {
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
            {t("recovery:sessionMetaLine", {
              profile: session.profileName ?? t("recovery:unknownProfile"),
              interruptedAt: formatTime(session.interruptedAt, locale, t("common:unknown")),
              lastSeenAt: formatTime(session.lastSeenAt, locale, t("common:unknown")),
            })}
          </p>
          {session.task && (
            <p className="mt-1 flex flex-wrap items-center gap-1.5 text-2xs text-fg-muted">
              {t("recovery:taskLine", { title: session.task.title, status: session.task.status })}
              {isMerging && (
                <Badge tone="danger" icon="alert">
                  {t("recovery:crashedWhileMerging")}
                </Badge>
              )}
            </p>
          )}
          {session.workspace && (
            <p className="mt-1 text-2xs text-fg-faint">
              {t("recovery:worktreeLine", { branch: session.workspace.branch })}
              {worktreeMissing && <span className="ml-1 text-danger">{t("recovery:missing")}</span>}
              {!worktreeMissing && worktreeDirty && <span className="ml-1 text-warn">{t("recovery:hasUncommittedChanges")}</span>}
              {!worktreeMissing && !worktreeDirty && <span className="ml-1 text-ok">{t("recovery:clean")}</span>}
            </p>
          )}
        </div>
      </div>

      {error && <Alert tone="danger" className="mt-2">{error}</Alert>}

      {isMerging ? (
        // §5.3:merging 中崩潰——只提供「檢查 git 狀態」,不提供任何自動修復。
        <div className="mt-2">
          <Button size="sm" variant="outline" loading={mergeStatusLoading} className="hover:!border-danger hover:!text-danger" onClick={() => void handleCheckGitStatus()}>
            {mergeStatusLoading ? t("recovery:checkingStatus") : t("recovery:checkGitStatus")}
          </Button>
          {mergeStatus && (
            <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-canvas p-2 text-2xs text-fg-muted">
              {mergeStatus.status || t("recovery:noStatusOutputClean")}
            </pre>
          )}
        </div>
      ) : (
        <div className="mt-2 flex flex-wrap gap-2">
          {/* §4.1:不支援「繼續」的後端,這個按鈕整個不出現(不是灰掉)。 */}
          {session.canContinue && (
            <Button size="sm" variant="primary" disabled={busy} title={t("recovery:continueTitle")} onClick={() => void run(() => continueSession(session.sessionId))}>
              {t("recovery:continueLabel")}
            </Button>
          )}
          <Button size="sm" variant="outline" disabled={busy} title={t("recovery:takeoverTitle")} onClick={() => void run(() => takeover(session.sessionId))}>
            {t("recovery:takeoverLabel")}
          </Button>
          {!worktreeMissing && (
            <Button size="sm" variant="outline" disabled={busy} title={t("recovery:rerunTitle")} onClick={handleRerunClick}>
              {t("recovery:rerunLabel")}
            </Button>
          )}
          <Button size="sm" variant="ghost" disabled={busy} className="hover:!text-danger" onClick={handleAbandon}>
            {t("recovery:abandonLabel")}
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
  const { t } = useTranslation(["recovery", "common"]);
  const sessions = useRecoveryStore((s) => s.sessions);
  const loading = useRecoveryStore((s) => s.loading);

  return (
    <Dialog
      title={t("recovery:title")}
      description={t("recovery:description")}
      icon="alert"
      size="lg"
      onClose={onClose}
    >
      <div className="space-y-2">
        {loading && sessions.length === 0 && <p className="py-6 text-center text-xs text-fg-faint">{t("common:loading")}</p>}
        {!loading && sessions.length === 0 && <EmptyState icon="check" title={t("recovery:emptyTitle")} compact />}
        {sessions.map((session) => (
          <RecoveryRow key={session.sessionId} session={session} />
        ))}
      </div>
    </Dialog>
  );
}
