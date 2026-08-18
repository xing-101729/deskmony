import { useEffect, useMemo, useRef, useState, type ChangeEvent, type ClipboardEvent } from "react";
import { useTranslation } from "react-i18next";
import type { AgentProfile, EffortLevel, Session } from "@deskmony/shared";
import { PromptImageMediaTypeSchema, type PromptImageMediaType } from "@deskmony/shared";
import {
  useSessionStore,
  selectProviderModels,
  selectUsageReporting,
  type ChatItem,
  type PendingAttachment,
} from "../stores/session-store.js";
import { AutoModeControl } from "./AutoModeControl.js";
import { IconButton } from "../ui/Button.js";
import { Select } from "../ui/Field.js";
import { Badge, Meta } from "../ui/Badge.js";
import { Icon } from "../ui/icons.js";
import { Meter } from "../ui/Feedback.js";
import { shortenPath } from "../lib/workspaces.js";
import { resolveSystemEventText } from "../lib/system-events.js";
import { MarkdownMessage } from "./chat/MarkdownMessage.js";
import { TodoListView, parseTodoWriteInput } from "./chat/TodoListView.js";
import { DiffHunkView, parseDiffResult } from "./chat/DiffHunkView.js";
import { ToolImage, parseImageBlock } from "./chat/ToolImage.js";
import { AskUserQuestionWidget, parseAskUserQuestionInput } from "./chat/AskUserQuestionWidget.js";

/**
 * 顯示目前 session 的 model,並(`software="claude-agent-sdk"` 或
 * `"opencode"`)提供切換用的下拉選單(功能3d)。兩者的 `AgentAdapter.
 * setModel()` 實作方式不同(前者呼叫 SDK 官方 API,後者是 adapter 內部的
 * session 覆寫,下一則訊息才生效),但對這裡是同一個 `session.setModel`
 * gateway 呼叫,不需要分流處理,見 packages/adapters/src/types.ts 的介面
 * 註解。acp/pty/codex 的 model 由外部 agent/CLI 自行管理,這裡只顯示唯讀
 * 資訊,不提供切換控制。
 */
function ModelControl({ session, profile }: { session: Session; profile: AgentProfile | undefined }): JSX.Element {
  const { t } = useTranslation(["chat"]);
  const setSessionModel = useSessionStore((s) => s.setSessionModel);
  const enabledModelIds = useSessionStore((s) => s.enabledModelIds);
  const detectedAgents = useSessionStore((s) => s.detectedAgents);
  const providerPrefs = useSessionStore((s) => s.providerPrefs);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 注意:`selectProviderModels()` 本身是通用邏輯(依 profile.providerId 查
  // resolveProviders() 的結果),不是 Claude 專屬——opencode profile 只要是
  // 透過 ProfileCreateDialog 目前的流程建立(帶 providerId="opencode"),這裡
  // 就能拿到 `opencode models` 偵測到的清單,變數名稱維持通用命名。
  const availableModels = useMemo(
    () => selectProviderModels(profile, detectedAgents, providerPrefs, enabledModelIds),
    [profile, detectedAgents, providerPrefs, enabledModelIds],
  );

  const supportsModelSwitch = session.adapterType === "claude-agent-sdk" || session.adapterType === "opencode";
  const currentModel = session.model ?? profile?.model ?? "";

  const handleChange = async (model: string): Promise<void> => {
    if (!model || model === currentModel) return;
    setSwitching(true);
    setError(null);
    try {
      await setSessionModel(session.id, model);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSwitching(false);
    }
  };

  if (!supportsModelSwitch) {
    return (
      <Badge tone="neutral" mono title={t("chat:model.managedByAgentTitle")}>
        {currentModel || t("chat:model.managedByAgentLabel")}
      </Badge>
    );
  }

  const knownIds = new Set(availableModels.map((m) => m.id));
  const options =
    currentModel && !knownIds.has(currentModel)
      ? [{ id: currentModel, label: currentModel }, ...availableModels]
      : availableModels;

  return (
    <div className="flex items-center gap-1.5">
      <Select
        aria-label={t("chat:model.switchAriaLabel")}
        value={currentModel}
        onChange={(e) => void handleChange(e.target.value)}
        disabled={switching}
        className="!h-6 !text-2xs"
      >
        {!currentModel && <option value="">{t("chat:control.notSpecifiedOption")}</option>}
        {options.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
      </Select>
      {error && (
        <span className="text-2xs text-danger" title={error}>
          {t("chat:control.switchFailed")}
        </span>
      )}
    </div>
  );
}

/**
 * 比照上面的 `ModelControl`,但更簡單:思考程度固定 5 個等級,不需要 provider
 * 偵測清單(見 packages/shared/src/agent-profile.ts 的 `EffortLevelSchema`
 * 註解)。只有 `claude-agent-sdk` 驗證支援這個能力——
 * `session.adapterType !== "claude-agent-sdk"` 時直接 `return null`,不像
 * `ModelControl` 對 acp/pty 顯示唯讀 badge:「思考程度」對那些 adapter 根本
 * 不是一個存在的概念,不需要顯示任何東西。
 */
function EffortControl({ session, profile }: { session: Session; profile: AgentProfile | undefined }): JSX.Element | null {
  const { t } = useTranslation(["chat"]);
  const setSessionEffort = useSessionStore((s) => s.setSessionEffort);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (session.adapterType !== "claude-agent-sdk") return null;

  const currentEffort = session.effort ?? profile?.effort ?? "";

  const handleChange = async (effort: EffortLevel | ""): Promise<void> => {
    if (!effort || effort === currentEffort) return;
    setSwitching(true);
    setError(null);
    try {
      await setSessionEffort(session.id, effort);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSwitching(false);
    }
  };

  return (
    <div className="flex items-center gap-1.5">
      <Select
        aria-label={t("chat:effort.switchAriaLabel")}
        value={currentEffort}
        onChange={(e) => void handleChange(e.target.value as EffortLevel | "")}
        disabled={switching}
        className="!h-6 !text-2xs"
      >
        {!currentEffort && <option value="">{t("chat:control.notSpecifiedOption")}</option>}
        <option value="low">low</option>
        <option value="medium">medium</option>
        <option value="high">high</option>
        <option value="xhigh">xhigh</option>
        <option value="max">max</option>
      </Select>
      {error && (
        <span className="text-2xs text-danger" title={error}>
          {t("chat:control.switchFailed")}
        </span>
      )}
    </div>
  );
}

/**
 * async-scribbling-llama.md Phase 5:`tool_result` 的 `output` 是陣列時,裡面
 * 是 Anthropic 的 content block——`{type:"image", source:{...}}` 與
 * `{type:"text", text}` 可能在同一個陣列裡共存(一個工具結果同時帶說明文字
 * 與截圖),依各自形狀分別渲染;無法辨識的形狀 fallback 回 JSON.stringify,
 * 不遺漏資料。
 */
function ToolOutputBlock({ block }: { block: unknown }): JSX.Element {
  const image = parseImageBlock(block);
  if (image) return <ToolImage mediaType={image.mediaType} data={image.data} />;

  if (typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text") {
    const text = (block as { text?: unknown }).text;
    if (typeof text === "string") {
      return (
        <pre className="whitespace-pre-wrap break-all rounded bg-canvas px-2 py-1.5 font-mono text-2xs text-fg-muted">
          {text}
        </pre>
      );
    }
  }

  return (
    <pre className="whitespace-pre-wrap break-all rounded bg-canvas px-2 py-1.5 font-mono text-2xs text-fg-muted">
      {JSON.stringify(block, null, 2)}
    </pre>
  );
}

/**
 * async-scribbling-llama.md Phase 7:`export` 讓 AskUserQuestionWidget.tsx
 * 能重用這個通用氣泡當它自己的「兩者皆非」fallback(SDK 已送出 tool-call、
 * 但待答狀態還沒抵達,或 reload 後 pendingUserDialogs 這個純記憶體狀態沒有
 * 重建)——與 TodoListView/DiffHunkView 不同,那兩個元件的 fallback 判斷完全
 * 留在下面 ChatBubble 的分派處(parse 失敗就不渲染,直接落到分派處最後一行的
 * ToolCallBubble),AskUserQuestionWidget 則需要在自己內部多分辨一種「已解析
 * 但還沒有 pending/output」的過渡狀態,因此需要能直接拿到這個元件本身。
 */
export function ToolCallBubble({ item }: { item: Extract<ChatItem, { kind: "tool" }> }): JSX.Element {
  const { t } = useTranslation(["chat"]);
  const tone = item.status === "running" ? "accent" : item.isError ? "danger" : "ok";
  return (
    <details className="group my-1.5 rounded-md border border-line-subtle bg-surface/60 text-xs">
      <summary className="flex cursor-pointer select-none list-none items-center gap-2 px-2.5 py-1.5 text-fg-muted marker:content-none">
        <Icon
          name="chevron-right"
          size={11}
          className="flex-shrink-0 text-fg-faint transition-transform group-open:rotate-90"
        />
        <span
          className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${
            item.status === "running" ? "animate-breathe bg-accent" : item.isError ? "bg-danger" : "bg-ok"
          }`}
        />
        <span className="font-mono text-fg-soft">{item.toolName || "tool"}</span>
        <Badge tone={tone} className="ml-auto">
          {item.status === "running" ? t("chat:tool.statusRunning") : item.isError ? t("chat:tool.statusFailed") : t("chat:tool.statusDone")}
        </Badge>
      </summary>
      <div className="space-y-2 border-t border-line-subtle px-2.5 py-2">
        {item.input !== undefined && (
          <div>
            <div className="mb-1 text-2xs font-medium uppercase tracking-wide text-fg-faint">{t("chat:tool.inputLabel")}</div>
            <pre className="whitespace-pre-wrap break-all rounded bg-canvas px-2 py-1.5 font-mono text-2xs text-fg-muted">
              {JSON.stringify(item.input, null, 2)}
            </pre>
          </div>
        )}
        {item.output !== undefined && (
          <div>
            <div className="mb-1 text-2xs font-medium uppercase tracking-wide text-fg-faint">{t("chat:tool.outputLabel")}</div>
            {Array.isArray(item.output) ? (
              <div className="space-y-1.5">
                {item.output.map((block, index) => (
                  <ToolOutputBlock key={index} block={block} />
                ))}
              </div>
            ) : (
              <pre className="whitespace-pre-wrap break-all rounded bg-canvas px-2 py-1.5 font-mono text-2xs text-fg-muted">
                {typeof item.output === "string" ? item.output : JSON.stringify(item.output, null, 2)}
              </pre>
            )}
          </div>
        )}
      </div>
    </details>
  );
}

/**
 * S3a(usage-metering)L4 §4:「ChatView 標頭顯示累計 $(有的話)」。三態能力
 * 決定顯示與否(見 selectUsageReporting()):`"unknown"`/`"unsupported"` 時渲染
 * 明確的警示徽章,而非整個沉默——見 S3b §0.2 的誠實揭露要求。
 */
function UsageBadge({ session }: { session: Session }): JSX.Element | null {
  const { t } = useTranslation(["chat"]);
  const usage = useSessionStore((s) => s.sessionUsage[session.id]);
  const capabilities = useSessionStore((s) => s.capabilitiesBySoftware[session.adapterType]);
  const support = selectUsageReporting(capabilities, usage);
  if (support !== "supported") {
    return (
      <Badge tone="warn" icon="alert" title={t("chat:usage.cannotMeasureTitle")}>
        {support === "unknown" ? t("chat:usage.unknownLabel") : t("chat:usage.cannotMeasureLabel")}
      </Badge>
    );
  }
  const hasValue = usage?.costAmount !== undefined;
  return (
    <Badge
      tone={hasValue ? "neutral" : "neutral"}
      mono
      title={hasValue ? t("chat:usage.hasValueTitle") : t("chat:usage.noValueYetTitle")}
    >
      {hasValue ? `${usage?.costCurrency ?? ""} ${usage?.costAmount?.toFixed(4)}` : "$ —"}
    </Badge>
  );
}

/** 依「$ 為主、token 兜底」規則(HLD §3.2)算出目前用了幾成。 */
function budgetPercentForDisplay(
  rollup: { costAmount: number; costCurrency?: string; inputTokens: number; outputTokens: number },
  limits: { maxCostUsd?: number; maxTokens?: number },
): number | undefined {
  if (limits.maxCostUsd !== undefined && rollup.costCurrency !== undefined) {
    return (rollup.costAmount / limits.maxCostUsd) * 100;
  }
  if (limits.maxTokens !== undefined) {
    return ((rollup.inputTokens + rollup.outputTokens) / limits.maxTokens) * 100;
  }
  return undefined;
}

/**
 * S3b(CostGovernor)§7:標頭顯示累計與預算餘量。只有 `task`(綁定任務有設
 * 預算)與 `dailyTripped`(今日 kill-switch 已觸發)兩種情況會渲染。
 */
function CostBudgetBadge({ session }: { session: Session }): JSX.Element | null {
  const { t } = useTranslation(["chat"]);
  const summary = useSessionStore((s) => s.costSummaryBySession[session.id]);
  const effectiveConfig = useSessionStore((s) => s.effectiveConfig);
  const fetchCostSummary = useSessionStore((s) => s.fetchCostSummary);

  useEffect(() => {
    void fetchCostSummary(session.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id]);

  if (!summary || !effectiveConfig) return null;
  const budget = effectiveConfig.budget;

  const parts: Array<{ label: string; tripped: boolean; percent?: number }> = [];
  if (summary.task) {
    if (summary.task.tripped) {
      parts.push({ label: t("chat:cost.taskTrippedLabel", { title: summary.task.title }), tripped: true });
    } else {
      const percent = budgetPercentForDisplay(summary.task.rollup, {
        maxCostUsd: budget.task.maxCostUsd.value,
        maxTokens: budget.task.maxTokens.value,
      });
      if (percent !== undefined) {
        parts.push({ label: t("chat:cost.taskBudgetPercentLabel", { percent: Math.min(100, Math.round(percent)) }), tripped: false, percent });
      }
    }
  }
  if (summary.dailyTripped) {
    parts.push({ label: t("chat:cost.dailyTrippedLabel"), tripped: true });
  }

  if (parts.length === 0) return null;

  return (
    <div className="flex items-center gap-1.5">
      {parts.map((part) => (
        <div key={part.label} className="flex items-center gap-1.5">
          {part.percent !== undefined && <Meter percent={part.percent} className="w-10" />}
          <Badge
            tone={part.tripped ? "danger" : "neutral"}
            title={part.tripped ? t("chat:cost.trippedTitle") : t("chat:cost.percentTitle")}
          >
            {part.label}
          </Badge>
        </div>
      ))}
    </div>
  );
}

/** 圖片附件有縮圖可看;PDF/純文字附件沒有,只能靠檔名+圖示辨識。 */
function AttachmentFileChip({ name, className }: { name: string; className?: string }): JSX.Element {
  return (
    <span className={`inline-flex items-center gap-1 overflow-hidden ${className ?? ""}`} title={name}>
      <Icon name="file" size={12} className="flex-shrink-0" />
      <span className="truncate">{name}</span>
    </span>
  );
}

function ChatBubble({ item }: { item: ChatItem }): JSX.Element | null {
  const { t } = useTranslation(["chat"]);

  if (item.kind === "tool") {
    if (item.toolName === "TodoWrite") {
      const todos = parseTodoWriteInput(item.input);
      if (todos) return <TodoListView todos={todos} />;
    }
    if ((item.toolName === "Edit" || item.toolName === "Write") && !item.isError) {
      // isError 時不嘗試 diff 渲染,即使 structuredResult 剛好驗證通過——失敗
      // 的編輯/寫入沒有真的套用變更,顯示 diff 只會誤導;fallback 回
      // ToolCallBubble 才能看到實際的錯誤訊息(在 output 裡)。這個分支的
      // 錯誤實際形狀未經真實 session 實測驗證,採保守處理。
      const diff = parseDiffResult(item.structuredResult);
      if (diff) return <DiffHunkView item={item} diff={diff} />;
    }
    if (item.toolName === "AskUserQuestion") {
      const questions = parseAskUserQuestionInput(item.input);
      if (questions) return <AskUserQuestionWidget item={item} questions={questions} />;
    }
    return <ToolCallBubble item={item} />;
  }

  if (item.kind === "system") {
    return (
      <div className="my-1.5 rounded-md bg-danger/10 px-2.5 py-1.5 text-xs leading-relaxed text-danger">
        {item.content}
      </div>
    );
  }

  const isUser = item.kind === "user";
  return (
    <div className={`my-1 flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[75%] rounded-lg px-3 py-2 text-sm leading-relaxed ${
          isUser ? "whitespace-pre-wrap bg-accent text-accent-fg" : "bg-surface text-fg"
        }`}
      >
        {/* async-scribbling-llama.md Phase 6:使用者傳送時夾帶的圖片/檔案——
            樂觀回顯(session-store.ts 的 sendPrompt() action)與 DB reload 後
            的 history(messageRecordsToItems())兩條路徑都會填
            item.attachments,這裡不需要區分來源。 */}
        {item.kind === "user" && item.attachments && item.attachments.length > 0 && (
          <div className="mb-1.5 flex flex-wrap gap-1.5">
            {item.attachments.map((att, index) =>
              att.type === "image" ? (
                <img
                  key={index}
                  src={`data:${att.mediaType};base64,${att.data}`}
                  alt={t("chat:composer.attachmentAltText")}
                  className="max-h-56 max-w-full rounded-md border border-accent-fg/20 object-contain"
                />
              ) : (
                <AttachmentFileChip
                  key={index}
                  name={att.name}
                  className="rounded-md border border-accent-fg/20 bg-accent-fg/10 px-2 py-1 text-2xs"
                />
              ),
            )}
          </div>
        )}
        {isUser ? item.content : <MarkdownMessage content={item.content} />}
        {item.kind === "assistant" && item.streaming && (
          <span className="ml-1 inline-block h-3 w-1.5 animate-pulse bg-fg-muted align-middle" />
        )}
      </div>
    </div>
  );
}

/**
 * async-scribbling-llama.md Phase 6:composer 待送附件的本地狀態形狀——比
 * `PendingAttachment`(session-store.ts,樂觀回顯/wire payload 共用的形狀)
 * 多一個純前端用的 `id`,供縮圖預覽條的 React key 與「移除這個」操作使用,
 * 送出前會被拿掉(見 ChatView 內的 handleSend())。
 */
type ComposerAttachment = PendingAttachment & { id: string };

const SUPPORTED_IMAGE_MEDIA_TYPES = PromptImageMediaTypeSchema.options;

function isSupportedImageMediaType(value: string): value is PromptImageMediaType {
  return (SUPPORTED_IMAGE_MEDIA_TYPES as readonly string[]).includes(value);
}

function readFileAsDataUrlBase64(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const commaIndex = result.indexOf(",");
      resolve(commaIndex === -1 ? null : result.slice(commaIndex + 1));
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

function readFileAsBytes(file: File): Promise<Uint8Array | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result instanceof ArrayBuffer ? new Uint8Array(reader.result) : null);
    reader.onerror = () => resolve(null);
    reader.readAsArrayBuffer(file);
  });
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * 「這個檔案是不是文字檔」沒有可靠的 MIME type 可查——瀏覽器對 .ts/.py/.log
 * 這類副檔名多半回報空字串或亂猜的 type(例如 Windows 上 .ts 常被猜成
 * video/mp2t),不能拿 file.type 當判斷依據。改用 git/grep -I 同一套慣用
 * 手法:取檔案開頭一段位元組,看有沒有 NUL byte——二進位格式幾乎必然有,
 * 正常文字檔幾乎不會。只取前 8000 bytes 取樣,避免大檔案拖慢。
 */
function looksBinary(bytes: Uint8Array): boolean {
  const sampleSize = Math.min(bytes.length, 8000);
  for (let i = 0; i < sampleSize; i++) {
    if (bytes[i] === 0) return true;
  }
  return false;
}

/**
 * 貼上/選取的 File 讀成附件。三種結果:
 *   1. 圖片(mediaType 在既有四種點陣圖清單內)→ image 附件,讀 data URL。
 *   2. `application/pdf` → document 附件(PDF),讀 data URL(Anthropic
 *      `Base64PDFSource` 就是要 base64)。
 *   3. 其他一律嘗試當純文字讀:用 NUL byte 判斷是不是二進位(見
 *      `looksBinary()`),看起來是二進位或讀出空檔案就回傳 null 靜默略過——
 *      v1 不做額外的錯誤提示 UI,不支援的檔案就是不出現在待送清單裡。純
 *      文字內容一律轉 base64 存放,與 prompt.ts 的
 *      `PromptDocumentAttachmentSchema` 約定一致。
 */
async function readComposerAttachment(file: File): Promise<ComposerAttachment | null> {
  if (isSupportedImageMediaType(file.type)) {
    const mediaType = file.type;
    const data = await readFileAsDataUrlBase64(file);
    return data === null ? null : { id: crypto.randomUUID(), type: "image", mediaType, data };
  }
  if (file.type === "application/pdf") {
    const data = await readFileAsDataUrlBase64(file);
    return data === null ? null : { id: crypto.randomUUID(), type: "document", mediaType: "application/pdf", name: file.name, data };
  }
  const bytes = await readFileAsBytes(file);
  if (bytes === null || bytes.length === 0 || looksBinary(bytes)) return null;
  return { id: crypto.randomUUID(), type: "document", mediaType: "text/plain", name: file.name, data: bytesToBase64(bytes) };
}

export function ChatView({ onOpenSidebar }: { onOpenSidebar: () => void }): JSX.Element {
  const { t } = useTranslation(["chat"]);
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const sessions = useSessionStore((s) => s.sessions);
  const profiles = useSessionStore((s) => s.profiles);
  const itemsBySession = useSessionStore((s) => s.itemsBySession);
  const sendPrompt = useSessionStore((s) => s.sendPrompt);
  const interrupt = useSessionStore((s) => s.interrupt);

  const [draft, setDraft] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState<ComposerAttachment[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const session = sessions.find((s) => s.id === currentSessionId);
  const items = useMemo(
    () => (currentSessionId ? (itemsBySession[currentSessionId] ?? []) : []),
    [currentSessionId, itemsBySession],
  );

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [items]);

  // 新建立或切換 session 時(例如剛建立第一個 profile 後接著建新對話),把
  // 焦點自動移到輸入框——否則焦點停在觸發按鈕/body 上,使用者直接打字會
  // 完全沒反應,得先手動點一下輸入框。
  //
  // 光是 DOM 的 `element.focus()` 不夠:使用者回報「還是要切換視窗才能打
  // 字」——那是因為 `element.focus()` 只能移動這個 BrowserWindow **內部**
  // 的 DOM focus,不保證這個視窗當下真的握有 OS 層級的輸入焦點(見
  // electron/main.ts 的 `deskmony:focusWindow` handler 註解)。純瀏覽器
  // client 沒有對應的 OS 視窗可以 focus,`window.deskmony?.focusWindow`
  // 在該情境下是 undefined,直接略過即可(視窗焦點本來就由瀏覽器分頁管理)。
  useEffect(() => {
    void window.deskmony?.focusWindow?.();
    textareaRef.current?.focus();
  }, [currentSessionId]);

  // Phase 6:切換 session 時清掉待送附件——附件是「這次要送給目前這個
  // session」的暫態,換一條對話後還留著上一條的預覽會讓人誤以為會一併送給
  // 新 session(同一批次的 draft 文字則沿用既有行為,不受這個效果影響)。
  useEffect(() => {
    setPendingAttachments([]);
  }, [currentSessionId]);

  const addComposerAttachments = (files: File[]): void => {
    if (files.length === 0) return;
    void Promise.all(files.map(readComposerAttachment)).then((results) => {
      const valid = results.filter((r): r is ComposerAttachment => r !== null);
      if (valid.length === 0) return;
      setPendingAttachments((prev) => [...prev, ...valid]);
    });
  };

  const removeAttachment = (id: string): void => {
    setPendingAttachments((prev) => prev.filter((a) => a.id !== id));
  };

  const handleFileInputChange = (e: ChangeEvent<HTMLInputElement>): void => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ""; // 允許重新選同一個檔案時仍會觸發 onChange
    addComposerAttachments(files);
  };

  const handleSend = (): void => {
    const text = draft.trim();
    if (!text || !currentSessionId) return;
    const attachments = pendingAttachments.map(({ id, ...rest }) => rest);
    setDraft("");
    setPendingAttachments([]);
    void sendPrompt(text, attachments.length > 0 ? attachments : undefined);
  };

  if (!currentSessionId || !session) {
    return (
      <main className="flex h-full flex-1 flex-col bg-canvas">
        <MobileHeaderBar onOpenSidebar={onOpenSidebar} />
        <div className="flex flex-1 items-center justify-center text-fg-subtle">
          <p className="text-sm">{t("chat:empty.selectOrCreateSession")}</p>
        </div>
      </main>
    );
  }

  const busy = session.status === "busy" || session.status === "waiting";
  const profile = profiles.find((p) => p.id === session.agentProfileId);
  /**
   * async-scribbling-llama.md Phase 6:目前只有 claude-agent-sdk 的
   * sendPrompt() 有明確路徑把圖片/文件內容送給模型(見 claude-sdk-adapter.ts)。
   * ACP 的協議層級雖然查證過確實支援圖片 content block(`ActiveSession.
   * prompt()` 接受 `ContentBlock`,含 `ImageContent`——見
   * `@agentclientprotocol/sdk` 的型別定義),但目前的 AcpAdapter.sendPrompt()
   * 尚未接上、不在這次範圍內;OpenCode 是外部 CLI(沒有可查證的本機型別
   * 定義,只能實測 HTTP API 行為),支援與否未經證實;PTY 是純終端直通,
   * 結構上不可能。這是編譯期就能確定的靜態事實(哪個 adapter 的程式碼有實作
   * 送圖片/文件邏輯),不是「連上線才知道被 spawn 的是哪個 agent」那種執行期
   * 行為——三態能力機制(AdapterCapabilities 的 usageReporting/
   * contextReporting)是為後者設計的,這裡不適用。比照 EffortControl 既有的
   * `session.adapterType !== "claude-agent-sdk"` 內聯判斷慣例,不新增能力
   * 旗標。
   */
  const canAttachFiles = session.adapterType === "claude-agent-sdk";

  const handlePaste = (e: ClipboardEvent<HTMLTextAreaElement>): void => {
    if (!canAttachFiles) return;
    const files = Array.from(e.clipboardData.items)
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (files.length === 0) return;
    e.preventDefault();
    addComposerAttachments(files);
  };

  return (
    <main className="flex h-full flex-1 flex-col bg-canvas">
      <header className="flex flex-shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line-subtle px-3 py-2 sm:px-4">
        <IconButton icon="menu" aria-label={t("chat:sidebar.openAriaLabel")} onClick={onOpenSidebar} className="sm:hidden" />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold text-fg">{session.title}</h1>
          <p className="truncate text-2xs text-fg-faint" title={session.workingDir}>
            {shortenPath(session.workingDir)}
          </p>
        </div>
        <div className="flex flex-shrink-0 flex-wrap items-center gap-1.5">
          <UsageBadge session={session} />
          <CostBudgetBadge session={session} />
          <AutoModeControl session={session} />
          <ModelControl session={session} profile={profile} />
          <EffortControl session={session} profile={profile} />
          {busy && (
            <IconButton
              icon="pause"
              aria-label={t("chat:session.interrupt")}
              title={t("chat:session.interrupt")}
              variant="outline"
              onClick={interrupt}
              className="hover:!border-danger hover:!text-danger"
            />
          )}
        </div>
      </header>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-3 sm:px-4">
        {items.length === 0 && <p className="mt-6 text-center text-xs text-fg-faint">{t("chat:empty.startTyping")}</p>}
        {items.map((item) => (
          <ChatBubble key={item.id} item={item} />
        ))}
      </div>

      <div className="flex-shrink-0 border-t border-line-subtle p-2.5 sm:p-3">
        {pendingAttachments.length > 0 && (
          <div className="mb-1.5 flex flex-wrap gap-1.5">
            {pendingAttachments.map((att) => (
              <div key={att.id} className="group relative">
                {att.type === "image" ? (
                  <img
                    src={`data:${att.mediaType};base64,${att.data}`}
                    alt={t("chat:composer.attachmentAltText")}
                    className="h-12 w-12 rounded-md border border-line object-cover"
                  />
                ) : (
                  <AttachmentFileChip
                    name={att.name}
                    className="h-12 max-w-[9rem] rounded-md border border-line bg-canvas px-2 text-2xs text-fg-muted"
                  />
                )}
                <button
                  type="button"
                  onClick={() => removeAttachment(att.id)}
                  aria-label={t("chat:composer.removeAttachmentAriaLabel")}
                  className="focus-ring absolute -right-1.5 -top-1.5 flex h-4 w-4 items-center justify-center rounded-full border border-line bg-surface text-fg-muted shadow-panel transition hover:text-danger"
                >
                  <Icon name="x" size={10} />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2 rounded-lg border border-line bg-surface p-1.5 focus-within:border-accent/60 focus-within:ring-2 focus-within:ring-accent/20">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            onChange={handleFileInputChange}
            className="hidden"
          />
          <IconButton
            icon="file"
            aria-label={t("chat:composer.attachAriaLabel")}
            title={canAttachFiles ? t("chat:composer.attachAriaLabel") : t("chat:composer.attachUnsupportedTitle")}
            disabled={!canAttachFiles}
            onClick={() => fileInputRef.current?.click()}
          />
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            onPaste={handlePaste}
            rows={2}
            placeholder={t("chat:composer.placeholder")}
            className="flex-1 resize-none bg-transparent px-2 py-1 text-sm text-fg outline-none placeholder:text-fg-faint"
          />
          <IconButton
            icon="play"
            aria-label={t("chat:composer.sendAriaLabel")}
            variant="primary"
            size="md"
            disabled={!draft.trim()}
            onClick={handleSend}
          />
        </div>
      </div>
    </main>
  );
}

/** 手機版頂列的側欄開關——空狀態(尚無選取 session)也要能開側欄選一個。 */
function MobileHeaderBar({ onOpenSidebar }: { onOpenSidebar: () => void }): JSX.Element {
  const { t } = useTranslation(["chat"]);
  return (
    <div className="flex flex-shrink-0 items-center border-b border-line-subtle px-2 py-1.5 sm:hidden">
      <IconButton icon="menu" aria-label={t("chat:sidebar.openAriaLabel")} onClick={onOpenSidebar} />
    </div>
  );
}
