import React from "react";
import { Box, Text } from "ink";
import type { PendingPermission } from "../model.js";
import { summarizeToolInputLines } from "../../render.js";
import { BORDER_STYLE, STRONG_BORDER_STYLE } from "../theme.js";

export interface PermissionModalProps {
  current: PendingPermission;
  /** 目前顯示的是佇列裡第幾筆/佇列總長度(1-based)——見 model.ts 的
   *  `getPermissionModalPosition()`。strong 請求的畫面不畫這個數字(design
   *  §4.3 的示意圖沒有「1/2」這種標示,見下方 render 邏輯的 strong 分支),
   *  但參數仍然統一由呼叫端傳入,型別上不做成 optional——這個元件只是不畫
   *  出來,不是拿不到,呼叫端(app.tsx)因此不需要為了這個 prop 另外分支。 */
  position: { index: number; total: number };
  sessionTitle: (sessionId: string) => string;
  /** design §4.3 打字輸入 `yes` 目前的緩衝——只有 `current.strong` 時會被
   *  用到。對應 model.ts 的 `permissionYesInput`,那個欄位本來就是永遠有值
   *  的字串(不是 optional),這裡跟著維持同樣的型別,呼叫端不用另外判斷
   *  要不要傳。 */
  yesInput: string;
  width: number;
  height: number;
}

/** design §4 的示意圖用 8 碼縮寫(例如「session 3ee96883」)——完整 UUID 在
 *  一行寬度有限的彈窗裡沒有必要全部印出來,8 碼已經足夠讓人與 Sessions
 *  窗格裡看到的標題對上號。 */
function shortSessionId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

/**
 * design §4.2/§4.3:逐一處理的權限彈窗。本檔案**只負責畫面**——「目前該看
 * 哪一筆」「按下某個鍵該送出什麼決定」全部是 `tui/model.ts` 的純函式算好,
 * 由 `tui/app.tsx` 的按鍵處理常式呼叫,這裡不做任何決策判斷。唯一會分支
 * 畫面的是 `current.strong`,而那本身就是 `PendingPermission` 的既有欄位
 * (由 core 的政策引擎決定,見 apps/core/src/permissions/policy-engine.ts),
 * 不是這個元件自己推導出來的狀態。
 *
 * 渲染 `input`(用 `apps/cli/src/render.ts` 的 `summarizeToolInputLines()`,
 * 與行導向 REPL 的 `prompt.ts`、桌面 `PermissionModal.tsx` 刻意同一份邏輯)
 * 而**不是** `description`——design §4.2 重申的紀律,`cli_hld.md` §13.3
 * 查證過 `description` 只有像 `"Write file"` 這種毫無資訊量的字串,只印它
 * 等於把安全罩最後一道人工關卡廢掉。
 *
 * strong 請求用圓角框線 + 紅色 + `⚠` 三者一起(見 theme.ts 的
 * `STRONG_BORDER_STYLE` 註解)——不只靠顏色,單色終端與色盲也要能分辨。
 */
export function PermissionModal({ current, position, sessionTitle, yesInput, width, height }: PermissionModalProps): React.JSX.Element {
  const strong = current.strong;
  const inputLines = summarizeToolInputLines(current.input);

  return (
    <Box width={width} height={height} flexDirection="column" justifyContent="center">
      <Box
        width={width}
        flexDirection="column"
        borderStyle={strong ? STRONG_BORDER_STYLE : BORDER_STYLE}
        borderColor={strong ? "red" : "cyan"}
        paddingX={1}
      >
        {strong ? (
          <Text bold color="red" wrap="truncate-end">
            ⚠ 高風險 ─ 這個操作命中了硬性拒絕清單
          </Text>
        ) : (
          <Text bold wrap="truncate-end">
            權限請求 {position.index}/{position.total} ─ {sessionTitle(current.sessionId)}
          </Text>
        )}
        <Text dimColor wrap="truncate-end">
          {strong ? `${sessionTitle(current.sessionId)} · ` : ""}session {shortSessionId(current.sessionId)}
        </Text>

        <Box height={1} />
        <Text wrap="truncate-end">工具 {current.toolName}</Text>
        {inputLines.map((line, i) => (
          <Text key={i} wrap="truncate-end">
            {line}
          </Text>
        ))}
        <Box height={1} />

        {strong ? (
          <Box flexDirection="column">
            <Text color="red">這類操作預設一律拒絕,且不提供「永遠允許」。</Text>
            <Text>要放行請完整輸入 yes 後按 Enter:</Text>
            <Text>
              {"> "}
              {yesInput}▏
            </Text>
            <Box height={1} />
            <Text dimColor>[Esc] 取消(維持拒絕)</Text>
          </Box>
        ) : (
          <Box flexDirection="column">
            <Text>[a] 允許一次   [d] 拒絕   [A] 永遠允許(最窄規則)</Text>
            <Text dimColor>[n] 下一筆     [Esc] 稍後再說</Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}
