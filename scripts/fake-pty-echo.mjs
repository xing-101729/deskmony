#!/usr/bin/env node
/**
 * scripts/fake-pty-echo.mjs
 *
 * 給 scripts/e2e-gateway.mjs 步驟 10 使用的最小互動式 CLI —— 用來當作
 * `software="pty"` 的 `AgentProfile.ptyConfig.command`,讓 `GenericPtyAdapter`
 * 的 e2e 測試不必依賴 `cmd.exe`/`bash` 的當地語系化輸出或分行慣例(那些會
 * 因作業系統/語系而不同,不夠決定性),而是有一個完全確定性、跨平台一致的
 * 終端輸出可以斷言。
 *
 * 行為:
 *   - 啟動後先印出一行 "READY"(讓測試端可以確認 pty 已經真的能收到輸出)。
 *   - 每次從 stdin 讀到一行文字(GenericPtyAdapter.sendPrompt() 會把
 *     `prompt.text + "\r"` 寫進 pty,終端的行編輯會在按下 Enter 時把整行
 *     交給這支程式的 stdin),就印出 `ECHO:<原文>`。
 *   - 若該行文字恰好是 "exit",印出 "BYE" 後以 exit code 0 結束(用來驗證
 *     GenericPtyAdapter 在子程序結束時會送出 `completed` 事件並關閉
 *     `outputQueue`)。
 *   - 收到 SIGINT(`GenericPtyAdapter.interrupt()` 送出的 `\x03`/Ctrl+C,
 *     經 ConPTY/pty 的終端驅動翻譯成真正的 SIGINT 遞送給前景程式)時印出
 *     "SIGINT-RECEIVED" 但**不**結束程式 —— Node 對 SIGINT 註冊了自訂
 *     listener 之後就不會再走預設的「收到訊號就終止」行為,這樣 e2e 才能
 *     在同一個 session 內先驗證 interrupt() 真的把 Ctrl+C 送到了子程序,
 *     再接著送 "exit" 驗證正常結束的路徑,不用為了測 interrupt 另開一個
 *     session。
 *
 * 這支腳本本身就是一支普通的 Node CLI(不像 fake-acp-agent.mjs 需要 ACP
 * JSON-RPC over stdio),`GenericPtyAdapter` 是用 `node-pty` 幫它另外開一個
 * 偽終端(pty)再把它跑起來,stdin/stdout 走的是 pty 的行編輯層,不是原始
 * pipe。
 */
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin, terminal: false });

process.stdout.write("READY\n");

process.on("SIGINT", () => {
  process.stdout.write("SIGINT-RECEIVED\n");
});

rl.on("line", (line) => {
  const trimmed = line.trim();
  process.stdout.write(`ECHO:${trimmed}\n`);
  if (trimmed === "exit") {
    process.stdout.write("BYE\n");
    rl.close();
    process.exit(0);
  }
});
