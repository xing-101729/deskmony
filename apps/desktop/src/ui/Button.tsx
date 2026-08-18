import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Icon, type IconName } from "./icons.js";

/**
 * 按鈕規範。
 *
 * 改版前的問題:每個按鈕都是手寫的一長串 class,結果同一個語意在不同畫面長得
 * 不一樣(有的 `border border-base-600 px-2 py-1`、有的 `px-3 py-1.5`、有的
 * `px-4 py-2`),而且**幾乎所有按鈕都帶邊框**——密集畫面裡數十個框線互相競爭,
 * 是「傳統企業後台感」的主要來源。
 *
 * 這裡的規範:
 *   - **層級靠填色,不靠邊框**:primary(實心品牌色)> secondary(淡填色,
 *     無邊框)> ghost(完全無底,hover 才出現)。只有 `outline` 這個變體保留
 *     邊框,給「需要看起來可點但不該吸引注意」的場合(例如唯讀資訊旁的動作)。
 *   - **尺寸只有三階**,最大 32px 高(md)。開發者工具不需要 44px 的觸控按鈕,
 *     過大的按鈕會壓縮資訊密度。
 *   - **焦點環統一**(`.focus-ring`),鍵盤操作永遠看得見焦點。
 */

export type ButtonVariant = "primary" | "secondary" | "ghost" | "outline" | "danger" | "accentSoft";
export type ButtonSize = "xs" | "sm" | "md";

const VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-accent text-accent-fg hover:bg-accent-hover shadow-panel",
  secondary: "bg-surface-2 text-fg-soft hover:bg-line hover:text-fg",
  ghost: "text-fg-muted hover:bg-surface-2 hover:text-fg",
  outline: "border border-line text-fg-muted hover:border-line-strong hover:text-fg",
  danger: "border border-danger/40 text-danger hover:bg-danger/12",
  accentSoft: "bg-accent/12 text-accent hover:bg-accent/20",
};

const SIZE: Record<ButtonSize, string> = {
  xs: "h-6 gap-1.5 rounded px-2 text-2xs",
  sm: "h-7 gap-1.5 rounded-md px-3 text-xs",
  md: "h-8 gap-2 rounded-md px-3.5 text-sm",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName;
  iconRight?: IconName;
  /** 佔滿容器寬度(側欄的主要行動、對話框的單一送出鈕) */
  block?: boolean;
  /** 進行中:自動 disabled 並顯示旋轉指示,文字由呼叫端自行改寫 */
  loading?: boolean;
  /** 切換型按鈕的「已開啟」狀態(例如 Auto 模式) */
  active?: boolean;
  children?: ReactNode;
}

export function Button({
  variant = "secondary",
  size = "sm",
  icon,
  iconRight,
  block,
  loading,
  active,
  className,
  disabled,
  children,
  ...rest
}: ButtonProps): JSX.Element {
  return (
    <button
      type="button"
      disabled={disabled || loading}
      data-active={active ? "true" : undefined}
      className={[
        "focus-ring inline-flex select-chrome items-center justify-center whitespace-nowrap font-medium transition",
        "disabled:pointer-events-none disabled:opacity-40",
        SIZE[size],
        VARIANT[variant],
        active ? "!bg-accent/15 !text-accent" : "",
        block ? "w-full" : "",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
      {...rest}
    >
      {loading ? <Spinner size={size === "xs" ? 10 : 12} /> : icon ? <Icon name={icon} size={size === "xs" ? 12 : 14} /> : null}
      {children}
      {iconRight && <Icon name={iconRight} size={size === "xs" ? 12 : 14} />}
    </button>
  );
}

/** 純圖示按鈕:正方形、無文字,一律要求 `aria-label`(無障礙 + hover tooltip)。 */
export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  icon: IconName;
  "aria-label": string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  active?: boolean;
}

/*
 * 正方形圖示按鈕**不**沿用 Button 文字按鈕的 rounded-md(12px)——12px 套在
 * 24–28px 見方的容器上會逼近甚至等於半徑一半,變成圓形而不是圓角方形。這裡
 * 固定用較小的圓角階梯,維持「圓角方形」而非「圓形」。
 */
const ICON_SIZE: Record<ButtonSize, string> = {
  xs: "h-5 w-5 rounded-sm",
  sm: "h-6 w-6 rounded",
  md: "h-7 w-7 rounded",
};

export function IconButton({
  icon,
  variant = "ghost",
  size = "sm",
  active,
  className,
  ...rest
}: IconButtonProps): JSX.Element {
  return (
    <button
      type="button"
      className={[
        "focus-ring inline-flex flex-shrink-0 items-center justify-center transition disabled:pointer-events-none disabled:opacity-40",
        ICON_SIZE[size],
        VARIANT[variant],
        active ? "!bg-accent/15 !text-accent" : "",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
      {...rest}
    >
      <Icon name={icon} size={size === "md" ? 15 : 14} />
    </button>
  );
}

/** 載入指示(取代改版前散落各處的「載入中…」純文字)。 */
export function Spinner({ size = 12, className }: { size?: number; className?: string }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={`animate-spin ${className ?? ""}`}
      aria-hidden="true"
      style={{ animationDuration: "700ms" }}
    >
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2.5" opacity="0.2" />
      <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

/**
 * 分段控制(取代原本頂列那組「三個各自帶背景的小按鈕」)——同一組互斥選項用
 * 一個容器包住、只有選中的那個有實心底,是 Linear/Raycast 的標準作法,比三個
 * 獨立按鈕更清楚地表達「這是同一維度的切換」。
 */
export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  icon?: IconName;
  /** 顯示在右側的快捷鍵提示(例如 "⌘1") */
  hint?: string;
  /** 右上角的計數(例如未讀/任務數) */
  count?: number;
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  className,
}: {
  options: SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  className?: string;
}): JSX.Element {
  return (
    <div
      role="tablist"
      className={`inline-flex select-chrome items-center gap-0.5 rounded-md bg-surface p-0.5 ${className ?? ""}`}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={selected}
            title={option.hint ? `${option.label}(${option.hint})` : option.label}
            onClick={() => onChange(option.value)}
            className={`focus-ring inline-flex h-6 items-center gap-1.5 rounded px-2.5 text-xs font-medium transition ${
              selected ? "bg-surface-2 text-fg shadow-panel" : "text-fg-subtle hover:text-fg-soft"
            }`}
          >
            {option.icon && <Icon name={option.icon} size={13} />}
            {option.label}
            {option.count !== undefined && option.count > 0 && (
              <span className={`tabular text-2xs ${selected ? "text-fg-subtle" : "text-fg-faint"}`}>{option.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** 快捷鍵提示。鍵盤優先操作的前提是「快捷鍵看得到」,不是藏在文件裡。 */
export function Kbd({ children, className }: { children: ReactNode; className?: string }): JSX.Element {
  return (
    <kbd
      className={`inline-flex h-4 min-w-4 items-center justify-center rounded-sm border border-line bg-surface-2 px-1 font-sans text-2xs font-medium text-fg-subtle ${
        className ?? ""
      }`}
    >
      {children}
    </kbd>
  );
}
