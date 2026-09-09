import type { Interface } from "node:readline";
import type { PolicyRule } from "@deskmony/shared";
import { buildNarrowestRememberRule, paint, summarizeToolInputLines } from "./render.js";

/**
 * 這個檔案只處理「chat REPL 裡,需要真人回答的互動」——權限問答(HLD §6)
 * 與 Ctrl+C 的雙擊確認(HLD §7)。`run` 一律非互動(§6:「非互動模式
 * (run、或 stdin 不是 TTY)」明講 `run` 本身就在非互動集合裡,不論 stdin
 * 是不是 TTY),完全不會用到這個檔案,見 commands/run.ts 對權限請求的
 * 處理方式(一律 deny,不問)。
 */

export interface PermissionAskParams {
  sessionId: string;
  toolName: string;
  input: unknown;
  strong: boolean;
}

export interface PermissionAnswer {
  decision: "allow" | "deny";
  rememberRule?: PolicyRule;
}

function question(rl: Interface, query: string): Promise<string> {
  return new Promise((resolve) => rl.question(query, resolve));
}

/**
 * HLD §6 的互動權限問答(stdin 是 TTY 的 chat REPL 專用)。
 *
 * 兩種樣式:
 *   - 一般(`strong === false`):`[a]` 允許一次、`[d]` 拒絕、`[A]` 永遠允許
 *     (最窄規則,見 render.ts 的 `buildNarrowestRememberRule()`)、直接
 *     Enter 視為拒絕。輸入看不懂時重新問(上限 3 次,避免真的卡在無窮
 *     迴圈——例如 stdin 被接到一個一直吐垃圾行的來源)。
 *   - `strong === true`(escalate-strong,對應 hard-deny 命中後的降級,見
 *     docs/DECISIONS.md §G「三斷路器」):**不提供 `[A]`**——core 端本來就
 *     會強制剝掉這種請求的 `rememberRule`(C4 紀律③),這裡不提供選項只是
 *     不要讓使用者以為「永遠允許」對這種請求有意義。要求輸入完整的
 *     `yes`(而非單一按鍵)才會允許,其餘任何輸入(含空字串)一律拒絕——
 *     刻意不重試:打錯字太容易被誤判成「使用者其實想打 yes」,對這種高
 *     風險請求,預設值必須是「拒絕」而不是「再給一次機會」。
 */
export async function askPermission(rl: Interface, params: PermissionAskParams, color: boolean): Promise<PermissionAnswer> {
  const header = params.strong
    ? paint(`權限請求(高風險,已被安全政策標記)· session ${params.sessionId}`, "red", color)
    : paint(`權限請求 · session ${params.sessionId}`, "cyan", color);
  process.stdout.write(`\n${header}\n`);
  process.stdout.write(`  工具:${params.toolName}\n`);
  for (const line of summarizeToolInputLines(params.input)) {
    process.stdout.write(`  ${line}\n`);
  }

  if (params.strong) {
    process.stdout.write(
      paint("  這個工具呼叫命中了 hard-deny 規則,一般會被直接拒絕。\n", "red", color) +
        "  不提供「永遠允許」。清楚自己在做什麼的話,請輸入完整的 yes 允許;" +
        "其餘任何輸入(含直接 Enter)一律視為拒絕。\n",
    );
    const answer = await question(rl, "  > ");
    return answer.trim() === "yes" ? { decision: "allow" } : { decision: "deny" };
  }

  process.stdout.write("  [a] 允許一次   [d] 拒絕   [A] 永遠允許(最窄規則)   [Enter] = 拒絕\n");
  const MAX_ATTEMPTS = 3;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const answer = (await question(rl, "  > ")).trim();
    if (answer === "" || answer === "d" || answer === "D") return { decision: "deny" };
    if (answer === "a") return { decision: "allow" };
    if (answer === "A") return { decision: "allow", rememberRule: buildNarrowestRememberRule(params.toolName, params.input) };
    process.stdout.write(`  看不懂「${answer}」,請輸入 a / d / A,或直接 Enter 拒絕。\n`);
  }
  process.stdout.write("  已達重試上限,視為拒絕。\n");
  return { decision: "deny" };
}

interface KeypressKey {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}

/**
 * chat REPL 在「這一輪還在跑」期間如何管理 stdin,避免串流輸出弄花使用者
 * 正在打的那一行(任務要求的第 3 個判斷)。
 *
 * **為什麼不是整個 `rl.pause()`**:Ctrl+C 在 raw mode 底下**不會**變成真正
 * 的 process SIGINT 訊號——raw mode 關掉了終端機驅動自己的 ISIG 處理,
 * Ctrl+C 只是一個位元組(0x03)經由一般輸入管線送進來,readline 收到才
 * 手動合成一個 `"SIGINT"` 事件。如果整條 stream 被 `pause()`,這個位元組
 * 根本不會被處理,連 `session.interrupt` 都送不出去——而 HLD §7 明講
 * 「互動模式第一次 Ctrl+C = session.interrupt」正是要在**串流進行中**也能
 * 用的功能,不能因為防止畫面錯亂而犧牲掉。
 *
 * **為什麼不是「線上重繪」(clear the line, write, `rl.prompt(true)`)**:
 * 這招對「偶爾插一行 log」很有效,但 `message-delta` 的頻率可能是每秒
 * 好幾次、每次幾個字——若每個 chunk 都重繪一次提示列,畫面會一直閃爍;
 * 若不每個 chunk 都重繪,readline 對「目前游標在第幾行」的內部狀態
 * (`_previousRows` 之類)會因為我們自己另外寫的內容而過期,使用者剛好在
 * 那個當下按下一個鍵時,readline 用過期的座標重繪,反而真的把畫面弄花。
 *
 * **實際做法**:直接把 `process.stdin` 上除了我們自己以外的 `"keypress"`
 * listener(也就是 readline 內部那個,負責回顯字元、更新 `rl.line`)整組
 * 暫時拔掉,換上一個只認 Ctrl+C 的 guard——這一輪其餘按鍵**誠實地被吞掉**
 * (不回顯、不進任何緩衝),不是「暫停後一次補上一大串」。這個取捨的理由:
 * 使用者這個當下打的字,不論哪一種處理方式都不會被 agent 這一輪看到
 * (它已經在跑了),與其讓使用者以為自己打的東西被記下來(pause+resume
 * 之後一次性回放,體驗更像 bug 而非設計),不如讓畫面在這段期間清楚地
 * 「沒有輸入行」,turn 結束後 `rl.prompt(true)` 重新畫出一個乾淨的提示符。
 *
 * 回傳值是 restore 函式——呼叫後恢復 readline 原本的 keypress 處理。
 * 這一輪途中彈出權限問答時(`rl.question()` 需要正常的按鍵回顯),
 * commands/chat.ts 會先呼叫這個 restore,問完再重新呼叫這個函式暫停一次。
 */
export function suspendEchoKeepingCtrlC(onCtrlC: () => void): () => void {
  const stdin = process.stdin;
  const previousListeners = stdin.listeners("keypress") as Array<(str: string, key: KeypressKey | undefined) => void>;
  for (const listener of previousListeners) stdin.removeListener("keypress", listener);
  const guard = (_str: string, key: KeypressKey | undefined): void => {
    if (key?.ctrl && key.name === "c") onCtrlC();
    // 其餘按鍵:busy 期間直接吞掉,見上方完整取捨說明。
  };
  stdin.on("keypress", guard);
  // restore 必須是 idempotent 的——commands/chat.ts 在「這一輪期間彈出權限
  // 問答」時會先 restore 一次(問答需要正常的按鍵回顯)、問完再重新呼叫
  // `suspendEchoKeepingCtrlC()` 掛一份新的;但如果同一輪後來又在
  // `completed`/`error` 的收尾也呼叫到「舊的那份」restore(理論上不該發生,
  // 防禦性地擋一次),沒有這個旗標的話,`previousListeners` 會被重複掛上去,
  // 每個鍵變成處理兩次(字元重複回顯、`rl.line` 內容加倍)。
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    stdin.removeListener("keypress", guard);
    for (const listener of previousListeners) stdin.on("keypress", listener);
  };
}

/**
 * HLD §7:「互動模式第一次 = session.interrupt(中斷這一輪,不離開);兩秒內
 * 再按一次 = 離開」。文件沒有把「idle 時按」跟「busy 時按」分成兩套規則,
 * 所以做成一個與忙碌狀態無關的狀態機,chat.ts 在兩個偵測點(idle 時的
 * `rl.on("SIGINT")`、busy 時上面 `suspendEchoKeepingCtrlC()` 的 guard)
 * 都呼叫同一個 `press()`,由呼叫端決定「interrupt-only」要不要真的送出
 * `session.interrupt`(idle 時送了也無妨,busy 時才真正有意義),
 * 「quit」則一律結束 REPL。
 */
export function createDoubleCtrlCGuard(windowMs = 2000): { press: () => "interrupt-only" | "quit" } {
  let armedUntil = 0;
  return {
    press(): "interrupt-only" | "quit" {
      const now = Date.now();
      if (now < armedUntil) return "quit";
      armedUntil = now + windowMs;
      return "interrupt-only";
    },
  };
}
