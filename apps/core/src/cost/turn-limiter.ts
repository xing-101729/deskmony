import type { BudgetTurnConfig } from "@deskmony/shared";
import type { AuditLog } from "../enforcement/audit-log.js";
import type { Notifier } from "../enforcement/notifier.js";
import { enforcementTrip, type SessionControlPort } from "../enforcement/trip.js";

/**
 * turn-limiter.ts(S3b:CostGovernor 第三條斷路器,見
 * docs/LAYER-4-detail-design/cost-governor_detail.md §3、§0)。
 *
 * ⚠️ **這是這一輪的優先實作項目**——真實環境實測(見
 * docs/LAYER-4-detail-design/usage-metering_detail.md §7)發現「Claude Code
 * 經 ACP」完全不回報 usage(連 `used`/`size` 都沒有,不是設定問題,是
 * bridge 結構性缺口)。對這類後端,任何依賴 usage 的預算(任務/每日)都不會
 * 生效——**回合硬上限(時間 / 工具呼叫次數)是這類後端唯一的保護**,不依賴
 * `usage` 事件,只依賴 `tool-call` 事件(`AgentEvent` 的一等公民,所有 adapter
 * 都會發)與時間本身。
 *
 * ---- 語意 ----
 * 回合開始(sendPrompt / 收到第一個 event)→ 記 turnStartedAt、toolCalls=0
 * 每個 tool-call 事件 → toolCalls++;超過 maxToolCalls ⇒ trip + interrupt
 * 每 10 秒定時檢查一次 → now - turnStartedAt > maxDurationMs ⇒ trip + interrupt
 * 回合結束(completed / error,或 pty 判定靜止轉 idle)→ 清除這個 session 的
 * 回合狀態(見 apps/core/src/session/session-manager.ts 的呼叫點)。
 *
 * ---- 預設值(§3)----
 * 呼叫端(apps/core/src/index.ts)傳入 `config.budget.turn`,預設
 * `maxDurationMs = 30 分鐘`、`maxToolCalls = 200`——刻意寬鬆,這是**防失控**,
 * 不是防正常長任務;太緊會打斷合法工作,使用者失去信任就會直接關掉,那才是
 * 真正的失敗。
 *
 * ---- halt 粒度(HLD §3.3)----
 * 回合硬上限的觸發**一律立即 `interrupt()`**——與任務預算(只擋後續 prompt、
 * 不打斷已結束的回合)不同,見 cost-governor.ts 對這條區分的完整說明。
 */
export class TurnLimiter {
  private readonly turns = new Map<string, { startedAt: number; toolCalls: number; tripped: boolean }>();
  private readonly checkTimer: ReturnType<typeof setInterval>;
  private sessionControl: SessionControlPort | undefined;

  constructor(
    private readonly config: BudgetTurnConfig,
    private readonly auditLog: AuditLog,
    private readonly notifier: Notifier,
    /** e2e 測試用:定時檢查的間隔(預設 10 秒,見 §3)。不落地任何設定檔,
     *  比照既有 `DESKMONY_YOLO_DURATION_MS` 的既有慣例。 */
    checkIntervalMs = 10_000,
  ) {
    this.checkTimer = setInterval(() => this.checkDurations(), checkIntervalMs);
    this.checkTimer.unref?.();
  }

  /** apps/core/src/index.ts 在 SessionManager 建好之後回頭注入(打破建構子
   *  循環依賴,比照既有 `notifier.setSessionInfo()`/`sessionManager.setTeamBus()`
   *  的既有手法——`SessionManager` 的建構子需要 `TurnLimiter`,`TurnLimiter`
   *  觸發 trip 時又需要呼叫 `SessionManager.interrupt()`)。 */
  setSessionControl(port: SessionControlPort): void {
    this.sessionControl = port;
  }

  /** 回合開始:`SessionManager.sendPrompt()` 呼叫。 */
  startTurn(sessionId: string): void {
    this.turns.set(sessionId, { startedAt: Date.now(), toolCalls: 0, tripped: false });
  }

  /** 回合結束(completed/error,或 pty 靜止轉 idle):清除狀態,避免 Map 無限增長。 */
  endTurn(sessionId: string): void {
    this.turns.delete(sessionId);
  }

  /** 每次 `tool-call` 事件呼叫一次。 */
  recordToolCall(sessionId: string): void {
    const state = this.turns.get(sessionId);
    if (!state || state.tripped) return;
    state.toolCalls += 1;
    if (state.toolCalls > this.config.maxToolCalls) {
      state.tripped = true;
      void this.trip(sessionId);
    }
  }

  private checkDurations(): void {
    const now = Date.now();
    for (const [sessionId, state] of this.turns) {
      if (state.tripped) continue;
      if (now - state.startedAt > this.config.maxDurationMs) {
        state.tripped = true;
        void this.trip(sessionId);
      }
    }
  }

  private async trip(sessionId: string): Promise<void> {
    await enforcementTrip({
      source: "cost",
      reason: "turn-limit",
      targetIds: [sessionId],
      auditLog: this.auditLog,
      notifier: this.notifier,
      interrupt: true,
      sessionControl: this.sessionControl,
    });
  }

  /** core 關閉時清理計時器(主要給 e2e 測試乾淨結束用)。 */
  dispose(): void {
    clearInterval(this.checkTimer);
  }
}
