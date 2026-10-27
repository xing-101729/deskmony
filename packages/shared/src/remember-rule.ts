import type { PolicyRule } from "./core-config.js";
import { extractCommandCandidates, extractPathCandidates } from "./tool-input.js";

/**
 * 權限請求「永遠允許」的規則候選,最窄的排第一個。
 *
 * 2026-10-22 起桌面端彈窗(apps/desktop/src/views/PermissionModal.tsx:全部候選,套上 i18n 文字讓人選,預設第一個)
 * 與 CLI/TUI 的 `[A]`(apps/cli/src/render.ts 的 `buildNarrowestRememberRule()`:只取第一個)共用這一份。在此之前
 * 兩邊各抄一份只看最外層的欄位清單、靠註解「手動同步」——codex 的 MCP 工具(參數包在 `arguments` 裡)只會得到
 * 「整個工具都放行」這種最寬的候選,而 HLD 要求的「CLI 的 [A] 與彈窗預設一致」也只能靠人記得。
 *
 * 指令/路徑用政策引擎同一份抽取(tool-input.ts)。一個 input 可能抽出好幾個候選值,而 core 的 allow 規則要
 * **每一個**都符合才命中(apps/core/src/permissions/policy-engine.ts 的 `ruleMatches()`)——所以這裡只提議比對得到
 * 「這個請求本身」的規則:
 *   - 指令:全部候選(trim 後)相同才給 commandEquals/commandMatches;不同的話哪條都對不上,改往下看路徑/整個工具。
 *   - 路徑:pathUnder 用所有路徑所在目錄的共同祖先。共同祖先退到根目錄(或 `C:` 這種磁碟根)代表這幾個路徑彼此
 *     無關,給它等於放行整顆磁碟,不提議;只剩 workingDir 那個候選(有給的話)。
 */

/** 候選的種類——桌面端依此挑 i18n 文字。 */
export type RememberRuleScope =
  | { kind: "command-exact"; command: string }
  | { kind: "command-prefix"; firstWord: string; pattern: string }
  | { kind: "path"; dir: string }
  | { kind: "working-dir"; dir: string }
  | { kind: "tool" };

export interface RememberRuleCandidate {
  scope: RememberRuleScope;
  rule: PolicyRule;
}

function normalizeSlashes(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

function dirnameOf(p: string): string {
  const normalized = normalizeSlashes(p);
  const idx = normalized.lastIndexOf("/");
  if (idx <= 0) return normalized.startsWith("/") ? "/" : normalized;
  return normalized.slice(0, idx);
}

/** 根目錄或磁碟根(`/`、`C:`、`C:/`)。 */
function isFilesystemRoot(dir: string): boolean {
  return dir === "/" || /^[A-Za-z]:\/?$/.test(dir);
}

/**
 * 多個路徑的 pathUnder 邊界:都在同一個目錄時就是那個目錄(單一路徑的情況與 2026-10-22 之前相同,即使那是根目錄);
 * 不同目錄時是最長共同祖先(以 `/` 分段比對),沒有共同段或退到根目錄時回傳 undefined。
 */
function pathBoundary(paths: string[]): string | undefined {
  const dirs = paths.map(dirnameOf);
  if (new Set(dirs).size === 1) return dirs[0];
  const split = dirs.map((d) => d.split("/"));
  const first = split[0];
  let n = 0;
  while (n < first.length && split.every((segments) => segments[n] === first[n])) n++;
  if (n === 0) return undefined;
  const common = first.slice(0, n).join("/") || "/";
  return isFilesystemRoot(common) ? undefined : common;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 「永遠允許」的規則候選,至少一個(最後退回「整個工具放行」),最窄的排第一個。`workingDir` 是這個 session 的工作目錄。 */
export function rememberRuleCandidates(toolName: string, input: unknown, workingDir?: string): RememberRuleCandidate[] {
  const commands = extractCommandCandidates(input).map((c) => c.trim());
  if (commands.length > 0 && commands.every((c) => c === commands[0])) {
    const command = commands[0];
    const candidates: RememberRuleCandidate[] = [
      { scope: { kind: "command-exact", command }, rule: { tool: toolName, when: { commandEquals: command }, effect: "allow" } },
    ];
    const firstWord = command.split(/\s+/)[0];
    if (firstWord) {
      const pattern = `^${escapeRegExp(firstWord)}\\b.*`;
      candidates.push({
        scope: { kind: "command-prefix", firstWord, pattern },
        rule: { tool: toolName, when: { commandMatches: pattern }, effect: "allow" },
      });
    }
    return candidates;
  }

  const paths = extractPathCandidates(input);
  if (paths.length > 0) {
    const candidates: RememberRuleCandidate[] = [];
    const dir = pathBoundary(paths);
    if (dir !== undefined) {
      candidates.push({ scope: { kind: "path", dir }, rule: { tool: toolName, when: { pathUnder: dir }, effect: "allow" } });
    }
    // 比較前統一斜線:Windows 的 workingDir 是反斜線、dir 是正斜線,同一個目錄不該變成兩個選項。
    if (workingDir && normalizeSlashes(workingDir) !== dir) {
      candidates.push({
        scope: { kind: "working-dir", dir: workingDir },
        rule: { tool: toolName, when: { pathUnder: workingDir }, effect: "allow" },
      });
    }
    if (candidates.length > 0) return candidates;
  }

  return [{ scope: { kind: "tool" }, rule: { tool: toolName, effect: "allow" } }];
}
