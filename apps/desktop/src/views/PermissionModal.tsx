import { useMemo, useState } from "react";
import type { PolicyRule } from "@deskmony/shared";
import { useSessionStore } from "../stores/session-store.js";
import { Dialog } from "../ui/Dialog.js";
import { Button } from "../ui/Button.js";
import { Badge } from "../ui/Badge.js";
import { Icon } from "../ui/icons.js";

/**
 * 權限請求彈窗:一次只顯示佇列中最早的一筆,其餘排隊等待。
 *
 * 三種樣式共用同一個 `Dialog` 骨架:
 *   1. 一般 escalate(`strong === false`):現況樣式,多一個「永遠允許…」
 *      按鈕,點下展開範圍選擇區塊(預設選最窄的候選)。
 *   2. escalate-strong(`strong === true`):`Dialog` 的 `tone="danger"`,
 *      **不得**出現「永遠允許」(C4 紀律③)——只有拒絕(預設焦點)/仍要允許
 *      (需二次點擊確認)。
 *   3. YOLO 啟用確認——獨立對話框(見 views/AutoModeControl.tsx)。
 *
 * `dismissible={false}`:這是一個必須做出決定的請求,Esc/點遮罩都不該讓它
 * 消失又沒有回應——那會讓 agent 卡住等一個使用者以為已經處理掉的請求。
 */

const COMMAND_KEYS = ["command", "cmd", "script"];
const PATH_KEYS = ["file_path", "filePath", "path", "notebook_path", "directory", "dir_path", "target_path"];

function asRecord(input: unknown): Record<string, unknown> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  return input as Record<string, unknown>;
}

function extractCommand(input: unknown): string | undefined {
  const obj = asRecord(input);
  if (!obj) return undefined;
  for (const key of COMMAND_KEYS) {
    const value = obj[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function extractPath(input: unknown): string | undefined {
  const obj = asRecord(input);
  if (!obj) return undefined;
  for (const key of PATH_KEYS) {
    const value = obj[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function dirnameOf(p: string): string {
  const normalized = p.replace(/\\/g, "/").replace(/\/+$/, "");
  const idx = normalized.lastIndexOf("/");
  if (idx <= 0) return normalized.startsWith("/") ? "/" : normalized;
  return normalized.slice(0, idx);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface RememberCandidate {
  label: string;
  description: string;
  rule: PolicyRule;
}

function buildRememberCandidates(toolName: string, input: unknown, workingDir: string | undefined): RememberCandidate[] {
  const command = extractCommand(input);
  if (command !== undefined) {
    const candidates: RememberCandidate[] = [
      {
        label: "只允許這個確切指令(最窄,建議)",
        description: `工具「${toolName}」且指令完全等於:${command}`,
        rule: { tool: toolName, when: { commandEquals: command }, effect: "allow" },
      },
    ];
    const firstWord = command.trim().split(/\s+/)[0];
    if (firstWord) {
      candidates.push({
        label: `允許所有以「${firstWord}」開頭的指令(較寬)`,
        description: `工具「${toolName}」且指令符合:^${firstWord}\\b.*`,
        rule: { tool: toolName, when: { commandMatches: `^${escapeRegExp(firstWord)}\\b.*` }, effect: "allow" },
      });
    }
    return candidates;
  }

  const path = extractPath(input);
  if (path !== undefined) {
    const dir = dirnameOf(path);
    const candidates: RememberCandidate[] = [
      {
        label: "只允許這個目錄下的檔案(最窄,建議)",
        description: `工具「${toolName}」且路徑位於:${dir}`,
        rule: { tool: toolName, when: { pathUnder: dir }, effect: "allow" },
      },
    ];
    if (workingDir && workingDir !== dir) {
      candidates.push({
        label: "允許整個 worktree 下的檔案(較寬)",
        description: `工具「${toolName}」且路徑位於:${workingDir}`,
        rule: { tool: toolName, when: { pathUnder: workingDir }, effect: "allow" },
      });
    }
    return candidates;
  }

  return [
    {
      label: "只允許這個工具(精確比對)",
      description: `工具精確等於:${toolName}`,
      rule: { tool: toolName, effect: "allow" },
    },
  ];
}

function RememberRuleSection({
  toolName,
  input,
  workingDir,
  onConfirm,
  onCancel,
}: {
  toolName: string;
  input: unknown;
  workingDir: string | undefined;
  onConfirm: (rule: PolicyRule) => void;
  onCancel: () => void;
}): JSX.Element {
  const candidates = useMemo(() => buildRememberCandidates(toolName, input, workingDir), [toolName, input, workingDir]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const selected = candidates[selectedIdx];

  return (
    <div className="mt-3 space-y-2 rounded-md border border-accent/30 bg-accent/[0.05] px-3 py-2.5">
      <p className="text-xs font-medium text-fg">選擇要記住的範圍(預設選最窄):</p>
      {candidates.map((c, idx) => (
        <label key={c.label} className="flex cursor-pointer items-start gap-2 text-xs text-fg-soft">
          <input
            type="radio"
            name="remember-scope"
            className="mt-0.5 accent-accent"
            checked={selectedIdx === idx}
            onChange={() => setSelectedIdx(idx)}
          />
          <span>{c.label}</span>
        </label>
      ))}
      {selected && (
        <p className="rounded bg-canvas px-2 py-1.5 text-2xs text-fg-muted">
          你將永遠允許:<span className="text-fg-soft">{selected.description}</span>
        </p>
      )}
      <p className="text-2xs text-fg-faint">寫入後立即生效(不需重啟),之後可在設定裡的政策規則移除。</p>
      <div className="flex justify-end gap-2 pt-1">
        <Button variant="secondary" size="sm" onClick={onCancel}>
          取消
        </Button>
        <Button variant="primary" size="sm" onClick={() => selected && onConfirm(selected.rule)}>
          確認永遠允許
        </Button>
      </div>
    </div>
  );
}

export function PermissionModal(): JSX.Element | null {
  const pendingPermissions = useSessionStore((s) => s.pendingPermissions);
  const resolvePermission = useSessionStore((s) => s.resolvePermission);
  const sessions = useSessionStore((s) => s.sessions);
  const [showRemember, setShowRemember] = useState(false);
  const [strongConfirmArmed, setStrongConfirmArmed] = useState(false);

  const current = pendingPermissions[0];
  if (!current) return null;

  const session = sessions.find((s) => s.id === current.sessionId);
  const strong = current.strong === true;

  const resetLocalState = (): void => {
    setShowRemember(false);
    setStrongConfirmArmed(false);
  };

  const handleDeny = (): void => {
    resetLocalState();
    resolvePermission(current.requestId, "deny");
  };
  const handleAllow = (rememberRule?: PolicyRule): void => {
    resetLocalState();
    resolvePermission(current.requestId, "allow", rememberRule);
  };

  return (
    <Dialog
      title={strong ? "此操作屬於硬性禁止項" : "Agent 請求執行權限"}
      description={
        strong
          ? "這類操作預設一律拒絕,即使目前是本機、有人盯著也僅能個別強制確認——無法設為永遠允許。"
          : (session?.title ?? current.sessionId)
      }
      icon={strong ? "shield" : "zap"}
      tone={strong ? "danger" : "default"}
      size="sm"
      dismissible={false}
      footer={
        strong ? (
          <div className="flex w-full flex-col gap-2">
            <Button variant="danger" block autoFocus onClick={handleDeny}>
              拒絕(建議)
            </Button>
            {!strongConfirmArmed ? (
              <Button variant="ghost" size="xs" block onClick={() => setStrongConfirmArmed(true)}>
                我了解風險,仍要允許…
              </Button>
            ) : (
              <Button variant="outline" size="xs" block className="!border-danger/50 !text-danger" onClick={() => handleAllow(undefined)}>
                再次點擊確認:仍要允許此次操作
              </Button>
            )}
          </div>
        ) : (
          <div className="flex w-full justify-end gap-2">
            <Button variant="outline" onClick={handleDeny} className="hover:!border-danger hover:!text-danger">
              拒絕
            </Button>
            {!showRemember && (
              <Button variant="outline" onClick={() => setShowRemember(true)}>
                永遠允許…
              </Button>
            )}
            <Button variant="primary" onClick={() => handleAllow(undefined)}>
              允許
            </Button>
          </div>
        )
      }
    >
      <div className="rounded-md bg-surface px-3 py-2">
        <div className="text-2xs text-fg-faint">工具</div>
        <div className="font-mono text-sm text-accent">{current.toolName}</div>
      </div>
      {current.description && <p className="mt-2 text-sm text-fg-soft">{current.description}</p>}
      {current.input !== undefined && (
        <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md bg-canvas px-3 py-2 font-mono text-2xs text-fg-muted">
          {JSON.stringify(current.input, null, 2)}
        </pre>
      )}
      {pendingPermissions.length > 1 && (
        <p className="mt-2 flex items-center gap-1 text-2xs text-fg-faint">
          <Icon name="clock" size={11} />
          還有 {pendingPermissions.length - 1} 筆請求排隊中
        </p>
      )}
      {!strong && showRemember && (
        <RememberRuleSection
          toolName={current.toolName}
          input={current.input}
          workingDir={session?.workingDir}
          onConfirm={(rule) => handleAllow(rule)}
          onCancel={() => setShowRemember(false)}
        />
      )}
      {strong && (
        <Badge tone="danger" icon="alert" className="mt-2">
          worktree 外寫入、讀取密鑰路徑、force-push 等操作一律列為硬性禁止
        </Badge>
      )}
    </Dialog>
  );
}
