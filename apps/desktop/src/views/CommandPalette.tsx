import { useEffect, useMemo, useRef, useState } from "react";
import { ModalPortal } from "./ModalPortal.js";
import { Icon, type IconName } from "../ui/icons.js";
import { Kbd } from "../ui/Button.js";
import { StatusDot } from "../ui/Badge.js";
import type { StatusMeta } from "../ui/status.js";

/**
 * 命令面板(⌘K / Ctrl+K)——Raycast / Linear / Cursor 的核心互動,也是這輪
 * 「鍵盤優先操作」的入口。
 *
 * 設計要點:
 *   - **不新增任何能力**,只是既有動作的鍵盤入口:切換視圖、切換/建立 session、
 *     開啟設定/團隊管理/復原視圖、切換主題……每一項都對應畫面上原本就存在的
 *     按鈕(由呼叫端 App.tsx 組裝,見該檔案的 `commands`)。
 *   - **子序列模糊搜尋**:輸入 `tb` 能命中「任務看板」、輸入路徑片段能命中
 *     session。命中位置越靠前、越連續,分數越高。
 *   - 面板置頂(不是垂直置中):清單變長時視覺不會上下跳動,這是命令面板類
 *     UI 的慣例。
 */

export interface Command {
  id: string;
  title: string;
  /** 第二行/右側的補充說明(例如 session 的工作目錄) */
  subtitle?: string;
  group: string;
  icon?: IconName;
  /** 快捷鍵提示(顯示用,實際綁定在 App.tsx 的 useHotkeys) */
  hint?: string;
  /** 額外的搜尋關鍵字(例如英文別名、狀態文字) */
  keywords?: string;
  /** session 類命令可以帶狀態圓點,直接在面板裡看到 agent 忙不忙 */
  status?: StatusMeta;
  tone?: "danger";
  run: () => void;
}

/** 子序列模糊比對:回傳分數(越大越相關),沒命中回傳 -1。 */
function fuzzyScore(haystack: string, needle: string): number {
  if (!needle) return 0;
  const text = haystack.toLowerCase();
  const query = needle.toLowerCase();
  let score = 0;
  let cursor = 0;
  let lastHit = -1;
  for (const char of query) {
    const hit = text.indexOf(char, cursor);
    if (hit === -1) return -1;
    // 連續命中加重、越靠前加重(讓「開頭吻合」勝過「散落命中」)
    score += hit === lastHit + 1 ? 12 : 4;
    score += Math.max(0, 8 - hit);
    lastHit = hit;
    cursor = hit + 1;
  }
  return score;
}

export function CommandPalette({
  commands,
  onClose,
}: {
  commands: Command[];
  onClose: () => void;
}): JSX.Element {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const results = useMemo(() => {
    if (!query.trim()) return commands;
    return commands
      .map((command) => ({
        command,
        score: Math.max(
          fuzzyScore(command.title, query),
          fuzzyScore(command.subtitle ?? "", query) - 6,
          fuzzyScore(command.keywords ?? "", query) - 3,
          fuzzyScore(command.group, query) - 10,
        ),
      }))
      .filter((entry) => entry.score >= 0)
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.command);
  }, [commands, query]);

  useEffect(() => setActiveIndex(0), [query]);

  // 讓目前選中的項目保持在可視範圍內(純鍵盤操作時必須)。
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, results]);

  const runActive = (): void => {
    const command = results[activeIndex];
    if (!command) return;
    onClose();
    command.run();
  };

  const handleKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === "ArrowDown" || (event.key === "n" && event.ctrlKey)) {
      event.preventDefault();
      setActiveIndex((index) => (results.length === 0 ? 0 : (index + 1) % results.length));
    } else if (event.key === "ArrowUp" || (event.key === "p" && event.ctrlKey)) {
      event.preventDefault();
      setActiveIndex((index) => (results.length === 0 ? 0 : (index - 1 + results.length) % results.length));
    } else if (event.key === "Enter") {
      event.preventDefault();
      runActive();
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };

  // 依 group 分段渲染,但索引是「攤平後的全域索引」——鍵盤上下移動要能跨群組
  // 連續移動,不能每群各自計數。
  let flatIndex = -1;

  return (
    <ModalPortal>
      <div
        className="fixed inset-0 z-[60] flex animate-fade-in items-start justify-center bg-scrim/60 p-4 pt-[12vh] backdrop-blur-[2px]"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label="命令面板"
          className="flex w-[min(620px,calc(100vw-32px))] animate-pop-in flex-col overflow-hidden rounded-xl bg-panel shadow-overlay"
        >
          <div className="flex items-center gap-2 border-b border-line-subtle px-3">
            <Icon name="search" size={15} className="text-fg-faint" />
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="搜尋指令、對話、專案…"
              aria-label="搜尋指令"
              className="h-11 flex-1 bg-transparent text-md text-fg outline-none placeholder:text-fg-faint"
            />
            <Kbd>Esc</Kbd>
          </div>

          <div ref={listRef} className="max-h-[min(52vh,420px)] overflow-y-auto p-1.5">
            {results.length === 0 && (
              <p className="px-3 py-8 text-center text-xs text-fg-subtle">沒有符合「{query}」的指令</p>
            )}
            {results.map((command, index) => {
              flatIndex = index;
              const previous = results[index - 1];
              const showGroup = !previous || previous.group !== command.group;
              const active = index === activeIndex;
              return (
                <div key={command.id}>
                  {showGroup && (
                    <div className="select-chrome px-2 pb-1 pt-2 text-2xs font-semibold uppercase tracking-[0.08em] text-fg-faint">
                      {command.group}
                    </div>
                  )}
                  <button
                    type="button"
                    data-active={active ? "true" : undefined}
                    onMouseMove={() => setActiveIndex(flatIndex)}
                    onClick={() => {
                      onClose();
                      command.run();
                    }}
                    className={`flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition ${
                      active ? "bg-accent/12" : "hover:bg-surface"
                    }`}
                  >
                    {command.status ? (
                      <span className="flex w-4 justify-center">
                        <StatusDot meta={command.status} />
                      </span>
                    ) : (
                      <Icon
                        name={command.icon ?? "chevron-right"}
                        size={14}
                        className={
                          command.tone === "danger" ? "text-danger" : active ? "text-accent" : "text-fg-subtle"
                        }
                      />
                    )}
                    <span className="min-w-0 flex-1">
                      <span
                        className={`block truncate text-sm ${
                          command.tone === "danger" ? "text-danger" : active ? "text-fg" : "text-fg-soft"
                        }`}
                      >
                        {command.title}
                      </span>
                      {command.subtitle && (
                        <span className="block truncate text-2xs text-fg-faint">{command.subtitle}</span>
                      )}
                    </span>
                    {command.hint && <Kbd>{command.hint}</Kbd>}
                  </button>
                </div>
              );
            })}
          </div>

          <div className="flex select-chrome items-center gap-3 border-t border-line-subtle bg-surface/40 px-3 py-2 text-2xs text-fg-faint">
            <span className="flex items-center gap-1">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd> 選擇
            </span>
            <span className="flex items-center gap-1">
              <Kbd>↵</Kbd> 執行
            </span>
            <span className="ml-auto tabular">{results.length} 項</span>
          </div>
        </div>
      </div>
    </ModalPortal>
  );
}
