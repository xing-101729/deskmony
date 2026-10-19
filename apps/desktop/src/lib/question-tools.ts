/**
 * 會被渲染成問答表單的提問工具:claude-agent-sdk 的 `AskUserQuestion`、
 * opencode 的 `question`(2026-09-17 補上——在那之前只認前者,opencode 的提問
 * 只會顯示成一個永遠「執行中」的通用工具氣泡,使用者看不到任何選項)。
 *
 * 2026-10-16:從 views/chat/AskUserQuestionWidget.tsx 搬出來(該檔仍 re-export `isQuestionToolName`,
 * 既有 import 不用改)。搬出來的原因:分組純函式 `groupChatItems()`(lib/chat-groups.ts)要用同一份判斷
 * 決定「提問工具不進摺疊群組」,而它的測試(scripts/e2e-chat-groups.mjs)是直接用 Node 載入 .ts 跑的——
 * 不能牽出 React / zustand,所以這個檔案不 import 任何東西。
 */
const QUESTION_TOOL_NAMES = new Set(["AskUserQuestion", "question"]);

export function isQuestionToolName(toolName: string): boolean {
  return QUESTION_TOOL_NAMES.has(toolName);
}
