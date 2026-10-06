/**
 * scripts/lib/fake-title-modes.mjs
 *
 * 2026-10-06(session 自動命名):scripts/fake-acp-agent.mjs、scripts/fake-opencode-server.mjs 與
 * scripts/e2e-session-title.mjs 共用的測試約定——假後端收到 core 的**命名請求**(`parseTitleRequestPrompt()` 認得)時,
 * 依引用的「使用者第一則訊息」裡的標記決定行為:
 *
 *   - 沒有標記:回 `**Title:** 「<fakeTitleFor(訊息)>」` + 一行多餘說明——core 清理(拿掉 markdown、「Title:」前綴、
 *     引號、第二行)之後,標題應該剛好是 `fakeTitleFor(訊息)`。
 *   - `TITLE_MODE_TOOL`:嘗試用工具(要權限);**被允許**才在工作目錄寫 `TITLE_TOOL_MARKER_FILE`。
 *   - `TITLE_MODE_HANG`:一直不回,直到被取消/中止(驗證 core 的逾時退回截取首句)。
 *   - `TITLE_MODE_REFUSE`:以失敗收場(ACP:`stopReason: "refusal"`;OpenCode:`session.error`)。
 *
 * 標記是測試腳本逐字組出來的,不是自然語言,不會誤觸。
 */

export const TITLE_MODE_TOOL = "[[E2E_TITLE:tool]]";
export const TITLE_MODE_HANG = "[[E2E_TITLE:hang]]";
export const TITLE_MODE_REFUSE = "[[E2E_TITLE:refuse]]";
const TITLE_MODE_PATTERN = /\[\[E2E_TITLE:[a-z]+\]\]/g;

/** TITLE_MODE_TOOL 的工具**被允許**時才會寫的檔案(相對於後端行程的工作目錄 = session 的工作目錄)。 */
export const TITLE_TOOL_MARKER_FILE = "title-tool-ran.txt";

/** 沒有標記時假後端取的標題(core 清理後應該剛好是這個字串)。 */
export function fakeTitleFor(firstMessage) {
  return `假標題-${Array.from(firstMessage.replace(TITLE_MODE_PATTERN, "").trim()).slice(0, 6).join("")}`;
}

/** 假後端回的原始文字(含 core 要清掉的 markdown、前綴、引號與第二行)。 */
export function fakeTitleReplyFor(firstMessage) {
  return `**Title:** 「${fakeTitleFor(firstMessage)}」\n(這一行是多餘的說明,core 應該把它丟掉)`;
}
