import type { ComponentType } from "react";
import type { Session } from "@deskmony/shared";
import type { IconName } from "../../ui/icons.js";
import { TerminalTab } from "./TerminalTab.js";
import { ChangesTab } from "./ChangesTab.js";
import { FilesTab } from "./FilesTab.js";
import { BrowserTab } from "./BrowserTab.js";
import { isBrowserSupported } from "../../stores/browser-store.js";

/**
 * 右側面板的分頁註冊陣列(2026-10-20,見 docs/LAYER-4-detail-design/side-panel_detail.md §P1.3)。
 *
 * `SidePanel` 的分頁列、目前分頁的選取與內容都由這個陣列產生——之後新增分頁(Changes、Files、Browser……)只要往
 * `PANEL_TABS` 加一項,不必改外殼。分頁的內容元件一律綁定「目前選取的 session」(`session` prop),切換 session 時由
 * 外殼以 `key={session.id}` 重新掛載,分頁不必自己處理「換 session 要重置」。
 */

export interface PanelTabProps {
  /** 面板目前對應的 session(永遠是目前選取的那一個)。 */
  session: Session;
  /** 這個分頁現在看得到(面板開著、且是目前分頁)。不可見時元件仍可能保持掛載(例如 webview 這類不能卸載的內容)。 */
  visible: boolean;
}

export interface PanelTabDef {
  /** 存進 localStorage 的穩定 id——改名會讓使用者記住的分頁退回預設。 */
  id: string;
  icon: IconName;
  /** i18n key(`sidePanel` namespace 以外也可以,帶 namespace 前綴即可)。 */
  titleKey: string;
  /** 這個 client 能不能用這個分頁(例如 Browser 分頁只有 Electron 殼有 webview,純瀏覽器 client 不顯示)。 */
  isAvailable: () => boolean;
  Component: ComponentType<PanelTabProps>;
}

export const TERMINAL_TAB_ID = "terminal";
export const CHANGES_TAB_ID = "changes";
export const FILES_TAB_ID = "files";
export const BROWSER_TAB_ID = "browser";

export const PANEL_TABS: PanelTabDef[] = [
  {
    id: TERMINAL_TAB_ID,
    icon: "terminal",
    titleKey: "sidePanel:tabs.terminal",
    isAvailable: () => true,
    Component: TerminalTab,
  },
  {
    id: CHANGES_TAB_ID,
    icon: "branch",
    titleKey: "sidePanel:tabs.changes",
    isAvailable: () => true,
    Component: ChangesTab,
  },
  {
    id: FILES_TAB_ID,
    icon: "folder",
    titleKey: "sidePanel:tabs.files",
    isAvailable: () => true,
    Component: FilesTab,
  },
  {
    id: BROWSER_TAB_ID,
    icon: "globe",
    titleKey: "sidePanel:tabs.browser",
    // 只有 Electron 殼有 <webview>;純瀏覽器 client(沒有 window.deskmony)不顯示這個分頁。
    isAvailable: isBrowserSupported,
    Component: BrowserTab,
  },
];
