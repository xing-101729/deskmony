import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ExtraProps } from "react-markdown";
import { PrismLight as SyntaxHighlighter } from "react-syntax-highlighter";
import oneDark from "react-syntax-highlighter/dist/esm/styles/prism/one-dark";
import oneLight from "react-syntax-highlighter/dist/esm/styles/prism/one-light";
import bash from "react-syntax-highlighter/dist/esm/languages/prism/bash";
import css from "react-syntax-highlighter/dist/esm/languages/prism/css";
import diff from "react-syntax-highlighter/dist/esm/languages/prism/diff";
import go from "react-syntax-highlighter/dist/esm/languages/prism/go";
import javascript from "react-syntax-highlighter/dist/esm/languages/prism/javascript";
import json from "react-syntax-highlighter/dist/esm/languages/prism/json";
import jsx from "react-syntax-highlighter/dist/esm/languages/prism/jsx";
import markdown from "react-syntax-highlighter/dist/esm/languages/prism/markdown";
import markup from "react-syntax-highlighter/dist/esm/languages/prism/markup";
import python from "react-syntax-highlighter/dist/esm/languages/prism/python";
import rust from "react-syntax-highlighter/dist/esm/languages/prism/rust";
import sql from "react-syntax-highlighter/dist/esm/languages/prism/sql";
import tsx from "react-syntax-highlighter/dist/esm/languages/prism/tsx";
import typescript from "react-syntax-highlighter/dist/esm/languages/prism/typescript";
import yaml from "react-syntax-highlighter/dist/esm/languages/prism/yaml";
import { IconButton } from "../../ui/Button.js";
import { useTheme } from "../../ui/theme.js";

/**
 * 明確列出的語言子集(而非全語言包),見 async-scribbling-llama.md Phase 1+2
 * 「輕量 build,明確列出語言清單」的要求——用 `PrismLight`(同步版)而不是
 * `PrismAsyncLight`:後者內部無條件 `import('./async-languages/prism')`,那
 * 是一份涵蓋全部 ~200 種語言的動態 import() 對照表,即使一個都沒用到,Vite
 * build 仍會把它們全部各自拆成獨立 chunk 檔案產出(實測:切到 PrismAsyncLight
 * 會多出 280 個 chunk、2.6MB 的 dist/assets,`PrismLight` 完全不會)。`refractor/core`
 * (Prism 引擎本身,不含任何語言文法)只有 8KB,同步引入的成本可忽略。
 *
 * `registerLanguage` 的第一個參數在執行期其實會被忽略——實際語言判定靠模組
 * 自身的 `displayName`/`aliases`(見 react-syntax-highlighter/dist/esm/
 * prism-light.js:`registerLanguage = (_, language) => refractor.register(language)`),
 * 這裡仍逐一寫出對應名稱只是方便閱讀。html 沒有獨立的 Prism 語言,對應到
 * Prism 的 `markup`。
 */
SyntaxHighlighter.registerLanguage("typescript", typescript);
SyntaxHighlighter.registerLanguage("tsx", tsx);
SyntaxHighlighter.registerLanguage("javascript", javascript);
SyntaxHighlighter.registerLanguage("jsx", jsx);
SyntaxHighlighter.registerLanguage("json", json);
SyntaxHighlighter.registerLanguage("bash", bash);
SyntaxHighlighter.registerLanguage("python", python);
SyntaxHighlighter.registerLanguage("go", go);
SyntaxHighlighter.registerLanguage("rust", rust);
SyntaxHighlighter.registerLanguage("yaml", yaml);
SyntaxHighlighter.registerLanguage("css", css);
SyntaxHighlighter.registerLanguage("html", markup);
SyntaxHighlighter.registerLanguage("sql", sql);
SyntaxHighlighter.registerLanguage("diff", diff);
SyntaxHighlighter.registerLanguage("markdown", markdown);

function FencedCodeBlock({ language, code }: { language: string; code: string }): JSX.Element {
  const { t } = useTranslation(["chat"]);
  const resolvedTheme = useTheme((s) => s.resolved);
  const [copied, setCopied] = useState(false);

  const handleCopy = (): void => {
    void navigator.clipboard.writeText(code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="my-1.5 overflow-hidden rounded-md border border-line-subtle bg-canvas">
      <div className="flex items-center justify-between gap-2 bg-surface-2 px-2.5 py-1 text-2xs text-fg-faint">
        <span className="font-mono">{language}</span>
        <IconButton
          icon={copied ? "check" : "copy"}
          aria-label={copied ? t("chat:code.copiedAriaLabel") : t("chat:code.copyAriaLabel")}
          title={copied ? t("chat:code.copiedAriaLabel") : t("chat:code.copyAriaLabel")}
          size="xs"
          variant="ghost"
          onClick={handleCopy}
        />
      </div>
      <div className="overflow-x-auto">
        <SyntaxHighlighter
          language={language}
          style={resolvedTheme === "dark" ? oneDark : oneLight}
          customStyle={{ margin: 0, padding: "0.625rem", background: "transparent", fontSize: "12px" }}
          codeTagProps={{ className: "font-mono" }}
        >
          {code}
        </SyntaxHighlighter>
      </div>
    </div>
  );
}

/**
 * react-markdown 的 `code` component override。react-markdown v9 起不再傳
 * `inline` prop(AST 沒有足夠資訊可靠判斷),官方建議的判斷方式就是這裡採用的
 * ——fenced code block 才會有 `language-xxx` 的 `className`,inline code span
 * 沒有,見 async-scribbling-llama.md Phase 1+2 說明。
 */
export function CodeBlock({ className, children }: JSX.IntrinsicElements["code"] & ExtraProps): JSX.Element {
  const match = /language-(\w+)/.exec(className ?? "");
  if (!match) {
    return <code className="rounded bg-surface-2 px-1 py-0.5 font-mono text-2xs text-fg-soft break-words">{children}</code>;
  }
  const code = (Array.isArray(children) ? children.join("") : String(children ?? "")).replace(/\n$/, "");
  return <FencedCodeBlock language={match[1].toLowerCase()} code={code} />;
}
