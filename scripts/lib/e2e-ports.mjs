/**
 * scripts/lib/e2e-ports.mjs
 *
 * 2026-10-27:e2e 的 core port 改成每次動態挑選,讓多個 git worktree 可以同時跑 e2e。
 *
 * ---- 為什麼需要這個 ----------------------------------------------------
 *
 * 在此之前每支 e2e 都把 core 的 WS port 寫死(e2e-session-network 用 5321/5322、
 * e2e-policy-engine 用 4331/4335……),各支之間靠檔頭註解互相「避開」。這只防得了
 * **同一份程式碼裡的兩支**撞號,防不了**兩個 worktree 跑同一支**——那時兩邊用的是
 * 完全相同的號碼。這台機器上常常同時開好幾個 session、各自在不同 worktree 跑測試,
 * 2026-10-27 實際撞到:`e2e-session-network` 序幕報「找不到 session: <id>」、
 * `e2e-notification` 15/16;等另一個 worktree 跑完再單獨重跑,全部通過。
 *
 * 更糟的是撞號**不會大聲失敗**:core 綁 port 失敗(EADDRINUSE)時,錯誤經 `ws` 的
 * WebSocketServer 轉成未捕捉例外,core 的 uncaught-exception handler 印一行 `[FATAL]`
 * 之後**刻意不退出**(見 apps/core/src/index.ts 的說明:怕失去對 agent 子程序的控制),
 * 測試的 `waitForPort()` 只確認「那個 port 連得上」,於是 client
 * 安靜地連到**另一個 worktree 的 core、另一份 DB**——症狀是莫名其妙的「找不到
 * session」,很容易被誤判成程式回歸。
 *
 * ---- 為什麼選「動態 port」而不是「全機一把鎖、一次只准一個 worktree 跑」 ----
 *
 * 鎖也能解決撞號,但代價是兩個 worktree 的 `pnpm test`(各約 30 分鐘)變成排隊
 * 60 分鐘——而這個任務的目的正是讓它們「同時跑」。動態 port 從源頭消除共用資源,
 * 不需要任何跨行程協調、也沒有過期鎖要回收。
 *
 * ---- 取號與啟動之間的競態 ----------------------------------------------
 *
 * 「先探測 port 空著、再讓 core 去綁」中間有一兩秒空窗(core 載入模組、跑 migration
 * 才開始 listen),別人可能在這段時間先綁走。兩層處理:
 *
 *   1. **降低機率**:不用 `listen(0)` 讓 OS 挑——OS 給的是臨時 port(Windows 預設
 *      49152–65535、Linux 32768–60999),機器上每一條對外連線都在搶同一個池子。
 *      這裡改從兩個臨時範圍之外的 20000–31999 隨機挑,只會跟「也在這段隨機挑號的
 *      另一支 e2e」相撞,而兩邊要在同一兩秒內抽中同一個號碼,機率約萬分之一。
 *      Windows 的保留範圍(Hyper-V/WSL 動態排除的 port,例如這台的 21112)綁了會
 *      EACCES,探測那一步就會跳過。
 *   2. **真的撞到時大聲失敗並重跑**:`guardCorePort()` 監看 core 的輸出,一看到
 *      gateway 綁 port 失敗就收掉這支 e2e 啟動的所有 core、以 `PORT_CONFLICT_EXIT_CODE`
 *      結束——不讓測試繼續對著別人的 core 斷言。`scripts/run-e2e.mjs` 看到這個
 *      exit code 會整支重跑(重跑時會抽到新的 port)。
 *
 * 用法:
 *   import { allocatePort, guardCorePort } from "./lib/e2e-ports.mjs";
 *   const PORT = await allocatePort();
 *   // startCore() 裡 spawn 完之後:
 *   guardCorePort(proc, port);
 */

import { spawnSync } from "node:child_process";
import net from "node:net";

/** 隨機挑號的範圍 [起, 迄)——刻意落在 Windows 與 Linux 預設臨時 port 範圍之外,理由見檔頭。 */
const PORT_RANGE_START = 20000;
const PORT_RANGE_END = 32000;
const MAX_ATTEMPTS = 200;

/**
 * core 綁不到 port 時 e2e 程序的 exit code(BSD sysexits 的 EX_TEMPFAIL:暫時性失敗、
 * 重試可能成功)。`run-e2e.mjs` 以它判斷要不要整支重跑,改了要同步改那邊。
 */
export const PORT_CONFLICT_EXIT_CODE = 75;

/**
 * 這個行程已經發出去的號碼。必要:一支 e2e 常常在啟動任何 core 之前就先取好兩三個
 * port(例如 e2e-cli 的一般 core + 認證 core),那時誰都還沒綁,探測看不出它們
 * 已經「有主」,沒有這份紀錄就可能把同一個號碼發兩次。
 */
const handedOut = new Set();

/** 實際在 127.0.0.1 上 listen 一次再關掉——core 預設也只綁 127.0.0.1。
 *  刻意不探測 0.0.0.0:在 Windows 上 node.exe 綁所有介面會跳防火牆詢問視窗。 */
function canListen(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ port, host: "127.0.0.1" }, () => {
      server.close(() => resolve(true));
    });
  });
}

/** 挑一個目前空著、而且這個行程還沒發出去過的 port。 */
export async function allocatePort() {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const port = PORT_RANGE_START + Math.floor(Math.random() * (PORT_RANGE_END - PORT_RANGE_START));
    if (handedOut.has(port)) continue;
    if (!(await canListen(port))) continue;
    handedOut.add(port);
    return port;
  }
  throw new Error(`[e2e-ports] 試了 ${MAX_ATTEMPTS} 次都找不到空閒的 port(${PORT_RANGE_START}-${PORT_RANGE_END - 1})`);
}

/** 目前還活著、被 guardCorePort() 看管的 core——撞號時要一併收掉,不然它們會變成孤兒繼續佔著資源。 */
const guarded = new Set();

/**
 * Node 綁 port 失敗的錯誤訊息,例如 `listen EADDRINUSE: address already in use 127.0.0.1:27030`。
 *
 * 比對的是 Node 錯誤本身、不是哪個 handler 印的前綴:實測(2026-10-27)這個錯誤並沒有走
 * ws-gateway.ts 的 `[gateway] HTTP server error`,而是被 `ws` 轉成未捕捉例外、由 core 的
 * `[uncaught-exception][FATAL]` 印出——前綴是 core 內部細節,隨時會變。改為要求訊息結尾
 * 是**這個 core 的 port**:core 底下的 agent 後端(例如 opencode server)也可能印出綁
 * port 失敗,但那是別的號碼,不是我們要攔的情況。
 */
function bindFailurePattern(port) {
  return new RegExp(`listen (EADDRINUSE|EACCES)[^\\n]*:${port}(?!\\d)`);
}

function killTree(proc) {
  if (proc.exitCode !== null) return;
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      proc.kill("SIGKILL");
    }
  } catch {
    // 收尾階段,殺不掉也只能繼續往下結束程序。
  }
}

/**
 * 看管一個剛 spawn 的 core:它的 gateway 一旦綁 port 失敗,就收掉這支 e2e 啟動的
 * 所有 core 並以 `PORT_CONFLICT_EXIT_CODE` 結束整支 e2e。
 *
 * 為什麼直接結束而不是讓測試自己失敗:core 綁不到 port 時程序不會退出,而那個
 * port 上回應的是別人的 core——接下來每一個斷言都是對著錯的對象做的,錯誤訊息
 * 只會誤導人。也不在這裡換號重啟:port 早已寫進各支測試的 URL、client、重啟
 * 流程裡,換號重試要改的是每一支的結構;整支重跑(由 run-e2e.mjs 負責)簡單得多,
 * 而這條路徑本來就只在萬分之一的撞號時才會走到。
 *
 * 必須在 spawn 之後**立刻**呼叫:錯誤訊息可能在呼叫端開始等 port 之前就印出來了。
 */
export function guardCorePort(proc, port) {
  guarded.add(proc);
  proc.once("exit", () => guarded.delete(proc));
  const pattern = bindFailurePattern(port);
  // 錯誤訊息可能被切在兩個 chunk 之間,保留一小段尾巴一起比對。
  let tail = "";
  const onData = (chunk) => {
    tail = (tail + chunk.toString()).slice(-2048);
    const match = pattern.exec(tail);
    if (!match) return;
    tail = "";
    console.error(
      `\n[e2e-ports] PORT_CONFLICT:core(pid=${proc.pid})綁不到 port ${port}(${match[1]})——` +
        `應該是取號之後、core 開始 listen 之前被別的程序搶走了。這個 port 上回應的不是這支測試的 core,` +
        `繼續跑下去的斷言都不可信,所以直接中止(exit ${PORT_CONFLICT_EXIT_CODE});重跑會抽到新的 port。\n`,
    );
    for (const p of guarded) killTree(p);
    process.exit(PORT_CONFLICT_EXIT_CODE);
  };
  proc.stdout?.on("data", onData);
  proc.stderr?.on("data", onData);
}
