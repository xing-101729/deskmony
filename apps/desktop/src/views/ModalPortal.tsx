import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

/** 可取得焦點的元素選擇器(略過 disabled/`tabindex="-1"`)——focus trap 用來
 *  找出第一個/最後一個可聚焦的後代元素。 */
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => !el.hasAttribute("disabled") && el.tabIndex !== -1 && el.offsetParent !== null,
  );
}

/**
 * ModalPortal(問題 2 修復,根因見 SessionList.tsx 的 `<aside>`):所有
 * `fixed inset-0` 全螢幕遮罩彈窗(ProfileCreateDialog / SettingsDialog /
 * PermissionModal / TeamManagementDialog)一律透過這個共用元件,把實際 DOM
 * 節點渲染到 `document.body`,而不是直接留在 React 元件樹原本的巢狀位置。
 *
 * ---- 根因(務必先讀,避免以後又在某個祖先元件加 transform 而重踩)----
 *
 * CSS 規範:`position: fixed` 的定位基準預設是 viewport,但只要**任何一個
 * 祖先元素套用了 `transform`(或 `perspective`/`filter`/`will-change:
 * transform` 等會建立新 containing block 的屬性)**,該祖先就會變成其
 * `position: fixed` 子孫的定位基準,而不是 viewport。
 *
 * `SessionList.tsx` 的 `<aside>`(側欄,M5 Round B 響應式改版時加入)帶了
 * `transition-transform` + `sm:translate-x-0`/`-translate-x-full`(手機版
 * 側欄用 transform 滑入滑出)——`ProfileCreateDialog` 過去被渲染在這個
 * `<aside>` 內部(見 SessionList.tsx 呼叫 `<ProfileCreateDialog>` 的位置),
 * 導致它自己的 `fixed inset-0` 遮罩不是對齊整個視窗置中,而是對齊只有
 * `w-64`(256px)寬的側欄——480px 寬的對話框置中在 256px 容器內,自然向左
 * 溢出視窗邊界,使用者看到的就是對話框左半部被切掉、卡在視窗邊緣的畫面。
 *
 * ---- 修法 ----
 *
 * 用 `createPortal()` 把 modal 的 DOM 節點掛到 `document.body`(React
 * 元件樹的父子關係不變,事件冒泡/context 都正常運作,只有實際渲染的 DOM
 * 位置改變)——`document.body` 本身沒有任何 transform,`fixed inset-0`
 * 從此保證以整個 viewport 為定位基準,不會再被任何祖先的 transform 影響。
 * 這比「移除 SessionList 的 transform」更穩健:即使未來又有人在別的祖先
 * 元件加 transform(例如某個側欄/面板的滑入滑出動畫),用了 `ModalPortal`
 * 的彈窗依然不會受影響。
 *
 * 稽核範圍(這輪逐一檢查所有 `fixed inset-0` 全螢幕遮罩彈窗是否經過這個
 * portal):ProfileCreateDialog(根因觸發點,渲染在 SessionList 的 `<aside>`
 * 內)、SettingsDialog、PermissionModal(兩者渲染在 App.tsx 頂層,沒有
 * transform 祖先,這次沒有實際受影響,但統一走 portal 避免未來任何祖先
 * 元件加 transform 時又中招)、TeamManagementDialog(渲染在
 * TeamChatView.tsx/TaskBoardView.tsx 的 `<main>` 內,同樣沒有 transform
 * 祖先,同樣為求一致與未來安全統一改用 portal)。
 */
export function ModalPortal({ children }: { children: React.ReactNode }): JSX.Element | null {
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  // Focus trap(問題 3 修復,見使用者回報:「+ Profile」開啟後直接打字,
  // 名稱欄位沒反應——因為 ModalPortal 完全沒有做焦點管理,DOM focus 還留在
  // 開啟彈窗前的元素上(例如 TerminalView 自己的 `<input>`,portal 不會把它
  // 遮住的元素真的移除,只是視覺上蓋住)。這裡補上標準的 modal focus trap:
  //   1. mount 時記住原本的 activeElement,把焦點移到彈窗內第一個可聚焦元素。
  //   2. 彈窗開啟期間攔截 Tab/Shift+Tab,焦點在彈窗內第一個/最後一個可聚焦
  //      元素之間循環,不讓 Tab 逃出彈窗跑到底下(視覺上)被遮住的元素。
  //   3. unmount 時把焦點還給原本記住的元素(例如關閉彈窗後,焦點回到觸發
  //      開啟的「+ Profile」按鈕上,而不是掉回 document.body)。
  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;

    // 同 ChatView.tsx 的 session 切換焦點修復(見 electron/main.ts 的
    // `deskmony:focusWindow` handler 註解):彈窗不一定是使用者當下這個
    // BrowserWindow 直接握有 OS 焦點時開出來的(例如 PermissionModal 由
    // core 端透過 WS push 觸發,見 PermissionModal.tsx),光靠下面的 DOM
    // `element.focus()` 只能移動這個視窗**內部**的 focus,收不到真正鍵盤
    // 事件時使用者得先 alt-tab 切一次視窗才能打字。純瀏覽器 client 沒有
    // 對應的 OS 視窗可以 focus,`window.deskmony?.focusWindow` 在該情境下
    // 是 undefined,略過即可。
    void window.deskmony?.focusWindow?.();

    const focusables = getFocusableElements(wrapper);
    (focusables[0] ?? wrapper).focus();

    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== "Tab") return;
      const current = getFocusableElements(wrapper);
      if (current.length === 0) {
        e.preventDefault();
        return;
      }
      const first = current[0];
      const last = current[current.length - 1];
      const active = document.activeElement;

      if (e.shiftKey) {
        if (active === first || !wrapper.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (active === last || !wrapper.contains(active)) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    wrapper.addEventListener("keydown", handleKeyDown);
    return () => {
      wrapper.removeEventListener("keydown", handleKeyDown);
      previouslyFocused?.focus?.();
    };
  }, []);

  if (typeof document === "undefined") return null; // SSR/測試環境保險(這個專案目前不會發生,但屬於安全的防禦)
  // `tabIndex={-1}` 讓 wrapper 本身在沒有任何可聚焦後代時仍可被 focus()
  // (例如某個 modal 未來只剩純文字內容),`display: contents` 讓這層 div
  // 不參與版面配置/不建立新的 containing block,不會影響內部 `fixed inset-0`
  // 遮罩的定位基準(見檔案頂端的根因說明,務必維持這一點)。
  return createPortal(
    <div ref={wrapperRef} tabIndex={-1} style={{ display: "contents" }}>
      {children}
    </div>,
    document.body,
  );
}
