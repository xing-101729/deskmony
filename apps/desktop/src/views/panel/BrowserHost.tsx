import { memo, useEffect, useRef, type Ref } from "react";
import { createPortal } from "react-dom";
import { browserPartitionForSession } from "../../../electron/browser-rules.js";
import { browserFrameInert, browserFrameStyle } from "../../lib/browser-frame-style.js";
import { useSessionStore } from "../../stores/session-store.js";
import {
  isBrowserSupported,
  registerWebview,
  useBrowserStore,
  type SlotRect,
  type WebviewElement,
} from "../../stores/browser-store.js";
import { startBrowserHost } from "./browser-host.js";

/**
 * App 層的 webview 宿主(2026-10-20,見 docs/LAYER-4-detail-design/side-panel_detail.md §P3.2 與 `stores/browser-store.ts` 開頭的說明)。
 * 每個建立過 webview 的 session 一個 `position: fixed` 的外框:Browser 分頁開著且是目前 session 時,外框疊到分頁回報的 slot 上(z-45:面板之上、所有對話框之下);
 * 其餘一律**停放**——留在視口內(fixed 0,0、1024×768)、`opacity: 0`、`z-index: -1`、不吃滑鼠;**不是**移到畫面外,也**不是** `visibility: hidden`/`display: none`
 * (原因是 P3.3 實驗:畫面外的 webview CDP 截圖會逾時,見 `lib/browser-frame-style.ts`)。
 * **外框與 webview 的 DOM 節點以 session id 為 key、建立後從不搬動、從不因切換分頁而卸載**。
 * 偵測到 session 被刪除才移除它的 webview 並清掉它的 partition。
 *
 * 2026-10-21(P4b):這個元件整個 app 生命週期都掛著,所以也在這裡啟動「agent 瀏覽器指令的執行端」(`./browser-host.ts`:每次連線開啟就
 * 註冊成 host、收 `browser-command`、必要時替還沒有 webview 的 session 建立一個)。
 */
export function BrowserHost(): JSX.Element | null {
  const created = useBrowserStore((s) => s.created);
  const slot = useBrowserStore((s) => s.slot);
  const pointerLock = useBrowserStore((s) => s.pointerLock);
  const sessions = useSessionStore((s) => s.sessions);

  useEffect(() => startBrowserHost(), []);

  // session 被刪除:移除它的 webview、清掉它的 partition(DECISIONS §L.3:session 刪除時清空)。
  // 只處理「曾經建立過 webview」的 id,所以啟動時 session 清單還沒載入(空陣列)不會誤刪。
  useEffect(() => {
    const known = new Set(sessions.map((s) => s.id));
    for (const sessionId of useBrowserStore.getState().created) {
      if (!known.has(sessionId)) useBrowserStore.getState().discard(sessionId);
    }
  }, [sessions]);

  if (!isBrowserSupported()) return null;
  return createPortal(
    <>
      {created.map((sessionId) => (
        <BrowserFrame
          key={sessionId}
          sessionId={sessionId}
          rect={slot?.sessionId === sessionId && slot.rect.width > 0 && slot.rect.height > 0 ? slot.rect : undefined}
          pointerLock={pointerLock}
        />
      ))}
    </>,
    document.body,
  );
}

/**
 * 停放中的外框加 `inert`:按 Tab 時鍵盤焦點不會跑進一個看不見的頁面(opacity 0 的 webview 仍然可以被 Tab 聚焦)。以空字串經 spread 傳入——
 * React 18 不認得 `inert`,布林值會被丟掉並警告,字串才會原樣寫成屬性;不再停放(`rect` 有值)時 prop 消失,React 會把屬性移除。
 * **`inert` 對 CDP 截圖/輸入有沒有影響是未驗證的**(見 `scripts/spike/webview-offscreen.cjs` 的 `parked-inert` 位置);如果實驗顯示會壞,
 * 把 `browserFrameInert()` 改成永遠回 false 即可退回沒有 inert 的停放方式。
 */
const INERT_PROPS = { inert: "" } as object;

function BrowserFrame({ sessionId, rect, pointerLock }: { sessionId: string; rect: SlotRect | undefined; pointerLock: boolean }): JSX.Element {
  const partition = browserPartitionForSession(sessionId) ?? "";
  // 可見/停放兩種樣式與 z-index 的理由都在 `lib/browser-frame-style.ts`(純函式,有測試鎖住)。
  const style = browserFrameStyle(rect, pointerLock);
  return (
    <div
      data-browser-frame={sessionId}
      aria-hidden={rect ? undefined : true}
      style={style}
      {...(browserFrameInert(rect) ? INERT_PROPS : undefined)}
    >
      <BrowserWebview sessionId={sessionId} partition={partition} />
    </div>
  );
}

/**
 * `allowpopups`:沒有這個屬性時 `window.open`/`target=_blank` 在 guest 端就被吞掉,main 的 `setWindowOpenHandler` 根本不會被呼叫,「在新分頁開啟」的連結點了沒反應。
 * 開它是安全的——main 的 `will-attach-webview` 會強制設定它(不信任這裡傳什麼),而每次彈出都進 deny-all 的 `setWindowOpenHandler`,不會產生任何新視窗,
 * 只有 http(s) 目標改成在同一個 webview 導過去(見 `electron/main.ts`)。以字串經 spread 傳入:React 對未知屬性的布林 `true` 會丟掉並警告,
 * 而且 `@types/react` 的 `allowpopups` 是 boolean 型別。屬性放在 `partition`/`src` 之後,不改變它們的設定順序。
 */
const ALLOW_POPUPS = { allowpopups: "true" } as object;

/**
 * 真正的 `<webview>`。`memo` + 常數 props:外框因為 slot 移動而重新渲染時,這個元件不重新渲染、webview 元素的屬性不被重設
 * (`src` 只在建立時是 `about:blank`;之後導覽走 `loadURL()`,見 `browserNavigate()`)。`partition` 必須在附掛前就設好——
 * React 先建立元素、設完屬性才把它加進 DOM,而且 `partition` 排在 `src` 前面。
 */
const BrowserWebview = memo(function BrowserWebview({ sessionId, partition }: { sessionId: string; partition: string }): JSX.Element {
  const ref = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const element = ref.current as WebviewElement | null;
    if (!element) return undefined;
    return registerWebview(sessionId, element);
  }, [sessionId]);
  return (
    <webview
      ref={ref as Ref<HTMLElement>}
      partition={partition}
      src="about:blank"
      style={{ display: "flex", width: "100%", height: "100%" }}
      {...ALLOW_POPUPS}
    />
  );
});
