import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server as NodeHttpServer, type ServerResponse } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import {
  ClientRequestSchema,
  type ChildResultPush,
  type ClientRequest,
  type ClientRequestMethod,
  type EffectiveCoreConfig,
  type EnforcementNotificationPush,
  type GatewayCapabilities,
  type PermissionResolvedPush,
  type ServerResponse as GatewayServerResponse,
  type ServerPush,
  type Session,
  type SessionEventEnvelope,
  type Task,
  type TeamMessage,
} from "@deskmony/shared";
import { applyConfigFilePatch } from "../config/config-file-writer.js";
import type { SessionManager } from "../session/session-manager.js";
import type { ProfileStore } from "../profiles.js";
import type { TeamManager } from "../team/team-manager.js";
import type { MessageBus } from "../bus/message-bus.js";
import type { TaskService } from "../tasks/task-service.js";
import type { WorkspaceManager } from "../workspace/workspace-manager.js";
import type { CostGovernor } from "../cost/cost-governor.js";
import type { RecoveryService } from "../recovery/recovery-service.js";
import { detectAllAgents } from "../detect/agent-detector.js";
import {
  getEnabledClaudeModelIds,
  getProviderPrefsMap,
  maskProviderPrefsMap,
  patchProviderPrefs,
  setEnabledClaudeModelIds,
  type SettingsStore,
} from "../settings/settings-store.js";

/**
 * S11(Notification)新增:`WsGateway` 需要的 `Notifier` 最小介面——只需要能
 * 訂閱 `"enforcement-notification"` 事件,不需要知道批次/webhook 邏輯(那些
 * 全在 `apps/core/src/enforcement/notifier.ts` 的 `RealNotifier` 裡)。見下方
 * 建構子的 `notifier` 參數註解。
 */
export interface NotificationEventSource {
  on(event: "enforcement-notification", listener: (payload: EnforcementNotificationPush) => void): void;
}

/** 單一 WS 連線的認證狀態(M5 Round A)。見下方 handleConnection()/handleMessage()。 */
interface ConnectionState {
  /** 未設定 DESKMONY_AUTH_TOKEN 時,連線一律視為已認證(向下相容)。 */
  authenticated: boolean;
  /** 逾時仍未通過認證就關閉連線的計時器;認證成功後清除。 */
  authTimer: ReturnType<typeof setTimeout> | undefined;
  /** 連線來源 IP(M5 Round B 任務3:認證失敗 rate limiting 用,見 AuthRateLimiter)。 */
  remoteAddress: string;
  /** S7(auto-mode-and-yolo)L4 §5.2:是否為本機連線(loopback)——由這個連線
   *  建立當下的 `remoteAddress` 正規化後判定,終生不變(同一條 TCP 連線的
   *  來源位址不會中途改變)。決定 `LOCAL_ONLY_METHODS` 的存取與握手
   *  capabilities,見 `isLoopbackAddress()`/`LOCAL_ONLY_METHODS`。 */
  isLocal: boolean;
}

/** 未認證連線的逾時秒數(M5 Round A 任務2:逾時未認證即關閉連線)。 */
const AUTH_TIMEOUT_MS = 5_000;

/** 認證失敗 rate limiting 的預設門檻/冷卻期(M5 Round B 任務3),可由
 * apps/core/src/index.ts 讀取 DESKMONY_AUTH_RATE_LIMIT_MAX /
 * DESKMONY_AUTH_RATE_LIMIT_COOLDOWN_MS 覆寫(比照 DESKMONY_PERMISSION_TIMEOUT_MS
 * 的既有慣例,方便 e2e 測試縮短冷卻期)。 */
const DEFAULT_AUTH_FAILURE_LIMIT = 5;
const DEFAULT_AUTH_FAILURE_COOLDOWN_MS = 30_000;

function normalizeRemoteAddress(address: string | undefined | null): string {
  if (!address) return "unknown";
  // IPv4-mapped IPv6 表示法(例如 "::ffff:127.0.0.1")在雙棧環境下常見,正規化
  // 成純 IPv4 字串,避免同一台機器被計成兩個不同的來源。
  return address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
}

/**
 * S7(auto-mode-and-yolo)L4 §5.2:`isLocal` 判定——**唯一來源是連線本身**
 * (`request.socket.remoteAddress` 正規化後比對 loopback),絕不採信 client
 * 自稱。隧道連線(Tailscale/WireGuard 等)的來源位址不是 loopback,一律視為
 * 遠端——這是刻意的:隧道只解決傳輸安全,不代表操作者在本機(F1/F3)。
 */
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1"]);
function isLoopbackAddress(normalizedAddress: string): boolean {
  return LOOPBACK_ADDRESSES.has(normalizedAddress);
}

/**
 * S7 L4 §5.1:唯一的安全保證——即使某個 client 想繞過 UI 直接送出這些
 * method 的 raw request,一律在 dispatch 之前被擋下(不是靠 UI 隱藏按鈕)。
 * 之後 S3b 的預算設定 method 也要加進這個清單。`profile.update` 目前尚未
 * 實作(見 packages/shared/src/gateway.ts),等實作後也要加進來。
 */
const LOCAL_ONLY_METHODS = new Set<ClientRequestMethod>([
  "session.setPermissionMode", // auto / YOLO
  "config.setFile", // 政策與設定
  "profile.create",
  "profile.delete",
]);

/**
 * 常數時間比較 token(M5 Round B 任務3)。
 *
 * `crypto.timingSafeEqual()` 要求兩個 buffer 長度相同,否則直接丟例外——這裡
 * 先比長度,長度不同時直接短路回傳 false,不呼叫 timingSafeEqual()。這確實
 * 讓「兩個字串長度是否相同」透過時間側channel被觀察到(長度不同時提早
 * return,耗時明顯短於長度相同時進入常數時間比較),但這是刻意接受的簡化:
 * token 的**長度**本身不是需要保密的資訊(不像字元內容那樣,逐字元比較時間差
 * 可以被用來一個字元一個字元地猜出正確 token),真正需要防禦時序側寫攻擊的是
 * 「內容比對」這一步——只要長度相同時的比較走常數時間,就不會洩漏「猜的 token
 * 前幾個字元是否正確」這種可被利用來逐步縮小猜測範圍的資訊。
 */
function timingSafeTokenEqual(candidate: string, expected: string): boolean {
  const candidateBuf = Buffer.from(candidate, "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");
  if (candidateBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(candidateBuf, expectedBuf);
}

interface RateLimitEntry {
  failCount: number;
  blockedUntil: number;
  lastAttemptAt: number;
}

/**
 * 認證失敗 rate limiting(M5 Round B 任務3):同一來源 IP 連續認證失敗達門檻
 * 後,在冷卻期內直接拒絕該 IP 之後的認證嘗試(不論這次帶的 token 是否正確
 * ——見 ws-gateway.ts handleMessage() 內的呼叫順序:先檢查是否被封鎖,通過
 * 才會走到 timingSafeTokenEqual() 比對)。
 *
 * **資料結構**:純記憶體 `Map<來源IP, RateLimitEntry>`,不落地——這是連線層級
 * 的節流,不是需要跨重啟保留的業務資料,重啟 core 等於重置所有 IP 的計數,
 * 可接受。
 *
 * **避免無限增長**:不額外起 `setInterval` 做週期性清理(這對頻繁在 e2e
 * 測試中反覆建立/銷毀的 core 子程序更省心,不會有計時器忘記清除、导致
 * process 遲遲無法自然結束的風險)。改用 lazy sweep:每次呼叫 `isBlocked()`/
 * `recordFailure()` 時,先清掉「距離上次嘗試已超過 entryTtlMs」的舊項目。
 * entryTtlMs 預設是冷卻期的 4 倍,確保一個 IP 早就不再嘗試之後,對應的項目
 * 終究會被清掉,Map 大小只受「entryTtlMs 時間窗內出現過的相異來源 IP 數」
 * 上限,不會無限增長。
 *
 * **「連續」的語意**:任何一次認證成功(`recordSuccess`)都會把該 IP 的紀錄
 * 整筆刪除,失敗計數重新從 0 開始——符合「連續認證失敗達門檻」這句話的字面
 * 意思(中間夾一次成功就不算連續)。
 */
class AuthRateLimiter {
  private readonly attempts = new Map<string, RateLimitEntry>();
  private readonly entryTtlMs: number;

  constructor(
    private readonly maxFailures: number,
    private readonly cooldownMs: number,
  ) {
    this.entryTtlMs = cooldownMs * 4;
  }

  private sweep(now: number): void {
    for (const [ip, entry] of this.attempts) {
      if (now - entry.lastAttemptAt > this.entryTtlMs) {
        this.attempts.delete(ip);
      }
    }
  }

  /** 目前這個 IP 是否在冷卻期內(純查詢,不消耗/增加任何嘗試次數)。 */
  isBlocked(ip: string): boolean {
    const now = Date.now();
    this.sweep(now);
    const entry = this.attempts.get(ip);
    return Boolean(entry && entry.blockedUntil > now);
  }

  /** 記錄一次認證失敗;達門檻時設定冷卻期(已在冷卻期內的失敗不會延長冷卻期,
   *  因為呼叫端在 isBlocked() 為 true 時就已經提早 return,不會走到這裡)。 */
  recordFailure(ip: string): void {
    const now = Date.now();
    this.sweep(now);
    const entry = this.attempts.get(ip) ?? { failCount: 0, blockedUntil: 0, lastAttemptAt: now };
    entry.failCount += 1;
    entry.lastAttemptAt = now;
    if (entry.failCount >= this.maxFailures) {
      entry.blockedUntil = now + this.cooldownMs;
    }
    this.attempts.set(ip, entry);
  }

  /** 認證成功時清除該 IP 的失敗紀錄,見上方類別註解「連續」的語意。 */
  recordSuccess(ip: string): void {
    this.attempts.delete(ip);
  }
}

/**
 * Gateway(ARCHITECTURE.md 3.2 節):
 *   「UI 與 Core 之間走 WebSocket:指令用 request/response,agent 輸出用事件推播」
 *
 * Core 本身是 headless server,桌面殼只是其中一種 client(3.2 節、第 10 節
 * 設計決策 1)—— 這裡的 WS server 不對 Electron 做任何假設,瀏覽器/手機
 * client 一樣可以直接連上來(M5 Round B 落地,見 apps/core/src/http/
 * static-server.ts)。
 *
 * M3 Round A:新增 TeamManager(team.*)與 MessageBus(team.messages /
 * message.send)的 dispatch case,並訂閱 MessageBus 的 "team-message" 事件
 * 推播給所有 client。
 *
 * M5 Round A(任務2,認證):可選建構子參數 `authToken`。設定時,每個新連線
 * 預設「未認證」,必須把 `auth`(帶正確 token)當作可處理的第一則訊息送出
 * 才能繼續發送其他 request;`AUTH_TIMEOUT_MS` 內未通過就主動關閉連線。認證
 * 檢查/設定 flag 這段邏輯全部寫在 `handleMessage()` 最前面、且在任何
 * `await` 之前完成(見該方法內註解)。
 *
 * M5 Round B(任務1,靜態網頁):`listen()` 改成先建立一個 `node:http` 的
 * `Server`,把 `WebSocketServer` 用 `{ server }` 選項掛在它上面(`ws` 套件
 * 會自動監聽這個 http server 的 `upgrade` 事件,一般 HTTP GET 請求則交給
 * `listen()` 呼叫端傳入的 `staticRequestHandler`)——WS 升級請求與一般 HTTP
 * 請求天生走 Node 的不同事件(`upgrade` vs `request`),不需要手動判斷。
 *
 * M5 Round B(任務3,安全強化):token 比對改用常數時間比較
 * (`timingSafeTokenEqual`),並新增 `AuthRateLimiter` 做認證失敗的 IP 層級
 * rate limiting(見上方兩者的類別/函式註解)。
 */
export class WsGateway {
  private wss: WebSocketServer | undefined;
  private httpServer: NodeHttpServer | undefined;
  private clients = new Map<WebSocket, ConnectionState>();
  private readonly authRateLimiter: AuthRateLimiter;

  constructor(
    private readonly sessionManager: SessionManager,
    private readonly profiles: ProfileStore,
    private readonly teamManager: TeamManager,
    private readonly messageBus: MessageBus,
    private readonly taskService: TaskService,
    private readonly workspaceManager: WorkspaceManager,
    private readonly settingsStore: SettingsStore,
    /** S3b(CostGovernor)新增:`cost.getSummary` 的資料來源,見該 case 註解。 */
    private readonly costGovernor: CostGovernor,
    /** S6(crash-recovery)新增:`recovery.*` 系列 method 的資料來源,見該 case 註解。 */
    private readonly recoveryService: RecoveryService,
    /**
     * S11(Notification)新增:`RealNotifier`(或任何實作了這個最小事件介面的
     * `Notifier`)——批次/webhook 邏輯全在 `apps/core/src/enforcement/
     * notifier.ts` 裡,這裡只負責訂閱它的 `"enforcement-notification"` 事件
     * 並廣播給所有已認證的 client(比照 `sessionManager.on(...)` 的既有模式)。
     * 用最小介面(不是具體類別)避免這個檔案耦合到 `RealNotifier` 的實作細節
     * ——`ConsoleNotifier`(沒有 `on()`)不會被傳進來,`apps/core/src/index.ts`
     * 一律注入 `RealNotifier`。
     */
    private readonly notifier: NotificationEventSource,
    /**
     * M6 Round A 新增:core 啟動時已經算好的「有效設定」快照(見
     * apps/core/src/config/load-config.ts 的 `loadConfig()`)——`config.getEffective`
     * 直接回傳這個物件,**沒有熱重載**,`config.setFile` 寫入設定檔後這裡仍是
     * 舊的快照,直到 core 重新啟動才會反映最新值(見下方 `config.setFile`
     * dispatch case 的完整說明)。
     */
    private readonly effectiveConfig: EffectiveCoreConfig,
    /** `<DESKMONY_HOME>/config.json` 的絕對路徑,`config.setFile` 寫入用。 */
    private readonly configPath: string,
    private readonly authToken?: string,
    authFailureLimit: number = DEFAULT_AUTH_FAILURE_LIMIT,
    authFailureCooldownMs: number = DEFAULT_AUTH_FAILURE_COOLDOWN_MS,
  ) {
    this.authRateLimiter = new AuthRateLimiter(authFailureLimit, authFailureCooldownMs);

    this.sessionManager.on("session-event", (envelope: SessionEventEnvelope) => {
      this.broadcast({ kind: "event", channel: "session-event", payload: envelope });
    });
    this.sessionManager.on("session-updated", (session: Session) => {
      this.broadcast({ kind: "event", channel: "session-updated", payload: session });
    });
    this.sessionManager.on("session-list-updated", () => {
      this.broadcast({ kind: "event", channel: "session-list-updated", payload: null });
    });
    this.sessionManager.on("permission-resolved", (payload: PermissionResolvedPush) => {
      this.broadcast({ kind: "event", channel: "permission-resolved", payload });
    });
    this.messageBus.on("team-message", (message: TeamMessage) => {
      this.broadcast({ kind: "event", channel: "team-message", payload: message });
    });
    this.taskService.on("task-updated", (task: Task) => {
      this.broadcast({ kind: "event", channel: "task-updated", payload: task });
    });
    this.taskService.on("task-deleted", (payload: { id: string; teamId: string }) => {
      this.broadcast({ kind: "event", channel: "task-deleted", payload });
    });
    // S11(Notification):headless core 沒有 client 連線時,這個事件沒有任何
    // 監聽者送達也無所謂——`broadcast()` 本身在沒有已認證連線時就是 no-op
    // (見該方法實作),desktop app 沒開著時純粹是「送 push 沒有人收」,不是
    // 錯誤(notification_detail.md §6 失敗模式表)。
    this.notifier.on("enforcement-notification", (payload: EnforcementNotificationPush) => {
      this.broadcast({ kind: "event", channel: "enforcement-notification", payload });
    });
    // S12(session-subagent):child session completed 時推播結果給所有 client。
    this.sessionManager.on("child-result", (payload: ChildResultPush) => {
      this.broadcast({ kind: "event", channel: "child-result", payload });
    });
  }

  /**
   * @param host 綁定位址(M5 Round A 任務1)。預設由呼叫端(apps/core/src/index.ts)
   *   決定,這裡不內建預設值,避免這個類別自己對「安全預設」做假設 ——
   *   單一 source of truth 放在啟動流程(index.ts 讀 DESKMONY_BIND_HOST +
   *   驗證對外綁定必須有 token)。
   * @param staticRequestHandler M5 Round B 任務1:一般 HTTP GET 請求(非 WS
   *   升級)的 handler,通常是 apps/core/src/http/static-server.ts 的
   *   `createStaticRequestHandler()` 回傳值。不傳入時,一般 HTTP 請求一律回
   *   404(WS 功能不受影響)。
   */
  listen(
    port: number,
    host: string,
    staticRequestHandler?: (req: IncomingMessage, res: ServerResponse) => void,
  ): void {
    this.httpServer = createServer((req, res) => {
      if (staticRequestHandler) {
        staticRequestHandler(req, res);
      } else {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("Not Found");
      }
    });
    this.wss = new WebSocketServer({ server: this.httpServer });
    this.wss.on("connection", (socket, request) => this.handleConnection(socket, request));
    this.httpServer.on("error", (err) => {
      console.error("[gateway] HTTP server error:", err);
    });
    this.httpServer.listen(port, host, () => {
      console.log(`[gateway] WebSocket server listening on ws://${host}:${port}`);
    });
  }

  close(): void {
    for (const client of this.clients.keys()) client.close();
    this.wss?.close();
    this.httpServer?.close();
  }

  /**
   * S7 L4 §2.1(`attended` 的真值來源):**現在有沒有人看得到彈窗?**
   *
   * 判定與 `broadcast()` 完全一致——「連線是 OPEN **且已認證**」,因為那正是
   * 會收到 `permission-request` 推播的連線集合。未認證的連線刻意**不算**:
   * 它收不到任何推播(見 `broadcast()`),也還不能呼叫 `permission.resolve`,
   * 把它當成「有人在」會讓 escalate 進入 5 分鐘逾時 deny 的路徑,而那正是
   * S11 §4 論證要避免的錯誤(「沒人回應 ≠ 拒絕」)。**不確定時倒向
   * `false`**(= 掛起等人,不逾時 deny)。
   *
   * ⚠️ 這是**決策當下**的瞬時事實:一筆已經升級成 escalate 的請求不會因為
   * client 之後斷線/連上而改變它註冊時決定的逾時語意(見 session-manager.ts
   * 的 `buildExecContext()` 註解)。
   */
  hasConnectedClient(): boolean {
    for (const [socket, state] of this.clients) {
      if (socket.readyState === WebSocket.OPEN && state.authenticated) return true;
    }
    return false;
  }

  /**
   * S7 L4 §2.1(`local` 的真值來源):**只要有任何遠端 client 連線中,就視為
   * 非 local**。permission-request 不綁定單一 WS 連線,無法問「這一筆是誰送
   * 的」,故採這個保守的整體判定——遠端可能就是那個會去點「仍要允許」的人,
   * fail-safe 方向要求寧可嚴、不可寬。
   *
   * 與 `hasConnectedClient()` 不同,這裡**不要求已認證**:未認證的遠端連線
   * 五秒內就會被關掉,但在那之前它仍有可能通過認證並回應這筆請求;把它算進
   * 來只會讓 hard-deny 更早倒向直接 `deny`(不降級為 escalate-strong),方向
   * 與上面那個方法一樣是「不確定時選較嚴的那一邊」。
   */
  hasRemoteClient(): boolean {
    for (const [socket, state] of this.clients) {
      if (socket.readyState === WebSocket.OPEN && !state.isLocal) return true;
    }
    return false;
  }

  /** S7 L4 §5.3:握手能力集,四項皆等於 `isLocal`(見上方 `ConnectionState.isLocal`)。 */
  private buildCapabilities(isLocal: boolean): GatewayCapabilities {
    return { canToggleAuto: isLocal, canEnableYolo: isLocal, canEditPolicy: isLocal, canManageProfiles: isLocal };
  }

  private handleConnection(socket: WebSocket, request: IncomingMessage): void {
    const remoteAddress = normalizeRemoteAddress(request.socket?.remoteAddress);
    const needsAuth = Boolean(this.authToken);
    const isLocal = isLoopbackAddress(remoteAddress);
    const state: ConnectionState = { authenticated: !needsAuth, authTimer: undefined, remoteAddress, isLocal };
    this.clients.set(socket, state);

    if (needsAuth) {
      state.authTimer = setTimeout(() => {
        if (!state.authenticated) {
          // 逾時未通過認證(M5 Round A 任務2)—— 不記錄任何請求內容(避免
          // 意外把 token 寫進 log),單純關閉連線。
          socket.close(1008, "認證逾時");
        }
      }, AUTH_TIMEOUT_MS);
    }

    socket.on("message", (raw) => {
      void this.handleMessage(socket, raw.toString());
    });
    socket.on("close", () => {
      if (state.authTimer) clearTimeout(state.authTimer);
      this.clients.delete(socket);
    });
    socket.on("error", () => {
      if (state.authTimer) clearTimeout(state.authTimer);
      this.clients.delete(socket);
    });
  }

  private async handleMessage(socket: WebSocket, raw: string): Promise<void> {
    let parsed: ClientRequest;
    let requestId = "unknown";
    try {
      const json = JSON.parse(raw);
      requestId = typeof json?.id === "string" ? json.id : randomUUID();
      parsed = ClientRequestSchema.parse(json);
    } catch (err) {
      this.send(socket, {
        kind: "response",
        id: requestId,
        ok: false,
        error: `無效的請求格式: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }

    // S7:提前拿一次 state(供下面的認證閘門、LOCAL_ONLY_METHODS 檢查、
    // dispatch() 的 isLocal 參數共用同一份,不必各自重複 `this.clients.get()`)。
    const connState = this.clients.get(socket);

    // ---- M5 Round A 任務2 / M5 Round B 任務3:認證閘門 -------------------
    // 刻意寫在最前面、且完全同步(不含任何 await),打破「兩則訊息幾乎同時
    // 抵達時,認證 flag 還沒設好下一則就先通過檢查」的競爭窗口(見類別頂端
    // 註解)。這裡不論成功/失敗都絕不把 token 本身寫進任何 console.log。
    if (this.authToken) {
      const state = connState;
      if (state && !state.authenticated) {
        if (parsed.method !== "auth") {
          this.send(socket, {
            kind: "response",
            id: parsed.id,
            ok: false,
            error: "尚未完成認證:第一則訊息必須是帶正確 token 的 auth 請求",
          });
          return;
        }
        // M5 Round B 任務3:先檢查這個來源 IP 是否在冷卻期內——不論這次帶的
        // token 是否正確,冷卻期內一律直接拒絕(不消耗/增加失敗計數,見
        // AuthRateLimiter.isBlocked() 的註解)。
        if (this.authRateLimiter.isBlocked(state.remoteAddress)) {
          this.send(socket, {
            kind: "response",
            id: parsed.id,
            ok: false,
            error: "認證嘗試次數過多,請稍後再試",
          });
          socket.close(1008, "認證嘗試次數過多");
          return;
        }
        if (timingSafeTokenEqual(parsed.params.token, this.authToken)) {
          state.authenticated = true;
          this.authRateLimiter.recordSuccess(state.remoteAddress);
          if (state.authTimer) {
            clearTimeout(state.authTimer);
            state.authTimer = undefined;
          }
          this.send(socket, {
            kind: "response",
            id: parsed.id,
            ok: true,
            result: { ok: true, capabilities: this.buildCapabilities(state.isLocal) },
          });
        } else {
          this.authRateLimiter.recordFailure(state.remoteAddress);
          this.send(socket, {
            kind: "response",
            id: parsed.id,
            ok: false,
            error: "認證失敗:token 不正確",
          });
          socket.close(1008, "認證失敗");
        }
        return;
      }
      if (parsed.method === "auth") {
        // 已認證過的連線又送一次 auth:冪等地回應成功,不視為錯誤。
        this.send(socket, {
          kind: "response",
          id: parsed.id,
          ok: true,
          result: { ok: true, capabilities: this.buildCapabilities(state?.isLocal ?? false) },
        });
        return;
      }
    } else if (parsed.method === "auth") {
      // 未設定 DESKMONY_AUTH_TOKEN 時完全免認證(向下相容),auth 請求
      // 一律直接成功,讓 client 端可以無條件呼叫同一段認證流程而不需要
      // 額外判斷 core 是否啟用了認證。
      this.send(socket, {
        kind: "response",
        id: parsed.id,
        ok: true,
        result: { ok: true, capabilities: this.buildCapabilities(connState?.isLocal ?? false) },
      });
      return;
    }

    // ---- S7(auto-mode-and-yolo)L4 §5.1:遠端不可觸碰安全罩本身 ----------
    // 這裡是**唯一的安全保證**,不是靠 UI 隱藏按鈕——即使某個 client 想繞過
    // UI 直接送出這些 method 的 raw request,一樣會在這裡被擋下。
    if (LOCAL_ONLY_METHODS.has(parsed.method) && !connState?.isLocal) {
      console.warn(
        `[gateway][security] 拒絕遠端連線(${connState?.remoteAddress ?? "unknown"})呼叫 local-only method "${parsed.method}"`,
      );
      this.send(socket, {
        kind: "response",
        id: parsed.id,
        ok: false,
        error: `此操作僅限本機連線呼叫:${parsed.method}`,
      });
      return;
    }

    // ---- S7(自行判斷,保守方向,見最終報告):`permission.resolve` 本身不在
    // 上面的 LOCAL_ONLY_METHODS(遠端使用者也該能核可一般 escalate 請求),但
    // 「順便把這次決定寫成永久 policy 規則」屬於修改安全罩本身,與其餘 policy
    // 設定同等對待——L4 §5.1 沒有明講這個 field-level 的情況,選最保守的方向:
    // 僅本機可用(escalate-strong 的 rememberRule 已在 SessionManager 端強制擋,
    // 這裡額外擋的是「一般 escalate + 遠端 client」這個 L4 沒直接點名的組合)。
    if (parsed.method === "permission.resolve" && parsed.params.rememberRule !== undefined && !connState?.isLocal) {
      console.warn(
        `[gateway][security] 拒絕遠端連線(${connState?.remoteAddress ?? "unknown"})的 permission.resolve 帶 rememberRule(requestId=${parsed.params.requestId})`,
      );
      this.send(socket, {
        kind: "response",
        id: parsed.id,
        ok: false,
        error: "「永遠允許」規則僅限本機連線設定",
      });
      return;
    }

    try {
      const result = await this.dispatch(parsed, connState?.isLocal ?? false);
      this.send(socket, { kind: "response", id: parsed.id, ok: true, result });
    } catch (err) {
      this.send(socket, {
        kind: "response",
        id: parsed.id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async dispatch(request: ClientRequest, isLocal: boolean): Promise<unknown> {
    switch (request.method) {
      case "auth":
        // 已在 handleMessage() 頂端的認證閘門處理完畢,不會走到這裡
        // (兩個分支都提前 return)。保留這個 case 純粹是讓 switch 對
        // ClientRequestSchema 的 discriminated union 保持窮舉檢查完整。
        return { ok: true };
      /**
       * S7(auto-mode-and-yolo)L4 §5.3:握手能力集,獨立於 `auth`(不強制要求
       * client 一定要先呼叫 `auth` 才能拿到,見 gateway.ts 對應 schema 的
       * 註解)——`isLocal` 由 `handleMessage()` 算好、透過 `dispatch()` 的第二
       * 參數傳進來,`dispatch()` 本身不重新查 `this.clients`(同一次呼叫只
       * 判斷一次連線來源,避免與 handleMessage() 的判斷不一致)。
       */
      case "gateway.capabilities":
        return { capabilities: this.buildCapabilities(isLocal) };
      case "profile.list":
        return { profiles: await this.profiles.list() };
      case "profile.create":
        return { profile: await this.profiles.create(request.params) };
      case "profile.delete":
        await this.profiles.delete(request.params.id);
        return { ok: true };
      case "session.list":
        return { sessions: await this.sessionManager.listSessions() };
      case "session.create":
        return { session: await this.sessionManager.createSession(request.params) };
      case "session.sendPrompt":
        await this.sessionManager.sendPrompt(request.params.sessionId, request.params.prompt);
        return { ok: true };
      case "session.interrupt":
        await this.sessionManager.interrupt(request.params.sessionId);
        return { ok: true };
      case "session.terminalInput":
        this.sessionManager.writeTerminalInput(request.params.sessionId, request.params.data);
        return { ok: true };
      case "session.resizeTerminal":
        this.sessionManager.resizeTerminal(request.params.sessionId, request.params.cols, request.params.rows);
        return { ok: true };
      case "session.history":
        return { messages: await this.sessionManager.getHistory(request.params.sessionId) };
      case "session.delete":
        await this.sessionManager.deleteSession(request.params.sessionId);
        return { ok: true };
      case "session.setModel":
        return { session: await this.sessionManager.setSessionModel(request.params.sessionId, request.params.model) };
      case "session.setEffort":
        return { session: await this.sessionManager.setSessionEffort(request.params.sessionId, request.params.effort) };
      case "permission.resolve":
        // rememberRule 若帶 escalate-strong 的 requestId,SessionManager 端會
        // 強制忽略(C4 紀律③);遠端連線帶 rememberRule 已在 handleMessage()
        // 更早一步被擋下(見上方 §5.1 之後的自行判斷區塊)。
        this.sessionManager.resolvePermission(request.params.requestId, request.params.decision, request.params.rememberRule);
        return { ok: true };
      /**
       * S7 L4 §2:切換 session 的暫態權限模式(auto/YOLO)。**遠端一律拒絕**
       * ——已在 `handleMessage()` 的 `LOCAL_ONLY_METHODS` 檢查擋下,這裡不會
       * 收到遠端呼叫。
       */
      case "session.setPermissionMode": {
        const state = this.sessionManager.setSessionPermissionMode(request.params.sessionId, request.params.mode);
        return { mode: state.mode, yoloExpiresAt: state.yoloExpiresAt };
      }
      /**
       * S12(session-subagent):從 parent session spawn child subagent session。
       * child completed 時會自動透過 "child-result" push 回傳結果。
       */
      case "session.spawnChild":
        return { session: await this.sessionManager.spawnChild(request.params) };
      case "adapter.capabilities":
        return { capabilities: this.sessionManager.getCapabilities(request.params.software) };
      case "env.detectAgents":
        // M5 Round D:不吃任何呼叫端參數(見 packages/shared/src/gateway.ts
        // 對應 schema 的註解、apps/core/src/detect/agent-detector.ts 的安全
        // 設計說明)——`detectAllAgents()` 只探測寫死在該檔案內的 allowlist。
        return { agents: await detectAllAgents() };
      /**
       * M5 Round E:「設定」介面的「啟用哪些偵測到的 model」偏好,見
       * apps/core/src/settings/settings-store.ts 的完整語意說明(空陣列 =
       * 全部啟用)。`setEnabledModels` 回傳寫入後的值,不需要呼叫端再多一次
       * `getEnabledModels` 往返確認。
       */
      case "settings.getEnabledModels":
        return { enabledModelIds: await getEnabledClaudeModelIds(this.settingsStore) };
      case "settings.setEnabledModels":
        await setEnabledClaudeModelIds(this.settingsStore, request.params.enabledModelIds);
        return { enabledModelIds: request.params.enabledModelIds };
      /**
       * 這輪新增(provider 目錄重構):per-provider 偏好的一般化版本,見
       * packages/shared/src/gateway.ts 對應 case 的完整安全/語意說明。
       * **安全關鍵**:兩個 case 都只把 `maskProviderPrefsMap()` 的輸出回傳給
       * client,絕不把 `getProviderPrefsMap()`/`patchProviderPrefs()` 的
       * (未遮罩)回傳值直接送出去——見 apps/core/src/settings/
       * settings-store.ts 頂端註解「安全:env 的處理」。
       */
      case "settings.getProviderPrefs":
        return { prefs: maskProviderPrefsMap(await getProviderPrefsMap(this.settingsStore)) };
      case "settings.setProviderPrefs":
        return {
          prefs: maskProviderPrefsMap(
            await patchProviderPrefs(this.settingsStore, request.params.providerId, request.params.patch),
          ),
        };
      /**
       * M6 Round A 新增:「全域設定」的分層合併結果(見 packages/shared/src/
       * gateway.ts 對應 case 的完整說明)。直接回傳建構時就已經算好的快照,
       * 不重新讀檔/重新讀環境變數——這個方法本身完全同步、不做任何 I/O。
       */
      /**
       * S11(Notification)修改:回傳前先遮罩 `notification.webhook.url`(見
       * `maskEffectiveConfigForClient()`)——webhook url 視同憑證
       * (notification_detail.md §5),絕不把明碼 URL 送給任何連上 gateway 的
       * client,比照 `maskProviderPrefsMap()` 的既有慣例(遮罩只發生在「回傳
       * 給 client」這一步,`this.effectiveConfig` 本身持有的仍是明碼值)。
       */
      case "config.getEffective":
        return { effective: maskEffectiveConfigForClient(this.effectiveConfig) };
      /**
       * M6 Round A 新增:把安全子集的欄位 patch 寫進 `<DESKMONY_HOME>/
       * config.json`(見 apps/core/src/config/config-file-writer.ts 的
       * `applyConfigFilePatch()`)。**安全關鍵**:`request.params` 的型別已經
       * 由 `ConfigSetFilePatchSchema`(見 packages/shared/src/core-config.ts)
       * 限制成安全子集——`daemon.port`/`daemon.bindHost` 不在允許的欄位裡,
       * 呼叫端若嘗試夾帶這兩個欄位,`ClientRequestSchema.parse()` 在
       * `handleMessage()` 那一步就已經因為未知欄位直接拒絕,不會走到這裡。
       * 這裡**不做熱重載**——回應固定 `requiresRestart: true`,提醒呼叫端
       * (SettingsDialog)顯示「請重啟 core 才會生效」。
       */
      case "config.setFile": {
        const result = applyConfigFilePatch(this.configPath, request.params);
        return { ok: true, changedFields: result.changedFields, requiresRestart: true };
      }
      case "team.create":
        return { team: await this.teamManager.createTeam(request.params) };
      case "team.list":
        return { teams: await this.teamManager.listTeams() };
      case "team.addMember":
        return { member: await this.teamManager.addMember(request.params) };
      case "team.removeMember":
        await this.teamManager.removeMember(request.params.teamId, request.params.memberId);
        return { ok: true };
      case "team.messages":
        return { messages: await this.messageBus.getMessages(request.params.teamId, request.params.limit) };
      case "team.teammates":
        // requestingMemberId 純粹是介面欄位(見 packages/shared/src/team-bus.ts
        // 的 TeamBusPort.listTeammates()),listTeammates() 實作本身不依賴它做
        // 任何過濾,UI(非 agent)呼叫時給空字串即可。
        return { teammates: await this.messageBus.listTeammates({ teamId: request.params.teamId, requestingMemberId: "" }) };
      case "message.send":
        return await this.messageBus.sendHumanMessage(request.params);
      case "message.reportStatus":
        return { message: await this.messageBus.reportStatus(request.params) };
      case "message.requestReview":
        return await this.messageBus.requestReview(request.params);
      /**
       * S2(message-budget)新增:比照 `message.reportStatus`/`message.requestReview`
       * 的既有先例——非 agent 呼叫端(UI、e2e 決定性測試)也能呼叫與 team-bus
       * MCP 工具完全相同的 `MessageBus.sendMessage()`/`broadcast()`,含這輪
       * 新增的 contextId 推導與訊息預算閘(見 packages/shared/src/gateway.ts
       * 對應 schema 的完整說明)。
       */
      case "message.sendMessage":
        return await this.messageBus.sendMessage(request.params);
      case "message.broadcast":
        return await this.messageBus.broadcast(request.params);
      case "message.getContextBudget":
        return await this.messageBus.getContextBudgetStatus(request.params.contextId);
      case "task.create":
        return { task: await this.taskService.createTask(request.params) };
      case "task.list":
        return { tasks: await this.taskService.listTasks(request.params.teamId) };
      case "task.get": {
        const task = await this.taskService.getTask(request.params.taskId);
        if (!task) {
          throw new Error(`找不到任務: ${request.params.taskId}`);
        }
        return { task };
      }
      case "task.assign":
        return await this.taskService.assignTask(request.params);
      case "task.updateStatus":
        return { task: await this.taskService.updateStatus(request.params.taskId, request.params.status) };
      case "task.merge":
        return { task: await this.taskService.mergeAndComplete(request.params.taskId) };
      case "task.delete": {
        const result = await this.taskService.deleteTask(request.params.taskId);
        return { ok: true, hadUncommittedChanges: result.hadUncommittedChanges };
      }
      case "workspace.get": {
        const workspace = await this.workspaceManager.getWorkspace(request.params.workspaceId);
        if (!workspace) {
          throw new Error(`找不到 workspace: ${request.params.workspaceId}`);
        }
        return { workspace };
      }
      /**
       * S4(機器驗收閘)新增,見 packages/shared/src/gateway.ts 對應 case 的
       * 完整說明——`setAcceptance()`/`runAcceptance()` 都只是薄薄一層委派給
       * `TaskService`,實際邏輯全在該檔案(不碰 `updateStatus()`)。
       */
      case "task.setAcceptance":
        return { task: await this.taskService.setAcceptance(request.params.taskId, request.params.acceptance) };
      case "task.runAcceptance":
        return { result: await this.taskService.runAcceptance(request.params.taskId) };
      /**
       * S5(dispose-gate)新增:見 packages/shared/src/gateway.ts 對應 case 的
       * 完整說明——薄薄一層委派給 `TaskService.approveReview()`。刻意**不**
       * 加進上方的 `LOCAL_ONLY_METHODS`:核可「等待人類核可」的任務是日常
       * 操作,不是安全罩設定,本機/遠端使用者都該能做(同一般 escalate 請求
       * 的既有先例,見 `LOCAL_ONLY_METHODS` 上方註解)。
       */
      case "task.approveReview":
        return { task: await this.taskService.approveReview(request.params.taskId) };
      /**
       * S3b(CostGovernor)新增:見 packages/shared/src/gateway.ts 對應 case 的
       * 完整說明——薄薄一層委派給 `CostGovernor.getSummary()`。
       */
      case "cost.getSummary":
        return await this.costGovernor.getSummary(request.params.sessionId);
      /**
       * S6(crash-recovery)新增:見 packages/shared/src/gateway.ts 對應 case
       * 的完整說明——薄薄一層委派給 `RecoveryService`(apps/core/src/recovery/
       * recovery-service.ts),實際邏輯全在該檔案。
       */
      case "recovery.list":
        return { sessions: await this.recoveryService.list() };
      case "recovery.continue":
        return { session: await this.recoveryService.continueSession(request.params.sessionId) };
      case "recovery.takeover":
        return { session: await this.recoveryService.takeover(request.params.sessionId) };
      case "recovery.gitStatus":
        return await this.recoveryService.gitStatus(request.params.sessionId);
      case "recovery.resolveDirtyWorktree":
        return await this.recoveryService.resolveDirtyWorktree(request.params);
      case "recovery.rerun":
        return { session: await this.recoveryService.rerun(request.params.sessionId) };
      case "recovery.abandon":
        await this.recoveryService.abandon(request.params.sessionId);
        return { ok: true };
      default: {
        const exhaustiveCheck: never = request;
        throw new Error(`未知的方法: ${JSON.stringify(exhaustiveCheck)}`);
      }
    }
  }

  private send(socket: WebSocket, message: GatewayServerResponse | ServerPush): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(message));
  }

  private broadcast(message: ServerPush): void {
    const payload = JSON.stringify(message);
    // M5 Round A:只推播給已認證的連線(未認證的連線在 auth 通過前不應該
    // 收到任何 agent 輸出/團隊訊息等潛在敏感內容)。未設定 authToken 時
    // 所有連線一律 authenticated=true,行為與過去完全相同。
    for (const [client, state] of this.clients) {
      if (client.readyState === WebSocket.OPEN && state.authenticated) client.send(payload);
    }
  }
}

/**
 * S11(Notification)新增:`config.getEffective` 回傳前遮罩 `notification.
 * webhook.url`(視同憑證,見 packages/shared/src/core-config.ts 的
 * `EffectiveCoreConfigSchema.notification` 註解)。空字串(未設定)不需要遮罩
 * ——遮罩的目的是不外流「已設定的真實 URL」,空字串本身不含任何機敏資訊。
 * 只淺層複製 `notification`/`notification.webhook` 這兩層,其餘欄位(含
 * `notification.webhook` 內的 `enabled`/`minSeverity`)原樣沿用同一個物件
 * 參考——比照 `maskProviderPrefsMap()` 的既有慣例,遮罩只在「回傳給 client」
 * 這一步做,不修改 `this.effectiveConfig` 本身持有的值。
 */
function maskEffectiveConfigForClient(effective: EffectiveCoreConfig): EffectiveCoreConfig {
  if (!effective.notification.webhook.url.value) return effective;
  return {
    ...effective,
    notification: {
      ...effective.notification,
      webhook: {
        ...effective.notification.webhook,
        url: { ...effective.notification.webhook.url, value: "***" },
      },
    },
  };
}
