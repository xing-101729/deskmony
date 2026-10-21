import { nativeImage } from "electron";
import type { WebContents } from "electron";
import { isExternallyOpenableUrl } from "./browser-rules.js";
import {
  EXEC_WORLD_ID,
  createGuestState,
  executeBrowserOp,
  type BrowserExecOutcome,
  type BrowserGuestDriver,
  type GuestState,
  type LoadOutcome,
  type LoadWaiter,
} from "./browser-exec.js";

/**
 * browser-executor.ts(2026-10-21,右側面板 P4b):把一個 `<webview>` guest 的 `WebContents` 包成 `browser-exec.ts` 的 `BrowserGuestDriver`,
 * 並提供 `runBrowserOp()`——`deskmony:browserExec` IPC 的實作本體。**所有 op 的執行邏輯都在 `browser-exec.ts`**(那邊沒有任何 Electron 依賴、
 * 有用假 driver 的純函式測試);這個檔案只剩 Electron 才有的膠水,所以**只能在真 Electron 裡驗證**的事情都在這裡:
 *   - `webContents.debugger`:第一次用才 `attach("1.3")`;`detach`(例如使用者打開了這個 webview 的 DevTools、或 guest 被銷毀)之後,
 *     下一個指令發現 `isAttached()` 為假就重新 attach(不事先 attach、不常駐;沒有 agent 操作的 session 完全不碰 debugger);
 *   - `Page.captureScreenshot`(parked / 疊放兩種狀態下的行為,見 scripts/spike/webview-offscreen.cjs);
 *   - `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent` / `Input.insertText` 對 guest 的實際效果;
 *   - `executeJavaScriptInIsolatedWorld` 對 webview guest 可用、ref 對照表在導覽後確實消失;
 *   - `did-finish-load` / `did-fail-load` / `did-stop-loading` 的時序、`navigationHistory`、`nativeImage` 解碼與縮放。
 *
 * 同一個 guest 的指令在這裡再串行一次(core 對同一個 session 本來就一次只送一個,這是縱深防禦:renderer 或 IPC 重送也不會讓兩個 op 交錯操作同一個頁面)。
 */

/** 單一 CDP 指令/isolated world 腳本的逾時(整個 op 另有更外層的上限,見 browser-exec.ts 的 `COMMAND_DEADLINE_MS`)。 */
const CDP_TIMEOUT_MS = 8_000;

interface GuestRecord {
  state: GuestState;
  /** 這個 guest 的指令串行佇列(尾端 promise)。 */
  queue: Promise<unknown>;
}

const records = new WeakMap<WebContents, GuestRecord>();

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 逾時(${ms} ms)`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function recordFor(contents: WebContents): GuestRecord {
  const existing = records.get(contents);
  if (existing) return existing;
  const record: GuestRecord = { state: createGuestState(), queue: Promise.resolve() };
  records.set(contents, record);
  // 文件換了(跨文件導覽完成):舊截圖上的座標沒有意義。(op 自己的導覽也會清;這裡涵蓋使用者在面板裡自己導覽或頁面自己導覽。)
  contents.on("did-navigate", () => {
    record.state.screenshot = undefined;
  });
  // DevTools 開啟/關閉、guest 銷毀都會 detach:只記一筆,下一個指令發現 isAttached() 為假就重新 attach。
  contents.debugger.on("detach", (_event, reason) => {
    console.log(`[browser-executor] webContents ${contents.id} 的 debugger 已 detach(${reason});下一個瀏覽器指令會重新 attach`);
  });
  return record;
}

function ensureAttached(contents: WebContents): void {
  if (contents.isDestroyed()) throw new Error("瀏覽器頁面已經被關閉");
  if (!contents.debugger.isAttached()) contents.debugger.attach("1.3");
}

function createDriver(contents: WebContents): BrowserGuestDriver {
  const cdp = async (method: string, params?: Record<string, unknown>): Promise<unknown> => {
    ensureAttached(contents);
    try {
      return await withTimeout(contents.debugger.sendCommand(method, params), CDP_TIMEOUT_MS, `CDP ${method}`);
    } catch (err) {
      // 指令送出的當下剛好被 detach(例如使用者剛好打開 DevTools):重新 attach 再試一次。
      if (/not attached|detached|target closed/i.test(err instanceof Error ? err.message : String(err)) && !contents.isDestroyed()) {
        ensureAttached(contents);
        return await withTimeout(contents.debugger.sendCommand(method, params), CDP_TIMEOUT_MS, `CDP ${method}`);
      }
      throw err;
    }
  };

  const waitForLoad = (timeoutMs: number): LoadWaiter => {
    let settle: (outcome: LoadOutcome) => void = () => undefined;
    const promise = new Promise<LoadOutcome>((resolve) => {
      settle = resolve;
    });
    let done = false;
    const cleanup = (): void => {
      done = true;
      clearTimeout(timer);
      contents.removeListener("did-finish-load", onFinish);
      contents.removeListener("did-fail-load", onFail);
    };
    const finish = (outcome: LoadOutcome): void => {
      if (done) return;
      cleanup();
      settle(outcome);
    };
    const onFinish = (): void => finish({ finished: true });
    const onFail = (_event: unknown, code: number, description: string, url: string, isMainFrame: boolean): void => {
      if (!isMainFrame) return;
      if (code === -3) return; // ERR_ABORTED:被新的導覽取代或使用者中止,不是失敗——繼續等真正的結果
      finish({ finished: false, failure: { code, description, url } });
    };
    const timer = setTimeout(() => finish({ finished: false, timedOut: true }), timeoutMs);
    contents.on("did-finish-load", onFinish);
    contents.on("did-fail-load", onFail);
    return {
      promise,
      cancel: () => {
        if (done) return;
        cleanup();
        settle({ finished: false });
      },
    };
  };

  return {
    cdp,
    evalIsolated: (code) => withTimeout(contents.executeJavaScriptInIsolatedWorld(EXEC_WORLD_ID, [{ code }]), CDP_TIMEOUT_MS, "isolated world 腳本"),
    getUrl: () => contents.getURL(),
    getTitle: () => contents.getTitle(),
    isLoading: () => contents.isLoading(),
    isUrlAllowed: (url) => isExternallyOpenableUrl(url),
    loadUrl: (url) => contents.loadURL(url),
    goHistory: (action) => {
      if (action === "reload") {
        contents.reload();
        return true;
      }
      const history = contents.navigationHistory;
      if (action === "back") {
        if (!history.canGoBack()) return false;
        history.goBack();
      } else {
        if (!history.canGoForward()) return false;
        history.goForward();
      }
      return true;
    },
    waitForLoad,
    waitForLoadStop: (timeoutMs) =>
      new Promise<void>((resolve) => {
        if (!contents.isLoading()) {
          resolve();
          return;
        }
        const timer = setTimeout(() => {
          contents.removeListener("did-stop-loading", onStop);
          resolve();
        }, timeoutMs);
        const onStop = (): void => {
          clearTimeout(timer);
          resolve();
        };
        contents.once("did-stop-loading", onStop);
      }),
    jpegSize: (base64) => nativeImage.createFromBuffer(Buffer.from(base64, "base64")).getSize(),
    resizeJpeg: (base64, width, height, quality) =>
      nativeImage
        .createFromBuffer(Buffer.from(base64, "base64"))
        .resize({ width, height, quality: "good" })
        .toJPEG(quality)
        .toString("base64"),
    sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  };
}

/**
 * 在這個 guest 上執行一個 op(`deskmony:browserExec`)。呼叫端(main 的 IPC handler)已經驗證過呼叫者是主視窗、`contents` 確實是主視窗的
 * `<webview>` guest(`resolveBrowserGuest()`)。期待中的失敗都回 `{ok:false, error}`,不丟例外。
 */
export function runBrowserOp(contents: WebContents, op: string, args: unknown): Promise<BrowserExecOutcome> {
  const record = recordFor(contents);
  const run = record.queue.then(() => executeBrowserOp(createDriver(contents), record.state, op, args));
  record.queue = run.catch(() => undefined);
  return run;
}
