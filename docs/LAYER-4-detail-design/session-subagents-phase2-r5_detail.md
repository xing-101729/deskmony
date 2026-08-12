# S12 Phase 2 — Round 5：`list_subagents`(父查詢自己名下的子 agent)

> 上層：S12 + [Phase 2 R1](./session-subagents-phase2_detail.md)（子回注父）+
> [R2](./session-subagents-phase2-r2_detail.md)（`spawn_subagent`）+
> [R4](./session-subagents-phase2-r4_detail.md)（`send_to_subagent`）。
> 階段：跨 package（shared / adapters / core）的加法，非破壞性。
> 對應實作者：Claude（Sonnet 5，本輪規劃與實作由同一個 session 直接完成）。
> 2026-08-12 完成，已用真實 Claude 憑證做 live smoke test（非 fake backend）。

---

## 0. 動機與範圍（實測發現的真實 bug，不是預先設計）

觸發：使用者在真實跑起來的 Deskmony app 裡回報「父沒辦法知道子」。用 computer-use 截圖
直接檢視使用者當下的畫面後查明：

1. 使用者是**在 UI 側欄手動點「開子 agent」**建立的子 session（不是父自己呼叫
   `spawn_subagent`）。
2. 使用者接著問父：「你的 subagent 現在是用什麼 model 跑的？」
3. 父完全不知道這個子的存在——它的對話歷史裡**沒有任何一則訊息提到這個子**（因為
   它自己沒 spawn 過，`session.spawnChild` 是使用者直接經 UI 呼叫的 gateway RPC，不
   經過父的工具呼叫；子這時多半也還沒完成第一輪，R1 的「completed → 注入父」機制
   還沒觸發）。父找不到任何管道回答，於是誤用了這台機器全域環境裡另一套不相干、
   跟 Deskmony 毫無關係的「Agent / SendMessage」工具（**推測是這個開發機的
   `~/.claude` 全域設定另外掛了一套多 agent 協作平台的工具，剛好命名概念相似**，
   跟 S12 完全無關）去問子,自然失敗。

**根因**：父原本只有「spawn 一個新的子」「對已知 id 的子送訊息」兩種能力
（R2、R4），**沒有任何方式反查「我名下現在有哪些子」**。只要子不是父自己
spawn 出來的，父就是真的、完全瞎的——不是工具壞掉，是這個查詢能力原本就不存在。

**範圍**：
- ✅ shared `SubagentPort` 新增 `listChildren()` + `SubagentChildSummary` 型別。
- ✅ adapters `subagent-mcp.ts` 新增第四個工具 `list_subagents`——**純查詢，放進
  `allowedTools` 自動放行**（同 `list_profiles`，不會讓任何 session 多跑一輪，不需要
  權限彈窗）。
- ✅ core `SessionManager.listChildrenFromTool()`——直接複用既有 `listSessions()`
  做 `parentSessionId` filter（同 R3 UI 的 SessionList 巢狀顯示用的是同一份資料、同一種
  filter 邏輯，只是搬到 server 端、只回傳呼叫者自己的子）。
- ✅ 工具說明文字與 MCP server 頂層 `instructions` 都**明講**「你的子 agent 不一定是你
  自己 spawn 的，使用者也可能手動開一個掛在你底下，被問到相關問題但自己不記得時，
  先呼叫 list_subagents 確認，不要用猜的或說不知道」——這是本輪唯一寫進
  systemPrompt/工具描述層級的行為引導，理由見 §2。

---

## 1. `packages/shared/src/subagent.ts`

```ts
listChildren(input: { parentSessionId: string }): Promise<SubagentChildSummary[]>;

export interface SubagentChildSummary {
  id: string;
  title: string;
  status: string;
  software: string;
  model?: string;
}
```

只回傳決策/回答問題需要的最小欄位（同 `SubagentProfileSummary` 的最小揭露原則）——
不含 `workingDir`/`agentProfileId` 等內部細節。

---

## 2. `packages/adapters/src/subagent-mcp.ts`

`list_subagents` 工具本身沒有參數（`parentSessionId` 同其餘工具由閉包捕捉，agent
不可指定，只能查自己的子）。**放進 `SUBAGENT_ALLOWED_TOOL_NAMES`**（跟
`list_profiles` 並列）——這是純查詢，不會讓任何 session 多跑一輪，沒有理由要求人
核可。

工具描述與 MCP server 的 `instructions` 都特別強調「子不一定是你自己開的」這件事。
這是 R2/R4 完全沒做、這輪才加的**唯一一處 systemPrompt/工具描述層級的行為提示**——
理由：R2 驗收時已經實測過「單純把能力做出來、靠 ToolSearch + 工具名稱本身，agent
就能正確發現並使用」，不需要額外提示（見 R2 附錄的兩組 blind/explicit 測試）。但
**這次的問題完全不是「找不到工具」，是「壓根不知道自己有子」**——這是一個沒有任何
工具名稱線索能提示 agent「該去查」的情境（agent 沒有理由主動懷疑自己有一個自己不
知道的子），所以才需要在工具描述本身把這個情境明講出來，屬性上比較接近「教它一個
違反直覺的邊界情況」而非「單純告知工具存在」。

---

## 3. `apps/core/src/session/session-manager.ts`

`listChildrenFromTool(parentSessionId)`：直接呼叫既有 `listSessions()`，
`filter(s => s.parentSessionId === parentSessionId)`，映射成最小欄位。沒有新的 DB
查詢路徑，也沒有任何權限檢查（純讀取自己的子清單，沒有可以濫用的地方）。

---

## 4. `apps/core/src/index.ts`

`claudeAdapter.setSubagentPort({...})` 加一行：
`listChildren: (input) => sessionManager.listChildrenFromTool(input.parentSessionId)`。

---

## 5. 驗收結果（實測，非假設）

1. `pnpm build` → exit 0
2. `pnpm typecheck` → exit 0
3. `node scripts/e2e-session-subagents.mjs` → 8 PASS，0 FAIL
4. `node scripts/e2e-gateway.mjs --only=deterministic` → 141 PASS，0 FAIL
5. **真實 Claude 憑證 live smoke test，精確重現使用者原始場景**：
   - 用 `session.spawnChild` gateway RPC 直接建子（模擬使用者手動點 UI「開子
     agent」），子刻意用 **`software=opencode`**（跟使用者畫面上看到的一致，父是
     `claude-agent-sdk`）。
   - 父完全沒被告知這件事（沒呼叫 spawn_subagent、子也還沒完成，R1 注入機制還沒
     觸發——刻意選在子仍是 `busy` 狀態時就問,測最嚴苛的情境）。
   - 直接問父:「你的 subagent 現在是用什麼 model 跑的？」（原句照使用者的問法，
     完全不提任何工具名稱）。
   - 結果:父正確用 `ToolSearch` 找到 `mcp__subagent__list_subagents` 並呼叫、拿到
     `{status:"busy", software:"opencode", model:"opencode/deepseek-v4-flash-free"}`,
     正確回答:「你名下有一個子 agent(手動開的),目前狀態是 busy,跑在
     opencode、model 是 opencode/deepseek-v4-flash-free。」**沒有**再誤用任何
     `SendMessage`/`Agent` 之類的無關工具。

---

## 6. 回報摘要

- 改的檔案：`packages/shared/src/subagent.ts`、`packages/adapters/src/subagent-mcp.ts`、
  `packages/adapters/src/claude-sdk-adapter.ts`（只改一行註解）、
  `apps/core/src/session/session-manager.ts`、`apps/core/src/index.ts`。
- `list_subagents` 有沒有被放進 allowedTools：**有**（純查詢，同 list_profiles）。
- 沒有做 UI、沒有動 team-bus/看板。
- 這一輪額外在工具描述/`instructions` 裡加了行為引導文字——是這一系列（R2/R4/R5）
  目前唯一一次這麼做，原因見 §2，不是隨意加的。
- 未解決、刻意留給以後：`list_subagents` 只回傳「有哪些子」，不會主動把「使用者剛
  手動開了一個子」這件事推播進父的對話（父仍是被動查詢，不是被通知）——這輪判斷
  「查得到就夠了」，真的要做「父被動收到通知」是更大幅度的改動（要決定什麼時機
  推、推進誰的回合），這輪不做。
