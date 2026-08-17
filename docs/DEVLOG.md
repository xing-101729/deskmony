# Deskmony 開發日誌(Dev Log)

> 這份文件是逐輪(M1–M11、S 系列)累積的工程實作紀錄與完成度存證,原本是專案根目錄的
> `README.md`,搬到這裡是為了讓根目錄能放一份給新讀者/GitHub 訪客看的簡介型 README。
> 專案簡介、快速開始、功能總覽請見根目錄 [`README.md`](../README.md);
> 權威設計基準見 [`DECISIONS.md`](./DECISIONS.md);系統架構見 [`ARCHITECTURE.md`](./ARCHITECTURE.md)。
> 以下內容維持原樣,未來仍會繼續在這份檔案累積每輪的完成度記錄。

---

# Deskmony

Agent Team 管理平台 —— **M5 Round B(遠端化,路線圖最後一輪:瀏覽器/行動
裝置 client + 安全強化)** 完成後,ARCHITECTURE.md 第 9 節路線圖 M1~M5 **全部
完成**。之後追加數個小版本:**M5 Round C**(對話管理 UI 補完:刪除對話、
對話中切換 model)、**M5 Round D**(「設定」介面:偵測本機已裝的 agent
軟體與可用 model)、**M5 Round E**(「建立 Agent Profile」對話框改用偵測
結果驅動的 software 選單 + 原生「選擇資料夾」+ 建 profile 時選 model、
「設定」介面新增「啟用哪些偵測到的 model」持久化偏好)。完整架構設計請見
[`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)。

## 目錄結構

```
Deskmony/
├─ apps/
│  ├─ desktop/     # Electron + React + Zustand + Tailwind 桌面殼(含 xterm.js 終端視圖、
│  │                 團隊管理對話框、團隊群聊視圖(M3 Round B）、任務看板(M4 Round B）;
│  │                 M5 Round B 起同一份程式碼也能在純瀏覽器分頁下運作(見下方
│  │                 「瀏覽器存取方式與安全界線」),新增 lib/connection-config.ts
│  │                 (sessionStorage 連線資訊)、views/ConnectScreen.tsx(連線畫面);
│  │                 M5 Round D 新增 views/SettingsDialog.tsx(「設定」彈窗:agent 偵測);
│  │                 M5 Round E:ProfileCreateDialog.tsx 改用偵測結果驅動的 software 選單 +
│  │                 「瀏覽…」選資料夾按鈕 + model 下拉,SettingsDialog.tsx 新增「啟用模型」
│  │                 勾選區塊,electron/{main.ts,preload.cts} 新增 `deskmony:pickDirectory` IPC
│  └─ core/        # headless orchestration server
│     ├─ gateway/       # WebSocket Gateway(request/response + 事件推播;M5 Round B
│     │                   新增 timingSafeEqual token 比對 + 認證失敗 rate limiting）
│     ├─ http/           # M5 Round B 新增:靜態網頁 server(static-server.ts,把
│     │                    apps/desktop 的 Vite build 產物與 WS Gateway 共用同一個 port）
│     ├─ detect/         # M5 Round D 新增:AgentDetector(agent-detector.ts,固定
│     │                    allowlist + execFile + 逾時的本機 agent CLI 偵測)
│     ├─ settings/       # M5 Round E 新增:SettingsStore(settings-store.ts,key/value 偏好,
│     │                    目前存「啟用哪些偵測到的 Claude model」)
│     ├─ session/       # SessionManager(session 生命週期 + 狀態機）
│     ├─ permissions/   # PermissionGateway
│     ├─ team/          # TeamManager(M3 Round A:team/team member CRUD）
│     ├─ bus/           # MessageBus(M3 Round A:訊息路由 + Mailbox + 投遞策略;M4 Round B 新增
│     │                   request_review）
│     ├─ tasks/          # TaskService(M4 Round A:任務 CRUD + 狀態機 + report_status 整合;
│     │                    M4 Round B 新增 mergeAndComplete/人類批准合併把關）
│     └─ workspace/      # WorkspaceManager(M4 Round A:git worktree 建立/清理;M4 Round B 新增
│                          真正的 git merge + hadUncommittedChanges 旗標）
├─ packages/
│  ├─ shared/      # zod 型別與事件 schema(AgentProfile / Session / AgentEvent / AdapterCapabilities /
│  │                 Team / TeamMember / TeamMessage / TeamBusPort / Task / Workspace / Gateway 協議;
│  │                 M5 Round D 新增 detect.ts:AgentDetectionEntry / DetectedModel;
│  │                 M5 Round E 新增 agent-target.ts:deriveDefaultAgentTarget/canUseAcpAdvanced/
│  │                 deriveAcpAdvancedTarget(偵測項 → 可建立 (software,command) 的純函式)、
│  │                 gateway.ts 新增 settings.getEnabledModels/settings.setEnabledModels）
│  ├─ adapters/    # AgentAdapter 介面 + AdapterRegistry + ClaudeAgentSdkAdapter + AcpAdapter +
│  │                 GenericPtyAdapter + team-bus-mcp.ts(team-bus MCP 工具薄層,M3 Round A;
│  │                 M4 Round B 新增 request_review 工具）
│  └─ db/          # Drizzle schema(sessions / messages / agent_profiles / teams / team_members /
│                    team_messages / tasks / workspaces / settings）+ SQLite client
│                    (M5 Round E 新增 settings 表:key/value 持久化偏好）
├─ scripts/
│  ├─ e2e-gateway.mjs      # 端到端冒煙測試(見下方「端到端冒煙測試」)
│  ├─ fake-acp-agent.mjs   # 給 e2e 用的最小 ACP agent,不依賴外部模型(M3 Round A 新增 DELAY_ECHO 標記)
│  └─ fake-pty-echo.mjs    # 給 e2e 用的最小互動式 CLI,GenericPtyAdapter 決定性測試用
└─ docs/
   └─ ARCHITECTURE.md
```

## 安裝步驟

需求:Node.js >= 20、pnpm(建議 10.x)。

```bash
pnpm install
```

首次安裝時,`better-sqlite3` / `electron` / `esbuild` / `node-pty` 需要執行原生
build script,已透過根目錄 `package.json` 的 `pnpm.onlyBuiltDependencies` 設定
自動核准,不需手動 `pnpm approve-builds`。`node-pty` 的安裝注意事項見下方
「GenericPtyAdapter:pty profile 設定與 node-pty 安裝注意事項」章節。

Claude Agent SDK(`@anthropic-ai/claude-agent-sdk`)在執行期需要能存取
Claude Code 的登入憑證/API Key(與本機安裝的 Claude Code 共用登入狀態,或設定
`ANTHROPIC_API_KEY` 環境變數),否則建立 session 後送出訊息會收到認證錯誤事件。

## 啟動方式(dev)

### 方式一:分別啟動 core 與 desktop(建議,方便看兩邊的 log)

```bash
# terminal 1:啟動 headless core(WebSocket Gateway,預設監聽 4317)
pnpm dev:core

# terminal 2:啟動 Vite dev server(桌面前端)
pnpm dev:desktop

# terminal 3:啟動 Electron(會自動連線到已在跑的 Vite dev server)
pnpm dev:electron
```

### 方式二:單獨跑 Electron(由 Electron main process 自動 spawn core)

```bash
pnpm build          # 先把所有 workspace 套件 build 一次(core 需要 dist/index.js)
pnpm dev:electron    # Electron 啟動時會自動 spawn apps/core/dist/index.js 作為 child process
```

> `apps/desktop/electron/main.ts` 的 `startCore()` 會先嘗試找系統安裝的
> Node.js(`where node.exe` / `which node`),找得到就直接用系統 Node 跑
> `apps/core/dist/index.js`;只有在系統完全找不到 Node 時才會退回用
> `ELECTRON_RUN_AS_NODE=1` 借用 Electron 內建的 Node 執行檔(並在 console
> 印出 ABI 不相容風險的警告)。原因見下方「已知限制」的 ABI 說明。因此
> `pnpm dev:electron` 這條路徑在 dev 階段**需要本機另外裝好 Node.js 並在
> PATH 中可被找到**。

### 環境變數

| 變數 | 說明 | 預設值 |
|---|---|---|
| `DESKMONY_CORE_PORT` | Gateway WebSocket port | `4317` |
| `DESKMONY_WORKSPACE` | 預設 AgentProfile 的工作目錄 | 使用者家目錄 |
| `DESKMONY_DATA_DIR` | SQLite 資料庫存放目錄 | `~/.deskmony` |
| `DESKMONY_PERMISSION_TIMEOUT_MS` | `PermissionGateway` 等待人類回覆權限請求的逾時毫秒數,逾時後自動視為 deny | `300000`(5 分鐘,沿用 `PermissionGateway` 建構子預設值) |
| `DESKMONY_BIND_HOST`(M5 Round A) | Gateway WebSocket server(M5 Round B 起也是 HTTP 靜態網頁 server)綁定的位址 | `127.0.0.1`(僅本機,見下方「綁定位址安全預設」) |
| `DESKMONY_AUTH_TOKEN`(M5 Round A) | 設定時,所有 WS 連線都必須先通過認證才能發送其他 request | 未設定(免認證,本機開發預設,見下方「認證(token-based)」) |
| `DESKMONY_STATIC_DIR`(M5 Round B) | 覆寫瀏覽器靜態網頁的來源目錄 | 依 monorepo 佈局自動推算 `apps/desktop/dist`(見下方「瀏覽器存取方式與安全界線」) |
| `DESKMONY_AUTH_RATE_LIMIT_MAX`(M5 Round B) | 同一來源 IP 連續認證失敗達幾次後進入冷卻期 | `5` |
| `DESKMONY_AUTH_RATE_LIMIT_COOLDOWN_MS`(M5 Round B) | 上述冷卻期長度(毫秒) | `30000`(30 秒,見下方「安全強化」) |
| `DESKMONY_HOME`(M6 Round A) | core 的「家目錄」——設定檔(`config.json`)存放位置 | `~/.deskmony`(見下方「全域設定」) |

> **舊資料目錄遷移**:專案更名前的版本資料存放在 `~/.nexusdesk`(內含
> `nexusdesk.db`)。更名後預設改讀 `~/.deskmony`(`deskmony.db`)。若要沿用
> 舊資料,手動把 `~/.nexusdesk` 目錄改名為 `~/.deskmony`(或設定
> `DESKMONY_DATA_DIR` 指向舊目錄)即可,舊目錄不會被自動刪除或搬移。

## 全域設定(分層合併的設定檔,M6 Round A)

這輪把上面「環境變數」表格裡的 core 設定,改成「分層合併的設定檔」——設計
移植自 [Paseo](https://github.com/) 的全域設定(`~/.paseo/config.json`,合併順序
`defaults → config.json → 環境變數 → CLI flags`)。Deskmony 沒有 CLI flags,合併
順序是:

```
defaults  →  <DESKMONY_HOME>/config.json  →  環境變數(DESKMONY_*)
(最低優先權)                                      (最高優先權,永遠贏)
```

**為什麼環境變數還是最高優先權**(不是照抄 Paseo 把 CLI flags 放最高):
Deskmony 目前完全靠環境變數運作部署與測試——`scripts/e2e-gateway.mjs` 的每一個
決定性測試、`apps/desktop/electron/main.ts` 啟動 core 子程序的方式,全部是透過
設定環境變數(`DESKMONY_CORE_PORT`/`DESKMONY_DATA_DIR`/`DESKMONY_AUTH_TOKEN`
……)。若改成設定檔優先權更高,任何人機器上留著一份舊的 `config.json` 就會讓
這些既有機制悄悄失效,是嚴重的相容性風險。因此這輪的決定是:**設定檔補上
「沒有 CLI/環境變數時的持久化預設值」這個空缺,但環境變數的權威地位完全不變**。

### 家目錄與設定檔位置

- `DESKMONY_HOME` 環境變數覆寫家目錄,預設 `~/.deskmony`。
- 設定檔路徑固定是 `<DESKMONY_HOME>/config.json`。
- 這個家目錄與 `DESKMONY_DATA_DIR`(SQLite 檔案位置)是**兩個獨立的概念**——
  預設剛好都是 `~/.deskmony`(與 Paseo 的 `~/.paseo` 同時存放設定檔與其他狀態
  一致),但各自可以被獨立的環境變數覆寫而分開,不假設兩者永遠相同。
- **沒有設定檔時,行為必須與現在完全相同**——這是這輪的相容性底線,見下方
  e2e 步驟28a。

### 設定區塊(對應目前真實存在的設定,沒有無中生有的功能開關)

| 區塊 | 欄位 | 對應環境變數 | 說明 |
|---|---|---|---|
| `daemon` | `port` | `DESKMONY_CORE_PORT` | Gateway 監聽的 port |
| `daemon` | `bindHost` | `DESKMONY_BIND_HOST` | 綁定位址(見下方「綁定安全檢查」) |
| `daemon` | `permissionTimeoutMs` | `DESKMONY_PERMISSION_TIMEOUT_MS` | `PermissionGateway` 逾時毫秒數 |
| `daemon` | `authRateLimit.max`/`authRateLimit.cooldownMs` | `DESKMONY_AUTH_RATE_LIMIT_MAX`/`DESKMONY_AUTH_RATE_LIMIT_COOLDOWN_MS` | 認證失敗 rate limiting |
| `workspace` | `defaultWorkingDir` | `DESKMONY_WORKSPACE` | 預設 AgentProfile 的工作目錄 |
| `workspace` | `worktreesRoot` | (無)只能透過設定檔/`config.setFile` | 任務 worktree 的固定根目錄;省略時維持 `WorkspaceManager` 既有的動態算法(每個 team 的 baseDir 旁邊各自的 `.deskmony-worktrees`) |
| `data` | `dataDir` | `DESKMONY_DATA_DIR` | SQLite 資料庫存放目錄 |
| `features` | `staticDir` | `DESKMONY_STATIC_DIR` | 瀏覽器 UI 靜態檔案目錄 |
| `log` | `level` | (無)只能透過設定檔/`config.setFile` | `"info"`/`"warn"`/`"error"`,只過濾 core 既有的 `console.log`/`console.warn` 輸出(`console.error` 永遠保留),不引入檔案輪替等新基礎設施 |
| (頂層) | `version` | — | 固定 `1`(數字或字串皆可) |
| (頂層) | `$schema` | — | 可選,見下方「JSON schema」 |

### 為何刻意不把 token 放進設定檔

Paseo 在 `daemon.auth.password` 存 **bcrypt 雜湊**;Deskmony 的認證是共享
bearer token,用 `timingSafeEqual` 做常數時間字串比對(見上方「認證
(token-based)」章節)——存雜湊會改變比對模型本身(雜湊沒辦法拿去做逐位元組
的常數時間字串比對),不是這輪要做的事。因此:

- **`DESKMONY_AUTH_TOKEN` 維持環境變數專屬**,這份設定檔完全沒有任何 token
  欄位。
- 桌面版每次啟動在記憶體產生臨時 token(見上方「桌面殼串接」)這個既有設計
  是刻意的:不把長期憑證落地成檔案,重開 app 就是換一把新鑰匙,沒有「token
  檔案被誰讀走」這個額外的攻擊面。
- 若設定檔出現疑似 token 的欄位(例如 `daemon.authToken`,或任何名稱含
  `token`/`secret`/`password`/`apikey` 的欄位),`apps/core/src/config/
  load-config.ts` 的 `scanUnknownKeys()` 會把它當「未知欄位」處理、忽略、
  並印出比一般未知欄位更明確的警告——這個值**絕不會**成為有效的認證 token
  (見 e2e 步驟28g:用設定檔裡的假 token 嘗試認證會被拒絕,只有真正的環境
  變數 token 才能通過)。

### 綁定安全檢查套用在「合併後」的設定上

`validateBindSafety()`(見 `apps/core/src/index.ts`)這輪改看**合併後**的
`config.daemon.bindHost`,不再只看環境變數——如果只看環境變數,使用者透過
設定檔把 `daemon.bindHost` 改成 `0.0.0.0` 卻沒有(來自環境變數的)
`DESKMONY_AUTH_TOKEN`,core 會在毫無認證的情況下對外曝露,而舊版的檢查完全
看不到這個情況。這是防止「使用者改設定檔就意外把無認證的 core 曝露到區網」
的關鍵防線,見 e2e 步驟28f。

### gateway/UI 的來源標記

`config.getEffective`(gateway 方法)回傳合併後的有效設定,**每個欄位都
附帶來源標記**(`"default"`/`"file"`/`"env"`)——分層合併最有價值的可觀察性:
使用者才知道「我改了設定檔卻沒生效,是因為被環境變數蓋掉」。回傳內容不含
任何 token(見 e2e 步驟28h,比照既有 provider env 遮罩的斷言方式對整個 JSON
字串做檢查)。

桌面殼的「設定」對話框(`SettingsDialog.tsx`)新增「全域設定」區塊,顯示每個
欄位的有效值 + 來源徽章;**來源是 `env` 的欄位一律鎖定為唯讀**(改設定檔不會
生效,環境變數永遠贏),並顯示鎖定原因。

### `config.setFile`:只允許安全子集,且不做熱重載

只允許覆寫:`workspace.*`、`features.staticDir`、`log.level`、
`daemon.permissionTimeoutMs`、`daemon.authRateLimit.*`。**刻意不允許**經
gateway 修改 `daemon.port`/`daemon.bindHost`——這兩個欄位決定 core 的網路
曝露面,若任何已連上 gateway 的 client(不需要本機檔案系統存取權限)都能
把它們改掉,等同讓遠端 client 有能力調整 core 的曝露面,必須留給本機手動
編輯設定檔(協議層面就不接受這兩個欄位,`ClientRequestSchema.parse()` 直接
拒絕,見 e2e 步驟28i-1/28i-2)。

設定檔不存在時,`config.setFile` 會自動建立它(含 `version`/`$schema`)。
寫入後**不做熱重載**(過度設計)——回應只回報「哪些欄位被寫入、需要重啟
core 才會生效」,SettingsDialog 顯示對應提示。

### JSON schema

`docs/deskmony.config.v1.json` 由 `packages/shared/src/core-config.ts` 的
`CoreConfigSchema` 透過 `zod-to-json-schema` 產生(對應 Paseo 發佈
`paseo.config.v1.json` 供編輯器自動補全的做法):

```bash
pnpm build                    # 先 build 一次(需要 packages/shared/dist)
pnpm generate:config-schema    # 產生/更新 docs/deskmony.config.v1.json
```

在 `<DESKMONY_HOME>/config.json` 頂端加一行 `$schema` 即可讓支援 JSON Schema
的編輯器(例如 VS Code)提供自動補全與型別檢查:

```json
{
  "$schema": "./deskmony.config.v1.json",
  "version": 1,
  "log": { "level": "warn" }
}
```

`$schema` 是相對路徑,實際要解析到需要把產生的
`docs/deskmony.config.v1.json` 複製到 `<DESKMONY_HOME>/` 底下(與
`config.json` 同一層),或在編輯器的設定裡手動把 `<DESKMONY_HOME>/config.json`
對應到這份 repo 裡的 schema 檔案路徑(例如 VS Code 的 `json.schemas` 設定)。
這個腳本不參與 `pnpm build`/`pnpm typecheck`/e2e 驗收流程,是手動的文件產出
步驟——改了 `core-config.ts` 之後記得重新執行並 commit 產出的 JSON。

## Core 獨立部署(headless,M5 Round A)

ARCHITECTURE.md 第 10 節設計決策 1「Core 與殼分離:Orchestration Core 是
headless server,桌面殼只是 client」從 M1 就是既有的架構事實(`apps/core`
從第一輪就不依賴 Electron 執行期,只是過去只有 `pnpm dev:core`/`node
dist/index.js` 這種「順手能跑」的用法,沒有正式收斂成一個對外承諾的部署方式)。
這輪把它正式化:

```bash
pnpm build           # 先 build 一次(core 需要 dist/index.js)
pnpm start:core       # 等同 pnpm --filter @deskmony/core run start → node dist/index.js
```

所有設定都能經環境變數注入(見上方「環境變數」表格):埠
(`DESKMONY_CORE_PORT`)、資料目錄(`DESKMONY_DATA_DIR`)、預設 workspace
(`DESKMONY_WORKSPACE`)、權限逾時(`DESKMONY_PERMISSION_TIMEOUT_MS`)、以及
這輪新增的綁定位址(`DESKMONY_BIND_HOST`)與認證 token
(`DESKMONY_AUTH_TOKEN`)。`apps/core` 完全不 import 任何 `apps/desktop`/
`electron` 相關套件(`pnpm -r run build` 的相依順序也印證了這一點:
`shared -> adapters/db -> core/desktop` 是平行分支,不是 `core` 依賴
`desktop`),`node scripts/e2e-gateway.mjs` 全程直接對 `apps/core/dist/index.js`
這個獨立 process 打 WebSocket RPC,從未透過 Electron —— 這是「Core 可以完全
脫離 Electron 獨立跑」這句話一直以來的實際驗證方式,這輪只是多了
`pnpm start:core` 這個正式入口與下面兩節的安全預設。

### 綁定位址安全預設

`WebSocketServer` 過去只帶 `port`(未指定 host 時 Node 的 `ws`/底層 `net`
預設行為等同監聽所有網卡,等同 `0.0.0.0`)。這輪改為**預設只綁
`127.0.0.1`**(僅本機可連,不對外曝露),要對外(例如區網內其他裝置、或
之後的瀏覽器/手機 client)存取,必須明確設定 `DESKMONY_BIND_HOST`(例如
`DESKMONY_BIND_HOST=0.0.0.0`)。

**警告:對外綁定務必同時設定 `DESKMONY_AUTH_TOKEN`,否則任何人連上這個位址
都能操控 agent(送出任意 prompt、核准任意權限請求)與檔案系統(worktree/git
操作、寫檔工具)。** 這不是建議,是強制的安全預設 ——
`apps/core/src/index.ts` 的 `validateBindSafety()` 在偵測到**合併後**的
`daemon.bindHost`(M6 Round A 起,見上方「全域設定」——不只看
`DESKMONY_BIND_HOST` 環境變數,設定檔把 `daemon.bindHost` 改成對外位址一樣
會觸發這個檢查)不是 `127.0.0.1`/`localhost`/`::1` 這三個公認本機位址之一、
且沒有設定 `DESKMONY_AUTH_TOKEN` 時,會在啟動流程一開始就直接
`console.error` + `process.exit(1)` 拒絕啟動(e2e 步驟17c 驗證環境變數路徑、
步驟28f 驗證設定檔路徑,兩者都是子程序以結束碼 1 結束、stderr 含明確錯誤
訊息)。

啟動時 `apps/core` 會印出目前的綁定位址與是否啟用認證的摘要(**不含 token
本身**):

```
[core] 綁定位址: ws://127.0.0.1:4317(僅本機)
[core] 認證: 未啟用(免認證)
[core] 警告:未設定 DESKMONY_AUTH_TOKEN,目前允許任何連上這個 WS 位址的 client 免認證發送 request。僅建議本機開發使用;若這個位址對外可及,請務必設定 DESKMONY_AUTH_TOKEN。
```

## 認證(token-based,M5 Round A)

設定 `DESKMONY_AUTH_TOKEN` 環境變數後,所有 WS 連線都必須先通過認證才能發送
除了 `auth` 以外的任何 request。

**傳輸方式的取捨**:token 的傳遞方式有三種常見選項——(1) client 連上後把
`auth` 當作可處理的第一則訊息送出(帶 token)、(2) 走 WS 交握階段的
`Sec-WebSocket-Protocol` header、(3) 放進連線 URL 的 query string。這輪選擇
**方案 (1)**:
- **不選 query string(方案3)**:URL(含 query string)非常容易被意外寫進
  各種 log——反向代理/negateway 的 access log、瀏覽器網路面板、`ws` 函式庫
  本身若有除錯輸出、甚至使用者不小心把網址列內容分享出去——token 進了 URL
  等於進了一個難以控制外洩範圍的地方,這是任務描述明確提醒要避免的風險。
- **不選 Sec-WebSocket-Protocol(方案2)**:雖然不會出現在 URL,但這個
  header 的語意是「client 提議一組子協議、server 從中選一個」,把 token
  塞進這個欄位是語意上的濫用(token 不是協議名稱),而且瀏覽器原生
  `WebSocket` API 對這個 header 的操作相對受限(某些環境下无法自由設定任意
  字串,只能從建構子的 `protocols` 參數傳入,彈性不如應用層訊息),跨
  client 實作(未來的瀏覽器/手機 client)一致性也較差。
- **方案 (1) 的取捨**:好處是完全在應用層(WS 訊息本身)處理,不涉及任何
  傳輸層/HTTP header 的特殊處理,瀏覽器原生 `WebSocket`、`ws` 函式庫、未來
  任何語言的 client 都能用完全一致的方式實作(送一個 JSON 訊息);代價是
  連線建立後有一個「已連線但未認證」的中間狀態,必須明確處理逾時與訊息閘門
  (見下方)。這輪判斷這個代價可控(只是多一個 per-connection 的 boolean
  flag + 一個逾時計時器),换來的實作一致性與避免 log 外洩的好處更重要。

**認證流程**(`apps/core/src/gateway/ws-gateway.ts` 的 `WsGateway`):
- client 連上後,若 core 有設定 token,連線預設「未認證」。除了 `auth`
  以外的任何 request 在通過認證前都會被拒絕(回應 `ok:false` 明確錯誤,
  連線本身不會因此被關閉,允許 client 補送正確的 `auth` 請求)。
- `auth` 請求帶正確 token → 標記為已認證,之後所有 request 正常處理。
- `auth` 請求帶錯誤 token → 回應明確錯誤後**主動關閉連線**(WS close code
  `1008`)。
- 連線後 5 秒(`AUTH_TIMEOUT_MS`)內未通過認證(不論是完全沒送訊息、還是
  送了但一直是錯的 token 且還沒觸發上面的立即關閉)→ 主動關閉連線。
- **不把 token 寫進任何 log**:認證失敗的錯誤訊息只說「token 不正確」,
  不回顯收到的值;`console.log`/`console.error` 全文搜尋過,沒有任何一行
  會印出 `authToken`/收到的 `params.token`。
- 認證檢查與 flag 設定寫在訊息處理函式最前面、且**完全同步、不含任何
  `await`**——這是刻意的順序,確保「認證訊息」與「緊接著送出的下一個
  request」就算幾乎同時抵達(同一個事件迴圈 tick 內被處理),也不會有
  「認證還沒處理完,下一個請求就先通過檢查」的競爭窗口(完整理由見
  `ws-gateway.ts` 類別頂端與 `handleMessage()` 內的註解)。
- 推播(`broadcast`,例如 agent 輸出、團隊訊息)只送給已認證的連線 ——
  未認證的連線在通過認證前不會收到任何可能含敏感內容的事件。

**未設定 token 時的行為**:維持免認證(向下相容本機開發),但啟動時印出
警告(見上方「綁定位址安全預設」的範例輸出)。若同時設定了對外綁定位址卻
沒有 token,啟動時會被 `validateBindSafety()` 直接拒絕(見上一節)——這是
唯一「無認證」不被允許的情況,其餘本機開發情境維持零設定即可用。

**桌面殼串接**(`apps/desktop/electron/main.ts`、`electron/preload.cts`、
`apps/desktop/src/lib/gateway-client.ts`):
- `main.ts` 在 app 啟動時用 `crypto.randomUUID()` 產生一個 token,設進
  `process.env.DESKMONY_AUTH_TOKEN`(每次啟動都重新產生、不落地成檔案 ——
  桌面殼場景下 core 子程序與桌面殼視窗生命週期一致,不需要跨重啟保留同一個
  token;現生成的隨機值也不需要額外處理「token 存哪裡、誰能讀」這個新的
  攻擊面)。同一份 `process.env` 之後被 `startCore()` 的 `env` 物件(展開
  `...process.env`)自動帶給 core 子程序,`preload.cts` 也讀同一份
  `process.env.DESKMONY_AUTH_TOKEN`(preload 腳本繼承 main process 環境變數
  的機制與既有 `DESKMONY_CORE_PORT` 相同)透過 `contextBridge` 曝露給
  renderer 的 `window.deskmony.authToken`。
- `GatewayClient`(`apps/desktop/src/lib/gateway-client.ts`)建構子新增可選
  的 `authToken` 參數;WS 連線一開啟(`open` 事件)就自動送出 `auth`
  request,成功後才把連線狀態切成 `"open"` 回報給外部訂閱者(認證失敗則
  主動關閉連線並印出錯誤,不切成 `"open"`)——這個自動認證流程對既有 UI
  完全透明,`session-store.ts`/`team-store.ts`/`task-store.ts` 都不需要
  任何改動,原有的「等 status 變成 open 才開始呼叫」的既有慣例自然涵蓋了
  認證這一步。
- 桌面殼是本機 process(core 子程序只監聽 `127.0.0.1`,`DESKMONY_BIND_HOST`
  沒有被 `main.ts` 覆寫),token 純粹是縱深防禦(即使本機被其他使用者/
  process 意外連上 core 的 port,也需要知道這個隨機 token 才能操控),不是
  因為桌面殼場景本身需要對外曝露。

## 瀏覽器/行動裝置 client(M5 Round B)

M5 Round A 把「瀏覽器/手機 client」留給之後的 round(只確保 Gateway 協議與
安全預設就緒);M5 Round B 補上實際的瀏覽器存取路徑——`apps/core` 現在同時
是 WS Gateway server 與 UI 靜態網頁 server,`apps/desktop` 的 React app 同一份
程式碼在 Electron renderer 與純瀏覽器分頁下都能運作。

### 瀏覽器存取方式與安全界線

- **同一個 port 服務兩件事**:`apps/core/src/gateway/ws-gateway.ts` 的
  `WsGateway.listen()` 改成先建立一個 `node:http` 的 `Server`,把
  `WebSocketServer` 用 `{ server }` 選項掛在它上面——`ws` 套件會自動監聽這個
  http server 的 `upgrade` 事件處理 WS 交握,一般 HTTP GET 請求則交給
  `apps/core/src/http/static-server.ts` 匯出的 `createStaticRequestHandler()`。
  兩者天生走 Node 的不同事件(`upgrade` vs `request`),不需要手動判斷是
  WS 升級請求還是一般 HTTP 請求。
- **服務內容**:`static-server.ts` 把 `apps/desktop` 既有的 Vite build 產物
  (`apps/desktop/dist/`,可用 `DESKMONY_STATIC_DIR` 覆寫)服務出去——`GET /`
  回傳 `index.html`;已知副檔名(`.html`/`.js`/`.css`/`.json`/圖片/字型等,見
  該檔案內 `STATIC_CONTENT_TYPES` 白名單)且實際存在的檔案原樣回傳;其餘任何
  路徑(包含前端內部路由、例如使用者重新整理某個 SPA 子路徑)一律回傳
  `index.html`(SPA fallback)。
- **安全界線(務必記住這條分界)**:靜態頁面本身**不需要認證即可下載**——
  它只是不含任何機敏資料的前端 UI 殼(HTML/JS/CSS)。但頁面透過瀏覽器原生
  `WebSocket` 連上 WS Gateway 之後,若 core 有設定 `DESKMONY_AUTH_TOKEN`,
  **仍然必須送出正確 token**(走上面「認證(token-based)」章節描述的同一套
  `auth` request 流程)才能呼叫除 `auth` 以外的任何方法、才能收到任何事件
  推播。這條界線在程式碼層面刻意分開:`static-server.ts` 完全不 import、不
  檢查 `DESKMONY_AUTH_TOKEN`,職責只有「這個路徑對應到哪個檔案、能不能
  讀」;真正的存取控制只存在於 `ws-gateway.ts` 的認證閘門。
- **目錄穿越三層防禦**(`resolveStaticFile()`,完整設計理由見
  `apps/core/src/http/static-server.ts` 檔案頂端註解):
  1. 拒絕反斜線(`\`)與 NUL 位元組——避免 Windows 上 `path.resolve()` 把
     反斜線當路徑分隔符,繞過下一步的正規化。
  2. 把 decode 後的路徑當作以 `/` 開頭的**虛擬絕對路徑**丟給
     `path.posix.normalize()`——多餘的 `..`(例如 `/../../package.json`)
     在絕對路徑下無法跑到虛擬根目錄之上,會被正規化收斂掉(等同
     `/package.json`,對應到 `distDir` 底下一個通常不存在的同名檔案,不是
     真的讀到專案根目錄的 `package.json`)。
  3. 最終防線:不論前兩層邏輯是否有沒設想到的漏洞,解析出的絕對路徑都必須
     真的落在 `distDir` 之內(以 `distDir + path.sep` 開頭),否則直接拒絕
     (HTTP 400),不會嘗試讀取。
  三層防禦已用 e2e 步驟18a-3 驗證三種變體(原始 `..`、URL 編碼
  `%2e%2e`、反斜線混合)皆不洩漏專案檔案內容(見下方「端到端冒煙測試」)。
- **只服務白名單副檔名**;不在白名單內的路徑一律走 SPA fallback,**完全不
  觸碰檔案系統裡對應那個路徑的任何檔案**——因此就算正規化/前綴檢查邏輯
  被繞過,「未知副檔名」這條分支本身就不構成任何洩漏管道。
- 啟動時 `apps/core` 會印出瀏覽器可用的 HTTP 位址(例如
  `[core] 瀏覽器 UI: http://127.0.0.1:4317/`),以及靜態檔案目錄若不存在時的
  警告(通常代表忘了先 `pnpm build`)。

**打包後(Electron 安裝版)也能正確提供這個靜態頁面**:`apps/core` 對
`DESKMONY_STATIC_DIR` 的預設推算路徑(`__dirname/../../desktop/dist`)只在
monorepo 佈局下成立,打包產物的 `resources/` 佈局並不符合這個假設。
`apps/desktop/package.json` 的 `build.extraResources` 因此額外把 Vite build
產物(`apps/desktop/dist`)複製到 `resources/desktop-ui`(與放 core 依賴的
`resources/core` 分開,語意上是兩種不同的資源),`electron/main.ts` 的
`startCore()` 在 `app.isPackaged` 時明確設定
`env.DESKMONY_STATIC_DIR = path.join(process.resourcesPath, "desktop-ui")`
傳給 core 子程序——用的是 core 既有的環境變數覆寫機制,不需要改動
`apps/core/src/index.ts` 本身的推算邏輯(dev 模式的預設推算路徑不受影響)。
`scripts/package-smoke.mjs` 除了既有的 WS auth 驗證,也對打包後的 exe 做一次
真的 `GET /` HTTP 請求,斷言拿到的是真正的 `index.html` 而非 404 fallback,
作為這個修復的迴歸防護(見下方「Electron 打包/發版」)。這個缺口過去只影響
「把打包後的 core 當成可被瀏覽器/手機連線的伺服器」這個情境(例如設定
`DESKMONY_BIND_HOST` 對外綁定,讓區網內其他裝置用瀏覽器連進來)——不影響
Electron 桌面殼本身,`createWindow()` 是用 `loadFile()` 直接從應用自己的
asar 載入 UI,完全不經過 core 的 HTTP static server。

### 連線畫面與響應式(`apps/desktop`)

- **Electron vs 瀏覽器的判斷**:`apps/desktop/src/App.tsx` 用
  `Boolean(window.deskmony)` 判斷目前是 Electron renderer(preload 透過
  `contextBridge` 提供 `window.deskmony`)還是純瀏覽器分頁。Electron 場景下
  行為完全不變(mount 時自動連線);瀏覽器場景下不自動連線,先顯示
  `views/ConnectScreen.tsx` 讓使用者輸入伺服器位址(預設同源
  `ws://<location.host>`,見 `lib/connection-config.ts` 的
  `defaultGatewayUrl()`——這正好對應「瀏覽器就是從 Core 的 HTTP server 載入
  這個頁面,WS Gateway 監聽同一個 host:port」這個典型部署情境)與 token。
- **探測連線**(`lib/gateway-client.ts` 的 `probeGatewayConnection()`):使用者
  送出表單後,先開一個獨立、用完即丟的 WebSocket 送一次 `auth` request 驗證,
  依結果分兩種明確錯誤——`GatewayAuthError`(連得上但 token 不正確,顯示
  「認證失敗」)與 `GatewayNetworkError`(連不上/逾時/連線中途被關閉,顯示
  「連線失敗」+ 詳細原因)。驗證成功才呼叫長駐的 `GatewayClient`(原本 M3
  Round B 就存在、`team-store`/`task-store` 共用的那個 singleton)的新方法
  `configure(url, token)` 設定真正的連線目標,再呼叫既有的 `connect()`。
- **登出**:主介面頂部(僅瀏覽器場景顯示)提供「登出」按鈕,清除
  sessionStorage 後整頁重新整理——比逐一手動重置 session/team/task 三個
  zustand store 簡單可靠(這三個 store 目前都沒有提供 `reset()`)。
- **響應式**(既有 Tailwind `sm:` 斷點,沒有引入新 UI 框架):
  - 側欄(`SessionList`)在窄螢幕(< `sm`,640px,涵蓋約 375px 的手機寬度)
    改用 `fixed` overlay 呈現、預設收合,頂部新增漢堡按鈕(`☰`)切換,點擊
    背景遮罩或選取 session 後自動收合;`sm:` 以上維持原本常駐側欄,行為
    完全不變。
  - 頂部列(連線狀態、Session/團隊群聊/任務看板三分頁切換、登出按鈕)改用
    `flex-wrap`,窄螢幕下自動換行,不會溢出裁切。
  - 任務看板(`TaskBoardView`)的欄位容器本來就有 `overflow-x-auto`(M4
    Round B 就存在),窄螢幕下可直接橫向捲動查看六個欄位,這輪不需要額外
    改動。
  - 終端視圖(`TerminalView`)容器由 `overflow-hidden` 改成 `overflow-auto`
    ——xterm 的 fit addon 會依容器寬度調整欄數,但既有輸出若比新的窄容器寬,
    允許捲動至少「不破版」(任務描述的字面要求)。
  - 根容器由 `h-screen`(固定 `100vh`)改用 `index.css` 新增的 `.app-shell`
    class(`100dvh`,`@supports` 判斷,不支援時退回 `100vh`)——行動裝置
    (尤其 iOS Safari)彈出虛擬鍵盤時 `100vh` 不會跟著可視區域縮小,會讓
    底部的聊天輸入框被鍵盤蓋住、也捲不到,`100dvh` 會隨鍵盤彈出/收起即時
    調整。

### token 儲存取捨

瀏覽器連線用的 token 存在 **`sessionStorage`**(`lib/connection-config.ts`),
刻意不用 `localStorage`,也絕不放進 URL query string 或寫進任何
`console.log`:

- `sessionStorage` 綁定「分頁」的生命週期,關閉分頁就自動清除——`localStorage`
  沒有到期機制,token 會一直留在瀏覽器裡直到使用者手動清除瀏覽器資料。在
  **共用電腦**上,若用 `localStorage`,前一個使用者的 token 會一直有效,下
  一個使用這台電腦的人只要打開同一個網址就能直接操控 agent 與檔案系統,是
  明顯的風險;`sessionStorage` 大幅縮小這個暴露視窗。
- URL query string 容易被瀏覽器歷史紀錄、反向代理 access log、螢幕分享時的
  網址列意外外洩——這是「認證(token-based)」章節從 M5 Round A 就對 WS
  傳輸層做過的同一個判斷,這裡對瀏覽器連線畫面的表單提交同樣適用(表單提交
  後只存進 sessionStorage,不會出現在任何 URL 或網址列)。
- **共用電腦使用注意事項**:使用完畢後務必按主介面的「登出」或直接關閉分頁
  ——只闔上瀏覽器視窗但分頁仍在背景存活(例如瀏覽器的「還原分頁」功能)不
  保證會清除 `sessionStorage`。這是任務描述明確要求記錄的取捨,不是可以
  忽略的細節。
- 代價:同分頁重新整理需要重新連線(`ConnectScreen` 會自動嘗試用
  sessionStorage 裡的上次連線資訊重連一次,失敗才需要使用者手動重新輸入);
  換分頁/換裝置一律要重新輸入 token。這輪判斷這個代價相對於「共用電腦上
  token 一直有效」的風險是合理的取捨。

## 安全強化(M5 Round A review 提出,M5 Round B 落地)

### token 常數時間比較(timingSafeEqual)

`ws-gateway.ts` 的 token 比對從 `===` 改用
`crypto.timingSafeEqual()`(`timingSafeTokenEqual()`):

- `timingSafeEqual()` 要求兩個 buffer 長度相同,否則直接丟例外——因此**先比
  長度**,長度不同時直接短路回傳 `false`,不呼叫 `timingSafeEqual()`。
- **這個簡化是刻意接受的**:先比長度確實會讓「兩個字串長度是否相同」透過
  時間側channel被觀察到(長度不同時提早 return,耗時明顯短於長度相同時進入
  常數時間比較),但 token 的**長度**本身不是需要保密的資訊(不像逐字元
  內容那樣,可以被用來一個字元一個字元地猜出正確 token)。真正需要防禦時序
  側寫攻擊的是「內容比對」這一步——只要長度相同時的比較走常數時間,就不會
  洩漏「猜的 token 前幾個字元是否正確」這種可被利用來逐步縮小猜測範圍的
  資訊。
- e2e 步驟18c 驗證三種情況(不同長度錯誤 token、同長度錯誤 token、正確
  token)都不丟例外、行為正確(正確拒絕/正確放行)。

### 認證失敗 rate limiting

`ws-gateway.ts` 新增 `AuthRateLimiter` 類別:同一來源 IP(從 WS 升級請求的
`IncomingMessage.socket.remoteAddress` 取得,IPv4-mapped IPv6 表示法如
`::ffff:127.0.0.1` 會正規化成純 IPv4 字串)連續認證失敗達門檻
(`DESKMONY_AUTH_RATE_LIMIT_MAX`,預設 5 次)後,在冷卻期內
(`DESKMONY_AUTH_RATE_LIMIT_COOLDOWN_MS`,預設 30 秒)直接拒絕該 IP 之後的
認證嘗試(不論這次帶的 token 是否正確——`isBlocked()` 檢查發生在
`timingSafeTokenEqual()` 比對之前)。

- **資料結構**:純記憶體 `Map<來源IP, {failCount, blockedUntil,
  lastAttemptAt}>`,不落地——這是連線層級的節流,不是需要跨重啟保留的業務
  資料。
- **「連續」的語意**:任何一次認證成功都會把該 IP 的紀錄整筆刪除,失敗計數
  重新從 0 開始——中間夾一次成功就不算連續,符合任務描述的字面意思。
- **避免無限增長**:不額外起 `setInterval` 做週期性清理(對頻繁在 e2e 測試
  中反覆建立/銷毀的 core 子程序更省心,不會有計時器忘記清除、導致 process
  無法自然結束的風險)。改用 lazy sweep:每次查詢/記錄時,先清掉「距離上次
  嘗試已超過冷卻期 4 倍時間」的舊項目,Map 大小只受「這個時間窗內出現過的
  相異來源 IP 數」上限,不會無限增長。
- 冷卻期/門檻可用環境變數縮短(比照 `DESKMONY_PERMISSION_TIMEOUT_MS` 的既有
  慣例),e2e 步驟18d 用這個機制在數秒內驗證完整流程(連續失敗達門檻 → 冷卻
  期內連正確 token 也被拒 → 冷卻期過後恢復正常)。

## Adapter 層:AdapterRegistry 與 ACP profile 設定

`apps/core` 啟動時會建立一個 `AdapterRegistry`(`packages/adapters/src/registry.ts`),
以 `AgentProfile.software` 為 key 註冊三個 adapter 實例(M2 Round B 新增
`GenericPtyAdapter`):

```ts
const adapters = new AdapterRegistry()
  .register("claude-agent-sdk", new ClaudeAgentSdkAdapter())
  .register("acp", new AcpAdapter())
  .register("pty", new GenericPtyAdapter());
```

`SessionManager.createSession()` 依 `profile.software` 從 registry 選出對應的
adapter 來 `spawn()`,並把該 adapter 實例記在這個 session 的 runtime state
裡 —— 同一個 session 之後所有的 `sendPrompt`/`interrupt`/`resolvePermission`/
`dispose` 都固定用這個 adapter,不同 session 可以綁定不同 software。

### 建立一個 software="acp" 的 AgentProfile

`AcpAdapter`(`packages/adapters/src/acp-adapter.ts`)是 [Agent Client
Protocol](https://agentclientprotocol.com) 的 **client** 端實作,用官方
`@agentclientprotocol/sdk`(`npm` 上已改名為 `@agentclientprotocol/sdk`,舊名
`@zed-industries/agent-client-protocol` 已 deprecated)對接。它會依
`AgentProfile.acpConfig` 啟動一個子程序,透過 stdio 建立 ACP JSON-RPC 連線:

```jsonc
// 呼叫 gateway 的 profile.create(或直接在程式碼種一個 AgentProfile)
{
  "name": "My ACP Agent",
  "software": "acp",
  "workingDir": "/path/to/project",
  "acpConfig": {
    "command": "claude-code-acp",      // 支援 ACP 的 agent CLI(PATH 上的名稱或絕對路徑)
    "args": ["--some-flag"],           // 選填
    "env": { "SOME_TOKEN": "..." }     // 選填,會與 process.env 合併
  }
}
```

`software="acp"` 時 `acpConfig.command` 為必填(zod 在
`packages/shared/src/agent-profile.ts` 的 `AgentProfileSchema` /
`CreateAgentProfileInputSchema` 上用 `superRefine` 強制要求,缺少會在
`profile.create` 直接被拒絕)。

### Windows spawn 規則(`resolveWindowsSpawnCommand`,M2 Round B 修復)

`AcpAdapter.spawn()` 內部的 `resolveWindowsSpawnCommand()` 依 `command` 的副檔名
決定 spawn 方式:

| 副檔名 | spawn 方式 |
|---|---|
| `.cmd` / `.bat`(例如某些用 npm 全域安裝的 CLI,像 `gemini.cmd`) | `shell: true`,command 與每個 arg 都會先用 `quoteWindowsShellArg()` 視需要加上雙引號 |
| `.ps1` | 改成呼叫 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File <script> <args...>`(`shell: false`,由 Node 自動處理每個 arg 的跳脫) |
| `.exe`,或無副檔名且為絕對路徑 | `shell: false`,原樣傳入 |
| 其他(副檔名不明的 PATH 相對名稱) | `shell: true` + quoting,交給 `cmd.exe` 依 `PATHEXT` 規則解析 |

**修復的 bug**:M2 Round A 版本的判斷式是
`path.isAbsolute(command) || /\.(exe|cmd|bat|ps1)$/i.test(command)` → `useShell:
false`,這個 `||` 會讓 `.cmd`/`.bat`(不論絕對或相對路徑)被錯誤分類到
`useShell: false` 分支;較新版本的 Node.js(修補 CVE-2024-27980 之後)對不帶
`shell: true` 的 `.cmd`/`.bat` spawn 會直接丟出 `EINVAL`,Windows 上任何用
npm 全域安裝、以 `.cmd` shim 呈現的 agent CLI(例如 `gemini.cmd`)必定踩中。
已用暫存 `.cmd` wrapper 重現此 bug 並驗證修復(見 e2e 步驟 11)。

### fake ACP agent(不依賴外部 CLI 的決定性測試)

`scripts/fake-acp-agent.mjs` 用 `@agentclientprotocol/sdk` 的 **agent** 端
建構器 API(`acp.agent()`)實作一個最小、行為完全確定性的 ACP agent,不呼叫
任何真實模型,讓 `AcpAdapter` 的事件轉換與權限請求路徑可以脫離「真實模型
行為是否穩定」被反覆驗證:

- 一般 prompt:固定回覆 `"Hello from fake ACP agent"`,拆成多段
  `agent_message_chunk` 串流送出,驗證 `AcpAdapter` 把 ACP 的
  `session/update` 通知正確轉成既有的 `message-delta` 事件(分組/`done`)。
- 若 prompt 文字以 `ACP_WRITE_FILE `(注意結尾空格)開頭,後面接一段 JSON
  `{"path": "...", "content": "..."}`:agent 會先送出一個 `tool_call`,再呼叫
  `session/request_permission` 要求授權 —— 選允許就實際寫入檔案並送出
  `tool_call_update(status: "completed")`,選拒絕就不寫檔、不送
  `tool_call_update`,直接結束該輪。

這支腳本本身可以被 `node scripts/fake-acp-agent.mjs` 直接執行(透過 stdio
提供 ACP 連線,例如手動拿其他 ACP client 對接測試),也可以被
`scripts/e2e-gateway.mjs` 用 `import` 取用其匯出的
`FAKE_ACP_REPLY_CHUNKS`/`WRITE_FILE_PREFIX` 常數(維持 prompt 文字與 agent
實際判斷邏輯同一個 source of truth);兩種用法互不干擾 —— 只有在
`process.argv[1]` 指向這支檔案本身時才會啟動 stdio 連線。

## GenericPtyAdapter:pty profile 設定與 node-pty 安裝注意事項(M2 Round B)

`GenericPtyAdapter`(`packages/adapters/src/pty-adapter.ts`)是 ARCHITECTURE.md
3.4 節「保底方案,無結構化事件,功能降級」的終端直通 adapter,用
[`node-pty`](https://github.com/microsoft/node-pty) 對任意互動式 CLI 開一個
偽終端(Windows 走 ConPTY,POSIX 走真正的 pty),不解析輸出內容,純粹把原始
輸出轉成 `terminal-data` AgentEvent 直通給 UI。

### 建立一個 software="pty" 的 AgentProfile

```jsonc
// 呼叫 gateway 的 profile.create(或直接在程式碼種一個 AgentProfile)
{
  "name": "My PTY Agent",
  "software": "pty",
  "workingDir": "/path/to/project",
  "ptyConfig": {
    "command": "bash",          // 或 Windows 上的 "cmd.exe" 等任意互動式 CLI
    "args": ["-l"],             // 選填
    "env": { "SOME_TOKEN": "..." }, // 選填,會與 process.env 合併
    "cols": 100,                 // 選填,預設 80
    "rows": 30                   // 選填,預設 24
  }
}
```

`software="pty"` 時 `ptyConfig.command` 為必填(比照 `acpConfig` 用
`superRefine` 校驗)。`cols`/`rows` 只能在 spawn 當下決定,`AgentAdapter` 介面
尚未有 `resize()`,見 `pty-adapter.ts` 的已知限制。

### `terminal-data` 事件的編碼選擇

`packages/shared/src/events.ts` 的 `TerminalDataEventSchema` 用 **UTF-8 字串**,
不是 base64:`node-pty` 的 `onData()` 本身就已經把底層位元組流解碼成字串,
ANSI escape sequence 也是合法 UTF-8 文字;xterm.js 的 `write()` 直接吃字串。
base64 只會多一層編解碼成本、讓高頻小片段輸出的 payload 平白增加約 33% 大小,
沒有額外好處。

### SessionManager 對 pty session 的狀態機簡化(設計決策)

pty 是連續、無回合邊界的終端 session(不像 ACP/SDK 的「一輪 prompt →
結構化事件 → `completed`」),`SessionManager`
(`apps/core/src/session/session-manager.ts`)因此用**活動量測**簡化判斷:

- `sendPrompt()` 後先轉 `busy`。
- 之後每收到一次該 session 的 `terminal-data` 事件,就把一個 800ms
  (`PTY_IDLE_TIMEOUT_MS`)的靜止計時器延後。
- 靜止超過這段時間沒有新輸出,才轉回 `idle`。
- 收到 pty 子程序自然結束送出的 `completed`/`error` 事件時,直接清掉計時器、
  照既有邏輯轉 `idle`/`error`。

這不是真正理解終端輸出語意(pty 無法知道「這個 CLI 是不是還在等你按下一個
鍵」),是刻意的簡化 —— e2e 步驟 10b 有驗證這個行為。`terminal-data` 事件本身
**不會**逐筆持久化進 SQLite(量大,且沒有可以離線回放的結構化語意),只透過
`session-event` 頻道直通轉發給 UI;renderer 端另外自行維護一個有上限的
記憶體 ring buffer(見 `apps/desktop/src/stores/session-store.ts` 的
`terminalBufferBySession`)讓使用者切換 session 分頁後回來還能看到最近輸出,
但這只是 renderer 暫存,不影響 core 端「不落地」的決定。

### node-pty 安裝結果(本機驗證,Windows x64 + Node 22)

`node-pty@1.1.0` 的 `install` script(`node scripts/prebuild.js || node-gyp
rebuild`)在本機透過**官方 prebuilt 二進位**成功安裝(`.node` 檔 + ConPTY 用的
`conpty.dll`/`OpenConsole.exe`),**不需要**本機裝 MSVC build tools 走
`node-gyp rebuild` 這條路(本機環境事實上也沒有裝 `cl.exe`)。已用暫存腳本
直接呼叫 `pty.spawn()` 驗證可以正常起子程序、收發資料、`kill()`。因此本專案
**不含** child_process + 管道的降級實作 —— 若未來在某台機器上 prebuild 抓取
失敗且本機也無法編譯,`apps/core` 啟動時 `import "node-pty"` 會直接丟出
module-not-found 錯誤,需要另外處理(包一層 dynamic import + try/catch,退化
成 `capabilities().terminal = false`),不在本次改動範圍內。

已知的無害 stderr 噪音:`node-pty` 在 Windows 走預設 ConPTY 模式(**不是**
`useConptyDll: true` —— 本機實測這個選項反而讓子程序完全收不到/送不出資料,
比預設模式更不可靠,因此刻意不採用)時,`kill()` 內部會另外 `fork()` 一個
短命的診斷子程序去查詢「這個 console 上還掛著哪些其他程序」;`apps/core`
這種以 `stdio:"pipe"` 背景執行、沒有附著在真實 Windows console 視窗上的
程序,這個診斷子程序的 `AttachConsole` 呼叫會失敗並印出一段 `Error:
AttachConsole failed` 的 stack trace 到它繼承的 stderr(也就是 `apps/core`
的 stderr)。**這不影響主程序**:已反覆驗證 kill()/dispose() 後 outputQueue
正常關閉、`tasklist` 確認無殘留 process、呼叫端正常 completes——這是
`node-pty` 上游在無 console 環境下的已知行為,可安全忽略。

### xterm 終端視圖

`apps/desktop` 安裝 `@xterm/xterm`(6.0.0,xterm.js 已從 `xterm` 改名到
`@xterm` scope,舊名 `xterm` 目前仍可用但已不再更新)+ `@xterm/addon-fit`。
`apps/desktop/src/views/SessionView.tsx` 依目前 session 對應 software 的
`capabilities()`(透過新的 gateway 方法 `adapter.capabilities` 查詢並快取,見
下方)決定渲染 `TerminalView.tsx`(`capabilities().terminal === true`,例如
`pty`)還是既有的 `ChatView.tsx`。`TerminalView` 直接把 `terminal-data` 事件
imperative 地寫進 xterm.js 的 buffer(不經過 zustand 的響應式 state,避免高頻
小片段輸出拖垮整個 store 的 re-render),輸入框送出的是「原始一行文字」,並提供
中斷(Ctrl+C)按鈕呼叫既有的 `session.interrupt`。

### Gateway 新增方法:`adapter.capabilities`

`packages/shared/src/gateway.ts` 的 `ClientRequestSchema` 新增
`adapter.capabilities`(`params: { software }` → `result: { capabilities }`,
`AdapterCapabilities` 型別搬到 `packages/shared/src/adapter-capabilities.ts`
當 single source of truth,`packages/adapters/src/types.ts` 直接 re-export
它),`WsGateway` 轉呼叫新增的 `SessionManager.getCapabilities(software)`。UI
在 `refreshProfiles()`/`createSession()`/`createProfile()` 之後都會主動預先
查詢並快取每個用到的 software,`SessionView` 才能在使用者切換 session 的當下
同步讀到快取,不必每次都先等一次 RPC 往返。

### 端到端冒煙測試

```bash
pnpm build                              # 需先 build,腳本會直接執行 apps/core/dist/index.js
node scripts/e2e-gateway.mjs             # 預設:deterministic + model-behavior 兩組都跑
node scripts/e2e-gateway.mjs --only=deterministic     # 只跑 deterministic 組(驗收閘門)
node scripts/e2e-gateway.mjs --only=model-behavior    # 只跑 model-behavior 組(觀察用)
```

**deterministic / model-behavior 兩組的定義(M5 Round A 任務0)**:57 個檢查
項目裡混了「斷言系統行為」與「斷言模型當輪自由選擇」兩種性質完全不同的
測試,過去全部混在一份 PASS/FAIL 清單裡,導致整份清單無法當成可靠的迴歸
閘門(同一份程式碼連跑兩次,一次 47/50、一次 49/50 是常態)。這輪把每個
檢查點分類:

- **deterministic**(驗收閘門,必須 100% PASS,`process.exitCode` 只由這組
  決定):斷言的是系統/協定行為——事件順序、DB 是否落地、狀態機是否正確、
  session 是否卡死、side effect(檔案/git 操作)是否發生——即使底層真的起了
  一個真實 Claude SDK session(例如步驟3/4/6/13a/14a-e),只要斷言本身不
  依賴模型當輪自由選擇的用詞或是否照做,就算 deterministic。步驟
  9/10/11/12/15/16 全程用 fake agent 或真實 git 子程序,完全不叫任何真實
  模型,是這組裡最強的決定性保證;步驟17(M5 Round A 新增,見下方)同樣
  100% 決定性。
- **model-behavior**(觀察用,失敗只印警告,不影響結束碼):斷言的是模型
  這一輪的自由選擇(是否照字面回覆某段文字、是否選擇呼叫某個工具)——同一段
  程式碼、同一個 prompt,模型不同輪可能給出不同結果,不是 regression。目前
  屬於這組的檢查點與各自的歸類理由:
  - **步驟3b**(回覆內容大致符合預期,軟性檢查):斷言模型選擇的措辭是否
    貼近期望文字,不影響步驟3主判定(分組/done/completed 才是硬性判定)。
  - **步驟5**(權限 deny 路徑):系統行為本身(deny 後不建立檔案、session
    正常結束)其實是系統行為,但整個檢查點能否在時間預算內收斂,依賴模型
    收到 deny 後是否選擇重試/換句話說法再問一次——已實測連續執行時偶發
    單獨 FAIL,因此整組列為 model-behavior。
  - **步驟13b**(模型實際呼叫 send_message 工具):直接斷言「模型是否選擇
    呼叫某個工具」,是模型的自由選擇,已知 flake。
  - **步驟14f**(原本冗長任務確實被中斷):依賴模型在送出 interrupt 前累積
    了多少內容、是否還在繼續原任務,屬於模型行為的時間點巧合,不是系統
    本身的行為保證。
  - **步驟14g**(後續 assistant 回覆提及注入的確認碼):直接斷言模型是否
    照字面回覆,已知 flake。
  - **14c/14d/14e 維持 deterministic**:雖然也依賴一個真實、正在忙碌中的
    Claude SDK session,但斷言的是「訊息是否被注入 session.history」
    「priority 是否被降級」「session 是否最終回到 idle」——這些是程式碼
    路徑本身的行為保證,不受模型是否遵從指令影響。

`--only` 只在真正能獨立省下一次額外模型呼叫時才整段略過(步驟5的獨立
session、步驟13b 的實際 prompt 送出);3b/14f/14g 是對同一輪已經因
deterministic 檢查而執行的模型呼叫做事後分析,不需要額外呼叫,因此不論
`--only` 為何都照常計算,只是被歸類進 model-behavior 統計組、不影響
deterministic 組的結論與結束碼。結束時分組印出兩份 PASS/FAIL 清單與各自的
統計數字。

會啟動一個獨立 port + 獨立 SQLite 資料目錄的 `apps/core` process,透過 WS
Gateway 跑一輪完整流程:

- 步驟 1-3:啟動 core、取得/建立 `AgentProfile`、建立 session、基本串流對話
  (`ClaudeAgentSdkAdapter`)。
- 步驟 4:權限 allow 路徑(驗證 tool-call 事件必須在對應的 tool-result 之前
  抵達)。
- 步驟 5(deny)、步驟 6(逾時):**各自建立一個獨立、測完即刪除的
  session**,不與步驟 3/4 共用 —— 這是 M2 Round A 步驟 0 的穩定化修法,見
  下方「已知限制」對 flake 的說明。步驟 6b 額外驗證權限逾時自動 deny 後
  core 會推播 `permission-resolved`(source=timeout)事件。
- 步驟 7:`session.delete` 清理主 session。
- 步驟 9:`AcpAdapter` + fake ACP agent(9a 建立 `software="acp"` 的 profile
  與 session;9b 一般 prompt 的串流事件轉換;9c 權限 allow 路徑;9d 權限
  deny 路徑;9e 清理)—— 全程不叫真實模型,結果 100% 決定性。
- 步驟 10(M2 Round B 新增):`GenericPtyAdapter` + `scripts/fake-pty-echo.mjs`
  (10a 驗證 `adapter.capabilities` 回報正確且建立 `software="pty"` 的
  profile/session;10b `sendPrompt` 寫入一行文字 → `terminal-data` 事件正確
  回顯,靜止 800ms 後 `SessionManager` 自動把狀態轉回 `idle`;10c
  `interrupt()` 送出的 `\x03` 真的以 SIGINT 送達子程序;10d 子程序自行
  `exit` 時送出 `completed` 事件並關閉 `outputQueue`;10e 清理)—— 全程不叫
  任何真實模型或外部 CLI,結果 100% 決定性。
- 步驟 11(M2 Round B 新增):Windows `.cmd` spawn 修復迴歸測試 —— 產生一個
  暫存、**路徑含空白目錄**的 `.cmd` wrapper(內容轉呼叫
  `node fake-acp-agent.mjs`),建立指向它的 `software="acp"` profile,驗證
  spawn 成功且事件轉換正常(涵蓋 `resolveWindowsSpawnCommand()` 的副檔名分類
  與 `quoteWindowsShellArg()` 的手動 quoting 兩個修復點)。非 Windows 平台會
  跳過並記為 PASS(此修復只影響 Windows)。
- 步驟 12(M3 Round A 新增,**決定性,不依賴外部模型**):`MessageBus` 端到端
  ——用兩個(後面再加一個)`software="acp"` 的 fake-acp-agent 成員組成一個
  team,全程透過 gateway 的 `team.*`/`message.send` 方法驅動:
  - 12a 建立 team + 兩個成員 + 各自的 session(`session.create` 帶
    `teamMemberId`)。
  - 12b idle 成員:`message.send` 後立即以 prompt 注入,用
    `scripts/fake-acp-agent.mjs` 新增的 `delayEchoMarker()`(prompt 內含
    `[[E2E_DELAY_ECHO:<ms>]]` 標記,agent 延遲後把完整收到的 prompt 加
    `"ECHO:"` 前綴回顯)驗證注入的 prompt 確實送達、格式正確(「來自
    @Tester(人類) 的訊息:...」),並比對 `team.messages` 落地紀錄。
  - 12c busy 成員:先用一個延遲 2500ms 的 prompt 讓對方忙碌,期間送出兩則
    訊息應被 `delivered: "queued"`,priming 那輪 `completed` 轉 `idle` 後
    `MessageBus` 應把兩則訊息合併成單一 prompt 批次注入(回顯內容需同時包含
    兩則訊息)。
  - 12d `priority="interrupt"` 的 `canInterrupt` 權限檢查:`canInterrupt=false`
    的成員送出 interrupt 應被自動降級為 `normal` 並在 `TeamMessage.note`
    標註;`canInterrupt=true` 的成員應維持 `interrupt`,不降級。
  - 12e 目標成員沒有活躍 session 時,`message.send` 回傳 `delivered:
    "no-session"`,訊息留在 Mailbox;之後 `session.create`(帶
    `teamMemberId`)建立該成員的 session 後,`MessageBus` 監聽
    `SessionManager` 的 `"member-session-ready"` 事件自動補投,fake agent
    的回顯驗證確實收到。
  - 12f 清理所有建立的 session。

  全程不叫任何真實模型,結果應為 100% 決定性。
- 步驟 13(M3 Round A 新增,**真實模型,允許軟性判定**):team-bus MCP
  工具 —— 建立一個含 Claude SDK 成員(掛載 team-bus MCP)的 team,prompt
  要求模型直接呼叫 `send_message` 工具把一段固定文字傳給 `"Reviewer"`,
  斷言 `team.messages` 出現 `to === "Reviewer" && content === <固定文字>`
  的紀錄。比照步驟 5 的既有慣例:模型這一輪偶發不呼叫工具視為已知 flake,
  如實記錄 FAIL detail(說明是 flake 而非 regression),不影響其他步驟判定。
- 步驟 14(M3 Round B 新增,**真實模型,硬性 + 軟性判定混合**,共 8 個子
  步驟):MessageBus 的 `priority="interrupt"` 投遞路徑在**真實、正在忙碌的
  Claude SDK session** 上的時序修正驗證(對應「M3 Round B 關鍵設計決策」的
  interrupt 時序修法)——建一個 team,`Worker` 成員(真實 Claude SDK
  session)被要求執行一個刻意冗長的任務(從 1 數到 100、每個數字附一句數學
  性質描述),觀察到第一個 `message-delta`(確認真的在忙碌中串流)後,
  `PM` 成員(`canInterrupt=true`,不需要真的建立 session ——
  `resolvePriorityForSender()` 只依名稱查 `TeamMember`,同一手法步驟 12d
  已驗證過)透過 `message.send` 送出一則 `priority="interrupt"` 的訊息:
  - 14a-14b:建立 team/session,確認 Worker 真的在忙碌中串流。
  - 14c(**硬性**):interrupt 訊息未被降級(`canInterrupt=true`,不依賴模型
    行為,100% 決定性)。
  - 14d(**硬性**):`session.history` 查得到這則 interrupt 訊息被注入成一則
    `user` 訊息 —— 這是「修正後的路徑(`await interrupt()` 才 `inject()`)
    沒有卡死、注入確實送達」的直接證據,不受模型後續是否遵從指令影響。
  - 14e(**硬性**):session 在有界時間內(90s)最終回到 `idle`,證明沒有
    卡死。
  - 14f(**軟性**):原本冗長任務的 assistant 訊息在送出 interrupt 後確實
    沒有跑完(未包含「100」),佐證 `interrupt()` 真的讓 SDK 停止了原本的
    回合,而不是排隊到原任務自然跑完後才處理插話。
  - 14g(**軟性**):插話之後,assistant 的下一則回覆確實提及/回覆了注入
    訊息裡要求的確認碼 —— 模型這輪可能選擇不照字面回覆,視為已知 flake
    (比照步驟 5/13),不影響 14d 已提供的決定性證據。
  - 14h:清理 session。

  本機反覆執行 2 次:第 1 次 14a-14f/14h 全 PASS、14g 因模型未照字面回覆確認碼
  單獨 FAIL(已知 flake,detail 訊息有明確標註);第 2 次 14a-14h 全 PASS。
  兩次執行中,三個硬性子步驟(14c/14d/14e)**皆 100% PASS**——這是這輪
  interrupt 時序修法在真實忙碌 SDK session 上「不卡死、注入確實送達」的
  直接證據。
- 步驟 15(M4 Round A 新增,**決定性,不依賴任何真實模型或 fake agent**):
  `TaskService` + `WorkspaceManager`,全程用真實 `git` 子程序 + 真實建立的
  team/task/member 驅動,**不建立任何 agent session**:
  - 15a:在系統暫存目錄建一個真的 git repo(`git init` + 設定
    `user.email`/`user.name` + 一個初始 commit),當作這輪 team 的
    `workingDir`;建 team + 一個成員(不建立 session)。
  - 15b:`task.create`(斷言初始 `status === "backlog"`)→ `task.assign`
    給該成員 —— 斷言:狀態轉 `assigned`、`workspace.worktreePath` 目錄
    實際存在於磁碟上、`git worktree list --porcelain` 看得到這個 worktree
    (在該 repo 底下)、分支名稱符合 `deskmony/task-<8碼>` 樣式、`task.create`
    與 `task.assign` 都各自收到對應的 `"task-updated"` 推播。
  - 15c:先試一個非法跳轉(`assigned → done`,跳過中間狀態)斷言被 RPC 拒絕
    (`ok:false`);接著走一條完整合法路徑 `assigned → in-progress → review
    → merging → done`(比對應的任務描述文字多了 `merging` 這一步——
    `review → done` 本身在狀態機裡不存在,見上方「M4 Round A 完成度」的
    狀態機轉移表說明),每一步都斷言 `task.updateStatus` 回傳的狀態正確、
    且都收到對應的 `"task-updated"` 推播。
  - 15d:report_status↔task 整合(透過這輪新增的 `message.reportStatus`
    gateway 方法,見上方「M4 Round A 完成度」),涵蓋四種情境:
    (1) `status` 對映得到且是合法轉換 → 任務狀態確實同步更新、訊息內容含
    「已同步」字樣;(2) `status` 對映不到的自由文字 → 任務狀態不變、訊息
    內容含「未同步」字樣;(3) 回報者不是該任務的指派人 → 任務狀態不變、
    訊息內容說明原因;(4) 不帶 `taskId` → 訊息內容維持 M3 的原始格式
    (向下相容)。
  - 15e:`task.delete` → 斷言 worktree 已被清理(`git worktree list` 不再
    含它、worktree 目錄從磁碟上移除、對應分支也被 `git branch -D` 刪除)、
    `task.get` 查不到已刪除的任務。
  - 結束時清理:額外刪除步驟中建立但未在 15e 主動刪除的任務(觸發對應
    worktree 清理)、移除整個暫存 git repo 與 worktree 根目錄
    (`.deskmony-worktrees/`),確保這個步驟結束後無殘留 worktree/暫存 repo。
- 步驟 16(M4 Round B 新增,**決定性,不依賴任何真實模型或 fake agent**):
  Review 合併流程 + `request_review`,全程用真實 `git` 子程序 + 真實建立的
  team/task/member 驅動,**不建立任何 agent session**:
  - 16(前置):在系統暫存目錄建一個真的 git repo(明確 `git init -b main`,
    不依賴這台機器的 `init.defaultBranch` 全域設定)當作 team 的
    `workingDir`;建 team + Coder/Reviewer 兩個成員(不建立任何 session)。
  - 16a:合併成功路徑——`task.assign` 後在 worktree 裡實際做一個 commit
    (`feature.txt`)→ 依序 `task.updateStatus` 推進到 `in-progress` →
    `review` → `merging` → `task.merge` —— 斷言任務變成 `done`、baseDir
    的 `git log --oneline --all` 看得到那個 commit、`feature.txt` 出現在
    baseDir 的工作目錄裡、`git branch --merged main` 確認任務分支已合併。
  - 16b:合併衝突路徑(獨立的暫存 repo,避免弄髒 16a/16c/16d 共用的
    repo)——baseDir 與 worktree 對同一個檔案(`conflict.txt`)分別 commit
    不同內容,製造真正的衝突,推進到 `merging` 後呼叫 `task.merge` —— 斷言
    這個 RPC 呼叫失敗(`ok:false`)、任務留在 `merging`、baseDir 的
    `git status --porcelain` 事後為空、沒有殘留的 `.git/MERGE_HEAD`
    (`git merge --abort` 確實生效)。
  - 16c:`request_review`——直接呼叫 `message.requestReview` gateway 方法
    (決定性,`ClaudeAgentSdkAdapter` 才會掛載 team-bus MCP,fake ACP agent
    呼叫不到真正的 MCP 工具,見上方「M4 Round B 完成度」),斷言任務從
    `in-progress` 轉到 `review`、回傳的訊息 `to === "Reviewer"` 且內容含
    「請審查」與任務標題、`team.messages` 歷史查詢也查得到這則訊息。
  - 16d:agent 不能自己合併到 done——16c 用過的任務推進到 `merging` 後,
    用 `message.reportStatus(status: "done", taskId)` 企圖繞過人類批准 ——
    斷言任務仍留在 `merging`,回應訊息內容說明需經 `task.merge`(含「未
    同步」與「task.merge」字樣)。
  - 16e:`task.delete` 的 `hadUncommittedChanges` 旗標——分別測試 worktree
    有未 commit 變更(寫入檔案但不 commit)與乾淨 worktree 兩種情境,斷言
    回應分別是 `true`/`false`。
  - 結束時清理:16a/16c/16d 共用的 team 內剩餘任務(觸發對應 worktree
    清理)、16b 獨立的衝突任務,移除兩個暫存 git repo 與各自的 worktree
    根目錄,確保這個步驟結束後無殘留 worktree/暫存 repo/分支。
- 步驟 8:額外跑一次 Electron 啟動冒煙測試(spawn 真正的 `electron.exe`,
  確認 main process 存活、core 子程序確實啟動並且 gateway 監聽成功、無致命
  錯誤)。
- 步驟 17(M5 Round A 新增,**決定性,不依賴任何真實模型**):認證
  (token-based),獨立管理自己的 core 子程序(不與步驟1-16 共用那個),見
  `authGatewaySmokeTest()`:
  - 17a:無 token 啟動的 core,連線可直接發 request(向後相容)。
  - 17b:有 token 啟動的 core,依序驗證四種情境——(17b-1)未認證連線發
    request(非 `auth`)被拒,回應含「認證」字樣的明確錯誤;(17b-2)`auth`
    帶正確 token 後,後續 request 正常;(17b-3)`auth` 帶錯誤 token 被拒,
    且連線在收到拒絕回應後主動被 server 關閉;(17b-4)完全不送任何訊息,
    連線在 `AUTH_TIMEOUT_MS`(5 秒)+ 緩衝時間內被 server 主動關閉。
  - 17c:綁定安全——用 `DESKMONY_BIND_HOST=0.0.0.0`、不設
    `DESKMONY_AUTH_TOKEN` 啟動一個 core 子程序,斷言它以結束碼 1 結束、
    stderr 含「拒絕啟動」與「DESKMONY_AUTH_TOKEN」字樣的明確錯誤。
  - 17d:既有 e2e 腳本自身的 `GatewayClient`(這支腳本手寫的最小 WS client
    類別,見檔案內 `class GatewayClient`)支援帶 token 連線並正常運作
    ——認證後跑 `team.create`/`team.list` 兩個代表性 RPC,證明整條
    request/response 路徑在認證開啟時依然正常,不是只有 `auth` 這個方法
    本身可用。
  - 結束時清理:各自的暫存 core 子程序與資料目錄。
- 步驟 18(M5 Round B 新增,**決定性,不依賴任何真實模型**):靜態網頁
  (任務1)+ 安全強化(任務3),獨立管理自己的 core 子程序(與步驟1-17都不
  共用),見 `staticServerAndSecuritySmokeTest()`:
  - 18a:啟動一個**已設定 `DESKMONY_AUTH_TOKEN`** 的 core(刻意如此,用來
    驗證「即使認證已啟用,靜態頁面仍不需要 token」這條安全界線)。
    (18a-1)`GET /` 回 200 且是 HTML;(18a-2)`GET` 一個實際存在的靜態資源
    (從 `apps/desktop/dist/assets/` 動態找一個 `.js` 檔)回 200;(18a-3)
    目錄穿越三種變體——原始 `/../../package.json`、URL 編碼
    `/%2e%2e/%2e%2e/package.json`、反斜線混合 `/..\..\package.json`——皆
    不得回傳專案根目錄 `package.json` 的內容(用 `node:http` 的低階
    `http.request({ path })` 送出原始請求行,刻意不用全域 `fetch()`/WHATWG
    `URL`,因為兩者會在建構 URL 物件時先把 `..` 正規化掉,無法真的把帶有
    `..` 的原始路徑送到伺服器,測不到伺服器端的目錄穿越防護)。判定條件是
    「不得洩漏檔案內容」而不是「一律回傳非 200」——`resolveStaticFile()`
    的正規化本身就會把 `/../../package.json` 收斂成對應 `distDir` 底下一個
    通常不存在的同名檔案,安全地退回 `index.html`(200);反斜線變體則在
    更早的防禦層被直接攔下(400)。兩種拒絕方式都滿足「不洩漏」,e2e 只檢查
    回應內容不含 `package.json` 的特徵字串。
  - 18b:同一個 core 上驗證 WS 仍要求認證,聚焦在「HTTP 與 WS 共用同一個
    port,兩者互不干擾」——(18b-1)帶錯 token(長度不同)被拒;(18b-2)帶
    對 token 可正常呼叫 `profile.list`。
  - 18c:timingSafeEqual——同長度但內容錯誤的 token 必須正確拒絕、不丟
    例外(伺服器未崩潰/未異常斷線);不同長度與正確 token 兩種情況直接複用
    18b 已驗證過的連線,三種情況合起來覆蓋 `timingSafeTokenEqual()` 的完整
    行為。
  - 18d:rate limiting,獨立一個 core(避免 18a-c 的認證失敗次數污染門檻
    計算),用環境變數縮短門檻(3 次)/冷卻期(5 秒)——(18d-1)連續達門檻
    次數的認證失敗後,冷卻期內即使下一次帶「正確」token 也被拒;(18d-2)
    等冷卻期過後,正確 token 恢復正常可用。
  - 結束時清理:兩個暫存 core 子程序與資料目錄。
- 步驟 19(M5 Round C 新增,**決定性,不依賴任何真實模型**):刪除對話——
  `session.create`(不送任何 prompt,`ClaudeAgentSdkAdapter.spawn()` 本身
  不會呼叫模型)→ `session.list` 確認存在 → `session.delete` → `session.list`
  確認不存在。
- 步驟 20(M5 Round C 新增,混合:20a-20d 決定性 / 20e 真實模型軟性判定):
  對話中切換 model——
  - 20a:建立一個明確指定 `model` 的 `software="claude-agent-sdk"` profile
    + session,驗證 `session.create` 回應與之後 `session.list` 查到的
    `session.model` 都等於 `profile.model`。
  - 20b:呼叫 `session.setModel` 換成另一個 model id,驗證 RPC 回應與之後
    `session.list` 查到的 `session.model` 都已更新成新值。
  - 20c:驗證 `session.setModel` 成功後有推播對應的 `"session-updated"`
    事件(帶新 `model`),讓 UI 標題列能即時同步,不需要等下一次
    `session.list` 才知道。
  - 20d:分別建立 `software="acp"`/`software="pty"` 的 fake agent session,
    呼叫 `session.setModel` 都必須得到明確的錯誤(RPC `ok:false`),不可
    默默成功——這兩種 adapter 的實作直接 `throw`。
  - 20e(model-behavior,軟性):換 model 後,對該 session 送一個 prompt,
    驗證仍能正常完成一輪對話(硬性斷言只驗證 20a-20d 的系統行為;20e 額外
    驗證的是「模型這一輪是否真的配合」,依賴真實 API 是否認得新 model id、
    額度/權限是否足夠等外部因素,失敗不影響 deterministic 組結論)。
- 步驟 21(M5 Round D 新增,**決定性,全程不叫任何真實模型**):「設定」
  介面的 agent 偵測(`env.detectAgents`)。分兩部分:
  - 21a/21b/21b-2:**不經過 gateway**,直接 dynamic import 編譯後的
    `apps/core/dist/detect/agent-detector.js`,呼叫其 export 的
    `probeCommand()`/`detectAllAgents()`——21a 用 `node`(執行 core 本身的
    必要條件,必定存在)驗證 `installed=true` 且 `version` 非空;21b 用一個
    亂數 bogus 命令名驗證 `installed=false`;21b-2 驗證 `detectAllAgents()`
    整體在合理時間內完成(逾時安全,不會被 allowlist 內任何一個探測不到的
    命令拖住)。之所以直接 import 編譯產物、不透過 gateway 傳入 command
    字串,是刻意避免在 gateway 層新增一個「可指定任意命令」的方法——那本身
    就是不必要的攻擊面。
  - 21c-21e:透過與步驟1-20 共用的同一個 client 呼叫正式的
    `env.detectAgents` 方法——21c 驗證回傳結構是 `{ agents: [...] }` 陣列;
    21d 驗證每一項欄位型別完整(`key`/`displayName`/`software` 為字串、
    `installed` 為 boolean、`models` 為陣列);21e 驗證陣列裡一定包含
    `key === "claude-agent-sdk"` 的內嵌項且 `installed === true`、`models`
    非空(它不依賴任何外部 CLI,必定出現)。刻意不斷言任何特定外部 CLI
    (claude/gemini/opencode/codex/aider)是否真的裝了——那是「本機到底裝了
    什麼」,因機器而異,不是這支腳本該斷言的決定性行為。
- 步驟 22(M5 Round E 新增,**決定性,不需要 core/gateway**):「偵測項 →
  可建立 (software,command) 映射」純函式(`packages/shared/src/agent-target.ts`)。
  不經過 gateway,直接 dynamic import 編譯後的 `packages/shared/dist/agent-target.js`,
  用手造的 `AgentDetectionEntry` fixture 呼叫其 export。22a 驗證
  `claude-agent-sdk` 內嵌項推導出 `software="claude-agent-sdk"` 且不需要
  command;22b 驗證 acp/codex/pty 這幾種外部 CLI 偵測分類一律預設推導成
  `software="pty"` 且 command 非空(不會產生 `software="codex"` 這種
  `AdapterRegistry` 建不起來的映射);22b-2(這輪新增)驗證 `opencode` 分類
  推導成 `software="opencode"` 本身(`OpenCodeAdapter` 已實作,不再退化成
  `pty`,見下方「OpenCodeAdapter」章節);22c 驗證沒有偵測到路徑的項目
  command 為 `undefined`;22d 驗證「進階:改用 ACP」的
  `canUseAcpAdvanced()`/`deriveAcpAdvancedTarget()` 只對偵測分類本身是
  `"acp"` 且有路徑的項目開放(opencode 依然沒有這個選項)。
- 步驟 24(這輪新增,**決定性,不依賴真實 opencode 執行檔或任何模型**):
  `OpenCodeAdapter` + `scripts/fake-opencode-server.mjs`(24a 驗證
  `adapter.capabilities` 回報正確且建立 `software="opencode"` 的
  profile/session;24b 一般 prompt 的 `message.part.delta`/`message.part.
  updated` → `message-delta` 轉換與 `completed`;24c 權限 allow 路徑
  (tool-call → permission-request → tool-result);24d 權限 deny 路徑(無
  tool-result);24e `interrupt()` 送出 `/session/{id}/abort` 後回合確實收斂,
  `MessageAbortedError` 不誤轉成 `error` 事件;24f 清理)——全程不叫任何真實
  opencode 執行檔或模型,結果 100% 決定性。詳見下方「OpenCodeAdapter」章節。
- 步驟 23(M5 Round E 新增,**決定性,全程不叫任何真實模型**):設定持久化
  (`settings.getEnabledModels`/`settings.setEnabledModels`)。獨立管理自己的
  core 子程序(專用 port + 專用 `DESKMONY_DATA_DIR`)。23a 驗證未曾設定過時
  `getEnabledModels` 回傳空陣列(「空=全部啟用」約定);23b 驗證
  `setEnabledModels` 後同一連線內 `getEnabledModels` 讀回一致;23c
  **關掉 core 子程序、用同一個 `DESKMONY_DATA_DIR` 重啟一個全新的 core 子
  程序**,`getEnabledModels` 仍讀回相同的值——這是證明設定真的落地 SQLite
  檔案、不是只存在上一個 process 記憶體的關鍵子步驟;23d 驗證
  `setEnabledModels([])`(使用者在 UI 上全部勾選時的儲存行為)後回到
  「全部啟用」的空陣列語意。

結束時清理所有 process 與暫存檔案。全部檢查點都能正常完成時共 88 項
(deterministic 82 項 + model-behavior 6 項,M5 Round E 新增步驟22/23後的
最新數字——見下方「M5 Round E 完成度」)。**deterministic 組必須 100%
PASS**(步驟1、1b、2、3(不含3b)、3c、4、6、6b、7、9、10、11、12、13a、
14a-14e、14h、15、16、17、18、19、20a-20d、21、22、23、24 全數;步驟8 這輪起
也改為 deterministic 子步驟)——如果 deterministic 組出現 FAIL,通常代表
regression,`process.exitCode` 會非 0。**model-behavior 組**(步驟3b、5、
13b、14f、14g、20e)本身仍可能因為模型這一輪的選擇而偶發 FAIL(見下方已知
限制),如實記錄但不影響 `process.exitCode`,也不應連鎖拖垮 deterministic
組的其他項目判定。
實際執行紀錄(含一次觀察到的步驟14b 逾時偶發 FAIL,判斷為真實 API 延遲而非
regression)見上方「M5 Round A 完成度」章節;M5 Round B 新增的步驟18本機
反覆執行皆 100% 決定性 PASS,見下方「M5 Round B 完成度」。

## OpenCodeAdapter:HTTP + SSE 對接 opencode 的 headless server(這輪新增)

修復使用者實際回報的問題:前一輪把所有偵測到的外部 CLI(含 opencode)一律
預設映射成 `software="pty"`,建出來的 profile 對 opencode 而言只是把它自己
的整頁全螢幕 TUI 塞進 xterm 終端視圖,體驗很差(TUI 全螢幕重繪在 xterm 裡
還會顯示殘缺)。ARCHITECTURE.md 3.4 節的表格其實一直都列著
`OpenCodeAdapter | OpenCode 的 HTTP + SSE server API`,只是還沒實作——這輪
補上。

### 調查方法與實際觀察(**全部以本機實際執行輸出為準,不臆測**)

本機已安裝 `opencode`(`where opencode` → `C:\Users\User\AppData\Roaming\npm\
opencode` 與 `opencode.cmd`,版本 `1.18.4`)。依序執行並記錄實際輸出:

1. `opencode --help`:除了預設的 TUI 子命令,還列出 `opencode serve`
   (「starts a headless opencode server」)、`opencode acp`
   (「start ACP (Agent Client Protocol) server」)、`opencode attach <url>`
   等子命令。`opencode serve --help` 顯示 `--port`(預設 `0`,隨機取一個
   port)、`--hostname`(預設 `127.0.0.1`)兩個關鍵旗標。
   > 附帶發現:opencode **也有**原生的 `opencode acp` 子命令,理論上可以讓
   > 既有的 `AcpAdapter` 直接對接(不需要新的 adapter)。這輪仍選擇依
   > ARCHITECTURE.md 3.4 節表格原訂計畫實作獨立的 `OpenCodeAdapter`(HTTP +
   > SSE),因為 opencode 的 HTTP API 天生比 ACP 提供更豐富的事件粒度(見
   > 下方 `message.part.delta` 的發現)、且與文件既有規劃/使用者要求一致;
   > `opencode acp` 這條路徑留給日後若要簡化 adapter 數量時參考,這輪不用。
2. 實際跑 `opencode serve --port 4315 --hostname 127.0.0.1`:stdout 印出
   `opencode server listening on http://127.0.0.1:4315`(**沒有**額外
   `--print-logs` 旗標也會印這行);`GET /doc` 回傳一份完整 OpenAPI 3.1
   文件(478KB);`GET /global/health` 回 `{healthy:true, version}`。
3. 用 `curl` 依序 `POST /session`(空 body)、`GET /event`(SSE)、
   `POST /session/{id}/message`(body
   `{parts:[{type:"text",text:"..."}]}`)實測兩種情境:
   - 極短回覆(單一英文字 "pong"):`message.part.updated` 直接從空字串
     跳到最終全文,**完全沒有** `message.part.delta` 事件。
   - 觸發 `bash` 工具(prompt 要求執行 `echo`):完整觀察到
     `message.part.delta`(`field:"text"`,真正的增量片段)、`tool` 型別的
     `message.part.updated`(`state.status`: `pending`→`running`→
     `completed`,帶 `output`)、`session.status`(`busy`/`idle`)、
     `session.idle`。**沒有觸發權限請求**(這台機器的 opencode 設定對
     `bash` 工具似乎是自動允許,不影響 adapter 設計本身,`permission.asked`
     的事件形狀改用 OpenAPI 文件裡的 schema 定義)。
4. 用 `POST /session/{id}/abort` 測試中斷:HTTP 回應立即 `true`,實際生效
   (SSE 收到帶 `error:{name:"MessageAbortedError"}` 的 `message.updated`、
   隨後 `session.idle`)則稍後才到——證實中斷是非同步生效,`interrupt()`
   需要 best-effort 等待 idle 才能安全回傳。
5. `POST /session` 沒有帶 `directory` 參數時,session 的工作目錄就是
   opencode server process 本身的 cwd(實測驗證)——因此 adapter 不需要在
   建立 session 時額外處理 `directory` 查詢參數,只要沿用既有慣例把 `cwd`
   設成 `workspace.path` 即可。
6. 全程用 `taskkill /IM opencode.exe /T /F` 確認調查用的所有 `opencode
   serve` process 都已結束,沒有殘留。

完整的原始 curl/SSE 輸出摘錄與 OpenAPI 端點清單記錄在本次調查過程中(見
`packages/adapters/src/opencode-adapter.ts` 頂端註解逐條引用)。

### 對接策略(`packages/adapters/src/opencode-adapter.ts`)

- **每個 session 各自 spawn 一個獨立的 `opencode serve` 子程序**(`cwd`
  設成 `workspace.path`),固定帶 `serve --port 0 --hostname 127.0.0.1`,
  解析 stdout 的 `listening on http://...` 這一行取得實際 base URL,再輪詢
  `/global/health` 確保就緒,才呼叫 `POST /session` 建立 opencode 端的
  session。這與 `AcpAdapter`/`GenericPtyAdapter` 每個 session 各自 spawn
  一個子程序的既有模式一致(見下方「已知限制」的記憶體用量取捨)。
- `sendPrompt()` 呼叫 `POST /session/{id}/message`(不等待它 resolve——
  這支 API 會阻塞到整輪真正完成才回應,但同一時間常駐訂閱的 `GET /event`
  SSE 連線已經即時推播中間過程,真正的串流顯示與回合邊界完全交給 SSE
  處理)。
- 事件轉換(對應 ARCHITECTURE.md 4.3 節 `AgentEvent` 型別):
  - `message.part.delta`(`field:"text"`)與 `message.part.updated`
    (`type:"text"`,帶完整累積文字)兩種事件來源統一用「已知長度」追蹤
    (`partMeta.textLength`),只轉發「還沒送出過的後綴」,避免因為「短回覆
    沒有 delta 事件、長回覆兩種事件都有」這個實測發現而重複送出
    `message-delta`。`messageId` 刻意用 opencode 的 **part id**(不是
    opencode 的 message id)——一則 assistant 訊息可能由多個 text part
    組成(文字→呼叫工具→文字),用 part id 才能讓每個文字段落各自成為一組
    有清楚 `done:true` 邊界的訊息。
  - `type:"reasoning"` 的 part 刻意不轉發(如同 ACP/Claude SDK adapter 都
    不轉發思考過程文字)。
  - `type:"tool"` 的 part(`status`: `pending`→`running`→`completed`/
    `error`)轉成 `tool-call`(第一次看到這個 `callID` 時)+ `tool-result`
    (`status` 變成 `completed`/`error` 時)。
  - `permission.asked` → `permission-request`;`resolvePermission()` 呼叫
    `POST /permission/{id}/reply`(`allow`→`"once"`,`deny`→`"reject"`)。
  - `session.status`(`idle`)/`session.idle` → 忙碌轉閒置的邊界,flush
    尚未收到 `done` 的 text part、送出 `completed`。`message.updated` 帶
    `error` 且 `error.name !== "MessageAbortedError"` 時才轉成 `error`
    事件——中斷造成的 `MessageAbortedError` 是預期結果,不當錯誤處理,單一
    回合只會送出 `completed` 或 `error` 其中一個(不會兩個都送)。
- `capabilities()` 據實回報:`streaming`/`toolEvents`/`permissionRequests`/
  `interrupt` 為 `true`,`diff`/`terminal` 為 `false`(`terminal:false` 讓
  `SessionView.tsx` 自動渲染 `ChatView` 而不是 `TerminalView`——這正是修復
  「opencode 只是 TUI 塞進終端」問題的關鍵,見 3.1 節/`SessionView.tsx` 的
  既有能力探測邏輯,不需要另外改 UI)。
- `setModel()` 明確拋出錯誤(不謊報支援):opencode 的 model 選擇是每則
  訊息各自可選的 `{providerID,modelID}`,不是一個獨立的「設定當前 model」
  狀態,而 `AgentProfile.model` 是扁平字串,沒有不臆測的方式拆解成
  opencode 要求的兩個欄位(需要另外查 `/provider` 才能正確對應,超出這輪
  範圍)。

### `OpencodeAgentConfigSchema`(`packages/shared/src/agent-profile.ts`)

```jsonc
// 呼叫 gateway 的 profile.create
{
  "name": "My OpenCode Agent",
  "software": "opencode",
  "workingDir": "/path/to/project",
  "opencodeConfig": {
    "command": "C:\\Users\\...\\opencode.cmd",   // 由偵測結果自動帶入,見 agent-target.ts
    "env": { "SOME_TOKEN": "..." }                 // 選填,會與 process.env 合併
  }
}
```

`args`(選填)語意與 `acpConfig`/`ptyConfig` 不同:**提供時完全取代**
adapter 自動組出的 `["serve", "--port", "0", "--hostname", "127.0.0.1"]`,
不是附加參數——唯一實際用途是 `scripts/fake-opencode-server.mjs`(見下方
e2e 章節),一般情況下(`args` 省略)不需要填。`ProfileCreateDialog.tsx`
因此對 opencode 分支刻意隱藏了泛用的「args」輸入框,避免使用者誤填導致
spawn 失敗。

### 偵測項 → 建立目標的映射更新(`packages/shared/src/agent-target.ts`)

`deriveDefaultAgentTarget()` 這輪把偵測分類為 `"opencode"` 的項目改成映射
成 `software="opencode"` 本身(不再退化成 `pty`)。`DerivedAgentTarget.
software` 型別同步擴充成
`Extract<AgentSoftware, "claude-agent-sdk" | "acp" | "pty" | "opencode">`
——`codex` 目前仍然沒有對應的 adapter,繼續映射成 `pty`(維持「這個型別只能
包含 `AdapterRegistry` 真正註冊過的 software」這條既有原則)。

### `scripts/fake-opencode-server.mjs`(不依賴真實 opencode、不依賴模型的決定性測試)

用 `node:http` 實作與真實 opencode 相同形狀的端點(`/session`、
`/session/{id}/message`、`/session/{id}/abort`、`/event`、
`/permission/{id}/reply`、`/global/health`)與 SSE 事件(`message.part.
updated`/`message.part.delta`/`session.status`/`session.idle`/
`permission.asked`),啟動後印出與真實 opencode 相同格式的
`opencode server listening on http://127.0.0.1:<port>`,讓
`OpenCodeAdapter` 的 port 探測邏輯不需要區分真假伺服器。透過固定的 prompt
前綴(`OPENCODE_TOOL_CALL`/`OPENCODE_SLOW`)分別驅動一般回覆、工具呼叫+
權限請求、以及可被中斷的長回覆三種情境,對應 e2e 步驟24。詳見上方「端到端
冒煙測試」步驟24的說明。

### 已知限制 / TODO

- **每個 session 各自 spawn 一個獨立的 `opencode serve` 子程序**,本機實測
  單一 process 常駐記憶體約 300–600MB——換取實作簡單、與既有
  ACP/PTY adapter 一致的 per-session 隔離模式,session 數量多時會比「adapter
  內部共用一個常駐 server、用 `?directory=` 區分不同 session」更耗資源。
  未來若要優化,需要額外處理「最後一個 session dispose 時才真正結束共用
  server」的參照計數,這輪先以正確性與一致性優先,不做。
- `setModel()` 不支援(見上方)。
- `diff` 能力回報 `false`:opencode 有 `session.diff` 事件與 `/vcs/diff`
  端點,這輪沒有解析轉發。
- `message.part.updated` 裡 `step-start`/`step-finish`/`patch`/`file`/
  `agent`/`subtask` 型別的 part 尚未有對應的 `AgentEvent` 型別,略過不轉發
  (與 `AcpAdapter` 對 ACP 擴充型別的既有做法一致)。

## Modal 彈窗定位修復:`ModalPortal`(這輪新增)

使用者實測回報:「建立 Agent Profile」對話框被主視窗切掉,只看得到右半部,
左半部超出視窗邊界。

### 根因

`apps/desktop/src/views/SessionList.tsx` 的 `<aside>`(側欄,M5 Round B
響應式改版時加入,約第 82 行)帶了 `transition-transform` +
`sm:translate-x-0`/`-translate-x-full`(手機版側欄用 CSS transform 滑入
滑出);而 `ProfileCreateDialog` 過去被渲染在**這個 `<aside>` 內部**(約第
184 行),它自己用 `fixed inset-0 flex items-center justify-center` +
`w-[480px]` 的內容盒(約第 165 行)。

CSS 規範:**祖先元素只要套用了 `transform`(或 `perspective`/`filter`/
`will-change: transform` 等會建立新 containing block 的屬性),就會成為其
`position: fixed` 子孫的定位基準**,不再是 viewport。`fixed inset-0` 因此
不是對齊整個視窗置中,而是對齊只有 `w-64`(256px)寬的側欄容器——480px 寬的
對話框置中在 256px 容器內,自然向左溢出視窗邊界,正是使用者截圖看到的
「左半部被切掉」現象。已用 Electron 實際開啟對話框重現並確認修復前後的
視覺差異(見下方「驗證方式」)。

### 修法:`ModalPortal`(`apps/desktop/src/views/ModalPortal.tsx`)

新增一個共用元件,內部用 `react-dom` 的 `createPortal()` 把彈窗的 DOM 節點
掛到 `document.body`(React 元件樹的父子關係、事件冒泡、context 完全不變,
只有實際渲染的 DOM 位置改變)——`document.body` 本身沒有任何 transform,
`fixed inset-0` 從此保證以整個 viewport 為定位基準。

這比「移除 `SessionList` 的 transform」更穩健:即使未來又有人在別的祖先
元件(例如某個面板的滑入滑出動畫)加 transform,用了 `ModalPortal` 的彈窗
依然不會受影響——選擇統一走共用元件而非讓每個彈窗各自呼叫
`createPortal()`,是為了讓這條「所有全螢幕遮罩彈窗都必須用 portal」的規則
只需要維護一次。

### 稽核範圍

逐一檢查所有 `fixed inset-0` 全螢幕遮罩彈窗的渲染位置是否落在帶 transform
的祖先下:

| 元件 | 渲染位置(修復前) | 是否受這次的 transform 影響 | 處理方式 |
|---|---|---|---|
| `ProfileCreateDialog.tsx` | `SessionList.tsx` 的 `<aside>` 內部 | **是**(根因觸發點) | 改用 `ModalPortal`,另加高度保護(見下方) |
| `SettingsDialog.tsx` | `App.tsx` 頂層(無 transform 祖先) | 否 | 改用 `ModalPortal`(一致性 + 未來安全) |
| `PermissionModal.tsx` | `App.tsx` 頂層(無 transform 祖先) | 否 | 改用 `ModalPortal`,另加高度保護(原本沒有 `max-h`/`overflow`) |
| `TeamManagementDialog.tsx` | `TeamChatView.tsx`/`TaskBoardView.tsx` 的 `<main>` 內(無 transform 祖先) | 否 | 改用 `ModalPortal`(一致性 + 未來安全) |

用 `grep -rn "transform\|translate-x\|scale-" apps/desktop/src` 確認整個
`apps/desktop` 目前**唯一**帶 transform 的祖先就是 `SessionList.tsx` 的
`<aside>`,而它只包住 `ProfileCreateDialog` 一個彈窗——與根因分析吻合。

### 高度保護(順手處理)

- `ProfileCreateDialog`:改成 `flex max-h-[90vh] flex-col`(外層)+ 內容區
  `flex-1 overflow-y-auto`(原本是寫死的 `max-h-[70vh]`,改成 flex 讓
  header/footer 固定、只有中間內容區捲動,對任何視窗高度都安全)。
- `PermissionModal`:原本完全沒有高度保護,新增 `max-h-[90vh] overflow-y-auto`。
- `SettingsDialog`/`TeamManagementDialog`:原本就已經是
  `flex max-h-[80vh]/[85vh] flex-col` + 內容區 `overflow-y-auto` 的正確
  寫法,這輪不需要調整,只加上 `ModalPortal`。

### 驗證方式

UI 定位無法無頭斷言(e2e 腳本走的是 WS Gateway,不牽涉真實瀏覽器渲染),
這輪的驗證方式:

1. `pnpm -r run typecheck`/`build` 全綠,確認 `ModalPortal` 的型別與四個
   彈窗的 import/JSX 巢狀關係正確。
2. 用 Chrome DevTools 風格的瀏覽器工具開啟 `apps/desktop` 的 dev server,
   把視窗縮到 `< sm`(640px,觸發 `SessionList` 的 overlay/transform 模式)
   同時開啟「建立 Agent Profile」對話框,確認對話框置中於整個視窗、不再
   被切、可以完整看到左右兩側邊界。
3. 確認寬螢幕(側欄維持 `sm:translate-x-0`,transform 值本身固定但屬性仍在)
   下對話框同樣置中正常——因為 `ModalPortal` 已經讓對話框完全脫離
   `<aside>` 的 DOM 子樹,不論側欄目前的 transform 值是多少都不受影響。

## 建置與型別檢查

```bash
pnpm typecheck   # 對所有 workspace 套件執行 tsc --noEmit
pnpm build       # 依相依順序 build 所有 workspace 套件(shared -> adapters/db -> core/desktop)
```

已於本機驗證(M3 Round A):`pnpm install` → `pnpm -r run clean && pnpm -r run
build && pnpm -r run typecheck` 全數通過,包含 `apps/desktop` 的 Vite
production build → `node scripts/e2e-gateway.mjs` 反覆執行多次,31 個檢查
項目中新增的步驟 12(MessageBus,6 個子步驟)每次都 100% 決定性 PASS,步驟
13(team-bus MCP 工具,真實模型)兩次執行皆 PASS,既有 23 項行為不變
(步驟 5 仍是既有已知的模型行為 flake,一次執行中觀察到單獨 FAIL、其餘項目
不受影響),結束後用 `tasklist`/PowerShell `Get-Process` 確認無殘留
`node.exe`/`electron.exe` process。

已於本機驗證(M3 Round B):`pnpm install`(無新增前端依賴,團隊管理 UI/群聊
視圖沿用既有的 zustand + Tailwind)→ `pnpm -r run build && pnpm -r run
typecheck` 全數通過,包含 `apps/desktop` 的 Vite production build →
`node scripts/e2e-gateway.mjs` 反覆執行 2 次,總項目數由 31 增為 **39**
(新增步驟 14,8 個子步驟):第 1 次 38/39 PASS(僅步驟 14g 這個已知 flake
的軟性子步驟 FAIL,detail 已標註原因,不影響其餘項目);第 2 次 38/39
PASS(這次換步驟 5 這個既有已知 flake 單獨 FAIL,步驟 14 全數 8 個子步驟含
14g 都 PASS)。兩次執行中,步驟 14 的三個硬性子步驟(14c/14d/14e)**皆
100% PASS**,既有 31 項行為不變,結束後用 `tasklist` 確認無殘留
`node.exe`/`electron.exe` process。

已於本機驗證(M4 Round A):`pnpm install`(本輪未新增任何相依套件)→
`pnpm -r run build && pnpm -r run typecheck` 全數通過,包含 `apps/desktop`
的 Vite production build(desktop 本身沒有程式碼變更)→
`node scripts/e2e-gateway.mjs` 本機執行 2 次,總項目數由 39 增為 **44**
(新增步驟 15,5 個子步驟):第 1 次 42/44 PASS —— 步驟 14g(既有已知
flake)單獨 FAIL,以及步驟 15b 因為 e2e 腳本自身的 bug(Windows 上
`git worktree list --porcelain` 輸出正斜線路徑,但比對用的字串是
`path.join()` 產生、Windows 上為反斜線,沒有正規化導致字串比對永遠比不到——
worktree 實際上建立成功、目錄存在、`git` 也認得,不是 `WorkspaceManager`
的 bug)單獨 FAIL;修正 e2e 腳本的路徑正規化後,第 2 次執行 44/44 全 PASS
(含步驟 14g 與步驟 15 全部 5 個子步驟)。新增的步驟 15 涉及真實 `git` 子
程序操作(worktree 建立/清理、分支建立/刪除),兩次執行(第 2 次已修正)皆
100% 決定性 PASS;既有 39 項行為不變,結束後用 PowerShell `Get-Process`
確認無殘留 `node.exe`/`electron.exe` process,並確認暫存 git repo 目錄與
`.deskmony-worktrees/` 都已被清理、不留殘留。

已於本機驗證(M4 Round B):`pnpm install`(本輪未新增任何相依套件)→
`pnpm -r run clean && pnpm -r run build && pnpm -r run typecheck` 全數通過,
包含 `apps/desktop` 的 Vite production build →
`node scripts/e2e-gateway.mjs` 本機執行 2 次,總項目數由 44 增為 **50**
(新增步驟 16,6 個子步驟:前置/16a/16b/16c/16d/16e):第 1 次 49/50
PASS —— 僅 16a 因為 e2e 腳本自身的判斷式 bug 單獨 FAIL(`git branch
--merged` 對「目前簽出在另一個 worktree 裡的分支」用 `+ ` 前綴,不是
`* `/純空白,e2e 腳本原本只去掉 `*` 前綴,字串比對永遠比不到——分支實際上
已經合併成功,不是 `WorkspaceManager` 的 bug);修正 e2e 腳本的前綴解析
(同時去掉 `*`/`+` 兩種前綴)後,第 2 次執行 **50/50 全 PASS**(含步驟 16
全部 6 個子步驟)。新增的步驟 16 涉及真實 `git` 子程序操作(worktree 建立/
清理、跨 baseDir 與 worktree 的 commit、`git merge --no-ff`/`git merge
--abort`、分支合併判定),兩次執行(第 2 次已修正)皆 100% 決定性 PASS;
既有 44 項行為不變(第 2 次執行含步驟 5、14g 在內的既有已知 flake 皆未
出現,全數 PASS),結束後用 PowerShell `Get-Process` 確認無殘留
`node.exe`/`electron.exe` process,並確認兩個暫存 git repo(16a/16c/16d
共用 repo + 16b 獨立的衝突測試 repo)與各自的 `.deskmony-worktrees/` 都已
被清理、不留殘留。

## M1 完成度

- [x] pnpm workspace monorepo(`packages/shared`、`packages/adapters`、
      `packages/db`、`apps/core`、`apps/desktop`),對應 ARCHITECTURE.md 第 8 節目錄結構
- [x] `packages/shared`:zod 定義 AgentProfile、Session/SessionStatus、
      AgentEvent(訊息增量/工具呼叫/工具結果/權限請求/完成/錯誤)、PromptInput、
      Gateway 的 request/response + event push 協議
- [x] `packages/adapters`:`AgentAdapter` 介面(capabilities/spawn/sendPrompt/
      events/interrupt/dispose,額外補上 `resolvePermission` 用於回覆權限請求)
      + `ClaudeAgentSdkAdapter`(基於實際讀取 `@anthropic-ai/claude-agent-sdk`
      的 `.d.ts` 對接 `query()`、streaming input、`canUseTool`、
      `includePartialMessages` 串流事件)
- [x] `apps/core`:
  - `gateway/`:`ws` 套件實作的 WebSocket server,request/response + 事件推播
  - `session/`:`SessionManager`,管理 session 生命週期與
    idle/busy/waiting/error 狀態機
  - `permissions/`:`PermissionGateway`,收斂權限請求、等待外部回覆、逾時
    (預設 5 分鐘)自動拒絕
  - SQLite 持久化(better-sqlite3 + Drizzle):`sessions`、`messages` 兩張表
- [x] `apps/desktop`:Electron + React + TypeScript + Zustand + Tailwind
  - 左側 session 列表(建立/切換 session)
  - 中間聊天串流視圖(逐字串流顯示 assistant 訊息、tool call 摺疊顯示)
  - 權限請求彈窗(允許/拒絕,回傳給 core)
  - Electron main process 啟動 apps/core(child process)並管理視窗
- [x] 全部 workspace 套件 `tsc --noEmit` 型別檢查通過,`pnpm build` 全綠

## M2 Round A 完成度

- [x] **e2e 穩定化**:`scripts/e2e-gateway.mjs` 步驟 5(deny)、步驟 6(逾時)
      改為各自建立獨立、測完即刪除的 session,不再與步驟 3/4 共用 —— 修復
      「權限測試依賴真實模型在 deny 後的行為,一步拖過時間預算就連鎖污染
      後續步驟」的 flake 根因;步驟 5 的時間預算由 120s 提高到 180s。
- [x] **AdapterRegistry**(`packages/adapters/src/registry.ts`):以
      `AgentProfile.software` 為 key 註冊/查找 `AgentAdapter` 實例。
      `SessionManager` 建構子改收 `AdapterRegistry` 而非單一 adapter,
      `createSession()` 依 profile 動態選 adapter,並把選定的 adapter 記在
      該 session 的 runtime state,後續 `sendPrompt`/`interrupt`/
      `resolvePermission`/`dispose` 都用它。`apps/core/src/index.ts` 註冊了
      `claude-agent-sdk` → `ClaudeAgentSdkAdapter`、`acp` → `AcpAdapter`
      兩個 adapter。
- [x] **AcpAdapter**(`packages/adapters/src/acp-adapter.ts`):基於官方
      `@agentclientprotocol/sdk`(v1.2.1)的 ACP client 端 API 對接 ——
      `spawn()` 依 `AgentProfile.acpConfig` 啟動子程序、經 stdio(ndJSON)
      建立連線、走 `initialize` → `session/new`;`sendPrompt()` 對應
      `session/prompt`;ACP 的 `session/update` 通知(`agent_message_chunk`
      / `tool_call` / `tool_call_update`)轉成既有的 `message-delta` /
      `tool-call` / `tool-result` AgentEvent;`session/request_permission`
      轉成 `permission-request` 事件並等待 `resolvePermission()`(語意對齊
      `ClaudeAgentSdkAdapter`);`interrupt()` 對應 `session/cancel`;
      `dispose()` 結束連線與子程序,懸置的權限請求一律以拒絕收場。
      `capabilities()` 如實回報(`diff: false`,尚未解析 ACP 的 diff 內容;
      `fs`/`terminal` 能力未開放)。
- [x] `packages/shared`:`AgentProfile` 新增 `acpConfig`
      (`command`/`args`/`env`)欄位,`software="acp"` 時 `acpConfig.command`
      為必填(zod `superRefine` 校驗)。
- [x] **`scripts/fake-acp-agent.mjs`**:用 ACP 的 agent 端建構器 API 實作的
      最小 ACP agent,e2e 步驟 9 用它建立 `software="acp"` 的 profile +
      session,驗證串流事件轉換與權限 allow/deny 兩條路徑 —— 全程不依賴
      任何真實模型,完全決定性。
- [x] `apps/desktop`:僅做維持 typecheck 通過所需的最小調整(`AgentProfile`
      型別新增的 `acpConfig` 為 optional 欄位,不影響既有 UI);能力降級
      UI(依 adapter capabilities 決定顯示豐富聊天串流或原始終端)留給
      Round B。
- [x] `pnpm -r run typecheck`、`pnpm -r run build` 全綠;
      `node scripts/e2e-gateway.mjs` 反覆執行多次,新增的步驟 9(ACP)全部
      決定性 PASS,既有步驟見下方已知限制的 flake 說明。

## M2 Round B 完成度

- [x] **Windows `.cmd` spawn bug 修復**(任務 1,`packages/adapters/src/acp-adapter.ts`
      的 `resolveWindowsSpawnCommand()`):改成先看副檔名(`.cmd`/`.bat` →
      `shell: true` + `quoteWindowsShellArg()` 手動 quoting;`.ps1` → 改叫
      `powershell.exe -File`;`.exe`/絕對路徑無副檔名 → 不用 shell),不再讓
      「是否為絕對路徑」蓋過副檔名判斷。已用暫存 `.cmd` wrapper(路徑刻意含
      空白)重現修復前的 `EINVAL` 並驗證修復(e2e 步驟 11)。
- [x] **`GenericPtyAdapter`**(任務 2,`packages/adapters/src/pty-adapter.ts`):
      用 `node-pty` 對接任意互動式 CLI,`spawn()`/`sendPrompt()`(寫入 stdin
      附 `\r`)/`interrupt()`(送 `\x03`)/`dispose()`(kill process tree)/
      `capabilities()`(`streaming/toolEvents/permissionRequests/diff` 全
      false,`interrupt/terminal` true)。node-pty 在本機透過官方 prebuilt
      二進位安裝成功,不需要 MSVC build tools,未實作 child_process 降級版本
      (見上方「node-pty 安裝結果」)。
- [x] `packages/shared`:`AgentSoftware` 早已含 `"pty"`(M2 Round A 就預留);
      `AgentProfile` 新增 `ptyConfig`(`command`/`args`/`env`/`cols`/`rows`),
      `software="pty"` 時 `ptyConfig.command` 為必填(zod `superRefine`,與
      `acpConfig` 共用同一個校驗函式 `refineAgentProfileConfig`)。
      `events.ts` 新增 `terminal-data` 事件(UTF-8 字串,見上方編碼選擇說明)。
      新增 `adapter-capabilities.ts`:`AdapterCapabilities` 從
      `packages/adapters` 搬成 zod schema,`terminal` 欄位讓既有 adapter 也
      補上(`ClaudeAgentSdkAdapter`/`AcpAdapter` 皆為 `false`)。
- [x] `apps/core`:registry 註冊 `"pty"` → `GenericPtyAdapter`;
      `SessionManager` 對 `terminal-data` 事件不逐筆持久化,只透過既有的
      `session-event` 頻道直通轉發;新增 `PTY_IDLE_TIMEOUT_MS`(800ms)靜止
      計時器簡化 pty session 的 busy/idle 判斷(見上方設計決策說明);新增
      `getCapabilities(software)`,`WsGateway` 曝露成 `adapter.capabilities`
      方法。
- [x] `apps/desktop`:安裝 `@xterm/xterm` + `@xterm/addon-fit`;新增
      `SessionView.tsx`(依 capabilities 決定渲染 `ChatView` 或新增的
      `TerminalView.tsx`)、`ProfileCreateDialog.tsx`(選 software:
      claude-agent-sdk/acp/pty,acp/pty 填 command/args,走既有
      `profile.create`);`SessionList.tsx` 新增 profile 下拉選單,建立
      session 時可選擇要用哪個 profile。維持既有深色 IDE 風格與繁中文案。
- [x] `pnpm install`(含三個新依賴)、`pnpm -r run typecheck`、
      `pnpm -r run build`(含 vite build)全綠;`node scripts/e2e-gateway.mjs`
      新增步驟 10(pty,5 個子步驟)、步驟 11(`.cmd` 修復迴歸測試)反覆執行
      皆 100% 決定性 PASS,既有 17 項不變(步驟 5 仍是既有已知的模型行為
      flake,見下方說明),結束後無殘留 process。

## M3 Round A 完成度

M3 Round A 的範圍是「團隊管理 + agent 互傳訊息的核心機制」(ARCHITECTURE.md
第 4 節);**群聊 UI 留給 Round B**,這輪只確保 gateway 協議與推播就緒。

- [x] **資料層落地**(`packages/db/src/schema.ts`、`packages/db/src/client.ts`):
      新增 `teams`、`team_members`、`team_messages` 三張表;`agent_profiles`
      也落地成資料表,取代 M1 的純記憶體 `ProfileStore`(README 已知限制
      「profile 僅記憶體」自此解除)—— `ProfileStore`(`apps/core/src/profiles.ts`)
      對外介面維持 `list()`/`get()`/`create()` 不變,只是改成 async,新增
      `ensureSeed()` 給啟動時的預設 profile 用(冪等,不會重複插入或覆寫)。
- [x] **`packages/shared`**:新增 `team.ts`(`Team`/`TeamMember`/`TeamMessage`
      的 zod schema,`TeamMember` 引用 `AgentProfile.id`,額外帶 `role` 字串
      與 `canInterrupt` 布林;`TeamMessage` 的 `to` 是成員名或 `"broadcast"`,
      `priority` 為 `"normal"|"interrupt"`,`source` 為 `"agent"|"human"`,
      另補了 `fromRole`/`note` 兩個可選欄位供注入格式化與降級標註使用)、
      `team-bus.ts`(`TeamBusPort` 介面,見下方「關鍵設計決策」)。
      `gateway.ts` 新增 `team.create`/`team.list`/`team.addMember`/
      `team.removeMember`/`team.messages`/`message.send` 六個方法,
      `ServerPushSchema` 新增 `"team-message"` channel;`session.ts` 的
      `CreateSessionInputSchema` 新增選填的 `teamMemberId`。
- [x] **`MessageBus`**(`apps/core/src/bus/message-bus.ts`,ARCHITECTURE.md
      4.2 節投遞策略的實作):收訊 → 持久化到 `team_messages` → `emit`
      `"team-message"`(`WsGateway` 訂閱後推播給所有 client)→ 依目標成員
      session 狀態決定投遞 —— idle 立即注入、busy 進 Mailbox 排隊並在回合
      `completed` 轉 idle 後批次合併成單一 prompt 注入、無活躍 session 留在
      Mailbox 並在該成員 session 建立後自動補投(監聽 `SessionManager` 的
      `"member-session-ready"` 事件)。`priority="interrupt"` 只有發送者
      對應的 `TeamMember.canInterrupt` 為 `true` 才允許,否則自動降級為
      `normal` 並在 `TeamMessage.note` 標註(`resolvePriorityForSender()`
      同時服務 agent 端與人類插話,見下方設計決策)。
- [x] **`TeamManager`**(`apps/core/src/team/team-manager.ts`):team/team
      member 的 CRUD,`name` 在同一個 team 內強制唯一(`addMember()` 會檢查
      撞名並拒絕)。
- [x] **team-bus MCP server**(`packages/adapters/src/team-bus-mcp.ts` +
      `claude-sdk-adapter.ts` 掛載邏輯):`send_message(to, content,
      priority?)`、`broadcast(content, priority?)`、`list_teammates()`、
      `report_status(status, summary?)` 四個工具,用 SDK 的
      `createSdkMcpServer()`/`tool()`(讀取 `sdk.d.ts` 確認 API)在
      `ClaudeAgentSdkAdapter.spawn()` 收到 `TeamSpawnContext` 時掛載進
      `options.mcpServers`,並把四個工具的完整名稱(`mcp__team-bus__<tool>`)
      加進 `options.allowedTools`,讓這幾個純訊息傳遞的內部工具略過
      `canUseTool` 權限彈窗(e2e 實跑時 SDK 印出
      `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` 警告,確認了這個行為符合預期,不是
      錯誤)。只有隸屬於某個 team 的 session(`session.create` 帶
      `teamMemberId`)才會拿到 `TeamSpawnContext`;`AcpAdapter`/
      `GenericPtyAdapter` 這輪不掛 MCP,`spawn()` 忽略這個參數即可(TS 允許
      實作方法宣告比介面少的參數)。`list_teammates` 如實回報每個成員的
      `software`/`hasActiveSession`/`status`,ACP/PTY 成員一樣會被列出。
- [x] **`SessionManager`**(`apps/core/src/session/session-manager.ts`)、
      **`WsGateway`**(`apps/core/src/gateway/ws-gateway.ts`)、
      **`apps/core/src/index.ts`**:`createSession()` 支援 `teamMemberId`,
      建立 `TeamSpawnContext` 傳給 `adapter.spawn()`;新增
      `getSessionIdForMember()`/`getMemberIdForSession()` 供 `MessageBus`
      查詢,`setTeamBus()` 事後注入 `TeamBusPort`(見下方循環依賴的設計決策)。
      `WsGateway` 新增 team.*/message.send 的 dispatch case,訂閱
      `MessageBus` 的 `"team-message"` 事件推播。`index.ts` 的建構順序:
      `ProfileStore` → `TeamManager` → `SessionManager` → `MessageBus` →
      `sessionManager.setTeamBus(messageBus)`。
- [x] `apps/desktop`:僅做維持 typecheck 通過所需的最小調整(型別變動皆為
      向下相容的新增欄位,不影響既有 UI);團隊群聊視圖留給 Round B。
- [x] **e2e**(`scripts/e2e-gateway.mjs`,詳見下方「端到端冒煙測試」):
      新增步驟 12(`MessageBus`,fake ACP agent,100% 決定性,6 個子步驟)、
      步驟 13(team-bus MCP 工具,真實模型,軟性判定比照步驟 5)。
      `scripts/fake-acp-agent.mjs` 新增 `delayEchoMarker()`/DELAY_ECHO
      標記(不影響既有步驟 9/11 的行為)。
- [x] `pnpm install`、`pnpm -r run typecheck`、`pnpm -r run build` 全綠;
      `node scripts/e2e-gateway.mjs` 本機反覆執行:新增的步驟 12(6 個子步驟)
      100% 決定性 PASS,步驟 13 兩次執行皆 PASS(模型確實呼叫了
      `send_message` 工具),既有 23 項不變(步驟 5 仍是既有已知的模型行為
      flake,其中一次執行觀察到,詳見下方 flake 說明),結束後以
      `tasklist`/`Get-Process` 確認無殘留 `node.exe`/`electron.exe`。

**M3 Round A 關鍵設計決策**
- **Mailbox 資料結構**:`MessageBus` 內部用 `Map<memberId, TeamMessage[]>`
  (純記憶體,不落地)當作每個成員的排隊佇列;訊息本身已經持久化在
  `team_messages`(所以 `team.messages` 歷史查詢不受 Mailbox 是否 flush
  影響),Mailbox 只負責記錄「這幾則訊息還沒被注入」。`flushMailbox()`
  在讀到佇列後立刻 `this.mailbox.delete(memberId)` 清空,才呼叫
  `sendPrompt()` 注入 —— 這是刻意的順序(先清空再注入),避免注入觸發的
  `session-updated` 事件在還沒拿到佇列快照前重入造成重複投遞。
- **注入 prompt 格式**:單則訊息 `"[降級標註] [廣播] 來自 @<發送者
  名>(<角色>)的訊息:<內容>"`(降級/廣播標註是可選前綴,不存在時省略);
  多則合併時外層再包一句「你收到 N 則隊友訊息(session 忙碌時累積,現在一次
  補上):」,逐條加編號列出。`fromRole` 存進 `TeamMessage` 記錄(而非僅在
  呼叫當下才查詢),是因為批次注入時佇列裡的訊息可能來自不同發送者,格式化
  當下不一定還查得到正確的 role。
- **循環依賴的打破方式**:`MessageBus` 建構子需要 `SessionManager`(查詢
  session 狀態、呼叫 `sendPrompt`/`interrupt`),但 `SessionManager.createSession()`
  也需要一個 `TeamBusPort` 實例傳給 `adapter.spawn()`。兩者互相依賴,用
  `sessionManager.setTeamBus(messageBus)` 在兩者都建構完成後事後注入
  打破循環(`apps/core/src/index.ts` 的建構順序見上方)。`SessionManager`
  不 import `MessageBus` 具體類別,只 import `TeamBusPort` 介面(來自
  `@deskmony/shared`),`packages/adapters` 同樣只依賴這個介面 —— 依賴方向
  規則(`packages/*` 不得 import `apps/*`)全程沒有被打破。
- **SDK MCP 掛載方式**:讀取 `node_modules/.pnpm/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`
  確認 `createSdkMcpServer({ name, tools })` 回傳
  `McpSdkServerConfigWithInstance`(`{ type: "sdk", name, instance }`),
  可以直接放進 `Options.mcpServers` 這個 record;`tool(name, description,
  zodRawShape, handler)` 建立單一工具,`handler` 回傳
  `Promise<CallToolResult>`。MCP 工具完整名稱是 `mcp__<server>__<tool>`
  (讀 `.d.ts` 對 `disallowedTools`/`toolAliases` 欄位的註解確認),
  `TEAM_BUS_TOOL_NAMES` 匯出給 `ClaudeAgentSdkAdapter` 組
  `options.allowedTools`。
- **人類插話與 agent 傳訊共用降級邏輯**:`resolvePriorityForSender(teamId,
  fromName, priority)` 依「`fromName` 是否對應這個 team 內一個
  `TeamMember`、且該成員 `canInterrupt` 為 `true`」判斷 ——
  agent 端(`sendMessage`/`broadcast`)一定有真實的 `fromMemberId` 可查,
  自然受這條規則約束;`message.send`(人類插話)預設 `fromName="Human"`
  查不到對應成員,直接放行(人類是最終決策者,ARCHITECTURE.md 第 10 節
  「人類永遠在迴路中」);但若 `fromName` 剛好與某個成員同名,仍套用同一套
  規則 —— 單一 source of truth,e2e 步驟 12d 就是用這個機制(`fromName:
  "Coder"`/`"Reviewer"`)在不需要真實模型的情況下決定性地測試降級邏輯。

## M3 Round B 完成度

M3 Round B 把 M3 Round A 留下的兩個待辦補齊:團隊管理 UI + 團隊群聊視圖
(ARCHITECTURE.md 3.1 節三種核心視圖之一)、以及 Round A review 指出的
interrupt 投遞時序 race。

- [x] **任務 1:團隊管理 UI**(`apps/desktop/src/stores/team-store.ts`、
      `apps/desktop/src/views/TeamManagementDialog.tsx`):新增獨立於
      `session-store` 的 `team-store`,管理 `teams`/`messagesByTeam`/
      `teammatesByTeam` 狀態,呼叫既有 gateway 方法(`team.list`/
      `team.create`/`team.addMember`/`team.removeMember`/`team.messages`)
      + 這輪新增的 `team.teammates`(見下方)。`TeamManagementDialog` 對話框
      (延續 `ProfileCreateDialog` 的深色 IDE 彈窗風格):左側建立/切換
      team,右側顯示成員清單(名稱、角色、`canInterrupt` 標籤、software
      徽章、目前 session 狀態燈號)、加入成員表單(下拉選現有
      `AgentProfile`、填顯示名稱/角色、勾 `canInterrupt`)、每個成員的
      「移除」按鈕,以及尚無 session 的成員可直接點「建立 session」(呼叫
      `session-store` 既有的 `createSession()`,這輪擴充它多接受一個選填的
      `teamMemberId` 參數,對應到既有的 `CreateSessionInput.teamMemberId`)。
- [x] **新增 gateway 方法 `team.teammates`**(`packages/shared/src/gateway.ts`、
      `apps/core/src/gateway/ws-gateway.ts`):團隊管理 UI 需要顯示「成員目前
      session 狀態」,但 `Session`/`team.list` 的回應都沒有曝露
      session↔member 的對應關係(`SessionManager` 內部的 `memberSessions`/
      `sessionMembers` map 只在 core 記憶體內,不落地也不對外)。與其新增
      資料庫欄位或修改 `Session` schema(有跨版本 SQLite migration 風險,
      README 已知限制長年記錄「尚未導入 migration」),直接複用
      `MessageBus.listTeammates()`(M3 Round A 就已經實作,原本只給
      `list_teammates` MCP 工具內部呼叫,見 `apps/core/src/bus/message-bus.ts`)
      ——多開一個 gateway 入口給 UI(非 agent)呼叫同一份邏輯,不重複實作、
      不改資料層。`packages/shared/src/team-bus.ts` 的 `TeammateInfo` 因此從
      純 TS interface 改成 zod schema(`TeammateInfoSchema`),讓 UI 端能在
      runtime 驗證回應,比照這個檔案其他型別的既有慣例。
- [x] **任務 2:團隊群聊視圖**(`apps/desktop/src/views/TeamChatView.tsx`、
      `apps/desktop/src/App.tsx`):訂閱 `"team-message"` 推播即時顯示整個
      team 的訊息流(進入時先用 `team.messages` 載入歷史),每則訊息顯示
      `from`/`fromRole`/`to`(或「全體(廣播)」)/`content`/`priority`/
      `source`/`note` 降級標註/`timestamp`。訊息依 `source` 視覺區分
      (human 訊息靠右、accent 色系;agent 訊息靠左、中性色系),
      `priority="interrupt"` 且未被降級的訊息額外加紅色 ring 標示,`note`
      存在(被自動降級)時額外顯示黃色「已降級」標籤與系統標註文字。人類
      插話:輸入框可選收件對象(某成員或「[廣播] 全體」)、可選
      priority(一般/interrupt),送出走 `message.send`(對應
      `MessageBus.sendHumanMessage()`)。`App.tsx` 頂部新增 Session
      視圖/團隊群聊視圖的切換分頁(一般的 `useState`,不需要進 zustand ——
      純 UI 導覽狀態,不需跨元件持久化);無 team 時給空狀態畫面引導使用者
      建立團隊(內嵌開啟 `TeamManagementDialog`)。捲動:訊息陣列變動時
      `scrollTo` 捲到底部(沿用 `ChatView.tsx` 既有的做法);未做虛擬列表
      (任務描述列為非必要),目前規模下（一般 team 群聊訊息量遠小於單一
      session 的逐字元串流）足夠,大量訊息情境留給之後視需要優化。
- [x] **任務 3:interrupt 時序修正**(Round A review 待辦,`packages/adapters/src/types.ts`、
      `packages/adapters/src/claude-sdk-adapter.ts`、
      `packages/adapters/src/acp-adapter.ts`、
      `packages/adapters/src/pty-adapter.ts`、
      `apps/core/src/session/session-manager.ts`、
      `apps/core/src/bus/message-bus.ts`、
      `apps/core/src/gateway/ws-gateway.ts`):判斷結論是**確有 race,已用
      最小修正解決**(詳見下方「interrupt 時序修正結論」)。
- [x] **任務 4:e2e 新增步驟 14**(`scripts/e2e-gateway.mjs`,詳見上方「端到端
      冒煙測試」):真實 Claude SDK session、真的忙碌中送出 interrupt,拆成
      硬性(不依賴模型是否遵從指令)/軟性(依賴模型行為,已知 flake)兩組
      判定,共 8 個子步驟,本機反覆執行 2 次,三個硬性子步驟(14c/14d/14e)
      皆 100% PASS。
- [x] `pnpm install`(本輪未新增前端依賴)、`pnpm -r run typecheck`、
      `pnpm -r run build` 全綠;`node scripts/e2e-gateway.mjs` 反覆執行,總
      項目數由 31 增為 39,既有 31 項不受影響(步驟 5 仍是既有已知 flake),
      新增步驟 14 的硬性子步驟 100% 決定性 PASS、軟性子步驟(14g)與步驟 13
      同屬已知模型行為 flake,結束後無殘留 `node.exe`/`electron.exe`。

**M3 Round B 關鍵設計決策:團隊群聊視圖狀態管理**

- `team-store.ts` 是一個獨立於 `session-store.ts` 的 zustand store(不是把
  team 相關欄位塞進既有的 `SessionStoreState`)——两者管理的是不同的資料
  維度:`session-store` 管單一 session 的聊天時間軸,`team-store` 管整個
  team 的成員清單與群聊訊息流,狀態形狀差異夠大,合併只會讓兩個 store 都
  變得難以理解。兩者共用同一條 WS 連線:`session-store.ts` 把原本模組層級
  私有的 `client`(`GatewayClient` 實例)改成 `export`,`team-store.ts`
  直接 import 它、各自呼叫 `client.onPush()` 訂閱(`pushListeners` 是
  `Set`,多個訂閱者互不干擾)——沒有理由為了狀態隔離而開兩條 WS 連線,那只會
  徒增重連/事件去重的複雜度。
- `team-store` 的 `init()` 是冪等的(`initialized` 旗標),由 `App.tsx` 在
  `useEffect` 內與既有 `session-store.connect()` 一起呼叫一次;訊息推播
  (`"team-message"`)以 `TeamMessage.id` 去重後 append 進
  `messagesByTeam[teamId]`,`sendTeamMessage()` 本身**不**手動把送出的訊息
  塞進 state(刻意的設計,見 `team-store.ts` 內註解)——`persistAndPush()`
  在 `apps/core/src/bus/message-bus.ts` 是先 `emit("team-message")` 再决定
  投遞方式,同一條 WS 連線上推播訊息幾乎必定先於 `message.send` 的 RPC
  回應抵達,若同時手動塞一次會造成競態下的重複或順序錯亂風險,依賴單一
  source of truth(推播)反而更簡單可靠。
- 成員目前 session 狀態(`teammatesByTeam`)不是靠 polling,而是在
  `team-store.init()` 訂閱 `client.onPush()` 時,對 `"session-updated"`/
  `"session-list-updated"` 這兩個既有頻道(`session-store.ts` 早已在用)
  額外掛一個處理:只要目前正在檢視的 team(`currentTeamId`)有任何 session
  變動,就重新呼叫 `team.teammates` 刷新——近乎即時,且不需要新增輪詢邏輯
  或 WS 頻道。

**interrupt 時序修正結論**

- **判斷結論:確有 race**。讀取 `node_modules` 內
  `@anthropic-ai/claude-agent-sdk` 的 `sdk.d.ts` 確認 `Query.interrupt()`
  的型別是 `Promise<SDKControlInterruptResponse | undefined>`,官方註解明載
  「The query will stop processing and return control to the caller」——
  也就是這個 Promise **resolve 的時間點才代表中斷真正生效、控制權交還**,
  不是呼叫當下就同步生效。修正前 `ClaudeAgentSdkAdapter.interrupt()` 是
  `void internal.sdkQuery.interrupt()`(fire-and-forget,不等待這個
  Promise),`apps/core/src/bus/message-bus.ts` 的
  `MessageBus.deliverToMember()` 又是「呼叫 `sessionManager.interrupt()`
  後不 await,緊接著就 `await this.inject(...)`」——兩層都不等待,意味著
  「注入下一個 prompt」這個動作,理論上可能發生在 SDK 尚未真正處理完中斷、
  上一輪回合都還沒真正停下來的時候,存在時序上的競爭窗口。
- **最小修正**(不改變投遞策略、不改變格式化邏輯,只修正等待時序,對應
  任務描述「不要過度設計」的要求):讓 `interrupt()` 這條呼叫鏈全程回傳
  `Promise<void>` 並逐層 `await`——`AgentAdapter.interrupt()` 介面
  (`packages/adapters/src/types.ts`)簽章從 `void` 改成 `Promise<void>`;
  `ClaudeAgentSdkAdapter.interrupt()` 改成 `async` 並 `await
  internal.sdkQuery.interrupt()`(讓「中斷確實生效」的保證真正往外傳遞);
  `AcpAdapter.interrupt()`/`GenericPtyAdapter.interrupt()` 也一併改成
  `async`(ACP 的 `session/cancel` 是單向 notification,協議本身沒有回條,
  只能盡力而為 await 送出動作本身完成;pty 的 `write()` 本來就是同步呼叫,
  改 async 純粹是滿足介面簽章,語意不變 —— 這兩個 adapter 的說明見各自檔案
  內的程式碼註解,誠實記錄了「能做到多少保證」的差異);
  `SessionManager.interrupt()` 改成 `async` 並 `await
  runtime.adapter.interrupt(...)`;`MessageBus.deliverToMember()` 的
  interrupt 分支改成 `await this.sessionManager.interrupt(sessionId)` 再
  `await this.inject(...)`;`WsGateway` 的 `"session.interrupt"` case
  (人類直接按「中斷」按鈕的路徑)一併補上 `await`,讓所有呼叫路徑都受益於
  同一個修正,不是只修 MessageBus 這一條路。
- **為什麼這是「最小」修正,不是重新設計投遞策略**:race 的根因是「該等的
  地方沒有等」,不是投遞策略(idle 立即注入 / busy 排隊 / interrupt 中斷後
  注入)本身有問題——修正範圍刻意限縮在「把已經存在、SDK 官方文件明載語意
  的 `Promise` 串起來 await」,不新增任何額外的狀態機、輪詢、或重試邏輯。
  任務描述提到的另一個候選方案(「interrupt 後等待該 session 狀態回到可
  接收」)需要新增一個等待 session 狀態機轉換的迴圈,比直接 await SDK 官方
  提供、語意明確的 Promise 更間接、更容易因為狀態機本身的邊界情況(例如
  pty 沒有真正的「回合」概念)而不可靠,因此採用「adapter 的 interrupt 回傳
  Promise 並 await」這個方案。
- **e2e 驗證**(見上方「端到端冒煙測試」步驟 14):用真實、正在忙碌中的
  Claude SDK session 驗證修正後的路徑——本機反覆執行 2 次,三個硬性子步驟
  (14c 訊息未被降級、14d 訊息確實被注入 `session.history`、14e session
  最終回到 `idle` 沒有卡死)皆 100% PASS,佐證修正後的 await 鏈在真實忙碌
  session 上運作正常;軟性子步驟(14f 原任務確實被中斷、14g 後續回應提及
  注入內容)分別於 2 次執行中各出現 1 次 PASS/FAIL,屬模型行為層面的已知
  flake(如實記錄,detail 已標註),不影響硬性判定的結論。

## M4 Round A 完成度

M4 Round A 的範圍是「core 端 TaskService + git worktree 工作區隔離」
(ARCHITECTURE.md 3.3 節 TaskService/WorkspaceManager、第 5 節任務協作流程
狀態機、第 6 節資料模型);**任務看板 UI 留給 Round B**,這輪只確保資料層、
狀態機、gateway 協議與 worktree 隔離就緒。

- [x] **資料層**(`packages/db/src/schema.ts`、`packages/db/src/client.ts`):
      新增 `tasks`、`workspaces` 兩張表,沿用既有的 `CREATE TABLE IF NOT
      EXISTS` 自我修復策略(README 已知限制長年記錄「尚未導入
      drizzle-kit migration」,這輪不改變這個策略)。`tasks` 除了任務描述
      列出的欄位(`id`/`teamId`/`title`/`description`/`status`/
      `assigneeMemberId`/`workspaceId`/`createdAt`/`updatedAt`)多了一個
      `blockedFrom`(見下方狀態機說明);`workspaces` 為
      `id`/`taskId`/`baseDir`/`worktreePath`/`branch`/`createdAt`。
- [x] **`packages/shared`**:新增 `task.ts`(`TaskStatusSchema` 七個狀態的
      zod enum、`Task`/`Workspace`/`CreateTaskInput`/`AssignTaskInput`/
      `UpdateTaskStatusInput` schema)。`gateway.ts` 新增
      `task.create`/`task.list`/`task.get`/`task.assign`/
      `task.updateStatus`/`task.delete` 六個方法,`ServerPushSchema` 新增
      `"task-updated"` channel;另外比照 M3 Round B「`team.teammates`」的
      先例新增 `message.reportStatus`(見下方「report_status↔task 整合」)。
      `team-bus.ts` 的 `TeamBusPort.reportStatus()` 輸入型別新增選填的
      `taskId`。
- [x] **`TaskService`**(`apps/core/src/tasks/task-service.ts`):任務 CRUD +
      狀態機,見下方「狀態機轉移表」。狀態變更一律經
      `db.update()` 持久化後 `emit("task-updated", task)`,`WsGateway` 訂閱
      後推播給所有 client。`assignTask()` 額外呼叫
      `WorkspaceManager.createWorkspaceForTask()` 建立 worktree、把
      `workspaceId` 寫回任務;`deleteTask()` 若任務已綁定 workspace,先呼叫
      `WorkspaceManager.removeWorkspace()` 清理 worktree(強制移除 + 刪除對應
      分支)才刪除任務本身。`tryApplyReportStatus()` 是 report_status 整合的
      落地位置,見下方。
- [x] **`WorkspaceManager`**(`apps/core/src/workspace/workspace-manager.ts`):
      git worktree 的建立與清理,見下方「worktree 佈局與命名」。一律用
      `execFile("git", [...])`(陣列參數,不組字串、不開 shell)呼叫 git,
      每次呼叫都收集 stderr 組成明確錯誤訊息;`baseDir`(= team.workingDir)
      不是 git repo 時,建立 worktree 前用 `git rev-parse
      --is-inside-work-tree` 檢查並丟出明確錯誤(不靜默失敗、不假裝指派
      成功),對應「team workingDir 需為 git repo 才能用任務 worktree 隔離」
      這個前提(見下方)。清理路徑(`removeWorkspace()`)對「worktree 目錄已被
      使用者手動刪除」這種情況做了冪等處理(`git worktree remove` 失敗時改跑
      `git worktree prune`,磁碟上路徑確實不存在才視為已清理成功,仍存在則
      原樣往外丟錯誤,不吞掉)。
- [x] **report_status↔task 整合**(`apps/core/src/bus/message-bus.ts` 的
      `reportStatus()`、`apps/core/src/tasks/task-service.ts` 的
      `tryApplyReportStatus()`、`packages/adapters/src/team-bus-mcp.ts` 的
      `report_status` 工具新增 `taskId` 選填參數):`report_status` 工具原本
      (M3)只寫 `team_messages`;這輪保持向後相容(不帶 `taskId` 行為完全
      不變),帶 `taskId` 時嘗試依「該成員是否為此任務的指派人」+「`status`
      自由文字是否對映得到 `TaskStatus`」+「對映到的目標是否為合法狀態轉換」
      三個條件同步任務狀態,任一條件不成立都只記錄訊息、不拋錯誤、不改任務
      狀態(`report_status` 語意上是「盡力而為的狀態同步」,不應該因為任務
      狀態機的限制讓這個純訊息回報工具本身失敗)。結果會文字化附加在這則
      `team_messages` 訊息內容裡(「(任務狀態已同步: X → Y)」或「(任務狀態未
      同步: 原因)」),團隊群聊視圖之後也看得到。
- [x] **新增 gateway 方法 `message.reportStatus`**(`packages/shared/src/gateway.ts`、
      `apps/core/src/gateway/ws-gateway.ts`):`MessageBus.reportStatus()`
      原本只給 team-bus 的 `report_status` MCP 工具呼叫,只有 `software=
      "claude-agent-sdk"` 的成員能透過工具呼叫觸發(ACP/PTY 成員完全沒有
      回報狀態的管道,這是 M3 就存在、這輪才被 report_status↔task 整合放大
      重要性的既有落差)。比照 M3 Round B「`team.teammates`」的先例(多開
      一個 gateway 入口給非 agent 呼叫端使用同一份既有邏輯,不重複實作),
      這個方法讓任何呼叫端(未來的 UI、或這輪 e2e 步驟 15d)可以代表一個已知
      的 team member 回報狀態,走的是與 MCP 工具完全相同的實作路徑。
- [x] **e2e 新增步驟 15**(`scripts/e2e-gateway.mjs`,詳見下方「端到端冒煙
      測試」與「e2e 步驟 15 設計說明」):100% 決定性,用真實 git 子程序 +
      真實的 team/task/member,全程不建立任何 agent session、不叫任何真實
      模型或 fake agent。5 個子步驟(15a-15e)。
- [x] `apps/desktop`:未做任何變更 —— `GatewayClient.call<M>()`
      (`apps/desktop/src/lib/gateway-client.ts`)是依 `ClientRequestMethod`
      泛型推導 params/result 型別的通用包裝,新增的 gateway 方法自動被涵蓋,
      不需要逐一補 case;desktop 沒有任何程式碼引用這輪新增的型別,
      `pnpm -r run typecheck`/`pnpm -r run build` 全綠不需要额外調整。任務
      看板 UI 本身留給 Round B。
- [x] `pnpm install`(本輪未新增任何相依套件)、`pnpm -r run typecheck`、
      `pnpm -r run build` 全綠;`node scripts/e2e-gateway.mjs` 本機執行 2
      次:第 1 次發現步驟 15b 的判斷式有 bug(Windows 上 `git worktree list
      --porcelain` 一律輸出正斜線路徑,但比對用的 `worktreePath` 是
      `path.join()` 產生、Windows 上會是反斜線,字串比對永遠比不到——worktree
      實際上建立成功、`git` 也認得,純粹是 e2e 腳本自己的路徑分隔字元沒有
      正規化,不是 `WorkspaceManager` 的 bug),修正後第 2 次執行 44/44 全
      PASS(含步驟 15 全部 5 個子步驟)。既有 39 項不受影響,詳見下方「端到
      端冒煙測試」與「建置與型別檢查」章節的完整執行紀錄。

**worktree 佈局與命名(設計決策)**

worktree 一律建在 `baseDir`(= `team.workingDir`)的**同層目錄**下一個統一的
`.deskmony-worktrees/` 資料夾裡:

```
<dirname(baseDir)>/.deskmony-worktrees/<basename(baseDir)>-task-<shortId>/
```

分支命名:`deskmony/task-<shortId>`(`shortId` = `task.id`(uuid)去掉連字號後
的前 8 碼)。選「baseDir 旁邊」而不是「baseDir 內部」或「系統暫存目錄」的
原因:放在 repo 內部容易被使用者的 `.gitignore`/IDE 檔案監控意外掃到,語意上
也怪;系統暫存目錄可能被系統清理策略定期清空,而任務 worktree 應該要在任務
完成前持續存在;「baseDir 旁邊」在檔案總管裡容易被看到、找到,又不會弄髒
repo 本身,是這兩者間的折衷。`basename(baseDir)` 前綴是為了同一台機器上有多個
不同 repo 的 team 時,各自的 worktree 資料夾不會撞在同一個
`.deskmony-worktrees/` 下混在一起難以分辨屬於哪個專案。完整理由見
`apps/core/src/workspace/workspace-manager.ts` 檔案頂端註解。

**狀態機轉移表**

```
backlog      → assigned                (指派時觸發 WorkspaceManager 建立 worktree)
assigned     → in-progress
in-progress  → review
review       → in-progress             (退回)
review       → merging
merging      → done
(backlog|assigned|in-progress|review|merging) → blocked
blocked      → <task.blockedFrom>      (回到進入 blocked 前的狀態)
```

`TaskService` 內的 `isValidTransition()` 是唯一允許改變 `status` 的判斷式,
不在表列的組合一律丟出明確錯誤(`不合法的任務狀態轉換: X → Y`),e2e 步驟
15c 有驗證一個非法跳轉(`assigned → done`,跳過中間狀態)確實被拒絕。`blocked`
比 ARCHITECTURE.md 第 5 節 mermaid 圖描述的更寬:圖上只畫了
`InProgress <-> Blocked`,但這輪任務描述明確要求「任意狀態 → blocked → 回
原狀態」,所以 `backlog`/`assigned`/`in-progress`/`review`/`merging` 這五個
非終態都能進 `blocked`(`done` 是終態、`blocked` 本身不能再進 `blocked`)。
「回原狀態」不能假設固定回到 `in-progress`——`Task` 因此多了一個
ARCHITECTURE.md ERD 沒有列出的欄位 `blockedFrom`,只有 `status === "blocked"`
時有意義,記錄進入 `blocked` 前的狀態,離開 `blocked` 時只允許轉到這個記錄
的狀態。

另外刻意的設計決策:worktree **不會**在任務進入 `done` 時自動清理(狀態轉換
本身合法,但 `updateStatus()` 不會連動呼叫 `WorkspaceManager`)——讓已完成的
任務仍保留 worktree,供人類事後用 3.1 節提到的 Diff 檢視器(Round B 才會真的
接上)檢視這個任務改了什麼;只有明確呼叫 `task.delete` 才會觸發清理
(`git worktree remove --force` + 刪除對應分支)。

**report_status↔task 映射表**

```
backlog / assigned / in-progress / in_progress / inprogress → 對應同名狀態
review / reviewing / in-review                              → review
merging / merge                                              → merging
done / completed / complete / finished                       → done
blocked / block                                               → blocked
```

查不到的自由文字(例如 `"still writing tests"`)一律視為「無法對映」,只記錄
訊息、不改任務狀態——`report_status` 的 `status` 欄位本來就是 agent 自由
填寫的敘述性文字,不做模糊比對。即使對映得到,還要滿足「回報者是該任務的
指派人」與「是合法的狀態轉換」兩個條件才會真的更新;三個條件的判斷與跳過
理由全部在 `apps/core/src/tasks/task-service.ts` 的 `tryApplyReportStatus()`
完整記錄,e2e 步驟 15d 逐一驗證了四種情境(對映成功且合法轉換 / 對映不到 /
回報者不是指派人 / 不帶 taskId 向下相容)。

> **M4 Round B 補充**:上表的 `done`/`completed`/`complete`/`finished` 這幾個
> 別名沒有被拿掉,但 `tryApplyReportStatus()` 這輪新增一道把關:對映結果是
> `"done"` 時一律回傳「未同步」,無論回報者是不是指派人、無論目前是什麼
> 狀態——`"done"` 只能由人類透過 `task.merge` 觸發真正的 git 合併後才會轉換,
> agent 沒有任何管道(`report_status` 或委派給它的 `request_review`)能自己
> 把任務標記完成。完整設計理由見上方「M4 Round B 完成度」與
> ARCHITECTURE.md 5.2 節,e2e 步驟 16d 驗證了這個把關點。

**team workingDir 需為 git repo 才能用任務 worktree 隔離**

`task.assign` 會呼叫 `WorkspaceManager.createWorkspaceForTask()`,建立
worktree 前會先確認 `team.workingDir` 是一個合法的 git 目錄
(`git rev-parse --is-inside-work-tree`);不是的話會丟出明確錯誤(訊息內容
包含「需要先在該目錄 \`git init\`」的提示),`task.assign` 這個 RPC 呼叫會
以 `ok:false` 收場,任務狀態維持在 `backlog` 不變(不會出現「指派成功但沒有
worktree」這種不一致狀態)。

## M4 Round B 完成度

M4 Round B 把 M4 Round A 留下的三個缺口補齊:Review 合併流程(真正的 git
merge)、`request_review` MCP 工具、任務看板 UI。

- [x] **任務 1:Review 合併流程**:
  - `WorkspaceManager.mergeWorkspace(workspace)`(`apps/core/src/workspace/workspace-manager.ts`):
    在 `baseDir` 這個 worktree 上對 `workspace.branch` 執行
    `git merge --no-ff <branch> -m <message>`。**主幹分支動態偵測**
    (`detectMainBranch()`,不寫死 `master`):優先讀 `git symbolic-ref
    refs/remotes/origin/HEAD`,失敗則依序檢查本機 `main`/`master` 分支是否
    存在,都找不到才丟出明確錯誤。合併前要求 `baseDir` 乾淨
    (`git status --porcelain` 無輸出)才進行,避免弄丟使用者在主幹上還沒
    commit 的工作。**衝突處理**:合併失敗時用 `git status --porcelain` 抓出
    真正處於「未合併」狀態的檔案清單,呼叫 `git merge --abort` 還原
    `baseDir` 到合併前狀態,把衝突檔案清單包進新增的 `MergeConflictError`
    往外丟——不留下半完成的合併狀態。全程 `execFile("git", [...])` 陣列
    參數。
  - `TaskService.mergeAndComplete(taskId)`:要求現狀必須是 `merging`,呼叫
    `mergeWorkspace()` 成功才呼叫既有的 `updateStatus(taskId, "done")`;
    合併失敗(衝突或其他錯誤)原樣往外拋,任務狀態維持在 `merging`,不 emit
    任何 `task-updated`。gateway 新增 `task.merge` 方法
    (`packages/shared/src/gateway.ts`、`apps/core/src/gateway/ws-gateway.ts`),
    這是**整個系統裡唯一真正觸發 `git merge` 的入口**,只由人類從任務看板
    UI 觸發(見下方「人類批准合併」)。
  - **agent 無法自行合併到 done 的把關點**:`TaskService.tryApplyReportStatus()`
    (`report_status`/`request_review` 唯一的落地邏輯)新增檢查——對映結果
    是 `"done"` 一律回傳「未同步」,不呼叫 `updateStatus()`。`REPORT_STATUS_ALIASES`
    本身仍保留 `"done"` 等別名不變,把關刻意放在套用階段。
  - `WorkspaceManager.removeWorkspace()` 新增刪除前檢查:`--force` 移除
    worktree 之前先用 `git status --porcelain` 檢查是否有未 commit 的變更,
    回傳 `hadUncommittedChanges` 旗標(**不阻擋刪除**,純粹供上層/UI 事後
    警告)。`TaskService.deleteTask()` 回傳型別從 `Promise<void>` 改成
    `Promise<{ hadUncommittedChanges: boolean }>`,`task.delete` gateway
    回應多帶這個欄位(`TaskDeleteResultSchema`)。
  - 新增 `"task-deleted"` server push channel(`TaskService.deleteTask()`
    這輪補上 `emit`)——`"task-updated"` 只在任務仍然存在、欄位變更時觸發,
    刪除是另一種語意,看板 UI 需要明確訊號才能把已刪除的任務從畫面移除。
  - 新增 `workspace.get` gateway 方法(查詢單一 workspace,任務看板 UI 顯示
    分支名稱用),`WsGateway` 建構子因此多收一個 `WorkspaceManager` 參數。
- [x] **任務 2:`request_review` MCP 工具**(ARCHITECTURE.md 4.1 節列出、
      M3/M4 Round A 都記錄「這輪先不做」的那個工具):
  - `TeamBusPort`(`packages/shared/src/team-bus.ts`)新增 `requestReview()`
    方法與 `RequestReviewOutcome` 型別(擴充 `TeamBusSendOutcome`)。
  - `MessageBus.requestReview()`(`apps/core/src/bus/message-bus.ts`):語意
    等同 `report_status(status: "review", taskId)` + `send_message(to:
    <reviewer>, "請審查...")` 的組合,直接複用既有的 `tryApplyReportStatus()`
    /`persistAndPush()`/`deliverToMember()`,固定 `priority: "normal"`,訊息
    內容附上任務標題與分支(新增 `TaskService.getTaskBranch()` 查詢)。
  - `packages/adapters/src/team-bus-mcp.ts` 新增 `request_review` MCP 工具,
    對接方式與既有四個工具一致,`TEAM_BUS_TOOL_LOCAL_NAMES` 加入
    `"request_review"`。
  - gateway 新增 `message.requestReview` 方法(比照 `message.reportStatus`
    的先例),讓 UI 與不依賴真實模型的 e2e 決定性測試也能走同一段實作。
  - 向後相容,不影響既有工具與其行為。
- [x] **任務 3:任務看板 UI**(ARCHITECTURE.md 3.1 節第三種核心視圖):
  - `apps/desktop/src/stores/task-store.ts`:新增獨立於 `session-store`/
    `team-store` 的 zustand store,管理 `tasksByTeam`/`workspacesById`,訂閱
    `"task-updated"`/`"task-deleted"` 推播即時更新,呼叫 `task.list`/
    `task.create`/`task.assign`/`task.updateStatus`/`task.merge`/
    `task.delete`/`workspace.get`。
  - `apps/desktop/src/views/TaskBoardView.tsx`:欄位 Backlog / Assigned /
    In-Progress / Review / Merging / Done,`blocked` 用獨立區塊呈現(卡片
    標示 `blockedFrom`)。每張卡片顯示 assignee、workspace 分支、更新時間。
    操作一律用按鈕(只提供 `isValidTransition()` 允許的轉換,不做拖拉):
    backlog 可指派(選成員,觸發 `task.assign`)、assigned 可「開始」、
    in-progress 可「送審」、review 可「退回」或「通過,進入合併」、merging
    可「批准合併」(彈出確認對話框顯示分支名稱,呼叫 `task.merge`,失敗時
    顯示 core 回傳的錯誤訊息含衝突檔案清單)、任何可打斷的狀態可「封鎖」、
    blocked 可「解除封鎖」回到 `blockedFrom`。刪除任務一律先確認,刪除完成
    後若 `hadUncommittedChanges` 為 `true` 額外顯示警告橫幅。風格延續既有
    深色 IDE 風、繁中文案,與 `TeamChatView`/`TeamManagementDialog` 一致
    (共用同一個 `TeamManagementDialog` 建立團隊/成員)。
  - `App.tsx` 新增第三個分頁「任務看板」(Session 視圖 ↔ 團隊群聊 ↔ 任務
    看板三者切換)。
- [x] **e2e 新增步驟 16**(`scripts/e2e-gateway.mjs`,詳見下方「端到端冒煙
      測試」):100% 決定性,用真實 git 子程序 + 真實的 team/task/member,
      全程不建立任何 agent session、不叫任何真實模型或 fake agent。
  - 16(前置):git repo(明確指定 `main` 分支,避免依賴機器的
    `init.defaultBranch` 設定)+ team + Coder/Reviewer 兩個成員。
  - 16a:合併成功路徑——assign 後在 worktree 實際 commit 一個檔案 → 推進到
    review → merging → `task.merge` → 斷言任務變 `done`、baseDir 的
    `git log --oneline --all` 看得到這個 commit、`git branch --merged`
    確認分支已合併。
  - 16b:合併衝突路徑(獨立暫存 repo)——baseDir 與 worktree 對同一檔案做
    衝突變更 → `task.merge` 應失敗(RPC reject)、任務留在 `merging`、
    baseDir 的 `git status --porcelain` 事後為空、無殘留 `.git/MERGE_HEAD`。
  - 16c:`request_review`(直接呼叫 `message.requestReview` gateway 方法,
    決定性——`ClaudeAgentSdkAdapter` 才會掛載 team-bus MCP,fake ACP agent
    呼叫不到真正的 MCP 工具,直接打 gateway 才是決定性且涵蓋同一段實作的
    正確做法)——斷言任務轉 `review`、reviewer 收到的訊息可從
    `team.messages` 查得到。
  - 16d:agent 不能自己合併到 done——任務推進到 `merging` 後,
    `message.reportStatus(status: "done", taskId)` 企圖繞過人類批准,斷言
    任務仍留在 `merging`,回應訊息說明需經 `task.merge`。
  - 16e:`task.delete` 的 `hadUncommittedChanges` 旗標——worktree 有未
    commit 的變更時回 `true`,乾淨的 worktree 回 `false`。
- [x] `pnpm install`(本輪未新增任何相依套件)、`pnpm -r run typecheck`、
      `pnpm -r run build` 全綠(含 `apps/desktop` 的 Vite production
      build)。`node scripts/e2e-gateway.mjs` 本機執行 2 次:第 1 次發現
      16a 的判斷式有 bug(`git branch --merged` 對「目前簽出在另一個
      worktree 裡的分支」用 `+ ` 前綴而非空白/`* `,e2e 腳本原本只去掉
      `*` 前綴,比對永遠比不到——分支實際上已經合併成功,不是
      `WorkspaceManager` 的 bug,純粹是 e2e 腳本自己的字串解析沒有涵蓋這個
      前綴),修正後第 2 次執行 **50/50 全 PASS**(既有 44 項 + 新增步驟 16
      的 6 個子步驟,含 16a/16b/16c/16d/16e 全部通過)。既有 44 項不受影響
      (步驟 5 這次沒有出現、其餘既有項目全數 PASS),結束後以 PowerShell
      `Get-Process` 確認無殘留 `node.exe`/`electron.exe`,並確認所有暫存
      git repo(含 16b 的獨立 conflict repo)與 `.deskmony-worktrees/` 都已
      被清理、不留殘留。

## M5 Round A 完成度

M5 Round A 的範圍是「e2e 套件體質整理 + Core 獨立部署 + 認證」
(ARCHITECTURE.md 3.2 節 Gateway、第 9 節路線圖 M5、第 10 節設計決策
1)——瀏覽器/手機 client 本身留給後續 round,這輪只確保 Gateway 協議、
安全預設、認證機制就緒。

- [x] **任務0:e2e 套件切分**(`scripts/e2e-gateway.mjs`):每個檢查點標記
      `deterministic`/`model-behavior`,支援 `--only=deterministic` /
      `--only=model-behavior`(預設兩組都跑),結束摘要分開統計,**結束碼只
      由 deterministic 組決定**。完整分類清單與各 model-behavior 項目的
      歸類理由見上方「端到端冒煙測試」章節開頭;既有檢查點一律沒有刪除或
      調弱,只是加了分類標記與分組執行的 `if (shouldRun(...))` 包裝。
- [x] **任務1:Core 獨立部署(headless)正式化**:新增根層級
      `pnpm start:core`(轉呼叫 `apps/core` 既有的 `pnpm start` →
      `node dist/index.js`);所有設定確認皆可經環境變數注入(見「環境變數」
      表格,含這輪新增的 `DESKMONY_BIND_HOST`/`DESKMONY_AUTH_TOKEN`)。
      **綁定位址安全預設**:`WsGateway.listen()` 新增必填的 `host` 參數,
      `apps/core/src/index.ts` 決定實際值(預設 `127.0.0.1`),`.env` 展開/
      log 一律不印出 token。啟動時印出綁定位址與認證啟用狀態的摘要(見上方
      「綁定位址安全預設」章節的範例輸出)。
- [x] **任務2:認證(token-based)**:`packages/shared/src/gateway.ts` 新增
      `auth` request(`{ token: string }`)與 `AuthResultSchema`;
      `apps/core/src/gateway/ws-gateway.ts` 的 `WsGateway` 新增可選建構子
      參數 `authToken`,每個連線維護 `{ authenticated, authTimer }` 狀態
      (`clients` 從 `Set<WebSocket>` 改成 `Map<WebSocket, ConnectionState>`),
      認證檢查寫在 `handleMessage()` 最前面且全程同步(不含任何 `await`),
      避免「認證訊息與緊接著的下一個請求幾乎同時抵達」時的競爭窗口(完整
      理由見該檔案類別頂端註解)。`broadcast()` 只推播給已認證的連線。
      `apps/core/src/index.ts` 新增 `validateBindSafety()`:對外綁定
      (非 `127.0.0.1`/`localhost`/`::1`)卻沒有 token 時直接
      `console.error` + `process.exit(1)` 拒絕啟動。**傳輸方式選「連線後
      第一則訊息」**(而非 `Sec-WebSocket-Protocol` 或 URL query
      string)——完整取捨見上方「認證(token-based)」章節,核心理由是避免
      token 進入 URL/log,同時讓所有語言/平台的 client 都能用完全一致的
      應用層訊息實作,不需要處理傳輸層 header 的特殊情況。
- [x] **桌面殼串接**:`electron/main.ts` 用 `crypto.randomUUID()` 產生
      token,設進 `process.env.DESKMONY_AUTH_TOKEN`(同時餵給 core 子程序的
      `env` 與 preload 讀到的 `process.env`);`electron/preload.ts` 新增
      曝露 `window.deskmony.authToken`;`GatewayClient`
      (`apps/desktop/src/lib/gateway-client.ts`)建構子新增可選
      `authToken`,WS 開啟後自動送出 `auth`,成功才回報連線狀態
      `"open"`——`session-store.ts`/`team-store.ts`/`task-store.ts` 完全
      不需要改動,既有「等 open 才呼叫」的慣例自然涵蓋認證這一步。
- [x] **任務3:e2e 擴充(deterministic 組,步驟17)**:全部確定性,不依賴
      任何真實模型。17a 驗證無 token 向下相容;17b 依序驗證未認證被拒/認證後
      正常/錯誤 token 被拒且連線關閉/逾時未認證連線被關閉四種情境;17c
      驗證對外綁定未設 token 時子程序以結束碼1失敗並印出明確錯誤;17d 驗證
      這支 e2e 腳本自身的 `GatewayClient`(手寫的最小 WS client 類別)支援
      帶 token 連線並正常完成代表性 RPC(`team.create`/`team.list`)。完整
      子步驟說明見上方「端到端冒煙測試」章節。
- [x] `pnpm install`、`pnpm -r run typecheck`、`pnpm -r run build`(含
      `apps/desktop` 的 Vite production build)全綠。
      `node scripts/e2e-gateway.mjs --only=deterministic`:實際執行中發現
      並修正兩個問題(皆與這輪改動直接相關,不是既有 regression)——
      (1) 步驟8(Electron 冒煙測試)原本比對 `stdout` 是否含
      `"listening on ws://localhost:<port>"`,但這輪 `WsGateway.listen()`
      改成印出實際綁定位址(`ws://127.0.0.1:<port>`),既有正則沒有同步更新
      導致誤判 FAIL;已修正比對字串。(2) 步驟17d 誤把 `team.list` 回傳的
      `TeamWithMembers[]` 當成巢狀 `{ team, members }[]` 存取
      `t.team.id`,實際上 `team` 欄位是攤平的,應為 `t.id`;已修正。兩處
      修正後,**`--only=deterministic` 本機連續執行 2 次皆 52/52 全
      PASS**(既有 44 項步驟1-16 的 deterministic 子步驟 + 步驟8 + 這輪
      新增的步驟17共7個子步驟),兩次執行後都確認無殘留
      `node.exe`/`electron.exe` process、無殘留暫存 git repo/worktree。
      另外額外執行一次預設模式(兩組都跑,不帶 `--only`):deterministic
      組 48 項中出現 1 項單獨 FAIL——步驟14b(等待 Worker 開始串流的 20
      秒逾時)這次逾時未觀察到任何 `message-delta`,連帶讓同一輪
      `interruptTimingSmokeTest()` 提早 `return`,少記錄了
      14c/14d/14e/14h 這 4 個子步驟(48 = 52 − 4);這是這支腳本從 M3
      Round B 就存在、寫死在原始碼裡的既有 20 秒逾時預算(這輪未變動這個
      數值),在該次執行當下的機器負載(前面已連續跑完 50 項、多個
      core/electron 子程序剛結束)下顯得偏緊,判斷屬於單次真實 API 延遲
      波動,不是這輪程式碼改動造成的 regression——同一支腳本、同一份
      程式碼在前後兩次乾淨的 `--only=deterministic` 執行皆 100% PASS
      (含 14a-14h 全數 8 個子步驟)。model-behavior 組(3b/5/13b)這次
      執行 3/3 全 PASS。`--only=model-behavior` 的分組執行邏輯已透過程式
      碼檢視(所有 `shouldRun("model-behavior")` 分支)與上述兩種模式的
      實際輸出交叉驗證,行為符合設計(僅略過純 model-behavior 專屬的獨立
      區塊,例如步驟5 整段、步驟13b 的實際 prompt 送出;3b/14f/14g 這類
      「附著在 deterministic 流程上的事後分析」不論 `--only` 為何都照常
      計算,只是被歸類進 model-behavior 統計組)。

## M5 Round B 完成度

M5 Round B 是 ARCHITECTURE.md 第 9 節路線圖的**最後一輪**:瀏覽器/行動裝置
client(任務1、任務2)+ 安全強化(任務3)+ e2e 擴充(任務4)。完整設計說明見
上方「瀏覽器/行動裝置 client(M5 Round B)」與「安全強化」兩節,這裡只記錄
完成清單與實際驗證輸出。

- [x] **任務1:Core 提供靜態網頁**:`apps/core/src/http/static-server.ts`
      新增 `createStaticRequestHandler()`,`apps/core/src/gateway/
      ws-gateway.ts` 的 `WsGateway.listen()` 改成先建立 `node:http` 的
      `Server`、把 `WebSocketServer` 用 `{ server }` 掛上去,同一個 port
      現在同時服務 WS 協議與這個新的靜態檔案 handler。目錄穿越三層防禦
      (反斜線/NUL 拒絕 → 虛擬絕對根目錄正規化 → 解析後路徑前綴檢查)、
      白名單副檔名 + SPA fallback 見上方「瀏覽器存取方式與安全界線」。
      `apps/core/src/index.ts` 新增 `DESKMONY_STATIC_DIR` 覆寫、啟動時印出
      瀏覽器 UI 位址與靜態目錄缺失警告。
- [x] **任務2:瀏覽器 client**:`apps/desktop/src/App.tsx` 用
      `Boolean(window.deskmony)` 分流 Electron/瀏覽器兩種場景;新增
      `apps/desktop/src/views/ConnectScreen.tsx`(連線畫面)、
      `apps/desktop/src/lib/connection-config.ts`(sessionStorage 存取 +
      預設同源位址);`apps/desktop/src/lib/gateway-client.ts` 的
      `GatewayClient` 新增 `configure()`(url/token 從 `readonly` 改
      可變)與獨立的 `probeGatewayConnection()`(探測用,分辨
      `GatewayAuthError`/`GatewayNetworkError` 兩種明確錯誤)。響應式:
      `SessionList` 窄螢幕下改 `fixed` overlay + 漢堡按鈕收合、`TerminalView`
      容器 `overflow-hidden` → `overflow-auto`、`App.tsx` 頂部列
      `flex-wrap`、根容器改用 `index.css` 新增的 `.app-shell`(`100dvh`
      + `@supports` fallback)。token 儲存於 `sessionStorage`(見上方
      「token 儲存取捨」),新增「登出」按鈕(清除 + 整頁重新整理)。
- [x] **任務3:安全強化**:`ws-gateway.ts` 的 token 比對改用
      `crypto.timingSafeEqual()`(`timingSafeTokenEqual()`,先比長度短路、
      長度相同時走常數時間比較,見上方「token 常數時間比較」的取捨說明);
      新增 `AuthRateLimiter` 類別做認證失敗 IP 層級 rate limiting(純記憶體
      `Map` + lazy sweep,見上方「認證失敗 rate limiting」)。兩者皆可用新增
      的環境變數調整(`DESKMONY_AUTH_RATE_LIMIT_MAX`/
      `DESKMONY_AUTH_RATE_LIMIT_COOLDOWN_MS`)。
- [x] **任務4:e2e 擴充(deterministic 組,步驟18)**:新增
      `staticServerAndSecuritySmokeTest()`,18a(HTTP 靜態服務 + 三種目錄
      穿越變體)/18b(同 port HTTP+WS 並存,WS 仍要求認證)/18c
      (timingSafeEqual 三種情況)/18d(rate limiting 完整流程:連續失敗達
      門檻 → 冷卻期內連正確 token 也被拒 → 冷卻期過後恢復)。完整子步驟
      說明見上方「端到端冒煙測試」章節。**既有 52 項 deterministic 檢查點
      沒有刪除或調弱任何一項**,純粹新增。
- [x] `pnpm install`(本輪未新增任何相依套件,靜態 server 用 `node:http`/
      `node:crypto` 皆為 Node 內建模組)、`pnpm -r run typecheck`、
      `pnpm -r run clean && pnpm -r run build`(含 `apps/desktop` 的 Vite
      production build)全綠。
      `node scripts/e2e-gateway.mjs --only=deterministic`:**62/62 全
      PASS**(既有 52 項 + 這輪新增步驟18的 10 個子步驟:
      18a-1/18a-2/18a-3×3/18b-1/18b-2/18c/18d-1/18d-2)。額外執行一次
      預設模式(兩組都跑,不帶 `--only`):deterministic 組同樣 **62/62 全
      PASS**;model-behavior 組 5 項中 4 項 PASS、僅步驟14g(既有已知 flake,
      模型這輪選擇不照字面回覆注入的確認碼)單獨 FAIL,detail 已標註屬
      已知 flake,不影響 deterministic 組結論與 `process.exitCode`(見上方
      「e2e 的殘留 flakiness」對這個既有 flake 的完整說明)。
      額外用 `pnpm start:core`(等效的 `node apps/core/dist/index.js`)手動
      啟動一次:`curl http://127.0.0.1:<port>/` 回 200 HTML;用
      `curl --path-as-is` 送出 `/../../package.json` 與
      URL 編碼變體皆回應 200 但內容是 `index.html`(SPA fallback,不含
      `package.json` 的內容特徵字串);用最小 WS client 對同一個 port 呼叫
      `profile.list` RPC 正常取得結果,驗證 HTTP 靜態服務與 WS 協議在同一個
      port 上確實互不干擾。結束後用 `ps`/`tasklist` 確認無殘留
      `node.exe`/`electron.exe` process,無殘留 `.deskmony-worktrees/` 或
      暫存 git repo。

## M5 Round C 完成度

M1~M5(Round A/B)完成後的小版本追加:UI 補完「刪除對話」與「對話中查看/
切換 model」這兩個 M1 Session 視圖一直缺的日常操作。完整設計說明見上方
ARCHITECTURE.md 3.4 節的對應備註,這裡記錄改動清單、SDK 換 model 能力的
調查結論、DB 遷移驗證方式與 e2e 實際輸出。

### 功能2:刪除對話(UI 補完)

後端(`session.delete` gateway 方法 + `SessionManager.deleteSession()`)在
這輪之前就已經完備,只差 UI 沒接:

- [x] `apps/desktop/src/stores/session-store.ts` 新增 `deleteSession(sessionId)`
      action:呼叫 `client.call("session.delete", { sessionId })`,成功後從
      本地 `sessions`/`itemsBySession` 移除;若刪的是 `currentSessionId`,改選
      剩餘 session 的第一個(並呼叫既有的 `selectSession()` 載入它的
      history)或設為 `null`。與 `"session-list-updated"` 推播的競態關係
      (為何不會打架/閃爍)見該 action 上方的程式碼註解。
- [x] `apps/desktop/src/views/SessionList.tsx` 每個 session 項目新增一個
      hover 才顯示的 ✕ 按鈕。原本的整列 `<button>`(選取用)改成外層
      `<div className="group">` + 兩個並列的 `<button>`(選取 / 刪除),避免
      HTML 不允許的 `<button>` 巢狀 `<button>`;刪除按鈕 `onClick` 內
      `stopPropagation()` 避免同時觸發選取,點擊後跳原生 `window.confirm()`
      二次確認(比照專案既有風格,這種低風險、影響範圍單一的操作不需要另外
      引入彈窗元件)。

### 3a:資料層——session 帶 model

- [x] `packages/shared/src/session.ts`:`SessionSchema` 新增
      `model: z.string().optional()`。
- [x] `packages/db/src/schema.ts`:`sessions` 表新增 `model: text("model")`
      (nullable)。
- [x] `packages/db/src/client.ts`:新增 `ensureSessionsModelColumn()`——啟動時
      用 `PRAGMA table_info(sessions)` 檢查有沒有 `model` 欄位,沒有就
      `ALTER TABLE sessions ADD COLUMN model TEXT`(包在 `try/catch`,欄位已
      存在時忽略,冪等)。`CREATE TABLE IF NOT EXISTS` 本身也同步加上
      `model TEXT`(讓全新 DB 一步到位),但那對「已存在的舊 DB」完全無效
      (`IF NOT EXISTS` 只判斷表本身是否存在),所以兩者都需要。
      **冪等性驗證方式**:寫了一個暫存腳本,手動建立一個「舊版 schema」的
      `sessions` 表(不含 `model` 欄位)+ 一筆既有資料,呼叫 `createDb()`
      後用 `PRAGMA table_info` 確認欄位已補上、既有資料的 `model` 是
      `NULL`(不會被動到);再呼叫第二次 `createDb()`(模擬 core 重啟)確認
      不會因為欄位已存在而丟例外;最後寫入一筆帶 `model` 值的新 row 確認
      欄位真的可用。四項全部通過。
- [x] `apps/core/src/session/session-manager.ts`:`createSession()` 把
      `model: profile.model` 存進 session row 與回傳的 `Session` 物件;
      `rowToSession()`/`sessionToRow()` 對應補上 `model` 欄位的轉換。

### 3b:SDK 換 model 能力調查與採用方案

**調查結論**(讀取 `node_modules` 內 `@anthropic-ai/claude-agent-sdk` 的
`sdk.d.ts` 後確認,不臆測):

- `Query` 物件(`query()` 的回傳值,`ClaudeAgentSdkAdapter` 一律以
  streaming input 模式使用它)提供 `setModel(model?: string):
  Promise<void>`,官方文件字面寫著:「Change the model used for subsequent
  responses. Only available in streaming input mode.」——`spawn()` 本來就
  一律用 `AsyncQueue` 當 `prompt`(streaming input),因此這個方法在任何
  時間點呼叫都合法。
- `Options.model?: string` 的官方註解直接舉例
  `'claude-sonnet-5'`、`'claude-opus-4-8'`、`'claude-fable-5'` 這幾個完整
  model ID(這也是 `KNOWN_CLAUDE_MODELS` 清單值的直接依據,見下方 3d);
  另外在 `AgentDefinition.model`/`AgentInfo.model` 允許簡短 alias
  (`'opus'`/`'sonnet'`/`'haiku'`/`'fable'`),但 `setModel()`/`query()` 兩處
  官方範例都只用完整 ID——`KNOWN_CLAUDE_MODELS` 因此一律採用完整 ID 當
  `value`,避免 alias 在未來若指向不同版本時的歧義。
- **採用方案**:直接呼叫 `Query.setModel()`,**不需要** dispose 現有連線
  後重新 spawn。這是比題目原先設想的「不支援時 dispose + respawn,盡量用
  resume 保留對話」更好的結果——因為 SDK 確實支援執行期切換,對話上下文
  (歷史訊息、SDK 內部 session 狀態)完全不受影響地保留,沒有「新 model 從
  下一個 prompt 開始接手」這種需要退讓的情況,也不需要 resume/continue 這
  條路。`packages/adapters/src/types.ts` 的 `AgentAdapter.setModel()` 介面
  註解記錄了完整取捨過程。
- `AcpAdapter`/`GenericPtyAdapter` 對應的協議本身沒有「呼叫端指定 model」
  這個機制(ACP 的 `session/new`/`session/prompt` 沒有 model 參數,model
  由外部 agent/CLI 自行決定;PTY 是無結構化終端直通,連「model」這個概念
  都不存在)——兩者的 `setModel()` 實作一律 `throw`,不可默默忽略成功。

### 3c:Core / gateway

- [x] `SessionManager.setSessionModel(sessionId, model)`:要求 session 目前
      是「執行中」的(有對應的 `RuntimeState`),呼叫
      `runtime.adapter.setModel(runtime.handle, model)`(ACP/PTY 在這裡就
      會 `throw`,原樣往外傳,不吞掉),成功後更新 session row 的 `model`、
      在該 session 的聊天串 `persistMessage("system", "已切換模型至 X,
      後續對話由新模型接續")`,`emit("session-updated", session)` 讓 UI
      同步,並回傳更新後的 `Session`。
- [x] `packages/shared/src/gateway.ts`:新增 `session.setModel` request
      (`params: { sessionId, model }`)與 `SessionSetModelResultSchema`
      (`{ session }`);`apps/core/src/gateway/ws-gateway.ts` 的
      `dispatch()` 接上對應 case。

### 3d:UI——顯示與切換

- [x] `packages/shared/src/known-models.ts`:新增 `KNOWN_CLAUDE_MODELS`
      常數(`{ id, label }[]`),集中定義目前已知的 Claude model 清單
      (`claude-opus-4-8`/`claude-sonnet-5`/`claude-haiku-4-5`/
      `claude-fable-5`/`claude-opus-4-7`/`claude-sonnet-4-6`),供 UI 與
      未來的模型偵測功能共用,經 `packages/shared/src/index.ts` 匯出。
      **刻意不寫死任何帶日期尾碼的 model ID**——完整 ID 直接取自 SDK
      `sdk.d.ts` 的官方註解範例(見上方 3b)。
- [x] `apps/desktop/src/views/ChatView.tsx` 新增 `ModelControl` 元件,放在
      對話標題列:顯示目前 session 的 model(`session.model` 為空時
      fallback 到 `profile.model`,兩者都沒有則顯示「(未指定,使用 CLI
      預設)」/「(由 agent 管理)」);只有 `adapterType ===
      "claude-agent-sdk"` 的 session 顯示可切換的 `<select>`(選項來自
      `KNOWN_CLAUDE_MODELS`,若目前值不在清單內會額外插入一個顯示原始值
      的選項,避免 `<select>` 因找不到對應 option 而顯示錯誤的第一項),
      其餘 software 只顯示唯讀文字。選擇後呼叫
      `session-store.ts` 新增的 `setSessionModel(sessionId, model)`
      action → gateway `session.setModel`,成功後本地立即補一則系統訊息
      (後端已經 persist 同樣內容到 DB,這裡只是不想讓使用者等下一次
      `selectSession()` 才看到提示),`"session-updated"` 推播另外會讓
      `sessions` 陣列(進而讓標題列顯示)同步更新。失敗時在選單旁顯示
      「切換失敗」並保留原有 `session.model`(不會誤把 UI 狀態改成使用者
      沒選中的值)。

### e2e 擴充(deterministic 優先)

新增步驟19(刪除對話)與步驟20(對話中切換 model,20a-20d 決定性 / 20e
真實模型軟性判定),完整子步驟說明見上方「端到端冒煙測試」章節。**既有 68
項(62 + 步驟19、20a-20d 共 6 項)一律不刪除或調弱任何一項,純粹新增**。

- `node scripts/e2e-gateway.mjs --only=deterministic`:**68/68 全 PASS**
  (既有 62 項 + 這輪新增的步驟19、20a、20b、20c、20d×2 共 6 項)。
- 額外執行一次預設模式(兩組都跑,不帶 `--only`):deterministic 組同樣
  **68/68 全 PASS**;model-behavior 組 6 項中 5 項 PASS,僅步驟5(既有已知
  flake,見上方「e2e 的殘留 flakiness」)單獨 FAIL,detail 已標註屬已知
  flake,不影響 deterministic 組結論與 `process.exitCode`。新增的步驟20e
  (換 model 後送一個 prompt 驗證仍能正常完成一輪對話)**PASS**——順帶
  證實 `claude-opus-4-8` 這個 model id 在目前環境(真實 Claude API 憑證)
  下確實可用。
- 結束後用 `tasklist` 確認無殘留 `node.exe`/`electron.exe` process。

## M5 Round D 完成度

M5 Round C 完成後的另一個小版本追加:「設定」功能 —— 偵測本機裝了哪些已知
agent CLI、各自的版本/路徑,以及(盡力而為)可用的 model,做成一個設定
介面,並把偵測到的 Claude model 接回既有的 model 切換下拉選單(維持單一
資料來源,不讓兩份清單各自漂移)。完整安全設計說明見 ARCHITECTURE.md 3.3
節備註,這裡記錄改動清單與 e2e 實際輸出。

### 1. Core:AgentDetector(`apps/core/src/detect/agent-detector.ts`,新增)

**安全設計(這輪最重要的把關點)**:

- **固定 allowlist,不接受外部輸入**:偵測哪些命令完全由檔案內寫死的
  `AGENT_ALLOWLIST` 常數陣列決定;`env.detectAgents`(唯一對外的 gateway
  入口)`params` 是空物件,不接受任何呼叫端輸入,沒有辦法要求偵測任意
  命令。
- **一律 `execFile` 陣列參數,不開 shell、不組字串**(比照
  `WorkspaceManager` 呼叫 git 的既有寫法):先用 `where`(Windows)/
  `which`(POSIX)找出完整路徑,才對該路徑跑 `--version`。Windows 上
  `.cmd`/`.bat` 這類 npm 全域安裝的 shim(例如實測本機裝的
  `claude.cmd`、`opencode.cmd`)在 `shell:false` 下 Node 會直接丟出
  `EINVAL`(與 `AcpAdapter.resolveWindowsSpawnCommand()` 遇到的問題相同)
  ——採用的做法:先用 `where` 拿到完整路徑,依副檔名(`.cmd`/`.bat`)決定
  是否需要 `shell:true`;需要時只對「解析出來的完整路徑本身」(可能含空白,
  例如 `C:\Program Files\nodejs\npm.cmd`)做必要的引號跳脫,`--version`
  這個引數本身固定寫死,不需要額外處理。**已用本機真實安裝的
  `claude.cmd`/`opencode.cmd`(路徑含空白的 `AppData\Roaming\npm\`)與
  `node.exe`/`npm.cmd`(`Program Files\nodejs\` 路徑含空白)實測驗證**,
  兩種情境(原生 `.exe` 與 `.cmd` shim,含空白路徑)都正確解析出版本字串。
- **每次探測都有逾時**(`PROBE_TIMEOUT_MS = 3000ms`):找執行檔、跑
  `--version` 這兩步各自套用,逾時/找不到/非 0 結束一律當「未安裝或無法
  判定」處理(`resolve(undefined)`,不 reject),`detectAllAgents()` 內部
  用 `Promise.all` 平行探測每個 allowlist 項目,單一項目的逾時不會拖累
  其他項目。
- **model 偵測務實降級**:只有內嵌的 `claude-agent-sdk`(直接複用
  `KNOWN_CLAUDE_MODELS`)有結構化 model 清單;外部 CLI 一律 `models: []`
  + `modelsNote` 說明「模型由該工具自行管理」——不臆測、不嘗試跑任何可能
  互動式/昂貴的「列出 model」指令。

**allowlist 現況(5 個外部 CLI + 1 個內嵌項)**:

| key | 命令 | software 分類 | model 偵測 |
|---|---|---|---|
| `claude-agent-sdk` | (內嵌 SDK,非外部命令) | `claude-agent-sdk` | `KNOWN_CLAUDE_MODELS`(結構化清單) |
| `claude-code-cli` | `claude` | `acp` | 無(`modelsNote`) |
| `gemini-cli` | `gemini` | `acp` | 無(`modelsNote`) |
| `opencode-cli` | `opencode` | `opencode` | 無(`modelsNote`) |
| `codex-cli` | `codex` | `codex` | 無(`modelsNote`) |
| `aider-cli` | `aider` | `pty` | 無(`modelsNote`) |

`claude-agent-sdk` 這個特殊項的可用性判定:檢查 `ANTHROPIC_API_KEY`
環境變數是否設定(保守、不誤報的判斷),有設定就顯示「已偵測到
`ANTHROPIC_API_KEY` 環境變數」,沒設定就顯示「已內建,憑證狀態未知(…若已用
`claude login` 完成本機登入,SDK 仍可正常運作)」——刻意不嘗試探測 Claude
CLI 私有的登入憑證檔案格式/位置(見下方「已知限制」)。

`probeCommand(command, versionArgs?)` 這個底層函式額外 export,供
`scripts/e2e-gateway.mjs` 步驟21 不經過 gateway、直接呼叫編譯產物驗證探測
邏輯本身的行為,避免在 gateway 層新增一個「可指定任意命令」的方法。

### 2. Gateway:`env.detectAgents`

- [x] `packages/shared/src/detect.ts`(新增):`DetectedModelSchema`
      (`{ id, label }`)、`AgentDetectionEntrySchema`(`key`/`displayName`/
      `software`/`installed`/`version?`/`path?`/`models`/`modelsNote?`/
      `credentialHint?`)。
- [x] `packages/shared/src/gateway.ts`:新增 `env.detectAgents` request
      (`params: z.object({}).default({})`,刻意不接受任何輸入)與
      `DetectAgentsResultSchema`(`{ agents: AgentDetectionEntry[] }`)。
- [x] `apps/core/src/gateway/ws-gateway.ts`:`dispatch()` 新增對應 case,
      直接呼叫 `detectAllAgents()`。這個方法是唯讀查詢,沿用既有的認證
      閘門即可,沒有額外的授權邏輯。

### 3. UI:設定介面 + 接回 model 選單

- [x] `apps/desktop/src/views/SettingsDialog.tsx`(新增):深色 IDE 風的
      彈窗,列出每個 agent 軟體的卡片(名稱、安裝狀態綠點/灰點、版本、路徑、
      model 清單或 `modelsNote`、`credentialHint`),右下角「重新偵測」
      按鈕。
- [x] `apps/desktop/src/App.tsx`:頂部列新增「⚙ 設定」按鈕,開啟
      `SettingsDialog`(Electron 與瀏覽器兩種場景都能用——偵測邏輯全部在
      core 端跑,兩種 client 都是打同一個 `env.detectAgents` gateway 方法)。
- [x] `apps/desktop/src/stores/session-store.ts`:新增 `detectedAgents`/
      `detectingAgents` 狀態與 `detectAgents()` action(呼叫
      `env.detectAgents`,失敗時安靜地保留舊值)。`connect()` 時
      fire-and-forget 呼叫一次,`SettingsDialog` mount 時若還沒有結果會
      補跑一次,之後只有明確按「重新偵測」才會再查一次。
- [x] `apps/desktop/src/views/ChatView.tsx`:`ModelControl` 的 model 下拉
      改用 `useMemo` 算出的 `claudeModels`——以 `detectedAgents` 裡
      `software === "claude-agent-sdk"` 項目的 `models` 為優先來源,該項
      不存在或 `models` 為空(例如尚未偵測完成的過渡期)時 fallback 到
      `KNOWN_CLAUDE_MODELS`。單一資料流:目前 `agent-detector.ts` 的
      `claude-agent-sdk` 偵測項本身就是直接把 `KNOWN_CLAUDE_MODELS` 塞進
      `models` 欄位,兩者理論上永遠一致,`SettingsDialog` 顯示的 Claude
      模型清單與 `ChatView` 下拉選單同源、不會漂移。

### e2e 擴充(步驟21,決定性優先)

新增步驟21(6 個子步驟,全部 deterministic,全程不叫任何真實模型),完整
子步驟說明見上方「端到端冒煙測試」章節。**既有 74 項(68 + 步驟21 共 6
項)一律不刪除或調弱任何一項,純粹新增**。

- `node scripts/e2e-gateway.mjs --only=deterministic`:**74/74 全 PASS**
  (既有 68 項 + 這輪新增的步驟21a、21b、21b-2、21c、21d、21e 共 6 項)。
- 額外執行一次預設模式(兩組都跑,不帶 `--only`):deterministic 組同樣
  **74/74 全 PASS**;model-behavior 組 **6/6 全 PASS**(本次執行未觀察到
  任何已知 flake 觸發,見上方「e2e 的殘留 flakiness」對這些軟性判定的
  完整說明——偶發 FAIL 不代表 regression,這次剛好全部順利收斂)。
  總計 **80 項全數 PASS**(deterministic 74 + model-behavior 6)。
- 額外用暫存腳本直接呼叫編譯後的 `apps/core/dist/detect/agent-detector.js`
  (不經過 gateway/WS)驗證 `probeCommand()`/`detectAllAgents()` 本身,並用
  本機真實安裝的 `claude`/`opencode`(均為 `.cmd` shim,路徑含空白)與
  `node`/`npm`(`.exe`/`.cmd`,路徑含空白)手動驗證版本字串解析正確(見上方
  「1. Core」的安全設計說明)。
- 結束後用 `tasklist` 確認無殘留 `node.exe`/`electron.exe` process。

## M5 Round E 完成度

M5 Round D 完成後的另一個小版本追加:強化「建立 Agent Profile」對話框與
「設定」介面——(1)工作目錄改用原生「選擇資料夾」對話框;(2)software 下拉
只列出偵測到的項目,每個選項都映射到一組保證能建立 session 的
`(software, command)`,使用者不需要自己打 command;(3)建立 profile 時可為
`claude-agent-sdk` 選一個 model;(4)「設定」介面新增「啟用哪些偵測到的
model」持久化偏好,兩個 model 下拉(ProfileCreateDialog / ChatView)只顯示
已啟用的清單。

### 1. 工作目錄改用「選擇資料夾」

- [x] `apps/desktop/electron/main.ts`:新增 `ipcMain.handle("deskmony:pickDirectory", ...)`,
      用 `dialog.showOpenDialog(mainWindow, { properties: ["openDirectory"] })`
      開原生選資料夾對話框,取消回傳 `null`。在 `app.whenReady()` 內
      `registerIpcHandlers()` 註冊一次。
- [x] `apps/desktop/electron/preload.cts`:新增 `import { ipcRenderer }`,曝露
      `pickDirectory(): Promise<string | null>` 到 `window.deskmony`。
- [x] `apps/desktop/src/global.d.ts`:`Window.deskmony` 型別新增
      `pickDirectory?: () => Promise<string | null>`(選填——純瀏覽器場景
      整個 `window.deskmony` 是 `undefined`)。
- [x] `apps/desktop/src/views/ProfileCreateDialog.tsx`:workingDir 欄位旁新增
      「瀏覽…」按鈕,只在 `window.deskmony?.pickDirectory` 存在時渲染
      (`canPickDirectory` 判斷),瀏覽器場景直接不顯示這顆按鈕,手動輸入
      workingDir 完全不受影響——**Electron 與瀏覽器兩種場景都不會壞**。

### 2. software 下拉改用偵測結果驅動

**關鍵限制(先理解才不會做出建不起來的 profile)**:`AdapterRegistry`
(`apps/core/src/index.ts`)只註冊了 `claude-agent-sdk`/`acp`/`pty` 三種
adapter,但 `env.detectAgents` 的偵測結果會把 claude/gemini CLI 分類成
`acp`、opencode 分類成 `opencode`、codex 分類成 `codex`——後兩者完全沒有
對應 adapter。因此新增 `packages/shared/src/agent-target.ts` 這個純函式層,
把「偵測到的 software 分類」轉換成「保證能建立 session 的 (software,
command)」:

> **這輪更新**:`OpenCodeAdapter` 已實作(見上方「OpenCodeAdapter」章節),
> `AdapterRegistry` 現在註冊了四種 adapter(`claude-agent-sdk`/`acp`/`pty`/
> `opencode`),下表 `opencode` 分類的映射已改成 `software="opencode"` 本身
> ——這裡維持 M5 Round E 當下的原始表格與文字供歷史對照,實際行為以上方
> 「偵測項 → 建立目標的映射更新」章節為準。

| 偵測到的 `software` 分類 | 預設映射(M5 Round E 當下) | 進階選項 |
|---|---|---|
| `claude-agent-sdk`(內嵌) | `software="claude-agent-sdk"`,無 command | 無 |
| `acp`(claude-code-cli / gemini-cli) | `software="pty"` + command=偵測到的完整路徑 | 可勾選「進階:改用 ACP」→ `software="acp"` + 同一個 command |
| `opencode`(opencode-cli) | ~~`software="pty"`~~ → **這輪起改成 `software="opencode"`**,command=偵測到的完整路徑 | 無(沒有 ACP 選項,不假設它講 ACP) |
| `codex`(codex-cli) | `software="pty"` + command=偵測到的完整路徑 | 無(codex 目前仍無對應 adapter) |
| `pty`(aider-cli) | `software="pty"` + command=偵測到的完整路徑 | 無(aider 本來就沒有結構化協議) |

理由:PTY 直通對任何互動式 CLI 都保證能跑(只是把 stdin/stdout 接到終端,
不要求對方講任何結構化協議);而任意 CLI 未必真的實作 ACP server(bare
`claude`/`gemini` 直接執行通常只是一般互動式 CLI,不是 ACP server),貿然
預設用 ACP 建 profile 有相當機率建出一個連不上的 session。只有偵測分類
「本來就已經是 acp」的兩個項目(表示 allowlist 撰寫者已經判斷它們適合走
ACP,見 `apps/core/src/detect/agent-detector.ts` 的 `AGENT_ALLOWLIST` 註解)
才提供「進階:改用 ACP」的勾選框給知道自己 CLI 支援 ACP 的使用者手動切換,
預設不勾。

- [x] `packages/shared/src/agent-target.ts`(新增):`deriveDefaultAgentTarget(entry)`
      (上表的預設映射邏輯)、`canUseAcpAdvanced(entry)`(只有偵測分類是
      `"acp"` 且有 `path` 才回傳 `true`)、`deriveAcpAdvancedTarget(entry)`
      (進階選項的目標)。純函式,不依賴任何 apps/*。
- [x] `apps/desktop/src/views/ProfileCreateDialog.tsx`:大改版——
  - software 下拉的選項改成:內嵌 Claude Agent SDK(固定第一個)+
    `detectedAgents` 裡 `installed === true` 的外部項目 + 「自訂…(進階)」
    逃生選項(放在清單最後,不是預設值)。
  - 對話框開啟時,若 `detectedAgents` 尚未有結果會自動觸發一次
    `detectAgents()`(比照 `SettingsDialog` 既有的節流邏輯),另附「重新
    偵測」小連結。
  - 選到某個偵測項時,command **唯讀顯示**(直接來自
    `deriveDefaultAgentTarget()`/`deriveAcpAdvancedTarget()` 的結果),使用者
    不需要打字;`args` 維持選填文字輸入(預設空)。
  - 只有 `canUseAcpAdvanced(entry)` 為真的項目才顯示「進階:改用 ACP」勾選框。
  - 「自訂…」選項才需要手動輸入 software(acp/pty 二選一)+ command +
    args——這是給進階使用者的逃生閥,不是預設路徑。

### 3. 建立 profile 時選 model

- [x] `apps/desktop/src/views/ProfileCreateDialog.tsx`:選到 `claude-agent-sdk`
      時額外顯示一個 model 下拉,選項來自 `selectEnabledClaudeModels()`(見
      下方需求4)——只列出「設定」介面啟用的 model。選擇後帶進
      `createProfile()` 呼叫的 `model` 欄位(`CreateAgentProfileInput.model?`
      本來就存在,這輪只是接上 UI)。其他 software 不顯示 model 下拉(model
      由外部工具自管)。

### 4. 「設定」介面:啟用哪些偵測到的 model,持久化

- [x] `packages/db/src/schema.ts` / `client.ts`:新增極簡的 `settings` 表
      (`key TEXT PRIMARY KEY, value TEXT NOT NULL`,value 存 JSON 字串)。
      比照既有的 `CREATE TABLE IF NOT EXISTS` 自我修復策略——這是全新的表,
      沒有既有資料需要遷移欄位,不需要 `ALTER TABLE`。
- [x] `apps/core/src/settings/settings-store.ts`(新增):`SettingsStore`
      (`get`/`set`,用 drizzle 的 `onConflictDoUpdate` 做 upsert)+
      `getEnabledClaudeModelIds()`/`setEnabledClaudeModelIds()`(封裝
      「啟用哪些 Claude model」這個具體語意,value 存 JSON 字串陣列)。
      **語意約定:空陣列 = 全部啟用**——未曾設定過,或存的 JSON 解析失敗,
      都回傳空陣列,讓呼叫端安全地 fallback 顯示 `KNOWN_CLAUDE_MODELS` 全部。
- [x] `packages/shared/src/gateway.ts`:新增 `settings.getEnabledModels`
      (`params` 空物件)/`settings.setEnabledModels`
      (`params: { enabledModelIds: string[] }`)request,以及
      `SettingsGetEnabledModelsResultSchema`/`SettingsSetEnabledModelsResultSchema`
      (兩者都回 `{ enabledModelIds: string[] }`)。
- [x] `apps/core/src/gateway/ws-gateway.ts`:`WsGateway` 建構子新增
      `settingsStore` 參數,`dispatch()` 新增對應兩個 case。
      `apps/core/src/index.ts` 建構並注入 `new SettingsStore(db)`。
- [x] `apps/desktop/src/stores/session-store.ts`:新增 `enabledModelIds`
      狀態、`loadEnabledModels()`/`setEnabledModels()` action,以及共用
      selector `selectEnabledClaudeModels(enabledModelIds)`(空陣列回傳
      `KNOWN_CLAUDE_MODELS` 全部,非空回傳交集)——**單一資料流**:
      `ProfileCreateDialog`(需求3)與 `ChatView` 的 `ModelControl`(對話中
      切換 model)都呼叫這同一個 selector,不各自複寫一份判斷邏輯。
      `connect()` 時 fire-and-forget 呼叫一次 `loadEnabledModels()`。
- [x] `apps/desktop/src/views/SettingsDialog.tsx`:新增 `EnabledModelsEditor`
      元件,只掛在 `claude-agent-sdk` 這個偵測項卡片下方——每個
      `KNOWN_CLAUDE_MODELS` 顯示一個勾選框(初始狀態 = 目前啟用清單,空陣列
      視為全部勾選),「儲存」按鈕呼叫 `setEnabledModels()`。若使用者勾選了
      全部 model,儲存時改存空陣列(維持「空=全部啟用」的約定,未來新增
      model 時自動視為啟用,不需要使用者手動回來再勾一次)。存檔成功後
      `session-store` 的 `enabledModelIds` 立即更新,`ProfileCreateDialog`/
      `ChatView` 兩個 model picker 不需要重開視窗就會反映最新清單(重新開
      `ProfileCreateDialog`、或 `ChatView` 因為 store 訂閱而即時 re-render)。

**落地驗證(不是只存在記憶體)**:見下方 e2e 步驟23——`setEnabledModels`
後關掉 core 子程序,用**同一個** `DESKMONY_DATA_DIR` 重啟一個全新的 core
子程序,`getEnabledModels` 仍讀回相同的值。

### e2e 擴充(步驟22/23,決定性優先)

新增步驟22(4 個子步驟:偵測項 → 可建立 (software,command) 映射的純函式
測試,不需要 core/gateway,直接 import `packages/shared/dist/agent-target.js`
驗證)與步驟23(4 個子步驟:設定持久化,含重啟 core 驗證真的落地 SQLite),
全部 deterministic、全程不叫任何真實模型。**既有 74 項一律不刪除或調弱任何
一項,純粹新增 8 項**。

- `node scripts/e2e-gateway.mjs --only=deterministic`:**82/82 全 PASS**
  (既有 74 項 + 這輪新增的步驟22a-d、23a-d 共 8 項)。
- 額外執行一次預設模式(兩組都跑,不帶 `--only`):deterministic 組同樣
  **82/82 全 PASS**;model-behavior 組 **6/6 全 PASS**(本次執行未觀察到
  任何已知 flake 觸發)。總計 **88 項全數 PASS**(deterministic 82 +
  model-behavior 6)。
- 結束後用 `tasklist` 確認無殘留 `node.exe`/`electron.exe` process。

**M5 Round E 範圍內的簡化與已知問題**
- `ProfileCreateDialog` 的「進階:改用 ACP」勾選框只在偵測分類本身是
  `"acp"` 的項目上出現(目前是 claude-code-cli/gemini-cli)——如果使用者
  安裝的是這兩個 CLI 但實際版本不支援 ACP,勾選後仍會嘗試以 ACP 建立
  session,建立/連線失敗時的錯誤訊息由 `AcpAdapter` 既有的錯誤處理負責,
  這輪沒有另外做「先試探對方是否真的講 ACP」的前置檢查。
- 「自訂…」逃生選項的 command 完全信任使用者輸入(與既有行為一致,
  `AcpAgentConfigSchema`/`PtyAgentConfigSchema` 只驗證非空字串),這是刻意
  保留給進階使用者的例外路徑,不是這輪新增的風險面。
- `EnabledModelsEditor` 目前只服務 `claude-agent-sdk` 這一個偵測項——外部
  CLI 的 model 由該工具自行管理,没有「啟用/停用」的概念,不適用這個機制。
- `settings` 表目前只有一筆 key(`enabledClaudeModelIds`),但設計成通用的
  key/value 結構,之後若要新增其他持久化偏好,不需要再一次 schema 遷移。

## Provider 目錄重構(對齊 Paseo 的 provider 設計)

這輪把「建立 Agent Profile」的方式,依 [Paseo](https://paseo.dev) `~/.paseo/config.json`
`agents.providers` 的設計重構:一份**具名 provider 目錄**,每個 provider
「繼承一個內建預設、再覆寫差異」(label/env/models/enabled/order),而不是
每次都從零手動填 software/command。**這輪移植的是這套「provider 目錄 +
繼承覆寫」的概念,不是照抄 Paseo 的檔案格式**——Deskmony 的設定持久化在
SQLite(`settings` 表),不是使用者家目錄下的 JSON 設定檔;全域設定檔(讓
使用者在 core 啟動前就能編輯的檔案)留待下一輪。

### 1. 內建 provider 目錄(`packages/shared/src/provider-catalog.ts`,新增)

`BUILTIN_PROVIDERS: ProviderCatalogEntry[]` 是靜態常數,每一項:

| id | label | software | detectKey | 備註 |
|---|---|---|---|---|
| `claude-agent-sdk` | Claude Agent SDK(內嵌) | `claude-agent-sdk` | `claude-agent-sdk` | `models` 直接遷移 `KNOWN_CLAUDE_MODELS`,第一項標 `isDefault` |
| `claude-cli` | Claude Code CLI | `pty` | `claude-code-cli` | bare CLI 不保證講 ACP,預設走 PTY 直通(同 `agent-target.ts` 既有保守原則) |
| `gemini` | Google Gemini | `acp` | `gemini-cli` | `defaultArgs: ["--acp"]`,對齊需求描述引用的 Paseo 範例 `"command": ["gemini", "--acp"]` |
| `opencode` | OpenCode | `opencode` | `opencode-cli` | 對應既有 `OpenCodeAdapter`(HTTP + SSE) |
| `codex` | Codex CLI | `pty` | `codex-cli` | 尚無專屬 adapter,映射成 pty(不是「不列出」) |
| `aider` | Aider | `pty` | `aider-cli` | 同上,PTY 直通 |
| `custom-pty` | 自訂…(進階) | `pty` | (無) | 逃生閥,`resolveProviders()` 恆回傳 `command: undefined`,需使用者手動輸入 |

**型別保證**(呼應 `agent-target.ts` 既有「絕不可產生建不起來的組合」原則):
`ProviderCatalogEntry.software` 用獨立的 `RegisteredAgentSoftwareSchema =
z.enum(["claude-agent-sdk", "acp", "pty", "opencode"])`,比完整的
`AgentSoftwareSchema`(多一個 `"codex"`)窄——`codex` 這個 provider **id**
存在,但它的 `software` 欄位只能填 `"pty"`,在 zod 執行期與 TS 型別兩層都
擋掉「software="codex"」這種 `AdapterRegistry` 建不起來的值。

`ProviderModel = { id, label, description?, isDefault? }`——對齊 Paseo 模型
物件形狀,**這輪不做** `thinkingOptions`(思考預算選項)/`disallowedTools`
(provider 層級工具黑名單),記入下方「已知限制」。

### 2. `resolveProviders()` 純函式(`packages/shared/src/resolve-providers.ts`,新增)

```
resolveProviders(BUILTIN_PROVIDERS, detection, prefs) => ResolvedProvider[]
```

輸入:內建目錄、`env.detectAgents` 的偵測結果、`settings.getProviderPrefs`
的使用者偏好(稀疏 map)。輸出每項保證「可直接拿去建立 profile」:

- **合併偵測結果**:依 `detectKey` 對應到 `AgentDetectionEntry`,帶入
  `installed`/`command`(= `entry.path`)/`detectedVersion`。`claude-agent-sdk`
  恆 `installed:true`、不需要 command;`custom-pty`(無 `detectKey`)恆
  `installed:true`、`command` 恆 `undefined`(不受偵測結果影響)。
- **套用使用者偏好**:`enabled`(未設定預設 `true`)、`order`/`label`
  提供時覆寫;`models` 提供時**整批取代**目錄預設;`additionalModels`
  **合併**進(取代後的)清單,**以 model id 去重、使用者定義優先**——既有
  id 原地覆寫(位置不變),新 id 附加在尾端;`enabledModelIds` 對合併結果
  再過濾一次(空陣列/省略 = 全部啟用,沿用既有 `settings.getEnabledModels`
  的約定);`defaultModelId` = 過濾後清單裡第一個 `isDefault` 的項目,沒有
  就取第一個。
- **輸出保證**:`software` 一定是 `AdapterRegistry` 實際註冊過的四種之一
  (由 `ProviderCatalogEntry.software` 的窄型別保證,見上一節);外部 CLI
  `command` 非空才代表真的可以建立 session(未安裝/未偵測到路徑的項目
  `command` 為 `undefined`,呼叫端應用 `installed` 決定是否可選)。
- 結果依 `order` 升冪排序(`Array.prototype.sort` 自 ES2019 起保證
  stable,同序值維持目錄宣告順序,不需要額外 tie-break)。

`selectSelectableProviders(resolved)`:只回傳 `enabled` 的項目,給
`ProfileCreateDialog` 的下拉選單使用;`SettingsDialog` 顯示**全部**
(含停用的),才能重新啟用。

**沿用、不取代 `agent-target.ts`**:`deriveDefaultAgentTarget()`/
`canUseAcpAdvanced()`/`deriveAcpAdvancedTarget()` 這輪**完全沒有改動**
(逐字沿用,e2e 步驟22 系列語意 100% 不變)——`resolveProviders()` 是平行的
新機制,provider 目錄本身就是「哪個 provider 對應哪個已註冊 adapter」的
權威來源,不需要再透過偵測分類反推。`ProfileCreateDialog` 這輪改呼叫
`resolveProviders()`,不再呼叫 `agent-target.ts` 的函式,但後者仍然是
`packages/shared` 對外匯出、有獨立 e2e 覆蓋的公開 API。

### 3. settings 的 per-provider 偏好(`apps/core/src/settings/settings-store.ts`)

擴充既有的 `settings` KV 表(單一 JSON blob,key 固定為 `providerPrefs`,
value 是 `{ [providerId]: ProviderPrefs }`):

- `getProviderPrefsMap(store)` / `patchProviderPrefs(store, providerId, patch)`
  ——`patch` 是**部分欄位合併**,不是整包取代:`enabled`/`order`/`label`
  提供時直接覆寫;**`env` 提供時淺層合併**進既有 env(只覆寫/新增 patch
  裡出現的 key,其餘既有 key 保留)——這是刻意設計:gateway 回傳給 client
  的 `env` 一律遮罩過(見下方安全章節),client 沒辦法安全地把「讀到的
  偏好」整包重新送回來,淺層合併讓 client 只需要送出「這次想新增/修改的
  那幾個 key」。`models`/`additionalModels`/`enabledModelIds` 提供時整批
  取代。
- `settings.getProviderPrefs`(params 空物件)/`settings.setProviderPrefs`
  (`params: { providerId, patch }`)兩個新 gateway 方法,回傳值都經過
  `maskProviderPrefsMap()` 遮罩。

**舊 `settings.getEnabledModels`/`setEnabledModels` 相容(保留,不廢除)**:
兩個方法**簽章與行為完全不變**,`ws-gateway.ts` 的 dispatch case 一行都
沒改——底層改成呼叫 `getEnabledClaudeModelIds()`/`setEnabledClaudeModelIds()`,
這兩個函式現在讀寫 per-provider 偏好裡 `claude-agent-sdk` 這一項的
`enabledModelIds` 欄位,**單一資料來源**(舊 API 與新 API 讀寫同一份底層
儲存,不會漂移,見下方 e2e 步驟26d 的直接驗證)。

**舊資料遷移(`migrateLegacyEnabledModelIds()`,啟動時呼叫一次)**:

```
if (providerPrefs["claude-agent-sdk"].enabledModelIds !== undefined) return; // 已遷移/使用者已設定過,不覆蓋
const legacy = settings.get("enabledClaudeModelIds");                        // 舊版扁平 key
if (!legacy) return;                                                          // 從未設定過,維持既有「空=全部啟用」語意
providerPrefs["claude-agent-sdk"].enabledModelIds = JSON.parse(legacy);
```

冪等:判斷條件是「新結構的欄位是否**已存在**(即使是空陣列)」,不是「舊
key 是否還在」——舊 key 刻意不刪除(遷移只新增,不破壞既有資料),重複呼叫
(每次 core 啟動都會跑一次)不會有任何副作用差異,也不會在使用者之後透過
新/舊 API 明確修改過設定後,把值覆蓋回最初遷移進來的舊值(見 e2e 步驟27e)。

### 4. env 的安全處理(review 會嚴查的部分)

`env` 可能含 API key(例如 `ANTHROPIC_API_KEY`),分兩層存在:

- **provider 層級**(`ProviderPrefs.env`,settings 表):同一 provider 的
  「共用預設憑證」,`SessionManager.createSession()` 依 `profile.providerId`
  查出來,疊在 `profile.env` **之下**。
- **profile 層級**(`AgentProfile.env`,`agent_profiles` 表新欄位):單一
  profile 的覆寫,對齊 Paseo「同一個 provider 建立多組不同憑證」的用法
  (例如 `claude-work`/`claude-personal` 兩個都用 `claude-agent-sdk`、
  各自帶不同 `ANTHROPIC_API_KEY` 的 profile)。優先權比 provider 層級高。

安全要求與實作位置:
1. **絕不寫進任何 log**:`settings-store.ts`/`ws-gateway.ts`/
   `session-manager.ts` 三處都不對 env 內容呼叫任何 `console.log`/`error`。
2. **gateway 回傳時遮罩**:`maskProviderPrefsMap()`(`apps/core/src/settings/
   settings-store.ts`)把每個 provider 的 `env` 值全部覆寫成字面字串
   `"***"`,只保留 key 名稱——`settings.getProviderPrefs`/`setProviderPrefs`
   **只**回傳這個函式的輸出,絕不把未遮罩的 map 直接送出去。這防護的攻擊面:
   任何連上這個 gateway 的 client(不只是設定這筆 env 的那個 client)呼叫
   `settings.getProviderPrefs` 就能讀走其他工作階段設定的 API key 明文。
   e2e 步驟26b/26e 直接斷言回應的完整 JSON 序列化字串裡不含明文金鑰值。
   **`AgentProfile.env` 這輪刻意不遮罩**——profile 本身透過既有的
   `profile.list`/`profile.create` 回傳完整物件,與 `acpConfig.env`/
   `ptyConfig.env`/`opencodeConfig.env` 這些既有欄位的既有慣例一致(那些
   欄位一直都是明文回傳,不是這輪才放寬),profile 是「使用者自己在這台
   機器建立、只給自己的 UI 讀」的資料,不像 provider 層級偏好是「多個
   client 都能查詢的共用設定」。
3. **本機明文落地**:遮罩只防護「透過 gateway 傳輸」這個管道,`env` 的值
   仍以明文 JSON 字串存在本機 `%DESKMONY_DATA_DIR%/deskmony.db`(SQLite 檔
   案)——這與 Paseo 把 API key 寫進 `~/.paseo/config.json`(同樣是本機
   明文設定檔)是**同一類取捨**:兩者都假設「本機檔案系統本身的存取控制」
   是信任邊界,不在應用層額外加密。

已知限制:`patchProviderPrefs()` 的 env 合併目前**沒有「移除單一 key」**
的操作(只能新增/覆寫),要移除需要之後擴充協議(例如額外的 `envUnset`
欄位)——SettingsDialog 的 `EnvEditor` 這輪只提供「新增/更新」,見程式內
註解。

### 5. `AgentProfile` 擴充(`providerId`/`env`)

- `packages/shared/src/agent-profile.ts`:新增 `providerId?: string`(來源
  是哪個 provider 目錄項目,純中繼資訊,不影響 `software`/`*Config` 決定
  怎麼 spawn)、`env?: Record<string,string>`。
- `packages/db/src/schema.ts`/`client.ts`:`agent_profiles` 表新增
  `provider_id`/`env` 兩欄。**冪等遷移**(`ensureAgentProfilesProviderColumns()`):
  比照既有 `ensureSessionsModelColumn()`/`ensureAgentProfilesOpencodeConfigColumn()`
  的既有手法——`PRAGMA table_info` 檢查欄位是否已存在,沒有才
  `ALTER TABLE ... ADD COLUMN`,`try/catch` 吞掉競態下的「欄位已存在」例外。
  對已存在的舊 DB 檔案(這輪之前建立、沒有這兩個欄位)一樣有效——`CREATE
  TABLE IF NOT EXISTS` 對已存在的表不會補欄位,這正是需要這個函式的原因。
- `SessionManager.createSession()`:依 `profile.providerId` 查
  provider 層級預設 env(`getProviderEnv()`),疊上 `profile.env`
  (profile 優先),合併後才傳給 `adapter.spawn()`——只有兩者至少一個非空
  時才建立新的 `env` 欄位,避免對「完全沒用到這個功能」的既有 profile
  產生任何行為差異。
- 各 adapter 的 `spawn()`:
  - `AcpAdapter`/`GenericPtyAdapter`/`OpenCodeAdapter`:既有的
    `acpConfig.env`/`ptyConfig.env`/`config.env` 欄位語意不變(依然是子
    程序環境變數的**最終**覆寫),`profile.env` 疊在 `process.env` 之上、
    `*Config.env` 之下,即 `{ ...process.env, ...profile.env,
    ...specificConfig.env }`。
  - `ClaudeAgentSdkAdapter`:這輪新增支援——`profile.env` 非空時才傳
    `options.env = { ...process.env, ...profile.env }`(讀取 SDK
    `sdk.d.ts` 確認 `Options.env` 設定後**整個取代**子程序環境、不自動
    merge `process.env`,故手動展開;省略此欄位時 SDK 沿用「繼承
    process.env」的預設行為,不改變既有 profile 的 spawn 結果)。

### 6. UI 改動

- **`ProfileCreateDialog.tsx`**:software 下拉改讀
  `selectResolvedProviders()`(session-store.ts 的單一入口,包住
  `resolveProviders(BUILTIN_PROVIDERS, detectedAgents, providerPrefs)`)——
  依 `order` 排序、`enabled=false` 不顯示、未安裝的項目仍顯示但
  `<option disabled>` 並標「未偵測到」。選定後自動帶入 label、command
  (唯讀)、該 provider 自己的模型清單(`supportsModelSelection` 時才
  顯示,預設選 `defaultModelId`)、`defaultArgs`(例如 gemini 固定的
  `--acp`,使用者填的 `args` 附加在後面,不是取代)。新增選填的「環境
  變數」key/value 陣列區塊,對應 `AgentProfile.env`,值輸入框用
  `type="password"` 遮罩。保留既有「自訂…」逃生選項,行為不變。
- **`SettingsDialog.tsx`**:整個改版為「Provider 管理」——列出
  `resolveProviders()` 的**全部**輸出(含停用的),每張卡片可切換
  `enabled`、調整 `order`(數字輸入)、展開後顯示該 provider 自己的模型
  勾選(泛化自舊版只給 Claude 用的 `EnabledModelsEditor`)與環境變數編輯
  (`EnvEditor`——顯示已設定的 key 名稱、新增/更新單一 key 的表單,絕不
  顯示明文值)。
- **`ChatView.tsx` 的 `ModelControl`**:model 下拉改讀
  `selectProviderModels(profile, detectedAgents, providerPrefs,
  enabledModelIds)`(session-store.ts)——這個 session 所屬 profile 若有
  `providerId`,用該 provider 目前已啟用的模型清單;沒有 `providerId` 的
  舊 profile 退回既有的 `selectEnabledClaudeModels()` fallback,不改變舊
  profile 的既有觀感。**注意**:對話中切換 model 這個動作本身依然只對
  `software="claude-agent-sdk"` 開放(`AgentAdapter.setModel()` 只有
  `ClaudeAgentSdkAdapter` 支援,見 `packages/adapters/src/types.ts`)——
  `supportsModelSelection` 這個 provider 目錄欄位管的是「建立 profile /
  設定介面要不要顯示模型清單」,與「這個 session 能不能對話中切換」是
  兩件不同的事,即使之後其他 provider 也宣告 `supportsModelSelection`,
  這裡的切換下拉依然不會對它們開放。
- 單一資料流:`ProfileCreateDialog`(建立 profile 選 model)、
  `SettingsDialog`(啟用哪些 model)、`ChatView`(對話中切換 model)三處
  都透過 `session-store.ts` 的 `selectResolvedProviders()`/
  `selectProviderModels()` 這兩個共用 selector,不各自複寫一份合併邏輯。

### 7. e2e 擴充(步驟25/26/27,決定性優先)

- **步驟25**(10 個子步驟):`resolveProviders()` 純函式測試,不需要
  core/gateway,直接 import `packages/shared/dist/{resolve-providers,
  provider-catalog}.js` 驗證——涵蓋 `BUILTIN_PROVIDERS`/輸出的 `software`
  皆已註冊(不會是 `"codex"`)、未安裝/已安裝偵測項的 `installed`/
  `command` 正確、`custom-pty` 不受偵測影響、`enabled`/`order`/`label`
  覆寫生效、`models` 整批取代、`additionalModels` 合併(id 去重、使用者
  優先、`defaultModelId` 隨新標記移動)、`enabledModelIds` 過濾、輸出依
  `order` 排序。
- **步驟26**(5 個子步驟):per-provider 偏好持久化——設定 → 同連線讀回
  一致 → env 淺層合併(新增一個 key 不影響既有 key)→ 舊/新 API 讀寫同一份
  儲存(不漂移)→ **殺掉 core 重啟後仍一致**(比照既有步驟23c,證明落地
  SQLite)。每一步都額外斷言完整回應的 JSON 序列化字串不含明文金鑰值
  (env 遮罩的直接證明)。
- **步驟27**(5 個子步驟):舊版 `enabledClaudeModelIds` 相容遷移——用
  `@deskmony/db` 的 `createDb()` 在 core 啟動前直接寫入舊格式的 settings
  列(模擬舊版遺留 DB,不啟動 core)→ 啟動 core(觸發遷移)→ 舊版
  `settings.getEnabledModels` 與新版 `settings.getProviderPrefs` 都讀到
  遷移後的正確值 → 重啟(再次觸發遷移邏輯)仍一致(冪等)→ 使用者之後
  明確修改過設定,再重啟也不會被遷移邏輯覆蓋回最初的舊值。

**既有步驟22/23 這輪沒有任何改動**(逐字沿用,不是「調整後語意等價」,是
完全沒碰):`agent-target.ts` 保留、`settings.getEnabledModels`/
`setEnabledModels` 的 gateway dispatch case 一行都沒改,只是底層儲存改道
——這兩組既有斷言在重構前後跑的是同一段程式碼路徑，零風險。

- `node scripts/e2e-gateway.mjs --only=deterministic`:**109/109 全 PASS**
  (既有 89 項 + 這輪新增的步驟25a-j、26a-e、27a-e 共 20 項)。
- 額外執行一次預設模式(兩組都跑,不帶 `--only`):**deterministic 組
  109/109 全 PASS,model-behavior 組 6/6 全 PASS,總計 115/115 全 PASS**。
  過程中曾遇到兩次已知的環境性 flake(皆非這輪改動造成,且都符合既有
  flake 分類原則,清乾淨暫存狀態後重跑即恢復全綠):(1)步驟8
  Electron 啟動冒煙測試在系統負載較高時偶發 `gatewayListening=false`
  (這個測試用固定 `sleep(20_000)` 判斷,不是這輪改動的程式碼,也未曾
  改動這個測試本身);(2)步驟14b(已在檔案頂端明列為「真實模型串流,
  屬 model-behavior 分類」的既知 flake)。**沒有修改任何測試斷言**,只是
  依專案既有的「乾淨重跑一次」慣例處理。
- 結束後用 `Get-Process`/`Get-NetTCPConnection` 確認無殘留
  `node.exe`/`electron.exe` process、無殘留佔用連接埠,暫存目錄
  (`%TEMP%\deskmony-e2e-*`、`%TEMP%\.deskmony-worktrees`)全部清除。

### 8. e2e 擴充(步驟28,M6 Round A:分層合併的設定檔)

全程用 `DESKMONY_HOME` 指到暫存目錄(絕不動到使用者真正的 `~/.deskmony`),
每個子測試各自獨立管理 core 子程序(見 `configLayeringSmokeTest()`):

- **28a**:沒有設定檔時,`config.getEffective` 的有效設定等同現行預設
  (`bindHost`/`permissionTimeoutMs`/`authRateLimit`/`defaultWorkingDir`/
  `worktreesRoot`/`staticDir`/`log.level` 皆為 `"default"` 來源,值與既有
  行為一致)。
- **28b**(3 個子步驟):合併優先權——同一欄位(`permissionTimeoutMs`)分別
  只有 default / 只有設定檔 / 設定檔+環境變數三種情況,斷言有效值與來源
  標記正確(環境變數贏過設定檔);`log.level`(沒有對應環境變數)驗證
  default → 設定檔兩層,證明環境變數覆寫是逐欄位的,不是整份設定檔被環境
  變數整批蓋掉。
- **28c**:設定檔 JSON 語法錯誤 → 拒絕啟動(結束碼非 0),stderr 有明確
  訊息。
- **28d**:已知欄位型別錯誤(`daemon.port` 給字串)→ 拒絕啟動。
- **28e**:未知欄位 → 仍可正常啟動,印出明確警告(逐一列出未知欄位路徑)。
- **28f**:安全防線(a)——設定檔把 `daemon.bindHost` 設成 `0.0.0.0`、無
  環境變數 token → 拒絕啟動(綁定安全檢查套用在合併後的設定上)。
- **28g/28h**:安全防線(b)——設定檔放入疑似 token 的欄位
  (`daemon.authToken`)→ 印出明確警告、忽略,用它嘗試認證會被拒絕,只有
  真正的環境變數 token 才能通過;`config.getEffective` 回傳內容不含任何
  token(比照既有 provider env 遮罩的斷言方式,對整個 JSON 字串做檢查)。
- **28i**(5 個子步驟):`config.setFile` 只接受安全子集——嘗試改
  `daemon.bindHost`/`daemon.port` 被拒(協議層面就不接受,不會走到
  dispatch);改 `log.level` 成功、落地成 `config.json`(含 `version`/
  `$schema`);重啟後仍生效(來源 `"file"`),且真的壓下 info 等級的既有
  `console.log` 輸出。

- `node scripts/e2e-gateway.mjs --only=deterministic`:見下方「已完成」章節
  末尾的最新一次總計數字。

### 9. 這輪刻意不做(留待未來)

- Paseo 的 `thinkingOptions`(模型思考預算選項)、`disallowedTools`
  (provider 層級工具黑名單)——`ProviderModelSchema`/`ProviderCatalogEntrySchema`
  這輪都沒有對應欄位。
- provider 偏好(env/models/enabledModelIds)仍是「core 啟動後,透過 gateway
  讀寫 SQLite」這個既有模式,**沒有**併入 M6 Round A 新增的 `config.json`
  ——`agents.providers` 這個區塊上一輪已用 SQLite 實作,這輪明確排除在外,
  不重複實作(見任務描述「這輪不要動」)。M6 Round A 全域設定檔(`<DESKMONY_HOME>/
  config.json`)見下方「全域設定」相關章節與 e2e 步驟28。
- provider 層級 env 的「移除單一 key」操作(見上方第4節)。
- Paseo 的「具名 provider 多實例」(同一個 map 裡多個 key 都 `extends`
  同一個內建 provider)——這輪改用「`AgentProfile.providerId` + 各自的
  `env`」達成同等效果(多個 profile 共用同一個 `providerId`,各自帶不同
  `env`),見上方第2節「刻意不做」的完整取捨說明。
- `custom-pty`(逃生閥)這個 provider 目錄項目在 `SettingsDialog` 裡也會
  顯示一個「啟用」開關,但 `ProfileCreateDialog` 的「自訂…」選項是獨立的
  `CUSTOM_KEY` sentinel(不透過 `resolveProviders()` 判斷是否顯示),目前
  停用 `custom-pty` 並不會讓「自訂…」選項消失——這是已知的小不一致,留給
  之後若要收斂再處理(需要把「自訂…」選項本身也改成讀 `custom-pty` 這個
  已解析項目的 `enabled` 狀態)。

## 已知限制 / TODO

**架構範圍(見 ARCHITECTURE.md 第 9 節路線圖)**
- 團隊群聊視圖與團隊管理 UI 已於 M3 Round B 完成(見上方「M3 Round B 完成度」)。
- TaskService + WorkspaceManager(git worktree 隔離)已於 M4 Round A 完成;
  任務看板 UI、`request_review` 工具、真正的 `merging → done` 合併自動化
  已於 M4 Round B 完成(見上方「M4 Round A 完成度」/「M4 Round B 完成度」)。
  `Scheduler`(定時喚醒/自動輪詢)還沒開始,是目前唯一明確不在路線圖 M1~M5
  範圍內、留給之後另立階段的項目。
- `AcpAdapter` 已於 M2 Round A 完成;`GenericPtyAdapter` 與 adapter 能力降級
  UI 已於 M2 Round B 完成;`OpenCodeAdapter` / `CodexAdapter` 留給之後的
  round;ACP/PTY 這輪不掛 team-bus MCP(見上方 M3 Round A 完成度)。
- Core 獨立部署正式化 + 綁定位址安全預設 + token 認證已於 M5 Round A 完成;
  瀏覽器/行動裝置 client + 安全強化(timingSafeEqual + rate limiting)已於
  M5 Round B 完成(見上方「M5 Round A 完成度」/「M5 Round B 完成度」)。
  **ARCHITECTURE.md 第 9 節路線圖 M1~M5 至此全部完成**。

**M5 Round A 範圍內的簡化與已知問題**
- 認證只有單一 token(全域共用),沒有多租戶/多使用者/權限分級的概念 ——
  知道 token 的人對這個 core 實例擁有完整操作權限(等同本機開發者本人),
  這輪的威脅模型只到「擋住沒有 token 的匿名連線」,不含更細緻的授權模型
  (見 ARCHITECTURE.md 3.3 節 `PermissionGateway` 是另一層、只管 agent 工具
  呼叫是否需要人類核可,與這裡的連線層認證是正交的兩件事)。
- token 沒有過期/輪替機制——桌面殼場景下每次啟動都重新產生(見上方桌面殼
  串接說明),但長時間對外運行的 headless 部署若要輪替 token,目前只能靠
  重啟 core 子程序(改環境變數後重新啟動)達成,沒有「不斷線換 token」的
  熱更新機制。
- `AUTH_TIMEOUT_MS`(5 秒)目前寫死在 `ws-gateway.ts`,沒有對應的環境變數
  可調整——這輪判斷 5 秒對正常的認證流程(client 連線後幾乎立即送出
  `auth`)綽綽有餘,拉長它只會讓惡意/異常連線占用資源的時間變長,沒有
  對應的正當需求,因此沒有加這個設定項。
- `message.reportStatus`/`message.send` 這類既有的「代表某個 team member
  行動」的 gateway 方法,這輪的連線層認證解決的是「誰能連上 core」,不是
  「這個連線能不能代表特定 member 行動」——換句話說,一旦通過連線層認證,
  呼叫端依然可以在請求參數裡填入任意 `fromMemberId`/`fromName` 代表任何
  成員發言,這個既有的已知限制(見 M4 Round B 完成度備註)這輪沒有一併
  收斂,留給之後視需要決定要不要加更細的每請求身分驗證。
- ~~WS server 目前對「已認證」與「未認證」連線的資源沒有額外限流(例如同一
  IP 短時間內大量嘗試錯誤 token)~~ **已於 M5 Round B 補上**(`AuthRateLimiter`,
  見上方「安全強化」章節)——注意這仍然只是**單一 IP 層級**的節流,不是
  完整的 DDoS/IP allowlist 防護,見下方「M5 Round B 範圍內的簡化與已知
  問題」。

**M5 Round B 範圍內的簡化與已知問題**
- `AuthRateLimiter` 的來源 IP 判斷用 `request.socket.remoteAddress`——若
  部署在反向代理(nginx/Cloudflare 等)之後,這個值會是代理伺服器自己的
  IP,而不是真正的終端使用者 IP(除非額外解析 `X-Forwarded-For` 之類的
  header,而這個 header 本身在沒有信任的代理清單時可以被 client 端偽造,
  貿然信任反而引入新的繞過手段)。這輪範圍是「Core 直接對外(或透過單純的
  TCP/port 轉發)曝露」這個部署情境,反向代理情境下的正確 IP 判斷留給之後
  視實際部署拓樸決定。
- rate limiting 的封鎖範圍是「這個 IP 的下一次認證嘗試」,不會主動關閉/
  終止該 IP**目前已經開著**的其他未認證連線(它們仍然各自受
  `AUTH_TIMEOUT_MS` 逾時保護,只是不會因為 rate limit 而提早關閉)——這是
  刻意的簡化(rate limiter 只在處理 `auth` 訊息時查詢,不會主動遍歷/關閉
  現有連線),多數情況下影響有限(未認證連線本來就不能做任何事)。
- 瀏覽器連線畫面的 `probeGatewayConnection()`(探測用的獨立 WebSocket)沒有
  對外提供「取消進行中的探測」的方式——使用者在連線中途改變心意重新送出
  表單,舊的探測請求仍會在背景跑到自己的逾時(8 秒)或完成為止,只是其結果
  會被忽略(`settled` 旗標避免重複 resolve/reject,但沒有真的呼叫
  `ws.close()` 提早中止舊請求,除非它自己先逾時或出錯)。這個殘留連線不會
  造成功能性錯誤,只是多佔用最多 8 秒的一條 WS 連線,留給之後視需要優化成
  可取消的探測。
- 響應式支援的驗證方式是**用 Tailwind `sm:` 斷點的 CSS 邏輯 + 手動檢視程式
  碼**(改動範圍本身刻意小、沿用既有 breakpoint,沒有新增任何 UI 框架),
  沒有用真實手機/瀏覽器裝置或自動化的視覺回歸測試(例如 Playwright 搭配
  多種 viewport 尺寸截圖比對)驗證過實際渲染結果——e2e 覆蓋的是「HTTP 靜態
  服務 + WS 協議層」這個瀏覽器 client 賴以運作的後端基礎,不包含前端
  響應式 CSS 本身的視覺驗證,留給之後有需要時再補。

**M5 Round D 範圍內的簡化與已知問題**
- `claude-agent-sdk` 的憑證偵測只檢查 `ANTHROPIC_API_KEY` 環境變數是否設定,
  **不會**嘗試探測 Claude CLI 自己的登入憑證檔案(位置/格式因平台/版本而異,
  沒有穩定公開的探測方式)——已用 `claude login` 完成本機登入、但沒有設定
  `ANTHROPIC_API_KEY` 的使用者,`credentialHint` 會顯示「憑證狀態未知」而
  非「已登入」,這是刻意的保守選擇(見 `apps/core/src/detect/agent-detector.ts`
  的 `detectClaudeAgentSdk()` 註解),避免誤報。
- 外部 CLI(claude/gemini/opencode/codex/aider)這輪只偵測「安裝與否 +
  版本」,**不列出**任何一個的可用 model 清單(`models: []` + `modelsNote`
  說明由該工具自行管理)——不嘗試臆測或跑任何可能互動式/昂貴的「列出
  model」指令,見需求範圍的明確取捨。
- `codex` 這個 `software` 分類目前只有 `AgentSoftwareSchema` 列舉值存在,
  `AdapterRegistry`(`apps/core/src/index.ts`)尚未真正註冊對應的
  adapter(仍是既有 TODO,見上方「架構範圍」)——這輪的偵測純粹是「回報本機
  裝了這個 CLI」,不代表 Deskmony 現在就能真的用它建立 session(建立
  `software="codex"` 的 `AgentProfile` 目前仍會在 `session.create` 時因
  `AdapterRegistry.get()` 找不到對應 adapter 而失敗)。**`opencode` 這輪起
  已經是例外**——`OpenCodeAdapter` 已實作並註冊,見上方「OpenCodeAdapter」
  章節;這段文字保留 M5 Round D 當下對 opencode/codex 一視同仁的原始描述,
  純粹供歷史對照。
- `SettingsDialog` 不會自動輪詢重新偵測——`connect()` 時跑一次、對話框
  mount 時若還沒有結果會補跑一次,之後只有使用者明確按「重新偵測」才會
  再查一次。若使用者在 Deskmony 執行期間才安裝/移除某個 CLI,畫面上的
  「已安裝」狀態不會自動更新,需要手動重新偵測。
- 找執行檔的方式(`where`/`which`)本質上是「依 `PATH` 環境變數目前的設定
  找同名執行檔」——如果 `PATH` 上排在前面的是一個惡意的同名檔案(例如攻擊者
  在使用者可寫的目錄放了一個假的 `claude.cmd` 並把該目錄插到 `PATH` 前段),
  探測會找到並執行那個假檔案的 `--version`。這是任何「依名稱在 PATH 上找
  執行檔」機制的固有限制,不是這個功能新引入的漏洞(`AcpAdapter`/
  `GenericPtyAdapter` 依使用者設定的 `command` 字串 spawn 子程序時,本來就
  有同樣的 PATH 解析行為)——這裡的偵測範圍與既有的信任假設一致(本機環境
  本身是受信任的),不額外強化。

**M4 Round A 範圍內的簡化與已知問題(部分已於 M4 Round B 解決,見下方標註)**
- ~~`request_review` MCP 工具仍未實作~~ **已於 M4 Round B 補上**(見上方
  「M4 Round B 完成度」與 ARCHITECTURE.md 4.6 節)。
- ~~`merging → done` 這個狀態轉換本身合法,但「真的把 worktree 分支合併回
  主幹」沒有自動化~~ **已於 M4 Round B 補上**(`WorkspaceManager.mergeWorkspace()`
  + `TaskService.mergeAndComplete()`,見上方「M4 Round B 完成度」)。
- worktree 不會在任務進入 `done` 時自動清理(刻意的設計決策,見上方「M4
  Round A 完成度」),只有明確呼叫 `task.delete` 才會清理。這代表一個 team
  若累積很多已完成但還沒刪除的任務,`.deskmony-worktrees/` 底下的磁碟空間
  會持續累積——目前沒有任何自動回收機制(例如「done 超過 N 天自動清理」),
  留給之後視需要優化。
- ~~`WorkspaceManager.removeWorkspace()` 用 `git worktree remove --force`,
  這會不詢問確認地丟棄該 worktree 內任何尚未 commit 的變更,目前
  `task.delete` 沒有先檢查並警告使用者~~ **已於 M4 Round B 補上
  `hadUncommittedChanges` 旗標**(見上方「M4 Round B 完成度」)——注意這個
  旗標**不阻擋刪除**,只是事後警告,不是真的擋下強制刪除這個操作本身
  (見該節的完整設計說明)。
- `task.assign` 只允許從 `backlog` 指派(`isValidTransition` 只有
  `backlog → assigned` 這條路);沒有「重新指派給另一個成員」的操作(要換人
  只能先手動把任務轉成其他狀態再想辦法回到 backlog,但目前的狀態機也沒有
  提供「回到 backlog」這條路)——這個產品行為(換人指派該怎麼處理已建立的
  worktree?)留給之後的 round 決定。
- `team.removeMember` 目前不會連動處理該成員手上已指派的任務(不會自動
  unassign 或標記為 blocked)——這跟 M3 Round A 就記錄的「`team.removeMember`
  不連動處理活躍 session」是同一類已知問題,這輪沒有一併解決。
- `message.reportStatus` 這個新 gateway 方法目前對呼叫者沒有任何額外授權
  檢查(只要知道 `teamId`/`fromMemberId` 就能代表任何成員回報狀態)——這輪
  範圍把它定位成「內部/測試/未來 UI 用的橋接方法」,比照 `message.send`
  對人類插話同樣沒有身分驗證的既有慣例(見 README「已知限制」對 M5 認證的
  規劃),不是這輪新增的額外風險,但也沒有加強。

**M3 Round A 範圍內的簡化與已知問題**
- `team.removeMember` 目前只刪除 `team_members` 資料列,不會連帶處理該成員
  現有的活躍 session(不會自動 `session.delete`)—— 之後若該成員被移除但
  session 仍在跑,`MessageBus` 的 `memberSessions`/`sessionMembers` map
  會變成孤兒對應(下一次該 session 送 `session-updated` 時
  `getMemberIdForSession()` 仍查得到已被移除的 memberId)。**M3 Round B
  現況**:`TeamManagementDialog` 的「移除」按鈕直接呼叫 `team.removeMember`,
  沒有另外處理對應的活躍 session(UI 沒有擋、也沒有連動刪除),這個已知問題
  這輪維持原狀,仍留給之後檢討(需要決定「移除成員時該不該連動刪除
  session」這個產品行為,而不只是修 bug)。
- Mailbox 是純記憶體結構,不落地 —— core 重啟後尚未 flush 的排隊訊息會
  遺失(但已經持久化的 `team_messages` 紀錄本身不會遺失,只是不會自動
  補投)。這跟 M1 就有的「session 不支援 resume/continue,core 重啟後執行中
  的 agent process 會結束」是同一類簡化,一併留給之後檢討。
- `team.list` 的結果把每個 team 的成員陣列整個嵌進去(`TeamWithMembers`),
  沒有另外提供分頁或只查單一 team 成員清單的方法 —— 目前規模下足夠,量大後
  可能需要調整。

**M3 Round B 範圍內的簡化與已知問題**
- `TeamChatView` 沒有做虛擬列表(任務描述列為非必要),訊息陣列變動時整份
  重新渲染 —— 目前規模下(一般 team 群聊的訊息量遠小於單一 session 逐字元
  串流的量級)沒有明顯卡頓,但沒有上限保護,理論上長時間掛著的 team 群聊
  累積數千則訊息後可能需要虛擬列表或分頁,留給之後視需要優化。
- `team.teammates` 的成員 session 狀態刷新是「訂閱既有的
  `session-updated`/`session-list-updated` 頻道 → 重新整理目前正在檢視的
  team」,不是逐一精準判斷「這次變動的 session 是否屬於目前這個 team 的成員」
  ——任何 session 的狀態變動都會觸發一次目前 team 的 `team.teammates`
  RPC(不論該 session 是否屬於這個 team),多數情況下影響不大(一次額外的
  查詢),但 session 數量很多、狀態變動很頻繁時可能造成不必要的 RPC 往返,
  留給之後視需要優化成更精準的訂閱範圍。
- `TeamManagementDialog` 建立成員 session 時的工作目錄邏輯是
  「優先用 team 的 `workingDir`,沒有才退回該成員對應 `AgentProfile` 的
  `workingDir`」,兩者都沒設定時會擋下並顯示錯誤訊息——沒有像
  `ProfileCreateDialog` 一樣提供輸入框讓使用者當場覆寫,這輪範圍認為
  「建立 team 時就該先想好 workingDir」是合理的產品假設,之後若有需要可以
  再加。
- interrupt 時序修正(任務 3)刻意限縮在「adapter 的 `interrupt()` 回傳
  `Promise` 並全程 await」,`AcpAdapter`/`GenericPtyAdapter` 因為協議本身
  沒有「中斷確實生效」的回條,只能盡力而為(見上方「interrupt 時序修正
  結論」)——這兩個 adapter 的 interrupt 時序保證因此比
  `ClaudeAgentSdkAdapter` 弱,是協議層面的限制,不是這次修正能解決的範圍
  (e2e 步驟 14 只驗證了 `ClaudeAgentSdkAdapter` 這條路徑,ACP/PTY 的
  interrupt 沒有新增對應的真實時序測試,維持既有步驟 9c/9d、10c 的既有
  覆蓋範圍)。

**e2e 的殘留 flakiness(M2 Round A 觀察,M3 Round A 新增步驟 13、M3 Round B
新增步驟 14g 同樣受影響)**
- 步驟 0 的 session 隔離修法解決的是「一步拖過預算連鎖污染其他步驟判定」
  的問題,**不是**模型本身的不確定性 —— 步驟 5(deny)的 prompt 要求模型
  呼叫寫檔工具,但模型偶爾會在該輪選擇不呼叫任何工具(例如改用文字回覆),
  導致 `permission-request` 事件數為 0、該步驟單獨判定 FAIL。本機反覆執行
  `node scripts/e2e-gateway.mjs` 5 次的觀察:4 次 17/17 全 PASS,1 次
  16/17(僅步驟 5 單獨 FAIL,`permission-request=false(共 0 次)`,其餘
  16 項不受影響、正常 PASS)—— 隔離修法達成了「一步失敗不得影響其他步驟
  判定」的目標,但無法消除步驟 5 本身依賴真實模型行為的殘留
  flakiness(約 20% 的觀察頻率,樣本數小,僅供參考)。這類 flake 只能透過
  換用步驟 9 的 fake ACP agent 那種完全決定性的測試手法根除;M2 Round B 新增
  的步驟 10(pty)、步驟 11(`.cmd` 修復),以及 M3 Round A 新增的步驟 12
  (MessageBus)都比照這個作法,全程不叫真實模型,本機反覆執行皆 100%
  決定性 PASS,不受這個 flake 影響。
- **步驟 13(M3 Round A 新增,team-bus MCP 工具)是同一類 flake 的新增樣本**:
  prompt 要求模型呼叫 `send_message` 工具,理論上模型也可能該輪選擇不呼叫
  任何工具(比照步驟 5 的行為模式)。本機反覆執行 2 次皆 PASS(模型兩次都
  確實呼叫了工具),樣本數小,尚未觀察到 FAIL,但架構上與步驟 5 同源,不能
  排除之後偶發 FAIL 的可能;若發生,detail 訊息會明確標註「屬已知 flake」,
  不應被誤判為 regression。
- **步驟 14g(M3 Round B 新增,interrupt 之後 assistant 是否照字面回覆確認碼)
  是同一類 flake,已實際觀察到一次 FAIL**:本機反覆執行 2 次,第 1 次
  14g 單獨 FAIL(模型選擇用自己的話回應,沒有照字面重複確認碼字串)、第 2
  次 14g PASS。這個子步驟本質上是「軟性佐證」——步驟 14 真正的決定性證據是
  14c/14d/14e 這三個硬性子步驟(兩次執行皆 100% PASS),14g 只是錦上添花的
  額外佐證,FAIL 時 detail 會明確標註「屬已知 flake」,不影響步驟 14 整體
  結論。步驟 14f(原任務是否確實被中斷)理論上也可能因為模型剛好在送出
  interrupt 前就已經自然跑完而失去代表性,但本機兩次執行都 PASS,尚未觀察到
  這個邊界情況實際發生。

**M2 Round B 範圍內的簡化與已知問題**
- `GenericPtyAdapter` 的 `cols`/`rows` 只能在 spawn 當下決定,`AgentAdapter`
  介面尚未有 `resize()` 方法;UI 端 xterm 容器 resize 只影響前端顯示,不會
  回傳給後端的實際 pty(pty 內部 CLI 的自動換行寬度判斷不受影響)。
- `node-pty` 在 Windows 走預設 ConPTY 模式下,`kill()` 觸發的內部診斷子程序
  在無真實 console 的環境(`apps/core` 這種背景執行的情境)會印出一段無害的
  `AttachConsole failed` stderr trace,不影響功能、不留殘留 process(見上方
  「node-pty 安裝結果」章節的完整說明),純粹是上游行為,可安全忽略。
- `interrupt()` 對 pty session 只是送出 `\x03`(Ctrl+C)這個終端慣例按鍵,
  不是像 ACP `session/cancel` 那樣有結構化的取消語意 —— 前景程式若完全吃掉
  輸入不理會 SIGINT(某些 TUI),目前沒有更強的手段。
- pty session 的 busy/idle 判斷是活動量測的簡化實作(見上方 SessionManager
  設計決策說明),不是真正理解終端語意,理論上存在「輸出間隔剛好略大於
  800ms 但邏輯上其實還在同一輪」的邊界情況;e2e 步驟 10b 驗證的是最常見的
  單行輸入/輸出情境。
- `apps/desktop` 的 production bundle 因為新增 `@xterm/xterm` 超過 Vite 預設
  的 500KB chunk 警告門檻(純警告,不影響建置成功或功能),尚未做
  code-splitting,留給之後視需要優化。

**M1 範圍內的簡化與已知問題**
- `AgentProfile` 目前只在記憶體中提供(啟動時注入一個預設的
  `default-claude-code` profile),尚未落地成資料表;`profile.create` 呼叫
  後的 profile 在 core 重啟後會消失。
- SQLite schema 用「啟動時 `CREATE TABLE IF NOT EXISTS`」的方式自我修復,
  尚未導入 `drizzle-kit` 的 migration 檔案流程。
- `ClaudeAgentSdkAdapter` 尚未支援 session 的 resume/continue(SDK 有提供
  相關 API,但 M1 每個 Deskmony session 對應一個全新的 `query()` process,
  一旦 core 重啟,運行中的 agent process 就會結束,需要在 UI 重新建立對話)。
- `tool-call` 事件在 SDK 送出 `content_block_start`(區塊剛開始、`input`
  尚未知道)時就會先提早送出一次(讓 UI 能在工具實際執行前顯示「執行中」),
  等 SDK 送出「完整」assistant 訊息時再送一次帶完整 `input` 的版本,兩者以
  `toolCallId` upsert 合併;但尚未處理 `input_json_delta` 的逐字累積顯示
  (input 在完整訊息抵達前 UI 端會是空的)。
- `SDKMessage` 是一個非常大的 union(讀取 SDK 的 `.d.ts` 得知有 40+ 種子
  type),`ClaudeAgentSdkAdapter` 目前只顯式處理 M1 聊天流程需要的子集
  (`stream_event` / `assistant` / `user` / `result` / `system`),其餘型別
  在 `default` 分支被忽略,未來可依需要擴充(例如
  `SDKPermissionDeniedMessage`、`SDKRateLimitEvent`、`SDKAuthStatusMessage`
  等)。
- `PermissionGateway` 的逾時自動拒絕(以及使用者自己在 UI 回覆)都會透過
  Gateway 的 `permission-resolved` 事件推播給所有 client,讓 UI 的權限彈窗
  即使不是自己這個 client 觸發的解決也會自動消失;逾時的情況還會在該
  session 的聊天串加一則「權限請求已逾時,自動拒絕」的 system 訊息。
- ~~尚未做 Electron 打包(`electron-builder` 等)與正式發版流程~~ **已補上
  `pnpm package` / `pnpm package:dir`**(見下方「Electron 打包/發版」章節)。
- **`better-sqlite3` 原生模組與 Electron 內建 Node 的 ABI 不相容問題**:
  `better-sqlite3` 是在 `pnpm install` 時用「系統 Node」的 ABI
  (`NODE_MODULE_VERSION`)編譯的原生模組(本機為 Node 22,對應 127)。
  Electron 33.4.11 內建的 Node 要求 `NODE_MODULE_VERSION` 130,兩者不相容 ——
  若 Electron main process 用 `ELECTRON_RUN_AS_NODE=1` + `process.execPath`
  借用 Electron 內建 Node 執行 `apps/core`,core 一啟動就會因載入
  `better-sqlite3` 的 `.node` 檔案 ABI 不符而以 `ERR_DLOPEN_FAILED` crash,
  完全無法從 Electron 建立 session(此問題已由 `node scripts/e2e-gateway.mjs`
  的步驟 8 重現並驗證修復)。
  **dev 階段**:`apps/desktop/electron/main.ts` 的 `startCore()` 優先偵測並
  使用**系統安裝的 Node.js**(`where node.exe` / `which node`)來 spawn
  `apps/core/dist/index.js`,不設定 `ELECTRON_RUN_AS_NODE`,因為系統 Node 與
  `better-sqlite3` 的編譯 ABI 天然一致。只有在系統完全找不到 Node 時才會退回
  `ELECTRON_RUN_AS_NODE` 方式,並在 console 印出 ABI 不相容風險的警告;這種
  情況下 core 仍可能 crash。main process 會在 core 於啟動後 10 秒內以非 0
  結束碼結束時,用 `dialog.showErrorBox` 跳出「Core 啟動失敗」對話框(含結束
  碼),提示查看終端機輸出。
  **打包階段:已解決**(`scripts/bundle-core.mjs`)。正式打包後不能假設終端
  使用者裝了 Node,因此 `apps/desktop/electron/main.ts` 的 `startCore()` 在
  `app.isPackaged` 時一律改用 `ELECTRON_RUN_AS_NODE=1` 借用 Electron 內建的
  Node 執行 core(不再嘗試找系統 Node)。要讓這條路徑不 crash,
  `scripts/bundle-core.mjs` 在 `pnpm deploy --filter @deskmony/core --prod`
  部署出 `core-bundle/` 之後,用 `@electron/rebuild` 針對**這個 Electron 版本**
  的 ABI 重新編譯一份 `better-sqlite3`(`onlyModules: ["better-sqlite3"]`,只動
  這份獨立部署的副本,不影響 repo 根目錄/workspace 給 `pnpm dev:core`/e2e 用的
  `node_modules`)。`node-pty` 不需要這道重編——它是 N-API(`node-addon-api`)
  建置的原生模組,N-API 是 ABI 穩定介面,同一份 prebuilt 二進位可以同時被系統
  Node 與 Electron 內建 Node 載入(已實測驗證)。這個修法已由
  `node scripts/package-smoke.mjs` 驗證:在完全過濾掉系統 Node.js 的 PATH 下
  啟動打包後的 exe,core 子程序正常啟動、無任何 ABI 不相容錯誤字樣。
- **打包後的第二個 bug:ESM 模組解析(`ERR_MODULE_NOT_FOUND`)——已解決**:
  ABI 問題修復後的第一次完整打包驗證(`pnpm package:dir` 後實際啟動
  unpacked exe)發現 core 子程序仍然啟動失敗,stderr 印出
  `Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@deskmony/adapters'`。
  根因:`scripts/bundle-core.mjs` 把 `pnpm deploy` 部署出來的 `node_modules`
  改名成 `_modules`,躲過 electron-builder 對 `extraResources` 的過濾(見下一段
  「為什麼要 rename」);`apps/desktop/electron/main.ts` 原本試圖用
  `env.NODE_PATH = <_modules 路徑>` 讓 core 找到依賴。但 `apps/core/package.json`
  是 `"type": "module"`(ESM 專案),`apps/core/dist/index.js` 用
  `import "@deskmony/adapters"` 這種 ESM import——Node 的 **ESM resolver 完全
  不查 `NODE_PATH`**(這是 Node.js 官方文件明載的行為,`NODE_PATH` 只對 CJS
  `require()` 有效)。而且不論 CJS 或 ESM,Node 的模組解析演算法都是沿著目錄樹
  往上找一個**字面上叫做 `node_modules`** 的資料夾——改名成 `_modules` 之後,
  兩種模組系統都找不到依賴,`NODE_PATH` 這個補丁對這個 ESM 專案從一開始就完全
  無效,是死程式碼(已從 `main.ts` 移除)。
  **為什麼要 rename(已實測驗證,不是延續舊註解假設)**:在改動前先做過對照
  實驗——暫時停用 rename、跑一次 `pnpm package:dir`,`core-bundle/node_modules`
  底下有 139 個項目,複製到 `release/win-unpacked/resources/core/` 之後這個
  目錄完全消失(不是部分過濾)。追到根因是 `app-builder-lib`(electron-builder
  的核心套件)`out/util/filter.js` 的 `createFilter()` 有一段寫死的邏輯
  `if (relative === "node_modules") return false`——純字串比對來源樹裡的相對
  路徑,不看該路徑底下實際是不是一個真正的目錄。因此 rename 這一步是必要的。
  **最終修法**:在 `apps/desktop/package.json` 的 `build.afterPack` 掛一個
  electron-builder hook(`apps/desktop/scripts/after-pack.mjs`),在
  extraResources **複製完成之後**(這個時間點之後 electron-builder 不會再對
  `resources/core/` 底下的內容做任何名稱過濾)才在這個「輸出」目錄底下建立一個
  名叫 `node_modules` 的 Windows 目錄 junction 指向同一層的 `_modules`
  (`fs.symlinkSync("_modules", junctionPath, "junction")`)。**曾經嘗試在
  `bundle-core.mjs` 的 rename 之後、也就是在「來源」`core-bundle/` 目錄裡直接
  建立這個 junction,已實測驗證這樣行不通**——`filter.js` 的過濾邏輯是純字串
  比對相對路徑,junction 與真正的目錄一樣會被過濾掉,複製後的
  `resources/core/` 底下一樣沒有 `node_modules`;junction 必須建在
  electron-builder 已經完成複製之後的輸出目錄,過濾邏輯才不會再套用。執行期
  Node 的模組解析器沿著目錄樹往上找,在 `dist/` 的上一層看到一個叫
  `node_modules` 的目錄(對 `fs` 層級操作,junction 與真正的目錄完全透明),
  於是能正確解析 `@deskmony/adapters` 等依賴,不論是 CJS `require()` 還是 ESM
  `import`。Windows 上用 `fs.symlinkSync(target, linkPath, "junction")` 建立
  目錄 junction **不需要系統管理員權限**(這點與一般 symlink 不同——一般
  symlink 預設需要系統管理員權限或先開啟「開發人員模式」;junction 是 NTFS
  原生機制,任何使用者都能建立)——已在本機以一般使用者權限反覆實測成功
  (`pnpm package:dir` 全程沒有任何權限錯誤或 UAC 提示)。
- **打包後的第三個 bug:preload script 的 ESM/CommonJS 相容性
  (`SyntaxError: Cannot use import statement outside a module`)——已解決**:
  使用者實測回報,安裝 `pnpm package` 產出的安裝檔並啟動 `Deskmony.exe` 後,
  Electron **桌面殼視窗本身**顯示的是只該給純瀏覽器分頁看的「連線到
  Deskmony Core」畫面(`ConnectScreen`,見 `src/App.tsx` 的
  `hasElectronBridge` 判斷),而不是直接進入聊天介面。
  **診斷方式**:先在 `main.ts` 暫時強制對打包後的視窗也開啟 DevTools
  (`webContents.openDevTools()`,平時只有 dev 模式會開),重新
  `pnpm package:dir` 並啟動 `release/win-unpacked/Deskmony.exe`,在 DevTools
  的 Console 分頁親眼看到:
  ```
  Unable to load preload script: .../resources/app.asar/dist-electron/preload.js
  SyntaxError: Cannot use import statement outside a module
      at runPreloadScript (VM4_sandbox_bundle:2:151950)
      ...
  ```
  （驗證完後這段暫時性的 `openDevTools()` 已移除,不是正式行為。）
  **根因**:`apps/desktop/package.json` 宣告 `"type": "module"`,
  `tsconfig.electron.json` 用 `"module": "NodeNext"` 編譯,`preload.ts`
  編譯出來的 `dist-electron/preload.js` 是 ESM 語法
  (`import { contextBridge } from "electron";`)。這對 `main.ts` 沒問題 ——
  Electron main process 本來就用 Node 的 ESM loader 執行。但 Electron 載入
  傳統(非 sandbox,見 `main.ts` 的 `webPreferences: { preload }`)preload
  script 的機制(`runPreloadScript`)是用 CommonJS 的方式**同步**執行 preload
  檔案內容,不支援檔案裡出現 `import` 陳述式,即使 Electron 33 內建的 Node
  版本本身完全支援 ESM 也一樣——這是 preload script 載入器本身的限制,與
  Node 版本無關。結果是 `contextBridge.exposeInMainWorld("deskmony", ...)`
  那行完全沒有執行到,renderer 讀不到 `window.deskmony`,`App.tsx` 的
  `hasElectronBridge` 判斷為 `false`,誤判成瀏覽器分頁場景,顯示
  `ConnectScreen`。
  **為什麼 dev 模式(`pnpm dev:electron`)沒有先前被發現這個問題**:dev
  模式下也是同一份編譯結果(同一個 `dist-electron/preload.js`,同樣是 ESM
  語法),**同樣會出現這個 bug**(已重新實測確認,不是猜測)——這不是
  「只有打包後才壞」的問題,是先前的驗證輪次没有從一個乾淨的視窗實際檢查過
  `window.deskmony`/DevTools console,單純沒被抓到。
  **修法**:把 `electron/preload.ts` 改用 `.cts` 副檔名
  (`electron/preload.cts`,TypeScript 4.7+ 支援)——`.cts` 檔案一律被當成
  CommonJS 模組編譯,固定產出 `.cjs` 檔案(`dist-electron/preload.cjs`),且
  **不受**同目錄 `package.json` 的 `"type": "module"` 宣告影響;Node/Electron
  對 `.cjs` 副檔名一律當 CommonJS 載入,這是 Node 官方文件明載的行為。
  `main.ts` 保持 `.ts`(仍走 NodeNext ESM 編譯,行為完全不變,只有
  `webPreferences.preload` 那一行路徑從 `preload.js` 改成 `preload.cjs`)。
  沒有拆成兩份 tsconfig——`.cts`/`.mts` 副檔名本身就會讓 TypeScript 忽略
  `tsconfig.json` 的 `module` 設定、固定套用對應的模組系統,不需要額外的
  編譯設定檔。
  **驗證**:重新 `pnpm package:dir` 後,打包後的 exe 開啟 DevTools 不再出現
  上述錯誤;正常啟動(不開 DevTools)後視窗直接顯示聊天介面(「Sessions」
  側欄 + 頂部「已連線」狀態),不再彈出 `ConnectScreen`。`pnpm dev:electron`
  同樣直接進入聊天介面。`node scripts/e2e-gateway.mjs --only=deterministic`
  62/62 PASS、`node scripts/package-smoke.mjs` PASS(這兩支腳本驗證的是
  core 子程序/WS Gateway 這條路,不涉及 renderer 是否讀到
  `window.deskmony`,因此没有能夠先前抓到這個 bug——這也是為什麼這個問題
  一直存在到使用者實測才被發現)。
- 尚未撰寫自動化測試(unit/e2e)。上述功能驗證方式為:1) 全 workspace
  `tsc --noEmit` 與 `pnpm build` 全綠;2) 手動起 `apps/core` 並用簡單腳本
  對 WebSocket Gateway 送出 `profile.list` / `session.list` 驗證
  request/response 協議正確;3) 實際透過 UI 對談需要有效的 Claude Code
  登入憑證,建議在本機以 `pnpm dev:electron` 手動驗證一次完整對話 + 工具呼叫
  + 權限彈窗流程。

## Electron 打包/發版

```bash
pnpm package:dir     # 打包成未壓縮的 release/win-unpacked/(快,適合本機驗證)
pnpm package          # 打包成 NSIS 安裝檔(release/*.exe)
```

`pnpm package`/`pnpm package:dir` 等同 `pnpm --filter @deskmony/desktop run
package`/`package:dir`,實際流程是 `bundle:core`(`scripts/bundle-core.mjs`:
build core → `pnpm deploy --prod` 部署依賴 → electron-rebuild 重編
`better-sqlite3` → rename `node_modules` → `_modules`)→ `build`(`vite
build` + electron 主程式編譯)→ `electron-builder --win`。`electron-builder`
的 `afterPack` hook(`apps/desktop/scripts/after-pack.mjs`)在複製完成後補上
`node_modules` junction(見上方「ESM 模組解析」說明)。

`build.extraResources` 這輪額外新增一筆:把 `apps/desktop/dist`(Vite build
產物)複製到 `resources/desktop-ui`,與放 core 依賴的 `resources/core` 分開
(語意上是兩種不同的資源,刻意不叫 `resources/desktop` 避免與其他資源撞名/
混淆)。`electron/main.ts` 的 `startCore()` 在 `app.isPackaged` 時把
`env.DESKMONY_STATIC_DIR` 指向這個目錄,讓打包後的 core 子程序也能正確找到
瀏覽器 UI 靜態檔案(完整背景見上方「瀏覽器存取方式與安全界線」)。

### `scripts/package-smoke.mjs`(打包迴歸測試)

驗證 `pnpm package:dir` 產出的 `release/win-unpacked/Deskmony.exe` 在**完全
找不到系統 Node.js 的機器上**也能正常啟動 core 子程序、開放 WS Gateway、並
正確提供瀏覽器 UI 靜態檔案——同時覆蓋了上面三個已解決的打包 bug(ABI 不相容、
ESM 模組解析、`DESKMONY_STATIC_DIR` 未指向 `resources/desktop-ui`)的迴歸
防護:

```bash
node scripts/package-smoke.mjs              # 完整跑:先 pnpm package:dir 再驗證
node scripts/package-smoke.mjs --skip-build  # 略過 pnpm package:dir,直接驗證既有的
                                              # release/win-unpacked/(手動重跑加速用)
```

流程:組一份過濾掉所有 `node.exe` 所在目錄的 PATH 啟動 exe(模擬使用者機器
沒裝 Node)→ 輪詢 WS port 是否開始監聽 → 送一次 `auth` request 驗證 core 真的
正常運作(不是視窗開著但 core 其實已經 crash)→ 對同一個 port 的 `GET /` 做
一次真的 HTTP 請求,斷言狀態碼 200 且回應內容是真正的 `index.html`(含
`<title>Deskmony</title>` 字樣),不是 `static-server.ts` 在找不到
`index.html` 時的 404 fallback 文字→ 全程掃描 stdout/stderr 是否出現
`ERR_DLOPEN_FAILED`/`NODE_MODULE_VERSION`/ABI 不相容字樣,或「找不到瀏覽器
UI 靜態檔案」這則警告,任何一個出現
就視為 FAIL → 結束時用 `taskkill /T /F` 收掉整個 process tree(exe + core 子
程序)並刪除暫存 `DESKMONY_DATA_DIR`。這支腳本覆蓋「core 子程序完全無法啟動」
(ABI、模組解析)與「core 啟動但瀏覽器 UI 靜態檔案沒帶到」這兩類錯誤字樣/
HTTP 回應掃描,不驗證實際 UI 渲染或完整業務功能(這是 `e2e-gateway.mjs` 的
範圍,兩者互補,不重複)。

### 打包範圍內的已知限制(刻意不在這輪處理)

- **不含應用程式圖示**(`apps/desktop/package.json` 的 `build.win.icon` 為
  `null`):打包產物使用 electron-builder 的預設 Electron 圖示,沒有另外設計/
  提供 `.ico`,純粹是美術資產缺口,不影響功能。
- **不含 code signing**:`electron-builder` 的 `signtool.exe` 呼叫在本機是用
  一份自我簽署或未簽署的憑證(本機環境沒有設定正式的 code signing
  憑證/`CSC_LINK`),終端使用者安裝/執行時 Windows SmartScreen 可能顯示
  「未知發行者」警告。正式對外發版前需要取得並設定正式的 code signing 憑證,
  這輪範圍不含。
- **只支援 Windows**:`scripts/package-smoke.mjs`、`apps/desktop/package.json`
  的 `build.win`/`build.nsis` 設定、`apps/desktop/scripts/after-pack.mjs` 的
  junction 邏輯都是 Windows 專用(macOS/Linux 不需要 `_modules` rename 這條
  路——electron-builder 在其他平台上是否有同樣的 `node_modules` 過濾行為、以及
  macOS/Linux 是否需要對應的 symlink 修法,這輪沒有驗證,留給之後若要支援
  跨平台打包時再處理)。`apps/core/package.json` 的 `better-sqlite3` 在其他
  平台上是否也需要 electron-rebuild 這輪同樣沒有驗證。
