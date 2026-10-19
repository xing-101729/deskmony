import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { DEFAULT_SESSION_TITLE, SESSION_TITLE_MAX_CHARS, type Session } from "@deskmony/shared";
import { useSessionStore } from "../stores/session-store.js";
import { translateError } from "../lib/error-i18n.js";
import { Icon } from "../ui/icons.js";
import { IconButton, Spinner } from "../ui/Button.js";

/**
 * 2026-10-06:session 標題的顯示與改名 UI(側欄與對話/終端標題列共用)。
 *
 *   - 手動改名:側欄雙擊標題或「⋯」選單的「重新命名」、標題列點一下標題 → inline 編輯(Enter 儲存、Esc 取消、
 *     點別處也算儲存)。**不用** `window.prompt/confirm`——Windows 的 Electron 上原生對話框關掉之後整個視窗收不到鍵盤。
 *   - 「AI 重新命名」:用 session 自己的 agent 在臨時對話裡產生標題(`session.autoTitle`,最多約 60 秒),進行中顯示轉圈。
 *   - 標題還是預設值(`titleSource: "default"`)時顯示在地化的「新對話」——core 存的是固定的中文預設字串。
 */

/** 側欄、標題列、命令面板等處顯示的標題。 */
export function displaySessionTitle(session: Pick<Session, "title" | "titleSource">, t: TFunction): string {
  return session.titleSource === "default" && session.title === DEFAULT_SESSION_TITLE
    ? t("sessionTitle:untitled")
    : session.title;
}

/** 正在中文/日文輸入法選字時按的 Enter 不算送出(否則一選字就把半成品存成標題)。 */
function isComposing(e: KeyboardEvent<HTMLInputElement>): boolean {
  return e.nativeEvent.isComposing || e.keyCode === 229;
}

/**
 * inline 標題編輯器。`onDone` 在儲存成功、取消、或內容沒變時呼叫;儲存失敗(空白、太長、連線問題)時留在編輯狀態並
 * 顯示錯誤。空白送出視同取消(不呼叫 API)。
 */
export function SessionTitleEditor({
  session,
  onDone,
  className,
}: {
  session: Session;
  onDone: () => void;
  className?: string;
}): JSX.Element {
  const { t } = useTranslation(["sessionTitle", "errors"]);
  const renameSession = useSessionStore((s) => s.renameSession);
  // 還是預設標題時從空白開始(placeholder 顯示在地化的「新對話」),不用先刪掉一串預設字。
  const [value, setValue] = useState(session.titleSource === "default" ? "" : session.title);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const finishedRef = useRef(false);
  // 用 ref 而不是只看 state:送出後 input 變 disabled 會觸發 blur,那時的 onBlur 可能還是舊的 closure。
  const savingRef = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const finish = (): void => {
    finishedRef.current = true;
    onDone();
  };

  const commit = async (): Promise<void> => {
    if (finishedRef.current || savingRef.current) return;
    const next = value.trim();
    if (next.length === 0 || (next === session.title && session.titleSource !== "default")) {
      finish();
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      await renameSession(session.id, next);
      finish();
    } catch (err) {
      setError(translateError(err, t));
      savingRef.current = false;
      setSaving(false);
      // 等 input 解除 disabled 之後再把焦點放回去,讓使用者直接修正。
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  };

  return (
    <div className={`min-w-0 ${className ?? ""}`}>
      <input
        ref={inputRef}
        value={value}
        disabled={saving}
        maxLength={SESSION_TITLE_MAX_CHARS * 2}
        placeholder={displaySessionTitle(session, t)}
        aria-label={t("sessionTitle:editorAriaLabel")}
        aria-invalid={error ? true : undefined}
        onChange={(e) => {
          setValue(e.target.value);
          if (error) setError(null);
        }}
        onKeyDown={(e) => {
          // 不讓按鍵冒泡到外層(列的點擊、全域快捷鍵)。
          e.stopPropagation();
          if (e.key === "Enter" && !isComposing(e)) {
            e.preventDefault();
            void commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            finish();
          }
        }}
        onBlur={() => void commit()}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        className={`h-6 w-full min-w-0 rounded border bg-surface px-1.5 text-xs text-fg outline-none transition focus:ring-2 focus:ring-accent/25 ${
          error ? "border-danger/60" : "border-accent/70"
        }`}
      />
      {error && (
        <p role="alert" className="mt-0.5 text-2xs leading-snug text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * 「⋯」選單(重新命名 / AI 重新命名)。用 portal 掛到 body、`position: fixed` 對齊 `anchor`——側欄清單是可捲動的
 * `overflow-y-auto` 容器,一般的 absolute 下拉會被它裁掉(側欄 `<aside>` 也有 transform,見 ModalPortal 的說明)。
 */
export function SessionTitleMenu({
  session,
  anchor,
  onRename,
  onClose,
  onError,
}: {
  session: Session;
  /** 選單左上角要對齊的位置(按鈕的左下角,或右鍵點擊的座標)。 */
  anchor: { x: number; y: number };
  onRename: () => void;
  onClose: () => void;
  /** 「AI 重新命名」失敗時的訊息(已翻譯)。 */
  onError: (message: string) => void;
}): JSX.Element {
  const { t } = useTranslation(["sessionTitle", "errors"]);
  const autoTitleSession = useSessionStore((s) => s.autoTitleSession);
  const generating = useSessionStore((s) => Boolean(s.titleGenerating[session.id]));
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState(anchor);

  // 貼著視窗邊緣時往內收,不讓選單超出畫面。
  useLayoutEffect(() => {
    const rect = menuRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPosition({
      x: Math.max(4, Math.min(anchor.x, window.innerWidth - rect.width - 4)),
      y: Math.max(4, Math.min(anchor.y, window.innerHeight - rect.height - 4)),
    });
  }, [anchor]);

  useEffect(() => {
    menuRef.current?.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus();
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const itemClass =
    "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-fg-soft transition hover:bg-surface focus:bg-surface focus:outline-none disabled:opacity-50";

  return createPortal(
    <>
      <div className="fixed inset-0 z-40" onMouseDown={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div
        ref={menuRef}
        role="menu"
        aria-label={t("sessionTitle:menuLabel")}
        style={{ left: position.x, top: position.y }}
        className="fixed z-50 w-40 overflow-hidden rounded-md border border-line-subtle bg-panel py-1 shadow-overlay"
      >
        <button
          type="button"
          role="menuitem"
          className={itemClass}
          onClick={() => {
            onClose();
            onRename();
          }}
        >
          <Icon name="pencil" size={12} className="text-fg-faint" />
          {t("sessionTitle:rename")}
        </button>
        <button
          type="button"
          role="menuitem"
          disabled={generating}
          className={itemClass}
          onClick={() => {
            onClose();
            autoTitleSession(session.id).catch((err: unknown) => onError(translateError(err, t)));
          }}
        >
          <Icon name="sparkle" size={12} className="text-fg-faint" />
          {generating ? t("sessionTitle:autoTitleRunning") : t("sessionTitle:autoTitle")}
        </button>
      </div>
    </>,
    document.body,
  );
}

/**
 * 對話/終端視圖標題列的標題:點一下就地改名;旁邊的 ✦ 按鈕是「AI 重新命名」(進行中轉圈)。
 */
export function SessionTitleHeading({ session }: { session: Session }): JSX.Element {
  const { t } = useTranslation(["sessionTitle", "errors"]);
  const autoTitleSession = useSessionStore((s) => s.autoTitleSession);
  const generating = useSessionStore((s) => Boolean(s.titleGenerating[session.id]));
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 換 session 時收起編輯器與錯誤。
  useEffect(() => {
    setEditing(false);
    setError(null);
  }, [session.id]);

  if (editing) {
    return <SessionTitleEditor session={session} onDone={() => setEditing(false)} className="max-w-md" />;
  }

  const title = displaySessionTitle(session, t);
  return (
    <div className="flex min-w-0 items-center gap-1">
      <h1 className="min-w-0 truncate text-sm font-semibold text-fg">
        <button
          type="button"
          onClick={() => {
            setError(null);
            setEditing(true);
          }}
          title={t("sessionTitle:clickToRename")}
          className="focus-ring max-w-full truncate rounded px-0.5 -mx-0.5 text-left hover:bg-surface"
        >
          {title}
        </button>
      </h1>
      {generating ? (
        <span className="inline-flex h-6 w-6 flex-shrink-0 items-center justify-center text-accent" title={t("sessionTitle:autoTitleRunning")}>
          <Spinner size={12} />
        </span>
      ) : (
        <IconButton
          icon="sparkle"
          size="xs"
          aria-label={t("sessionTitle:autoTitle")}
          title={t("sessionTitle:autoTitleHint")}
          className="opacity-60 hover:opacity-100"
          onClick={() => {
            setError(null);
            autoTitleSession(session.id).catch((err: unknown) => setError(translateError(err, t)));
          }}
        />
      )}
      {error && (
        <span role="alert" className="truncate text-2xs text-danger" title={error}>
          {error}
        </span>
      )}
    </div>
  );
}
