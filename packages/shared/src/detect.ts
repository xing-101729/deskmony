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
  /** 已知可用的 model 清單;沒有結構化清單時為空陣列(改用 `modelsNote` 說明)。 */
  models: z.array(DetectedModelSchema),
  /** 沒有結構化 model 清單時的說明文字(例如「模型由該工具自行管理」)。 */
  modelsNote: z.string().optional(),
  /** 憑證狀態提示(目前只有 claude-agent-sdk 這個內嵌項會填)。 */
  credentialHint: z.string().optional(),
});
export type AgentDetectionEntry = z.infer<typeof AgentDetectionEntrySchema>;
