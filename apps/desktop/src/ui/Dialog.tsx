import { useEffect, type ReactNode } from "react";
import { ModalPortal } from "../views/ModalPortal.js";
import { IconButton } from "./Button.js";
import { Icon, type IconName } from "./icons.js";

/**
 * 對話框外殼。
 *
 * 改版前每個彈窗都自己寫一份 `fixed inset-0 … bg-black/60` + 卡片骨架 +
 * 標頭/內容/footer 的內距,五個彈窗長出五種寬度與四種標頭寫法;而且**沒有一個
 * 支援 Esc 關閉**(鍵盤優先操作的基本要求)。
 *
 * 這個元件負責:遮罩(含背景模糊)、置中、尺寸階梯、進場動畫、標頭/內容/footer
 * 三段結構、Esc 關閉、點擊遮罩關閉。焦點管理(focus trap、關閉後把焦點還給
 * 觸發元素)仍由既有的 `ModalPortal` 負責——它同時解決了「祖先 transform 讓
 * fixed 定位跑掉」的問題,見該檔案頂端的根因說明,不要繞過它。
 *
 * `dismissible={false}` 給**必須做出決定**的彈窗用(權限請求):Esc/點遮罩都
 * 不關,避免使用者以為「按 Esc = 拒絕」而在不知道結果的情況下離開。
 */

export type DialogSize = "sm" | "md" | "lg" | "xl";

const SIZE: Record<DialogSize, string> = {
  sm: "w-[min(420px,calc(100vw-32px))]",
  md: "w-[min(560px,calc(100vw-32px))]",
  lg: "w-[min(680px,calc(100vw-32px))]",
  xl: "w-[min(880px,calc(100vw-32px))]",
};

export interface DialogProps {
  title: ReactNode;
  description?: ReactNode;
  icon?: IconName;
  /** `danger` 會讓外框與標頭轉為警示樣式(硬性禁止項、YOLO 確認) */
  tone?: "default" | "danger";
  size?: DialogSize;
  onClose?: () => void;
  dismissible?: boolean;
  /** 標頭右側的額外控制(關閉鈕之外) */
  headerAction?: ReactNode;
  footer?: ReactNode;
  /** 內容區是否自行處理內距(false 時由 Dialog 給 px-4 py-3) */
  bare?: boolean;
  children: ReactNode;
}

export function Dialog({
  title,
  description,
  icon,
  tone = "default",
  size = "md",
  onClose,
  dismissible = true,
  headerAction,
  footer,
  bare,
  children,
}: DialogProps): JSX.Element {
  useEffect(() => {
    if (!dismissible || !onClose) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dismissible, onClose]);

  const danger = tone === "danger";

  return (
    <ModalPortal>
      <div
        className="fixed inset-0 z-50 flex animate-fade-in items-center justify-center bg-scrim/60 p-4 backdrop-blur-[2px]"
        onMouseDown={(event) => {
          // 只有點到遮罩本身(不是內容)才關閉;mousedown 而非 click,避免在
          // 對話框內開始拖選文字、滑到遮罩上放開時被誤判為「點了遮罩」。
          if (dismissible && onClose && event.target === event.currentTarget) onClose();
        }}
      >
        <div
          role="dialog"
          aria-modal="true"
          className={`flex max-h-[min(88vh,900px)] animate-pop-in flex-col overflow-hidden rounded-xl bg-panel shadow-overlay ${
            SIZE[size]
          } ${danger ? "ring-1 ring-danger/60" : ""}`}
        >
          <header
            className={`flex flex-shrink-0 items-start gap-2.5 px-4 py-3 ${
              danger ? "border-b border-danger/25 bg-danger/[0.07]" : "border-b border-line-subtle"
            }`}
          >
            {icon && (
              <span
                className={`mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md ${
                  danger ? "bg-danger/15 text-danger" : "bg-surface-2 text-fg-muted"
                }`}
              >
                <Icon name={icon} size={14} />
              </span>
            )}
            <div className="min-w-0 flex-1">
              <h2 className={`text-md font-semibold tracking-tight ${danger ? "text-danger" : "text-fg"}`}>{title}</h2>
              {description && <p className="mt-0.5 text-xs leading-relaxed text-fg-subtle">{description}</p>}
            </div>
            <div className="flex flex-shrink-0 items-center gap-1">
              {headerAction}
              {dismissible && onClose && <IconButton icon="x" aria-label="關閉" onClick={onClose} />}
            </div>
          </header>

          <div className={`min-h-0 flex-1 overflow-y-auto ${bare ? "" : "px-4 py-3"}`}>{children}</div>

          {footer && (
            <footer className="flex flex-shrink-0 items-center justify-between gap-2 border-t border-line-subtle bg-surface/40 px-4 py-2.5">
              {footer}
            </footer>
          )}
        </div>
      </div>
    </ModalPortal>
  );
}
