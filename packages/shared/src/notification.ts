import { z } from "zod";

/**
 * notification.ts(S11:Notification,見 docs/LAYER-4-detail-design/notification_detail.md)。
 *
 * 這裡定義兩件事:
 *   1. `EnforcementNotificationPushSchema`——`enforcement-notification` WS push
 *      channel 的 payload 形狀(見 gateway.ts 的 `ServerPushSchema.channel`),
 *      也是 webhook POST body 的完整內容(§2.2:「body = §4 的最小化 payload」,
 *      不是另外轉譯成 Slack/Discord 專屬格式——那是使用者自己接收端的事)。
 *   2. `formatEnforcementNotificationText()`——把上述結構化 payload 轉成人類
 *      可讀的 title/body 字串,只給**桌面通知**用(webhook 直接送結構化
 *      JSON,不需要這個)。刻意放在 packages/shared(不是 apps/core 或
 *      apps/desktop 各自實作一份)——這個檔案完全不 import `node:*`,可以被
 *      apps/desktop 的瀏覽器 bundle 安全引入(與 core-config.ts 同樣的限制,
 *      見該檔案頂端說明),渲染端(apps/desktop/src/stores/session-store.ts)
 *      在呼叫 `deskmony:notify` IPC 前用它算出 title/body,單一份格式邏輯,
 *      不會在 core/desktop 兩邊各寫一份而漂移。
 *
 * ---- 內容最小化(§4,硬規則,不是風格偏好)----
 * 這裡的 payload **絕不**帶指令字串、檔案路徑、檔案內容、agent 輸出、錯誤
 * 訊息全文、任何 config/env 值——只帶元資料(工具名、session 顯示名、筆數、
 * 事件種類、trip 的原因分類)。`RealNotifier`(apps/core/src/enforcement/
 * notifier.ts)是唯一產生這個 payload 的地方,務必維持這條邊界。
 */

/**
 * trip 的原因分類(§4:「trip 例外」——可多帶原因分類,分類本身不含敏感
 * 內容)。S3b(CostGovernor)新增 `"turn-limit"`(回合硬上限:時間/工具呼叫
 * 次數超標,見 cost-governor_detail.md §3)——**必須**是獨立分類,不能讓它
 * 落回 `TRIP_REASON_TO_SOURCE_FALLBACK` 的 "daily-limit" 預設值:那會讓使用者
 * 看到「每日成本上限」的通知文字,但實際觸發原因其實是回合跑太久/工具呼叫
 * 太多次,兩者原因完全不同,顯示錯的分類比不分類更糟(誤導使用者去查錯的
 * 地方)。
 */
export const NotificationTripReasonSchema = z.enum([
  "task-budget",
  "daily-limit",
  "waiting-ttl",
  "message-budget",
  "turn-limit",
]);
export type NotificationTripReason = z.infer<typeof NotificationTripReasonSchema>;

export const EnforcementNotificationPushSchema = z
  .object({
    /** S3b(cost-governor)新增 "reminder"——T1 防遺忘提醒,見
     *  packages/shared/src/enforcement.ts 的 `ReminderEnforcementEventSchema`
     *  註解:語意上不是 halt,不可與 "trip" 共用「已熔斷」措辭。 */
    kind: z.enum(["escalation", "trip", "reminder"]),
    /** 彙總後的筆數(單筆為 1)。 */
    count: z.number().int().positive(),
    /** 涉及的 session 顯示名——這個陣列本身已經是「最多 3 個真名,超過時多
     *  加一個『等 N 個』字串」處理過的最終結果(見 RealNotifier 的
     *  `buildSessionNamesField()`),渲染端只需要原樣 join,不需要再次截斷。 */
    sessionNames: z.array(z.string()),
    /** 工具名清單(去重,最多 3 個 + 可能的「等 N 個工具」,同上處理方式)。 */
    toolNames: z.array(z.string()),
    /** 僅 trip 事件會有值。 */
    tripReason: NotificationTripReasonSchema.optional(),
    /** 僅 reminder 事件會有值——見 `ReminderEnforcementEventSchema.reason`。 */
    reminderReason: z.enum(["waiting-ttl", "budget-warning"]).optional(),
    ts: z.number(),
    /** 深連結(§4.1):`<gateway 的 http base>/#/session/<id>`。批次彙總涉及
     *  多個不同 session 時,無法用單一連結精準指向其中一個(保守選擇:退化成
     *  app 根路徑,不猜測要連去哪一個 session),見下方 `sessionId` 欄位。 */
    link: z.string(),
    /** 桌面深連結專用(§4.1:「桌面:不需要 URL,payload 帶 sessionId,
     *  renderer 直接切換」)——只有這批通知涉及**恰好一個** session 時才有值;
     *  涉及多個 session 時省略(不猜測要聚焦哪一個,見上方 `link` 的保守選擇,
     *  這是 L4 沒寫清楚、由 S11 實作時保守決定的地方)。 */
    sessionId: z.string().optional(),
  })
  .strict();
export type EnforcementNotificationPush = z.infer<typeof EnforcementNotificationPushSchema>;

const TRIP_REASON_LABEL: Record<NotificationTripReason, string> = {
  "task-budget": "任務預算上限",
  "daily-limit": "每日成本上限",
  "waiting-ttl": "等待逾時上限",
  "message-budget": "訊息數上限",
  "turn-limit": "回合時間/工具呼叫次數上限",
};

/** 桌面原生通知的 title/body(見檔案頂端說明,webhook 不使用這個函式)。 */
export function formatEnforcementNotificationText(payload: EnforcementNotificationPush): {
  title: string;
  body: string;
} {
  const who = payload.sessionNames.length > 0 ? payload.sessionNames.join("、") : "Deskmony";

  if (payload.kind === "trip") {
    const reason = payload.tripReason ? TRIP_REASON_LABEL[payload.tripReason] : "已被熔斷叫停";
    return {
      title: "Deskmony:任務已熔斷",
      body: `${who}:${reason}`,
    };
  }

  if (payload.kind === "reminder") {
    // S3b(cost-governor):誠實措辭——**沒有**halt,只是提醒(見
    // ReminderEnforcementEventSchema 註解),不可套用「已熔斷」字樣。
    if (payload.reminderReason === "budget-warning") {
      return {
        title: "Deskmony:預算即將用盡",
        body: `${who}:花費/token 已達到警戒線,尚未 halt,建議關注或調整預算上限`,
      };
    }
    return {
      title: "Deskmony:任務閒置提醒",
      body: `${who}:已等待回應超過 6 小時,尚未被中斷,worktree/任務仍保留,請確認是否需要回來處理`,
    };
  }

  // escalation:count/toolNames 只有去重後的工具名清單與總筆數,沒有「每個
  // 工具各幾筆」的細分(schema 本身沒有帶這個粒度,見檔案頂端「內容最小化」
  // 的欄位形狀)——body 只能表達「共 N 筆,涉及哪些工具」,不做逐工具計數。
  const tools = payload.toolNames.length > 0 ? payload.toolNames.join("、") : "操作";
  const title = payload.count > 1 ? `Deskmony:${payload.count} 個操作等待核可` : "Deskmony:等待核可";
  return {
    title,
    body: `${who}:等待核可 ${tools}`,
  };
}
