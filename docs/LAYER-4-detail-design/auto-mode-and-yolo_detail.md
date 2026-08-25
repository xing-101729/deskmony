# S7 Detail Design:Auto Mode / YOLO / 遠端能力矩陣

> 上層:[S7 HLD](../LAYER-3-hld/auto-mode-and-yolo_hld.md)｜階段:**Phase 1**
> 前置:[S1 L4](./policy-engine_detail.md)(已實作;`ExecContext.autoMode` 目前寫死 `false`,等本 spec 接上)
> L4 完成度標準:**另一個工程師照著寫,不用問你**。

---

## 0. 現況缺口(已查證)

| 缺口 | 現況 | S7 要補 |
|---|---|---|
| **`escalate-strong` 傳不到 UI** | `PermissionRequestEventSchema`(`packages/shared/src/events.ts`)**沒有 `strong` 欄位**;S1 已能產生 escalate-strong,但 UI 收到的與一般 escalate 完全一樣 | 加欄位 + 差異化 UX |
| **彈窗只有 allow / deny** | `PermissionModal.tsx` 兩個鈕,無「永遠允許」 | 加第三個選項 + 窄規則確認 |
| **`PermissionDecision.remember`** | schema 有(events.ts:115),**無任何消費端** | 接上 → 寫 config |
| **`ExecContext.autoMode`** | S1 寫死 `false` | 接 session 暫態 |
| **`permissionLevel` 可存 `auto-accept-all`** | schema 允許 | **收窄 + 遷移降級**(HLD §2.1) |
| **遠端能力矩陣** | 無 | Gateway 硬拒 + 握手能力集 |

---

## 1. schema 變更

### 1.1 `PermissionLevelSchema` 收窄(破壞性,HLD §2.1)

```ts
// packages/shared/src/agent-profile.ts
/** 可持久化到 profile 的權限等級。⚠️ 不含 auto-accept-all —— YOLO 僅 session 暫態 */
export const PermissionLevelSchema = z.enum(["always-ask", "auto-accept-edits"]);

/** session 暫態可達的等級(含 YOLO),不寫入 profile */
export const SessionPermissionModeSchema = z.enum(["always-ask", "auto-accept-edits", "auto-accept-all"]);
```

**遷移**(`packages/db/src/client.ts`,比照既有 `ensureTasksAcceptanceColumn` 作風):
```sql
UPDATE agent_profiles SET permission_level = 'auto-accept-edits' WHERE permission_level = 'auto-accept-all';
```
執行時 **console.warn 告知使用者哪些 profile 被降級**(不可靜默)。

### 1.2 `PermissionRequestEvent` 加 `strong`

```ts
// packages/shared/src/events.ts —— PermissionRequestEventSchema
/** S1 的 escalate-strong:hard-deny 類在「本機+attended」下的強確認。
 *  UI 必須以明顯不同的樣式呈現,且**不得**提供「永遠允許」(C4 紀律③)。 */
strong: z.boolean().default(false),
```
S1 的 session-manager hook 在 escalate-strong 時帶 `strong: true`。

### 1.3 `PermissionDecision` 擴充(接上 remember)

```ts
// packages/shared/src/events.ts
export const PermissionDecisionSchema = z.object({
  requestId: z.string(),
  decision: z.enum(["allow", "deny"]),
  /** 選定要寫入 allowlist 的窄規則;undefined = 只此一次。
   *  ⚠️ strong 請求一律不得帶此欄位(Core 端強制檢查,§4) */
  rememberRule: PolicyRuleSchema.optional(),
});
```
> **取代**既有的 `remember: z.boolean()`——布林值表達不了「記多窄」,而 HLD §4 定案是**使用者選定範圍**。

---

## 2. Session 暫態(auto / YOLO)

存在 `SessionManager` 記憶體,**不進 DB**(HLD §2:暫態、崩潰不復活):

```ts
interface SessionPermissionState {
  mode: SessionPermissionMode;      // 初值 = profile.permissionLevel
  yoloExpiresAt?: number;           // 僅 mode==="auto-accept-all" 時有值
}
```

| 規則 | 值 |
|---|---|
| **YOLO 過期**(HLD §2.2) | **30 分鐘**;到期回落 `always-ask` + 發通知。`auto` **不過期** |
| 過期檢查時機 | 每次 `decide()` 前惰性檢查(不需計時器) |
| 崩潰/重啟 | 暫態消失,回落 `profile.permissionLevel`(§1.1 已確保不可能是 YOLO) |

**Gateway method**:`session.setPermissionMode({ sessionId, mode })`
- `mode === "auto-accept-all"` 時,Core 設定 `yoloExpiresAt = now + 30min`。
- **遠端呼叫一律拒絕**(§5)。
  > ⚠️ **2026-08-25 修訂**(見 [DECISIONS.md §G](../DECISIONS.md)):此限制已
  > 取消,遠端現在可呼叫 `session.setPermissionMode`,與本機同權。§5.1 的
  > `LOCAL_ONLY_METHODS` 樣本已同步更新。

**餵給 S1**:`buildExecContext()` 改為讀此狀態 —

```ts
// ⚠️ 已知錯誤的初版(2026-07-27 實作,2026-07-28 已修正,見 §2.1):
autoMode: state.mode !== "always-ask"
attended: state.mode === "always-ask"          // ← 定義成 autoMode 的補數,錯
```

### 2.1 ⚠️ 設計錯誤與修正:`attended` 不是 `autoMode` 的補數

**錯誤**:上式把 `attended` 定義成 `autoMode` 的補數,等於把一個 2×2 壓成 1×2。

**後果(實作階段發現)**:`attended=false` ⟺ `autoMode=true` ⟹ 所有未分類請求在 `decide()` 第 4 步就被自動放行,**永遠走不到第 5 步的 escalate** ⟹ **[S1 L4 §6](./policy-engine_detail.md) 與 [S11 §4](../LAYER-3-hld/notification_hld.md) 花力氣定案的「無人值守時 escalate 掛起等人、不逾時 deny」變成死碼。** 那條規則存在的理由(「沒人回應 ≠ 拒絕」,不該讓整晚工作白費)恰恰是為了**「無人值守 + 未開 auto」**這個象限——而該象限被這個公式消滅了。

**根因**:兩個**正交**概念被混為一談 —
| 概念 | 語意 | 由誰決定 |
|---|---|---|
| `attended` | **現在有沒有人能回應?**(在場) | 環境事實 |
| `autoMode` | **使用者是否預先授權自動放行?**(政策) | 使用者設定 |

**修正:`attended` 改由「是否有 client 連線中」推導**(Gateway 已知此事實):

```ts
attended: gateway.hasConnectedClient()          // 有人看得到彈窗
autoMode: state.mode !== "always-ask"           // 與 attended 完全獨立
local:    !gateway.hasRemoteClient()            // 見下
```

還原後的正確 2×2:

| | **未開 auto** | **已開 auto** |
|---|---|---|
| **有 client 連線(attended)** | 逐筆問;逾時 5 分鐘 → deny | 中間地帶自動放行 |
| **無 client(unattended)** | **escalate 掛起等你回來** ← S11 的象限,修正後才活著 | 中間地帶自動放行 |

- 語意上也更正確:`attended` 字面就是「有人在」。**沒有 UI 連線時根本沒人看得到彈窗,5 分鐘後 deny 正是 S11 論證要避免的錯誤**。
- hard-deny 的行為不變且仍正確:無人值守時 → `deny`(沒人能做強確認),`local && attended` 才降級為 `escalate-strong`。

**`local` 一併修正(解決實作回報的最大落差)**:permission-request 不綁定單一 WS 連線,故不能問「這一筆是誰送的」。改用**保守的整體判定**:**只要有任何遠端 client 連線中,就視為非 local**。理由:遠端可能就是那個會去點「仍要允許」的人;fail-safe 方向要求寧可嚴、不可寬。這直接補上「auto 已開著時,遠端看到的 escalate-strong 仍被當本機處理」這個缺口。

> **狀態**:✅ **已實作(2026-07-28)**。
> - `attended`/`local` 的事實來源:`WsGateway.hasConnectedClient()` / `hasRemoteClient()`(`apps/core/src/gateway/ws-gateway.ts`)。
> - 依賴方向:`SessionManager` 不依賴 Gateway——宣告最小介面 `ClientPresencePort`,由 `apps/core/src/index.ts` 在 Gateway 建好後 `sessionManager.setClientPresence(gateway)` 事後注入(比照既有的 `setTeamBus()`,不製造建構子循環依賴)。
> - 組裝點:`SessionManager.buildExecContext()`(`apps/core/src/session/session-manager.ts`)。
> - **判定細節(實作時釘死)**:
>   - `hasConnectedClient()` 只算「OPEN **且已認證**」的連線——與 `broadcast()` 的條件完全一致,因為那才是收得到 `permission-request` 推播的連線集合。未認證連線收不到彈窗、也還不能呼叫 `permission.resolve`,把它當成「有人在」會讓請求落入 5 分鐘逾時 deny,正是 S11 §4 要避免的錯誤。
>   - `hasRemoteClient()` 則**不要求已認證**(未認證的遠端連線仍可能在幾秒內通過認證並回應)。兩者的不確定性都倒向「較嚴的那一邊」。
>   - 未注入 `ClientPresencePort` 時退化為 `attended=false` + `local=true`(= 沒有任何 client),此組合**不可能**產生 escalate-strong,忘記接線的失敗方向是安全的。
> - e2e:`scripts/e2e-policy-engine.mjs` 2f(無 client + 未開 auto → 掛起不逾時 deny,**真的把 WS 連線關掉**製造)、2g(有 client + 未開 auto → 逾時 deny)、Part 1 的 1i(2×2 四象限);`scripts/e2e-auto-mode-yolo.mjs` E-4/E-5(有遠端連線 → hard-deny 不降級;斷線後恢復降級)。
>
> ⚠️ **與 S1 的既有語意對齊**:S1 已實作「`!local || autoMode` ⇒ hard-deny 無條件 deny」。故 **auto 與 YOLO 都會讓 hard-deny 變成硬地板**(不降級為 escalate-strong)——這正是 HLD §6「auto 開著但撞到 hard-deny → deny」要的。

**YOLO 的「繞過一切」在哪實作**:`decide()` 第 4 步(`autoMode → allow`)已涵蓋中間地帶;YOLO 與 auto 的差別**僅在於**是否連 config `effect:"deny"` 規則也繞過。
- `auto`:仍受 config deny-list 約束(第 2 步)。
- `YOLO`:跳過第 2 步。**但 hard-deny(第 1 步)永遠不跳**。
  > ⚠️ **2026-08-25 修訂**(見 [DECISIONS.md §G](../DECISIONS.md)):「永遠不跳」
  > 現在有一個顯式 opt-in 例外——`trueUnrestricted`(前提是已處於 YOLO)會讓
  > `decide()` 在第 0 步就跳過 hard-deny,見 §5.1 修訂註記與
  > [S1 L4 §2](./policy-engine_detail.md)。單純的 YOLO(未額外開
  > `trueUnrestricted`)本身仍不影響 hard-deny 判斷。

---

## 3. 三種確認 UX(`PermissionModal.tsx`)

| 種類 | 觸發 | 樣式 | 選項 |
|---|---|---|---|
| **一般 escalate** | `strong === false` | 現況樣式 | 拒絕 / 允許 / **永遠允許…** |
| **escalate-strong** | `strong === true` | **紅色邊框 + 警示標題「此操作屬於硬性禁止項」** + 說明為何被擋 | 拒絕(**預設焦點**)/ 仍要允許(需**二次點擊確認**) |
| **YOLO 啟用確認** | 使用者點 YOLO 鈕 | 獨立對話框,列出「將繞過所有 config 規則、30 分鐘後自動關閉、hard-deny 仍生效」 | 取消(預設)/ 啟用 |

**硬性要求**:
- escalate-strong **不得**出現「永遠允許」(C4 紀律③)。
- escalate-strong 的「仍要允許」需二次點擊(防疲勞誤觸),且**不與一般彈窗的允許鈕同位置**。
- YOLO 鈕**不與 auto 鈕相鄰**。

---

## 4. 「永遠允許」→ 窄規則(HLD §4:半自動,預設最窄)

點「永遠允許…」→ 展開一個**範圍選擇**區塊,列出候選(**預設選最窄**):

| 工具類型 | 候選① 最窄(預設) | 候選② 較寬(需明選) |
|---|---|---|
| Bash 類 | `commandEquals: "<原指令字串>"` | `commandMatches: "^<第一個詞>\b.*"`(如 `^pnpm\b.*`) |
| 檔案類 | `pathUnder: "<該檔案所在目錄>"` | `pathUnder: "<worktree 根>"` |
| 其他 | `tool: "<toolName>"` 精確 | (無) |

- 區塊頂端顯示 **「你將永遠允許:<規則的人話描述>」**。
- 送出 `rememberRule` → Core 寫入 `config.json` 的 `policy.rules`,**unshift 或 push 依 effect**(allow → push 到尾端,deny → unshift,見 S1 L4 §2)。
- 寫入後**需重啟才生效**(policy 無熱重載,S1 L4 §5 判斷)⇒ **UI 必須明示這點**,否則使用者會困惑「我按了永遠允許怎麼又問我」。
  > **替代方案(建議實作)**:讓 `PolicyEngine` 持有一份可變的 rules 陣列,寫 config 的同時也 **in-memory 追加**,即時生效。這比「叫使用者重啟」好得多,且不違反「config 是權威來源」(重啟後從 config 讀回同樣的規則)。

**Core 端強制檢查(不可省)**:
```
若 該 requestId 當初是 escalate-strong 且 decision 帶 rememberRule
   → 拒絕寫入 + 記 audit(這是 UI bug 或惡意 client)
```

---

## 5. 遠端能力矩陣(F3/F4)

### 5.1 Gateway 硬拒(唯一的安全保證)

在 `ws-gateway.ts` 的 method dispatch 前加一道檢查:

> ⚠️ **2026-08-25 修訂**(見 [DECISIONS.md §G](../DECISIONS.md)):
> `session.setPermissionMode` 已從下面這份清單移除——使用者明確翻案原「遠端
> 不可切 auto/YOLO」的限制,本機與遠端現在同權;新增的
> `session.setTrueUnrestricted`/`policy.addRule`/`policy.removeRule`/
> `policy.listRules` 四個方法也**刻意不列入**這份清單,同一次翻案的一部分。
> 以下樣本已更新以反映現況,實際定義見 `ws-gateway.ts` 的 `LOCAL_ONLY_METHODS`。

```ts
const LOCAL_ONLY_METHODS = new Set([
  "config.setFile",                // 政策與設定
  "profile.create", "profile.update", "profile.delete",
  // 之後 S3b 的預算設定 method 也要加入
]);
if (!conn.isLocal && LOCAL_ONLY_METHODS.has(method)) → 回錯誤 + audit
```

**`escalate-strong` 的覆寫**:不在 method 層擋(它走既有的 `permission.resolve`),而是在 **S1 的 `decide()`** 擋——S1 已實作 `!local ⇒ hard-deny 直接 deny`,遠端根本收不到 strong 請求。**兩層一致,無需額外程式碼。**

> ⚠️ **2026-08-25 修訂**(見 [DECISIONS.md §G](../DECISIONS.md)):上面這段講的
> 是 `escalate-strong` 這一條路徑——遠端確實仍然拿不到 hard-deny 的「強確認
> 覆寫」提示,這點沒變。但這不代表遠端**完全**碰不到 hard-deny 的例外:新增
> 的 `trueUnrestricted`([S1 L4 §2](./policy-engine_detail.md))是另一條**獨立
> 、explicit opt-in** 的路徑,本機與遠端皆可觸發,見 `decide()` 最前面的
> 第 0 步短路。「遠端拿不到 escalate-strong」與「遠端完全碰不到 hard-deny 的
> 例外」不再是同一件事。

### 5.2 `isLocal` 判定(硬規則:絕不採信 client)

```ts
// 由 Core 依連線本身判定,唯一來源
isLocal = 正規化後的 remoteAddress ∈ { "127.0.0.1", "::1" }
```
既有 `ws-gateway.ts` L55 已有 IPv4-mapped IPv6 正規化(`::ffff:127.0.0.1`),**直接複用**。
⚠️ 隧道(Tailscale/WireGuard)來的連線**不是 loopback** ⇒ 視為遠端。**這是刻意的**:隧道只解決傳輸安全,不代表操作者在本機(F1/F3)。

### 5.3 握手能力集(消除 UI/Gateway 認知漂移)

`auth` 成功回應(或 `hello`)增加:
```ts
capabilities: {
  canToggleAuto: boolean;      // = isLocal
  canEnableYolo: boolean;      // = isLocal
  canEditPolicy: boolean;      // = isLocal
  canManageProfiles: boolean;  // = isLocal
}
```
UI **純依此渲染**(遠端隱藏這些控制項)。**安全仍由 §5.1 的每次檢查保證**,握手只是讓 UI 正確。

> ⚠️ **2026-08-25 修訂**(見 [DECISIONS.md §G](../DECISIONS.md)):`canToggleAuto`
> /`canEnableYolo`/`canEditPolicy` 三者不再等於 `isLocal`,已改成恆為
> `true`;「遠端隱藏這些控制項」不再成立,遠端現在會看到並可使用這些控制項。
> `canManageProfiles` 未變,仍等於 `isLocal`。另新增 `canEnableTrueUnrestricted`
> (恆 `true`,真正的把關在呼叫當下的 session-mode 前置條件,不是連線類型)
> 與 `isRemoteConnection`(純顯示用)兩個欄位。現況見 `ws-gateway.ts` 的
> `buildCapabilities()`。

---

## 6. 實作檢查清單

- [ ] `agent-profile.ts`:`PermissionLevelSchema` 收窄 + 新增 `SessionPermissionModeSchema`
- [ ] `packages/db/src/client.ts`:`auto-accept-all` → `auto-accept-edits` 遷移 + console.warn
- [ ] `events.ts`:`PermissionRequestEvent` 加 `strong`;`PermissionDecision` 的 `remember` 改 `rememberRule`
- [ ] `session-manager.ts`:`SessionPermissionState`、YOLO 惰性過期、`buildExecContext()` 接真值、escalate-strong 帶 `strong: true`
- [ ] `policy-engine.ts`:YOLO 跳過 config deny-list(第 2 步),**hard-deny 永不跳**
- [ ] `config-file-writer.ts` + `PolicyEngine`:`rememberRule` 寫入 config **且 in-memory 即時生效**(§4)
- [ ] Core 強制檢查:strong 請求不得帶 `rememberRule`
- [ ] `gateway.ts` + `ws-gateway.ts`:`session.setPermissionMode`、`LOCAL_ONLY_METHODS`、`isLocal`、握手 capabilities
- [ ] `PermissionModal.tsx`:三種 UX、範圍選擇區塊
- [ ] `ChatView.tsx`:session 標頭的 auto 常駐標記(HLD §2.2 補償防護)+ auto/YOLO 切換鈕(⚠️ 2026-08-25 起不再遠端隱藏,見 DECISIONS.md §G)
- [ ] e2e:auto 放行中間地帶、YOLO 跳過 config deny、**hard-deny 在 YOLO 下仍 deny**、YOLO 過期回落、遠端呼叫 local-only method 被拒、strong 請求帶 rememberRule 被拒

---

> **下一步**:交實作,或先 `/grill-me`(重點 §2 的 auto/YOLO 差異是否夠清楚、§4 的 in-memory 即時生效是否引入不一致風險、§5.2 把隧道視為遠端的取捨)。
