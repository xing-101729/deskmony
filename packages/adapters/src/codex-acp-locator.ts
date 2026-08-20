import { createRequire } from "node:module";

/**
 * codex-acp-locator.ts(Codex ACP 橋接切換 Phase 1 新增):解析
 * `@agentclientprotocol/codex-acp`(npm 套件,內附自己的 `@openai/codex`
 * 相依,不需要使用者另裝 codex CLI,支援 `OPENAI_API_KEY`/`CODEX_API_KEY` 或
 * ChatGPT 登入,見 docs/DECISIONS.md B2)的可執行進入點。
 *
 * 為什麼放在 packages/adapters 而非 apps/core 或 packages/shared:只有這個
 * package 的 package.json 真的宣告了對 `@agentclientprotocol/codex-acp` 的
 * 相依(見同目錄 package.json)——`createRequire(import.meta.url)` 是相對於
 * *這個檔案* 的模組解析路徑,必須放在真正宣告相依的 package 內才保證解析
 * 得到,不能假設 pnpm hoisting 會讓其他 package 也能直接 `require.resolve()`
 * 到它。
 *
 * 已實際驗證(Windows,`@agentclientprotocol/codex-acp@1.4.0`,見
 * apps/core/src/detect/agent-detector.ts 的 `detectCodexAcp()` 如何使用這裡
 * 的回傳值):
 *  - package.json 的 `main`/`bin.codex-acp` 都指向同一個檔案 `dist/index.js`
 *    ——單一 esbuild bundle(~1.18MB),開頭有 `#!/usr/bin/env node`,是純 JS
 *    轉譯層;執行期再用 `child_process.spawn()` 另外拉起 `@openai/codex` 的
 *    `bin/codex.js`(平台無關 JS launcher),那支 launcher 再依平台/架構挑選
 *    vendored 的原生 Rust binary(例如 `@openai/codex-win32-x64` 這個
 *    optionalDependency)執行——實際是三層行程樹,但 `AcpAdapter` 既有的
 *    `killProcessTree()`(Windows 上 `taskkill /T /F`)本來就是整棵子孫行程樹
 *    一起殺,不需要為此另外調整 dispose() 邏輯。
 *  - `node <entryPath> --version` 能在沒有任何憑證的情況下直接印出版本號並以
 *    exit code 0 結束(實測輸出 `@agentclientprotocol/codex-acp 1.4.0`)——這
 *    是 `detectCodexAcp()` 用來確認「JS 殼 + 底層 Rust engine 都真的能跑」的
 *    探測旗標。**`--help` 已驗證會整個掛住**(不是被辨識成特殊旗標印出說明後
 *    結束,而是直接落入啟動 ACP stdio server、卡在等待 `initialize` 這個
 *    JSON-RPC 請求,逾時前不會有任何輸出),絕對不可用來探測。
 *
 * 用 `require.resolve()` 而非直接組字串路徑(例如手動拼
 * `.../node_modules/@agentclientprotocol/codex-acp/dist/index.js`),是因為
 * `main` 欄位理論上可能隨套件版本改變檔名/位置——交給 Node 內建的模組解析
 * 機制(含 pnpm 的 node_modules 結構),不自己維護一份可能過時的假設。
 */
export function resolveCodexAcpBridge(): { command: string; args: string[] } | undefined {
  try {
    const require = createRequire(import.meta.url);
    const entryPath = require.resolve("@agentclientprotocol/codex-acp");
    return { command: process.execPath, args: [entryPath] };
  } catch {
    // 套件沒裝好(node_modules 缺失/損毀)、或 require.resolve 因其他原因
    // 丟例外——一律回傳 undefined,呼叫端(detectCodexAcp())據此回報
    // installed:false,不讓例外往外傳到 detectAllAgents()。
    return undefined;
  }
}
