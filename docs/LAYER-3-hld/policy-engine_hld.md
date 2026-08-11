# S1 HLD:PolicyEngine + EnforcementKernel(最小版)

> 階段:**Phase 1**(安全罩地基)｜對應 L1:**C2–C6**、**F4**｜上層:[L2 §3](../LAYER-2-design-spec.md)、[DECISIONS §C](../DECISIONS.md)
> 定位:把現況 57 行的 timeout-and-forward 空殼(`permission-gateway.ts`),換成**真正的 default-deny 政策引擎**;並抽出三斷路器共用的 **EnforcementKernel** 最小版。
> **本 HLD 不含**:每 session auto 按鈕 / YOLO 的 UX 與暫態(→ S7);訊息/成本斷路器(→ S2/S3b),只定義它們共用的 kernel 介面。

---

## 1. 職責邊界

**PolicyEngine 負責**:
- 收到 adapter 轉來的 `permission-request`(工具呼叫),依政策 + **執行情境**產出決策:`allow` / `deny` / `escalate` / `escalate-strong`(見 §3)。
- **default-deny**:不在 allowlist、也不是 hard-deny → `escalate`(不是靜默放行,也不是直接 deny——留給人決定並可學習)。
- 維護 allowlist / deny-list(存 `~/.deskmony/config.json`,agent 不可寫)。
- 執行**硬性 deny 類**(內建、不可經 config 關閉,見 §4)。

**Enforcement 共用底座(最小版)負責**(S1 grill 定案:是**底座**,不是單一 kernel 物件,見 §5):
- `Notifier`:把事件送達人類(交給 S11)。
- `AuditLog`:append-only 寫入所有決策/升級/熔斷(D5)。
- 共用 `EnforcementEvent` schema:讓 escalation / trip / decision 都一致序列化。
- 供 S2(訊息熔斷)/ S3b(成本熔斷)**原封不動複用**的底座;`escalate` 與 `trip` 是建在其上的**兩條流程**,不是同一物件的兩個方法。

**不負責**:
- ❌ auto/YOLO 的 session 暫態與按鈕(→ S7,只在 §3 標出掛點)。
- ❌ 決定「工具呼叫本身能不能被攔」——那是 adapter 的 `permissionRequests` 能力(PTY 無閘,C7 唯讀)。

---

## 2. 政策資料模型(存 config.json,agent 不可寫)

```ts
policy: {
  rules: [
    // 依序比對,第一個 match 決定結果;都不 match → default-deny(escalate)
    { match: { tool: "Read" }, effect: "allow" },
    { match: { tool: "Write", pathUnder: "<worktree>" }, effect: "allow" },
    { match: { tool: "Bash", command: "^(pnpm|npm) (test|run build)$" }, effect: "allow" },
    // ... 由 UI「永遠允許」學習而來(C4),或人手改
  ],
  // 每 agent/角色的寬鬆度(對應既有 AgentProfile.permissionLevel)
}
```

- **match 維度**:`tool`(工具名)+ 選配的細化(`pathUnder` 路徑前綴、`command` regex、`host` 網域)。
- **effect**:`allow` / `deny`(明確拒絕)/ 省略 → 未 match。
- **完整性(C3)**:policy 只在 `~/.deskmony/config.json`,家目錄在 worktree 外;寫入路徑擋 agent(與 acceptance 欄位同紀律)。config loader 已拒收憑證欄位(現況),此處延伸拒收「來自 agent 上下文的寫入」。

---

## 3. 決策函式(核心)

```
decide(request, ctx: ExecContext) -> "allow" | "deny" | "escalate" | "escalate-strong"

ExecContext = { attended: boolean;   // 有人看(always-ask)還是無人值守
                local: boolean;      // 本機 console 還是遠端 client
                autoMode: boolean }  // session auto / YOLO 是否開啟(S7 供給)
```

**優先序(硬性最高,default 最低)**:

```
1. 命中 hard-deny 類?
     ├─ 遠端 或 auto/YOLO 開啟        → deny            (硬地板,F4)
     └─ 本機 + attended(always-ask)  → escalate-strong (獨立強確認,非一般 allow/deny)
2. 命中 config deny-list?             → deny
3. 命中 allowlist?                    → allow
4. (S7 掛點) session auto mode?       → 中間地帶轉 allow;hard-deny 類仍走 1
5. 皆否(未分類長尾)                  → escalate        (= default-deny,C2)
```

**情境相依的 hard-deny(S1 grill 定案)**:S1 **擁有規則**,S7/remote 層**供給 `ExecContext` 旗標**。在最該守的地方(無人值守、auto/YOLO、遠端、token 外洩)hard-deny 維持硬地板不可覆寫(F4);只有「本機 + 有人看」時降級為 `escalate-strong`,讓罕見的合法邊界案不必改內建規則重編。`escalate-strong` 的確認 UX(更嚇人、與一般核可視覺區隔、不可「永遠允許」)由 **S7** 實作。

- **escalate** 交給共用底座:發 `escalation` 事件 → Notification(S11)送達人類 → 人回 `allow/deny`(可帶 `remember`,C4:寫回 config allowlist)→ PolicyEngine 呼叫 adapter `resolvePermission()`。
- **逾時:情境相依**(⚠️ **S11 grill 反向修正**,見 [S11 §4](./notification_hld.md)):
  - **attended(有人看)** → 短逾時(5 分鐘)**deny**。你在旁邊,不理 = 不想要。
  - **無人值守** → **不 deny**,轉掛起 `waiting-permission`(session 不推進、不佔資源),人回來即繼續。理由:無人值守的前提就是你不在,把「沒人回應」解讀成「拒絕」會讓整晚工作白費。掛起與 deny **一樣安全**(什麼都沒執行),但保留繼續的可能。止損改由**成本/時間預算(S3b)**負責。
- **既有掛點**:`AgentProfile.permissionLevel`(`always-ask`/`auto-accept-edits`/`auto-accept-all`)已存在,對應步驟 4 的預設模式;S7 負責把它變成 per-session 可覆寫的暫態。

---

## 4. 硬性 deny 類(內建、config 不可關閉 — F4)

**永遠 deny、永不「永遠允許」、即使 auto/YOLO 也不放行**(DECISIONS C5/C6):

| 類 | 判定(best-effort) |
|---|---|
| worktree 外寫入/刪除 | 路徑正規化後不在 workspace 邊界內 |
| 讀秘密路徑 | `~/.ssh`、`.env`、憑證庫、`~/.deskmony/config.json` 自身 |
| force-push / 危險 git | `git push --force`、刪遠端分支 |
| 非白名單網路外連 | host 不在 allowlist |

> **誠實的限制(grill 點)**:對 **Bash/shell**,指令可被混淆(`bash -c`、`$()`、base64)——**deny-list 對 shell 是 best-effort,擋不住決心繞過的**。所以:shell 類**預設 escalate**(不靠 pattern 放行);hard-deny 的 pattern 只擋「明顯的意外」,**真正的圍堵是 worktree 邊界 +(S12)沙箱**,不是字串比對。這與 C7 對 PTY 的結論一致。

### 4.1 ⚠️ Phase 1「無人值守」的真實範圍(S1 grill 定案)

事實鏈:核心三家(Claude Code/Codex via ACP、OpenCode)**都會把 bash 當 permission-request 送出來**,所以 gate 沒被繞過 ✅;但 coding agent **大量透過 shell 幹活**,而 shell 指令**無法可靠分類**。在 default-deny 下,無法分類 → escalate。

**因此必須白紙黑字承認**:

> **shell-heavy 的「低打擾無人值守」受制於 S12 沙箱。** 在沙箱到位前,Phase 1 的無人值守 = **「無人值守 + 偶爾被 webhook 叫回來核可」**,不是「徹夜放著 shell agent 亂跑」。

- allowlist 只能替**重複的完全相同指令**減負;coding agent 指令千變萬化,allowlist 要嘛太小(狂 escalate)、要嘛放寬成 `.*`(fail-open,禁止)。
- **不把沙箱塞進 Phase 1**(Windows 上 = WSL2/容器,是大工程,會讓 Phase 1 出不了貨)。
- **路線圖含意**:**S12 與 Phase 1 的無人值守承諾,綁得比 L2 原本承認的更緊**。S12 維持 deferred,但它是「shell agent 低打擾無人值守」的**前置條件**,不是可有可無的加強。→ 已回寫 [L2 §2](../LAYER-2-design-spec.md)。

---

## 5. Enforcement 共用底座(S1 grill 定案:底座,非單一 kernel)

**為何不是一個 `EnforcementKernel` 物件**:`escalate` 與 `trip` 是**根本不同的互動形狀**——
- `escalate`(權限):請求 → **等人回決策** → 回傳 `Decision`。**雙向**。
- `trip`(成本/訊息預算耗盡):**單方面叫停** + 通知 → `void`。**單向**。

硬塞進同一介面,會逼 S2/S3b 實作對它們形狀不合的 `escalate`,或逼 S1 帶一個用不到的 `trip`。兩者**真正共用的只有底座**:

```ts
// ── 共用底座(隨 S1 出最小版,S2/S3b 原封不動複用)──
interface Notifier   { deliver(e: EnforcementEvent): Promise<void>; }   // → S11
interface AuditLog   { append(e: EnforcementEvent): void; }             // → D5, append-only
type EnforcementEvent =                                                  // 一致序列化
  | { kind: "escalation"; ... } | { kind: "trip"; ... } | { kind: "decision"; ... };

// ── 建在底座上的兩條流程(形狀不同,各自實作)──
// S1:   escalate(req, ctx) -> Promise<Decision>   （notify + 等回覆 + 逾時 fail-safe + audit）
// S2/S3b: trip(event)      -> void                （halt + notify + audit）
```

- **「隨 S1 出最小版」的具體內容 = 底座三件**(Notifier / AuditLog / EnforcementEvent schema),不是三個方法的大物件。
- L2 所說「三斷路器共用 kernel」,精確化為「三斷路器共用**底座**」。

---

## 6. 失敗模式

| 情境 | 行為 |
|---|---|
| policy config 不存在/損毀 | **全部 escalate**(fail-safe:無政策 = 什麼都問人,不 fail-open)。 |
| adapter 無 `permissionRequests`(PTY) | 無請求可決策;該 tier 唯讀(C7),不在 S1 範圍。 |
| escalate / escalate-strong 逾時無人回 | **情境相依**(S11 §4):attended → deny;無人值守 → 掛起 `waiting-permission`,由 S3b 預算止損。 |
| Notification 送不出去 | 稽核 log 記「未送達」;逾時行為同上。**不因通知失敗而放行**。 |
| hard-deny 誤傷正常操作 | **本機+attended** → `escalate-strong`,人可當場強確認放行(不需重編)。**遠端/auto/YOLO** → 直接 deny,無覆寫(F4)。 |
| shell 指令無法分類(常態) | escalate。頻繁 escalate 是 Phase 1 的**已知代價**,見 §4.1;緩解靠 S11 通知 + S12 沙箱。 |

---

## 7. 對應 L1 決策

C2 default-deny · C3 policy agent 不可寫、存家目錄 · C4 escalate 可 remember→寫 allowlist · C5 硬性 deny 類 · C6 auto 掛點(S7 細化)· F4 安全罩遠端/auto 下 hard-deny 為硬地板 · D5 稽核 log(底座 AuditLog)。

---

## 8. 開放問題(留給 L4 / S7)

1. **match 語法的精確度**(L4):`command` regex 夠嗎?路徑比對如何處理符號連結逃逸?host allowlist 如何涵蓋 IP/DNS?
2. **per-agent/role 寬鬆度**:`permissionLevel` 之外,要不要 per-role 的 allowlist 繼承?
3. **S7 銜接**:session auto 暫態如何覆寫 profile 的 `permissionLevel` 並供給 `ExecContext`;`escalate-strong` 的確認 UX;YOLO 如何在遠端被禁用(F3)。
4. **attended 的逾時 deny 是否該同時發 trip 事件**,讓人知道「有東西卡住被拒了」。(無人值守的掛起分支已由 S11 §4 定案。)

---

> **S1 grill 已完成(2026-07-24)**,3 項定案:
> ① **shell 決策 = 指令分類 + escalate 長尾**,並承認「shell 低打擾無人值守受制於 S12 沙箱」(§4.1),S12 與 Phase 1 承諾的耦合已回寫 L2。
> ② **hard-deny 情境相依**:遠端/auto/YOLO → 硬 deny;本機+attended → `escalate-strong`。S1 擁有規則,S7 供 `ExecContext` 與確認 UX。
> ③ **kernel 拆成共用底座**(Notifier / AuditLog / EnforcementEvent schema)+ escalate/trip 兩條流程,不硬併成單一物件。
> **下一步**:S7(auto/YOLO,與本 HLD 耦合最緊)或 S11(Notification,底座的送達端);或 S1 進 L4。
