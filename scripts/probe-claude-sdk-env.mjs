#!/usr/bin/env node
/**
 * scripts/probe-claude-sdk-env.mjs
 *
 * 2026-10-05(安全:agent 子行程環境不得含 Deskmony 憑證):給 scripts/e2e-agent-env.mjs 用的探針——
 * 回答「`ClaudeAgentSdkAdapter` 真的 spawn `claude` 子行程時,傳給它的 `env` 裡有沒有 Deskmony 的內部憑證」。
 *
 * ## 為什麼需要這個探針
 *
 * Claude SDK 那條路本機沒登入就無法用真模型跑(其餘三種 adapter 都能走 fake 後端、讓子行程自己回報環境)。但「SDK 在
 * 沒有 provider env 時省略 `env`、讓子行程繼承整份 process.env」正是這個漏洞最常見的觸發情境,所以不能只測
 * `buildAgentChildEnv()` 這個函式本身——要確認 **adapter 真的把它的結果傳給了 spawn**。
 *
 * ## 做法
 *
 * 在載入 adapters 之前,把 `node:child_process` 的 `spawn` 換成一個攔截器(`syncBuiltinESMExports()` 讓 ESM 的具名匯入
 * 也拿到替換後的版本,與 SDK/adapter 內 `import { spawn } from "node:child_process"` 的綁定相通):
 *  - 攔下 SDK 經 `spawnClaudeCodeProcess` 要求的那一次 `claude` spawn,記錄它收到的 `options.env`(`undefined` = 子行程會繼承
 *    整份 process.env,也算洩漏)——**只記錄「有沒有」某些變數,絕不輸出值**;
 *  - 真正 spawn 的是一個閒置的 node 行程(不啟動真的 claude:沒登入、也不該花資源或連網),立刻在探針結束時由 adapter 的
 *    `dispose()` 收掉。
 *
 * 用法(由 e2e 呼叫,不是給人直接跑):`node scripts/probe-claude-sdk-env.mjs <adapters dist index.js> <逗號分隔的變數名稱> <cwd>`
 * 輸出一行 `PROBE_RESULT:<JSON>`:`{ envProvided: boolean, presence: { <名稱>: boolean } }`。
 * 呼叫端負責在這個行程的環境裡設好要被濾掉的(假)憑證,否則「全部都不存在」是空洞的通過。
 */
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";

const [, , adaptersEntry, namesCsv, cwd] = process.argv;
if (!adaptersEntry || !namesCsv || !cwd) {
  console.error("usage: node probe-claude-sdk-env.mjs <adapters-dist-index.js> <names-csv> <cwd>");
  process.exit(2);
}

let captured; // { env } | undefined
const origSpawn = cp.spawn;
cp.spawn = function interceptedSpawn(command, args, options) {
  if (captured === undefined) {
    captured = { env: options?.env };
    // 不啟動真的 claude:換成一個閒置的 node 行程(用原本的 spawn、只帶最小環境,避免它自己成為洩漏來源的混淆)。
    return origSpawn.call(this, process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      cwd: options?.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      signal: options?.signal,
      windowsHide: true,
    });
  }
  return origSpawn.apply(this, arguments);
};
syncBuiltinESMExports();

const { ClaudeAgentSdkAdapter } = await import(pathToFileURL(adaptersEntry).href);
const adapter = new ClaudeAgentSdkAdapter();
const launch = {
  software: "claude-agent-sdk",
  providerId: "e2e-probe-claude",
  // provider 層級 env:證明 provider env 照常傳進去(E2E_ENV_PASSTHROUGH 要存在),同時使用者在這裡填的主 token 一樣被刪。
  env: { E2E_ENV_PASSTHROUGH: "1", DESKMONY_AUTH_TOKEN: "user-typed-provider-env-token" },
};
const handle = await adapter.spawn(launch, { path: cwd });
await new Promise((resolve) => setTimeout(resolve, 300)); // 讓 SDK 的 spawn 呼叫走完(實際上是同步的,保險)

const names = namesCsv.split(",").map((n) => n.trim()).filter(Boolean);
let result;
if (captured === undefined) {
  result = { error: "SDK 沒有呼叫 spawn(攔截器沒被觸發)" };
} else if (captured.env === undefined) {
  // env 被省略 = 子行程繼承整份 process.env,等於所有 process.env 裡的變數都洩漏。
  const upperKeys = new Set(Object.keys(process.env).map((k) => k.toUpperCase()));
  result = { envProvided: false, presence: Object.fromEntries(names.map((n) => [n, upperKeys.has(n.toUpperCase())])) };
} else {
  const upperKeys = new Set(Object.keys(captured.env).map((k) => k.toUpperCase()));
  result = { envProvided: true, presence: Object.fromEntries(names.map((n) => [n, upperKeys.has(n.toUpperCase())])) };
}
console.log(`PROBE_RESULT:${JSON.stringify(result)}`);

try {
  await Promise.race([adapter.dispose(handle), new Promise((resolve) => setTimeout(resolve, 5000))]);
} catch {
  // ignore
}
process.exit(0);
