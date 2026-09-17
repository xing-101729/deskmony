import React from "react";
import { Box, Text } from "ink";
import type { SessionView, TranscriptLine } from "../model.js";
import { BORDER_STYLE, SESSION_STATUS_COLOR, SESSION_STATUS_ICON, TRANSCRIPT_LINE_COLOR } from "../theme.js";

export interface TranscriptPaneProps {
  view: SessionView | undefined;
  focused: boolean;
  width: number;
  height: number;
}

/**
 * 中間窗格:焦點 session 的串流輸出(§3 區域表格)。
 *
 * 捲動視窗**用陣列切片自己算,不依賴 ink Box 的 `overflow="hidden"` 幫忙
 * 裁切**——`overflow:hidden` 在內容超出高度時會裁掉哪一端(從上面裁還是
 * 從下面裁)不是這個元件想去賭的事(flexbox column 正常流向是由上而下,
 * 超出的部分直覺上會被裁在下面,但那正好跟我們想要的「貼齊底部、看最新
 * 內容」相反)。改成在算出 `visibleLines` 陣列時就只放剛好塞得下的那幾行,
 * ink 拿到的 children 數量本來就不多於可視高度。
 */
export function TranscriptPane({ view, focused, width, height }: TranscriptPaneProps): React.JSX.Element {
  const innerWidth = Math.max(1, width - 2); // 減掉左右各 1 欄的框線。
  const headerHeight = 2; // 標題行 + 分隔線各一行。
  const contentHeight = Math.max(0, height - 2 /* 上下框線 */ - headerHeight);

  if (!view) {
    return (
      <Box width={width} height={height} flexDirection="column" borderStyle={BORDER_STYLE} borderColor={focused ? "cyan" : undefined}>
        <Box paddingX={1}>
          <Text bold>TRANSCRIPT</Text>
        </Box>
        <Box paddingX={1}>
          <Text dimColor>尚無 session 可顯示——等其他 client 建立 session,或用「deskmony run」/「deskmony chat」建一個。</Text>
        </Box>
      </Box>
    );
  }

  const { session } = view;
  const statusIcon = SESSION_STATUS_ICON[session.status];
  const statusColor = SESSION_STATUS_COLOR[session.status];

  // HLD §8「刻意不做的」:PTY session 的原始 ANSI 不在這裡渲染(等於要內嵌
  // 一個終端機模擬器),顯示替代訊息即可。
  const isPty = session.adapterType === "pty";

  const allLines: TranscriptLine[] = isPty
    ? []
    : view.pendingAssistant
      ? [...view.lines, { kind: "agent", text: view.pendingAssistant.text }]
      : view.lines;

  const end = Math.max(0, allLines.length - view.scrollOffset);
  const start = Math.max(0, end - contentHeight);
  const visibleLines = allLines.slice(start, end);

  return (
    <Box width={width} height={height} flexDirection="column" borderStyle={BORDER_STYLE} borderColor={focused ? "cyan" : undefined}>
      <Box paddingX={1} flexDirection="row">
        <Text bold wrap="truncate-end">
          {session.title}
        </Text>
        <Text> · {session.adapterType} · </Text>
        <Text color={statusColor}>
          {statusIcon} {session.status}
        </Text>
        {view.scrollOffset > 0 && <Text dimColor> · 已往回捲動({view.scrollOffset})</Text>}
      </Box>
      <Box paddingX={1}>
        <Text dimColor>{"─".repeat(innerWidth)}</Text>
      </Box>
      <Box flexDirection="column" paddingX={1} height={contentHeight} overflow="hidden">
        {isPty ? (
          <Text dimColor>這是 PTY session,請用「deskmony chat --session {session.id}」或桌面 app 檢視。</Text>
        ) : visibleLines.length === 0 ? (
          <Text dimColor>(尚無輸出)</Text>
        ) : (
          visibleLines.map((line, i) => (
            <Text key={`${start + i}`} color={TRANSCRIPT_LINE_COLOR[line.kind]} wrap="truncate-end">
              {line.text}
            </Text>
          ))
        )}
      </Box>
    </Box>
  );
}
