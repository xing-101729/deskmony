# Deskmony 功能總覽

> **文件定位**:這份文件回答「Deskmony 現在能做什麼」——依**使用者能力**分類,不是
> 依程式碼模組分類(那是 [`ARCHITECTURE.md`](./ARCHITECTURE.md) 的職責)。每一項
> 功能都已落地並有對應的 e2e 測試,不包含規劃中或設計中的東西——那些見
> [`ARCHITECTURE.md` §15「已知缺口」](./ARCHITECTURE.md#15-已知缺口誠實列出)。
>
> 內容截至 **2026-08-25**,2026-10-02 起移除 team / 任務 / 看板(見
> [`DECISIONS.md` §H](./DECISIONS.md))。與 [`DECISIONS.md`](./DECISIONS.md)(為什麼這樣設計)、
> [`ARCHITECTURE.md`](./ARCHITECTURE.md)(程式碼目前長什麼樣)互補,三份文件
> 衝突時以 `DECISIONS.md` 為準。

---

## 一句話

Deskmony 是一個桌面控制室,讓 AI coding agent(不是單一聊天視窗)在
**無人值守**的情況下跑數小時而不失控——靠的是彼此獨立、遠端也動不了的
安全斷路器(權限、成本;訊息斷路器待重建),不是靠「相信 agent 不會亂來」。

---

## 1. Session 子 agent(原「多 Agent 團隊協作」)

> ⚠️ **2026-10-02 移除(見 [`DECISIONS.md` §H](./DECISIONS.md))**:角色制團隊
> (team / team member / lifecycle)、刪除團隊、`team-bus` 傳訊(`send_message` /
> `broadcast` / `report_status` / `request_review` / `list_teammates`)、團隊群聊、
> 投遞策略與 Mailbox、任務看板——整套已經拿掉。session 之間互相傳訊的新設計
> (P3)還沒實作,所以現在 agent 之間**沒有**橫向傳訊通道。

- **Session 子 agent**:任一 session 可透過 `subagent` MCP server 呼叫
  `spawn_subagent`/`send_to_subagent`,把工作委派給子 session 並收集結果
  (完成後自動把結果當 prompt 注回父 session)。**刻意不自動放行**——會多跑
  一輪的操作一律走權限升級,不因為是「開子 agent」就特例。
- 目前只有 `claude-agent-sdk` 與經 ACP 的 agent(Codex、Gemini CLI、走
  `opencode acp` 的 OpenCode,透過 scoped MCP-bridge token)能**主動**呼叫開子
  agent 工具;走 HTTP 的 OpenCode、PTY 尚未掛載——但**接收端跨後端都通**,
  注入 prompt 對任何 session 都有效。

## 2. 多後端 Adapter,一套介面

| Provider | 對接方式 | 能力層級 |
|---|---|---|
| Claude Code(內嵌 SDK) | Claude Agent SDK,程式內嵌 | 最深——hooks、子 agent、細粒度權限事件、對話中即時切換 model/effort |
| Claude Code CLI | PTY 原始直通 | 相容層,無權限事件 |
| Codex | ACP(經 `@agentclientprotocol/codex-acp` 橋接套件) | 結構化事件 |
| Gemini CLI | ACP | 結構化事件 |
| OpenCode | HTTP + SSE(原生 server) | 結構化事件,可遠端 |
| Aider / 任意互動式 CLI | PTY | 相容層,無權限事件 |

- **能力探測誠實分級**:每個 adapter 回報 streaming / 工具事件 / 權限請求 /
  diff / interrupt / 終端機這些布林能力,外加 usage 回報、context 回報、
  slash command 支援這三項用 `supported`/`unsupported`/`unknown` 三態
  ——因為同一個 ACP adapter,底下換一個 agent 就可能完全不回報 usage,
  靜態布林等於對 UI 說謊。
- **PTY 是相容保底,不是自主層**:raw stdin 直通,結構上無法被政策引擎管
  ——在真正的執行沙箱做出來之前,PTY agent 一律唯讀,不給無人值守的自主權。
  刻意不做 shell 指令攔截(`bash -c`/`$()`/base64 幾秒就能繞過)。

## 3. 無人值守安全罩——三個獨立斷路器

這是整個專案的核心賣點:三條線各自獨立,任一條都能單獨叫停失控(其中訊息斷路器
目前待 P3 重建,見 3.2)。

### 3.1 權限斷路器

- **Default-deny 政策引擎**:每次工具呼叫都走同一套固定優先序判斷,判斷不
  出來一律升級給人,絕不自動放行。
- **四類硬性禁止(hard-deny),config 永遠關不掉**:worktree 外寫入/刪除、讀
  秘密路徑(`~/.ssh`、`~/.aws`、`.env*`、`id_rsa*`、`credentials`)、危險
  git(force-push、砍遠端分支、`branch -D`)、對非白名單主機的網路連線。
- **每 session 的 Auto / YOLO 開關**:Auto 只把「未分類中間地帶」變自動放行;
  YOLO 額外跳過 config 裡的 deny 規則。**兩者都絕不跳過 hard-deny**。YOLO
  30 分鐘後自動失效。
- **允許清單學習 + 手動管理**:對話中點「永遠允許」會寫最窄的規則(單一指令
  或路徑前綴),同時寫進設定檔與記憶體,重啟前後行為一致。**Settings 內建
  「權限」分頁**(2026-08-25 新增)能直接瀏覽/新增/刪除整份允許清單,不必等
  規則自然浮現在對話裡。
- **「真.無限制」層**(2026-08-25 新增):疊在 YOLO 之上、需要額外打字確認的
  更高層級開關——開啟後連四類 hard-deny 都會被繞過。前提是該 session 已經
  處於 YOLO,啟用當下會強制跳出風險說明對話框(要求輸入確認字串)+ 桌面
  通知 + 稽核記錄。這是**唯一**能繞過 hard-deny 的路徑,而且是逐 session、
  需要人明確二次確認才能開,不是任何規則比對能自動觸發的。
- **遠端能力**(2026-08-25 更新):遠端連線現在能觀察、送 prompt、逐一核可/
  拒絕權限升級、**切換 session 的 Auto/YOLO 模式、編輯允許清單、開啟真.
  無限制層**——與本機同權。遠端仍然**不能**:建立/刪除 agent profile、改
  daemon 綁定介面、改預算上限。這是連線本身(是否為 loopback)由 Core 判定,
  絕不採信 client 自稱;即使是繞過 UI 直接送 raw request,伺服器端一樣會擋。

### 3.2 訊息斷路器 — 已於 2026-10-02 移除(P3 重建)

原本的每 context 訊息數預算(context id 由 Core 推導、超額熔斷)隨 `MessageBus` 一併移除,
見 [`DECISIONS.md` §H](./DECISIONS.md)(A5 改寫)。`messageBudget` 設定鍵保留,P3 的
「每條訊息鏈」預算沿用它;在那之前 agent 之間沒有橫向傳訊通道,因此沒有可失控的
訊息迴圈。

### 3.3 成本斷路器

| 元件 | 依據 | 觸發條件 | halt 範圍 |
|---|---|---|---|
| TurnLimiter | 工具呼叫次數 + 時間,**不需要 usage 資料** | 單回合 30 分鐘或 200 次工具呼叫 | 立即中斷該回合 |
| CostGovernor(每日 kill-switch) | usage 事件 | 當日總花費超標 | 全部 session 中斷 |
| WaitingWatchdog T1 | 掛起時長 | 超過 6 小時 | 只通知,不 halt |
| WaitingWatchdog T2 | 掛起時長 | 超過 72 小時 | 回收子行程資源;對話紀錄保留 |

TurnLimiter 是最後一道防線——實測某些後端(例如 Claude Code 經 ACP)完全不
回報 usage,依賴 usage 的預算對這類後端完全不生效,回合硬上限是唯一還有效
的保護。

## 4. 任務協作與 Git Worktree 隔離 — 已於 2026-10-02 移除

任務看板、任務級 git worktree 隔離、機器驗收閘、人類 review 閘、人類批准合併、
合併衝突自動 abort、ephemeral 成員自動 spawn——**整套已移除**,見
[`DECISIONS.md` §H](./DECISIONS.md)。使用者資料庫裡既有的 `tasks` / `workspaces`
等表沒有被刪除,只是不再有程式碼讀寫。

## 5. 崩潰復原

- 立場很直白:agent 累積的推理與 context 活在後端行程裡,不在資料庫——崩潰
  復原的本質是「對帳 + 人工分流」,不是重放事件流。
- Core 每次啟動,在接受任何連線之前先做對帳:上次沒乾淨關閉的 session 一律
  標記 `interrupted`。
- 復原視圖提供三種動作,**全部要人主動點,沒有任何背景自動觸發**:
  - **繼續**(保有記憶重啟,僅限真正支援磁碟持久化 session 的後端)
  - **接手**(讀摘要重啟,一律可用)
  - **放棄**(session 標記關閉,對話紀錄原封不動保留)
- (2026-10-02 移除:原本的「重跑」與髒 worktree 強制前置流程是任務 worktree
  專用,見 [`DECISIONS.md` §H](./DECISIONS.md)。)

## 6. 遠端存取

- 從瀏覽器或手機連進同一個 core 的 WebSocket gateway,不需要另外安裝任何
  東西——headless 模式下,同一個 port 同時服務靜態頁面與 WebSocket。
- **不自己做 TLS**:預設只綁 loopback;要遠端就強制走 Tailscale/WireGuard/
  SSH 這類隧道處理加密與網路層認證。綁定非 loopback 位址若沒設定
  `DESKMONY_AUTH_TOKEN` 會直接拒絕啟動。
- Token 認證用常數時間比對,認證失敗有次數 + 冷卻限制;token 刻意不是設定檔
  欄位,`~/.deskmony/config.json` 改了也不可能意外把它洩漏或改掉——只能來自
  `DESKMONY_AUTH_TOKEN` 環境變數,或(桌面殼專屬)Settings 的「遠端存取」
  區塊用 Electron `safeStorage` 加密保存在本機的值,兩者都不落入設定檔。
- 遠端能力邊界見上方「3.1 權限斷路器」——這是 2026-08-25 這輪唯一被有意識
  放寬的部分,其餘(成本斷路器,以及 profile 管理/綁定介面/預算
  上限)遠端一律仍然動不了。

## 7. 桌面 IDE 體驗

- **對話視圖**:串流 markdown、行內 diff(自製 `DiffHunkView`,非 Monaco)、
  程式碼語法高亮、todo 清單追蹤、工具產生的圖片輸出。
- **內嵌終端機**(xterm.js + node-pty):給 PTY 後端用,支援即時尺寸同步、
  逐鍵輸入透傳。
- **互動式提問**:agent 能跳出結構化問題(claude-agent-sdk 的 `AskUserQuestion`、
  OpenCode 的 `question` 工具),由使用者在對話框內選答案,或自行輸入答案。
- **檔案附件**:除了圖片,也支援 PDF、純文字檔與任意檔案的貼上/附加。
- **Slash command**:輸入 `/` 叫出後端原生支援的指令清單(claude-agent-sdk、
  ACP、OpenCode 三種來源都支援,清單即時更新)。
- **Command Palette**(`Ctrl+K`):快速搜尋與執行指令。
- 對話中可即時切換 model 與 effort(思考程度)——依後端能力優雅降級,不支援
  的後端會得到明確錯誤而不是靜默失敗。

## 8. 設定系統

- **分層設定合併**:預設值 → `<DESKMONY_HOME>/config.json` → 環境變數,
  UI 上每個欄位都標示目前生效值的來源,來源是環境變數的欄位會鎖成唯讀。
- **Provider 目錄管理**:偵測本機已裝的 agent 軟體與版本、啟用/停用個別
  provider、排序、勾選要開放的 model、設定環境變數(對外一律遮罩顯示)。
- **「權限」分頁**(2026-08-25 新增):瀏覽目前生效的允許清單、逐條新增
  (工具 + 條件 + 效果 + 可選 scope)、逐條刪除——本機與遠端皆可用,即時透過
  推播同步給其他已連線的 client。
- **通知設定**:唯讀顯示目前的桌面通知/webhook 設定(webhook URL 視同憑證,
  一律遮罩,不提供任何寫入路徑,只能手動編輯設定檔)。
- **「遠端存取」token 管理**(桌面殼專屬,2026-09 新增):顯示目前 token
  (可複製給要連線的瀏覽器/手機)、自訂一組固定值、或重新產生一組隨機值——
  用 Electron `safeStorage` 加密保存在本機,重啟 Deskmony 後沿用;來源是
  `DESKMONY_AUTH_TOKEN` 環境變數時鎖定唯讀。變更只影響下次啟動套用的值。
- 寫入設定檔不做熱重載,需要重啟 core 才生效,UI 會明確提示。

## 9. 通知

- **桌面系統通知 + webhook** 兩條獨立通道,各自判斷要不要送。
- 升級(escalation)類事件會批次彙總(第一筆立即送,之後在時間窗內合併成
  一則);熔斷(trip)類事件必送、不節流、不受靜音時段限制。
- 支援靜音時段(24 小時制,可跨午夜)。
- webhook 內容刻意最小化——只帶元資料(session 名稱、工具名、筆數、事件
  種類),絕不夾帶指令字串、檔案路徑、檔案內容或 agent 輸出全文。

## 10. 國際化

四語言完整支援(English、繁體中文、日本語、Español),涵蓋介面文字、錯誤
訊息、通知內容。產品專有詞(YOLO、AUTO、UNRESTRICTED 等徽章文字、
worktree、session、profile 等技術詞)依詞彙表刻意保留原文,不強行本土化。

## 11. 稽核與資料持久化

- SQLite(better-sqlite3 + Drizzle ORM),6 張表(2026-10-02 起 team / 任務相關
  五張表的程式碼定義已移除,但既有資料庫裡的表與資料原封不動留著),冪等遷移
  (`CREATE TABLE IF NOT EXISTS` + 逐欄位 `ensure` 函式,不需要版本化 migration 系統)。
- `enforcement_audit` 是系統裡唯一 append-only 的表:只記權限決策(含自動
  放行)、三斷路器熔斷、啟動對帳、真.無限制切換、允許清單變更——供事後
  稽核與除錯,**不是** event sourcing,不記 agent 輸出,不能拿來重建狀態。

---

## 尚未做的事(誠實列出)

- **PTY 沒有執行沙箱**——這類後端因此結構上無法自主運作,一律唯讀。
- **沒有 mid-turn 成本熔斷**——目前唯一會回報 usage 的後端都是在回合結束時
  才發送一次。
- **OpenCode(HTTP)、PTY 尚未掛載子 agent 的 MCP 工具**(接收端不受影響)。
- **Provider 環境變數本機明文儲存**——對外一律遮罩,但本機 SQLite 檔案本身
  不加密(與多數同類工具的既有取捨一致)。
- **只有 Windows 打包**——core 與 adapter 本身是純 Node/TypeScript,其餘平台
  主要是打包工程,不是程式碼問題。

完整清單與細節見 [`ARCHITECTURE.md` §15](./ARCHITECTURE.md#15-已知缺口誠實列出)。
