/**
 * opencode-shell-env-plugin.ts(2026-10-05,安全):**Deskmony 自帶的 opencode 外掛**——把 opencode 行程自己需要、但 agent 的
 * bash 工具不該拿到的環境變數,從 opencode 啟動的 shell 環境裡移除。
 *
 * ⚠️ 這個檔案是被 **opencode 自己的 runtime(Bun)** 載入、不是被 Deskmony 的 core 載入:`opencode-shell-env.ts` 把它編譯後的
 * `.js` 路徑以 `file://` URL 寫進注入給 opencode 的 `OPENCODE_CONFIG_CONTENT` 的 `plugin` 陣列。所以:
 *  - **必須自成一體**(只 import Node 內建模組,不 import 任何相對路徑的檔案,連 `./agent-env.js` 也不行——opencode 載入時不保證
 *    相對路徑的模組解析);
 *  - **只能有一個函式匯出**:opencode 會把外掛模組裡**每一個**函式匯出都當成外掛工廠呼叫(2026-10-05 對 1.18.7 實測:多匯出的
 *    helper 函式被呼叫了),所以不要在這裡匯出任何別的函式(型別、非函式常數沒關係,但保險起見也不匯出)。
 *
 * ## 為什麼要有這個外掛
 *
 * Deskmony 啟動 opencode 時(HTTP 的 `opencode serve`、ACP 的 `opencode acp`)必須用環境變數交給它:
 *  - `OPENCODE_SERVER_PASSWORD` / `OPENCODE_SERVER_USERNAME`:替 opencode 本機伺服器加 basic auth(opencode-server-auth.ts)——
 *    沒有它,本機任何程序都能 `POST /permission/{id}/reply` 替 agent 核准權限、繞過 Deskmony 的政策引擎;
 *  - `OPENCODE_CONFIG_CONTENT`:注入「所有工具都 ask」的設定(opencode-config.ts),HTTP 版另含 `mcp.deskmony.environment` 裡的
 *    scoped bridge token。
 * 但 opencode **不會**把這些從它啟動的 bash 工具環境裡濾掉(2026-10-03 實測 1.18.7 + `opencode/big-pickle`,YOLO:agent 的
 * `node -e` 讀得到密碼)。agent 就能拿密碼 `curl` 自家伺服器的 `POST /permission/{id}/reply` 自我核准——YOLO 下 hard-deny 的
 * 「非白名單外連」只看工具 input 裡結構化的 host/url 欄位、不解析 bash 指令字串,擋不住。
 *
 * ## 機制(2026-10-05 對本機 opencode 1.18.7 **實測**,不是讀文件猜的)
 *
 *  - 外掛 hook `"shell.env"`(`(input: {cwd, sessionID?, callID?}, output: {env: Record<string, string | undefined>}) => Promise<void>`):
 *    opencode 在**每一次**啟動 shell 前(bash 工具、使用者的 `!` shell 指令、PTY)呼叫,把 `output.env` 與 `process.env` 合併成子行程環境
 *    (二進位裡是 `{ ...process.env, ...output.env }`)。
 *  - **把值設成 `undefined` 就真的移除**(不是變成空字串):實測 agent 的 `node -e "'X' in process.env"`、
 *    `process.env.X !== undefined` 都是 false——Node 的 `spawn` 會略過值為 `undefined` 的鍵。所以不必退而求其次設空字串。
 *  - 外掛以 `file://` URL 載入(含空白與中文的路徑要百分比編碼,`pathToFileURL()` 會做)、放進 `OPENCODE_CONFIG_CONTENT` 的 `plugin`
 *    陣列會與使用者全域/專案設定的 `plugin` **串接**(順序:全域 → 專案 → 這個環境變數,所以我們的 hook 最後執行,不會被別人蓋回去)。
 *  - 外掛可以用 `[spec, options]` 元組帶選項,工廠函式的第二個參數收得到;載入失敗(例如更舊的 opencode 不認這個 hook)opencode 只記 log
 *    不影響啟動——所以 adapter 無法從行程本身得知有沒有載入成功,才有下面的「載入標記檔」。
 *
 * ## 載入標記檔(給 adapter 偵測外掛有沒有真的被載入)
 *
 * 工廠函式被呼叫時,若選項有 `loadedMarkerFile`,就寫一個檔案到那個路徑;adapter 在 session 建立之後(opencode 對該資料夾的 instance
 * 啟動時才初始化外掛)去看它存不存在,不存在就 `console.warn`(session 照常運作,只是 agent 的 bash 環境沒被濾)。
 *
 * ## 仍然擋不住的
 *
 * 同一個作業系統使用者底下的程序能讀其他程序的記憶體(含 opencode 行程的環境區塊)——agent 在 bash 裡用 PowerShell/P-Invoke 讀
 * opencode 行程的 PEB 就拿得到。這屬沙箱/作業系統隔離的範疇,見 docs/DECISIONS.md §J。
 */

import { writeFileSync } from "node:fs";

type ShellEnvInput = { cwd?: string; sessionID?: string; callID?: string };
type ShellEnvOutput = { env?: Record<string, string | undefined> };
type PluginOptions = { loadedMarkerFile?: unknown } | undefined;

/** 要從 agent 的 shell 環境移除的變數名稱(大寫;比對不分大小寫)。 */
const STRIPPED_NAMES = [
  "OPENCODE_SERVER_PASSWORD",
  "OPENCODE_SERVER_USERNAME",
  "OPENCODE_CONFIG_CONTENT",
  // 縱深防禦:Deskmony 啟動 opencode 時環境裡本來就已經沒有這些(agent-env.ts 的 denylist),萬一哪天有,這裡再擋一次。
  "DESKMONY_AUTH_TOKEN",
];
const STRIPPED_PREFIXES = ["DESKMONY_MCP_BRIDGE_"];

export const DeskmonyOpencodeShellEnvPlugin = async (_ctx: unknown, options?: PluginOptions) => {
  const markerFile = options && typeof options.loadedMarkerFile === "string" ? options.loadedMarkerFile : undefined;
  if (markerFile) {
    try {
      // 失敗(唯讀目錄等)只是 adapter 會多一則警告,不影響 hook。
      writeFileSync(markerFile, JSON.stringify({ loadedAt: Date.now(), pid: process.pid }));
    } catch {
      // ignore
    }
  }
  return {
    "shell.env": async (_input: ShellEnvInput, output: ShellEnvOutput) => {
      const env = (output.env ??= {});
      for (const name of Object.keys(process.env)) {
        const upper = name.toUpperCase();
        if (STRIPPED_NAMES.includes(upper) || STRIPPED_PREFIXES.some((prefix) => upper.startsWith(prefix))) {
          // `undefined` = 真的移除(Node 的 spawn 略過它),見檔頭實測。
          env[name] = undefined;
        }
      }
    },
  };
};
