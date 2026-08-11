#!/usr/bin/env node
/**
 * scripts/e2e-crash-recovery-graceful-bootstrap.mjs
 *
 * **測試專用啟動殼,不是產品程式碼**——只給 scripts/e2e-crash-recovery.mjs 用,
 * 目的是在 Windows 上可靠地觸發 apps/core/src/index.ts 真正的優雅關閉
 * handler(`process.on("SIGTERM", ...)`)。
 *
 * 背景(已實測,不是猜測):在這台 Windows 機器上,`child_process` 從父行程
 * 呼叫 `child.kill("SIGTERM")`/`child.kill("SIGINT")` 一律等同無條件
 * `TerminateProcess`——被殺的子行程**完全沒有機會**執行它自己註冊的
 * `process.on("SIGTERM"/"SIGINT", ...)` handler(用一個最小的 repro 腳本驗證
 * 過:子行程印出 "CHILD_READY" 後,父行程送出訊號,子行程直接消失,從未印出
 * "CHILD_GOT_SIGTERM")。`taskkill /PID <pid>`(不加 `/F`)對這種沒有訊息迴圈
 * 的 headless 子行程也會直接失敗("此處理程序只能強制終止")。
 *
 * 這正好符合「kill -9 模擬崩潰」測試的需求(見 e2e-crash-recovery.mjs 的
 * `killProcessTree()`——這就是崩潰情境該有的行為,不需要額外處理),但代表
 * **無法**用同一招從外部測試程式可靠地觸發「優雅關閉」。
 *
 * 解法:改用 Node 內建的 IPC channel(`spawn(..., { stdio: [...,'ipc'] })`)
 * 傳一則訊息,子行程收到後對**自己**呼叫 `process.emit("SIGTERM")`——這與真的
 * 收到 OS SIGTERM 時 Node 內部對 `process.on("SIGTERM", listener)` 的呼叫方式
 * 完全等價(libuv 收到訊號 → 通知 Node → `process.emit(signalName)`;這裡只是
 * 把「OS 訊號抵達」換成「IPC 訊息抵達」,`apps/core/src/index.ts` 內
 * `shutdown()` 實際執行的程式碼與真的收到 SIGTERM 時完全相同,測的是真正的
 * production 邏輯,不是重新實作一份)。
 */
process.on("message", (msg) => {
  if (msg === "graceful-shutdown") {
    process.emit("SIGTERM");
  }
});
await import("../apps/core/dist/index.js");
