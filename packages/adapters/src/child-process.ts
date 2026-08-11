import { spawnSync, type ChildProcess } from "node:child_process";

/**
 * adapter 共用的子程序終止工具(S8 迴歸修正時從 acp-adapter.ts 抽出來,讓
 * claude-sdk-adapter.ts 也能用同一套語意 —— 兩個 adapter 都會把子程序的 cwd
 * 設在任務 worktree 底下,`dispose()` 之後若子程序還活著,Windows 就無法刪除
 * 該目錄,`git worktree remove` 會得到 `Permission denied` / `EBUSY`)。
 */

/**
 * 終止一個子程序**連同它整棵子程序樹**。
 *
 * Windows:用 `taskkill /pid <pid> /T /F`。`/T` 是關鍵——被 spawn 出來的 CLI
 * 自己還會再開一堆子程序(Claude Code 會為每個設定好的 MCP server 開一個行程,
 * ACP agent 則可能經 `cmd.exe` shim 啟動),這些孫程序**同樣繼承了 cwd**,
 * 只殺直接子程序會把它們變成孤兒、繼續佔住 worktree 目錄。
 *
 * ⚠️ 時序前提:`/T` 是靠「當下的父子關係」找出整棵樹的,所以**必須趁直接
 * 子程序還活著時呼叫**。一旦父程序先自然結束,孫程序就成了孤兒,再也無法
 * 用這個 pid 找到它們(這正是 ClaudeAgentSdkAdapter 只呼叫 SDK 的
 * `Query.close()`(送 stdin EOF 後等它自己收工)時留下殘留行程的原因)。
 *
 * 非 Windows:維持既有行為,只對直接子程序送 SIGTERM。這裡**沒有**改用
 * process group kill(那需要 spawn 時就帶 `detached: true`,是另一個層級的
 * 行為變動),如實記錄這個限制:POSIX 上孫程序仍可能短暫存活,但 POSIX 沒有
 * 「目錄被行程當 cwd 就不能刪」這條限制,不會造成這裡要修的那個症狀。
 */
export function killProcessTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null || child.killed) return;
  if (process.platform === "win32") {
    if (child.pid) {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    }
  } else {
    child.kill("SIGTERM");
  }
}

/**
 * 等子程序真正 exit。
 *
 * 「送出終止指令」不等於「子程序已經死掉」——在 Windows 上,行程要再過一小段
 * 時間才會釋放它對 cwd(= 任務 worktree)的佔用。若 `dispose()` 在此之前就
 * resolve,呼叫端(TaskService.deleteTask → WorkspaceManager.removeWorkspace)
 * 會立刻 `git worktree remove`,撞上 `Permission denied` / `EBUSY`。
 *
 * 已經退出時立即回傳;逾時則**放棄等待且不丟錯**——呼叫端不該因為「等不到
 * 子程序死透」而失敗,這是 fail-safe 方向:最壞情況退回 WorkspaceManager
 * 既有的 worktree 刪除重試機制。
 */
export function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      child.removeListener("exit", done);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    timer.unref?.();
    child.once("exit", done);
  });
}
