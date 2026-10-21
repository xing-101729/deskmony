import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { browserPartitionForSession, isExternallyOpenableUrl, normalizeAddressInput } from "../../../electron/browser-rules.js";
import {
  browserBack,
  browserForward,
  browserNavigate,
  browserOpenDevTools,
  browserOpenExternal,
  browserReload,
  browserStop,
  useBrowserStore,
} from "../../stores/browser-store.js";
import { IconButton, Spinner } from "../../ui/Button.js";
import { useAgentActivity } from "./agent-activity.js";
import type { PanelTabProps } from "./panel-tabs.js";

/**
 * 面板的 Browser 分頁(2026-10-20,見 docs/LAYER-4-detail-design/side-panel_detail.md §P3.2):每個 session 一個 webview,
 * 使用者與 agent 共用(agent 經 MCP 工具操作這個 webview,見 P4;agent 操作中時標題列顯示最近一個動作)。這個元件只畫**工具列**與一個**佔位 slot**——webview 本身在 App 層的 `BrowserHost`
 * (它的 DOM 節點不能搬家、不能因為這個分頁被卸載而消失,理由見 `stores/browser-store.ts` 開頭)。
 * slot 的位置與大小每個畫面影格比對一次(`requestAnimationFrame`,只有變了才寫進 store),所以面板拖拉寬度、側欄展開收合、
 * 視窗縮放、覆蓋層切換都會跟上,不必逐一去訂閱那些事件。
 */
export function BrowserTab({ session }: PanelTabProps): JSX.Element {
  const { t } = useTranslation(["sidePanel"]);
  const sessionId = session.id;
  const supported = browserPartitionForSession(sessionId) !== undefined;
  const page = useBrowserStore((s) => s.pages[sessionId]);
  const agent = useAgentActivity(sessionId);
  const slotRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [addressError, setAddressError] = useState<string | null>(null);

  // 第一次打開這個 session 的 Browser 分頁才建立它的 webview;之後即使切走分頁/關面板它都還在。
  useEffect(() => {
    if (supported) useBrowserStore.getState().ensure(sessionId);
  }, [sessionId, supported]);

  // 回報 slot 的位置與大小(viewport 座標,給 BrowserHost 的 position: fixed 用)。卸載時清掉——BrowserHost 就把 webview 停放起來(留在視口內、opacity 0、沉到 app 外殼底下)。
  useEffect(() => {
    if (!supported) return undefined;
    let frame = 0;
    let last = "";
    const tick = (): void => {
      const element = slotRef.current;
      if (element) {
        const box = element.getBoundingClientRect();
        const rect = { x: Math.round(box.left), y: Math.round(box.top), width: Math.round(box.width), height: Math.round(box.height) };
        const key = `${rect.x},${rect.y},${rect.width},${rect.height}`;
        if (key !== last) {
          last = key;
          useBrowserStore.getState().setSlot({ sessionId, rect });
        }
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      const { slot, setSlot } = useBrowserStore.getState();
      if (slot?.sessionId === sessionId) setSlot(undefined);
    };
  }, [sessionId, supported]);

  // 網址列:沒有在編輯時跟著頁面目前的網址(空白頁顯示空字串)。
  const currentUrl = page?.url ?? "";
  useEffect(() => {
    if (!editing) setDraft(currentUrl === "about:blank" ? "" : currentUrl);
  }, [currentUrl, editing]);

  // 空白頁(剛建立)直接把游標放進網址列。
  const isBlank = currentUrl === "" || currentUrl === "about:blank";
  const focusedOnceRef = useRef(false);
  useEffect(() => {
    if (supported && isBlank && !focusedOnceRef.current) {
      focusedOnceRef.current = true;
      inputRef.current?.focus();
    }
  }, [supported, isBlank]);

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const resolved = normalizeAddressInput(draft);
    if (resolved.kind === "empty") return;
    if (resolved.kind === "invalid") {
      setAddressError(t(resolved.reason === "unsupportedScheme" ? "sidePanel:browser.invalidScheme" : "sidePanel:browser.invalidAddress"));
      return;
    }
    setAddressError(null);
    browserNavigate(sessionId, resolved.url);
    inputRef.current?.blur();
  };

  if (!supported) {
    return <div className="flex h-full items-center justify-center px-6 text-center text-sm text-fg-subtle">{t("sidePanel:browser.unavailable")}</div>;
  }

  const ready = page?.ready === true;
  const loading = page?.loading === true;
  const failure = page?.failure;
  const message = addressError ?? (page?.crashed ? t("sidePanel:browser.crashed") : failure ? t("sidePanel:browser.loadFailed", { url: failure.url, description: failure.description }) : null);
  const title = page?.title || (isBlank ? "" : currentUrl);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <form onSubmit={submit} className="flex flex-shrink-0 items-center gap-1 border-b border-line-subtle px-2 py-1.5">
        <IconButton icon="undo" aria-label={t("sidePanel:browser.back")} title={t("sidePanel:browser.back")} disabled={!ready || !page?.canGoBack} onClick={() => browserBack(sessionId)} />
        <IconButton
          icon="forward"
          aria-label={t("sidePanel:browser.forward")}
          title={t("sidePanel:browser.forward")}
          disabled={!ready || !page?.canGoForward}
          onClick={() => browserForward(sessionId)}
        />
        <IconButton
          icon={loading ? "x" : "refresh"}
          aria-label={loading ? t("sidePanel:browser.stop") : t("sidePanel:browser.reload")}
          title={loading ? t("sidePanel:browser.stop") : t("sidePanel:browser.reload")}
          disabled={!ready}
          onClick={() => (loading ? browserStop(sessionId) : browserReload(sessionId))}
        />
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setAddressError(null);
          }}
          onFocus={(e) => {
            setEditing(true);
            e.currentTarget.select();
          }}
          onBlur={() => setEditing(false)}
          placeholder={t("sidePanel:browser.addressPlaceholder")}
          aria-label={t("sidePanel:browser.addressLabel")}
          aria-invalid={addressError !== null}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          className="focus-ring h-6 min-w-0 flex-1 rounded border border-line bg-surface px-2 font-mono text-xs text-fg outline-none placeholder:text-fg-faint"
        />
        <IconButton
          icon="external"
          aria-label={t("sidePanel:browser.openExternal")}
          title={t("sidePanel:browser.openExternal")}
          disabled={!isExternallyOpenableUrl(currentUrl)}
          onClick={() => browserOpenExternal(sessionId)}
        />
        <IconButton
          icon="terminal"
          aria-label={t("sidePanel:browser.devTools")}
          title={t("sidePanel:browser.devTools")}
          disabled={!ready || page?.webContentsId === undefined}
          onClick={() => browserOpenDevTools(sessionId)}
        />
      </form>

      {/* 載入指示:工具列下緣一條細的進度條(載入中時動畫);標題列顯示頁面標題與轉圈。 */}
      <div className="relative h-0.5 flex-shrink-0 bg-transparent">{loading && <div className="absolute inset-0 animate-pulse bg-accent" />}</div>
      {/* 標題列。agent 操作中(或剛操作過)時,這一列改顯示「agent 正在操作瀏覽器 · 最近的動作」——**不另外加一列**:多一列會讓 slot(webview)
          的高度隨指示出現/消失而變,agent 截圖與點擊之間的 viewport 尺寸就會對不上(browser.staleScreenshot)。 */}
      <div
        role={agent ? "status" : undefined}
        className={`flex flex-shrink-0 items-center gap-2 border-b border-line-subtle px-3 py-1 text-2xs ${agent ? "bg-accent/10 text-accent" : "text-fg-subtle"}`}
      >
        {agent ? (
          <span aria-hidden="true" className={`h-1.5 w-1.5 flex-shrink-0 rounded-full bg-accent ${agent.working ? "animate-pulse" : "opacity-60"}`} />
        ) : (
          loading && <Spinner size={11} />
        )}
        <span className="min-w-0 flex-1 truncate" title={agent ? `${agent.text}\n${title}` : title}>
          {agent ? agent.text : title || t("sidePanel:browser.blankTitle")}
        </span>
      </div>
      {message && (
        <div className="flex-shrink-0 border-b border-line-subtle bg-danger/10 px-3 py-1.5 text-xs text-danger" role="alert">
          {message}
        </div>
      )}

      {/* 佔位 slot:BrowserHost 會把這個 session 的 webview 疊在這個區域上(position: fixed)。 */}
      <div ref={slotRef} data-browser-slot className="min-h-0 flex-1" />
    </div>
  );
}
