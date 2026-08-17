import { z } from "zod";
import { PolicyRuleSchema } from "./core-config.js";

/**
 * AgentEvent:AgentAdapter.events() 串流出的統一事件型別。
 * 對應 ARCHITECTURE.md 4.3 節:
 *   AgentEvent = 訊息增量 | 工具呼叫 | 權限請求 | 完成 | 錯誤
 *
 * 使用 zod discriminated union,`type` 為判別欄位。
 */

/** 訊息增量(assistant 串流輸出的文字片段) */
export const MessageDeltaEventSchema = z.object({
  type: z.literal("message-delta"),
  messageId: z.string(),
  role: z.enum(["assistant"]),
  delta: z.string(),
  /** 這段 delta 是否為該訊息的最後一段 */
  done: z.boolean().default(false),
});
export type MessageDeltaEvent = z.infer<typeof MessageDeltaEventSchema>;

/** 工具呼叫開始 */
export const ToolCallEventSchema = z.object({
  type: z.literal("tool-call"),
  toolCallId: z.string(),
  toolName: z.string(),
  input: z.unknown().optional(),
});
export type ToolCallEvent = z.infer<typeof ToolCallEventSchema>;

/** 工具呼叫結果(對應同一個 toolCallId) */
export const ToolResultEventSchema = z.object({
  type: z.literal("tool-result"),
  toolCallId: z.string(),
  toolName: z.string(),
  output: z.unknown().optional(),
  isError: z.boolean().default(false),
  /**
   * async-scribbling-llama.md Phase 4:claude-agent-sdk 的 `SDKUserMessage.
   * tool_use_result`(每個工具各自的完整結構化 Output 物件,例如
   * `FileEditOutput`/`FileWriteOutput` 的 `structuredPatch`)。刻意取通用名稱
   * 而非 `diffResult`——同一條管線之後 Phase 7(AskUserQuestion 的
   * `answers`)也會沿用,不是 diff 專用欄位。只有 claude-agent-sdk adapter 會
   * 填這個欄位(且只在能確定歸屬時才填,見該 adapter 的 `case "user":`
   * 註解),其餘 adapter 一律留 undefined,消費端(UI)須自行 fallback。
   */
  structuredResult: z.unknown().optional(),
});
export type ToolResultEvent = z.infer<typeof ToolResultEventSchema>;

/** 權限請求(由 adapter 的 canUseTool callback 轉發而來) */
export const PermissionRequestEventSchema = z.object({
  type: z.literal("permission-request"),
  requestId: z.string(),
  toolName: z.string(),
  input: z.unknown().optional(),
  /** 供 UI 顯示的簡述,例如即將執行的指令或修改的檔案 */
  description: z.string().optional(),
  /**
   * S7(auto-mode-and-yolo)L4 §1.2:S1 的 `decide()` 在「本機 + attended +
   * 未開 autoMode」時,把 hard-deny 命中降級為 escalate-strong(見
   * apps/core/src/permissions/policy-engine.ts)——這種請求在 UI 必須用明顯
   * 不同的樣式呈現(紅框警示、二次確認),且**不得**提供「永遠允許」
   * (C4 紀律③)。`false`(一般 escalate,default-deny 的未分類長尾)是絕大多數
   * 情況,故是選填欄位——**刻意用 `.optional()` 而非 `.default(false)`**:
   * 三個 adapter(claude-agent-sdk/acp/opencode)組裝 `PermissionRequestEvent`
   * 物件字面量的地方(packages/adapters/src/*-adapter.ts)完全不知道、也不該
   * 知道 escalate-strong 這件事(那是 PolicyEngine 決策後才算得出來的,見
   * apps/core/src/session/session-manager.ts),若這裡用 `.default()`,z.infer
   * 出來的 TS 型別會要求這些呼叫點都必須提供 `strong` 欄位,徒增不相干模組的
   * 耦合。消費端(UI/SessionManager)一律把 `undefined` 視為 `false`
   * (一般 escalate),語意與 `.default(false)` 完全等價,只是型別層面選填。
   */
  strong: z.boolean().optional(),
});
export type PermissionRequestEvent = z.infer<typeof PermissionRequestEventSchema>;

/**
 * async-scribbling-llama.md Phase 7:`AskUserQuestion` 的待答問題——由
 * claude-sdk-adapter.ts 的 `canUseTool` 特例攔截後轉發,**不是**
 * `permission-request` 的變體(這不是一個允許/拒絕的權限決策,見
 * docs/DECISIONS.md §C 的政策引擎範圍——政策引擎管的是「要不要放行一個工具
 * 呼叫」,AskUserQuestion 本身的執行從未被擋下,只是它需要使用者提供答案才能
 * 完成)。`questions` 直接透傳 SDK 的 `AskUserQuestionInput.questions`(未經
 * 加工的 `unknown`——桌面端不 import `@anthropic-ai/claude-agent-sdk` 型別,
 * 由 UI 端自行防禦性驗證,同 Phase 3/4 的 `parseTodoWriteInput()`/
 * `parseDiffResult()` 既有慣例)。`toolUseID` 對應既有 `tool-call` 事件的
 * `toolCallId`(SDK 保證同一個工具呼叫兩邊用同一個 id),UI 靠它把這筆待答
 * 請求與已經在對話串裡顯示的工具呼叫項目對上;`requestId` 是
 * `canUseTool`/`resolveUserDialog()` 用來配對的 control-protocol id,兩者用途
 * 不同,刻意都保留(不能只留一個)。
 */
export const UserDialogRequestEventSchema = z.object({
  type: z.literal("user-dialog-request"),
  requestId: z.string(),
  toolUseID: z.string(),
  questions: z.unknown(),
});
export type UserDialogRequestEvent = z.infer<typeof UserDialogRequestEventSchema>;

/** 單輪對話完成 */
export const CompletedEventSchema = z.object({
  type: z.literal("completed"),
  messageId: z.string().optional(),
  /** 完整的最終文字內容(方便持久化) */
  finalText: z.string().optional(),
  durationMs: z.number().optional(),
});
export type CompletedEvent = z.infer<typeof CompletedEventSchema>;

/** 錯誤 */
export const ErrorEventSchema = z.object({
  type: z.literal("error"),
  message: z.string(),
  detail: z.string().optional(),
});
export type ErrorEvent = z.infer<typeof ErrorEventSchema>;

/**
 * pty 終端原始輸出片段(M2 Round B,GenericPtyAdapter 專用)。
 *
 * 編碼選擇:UTF-8 字串,不用 base64。理由 ——
 *   1. `node-pty` 的 `onData(callback: (data: string) => void)` 本身就是把
 *      底層 conpty(Windows)/pty(POSIX)的位元組流依系統編碼解碼成 JS
 *      字串後才回呼給我們,我們拿到的本來就已經是字串,不是 Buffer;
 *      ANSI escape sequence(游標移動、顏色碼等)也都是合法的 ASCII/UTF-8
 *      文字,不含會讓 JSON 字串化失敗的位元組。
 *   2. 消費端(`xterm.js` 的 `Terminal.write()`)本身吃的就是字串或
 *      Uint8Array,不需要先 base64 decode。
 *   3. base64 會讓 payload 平白增加約 33% 大小,且多一層編解碼成本;對於
 *      互動式終端這種高頻小片段輸出(每個按鍵回顯都是一個事件)是不必要的
 *      開銷。若未來要支援真正的任意二進位輸出(例如 pty 裡跑會輸出非文字
 *      控制碼的程式),再視情況改用 base64 或另開一個 binary 事件型別。
 */
export const TerminalDataEventSchema = z.object({
  type: z.literal("terminal-data"),
  data: z.string(),
});
export type TerminalDataEvent = z.infer<typeof TerminalDataEventSchema>;

/**
 * S3a(usage-metering):累計花費(cumulative,同一條 adapter 連線內單調遞增)。
 * 對應 [S3a L4](../../docs/LAYER-4-detail-design/usage-metering_detail.md) §1
 * ——查證 `@agentclientprotocol/sdk@1.2.1` 的 `UsageUpdate` 型別後發現 ACP 給的
 * `used`/`size` 是 context 窗口計量表(gauge,見下方 `ContextUsageEventSchema`),
 * 不是成本訊號;真正能拿來算花費的是天生就是累計值的 `cost.amount`。
 *
 * **刻意拆成兩個獨立事件、不合併成一個型別**:這個是「累計計數器」(可 diff、
 * 單調遞增),下面的 `context-usage` 是「瞬時計量表」(compaction 後會變小)。
 * 塞進同一個事件會讓消費端「新值 < 舊值 = 連線重置」這條規則對 gauge 誤判成
 * 重置,語意不同就不共用型別(見 L4 §1 完整說明)。
 */
export const UsageEventSchema = z.object({
  type: z.literal("usage"),
  /** 累計花費金額;來源未提供(尚未回報過 cost,或這個後端從未回報)則 undefined,不編造成 0。 */
  costAmount: z.number().optional(),
  /** ISO 4217,如 "USD"。有 costAmount 時應同時有。 */
  costCurrency: z.string().optional(),
  /** 累計 token(來源有給才填;ACP 目前不給,保留欄位供 Claude SDK / OpenCode 之後接上)。 */
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  cacheReadTokens: z.number().optional(),
  cacheCreationTokens: z.number().optional(),
  /** 此用量對應的 model(session 中途 setModel 換過時用來消歧)。 */
  model: z.string().optional(),
});
export type UsageEvent = z.infer<typeof UsageEventSchema>;

/**
 * S3a(usage-metering):context 窗口使用率(gauge,非累計——compaction 後會
 * 變小,見上方 `UsageEventSchema` 註解的完整理由)。ACP 保證一定會給
 * `used`/`size`(不像 `cost` 是 optional),是這個切片唯一保證看得到的用量訊號
 * (見 L4 §3):即使拿不到 $,也至少能看到「這個 session 的 context 用了幾成」。
 */
export const ContextUsageEventSchema = z.object({
  type: z.literal("context-usage"),
  /** 目前 context 內 token 數。 */
  used: z.number(),
  /** context 窗口總大小。 */
  size: z.number(),
});
export type ContextUsageEvent = z.infer<typeof ContextUsageEventSchema>;

export const AgentEventSchema = z.discriminatedUnion("type", [
  MessageDeltaEventSchema,
  ToolCallEventSchema,
  ToolResultEventSchema,
  PermissionRequestEventSchema,
  UserDialogRequestEventSchema,
  CompletedEventSchema,
  ErrorEventSchema,
  TerminalDataEventSchema,
  UsageEventSchema,
  ContextUsageEventSchema,
]);
export type AgentEvent = z.infer<typeof AgentEventSchema>;

/** 由 SessionManager 附加 sessionId 後,推播給 Gateway 使用的信封。 */
export const SessionEventEnvelopeSchema = z.object({
  sessionId: z.string(),
  event: AgentEventSchema,
  timestamp: z.number(),
});
export type SessionEventEnvelope = z.infer<typeof SessionEventEnvelopeSchema>;

/**
 * 給 UI 的權限回覆(允許/拒絕,可選擇把這次決定寫成一條永久規則)。
 *
 * S7(auto-mode-and-yolo)L4 §1.3:**取代**舊版 `remember: z.boolean()`——布林
 * 值只能表達「要不要記住」,表達不了「記多窄」,HLD §4 定案是使用者在 UI
 * 上明確選定範圍(見 PermissionModal.tsx 的「永遠允許…」展開區塊,預設選最窄
 * 的 `commandEquals`/`pathUnder`)。`undefined` = 只此一次,不寫入任何規則
 * (與舊版 `remember` 未提供/false 語意相同)。
 *
 * **Core 端強制檢查(不可省,C4 紀律③)**:若這個 `requestId` 當初是
 * escalate-strong(見 `PermissionRequestEvent.strong`),Core 一律拒絕連同
 * `rememberRule` 一起套用(即使 UI 有 bug 或惡意 client 硬塞這個欄位)——見
 * apps/core/src/session/session-manager.ts 的 `resolvePermission()`。
 */
export const PermissionDecisionSchema = z.object({
  requestId: z.string(),
  decision: z.enum(["allow", "deny"]),
  rememberRule: PolicyRuleSchema.optional(),
});
export type PermissionDecision = z.infer<typeof PermissionDecisionSchema>;

/**
 * async-scribbling-llama.md Phase 7:給 UI 的 `user-dialog-request` 回覆。刻意
 * 取通用名稱(不叫 `AskUserQuestionAnswer`)——但這是 Deskmony 自訂的「待答 UI
 * 事件」概念,**不是**在透傳 SDK 官方的某個 dialog result 型別(那條路徑
 * `onUserDialog`/`supportedDialogKinds` 在這個 SDK 版本確認不會觸發,見
 * claude-sdk-adapter.ts 的 `canUseTool` 內對應段落的機制說明,沒有對應的官方
 * 型別可透傳)。
 *
 * `"completed"`:使用者實際選了答案(question text -> 選項 label,多選以逗號
 * 串接,對齊 SDK `AskUserQuestionOutput.answers` 的既有語意)。
 * `"cancelled"`:使用者略過作答,沒有 `result`——`resolveUserDialog()` 對這
 * 兩種 behavior 最終都會讓 SDK 收到空 `answers` 物件(比照 SDK 自己 idle 逾時
 * 未答的語意),差別只在於「是使用者主動略過」還是「送出了具體答案」,兩者都
 * **不是** `deny`(deny 是權限決策的語彙,這裡完全不適用,見上方
 * `UserDialogRequestEventSchema` 的註解)。
 */
export const DialogAnswerSchema = z.discriminatedUnion("behavior", [
  z.object({ behavior: z.literal("completed"), result: z.object({ answers: z.record(z.string(), z.string()) }) }),
  z.object({ behavior: z.literal("cancelled") }),
]);
export type DialogAnswer = z.infer<typeof DialogAnswerSchema>;
