# S12 Phase 2 — Round 3：UI（從 session 開子 agent + 父子巢狀顯示）

> 上層：S12 + Phase 2 R1/R2。階段：UI，加法、非破壞性。
> 對應實作者：opencode subagent（`opencode/deepseek-v4-flash-free`）。

---

## 0. 目標與範圍 + ⚠️ 驗證限制

讓使用者能**在畫面上**：(1) 從一個既有 session 開一個子 agent（給它一段 prompt）；
(2) 在 SessionList 看到子 agent **巢狀縮排在父 session 底下**。

**⚠️ UI 沒有自動測試**：這個 repo 沒有 UI e2e / 元件測試，我（人）也不便在此環境跑
Electron。所以驗收只有 `pnpm build` + `pnpm typecheck` + 我 code review。**不要**捏造 UI
測試、**不要**動後端 e2e（`e2e-session-subagents.mjs` 只要仍 8/8 PASS 證明沒打壞後端即可）。

**範圍（只動 `apps/desktop`）**：
- ✅ `session-store.ts`：新增 `spawnChild` action（呼叫既有 `session.spawnChild` RPC）。
- ✅ `SessionList.tsx`：父子巢狀顯示 + 每個 session 列的 hover 動作多一個「開子 agent」鈕，開一個極簡對話框輸入 prompt。
- ❌ 不動任何後端（core / shared / adapters）。協議早就有 `session.spawnChild`（S12）與
  `child-result` push channel，這輪 UI 直接用。
- ❌ 不做 `child-result` 的即時 toast（子結果已由 R1 注入父對話流、在父 ChatView 看得到,
  本輪不重複做,留待日後 polish）。
- ❌ 不砍 team/看板 UI（那是更後面的事）。

---

## 1. `session-store.ts`

### 1.1 新增 `spawnChild` action

在 `SessionStoreState` 介面加：
```ts
/** S12 Phase2 R3:從一個既有 session 開子 agent —— child 沿用父 session 的
 *  agentProfileId（同 software/model）。呼叫既有 `session.spawnChild` RPC。 */
spawnChild: (parentSessionId: string, prompt: string, title?: string) => Promise<void>;
```
在 store 實作加（比照既有 `createSession`）：
```ts
spawnChild: async (parentSessionId, prompt, title) => {
  const parent = get().sessions.find((s) => s.id === parentSessionId);
  if (!parent) return;
  const raw = await client.call("session.spawnChild", {
    parentSessionId,
    agentProfileId: parent.agentProfileId,
    prompt,
    title,
  });
  const { session } = SessionCreateResultSchema.parse(raw); // spawnChild 回傳形狀 = { session }，與 session.create 相同
  set((state) => ({
    sessions: [...state.sessions, session],
    itemsBySession: { ...state.itemsBySession, [session.id]: [] },
  }));
  void get().fetchCapabilities(session.adapterType);
},
```
> `SessionSpawnChildResultSchema`（gateway.ts）與 `SessionCreateResultSchema` 都是
> `{ session }`。用 `SessionCreateResultSchema.parse` 即可（不需新 import）；若你想精確,
> 也可從 `@deskmony/shared` import `SessionSpawnChildResultSchema` —— 兩者等價,擇一。

### 1.2 （選配，若簡單就做）`onPush` 的 `child-result` 分支

`connect()` 的 `client.onPush` 目前沒有 `"child-result"` 分支。**本輪可以完全不加**
（R1 已把子結果注入父對話,父 ChatView 已看得到）。若你要加,只能做「安靜忽略」這種
零風險處理,**絕不可**在這裡做任何會改變既有 session 狀態的事。建議直接不加,少一個出錯點。

---

## 2. `SessionList.tsx`：父子巢狀 + 開子 agent 鈕

### 2.1 巢狀顯示

目前每個 workspace 分組內是 `workspace.sessions.map(session => …)` 平鋪。改成**先只渲染
頂層 session（`parentSessionId == null`），每個頂層 session 底下接著渲染它的子 session（縮排）**：

- 在 `workspace.sessions` 內：
  - `const topLevel = workspace.sessions.filter((s) => !s.parentSessionId);`
  - 對每個 topLevel session 渲染既有的那個列（原封不動）；緊接著渲染
    `workspace.sessions.filter((s) => s.parentSessionId === session.id)` 的子列。
- **子列**沿用同一個 session 列的 JSX（可抽成一個內部 `renderSessionRow(session, isChild)`
  小函式,避免複製整段），差別只在：外層多一個 `pl-4`（或 `ml-4 border-l`）的縮排容器 +
  標題前綴一個小的 `↳`（可用既有 `Icon`；沒有合適 icon 就用純文字 `↳`）。
- **邊界**：子 session 的父不在同一個 workspace 分組（理論上不會,子沿用父 workingDir，
  必同組）或父不存在時,該子 session **仍要顯示**（退化成一個頂層列,不要讓它憑空消失）。
  簡單作法：先渲染所有 topLevel + 其子;最後把「`parentSessionId` 有值但在本組找不到父」
  的 session 也當頂層補渲染一次（用一個 `renderedIds` Set 去重,避免同一個 session 畫兩次）。

> 保持既有的 workspace 分組、collapse、context% 徽章、刪除鈕全部不變 —— 只是在「一個
> workspace 內部的 session 排列」多一層父→子的縮排。

### 2.2 每列多一個「開子 agent」鈕

在每個 session 列現有的「刪除對話」IconButton **旁邊**（同一個 hover 動作區）加一個
IconButton：
```tsx
<IconButton
  icon="plus"           // 或 "sparkle"／"git-branch"，挑一個既有的 IconName（見 ui/icons.tsx，不要自創）
  aria-label="開子 agent"
  title="開一個子 agent 執行子任務"
  size="xs"
  className="my-auto opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
  onClick={(e) => { e.stopPropagation(); setSpawnParent(session); }}
/>
```
- `const [spawnParent, setSpawnParent] = useState<Session | null>(null);`（元件內 state）。
- `spawnParent` 非 null 時渲染一個**極簡對話框**（用既有 `ui/Dialog.tsx`，看它的 props 用法；
  參考 `ProfileCreateDialog` 怎麼用）：
  - 標題：「在「{spawnParent.title}」底下開子 agent」。
  - 一個多行 `textarea`（給子 agent 的 prompt）+ 選填的「標題」單行輸入。
  - 「取消」關閉；「開子 agent」按鈕：`await spawnChild(spawnParent.id, prompt, title || undefined)`
    成功後關閉對話框、清空欄位。prompt 空白時禁用送出鈕。
  - 送出中 loading、失敗顯示錯誤（比照 ProfileCreateDialog 既有的錯誤呈現風格,別自創一套）。
- 從 store 取 action：`const spawnChild = useSessionStore((s) => s.spawnChild);`

> `Session` 型別從 `@deskmony/shared` import（SessionList 目前可能還沒 import,補上 `type Session`）。

---

## 3. 驗收（實作者必須跑,不准謊報）

repo 根目錄：
1. `pnpm build` → exit 0
2. `pnpm typecheck` → exit 0（零 TS 錯誤;JSX / 新 import / IconName 都要真實存在——
   `icon` 只能用 `ui/icons.tsx` 已定義的 `IconName`,不要自創圖示名稱,否則 typecheck 會過
   但 runtime 顯示空白）
3. `grep -rn "fa:opencode" packages apps scripts` → 零結果
4. `node scripts/e2e-session-subagents.mjs` → 仍 8 PASS 0 FAIL（證明沒動壞後端）

> ⚠️ **沒有** UI 自動測試。回報時明講「UI 未經 runtime 驗證,靠 build/typecheck + review」。

---

## 4. 回報要求

- 改了哪些檔案（逐檔一句話）。
- 4 個驗收各自結果（貼統計 + exit code）。
- 用了哪個 `IconName` 當「開子 agent」鈕（必須是 ui/icons.tsx 既有的）。
- 有沒有動到後端（不該動）。
- `child-result` 的 onPush 分支加了沒（建議沒加;若加,是不是零風險的忽略）。
- 任何自行取捨、TODO。

---

> **驗收核心**：①能從 session 列開子 agent（prompt → `session.spawnChild`,child 用父
> profile）；②SessionList 子 session 縮排在父底下,孤兒子不消失;③只動 apps/desktop,
> 後端 e2e 不退步;④用真實存在的 IconName。
