#!/usr/bin/env node
/**
 * scripts/e2e-core-port-in-use.mjs
 *
 * 2026-10-27:core 的 gateway 綁不到 port 時,必須印出可讀的訊息並以非 0 exit code 退出。
 *
 * 在此之前,EADDRINUSE 經 `ws` 的 WebSocketServer 轉成未捕捉例外,core 的 uncaught-exception 兜底印一行
 * `[FATAL]` 之後刻意不退出——core 活著卻沒在 listen,連到這個 port 的 client(桌面殼的 renderer、CLI)
 * 安靜地連到佔用這個 port 的程序(見 apps/core/src/gateway/ws-gateway.ts `listen()` 的說明)。
 *
 * 涵蓋:
 *   A. port 被別的程序佔用、port 來自 DESKMONY_CORE_PORT:core 以 CORE_EXIT_CODE_BIND_FAILED 退出;
 *      訊息講清楚 host:port 與「改 DESKMONY_CORE_PORT」,並原樣保留 Node 的錯誤訊息(lib/e2e-ports.mjs 的
 *      guardCorePort() 靠比對它判斷撞號);不再走 uncaught-exception,也沒有印出「listening」。
 *   B. port 來自 config.json(沒有設 DESKMONY_CORE_PORT):提示指向那個設定檔的 daemon.port。
 *   C. 佔用者放開之後,同一個 port 照常啟動:gateway 連得上、core 沒有自己退出
 *      (`listen()` 改成回傳 Promise 之後的正向路徑)。
 *
 * 不需要任何 agent 後端:core 在 listen 之前就該結束,C 也只確認 gateway 起來了。
 *
 * 前置需求:`pnpm build` 已跑過。
 * 用法:node scripts/e2e-core-port-in-use.mjs
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { requireFreshBuild } from "./lib/require-fresh-build.mjs";
import { allocatePort, guardCorePort } from "./lib/e2e-ports.mjs";

requireFreshBuild();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const CORE_ENTRY = path.join(REPO_ROOT, "apps", "core", "dist", "index.js");

/** 與 apps/core/src/gateway/ws-gateway.ts 的 `CORE_EXIT_CODE_BIND_FAILED` 同值(這支測的就是那個契約,刻意不 import core)。 */
const CORE_EXIT_CODE_BIND_FAILED = 78;

/** core 啟動到 listen 之前要先回收孤兒、跑 migration、對帳;在慢的機器上給足時間。 */
const CORE_EXIT_TIMEOUT_MS = 60_000;

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`\n${ok ? "PASS" : "FAIL"} ${name}`);
  if (detail) console.log(`       ${detail}`);
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeDirs(prefix) {
  return {
    homeDir: mkdtempSync(path.join(os.tmpdir(), `deskmony-e2e-${prefix}-home-`)),
    dataDir: mkdtempSync(path.join(os.tmpdir(), `deskmony-e2e-${prefix}-data-`)),
    workspaceDir: mkdtempSync(path.join(os.tmpdir(), `deskmony-e2e-${prefix}-ws-`)),
  };
}

function rmDirs({ homeDir, dataDir, workspaceDir }) {
  for (const dir of [homeDir, dataDir, workspaceDir]) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

/** 扮演「已經佔住這個 port 的別的程序」:在 core 預設綁的 127.0.0.1 上 listen。 */
function listenOn(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => socket.destroy());
    server.once("error", reject);
    server.listen({ port, host: "127.0.0.1" }, () => resolve(server));
  });
}

/** 取一個空 port 並立刻佔住。取號到佔住之間可能被別人搶走,那就換一個號碼。 */
async function holdFreshPort() {
  for (let attempt = 0; attempt < 5; attempt++) {
    const port = await allocatePort();
    try {
      return { port, server: await listenOn(port) };
    } catch {
      // 被搶走了,換號。
    }
  }
  throw new Error("連續 5 次都佔不住剛取到的 port");
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

/**
 * 起一個 core 並收集它全部的輸出。`port` 為 undefined 時不設 DESKMONY_CORE_PORT(讓 port 來自 config.json)。
 * DESKMONY_BIND_HOST 一律拿掉:佔用者綁的是 127.0.0.1,core 也必須綁同一個位址才會撞到。
 */
function startCore({ port, homeDir, dataDir, workspaceDir }) {
  const env = {
    ...process.env,
    DESKMONY_HOME: homeDir,
    DESKMONY_DATA_DIR: dataDir,
    DESKMONY_WORKSPACE: workspaceDir,
  };
  delete env.DESKMONY_CORE_PORT;
  delete env.DESKMONY_BIND_HOST;
  if (port !== undefined) env.DESKMONY_CORE_PORT = String(port);
  const proc = spawn(process.execPath, [CORE_ENTRY], { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  const state = { proc, output: "" };
  const tag = port ?? "config";
  proc.stdout.on("data", (chunk) => {
    state.output += chunk.toString();
    process.stdout.write(`[core:${tag}] ${chunk}`);
  });
  proc.stderr.on("data", (chunk) => {
    state.output += chunk.toString();
    process.stderr.write(`[core:${tag}:err] ${chunk}`);
  });
  return state;
}

/** 等剛 spawn 的 core 自己結束;逾時回傳 null(此時 core 還活著——正是這支要抓的回歸)。 */
function waitForExit(proc, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    // 'close' 而不是 'exit':要等 stdout/stderr 都讀完,斷言輸出內容時才不會漏掉最後幾行。
    proc.once("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function waitForPort(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const ws = new WebSocket(url);
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("connect timeout")), 1500);
        ws.addEventListener("open", () => {
          clearTimeout(t);
          resolve();
        });
        ws.addEventListener("error", () => {
          clearTimeout(t);
          reject(new Error("connect error"));
        });
      });
      ws.close();
      return;
    } catch (err) {
      lastErr = err;
      await sleep(300);
    }
  }
  throw new Error(`等待 gateway 啟動逾時: ${lastErr}`);
}

async function killProcessTreeHard(proc) {
  if (!proc || proc.exitCode !== null) return;
  const exitPromise = new Promise((resolve) => proc.once("exit", resolve));
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      proc.kill("SIGKILL");
    }
  } catch {
    // ignore
  }
  await Promise.race([exitPromise, sleep(3000)]);
}

// =======================================================================
// A + C:port 來自 DESKMONY_CORE_PORT;佔用時退出,放開後照常啟動。
async function testPortFromEnv() {
  const dirs = makeDirs("portinuse");
  const { port, server } = await holdFreshPort();
  let core;
  try {
    core = startCore({ port, ...dirs });
    const code = await waitForExit(core.proc, CORE_EXIT_TIMEOUT_MS);
    const out = core.output;
    record(
      `A1: port ${port} 被佔用時 core 自己退出,exit code = ${CORE_EXIT_CODE_BIND_FAILED}`,
      code === CORE_EXIT_CODE_BIND_FAILED,
      code === null ? `${CORE_EXIT_TIMEOUT_MS}ms 內沒有退出(core 帶著沒開的 gateway 繼續跑)` : `exit code=${code}`,
    );
    record(
      "A2: 訊息講清楚哪個 host:port、原因是 port 被佔用、怎麼改 DESKMONY_CORE_PORT",
      out.includes(`gateway 無法綁定 127.0.0.1:${port}`) &&
        out.includes("已經被別的程序佔用") &&
        out.includes(`port ${port} 來自環境變數 DESKMONY_CORE_PORT`) &&
        out.includes("請把 DESKMONY_CORE_PORT 改成一個空閒的 port"),
    );
    record(
      "A3: 原樣保留 Node 的錯誤訊息(lib/e2e-ports.mjs 的 guardCorePort 靠它判斷撞號)",
      new RegExp(`listen EADDRINUSE[^\\n]*:${port}(?!\\d)`).test(out),
    );
    record(
      "A4: 不再經由 uncaught-exception 兜底,也沒有印出 gateway 已在 listen",
      !out.includes("uncaught-exception") && !out.includes("WebSocket server listening"),
    );
  } catch (err) {
    record("A 執行過程發生未預期錯誤", false, String(err));
  } finally {
    if (core) await killProcessTreeHard(core.proc);
    await closeServer(server);
  }

  // C:同一個 port、同一份資料目錄,佔用者放開之後應該照常啟動。
  // 放開到 core 開始 listen 之間 port 可能被別人搶走——guardCorePort 會以 75 中止,由 run-e2e.mjs 重跑。
  try {
    core = startCore({ port, ...dirs });
    guardCorePort(core.proc, port);
    await waitForPort(`ws://127.0.0.1:${port}`, 30_000);
    // 給 core 一點時間:若它在 listen 之後又走進退出的路徑,這段時間內應該看得到。
    await sleep(1000);
    record(
      `C: 佔用者放開後同一個 port 照常啟動(gateway 連得上、core 仍在執行)`,
      core.proc.exitCode === null && core.output.includes(`WebSocket server listening on ws://127.0.0.1:${port}`),
      `exitCode=${core.proc.exitCode}`,
    );
  } catch (err) {
    record("C 執行過程發生未預期錯誤", false, String(err));
  } finally {
    if (core) await killProcessTreeHard(core.proc);
  }

  rmDirs(dirs);
}

// =======================================================================
// B:port 來自 config.json。環境變數優先於設定檔,所以提示要指向「設定檔的 daemon.port 或環境變數」。
async function testPortFromConfigFile() {
  const dirs = makeDirs("portinuse-cfg");
  const { port, server } = await holdFreshPort();
  const configPath = path.join(dirs.homeDir, "config.json");
  writeFileSync(configPath, JSON.stringify({ daemon: { port } }, null, 2), "utf8");
  let core;
  try {
    core = startCore({ port: undefined, ...dirs });
    const code = await waitForExit(core.proc, CORE_EXIT_TIMEOUT_MS);
    const out = core.output;
    record(
      `B1: port 來自 config.json 時同樣以 ${CORE_EXIT_CODE_BIND_FAILED} 退出`,
      code === CORE_EXIT_CODE_BIND_FAILED,
      code === null ? `${CORE_EXIT_TIMEOUT_MS}ms 內沒有退出` : `exit code=${code}`,
    );
    record(
      "B2: 提示指出 port 來自哪個設定檔的 daemon.port,並說明可改環境變數或設定檔",
      out.includes(`port ${port} 來自設定檔 ${configPath} 的 daemon.port`) &&
        out.includes(`請設定環境變數 DESKMONY_CORE_PORT(或修改 ${configPath} 的 daemon.port)`),
    );
  } catch (err) {
    record("B 執行過程發生未預期錯誤", false, String(err));
  } finally {
    if (core) await killProcessTreeHard(core.proc);
    await closeServer(server);
  }
  rmDirs(dirs);
}

// =======================================================================
async function main() {
  if (!existsSync(CORE_ENTRY)) {
    console.error(`找不到 ${CORE_ENTRY} —— 請先執行 pnpm build`);
    process.exit(1);
  }

  console.log("=== A/C:port 來自 DESKMONY_CORE_PORT ===");
  await testPortFromEnv();
  console.log("\n=== B:port 來自 config.json ===");
  await testPortFromConfigFile();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n\n========== 總結:${results.length - failed.length}/${results.length} 通過 ==========`);
  for (const r of failed) {
    console.log(`  FAIL: ${r.name}`);
  }
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[e2e-core-port-in-use] fatal:", err);
  process.exit(1);
});
