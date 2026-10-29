import { randomUUID } from "node:crypto";
import {
  BROWSER_COMMAND_TIMEOUT_MS,
  BROWSER_HOST_ERROR_CODES,
  BROWSER_NAVIGATE_TIMEOUT_MS,
  BROWSER_OP_RESULT_SCHEMAS,
  BROWSER_READ_PAGE_DEFAULT_MAX_CHARS,
  BROWSER_SCREENSHOT_MAX_BYTES,
  BrowserClickArgsSchema,
  BrowserErrorCodes,
  BrowserNavigateArgsSchema,
  BrowserPressKeyArgsSchema,
  BrowserReadPageArgsSchema,
  BrowserScreenshotArgsSchema,
  BrowserScrollArgsSchema,
  BrowserTypeArgsSchema,
  DeskmonyError,
  type BrowserClickArgs,
  type BrowserClickResult,
  type BrowserCommandPush,
  type BrowserCommandResultParams,
  type BrowserEmptyResult,
  type BrowserNavigateArgs,
  type BrowserNavigateResult,
  type BrowserOp,
  type BrowserOpMap,
  type BrowserPort,
  type BrowserPressKeyArgs,
  type BrowserReadPageArgs,
  type BrowserReadPageResult,
  type BrowserScreenshotResult,
  type BrowserScrollArgs,
  type BrowserTypeArgs,
} from "@deskmony/shared";
import type { z } from "zod";

/**
 * browser-relay.ts(2026-10-21,右側面板 P4a,見 docs/LAYER-4-detail-design/side-panel_detail.md §P4a.3、
 * docs/DECISIONS.md §L.2、packages/shared/src/browser.ts 的整體流程圖)。
 *
 * core 在 agent 與「桌面 app 右側面板的瀏覽器」之間的**轉送與政策層**——它自己不碰任何瀏覽器:
 *  - **host**:桌面 app 的 renderer 以 `browser.registerHost` 註冊(P4b 才實作,e2e 用假 host)。只有一個 host 有效,
 *    多個註冊時以最後一個為準(被取代的 host 還沒回的指令一律當成 `browser.hostDisconnected`)。host 連線斷開就註銷。
 *  - **指令**只送給 host 那一條連線(`BrowserHostConnection.sendCommand()`,gateway 實作成 targeted push,**不是** `broadcast()`)。
 *  - **排隊**:同一個 session 的指令依序執行(一個結果回來或逾時才送下一個),不同 session 互不阻塞。
 *    逾時從「指令送給 host 的那一刻」起算(排隊等待不吃逾時):導覽 30 秒、其他 15 秒。
 *  - **導覽規則在這裡強制執行**(不依賴 adapter 有沒有問權限——三種 adapter 對 MCP 工具發不發權限請求、帶不帶完整 input 都不一樣,
 *    codex 甚至可能完全不問;只靠 adapter 層的政策判斷會有後端依賴的破口):`browser_navigate` 帶 `url` 時,
 *    scheme 只能 http/https;主機必須是 loopback(`localhost`、`*.localhost`、`127.0.0.0/8`、`[::1]`),或在 `policy.allowedHosts`
 *    (不分大小寫完全比對 hostname,比照 hard-deny),或該 session 開著「真.無限制」。違規時 host **完全收不到**指令。
 *    送給 host 的網址是**這裡檢查過的那個 `URL.href`**(檢查與送出是同一個字串)。
 *  - host 回的結果用 `BROWSER_OP_RESULT_SCHEMAS` 驗證形狀、截圖限 5 MB、文字/元素數量限上限;錯誤碼只放行 `BROWSER_HOST_ERROR_CODES`。
 *
 * **誠實的限制**:這裡只擋 agent「明確要求」的導覽。頁面載入之後的連結、表單送出、重新導向可以走到 allowedHosts 之外
 * ——瀏覽器本質上就是能對外連線的工具,要嚴格隔離就關掉 `features.agentBrowserTools`(docs/DECISIONS.md §L.5)。
 */

/** 一條 host 連線(gateway 為每條 WS 連線建一個,`browser.registerHost` 時才登記給 relay)。 */
export interface BrowserHostConnection {
  /** 日誌用的識別。 */
  readonly id: string;
  /** 對這一條連線送 `browser-command` push;連線已不在線(或不是可以收 push 的連線)回 `false`。 */
  sendCommand(command: BrowserCommandPush): boolean;
}

export interface BrowserRelayOptions {
  /** `policy.allowedHosts`。 */
  allowedHosts: readonly string[];
  /** 這個 session 目前是否開著「真.無限制」(此時導覽不受主機限制)。 */
  isTrueUnrestricted: (sessionId: string) => boolean;
  /** 導覽指令的逾時(預設 30 秒;`DESKMONY_BROWSER_NAVIGATE_TIMEOUT_MS` 讓 e2e 縮短)。 */
  navigateTimeoutMs?: number;
  /** 其他指令的逾時(預設 15 秒;`DESKMONY_BROWSER_COMMAND_TIMEOUT_MS`)。 */
  commandTimeoutMs?: number;
}

/** 互動元素清單的上限(host 回更多就截斷並標 `truncated`)。 */
export const BROWSER_INTERACTIVE_MAX_ELEMENTS = 500;

interface PendingCommand {
  commandId: string;
  sessionId: string;
  op: BrowserOp;
  args: Record<string, unknown>;
  /** 指令建立當下的 host——之後 host 斷線/被取代,這筆就以 `hostDisconnected` 收場。 */
  host: BrowserHostConnection;
  state: "queued" | "sent";
  settled: boolean;
  timer?: ReturnType<typeof setTimeout>;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  /** 輪到它執行的 promise 在這個結果出來(或逾時、斷線)時 resolve,讓同一個 session 的下一筆開始。 */
  onSettled?: () => void;
}

/** WHATWG 解析後的 hostname 是不是 loopback:`localhost`、`*.localhost`、`127.0.0.0/8`、`[::1]`。 */
export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  // IPv6:URL 解析器把 `[0:0:0:0:0:0:0:1]` 等寫法都正規化成 `[::1]`。IPv4-mapped(`[::ffff:7f00:1]`)刻意不算 loopback——
  // 寧可要求使用者把它加進 allowedHosts,也不替它放行(不確定時選較嚴的那一邊)。
  if (host === "[::1]") return true;
  // IPv4:URL 解析器把 `127.1`、`0x7f.1`、`2130706433` 都正規化成點分十進位。
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return false;
  const octets = match.slice(1).map(Number);
  return octets.every((n) => n <= 255) && octets[0] === 127;
}

function invalidArgs(detail: string): DeskmonyError {
  return new DeskmonyError(BrowserErrorCodes.INVALID_ARGS, { detail }, `瀏覽器工具的參數不正確:${detail}`);
}

function parseArgs<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, args: unknown): T {
  const parsed = schema.safeParse(args);
  if (!parsed.success) throw invalidArgs(parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "));
  return parsed.data;
}

export class BrowserRelay {
  private host: BrowserHostConnection | undefined;
  private readonly pending = new Map<string, PendingCommand>();
  /** 每個 session 一條佇列(尾端 promise)。 */
  private readonly queues = new Map<string, Promise<void>>();
  private readonly navigateTimeoutMs: number;
  private readonly commandTimeoutMs: number;

  constructor(private readonly options: BrowserRelayOptions) {
    this.navigateTimeoutMs = options.navigateTimeoutMs ?? BROWSER_NAVIGATE_TIMEOUT_MS;
    this.commandTimeoutMs = options.commandTimeoutMs ?? BROWSER_COMMAND_TIMEOUT_MS;
  }

  // ---- host 註冊 -------------------------------------------------------------

  /** 登記 host。已有別的 host 時以這個為準,舊 host 還沒回的指令一律以 `browser.hostDisconnected` 收場。 */
  registerHost(host: BrowserHostConnection): void {
    if (this.host === host) return;
    const previous = this.host;
    this.host = host;
    if (previous) {
      console.warn(`[browser-relay] host ${host.id} 取代了 host ${previous.id}`);
      this.failAllOf(previous, "replaced");
    }
  }

  /** host 連線斷開(或主動註銷):沒有 host 了,它還沒回的指令全部 `browser.hostDisconnected`。不是目前 host 的連線呼叫是 no-op。 */
  unregisterHost(host: BrowserHostConnection): void {
    if (this.host !== host) return;
    this.host = undefined;
    this.failAllOf(host, "disconnected");
  }

  hasHost(): boolean {
    return this.host !== undefined;
  }

  // ---- host 回報結果 ---------------------------------------------------------

  /**
   * 處理 `browser.commandResult`。**必須來自目前的 host 連線、commandId 必須是還在等的指令**,否則忽略並記 warning,
   * 回 `false`——這條路徑是任何連線都碰得到的 RPC,不能讓非 host(或舊 host、或逾時之後才到的結果)影響任何一筆指令。
   * @param from 送出這個 RPC 的連線所對應的 host 物件;不是 host 的連線傳 `undefined`。
   */
  handleCommandResult(from: BrowserHostConnection | undefined, params: BrowserCommandResultParams): boolean {
    const entry = this.pending.get(params.commandId);
    if (!from || from !== this.host) {
      console.warn(`[browser-relay][security] 忽略來自非 host 連線的 browser.commandResult(commandId=${params.commandId})`);
      return false;
    }
    if (!entry || entry.host !== from || entry.state !== "sent") {
      console.warn(`[browser-relay] 忽略未知或已結束的 commandId ${params.commandId}(逾時之後才到的結果,或偽造的 id)`);
      return false;
    }

    if (!params.ok) {
      const hostError = params.error;
      const code = hostError && BROWSER_HOST_ERROR_CODES.includes(hostError.code) ? hostError.code : BrowserErrorCodes.HOST_ERROR;
      const detail = hostError?.message ?? "(host 沒有提供說明)";
      this.settle(entry, { error: new DeskmonyError(code, { detail }, detail) });
      return true;
    }

    const schema = BROWSER_OP_RESULT_SCHEMAS[entry.op] as z.ZodTypeAny;
    const parsed = schema.safeParse(params.result);
    if (!parsed.success) {
      const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
      console.warn(`[browser-relay] host 回傳的 ${entry.op} 結果形狀不對: ${detail}`);
      this.settle(entry, {
        error: new DeskmonyError(BrowserErrorCodes.INVALID_RESULT, { op: entry.op, detail }, `瀏覽器回傳的結果格式不正確(${entry.op}):${detail}`),
      });
      return true;
    }

    let value = parsed.data as Record<string, unknown>;
    if (entry.op === "screenshot") {
      // base64 字元數換算成位元組(3/4)——不解碼,只算大小。
      const bytes = Math.floor(((value.data as string).length * 3) / 4);
      if (bytes > BROWSER_SCREENSHOT_MAX_BYTES) {
        this.settle(entry, {
          error: new DeskmonyError(
            BrowserErrorCodes.RESULT_TOO_LARGE,
            { bytes, maxBytes: BROWSER_SCREENSHOT_MAX_BYTES },
            `瀏覽器回傳的截圖太大(${bytes} 位元組,上限 ${BROWSER_SCREENSHOT_MAX_BYTES})`,
          ),
        });
        return true;
      }
    } else if (entry.op === "readPage") {
      value = this.clampReadPage(value as unknown as BrowserReadPageResult, entry.args as BrowserReadPageArgs) as unknown as Record<string, unknown>;
    }
    this.settle(entry, { value });
    return true;
  }

  /** host 理應已經照 `maxChars`/元素上限截斷;這裡再保險一次(不信任 host 回多少就吞多少)。 */
  private clampReadPage(result: BrowserReadPageResult, args: BrowserReadPageArgs): BrowserReadPageResult {
    if (result.mode === "text") {
      const max = args.maxChars ?? BROWSER_READ_PAGE_DEFAULT_MAX_CHARS;
      if (result.text.length <= max) return result;
      return { ...result, text: result.text.slice(0, max), truncated: true };
    }
    if (result.elements.length <= BROWSER_INTERACTIVE_MAX_ELEMENTS) return result;
    return { ...result, elements: result.elements.slice(0, BROWSER_INTERACTIVE_MAX_ELEMENTS), truncated: true };
  }

  // ---- 七個操作(gateway 與 in-process port 共用)-------------------------------

  async navigate(sessionId: string, rawArgs: unknown): Promise<BrowserNavigateResult> {
    const args = parseArgs(BrowserNavigateArgsSchema, rawArgs);
    const hasUrl = args.url !== undefined;
    const hasAction = args.action !== undefined;
    if (hasUrl === hasAction) throw invalidArgs("browser_navigate 要給 url 或 action 其中之一(不能兩者都給,也不能都不給)");
    if (args.url !== undefined) {
      // 送給 host 的是這裡檢查過的 href(同一個字串),不是 agent 原本傳的。
      const href = this.checkNavigationTarget(sessionId, args.url);
      return (await this.execute(sessionId, "navigate", { url: href })) as BrowserNavigateResult;
    }
    return (await this.execute(sessionId, "navigate", { action: args.action })) as BrowserNavigateResult;
  }

  async screenshot(sessionId: string, rawArgs: unknown = {}): Promise<BrowserScreenshotResult> {
    parseArgs(BrowserScreenshotArgsSchema, rawArgs);
    return (await this.execute(sessionId, "screenshot", {})) as BrowserScreenshotResult;
  }

  async readPage(sessionId: string, rawArgs: unknown = {}): Promise<BrowserReadPageResult> {
    const args = parseArgs(BrowserReadPageArgsSchema, rawArgs);
    return (await this.execute(sessionId, "readPage", { ...args })) as BrowserReadPageResult;
  }

  async click(sessionId: string, rawArgs: unknown): Promise<BrowserClickResult> {
    const args = parseArgs(BrowserClickArgsSchema, rawArgs);
    const hasRef = args.ref !== undefined;
    const hasX = args.x !== undefined;
    const hasY = args.y !== undefined;
    if (hasRef && (hasX || hasY)) throw invalidArgs("browser_click 要給 ref 或 x+y 其中之一(不能兩者都給)");
    if (!hasRef && !(hasX && hasY)) throw invalidArgs("browser_click 要給 ref,或同時給 x 與 y(最近一次截圖的像素座標)");
    return (await this.execute(sessionId, "click", { ...args })) as BrowserClickResult;
  }

  async type(sessionId: string, rawArgs: unknown): Promise<BrowserEmptyResult> {
    const args = parseArgs(BrowserTypeArgsSchema, rawArgs);
    return (await this.execute(sessionId, "type", { ...args })) as BrowserEmptyResult;
  }

  async pressKey(sessionId: string, rawArgs: unknown): Promise<BrowserEmptyResult> {
    const args = parseArgs(BrowserPressKeyArgsSchema, rawArgs);
    return (await this.execute(sessionId, "pressKey", { ...args })) as BrowserEmptyResult;
  }

  async scroll(sessionId: string, rawArgs: unknown): Promise<BrowserEmptyResult> {
    const args = parseArgs(BrowserScrollArgsSchema, rawArgs);
    return (await this.execute(sessionId, "scroll", { ...args })) as BrowserEmptyResult;
  }

  /** 給 in-process 路徑(Claude SDK 的 MCP 工具)用的 `BrowserPort`——與 gateway 的七個方法走同一套驗證、規則與逾時。 */
  toPort(): BrowserPort {
    const strip = <T extends { callerSessionId: string }>(input: T): Omit<T, "callerSessionId"> => {
      const { callerSessionId: _caller, ...rest } = input;
      return rest;
    };
    return {
      navigate: (input) => this.navigate(input.callerSessionId, strip(input)),
      screenshot: (input) => this.screenshot(input.callerSessionId),
      readPage: (input) => this.readPage(input.callerSessionId, strip(input)),
      click: (input) => this.click(input.callerSessionId, strip(input)),
      type: (input) => this.type(input.callerSessionId, strip(input)),
      pressKey: (input) => this.pressKey(input.callerSessionId, strip(input)),
      scroll: (input) => this.scroll(input.callerSessionId, strip(input)),
    };
  }

  // ---- 導覽規則 --------------------------------------------------------------

  /** 檢查導覽目標;通過回傳要送給 host 的 `URL.href`,違規丟 `DeskmonyError`(並 `console.warn`,含 session、原因)。 */
  private checkNavigationTarget(sessionId: string, rawUrl: string): string {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      console.warn(`[browser-relay][security] 拒絕導覽(session=${sessionId}):不是合法網址 "${rawUrl.slice(0, 200)}"`);
      throw invalidArgs(`url 必須是完整的網址(以 http:// 或 https:// 開頭):"${rawUrl.slice(0, 200)}"`);
    }
    const scheme = parsed.protocol.replace(/:$/, "");
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      console.warn(`[browser-relay][security] 拒絕導覽(session=${sessionId}):不支援的 scheme "${scheme}"`);
      throw new DeskmonyError(
        BrowserErrorCodes.UNSUPPORTED_SCHEME,
        { scheme },
        `瀏覽器工具只能開啟 http:// 或 https:// 網址,不支援 "${scheme}:"`,
      );
    }
    const hostname = parsed.hostname.toLowerCase();
    if (isLoopbackHostname(hostname)) return parsed.href;
    if (this.options.allowedHosts.some((allowed) => allowed.toLowerCase() === hostname)) return parsed.href;
    if (this.options.isTrueUnrestricted(sessionId)) return parsed.href;
    console.warn(`[browser-relay][security] 拒絕導覽(session=${sessionId}):主機 "${hostname}" 不是 loopback、不在 policy.allowedHosts,session 也沒開真.無限制`);
    throw new DeskmonyError(
      BrowserErrorCodes.HOST_NOT_ALLOWED,
      { host: hostname },
      `瀏覽器工具只能導覽到本機(localhost、127.0.0.1、[::1])或 policy.allowedHosts 內的網站;"${hostname}" 不在其中。` +
        `請告訴使用者:若要放行,請把 "${hostname}" 加進 ~/.deskmony/config.json 的 policy.allowedHosts,然後重新啟動 Deskmony。`,
    );
  }

  // ---- 指令佇列 --------------------------------------------------------------

  private execute<K extends BrowserOp>(sessionId: string, op: K, args: BrowserOpMap[K]["args"] | Record<string, unknown>): Promise<unknown> {
    const host = this.host;
    if (!host) {
      return Promise.reject(
        new DeskmonyError(
          BrowserErrorCodes.NO_HOST,
          undefined,
          "目前沒有開著的 Deskmony 桌面 app,瀏覽器工具需要桌面 app 的右側面板才能使用。請告訴使用者:請開啟 Deskmony 桌面 app 後再試。",
        ),
      );
    }
    return new Promise<unknown>((resolve, reject) => {
      const entry: PendingCommand = {
        commandId: randomUUID(),
        sessionId,
        op,
        args: args as Record<string, unknown>,
        host,
        state: "queued",
        settled: false,
        resolve,
        reject,
      };
      this.pending.set(entry.commandId, entry);
      // 同一個 session 依序:接在它目前佇列的尾端;不同 session 各有各的佇列,互不阻塞。
      const tail = this.queues.get(sessionId) ?? Promise.resolve();
      const next = tail.then(() => this.dispatchToHost(entry)).catch(() => undefined); // dispatchToHost 自己不會丟;保險,佇列鏈永遠不能 reject
      this.queues.set(sessionId, next);
      void next.then(() => {
        if (this.queues.get(sessionId) === next) this.queues.delete(sessionId);
      });
    });
  }

  /** 輪到這筆指令:把它送給 host 並等它收場(結果/逾時/斷線);回傳的 promise 在那之後才 resolve。 */
  private dispatchToHost(entry: PendingCommand): Promise<void> {
    if (entry.settled) return Promise.resolve(); // 排隊期間 host 已斷線/被取代,早就以 hostDisconnected 收場了
    return new Promise<void>((done) => {
      entry.onSettled = done;
      entry.state = "sent";
      const timeoutMs = entry.op === "navigate" ? this.navigateTimeoutMs : this.commandTimeoutMs;
      entry.timer = setTimeout(() => {
        console.warn(`[browser-relay] 指令逾時(session=${entry.sessionId}, op=${entry.op}, ${timeoutMs}ms)`);
        this.settle(entry, {
          error: new DeskmonyError(
            BrowserErrorCodes.TIMEOUT,
            { op: entry.op, timeoutMs },
            `瀏覽器在 ${Math.round(timeoutMs / 1000)} 秒內沒有回應(${entry.op})。可能頁面卡住、或桌面 app 沒有回應;可以稍後再試。`,
          ),
        });
      }, timeoutMs);
      // socket.send 在連線剛好關閉的邊緣可能丟例外——當成沒送出去,不能讓例外逃出這個 promise(它在佇列鏈上,逃出去 = 這個 session 的佇列壞掉)。
      let sent = false;
      try {
        sent = entry.host.sendCommand({
          commandId: entry.commandId,
          sessionId: entry.sessionId,
          op: entry.op,
          args: entry.args,
        });
      } catch (err) {
        console.warn(`[browser-relay] 對 host ${entry.host.id} 送指令時丟出例外:${err instanceof Error ? err.message : String(err)}`);
      }
      if (!sent) this.settle(entry, { error: this.hostDisconnected("send-failed") });
    });
  }

  private hostDisconnected(reason: string): DeskmonyError {
    return new DeskmonyError(
      BrowserErrorCodes.HOST_DISCONNECTED,
      { reason },
      "瀏覽器所在的 Deskmony 桌面 app 在指令執行途中斷線了(可能被關掉或重新整理)。請告訴使用者確認桌面 app 還開著,然後再試一次。",
    );
  }

  /** 把某個 host 的所有未完成指令(含還在排隊的)以 `browser.hostDisconnected` 收場。 */
  private failAllOf(host: BrowserHostConnection, reason: string): void {
    for (const entry of [...this.pending.values()]) {
      if (entry.host === host) this.settle(entry, { error: this.hostDisconnected(reason) });
    }
  }

  /** 唯一的收場出口:每筆指令只會收場一次,並放行同一個 session 的下一筆。 */
  private settle(entry: PendingCommand, outcome: { value: unknown } | { error: Error }): void {
    if (entry.settled) return;
    entry.settled = true;
    if (entry.timer) clearTimeout(entry.timer);
    this.pending.delete(entry.commandId);
    if ("error" in outcome) entry.reject(outcome.error);
    else entry.resolve(outcome.value);
    entry.onSettled?.();
  }
}
