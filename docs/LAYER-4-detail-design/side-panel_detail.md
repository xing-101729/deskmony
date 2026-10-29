# 右側面板:Terminal / Browser / Changes / Files(2026-10-20)

> 狀態:**規格定案,實作中**。分支 `feat/side-panel`(從 `feat/simplify-agent-sessions` 9c64b49 開)。
> 對應決策:[`DECISIONS.md` §L](../DECISIONS.md)(本輪新增)。
>
> 使用者 2026-10-20 的需求原文:「我想要做到有 side windows,像是 claude code 可以整合 terminal、browser 等功能」。
>
> 追問後的定案(使用者親自選的,實作不得偏離):
>
> | # | 問題 | 定案 |
> |---|---|---|
> | Q1 | 第一版放哪些分頁 | **Terminal、Browser、Changes、Files 四個全做** |
> | Q2 | 瀏覽器要不要讓 agent 操作 | **第一版就讓 agent 操作**(navigate/截圖/讀頁面/點擊/輸入) |
> | Q3 | 終端能不能遠端用 | **遠端也可用**(不列入 `LOCAL_ONLY_METHODS`) |
> | Q4 | 終端跟 session 的關係 | **跟著 session**:每個 session 自己一組終端,cwd = 該 session 的工作資料夾;session 刪除時一併關掉;app/core 重啟後不保留 |
> | Q5 | agent 開 localhost 要不要豁免 hard-deny 的「非白名單外連」 | **只豁免瀏覽器工具的 loopback**;仍走一般政策(未開 auto 會問、可「永遠允許」);WebFetch 等其他工具的 C5 定義不動;外部網站仍不放行 |
> | Q6 | 面板瀏覽器的登入狀態 | **每個 session 獨立、不落地**(記憶體 partition,session 刪除或 app 重開就清空) |

---

## 0. 階段(依序實作;一次只跑一個實作者;每階段結束要 `pnpm test` 全綠、commit,review 通過才進下一階段)

| 階段 | 內容 | 驗收重點 |
|---|---|---|
| **P0** | 安全前置:`broadcast()` 不再推播給 scoped bridge 連線 | e2e 斷言 scoped 連線收不到任何 push |
| **P1** | 面板外殼 + Terminal(core `TerminalManager` + gateway + UI) | 新 e2e `e2e-side-panel-terminal` |
| **P2** | Changes + Files(core 唯讀 workspace 查詢 + UI) | 新 e2e `e2e-side-panel-workspace`(含路徑逃逸) |
| **P3** | Browser 分頁(只給人用)+ 隱藏 webview 的可行性實驗 | Electron 安全強化;實驗結果回報後才做 P4b |
| **P4a** | agent 瀏覽器工具:MCP 工具 + core 轉送(relay)+ 政策 | 新 e2e `e2e-side-panel-browser`(假的 browser host) |
| **P4b** | agent 瀏覽器工具:Electron 端執行器 + UI 指示 | 真實 app 驗證(由 review 方執行) |

P0 很小,與 P1 由同一個實作者做,但**各自一個 commit**。

### 全階段共通紀律

- **CRLF**:repo 是 `core.autocrlf=true`、無 `.gitattributes`。用腳本做多行取代先正規化成 LF 再換回去;Git Bash 的 `sed -i` 會剝掉 CR。
- **不要碰主樹**(`D:\AgentTeam\Deskmony` 根目錄的 checkout)——只在 `.claude/worktrees/side-panel` 工作。
- **本機啟 core 驗證要隔離**:同時設 `DESKMONY_HOME`、`DESKMONY_DATA_DIR`、`DESKMONY_WORKSPACE`、`DESKMONY_CORE_PORT` 四個環境變數(port 用 4800–4999 之間沒人用的),否則會碰到使用者真正的 DB。**不准** `taskkill` 全部 node/core 程序,只殺自己啟動的 pid。
- **不要自己啟動真實 Electron app**(P3 實驗與 P4b 的真實驗證由 review 方決定何時跑——這台機器曾在 Electron + agent 實測時藍屏)。可以 build、typecheck、跑 e2e。
- 新 worktree 要先 `pnpm build` 再 `pnpm test`(client typecheck 要 shared 的 dist 型別)。TEMP 設在 D 槽。
- 新增的使用者可見字串:四個語系(`en`、`es`、`ja`、`zh-Hant`)都要有,用詞對照 `apps/desktop/src/locales/GLOSSARY.md`。
- 程式碼註解比照周圍:中文、說明「為什麼」,不寫流水帳。
- commit 訊息英文、祈使句、說明行為改變(比照 `git log` 的既有風格),結尾加
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。PowerShell 下一律寫檔再 `git commit -F`。

---

## P0. `broadcast()` 跳過 scoped bridge 連線

**問題(既有漏洞)**:`WsGateway.broadcast()`(`apps/core/src/gateway/ws-gateway.ts`)把每個 push 送給所有 `authenticated` 連線,
**包含用 scoped MCP bridge token 認證的連線**(`state.scopedGrant` 有值)。bridge 子行程本身完全不讀 push
(`packages/adapters/src/mcp-bridge-server.ts` 只處理 `kind:"response"`),但拿到 bridge token 的人(agent 有辦法從 bridge 子行程讀到)
可以自己開一條 WS,就收得到**所有 session** 的對話事件、權限請求(含工具 input)等。P1 加上終端輸出後,連使用者的 shell 畫面都會外流。

**修法**:`broadcast()` 與任何其他「送 push 給多個連線」的路徑都跳過 `state.scopedGrant !== undefined` 的連線。scoped 連線只收得到自己 request 的 response。
**e2e**:在 `scripts/e2e-session-network.mjs`(它已經會核發 scoped token 並連線)加一組斷言:用 scoped token 連上後觸發幾個會 broadcast 的事件
(例如建立 session、送 prompt),等待一段時間,斷言 scoped 連線**一個 push 都沒收到**;同時斷言一般連線有收到(證明事件確實有發生)。
做反向驗證:暫時拿掉修法跑一次,確認這組斷言會失敗,再放回去(回報裡寫出你做過)。

---

## P1. 面板外殼 + Terminal

### P1.1 core:`apps/core/src/terminal/terminal-manager.ts`(新檔)

- **建立** `create({ sessionId, cols, rows })`:
  - session 必須存在;cwd = `session.workingDir`,資料夾不存在 → 錯誤碼 `terminal.cwdMissing`。
  - shell:Windows 先找 PATH 上的 `pwsh.exe`,沒有就 `powershell.exe`,參數 `-NoLogo`;其他平台 `$SHELL`,沒有就 `/bin/bash`。第一版不提供設定。
  - **環境變數一律經過 `buildAgentChildEnv()`**(`packages/adapters/src/agent-env.ts`)——不然在終端裡開的 CLI(例如使用者自己在裡面跑 `claude`)會繼承
    `DESKMONY_AUTH_TOKEN`。另外加 `TERM=xterm-256color`、`COLORTERM=truecolor`。
  - 用 `node-pty` spawn,寫法比照 `packages/adapters/src/pty-adapter.ts`(含 Windows 的結束/清理方式)。
  - 每個 shell 經 `registerChild()` 登記到 child-registry(崩潰後的孤兒回收),結束時 `unregisterChild()`。
  - 上限:每個 session 8 個、全域 32 個 → `terminal.limitReached`。
  - 回傳 `TerminalInfo`:`{ id, sessionId, title, shell, cwd, cols, rows, createdAt, exitCode?: number | null, closed?: boolean }`。title 預設 `"<shell 名稱> <序號>"`。
- **輸出**:
  - 每個終端一個環狀緩衝,保留最後 512 KB 輸出;每個輸出片段帶單調遞增的 `seq`(每個終端各自從 1 起算)。
  - 同一終端約 16 ms 內的輸出合併成一個 push,降低 WS 訊息量。
- `attach(terminalId)` → `{ terminal: TerminalInfo, buffer: string, seq: number }`:`seq` 是 buffer 內最後一個片段的序號。
  client 先訂閱 push,再呼叫 `attach`,收到後丟掉 `seq <= 回傳 seq` 的 push(避免 attach 與即時輸出之間的重複/遺漏)。
- `input(terminalId, data)`:`data` 上限 64 KB/次。`resize(terminalId, cols, rows)`:cols 夾在 2–500、rows 夾在 1–300。
- `close(terminalId)`:結束 shell(含子程序樹,比照 pty-adapter),從清單移除,發 `terminal-updated`(`closed: true`)。
- **shell 自己結束**(使用者打 `exit`):保留在清單裡、`exitCode` 有值,發 `terminal-updated`;使用者在 UI 關掉或按「重新啟動」才移除。
- **生命週期**:
  - `SessionManager.deleteSession()` 新增 emit `"session-deleted"`(帶 sessionId);`TerminalManager` 在 `apps/core/src/index.ts` 接線時訂閱,關掉該 session 全部終端。
  - core 關閉(既有的 shutdown 路徑)時關掉全部終端。
  - 不持久化:core 重啟後清單是空的。
- `list(sessionId)`。

### P1.2 gateway 與 shared 型別

- `packages/shared`:新檔 `terminal.ts` 放 `TerminalInfo` 等 schema;`gateway.ts` 加 request 與 push schema(比照既有寫法)。
- 方法:`terminal.list {sessionId}`、`terminal.create {sessionId, cols, rows}`、`terminal.attach {terminalId}`、`terminal.input {terminalId, data}`、
  `terminal.resize {terminalId, cols, rows}`、`terminal.close {terminalId}`。
  - **不列入** `LOCAL_ONLY_METHODS`(Q3)。在 `LOCAL_ONLY_METHODS` 上方的註解區塊補一句說明為什麼 terminal 刻意不在裡面,並指向 DECISIONS §L。
  - **不加進** `computeAllowedMethods()`——agent 的 bridge token 永遠不能開終端。
- push:`terminal-output` `{ terminalId, sessionId, seq, data }`、`terminal-updated` `{ terminal: TerminalInfo }`。經 `broadcast()`(P0 之後已不含 scoped 連線)。
- 錯誤碼:`terminal.notFound`、`terminal.cwdMissing`、`terminal.limitReached`、`terminal.sessionNotFound`,加進 desktop 的錯誤翻譯(比照 `lib/error-i18n.ts` 與 `errors-*.json` 的既有分法)。
- `packages/client`:若它對每個方法有包裝(給 desktop 與 CLI 用),比照補上。
- **稽核**:`audit-log.ts` 新增 `kind: "terminal-session"`(寫法比照 `appendNotificationFailure` 這類非 EnforcementEvent 的紀錄),記錄
  `{ action: "create" | "close", terminalId, sessionId, shell, remote: boolean, remoteAddress }`。`remote` 取自發出 request 的那條連線的 `isLocal`。
  shell 自己結束不用記。

### P1.3 desktop:面板外殼

- 新元件 `apps/desktop/src/views/panel/SidePanel.tsx`,放在 `App.tsx` 的主 flex 列裡、`SessionView` 右邊,**自己包一層 ErrorBoundary**(與聊天視圖互不拖累)。
  面板內容永遠對應「目前選取的 session」;沒有選取 session 時顯示空狀態。
- 分頁列用一個分頁註冊陣列產生(`id`、圖示、標題、是否可用、元件),P2–P4 只需要往陣列加項目。P1 只有 Terminal。
- 寬度可拖拉(左緣把手):最小 320 px、最大視窗寬度 70%;開/關狀態、寬度、目前分頁存 localStorage(讀寫都包 try/catch)。
- 窄螢幕(`sm` 以下):面板改成全螢幕覆蓋層,附關閉鈕。
- 開關入口:
  - ChatView 與 TerminalView 標頭各加一顆切換鈕。
  - 快捷鍵 `mod+j` 切換面板(`allowInTerminal: true`);`` ctrl+` `` 開面板並切到 Terminal(沒有終端就自動建一個)。先確認 `ui/hotkeys.ts` 的 `matches()` 吃得到反引號鍵,吃不到就修。
  - 命令面板加:切換面板、新終端、開 Changes、開 Files(P2 之後才有後兩項)。

### P1.4 desktop:Terminal 分頁

- 一個 session 可以有多個終端:分頁列上有子分頁(標題、× 關閉)與「+」新增。面板打開到 Terminal 分頁、但目前 session 還沒有終端時,自動建一個。
- 每個終端一個 xterm 實例;同一 session 內切換子分頁**只隱藏、不 dispose**。切換 session 時 dispose 前一個 session 的實例,切回來再 attach(core 有緩衝)。
- 資料流:比照 `stores/session-store.ts` 的 `onTerminalData` 作法,`terminal-output` 不進 zustand 的響應式 state,用 pub/sub 直接寫入 xterm;attach 的 seq 去重見 P1.1。
- WS 重連後:所有掛著的終端 reset + 重新 attach。
- 主題與字級:把 `views/TerminalView.tsx` 的 `resolveTerminalTheme()` 與 `TERMINAL_BASE_FONT_PX` 換算抽到共用的 `ui/xterm-theme.ts`,兩邊共用;深淺主題切換、字級變動時即時套用、重新 fit 並回報尺寸(debounce,比照 TerminalView)。
- shell 結束:終端底部顯示「程序已結束(代碼 N)」與「重新啟動」鈕(重新啟動 = 關掉舊的、在同一位置建新的)。
- 終端面板聚焦時,`ui/hotkeys.ts` 的 `insideTerminal()` 判斷要涵蓋它(看它是靠 `data-terminal-surface` 判斷的就加上同一個屬性)。
- 既有的 PTY session 視圖(`TerminalView`)行為不變。

### P1.5 e2e:`scripts/e2e-side-panel-terminal.mjs`(加進 `run-e2e.mjs` 的 SUITES)

用隔離的 core(**帶 `DESKMONY_AUTH_TOKEN` 啟動**)+ fake agent 建一個 session(建法比照 `e2e-session-network.mjs`)。至少驗:

1. `terminal.create` 成功、收到 `terminal-updated`;cwd 是 session 的工作資料夾。
2. 送 `echo` 一個隨機標記 + `\r`,在 `terminal-output` 收到標記;`attach` 的 buffer 含標記且 `seq` 正確。
3. **環境變數**:在終端裡印出 `DESKMONY_AUTH_TOKEN`(PowerShell 用 `$env:...`),斷言是空的。
4. `resize` 成功;`input` 超過 64 KB 被拒。
5. `close` 後 shell 的 pid 已不存在、收到 `closed: true`。
6. 刪除 session → 它的終端全部關閉、pid 不存在。
7. 上限:第 9 個(同一 session)被拒,錯誤碼正確。
8. 不存在的 terminalId / sessionId 錯誤碼正確。
9. **scoped bridge token 呼叫 `terminal.create` 被拒**;scoped 連線收不到 `terminal-output`。
10. 稽核表有 `terminal-session` 的 create/close 兩筆。

最後全套 `pnpm test` 綠。

### P0/P1 實作備註(與上文不同或規格沒寫死的地方)

- **node-pty 放在 adapters**:`packages/adapters/src/shell-pty.ts` 的 `spawnShellPty()`,core 的 `TerminalManager` 只認它回傳的最小介面(`ShellPty`)。
  node-pty 是 adapters 的相依(原生模組、打包路徑只有一處),core 不另外宣告一份。終止是**非同步**的(`taskkill /T /F` 用 `spawn`、不是 `spawnSync`),
  理由見該檔案頂端:同步 taskkill 在 WMI 變慢時會卡住整個 core 的事件迴圈。
- **`hasConnectedClient()` 也排除 scoped 連線**(P0 的連帶修正):它的文件寫明判定與 `broadcast()` 一致,scoped 連線不再收 push 之後,
  把它算成「有人看得到彈窗」會讓只剩 bridge 連線的 core(桌面 app 沒開)把 escalate 當成有人在、永遠掛起而不是逾時 deny。
- **稽核只記使用者要求的開/關**:`terminal.create`/`terminal.close` 由 gateway 帶 `{remote, remoteAddress}` 進 `TerminalManager`;
  session 刪除/core 關閉連帶關閉、shell 自己結束都不記(沒有「發出請求的連線」可言)。
- **`terminal.list` 對不存在的 session 回 `terminal.sessionNotFound`**(與 `create` 一致);另加 `terminal.spawnFailed`(shell 啟不起來)。
  `terminal.limitReached` 的 params 帶 `scope`(`session`/`global`)、`limit`、`perSession`、`global`,翻譯文字不依賴 scope。
- **`terminal.input` 的 64 KB 上限以字元數計**(`TERMINAL_INPUT_MAX_CHARS` = 65536),由 schema 驗證拒絕(`gateway.invalidRequest`),不是 manager 內的專屬錯誤碼。
- **全域 32 個上限沒有 e2e**(需要 4 個 session × 8 個真 shell,負載過重);每個 session 8 個有測。
- **面板寬度上限(review 後修正,取代上文「最大視窗寬度 70%」)**:`lib/panel-layout.ts` 的 `computePanelLayout()`——
  面板寬度 = 偏好寬度夾在 [320, min(視窗 70%, 實際量到的可用寬度 − 22rem)];可用寬度是 App.tsx 裡「聊天視圖 + 面板」共用容器的
  實測寬度(側欄展開/收合、字級縮放都已反映,不寫死側欄寬度)。連 22rem + 320 都放不下、或視窗在 `sm` 以下 → 改成全螢幕覆蓋層。
  拖拉同樣受上限限制;**存下來的偏好**在被版面限制時不改寫(拖到上限時存的是上限),空間變大(展開↔收合側欄、放大視窗)就恢復。
- **shell 自己結束後的終端被關閉時不碰它的 pid**(pid 可能已被別的行程重用,taskkill /T /F 會殺到無關的程序樹),
  `ShellPty.kill()` 與 `TerminalManager.closeRecord()` 兩層都擋。
- **面板終端的環境刪掉 `ELECTRON_RUN_AS_NODE`**(打包版 core 帶著它,shell 繼承會讓使用者在終端裡啟動的 Electron 程式變成純 Node);
  只動面板終端(`buildTerminalEnv()`),`buildAgentChildEnv()` 與 agent 的環境不動。`spawnShellPty()` 另外濾掉值是 `undefined` 的鍵
  (node-pty 會把它變成字面的 `"undefined"` 字串)。
- **重新啟動的新終端「在同一位置」**是 client 端的分頁順序(core 的清單依建立順序);重新載入清單後回到建立順序。
- **面板關著時整個不渲染**(xterm 一併 dispose),重新打開時 attach——不是隱藏保留;P3 的 webview 才需要「不能卸載」,到時在分頁註冊陣列加 `keepMounted`。
- 快捷鍵:`hotkeys.ts` 新增 `ctrl` 記號(字面 Ctrl,不隨平台變成 ⌘),`ctrl+\`` 用它;`mod+j` 在 Windows 上就是 Ctrl+J(終端裡的 LF,`allowInTerminal` 照規格攔截)。

---

## P2. Changes + Files

> **實作備註(與下文不同或規格沒寫死的地方,P2 實作時補)**
>
> - **路徑安全**(`apps/core/src/workspace/workspace-paths.ts`):三道關——字面檢查、`fs.realpathSync.native`(目標必須存在;不存在是
>   `workspace.notFound`,**不用** `resolveRealpathBestEffort()`)、`isPathUnder()` 前綴比對(Windows 大小寫不敏感,`normalizeForCompare()` 轉小寫)。
>   用 `.native` 而不是 JS 版 `realpathSync`:Windows 走 `GetFinalPathNameByHandle`,junction、掛載點、8.3 短檔名都由系統解開。
>   字面檢查不分平台拒絕所有絕對路徑寫法(`/x`、`C:\x`、`C:x`、`\\server\share`、`//server/share`、`\x`),Windows 另外拒絕反斜線、冒號(磁碟機/NTFS 資料流)、
>   保留裝置名(`CON`、`NUL.txt`…)、結尾是點或空白的片段(Win32 會把 `.. ` 正規化成 `..`)。
> - **`.git` 不只隱藏,也不可讀**(`listDir`/`readFile` 一律 `workspace.notFound`,不分大小寫):裡面有 remote URL 等設定,隱藏列表卻允許直接讀 `.git/config` 沒有意義。
> - **`gitDiff` 多一個選填的 `oldPath`**(rename/copy 的舊路徑,同樣過路徑檢查):改名後又改的檔案只顯示真正的差異,而不是整個檔案新增。
>   `gitDiff` 的路徑可以不存在(已刪除的追蹤檔)、不跟進最後一段 symlink,所以改檢查「上層資料夾鏈中第一個存在的祖先」的 realpath(`resolveForGit()`);
>   未追蹤檔案才走 `resolveExisting()` + `readFile` 同一套檢查。
> - **hunk 用自己寫的寬鬆解析**(`parseUnifiedDiff()`),不加 `diff` 套件相依:diff 文字會被 512 KB 上限截在 hunk 中間,`parsePatch` 會因行數對不上而丟例外。
>   輸出形狀就是 `structuredPatch` 的 hunk,`DiffHunkView.tsx` 拆出 `DiffHunks` 共用同一份渲染,沒有另寫 diff 元件。
> - **git 執行的防護**(`workspace-git.ts` 檔頭有完整理由):工作資料夾內容是 agent 能寫的(含 `.git/config`、`.gitattributes`),而 Changes 是使用者一打開就跑
>   `git status`/`git diff` 的地方——實測 `core.fsmonitor` 在 status 時執行、`filter.<n>.clean` 在 diff 時執行。所以一律 `-c core.fsmonitor=false`、diff 加
>   `--no-ext-diff --no-textconv`、`--ignore-submodules=all`、**不限 scope** 列舉出來的 filter(`git config --includes --show-scope --name-only --get-regexp`)中,scope 不是
>   `system`/`global` 的**一律**用 `-c filter.<n>.clean=` 覆寫成空(fail-closed:`local`、`worktree`——`extensions.worktreeConfig=true` 時 agent 也寫得到的
>   `.git/config.worktree`,`--local` 看不到——`command`,以及未來新增的任何 scope;`include.path` 引進的檔案沿用引入它的檔案的 scope;`--show-scope` 不被支援時退回「所有 scope 全部中和」;
>   列舉失敗或名稱含 `=`/控制字元就拒絕執行)、
>   `--literal-pathspecs`、`--no-optional-locks`、濾掉繼承來的 `GIT_*` 環境。代價:repo **本地/worktree 層級**設定的 filter(例如 `git lfs install --local`)在這裡被停用,
>   LFS 檔案可能顯示成已修改;使用者全域/系統設定的 filter(全域安裝的 LFS)保留。
> - `status` 多帶 `-b`(取分支名)與 `-- .`:工作資料夾是 repo 子資料夾時只列該資料夾、路徑去掉 repo 前綴;`core.worktree` 指到別處的 repo 視為不是 repo。
>   檔案數上限 5000(`truncated`)。沒有 commit 的 repo 的 diff 對空樹(`git hash-object -t tree --stdin` 取得,SHA-1/SHA-256 repo 都對)。
> - **檔案 symlink 沒測**(這台機器沒權限建立;e2e 會在能建立時加測 `link-file`),junction 有測。
> - 點到 symlink/junction 時 UI 先當檔案讀,`workspace.notAFile` 才改當資料夾展開;指向工作資料夾外的顯示 core 的 `workspace.pathOutsideRoot` 錯誤。

### 原規格

### P2.1 core:`apps/core/src/workspace/workspace-inspector.ts`(新檔,全部唯讀)

**路徑安全(整個 P2 最重要的一段)**:root = `realpath(session.workingDir)`。所有 `path` 參數都是相對 root、以 `/` 分隔的字串:
- 絕對路徑(含 `C:\...`、`\\server\...`、`/...`)→ 拒絕;正規化後含 `..` 片段 → 拒絕;
- 目標的 realpath 必須在 root realpath 之下(擋 symlink/junction 逃逸)——用 `apps/core/src/permissions/tool-input.ts` 的 `isPathUnder()` 與 realpath 作法,不要自己另寫一套前綴比對;
- 違反任何一條 → `workspace.pathOutsideRoot`。

方法(都**不**列入 `LOCAL_ONLY_METHODS`、**不**加進 `computeAllowedMethods()`,理由同終端:遠端已能開 shell,唯讀查看檔案是更弱的能力):

- `workspace.listDir { sessionId, path }` → `{ entries: [{ name, type: "file" | "dir" | "symlink", size, mtimeMs }], truncated }`:
  資料夾在前、名稱排序;隱藏 `.git`;單一資料夾最多 2000 筆。symlink 只標示,指向 root 外的不跟進。
- `workspace.readFile { sessionId, path }` → `{ kind: "text", content, size, truncated } | { kind: "image", mime, dataBase64, size } | { kind: "binary", size } | { kind: "tooLarge", size }`:
  文字上限 1 MB(超過截斷並 `truncated: true`);前 8 KB 有 NUL 視為 binary;png/jpg/jpeg/gif/webp 回圖片(上限 5 MB,超過 `tooLarge`)。
- `workspace.gitStatus { sessionId }` → `{ isRepo, branch, files: [{ path, oldPath?, index, worktree }], truncated }`:
  `git status --porcelain=v1 -z --untracked-files=all`,cwd = root。不是 git repo → `isRepo: false`;找不到 git → `workspace.gitUnavailable`。
- `workspace.gitDiff { sessionId, path }` → `{ hunks, binary, truncated }`:hunks 格式要能直接餵給既有的 `DiffHunkView`(看它吃什麼格式,通常是 `diff` 套件的 structuredPatch hunk)。
  追蹤中的檔案:`git diff HEAD --no-color --no-ext-diff -- <path>`(repo 還沒有任何 commit 時改成對空樹比);未追蹤的:經 `readFile` 同一套安全檢查讀出內容、組成全部新增的 hunk;
  解析 unified diff 用 `diff` 套件的 `parsePatch`(core 若還沒依賴 `diff`,比照 adapters 的版本加上)。diff 文字上限 512 KB。
- 呼叫 git 一律 `spawn`/`execFile`(不經 shell)、`windowsHide: true`、逾時 10 秒、限制 maxBuffer;`path` 一定放在 `--` 之後。

### P2.2 desktop

- **Changes 分頁**:上方顯示分支與檔案數;檔案清單(狀態徽章 M/A/D/R/?,點擊展開 diff,用 `DiffHunkView`);重新整理鈕;
  目前 session 從 busy 變回 idle 時、以及分頁變成可見時自動重新整理;不是 git repo 時顯示說明空狀態。
- **Files 分頁**:檔案樹逐層展開(展開時才 `listDir`);上方篩選框(只篩已載入的項目);點檔案在下方/右側預覽:
  文字用既有的 `views/chat/CodeBlock.tsx` 依副檔名上色;圖片直接顯示;binary/太大顯示說明;「複製路徑」鈕;重新整理鈕。
- 兩個分頁都綁目前 session,切換 session 時重置。

### P2.3 e2e:`scripts/e2e-side-panel-workspace.mjs`

在暫存資料夾建一個 git repo 當 session 工作資料夾(先 commit 幾個檔案,再改、加、刪、改名),至少驗:

1. `gitStatus` 的每種狀態;`gitDiff` 的 hunk 內容;未追蹤檔案的 diff;還沒有 commit 的 repo;不是 repo 的資料夾。
2. `listDir`/`readFile` 正常情況、`.git` 被隱藏、文字截斷、binary、圖片。
3. **路徑逃逸全部被拒**:`../x`、`a/../../x`、絕對路徑(Windows 與 POSIX 寫法)、UNC、以及 root 內一個指向 root 外的 **junction/symlink**
   (Windows 用 `fs.symlinkSync(target, link, "junction")`)——`listDir` 與 `readFile` 都要測。
4. scoped bridge token 呼叫這四個方法都被拒。

---

## P3. Browser 分頁(只給人用)

### P3.1 Electron main(`apps/desktop/electron/main.ts`)

- 主視窗 `webPreferences.webviewTag: true`。
- 主視窗 webContents 的 `will-attach-webview`:
  - 刪掉 `webPreferences.preload`/`preloadURL`;強制 `nodeIntegration: false`、`contextIsolation: true`、`sandbox: true`、`webSecurity: true`、`allowRunningInsecureContent: false`;
  - `params.partition` 必須符合 `/^deskmony-browser-[A-Za-z0-9_-]+$/`(**不帶 `persist:`** = 記憶體 partition,Q6),否則 `preventDefault()`;
  - `params.src` 必須是 `about:blank` 或 http(s),否則 `preventDefault()`。
- 每個 webview guest(`did-attach-webview` 或 `web-contents-created` 且 `getType() === "webview"`):
  - `setWindowOpenHandler`:一律 `deny`;若目標是 http(s),改成讓同一個 webview 導過去。
  - `will-navigate`、`will-redirect`、`will-frame-navigate`:只允許 `http:`、`https:`、`about:blank`,其餘(`file:`、`chrome:`、`devtools:`、`javascript:` 等)擋下。
- 每個 `deskmony-browser-*` partition 的 session(第一次 attach 時設定一次):
  - `setPermissionRequestHandler` 一律拒絕、`setPermissionCheckHandler` 一律 false(相機、麥克風、定位、通知、剪貼簿讀取……);
  - `will-download` 一律取消(第一版不開放下載:下載等於在政策引擎外寫檔);
  - `webRequest.onBeforeRequest` 擋 `file://*`(縱深防禦)。
- 新 IPC(preload 曝露、`global.d.ts` 補型別):
  - `browserOpenExternal(url)`:只接受 http(s),`shell.openExternal`;
  - `browserOpenDevTools(webContentsId)`、`browserClearPartition(sessionId)`(`clearStorageData` + `clearCache`)。
  - 收到 webContentsId 的 IPC 一律驗證:`webContents.fromId(id)` 存在、`getType() === "webview"`、`hostWebContents === mainWindow.webContents`;不符就丟錯。

### P3.2 renderer

- App 層新增 `BrowserHost`:管理 `sessionId → <webview>`,partition = `deskmony-browser-<sessionId>`。**webview 的 DOM 節點一旦建立就不能搬家(re-parent 會讓頁面重新載入)、不能因切換分頁而條件式卸載**——
  只用定位/尺寸控制可見與否:目前 session 且面板開在 Browser 分頁時,把它定位到面板內容區(用 ResizeObserver 追蹤內容區的位置與大小),其餘的移到畫面外並保持固定尺寸。
  P3 只在使用者第一次打開某 session 的 Browser 分頁時才建立它的 webview。
- 分頁 UI:上一頁/下一頁/重新整理(載入中變成停止)、網址列(Enter 導覽;沒寫 scheme 時,`localhost`/IP/`host:port` 補 `http://`,其餘補 `https://`)、
  載入指示、頁面標題、「用外部瀏覽器開啟」、「開發者工具」。
- 偵測到 session 被刪除時:移除它的 webview,呼叫 `browserClearPartition`。
- 純瀏覽器 client(沒有 `window.deskmony`)不顯示 Browser 分頁。

### P3.3 隱藏 webview 的可行性實驗(**寫好腳本與步驟,不要自己跑**,由 review 方決定何時跑)

P4 要讓 agent 操作「使用者現在沒在看」的 session 瀏覽器,所以要先確認 Electron 44 下,一個已掛載但不在畫面上(移到畫面外/面板關閉)的 webview:
1. CDP `Page.captureScreenshot`(經 `webContents.debugger`)回傳正確、非空白的畫面;
2. CDP `Input.dispatchMouseEvent` 的點擊會觸發頁面的 click handler;
3. CDP `Input.insertText` 能輸入到 focus 的 input;
4. `loadURL` 後 `did-finish-load` 正常觸發;
5. 在「可見位置」與「畫面外」之間來回移動不會重新載入。

寫成 `scripts/spike-webview-offscreen.mjs`(或一個可以用 `electron <檔案>` 直接跑的最小 Electron 程式,放 `scripts/spike/`),輸出每一項 PASS/FAIL。
若「畫面外」不行,依序試:`opacity: 0` 疊在面板內容區後面、1×1 可見容器裁切;把每種方式的結果都輸出。

> ### P3 實作備註(與上文不同或規格沒寫死的地方)
>
> - **共用規則模組**:`apps/desktop/electron/browser-rules.ts`(無任何 import;main 以 `./browser-rules.js`、renderer 以 `../../electron/browser-rules.js` 引用,`e2e-side-panel-pure` 直接載入 .ts 測)。
>   scheme 判斷、partition 名稱、網址列正規化、要從 webview 轉回 app 的組合鍵都只有這一份。判斷一律以 WHATWG `URL` 解析結果為準(會去掉 tab/換行、scheme 轉小寫,不自己拆字串)。
> - **網址列**:輸入含空白一律拒絕(`notUrl`),**不接搜尋引擎**(沒有人要求,而且會把輸入送去第三方);`localhost:3000` 這種 `host:port` 不當成 scheme;
>   `javascript:`/`file:`/`data:` 等回 `unsupportedScheme`。沒寫 scheme 時 `localhost`、`*.localhost`、IPv4、`[IPv6]`、明確帶 port 的補 `http://`,其餘補 `https://`。
> - **偏離規格:子框架多放行 `about:srcdoc`、`blob:`、`data:`**(只限子框架,主框架仍只有 http(s) 與 `about:blank`)。不放行的話許多網站內嵌的 iframe 會壞;
>   這三種都是頁面自己產生的內容,讀不到本機檔案。`file:`、`chrome:`、`devtools:`、`javascript:` 在任何框架都擋。
> - **偏離規格:slot 位置用每個畫面影格比對(`requestAnimationFrame`,變了才寫進 store),不用 ResizeObserver**。ResizeObserver 抓不到「大小不變、只有位置變」(側欄展開/收合),
>   要追蹤的事件太多。代價:Browser 分頁開著時每個影格讀一次 `getBoundingClientRect()`(沒變就不 setState)。
> - **層級**:webview 外框 `z-45`——面板(含覆蓋層模式)是 `z-40`,所有對話框(`ui/Dialog.tsx` 的 PermissionModal/ConfirmDialog/SettingsDialog…是 `z-50`、命令面板 `z-[60]`)都在它之上。
> - **停放方式(P3 review 後修正)**:不在畫面上的 webview **不再**停到 `left:-20000`——P3.3 實驗(真 Electron)顯示那樣 CDP `Page.captureScreenshot` 會逾時(其餘四項過;opacity0 與 clip1x1 都 5/5)。
>   現在停放時外框是 `position: fixed; left: 0; top: 0; width: 1024px; height: 768px; opacity: 0; z-index: -1; pointer-events: none` 加 `aria-hidden`,**留在視口內**;
>   **不用** `visibility: hidden`/`display: none`。它在根層疊脈絡的負 z-index,被 `.app-shell`(在流內、不是 positioned、不透明的 `bg-canvas`、鋪滿視口)的背景蓋住——
>   在瀏覽器窗格把停放的外框強制改成不透明洋紅色,畫面上完全看不到,確認有蓋住。可見時照舊疊到 slot 上(z-45)。樣式在純函式 `src/lib/browser-frame-style.ts`,`e2e-side-panel-pure` 鎖住。
> - **彈出視窗(P3 review 後修正)**:`<webview>` 沒有 `allowpopups` 屬性時,`window.open`/`target=_blank` 在 guest 端就被吞掉,`setWindowOpenHandler` 根本不會被呼叫(真 Electron 實測:點了毫無反應)。
>   所以 `<webview>` 帶 `allowpopups`,而且 `will-attach-webview` 的政策(純函式 `enforceWebviewAttachPolicy()`)**強制**設成 `"true"`、不信任 renderer。安全理由:每次彈出都進永遠回傳 `deny` 的 handler,
>   不會建立任何新視窗;只有 http(s) 目標(`popupRedirectUrl()`)改在同一個 webview 導過去,`about:blank` 與其他 scheme 什麼都不做。
> - **拖拉面板寬度時**,webview 暫時不吃滑鼠事件(`pointerLock`):游標一移到 guest 上,pointer capture 跨行程抓不住;面板被快捷鍵關掉或變成覆蓋層時會自動放開。
> - **快捷鍵**:焦點在 webview 裡時只攔 Ctrl/Cmd+J(開關面板)、Ctrl+\`(開 Terminal)、Ctrl/Cmd+K(命令面板)這三個,`preventDefault()` 後經 IPC 轉給 renderer,main 再把鍵盤焦點還給 app 的 renderer;其餘按鍵一律給網頁。
>   **取捨**:Ctrl/Cmd+K 在網頁內失效(不少網站拿它當搜尋快捷鍵)——命令面板是 app 的全域入口,在 Browser 分頁裡也要能叫出來。有 Alt/Shift 修飾的組合都不攔。
> - **CSP**:`apps/desktop/index.html` 沒有 CSP(`<meta>` 或 main 的 `onHeadersReceived` 都沒有),所以沒有東西擋 `<webview>`。日後加 CSP 時要實測 webview 還能不能附掛。
> - **P3.3 實驗腳本**:`scripts/spike/webview-offscreen.cjs`(CommonJS:`electron <檔案>` 對 .cjs 一定走得通)。執行方式與預期時間見檔頭;共五種位置(visible、offscreen、opacity0、clip1x1、`parked`=目前正式停放方式,
>   之後改停放方式就用同一支重驗)。review 方在真 Electron 跑過前四種:visible 5/5、offscreen 4/5(截圖逾時)、opacity0 5/5、clip1x1 5/5(截圖尺寸是 webview 本身的 1024×768,不是裁切後的 1×1)。**第五種 `parked` 尚未實際執行**。(P4b:腳本又多了 `parked-inert` 與 `parked-tabindex` 兩種(現行正式停放方式 = `parked` + `<webview tabindex="-1">`),並改成走 app 式的生命週期;見 P4b 實作備註。)

---

## P4a. agent 瀏覽器工具:MCP 工具 + core 轉送 + 政策

### P4a.1 工具(MCP server `deskmony`,全名 `mcp__deskmony__<name>`)

兩份實作都要加,**工具名稱、參數 schema、描述文字逐字一致**:`packages/adapters/src/session-network-mcp.ts`(Claude SDK in-process)與
`packages/adapters/src/mcp-bridge-server.ts`(ACP/OpenCode 子行程);`e2e-session-network.mjs` 既有的「兩邊 tools/list 一致」斷言要涵蓋新工具。

| 工具 | 參數 | 回傳 | 權限 |
|---|---|---|---|
| `browser_navigate` | `{ url }` 或 `{ action: "back" \| "forward" \| "reload" }`(二擇一) | 最終 url、標題、是否載入完成 | 走政策 |
| `browser_screenshot` | `{}` | **image content**(JPEG,長邊 ≤ 1568 px)+ 文字(url、標題、截圖尺寸、座標說明) | 自動放行 |
| `browser_read_page` | `{ mode?: "text" \| "interactive", maxChars? }` | text:頁面文字(預設 20,000 字元截斷);interactive:可互動元素 `[{ ref, role, name, href? }]` | 自動放行 |
| `browser_click` | `{ ref }` 或 `{ x, y }` | 點擊後的 url/標題 | 走政策 |
| `browser_type` | `{ text, ref?, submit? }` | — | 走政策 |
| `browser_press_key` | `{ key }`(列舉:Enter、Tab、Escape、Backspace、Delete、四個方向鍵、PageUp、PageDown、Home、End、Space) | — | 走政策 |
| `browser_scroll` | `{ direction: "up" \| "down", amount? }` | — | 自動放行 |

- `x`/`y` 是**最近一次 `browser_screenshot` 圖片的像素座標**;執行端依截圖縮放比例換算回頁面 CSS px。工具描述要寫清楚。
- `ref` 由 `browser_read_page`(interactive)產生,在下一次導覽前有效;過期回明確錯誤,提示重新 read_page。
- **第一版不提供執行任意 JavaScript 的工具**(等於以頁面身分對任意主機發請求,範圍另議)。
- 工具描述要告訴 agent:瀏覽器在使用者的 Deskmony 桌面 app 右側面板裡、使用者看得到;沒開桌面 app 時工具會失敗。
- 「自動放行」的三個工具比照既有查詢工具的放行方式加進:Claude SDK 的 `allowedTools`(`SESSION_NETWORK_ALLOWED_TOOL_NAMES` 那一類常數)、
  OpenCode 的預先放行清單(`opencode-config.ts` 的 `SESSION_NETWORK_QUERY_TOOL_NAMES` 那一類)。ACP 由 agent 自己決定要不要問,不另外處理。
- 設定開關 `features.agentBrowserTools`(boolean,預設 `true`):`false` 時兩份實作都不註冊瀏覽器工具。比照 `features` 既有欄位補 schema、effective config、`config.setFile` patch。

### P4a.2 gateway 方法(scoped)

- 每個工具一個方法,**精確**加進 `computeAllowedMethods()`(不要用前綴或 `browser.*` 一網打盡):
  `browser.navigateForAgent`、`browser.screenshotForAgent`、`browser.readPageForAgent`、`browser.clickForAgent`、`browser.typeForAgent`、`browser.pressKeyForAgent`、`browser.scrollForAgent`。
- `McpBridgeTokenScope` 加 `browser: boolean`;`features.agentBrowserTools` 為 true 時核發的 token 才帶。方法參數**沒有 sessionId**——目標一律是 token 綁定的呼叫者自己的 session(agent 只能操作自己 session 的瀏覽器)。
- Claude SDK in-process 路徑比照 `SessionNetworkPort` 注入一個 `BrowserPort`,直接呼叫 core 的 relay。

### P4a.3 core:`apps/core/src/browser/browser-relay.ts`(新檔)

- **host 註冊**:`browser.registerHost {}`——只接受**非 scoped、且 `isLocal`** 的連線(遠端 client 沒有 webview,也不該能攔截 agent 的瀏覽器指令),否則 `browser.hostNotAllowed`。
  多個 host 時以最後註冊的為準;host 連線斷開就註銷。
- **執行** `execute(sessionId, op, args)`:
  - 沒有 host → `browser.noHost`(訊息讓 agent 能轉告使用者:要開著 Deskmony 桌面 app);
  - 對 host 那**一條**連線送 push `browser-command { commandId, sessionId, op, args }`(**不是 broadcast**);
  - host 回 `browser.commandResult { commandId, ok, result?, error? }`——必須來自同一條 host 連線、commandId 存在,否則忽略並記 warning;
  - 逾時:navigate 30 秒、其他 15 秒 → `browser.timeout`;host 中途斷線 → 未完成的全部 `browser.hostDisconnected`;
  - 同一 session 的指令排隊依序執行;
  - 截圖結果上限 5 MB。
- **導覽規則(core 端強制,不依賴 adapter 有沒有問權限)**:`browser.navigateForAgent` 帶 `url` 時——
  - scheme 只能 http/https → 否則 `browser.unsupportedScheme`;
  - host 必須是 loopback(`localhost`、`*.localhost`、`127.0.0.0/8`、`::1`)**或**在 `policy.allowedHosts` 裡,**或**該 session 開著「真.無限制」→ 否則 `browser.hostNotAllowed`,
    錯誤訊息告訴 agent:要請使用者把 host 加進 `~/.deskmony/config.json` 的 `policy.allowedHosts`。
  - 為什麼 core 要自己擋:三種 adapter 的權限請求帶不帶完整 input、會不會為 MCP 工具發權限請求都不一樣(codex 可能根本不問),只靠 adapter 層的政策判斷會有後端依賴的破口。
- **hard-deny 調整**(`apps/core/src/permissions/hard-deny.ts` 第 4 類):工具是 Deskmony 的 `browser_navigate` 時**跳過 host 檢查**
  (外部 host 由上面的 core 規則擋、而且比 hard-deny 更嚴:不給逐次強確認放行;loopback 依 Q5 不算外連)。
  - 工具名稱判斷寫成一個函式(例如 `isDeskmonyBrowserNavigateTool()`),涵蓋三種寫法:Claude SDK 的 `mcp__deskmony__browser_navigate`、OpenCode 的 `deskmony_browser_navigate`、
    以及 ACP 實際送來的名稱——**先實測或從既有 e2e/fake agent 確認 ACP 送的 toolName 長什麼樣**,不要猜;判斷要綁 `deskmony` 這個 server 名稱,不能只比 `browser_navigate` 結尾(別的 MCP server 可能有同名工具)。
  - 其他工具(WebFetch 等)的第 4 類判斷完全不變。
  - 結果:`browser_navigate` 在 adapter 層是一般的「未分類」工具——未開 auto 會問、可「永遠允許」,auto 模式自動放行;放行之後 core 再套用上面的 host 規則。

### P4a.4 e2e:`scripts/e2e-side-panel-browser.mjs`

core + 一個**假的 browser host**(WS client,`registerHost` 後對每個 `browser-command` 回固定結果並記錄收到的指令)+ 直接用 scoped token 驅動 `mcp-bridge-server` 子行程呼叫工具(比照 `e2e-session-network.mjs`)。至少驗:

1. `browser_navigate` 到 `http://localhost:xxxx` → host 收到指令、工具回傳 host 的結果。
2. 外部 host 不在 allowedHosts → `browser.hostNotAllowed`,**host 沒收到任何指令**;把它加進 allowedHosts(重啟 core)後放行。
3. `file:///...`、`javascript:...` → `browser.unsupportedScheme`,host 沒收到。
4. 沒有 host → `browser.noHost`;host 中途斷線 → `browser.hostDisconnected`;host 不回 → `browser.timeout`(用環境變數把逾時縮短以加速測試,比照 `DESKMONY_PERMISSION_TIMEOUT_MS` 慣例)。
5. `browser-command` 只送到 host 連線:另一條一般連線、以及 scoped 連線都收不到。
6. 非 host 連線送 `browser.commandResult`、錯的 commandId → 被忽略。
7. scoped token 呼叫 `browser.registerHost`/`browser.commandResult` 被拒。
8. `browser_screenshot` 回傳 MCP image content。
9. `features.agentBrowserTools: false` 時兩份實作的 tools/list 都沒有瀏覽器工具。
10. `e2e-hard-deny`/`e2e-policy-engine`:`browser_navigate` 三種名稱寫法到外部 host 都**不**被 hard-deny;WebFetch 到同一外部 host 仍被 hard-deny;別的 server 的同名工具仍被 hard-deny。

> ### P4a 實作備註(與上文不同或規格沒寫死的地方)
>
> - **檔案**:`packages/shared/src/browser.ts`(工具參數、host 指令/結果、錯誤碼、`BrowserPort`)、`apps/core/src/browser/browser-relay.ts`(轉送層)、
>   `packages/adapters/src/browser-tools.ts`(七個工具的**單一定義處**)、gateway 的 `browser.*` 方法、`hard-deny.ts` 的例外、`features.agentBrowserTools`。
> - **偏離規格:兩份 MCP 實作從同一個模組取工具定義**。session 網路五個工具當初刻意複製文字(不想讓輕量的 bridge 子行程載入 claude-agent-sdk);
>   瀏覽器七個工具的名稱、描述、參數 schema、結果格式化與 instructions 的瀏覽器段落都在 `browser-tools.ts`,`session-network-mcp.ts` 與 `mcp-bridge-server.ts` 各自只負責接後端
>   (in-process 接 `BrowserPort`、bridge 接 gateway RPC)——逐字一致由結構保證,`e2e-session-network` 仍直接比對兩邊真正輸出的 tools/list 與 instructions(掛與沒掛瀏覽器都比)。
> - **偏離規格:`browser.hostNotAllowed` 一分為二**。規格在兩個地方用了這個碼(註冊 host 被拒、導覽目標主機被拒),語意不同:前者的「host」是桌面 app,後者是網站主機名稱。
>   導覽目標主機被拒維持 `browser.hostNotAllowed`(e2e 與給 agent 的訊息用它);註冊被拒(非本機或 scoped 連線)是 **`browser.registerNotAllowed`**。
> - **新增的錯誤碼**(`BrowserErrorCodes`,桌面端翻譯在 `errors-browser.json` 四語系):core 產生的有 `noHost`、`hostDisconnected`(params.reason=`disconnected`/`replaced`/`send-failed`)、`timeout`、
>   `hostNotAllowed`、`unsupportedScheme`、`invalidArgs`、`registerNotAllowed`、`resultTooLarge`、`invalidResult`;由 **host(P4b 執行器)回報**、core 原樣轉給 agent 的有 `staleRef`、
>   `staleScreenshot`(截圖之後頁面 viewport 尺寸變了,座標失準)、`noScreenshot`、`elementNotFound`、`navigationFailed`、`hostError`。host 回了不在這份名單裡的 code 一律轉成 `browser.hostError`
>   (擋掉 host 冒充 `gateway.scopedTokenForbidden` 之類的碼)。
> - **導覽規則細節**(`BrowserRelay.checkNavigationTarget()`):以 WHATWG `URL` 解析、看正規化後的 hostname(`127.1`、`0x7f.0.0.1`、`2130706433` 都會變成 `127.0.0.1`,所以放行;
>   `localhost.evil.test`、`127.0.0.1.evil.test`、`http://localhost@evil.test/`、反斜線把戲的主機是 evil.test,擋)。loopback = `localhost`、`*.localhost`、`127.0.0.0/8`、`[::1]`;
>   **刻意不算 loopback**:IPv4-mapped IPv6(`[::ffff:7f00:1]`)、`0.0.0.0`、結尾有點的 `localhost.`(不確定時選較嚴的那一邊,要用就加進 allowedHosts)。
>   `policy.allowedHosts` 不分大小寫、**完全比對** hostname(子網域不繼承,比照 hard-deny)。**送給 host 的是檢查過的 `URL.href`**,不是 agent 原本傳的字串。
>   「真.無限制」用 `SessionManager.isSessionTrueUnrestricted()`——**純讀取**,刻意不呼叫 `checkAndExpireYolo()`(那個會就地降級並把「YOLO 剛過期」的訊號只留給權限決策去寫系統訊息)。
> - **排隊與逾時**:同一個 session 一條佇列(結果/逾時/斷線才放行下一筆),不同 session 互不阻塞。逾時**從指令送給 host 的那一刻起算**(排隊等待不吃逾時);
>   環境變數 `DESKMONY_BROWSER_NAVIGATE_TIMEOUT_MS`/`DESKMONY_BROWSER_COMMAND_TIMEOUT_MS`(預設 30 秒/15 秒)讓 e2e 縮短。bridge 對瀏覽器 RPC 的等待上限是 120 秒(要明顯大於單一指令的逾時,
>   否則 agent 會先看到籠統的「RPC 逾時」而不是 `browser.timeout`)。host 斷線或被取代時,它的所有未完成指令(含還在排隊的、含別的 session 的)一律 `browser.hostDisconnected`。
> - **host 結果的防線**:每個 op 用 `BROWSER_OP_RESULT_SCHEMAS` 驗證形狀;截圖 base64 換算超過 5 MB → `resultTooLarge`;readPage 的文字超過 `maxChars`(預設 20,000)與互動元素超過 500 個由 core 截斷並標 `truncated`。
> - **`features.agentBrowserTools`**(預設 `true`,只有 file/default 兩層、沒有環境變數):`false` 時 `index.ts` 不注入 in-process `BrowserPort`、不讓 ACP/OpenCode adapter 要求瀏覽器範圍;
>   **gateway 在 `mintMcpBridgeToken()` 再與這個設定取交集**(安全開關在 core,不在 adapter),核發結果的 `browser` 欄位(`McpBridgeTokenGrant.browser`)才是 adapter 決定 bridge 掛不掛瀏覽器工具的依據。
>   `config.setFile` 的 patch 接受它(`config.setFile` 本身是 local-only 方法,寫入後要重啟 core 才生效);schema JSON(`docs/deskmony.config.v1.json`)已重新產生。
> - **targeted push**:`WsGateway.pushToConnection()`——只送給**已認證、非 scoped、連線還開著**的那一條;正常情況 scoped 連線連註冊 host 都不行,這是第二道保險。`broadcast()` 的 P0 過濾不變。
> - **呼叫者身分**:in-process 的 MCP wrapper 把閉包捕捉的 `callerSessionId` 放在 `...args` **之後**(工具參數夾帶 `callerSessionId` 也蓋不掉;e2e 有測);gateway 路徑由 token 決定,參數多塞 `sessionId` 被 zod 丟掉。
>
> **三種 adapter 送進政策引擎的 `browser_navigate` toolName(2026-10-21 查證/實測)**——`isDeskmonyBrowserNavigateTool()` 完整比對這三個字串(不是比結尾):
>
> | adapter | toolName | 依據 |
> |---|---|---|
> | Claude SDK(及 claude-code-acp 一類) | `mcp__deskmony__browser_navigate` | 讀 `@anthropic-ai/claude-agent-sdk` 的 sdk.mjs:in-process MCP 工具名一律組成 `mcp__${serverName}__${toolName}`(sdk.d.ts 也寫了);本機沒登入 Claude,**沒有跑真實模型** |
> | OpenCode(HTTP) | `deskmony_browser_navigate` | **實測**:真實 opencode 1.18.7 + `opencode/big-pickle`,掛一個名為 `deskmony` 的 stdio MCP server,tool part 的 `tool` 與 `permission.asked` 的 `permission` 都是這個字串;`permission.asked` 的 `metadata` 是 `{}`,tool part 的 input 在 `running` 才有 `{url}` |
> | OpenCode(`opencode acp`) | `deskmony_browser_navigate` | **實測**:用 Deskmony 自己的 `AcpAdapter` 啟動真實 `opencode acp`,送進政策引擎的 permission-request `toolName` 是這個字串、`input` 是 `{}`(那時還沒有 url) |
> | codex(`@agentclientprotocol/codex-acp` 1.13.1) | `mcp.deskmony.browser_navigate`(`tool_call` 的 title) | **讀套件原始碼**(dist/index.js 的 `createMcpToolCallUpdate()`:`mcp.${server}.${tool}`,rawInput 是 `{server, tool, arguments}`);**沒有真的跑 codex** |
>
> ⚠️ **發現(既有限制,沒有在這輪修)**:codex-acp 的 MCP 工具**權限請求**(`session/request_permission`)在已有對應 `tool_call` 時只帶 `toolCallId`(`kind: execute`、`status: pending`、`_meta.is_mcp_tool_approval`),
> **沒有 title 也沒有 rawInput**。`AcpAdapter` 用 `title ?? toolCallId` 當 toolName,所以 codex 的 MCP 工具(包含 `browser_navigate`)送進政策引擎的 toolName 是一串 call id、input 是空的——
> 政策規則與「永遠允許」對它們無從比對。`browser_navigate` 因此不會被 hard-deny 誤擋(沒有 url 可看),功能不受影響;要讓 codex 的 MCP 權限請求可用,
> `AcpAdapter` 得記住先前 `tool_call` 的 title/rawInput 再補進權限請求(後續工作)。另外 OpenCode 兩條路在權限請求當下 input 都還是空的(url 在後面才到),所以對 opencode 而言 hard-deny 第 4 類本來就看不到 `browser_navigate` 的 url。
> 其他沒查證的後端(例如 gemini)不在這份名單裡,保守起見 `browser_navigate` 仍受第 4 類約束。
>
> **留給 P4b 的介面**(host 端要實作的):
>
> 1. 以 `browser.registerHost {}` 註冊——**每次 WS 連上(含重連)都要重新註冊**(core 在連線斷開時就註銷 host,重連後不會自動恢復)。只在 Electron 註冊;core 只收本機、非 scoped 的連線。
> 2. 收 push `browser-command`,payload `{ commandId, sessionId, op, args }`(`BrowserCommandPushSchema`);`op` 是 `navigate`/`screenshot`/`readPage`/`click`/`type`/`pressKey`/`scroll`,`args` 的形狀見 `BrowserOpMap[op].args`;
>    core 已驗證過 args、導覽的網址已檢查過(host 不需要、也不該再放寬)。**同一個 session 的指令 core 保證一次只送一個**;不同 session 的可能同時在飛。
> 3. 完成後呼叫 `browser.commandResult { commandId, ok: true, result }` 或 `{ commandId, ok: false, error: { code, message } }`;`result` 的形狀見 `BrowserOpMap[op].result`:
>    `navigate → {url, title, loaded}`、`screenshot → {mimeType:"image/jpeg", data(base64), width, height, url, title}`(`width`/`height` 是**這張圖**的像素尺寸,≤ 長邊 1568)、
>    `readPage → {mode:"text", url, title, text, truncated}` 或 `{mode:"interactive", url, title, elements:[{ref, role, name, href?}], truncated}`、`click → {url, title}`、`type/pressKey/scroll → {}`。
>    回的結果在逾時(導覽 30 秒、其他 15 秒)之後才到會被忽略。`ok: false` 的 `error.code` 要用 `BROWSER_HOST_ERROR_CODES`:`browser.staleRef`、`browser.staleScreenshot`、`browser.noScreenshot`、
>    `browser.elementNotFound`、`browser.navigationFailed`、`browser.hostError`,`message` 是給 agent 看的說明。
> 4. `staleScreenshot` 的用法:記住最近一次截圖當下的 viewport 尺寸;`click` 用 x/y 時若現在的尺寸不同(使用者開關面板,webview 在 slot 尺寸與停放的 1024×768 之間切換)就回這個錯誤,不要點下去。
> 5. screenshot 會被 session 事件原樣存進 DB 並廣播(`ToolImage` 會在對話串顯示)——P4b 執行器請用偏低的 JPEG 品質(約 60–70),讓單張遠低於 1 MB(core 上限 5 MB 只是保險)。
> 6. 瀏覽器工具的結果文字裡,網頁內容(`browser_read_page`)已帶「不可信資料」標示;host 回的 `text`/`name` 不需要再包一層。
>
> **沒有 e2e 的部分**:`browser.registerHost` 被**非本機**(非 loopback)連線呼叫的拒絕路徑——需要讓 core 綁到對外位址再用區網 IP 連,會跳 Windows 防火牆提示,這輪沒做;邏輯只有 `!isLocal` 一個條件(`dispatch()` 的 `browser.registerHost` case),`isLocal` 本身由既有的 `LOCAL_ONLY_METHODS` 路徑測過。

---

## P4b. agent 瀏覽器工具:Electron 端執行器 + UI

依 P3.3 實驗結果決定隱藏 webview 的方式後再做。

- **renderer**:`BrowserHost` 在 WS 連上(含重連)後呼叫 `browser.registerHost`(只在 Electron)。收到 `browser-command`:
  確保該 session 的 webview 存在(不存在就建立並等 `dom-ready`)→ 取 `getWebContentsId()` → `window.deskmony.browserExec(webContentsId, op, args)` → 結果回 `browser.commandResult`。
- **main** `deskmony:browserExec`:同 P3.1 的 webContentsId 驗證;第一次用時 `debugger.attach("1.3")`,處理 `detach` 事件(例如使用者開了 DevTools)後下次重 attach。
  - navigate:再檢查一次 scheme;`loadURL`,等 `did-finish-load`/`did-fail-load`(逾時就回「仍在載入」)。back/forward/reload 用 `navigationHistory`。
  - screenshot:CDP `Page.captureScreenshot`(JPEG),縮到長邊 ≤ 1568;記住這次的縮放比例供 `x`/`y` 換算。
  - read_page:`executeJavaScriptInIsolatedWorld`(固定 worldId),在 isolated world 裡保存 ref → 元素的對照(不要在頁面 DOM 上加屬性);導覽後失效。頁面內容一律當不可信資料處理。
  - click:ref → isolated world 取元素 `scrollIntoView` 後的中心座標;x/y → 依截圖比例換算;用 CDP `Input.dispatchMouseEvent`(mouseMoved/mousePressed/mouseReleased)。
  - type:有 ref 先 focus;CDP `Input.insertText`;`submit` 再送 Enter。press_key:CDP `Input.dispatchKeyEvent`(帶正確的 key/code/windowsVirtualKeyCode)。scroll:CDP mouseWheel。
- **UI**:session 的瀏覽器正被 agent 操作時,Browser 分頁與面板切換鈕顯示「agent 操作中」指示與最近一個動作;該 session 是目前 session 且面板關著時,自動打開面板並切到 Browser。

> ### P4b 實作備註(與上文不同或規格沒寫死的地方)
>
> **檔案**
>
> | 檔案 | 角色 |
> |---|---|
> | `apps/desktop/electron/browser-exec.ts` | 執行流程本體(七個 op、截圖縮放與座標換算、`staleScreenshot` 判斷、ref 解析、滑鼠/鍵盤事件序列、逾時、錯誤碼對照、結果整形)。**沒有任何 import**,對抽象的 `BrowserGuestDriver` 寫 |
> | `apps/desktop/electron/browser-executor.ts` | 把 `WebContents` 包成 driver 的 Electron 膠水(debugger attach/detach、`executeJavaScriptInIsolatedWorld`、載入事件、`navigationHistory`、`nativeImage`);同一個 guest 的指令在這裡再串行一次 |
> | `electron/main.ts`、`preload.cts`、`src/global.d.ts` | IPC `deskmony:browserExec`(`assertFromMainWindow` + `resolveBrowserGuest`);preload 的 `browserExec(webContentsId, op, args)` |
> | `src/lib/browser-host-flow.ts` | 收到 `browser-command` 之後的**決策邏輯**(順序、各種失敗怎麼回報);沒有 import,副作用經 `HostFlowDeps` 注入 |
> | `src/views/panel/browser-host.ts` | 把上面那個流程接到真的 store、WS client、IPC;`startBrowserHost()`(每次連線開啟都 `browser.registerHost`)由 `BrowserHost` 掛載時呼叫 |
> | `src/lib/browser-activity.ts`、`src/views/panel/agent-activity.ts`、`stores/browser-store.ts` | 「agent 操作中」指示:動作描述(i18n key + 參數)、留存計時、`waitForBrowserReady()` |
> | `src/lib/browser-frame-style.ts` | `browserWebviewTabIndex()`(停放 → `-1`);`BrowserHost.tsx` 把它傳給 `<webview>` 的 `tabIndex` |
> | `scripts/spike/webview-offscreen.cjs`、`scripts/verify-browser-host-real.mjs` | 實驗腳本的 `parked-inert`/`parked-tabindex` 位置與 app 式生命週期;對真 app 的驗證腳本 |
>
> **為什麼拆成純函式 + driver/deps**:跟 `browser-rules.ts` 同一個慣例——Node 直接載入 `.ts`(不需 build、不需 Electron)就能測。真正只能在 Electron 裡驗的只剩 `browser-executor.ts` 那層膠水(清單見下)。
> `e2e-side-panel-pure.mjs` 用假 driver + 最小的假 DOM 驗執行流程、isolated world 腳本的行為與「不改動頁面 DOM」,用假 deps 驗 host 流程,用**真的 zustand store + 假計時器**驗指示留存與 `waitForBrowserReady()`;
> `e2e-side-panel-browser.mjs` 的 BR-13 驗執行器與 core/shared 的契約(常數、逾時、錯誤碼、每個 op 的結果都通得過 core 的結果 schema)。
>
> **執行器的決定**
>
> - **ref 對照表在 isolated world,不在頁面 DOM**:`window.__deskmonyRefs.table`(worldId 7101),每次 `readPage(interactive)` 整份重建;腳本不寫屬性、不改樣式、不插節點(唯一的副作用是 `scrollIntoView`/`focus`),
>   e2e 用原始碼掃描擋住 `setAttribute`/`dataset`/`appendChild`/`eval`… 之類的字樣。導覽後 isolated world 的 context 隨文件重建,表自然消失 → `browser.staleRef`(元素已脫離文件、ref 不在表裡同樣)。
>   回給 agent 的 ref 只認 `e<N>`、href 只回 http(s)、名稱/role/href 有長度上限、最多 500 個;文字與密碼輸入框的 `value`(可能是使用者輸入的機密)**絕不**進結果(只有按鈕型 input 才用 value 當名稱)。頁面來的值一律在 host 端重新檢查型別與長度。
> - **viewport 從 isolated world 讀**(`window.innerWidth/innerHeight`):頁面在它自己的世界改寫 `innerWidth` 影響不到,座標換算不會被騙。`screenshot` 記下「截圖當下的 viewport(CSS px)+ 回傳的圖的像素尺寸」;
>   `click(x, y)` 時 viewport 與紀錄差超過 1px 就回 `browser.staleScreenshot`(訊息帶前後尺寸);沒有紀錄回 `browser.noScreenshot`。
> - **截圖紀錄在導覽(含使用者自己導覽、`did-navigate`)與 agent 自己捲動之後失效**——舊座標對不上新畫面,與其點錯不如要求重新截圖。(規格只寫 viewport 尺寸變了才算過期;這是多出來的保守處理。)
> - **逾時一律小於 core 的**:導覽最多等 25 秒(整體 28 秒;逾時回 `loaded: false`,不是錯誤)、其他 op 整體 12 秒;core 是 30/15 秒。兩者都從**指令送給 host** 起算,但 renderer 等 webview `dom-ready` 的最多 5 秒(`READY_WAIT_MS`)不算在執行器的上限裡——
>   webview 很慢又碰上很慢的頁面時,core 可能先回 `browser.timeout`(之後才到的結果被 core 忽略);正常情況 webview 幾百毫秒就緒,不會碰到。
> - **點擊/按鍵之後**先等 250 ms,頁面開始導覽的話最多再等 5 秒載完,才回 url/title(點連結後回的是新頁)。`navigate` 在 `loadURL` **之前**就開始觀察 `did-finish-load`/`did-fail-load`(ERR_ABORTED = -3 忽略),`did-fail-load` → `browser.navigationFailed`(訊息含錯誤描述與網址)。
> - **`type`**:給 `ref` 先在 isolated world `focus()`,聚焦後還不是可輸入元素(自訂元件)就點它的中心再檢查一次,仍不行 → `browser.elementNotFound`;沒給 `ref` 且目前沒聚焦在可輸入元素 → `browser.elementNotFound`(訊息教 agent 用 ref)。輸入用 `Input.insertText`,`submit` 再送 Enter。
> - **按鍵表**(`KEY_TABLE`)十四個鍵與 `BROWSER_KEYS` 一致(e2e 比對),`windowsVirtualKeyCode` 與 Puppeteer 的 keyDefinitions 同值;會產生字元的 Enter/Space 以 `keyDown` + `text` 送、其餘 `rawKeyDown`,都再送 `keyUp`。
> - **scroll**:CDP `mouseWheel`,位置在 viewport 中心,一個單位 = 視窗高度的 80%(預設 1、上限 20)。
> - **debugger 生命週期**:第一次用才 `attach("1.3")`,不常駐;`detach` 只記 log,下一個指令發現 `isAttached()` 為假就重新 attach;指令送出當下剛好被 detach 的錯誤會重試一次。沒有 agent 操作的 session 完全不碰 debugger。
> - **IPC 不丟例外**:`deskmony:browserExec` 期待中的失敗回 `{ok:false, error:{code,message}}`(renderer 原樣轉成 `browser.commandResult`),只有呼叫者不是主視窗/webContentsId 不是這個視窗的 webview 才丟(host 流程把它轉成 `browser.hostError`)。navigate 的 scheme 在 main **再檢查一次**(第三層,與 core、`will-attach-webview`/導覽鎖並列)。
>
> **host(renderer)的決定**
>
> - **每次連線開啟都註冊**(`onStatus === "open"`,掛上時若已經開著也註冊一次);只有 Electron 殼且有 `browserExec` 才啟動。
> - **有 `commandId` 就一定回一個結果**:壞掉的 payload/不認得的 op、session 不在清單裡、webview 起不來、頁面當掉(`crashed`)、IPC 失敗、執行器回了怪形狀,一律 `browser.hostError`,不讓 core 乾等到逾時;整個流程不丟例外。
> - **session 不在 session 清單裡就拒絕、不建立 webview**:`BrowserHost` 會把「不在清單裡」的 session 的 webview 清掉(啟動時清單還沒載入完的空窗也算),為它建立等於白做。
> - **使用者從沒開過 Browser 分頁也能用**:`ensure()` 排進 `BrowserHost` → 等 `dom-ready` 拿 `webContentsId`(`waitForBrowserReady`),停放樣式沿用 P3(P3.3 實驗驗過的那種)。
> - **「agent 操作中」指示**:每個指令 `begin`/`end` 計數,最後一個結束後再留 8 秒(`ACTIVITY_LINGER_MS`)才清;顯示的動作只有 i18n key + 參數,輸入的文字只顯示字元數、網址只顯示 host + 路徑。
>   指示放在 **Browser 分頁既有的標題列**(取代頁面標題)、Browser 分頁標籤的小圓點、面板開關鈕的小圓點。**不在 slot 上方加一列**——多一列會讓 webview 的高度隨指示出現/消失而變,截圖與點擊之間的 viewport 尺寸就會對不上(`staleScreenshot`)。
> - **自動打開面板**:只在「一段操作的開頭」(該 session 之前沒有指示紀錄)+ 目前選取的就是這個 session + 面板關著時觸發,並等 300 ms 讓 slot 就位;面板開著但停在別的分頁時不搶走使用者正在看的分頁(只有圓點);
>   使用者在操作進行中把面板關掉,8 秒內的下一個指令不會又彈出來。
> - **停放中的 Tab 防護**(使用者按 Tab 不該把焦點送進看不見的頁面;opacity 0 的 webview 仍然可以被 Tab 聚焦)。現況是 `<webview tabindex="-1">`(`browserWebviewTabIndex()` 停放 → `-1`、可見 → 不設),
>   它只讓 webview 退出循序導覽,不影響程式/CDP 聚焦它。**這個決定的歷史與證據(請不要只看結論)**:
>   1. 最初是停放外框的 `inert`。實驗腳本第一版(真 Electron,2026-10-23):`parked-inert` 5/5、Tab 進不去(BODY);沒加 inert 的 `parked` Tab 會進 webview。
>   2. 同一天驗證腳本在真 app 完整執行(可見階段 + 停放階段),停放階段 P-5a/P-5b(click)FAIL(工具回成功、頁面沒收到 click),其餘都 PASS;當時歸因於 `inert`,並用「拿掉 inert、只跑 `--phase=parked`」得到 9/9 當作佐證,於是改用 tabindex(commit 920ecf2)。
>   3. **事後發現那個 FAIL 是驗證腳本自己的 bug**:V-5a/V-5b/P-5a/P-5b 用「頁面至今累計收到的 click 事件數 + 1」當預期的頁面點擊計數 `n`,但頁面重新載入後計數歸零,完整執行的停放階段(P-1 重新載入過頁面)
>      點擊就算真的送達也一定比不上——**與 inert 無關**,而且和觀察到的症狀(工具成功、url/title 正確、頁面沒「收到」click)完全吻合。2 的對照同時改變了兩件事(inert 與只跑停放階段,後者讓計數器是新的),所以**沒有證明 inert 會擋 CDP 點擊**。
>      已修(`expectOneClick()`:只看「這次點擊之後」出現的 click 事件、要剛好一個)。
>   4. 所以現在的狀態是:「`inert` 會擋 CDP 點擊」既沒有被證明、也沒有被推翻;`tabindex` 能不能擋住 Tab、會不會影響 CDP 點擊也都還沒在真 Electron 驗證。實驗腳本(app 式生命週期 + `parked-inert`/`parked-tabindex` 兩個位置、各 5 項檢查加 Tab 檢查,摘要有並排結論)
>      與修好的驗證腳本就是用來決定的:完整執行驗證腳本的停放階段若 9/9 且 Tab 檢查 OK,就維持 tabindex;若想換回 `inert`,改 `browserWebviewTabIndex()` 與 `BrowserHost` 的接線(外框加 `inert`,React 18 不認得這個屬性,要以空字串經 spread 傳入)即可。
>
> **只能在真 Electron 驗證的事**(`pnpm test` 驗不到;對應的檢查在 `webview-offscreen.cjs` 與 `verify-browser-host-real.mjs`)
>
> 1. `webContents.debugger.attach("1.3")` 對 `<webview>` guest 能用,而且**使用者同時開著這個 webview 的 DevTools 時**仍能 attach(或 detach 之後能重新 attach)——Electron 版本之間有差,這裡沒有實測。
> 2. `Page.captureScreenshot` 在「可見」與「停放」(含 `tabindex="-1"`)兩種狀態都回正常的畫面;JPEG 品質 65 的檔案大小與 `nativeImage` 縮放後的畫質。
>    **另外沒測的情境**:Deskmony 視窗被最小化或完全被別的視窗遮住時,Chromium 可能停止繪製 guest,截圖會逾時(回 `browser.hostError`)——兩個腳本都沒覆蓋這種情況,要手動試。
> 3. `Input.dispatchMouseEvent`/`dispatchKeyEvent`/`insertText` 對 guest 的實際效果——特別是 guest 認為自己沒有焦點(`document.hasFocus()` 為假)時,`:focus` 樣式與 focus 事件的行為,以及停放時 `tabindex="-1"`(或當初的 `inert`)的影響;`tabindex="-1"` 能不能真的擋住 Tab(`<webview>` 是 shadow host,要實測)。
> 4. `executeJavaScriptInIsolatedWorld` 對 `<webview>` guest 可用、isolated world 的 `window` 確實與頁面隔離、ref 對照表在導覽後確實消失。
> 5. `did-finish-load`/`did-fail-load`/`did-stop-loading` 的實際時序(特別是點連結後的導覽、`loadURL` 同網址、history 的 back/forward 是否都會觸發 `did-finish-load`)、`navigationHistory`、截圖 `nativeImage` 的解碼與縮放。
> 6. 面板開關、拖拉寬度時 viewport 尺寸的變化與 `staleScreenshot` 的實際觸發;自動打開面板後 300 ms 是否足夠讓 slot 就位。
> 7. 所有 UI(指示、圓點、自動打開、四語系文字)的實際外觀——這輪沒有啟動 Electron,只過了 typecheck/build。
>
> **執行方式**:實驗腳本 `apps\desktop\node_modules\.bin\electron.cmd scripts\spike\webview-offscreen.cjs`(開七個視窗依序跑,約 45–90 秒,自己結束);驗證腳本先照它檔頭的 PowerShell 指令啟動 dev app(`DESKMONY_E2E_EXTRA_PROVIDERS` 提供 fake ACP provider),
> 再 `node scripts/verify-browser-host-real.mjs --core-port=<n> --token=<t>`。

---

## 已知限制(誠實記錄,寫進 DECISIONS §L)

- core 只擋 agent **明確要求**的導覽;到了頁面上之後,點連結/表單送出/重新導向可以走到 allowedHosts 以外的主機——瀏覽器本質上就是能對外連線的工具。要嚴格隔離就把 `features.agentBrowserTools` 關掉。
- 每個 session 的瀏覽器登入狀態只活在記憶體:使用者在某個 session 的瀏覽器登入了什麼,那個 session 的 agent 在它活著的期間都能以使用者身分操作。
- `policy.allowedHosts` 目前沒有 UI,只能手改 `~/.deskmony/config.json`(它是安全罩地基,刻意不開 RPC)。
- 遠端 client 可以開終端(Q3)= 拿到主 token 就拿到 shell;這是使用者明確選的,見 DECISIONS §L。
