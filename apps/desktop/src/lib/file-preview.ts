/**
 * Files 分頁預覽用的小工具(2026-10-20,右側面板 P2)。**純函式、沒有任何 import**
 * (`scripts/e2e-side-panel-pure.mjs` 直接用 Node 載入這個 .ts 驗證)。
 */

/**
 * 依副檔名挑 `views/chat/CodeBlock.tsx` 已註冊的語言(`PrismLight` 只註冊了一個子集,沒註冊的語言會退成純文字)。
 * 不認得的回 `"text"`。
 */
const LANGUAGE_BY_EXT: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  json: "json",
  jsonc: "json",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  py: "python",
  go: "go",
  rs: "rust",
  yml: "yaml",
  yaml: "yaml",
  css: "css",
  html: "html",
  htm: "html",
  xml: "html",
  svg: "html",
  sql: "sql",
  diff: "diff",
  patch: "diff",
  md: "markdown",
  markdown: "markdown",
};

/** `path` 可以是相對路徑或單純檔名;沒有副檔名(`Makefile`、`.gitignore` 的點開頭)→ `"text"`。 */
export function languageForPath(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "text"; // 沒有點,或只有開頭的點(`.gitignore`)
  return LANGUAGE_BY_EXT[name.slice(dot + 1).toLowerCase()] ?? "text";
}

/** 位元組數的人類可讀寫法(1024 進位):`512 B`、`1.5 KB`、`2.0 MB`。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "?";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

/** 把相對路徑接上資料夾(`parent` 為空字串 = root)。 */
export function joinRelPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}
