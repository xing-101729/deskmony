import { useEffect, useMemo, useRef, useState } from "react";
import type { MessagePriority, TeamMessage } from "@deskmony/shared";
import { useTeamStore } from "../stores/team-store.js";
import { TeamManagementDialog } from "./TeamManagementDialog.js";
import { IconButton, Button } from "../ui/Button.js";
import { Select } from "../ui/Field.js";
import { Badge, StatusDot } from "../ui/Badge.js";
import { EmptyState } from "../ui/Feedback.js";
import { sessionStatusMeta, OFFLINE_STATUS } from "../ui/status.js";

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("zh-TW", { hour12: false });
}

/**
 * S2(message-budget):`contextId` 的簡短顯示形式——task id 通常是 UUID,群聊
 * 視圖只需要一眼能分辨「這幾則訊息屬於同一個 context」,不需要完整 id。
 * `"legacy"` 不顯示這個標籤。
 */
function shortContextId(contextId: string): string {
  return contextId.slice(0, 8);
}

/** 一則群聊訊息的顯示氣泡:依 source(human/agent)區分視覺,interrupt/降級訊息額外標示。 */
function MessageBubble({
  message,
  budget,
}: {
  message: TeamMessage;
  budget?: { count: number; max: number; tripped: boolean };
}): JSX.Element {
  const isHuman = message.source === "human";
  const isBroadcast = message.to === "broadcast";
  const isInterrupt = message.priority === "interrupt";
  const isDowngraded = Boolean(message.note);
  const showContext = message.contextId !== "legacy";

  return (
    <div className={`my-1 flex ${isHuman ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[78%] rounded-lg px-3 py-2 text-sm leading-relaxed ${
          isHuman ? "bg-accent/15 text-fg" : "bg-surface text-fg"
        } ${isInterrupt && !isDowngraded ? "ring-1 ring-danger/60" : ""}`}
      >
        <div className="mb-1 flex flex-wrap items-center gap-1.5 text-2xs text-fg-faint">
          <span className={`h-1.5 w-1.5 rounded-full ${isHuman ? "bg-accent" : "bg-ok"}`} />
          <span className="font-medium text-fg-soft">{message.from}</span>
          {message.fromRole && <span>({message.fromRole})</span>}
          <span>→</span>
          <span className="text-fg-muted">{isBroadcast ? "全體(廣播)" : message.to}</span>
          {isInterrupt && !isDowngraded && (
            <Badge tone="danger" className="uppercase">
              interrupt
            </Badge>
          )}
          {isDowngraded && <Badge tone="warn">已降級</Badge>}
          {showContext && (
            <Badge
              tone={budget?.tripped ? "danger" : "neutral"}
              mono
              title={`context: ${message.contextId}${budget ? `(訊息額度 ${budget.count}/${budget.max}${budget.tripped ? "，已熔斷" : ""})` : ""}`}
            >
              #{shortContextId(message.contextId)}
              {budget && ` ${budget.count}/${budget.max}`}
            </Badge>
          )}
          <span className="ml-auto tabular">{formatTime(message.timestamp)}</span>
        </div>
        <div className="whitespace-pre-wrap break-words">{message.content}</div>
        {message.note && <div className="mt-1 text-2xs text-warn">[系統標註] {message.note}</div>}
      </div>
    </div>
  );
}

/**
 * TeamChatView(M3 Round B,任務 2 核心):訂閱 "team-message" 推播即時顯示
 * 整個 team 的訊息流,人類可插話(走 message.send)。
 *
 * 無 team 時給空狀態引導建立;有 team 但尚未選取時列出清單讓使用者選。
 */
export function TeamChatView({ onOpenSidebar }: { onOpenSidebar: () => void }): JSX.Element {
  const teams = useTeamStore((s) => s.teams);
  const currentTeamId = useTeamStore((s) => s.currentTeamId);
  const messagesByTeam = useTeamStore((s) => s.messagesByTeam);
  const teammatesByTeam = useTeamStore((s) => s.teammatesByTeam);
  const contextBudgets = useTeamStore((s) => s.contextBudgets);
  const selectTeam = useTeamStore((s) => s.selectTeam);
  const sendTeamMessage = useTeamStore((s) => s.sendTeamMessage);
  const refreshContextBudget = useTeamStore((s) => s.refreshContextBudget);

  const [managementOpen, setManagementOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [to, setTo] = useState<string>("broadcast");
  const [priority, setPriority] = useState<MessagePriority>("normal");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const team = teams.find((t) => t.id === currentTeamId);
  const messages = useMemo(
    () => (currentTeamId ? (messagesByTeam[currentTeamId] ?? []) : []),
    [currentTeamId, messagesByTeam],
  );
  const teammates = currentTeamId ? (teammatesByTeam[currentTeamId] ?? []) : [];

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  // S2(message-budget):訊息列表出現新的 contextId 時,查一次目前的額度用量。
  useEffect(() => {
    const distinctContextIds = new Set(messages.map((m) => m.contextId).filter((id) => id !== "legacy"));
    for (const contextId of distinctContextIds) {
      void refreshContextBudget(contextId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);

  useEffect(() => {
    if (to !== "broadcast" && team && !team.members.some((m) => m.name === to)) {
      setTo("broadcast");
    }
  }, [team, to]);

  const handleSend = async (): Promise<void> => {
    const content = draft.trim();
    if (!content || !currentTeamId) return;
    setSending(true);
    setError(null);
    try {
      await sendTeamMessage({ teamId: currentTeamId, to, content, priority });
      setDraft("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  if (teams.length === 0) {
    return (
      <main className="flex h-full flex-1 flex-col bg-canvas">
        <MobileBar onOpenSidebar={onOpenSidebar} />
        <EmptyState
          icon="users"
          title="尚未建立任何團隊"
          description="團隊群聊視圖需要先建立一個團隊、加入至少一位成員,才能觀察 agent 互傳訊息或插話。"
          action={
            <Button variant="primary" icon="plus" onClick={() => setManagementOpen(true)}>
              建立團隊
            </Button>
          }
        />
        {managementOpen && <TeamManagementDialog onClose={() => setManagementOpen(false)} />}
      </main>
    );
  }

  if (!team) {
    return (
      <main className="flex h-full flex-1 flex-col bg-canvas">
        <MobileBar onOpenSidebar={onOpenSidebar} />
        <EmptyState
          icon="users"
          title="請選擇一個團隊"
          action={
            <div className="flex flex-wrap justify-center gap-2">
              {teams.map((t) => (
                <Button key={t.id} variant="outline" onClick={() => void selectTeam(t.id)}>
                  {t.name}
                  <span className="ml-1 text-fg-faint">({t.members.length})</span>
                </Button>
              ))}
            </div>
          }
        />
      </main>
    );
  }

  return (
    <main className="flex h-full flex-1 flex-col bg-canvas">
      <header className="flex flex-shrink-0 flex-wrap items-start justify-between gap-2 border-b border-line-subtle px-3 py-2 sm:px-4">
        <div className="flex min-w-0 items-start gap-2">
          <IconButton icon="menu" aria-label="開啟側欄" onClick={onOpenSidebar} className="mt-0.5 sm:hidden" />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-sm font-semibold text-fg">{team.name}</h1>
              <Select aria-label="切換團隊" value={team.id} onChange={(e) => void selectTeam(e.target.value)} className="!h-6 !text-2xs">
                {teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              {team.members.map((member) => {
                const teammate = teammates.find((tm) => tm.memberId === member.id);
                const meta = teammate?.hasActiveSession ? sessionStatusMeta(teammate.status) : OFFLINE_STATUS;
                return (
                  <span key={member.id} className="flex items-center gap-1 rounded bg-surface px-1.5 py-0.5 text-2xs text-fg-muted">
                    <StatusDot meta={meta} />
                    {member.name}
                  </span>
                );
              })}
            </div>
          </div>
        </div>
        <Button variant="outline" size="sm" icon="users" onClick={() => setManagementOpen(true)}>
          團隊管理
        </Button>
      </header>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-3 sm:px-4">
        {messages.length === 0 && (
          <p className="mt-6 text-center text-xs text-fg-faint">
            尚無訊息 —— agent 之間互傳的訊息、以及你的插話都會顯示在這裡
          </p>
        )}
        {messages.map((message) => (
          <MessageBubble key={message.id} message={message} budget={contextBudgets[message.contextId]} />
        ))}
      </div>

      <div className="flex-shrink-0 border-t border-line-subtle p-2.5 sm:p-3">
        {error && <div className="mb-2 rounded-md bg-danger/10 px-2.5 py-1.5 text-xs text-danger">{error}</div>}
        <div className="flex items-end gap-2 rounded-lg border border-line bg-surface p-1.5 focus-within:border-accent/60 focus-within:ring-2 focus-within:ring-accent/20">
          <div className="flex flex-shrink-0 flex-col gap-1">
            <Select aria-label="收件對象" value={to} onChange={(e) => setTo(e.target.value)}>
              <option value="broadcast">[廣播] 全體</option>
              {team.members.map((member) => (
                <option key={member.id} value={member.name}>
                  @{member.name}
                </option>
              ))}
            </Select>
            <Select aria-label="優先度" value={priority} onChange={(e) => setPriority(e.target.value as MessagePriority)}>
              <option value="normal">一般</option>
              <option value="interrupt">中斷(interrupt)</option>
            </Select>
          </div>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void handleSend();
              }
            }}
            rows={2}
            placeholder="以人類身分插話…(Enter 送出,Shift+Enter 換行)"
            className="flex-1 resize-none bg-transparent px-2 py-1 text-sm text-fg outline-none placeholder:text-fg-faint"
          />
          <IconButton icon="play" aria-label="送出" variant="primary" size="md" disabled={!draft.trim() || sending} onClick={() => void handleSend()} />
        </div>
      </div>

      {managementOpen && <TeamManagementDialog onClose={() => setManagementOpen(false)} />}
    </main>
  );
}

function MobileBar({ onOpenSidebar }: { onOpenSidebar: () => void }): JSX.Element {
  return (
    <div className="flex flex-shrink-0 items-center border-b border-line-subtle px-2 py-1.5 sm:hidden">
      <IconButton icon="menu" aria-label="開啟側欄" onClick={onOpenSidebar} />
    </div>
  );
}
