# S3a Detail Design:Usage 量測

> 上層:[S3a HLD](../LAYER-3-hld/usage-metering_hld.md)｜階段:**切片**
> L4 的完成度標準:**另一個工程師照著寫,不用問你**。

---

## 0. ⚠️ L4 查證推翻了 HLD 的 schema 假設

HLD §2.1 假設 `usage_update` 會給 `inputTokens` / `outputTokens` / `cacheRead` / `cacheCreation`。**查證 `@agentclientprotocol/sdk@1.2.1` 的實際型別後,這是錯的**:

```ts
// node_modules/@agentclientprotocol/sdk/dist/schema/types.gen.d.ts:3951
export type UsageUpdate = {
  used: number;        // "Tokens currently in context."
  size: number;        // "Total context window size in tokens."
  cost?: Cost | null;  // "Cumulative session cost (optional)."
};
export type Cost = {
  amount: number;      // "Total cumulative cost for session."
  currency: string;    // ISO 4217,如 "USD"
};
```

**ACP 給的是兩種完全不同的東西**:

| 欄位 | 是什麼 | 能不能拿來算花費 |
|---|---|---|
| `used` / `size` | **context 窗口計量表(gauge)** | ❌ **不能**。它是「現在 context 裡有多少 token」,不是「總共燒了多少」——compaction 後會**變小**,且**不含跨回合累積的 output token** |
| `cost.amount` | **累計花費($)**,session 級 | ✅ **可以**,而且天生就是**累計值**——**正好對上 HLD 選的累計 payload 語意** |

### 0.1 兩個連帶結論

1. **`used`/`size` 不是成本訊號,而是 [S8 §2.2](../LAYER-3-hld/agent-lifecycle_hld.md) 要的東西**——S8 把「context 閾值怎麼測」列為開放問題,**答案就在這裡**:`used / size` 就是 context 使用率,可直接驅動長命 agent 的 checkpoint 重啟。
2. **`cost` 是 optional**——agent 可能不報。這正是 [S3b §3.2](../LAYER-3-hld/cost-governor_hld.md) 決定「$ 為主、token 兜底」的實際理由:**ACP 的 $ 隨時可能缺席**。

---

## 1. 修正後的 UsageEvent schema

拆成**兩個語意不同的事件**,不再硬塞進一個:

```ts
// packages/shared/src/events.ts

/** 累計花費(cumulative,每條 adapter 連線內單調遞增) */
export const UsageEventSchema = z.object({
  type: z.literal("usage"),
  /** 累計花費金額;來源未提供則 undefined(不編 0) */
  costAmount: z.number().optional(),
  /** ISO 4217,如 "USD"。有 costAmount 時應同時有 */
  costCurrency: z.string().optional(),
  /** 累計 token(來源有給才填;ACP 目前不給,保留供 Claude SDK / OpenCode) */
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  cacheReadTokens: z.number().optional(),
  cacheCreationTokens: z.number().optional(),
  /** 此用量對應的 model(setModel 換過時消歧) */
  model: z.string().optional(),
});

/** context 窗口使用率(gauge,非累計 —— 會上下浮動) */
export const ContextUsageEventSchema = z.object({
  type: z.literal("context-usage"),
  used: z.number(),   // 目前 context 內 token 數
  size: z.number(),   // context 窗口總大小
});
```

> **為何拆兩個**:一個是**累計計數器**(可 diff、單調遞增)、一個是**瞬時計量表**(會變小)。塞同一個事件會讓消費端的「新<舊 = 重置」規則對 gauge 誤判成重置。**語意不同就不共用型別。**

兩者都加進 `AgentEventSchema` 的 discriminated union。

### 1.1 capabilities 擴充

```ts
// packages/shared/src/adapter-capabilities.ts
// ⚠️ 已於 §8 改成三態,下面這個布林版本保留供對照(不再是現況)
usageReporting: z.boolean(),    // 是否回報 usage(累計花費/token)
contextReporting: z.boolean(),  // 是否回報 context 計量表
```

> ⚠️ **修正(實作回饋)**:本表原本把 claude-sdk/opencode 寫成「`true`(延後接)」——**這個用語自相矛盾**:若這輪沒真的接上轉發邏輯,回報 `true` 就是**對 UI 說謊**,與此 codebase 到處強調的「如實回報」原則(見既有 `diff` 欄位的處理)衝突。**capabilities 一律是「這輪的實際值」,不是「預期未來值」。**

> ⚠️ **本表已被 [§8](#8--修正實作capabilities-三態--claudeagentsdkadapter-接上用量) 取代**(布林 → 三態、claude-sdk 已接上)。保留原表供對照。

| Adapter | usageReporting | contextReporting | 備註 |
|---|---|---|---|
| **AcpAdapter** | `true` | `true` | 本輪實作;但 `cost` 可能缺 → §3。⚠️ **這兩個 `true` 已知在 Claude Code profile 上是錯的**(§7.5 ④):會不會報 usage 由**被 spawn 的 agent** 決定,adapter 層級的靜態布林值表達不了 |
| ClaudeAgentSdkAdapter | `false` | `false` | **未接轉發邏輯 ⇒ 如實回報 false**;之後接上時才改 true |
| OpenCodeAdapter | `false` | `false` | 同上 |
| GenericPtyAdapter | `false` | `false` | 結構上不可能回報 |

---

## 2. AcpAdapter 實作點

現況 `acp-adapter.ts:46` 註解自承 `usage_update` 「尚未有對應的[處理]」。實作位置在 `handleSessionUpdate()`(現況 L310 附近 `this.handleSessionUpdate(internal, message.notification.update)`)。

```ts
case "usage_update": {
  const u = update;  // UsageUpdate
  // ① context gauge —— 每次都發(便宜,且 S8 要用)
  emit({ type: "context-usage", used: u.used, size: u.size });

  // ② 累計花費 —— 僅在 cost 存在時發
  if (u.cost) {
    internal.lastCost = { amount: u.cost.amount, currency: u.cost.currency };
  }
  break;
}
```

**發射時機(切片,依 HLD §3)**:
- `context-usage`:**逐次發**(gauge 本來就要即時,且量小)。
- `usage`(累計花費):**回合末發一次**——在 `completed` 事件之前,用 `internal.lastCost` 發出當前累計。
- 回合以 **error / interrupt** 收場時:**盡力補發** `internal.lastCost` 再結束(HLD §4)。
- ⚠️ **Phase 1 起改 mid-turn**([S3b §3.1](../LAYER-3-hld/cost-governor_hld.md)):屆時 `usage` 改為收到 `usage_update` 即發。**schema 不變**(累計 payload 天生支援)。

**狀態**:`AcpAdapterInternal` 增加 `lastCost?: { amount: number; currency: string }`,在 `dispose()` 時清除。

---

## 3. `cost` 缺席時怎麼辦(切片)

ACP 的 `cost` 是 optional,實測前**無法確定 Claude Code 會不會給**。

| 情況 | 切片行為 |
|---|---|
| `cost` 有值 | 正常發 `usage`,UI 顯示 $ |
| `cost` 一直沒有 | **不發 `usage` 事件**;UI 顯示「此後端未回報花費」,**不猜、不估**(HLD §4) |
| `context-usage` 一定有 | 一律顯示 context 使用率(這是 ACP 保證的欄位) |

> ⚠️ **本表第三列已被 [§7](#7--已驗證claude-code-經-acp-完全不報-usage連-usedsize-都沒有) 的實測推翻**:ACP 保證的是「送了 `usage_update` 就一定有 `used`/`size`」,**不保證 agent 會送這個通知**。Claude Code 經 ACP bridge **一次都不送** ⇒ 對該後端連 context 使用率都顯示不出來。

> **切片的最低保證是 `context-usage`**——即使拿不到 $,你至少看得到「這個 session 的 context 用了幾成」,這對判斷「該不該重開一個 session」已經有用。

---

## 4. 消費端(UI store,切片純 ephemeral)

```ts
// apps/desktop/src/stores/session-store.ts
sessionUsage: Map<sessionId, {
  // 累計花費:直接顯示最新值(已是累計,不需加總)
  costAmount?: number; costCurrency?: string;
  // context gauge:直接顯示最新值
  contextUsed?: number; contextSize?: number;
}>
```

- **不落地**(HLD §3 定案:切片 ephemeral),reload 歸零。
- **累計重置規則**(HLD §3):`usage` 的 `costAmount` 若 **新值 < 舊值** ⇒ 視為連線重置,**起新段、不做負 diff**。切片只顯示最新值,故實務上直接覆寫即可;**S3b 做權威 rollup 時才需要真正處理分段**。
- `context-usage` 是 gauge,**永遠直接覆寫**,不套用重置規則。

**顯示位置(切片最小)**:`SessionList` 每列顯示 context 使用率(如 `32%`);`ChatView` 標頭顯示累計 $(有的話)。不做 per-turn 明細(留 S3b 的 CostView)。

---

## 5. 對 HLD 開放問題的回答

| HLD 開放問題 | L4 回答 |
|---|---|
| #1 每任務歸屬 | 切片單 agent 單任務,**不處理**;S3b 做權威 rollup 時再解 |
| #2 segment/connection id | 切片只顯示最新值,**不需要**;S3b 需要時再加 |
| #3 price table 放哪 | **切片不需要**——ACP 直接給 $。price table 只有在「後端只給 token」時才需要(S3b)。⚠️ **「ACP 直接給 $」已被 §7 推翻**(Claude Code 經 ACP 連 token 都不給)。但結論意外地不變:**切片仍然不需要 price table**,因為沒有 token 可乘——正解是走 `ClaudeAgentSdkAdapter`(§7.5 ⑤),它直接給 $ |
| #4 UI 呈現粒度 | §4 已定:context 使用率 + 累計 $,無明細 |

---

## 6. 實作檢查清單

- [ ] `packages/shared/src/events.ts`:加 `UsageEventSchema`、`ContextUsageEventSchema`,併入 union
- [ ] `packages/shared/src/adapter-capabilities.ts`:加 `usageReporting`、`contextReporting`
- [ ] 各 adapter 的 `capabilities()` 補這兩個欄位(PTY 為 false)
- [ ] `packages/adapters/src/acp-adapter.ts`:`handleSessionUpdate` 加 `usage_update` case;internal 加 `lastCost`;`completed`/error/interrupt 前補發
- [ ] `apps/desktop/src/stores/session-store.ts`:接兩種事件、存最新值
- [ ] `SessionList` / `ChatView`:顯示
- [ ] e2e:`scripts/fake-acp-agent.mjs` 增加送 `usage_update` 的模式,驗證事件流

---

## 7. ✅ 已驗證:Claude Code 經 ACP **完全不報 usage**(連 `used`/`size` 都沒有)

**狀態(2026-07-27):已用真實 Claude Code + 真實憑證實測完畢。結論比原本的問題更壞——不只 `cost` 沒有,`usage_update` 這個通知從頭到尾一次都不會出現。**

### 7.1 驗證環境與方法

| 項目 | 值 |
|---|---|
| Claude Code CLI | `2.1.199`(原生二進位 `claude.exe`) |
| 憑證 | 真實登入(`claude.ai` OAuth,`firstParty`,Pro 訂閱) |
| ACP bridge | `@zed-industries/claude-code-acp@0.16.2`(當時 npm latest) |
| 協商到的協議版本 | `protocolVersion: 1`(與 Deskmony 用的 SDK 1.2.1 相同,互通無礙) |

**方法**:繞過所有 SDK 抽象,直接對 bridge 講 ndjson JSON-RPC,把每一行進出的原始位元組印出來(`initialize` → `session/new` → `session/prompt`),確保看到的是真的跑在線上的東西,不是任何一層的詮釋。**沒有用 `scripts/fake-acp-agent.mjs`。**

### 7.2 前提修正:**Claude Code 本身沒有 ACP 模式**

`claude --help` 沒有任何 ACP 旗標;在 240MB 的 `claude.exe` 內搜尋 `agentclientprotocol` / `usage_update` / `session/prompt` / `experimental-acp`,**四個字串的命中數都是 0**。

⇒ 「Claude Code 經 ACP 連線」在今天**只有一條路**:透過**第三方** bridge `@zed-industries/claude-code-acp`(Zed 編輯器用的那個)。**這條路的行為是 bridge 的行為,不是 Anthropic 的承諾**——Anthropic 沒有對 Claude Code 的 ACP 表面做過任何保證,bridge 隨時可能改。

### 7.3 實測結果

| 問題 | 答案 |
|---|---|
| `used` / `size` 有沒有值? | ❌ **通知本身不存在**,談不上有沒有值 |
| `cost` 有沒有出現? | ❌ **沒有** |
| `amount` / `currency` 長什麼樣? | 不適用 |

一輪完整、成功的對話(prompt 送出、模型真的回了 `hello`、`stopReason: "end_turn"`)收到的 `session/update` 型別統計:

```json
{ "available_commands_update": 1, "agent_message_chunk": 2 }
```

`usage_update` 出現次數:**0**。

**靜態佐證(與實測互相印證)**:把 bridge `dist/*.js` 內所有 `sessionUpdate:` 的賦值窮舉出來,總共只有 8 種——`agent_message_chunk`、`user_message_chunk`、`agent_thought_chunk`、`available_commands_update`、`current_mode_update`、`plan`、`tool_call`、`tool_call_update`。**`usage_update` 不在其中,程式碼裡根本沒有任何一條路徑會送它。** 所以這不是「這次剛好沒觸發」,是**結構上不會發生**;跑再久、跑到 compaction 也不會冒出來。

### 7.4 資料其實存在,是 bridge 丟掉的

底層 `@anthropic-ai/claude-agent-sdk@0.2.44` 的 `SDKResultMessage` **明確帶著這些欄位**:

```ts
total_cost_usd: number;              // ← 累計 $,正是我們要的
usage: NonNullableUsage;             // ← input/output/cache token
modelUsage: Record<string, ModelUsage>;
```

但 bridge 的 `case "result":` handler(`dist/acp-agent.js:375`)**只讀 `subtype` / `is_error` / `result` / `errors`,然後 `return { stopReason }`**——`total_cost_usd`、`usage`、`modelUsage` 全部**原地丟棄**,沒有轉成任何 ACP 通知。

⇒ **這是 bridge 的轉發缺口,不是資料拿不到。** 這件事決定了下面的對策:問題出在「經過 ACP 這一層」,繞開它就有資料。

### 7.5 下游影響(比原本預期的更嚴重)

**① 原本的推測只對了一半,而且是比較不痛的那一半。**

原文預期「若 `cost` 不報 ⇒ S3b 的『$ 為主、token 兜底』在 ACP tier 永遠走 token 分支 ⇒ price table 提前成為必要件」。**實測後這個推論不成立**:token 也一樣拿不到(`used`/`size` 連通知都沒有)。**沒有 token,price table 乘什麼?** 

⇒ **price table 並不會因此提前變成必要件**——它在 ACP+Claude Code 這條路上**根本救不了場**。真正的結論是:**這條路上「$ 兜底 token」的兩條分支同時斷掉,拿不到任何用量訊號。**

**② §3 的「最低保證」在這個後端是假的。**

§3 寫「`context-usage` 一定有(這是 ACP 保證的欄位)」——**這句話要修正**。ACP 保證的是「**若** agent 送 `usage_update`,則裡面**一定**有 `used`/`size`」;它**不保證 agent 會送這個通知**。Claude Code 經 bridge 就是完全不送。⇒ 切片對這個後端的實際 UI 表現是:**context 使用率也顯示不出來**,不只是少了 $。

**③ §0.1 給 S8 的答案,在這個後端不成立。**

§0.1 說「S8 的 context 閾值怎麼測?答案就在 `used`/`size`」。對 Claude Code-over-ACP 而言**沒有這個答案**,S8 若要對這個後端做長命 agent 的 checkpoint 重啟,得另尋訊號。

**④ `capabilities()` 現在正在對 UI 說謊——這正是 §1.1 自己警告過的錯。**

`AcpAdapter.capabilities()` **無條件**回報 `usageReporting: true, contextReporting: true`。但 capabilities 是 **adapter 層級(靜態)**,而「會不會報 usage」是 **被 spawn 的那個 agent 決定的(每個 profile 不同)**——Gemini CLI 可能報,Claude Code bridge 確定不報。**同一個 adapter 的兩個 profile 行為相反,靜態布林值表達不了。**

⇒ 待辦(不在本次驗證範圍內,但這次驗證讓它從「理論瑕疵」變成「已知的實際錯誤」):capabilities 對 usage/context 這兩項需要**從靜態改為連線後動態判定**(例如先回報 unknown,收到第一個 `usage_update` 才轉 true),否則 UI 會對 Claude Code profile 顯示「有花費可看」然後永遠空著。

**⑤ 真正的對策:Claude Code 的成本量測不要走 ACP tier。**

資料在 `claude-agent-sdk` 手上(§7.4),`ClaudeAgentSdkAdapter` **直接**就能拿到 `total_cost_usd` 與 token 明細,不需要 price table、不需要估算。本文件 §1.1 目前把它的 `usageReporting` 記為 `false`(理由是「未接轉發邏輯」)——**這次驗證把「接上它」的優先級整個抬高了**:它不是 ACP 路線的補充,而是 Claude Code 這個後端**唯一**能拿到用量的路線。

### 7.6 這次驗證沒有涵蓋的範圍(誠實邊界)

- 只測了 **Claude Code**。**其他 ACP agent(Gemini CLI 等)可能照送 `usage_update`**——AcpAdapter 對 `usage_update` 的處理邏輯本身仍然有用,不該因此拆掉。這次否定的是「Claude Code 這個 profile 會給用量」,**不是**「ACP usage 支援白做了」。
- 只測了 bridge `0.16.2`。上游若補上轉發,結論會翻轉;若要長期依賴,需要有回歸偵測。
- 訂閱型帳號(Pro)與 API key 帳號的成本語意本來就不同,但**本次結論與此無關**——通知根本沒送,不是送了但金額為 0。

---

### 7.7 原始記錄:驗證前的未知數描述(保留供對照)

**狀態(2026-07-27,驗證前):實作已完成並通過 e2e,但 `cost` 仍未經真實後端驗證。**

- 實作階段全程用 `scripts/fake-acp-agent.mjs` 模擬 ACP,`cost` 是否出現由測試腳本自己決定(e2e 步驟 29b 送假 cost、29c 故意不送)。驗證的是「**AcpAdapter 對兩種情況都處理正確**」,**不是**「Claude Code 實際會不會給」。
- ⇒ **「切片能不能看到花費」目前仍是理論推測,沒有任何人驗證過。**
- **不影響設計正確性**:保底設計(`context-usage` 一定有)已涵蓋 cost 缺席的情況。
- **後續任務**:找一個有真實 Claude Code CLI + ACP 的環境,建立 session 跑一輪,確認 `usage_update` 是否帶 `cost`。若確認不報,則 S3b 的「$ 為主、token 兜底」在 ACP tier 上會**永遠走 token 分支**,那會讓 price table 從「S3b 才需要」提前成為必要件——**這是這個未知數真正的下游影響**。

---

## 8. ✅ 修正實作:capabilities 三態 + `ClaudeAgentSdkAdapter` 接上用量

**狀態(2026-07-27):§7.5 ④(capabilities 說謊)與 ⑤(SDK 路線)兩項待辦已實作完成,`pnpm typecheck` / `pnpm build` 通過。**

### 8.1 capabilities 從布林改為三態(對應 §7.5 ④)

`packages/shared/src/adapter-capabilities.ts` 新增 `CapabilitySupportSchema`,`usageReporting`/`contextReporting` 兩欄由 `z.boolean()` 改為 `z.enum(["supported","unsupported","unknown"])`:

| 值 | 語意 | UI 行為 |
|---|---|---|
| `"supported"` | adapter **自己**保證會發(轉發邏輯就在 adapter 裡,不依賴外部 agent) | **顯示**用量區塊;值還沒到顯示 `—` 佔位 |
| `"unsupported"` | 結構上不可能,或這輪確實沒接轉發邏輯 | **完全不渲染** |
| `"unknown"` | adapter 有處理邏輯,但資料來不來由**被 spawn 的 agent** 決定 | **完全不渲染**(直到收斂) |

**收斂機制**:`resolveCapabilitySupport(declared, observed)`(同檔案)。`observed` = 「這條 **session** 至少收到過一次該事件」——收到就是壓倒性證據,一律收斂成 `"supported"`;沒收到**不會**把 `"unknown"` 降級成 `"unsupported"`(「還沒收到」≠「不會收到」,硬判同樣是編造)。UI 端由 `apps/desktop/src/stores/session-store.ts` 的 `SessionUsage.usageSeen`/`contextSeen` 提供 `observed`,`selectUsageReporting()`/`selectContextReporting()` 是唯一入口(ChatView 的 $ 徽章、SessionList 的 ctx 徽章都走它)。

> **為什麼收斂放在 UI 而不是新開一條 gateway 通道**:事件本身已經 per-session 流到 UI 了,再讓 core 平行維護一份「這條 session 報過用量沒」並開新 RPC,只是把同一個事實存兩份。代價是誠實的:`sessionUsage` 是 ephemeral,reload 後能力退回 `"unknown"`(先不顯示,下一輪事件抵達自動恢復)——與「切片不落地用量」是同一個決定的必然後果。

修正後的能力表:

| Adapter | usageReporting | contextReporting | 理由 |
|---|---|---|---|
| **AcpAdapter** | `"unknown"` | `"unknown"` | 有轉發邏輯,但送不送由 agent 決定(Gemini CLI 可能送、Claude Code bridge 確定不送) |
| **ClaudeAgentSdkAdapter** | `"supported"` | `"unsupported"` | §8.2 已接上;context gauge 無來源(見下) |
| OpenCodeAdapter | `"unsupported"` | `"unsupported"` | 沒有轉發程式碼,不管後端送什麼都不會變成事件 |
| GenericPtyAdapter | `"unsupported"` | `"unsupported"` | 結構上不可能 |

### 8.2 `ClaudeAgentSdkAdapter` 接上用量(對應 §7.5 ⑤)

`handleMessage()` 的 `case "result":` 在 push completed/error **之前**呼叫 `flushUsage()`,發出 `usage` 事件(**`UsageEventSchema` 未改**)。`SDKResultMessage` 的 success 與 error 兩種 subtype 在**型別上**都帶用量欄位 ⇒ 同一條路徑同時涵蓋正常結束與 error/interrupt 收場,不需要第二條路徑。

**⚠️ 累計語意:實測發現同一則 `result` 上的三組數字語意並不一致。** 用真實憑證在同一個 `query()` 內連跑兩輪(streaming input mode):

| 欄位 | 第 1 輪 → 第 2 輪 | 累計? |
|---|---|---|
| `total_cost_usd` | `0.157881` → `0.16590749` | ✅ **累計** |
| `usage`(頂層) | in 2 / out 3 → in 2 / out 3 | ❌ **只是「這一輪」** |
| `modelUsage[m]` | in 2 / out 3 → in 4 / out 6 | ✅ **累計** |

⇒ token 明細取自 **`modelUsage`(跨 model 加總)**,不是頂層 `usage`。把 per-turn 數字填進宣告為累計的欄位,只是換一種方式對消費端說謊(第二輪 UI 會顯示「累計只用了 2 個 input token」)。對應關係:

- `total_cost_usd` → `costAmount`,`costCurrency` 固定 `"USD"`(欄位名稱本身就定死幣別)
- `modelUsage[*].inputTokens` / `outputTokens` / `cacheReadInputTokens` / `cacheCreationInputTokens` 加總 → `inputTokens` / `outputTokens` / `cacheReadTokens` / `cacheCreationTokens`
- `model`:只有 `modelUsage` 恰好一個 key 時才填(中途 `setModel()` 換過時這筆累計橫跨多個 model,填哪一個都是錯的 ⇒ 留 undefined)
- `modelUsage` 為空時整組 token 欄位留 undefined,**不編造成 0**

**⚠️ 「有欄位」不等於「有值」——interrupt 收場實測(這一輪差點出貨的 bug)**:用真實憑證跑「送出長任務 → 4 秒後 `interrupt()`」,拿到的 result 是

```json
{ "subtype": "error_during_execution", "total_cost_usd": 0, "modelUsage": {} }
```

回合被中止,SDK **沒有結算任何用量**。若照「有 result 就發」實作,每按一次「中斷」就會送出 `costAmount: 0`,而消費端規則是「直接覆寫顯示最新值」⇒ **使用者每中斷一次,畫面上的累計花費就歸零一次**。

⇒ `flushUsage()` 加了防線:`modelUsage` 為空**且** `total_cost_usd` 為 0(這則 result 完全沒有用量資訊)時**不發事件**——與 §3 表格「cost 一直沒有 → 不發 usage 事件」同一條原則。**沉默 > 發一個看起來像真的的 0。**

> 未驗證的邊界:單次觀察無法區分「錯誤收場的 result 一律回報 0」與「這條 session 當下累計本來就是 0」。兩者對現在的行為沒有差別(都被防線擋下),故不追測;S3b 做權威 rollup 時需要重新確認。

**`contextReporting` 維持 `"unsupported"`**:`SDKResultMessage` 沒有「目前 context 裡有多少 token」這個 gauge。`modelUsage[*].contextWindow` 給了窗口大小(實測 `claude-sonnet-5` = 1,000,000),`used` 則只能從「最後一次請求的 `input_tokens + cache_read + cache_creation`」反推——**那是推論不是來源給的值**,這輪刻意不做(不猜、不估)。⇒ §7.5 ③ 指出的「S8 對這個後端失去 context 訊號」**仍然成立**,但已知有這條反推路線可走,是 S8 的候選解而非死路。

### 8.3 e2e

- 步驟 **29a** 改為斷言 ACP 回報 `"unknown"`/`"unknown"`(原本斷言 `true`/`true`)。29b/29c 未動。
- 新增步驟 **29d**:`29d-1` 斷言 SDK adapter 回報 `"supported"`/`"unsupported"`;`29d-2` 跑一輪真實 session,斷言 `usage` 事件的 `costAmount>0`、`costCurrency==="USD"`、四個 token 欄位齊全、**在 completed 之前**、單一 model 時帶 `model`、且**不發** `context-usage`。
- ⚠️ **29d-2 沒有 fake 版本可用**:用量數字是 SDK 從真實 API 回應累計出來的,`scripts/` 底下的假後端都不經過 `claude-agent-sdk`,造不出 `SDKResultMessage`。這是「經 ACP 拿不到用量、只能走 SDK」這個結論的直接代價。斷言的是系統行為(事件有無/欄位型別/順序)而非模型措辭,故仍歸 **deterministic** 分組。
