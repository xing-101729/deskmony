import { useState } from "react";
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
 */
export function AutoModeControl({ session }: { session: Session }): JSX.Element | null {
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
            ? `YOLO 已啟用:繞過 config 政策(hard-deny 仍生效)${
                session.yoloExpiresAt ? `,約 ${Math.max(0, Math.round((session.yoloExpiresAt - Date.now()) / 60_000))} 分鐘後自動關閉` : ""
              }`
            : "Auto 已啟用:自動放行未分類操作(config 的 deny 規則仍生效)"
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
          title="Auto:自動放行未分類的中間地帶操作,仍受 config 的 deny 規則與 hard-deny 約束"
          className={isAuto ? "!bg-warn/12 !text-warn" : ""}
        >
          {isAuto ? "Auto 開啟中" : "開啟 Auto"}
        </Button>
      )}

      {badge}

      {canEnableYolo && (
        <Button
          size="xs"
          variant={isYolo ? "danger" : "outline"}
          disabled={busy}
          onClick={handleYoloClick}
          title="YOLO:繞過 config 的所有規則,30 分鐘後自動關閉;hard-deny 永遠不受影響"
        >
          {isYolo ? "關閉 YOLO" : "啟用 YOLO"}
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
  return (
    <Dialog
      title="啟用 YOLO?"
      icon="zap"
      tone="danger"
      size="sm"
      dismissible={false}
      footer={
        <div className="flex w-full justify-end gap-2">
          <Button variant="secondary" autoFocus onClick={onCancel}>
            取消
          </Button>
          <Button variant="danger" onClick={onConfirm}>
            啟用 YOLO
          </Button>
        </div>
      }
    >
      <ul className="space-y-1.5 text-xs leading-relaxed text-fg-soft">
        <li className="flex gap-1.5">
          <Icon name="alert" size={13} className="mt-0.5 flex-shrink-0 text-danger" />
          將繞過 config 裡設定的所有政策規則(包含你自訂的 deny 規則)。
        </li>
        <li className="flex gap-1.5">
          <Icon name="clock" size={13} className="mt-0.5 flex-shrink-0 text-fg-faint" />
          30 分鐘後自動關閉,回到一般確認模式。
        </li>
        <li className="flex gap-1.5">
          <Icon name="shield" size={13} className="mt-0.5 flex-shrink-0 text-ok" />
          <span>
            <span className="font-medium text-fg">硬性禁止項(hard-deny)不受影響</span>
            ——worktree 外寫入、讀取密鑰路徑、force-push 等操作仍會被拒絕或需要強制確認。
          </span>
        </li>
      </ul>
    </Dialog>
  );
}
