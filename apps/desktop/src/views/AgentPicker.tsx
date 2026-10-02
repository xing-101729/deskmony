import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { EffortLevel } from "@deskmony/shared";
import { useSessionStore, selectAvailableProviders } from "../stores/session-store.js";
import { reconcileSelection, type NewSessionSelection } from "../lib/new-session-selection.js";
import { Button } from "../ui/Button.js";
import { Field, Input, Select } from "../ui/Field.js";
import { EmptyState } from "../ui/Feedback.js";

/**
 * AgentPicker.tsx(2026-10-02,P2「移除 profile」新增,見
 * docs/LAYER-4-detail-design/simplify-agents-sessions_detail.md §P2.6)。
 *
 * 「用哪個 agent 開新對話」的選單組:**agent 下拉**(從這台電腦偵測到、且沒被停用的 provider,顯示 label + 版本)
 * + **model 下拉**(該 provider 的 models;`supportsModelSelection` 為 false 或清單為空時整個隱藏)
 * + **effort**(只有 claude-agent-sdk 顯示)+(選填)**工作資料夾**。取代原本的「選 profile」下拉與
 * ProfileCreateDialog——SessionList 側欄頂部與「在這個 session 底下開新 session」對話框共用同一份,選擇狀態由呼叫端持有(見
 * lib/new-session-selection.ts,上次的選擇存 localStorage)。
 *
 * 沒有任何可用 agent 時(例如 claude-agent-sdk 被停用、其餘 CLI 都沒裝)顯示說明 + 「重新偵測」鈕
 * (呼叫 `env.detectAgents`)。
 */

interface AgentPickerProps {
  selection: NewSessionSelection;
  onChange: (next: NewSessionSelection) => void;
  /** true = 側欄用的緊湊排版(沒有欄位標籤,只有 aria-label);false = 對話框排版。 */
  compact?: boolean;
  /** 是否顯示「工作資料夾」欄位(側欄「新對話」要,「在這個 session 底下開新 session」不用——新 session 預設沿用該 session 的目錄)。 */
  showWorkingDir?: boolean;
  /** 工作資料夾留空時實際會用的預設值(只用來當 placeholder 顯示)。 */
  defaultWorkingDir?: string;
}

export function AgentPicker({
  selection,
  onChange,
  compact = false,
  showWorkingDir = false,
  defaultWorkingDir,
}: AgentPickerProps): JSX.Element {
  const { t } = useTranslation(["agentPicker", "common"]);
  const detectedAgents = useSessionStore((s) => s.detectedAgents);
  const detectingAgents = useSessionStore((s) => s.detectingAgents);
  const detectAgents = useSessionStore((s) => s.detectAgents);
  const providerPrefs = useSessionStore((s) => s.providerPrefs);

  useEffect(() => {
    // 第一次沒有任何偵測結果時主動偵測一次(connect() 也會背景偵測一次,這裡只是保險)。
    if (detectedAgents.length === 0 && !detectingAgents) void detectAgents();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const available = useMemo(() => selectAvailableProviders(detectedAgents, providerPrefs), [detectedAgents, providerPrefs]);
  // 呼叫端持有的選擇可能是過時的(provider 被停用/移除),顯示時一律對齊到現在真的可用的清單。
  const effective = useMemo(() => reconcileSelection(selection, available), [selection, available]);
  const provider = available.find((p) => p.id === effective.providerId);

  const canPickDirectory = typeof window !== "undefined" && Boolean(window.deskmony?.pickDirectory);

  if (available.length === 0) {
    return (
      <div className="rounded-md border border-line-subtle bg-surface p-2">
        <EmptyState
          icon="alert"
          title={t("agentPicker:noAgent.title")}
          description={t("agentPicker:noAgent.description")}
          compact
          action={
            <Button size="xs" variant="outline" loading={detectingAgents} onClick={() => void detectAgents()}>
              {detectingAgents ? t("common:detecting") : t("agentPicker:redetect")}
            </Button>
          }
        />
      </div>
    );
  }

  const set = (patch: Partial<NewSessionSelection>): void => onChange({ ...effective, ...patch });

  const agentSelect = (
    <Select
      aria-label={t("agentPicker:agentAriaLabel")}
      value={effective.providerId}
      onChange={(e) => {
        // 換 agent 時 model/effort 一律重置——舊的選擇是針對舊 agent 挑的。
        onChange({ ...effective, providerId: e.target.value, model: "", effort: "" });
      }}
    >
      {available.map((p) => (
        <option key={p.id} value={p.id}>
          {p.label}
          {p.detectedVersion ? ` (v${p.detectedVersion})` : ""}
        </option>
      ))}
    </Select>
  );

  const showModel = Boolean(provider?.supportsModelSelection) && (provider?.models.length ?? 0) > 0;
  const modelSelect = showModel ? (
    <Select aria-label={t("agentPicker:modelAriaLabel")} value={effective.model} onChange={(e) => set({ model: e.target.value })}>
      <option value="">{t("agentPicker:defaultModelOption")}</option>
      {provider!.models.map((m) => (
        <option key={m.id} value={m.id}>
          {m.label}
        </option>
      ))}
    </Select>
  ) : null;

  const showEffort = provider?.software === "claude-agent-sdk";
  const effortSelect = showEffort ? (
    <Select
      aria-label={t("agentPicker:effortAriaLabel")}
      value={effective.effort}
      onChange={(e) => set({ effort: e.target.value as EffortLevel | "" })}
    >
      <option value="">{t("agentPicker:defaultEffortOption")}</option>
      <option value="low">low</option>
      <option value="medium">medium</option>
      <option value="high">high</option>
      <option value="xhigh">xhigh</option>
      <option value="max">max</option>
    </Select>
  ) : null;

  const handlePickDirectory = async (): Promise<void> => {
    const picked = await window.deskmony?.pickDirectory?.();
    if (picked) set({ workingDir: picked });
  };

  const workingDirInput = showWorkingDir ? (
    <div className="flex gap-1.5">
      <Input
        mono
        aria-label={t("agentPicker:workingDirLabel")}
        title={t("agentPicker:workingDirLabel")}
        value={effective.workingDir}
        onChange={(e) => set({ workingDir: e.target.value })}
        placeholder={defaultWorkingDir ? t("agentPicker:workingDirPlaceholder", { dir: defaultWorkingDir }) : t("agentPicker:workingDirPlaceholderNoDefault")}
        className="flex-1"
      />
      {canPickDirectory && (
        <Button variant="outline" size="sm" onClick={() => void handlePickDirectory()}>
          {t("agentPicker:browseButton")}
        </Button>
      )}
    </div>
  ) : null;

  const redetectLink = (
    <button
      type="button"
      onClick={() => void detectAgents()}
      disabled={detectingAgents}
      className="text-2xs text-fg-faint underline decoration-dotted hover:text-accent disabled:opacity-40"
    >
      {detectingAgents ? t("common:detecting") : t("agentPicker:redetect")}
    </button>
  );

  if (compact) {
    return (
      <div className="space-y-1.5">
        {agentSelect}
        {modelSelect}
        {effortSelect}
        {workingDirInput}
        <div className="flex justify-end">{redetectLink}</div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <Field label={t("agentPicker:agentLabel")} action={redetectLink}>
        {agentSelect}
      </Field>
      {modelSelect && <Field label={t("agentPicker:modelLabel")}>{modelSelect}</Field>}
      {effortSelect && <Field label={t("agentPicker:effortLabel")}>{effortSelect}</Field>}
      {workingDirInput && <Field label={t("agentPicker:workingDirLabel")}>{workingDirInput}</Field>}
    </div>
  );
}
