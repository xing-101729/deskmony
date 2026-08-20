import { z } from "zod";
import { AgentSoftwareSchema } from "./agent-profile.js";

/**
 * detect.ts(M5 Round D 新增):「設定」介面偵測本機已裝 agent 軟體用的共用
 * 型別(對應 `env.detectAgents` gateway 方法,見 packages/shared/src/gateway.ts
 * 的 `DetectAgentsResultSchema`、apps/core/src/detect/agent-detector.ts 的
 * 實際偵測邏輯)。
 *
 * 這裡只定義**資料形狀**,不含任何偵測邏輯本身 —— 偵測邏輯(allowlist、
 * execFile、逾時)全部在 apps/core(headless server 端),packages/shared
 * 不得 import apps/*(依賴方向規則),UI(apps/desktop)與 core 都只依賴這裡
 * 的 zod schema 當 single source of truth,避免兩邊的型別各自漂移。
 */

/**
 * 一個 agent 軟體回報的單一可用 model。與 `known-models.ts` 的
 * `KnownClaudeModel` 同構(id/label),這裡獨立定義是因為這份型別要涵蓋
 * 所有 agent 軟體(不只 Claude)—— `claude-agent-sdk` 這個偵測項目把
 * Anthropic Models API 動態查到的清單(查不到就是空陣列)塞進 `models`
 * 欄位(欄位剛好一致,不需要轉換),見 agent-detector.ts 的
 * `detectClaudeAgentSdk()`。
 */
export const DetectedModelSchema = z.object({
  id: z.string(),
  label: z.string(),
});
export type DetectedModel = z.infer<typeof DetectedModelSchema>;

/**
 * 單一 agent 軟體(或內嵌 SDK)的偵測結果。
 *
 * `software` 對應 `AgentSoftwareSchema`(見 agent-profile.ts)—— 這輪偵測只
 * 回報「屬於哪個大類」,不是「建立 profile 要填哪個 command」這麼細,UI 這輪
 * 只用它做顯示與接回 model 選單,尚未接回 ProfileCreateDialog 的表單欄位。
 */
export const AgentDetectionEntrySchema = z.object({
  /** 穩定識別碼(例如 "claude-agent-sdk"、"claude-code-cli"),UI list key 用,不會隨語言/顯示文字改變。 */
  key: z.string(),
  /** 顯示用名稱(中文)。 */
  displayName: z.string(),
  software: AgentSoftwareSchema,
  /** 是否偵測到已安裝(內嵌的 claude-agent-sdk 一律為 true)。 */
  installed: z.boolean(),
  /** `--version` 之類指令實際輸出解析出的版本字串,解析不出就不填。 */
  version: z.string().optional(),
  /** 偵測到的執行檔完整路徑(內嵌 SDK 沒有對應的外部執行檔,不填)。 */
  path: z.string().optional(),
  /**
   * `ProviderCatalogEntry.defaultArgs`(見 provider-catalog.ts)的「動態版本」
   * ——用在「command 的參數要看某個 vendored 相依套件實際裝到哪裡才知道」這種
   * 靜態目錄寫不出來的情況(目錄只能是編譯期就固定的字面字串常數),codex-acp
   * 是第一個用到的案例:`args` 是 `resolveCodexAcpBridge()` 解析出來的橋接
   * 套件進入點絕對路徑,每台機器/每次安裝都可能不同。`resolveProviders()`
   * (見 resolve-providers.ts)這個欄位若存在會優先於目錄的靜態 `defaultArgs`。
   */
  args: z.array(z.string()).optional(),
  /** 已知可用的 model 清單;沒有結構化清單時為空陣列(改用 `modelsNote` 說明)。 */
  models: z.array(DetectedModelSchema),
  /** 沒有結構化 model 清單時的說明文字(例如「模型由該工具自行管理」)。 */
  modelsNote: z.string().optional(),
  /** 憑證狀態提示(目前 claude-agent-sdk 與 codex-acp 這兩個獨立探測項會填)。 */
  credentialHint: z.string().optional(),
});
export type AgentDetectionEntry = z.infer<typeof AgentDetectionEntrySchema>;
