import type { AuditLog } from "../enforcement/audit-log.js";
import type { Notifier } from "../enforcement/notifier.js";

/**
 * waiting-watchdog.ts(S3b:CostGovernor,見
 * docs/LAYER-4-detail-design/cost-governor_detail.md §4、HLD §4「正名」)。
 *
 * 掛起的 session **不燒錢、不佔算力**——止的不是金錢損失,而是「你以為它在
 * 跑、其實它卡死三天」的認知損失。拆成兩件語意不同的事:
 *
 *   T1 防遺忘(waiting 超過 6 小時) → **只發通知,不 halt**(這是提醒,不是
 *     熔斷,見 packages/shared/src/enforcement.ts 的
 *     `ReminderEnforcementEventSchema` 註解——不可借用 `trip` 的「已熔斷」
 *     措辭)。
 *   T2 資源回收(waiting 超過 72 小時) → **真 trip**:dispose 該 session 的
 *     子程序、釋放資源。**回收 ≠ 丟棄**——任務留 blocked、worktree 保留,人
 *     回來可續/棄(同 S6 復原視圖)。這裡的 halt 動作是 `dispose()`,不是
 *     `interrupt()`(掛起的 session 沒有正在跑的回合可以中斷,見 HLD §4「回收
 *     的是記憶體與子程序,不是金錢」)——不透過 `enforcement/trip.ts` 的
 *     `enforcementTrip()`(那個助手是為 `interrupt()` 語意設計的),這裡自己
 *     組 trip 事件。
 *
 * 這是 S7(auto-mode-and-yolo)/S11 定案「無人值守時 escalate 掛起等人、不逾時
 * deny」的唯一兜底——沒有它,那個象限會永遠懸著(見 HLD §4)。
 */

export interface WaitingSessionPort {
  /** 目前所有 `status === "waiting"` 的 session,含各自進入 waiting 的時間戳
   *  (epoch ms)。 */
  listWaitingSessions(): Array<{ sessionId: string; waitingSince: number }>;
  /** T2:真正回收子程序/資源(dispose adapter handle),但**保留** DB 裡的
   *  session/messages 記錄與任務/worktree(見上方檔案頂端「回收 ≠ 丟棄」)。 */
  reclaimSession(sessionId: string): Promise<void>;
}

/** §4:定時掃描間隔,每 10 分鐘。 */
const DEFAULT_SCAN_INTERVAL_MS = 10 * 60_000;
/** T1:6 小時。 */
const DEFAULT_T1_MS = 6 * 60 * 60_000;
/** T2:72 小時(遠長於 T1)。 */
const DEFAULT_T2_MS = 72 * 60 * 60_000;

export class WaitingWatchdog {
  private sessionControl: WaitingSessionPort | undefined;
  private readonly scanTimer: ReturnType<typeof setInterval>;
  /** 已經發過 T1 提醒的 sessionId——避免每 10 分鐘掃描一次就重複轟炸;離開
   *  waiting 狀態後會被清除(見 `scan()`),下次再進 waiting 又能重新提醒。 */
  private readonly notifiedT1 = new Set<string>();

  constructor(
    private readonly auditLog: AuditLog,
    private readonly notifier: Notifier,
    private readonly t1Ms = DEFAULT_T1_MS,
    private readonly t2Ms = DEFAULT_T2_MS,
    scanIntervalMs = DEFAULT_SCAN_INTERVAL_MS,
  ) {
    this.scanTimer = setInterval(() => void this.scan(), scanIntervalMs);
    this.scanTimer.unref?.();
  }

  /** apps/core/src/index.ts 在 SessionManager 建好之後回頭注入。 */
  setSessionControl(port: WaitingSessionPort): void {
    this.sessionControl = port;
  }

  /** 公開給定時器與 e2e 測試直接呼叫(不用真的等 10 分鐘)。 */
  async scan(): Promise<void> {
    if (!this.sessionControl) return;
    const now = Date.now();
    const waiting = this.sessionControl.listWaitingSessions();
    const stillWaitingIds = new Set(waiting.map((w) => w.sessionId));
    for (const sessionId of [...this.notifiedT1]) {
      if (!stillWaitingIds.has(sessionId)) this.notifiedT1.delete(sessionId);
    }

    for (const { sessionId, waitingSince } of waiting) {
      const waitedMs = now - waitingSince;
      if (waitedMs >= this.t2Ms) {
        await this.tripT2(sessionId);
        continue;
      }
      if (waitedMs >= this.t1Ms && !this.notifiedT1.has(sessionId)) {
        this.notifiedT1.add(sessionId);
        await this.notifyT1(sessionId);
      }
    }
  }

  private async notifyT1(sessionId: string): Promise<void> {
    const event = {
      kind: "reminder" as const,
      source: "cost" as const,
      reason: "waiting-ttl" as const,
      targetIds: [sessionId],
      ts: Date.now(),
    };
    this.auditLog.append(event);
    await this.notifier.deliver(event).catch((err) => {
      console.error(`[cost-governor] T1 防遺忘提醒送出失敗(不影響 session 本身): ${String(err)}`);
    });
  }

  private async tripT2(sessionId: string): Promise<void> {
    let reclaimed = true;
    try {
      await this.sessionControl!.reclaimSession(sessionId);
    } catch (err) {
      reclaimed = false;
      console.error(
        `[cost-governor] T2 回收 session ${sessionId} 失敗(仍會記錄 trip 稽核與通知,不假裝已回收): ${String(err)}`,
      );
    }
    this.notifiedT1.delete(sessionId);
    const event = {
      kind: "trip" as const,
      source: "cost" as const,
      // 回收失敗時附加後綴,理由同 enforcement/trip.ts 的 interrupt 逾時處理
      // ——不假裝已經回收成功,稽核 payload 要看得出來。
      reason: reclaimed ? "waiting-ttl" : "waiting-ttl-reclaim-failed",
      targetIds: [sessionId],
      ts: Date.now(),
    };
    this.auditLog.append(event);
    await this.notifier.deliver(event).catch((err) => {
      console.error(`[cost-governor] T2 trip 通知送出失敗: ${String(err)}`);
    });
  }

  dispose(): void {
    clearInterval(this.scanTimer);
  }
}
