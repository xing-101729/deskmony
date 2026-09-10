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
 * 這個元件本身只負責顯示「有幾筆、是哪幾個 session」——這兩件事已經是
 * T1 的完整範圍(design 文件對 T1 的要求:「alert bar 應該已經顯示計數」)。
 * **刻意不畫 `[a] 逐一處理` 的按鍵提示**:那個鍵目前是 no-op(見
 * tui/app.tsx 對 `char === "a"` 的處理,T2 才會真的實作彈窗),提示一個
 * 按下去沒反應的鍵比什麼都不提示更容易誤導使用者。呼叫端(app.tsx)只有
 * 在 `pendingPermissions.length > 0` 時才會渲染這個元件,這裡不必自己判斷
 * 要不要隱藏。
 */
export function AlertBar({ pendingPermissions, sessionTitle, width }: AlertBarProps): React.JSX.Element {
  const names = [...new Set(pendingPermissions.map((p) => sessionTitle(p.sessionId)))];
  return (
    <Box width={width} paddingX={1} borderStyle={BORDER_STYLE} borderColor="yellow" flexDirection="row">
      <Text color="yellow">
        ⚠ {pendingPermissions.length} 個待決權限請求({names.join("、")})
      </Text>
    </Box>
  );
}
