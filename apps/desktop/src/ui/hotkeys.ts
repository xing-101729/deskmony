import { useEffect } from "react";

/**
 * 全域快捷鍵。
 *
 * 「鍵盤優先操作」的兩個前提:(1) 快捷鍵要**存在**,(2) 快捷鍵**不能搶走**使用者
 * 在編輯區域裡真正想要的按鍵。第二點在這個 app 特別重要,因為 TerminalView 是
 * 一個真正的 pty 終端——`Ctrl+K`(kill line)、`Ctrl+B`、`Ctrl+N` 在終端裡都有
 * 既定語意,如果 UI 無條件攔截,終端就壞了。
 *
 * 規則:
 *   - 一律使用 `mod`(macOS 的 ⌘ / 其他平台的 Ctrl)組合鍵,不綁單鍵,避免與
 *     文字輸入衝突。
 *   - 焦點位於標記了 `data-terminal-surface` 的區域內時,**Ctrl 系組合鍵讓給
 *     終端**(macOS 的 ⌘ 系不會與終端衝突,照常生效)。這是刻意的取捨:在終端
 *     裡工作時,終端的按鍵語意優先;需要開命令面板可以先按 Esc/點別處移開焦點,
 *     或使用 `Ctrl+Shift+P`(下方 CommandPalette 的第二組合鍵)。
 */

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** 顯示用的 modifier 符號(⌘ / Ctrl)——快捷鍵提示要跟著平台,不然是錯的資訊。 */
export const MOD_LABEL = isMac ? "⌘" : "Ctrl";

export interface Hotkey {
  /** 例如 "mod+k"、"mod+shift+p"、"mod+1"、"alt+ArrowDown" */
  combo: string;
  handler: (event: KeyboardEvent) => void;
  /** 終端聚焦時也要生效(預設 false:Ctrl 系讓給終端) */
  allowInTerminal?: boolean;
  /** 停用這組綁定(例如遠端連線不允許的操作) */
  disabled?: boolean;
}

function matches(event: KeyboardEvent, combo: string): boolean {
  const parts = combo.toLowerCase().split("+");
  const key = parts[parts.length - 1];
  const needMod = parts.includes("mod");
  const needShift = parts.includes("shift");
  const needAlt = parts.includes("alt");

  const modActive = isMac ? event.metaKey : event.ctrlKey;
  if (needMod !== modActive) return false;
  if (needShift !== event.shiftKey) return false;
  if (needAlt !== event.altKey) return false;
  // 非 mac 上避免 AltGr(Ctrl+Alt)誤觸
  if (!needAlt && event.altKey) return false;

  return event.key.toLowerCase() === key;
}

function insideTerminal(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest("[data-terminal-surface]"));
}

export function useHotkeys(hotkeys: Hotkey[]): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      for (const hotkey of hotkeys) {
        if (hotkey.disabled) continue;
        if (!matches(event, hotkey.combo)) continue;
        if (!hotkey.allowInTerminal && !isMac && insideTerminal(event.target)) continue;
        event.preventDefault();
        event.stopPropagation();
        hotkey.handler(event);
        return;
      }
    };
    // capture:在 xterm 等元件自己的 handler 之前先看到事件(仍受上面的
    // insideTerminal 判斷保護)。
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [hotkeys]);
}
