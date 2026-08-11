# S8 Detail Design:Agent 生命週期 + 外部記憶(檔案層)

> 上層:[S8 HLD](../LAYER-3-hld/agent-lifecycle_hld.md)｜階段:**Phase 2**
> 前置:[S6 L4](./crash-recovery_detail.md)(「接手」機制已實作,§2.2 直接複用)、[S2 L4](./message-budget_detail.md)(contextId 推導依賴 member↔task 綁定)、[S3a L4](./usage-metering_detail.md)(`context-usage` 事件)
> L4 完成度標準:**另一個工程師照著寫,不用問你**。

---

## 0. 現況(已查證)

| 事實 | 位置 | 含意 |
|---|---|---|
| `TeamMemberSchema` **沒有 `lifecycle` 欄位** | `packages/shared/src/team.ts` | 需新增 |
| `assignTask()` **只建 worktree,不 spawn session** | `apps/core/src/tasks/task-service.ts` | 短命 worker 的自動 spawn 是淨新增 |
| session 建立/dispose **全是手動** | `SessionManager` | 目前實質上「全部長命」 |
| **S6 已實作「接手」**(新 session + 注入摘要) | `apps/core/src/recovery/` | §2.2 的 checkpoint 重啟**直接複用,不重寫** |

---

## 1. `lifecycle` 欄位

```ts
// packages/shared/src/team.ts —— TeamMemberSchema 新增
/** persistent = 長命(為了「在線可達」,不是為了記憶,見 HLD §2.0);
 *  ephemeral  = 隨任務生滅。預設由 role 推導(§1.1),可明確覆寫。 */
lifecycle: z.enum(["persistent", "ephemeral"]).default("ephemeral"),
```
DB:`team_members` 加 `lifecycle TEXT NOT NULL DEFAULT 'ephemeral'`(冪等建欄)。

### 1.1 預設推導(依「是否需隨時回應」,**不是**「是否需要記憶」)

```ts
role 含 "lead" / "pm" / "架構" / "協調"(不分大小寫) → "persistent"
其餘(Coder / Reviewer / QA …)                      → "ephemeral"
```
> **理由(HLD §2.0 的核心修正)**:外部記憶(§3)讓「為記憶而長命」的理由消失。長命唯一的正當理由是**協調者必須隨時能回應隊友**;worker 不在線完全可接受(訊息落 Mailbox,S2 已實作)。

**遷移**:既有 member 一律 `ephemeral`,**但不自動 dispose 任何現存 session**——遷移只改預設值,不改變正在跑的東西。

---

## 2. 短命 worker 的自動生命週期

### 2.1 自動 spawn(指派時)

在 `assignTask()` 建完 workspace **之後**:
```
若 member.lifecycle === "ephemeral":
   若該 member 已有活躍 session → **拒絕指派**並明確報錯
       (「成員 X 目前已在任務 Y 上,一個成員同時只能承接一個任務」)
   否則 → SessionManager.createSession({ profileId: member.agentProfileId,
                                          workingDir: workspace.worktreePath,
                                          teamMemberId: member.id })
若 member.lifecycle === "persistent": **不做任何事**(長命 session 由人或團隊啟動時建立)
```

**失敗處理**:spawn 失敗時**整個指派回滾**(任務退回 `backlog`、清掉 workspace),不留下「已指派但沒有 agent」的半狀態。

### 2.2 自動 dispose(任務終態)

在 `updateStatus()` / `mergeAndComplete()` 進入終態時:

| 任務新狀態 | 對 ephemeral member 的 session |
|---|---|
| `done` | **dispose**(釋放子程序),session 標 `closed` |
| 人工放棄(`deleteTask`) | **dispose** |
| **`blocked`** | ⚠️ **不 dispose**——它可能回到 `in-progress`。長期 blocked 由 **S3b 的 T2 資源回收**處理(既有機制,勿重複實作) |
| `review` / `merging` | 不 dispose(可能被退回) |

### 2.3 一 member 一 session 的約束

沿用 `SessionManager` 既有的 `memberSessions: Map<memberId, sessionId>`。**本輪不放寬**——放寬會牽動 S2 的 contextId 推導(§0 前置)、訊息路由、以及 `memberSessions` 的資料結構,超出本 spec。

---

## 3. 外部記憶:檔案層(HLD §2.1)

**這是本 spec 的核心**——它讓「長命」從空頭承諾變成可實現的東西。

### 3.1 約定位置

```
<team.workingDir>/.deskmony/notes/
├── team.md              # 全隊共用:專案慣例、決策紀錄
└── <member-name>.md     # 個人筆記
```

- **放在 team 的 workingDir(專案內),不是家目錄** —— 目的就是**進 git、可 diff、可 review、可 revert**(HLD §2.1:錯誤的記憶會像錯誤的程式碼一樣被抓到)。
- **不新增任何 MCP 工具**:agent 用**既有的檔案工具**讀寫。平台只負責「spawn 時指出該讀什麼」。
- ⚠️ **與 hard-deny 的關係**:`.deskmony/notes/` 在 worktree **之內**,故 S1 的「worktree 外寫入」hard-deny **不會**擋到它。但**家目錄的 `~/.deskmony/`(政策/設定)仍然是 hard-deny**——兩者名字像但完全不同,實作時勿混淆。

### 3.2 spawn 時指路(不是注入內容)

在 `systemPrompt` 尾端**附加**一段(不取代 profile 既有的 systemPrompt):

```
【團隊記憶】
你的團隊筆記位於 .deskmony/notes/(相對於工作目錄):
- team.md:全隊共用的專案慣例與決策紀錄
- <你的名字>.md:你的個人筆記
開始工作前先讀取相關筆記;學到值得跨任務保留的結論時,寫回筆記。
筆記會進 git,請像寫程式碼一樣審慎。
```

- **指路而非注入內容**:避免每次 spawn 都把整份筆記塞進 context(那等於沒有把記憶移出 context)。agent 自己決定要不要讀、讀哪些。
- `.deskmony/notes/` **不存在時自動建立**(含一個空的 `team.md`),避免 agent 因為路徑不存在而困惑。

### 3.3 明確不做(HLD §2.1 分期)

❌ **結構化記憶層 / `remember()` / `recall()` / 向量檢索** —— 延後。理由:**你還不知道 agent 實際會想記住什麼**;先建 schema 等於在沒有真實資料時猜。跑一陣子後從實際累積的筆記裡看出哪些是反覆查詢的事實,再據此設計。

---

## 4. Context 閾值 checkpoint 重啟(HLD §2.2)

### 4.1 訊號來源與**覆蓋率限制**

用 S3a 的 `context-usage` 事件:`used / size` 即使用率。

> ⚠️ **與成本斷路器完全相同的覆蓋率問題**([S3a L4 §7](./usage-metering_detail.md) 實測):
> **Claude Code 經 ACP 完全不送 `usage_update`** ⇒ **拿不到 `used`/`size`** ⇒ **這類 session 無法自動偵測 context 閾值**。
>
> | 後端 | 能自動 checkpoint? |
> |---|---|
> | Claude SDK | ✅(SDK 有 usage;且它本身也支援 resume) |
> | Claude Code 經 ACP | ❌ **不能** |
> | 其他 ACP agent | ❓ 視其是否送 `usage_update` |
> | PTY | ❌ |
>
> **UI 必須誠實揭露**:長命 member 若其後端無法回報 context,設定處要明示「此後端無法自動偵測 context 上限,需手動重啟」——**比照 S3b §0.2 的作法,不可靜默失效**。

### 4.2 觸發與動作

```
context-usage 事件 → used/size >= threshold(預設 85%)
  → 對該 session 注入一則 prompt:
      「你的 context 即將用盡。請把本次工作中值得跨任務保留的結論寫進
        .deskmony/notes/<你的名字>.md,只回覆『已寫入』即可。」
  → 等該回合結束(completed)
  → 呼叫 S6 既有的「接手」流程(新 session + 摘要),沿用同一個 DB session id
```

- **閾值 85%**:留 15% 給「寫筆記」那一輪本身用。
- **只觸發一次**:同一個 session 已觸發過就不再觸發(避免重啟迴圈);重啟後是新 session,計數歸零。
- **不強制**:agent 若不配合寫筆記,仍照常重啟——該次的隱性知識遺失(可接受,HLD §6)。

---

## 5. 失敗模式

| 情境 | 行為 |
|---|---|
| ephemeral member 被指派第二個任務 | **拒絕指派**並明確報錯(§2.1) |
| 自動 spawn 失敗 | **整個指派回滾**,不留半狀態(§2.1) |
| 任務 `done` 但 dispose 失敗 | 記 audit;session 留著不算災難(下次指派前會檢查) |
| 訊息送給已 dispose 的 ephemeral member | 留 Mailbox(`delivered_at IS NULL`),下次 spawn 補投——**S2 既有機制** |
| 該 member 永遠不再被指派 | 訊息永遠留 Mailbox;群聊視圖應標「待送達」 |
| 後端不報 context | 無法自動 checkpoint;UI 明示(§4.1) |
| `.deskmony/notes/` 被 agent 寫壞 | **在 git 裡** ⇒ 可 diff / review / revert(這正是選檔案層的理由) |
| 長命 member 的 session 崩潰 | 走 S6 對帳 → 復原視圖人工分流(**不自動重 spawn**) |

---

## 6. 實作檢查清單

- [ ] `packages/shared/src/team.ts` + `packages/db`:`lifecycle` 欄位(冪等建欄 + 既有資料預設 `ephemeral`)
- [ ] `TeamManagementDialog.tsx`:lifecycle 選擇 + §1.1 預設推導提示
- [ ] `task-service.ts` `assignTask()`:ephemeral 自動 spawn + 已有 session 則拒絕 + 失敗回滾
- [ ] `task-service.ts` 終態:`done`/放棄 → dispose;**`blocked` 不 dispose**(S3b T2 負責)
- [ ] `session-manager.ts`:spawn 時建立 `.deskmony/notes/` 並在 systemPrompt 附加指路段落(§3.2)
- [ ] `session-manager.ts`:接 `context-usage` → 85% 閾值 → 注入寫筆記 prompt → 回合結束後走 S6「接手」(§4.2)
- [ ] UI:長命 member 若後端無 context 回報,**明示無法自動 checkpoint**(§4.1)
- [ ] e2e(`scripts/e2e-agent-lifecycle.mjs`):
  - [ ] 指派 ephemeral → 自動 spawn;任務 done → 自動 dispose
  - [ ] `blocked` **不** dispose
  - [ ] 同一 ephemeral member 被指派第二個任務 → 拒絕
  - [ ] spawn 失敗 → 指派回滾(任務回 backlog、無殘留 workspace)
  - [ ] 訊息送給已 dispose 的 member → 留 Mailbox,下次 spawn 補投
  - [ ] `.deskmony/notes/` 自動建立且 systemPrompt 含指路段落
  - [ ] context 達 85% → 觸發寫筆記 + 接手重啟,**且只觸發一次**

---

> **驗收核心**:①ephemeral 的 spawn/dispose 全自動且失敗可回滾;②長命 agent 的 context 不再是空頭承諾(能 checkpoint 重啟,拿不到訊號時**誠實揭露**而非靜默失效)。
