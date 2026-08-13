import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentProfile, EffortLevel, Session } from "@deskmony/shared";
import { useSessionStore, selectProviderModels, selectUsageReporting, type ChatItem } from "../stores/session-store.js";
import { AutoModeControl } from "./AutoModeControl.js";
import { IconButton } from "../ui/Button.js";
import { Select } from "../ui/Field.js";
import { Badge, Meta } from "../ui/Badge.js";
import { Icon } from "../ui/icons.js";
import { Meter } from "../ui/Feedback.js";
import { shortenPath } from "../lib/workspaces.js";

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
    return <Badge tone="neutral" mono title="model 由 agent/CLI 自行管理">{currentModel || "由 agent 管理"}</Badge>;
  }

  const knownIds = new Set(availableModels.map((m) => m.id));
  const options =
    currentModel && !knownIds.has(currentModel)
      ? [{ id: currentModel, label: currentModel }, ...availableModels]
      : availableModels;

  return (
    <div className="flex items-center gap-1.5">
      <Select
        aria-label="切換 model"
        value={currentModel}
        onChange={(e) => void handleChange(e.target.value)}
        disabled={switching}
        className="!h-6 !text-2xs"
      >
        {!currentModel && <option value="">(未指定,使用 CLI 預設)</option>}
        {options.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
      </Select>
      {error && (
        <span className="text-2xs text-danger" title={error}>
          切換失敗
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
        aria-label="切換思考程度"
        value={currentEffort}
        onChange={(e) => void handleChange(e.target.value as EffortLevel | "")}
        disabled={switching}
        className="!h-6 !text-2xs"
      >
        {!currentEffort && <option value="">(未指定,使用 CLI 預設)</option>}
        <option value="low">low</option>
        <option value="medium">medium</option>
        <option value="high">high</option>
        <option value="xhigh">xhigh</option>
        <option value="max">max</option>
      </Select>
      {error && (
        <span className="text-2xs text-danger" title={error}>
          切換失敗
        </span>
      )}
    </div>
  );
}

function ToolCallBubble({ item }: { item: Extract<ChatItem, { kind: "tool" }> }): JSX.Element {
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
          {item.status === "running" ? "執行中" : item.isError ? "失敗" : "完成"}
        </Badge>
      </summary>
      <div className="space-y-2 border-t border-line-subtle px-2.5 py-2">
        {item.input !== undefined && (
          <div>
            <div className="mb-1 text-2xs font-medium uppercase tracking-wide text-fg-faint">輸入</div>
            <pre className="whitespace-pre-wrap break-all rounded bg-canvas px-2 py-1.5 font-mono text-2xs text-fg-muted">
              {JSON.stringify(item.input, null, 2)}
            </pre>
          </div>
        )}
        {item.output !== undefined && (
          <div>
            <div className="mb-1 text-2xs font-medium uppercase tracking-wide text-fg-faint">輸出</div>
            <pre className="whitespace-pre-wrap break-all rounded bg-canvas px-2 py-1.5 font-mono text-2xs text-fg-muted">
              {typeof item.output === "string" ? item.output : JSON.stringify(item.output, null, 2)}
            </pre>
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
  const usage = useSessionStore((s) => s.sessionUsage[session.id]);
  const capabilities = useSessionStore((s) => s.capabilitiesBySoftware[session.adapterType]);
  const support = selectUsageReporting(capabilities, usage);
  if (support !== "supported") {
    return (
      <Badge
        tone="warn"
        icon="alert"
        title="此後端無法量測花費(或尚未確認會不會回報)——任務/每日成本預算對這個 session 不會生效,只有回合時間/工具呼叫次數上限仍在保護。"
      >
        {support === "unknown" ? "花費未知" : "無法量測花費"}
      </Badge>
    );
  }
  const hasValue = usage?.costAmount !== undefined;
  return (
    <Badge
      tone={hasValue ? "neutral" : "neutral"}
      mono
      title={hasValue ? "累計花費(此後端有回報 cost,S3a usage-metering)" : "此後端會回報累計花費,但這個 session 尚未收到第一筆(回合結束時才發)"}
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
      parts.push({ label: `任務「${summary.task.title}」預算已達上限,新 prompt 已擋下`, tripped: true });
    } else {
      const percent = budgetPercentForDisplay(summary.task.rollup, {
        maxCostUsd: budget.task.maxCostUsd.value,
        maxTokens: budget.task.maxTokens.value,
      });
      if (percent !== undefined) {
        parts.push({ label: `任務預算 ${Math.min(100, Math.round(percent))}%`, tripped: false, percent });
      }
    }
  }
  if (summary.dailyTripped) {
    parts.push({ label: "今日成本 kill-switch 已觸發,所有 session 已暫停", tripped: true });
  }

  if (parts.length === 0) return null;

  return (
    <div className="flex items-center gap-1.5">
      {parts.map((part) => (
        <div key={part.label} className="flex items-center gap-1.5">
          {part.percent !== undefined && <Meter percent={part.percent} className="w-10" />}
          <Badge
            tone={part.tripped ? "danger" : "neutral"}
            title={part.tripped ? "此 session/任務已被成本斷路器擋下(worktree/任務保留,可調整預算並重啟 core 續行)" : "任務層級累計花費/token 佔預算比例"}
          >
            {part.label}
          </Badge>
        </div>
      ))}
    </div>
  );
}

function ChatBubble({ item }: { item: ChatItem }): JSX.Element | null {
  if (item.kind === "tool") return <ToolCallBubble item={item} />;

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
        className={`max-w-[75%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm leading-relaxed ${
          isUser ? "bg-accent text-accent-fg" : "bg-surface text-fg"
        }`}
      >
        {item.content}
        {item.kind === "assistant" && item.streaming && (
          <span className="ml-1 inline-block h-3 w-1.5 animate-pulse bg-fg-muted align-middle" />
        )}
      </div>
    </div>
  );
}

export function ChatView({ onOpenSidebar }: { onOpenSidebar: () => void }): JSX.Element {
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const sessions = useSessionStore((s) => s.sessions);
  const profiles = useSessionStore((s) => s.profiles);
  const itemsBySession = useSessionStore((s) => s.itemsBySession);
  const sendPrompt = useSessionStore((s) => s.sendPrompt);
  const interrupt = useSessionStore((s) => s.interrupt);

  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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

  const handleSend = (): void => {
    const text = draft.trim();
    if (!text || !currentSessionId) return;
    setDraft("");
    void sendPrompt(text);
  };

  if (!currentSessionId || !session) {
    return (
      <main className="flex h-full flex-1 flex-col bg-canvas">
        <MobileHeaderBar onOpenSidebar={onOpenSidebar} />
        <div className="flex flex-1 items-center justify-center text-fg-subtle">
          <p className="text-sm">從左側選擇或建立一個對話開始</p>
        </div>
      </main>
    );
  }

  const busy = session.status === "busy" || session.status === "waiting";
  const profile = profiles.find((p) => p.id === session.agentProfileId);

  return (
    <main className="flex h-full flex-1 flex-col bg-canvas">
      <header className="flex flex-shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line-subtle px-3 py-2 sm:px-4">
        <IconButton icon="menu" aria-label="開啟側欄" onClick={onOpenSidebar} className="sm:hidden" />
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
            <IconButton icon="pause" aria-label="中斷" title="中斷" variant="outline" onClick={interrupt} className="hover:!border-danger hover:!text-danger" />
          )}
        </div>
      </header>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-3 sm:px-4">
        {items.length === 0 && <p className="mt-6 text-center text-xs text-fg-faint">開始輸入訊息與 agent 對話</p>}
        {items.map((item) => (
          <ChatBubble key={item.id} item={item} />
        ))}
      </div>

      <div className="flex-shrink-0 border-t border-line-subtle p-2.5 sm:p-3">
        <div className="flex items-end gap-2 rounded-lg border border-line bg-surface p-1.5 focus-within:border-accent/60 focus-within:ring-2 focus-within:ring-accent/20">
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
            rows={2}
            placeholder="輸入訊息給 agent…(Enter 送出,Shift+Enter 換行)"
            className="flex-1 resize-none bg-transparent px-2 py-1 text-sm text-fg outline-none placeholder:text-fg-faint"
          />
          <IconButton
            icon="play"
            aria-label="送出"
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
  return (
    <div className="flex flex-shrink-0 items-center border-b border-line-subtle px-2 py-1.5 sm:hidden">
      <IconButton icon="menu" aria-label="開啟側欄" onClick={onOpenSidebar} />
    </div>
  );
}
