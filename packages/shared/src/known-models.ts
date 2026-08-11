/**
 * KNOWN_CLAUDE_MODELS(M5 Round C):UI 建立/切換 model 時可選的已知 Claude
 * model 清單,集中定義在這裡,供 desktop UI(ProfileCreateDialog 未來若要
 * 選 model、ChatView 的「切換 model」下拉選單)與未來 Round B 的模型偵測
 * 功能共用,不在各處各自硬編一份會漂移的清單。
 *
 * ID 來源與格式(讀取 node_modules 內 `@anthropic-ai/claude-agent-sdk` 的
 * `sdk.d.ts` 後確認,見 `packages/adapters/src/claude-sdk-adapter.ts` 頂端
 * 對接策略註解的延伸調查):
 *   - `Options.model?: string` 的官方註解逐字寫著
 *     `Examples: 'claude-sonnet-5', 'claude-opus-4-8', 'claude-fable-5'`
 *     —— 這裡的 id 直接採用這份 SDK 型別定義檔本身給出的完整 model ID,
 *     不臆測、不外加任何日期尾碼(SDK 註解也沒有帶日期尾碼)。
 *   - SDK 另外在 `AgentDefinition.model`/`AgentInfo.model` 允許簡短 alias
 *     (`'opus'`/`'sonnet'`/`'haiku'`/`'fable'`),但 `Query.setModel()`/
 *     `query({ options: { model } })` 兩處都只在註解舉例完整 ID —— 這裡的
 *     `id` 一律使用完整 ID(避免 alias 在多次呼叫之間指向不同真實模型版本的
 *     歧義),`label` 則是給 UI 顯示用的中文友善名稱。
 *
 * 用途:
 *   - `session.setModel` 的下拉選單選項(`value = id`)。
 *   - 未來若要在 UI 顯示目前 model 的友善名稱,可用 `id` 反查 `label`。
 */
export interface KnownClaudeModel {
  /** 完整 model ID,直接對應 SDK `Options.model`/`Query.setModel()` 接受的字串。 */
  id: string;
  /** UI 顯示用的友善名稱。 */
  label: string;
}

export const KNOWN_CLAUDE_MODELS: KnownClaudeModel[] = [
  { id: "claude-opus-4-8", label: "Claude Opus 4.8" },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
  { id: "claude-fable-5", label: "Claude Fable 5" },
  { id: "claude-opus-4-7", label: "Claude Opus 4.7(舊版)" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6(舊版)" },
];

/**
 * S3b(CostGovernor)§3.2「雙軌」的 token→$ 換算表:
 * docs/LAYER-4-detail-design/cost-governor_detail.md §7 檢查清單「price
 * table:僅在後端只給 token 時才需要」。
 *
 * **刻意留空,不內建任何定價**(見 packages/shared/src/core-config.ts 的
 * `BudgetModelPricingSchema` 註解完整理由)——這輪沒有可靠管道驗證真實現行
 * 價格,寫死一份可能過時/錯誤的表,比完全沒有更危險(使用者會相信一個編出來
 * 的金額,直接違反這個 codebase「不猜價」的一貫紀律,見
 * cost-governor_detail.md §6)。使用者可透過 `config.json` 的
 * `budget.modelPricing` 自行覆寫/新增(見該檔案 `BudgetConfigSchema.modelPricing`
 * 欄位),`resolveModelPricing()` 是唯一查詢入口——查無定價時呼叫端應退回
 * `maxTokens` 上限(不猜、不估,見 HLD §3.2)。
 *
 * 現況(2026-07-28)沒有任何已接線的 adapter 會真正走到這個路徑:
 * `ClaudeAgentSdkAdapter` 有 usage 時必有 `total_cost_usd`(見
 * usage-metering_detail.md §8.2);ACP 經 Claude Code 完全不報 usage(連
 * token 都沒有,見同文件 §7)。這個表是為「未來某個只報 token、不報 $ 的
 * adapter/profile」預留的擴充點。
 */
export const KNOWN_MODEL_PRICING: Record<string, { inputPerMTokUsd: number; outputPerMTokUsd: number }> = {};

/**
 * 查詢一個 model 的定價——先看 config 覆寫(`budgetModelPricing`,使用者在
 * `config.json` 的 `budget.modelPricing` 明確設定的),查無才退回這裡的內建表
 * (目前固定是空的,見上方說明)。都查無時回傳 `undefined`,呼叫端(CostGovernor)
 * 應退回 token 上限,不猜價。
 */
export function resolveModelPricing(
  budgetModelPricing: Record<string, { inputPerMTokUsd: number; outputPerMTokUsd: number }> | undefined,
  model: string | undefined,
): { inputPerMTokUsd: number; outputPerMTokUsd: number } | undefined {
  if (!model) return undefined;
  return budgetModelPricing?.[model] ?? KNOWN_MODEL_PRICING[model];
}
