import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";

/**
 * Preload script:把 Core Gateway 的連線位址(port)+ 認證 token 曝露給
 * renderer。Renderer 直接用瀏覽器原生 WebSocket 連上 apps/core 的
 * Gateway,不需要透過 IPC 轉發 —— 這也呼應「Core 是獨立 client-agnostic
 * headless server」的設計(ARCHITECTURE.md 第 10 節)。
 *
 * M5 Round A(任務2):`DESKMONY_AUTH_TOKEN` 由 electron/main.ts 的
 * startCore() 產生並設進 `process.env`(同一份值同時傳給 core 子程序與這裡
 * 的 preload,見 main.ts 內註解)—— preload 腳本雖然執行在 renderer
 * process,但 Electron 對 Node 整合的 preload 腳本仍會繼承 main process 當下
 * 的環境變數(現有的 `DESKMONY_CORE_PORT` 就是同樣的機制),因此這裡直接讀
 * `process.env.DESKMONY_AUTH_TOKEN` 即可,不需要額外的 IPC 往返。token 只
 * 經由 `contextBridge` 曝露給 renderer 記憶體內的 `window.deskmony`,不寫入
 * 任何檔案或 log。
 *
 * 檔名為什麼是 `.cts` 而不是 `.ts`(修 bug 記錄,實測驗證見 README):
 * `apps/desktop/package.json` 宣告 `"type": "module"`,`tsconfig.electron.json`
 * 用 `"module": "NodeNext"` 編譯 —— 這對 main.ts 沒問題(Electron main
 * process 本來就用 `import()` 動態載入、`app.whenReady()` 等 ESM 語法正常
 * 執行),但實測發現 Electron 載入傳統(非 sandbox,見 main.ts
 * `webPreferences`)preload script 的機制(`runPreloadScript`)是用類似
 * CommonJS 的方式同步執行 preload 檔案,**不支援**檔案裡出現 `import`
 * 陳述式 —— 即使 Electron 33 的 Node 版本本身支援 ESM。實測現象:打包後的
 * exe 開啟 DevTools console 會看到
 *   `Unable to load preload script: .../dist-electron/preload.js`
 *   `SyntaxError: Cannot use import statement outside a module`
 * 導致 `contextBridge.exposeInMainWorld` 那行完全沒執行到,renderer 讀不到
 * `window.deskmony`,退回顯示 `ConnectScreen`(見 src/App.tsx 的
 * `hasElectronBridge` 判斷)。
 *
 * 修法:用 TypeScript 的 `.cts` 副檔名(TS 4.7+)—— `.cts` 檔案一律被當成
 * CommonJS 模組編譯,產出 `.cjs` 檔案,且**不受**同目錄 `package.json` 的
 * `"type": "module"` 宣告影響(Node/Electron 對 `.cjs` 副檔名一律當
 * CommonJS 載入,這是 Node 官方文件明載的行為)。`main.ts` 保持
 * `.ts`(仍走 NodeNext ESM 編譯,行為不變),只有 preload 這個檔案需要
 * CommonJS 輸出。
 */
const corePort = Number(process.env.DESKMONY_CORE_PORT ?? 4317);
const authToken = process.env.DESKMONY_AUTH_TOKEN || undefined;

/**
 * M5 Round E(需求1):把「選擇資料夾」原生對話框(見 electron/main.ts 的
 * `deskmony:pickDirectory` IPC handler)包成一個 renderer 可直接呼叫的
 * async function。回傳選到的完整路徑,使用者取消時回傳 `null`。
 */
function pickDirectory(): Promise<string | null> {
  return ipcRenderer.invoke("deskmony:pickDirectory");
}

/** 見 electron/main.ts 的 `deskmony:focusWindow` handler 註解:把 OS 層級的
 *  BrowserWindow focus 曝露給 renderer,配合 DOM `element.focus()` 一起用。 */
function focusWindow(): Promise<void> {
  return ipcRenderer.invoke("deskmony:focusWindow");
}

/**
 * S11(Notification)新增:把 electron/main.ts 的 `deskmony:notify` IPC 包成
 * renderer 可直接呼叫的 async function(見 session-store.ts 收到
 * `"enforcement-notification"` push 後呼叫的地方),以及訂閱「使用者點擊了
 * 原生通知」事件(main.ts 的 `notification.on("click", ...)` 轉發過來,見
 * App.tsx 的訂閱處,聚焦對應 session)。回傳取消訂閱函式,比照一般
 * event-listener 的慣例。
 */
function notify(payload: { title: string; body: string; sessionId?: string }): Promise<void> {
  return ipcRenderer.invoke("deskmony:notify", payload);
}

function onNotificationClick(callback: (sessionId: string) => void): () => void {
  const listener = (_event: IpcRendererEvent, sessionId: string): void => callback(sessionId);
  ipcRenderer.on("deskmony:notification-clicked", listener);
  return () => ipcRenderer.removeListener("deskmony:notification-clicked", listener);
}

interface AuthTokenInfo {
  token: string;
  locked: boolean;
  persisted: boolean;
}

/**
 * 使用者需求(2026-09):Settings UI 需要顯示/複製/自訂/重新產生桌面殼目前
 * 使用的認證 token(見 electron/main.ts 的 `resolveAuthToken()`/
 * `deskmony:setAuthToken`/`deskmony:regenerateAuthToken` handler 註解)。
 * 純瀏覽器 client(`window.deskmony` 整個是 `undefined`)沒有這組方法可用
 * ——那是另一台機器,本來就管不到「這台」機器的 Electron 本機加密儲存。
 */
function getAuthTokenInfo(): Promise<AuthTokenInfo> {
  return ipcRenderer.invoke("deskmony:getAuthTokenInfo");
}

function setAuthToken(value: string): Promise<AuthTokenInfo> {
  return ipcRenderer.invoke("deskmony:setAuthToken", value);
}

function regenerateAuthToken(): Promise<AuthTokenInfo> {
  return ipcRenderer.invoke("deskmony:regenerateAuthToken");
}

contextBridge.exposeInMainWorld("deskmony", {
  corePort,
  gatewayUrl: `ws://localhost:${corePort}`,
  authToken,
  pickDirectory,
  focusWindow,
  notify,
  onNotificationClick,
  getAuthTokenInfo,
  setAuthToken,
  regenerateAuthToken,
});
