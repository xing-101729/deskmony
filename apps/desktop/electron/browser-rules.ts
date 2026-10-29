/**
 * browser-rules.ts(2026-10-20,右側面板 P3「Browser 分頁」,見 docs/LAYER-4-detail-design/side-panel_detail.md §P3)。
 *
 * **Electron main 與 renderer 共用的純判斷**——網址允許哪些 scheme、partition 名稱長什麼樣子才合法、網址列輸入怎麼正規化、
 * 哪些組合鍵要從 webview 轉回 app。安全規則只能有**一份**:main(`will-attach-webview`、導覽事件、IPC 驗證)與
 * renderer(網址列、建立 webview)各寫一套就會漂移,漂移的那一天就是缺口。
 *
 * **刻意不 import 任何東西**:
 *  - main 以 NodeNext 編譯(`tsconfig.electron.json`,rootDir 是 `electron/`),renderer 由 Vite 打包——放在這裡兩邊都能引入
 *    (renderer 以 `../../electron/browser-rules.js` 引用);
 *  - `scripts/e2e-side-panel-pure.mjs` 直接用 Node 載入這個 .ts 驗證(同 `src/lib/chat-groups.ts` 的慣例)。
 *
 * 判斷一律用 WHATWG `URL` 解析、再看解析結果(`protocol`/`href`),不用字串前綴比對——`java\nscript:`、` JAVASCRIPT:`、
 * 前導控制字元這類變體,URL 解析器與 Chromium 的處理一致(會剝掉 tab/換行與前後空白、scheme 轉小寫),我們與瀏覽器看到的是同一個 scheme。
 */

/** 網址長度上限(超過一律拒絕,避免把整段資料塞進網址列/屬性)。 */
export const BROWSER_URL_MAX_LENGTH = 8192;

/** 允許的 partition:`deskmony-browser-<id>`,**不帶 `persist:`**(= 記憶體 partition,session 刪除或 app 重開就清空,DECISIONS §L.3)。 */
export const BROWSER_PARTITION_PATTERN = /^deskmony-browser-[A-Za-z0-9_-]+$/;
const BROWSER_PARTITION_PREFIX = "deskmony-browser-";
const BROWSER_PARTITION_MAX_LENGTH = 200;

/**
 * 這個網址(webview 的 `src` 或導覽目標)能不能載入:只有 `http:`、`https:` 與**剛好是** `about:blank`。
 * `file:`、`chrome:`、`devtools:`、`javascript:`、`data:`、`blob:`、`view-source:`、`about:` 的其他路徑……一律不行。
 */
export function isAllowedWebviewUrl(rawUrl: unknown): boolean {
  if (typeof rawUrl !== "string" || rawUrl.length === 0 || rawUrl.length > BROWSER_URL_MAX_LENGTH) return false;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.hostname.length > 0;
  return parsed.href === "about:blank";
}

/**
 * 導覽事件(`will-navigate`/`will-redirect`/`will-frame-navigate`)用:主框架嚴格照 `isAllowedWebviewUrl()`;
 * **子框架**另外放行 `about:srcdoc`、`blob:`、`data:`——這三種在 iframe 裡是 opaque origin、讀不到任何本機資源,而一般網頁(含本機開發伺服器的
 * 預覽頁、線上編輯器)很常用 `srcdoc`/`blob:`/`data:` 的 iframe,整個擋掉會讓這些頁面壞掉;真正危險的 `file:`/`chrome:`/`devtools:`/`javascript:`
 * 在任何框架都不放行。
 */
export function isAllowedNavigationUrl(rawUrl: unknown, isMainFrame: boolean): boolean {
  if (isAllowedWebviewUrl(rawUrl)) return true;
  if (isMainFrame || typeof rawUrl !== "string" || rawUrl.length > BROWSER_URL_MAX_LENGTH) return false;
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === "blob:" || parsed.protocol === "data:" || parsed.href === "about:srcdoc";
  } catch {
    return false;
  }
}

/** 能不能交給外部瀏覽器(`shell.openExternal`):只有 http(s)——`about:blank` 沒有意義、其餘更不行。 */
export function isExternallyOpenableUrl(rawUrl: unknown): boolean {
  if (!isAllowedWebviewUrl(rawUrl)) return false;
  const protocol = new URL(rawUrl as string).protocol;
  return protocol === "http:" || protocol === "https:";
}

/** `<webview>` 的這些屬性會放寬隔離或改寫上面強制的設定:不論 renderer 怎麼寫都拿掉。 */
const STRIPPED_WEBVIEW_ATTRIBUTES = ["preload", "disablewebsecurity", "nodeintegration", "nodeintegrationinsubframes", "webpreferences", "plugins"] as const;

/**
 * `will-attach-webview` 的政策(純函式,main 與測試共用;原地修改傳入的兩個物件):
 *  - partition 必須是 `deskmony-browser-<id>`(不帶 `persist:`)、`src` 必須是 http(s) 或 `about:blank`,否則回傳 `false`(呼叫端要 `preventDefault()` 取消 attach);
 *  - guest 的 webPreferences 一律強制成最嚴格的值、刪掉 `preload`/`preloadURL`;
 *  - 會放寬隔離的 `<webview>` 屬性一律拿掉;
 *  - `allowpopups` 反過來**強制設成允許**(不信任 renderer 傳什麼,連 "false" 也蓋掉):沒有它時 `window.open`/`target=_blank` 在 guest 端就被吞掉,
 *    `setWindowOpenHandler` 根本不會被呼叫。開它是安全的:每次彈出都進永遠回傳 `deny` 的 handler,不會建立任何新視窗,
 *    只有 http(s) 目標(`popupRedirectUrl()`)改在同一個 webview 導過去。
 */
export function enforceWebviewAttachPolicy(webPreferences: object, params: Record<string, string>): boolean {
  if (!isAllowedBrowserPartition(params.partition) || !isAllowedWebviewUrl(params.src)) return false;
  const prefs = webPreferences as Record<string, unknown>;
  delete prefs.preload;
  delete prefs.preloadURL;
  prefs.nodeIntegration = false;
  prefs.nodeIntegrationInSubFrames = false;
  prefs.nodeIntegrationInWorker = false;
  prefs.contextIsolation = true;
  prefs.sandbox = true;
  prefs.webSecurity = true;
  prefs.allowRunningInsecureContent = false;
  prefs.webviewTag = false; // guest 裡不能再嵌 webview
  prefs.experimentalFeatures = false;
  for (const attribute of STRIPPED_WEBVIEW_ATTRIBUTES) delete params[attribute];
  params.allowpopups = "true";
  return true;
}

/**
 * 頁面要彈出視窗(`window.open`、`target=_blank`)時,`setWindowOpenHandler` 要不要把目標改成「在同一個 webview 導過去」:
 * 只有 http(s) 才會——回傳要載入的網址;`about:blank`(`window.open()` 不帶網址)、`file:`、`javascript:`、`data:` 等一律回 `undefined`(什麼都不做)。
 * handler 本身永遠回傳 `deny`,不會產生任何新視窗。
 */
export function popupRedirectUrl(rawUrl: unknown): string | undefined {
  return isExternallyOpenableUrl(rawUrl) ? (rawUrl as string) : undefined;
}

export function isAllowedBrowserPartition(partition: unknown): boolean {
  return (
    typeof partition === "string" &&
    partition.length <= BROWSER_PARTITION_MAX_LENGTH &&
    BROWSER_PARTITION_PATTERN.test(partition)
  );
}

/**
 * session id → partition 名稱;id 含不合法字元(session id 是 UUID,正常不會)→ `undefined`,呼叫端當成「這個 session 不能開瀏覽器」。
 * 不替不合法的 id 做「清理」:兩個不同的 id 清理後撞成同一個 partition 就等於共用登入狀態。
 */
export function browserPartitionForSession(sessionId: unknown): string | undefined {
  if (typeof sessionId !== "string") return undefined;
  const partition = `${BROWSER_PARTITION_PREFIX}${sessionId}`;
  return isAllowedBrowserPartition(partition) ? partition : undefined;
}

// ---- 網址列輸入 ------------------------------------------------------------------------------------

export type AddressResolution =
  | { kind: "url"; url: string }
  | { kind: "empty" }
  /** `notUrl`:不像網址(含空白——第一版沒有搜尋引擎,不把輸入的字送給第三方)、`unsupportedScheme`:有 scheme 但不是 http/https/about:blank。 */
  | { kind: "invalid"; reason: "notUrl" | "unsupportedScheme" };

/**
 * 一個「看起來像 scheme」的前綴:字母開頭、字母數字與 `+.-`、冒號——**但冒號後面緊接著純數字再接 `/?#` 或結尾的,是 `host:port`**
 * (`localhost:5173`、`example.com:8080`、`my-host:3000/path`),不是 scheme。
 */
const SCHEME_PREFIX = /^([A-Za-z][A-Za-z0-9+.-]*):(?!\d+(?:[/?#]|$))/;

/** 這個主機部分要不要預設補 `http://`:`localhost`、`*.localhost`、IPv4 字面值、方括號的 IPv6 字面值,或帶明確 port。 */
function defaultsToHttp(authority: string): boolean {
  // 去掉 userinfo(`user:pw@`)再看 host:port。
  const hostPort = authority.slice(authority.lastIndexOf("@") + 1);
  if (hostPort.startsWith("[")) return true; // IPv6 字面值(`[::1]`、`[::1]:3000`)
  const portSplit = hostPort.lastIndexOf(":");
  const host = (portSplit >= 0 ? hostPort.slice(0, portSplit) : hostPort).toLowerCase();
  if (portSplit >= 0) return true; // 有明確 port(`example.com:8080`)
  return host === "localhost" || host.endsWith(".localhost") || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);
}

/**
 * 網址列輸入 → 要載入的網址。規則:
 *  - 前後空白修剪;空字串 → `empty`;**含空白(修剪後仍有)→ `notUrl`**:第一版沒有搜尋引擎——把使用者輸入的字送給
 *    第三方搜尋服務是該由使用者自己選擇的事,這裡寧可明確說「這不是網址」。
 *  - 有 scheme(`SCHEME_PREFIX`):必須是 `http:`/`https:`/剛好 `about:blank`,否則 `unsupportedScheme`
 *    (`file:///x`、`javascript:alert(1)`、`chrome://gpu`、`mailto:a@b`、`data:text/html,…`、`view-source:…`)。
 *  - 沒有 scheme:`localhost`、`*.localhost`、IPv4、`[IPv6]` 或帶 `:port` 的補 `http://`,其餘(`example.com`)補 `https://`。
 *    `//example.com`(協定相對)同樣依主機決定。
 *  - 最後一律過 `isAllowedWebviewUrl()`;回傳的是 `URL.href`(正規化過:`localhost:5173` → `http://localhost:5173/`)。
 */
export function normalizeAddressInput(input: string): AddressResolution {
  const text = (typeof input === "string" ? input : "").trim();
  if (text.length === 0) return { kind: "empty" };
  if (/\s/.test(text) || text.length > BROWSER_URL_MAX_LENGTH) return { kind: "invalid", reason: "notUrl" };

  let candidate: string;
  if (SCHEME_PREFIX.test(text)) {
    candidate = text;
  } else {
    const withoutSlashes = text.startsWith("//") ? text.slice(2) : text;
    const authority = withoutSlashes.split(/[/?#]/, 1)[0];
    if (authority.length === 0) return { kind: "invalid", reason: "notUrl" };
    candidate = `${defaultsToHttp(authority) ? "http" : "https"}://${withoutSlashes}`;
  }

  // 有 scheme 但解析失敗:http(s) 的壞網址(`http://`)是 notUrl;其他 scheme 本來就不支援。
  const scheme = SCHEME_PREFIX.exec(text)?.[1]?.toLowerCase();
  const failure = (): AddressResolution => ({
    kind: "invalid",
    reason: scheme === undefined || scheme === "http" || scheme === "https" ? "notUrl" : "unsupportedScheme",
  });
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return failure();
  }
  if (!isAllowedWebviewUrl(parsed.href)) return failure();
  return { kind: "url", url: parsed.href };
}

// ---- 從 webview 轉回 app 的組合鍵 --------------------------------------------------------------------

export type AppShortcutAction = "toggle-panel" | "open-terminal" | "open-palette";

/** Electron `before-input-event` 的 `Input`(只取要用的欄位)。 */
export interface InputLike {
  type: string;
  key: string;
  control: boolean;
  meta: boolean;
  shift: boolean;
  alt: boolean;
}

/**
 * 焦點在 webview(guest 行程)裡時,鍵盤事件不會進 app 的 renderer,`ui/hotkeys.ts` 註冊的組合鍵收不到。
 * main 對 guest 掛 `before-input-event`,**只攔這三個組合鍵**(其餘按鍵一律照常給網頁),攔下後經 IPC 轉給 renderer 執行同樣的動作。
 * 語意與 `ui/hotkeys.ts` 的 `matches()` 一致:`mod` 在 macOS 是 ⌘、其他平台是 Ctrl;`ctrl+\`` 是**字面** Ctrl(沒有 ⌘)。
 *  - `mod+j` → 開/關面板;`ctrl+\`` → 開面板並切到 Terminal;`mod+k` → 命令面板。
 * 只認 `keyDown`(`keyUp` 不處理,也不攔——只攔 keyDown 就夠讓網頁收不到這次按鍵)。
 */
export function matchAppShortcut(input: InputLike, isMac: boolean): AppShortcutAction | undefined {
  if (input.type !== "keyDown" || input.alt || input.shift) return undefined;
  const key = input.key.toLowerCase();
  const mod = isMac ? input.meta && !input.control : input.control && !input.meta;
  if (mod && key === "j") return "toggle-panel";
  if (mod && key === "k") return "open-palette";
  if (key === "`" && input.control && !input.meta) return "open-terminal";
  return undefined;
}
