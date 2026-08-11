# S4 Detail Design:機器驗收閘

> 上層:[S4 HLD](../LAYER-3-hld/acceptance-gate_hld.md)｜階段:**切片(量測半,諮詢性)**
> L4 完成度標準:**另一個工程師照著寫,不用問你**。

---

## 0. ⚠️ 與既有設計哲學的張力(L4 查證)

S4 HLD 說「閘掛在 `updateStatus` 的 `in-progress → review` 轉換上」。但 `task-service.ts` L29–42 的既有註解**明確拒絕**這種做法:

> 「這裡**刻意不在 `updateStatus()` 本身加上這個限制**(那會讓 `updateStatus()` 承擔它不該管的『是否真的合併了』語意),而是在唯一允許呼叫的兩個地方分別把關。」

既有哲學是:**`updateStatus()` 只管「狀態轉換合不合法」(`isValidTransition`),語意檢查放在呼叫端。**

### 0.1 解法:分離 Runner 與 Gate

| 元件 | 職責 | 放哪 |
|---|---|---|
| **`AcceptanceRunner`** | 純執行:跑指令、回結果。**無狀態機知識** | 獨立模組 `apps/core/src/tasks/acceptance-runner.ts` |
| **Gate(裁決)** | 決定「結果 pass/fail 要不要擋轉換」 | **呼叫端**(切片:UI/gateway;Phase 2:dispose-gate) |

**這同時解決兩件事**:
1. **尊重既有哲學**——`updateStatus()` 保持純淨。
2. **切片本來就不需要 Gate**(HLD 定案:量測半、諮詢性)⇒ 切片**只實作 Runner**,Gate 是 Phase 2 的事。

> **Phase 2 的 Gate 放哪**:依既有哲學放在呼叫端。S5 §4.1 說「閘掛在狀態轉換上是唯一入口、無法繞過」——L4 修正為:**收斂到 gateway 的 `task.updateStatus` 這個唯一對外入口**,而非 `TaskService.updateStatus()` 內部。既有註解已指出 gateway 方法是唯一能觸發的地方,語意等價且不破壞分層。

---

## 1. Task schema 擴充

```ts
// packages/shared/src/task.ts —— 加進 TaskSchema
/** 機器驗收條件;undefined = 無機器驗收(A3 例外,退回人類判定) */
acceptance: z.object({
  /** 依序執行,全部 exit 0 才算過。至少一條 */
  commands: z.array(z.string().min(1)).min(1),
  /** 每條指令逾時(毫秒),預設 §3 */
  timeoutMs: z.number().int().positive().optional(),
}).optional(),
```

**DB**:`tasks` 表加一欄 `acceptance TEXT`(JSON 字串,null = 無)。遷移:既有 row 一律 null(= 無驗收,退回人判),**無破壞性**。

**寫入路徑(完整性紀律,HLD §2.1)**:`acceptance` **只能由人設定**;**team-bus MCP 工具一律不得寫入**——agent 無法自設 `echo pass` 自我背書。

> ⚠️ **修正(實作回饋)**:本節原寫「gateway 的 `task.create`/`task.update` 接受此欄位」,但**此 codebase 根本沒有通用的 `task.update` method**——這是本文件的事實錯誤。
> **實際採用**:`task.create` 接受此欄位,另加一個**窄範圍**的 `task.setAcceptance(taskId, acceptance?)`(可傳 undefined 清除),**而非**新開一個能順便改 title/description 的通用 `task.update`。窄介面更符合「最小授權」與本 codebase 既有的 method 粒度。

---

## 2. AcceptanceRunner 介面

```ts
// apps/core/src/tasks/acceptance-runner.ts
export interface AcceptanceCommandResult {
  command: string;
  exitCode: number | null;      // null = 被 kill(逾時)
  timedOut: boolean;
  durationMs: number;
  outputTail: string;            // 末段輸出,見 §3
}
export interface AcceptanceResult {
  passed: boolean;               // 全部 exit 0 且無逾時
  perCommand: AcceptanceCommandResult[];
  startedAt: number;
  finishedAt: number;
  /** 未跑的原因(無 acceptance / worktree 遺失),passed 為 false 時可能有值 */
  skippedReason?: "no-acceptance" | "workspace-missing";
}

export class AcceptanceRunner {
  async run(task: Task, workspace: Workspace): Promise<AcceptanceResult>;
}
```

---

## 3. 執行細節(釘死)

| 項目 | 決定 |
|---|---|
| **cwd** | `workspace.worktreePath`(**絕不**用 team 的 baseDir——驗收必須跑在該任務的 worktree) |
| **shell** | Windows 用 `cmd.exe /c`,POSIX 用 `/bin/sh -c`。沿用既有 `resolveWindowsSpawnCommand` 的作風(見 opencode-adapter.ts) |
| **依序執行** | 前一條非 0 → **立即停止**,後續標記未執行(不列入 perCommand) |
| **逾時預設** | **10 分鐘**(600_000ms)/ 條。逾時 → kill 子程序樹 + `timedOut: true` |
| **輸出截斷** | 保留**末 8 KB**(stdout+stderr 合併)。理由:失敗訊息通常在尾端;避免把整份測試輸出灌進 WS/記憶體 |
| **env** | 繼承 `process.env`;**不注入** agent profile 的 env(驗收是人授權的基礎設施,不該帶 agent 的 API key) |
| **併發** | 同一任務同時只能跑一次驗收(以 taskId 加鎖);重複請求回「執行中」 |

**安全(HLD §5)**:指令字串人授權故不逐次過 PermissionGateway;但**執行是 agent 程式碼**,受 worktree 邊界約束,Phase 1 的 PolicyEngine 硬性 deny 對它照樣適用。

---

## 4. 觸發點(切片)

HLD §2.2 定兩個入口,切片**都是諮詢性**:

| 入口 | 實作 |
|---|---|
| **手動鈕** | 新增 gateway method `task.runAcceptance(taskId)` → 回 `AcceptanceResult`。TaskBoard 卡片上一個「跑驗收」鈕 |
| **拖向 review** | UI 在送出 `task.updateStatus(→review)` **之前**先呼叫 `task.runAcceptance`;**不論結果都繼續送出轉換**,失敗只跳警告 |

> **切片刻意把「先跑驗收」放在 UI 端**——這正是「諮詢性」的具體含義:Core 不強制,由呼叫端決定要不要看結果。Phase 2 要硬擋時,把這個判斷從 UI 移到 gateway 的 `task.updateStatus`(§0.1)。

**無 `acceptance` 時**:`task.runAcceptance` 回 `{ passed: false, skippedReason: "no-acceptance", perCommand: [] }`;UI 顯示「此任務未定義驗收條件」,**不當成失敗**。

---

## 5. UI(切片最小)

- **TaskBoard 卡片**:有 `acceptance` 的卡顯示一個小標記;「跑驗收」鈕;最近一次結果的 pass/fail 徽章(**ephemeral,同 S3a 不落地**)。
- **結果面板**:逐條指令的 exit code、耗時、`outputTail`(等寬字體、可捲動)。
- **拖向 review 且 fail**:跳一個**警告** toast(「驗收未通過,仍已移至 review」),**不阻擋**。

---

## 6. 對 HLD 開放問題的回答

| HLD 開放問題 | L4 回答 |
|---|---|
| #1 條件定義位置(per-task vs team 模板) | **切片只做 per-task**。team 模板延後——先看實際使用是否重複到值得抽象 |
| #2 pass 門檻(軟門檻?) | **全 exit 0 才過**,不做軟門檻。簡單且無歧義 |
| #3 逾時 / 截斷長度 | §3 已釘:10 分鐘 / 末 8 KB |
| #4 Phase 2 銜接 | §0.1 已定:Gate 收斂到 gateway `task.updateStatus`;`report_status(done)` 映射到同一入口 |

---

## 7. 實作檢查清單

- [ ] `packages/shared/src/task.ts`:`TaskSchema` 加 `acceptance`;`CreateTaskInput`/更新輸入同步
- [ ] `packages/db/src/schema.ts` + `client.ts`:`tasks` 加 `acceptance TEXT`
- [ ] `apps/core/src/tasks/acceptance-runner.ts`:新檔,§2/§3
- [ ] `apps/core/src/tasks/task-service.ts`:**不改** `updateStatus()`;加 `runAcceptance(taskId)` 委派給 Runner(取 workspace 後執行)
- [ ] `packages/shared/src/gateway.ts` + `ws-gateway.ts`:加 `task.runAcceptance` method 與結果 schema
- [ ] **確認 team-bus MCP 工具無法寫入 `acceptance`**(完整性紀律)
- [ ] `apps/desktop/src/views/TaskBoardView.tsx`:鈕、徽章、結果面板、拖曳前呼叫
- [ ] e2e:`scripts/e2e-gateway.mjs` 加一個「定義驗收 → 跑 → 斷言 pass/fail」的案例(用 `node -e "process.exit(0/1)"` 當確定性指令)

---

> **切片的 L4 到此完整**(S3a + S4)。下一步:交實作。
