# S4 HLD:機器驗收閘(Acceptance Gate)

> 階段:**切片**(最小可選)｜對應 L1:**A3**｜上層:[L2 §3](../LAYER-2-design-spec.md)、[DECISIONS §A](../DECISIONS.md)
> 定位:讓「done」不再只靠 LLM 自我宣告與人眼——提供一道**機器可驗證**的檢查。
> **關鍵定性(S4 grill 定案)**:驗收閘是**快篩,不是正確性證明**——它抓明顯壞掉的東西,但可被 agent 從內部繞過(閹割測試,見 §5)。**真正的正確性靠山是人類 merge-review**(review→merging,DECISIONS 讓合併保持人核可正是為此)。

## 分階段範圍(measure-before-govern)

| 半 | 內容 | 階段 |
|---|---|---|
| **量測半** | 任務可定義驗收指令;能**跑它、顯示 pass/fail**;**諮詢性**(人自己決定拖不拖卡) | **切片** |
| **強制半** | pass/fail **硬擋** `in-progress → review` 轉換 | **Phase 2**(有 agent 經 `report_status` 自我推進時,閘才真正保護 A3) |

---

## 1. 職責邊界

**負責(切片,量測半)**:
- 在任務的 **git worktree** 內執行該任務定義的**驗收指令**(測試/build/typecheck/自訂),回傳 pass/fail + 輸出。
- **可選**:任務沒定義驗收條件 → 無事可跑,**退回人類判定**。
- 觸發:手動按鈕 + 拖向 review 時自動跑一次(**警告但不擋**,見 §3)。

**負責(Phase 2,強制半)**:
- 同一段閘邏輯掛上 `in-progress → review` 轉換:失敗**拒絕轉換**、留 in-progress。觸發點與切片相同,只把「警告」翻成「硬擋」。

**不負責**(明確劃出去):
- ❌ **判定合併**(`review → merging`)——人類批准閘(DECISIONS A2/C)。這才是正確性靠山。
- ❌ **定義驗收條件是什麼**——由人(或 Phase 2 lead 提議、人核可)設定;本閘只執行。
- ❌ **防竄改 / 證明正確**——閘是快篩,agent 可閹割測試繞過(§5)。

---

## 2. 對外介面

### 2.1 Task schema 擴充(`packages/shared/src/task.ts`)

`TaskSchema` 增加一個可選欄位:

```ts
/** 機器驗收條件;undefined = 無機器驗收,退回人類判定(A3 例外) */
acceptance: z.object({
  /** 依序執行的指令(全過才算過);空陣列視同 undefined */
  commands: z.array(z.string()).min(1),
  /** 每條指令逾時(毫秒);預設見 L4 */
  timeoutMs: z.number().optional(),
}).optional(),
```

> **完整性紀律(對齊 C3/policy)**:`acceptance` **只能由人設定(或 lead 提議→人核可),agent 不可寫**。否則 agent 可自設 `commands: ["echo pass"]` 自我背書,整個閘失效。寫入路徑必須擋 agent。

### 2.2 觸發點與執行(`apps/core/src/tasks/task-service.ts`)

核心是一個 `AcceptanceRunner(task.acceptance, workspace) → AcceptanceResult`,兩種入口:

- **手動**:UI「跑驗收」按鈕 → 呼叫 runner,回傳結果顯示。任何時候可按。
- **拖向 review 時**:`updateStatus(from=in-progress, to=review)` 內先跑 runner——
  - **切片(量測半)**:結果只是**警告**,`pass/fail` 都**放行**轉換(諮詢性)。
  - **Phase 2(強制半)**:`fail` → **拒絕轉換**、留 in-progress;`pass` → 放行。**同一個 hook,翻個開關**。
  - `task.acceptance` 不存在 → 無事可跑,直接放行(退回人類判定)。

### 2.3 結果型別(供 UI 與稽核)

```ts
AcceptanceResult = {
  passed: boolean;
  perCommand: { command, exitCode, durationMs, outputTail }[];  // outputTail = 末段輸出,非全量
  startedAt, finishedAt;
}
```

切片:結果隨轉換回應回傳給 UI 顯示(不落地);持久化留 S3b 風格的稽核延後。

---

## 3. 資料流(切片:諮詢 / Phase 2:硬擋)

```
手動鈕  ─┐
         ├─> AcceptanceRunner ── worktree 內依序跑 commands ──> AcceptanceResult
拖向     ─┘                          ┌───────────┴───────────┐
review                          全過 exit 0            任一非 0 / 逾時
                                     │                        │
      切片(諮詢) ────────────────  放行 + 顯示 pass    放行 + 跳警告(不擋)
      Phase 2(硬擋) ───────────────  → review           拒絕、留 in-progress + fail 明細
```

**觸發者隨階段演進,閘邏輯不變(關鍵設計)**:
- **切片**:觸發者 = **人類**(手動鈕 / 拖卡)。結果諮詢性,不擋。
- **Phase 2**:觸發者 = **agent** 的 `report_status(done)` 映射成「請求 in-progress→review」。此時同一 hook 硬擋——攔「agent 自稱完成、其實沒過」,正是 A3 核心。
- 兩者走**同一段** runner + `updateStatus` hook,不為 team-bus 另寫一套。

---

## 4. 失敗模式

| 情境 | 行為 |
|---|---|
| 任務無 `acceptance` | 放行,退回人類判定(A3 例外,合法路徑非錯誤)。 |
| 指令 exit ≠ 0 | 閘失敗,留 in-progress,回 AcceptanceResult 明細。 |
| 指令逾時 | 視同失敗(kill 子程序);`outputTail` 標記 timeout。 |
| worktree 不存在/毀損 | 閘**無法執行 = 失敗**(不可靜默放行);錯誤指向 WorkspaceManager。 |
| flaky 測試(偶爾失敗) | 閘如實回失敗;重試策略**不在閘內**(避免閘自作主張重跑遮蔽真問題),由觸發者/人決定重跑。 |
| 驗收指令本身具破壞性(如 `rm -rf`) | 見 §5 安全:指令是**人授權的可信基礎設施**,但仍在 worktree 邊界內跑;越界防護由 PolicyEngine(Phase 1)覆蓋。 |

---

## 5. 安全與信任模型(S4 grill 定案)

把「指令字串」與「執行」**分開看**——這是本 HLD 最關鍵的修正:

- **指令字串**:人授權、agent 不可寫(§2.1),與 **C3** 同紀律。故執行時**不逐次過 PermissionGateway**(否則每次驗收都要人再點,荒謬)。
- **執行**:驗收指令的本質是**跑 agent 剛寫的程式碼**(`pnpm test` 跑的是 agent 改過的測試)。所以「跑驗收」**永遠是一次 agent 程式碼執行**,必須像**任何 agent 工具執行一樣圍堵**:
  - 切片:worktree 邊界 + 有人看。
  - Phase 1:PolicyEngine 硬性 deny(越界刪除、非白名單外連)**照樣適用於驗收執行**。
  - 最終:沙箱(C7)。
- **可被繞過(§1 快篩定性的根據)**:agent 能合法改測試檔 / package.json 的 `test` script → 把驗收閹割成 `echo pass`。欄位不可寫擋不住這個。**故驗收 = 快篩,不是證明;正確性靠 review→merging 的人核可**。(Phase 2 增強:偵測並向 reviewer 標記「agent 改動了測試/驗收腳本」。)

**對應 A3**:本閘落地 A3 的「機器驗收」精神,但誠實承認其為快篩;A3 的收斂保證由「機器快篩 + 人類 merge-review」兩者合成,非單靠此閘。

---

## 6. 開放問題(留給 L4 / 後續)

1. **驗收條件放哪定義**:純 per-task,還是 team 層級模板(如「所有任務預設跑 `pnpm test`」)可繼承覆寫?
2. **pass 門檻**:全指令 exit 0 才過(目前假設);要不要允許「警告可過」的軟門檻?
3. **逾時預設值 / 輸出截斷長度**:L4 定。
4. **Phase 2 銜接**:`report_status(done)` 如何映射到「請求 in-progress→review 轉換」;lead 提議 acceptance 的核可流程 + 偵測測試被改的標記機制。

---

> **S4 grill 已完成(2026-07-24)**,4 項定案:①切片只做量測半(諮詢),硬擋延 Phase 2 ②指令字串可信不逐次彈權限,但執行是 agent 程式碼、照常圍堵 ③驗收=快篩非證明,人類 merge-review 才是正確性靠山 ④觸發=手動鈕+拖 review 自動跑(切片警告不擋,Phase 2 同 hook 翻硬擋)。
> **切片兩份 HLD(S3a + S4)完成。** 下一步:整體進 L4 detail design / 交 Sonnet 實作。
