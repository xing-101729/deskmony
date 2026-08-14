import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { Session } from "@deskmony/shared";
import { useSessionStore } from "../stores/session-store.js";
import { Dialog } from "../ui/Dialog.js";
import { Button } from "../ui/Button.js";
import { Badge } from "../ui/Badge.js";
import { Icon } from "../ui/icons.js";

/**
 * S7(auto-mode-and-yolo)L4 §6:ChatView 標頭的 auto 常駐標記(HLD §2.2
 * 補償防護,YOLO 是無人值守/隨時可能忘記關的東西,標頭必須隨時提醒目前
 * 開著)+ auto/YOLO 切換鈕。
 *
 * **遠端隱藏**:`gatewayCapabilities.canToggleAuto`/`canEnableYolo` 為 `false`
 * 時完全不渲染切換鈕——但這只是 UI 體驗,**真正的安全保證在 Gateway 每次
 * 呼叫的檢查**(`LOCAL_ONLY_METHODS`),不是這裡隱藏了按鈕才安全。
 *
 * **YOLO 鈕刻意不與 auto 鈕相鄰**(L4 §3 硬性要求,避免手滑誤觸)——改版後
 * 兩者中間隔著常駐標記徽章,視覺上仍維持這個間隔;YOLO 鈕額外用 `danger`
 * 語氣(而非 outline),讓「這是危險操作」在配色上就先傳達出來,不需要等
 * hover 才知道。
 *
 * i18n 專案新增:徽章內文「YOLO」/「AUTO」刻意不經過 t() ——比照
 * ui/status.ts 的 softwareBadge 慣例,這是產品專有的模式名稱縮寫(見
 * locales/GLOSSARY.md),四語言一律保留原文。
 */
export function AutoModeControl({ session }: { session: Session }): JSX.Element | null {
  const { t } = useTranslation(["autoMode", "common"]);
  const capabilities = useSessionStore((s) => s.gatewayCapabilities);
  const setSessionPermissionMode = useSessionStore((s) => s.setSessionPermissionMode);
  const [showYoloConfirm, setShowYoloConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  const mode = session.permissionMode ?? "always-ask";
  const isAuto = mode === "auto-accept-edits";
  const isYolo = mode === "auto-accept-all";

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

  const badge =
    mode === "always-ask" ? null : (
      <Badge
        tone={isYolo ? "danger" : "warn"}
        icon="zap"
        title={
          isYolo
            ? session.yoloExpiresAt
              ? t("autoMode:yoloEnabledTitleWithExpiry", {
                  minutes: Math.max(0, Math.round((session.yoloExpiresAt - Date.now()) / 60_000)),
                })
              : t("autoMode:yoloEnabledTitle")
            : t("autoMode:autoEnabledTitle")
        }
        className="uppercase tracking-wide"
      >
        {isYolo ? "YOLO" : "AUTO"}
      </Badge>
    );

  const canToggleAuto = capabilities.canToggleAuto;
  const canEnableYolo = capabilities.canEnableYolo;
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

      {showYoloConfirm && (
        <YoloConfirmDialog
          onCancel={() => setShowYoloConfirm(false)}
          onConfirm={() => {
            setShowYoloConfirm(false);
            void applyMode("auto-accept-all");
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
