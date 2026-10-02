#!/usr/bin/env node
/**
 * scripts/e2e-child-registry.mjs
 *
 * 2026-09-17:`packages/adapters/src/child-registry.ts`(跨 core 重啟的孤兒行程
 * 回收)的回歸測試 —— 特別是「登記到的 pid 只是 shell wrapper」這個洞。
 *
 * ---- 為什麼這支必須存在 ------------------------------------------------
 *
 * 這個模組 2026-09-04 加入之後一直**沒有任何測試**,而它有兩個方向都很傷的失敗
 * 模式:漏殺(孤兒永遠沒人收)與誤殺(pid 重用時殺到使用者自己的程式)。
 *
 * 2026-09-17 在使用者機器上抓到漏殺的實例:opencode 全域安裝是 `.cmd` shim,
 * adapter 用 `shell: true` 啟動,登記到的 pid 是 `cmd.exe`;cmd.exe 先死之後,
 * 回收查不到它就跳過,底下真正的 `opencode.exe serve` 隔天還活著(每支
 * 300–600MB)。修正方式見 child-registry.ts 檔案頂端「登記到的 pid 只是 shell
 * wrapper」—— 這支測試同時守住修正本身,以及修正**不能**換來的誤殺。
 *
 * ---- 這支測的是什麼 ----------------------------------------------------
 *
 *  A. 純函式 `collectDescendants()`,用合成的行程快照。登記子孫時排除「父 pid 對得
 *     上但其實不是它開的」那幾條規則,真實行程沒辦法叫 OS 重用某個 pid 來測,只能這樣。
 *  B. 【這次的 bug】真實的 `.cmd` shim → 長壽 node 孫程序。只殺 cmd.exe,重現使用者
 *     機器上的狀態(孫程序還活著、父 pid 指向已不存在的 wrapper),再另開一個 node
 *     行程扮演「下次啟動的 core」跑 `reapOrphans()`,斷言孫程序被收掉。
 *  C. 【負向:pid 重用】紀錄裡的 pid 現在屬於另一個行程、建立時間對不上 —— 差一小時
 *     與只差 1 毫秒都算(Windows 已收緊為完全一致)—— 一個都不殺。
 *  D. 【負向:沒有子孫紀錄】升級前的舊紀錄檔 / core 在 agent 就緒前就死,只有 wrapper
 *     的紀錄:不殺孫程序,只印「疑似殘留」提示。
 *  E. 【崩潰當下整棵樹都還活著】wrapper 與子孫都在:對 wrapper 下 `taskkill /T` 之後,
 *     必須重查行程表才判斷下一筆,不能拿殺之前的快照去殺剛被我們自己釋放的 pid。
 *  F. 【dispose 路徑】`unregisterChild()` 整組移除;查詢途中被 unregister,子孫不會被
 *     寫回紀錄檔。
 *  G. 【adapter 接線】`OpenCodeAdapter` / `AcpAdapter` 經 `.cmd` shim spawn 之後,紀錄檔
 *     裡真的出現 wrapper 底下的行程;dispose 之後整組移除。
 *
 * B–G 需要 Windows(`.cmd`、CIM、`taskkill`);其他平台只跑 A,其餘印 SKIP 不計分。
 *
 * ---- 清理紀律 ----------------------------------------------------------
 *
 * 只清這支測試**自己開出來**的行程,而且清之前一樣先比對建立時間(pid 可能早就被
 * 回收、重用)—— 跟被測的模組守同一條規矩。絕不以程式名稱或指令列 blanket kill
 * 任何 node / core 行程:使用者常同時開著 Deskmony 桌面 app,它有合法的 core 在跑。
 * 最後一個斷言就是「測試開出來的行程全數清乾淨」。
 *
 * 用法:node scripts/e2e-child-registry.mjs
 * 前置需求:pnpm build 已跑過
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireFreshBuild } from "./lib/require-fresh-build.mjs";

requireFreshBuild();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const ADAPTERS_DIST = path.join(REPO_ROOT, "packages", "adapters", "dist");
/**
 * adapter 模組用相對路徑 `./child-registry.js` 匯入登記簿;這裡必須用**同一個 URL**
 * 匯入,才會拿到同一份模組狀態(ESM 以 URL 為快取鍵,多帶一個 query string 就會變成
 * 另一個實例 —— 那樣 G 會測到一份 adapter 根本沒寫進去的登記簿)。
 */
const REGISTRY_URL = pathToFileURL(path.join(ADAPTERS_DIST, "child-registry.js")).href;
const registry = await import(REGISTRY_URL);

const IS_WINDOWS = process.platform === "win32";

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
  if (detail) console.log(`       ${detail}`);
}
function skip(name, reason) {
  console.log(`SKIP ${name}`);
  console.log(`       ${reason}`);
}

// ===========================================================================
// 共用工具
// ===========================================================================

/** 整支測試的暫存根目錄。刻意含空白 —— 真實世界的 shim 路徑常常有空白,quoting 錯了要現形。 */
const TEMP_ROOT = mkdtempSync(path.join(os.tmpdir(), "deskmony e2e child-registry "));
let tempSeq = 0;
function tempDir(label) {
  const dir = path.join(TEMP_ROOT, `${++tempSeq}-${label}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 這支測試自己開出來的行程:`{ pid, createdAt, what }`。只有登記在這裡、且建立時間
 * 對得上的才會在最後被清掉(見檔案頂端「清理紀律」)。
 */
const ownProcesses = [];
function trackOwn(pid, createdAt, what) {
  if (!pid || !createdAt) return;
  if (!ownProcesses.some((p) => p.pid === pid && p.createdAt === createdAt)) {
    ownProcesses.push({ pid, createdAt, what });
  }
}

/**
 * 測試**直接** spawn 出來的行程(wrapper、C 的無辜行程)另外留著 ChildProcess 本身:
 * Node 在 exit 事件處理完之前一直握著行程 handle,這段期間那個 pid 不可能被重用,
 * 所以用 handle 清理(`child.kill()`)不需要再比對建立時間,也不怕建立時間沒查到。
 */
const ownChildren = [];
function trackOwnChild(child) {
  ownChildren.push(child);
  return child;
}

/**
 * 用 CIM 查一批 pid 的父 pid / 建立時間 / 名稱,格式與 child-registry.ts 的快照一致。
 * 查的是當下這個 pid 的**主人**,可能已經不是當初那個行程 —— 呼叫端自己比對建立時間。
 */
function queryProcesses(pids) {
  const unique = [...new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0))];
  if (unique.length === 0) return new Map();
  return queryWhere(unique.map((pid) => `ProcessId=${pid}`).join(" OR "));
}

/** 同上,但直接給 WQL 條件(例如 `ParentProcessId=123`)。 */
function queryWhere(filter) {
  const table = new Map();
  const command =
    `Get-CimInstance Win32_Process -Filter "${filter}" -ErrorAction SilentlyContinue | ForEach-Object { if ($_.CreationDate) { ` +
    '"{0}`t{1}`t{2}`t{3}" -f $_.ProcessId, $_.ParentProcessId, ' +
    "[int64]([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds(), $_.Name } }";
  const out = spawnSync("powershell", ["-NoProfile", "-Command", command], {
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
  });
  if (out.error || out.status !== 0) {
    throw new Error(`CIM 查詢失敗: ${out.error ?? out.stderr}`);
  }
  for (const line of out.stdout.split(/\r?\n/)) {
    const [pidText, ppidText, createdText, ...name] = line.split("\t");
    const pid = Number(pidText);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    table.set(pid, { pid, ppid: Number(ppidText), createdAt: Number(createdText), name: name.join("\t").trim() });
  }
  return table;
}

/**
 * 追蹤某個 wrapper 與它底下的直接子程序,供最後清理用。回傳 wrapper 的查詢結果。
 *
 * **不能靠被測模組寫的紀錄檔來追蹤**:被測模組壞掉時(例如子孫根本沒登記),清理會
 * 跟著漏掉,測試自己反而留下孤兒 —— 2026-09-17 做變異測試時真的發生過。所以一律用
 * 測試自己的 CIM 查詢。
 *
 * 除了 node 孫程序,測試用 `windowsHide: true` 啟動 cmd.exe 時,Windows 還會替它開
 * 一個 `conhost.exe`(父 pid 也是 cmd.exe),它會跟著孤兒 agent 一起活下來,一樣要清。
 */
function trackTreeOf(wrapperPid, what) {
  const rows = queryWhere(`ProcessId=${wrapperPid} OR ParentProcessId=${wrapperPid}`);
  const wrapper = rows.get(wrapperPid);
  if (!wrapper) return rows;
  trackOwn(wrapper.pid, wrapper.createdAt, `${what} wrapper`);
  for (const row of rows.values()) {
    if (row.ppid === wrapperPid && row.createdAt > wrapper.createdAt) trackOwn(row.pid, row.createdAt, `${what} ${row.name}`);
  }
  return rows;
}

/** 這個 pid 現在還是不是當初那個行程(建立時間完全一致)。 */
function isStillSame(pid, createdAt) {
  return queryProcesses([pid]).get(pid)?.createdAt === createdAt;
}

/** 等某個行程死透(pid 消失,或已經換了主人)。逾時回 false。 */
async function waitUntilGone(pid, createdAt, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let exists = true;
    try {
      process.kill(pid, 0);
    } catch {
      exists = false;
    }
    if (!exists || !isStillSame(pid, createdAt)) return true;
    await delay(300);
  }
  return false;
}

function readRegistryFile(dataDir) {
  const file = path.join(dataDir, "child-pids.json");
  if (!existsSync(file)) return [];
  return JSON.parse(readFileSync(file, "utf8"));
}

async function pollRegistryFile(dataDir, predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let last = readRegistryFile(dataDir);
  while (Date.now() < deadline) {
    last = readRegistryFile(dataDir);
    if (predicate(last)) return last;
    await delay(250);
  }
  return last;
}

/**
 * 另開一個全新的 node 行程,扮演「下次啟動的 core」:初始化登記簿、跑一次
 * `reapOrphans()`,把結果與它印出的所有 log 帶回來。
 *
 * 必須是另一個行程:真實情境裡回收發生在一個模組狀態全新的 core 裡,只讀得到磁碟
 * 上的紀錄檔;在測試自己的行程裡呼叫會共用記憶體裡的 `entries`,測不出紀錄檔格式
 * 的問題。用非同步 spawn,不讓測試自己的事件迴圈在回收期間卡住(不處理 exit 事件
 * 就不會關掉 wrapper 的行程 handle,跟真實「core 已經死了、沒人拿著 handle」不一樣)。
 */
const REAP_HELPER = path.join(TEMP_ROOT, "reap-once.mjs");
writeFileSync(
  REAP_HELPER,
  [
    "const [registryUrl, dataDir] = process.argv.slice(2);",
    "const registry = await import(registryUrl);",
    "registry.initChildRegistry(dataDir);",
    "const result = registry.reapOrphans();",
    "console.log(`REAP_RESULT ${JSON.stringify(result)}`);",
    "",
  ].join("\n"),
);
function reapInFreshProcess(dataDir) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [REAP_HELPER, REGISTRY_URL, dataDir], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk.toString()));
    child.stderr.on("data", (chunk) => (output += chunk.toString()));
    const timer = setTimeout(() => child.kill(), 120_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      const match = output.match(/REAP_RESULT (\{.*\})/);
      resolve({ code, output, result: match ? JSON.parse(match[1]) : undefined });
    });
  });
}

/**
 * 做一個 `.cmd` shim:它用 node 跑一支長壽腳本,腳本一啟動就印出自己的 pid。
 * 這就是 `opencode.cmd` 的形狀(cmd.exe → 真正的程式),只是真正的程式換成我們
 * 能精準辨認、精準清理的 node 腳本。
 */
function makeShim(label) {
  const dir = tempDir(label);
  const agentScript = path.join(dir, "long running agent.mjs");
  writeFileSync(agentScript, 'console.log(`AGENT_READY ${process.pid}`);\nsetInterval(() => {}, 1 << 30);\n');
  const shimPath = path.join(dir, "fake agent.cmd");
  writeFileSync(shimPath, `@echo off\r\n"${process.execPath}" "${agentScript}" %*\r\n`);
  return shimPath;
}

/**
 * 比照 acp-adapter.ts / opencode-adapter.ts 的 `resolveWindowsSpawnCommand()`:
 * `.cmd` 一律 `shell: true`,command 自己加引號。回傳 wrapper(cmd.exe)的 ChildProcess
 * 與「孫程序印出 pid」的 Promise。
 */
function spawnShim(shimPath) {
  const child = trackOwnChild(
    spawn(`"${shimPath}"`, ["serve", "--port", "0"], {
      stdio: ["ignore", "pipe", "ignore"],
      shell: true,
      windowsHide: true,
    }),
  );
  const agentPid = new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("等待 AGENT_READY 逾時")), 30_000);
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const match = buffer.match(/AGENT_READY (\d+)/);
      if (match) {
        clearTimeout(timer);
        // 孫程序繼承了這條 pipe;讀到 pid 之後就關掉我們這端,免得它讓測試行程
        // 在孫程序被殺之前都結束不了。
        child.stdout.destroy();
        resolve(Number(match[1]));
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`wrapper 在孫程序就緒前就結束了(code=${code})`));
    });
  });
  return { child, agentPid };
}

/** 只殺 cmd.exe 本身(TerminateProcess,不帶 /T)—— 使用者機器上觀察到的就是這個狀態。 */
async function killWrapperOnly(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill();
  await exited;
}

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} 逾時(${ms}ms)`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

// ===========================================================================
// A. 純函式 collectDescendants():合成快照
// ===========================================================================
console.log("\n=== A. collectDescendants():登記子孫時的 pid 重用防護(合成快照)===\n");

{
  const { collectDescendants } = registry;
  const T = 1_780_000_000_000;
  const QUERIED_AT = T + 60_000;
  const snapshotOf = (rows) => new Map(rows.map(([pid, ppid, createdAt, name]) => [pid, { pid, ppid, createdAt, name }]));
  const pidsOf = (list) => list.map((p) => p.pid).join(",");
  const ROOT = { pid: 100, createdAt: T };

  // 真實形狀:cmd.exe(根)→ node.exe(launcher)→ codex.exe,外加一個無關行程。
  const normal = snapshotOf([
    [100, 4, T, "cmd.exe"],
    [200, 100, T + 100, "node.exe"],
    [300, 200, T + 500, "codex.exe"],
    [400, 4, T + 50, "explorer.exe"],
  ]);
  const found = collectDescendants(normal, ROOT, QUERIED_AT);
  record(
    "A1: 正常的三層樹 —— 找到整條 wrapper → launcher → 真正的 agent,父一定排在子前面,不含無關行程",
    pidsOf(found) === "200,300",
    `找到 [${pidsOf(found)}](預期 [200,300])`,
  );

  // pid 100 以前的主人開過、至今還活著的行程:父 pid 也是 100,但比現在的根更早建立。
  // 它底下的行程即使建立時間晚於根,也不能順著它被收進來。
  const stale = snapshotOf([
    [100, 4, T, "cmd.exe"],
    [200, 100, T + 100, "node.exe"],
    [250, 100, T - 10_000, "previous-owner-child.exe"],
    [350, 250, T + 200, "grandchild-of-previous-owner.exe"],
  ]);
  const foundStale = collectDescendants(stale, ROOT, QUERIED_AT);
  record(
    "A2: 父 pid 對得上、但比根更早建立(pid 以前的主人留下的)—— 排除,它底下的行程也不會被順帶收進來",
    pidsOf(foundStale) === "200",
    `找到 [${pidsOf(foundStale)}](預期 [200])`,
  );

  const late = snapshotOf([
    [100, 4, T, "cmd.exe"],
    [200, 100, T + 100, "node.exe"],
    [260, 100, QUERIED_AT, "created-when-query-started.exe"],
    [270, 100, QUERIED_AT + 5, "created-during-query.exe"],
  ]);
  const foundLate = collectDescendants(late, ROOT, QUERIED_AT);
  record(
    "A3: 開始查詢之後才建立的行程 —— 身分無法跟著快照一起確認,排除(含剛好等於查詢起點)",
    pidsOf(foundLate) === "200",
    `找到 [${pidsOf(foundLate)}](預期 [200])`,
  );

  const reusedRoot = collectDescendants(normal, { pid: 100, createdAt: T - 1 }, QUERIED_AT);
  const missingRoot = collectDescendants(normal, { pid: 999, createdAt: T }, QUERIED_AT);
  record(
    "A4: 根的建立時間對不上(連差 1 毫秒)或根已不在快照裡 —— 一個都不收",
    reusedRoot.length === 0 && missingRoot.length === 0,
    `建立時間差 1ms → [${pidsOf(reusedRoot)}];根不在 → [${pidsOf(missingRoot)}](兩者都應為空)`,
  );

  const sameMs = snapshotOf([
    [100, 4, T, "cmd.exe"],
    [280, 100, T, "same-millisecond.exe"],
  ]);
  const foundSameMs = collectDescendants(sameMs, ROOT, QUERIED_AT);
  record(
    "A5: 與父行程同一毫秒建立 —— 無法證明先後,排除(寧可漏登記,不可誤登記)",
    foundSameMs.length === 0,
    `找到 [${pidsOf(foundSameMs)}](預期為空)`,
  );

  // pid 重用可以造出「A 的父是 B、B 的父是 A」這種資料;不能因此卡死。
  const cyclic = snapshotOf([
    [500, 600, T + 10, "a.exe"],
    [600, 500, T + 20, "b.exe"],
  ]);
  const foundCyclic = collectDescendants(cyclic, { pid: 500, createdAt: T + 10 }, QUERIED_AT);
  record(
    "A6: 環狀的父子資料(pid 重用造成)—— 正常結束,不會無限迴圈",
    pidsOf(foundCyclic) === "600",
    `找到 [${pidsOf(foundCyclic)}](預期 [600])`,
  );
}

// ===========================================================================
// B–G:真實行程(Windows)
// ===========================================================================

if (!IS_WINDOWS) {
  skip("B–G 真實行程測試", `平台為 ${process.platform}:shell wrapper 問題與這幾個情境只存在於 Windows(.cmd / CIM / taskkill)。`);
} else {
  try {
    await runWindowsCases();
  } catch (err) {
    record("B–G 執行過程沒有未預期的例外", false, err instanceof Error ? (err.stack ?? err.message) : String(err));
  } finally {
    await cleanupOwnProcesses();
  }
}

async function runWindowsCases() {
  // =========================================================================
  // B. 這次的 bug:wrapper 先死,孫程序要被回收
  // =========================================================================
  console.log("\n=== B. 只殺 cmd.exe wrapper 之後,下次啟動要回收底下真正的 agent ===\n");
  {
    const dataDir = tempDir("B-data");
    registry.initChildRegistry(dataDir);
    const shim = makeShim("B-shim");
    const { child, agentPid } = spawnShim(shim);
    registry.registerChild(child.pid, `e2e:${shim}`);
    const agent = await agentPid;
    trackTreeOf(child.pid, "B");
    await registry.registerChildDescendants(child.pid);

    const saved = readRegistryFile(dataDir);
    const wrapperEntry = saved.find((e) => e.pid === child.pid && e.rootPid === undefined);
    const agentEntry = saved.find((e) => e.pid === agent);
    const descendantEntries = saved.filter((e) => e.rootPid === child.pid);
    record(
      "B1: 登記 —— 除了 wrapper(cmd.exe)本身,底下真正的 agent 也有自己的一筆 pid + 建立時間,並指回所屬的根",
      Boolean(
        wrapperEntry &&
          agentEntry &&
          agentEntry.rootPid === child.pid &&
          agentEntry.rootCreatedAt === wrapperEntry.createdAt &&
          agentEntry.label.endsWith("node.exe"),
      ),
      `紀錄檔:${JSON.stringify(saved)}`,
    );

    await killWrapperOnly(child);
    const afterKill = queryProcesses([child.pid, agent]);
    record(
      "B2: 重現使用者機器上的狀態 —— 只殺 cmd.exe 之後,agent 仍活著,父 pid 指向已經不存在的 wrapper",
      afterKill.get(child.pid)?.createdAt !== wrapperEntry?.createdAt &&
        afterKill.get(agent)?.createdAt === agentEntry?.createdAt &&
        afterKill.get(agent)?.ppid === child.pid,
      `wrapper pid ${child.pid} 現況=${JSON.stringify(afterKill.get(child.pid) ?? null)};agent=${JSON.stringify(afterKill.get(agent) ?? null)}`,
    );

    const reap = await reapInFreshProcess(dataDir);
    const agentGone = agentEntry ? await waitUntilGone(agent, agentEntry.createdAt) : false;
    const survivors = [];
    for (const e of descendantEntries) {
      if (!(await waitUntilGone(e.pid, e.createdAt))) survivors.push(`${e.pid}(${e.label.split(" → ").pop()})`);
    }
    // killed 不寫死成 1:依啟動環境,wrapper 底下除了 agent 可能還有一個 conhost.exe
    // (見 trackTreeOf() 註解),它一樣是驗證過身分的孤兒,一起被收是對的。
    record(
      "B3: 回收 —— 下次啟動的 reapOrphans() 殺掉 wrapper 底下的 agent(以及同一棵樹裡其他登記過的孤兒);修正前會因為 wrapper 查不到而整筆跳過",
      reap.result !== undefined && reap.result.killed >= 1 && reap.result.skipped === 0 && agentGone && survivors.length === 0,
      `結果=${JSON.stringify(reap.result)}, agent 已結束=${agentGone}, ` +
        `登記的子孫=${descendantEntries.map((e) => e.label.split(" → ").pop()).join("+")}, 仍存活=${survivors.join(",") || "無"}`,
    );
    record(
      "B4: 回收之後紀錄檔清空(不會帶著已處理的紀錄進下一輪)",
      readRegistryFile(dataDir).length === 0,
      `紀錄檔:${JSON.stringify(readRegistryFile(dataDir))}`,
    );
  }

  // =========================================================================
  // C. 負向:pid 重用 —— 建立時間對不上就不殺
  // =========================================================================
  console.log("\n=== C. 負向:紀錄裡的 pid 已經屬於別的行程 ===\n");
  {
    const dataDir = tempDir("C-data");
    // 兩個「無辜」的長壽行程,扮演「pid 被重用之後的新主人」。
    const innocentA = trackOwnChild(
      spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], { stdio: "ignore", windowsHide: true }),
    );
    const innocentB = trackOwnChild(
      spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], { stdio: "ignore", windowsHide: true }),
    );
    await delay(300);
    const live = queryProcesses([innocentA.pid, innocentB.pid]);
    const aCreatedAt = live.get(innocentA.pid)?.createdAt;
    const bCreatedAt = live.get(innocentB.pid)?.createdAt;
    trackOwn(innocentA.pid, aCreatedAt, "C innocent A");
    trackOwn(innocentB.pid, bCreatedAt, "C innocent B");

    writeFileSync(
      path.join(dataDir, "child-pids.json"),
      JSON.stringify([
        { pid: innocentA.pid, createdAt: aCreatedAt - 3_600_000, label: "e2e:上一輪的根(建立時間差一小時)" },
        {
          pid: innocentB.pid,
          createdAt: bCreatedAt - 1,
          label: "e2e:上一輪的子孫(建立時間只差 1 毫秒)",
          rootPid: 4242,
          rootCreatedAt: bCreatedAt - 5_000,
        },
      ]),
    );
    const reap = await reapInFreshProcess(dataDir);
    const after = queryProcesses([innocentA.pid, innocentB.pid]);
    record(
      "C1: pid 重用 —— 建立時間差一小時、或只差 1 毫秒(Windows 要求完全一致),都一個不殺,兩筆都計入略過",
      reap.result?.killed === 0 &&
        reap.result?.skipped === 2 &&
        after.get(innocentA.pid)?.createdAt === aCreatedAt &&
        after.get(innocentB.pid)?.createdAt === bCreatedAt,
      `結果=${JSON.stringify(reap.result)}, A 仍在=${after.get(innocentA.pid)?.createdAt === aCreatedAt}, B 仍在=${after.get(innocentB.pid)?.createdAt === bCreatedAt}`,
    );
    record(
      "C2: 略過時有印出「判定為 pid 重用,不殺」讓使用者看得到",
      (reap.output.match(/判定為 pid 重用/g) ?? []).length === 2,
      reap.output.trim().split(/\r?\n/).slice(0, 4).join(" | "),
    );
  }

  // =========================================================================
  // D. 負向:只有 wrapper 的紀錄(舊版紀錄檔 / core 在就緒前就死)
  // =========================================================================
  console.log("\n=== D. 負向:沒有子孫紀錄時只提示、不殺 ===\n");
  {
    const dataDir = tempDir("D-data");
    registry.initChildRegistry(dataDir);
    const shim = makeShim("D-shim");
    const { child, agentPid } = spawnShim(shim);
    registry.registerChild(child.pid, `e2e:${shim}`);
    const agent = await agentPid;
    // 刻意**不**呼叫 registerChildDescendants():紀錄檔長得跟使用者機器上那份一模一樣。
    const agentCreatedAt = trackTreeOf(child.pid, "D").get(agent)?.createdAt;

    await killWrapperOnly(child);
    const reap = await reapInFreshProcess(dataDir);
    const stillAlive = isStillSame(agent, agentCreatedAt);
    record(
      "D1: 沒有子孫身分資料 —— 就算孫程序的父 pid 對得上、建立時間也吻合,仍然不殺(只憑推測不下手)",
      reap.result?.killed === 0 && stillAlive,
      `結果=${JSON.stringify(reap.result)}, 孫程序仍在=${stillAlive}`,
    );
    record(
      "D2: 但會印出「疑似殘留」提示,帶上孫程序的 pid,讓使用者知道要自己去確認",
      reap.output.includes(`疑似殘留:pid ${agent}`),
      reap.output.trim().split(/\r?\n/).find((l) => l.includes(`疑似殘留:pid ${agent}`)) ?? "(沒有針對孫程序的提示)",
    );
  }

  // =========================================================================
  // E. 崩潰當下 wrapper 與子孫都還活著
  // =========================================================================
  console.log("\n=== E. wrapper 還活著:taskkill /T 之後必須重查,不能拿舊快照殺下一筆 ===\n");
  {
    const dataDir = tempDir("E-data");
    registry.initChildRegistry(dataDir);
    const shim = makeShim("E-shim");
    const { child, agentPid } = spawnShim(shim);
    registry.registerChild(child.pid, `e2e:${shim}`);
    const agent = await agentPid;
    trackTreeOf(child.pid, "E");
    await registry.registerChildDescendants(child.pid);
    const saved = readRegistryFile(dataDir);
    const wrapperEntry = saved.find((e) => e.pid === child.pid && e.rootPid === undefined);
    const agentEntry = saved.find((e) => e.pid === agent);

    const reap = await reapInFreshProcess(dataDir);
    const wrapperGone = wrapperEntry ? await waitUntilGone(child.pid, wrapperEntry.createdAt) : false;
    const agentGone = agentEntry ? await waitUntilGone(agent, agentEntry.createdAt) : false;
    // killed 必須是 1:agent(以及可能有的 conhost.exe)已經被 wrapper 的 /T 一起帶走,
    // 重查後應該是「已不在」。若拿殺之前的舊快照判斷,它們會被當成還活著再殺一次
    // (killed > 1)—— 那幾刀砍的是剛被我們自己釋放、可能已經換了主人的 pid。
    record(
      "E1: 對 wrapper 下 taskkill /T 帶走整棵樹;下一筆(agent)重查後判定已不在,不會再砍一次",
      Boolean(agentEntry) && reap.result?.killed === 1 && wrapperGone && agentGone,
      `結果=${JSON.stringify(reap.result)}, wrapper 已結束=${wrapperGone}, agent 已結束=${agentGone}`,
    );
  }

  // =========================================================================
  // F. dispose 路徑
  // =========================================================================
  console.log("\n=== F. unregisterChild():整組移除,查詢途中被移除也不會寫回 ===\n");
  {
    const dataDir = tempDir("F-data");
    registry.initChildRegistry(dataDir);
    const shim = makeShim("F-shim");
    const { child, agentPid } = spawnShim(shim);
    registry.registerChild(child.pid, `e2e:${shim}`);
    const agent = await agentPid;
    trackTreeOf(child.pid, "F");
    await registry.registerChildDescendants(child.pid);
    const saved = readRegistryFile(dataDir);

    registry.unregisterChild(child.pid);
    const afterUnregister = readRegistryFile(dataDir);
    record(
      "F1: unregisterChild(wrapper) 連同登記在它底下的子孫一起移除",
      saved.some((e) => e.pid === child.pid) && saved.some((e) => e.pid === agent) && afterUnregister.length === 0,
      `移除前 ${saved.length} 筆(${saved.map((e) => (e.rootPid === undefined ? "wrapper" : e.label.split(" → ").pop())).join("+")}),移除後 ${JSON.stringify(afterUnregister)}`,
    );

    // 模擬 adapter 的 fire-and-forget:子孫查詢還在跑(要 1 秒多),dispose 就先 unregister 了。
    registry.registerChild(child.pid, `e2e:${shim}`);
    const inFlight = registry.registerChildDescendants(child.pid);
    registry.unregisterChild(child.pid);
    await inFlight;
    const afterRace = readRegistryFile(dataDir);
    record(
      "F2: 查詢途中被 unregister —— 查完之後不會把子孫寫回去(不留沒有根、永遠移除不掉的紀錄)",
      afterRace.length === 0,
      `紀錄檔:${JSON.stringify(afterRace)}`,
    );
  }

  // =========================================================================
  // G. adapter 接線
  // =========================================================================
  console.log("\n=== G. adapter 接線:經 .cmd shim spawn 之後,子孫真的有被登記 ===\n");
  {
    const { OpenCodeAdapter } = await import(pathToFileURL(path.join(ADAPTERS_DIST, "opencode-adapter.js")).href);
    const { AcpAdapter } = await import(pathToFileURL(path.join(ADAPTERS_DIST, "acp-adapter.js")).href);

    const cases = [
      {
        name: "OpenCodeAdapter",
        labelPrefix: "opencode:",
        backend: path.join(REPO_ROOT, "scripts", "fake-opencode-server.mjs"),
        adapter: new OpenCodeAdapter(),
        launchFor: (command) => ({ software: "opencode", opencodeConfig: { command } }),
      },
      {
        name: "AcpAdapter",
        labelPrefix: "acp:",
        backend: path.join(REPO_ROOT, "scripts", "fake-acp-agent.mjs"),
        adapter: new AcpAdapter(),
        launchFor: (command) => ({ software: "acp", acpConfig: { command, args: [] } }),
      },
    ];

    for (const c of cases) {
      const dataDir = tempDir(`G-${c.name}-data`);
      const workspaceDir = tempDir(`G-${c.name}-workspace`);
      const shimDir = tempDir(`G-${c.name}-shim`);
      const shimPath = path.join(shimDir, `fake ${c.name}.cmd`);
      writeFileSync(shimPath, `@echo off\r\n"${process.execPath}" "${c.backend}"\r\n`);
      registry.initChildRegistry(dataDir);

      // 2026-10-02(P2:移除 profile):`adapter.spawn()` 吃的是 `AgentLaunchSpec`(software + 各 adapter 的
      // *Config),不再是 AgentProfile。
      const launch = {
        providerId: `e2e-child-registry-${c.name}`,
        ...c.launchFor(shimPath),
      };

      let handle;
      try {
        handle = await withTimeout(c.adapter.spawn(launch, { path: workspaceDir }), 60_000, `${c.name}.spawn()`);
        // adapter 刻意不 await 子孫登記(見 adapter 內註解),這裡輪詢紀錄檔。
        const saved = await pollRegistryFile(dataDir, (list) => list.some((e) => e.rootPid !== undefined));
        const root = saved.find((e) => e.rootPid === undefined && e.label.startsWith(c.labelPrefix));
        const descendants = saved.filter((e) => root && e.rootPid === root.pid && e.rootCreatedAt === root.createdAt);
        if (root) trackTreeOf(root.pid, `G ${c.name}`);
        const backendProc = descendants.find((d) => d.label.endsWith("node.exe"));
        const live = backendProc ? queryProcesses([backendProc.pid]).get(backendProc.pid) : undefined;
        record(
          `G1(${c.name}): spawn 經 .cmd shim 完成後,紀錄檔裡有 wrapper 底下的假後端行程,且它此刻確實活著、父 pid 就是 wrapper`,
          Boolean(root && backendProc && live && live.createdAt === backendProc.createdAt && live.ppid === root.pid),
          `紀錄檔:${JSON.stringify(saved)}`,
        );

        await withTimeout(c.adapter.dispose(handle), 30_000, `${c.name}.dispose()`);
        handle = undefined;
        const afterDispose = readRegistryFile(dataDir);
        const backendGone = backendProc ? await waitUntilGone(backendProc.pid, backendProc.createdAt) : false;
        record(
          `G2(${c.name}): dispose() 之後整組紀錄(wrapper + 子孫)一起移除,假後端行程也確實結束`,
          afterDispose.length === 0 && backendGone,
          `紀錄檔:${JSON.stringify(afterDispose)}, 假後端已結束=${backendGone}`,
        );
      } catch (err) {
        record(`G(${c.name}): 執行過程沒有未預期的例外`, false, err instanceof Error ? (err.stack ?? err.message) : String(err));
      } finally {
        if (handle) {
          try {
            await withTimeout(c.adapter.dispose(handle), 30_000, `${c.name}.dispose()(清理)`);
          } catch {
            // 清理路徑:下面的 cleanupOwnProcesses() 會再按 pid + 建立時間補刀。
          }
        }
      }
    }
  }
}

/**
 * 清掉這支測試自己開出來、而且**建立時間仍然對得上**的行程(對不上代表 pid 早就
 * 換了主人,絕對不能碰)。逐一 `taskkill /F`,不帶 /T:要清的每一個都已經各自登記,
 * 不需要、也不應該順著父 pid 往下砍。
 */
async function cleanupOwnProcesses() {
  // 先用 handle 收掉直接子程序(見 trackOwnChild() 註解),等 exit 事件處理完。
  const running = ownChildren.filter((c) => c.exitCode === null && c.signalCode === null);
  await Promise.all(
    running.map(
      (c) =>
        new Promise((resolve) => {
          const timer = setTimeout(resolve, 10_000);
          c.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
          c.kill();
        }),
    ),
  );
  if (ownProcesses.length === 0) return;
  let live;
  try {
    live = queryProcesses(ownProcesses.map((p) => p.pid));
  } catch (err) {
    record("清理:測試自己開出來的行程全數結束", false, `查詢失敗,無法安全清理: ${String(err)}`);
    return;
  }
  const leftovers = ownProcesses.filter((p) => live.get(p.pid)?.createdAt === p.createdAt);
  for (const p of leftovers) {
    spawnSync("taskkill", ["/pid", String(p.pid), "/F"], { stdio: "ignore", windowsHide: true });
  }
  const stillAlive = [];
  for (const p of leftovers) {
    if (!(await waitUntilGone(p.pid, p.createdAt, 10_000))) stillAlive.push(p);
  }
  record(
    "清理:測試自己開出來的行程全數結束(只清建立時間對得上的,不碰其他任何行程)",
    stillAlive.length === 0,
    `追蹤 ${ownProcesses.length} 個,結束時仍存活需要補清 ${leftovers.length} 個` +
      (leftovers.length > 0 ? `(${leftovers.map((p) => `${p.what}=${p.pid}`).join(", ")})` : "") +
      (stillAlive.length > 0 ? `;清不掉:${stillAlive.map((p) => `${p.what}=${p.pid}`).join(", ")}` : ""),
  );
}

// ===========================================================================
try {
  rmSync(TEMP_ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
} catch {
  // 暫存目錄刪不掉不影響結果(可能有防毒軟體短暫鎖住)。
}

const failed = results.filter((r) => !r.ok);
console.log(`\n========== 總結:${results.length - failed.length}/${results.length} 通過 ==========`);
if (failed.length > 0) {
  for (const f of failed) console.log(`  FAIL: ${f.name}`);
}
process.exit(failed.length > 0 ? 1 : 0);
