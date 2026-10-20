import { memo, useEffect, useRef, type CSSProperties, type Ref } from "react";
import { createPortal } from "react-dom";
import { browserPartitionForSession } from "../../../electron/browser-rules.js";
import { useSessionStore } from "../../stores/session-store.js";
import {
  isBrowserSupported,
  registerWebview,
  useBrowserStore,
  type SlotRect,
  type WebviewElement,
} from "../../stores/browser-store.js";

/**
 * webview 疊在**面板之上**(面板與窄螢幕/空間不足時的覆蓋層都是 `z-40`)、**所有對話框之下**:
 * `ui/Dialog.tsx`(PermissionModal、ConfirmDialog、SettingsDialog、RecoveryView…全部經它)是 `z-50`、命令面板是 `z-[60]`,
 * 內容選單(`SessionTitle`)也是 `z-50`——權限彈窗被 webview 蓋住是不可接受的。45 夾在 40 與 50 之間。
 * (所有彈窗都經 `ModalPortal` 掛到 `document.body`,和這裡的 portal 同在根層疊脈絡,z-index 直接比大小。)
 */
const BROWSER_Z_INDEX = 45;
/** 不在畫面上的 webview 停在畫面外並保持這個固定尺寸(頁面的 viewport 不會因為被收起而縮成 0)。 */
const PARKED_STYLE: CSSProperties = { left: -20000, top: 0, width: 1024, height: 768 };

/**
 * App 層的 webview 宿主(2026-10-20,見 docs/LAYER-4-detail-design/side-panel_detail.md §P3.2 與 `stores/browser-store.ts` 開頭的說明)。
 * 每個建立過 webview 的 session 一個 `position: fixed` 的外框:Browser 分頁開著且是目前 session 時,外框疊到分頁回報的 slot 上;
 * 其餘一律停在畫面外。**外框與 webview 的 DOM 節點以 session id 為 key、建立後從不搬動、從不因切換分頁而卸載**。
 * 偵測到 session 被刪除才移除它的 webview 並清掉它的 partition。
 */
export function BrowserHost(): JSX.Element | null {
  const created = useBrowserStore((s) => s.created);
  const slot = useBrowserStore((s) => s.slot);
  const pointerLock = useBrowserStore((s) => s.pointerLock);
  const sessions = useSessionStore((s) => s.sessions);

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

function BrowserFrame({ sessionId, rect, pointerLock }: { sessionId: string; rect: SlotRect | undefined; pointerLock: boolean }): JSX.Element {
  const partition = browserPartitionForSession(sessionId) ?? "";
  const style: CSSProperties = {
    position: "fixed",
    zIndex: BROWSER_Z_INDEX,
    overflow: "hidden",
    background: "#fff",
    // 不在畫面上的不吃滑鼠事件;拖拉面板寬度時全部暫時不吃(見 `pointerLock`)。
    pointerEvents: rect && !pointerLock ? "auto" : "none",
    ...(rect ? { left: rect.x, top: rect.y, width: rect.width, height: rect.height } : PARKED_STYLE),
  };
  return (
    <div data-browser-frame={sessionId} aria-hidden={rect ? undefined : true} style={style}>
      <BrowserWebview sessionId={sessionId} partition={partition} />
    </div>
  );
}

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
  return <webview ref={ref as Ref<HTMLElement>} partition={partition} src="about:blank" style={{ display: "flex", width: "100%", height: "100%" }} />;
});
