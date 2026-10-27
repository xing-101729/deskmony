import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { providerEffortChoices, providerEffortSelectionState } from "@deskmony/shared";
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
 * + **思考程度**(2026-10-06 起不只 Claude:清單由 `providerEffortChoices()` 決定——Claude 的固定 5 級、OpenCode
 * 選定 model 的 variants;建立前不知道就隱藏;2026-10-16 起 OpenCode 沒選 model / 選的 model 沒有 variants 時改顯示 disabled 的
 * 下拉說明原因,不再整個消失)+(選填)**工作資料夾**。「要等 session 開起來才知道選項」的 agent
 * (ACP:Codex / Gemini / OpenCode ACP)改顯示一行說明:建立後在對話標題列選,會記住上次的選擇。取代原本的「選 profile」下拉與
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
    <Select
      aria-label={t("agentPicker:modelAriaLabel")}
      value={effective.model}
      onChange={(e) => {
        // 可選的思考程度可能隨 model 變(OpenCode 的 variants)——新 model 沒有目前選的那個就清掉。
        const model = e.target.value;
        const efforts = provider ? providerEffortChoices(provider, model || undefined) : undefined;
        set({ model, effort: effective.effort && efforts?.includes(effective.effort) ? effective.effort : "" });
      }}
    >
      <option value="">{t("agentPicker:defaultModelOption")}</option>
      {provider!.models.map((m) => (
        <option key={m.id} value={m.id}>
          {m.label}
        </option>
      ))}
    </Select>
  ) : null;

  // 2026-10-16:沒有選項時不再整個消失——OpenCode 預設 model(`opencode/big-pickle`)沒有 variants,使用者看不到思考程度
  // 就不知道換成別的 model 才能選。provider 能選、只是現在選不了(還沒選 model / 選的 model 沒有)→ 顯示 disabled 的下拉,
  // 選項文字就是原因(緊湊排版沒有欄位標籤,說明必須在控制項本身)。判斷見 `providerEffortSelectionState()`。
  const effortState = provider ? providerEffortSelectionState(provider, effective.model || undefined) : undefined;
  let effortSelect: JSX.Element | null = null;
  if (effortState?.kind === "choices") {
    effortSelect = (
      <Select aria-label={t("agentPicker:effortAriaLabel")} value={effective.effort} onChange={(e) => set({ effort: e.target.value })}>
        <option value="">{t("agentPicker:defaultEffortOption")}</option>
        {effortState.choices.map((value) => (
          <option key={value} value={value}>
            {value}
          </option>
        ))}
      </Select>
    );
  } else if (effortState?.kind === "pickModelFirst" || effortState?.kind === "modelHasNone") {
    const reason = t(effortState.kind === "pickModelFirst" ? "agentPicker:effortPickModelFirst" : "agentPicker:effortModelUnsupported");
    effortSelect = (
      <Select aria-label={t("agentPicker:effortAriaLabel")} value="" disabled title={reason}>
        <option value="">{reason}</option>
      </Select>
    );
  }

  // 建立前不知道選項的 agent:說明建立後在哪裡選。
  const optionsLaterNote = provider?.optionsAfterStart ? (
    <p className="text-2xs text-fg-faint">{t("agentPicker:optionsAfterStartHint")}</p>
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
        {optionsLaterNote}
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
      {optionsLaterNote}
      {workingDirInput && <Field label={t("agentPicker:workingDirLabel")}>{workingDirInput}</Field>}
    </div>
  );
}
