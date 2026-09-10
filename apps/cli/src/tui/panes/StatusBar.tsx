import React from "react";
import { Box, Text } from "ink";
import type { CostSnapshot } from "../model.js";
import { BORDER_STYLE } from "../theme.js";

export interface StatusBarProps {
  cost: CostSnapshot;
  width: number;
  /** `model.ctrlCArmedUntil`——第一次 Ctrl+C 之後的兩秒確認視窗(§6.3)。
   *  傳進來讓這個元件自己判斷「現在是不是還在視窗內」,而不是要求
   *  model.ts 額外算出一個 boolean(那個時間比對本身就是「現在幾點」這種
   *  只有渲染當下才有意義的東西,不適合放進 model 的資料裡)。 */
  ctrlCArmedUntil: number;
}

function formatUsd(amount: number | undefined): string {
  return amount === undefined ? "—" : `$${amount.toFixed(2)}`;
}

/**
 * §3 底部狀態列:「今日花費/上限、斷路器狀態、按鍵提示」。
 *
 * 只反映**成本**斷路器(`cost.getSummary` 的 `dailyTripped`,見 model.ts
 * 的 `CostSnapshot`)——`docs/DECISIONS.md` 的無人值守安全罩其實有三道
 * 斷路器(成本/訊息數/hard-deny 觸發的 enforcement),這裡只呈現跟同一行
 * 顯示的美金數字直接相關的那一道,不是把三道斷路器的狀態硬塞進一行文字。
 * 這是刻意的範圍縮小,不是漏掉——T1 是骨架,合併呈現三道斷路器需要更多
 * 版面/RPC 才做得誠實,留給之後真的要用到的時候再做。
 *
 * 按鍵提示**只列 T1 真的有接的鍵**——`Tab`/方向鍵/`q` 這輪都能用;
 * `[/]`(指令)、傳訊息用的輸入框、`[?]`(說明彈窗)這幾個 design 文件 §3
 * 示意圖畫出來的提示,T1 都還沒有對應功能(T1 的核心論點是「同時盯著多個
 * agent」的**唯讀監看**,見 cli-tui_hld.md §2:「如果 TUI 只是把 REPL 畫進
 * 框線裡,它不值得做」——送出訊息不是這輪的骨架要解決的問題),提示一個
 * 按下去沒反應的鍵沒有意義。
 *
 * 第一次 Ctrl+C 按下去之後,「兩秒內再按一次可離開」的提示會取代按鍵提示
 * 那一段——`apps/cli/src/commands/chat.ts` 的 REPL 對同一個情境會印一行
 * 訊息,這裡沒有對應的訊息機制,原本第一次按下去完全沒有任何看得見的
 * 反應(對「焦點 session 目前不是 busy」的情況尤其容易讓人以為按鍵沒有
 * 生效),補上這個提示是刻意的一致性修正,不是 HLD 逐字要求的項目。
 */
export function StatusBar({ cost, width, ctrlCArmedUntil }: StatusBarProps): React.JSX.Element {
  const breakerLabel = cost.dailyTripped ? "已跳(今日已停止送出新對話)" : "正常";
  const ctrlCArmed = Date.now() < ctrlCArmedUntil;
  return (
    <Box width={width} paddingX={1} flexDirection="row" justifyContent="space-between" borderStyle={BORDER_STYLE}>
      <Text color={cost.dailyTripped ? "red" : undefined}>
        今日 {formatUsd(cost.todayCostUsd)} / {formatUsd(cost.dailyCapUsd)} · 斷路器{breakerLabel}
      </Text>
      {ctrlCArmed ? (
        <Text color="yellow">兩秒內再按一次 Ctrl+C 可離開</Text>
      ) : (
        <Text dimColor>[Tab] 切換窗格 [↑↓] 選取/捲動 [q] 離開</Text>
      )}
    </Box>
  );
}
