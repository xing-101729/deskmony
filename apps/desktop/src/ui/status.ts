import type { TaskStatus } from "@deskmony/shared";
import type { IconName } from "./icons.js";
import i18n from "../i18n.js";

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
 *
 * i18n 專案新增:`label` 不再是模組載入當下就算好的靜態字串,改成呼叫端每次
 * 取用時透過 i18next 單例(`../i18n.js` 的裸 `i18n.t()`,不是 `useTranslation()`
 * hook——這個檔案是純 TS,不是 React 元件)即時查表,才能在語言切換後給出
 * 正確的文字。非文字欄位(`dot`/`fg`/`chip`/`live`/`rail`/`code`)維持原樣的
 * 靜態 Record,只有 `label` 是動態的——見下方 `sessionStatusMeta()`/
 * `taskStatusMeta()`/`offlineStatus()`。
 */

export type SessionStatusKey = "idle" | "busy" | "waiting" | "error";

export interface StatusMeta {
  /** 標籤(列表/標頭顯示) */
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

/** 非文字樣式——`label` 拆出去用 i18next 動態查,這裡只留顏色/動態旗標。 */
type SessionStatusStyle = Omit<StatusMeta, "label">;

const SESSION_STATUS_STYLE: Record<SessionStatusKey, SessionStatusStyle> = {
  idle: { dot: "bg-fg-faint", fg: "text-fg-subtle", chip: "bg-surface-2 text-fg-muted", live: false },
  busy: { dot: "bg-accent", fg: "text-accent", chip: "bg-accent/12 text-accent", live: true },
  waiting: { dot: "bg-warn", fg: "text-warn", chip: "bg-warn/12 text-warn", live: true },
  error: { dot: "bg-danger", fg: "text-danger", chip: "bg-danger/12 text-danger", live: false },
};

/** 未知狀態(理論上不會發生)退回 idle 的樣式,但保留原始字串當標籤——不要
 *  騙使用者說「閒置」。 */
export function sessionStatusMeta(status: string | undefined): StatusMeta {
  if (status && status in SESSION_STATUS_STYLE) {
    return { ...SESSION_STATUS_STYLE[status as SessionStatusKey], label: i18n.t(`status:session.${status}`) };
  }
  return { ...SESSION_STATUS_STYLE.idle, label: status ?? i18n.t("common:unknown") };
}

/**
 * 成員沒有任何 active session 時的樣式(比 idle 更淡:那是「不在線」)。
 *
 * i18n 專案新增:從模組載入時就算好的 const 物件改成零參數函式——`label`
 * 現在是每次呼叫時才查表的動態值(見檔案頂端註解),不能再是模組載入當下就
 * 凍結的常數,否則語言切換後這個標籤永遠停在第一次載入時的語言。呼叫端
 * (TeamChatView.tsx / TeamManagementDialog.tsx)已改叫 `offlineStatus()`。
 */
export function offlineStatus(): StatusMeta {
  return {
    label: i18n.t("status:session.offline"),
    dot: "bg-line-strong",
    fg: "text-fg-faint",
    chip: "bg-surface-2 text-fg-faint",
    live: false,
  };
}

/* ------------------------------------------------------------------------- */

export interface TaskStatusMeta {
  label: string;
  /** 看板欄位標題用的英文短名(維持與 core 狀態機同名,方便對照 log)——
   *  刻意不翻譯,見 apps/desktop/src/locales/GLOSSARY.md。 */
  code: string;
  fg: string;
  chip: string;
  /** 卡片左緣的狀態色條 */
  rail: string;
}

/** 非文字樣式 + i18next key(camelCase,對應 locales/<locale>/status.json 的
 *  `task.*`)——`TaskStatus` 本身有 `"in-progress"` 這種帶連字號的 key,JSON
 *  namespace 的 key 統一用 camelCase(`inProgress`),兩者用這張表對應。 */
const TASK_STATUS_STYLE: Record<TaskStatus, Omit<TaskStatusMeta, "label"> & { i18nKey: string }> = {
  backlog: { code: "Backlog", fg: "text-fg-subtle", chip: "bg-surface-2 text-fg-muted", rail: "bg-line-strong", i18nKey: "backlog" },
  assigned: { code: "Assigned", fg: "text-info", chip: "bg-info/12 text-info", rail: "bg-info", i18nKey: "assigned" },
  "in-progress": { code: "In Progress", fg: "text-accent", chip: "bg-accent/12 text-accent", rail: "bg-accent", i18nKey: "inProgress" },
  review: { code: "Review", fg: "text-warn", chip: "bg-warn/12 text-warn", rail: "bg-warn", i18nKey: "review" },
  merging: { code: "Merging", fg: "text-ok", chip: "bg-ok/12 text-ok", rail: "bg-ok", i18nKey: "merging" },
  done: { code: "Done", fg: "text-fg-subtle", chip: "bg-surface-2 text-fg-muted", rail: "bg-ok/50", i18nKey: "done" },
  blocked: { code: "Blocked", fg: "text-danger", chip: "bg-danger/12 text-danger", rail: "bg-danger", i18nKey: "blocked" },
};

export function taskStatusMeta(status: TaskStatus): TaskStatusMeta {
  const { i18nKey, ...meta } = TASK_STATUS_STYLE[status];
  return { ...meta, label: i18n.t(`status:task.${i18nKey}`) };
}

/* ------------------------------------------------------------------------- */

/** adapter/provider 的短徽章文字(原本三個檔案各有一份拷貝)。刻意不翻譯
 *  ——這些是產品/技術專有名詞,見 apps/desktop/src/locales/GLOSSARY.md。 */
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
