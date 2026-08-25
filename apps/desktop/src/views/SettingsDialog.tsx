import { useEffect, useMemo, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import type { ConfigSetFilePatchInput, ConfigSource, EffectiveCoreConfig, ResolvedProvider } from "@deskmony/shared";
import { useSessionStore, selectResolvedProviders } from "../stores/session-store.js";
import { Dialog } from "../ui/Dialog.js";
import { Button } from "../ui/Button.js";
import { Field, Input, Select, Checkbox, Switch } from "../ui/Field.js";
import { Badge, SectionLabel } from "../ui/Badge.js";
import { Icon } from "../ui/icons.js";
import { softwareLabel } from "../ui/status.js";
import { translateError } from "../lib/error-i18n.js";
import { PermissionsSection } from "./PermissionsSection.js";

interface SettingsDialogProps {
  onClose: () => void;
}

/**
 * 單一 provider 的模型啟用編輯器——任何 `models.length > 0` 的 provider 都能
 * 用同一個元件勾選啟用哪些 model。「全部勾選時存回空陣列」的既有約定維持
 * 不變(見 packages/shared/src/provider-catalog.ts 的註解)。
 */
function ModelsEditor({ provider }: { provider: ResolvedProvider }): JSX.Element {
  const { t } = useTranslation(["settings", "common"]);
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
      setError(translateError(err, t));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-1.5 rounded-md bg-canvas px-3 py-2.5">
      <p className="text-2xs text-fg-faint">{t("settings:provider.modelsHint")}</p>
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
        {provider.models.map((m) => (
          <Checkbox key={m.id} checked={draft.has(m.id)} onChange={() => toggle(m.id)} label={m.label} />
        ))}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <Button size="xs" variant="outline" loading={saving} onClick={() => void handleSave()}>
          {saving ? t("common:saving") : t("common:save")}
        </Button>
        {saved && <Badge tone="ok">{t("common:saved")}</Badge>}
        {error && <Badge tone="danger" title={error}>{t("common:saveFailed")}</Badge>}
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
  const { t } = useTranslation(["settings", "common"]);
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
      setError(translateError(err, t));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-1.5 rounded-md bg-canvas px-3 py-2.5">
      <p className="text-2xs text-fg-faint">{t("settings:provider.envHint")}</p>
      {maskedEnvKeys.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {maskedEnvKeys.map((key) => (
            <Badge key={key} mono>{key}=***</Badge>
          ))}
        </div>
      )}
      <div className="mt-1.5 flex gap-1.5">
        <Input mono value={newKey} onChange={(e) => setNewKey(e.target.value)} placeholder={t("settings:provider.envKeyPlaceholder")} className="w-2/5" />
        <Input mono type="password" value={newValue} onChange={(e) => setNewValue(e.target.value)} placeholder={t("settings:provider.envValuePlaceholder")} className="flex-1" />
        <Button size="sm" variant="outline" loading={saving} disabled={!newKey.trim()} onClick={() => void handleAdd()}>
          {saving ? t("common:saving") : t("settings:provider.addUpdate")}
        </Button>
      </div>
      {saved && <p className="mt-1 text-2xs text-ok">{t("common:saved")}</p>}
      {error && <p className="mt-1 text-2xs text-danger" title={error}>{t("common:saveFailed")}</p>}
    </div>
  );
}

/** 單一 provider 的管理卡片:啟用開關 + 排序 + 展開後的模型/環境變數編輯。 */
function ProviderCard({ provider, maskedEnvKeys }: { provider: ResolvedProvider; maskedEnvKeys: string[] }): JSX.Element {
  const { t } = useTranslation(["settings"]);
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
          title={provider.installed ? t("settings:provider.installed") : t("settings:provider.notDetected")}
        />
        <span className="text-sm font-medium text-fg">{provider.label}</span>
        <Badge mono>{softwareLabel(provider.software)}</Badge>
        {provider.detectedVersion && <Badge mono>v{provider.detectedVersion}</Badge>}
        <div className="ml-auto flex flex-shrink-0 items-center gap-3">
          <label className="flex items-center gap-1.5 text-2xs text-fg-muted">
            {t("settings:provider.orderLabel")}
            <Input value={orderDraft} onChange={(e) => setOrderDraft(e.target.value)} onBlur={handleOrderCommit} className="!h-6 w-12" />
          </label>
          <Switch
            checked={provider.enabled}
            onChange={(next) => void setProviderPrefs(provider.id, { enabled: next })}
            label={t(provider.enabled ? "settings:provider.disableLabel" : "settings:provider.enableLabel", { name: provider.label })}
          />
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
          {expanded ? t("settings:provider.collapseModelsEnv") : t("settings:provider.expandModelsEnv")}
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

const sourceBadgeTone: Record<ConfigSource, "neutral" | "info" | "warn"> = { default: "neutral", file: "info", env: "warn" };

/** i18n 專案新增:`sourceBadgeText` 原本是模組載入當下就算好的靜態 Record,
 *  改成在這個元件內即時查表(比照 ui/status.ts 的 sessionStatusMeta() 慣例)
 *  ——純樣式的 `sourceBadgeTone` 不含文字,維持靜態 Record 即可。 */
function SourceBadge({ source }: { source: ConfigSource }): JSX.Element {
  const { t } = useTranslation(["settings"]);
  return <Badge tone={sourceBadgeTone[source]}>{t(`settings:source.${source}`)}</Badge>;
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
  const { t } = useTranslation(["settings", "common"]);
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
      setError(translateError(err, t));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-md bg-surface px-3 py-2.5">
      <p className="text-2xs leading-relaxed text-fg-faint">
        <Trans
          i18nKey="settings:global.description"
          components={{ configPath: <code className="text-fg-muted">{"<DESKMONY_HOME>/config.json"}</code> }}
        />
      </p>

      <ConfigFieldRow label="Gateway Port" source={config.daemon.port.source} locked lockedReason={t("settings:global.noInterfaceEditReason", { envVarName: "DESKMONY_CORE_PORT" })}>
        <span className="font-mono text-2xs text-fg-muted">{config.daemon.port.value}</span>
      </ConfigFieldRow>
      <ConfigFieldRow label={t("settings:global.bindHostLabel")} source={config.daemon.bindHost.source} locked lockedReason={t("settings:global.noInterfaceEditReason", { envVarName: "DESKMONY_BIND_HOST" })}>
        <span className="font-mono text-2xs text-fg-muted">{config.daemon.bindHost.value}</span>
      </ConfigFieldRow>
      <ConfigFieldRow
        label={t("settings:global.permissionTimeoutLabel")}
        source={config.daemon.permissionTimeoutMs.source}
        locked={config.daemon.permissionTimeoutMs.source === "env"}
        lockedReason={t("settings:global.lockedByEnvVar", { envVarName: "DESKMONY_PERMISSION_TIMEOUT_MS" })}
      >
        <Input value={permissionTimeoutMs} onChange={(e) => setPermissionTimeoutMs(e.target.value)} disabled={config.daemon.permissionTimeoutMs.source === "env"} />
      </ConfigFieldRow>
      <ConfigFieldRow
        label={t("settings:global.authRateLimitMaxLabel")}
        source={config.daemon.authRateLimit.max.source}
        locked={config.daemon.authRateLimit.max.source === "env"}
        lockedReason={t("settings:global.lockedByEnvVar", { envVarName: "DESKMONY_AUTH_RATE_LIMIT_MAX" })}
      >
        <Input value={rateLimitMax} onChange={(e) => setRateLimitMax(e.target.value)} disabled={config.daemon.authRateLimit.max.source === "env"} />
      </ConfigFieldRow>
      <ConfigFieldRow
        label={t("settings:global.authRateLimitCooldownLabel")}
        source={config.daemon.authRateLimit.cooldownMs.source}
        locked={config.daemon.authRateLimit.cooldownMs.source === "env"}
        lockedReason={t("settings:global.lockedByEnvVar", { envVarName: "DESKMONY_AUTH_RATE_LIMIT_COOLDOWN_MS" })}
      >
        <Input value={rateLimitCooldownMs} onChange={(e) => setRateLimitCooldownMs(e.target.value)} disabled={config.daemon.authRateLimit.cooldownMs.source === "env"} />
      </ConfigFieldRow>
      <ConfigFieldRow
        label={t("settings:global.defaultWorkingDirLabel")}
        source={config.workspace.defaultWorkingDir.source}
        locked={config.workspace.defaultWorkingDir.source === "env"}
        lockedReason={t("settings:global.lockedByEnvVar", { envVarName: "DESKMONY_WORKSPACE" })}
      >
        <Input mono value={defaultWorkingDir} onChange={(e) => setDefaultWorkingDir(e.target.value)} disabled={config.workspace.defaultWorkingDir.source === "env"} />
      </ConfigFieldRow>
      <ConfigFieldRow label={t("settings:global.taskWorktreesRootLabel")} source={config.workspace.worktreesRoot.source} locked={false}>
        <Input mono value={worktreesRoot} onChange={(e) => setWorktreesRoot(e.target.value)} placeholder={t("settings:global.taskWorktreesRootPlaceholder")} />
      </ConfigFieldRow>
      <ConfigFieldRow
        label={t("settings:global.staticDirLabel")}
        source={config.features.staticDir.source}
        locked={config.features.staticDir.source === "env"}
        lockedReason={t("settings:global.lockedByEnvVar", { envVarName: "DESKMONY_STATIC_DIR" })}
      >
        <Input mono value={staticDir} onChange={(e) => setStaticDir(e.target.value)} disabled={config.features.staticDir.source === "env"} />
      </ConfigFieldRow>
      <ConfigFieldRow label={t("settings:global.logLevelLabel")} source={config.log.level.source} locked={config.log.level.source === "env"}>
        <Select value={logLevel} onChange={(e) => setLogLevel(e.target.value as "info" | "warn" | "error")} disabled={config.log.level.source === "env"}>
          <option value="info">info</option>
          <option value="warn">warn</option>
          <option value="error">error</option>
        </Select>
      </ConfigFieldRow>
      <ConfigFieldRow label={t("settings:global.dataDirLabel")} source={config.data.dataDir.source} locked lockedReason={t("settings:global.dataDirLockedReason", { envVarName: "DESKMONY_DATA_DIR" })}>
        <span className="truncate font-mono text-2xs text-fg-muted" title={config.data.dataDir.value}>
          {config.data.dataDir.value}
        </span>
      </ConfigFieldRow>

      <div className="mt-2 flex items-center gap-2">
        <Button size="sm" variant="outline" loading={saving} onClick={() => void handleSave()}>
          {saving ? t("common:saving") : t("settings:global.saveButton")}
        </Button>
        {result && result.changedFields.length === 0 && <span className="text-2xs text-fg-faint">{t("settings:global.noChanges")}</span>}
        {result && result.changedFields.length > 0 && (
          <Badge tone="warn">
            {t("settings:global.written", { fields: result.changedFields.join(", ") })}
            {result.requiresRestart ? t("settings:global.requiresRestart") : ""}
          </Badge>
        )}
        {error && <Badge tone="danger" title={error}>{t("settings:global.saveFailedWithReason", { error })}</Badge>}
      </div>
    </div>
  );
}

/**
 * S11(Notification):「通知設定」區塊——**唯讀顯示**。刻意不提供任何輸入框
 * ——`notification` 整區都不在 `config.setFile` 的安全子集內。
 */
function NotificationConfigSection({ config }: { config: EffectiveCoreConfig }): JSX.Element {
  const { t } = useTranslation(["settings"]);
  const n = config.notification;
  return (
    <div className="rounded-md bg-surface px-3 py-2.5">
      <p className="text-2xs leading-relaxed text-fg-faint">
        <Trans
          i18nKey="settings:notification.description"
          components={{
            configPath: <code className="text-fg-muted">{"<DESKMONY_HOME>/config.json"}</code>,
            notificationBlock: <code className="text-fg-muted">notification</code>,
          }}
        />
      </p>
      <ConfigFieldRow label={t("settings:notification.desktopLabel")} source={n.desktop.enabled.source} locked lockedReason={t("settings:notification.readOnlyReason")}>
        <span className="text-2xs text-fg-muted">{n.desktop.enabled.value ? t("settings:notification.enabledValue") : t("settings:notification.disabledValue")}</span>
      </ConfigFieldRow>
      <ConfigFieldRow label="Webhook" source={n.webhook.enabled.source} locked lockedReason={t("settings:notification.readOnlyReason")}>
        <span className="text-2xs text-fg-muted">{n.webhook.enabled.value ? t("settings:notification.enabledValue") : t("settings:notification.disabledValue")}</span>
      </ConfigFieldRow>
      <ConfigFieldRow label="Webhook URL" source={n.webhook.url.source} locked lockedReason={t("settings:notification.webhookUrlLockedReason")}>
        <span className="font-mono text-2xs text-fg-muted">{n.webhook.url.value || t("settings:notification.notSet")}</span>
      </ConfigFieldRow>
      <ConfigFieldRow label={t("settings:notification.webhookMinSeverityLabel")} source={n.webhook.minSeverity.source} locked lockedReason={t("settings:notification.readOnlyReason")}>
        <span className="text-2xs text-fg-muted">{n.webhook.minSeverity.value}</span>
      </ConfigFieldRow>
      <ConfigFieldRow label={t("settings:notification.batchIntervalLabel")} source={n.batchIntervalMinutes.source} locked lockedReason={t("settings:notification.readOnlyReason")}>
        <span className="text-2xs text-fg-muted">{n.batchIntervalMinutes.value}</span>
      </ConfigFieldRow>
      <ConfigFieldRow label={t("settings:notification.quietHoursLabel")} source={n.quietHours.source} locked lockedReason={t("settings:notification.readOnlyReason")}>
        <span className="text-2xs text-fg-muted">{n.quietHours.value ? `${n.quietHours.value.from} – ${n.quietHours.value.to}` : t("settings:notification.notSet")}</span>
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
  const { t } = useTranslation(["settings", "common"]);
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
      title={t("settings:dialogTitle")}
      description={t("settings:dialogDescription")}
      icon="settings"
      size="lg"
      onClose={onClose}
      footer={
        <>
          <p className="text-2xs text-fg-faint">{detectingAgents ? t("common:detecting") : t("settings:providerCountFooter", { count: resolvedProviders.length })}</p>
          <div className="flex gap-2">
            <Button variant="outline" loading={detectingAgents} onClick={() => void detectAgents()}>
              {detectingAgents ? t("common:detecting") : t("settings:redetect")}
            </Button>
            <Button variant="primary" onClick={onClose}>
              {t("common:close")}
            </Button>
          </div>
        </>
      }
    >
      <div className="space-y-2">
        <SectionLabel>{t("settings:sections.permission")}</SectionLabel>
        <PermissionsSection />

        <SectionLabel className="pt-1">{t("settings:sections.global")}</SectionLabel>
        {effectiveConfig ? <GlobalConfigSection config={effectiveConfig} /> : <p className="py-2 text-center text-2xs text-fg-faint">{t("common:loading")}</p>}

        <SectionLabel className="pt-1">{t("settings:sections.notification")}</SectionLabel>
        {effectiveConfig ? <NotificationConfigSection config={effectiveConfig} /> : <p className="py-2 text-center text-2xs text-fg-faint">{t("common:loading")}</p>}

        <SectionLabel className="pt-1">{t("settings:sections.provider")}</SectionLabel>
        {resolvedProviders.length === 0 && detectingAgents && <p className="py-6 text-center text-xs text-fg-faint">{t("common:detecting")}</p>}
        <div className="space-y-2">
          {resolvedProviders.map((provider) => (
            <ProviderCard key={provider.id} provider={provider} maskedEnvKeys={Object.keys(providerPrefs[provider.id]?.env ?? {})} />
          ))}
        </div>
      </div>
    </Dialog>
  );
}
