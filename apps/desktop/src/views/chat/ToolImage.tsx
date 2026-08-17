import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "../../ui/icons.js";

export interface ImageBlock {
  mediaType: string;
  data: string;
}

/** 防禦性驗證:tool_result 的 `output` 內容陣列裡的一筆是否為 Anthropic 的
 *  `ImageBlockParam`(base64 變體——沒有來源會回傳 URL 變體,故不處理)。同
 *  TodoListView.tsx 的 `parseTodoWriteInput` 慣例,形狀不符就回傳 null。 */
export function parseImageBlock(value: unknown): ImageBlock | null {
  if (typeof value !== "object" || value === null) return null;
  const block = value as Record<string, unknown>;
  if (block.type !== "image") return null;
  if (typeof block.source !== "object" || block.source === null) return null;
  const { type, media_type: mediaType, data } = block.source as Record<string, unknown>;
  if (type !== "base64") return null;
  if (typeof mediaType !== "string" || typeof data !== "string") return null;
  return { mediaType, data };
}

/**
 * async-scribbling-llama.md Phase 5:明確的大小安全上限——避免長時間累積大量
 * 截圖的 session 把巨大 base64 payload 直接塞進 DOM 拖垮渲染效能。一般截圖
 * 通常遠低於這個門檻,不受影響;只有離群的超大 payload 才會先擋成佔位圖,
 * 點擊後仍可查看——這只是渲染層的保護,不影響資料本身或其 persistence(SQLite
 * 仍完整存下整包 `output`,這一輪刻意不改動,見 async-scribbling-llama.md
 * Phase 5 段落)。
 */
const MAX_INLINE_BYTES = 15 * 1024 * 1024;

/** base64 字串解碼後的位元組數——用字串長度換算,不真的呼叫 atob() 解碼,
 *  避免對巨大 payload 做一次沒必要的完整解碼只為了量測大小。 */
function decodedByteLength(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

/** `item.output` 內容陣列含圖片 block 時,ChatView.tsx 渲染這個元件。 */
export function ToolImage({ mediaType, data }: ImageBlock): JSX.Element {
  const { t } = useTranslation(["chat"]);
  const [forceShow, setForceShow] = useState(false);
  const size = decodedByteLength(data);
  const tooLarge = size > MAX_INLINE_BYTES;

  if (tooLarge && !forceShow) {
    return (
      <button
        type="button"
        onClick={() => setForceShow(true)}
        className="focus-ring my-1 flex items-center gap-1.5 rounded-md border border-line-subtle bg-surface/60 px-2.5 py-1.5 text-left text-2xs text-fg-muted transition hover:text-fg"
      >
        <Icon name="image" size={13} className="flex-shrink-0 text-fg-faint" />
        {t("chat:image.tooLargeLabel", { size: (size / (1024 * 1024)).toFixed(1) })}
      </button>
    );
  }

  return (
    <img
      src={`data:${mediaType};base64,${data}`}
      alt={t("chat:image.altText")}
      className="my-1 max-w-full rounded-md border border-line-subtle"
    />
  );
}
