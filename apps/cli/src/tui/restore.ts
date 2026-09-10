/**
 * 終端還原(HLD §6.3):退出 alternate screen、顯示游標、關閉 raw mode,
 * 三件事收在同一個 `restore()`,掛在 `process.on("exit")`——崩潰後使用者
 * 的終端不能壞掉(看不到游標、鍵盤沒回顯),那是最惹人厭的 bug。
 *
 * ---- ink 自己做了什麼、沒做什麼(讀過 node_modules/ink 的原始碼確認,
 * 不是猜的)------------------------------------------------------------
 *
 * `tui/app.tsx` 用 `render(<App/>, { alternateScreen: true, ... })`。讀過
 * `ink/build/ink.js` 之後確認 ink 在這個選項開啟時,自己會做的事:
 *
 *   - 啟動時(建構子呼叫 `setAlternateScreen(true)`):寫入
 *     `ansiEscapes.enterAlternativeScreen`(`\x1b[?1049h`)與
 *     `hideCursorEscape`(`\x1b[?25l`)。
 *   - `unmount()` 執行到 `finishUnmount()` 時:如果 `this.alternateScreen`
 *     仍是 true,寫入 `ansiEscapes.exitAlternativeScreen`(`\x1b[?1049l`)
 *     與 `showCursorEscape`(`\x1b[?25h`)。
 *   - `ink/build/components/App.js` 的 unmount effect**又**獨立呼叫一次
 *     `cliCursor.show(stdout)`(只要 `interactive` 為 true)——與上面那條
 *     完全獨立、互相冗餘,不影響正確性(顯示游標本來就是可以重複呼叫的
 *     冪等操作)。
 *   - `unmount()` 會透過 `signal-exit` 套件(`ink.js`:
 *     `this.unsubscribeExit = signalExit(this.unmount, { alwaysLast: false })`)
 *     自動掛在 process 的退出路徑上——即使我們自己的程式碼從沒明講呼叫
 *     `instance.unmount()`,直接呼叫 `process.exit()` 通常也會觸發它。
 *
 * ink **不會**做的事:**raw mode 的開關**。讀過 `App.js` 確認 raw mode
 * 只有在某個元件呼叫 `useInput()`/`useStdin().setRawMode(true)` 時才會被
 * 打開(`handleSetRawMode()`),這個 TUI 完全不用 `useInput`(見
 * `tui/keys.ts` 檔頭的完整理由——自己讀 raw bytes 才能做到 §6.2 要求的
 * 30ms Esc 逾時消歧),所以 ink 從頭到尾不知道、也不會去關掉 raw mode。
 * `tui/app.tsx` 自己呼叫 `process.stdin.setRawMode(true)`,**這個檔案是
 * 唯一會把它關掉的地方**。
 *
 * ---- 為什麼這裡仍然重複寫 alt-screen-exit / show-cursor(即使 ink 通常
 * 也會做)------------------------------------------------------------
 *
 * ink 的教程本身就承認這件事是 best-effort:`finishUnmount()` 只在
 * `canWriteToStdout` 為真時才寫這些逸出碼,而 `unmount()` 要嘛被我們自己
 * 呼叫、要嘛靠 `signal-exit` 攔到才會執行——兩條路徑都有「萬一沒發生」的
 * 可能(例如某個我們沒預期到的例外在 ink 的 `unmount()` 跑完前就讓行程
 * 用別的方式結束)。這三行是這個功能**唯一被 HLD 明講要做的保證**,重複
 * 寫、多寫一次是零成本的(這些逸出碼在已經處於目標狀態時重複送出是
 * no-op),換來的是「不論 ink 那邊發生什麼,這三件事一定做過一次」的
 * 確定性,不必去賭 ink 內部的時序或例外處理路徑。
 */

let restored = false;

/** 冪等——`process.on("exit")` 只保證觸發一次,但呼叫端(tui/app.tsx)在
 *  使用者主動離開時也會提早呼叫一次,兩邊都呼叫是刻意的(提早呼叫讓終端
 *  在 ink 的 `unmount()` 收尾動作跑之前就已經是乾淨狀態,`process.on`
 *  那份純粹是保險),用旗標擋掉重複執行。 */
export function restore(): void {
  if (restored) return;
  restored = true;
  try {
    process.stdout.write("\x1b[?1049l"); // 離開 alternate screen。
  } catch {
    // stdout 可能已經在結束流程中被關掉——盡力而為,不要讓 restore() 本身
    // 拋錯(拋錯會讓 process.on("exit") 的其餘 listener 也遭殃)。
  }
  try {
    process.stdout.write("\x1b[?25h"); // 顯示游標。
  } catch {
    // 同上。
  }
  try {
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
  } catch {
    // 同上——且非 TTY 的 stdin 本來就沒有這個方法可呼叫。
  }
}

/** 掛在 `process.on("exit")`——這是唯一保證「不論怎麼結束都會跑一次」的
 *  掛點(比較 SIGINT/SIGTERM:沒有 handler 時的預設行為不會經過這裡,但
 *  這個 TUI 一開啟 raw mode 之後,Ctrl+C 本來就只是一個位元組不是訊號,
 *  不會觸發 OS 預設的 SIGINT 行為;`registerExitRestore()` 呼叫端
 *  (tui/app.tsx)另外接了 SIGTERM,讓「被外部 kill」也能收斂成一次正常
 *  的 `process.exit()`,理由見 app.tsx 對應段落的註解)。 */
export function registerExitRestore(): void {
  process.on("exit", restore);
}
