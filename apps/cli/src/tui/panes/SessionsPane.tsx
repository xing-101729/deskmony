import React from "react";
import { Box, Text } from "ink";
import type { SessionView } from "../model.js";
import { BORDER_STYLE, SESSION_STATUS_COLOR, SESSION_STATUS_ICON, spinnerFrame } from "../theme.js";

export interface SessionsPaneProps {
  sessions: SessionView[];
  selectedSessionId: string | undefined;
  /** 是不是目前的窗格焦點(§6.1 兩層焦點模型的第一層)——只影響邊框顏色與
   *  選取列要不要反白,不影響資料內容。 */
  focused: boolean;
  /** §3.1 80–99 欄:縮到 16 欄,只顯示圖示 + 截斷標題(不顯示狀態文字)。 */
  compact: boolean;
  width: number;
  height: number;
}

/**
 * 左側窗格:全部 session、狀態圖示、標題(§3 區域表格)。
 *
 * 標題與狀態文字之間的對齊**刻意用 `<Box flexGrow>` 做,不用字串
 * `padEnd()`**——HLD §1.2 已經實測 ink/yoga 對中文全形寬度算得正確
 * (量到「左窗格」+ 12 個空白 = 18 欄的結果),但那是 ink 自己排版引擎的
 * 能力,`String.prototype.padEnd()` 只看 UTF-16 code unit 數、不知道
 * 中文佔 2 欄,對含有中文標題的 session(例如預設標題「新對話」)會對不齊。
 * 用 flexbox 讓 ink 自己決定怎麼填空白,而不是自己用字串手算。
 */
export function SessionsPane({ sessions, selectedSessionId, focused, compact, width, height }: SessionsPaneProps): React.JSX.Element {
  return (
    <Box width={width} height={height} flexDirection="column" borderStyle={BORDER_STYLE} borderColor={focused ? "cyan" : undefined}>
      <Box paddingX={1}>
        <Text bold>SESSIONS ({sessions.length})</Text>
      </Box>
      <Box flexDirection="column" paddingX={1} flexGrow={1} overflow="hidden">
        {sessions.length === 0 && <Text dimColor>(尚無 session)</Text>}
        {sessions.map((view) => {
          const isSelected = view.session.id === selectedSessionId;
          // T3(§7.3):busy 的那一列用 spinner 幀取代靜態的 `●`,讓背景
          // session 看起來「還在動」。這是 §7.3 能夠成立的前提——非焦點
          // session 的 delta 不再觸發重繪之後,若這裡也是靜態圖示,一個跑
          // 了三小時的背景 agent 與一個當掉的背景 agent 在畫面上完全一樣。
          // spinner 幀由 `spinnerFrame()` 依時間推算(見 theme.ts),所以
          // 這裡不需要任何 per-session 的動畫狀態。
          const icon =
            view.session.status === "busy" ? spinnerFrame(Date.now()) : SESSION_STATUS_ICON[view.session.status];
          const iconColor = SESSION_STATUS_COLOR[view.session.status];
          return (
            <Box key={view.session.id} flexDirection="row">
              <Text inverse={isSelected && focused}>{isSelected ? "▸" : " "}</Text>
              <Text color={iconColor}> {icon} </Text>
              <Box flexGrow={1} overflow="hidden">
                <Text wrap="truncate-end" inverse={isSelected && focused}>
                  {compact ? "" : view.session.title}
                </Text>
              </Box>
              {!compact && (
                <Text dimColor={!isSelected} color={iconColor}>
                  {" "}
                  {view.session.status}
                </Text>
              )}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

export interface SessionsSummaryLineProps {
  sessions: SessionView[];
  expanded: boolean;
}

/**
 * §3.1 60–79 欄(collapsed):「Sessions 窗格收合成一列『3 sessions ·
 * [s] 展開』」。`[s]` 真的有作用(見 tui/app.tsx 對 `char === "s"` 的處理,
 * 切換 `model.collapsedSessionsExpanded`)——展開時 app.tsx 改用完整寬度的
 * `SessionsPane` 暫時取代 Transcript 窗格(這個寬度容不下兩欄並排),不是
 * 這個元件自己畫展開後的內容。
 */
export function SessionsSummaryLine({ sessions, expanded }: SessionsSummaryLineProps): React.JSX.Element {
  const busyCount = sessions.filter((v) => v.session.status === "busy").length;
  const waitingCount = sessions.filter((v) => v.session.status === "waiting").length;
  return (
    <Box paddingX={1} borderStyle={BORDER_STYLE}>
      <Text>
        {sessions.length} 個 session
        {busyCount > 0 ? `(${busyCount} 個運作中)` : ""}
        {waitingCount > 0 ? ` ⚠ ${waitingCount} 個等待中` : ""} · [s] {expanded ? "收合" : "展開"}
      </Text>
    </Box>
  );
}
