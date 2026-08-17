import { useTranslation } from "react-i18next";
import type { ChatItem } from "../../stores/session-store.js";
import { Badge } from "../../ui/Badge.js";

/** 對應 SDK 的 `FileEditOutput`/`FileWriteOutput.structuredPatch[]`(見
 *  async-scribbling-llama.md Phase 4)。跟 TodoListView.tsx 一樣不 import SDK
 *  型別——desktop 這一側從沒依賴過 `@anthropic-ai/claude-agent-sdk`。 */
export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

export interface DiffResult {
  filePath: string;
  hunks: DiffHunk[];
}

/** 防禦性驗證:形狀不符就回傳 null,呼叫端(ChatView.tsx)據此 fallback 回
 *  通用的 `ToolCallBubble`——同 TodoListView.tsx 的 `parseTodoWriteInput` 慣例。 */
export function parseDiffResult(value: unknown): DiffResult | null {
  if (typeof value !== "object" || value === null) return null;
  const { filePath, structuredPatch, content } = value as Record<string, unknown>;
  if (typeof filePath !== "string") return null;
  if (!Array.isArray(structuredPatch)) return null;

  const hunks: DiffHunk[] = [];
  for (const entry of structuredPatch) {
    if (typeof entry !== "object" || entry === null) return null;
    const { oldStart, oldLines, newStart, newLines, lines } = entry as Record<string, unknown>;
    if (typeof oldStart !== "number" || typeof oldLines !== "number") return null;
    if (typeof newStart !== "number" || typeof newLines !== "number") return null;
    if (!Array.isArray(lines) || !lines.every((line) => typeof line === "string")) return null;
    hunks.push({ oldStart, oldLines, newStart, newLines, lines: lines as string[] });
  }

  // 實測(用真實憑證起 session 觀察,見 async-scribbling-llama.md Phase 4 驗證
  // 段落):`FileWriteOutput` 建立新檔(`type:"create"`)時 `structuredPatch`
  // 是空陣列——SDK 並未替新檔合成 pseudo-diff hunk,這點與計畫原先的假設不同。
  // 這裡從 `content` 自己合成一個全綠 hunk,才能符合「Write 渲染成全綠新檔」
  // 的目標。`FileEditOutput` 沒有 `content` 欄位,這個分支對 Edit 天然不會
  // 觸發(Edit 的 structuredPatch 實測一律有值)。
  if (hunks.length === 0 && typeof content === "string" && content.length > 0) {
    const contentLines = content.split("\n");
    hunks.push({
      oldStart: 0,
      oldLines: 0,
      newStart: 1,
      newLines: contentLines.length,
      lines: contentLines.map((line) => `+${line}`),
    });
  }

  return { filePath, hunks };
}

/** 單一 diff 行:低飽和 tint + 同色文字,對齊 Badge.tsx 既有的語意色慣例
 *  (`bg-ok/12 text-ok`/`bg-danger/12 text-danger`)。v1 不做行內 word-diff,
 *  純粹依前綴字元(`+`/`-`/` `,或 `\ No newline at end of file` 這類中性
 *  metadata 行)整行上色。 */
function DiffLine({ line }: { line: string }): JSX.Element {
  const marker = line.charAt(0);
  const tone = marker === "+" ? "bg-ok/10 text-ok" : marker === "-" ? "bg-danger/10 text-danger" : "text-fg-muted";
  return <div className={`whitespace-pre px-2.5 py-0.5 font-mono text-2xs ${tone}`}>{line || " "}</div>;
}

/** `toolName` 為 `Edit`/`Write` 且 `structuredResult` 通過 `parseDiffResult()`
 *  驗證時,ChatView.tsx 的 `ChatBubble` 分派到這裡渲染,取代通用的
 *  `ToolCallBubble`。標頭比照 `ToolCallBubble` 的狀態圓點/badge 慣例。 */
export function DiffHunkView({
  item,
  diff,
}: {
  item: Extract<ChatItem, { kind: "tool" }>;
  diff: DiffResult;
}): JSX.Element {
  const { t } = useTranslation(["chat"]);
  const tone = item.status === "running" ? "accent" : item.isError ? "danger" : "ok";

  let added = 0;
  let removed = 0;
  for (const hunk of diff.hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith("+")) added += 1;
      else if (line.startsWith("-")) removed += 1;
    }
  }

  return (
    <div className="my-1.5 overflow-hidden rounded-md border border-line-subtle bg-surface/60 text-xs">
      <div className="flex items-center gap-2 px-2.5 py-1.5 text-fg-muted">
        <span
          className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${
            item.status === "running" ? "animate-breathe bg-accent" : item.isError ? "bg-danger" : "bg-ok"
          }`}
        />
        <span className="flex-shrink-0 font-mono text-fg-soft">{item.toolName}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-2xs text-fg-faint" title={diff.filePath}>
          {diff.filePath}
        </span>
        <div className="flex flex-shrink-0 items-center gap-2">
          {(added > 0 || removed > 0) && (
            <span className="tabular flex items-center gap-1 font-mono text-2xs">
              {added > 0 && (
                <span className="text-ok" title={t("chat:diff.addedLinesTitle", { count: added })}>
                  +{added}
                </span>
              )}
              {removed > 0 && (
                <span className="text-danger" title={t("chat:diff.removedLinesTitle", { count: removed })}>
                  -{removed}
                </span>
              )}
            </span>
          )}
          <Badge tone={tone}>
            {item.status === "running"
              ? t("chat:tool.statusRunning")
              : item.isError
                ? t("chat:tool.statusFailed")
                : t("chat:tool.statusDone")}
          </Badge>
        </div>
      </div>
      {diff.hunks.length === 0 ? (
        <div className="border-t border-line-subtle px-2.5 py-2 text-2xs text-fg-faint">{t("chat:diff.noChangesLabel")}</div>
      ) : (
        <div className="max-h-[420px] overflow-auto border-t border-line-subtle">
          {diff.hunks.map((hunk, i) => (
            <div key={i}>
              <div className="bg-canvas px-2.5 py-1 font-mono text-2xs text-fg-faint">
                @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
              </div>
              {hunk.lines.map((line, j) => (
                <DiffLine key={j} line={line} />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
