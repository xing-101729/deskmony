import { randomUUID } from "node:crypto";
import type { NexusDb } from "@deskmony/db";
import { enforcementAudit as enforcementAuditTable } from "@deskmony/db";
import type { EnforcementEvent } from "@deskmony/shared";

/**
 * audit-log.ts(S1 Enforcement 底座,見 policy-engine_detail.md §5/§5.1)。
 *
 * `AuditLog` 是三斷路器(權限/訊息/成本)共用底座的一部分——append-only,只
 * INSERT,永不 UPDATE/DELETE,對應 `enforcement_audit` 表(見
 * packages/db/src/schema.ts)。**權限決策一律落地,含自動放行**,這是安全
 * 稽核的最低要求(DECISIONS.md D5),不因為「這次是自動放行、沒有人介入」
 * 而省略。
 */
/**
 * S11(Notification)新增:webhook 送達失敗(重試後仍失敗)時記一筆稽核(見
 * notification_detail.md §6 失敗模式表「webhook 送出失敗 → 有限重試後放棄 +
 * audit『未送達』」)。獨立於上面的 `append(EnforcementEvent)`——「送達失敗」
 * 本身不是三斷路器的一次新決策/升級/熔斷事件,硬塞進 `EnforcementEventSchema`
 * 的 kind 判別聯集會混淆「事件本體」與「這個事件的送達結果」兩個不同概念,
 * 也會牽動 `EnforcementEventSchema` 這個三斷路器共用型別(S2/S3b 都依賴它的
 * 判別聯集做窮盡性檢查),不是這輪該做的架構變動。DB 的 `enforcement_audit.kind`
 * 欄位本身是自由文字(見 packages/db/src/schema.ts,沒有 CHECK 限制),這裡
 * 沿用同一張表、同一種落地方式,只是 kind 用字面值 "notification-failed"。
 */
export interface NotificationFailureDetail {
  channel: "webhook";
  sessionId?: string;
  /** 粗分類的失敗原因(例如 "timeout"、"http-500"),**不含**回應本文/URL
   *  本身——遮罩/最小化紀律與 notification 的內容最小化規則一致。 */
  reason: string;
  ts: number;
}

/**
 * S6(crash-recovery)新增:啟動對帳結果(見 crash-recovery_detail.md §6.3
 * 「沿用 S11 新增的 `kind: "notification-failed"` 那種『非 EnforcementEvent
 * union』的作風,新增 `kind: "recovery-reconcile"`」)。獨立於
 * `append(EnforcementEvent)`——對帳不是三斷路器(權限/訊息/成本)的一次決策/
 * 升級/熔斷事件,理由與 `NotificationFailureDetail` 完全相同,不重複贅述。
 */
export interface RecoveryReconcileDetail {
  count: number;
  sessionIds: string[];
  ts: number;
}

export interface AuditLog {
  append(event: EnforcementEvent): void;
  /** S11 新增,見上方 `NotificationFailureDetail` 註解。 */
  appendNotificationFailure(detail: NotificationFailureDetail): void;
  /** S6 新增,見上方 `RecoveryReconcileDetail` 註解。 */
  appendRecoveryReconcile(detail: RecoveryReconcileDetail): void;
}

/** 落地到 SQLite 的 `enforcement_audit` 表。 */
export class SqliteAuditLog implements AuditLog {
  constructor(private readonly db: NexusDb) {}

  append(event: EnforcementEvent): void {
    const common = commonColumnsFor(event);
    try {
      // better-sqlite3 是同步驅動,`.run()` 立即完成——這裡刻意不 await:
      // `AuditLog.append()` 介面是同步 `void`(見上方介面定義),稽核落地不應該
      // 讓 decide() 之後的自動放行/拒絕路徑多一個 await 節點而變慢或引入額外
      // 的 race window。稽核寫入失敗(理論上只會是磁碟/DB 層級的意外)一律
      // 吞下並印警告,**不讓它反過來影響已經做出的權限決策**——decide() 的
      // 結果在呼叫 append() 之前就已經確定,稽核只是「記錄」,不是「把關」。
      void this.db
        .insert(enforcementAuditTable)
        .values({
          id: randomUUID(),
          ts: event.ts,
          kind: event.kind,
          sessionId: common.sessionId ?? null,
          requestId: common.requestId ?? null,
          toolName: common.toolName ?? null,
          effect: common.effect ?? null,
          reason: common.reason ?? null,
          payload: JSON.stringify(event),
        })
        .run();
    } catch (err) {
      console.error(`[enforcement] 稽核落地失敗(不影響已做出的權限決策,僅遺失這筆稽核紀錄): ${String(err)}`);
    }
  }

  appendNotificationFailure(detail: NotificationFailureDetail): void {
    try {
      void this.db
        .insert(enforcementAuditTable)
        .values({
          id: randomUUID(),
          ts: detail.ts,
          kind: "notification-failed",
          sessionId: detail.sessionId ?? null,
          requestId: null,
          toolName: null,
          effect: null,
          reason: detail.reason,
          payload: JSON.stringify(detail),
        })
        .run();
    } catch (err) {
      console.error(`[enforcement] 「通知未送達」稽核落地失敗(不影響任何權限決策): ${String(err)}`);
    }
  }

  appendRecoveryReconcile(detail: RecoveryReconcileDetail): void {
    try {
      void this.db
        .insert(enforcementAuditTable)
        .values({
          id: randomUUID(),
          ts: detail.ts,
          kind: "recovery-reconcile",
          sessionId: null,
          requestId: null,
          toolName: null,
          effect: null,
          reason: `啟動對帳:標記 ${detail.count} 個中斷 session`,
          payload: JSON.stringify(detail),
        })
        .run();
    } catch (err) {
      console.error(`[recovery] 啟動對帳稽核落地失敗(不影響對帳本身已完成的標記): ${String(err)}`);
    }
  }
}

function commonColumnsFor(event: EnforcementEvent): {
  sessionId?: string;
  requestId?: string;
  toolName?: string;
  effect?: string;
  reason?: string;
} {
  switch (event.kind) {
    case "decision":
      return {
        sessionId: event.sessionId,
        requestId: event.requestId,
        toolName: event.toolName,
        effect: event.effect,
        reason: event.reason,
      };
    case "escalation":
      return {
        sessionId: event.sessionId,
        requestId: event.requestId,
        toolName: event.toolName,
        reason: event.strong ? "escalate-strong" : "escalate",
      };
    case "trip":
      return { reason: event.reason };
    case "reminder":
      // S3b(cost-governor)新增:T1 防遺忘提醒——見
      // packages/shared/src/enforcement.ts 的 `ReminderEnforcementEventSchema`
      // 註解,只有 reason 有意義(固定 "waiting-ttl"),沒有 sessionId/
      // requestId/toolName/effect 這種單一目標欄位(targetIds 可能多個,完整
      // 清單留在 payload JSON 裡,不重複拉出來)。
      return { reason: event.reason };
    case "task-review":
      // S5(dispose-gate)新增:見 `TaskReviewEnforcementEventSchema` 頂端註解
      // ——沒有 sessionId/requestId/toolName(不是工具權限請求),taskId/
      // teamId/taskTitle 完整內容留在 payload JSON 裡,這裡只把 reason 拉出來
      // 供快速篩選用。
      return { reason: event.reason };
  }
}
