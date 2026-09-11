#!/usr/bin/env node
/**
 * scripts/e2e-cli-tui.mjs
 *
 * 2026-09-11:全螢幕 TUI(`deskmony tui`)的決定性 e2e —— 對應
 * docs/LAYER-3-hld/cli-tui_hld.md §10.1 的九個項目。
 *
 * ---- 這支跟其餘 e2e 有什麼不同 ----------------------------------------
 *
 * 其餘測試都是「用 WS client 對 gateway 送 request」或「跑 CLI 子程序看
 * stdout」。這支不一樣:TUI 只有在**真的 TTY** 底下才會啟動(沒有 TTY 時
 * `deskmony tui` 會直接拒絕,見 apps/cli/src/commands/tui.ts),所以它必須
 * 透過 `node-pty` 開一個真的偽終端(Windows 上就是 ConPTY)來驅動,再對
 * 終端機**輸出的位元組**做斷言。
 *
 * `node-pty` 不是為了這支測試新加的相依 —— 它本來就是 packages/adapters
 * 的相依(GenericPtyAdapter 用它跑任意互動式 CLI),這裡只是把同一個套件
 * 拿來當測試工具。
 *
 * ---- ⚠ 寫斷言前必讀:不要把 ANSI 濾掉再比對 --------------------------
 *
 * cli-tui_hld.md §10.1 有一整段警告,是驗收 T1 時連續踩三次假失敗換來的:
 *
 *   1. 「方向鍵沒作用」—— 當時只有零個 session,按 ↓ 本來就不該有變化,
 *      ink 做完差異比對後不送任何位元組,那是**正確**行為。所以下面案例 2
 *      一定先建好兩個 session 才測導航。
 *   2. 「沒有選取指標」—— 指標 `▸` 是用反白呈現(`ESC[7m▸ESC[27m`),把
 *      ANSI 濾掉就一起濾掉了。
 *   3. 「狀態列只有 65 欄、兩半擠在一起」—— ink **不是用空格補間隔**,而是
 *      `ESC[35X`(ECH,清除 35 格)加 `ESC[35C`(CUF,游標右移 35 欄)。
 *      把游標移動濾掉,35 欄的間隔就憑空消失,於是得到「版面壞掉」的錯誤
 *      結論。實際版面是滿版、正確的。
 *
 * 結論:**游標移動序列與 ECH 本身就是版面資訊,不是雜訊。** 這支測試因此
 * 一律只斷言「某段文字有沒有出現在輸出裡」這種不依賴欄位位置的性質,
 * 絕不從濾掉 ANSI 之後的字串去推論寬度或對齊。要驗對齊只能靠人眼,見
 * §10.2(那一節明講哪些項目不進自動化)。
 *
 * 但「不濾 ANSI」也有它自己的陷阱,寫這支測試時當場又踩到一次(第四次):
 * ink 會把標題之類的東西用 SGR 包起來,例如 Transcript 標頭的原始位元組是
 * `ESC[1mTUI-BBB ESC[22m · acp · ○ idle` —— 於是 `"TUI-BBB · acp"` 這個看
 * 起來理所當然的字串**根本不連續**,直接 `includes()` 一定找不到。
 *
 * 正確的分辨方式是把兩種序列分開看:
 *   - **游標移動(CUF/CUP)、ECH** → 版面資訊,濾掉就會得出錯誤的寬度結論。
 *   - **SGR(`ESC[…m`,粗體/顏色/反白)** → 純樣式,對「這段文字在不在」
 *     沒有任何影響,濾掉是安全的,而且是必要的。
 * 所以下面的 `stripStyleOnly()`(見 helper 區)**只**濾 SGR,其餘一律保留。
 *
 * ---- port 配置 --------------------------------------------------------
 *
 * 既有套件用掉的 port(`grep -hoE "[0-9]{4}" scripts/*.mjs` 過一輪):
 * 4317-4389、4700-4713(agent-lifecycle/lead-gate)、4720-4721(e2e-cli)、
 * 5321、9999。4730 以上整段是空的,這裡取 4730 一個就夠 —— strong 權限
 * 請求不需要第二個 core,只要讓寫入目標落在 session workingDir **之外**
 * 就會命中 hard-deny 的 worktree-escape 類別。
 *
 * 用法:node scripts/e2e-cli-tui.mjs
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync as fsReadFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WRITE_FILE_PREFIX } from "./fake-acp-agent.mjs";
import { requireFreshBuild } from "./lib/require-fresh-build.mjs";

requireFreshBuild();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const FAKE_AGENT_PATH = path.join(REPO_ROOT, "scripts", "fake-acp-agent.mjs");
const CORE_ENTRY = path.join(REPO_ROOT, "apps", "core", "dist", "index.js");
const CLI_ENTRY = path.join(REPO_ROOT, "apps", "cli", "dist", "bin.js");
const NODE_PTY_ENTRY = path.join(REPO_ROOT, "node_modules", "node-pty", "lib", "index.js");

/** 見檔頭「port 配置」。 */
const PORT_TUI = 4730;
const URL_TUI = `ws://127.0.0.1:${PORT_TUI}`;

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`\n${ok ? "PASS" : "FAIL"} ${name}`);
  if (detail) console.log(`       ${detail}`);
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 只濾掉 SGR(`ESC[…m`:粗體/顏色/反白),游標移動與 ECH 一律保留 ——
 * 完整理由見檔頭「寫斷言前必讀」。所有「這段文字在不在」的斷言都要先過
 * 這一層,否則 ink 夾在文字中間的樣式碼會讓連續的字串變成不連續。
 */
const SGR_PATTERN = /\x1b\[[0-9;]*m/g;
function stripStyleOnly(text) {
  return text.replace(SGR_PATTERN, "");
}

// =======================================================================
// 以下四個 helper 逐字沿用 scripts/e2e-cli.mjs(它又沿用
// e2e-agent-lifecycle.mjs)—— 已經被其他七支測試驗證過的手法,不另外發明。
// =======================================================================
class MiniGatewayClient {
  constructor(url, token) {
    this.url = url;
    this.token = token;
    this.pendingRpc = new Map();
    /** 這支測試需要 `permission-request` 的 requestId(案例 8 要從**第二個
     *  獨立 client** 之外的角度確認佇列內容),所以比 e2e-cli 的版本多收
     *  session-event 推播。 */
    this.sessionEvents = [];
  }

  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`WS connect timeout (${this.url})`)), 10_000);
      this.ws.addEventListener("open", () => {
        clearTimeout(t);
        resolve();
      });
      this.ws.addEventListener("error", (e) => {
        clearTimeout(t);
        reject(new Error(`WS error (${this.url}): ${e.message ?? e}`));
      });
    });
    this.ws.addEventListener("message", (e) => this._handleMessage(e.data));
    if (this.token !== undefined) {
      await this.rpc("auth", { token: this.token });
    }
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
  }

  _handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : raw.toString());
    } catch {
      return;
    }
    if (msg.kind === "response") {
      const pending = this.pendingRpc.get(msg.id);
      if (pending) {
        this.pendingRpc.delete(msg.id);
        if (msg.ok) pending.resolve(msg.result);
        else pending.reject(new Error(msg.error ?? "unknown gateway error"));
      }
      return;
    }
    if (msg.kind === "event" && msg.channel === "session-event") {
      this.sessionEvents.push(msg.payload);
    }
  }

  rpc(method, params, timeoutMs = 30_000) {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pendingRpc.delete(id);
        reject(new Error(`rpc ${method} 逾時 (${timeoutMs}ms)`));
      }, timeoutMs);
      this.pendingRpc.set(id, {
        resolve: (v) => {
          clearTimeout(t);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(t);
          reject(e);
        },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

function startCore({ port, dataDir, homeDir, workspaceDir }) {
  const env = {
    ...process.env,
    DESKMONY_CORE_PORT: String(port),
    DESKMONY_DATA_DIR: dataDir,
    DESKMONY_HOME: homeDir,
    DESKMONY_WORKSPACE: workspaceDir,
  };
  const proc = spawn(process.execPath, [CORE_ENTRY], { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  proc.stdout.on("data", (chunk) => process.stdout.write(`[core:${port}] ${chunk}`));
  proc.stderr.on("data", (chunk) => process.stderr.write(`[core:${port}:err] ${chunk}`));
  return proc;
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
      return true;
    } catch (err) {
      lastErr = err;
      await sleep(300);
    }
  }
  throw new Error(`等待 gateway 啟動逾時: ${lastErr}`);
}

async function killProcessTreeHard(proc) {
  if (!proc || proc.exitCode !== null || proc.killed) return;
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

function rmDirs(dirs) {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

async function createAcpProfile(client, name, workingDir) {
  const { profile } = await client.rpc("profile.create", {
    name,
    software: "acp",
    workingDir,
    acpConfig: { command: process.execPath, args: [FAKE_AGENT_PATH] },
    permissionLevel: "always-ask",
  });
  return profile;
}

// =======================================================================
// TUI 驅動器 —— 這支測試唯一真正的「受測物件」入口。
// =======================================================================

/**
 * `node-pty` 的載入刻意用檔案路徑而不是裸 specifier:`node-pty` 是
 * packages/adapters 的相依,不是這個 repo 根目錄的;pnpm 的隔離式
 * node_modules 下,從 `scripts/` 直接 `import "node-pty"` 不保證解析得到。
 * 用 `node_modules/node-pty`(pnpm 為根目錄建立的 symlink,若存在)優先,
 * 找不到就退回去 `.pnpm` 底下實際的安裝位置。
 */
async function loadNodePty() {
  if (existsSync(NODE_PTY_ENTRY)) {
    return import(pathToFileURL(NODE_PTY_ENTRY).href);
  }
  const pnpmDir = path.join(REPO_ROOT, "node_modules", ".pnpm");
  const { readdirSync } = await import("node:fs");
  const candidates = readdirSync(pnpmDir).filter((n) => n.startsWith("node-pty@"));
  if (candidates.length === 0) throw new Error("找不到 node-pty —— 請先 pnpm install");
  const entry = path.join(pnpmDir, candidates[0], "node_modules", "node-pty", "lib", "index.js");
  return import(pathToFileURL(entry).href);
}

/**
 * 開一個真的 ConPTY 跑 `deskmony tui`,並累積它吐出來的所有位元組。
 *
 * `waitForOutput()` 是所有斷言的共同入口:它輪詢累積下來的原始輸出,
 * 找到就回傳 true、逾時回 false —— 刻意**不**對輸出做任何 ANSI 處理
 * (理由見檔頭)。
 */
class TuiDriver {
  constructor(pty, { cols = 100, rows = 30, url, cwd, env }) {
    this.all = "";
    this.exited = false;
    this.exitCode = null;
    this.term = pty.spawn(process.execPath, [CLI_ENTRY, "tui", "--url", url, "--cwd", cwd], {
      name: "xterm-256color",
      cols,
      rows,
      cwd: REPO_ROOT,
      env,
    });
    this.term.onData((chunk) => {
      this.all += chunk;
    });
    this.term.onExit((e) => {
      this.exited = true;
      this.exitCode = e?.exitCode ?? null;
    });
  }

  /** 清掉目前累積的輸出,讓接下來的斷言只看「這個動作之後」新畫出來的東西。 */
  mark() {
    this.since = this.all.length;
  }
  get sinceMark() {
    return this.all.slice(this.since ?? 0);
  }

  write(data) {
    this.term.write(data);
  }
  resize(cols, rows) {
    this.term.resize(cols, rows);
  }

  async waitForOutput(needle, timeoutMs = 15_000, { fromMark = false } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const haystack = stripStyleOnly(fromMark ? this.sinceMark : this.all);
      if (haystack.includes(needle)) return true;
      if (this.exited) break;
      await sleep(150);
    }
    return false;
  }

  async waitForExit(timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.exited) return true;
      await sleep(150);
    }
    return false;
  }

  async dispose() {
    // 已經自己退出的 ConPTY 再呼叫 kill(),node-pty 會去開一個內部的
    // conpty_console_list_agent 子行程,在沒有 console 的環境下丟
    // `AttachConsole failed`。已經退出就什麼都不用做。
    if (this.exited) return;
    try {
      this.term.kill();
    } catch {
      // ignore
    }
    await sleep(300);
  }
}

/** TUI 子程序的環境:比照 e2e-cli 的 `cleanCliEnv()`,把開發者終端機裡可能
 *  殘留的 `DESKMONY_*` 拔掉,讓結果不受執行機器的環境影響。 */
const STRIPPED_ENV_KEYS = [
  "DESKMONY_URL",
  "DESKMONY_AUTH_TOKEN",
  "DESKMONY_CORE_PORT",
  "DESKMONY_BIND_HOST",
  "DESKMONY_DATA_DIR",
  "DESKMONY_HOME",
  "DESKMONY_WORKSPACE",
  "NO_COLOR",
];
function cleanCliEnv() {
  const env = { ...process.env };
  for (const key of STRIPPED_ENV_KEYS) delete env[key];
  return env;
}

// =======================================================================
// 案例 9(§10.1 第 8 項):純函式檢查 —— 不啟動 core、不開終端機。
// 這個 repo 沒有單元測試框架,直接在 e2e 裡寫斷言是既有慣例
// (見 scripts/e2e-hard-deny.mjs 也是這樣測純邏輯的)。
// =======================================================================
async function testPureFunctions() {
  const keys = await import(pathToFileURL(path.join(REPO_ROOT, "apps/cli/dist/tui/keys.js")).href);

  // ---- §6.2:裸 Esc 與跳脫序列開頭無法區分,靠逾時分辨 ----------------
  // `createKeyDecoder` 提供可注入的 scheduler,所以這裡不需要真的等 30ms,
  // 直接手動觸發那個計時器 —— 決定性,不會因為機器慢而 flaky。
  {
    const fired = [];
    let pendingCb;
    const scheduler = {
      setTimeout: (cb) => {
        pendingCb = cb;
        return 1;
      },
      clearTimeout: () => {
        pendingCb = undefined;
      },
    };
    const dec = keys.createKeyDecoder((k) => fired.push(k.name), { scheduler });

    dec.feed(Buffer.from([0x1b])); // 裸 Esc
    const beforeTimer = fired.length;
    pendingCb?.(); // 逾時到了 —— 這時才該判定為 Esc
    const afterTimer = fired.slice();
    record(
      "案例 9a(§6.2):裸 Esc 要等逾時才判定,不會立刻送出",
      beforeTimer === 0 && afterTimer.includes("escape"),
      `逾時前送出 ${beforeTimer} 個鍵,逾時後=${JSON.stringify(afterTimer)}`,
    );
  }
  {
    const fired = [];
    const scheduler = { setTimeout: () => 1, clearTimeout: () => {} };
    const dec = keys.createKeyDecoder((k) => fired.push(k.name), { scheduler });
    dec.feed(Buffer.from([0x1b, 0x5b, 0x41])); // ESC [ A = ↑
    record(
      "案例 9b(§6.2):完整的方向鍵序列要被解析成 up,不是 escape",
      fired.length === 1 && fired[0] === "up",
      `解析結果=${JSON.stringify(fired)}`,
    );
  }

  // ---- §6.4:UTF-8 多位元組字元被 chunk 邊界切開 ----------------------
  // `中` = e4 b8 ad。分兩次餵進去,必須只吐出一個完整的字,不是兩個亂碼。
  {
    const chars = [];
    const scheduler = { setTimeout: () => 1, clearTimeout: () => {} };
    const dec = keys.createKeyDecoder((k) => {
      if (k.char) chars.push(k.char);
    }, { scheduler });
    dec.feed(Buffer.from([0xe4, 0xb8])); // 半個字
    const midway = chars.slice();
    dec.feed(Buffer.from([0xad])); // 補完
    record(
      "案例 9c(§6.4):UTF-8 字元跨 chunk 邊界要能正確組回來",
      midway.length === 0 && chars.join("") === "中",
      `半個字時送出 ${midway.length} 個字元,補完後=${JSON.stringify(chars.join(""))}`,
    );
  }

  // ---- §7.3:背景 session 的 delta 不得觸發重繪 -----------------------
  {
    const m = await import(pathToFileURL(path.join(REPO_ROOT, "apps/cli/dist/tui/model.js")).href);
    const model = m.createModel();
    const now = Date.now();
    m.replaceSessions(model, [
      { id: "s0", title: "焦點", agentProfileId: "p", adapterType: "acp", status: "idle", workingDir: "/tmp", createdAt: now, updatedAt: now },
      { id: "s1", title: "背景", agentProfileId: "p", adapterType: "acp", status: "busy", workingDir: "/tmp", createdAt: now, updatedAt: now },
    ]);
    model.selectedSessionId = "s0";
    model.dirty = false;

    let dirtyMarks = 0;
    const DELTAS = 200;
    for (let i = 0; i < DELTAS; i++) {
      m.applySessionEvent(model, {
        sessionId: "s1",
        timestamp: Date.now(),
        event: { type: "message-delta", messageId: "msg", role: "assistant", delta: "字", done: false },
      });
      if (model.dirty) {
        dirtyMarks++;
        model.dirty = false;
      }
    }
    const buffered = (model.sessions.get("s1")?.pendingAssistant?.text ?? "").length;
    record(
      "案例 9d(§7.3):背景 session 的 delta 完全不觸發重繪,但內容照樣進緩衝",
      dirtyMarks === 0 && buffered === DELTAS,
      `${DELTAS} 個背景 delta → 觸發重繪 ${dirtyMarks} 次(需為 0),緩衝長度 ${buffered}(需為 ${DELTAS})`,
    );

    // 對照組:同樣的 delta 若屬於焦點 session,就**必須**觸發重繪 ——
    // 否則「不重繪」會是因為壞掉,不是因為節流。
    model.selectedSessionId = "s1";
    model.dirty = false;
    m.applySessionEvent(model, {
      sessionId: "s1",
      timestamp: Date.now(),
      event: { type: "message-delta", messageId: "msg", role: "assistant", delta: "字", done: false },
    });
    record(
      "案例 9e(§7.3 對照組):焦點 session 的 delta 仍然要觸發重繪",
      model.dirty === true,
      `dirty=${model.dirty}(需為 true —— 若這裡也是 false,代表節流把該畫的也擋掉了)`,
    );
  }
}

// =======================================================================
// 案例 10(§10.1 第 9 項):ink/react 不得出現在 `--help` 的載入路徑上。
//
// HLD §5.2 的原文是「`deskmony run` 的啟動時間在加入 TUI 前後差異不超過
// 50ms」,但**用時間當斷言是錯的工具**,實測後改掉:
//
//   - 這台開發機上光是 `node -e ""` 就要 ~610ms(Windows 防毒掃描),
//     `deskmony --help` 約 1160ms。中間那 ~550ms 是 CLI 自己載入 zod /
//     @deskmony/shared / 各 command 模組的**固有成本**,跟 TUI 無關。
//   - 也就是說,一個時間門檻分辨不出「CLI 本來就重」與「ink 漏進來了」,
//     而且會隨硬體浮動 —— 放進 CI 就是一台 flake 製造機。
//
// 真正要守的不變量是「ink/react 不在非 TUI 指令的載入路徑上」,那是**靜態
// 可判定**的:從 `dist/bin.js` 出發走遍所有**靜態** import,沿途不得出現
// ink/react,且 `commands/tui.js` 只能用動態 `import()` 碰到 tui/。這個檢查
// 決定性、毫秒級、與硬體無關。時間數字仍然印出來當參考,但不當成敗判準。
// =======================================================================
function testInkNotOnHelpPath() {
  const { readFileSync } = require_fs();
  const distDir = path.join(REPO_ROOT, "apps", "cli", "dist");
  const visited = new Set();
  const offenders = [];

  /** 只抓**靜態** import/export …… from "x";動態 `import("x")` 刻意不算
   *  —— 那正是 §5.2 允許的載入方式。 */
  const STATIC_IMPORT = /(?:^|\n)\s*(?:import|export)[^;\n]*?from\s+["']([^"']+)["']/g;

  function walk(fileAbs, chain) {
    const rel = path.relative(distDir, fileAbs).split(path.sep).join("/");
    if (visited.has(rel)) return;
    visited.add(rel);
    let src;
    try {
      src = readFileSync(fileAbs, "utf8");
    } catch {
      return;
    }
    STATIC_IMPORT.lastIndex = 0;
    let m;
    while ((m = STATIC_IMPORT.exec(src)) !== null) {
      const spec = m[1];
      if (spec === "ink" || spec === "react" || spec.startsWith("ink/") || spec.startsWith("react/")) {
        offenders.push(`${rel} 靜態 import "${spec}"(路徑:${chain.join(" -> ")} -> ${rel})`);
        continue;
      }
      if (!spec.startsWith(".")) continue; // 其餘第三方套件不在這個檢查的範圍
      const next = path.resolve(path.dirname(fileAbs), spec);
      walk(next, [...chain, rel]);
    }
  }

  walk(path.join(distDir, "bin.js"), []);

  record(
    "案例 10(§5.2):從 bin.js 靜態可達的模組裡沒有 ink/react",
    offenders.length === 0,
    offenders.length === 0
      ? `走訪了 ${visited.size} 個模組,無一靜態 import ink/react`
      : offenders.join("; "),
  );

  // tui/ 的存在本身也要確認——若整個 tui 目錄根本沒被編譯出來,上面那條會
  // 「因為沒東西可查」而假通過。
  const tuiBuilt = existsSync(path.join(distDir, "tui", "app.js"));
  record("案例 10b:tui/ 確實有被編譯出來(確保上一條不是因為沒東西可查而通過)", tuiBuilt, `dist/tui/app.js 存在=${tuiBuilt}`);

  // 時間數字只印出來當參考,不當判準(理由見本節開頭)。
  const measure = (args) => {
    const runs = [];
    for (let i = 0; i < 5; i++) {
      const t0 = Date.now();
      spawnSync(process.execPath, args, { encoding: "utf8", timeout: 30_000, windowsHide: true });
      runs.push(Date.now() - t0);
    }
    runs.sort((a, b) => a - b);
    return runs[2];
  };
  const baseline = measure(["-e", ""]);
  const cliHelp = measure([CLI_ENTRY, "--help"]);
  console.log(`
       (參考數據,不列入成敗)node 基準 ${baseline}ms,deskmony --help ${cliHelp}ms,差 ${cliHelp - baseline}ms`);
}

/** `node:fs` 的同步讀取——這支檔案其餘地方用的是具名 import,這裡另外包一層
 *  只是為了讓上面那個函式讀起來不必把 readFileSync 拉到檔頭。 */
function require_fs() {
  return { readFileSync: fsReadFileSync };
}

// =======================================================================
// 案例 1-8:需要真的 core + 真的 ConPTY。
// =======================================================================
async function testTuiAgainstCore() {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-tui-data-"));
  const homeDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-tui-home-"));
  const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-tui-ws-"));
  /** 刻意建在 workspace **之外** —— 案例 8 要靠「寫到 workingDir 外面」
   *  命中 hard-deny 的 worktree-escape 類別,讓 PolicyEngine 把它降級成
   *  escalate-strong(條件:本機 + attended + 未開 auto,見
   *  apps/core/src/permissions/policy-engine.ts)。 */
  const outsideDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-e2e-tui-OUTSIDE-"));

  let core;
  let client;
  let tui;
  try {
    core = startCore({ port: PORT_TUI, dataDir, homeDir, workspaceDir });
    await waitForPort(URL_TUI, 20_000);
    client = new MiniGatewayClient(URL_TUI);
    await client.connect();

    const profile = await createAcpProfile(client, "tui-e2e", workspaceDir);
    // §10.1 陷阱:**一定要兩個以上的 session** 才測得了方向鍵導航 ——
    // 只有零個或一個時,ink 差異比對後不送任何位元組,那是正確行為,
    // 但天真的測試會把它讀成「方向鍵壞掉」。
    const sessionA = (await client.rpc("session.create", { agentProfileId: profile.id, workingDir: workspaceDir, title: "TUI-AAA" })).session;
    const sessionB = (await client.rpc("session.create", { agentProfileId: profile.id, workingDir: workspaceDir, title: "TUI-BBB" })).session;

    const pty = await loadNodePty();
    tui = new TuiDriver(pty, { url: URL_TUI, cwd: workspaceDir, env: cleanCliEnv() });

    // ---- 案例 1:版面畫得出來 ----------------------------------------
    const gotTitle = await tui.waitForOutput("Deskmony", 20_000);
    const gotSessions = await tui.waitForOutput("SESSIONS", 10_000);
    record("案例 1(§10.1-1):啟動後畫出版面(標題 + SESSIONS 窗格)", gotTitle && gotSessions, `Deskmony=${gotTitle} SESSIONS=${gotSessions}`);
    // **一定要等,不能快照。** session 清單是 TUI 連上 gateway 之後才非同步
    // 抓回來的(`session.list`),跟「畫面上出現 SESSIONS 這個字」沒有先後
    // 保證 —— 第一版寫成「等到 SESSIONS 出現就立刻檢查標題」,結果偶發失敗
    // (跑五次錯一次)。一個會偶發變紅的測試很快就會被所有人忽略,所以這裡
    // 改成對每個標題各自 `waitForOutput()`。
    const gotA = await tui.waitForOutput("TUI-AAA", 15_000);
    const gotB = await tui.waitForOutput("TUI-BBB", 15_000);
    record("案例 1b:兩個 session 都列在 Sessions 窗格", gotA && gotB, `AAA=${gotA} BBB=${gotB}`);

    // ---- 案例 2:方向鍵移動選取 --------------------------------------
    // 斷言方式:Transcript 窗格的標頭會顯示**目前選取的** session 標題,
    // 所以「↓ 之後輸出裡出現了另一個 session 的標頭」就是導航生效的證據。
    // 不去數欄位、不去找反白碼(見檔頭陷阱 2)。
    tui.mark();
    tui.write("\x1b[B");
    const moved = await tui.waitForOutput("TUI-BBB · acp", 8_000, { fromMark: true });
    record("案例 2(§10.1-2):↓ 讓選取移到下一個 session(Transcript 標頭跟著換)", moved, `↓ 之後輸出含 "TUI-BBB · acp" = ${moved}`);
    tui.mark();
    tui.write("\x1b[A");
    const movedBack = await tui.waitForOutput("TUI-AAA · acp", 8_000, { fromMark: true });
    record("案例 2b:↑ 讓選取移回上一個", movedBack, `↑ 之後輸出含 "TUI-AAA · acp" = ${movedBack}`);

    // ---- 案例 2c(§7.3):背景 busy session 不能看起來凍住 -------------
    // 這是 §7.3 能不能成立的前提。非焦點 session 的 delta 已經不再觸發重繪
    // (案例 9d 用純函式證明了),代價是:如果 Sessions 窗格也是靜態圖示,
    // 一個跑了三小時的背景 agent 與一個當掉的背景 agent 在畫面上完全一樣。
    // 補救是 theme.ts 的 spinner —— 這裡用「完全不送任何按鍵,純粹等一秒,
    // 看畫面有沒有自己動」來證明它真的在轉。
    //
    // 用 ACP_SLEEP_TURN 讓假 agent 維持 busy 一段夠長的時間,否則回合太快
    // 結束,status 一下就回 idle,就測不到 busy 狀態的呈現。
    await client.rpc("session.sendPrompt", {
      sessionId: sessionB.id,
      prompt: { text: `ACP_SLEEP_TURN ${JSON.stringify({ ms: 6000 })}` },
    });
    await sleep(1500); // 等 status 變成 busy 並畫出來
    tui.mark();
    await sleep(1200); // 期間**完全不送任何輸入**
    const idleWindow = tui.sinceMark;
    record(
      "案例 2c(§7.3):背景 session 在跑時,畫面會自己更新(spinner 有在轉,不是凍住)",
      idleWindow.length > 0,
      `1.2 秒內沒有任何輸入,終端仍收到 ${idleWindow.length} bytes 的重繪輸出(需 > 0)`,
    );
    await sleep(5500); // 等那一回合睡完,免得影響後面的案例

    // ---- 案例 3:尺寸退化 --------------------------------------------
    tui.mark();
    tui.resize(50, 12);
    const tooSmall = await tui.waitForOutput("終端機太小", 8_000, { fromMark: true });
    record("案例 3(§10.1-3):縮到 50×12 顯示「終端機太小」", tooSmall, `找到提示=${tooSmall}`);
    tui.mark();
    tui.resize(100, 30);
    const restored = await tui.waitForOutput("SESSIONS", 8_000, { fromMark: true });
    record("案例 3b:放大回 100×30 版面自動回來(不是報錯退出)", restored, `版面回復=${restored}`);

    // ---- 案例 4/5/6:一般權限請求 ------------------------------------
    const insideFile = path.join(workspaceDir, "tui-e2e-inside.txt");
    tui.mark();
    await client.rpc("session.sendPrompt", {
      sessionId: sessionB.id,
      prompt: { text: `${WRITE_FILE_PREFIX}${JSON.stringify({ path: insideFile, content: "hi" })}` },
    });
    const alerted = await tui.waitForOutput("待決權限請求", 20_000, { fromMark: true });
    record("案例 4(§10.1-4):權限請求讓 alert bar 顯示待決計數", alerted, `alert bar 出現=${alerted}`);

    tui.mark();
    tui.write("a");
    // §4.2 的紀律:彈窗顯示的必須是 `input` 裡的東西(檔案路徑),不是
    // `description`(cli_hld.md §13.3 查證過那只是 "Write file" 這種
    // 毫無資訊量的字串)。這裡斷言檔名有出現 —— 檔名只可能來自 input。
    const showsPath = await tui.waitForOutput("tui-e2e-inside.txt", 8_000, { fromMark: true });
    record("案例 5(§10.1-5):`a` 開啟彈窗,且顯示 input 裡的檔案路徑(不是只有 description)", showsPath, `輸出含檔名=${showsPath}`);

    tui.mark();
    tui.write("d");
    await sleep(2500);
    const denied = !existsSync(insideFile);
    const modalClosed = stripStyleOnly(tui.sinceMark).includes("SESSIONS");
    record("案例 6(§10.1-6):`d` 拒絕後檔案不落地,且彈窗關閉", denied && modalClosed, `檔案存在=${existsSync(insideFile)} 回到主畫面=${modalClosed}`);

    // ---- 案例 8:escalate-strong ------------------------------------
    const outsideFile = path.join(outsideDir, "tui-e2e-escape.txt");
    tui.mark();
    await client.rpc("session.sendPrompt", {
      sessionId: sessionA.id,
      prompt: { text: `${WRITE_FILE_PREFIX}${JSON.stringify({ path: outsideFile, content: "hi" })}` },
    });
    await tui.waitForOutput("待決權限請求", 20_000, { fromMark: true });
    tui.mark();
    tui.write("a");
    const strongShown = await tui.waitForOutput("高風險", 10_000, { fromMark: true });
    const strongScreen = stripStyleOnly(tui.sinceMark);
    record("案例 8(§10.1-8):寫到 workingDir 之外 → 彈窗用「高風險」樣式呈現", strongShown, `找到高風險標示=${strongShown}`);
    record("案例 8b:strong 畫面有 ⚠ 圖示(不只靠顏色區分)", strongScreen.includes("⚠"), `含 ⚠=${strongScreen.includes("⚠")}`);
    // 斷言的是**可按的按鍵**,不是「永遠允許」這四個字 —— 畫面上本來就有
    // 一句「不提供『永遠允許』」,用字串包含去判斷會把正確的文案誤判成失敗。
    const hasAlwaysAllowKey = /\[A\]\s*永遠允許/.test(strongScreen);
    record("案例 8c(§4.3):strong 不提供 `[A] 永遠允許` 按鍵", !hasAlwaysAllowKey, hasAlwaysAllowKey ? "!!! 竟然提供了 [A] 永遠允許" : "沒有 [A] 永遠允許(正確)");
    record("案例 8d(§4.3):strong 要求完整輸入 yes,不接受單鍵", strongScreen.includes("完整輸入"), `含「完整輸入」=${strongScreen.includes("完整輸入")}`);

    // 單按一個鍵不該核准。**這支測試從頭到尾不會輸入 yes** —— 那是一個
    // workspace 外的寫入,自動化測試沒有任何理由真的放行它。
    tui.write("a");
    await sleep(1500);
    record("案例 8e:單按一鍵不會核准 strong(檔案仍未落地)", !existsSync(outsideFile), `檔案存在=${existsSync(outsideFile)}`);
    tui.mark();
    tui.write("\x1b"); // Esc = 維持拒絕
    await sleep(2500);
    record("案例 8f:Esc 之後檔案仍未落地", !existsSync(outsideFile), `檔案存在=${existsSync(outsideFile)}`);

    // ---- 案例 7:離開時還原終端 --------------------------------------
    tui.write("\x03");
    await sleep(800);
    const aliveAfterFirst = !tui.exited;
    tui.write("\x03");
    const gone = await tui.waitForExit(10_000);
    record("案例 7(§10.1-7):第一次 Ctrl+C 不退出,第二次才退出", aliveAfterFirst && gone, `第一次後仍存活=${aliveAfterFirst} 第二次後退出=${gone}(code=${tui.exitCode})`);
    // 終端還原是這一整個案例的重點:崩潰或退出後若沒還原,使用者的終端機
    // 會留在 alternate screen、游標消失,那是最惹人厭的 bug。
    record(
      "案例 7b:退出時還原終端(離開 alt screen + 顯示游標)",
      tui.all.includes("\x1b[?1049l") && tui.all.includes("\x1b[?25h"),
      `ESC[?1049l=${tui.all.includes("\x1b[?1049l")} ESC[?25h=${tui.all.includes("\x1b[?25h")}`,
    );
  } finally {
    await tui?.dispose();
    client?.close();
    await killProcessTreeHard(core);
    await sleep(500);
    rmDirs([dataDir, homeDir, workspaceDir, outsideDir]);
  }
}

// =======================================================================
async function main() {
  console.log("=== CLI TUI e2e(cli-tui_hld.md §10.1)===");
  await testPureFunctions();
  testInkNotOnHelpPath();
  await testTuiAgainstCore();

  const passed = results.filter((r) => r.ok).length;
  // 格式刻意對齊 scripts/run-e2e.mjs 的 `extractCounts()`(它抓「總結:N/M」)
  // —— 不照這個格式寫,總跑器印出來的「共 N/M 個斷言」會**安靜地少算**這
  // 一整支,而那正是這個 repo 最不該有的那種空洞回報:看起來全綠,實際上
  // 有二十幾條斷言根本沒被計入。
  console.log(`\n\n========== 總結:${passed}/${results.length} 通過 ==========`);
  for (const r of results.filter((x) => !x.ok)) console.log(`  FAIL: ${r.name}`);
  // **一定要 process.exit()**,不能只設 process.exitCode:node-pty 的 ConPTY
  // handle 在子程序結束後仍然撐著 event loop,只設 exitCode 的話這支測試會
  // 把每一項都跑完、印完總結,然後永遠不結束——在 CI 上就是一路掛到 job
  // 逾時。e2e-cli.mjs 也是這樣收尾的(它沒用 pty,但同樣明確 exit)。
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((err) => {
  console.error("e2e-cli-tui 執行失敗:", err);
  process.exitCode = 1;
});
