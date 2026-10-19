import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { RecoverySessionInfo } from "@deskmony/shared";
import { useRecoveryStore } from "../stores/recovery-store.js";
import { Dialog } from "../ui/Dialog.js";
import { confirmDialog } from "../ui/ConfirmDialog.js";
import { Button } from "../ui/Button.js";
import { Alert, EmptyState } from "../ui/Feedback.js";
import { useLocale } from "../ui/locale.js";
import { formatDateTime } from "../lib/format-datetime.js";
import type { Locale } from "../lib/locale-storage.js";
import { translateError } from "../lib/error-i18n.js";

interface RecoveryViewProps {
  onClose: () => void;
}

/** i18n 專案新增:改用 formatDateTime()(見 lib/format-datetime.ts)取代原本
 *  沒帶 locale 參數的裸 `.toLocaleString()`——這支是全 app 唯一一處這種寫法
 *  (其餘兩處硬編 "zh-TW" 的呼叫點在其他檔案,不在這批次範圍內)。無時間戳
 *  時顯示的文字改由呼叫端傳入(元件內用 t("common:unknown")),這裡維持是
 *  不依賴 React context 的純函式。 */
function formatTime(ts: number | undefined, locale: Locale, unknownLabel: string): string {
  if (!ts) return unknownLabel;
  return formatDateTime(ts, locale);
}

function RecoveryRow({ session }: { session: RecoverySessionInfo }): JSX.Element {
  const { t } = useTranslation(["recovery", "common"]);
  const locale = useLocale((s) => s.locale);
  const continueSession = useRecoveryStore((s) => s.continueSession);
  const takeover = useRecoveryStore((s) => s.takeover);
  const abandon = useRecoveryStore((s) => s.abandon);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(translateError(err, t));
    } finally {
      setBusy(false);
    }
  };

  const handleAbandon = async (): Promise<void> => {
    const ok = await confirmDialog({
      title: t("recovery:abandonLabel"),
      message: t("recovery:confirmAbandon", { title: session.sessionTitle }),
      confirmLabel: t("recovery:abandonLabel"),
      tone: "danger",
    });
    if (!ok) return;
    void run(() => abandon(session.sessionId));
  };

  return (
    <div className="rounded-md bg-surface p-3.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-fg">{session.sessionTitle}</p>
          <p className="mt-0.5 text-2xs text-fg-faint">
            {t("recovery:sessionMetaLine", {
              agent: session.agentLabel ?? t("recovery:unknownAgent"),
              interruptedAt: formatTime(session.interruptedAt, locale, t("common:unknown")),
              lastSeenAt: formatTime(session.lastSeenAt, locale, t("common:unknown")),
            })}
          </p>
        </div>
      </div>

      {error && <Alert tone="danger" className="mt-2">{error}</Alert>}

      <div className="mt-2 flex flex-wrap gap-2">
        {/* §4.1:不支援「繼續」的後端,這個按鈕整個不出現(不是灰掉)。 */}
        {session.canContinue && (
          <Button size="sm" variant="primary" disabled={busy} title={t("recovery:continueTitle")} onClick={() => void run(() => continueSession(session.sessionId))}>
            {t("recovery:continueLabel")}
          </Button>
        )}
        <Button size="sm" variant="outline" disabled={busy} title={t("recovery:takeoverTitle")} onClick={() => void run(() => takeover(session.sessionId))}>
          {t("recovery:takeoverLabel")}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} className="hover:!text-danger" onClick={() => void handleAbandon()}>
          {t("recovery:abandonLabel")}
        </Button>
      </div>
    </div>
  );
}

/**
 * S6(crash-recovery)L4 §5:復原視圖——列出所有 `interrupted` session,供人
 * 逐一分流(繼續/接手/放棄)。**入口是 App.tsx 的常駐提示條**,這個元件
 * 本身是被動的:不會自己彈出,也不會自動對任何一列採取行動(D3)。
 *
 * 2026-10-02(移除 team/task/看板,見 docs/DECISIONS.md §H):原本的「重跑」、
 * 任務/worktree 資訊與髒 worktree 處理流程已移除,只剩 session 對帳。
 */
export function RecoveryView({ onClose }: RecoveryViewProps): JSX.Element {
  const { t } = useTranslation(["recovery", "common"]);
  const sessions = useRecoveryStore((s) => s.sessions);
  const loading = useRecoveryStore((s) => s.loading);

  return (
    <Dialog
      title={t("recovery:title")}
      description={t("recovery:description")}
      icon="alert"
      size="lg"
      onClose={onClose}
    >
      <div className="space-y-2">
        {loading && sessions.length === 0 && <p className="py-6 text-center text-xs text-fg-faint">{t("common:loading")}</p>}
        {!loading && sessions.length === 0 && <EmptyState icon="check" title={t("recovery:emptyTitle")} compact />}
        {sessions.map((session) => (
          <RecoveryRow key={session.sessionId} session={session} />
        ))}
      </div>
    </Dialog>
  );
}
