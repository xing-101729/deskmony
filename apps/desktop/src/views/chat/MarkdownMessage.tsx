import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock } from "./CodeBlock.js";

/**
 * 專案沒裝 `@tailwindcss/typography`(見 async-scribbling-llama.md Phase
 * 1+2),這裡手動用既有 design token 幫每個 markdown 區塊元素套上排版
 * class。顏色/字級刻意不重複宣告(`text-fg`/`text-sm`/`leading-relaxed` 已由
 * ChatView.tsx 的泡泡容器套用,靠 CSS 繼承往下傳),只有需要跟正文不同色階
 * /字重的元素(標題、blockquote、表格表頭)才明確指定。
 */
const components: Components = {
  code: CodeBlock,
  p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="mb-2 list-disc space-y-0.5 pl-5 last:mb-0">{children}</ul>,
  ol: ({ children }) => <ol className="mb-2 list-decimal space-y-0.5 pl-5 last:mb-0">{children}</ol>,
  li: ({ children }) => <li className="pl-0.5">{children}</li>,
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-accent underline underline-offset-2 hover:text-accent-hover"
    >
      {children}
    </a>
  ),
  blockquote: ({ children }) => (
    <blockquote className="mb-2 border-l-2 border-line-strong pl-2.5 text-fg-muted last:mb-0">{children}</blockquote>
  ),
  h1: ({ children }) => <h1 className="mb-1.5 mt-2 text-base font-semibold first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="mb-1.5 mt-2 text-sm font-semibold first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="mb-1 mt-2 text-sm font-semibold first:mt-0">{children}</h3>,
  h4: ({ children }) => <h4 className="mb-1 mt-2 text-sm font-semibold first:mt-0">{children}</h4>,
  h5: ({ children }) => <h5 className="mb-1 mt-2 text-sm font-semibold first:mt-0">{children}</h5>,
  h6: ({ children }) => <h6 className="mb-1 mt-2 text-sm font-semibold first:mt-0">{children}</h6>,
  hr: () => <hr className="my-2 border-line-subtle" />,
  table: ({ children }) => (
    <div className="mb-2 overflow-x-auto last:mb-0">
      <table className="w-full border-collapse text-left">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="border-b border-line">{children}</thead>,
  th: ({ children }) => <th className="px-2 py-1 font-medium text-fg-soft">{children}</th>,
  td: ({ children }) => <td className="px-2 py-1 align-top">{children}</td>,
  tr: ({ children }) => <tr className="border-b border-line-subtle last:border-0">{children}</tr>,
};

export function MarkdownMessage({ content }: { content: string }): JSX.Element {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
      {content}
    </ReactMarkdown>
  );
}
