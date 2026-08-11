import type { EnforcementEvent } from "@deskmony/shared";
import type { AuditLog } from "./audit-log.js";
import type { Notifier } from "./notifier.js";

/**
 * trip.ts(S3b:CostGovernor 新增,見
 * docs/LAYER-4-detail-design/cost-governor_detail.md §5)。
 *
 * S1 把三斷路器的共用底座拆成「`AuditLog`/`Notifier`」+ `EnforcementEvent`
 * schema(見 packages/shared/src/enforcement.ts 頂端說明),但「trip 的完整
 * 流程」(必要時 interrupt → 記 audit → 通知)本身還沒有共用實作——S1 階段
 * 完全沒有 trip 的生產端。S3b 是第一個真正產生 `trip` 事件的模組
 * (`TurnLimiter`/`CostGovernor`/`WaitingWatchdog` 三個都要用到),把這段邏輯
 * 抽成這裡的 `enforcementTrip()`,避免三個模組各自重複實作「interrupt 逾時
 * 怎麼辦」這種容易漏掉的細節。
 *
 * ---- `interrupt()` 必須 await,逾時不假裝已停 ----
 * L4 §2:「`interrupt()` 回傳 Promise 且語意是『中斷確實生效才 resolve』
 * (見 packages/adapters/src/types.ts 註解)。S3b 必須 await 再標記 halt
 * 完成;逾時無回應要記 audit + 最高等級通知,**不假裝已停**。」
 *
 * 但 `AgentAdapter.interrupt()` 本身**沒有內建逾時**——它的介面契約只保證
 * 「resolve 就代表確實停了」,沒有保證「一定會在合理時間內 resolve」(ACP/PTY
 * 的實作本身就承認「沒有確認生效的回條,只能盡力而為」,見該介面註解)。萬一
 * 底層卡死(例如 adapter 子程序沒回應),不加保護的 `await` 會讓這整個 trip
 * 流程永遠掛住,連 audit 都來不及記。這裡用 `interruptWithTimeout()` 包一層
 * 逾時保護——逾時視為「未確認已停」,仍然照常記 audit + 送通知,只是把這個
 * 事實(是否確認生效)寫進 `reason` 欄位讓稽核看得到,**不偷偷假裝一切正常**。
 */

export interface SessionControlPort {
  /** 中斷指定 session 目前回合;語意見上方檔案頂端說明。 */
  interrupt(sessionId: string): Promise<void>;
}

const DEFAULT_INTERRUPT_TIMEOUT_MS = 10_000;

async function interruptWithTimeout(port: SessionControlPort, sessionId: string, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
    timer.unref?.();
  });
  try {
    const outcome = await Promise.race([port.interrupt(sessionId).then(() => "ok" as const), timeout]);
    return outcome === "ok";
  } catch (err) {
    console.error(`[enforcement] interrupt(${sessionId}) 失敗(不假裝已停): ${String(err)}`);
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface EnforcementTripInput {
  source: "cost" | "message";
  /** 應為 `NotificationTripReasonSchema` 的其中一個值(見
   *  packages/shared/src/notification.ts),不在清單內的自由字串仍會被記錄,
   *  只是 `RealNotifier` 顯示時會退回較不精準的 `source` 分類文字。 */
  reason: string;
  targetIds: string[];
  auditLog: AuditLog;
  notifier: Notifier;
  /**
   * 這次 trip 是否需要真的 interrupt(HLD §3.3「halt 粒度與急迫性相稱」):
   *   - `true`:回合硬上限/mid-turn 成本熔斷/每日 kill-switch——立即中斷。
   *   - `false`:任務預算(回合邊界才發現)——只擋後續 prompt,不打斷已結束
   *     的回合,這裡完全不呼叫 `sessionControl.interrupt()`。
   */
  interrupt: boolean;
  sessionControl?: SessionControlPort;
  interruptTimeoutMs?: number;
}

/**
 * S3b 共用的 trip 流程(§5):
 *   (需要 interrupt 時)await adapter.interrupt() → auditLog.append() →
 *   notifier.deliver()。
 *
 * 呼叫端(TurnLimiter/CostGovernor/WaitingWatchdog)只需要決定「要不要
 * interrupt」與「targetIds 是誰」,不需要各自處理逾時/稽核/通知的細節。
 */
export async function enforcementTrip(input: EnforcementTripInput): Promise<void> {
  const ts = Date.now();
  let allConfirmed = true;

  if (input.interrupt) {
    if (!input.sessionControl) {
      allConfirmed = false;
      console.error(
        `[enforcement] trip(reason=${input.reason}) 需要 interrupt,但尚未注入 SessionControlPort,` +
          `無法確認已停止: ${input.targetIds.join(", ")}`,
      );
    } else {
      const results = await Promise.all(
        input.targetIds.map((sessionId) =>
          interruptWithTimeout(input.sessionControl!, sessionId, input.interruptTimeoutMs ?? DEFAULT_INTERRUPT_TIMEOUT_MS),
        ),
      );
      allConfirmed = results.every(Boolean);
    }
  }

  const event: EnforcementEvent = {
    kind: "trip",
    source: input.source,
    // 逾時/失敗時附加後綴,讓稽核 payload 裡看得到「這次沒能確認真的停了」,
    // 不偷偷假裝一切正常(見檔案頂端說明)。刻意不影響 `RealNotifier` 的
    // `classifyTripReason()` 判斷(該函式對非完全相等的字串會退回 source 分類,
    // 使用者仍會收到一則通知,只是分類文字比較籠統——比完全不通知安全)。
    reason: allConfirmed ? input.reason : `${input.reason}-interrupt-unconfirmed`,
    targetIds: input.targetIds,
    ts,
  };
  input.auditLog.append(event);
  await input.notifier.deliver(event).catch((err) => {
    console.error(`[enforcement] notifier.deliver(trip) 失敗(不影響 interrupt/audit 已完成): ${String(err)}`);
  });
}
