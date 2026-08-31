# S2 HLD:訊息預算與熔斷 + Mailbox 持久化(第三條斷路器)

> 階段:**Phase 2**｜對應 L1:**A5**、**D4**(S6 移交)｜上層:[L2 §3](../LAYER-2-design-spec.md)、[DECISIONS §A](../DECISIONS.md)
> 前置:[S1](./policy-engine_hld.md)(共用底座 `trip`/`AuditLog`)、[S11](./notification_hld.md)(送達)、[S3b](./cost-governor_hld.md)(trip 的先例)
> 定位:三斷路器的**最後一條**。管的不是錢也不是權限,而是**agent 之間的對話會不會失控**。

---

## 0. 現況(已查證)

`apps/core/src/bus/message-bus.ts`(20KB)已實作完整投遞策略:idle 立即注入 / busy 排隊 / interrupt(需 `canInterrupt`)/ 無 session 留 Mailbox 待補投。

**兩個缺口**:

| 缺口 | 現況 | 影響 |
|---|---|---|
| **零失控防護** | 檔案頂端註解(L44–50)自承:agent 收到注入後可再呼叫 `send_message`,「那是預期中的正常對話」——**沒有任何預算、深度、頻率限制** | A↔B 可無限互相回覆,燒光額度 |
| **Mailbox 佇列狀態只在記憶體** | 訊息**本身**已 persist 到 `team_messages`(`persistAndPush`),但「誰還沒收到」是 `Map<memberId, TeamMessage[]>` | 崩潰後訊息還在 DB,但**「未送達」這個事實消失** → 訊息永遠不會被投遞 |

---

## 1. 職責邊界

**負責**:
- **context 綁定**:每則訊息都必須掛在一個由 Core 推導的 context 下(A5 前半)——有進行中任務就是該任務,沒有則是 `member:<memberId>`(2026-08-28 修正,原為「無脈絡拒收」,見 §2.1)。
- **context 預算**:每個 context 自帶訊息數 / hop 深度上限,燒完 `trip`(A5 後半)。
- **迴圈偵測**:A↔B 高頻互傳熔斷。
- **Mailbox 佇列持久化**(D4,S6 移交):讓「未送達」跨崩潰存活。

**不負責**:
- ❌ 投遞策略本身(現況已完整,只在其上加閘)。
- ❌ 通知送達(→ S11)、稽核落地(→ 底座 `AuditLog`)。

---

## 2. Context 綁定:Core 自動注入,agent 不可指定(A5 前半)

L1 選了比「純預算」更硬的方案:**所有 peer 訊息必須綁 task/review context**。

### 2.1 contextId 由 Core 注入(S2 grill 定案)

**修正的漏洞**:草稿原本把 `contextId` 設計成 MCP 工具**參數**,等於**讓被管制的對象自己申報管制欄位**——一個燒完 A 任務預算的 agent,只要換填另一個 contextId,預算就重新歸零,§3 的預算閘形同虛設。這與 C3(政策 agent 不可寫)、S4(acceptance agent 不可寫)是**完全相同的漏洞形狀**。

```ts
// MCP 工具簽章:不含 contextId —— agent 無從指定
send_message(to, content)
broadcast(content)
request_review(taskId, to)
```

- **Core 依「該 session 當下綁定的任務」自動填 contextId**;agent 完全不能指定、也無法偽造。
- ~~**session 未綁任何任務 → 直接拒收訊息**(取代草稿的「無 contextId → 拒收」)。~~
  **2026-08-28 修正(使用者實測回報)**:改為落在 `member:<memberId>` 這個由 Core 推導的專屬 contextId。原本的一律拒收把「手上沒有任務的成員回覆人類或隊友」也一起擋掉了——那是人類插話帶起的對話,天然有速度上限,不是本 spec §0 要防的「agent 之間互相對話失控」。**紀律不變**:contextId 仍然只由 Core 推導、agent 一樣無從指定或偽造,per-member 桶照樣吃 §3 的訊息數上限、成員之間互不共用,不是「沒有任務就無限暢聊」的後門。
- 語意上也更正確:「這則訊息屬於哪個任務」是**事實**,不是 agent 的意見——Core 本來就知道(session↔member↔task 綁定)。讓 agent 申報一個 Core 已知的事實,只會製造分歧與偽造空間。
- 效果:壓制無脈絡閒聊;稽核時能回答「**這則訊息為何存在**」。

---

## 3. Context 預算:脈絡內死循環的解藥(A5 後半)

**關鍵認知(L1 grill 定案)**:綁了 context **不代表不會迴圈**——A、B 完全可以在**同一張 task 底下**無限「收到→回→收到→回」,context 一直合法。**故 context 必須自帶預算**。

### 3.1 只做「訊息數上限」一條主防線(S2 grill 定案)

| 維度 | 決定 | 理由 |
|---|---|---|
| **訊息數上限** | ✅ **Phase 2 唯一主防線** | **所有失控形態的共同表徵**——任何迴圈最終都表現為訊息數暴增。簡單、無法繞過、**一定會斷** |
| hop 深度 | ⏸ 延後 | 需 `causedBy` 欄位 + 鏈計算 + 斷鏈處理,**成本遠高於它多擋到的東西**;深鏈必然先消耗訊息數 |
| A↔B 頻率 | ⏸ 延後 | 高頻互刷同樣會撞訊息數上限;它多提供的只是「**更早**發現」 |
| broadcast 冷卻 | ⏸ 延後 | broadcast 一對多、一次消耗 N 則額度,**已被訊息數上限放大懲罰** |

- **斷路器最重要的性質是「不求早,但求一定會斷」**——先做保證有效的最小機制,等真實運行告訴你不夠再加。同 S4 只做量測半、S3a 不加 `estimated`、S6 不做 heartbeat 的一貫刀法。
- **升級路徑不需改 schema**:日後若觀察到「訊息數上限太晚才斷」,頻率偵測可從**既有時間戳**算出,不需 `causedBy`。
- **越線一律「明確拒收 + 記事件」**,絕不靜默吞掉——agent 要知道自己被擋,人要能在群聊視圖看到。
- `trip` 走**共用底座**(同 S3b):通知 + 稽核。

### 3.2 trip 後:只斷訊息,不斷工作(S2 grill 定案)

訊息熔斷與成本熔斷**不同**:成本 trip 要 halt session(它不該再燒錢);但訊息額度用盡時,**agent 本身可能還在正常工作**。

| 做法 | 判定 |
|---|---|
| halt 整個 session | ❌ 過度——額度用完不代表它不能繼續寫程式,它可能正要完成任務 |
| 斷訊息 + 標任務 blocked | ❌ 越俎代庖——該由任務層機制決定 |
| **只斷訊息,agent 繼續工作** | ✅ **採用** |

- `send_message`/`broadcast` 一律拒收;**`report_status` 等縱向推進不受影響**。等於**切斷橫向溝通,保留縱向推進**。
- **熔斷的目標是「阻止對話迴圈燒錢」,不是「阻止工作」**——斷路器該斷失控的那條線,不是全部。
- 自然導向正確結果:agent 講不了話,要嘛自己做完,要嘛卡住 → 那時任務層機制(S3b 的 T1 提醒、驗收閘)會接手。
- 人收到通知後可**提高預算恢復溝通**或直接介入(不自動放寬,同 default-deny 哲學)。
- **拒收訊息回給 agent 的錯誤必須明確可理解**(「此任務的訊息額度已用盡,已通知人類」),否則 agent 會反覆重試(§6)。

---

## 4. Mailbox 佇列持久化(D4,S6 移交)

**現況的半完成**:訊息 persist 了,佇列狀態沒有。修法是**把「未送達」變成訊息的持久欄位**,而非獨立的記憶體結構:

```
team_messages 加欄位:
  deliveredAt: number | null     // null = 尚未送達(即在 Mailbox 中)
  contextId:   string            // §2,Core 注入
```
> `causedBy` **不加**——hop 深度已由 §3.1 延後。

- Mailbox 從「記憶體 Map」變成「**對 `deliveredAt IS NULL` 的查詢**」。
- 崩潰重啟後,未送達訊息**自然還在**,`flushMailbox` 照常運作——**無需額外的復原邏輯**(這是選這個 schema 的主要理由)。
- 記憶體 Map 可保留為**快取**,但**權威來源是 DB**。

### 4.1 遷移:舊資料一律標記為已送達(S2 grill 定案)

| 做法 | 判定 |
|---|---|
| `deliveredAt` 預設 NULL | ❌ **災難**——NULL = 在 Mailbox 中 ⇒ 升級後**所有歷史訊息被當成待投遞,一次全灌給 agent** |
| 升級時把記憶體 Mailbox flush 進 DB | ❌ **物理上不可行**——遷移發生在啟動時,舊行程的記憶體 Mailbox 已隨關閉消失,沒有東西可 flush |
| **舊資料一律 `deliveredAt = createdAt`** | ✅ **採用** |

- 假設升級前的訊息都處理完了。可能誤標少數真沒送到的,但**代價極小**(漏投一則舊訊息),而預設 NULL 的代價是**訊息風暴**。
- **遷移的預設值要選「失敗代價小」的那一邊**——與 default-deny 同一種思維。
- 舊資料的 `contextId` 填哨兵值(如 `legacy`),**不參與預算計算**。

### 4.2 交易一致性(必要條件)

**`deliveredAt` 的寫入必須與注入動作在同一個交易裡**——否則「注入成功但標記失敗」會導致重啟後**重複投遞**,反而製造出我們正要防的訊息重複。

---

## 5. 與既有投遞策略的關係(只加閘,不重寫)

```
send_message(to, content)              ← agent 不傳 contextId
   │
   ├─ [S2] Core 由 session 綁定推導 contextId
   ├─ [S2] session 未綁任務?            → contextId = member:<memberId>(2026-08-28 修正,原為拒收)
   ├─ [S2] context 訊息數越線?          → trip + 拒收(agent 仍可繼續工作,§3.2)
   │
   ▼ 通過後,走**現況既有**的投遞策略(不動)
   persistAndPush → 依 session 狀態:idle 注入 / busy 排隊 / interrupt / 無 session 留 Mailbox
                    (注入與 deliveredAt 標記同交易,§4.2)
```

**設計立場**:現況的投遞策略是好的,S2 **在它前面加閘**,不重寫。唯一改動既有行為的是 §4 的 Mailbox 來源(記憶體 → DB 查詢)。

---

## 6. 失敗模式

| 情境 | 行為 |
|---|---|
| agent 反覆嘗試發已越線的訊息 | 持續拒收;拒收本身不計入預算(否則變成懲罰迴圈)。**但**高頻拒收應觸發一次通知(agent 可能卡在重試迴圈)。 |
| context 預算耗盡但工作未完成 | `trip` + 通知人類;**agent 繼續工作,只是不能發訊息**(§3.2)。人可提高預算或介入,**不自動放寬**。 |
| 崩潰時有未送達訊息 | §4 保證存活;重啟後 flush。 |
| 目標 member 已被 dispose(A4 短命 worker) | 留 Mailbox(`deliveredAt IS NULL`),下次該 member 有 session 時補投——**現況既有機制**。 |
| broadcast 風暴 | 一次消耗 N 則額度,由訊息數上限放大懲罰(§3.1);冷卻機制延後。 |
| session 未綁任務就想發訊息 | 落 `member:<memberId>` 桶,照樣受 §3 上限管制(§2.1,2026-08-28 修正,原為拒收)。 |

---

## 7. 對應 L1 決策

**A5**(peer 訊息綁 context + context 自帶預算)· **D4**(Mailbox 持久化,S6 移交)· 與 S3b 共用底座 `trip` · **A4**(對方不在線 → 落持久 Mailbox,現況已有、§4 強化)。

---

## 8. 開放問題(留給 L4)

1. **訊息數上限的預設值**:一個 task context 預設允許幾則?過小打斷正常協作,過大失去意義。
2. **review 迴圈的 context**:`request_review` 產生的往返算同一個 context 還是子 context?(影響預算分母。)
3. **既有 `canInterrupt` 與新預算的關係**:interrupt 是否該有獨立且更嚴的配額?
4. **session 綁定多個任務時**如何推導 contextId(同 S3a/S3b 的歸屬議題)。

---

> **S2 grill 已完成(2026-07-24)**,4 項定案:
> ① **contextId 由 Core 注入,agent 不可指定**——修補「讓被管制者自己申報管制欄位」的漏洞(換個 contextId 就能重置預算);與 C3/S4「agent 不可寫」同紀律。MCP 簽章移除該參數。
> ② **只做訊息數上限一條主防線**——hop 深度 / A↔B 頻率 / broadcast 冷卻全部延後;訊息數是所有失控形態的共同表徵,**斷路器不求早、但求一定會斷**。升級不需改 schema。
> ③ **trip 後只斷訊息、不斷工作**——切斷橫向溝通,保留縱向推進(`report_status` 不受影響);熔斷的目標是阻止對話迴圈,不是阻止工作。
> ④ **遷移舊資料一律標記已送達** + **注入與標記同交易**——預設 NULL 會讓歷史訊息全部重投(災難);遷移預設值要選失敗代價小的一邊。
> **下一步**:S8(agent 生命週期)或 S5(Lead + dispose-gate)—— Phase 2 剩餘兩份。
