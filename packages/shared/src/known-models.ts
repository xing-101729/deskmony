/**
 * KnownClaudeModel:一個 Claude model 的 id/label 形狀,供
 * `session.setModel` 下拉選單、`ChatView` 的「切換 model」控制項共用型別。
 *
 * 這輪起**移除**了原本寫死在這裡的 `KNOWN_CLAUDE_MODELS` 清單——那份清單
 * 會隨 Anthropic 發布新 model/棄用舊 model 而過時,顯示過時清單比完全不顯示
 * 更容易誤導使用者。實際可選的 model 清單改為即時查詢 Anthropic 官方 Models
 * API 取得(見 `apps/core/src/detect/agent-detector.ts` 的
 * `detectClaudeAgentSdk()`/`detectClaudeModelsFromApi()`),查不到就是空
 * 陣列 + 說明原因,不再有寫死的清單可以退回。
 */
export interface KnownClaudeModel {
  /** 完整 model ID,直接對應 SDK `Options.model`/`Query.setModel()` 接受的字串。 */
  id: string;
  /** UI 顯示用的友善名稱。 */
  label: string;
}

/**
 * CLAUDE_MODEL_ALIASES:claude CLI/Agent SDK 原生支援的「別名」
 * (`claude --model <alias>`,例如 `opus`/`sonnet`),不是特定日期的 model
 * 快照 ID——這是刻意跟上面「移除 KNOWN_CLAUDE_MODELS」的理由分開處理的例外:
 * 別名的語意就是「目前最新的那一版」,由 Anthropic 官方保證永遠指向現行
 * model,不會像具體 model ID 那樣過時,所以不違反這個檔案「不留可能過期清單」
 * 的原則(見上方 `KnownClaudeModel` 的檔案註解)。
 *
 * 用途:`ANTHROPIC_API_KEY` 不存在(例如只用 `claude login` 本機登入)時,
 * `apps/core/src/detect/agent-detector.ts` 的 `detectClaudeAgentSdk()` 沒辦法
 * 查 Anthropic Models API 拿到即時清單——這時候別名是唯一「不用猜、也不會
 * 過期」的退路,讓 model 選單至少有東西可選,而不是完全空白(見
 * `resolve-providers.ts`/`session-store.ts` 的 `selectEnabledClaudeModels()`
 * 如何把這份清單當作「底線」跟即時查詢結果合併)。
 *
 * 這份清單只收「已經在這台開發機上用 `claude --model <alias> -p ...`
 * 實測過、CLI 回應沒有出現『There's an issue with the selected model』錯誤」
 * 的別名——不是憑印象猜的。
 */
export const CLAUDE_MODEL_ALIASES: KnownClaudeModel[] = [
  { id: "opus", label: "Opus(別名,自動對應目前最新版)" },
  { id: "sonnet", label: "Sonnet(別名,自動對應目前最新版)" },
  { id: "haiku", label: "Haiku(別名,自動對應目前最新版)" },
  { id: "fable", label: "Fable(別名,自動對應目前最新版)" },
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
