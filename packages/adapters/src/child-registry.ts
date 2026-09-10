import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * 2026-09-04(稽核修補):跨 core 重啟的孤兒子程序回收。
 *
 * ---- 要解的問題 --------------------------------------------------------
 *
 * `apps/core/src/index.ts` 的優雅關機路徑寫得很仔細(gateway 先關 → 逐一
 * dispose + 5 秒逾時 → exit),但它的前提是 **core 的 JS 有機會執行**。
 * SIGKILL(任何 OS 都攔不到)、Windows 工作管理員「結束工作」、OOM、斷電、
 * 或 core 自己的一次崩潰 —— 全都跳過它。
 *
 * 而 spawn 出來的 agent 子程序(以及它們自己再開的 MCP 孫程序)沒有任何
 * OS 層級的連坐回收單位,於是全部變成真正的孤兒:繼續吃 CPU/記憶體、繼續
 * 佔住 worktree 目錄,直到使用者自己用工作管理員一個一個砍。
 *
 * ---- 為什麼不用「正統」做法 ---------------------------------------------
 *
 * - **Windows Job Object**(`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`)是這題的正解,
 *   但 Node 沒有內建繫結,要多一個原生相依 —— 而這個專案刻意避免要求打包機器
 *   具備 MSVC 工具鏈(見 `scripts/bundle-core.mjs` 對 `node-pty` 不重編的說明)。
 * - **POSIX `detached: true` + process group kill** 幫不上忙:父程序被 SIGKILL
 *   時一樣不會有人去 kill 那個 group。真正對應的是 Linux 專屬的
 *   `prctl(PR_SET_PDEATHSIG)`,不可攜。
 *
 * ---- 這裡的做法 --------------------------------------------------------
 *
 * 把「當下殺掉」換成「**下次啟動時回收**」:spawn 時把 pid 連同它的建立時間
 * 記到磁碟,正常 dispose 時移除;core 下次啟動時讀這份清單,把還活著的殺掉。
 *
 * 這不消除孤兒存在的視窗(core 死到下次啟動之間它們仍在跑),但把「永遠洩漏」
 * 變成「有界」—— 在拿不到 Job Object 的前提下,這是誠實能做到的最好程度。
 *
 * ---- PID 重用的防護(這是本模組最重要的部分)----------------------------
 *
 * pid 會被作業系統重用。若只憑 pid 就下手,core 崩潰後隔一天才重開,那個 pid
 * 很可能已經是**使用者自己的某個程式** —— 殺錯一個無關行程,比洩漏一個孤兒
 * 嚴重得多。
 *
 * 所以每筆紀錄都存下該行程的**建立時間**,回收前重新查詢當下該 pid 的建立時間,
 * **兩者一致才殺**。查不到、對不上、或平台不支援查詢時,一律**不殺**,只印一行
 * 讓使用者知道有殘留可以自己清理。fail-safe 方向:寧可漏殺,不可誤殺。
 */

interface RegisteredChild {
  pid: number;
  /** 該行程的建立時間(epoch ms)。見檔案頂端「PID 重用的防護」。 */
  createdAt: number;
  /** 只為了讓使用者看 log 時知道這是什麼,不參與判斷。 */
  label: string;
}

let registryPath: string | undefined;
let entries: RegisteredChild[] = [];

/**
 * 由 `apps/core/src/index.ts` 在啟動時呼叫一次,指定紀錄檔位置
 * (`<dataDir>/child-pids.json`)。未呼叫時本模組的所有函式都是 no-op ——
 * e2e 與單元測試不需要為了這個機制額外準備環境。
 */
export function initChildRegistry(dataDir: string): void {
  try {
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    registryPath = path.join(dataDir, "child-pids.json");
    entries = readRegistry();
  } catch (err) {
    console.warn(`[child-registry] 初始化失敗,孤兒回收功能停用(不影響其他功能): ${String(err)}`);
    registryPath = undefined;
  }
}

function readRegistry(): RegisteredChild[] {
  if (!registryPath || !existsSync(registryPath)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(registryPath, "utf8"));
    return Array.isArray(parsed) ? (parsed as RegisteredChild[]) : [];
  } catch {
    // 檔案壞掉不是致命問題 —— 當作沒有殘留紀錄,重新開始。
    return [];
  }
}

function flush(): void {
  if (!registryPath) return;
  try {
    writeFileSync(registryPath, JSON.stringify(entries), "utf8");
  } catch (err) {
    console.warn(`[child-registry] 寫入失敗(孤兒回收可能不完整): ${String(err)}`);
  }
}

/**
 * 查詢某個 pid 目前的建立時間(epoch ms);查不到 / 平台不支援回 `undefined`。
 *
 * Windows 用 PowerShell 的 CIM 查詢(`wmic` 已被 Microsoft 標為淘汰)。
 * POSIX 用 `ps -o lstart=`。兩者都是唯讀查詢,不會有副作用。
 */
function queryProcessCreatedAt(pid: number): number | undefined {
  try {
    if (process.platform === "win32") {
      const out = spawnSync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" -ErrorAction SilentlyContinue; ` +
            "if ($p) { [int64]([DateTimeOffset]$p.CreationDate).ToUnixTimeMilliseconds() }",
        ],
        { encoding: "utf8", timeout: 5_000 },
      );
      const value = Number((out.stdout ?? "").trim());
      return Number.isFinite(value) && value > 0 ? value : undefined;
    }
    const out = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 5_000 });
    const text = (out.stdout ?? "").trim();
    if (!text) return undefined;
    const ms = Date.parse(text);
    return Number.isFinite(ms) ? ms : undefined;
  } catch {
    return undefined;
  }
}

/** spawn 之後立刻呼叫。`pid` 為 undefined(spawn 失敗)時直接忽略。 */
export function registerChild(pid: number | undefined, label: string): void {
  if (!registryPath || pid === undefined) return;
  const createdAt = queryProcessCreatedAt(pid);
  if (createdAt === undefined) {
    // 查不到建立時間就不記 —— 記了也無法在回收時安全驗證,只會變成一筆
    // 永遠不敢動的紀錄。
    return;
  }
  entries = entries.filter((e) => e.pid !== pid);
  entries.push({ pid, createdAt, label });
  flush();
}

/** 正常 dispose 之後呼叫 —— 這個子程序已經被好好收掉,不需要下次回收。 */
export function unregisterChild(pid: number | undefined): void {
  if (!registryPath || pid === undefined) return;
  const before = entries.length;
  entries = entries.filter((e) => e.pid !== pid);
  if (entries.length !== before) flush();
}

/**
 * core 啟動時呼叫一次:把上一輪沒被乾淨收掉、而且**確認仍是同一個行程**的
 * 子程序殺掉。回傳這次實際殺掉的數量與跳過的數量(供啟動 log 使用)。
 */
export function reapOrphans(): { killed: number; skipped: number } {
  if (!registryPath) return { killed: 0, skipped: 0 };
  const leftovers = entries;
  entries = [];
  flush();

  let killed = 0;
  let skipped = 0;
  for (const entry of leftovers) {
    const currentCreatedAt = queryProcessCreatedAt(entry.pid);
    if (currentCreatedAt === undefined) {
      // 行程已經不在了 —— 正常情況(使用者自己關掉、或 OS 已回收)。
      continue;
    }
    // 允許 2 秒誤差:不同來源對建立時間的精度不一致(Windows CIM 到毫秒,
    // POSIX `ps lstart` 只到秒)。
    if (Math.abs(currentCreatedAt - entry.createdAt) > 2_000) {
      skipped += 1;
      console.warn(
        `[child-registry] pid ${entry.pid}(${entry.label})目前存在,但建立時間對不上 —— ` +
          "判定為 pid 重用,**不殺**。若你發現有殘留的 agent 行程,請手動確認。",
      );
      continue;
    }
    try {
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/pid", String(entry.pid), "/T", "/F"], { stdio: "ignore" });
      } else {
        process.kill(entry.pid, "SIGTERM");
      }
      killed += 1;
      console.warn(
        `[child-registry] 回收上一輪殘留的 agent 子程序 pid ${entry.pid}(${entry.label})—— ` +
          "代表 core 上次不是乾淨關閉的(崩潰 / 被強制終止 / 斷電)。",
      );
    } catch (err) {
      skipped += 1;
      console.warn(`[child-registry] 回收 pid ${entry.pid} 失敗(略過): ${String(err)}`);
    }
  }
  return { killed, skipped };
}
