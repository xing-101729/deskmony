import React from "react";
import { Box, Text } from "ink";
import type { PendingPermission } from "../model.js";
import { BORDER_STYLE } from "../theme.js";

export interface AlertBarProps {
  pendingPermissions: PendingPermission[];
  sessionTitle: (sessionId: string) => string;
  width: number;
}

/**
 * §3「Alert bar(下,權限有待決才出現)」——**永遠可見,不受目前焦點影響**,
 * 這正是 §2 講的整份設計的核心價值:不論你正盯著哪個 session,別的
 * session 冒出來的權限請求都要立刻看得到。
 *
 * 這個元件本身只負責顯示「有幾筆、是哪幾個 session」,以及(T2 起)`[a]`
 * 的按鍵提示。T1 階段刻意不畫這個提示——當時 `a` 還是 no-op(見
 * tui/app.tsx 對 `char === "a"` 的處理),提示一個按下去沒反應的鍵比什麼
 * 都不提示更容易誤導使用者;T2 把 `a` 接上真正的彈窗(design §4)之後,
 * 提示才補回來,對齊 design §3 示意圖「[a] 逐一處理」的畫面。呼叫端
 * (app.tsx)只有在 `pendingPermissions.length > 0` **且彈窗未開啟**時才會
 * 渲染這個元件(彈窗開著時整段版位讓給彈窗本身,見 app.tsx 的
 * `showAlertBar` 計算),這裡不必自己判斷要不要隱藏。
 */
export function AlertBar({ pendingPermissions, sessionTitle, width }: AlertBarProps): React.JSX.Element {
  const names = [...new Set(pendingPermissions.map((p) => sessionTitle(p.sessionId)))];
  return (
    <Box width={width} paddingX={1} borderStyle={BORDER_STYLE} borderColor="yellow" flexDirection="row" justifyContent="space-between">
      <Text color="yellow">
        ⚠ {pendingPermissions.length} 個待決權限請求({names.join("、")})
      </Text>
      <Text color="yellow">[a] 逐一處理</Text>
    </Box>
  );
}
