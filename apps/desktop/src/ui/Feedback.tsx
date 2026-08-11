import type { ReactNode } from "react";
import { IconButton } from "./Button.js";
import { Icon, type IconName } from "./icons.js";
import type { Tone } from "./Badge.js";

/**
 * 提示與空狀態。
 *
 * 改版前:錯誤訊息在 6 個檔案裡各寫一份 `rounded-md border border-red-900/50
 * bg-red-950/30 px-3 py-2 text-xs text-red-300`,警告又是另一組黃色;空狀態則是
 * 一到兩行居中的灰字,沒有圖示也沒有下一步引導。
 *
 * 這裡統一成 `Alert`(四種語氣、可關閉、可帶動作)與 `EmptyState`(圖示 +
 * 標題 + 說明 + 主要行動)。空狀態帶「下一步」是 UX 重點:使用者第一次打開
 * 任務看板時看到的不該只是「尚未建立任何團隊」,而是能直接開始的按鈕。
 */

const ALERT_TONE: Record<Exclude<Tone, "neutral" | "accent">, { wrap: string; icon: IconName; iconClass: string }> = {
  danger: { wrap: "bg-danger/10 text-danger", icon: "alert", iconClass: "text-danger" },
  warn: { wrap: "bg-warn/10 text-warn", icon: "alert", iconClass: "text-warn" },
  ok: { wrap: "bg-ok/10 text-ok", icon: "check", iconClass: "text-ok" },
  info: { wrap: "bg-info/10 text-info", icon: "sparkle", iconClass: "text-info" },
};

export function Alert({
  tone = "danger",
  children,
  title,
  onDismiss,
  action,
  className,
}: {
  tone?: "danger" | "warn" | "ok" | "info";
  children: ReactNode;
  title?: ReactNode;
  onDismiss?: () => void;
  action?: ReactNode;
  className?: string;
}): JSX.Element {
  const meta = ALERT_TONE[tone];
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={`flex items-start gap-2 rounded-md px-2.5 py-2 text-xs leading-relaxed ${meta.wrap} ${className ?? ""}`}
    >
      <Icon name={meta.icon} size={13} className={`mt-[2px] ${meta.iconClass}`} />
      <div className="min-w-0 flex-1 break-words">
        {title && <p className="font-semibold">{title}</p>}
        {children}
      </div>
      {action}
      {onDismiss && <IconButton icon="x" aria-label="關閉提示" size="xs" onClick={onDismiss} className="-mr-1 -mt-0.5" />}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  compact,
}: {
  icon: IconName;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  /** 用在小容器裡(側欄、看板欄位):只留一行極簡文字 */
  compact?: boolean;
}): JSX.Element {
  if (compact) {
    return (
      <div className="flex flex-col items-center gap-1.5 px-3 py-6 text-center">
        <Icon name={icon} size={16} className="text-fg-faint opacity-60" />
        <p className="text-xs text-fg-subtle">{title}</p>
        {description && <p className="max-w-[220px] text-2xs leading-relaxed text-fg-faint">{description}</p>}
        {action}
      </div>
    );
  }
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 py-10 text-center">
      <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-surface text-fg-subtle">
        <Icon name={icon} size={18} />
      </span>
      <div className="space-y-1">
        <p className="text-md font-semibold text-fg">{title}</p>
        {description && <p className="mx-auto max-w-[340px] text-xs leading-relaxed text-fg-subtle">{description}</p>}
      </div>
      {action && <div className="flex items-center gap-2 pt-1">{action}</div>}
    </div>
  );
}

/**
 * 進度條(細線版)——給「預算用量」「context 使用率」這種比例值用。改版前這些
 * 只有一個百分比數字,數字要「讀」才知道快滿了;一條 2px 的條在餘光就能看出
 * 逼近上限,並在 ≥80% 轉為警示色。
 */
export function Meter({
  percent,
  className,
  title,
}: {
  percent: number;
  className?: string;
  title?: string;
}): JSX.Element {
  const clamped = Math.max(0, Math.min(100, percent));
  const tone = clamped >= 100 ? "bg-danger" : clamped >= 80 ? "bg-warn" : "bg-accent";
  return (
    <span title={title} className={`block h-[3px] w-full overflow-hidden rounded-full bg-surface-2 ${className ?? ""}`}>
      <span className={`block h-full rounded-full transition-all ${tone}`} style={{ width: `${clamped}%` }} />
    </span>
  );
}

/** 骨架載入(取代「載入中…」文字,避免版面在資料抵達時跳動)。 */
export function Skeleton({ className }: { className?: string }): JSX.Element {
  return <span className={`block animate-breathe rounded bg-surface-2 ${className ?? ""}`} aria-hidden="true" />;
}
