/**
 * agent-env.ts(2026-10-05,安全):組出「要交給 agent 子行程」的環境變數——一律把 Deskmony 自己的內部憑證濾掉。
 *
 * ## 為什麼一定要濾(安全,不是便利)
 *
 * 桌面殼(`apps/desktop/electron/main.ts`)啟動 core 之前**一律**把 `process.env.DESKMONY_AUTH_TOKEN` 設好
 * (使用者沒設定時也會產生一組 session-only 的),所以真實 app 裡的 core 帶著**主認證 token**。四個 adapter 原本都是
 * `{ ...process.env, ...launch.env, ...config.env }` 組子行程環境(Claude SDK 那條在沒有 provider env 時乾脆省略 `env`、
 * 讓 SDK 繼承整份 `process.env`)——於是**任何 agent 的 bash 工具都讀得到 `DESKMONY_AUTH_TOKEN`**。
 * 拿著它連上 gateway(`ws://127.0.0.1:<port>`)就等於使用者本人:核准自己的權限請求、把自己切成 YOLO 與「真.無限制」、
 * 新增政策 allowlist——整個安全罩(default-deny、hard-deny 四類、auto/YOLO 的斷路器)是 agent 自己能拆的。
 *
 * ## denylist(最後一步無條件套用)
 *
 *  - `DESKMONY_AUTH_TOKEN`:主認證 token。**沒有任何正當理由讓 agent 拿到**,所以連使用者自己在 provider 環境變數
 *    (`getProviderEnv()` → `launch.env`)或 `acpConfig.env` 等設定裡填了它也照樣刪——denylist 排在所有 layer **之後**,不是起點。
 *  - `DESKMONY_MCP_BRIDGE_*`:session 網路 MCP bridge 的 scoped token / gateway 位址 / session id / 開關(見 mcp-bridge-launch.ts)。
 *    **bridge 子行程需要的值是另外明確交給它的**(ACP:`session/new` 的 `mcpServers[].env`;OpenCode HTTP:`mcp.deskmony.environment`;
 *    Claude SDK:in-process,沒有子行程),不是靠 agent 自己的環境繼承——所以 agent 環境裡完全不需要、也不該有這些變數
 *    (有的話 agent 的 bash 能冒充這個 session 傳訊息、開 session)。
 *  - `OPENCODE_SERVER_PASSWORD` / `OPENCODE_SERVER_USERNAME`:從**父行程**(啟動 core 的 shell)繼承來的值。OpenCode 的兩個 adapter
 *    在這個函式**之後**才自己設一組新的隨機密碼(opencode-server-auth.ts,opencode 行程本身需要它);其他 agent 完全不該拿到
 *    (拿到別人的 opencode 伺服器密碼 = 能替那個伺服器核准權限)。opencode 行程自己啟動的 bash 工具環境另外由 Deskmony 的
 *    opencode 外掛(opencode-shell-env-plugin.ts)濾掉,見 docs/DECISIONS.md §J。
 *
 * 比對**不分大小寫**:Windows 的環境變數名稱不分大小寫,而 `{ ...process.env }` 展開出來的是一般物件、保留原本的大小寫——
 * 若只比對大寫字面值,父行程剛好設成 `Deskmony_Auth_Token` 的話濾不掉,子行程(Windows 照樣視為同一個變數)卻看得到。
 *
 * ## 仍然擋不住的(誠實記錄)
 *
 * 同一個作業系統使用者底下的程序,能讀其他程序的記憶體(含 core 行程的環境區塊)、或用 DPAPI 解密 Electron `safeStorage`
 * 存在本機的 token 檔。這屬沙箱/作業系統隔離的範疇,不是環境變數層級能解的,見 docs/DECISIONS.md §J。
 */

/** 完整變數名稱(大寫)。 */
export const AGENT_ENV_DENY_NAMES: readonly string[] = [
  "DESKMONY_AUTH_TOKEN",
  "OPENCODE_SERVER_PASSWORD",
  "OPENCODE_SERVER_USERNAME",
];

/** 變數名稱前綴(大寫)。 */
export const AGENT_ENV_DENY_PREFIXES: readonly string[] = ["DESKMONY_MCP_BRIDGE_"];

/** 一層環境變數覆寫;`undefined` 整層略過,值為 `undefined` 的鍵照 `Object.assign` 語意覆寫成 `undefined`。 */
export type AgentEnvLayer = Readonly<Record<string, string | undefined>> | undefined;

/** 這個名稱是不是 Deskmony 內部憑證(不分大小寫)。 */
export function isDeskmonyInternalEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  return AGENT_ENV_DENY_NAMES.includes(upper) || AGENT_ENV_DENY_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

/**
 * 從 `process.env` 出發,依序疊上 `layers`(後面的蓋前面的:provider env → `launch.env` → config.env……由呼叫端決定順序),
 * 最後**一律**刪除 Deskmony 內部憑證 denylist。回傳的是新物件,不會動到 `process.env` 或任何 layer。
 *
 * 只能用在「要交給 agent 的子行程」。Deskmony 自己要交給**特定**子行程(例如 OpenCode 行程本身需要的伺服器密碼)的值,
 * 必須在呼叫這個函式**之後**再設進回傳物件,不能放進 layers(放進去會被 denylist 刪掉)。
 */
export function buildAgentChildEnv(...layers: AgentEnvLayer[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const layer of layers) {
    if (layer) Object.assign(env, layer);
  }
  for (const name of Object.keys(env)) {
    if (isDeskmonyInternalEnvName(name)) delete env[name];
  }
  return env;
}
