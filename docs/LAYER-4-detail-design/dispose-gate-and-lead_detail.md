# S5 Detail Design:Lead(AgentProfile)+ dispose-gate(收斂閘)

> 上層:[S5 HLD](../LAYER-3-hld/dispose-gate-and-lead_hld.md)｜階段:**Phase 2 最後一份**
> 前置:[S4 L4](./acceptance-gate_detail.md)(Runner 已實作;**強制半原本就延到 Phase 2 = 本 spec**)、[S8 L4](./agent-lifecycle_detail.md)(Lead = persistent)、[S2 L4](./message-budget_detail.md)(Lead 發訊息受 context 預算)
> L4 完成度標準:**另一個工程師照著寫,不用問你**。

---

## 0. ⚠️ 查證結論:S5 最關鍵的閘**已經存在**

`apps/core/src/tasks/task-service.ts` 的 `tryApplyReportStatus()` **已經實作了「批准合併必須人類」**:

```ts
if (mapped === "done") {
  // M4 Round B 把關點:agent 無法透過 report_status(或包裝它的 request_review)
  // 把任務直接標記完成 —— "done" 只能由人類經 task.merge 觸發真正的 git 合併
  // 後才會轉換(見 mergeAndComplete() 的說明)。
  return { updated: false, skippedReason: `"done" 狀態需要人類透過 task.merge ...` };
}
```

⇒ **[HLD §2.1](../LAYER-3-hld/dispose-gate-and-lead_hld.md) 定案的唯一「人類必核」項目(批准合併),現況已經守住了。**

### 0.1 S5 的實際淨新增只剩兩件事

| 項目 | 狀態 |
|---|---|
| 批准合併需人類 | ✅ **已存在**(上述把關點 + `mergeAndComplete()`) |
| 指派 / 拆解自由(可撤銷) | ✅ **已是現況**(無閘) |
| **① 完成判定:有 `acceptance` 才機器自動放行** | 🔴 **淨新增**(= S4 的強制半,原本就延到 Phase 2) |
| **② Lead 作為 AgentProfile 的慣例** | 🔴 **淨新增**(prompt 契約 + 設定,非程式碼邏輯) |

> **這印證了 L2 的定性**:「Core 淨新增的只是薄的 dispose-gate」。實際上比「薄」還薄——**大半已經在了**。

---

## 1. 淨新增①:完成判定的機器裁決(S4 強制半)

### 1.1 閘的位置

[S4 L4 §0.1](./acceptance-gate_detail.md) 已定:**Gate 放呼叫端,不放 `TaskService.updateStatus()` 內部**(尊重既有「`updateStatus()` 只管轉換合不合法」的哲學)。

**兩個呼叫端都要掛**:

| 路徑 | 誰觸發 | 現況 | 本 spec |
|---|---|---|---|
| `tryApplyReportStatus()` → `in-progress → review` | **agent**(`report_status` / `request_review`) | 直接放行 | **加驗收閘** |
| gateway `task.updateStatus` → `in-progress → review` | **人類**(UI) | 直接放行 | **維持諮詢**(切片定案:人類驅動時不硬擋) |

> **為何只擋 agent 路徑**:S4 grill 定案「切片只做量測半(諮詢),硬擋延到 Phase 2 有 agent 自我推進時」。人類把卡拖到 review 是他自己的判斷,不需要系統硬擋;**agent 自稱完成才是 A3 要防的對象**。

### 1.2 裁決規則(HLD §2.2)

```
agent 請求 in-progress → review:
  ├─ task.acceptance 存在?
  │    ├─ 是 → 跑 AcceptanceRunner(既有)
  │    │        ├─ pass → 放行進 review
  │    │        └─ fail → **拒絕**,回傳逐條結果給 agent
  │    └─ 否 → **不放行**,轉為「等待人類核可」
  │              (escalate,走 S1 底座 + S11 通知)
```

**「無 acceptance → 人判」的實作**:
- 任務狀態**維持 `in-progress`**,另加一個標記(`awaitingHumanReview: boolean`,存 tasks 表)。
- 發 escalation 事件(底座)→ S11 通知人類。
- 人類在 TaskBoard 按「核准進入 review」→ 才轉換。
- **無人值守時**:比照 S11 §4 —— **不逾時拒絕**,一直等;由 S3b 的 T1/T2 兜底。

> **這讓 S4 的「可選驗收」產生真正後果**:寫了驗收條件 = 機器可代你判 = agent 能自主推進;沒寫 = 每次都要你點。**紀律靠誘因,不靠強制**(HLD §2.2)。

### 1.3 回給 agent 的錯誤必須可理解

驗收失敗:
> 「驗收未通過(`pnpm test` exit 1)。任務維持 in-progress。輸出末段:<outputTail>」

無 acceptance:
> 「此任務未定義機器驗收條件,已請求人類核可。你可以繼續補充或等待。」

---

## 2. 淨新增②:Lead 作為 AgentProfile(不是程式碼)

**L2 定性**:Lead 是 **AgentProfile(prompt/設定),不是 Core 模組**。若寫成 Core 程式,會蓋出確定性編排引擎,**正好違反 A2「LLM 提議」**。

### 2.1 Lead profile 的三個設定

| 元素 | 值 | 依據 |
|---|---|---|
| `TeamMember.lifecycle` | `persistent` | S8 §1.1(role 含 "lead" 自動推導) |
| `TeamMember.canInterrupt` | `true` | 既有欄位;協調者可打斷 worker |
| `AgentProfile.systemPrompt` | §2.2 的契約 | 本 spec |

### 2.2 systemPrompt 契約(提供一份可編輯的**範本**,不寫死在程式碼)

放 `docs/lead-prompt-template.md`,建 Lead profile 時由 UI 預填(使用者可改):

```
你是團隊的協調者(Lead)。

【你能自主做的】
- 把大任務拆成子任務(task.create)、指派給合適的隊友(task.assign)
- 用 send_message / request_review 與隊友溝通
- 讀寫團隊記憶 .deskmony/notes/team.md

【你不能做的】
- 你無法把任務標記完成或合併進主幹——那需要人類批准。
  你可以 report_status 回報進度,但 "done" 一律由人類執行合併。

【重要習慣】
- 指派前先 list_teammates 確認對方角色與是否在線
- 拆解任務時,盡量為每個子任務定義機器驗收條件(acceptance),
  這樣隊友完成後系統能自動驗收、不必等人核可
- 把決策理由寫進 .deskmony/notes/team.md,你的 context 會被定期重置
```

> 最後兩條是**設計意圖的直接傳達**:讓 Lead 主動寫 acceptance(§1.2 的誘因)、主動寫記憶(S8 的外部記憶前提)。

### 2.3 明確不做

❌ **不新增 `propose_*` MCP 工具**(HLD §4.1):閘掛在既有路徑上,agent 介面零變動、無法繞過。
❌ **不寫任何排程/編排演算法**。

---

## 3. 失敗模式

| 情境 | 行為 |
|---|---|
| Lead 做出爛拆解/爛指派 | **閘不擋**(可撤銷)——由人在看板退回,或由驗收閘與 merge-review 在下游攔截成果 |
| Lead 反覆提交驗收失敗的 review 請求 | 每次都跑驗收(有成本)⇒ **同一任務連續失敗 3 次後,改為直接拒絕並通知人類**,避免無限重試燒 CI |
| Lead 自己被指派任務並自評完成 | 仍須過驗收/人核可;**A2 禁止同一 LLM 既拆解又自評**,但這由 prompt 與人類監督處理,不由程式強制 |
| 沒有 Lead 的團隊 | **完全合法**——人類自己扮演 Lead(切片/Phase 1 就是如此)。**Lead 是可選的** |
| Lead 的 context 重置(S8 §4.2) | 走「接手」;待人核可的請求**留在閘上,不隨 Lead 消失** |

---

## 4. 實作檢查清單

- [ ] `packages/shared/src/task.ts` + db:`tasks` 加 `awaiting_human_review INTEGER`(0/1,冪等建欄)
- [ ] `task-service.ts` `tryApplyReportStatus()`:`in-progress → review` 時掛驗收閘(§1.2);有 acceptance 跑 Runner、無則設 `awaitingHumanReview` + 發 escalation
- [ ] 連續失敗 3 次 → 直接拒絕 + 通知(§3)
- [ ] gateway:`task.approveReview({ taskId })`(人類核可無 acceptance 的任務);**本機/遠端皆可**(這不是安全罩設定,是日常操作)
- [ ] `TaskBoardView.tsx`:`awaitingHumanReview` 的卡片顯示「等待你核可進入 review」+ 核可鈕
- [ ] `docs/lead-prompt-template.md` + `ProfileCreateDialog.tsx` 預填(role 含 lead 時)
- [ ] e2e(`scripts/e2e-lead-gate.mjs`):
  - [ ] agent `report_status(review)` + **有** acceptance 且通過 → 自動進 review
  - [ ] agent + 有 acceptance 但**失敗** → 拒絕,任務維持 in-progress,錯誤含輸出末段
  - [ ] agent + **無** acceptance → `awaitingHumanReview=true`,**不進 review**,發 escalation;人類 `task.approveReview` 後才進
  - [ ] **人類**經 `task.updateStatus` 走同一轉換 → **不受閘影響**(維持諮詢)
  - [ ] 連續 3 次驗收失敗 → 直接拒絕不再跑 Runner
  - [ ] **agent 仍無法把任務變成 `done`**(既有把關點不可退步)

---

> **驗收核心**:①agent 自稱完成必須過機器驗收或人類核可,無法自我背書;②既有的「done 需人類合併」把關點不退步;③Lead 的智慧全在 prompt,Core 沒有排程演算法。
