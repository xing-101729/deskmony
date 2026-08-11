# S3b Detail Design:CostGovernor(成本治理 / 第三條斷路器)

> 上層:[S3b HLD](../LAYER-3-hld/cost-governor_hld.md)｜階段:**Phase 1**
> 前置:[S3a L4](./usage-metering_detail.md)(量測;**§7 的實測結論改變了本 spec 的資料來源**)、[S1 L4 §5](./policy-engine_detail.md)(底座 `trip`/`AuditLog`)、[S11 L4](./notification_detail.md)(送達)
> L4 完成度標準:**另一個工程師照著寫,不用問你**。

---

## 0. ⚠️ 實測結論改變了資料來源與可保護範圍

[S3a L4 §7](./usage-metering_detail.md) 的真實環境實測(Claude Code 2.1.199 + zed bridge 0.16.2)結論:

| 後端 | 用量資料 | 成本斷路器能保護嗎? |
|---|---|---|
| **Claude Code 經 ACP** | ❌ **完全沒有**(`usage_update` 一次都不送,結構性) | ❌ **不能** |
| **Claude Code 經 `ClaudeAgentSdkAdapter`** | ✅ `total_cost_usd`(累計 $)+ `modelUsage`(累計 token) | ✅ **能** |
| 其他 ACP agent(Gemini CLI 等) | ❓ 未測 | 視其是否送 `usage_update` |
| OpenCode | ❓ 未接 | 待接 |
| PTY | ❌ 結構上不可能 | ❌ 不能 |

### 0.1 兩個必須寫進產品的結論

1. **成本斷路器的覆蓋率取決於後端,不是全域保證。** 對「Claude Code 經 ACP」的 session,**任何 token/金額上限都不會生效**——不是設定錯,是拿不到訊號。
2. ⇒ **必須有「不依賴 usage 的兜底」**:[HLD §3.1](../LAYER-3-hld/cost-governor_hld.md) 定的**回合硬上限**(時間 / 工具呼叫次數)在此從「兜底」升格為**該類後端唯一的保護**。**優先實作它。**

### 0.2 UI 必須誠實揭露
session 若屬「用量不可量測」的後端(`usageReporting !== "supported"`),**預算設定 UI 要明示「此後端無法量測花費,僅回合上限生效」**——否則使用者會以為自己設了防線。這與三態 capabilities 的精神一致(不對 UI 說謊)。

---

## 1. 權威 rollup 與持久化

S3a 是 ephemeral;S3b 補上持久層。

```sql
-- 新表:usage_rollup(權威累計)
CREATE TABLE usage_rollup (
  scope TEXT NOT NULL,          -- "session" | "task" | "day"
  scope_id TEXT NOT NULL,       -- sessionId / taskId / "YYYY-MM-DD"
  cost_amount REAL NOT NULL DEFAULT 0,
  cost_currency TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (scope, scope_id)
);
```

**寫入流程**:
```
UsageEvent(累計)
  → 取該 session 的「上次累計」(記憶體) → delta = 新 - 舊
  → 若 新 < 舊 ⇒ 連線重置:delta = 新(起新段,不做負 diff)   ← S3a §3 規則
  → delta 加進三個 scope:session / 當下綁定的 task / 今天
  → 檢查門檻(§2)
```

- **歸屬**:依 session **當下綁定的 task**;未綁任務則只記 session/day。跨任務切換時,delta 歸給**切換前**的任務(以事件時序為準)。
- **「日」的定義**:**本地時區午夜**(不是滾動 24h)——與人的直覺一致,且 kill-switch 的重置時點可預期。

---

## 2. 三層上限

```ts
// config.json 新增(遠端不可改,同 policy/notification)
budget: {
  task:  { maxCostUsd?: number; maxTokens?: number },
  daily: { maxCostUsd?: number; maxTokens?: number },
  turn:  { maxDurationMs: number; maxToolCalls: number },   // ← 不依賴 usage,§0.1
  warnAtPercent: number,   // 預設 80
}
```

| 層 | 觸發 | 動作(HLD §3.3:與急迫性相稱) |
|---|---|---|
| **回合硬上限** | 單一回合耗時 / 工具呼叫次數超標 | **立即 `interrupt()`** |
| **任務預算** | 該 task 累計超標(回合邊界發現) | **擋後續 prompt**,不打斷已結束的回合 |
| **mid-turn 成本熔斷** | 回合中收到 usage 且已超標 | **立即 `interrupt()`** |
| **每日 kill-switch** | 當日總額超標 | **全部 session `interrupt()`** |
| 軟警告 | 達 `warnAtPercent` | 發通知,**不 halt** |

**預算單位雙軌(HLD §3.2)**:`maxCostUsd` 優先;該後端拿不到 $ 但拿得到 token 時退回 `maxTokens`;兩者皆無 ⇒ 只有回合上限生效(§0.1)。

**`interrupt()` 的正確用法**:adapter 的 `interrupt()` **回傳 Promise 且語意是「中斷確實生效才 resolve」**(見 `packages/adapters/src/types.ts` 註解)。S3b **必須 await** 再標記 halt 完成;逾時無回應 → 記 audit + 最高等級通知,**不假裝已停**。

---

## 3. 回合硬上限(不依賴 usage,§0.1 的重點)

```
回合開始(sendPrompt / 收到第一個 event)→ 記 turnStartedAt、turnToolCalls = 0
每個 tool-call 事件 → turnToolCalls++
                    → 若 > budget.turn.maxToolCalls ⇒ trip + interrupt
定時檢查(每 10s)→ 若 now - turnStartedAt > maxDurationMs ⇒ trip + interrupt
回合結束(completed / error)→ 清除
```

**預設值**:`maxDurationMs = 30 分鐘`、`maxToolCalls = 200`。刻意寬鬆——這是**防失控**,不是防正常長任務;太緊會打斷合法工作,失去信任後使用者會直接關掉。

---

## 4. 掛起處理:防遺忘 + 資源回收(HLD §4 正名)

掛起的 session **不燒錢**,所以止的不是金錢損失,而是「你以為它在跑、其實卡了三天」。

| 階段 | 觸發 | 動作 |
|---|---|---|
| **T1 防遺忘** | `waiting` 超過 **6 小時** | **只發通知**(escalation 類),**不 halt** |
| **T2 資源回收** | `waiting` 超過 **72 小時** | **trip**:dispose 該 session 子程序、釋放資源 |

- **回收 ≠ 丟棄**:任務留 blocked、**worktree 保留**;人回來可續/棄(同 S6 復原視圖)。
- 這正是 S7 修正後「無人值守 escalate 無限掛起」的兜底——**沒有它,那個象限會永遠懸著**。
- 實作:定時掃描(每 10 分鐘)`status === "waiting"` 且 `waitingSince` 超時者。

---

## 5. 底座複用(驗證 S1 的抽象)

```ts
// S3b 只用 trip(單向叫停),完全不需要 escalate(雙向等回覆)
enforcementTrip({
  kind: "trip",
  source: "cost",
  reason: "task-budget" | "daily-limit" | "turn-limit" | "waiting-ttl",
  targetIds: [sessionId, ...],
})
  → await adapter.interrupt()(必要時)
  → notifier.deliver()     // S11:trip 必送、不節流
  → auditLog.append()
```

> **印證**:S3b 確實一次都用不到 `escalate` ⇒ S1 grill 把 kernel 拆成「底座 + 兩條流程」是對的。若當初硬併成單一介面,S3b 會被迫實作一個形狀不合的方法。

---

## 6. 失敗模式

| 情境 | 行為 |
|---|---|
| usage 事件遺失 | 累計 payload **自癒**(下個事件帶真總量)——這正是 S3a 選累計的理由 |
| 後端不報 usage | 該 session **只有回合上限保護**;UI 明示(§0.2) |
| price table 缺該 model | 以 token 計;**不猜價** |
| 崩潰重啟 | rollup 已持久化 → 從 DB 還原;in-flight 未落地的 delta 可能遺失(可接受) |
| `interrupt()` 無回應 | 記 audit + 最高等級通知,**不假裝已停** |
| 使用者調高上限 | 立即生效;**已 halt 的不自動恢復**(fail-safe,需手動) |
| 跨日瞬間 | 以事件 `ts` 歸屬到當時的本地日期,不因處理延遲跨錯日 |

---

## 7. 實作檢查清單

- [ ] `packages/shared/src/core-config.ts`:`budget` 區塊;**確認不在 `ConfigSetFilePatchSchema`**
- [ ] `packages/db`:`usage_rollup` 表 + 冪等建表
- [ ] `apps/core/src/cost/cost-governor.ts`:rollup 寫入、門檻檢查、trip
- [ ] `apps/core/src/cost/turn-limiter.ts`:**回合硬上限(優先做,§0.1)**
- [ ] `session-manager.ts`:接 `usage` 事件 → CostGovernor;回合起訖 → TurnLimiter;`waiting` 掃描 → T1/T2
- [ ] `packages/shared/src/known-models.ts` 或 config:price table(**僅在後端只給 token 時才需要**)
- [ ] UI:`CostView`/session 標頭顯示累計與預算餘量;**「此後端無法量測花費」明示**(§0.2)
- [ ] e2e:回合工具數超標 → interrupt;任務預算超標 → 擋後續 prompt;每日上限 → 全部 interrupt;T1 通知/T2 dispose;**不報 usage 的後端只有回合上限生效**

---

> **下一步**:與 S11 一起交實作(**S11 先**,S3b 的 trip 依賴其 Notifier)。
