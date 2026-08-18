import { z } from "zod";

/**
 * AdapterCapabilities:每個 `AgentAdapter`(packages/adapters)回報的能力集合。
 * 對應 ARCHITECTURE.md 3.4 節「能力探測(capabilities)+ 優雅降級」—— UI 依此
 * 決定要渲染豐富聊天串流視圖,還是原始終端視圖(GenericPtyAdapter)。
 *
 * M2 Round A 時這只是 `packages/adapters/src/types.ts` 內部的一個 TS
 * interface,不需要跨行程序傳遞。M2 Round B 新增「gateway 查詢 software →
 * capabilities」的需求(desktop UI 要在建立 session 前,或拿到 session 之後,
 * 知道該用哪種視圖渲染),capabilities 因此需要能被序列化成 JSON 經 WS
 * Gateway 傳給 renderer —— 所以搬來 `packages/shared`,用 zod schema 當
 * single source of truth:`packages/adapters/src/types.ts` 的
 * `AdapterCapabilities` 型別改成直接 re-export 這裡的型別,兩邊不會漂移。
 */
/**
 * S3a(usage-metering)§7.5 ④ 的修正:**三態能力**,取代原本的 `z.boolean()`。
 *
 * 為什麼布林值不夠:`capabilities()` 是 **adapter 層級(靜態、per-software)**
 * 的宣告,但「這條連線到底會不會回報用量」是 **被 spawn 的那個 agent 決定的
 * (per-profile)**。已實測(見 L4 §7):同一個 `AcpAdapter`,Gemini CLI 這類
 * agent 可能照送 `usage_update`,而 Claude Code 經 `@zed-industries/
 * claude-code-acp` bridge **結構上一次都不送**。兩個 profile 行為相反,靜態
 * 布林值表達不了——回報 `true` 就是對 UI 說謊(UI 顯示「有花費可看」然後
 * 永遠空著),回報 `false` 又會讓真的會報的 agent 永遠顯示不出來。
 *
 *   - `"supported"`:這個 adapter **自己**保證會發出對應事件(轉發邏輯就寫在
 *     adapter 裡,不依賴外部 agent 的善意)。例:`ClaudeAgentSdkAdapter` 直接
 *     從 `SDKResultMessage.total_cost_usd` 取值。
 *   - `"unsupported"`:結構上不可能,或這輪確實沒接轉發邏輯(維持既有 `diff`
 *     欄位「沒接上就不報 true」的保守慣例)。
 *   - `"unknown"`:**要等連線後才知道**——adapter 有處理邏輯,但資料來不來
 *     由外部 agent 決定。消費端必須靠「這條 session 實際上有沒有收到過該事件」
 *     來收斂(見下方 `resolveCapabilitySupport()`),**在收斂之前不得對使用者
 *     宣稱有東西可看**。
 */
export const CapabilitySupportSchema = z.enum(["supported", "unsupported", "unknown"]);
export type CapabilitySupport = z.infer<typeof CapabilitySupportSchema>;

/**
 * 把「靜態宣告」與「這條 session 實際觀察到的事實」收斂成一個可直接拿來決定
 * UI 顯示與否的值。
 *
 * `observed`(這條 session 至少收到過一次對應事件)是**壓倒性的證據**:事件
 * 都收到了,不管當初宣告什麼,實際就是會報 ⇒ `"supported"`。反過來沒觀察到
 * 時**不會**把 `"unknown"` 降級成 `"unsupported"`——「還沒收到」與「不會收到」
 * 是兩件事,前者只是還不知道(可能只是這輪還沒跑完),硬判成 `"unsupported"`
 * 同樣是編造。UI 對這兩者的處理恰好一致(都不顯示用量區塊),但語意必須分開,
 * S3b 做權威 rollup 時會需要區分。
 *
 * 注意這個收斂是 **per-session** 的:呼叫端要傳入「這條 session」的觀察結果,
 * 不是「這個 software」的。同一個 adapter 的兩個 session 可能收斂到不同答案
 * ——這正是三態存在的理由。
 */
export function resolveCapabilitySupport(
  declared: CapabilitySupport | undefined,
  observed: boolean,
): CapabilitySupport {
  if (observed) return "supported";
  return declared ?? "unknown";
}

export const AdapterCapabilitiesSchema = z.object({
  /** 是否支援串流訊息增量 */
  streaming: z.boolean(),
  /** 是否會回報工具呼叫事件 */
  toolEvents: z.boolean(),
  /** 是否會發出權限請求事件(而非自行決定) */
  permissionRequests: z.boolean(),
  /** 是否支援回報 diff */
  diff: z.boolean(),
  /** 是否支援 interrupt() */
  interrupt: z.boolean(),
  /** 是否為終端直通型 adapter(M2 Round B 新增,見 GenericPtyAdapter) */
  terminal: z.boolean(),
  /**
   * S3a(usage-metering):是否會回報 `usage` 事件(累計花費/token,見
   * packages/shared/src/events.ts 的 `UsageEventSchema`)。
   *
   * ⚠️ **三態,不是布林值**(見上方 `CapabilitySupportSchema` 的完整理由):
   * 這輪從 `z.boolean()` 改過來,因為 `AcpAdapter` 原本無條件回報 `true`,
   * 而實測證明 Claude Code 經 ACP bridge 一次都不報——靜態布林值沒有能力
   * 表達「要看被 spawn 的是哪個 agent」。
   */
  usageReporting: CapabilitySupportSchema,
  /**
   * S3a(usage-metering):是否會回報 `context-usage` 事件(context 窗口
   * 使用率 gauge,見 `ContextUsageEventSchema`)。同樣是三態。
   */
  contextReporting: CapabilitySupportSchema,
  /**
   * 這輪(slash command)新增:是否會回報 `available-commands` 事件(見
   * `events.ts` 的 `AvailableCommandsEventSchema`)。同樣是三態,理由與
   * `usageReporting`/`contextReporting` 一致——`claude-agent-sdk` 是 vendored、
   * 版本鎖定的相依套件,`supportedCommands()` 存在與否是建置期就確定的事實,
   * 故為 `"supported"`;`acp` 要看實際 spawn 出來的是哪個 ACP agent 才知道會不
   * 會送 `available_commands_update`,故為 `"unknown"`;`opencode` 是使用者自帶、
   * 版本不受 Deskmony 控制的外部 CLI,`GET /command` 這個端點存不存在是執行期
   * 才能確認的事實,同樣為 `"unknown"`(即使本機驗證版本確實有這支端點,也不
   * 能保證使用者實際指到的版本一定有——"supported" 該保留給 adapter 自己
   * 保證做得到的情況,見上方本檔案開頭的三態定義);`pty` 是無結構化的終端
   * 直通,連「指令清單」這個概念本身都不存在,為 `"unsupported"`。
   */
  slashCommands: CapabilitySupportSchema,
});
export type AdapterCapabilities = z.infer<typeof AdapterCapabilitiesSchema>;
