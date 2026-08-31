import { z } from "zod";
import { CLAUDE_MODEL_ALIASES } from "./known-models.js";

/**
 * provider-catalog.ts(這輪新增):把「Paseo 的 provider 設計」——具名 provider
 * 繼承一個內建 provider、再用使用者偏好覆寫差異(label/env/models/enabled/
 * order)——移植到 Deskmony。不是照抄 Paseo 的 `~/.paseo/config.json` 檔案格式
 * (Deskmony 的設定存在 SQLite,見 apps/core/src/settings/settings-store.ts),
 * 而是移植這套「provider 目錄 + 繼承覆寫」的**概念**。
 *
 * 這裡只定義**內建 provider 目錄**本身(靜態常數 + zod schema),純函式
 * `resolveProviders()`(見 resolve-providers.ts)才是「內建目錄 + 偵測結果 +
 * 使用者偏好 → 可直接用來建立 profile 的清單」這件事的實際邏輯,兩者分開
 * 是因為目錄是靜態資料、resolve 是每次呼叫都要重新套用偵測/偏好的計算。
 *
 * 刻意不做(記入未來項目,對齊需求描述「這輪不做」的範圍)：
 *   - `thinkingOptions`(Paseo 模型物件的思考預算選項)。
 *   - `disallowedTools`(Paseo provider 層級的工具黑名單)。
 *   - Paseo 的「具名 provider 多實例」(例如同時存在 `claude-work`/
 *     `claude-personal` 兩個都 extends `claude` 的具名 provider)——這輪改用
 *     更簡單的對應:`AgentProfile` 本身新增 `providerId`/`env`(見
 *     agent-profile.ts),同一個 provider 目錄項目可以被多個 profile 引用,
 *     每個 profile 各自帶不同的 `env`(例如不同的 `ANTHROPIC_API_KEY`),效果
 *     等同 Paseo 的「同 provider 多組憑證」,但資料模型更貼近 Deskmony 既有的
 *     「profile 是可建立 session 的具體設定檔」這個核心概念,不需要在 provider
 *     目錄本身之外再發明一層「具名 provider 實例」。
 */

/** 對齊 Paseo 模型物件的形狀(id/label/description/isDefault),先不含
 *  `thinkingOptions`(見上方檔案註解「刻意不做」)。 */
export const ProviderModelSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
  isDefault: z.boolean().optional(),
});
export type ProviderModel = z.infer<typeof ProviderModelSchema>;

/**
 * provider 目錄的 `software` 欄位刻意比完整的 `AgentSoftwareSchema` 窄:只允許
 * `apps/core/src/index.ts` 的 `AdapterRegistry` 實際註冊過的四種
 * (claude-agent-sdk/acp/pty/opencode),不可能是 `"codex"`——延續
 * `packages/shared/src/agent-target.ts` 的 `DerivedAgentTarget.software` 同一
 * 手法(那裡用 TS 的 `Extract<...>`,這裡用獨立的 zod enum 常數,避免依賴
 * zod 版本是否支援 `ZodEnum.extract()`),在型別與執行期驗證兩層都保證
 * `BUILTIN_PROVIDERS`/使用者自訂的 provider 不會產生 AdapterRegistry 建不起來
 * 的組合(呼應 e2e 步驟22 系列「codex 不可產生建不起來的 profile」的既有精神,
 * 這裡是對 provider 目錄套用同一條原則,見 scripts/e2e-gateway.mjs 新增的
 * provider-catalog 決定性測試)。
 */
export const RegisteredAgentSoftwareSchema = z.enum(["claude-agent-sdk", "acp", "pty", "opencode"]);
export type RegisteredAgentSoftware = z.infer<typeof RegisteredAgentSoftwareSchema>;

export const ProviderCatalogEntrySchema = z.object({
  /** 穩定識別碼(例如 "claude-agent-sdk"、"gemini"),使用者偏好(settings 的
   *  per-provider prefs)以這個 id 為 key 覆寫。 */
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
  software: RegisteredAgentSoftwareSchema,
  /**
   * 對應 `AgentDetectionEntry.key`(見 detect.ts),`resolveProviders()` 依此
   * 帶入安裝狀態與解析出的執行檔路徑。省略代表這個 provider 沒有對應的自動
   * 偵測項(目前只有 `custom-pty` 這個逃生閥)——一律視為「可選,但 command
   * 需要使用者手動輸入」,不臆測任何路徑。
   */
  detectKey: z.string().optional(),
  /** 附加在偵測到的 command 後面的固定參數(例如 gemini 需要 `--acp` 才會講
   *  ACP,對齊 Paseo 範例 `"command": ["gemini", "--acp"]`)。 */
  defaultArgs: z.array(z.string()).optional(),
  /** 這個 provider 自己的模型清單;由外部工具自管模型的 provider 給空陣列
   *  (與 apps/core/src/detect/agent-detector.ts 既有的 `modelsNote` 慣例一致,
   *  不臆測)。 */
  models: z.array(ProviderModelSchema),
  supportsModelSelection: z.boolean(),
  /** UI 排序(數字越小越前面),使用者偏好的 `order` 可覆寫。 */
  order: z.number().int(),
});
export type ProviderCatalogEntry = z.infer<typeof ProviderCatalogEntrySchema>;

/**
 * 使用者對某個 provider 的偏好覆寫(settings 持久化,見
 * apps/core/src/settings/settings-store.ts)。所有欄位皆選填——`resolveProviders()`
 * 只在欄位「有提供」時才覆寫對應的預設值,省略的欄位維持目錄預設。
 *
 * 語意(對應需求描述,務必與 resolveProviders() 的實作保持一致):
 *   - `enabled`:預設 true(未設定 = 啟用)。
 *   - `order`/`label`:提供時覆寫,否則沿用目錄預設。
 *   - `env`:併入子程序環境變數(見 packages/adapters 各 adapter 的 spawn());
 *     **可能含 API key,一律 write-only**——gateway 回傳時只回傳 key 名稱,
 *     值一律遮罩成 "***"(見 `MaskedProviderPrefsSchema`、
 *     apps/core/src/settings/settings-store.ts 的 `maskProviderPrefsMap()`),
 *     絕不把明文值回傳給任何連上 gateway 的 client。
 *   - `models`:提供時**整批取代**目錄預設的模型清單(對齊 Paseo 的
 *     `"models"` 欄位語意)。
 *   - `additionalModels`:**合併**進(目錄預設或已被 `models` 取代的)清單,
 *     以 model id 去重,使用者定義的項目優先(對齊 Paseo 的
 *     `"additionalModels"` 欄位語意)。
 *   - `enabledModelIds`:從合併後的模型清單再過濾一次「顯示哪些」,空陣列
 *     或省略 = 全部啟用(沿用既有 `settings.getEnabledModels` 的約定)。
 */
export const ProviderPrefsSchema = z.object({
  enabled: z.boolean().optional(),
  order: z.number().int().optional(),
  label: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  models: z.array(ProviderModelSchema).optional(),
  additionalModels: z.array(ProviderModelSchema).optional(),
  enabledModelIds: z.array(z.string()).optional(),
});
export type ProviderPrefs = z.infer<typeof ProviderPrefsSchema>;

/**
 * gateway 回傳給 client 的「遮罩版」provider 偏好——`env` 的**值**一律被覆寫成
 * `"***"`,只保留 key 名稱本身(讓 UI 知道「已經設定了哪些 key」以顯示標籤,
 * 但拿不到明文值)。與 `ProviderPrefsSchema` shape 相同,只是 `env` 的值域在
 * 語意上保證是遮罩過的字串,不是真正的 secret——分開命名/匯出是為了讓
 * 呼叫端(desktop UI)型別上清楚區分「這是遮罩過的、不能拿來當真正 env 用」。
 */
export const MaskedProviderPrefsSchema = ProviderPrefsSchema;
export type MaskedProviderPrefs = z.infer<typeof MaskedProviderPrefsSchema>;

/** `settings.setProviderPrefs` 的輸入——與 `ProviderPrefsSchema` 同構,獨立
 *  命名是為了讓呼叫端(desktop UI)清楚這是「這次要 patch 的欄位」,不是完整
 *  狀態(見 apps/core/src/settings/settings-store.ts 的 patch 合併語意:
 *  enabled/order/label 直接覆寫,env 淺層合併進既有 env,models/
 *  additionalModels/enabledModelIds 整批取代)。 */
export const ProviderPrefsPatchInputSchema = ProviderPrefsSchema;
export type ProviderPrefsPatchInput = z.infer<typeof ProviderPrefsPatchInputSchema>;

/**
 * 內建 provider 目錄。`claude-agent-sdk` 的靜態 `models` 這輪起改成 `[]`——
 * 不再把任何寫死的 model 清單放在這裡(原本的 `KNOWN_CLAUDE_MODELS`,見
 * known-models.ts,已整個移除——那份清單會過時,顯示過時清單比完全不顯示更
 * 容易誤導使用者)。實際可選的 model 清單完全來自
 * `apps/core/src/detect/agent-detector.ts` 的 `detectClaudeAgentSdk()`:
 * 有 `ANTHROPIC_API_KEY` 且查得到 Anthropic Models API 才非空,查不到就是
 * 空陣列 + `modelsNote` 說明原因,不再有任何靜態清單可以退回。
 * `resolveProviders()` 的 `mergeModelsById(entry.models, detected.models)`
 * (見 resolve-providers.ts)在這裡的靜態 `models` 是 `[]` 時,等同直接採用
 * 偵測結果——與下方 `opencode` 項目「靜態 `models: []`,實際清單由偵測結果
 * 補上」的既有模式完全一致,不是這輪新發明的合併語意。其餘外部 CLI
 * (`gemini`/`codex`/`aider`/`claude-cli`)一律交由 `modelsNote`(見
 * detect.ts/agent-detector.ts)說明模型由該工具自管,`models: []`(可用
 * provider 偏好的 `additionalModels` 補上已知清單,例如 Paseo 範例的 gemini
 * `experimental-model`)。
 *
 * `software` 選擇的原則(呼應 agent-target.ts 既有的
 * `deriveDefaultAgentTarget()` 安全預設,但這裡刻意不呼叫該函式——provider
 * 目錄本身就是「哪個 provider 對應哪個已註冊 adapter」的權威來源,不需要再
 * 透過偵測分類反推):
 *   - `claude-agent-sdk`:內嵌 SDK,不需要 command。
 *   - `claude-cli`:外部 `claude` 執行檔,預設走 PTY 直通(bare CLI 不保證講
 *     ACP,與 agent-target.ts 對 acp 分類偵測項的既有保守預設一致)。
 *   - `gemini`:對齊需求描述引用的 Paseo 範例(`"extends": "acp", "command":
 *     ["gemini", "--acp"]`)——固定用 ACP 對接、`defaultArgs: ["--acp"]`。
 *   - `opencode`:對應這輪稍早新增的 `OpenCodeAdapter`(HTTP + SSE)。
 *   - `aider`:目前沒有專屬 adapter,映射成 `pty`(`AgentSoftwareSchema` 沒有
 *     對應的 `"aider"` 獨立列舉值,PTY 直通是唯一可行選項)。
 *   - `codex`:**這輪(Codex ACP 橋接)起改映射成 `"acp"`**——OpenAI 官方
 *     `codex` binary 本身不講 ACP(`openai/codex#9085` 要求原生支援已 closed
 *     as not planned),但透過社群/Zed 系維護的橋接套件
 *     `@agentclientprotocol/codex-acp`(見 packages/adapters/package.json 的
 *     相依、`packages/adapters/src/codex-acp-locator.ts`)可以把 codex 接上
 *     既有的通用 `AcpAdapter`——這個套件內附自己的 `@openai/codex` 相依,
 *     使用者不需要另外安裝 codex CLI,`command`/`args` 也不是使用者本機
 *     PATH 上的路徑,而是這個橋接套件的絕對進入點路徑,由
 *     `apps/core/src/detect/agent-detector.ts` 的 `detectCodexAcp()` 動態
 *     解析後填進 `AgentDetectionEntry.args`(見 detect.ts 該欄位註解),
 *     `resolveProviders()` 會優先採用這個動態值而非這裡的靜態
 *     `defaultArgs`(這個項目刻意不寫 `defaultArgs`,見下方 codex 項目定義)。
 *     `docs/DECISIONS.md` B2 對這個取捨(依賴非 OpenAI 官方維護的第三方套件)
 *     有更完整的說明。
 *   - `custom-pty`:逃生閥,無 `detectKey`,`resolveProviders()` 一律回傳
 *     `command: undefined`,由使用者在 UI 手動輸入(比照既有
 *     ProfileCreateDialog 的「自訂…」選項)。
 */
export const BUILTIN_PROVIDERS: ProviderCatalogEntry[] = [
  {
    id: "claude-agent-sdk",
    label: "Claude Agent SDK(內嵌)",
    description: "深度整合 Claude Code,內嵌 SDK 直接呼叫,不需要 spawn 任何子程序。",
    software: "claude-agent-sdk",
    detectKey: "claude-agent-sdk",
    // 靜態底線用穩定別名(見 known-models.ts 的 CLAUDE_MODEL_ALIASES 註解)
    // ——沒有 ANTHROPIC_API_KEY(只用 claude login 本機登入)時即時查詢拿不到
    // 清單,resolve-providers.ts 會把這份底線跟即時查詢結果合併,保證選單
    // 永遠至少有這幾個別名可選,不會完全空白。
    models: CLAUDE_MODEL_ALIASES,
    supportsModelSelection: true,
    order: 0,
  },
  {
    id: "claude-cli",
    label: "Claude Code CLI",
    description: "外部 claude 執行檔,以 PTY 直通對接。",
    software: "pty",
    detectKey: "claude-code-cli",
    // pty 是無結構化終端直通,建立後不能像 SDK 一樣中途切換 model(見
    // packages/adapters/src/pty-adapter.ts 的 setModel() 一律 throw)——這裡的
    // 「支援 model 選擇」意思是「建立 profile 時把 --model <別名> 烤進固定的
    // 啟動參數」(見 ProfileCreateDialog.tsx 的 resolveTarget()),不是隨時可
    // 切換。底層是同一支 claude 執行檔,同樣的別名清單直接適用。
    models: CLAUDE_MODEL_ALIASES,
    supportsModelSelection: true,
    order: 10,
  },
  {
    id: "gemini",
    label: "Google Gemini",
    description: "外部 gemini 執行檔,以 ACP(Agent Client Protocol)對接,固定帶 --acp 參數(對齊 Paseo 的 gemini provider 設定)。",
    software: "acp",
    detectKey: "gemini-cli",
    defaultArgs: ["--acp"],
    models: [],
    supportsModelSelection: true,
    order: 20,
  },
  {
    id: "opencode",
    label: "OpenCode",
    description: "OpenCode 的 HTTP + SSE headless server API。",
    software: "opencode",
    detectKey: "opencode-cli",
    // 這輪起:目錄本身的靜態清單仍是空的(這裡不臆測任何固定 model
    // 清單——opencode 支援的 provider/model 組合完全依使用者本機安裝/設定
    // 的 opencode 版本而定),但 `resolveProviders()` 這輪新增了「把
    // apps/core/src/detect/agent-detector.ts 用 `opencode models` 偵測到的
    // 清單併入 models 欄位」的邏輯(見 resolve-providers.ts 的
    // baseModels 計算),所以這裡改成 true——與上方 gemini 項目「
    // supportsModelSelection:true 但靜態 models:[],實際清單由偵測結果補上」
    // 的既有先例一致,不是這輪新發明的模式。
    models: [],
    supportsModelSelection: true,
    order: 30,
  },
  {
    id: "opencode-acp",
    label: "OpenCode(ACP,支援團隊訊息)",
    description:
      "同一個 opencode 執行檔,但改用它內建的 `opencode acp` 子命令以 ACP 對接。" +
      "與上面的「OpenCode」項目差別只有一個、但很關鍵:ACP 這條路會掛載 team-bus MCP 工具," +
      "所以這個 provider 建立的成員**能把回覆送回團隊聊天**;走 HTTP server API 的那個不行" +
      "(adapter 內沒有任何 MCP 掛載,見 SOFTWARE_WITH_TEAM_BUS)。單機使用兩者差異不大。",
    software: "acp",
    detectKey: "opencode-cli",
    // `opencode acp`——2026-08-28 對本機實際安裝的 opencode 1.18.7 實測驗證
    // (比照本 repo「以實際觀察到的行為為準,不臆測」的一貫紀律):
    //   ① `opencode acp` 以 **stdio** 說 ACP,initialize 回 protocolVersion 1;
    //   ② `session/new` 帶 **stdio 型** mcpServers 會成功,且 opencode 真的會
    //      啟動該 MCP server 並送出 initialize + tools/list。
    // ②很重要:opencode 的 initialize 只宣告 `mcpCapabilities:{http,sse}`、
    // 沒有提到 stdio,但 stdio 是 ACP 的基線傳輸,實測確認支援——Deskmony 的
    // mcp-bridge-server.ts 正是 stdio 型,所以不需要對 AcpAdapter 做任何修改。
    defaultArgs: ["acp"],
    models: [],
    supportsModelSelection: false,
    order: 31,
  },
  {
    id: "codex",
    label: "Codex",
    description:
      "透過 @agentclientprotocol/codex-acp 橋接套件以 ACP 對接(內附自己的 codex engine,不是使用者自行安裝的 codex CLI)。OPENAI_API_KEY/CODEX_API_KEY 需在下方「環境變數」設定,或改用 ChatGPT 登入。",
    software: "acp",
    detectKey: "codex-acp",
    // 刻意不寫 defaultArgs——這個 provider 的 args(橋接套件進入點絕對路徑)
    // 只能在偵測階段動態解析,見 resolve-providers.ts 的
    // `defaultArgs: detected?.args ?? entry.defaultArgs`。
    models: [],
    supportsModelSelection: false,
    order: 40,
  },
  {
    id: "aider",
    label: "Aider",
    description: "以 PTY 直通對接。",
    software: "pty",
    detectKey: "aider-cli",
    models: [],
    supportsModelSelection: false,
    order: 50,
  },
  {
    id: "custom-pty",
    label: "自訂…(進階,手動輸入 command)",
    description: "沒有自動偵測,command 需要手動輸入(逃生閥,比照既有 ProfileCreateDialog 的自訂選項)。",
    software: "pty",
    models: [],
    supportsModelSelection: false,
    order: 9999,
  },
];
