import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";
import { Icon } from "./icons.js";

/**
 * 表單元件規範。
 *
 * 改版前每個輸入框都手寫同一串 class(`rounded-md border border-base-700
 * bg-base-850 px-2 py-1 text-xs … focus:border-accent`),共出現 30+ 次,尺寸與
 * 內距各處不一。這裡收斂成:
 *   - 兩種尺寸(sm 28px / md 32px),與 Button 對齊,並排時不會高低不平。
 *   - 統一的 focus 表現:邊框轉品牌色 **+ 外圈細環**(只有邊框變色在深色主題
 *     下太不明顯,鍵盤操作時容易找不到目前焦點)。
 *   - `<select>` 一律 `appearance-none` + 自繪箭頭:原生箭頭在 Windows 上是
 *     系統灰色三角,與整體視覺語言不一致。
 */

export type FieldSize = "sm" | "md";

const BASE =
  "w-full min-w-0 rounded-md border border-line bg-surface text-fg placeholder:text-fg-faint transition " +
  "outline-none focus:border-accent/70 focus:ring-2 focus:ring-accent/25 " +
  "disabled:cursor-not-allowed disabled:opacity-50";

const SIZE: Record<FieldSize, string> = {
  sm: "h-7 px-2 text-xs",
  md: "h-8 px-2.5 text-sm",
};

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
  fieldSize?: FieldSize;
  mono?: boolean;
  invalid?: boolean;
}

export function Input({ fieldSize = "sm", mono, invalid, className, ...rest }: InputProps): JSX.Element {
  return (
    <input
      className={[
        BASE,
        SIZE[fieldSize],
        mono ? "font-mono" : "",
        invalid ? "!border-danger/60" : "",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
      {...rest}
    />
  );
}

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  mono?: boolean;
}

export function Textarea({ mono, className, ...rest }: TextareaProps): JSX.Element {
  return (
    <textarea
      className={[BASE, "resize-y px-2.5 py-1.5 text-sm leading-relaxed", mono ? "font-mono text-xs" : "", className ?? ""]
        .filter(Boolean)
        .join(" ")}
      {...rest}
    />
  );
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "size"> {
  fieldSize?: FieldSize;
  children: ReactNode;
}

export function Select({ fieldSize = "sm", className, children, ...rest }: SelectProps): JSX.Element {
  return (
    <div className="relative min-w-0">
      <select
        className={[BASE, SIZE[fieldSize], "cursor-pointer appearance-none pr-6", className ?? ""]
          .filter(Boolean)
          .join(" ")}
        {...rest}
      >
        {children}
      </select>
      <Icon
        name="chevron-down"
        size={12}
        className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 text-fg-faint"
      />
    </div>
  );
}

/** 標籤 + 說明 + 錯誤的容器。說明文字放在**輸入框下方**(不是 placeholder),
 *  placeholder 一消失就看不到,說明必須常駐。 */
export function Field({
  label,
  hint,
  error,
  action,
  htmlFor,
  children,
  className,
}: {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  /** 標籤同列右側的次要動作(例如「重新偵測」「套用範本」) */
  action?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}): JSX.Element {
  return (
    <div className={`space-y-1 ${className ?? ""}`}>
      {(label || action) && (
        <div className="flex min-h-4 items-center justify-between gap-2">
          {label ? (
            <label htmlFor={htmlFor} className="text-xs font-medium text-fg-muted">
              {label}
            </label>
          ) : (
            <span />
          )}
          {action}
        </div>
      )}
      {children}
      {hint && <p className="text-2xs leading-normal text-fg-faint">{hint}</p>}
      {error && <p className="text-2xs text-danger">{error}</p>}
    </div>
  );
}

/** 勾選框(維持原生 input,只調整尺寸與色彩:原生元件的鍵盤/無障礙行為最可靠)。 */
export function Checkbox({
  label,
  className,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode }): JSX.Element {
  return (
    <label className={`inline-flex cursor-pointer select-none items-center gap-1.5 text-xs text-fg-muted ${className ?? ""}`}>
      <input
        type="checkbox"
        className="focus-ring h-3.5 w-3.5 flex-shrink-0 rounded border-line bg-surface"
        {...rest}
      />
      {label}
    </label>
  );
}

/**
 * 開關(switch)——給「立即生效的布林設定」用(例如 provider 啟用/停用)。
 * 與 Checkbox 的分工:checkbox 是「多選清單裡的一項」(送出時才生效),switch
 * 是「一個功能的開/關」(點下去就生效),兩者視覺不同才不會誤導。
 */
export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`focus-ring relative inline-flex h-4 w-7 flex-shrink-0 items-center rounded-full transition disabled:opacity-40 ${
        checked ? "bg-accent" : "bg-line-strong"
      }`}
    >
      <span
        className={`absolute h-3 w-3 rounded-full bg-white shadow-panel transition-all ${checked ? "left-3.5" : "left-0.5"}`}
      />
    </button>
  );
}
