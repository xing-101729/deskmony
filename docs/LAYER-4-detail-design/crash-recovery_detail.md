# S6 Detail Design:崩潰復原(對帳 + 人工分流)

> 上層:[S6 HLD](../LAYER-3-hld/crash-recovery_hld.md)｜階段:**Phase 1 最後一份**
> 前置:[S3b L4 §4](./cost-governor_detail.md)(T2 資源回收已實作,語意需對齊)、[S7 L4](./auto-mode-and-yolo_detail.md)(暫態不復活)
> L4 完成度標準:**另一個工程師照著寫,不用問你**。

---

## 0. 現況(已查證)

### 0.1 shutdown handler 已存在,但不標記 session

`apps/core/src/index.ts:330–338`:
```ts
const shutdown = (): void => {
  gateway.close();
  turnLimiter.dispose();
  waitingWatchdog.dispose();
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
```

⇒ **正常關閉時,DB 裡的 session 狀態原封不動留著 `busy`/`waiting`**,與崩潰後的殘留**長得一模一樣**。這正是 [HLD §2.1](../LAYER-3-hld/crash-recovery_hld.md) 說的「若只憑殘留狀態判定崩潰,每次正常關閉也會看到復原視圖 → 淪為天天跳的雜訊」。

### 0.2 啟動時沒有任何對帳

`main()` 只做:載入 config → seed profile → 建各服務 → 開 gateway。**沒有掃描孤兒 session。**

### 0.3 S3b 已建立「回收 ≠ 丟棄」的語意先例

`waiting-watchdog.ts` 的 T2 回收把 session 標成 `error`,錯誤訊息是:
> 「已閒置等待超過 72 小時,資源已自動回收(子程序已釋放);**任務與 worktree 仍保留,可重新建立 session 續行或放棄此任務**」

**S6 的復原視圖必須沿用同一套語意與措辭風格**,否則使用者會看到兩種不一致的「被中斷」說明。

---

## 1. session 狀態擴充

`SessionStatusSchema` 目前是 `["idle","busy","waiting","error"]`。新增兩個**終態**:

```ts
// packages/shared/src/session.ts
export const SessionStatusSchema = z.enum([
  "idle", "busy", "waiting", "error",
  /** 優雅關閉時主動標記 —— 啟動對帳據此判斷「不是崩潰」(§2) */
  "closed",
  /** 啟動對帳發現的孤兒 —— 子程序已隨 core 消失,等人分流(§3) */
  "interrupted",
]);
```

`sessions` 表另加兩欄(冪等建欄,比照 `ensureTasksAcceptanceColumn`):
```sql
interrupted_at INTEGER,      -- 對帳標記的時間
last_seen_at   INTEGER       -- 每次狀態變更時更新,供顯示「中斷前最後活動」
```

---

## 2. 優雅關閉:主動收尾(HLD §2.1)

擴充既有 shutdown handler(**保持同步 + 加上必要的 await**):

```
shutdown():
  1. gateway.close()                      // 先停止接受新請求
  2. turnLimiter/waitingWatchdog.dispose()
  3. await sessionManager.shutdownAll()    ← 新增
       對每個 runtime session:
         - adapter.dispose(handle)         // 釋放子程序
         - DB: status = "closed"
  4. process.exit(0)
```

**實作要點**:
- `process.on("SIGINT"|"SIGTERM")` 的 handler **改為 async**,並在完成後才 `process.exit(0)`。
- **加逾時保護**:整個 `shutdownAll()` 最多 **5 秒**;超時就放棄剩餘的、直接退出(**寧可留下孤兒被對帳,也不要卡住不關**)。
- Windows 上 `SIGINT` 行為與 POSIX 不同,但既有程式碼已用這組事件,**沿用即可**,不在本 spec 擴大範圍。

⇒ **「沒被標成 `closed`」就是崩潰的定義。** 強制關機/斷電時 handler 跑不到,分類正確。

---

## 3. 啟動對帳(HLD §2)

在 `main()` 建完服務、**開 gateway 之前**執行:

```
reconcileOnStartup():
  找出 status ∈ {idle, busy, waiting} 的所有 session   // 註:idle 也算,見下
    → 這些子程序必然已死(隨 core 一起消失)
    → status = "interrupted", interrupted_at = now
    → 記 audit(kind: "decision" 不適用 → 用新的 audit 類別或 console，見 §6.3)
  回傳:被標記的數量,供啟動摘要輸出
```

**為何 `idle` 也算孤兒**:`idle` 只代表「該 session 上一輪結束了」,它的**子程序仍然活著**(等下一個 prompt)。core 一死,子程序也沒了。所以 `idle` 同樣是孤兒,只是它沒有「做到一半」的工作。

**`error` 與 `closed` 不動**:前者已是失敗終態(含 S3b 的 T2 回收)、後者是正常關閉。

---

## 4. 兩種恢復,必須分別命名(HLD §2.2)

**這是本 spec 最重要的誠實性要求。** adapter spawn 的是子程序,隨 core 而死 ⇒ **除非後端有磁碟持久化的 session,否則沒有記憶可續**。

| UI 名稱 | 實作 | 承諾 |
|---|---|---|
| **繼續(保有記憶)** | 用後端的 session id 重連磁碟持久化的 session | agent **記得**先前脈絡 |
| **接手(讀摘要重啟)** | 開**新** session + 注入摘要 | agent 的腦是**新的**,只讀過筆記 |

### 4.1 各後端支援哪一種(已查證,2026-07-29 實作回填)

| Adapter | 支援「繼續」? | 依據 |
|---|---|---|
| `ClaudeAgentSdkAdapter` | ✅ **支援,已實作** | 讀 `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` 確認:`Options.resume?: string`──「Session ID to resume. Loads the conversation history from the specified session.」session 預設落地到磁碟(`~/.claude/projects/...`,見 `deleteSession()`/`getSessionMessages()` 等匯出函式的官方註解),不是只存在單次 `query()` process 的記憶體。session id 來源:`SDKSystemMessage`(`type:'system', subtype:'init'`)帶 `session_id: string`,是這條連線最早、保證出現的訊息。**已實作**:`claude-sdk-adapter.ts` 捕捉 `session_id` 存進新欄位 `sessions.backend_session_id`,`spawn()` 新增 `resume?: ResumeOptions` 參數,`SessionManager.continueSession()` 用它重新 `spawn()` 並沿用既有 DB session id(見 apps/core/src/session/session-manager.ts)。**未查證/未覆蓋**:e2e 沒有用真實 Claude 憑證驗證這條路徑真的「記得」先前脈絡(需要真實 API/OAuth 憑證且非決定性,同既有 e2e-gateway.mjs「model-behavior 組有已知 flake」的既有風險接受範圍),只驗證了資料層(`backendSessionId` 捕捉、DB 落地、`canContinue` 計算)。 |
| `AcpAdapter` | ❌ **不支援(這輪)** | 讀 `node_modules/@agentclientprotocol/sdk/dist/acp.d.ts` 確認協議層**確實有** `session/load`(`loadSession()`),但文件明講「This method is only available if the agent advertises the `loadSession` capability」──是否支援**取決於被 spawn 的那個外部 agent**(Gemini CLI/Claude Code bridge/其他 ACP agent 各自不同),不是 adapter 層級的靜態能力。目前 `AcpAdapter` 完全沒有在 `initialize` 交握時記錄/暴露這個 per-agent capability,也沒有任何 session id 持久化機制。**依規格「查不到就標不支援,寧可少承諾」判定為不支援**——要做對需要新增「握手時讀取 agent 是否宣告 `loadSession` → per-session 動態能力(比照 `usageReporting` 三態的既有模式)」,判定为超出這輪範圍,留給未來輪次。 |
| `OpenCodeAdapter` | ❌ **不支援(這輪)** | 讀 `packages/adapters/src/opencode-adapter.ts` 確認:`opencode serve` 是**每個 session 各自 spawn 一個獨立子程序**(`spawn(command, args, { cwd: workspace.path, ... })`,沒有 `detached:true`),core 崩潰時這個子程序**不會**自動被清理(Node 的 `child_process` 預設不會在父行程死亡時自動終止子行程),但它的連線資訊(`baseUrl` 含隨機 port、`opencodeSessionId`)**只存在 adapter 的記憶體 `Map` 裡,完全沒有落地到 DB**──即使那個子程序真的還活著,重啟後的 core 也無從得知要連哪個 port、哪個 session id。**依規格判定為不支援**;若要支援,需要把 baseUrl/opencodeSessionId 持久化 + 子程序改用 `detached` 讓它在崩潰後仍可被外部重新發現,是比 Claude SDK 大得多的改動,這輪不做。 |
| `GenericPtyAdapter` | ❌ **確定不支援** | 純終端直通,無狀態可續(HLD 原文判斷,查證後維持不變)。 |

**UI 落實**:`RecoverySessionInfo.canContinue`(見 `packages/shared/src/recovery.ts`)由 `apps/core/src/recovery/recovery-service.ts` 的 `computeCanContinue()` 計算——`adapterType === "claude-agent-sdk" && backendSessionId 存在`。`apps/desktop/src/views/RecoveryView.tsx` 只在 `canContinue === true` 時渲染「繼續」按鈕,`false` 時**整個按鈕不出現**(不是灰掉)。

### 4.2 「接手」注入的摘要內容

```
【前次工作中斷】
任務:<title>
狀態:中斷於 <status>,時間 <interrupted_at>
已變更檔案:<git status --short 的前 20 行>
最後對話(最多 3 輪):<messages 表的末 3 筆 user/assistant>
```
- 上限 **4000 字元**,超過從最舊的對話開始截斷。
- 摘要**只讀 DB 與 git**,不呼叫 LLM(避免復原本身變成一次昂貴的推論)。

---

## 5. 復原視圖(HLD §3)

### 5.1 資料來源

新增 gateway method `recovery.list` → 回傳:
```ts
{
  sessionId, sessionTitle, profileName,
  status: "interrupted",
  interruptedAt, lastSeenAt,
  task?: { id, title, status },
  workspace?: { worktreePath, hadUncommittedChanges, changedFileCount },
  canContinue: boolean,   // §4.1 該後端是否支援「繼續」
}
```
`hadUncommittedChanges` **是既有機制**(`WorkspaceManager`),直接複用。

### 5.2 動作與對 worktree 的處理(HLD §3.1)

| 動作 | 前置條件 | 行為 |
|---|---|---|
| **繼續** | `canContinue` | 重連後端 session |
| **接手** | 一律可用 | 新 session + 注入摘要(§4.2) |
| **重跑** | **worktree 必須乾淨** | 見下 |
| **放棄** | 一律可用 | session 標 `closed`;**worktree 保留**(不自動刪) |

**「重跑」對髒 worktree 的強制流程**:
```
若 hadUncommittedChanges:
   → 先顯示 diff(既有 diff 檢視能力)
   → 使用者二選一:
       [保留] → git 建 wip 分支並 commit:  wip/recovery-<taskId>-<yyyymmddHHmm>
       [丟棄] → git reset --hard + git clean -fd   ← 需**明確二次確認**
   → 之後才能重跑
絕不默默在髒 worktree 上重跑。
```

### 5.3 `merging` 中崩潰:特別標示,不自動修復

若 task 狀態是 `merging`,該列**紅色警示**:「崩潰於合併中,git 可能處於中間狀態」,只提供「**檢查 git 狀態**」(顯示 `git status`),**不提供任何自動修復**(`merge --abort` 等由人自己決定)。

### 5.4 入口:常駐而非強制彈窗

有 `interrupted` session 時,**主畫面常駐一個提示條**(比照 S7 的 auto 常駐標記作風),點擊開啟復原視圖。**不強制彈窗**——使用者可先做別的事,但提示不會消失,避免遺忘(HLD §6 最後一列)。

---

## 6. 失敗模式

| 情境 | 行為 |
|---|---|
| 對帳時 DB 損毀 | **啟動失敗並明確報錯**,不帶著壞資料啟動(同 config 損毀的既有作風) |
| 「繼續」失敗(後端連不上) | 標 `error`,退回復原視圖,提示改用「接手」/重跑/放棄 |
| worktree 已被外部刪除 | 標示「worktree 遺失」,只提供「放棄」 |
| shutdown 逾時(>5s) | 放棄剩餘 dispose 直接退出;**下次啟動視為崩潰**(保守方向正確) |
| 大量孤兒(如 20 個) | 對帳批次 UPDATE,**不阻塞啟動**;視圖分頁 |
| 使用者忽略復原視圖 | 允許;但 §5.4 的提示條持續可見 |

### 6.3 audit 記錄
對帳結果寫入 `enforcement_audit`,沿用 S11 新增的 `kind: "notification-failed"` 那種「非 EnforcementEvent union」的作風,新增 `kind: "recovery-reconcile"`(payload 存被標記的 session 數與 id 清單)。**不擴充 S1/S2/S3b 共用的 `EnforcementEventSchema` union。**

---

## 7. 明確不做

- ❌ **自動續接任何 mid-flight 任務**(D3 明令禁止)
- ❌ 重建 agent 推理狀態(做不到,D1)
- ❌ 完整 event sourcing(D1 否決)
- ❌ **Mailbox 持久化**(D4 決策不變,但實作**移交 S2 / Phase 2**,見 HLD §4)

---

## 8. 實作檢查清單

- [x] `packages/shared/src/session.ts`:`SessionStatusSchema` 加 `closed` / `interrupted`(另加 `interruptedAt`/`lastSeenAt`/`backendSessionId` 三個欄位,見該檔案)
- [x] `packages/db`:`sessions` 加 `interrupted_at` / `last_seen_at`(冪等)——另加 `backend_session_id`(§4.1「繼續」實作需要,見 `ensureSessionsRecoveryColumns()`)
- [x] `apps/core/src/session/session-manager.ts`:`shutdownAll()`、`reconcileOnStartup()`、`last_seen_at` 更新(於 `setStatus()`)——另加 `continueSession()`/`abandonInterruptedSession()`/`takeoverWithSummary()`/`listInterruptedSessions()`
- [x] `apps/core/src/index.ts`:shutdown handler 改 async + 5 秒逾時;`main()` 開 gateway 前呼叫對帳 + 印摘要 + 寫入 `recovery-reconcile` 稽核
- [x] **查證各後端是否支援「繼續」並回寫 §4.1**——Claude Agent SDK 支援且已實作,ACP/OpenCode/PTY 皆不支援(理由見 §4.1)
- [x] 「接手」摘要組裝(§4.2,只讀 DB + git,見 `RecoveryService.buildTakeoverSummary()`)
- [x] gateway:`recovery.list` / `recovery.continue` / `recovery.takeover` / `recovery.rerun` / `recovery.abandon`——另加 `recovery.gitStatus`(§5.2 diff 檢視 + §5.3 merging 檢查 git 狀態共用)、`recovery.resolveDirtyWorktree`(§5.2 保留/丟棄)
- [x] `RecoveryView.tsx` + 主畫面常駐提示條(`apps/desktop/src/App.tsx` 的黃色徽章)
- [x] 髒 worktree 的保留(wip 分支)/ 丟棄(二次確認)流程(`WorkspaceManager.commitDirtyToWipBranch()`/`discardDirty()`)
- [x] e2e(`scripts/e2e-crash-recovery.mjs`,14/14 通過):正常關閉 → `closed` 且**不出現在復原視圖**;kill -9 → `interrupted` 且出現;idle/busy/waiting 皆算孤兒、error/closed 不受影響;髒 worktree 擋重跑(含 diff 檢視 + 二次確認);`merging` 特別標示(`recovery.gitStatus` 查 baseDir);不支援「繼續」的後端(ACP)`recovery.continue` 明確拒絕、`canContinue=false`

---

> **驗收標準**:`closed` 與 `interrupted` 必須能被 e2e **明確區分**——這是本 spec 的核心價值(避免復原視圖淪為天天跳的雜訊)。
