import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { DeskmonyError, type WorkspaceEntry, type WorkspaceListDirResult, type WorkspaceReadFileResult } from "@deskmony/shared";
import { Button, IconButton, Spinner } from "../../ui/Button.js";
import { Icon } from "../../ui/icons.js";
import { translateError } from "../../lib/error-i18n.js";
import { formatBytes, joinRelPath, languageForPath } from "../../lib/file-preview.js";
import { workspaceListDir, workspaceReadFile } from "../../lib/workspace-api.js";
import { CodeBlock } from "../chat/CodeBlock.js";
import type { PanelTabProps } from "./panel-tabs.js";
import { useAutoRefresh } from "./useAutoRefresh.js";

/** 文字預覽超過這個字元數就不上色(語法上色對大檔很慢),改用純文字 `<pre>`。 */
const HIGHLIGHT_MAX_CHARS = 100_000;

interface DirState {
  phase: "loading" | "done" | "error";
  entries: WorkspaceEntry[];
  truncated: boolean;
  message?: string;
}

type PreviewState =
  | { path: string; phase: "loading" }
  | { path: string; phase: "error"; message: string }
  | { path: string; phase: "done"; file: WorkspaceReadFileResult };

type Row =
  | { kind: "entry"; path: string; entry: WorkspaceEntry; depth: number; isDir: boolean; open: boolean; loading: boolean }
  | { kind: "notice"; key: string; depth: number; tone: "muted" | "warn" | "danger"; text: string };

/**
 * 面板的 Files 分頁(2026-10-20,見 docs/LAYER-4-detail-design/side-panel_detail.md §P2.2):目前 session 工作資料夾的檔案樹
 * (逐層展開、展開時才 `listDir`;core 單一資料夾最多回 2000 筆並標 `truncated`,大型目錄不會卡住)+ 篩選框(只篩**已載入**的項目)
 * + 下方預覽(文字用聊天裡同一個 `CodeBlock` 依副檔名上色、圖片直接顯示、binary/太大顯示說明)。
 *
 * symlink/junction 在列表上只標示;點它時先當檔案讀,若 core 回 `workspace.notAFile`(它是資料夾)才改當資料夾展開;
 * 指向工作資料夾外的會被 core 拒絕(`workspace.pathOutsideRoot`),錯誤顯示在預覽區,不會展開。
 */
export function FilesTab({ session, visible }: PanelTabProps): JSX.Element {
  const { t } = useTranslation(["sidePanel", "errors"]);
  const sessionId = session.id;
  const [dirs, setDirs] = useState<Record<string, DirState>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [symlinkDirs, setSymlinkDirs] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [preview, setPreview] = useState<PreviewState | undefined>();
  const dirTickets = useRef<Record<string, number>>({});
  const previewTicket = useRef(0);
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const previewPathRef = useRef<string | undefined>(undefined);
  previewPathRef.current = preview?.path;
  const [anyLoading, setAnyLoading] = useState(false);

  const loadDir = useCallback(
    (path: string): void => {
      const ticket = (dirTickets.current[path] ?? 0) + 1;
      dirTickets.current[path] = ticket;
      setAnyLoading(true);
      setDirs((prev) => ({ ...prev, [path]: { phase: "loading", entries: prev[path]?.entries ?? [], truncated: prev[path]?.truncated ?? false } }));
      workspaceListDir(sessionId, path).then(
        (result: WorkspaceListDirResult) => {
          if (dirTickets.current[path] !== ticket) return;
          setDirs((prev) => ({ ...prev, [path]: { phase: "done", entries: result.entries, truncated: result.truncated } }));
          setAnyLoading(false);
        },
        (err: unknown) => {
          if (dirTickets.current[path] !== ticket) return;
          setDirs((prev) => ({ ...prev, [path]: { phase: "error", entries: [], truncated: false, message: translateError(err, t) } }));
          setAnyLoading(false);
        },
      );
    },
    // `t` 不放進依賴:語言切換不該讓檔案樹重新載入。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionId],
  );

  const loadPreview = useCallback(
    (path: string, isSymlink = false): void => {
      const ticket = ++previewTicket.current;
      setPreview((prev) => (prev?.path === path && prev.phase === "done" ? prev : { path, phase: "loading" }));
      workspaceReadFile(sessionId, path).then(
        (file) => {
          if (previewTicket.current !== ticket) return;
          setPreview({ path, phase: "done", file });
        },
        (err: unknown) => {
          if (previewTicket.current !== ticket) return;
          if (isSymlink && err instanceof DeskmonyError && err.code === "workspace.notAFile") {
            // 它是指向資料夾的 symlink/junction(且在工作資料夾內):改當資料夾展開。
            setPreview(undefined);
            setSymlinkDirs((prev) => new Set(prev).add(path));
            setExpanded((prev) => new Set(prev).add(path));
            loadDir(path);
            return;
          }
          setPreview({ path, phase: "error", message: translateError(err, t) });
        },
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionId, loadDir],
  );

  const refresh = useCallback((): void => {
    loadDir("");
    for (const path of expandedRef.current) loadDir(path);
    if (previewPathRef.current) loadPreview(previewPathRef.current);
  }, [loadDir, loadPreview]);

  useAutoRefresh(session, visible, refresh);
  useEffect(
    () => () => {
      // 卸載後晚到的回應作廢。
      previewTicket.current += 1;
      for (const path of Object.keys(dirTickets.current)) dirTickets.current[path] += 1;
    },
    [],
  );

  const onEntryClick = (row: Extract<Row, { kind: "entry" }>): void => {
    if (row.isDir) {
      const open = expandedRef.current.has(row.path);
      setExpanded((prev) => {
        const next = new Set(prev);
        if (open) next.delete(row.path);
        else next.add(row.path);
        return next;
      });
      if (!open && !dirs[row.path]) loadDir(row.path);
      return;
    }
    loadPreview(row.path, row.entry.type === "symlink");
  };

  const rows = useMemo(() => buildRows(dirs, expanded, symlinkDirs, filter, t), [dirs, expanded, symlinkDirs, filter, t]);
  const copyPath = (path: string): void => {
    void navigator.clipboard.writeText(path).catch(() => undefined);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-shrink-0 items-center gap-1.5 border-b border-line-subtle px-2 py-1.5">
        <div className="relative min-w-0 flex-1">
          <Icon name="search" size={12} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-fg-faint" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t("sidePanel:files.filter")}
            aria-label={t("sidePanel:files.filter")}
            className="focus-ring h-6 w-full rounded border border-line bg-surface pl-6 pr-2 text-xs text-fg outline-none placeholder:text-fg-faint"
          />
        </div>
        {anyLoading && <Spinner size={12} />}
        <IconButton icon="refresh" aria-label={t("sidePanel:refresh")} title={t("sidePanel:refresh")} onClick={refresh} />
      </div>

      <div className={`min-h-0 overflow-auto ${preview ? "flex-[2]" : "flex-1"}`} role="tree" aria-label={t("sidePanel:tabs.files")}>
        {rows.map((row) =>
          row.kind === "notice" ? (
            <div
              key={row.key}
              style={{ paddingLeft: `${row.depth * 0.75 + 1.75}rem` }}
              className={`py-1 pr-3 text-2xs ${row.tone === "danger" ? "text-danger" : row.tone === "warn" ? "text-warn" : "text-fg-faint"}`}
            >
              {row.text}
            </div>
          ) : (
            <button
              key={row.path}
              type="button"
              role="treeitem"
              aria-expanded={row.isDir ? row.open : undefined}
              aria-selected={preview?.path === row.path}
              onClick={() => onEntryClick(row)}
              style={{ paddingLeft: `${row.depth * 0.75 + 0.5}rem` }}
              className={`focus-ring flex w-full items-center gap-1.5 py-1 pr-3 text-left text-xs transition hover:bg-surface ${
                preview?.path === row.path ? "bg-accent/10 text-fg" : "text-fg-soft"
              }`}
            >
              {row.isDir ? (
                <Icon name={row.open ? "chevron-down" : "chevron-right"} size={12} className="flex-shrink-0 text-fg-faint" />
              ) : (
                <span className="inline-block w-3 flex-shrink-0" />
              )}
              <Icon
                name={row.isDir ? "folder" : "file"}
                size={13}
                className={`flex-shrink-0 ${row.isDir ? "text-accent" : "text-fg-subtle"}`}
              />
              <span className="min-w-0 flex-1 truncate font-mono" title={row.path}>
                {row.entry.name}
              </span>
              {row.entry.type === "symlink" && (
                <span className="flex-shrink-0 text-2xs text-fg-faint" title={t("sidePanel:files.symlink")}>
                  ↪
                </span>
              )}
              {row.loading && <Spinner size={11} />}
              {row.entry.type === "file" && <span className="tabular flex-shrink-0 text-2xs text-fg-faint">{formatBytes(row.entry.size)}</span>}
            </button>
          ),
        )}
      </div>

      {preview && (
        <div className="flex min-h-0 flex-[3] flex-col border-t border-line-subtle">
          <div className="flex flex-shrink-0 items-center gap-1.5 border-b border-line-subtle px-3 py-1 text-xs text-fg-muted">
            <span className="min-w-0 flex-1 truncate font-mono" title={preview.path}>
              {preview.path}
            </span>
            <IconButton
              icon="copy"
              aria-label={t("sidePanel:files.copyPath")}
              title={t("sidePanel:files.copyPath")}
              onClick={() => copyPath(preview.path)}
            />
            <IconButton icon="x" aria-label={t("sidePanel:files.closePreview")} title={t("sidePanel:files.closePreview")} onClick={() => setPreview(undefined)} />
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            <PreviewBody preview={preview} onRetry={() => loadPreview(preview.path)} />
          </div>
        </div>
      )}
    </div>
  );
}

/** 把已載入的資料夾狀態攤平成要顯示的列。篩選只看**已載入**的項目,見 `FilesTab` 的說明。 */
function buildRows(
  dirs: Record<string, DirState>,
  expanded: Set<string>,
  symlinkDirs: Set<string>,
  filter: string,
  t: TFunction,
): Row[] {
  const needle = filter.trim().toLowerCase();
  const rows: Row[] = [];

  const walk = (dirPath: string, depth: number): boolean => {
    const state = dirs[dirPath];
    if (!state) {
      if (dirPath === "") rows.push({ kind: "notice", key: "root-loading", depth: -1, tone: "muted", text: t("sidePanel:files.loading") });
      return false;
    }
    let anyVisible = false;
    for (const entry of state.entries) {
      const path = joinRelPath(dirPath, entry.name);
      const isDir = entry.type === "dir" || (entry.type === "symlink" && symlinkDirs.has(path));
      const selfMatch = !needle || entry.name.toLowerCase().includes(needle);
      const rowIndex = rows.length;
      rows.push({ kind: "entry", path, entry, depth, isDir, open: false, loading: false });
      let childMatch = false;
      if (isDir && dirs[path] && (expanded.has(path) || needle)) childMatch = walk(path, depth + 1);
      if (needle && !selfMatch && !childMatch) {
        rows.length = rowIndex; // 自己與(已推進去的)子列都不符合:整段拿掉
        continue;
      }
      const row = rows[rowIndex] as Extract<Row, { kind: "entry" }>;
      row.open = isDir && (expanded.has(path) || (needle !== "" && childMatch));
      row.loading = isDir && dirs[path]?.phase === "loading";
      anyVisible = true;
    }
    if (state.phase === "error") {
      rows.push({ kind: "notice", key: `${dirPath}:error`, depth, tone: "danger", text: state.message ?? "" });
    } else if (!needle) {
      if (state.truncated) {
        rows.push({ kind: "notice", key: `${dirPath}:truncated`, depth, tone: "warn", text: t("sidePanel:files.truncated", { count: state.entries.length }) });
      } else if (state.phase === "done" && state.entries.length === 0) {
        rows.push({ kind: "notice", key: `${dirPath}:empty`, depth, tone: "muted", text: t("sidePanel:files.empty") });
      }
    }
    return anyVisible;
  };

  walk("", 0);
  return rows;
}

function PreviewBody({ preview, onRetry }: { preview: PreviewState; onRetry: () => void }): JSX.Element {
  const { t } = useTranslation(["sidePanel"]);
  if (preview.phase === "loading") {
    return (
      <div className="flex h-full items-center justify-center text-fg-subtle">
        <Spinner size={16} />
      </div>
    );
  }
  if (preview.phase === "error") {
    return (
      <div className="flex flex-col items-start gap-2 p-3 text-xs text-danger" role="alert">
        <span className="break-words">{preview.message}</span>
        <Button size="xs" variant="secondary" onClick={onRetry}>
          {t("sidePanel:retry")}
        </Button>
      </div>
    );
  }
  const file = preview.file;
  if (file.kind === "binary") {
    return <div className="p-3 text-xs text-fg-subtle">{t("sidePanel:files.binary", { size: formatBytes(file.size) })}</div>;
  }
  if (file.kind === "tooLarge") {
    return <div className="p-3 text-xs text-fg-subtle">{t("sidePanel:files.tooLarge", { size: formatBytes(file.size) })}</div>;
  }
  if (file.kind === "image") {
    return (
      <div className="flex min-h-full items-center justify-center bg-surface p-3">
        <img
          src={`data:${file.mime};base64,${file.dataBase64}`}
          alt={preview.path}
          className="max-h-full max-w-full object-contain"
        />
      </div>
    );
  }
  return (
    <div>
      {file.truncated && (
        <div className="border-b border-line-subtle px-3 py-1 text-2xs text-warn">
          {t("sidePanel:files.previewTruncated", { shown: formatBytes(new TextEncoder().encode(file.content).length), total: formatBytes(file.size) })}
        </div>
      )}
      {file.content.length === 0 ? (
        <div className="p-3 text-xs text-fg-faint">{t("sidePanel:files.emptyFile")}</div>
      ) : file.content.length > HIGHLIGHT_MAX_CHARS ? (
        <pre className="overflow-auto p-3 font-mono text-2xs text-fg-soft">{file.content}</pre>
      ) : (
        <div className="px-2">
          <CodeBlock className={`language-${languageForPath(preview.path)}`}>{file.content}</CodeBlock>
        </div>
      )}
    </div>
  );
}
