# S12 Phase 2 — Round 1：子 agent 結果回注父 session

> 上層：[`session-subagents_detail.md`](./session-subagents_detail.md)（S12 Round 1 已完成）。
> 階段：**加法/演進**，非破壞性。
> L4 完成度標準：**另一個工程師照著寫，不用問你。**
> 對應實作者：opencode subagent（免費模型，例如 `opencode/deepseek-v4-flash-free`）。

---

## 0. 動機與範圍

S12 已能：父 session `spawnChild`（帶 prompt）→ 子 agent 跑完 → 結果透過 `child-result`
push + **父 session 歷史留一則 system 訊息**回報。

**這一輪要補的一件事**：讓子的結果**真正回到父 agent 的對話流**裡 —— 不只是「寫進父
的歷史等人看」，而是**當成一段 prompt 注入父 session，讓父 agent 能接著用這個結果繼續
工作**。這是「父 spawn worker → worker 回報 → 父據此繼續」這個編排迴圈的最後一環。

**範圍（不要擴大）**：
- ✅ 只改 `SessionManager`：把 S12 completed case 裡「回報父」的動作，從「persist 一則
  system 歷史訊息」**改成「把結果當 prompt 注入父 session」**（idle 就立刻送，busy 就排隊
  等父下一次空檔）。`child-result` push **保持不變**（UI 仍照收）。
- ❌ 不做 MCP 工具（agent 自主 spawn 是 Round 2）。
- ❌ 不做 UI（Round 3）。
- ❌ 不碰 team / task / 看板 / MessageBus。
- ❌ 不加任何新的 gateway 方法或 schema（協議零變動）。

---

## 1. 行為規格

子 session（`runtime.parentSessionId` 有值）收到 `completed`、且 `finalText` 非空時：

1. **仍然 emit `child-result` push**（payload 形狀不變，見 S12 §3.1）—— 這行不要動。
2. **不再** persist 那則 `role:"system"` 到父歷史（移除 S12 §2.4 的 `persistMessage(parentId,
   "system", …)`）—— 由下面的「注入 prompt」取代（`sendPrompt` 本來就會 persist 一則
   `user` 訊息，父歷史一樣看得到，不需要再多記一則 system）。
3. **把結果注入父 session**，注入文字：
   ```
   [子 agent「<childTitle>」完成回報]
   <finalText>

   請根據以上子 agent 的結果繼續你的工作。
   ```
   投遞規則（**必須依父 session 當下狀態決定**，不能無條件 sendPrompt —— 父可能正忙）：
   - 查父 session 目前狀態（`getSession(parentId)`）：
     - 父 **idle** 且 `runtime` 仍存在 → 立刻 `this.sendPrompt(parentId, { text })`。
     - 父 **busy / waiting** → **排隊**：存進新的 `pendingParentInjection: Map<parentId,
       string[]>`（一個父可累積多筆子回報），等父下一次 `completed` 時 flush（見 §2）。
     - 父 `runtime` 已不存在（父已被刪/結束）→ 丟棄注入，只留 `child-result` push 已發出的
       事實（不報錯）。

> **為什麼要排隊而不是直接 sendPrompt**：父正在跑一輪時 `sendPrompt` 會與正在跑的回合
> 競爭 / 被 cost 檢查擋。既有的 `contextCheckpointPendingNote`（S8）就是同一個「忙就等
> completed 空檔再送」的模式，**照抄那個模式**（見 session-manager.ts 的 `completed` case
> 與 `contextCheckpointPendingNote` 相關程式碼）。

---

## 2. 實作點（全部在 `apps/core/src/session/session-manager.ts`）

### 2.1 新增一個 pending 佇列欄位

比照既有 `contextCheckpointPendingNote`：
```ts
/** S12 Phase2：父 session 正忙時，暫存要注入父的子 agent 回報，等父下一次
 *  completed 空檔 flush。一個父可累積多筆（多個子先後回報）。 */
private readonly pendingParentInjection = new Map<string, string[]>();
```
並在 `deleteSession()` / `disposeSessionForMember()` / `shutdownAll()` / `reclaimSession()`
清除該 session 的 entry（比照那些方法對 `contextCheckpointState` 的清理，避免無限增長）。
可加一個 `private clearPendingParentInjection(sessionId)` 收斂。

### 2.2 改 `consumeEvents()` 的 `completed` case

目前 S12 的區塊（`if (runtime.parentSessionId && finalText) { persistMessage(parentId,
"system", …); this.emit("child-result", …) }`）改成：

```ts
if (runtime.parentSessionId && finalText) {
  const parentId = runtime.parentSessionId;
  const childTitle = (await this.getSession(sessionId))?.title ?? sessionId;
  // child-result push 不變（UI 用）
  this.emit("child-result", { parentSessionId: parentId, childSessionId: sessionId, childTitle, finalText, ts: Date.now() });
  // 取代原本的 system 歷史訊息：把結果注入父 session
  const injectText = `[子 agent「${childTitle}」完成回報]\n${finalText}\n\n請根據以上子 agent 的結果繼續你的工作。`;
  await this.deliverInjectionToParent(parentId, injectText);
}
```

**同一個 `completed` case 的最後**（父自己這一輪結束時），要 flush 排在它身上的 pending
注入 —— 在既有 `contextCheckpointPendingNote` 的 flush 邏輯**旁邊**加：如果
`this.pendingParentInjection` 有 `sessionId` 的佇列且此時父已回 idle，取出**第一筆**送出
（`sendPrompt`），其餘留著等下一輪（一次只送一筆，避免把多筆塞成一個回合）。務必與既有的
checkpoint pending/awaiting-restart 邏輯**互不干擾**（用獨立的 if 判斷，不要塞進同一個
if/else if 鏈，除非你確定語意不衝突）。

### 2.3 新增 `deliverInjectionToParent()`

```ts
/** S12 Phase2：把一段子 agent 回報投遞給父 session —— idle 立刻送，busy/waiting 排隊。 */
private async deliverInjectionToParent(parentId: string, text: string): Promise<void> {
  const parentRuntime = this.runtime.get(parentId);
  if (!parentRuntime) return; // 父已結束，丟棄
  const parent = await this.getSession(parentId);
  if (parent?.status === "idle") {
    await this.sendPrompt(parentId, { text });
  } else {
    const q = this.pendingParentInjection.get(parentId) ?? [];
    q.push(text);
    this.pendingParentInjection.set(parentId, q);
  }
}
```
> `sendPrompt` 內建的 cost 斷路器檢查照舊生效（父燒破預算時注入會被擋，丟明確錯誤 —— 用
> try/catch 包住，注入失敗只記 `console.warn`，不讓它炸掉子的 completed 事件迴圈）。

---

## 3. 失敗模式 / 邊界

| 情境 | 行為 |
|---|---|
| 父正忙 → 多個子先後回報 | 全部排進 `pendingParentInjection[parent]`，父每回到 idle flush 一筆 |
| 父已被刪除 / dispose | 丟棄注入（`deliverInjectionToParent` 開頭 `if (!parentRuntime) return`），`child-result` push 已發，不報錯 |
| 父燒破成本預算 | `sendPrompt` 丟錯 → try/catch 吞掉、`console.warn`，不影響子 |
| 注入造成父再 spawn 子、無限迴圈 | **本輪不特別防**（父的 `turnLimiter` / cost 斷路器兜底）；在實作報告裡註明這是已知、留給之後接安全罩 |
| 子 finalText 為空 | 不注入（沿用 S12 的 `&& finalText` 條件）|

---

## 4. 測試：更新 `scripts/e2e-session-subagents.mjs`

S12 既有的斷言 A/B/C/D/E/G/H **維持**，只有**斷言 F 要改**（原本測「父歷史有 system 訊息」，
現在改測「子結果被注入父、父據此又跑了一輪」）：

- **改後的斷言 F**：child completed 之後，
  - 父 session 的 `session.history` 出現一則 `role:"user"` 訊息，content 含
    `子 agent` 且含子的 finalText（`FAKE_ACP_REPLY_TEXT` / fake 後端固定回覆）；
  - 且父隨後**又產生一則 `role:"assistant"` 回覆**（代表注入的 prompt 真的餵給了父、父跑了
    一輪）—— 用 `drivePrompt` 之外的等待方式（例如 poll 父 history 直到出現該 user 訊息 +
    後續 assistant，或監聽父的 session-event completed），設合理逾時（15s）。
- **新增斷言 I（防迴圈/會終止）**：最終父 session 回到 `status:"idle"`（注入沒有造成父卡在
  busy 或無限跑）。

其餘（用既有假後端、不需真實模型 / API key；骨架照 S12 那支）不變。

---

## 5. 驗收（實作者必須全部跑過、不准謊報）

在 repo 根目錄：
1. `pnpm build` → exit 0
2. `pnpm typecheck` → exit 0（零 TS 錯誤）
3. `grep -rn "fa:opencode" packages apps scripts` → 零結果（別又汙染）
4. `node scripts/e2e-session-subagents.mjs` → exit 0，且斷言 A–E、F（改後）、G、H、I 全 PASS

> ⚠️ **不要**動 `packages/shared`（session.ts / gateway.ts）—— 這輪協議零變動，只改
> `apps/core/src/session/session-manager.ts` 與那支 e2e 腳本。若你發現需要改 shared 才能做到，
> 先停下來在報告裡說明，不要擅自改協議。

---

## 6. 明確不做（Round 2 / Round 3）

- `spawn_subagent` MCP 工具（讓 agent 自己 spawn）→ Round 2。
- UI 巢狀顯示 / child-result 卡片 → Round 3。
- 注入迴圈的專屬安全罩（訊息/成本預算歸屬父子鏈）→ 之後接。

---

> **驗收核心**：①子完成後，結果被當 prompt 注入父 session，父據此又跑一輪；②父忙時排隊、
> 父不在時丟棄、不炸事件迴圈；③協議零變動，只動 SessionManager + e2e；④最終會終止（父回 idle）。
