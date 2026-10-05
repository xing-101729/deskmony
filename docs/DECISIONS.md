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
| A5 | **peer 訊息綁 context** | 無 task/review 脈絡的訊息一律拒收。**每個 context 自帶訊息數預算**,燒完熔斷並回報 lead 或人類。脈絡閘擋無脈絡閒聊,脈絡預算擋脈絡內死循環。<br>⚠️ **2026-09-04 更正**:原文寫「訊息數 / **hop 深度**預算」,但 hop 深度從未實作 —— 實際落地的只有訊息數這一條(`core-config.ts` 明載它是 Phase 2「唯一主防線」,hop 深度 / A↔B 頻率 / broadcast 冷卻**全部延後**;`message-budget_hld.md` §與 `_detail.md` 也都標「⏸ 延後」)。`FEATURES.md` 一直是對的,是這份文件沒跟上。 |

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
| E1 | **做 usage 量測** | 補一個一等公民 `usage` AgentEvent。PTY 報不了 → 又一個「PTY 唯讀/需人陪」的理由。<br>⚠️ **2026-09-04 更正**:原文列的三個來源(ACP `usage_update`、Claude SDK `result.usage`、OpenCode usage)**實測只有一個可用**。經 bridge 的 Claude Code 從頭到尾送 0 個 `usage_update`(`acp-adapter.ts` 實測紀錄,且是結構性的 → `usageReporting: "unknown"`);OpenCode adapter 如實回報 `"unsupported"`。**唯一真正會發 `usage` 事件的是 `ClaudeAgentSdkAdapter`**。對其他後端,所有 usage-based 預算是空轉,只剩不依賴 usage 的 `TurnLimiter` —— 這是成本斷路器實際涵蓋範圍的重大限制,README 已誠實揭露,這份文件補上。 |
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

## 這份共識逼出的「淨新增工作」

> ⚠️ **2026-09-04 更正**:本節原標題是「(目前 codebase 沒有)」,寫於 2026-07-24。
> **七項裡有六項早已完成**,只讀這一節會嚴重誤判專案進度。逐項現況標註如下,
> 標題也已拿掉那個已經不成立的括號。

依風險 / 依賴排序(原始順序保留,不重排):

1. ✅ **已完成** — **政策引擎(C2–C6)**。落地於 `apps/core/src/permissions/policy-engine.ts` 與 `hard-deny.ts`。
2. ✅ **已完成(部分)** — **context 訊息預算 + 熔斷(A5)**,落地於 `apps/core/src/bus/message-bus.ts`。**僅訊息數維度**,hop 深度仍未做(見上面 A5 的更正)。
3. ✅ **已完成(涵蓋範圍受限)** — **usage 量測 + 預算斷路器(E1–E3)**,落地於 `apps/core/src/cost/cost-governor.ts`。但只有 `claude-agent-sdk` 後端真的會發 usage(見上面 E1 的更正)。
4. ✅ **已完成** — **機器驗收閘(A3)**,落地於 `apps/core/src/tasks/acceptance-runner.ts`。
5. ⬜ **仍未做** — **LLM lead/orchestrator(A2)**:`TaskService` 目前仍是純確定性的,沒有會提議拆解的 LLM。**這是七項裡唯一還沒做的。**
6. ✅ **已完成** — **崩潰對帳 + 復原視圖 + Mailbox 持久化(D2–D4)**,落地於 `apps/core/src/recovery/recovery-service.ts` 與 `team_messages` 表。
7. ✅ **已完成** — **每 session auto 按鈕 + 獨立 YOLO + 遠端能力矩陣(C6, F3–F4)**,落地於 `session-manager.ts` 與 `ws-gateway.ts` 的 `buildCapabilities()`。遠端能力矩陣已於 2026-08-25 翻案(見 §G)。

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

---

## H. 2026-10-02 修訂:簡化——拿掉 profile 與 team/看板,改成全 session 互傳訊息

> 使用者要求「功能簡單化」:從電腦找到各種 agent 軟體直接使用、不用每個都建 profile、每個 session
> 知道有哪些 agent 可用並能建 session、session 之間能互傳對話。追問後四項定案由使用者親自選定。
> 完整規格:[`LAYER-4-detail-design/simplify-agents-sessions_detail.md`](./LAYER-4-detail-design/simplify-agents-sessions_detail.md)。

**撤銷 / 改寫的決策**:

| 原決策 | 之後 |
|---|---|
| **A1** 混合協作(階層骨架 + peer)、**A4** 角色決定生命週期 | 撤銷。沒有 team、沒有角色;所有 session 平等、互相可見,誰建了誰只用來顯示巢狀與溯源。 |
| **A2** LLM 提議、人/規則裁決(lead + dispose-gate) | 撤銷 lead/dispose-gate。收斂決策回到人類直接在各 session 裡下指示。 |
| **A3** done = 機器驗收閘 | 撤銷(隨 task 一起移除)。 |
| **A5** peer 訊息綁 task/review 脈絡 + 每 context 訊息預算 | **改寫**:不再要求脈絡(使用者要任意 session 互傳),改為「**每條訊息鏈**的訊息數預算」——人類輸入開新鏈,agent 轉發沿用觸發它那一輪的鏈,超過 `messageBudget.maxMessagesPerContext` 即熔斷並通知人。訊息斷路器仍是三條斷路器之一,遠端仍不可停用。 |
| **D3** 任務永不自動續接 + 復原視圖列髒 worktree、**D4** Mailbox 持久化 | 任務部分撤銷;session 對帳(D2)保留。跨 session 訊息若目標忙碌,在記憶體佇列等待,core 重啟即遺失(不再有 Mailbox)。 |
| **E2** 任務預算硬上限 | 撤銷(隨 task 一起移除)。E1 用量量測、E3 每日 kill-switch 保留。 |
| **F3** 遠端不可建改 agent profile | profile 已不存在,此項自然失效。 |

**新增**:

- 回覆語意:**不做任何自動回送**。收到訊息的 agent 自己決定要不要回、回給誰(使用者原話:「畢竟不一定給 A」)。S12 的「子完成 → 結果注入父」一併移除。
- 跨 session 工具 `create_session` / `send_to_session` 走既有權限流程(default-deny 不變);`list_agents` / `list_sessions` / `read_session` 純查詢,自動放行。

**沒改什麼**:§C 權限斷路器全部規則、§E1/E3、§F 其餘項、§G。


---

## I. 2026-10-03 修訂:OpenCode 也走政策引擎、HTTP 版也掛 session 工具、本機伺服器加認證

> 在簡化重構(§H)之後的三個相關修補。§C 的規則本身一條都沒改——補的是「OpenCode 對這些規則形同虛設」的洞。

**1. OpenCode 的工具呼叫一律經過 PolicyEngine(C2 / C5 / C6 對它補上)。** opencode **預設所有工具權限都是 allow**,
只有它自己設定裡標成 `"ask"` 的才會發 `permission.asked`(HTTP)/ `session/request_permission`(ACP);使用者的 opencode
設定通常沒有 `permission` 段,所以過去 OpenCode session 的 bash / edit / webfetch / MCP 呼叫大多**根本到不了**政策引擎
——default-deny、hard-deny 四類、auto/YOLO 對它全部失效。現在 Deskmony 啟動 opencode 子行程時(`opencode` 與
`opencode-acp` 兩個 provider)用環境變數 `OPENCODE_CONFIG_CONTENT` 注入「所有工具都 ask」的設定,與使用者既有的值
深度合併(Deskmony 的 `permission` 優先)。寫法、實測依據與已知邊界見 `packages/adapters/src/opencode-config.ts` 檔頭。

- **使用者可見的改變**:`always-ask` 下的 OpenCode session 原本靜默執行的操作,現在會跳權限確認;auto/YOLO 照常放行。
- **為了讓它真的有效而一併補的**:(a) `permission-request` 帶上工具參數(沒有 input,hard-deny 與 allowlist 規則只能「猜不到 →
  不命中」,YOLO 下 `git push --force` 會被當成未分類操作自動放行);(b) HTTP 轉發 subagent 子 session 的權限請求(否則全 ask 後
  subagent 會永遠等一個沒人回的權限);(c) `opencode-acp` 停用 `task`(subagent)工具——`opencode acp` 不會轉發子 session 的
  權限請求,實測 subagent 卡死;(d) 三個唯讀查詢工具預先放行(語意等同 Claude SDK 的 `allowedTools`)。
- **已知邊界**:`agent.<name>.permission`(使用者自己在 opencode 設定檔針對某個 agent 寫的)是 opencode 在全域 `permission`
  **之後**才疊的,這裡管不到;另外 ACP 對接下,MCP 工具的 `permission-request.input` 只有 opencode 在請求當下給的
  (實測是 `{}`,真參數稍後才到),政策引擎對它們只能依工具名判斷。

**2. OpenCode(HTTP)也掛 session 網路工具(推翻 §H「不做」清單的一項)。** 同一個 `mcp-bridge-server` 子行程、同一套
scoped token(`mintMcpBridgeLaunch()`,核發/撤銷沿用 ACP 那條),寫進 opencode 設定的 `mcp.deskmony`;token 只放
`environment`、不放 `command`,呼叫者身分仍由 token 綁定。`create_session` / `send_to_session` 因為上一項自然走權限流程。
`softwareCanUseTools("opencode")` 改為 true;provider 目錄的 OpenCode 兩項差別只剩對接方式(HTTP + SSE / ACP)。

**3. Deskmony 啟動的 opencode 本機伺服器一律加 basic auth(上面兩項的前提)。** `opencode serve`(HTTP)與 `opencode acp`
(實測 1.18.7,看行程樹的 LISTEN port)**都會**在 loopback 開 HTTP 伺服器,而且預設**沒有任何認證**;最常見的第一個伺服器還
固定落在 opencode 的預設 port 4096(`--port 0` 是「先試 4096、被占用才隨機」,不是純隨機)。本機任何程序就能:
`POST /permission/{id}/reply` 替 opencode 核准權限請求——直接繞過第 1 項費力接上的政策引擎與使用者本人;`GET /config` 讀到第 2
項才放進設定裡的 scoped bridge token(只能呼叫 session 網路的五個 gateway 方法,但仍是能冒充該 session 傳訊息、開 session 的憑證);
對 session 送 prompt、讀對話。所以每次 spawn 都產生一組新的隨機密碼(32 bytes、base64url),以 `OPENCODE_SERVER_PASSWORD` /
`OPENCODE_SERVER_USERNAME` **環境變數**(不放 command args)交給子行程;`OpenCodeAdapter` 對該伺服器的每個請求(含 SSE `/event`)
都帶 `Authorization: Basic`,`opencode acp` 那條路 Deskmony 不打它的 HTTP API,只設密碼讓別人進不去。密碼只在 adapter 記憶體,
不寫 log、不寫 DB、不進任何事件;使用者自己設的同名環境變數一律**被覆蓋**(不沿用長效秘密)。實作與實測見
`packages/adapters/src/opencode-server-auth.ts` 檔頭。

- **使用者可見的改變**:Deskmony 內部的對話、權限、提問流程完全不變;唯一的差別是從外部(別的程序、手動 `curl`)不帶密碼連不進
  Deskmony 啟動的 opencode 伺服器了——那正是要擋的事,密碼只有 Deskmony 知道。
- **已知邊界**:(a) 密碼在 opencode 行程的環境變數裡,而 opencode **不會**把它從 bash 工具的環境濾掉(實測模型跑 bash 讀得到),所以這道鎖
  擋的是 **agent 以外**的本機程序,擋不住 agent 自己;要連 agent 一起擋得在 opencode 端清掉那個變數——**2026-10-05 已用 opencode 的
  `shell.env` 外掛 hook 補上,見 §J**。(b) 不認這個環境變數的舊版 opencode 不會鎖;`OpenCodeAdapter.spawn()` 就緒後會不帶認證探測一次,仍回 2xx 就
  `console.warn`,但**不拒絕啟動**(拒絕會讓舊版使用者整個 OpenCode 功能壞掉)。

## J. 2026-10-05 修訂:agent 子行程的環境不得含 Deskmony 憑證

> 稽核補的洞,不限 OpenCode(master 同樣有)。§C 的規則本身一條都沒改——補的是「**agent 自己就能拆掉整個安全罩**」的洞:
> 安全罩罩得住「agent 想做什麼」,但罩不到「agent 跑在什麼環境裡」。

**1. 主認證 token 不再傳進任何 agent 的環境。** 桌面殼(`apps/desktop/electron/main.ts`)啟動 core 之前**一律**把
`DESKMONY_AUTH_TOKEN` 設好(使用者沒設定時也會產生一組 session-only 的),所以真實 app 裡的 core 帶著**主 token**。四個 adapter 原本都用
`{ ...process.env, ...launch.env, ...config.env }` 組 agent 子行程的環境(Claude SDK 那條在沒有 provider env 時乾脆省略 `env`,讓 SDK
繼承整份 `process.env`)——於是**任何 agent 的 bash 都讀得到 `DESKMONY_AUTH_TOKEN`**。拿著它連上 gateway(`ws://127.0.0.1:<port>`)就等於使用者本人:
核准自己的權限請求、把自己切成 YOLO 與「真.無限制」(§G)、新增政策 allowlist。現在四個 adapter(`AcpAdapter`、`OpenCodeAdapter`、`GenericPtyAdapter`、
`ClaudeAgentSdkAdapter`)一律經 `packages/adapters/src/agent-env.ts` 的 `buildAgentChildEnv()` 組環境:從 `process.env` 出發、疊上 provider / launch /
config 各層,**最後一步無條件刪除 denylist**:

| 刪掉的變數 | 為什麼 |
|---|---|
| `DESKMONY_AUTH_TOKEN` | 主認證 token。沒有任何正當理由讓 agent 拿到,所以連使用者自己在 provider 環境變數裡填了它也照樣刪(denylist 排在所有 layer 之後) |
| `DESKMONY_MCP_BRIDGE_*`(token / gateway 位址 / session id / 開關) | bridge 子行程需要的值是**另外明確交給它的**(ACP:`session/new` 的 `mcpServers[].env`;OpenCode HTTP:`mcp.deskmony.environment`;Claude SDK:in-process,沒有子行程),不是靠 agent 環境繼承;agent 環境裡有的話,它的 bash 就能冒充該 session 傳訊息、開 session |
| `OPENCODE_SERVER_PASSWORD` / `OPENCODE_SERVER_USERNAME`(**從父行程繼承來的**) | OpenCode 的兩個 adapter 在 denylist 之後才自己設一組新的隨機密碼(opencode 行程本身需要它,§I-3);其他 agent 完全不該拿到別人的 opencode 伺服器密碼 |

- **使用者可見的改變**:agent 在 bash 裡看到的環境少了這幾個變數;session 網路工具(`list_sessions` 等)照常可用。唯一會感覺到的:若有人刻意讓 agent 在 bash 裡用
  `deskmony` CLI 連回 gateway(`DESKMONY_AUTH_TOKEN` 環境變數是 CLI 的預設 token 來源),現在得自己明確帶 `--token`——那等於使用者明確把主 token 交給 agent,
  不再是「沒注意到就被繼承」。

比對**不分大小寫**(Windows 的環境變數名稱不分大小寫,`{ ...process.env }` 展開出來的一般物件卻保留原本的大小寫)。`ClaudeAgentSdkAdapter` 現在**一律明確傳**
sanitized env(SDK 的 `env` 選項整個取代子行程環境,所以從 `process.env` 出發才保留 PATH 等)。連 agent 偵測(`agent-detector.ts`)對使用者機器上的
agent 執行檔跑 `--version` / `models` 時也不再帶著 core 的憑證。

**2. OpenCode 的伺服器密碼與設定內容,連它自己的 bash 工具都看不到(補 §I-3 的已知邊界 (a))。** opencode 不會把
`OPENCODE_SERVER_PASSWORD` 與含 bridge scoped token 的 `OPENCODE_CONFIG_CONTENT`(HTTP 版)從它啟動的 bash 工具環境濾掉(2026-10-03 實測)——YOLO 下的 agent
能拿密碼 `curl` 自家伺服器的 `POST /permission/{id}/reply` 自我核准,而 hard-deny 的「非白名單外連」只看工具 input 裡結構化的 host/url 欄位,不解析 bash 指令字串。
所以 Deskmony 自帶一個 opencode 外掛(`packages/adapters/src/opencode-shell-env-plugin.ts`,編譯到 `dist/`、打包後同樣在 `core-bundle` 裡),在 opencode 的
`shell.env` hook 把 `OPENCODE_SERVER_PASSWORD` / `OPENCODE_SERVER_USERNAME` / `OPENCODE_CONFIG_CONTENT`(縱深防禦:再加 `DESKMONY_AUTH_TOKEN`、`DESKMONY_MCP_BRIDGE_*`)
從 shell 環境移除,經注入的 `OPENCODE_CONFIG_CONTENT` 的 `plugin` 陣列載入(`opencode` 與 `opencode-acp` 兩種都掛;附加在使用者自己的 `plugin` 之後)。

- **實測依據(opencode 1.18.7,不是讀文件猜的)**:hook 名稱 `shell.env`,簽名 `(input: {cwd, sessionID?, callID?}, output: {env})`,opencode 在每次啟動 shell 前呼叫,子 shell 環境是
  `{ ...process.env, ...output.env }`;**把值設成 `undefined` 就真的移除**(agent 的 `process.env.X !== undefined` 是 false,不是空字串)。外掛可用 `file://` URL 載入
  (含空白與中文的路徑,`pathToFileURL()` 百分比編碼),`plugin` 陣列與使用者全域/專案設定的**串接**(我們附加在最後,hook 依序執行,不會被蓋回去);`[spec, options]`
  元組的選項會傳給工廠函式。**opencode 會把外掛模組的每個函式匯出都當外掛工廠呼叫**(實測多匯出的 helper 被呼叫了),所以外掛檔只匯出一個函式。
- **外掛載入失敗不影響 session**:找不到外掛檔、或 opencode 沒載入它(不認 `shell.env` 的舊版、載入時丟例外),adapter 只 `console.warn`、session 照常啟動。偵測靠外掛
  載入時寫的「載入標記檔」(adapter 在 session 建立之後背景輪詢,最多 10 秒)。沒載入的這種情況下,agent 的 bash 環境仍拿得到密碼——與這個外掛出現之前相同。
- **使用者可見的改變**:無。agent 在 bash 裡看到的環境少了這幾個變數;`opencode` 的伺服器密碼、MCP bridge 的運作、對話與權限流程完全不變。

**3. hard-deny 的「讀秘密路徑」多涵蓋桌面殼自己的本機資料夾。** 桌面殼把遠端存取 token 用 Electron `safeStorage`(Windows DPAPI)加密存在 `<userData>/auth-token.enc`
(`apps/desktop/electron/main.ts`)。core 不知道 Electron 的真實 userData 路徑,所以依平台慣例推算(appData 基底:Windows `%APPDATA%`、macOS `~/Library/Application Support`、
Linux `$XDG_CONFIG_HOME`/`~/.config`),整個目錄樹納入秘密路徑:`Deskmony`(打包後,electron-builder 的 `productName`)與 `@deskmony`(開發模式,app 名稱是 `@deskmony/desktop`;
2026-10-05 對這台機器的真實目錄結構核對過)。跟 `~/.deskmony` 一樣只看工具 input 裡結構化的路徑欄位。

**驗證**:`scripts/e2e-agent-env.mjs`(core 以設了 `DESKMONY_AUTH_TOKEN` 的環境啟動;fake ACP / OpenCode / PTY 後端只回報「環境裡有沒有這個變數」、絕不回顯值;另有攔截
`ClaudeAgentSdkAdapter` 實際 spawn 的探針——本機沒登入 Claude,所以涵蓋範圍是「adapter 傳給 claude 子行程的環境」)、`e2e-opencode-permissions.mjs` PM18–PM21
(fake 後端內建外掛宿主模擬,規則照上面的實測)、`e2e-hard-deny.mjs` 2d;另用真實 opencode 1.18.7 + `opencode/big-pickle`、帶著隨機 `DESKMONY_AUTH_TOKEN` 的隔離 core,
對 `opencode` 與 `opencode-acp` 各建一個 YOLO session 實測:agent 的 bash 看不到 `DESKMONY_AUTH_TOKEN` / `DESKMONY_MCP_BRIDGE_*` / `OPENCODE_SERVER_PASSWORD` /
`OPENCODE_SERVER_USERNAME` / `OPENCODE_CONFIG_CONTENT`,而 session 照常回覆、`list_sessions` 照常可用。

**仍然擋不住的(誠實記錄,屬沙箱 / 作業系統隔離的範疇,不是環境變數層級能解的)**:

- 同一個作業系統使用者底下的程序,能讀其他程序的記憶體——例如 agent 在 bash 裡用 PowerShell / P-Invoke 讀 core 或 opencode 行程的環境區塊(PEB),環境變數濾得再乾淨也一樣。
- 同一個作業系統使用者的程序能解密 DPAPI 保護的本機檔案(Electron `safeStorage` 的 `auth-token.enc`)。hard-deny 的路徑規則只擋「工具 input 裡結構化的路徑」,
  agent 在 bash 指令字串裡 `cat` 它看不到(§C7 的誠實限制)。
- 要真正擋住這些,需要讓 agent 跑在不同的 OS 使用者 / 容器 / 沙箱裡——目前沒有,PTY 那條路同樣沒有(§C7)。這次補的是「agent 不需要任何特殊技巧、一行 `echo $VAR`
  就拿到主 token」這個最便宜的路徑。
