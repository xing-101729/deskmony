import { randomBytes } from "node:crypto";

/**
 * opencode-server-auth.ts(2026-10-03,安全):替 Deskmony 啟動的 opencode 子行程加上 HTTP basic auth。
 *
 * ## 為什麼一定要設(安全,不是便利)
 *
 * `opencode serve`(`OpenCodeAdapter` 的 HTTP 對接)與 `opencode acp`(`AcpAdapter` 的 ACP 對接)**都會**在 loopback 開一個
 * HTTP 伺服器(2026-10-03 實測,1.18.7,用 `Get-NetTCPConnection -OwningProcess` 看行程樹):`opencode acp` 聽 `127.0.0.1:4096`;
 * `opencode serve --port 0` 的 0 **不是**「隨機」——它先試 opencode 的預設 port 4096,被占用才改隨機(實測第一個 serve 在
 * 4096、同時間第二個在 63168),所以最常見的第一個伺服器**位址是可預測的**,根本不必掃。而且**預設完全沒有認證**(啟動時印
 * "OPENCODE_SERVER_PASSWORD is not set; server is unsecured";實測不帶任何標頭 `GET /config` 直接回 200)。
 * 本機任何程序、任何使用者帳號底下的任何東西,只要連到那個 loopback port 就能:
 *
 *  1. `POST /permission/{id}/reply` 替 opencode **核准權限請求**——完全繞過 Deskmony 的政策引擎(default-deny、hard-deny 四類、
 *     auto/YOLO)與使用者本人;
 *  2. `GET /config` 讀到完整設定,其中含 `mcp.deskmony.environment` 裡的 **scoped bridge token**(只能呼叫 session 網路的
 *     五個 gateway 方法,但仍是能冒充該 session 傳訊息、開 session 的憑證);
 *  3. 對 session 送 prompt、讀整段對話。
 *
 * ## 做法
 *
 * opencode 支援 basic auth:`OPENCODE_SERVER_PASSWORD`(設了就要求認證,未設則不鎖)與 `OPENCODE_SERVER_USERNAME`(預設 `opencode`)。
 * 實測帶了密碼之後,不帶標頭與帶錯密碼的請求(連 `/global/health` 都是)一律 401,帶對才 200;`opencode acp` 帶了密碼照常運作
 * (initialize / session/new / session/prompt 都正常,它內部的 HTTP client 不受影響)。
 *
 *  - **每次 spawn 都產生一組新的隨機密碼**(32 bytes、base64url,43 字元):沒有任何長效秘密、不同 session 之間互不通用、
 *    不需要保管;行程結束就隨之作廢。
 *  - **只走環境變數,不放 command args**(命令列在行程列表看得到;環境變數需要同使用者權限去讀行程記憶體)。
 *  - **一律以 Deskmony 產生的為準,覆蓋**使用者在 provider 環境變數、`opencodeConfig.env` 或啟動 core 的 shell 裡設的
 *    `OPENCODE_SERVER_PASSWORD`/`OPENCODE_SERVER_USERNAME`:(a) adapter 必須知道密碼才能呼叫自己啟動的伺服器,沿用使用者的值等於
 *    要把一個長效秘密從設定檔/環境讀進來;(b) 使用者給的值可能是共用的、很短的、或同時給了別的 opencode 實例用,不該決定這個伺服器的
 *    強度。覆蓋的唯一代價是使用者無法用自己的密碼從外部連進 Deskmony 啟動的那個 opencode——這正是這道鎖要擋的事。
 *  - 密碼只存在 adapter 的記憶體(`InternalSession.authorization`),不寫 log、不寫 DB、不進任何 AgentEvent。
 *
 * ## agent 自己的 bash 讀得到密碼(2026-10-05 已用外掛堵上)
 *
 * 密碼在 opencode 行程的環境變數裡,而 opencode **不會**把它從自己啟動的子行程(bash 工具)環境裡濾掉——2026-10-03 實測(1.18.7 +
 * `opencode/big-pickle`,YOLO)模型跑 `node -e "…process.env.OPENCODE_SERVER_PASSWORD…"` 得到 PRESENT。所以光靠這道鎖,**agent 自己
 * (以及它在 bash 工具裡啟動的任何東西)仍然拿得到密碼**,能 `curl` 自己的伺服器去 `POST /permission/{id}/reply` 核准自己(YOLO 下
 * hard-deny 的「非白名單外連」只看工具 input 裡結構化的 host/url 欄位,不解析 bash 指令字串,擋不住)。
 *
 * 2026-10-05:Deskmony 自帶一個 opencode 外掛(opencode-shell-env-plugin.ts),在 opencode 的 `shell.env` hook 把
 * `OPENCODE_SERVER_PASSWORD`/`OPENCODE_SERVER_USERNAME`/`OPENCODE_CONFIG_CONTENT` 從 agent 的 bash 工具環境移除(對真實 opencode 1.18.7
 * 實測:設成 `undefined` 就真的消失)——見該檔檔頭與 docs/DECISIONS.md §J。外掛沒載入(舊版 opencode)時 adapter 會警告,這時這道鎖
 * 仍然**擋不住 agent 本身**。
 *
 * 仍然擋不住的:同一個作業系統使用者底下的程序(含 agent 在 bash 裡啟動的)能讀 opencode 行程的記憶體(環境區塊)——屬沙箱/作業系統隔離的範疇。
 */

export const OPENCODE_SERVER_USERNAME_ENV = "OPENCODE_SERVER_USERNAME";
export const OPENCODE_SERVER_PASSWORD_ENV = "OPENCODE_SERVER_PASSWORD";

/** 固定的使用者名稱(不是秘密,明確設定只是不依賴 opencode 的預設值)。 */
const OPENCODE_SERVER_USERNAME = "deskmony";
const PASSWORD_BYTES = 32;

/**
 * 產生一組新的隨機認證,寫進(覆蓋)`env` 的 `OPENCODE_SERVER_PASSWORD`/`OPENCODE_SERVER_USERNAME`,回傳 adapter 呼叫該伺服器時
 * 要帶的 `Authorization` 標頭值(`Basic ...`)。**每個子行程呼叫一次**,回傳值只能留在記憶體裡。
 *
 * 呼叫端必須在使用者的 env 都合併完**之後**呼叫(覆蓋才會生效),並且只傳給這一個子行程。
 */
export function applyOpencodeServerAuth(env: NodeJS.ProcessEnv): string {
  const password = randomBytes(PASSWORD_BYTES).toString("base64url");
  env[OPENCODE_SERVER_USERNAME_ENV] = OPENCODE_SERVER_USERNAME;
  env[OPENCODE_SERVER_PASSWORD_ENV] = password;
  return `Basic ${Buffer.from(`${OPENCODE_SERVER_USERNAME}:${password}`).toString("base64")}`;
}
