import { spawn, spawnSync } from "node:child_process";
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
 *
 * ---- 2026-09-17 補充:登記到的 pid 只是 shell wrapper -----------------------
 *
 * Windows 上 opencode、gemini 這類全域安裝的 CLI 是 `.cmd` shim,
 * `opencode-adapter.ts`/`acp-adapter.ts` 必須用 `shell: true` 啟動,於是
 * `child.pid` —— 也就是 spawn 之後立刻登記的那個 pid —— 是 `cmd.exe`,不是
 * 真正的 agent。實測行程樹:
 *
 *     core(node) → cmd.exe(登記到的 pid)→ opencode.exe / node.exe(真正的 agent)
 *
 * 使用者機器上實際發生過:`child-pids.json` 裡只有 cmd.exe(pid 33664),它已經
 * 不在了,但父 pid 為 33664 的 `opencode.exe serve`(pid 26880,每支 300–600MB)
 * 隔天還活著。回收時查 33664 查不到,照「行程已經不在了」跳過 —— opencode.exe
 * 於是永遠沒人收。Windows 的 ParentProcessId 是**建立當下**記下的值,父程序死了
 * 也不會更新,所以它會一直指向一個已經不存在(甚至已被重用)的 pid。
 *
 * 不只 `.cmd`:`.ps1` 走 `powershell.exe -File`、codex-acp 是
 * node → node(launcher)→ codex.exe 三層(見 `codex-acp-locator.ts`)——
 * 都是「登記到的是外殼,真正吃資源的在底下」。只要外殼比 agent 先死,就是同一個洞。
 *
 * 評估過兩個做法:
 *
 * (a)【採用】agent **確認就緒之後**,把登記過的那個行程底下、當下已存在的整棵
 *     子孫樹也登記起來,每一個各自帶建立時間(`registerChildDescendants()`)。
 * (b)【不拿來殺,只拿來提示】回收時若登記的 pid 已經不在,找父 pid 等於它、
 *     建立時間落在它之後一小段時間內的行程。
 *
 * (b) 不能拿來殺,因為它判斷的是「**看起來像**當初那個 wrapper 開的」,不是
 * 「**確定是**」:wrapper 死掉之後 pid 可能被別的程式拿走,那個程式開出來的
 * 子程序一樣「父 pid = 這個 pid、建立時間在 wrapper 之後」。時間窗口只能讓這件事
 * 很不可能,不能讓它不可能 —— 它會是這個模組第一條不滿足「兩者一致才殺」的路徑。
 *
 * (a) 做得到**確定**:登記時 wrapper 還在,且快照裡它的建立時間與登記時完全一致,
 * 所以那一刻這個 pid 一定還是我們的 wrapper;再加上建立時間的先後關係,就能確定
 * 哪些行程是它開的(推導見 `collectDescendants()`)。登記下來之後,回收時每一筆
 * **仍然只看它自己的 pid + 建立時間** —— 跟原本的規則一字不差,沒有任何推測
 * 進到「殺不殺」的判斷裡。
 *
 * (a) 的缺口也要說清楚:core 若在「spawn 之後、agent 就緒之前」就死了(opencode
 * 最多等 15 秒,ACP 通常幾秒),子孫還沒登記,那個孤兒一樣收不到;升級前寫下的
 * 舊紀錄檔也沒有子孫資料。這兩種情況回收時用 (b) 的條件找出「疑似殘留」,但
 * **只印 log、不殺**(`reportUntrackedChildren()`)—— fail-safe 方向不變。
 */

interface RegisteredChild {
  pid: number;
  /** 該行程的建立時間(epoch ms)。見檔案頂端「PID 重用的防護」。 */
  createdAt: number;
  /** 只為了讓使用者看 log 時知道這是什麼,不參與判斷。 */
  label: string;
  /**
   * 2026-09-17:這筆是 `registerChildDescendants()` 登記的子孫時,記下它所屬的
   * 「根」(adapter 用 `registerChild()` 登記的那個行程)的 pid 與建立時間。
   *
   * 只有兩個用途:`unregisterChild()` 整組移除,以及回收時判斷某個根有沒有子孫
   * 資料(沒有才需要印「疑似殘留」提示)。**不參與「殺不殺」** —— 那永遠只看這筆
   * 自己的 `pid` + `createdAt`。升級前寫下的紀錄沒有這兩個欄位,一律視為根。
   */
  rootPid?: number;
  rootCreatedAt?: number;
}

/**
 * 行程快照裡的一列(只有 Windows 會產生,見 `SNAPSHOT_COMMAND`)。
 *
 * export 只是因為 `collectDescendants()` 的參數型別用到它。
 */
export interface ProcessSnapshotEntry {
  pid: number;
  /**
   * 建立當下的父程序 pid。Windows 不會在父程序死後更新它 —— 可能指向一個已經
   * 不存在、甚至已經被別的程式重用的 pid,**不能單獨拿來判斷親子關係**。
   */
  ppid: number;
  /** 建立時間(epoch ms)。 */
  createdAt: number;
  /** 映像名稱(例如 `opencode.exe`),只用在 label / log。 */
  name: string;
}

/**
 * 列出全部行程,一行一個:`pid<TAB>父 pid<TAB>建立時間(epoch ms)<TAB>映像名稱`。
 *
 * 刻意查「全部」,不用 `-Filter` 只查需要的 pid:2026-09-17 實測,光是 PowerShell
 * 啟動就要約 0.8 秒,查單一 pid 約 1.4 秒,列出全部(約 400 個行程)也是約 1.4 秒
 * —— 成本幾乎全在啟動,不在筆數。一次拿整張表,子孫樹、回收比對、疑似殘留的提示
 * 都從同一張表算,不用每筆紀錄各開一次 PowerShell。
 *
 * `CreationDate` 為空的是 System Idle Process 之類的系統行程,略過。
 * 用 tab 分隔:Windows 檔名不允許控制字元,映像名稱不會含 tab。
 */
const SNAPSHOT_COMMAND =
  "Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ForEach-Object { if ($_.CreationDate) { " +
  '"{0}`t{1}`t{2}`t{3}" -f $_.ProcessId, $_.ParentProcessId, ' +
  "[int64]([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds(), $_.Name } }";

/**
 * 行程快照的逾時。正常約 1.4 秒;core 剛開機、防毒正在掃的時候會慢很多,
 * 給足餘裕免得把「慢」誤判成「查不到」(查不到的後果見 `reapOrphans()`)。
 */
const SNAPSHOT_TIMEOUT_MS = 10_000;

/**
 * 「疑似殘留」提示的時間窗口:子程序必須在根建立後這麼久之內建立。
 * `.cmd` shim 開出真正的 agent 實測約 0.1 秒;10 秒是給忙碌機器的餘裕。
 * 只影響 log 會不會印,不影響殺不殺(見 `reportUntrackedChildren()`)。
 */
const UNTRACKED_CHILD_HINT_WINDOW_MS = 10_000;

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

function parseSnapshot(stdout: string): Map<number, ProcessSnapshotEntry> {
  const table = new Map<number, ProcessSnapshotEntry>();
  for (const line of stdout.split(/\r?\n/)) {
    const [pidText, ppidText, createdText, ...nameParts] = line.split("\t");
    const pid = Number(pidText);
    const ppid = Number(ppidText);
    const createdAt = Number(createdText);
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(ppid) || !Number.isFinite(createdAt) || createdAt <= 0) {
      continue;
    }
    table.set(pid, { pid, ppid, createdAt, name: nameParts.join("\t").trim() });
  }
  return table;
}

/**
 * Windows 行程快照(同步版,給 core 啟動時的 `reapOrphans()` 用)。
 * 查不到回 `undefined` —— 一台正常的機器不可能沒有任何行程,空表也當成查不到。
 */
function snapshotProcessesSync(): Map<number, ProcessSnapshotEntry> | undefined {
  try {
    const out = spawnSync("powershell", ["-NoProfile", "-Command", SNAPSHOT_COMMAND], {
      encoding: "utf8",
      timeout: SNAPSHOT_TIMEOUT_MS,
      windowsHide: true,
    });
    if (out.error || out.status !== 0) return undefined;
    const table = parseSnapshot(out.stdout ?? "");
    return table.size > 0 ? table : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Windows 行程快照(非同步版,給 `registerChildDescendants()` 用)。
 *
 * 不能用同步版:它在 session 建立途中執行,1 秒多的 `spawnSync` 會讓 core 整個
 * 事件迴圈(包括 gateway 上其他人的連線)卡住。永遠 resolve,查不到給 `undefined`。
 */
function snapshotProcessesAsync(): Promise<Map<number, ProcessSnapshotEntry> | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (table: Map<number, ProcessSnapshotEntry> | undefined): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(table && table.size > 0 ? table : undefined);
    };
    try {
      const query = spawn("powershell", ["-NoProfile", "-Command", SNAPSHOT_COMMAND], {
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
      let stdout = "";
      query.stdout.setEncoding("utf8");
      query.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      query.once("error", () => finish(undefined));
      query.once("close", (code) => finish(code === 0 ? parseSnapshot(stdout) : undefined));
      timer = setTimeout(() => {
        query.kill();
        finish(undefined);
      }, SNAPSHOT_TIMEOUT_MS);
      timer.unref?.();
    } catch {
      finish(undefined);
    }
  });
}

/**
 * 從一張行程快照裡,找出「**確定是**」某個根行程的子孫(廣度優先,父一定排在子
 * 前面)。
 *
 * 純函式,不查系統 —— export 出來是為了讓 `scripts/e2e-child-registry.mjs` 用
 * 合成的快照驗證下面這幾條防護:真實行程沒辦法叫 OS 去重用某個 pid,這些情境
 * 只能這樣測。
 *
 * 每一條規則都在排除一種「父 pid 對得上,但其實不是它開的」:
 *
 *  1. 根本身必須在快照裡,而且建立時間與登記時**完全一致**。對不上代表根已經
 *     不在、pid 已經換人 —— 底下找到的任何東西都不能算我們的,回傳空陣列。
 *  2. 子行程的建立時間必須**嚴格晚於**父行程。ParentProcessId 不會隨父程序死亡
 *     更新,所以同一個 pid「以前的主人」開過、至今還活著的行程,父 pid 也等於
 *     這個 pid —— 但它一定比現在這個主人更早建立。(同一毫秒也排除:寧可漏登記,
 *     不可誤登記。)
 *  3. 子行程的建立時間必須早於 `queriedAt`(開始查詢**之前**取的時間)。這條讓
 *     推導不必假設快照是原子的:快照列出父行程 P 的那一刻 P 一定還活著,所以
 *     P 的 pid 最早也要在「被列出之後」才可能被別人拿走,而列出一定晚於
 *     `queriedAt`。子行程 C 若建立於 `queriedAt` 之前,C 被建立時 P 的 pid 還沒
 *     被釋放 —— 開出 C 的只可能是 P 本人。查詢途中才建立的行程得不到這個保證,
 *     一律不登記(那只會是 agent 自己新開的行程,回收時對活著的祖先下
 *     `taskkill /T` 本來就會一起帶走)。這條推導唯一的前提:`Date.now()` 與 CIM 的
 *     建立時間取自同一個系統時鐘,而且查詢的這一秒多裡時鐘沒有被往回調。
 *
 * 根先用規則 1 確認,之後每往下一層都是「父已確認 → 用 2、3 確認子」,所以整棵
 * 樹每個節點的保證強度都一樣。
 */
export function collectDescendants(
  snapshot: ReadonlyMap<number, ProcessSnapshotEntry>,
  root: { pid: number; createdAt: number },
  queriedAt: number,
): ProcessSnapshotEntry[] {
  const rootNow = snapshot.get(root.pid);
  if (!rootNow || rootNow.createdAt !== root.createdAt) return [];

  const childrenByParent = new Map<number, ProcessSnapshotEntry[]>();
  for (const proc of snapshot.values()) {
    const siblings = childrenByParent.get(proc.ppid);
    if (siblings) siblings.push(proc);
    else childrenByParent.set(proc.ppid, [proc]);
  }

  const found: ProcessSnapshotEntry[] = [];
  // 規則 2 已經讓環狀的父子關係走不進來;這個集合只是多一層保險,確保一定會結束。
  const visited = new Set<number>([rootNow.pid]);
  const queue: ProcessSnapshotEntry[] = [rootNow];
  while (queue.length > 0) {
    const parent = queue.shift() as ProcessSnapshotEntry;
    for (const child of childrenByParent.get(parent.pid) ?? []) {
      if (visited.has(child.pid)) continue;
      if (child.createdAt <= parent.createdAt) continue; // 規則 2
      if (child.createdAt >= queriedAt) continue; // 規則 3
      visited.add(child.pid);
      found.push(child);
      queue.push(child);
    }
  }
  return found;
}

/** `registerChild()` 登記的那筆(不是某個根的子孫)。 */
function findRoot(pid: number): RegisteredChild | undefined {
  return entries.find((e) => e.pid === pid && e.rootPid === undefined);
}

/**
 * 同一個 pid 的兩次建立時間查詢結果,算不算同一個行程。
 *
 * - POSIX 允許 2 秒誤差:`ps -o lstart=` 只到秒,而且是用「開機時間 + 經過的
 *   tick」推算的,系統時鐘被 NTP 校正後,同一個行程查兩次可能差一秒。
 * - **Windows 要求完全一致**(2026-09-17 收緊,原本也是 2 秒):CIM 的
 *   `CreationDate` 是 kernel 記在行程上的絕對時間,同一個行程重複查詢到毫秒都
 *   一樣(實測)。留著 2 秒誤差,等於把「原行程建立後 2 秒內就死、pid 立刻被別的
 *   程式拿走」判成同一個行程 —— 而 adapter spawn 失敗的路徑剛好會留下這種紀錄
 *   (例如 `.cmd` 找不到指令,cmd.exe 約 0.1 秒就結束;失敗路徑只 kill、沒有
 *   `unregisterChild()`,紀錄會一路留到下次啟動)。
 */
function isSameProcess(currentCreatedAt: number, recordedCreatedAt: number): boolean {
  if (process.platform === "win32") return currentCreatedAt === recordedCreatedAt;
  return Math.abs(currentCreatedAt - recordedCreatedAt) <= 2_000;
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

/**
 * 2026-09-17:agent **確認就緒之後**呼叫(opencode:`/global/health` 通過;ACP:
 * handshake 與 session/new 都成功),把 `registerChild()` 登記過的那個行程底下、
 * 當下已經存在的整棵子孫樹一起登記。理由見檔案頂端「登記到的 pid 只是 shell
 * wrapper」。
 *
 * 為什麼是「就緒之後」,不是 spawn 當下:spawn 當下 cmd.exe 可能還沒把真正的
 * agent 開出來(實測晚約 0.1 秒,機器忙時更久),查了也是空的;agent 已經回應過
 * 請求,就代表它一定已經存在。
 *
 * 只在 Windows 做:需要外殼啟動的只有 Windows(`resolveWindowsSpawnCommand()` 在
 * 其他平台一律 `useShell: false`),而且 POSIX 的回收本來就只對單一 pid 送 SIGTERM、
 * 沒有整棵樹的概念(見 `child-process.ts` `killProcessTree()` 的限制說明)。
 *
 * 永遠不會 reject。呼叫端應該 `void` 掉,不要讓 1 秒多的查詢拖慢 session 建立;
 * 查不到只是少一層保護,不影響 session 本身。回傳 Promise 只是讓測試能等它寫完。
 */
export async function registerChildDescendants(pid: number | undefined): Promise<void> {
  if (!registryPath || pid === undefined || process.platform !== "win32") return;
  const root = findRoot(pid);
  // 沒有根:registerChild() 當初就沒記到(查不到建立時間),或已經 unregister 了。
  if (!root) return;

  // 必須在開始查詢「之前」取,見 collectDescendants() 規則 3。
  const queriedAt = Date.now();
  const snapshot = await snapshotProcessesAsync();
  if (!snapshot) {
    console.warn(
      `[child-registry] 查不到行程快照,pid ${pid}(${root.label})底下的子程序沒有登記 —— ` +
        "core 若之後非正常終止,真正的 agent 行程可能無法在下次啟動時自動回收。",
    );
    return;
  }
  // 查詢的這一秒多裡,dispose() 可能已經 unregisterChild() 掉整組紀錄(甚至同一個
  // pid 又被下一個 session 重新登記)。根已經不是同一筆就什麼都不寫 —— 否則會把
  // 子孫寫回去,留下一組沒有根、永遠不會被移除的紀錄。
  if (findRoot(pid) !== root) return;

  const descendants = collectDescendants(snapshot, root, queriedAt);
  if (descendants.length === 0) return;

  // 比照 registerChild():同 pid 的舊紀錄一定已經不是同一個行程(這個 pid 現在
  // 是剛確認過的子孫),直接取代。
  const pids = new Set(descendants.map((d) => d.pid));
  entries = entries.filter((e) => !pids.has(e.pid));
  for (const d of descendants) {
    entries.push({
      pid: d.pid,
      createdAt: d.createdAt,
      label: `${root.label} → ${d.name}`,
      rootPid: root.pid,
      rootCreatedAt: root.createdAt,
    });
  }
  flush();
}

/**
 * 正常 dispose 之後呼叫 —— 這個子程序已經被好好收掉,不需要下次回收。
 *
 * 2026-09-17:連同 `registerChildDescendants()` 登記在它底下的子孫一起移除
 * (dispose 用的 `taskkill /T` 已經整棵樹一起殺了)。只認根:某筆子孫剛好跟
 * 這個 pid 相同時不動它 —— 那代表這個 pid 早就換過主人,是別組的紀錄。
 */
export function unregisterChild(pid: number | undefined): void {
  if (!registryPath || pid === undefined) return;
  const root = findRoot(pid);
  if (!root) return;
  entries = entries.filter(
    (e) => e !== root && !(e.rootPid === root.pid && e.rootCreatedAt === root.createdAt),
  );
  flush();
}

/**
 * core 啟動時呼叫一次:把上一輪沒被乾淨收掉、而且**確認仍是同一個行程**的
 * 子程序殺掉。回傳這次實際殺掉的數量與跳過的數量(供啟動 log 使用)。
 *
 * 2026-09-17:Windows 改成一次查整張行程表(見 `SNAPSHOT_COMMAND`),不再每筆
 * 紀錄各開一次 PowerShell —— 有了子孫紀錄之後筆數會變多,逐筆查會讓崩潰後的
 * 那次啟動多卡好幾秒。判斷規則本身沒變:每一筆只看它自己的 pid + 建立時間。
 */
export function reapOrphans(): { killed: number; skipped: number } {
  if (!registryPath) return { killed: 0, skipped: 0 };
  const leftovers = entries;
  entries = [];
  flush();

  const isWindows = process.platform === "win32";
  let killed = 0;
  let skipped = 0;
  /** 已經不在、或 pid 已被重用的根 —— 最後用來找「疑似殘留」,見 reportUntrackedChildren()。 */
  const vanishedRoots: RegisteredChild[] = [];
  let snapshot: Map<number, ProcessSnapshotEntry> | undefined;
  let snapshotIsStale = true;

  for (let i = 0; i < leftovers.length; i += 1) {
    const entry = leftovers[i];
    let currentCreatedAt: number | undefined;
    if (isWindows) {
      // 第一次進來要查;之後只有「上一筆剛用 taskkill /T 殺過一整棵樹」才重查 ——
      // 那棵樹裡的 pid 剛被**我們自己**釋放,可能馬上被別的程式拿走,不能拿殺之前
      // 的快照去判斷下一筆(下一筆常常就是剛被一起殺掉的子孫)。
      if (snapshotIsStale) {
        snapshot = snapshotProcessesSync();
        snapshotIsStale = false;
      }
      if (!snapshot) {
        // 查不到行程表就無從確認任何一筆的身分:剩下的一個都不殺,紀錄放回去,
        // 下次啟動再試(查不到多半是暫時的,例如開機時防毒掃描拖慢 PowerShell)。
        const remaining = leftovers.slice(i);
        entries = remaining;
        flush();
        skipped += remaining.length;
        console.warn(
          `[child-registry] 查不到行程快照,無法確認 ${remaining.length} 筆上一輪殘留紀錄的身分 —— ` +
            "**不殺**,紀錄保留到下次啟動再試。",
        );
        return { killed, skipped };
      }
      currentCreatedAt = snapshot.get(entry.pid)?.createdAt;
    } else {
      currentCreatedAt = queryProcessCreatedAt(entry.pid);
    }

    if (currentCreatedAt === undefined) {
      // 行程已經不在了 —— 正常情況(使用者自己關掉、或 OS 已回收)。
      if (entry.rootPid === undefined) vanishedRoots.push(entry);
      continue;
    }
    if (!isSameProcess(currentCreatedAt, entry.createdAt)) {
      if (entry.rootPid === undefined) vanishedRoots.push(entry);
      skipped += 1;
      console.warn(
        `[child-registry] pid ${entry.pid}(${entry.label})目前存在,但建立時間對不上 —— ` +
          "判定為 pid 重用,**不殺**。若你發現有殘留的 agent 行程,請手動確認。",
      );
      continue;
    }
    try {
      if (isWindows) {
        spawnSync("taskkill", ["/pid", String(entry.pid), "/T", "/F"], { stdio: "ignore" });
        snapshotIsStale = true;
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

  if (isWindows) {
    // 有子孫紀錄的根不用看:它的子孫上面已經各自照 pid + 建立時間處理過了。
    const untrackedRoots = vanishedRoots.filter(
      (root) => !leftovers.some((e) => e.rootPid === root.pid && e.rootCreatedAt === root.createdAt),
    );
    if (untrackedRoots.length > 0) {
      if (snapshotIsStale) snapshot = snapshotProcessesSync();
      if (snapshot) reportUntrackedChildren(untrackedRoots, snapshot);
    }
  }
  return { killed, skipped };
}

/**
 * 2026-09-17:做法 (b) 的「只提示、不殺」版本(見檔案頂端)。
 *
 * 對象是「已經不在(或 pid 已被重用)、而且**沒有任何子孫紀錄**」的根 —— 升級前
 * 寫下的舊紀錄,或 core 在 agent 就緒前就終止、`registerChildDescendants()` 還沒
 * 來得及跑的那種。
 *
 * 條件:父 pid 等於那個根、建立時間嚴格晚於根、且在根建立後
 * `UNTRACKED_CHILD_HINT_WINDOW_MS` 之內;若那個 pid 現在被別的行程佔著,還要早於
 * 現在這個主人建立(晚於它的,更可能是現在這個主人自己開的)。
 *
 * 這些條件只能讓「是當初那個 wrapper 開的」變得**很可能**,不能變成**確定**,所以
 * 只印 log,附上建立時間差讓使用者自己判斷。
 */
function reportUntrackedChildren(
  roots: RegisteredChild[],
  snapshot: ReadonlyMap<number, ProcessSnapshotEntry>,
): void {
  for (const root of roots) {
    const currentHolder = snapshot.get(root.pid);
    for (const proc of snapshot.values()) {
      if (proc.ppid !== root.pid) continue;
      const delayMs = proc.createdAt - root.createdAt;
      if (delayMs <= 0 || delayMs > UNTRACKED_CHILD_HINT_WINDOW_MS) continue;
      if (currentHolder && proc.createdAt >= currentHolder.createdAt) continue;
      console.warn(
        `[child-registry] 疑似殘留:pid ${proc.pid}(${proc.name})的父 pid 是上一輪登記的 ` +
          `pid ${root.pid}(${root.label}),建立於它之後 ${delayMs}ms。但這筆紀錄沒有子孫身分資料` +
          "(升級前的舊紀錄,或 core 在 agent 就緒前就終止),無法確認它真的是當初那個 agent —— " +
          "**不殺**。若確定是殘留的 agent,請手動結束它。",
      );
    }
  }
}
