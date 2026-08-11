import { app, BrowserWindow, dialog, ipcMain, Notification } from "electron";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
const RESOURCES_CORE_DIR = "core";
/**
 * Electron main process(ARCHITECTURE.md 3.1、10 節「Core 與殼分離」):
 *   - 負責啟動 apps/core(headless server)這個 child process
 *   - 負責建立/管理視窗
 *   - 不直接碰 Core 的業務邏輯 —— renderer 透過 WebSocket 直接連上 Core 的
 *     Gateway(ws://localhost:CORE_PORT),main process 只是把 process 啟動
 *     起來,概念上桌面殼只是 Core 的其中一種 client。
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORE_PORT = Number(process.env.DESKMONY_CORE_PORT ?? 4317);
const isDev = !app.isPackaged;
/**
 * M5 Round A(任務2):桌面殼串接認證。main process 產生一個隨機 token,
 * 設進 `process.env.DESKMONY_AUTH_TOKEN`(在 `createWindow()` 之前設定,
 * 讓 preload script 讀到的 `process.env` 也含這個值 —— preload 繼承 main
 * process 當下環境變數的機制與既有 `DESKMONY_CORE_PORT` 相同,見
 * preload.ts 內註解),同一個值再透過 `startCore()` 的 `env` 傳給 core
 * 子程序。這樣 core/renderer 兩端拿到的是同一份 token,且只存在於這個
 * app 生命週期的記憶體/環境變數內,不落地成檔案、不寫進任何 log。
 *
 * 每次啟動都重新產生(不持久化)——桌面殼場景下 core 子程序與桌面殼視窗
 * 生命週期一致(main.ts 自己 spawn 的 child process,只有這個 app 實例會
 * 連上),不需要跨重啟保留同一個 token;比起持久化,現生成的隨機值不需要
 * 額外處理「token 檔案要存哪裡、誰能讀」這個新的攻擊面。
 */
const CORE_AUTH_TOKEN = process.env.DESKMONY_AUTH_TOKEN || randomUUID();
process.env.DESKMONY_AUTH_TOKEN = CORE_AUTH_TOKEN;
let coreProcess;
let mainWindow;
// stopCore() 主動 kill() core 子程序時,Windows 上實測會讓 exit 事件回報
// code=1、signal=null(而不是 null/訊號結尾),與「啟動後很快 crash」在
// exit handler 裡完全無法區分。用這個旗標記錄「這是我方主動終止」,
// exit handler 看到旗標時一律不彈「Core 啟動失敗」對話框。
let intentionalShutdown = false;
function resolveCoreEntry() {
    // packaged: core dist 在 extraResources 底下(`apps/desktop/package.json` 的
    // `extraResources` 設定把 `core-bundle` 整包複製到 `resources/core`,
    // `scripts/bundle-core.mjs` 保留了 `@deskmony/core` 原本的 `dist/` 佈局,
    // 入口是 `dist/index.js`,不是 `core-bundle` 根目錄下的 `index.js`——這裡
    // 曾經漏了 `dist` 這一層,實際打包驗證(`pnpm package:dir` + 啟動
    // unpacked exe)時才發現 `MODULE_NOT_FOUND`,修正見此)。
    if (app.isPackaged) {
        return path.join(process.resourcesPath, RESOURCES_CORE_DIR, "dist", "index.js");
    }
    // dev/monorepo 佈局:apps/desktop/dist-electron/main.js -> apps/core/dist/index.js
    return path.join(__dirname, "..", "..", "core", "dist", "index.js");
}
// core 子程序啟動後,在這段時間內以非 0 結束碼結束就視為「啟動失敗」(而不是
// 使用者正常關閉 app 導致的結束),用來決定要不要跳出錯誤對話框。
const CORE_STARTUP_GRACE_MS = 10_000;
/**
 * 嘗試找出系統安裝的 Node.js 執行檔路徑(不透過 shell,避免 shell:false 下
 * Windows 找不到 `node` 這個非 .exe 名稱的問題)。找不到回傳 undefined。
 *
 * 背景:better-sqlite3 的原生模組是用「系統 Node」的 ABI(NODE_MODULE_VERSION)
 * 編譯的;若改用 `ELECTRON_RUN_AS_NODE=1` + `process.execPath` 借用 Electron
 * 內建 Node 執行 core,Electron 內建 Node 的 ABI 版本通常與系統 Node 不同
 * (例如 Electron 33.4.11 要求 NODE_MODULE_VERSION 130,系統 Node 22 編譯出的是
 * 127),會導致 core 一啟動就以 ERR_DLOPEN_FAILED crash。因此 dev 階段優先用
 * 系統 Node 跑 core,與 better-sqlite3 的編譯 ABI 保持一致。
 */
function resolveSystemNode() {
    try {
        const finder = process.platform === "win32" ? "where" : "which";
        const target = process.platform === "win32" ? "node.exe" : "node";
        const result = spawnSync(finder, [target], { encoding: "utf8" });
        if (result.status !== 0 || !result.stdout)
            return undefined;
        const candidate = result.stdout
            .split(/\r?\n/)
            .map((line) => line.trim())
            .find((line) => line.length > 0 && existsSync(line));
        return candidate;
    }
    catch {
        return undefined;
    }
}
function startCore() {
    const corePort = String(CORE_PORT);
    const entry = resolveCoreEntry();
    const env = {
        ...process.env,
        DESKMONY_CORE_PORT: corePort,
    };
    // 打包模式下 core 的預設靜態檔案目錄推算法(`__dirname/../../desktop/dist`,
    // 見 apps/core/src/index.ts)只在 monorepo 佈局下成立,打包後的
    // resources 佈局並不符合這個假設。`apps/desktop/package.json` 的
    // `build.extraResources` 已把 Vite build 產物(`apps/desktop/dist`)複製到
    // `resources/desktop-ui`(與 `resources/core` 分開,語意上是兩種不同的
    // 資源),這裡透過 core 既有的 `DESKMONY_STATIC_DIR` 覆寫機制明確指過去 ——
    // 不需要改動 core 本身的推算邏輯(dev 模式的預設推算路徑保持不動)。這個
    // 缺口只影響「把打包後的 core 當成可被瀏覽器/手機連線的伺服器」的情境,
    // 不影響 Electron 桌面殼本身(`createWindow()` 用 `loadFile()` 直接從
    // app 自己的 asar 載入 UI,完全不經過 core 的 HTTP static server)。
    if (app.isPackaged) {
        env.DESKMONY_STATIC_DIR = path.join(process.resourcesPath, "desktop-ui");
    }
    // 打包模式下 core 子程序如何找到它的依賴(`@deskmony/adapters` 等):見
    // `scripts/bundle-core.mjs`(node_modules -> _modules rename 的原因)與
    // `apps/desktop/scripts/after-pack.mjs`(electron-builder afterPack hook,
    // 在 `resources/core/` 底下建立 `node_modules` -> `_modules` 的 Windows
    // 目錄 junction)。這裡**不需要**也**不能**設定 `NODE_PATH`——`apps/core`
    // 是 `"type": "module"` 的 ESM 專案,Node 的 ESM resolver 完全不查
    // `NODE_PATH`(只有 CJS `require()` 會查,這是 Node.js 官方文件明載的行為),
    // 過去這裡設定 `env.NODE_PATH` 指向 `_modules` 的作法對 ESM import 從一開始
    // 就沒有任何效果,是死程式碼(已實測驗證移除後、junction 就位後,packaged
    // exe 能正常解析所有依賴,見 `scripts/package-smoke.mjs` 的驗證記錄)。
    let command;
    if (app.isPackaged) {
        // 打包模式:一律用 ELECTRON_RUN_AS_NODE 借用 Electron 內建的 Node,絕對
        // 不呼叫 resolveSystemNode()。原因(見 README「已知限制」→「打包階段已
        // 解決」章節與 scripts/bundle-core.mjs 內的完整說明):`scripts/bundle-core.mjs`
        // 在打包時已經用 `@electron/rebuild` 把 `core-bundle/_modules` 裡的
        // `better-sqlite3` 原生模組針對「這個 Electron 版本」的 ABI
        // (NODE_MODULE_VERSION)重新編譯過,不再是系統 Node 的 ABI —— 因此打包後
        // 的正確作法反過來了:用系統 Node 執行反而會 ABI 不匹配,必須用 Electron
        // 內建的 Node 執行才會匹配。這也代表終端使用者機器完全不需要安裝 Node.js。
        console.log(`[electron] packaged: starting core with Electron's bundled Node (ELECTRON_RUN_AS_NODE) ${entry} (port ${corePort})`);
        env.ELECTRON_RUN_AS_NODE = "1";
        command = process.execPath;
    }
    else {
        // dev 模式:維持原本行為,優先找系統安裝的 Node.js 執行 core ——
        // dev 階段的 core 依賴(repo 根目錄/workspace 的 node_modules)是用系統
        // Node 的 ABI 裝的,沒有經過 electron-rebuild,因此這裡不能用
        // ELECTRON_RUN_AS_NODE(除非系統完全找不到 Node.js,才退回並接受 ABI
        // 不相容的風險,見下方警告)。
        const systemNode = resolveSystemNode();
        if (systemNode) {
            console.log(`[electron] starting core process with system Node: ${systemNode} ${entry} (port ${corePort})`);
            command = systemNode;
        }
        else {
            console.warn("[electron] 找不到系統 Node.js(PATH 中找不到 node),退回用 ELECTRON_RUN_AS_NODE 借用 " +
                "Electron 內建的 Node 執行 core。\n" +
                "[electron] 警告:這可能導致 core 因 ABI(NODE_MODULE_VERSION)不相容而啟動失敗 —— " +
                "better-sqlite3 原生模組是用系統 Node 的 ABI 編譯的,若與 Electron 內建 Node 的 ABI " +
                "版本不同(例如 Electron 33.4.11 需要 NODE_MODULE_VERSION 130,系統 Node 22 編譯出的是 127)," +
                "core 子程序會以 ERR_DLOPEN_FAILED crash。建議安裝 Node.js 並確保在 PATH 中可被找到。");
            env.ELECTRON_RUN_AS_NODE = "1";
            command = process.execPath;
            console.log(`[electron] starting core process: ${entry} (port ${corePort})`);
        }
    }
    const startedAt = Date.now();
    coreProcess = spawn(command, [entry], { env, stdio: "inherit" });
    coreProcess.on("exit", (code) => {
        console.log(`[electron] core process exited with code ${code}`);
        const elapsedMs = Date.now() - startedAt;
        // 若是我方主動呼叫 stopCore() 中止(app 關閉/退出中),不視為啟動失敗 ——
        // Windows 上實測 kill() 會讓 exit 事件回報 code=1、signal=null,與真正的
        // 啟動失敗在 code/signal 層面無法區分,必須靠這個旗標判斷。
        if (!intentionalShutdown && code !== null && code !== 0 && elapsedMs < CORE_STARTUP_GRACE_MS) {
            dialog.showErrorBox("Core 啟動失敗", `apps/core 子程序在啟動後 ${elapsedMs}ms 內即以結束碼 ${code} 結束。\n` +
                "請查看終端機輸出以取得詳細錯誤訊息(常見原因:原生模組 ABI 不相容,見終端機警告)。");
        }
        coreProcess = undefined;
    });
}
function stopCore() {
    intentionalShutdown = true;
    coreProcess?.kill();
    coreProcess = undefined;
}
function registerIpcHandlers() {
    // 使用者回報:建立新對話後,即使 renderer 端已經把 DOM focus 移到輸入框
    // (見 ChatView.tsx 的 textareaRef 那個 effect),實際打字仍然沒反應,得
    // alt-tab 切換視窗才恢復——這是 OS 層級的視窗焦點與 Chromium DOM focus
    // 是兩回事:`element.focus()` 只能移動「這個 BrowserWindow 內部」的 DOM
    // focus,如果當下 Windows 的輸入焦點根本不在這個視窗上(例如剛才是用滑鼠
    // 點擊觸發的非同步流程,或系統把焦點吃掉),DOM focus 再怎麼設都收不到
    // 真正的鍵盤事件,直到使用者手動切換視窗讓 OS 把焦點還給它。`window.focus()`
    // 在 renderer 端不保證真的觸發 OS 層級 focus(瀏覽器的 user-activation 限制),
    // 必須透過 main process 呼叫 `BrowserWindow.focus()`(貨真價實的 OS API)。
    ipcMain.handle("deskmony:focusWindow", () => {
        mainWindow?.focus();
    });
    ipcMain.handle("deskmony:pickDirectory", async () => {
        if (!mainWindow)
            return null;
        const result = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory"] });
        if (result.canceled || result.filePaths.length === 0)
            return null;
        return result.filePaths[0];
    });
    ipcMain.handle("deskmony:notify", (_event, payload) => {
        if (!Notification.isSupported())
            return;
        const notification = new Notification({ title: payload.title, body: payload.body });
        notification.on("click", () => {
            mainWindow?.show();
            mainWindow?.focus();
            if (payload.sessionId) {
                mainWindow?.webContents.send("deskmony:notification-clicked", payload.sessionId);
            }
        });
        notification.show();
    });
}
function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 800,
        backgroundColor: "#1e1e1e",
        autoHideMenuBar: true,
        webPreferences: {
            preload: path.join(__dirname, "preload.cjs"),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });
    if (isDev && process.env.VITE_DEV_SERVER_URL) {
        void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
        mainWindow.webContents.openDevTools({ mode: "detach" });
    }
    else {
        void mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
    }
    mainWindow.on("closed", () => {
        mainWindow = undefined;
    });
}
app.whenReady().then(() => {
    registerIpcHandlers();
    startCore();
    createWindow();
    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0)
            createWindow();
    });
});
app.on("window-all-closed", () => {
    stopCore();
    if (process.platform !== "darwin")
        app.quit();
});
app.on("before-quit", () => {
    stopCore();
});
