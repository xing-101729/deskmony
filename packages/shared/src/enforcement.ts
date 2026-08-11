import { z } from "zod";

/**
 * enforcement.ts(S1:PolicyEngine + Enforcement 底座)。
 *
 * 對應 docs/LAYER-3-hld/policy-engine_hld.md §5、
 * docs/LAYER-4-detail-design/policy-engine_detail.md §5:
 *
 * `escalate`(權限)與 `trip`(訊息/成本熔斷)是根本不同的互動形狀——
 *   - `escalate`:請求 → **等人回決策** → 回傳 Decision。雙向。
 *   - `trip`:單方面叫停 + 通知 → void。單向。
 * 硬塞進同一介面會逼 S2(訊息熔斷)/S3b(成本熔斷)實作對它們形狀不合的
 * `escalate`,或逼 S1 帶一個用不到的 `trip`。三斷路器真正共用的只有這裡定義
 * 的「底座」:一致序列化的 `EnforcementEvent` schema(給 `AuditLog`/`Notifier`
 * 使用)。escalate/trip 各自建在這個底座之上,不合併成單一 kernel 物件。
 *
 * S1 這輪只**產生** "decision"/"escalation" 兩種事件;"trip" 的 schema 在這裡
 * 一次定型,供之後的 S2/S3b 直接複用(不需要重新設計序列化形狀),但 S1 本身
 * 不產生 trip 事件。
 */

/** PolicyEngine 的決策結果(見 apps/core/src/permissions/policy-engine.ts)。
 *  也是 `decision` 事件的 `effect` 欄位型別,放在這裡讓 `AuditLog`/`Notifier`
 *  的消費端不需要額外 import apps/core 的型別(packages/* 不得 import
 *  apps/*)。 */
export const PolicyEffectSchema = z.enum(["allow", "deny", "escalate", "escalate-strong"]);
export type PolicyEffect = z.infer<typeof PolicyEffectSchema>;

/** 一次權限決策(不論是自動放行/拒絕,或升級前的分類)——**一律記錄,含自動
 *  放行**,這是安全稽核的最低要求(D5)。 */
export const DecisionEnforcementEventSchema = z
  .object({
    kind: z.literal("decision"),
    sessionId: z.string(),
    requestId: z.string(),
    toolName: z.string(),
    effect: PolicyEffectSchema,
    reason: z.string(),
    ts: z.number(),
  })
  .strict();
export type DecisionEnforcementEvent = z.infer<typeof DecisionEnforcementEventSchema>;

/** 一次升級给人類的事件(`effect` 為 escalate/escalate-strong 時,decision 之
 *  外額外多發一則,供 Notifier 送達與稽核區分「這是一次需要人回應的升級」)。 */
export const EscalationEnforcementEventSchema = z
  .object({
    kind: z.literal("escalation"),
    sessionId: z.string(),
    requestId: z.string(),
    toolName: z.string(),
    /** true = escalate-strong(hard-deny 命中但「本機 + attended」降級的強確認,
     *  不可「永遠允許」);false = 一般 escalate(未分類長尾,default-deny)。 */
    strong: z.boolean(),
    ts: z.number(),
  })
  .strict();
export type EscalationEnforcementEvent = z.infer<typeof EscalationEnforcementEventSchema>;

/**
 * 訊息/成本熔斷單方面叫停(S2/S3b 專用)。S1 階段只定型 schema、不產生這種
 * 事件——`source` 之後可能還會擴充,這裡先覆蓋 HLD §5 列出的兩種已知來源。
 */
export const TripEnforcementEventSchema = z
  .object({
    kind: z.literal("trip"),
    source: z.enum(["cost", "message"]),
    reason: z.string(),
    targetIds: z.array(z.string()),
    ts: z.number(),
  })
  .strict();
export type TripEnforcementEvent = z.infer<typeof TripEnforcementEventSchema>;

/**
 * S3b(cost-governor)新增:T1「防遺忘」提醒(見 cost-governor_detail.md §4)。
 *
 * **為何不能沿用 `trip`**:`trip` 的既有語意是「單方面叫停」(halt),但 T1
 * 明確定案為「只發通知,不 halt」(HLD §4 的「正名」——掛起的 session 不燒錢,
 * 止的不是金錢損失而是『你以為它在跑、其實卡了三天』的認知損失,對一個已經
 * 不動的東西發 trip 只是換個標籤、沒有實質作用)。若借用 `trip` kind 傳遞 T1,
 * `RealNotifier`/UI 只能照 `trip` 的既有措辭顯示「已熔斷」,這對「其實什麼都
 * 沒發生、只是在提醒你」的 T1 是不誠實的(違反這個 codebase 對 UI 誠實揭露的
 * 一貫原則,見 adapter-capabilities.ts 的三態設計)。
 *
 * 只有 T1(waiting 超過 6 小時)會產生這種事件;T2(72 小時,真的 dispose 子
 * 程序)才是貨真價實的 halt,走既有的 `trip`(reason="waiting-ttl",與
 * `NotificationTripReasonSchema` 既有的 "waiting-ttl" 分類一致)。
 *
 * `reason: "budget-warning"`(HLD §3「中間地帶軟警告」):達 `warnAtPercent`
 * 時發通知、**不 halt**,與 T1 同一種「純提醒」語意,故共用這個 kind——差別
 * 只在提醒的具體原因,見 `EnforcementNotificationPushSchema.reminderReason`。
 */
export const ReminderEnforcementEventSchema = z
  .object({
    kind: z.literal("reminder"),
    source: z.literal("cost"),
    reason: z.enum(["waiting-ttl", "budget-warning"]),
    targetIds: z.array(z.string()),
    ts: z.number(),
  })
  .strict();
export type ReminderEnforcementEvent = z.infer<typeof ReminderEnforcementEventSchema>;

/**
 * S5(dispose-gate)新增:任務的「完成判定」升級給人類核可(見
 * docs/LAYER-4-detail-design/dispose-gate-and-lead_detail.md §1.2/§3)。
 *
 * **為何不能沿用既有的 `escalation`**:`EscalationEnforcementEventSchema` 的形狀
 * 綁死在「一次工具權限請求」的語意上(`requestId`/`toolName`/`strong` 都是
 * PermissionGateway 那條路徑才有的概念)——這裡的升級對象是「一個任務」,不是
 * 一次工具呼叫,沒有 requestId/toolName 可填,硬塞會產生一堆假欄位。理由與
 * `ReminderEnforcementEventSchema` 頂端註解完全相同:形狀不合硬塞,不如獨立
 * 開一個 kind。
 *
 * 兩種觸發原因(`reason`):
 *   - `"no-acceptance"`:任務沒有機器驗收條件,完成判定只能由人類判(HLD §2.2)。
 *   - `"acceptance-failure-streak"`:同一任務連續驗收失敗達上限(L4 §3),
 *     停止自動重跑、改為需要人類介入。
 *
 * `RealNotifier.deliver()`(apps/core/src/enforcement/notifier.ts)收到這個
 * kind 時,直接送出(不進批次佇列——理由見該檔案內的說明),對外仍然沿用
 * `EnforcementNotificationPushSchema` 既有的 "escalation" kind(不擴充對外
 * payload 形狀),只是用 `taskTitle` 取代 session 顯示名。
 */
export const TaskReviewEnforcementEventSchema = z
  .object({
    kind: z.literal("task-review"),
    taskId: z.string(),
    teamId: z.string(),
    taskTitle: z.string(),
    reason: z.enum(["no-acceptance", "acceptance-failure-streak"]),
    ts: z.number(),
  })
  .strict();
export type TaskReviewEnforcementEvent = z.infer<typeof TaskReviewEnforcementEventSchema>;

export const EnforcementEventSchema = z.discriminatedUnion("kind", [
  DecisionEnforcementEventSchema,
  EscalationEnforcementEventSchema,
  TripEnforcementEventSchema,
  ReminderEnforcementEventSchema,
  TaskReviewEnforcementEventSchema,
]);
export type EnforcementEvent = z.infer<typeof EnforcementEventSchema>;
