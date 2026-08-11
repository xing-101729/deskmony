import { useEffect, useMemo, useState } from "react";
import { type AgentSoftware } from "@deskmony/shared";
import { useSessionStore, selectResolvedProviders } from "../stores/session-store.js";
import { Dialog } from "../ui/Dialog.js";
import { Button, IconButton } from "../ui/Button.js";
import { Field, Input, Select, Textarea } from "../ui/Field.js";
import { Alert } from "../ui/Feedback.js";
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
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
  }

  function resolveTarget():
    | { software: AgentSoftware; command?: string; args?: string[]; providerId?: string }
    | { error: string } {
    if (selectionKey === CUSTOM_KEY) {
      if (!customCommand.trim()) {
        return { error: `software="${customSoftware}" 必須提供 command` };
      }
      return { software: customSoftware, command: customCommand.trim(), args: parseArgs(customArgs) };
    }
    if (!selectedProvider) {
      return { error: "請選擇一個 agent 軟體" };
    }
    if (selectedProvider.software !== "claude-agent-sdk" && !selectedProvider.command) {
      return { error: "找不到這個 CLI 的完整路徑(偵測不到 path),請改用「自訂…」手動輸入" };
    }
    const combinedArgs = [...(selectedProvider.defaultArgs ?? []), ...(parseArgs(args) ?? [])];
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
      setError("請輸入 Profile 名稱");
      return;
    }
    if (!workingDir.trim()) {
      setError("請輸入工作目錄");
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
        ...(target.software === "acp" && target.command ? { acpConfig: { command: target.command, args: target.args } } : {}),
        ...(target.software === "pty" && target.command ? { ptyConfig: { command: target.command, args: target.args } } : {}),
        ...(target.software === "opencode" && target.command ? { opencodeConfig: { command: target.command } } : {}),
      });
      onCreated(profile.id);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      title="建立 Agent Profile"
      description="設定一個可用來建立 session 的 agent 設定檔"
      icon="sparkle"
      size="md"
      onClose={onClose}
      footer={
        <div className="flex w-full justify-end gap-2">
          <Button variant="secondary" disabled={submitting} onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" loading={submitting} onClick={() => void handleSubmit()}>
            {submitting ? "建立中…" : "建立"}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <Field label="名稱">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如:My Gemini Agent" />
        </Field>

        <Field label="角色(role,選填,預設 Coder)" hint="role 含「lead」時,下方 systemPrompt 會自動預填協調者範本(可再修改)。">
          <Input value={role} onChange={(e) => setRole(e.target.value)} placeholder="例如:Lead、Coder、Reviewer" />
        </Field>

        <Field
          label="systemPrompt(選填)"
          action={
            isLeadRole && (
              <button
                type="button"
                onClick={() => setSystemPrompt(LEAD_PROMPT_TEMPLATE_BODY)}
                className="text-2xs text-fg-faint underline decoration-dotted hover:text-accent"
              >
                套用 Lead 範本
              </button>
            )
          }
          hint="範本來源:docs/lead-prompt-template.md(可編輯該檔案調整之後新建 Lead profile 的預填內容)。"
        >
          <Textarea mono value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} rows={5} placeholder="留空 = 使用 agent 軟體本身的預設行為" />
        </Field>

        <Field
          label="Agent 軟體(provider 目錄,依本機偵測結果)"
          action={
            <button
              type="button"
              onClick={() => void detectAgents()}
              disabled={detectingAgents}
              className="text-2xs text-fg-faint underline decoration-dotted hover:text-accent disabled:opacity-40"
            >
              {detectingAgents ? "偵測中…" : "重新偵測"}
            </button>
          }
        >
          <Select value={selectionKey} onChange={(e) => setSelectionKey(e.target.value)}>
            {resolvedProviders.map((p) => (
              <option key={p.id} value={p.id} disabled={p.software !== "claude-agent-sdk" && !p.installed}>
                {p.label}
                {p.detectedVersion ? ` (v${p.detectedVersion})` : ""}
                {p.software !== "claude-agent-sdk" && !p.installed ? "(未偵測到)" : ""}
              </option>
            ))}
            <option value={CUSTOM_KEY}>自訂…(進階,手動輸入 command)</option>
          </Select>

          {isSdkTarget && <p className="mt-1 text-2xs text-fg-faint">深度整合 Claude Code(需要本機登入憑證或 ANTHROPIC_API_KEY)</p>}

          {selectedProvider && !isSdkTarget && (
            <div className="mt-1.5 space-y-1">
              <p className="text-2xs text-fg-faint">
                將以 <span className="font-mono text-fg-muted">{selectedProvider.software}</span> 建立,command 自動帶入偵測到的路徑:
              </p>
              <p className="truncate rounded bg-canvas px-2 py-1 font-mono text-2xs text-fg-muted" title={selectedProvider.command}>
                {selectedProvider.command ?? "(未偵測到完整路徑)"}
              </p>
              {selectedProvider.defaultArgs && selectedProvider.defaultArgs.length > 0 && (
                <p className="text-2xs text-fg-faint">
                  固定參數:<span className="font-mono text-fg-muted">{selectedProvider.defaultArgs.join(" ")}</span>
                </p>
              )}
              {isOpencodeTarget && (
                <p className="text-2xs text-fg-faint">對接 opencode 的 HTTP + SSE headless server API(非終端直通),支援串流訊息、工具呼叫與權限請求。</p>
              )}
            </div>
          )}
        </Field>

        {selectedProvider?.supportsModelSelection && selectedProvider.models.length > 0 && (
          <Field label="Model(選填)" hint="只列出「設定」介面啟用的 model(見設定 · Provider 管理);全部停用視為全部啟用。">
            <Select value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="">(未指定,使用 CLI 預設)</option>
              {selectedProvider.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </Select>
          </Field>
        )}

        {showArgsInput && (
          <Field label={`args(選填,以空白分隔${selectedProvider?.defaultArgs?.length ? ",附加在固定參數之後" : ""})`}>
            <Input mono value={args} onChange={(e) => setArgs(e.target.value)} placeholder="例如:--flag value" />
          </Field>
        )}

        {selectionKey === CUSTOM_KEY && (
          <>
            <Field label="software(自訂)">
              <Select value={customSoftware} onChange={(e) => setCustomSoftware(e.target.value as AgentSoftware)}>
                <option value="pty">PTY(終端直通)</option>
                <option value="acp">ACP(Agent Client Protocol)</option>
              </Select>
            </Field>
            <Field label="command">
              <Input mono value={customCommand} onChange={(e) => setCustomCommand(e.target.value)} placeholder="例如:cmd.exe 或 claude-code-acp" />
            </Field>
            <Field label="args(選填,以空白分隔)">
              <Input mono value={customArgs} onChange={(e) => setCustomArgs(e.target.value)} placeholder="例如:--flag value" />
            </Field>
          </>
        )}

        <Field
          label="環境變數(選填,對應 AgentProfile.env——同一 provider 建立多組不同憑證用,例如不同的 ANTHROPIC_API_KEY)"
          action={
            <button type="button" onClick={addEnvRow} className="text-2xs text-fg-faint underline decoration-dotted hover:text-accent">
              + 新增
            </button>
          }
        >
          <div className="space-y-1.5">
            {envRows.map((row, idx) => (
              <div key={idx} className="flex gap-1.5">
                <Input mono value={row.key} onChange={(e) => updateEnvRow(idx, { key: e.target.value })} placeholder="例如:ANTHROPIC_API_KEY" className="w-2/5" />
                <Input mono type="password" value={row.value} onChange={(e) => updateEnvRow(idx, { value: e.target.value })} placeholder="值" className="flex-1" />
                <IconButton icon="x" aria-label="移除這個環境變數" onClick={() => removeEnvRow(idx)} className="hover:!text-danger" />
              </div>
            ))}
            {envRows.length === 0 && <p className="text-2xs text-fg-faint">尚未新增任何環境變數。</p>}
          </div>
        </Field>

        <Field label="工作目錄(workingDir)">
          <div className="flex gap-1.5">
            <Input mono value={workingDir} onChange={(e) => setWorkingDir(e.target.value)} placeholder="例如:D:\project 或 /home/user/project" className="flex-1" />
            {canPickDirectory && (
              <Button variant="outline" onClick={() => void handlePickDirectory()}>
                瀏覽…
              </Button>
            )}
          </div>
        </Field>

        {error && <Alert tone="danger">{error}</Alert>}
      </div>
    </Dialog>
  );
}
