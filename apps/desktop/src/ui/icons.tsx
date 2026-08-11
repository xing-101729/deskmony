/**
 * 圖示集——**刻意手寫一組最小 SVG**,不引入圖示套件:
 *
 *   1. 改版前 UI 大量使用 emoji(`✕ ☰ ⚙ 👤 🌿 📋 ⏳ ⚠`)當圖示。emoji 在不同
 *      平台是不同的彩色點陣圖,無法繼承文字色、無法對齊光學基線、也無法統一
 *      粗細——這是「看起來不專業」最直接的來源之一。
 *   2. 這個 app 是 Electron + 瀏覽器雙載體,多一個 runtime 依賴就多一份 bundle
 *      與版本維護成本;實際用到的圖示不到 30 個,手寫描邊路徑成本更低。
 *
 * 規格統一:24×24 viewBox、`stroke-width: 1.75`、圓端點、`currentColor`——
 * 因此圖示一律跟隨文字色與主題,不需要為深/淺色各準備一份。
 */

export type IconName =
  | "alert"
  | "board"
  | "branch"
  | "check"
  | "checklist"
  | "chevron-down"
  | "chevron-right"
  | "clock"
  | "command"
  | "cost"
  | "external"
  | "folder"
  | "gauge"
  | "logout"
  | "menu"
  | "message"
  | "moon"
  | "pause"
  | "play"
  | "plus"
  | "refresh"
  | "search"
  | "settings"
  | "shield"
  | "sidebar"
  | "sparkle"
  | "sun"
  | "terminal"
  | "trash"
  | "user"
  | "users"
  | "x"
  | "zap";

/** 每個圖示的路徑內容(共用同一組 stroke 設定,見下方 <svg>)。 */
const PATHS: Record<IconName, JSX.Element> = {
  alert: (
    <>
      <path d="M10.3 3.9 2.4 17.4a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </>
  ),
  board: (
    <>
      <rect x="3" y="4" width="5.5" height="16" rx="1.5" />
      <rect x="9.75" y="4" width="5.5" height="11" rx="1.5" />
      <rect x="16.5" y="4" width="4.5" height="7" rx="1.5" />
    </>
  ),
  branch: (
    <>
      <circle cx="6" cy="5" r="2" />
      <circle cx="6" cy="19" r="2" />
      <circle cx="18" cy="9" r="2" />
      <path d="M6 7v10" />
      <path d="M18 11a5 5 0 0 1-5 5H9" />
    </>
  ),
  check: <path d="m4.5 12.5 5 5 10-11" />,
  checklist: (
    <>
      <path d="m3 6 2 2 3.5-3.5" />
      <path d="m3 16 2 2 3.5-3.5" />
      <path d="M12 6h9" />
      <path d="M12 16h9" />
    </>
  ),
  "chevron-down": <path d="m6 9.5 6 6 6-6" />,
  "chevron-right": <path d="m9.5 6 6 6-6 6" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  command: <path d="M15 6a3 3 0 1 1 3 3h-3V6Zm0 3v6m0 0h3a3 3 0 1 1-3 3v-3Zm0 0H9m0 0H6a3 3 0 1 0 3 3v-3Zm0 0V9m0 0H6a3 3 0 1 1 3-3v3Zm0 0h6" />,
  cost: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7v10" />
      <path d="M14.5 9.5a2.2 2.2 0 0 0-2.5-1.2c-1.4 0-2.4.8-2.4 1.9 0 1.2 1 1.7 2.6 2 1.7.4 2.7.9 2.7 2.1 0 1.2-1.1 2-2.6 2a2.6 2.6 0 0 1-2.7-1.6" />
    </>
  ),
  external: (
    <>
      <path d="M14 4h6v6" />
      <path d="M20 4 11 13" />
      <path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" />
    </>
  ),
  folder: <path d="M3 7.5A2 2 0 0 1 5 5.5h3.6a2 2 0 0 1 1.5.7l1 1.3H19a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-9Z" />,
  gauge: (
    <>
      <path d="M4 17a9 9 0 1 1 16 0" />
      <path d="m12 13 4-3.5" />
      <circle cx="12" cy="14" r="1.4" />
    </>
  ),
  logout: (
    <>
      <path d="M9 20H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h3" />
      <path d="m15 8 4 4-4 4" />
      <path d="M19 12H9" />
    </>
  ),
  menu: (
    <>
      <path d="M4 7h16" />
      <path d="M4 12h16" />
      <path d="M4 17h16" />
    </>
  ),
  message: <path d="M20 12.5c0 3.9-3.6 7-8 7-.9 0-1.8-.1-2.6-.4L5 21l1.2-3.2A6.6 6.6 0 0 1 4 12.5c0-3.9 3.6-7 8-7s8 3.1 8 7Z" />,
  moon: <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />,
  pause: (
    <>
      <rect x="7" y="5" width="3.5" height="14" rx="1" />
      <rect x="13.5" y="5" width="3.5" height="14" rx="1" />
    </>
  ),
  play: <path d="M8 5.5v13l11-6.5-11-6.5Z" />,
  plus: (
    <>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 11a8 8 0 0 0-13.7-4.6L4 8.6" />
      <path d="M4 5v4h4" />
      <path d="M4 13a8 8 0 0 0 13.7 4.6L20 15.4" />
      <path d="M20 19v-4h-4" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4.5 4.5" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="2.8" />
      <path d="M19.4 14.4a1.7 1.7 0 0 0 .4 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2v.2a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-2.9-1.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0-1.2-2.9H3a2 2 0 1 1 0-4h.2a1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 2.9-1.2V3a2 2 0 1 1 4 0v.2a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0 1.2 2.9H21a2 2 0 1 1 0 4h-.2a1.7 1.7 0 0 0-1.4 1Z" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3.5 5 6v5.5c0 4.2 2.9 7.6 7 9 4.1-1.4 7-4.8 7-9V6l-7-2.5Z" />
      <path d="m9.2 12 2 2 3.6-4" />
    </>
  ),
  sidebar: (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2" />
      <path d="M9.5 4.5v15" />
    </>
  ),
  sparkle: <path d="M12 3.5l1.9 4.8 4.8 1.9-4.8 1.9L12 17l-1.9-4.9L5.3 10.2l4.8-1.9L12 3.5Z" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5V5" />
      <path d="M12 19v2.5" />
      <path d="M4.2 4.2 6 6" />
      <path d="m18 18 1.8 1.8" />
      <path d="M2.5 12H5" />
      <path d="M19 12h2.5" />
      <path d="M4.2 19.8 6 18" />
      <path d="m18 6 1.8-1.8" />
    </>
  ),
  terminal: (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2" />
      <path d="m7.5 10 2 2-2 2" />
      <path d="M12.5 14h4" />
    </>
  ),
  trash: (
    <>
      <path d="M4.5 7h15" />
      <path d="M9.5 7V5.5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1V7" />
      <path d="M6.5 7l.8 11a2 2 0 0 0 2 1.9h5.4a2 2 0 0 0 2-1.9L17.5 7" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M5 20c0-3.3 3.1-5.5 7-5.5s7 2.2 7 5.5" />
    </>
  ),
  users: (
    <>
      <circle cx="9.5" cy="8.5" r="3.2" />
      <path d="M3.5 19.5c0-3 2.7-5 6-5s6 2 6 5" />
      <path d="M16.5 6.2a3.2 3.2 0 0 1 0 6.1" />
      <path d="M18 14.9c1.7.6 2.9 1.9 2.9 3.6" />
    </>
  ),
  x: (
    <>
      <path d="m6 6 12 12" />
      <path d="m18 6-12 12" />
    </>
  ),
  zap: <path d="M13.5 3 5.5 13.5H11l-.5 7.5 8-11H13l.5-7Z" />,
};

export interface IconProps {
  name: IconName;
  /** 邊長(px)。預設 14——與 11/12px 的文字並排時視覺重量最接近。 */
  size?: number;
  className?: string;
  /** 少數需要更細/更粗描邊的場合(例如 10px 的極小徽章圖示)。 */
  strokeWidth?: number;
}

export function Icon({ name, size = 14, className, strokeWidth = 1.75 }: IconProps): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={`flex-shrink-0 ${className ?? ""}`}
    >
      {PATHS[name]}
    </svg>
  );
}
