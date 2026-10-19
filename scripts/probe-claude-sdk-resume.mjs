#!/usr/bin/env node
/**
 * scripts/probe-claude-sdk-resume.mjs
 *
 * 2026-10-15(session 自動復活):給 scripts/e2e-session-revive.mjs 用的探針——回答「`ClaudeAgentSdkAdapter.spawn(..., resume)` 對 Claude
 * 到底做了什麼」,**不需要登入、不連網、不花錢**(和 probe-claude-sdk-env.mjs 同一種手法:攔截 SDK 經 `spawnClaudeCodeProcess` 要求的那一次
 * `claude` spawn,記下它收到的命令列參數,真正跑的是一個閒置的 node 行程)。
 *
 * 做法:把 `CLAUDE_CONFIG_DIR` 指到暫存目錄,手寫一個最小的 SDK 對話檔(`<configDir>/projects/<專案目錄>/<sessionId>.jsonl`,內容是一則 user +
 * 一則 assistant),然後三次 `spawn()`:
 *   1. 帶存在的 `backendSessionId`:命令列要有 `--resume=<id>`,`handle.resumed === true`,`handle.id` 是呼叫端指定的 Deskmony session id。
 *   2. 帶**不存在**的 `backendSessionId`:命令列**不能**有 `--resume`(否則 CLI 要等第一則訊息才報 "No conversation found"),`handle.resumed === false`。
 *   3. 沒帶 `backendSessionId` 只帶 `sessionId`(復活時 session 還沒捕捉到後端識別碼):沒有 `--resume`,`handle.id` 仍是指定的 id。
 *
 * 用法(由 e2e 呼叫,不是給人直接跑):`node scripts/probe-claude-sdk-resume.mjs <adapters dist index.js> <workspace> <config dir>`
 * 輸出一行 `PROBE_RESULT:<JSON>`。
 */
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [, , adaptersEntry, workspace, configDir] = process.argv;
if (!adaptersEntry || !workspace || !configDir) {
  console.error("usage: node probe-claude-sdk-resume.mjs <adapters-dist-index.js> <workspace> <config-dir>");
  process.exit(2);
}

// SDK 讀這個環境變數決定對話檔放哪;必須在 SDK 第一次被用到之前設好。
process.env.CLAUDE_CONFIG_DIR = configDir;
mkdirSync(workspace, { recursive: true });

const sessionId = "11111111-2222-4333-8444-555555555555";
// 專案目錄名稱要和 SDK 的 `getSessionInfo({ dir })` 算法一致:SDK 先用 `fs/promises` 的 `realpath()` 取真實路徑再把非英數字元換成 `-`。
// 原生 realpath 會展開 Windows 的 8.3 短檔名——CI runner 的暫存目錄是 `C:\Users\RUNNER~1\...`,直接用 `path.resolve()` 算出的目錄
// SDK 找不到(本機路徑沒有短檔名,所以只有 CI 會踩到)。
const projectDir = path.join(configDir, "projects", (await realpath(path.resolve(workspace))).replace(/[^a-zA-Z0-9]/g, "-"));
mkdirSync(projectDir, { recursive: true });
const line = (entry) => `${JSON.stringify(entry)}\n`;
const now = new Date().toISOString();
writeFileSync(
  path.join(projectDir, `${sessionId}.jsonl`),
  line({ type: "user", message: { role: "user", content: "hello there" }, uuid: "aaaaaaaa-0000-4000-8000-000000000001", parentUuid: null, timestamp: now, sessionId, cwd: path.resolve(workspace), version: "2.0.0", isSidechain: false, userType: "external" }) +
    line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "hi" }], model: "x", id: "msg_1", type: "message", stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }, uuid: "aaaaaaaa-0000-4000-8000-000000000002", parentUuid: "aaaaaaaa-0000-4000-8000-000000000001", timestamp: now, sessionId, cwd: path.resolve(workspace), version: "2.0.0", isSidechain: false, userType: "external" }),
  "utf8",
);

/** 目前這一次 spawn 攔到的命令列參數。 */
let capturedArgs;
const origSpawn = cp.spawn;
cp.spawn = function interceptedSpawn(command, args, options) {
  if (capturedArgs === undefined) {
    capturedArgs = args;
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
// model / 思考程度:復活要保留 session 記住的值(AgentCatalog 對 claude 是明確值,見 buildLaunchSpecForSession)。
const launch = { software: "claude-agent-sdk", providerId: "e2e-probe-claude", model: "sonnet", effort: "high" };

async function attempt(resume) {
  capturedArgs = undefined;
  const handle = await adapter.spawn(launch, { path: workspace }, resume);
  await new Promise((resolve) => setTimeout(resolve, 200)); // SDK 的 spawn 呼叫是同步的,保險多等一下
  const args = capturedArgs ?? [];
  // SDK 把 resume 組成單一個 `--resume=<id>` 參數。
  const resumeFlag = args.find((a) => a.startsWith("--resume="));
  const argAfter = (flag) => {
    const eq = args.find((a) => a.startsWith(`${flag}=`));
    if (eq) return eq.slice(flag.length + 1);
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : null;
  };
  const outcome = {
    modelArg: argAfter("--model"),
    effortArg: argAfter("--effort"),
    handleId: handle.id,
    resumed: handle.resumed,
    resumeArg: resumeFlag ? resumeFlag.slice("--resume=".length) : null,
    spawnObserved: capturedArgs !== undefined,
  };
  await Promise.race([adapter.dispose(handle), new Promise((resolve) => setTimeout(resolve, 5000))]);
  return outcome;
}

const result = {
  sessionId,
  existing: await attempt({ backendSessionId: sessionId, sessionId: "deskmony-session-A" }),
  missing: await attempt({ backendSessionId: "99999999-2222-4333-8444-555555555555", sessionId: "deskmony-session-B" }),
  noBackendId: await attempt({ sessionId: "deskmony-session-C" }),
};
console.log(`PROBE_RESULT:${JSON.stringify(result)}`);
process.exit(0);
