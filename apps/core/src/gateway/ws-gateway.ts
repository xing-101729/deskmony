import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server as NodeHttpServer, type ServerResponse } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import {
  ClientRequestSchema,
  DeskmonyError,
  ErrorCodes,
  type ChildResultPush,
  type ClientRequest,
  type ClientRequestMethod,
  type EffectiveCoreConfig,
  type EnforcementNotificationPush,
  type GatewayCapabilities,
  type McpBridgeTokenGrant,
  type McpBridgeTokenScope,
  type PermissionResolvedPush,
  type PolicyUpdatedPush,
  type ServerResponse as GatewayServerResponse,
  type ServerPush,
  type Session,
  type SessionEventEnvelope,
  type Task,
  type TeamMessage,
  type UserDialogResolvedPush,
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
  /**
   * Phase 2(ACP scoped MCP bridge token):若這條連線是用 scoped bridge
   * token(而非 master `DESKMONY_AUTH_TOKEN`,也不是「未設定 authToken」的
   * 免認證模式)通過認證,這裡是它綁定的授權範圍——`handleMessage()` 在
   * dispatch 之前用 `checkScopedGrantAccess()` 依此做方法白名單 + 綁定
   * session/team 的檢查。`undefined` 代表這是一般連線(master token 或無認證
   * 模式),完全不受這層額外限制,行為與這輪之前完全相同。
   */
  scopedGrant?: ScopedTokenGrant;
}

/** 未認證連線的逾時秒數(M5 Round A 任務2:逾時未認證即關閉連線)。 */
const AUTH_TIMEOUT_MS = 5_000;

/**
 * Phase 2(ACP scoped MCP bridge token):見 apps/core/src/gateway/
 * ws-gateway.ts 頂端 class 註解與 `packages/shared/src/mcp-bridge-auth.ts`
 * 的背景說明。
 *
 * `token` 一律帶這個前綴,用來在 `handleMessage()` 的認證閘門**無條件**
 * (不受 `DESKMONY_AUTH_TOKEN` 是否設定影響)辨識出「這是一次 scoped bridge
 * token 的認證嘗試」,與一般 client(master token 或無認證模式的任意/空字串
 * token)分流——這是整個機制能不能在「core 未設定 DESKMONY_AUTH_TOKEN」這種
 * (本專案最常見的單機模式)情境下仍然正確限縮權限的關鍵:若不靠前綴分流,
 * 一個已過期/被撤銷的 scoped token 送到「未設定 authToken → auth 一律直接
 * 成功」那條既有分支時,會被誤判成一般連線而意外拿到**完整、無範圍限制**的
 * gateway 存取權——這正是本輪安全設計最需要避免的事。
 */
const MCP_BRIDGE_TOKEN_PREFIX = "dmbt_";

/**
 * scoped token 的絕對過期時間保底(24 小時)——即使呼叫端忘了在 session
 * dispose 時呼叫 `revokeMcpBridgeTokensForSession()`,token 也不會永久有效。
 * 正常情況下 token 的失效由 `AcpAdapter.dispose()` 主動觸發(見該方法),這個
 * TTL 只是防禦性的保底,故設得夠寬鬆、幾乎不會在正常使用中觸發。可由
 * `DESKMONY_MCP_BRIDGE_TOKEN_TTL_MS` 覆寫(比照 `DESKMONY_YOLO_DURATION_MS`
 * 等既有慣例,純粹讓 e2e 測試能在合理時間內驗證「過期後拒絕」這條規則)。
 */
const DEFAULT_MCP_BRIDGE_TOKEN_TTL_MS = 24 * 60 * 60_000;

/**
 * 一個已核發、尚未失效的 scoped bridge token 的完整狀態。`sessionId`/`team`/
 * `subagent` 直接對應 `McpBridgeTokenScope`(核發時呼叫端提供的綁定範圍),
 * `allowedMethods` 是依這個範圍算出的方法白名單(見 `computeAllowedMethods()`)
 * ——連 `allowedMethods` 本身也一併存進 grant,而不是每次請求都重新計算,
 * 避免核發時的範圍與檢查時的白名單邏輯有機會不同步。
 */
interface ScopedTokenGrant {
  token: string;
  sessionId: string;
  team?: { teamId: string; memberId: string };
  subagent: boolean;
  allowedMethods: ReadonlySet<ClientRequestMethod>;
  expiresAt: number;
}

/**
 * 依 `McpBridgeTokenScope` 算出允許呼叫的 gateway 方法白名單——**精確**列出
 * 每個 team-bus/subagent MCP 工具對應的既有(或這輪新增的)gateway 方法,
 * 刻意不用任何前綴比對或範圍歸類的方式圖方便(例如「所有 `message.*` 方法」
 * 或「所有 `session.*` 方法」都不精確,`session.setPermissionMode`/
 * `message.getContextBudget` 等完全不相干的方法會被誤放行)。
 *
 * 對照表(MCP 工具 → gateway 方法,見 packages/adapters/src/team-bus-mcp.ts /
 * subagent-mcp.ts / mcp-bridge-server.ts):
 *   send_message      → message.sendMessage
 *   broadcast         → message.broadcast
 *   list_teammates    → team.teammates
 *   report_status     → message.reportStatus
 *   request_review    → message.requestReview
 *   spawn_subagent    → session.spawnChildForSubagent
 *   send_to_subagent  → session.sendToChild
 *   list_subagents    → session.listChildren
 *   list_profiles     → profile.listForSubagent
 */
function computeAllowedMethods(scope: McpBridgeTokenScope): ReadonlySet<ClientRequestMethod> {
  const methods = new Set<ClientRequestMethod>();
  if (scope.team) {
    methods.add("message.sendMessage");
    methods.add("message.broadcast");
    methods.add("team.teammates");
    methods.add("message.reportStatus");
    methods.add("message.requestReview");
  }
  if (scope.subagent) {
    methods.add("session.spawnChildForSubagent");
    methods.add("session.sendToChild");
    methods.add("session.listChildren");
    methods.add("profile.listForSubagent");
  }
  return methods;
}

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
 * Phase 2(ACP scoped MCP bridge token):算出 mcp-bridge-server.ts 子行程
 * 應該連線的 host——子行程一律是本機同一台機器上被 spawn 出來的行程(見
 * `WsGateway.mintMcpBridgeToken()` 的呼叫點),只要 `bindHost` 涵蓋 loopback
 * (預設 `127.0.0.1`,或對外開放用的萬用位址 `0.0.0.0`/`::`)就一律回傳
 * `127.0.0.1`——不受 `DESKMONY_BIND_HOST` 是否對外開放影響,子行程走 loopback
 * 永遠比照原樣使用 `bindHost` 更安全也更不會連不上(0.0.0.0 本身不是可連線的
 * 目的地位址)。只有 `bindHost` 被設成某個特定的、不含 loopback 的位址(例如
 * 區網 IP,`validateBindSafety()` 會要求這種設定必須同時有
 * `DESKMONY_AUTH_TOKEN`)時,loopback 才真的連不到——此時老實回傳原樣的
 * `bindHost`(這台機器上除了那個特定位址,不確定 loopback 是否也在聽)。
 */
function resolveMcpBridgeConnectHost(bindHost: string): string {
  const LOOPBACK_COVERING_HOSTS = new Set(["127.0.0.1", "localhost", "0.0.0.0", "::"]);
  return LOOPBACK_COVERING_HOSTS.has(bindHost) ? "127.0.0.1" : bindHost;
}

/**
 * S7 L4 §5.1:唯一的安全保證——即使某個 client 想繞過 UI 直接送出這些
 * method 的 raw request,一律在 dispatch 之前被擋下(不是靠 UI 隱藏按鈕)。
 * 之後 S3b 的預算設定 method 也要加進這個清單。`profile.update` 目前尚未
 * 實作(見 packages/shared/src/gateway.ts),等實作後也要加進來。
 *
 * ⚠️ 2026-08-25 修訂(見 docs/DECISIONS.md §G):`session.setPermissionMode`
 * 已移除——使用者明確翻案原 F3/C6「遠端不可切 auto/YOLO」的限制,本機與遠端
 * 現在同等對待。新增的 `session.setTrueUnrestricted`/`policy.addRule`/
 * `policy.removeRule`/`policy.listRules` 四個方法**刻意不加進這個清單**
 * (同一次翻案的一部分)。`config.setFile`(daemon/workspace/features/log 這類
 * 一般設定,不含 policy)、`profile.create`、`profile.delete` 三項使用者沒有
 * 要求開放,維持 local-only。
 */
const LOCAL_ONLY_METHODS = new Set<ClientRequestMethod>([
  "config.setFile", // 一般設定(daemon/workspace/features/log,不含 policy)
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
  /**
   * Phase 2(ACP scoped MCP bridge token):`token -> grant`(認證閘門查表用)
   * 與 `sessionId -> 該 session 核發過的所有 token`(`revokeMcpBridgeTokensForSession()`
   * 撤銷用,見該方法)。純記憶體,不落地——比照 `AuthRateLimiter` 的既有慣例
   * (連線層級的暫態,不是需要跨重啟保留的業務資料,core 重啟等於所有既有 ACP
   * session 都要重新 spawn,舊 token 本來就該失效)。
   */
  private readonly scopedTokens = new Map<string, ScopedTokenGrant>();
  private readonly scopedTokensBySession = new Map<string, Set<string>>();
  private readonly mcpBridgeTokenTtlMs: number;

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
    /** Phase 2(ACP scoped MCP bridge token)新增,見 `DEFAULT_MCP_BRIDGE_TOKEN_TTL_MS`
     *  的說明——可由 `DESKMONY_MCP_BRIDGE_TOKEN_TTL_MS` 覆寫,純粹方便 e2e 測試。 */
    mcpBridgeTokenTtlMs: number = DEFAULT_MCP_BRIDGE_TOKEN_TTL_MS,
  ) {
    this.authRateLimiter = new AuthRateLimiter(authFailureLimit, authFailureCooldownMs);
    this.mcpBridgeTokenTtlMs = mcpBridgeTokenTtlMs;

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
    // async-scribbling-llama.md Phase 7:一筆 AskUserQuestion 的待答問題被解決
    // 時,轉播給所有已認證 client(比照上面 "permission-resolved" 的既有模式)。
    this.sessionManager.on("user-dialog-resolved", (payload: UserDialogResolvedPush) => {
      this.broadcast({ kind: "event", channel: "user-dialog-resolved", payload });
    });
    // 2026-08-25 新增(見 docs/DECISIONS.md §G):`policy.addRule`/`removeRule`
    // 成功後轉播給所有已認證 client,讓「權限」設定頁在其他視窗/其他 client
    // 也能即時看到允許清單變化(比照上面幾個 broadcast 的既有模式)。
    this.sessionManager.on("policy-updated", (payload: PolicyUpdatedPush) => {
      this.broadcast({ kind: "event", channel: "policy-updated", payload });
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

  /**
   * S7 L4 §5.3:握手能力集。
   *
   * ⚠️ 2026-08-25 修訂(見 docs/DECISIONS.md §G):`canToggleAuto`/
   * `canEnableYolo`/`canEditPolicy` 不再等於 `isLocal`,改成恆 `true`——使用者
   * 明確翻案,遠端與本機同權。`canManageProfiles` 維持 `isLocal`,未變動
   * (使用者這輪沒有要求開放 profile 管理)。新增 `canEnableTrueUnrestricted`
   * (恆 `true`,真正的把關是每次呼叫時的 session-mode 前置條件,不是連線
   * 類型)與 `isRemoteConnection`(純顯示用,見 `GatewayCapabilitiesSchema` 的
   * 完整說明)。
   */
  private buildCapabilities(isLocal: boolean): GatewayCapabilities {
    return {
      canToggleAuto: true,
      canEnableYolo: true,
      canEditPolicy: true,
      canManageProfiles: isLocal,
      canEnableTrueUnrestricted: true,
      isRemoteConnection: !isLocal,
    };
  }

  /**
   * Phase 2(ACP scoped MCP bridge token):核發一個新的 scoped token,實作
   * `packages/shared/src/mcp-bridge-auth.ts` 的 `McpBridgeTokenPort.mint()`
   * ——`apps/core/src/index.ts` 建構好這個 `WsGateway` 之後,用一個委派到這個
   * 方法的物件呼叫 `AcpAdapter.setTokenMinter()`(事後注入,理由見該檔案的
   * 建構順序註解)。
   *
   * `gatewayUrl` 一律用 `this.effectiveConfig.daemon.port.value`(與
   * `listen()` 實際綁定的 port 同一個來源——`apps/core/src/index.ts` 的
   * `main()` 用同一個 `config.daemon.port` 同時餵給 `gateway.listen()` 與
   * `loadConfig()` 算出的 `effective`,兩者不可能不同步)算出——host 部分見
   * `resolveMcpBridgeConnectHost()`:子行程一律是本機同一台機器上被 spawn
   * 出來的行程,只要 bindHost 涵蓋 loopback 就一律連 127.0.0.1,不受
   * `DESKMONY_BIND_HOST` 對外綁定的設定影響;只有 bindHost 被設成某個特定的
   * 區網位址時,loopback 才真的連不到,此時老實回傳那個特定位址。
   */
  mintMcpBridgeToken(scope: McpBridgeTokenScope): McpBridgeTokenGrant {
    this.sweepExpiredScopedTokens();
    const token = `${MCP_BRIDGE_TOKEN_PREFIX}${randomBytes(32).toString("hex")}`;
    const expiresAt = Date.now() + this.mcpBridgeTokenTtlMs;
    const grant: ScopedTokenGrant = {
      token,
      sessionId: scope.sessionId,
      team: scope.team,
      subagent: scope.subagent,
      allowedMethods: computeAllowedMethods(scope),
      expiresAt,
    };
    this.scopedTokens.set(token, grant);
    const bySession = this.scopedTokensBySession.get(scope.sessionId) ?? new Set<string>();
    bySession.add(token);
    this.scopedTokensBySession.set(scope.sessionId, bySession);

    const host = resolveMcpBridgeConnectHost(this.effectiveConfig.daemon.bindHost.value);
    const port = this.effectiveConfig.daemon.port.value;
    return { token, gatewayUrl: `ws://${host}:${port}`, expiresAt };
  }

  /**
   * Phase 2:讓某個 session 核發過的所有 scoped token 立即失效,實作
   * `McpBridgeTokenPort.revokeForSession()`——`AcpAdapter.dispose()` 必須
   * 呼叫,見該方法。**不主動關閉**該 token 對應的 WS 連線本身(子行程自己會
   * 在偵測到之後的 request 失敗後決定要不要結束)——但**這裡移除的
   * `this.scopedTokens` 項目,是 `checkScopedGrantAccess()` 之後每次 dispatch
   * 都會重新查詢的同一份活的來源**(見該方法內的說明:安全審查抓到過一版
   * 只信任連線建立當下快取物件、never 回頭查這個 map 的錯誤實作,已修正),
   * 所以撤銷之後,這條連線送出的下一個 request 就會因為查不到而被拒絕,不需要
   * 額外主動關閉連線才能讓撤銷生效。
   */
  revokeMcpBridgeTokensForSession(sessionId: string): void {
    const tokens = this.scopedTokensBySession.get(sessionId);
    if (!tokens) return;
    for (const token of tokens) this.scopedTokens.delete(token);
    this.scopedTokensBySession.delete(sessionId);
  }

  /** 比照 `AuthRateLimiter.sweep()` 的既有慣例:lazy sweep,不額外起
   *  `setInterval`(避免計時器讓 core process 難以自然結束)。每次核發新
   *  token 時,先清掉已經過期的舊 grant,避免 `scopedTokens` 無限增長。 */
  private sweepExpiredScopedTokens(): void {
    const now = Date.now();
    for (const [token, grant] of this.scopedTokens) {
      if (grant.expiresAt <= now) {
        this.scopedTokens.delete(token);
        this.scopedTokensBySession.get(grant.sessionId)?.delete(token);
      }
    }
  }

  /**
   * Phase 2:認證閘門用——`candidate` 是否帶有 scoped bridge token 的前綴。
   * 見 `MCP_BRIDGE_TOKEN_PREFIX` 的完整理由:這個判斷**必須**先於
   * `this.authToken` 是否設定的分流,否則一個過期/被撤銷的 scoped token 會在
   * 「未設定 authToken」的免認證模式下被誤判成一般連線,意外拿到完整存取權。
   */
  private isMcpBridgeTokenCandidate(candidate: string): boolean {
    return candidate.startsWith(MCP_BRIDGE_TOKEN_PREFIX);
  }

  /**
   * Phase 2:查表比對——**刻意不用** `timingSafeTokenEqual()` 逐一比對每個
   * grant(那是給 `DESKMONY_AUTH_TOKEN` 這種單一、可能是使用者手動設定/記憶
   * 的固定密鑰用的常數時間比較,防的是「逐字元側寫猜出正確 token」)。scoped
   * token 是這裡自己用 `randomBytes(32)` 產生的 256-bit 隨機值,不存在「使用者
   * 手動輸入、需要防止逐字元猜測」的情境,一般 `Map.get()` 雜湊查找已經是這類
   * 高熵 bearer token 業界常見的做法(web session token/API key 的驗證幾乎都是
   * 這樣做),不需要對雜湊表查找本身的時間側 channel 過度防禦。
   */
  private matchScopedToken(candidate: string): ScopedTokenGrant | undefined {
    this.sweepExpiredScopedTokens();
    const grant = this.scopedTokens.get(candidate);
    if (!grant) return undefined;
    if (grant.expiresAt <= Date.now()) {
      this.scopedTokens.delete(candidate);
      this.scopedTokensBySession.get(grant.sessionId)?.delete(candidate);
      return undefined;
    }
    return grant;
  }

  /**
   * Phase 2:一條已通過 scoped token 認證的連線,對每個非 `auth` request 做的
   * 方法白名單 + 綁定範圍檢查——比照既有 `LOCAL_ONLY_METHODS` 的檢查模式與
   * 拒絕回覆格式(`errorCode: ErrorCodes.GATEWAY_SCOPED_TOKEN_FORBIDDEN`,見
   * `handleMessage()` 的呼叫點),不另外發明一套。
   *
   * 三層檢查:
   *   1. **這個 token 是否仍然活著**——外部安全審查抓到的真實漏洞修正:早期
   *      實作這裡只檢查呼叫端傳進來的 `grant` 參數(連線 `auth` 成功當下快取
   *      在 `connState.scopedGrant` 的那個物件參照),`revokeMcpBridgeTokensFor
   *      Session()` 只會從 `this.scopedTokens` 這個 map 刪除項目,**不會**回頭
   *      改寫已經快取在既有連線上的物件——結果是撤銷/過期對一個「已經完成
   *      auth handshake」的連線完全沒有效果,它會帶著原始範圍一路用到 token
   *      的絕對 TTL(預設 24 小時)為止。這個缺口不需要任何惡意情境就會發生
   *      ——`AcpAdapter.dispose()` 呼叫 `revokeForSession()` 到 `killChild()`
   *      真的把子行程殺掉之間,`waitForChildExit()` 本身就給了子行程最多 3
   *      秒的存活窗口,這段時間內子行程若剛好還在送 request,舊實作一律放行。
   *      修正方式:**一律用 `grant.token` 重新查詢 `matchScopedToken()`**(而
   *      非信任傳入的 `grant` 物件本身)——這個方法本來就會一併處理「查不到
   *      (已撤銷)」與「已過期」兩種情況,不需要在這裡重複一份 TTL 判斷,後續
   *      判斷一律用這次查到的、當下真正有效的 grant。
   *   2. 方法本身是否在這個 grant 的 `allowedMethods` 白名單內。
   *   3. 白名單內的方法,參數是否真的操作它被核發時綁定的那個 session/team
   *      ——**不能只信任 request.params 帶的 teamId/fromMemberId/
   *      parentSessionId**(這條連線背後的子行程理論上可能被動過手腳,送出
   *      跟自己 env 不一致的參數),一律拿 grant 記錄的值重新比對。
   */
  private checkScopedGrantAccess(grant: ScopedTokenGrant, request: ClientRequest): { allowed: boolean; reason?: string } {
    const current = this.matchScopedToken(grant.token);
    if (!current) return { allowed: false, reason: "token 已撤銷或已過期" };
    if (!current.allowedMethods.has(request.method)) {
      return { allowed: false, reason: "不在此 token 的授權方法白名單內" };
    }
    switch (request.method) {
      case "message.sendMessage":
      case "message.broadcast":
      case "message.reportStatus":
      case "message.requestReview":
        if (!current.team || request.params.teamId !== current.team.teamId || request.params.fromMemberId !== current.team.memberId) {
          return { allowed: false, reason: "teamId/fromMemberId 與此 token 綁定的團隊/成員不符" };
        }
        return { allowed: true };
      case "team.teammates":
        if (!current.team || request.params.teamId !== current.team.teamId) {
          return { allowed: false, reason: "teamId 與此 token 綁定的團隊不符" };
        }
        return { allowed: true };
      case "session.spawnChildForSubagent":
      case "session.sendToChild":
      case "session.listChildren":
        if (!current.subagent || request.params.parentSessionId !== current.sessionId) {
          return { allowed: false, reason: "parentSessionId 與此 token 綁定的 session 不符" };
        }
        return { allowed: true };
      case "profile.listForSubagent":
        if (!current.subagent) return { allowed: false, reason: "此 token 未授權 subagent 相關方法" };
        return { allowed: true };
      default:
        // 不應該發生——allowedMethods 只可能含上面列出的方法(見
        // computeAllowedMethods()),這裡 fail-closed 而非假設安全。
        return { allowed: false, reason: "未預期的方法" };
    }
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
      const detail = err instanceof Error ? err.message : String(err);
      this.send(socket, {
        kind: "response",
        id: requestId,
        ok: false,
        error: `無效的請求格式: ${detail}`,
        errorCode: ErrorCodes.GATEWAY_INVALID_REQUEST,
        errorParams: { detail },
      });
      return;
    }

    // S7:提前拿一次 state(供下面的認證閘門、LOCAL_ONLY_METHODS 檢查、
    // dispatch() 的 isLocal 參數共用同一份,不必各自重複 `this.clients.get()`)。
    const connState = this.clients.get(socket);

    // ---- Phase 2(ACP scoped MCP bridge token):scoped token 認證 --------
    // **必須排在 `this.authToken` 分流之前**,且同樣完全同步(不含任何
    // await,理由同下方既有認證閘門的註解)——見 `MCP_BRIDGE_TOKEN_PREFIX`
    // 的完整理由:一個帶 scoped bridge token 前綴的認證嘗試,不論
    // `DESKMONY_AUTH_TOKEN` 是否設定,都必須先在這裡被正確地核准/拒絕,絕不能
    // 落到下面「未設定 authToken → auth 一律直接成功」那條既有分支,意外把
    // 一個過期/被撤銷/偽造的 scoped token 升級成完整、無範圍限制的存取權。
    //
    // ⚠️ **這裡刻意不檢查 `!connState.authenticated`**(修正前有檢查,e2e
    // 步驟32b-e 決定性地抓到這是個安全漏洞,不是猜測)——`handleConnection()`
    // 把新連線的初始 `authenticated` 設成 `!needsAuth`(見該方法),也就是說
    // **未設定 `DESKMONY_AUTH_TOKEN`(本專案最常見的單機模式)時,每條連線一
    // 建立就已經是 `authenticated: true`**。若這裡沿用 `!connState.
    // authenticated` 當作進入條件,在這個(最常見的)部署模式下,scoped
    // bridge token 的 `auth` 請求永遠不會被導向這個區塊,而是直接落到下面
    // 「未設定 authToken → auth 一律直接成功」的既有分支——`connState.
    // scopedGrant` 永遠不會被設定,子行程對每個之後的 request 都會被當成一般
    // 全權限連線放行,完全繞過白名單/綁定範圍檢查。改成只看
    // `isMcpBridgeTokenCandidate()`(token 是否帶 scoped 前綴)判斷要不要進這
    // 個分支——不論這條連線目前的 `authenticated` 是原本就 `true`(無 master
    // token)還是 `false`(有 master token、尚未認證),只要送來的是一個
    // scoped bridge token,一律由這裡接管、覆寫成正確的 scoped 狀態(合法
    // token 收斂成 `scopedGrant` 限定範圍;不合法一律拒絕並關閉連線,不會
    // 意外繼承前面那個 `authenticated: true` 的全權限狀態)。
    if (connState && parsed.method === "auth" && this.isMcpBridgeTokenCandidate(parsed.params.token)) {
      const grant = this.matchScopedToken(parsed.params.token);
      if (grant) {
        connState.authenticated = true;
        connState.scopedGrant = grant;
        if (connState.authTimer) {
          clearTimeout(connState.authTimer);
          connState.authTimer = undefined;
        }
        this.send(socket, {
          kind: "response",
          id: parsed.id,
          ok: true,
          result: { ok: true, capabilities: this.buildCapabilities(connState.isLocal) },
        });
      } else {
        // 刻意**不**餵進 `this.authRateLimiter`——那個限流器以來源 IP 為 key,
        // 而 scoped bridge token 的連線幾乎必然來自 127.0.0.1(見
        // `resolveMcpBridgeConnectHost()`),與桌面 UI 等一般本機 client 共用
        // 同一個來源位址;若這裡也記錄失敗次數,一個行為異常(例如 token 過期
        // 後仍不斷重試)的子行程有機會連帶把同一台機器上其餘本機 client 的
        // 認證也一起鎖進冷卻期,形成自傷式 DoS。scoped token 本身是 256-bit
        // 隨機值,不像 master token 那樣需要靠 rate limiting 防禦線上暴力猜測。
        this.send(socket, {
          kind: "response",
          id: parsed.id,
          ok: false,
          error: "認證失敗:scoped token 不正確或已失效",
          errorCode: ErrorCodes.AUTH_INVALID_TOKEN,
        });
        socket.close(1008, "認證失敗");
      }
      return;
    }

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
            errorCode: ErrorCodes.AUTH_NOT_YET_AUTHENTICATED,
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
            errorCode: ErrorCodes.AUTH_RATE_LIMITED,
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
            errorCode: ErrorCodes.AUTH_INVALID_TOKEN,
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

    // ---- Phase 2(ACP scoped MCP bridge token):方法白名單 + 綁定範圍檢查 ----
    // 只影響用 scoped token 認證的連線(`connState.scopedGrant` 有值)——一般
    // client(master token 或無認證模式)完全不受影響,見
    // `checkScopedGrantAccess()` 的完整說明與拒絕理由分類。
    if (connState?.scopedGrant) {
      const access = this.checkScopedGrantAccess(connState.scopedGrant, parsed);
      if (!access.allowed) {
        console.warn(
          `[gateway][security] 拒絕 scoped bridge token(session=${connState.scopedGrant.sessionId})呼叫 "${parsed.method}": ${access.reason}`,
        );
        this.send(socket, {
          kind: "response",
          id: parsed.id,
          ok: false,
          error: `此 scoped token 無權呼叫 ${parsed.method}(${access.reason})`,
          errorCode: ErrorCodes.GATEWAY_SCOPED_TOKEN_FORBIDDEN,
          errorParams: { method: parsed.method },
        });
        return;
      }
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
        errorCode: ErrorCodes.GATEWAY_LOCAL_ONLY_METHOD,
        errorParams: { method: parsed.method },
      });
      return;
    }

    // ---- 2026-08-25 移除(見 docs/DECISIONS.md §G):原本這裡有一道獨立於
    // LOCAL_ONLY_METHODS 的擋——`permission.resolve` 帶 rememberRule 時遠端一律
    // 拒絕,當初是 S7 自行判斷選的保守方向。使用者這輪明確翻案「遠端可編輯
    // allowlist」之後,繼續擋這一條會變成「同一件事,從對話框順手記一條可以
    // (policy.addRule),從即時權限提示按『永遠允許』卻不行」的不一致——已經
    // 沒有理由存在,移除。escalate-strong 的 rememberRule 仍然一律被
    // SessionManager 端強制忽略(C4 紀律③,不因為這道擋移除而變寬,見
    // session-manager.ts 的 `resolvePermission()`)。

    try {
      const result = await this.dispatch(parsed, connState?.isLocal ?? false);
      this.send(socket, { kind: "response", id: parsed.id, ok: true, result });
    } catch (err) {
      this.send(socket, toErrorResponse(parsed.id, err));
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
      /**
       * Phase 2(ACP scoped MCP bridge token):`list_profiles` MCP 工具對應的
       * gateway 入口,見 packages/shared/src/gateway.ts 對應 case 的完整說明
       * ——只回傳決策需要的最小欄位,與 apps/core/src/index.ts 注入給
       * `ClaudeAgentSdkAdapter.setSubagentPort()` 的 `listProfiles` 回呼用
       * 同一份映射邏輯(維持兩個 adapter 看到的 `list_profiles` 結果一致)。
       */
      case "profile.listForSubagent": {
        const list = await this.profiles.list();
        return { profiles: list.map((p) => ({ id: p.id, name: p.name, software: p.software, model: p.model, role: p.role })) };
      }
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
      case "session.getSlashCommands":
        return this.sessionManager.getSlashCommands(request.params.sessionId);
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
       * async-scribbling-llama.md Phase 7:回覆一筆 AskUserQuestion 的待答問題。
       * 與上面的 `permission.resolve` 不同,`sessionId` 由 client 直接提供
       * (見 packages/shared/src/gateway.ts 對應 case 的完整說明——這裡不經過
       * `PermissionGateway`,沒有登記可反查),不需要 `LOCAL_ONLY_METHODS`/
       * rememberRule 那類遠端限制檢查。
       */
      case "dialog.resolve":
        this.sessionManager.resolveUserDialog(request.params.sessionId, request.params.requestId, request.params.result);
        return { ok: true };
      /**
       * S7 L4 §2:切換 session 的暫態權限模式(auto/YOLO)。**遠端一律拒絕**
       * ——已在 `handleMessage()` 的 `LOCAL_ONLY_METHODS` 檢查擋下,這裡不會
       * 收到遠端呼叫。
       */
      case "session.setPermissionMode": {
        const state = this.sessionManager.setSessionPermissionMode(request.params.sessionId, request.params.mode);
        return { mode: state.mode, yoloExpiresAt: state.yoloExpiresAt, trueUnrestricted: state.trueUnrestricted };
      }
      /**
       * 2026-08-25 新增(見 docs/DECISIONS.md §G):在 YOLO 之上疊加/解除
       * 「真.無限制」層。`isLocal` 只用來組出 `isRemote` 傳給
       * `SessionManager.setTrueUnrestricted()` 做稽核/通知內容,**不**用來
       * gate 是否放行這次呼叫——這個方法本機遠端一視同仁,見上方
       * `LOCAL_ONLY_METHODS` 的修訂註解。
       */
      case "session.setTrueUnrestricted": {
        const state = this.sessionManager.setTrueUnrestricted(request.params.sessionId, request.params.enabled, !isLocal);
        return { trueUnrestricted: state.trueUnrestricted ?? false };
      }
      /** 2026-08-25 新增:新增一條政策允許清單規則。見 gateway.ts 對應 case 的完整說明。 */
      case "policy.addRule":
        return { rule: this.sessionManager.addPolicyRule(request.params, !isLocal) };
      /** 2026-08-25 新增:依 id 刪除一條政策允許清單規則。 */
      case "policy.removeRule": {
        const removed = this.sessionManager.removePolicyRule(request.params.id, !isLocal);
        return { removed: removed !== undefined, rule: removed };
      }
      /** 2026-08-25 新增:讀取目前完整的政策允許清單(直接讀 in-memory,見
       *  gateway.ts 對應 case 說明「為什麼不能改讀 config.getEffective」)。 */
      case "policy.listRules":
        return { rules: this.sessionManager.listPolicyRules() };
      /**
       * S12(session-subagent):從 parent session spawn child subagent session。
       * child completed 時會自動透過 "child-result" push 回傳結果。
       */
      case "session.spawnChild":
        return { session: await this.sessionManager.spawnChild(request.params) };
      /**
       * Phase 2(ACP scoped MCP bridge token):`spawn_subagent` MCP 工具對應的
       * gateway 入口——見 packages/shared/src/gateway.ts 對應 case 的完整說明
       * (為何不是直接放行上面的 `session.spawnChild`:`agentProfileId` 語意
       * 不同)。呼叫 `spawnChildFromTool()`(而非 `spawnChild()`)取得「省略
       * agentProfileId 時沿用父 session 自己的 profile」這個既有的預設值解析
       * 邏輯,與 in-process 的 `subagent-mcp.ts` 走同一份實作。
       */
      case "session.spawnChildForSubagent":
        return await this.sessionManager.spawnChildFromTool(request.params);
      /**
       * Phase 2:`send_to_subagent` MCP 工具對應的 gateway 入口——薄薄一層
       * 委派給 `sendToChildFromTool()`(授權檢查——只能對呼叫端自己的直接子
       * session 送訊息——完整邏輯都在該方法,見其註解)。
       */
      case "session.sendToChild":
        await this.sessionManager.sendToChildFromTool(request.params);
        return { ok: true };
      /**
       * Phase 2:`list_subagents` MCP 工具對應的 gateway 入口。
       */
      case "session.listChildren":
        return { children: await this.sessionManager.listChildrenFromTool(request.params.parentSessionId) };
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
          throw new DeskmonyError(
            ErrorCodes.ENTITY_NOT_FOUND,
            { entityType: "task", id: request.params.taskId },
            `找不到任務: ${request.params.taskId}`,
          );
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
          throw new DeskmonyError(
            ErrorCodes.ENTITY_NOT_FOUND,
            { entityType: "workspace", id: request.params.workspaceId },
            `找不到 workspace: ${request.params.workspaceId}`,
          );
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

/**
 * i18n 專案新增:把 `dispatch()` 拋出的例外轉成 WS response——`DeskmonyError`
 * (見 packages/shared/src/errors.ts)帶有 `code`/`params`,原樣搬進
 * `errorCode`/`errorParams`(見 packages/shared/src/gateway.ts 的
 * `ServerResponseSchema` 對應欄位註解),讓前端可以查 `errors` namespace 翻譯;
 * 其餘未預期的例外(不是 `DeskmonyError`,例如真正的 bug 或第三方套件拋出的
 * 例外)維持原本只有純文字 `error` 的行為,不硬塞一個猜測的 code——查不到
 * code 時前端一律退回顯示這個 `error` 純文字訊息(見 error-i18n.ts)。
 */
function toErrorResponse(id: string, err: unknown): GatewayServerResponse {
  if (err instanceof DeskmonyError) {
    return { kind: "response", id, ok: false, error: err.message, errorCode: err.code, errorParams: err.params };
  }
  return { kind: "response", id, ok: false, error: err instanceof Error ? err.message : String(err) };
}
