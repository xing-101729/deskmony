# S11 Detail Design:Notification(升級/熔斷的帶外送達)

> 上層:[S11 HLD](../LAYER-3-hld/notification_hld.md)｜階段:**Phase 1**
> 前置:[S1 L4 §5](./policy-engine_detail.md)(`Notifier` 介面與注入點**已就緒**)、[S7 L4 §2.1](./auto-mode-and-yolo_detail.md)(`attended` 語意)
> L4 完成度標準:**另一個工程師照著寫,不用問你**。

---

## 0. 現況(已查證):介面已備好,只差實作

`apps/core/src/enforcement/notifier.ts` 已有:

```ts
export interface Notifier { deliver(event: EnforcementEvent): Promise<void>; }
export class ConsoleNotifier implements Notifier { /* 只 console.log */ }
```

注入點在 `session-manager.ts`,S1 註解已言明:「**之後只需要把注入的 `Notifier` 實例換成 S11 的實作,呼叫端完全不用改**」。

⇒ **S11 的工作是加一個 `Notifier` 實作 + 設定 + 批次邏輯,不需動任何呼叫端。**

### 0.1 S7 讓 S11 的價值變得具體

S7 修正後,`attended = 有 client 連線中`。**「無 client 連線」正是 escalate 會無限期掛起的象限**——那個象限沒有通知就等於**永遠沒人知道 agent 卡住了**。S11 是那個象限唯一的出口。

---

## 1. 設定 schema(`~/.deskmony/config.json`)

```ts
// packages/shared/src/core-config.ts —— 新增 notification 區塊
notification: z.object({
  desktop: z.object({ enabled: z.boolean().default(true) }).default({ enabled: true }),
  webhook: z.object({
    /** 空字串 = 未設定。⚠️ 敏感值,見 §5 */
    url: z.string().default(""),
    enabled: z.boolean().default(false),
    /** "trip" = 只送熔斷;"escalate" = 升級也送 */
    minSeverity: z.enum(["escalate", "trip"]).default("escalate"),
  }).default({ url: "", enabled: false, minSeverity: "escalate" }),
  /** escalate 的批次彙總間隔(分鐘)。trip 不受此限(§3) */
  batchIntervalMinutes: z.number().int().positive().default(20),
  /** 靜音時段(24h 制 "HH:mm");只壓 escalate,不壓 trip */
  quietHours: z.object({ from: z.string(), to: z.string() }).optional(),
}).default({ /* 同上預設 */ }),
```

**遠端不可改**:`notification` **不得**加入 `ConfigSetFilePatchSchema` 安全子集——與 `policy` 同等對待。理由:webhook url 是「能對外送資料」的能力,遠端可改等於允許把資料導向任意端點(F3/F4)。

---

## 2. 兩條通道

### 2.1 桌面系統通知(Electron)

- 用 Electron 主行程的 `new Notification({ title, body })`(Windows/macOS 原生)。
- **實作位置**:Core 是 headless、沒有 Electron API ⇒ 通知事件**經既有 WS push 送到 desktop renderer**,由 `electron/main.ts` 觸發。
  - 新增 push:`enforcement-notification`(payload = §4 的最小化內容)。
  - `electron/preload.cts` 曝露 `deskmony:notify` IPC(比照既有 `deskmony:pickDirectory` 作風)。
- **點擊 → 聚焦對應 session**:通知帶 `sessionId`,renderer 收到點擊事件後切換到該 session。

### 2.2 Webhook

- `POST <url>`,`Content-Type: application/json`,body = §4 的最小化 payload。
- **逾時 5 秒**;失敗**最多重試 2 次**(指數退避 1s/2s),之後放棄並記 audit「未送達」。
- **不阻塞**:`deliver()` 內部 fire-and-forget,呼叫端(session-manager)不 await 結果——**通知失敗絕不影響權限決策**(HLD §6)。

---

## 3. 批次與節流(HLD §4.1:目標是保住通知可信度)

```
escalate 事件 → 進 pending 佇列(不立即送)
                 ↓ 每 batchIntervalMinutes 觸發一次
              彙總成一則:「Deskmony:3 個操作等待核可」
              (同一 session 同類請求去重,只計一次)

trip 事件    → 立即送,不進佇列、不去重、不受 quietHours 限制
```

| 規則 | 值 |
|---|---|
| escalate 批次間隔 | `batchIntervalMinutes`(預設 20 分) |
| **首次 escalate** | ⚠️ **立即送一則**,之後才進入批次節奏。理由:第一個 escalate 代表「agent 剛卡住」,等 20 分鐘才通知會讓最該即時的訊號變成最遲的 |
| trip | **必送、不節流、不併批、不受靜音** |
| quietHours | 只壓 escalate;到期後補送彙總 |

> **與逾時無關**:S11 grill 定案已解除「節流窗必須 ≪ 逾時」的約束——`attended` 時逾時 5 分鐘 deny 的路徑,人本來就在看畫面,不靠通知。**通知服務的是無人值守象限**,而那個象限**不會逾時**(掛起),所以批次可以從容。

---

## 4. 內容最小化(HLD §3.1:只帶元資料,不帶內容)

```ts
interface NotificationPayload {
  kind: "escalation" | "trip";
  /** 彙總後的筆數(單筆為 1) */
  count: number;
  /** 涉及的 session 顯示名(最多 3 個,超過用「等 N 個」) */
  sessionNames: string[];
  /** 工具名清單(去重,最多 3 個) */
  toolNames: string[];
  /** 僅 trip:原因分類 */
  tripReason?: "task-budget" | "daily-limit" | "waiting-ttl" | "message-budget";
  ts: number;
  /** 深連結,見 §4.1 */
  link: string;
}
```

**絕不放入**:指令字串、檔案路徑、檔案內容、agent 輸出、錯誤訊息全文、任何 config/env 值。

範例 body:`Coder-1:等待核可 Bash ×2、Write ×1`

### 4.1 深連結

- 桌面:不需要 URL,payload 帶 `sessionId`,renderer 直接切換。
- Webhook:`link` = `<gateway 的 http base>/#/session/<id>`(靜態 server 已存在,見 `http/static-server.ts`)。**若 core 只綁 loopback,此連結在外網無法開啟**——這是正常的(要先連隧道),UI 設定頁應說明。

### 4.2 硬規則:webhook 絕不是授權通道

**不得**在 webhook 訊息放「一鍵允許」按鈕或支援回覆式核可。Slack/Discord 不是經認證的授權通道;任何看得到頻道或能偽造回呼的人就能核可 agent 的危險操作。**授權只能經 Gateway 的認證連線**(F3/F4)。

---

## 5. webhook url 的敏感性

- **視同憑證**:`config.getEffective` 回傳給 client 時 **url 必須遮罩**(比照既有 token 從不外流的作風,見 `core-config.ts` 頂端「安全決定」)。
- config loader 既有的「疑似憑證欄位一律拒收」邏輯**不可誤傷** `notification.webhook.url`(它是合法欄位)——實作時確認該檢查是白名單式而非關鍵字式。
- **agent 不可寫**(policy 同紀律):hard-deny 已擋 `~/.deskmony` 寫入。

---

## 6. 失敗模式

| 情境 | 行為 |
|---|---|
| webhook 送出失敗 | 有限重試(2 次)後放棄 + audit「未送達」。**不影響權限決策** |
| desktop app 未執行 | 只走 webhook(Core 送 push 沒有 client 收 = 自然略過) |
| 兩條通道都不可用 | 事件仍落 audit。**系統安全地停,不危險地放行** |
| 通知風暴 | §3 批次;若單批超過 20 筆,body 只寫總數不列細節 |
| `quietHours` 跨午夜(如 23:00→07:00) | 需正確處理跨日判斷 |

---

## 7. 實作檢查清單

- [ ] `packages/shared/src/core-config.ts`:`notification` 區塊;**確認不在 `ConfigSetFilePatchSchema`**
- [ ] `packages/shared/src/gateway.ts`:`enforcement-notification` push schema + `config.getEffective` 遮罩 webhook url
- [ ] `apps/core/src/enforcement/notifier.ts`:`RealNotifier`(批次佇列 + webhook + 發 WS push),保留 `ConsoleNotifier` 供測試
- [ ] `apps/core/src/index.ts`:注入 `RealNotifier` 取代 `ConsoleNotifier`
- [ ] `apps/desktop/electron/main.ts` + `preload.cts`:`deskmony:notify` IPC → 原生通知 + 點擊回呼
- [ ] `apps/desktop/src`:收 push → 呼叫 IPC;點擊 → 切換 session
- [ ] `SettingsDialog.tsx`:通知設定(desktop 開關、webhook url/enabled、批次間隔、靜音時段)
- [ ] e2e:trip 立即送、escalate 首次立即後續批次、payload **不含**指令/路徑、webhook 失敗不影響決策、遠端不可改 notification 設定

---

> **下一步**:與 S3b 一起交實作(S3b 的 `trip` 會用到本 spec 的 Notifier)。
