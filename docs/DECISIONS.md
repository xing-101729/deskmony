# Deskmony 設計定案(Design Decision Record)

> 本文件是 **權威設計基準**,於 2026-07-24 一場 15 題 grilling 後定稿。
> 凡與 [`ARCHITECTURE.md`](./ARCHITECTURE.md) 衝突之處,**以本文件為準**。
>
> ⚠️ **2026-08-18 更新**:文末「對 ARCHITECTURE.md 的更正」指的是
> [`ARCHITECTURE-legacy-2026-07.md`](./ARCHITECTURE-legacy-2026-07.md)(當時的
> 早期概念草圖,現已封存)。**[`ARCHITECTURE.md`](./ARCHITECTURE.md) 已依實際
> 原始碼重寫**,那些更正都已納入,不再需要靠這一節去修補。
>
> ⚠️ **2026-08-25 更新**:使用者在被完整攤開「F3/C6 的遠端限制、hard-deny
> 可繞過性各自防的是什麼」後(兩輪追問確認),明確決定翻案部分規則:遠端連線
> 現在可切 session 的 auto/YOLO 模式、可編輯政策 allowlist(原 F3/C6 的
> 「遠端禁止」已取消);另新增一層比 YOLO 更深、**可繞過 C5 四類 hard-deny**
> 的「真.無限制」(`trueUnrestricted`)開關,本機與遠端皆可用,啟用需強警告
> 確認 + 稽核。落地於 `apps/core/src/gateway/ws-gateway.ts` 的
> `LOCAL_ONLY_METHODS`(已移除 `session.setPermissionMode`)與
> `apps/core/src/permissions/policy-engine.ts` 的 `decide()`(新增
> `ctx.trueUnrestricted` 短路)。完整範圍與「沒改什麼」見文末 **§G**。

---

## 0. 貫穿全局的設計主軸:無人值守安全罩

Deskmony 的核心不是「多 agent 能互聊」,而是**讓一隊 agent 能無人值守跑數小時而不失控**。
一切決策服務於一個**由三個獨立斷路器組成的安全罩**:

| 斷路器 | 防的東西 | 機制 |
|---|---|---|
| **權限** | agent 亂動手(刪檔、外洩、force-push) | default-deny 政策引擎(§C) |
| **訊息** | agent 互傳訊息死循環 / 訊息風暴 | 每 context 訊息/hop 預算 + 熔斷(§A5) |
| **成本** | token 一夜燒爆 | usage 量測 + 任務預算 + 每日 kill-switch(§E) |

三條線各自獨立,任一條都能單獨叫停失控。**這三者的設定,遠端一律不可停用(§F)。**

> ⚠️ **2026-08-25 起的例外**:上一句對**權限**斷路器不再完全成立——auto/YOLO
> 切換與 allowlist 編輯現在遠端也能做;**訊息、成本兩條斷路器不受影響**,
> 遠端依然無法停用。完整原因與範圍見 **§G**。

---

## A. 協作模型

| # | 決策 | 說明 |
|---|---|---|
| A1 | **混合協作** | 階層骨架 + peer 橫向溝通。**不是**純 peer-to-peer。 |
| A2 | **LLM 提議、人/規則裁決** | 發散工作(拆解、找路、寫扣)給 LLM;**收斂決策**(定案拆解、判定完成、批准合併)由人或硬規則把關。同一個 LLM 不得既拆解又自評完成。 |
| A3 | **done = 機器可驗證驗收閘** | `report_status(done)` 必須先過該任務定義的測試 / build / typecheck / 自訂指令,否則系統直接打回,進不了 Review。純探索型任務可標「無機器驗收、強制人判」為例外。 |
| A4 | **角色決定生命週期** | lead + 少數需跨任務記憶的角色(如熟悉 codebase 的 Reviewer)長命;純執行 worker 隨任務生滅。投遞層必須把「對方不在線」當一等公民。 |
| A5 | **peer 訊息綁 context** | 無 task/review 脈絡的訊息一律拒收。**每個 context 自帶訊息數 / hop 深度預算**,燒完熔斷並回報 lead 或人類。脈絡閘擋無脈絡閒聊,脈絡預算擋脈絡內死循環。 |

## B. 多後端 Adapter

| # | 決策 | 說明 |
|---|---|---|
| B1 | **核心 set = {Claude Code, Codex, OpenCode}** | **放棄 Antigravity**(原生 `--acp` 未出貨,不依賴第三方橋)。PTY 為任意其他 CLI 的保底。 |
| B2 | **ACP 收斂** | Claude Code + Codex 走 ACP(Codex CLI 本身**不**原生講 ACP,經 `@agentclientprotocol/codex-acp` 橋接套件對接,但仍**無需 bespoke codex adapter**——橋接套件走既有的通用 `AcpAdapter`);OpenCode 維持 bespoke HTTP/SSE;PTY 保底。ACP `diff:false` 的缺口已補上(`capabilities().diff` 現為 `true`):`AcpAdapter` 內建兩條路徑——路徑 A 優先讀取原生 `ToolCallContent` 的 `type:"diff"` 區塊;沒有時走路徑 B,在 `tool_call`(kind==="edit")建立時、`tool_call_update` 完成時各**直接讀一次目標檔案內容**合成 before/after(不是呼叫外部 `git diff` 指令),交給 `diff` 套件的 `structuredPatch()` 產生 hunk,重用既有的 `ToolResultEvent.structuredResult` → `DiffHunkView` 顯示管線,無需新的事件型別或 UI 元件。細節見 `packages/adapters/src/acp-adapter.ts`。 |
| B3 | **放棄「ACP 省工」幻覺** | adapter 本就逐家客製,ACP 只是剛好覆蓋兩家的其中一個 adapter,不是救世主。廣度是 feature,不是 moat;護城河在協作層。 |
| B4 | **能力分層 = 安全分層** | 「相容 tier」(PTY)不只少 diff,更**結構上無法執行權限政策**。見 C6。 |

## C. 安全 / 權限(最高風險分支)

| # | 決策 | 說明 |
|---|---|---|
| C1 | **政策層 + 一小片沙箱** | 政策引擎管有閘門的 adapter;沙箱專門圍堵「不可逆/越界」與無閘門 tier。 |
| C2 | **default-deny** | 未分類操作 → 升級給人 / 擋下。**fail-safe,不 fail-open。** 自主程度靠 allowlist 漸進長出,不是第一天全開。 |
| C3 | **政策存 `~/.deskmony/config.json`,agent 永不可寫** | 家目錄在 agent worktree 外;靠「worktree 外一律 deny」+ config 在家目錄雙重保護。 |
| C4 | **allowlist 靠 UI 學習 + 手改並存** | 三條硬紀律:①「永遠允許」預設**記窄的**(this tool + arg pattern,非整類) ②UI 寫的全落**同一份可讀 config**,可手動稽核/砍 ③**硬性 deny 類永不給「永遠允許」**。 |
| C5 | **硬性 deny 類(永遠升級、不學習)** | force-push、讀秘密路徑(`~/.ssh`、`.env`、憑證庫)、worktree 外刪除、對非白名單主機的網路外連。 |
| C6 | **每 session auto 按鈕 = 語意 (ii)** | 只把「未分類中間地帶」變自動放行;**硬性 deny 類即使 auto mode 也一律升級**。真 YOLO(繞過一切)拆成**獨立、更難按、要更強確認**的開關,**本機與遠端皆可啟用**(⚠️ 原「遠端禁用」已於 2026-08-25 翻案;另新增可繞過硬性 deny 類的「真.無限制」層,啟用需強警告確認 + 稽核,詳見 §G)。auto 是 **session 暫態,不寫 config**;會寫持久政策的只有 C4 的「永遠允許」。 |
| C7 | **PTY 沙箱前一律唯讀、不給自主權** | `GenericPtyAdapter` 是 raw stdin 直通、`permissionRequests:false`,結構上無法被政策管。建出環境沙箱(Windows:WSL2/容器/鎖死 VM)前,PTY agent 不給自主權。**不做 shell 指令攔截**(被 `bash -c`/`$()`/base64 秒破,是 security theater)。 |

> **無人值守 vs 有人看**:auto 按鈕是「有人看著單一 session」時的省事開關;無人值守的安全**只能**來自 C4 的窄 allowlist,不能靠「把全部 session 按成 auto 然後走人」——那只是繞遠路的 default-allow ×N。

## D. 崩潰復原

| # | 決策 | 說明 |
|---|---|---|
| D1 | **不做完整 event sourcing** | 最貴的東西(agent 累積的推理/context)活在**後端 agent 行程**裡,不在 DB。replay 重建的是你的帳本,不是 agent 的腦。崩潰復原本質是「對帳 + 人工分流」,不是 replay。 |
| D2 | **session 自動對帳** | 重啟時死掉的 session 標 `interrupted`;後端支援續接的(Claude Code session-id、OpenCode session)給一鍵續接;不支援的(PTY)誠實顯示「已消失」。 |
| D3 | **任務永不自動續接** | mid-flight 任務崩潰後給「復原視圖」列出中斷任務 + 髒 worktree,人類逐一決定(續/重跑/放棄)。丟了 context 的 agent 自動接著跑 = 重做/半做/毀壞的溫床。 |
| D4 | **Mailbox 持久化** | 未送出訊息落 `teamMessages`,不可只在記憶體。與 A4「對方不在線 → 落持久 Mailbox」同一機制,順便買到崩潰安全。 |
| D5 | **保留便宜的稽核 log** | append-only 只記訊息 + 權限決策,供除錯與安全稽核;但**不**把全系統狀態重架成事件。 |

## E. 成本治理

| # | 決策 | 說明 |
|---|---|---|
| E1 | **做 usage 量測** | 補一個一等公民 `usage` AgentEvent,來源:ACP `usage_update`、Claude SDK `result.usage`、OpenCode usage。PTY 報不了 → 又一個「PTY 唯讀/需人陪」的理由。 |
| E2 | **任務預算硬上限** | 燒破 → halt + 升級(同 A5 circuit-breaker 模式)。 |
| E3 | **每日 / 全域 kill-switch** | 團隊總花費到頂 → 全部暫停。 |
| E4 | **保守預設、有意識才開大** | 同 default-deny 哲學。上限是**反應式**的:框住損害,非精準防超支。 |

## F. 遠端(M5)

| # | 決策 | 說明 |
|---|---|---|
| F1 | **不自己搞 TLS** | 預設綁 localhost;要遠端強制走 Tailscale/WireGuard/SSH 隧道(給你加密 + 網路層認證 + 不公開曝露)。 |
| F2 | **明文綁非 loopback 要明確確認** | 硬規則:`ws://` 綁非 loopback 介面必須有「我知道這在隧道後面」的明確確認,否則拒絕。 |
| F3 | **遠端能力受限** | 遠端**可**:觀察、送 prompt、逐一核可/拒絕權限升級、切 auto/YOLO 模式、改 allowlist/政策(⚠️ 後三項 2026-08-25 起開放,原屬「不可」,詳見 §G)。遠端**不可**:建改 agent profile、改綁介面、改預算上限。 |
| F4 | **安全罩本身遠端不可停用** | 三斷路器(權限/訊息/成本)及其設定,遠端一律不可停用。原則:**遠端能在安全罩內幹活,但不能改動安全罩本身。** ⚠️ **2026-08-25 起的例外**:權限斷路器新增兩條遠端可達的鬆綁路徑(auto/YOLO 切換、allowlist 編輯),另有本機與遠端皆可用、可繞過 hard-deny 的 `trueUnrestricted` 層;**訊息(A5)與成本(E1–E3)兩條斷路器完全不受影響**,遠端仍無法停用。詳見 §G。 |

---

## 這份共識逼出的「淨新增工作」(目前 codebase 沒有)

依風險 / 依賴排序,**與現況落差最大者在前**:

1. **政策引擎(C2–C6)** — gateway 目前只 forward+timeout(57 行空殼),無 allowlist/deny-list/default-deny/auto 語意。**安全罩的地基,最優先。**
2. **context 訊息預算 + 熔斷(A5)** — MessageBus 目前**零**失控防護。
3. **usage 量測 + 預算斷路器(E1–E3)** — AgentEvent 目前無 usage 欄位。
4. **機器驗收閘(A3)** — TaskService 目前無驗收條件概念。
5. **LLM lead/orchestrator(A2)** — 目前 TaskService 純確定性,沒有會提議拆解的 LLM。
6. **崩潰對帳 + 復原視圖 + Mailbox 持久化(D2–D4)**。
7. **每 session auto 按鈕(語意 ii)+ 獨立 YOLO + 遠端能力矩陣(C6, F3–F4)**。

---

## 對早期 ARCHITECTURE.md 的更正(它寫過頭了)

> 以下針對的是 [`ARCHITECTURE-legacy-2026-07.md`](./ARCHITECTURE-legacy-2026-07.md)。
> 現行的 [`ARCHITECTURE.md`](./ARCHITECTURE.md) 已重寫,這些更正全部已納入。

- ❌ **「Event Sourcing 可回放重建」** → 現實是當前狀態 CRUD(9 張表,無 event log),而且 event sourcing 救不了崩潰復原(D1)。
- ❌ **文件列的 `CodexAdapter`** → **不存在**;Codex 走 ACP(經 `@agentclientprotocol/codex-acp` 橋接套件,B2)。
- ❌ **「ACP-first 省下逐家客製」** → 你最肥的 adapter(OpenCode 36KB)是全客製(B3)。
- ⚠️ **PermissionGateway 被畫成核心元件** → 實際是 57 行 timeout-and-forward 空殼,政策引擎還沒寫(淨新增 #1)。
- ⚠️ **adapter set 含 Gemini CLI / Antigravity** → 核心 set 收斂為 {Claude Code, Codex, OpenCode},放棄 Antigravity(B1)。

---

## G. 2026-08-25 修訂:遠端與真.無限制層

> 使用者在被完整攤開「F3/C6 的遠端限制、C5 hard-deny 各自防的是什麼」後
> (兩輪追問確認),明確決定翻案以下規則。這是**有意識的決定**,不是遺漏或
> 倒退——C2(default-deny 鐵則)與 C5(hard-deny 四類的**定義**)本身未變,
> 變的是「誰能碰、能碰多深」。

**改了什麼**:

| 項目 | 舊規則 | 新規則 | 落地位置 |
|---|---|---|---|
| 遠端切 session auto/YOLO 模式 | 遠端禁止(原 F3/C6) | 遠端與本機同權 | `apps/core/src/gateway/ws-gateway.ts`:`LOCAL_ONLY_METHODS` 已移除 `session.setPermissionMode` |
| 遠端編輯政策 allowlist | 遠端禁止(原 F3) | 遠端與本機同權 | 新增 `policy.addRule`/`policy.removeRule`/`policy.listRules`,刻意不列入 `LOCAL_ONLY_METHODS` |
| 握手能力集 | `canToggleAuto`/`canEnableYolo`/`canEditPolicy` 恆等於 `isLocal` | 三者恆為 `true` | `WsGateway.buildCapabilities()` |
| **新增**「真.無限制」層(`trueUnrestricted`) | 不存在 | YOLO 之上再加一層,**可繞過 C5 四類 hard-deny**(worktree 外刪除、讀秘密路徑、force-push、非白名單外連);本機與遠端皆可啟用;前提是該 session 已處於 YOLO(`auto-accept-all`),否則拒絕啟用(`SESSION_TRUE_UNRESTRICTED_REQUIRES_YOLO`);啟用當下強制 UI 強警告確認 + 桌面通知 + 稽核記錄(關閉時只記稽核、不推播) | `apps/core/src/permissions/policy-engine.ts`:`decide()` 新增第 0 步,`ctx.trueUnrestricted` 為真時直接 `allow`——唯一能跳過 hard-deny 判斷的路徑;`apps/core/src/session/session-manager.ts`:`setTrueUnrestricted()` |

**沒改什麼**(使用者這輪未要求,維持 local-only):

- Profile 建立/刪除(`profile.create`/`profile.delete`)。
- daemon 綁定介面(bind host)變更。
- 預算上限變更(`config.setFile` 既有安全子集)。
- **C5 四類 hard-deny 的定義本身**——`hard-deny.ts` 未動,沒有變寬、沒有減類。變的只是「有沒有一個明確 opt-in 的開關能繞過它」,不是這四類的範圍或判定方式。
- MCP-bridge agent token 的 method allowlist(`computeAllowedMethods()`)——刻意未動;agent 無法透過自己的工具呼叫取得 `trueUnrestricted` 或改 allowlist 的能力,這仍然是人類/UI-only 的操作。

**為何 `trueUnrestricted` 不算打破 C2 的 default-deny 鐵則**:它不是新的「未分類自動放行」規則,而是**單一 session、需先已處於 YOLO、且要求額外顯式開啟**的例外閘門——沒有規則比對或 autoMode 能觸發它。`decide()` 把這個短路刻意放在函式最開頭(第 0 步,先於 hard-deny 判斷本身),不是埋在 hard-deny 分支裡——grep `trueUnrestricted` 找到的就是這個唯一入口,審查者不需要先看懂 hard-deny 邏輯才發現這裡有例外。

**對應修訂**:**C6**「真 YOLO…遠端禁用」已改為本機遠端同權;**F3**「遠端不可:開 YOLO、切 auto mode、改 allowlist/政策」三項已移至「遠端可」;**F4**——三斷路器中只有**權限**這條新增遠端可達的鬆綁路徑,訊息(A5)、成本(E1–E3)不受影響。
