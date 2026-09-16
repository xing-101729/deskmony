import React from "react";

/**
 * 2026-09-04(稽核修補):全 app 的 render 例外安全網。
 *
 * ---- 為什麼需要 --------------------------------------------------------
 *
 * 在此之前整個 `apps/desktop/src` 找不到任何 `componentDidCatch` /
 * `getDerivedStateFromError` —— 也就是說**任何**一個子元件在 render 期間拋出
 * 例外,React 就會卸載整棵樹,使用者看到全白畫面,唯一的復原方式是重開 app。
 *
 * 對這個 app 來說這個缺口特別要緊:它整天在渲染 **agent 產生的不可信內容**
 * (markdown、程式碼區塊、工具輸出、diff、結構化 widget)。目前讀過的
 * `chat/` 子元件對形狀都有手動驗證、失敗會安全 fallback,所以我沒能指出一個
 * 確定會炸的輸入 —— 但「現在剛好沒有」與「有安全網」是兩回事,而缺這張網的
 * 代價是整個 app 消失,不是一塊區域壞掉。
 *
 * ---- 設計 --------------------------------------------------------------
 *
 * **分兩層用**(見 `App.tsx`):
 *   - 最外層包住整個 app:最後防線,壞掉時至少還能給一個「重新載入」按鈕,
 *     而不是一片白。
 *   - 內層各自包住主要視圖:一個 session 的聊天內容炸掉時,側邊欄、設定、
 *     其他 session 仍然可用 —— 這才是有價值的隔離,只包最外層等於只是把白畫面
 *     換成錯誤畫面。
 *
 * 刻意**不**做自動重試:render 例外通常是決定性的(同樣的資料會再炸一次),
 * 自動重試只會變成無限迴圈。由使用者決定要重試還是重載。
 *
 * 這個檔案刻意不用 i18next —— `useTranslation()` 是 hook,不能在 class
 * component 裡用,而 error boundary 目前只能是 class component(React 尚未提供
 * hook 版本)。把 i18n 的文字透過 props 傳進來會讓「最外層那一個」在 i18n 本身
 * 初始化失敗時反而不能顯示任何東西 —— 這裡的文案刻意寫死中英雙語,確保它在
 * 任何情況下都顯示得出來。
 */

interface Props {
  children: React.ReactNode;
  /** 顯示在錯誤畫面上的區域名稱,例如 "聊天視圖"。用來讓使用者知道壞的是哪一塊。 */
  label?: string;
  /**
   * 讓外層可以在切換 session/視圖時自動清掉錯誤狀態 —— 值改變就重置。
   * 沒有這個的話,一個 session 炸掉之後切到別的 session 仍然看到錯誤畫面。
   */
  resetKey?: string | number;
}

interface State {
  error: Error | undefined;
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: undefined };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidUpdate(prevProps: Props): void {
    if (prevProps.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: undefined });
    }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // 這是目前唯一會記錄 render 例外的地方 —— 在此之前它們只會讓畫面消失,
    // 連 console 都不一定留下有用的堆疊。
    console.error(
      `[error-boundary] ${this.props.label ?? "app"} render 時拋出例外(該區域已被隔離,其餘部分仍可用):`,
      error,
      info.componentStack,
    );
  }

  private handleRetry = (): void => {
    this.setState({ error: undefined });
  };

  private handleReload = (): void => {
    window.location.reload();
  };

  render(): React.ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    const where = this.props.label ? `「${this.props.label}」` : "";
    return (
      <div className="flex h-full w-full items-center justify-center p-6">
        <div className="max-w-lg rounded-md border border-danger/40 bg-danger/5 p-5">
          <h2 className="m-0 text-sm font-semibold text-danger">
            {where}發生未預期的錯誤 / Something went wrong{where && ` in ${this.props.label}`}
          </h2>
          <p className="mt-2 text-xs leading-relaxed text-fg-muted">
            這一塊畫面已被隔離,app 的其他部分應該仍可正常使用。若重試無效,請重新載入。
            <br />
            This section has been isolated; the rest of the app should still work. Reload if retrying doesn’t help.
          </p>
          <pre className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-canvas px-2 py-1.5 font-mono text-2xs text-fg-muted">
            {error.message}
          </pre>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={this.handleRetry}
              className="rounded border border-border px-2.5 py-1 text-xs hover:bg-surface-hover"
            >
              重試 / Retry
            </button>
            <button
              type="button"
              onClick={this.handleReload}
              className="rounded border border-border px-2.5 py-1 text-xs hover:bg-surface-hover"
            >
              重新載入 / Reload
            </button>
          </div>
        </div>
      </div>
    );
  }
}
