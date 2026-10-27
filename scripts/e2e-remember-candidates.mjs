#!/usr/bin/env node
/**
 * scripts/e2e-remember-candidates.mjs
 *
 * 2026-10-22:「永遠允許」的規則候選(packages/shared/src/remember-rule.ts 的 `rememberRuleCandidates()`)。
 *
 * 桌面彈窗(apps/desktop/src/views/PermissionModal.tsx)列出全部候選、CLI/TUI 的 `[A]`(apps/cli/src/render.ts 的
 * `buildNarrowestRememberRule()`)取第一個,兩邊在此之前各抄一份只看最外層的欄位清單——codex 的 MCP 工具
 * (參數包在 `arguments` 裡)只會得到「整個工具都放行」這種最寬的候選。
 *
 * 核心斷言是**來回驗證**:每個提議的規則單獨丟進 core 的 PolicyEngine,都要放行產生它的那個請求。核可的規則
 * 若比對不到它自己,使用者按了「永遠允許」下次還是被問——或者更糟,UI 為了「比得到」只好給更寬的規則。core 的
 * allow 規則要全部候選值都符合才命中(見 policy-engine.ts 的 `ruleMatches()`),候選邏輯必須跟著它走。
 *
 * 單元層級,不啟動 core,毫秒級。前置需求:pnpm build(載入 packages/shared、apps/core、apps/cli 的 dist)。
 *
 * 用法:node scripts/e2e-remember-candidates.mjs
 */

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireFreshBuild } from "./lib/require-fresh-build.mjs";

requireFreshBuild();

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const load = (rel) => import(pathToFileURL(path.join(REPO_ROOT, rel)).href);
const { rememberRuleCandidates } = await load("packages/shared/dist/index.js");
const { PolicyEngine } = await load("apps/core/dist/permissions/policy-engine.js");
const { buildNarrowestRememberRule, summarizeToolInputLines } = await load("apps/cli/dist/render.js");

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
  if (detail) console.log(`       ${detail}`);
}

const ws = mkdtempSync(path.join(os.tmpdir(), "deskmony-remember-ws-"));
const inWs = (...segments) => path.join(ws, ...segments);
const slashed = (p) => p.split(path.sep).join("/");
const codexMcp = (server, tool, args) => ({ toolName: `mcp.${server}.${tool}`, input: { server, tool, arguments: args } });
const ctx = { attended: true, local: true, autoMode: false };
const decideWith = (rule, toolName, input) =>
  new PolicyEngine({ rules: [rule], allowedHosts: [] }).decide({ sessionId: "s", requestId: randomUUID(), toolName, input, workingDir: ws }, ctx);

/** 各後端的真實形狀;路徑都在 workingDir 內(來回驗證要求每個候選都放行它)。 */
const table = [
  ["Claude Bash", { toolName: "Bash", input: { command: "pnpm test", description: "run tests" } }, "command-exact"],
  ["Claude Write", { toolName: "Write", input: { file_path: inWs("src", "a.ts"), content: "x" } }, "path"],
  ["OpenCode edit 的 {filepath, diff}", { toolName: "edit", input: { filepath: inWs("src", "b.ts"), diff: "-a\n+b" } }, "path"],
  ["codex MCP write_file(arguments 外殼)", codexMcp("filesystem", "write_file", { path: inWs("src", "c.ts"), content: "x" }), "path"],
  ["codex MCP 的 shell 指令(arguments 外殼)", codexMcp("shell", "run", { command: "pnpm lint" }), "command-exact"],
  ["codex function call {command, cwd, arguments:{cmd}}", { toolName: "Run command", input: { command: "pnpm test", cwd: ws, arguments: { cmd: "pnpm test", workdir: ws } } }, "command-exact"],
  ["move_file 兩端在不同子目錄", codexMcp("filesystem", "move_file", { source: inWs("src", "x", "a.ts"), destination: inWs("src", "y", "b.ts") }), "path"],
  ["read_multiple_files", codexMcp("filesystem", "read_multiple_files", { paths: [inWs("docs", "a.md"), inWs("src", "b.ts")] }), "path"],
  ["沒有認得的欄位", codexMcp("github", "create_issue", { title: "t", body: "b" }), "tool"],
];

// ---- R1:來回驗證——每個候選單獨放進 PolicyEngine,都要放行產生它的請求;第一個候選的種類符合預期 ----
{
  const failures = [];
  for (const [label, { toolName, input }, firstKind] of table) {
    const candidates = rememberRuleCandidates(toolName, input, ws);
    if (candidates[0]?.scope.kind !== firstKind) failures.push(`${label}:第一個候選是 ${candidates[0]?.scope.kind},預期 ${firstKind}`);
    for (const { scope, rule } of candidates) {
      const decision = decideWith(rule, toolName, input);
      if (decision.effect !== "allow" || decision.matchedRule !== 0) failures.push(`${label}:${scope.kind} 規則 ${JSON.stringify(rule)} → ${decision.effect}`);
    }
  }
  record(
    `R1 來回驗證:${table.length} 種真實形狀(Claude/OpenCode/codex MCP/function call/move_file/read_multiple_files)的每個候選規則都放行產生它的請求,第一個候選的種類符合預期`,
    failures.length === 0,
    failures.length === 0 ? "全部候選都比對得到自己的請求" : failures.join(";"),
  );
}

// ---- R2:codex MCP 工具拿得到窄規則——過去只看最外層,只能「整個工具都放行」 ----
{
  const write = codexMcp("filesystem", "write_file", { path: inWs("src", "c.ts"), content: "x" });
  const moved = codexMcp("filesystem", "move_file", { source: inWs("src", "x", "a.ts"), destination: inWs("src", "y", "b.ts") });
  const writeFirst = rememberRuleCandidates(write.toolName, write.input, ws)[0];
  const moveFirst = rememberRuleCandidates(moved.toolName, moved.input, ws)[0];
  // 窄規則真的窄:同一個工具寫到 src 外面(仍在 worktree 內)不會被它放行。
  const elsewhere = decideWith(writeFirst.rule, write.toolName, { server: "filesystem", tool: "write_file", arguments: { path: inWs("other", "d.ts") } }).effect;
  record(
    "R2 codex MCP 工具的預設候選是 pathUnder 所在目錄(move_file 取兩端的共同祖先),不是整個工具;同工具寫到那個目錄外不會被它放行",
    writeFirst.scope.kind === "path" &&
      writeFirst.scope.dir === slashed(inWs("src")) &&
      moveFirst.scope.kind === "path" &&
      moveFirst.scope.dir === slashed(inWs("src")) &&
      elsewhere === "escalate",
    `write=${JSON.stringify(writeFirst.scope)}, move=${JSON.stringify(moveFirst.scope)}, 寫到 src 外=${elsewhere}`,
  );
}

// ---- R3:指令候選不全相同時不給指令規則(哪條都比對不到這個請求),退回路徑/整個工具 ----
{
  const input = { command: "pnpm test", arguments: { command: "rm -rf build" } };
  const candidates = rememberRuleCandidates("mcp.shell.run", input, ws);
  const wouldBe = decideWith({ tool: "mcp.shell.run", when: { commandEquals: "pnpm test" }, effect: "allow" }, "mcp.shell.run", input).effect;
  record(
    "R3 指令候選不全相同(最外層 pnpm test、外殼裡 rm -rf build)→ 不提議 commandEquals(對照:那條規則確實比對不到這個請求),只剩整個工具",
    candidates.length === 1 && candidates[0].scope.kind === "tool" && wouldBe === "escalate",
    `candidates=${JSON.stringify(candidates.map((c) => c.scope))}, commandEquals「pnpm test」對這個請求=${wouldBe}`,
  );
}

// ---- R4:多個路徑彼此無關(共同祖先退到根目錄/不同磁碟)時不提議根目錄,只留 workingDir;沒有 workingDir 就是整個工具 ----
{
  const posix = rememberRuleCandidates("mcp.fs.read_multiple_files", { paths: ["/a/x.txt", "/b/y.txt"] }, "/ws");
  const drives = rememberRuleCandidates("mcp.fs.read_multiple_files", { paths: ["C:/a/x.txt", "D:/b/y.txt"] }, "C:/ws");
  const sameDrive = rememberRuleCandidates("mcp.fs.read_multiple_files", { paths: ["C:/a/x.txt", "C:/b/y.txt"] }, undefined);
  record(
    "R4 多個路徑沒有共同目錄(/a 與 /b、C: 與 D:、同磁碟但只共用 C:)→ 不提議根目錄,只有 workingDir 候選;沒給 workingDir 時退回整個工具",
    posix.length === 1 &&
      posix[0].scope.kind === "working-dir" &&
      drives.length === 1 &&
      drives[0].scope.kind === "working-dir" &&
      sameDrive.length === 1 &&
      sameDrive[0].scope.kind === "tool",
    `posix=${JSON.stringify(posix.map((c) => c.scope))}, drives=${JSON.stringify(drives.map((c) => c.scope))}, sameDrive=${JSON.stringify(sameDrive.map((c) => c.scope))}`,
  );
}

// ---- R5:Windows 的 workingDir(反斜線)與共同目錄(正斜線)是同一個目錄時只給一個選項 ----
{
  const read = codexMcp("filesystem", "read_multiple_files", { paths: [inWs("docs", "a.md"), inWs("src", "b.ts")] });
  const candidates = rememberRuleCandidates(read.toolName, read.input, ws);
  record(
    "R5 共同目錄剛好就是 workingDir 時只給一個候選(不因斜線方向不同變成兩個一樣的選項)",
    candidates.length === 1 && candidates[0].scope.kind === "path",
    `workingDir=${ws}, candidates=${JSON.stringify(candidates.map((c) => c.scope))}`,
  );
}

// ---- R6:CLI/TUI 的 [A] 就是第一個候選;CLI 的提示文字看得到外殼裡的路徑 ----
{
  const mismatches = table.filter(
    ([, { toolName, input }]) =>
      JSON.stringify(buildNarrowestRememberRule(toolName, input, ws)) !== JSON.stringify(rememberRuleCandidates(toolName, input, ws)[0].rule),
  );
  const write = codexMcp("filesystem", "write_file", { path: inWs("src", "c.ts"), content: "x" });
  const lines = summarizeToolInputLines(write.input);
  record(
    "R6 CLI 的最窄規則與彈窗預設候選一致(所有形狀);CLI 權限提示對 codex MCP 工具顯示外殼裡的路徑",
    mismatches.length === 0 && lines.includes(`路徑:${inWs("src", "c.ts")}`),
    `不一致:${mismatches.map(([l]) => l).join("、") || "無"};lines=${JSON.stringify(lines)}`,
  );
}

rmSync(ws, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
console.log(`\n========== 總結:${results.length - failed.length}/${results.length} 通過 ==========`);
for (const f of failed) console.log(`  FAIL: ${f.name}`);
process.exit(failed.length > 0 ? 1 : 0);
