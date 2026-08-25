import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { PolicyRule, PolicyRuleWhen } from "@deskmony/shared";
import { useSessionStore } from "../stores/session-store.js";
import { Button } from "../ui/Button.js";
import { Badge } from "../ui/Badge.js";
import { Field, Input, Select } from "../ui/Field.js";
import { Icon } from "../ui/icons.js";
import { translateError } from "../lib/error-i18n.js";

/**
 * PermissionsSection.tsx(2026-08-25 新增,見 docs/DECISIONS.md §G)。
 *
 * Settings 對話框的「權限」分頁——使用者原始要求裡「也要能單項選擇」的具體
 * 實作:目前的政策允許清單(逐條顯示、逐條刪除),加上一個手動新增單一規則
 * 的小表單。**本機與遠端皆可使用**(`policy.addRule`/`removeRule` 這輪起不
 * 再是 local-only,見 gateway.ts 對應方法的完整說明)。
 *
 * **刻意獨立成自己的檔案**(不是像 `GlobalConfigSection`/`NotificationConfigSection`
 * 那樣是 `SettingsDialog.tsx` 內的一個函式)——這個分頁有自己的非同步資料
 * 生命週期(`policy.listRules` + `"policy-updated"` 即時推播),不是單純渲染
 * 一份已經同步載入好的 `effectiveConfig` 快照。
 *
 * **這裡管理的允許清單,本身管不到 hard-deny**——default-deny 的中間地帶
 * 規則(`allow`/`deny`)一律在 hard-deny 判斷之後才比對(見
 * apps/core/src/permissions/policy-engine.ts 的 `decide()`),不管這裡加了
 * 什麼規則,四類硬性 deny 依然是地板。唯一能繞過 hard-deny 的開關是
 * per-session 的「真.無限制」層(在 ChatView 標頭的 `AutoModeControl` 裡,
 * 不在這裡)——這裡的說明區塊會提醒這個界線,避免使用者以為在這裡加一條
 * `effect:"allow"` 規則就能連 force-push 都放行。
 */

const WHEN_KINDS = ["none", "commandEquals", "commandMatches", "pathUnder"] as const;
type WhenKind = (typeof WHEN_KINDS)[number];

function whenKindOf(when: PolicyRuleWhen | undefined): WhenKind {
  if (!when) return "none";
  if (when.commandEquals !== undefined) return "commandEquals";
  if (when.commandMatches !== undefined) return "commandMatches";
  if (when.pathUnder !== undefined) return "pathUnder";
  return "none";
}

/** 借用 `permission.json` 既有的 `remember.*Description` 詞彙(見
 *  `PermissionModal.tsx` 的 `buildRememberCandidates()` 已經解過一次同樣的
 *  措辭問題)——不管這條規則是從對話框「永遠允許」按出來的,還是這裡手動
 *  新增的,同一種 when 形狀用同一句描述,不重造一套相近但不同的說法。 */
function describeWhen(rule: PolicyRule, t: TFunction): string {
  if (rule.when?.commandEquals !== undefined) {
    return t("permission:remember.commandExactDescription", { toolName: rule.tool, command: rule.when.commandEquals });
  }
  if (rule.when?.commandMatches !== undefined) {
    return t("permission:remember.commandPrefixDescription", { toolName: rule.tool, pattern: rule.when.commandMatches });
  }
  if (rule.when?.pathUnder !== undefined) {
    return t("permission:remember.pathScopeDescription", { toolName: rule.tool, path: rule.when.pathUnder });
  }
  return t("permission:remember.toolExactDescription", { toolName: rule.tool });
}

function RuleRow({ rule }: { rule: PolicyRule }): JSX.Element {
  const { t } = useTranslation(["settings", "permission", "common"]);
  const removePolicyRule = useSessionStore((s) => s.removePolicyRule);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleRemove = async (): Promise<void> => {
    if (!rule.id) return;
    setRemoving(true);
    setError(null);
    try {
      await removePolicyRule(rule.id);
    } catch (err) {
      setError(translateError(err, t));
    } finally {
      setRemoving(false);
    }
  };

  return (
    <div className="flex items-start gap-2 rounded-md bg-canvas px-3 py-2">
      <Badge tone={rule.effect === "deny" ? "danger" : "ok"} className="mt-0.5 flex-shrink-0 uppercase">
        {rule.effect}
      </Badge>
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs text-fg-soft">{describeWhen(rule, t)}</p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs text-fg-faint">
          {rule.scope?.profileId && <span>{t("settings:permission.scopeProfile", { id: rule.scope.profileId })}</span>}
          {rule.scope?.role && <span>{t("settings:permission.scopeRole", { role: rule.scope.role })}</span>}
          <span>
            {t(rule.addedBy === "ui-remember" ? "settings:permission.addedByRemember" : "settings:permission.addedByUser")}
          </span>
          {rule.addedAt && <span>{new Date(rule.addedAt).toLocaleString()}</span>}
        </p>
        {error && <p className="mt-0.5 text-2xs text-danger">{error}</p>}
      </div>
      <Button
        size="xs"
        variant="ghost"
        icon="trash"
        loading={removing}
        disabled={!rule.id}
        onClick={() => void handleRemove()}
        className="!text-fg-faint hover:!text-danger"
      >
        {t("common:delete")}
      </Button>
    </div>
  );
}

function AddRuleForm(): JSX.Element {
  const { t } = useTranslation(["settings", "common"]);
  const addPolicyRule = useSessionStore((s) => s.addPolicyRule);
  const [tool, setTool] = useState("");
  const [effect, setEffect] = useState<"allow" | "deny">("allow");
  const [whenKind, setWhenKind] = useState<WhenKind>("none");
  const [whenValue, setWhenValue] = useState("");
  const [profileId, setProfileId] = useState("");
  const [role, setRole] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (): Promise<void> => {
    const trimmedTool = tool.trim();
    if (!trimmedTool) {
      setError(t("settings:permission.toolRequired"));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const when: PolicyRuleWhen | undefined =
        whenKind === "none" || !whenValue.trim()
          ? undefined
          : whenKind === "commandEquals"
            ? { commandEquals: whenValue.trim() }
            : whenKind === "commandMatches"
              ? { commandMatches: whenValue.trim() }
              : { pathUnder: whenValue.trim() };
      const scope =
        profileId.trim() || role.trim()
          ? { profileId: profileId.trim() || undefined, role: role.trim() || undefined }
          : undefined;
      await addPolicyRule({ tool: trimmedTool, effect, when, scope });
      setTool("");
      setWhenValue("");
      setProfileId("");
      setRole("");
      setWhenKind("none");
    } catch (err) {
      setError(translateError(err, t));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-md bg-canvas px-3 py-2.5">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Field label={t("settings:permission.toolLabel")}>
          <Input value={tool} onChange={(e) => setTool(e.target.value)} placeholder="*" mono />
        </Field>
        <Field label={t("settings:permission.effectLabel")}>
          <Select value={effect} onChange={(e) => setEffect(e.target.value as "allow" | "deny")}>
            <option value="allow">{t("settings:permission.effectAllow")}</option>
            <option value="deny">{t("settings:permission.effectDeny")}</option>
          </Select>
        </Field>
        <Field label={t("settings:permission.whenKindLabel")} className="col-span-2 sm:col-span-1">
          <Select value={whenKind} onChange={(e) => setWhenKind(e.target.value as WhenKind)}>
            <option value="none">{t("settings:permission.whenKindNone")}</option>
            <option value="commandEquals">{t("settings:permission.whenKindCommandEquals")}</option>
            <option value="commandMatches">{t("settings:permission.whenKindCommandMatches")}</option>
            <option value="pathUnder">{t("settings:permission.whenKindPathUnder")}</option>
          </Select>
        </Field>
        <Field label={t("settings:permission.whenValueLabel")} className="col-span-2 sm:col-span-1">
          <Input
            value={whenValue}
            onChange={(e) => setWhenValue(e.target.value)}
            disabled={whenKind === "none"}
            mono
          />
        </Field>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <Field label={t("settings:permission.scopeProfileLabel")}>
          <Input value={profileId} onChange={(e) => setProfileId(e.target.value)} />
        </Field>
        <Field label={t("settings:permission.scopeRoleLabel")}>
          <Input value={role} onChange={(e) => setRole(e.target.value)} />
        </Field>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <Button size="xs" variant="outline" loading={saving} onClick={() => void handleSubmit()}>
          {t("settings:permission.addRuleButton")}
        </Button>
        {error && <p className="text-2xs text-danger">{error}</p>}
      </div>
    </div>
  );
}

export function PermissionsSection(): JSX.Element {
  const { t } = useTranslation(["settings", "common"]);
  const policyRules = useSessionStore((s) => s.policyRules);
  const loadPolicyRules = useSessionStore((s) => s.loadPolicyRules);
  const capabilities = useSessionStore((s) => s.gatewayCapabilities);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void loadPolicyRules().finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="rounded-md bg-surface px-3 py-2.5">
      <p className="text-2xs leading-relaxed text-fg-faint">{t("settings:permission.description")}</p>
      {capabilities.isRemoteConnection && (
        <p className="mt-1 flex items-center gap-1 text-2xs text-warn">
          <Icon name="alert" size={11} />
          {t("settings:permission.remoteNotice")}
        </p>
      )}

      <div className="mt-2 space-y-1.5">
        {loading && <p className="py-2 text-center text-2xs text-fg-faint">{t("common:loading")}</p>}
        {!loading && policyRules.length === 0 && (
          <p className="py-2 text-center text-2xs text-fg-faint">{t("settings:permission.emptyList")}</p>
        )}
        {policyRules.map((rule) => (
          <RuleRow key={rule.id ?? `${rule.tool}-${rule.addedAt ?? 0}`} rule={rule} />
        ))}
      </div>

      <div className="mt-2">
        <AddRuleForm />
      </div>
    </div>
  );
}
