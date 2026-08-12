# S12 Phase 2 — Round 4：`send_to_subagent`(父對已存在的子 agent 追加訊息)

> 上層：S12 + [Phase 2 R1](./session-subagents-phase2_detail.md)（子完成回注父）+
> [R2](./session-subagents-phase2-r2_detail.md)（`spawn_subagent` 工具）。
> 階段：跨 package（shared / adapters / core）的加法，非破壞性。
> 對應實作者：Claude（Sonnet 5，本輪規劃與實作由同一個 session 直接完成，未經 Fable/Sonnet
> 分工）。2026-08-12 完成，已用真實 Claude 憑證做 live smoke test（非 fake backend）。

---

## 0. 動機與範圍

觸發：使用者問「父對話要如何送訊息到子對話」。查證既有程式碼後發現：R2 讓父 agent 能
`spawn_subagent` 開新的子任務，但子 agent 一旦開始跑，**父完全沒有回頭跟它說話的管道**
——`subagent-mcp.ts` 只有 `spawn_subagent`（開新的）跟 `list_profiles`（查詢），父只能
開新的子、無法對舊的子追加指示。人類倒是可以（子 session 是完全正常、未被鎖住的
session，UI 側欄直接點進去打字就行），但這是「人類繞過父直接跟子對話」，不是「父送
訊息給子」。

這輪補上父側的對稱能力：`send_to_subagent(childSessionId, message)`。

**範圍**：
- ✅ shared `SubagentPort` 新增 `sendToChild()`。
- ✅ adapters `subagent-mcp.ts` 新增第三個工具 `send_to_subagent`（**不**進
  `allowedTools`，同 `spawn_subagent` 走既有權限彈窗——理由同 spawn_subagent：會讓
  某個 session 多跑一輪、燒 token）。
- ✅ core `SessionManager` 新增 `sendToChildFromTool()`。
- ✅ 把 R1 的 `deliverInjectionToParent()` / `pendingParentInjection` 重新命名為通用的
  `deliverPromptWhenIdle()` / `pendingIdleInjection`——這兩個方法/欄位的邏輯本來就與
  「父/子」無關（純粹是「把一段文字當 prompt 投遞給某個 sessionId，尊重它是否忙碌」），
  只是命名被 R1 的第一個用途（子→父）綁死了。R4 直接重用同一套機制（父→子），只是
  改名讓兩邊都讀得通，**沒有新增第二套排隊邏輯**。
- ❌ 不做 UI——人類已經可以直接點進子 session 的聊天視窗跟它對話，不需要透過父中繼。
- ❌ 不做「同步等子回覆」——`send_to_subagent` 呼叫完立刻回傳「已送出」，子的回覆一樣
  經由既有的 `completed` → `child-result` 機制非同步回來，同 `spawn_subagent` 的既有
  語意（回傳的是「已建立/已送出」，不是任務結果本身）。

---

## 1. `packages/shared/src/subagent.ts`

`SubagentPort` 新增一個方法：

```ts
sendToChild(input: { parentSessionId: string; childSessionId: string; message: string }): Promise<void>;
```

`parentSessionId` 同 `spawnChild()`：由 adapter 端以自己的 `handle.id` 帶入，agent 不可
指定（閉包捕捉，防冒名）。`childSessionId` 由 agent 自己記得（`spawn_subagent` 回傳過）。

---

## 2. `packages/adapters/src/subagent-mcp.ts`

新增第三個 `tool()`，`childSessionId` + `message` 兩個必填參數。工具說明文字裡明講「只能
對你自己開過的子 agent 送訊息，對別的 sessionId 會被拒絕」，讓 agent 對授權邊界有預期，
遇到拒絕時知道原因、不會誤以為是系統壞了。

`SUBAGENT_TOOL_LOCAL_NAMES` 加入 `"send_to_subagent"`；`SUBAGENT_ALLOWED_TOOL_NAMES`
**不動**（仍然只有 `list_profiles`）。

---

## 3. `apps/core/src/session/session-manager.ts`

### 3.1 `sendToChildFromTool()`（新增，緊接在 `spawnChildFromTool()` 之後）

三層檢查，順序刻意如下：

1. `childSessionId` 對應的 session 不存在 → 明確報錯。
2. 存在，但 `parentSessionId` 不等於呼叫端帶入的 `parentSessionId` → 拒絕（**授權
   檢查**：只認「直接子」這一層關係，不接受祖父/兄弟/完全無關的 session，同
   `spawnChildFromTool()` 的冒名防護精神）。
3. 通過授權檢查，但那個子 session 目前沒有在跑（`this.runtime` 沒有它——可能已被 S3b
   的 72 小時資源回收站起，或已被刪除）→ 明確報錯，而不是讓底層的
   `deliverPromptWhenIdle()` 靜默丟棄訊息卻讓這次工具呼叫看起來像成功了（那樣 agent
   會誤以為訊息真的送到了）。

通過後才呼叫 `deliverPromptWhenIdle(childSessionId, message)`。

### 3.2 `pendingParentInjection` → `pendingIdleInjection`、`deliverInjectionToParent()` →
### `deliverPromptWhenIdle()`

純重新命名 + 註解更新，行為零變動。已確認的呼叫點（`completed` case 的 R1 注入、
`completed` case 的 flush 迴圈、4 個生命週期清理點：`deleteSession`/
`disposeSessionForMember`/`shutdownAll`/`reclaimSession`）全部同步改名。

---

## 4. `apps/core/src/index.ts`

`claudeAdapter.setSubagentPort({...})` 加一行：
`sendToChild: (input) => sessionManager.sendToChildFromTool(input)`。

---

## 5. 權限（同 R2 §4 的既有設計，這輪沒有放鬆）

`send_to_subagent` 刻意不進 `allowedTools`，走既有 `canUseTool` → `permission-request`
→ `PolicyEngine`（未分類 → default-deny → 升級給人）流程。無人值守時會 escalate 掛起
等人——本輪接受這個行為，同 `spawn_subagent`。

---

## 6. 驗收結果（實測，非假設）

跑過：
1. `pnpm build` → exit 0
2. `pnpm typecheck` → exit 0
3. `node scripts/e2e-session-subagents.mjs` → 8 PASS，0 FAIL（證明 R1 重新命名沒有
   打壞既有行為）
4. `node scripts/e2e-gateway.mjs --only=deterministic` → 141 PASS，0 FAIL（連跑兩次
   確認穩定；中間有一次因無關的環境時序問題出現 1 個偶發 FAIL，重跑即消失，不可重現，
   判定為既有測試基礎設施的既知 flake，非本輪改動導致）
5. **真實 Claude 憑證 live smoke test**（非 fake backend，直接對 `apps/core/dist/index.js`
   送真實 gateway RPC）：
   - **Test A**（idle 子的追加訊息）：父 `spawn_subagent` 開子（回覆 `ROUND1`）→
     結果注入父 → 父 idle 後呼叫 `send_to_subagent` 對同一個子追加訊息（要求回覆
     `ROUND2`）→ 子正確收到、處理、回覆 `ROUND2` → 新的 `child-result` push + 正確
     再次注入父對話。全程 `permission-request` 正確跳出（`send_to_subagent` 確實
     沒有被 allowedTools 自動放行）。
   - **Test B**（授權邊界）：父對一個完全無關（非自己子）的 session id 呼叫
     `send_to_subagent` → 工具回傳 `isError:true` + 明確錯誤訊息「不是你的子
     session，無法送出訊息」→ agent 正確理解並如實回報失敗原因，沒有誤判成功。

> ⚠️ 如同 R2：MCP 工具的實際觸發本來就不是 CI 能跑的決定性測試，上面的 live smoke test
> 是用真實憑證手動跑的，不是 repo 的自動化 e2e 套件的一部分。

---

## 7. 回報摘要

- 改的檔案：`packages/shared/src/subagent.ts`、`packages/adapters/src/subagent-mcp.ts`、
  `packages/adapters/src/claude-sdk-adapter.ts`（只改一行註解）、
  `apps/core/src/session/session-manager.ts`、`apps/core/src/index.ts`。
- `send_to_subagent` 有沒有被放進 allowedTools：**沒有**（同 spawn_subagent）。
- 依賴方向：`packages/adapters` 只 import `@deskmony/shared` 的 `SubagentPort`，沒有
  import `apps/core`，守住既定方向。
- 沒有做 UI，沒有動 team-bus/看板。
- 自行取捨：`pendingParentInjection`/`deliverInjectionToParent` 重新命名為通用名稱
  （見 §3.2）——判斷這是實作這個功能「附帶但必要」的一部分（不重新命名的話，
  `pendingParentInjection.get(childSessionId)` 讀起來會很反直覺），不是無關的
  drive-by 重構，範圍僅限這一個檔案內的私有欄位/方法。
