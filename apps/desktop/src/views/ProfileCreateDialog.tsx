import { useEffect, useMemo, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { type AgentSoftware, type EffortLevel } from "@deskmony/shared";
import { useSessionStore, selectResolvedProviders } from "../stores/session-store.js";
import { Dialog } from "../ui/Dialog.js";
import { Button, IconButton } from "../ui/Button.js";
import { Field, Input, Select, Textarea } from "../ui/Field.js";
import { Alert } from "../ui/Feedback.js";
import { translateError } from "../lib/error-i18n.js";
// S5(dispose-gate-and-lead)L4 §2.2:Lead 的 systemPrompt 範本是一份可編輯的
// 檔案(docs/lead-prompt-template.md),不寫死在程式碼——這裡用 Vite 的 `?raw`
// 匯入直接取得該檔案的原始文字,單一份內容,改文件就改了預填內容。
import leadPromptTemplateRaw from "../../../../docs/lead-prompt-template.md?raw";

/** role 欄位含這個關鍵字(不分大小寫)時視為 Lead——只用來決定「要不要預填
 *  範本」,刻意比 `deriveLifecycleFromRole()` 窄。 */
const LEAD_ROLE_KEYWORD = "lead";

/** 從 lead-prompt-template.md 抓出第一個 code fence 區塊的內容。 */
function extractLeadPromptTemplateBody(markdown: string): string {
  const match = markdown.match(/```\n([\s\S]*?)```/);
  return match ? match[1].trim() : markdown.trim();
}

const LEAD_PROMPT_TEMPLATE_BODY = extractLeadPromptTemplateBody(leadPromptTemplateRaw);

/** 逃生選項的 key,不對應任何 provider 目錄項目。 */
const CUSTOM_KEY = "__custom__";

function parseArgs(raw: string): string[] | undefined {
  const parts = raw.trim().split(/\s+/).filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}

interface EnvRow {
  key: string;
  value: string;
}

interface ProfileCreateDialogProps {
  onClose: () => void;
  onCreated: (profileId: string) => void;
  defaultWorkingDir: string;
}

/**
 * 「建立 Profile」對話框——software 下拉的資料來源是 `selectResolvedProviders()`
 * (合併內建 provider 目錄 + 本機偵測結果 + 使用者偏好的純函式)。這輪只換了
 * 外殼(`Dialog` + `Field`/`Input`/`Select`/`Textarea`),欄位邏輯與資料流完全
 * 不變。
 */
export function ProfileCreateDialog({ onClose, onCreated, defaultWorkingDir }: ProfileCreateDialogProps): JSX.Element {
  const { t } = useTranslation(["profileCreate", "common"]);
  const createProfile = useSessionStore((s) => s.createProfile);
  const detectedAgents = useSessionStore((s) => s.detectedAgents);
  const detectingAgents = useSessionStore((s) => s.detectingAgents);
  const detectAgents = useSessionStore((s) => s.detectAgents);
  const providerPrefs = useSessionStore((s) => s.providerPrefs);

  useEffect(() => {
    if (detectedAgents.length === 0 && !detectingAgents) {
      void detectAgents();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const resolvedProviders = useMemo(
    () => selectResolvedProviders(detectedAgents, providerPrefs).filter((p) => p.enabled && p.id !== "custom-pty"),
    [detectedAgents, providerPrefs],
  );

  const [name, setName] = useState("");
  const [selectionKey, setSelectionKey] = useState<string>("claude-agent-sdk");
  const [workingDir, setWorkingDir] = useState(defaultWorkingDir);
  const [args, setArgs] = useState("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState<EffortLevel | "">("");
  /** 只在 isSdkTarget 時有意義:每個 profile 各自選要用 `claude login` 的本機
   *  登入憑證,還是這裡直接填一把 API key(存成這個 profile 的
   *  `env.ANTHROPIC_API_KEY`)——見 handleSubmit() 怎麼把 apiKey 併進
   *  buildEnv()。預設 "login" 是因為它不需要使用者額外提供任何東西就能動
   *  (前提是本機已經 `claude login` 過),API key 是進階/多帳號情境才需要
   *  的選項。 */
  const [authMode, setAuthMode] = useState<"login" | "apikey">("login");
  const [apiKey, setApiKey] = useState("");
  const [envRows, setEnvRows] = useState<EnvRow[]>([]);
  const [role, setRole] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [customSoftware, setCustomSoftware] = useState<AgentSoftware>("pty");
  const [customCommand, setCustomCommand] = useState("");
  const [customArgs, setCustomArgs] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canPickDirectory = typeof window !== "undefined" && Boolean(window.deskmony?.pickDirectory);

  const selectedProvider = resolvedProviders.find((p) => p.id === selectionKey);
  const isSdkTarget = selectedProvider?.software === "claude-agent-sdk";
  const isOpencodeTarget = selectedProvider?.software === "opencode";
  const showArgsInput = Boolean(selectedProvider) && !isSdkTarget && !isOpencodeTarget;

  useEffect(() => {
    setArgs("");
    setModel(selectedProvider?.defaultModelId ?? "");
    setEffort("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionKey]);

  const isLeadRole = role.trim().toLowerCase().includes(LEAD_ROLE_KEYWORD);
  useEffect(() => {
    if (isLeadRole && (systemPrompt.trim() === "" || systemPrompt === LEAD_PROMPT_TEMPLATE_BODY)) {
      setSystemPrompt(LEAD_PROMPT_TEMPLATE_BODY);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLeadRole]);

  const handlePickDirectory = async (): Promise<void> => {
    const picked = await window.deskmony?.pickDirectory?.();
    if (picked) setWorkingDir(picked);
  };

  const addEnvRow = (): void => setEnvRows((rows) => [...rows, { key: "", value: "" }]);
  const updateEnvRow = (idx: number, patch: Partial<EnvRow>): void =>
    setEnvRows((rows) => rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  const removeEnvRow = (idx: number): void => setEnvRows((rows) => rows.filter((_, i) => i !== idx));

  function buildEnv(): Record<string, string> | undefined {
    const entries = envRows.map((r) => [r.key.trim(), r.value] as const).filter(([key]) => key.length > 0);
    const env = Object.fromEntries(entries);
    // isSdkTarget 且選了「API Key」認證方式時,把這裡填的金鑰併進
    // env.ANTHROPIC_API_KEY——放在下面的 envRows 之後 assign,讓這個欄位優先
    // (使用者不需要在下方環境變數區再手動加一次同名的列)。
    if (isSdkTarget && authMode === "apikey" && apiKey.trim()) {
      env.ANTHROPIC_API_KEY = apiKey.trim();
    }
    return Object.keys(env).length > 0 ? env : undefined;
  }

  function resolveTarget():
    | { software: AgentSoftware; command?: string; args?: string[]; providerId?: string }
    | { error: string } {
    if (selectionKey === CUSTOM_KEY) {
      if (!customCommand.trim()) {
        return { error: t("profileCreate:errors.customCommandRequired", { software: customSoftware }) };
      }
      return { software: customSoftware, command: customCommand.trim(), args: parseArgs(customArgs) };
    }
    if (!selectedProvider) {
      return { error: t("profileCreate:errors.selectSoftware") };
    }
    if (selectedProvider.software !== "claude-agent-sdk" && !selectedProvider.command) {
      return { error: t("profileCreate:errors.cliPathNotFound") };
    }
    // claude-cli(pty 直通)「支援 model 選擇」的實際做法:pty 建立後不能像
    // SDK 一樣中途切換 model(見 packages/adapters/src/pty-adapter.ts 的
    // setModel() 一律 throw),只能在建立當下把 `--model <別名>` 烤進固定的
    // 啟動參數——見 provider-catalog.ts 的 claude-cli entry 註解。只對這個
    // provider 特別處理,不是通用邏輯:其他 pty provider(codex/aider/自訂)
    // 沒有 supportsModelSelection,不會有 model 值可烤。
    const modelArgs = selectedProvider.id === "claude-cli" && model ? ["--model", model] : [];
    const combinedArgs = [...(selectedProvider.defaultArgs ?? []), ...modelArgs, ...(parseArgs(args) ?? [])];
    return {
      software: selectedProvider.software,
      command: selectedProvider.command,
      args: combinedArgs.length > 0 ? combinedArgs : undefined,
      providerId: selectedProvider.id,
    };
  }

  const handleSubmit = async (): Promise<void> => {
    setError(null);
    if (!name.trim()) {
      setError(t("profileCreate:errors.nameRequired"));
      return;
    }
    if (!workingDir.trim()) {
      setError(t("profileCreate:errors.workingDirRequired"));
      return;
    }
    const target = resolveTarget();
    if ("error" in target) {
      setError(target.error);
      return;
    }

    setSubmitting(true);
    try {
      const profile = await createProfile({
        name: name.trim(),
        software: target.software,
        workingDir: workingDir.trim(),
        ...(role.trim() ? { role: role.trim() } : {}),
        ...(systemPrompt.trim() ? { systemPrompt: systemPrompt.trim() } : {}),
        ...(target.providerId ? { providerId: target.providerId } : {}),
        ...(buildEnv() ? { env: buildEnv() } : {}),
        ...(selectedProvider?.supportsModelSelection && model ? { model } : {}),
        ...(isSdkTarget && effort ? { effort } : {}),
        ...(target.software === "acp" && target.command ? { acpConfig: { command: target.command, args: target.args } } : {}),
        ...(target.software === "pty" && target.command ? { ptyConfig: { command: target.command, args: target.args } } : {}),
        ...(target.software === "opencode" && target.command ? { opencodeConfig: { command: target.command } } : {}),
      });
      onCreated(profile.id);
      onClose();
    } catch (err) {
      setError(translateError(err, t));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      title={t("profileCreate:dialogTitle")}
      description={t("profileCreate:dialogDescription")}
      icon="sparkle"
      size="md"
      onClose={onClose}
      footer={
        <div className="flex w-full justify-end gap-2">
          <Button variant="secondary" disabled={submitting} onClick={onClose}>
            {t("common:cancel")}
          </Button>
          <Button variant="primary" loading={submitting} onClick={() => void handleSubmit()}>
            {submitting ? t("profileCreate:creating") : t("profileCreate:createButton")}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <Field label={t("profileCreate:nameLabel")}>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("profileCreate:namePlaceholder")} />
        </Field>

        <Field label={t("profileCreate:roleLabel")} hint={t("profileCreate:roleHint")}>
          <Input value={role} onChange={(e) => setRole(e.target.value)} placeholder={t("profileCreate:rolePlaceholder")} />
        </Field>

        <Field
          label={t("profileCreate:systemPromptLabel")}
          action={
            isLeadRole && (
              <button
                type="button"
                onClick={() => setSystemPrompt(LEAD_PROMPT_TEMPLATE_BODY)}
                className="text-2xs text-fg-faint underline decoration-dotted hover:text-accent"
              >
                {t("profileCreate:applyLeadTemplate")}
              </button>
            )
          }
          hint={t("profileCreate:systemPromptHint")}
        >
          <Textarea mono value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} rows={5} placeholder={t("profileCreate:systemPromptPlaceholder")} />
        </Field>

        <Field
          label={t("profileCreate:agentSoftwareLabel")}
          action={
            <button
              type="button"
              onClick={() => void detectAgents()}
              disabled={detectingAgents}
              className="text-2xs text-fg-faint underline decoration-dotted hover:text-accent disabled:opacity-40"
            >
              {detectingAgents ? t("common:detecting") : t("profileCreate:redetect")}
            </button>
          }
        >
          <Select value={selectionKey} onChange={(e) => setSelectionKey(e.target.value)}>
            {resolvedProviders.map((p) => (
              <option key={p.id} value={p.id} disabled={p.software !== "claude-agent-sdk" && !p.installed}>
                {p.label}
                {p.detectedVersion ? ` (v${p.detectedVersion})` : ""}
                {p.software !== "claude-agent-sdk" && !p.installed ? t("profileCreate:notDetectedSuffix") : ""}
              </option>
            ))}
            <option value={CUSTOM_KEY}>{t("profileCreate:customOption")}</option>
          </Select>

          {isSdkTarget && <p className="mt-1 text-2xs text-fg-faint">{t("profileCreate:sdkTargetHint")}</p>}

          {selectedProvider && !isSdkTarget && (
            <div className="mt-1.5 space-y-1">
              <p className="text-2xs text-fg-faint">
                <Trans
                  i18nKey="profileCreate:willCreateWith"
                  values={{ software: selectedProvider.software }}
                  components={{ mono: <span className="font-mono text-fg-muted" /> }}
                />
              </p>
              <p className="truncate rounded bg-canvas px-2 py-1 font-mono text-2xs text-fg-muted" title={selectedProvider.command}>
                {selectedProvider.command ?? t("profileCreate:commandNotDetected")}
              </p>
              {selectedProvider.defaultArgs && selectedProvider.defaultArgs.length > 0 && (
                <p className="text-2xs text-fg-faint">
                  {t("profileCreate:fixedArgsLabel")}<span className="font-mono text-fg-muted">{selectedProvider.defaultArgs.join(" ")}</span>
                </p>
              )}
              {isOpencodeTarget && (
                <p className="text-2xs text-fg-faint">{t("profileCreate:opencodeHint")}</p>
              )}
            </div>
          )}
        </Field>

        {isSdkTarget && (
          <Field
            label={t("profileCreate:authModeLabel")}
            hint={authMode === "login" ? t("profileCreate:authModeLoginHint") : t("profileCreate:authModeApiKeyHint")}
          >
            <Select value={authMode} onChange={(e) => setAuthMode(e.target.value as "login" | "apikey")}>
              <option value="login">{t("profileCreate:authModeLoginOption")}</option>
              <option value="apikey">API Key</option>
            </Select>
            {authMode === "apikey" && (
              <Input
                mono
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-ant-..."
                className="mt-1.5"
              />
            )}
          </Field>
        )}

        {selectedProvider?.supportsModelSelection && selectedProvider.models.length > 0 && (
          <Field label={t("profileCreate:modelLabel")} hint={t("profileCreate:modelHint")}>
            <Select value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="">{t("profileCreate:unspecifiedCliDefaultOption")}</option>
              {selectedProvider.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </Select>
          </Field>
        )}

        {isSdkTarget && (
          <Field
            label={t("profileCreate:effortLabel")}
            hint={t("profileCreate:effortHint")}
          >
            <Select value={effort} onChange={(e) => setEffort(e.target.value as EffortLevel | "")}>
              <option value="">{t("profileCreate:unspecifiedCliDefaultOption")}</option>
              <option value="low">low</option>
              <option value="medium">medium</option>
              <option value="high">high</option>
              <option value="xhigh">xhigh</option>
              <option value="max">max</option>
            </Select>
          </Field>
        )}

        {showArgsInput && (
          <Field label={t(selectedProvider?.defaultArgs?.length ? "profileCreate:argsLabelWithDefaults" : "profileCreate:argsLabel")}>
            <Input mono value={args} onChange={(e) => setArgs(e.target.value)} placeholder={t("profileCreate:argsPlaceholder")} />
          </Field>
        )}

        {selectionKey === CUSTOM_KEY && (
          <>
            <Field label={t("profileCreate:customSoftwareLabel")}>
              <Select value={customSoftware} onChange={(e) => setCustomSoftware(e.target.value as AgentSoftware)}>
                <option value="pty">{t("profileCreate:customSoftwarePtyOption")}</option>
                <option value="acp">ACP(Agent Client Protocol)</option>
              </Select>
            </Field>
            <Field label="command">
              <Input mono value={customCommand} onChange={(e) => setCustomCommand(e.target.value)} placeholder={t("profileCreate:customCommandPlaceholder")} />
            </Field>
            <Field label={t("profileCreate:argsLabel")}>
              <Input mono value={customArgs} onChange={(e) => setCustomArgs(e.target.value)} placeholder={t("profileCreate:argsPlaceholder")} />
            </Field>
          </>
        )}

        <Field
          label={t("profileCreate:envLabel")}
          action={
            <button type="button" onClick={addEnvRow} className="text-2xs text-fg-faint underline decoration-dotted hover:text-accent">
              {t("profileCreate:addEnvRowButton")}
            </button>
          }
        >
          <div className="space-y-1.5">
            {envRows.map((row, idx) => (
              <div key={idx} className="flex gap-1.5">
                <Input mono value={row.key} onChange={(e) => updateEnvRow(idx, { key: e.target.value })} placeholder={t("profileCreate:envKeyExamplePlaceholder")} className="w-2/5" />
                <Input mono type="password" value={row.value} onChange={(e) => updateEnvRow(idx, { value: e.target.value })} placeholder={t("profileCreate:envValuePlaceholder")} className="flex-1" />
                <IconButton icon="x" aria-label={t("profileCreate:removeEnvRowAriaLabel")} onClick={() => removeEnvRow(idx)} className="hover:!text-danger" />
              </div>
            ))}
            {envRows.length === 0 && <p className="text-2xs text-fg-faint">{t("profileCreate:noEnvRowsYet")}</p>}
          </div>
        </Field>

        <Field label={t("profileCreate:workingDirLabel")}>
          <div className="flex gap-1.5">
            <Input mono value={workingDir} onChange={(e) => setWorkingDir(e.target.value)} placeholder={t("profileCreate:workingDirPlaceholder")} className="flex-1" />
            {canPickDirectory && (
              <Button variant="outline" onClick={() => void handlePickDirectory()}>
                {t("profileCreate:browseButton")}
              </Button>
            )}
          </div>
        </Field>

        {error && <Alert tone="danger">{error}</Alert>}
      </div>
    </Dialog>
  );
}
