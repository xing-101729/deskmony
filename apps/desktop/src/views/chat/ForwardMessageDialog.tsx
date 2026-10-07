import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { FORWARD_MESSAGE_MAX_CHARS, type Session } from "@deskmony/shared";
import { providerLabelOf, useSessionStore } from "../../stores/session-store.js";
import { Button } from "../../ui/Button.js";
import { Dialog } from "../../ui/Dialog.js";
import { Field, Select, Textarea } from "../../ui/Field.js";
import { Alert } from "../../ui/Feedback.js";
import { sessionStatusMeta } from "../../ui/status.js";
import { translateError } from "../../lib/error-i18n.js";
import { displaySessionTitle } from "../SessionTitle.js";

/**
 * ForwardMessageDialog.tsx(2026-10-02,P3「session 網路」新增,見
 * docs/LAYER-4-detail-design/simplify-agents-sessions_detail.md §P3.5)。
 *
 * 每則 assistant 訊息的動作列「轉傳到…」開啟的對話框:選目標 session(**所有** session,排除自己)+ 選填附註
 * → `session.forwardMessage`。目標收到的信封標明「使用者從 session X 轉來」,並自己決定要不要處理——系統不會
 * 自動把對方的回答送回來。這是人類操作:開一條新的訊息鏈,不受先前 agent 間鏈熔斷的影響。
 */
export function ForwardMessageDialog({
  source,
  item,
  onClose,
}: {
  /** 訊息所在的 session(也就是「來源」,不能選自己當目標)。 */
  source: Session;
  /** 使用者按下轉傳的那個氣泡——`content` 就是要轉傳的文字(畫面上看到什麼就送什麼)。 */
  item: { content: string };
  onClose: () => void;
}): JSX.Element {
  const { t } = useTranslation(["chat", "common"]);
  const sessions = useSessionStore((s) => s.sessions);
  const detectedAgents = useSessionStore((s) => s.detectedAgents);
  const providerPrefs = useSessionStore((s) => s.providerPrefs);
  const forwardMessage = useSessionStore((s) => s.forwardMessage);
  const [targetId, setTargetId] = useState("");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const targets = useMemo(() => sessions.filter((s) => s.id !== source.id), [sessions, source.id]);
  // gateway 對 `text` 有字元上限;超過就在這裡明講,而不是等 gateway 回一個「無效的請求格式」。
  const tooLong = item.content.length > FORWARD_MESSAGE_MAX_CHARS;

  const handleSubmit = async (): Promise<void> => {
    if (!targetId || tooLong) return;
    setError(null);
    setSubmitting(true);
    try {
      await forwardMessage(source.id, item.content, targetId, note);
      onClose();
    } catch (err) {
      setError(translateError(err, t));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      title={t("chat:forward.dialogTitle")}
      description={t("chat:forward.dialogDescription")}
      icon="forward"
      size="md"
      onClose={onClose}
      footer={
        <div className="flex w-full justify-end gap-2">
          <Button variant="secondary" disabled={submitting} onClick={onClose}>
            {t("common:cancel")}
          </Button>
          <Button variant="primary" disabled={!targetId || submitting || tooLong} loading={submitting} onClick={() => void handleSubmit()}>
            {submitting ? t("chat:forward.sending") : t("chat:forward.submit")}
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <Field label={t("chat:forward.previewLabel")}>
          <pre className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-line-subtle bg-canvas px-2.5 py-2 text-2xs text-fg-muted">
            {item.content}
          </pre>
        </Field>
        <Field label={t("chat:forward.targetLabel")}>
          {targets.length === 0 ? (
            <p className="text-xs text-fg-faint">{t("chat:forward.noTargets")}</p>
          ) : (
            <Select
              aria-label={t("chat:forward.targetLabel")}
              value={targetId}
              onChange={(e) => setTargetId(e.target.value)}
              autoFocus
            >
              <option value="">{t("chat:forward.targetPlaceholder")}</option>
              {targets.map((s) => (
                <option key={s.id} value={s.id}>
                  {displaySessionTitle(s, t)} · {providerLabelOf(s.providerId, detectedAgents, providerPrefs)} · {sessionStatusMeta(s.status).label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t("chat:forward.noteLabel")}>
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            placeholder={t("chat:forward.notePlaceholder")}
          />
        </Field>
        {tooLong && <Alert tone="danger">{t("chat:forward.tooLong", { max: FORWARD_MESSAGE_MAX_CHARS.toLocaleString() })}</Alert>}
        {error && <Alert tone="danger">{error}</Alert>}
      </div>
    </Dialog>
  );
}
