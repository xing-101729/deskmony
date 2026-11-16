#!/usr/bin/env node
/**
 * scripts/e2e-windows-path.mjs
 *
 * 2026-11-16:core 啟動時展開 PATH 裡沒展開的 `%VAR%`(apps/core/src/env/windows-path.ts)。
 *
 * 真機回報:系統 Path 登錄值型別被改成 REG_SZ,Explorer 不展開 `%SystemRoot%\system32`,從開始功能表啟動的
 * Deskmony 的 core 找不到 `where.exe`,Claude Code CLI / OpenCode 全部「未偵測到」。
 *
 * 涵蓋:
 *   A. 純函式:有定義的變數展開(名稱不分大小寫)、沒定義的原樣保留、只展開一層、不跨 `;`、非 Windows 不動、
 *      鍵名是 `Path` 時就地改寫同一個鍵。
 *   B.(僅 Windows)用「壞掉的」PATH 起一個 core:PATH 只有字面上的 `%SystemRoot%\system32`、`%SystemRoot%`,
 *      以及 `%DESKMONY_E2E_FAKE_BIN%`(指向放了假 `claude.cmd` 的暫存目錄),鍵名用 Explorer 給的 `Path`。
 *      經 CLI 的 `doctor --json` 呼叫 `env.detectAgents`:claude-code-cli 必須 installed、路徑在假目錄、
 *      版本是假 shim 印的字串;core 輸出要有「已自動展開」的警告。沒有修補時 `where` 是 ENOENT,這一段會失敗。
 *
 * 前置需求:`pnpm build` 已跑過。
 * 用法:node scripts/e2e-windows-path.mjs
 */

import { spawn, execFile } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireFreshBuild } from "./lib/require-fresh-build.mjs";
import { allocatePort, guardCorePort } from "./lib/e2e-ports.mjs";

requireFreshBuild();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const CORE_ENTRY = path.join(REPO_ROOT, "apps", "core", "dist", "index.js");
const CLI_ENTRY = path.join(REPO_ROOT, "apps", "cli", "dist", "bin.js");
const HELPER = pathToFileURL(path.join(REPO_ROOT, "apps", "core", "dist", "env", "windows-path.js")).href;

const FAKE_VERSION = "9.9.9-deskmony-e2e-fake";
const TOKEN = "e2e-windows-path-token";
/** core 起來 + 背景偵測(其餘 CLI 都找不到,很快)——慢機器上給足時間。 */
const DETECT_DEADLINE_MS = 60_000;

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`\n${ok ? "PASS" : "FAIL"} ${name}`);
  if (detail) console.log(`       ${detail}`);
}
/**
 * 比較兩個目錄是否相同。CI runner 的暫存目錄是 8.3 短檔名(`C:\Users\RUNNER~1\…`),`where` 回的是長檔名,
 * 所以先用 realpath 正規化再不分大小寫比較。
 */
function sameDir(a, b) {
  const norm = (p) => {
    try {
      return realpathSync.native(p).toLowerCase();
    } catch {
      return path.resolve(p).toLowerCase();
    }
  };
  return norm(a) === norm(b);
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---- A. 純函式 -------------------------------------------------------------

const { expandWindowsEnvReferences, repairWindowsPath } = await import(HELPER);
{
  const env = { SystemRoot: "C:\\WINDOWS", Empty: "" };
  const cases = [
    ["%SystemRoot%\\system32", "C:\\WINDOWS\\system32", "有定義的變數展開"],
    ["%SYSTEMROOT%\\System32\\Wbem", "C:\\WINDOWS\\System32\\Wbem", "名稱不分大小寫"],
    ["%NoSuchVar%\\bin", "%NoSuchVar%\\bin", "沒定義的原樣保留"],
    ["a%Empty%b", "ab", "定義成空字串就換成空字串"],
    ["%A;B%", "%A;B%", "不跨 ; 把兩個項目當成一個參照"],
    ["100%", "100%", "單獨的 % 不動"],
  ];
  for (const [input, expected, label] of cases) {
    const actual = expandWindowsEnvReferences(input, env);
    record(`A ${label}`, actual === expected, `${JSON.stringify(input)} → ${JSON.stringify(actual)}(期望 ${JSON.stringify(expected)})`);
  }
  const once = expandWindowsEnvReferences("%Outer%", { Outer: "%Inner%", Inner: "x" });
  record("A 只展開一層(同 ExpandEnvironmentStrings)", once === "%Inner%", JSON.stringify(once));

  const winEnv = { Path: "%SystemRoot%\\system32;D:\\tools", SystemRoot: "C:\\WINDOWS" };
  const repair = repairWindowsPath(winEnv, "win32");
  record(
    "A repairWindowsPath 就地改寫同一個鍵(Path)",
    repair?.key === "Path" && winEnv.Path === "C:\\WINDOWS\\system32;D:\\tools" && !("PATH" in winEnv),
    JSON.stringify({ repair, winEnv }),
  );
  const cleanEnv = { Path: "C:\\WINDOWS\\system32" };
  record("A 沒有可展開的參照 → undefined、不動", repairWindowsPath(cleanEnv, "win32") === undefined && cleanEnv.Path === "C:\\WINDOWS\\system32");
  const linuxEnv = { PATH: "%SystemRoot%/bin", SystemRoot: "/x" };
  record("A 非 Windows 不動", repairWindowsPath(linuxEnv, "linux") === undefined && linuxEnv.PATH === "%SystemRoot%/bin");
}

// ---- B. 壞掉的 PATH 下,core 仍偵測得到 CLI ---------------------------------

if (process.platform !== "win32") {
  console.log("\nSKIP B:只在 Windows 上有意義(REG_SZ 的 Path 是 Windows 特有的問題)");
} else {
  const dirs = {
    home: mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-winpath-home-")),
    data: mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-winpath-data-")),
    ws: mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-winpath-ws-")),
    bin: mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-winpath-bin-")),
  };
  writeFileSync(path.join(dirs.bin, "claude.cmd"), `@echo ${FAKE_VERSION}\r\n`);

  const port = await allocatePort();
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.toLowerCase() === "path" || key.startsWith("DESKMONY_")) continue;
    env[key] = value;
  }
  // Explorer 給的鍵名是 `Path`;值照 REG_SZ 機器上的樣子,完全沒有展開過的 System32。
  env.Path = "%SystemRoot%\\system32;%SystemRoot%;%DESKMONY_E2E_FAKE_BIN%";
  env.DESKMONY_E2E_FAKE_BIN = dirs.bin;
  env.DESKMONY_HOME = dirs.home;
  env.DESKMONY_DATA_DIR = dirs.data;
  env.DESKMONY_WORKSPACE = dirs.ws;
  env.DESKMONY_CORE_PORT = String(port);
  env.DESKMONY_AUTH_TOKEN = TOKEN;

  const proc = spawn(process.execPath, [CORE_ENTRY], { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  guardCorePort(proc, port);
  let output = "";
  for (const stream of [proc.stdout, proc.stderr]) {
    stream.on("data", (chunk) => {
      output += chunk.toString();
      process.stdout.write(`[core] ${chunk}`);
    });
  }

  /** CLI 用正常的環境跑(它只是 gateway client,不受這個問題影響)。 */
  function doctor() {
    return new Promise((resolve) => {
      execFile(
        process.execPath,
        [CLI_ENTRY, "doctor", "--json", "--url", `ws://127.0.0.1:${port}`, "--token", TOKEN],
        { timeout: 45_000 },
        (_err, stdout) => {
          try {
            resolve(JSON.parse(stdout));
          } catch {
            resolve(undefined);
          }
        },
      );
    });
  }

  let report;
  const deadline = Date.now() + DETECT_DEADLINE_MS;
  while (Date.now() < deadline && proc.exitCode === null) {
    report = await doctor();
    if (report?.connected && report.agents) break;
    await sleep(500);
  }

  try {
    record("B core 起得來、doctor 連得上", Boolean(report?.connected && report.agents), JSON.stringify(report)?.slice(0, 300));
    const claude = report?.agents?.find((a) => a.key === "claude-code-cli");
    record(
      "B 壞掉的 PATH 下仍偵測到 claude-code-cli",
      claude?.installed === true &&
        typeof claude.path === "string" &&
        sameDir(path.dirname(claude.path), dirs.bin) &&
        claude.version === FAKE_VERSION,
      JSON.stringify(claude),
    );
    record("B core 印出已自動展開的警告", output.includes("已自動展開"));
  } finally {
    proc.kill();
    await new Promise((resolve) => (proc.exitCode !== null ? resolve() : proc.once("close", resolve)));
    for (const dir of Object.values(dirs)) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n總結:${results.length - failed.length}/${results.length} 通過`);
process.exit(failed.length === 0 ? 0 : 1);
