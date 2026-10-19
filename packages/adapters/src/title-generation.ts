import { DeskmonyError } from "@deskmony/shared";

/**
 * 2026-10-06(AI 自動命名):各 adapter 的 `generateTitle()` 共用的小工具(介面紀律見 types.ts 的
 * `AgentAdapter.generateTitle()`)。
 */

/**
 * 能自訂系統提示的後端(claude-agent-sdk)給臨時命名對話用的系統提示——取代預設那份充滿工具使用說明的提示。
 * 其餘後端(opencode、ACP)沒有每個 session 自訂系統提示的管道,只靠 core 組的命名指示本身(`buildTitleRequestPrompt()`)。
 */
export const TITLE_SYSTEM_PROMPT =
  "You only write short titles for conversations. You have no tools. Reply with the title text only, in the same language as the user's message.";

/** `request.signal` 觸發(逾時、session 被刪)時丟的錯誤。 */
export function titleAbortedError(): DeskmonyError {
  return new DeskmonyError("title.aborted", undefined, "命名用的臨時對話已中止(逾時或 session 已關閉)");
}

/** 臨時對話嘗試呼叫工具時丟的錯誤——命名請求不該需要任何工具,一出現就中止、退回截取首句。 */
export function titleToolUseError(software: string): DeskmonyError {
  return new DeskmonyError("title.toolUseAttempted", { software }, "命名用的臨時對話嘗試呼叫工具,已中止");
}

/** 臨時對話以錯誤收場(拒答、後端錯誤、沒有回覆)。 */
export function titleAgentFailedError(software: string, detail: string): DeskmonyError {
  return new DeskmonyError("title.agentFailed", { software, detail }, `命名用的臨時對話失敗: ${detail}`);
}

/** 等 `promise`,但 `signal` 觸發就立刻丟 `titleAbortedError()`(不等 promise 自己結束——清理交給呼叫端的 finally)。 */
export function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(titleAbortedError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(titleAbortedError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}
