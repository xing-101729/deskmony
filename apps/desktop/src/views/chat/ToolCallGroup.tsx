import { memo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "../../ui/Badge.js";
import { Icon } from "../../ui/icons.js";
import { sameToolItems, summarizeToolGroup, type ToolItem } from "../../lib/chat-groups.js";

/** 摘要列最多列出幾個(去重後的)工具名,超過的用「…」帶過;完整清單在 title。 */
const MAX_NAMES_SHOWN = 3;

/**
 * 2026-10-16:連續工具呼叫的群組卡片(分組規則見 lib/chat-groups.ts 的 `groupChatItems()`)。
 *
 * 外觀與 `ToolCallBubble` 的 summary 同一個風格(chevron、狀態點、右側 Badge),只是中間改成
 * 「使用了 N 個工具」+ 工具名稱摘要;展開後是原本的各張工具卡片,每張仍可各自展開看 input/output。
 *
 * **展開/收合交給 `<details>` 自己的 DOM 狀態**(不受控),React 重繪不會碰 `open` 屬性:
 *   - 群組的 key 是第一個工具的 id(穩定),新工具加入、串流更新時這個元件實體不會被換掉,所以使用者手動展開/收合的
 *     結果不會被重置;切換 session 再回來會重新掛載、回到預設的摺疊(刻意不持久化)。
 *   - 子卡片**第一次展開時才渲染**(`mounted`):一組可能有幾十個工具,裡面的 `DiffHunkView` 還會跑語法高亮,
 *     從沒被打開過的群組不該付這個成本。展開過之後就一直保留在 DOM(收合只是被 `<details>` 藏起來),
 *     這樣收合再展開時,裡面各張卡片自己的展開狀態也還在。
 *
 * 用 `<details>/<summary>` 而不是 button + aria-expanded:瀏覽器原生就處理了 Enter/Space 與無障礙語意,
 * 與 `ToolCallBubble` 也一致。
 *
 * **具名 group**(`group/toolgroup`、`group-open/toolgroup:`):Tailwind 的 `group-open:` 會對任何祖先的
 * `.group[open]` 生效,群組裡的 `ToolCallBubble` 自己也有 chevron 靠 `group-open:rotate-90`——不具名的話,
 * 外層群組一展開,裡面每一張還沒展開的卡片的 chevron 都會跟著轉 90 度。
 *
 * `renderItem` 由 ChatView 傳入(而不是這裡 import `ChatBubble`):ChatView 已經 import 這個檔案,
 * 反過來 import 會多一條循環依賴;而且分派工具卡片(TodoListView / DiffHunkView / ToolCallBubble)的邏輯
 * 本來就該只有 `ChatBubble` 一份。
 */
export const ToolCallGroup = memo(
  function ToolCallGroup({
    items,
    renderItem,
  }: {
    items: readonly ToolItem[];
    renderItem: (item: ToolItem) => ReactNode;
  }): JSX.Element {
    const { t } = useTranslation(["chat"]);
    const [mounted, setMounted] = useState(false);
    const summary = summarizeToolGroup(items);

    const separator = t("chat:tool.group.nameSeparator");
    const allNames = summary.names.join(separator);
    const shownNames =
      summary.names.slice(0, MAX_NAMES_SHOWN).join(separator) + (summary.names.length > MAX_NAMES_SHOWN ? "…" : "");

    const dotClass =
      summary.status === "running" ? "animate-breathe bg-accent" : summary.status === "failed" ? "bg-danger" : "bg-ok";

    return (
      <details
        onToggle={(e) => {
          if (e.currentTarget.open) setMounted(true);
        }}
        className="group/toolgroup my-1.5 rounded-md border border-line-subtle bg-surface/60 text-xs"
      >
        <summary
          // 滑鼠與鍵盤(Enter/Space)啟動 summary 都會先觸發 click、早於 `toggle` 事件:在這裡就掛上子卡片,
          // 展開的那一幀就有內容,不會先閃出一個空的展開框。`onToggle` 留給其他開啟途徑(例如瀏覽器自己展開)。
          onClick={() => setMounted(true)}
          className="focus-ring flex cursor-pointer select-none list-none items-center gap-2 rounded-md px-3 py-2 text-fg-muted marker:content-none"
        >
          <Icon
            name="chevron-right"
            size={11}
            className="flex-shrink-0 text-fg-faint transition-transform group-open/toolgroup:rotate-90"
          />
          <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${dotClass}`} />
          <span className="flex-shrink-0 text-fg-soft">{t("chat:tool.group.usedTools", { count: summary.total })}</span>
          {/* `w-0` 不能省:`truncate` 是 nowrap,min-content 寬度就是整串工具名;沒有明確寬度的話,窄視窗下它會把
              外層 `<main>`(沒有 min-w-0 的 flex item)撐得比視窗寬,整個對話區橫向溢出。實際寬度由 flex-1 決定,
              `w-0` 只是讓它不參與 min-content 的計算。 */}
          <span className="w-0 min-w-0 flex-1 truncate font-mono text-fg-faint" title={allNames}>
            {summary.status === "running" && summary.runningName !== undefined
              ? t("chat:tool.group.runningNow", { name: summary.runningName })
              : shownNames}
          </span>
          <span className="flex flex-shrink-0 items-center gap-1.5">
            {summary.failedCount > 0 && (
              <Badge tone="danger">{t("chat:tool.group.failedCount", { count: summary.failedCount })}</Badge>
            )}
            {summary.status === "running" && <Badge tone="accent">{t("chat:tool.statusRunning")}</Badge>}
            {summary.status === "done" && <Badge tone="ok">{t("chat:tool.statusDone")}</Badge>}
          </span>
        </summary>
        {mounted && <div className="border-t border-line-subtle px-2 py-1">{items.map(renderItem)}</div>}
      </details>
    );
  },
  // 預設的淺比較會因為每次重算分組都新建 items 陣列而永遠判定「變了」,見 sameToolItems() 的說明。
  (prev, next) => prev.renderItem === next.renderItem && sameToolItems(prev.items, next.items),
);
