/**
 * DeskmonyError — 貫穿 core/adapters/desktop 的結構化錯誤(i18n 專案新增)。
 *
 * 設計原則:
 *   - `message` 永遠填入目前(遷移前)的中文文字——log/console 在遷移期間、
 *     以及任何尚未轉換的 call site 或真正未預期的錯誤,都還能看懂內容。
 *   - `code` 是 dot-path 慣例(`domain.reason`,例如 "session.notFound"),
 *     由前端拿去查 `errors` namespace 翻譯,查不到時用 `message` 當
 *     defaultValue(見 apps/desktop/src/lib/error-i18n.ts)。
 *   - `params` 必須是可以直接 JSON.stringify 的值(它會被塞進 WS response
 *     的 errorParams 欄位,原樣序列化過網路),不可放 Date/class 實例等。
 *   - 這個檔案完全不 import `node:*`,可以被 apps/desktop 的瀏覽器 bundle
 *     安全引入(與同目錄 notification.ts 的既有限制一致)。
 */
export class DeskmonyError extends Error {
  readonly code: string;
  readonly params?: Record<string, unknown>;

  constructor(code: string, params: Record<string, unknown> | undefined, fallbackMessage: string) {
    super(fallbackMessage);
    this.name = "DeskmonyError";
    this.code = code;
    this.params = params;
  }
}

/**
 * 刻意只收錄「被至少 2-3 個不同檔案重複使用」的通用 code——這份清單**不求
 * 窮舉**,新的 domain 專屬 code 直接在呼叫端用字面字串(遵守 `domain.reason`
 * 慣例)即可,不必回來編輯這個檔案(平行批次共同編輯同一個檔案會製造不必要
 * 的 merge 衝突)。
 */
export const ErrorCodes = {
  ENTITY_NOT_FOUND: "entity.notFound", // params: {entityType, id}
  SESSION_NOT_RUNNING: "session.notRunning", // params: {sessionId}
  ADAPTER_UNSUPPORTED_OPERATION: "adapter.unsupportedOperation", // params: {software, operation}
  ADAPTER_UNKNOWN_HANDLE: "adapter.unknownHandle", // params: {handleId}
  ADAPTER_MISSING_CONFIG: "adapter.missingConfig", // params: {profileId, software, configField}
  TASK_INVALID_TRANSITION: "task.invalidTransition", // params: {from, to, taskId}
  AUTH_NOT_YET_AUTHENTICATED: "auth.notYetAuthenticated",
  AUTH_INVALID_TOKEN: "auth.invalidToken",
  AUTH_RATE_LIMITED: "auth.rateLimited",
  GATEWAY_LOCAL_ONLY_METHOD: "gateway.localOnlyMethod", // params: {method}
  GATEWAY_INVALID_REQUEST: "gateway.invalidRequest", // params: {detail}
  // Phase 2(ACP scoped MCP bridge token):scoped token 呼叫了不在白名單內的
  // 方法,或試圖操作不屬於自己綁定範圍(session/team)的資源,或 token 已過期。
  GATEWAY_SCOPED_TOKEN_FORBIDDEN: "gateway.scopedTokenForbidden", // params: {method, reason}
  // 2026-08-25(真.無限制層):`session.setTrueUnrestricted({enabled:true})`
  // 但該 session 目前的 permissionMode 不是 "auto-accept-all"——不能讓 client
  // 跳過 YOLO 直接開最高層級,見 docs/DECISIONS.md §G。
  SESSION_TRUE_UNRESTRICTED_REQUIRES_YOLO: "session.trueUnrestrictedRequiresYolo", // params: {sessionId}
  BUDGET_DAILY_LIMIT: "budget.dailyLimitReached",
  BUDGET_TASK_LIMIT: "budget.taskLimitReached", // params: {taskTitle}
  RECOVERY_DISCARD_CONFIRM_REQUIRED: "recovery.discardConfirmRequired",
  RECOVERY_WORKTREE_LOST: "recovery.worktreeLost", // params: {worktreePath}
  INTERNAL_UNEXPECTED: "internal.unexpected", // catch-all fallback, params: {detail}
} as const;
