import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import type { AcceptanceCommandResult, AcceptanceResult, Task, Workspace } from "@deskmony/shared";

/**
 * AcceptanceRunner(S4 機器驗收閘,切片:量測半、諮詢性)。
 * 對應 [S4 L4](../../../../docs/LAYER-4-detail-design/acceptance-gate_detail.md)
 * §2/§3——**純執行,無狀態機知識**:只負責「照 `Task.acceptance` 跑指令、回結果」,
 * 完全不知道 TaskService 的狀態轉換規則,也不會擋任何轉換(裁決/Gate 留給
 * 呼叫端,見 L4 §0.1 的分離設計)。
 *
 * 執行細節全部釘死在 L4 §3,這裡逐項對應:
 *   - **cwd**:呼叫端(TaskService.runAcceptance())必須傳入該任務的
 *     `workspace.worktreePath`,絕不能是 team 的 baseDir——驗收要跑在這個
 *     任務專屬的 worktree 隔離環境裡,不會動到主幹或其他任務的檔案。
 *   - **shell**:用 Node `child_process.spawn(command, { shell: true })`——
 *     這正是 Node 官方文件記載的行為:Windows 上等同
 *     `cmd.exe /d /s /c <command>`,POSIX 上等同 `/bin/sh -c <command>`,
 *     與 L4 §3 釘死的 shell 選擇完全一致,不需要像
 *     `acp-adapter.ts`/`opencode-adapter.ts` 的 `resolveWindowsSpawnCommand()`
 *     那樣手動組 command/args——那個函式是給「呼叫一個特定執行檔 + args 陣列」
 *     用的(agent CLI 的 command/args 分開設定),這裡的 `acceptance.commands`
 *     是使用者填的**完整 shell 指令字串**(例如 `"npm test"`),語意上就是
 *     交給 shell 解析,`shell: true` 是最直接對應的做法。
 *   - **依序執行**:前一條非 0(或逾時)就立即停止,後續指令完全不執行、也
 *     不列入 `perCommand`(不是「列入但標記 skipped」)。
 *   - **逾時**:每條指令預設 10 分鐘(`DEFAULT_TIMEOUT_MS`),逾時時 kill 掉
 *     整個子程序樹(見 `killProcessTree()`,Windows 用 `taskkill /T /F`,
 *     比照 acp-adapter.ts/opencode-adapter.ts 既有的既有做法——`shell: true`
 *     時 `child.pid` 是 cmd.exe/sh 的 pid,單純 `kill()` 殺不到底下真正在跑的
 *     指令)。
 *   - **輸出截斷**:只保留末 8KB(stdout+stderr 合併,依到達順序交錯);為
 *     避免長時間跑的指令在裁剪之前於記憶體中無限增長,累積超過 2 倍上限時
 *     提前裁剪一次(`appendChunk()`),結束時再做最終裁剪。
 *   - **env**:只繼承 `process.env`,不注入任何 agent profile 的 env——這裡
 *     的函式簽章本來就不吃 `AgentProfile`,自然滿足這條規則。
 *   - **併發**:`runningTaskIds`(單一 Set,同一個 process 內的所有任務共用
 *     一個 AcceptanceRunner instance,見 task-service.ts 的建構方式)以
 *     taskId 為鍵加鎖,同一任務同時只能跑一次;重複請求丟出明確錯誤(呼叫端
 *     /gateway 會把它原樣轉成 `ok:false` 回應,文字內容即「執行中」的說明)。
 */

const DEFAULT_TIMEOUT_MS = 600_000; // 10 分鐘(L4 §3 釘死的預設值)
const OUTPUT_TAIL_BYTES = 8 * 1024; // 末 8 KB(L4 §3 釘死)
/** 執行期間內部緩衝區的軟上限(超過才提前裁剪一次),避免長輸出無限增長佔記憶體。 */
const OUTPUT_BUFFER_SOFT_LIMIT_BYTES = OUTPUT_TAIL_BYTES * 4;

export class AcceptanceRunner {
  /** 目前正在跑驗收的 taskId 集合(L4 §3「同一任務同時只能跑一次」的鎖)。 */
  private readonly runningTaskIds = new Set<string>();

  /**
   * @param task 必須含 `acceptance`(沒有則回 `skippedReason: "no-acceptance"`,
   *   不當成失敗)。
   * @param workspace 呼叫端(TaskService.runAcceptance())解析出的 Workspace;
   *   任務從未指派、或 workspaceId 指到的紀錄已不存在時傳 `undefined`,回
   *   `skippedReason: "workspace-missing"`。
   */
  async run(task: Task, workspace: Workspace | undefined): Promise<AcceptanceResult> {
    const startedAt = Date.now();

    if (!task.acceptance) {
      return { passed: false, perCommand: [], startedAt, finishedAt: Date.now(), skippedReason: "no-acceptance" };
    }
    if (!workspace) {
      return { passed: false, perCommand: [], startedAt, finishedAt: Date.now(), skippedReason: "workspace-missing" };
    }
    if (this.runningTaskIds.has(task.id)) {
      throw new Error(`任務 ${task.id} 的驗收目前正在執行中,請稍候再試`);
    }

    this.runningTaskIds.add(task.id);
    try {
      const perCommand: AcceptanceCommandResult[] = [];
      let passed = true;
      const timeoutMs = task.acceptance.timeoutMs ?? DEFAULT_TIMEOUT_MS;

      for (const command of task.acceptance.commands) {
        const result = await this.runOneCommand(command, workspace.worktreePath, timeoutMs);
        perCommand.push(result);
        if (result.timedOut || result.exitCode !== 0) {
          passed = false;
          break; // L4 §3:前一條非 0 → 立即停止,後續指令不執行、不列入 perCommand。
        }
      }

      return { passed, perCommand, startedAt, finishedAt: Date.now() };
    } finally {
      this.runningTaskIds.delete(task.id);
    }
  }

  private runOneCommand(command: string, cwd: string, timeoutMs: number): Promise<AcceptanceCommandResult> {
    return new Promise((resolve) => {
      const startedAt = Date.now();
      let output = "";
      let timedOut = false;
      let settled = false;

      // shell: true —— Windows 上 Node 會用 `cmd.exe /d /s /c <command>`,
      // POSIX 上用 `/bin/sh -c <command>`(見 class 頂端註解),正對應 L4 §3
      // 釘死的 shell 選擇。env 只繼承 process.env,不疊加任何 profile.env
      // (L4 §3:「驗收是人授權的基礎設施,不該帶 agent 的 API key」)。
      const child = spawn(command, {
        cwd,
        env: { ...process.env },
        shell: true,
        windowsHide: true,
      });

      const appendChunk = (chunk: Buffer): void => {
        output += chunk.toString("utf8");
        if (Buffer.byteLength(output, "utf8") > OUTPUT_BUFFER_SOFT_LIMIT_BYTES) {
          output = tailBytes(output, OUTPUT_BUFFER_SOFT_LIMIT_BYTES);
        }
      };
      child.stdout?.on("data", appendChunk);
      child.stderr?.on("data", appendChunk);

      const timer = setTimeout(() => {
        timedOut = true;
        killProcessTree(child);
      }, timeoutMs);

      const finish = (exitCode: number | null): void => {
        if (settled) return; // "error" 與 "close" 理论上只会有一个真正驱动 resolve,防御性避免重複 resolve。
        settled = true;
        clearTimeout(timer);
        resolve({
          command,
          exitCode: timedOut ? null : exitCode,
          timedOut,
          durationMs: Date.now() - startedAt,
          outputTail: tailBytes(output, OUTPUT_TAIL_BYTES),
        });
      };

      child.on("error", (err) => {
        output += `\n[spawn error] ${err.message}`;
        finish(null);
      });
      child.on("close", (code) => {
        finish(code);
      });
    });
  }
}

/** 取字串以 UTF-8 位元組計的末 N bytes(避免在多位元組字元中間切斷,寧可少切一點)。 */
function tailBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  // 從尾端往前找一個不落在 UTF-8 續位元組(0x80-0xBF)中間的切點,避免產生
  // 無法解碼的殘缺字元。
  let start = buf.length - maxBytes;
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) {
    start += 1;
  }
  return buf.subarray(start).toString("utf8");
}

/**
 * 逾時 kill 整個子程序樹(L4 §3)。`shell: true` 時 `child.pid` 是
 * cmd.exe(Windows)/sh(POSIX)的 pid,單純呼叫 `child.kill()` 殺不到底下
 * 真正在跑的指令——比照 `packages/adapters/src/acp-adapter.ts`/
 * `opencode-adapter.ts` 的 `killChild()` 既有做法:Windows 用
 * `taskkill /T /F` 連同子程序樹一起結束,POSIX 用 `SIGKILL`(逾時是我們主動
 * 要求終止,不是像 dispose() 那樣先禮貌性 SIGTERM 再升級,直接 SIGKILL 確保
 * 真的停下來,不需要再等一輪 SIGTERM 的優雅關閉)。
 */
function killProcessTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.killed) return;
  if (process.platform === "win32") {
    if (child.pid) {
      spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    }
  } else {
    child.kill("SIGKILL");
  }
}
