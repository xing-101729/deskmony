/**
 * opencode-config.ts(2026-10-03):Deskmony 啟動 opencode 子行程時,透過環境變數
 * `OPENCODE_CONFIG_CONTENT` 注入的設定——兩種對接方式(`OpenCodeAdapter` 的 HTTP server、
 * `AcpAdapter` 的 `opencode acp`)共用同一份,行為才不會漂移。
 *
 * ## 為什麼一定要注入(安全,不是便利)
 *
 * Deskmony 的核心設計是 default-deny 政策引擎(docs/DECISIONS.md §C:C2 default-deny、C5 hard-deny
 * 四類、C6 auto/YOLO):Claude SDK 與一般 ACP agent 的**每一次**工具呼叫都會變成
 * `permission-request`,由 `PolicyEngine.decide()` 裁決。但 **opencode 預設所有權限都是 allow**,
 * 只有它自己設定裡標成 `"ask"` 的工具才會發 `permission.asked`(HTTP)/`session/request_permission`(ACP)。
 * 使用者的 opencode 設定通常沒有 `permission` 段,於是 OpenCode session 跑 bash/edit/webfetch/MCP
 * 工具時**完全不經過**政策引擎——hard-deny 四類(worktree 外寫入、讀秘密路徑、危險 git、非白名單外連)
 * 對它等於沒生效,auto/YOLO 也只是形式。這裡把所有工具權限改成 `"ask"`,讓每個請求都進
 * Deskmony 裁決(auto/YOLO 照常放行,always-ask 才會彈出確認)。
 *
 * ## 寫法(2026-10-03 對本機 opencode 1.18.7 **實測**,不是讀文件猜的)
 *
 *  - `OPENCODE_CONFIG_CONTENT` 與使用者既有設定**合併**(`opencode debug config` 看得到使用者原有的
 *    mcp/provider/plugin 都還在),而且是 opencode 設定載入順序的**最後一層**(蓋過全域與專案設定)。
 *  - `"permission": "ask"` 與 `{"*": "ask"}` 被正規化成同一個東西;實測 `*` 涵蓋 `bash`/`edit`(含 write)/
 *    `read`/`glob`/`grep`/`todowrite`/`task`(subagent)/MCP 工具(`<server>_<tool>`)等**所有**會呼叫
 *    `ctx.ask()` 的工具。`question` 工具不經過權限(它走自己的 `question.asked` → 使用者對話框),不受影響。
 *  - 規則是**依物件鍵的順序、最後一個符合的生效**(實測 `{"*":"ask","bash":"allow"}` 時 bash 不問、
 *    `{"bash":"allow","*":"ask"}` 時 bash 照問)。因此使用者自己(全域/專案設定檔)寫的
 *    `{"*":"ask","bash":{"git *":"allow"}}` 這類「問全部、只放行某些」的寫法,會在合併後排在 Deskmony 的
 *    `*` **之後**而獲勝——等於一個旁路。對策:在最後再加一個 `"**"`(實測與 `*` 等價、也是 ask)——
 *    Deskmony 新增的鍵一律附加在合併結果的尾端,所以不論使用者設定檔裡有什麼順序,最後生效的都是這一條。
 *    (agent 層級的 `agent.<name>.permission` 是 opencode 在全域 permission **之後**才疊的,這裡管不到;
 *    那要使用者自己在設定檔明確寫才會出現,見 docs 的說明。)
 *
 * ## 與使用者既有的 `OPENCODE_CONFIG_CONTENT` 合併
 *
 * 使用者在設定頁給這個 provider 設的環境變數(`getProviderEnv()`,疊在 `launch.env`)或啟動 core 的
 * shell 環境裡本來就可能有這個變數:解析成 JSON 之後與 Deskmony 的設定**深度合併**,Deskmony 的
 * `permission` 優先(使用者在這個值裡寫的 `permission` 鍵,除了與 Deskmony 同名的之外一律排在 Deskmony 的
 * 規則**前面**,所以最後生效的仍是 Deskmony 的)。解析失敗(或不是 JSON 物件)就 `console.warn` 並**只用
 * Deskmony 的**——寧可少合併使用者的設定,也不能因此讓 default-deny 失效或讓 session 起不來。
 */

/** opencode 讀的環境變數名稱。 */
export const OPENCODE_CONFIG_CONTENT_ENV = "OPENCODE_CONFIG_CONTENT";

/**
 * 三個**唯讀**的 session 網路查詢工具,在 opencode 裡的工具名稱是 `<MCP server 名稱>_<工具名稱>`
 * (server 名稱 `deskmony`,見 `SESSION_NETWORK_MCP_SERVER_NAME`)。
 *
 * 比照 Claude SDK adapter 把這三個放進 `allowedTools`(SDK 層級預先放行、不經過政策引擎)的語意:
 * 它們只是查詢,而且 gateway 端本來就有 scoped token 的方法白名單與呼叫者綁定。所以在**同一份**
 * opencode 設定裡把它們設成 `"allow"`(排在 `*`/`**` 之後才會生效)——不然 always-ask 下每次
 * `list_sessions` 都要人按確認。`create_session`/`send_to_session` 會產生新訊息、驅動別的 agent,
 * **不**預先放行,走一般的 default-deny 流程(always-ask 下會跳出確認;auto/YOLO 自動放行)。
 */
export const SESSION_NETWORK_QUERY_TOOL_NAMES = ["deskmony_list_agents", "deskmony_list_sessions", "deskmony_read_session"] as const;

export interface DeskmonyOpencodeConfigOptions {
  /**
   * 停用 `task` 工具(subagent)。**只有 ACP 對接要設**:`opencode acp` 只把「它自己認識的 ACP session」的
   * `permission.asked` 轉成 `session/request_permission`,而 `task` 建立的子 session 它不認識——實測(2026-10-03,
   * 1.18.7)父 session 的 `task` 權限問過、核准之後,子 session 裡的 bash 權限請求**永遠不會送到 Deskmony**,
   * opencode 就一直等、session 卡死(不是慢,等了近 4 分鐘沒有任何事件)。全部改成 ask 之前這些操作靜默放行,
   * 所以這是「改成 default-deny」帶來的退步,必須處理;能做的只有不讓模型用 subagent(`deny` 的工具 opencode 連
   * 工具清單都不會給模型,實測模型會自己改用 bash)。HTTP 對接不需要——adapter 追蹤子 session 並轉發它們的權限請求,
   * 見 opencode-adapter.ts 的 handleEvent()。
   */
  denySubagents?: boolean;
  /**
   * 這個 session 有掛 Deskmony 的 session 網路 MCP server(名稱 `deskmony`)。給了才會預先放行上面三個查詢工具
   * (沒掛的時候不放行:同名的別家工具不該因此被放行)。
   */
  sessionNetwork?: {
    /**
     * 只有 HTTP adapter 要給:把 bridge 以 `mcp.deskmony`(`type: "local"`)寫進設定。ACP 不用——
     * `AcpAdapter` 經 `session/new` 的 `mcpServers` 掛載。`environment` 含 scoped token,
     * **只放 environment、不放 command**(token 不出現在行程列表的命令列裡)。
     */
    localMcpServer?: { command: string[]; environment: Record<string, string> };
  };
}

type JsonObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 解析使用者既有的 `OPENCODE_CONFIG_CONTENT`;沒有或壞掉都回 `{}`(壞掉會 `console.warn`)。 */
function parseUserConfig(userValue: string | undefined): JsonObject {
  if (userValue === undefined || userValue.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(userValue);
  } catch (err) {
    console.warn(
      `[opencode-config] 使用者設定的 ${OPENCODE_CONFIG_CONTENT_ENV} 不是合法的 JSON,已忽略、只使用 Deskmony 注入的設定: ${err instanceof Error ? err.message : String(err)}`,
    );
    return {};
  }
  if (!isPlainObject(parsed)) {
    console.warn(`[opencode-config] 使用者設定的 ${OPENCODE_CONFIG_CONTENT_ENV} 不是 JSON 物件,已忽略、只使用 Deskmony 注入的設定。`);
    return {};
  }
  return parsed;
}

/**
 * Deskmony 的 `permission` 段。鍵的**順序有意義**(最後符合的生效,見檔頭):`*`、`**` 在前(全部 ask),
 * 之後才是預先放行的查詢工具。
 */
function deskmonyPermission(options: DeskmonyOpencodeConfigOptions): Record<string, "ask" | "allow" | "deny"> {
  const permission: Record<string, "ask" | "allow" | "deny"> = { "*": "ask", "**": "ask" };
  if (options.sessionNetwork) {
    for (const name of SESSION_NETWORK_QUERY_TOOL_NAMES) permission[name] = "allow";
  }
  if (options.denySubagents) permission.task = "deny";
  return permission;
}

/**
 * 組出要放進 `OPENCODE_CONFIG_CONTENT` 的 JSON 字串。`userValue` = 使用者既有的值(provider env 或 shell
 * 環境);回傳值 = 使用者設定與 Deskmony 設定合併後的結果(Deskmony 優先)。
 *
 * 合併規則(只有 `permission` 與 `mcp` 兩個頂層鍵是 Deskmony 的,其餘使用者的鍵原樣保留):
 *  - `permission`:使用者的鍵(排除與 Deskmony 同名者)放前面,Deskmony 的放後面——最後符合者生效,
 *    所以 Deskmony 的 ask 一定贏過使用者在這個值裡寫的任何 allow。使用者寫成字串(`"allow"`)也被取代。
 *  - `mcp`:使用者的其他 MCP server 保留;名為 `deskmony` 的整筆被 Deskmony 的取代(不做欄位層級合併,
 *    不然使用者的同名項目可能把 command 換掉)。
 */
export function buildOpencodeConfigContent(userValue: string | undefined, options: DeskmonyOpencodeConfigOptions = {}): string {
  const merged: JsonObject = { ...parseUserConfig(userValue) };

  const ours = deskmonyPermission(options);
  const userPermission = isPlainObject(merged.permission) ? merged.permission : {};
  const permission: JsonObject = {};
  for (const [key, value] of Object.entries(userPermission)) {
    if (!(key in ours)) permission[key] = value;
  }
  merged.permission = Object.assign(permission, ours);

  const localMcpServer = options.sessionNetwork?.localMcpServer;
  if (localMcpServer) {
    const userMcp = isPlainObject(merged.mcp) ? merged.mcp : {};
    merged.mcp = {
      ...userMcp,
      deskmony: { type: "local", command: localMcpServer.command, environment: localMcpServer.environment, enabled: true },
    };
  }
  return JSON.stringify(merged);
}
