#!/usr/bin/env node
/**
 * scripts/run-e2e.mjs
 *
 * 2026-09-04(稽核修補):e2e 總跑器。
 *
 * ---- 為什麼需要這支 ----------------------------------------------------
 *
 * 在此之前,這個 repo 有 16,800 行 e2e,但**沒有任何指令可以跑它們** ——
 * `package.json` 完全沒有 `test` script、沒有 CI、沒有文件說明怎麼跑。
 * README 寫「已完成並有端到端測試把關」,而實際上「把關」的是作者記得手動
 * 逐支執行,不是任何機制。這支腳本 + `.github/workflows/ci.yml` 把那句話
 * 從過去式變成持續式。
 *
 * ---- 為什麼不含 e2e-gateway.mjs ----------------------------------------
 *
 * `e2e-gateway.mjs`(7,160 行)需要**本機有可用的 Claude Code 登入憑證或
 * `ANTHROPIC_API_KEY`**,而且會真的呼叫模型、花真的錢。它另外有一組
 * 「model-behavior」分組,斷言的是模型當輪的自由選擇,檔案自己標註為
 * 「已知 flake」。這種測試放進預設的 `pnpm test` 或 CI 會有兩個後果:
 * 別人第一次 clone 下來跑就失敗(沒有憑證),以及 CI 會週期性地因為模型
 * 換句話說而變紅 —— 而一個會無故變紅的 CI,很快就會被所有人忽略。
 *
 * 所以它留給人工執行:`node scripts/e2e-gateway.mjs`。下面這九支是**決定性**
 * 的(全部走 fake-acp-agent / fake-opencode-server / fake-pty-echo 假後端),
 * 在沒有任何憑證的機器上也能重現同樣結果。
 *
 * 用法:
 *   node scripts/run-e2e.mjs              # 全部跑完(即使中途有失敗)
 *   node scripts/run-e2e.mjs --bail       # 第一支失敗就停
 *   node scripts/run-e2e.mjs policy auto  # 只跑名稱含這些片段的
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requireFreshBuild } from "./lib/require-fresh-build.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 決定性 e2e 清單。順序刻意由快到慢 —— 失敗時越早看到越好。
 *
 * `e2e-crash-recovery-graceful-bootstrap.mjs` 不在此列:它是
 * `e2e-crash-recovery.mjs` 內部用的啟動殼,不是獨立測試(見該檔案頂端說明)。
 */
const SUITES = [
  // 單元層級、毫秒級跑完(不啟動 core)—— 放第一個當快速煙霧測試。
  "e2e-hard-deny",
  "e2e-session-subagents",
  "e2e-cost-governor",
  "e2e-message-budget",
  "e2e-lead-gate",
  "e2e-notification",
  "e2e-policy-engine",
  "e2e-agent-lifecycle",
  "e2e-crash-recovery",
  "e2e-auto-mode-yolo",
];

const args = process.argv.slice(2);
const bail = args.includes("--bail");
const filters = args.filter((a) => !a.startsWith("--"));
const selected = filters.length > 0 ? SUITES.filter((s) => filters.some((f) => s.includes(f))) : SUITES;

if (selected.length === 0) {
  console.error(`找不到符合 ${filters.join(", ")} 的測試。可用的:\n  ${SUITES.join("\n  ")}`);
  process.exit(1);
}

// 在跑任何一支之前先擋掉過期產物 —— 每支自己也會檢查一次,但在這裡先擋掉可以
// 省下「跑了 20 分鐘才發現測的是舊程式碼」。
requireFreshBuild();

function runSuite(name) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [path.join(__dirname, `${name}.mjs`)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (c) => (output += c.toString()));
    child.stderr.on("data", (c) => (output += c.toString()));
    child.on("close", (code) => {
      resolve({ name, code, output, durationMs: Date.now() - started });
    });
  });
}

/** 從各支測試各自的總結行抽出通過/總數(格式不統一,兩種都試)。 */
function extractTally(output) {
  const m1 = output.match(/總結:(\d+)\/(\d+)/);
  if (m1) return { passed: Number(m1[1]), total: Number(m1[2]) };
  const m2 = output.match(/總計:\s*(\d+)\s*PASS,\s*(\d+)\s*FAIL/);
  if (m2) return { passed: Number(m2[1]), total: Number(m2[1]) + Number(m2[2]) };
  return undefined;
}

const results = [];
console.log(`\n跑 ${selected.length} 支決定性 e2e(不含需要真實憑證的 e2e-gateway.mjs)\n`);

for (const name of selected) {
  process.stdout.write(`  ${name} ... `);
  const r = await runSuite(name);
  const tally = extractTally(r.output);
  results.push({ ...r, tally });
  const secs = (r.durationMs / 1000).toFixed(0);
  if (r.code === 0) {
    console.log(`PASS ${tally ? `(${tally.passed}/${tally.total})` : ""} ${secs}s`);
  } else {
    console.log(`FAIL ${tally ? `(${tally.passed}/${tally.total})` : ""} ${secs}s  [exit ${r.code}]`);
    if (bail) break;
  }
}

const failed = results.filter((r) => r.code !== 0);

// 失敗的把完整輸出印出來(通過的不印,否則會淹沒 CI log)。
for (const r of failed) {
  console.log(`\n${"=".repeat(70)}\n${r.name} 的完整輸出\n${"=".repeat(70)}`);
  console.log(r.output);
}

const totalAssertions = results.reduce((s, r) => s + (r.tally?.total ?? 0), 0);
const passedAssertions = results.reduce((s, r) => s + (r.tally?.passed ?? 0), 0);
const totalSecs = (results.reduce((s, r) => s + r.durationMs, 0) / 1000).toFixed(0);

console.log(`\n${"=".repeat(70)}`);
console.log(`  ${results.length - failed.length}/${results.length} 支通過,共 ${passedAssertions}/${totalAssertions} 個斷言,耗時 ${totalSecs}s`);
if (failed.length > 0) console.log(`  失敗:${failed.map((r) => r.name).join(", ")}`);
console.log(`${"=".repeat(70)}\n`);

process.exit(failed.length > 0 ? 1 : 0);
