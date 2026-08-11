# S3b HLD:CostGovernor(成本治理 / 第三條斷路器)

> 階段:**Phase 1**｜對應 L1:**E2、E3、E4**｜上層:[L2 §3](../LAYER-2-design-spec.md)、[DECISIONS §E](../DECISIONS.md)
> 前置:[S3a](./usage-metering_hld.md)(量測半)、[S1](./policy-engine_hld.md)(共用底座 `trip`/`AuditLog`)、[S11](./notification_hld.md)(送達端)
> 定位:三斷路器的**第三條**。S3a 把 token 攤在陽光下,S3b 決定**何時叫停**。
> ⚠️ **S11 移交的額外責任**:「掛起的 session 誰來止損」由本 HLD 承接(§4)。

---

## 1. 職責邊界

**負責**:
- 消費 S3a 的 `UsageEvent`(累計 payload),做**權威聚合**與**持久化**。
- **任務預算**(E2)與**每日/全域 kill-switch**(E3):越線 → `trip`(halt + 通知)。
- **掛起止損**(S11 移交):`waiting-permission` 掛太久的任務,由時間預算叫停。
- token → $ 換算(price table)。

**不負責**:
- ❌ usage 事件的產生與正規化(→ S3a)。
- ❌ 通知送達(→ S11 的 `Notifier`)。
- ❌ 訊息/權限斷路器(→ S2/S1),但**共用同一底座**。

---

## 2. 從 ephemeral 到權威:S3a 未做的持久化

S3a 定「切片純 ephemeral、不落地」。S3b 補上治理所需的持久層:

```
UsageEvent(累計,per 連線)
   → CostGovernor 相鄰相減得 delta(S3a §3 規則:新<舊 = 重置,起新段不做負 diff)
   → 累加進權威 rollup:per session / per task / per day
   → 持久化(DB)+ append-only 稽核(底座 AuditLog,D5)
   → 每次累加後檢查門檻(§3)
```

**歸屬(承接 S3a 開放問題 #1)**:delta 產生時,依 session **當下綁定的 task** 歸屬。session 未綁任務 → 只計入 session/day 層級。**跨任務切換時的 delta 歸給切換前的任務**(以事件時序為準)。

---

## 3. 兩層硬上限(E2/E3)

| 層 | 範圍 | 越線行為 |
|---|---|---|
| **任務預算** | 單一任務累計($ 為主,見 §3.2) | `trip` → 擋後續 prompt + 通知 + 任務標 blocked(粒度見 §3.3) |
| **每日 / 全域 kill-switch** | 團隊當日總花費 | `trip` → **全部 interrupt** + 通知(最高等級) |
| **回合硬上限**(§3.1 兜底) | 單一回合的時間 / 工具呼叫次數 | `trip` → **立即 interrupt** |

- **中間地帶軟警告**:達 X%(如 80%)發**軟警告**(不 halt),讓你有機會提高上限而非直接撞牆。
- **保守預設**(E4):預設值偏低,**要開大得有意識地開**——與 default-deny 同哲學。
- **遠端不可改**(F3/F4):預算設定走 config,且**不在遠端可改的 patch 白名單內**(既有機制,core-config.ts 已有此模式)。

### 3.1 保護粒度:mid-turn 熔斷 + 回合硬上限(S3b grill 定案)

**發現的洞**:S3a 定「回合末才發 usage」+ S3b「每次累加後檢查」⇒ **檢查只可能發生在回合之間**。一個 agent 在單一回合裡跑超長 agentic loop(幾十次工具呼叫)可以燒掉數倍上限而**三條斷路器全都看著卻擋不住**。等於**保護粒度由 agent 決定,不是由你的上限決定**——違反安全罩「平台保有單方面叫停權」的精神。

**定案:兩層一起做**

| 層 | 內容 |
|---|---|
| **(B) mid-turn usage 熔斷(主)** | 啟用 S3a 預留的高頻發射路徑:ACP adapter 收到 `usage_update` 即轉發累計事件(**schema 不變**,S3a §3 已預留),S3b 得以在**回合中途**檢查門檻並熔斷。代價:事件流量變大。 |
| **(C) 回合硬上限(兜底)** | 對單一回合設**時間 / 工具呼叫次數**上限,超過即 interrupt。**不依賴 usage**——涵蓋 PTY 等不報用量的後端,是最後一道粗網。 |

- **接受的代價**:mid-turn interrupt 會產生**半完成狀態**(檔案改一半)。這與預算耗盡本來就會發生的情況相同,由 **worktree 隔離 + 人工分流**(同 S6 復原視圖)處理。
- **仍然反應式(E4)**:即使 mid-turn,也擋不掉**已送出**的 token,量測仍有延遲。上限的作用是**框住損害**,不是精準防超支;實際花費會略超,這是設計接受的。

### 3.2 預算單位:雙軌($ 為主,token 兜底)(S3b grill 定案)

| 做法 | 判定 |
|---|---|
| 純 token | ❌ **跨 model 無可比性**——Opus 與 Haiku 的 1M token 差幾十倍價錢;核心 set 是三家軟體各自多 model,一個 token 上限在換 model 後意義全變 |
| 純 $ | ❌ 強制依賴 price table;**缺價時靜默失去保護**(新 model / 自架 / OpenCode 接的任意後端),這是最危險的失敗模式 |
| **雙軌** | ✅ **採用** |

- 內部**同時記 token 與 $**;**上限以 $ 為主**(你真正在意的是「別一夜燒掉 $200」,不是 token 數)。
- **price table 缺該 model 單價時 → 退回 token 上限**,並在 UI 標示「此 model 以 token 計」。保證**永遠有一條線**。
- price table:內建一份(`known-models.ts` 已有 model 知識)+ **允許 config 覆寫**(單價會變,不能寫死等發版)。缺價**不猜價**(§6)。

### 3.3 halt 粒度:與觸發原因的急迫性相稱(S3b grill 定案)

| 觸發 | 動作 | 理由 |
|---|---|---|
| **回合硬上限 / mid-turn 成本熔斷** | **立即 `interrupt()`** | 必須中途停,否則 mid-turn 熔斷失去存在意義 |
| **任務預算(回合邊界發現)** | **不打斷已結束的回合**,擋住後續 prompt | 回合都結束了,沒必要製造半完成狀態 |
| **每日 kill-switch** | **全部 `interrupt()`** | 最高等級訊號,寧可留半完成也要止血 |

- 沿用既有介面:adapter 的 `interrupt()` **已回傳 Promise 且語意明確**(「中斷確實生效才 resolve」)。S3b 應 **await 它**再標記 halt 完成。
- interrupt 無回應 → 走 §6:記稽核 + 最高等級通知,**不假裝已停**。

---

## 4. 掛起的處理:防遺忘 + 資源回收(S3b grill 定案,正名自「止損」)

S11 定:無人值守下 escalate **不 deny,改掛起** `waiting-permission`,並把後續交給預算。

**正名的理由**:掛起的 session **不燒錢、不佔算力**——所以我們止的**不是金錢損失**,而是「**你以為它在跑、其實它卡死三天**」的認知損失。對一個已經不動的東西發 trip(halt),只是換個標籤、沒有實質作用。故拆成兩件語意正確的事:

| 階段 | 觸發 | 動作 | 這是什麼 |
|---|---|---|---|
| **T1 防遺忘** | 等待超過 T1(較短,如 6h) | **只發通知,不 halt** | **提醒**,不是熔斷。呼應 S11「叫你回來」 |
| **T2 資源回收** | 等待超過 T2(遠長於 T1,如 72h) | **真 trip**:dispose 該 session 的子程序、釋放資源 | 回收的是**記憶體與子程序**,不是金錢 |

- **回收 ≠ 丟棄**:任務留在 blocked、**worktree 保留**;人回來可決定續/棄(與 S6 復原視圖同一 UX)。
- 這解釋了為何 S11 能安心地「不 deny」:掛起有**提醒 + 回收**兜底,不會無限期無聲懸著。

---

## 5. 共用底座的複用(驗證 S1 的抽象)

S3b 是**第一個 `trip` 的真實使用者**,用來驗證 S1 §5 的底座切分是否正確:

```ts
// S3b 只用 trip 流程(單向叫停),不需要 escalate(雙向等回覆)
trip({ kind: "trip", reason: "task-budget" | "daily-limit" | "waiting-ttl", ... })
  → halt 目標 session(s)
  → Notifier.deliver()   // S11:trip 必送、不節流、可帶原因分類
  → AuditLog.append()    // D5
```

**驗證結果(設計層)**:S3b 確實**完全不需要** `escalate`——印證 S1 grill 把 kernel 拆成「底座 + 兩條流程」是對的;若當初硬併成單一 `EnforcementKernel` 介面,S3b 會被迫實作一個形狀不合的 `escalate`。

---

## 6. 失敗模式

| 情境 | 行為 |
|---|---|
| usage 事件遺失 | 累計 payload **自癒**(S3a),下個事件帶真總量,rollup 自動修正。**這正是 S3a 選累計的理由**。 |
| adapter 不報 usage(PTY) | 該 session **花費不可量測** → 無法被成本斷路器保護 → 又一個「PTY 唯讀/需人陪」的理由(C7)。 |
| price table 缺該 model 單價 | 以 token 計而非 $;或標記「$ 不可得」。**不猜價**。 |
| 崩潰重啟 | 權威 rollup 已持久化 → 從 DB 還原;in-flight 的未落地 delta 可能遺失(可接受,best-effort)。 |
| 上限被撞但 halt 失敗(adapter interrupt 無回應) | 記稽核 + 升級最高等級通知;**不假裝已停**。 |
| 使用者調高上限 | 立即生效,已 halt 的可手動恢復(不自動復活,fail-safe)。 |

---

## 7. 對應 L1 決策

E2 任務預算 · E3 每日 kill-switch · E4 保守預設 + 反應式誠實 · D5 稽核 · F3/F4 遠端不可改預算 · **承接 S11 §4 的掛起止損**。

---

## 8. 開放問題(留給 L4)

1. **price table 的覆寫格式**(承接 S3a 開放 #3):內建 `known-models.ts` + config 覆寫的 schema 與優先序。
2. **T1 / T2 的預設值**:6h / 72h?可 per-task 覆寫?
3. **回合硬上限的維度與預設**:時間、工具呼叫次數,還是兩者?各自預設值?
4. **mid-turn 發射的流量控制**:ACP `usage_update` 若非常頻繁,adapter 端要不要節流(如每 N 秒最多一次)?
5. **每日的「日」如何定義**:本地時區午夜?滾動 24h?

---

> **S3b grill 已完成(2026-07-24)**,4 項定案:
> ① **mid-turn 熔斷 + 回合硬上限**——修補「保護粒度由 agent 的回合長度決定」的洞;啟用 S3a 預留的高頻發射路徑(schema 不變),PTY 等不報用量者由回合硬上限兜底。
> ② **預算單位雙軌**:$ 為主、token 兜底;price table 缺價時退回 token 線,保證永遠有一條線,不猜價。
> ③ **掛起正名為「防遺忘 + 資源回收」**:T1 只通知(提醒)、T2 才 dispose(回收子程序,非金錢);誠實面對「掛起不燒錢」。
> ④ **halt 粒度與急迫性相稱**:mid-turn/回合上限 → 立即 interrupt;任務預算(回合邊界)→ 擋後續 prompt;每日 kill-switch → 全部 interrupt。
> **驗證**:S3b 完全不需要 `escalate`,印證 S1 把 kernel 拆成「底座 + 兩條流程」是對的(§5)。
> **下一步**:S6(崩潰復原)—— Phase 1 最後一份 HLD。
