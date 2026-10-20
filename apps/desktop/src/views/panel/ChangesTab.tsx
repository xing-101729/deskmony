import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { WorkspaceGitDiffResult, WorkspaceGitFile, WorkspaceGitStatusResult } from "@deskmony/shared";
import { Badge } from "../../ui/Badge.js";
import { Button, IconButton, Spinner } from "../../ui/Button.js";
import { Icon } from "../../ui/icons.js";
import { translateError } from "../../lib/error-i18n.js";
import { gitStatusBadge, gitStatusCode } from "../../lib/git-status.js";
import { workspaceGitDiff, workspaceGitStatus } from "../../lib/workspace-api.js";
import { DiffHunks } from "../chat/DiffHunkView.js";
import type { PanelTabProps } from "./panel-tabs.js";
import { useAutoRefresh } from "./useAutoRefresh.js";

type DiffState =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "done"; diff: WorkspaceGitDiffResult };

/**
 * 面板的 Changes 分頁(2026-10-20,見 docs/LAYER-4-detail-design/side-panel_detail.md §P2.2):目前 session 工作資料夾的
 * git 變更。上方分支與檔案數、重新整理鈕;檔案清單(狀態徽章 M/A/D/R/?),點擊展開 diff(`DiffHunks`,與聊天裡 Edit/Write
 * 同一份渲染)。分頁變成可見、以及 session 從 busy 變回 idle 時自動重新整理;不是 git repo 時顯示說明。
 *
 * 展開中的 diff 在重新整理時一併重新載入(檔案可能又變了);請求以序號編號,舊的回應不覆蓋新的。
 */
export function ChangesTab({ session, visible }: PanelTabProps): JSX.Element {
  const { t } = useTranslation(["sidePanel", "errors"]);
  const sessionId = session.id;
  const [status, setStatus] = useState<WorkspaceGitStatusResult | undefined>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [diffs, setDiffs] = useState<Record<string, DiffState>>({});
  const statusRequest = useRef(0);
  const diffRequests = useRef<Record<string, number>>({});
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const filesRef = useRef<WorkspaceGitFile[]>([]);

  const loadDiff = useCallback(
    (file: WorkspaceGitFile): void => {
      const ticket = (diffRequests.current[file.path] ?? 0) + 1;
      diffRequests.current[file.path] = ticket;
      // 重新載入時保留舊內容(避免閃爍成 spinner);第一次才顯示 loading。
      setDiffs((prev) => (prev[file.path]?.phase === "done" ? prev : { ...prev, [file.path]: { phase: "loading" } }));
      workspaceGitDiff(sessionId, file.path, file.oldPath).then(
        (diff) => {
          if (diffRequests.current[file.path] !== ticket) return;
          setDiffs((prev) => ({ ...prev, [file.path]: { phase: "done", diff } }));
        },
        (err: unknown) => {
          if (diffRequests.current[file.path] !== ticket) return;
          setDiffs((prev) => ({ ...prev, [file.path]: { phase: "error", message: translateError(err, t) } }));
        },
      );
    },
    // `t` 不放進依賴:語言切換不該讓 diff 重新載入。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionId],
  );

  const refresh = useCallback((): void => {
    const ticket = ++statusRequest.current;
    setLoading(true);
    workspaceGitStatus(sessionId).then(
      (result) => {
        if (statusRequest.current !== ticket) return;
        setStatus(result);
        setError(null);
        setLoading(false);
        filesRef.current = result.files;
        // 已經沒有變更的檔案:收起並丟掉它的 diff;還在清單裡且展開中的:重新載入。
        const stillThere = new Set(result.files.map((f) => f.path));
        setExpanded((prev) => new Set([...prev].filter((p) => stillThere.has(p))));
        setDiffs((prev) => Object.fromEntries(Object.entries(prev).filter(([p]) => stillThere.has(p))));
        for (const file of result.files) if (expandedRef.current.has(file.path)) loadDiff(file);
      },
      (err: unknown) => {
        if (statusRequest.current !== ticket) return;
        setError(translateError(err, t));
        setLoading(false);
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, loadDiff]);

  useAutoRefresh(session, visible, refresh);
  // 卸載(切換分頁/session)後晚到的回應不要再 setState。
  useEffect(
    () => () => {
      statusRequest.current += 1;
      for (const path of Object.keys(diffRequests.current)) diffRequests.current[path] += 1;
    },
    [],
  );

  const toggle = (file: WorkspaceGitFile): void => {
    const open = expanded.has(file.path);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (open) next.delete(file.path);
      else next.add(file.path);
      return next;
    });
    if (!open) loadDiff(file);
  };

  const branchLabel = status?.isRepo ? (status.branch ? t("sidePanel:changes.branch", { name: status.branch }) : t("sidePanel:changes.detached")) : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-shrink-0 items-center gap-2 border-b border-line-subtle px-3 py-1.5 text-xs text-fg-muted">
        <Icon name="branch" size={13} className="flex-shrink-0 text-fg-subtle" />
        <span className="min-w-0 flex-1 truncate">
          {branchLabel ? <span className="font-mono text-fg-soft">{branchLabel}</span> : t("sidePanel:tabs.changes")}
          {status?.isRepo && (
            <span className="tabular ml-2 text-fg-faint">{t("sidePanel:changes.fileCount", { count: status.files.length })}</span>
          )}
        </span>
        {loading && <Spinner size={12} />}
        <IconButton icon="refresh" aria-label={t("sidePanel:refresh")} title={t("sidePanel:refresh")} disabled={loading} onClick={refresh} />
      </div>

      {error && (
        <div className="flex flex-shrink-0 items-center gap-2 border-b border-line-subtle bg-danger/10 px-3 py-1.5 text-xs text-danger" role="alert">
          <span className="min-w-0 flex-1 break-words">{error}</span>
          <Button size="xs" variant="secondary" onClick={refresh}>
            {t("sidePanel:retry")}
          </Button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {!status && !error && (
          <div className="flex h-full items-center justify-center text-fg-subtle">
            <Spinner size={16} />
          </div>
        )}
        {status && !status.isRepo && (
          <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center text-fg-subtle">
            <p className="text-sm">{t("sidePanel:changes.notRepo")}</p>
            <p className="text-2xs text-fg-faint">{t("sidePanel:changes.notRepoHint")}</p>
          </div>
        )}
        {status?.isRepo && status.files.length === 0 && (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-fg-subtle">{t("sidePanel:changes.clean")}</div>
        )}
        {status?.isRepo && status.files.length > 0 && (
          <ul>
            {status.files.map((file) => {
              const badge = gitStatusBadge(file.index, file.worktree);
              const open = expanded.has(file.path);
              const diff = diffs[file.path];
              return (
                <li key={file.path} className="border-b border-line-subtle">
                  <button
                    type="button"
                    onClick={() => toggle(file)}
                    aria-expanded={open}
                    className="focus-ring flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition hover:bg-surface"
                  >
                    <Icon name={open ? "chevron-down" : "chevron-right"} size={12} className="flex-shrink-0 text-fg-faint" />
                    <Badge
                      tone={badge.tone}
                      mono
                      title={`${t(`sidePanel:changes.status.${badge.letter}`, { defaultValue: badge.letter })} (${gitStatusCode(file.index, file.worktree)})`}
                    >
                      {badge.letter}
                    </Badge>
                    <span className="min-w-0 flex-1 truncate font-mono text-fg-soft" title={file.path}>
                      {file.path}
                      {file.oldPath && <span className="ml-1.5 text-fg-faint">{t("sidePanel:changes.renamedFrom", { path: file.oldPath })}</span>}
                    </span>
                  </button>
                  {open && (
                    <div className="border-t border-line-subtle bg-surface/40">
                      {(!diff || diff.phase === "loading") && (
                        <div className="flex items-center gap-2 px-3 py-2 text-2xs text-fg-faint">
                          <Spinner size={11} />
                        </div>
                      )}
                      {diff?.phase === "error" && <div className="px-3 py-2 text-2xs text-danger">{diff.message}</div>}
                      {diff?.phase === "done" && <DiffBody diff={diff.diff} />}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {status?.truncated && <div className="px-3 py-2 text-2xs text-warn">{t("sidePanel:changes.truncated", { count: status.files.length })}</div>}
      </div>
    </div>
  );
}

function DiffBody({ diff }: { diff: WorkspaceGitDiffResult }): JSX.Element {
  const { t } = useTranslation(["sidePanel"]);
  if (diff.binary) return <div className="px-3 py-2 text-2xs text-fg-faint">{t("sidePanel:changes.binary")}</div>;
  if (diff.hunks.length === 0) return <div className="px-3 py-2 text-2xs text-fg-faint">{t("sidePanel:changes.noContentChanges")}</div>;
  return (
    <div>
      <div className="max-h-[28rem] overflow-auto">
        <DiffHunks hunks={diff.hunks} />
      </div>
      {diff.truncated && <div className="border-t border-line-subtle px-3 py-1.5 text-2xs text-warn">{t("sidePanel:changes.diffTruncated")}</div>}
    </div>
  );
}
