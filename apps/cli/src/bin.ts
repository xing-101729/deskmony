#!/usr/bin/env node
import { CliUsageError, parseArgv, printHelp, printVersion, type ParsedCommand } from "./args.js";
import { CliExitError } from "./connect.js";
import { chatCommand } from "./commands/chat.js";
import { configShowCommand } from "./commands/config.js";
import { doctorCommand } from "./commands/doctor.js";
import { profileListCommand } from "./commands/profile.js";
import { runCommand } from "./commands/run.js";
import { serveCommand } from "./commands/serve.js";
import { sessionListCommand, sessionRmCommand } from "./commands/session.js";

/**
 * `bin.ts` 只做兩件事(HLD §4.2 對這個檔案的定位):argv 分派、決定退出碼。
 * 「怎麼連線」「怎麼渲染事件」「怎麼問權限」全部在其他檔案——這裡刻意保持
 * 薄,讓「哪個指令對應哪個退出碼」這個最容易在往後維護中被不小心弄壞的
 * 映射關係,一眼就能看完整。
 *
 * 判斷4(任務要求的四個判斷之一):Ctrl+C 在非互動模式下的退出碼 130,
 * 與 HLD §2 那張表(0/1/2/3/4)是**兩個不同的編號空間,刻意不會打架**——
 * 128+訊號編號是 POSIX shell 回報「行程被訊號終止」的通用慣例(SIGINT=2,
 * 故 130),不屬於這個工具自訂的退出碼語意,任何看得懂這個慣例的呼叫端
 * (CI、其他腳本)本來就會把它跟「應用程式自訂的退出碼」分開看待。
 *
 * `run`/`session`/`profile`/`doctor`/`config` 這幾個一次性指令,這個檔案
 * **刻意不**替它們安裝任何 `process.on("SIGINT", ...)`——Node.js 對「沒有
 * 監聽者的 SIGINT」有明確定義的預設行為:終止行程,父層 shell 依上述慣例
 * 把結果回報成 130。這正是 HLD §7「非互動模式 = 直接離開,退出碼 130」要
 * 的效果,而且是**完全不用寫程式碼**就拿到的效果——手動裝一個「印訊息、
 * `process.exit(130)`」的 handler 反而更危險:一旦裝了 handler 就取代了
 * 預設行為,那個 handler 只要不小心夾雜任何非同步操作(例如「順便」呼叫
 * `session.interrupt` 並等待回應),就可能讓 Ctrl+C 卡住不動,比什麼都不
 * 做還糟。什麼都不裝、讓 Node 的預設路徑接管,是這裡最安全也最簡單的選擇。
 *
 * `chat` 是唯一的例外——它把 stdin 切進 raw mode(`node:readline` 的
 * `terminal:true`),Ctrl+C 在 raw mode 下**不會**產生真正的 OS SIGINT 訊號
 * (raw mode 關掉了終端機驅動自己的 ISIG 處理),上面那段「預設行為」完全
 * 不適用,必須靠 readline 自己合成的 `"SIGINT"` 事件——commands/chat.ts
 * 裡那一整套雙擊確認邏輯正是為此存在,細節見 prompt.ts 的完整說明。
 *
 * `serve` 同樣刻意不裝——HLD §7 明講「serve 只把 SIGINT/SIGTERM 交給 core
 * 既有的關閉流程」。`await import("@deskmony/core")` 執行後,core 自己的
 * `apps/core/src/index.ts` 早就註冊了它自己的 `process.on("SIGINT", ...)`
 * (含 5 秒逾時保護的優雅關閉),這個檔案不需要、也不應該疊加第二層——兩層
 * handler 搶著處理同一個訊號,只會製造不確定的行為。
 */

async function dispatch(parsed: ParsedCommand): Promise<void> {
  switch (parsed.kind) {
    case "help":
      printHelp();
      return;
    case "version":
      printVersion();
      return;
    case "chat":
      return chatCommand(parsed.options);
    case "run":
      return runCommand(parsed.options, parsed.promptArg);
    case "serve":
      return serveCommand(parsed.options);
    case "session-list":
      return sessionListCommand(parsed.options);
    case "session-rm":
      return sessionRmCommand(parsed.options, parsed.sessionId);
    case "profile-list":
      return profileListCommand(parsed.options);
    case "doctor":
      return doctorCommand(parsed.options);
    case "config-show":
      return configShowCommand(parsed.options);
  }
}

async function main(): Promise<void> {
  try {
    const parsed = parseArgv(process.argv.slice(2));
    await dispatch(parsed);
  } catch (err) {
    if (err instanceof CliUsageError) {
      process.stderr.write(`[deskmony] ${err.message}\n`);
      process.stderr.write("執行「deskmony --help」查看用法。\n");
      process.exitCode = 2;
      return;
    }
    if (err instanceof CliExitError) {
      process.stderr.write(`[deskmony] ${err.message}\n`);
      process.exitCode = err.exitCode;
      return;
    }
    // 真正沒預期到的錯誤(bug,不是「使用者用錯」或「gateway 回報失敗」這
    // 兩種已經分類過的情況)——印出完整堆疊,退出碼 1(HLD §2:「執行期
    // 錯誤」是這個碼最廣義的解釋,涵蓋「CLI 自己的錯誤」也合理)。
    process.stderr.write(`[deskmony] 未預期的錯誤:${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exitCode = 1;
  }
}

void main();
