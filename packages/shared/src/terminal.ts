import { z } from "zod";

/**
 * 右側面板的 Terminal 分頁(2026-10-20,見 docs/LAYER-4-detail-design/side-panel_detail.md §P1、docs/DECISIONS.md §L)。
 *
 * 與 `session.terminalInput`/`session.resizeTerminal`(`software="pty"` 的 session 本身就是一個終端)不同:這裡的終端是
 * **掛在某個 session 底下的獨立 shell**——cwd = 該 session 的工作資料夾,session 刪除時一併關掉,core 重啟後不保留。
 *
 * 這個檔案不 import `node:*`(與 errors.ts 同,會被 apps/desktop 的瀏覽器 bundle 引入)。
 */

/** `terminal.input` 單次 `data` 的字元上限——人手打字與貼上遠小於此,擋掉的是失控的程式一次灌進 shell 的情況。 */
export const TERMINAL_INPUT_MAX_CHARS = 65_536;

/** 每個 session 最多幾個終端、全域最多幾個(超過回 `terminal.limitReached`)。 */
export const TERMINAL_MAX_PER_SESSION = 8;
export const TERMINAL_MAX_GLOBAL = 32;

/** 每個終端環狀緩衝保留的輸出字元數(`terminal.attach` 回傳的 `buffer` 上限)。 */
export const TERMINAL_BUFFER_MAX_CHARS = 512 * 1024;

/**
 * 一個面板終端的公開資訊。
 *
 * `exitCode` 有值(含 `null`)= shell 已經結束但還留在清單裡(使用者打了 `exit`),UI 顯示「程序已結束」與重新啟動鈕;
 * `null` 代表系統沒有給結束代碼(例如被訊號終止)。`closed: true` 只出現在 `terminal-updated` push——
 * 這個終端已從清單移除(使用者關掉、或所屬 session 被刪除),client 收到就該把它丟掉。
 */
export const TerminalInfoSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  title: z.string(),
  /** shell 的顯示名稱(`pwsh`、`powershell`、`bash`……),不含路徑。 */
  shell: z.string(),
  cwd: z.string(),
  cols: z.number().int(),
  rows: z.number().int(),
  createdAt: z.number(),
  exitCode: z.number().int().nullable().optional(),
  closed: z.boolean().optional(),
});
export type TerminalInfo = z.infer<typeof TerminalInfoSchema>;

/**
 * `terminal-output` push:同一個終端約 16 ms 內的輸出合併成一筆。`seq` 每個終端各自從 1 起算、單調遞增——
 * client 先訂閱 push 再呼叫 `terminal.attach`,收到 attach 結果後丟掉 `seq <= result.seq` 的 push,
 * 就不會在 attach 與即時輸出之間重複或遺漏。
 */
export const TerminalOutputPushSchema = z.object({
  terminalId: z.string(),
  sessionId: z.string(),
  seq: z.number().int(),
  data: z.string(),
});
export type TerminalOutputPush = z.infer<typeof TerminalOutputPushSchema>;

/** `terminal-updated` push:終端建立後狀態改變(shell 結束、被關閉、尺寸改變)。 */
export const TerminalUpdatedPushSchema = z.object({ terminal: TerminalInfoSchema });
export type TerminalUpdatedPush = z.infer<typeof TerminalUpdatedPushSchema>;

export const TerminalListResultSchema = z.object({ terminals: z.array(TerminalInfoSchema) });
export const TerminalCreateResultSchema = z.object({ terminal: TerminalInfoSchema });
/** `seq` 是 `buffer` 內最後一個片段的序號(緩衝是空的就是 0)。 */
export const TerminalAttachResultSchema = z.object({
  terminal: TerminalInfoSchema,
  buffer: z.string(),
  seq: z.number().int(),
});
export type TerminalAttachResult = z.infer<typeof TerminalAttachResultSchema>;
