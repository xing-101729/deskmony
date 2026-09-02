export {};

declare global {
  interface Window {
    deskmony?: {
      corePort: number;
      gatewayUrl: string;
      /** M5 Round A:electron main process 產生的認證 token(見
       *  electron/main.ts、electron/preload.ts)。core 未啟用認證時為
       *  undefined,GatewayClient 對此已有相容處理。 */
      authToken?: string;
      /** M5 Round E(需求1):開啟原生「選擇資料夾」對話框,回傳選到的完整
       *  路徑;使用者取消回傳 `null`。只在 Electron 場景存在——純瀏覽器
       *  client 讀到的 `window.deskmony` 整個是 `undefined`,呼叫端
       *  (ProfileCreateDialog.tsx)需自行對 `window.deskmony?.pickDirectory`
       *  做存在性檢查,不存在時隱藏「瀏覽…」按鈕、維持手動文字輸入。 */
      pickDirectory?: () => Promise<string | null>;
      /** 見 electron/main.ts 的 `deskmony:focusWindow` IPC handler 註解:把
       *  OS 層級的 BrowserWindow focus 要回來——DOM `element.focus()` 只能
       *  移動這個視窗「內部」的 focus,收不到真正鍵盤事件時(使用者得
       *  alt-tab 才能打字)靠這個補上真正的 OS 焦點。只在 Electron 場景
       *  存在,純瀏覽器 client 沒有對應的 OS 視窗可以 focus。 */
      focusWindow?: () => Promise<void>;
      /** S11(Notification):顯示原生桌面通知(見 electron/main.ts 的
       *  `deskmony:notify` IPC handler)。只在 Electron 場景存在——純瀏覽器
       *  client 讀到的 `window.deskmony` 整個是 `undefined`,呼叫端
       *  (session-store.ts)需自行做存在性檢查,不存在時純粹略過桌面通知
       *  (仍然可能透過 webhook 通道送達,見 notification_detail.md §6)。 */
      notify?: (payload: { title: string; body: string; sessionId?: string }) => Promise<void>;
      /** S11:訂閱「使用者點擊了原生通知」事件,回傳取消訂閱函式(見
       *  electron/preload.cts 的 `onNotificationClick()`)。 */
      onNotificationClick?: (callback: (sessionId: string) => void) => () => void;
      /** Settings UI「遠端存取 token」區塊用(見 electron/main.ts 的
       *  `resolveAuthToken()`/`currentAuthTokenInfo()` 註解)。`locked` 為真
       *  時表示由 `DESKMONY_AUTH_TOKEN` 環境變數決定,`setAuthToken`/
       *  `regenerateAuthToken` 會被 main process 拒絕;`persisted` 為假時表示
       *  這台機器目前無法使用 `safeStorage` 加密儲存,值僅本次執行有效。只在
       *  Electron 場景存在。 */
      getAuthTokenInfo?: () => Promise<{ token: string; locked: boolean; persisted: boolean }>;
      /** 設定自訂 token(至少 8 個字元)。`locked` 為真時 main process 會
       *  拒絕(拋出例外)。變更只影響下次啟動 Deskmony 時套用的值,不會追溯
       *  套用到目前已在跑的 core 子程序。 */
      setAuthToken?: (value: string) => Promise<{ token: string; locked: boolean; persisted: boolean }>;
      /** 隨機產生一組新 token(32 bytes hex)並嘗試加密保存。語意同
       *  `setAuthToken`。 */
      regenerateAuthToken?: () => Promise<{ token: string; locked: boolean; persisted: boolean }>;
    };
  }
}
