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
- **重新啟動的新終端「在同一位置」**是 client 端的分頁順序(core 的清單依建立順序);重新載入清單後回到建立順序。
- **面板關著時整個不渲染**(xterm 一併 dispose),重新打開時 attach——不是隱藏保留;P3 的 webview 才需要「不能卸載」,到時在分頁註冊陣列加 `keepMounted`。
- 快捷鍵:`hotkeys.ts` 新增 `ctrl` 記號(字面 Ctrl,不隨平台變成 ⌘),`ctrl+\`` 用它;`mod+j` 在 Windows 上就是 Ctrl+J(終端裡的 LF,`allowInTerminal` 照規格攔截)。

---

## P2. Changes + Files

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

---

## 已知限制(誠實記錄,寫進 DECISIONS §L)

- core 只擋 agent **明確要求**的導覽;到了頁面上之後,點連結/表單送出/重新導向可以走到 allowedHosts 以外的主機——瀏覽器本質上就是能對外連線的工具。要嚴格隔離就把 `features.agentBrowserTools` 關掉。
- 每個 session 的瀏覽器登入狀態只活在記憶體:使用者在某個 session 的瀏覽器登入了什麼,那個 session 的 agent 在它活著的期間都能以使用者身分操作。
- `policy.allowedHosts` 目前沒有 UI,只能手改 `~/.deskmony/config.json`(它是安全罩地基,刻意不開 RPC)。
- 遠端 client 可以開終端(Q3)= 拿到主 token 就拿到 shell;這是使用者明確選的,見 DECISIONS §L。
