#!/usr/bin/env node
/**
 * scripts/probe-claude-sdk-exit.mjs
 *
 * 2026-10-15(agent 自己結束時的自動復活):給 scripts/e2e-session-revive.mjs 用的探針——`claude` CLI 子行程在 session 執行中**自己結束**
 * (崩潰/被殺,非 0 結束碼)時,`ClaudeAgentSdkAdapter.events()` 必須送出 error 並**結束**:core 靠事件串流結束知道這個 runtime 已經
 * 不能用(`SessionManager.detachEndedRuntime()`),下一則人類訊息才會重新啟動 agent。修正前 adapter 只推 error、沒關事件佇列,
 * 串流永遠不結束,core 一直以為 agent 還活著。
 *
 * **不需要登入、不連網、不花錢**(同 probe-claude-sdk-resume.mjs 的手法):攔截 SDK 經 `spawnClaudeCodeProcess` 要求的那一次 `claude`
 * spawn,真正跑的是一個讀著 stdin、一秒後以結束碼 1 自己結束的 node 行程。
 *
 * 用法(由 e2e 呼叫,不是給人直接跑):`node scripts/probe-claude-sdk-exit.mjs <adapters dist index.js> <workspace> <config dir>`
 * 輸出一行 `PROBE_RESULT:<JSON>`(`{spawnObserved, ended, events}`;`ended` = 事件串流在 15 秒內結束)。
 */
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdirSync } from "node:fs";
import { pathToFileURL } from "node:url";

const [, , adaptersEntry, workspace, configDir] = process.argv;
if (!adaptersEntry || !workspace || !configDir) {
  console.error("usage: node probe-claude-sdk-exit.mjs <adapters-dist-index.js> <workspace> <config-dir>");
  process.exit(2);
}

// 不讓 SDK 碰使用者真正的 ~/.claude(必須在 SDK 第一次被用到之前設好)。
process.env.CLAUDE_CONFIG_DIR = configDir;
mkdirSync(workspace, { recursive: true });
mkdirSync(configDir, { recursive: true });

let spawnObserved = false;
const origSpawn = cp.spawn;
cp.spawn = function interceptedSpawn(command, args, options) {
  if (!spawnObserved) {
    spawnObserved = true;
    // 假的 claude:讀著 stdin(SDK 會寫控制請求進來)但什麼都不回,一秒後以結束碼 1 結束——模擬 CLI 崩潰/被殺。
    return origSpawn.call(this, process.execPath, ["-e", "process.stdin.resume(); setTimeout(() => process.exit(1), 1000)"], {
      cwd: options?.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      signal: options?.signal,
      windowsHide: true,
    });
  }
  return origSpawn.apply(this, arguments);
};
syncBuiltinESMExports();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const { ClaudeAgentSdkAdapter } = await import(pathToFileURL(adaptersEntry).href);
const adapter = new ClaudeAgentSdkAdapter();
const launch = { software: "claude-agent-sdk", providerId: "e2e-probe-claude" };
const handle = await adapter.spawn(launch, { path: workspace }, { sessionId: "deskmony-session-exit" });

const events = [];
const ended = await Promise.race([
  (async () => {
    for await (const event of adapter.events(handle)) {
      events.push(event.type === "error" ? { type: event.type, message: event.message, detail: event.detail } : { type: event.type });
    }
    return true;
  })(),
  sleep(15_000).then(() => false),
]);
await Promise.race([adapter.dispose(handle), sleep(5_000)]);
console.log(`PROBE_RESULT:${JSON.stringify({ spawnObserved, ended, events })}`);
process.exit(0);
