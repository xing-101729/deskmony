# S12 Detail Design：Session 子 agent（parent → child session）

> 上層依據：DECISIONS.md A1（混合協作：階層骨架）、A4（角色決定生命週期）。
> 階段：**新增能力**，加法式、非破壞性。
> L4 完成度標準：**另一個工程師照著寫，不用問你。**
> 對應實作者：`opencode/big-pickle`（在 paseo session 底下開的 coding agent）。

---

## 0. 動機與範圍決策

**要解決的事**：目前要讓多個 agent 協作，必須先建 Team → 加 TeamMember → 開 Task 看板。
使用者要的是更輕的模式：**在一個 session 裡直接 spawn 一個子 agent、給它一段
prompt、它跑完把結果回報到父 session**，完全不碰 Team / TeamMember / Task。
（語意上等同 paseo 的「在 session 底下 create_agent」。）

**範圍決策（重要，實作者不要擅自擴大）**：

- ✅ **本輪只做加法**：新增 `parentSessionId` 關聯 + `session.spawnChild` + 子 agent
  跑完把結果回報父 session 的通道 + 一支決定性 e2e。
- ❌ **本輪不動 Team / TeamMember / TaskService / MessageBus / 看板 任何一行**。
  它們保持原狀、原有 e2e 全部仍須通過。移除看板 UI 是**之後獨立的 Phase 2**，
  不在本 spec。
- ❌ **本輪不做 UI**（TaskBoardView / SessionList 的巢狀顯示留 Phase 2）。
  本輪的驗收完全靠 gateway + e2e，不靠畫面。
- ❌ **本輪不做「agent 自己呼叫工具 spawn 子 agent」**（team-bus 那種 MCP 工具）。
  spawn 由 gateway 呼叫端（人類 / e2e）觸發。agent 自主 spawn 是之後的事。

> 為何加法：這個 codebase 全程是「非破壞性、冪等遷移」的紀律（見 db/client.ts 的
> `ensureXxxColumn()` 慣例）。砍 team/看板會連帶打爛數十個 gateway 方法、e2e 與
> UI，風險與本輪目標不成比例。新 UX 用加法即可完全達成。

---

## 1. 資料模型：Session 多一個 `parentSessionId`

比照既有 `Session.model` / `backendSessionId` 這些 optional 欄位的**每一個接觸點**
照做（不要漏任何一處，否則 typecheck 會抓到）：

### 1.1 `packages/shared/src/session.ts`

- `SessionSchema` 新增：
  ```ts
  /** S12（session 子 agent）：這個 session 是被哪個父 session spawn 出來的。
   *  undefined = 頂層 session（非子 agent）。父子關係是一棵樹，child 本身也
   *  可以再 spawn 孫 session。 */
  parentSessionId: z.string().optional(),
  ```
- `CreateSessionInputSchema` 新增同名 optional 欄位（讓 `createSession()` 能把它
  一路帶下去）：
  ```ts
  parentSessionId: z.string().optional(),
  ```
- 新增 spawnChild 的輸入 schema（放這個檔案，與其他 session 輸入放一起）：
  ```ts
  export const SpawnChildSessionInputSchema = z.object({
    parentSessionId: z.string(),
    agentProfileId: z.string(),
    /** 省略時沿用父 session 的 workingDir。 */
    workingDir: z.string().optional(),
    title: z.string().optional(),
    /** 建立子 session 後立即送出的第一段 prompt（子 agent 的任務）。 */
    prompt: z.string().min(1),
  });
  export type SpawnChildSessionInput = z.infer<typeof SpawnChildSessionInputSchema>;
  ```

### 1.2 `packages/db/src/schema.ts`

`sessions` 表新增 nullable 欄位（比照 `model` / `backendSessionId`）：
```ts
parentSessionId: text("parent_session_id"),
```

### 1.3 `packages/db/src/client.ts`

新增冪等遷移 `ensureSessionsParentColumn()`，比照既有的
`ensureSessionsModelColumn()` / `ensureSessionsRecoveryColumns()` 寫法（`PRAGMA
table_info` 檢查欄位是否存在，缺了才 `ALTER TABLE sessions ADD COLUMN
parent_session_id TEXT`），並在既有那串 `ensureXxx()` 的呼叫處**一併呼叫一次**。
既有 row 會是 NULL，無破壞性。

### 1.4 `session-manager.ts` 的 `rowToSession()` / `sessionToRow()`

比照 `model` / `backendSessionId` 兩處：
- `rowToSession`：`parentSessionId: row.parentSessionId ?? undefined,`
- `sessionToRow`：`parentSessionId: session.parentSessionId ?? null,`

---

## 2. Core：`SessionManager` 的三處改動

### 2.1 `RuntimeState` 新增 `parentSessionId?: string`

（比照既有 `teamMemberId?` 的作法——存在 RuntimeState 上，`completed` 事件到達時
不必再查一次 DB。）

### 2.2 `createSession()` 接受並寫入 `parentSessionId`

- 組 `session` 物件時帶上 `parentSessionId: input.parentSessionId`。
- `this.runtime.set(...)` 時帶上 `parentSessionId: input.parentSessionId`。
- 其餘邏輯（adapter 選擇、consumeEvents、emit）完全不變。
- **不要**動 teamMemberId 那條路徑——parentSessionId 與 teamMemberId 正交，一個
  session 理論上兩者都可以有（本輪不會同時用到，但不要互相排斥）。

### 2.3 新增 `spawnChild()`

```ts
/** S12：在一個既有 session 底下 spawn 一個子 session，並立即送出第一段 prompt。
 *  子 session 跑完（completed）時，會把結果回報回父 session（見 consumeEvents
 *  的 completed case）。父 session 必須目前正在跑（runtime 有對應 handle）。 */
async spawnChild(input: SpawnChildSessionInput): Promise<Session> {
  const parent = await this.getSession(input.parentSessionId);
  if (!parent) throw new Error(`找不到父 session: ${input.parentSessionId}`);
  const child = await this.createSession({
    title: input.title ?? `子 agent（${parent.title}）`,
    agentProfileId: input.agentProfileId,
    workingDir: input.workingDir ?? parent.workingDir,
    parentSessionId: input.parentSessionId,
  });
  await this.sendPrompt(child.id, { text: input.prompt });
  return child;
}
```
> 不需要新的 in-memory「parent → children」Map：子 session 自帶 `parentSessionId`，
> 要列出某個父的子嗣直接 `listSessions().filter(s => s.parentSessionId === id)`。

### 2.4 `consumeEvents()` 的 `completed` case：把結果回報父 session

在既有 `completed` case **末尾**（`finalText` 已算好、`setStatus(idle)` 之後）加一段：
```ts
// S12：若這是子 session，把這一輪的最終結果回報回父 session：
//  (1) 在父 session 的聊天歷史留一則 system 訊息（人類重新載入 history 也看得到）
//  (2) emit "child-result" 讓所有 client 即時看到
if (runtime.parentSessionId && finalText) {
  const parentId = runtime.parentSessionId;
  const childTitle = (await this.getSession(sessionId))?.title ?? sessionId;
  await this.persistMessage(parentId, "system", `[子 agent 回報｜${childTitle}]\n${finalText}`);
  this.emit("child-result", {
    parentSessionId: parentId,
    childSessionId: sessionId,
    childTitle,
    finalText,
    ts: Date.now(),
  });
}
```
> **刻意不做**：不把 finalText 當 prompt 自動注入父 agent（那會讓父 LLM 自動接著
> 跑，是更強、更該獨立設計的行為）。本輪只「顯示 + 存歷史」，父 agent 不被自動
> 觸發。這是安全且可決定性測試的邊界。
> `finalText` 為空的一輪不回報（避免洗版空訊息）。

---

## 3. Gateway 協議

### 3.1 `packages/shared/src/gateway.ts`

- `ClientRequestSchema` 的 discriminated union 新增一條（放在 `session.*` 那群裡）：
  ```ts
  z.object({ ...baseRequest, method: z.literal("session.spawnChild"), params: SpawnChildSessionInputSchema }),
  ```
  （記得從 `./session.js` import `SpawnChildSessionInputSchema`。）
- 新增結果 schema：
  ```ts
  export const SessionSpawnChildResultSchema = z.object({ session: SessionSchema });
  ```
- `ServerPushSchema` 的 `channel` enum 新增 `"child-result"`。
- 新增 push payload schema：
  ```ts
  export const ChildResultPushSchema = z.object({
    parentSessionId: z.string(),
    childSessionId: z.string(),
    childTitle: z.string(),
    finalText: z.string(),
    ts: z.number(),
  });
  export type ChildResultPush = z.infer<typeof ChildResultPushSchema>;
  ```

### 3.2 `apps/core/src/gateway/ws-gateway.ts`

- 新增 `case "session.spawnChild"`：呼叫 `sessionManager.spawnChild(req.params)`，
  回 `{ session }`（比照既有 `session.create` 那個 case 的回傳形狀）。
- 訂閱 SessionManager 的 `"child-result"` 事件，`broadcast` 到 channel
  `"child-result"`（比照既有訂閱 `"session-updated"` / `"session-list-updated"`
  等事件轉 push 的寫法——**只送給已認證連線**，沿用既有 broadcast helper，不要
  自己重寫認證判斷）。
- `session.spawnChild` **不是** local-only（不加進 `LOCAL_ONLY_METHODS`）——它是
  日常操作，不是安全罩設定，本機/遠端皆可（比照 `task.approveReview` 的定調）。

---

## 4. 決定性 e2e：`scripts/e2e-session-subagents.mjs`

**骨架照抄 `scripts/e2e-gateway.mjs`**（core 子程序啟動、WS 連線、request/response
helper、PASS/FAIL 記錄、cleanup 都用同一套；可直接複製那支的前段工具函式）。
用**既有的**決定性假後端當後端——**不需要任何真實模型 / API key**。二選一：
`software:"opencode"` + `scripts/fake-opencode-server.mjs`（回覆 `FAKE_OPENCODE_REPLY_CHUNKS`），
或 `software:"acp"` + `scripts/fake-acp-agent.mjs`（回覆 `"Hello from fake ACP agent"`）。
建立 profile 時怎麼指向假後端，**直接照 e2e-gateway.mjs 裡既有的步驟抄**。

> 🚫 **絕對禁止新增任何 `AgentSoftware` 列舉值**（例如 `"fa:opencode"` 之類的
> test-only 假 software）。`AgentSoftwareSchema` / `AdapterRegistry` / `index.ts`
> **一行都不准動**。父與子都用同一個既有的 `software`（同一個 profile 即可）。
> 需要「決定性 child」時就用上面既有的假後端,不是造新 enum。

測試步驟與斷言（全部是 deterministic）：

1. 啟動獨立 core（專用 port + 專用 `DESKMONY_DATA_DIR` 暫存目錄），連線 + auth。
2. `profile.create`：`software:"acp"`，acpConfig 指向 fake-acp-agent。
3. `session.create`（父 session，用該 profile）→ 記 `parentId`。
   - 斷言：回傳的 session `parentSessionId` 為 undefined（頂層 session）。
4. 開始監聽 `"child-result"` push。
5. `session.spawnChild({ parentSessionId: parentId, agentProfileId, prompt: "任務" })`
   → 記回傳的 `child`。
   - **斷言 A**：`child.parentSessionId === parentId`。
   - **斷言 B**：`child.id !== parentId`。
6. 等 `"child-result"` push（設合理逾時，例如 15s）。
   - **斷言 C**：`payload.parentSessionId === parentId`。
   - **斷言 D**：`payload.childSessionId === child.id`。
   - **斷言 E**：`payload.finalText` 包含 `"Hello from fake ACP agent"`。
7. `session.history({ sessionId: parentId })`。
   - **斷言 F**：父 session 歷史裡有一則 `role:"system"` 訊息，content 含
     `"子 agent 回報"` 且含 `"Hello from fake ACP agent"`。
8. `session.list`。
   - **斷言 G**：清單同時含 parent 與 child，且 child 的 `parentSessionId === parentId`。
   - **斷言 H**：整個流程沒有建立任何 team / task（本輪不碰它們）——`team.list`
     回傳的 teams 為空陣列即可（純加法、沒動到 team 路徑）。
9. cleanup：kill core、刪暫存目錄。

腳本結尾比照 e2e-gateway.mjs：印出 PASS/FAIL 統計，**只要有一項 FAIL 就
`process.exit(1)`**，全 PASS 才 `exit(0)`。

---

## 5. 驗收（機器可驗證，實作者必須全部跑過才算完成）

在 repo 根目錄依序執行，三個都必須成功：

1. `pnpm build` → exit 0（apps/core/dist 有重新產出）。
2. `pnpm typecheck` → exit 0（**零** TS 錯誤；新增欄位的每個接觸點都補齊）。
3. `node scripts/e2e-session-subagents.mjs` → exit 0（所有 PASS）。

另外**不得回退既有行為**：
4. `node scripts/e2e-gateway.mjs --only=deterministic` 仍須通過（沒打壞既有 session/
   team/task 路徑）。若這支因本機缺真實模型憑證而有 model-behavior 項目失敗，只看
   `--only=deterministic` 這組。

---

## 6. 明確不做（Phase 2，本輪碰到請留 TODO，不要順手做）

- UI：SessionList 巢狀顯示子 agent、父 session 顯示 child-result 卡片。
- agent 自主 spawn（team-bus 那種 MCP 工具 `spawn_child`）。
- 父 session 自動把子結果當 prompt 續跑（orchestration）。
- 移除 Team / 看板 UI。
- 子 session 的成本/訊息預算歸屬到父（沿用既有各自獨立的 session 級預算即可）。

---

> **驗收核心**：①能在一個 session 底下 spawn 子 session（parentSessionId 正確落地）；
> ②子 session 跑完，結果透過 `child-result` push + 父 session 歷史 system 訊息回報；
> ③完全沒動到 team/看板，既有 deterministic e2e 不退步。
