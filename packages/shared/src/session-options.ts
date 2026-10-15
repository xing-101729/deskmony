import { z } from "zod";

/**
 * session-options.ts(2026-10-06 新增:各 agent 選 model 與思考程度)。
 *
 * **「這個 session 現在能選哪些 model / 思考程度」由 agent 本身回報,不寫死在 Deskmony。** 過去只有
 * claude-agent-sdk 能選(model 清單來自 provider 目錄、思考程度是寫死的 5 級),其他 agent 一律「由 agent
 * 自行管理」。實際上多數 agent 都有自己的機制,只是要向它查:
 *
 *   - **ACP**(Codex / Gemini / OpenCode ACP):`session/new`(與 load/resume)回應的 `configOptions`,
 *     以及之後的 `config_option_update` 通知。`category: "model"` 是 model、`category: "thought_level"`
 *     是思考程度;切換用 `session/set_config_option`。**option id 各家不同**(實測:opencode 1.18.7 是
 *     `model`/`effort`,codex-acp 1.4.0 是 `model`/`reasoning_effort`),所以認 `category` 不認 id。
 *   - **OpenCode(HTTP)**:`GET /config/providers` 每個 model 的 `variants`(例如 `low`/`medium`/`high`,
 *     各 model 不同,部分 model 沒有),選定的 variant 隨每則 `prompt_async` 的 `variant` 欄位送出。
 *     model 清單沿用 provider 目錄(同一個 `opencode models` 來源,而且會套用使用者的 provider 偏好)。
 *
 * adapter 一拿到(或選項有變動)就送 `session-options` 事件(見 events.ts),**REPLACE 語意**:每次都是
 * 完整的一份,消費端整份覆蓋。`model`/`effort` 省略 = 這個 session 目前不能選那一項(agent 沒宣告,或例如
 * OpenCode 目前的 model 沒有 variants)。core 把最新一份掛在 `Session.options`(只存記憶體,同
 * `permissionMode` 的待遇),UI 只顯示 agent 真的支援的選項。
 */

export const SessionOptionChoiceSchema = z.object({
  /** 送回給 agent 的值(`session.setModel`/`session.setEffort` 的參數就是這個)。 */
  value: z.string().min(1),
  /** 顯示名稱(agent 有給就用 agent 的,否則同 value)。 */
  label: z.string().min(1),
  description: z.string().optional(),
});
export type SessionOptionChoice = z.infer<typeof SessionOptionChoiceSchema>;

export const SessionOptionSchema = z.object({
  /** agent 回報的目前值;省略 = agent 沒說(例如 OpenCode 沒指定 variant 時用 model 自己的預設)。 */
  current: z.string().optional(),
  choices: z.array(SessionOptionChoiceSchema),
});
export type SessionOption = z.infer<typeof SessionOptionSchema>;

export const SessionOptionsSchema = z.object({
  model: SessionOptionSchema.optional(),
  effort: SessionOptionSchema.optional(),
});
export type SessionOptions = z.infer<typeof SessionOptionsSchema>;

/**
 * 思考程度的值:各 agent 自己定義(Claude 是 `low`…`max`,codex/opencode 有 `none`/`minimal`,Gemini 有
 * `minimal`/`high`……),所以只限制成非空、長度合理的字串;合不合法由 adapter 依 agent 回報的清單判斷
 * (Claude SDK 仍只接受 `EffortLevelSchema` 的 5 級,見 agent-launch.ts)。
 */
export const EffortValueSchema = z.string().min(1).max(64);

/** 兩個 session-options 是否相同(core 用來避免重複寫 DB/廣播)。 */
export function sameSessionOptions(a: SessionOptions | undefined, b: SessionOptions | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}
