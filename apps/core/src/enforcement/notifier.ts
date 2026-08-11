import { EventEmitter } from "node:events";
import {
  NotificationTripReasonSchema,
  type EnforcementEvent,
  type EnforcementNotificationPush,
  type NotificationConfig,
  type NotificationTripReason,
} from "@deskmony/shared";
import type { AuditLog } from "./audit-log.js";

/**
 * notifier.ts(S1 Enforcement 底座,見 policy-engine_detail.md §5)。
 *
 * `Notifier` 是「把事件送達人類」的介面——真正的送達管道(系統通知/webhook/
 * push,見 docs/LAYER-3-hld/notification_hld.md)由 **S11** 實作。S1 這輪只給
 * 一個 `ConsoleNotifier` stub,讓 S1 不被 S11 阻塞(可以獨立上線),之後只需要
 * 把注入的 `Notifier` 實例換成 S11 的實作,呼叫端(session-manager.ts)完全
 * 不用改。
 *
 * ---- S11 這輪:`RealNotifier` ----
 * 見 docs/LAYER-4-detail-design/notification_detail.md 的完整規格。這裡只
 * 摘要實作要點(逐項對照 §7 檢查清單):
 *   - §3 批次:escalate 事件第一筆立即送(agent 剛卡住,是最該即時的訊號),
 *     之後的批次視窗內累積的請求在 `batchIntervalMinutes` 後彙總成一則。
 *     trip 永遠立即送、不進佇列、不去重、不受 quietHours 限制。
 *   - §4 內容最小化:`buildPayload()` 只組裝 session 顯示名/工具名/筆數/
 *     事件種類/(trip 的)原因分類,**絕不**放入指令字串/檔案路徑/檔案內容/
 *     agent 輸出/config 值——這條邊界由呼叫端傳入的 `EnforcementEvent` 形狀
 *     本身保證(該型別完全沒有這些欄位,見 packages/shared/src/enforcement.ts),
 *     這裡再次強調:新增欄位時務必維持。
 *   - §4.2 webhook 絕不是授權通道:這裡只送資訊性 payload,不附任何「允許」
 *     動作連結/callback,見 `buildPayload()` 完全沒有這類欄位。
 *   - §8 fire-and-forget:`deliver()` 對 escalate 只同步做「入佇列或立即送」
 *     這一步,批次計時器與 webhook 送出都是背景執行,`deliver()` 本身
 *     幾乎立即 resolve,呼叫端(session-manager.ts)也刻意不 await 其結果
 *     (`void this.notifier.deliver(...).catch(...)`)。
 */
export interface Notifier {
  deliver(event: EnforcementEvent): Promise<void>;
}

/** S1 階段的 stub:只 console.log,不接任何真實送達管道。保留給測試/未設定
 *  通知管道時使用。 */
export class ConsoleNotifier implements Notifier {
  async deliver(event: EnforcementEvent): Promise<void> {
    console.log(
      `[enforcement] ${event.kind} 事件(尚未接上真實通知管道,S11 才會實作真正的 Notifier): ${JSON.stringify(event)}`,
    );
  }
}

/**
 * `RealNotifier` 需要把 `sessionId` 換成人類可讀的顯示名(§4 的
 * `sessionNames`)。用最小介面注入,避免直接依賴 `SessionManager` 型別、
 * 製造循環 import(`SessionManager` 建構子本身就需要 `Notifier`)——
 * `apps/core/src/index.ts` 在 `SessionManager` 建好之後用 `setSessionInfo()`
 * 事後注入,比照既有 `setTeamBus()`/`setClientPresence()` 的解耦手法(見
 * session-manager.ts 對應方法註解)。
 */
export interface SessionInfoPort {
  /** 找不到(例如 session 已刪除)回傳 `undefined`——呼叫端退回顯示 sessionId 本身。 */
  getSessionTitle(sessionId: string): Promise<string | undefined>;
}

const MAX_SESSION_NAMES_SHOWN = 3;
const MAX_TOOL_NAMES_SHOWN = 3;

/** 一筆還在等待批次彙總的 escalate 請求。 */
interface PendingEscalation {
  sessionId: string;
  toolName: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 陣列超過 `max` 筆時,只保留前 `max` 筆 + 一個「等 N 個」的摘要字串(見
 *  notification_detail.md §4:「涉及的 session 顯示名(最多 3 個,超過用
 *  『等 N 個』)」)。 */
function truncateWithCount(items: string[], max: number): string[] {
  if (items.length <= max) return items;
  return [...items.slice(0, max), `等 ${items.length - max} 個`];
}

/** "HH:mm" → 當日分鐘數。 */
function parseHHmm(value: string): number {
  const [h, m] = value.split(":").map((part) => Number(part));
  return (h || 0) * 60 + (m || 0);
}

/** 靜音時段判定,支援跨午夜(from > to,例如 23:00 → 07:00)。匯出成獨立的
 *  純函式,方便 e2e/單元測試直接餵 `now` 驗證邊界,不需要真的等到那個時間。 */
export function isWithinQuietHours(now: Date, quietHours: { from: string; to: string } | undefined): boolean {
  if (!quietHours) return false;
  const fromMin = parseHHmm(quietHours.from);
  const toMin = parseHHmm(quietHours.to);
  const nowMin = now.getHours() * 60 + now.getMinutes();
  if (fromMin < toMin) {
    return nowMin >= fromMin && nowMin < toMin;
  }
  // 跨午夜(或 from === to,視為全天靜音——一個會不斷回到自己的 24h 窗口)。
  return nowMin >= fromMin || nowMin < toMin;
}

/** 距離目前這段靜音時段結束(`quietHours.to`)還有多少毫秒——用來精準排程
 *  「靜音期滿後補送彙總」的計時器,而不是每隔幾秒輪詢一次。 */
export function msUntilQuietHoursEnd(now: Date, quietHours: { from: string; to: string }): number {
  const [toH, toM] = quietHours.to.split(":").map((part) => Number(part));
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), toH || 0, toM || 0, 0, 0);
  if (end.getTime() <= now.getTime()) {
    end.setDate(end.getDate() + 1);
  }
  return end.getTime() - now.getTime();
}

/** `NotificationTripReason` 的其中一種,對照 notification_detail.md §4「trip
 *  例外」的分類文案。 */
const TRIP_REASON_TO_SOURCE_FALLBACK: Record<"cost" | "message", NotificationTripReason> = {
  cost: "daily-limit",
  message: "message-budget",
};

export interface RealNotifierOptions {
  /**
   * e2e 測試用的覆寫(毫秒)——比照 `SessionManager` 的
   * `DESKMONY_YOLO_DURATION_MS` 既有慣例,純粹讓 e2e 能在合理時間內驗證
   * 「批次視窗到期後彙總送出」,不落地任何設定檔,不是使用者可調整的偏好
   * (見 apps/core/src/index.ts 的 `DESKMONY_NOTIFICATION_BATCH_INTERVAL_MS`)。
   * 未提供時使用 `config.batchIntervalMinutes * 60_000`。
   */
  batchIntervalMsOverride?: number;
  /** 單元測試/e2e 注入假的 fetch,不依賴真實網路,也不用真的等 5 秒逾時。 */
  fetchImpl?: typeof fetch;
  /** 深連結用的 http base(§4.1),例如 `http://127.0.0.1:4317`。省略時
   *  `link` 只給相對路徑(`/#/session/<id>`)。 */
  linkBase?: string;
}

/**
 * S11 的真正實作——見檔案頂端摘要與 notification_detail.md 完整規格。
 */
export class RealNotifier extends EventEmitter implements Notifier {
  private sessionInfo: SessionInfoPort | undefined;
  /**
   * 批次佇列,key = `${sessionId}::${requestId}`——**不能只用 requestId**:
   * 不同 adapter 連線(每個 session 各自獨立的 ACP/pty 子程序)各自維護自己
   * 的請求編號,`requestId` 只保證在**同一個 session** 內唯一,跨 session 完全
   * 可能重複(實測驗證:兩個不同 session 的第一筆權限請求都拿到同一個
   * `requestId`)。組合鍵才是真正的唯一去重鍵——防禦性去重(同一筆
   * `(sessionId, requestId)` 理論上不會重複送達,但若真的發生,覆寫而不是
   * 重複計數)。同一 session 對同一種工具的**不同** requestId 不去重,各自
   * 計入筆數(對照 notification_detail.md §4 的範例「Bash ×2」——不同的
   * requestId 是不同的真實待決請求,不應該被消音)。
   */
  private pending = new Map<string, PendingEscalation>();
  private batchTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly batchIntervalMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly linkBase: string;

  constructor(
    private readonly config: NotificationConfig,
    private readonly auditLog: AuditLog,
    opts: RealNotifierOptions = {},
  ) {
    super();
    this.batchIntervalMs = opts.batchIntervalMsOverride ?? config.batchIntervalMinutes * 60_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.linkBase = opts.linkBase ?? "";
  }

  /** 見上方 `SessionInfoPort` 註解:`apps/core/src/index.ts` 在 `SessionManager`
   *  建好之後回頭注入。 */
  setSessionInfo(port: SessionInfoPort): void {
    this.sessionInfo = port;
  }

  async deliver(event: EnforcementEvent): Promise<void> {
    if (event.kind === "decision") return; // 自動放行/拒絕不通知,只有升級/熔斷才通知人類。
    if (event.kind === "trip") {
      // §3:trip 必送、不節流、不併批、不受靜音限制——直接組 payload 送出,
      // 不經過下面 escalate 的佇列/批次邏輯。這裡對每個 targetId 各記一筆,
      // 讓 `count`/`sessionNames` 反映實際受影響的 session 數。
      const items = event.targetIds.map((sessionId) => ({ sessionId }));
      const payload = await this.buildPayload("trip", items, {
        tripReason: this.classifyTripReason(event.reason, event.source),
      });
      this.sendNow(payload);
      return;
    }
    if (event.kind === "task-review") {
      // S5(dispose-gate)新增:任務完成判定等待人類核可(見
      // packages/shared/src/enforcement.ts 的 `TaskReviewEnforcementEventSchema`
      // 頂端註解)。比照 trip/reminder:必送、不進批次佇列——同一個任務同時
      // 只會卡在這裡一次(task-service.ts 的 `awaitingHumanReview` 是單一
      // boolean,重複觸發會被 applyHumanReviewGate() 擋下,不會出現「短時間
      // 大量升級」需要批次彙總的洪水問題),批次化只會拖慢人類發現的時間。
      // 對外沿用既有的 "escalation" payload kind(語意上就是等待核可),不
      // 擴充 `EnforcementNotificationPushSchema`——用任務標題頂替 session
      // 顯示名(`sessionNames`),`toolNames` 借來放一句簡短的原因描述。
      const payload = await this.buildTaskReviewPayload(event);
      this.sendNow(payload);
      return;
    }
    if (event.kind === "reminder") {
      // S3b(cost-governor):比照 trip 必送、不節流、不受靜音限制——不論是
      // T1「防遺忘」或預算軟警告,都是「讓你即時知道」的提醒,若被靜音時段
      // 吃掉或延到批次視窗才送,反而違背它存在的理由。**但語意上不是 halt**,
      // `buildPayload("reminder", ...)` 不會產生 `tripReason`(見
      // packages/shared/src/notification.ts 的 `formatEnforcementNotificationText()`
      // 已為 "reminder" 開獨立分支,不會顯示「已熔斷」字樣)。
      const items = event.targetIds.map((sessionId) => ({ sessionId }));
      const payload = await this.buildPayload("reminder", items, { reminderReason: event.reason });
      this.sendNow(payload);
      return;
    }
    // escalation
    await this.handleEscalation(`${event.sessionId}::${event.requestId}`, {
      sessionId: event.sessionId,
      toolName: event.toolName,
    });
  }

  /**
   * §3 的核心狀態機:
   *   - 佇列目前是空的、且沒有正在跑的批次計時器 ⇒ 這是「新一輪卡住」的第一筆
   *     ⇒ 立即送(除非正在靜音時段,見下方),並啟動批次計時器開始接收後續
   *     請求。
   *   - 否則(已經在批次視窗內,或正在靜音時段)⇒ 只入佇列,等計時器到期
   *     (或靜音時段結束)一次彙總送出。
   *
   * `deliver()` 會等到「桌面通知事件已經 emit」才 resolve(這裡回傳的
   * promise 一路等到 `sendNow()` 呼叫完成),呼叫端(session-manager.ts)仍然
   * 刻意不 await `deliver()` 的回傳值,所以這不會拖慢權限決策路徑。真正
   * 「不 await」的是 `sendNow()` 內部的 webhook 送出(`postWebhook()`,見該
   * 方法),那才是會真的碰網路、可能慢/失敗的部分。
   *
   * **並行安全**:判斷「這是不是新一輪的第一筆」與「鎖定這一輪已經開始」
   * (呼叫 `scheduleBatchFlush()`)必須在同一個同步區塊內完成、不能跨
   * `await` ——`buildPayload()` 內部會 `await` session 顯示名查詢,若把
   * `scheduleBatchFlush()` 放在那之後,兩筆幾乎同時抵達的 escalate(不同
   * session)有機會都在對方的 await 恢復前讀到「佇列空、沒有計時器」,誤判
   * 成两筆都是「第一筆」而各自立即送出。這裡把 `scheduleBatchFlush()` 提前
   * 到任何 `await` 之前呼叫,第二筆到達時一定能看到 `batchTimer` 已經非空。
   */
  private handleEscalation(dedupeKey: string, item: PendingEscalation): Promise<void> {
    const now = new Date();
    const cycleStarting = this.pending.size === 0 && !this.batchTimer;
    if (cycleStarting && !isWithinQuietHours(now, this.config.quietHours)) {
      this.scheduleBatchFlush(this.batchIntervalMs);
      return this.buildPayload("escalation", [item]).then((payload) => this.sendNow(payload));
    }
    this.pending.set(dedupeKey, item);
    if (!this.batchTimer) {
      const delay = isWithinQuietHours(now, this.config.quietHours)
        ? msUntilQuietHoursEnd(now, this.config.quietHours!)
        : this.batchIntervalMs;
      this.scheduleBatchFlush(delay);
    }
    return Promise.resolve();
  }

  private scheduleBatchFlush(delayMs: number): void {
    const timer = setTimeout(() => void this.flush(), delayMs);
    timer.unref?.();
    this.batchTimer = timer;
  }

  private async flush(): Promise<void> {
    this.batchTimer = undefined;
    if (this.pending.size === 0) return;
    const now = new Date();
    if (isWithinQuietHours(now, this.config.quietHours)) {
      // 理論上不該發生(進佇列時已經算好精準的到期時間),保險起見仍檢查一次
      // 再重排,避免時鐘/計時器誤差讓通知在靜音時段內漏出去。
      this.scheduleBatchFlush(msUntilQuietHoursEnd(now, this.config.quietHours!));
      return;
    }
    const items = [...this.pending.values()];
    this.pending.clear();
    const payload = await this.buildPayload("escalation", items);
    this.sendNow(payload);
  }

  /** 組裝 §4 的最小化 payload——只有元資料(session 顯示名/工具名/筆數/種類/
   *  trip 原因分類),見檔案頂端「內容最小化」說明。 */
  private async buildPayload(
    kind: "escalation" | "trip" | "reminder",
    items: Array<{ sessionId: string; toolName?: string }>,
    opts: { tripReason?: NotificationTripReason; reminderReason?: "waiting-ttl" | "budget-warning" } = {},
  ): Promise<EnforcementNotificationPush> {
    const distinctSessionIds = [...new Set(items.map((i) => i.sessionId))];
    const names = await this.resolveSessionNames(distinctSessionIds);
    const toolNamesRaw =
      kind === "escalation" ? [...new Set(items.map((i) => i.toolName).filter((t): t is string => Boolean(t)))] : [];
    // §4.1:批次涉及**恰好一個** session 時才給桌面深連結用的 sessionId/精準
    // link;涉及多個 session 時保守退化(不猜測要聚焦哪一個,見 notifier.ts
    // 頂端「S11 判斷/猜測」相關報告說明)。
    const singleSessionId = distinctSessionIds.length === 1 ? distinctSessionIds[0] : undefined;
    return {
      kind,
      count: items.length,
      sessionNames: truncateWithCount(names, MAX_SESSION_NAMES_SHOWN),
      toolNames: truncateWithCount(toolNamesRaw, MAX_TOOL_NAMES_SHOWN),
      tripReason: opts.tripReason,
      reminderReason: opts.reminderReason,
      ts: Date.now(),
      link: singleSessionId
        ? `${this.linkBase}/#/session/${singleSessionId}`
        : this.linkBase
          ? `${this.linkBase}/#/`
          : "",
      sessionId: singleSessionId,
    };
  }

  /**
   * S5(dispose-gate)新增:見上方 `deliver()` 內 "task-review" 分支的說明——
   * 獨立於 `buildPayload()` 之外,因為這裡沒有 session 可查(不呼叫
   * `resolveSessionNames()`),直接用呼叫端給的 `taskTitle` 當顯示名。
   */
  private async buildTaskReviewPayload(event: {
    taskId: string;
    taskTitle: string;
    reason: "no-acceptance" | "acceptance-failure-streak";
    ts: number;
  }): Promise<EnforcementNotificationPush> {
    return {
      kind: "escalation",
      count: 1,
      sessionNames: [event.taskTitle],
      toolNames: [event.reason === "acceptance-failure-streak" ? "驗收連續失敗" : "任務驗收核可"],
      ts: event.ts,
      link: this.linkBase ? `${this.linkBase}/#/` : "",
    };
  }

  private async resolveSessionNames(sessionIds: string[]): Promise<string[]> {
    const names: string[] = [];
    for (const id of sessionIds) {
      const title = this.sessionInfo ? await this.sessionInfo.getSessionTitle(id).catch(() => undefined) : undefined;
      names.push(title ?? id);
    }
    return names;
  }

  /**
   * `TripEnforcementEvent.reason`(見 packages/shared/src/enforcement.ts)目前
   * 是自由文字——S3b(成本熔斷)尚未實作,還沒有任何呼叫端真的產生 trip 事件,
   * 這個欄位的實際內容還沒有被那個生產端收斂成固定分類。保守做法:只有
   * `reason` 剛好完全等於四個已知分類字面值之一時才直接採用;否則不信任
   * 這個自由字串(可能夾帶未來才會出現、我們無法預期的內容),改用同樣安全
   * 的 `source`("cost"/"message",這兩個值本身是 schema 定義的封閉列舉,
   * 不是自由文字)概略對應到最接近的分類。
   */
  private classifyTripReason(reason: string, source: "cost" | "message"): NotificationTripReason | undefined {
    const parsed = NotificationTripReasonSchema.safeParse(reason);
    if (parsed.success) return parsed.data;
    return TRIP_REASON_TO_SOURCE_FALLBACK[source];
  }

  /** 送出這一則通知——兩條通道各自獨立判斷是否要送,兩者互不影響、互不等待
   *  對方結果。§8:這個方法本身不 await webhook 送出完成,呼叫端(`deliver()`/
   *  `flush()`)也不 await 這個方法。 */
  private sendNow(payload: EnforcementNotificationPush): void {
    if (this.config.desktop.enabled) {
      // 由 WsGateway 監聽這個事件並廣播給所有已認證的 client(見
      // apps/core/src/gateway/ws-gateway.ts 建構子)——headless core 沒有
      // client 連線時,`emit()` 沒有任何監聽者,是安全的 no-op。
      this.emit("enforcement-notification", payload);
    }
    if (this.shouldSendWebhook(payload)) {
      void this.postWebhook(payload);
    }
  }

  private shouldSendWebhook(payload: EnforcementNotificationPush): boolean {
    if (!this.config.webhook.enabled) return false;
    if (!this.config.webhook.url) return false;
    // minSeverity="trip":escalate 完全不送 webhook,只留桌面通知。
    if (this.config.webhook.minSeverity === "trip" && payload.kind !== "trip") return false;
    return true;
  }

  /**
   * §2.2/§6:逾時 5 秒;失敗最多重試 2 次(指數退避 1s/2s),之後放棄並記
   * audit「未送達」。**不影響任何權限決策**——這個方法整段都是背景執行,
   * `sendNow()`/`deliver()` 都不 await 它。
   */
  private async postWebhook(payload: EnforcementNotificationPush): Promise<void> {
    const body = JSON.stringify(payload);
    const backoffMs = [0, 1_000, 2_000]; // 共 3 次嘗試(1 次原始 + 2 次重試)。
    let lastErr: unknown;
    for (const delay of backoffMs) {
      if (delay > 0) await sleep(delay);
      const controller = new AbortController();
      const timeoutTimer = setTimeout(() => controller.abort(), 5_000);
      try {
        const res = await this.fetchImpl(this.config.webhook.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`http-${res.status}`);
        return;
      } catch (err) {
        lastErr = err;
      } finally {
        clearTimeout(timeoutTimer);
      }
    }
    const reason = lastErr instanceof Error ? lastErr.message : String(lastErr);
    console.error(`[enforcement] webhook 送達失敗(重試 ${backoffMs.length - 1} 次後放棄,不影響任何權限決策): ${reason}`);
    this.auditLog.appendNotificationFailure({
      channel: "webhook",
      sessionId: payload.sessionId,
      reason,
      ts: Date.now(),
    });
  }
}
