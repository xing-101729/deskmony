import { z } from "zod";

/**
 * browser.ts(2026-10-21,右側面板 P4a「agent 瀏覽器工具」,見 docs/LAYER-4-detail-design/side-panel_detail.md §P4a、
 * docs/DECISIONS.md §L.2)。
 *
 * agent 透過 session 網路的 MCP server(`deskmony`)操作**使用者桌面 app 右側面板裡**的瀏覽器:七個工具
 * `browser_navigate` / `browser_screenshot` / `browser_read_page` / `browser_click` / `browser_type` /
 * `browser_press_key` / `browser_scroll`。core 只做**轉送與政策**,不碰任何瀏覽器:
 *
 *   agent ──MCP──▶ gateway `browser.<op>ForAgent`(scoped token,呼叫者 session 由 token 決定)
 *                 ──▶ `BrowserRelay`(apps/core/src/browser/browser-relay.ts:導覽規則、逾時、排隊)
 *                 ──push `browser-command`(只送給 host 那一條連線)──▶ **host**(桌面 app 的 renderer,P4b 才實作)
 *                 ◀──`browser.commandResult`──
 *
 * 這個檔案定義 wire 上所有東西的形狀:工具參數、host 收到的指令、host 回的結果與錯誤碼,以及 in-process 路徑
 * (Claude SDK)用的 `BrowserPort`。**P4b 的 host 執行器要實作的就是這裡的 `BrowserOpMap`**。
 *
 * 這個檔案不 import `node:*`(與 errors.ts 同,會被 apps/desktop 的瀏覽器 bundle 引入)。
 */

// ---- 常數 -------------------------------------------------------------------

/** `browser_navigate` 的網址長度上限(與桌面端 `browser-rules.ts` 的 `BROWSER_URL_MAX_LENGTH` 一致)。 */
export const BROWSER_URL_MAX_LENGTH = 8192;
/** `browser_read_page` 的 `maxChars`:預設與上限。 */
export const BROWSER_READ_PAGE_DEFAULT_MAX_CHARS = 20_000;
export const BROWSER_READ_PAGE_MAX_CHARS = 100_000;
/** `browser_type` 單次輸入的字元上限(擋掉失控地把整份文件灌進輸入框)。 */
export const BROWSER_TYPE_MAX_CHARS = 10_000;
/** `browser_scroll` 的 `amount`:單位是「視窗高度的約 80%」,預設 1、上限 20。 */
export const BROWSER_SCROLL_DEFAULT_AMOUNT = 1;
export const BROWSER_SCROLL_MAX_AMOUNT = 20;
/** 截圖長邊的上限(像素):`browser_click` 的 x/y 是這張縮過的圖的座標。 */
export const BROWSER_SCREENSHOT_MAX_EDGE = 1568;
/** host 回傳的截圖(base64 字元數換算成位元組)上限;超過 core 回 `browser.resultTooLarge`。 */
export const BROWSER_SCREENSHOT_MAX_BYTES = 5 * 1024 * 1024;
/** 單一指令的逾時:導覽 30 秒、其餘 15 秒(core 端計時,從指令送給 host 的那一刻起算)。 */
export const BROWSER_NAVIGATE_TIMEOUT_MS = 30_000;
export const BROWSER_COMMAND_TIMEOUT_MS = 15_000;

/** `browser_press_key` 允許的按鍵(列舉,沒有組合鍵、沒有任意字元——要輸入文字用 `browser_type`)。 */
export const BROWSER_KEYS = [
  "Enter",
  "Tab",
  "Escape",
  "Backspace",
  "Delete",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  "Space",
] as const;
export const BrowserKeySchema = z.enum(BROWSER_KEYS);
export type BrowserKey = z.infer<typeof BrowserKeySchema>;

// ---- 錯誤碼 -----------------------------------------------------------------

/**
 * 瀏覽器工具的錯誤碼(`DeskmonyError.code`,桌面端翻譯在 `errors-browser.json`)。
 *
 * 前半是 **core** 產生的;後半(`STALE_*` 起)是 **host**(P4b 執行器)在 `browser.commandResult` 的 `error.code` 回報、
 * core 原樣轉給 agent 的。host 回了不認得的 code 一律轉成 `HOST_ERROR`(見 `BROWSER_HOST_ERROR_CODES`)。
 *
 * 注意 `HOST_NOT_ALLOWED` 的「host」是**網站主機名稱**(導覽目標不在 loopback/`policy.allowedHosts`),
 * 與 `NO_HOST`/`REGISTER_NOT_ALLOWED` 的「host」(桌面 app 這個瀏覽器宿主)不是同一件事。
 */
export const BrowserErrorCodes = {
  /** 沒有任何桌面 app 註冊成 host——要請使用者開著 Deskmony 桌面 app。params: 無 */
  NO_HOST: "browser.noHost",
  /** 指令送出後 host 斷線(或被另一個視窗取代)。params: {reason} */
  HOST_DISCONNECTED: "browser.hostDisconnected",
  /** host 在時限內沒回。params: {op, timeoutMs} */
  TIMEOUT: "browser.timeout",
  /** 導覽目標的網站主機不在 loopback、`policy.allowedHosts`,且該 session 沒開「真.無限制」。params: {host} */
  HOST_NOT_ALLOWED: "browser.hostNotAllowed",
  /** 導覽目標不是 http/https。params: {scheme} */
  UNSUPPORTED_SCHEME: "browser.unsupportedScheme",
  /** 工具參數不合法(例如 navigate 同時給 url 與 action、click 沒給 ref 也沒給座標)。params: {detail} */
  INVALID_ARGS: "browser.invalidArgs",
  /** `browser.registerHost` 被非本機或 scoped 連線呼叫。 */
  REGISTER_NOT_ALLOWED: "browser.registerNotAllowed",
  /** host 回的截圖超過 `BROWSER_SCREENSHOT_MAX_BYTES`。params: {bytes, maxBytes} */
  RESULT_TOO_LARGE: "browser.resultTooLarge",
  /** host 回的結果形狀不對(不符合這個檔案的結果 schema)。params: {op, detail} */
  INVALID_RESULT: "browser.invalidResult",
  // ---- 以下由 host 回報 ----
  /** `ref` 已過期(導覽之後失效)——要重新 `browser_read_page`(interactive)。 */
  STALE_REF: "browser.staleRef",
  /** 截圖之後頁面 viewport 尺寸變了(使用者開關面板),座標會失準——要重新 `browser_screenshot`。 */
  STALE_SCREENSHOT: "browser.staleScreenshot",
  /** 用座標點擊,但還沒有截圖可換算座標——要先 `browser_screenshot`。 */
  NO_SCREENSHOT: "browser.noScreenshot",
  /** `ref` 對應的元素已不存在,或沒有可點擊的位置。 */
  ELEMENT_NOT_FOUND: "browser.elementNotFound",
  /** 載入失敗(DNS、連線被拒、憑證錯誤……)。params: {url, detail} */
  NAVIGATION_FAILED: "browser.navigationFailed",
  /** host 回報了不屬於上面任何一種的失敗。params: {detail} */
  HOST_ERROR: "browser.hostError",
} as const;

/** host 可以回報的錯誤碼;其餘一律當成 `HOST_ERROR`。 */
export const BROWSER_HOST_ERROR_CODES: readonly string[] = [
  BrowserErrorCodes.STALE_REF,
  BrowserErrorCodes.STALE_SCREENSHOT,
  BrowserErrorCodes.NO_SCREENSHOT,
  BrowserErrorCodes.ELEMENT_NOT_FOUND,
  BrowserErrorCodes.NAVIGATION_FAILED,
  BrowserErrorCodes.HOST_ERROR,
];

// ---- 工具參數(= gateway 方法參數 = host 指令的 args)-------------------------

/** `browser_navigate`:`url` 或 `action` 二擇一(語意檢查在 `BrowserRelay`,錯了回 `browser.invalidArgs`)。 */
export const BrowserNavigateArgsSchema = z.object({
  url: z.string().min(1).max(BROWSER_URL_MAX_LENGTH).optional(),
  action: z.enum(["back", "forward", "reload"]).optional(),
});
export type BrowserNavigateArgs = z.infer<typeof BrowserNavigateArgsSchema>;

export const BrowserScreenshotArgsSchema = z.object({});
export type BrowserScreenshotArgs = z.infer<typeof BrowserScreenshotArgsSchema>;

export const BrowserReadPageArgsSchema = z.object({
  mode: z.enum(["text", "interactive"]).optional(),
  maxChars: z.number().int().positive().max(BROWSER_READ_PAGE_MAX_CHARS).optional(),
});
export type BrowserReadPageArgs = z.infer<typeof BrowserReadPageArgsSchema>;

/** `browser_click`:`ref`(來自 `browser_read_page` interactive)或 `x`+`y`(最近一次截圖的像素座標)二擇一。 */
export const BrowserClickArgsSchema = z.object({
  ref: z.string().min(1).max(200).optional(),
  x: z.number().int().min(0).max(100_000).optional(),
  y: z.number().int().min(0).max(100_000).optional(),
});
export type BrowserClickArgs = z.infer<typeof BrowserClickArgsSchema>;

export const BrowserTypeArgsSchema = z.object({
  text: z.string().min(1).max(BROWSER_TYPE_MAX_CHARS),
  ref: z.string().min(1).max(200).optional(),
  submit: z.boolean().optional(),
});
export type BrowserTypeArgs = z.infer<typeof BrowserTypeArgsSchema>;

export const BrowserPressKeyArgsSchema = z.object({ key: BrowserKeySchema });
export type BrowserPressKeyArgs = z.infer<typeof BrowserPressKeyArgsSchema>;

export const BrowserScrollArgsSchema = z.object({
  direction: z.enum(["up", "down"]),
  amount: z.number().positive().max(BROWSER_SCROLL_MAX_AMOUNT).optional(),
});
export type BrowserScrollArgs = z.infer<typeof BrowserScrollArgsSchema>;

// ---- 結果(host 回傳 → core 驗證 → 原樣給 agent)-------------------------------

/** `loaded: false` = 在時限內沒載完(頁面可能仍在載入,內容可能不完整)。 */
export const BrowserNavigateResultSchema = z.object({
  url: z.string(),
  title: z.string(),
  loaded: z.boolean(),
});
export type BrowserNavigateResult = z.infer<typeof BrowserNavigateResultSchema>;

/**
 * 截圖:JPEG、長邊 ≤ `BROWSER_SCREENSHOT_MAX_EDGE`。`width`/`height` 是**這張圖**的像素尺寸——`browser_click` 的
 * x/y 就是這個座標系(執行端依縮放比例換算回頁面 CSS px)。`url`/`title` 是截圖當下的頁面。
 */
export const BrowserScreenshotResultSchema = z.object({
  mimeType: z.literal("image/jpeg"),
  /** base64(不含 `data:` 前綴)。 */
  data: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  url: z.string(),
  title: z.string(),
});
export type BrowserScreenshotResult = z.infer<typeof BrowserScreenshotResultSchema>;

export const BrowserInteractiveElementSchema = z.object({
  /** 在下一次導覽前有效;`browser_click`/`browser_type` 的 `ref` 就填這個。 */
  ref: z.string().min(1),
  role: z.string(),
  name: z.string(),
  href: z.string().optional(),
});
export type BrowserInteractiveElement = z.infer<typeof BrowserInteractiveElementSchema>;

export const BrowserReadPageResultSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("text"),
    url: z.string(),
    title: z.string(),
    text: z.string(),
    /** 被 `maxChars` 截斷了。 */
    truncated: z.boolean(),
  }),
  z.object({
    mode: z.literal("interactive"),
    url: z.string(),
    title: z.string(),
    elements: z.array(BrowserInteractiveElementSchema),
    /** 元素太多,只列出前面一部分。 */
    truncated: z.boolean(),
  }),
]);
export type BrowserReadPageResult = z.infer<typeof BrowserReadPageResultSchema>;

/** 點擊之後的頁面(點連結可能已經導覽走了)。 */
export const BrowserClickResultSchema = z.object({ url: z.string(), title: z.string() });
export type BrowserClickResult = z.infer<typeof BrowserClickResultSchema>;

/** `type`/`press_key`/`scroll` 沒有有意義的回傳值,host 回 `{}` 即可。 */
export const BrowserEmptyResultSchema = z.object({});
export type BrowserEmptyResult = z.infer<typeof BrowserEmptyResultSchema>;

// ---- host 指令 / 結果 -------------------------------------------------------

export const BROWSER_OPS = ["navigate", "screenshot", "readPage", "click", "type", "pressKey", "scroll"] as const;
export const BrowserOpSchema = z.enum(BROWSER_OPS);
export type BrowserOp = z.infer<typeof BrowserOpSchema>;

/** 每個 op 的 args 與 result 型別——**P4b 的 host 執行器對每個 op 要實作的契約**。 */
export interface BrowserOpMap {
  navigate: { args: BrowserNavigateArgs; result: BrowserNavigateResult };
  screenshot: { args: BrowserScreenshotArgs; result: BrowserScreenshotResult };
  readPage: { args: BrowserReadPageArgs; result: BrowserReadPageResult };
  click: { args: BrowserClickArgs; result: BrowserClickResult };
  type: { args: BrowserTypeArgs; result: BrowserEmptyResult };
  pressKey: { args: BrowserPressKeyArgs; result: BrowserEmptyResult };
  scroll: { args: BrowserScrollArgs; result: BrowserEmptyResult };
}

/** core 驗證 host 回傳結果用:每個 op 一個 schema。 */
export const BROWSER_OP_RESULT_SCHEMAS = {
  navigate: BrowserNavigateResultSchema,
  screenshot: BrowserScreenshotResultSchema,
  readPage: BrowserReadPageResultSchema,
  click: BrowserClickResultSchema,
  type: BrowserEmptyResultSchema,
  pressKey: BrowserEmptyResultSchema,
  scroll: BrowserEmptyResultSchema,
} as const;

/**
 * `browser-command` push 的 payload——**只送給 host 那一條連線**(`WsGateway` 的 targeted push,不走 `broadcast()`)。
 * `sessionId` 是要操作哪個 session 的瀏覽器(host 依它找 webview);`args` 的形狀依 `op`(見 `BrowserOpMap`),
 * core 送出前已經用上面的 args schema 驗證過。
 */
export const BrowserCommandPushSchema = z.object({
  commandId: z.string(),
  sessionId: z.string(),
  op: BrowserOpSchema,
  args: z.record(z.unknown()),
});
export type BrowserCommandPush = z.infer<typeof BrowserCommandPushSchema>;

/** host 回報的錯誤:`code` 見 `BROWSER_HOST_ERROR_CODES`(不認得的當成 `browser.hostError`),`message` 是給 agent 看的說明。 */
export const BrowserHostErrorSchema = z.object({
  code: z.string().max(100),
  message: z.string().max(2000),
});
export type BrowserHostError = z.infer<typeof BrowserHostErrorSchema>;

/** `browser.commandResult` 的參數:`ok: true` 帶 `result`(形狀依指令的 op),`ok: false` 帶 `error`。 */
export const BrowserCommandResultParamsSchema = z.object({
  commandId: z.string().min(1),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: BrowserHostErrorSchema.optional(),
});
export type BrowserCommandResultParams = z.infer<typeof BrowserCommandResultParamsSchema>;

// ---- BrowserPort(in-process 路徑)-------------------------------------------

/**
 * Claude SDK 的 in-process MCP 工具用(比照 `SessionNetworkPort`:介面在這裡、實例由 `apps/core/src/index.ts` 注入,
 * `packages/adapters` 不 import `apps/*`)。`callerSessionId` 由 adapter 以自己的 handle.id 閉包捕捉——工具參數裡沒有任何 session 欄位,
 * agent 只能操作**自己 session** 的瀏覽器。實作就是 core 的 `BrowserRelay`,導覽規則與逾時與 gateway 路徑完全相同。
 */
export interface BrowserPort {
  navigate(input: { callerSessionId: string } & BrowserNavigateArgs): Promise<BrowserNavigateResult>;
  screenshot(input: { callerSessionId: string }): Promise<BrowserScreenshotResult>;
  readPage(input: { callerSessionId: string } & BrowserReadPageArgs): Promise<BrowserReadPageResult>;
  click(input: { callerSessionId: string } & BrowserClickArgs): Promise<BrowserClickResult>;
  type(input: { callerSessionId: string } & BrowserTypeArgs): Promise<BrowserEmptyResult>;
  pressKey(input: { callerSessionId: string } & BrowserPressKeyArgs): Promise<BrowserEmptyResult>;
  scroll(input: { callerSessionId: string } & BrowserScrollArgs): Promise<BrowserEmptyResult>;
}
