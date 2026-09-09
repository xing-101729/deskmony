# CLI(`deskmony` 指令列介面)HLD

> 狀態:Phase 1 設計定案(2026-09-09)。分支 `feat/cli`。

## 0. 為什麼做這個

Deskmony 目前唯一的人機介面是 Electron 桌面殼,而 `README.md` 第 111 行早就
寫著「桌面殼**刻意**只是 core 的其中一種 client——同一個 WebSocket gateway
也服務瀏覽器或手機」。CLI 就是把那句話兌現的第三種 client。

兩個具體需求驅動:

1. **Linux 伺服器**上沒有桌面環境,但 core 是純 Node,完全跑得動。缺的只是一個
   不需要 Electron 的操作介面。
2. **Windows `cmd.exe` / PowerShell** 裡直接下指令,不必開 app。

## 1. 最重要的一條界線:CLI **不是**第二個 orchestrator

CLI 是 gateway 的 client,**所有**決策(權限、政策引擎、hard-deny、成本治理、
worktree 隔離)仍然只在 `apps/core` 裡發生。CLI 不得:

- 自己 spawn agent 子程序(那是 `SessionManager` + adapter 的事);
- 自己判斷某個工具呼叫該不該放行(那是 `PolicyEngine` 的事);
- 新增任何「繞過安全罩」的旗標。

CLI 只能呼叫 gateway 既有的方法。`--yes` 這類自動化旗標一律**對應到 core 既有的
`session.setPermissionMode`**(`auto-accept-edits` / `auto-accept-all`),不另闢
一條 client 端的自動放行路徑。這是 `docs/DECISIONS.md` §0「無人值守安全罩」的
直接推論——安全罩罩不到的東西不算被罩住,而一個能自己決定放行的 client 正是
安全罩罩不到的東西。

## 2. 命令表面(Phase 1)

參考 Claude Code CLI / Codex CLI / opencode / aider 的共同慣例:裸執行進互動
模式、`-p` 一次性列印、`serve` 開 headless server、資源型子指令、`--json` 供
腳本使用。

```
deskmony                          # = deskmony chat(裸執行進互動 REPL)
deskmony chat [--session <id>]    # 互動 REPL;不給 --session 就建新的
deskmony run <prompt>             # 一次性:送出、串流輸出、完成後退出
deskmony run -                    # prompt 從 stdin 讀(支援 pipe)
deskmony serve                    # 在前景跑 headless core
deskmony session list|rm          # 列出/刪除 session
deskmony profile list             # 列出 agent profile
deskmony doctor                   # 環境偵測(env.detectAgents)+ 連線自我檢查
deskmony config show              # 顯示生效設定(config.getEffective)
deskmony --version | --help
```

### 全域旗標

| 旗標 | 環境變數 | 預設 | 說明 |
|---|---|---|---|
| `--url <ws://…>` | `DESKMONY_URL` | `ws://127.0.0.1:4317` | gateway 位址 |
| `--token <t>` | `DESKMONY_AUTH_TOKEN` | 無 | 認證 token |
| `--cwd <path>` | — | `process.cwd()` | session 的 workingDir |
| `--profile <id>` | — | `default-claude-code` | agent profile |
| `--model <m>` / `--effort <e>` | — | 依 profile | 建 session 時的 agentOverride |
| `--json` | — | 關 | 輸出 NDJSON,供腳本消費 |
| `--no-color` | `NO_COLOR` | 依 TTY | 關閉 ANSI |
| `--timeout <ms>` | — | `run` 為 600000 | 一次性模式的整體上限 |

優先序一律 **旗標 > 環境變數 > 預設**,與 `load-config.ts` 既有的
「環境變數永遠贏過設定檔」同一套思路。

### 退出碼

| 碼 | 意義 |
|---|---|
| 0 | 成功 |
| 1 | 執行期錯誤(agent 回報 error 事件、gateway 回 error) |
| 2 | 用法錯誤(未知旗標/缺參數) |
| 3 | 連不上 gateway 或認證失敗 |
| 4 | 權限請求被拒或逾時(非互動模式下的預設結果) |

## 3. 不做的事(Phase 1 明確排除)

- **不自動啟動 core。** 連不上就給一則可執行的錯誤訊息(叫使用者跑
  `deskmony serve`),而不是偷偷 spawn 一個。理由:core 持有 SQLite,同一個
  `DATA_DIR` 上跑兩份 core 是真實的資料危害,要做就得先有 lockfile 與交握,
  那是 Phase 2 的獨立題目,不該夾帶在第一版裡。
- **不做全螢幕 TUI。** 用 `node:readline` 的行導向 REPL。全螢幕 TUI 在
  `cmd.exe` 上的相容性問題(codepage、alternate screen buffer、滑鼠序列)是
  另一個工程,不是這一版的價值所在。
- **不碰 desktop 的 UI。** 只把 gateway client 抽成共用套件(見 §4)。
- **不做 `team` / `task` 子指令。** 先把單 session 的路徑做對做完整。

## 4. 套件結構

### 4.1 新增 `packages/client`(`@deskmony/client`)

把 `apps/desktop/src/lib/gateway-client.ts` 原封不動搬過來,只做**一項**改動:
WebSocket 建構子改成可注入。

```ts
export type WebSocketFactory = (url: string) => WebSocketLike;
// 預設 globalThis.WebSocket(瀏覽器/Electron renderer 原本的行為)
```

`apps/desktop/src/lib/gateway-client.ts` 改成純 re-export,desktop 其餘程式碼
一行都不動。這樣協定 client 只有**一份**實作,`ClientRequest`/`ServerMessage`
的型別漂移由 `tsc` 抓。

這個套件**不得**相依 `ws`——它要能被 vite 打進瀏覽器 bundle。CLI 自己注入
`ws`(core 已經相依這個套件,不是新相依)。

### 4.2 新增 `apps/cli`(`@deskmony/cli`)

```
apps/cli/
  package.json        # bin: { "deskmony": "./dist/bin.js" }
  src/
    bin.ts            # #!/usr/bin/env node,只做 argv 分派與退出碼
    args.ts           # 自己寫的旗標解析(不引入 commander/yargs 等新相依)
    connect.ts        # 建立 GatewayClient(注入 ws)、auth、錯誤訊息
    render.ts         # AgentEvent → 終端輸出;色彩/ASCII 降級都在這裡
    prompt.ts         # readline 互動:權限問答、確認
    commands/
      chat.ts serve.ts run.ts session.ts profile.ts doctor.ts config.ts
```

`serve.ts` 的作法:把旗標翻成 `process.env.DESKMONY_*`,然後
`await import("@deskmony/core")` ——core 的 `index.ts` 是 import 即執行
`main()`。同一個行程,Ctrl+C 與訊號處理都是自然的,不必處理跨平台 spawn。

**新相依只有 `ws`**(已在 monorepo 內)。不引入 CLI 框架、不引入 chalk。

## 5. 事件渲染

| 事件 | 互動/預設輸出 | `--json` |
|---|---|---|
| `message-delta` | 直接 `stdout.write(delta)` | `{"type":"message-delta",…}` 一行 |
| `tool-call` | `  → <toolName> <單行摘要>` | 同上 |
| `tool-result` | 只在 `isError` 時印一行 | 同上 |
| `permission-request` | 見 §6 | 見 §6 |
| `usage` / `context-usage` | 只在 `--verbose` 印 | 同上 |
| `completed` | 換行,回到提示符 | 同上 |
| `error` | 印到 stderr,退出碼 1 | 同上 |
| `terminal-data` | 原樣寫 stdout | 同上 |

`--json` 是 **NDJSON**(每行一個 JSON 物件),不是最後吐一顆大 JSON——串流
場景下前者才可用。

## 6. 權限請求在終端裡怎麼問

這是 CLI 最需要做對的一段。

**互動模式**(stdin 是 TTY):

```
權限請求 · session <id>
  工具:Bash
  指令:git push --force origin main
  [a] 允許一次   [d] 拒絕   [A] 永遠允許(最窄規則)   [Enter] = 拒絕
```

- 送出 `permission.resolve`,`sessionId` **必填**(見 `PermissionDecisionSchema`
  的註解:`requestId` 只保證同一 session 內唯一,單鍵反查在多 agent 併發下會
  把 A 的決定套到 B 身上)。
- `[A]` 只送最窄的規則(`commandEquals` / `pathUnder`),與 `PermissionModal.tsx`
  的預設一致。
- **`strong === true`(escalate-strong)時:紅色警示 + 不提供 `[A]`,並要求輸入
  完整的 `yes` 而非單鍵。** core 端本來就會剝掉 strong 請求的 `rememberRule`
  (C4 紀律③),CLI 這邊不提供只是不要讓使用者以為那個選項存在。

**非互動模式**(`run`、或 stdin 不是 TTY):不問,直接**拒絕**,印出被拒的工具
與指令,退出碼 4。要自動化就明講 `--permission-mode auto-accept-edits`
(對應 `session.setPermissionMode`),不給沉默放行的路。

## 7. 跨平台(這是需求本身,不是附註)

| 項目 | 作法 |
|---|---|
| Windows 進入點 | npm `bin` 會自動產生 `deskmony.cmd` / `deskmony.ps1`,`cmd.exe` 與 PowerShell 都能直接叫 |
| ANSI 色彩 | 只在 `stdout.isTTY && !NO_COLOR && !--no-color` 時輸出;不用 chalk,直接寫 SGR 碼 |
| 非 UTF-8 codepage | `cmd.exe` 預設 cp950/cp437 下 Unicode 框線與 emoji 會變亂碼。**一律只用 ASCII**(`->`、`*`、`|`)當結構符號;需要的話另外提供 `--ascii` 強制 |
| 換行 | 讀 stdin 時 `.replace(/\r\n/g, "\n")`;輸出用 `\n`,Windows 終端自己處理 |
| 路徑 | 一律 `path.resolve()`;`--cwd` 相對路徑以 `process.cwd()` 為基準 |
| Ctrl+C | 互動模式第一次 = `session.interrupt`(中斷這一輪,不離開);兩秒內再按一次 = 離開。非互動模式 = 直接離開,退出碼 130 |
| Ctrl+D / `/exit` | 離開 REPL |
| 訊號 | 不用 `process.kill` 打樹;`serve` 只把 SIGINT/SIGTERM 交給 core 既有的關閉流程 |

## 8. REPL 內建斜線指令(最小集)

`/help` `/exit` `/new` `/sessions` `/model <m>` `/mode <always-ask|auto-accept-edits|auto-accept-all>` `/interrupt` `/clear`

`/mode` 直接對應 `session.setPermissionMode`。**不提供** true-unrestricted 的
開關——那一層在 `docs/DECISIONS.md` §G 要求打字確認的儀式,不適合放進 REPL 的
單行指令,留給 Phase 2 用完整的確認流程做。

## 9. 驗收(這一版算不算做完的唯一標準)

新增 `scripts/e2e-cli.mjs`,加進 `scripts/run-e2e.mjs` 的 `SUITES`,並把
`apps/cli` 加進 `scripts/lib/require-fresh-build.mjs` 的 `WATCHED`。

測法比照既有 e2e:啟動真的 headless core(獨立 port + 獨立 `DESKMONY_DATA_DIR`),
後端用 `fake-acp-agent.mjs`,然後**以子程序執行編譯後的 CLI**(`node
apps/cli/dist/bin.js …`),斷言 stdout/stderr/退出碼。

必須涵蓋:

1. `--version` / `--help` → 退出碼 0,`--help` 列出所有子指令。
2. 未知旗標 → 退出碼 2,錯誤訊息指向 `--help`。
3. 連不上的 URL → 退出碼 3,訊息含「`deskmony serve`」的可執行指引。
4. token 錯誤 → 退出碼 3,且**不得**把 token 印進輸出。
5. `session list --json` → 每行是合法 JSON,欄位通過 `SessionSchema` 驗證。
6. `run "<prompt>"` → stdout 出現 fake agent 的回覆文字,退出碼 0。
7. `run` 遇到 `permission-request` 且非 TTY → 退出碼 4,stderr 說明被拒的工具。
8. `run -` 從 stdin 讀 prompt(含 CRLF)→ 與 (6) 同樣結果。
9. `--no-color` → 輸出不含 `\x1b[`。
10. `doctor` → 退出碼 0,輸出含 gateway 連線狀態。

CI:`.github/workflows/ci.yml` 新增一個 **`ubuntu-latest`** job,跑
`pnpm install` → `pnpm typecheck` → `pnpm build` → `node scripts/e2e-cli.mjs`。
只跑 CLI 這一套——現有的其他 e2e 是否在 Linux 上通過是另一個題目,不在這輪
承諾範圍內,把它們一起拉上去只會得到一個沒人相信的紅燈。

## 10. Phase 2 備忘(不在這輪)

- 連不上時自動啟動本機 core(需要 `DATA_DIR` lockfile 與交握)
- `team` / `task` / `recovery` 子指令
- 全螢幕 TUI
- true-unrestricted 的終端確認儀式
- 把 `@deskmony/cli` 發成公開 npm 套件(目前 `private: true`)

## 11. 施工用事實表(已在 core 原始碼查證,不要再猜)

| 事實 | 出處 |
|---|---|
| `session.sendPrompt` **立刻**回 `{ok:true}`,不等這一輪跑完 | `ws-gateway.ts:1178` |
| 因此 `run` 必須訂閱 `session-event` channel,自己等 `completed` 或 `error`(用 `sessionId` 過濾——所有 client 都會收到**全部** session 的推播) | `SessionEventEnvelopeSchema` |
| 認證失敗回 `errorCode: "auth.invalidToken"`,且 server 會 `socket.close(1008)` | `ws-gateway.ts:970-977` |
| 認證有以來源 IP 為 key 的失敗限流,冷卻期內一律拒絕,code 為 `auth.rateLimited` | `ws-gateway.ts:1002` |
| 尚未認證就送別的方法 → `auth.notYetAuthenticated` | `ws-gateway.ts:989` |
| 沒有 `Origin` header 的 client 一律通過同源檢查(CLI 屬於此類) | `verifySameOrigin()`,`ws-gateway.ts:313` |
| 走 loopback 連線 → `isLocal: true` → 具備完整能力(含 `canManageProfiles`) | `ws-gateway.ts:176` |
| core 啟動時冪等 seed 一個 profile,id 固定為 `default-claude-code`,software 為 `claude-agent-sdk` | `index.ts:152`、`profiles.ts:79` |
| 隔離的本機 core 需要**同時**設四個環境變數:`DESKMONY_CORE_PORT` / `DESKMONY_DATA_DIR` / `DESKMONY_HOME` / `DESKMONY_WORKSPACE` | `scripts/e2e-agent-lifecycle.mjs:192` |
| `permission.resolve` 的 `sessionId` 是**必填**,不可省略靠 requestId 反查 | `PermissionDecisionSchema` |
| e2e 假後端 `scripts/fake-acp-agent.mjs`:一般 prompt 固定回 `"Hello from fake ACP agent"`(分三段 delta);prompt 以 `ACP_WRITE_FILE {json}` 開頭則會發出一則真的權限請求 | `fake-acp-agent.mjs:120-121` |
| e2e 建 ACP profile 的寫法:`profile.create` 帶 `software:"acp"` + `acpConfig:{command: process.execPath, args:[FAKE_AGENT_PATH]}` | `e2e-agent-lifecycle.mjs:307` |

## 12. Linux 可行性(動手前先查證過,不是假設)

「Linux 也能用」是這輪的需求本身,所以先逐條看過 core 與 adapters 裡每一處
`process.platform === "win32"` 分支,確認都有能動的 POSIX 對應:

| 位置 | Windows 作法 | POSIX 作法 | 判定 |
|---|---|---|---|
| `child-process.ts:killProcessTree` | `taskkill /T /F` | `child.kill("SIGTERM")` | 可用(孫程序可能短暫存活,檔案內已如實記載這個限制) |
| `child-registry.ts:queryProcessCreatedAt` | PowerShell CIM | `ps -o lstart=` | 可用 |
| `child-registry.ts` 回收殘留 | `taskkill` | `process.kill(pid, "SIGTERM")` | 可用 |
| `agent-detector.ts` | `where` | `which` | 可用 |
| `tool-input.ts` 路徑正規化 | 轉小寫 | 保留大小寫 | 正確(POSIX 檔名區分大小寫) |

原生相依:`better-sqlite3` 有 linux-x64 prebuild;`node-pty` 在 ubuntu runner
上編得起來。**Electron 只是 `apps/desktop` 的 devDependency,CLI 完全不碰**——
Linux CI job 應設 `ELECTRON_SKIP_BINARY_DOWNLOAD=1` 跳過那 ~100MB 下載,並用
`pnpm --filter "@deskmony/cli..." build` 只建 CLI 與它的相依,不建 desktop。

尚未查證、也不在這輪承諾範圍內的:各 adapter 在 Linux 上對真實後端
(Claude Code / Codex / OpenCode)的實際行為。CLI e2e 只用假後端,證明的是
「core + CLI 這條路徑在 Linux 上通」,不是「所有後端在 Linux 上都通」。

## 13. 動手前先跑過的五支探針(2026-09-09,結果都在下面)

規格裡最新穎、最容易猜錯的幾個假設,在派工前先用一次性腳本對**真的 core**
驗證過,不是紙上推論。全部通過,實作時照著這裡的結論寫即可。

### 13.1 `serve` 用 `await import()` 在同一行程啟動 core —— 可行

先設 `process.env.DESKMONY_*`,再 `await import(core 進入點)`,core 的
`main()` 會在 import 當下執行並吃到剛設的值,gateway 隨即可連。**必須用動態
`import()`**:靜態 import 會被提升到模組本體之前求值,環境變數還來不及設。

### 13.2 注入 `ws` 當 `WebSocketLike` —— 零轉接即可用

`ws@8.21.1` 的實例查證結果:

| 項目 | 結果 |
|---|---|
| `addEventListener` / `removeEventListener` / `send` / `close` | 都有 |
| `readyState`、`WebSocket.OPEN` / `CONNECTING` | 1 / 0,與 WHATWG 規格一致 |
| `"message"` 事件的 payload | 在 `ev.data`,型別是 **string**(不是 Buffer),`JSON.parse(ev.data)` 直接可用 |

所以 `GatewayClient` 現有的 `JSON.parse(ev.data)` 一行都不用改。注意 `ws` 是
CJS,CLI 端用 `import WebSocket from "ws"` 取 client class 即可。

### 13.3 純 WS client 走完整條權限流程 —— 可行,但有一個陷阱

用假後端送 `ACP_WRITE_FILE`,收到 `permission-request`,以
`permission.resolve`(帶 `sessionId`)允許,檔案確實被寫入且 `completed` 事件
送達。實際收到的事件內容:

```
toolName    = "Write file"
strong      = false
description = "Write file"
input       = {"path":"…\written-by-agent.txt","content":"hi"}
```

**陷阱:`description` 只是 `"Write file"`,沒有任何可判斷的資訊。** 真正要給
人看的東西(檔案路徑、指令內容)全在 `input` 裡。CLI 的權限提示**必須渲染
`input`**,不能只印 `description` —— 只印 `description` 的話,使用者看到的是
「要不要允許 Write file」而完全不知道要寫哪個檔,那個提示等於沒有,而這正是
安全罩最後一道人工關卡。`input` 的形狀隨工具而異(`unknown`),渲染時要防禦性
處理:認得的鍵(`path`/`command`/`file_path`)優先單獨顯示,其餘 JSON 截斷。

### 13.4 拒絕權限後,agent 仍然送出 `completed` —— 退出碼不能只看事件

同一支探針把 `decision` 改成 `"deny"` 重跑,結果:

```
FILE_WRITTEN = false                                  (檔案確實沒被寫)
EVENT_TYPES  = ["tool-call","permission-request","completed"]
```

**沒有 `error` 事件。** 被拒絕的那一輪一樣以 `completed` 收尾,和成功的一輪在
事件層面長得一模一樣。

推論(直接影響 §2 的退出碼表):CLI **必須自己記住這一輪有沒有拒絕過任何一筆
權限請求**,收到 `completed` 時再據此決定退出碼——只看事件型別就 `exit 0` 的
話,一個「什麼都沒做成」的回合會被回報成成功。這對 `run` 用在腳本/CI 裡尤其
致命:呼叫端會以為工作完成了。

實作要求:`run` 維護一個 `deniedTools: string[]`,`completed` 抵達時若非空,
印出被拒的工具清單到 stderr 並以退出碼 4 結束,`completed` 的 `finalText` 仍然
正常印到 stdout(agent 可能有話要說)。

### 13.5 `session.interrupt` 真的能中斷跑到一半的回合

用假後端的 `ACP_SLEEP_TURN {"ms":60000}` 製造一個 60 秒的回合,開始 3 秒後送
`session.interrupt`:

```
ELAPSED_MS      = 3226        (回合本體要求睡 60000ms)
TYPES           = ["completed"]
SESSION_STATUS  = idle
```

回合確實提早結束、session 回到 `idle`,所以 §7 的「Ctrl+C 第一次中斷這一輪、
不離開」是做得到的。

但注意它**又一次以 `completed` 收尾**——和 §13.4 的拒絕情境同一個教訓:
成功、被拒、被中斷,三者在事件層面完全無法分辨,全都只送 `completed`。CLI
的每一個結束路徑都必須靠自己維護的狀態來判斷,不能從事件反推。

## 14. 施工中發現:既有 CI 從未執行過,且步驟順序會讓它第一次就掛掉

做這輪 Linux CI job(§9)時查證的副產物,**與 CLI 無關但必須一起修**,因為新的
job 會踩同一顆地雷。

### 14.1 事實

`gh run list` 回傳空陣列 —— `.github/workflows/ci.yml`(2026-09-04 新增)**一次
都沒有執行過**。工作流程的觸發條件是 `push: branches: [master]` 與
`pull_request`;那批修補推上了 `origin/fix/audit-top-five`,但沒有合進 master、
也沒有開 PR,所以兩個條件都沒被滿足。

### 14.2 而且它現在的步驟順序是錯的

```yaml
- name: Typecheck
  run: pnpm typecheck      # ← 先 typecheck
- name: Build
  run: pnpm build          # ← 後 build
```

CI 的 checkout 是全新的,沒有任何 `dist/`。實測(把 `packages/shared/dist`
暫時移走再跑)結果:

```
packages/adapters : error TS2307: Cannot find module '@deskmony/shared'
apps/core         : error TS2339: Property 'name' does not exist on type 'MergeConflictError'
```

**這與新增的 `packages/client` 無關**——上面兩個都是既有套件,未被這輪改動。
根因是各 package 的 `typecheck` 是 `tsc -p tsconfig.json --noEmit`,不帶
`--build`,不會自動編譯它依賴的 workspace package;跨 package 的 import 解析
到的是 `packages/*/dist/*.d.ts`,那在全新 checkout 上不存在。

### 14.3 修法

把 CI 的 Build 步驟移到 Typecheck 之前。`pnpm build` 本身就會跑 `tsc`(帶
emit),真正的型別錯誤一樣擋得住;`pnpm typecheck` 留在後面仍有價值——
`apps/desktop` 的 `tsconfig.json` 是 `noEmit` 專用的,只有這一步會檢查它。

新增的 Linux job 同樣必須 build 在前。

### 14.4 這件事本身的教訓

2026-09-03 稽核抓到的核心問題是「宣稱有把關機制,但機制不存在」。這次是它的
下一層:**機制存在了,但機制本身從來沒有被驗證過能不能跑**。加 CI 的那一輪
沒有把它跑起來看一次綠燈,所以一個第一步就會失敗的 workflow 安靜地躺了五天。

## 15. 怎麼讓 `deskmony` 真的出現在 PATH 上

原本的 §7 只寫了「npm `bin` 會自動產生 `.cmd`/`.ps1` shim」,那句話**對這個
repo 不成立**,是規格的缺口。查證結果:

```
$ ls node_modules/.bin
electron-rebuild  tsc  tsserver          # 沒有任何 workspace 套件的 bin
$ find node_modules -name "deskmony-mcp-bridge-server*"
(空)
```

pnpm 只會在**依賴該套件的那個 package** 底下建 shim(所以既有的
`deskmony-mcp-bridge-server` 只出現在 `apps/core/node_modules/.bin/`),不會放
進 workspace 根目錄。這個 repo 的套件又全是 `private: true`,沒發佈到 npm。
換句話說,光跑 `pnpm install` 之後在終端打 `deskmony` 一定是 command not found。

三條路,都要在 README 寫清楚:

| 方式 | 指令 | 適用 |
|---|---|---|
| 不裝,直接跑 | `node apps/cli/dist/bin.js …` | 開發、CI、e2e。**最可靠,零設定** |
| workspace 內的捷徑 | `pnpm cli …`(根 package.json 加一條 `"cli": "node apps/cli/dist/bin.js"`) | 在 repo 裡工作時 |
| 真的進 PATH | `cd apps/cli && npm link` | 想在任何目錄下打 `deskmony`。**實測可用** |

### 15.1 實測結論(2026-09-09):用 `npm link`,不要用 `pnpm link --global`

原本這裡推薦 `pnpm link --global`。實測後**推翻**:

- `pnpm link --global` 在這台機器上**不成立**——`PNPM_HOME` 未設定、PATH 也
  不含 pnpm,得先跑 `pnpm setup`,而那會改寫使用者的 PATH。
- `npm link` **零設定可用**:npm 的全域 prefix(Windows 是
  `%APPDATA%\npm`)在標準 Node 安裝下本來就在 PATH 上。

驗證方式很重要:**用管線測不出來**。Node 在 Windows 一律輸出 UTF-8 位元組,
渲染成什麼樣完全取決於主控台的 codepage,`cmd /c deskmony --help | head` 只
會看到原始位元組。必須開一個真的主控台視窗看。實際做法是 computer-use 截圖
(Windows 11 的 `cmd.exe` 跑在「終端機」裡,兩個都要授權,click tier 就夠)。
結果:中文與兩欄排版**完全正常**。

驗完記得把全域連結拆掉(`npm unlink -g @deskmony/cli`,再手動 `rmdir` 殘留
的空 `@deskmony` 目錄)——尤其連結的是 worktree 路徑時,那個目錄合併後會
消失,留著就是一個壞掉的指令。

長遠解是把 `@deskmony/cli` 發成公開 npm 套件(`npx deskmony`),那需要先解掉
`workspace:*` 相依(發佈前要 `pnpm publish` 自動改寫版本號)與 `private: true`,
留在 §10 的 Phase 2。
