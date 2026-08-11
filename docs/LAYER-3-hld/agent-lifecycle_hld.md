# S8 HLD:Agent 生命週期(角色決定長命 / 短命)

> 階段:**Phase 2**｜對應 L1:**A4**｜上層:[L2 §3](../LAYER-2-design-spec.md)、[DECISIONS §A](../DECISIONS.md)
> 前置:[S2](./message-budget_hld.md)(Mailbox 已持久化 → 「對方不在線」可安全處理)、[S6](./crash-recovery_hld.md)(恢復語意)
> 定位:決定**誰一直活著、誰用完即棄**。這是 context 成本與協作可用性的權衡點。

---

## 0. 現況(已查證)

`SessionManager` 用 `memberSessions: Map<memberId, sessionId>` 維護「一個 member 一個 session」。
`createSession()` 與 `dispose()` **都是明確呼叫**——**沒有任何生命週期策略**:沒有「指派任務時自動 spawn」、也沒有「任務完成後自動 dispose」。目前所有 session 都是**人手動建立、手動關閉**,實質上等於「全部長命」。

---

## 1. 職責邊界

**負責**:
- 定義**角色 → 生命週期**的對應(長命 = 在線可達 / 短命 = 用完即棄)。
- 短命 worker 的**自動 spawn(指派時)與 dispose(任務結束時)**。
- **外部記憶的檔案層**(§2.1):約定位置 + spawn 時指路。
- 長命 agent 的 **context 閾值 checkpoint 重啟**(§2.2)。
- 「對方不在線」時的訊息處理(與 S2 的持久 Mailbox 協同)。

**不負責**:
- ❌ 訊息投遞策略(→ S2)。
- ❌ Lead 的行為與收斂閘(→ S5)。
- ❌ 崩潰後的恢復(→ S6;但**共用「接手」機制**,§2.2)。
- ❌ **結構化記憶層 / 檢索**(延後,§2.1)。

---

## 2. 兩種生命週期(A4)

| | **長命(persistent)** | **短命(ephemeral)** |
|---|---|---|
| 誰 | **協調者**(Lead);需隨時回應隊友的角色 | 純執行的 task worker(Coder、Reviewer) |
| 建立 | 團隊啟動時 / 人手動 | **任務指派時自動 spawn** |
| 銷毀 | 人手動 / 團隊關閉 / **context 閾值 checkpoint 重啟**(§2.2) | **任務進入終態時自動 dispose** |
| 記憶 | **外部記憶**(§2.1),非 context | **外部記憶**,context 每任務歸零 |

**設定位置**:`TeamMember` 增加 `lifecycle: "persistent" | "ephemeral"`(預設由 role 決定,可覆寫)。

### 2.0 ⚠️ 長命的理由被改寫(S8 grill 定案)

草稿的理由是「**為了跨任務記憶**」——**這是錯的**。一旦有了外部記憶(§2.1),記憶就不依賴 context 存活,任何 agent spawn 起來讀一下就有了。**「為了記憶而長命」的理由消失。**

> **正確的理由:長命 = 為了「在線可達」,不是為了記憶。**

- **Lead 的職責是協調**,它必須隨時能回應隊友訊息;若它是短命的,隊友發訊息時它不存在,訊息進 Mailbox 等下次喚醒——**協調者離線,整個團隊的協作即時性就崩了**。
- Worker 則相反:它只在自己的任務上工作,不在線完全可接受(訊息落 Mailbox,§4)。
- **⇒ §4「對方不在線」的處理因此更聚焦:只有 worker 會不在線,協調者永遠在線。**
- **附帶好處**:理由從「記憶」改為「在線」後,**context 膨脹的壓力大減**——Lead 可在接近上限時安心 checkpoint 重啟(知識在檔案裡,重啟不損失),只要重啟夠快就不影響在線性(§2.2)。

### 2.1 外部記憶:兩層,分期實作(S8 grill 定案)

**這解決了草稿最大的漏洞**:草稿定義了「長命」類別,卻把「context 撐爆怎麼辦」列為不解決的開放問題 ⇒ **長命是一個空頭承諾**(一個跑三天的 Lead 必然撞上 context 上限,要嘛爆掉、要嘛被後端悄悄截斷而你以為它記得)。

定案:記憶**移到 context 之外**,分兩層:

| 層 | 內容 | 階段 | 理由 |
|---|---|---|---|
| **① 檔案記憶(敘述)** | 專案內的 markdown 筆記(如 `.deskmony/notes/`)。agent 用**已有的檔案工具**讀寫;平台只負責「spawn 時指出該讀什麼」 | **Phase 2** | **零新機制**;人類可讀可改可稽核(同政策/驗收紀律);**天然進 git**,錯誤記憶會像錯誤程式碼一樣被 diff/review 抓到;檢索交給 agent 自己 grep |
| **② 結構化事實(DB + 檢索)** | `remember(fact)`/`recall(query)` 之類的結構化層 | **延後** | 需 schema/寫入/檢索/去重/失效整套,是**獨立子系統的體量** |

**為何檔案先行**:**你還不知道 agent 實際會想記住什麼**。先建結構化 schema 等於在沒有真實資料時猜「事實」長什麼樣,很可能猜錯重來。跑一陣子後,**從實際累積的筆記裡看出哪些是反覆查詢的事實**(如「這模組誰負責」「上次為何否決 X 方案」),再據此設計 schema——**用資料決定 schema,不用想像**。同 S4 只做量測半、S2 只做訊息數上限的一貫刀法。

### 2.2 長命 agent 的 context 閾值重啟

context 接近上限時:要求 agent 把該記的寫進**檔案記憶** → dispose → 重新 spawn 並指路讀回。

- **這就是 S6 的「接手(讀摘要重啟)」**,只是觸發原因從崩潰換成 context 閾值——**重用既有機制,不需新發明**。
- 因為知識在檔案裡,重啟**不損失知識**,只損失未寫下的隱性 context。

---

## 3. 短命 worker 的生命週期

```
任務 backlog
   │  指派給 member(lifecycle=ephemeral)
   ▼
[自動 spawn session]  ← workspace = 該任務的 worktree
   │
   任務 in-progress → review → merging
   ▼
任務進入終態(done / 放棄)
   │
[自動 dispose session]
   │
   context 消失;下次指派 = 全新 session
```

- **spawn 時機**:任務 `backlog → assigned` 轉換(worktree 此時已建立)。
- **dispose 時機**:任務進入**終態**(`done`,或人工放棄)。
  - ⚠️ **`blocked` 不 dispose**——它可能還會回到 in-progress(S3b 的 T2 資源回收才會 dispose 長期 blocked 的)。
- **一個 member 同時只有一個 session**(現況 `memberSessions` 的約束)⇒ 短命 member **同時只能承接一個任務**。多任務並行需要多個 member。

---

## 4. 「對方不在線」是一等公民(A4 的關鍵要求)

短命 worker 意味著**訊息的目標可能不存在**。三種情況:

| 情況 | 處理 |
|---|---|
| 目標長命且 idle/busy | 走 S2/現況投遞策略(立即注入 / 排隊) |
| 目標短命但**當前有 session** | 同上 |
| 目標短命且**已 dispose** | **落持久 Mailbox**(`deliveredAt IS NULL`),下次該 member spawn 時由 `member-session-ready` 補投——**現況已有此機制**,S2 讓它跨崩潰存活 |

- **關鍵**:訊息**不會因為對方不在而失敗**,只是延遲。這讓「短命 worker」不破壞協作語意。
- **但要誠實**:延遲可能很長(對方可能永遠不再被指派任務)。故:
  - 群聊視圖應標示「**待送達**」狀態,人看得到訊息卡住了。
  - 長期未送達的訊息由 S3b 的提醒機制涵蓋(等待類的 T1 通知)。

---

## 5. 與 context 成本的關係(呼應 S3b)

短命 worker 是**成本治理的結構性手段**,不只是架構潔癖:

- 長命 agent 的 context 每輪都在增長 → 每次呼叫的 input token 單調上升 → **成本隨時間超線性成長**。
- 短命 worker 每個任務從零開始 → 成本與任務複雜度成正比,**不隨團隊運行時間累積**。
- ⇒ 在 S3b 的預算視角下,**把 worker 設成短命,是降低長期成本最有效的單一決定**。
- **外部記憶讓這個決定沒有代價**:短命不再等於失憶(§2.1),所以「為省成本而短命」不必犧牲知識連續性。長命的 Lead 也靠 §2.2 的閾值重啟避免無限膨脹。

---

## 6. 失敗模式

| 情境 | 行為 |
|---|---|
| 短命 worker 在任務中途崩潰 | 走 S6:標 interrupted,進復原視圖人工分流(**不自動重 spawn**)。 |
| 任務 done 但 dispose 失敗 | 記稽核 + 標記;session 留著不算災難(下次指派前會先檢查)。 |
| 長命 agent 的 context 撐爆 | **§2.2 閾值 checkpoint 重啟**(寫檔案記憶 → dispose → 重 spawn 讀回)。知識不損失,只損失未寫下的隱性 context。 |
| dispose 前 agent 未寫檔案記憶 | 該次的隱性知識遺失(可接受);**dispose 前應提示 agent 寫記憶**(見 §8)。 |
| 檔案記憶被 agent 寫壞/寫入錯誤事實 | 記憶在 git 裡 → **可 diff、可 review、可 revert**,與錯誤程式碼同等處理(這正是選檔案層的理由)。 |
| 短命 member 被指派第二個任務(前一個未結束) | 拒絕指派並明確報錯(一 member 一 session 的約束)。 |
| 訊息送給一個「永遠不會再 spawn」的 member | 留在 Mailbox;由群聊視圖的「待送達」標示 + 人工清理。 |

---

## 7. 對應 L1 決策

**A4**(角色決定生命週期;投遞層把「對方不在線」當一等公民)· 呼應 **A1**(階層骨架中 worker 是可拋棄執行單位)· 支撐 **E**(成本治理的結構性手段,§5)· 與 **S2**(持久 Mailbox)、**S6**(共用「接手」機制)協同。

---

## 8. 開放問題(留給 L4 / 後續)

1. **檔案記憶的約定**:位置(`.deskmony/notes/`?)、檔案組織方式、spawn 時如何指路(system prompt 指路 vs 注入摘要)。
2. **context 閾值怎麼測** → ⚠️ **部分解答,且對主力後端不成立(2026-07-27 實測修正)**:
   - ACP 協議**定義**了 `usage_update: { used, size }`,`used/size` 即 context 使用率——**若 agent 有送**。
   - **但實測證實:Claude Code 經 ACP bridge 從頭到尾一次都不送 `usage_update`**(結構上不會發生,非偶發)。見 [S3a L4 §7](../LAYER-4-detail-design/usage-metering_detail.md)。
   - ⇒ **對 Claude Code-over-ACP,本題仍無答案**;S8 的 checkpoint 重啟需另尋訊號。
   - **可行路線**:走 `ClaudeAgentSdkAdapter`(SDK 直接給 `usage` 明細),或由 Deskmony 自行累計估算。
   - 其他 ACP agent(Gemini CLI 等)**可能**有送,未測。
   - 閾值取值(建議 80–85%,留重啟緩衝)在拿得到訊號的後端才適用。
3. **dispose 前的「交接」**:是否強制要求 agent 先寫記憶再 dispose?若 agent 不配合怎麼辦?
4. **`lifecycle` 的預設對應**:Lead 必然長命(在線可達);Reviewer 該長命嗎?(依「是否需隨時回應」判斷,不再依「是否需要記憶」。)
5. **一 member 一 session 的約束是否該放寬**:允許一 member 同時跑多任務?會牽動 `memberSessions` 結構與訊息路由。
6. **結構化記憶層的觸發時機**:累積多少檔案記憶後,才值得從中萃取 schema?

---

> **S8 grill 已完成(2026-07-24)**,4 項定案:
> ① **外部記憶(§2.1)**——修補「長命是空頭承諾」的核心漏洞:記憶移出 context,長命才真的可實現。
> ② **兩層記憶分期**:檔案層 Phase 2(零新機制、人類可讀、進 git);結構化層延後——**用真實累積的筆記決定 schema,不用想像**。
> ③ **長命的理由改寫為「在線可達」,不是「記憶」**——外部記憶讓「為記憶而長命」失效;協調者必須在線,worker 不在線無妨。這也讓 §4「對方不在線」更聚焦。
> ④ **context 閾值 checkpoint 重啟(§2.2)**——重用 S6 的「接手」機制,知識在檔案裡故重啟不損失。
> **下一步**:S5(Lead + dispose-gate)—— Phase 2 最後一份,也是 L3 的最後一份。
