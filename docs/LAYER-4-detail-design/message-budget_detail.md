# S2 Detail Design:訊息預算 + Mailbox 持久化(第三條斷路器)

> 上層:[S2 HLD](../LAYER-3-hld/message-budget_hld.md)｜階段:**Phase 2 第一份**
> 前置:[S1 L4 §5](./policy-engine_detail.md)(底座 `trip`/`AuditLog`)、[S11 L4](./notification_detail.md)(trip 必送不節流)、[S3b L4 §5](./cost-governor_detail.md)(`trip` 的實作先例)
> L4 完成度標準:**另一個工程師照著寫,不用問你**。

---

## 0. 現況(已查證)

### 0.1 `team_messages` 缺兩個欄位

```ts
// packages/db/src/schema.ts —— 現況
teamMessages = { id, teamId, fromName, fromRole, toTarget, content, priority, timestamp, source, note }
```
**沒有 `deliveredAt`、沒有 `contextId`。**

### 0.2 Mailbox 佇列狀態只在記憶體

`message-bus.ts` 的 `private readonly mailbox = new Map<string, TeamMessage[]>()`。
訊息**本身**已 persist(`persistAndPush`),但**「誰還沒收到」只在記憶體** ⇒ 崩潰後訊息還在 DB,但**「未送達」這個事實消失**,那則訊息永遠不會被投遞。

### 0.3 team-bus 目前 5 個工具
`send_message` / `broadcast` / `list_teammates` / `report_status` / `request_review`。
**簽章不含 `contextId`** —— 這是好事,§2 定案就是不讓 agent 指定。

### 0.4 零失控防護
`message-bus.ts` L44–50 的註解自承:agent 收到注入後可再呼叫 `send_message`,「那是預期中的正常對話」——**沒有任何預算、深度、頻率限制**。

---

## 1. schema 變更

```ts
// packages/db/src/schema.ts —— team_messages 加兩欄(冪等建欄,比照 ensureTasksAcceptanceColumn)
deliveredAt: integer("delivered_at"),        // null = 尚未送達(即在 Mailbox 中)
contextId:   text("context_id").notNull().default("legacy"),
```
> **`causedBy` 不加** —— hop 深度已由 HLD §3.1 定案延後。

### 1.1 遷移:舊資料一律標記已送達(HLD §4.1)

```sql
UPDATE team_messages SET delivered_at = timestamp WHERE delivered_at IS NULL;
-- context_id 由 DEFAULT 'legacy' 帶入
```

**為何不能預設 NULL**:NULL = 在 Mailbox 中 ⇒ 升級後**所有歷史訊息會被當成待投遞,一次全灌給 agent**。
**為何不能 flush 記憶體 Mailbox**:遷移發生在啟動時,舊行程的記憶體早已消失,**物理上做不到**。
⇒ **遷移的預設值要選「失敗代價小」的一邊**(漏投幾則舊訊息 ≪ 訊息風暴),與 default-deny 同一種思維。

`context_id = "legacy"` 的舊資料**不參與預算計算**。

---

## 2. contextId 由 Core 注入(agent 不可指定)

**這是本 spec 最重要的完整性要求。** 草稿曾把 `contextId` 設計成 MCP 參數,那等於**讓被管制的對象自己申報管制欄位**——燒完 A 任務預算的 agent 換個 contextId 就重置,整條斷路器形同虛設。與 C3(政策 agent 不可寫)、S4(acceptance agent 不可寫)是**同一個漏洞形狀**。

```
send_message(to, content)          ← MCP 簽章不變,agent 無從指定
   ↓
MessageBus 由 fromMemberId 反查:
   memberId → 該 member 目前有無綁定任務
     有 → contextId = taskId
     無 → contextId = `member:<memberId>`(2026-08-28 修正,原為拒收)
```

**推導規則(釘死)**:
- 用 `TaskService` 查 `assigneeMemberId === fromMemberId` 且 `status ∈ {assigned, in-progress, review, merging}` 的任務。
- **恰好一個** → 用它。
- **多於一個** → 取 `updatedAt` 最新的那個(**保守且可預期**;S8 之後若允許一 member 多任務,此處需重新設計)。
- **零個** → ~~拒收:「訊息必須關聯到一個進行中的任務;你目前沒有被指派任務」~~
  **2026-08-28 修正**:改回傳 `member:${fromMemberId}`(HLD §2.1 同步更新)。實作見 `MessageBus.deriveContextId()`,e2e 見 `scripts/e2e-message-budget.mjs` 的 A1(同一 member 的桶穩定、不同 member 彼此隔離)與 A2(這個桶照樣會撞上限並 trip)。

`request_review(taskId, to)` **天然帶 context**(= 該 taskId),但仍須驗證該 taskId 確實指派給發送者,否則拒收。

---

## 3. 訊息數上限:唯一主防線(HLD §3.1)

| 維度 | 這輪 | 理由 |
|---|---|---|
| **訊息數上限** | ✅ **唯一主防線** | **所有失控形態的共同表徵**;簡單、無法繞過、**一定會斷** |
| hop 深度 / A↔B 頻率 / broadcast 冷卻 | ⏸ 延後 | 成本遠高於多擋到的東西;**升級不需改 schema**(頻率可從既有 `timestamp` 算) |

```ts
// config.json 新增(遠端不可改,同 policy/notification/budget)
messageBudget: {
  maxMessagesPerContext: z.number().int().positive().default(50),
  warnAtPercent: z.number().default(80),
}
```

**計數方式**:`SELECT COUNT(*) FROM team_messages WHERE context_id = ? AND source = 'agent'`
- **只計 agent 發的**(`source = 'agent'`);人類插話不佔額度。
- broadcast 對 N 個收件者 ⇒ 產生 N 筆 → **天然被放大懲罰**(HLD §3.1 的預期行為)。

**預設值 50 的理由**:一個任務的正常協作往返(交辦、澄清、review 意見、修正回報)量級在 10–20 則;50 給了 2–3 倍餘裕,又能在失控迴圈跑掉前(通常幾十輪內)斷掉。**寧可偶爾被人調高,也不要形同虛設。**

---

## 4. trip 後:只斷訊息,不斷工作(HLD §3.2)

```
超過 maxMessagesPerContext
  → enforcementTrip({ kind:"trip", source:"message", reason:"message-budget",
                      targetIds:[contextId] })       // S11:trip 必送、不節流
  → 該 context 後續 send_message/broadcast 一律拒收
  → ⚠️ report_status / list_teammates **不受影響**(縱向推進保留)
  → agent session **不 halt**,可繼續工作
```

**回給 agent 的錯誤必須明確可理解**:
> 「此任務的訊息額度已用盡(50/50),已通知人類。你仍可繼續工作與回報狀態,但暫時無法傳訊給隊友。」

否則 agent 會反覆重試(HLD §6)。**拒收本身不計入預算**(否則變成懲罰迴圈);但**同一 context 的高頻拒收(如 10 次)應再發一次通知**——agent 可能卡在重試迴圈。

**恢復**:人類調高該 context 的預算(或全域設定)後即恢復。**不自動放寬**(同 default-deny 哲學)。

---

## 5. Mailbox 改由 DB 驅動(HLD §4)

```
現況:mailbox: Map<memberId, TeamMessage[]>          ← 權威來源
改為:SELECT * FROM team_messages
        WHERE to_target = ? AND delivered_at IS NULL
        ORDER BY timestamp                            ← 權威來源
      記憶體 Map 可保留為快取,但不是權威
```

- 崩潰重啟後未送達訊息**自然還在**,`flushMailbox` 照常運作——**無需任何額外復原邏輯**(這是選這個 schema 的主要理由,也與 S6「對帳而非 replay」一致)。
- `to_target === "broadcast"` 的訊息:投遞時對每個收件者各自判斷,**需要 per-recipient 的送達狀態** ⇒ 見 §5.1。

### 5.1 broadcast 的送達狀態(L4 必須解決的細節)

單一 `delivered_at` 欄位表達不了「A 收到了、B 還沒」。兩個選項:

| 做法 | 判定 |
|---|---|
| broadcast 時**展開成 N 筆**(每個收件者一筆,`to_target = 各自的 name`) | ✅ **採用**——`delivered_at` 語意單純,預算計數天然放大懲罰(§3),Mailbox 查詢不用特例 |
| 加一張 `team_message_recipients` 表 | ❌ 為一個尚未證明必要的正規化增加 join 與複雜度 |

**含意**:`broadcast` 在 DB 層是 N 筆訊息;UI 群聊視圖若要顯示成「一則廣播」,可用同一個 `id` 前綴或新增 `broadcast_group_id` 分組(**這輪先不做**,UI 顯示 N 筆可接受)。

### 5.2 交易一致性(必要條件)

**注入動作與 `delivered_at` 寫入必須在同一個交易裡**——否則「注入成功但標記失敗」會導致重啟後**重複投遞**,反而製造出我們正要防的訊息重複。

實作:`sendPrompt` 成功回傳後,在同一個 better-sqlite3 transaction 內 UPDATE。若 `sendPrompt` 拋錯 ⇒ **不標記**,留在 Mailbox 下次重試。

---

## 6. 失敗模式

| 情境 | 行為 |
|---|---|
| agent 反覆嘗試發已越線的訊息 | 持續拒收;**拒收不計入預算**;高頻拒收(≥10 次)再發一次通知 |
| context 預算耗盡但工作未完成 | trip + 通知;**agent 繼續工作**(§4)。人可調高或介入,**不自動放寬** |
| 崩潰時有未送達訊息 | §5 保證存活;重啟後 flush |
| 目標 member 已 dispose(S8 短命 worker) | 留 Mailbox(`delivered_at IS NULL`),下次 spawn 時補投——**現況既有機制** |
| session 未綁任務就發訊息 | 落 `member:<memberId>` 桶,照樣受上限管制(§2,2026-08-28 修正,原為拒收) |
| 一個 member 同時有多個進行中任務 | 取 `updatedAt` 最新者(§2);S8 若放寬約束需重新設計 |
| `contextId = "legacy"` 的舊訊息 | 不參與預算計算 |

---

## 7. 實作檢查清單

- [ ] `packages/db/src/schema.ts` + `client.ts`:`team_messages` 加 `delivered_at` / `context_id`(冪等)+ §1.1 遷移
- [ ] `packages/shared/src/core-config.ts`:`messageBudget` 區塊;**確認不在 `ConfigSetFilePatchSchema`**
- [ ] `apps/core/src/bus/message-bus.ts`:
  - [ ] contextId 推導(§2),沒有任務就落 `member:<memberId>` 桶
  - [ ] 發送前檢查訊息數上限(§3),越線 trip + 拒收
  - [ ] broadcast 展開成 N 筆(§5.1)
  - [ ] Mailbox 改查 DB(§5),記憶體 Map 降為快取
  - [ ] 注入 + `delivered_at` 同交易(§5.2)
- [ ] `packages/adapters/src/team-bus-mcp.ts`:**簽章不變**;錯誤訊息要明確可理解(§4)
- [ ] UI 群聊視圖:顯示 context 與額度餘量;trip 狀態
- [ ] e2e(`scripts/e2e-message-budget.mjs`):
  - [ ] 未綁任務 → per-member 桶(A1:同 member 穩定、不同 member 隔離;A2:照樣會撞上限 trip)
  - [ ] **agent 無法偽造 contextId**(MCP 簽章無此參數,且換任務才會換 context)
  - [ ] 超過上限 → trip + 拒收,但 `report_status` **仍可用**、session 未 halt
  - [ ] 崩潰重啟後未送達訊息仍被投遞(`delivered_at IS NULL` 存活)
  - [ ] 遷移:舊資料標為已送達,**不會一次全灌**
  - [ ] broadcast 產生 N 筆並放大消耗額度

---

> **驗收核心**:①agent 無法透過任何路徑重置或繞過 context 預算;②崩潰後未送達訊息不遺失、也不重複投遞。
