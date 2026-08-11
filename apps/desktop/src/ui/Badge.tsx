import type { ReactNode } from "react";
import { Icon, type IconName } from "./icons.js";
import type { StatusMeta } from "./status.js";

/**
 * 徽章 / 狀態指示規範。
 *
 * 改版前的問題:所有徽章都是 `rounded bg-base-800 px-1.5 py-0.5 text-[10px]` 的
 * 手抄版本,而需要「表達嚴重度」的地方(成本熔斷、無法量測、已降級…)則各自
 * 挑了 `bg-amber-900/50`、`bg-red-900/50`、`bg-yellow-900/40` 等等——同一種嚴重
 * 度在不同畫面用了不同顏色與不同透明度,使用者學不到穩定的對應關係。
 *
 * 這裡只有 6 種語氣(tone),對應設計系統的語意色:
 *   neutral(資訊)/ accent(品牌,進行中)/ ok / warn / danger / info
 * 並且**一律是低飽和 tint + 同色文字**,不用實心色塊——實心色塊在密集畫面裡
 * 會變成「彩色噪音」(避免過多彩色區塊)。
 */

export type Tone = "neutral" | "accent" | "ok" | "warn" | "danger" | "info";

const TONE: Record<Tone, string> = {
  neutral: "bg-surface-2 text-fg-muted",
  accent: "bg-accent/12 text-accent",
  ok: "bg-ok/12 text-ok",
  warn: "bg-warn/12 text-warn",
  danger: "bg-danger/12 text-danger",
  info: "bg-info/12 text-info",
};

export interface BadgeProps {
  children: ReactNode;
  tone?: Tone;
  icon?: IconName;
  mono?: boolean;
  title?: string;
  className?: string;
}

export function Badge({ children, tone = "neutral", icon, mono, title, className }: BadgeProps): JSX.Element {
  return (
    <span
      title={title}
      className={[
        "inline-flex h-[18px] max-w-full items-center gap-1 rounded px-1.5 text-2xs font-medium",
        mono ? "tabular font-mono" : "",
        TONE[tone],
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {icon && <Icon name={icon} size={11} />}
      <span className="truncate">{children}</span>
    </span>
  );
}

/**
 * 狀態圓點。`live`(執行中/等待中)時外圈加一層同色光暈並呼吸——
 * 「Agent 狀態一眼可辨識」的核心:在 200px 寬的側欄裡,顏色 + 動態比文字更快
 * 被眼睛掃到,文字則負責消除歧義。
 */
export function StatusDot({ meta, size = 6 }: { meta: StatusMeta; size?: number }): JSX.Element {
  return (
    <span className="relative inline-flex flex-shrink-0 items-center justify-center" style={{ width: size, height: size }}>
      {meta.live && (
        <span
          className={`absolute inset-[-3px] animate-breathe rounded-full opacity-30 ${meta.dot}`}
          aria-hidden="true"
        />
      )}
      <span className={`relative block h-full w-full rounded-full ${meta.dot}`} aria-hidden="true" />
    </span>
  );
}

/** 狀態圓點 + 文字的組合(列表列、標頭都用同一個組合,避免各處自己拼)。 */
export function StatusPill({ meta, className }: { meta: StatusMeta; className?: string }): JSX.Element {
  return (
    <span className={`inline-flex items-center gap-1.5 text-2xs font-medium ${meta.fg} ${className ?? ""}`}>
      <StatusDot meta={meta} />
      {meta.label}
    </span>
  );
}

/**
 * 標頭/卡片裡的「圖示 + 數值」meta 單元。取代原本各處把 emoji 直接寫進文字
 * (`👤 name`、`🌿 branch`)的做法,並保證圖示與文字的間距/對齊一致。
 */
export function Meta({
  icon,
  children,
  title,
  mono,
  className,
}: {
  icon?: IconName;
  children: ReactNode;
  title?: string;
  mono?: boolean;
  className?: string;
}): JSX.Element {
  return (
    <span
      title={title}
      className={`inline-flex min-w-0 items-center gap-1 text-2xs text-fg-subtle ${mono ? "tabular font-mono" : ""} ${
        className ?? ""
      }`}
    >
      {icon && <Icon name={icon} size={11} className="text-fg-faint" />}
      <span className="truncate">{children}</span>
    </span>
  );
}

/** 區塊小標題(設定對話框、側欄分組)——大寫 + 字距 + 極小字級,是 dev tool
 *  慣用的「這是一個群組」訊號,比加一條粗分隔線更輕。 */
export function SectionLabel({
  children,
  action,
  className,
}: {
  children: ReactNode;
  action?: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <div className={`flex h-6 items-center justify-between gap-2 ${className ?? ""}`}>
      <span className="select-chrome text-2xs font-semibold uppercase tracking-[0.08em] text-fg-faint">{children}</span>
      {action}
    </div>
  );
}
