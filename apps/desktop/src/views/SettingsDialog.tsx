import { useEffect, useMemo, useState } from "react";
import type { ConfigSetFilePatchInput, ConfigSource, EffectiveCoreConfig, ResolvedProvider } from "@deskmony/shared";
import { useSessionStore, selectResolvedProviders } from "../stores/session-store.js";
import { Dialog } from "../ui/Dialog.js";
import { Button } from "../ui/Button.js";
import { Field, Input, Select, Checkbox, Switch } from "../ui/Field.js";
import { Badge, SectionLabel } from "../ui/Badge.js";
import { Icon } from "../ui/icons.js";
import { softwareLabel } from "../ui/status.js";

interface SettingsDialogProps {
  onClose: () => void;
}

/**
 * 單一 provider 的模型啟用編輯器——任何 `models.length > 0` 的 provider 都能
 * 用同一個元件勾選啟用哪些 model。「全部勾選時存回空陣列」的既有約定維持
 * 不變(見 packages/shared/src/provider-catalog.ts 的註解)。
 */
function ModelsEditor({ provider }: { provider: ResolvedProvider }): JSX.Element {
  const setProviderPrefs = useSessionStore((s) => s.setProviderPrefs);
  const [draft, setDraft] = useState<Set<string>>(new Set(provider.models.map((m) => m.id)));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(new Set(provider.models.map((m) => m.id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider.models.map((m) => m.id).join(",")]);

  const toggle = (id: string): void => {
    setSaved(false);
    setDraft((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleSave = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const allIds = provider.models.map((m) => m.id);
      const allSelected = allIds.length > 0 && allIds.every((id) => draft.has(id));
      await setProviderPrefs(provider.id, { enabledModelIds: allSelected ? [] : [...draft] });
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-1.5 rounded-md bg-canvas px-3 py-2.5">
      <p className="text-2xs text-fg-faint">啟用的 model(未勾選的不會出現在「建立 Profile」或對話中「切換 model」的下拉選單)</p>
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
        {provider.models.map((m) => (
          <Checkbox key={m.id} checked={draft.has(m.id)} onChange={() => toggle(m.id)} label={m.label} />
        ))}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <Button size="xs" variant="outline" loading={saving} onClick={() => void handleSave()}>
          {saving ? "儲存中…" : "儲存"}
        </Button>
        {saved && <Badge tone="ok">已儲存</Badge>}
        {error && <Badge tone="danger" title={error}>儲存失敗</Badge>}
      </div>
    </div>
  );
}

/**
 * 環境變數編輯器——顯示已設定的 env key 名稱(**不含值**,一律遮罩),提供
 * 「新增/更新單一 key」的小表單。write-only 語意不變:永遠不會把遮罩值當作
 * 真正的 env 值使用。
 */
function EnvEditor({ provider, maskedEnvKeys }: { provider: ResolvedProvider; maskedEnvKeys: string[] }): JSX.Element {
  const setProviderPrefs = useSessionStore((s) => s.setProviderPrefs);
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleAdd = async (): Promise<void> => {
    const key = newKey.trim();
    if (!key) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await setProviderPrefs(provider.id, { env: { [key]: newValue } });
      setNewKey("");
      setNewValue("");
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-1.5 rounded-md bg-canvas px-3 py-2.5">
      <p className="text-2xs text-fg-faint">環境變數(例如 ANTHROPIC_API_KEY)——值一律加密顯示為 ***,這裡看到的清單只是「已設定哪些 key」,無法讀回明文。</p>
      {maskedEnvKeys.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {maskedEnvKeys.map((key) => (
            <Badge key={key} mono>{key}=***</Badge>
          ))}
        </div>
      )}
      <div className="mt-1.5 flex gap-1.5">
        <Input mono value={newKey} onChange={(e) => setNewKey(e.target.value)} placeholder="KEY" className="w-2/5" />
        <Input mono type="password" value={newValue} onChange={(e) => setNewValue(e.target.value)} placeholder="值" className="flex-1" />
        <Button size="sm" variant="outline" loading={saving} disabled={!newKey.trim()} onClick={() => void handleAdd()}>
          {saving ? "儲存中…" : "新增/更新"}
        </Button>
      </div>
      {saved && <p className="mt-1 text-2xs text-ok">已儲存</p>}
      {error && <p className="mt-1 text-2xs text-danger" title={error}>儲存失敗</p>}
    </div>
  );
}

/** 單一 provider 的管理卡片:啟用開關 + 排序 + 展開後的模型/環境變數編輯。 */
function ProviderCard({ provider, maskedEnvKeys }: { provider: ResolvedProvider; maskedEnvKeys: string[] }): JSX.Element {
  const setProviderPrefs = useSessionStore((s) => s.setProviderPrefs);
  const [expanded, setExpanded] = useState(false);
  const [orderDraft, setOrderDraft] = useState(String(provider.order));

  useEffect(() => setOrderDraft(String(provider.order)), [provider.order]);

  const handleOrderCommit = (): void => {
    const parsed = Number(orderDraft);
    if (Number.isFinite(parsed) && parsed !== provider.order) {
      void setProviderPrefs(provider.id, { order: parsed });
    }
  };

  return (
    <div className={`rounded-md bg-surface px-3 py-2.5 ${provider.enabled ? "" : "opacity-60"}`}>
      <div className="flex items-center gap-2">
        <span
          className={`h-2 w-2 flex-shrink-0 rounded-full ${provider.software === "claude-agent-sdk" || provider.installed ? "bg-ok" : "bg-line-strong"}`}
          title={provider.installed ? "已安裝/可用" : "未偵測到"}
        />
        <span className="text-sm font-medium text-fg">{provider.label}</span>
        <Badge mono>{softwareLabel(provider.software)}</Badge>
        {provider.detectedVersion && <Badge mono>v{provider.detectedVersion}</Badge>}
        <div className="ml-auto flex flex-shrink-0 items-center gap-3">
          <label className="flex items-center gap-1.5 text-2xs text-fg-muted">
            排序
            <Input value={orderDraft} onChange={(e) => setOrderDraft(e.target.value)} onBlur={handleOrderCommit} className="!h-6 w-12" />
          </label>
          <Switch checked={provider.enabled} onChange={(next) => void setProviderPrefs(provider.id, { enabled: next })} label={`${provider.enabled ? "停用" : "啟用"} ${provider.label}`} />
        </div>
      </div>

      {provider.command && (
        <p className="mt-1 truncate pl-4 font-mono text-2xs text-fg-faint" title={provider.command}>
          {provider.command}
          {provider.defaultArgs && provider.defaultArgs.length > 0 ? ` ${provider.defaultArgs.join(" ")}` : ""}
        </p>
      )}

      <div className="mt-1.5 pl-4">
        <button type="button" onClick={() => setExpanded((v) => !v)} className="flex items-center gap-1 text-2xs text-fg-faint hover:text-accent">
          <Icon name="chevron-right" size={11} className={`transition-transform ${expanded ? "rotate-90" : ""}`} />
          {expanded ? "收合" : "展開"}(模型 / 環境變數)
        </button>
      </div>

      {expanded && (
        <div className="pl-4">
          {provider.models.length > 0 && <ModelsEditor provider={provider} />}
          <EnvEditor provider={provider} maskedEnvKeys={maskedEnvKeys} />
        </div>
      )}
    </div>
  );
}

const sourceBadgeText: Record<ConfigSource, string> = { default: "預設值", file: "設定檔", env: "環境變數" };
const sourceBadgeTone: Record<ConfigSource, "neutral" | "info" | "warn"> = { default: "neutral", file: "info", env: "warn" };

function SourceBadge({ source }: { source: ConfigSource }): JSX.Element {
  return <Badge tone={sourceBadgeTone[source]}>{sourceBadgeText[source]}</Badge>;
}

/**
 * 一列「全域設定」欄位:顯示目前有效值 + 來源徽章,`locked=true` 時顯示唯讀值。
 */
function ConfigFieldRow({
  label,
  source,
  locked,
  lockedReason,
  children,
}: {
  label: string;
  source: ConfigSource;
  locked: boolean;
  lockedReason?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="flex items-center gap-2 py-1">
      <span className="w-40 flex-shrink-0 text-2xs text-fg-faint">{label}</span>
      <div className="min-w-0 flex-1">{children}</div>
      <SourceBadge source={source} />
      {locked && (
        <span title={lockedReason} className="flex-shrink-0 text-fg-faint">
          <Icon name="shield" size={12} />
        </span>
      )}
    </div>
  );
}

/**
 * 「全域設定」區塊——顯示 `config.getEffective` 的分層合併結果,提供
 * `config.setFile` 安全子集的編輯表單。刻意不提供 `daemon.port`/`daemon.bindHost`
 * 的編輯 UI。
 */
function GlobalConfigSection({ config }: { config: EffectiveCoreConfig }): JSX.Element {
  const setConfigFile = useSessionStore((s) => s.setConfigFile);
  const [permissionTimeoutMs, setPermissionTimeoutMs] = useState(String(config.daemon.permissionTimeoutMs.value));
  const [rateLimitMax, setRateLimitMax] = useState(String(config.daemon.authRateLimit.max.value));
  const [rateLimitCooldownMs, setRateLimitCooldownMs] = useState(String(config.daemon.authRateLimit.cooldownMs.value));
  const [defaultWorkingDir, setDefaultWorkingDir] = useState(config.workspace.defaultWorkingDir.value);
  const [worktreesRoot, setWorktreesRoot] = useState(config.workspace.worktreesRoot.value ?? "");
  const [staticDir, setStaticDir] = useState(config.features.staticDir.value ?? "");
  const [logLevel, setLogLevel] = useState(config.log.level.value);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ changedFields: string[]; requiresRestart: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    setResult(null);
    try {
      const patch: ConfigSetFilePatchInput = {};
      if (config.daemon.permissionTimeoutMs.source !== "env" && Number(permissionTimeoutMs) !== config.daemon.permissionTimeoutMs.value) {
        patch.daemon = { ...patch.daemon, permissionTimeoutMs: Number(permissionTimeoutMs) };
      }
      if (config.daemon.authRateLimit.max.source !== "env" && Number(rateLimitMax) !== config.daemon.authRateLimit.max.value) {
        patch.daemon = { ...patch.daemon, authRateLimit: { ...patch.daemon?.authRateLimit, max: Number(rateLimitMax) } };
      }
      if (
        config.daemon.authRateLimit.cooldownMs.source !== "env" &&
        Number(rateLimitCooldownMs) !== config.daemon.authRateLimit.cooldownMs.value
      ) {
        patch.daemon = {
          ...patch.daemon,
          authRateLimit: { ...patch.daemon?.authRateLimit, cooldownMs: Number(rateLimitCooldownMs) },
        };
      }
      if (config.workspace.defaultWorkingDir.source !== "env" && defaultWorkingDir !== config.workspace.defaultWorkingDir.value) {
        patch.workspace = { ...patch.workspace, defaultWorkingDir };
      }
      if (worktreesRoot.trim() && worktreesRoot !== (config.workspace.worktreesRoot.value ?? "")) {
        patch.workspace = { ...patch.workspace, worktreesRoot: worktreesRoot.trim() };
      }
      if (config.features.staticDir.source !== "env" && staticDir.trim() && staticDir !== (config.features.staticDir.value ?? "")) {
        patch.features = { staticDir: staticDir.trim() };
      }
      if (config.log.level.source !== "env" && logLevel !== config.log.level.value) {
        patch.log = { level: logLevel };
      }
      if (Object.keys(patch).length === 0) {
        setResult({ changedFields: [], requiresRestart: false });
        return;
      }
      const saveResult = await setConfigFile(patch);
      setResult(saveResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-md bg-surface px-3 py-2.5">
      <p className="text-2xs leading-relaxed text-fg-faint">
        core 的分層設定(defaults → <code className="text-fg-muted">&lt;DESKMONY_HOME&gt;/config.json</code> → 環境變數)——標示「環境變數」來源的欄位已鎖定
        (改設定檔不會生效,環境變數永遠優先);修改後需要重啟 core 才會生效。
      </p>

      <ConfigFieldRow label="Gateway Port" source={config.daemon.port.source} locked lockedReason="不可經此介面修改,避免遠端調整曝露面,需手動編輯設定檔或 DESKMONY_CORE_PORT">
        <span className="font-mono text-2xs text-fg-muted">{config.daemon.port.value}</span>
      </ConfigFieldRow>
      <ConfigFieldRow label="綁定位址" source={config.daemon.bindHost.source} locked lockedReason="不可經此介面修改,避免遠端調整曝露面,需手動編輯設定檔或 DESKMONY_BIND_HOST">
        <span className="font-mono text-2xs text-fg-muted">{config.daemon.bindHost.value}</span>
      </ConfigFieldRow>
      <ConfigFieldRow
        label="權限逾時(ms)"
        source={config.daemon.permissionTimeoutMs.source}
        locked={config.daemon.permissionTimeoutMs.source === "env"}
        lockedReason="目前由 DESKMONY_PERMISSION_TIMEOUT_MS 決定,改設定檔不會生效"
      >
        <Input value={permissionTimeoutMs} onChange={(e) => setPermissionTimeoutMs(e.target.value)} disabled={config.daemon.permissionTimeoutMs.source === "env"} />
      </ConfigFieldRow>
      <ConfigFieldRow
        label="認證失敗門檻(次)"
        source={config.daemon.authRateLimit.max.source}
        locked={config.daemon.authRateLimit.max.source === "env"}
        lockedReason="目前由 DESKMONY_AUTH_RATE_LIMIT_MAX 決定,改設定檔不會生效"
      >
        <Input value={rateLimitMax} onChange={(e) => setRateLimitMax(e.target.value)} disabled={config.daemon.authRateLimit.max.source === "env"} />
      </ConfigFieldRow>
      <ConfigFieldRow
        label="認證冷卻期(ms)"
        source={config.daemon.authRateLimit.cooldownMs.source}
        locked={config.daemon.authRateLimit.cooldownMs.source === "env"}
        lockedReason="目前由 DESKMONY_AUTH_RATE_LIMIT_COOLDOWN_MS 決定,改設定檔不會生效"
      >
        <Input value={rateLimitCooldownMs} onChange={(e) => setRateLimitCooldownMs(e.target.value)} disabled={config.daemon.authRateLimit.cooldownMs.source === "env"} />
      </ConfigFieldRow>
      <ConfigFieldRow
        label="預設工作目錄"
        source={config.workspace.defaultWorkingDir.source}
        locked={config.workspace.defaultWorkingDir.source === "env"}
        lockedReason="目前由 DESKMONY_WORKSPACE 決定,改設定檔不會生效"
      >
        <Input mono value={defaultWorkingDir} onChange={(e) => setDefaultWorkingDir(e.target.value)} disabled={config.workspace.defaultWorkingDir.source === "env"} />
      </ConfigFieldRow>
      <ConfigFieldRow label="任務 worktree 根目錄" source={config.workspace.worktreesRoot.source} locked={false}>
        <Input mono value={worktreesRoot} onChange={(e) => setWorktreesRoot(e.target.value)} placeholder="省略 = 維持既有算法(每個 team 各自旁邊的 .deskmony-worktrees)" />
      </ConfigFieldRow>
      <ConfigFieldRow
        label="瀏覽器 UI 靜態目錄"
        source={config.features.staticDir.source}
        locked={config.features.staticDir.source === "env"}
        lockedReason="目前由 DESKMONY_STATIC_DIR 決定,改設定檔不會生效"
      >
        <Input mono value={staticDir} onChange={(e) => setStaticDir(e.target.value)} disabled={config.features.staticDir.source === "env"} />
      </ConfigFieldRow>
      <ConfigFieldRow label="Log 等級" source={config.log.level.source} locked={config.log.level.source === "env"}>
        <Select value={logLevel} onChange={(e) => setLogLevel(e.target.value as "info" | "warn" | "error")} disabled={config.log.level.source === "env"}>
          <option value="info">info</option>
          <option value="warn">warn</option>
          <option value="error">error</option>
        </Select>
      </ConfigFieldRow>
      <ConfigFieldRow label="SQLite 資料目錄(唯讀)" source={config.data.dataDir.source} locked lockedReason="不在可經 gateway 修改的安全子集內,需手動編輯設定檔或 DESKMONY_DATA_DIR">
        <span className="truncate font-mono text-2xs text-fg-muted" title={config.data.dataDir.value}>
          {config.data.dataDir.value}
        </span>
      </ConfigFieldRow>

      <div className="mt-2 flex items-center gap-2">
        <Button size="sm" variant="outline" loading={saving} onClick={() => void handleSave()}>
          {saving ? "儲存中…" : "儲存全域設定"}
        </Button>
        {result && result.changedFields.length === 0 && <span className="text-2xs text-fg-faint">沒有變更</span>}
        {result && result.changedFields.length > 0 && (
          <Badge tone="warn">
            已寫入:{result.changedFields.join(", ")}
            {result.requiresRestart ? "(需重啟 core 才會生效)" : ""}
          </Badge>
        )}
        {error && <Badge tone="danger" title={error}>儲存失敗:{error}</Badge>}
      </div>
    </div>
  );
}

/**
 * S11(Notification):「通知設定」區塊——**唯讀顯示**。刻意不提供任何輸入框
 * ——`notification` 整區都不在 `config.setFile` 的安全子集內。
 */
function NotificationConfigSection({ config }: { config: EffectiveCoreConfig }): JSX.Element {
  const n = config.notification;
  return (
    <div className="rounded-md bg-surface px-3 py-2.5">
      <p className="text-2xs leading-relaxed text-fg-faint">
        升級/熔斷的帶外通知(唯讀)——webhook url 視同憑證,即使本機連線也不提供任何遠端/UI 寫入路徑;要修改請直接編輯{" "}
        <code className="text-fg-muted">&lt;DESKMONY_HOME&gt;/config.json</code> 的 <code className="text-fg-muted">notification</code> 區塊,並重啟 core 才會生效。
      </p>
      <ConfigFieldRow label="桌面系統通知" source={n.desktop.enabled.source} locked lockedReason="唯讀,見上方說明">
        <span className="text-2xs text-fg-muted">{n.desktop.enabled.value ? "已啟用" : "已停用"}</span>
      </ConfigFieldRow>
      <ConfigFieldRow label="Webhook" source={n.webhook.enabled.source} locked lockedReason="唯讀,見上方說明">
        <span className="text-2xs text-fg-muted">{n.webhook.enabled.value ? "已啟用" : "已停用"}</span>
      </ConfigFieldRow>
      <ConfigFieldRow label="Webhook URL" source={n.webhook.url.source} locked lockedReason="視同憑證,一律遮罩,唯讀">
        <span className="font-mono text-2xs text-fg-muted">{n.webhook.url.value || "(未設定)"}</span>
      </ConfigFieldRow>
      <ConfigFieldRow label="Webhook 最低嚴重度" source={n.webhook.minSeverity.source} locked lockedReason="唯讀,見上方說明">
        <span className="text-2xs text-fg-muted">{n.webhook.minSeverity.value}</span>
      </ConfigFieldRow>
      <ConfigFieldRow label="批次間隔(分鐘)" source={n.batchIntervalMinutes.source} locked lockedReason="唯讀,見上方說明">
        <span className="text-2xs text-fg-muted">{n.batchIntervalMinutes.value}</span>
      </ConfigFieldRow>
      <ConfigFieldRow label="靜音時段" source={n.quietHours.source} locked lockedReason="唯讀,見上方說明">
        <span className="text-2xs text-fg-muted">{n.quietHours.value ? `${n.quietHours.value.from} – ${n.quietHours.value.to}` : "(未設定)"}</span>
      </ConfigFieldRow>
    </div>
  );
}

/**
 * 「設定」對話框(「Provider 管理」)。資料來源:`detectedAgents` +
 * `providerPrefs` 透過 `selectResolvedProviders()` 合併——與 ProfileCreateDialog/
 * ChatView 共用同一份計算結果,不會漂移。
 */
export function SettingsDialog({ onClose }: SettingsDialogProps): JSX.Element {
  const detectedAgents = useSessionStore((s) => s.detectedAgents);
  const detectingAgents = useSessionStore((s) => s.detectingAgents);
  const detectAgents = useSessionStore((s) => s.detectAgents);
  const providerPrefs = useSessionStore((s) => s.providerPrefs);
  const effectiveConfig = useSessionStore((s) => s.effectiveConfig);
  const loadEffectiveConfig = useSessionStore((s) => s.loadEffectiveConfig);

  useEffect(() => {
    if (!effectiveConfig) void loadEffectiveConfig();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (detectedAgents.length === 0 && !detectingAgents) {
      void detectAgents();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const resolvedProviders = useMemo(
    () => selectResolvedProviders(detectedAgents, providerPrefs),
    [detectedAgents, providerPrefs],
  );

  return (
    <Dialog
      title="設定 · Provider 管理"
      description="管理內建 provider 目錄(啟用/停用、排序、可用 model、環境變數),見本機偵測結果自動帶入的安裝狀態"
      icon="settings"
      size="lg"
      onClose={onClose}
      footer={
        <>
          <p className="text-2xs text-fg-faint">{detectingAgents ? "偵測中…" : `共 ${resolvedProviders.length} 項`}</p>
          <div className="flex gap-2">
            <Button variant="outline" loading={detectingAgents} onClick={() => void detectAgents()}>
              {detectingAgents ? "偵測中…" : "重新偵測"}
            </Button>
            <Button variant="primary" onClick={onClose}>
              關閉
            </Button>
          </div>
        </>
      }
    >
      <div className="space-y-2">
        <SectionLabel>全域設定</SectionLabel>
        {effectiveConfig ? <GlobalConfigSection config={effectiveConfig} /> : <p className="py-2 text-center text-2xs text-fg-faint">載入中…</p>}

        <SectionLabel className="pt-1">通知設定</SectionLabel>
        {effectiveConfig ? <NotificationConfigSection config={effectiveConfig} /> : <p className="py-2 text-center text-2xs text-fg-faint">載入中…</p>}

        <SectionLabel className="pt-1">Provider 管理</SectionLabel>
        {resolvedProviders.length === 0 && detectingAgents && <p className="py-6 text-center text-xs text-fg-faint">偵測中…</p>}
        <div className="space-y-2">
          {resolvedProviders.map((provider) => (
            <ProviderCard key={provider.id} provider={provider} maskedEnvKeys={Object.keys(providerPrefs[provider.id]?.env ?? {})} />
          ))}
        </div>
      </div>
    </Dialog>
  );
}
