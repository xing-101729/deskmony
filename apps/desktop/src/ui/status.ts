import type { TaskStatus } from "@deskmony/shared";
import type { IconName } from "./icons.js";

/**
 * 狀態語彙的**單一來源**。
 *
 * 改版前,`statusLabel` / `statusColor` / `softwareBadge` 這三張表在
 * SessionList.tsx、TeamChatView.tsx、TeamManagementDialog.tsx 各複製了一份
 * (內容目前剛好一致,但沒有任何機制保證——任何一處加狀態就會漂移)。集中在
 * 這裡之後,「agent 狀態長什麼樣」全 app 只有一個定義。
 *
 * 每個狀態都給三種可辨識訊號,而不是只有顏色(色盲友善、也讓縮小的側欄仍
 * 可讀):**顏色 + 文字 + 動態(執行中/等待中會呼吸)**。
 */

export type SessionStatusKey = "idle" | "busy" | "waiting" | "error";

export interface StatusMeta {
  /** 中文標籤(列表/標頭顯示) */
  label: string;
  /** 圓點的 class(含深淺主題自動適配的語意色) */
  dot: string;
  /** 文字色 */
  fg: string;
  /** 徽章底色(低飽和 tint,不是大色塊) */
  chip: string;
  /** 是否需要「還在動」的呼吸提示 */
  live: boolean;
}

const SESSION_STATUS: Record<SessionStatusKey, StatusMeta> = {
  idle: { label: "閒置", dot: "bg-fg-faint", fg: "text-fg-subtle", chip: "bg-surface-2 text-fg-muted", live: false },
  busy: { label: "執行中", dot: "bg-accent", fg: "text-accent", chip: "bg-accent/12 text-accent", live: true },
  waiting: { label: "等待授權", dot: "bg-warn", fg: "text-warn", chip: "bg-warn/12 text-warn", live: true },
  error: { label: "錯誤", dot: "bg-danger", fg: "text-danger", chip: "bg-danger/12 text-danger", live: false },
};

/** 未知狀態(理論上不會發生)退回 idle 的樣式,但保留原始字串當標籤——不要
 *  騙使用者說「閒置」。 */
export function sessionStatusMeta(status: string | undefined): StatusMeta {
  if (status && status in SESSION_STATUS) return SESSION_STATUS[status as SessionStatusKey];
  return { ...SESSION_STATUS.idle, label: status ?? "未知" };
}

/** 成員沒有任何 active session 時的樣式(比 idle 更淡:那是「不在線」)。 */
export const OFFLINE_STATUS: StatusMeta = {
  label: "尚無 session",
  dot: "bg-line-strong",
  fg: "text-fg-faint",
  chip: "bg-surface-2 text-fg-faint",
  live: false,
};

/* ------------------------------------------------------------------------- */

export interface TaskStatusMeta {
  label: string;
  /** 看板欄位標題用的英文短名(維持與 core 狀態機同名,方便對照 log) */
  code: string;
  fg: string;
  chip: string;
  /** 卡片左緣的狀態色條 */
  rail: string;
}

const TASK_STATUS: Record<TaskStatus, TaskStatusMeta> = {
  backlog: { label: "待處理", code: "Backlog", fg: "text-fg-subtle", chip: "bg-surface-2 text-fg-muted", rail: "bg-line-strong" },
  assigned: { label: "已指派", code: "Assigned", fg: "text-info", chip: "bg-info/12 text-info", rail: "bg-info" },
  "in-progress": { label: "進行中", code: "In Progress", fg: "text-accent", chip: "bg-accent/12 text-accent", rail: "bg-accent" },
  review: { label: "審查中", code: "Review", fg: "text-warn", chip: "bg-warn/12 text-warn", rail: "bg-warn" },
  merging: { label: "合併中", code: "Merging", fg: "text-ok", chip: "bg-ok/12 text-ok", rail: "bg-ok" },
  done: { label: "已完成", code: "Done", fg: "text-fg-subtle", chip: "bg-surface-2 text-fg-muted", rail: "bg-ok/50" },
  blocked: { label: "已封鎖", code: "Blocked", fg: "text-danger", chip: "bg-danger/12 text-danger", rail: "bg-danger" },
};

export function taskStatusMeta(status: TaskStatus): TaskStatusMeta {
  return TASK_STATUS[status];
}

/* ------------------------------------------------------------------------- */

/** adapter/provider 的短徽章文字(原本三個檔案各有一份拷貝)。 */
export const softwareBadge: Record<string, string> = {
  "claude-agent-sdk": "SDK",
  acp: "ACP",
  opencode: "OpenCode",
  codex: "Codex",
  pty: "PTY",
};

export function softwareLabel(software: string | undefined): string {
  if (!software) return "?";
  return softwareBadge[software] ?? software;
}

/** 每種 adapter 在側欄/標頭用的圖示——聊天型 vs 終端型一眼可分。 */
export function softwareIcon(software: string | undefined): IconName {
  return software === "pty" ? "terminal" : "message";
}
