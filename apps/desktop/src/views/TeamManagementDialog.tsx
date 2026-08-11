import { useEffect, useState } from "react";
import { deriveLifecycleFromRole, type Lifecycle } from "@deskmony/shared";
import { useSessionStore } from "../stores/session-store.js";
import { useTeamStore } from "../stores/team-store.js";
import { Dialog } from "../ui/Dialog.js";
import { Button } from "../ui/Button.js";
import { Input, Select, Checkbox } from "../ui/Field.js";
import { Badge, StatusDot, SectionLabel } from "../ui/Badge.js";
import { Alert, EmptyState } from "../ui/Feedback.js";
import { sessionStatusMeta, softwareLabel, OFFLINE_STATUS } from "../ui/status.js";

/** S8(agent-lifecycle):"" = 自動(依角色推導,見 deriveLifecycleFromRole())。 */
const lifecycleLabel: Record<Lifecycle, string> = {
  persistent: "長命(persistent)",
  ephemeral: "短命(ephemeral)",
};

interface TeamManagementDialogProps {
  onClose: () => void;
}

/**
 * 「團隊管理」對話框:建立團隊、加入/移除成員、顯示成員清單與其目前 session
 * 狀態。改版只換了外殼與狀態語彙(統一走 `ui/status.ts`),資料流與既有邏輯
 * 完全不變。
 */
export function TeamManagementDialog({ onClose }: TeamManagementDialogProps): JSX.Element {
  const teams = useTeamStore((s) => s.teams);
  const currentTeamId = useTeamStore((s) => s.currentTeamId);
  const teammatesByTeam = useTeamStore((s) => s.teammatesByTeam);
  const createTeam = useTeamStore((s) => s.createTeam);
  const addMember = useTeamStore((s) => s.addMember);
  const removeMember = useTeamStore((s) => s.removeMember);
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

  useEffect(() => {
    if (!selectedTeamId && teams.length > 0) setSelectedTeamId(teams[0].id);
  }, [teams, selectedTeamId]);

  useEffect(() => {
    if (profiles.length > 0 && !memberProfileId) setMemberProfileId(profiles[0].id);
  }, [profiles, memberProfileId]);

  const selectedTeam = teams.find((t) => t.id === selectedTeamId);
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
      setError("請輸入團隊名稱");
      return;
    }
    setCreatingTeam(true);
    try {
      await createTeam({ name: newTeamName.trim(), workingDir: newTeamWorkingDir.trim() || undefined });
      setNewTeamName("");
      setNewTeamWorkingDir("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreatingTeam(false);
    }
  };

  const handleAddMember = async (): Promise<void> => {
    setError(null);
    if (!selectedTeamId) {
      setError("請先選擇一個團隊");
      return;
    }
    if (!memberProfileId) {
      setError("請選擇一個 Agent Profile");
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
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAddingMember(false);
    }
  };

  const handleRemoveMember = async (memberId: string): Promise<void> => {
    if (!selectedTeamId) return;
    try {
      await removeMember(selectedTeamId, memberId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleCreateMemberSession = async (memberId: string, agentProfileId: string): Promise<void> => {
    const profile = profiles.find((p) => p.id === agentProfileId);
    const workingDir = selectedTeam?.workingDir || profile?.workingDir;
    if (!workingDir) {
      setError("找不到可用的工作目錄,請確認團隊或 Profile 有設定 workingDir");
      return;
    }
    try {
      await createSession(agentProfileId, workingDir, undefined, memberId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Dialog title="團隊管理" description="建立團隊、加入/移除成員、檢視成員 session 狀態" icon="users" size="xl" onClose={onClose} bare>
      <div className="flex h-[68vh] min-h-0 max-h-full">
        {/* ---- 左側:team 清單 + 建立 team ---- */}
        <div className="w-52 flex-shrink-0 overflow-y-auto border-r border-line-subtle p-3">
          <SectionLabel>團隊</SectionLabel>
          <div className="mb-3 mt-1 space-y-0.5">
            {teams.length === 0 && <p className="text-xs text-fg-faint">尚無團隊</p>}
            {teams.map((team) => (
              <button
                key={team.id}
                type="button"
                onClick={() => handleSelectTeam(team.id)}
                className={`focus-ring block w-full truncate rounded-md px-2 py-1.5 text-left text-xs transition ${
                  team.id === selectedTeamId ? "bg-surface-2 text-fg" : "text-fg-muted hover:bg-surface"
                }`}
              >
                {team.name}
                <span className="ml-1 text-fg-faint">({team.members.length})</span>
              </button>
            ))}
          </div>
          <div className="space-y-1.5 border-t border-line-subtle pt-2">
            <Input value={newTeamName} onChange={(e) => setNewTeamName(e.target.value)} placeholder="新團隊名稱" />
            <Input mono value={newTeamWorkingDir} onChange={(e) => setNewTeamWorkingDir(e.target.value)} placeholder="工作目錄(選填)" />
            <Button variant="primary" size="sm" icon="plus" block loading={creatingTeam} onClick={() => void handleCreateTeam()}>
              {creatingTeam ? "建立中…" : "建立團隊"}
            </Button>
          </div>
        </div>

        {/* ---- 右側:成員清單 + 加入成員 ---- */}
        <div className="flex min-h-0 flex-1 flex-col p-3">
          {!selectedTeam ? (
            <EmptyState icon="users" title="請先在左側選擇或建立一個團隊" compact />
          ) : (
            <>
              <SectionLabel>成員({selectedTeam.members.length})</SectionLabel>
              <div className="mb-3 mt-1 flex-1 space-y-1.5 overflow-y-auto">
                {selectedTeam.members.length === 0 && <p className="text-xs text-fg-faint">尚無成員</p>}
                {selectedTeam.members.map((member) => {
                  const teammate = teammates.find((t) => t.memberId === member.id);
                  const profile = profiles.find((p) => p.id === member.agentProfileId);
                  const meta = teammate?.hasActiveSession ? sessionStatusMeta(teammate.status) : OFFLINE_STATUS;
                  const contextUnsupported =
                    member.lifecycle === "persistent" &&
                    (() => {
                      const effectiveSoftware = profile?.software ?? teammate?.software;
                      const support = effectiveSoftware ? capabilitiesBySoftware[effectiveSoftware]?.contextReporting : undefined;
                      return support !== "supported";
                    })();
                  return (
                    <div key={member.id} className="rounded-md bg-surface px-3 py-2 text-xs">
                      <div className="flex items-center gap-2">
                        <StatusDot meta={meta} />
                        <span className="font-medium text-fg">{member.name}</span>
                        <span className="text-fg-faint">· {member.role}</span>
                        {member.canInterrupt && <Badge tone="warn">可中斷</Badge>}
                        <Badge
                          tone={member.lifecycle === "persistent" ? "accent" : "neutral"}
                          title="S8:長命(persistent)= 為了在線可達,由人/團隊啟動時建立;短命(ephemeral)= 指派任務時自動建立、任務完成自動釋放"
                        >
                          {lifecycleLabel[member.lifecycle]}
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
                          title="此後端無法自動偵測 context 上限——這個長命成員的 session 不會自動 checkpoint 重啟,context 撐爆前需要人工手動重啟(dispose + 重新建立 session)。"
                        >
                          此後端無法自動偵測 context 上限,需手動重啟
                        </Badge>
                      )}
                      <div className="mt-1 flex items-center justify-between pl-3.5 text-2xs text-fg-faint">
                        <span>{teammate?.hasActiveSession ? meta.label : "尚無 session"}</span>
                        <div className="flex gap-2">
                          {!teammate?.hasActiveSession && (
                            <button type="button" onClick={() => void handleCreateMemberSession(member.id, member.agentProfileId)} className="text-accent hover:underline">
                              建立 session
                            </button>
                          )}
                          <button type="button" onClick={() => void handleRemoveMember(member.id)} className="hover:text-danger">
                            移除
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="space-y-1.5 border-t border-line-subtle pt-2">
                <SectionLabel>加入成員</SectionLabel>
                <Select value={memberProfileId} onChange={(e) => setMemberProfileId(e.target.value)}>
                  {profiles.length === 0 && <option value="">(尚無 Profile)</option>}
                  {profiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}({softwareLabel(p.software)})
                    </option>
                  ))}
                </Select>
                <div className="flex gap-1.5">
                  <Input value={memberName} onChange={(e) => setMemberName(e.target.value)} placeholder="顯示名稱(選填,預設沿用 profile)" className="w-1/2" />
                  <Input value={memberRole} onChange={(e) => setMemberRole(e.target.value)} placeholder="角色(選填)" className="w-1/2" />
                </div>
                <Checkbox checked={memberCanInterrupt} onChange={(e) => setMemberCanInterrupt(e.target.checked)} label="可中斷隊友(canInterrupt)" />
                <div className="flex items-center gap-1.5">
                  <Select value={memberLifecycle} onChange={(e) => setMemberLifecycle(e.target.value as "" | Lifecycle)} className="w-auto">
                    <option value="">自動(依角色推導)</option>
                    <option value="persistent">長命(persistent)</option>
                    <option value="ephemeral">短命(ephemeral)</option>
                  </Select>
                  {memberLifecycle === "" && derivedLifecyclePreview && (
                    <span className="text-2xs text-fg-faint">→ 將推導為「{lifecycleLabel[derivedLifecyclePreview]}」</span>
                  )}
                </div>
                <Button variant="outline" size="sm" block loading={addingMember} disabled={!profiles.length} onClick={() => void handleAddMember()}>
                  {addingMember ? "加入中…" : "+ 加入成員"}
                </Button>
              </div>
            </>
          )}

          {error && <Alert tone="danger" className="mt-2">{error}</Alert>}
        </div>
      </div>
    </Dialog>
  );
}
