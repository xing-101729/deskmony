import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { Session } from "@deskmony/shared";
import { useSessionStore } from "../stores/session-store.js";
import { Dialog } from "../ui/Dialog.js";
import { Button } from "../ui/Button.js";
import { Input } from "../ui/Field.js";
import { Badge } from "../ui/Badge.js";
import { Icon } from "../ui/icons.js";

/**
 * S7(auto-mode-and-yolo)L4 §6:ChatView 標頭的 auto 常駐標記(HLD §2.2
 * 補償防護,YOLO 是無人值守/隨時可能忘記關的東西,標頭必須隨時提醒目前
 * 開著)+ auto/YOLO 切換鈕。
 *
 * ⚠️ 2026-08-25 修訂(見 docs/DECISIONS.md §G):`canToggleAuto`/`canEnableYolo`
 * 現在恆為 `true`(本機遠端同權,使用者明確翻案),下面「遠端隱藏」這段話
 * 已不成立——控制項一律顯示,**真正的安全保證在 Gateway 每次呼叫的檢查**
 * (`session.setPermissionMode`/`session.setTrueUnrestricted` 兩者皆同),
 * 不是靠這裡隱藏了按鈕才安全,這個原則本身沒有變。
 *
 * **YOLO 鈕刻意不與 auto 鈕相鄰**(L4 §3 硬性要求,避免手滑誤觸)——改版後
 * 兩者中間隔著常駐標記徽章,視覺上仍維持這個間隔;YOLO 鈕額外用 `danger`
 * 語氣(而非 outline),讓「這是危險操作」在配色上就先傳達出來,不需要等
 * hover 才知道。
 *
 * **「真.無限制」鈕(2026-08-25 新增)只在 YOLO 已經開啟時才渲染**——DOM 裡
 * 都還沒這顆按鈕,這就是「比 YOLO 更難按」的具體做法(見 DECISIONS.md C6),
 * 不需要額外的 disabled 邏輯。啟用需要在確認對話框裡打對一段固定字串,是
 * 全 app 目前唯一的「輸入文字才能確認」模式,理由見
 * `TrueUnrestrictedConfirmDialog` 註解。
 *
 * i18n 專案新增:徽章內文「YOLO」/「AUTO」/「UNRESTRICTED」刻意不經過 t()
 * ——比照 ui/status.ts 的 softwareBadge 慣例,這是產品專有的模式名稱縮寫
 * (見 locales/GLOSSARY.md),四語言一律保留原文。
 */
export function AutoModeControl({ session }: { session: Session }): JSX.Element | null {
  const { t } = useTranslation(["autoMode", "common"]);
  const capabilities = useSessionStore((s) => s.gatewayCapabilities);
  const setSessionPermissionMode = useSessionStore((s) => s.setSessionPermissionMode);
  const setSessionTrueUnrestricted = useSessionStore((s) => s.setSessionTrueUnrestricted);
  const [showYoloConfirm, setShowYoloConfirm] = useState(false);
  const [showUnrestrictedConfirm, setShowUnrestrictedConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  const mode = session.permissionMode ?? "always-ask";
  const isAuto = mode === "auto-accept-edits";
  const isYolo = mode === "auto-accept-all";
  const isUnrestricted = isYolo && session.trueUnrestricted === true;

  const applyMode = async (next: Parameters<typeof setSessionPermissionMode>[1]): Promise<void> => {
    setBusy(true);
    try {
      await setSessionPermissionMode(session.id, next);
    } catch (err) {
      console.error("[auto-mode] 切換權限模式失敗:", err instanceof Error ? err.message : err);
    } finally {
      setBusy(false);
    }
  };

  const applyUnrestricted = async (enabled: boolean): Promise<void> => {
    setBusy(true);
    try {
      await setSessionTrueUnrestricted(session.id, enabled);
    } catch (err) {
      console.error("[auto-mode] 切換 true-unrestricted 失敗:", err instanceof Error ? err.message : err);
    } finally {
      setBusy(false);
    }
  };

  const handleAutoClick = (): void => {
    void applyMode(mode === "always-ask" ? "auto-accept-edits" : "always-ask");
  };

  const handleYoloClick = (): void => {
    if (isYolo) {
      void applyMode("always-ask");
      return;
    }
    setShowYoloConfirm(true);
  };

  const handleUnrestrictedClick = (): void => {
    if (isUnrestricted) {
      void applyUnrestricted(false);
      return;
    }
    setShowUnrestrictedConfirm(true);
  };

  const badge =
    mode === "always-ask" ? null : (
      <Badge
        tone="danger"
        icon="zap"
        title={
          isUnrestricted
            ? t("autoMode:unrestrictedEnabledTitle")
            : isYolo
              ? session.yoloExpiresAt
                ? t("autoMode:yoloEnabledTitleWithExpiry", {
                    minutes: Math.max(0, Math.round((session.yoloExpiresAt - Date.now()) / 60_000)),
                  })
                : t("autoMode:yoloEnabledTitle")
              : t("autoMode:autoEnabledTitle")
        }
        className={`uppercase tracking-wide ${isYolo ? "" : "!bg-warn/12 !text-warn"}`}
      >
        {isUnrestricted ? "UNRESTRICTED" : isYolo ? "YOLO" : "AUTO"}
      </Badge>
    );

  const canToggleAuto = capabilities.canToggleAuto;
  const canEnableYolo = capabilities.canEnableYolo;
  const canEnableTrueUnrestricted = capabilities.canEnableTrueUnrestricted;
  if (!canToggleAuto && !canEnableYolo && !badge) return null;

  return (
    <div className="flex flex-shrink-0 items-center gap-1.5">
      {canToggleAuto && (
        <Button
          size="xs"
          variant={isAuto ? "accentSoft" : "outline"}
          disabled={busy}
          onClick={handleAutoClick}
          title={t("autoMode:autoToggleTitle")}
          className={isAuto ? "!bg-warn/12 !text-warn" : ""}
        >
          {isAuto ? t("autoMode:autoOnLabel") : t("autoMode:autoOffLabel")}
        </Button>
      )}

      {badge}

      {canEnableYolo && (
        <Button
          size="xs"
          variant={isYolo ? "danger" : "outline"}
          disabled={busy}
          onClick={handleYoloClick}
          title={t("autoMode:yoloToggleTitle")}
        >
          {isYolo ? t("autoMode:yoloOffLabel") : t("autoMode:yoloOnLabel")}
        </Button>
      )}

      {isYolo && canEnableTrueUnrestricted && (
        <Button
          size="xs"
          variant={isUnrestricted ? "danger" : "outline"}
          disabled={busy}
          onClick={handleUnrestrictedClick}
          title={t("autoMode:unrestrictedToggleTitle")}
          className={isUnrestricted ? "" : "!border-danger/40 !text-danger"}
        >
          {isUnrestricted ? t("autoMode:unrestrictedOffLabel") : t("autoMode:unrestrictedOnLabel")}
        </Button>
      )}

      {showYoloConfirm && (
        <YoloConfirmDialog
          onCancel={() => setShowYoloConfirm(false)}
          onConfirm={() => {
            setShowYoloConfirm(false);
            void applyMode("auto-accept-all");
          }}
        />
      )}

      {showUnrestrictedConfirm && (
        <TrueUnrestrictedConfirmDialog
          isRemote={capabilities.isRemoteConnection}
          onCancel={() => setShowUnrestrictedConfirm(false)}
          onConfirm={() => {
            setShowUnrestrictedConfirm(false);
            void applyUnrestricted(true);
          }}
        />
      )}
    </div>
  );
}

/** L4 §3:YOLO 啟用確認——獨立對話框,取消為預設(不 autoFocus 到啟用鈕)。 */
function YoloConfirmDialog({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: () => void }): JSX.Element {
  const { t } = useTranslation(["autoMode", "common"]);
  return (
    <Dialog
      title={t("autoMode:confirmDialogTitle")}
      icon="zap"
      tone="danger"
      size="sm"
      dismissible={false}
      footer={
        <div className="flex w-full justify-end gap-2">
          <Button variant="secondary" autoFocus onClick={onCancel}>
            {t("common:cancel")}
          </Button>
          <Button variant="danger" onClick={onConfirm}>
            {t("autoMode:yoloOnLabel")}
          </Button>
        </div>
      }
    >
      <ul className="space-y-1.5 text-xs leading-relaxed text-fg-soft">
        <li className="flex gap-1.5">
          <Icon name="alert" size={13} className="mt-0.5 flex-shrink-0 text-danger" />
          {t("autoMode:risk1")}
        </li>
        <li className="flex gap-1.5">
          <Icon name="clock" size={13} className="mt-0.5 flex-shrink-0 text-fg-faint" />
          {t("autoMode:risk2")}
        </li>
        <li className="flex gap-1.5">
          <Icon name="shield" size={13} className="mt-0.5 flex-shrink-0 text-ok" />
          <span>
            <span className="font-medium text-fg">{t("autoMode:risk3Bold")}</span>
            {t("autoMode:risk3Rest")}
          </span>
        </li>
      </ul>
    </Dialog>
  );
}

/** 2026-08-25 新增(見 docs/DECISIONS.md §G):輸入這個文字才能確認的固定
 *  字串——刻意不經過 t()、四語言一律相同(比照 GLOSSARY.md 的 AUTO/YOLO
 *  徽章慣例):這是唯一能繞過 hard-deny 的開關,翻譯過的確認字串會讓「更難
 *  按」變成語言差異造成的「翻譯困擾」,而不是刻意的摩擦力。 */
const UNRESTRICTED_CONFIRM_PHRASE = "UNRESTRICTED";

/**
 * 2026-08-25 新增(見 docs/DECISIONS.md §G):「真.無限制」啟用確認——結構
 * 比照 `YoloConfirmDialog`(danger tone、不可用 Esc/點遮罩關閉、取消鈕
 * autoFocus),但這是全 app 第一個要求「打對一段文字才能按下確認鈕」的
 * 對話框:這個開關繞過的是連本機 YOLO 都攻不破的 hard-deny 地板,一個誤點
 * 的代價遠比誤開 YOLO 高,值得比單純點兩下更高的摩擦力。
 */
function TrueUnrestrictedConfirmDialog({
  isRemote,
  onCancel,
  onConfirm,
}: {
  isRemote: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}): JSX.Element {
  const { t } = useTranslation(["autoMode", "common"]);
  const [confirmText, setConfirmText] = useState("");
  const confirmed = confirmText === UNRESTRICTED_CONFIRM_PHRASE;

  return (
    <Dialog
      title={t("autoMode:unrestrictedConfirmDialogTitle")}
      icon="alert"
      tone="danger"
      size="sm"
      dismissible={false}
      footer={
        <div className="flex w-full justify-end gap-2">
          <Button variant="secondary" autoFocus onClick={onCancel}>
            {t("common:cancel")}
          </Button>
          <Button variant="danger" disabled={!confirmed} onClick={onConfirm}>
            {t("autoMode:unrestrictedOnLabel")}
          </Button>
        </div>
      }
    >
      <ul className="space-y-1.5 text-xs leading-relaxed text-fg-soft">
        <li className="flex gap-1.5">
          <Icon name="alert" size={13} className="mt-0.5 flex-shrink-0 text-danger" />
          {t("autoMode:unrestrictedRisk1")}
        </li>
        <li className="flex gap-1.5">
          <Icon name="alert" size={13} className="mt-0.5 flex-shrink-0 text-danger" />
          <ul className="list-disc space-y-0.5 pl-4">
            <li>{t("autoMode:unrestrictedRiskCategory1")}</li>
            <li>{t("autoMode:unrestrictedRiskCategory2")}</li>
            <li>{t("autoMode:unrestrictedRiskCategory3")}</li>
            <li>{t("autoMode:unrestrictedRiskCategory4")}</li>
          </ul>
        </li>
        <li className="flex gap-1.5">
          <Icon name="clock" size={13} className="mt-0.5 flex-shrink-0 text-fg-faint" />
          {t("autoMode:unrestrictedRisk2")}
        </li>
        {isRemote && (
          <li className="flex gap-1.5 rounded-md bg-danger/10 px-2 py-1.5">
            <Icon name="external" size={13} className="mt-0.5 flex-shrink-0 text-danger" />
            <span className="font-medium text-danger">{t("autoMode:unrestrictedRiskRemote")}</span>
          </li>
        )}
      </ul>
      <div className="mt-3 space-y-1">
        <label htmlFor="unrestricted-confirm-input" className="text-2xs text-fg-faint">
          {t("autoMode:unrestrictedTypeToConfirm", { phrase: UNRESTRICTED_CONFIRM_PHRASE })}
        </label>
        <Input
          id="unrestricted-confirm-input"
          mono
          autoFocus={false}
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          placeholder={UNRESTRICTED_CONFIRM_PHRASE}
          invalid={confirmText.length > 0 && !confirmed}
        />
      </div>
    </Dialog>
  );
}
