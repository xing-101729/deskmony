import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { create } from "zustand";
import { Button } from "./Button.js";
import { Dialog } from "./Dialog.js";
import type { IconName } from "./icons.js";

/**
 * App 內確認框,取代原生 `window.confirm()`。**新程式碼不要再用 `window.confirm()`/`alert()`。**
 *
 * 根因(2026-10-06 用真實打包的 app 重現,master 與 feat/simplify-agent-sessions 都會):
 * Windows 上的 Electron 關掉原生 `confirm()` 對話框之後,視窗雖然還在前景,頁面卻收不到
 * 鍵盤——點輸入框打字沒反應、原生 `<select>` 下拉選單也打不開,要切到別的視窗再切回來
 * 才恢復。對話框關閉約半秒後 `document.hasFocus()` 變成 false;在 `confirm()` 回傳後呼叫
 * main process 的 `BrowserWindow.focus()`(`window.deskmony.focusWindow()`)也救不回來
 * ——視窗本來就是前景視窗,那個呼叫等於沒做事。所以不去「事後補焦點」,而是根本不開原生
 * 對話框:用既有的 `Dialog`(經 `ModalPortal`)畫在頁面裡,焦點從頭到尾沒離開 webContents。
 *
 * 用法與 `window.confirm()` 一樣是「問一句、拿到 true/false」,呼叫端不必各自管理開關狀態:
 *
 *     if (!(await confirmDialog({ title, message }))) return;
 *
 * 畫面由 App.tsx 掛一次的 `<ConfirmDialogHost />` 負責。
 */
export interface ConfirmDialogOptions {
  title: string;
  /** 內文,保留 `\n` 換行(沿用原本寫給原生 `confirm()` 的多行字串)。 */
  message: string;
  /** 確認鈕文字,預設 `common:confirm`。 */
  confirmLabel?: string;
  /** 不可復原的操作用 `danger`:紅色外框 + 紅色確認鈕。 */
  tone?: "default" | "danger";
  icon?: IconName;
}

interface PendingConfirm {
  /** 每次請求一個新 id,當 React key 用——連續兩次確認時讓 `ModalPortal` 重新掛載、重新抓焦點。 */
  id: number;
  options: ConfirmDialogOptions;
  resolve: (ok: boolean) => void;
}

const useConfirmStore = create<{ pending: PendingConfirm | null }>(() => ({ pending: null }));
let nextId = 1;

export function confirmDialog(options: ConfirmDialogOptions): Promise<boolean> {
  return new Promise((resolve) => {
    // 同時只顯示一個:前一個還沒回答就視同取消,不讓它的 Promise 永遠懸著。
    useConfirmStore.getState().pending?.resolve(false);
    useConfirmStore.setState({ pending: { id: nextId++, options, resolve } });
  });
}

function settle(ok: boolean): void {
  const pending = useConfirmStore.getState().pending;
  if (!pending) return;
  useConfirmStore.setState({ pending: null });
  pending.resolve(ok);
}

export function ConfirmDialogHost(): JSX.Element | null {
  const pending = useConfirmStore((s) => s.pending);
  if (!pending) return null;
  return <ConfirmDialogView key={pending.id} options={pending.options} />;
}

function ConfirmDialogView({ options }: { options: ConfirmDialogOptions }): JSX.Element {
  const { t } = useTranslation(["common"]);
  const danger = options.tone === "danger";

  // Esc = 取消(與原生 confirm() 相同)。掛在 capture 階段並 stopImmediatePropagation:確認框
  // 可能疊在另一個 Dialog 上(例如復原視圖),那個 Dialog 也在 window 上聽 Esc,不攔下來會連
  // 底下的對話框一起關掉。
  //
  // Dialog 的 `dismissible` 刻意關掉:開著的話標頭會多一顆關閉鈕,`ModalPortal` 會把預設焦點放
  // 在它身上;關掉後第一個可聚焦元素就是「取消」——不可復原的操作,預設焦點不該落在確認鈕上
  // (同 AutoModeControl.tsx 的 YoloConfirmDialog)。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.stopImmediatePropagation();
      settle(false);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  return (
    <Dialog
      title={options.title}
      icon={options.icon ?? (danger ? "alert" : undefined)}
      tone={options.tone}
      size="sm"
      dismissible={false}
      footer={
        <div className="flex w-full justify-end gap-2">
          <Button variant="secondary" onClick={() => settle(false)}>
            {t("common:cancel")}
          </Button>
          <Button variant={danger ? "danger" : "primary"} onClick={() => settle(true)}>
            {options.confirmLabel ?? t("common:confirm")}
          </Button>
        </div>
      }
    >
      <p className="whitespace-pre-line text-xs leading-relaxed text-fg-soft">{options.message}</p>
    </Dialog>
  );
}
