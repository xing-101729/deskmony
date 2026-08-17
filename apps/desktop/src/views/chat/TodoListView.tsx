import { Icon } from "../../ui/icons.js";

/** 對應 SDK 的 `TodoWriteInput.todos[]`(見 async-scribbling-llama.md Phase
 *  3)。這裡刻意不 import SDK 型別——desktop 這一側從沒依賴過
 *  `@anthropic-ai/claude-agent-sdk`(那是 adapter 層的事),`input` 一路以
 *  `unknown` 型別流到前端,因此在這裡自己宣告形狀 + 執行期驗證。 */
export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm: string;
}

const VALID_STATUSES = new Set(["pending", "in_progress", "completed"]);

/** 防禦性驗證:形狀不符就回傳 null,呼叫端(ChatView.tsx)據此 fallback 回
 *  通用的 `ToolCallBubble`,避免未來 SDK 改格式時直接把 undefined 欄位塞進
 *  畫面或整個 render 掛掉。 */
export function parseTodoWriteInput(input: unknown): TodoItem[] | null {
  if (typeof input !== "object" || input === null) return null;
  const todos = (input as { todos?: unknown }).todos;
  if (!Array.isArray(todos)) return null;

  const parsed: TodoItem[] = [];
  for (const entry of todos) {
    if (typeof entry !== "object" || entry === null) return null;
    const { content, status, activeForm } = entry as Record<string, unknown>;
    if (typeof content !== "string" || typeof activeForm !== "string") return null;
    if (typeof status !== "string" || !VALID_STATUSES.has(status)) return null;
    parsed.push({ content, status: status as TodoItem["status"], activeForm });
  }
  return parsed;
}

/** 單一 todo 列的狀態指示:`pending` = 空心圈、`in_progress` = 沿用
 *  ChatView.tsx 的 ToolCallBubble 用過的 `animate-breathe` 呼吸點(同一套
 *  「進行中」視覺語彙,尺寸放大以對齊 checkmark/空心圈)、`completed` = 打勾。 */
function TodoStatusIndicator({ status }: { status: TodoItem["status"] }): JSX.Element {
  if (status === "completed") {
    return <Icon name="check" size={12} className="mt-[3px] flex-shrink-0 text-ok" />;
  }
  if (status === "in_progress") {
    return <span className="mt-[3px] h-3 w-3 flex-shrink-0 animate-breathe rounded-full bg-accent" />;
  }
  return <span className="mt-[3px] h-3 w-3 flex-shrink-0 rounded-full border-[1.5px] border-fg-faint" />;
}

/** Claude Code 的慣例:`in_progress` 的項目顯示 `activeForm`(「正在做 X」)
 *  而非 `content`(「做 X」),其餘狀態顯示 `content`。 */
export function TodoListView({ todos }: { todos: TodoItem[] }): JSX.Element {
  return (
    <div className="my-1.5 rounded-md border border-line-subtle bg-surface/60 px-2.5 py-2 text-xs">
      <ul className="space-y-1.5">
        {todos.map((todo, index) => (
          <li key={index} className="flex items-start gap-2">
            <TodoStatusIndicator status={todo.status} />
            <span
              className={
                todo.status === "completed"
                  ? "text-fg-faint line-through"
                  : todo.status === "in_progress"
                    ? "font-medium text-fg"
                    : "text-fg-muted"
              }
            >
              {todo.status === "in_progress" ? todo.activeForm : todo.content}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
