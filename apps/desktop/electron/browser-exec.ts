/**
 * browser-exec.ts(2026-10-21,右側面板 P4b「Electron 端執行器」,見 docs/LAYER-4-detail-design/side-panel_detail.md §P4b 與 §P4a 實作備註的「留給 P4b 的介面」)。
 *
 * agent 瀏覽器工具在**桌面 app 這一端**怎麼真的執行:core 把 `browser-command`(op + args)送給 renderer(host),renderer 經 IPC 交給 main,
 * main 在這裡用 CDP(`webContents.debugger`)與 isolated world 腳本操作那個 session 的 `<webview>` guest。
 *
 * ## 為什麼拆成「這個檔案」與 `browser-executor.ts`
 * 這個檔案**不 import 任何東西**(連 electron 都沒有),整個執行流程(導覽等待、截圖縮放與座標換算、staleScreenshot 判斷、ref 解析、
 * 滑鼠/鍵盤事件序列、逾時、錯誤碼對照、結果整形)都對一個抽象的 `BrowserGuestDriver` 寫。`browser-executor.ts` 才是把 `WebContents`
 * 包成 driver 的薄薄一層 Electron 膠水。好處是 `scripts/e2e-side-panel-pure.mjs` 能直接用 Node 載入這個 .ts、餵一個假 driver,把不需要
 * 真 Electron 就能驗的邏輯全部驗掉(同 `browser-rules.ts` 的慣例);真正只能在 Electron 裡驗的,只剩 driver 那一層(見 `browser-executor.ts` 檔頭)。
 *
 * ## 安全與正確性的幾條原則
 *  - **網頁內容一律是不可信資料**:read_page 只回文字與元素描述;所有從頁面來的值都在 `buildReadTextResult()`/`buildInteractiveResult()`
 *    重新檢查型別與長度,不原樣信任。
 *  - **不在頁面 DOM 上留任何東西**:ref → 元素的對照表放在 isolated world 的全域(`window.__deskmonyRefs`,頁面的 JS 看不到);腳本不寫入屬性/dataset、
 *    不改樣式、不插入節點(唯一的副作用是 `scrollIntoView` 與 `focus`)。導覽之後 isolated world 的 context 隨文件重建,對照表自然消失 → `browser.staleRef`。
 *  - **逾時一律小於 core 的**:core 對導覽 30 秒、其他 15 秒計時(從送出指令起);這裡導覽最多等 25 秒(逾時回 `loaded:false`,不讓 core 先逾時)、
 *    其他 op 整體 12 秒。
 *  - 從頁面讀來的 viewport 尺寸用 **isolated world** 的 `window.innerWidth/innerHeight`——頁面在它自己的世界裡改寫 `innerWidth` 影響不到這裡,
 *    座標換算不會被騙。
 */

// ---- 常數 -------------------------------------------------------------------

/** isolated world 的 id(任意整數;0 是頁面本身、999 是 Electron 的 contextIsolation,避開)。 */
export const EXEC_WORLD_ID = 7101;
/** 截圖長邊上限(像素)與 JPEG 品質。與 `packages/shared` 的 `BROWSER_SCREENSHOT_MAX_EDGE` 同值(e2e 有比對)。 */
export const SCREENSHOT_MAX_EDGE = 1568;
export const SCREENSHOT_JPEG_QUALITY = 65;
/** 導覽最多等這麼久(要**小於** core 的 30 秒);逾時回 `loaded: false`。 */
export const NAVIGATE_WAIT_MS = 25_000;
/** 其他 op 的整體上限(要小於 core 的 15 秒)。導覽的整體上限是 `NAVIGATE_WAIT_MS` 加一點緩衝。 */
export const COMMAND_DEADLINE_MS = 12_000;
export const NAVIGATE_DEADLINE_MS = NAVIGATE_WAIT_MS + 3_000;
/** 點擊/按 Enter 之後,先等這麼久看有沒有開始導覽,有的話最多再等這麼久載完(再回傳 url/title)。 */
export const SETTLE_START_MS = 250;
export const SETTLE_MAX_MS = 5_000;
/** `browser_scroll` 的一個單位 = 視窗高度的 80%;預設 1、上限 20。 */
export const SCROLL_PAGE_RATIO = 0.8;
export const SCROLL_DEFAULT_AMOUNT = 1;
export const SCROLL_MAX_AMOUNT = 20;
/** `browser_read_page` 的 maxChars 預設/上限、互動元素數量上限、單一元素的名稱/網址長度上限。 */
export const READ_PAGE_DEFAULT_MAX_CHARS = 20_000;
export const READ_PAGE_MAX_CHARS = 100_000;
export const INTERACTIVE_MAX_ELEMENTS = 500;
export const ELEMENT_NAME_MAX_CHARS = 120;
export const ELEMENT_HREF_MAX_CHARS = 2048;
/** 截圖座標容許的 viewport 尺寸誤差(CSS px):四捨五入造成的 1px 不算「尺寸變了」。 */
export const VIEWPORT_TOLERANCE_PX = 1;

// ---- 錯誤 -------------------------------------------------------------------

/** host 可以回報的錯誤碼(同 `packages/shared` 的 `BROWSER_HOST_ERROR_CODES`;不認得的 core 會轉成 `browser.hostError`)。 */
export const ExecErrorCodes = {
  STALE_REF: "browser.staleRef",
  STALE_SCREENSHOT: "browser.staleScreenshot",
  NO_SCREENSHOT: "browser.noScreenshot",
  ELEMENT_NOT_FOUND: "browser.elementNotFound",
  NAVIGATION_FAILED: "browser.navigationFailed",
  HOST_ERROR: "browser.hostError",
} as const;

export class BrowserExecError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "BrowserExecError";
    this.code = code;
  }
}

const hostError = (message: string): BrowserExecError => new BrowserExecError(ExecErrorCodes.HOST_ERROR, message);

/** IPC 回給 renderer 的結果:期待中的失敗一律走 `ok:false`(不丟例外),renderer 原樣轉成 `browser.commandResult`。 */
export type BrowserExecOutcome =
  | { ok: true; result: unknown }
  | { ok: false; error: { code: string; message: string } };

/** 任何丟出來的東西 → host 回報用的 `{code, message}`。非 `BrowserExecError` 一律 `browser.hostError`(CDP/Electron 的錯誤訊息原樣當說明)。 */
export function mapExecError(err: unknown): { code: string; message: string } {
  if (err instanceof BrowserExecError) return { code: err.code, message: err.message.slice(0, 1800) };
  const message = err instanceof Error ? err.message : String(err);
  return { code: ExecErrorCodes.HOST_ERROR, message: (message || "未知的錯誤").slice(0, 1800) };
}

// ---- 鍵盤 -------------------------------------------------------------------

export interface KeySpec {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  /** 會產生字元的鍵(Enter、Space)帶 text,CDP 以 `keyDown` 送;其餘用 `rawKeyDown`。 */
  text?: string;
}

/**
 * `browser_press_key` 允許的十四個鍵 → CDP `Input.dispatchKeyEvent` 的 key / code / windowsVirtualKeyCode(Windows virtual-key code,
 * 與 Puppeteer 的 keyDefinitions 同值)。名稱與 `packages/shared` 的 `BROWSER_KEYS` 一致(e2e 有比對)。
 */
export const KEY_TABLE: Readonly<Record<string, KeySpec>> = {
  Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
  Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  Delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
  PageUp: { key: "PageUp", code: "PageUp", windowsVirtualKeyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", windowsVirtualKeyCode: 34 },
  Home: { key: "Home", code: "Home", windowsVirtualKeyCode: 36 },
  End: { key: "End", code: "End", windowsVirtualKeyCode: 35 },
  Space: { key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " },
};

export interface CdpKeyEvent {
  type: "keyDown" | "rawKeyDown" | "keyUp";
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  nativeVirtualKeyCode: number;
  text?: string;
  unmodifiedText?: string;
}

/** 按一個鍵 = 一次按下 + 一次放開。不認得的鍵名丟錯(core 與 MCP schema 已限制成列舉,這裡是縱深防禦)。 */
export function keyEventsFor(name: string): CdpKeyEvent[] {
  const spec = Object.prototype.hasOwnProperty.call(KEY_TABLE, name) ? KEY_TABLE[name] : undefined;
  if (!spec) throw hostError(`不支援的按鍵: ${name}`);
  const base = { key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.windowsVirtualKeyCode, nativeVirtualKeyCode: spec.windowsVirtualKeyCode };
  const down: CdpKeyEvent = spec.text
    ? { type: "keyDown", ...base, text: spec.text, unmodifiedText: spec.text }
    : { type: "rawKeyDown", ...base };
  return [down, { type: "keyUp", ...base }];
}

// ---- 截圖縮放與座標換算 -------------------------------------------------------------

/** 最近一次截圖的紀錄:截圖當下頁面的 viewport(CSS px)與**回傳的圖**的像素尺寸。`browser_click` 的 x/y 就是這張圖的座標。 */
export interface ScreenshotRecord {
  cssWidth: number;
  cssHeight: number;
  width: number;
  height: number;
}

/** 長邊超過 `maxEdge` 時等比縮小(四捨五入、至少 1px);沒超過就原尺寸。 */
export function fitWithin(width: number, height: number, maxEdge: number): { width: number; height: number; scaled: boolean } {
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width, height, scaled: false };
  const ratio = maxEdge / longest;
  return { width: Math.max(1, Math.round(width * ratio)), height: Math.max(1, Math.round(height * ratio)), scaled: true };
}

/** 截圖像素座標 → 頁面 CSS px(CDP `Input.dispatchMouseEvent` 的座標系)。超出圖的範圍丟錯。 */
export function imageToCss(record: ScreenshotRecord, x: number, y: number): { x: number; y: number } {
  if (!(x >= 0 && y >= 0 && x < record.width && y < record.height)) {
    throw hostError(`座標 (${x}, ${y}) 超出最近一次截圖的範圍(${record.width}×${record.height} 像素)`);
  }
  return { x: (x * record.cssWidth) / record.width, y: (y * record.cssHeight) / record.height };
}

/** 截圖之後頁面的 viewport 尺寸變了(使用者開關面板,webview 在 slot 尺寸與停放的 1024×768 之間切換)→ 座標會失準。 */
export function isScreenshotStale(record: ScreenshotRecord, current: { cssWidth: number; cssHeight: number }): boolean {
  return (
    Math.abs(record.cssWidth - current.cssWidth) > VIEWPORT_TOLERANCE_PX ||
    Math.abs(record.cssHeight - current.cssHeight) > VIEWPORT_TOLERANCE_PX
  );
}

// ---- isolated world 腳本 ------------------------------------------------------------
//
// 全部是「回傳可結構化複製的值」的 IIFE 表達式,在 isolated world 執行(`executeJavaScriptInIsolatedWorld`)。ref 對照表存在那個世界的
// `window.__deskmonyRefs`(頁面看不到)。腳本只讀 DOM;唯二的副作用是 `scrollIntoView` 與 `focus`。

/** 目前 viewport 的 CSS 尺寸(isolated world 的 window——頁面改寫自己的 `innerWidth` 影響不到)。 */
export const VIEWPORT_SCRIPT = "({ cssWidth: window.innerWidth, cssHeight: window.innerHeight })";

/** 目前聚焦的元素是不是能輸入文字的(input 文字類/textarea/contenteditable/role=textbox)。 */
export const EDITABLE_FOCUS_SCRIPT = `(() => {
  const el = document.activeElement;
  if (!el || el === document.body || el === document.documentElement) return false;
  const tag = el.tagName;
  if (tag === 'TEXTAREA') return !el.readOnly && !el.disabled;
  if (tag === 'INPUT') {
    const type = String(el.type || 'text').toLowerCase();
    const nonText = ['button', 'submit', 'reset', 'checkbox', 'radio', 'file', 'image', 'range', 'color', 'hidden'];
    return nonText.indexOf(type) < 0 && !el.readOnly && !el.disabled;
  }
  return el.isContentEditable === true || el.getAttribute('role') === 'textbox';
})()`;

/** 頁面可見文字(`body.innerText`),超過 maxChars 截斷;網址與標題一併回。 */
export function buildReadTextScript(maxChars: number): string {
  const max = Math.max(1, Math.min(READ_PAGE_MAX_CHARS, Math.floor(maxChars)));
  return `(() => {
  const max = ${max};
  const body = document.body;
  const full = body ? String(body.innerText || '') : '';
  return { url: String(location.href), title: String(document.title || ''), text: full.length > max ? full.slice(0, max) : full, truncated: full.length > max };
})()`;
}

/**
 * 可互動元素清單 + 在 isolated world 建立 ref 對照表(`window.__deskmonyRefs`)。每次呼叫都**整份重建**:舊的 ref 失效。
 * 名稱不含文字輸入框的 value(可能是使用者輸入的機密),只有按鈕型 input 才用 value。
 */
export function buildInteractiveScript(maxElements: number): string {
  const max = Math.max(1, Math.min(INTERACTIVE_MAX_ELEMENTS, Math.floor(maxElements)));
  return `(() => {
  const MAX = ${max};
  const NAME_MAX = ${ELEMENT_NAME_MAX_CHARS};
  const SELECTOR = 'a[href],button,input:not([type="hidden"]),select,textarea,summary,[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="tab"],[role="menuitem"],[role="switch"],[role="option"],[role="combobox"],[role="textbox"],[contenteditable=""],[contenteditable="true"],[onclick]';
  const clean = (s) => String(s == null ? '' : s).replace(/\\s+/g, ' ').trim();
  const visible = (el) => {
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    if (el.closest('[hidden],[inert]')) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const roleOf = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit) return clean(explicit).split(' ')[0];
    const tag = el.tagName;
    if (tag === 'A') return 'link';
    if (tag === 'BUTTON' || tag === 'SUMMARY') return 'button';
    if (tag === 'SELECT') return 'combobox';
    if (tag === 'TEXTAREA') return 'textbox';
    if (tag === 'INPUT') {
      const type = String(el.type || 'text').toLowerCase();
      if (type === 'checkbox' || type === 'radio') return type;
      if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image') return 'button';
      if (type === 'range') return 'slider';
      return 'textbox';
    }
    return el.isContentEditable === true ? 'textbox' : 'generic';
  };
  const nameOf = (el) => {
    let name = clean(el.getAttribute('aria-label'));
    if (!name) {
      const ids = clean(el.getAttribute('aria-labelledby'));
      if (ids) name = clean(ids.split(' ').map((id) => { const t = document.getElementById(id); return t ? t.textContent : ''; }).join(' '));
    }
    if (!name && el.labels && el.labels.length > 0) name = clean(Array.prototype.map.call(el.labels, (l) => l.textContent).join(' '));
    if (!name && el.tagName === 'INPUT') {
      const type = String(el.type || 'text').toLowerCase();
      if (type === 'submit' || type === 'button' || type === 'reset') name = clean(el.value);
      if (!name) name = clean(el.getAttribute('placeholder'));
      if (!name && type === 'image') name = clean(el.getAttribute('alt'));
    }
    if (!name) name = clean(el.getAttribute('placeholder'));
    if (!name && el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA' && el.tagName !== 'SELECT') name = clean(el.innerText || el.textContent);
    if (!name) name = clean(el.getAttribute('title')) || clean(el.getAttribute('alt'));
    return name.length > NAME_MAX ? name.slice(0, NAME_MAX) : name;
  };
  const table = new Map();
  const elements = [];
  let truncated = false;
  const nodes = document.querySelectorAll(SELECTOR);
  for (let i = 0; i < nodes.length; i++) {
    const el = nodes[i];
    if (el.disabled) continue;
    if (!visible(el)) continue;
    if (elements.length >= MAX) { truncated = true; break; }
    const ref = 'e' + (elements.length + 1);
    table.set(ref, el);
    const entry = { ref: ref, role: roleOf(el), name: nameOf(el) };
    if (el.tagName === 'A') {
      const href = String(el.href || '');
      if (/^https?:/i.test(href)) entry.href = href;
    }
    elements.push(entry);
  }
  window.__deskmonyRefs = { table: table };
  return { url: String(location.href), title: String(document.title || ''), elements: elements, truncated: truncated };
})()`;
}

/**
 * ref → 元素:`scrollIntoView`(instant,不管頁面有沒有設 smooth)之後取中心座標(viewport 的 CSS px);`focus` 為真時順便聚焦它。
 * 回傳 `{x, y, focused?}` 或 `{error: 'stale' | 'nobox'}`——對照表不在(導覽之後 context 重建)、ref 不在表裡、元素已脫離文件 = 'stale'。
 */
export function buildResolveRefScript(ref: string, focus: boolean): string {
  return `((ref, focus) => {
  const refs = window.__deskmonyRefs;
  if (!refs) return { error: 'stale' };
  const el = refs.table.get(ref);
  if (!el || !el.isConnected) return { error: 'stale' };
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const r = el.getBoundingClientRect();
  if (!(r.width > 0 && r.height > 0)) return { error: 'nobox' };
  let focused;
  if (focus) {
    try { el.focus({ preventScroll: true }); } catch (e) {}
    focused = document.activeElement === el;
  }
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, focused: focused };
})(${JSON.stringify(ref)}, ${focus ? "true" : "false"})`;
}

// ---- 腳本結果的整形(頁面來的值一律重新檢查)----------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

/** 切在 surrogate pair 中間會留下壞掉的半個字元——丟掉結尾孤立的高位 surrogate。 */
export function dropTrailingHighSurrogate(text: string): string {
  if (text.length === 0) return text;
  const last = text.charCodeAt(text.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? text.slice(0, -1) : text;
}

export function buildReadTextResult(raw: unknown, maxChars: number): { mode: "text"; url: string; title: string; text: string; truncated: boolean } {
  const rec = isRecord(raw) ? raw : {};
  const max = Math.max(1, Math.min(READ_PAGE_MAX_CHARS, Math.floor(maxChars)));
  const text = typeof rec.text === "string" ? rec.text : "";
  const over = text.length > max;
  return {
    mode: "text",
    url: str(rec.url, 8192),
    title: str(rec.title, 1000),
    text: over ? dropTrailingHighSurrogate(text.slice(0, max)) : text,
    truncated: over || rec.truncated === true,
  };
}

export function buildInteractiveResult(raw: unknown): {
  mode: "interactive";
  url: string;
  title: string;
  elements: Array<{ ref: string; role: string; name: string; href?: string }>;
  truncated: boolean;
} {
  const rec = isRecord(raw) ? raw : {};
  const list = Array.isArray(rec.elements) ? rec.elements : [];
  const elements: Array<{ ref: string; role: string; name: string; href?: string }> = [];
  let truncated = rec.truncated === true;
  for (const item of list) {
    if (!isRecord(item)) continue;
    const ref = str(item.ref, 64);
    if (!/^e[0-9]+$/.test(ref)) continue; // ref 只可能是我們自己產生的 e<N>——頁面不可能塞進別的東西
    if (elements.length >= INTERACTIVE_MAX_ELEMENTS) {
      truncated = true;
      break;
    }
    const entry: { ref: string; role: string; name: string; href?: string } = {
      ref,
      role: str(item.role, 40) || "generic",
      name: str(item.name, ELEMENT_NAME_MAX_CHARS),
    };
    const href = str(item.href, ELEMENT_HREF_MAX_CHARS);
    if (/^https?:\/\//i.test(href)) entry.href = href;
    elements.push(entry);
  }
  return { mode: "interactive", url: str(rec.url, 8192), title: str(rec.title, 1000), elements, truncated };
}

/** `buildResolveRefScript()` 的結果 → 座標,或對應的錯誤。 */
export function interpretResolveResult(raw: unknown): { x: number; y: number; focused?: boolean } {
  if (isRecord(raw) && raw.error === "stale") {
    throw new BrowserExecError(ExecErrorCodes.STALE_REF, "這個 ref 已經失效(頁面導覽過、或元素已不在文件裡)。請重新 browser_read_page(mode=interactive)取得新的 ref。");
  }
  if (isRecord(raw) && raw.error === "nobox") {
    throw new BrowserExecError(ExecErrorCodes.ELEMENT_NOT_FOUND, "那個元素目前沒有可點擊的位置(沒有大小,或被隱藏)。");
  }
  if (!isRecord(raw) || typeof raw.x !== "number" || typeof raw.y !== "number" || !Number.isFinite(raw.x) || !Number.isFinite(raw.y)) {
    throw hostError("解析元素位置失敗(頁面回傳的格式不對)");
  }
  return { x: raw.x, y: raw.y, focused: typeof raw.focused === "boolean" ? raw.focused : undefined };
}

// ---- driver 與執行 -------------------------------------------------------------------

export interface LoadOutcome {
  /** 主框架載完了(`did-finish-load`)。 */
  finished: boolean;
  /** 等到上限都還沒載完。 */
  timedOut?: boolean;
  /** 主框架載入失敗(ERR_ABORTED 由 driver 忽略,不會出現在這裡)。 */
  failure?: { code: number; description: string; url: string };
}

export interface LoadWaiter {
  promise: Promise<LoadOutcome>;
  cancel(): void;
}

/** 一個 `<webview>` guest 的最小操作介面。`browser-executor.ts` 用 `WebContents` 實作;測試用假的。 */
export interface BrowserGuestDriver {
  /** CDP 指令(`webContents.debugger.sendCommand`,已含逾時與重新 attach)。 */
  cdp(method: string, params?: Record<string, unknown>): Promise<unknown>;
  /** 在 isolated world 執行腳本,回傳它最後一個運算式的值。 */
  evalIsolated(code: string): Promise<unknown>;
  getUrl(): string;
  getTitle(): string;
  isLoading(): boolean;
  /** 這個網址能不能導覽(只放行 http(s),用 `browser-rules` 的判斷;縱深防禦,core 已經檢查過一次)。 */
  isUrlAllowed(url: string): boolean;
  /** 開始載入(不等載完;載完/失敗由 `waitForLoad()` 觀察)。 */
  loadUrl(url: string): Promise<void>;
  /** back/forward/reload;沒有歷史可走回傳 false。 */
  goHistory(action: "back" | "forward" | "reload"): boolean;
  /** 在**觸發導覽之前**呼叫:開始觀察主框架的載入結果(`did-finish-load` / `did-fail-load`),最多等 `timeoutMs`。 */
  waitForLoad(timeoutMs: number): LoadWaiter;
  /** 等載入停止(沒在載入就立刻 resolve),最多等 `timeoutMs`。 */
  waitForLoadStop(timeoutMs: number): Promise<void>;
  /** JPEG(base64)的像素尺寸。 */
  jpegSize(base64: string): { width: number; height: number };
  /** 縮放 JPEG 並重新編碼(base64)。 */
  resizeJpeg(base64: string, width: number, height: number, quality: number): string;
  sleep(ms: number): Promise<void>;
}

/** 每個 guest 一份、跨指令保留的狀態。 */
export interface GuestState {
  screenshot?: ScreenshotRecord;
}

export function createGuestState(): GuestState {
  return {};
}

function argsRecord(args: unknown): Record<string, unknown> {
  return isRecord(args) ? args : {};
}

async function readViewport(driver: BrowserGuestDriver): Promise<{ cssWidth: number; cssHeight: number }> {
  const raw = await driver.evalIsolated(VIEWPORT_SCRIPT);
  const w = isRecord(raw) ? raw.cssWidth : undefined;
  const h = isRecord(raw) ? raw.cssHeight : undefined;
  if (typeof w !== "number" || typeof h !== "number" || !(w > 0) || !(h > 0)) {
    throw hostError("頁面目前沒有可見的畫面(viewport 尺寸是 0)");
  }
  return { cssWidth: w, cssHeight: h };
}

async function mouseClick(driver: BrowserGuestDriver, x: number, y: number): Promise<void> {
  await driver.cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await driver.cdp("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
  await driver.cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
}

async function pressKeyName(driver: BrowserGuestDriver, name: string): Promise<void> {
  for (const event of keyEventsFor(name)) await driver.cdp("Input.dispatchKeyEvent", { ...event });
}

/** 輸入類動作之後:先等一下看有沒有開始導覽,有的話等它載完(有上限)——之後讀到的 url/title 才是點擊的結果。 */
async function settleAfterInput(driver: BrowserGuestDriver): Promise<void> {
  await driver.sleep(SETTLE_START_MS);
  if (driver.isLoading()) await driver.waitForLoadStop(SETTLE_MAX_MS);
}

async function resolveRef(driver: BrowserGuestDriver, ref: string, focus: boolean): Promise<{ x: number; y: number; focused?: boolean }> {
  return interpretResolveResult(await driver.evalIsolated(buildResolveRefScript(ref, focus)));
}

const isEditableFocused = async (driver: BrowserGuestDriver): Promise<boolean> => (await driver.evalIsolated(EDITABLE_FOCUS_SCRIPT)) === true;

async function opNavigate(driver: BrowserGuestDriver, state: GuestState, args: Record<string, unknown>): Promise<unknown> {
  const action = args.action;
  const url = args.url;
  let waiter: LoadWaiter;
  if (typeof url === "string" && url.length > 0) {
    if (!driver.isUrlAllowed(url)) throw hostError("這個網址不是 http(s),瀏覽器不會開啟");
    waiter = driver.waitForLoad(NAVIGATE_WAIT_MS);
    // loadURL 在失敗(含被新的導覽取代)時會 reject——結果以 did-fail-load 為準,這裡只避免 unhandled rejection。
    driver.loadUrl(url).catch(() => undefined);
  } else if (action === "back" || action === "forward" || action === "reload") {
    waiter = driver.waitForLoad(NAVIGATE_WAIT_MS);
    if (!driver.goHistory(action)) {
      waiter.cancel();
      throw hostError(action === "back" ? "沒有上一頁可以回去" : "沒有下一頁可以前進");
    }
  } else {
    throw hostError("navigate 要給 url 或 action(back/forward/reload)");
  }
  state.screenshot = undefined; // 導覽之後舊截圖的座標沒有意義(文件換了)
  const outcome = await waiter.promise;
  if (outcome.failure) {
    throw new BrowserExecError(
      ExecErrorCodes.NAVIGATION_FAILED,
      `頁面載入失敗:${outcome.failure.description || `錯誤碼 ${outcome.failure.code}`}(${outcome.failure.url || url || ""})`,
    );
  }
  return { url: driver.getUrl(), title: driver.getTitle(), loaded: outcome.finished === true };
}

async function opScreenshot(driver: BrowserGuestDriver, state: GuestState): Promise<unknown> {
  const viewport = await readViewport(driver);
  const captured = (await driver.cdp("Page.captureScreenshot", { format: "jpeg", quality: SCREENSHOT_JPEG_QUALITY, fromSurface: true })) as { data?: unknown };
  if (!isRecord(captured) || typeof captured.data !== "string" || captured.data.length === 0) throw hostError("截圖沒有回傳影像資料");
  let data = captured.data;
  const size = driver.jpegSize(data);
  if (!(size.width > 0 && size.height > 0)) throw hostError("截圖的影像尺寸是 0");
  let { width, height } = size;
  const fit = fitWithin(width, height, SCREENSHOT_MAX_EDGE);
  if (fit.scaled) {
    data = driver.resizeJpeg(data, fit.width, fit.height, SCREENSHOT_JPEG_QUALITY);
    width = fit.width;
    height = fit.height;
  }
  state.screenshot = { cssWidth: viewport.cssWidth, cssHeight: viewport.cssHeight, width, height };
  return { mimeType: "image/jpeg", data, width, height, url: driver.getUrl(), title: driver.getTitle() };
}

async function opReadPage(driver: BrowserGuestDriver, args: Record<string, unknown>): Promise<unknown> {
  if (args.mode === "interactive") {
    return buildInteractiveResult(await driver.evalIsolated(buildInteractiveScript(INTERACTIVE_MAX_ELEMENTS)));
  }
  const requested = typeof args.maxChars === "number" && Number.isFinite(args.maxChars) ? args.maxChars : READ_PAGE_DEFAULT_MAX_CHARS;
  const maxChars = Math.max(1, Math.min(READ_PAGE_MAX_CHARS, Math.floor(requested)));
  return buildReadTextResult(await driver.evalIsolated(buildReadTextScript(maxChars)), maxChars);
}

async function opClick(driver: BrowserGuestDriver, state: GuestState, args: Record<string, unknown>): Promise<unknown> {
  let point: { x: number; y: number };
  if (typeof args.ref === "string" && args.ref.length > 0) {
    point = await resolveRef(driver, args.ref, false);
  } else if (typeof args.x === "number" && typeof args.y === "number") {
    const record = state.screenshot;
    if (!record) {
      throw new BrowserExecError(ExecErrorCodes.NO_SCREENSHOT, "還沒有截圖可以換算座標。請先 browser_screenshot,再用那張圖上的座標點擊。");
    }
    const viewport = await readViewport(driver);
    if (isScreenshotStale(record, viewport)) {
      throw new BrowserExecError(
        ExecErrorCodes.STALE_SCREENSHOT,
        `截圖之後頁面的視窗大小變了(${record.cssWidth}×${record.cssHeight} → ${Math.round(viewport.cssWidth)}×${Math.round(viewport.cssHeight)} CSS px),座標已經不準。請重新 browser_screenshot。`,
      );
    }
    point = imageToCss(record, args.x, args.y);
  } else {
    throw hostError("click 要給 ref,或同時給 x 與 y");
  }
  await mouseClick(driver, point.x, point.y);
  await settleAfterInput(driver);
  return { url: driver.getUrl(), title: driver.getTitle() };
}

async function opType(driver: BrowserGuestDriver, args: Record<string, unknown>): Promise<unknown> {
  const text = args.text;
  if (typeof text !== "string" || text.length === 0) throw hostError("type 要給非空的 text");
  if (typeof args.ref === "string" && args.ref.length > 0) {
    const pos = await resolveRef(driver, args.ref, true);
    if (!(await isEditableFocused(driver))) {
      // 有些元件要點一下才會聚焦(自訂的輸入元件):點它的中心再檢查一次。
      await mouseClick(driver, pos.x, pos.y);
      if (!(await isEditableFocused(driver))) throw new BrowserExecError(ExecErrorCodes.ELEMENT_NOT_FOUND, "那個元素無法輸入文字(不是輸入框,點了也沒有聚焦)。");
    }
  } else if (!(await isEditableFocused(driver))) {
    throw new BrowserExecError(
      ExecErrorCodes.ELEMENT_NOT_FOUND,
      "目前沒有聚焦在可以輸入文字的元素上。請用 ref 指定輸入框,或先 browser_click 一個輸入框。",
    );
  }
  await driver.cdp("Input.insertText", { text });
  if (args.submit === true) {
    await pressKeyName(driver, "Enter");
    await settleAfterInput(driver);
  }
  return {};
}

async function opPressKey(driver: BrowserGuestDriver, args: Record<string, unknown>): Promise<unknown> {
  if (typeof args.key !== "string") throw hostError("press_key 要給 key");
  await pressKeyName(driver, args.key);
  await settleAfterInput(driver);
  return {};
}

async function opScroll(driver: BrowserGuestDriver, state: GuestState, args: Record<string, unknown>): Promise<unknown> {
  if (args.direction !== "up" && args.direction !== "down") throw hostError("scroll 的 direction 要是 up 或 down");
  const requested = typeof args.amount === "number" && Number.isFinite(args.amount) && args.amount > 0 ? args.amount : SCROLL_DEFAULT_AMOUNT;
  const amount = Math.min(SCROLL_MAX_AMOUNT, requested);
  const viewport = await readViewport(driver);
  const deltaY = (args.direction === "down" ? 1 : -1) * amount * SCROLL_PAGE_RATIO * viewport.cssHeight;
  await driver.cdp("Input.dispatchMouseEvent", { type: "mouseWheel", x: viewport.cssWidth / 2, y: viewport.cssHeight / 2, deltaX: 0, deltaY });
  await driver.sleep(150);
  state.screenshot = undefined; // 捲動之後舊截圖上的座標對不上頁面
  return {};
}

function withDeadline<T>(ms: number, promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(hostError(`瀏覽器操作超過 ${Math.round(ms / 1000)} 秒沒有完成`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** 執行一個 op,回傳 `BrowserExecOutcome`(期待中的失敗是 `ok:false`,**不丟例外**)。 */
export async function executeBrowserOp(driver: BrowserGuestDriver, state: GuestState, op: string, rawArgs: unknown): Promise<BrowserExecOutcome> {
  const args = argsRecord(rawArgs);
  try {
    let run: Promise<unknown>;
    switch (op) {
      case "navigate":
        run = withDeadline(NAVIGATE_DEADLINE_MS, opNavigate(driver, state, args));
        break;
      case "screenshot":
        run = withDeadline(COMMAND_DEADLINE_MS, opScreenshot(driver, state));
        break;
      case "readPage":
        run = withDeadline(COMMAND_DEADLINE_MS, opReadPage(driver, args));
        break;
      case "click":
        run = withDeadline(COMMAND_DEADLINE_MS, opClick(driver, state, args));
        break;
      case "type":
        run = withDeadline(COMMAND_DEADLINE_MS, opType(driver, args));
        break;
      case "pressKey":
        run = withDeadline(COMMAND_DEADLINE_MS, opPressKey(driver, args));
        break;
      case "scroll":
        run = withDeadline(COMMAND_DEADLINE_MS, opScroll(driver, state, args));
        break;
      default:
        throw hostError(`不認得的操作: ${op}`);
    }
    return { ok: true, result: await run };
  } catch (err) {
    return { ok: false, error: mapExecError(err) };
  }
}
