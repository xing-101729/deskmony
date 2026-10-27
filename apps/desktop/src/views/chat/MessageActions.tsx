import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useSessionStore, type ChatItem } from "../../stores/session-store.js";
import { Icon, type IconName } from "../../ui/icons.js";
import { confirmDialog } from "../../ui/ConfirmDialog.js";
import { useLocale } from "../../ui/locale.js";
import { formatMessageTime, formatMessageTimeFull } from "../../lib/format-datetime.js";
import { ForwardMessageDialog } from "./ForwardMessageDialog.js";

/** 有動作列的訊息:使用者訊息(含別的 session 送來的)與 assistant 訊息。 */
type MessageItem = Extract<ChatItem, { kind: "user" | "assistant" }>;

/**
 * 把文字放進剪貼簿。先用 Clipboard API(Electron 與 localhost/https 的瀏覽器都有);拿不到或被拒絕(例如以 http 連到
 * 遠端 core 的非安全情境、頁面沒有焦點)再退回隱藏 textarea + `execCommand("copy")`。成功與否回傳給呼叫端顯示。
 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 退回下面的做法
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

/** 動作列上的一顆小按鈕(圖示 + 文字)。`disabledTitle` 有值 = 停用並用 tooltip 說明原因。 */
function BarButton({
  icon,
  label,
  title,
  onClick,
  disabledTitle,
  tone = "default",
}: {
  icon: IconName;
  label: ReactNode;
  title: string;
  onClick: () => void;
  disabledTitle?: string;
  tone?: "default" | "ok" | "danger";
}): JSX.Element {
  const disabled = disabledTitle !== undefined;
  const toneClass = tone === "ok" ? "!text-ok" : tone === "danger" ? "!text-danger" : "";
  const button = (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={disabled ? undefined : title}
      className={`focus-ring inline-flex items-center gap-1 whitespace-nowrap rounded-md border border-line-subtle bg-surface-2 px-1.5 py-0.5 text-2xs text-fg-muted shadow-sm transition hover:bg-surface hover:text-fg disabled:pointer-events-none disabled:opacity-40 ${toneClass}`}
    >
      <Icon name={icon} size={11} />
      {label}
    </button>
  );
  // 原生 tooltip 不會出現在 `disabled` 的按鈕上(它收不到滑鼠事件),所以停用時把說明掛在外面包一層的 span 上。
  return disabled ? <span title={disabledTitle}>{button}</span> : button;
}

/**
 * 每則訊息的 hover 動作列(2026-10-16;取代 ChatView 裡只有「轉傳到…」的 `AssistantActions`):
 *   - 自己送出的訊息(靠右):時間戳、複製、倒回、分支。
 *   - AI 回覆(靠左):時間戳、複製、轉傳到…。
 *   - 別的 session 送來/轉傳的訊息(靠左):時間戳、複製(不是使用者在這個 session 說的話,不能倒回/分支)。
 * 滑過整則訊息才顯示(`group-hover/msg`),鍵盤聚焦(`focus-visible`)時也會顯示。
 *
 * **疊加式、不佔版面**(沿用 `AssistantActions` 當初的做法):這個元件要渲染在氣泡外層的 `relative group/msg` 容器裡
 * (見 `ChatBubble`),整列是跨在氣泡下緣的絕對定位浮動鈕,hover 前後整串訊息的位置完全不變。
 * 使用者訊息的氣泡靠右,動作列錨在**右**下角(`right-2`),往左展開;靠左的訊息錨在左下角,往右展開——這樣很短的氣泡
 * (例如「OK」)比動作列窄時,動作列凸出去的一邊是空白處,不會被捲動容器的邊界切掉。按鈕要 `whitespace-nowrap`:絕對定位元素
 * 的寬度上限是「氣泡寬度 − 錨點距離」,不加的話短氣泡上的標籤會被擠成好幾行。`-bottom-2` 讓動作列伸出氣泡外 8px:其中 4px 是相鄰
 * 訊息間 `my-1` 疊出的間距,另外 4px 蓋在下一則訊息頂端的內距上(那裡沒有字);換來的是伸進自己氣泡的部分剛好落在 `py-2.5` 的
 * 底部留白裡,不會蓋到單行氣泡最後一行字的下半(原本 `-bottom-1` 只伸出 4px,動作列比留白高,會蓋到字)。隱藏時 `pointer-events-none`,
 * 免得看不見的按鈕擋住氣泡下緣的選字。鍵盤聚焦用 `has-[:focus-visible]` 而不是 `focus-within`:滑鼠點擊後(對話框關閉、
 * 焦點回到按鈕)不會讓它一直停在顯示狀態。具名群組 `group/msg`:不和氣泡內容(程式碼區塊等)可能自己用的 `group` 互相觸發。
 *
 * 倒回/分支只在**閒置**時可用(busy/waiting 時停用並用 tooltip 說明);終端程式(pty)沒有對話可倒回,不提供。
 * 語意見 docs/DECISIONS.md「訊息倒回與分支」:只倒對話,agent 已經改過的檔案不會還原——倒回前用 `confirmDialog()` 講清楚
 * (不用原生 `confirm()`,它會讓整個視窗失去鍵盤焦點,見 ui/ConfirmDialog.tsx)。分支不破壞任何東西,不需要確認。
 */
export function MessageActions({ item }: { item: MessageItem }): JSX.Element | null {
  const { t } = useTranslation(["chat"]);
  const locale = useLocale((s) => s.locale);
  const sessionId = useSessionStore((s) => s.currentSessionId);
  // 只選原始型別:session 物件每次 `session-updated` 都是新的,整個選下來會讓每一則訊息的動作列都跟著重繪。
  const status = useSessionStore((s) => s.sessions.find((x) => x.id === s.currentSessionId)?.status);
  const isTerminal = useSessionStore((s) => {
    const current = s.sessions.find((x) => x.id === s.currentSessionId);
    return current ? s.capabilitiesBySoftware[current.adapterType]?.terminal === true : false;
  });
  const rewindToMessage = useSessionStore((s) => s.rewindToMessage);
  const forkFromMessage = useSessionStore((s) => s.forkFromMessage);

  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [acting, setActing] = useState<"rewind" | "fork" | null>(null);
  const [forwarding, setForwarding] = useState(false);
  const forwardSource = useSessionStore((s) => (forwarding ? s.sessions.find((x) => x.id === s.currentSessionId) : undefined));

  useEffect(() => {
    if (copyState === "idle") return;
    const timer = setTimeout(() => setCopyState("idle"), 1500);
    return () => clearTimeout(timer);
  }, [copyState]);

  if (!sessionId || status === undefined) return null;

  const isOwnMessage = item.kind === "user" && !item.origin;
  const canEditHistory = isOwnMessage && !isTerminal;
  const busy = status === "busy" || status === "waiting";
  const busyTitle = busy || acting !== null ? t("chat:messageActions.busyTitle") : undefined;

  const handleCopy = async (): Promise<void> => {
    setCopyState((await copyText(item.content)) ? "copied" : "failed");
  };

  const handleRewind = async (): Promise<void> => {
    if (acting) return;
    const confirmed = await confirmDialog({
      title: t("chat:messageActions.rewindConfirm.title"),
      message: t("chat:messageActions.rewindConfirm.message"),
      confirmLabel: t("chat:messageActions.rewindConfirm.confirm"),
      tone: "danger",
      icon: "undo",
    });
    if (!confirmed) return;
    setActing("rewind");
    try {
      await rewindToMessage(sessionId, item.id);
    } finally {
      setActing(null);
    }
  };

  const handleFork = async (): Promise<void> => {
    if (acting) return;
    setActing("fork");
    try {
      await forkFromMessage(sessionId, item.id, t("chat:messageActions.forkTitleSuffix"));
    } finally {
      setActing(null);
    }
  };

  const sideClass = isOwnMessage ? "right-2" : "left-2";
  // 進行中(倒回/分支的 RPC 要幾秒)時固定顯示,免得滑鼠移開後使用者看不到「倒回中…」。
  const visibleClass = acting
    ? "pointer-events-auto opacity-100"
    : "pointer-events-none opacity-0 has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:opacity-100 group-hover/msg:pointer-events-auto group-hover/msg:opacity-100";

  return (
    <>
      <div className={`absolute -bottom-2 ${sideClass} z-10 flex items-center gap-1 transition ${visibleClass}`}>
        <span
          title={formatMessageTimeFull(item.createdAt, locale)}
          className="inline-flex cursor-default select-none items-center rounded-md border border-line-subtle bg-surface-2 px-1.5 py-0.5 text-2xs tabular-nums text-fg-faint shadow-sm"
        >
          {formatMessageTime(item.createdAt, locale)}
        </span>
        {item.content.trim() !== "" && (
          <BarButton
            icon={copyState === "copied" ? "check" : "copy"}
            label={
              copyState === "copied"
                ? t("chat:messageActions.copied")
                : copyState === "failed"
                  ? t("chat:messageActions.copyFailed")
                  : t("chat:messageActions.copy")
            }
            title={t("chat:messageActions.copyTitle")}
            tone={copyState === "copied" ? "ok" : copyState === "failed" ? "danger" : "default"}
            onClick={() => void handleCopy()}
          />
        )}
        {canEditHistory && (
          <>
            <BarButton
              icon="undo"
              label={acting === "rewind" ? t("chat:messageActions.rewinding") : t("chat:messageActions.rewind")}
              title={t("chat:messageActions.rewindTitle")}
              disabledTitle={busyTitle}
              onClick={() => void handleRewind()}
            />
            <BarButton
              icon="branch"
              label={acting === "fork" ? t("chat:messageActions.forking") : t("chat:messageActions.fork")}
              title={t("chat:messageActions.forkTitle")}
              disabledTitle={busyTitle}
              onClick={() => void handleFork()}
            />
          </>
        )}
        {item.kind === "assistant" && (
          <BarButton
            icon="forward"
            label={t("chat:forward.button")}
            title={t("chat:forward.buttonTitle")}
            onClick={() => setForwarding(true)}
          />
        )}
      </div>
      {forwarding && forwardSource && (
        <ForwardMessageDialog source={forwardSource} item={{ content: item.content }} onClose={() => setForwarding(false)} />
      )}
    </>
  );
}
