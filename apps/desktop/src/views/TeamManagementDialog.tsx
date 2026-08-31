import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { deriveLifecycleFromRole, type Lifecycle } from "@deskmony/shared";
import { useSessionStore } from "../stores/session-store.js";
import { useTeamStore } from "../stores/team-store.js";
import { Dialog } from "../ui/Dialog.js";
import { Button } from "../ui/Button.js";
import { Input, Select, Checkbox } from "../ui/Field.js";
import { Badge, StatusDot, SectionLabel } from "../ui/Badge.js";
import { Alert, EmptyState } from "../ui/Feedback.js";
import { sessionStatusMeta, softwareLabel, offlineStatus } from "../ui/status.js";
import { translateError } from "../lib/error-i18n.js";

/**
 * S8(agent-lifecycle):"" = 自動(依角色推導,見 deriveLifecycleFromRole())。
 *
 * i18n 專案新增:改成函式而非模組層級就算好的 `Record<Lifecycle, string>`——
 * `label` 要在每次呼叫時才即時查表(比照 ui/status.ts 的 sessionStatusMeta()/
 * taskStatusMeta() 慣例),否則語言切換後這個標籤會永遠停在第一次載入時的
 * 語言。這個檔案是 React 元件(不是像 ui/status.ts 那樣的純 TS 模組),`t`
 * 由呼叫端(元件本體 `useTranslation()` 拿到的)傳入,不直接 import i18next
 * 單例(比照 lib/error-i18n.ts 的 translateError() 慣例)。
 */
function lifecycleLabel(lifecycle: Lifecycle, t: TFunction): string {
  return t(`teamManagement:lifecycle.${lifecycle}`);
}

interface TeamManagementDialogProps {
  onClose: () => void;
}

/**
 * 「團隊管理」對話框:建立團隊、加入/移除成員、顯示成員清單與其目前 session
 * 狀態。改版只換了外殼與狀態語彙(統一走 `ui/status.ts`),資料流與既有邏輯
 * 完全不變。
 */
export function TeamManagementDialog({ onClose }: TeamManagementDialogProps): JSX.Element {
  const { t } = useTranslation(["teamManagement", "common"]);
  const teams = useTeamStore((s) => s.teams);
  const currentTeamId = useTeamStore((s) => s.currentTeamId);
  const teammatesByTeam = useTeamStore((s) => s.teammatesByTeam);
  const createTeam = useTeamStore((s) => s.createTeam);
  const addMember = useTeamStore((s) => s.addMember);
  const removeMember = useTeamStore((s) => s.removeMember);
  const deleteTeam = useTeamStore((s) => s.deleteTeam);
  const selectTeam = useTeamStore((s) => s.selectTeam);
  const profiles = useSessionStore((s) => s.profiles);
  const createSession = useSessionStore((s) => s.createSession);
  const capabilitiesBySoftware = useSessionStore((s) => s.capabilitiesBySoftware);

  const [selectedTeamId, setSelectedTeamId] = useState<string>(currentTeamId ?? "");
  const [newTeamName, setNewTeamName] = useState("");
  const [newTeamWorkingDir, setNewTeamWorkingDir] = useState("");
  const [creatingTeam, setCreatingTeam] = useState(false);

  const [memberProfileId, setMemberProfileId] = useState("");
  const [memberName, setMemberName] = useState("");
  const [memberRole, setMemberRole] = useState("");
  const [memberCanInterrupt, setMemberCanInterrupt] = useState(false);
  const [memberLifecycle, setMemberLifecycle] = useState<"" | Lifecycle>("");
  const [addingMember, setAddingMember] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 刪除團隊:確認對話框開關 + 刪除中狀態 + 刪完的後果摘要(尤其是「有未提交
   *  變更的 worktree 被移除了」——那是唯一可能真的失去工作成果的部分)。 */
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deletingTeam, setDeletingTeam] = useState(false);
  const [deleteSummary, setDeleteSummary] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedTeamId && teams.length > 0) setSelectedTeamId(teams[0].id);
  }, [teams, selectedTeamId]);

  useEffect(() => {
    if (profiles.length > 0 && !memberProfileId) setMemberProfileId(profiles[0].id);
  }, [profiles, memberProfileId]);

  const selectedTeam = teams.find((tm) => tm.id === selectedTeamId);
  const teammates = selectedTeamId ? (teammatesByTeam[selectedTeamId] ?? []) : [];
  const selectedMemberProfile = profiles.find((p) => p.id === memberProfileId);
  const effectiveRoleForPreview = memberRole.trim() || selectedMemberProfile?.role || "";
  const derivedLifecyclePreview = effectiveRoleForPreview ? deriveLifecycleFromRole(effectiveRoleForPreview) : undefined;

  const handleSelectTeam = (teamId: string): void => {
    setSelectedTeamId(teamId);
    void selectTeam(teamId);
  };

  const handleCreateTeam = async (): Promise<void> => {
    setError(null);
    if (!newTeamName.trim()) {
      setError(t("teamManagement:errors.teamNameRequired"));
      return;
    }
    setCreatingTeam(true);
    try {
      await createTeam({ name: newTeamName.trim(), workingDir: newTeamWorkingDir.trim() || undefined });
      setNewTeamName("");
      setNewTeamWorkingDir("");
    } catch (err) {
      setError(translateError(err, t));
    } finally {
      setCreatingTeam(false);
    }
  };

  const handleAddMember = async (): Promise<void> => {
    setError(null);
    if (!selectedTeamId) {
      setError(t("teamManagement:errors.selectTeamFirst"));
      return;
    }
    if (!memberProfileId) {
      setError(t("teamManagement:errors.selectProfileFirst"));
      return;
    }
    setAddingMember(true);
    try {
      await addMember({
        teamId: selectedTeamId,
        agentProfileId: memberProfileId,
        name: memberName.trim() || undefined,
        role: memberRole.trim() || undefined,
        canInterrupt: memberCanInterrupt,
        lifecycle: memberLifecycle || undefined,
      });
      setMemberName("");
      setMemberRole("");
      setMemberCanInterrupt(false);
      setMemberLifecycle("");
    } catch (err) {
      setError(translateError(err, t));
    } finally {
      setAddingMember(false);
    }
  };

  const handleDeleteTeam = async (): Promise<void> => {
    if (!selectedTeam) return;
    setError(null);
    setDeleteSummary(null);
    setDeletingTeam(true);
    try {
      const result = await deleteTeam(selectedTeam.id);
      setConfirmingDelete(false);
      // 選取換到剩下的第一個 team(store 已經把 currentTeamId 清成 null)。
      const remaining = teams.filter((tm) => tm.id !== selectedTeam.id);
      setSelectedTeamId(remaining[0]?.id ?? "");
      if (remaining[0]) void selectTeam(remaining[0].id);
      // 有未提交變更被丟掉時,訊息必須說得夠具體(列出是哪些任務),這是使用者
      // 唯一能據以判斷「我剛剛失去了什麼」的資訊。
      setDeleteSummary(
        result.tasksWithUncommittedChanges.length > 0
          ? t("teamManagement:deleteTeam.summaryWithUncommitted", {
              tasks: result.deletedTasks,
              members: result.deletedMembers,
              sessions: result.disposedSessions,
              titles: result.tasksWithUncommittedChanges.join("、"),
            })
          : t("teamManagement:deleteTeam.summary", {
              tasks: result.deletedTasks,
              members: result.deletedMembers,
              sessions: result.disposedSessions,
            }),
      );
    } catch (err) {
      setError(translateError(err, t));
      setConfirmingDelete(false);
    } finally {
      setDeletingTeam(false);
    }
  };

  const handleRemoveMember = async (memberId: string): Promise<void> => {
    if (!selectedTeamId) return;
    try {
      await removeMember(selectedTeamId, memberId);
    } catch (err) {
      setError(translateError(err, t));
    }
  };

  const handleCreateMemberSession = async (memberId: string, agentProfileId: string): Promise<void> => {
    const profile = profiles.find((p) => p.id === agentProfileId);
    const workingDir = selectedTeam?.workingDir || profile?.workingDir;
    if (!workingDir) {
      setError(t("teamManagement:errors.workingDirNotFound"));
      return;
    }
    try {
      await createSession(agentProfileId, workingDir, undefined, memberId);
    } catch (err) {
      setError(translateError(err, t));
    }
  };

  return (
    <Dialog title={t("teamManagement:dialog.title")} description={t("teamManagement:dialog.description")} icon="users" size="xl" onClose={onClose} bare>
      <div className="flex h-[68vh] min-h-0 max-h-full">
        {/* ---- 左側:team 清單 + 建立 team ---- */}
        <div className="w-52 flex-shrink-0 overflow-y-auto border-r border-line-subtle p-4">
          <SectionLabel>{t("teamManagement:teamPanel.sectionLabel")}</SectionLabel>
          <div className="mb-3 mt-1 space-y-0.5">
            {teams.length === 0 && <p className="text-xs text-fg-faint">{t("teamManagement:teamPanel.noTeams")}</p>}
            {teams.map((team) => (
              <button
                key={team.id}
                type="button"
                onClick={() => handleSelectTeam(team.id)}
                className={`focus-ring block w-full truncate rounded-md px-2.5 py-2 text-left text-xs transition ${
                  team.id === selectedTeamId ? "bg-surface-2 text-fg" : "text-fg-muted hover:bg-surface"
                }`}
              >
                {team.name}
                <span className="ml-1 text-fg-faint">({team.members.length})</span>
              </button>
            ))}
          </div>
          <div className="space-y-1.5 border-t border-line-subtle pt-2">
            <Input value={newTeamName} onChange={(e) => setNewTeamName(e.target.value)} placeholder={t("teamManagement:teamPanel.newTeamNamePlaceholder")} />
            <Input
              mono
              value={newTeamWorkingDir}
              onChange={(e) => setNewTeamWorkingDir(e.target.value)}
              placeholder={t("teamManagement:teamPanel.newTeamWorkingDirPlaceholder")}
            />
            <Button variant="primary" size="sm" icon="plus" block loading={creatingTeam} onClick={() => void handleCreateTeam()}>
              {creatingTeam ? t("teamManagement:teamPanel.creating") : t("teamManagement:teamPanel.createTeam")}
            </Button>
          </div>
        </div>

        {/* ---- 右側:成員清單 + 加入成員 ---- */}
        <div className="flex min-h-0 flex-1 flex-col p-4">
          {!selectedTeam ? (
            <EmptyState icon="users" title={t("teamManagement:memberPanel.emptyTitle")} compact />
          ) : (
            <>
              <div className="flex items-center justify-between">
                <SectionLabel>{t("teamManagement:memberPanel.sectionLabel", { count: selectedTeam.members.length })}</SectionLabel>
                <button
                  type="button"
                  onClick={() => {
                    setDeleteSummary(null);
                    setConfirmingDelete(true);
                  }}
                  className="focus-ring rounded px-1.5 py-0.5 text-2xs text-fg-faint transition hover:text-danger"
                >
                  {t("teamManagement:deleteTeam.button")}
                </button>
              </div>
              <div className="mb-3 mt-1 flex-1 space-y-1.5 overflow-y-auto">
                {selectedTeam.members.length === 0 && <p className="text-xs text-fg-faint">{t("teamManagement:memberPanel.noMembers")}</p>}
                {selectedTeam.members.map((member) => {
                  const teammate = teammates.find((tm) => tm.memberId === member.id);
                  const profile = profiles.find((p) => p.id === member.agentProfileId);
                  const meta = teammate?.hasActiveSession ? sessionStatusMeta(teammate.status) : offlineStatus();
                  const contextUnsupported =
                    member.lifecycle === "persistent" &&
                    (() => {
                      const effectiveSoftware = profile?.software ?? teammate?.software;
                      const support = effectiveSoftware ? capabilitiesBySoftware[effectiveSoftware]?.contextReporting : undefined;
                      return support !== "supported";
                    })();
                  return (
                    <div key={member.id} className="rounded-md bg-surface px-3 py-2.5 text-xs">
                      <div className="flex items-center gap-2">
                        <StatusDot meta={meta} />
                        <span className="font-medium text-fg">{member.name}</span>
                        <span className="text-fg-faint">· {member.role}</span>
                        {member.canInterrupt && <Badge tone="warn">{t("teamManagement:memberPanel.canInterruptBadge")}</Badge>}
                        <Badge
                          tone={member.lifecycle === "persistent" ? "accent" : "neutral"}
                          title={t("teamManagement:lifecycleHint")}
                        >
                          {lifecycleLabel(member.lifecycle, t)}
                        </Badge>
                        <Badge mono className="ml-auto">
                          {softwareLabel(teammate?.software ?? profile?.software)}
                        </Badge>
                      </div>
                      {contextUnsupported && (
                        <Badge
                          tone="warn"
                          icon="alert"
                          className="mt-1 ml-3.5"
                          title={t("teamManagement:memberPanel.contextUnsupportedTitle")}
                        >
                          {t("teamManagement:memberPanel.contextUnsupportedBadge")}
                        </Badge>
                      )}
                      <div className="mt-1 flex items-center justify-between pl-3.5 text-2xs text-fg-faint">
                        <span>{teammate?.hasActiveSession ? meta.label : t("teamManagement:memberPanel.noSession")}</span>
                        <div className="flex gap-2">
                          {!teammate?.hasActiveSession && (
                            <button type="button" onClick={() => void handleCreateMemberSession(member.id, member.agentProfileId)} className="text-accent hover:underline">
                              {t("teamManagement:memberPanel.createSession")}
                            </button>
                          )}
                          <button type="button" onClick={() => void handleRemoveMember(member.id)} className="hover:text-danger">
                            {t("teamManagement:memberPanel.remove")}
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="space-y-1.5 border-t border-line-subtle pt-2">
                <SectionLabel>{t("teamManagement:addMember.sectionLabel")}</SectionLabel>
                <Select value={memberProfileId} onChange={(e) => setMemberProfileId(e.target.value)}>
                  {profiles.length === 0 && <option value="">{t("teamManagement:addMember.noProfileOption")}</option>}
                  {profiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}({softwareLabel(p.software)})
                    </option>
                  ))}
                </Select>
                <div className="flex gap-1.5">
                  <Input
                    value={memberName}
                    onChange={(e) => setMemberName(e.target.value)}
                    placeholder={t("teamManagement:addMember.namePlaceholder")}
                    className="w-1/2"
                  />
                  <Input value={memberRole} onChange={(e) => setMemberRole(e.target.value)} placeholder={t("teamManagement:addMember.rolePlaceholder")} className="w-1/2" />
                </div>
                <Checkbox checked={memberCanInterrupt} onChange={(e) => setMemberCanInterrupt(e.target.checked)} label={t("teamManagement:addMember.canInterruptLabel")} />
                <div className="flex items-center gap-1.5">
                  <Select value={memberLifecycle} onChange={(e) => setMemberLifecycle(e.target.value as "" | Lifecycle)} className="w-auto">
                    <option value="">{t("teamManagement:addMember.autoLifecycleOption")}</option>
                    <option value="persistent">{lifecycleLabel("persistent", t)}</option>
                    <option value="ephemeral">{lifecycleLabel("ephemeral", t)}</option>
                  </Select>
                  {memberLifecycle === "" && derivedLifecyclePreview && (
                    <span className="text-2xs text-fg-faint">
                      {t("teamManagement:addMember.derivedPreview", { label: lifecycleLabel(derivedLifecyclePreview, t) })}
                    </span>
                  )}
                </div>
                <Button variant="outline" size="sm" block loading={addingMember} disabled={!profiles.length} onClick={() => void handleAddMember()}>
                  {addingMember ? t("teamManagement:addMember.adding") : t("teamManagement:addMember.submit")}
                </Button>
              </div>
            </>
          )}

          {error && <Alert tone="danger" className="mt-2">{error}</Alert>}
          {deleteSummary && <Alert tone="warn" className="mt-2">{deleteSummary}</Alert>}
        </div>
      </div>

      {confirmingDelete && selectedTeam && (
        <DeleteTeamConfirmDialog
          teamName={selectedTeam.name}
          memberCount={selectedTeam.members.length}
          deleting={deletingTeam}
          onCancel={() => setConfirmingDelete(false)}
          onConfirm={() => void handleDeleteTeam()}
        />
      )}
    </Dialog>
  );
}

/**
 * 刪除團隊的確認對話框。比照 `AutoModeControl.tsx` 的 `YoloConfirmDialog`:
 * danger tone、不可用 Esc/點遮罩關閉(`dismissible={false}`)、**取消為預設焦點**
 * ——這是不可復原的操作,預設不應該落在確認鈕上。
 *
 * 刻意把「會連帶消失什麼」逐條列出而不是只寫「確定刪除嗎?」:這個操作會中止
 * 正在跑的 agent、移除任務的 git worktree(含未提交的變更),使用者按下去之前
 * 有權知道代價。
 */
function DeleteTeamConfirmDialog({
  teamName,
  memberCount,
  deleting,
  onCancel,
  onConfirm,
}: {
  teamName: string;
  memberCount: number;
  deleting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}): JSX.Element {
  const { t } = useTranslation(["teamManagement", "common"]);
  return (
    <Dialog
      title={t("teamManagement:deleteTeam.confirmTitle", { name: teamName })}
      icon="alert"
      tone="danger"
      size="sm"
      dismissible={false}
      onClose={onCancel}
      footer={
        <div className="flex w-full justify-end gap-2">
          <Button variant="secondary" autoFocus disabled={deleting} onClick={onCancel}>
            {t("common:cancel")}
          </Button>
          <Button variant="danger" loading={deleting} onClick={onConfirm}>
            {deleting ? t("teamManagement:deleteTeam.deleting") : t("teamManagement:deleteTeam.confirmButton")}
          </Button>
        </div>
      }
    >
      <ul className="space-y-1.5 text-xs leading-relaxed text-fg-soft">
        <li>{t("teamManagement:deleteTeam.warnMembers", { count: memberCount })}</li>
        <li>{t("teamManagement:deleteTeam.warnSessions")}</li>
        <li className="text-danger">{t("teamManagement:deleteTeam.warnTasks")}</li>
        <li>{t("teamManagement:deleteTeam.warnMessages")}</li>
      </ul>
    </Dialog>
  );
}
