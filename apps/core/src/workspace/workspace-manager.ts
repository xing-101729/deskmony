import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import type { NexusDb } from "@deskmony/db";
import { workspaces as workspacesTable } from "@deskmony/db";
import { DeskmonyError, ErrorCodes, type Workspace } from "@deskmony/shared";

/**
 * WorkspaceManager(ARCHITECTURE.md 3.3 節):
 *   「為任務建立 git worktree、追蹤 diff、合併/清理」
 *
 * 這輪(M4 Round A)只做「建立 / 清理」這兩端;diff 追蹤與合併留給看板 UI
 * 落地的 Round B(3.1 節 Diff 檢視器)再決定要不要串進來。
 *
 * ---- worktree 佈局與命名(設計決策)----
 *
 * `baseDir`(= team.workingDir)本身必須是一個 git repo(見 assertIsGitRepo,
 * README 有對應說明:「team workingDir 需為 git repo 才能用任務 worktree
 * 隔離」)。worktree 一律建在 `baseDir` 的**同層目錄**下一個統一的
 * `.deskmony-worktrees/` 資料夾裡(不是 baseDir 內部、也不是系統暫存目錄):
 *
 *   <dirname(baseDir)>/.deskmony-worktrees/<basename(baseDir)>-task-<shortId>/
 *
 * 選這個位置而不是「baseDir 內部」或「系統暫存目錄」的原因:
 *   - git worktree 技術上可以放在 baseDir 內部(只要不在 .git 目錄裡),但
 *     放在 repo 內部容易被使用者的 .gitignore/IDE 檔案監控意外掃到,語意上
 *     也怪(工作區目錄裡混著別的 worktree)。
 *   - 系統暫存目錄(os.tmpdir())的缺點是可能被系統清理策略定期清空,而任務
 *     worktree 應該要在任務完成前持續存在,不該有被靜默清掉的風險。
 *   - 「baseDir 旁邊」在使用者檔案總管裡容易被看到、找到,又不會弄髒 repo
 *     本身,是這兩者間的折衷。
 * `basename(baseDir)` 前綴是為了同一台機器上有多個不同 repo 的 team 時,
 * 各自的 worktree 資料夾不會撞在同一個 `.deskmony-worktrees/` 下混在一起難以
 * 分辨屬於哪個專案。
 *
 * 分支命名:`deskmony/task-<shortId>`(`shortId` = `task.id`(uuid)前 8
 * 碼)—— 用 task id 保證同一個任務只會有一個對應分支(可預期、可重建路徑,
 * 不需要另外查表);用短 id 而非完整 uuid 是為了讓分支名/路徑名不要過長
 * (Windows 路徑長度限制仍是實務上的隱患,雖然這台機器啟用了長路徑支援)。
 * 8 碼 uuid 前綴的碰撞機率在單一 team 的任務規模下可忽略。
 *
 * ---- Windows / 子程序呼叫 ----
 *
 * 一律用 `execFile("git", [...])`(陣列參數,不組字串、不開 shell),避免:
 *   (1) shell 注入風險(worktreePath/branch 都是程式產生的字串,但仍遵循
 *       「不用字串組指令」的最佳實踐,不依賴自己相信輸入是乾淨的);
 *   (2) 路徑含空白時的引號問題 —— execFile 的陣列參數由 Node 底層負責正確
 *       傳遞給子程序,不需要手動 quoting(這點與 AcpAdapter 的
 *       resolveWindowsSpawnCommand() 处理 shell:true 情境下需要手動 quoting
 *       是不同的情境:這裡完全不使用 shell)。
 */
/** removeWorkspace() 的結果 —— 見下方方法內的說明。 */
export interface RemoveWorkspaceResult {
  /** worktree 移除前,裡面是否還有未 commit 的變更(不阻擋刪除,純粹供上層/UI 警告用)。 */
  hadUncommittedChanges: boolean;
}

/**
 * mergeWorkspace() 合併衝突時丟出的錯誤 —— 帶上衝突檔案清單,供呼叫端組出人類
 * 可讀的訊息。i18n 專案新增:改為繼承 `DeskmonyError`,`conflictFiles` 搬進
 * `params`(隨 WS response 的 `errorParams` 原樣序列化過網路給前端),不再是
 * 「碰到 WS gateway 的 generic catch-all 就被靜默丟掉」的 subclass-only 欄位
 * ——同時保留 `conflictFiles` 這個公開存取器,維持既有呼叫端(若有)的存取方式
 * 不需要改成 `err.params?.conflictFiles`。
 */
export class MergeConflictError extends DeskmonyError {
  constructor(fallbackMessage: string, conflictFiles: string[]) {
    super("workspace.mergeConflict", { conflictFiles }, fallbackMessage);
    this.name = "MergeConflictError";
  }

  get conflictFiles(): string[] {
    return (this.params?.conflictFiles as string[] | undefined) ?? [];
  }
}

export class WorkspaceManager {
  /**
   * @param worktreesRootOverride M6 Round A 新增(對應 `config.workspace.worktreesRoot`,
   *   見 packages/shared/src/core-config.ts):提供時,所有 team 的任務
   *   worktree 一律建在這個固定目錄下(不再各自算在 `dirname(baseDir)` 旁邊),
   *   `undefined`(未設定)時完全維持既有的動態算法——見下方
   *   `createWorkspaceForTask()` 與 class 頂端註解「worktree 佈局與命名」。
   */
  constructor(
    private readonly db: NexusDb,
    private readonly worktreesRootOverride?: string,
  ) {}

  /** 為一個任務建立 git worktree,持久化 Workspace 紀錄並回傳。 */
  async createWorkspaceForTask(input: { taskId: string; baseDir: string }): Promise<Workspace> {
    await this.assertIsGitRepo(input.baseDir);

    const shortId = input.taskId.replace(/-/g, "").slice(0, 8);
    const worktreeRoot = this.worktreesRootOverride ?? path.join(path.dirname(input.baseDir), ".deskmony-worktrees");
    const worktreePath = path.join(worktreeRoot, `${path.basename(input.baseDir)}-task-${shortId}`);
    const branch = `deskmony/task-${shortId}`;

    await fs.promises.mkdir(worktreeRoot, { recursive: true });
    await this.git(["worktree", "add", worktreePath, "-b", branch], input.baseDir);

    const workspace: Workspace = {
      id: randomUUID(),
      taskId: input.taskId,
      baseDir: input.baseDir,
      worktreePath,
      branch,
      createdAt: Date.now(),
    };
    await this.db.insert(workspacesTable).values(workspaceToRow(workspace)).run();
    return workspace;
  }

  async getWorkspace(id: string): Promise<Workspace | undefined> {
    const rows = await this.db.select().from(workspacesTable).where(eq(workspacesTable.id, id)).all();
    return rows[0] ? rowToWorkspace(rows[0]) : undefined;
  }

  /**
   * S6(crash-recovery)新增:worktree 目錄是否還存在於磁碟上(§6「worktree 已
   * 被外部刪除」的偵測用,見 crash-recovery_detail.md §6 失敗模式表)。純
   * `fs.existsSync`,不觸發任何 git 指令(worktree 目錄不存在時執行 git 指令
   * 只會得到不好懂的錯誤訊息)。
   */
  worktreeExists(workspace: Workspace): boolean {
    return fs.existsSync(workspace.worktreePath);
  }

  /**
   * S6 新增:worktree 目前是否有未 commit 的變更,不做任何清理動作(純查詢,
   * 與 `removeWorkspace()` 內嵌的一次性檢查邏輯相同,獨立拉出來給復原視圖用
   * ——`recovery.list`/`recovery.rerun` 都需要在不刪除 worktree 的前提下知道
   * 這件事)。呼叫前應先確認 `worktreeExists()`。
   */
  async isDirty(workspace: Workspace): Promise<boolean> {
    const result = await this.git(["status", "--porcelain"], workspace.worktreePath);
    return result.stdout.trim().length > 0;
  }

  /**
   * S6 新增:「重跑」前顯示 diff 用(crash-recovery_detail.md §5.2「先顯示
   * diff(既有 diff 檢視能力)」——查證後這個能力**其實不存在**,desktop UI
   * 目前完全沒有任何 diff 檢視元件,這裡是新增的最小實作,見最終報告的
   * L4 落差說明)。回傳 `git status --porcelain` 與 `git diff`(只涵蓋已追蹤
   * 檔案的修改;新增的未追蹤檔案只會出現在 status,不會出現在 diff 內容裡
   * ——這是 `git diff` 本身的行為,不特別用 `--no-index`/`add -N` 模擬,保持
   * 這是唯讀查詢、不改動 worktree 任何狀態)。
   */
  async statusAndDiff(dir: string): Promise<{ status: string; diff: string }> {
    const [statusResult, diffResult] = await Promise.all([
      this.git(["status", "--porcelain"], dir),
      this.git(["diff"], dir).catch((err) => ({ stdout: `(git diff 失敗: ${err instanceof Error ? err.message : String(err)})`, stderr: "" })),
    ]);
    return { status: statusResult.stdout, diff: diffResult.stdout };
  }

  /**
   * S6 新增:「重跑」對髒 worktree 的「保留」選項——把目前未 commit 的變更
   * commit 到一個新的 wip 分支,再把 worktree 切回原本的任務分支(乾淨狀態),
   * 見 crash-recovery_detail.md §5.2「保留(建 wip 分支並 commit)」。
   *
   * 步驟(全程只在 `workspace.worktreePath` 內操作,不動 `baseDir`):
   *   1. `git switch -c <wipBranch>`——從目前分支(`workspace.branch`)切出新
   *      分支,`switch -c` 會保留尚未 commit 的工作目錄變更(不像
   *      `checkout -b` 需要額外注意,但兩者在這個情境下行為等價,選 `switch`
   *      是比較新的 git 慣用法)。
   *   2. `git add -A && git commit`——把變更定格在 wip 分支上。
   *   3. `git switch <workspace.branch>`——切回任務分支;此時工作目錄相對於
   *      wip 分支的最後一次 commit 是乾淨的,`switch` 本身的 checkout 動作會
   *      讓工作目錄變成任務分支的乾淨狀態(沒有殘留的未 commit 變更)。
   */
  async commitDirtyToWipBranch(workspace: Workspace, wipBranch: string): Promise<void> {
    await this.git(["switch", "-c", wipBranch], workspace.worktreePath);
    await this.git(["add", "-A"], workspace.worktreePath);
    await this.git(["commit", "-m", `wip: recovery snapshot before rerun (task branch: ${workspace.branch})`], workspace.worktreePath);
    await this.git(["switch", workspace.branch], workspace.worktreePath);
  }

  /**
   * S6 新增:「重跑」對髒 worktree 的「丟棄」選項——`git reset --hard` +
   * `git clean -fd`,見 crash-recovery_detail.md §5.2。**呼叫端必須先取得
   * 明確的二次確認**(見 RecoveryService.resolveDirtyWorktree()),這個方法
   * 本身不做確認檢查——它是純執行層,把握關卡設在呼叫端統一把關,避免兩層
   * 各自判斷而漂移。
   */
  async discardDirty(workspace: Workspace): Promise<void> {
    await this.git(["reset", "--hard"], workspace.worktreePath);
    await this.git(["clean", "-fd"], workspace.worktreePath);
  }

  /**
   * M4 Round B:把一個任務的 worktree 分支合併回主幹 —— ARCHITECTURE.md 第 5
   * 節「Merging --> Done : worktree 合併回主幹」這句話這輪才真正落地(M4
   * Round A 的備註明講「這輪沒有自動化實作」)。呼叫端是
   * `TaskService.mergeAndComplete()`,而它只會被 `task.merge` gateway 方法
   * 呼叫 —— `task.merge` 是人類從 UI 觸發的動作,agent 端沒有對應的 MCP 工具
   * (見 `TaskService.tryApplyReportStatus()` 明確擋掉 "done" 這個目標的說明),
   * 這是「Review 環節可設定必須人類批准才能合併(預設開啟)」這句話的具體實作。
   *
   * 設計決策:
   *  - **主幹分支偵測**(不寫死 "master"):優先讀 `git symbolic-ref
   *    refs/remotes/origin/HEAD`(有設定遠端時最準確);沒有遠端或沒設定時,
   *    退回檢查本機是否存在 `main` 或 `master` 分支(依序),都找不到就丟出
   *    明確錯誤 —— 不猜測、不假設。
   *  - **合併前置條件**:`baseDir` 必須乾淨(`git status --porcelain` 無輸出)
   *    才會進行 —— 合併需要把 `baseDir` checkout 到主幹分支上執行
   *    `git merge`,若 `baseDir` 目前有未 commit 的變更就切換分支/合併,可能
   *    弄丟使用者在主幹上還沒 commit 的工作,所以刻意在這種情況下直接拒絕
   *    (丟出明確錯誤,不嘗試 stash 或其他自動化犧牲使用者資料的做法)。
   *  - **衝突處理**:`git merge --no-ff <branch>` 失敗時,不留下半完成的
   *    merge 狀態 —— 用 `git status --porcelain` 找出真正處於「未合併」
   *    (`U`/`AA`/`DD` 開頭)狀態的檔案清單,接著呼叫 `git merge --abort`
   *    把 `baseDir` 還原成合併前的乾淨狀態,再把衝突檔案清單包進
   *    `MergeConflictError` 往外丟(任務狀態留在 "merging" 由呼叫端
   *    `TaskService.mergeAndComplete()` 保證 —— 這裡丟錯誤,呼叫端就不會走到
   *    `updateStatus(taskId, "done")` 那一步)。
   *  - 全程一律 `execFile("git", [...])` 陣列參數,不組字串、不開 shell,理由
   *    同 class 頂端註解。
   */
  async mergeWorkspace(workspace: Workspace): Promise<{ mainBranch: string }> {
    await this.assertIsGitRepo(workspace.baseDir);
    const mainBranch = await this.detectMainBranch(workspace.baseDir);

    const dirtyStatus = await this.git(["status", "--porcelain"], workspace.baseDir);
    if (dirtyStatus.stdout.trim().length > 0) {
      throw new DeskmonyError(
        "workspace.baseDirDirty",
        { baseDir: workspace.baseDir, status: dirtyStatus.stdout },
        `baseDir(${workspace.baseDir})有未 commit 的變更,為避免合併過程弄丟使用者的工作,拒絕在此狀態下執行合併,` +
          `請先手動 commit 或處理乾淨後再試一次。\n${dirtyStatus.stdout}`,
      );
    }

    const currentBranch = (await this.git(["rev-parse", "--abbrev-ref", "HEAD"], workspace.baseDir)).stdout.trim();
    if (currentBranch !== mainBranch) {
      await this.git(["checkout", mainBranch], workspace.baseDir);
    }

    try {
      await this.git(
        ["merge", "--no-ff", workspace.branch, "-m", `Merge task branch '${workspace.branch}' into ${mainBranch}`],
        workspace.baseDir,
      );
    } catch (err) {
      const statusAfterFailure = await this.git(["status", "--porcelain"], workspace.baseDir).catch(
        () => ({ stdout: "", stderr: "" }),
      );
      const conflictFiles = statusAfterFailure.stdout
        .split(/\r?\n/)
        .filter((line) => /^(UU|AA|DD|AU|UA|UD|DU)\s/.test(line))
        .map((line) => line.slice(3).trim())
        .filter(Boolean);

      // 無論是否偵測到衝突檔案,都嘗試 abort 還原 —— `git merge --abort` 在
      // 「其實沒有進行中的 merge」時本身會失敗("fatal: There is no merge to
      // abort"),這種情況不影響判斷(代表 merge 一開始就沒有真的進入衝突
      // 狀態,baseDir 本來就還是乾淨的),忽略即可。
      await this.git(["merge", "--abort"], workspace.baseDir).catch(() => {});

      throw new MergeConflictError(
        `合併分支 "${workspace.branch}" 到 "${mainBranch}" 發生衝突,已執行 git merge --abort 還原 baseDir 到合併前狀態。` +
          `衝突檔案: ${conflictFiles.length > 0 ? conflictFiles.join(", ") : "(無法從 git status 判讀,見原始錯誤)"}\n` +
          `原始錯誤: ${err instanceof Error ? err.message : String(err)}`,
        conflictFiles,
      ); // 見上方 MergeConflictError 類別註解——conflictFiles 已隨 params 帶到前端。
    }

    return { mainBranch };
  }

  /**
   * 清理一個 workspace:`git worktree remove --force` + 可選刪分支,最後刪除
   * DB 紀錄。刻意不在任務進入 "done" 時自動觸發(見
   * apps/core/src/tasks/task-service.ts 的說明)—— 只有明確呼叫
   * `task.delete` 才會走到這裡,讓已完成的任務仍保留 worktree 供人類事後
   * 檢視 diff。
   *
   * M4 Round B:刪除前先檢查 worktree 裡是否還有未 commit 的變更
   * (`git status --porcelain`),回傳 `hadUncommittedChanges` 旗標 ——
   * **不阻擋刪除**(`--force` 的語意就是使用者/呼叫端已經確認要刪,這裡只是
   * 事後讓上層/UI 能警告「剛才刪掉的 worktree 裡其實還有沒存的變更」,而不是
   * 在刪除前擋下來要求二次確認 —— task.delete 這條路徑目前沒有「先檢查再決定
   * 要不要繼續」的分階段設計,見 TaskService.deleteTask() 與 WsGateway 的
   * task.delete case)。
   */
  async removeWorkspace(
    workspace: Workspace,
    opts: { deleteBranch?: boolean } = {},
  ): Promise<RemoveWorkspaceResult> {
    let hadUncommittedChanges = false;
    if (fs.existsSync(workspace.worktreePath)) {
      try {
        const statusResult = await this.git(["status", "--porcelain"], workspace.worktreePath);
        hadUncommittedChanges = statusResult.stdout.trim().length > 0;
      } catch {
        // 查詢失敗(例如 worktree 已經處於某種壞掉的狀態)不應該阻擋刪除本身,
        // 保守地當作「無法判斷,視為沒有未 commit 變更」,忽略錯誤繼續往下走。
      }
    }

    // S8(agent-lifecycle):ephemeral member 的 session 現在會自動 spawn 在這個
    // worktree 底下(見 apps/core/src/tasks/task-service.ts 的
    // `disposeEphemeralMemberSession()`——`task.delete`/任務轉 done 時會先
    // dispose 該 session,幾乎緊接著才呼叫這裡)。`adapter.dispose()` resolve
    // 不保證 Windows 已經完全釋放子程序對這個目錄的檔案控點(即時掃毒/索引器
    // 也可能短暫鎖住剛結束的程序留下的檔案)——實測發現偶發
    // "Permission denied"/EBUSY。這在 S8 之前不會發生(task.assign 從不 spawn
    // 任何東西,worktree 底下不會有真的活過的子程序),是這輪新增自動生命週期
    // 管理後才會出現的競態。
    try {
      await this.git(["worktree", "remove", workspace.worktreePath, "--force"], workspace.baseDir);
    } catch (err) {
      // worktree 目錄可能已經被使用者手動刪除,`worktree remove` 在這種情況
      // 下會失敗(git 認得這個路徑但磁碟上東西不在了)。用 `worktree prune`
      // 清掉 git 內部殘留的 metadata。**這一步之後,即使目錄仍存在,git 也已經
      // 不再把它當成一個 worktree**(`.git/worktrees/<name>` 的 metadata 已被
      // 移除)——重複呼叫 `git worktree remove` 只會得到一個新的、無助於解決
      // 問題的錯誤("... is not a working tree"),所以下面改用純檔案系統的
      // `fs.rm` 重試,不再重複呼叫 git。
      await this.git(["worktree", "prune"], workspace.baseDir).catch(() => {
        // prune 失敗不影響後續判斷,忽略。
      });
      if (fs.existsSync(workspace.worktreePath)) {
        const REMOVE_RETRY_ATTEMPTS = 4;
        const REMOVE_RETRY_DELAY_MS = 300;
        let rmErr: unknown;
        for (let attempt = 1; attempt <= REMOVE_RETRY_ATTEMPTS; attempt++) {
          try {
            await fs.promises.rm(workspace.worktreePath, { recursive: true, force: true });
            rmErr = undefined;
            break;
          } catch (e) {
            rmErr = e;
            if (attempt < REMOVE_RETRY_ATTEMPTS) {
              await new Promise((resolve) => setTimeout(resolve, REMOVE_RETRY_DELAY_MS * attempt));
            }
          }
        }
        if (rmErr && fs.existsSync(workspace.worktreePath)) {
          // 重試用盡後路徑仍然存在,代表是真正的清理失敗(例如檔案被長期鎖住),
          // 原樣往外丟明確錯誤,不靜默吞掉。
          const detail = err instanceof Error ? err.message : String(err);
          const rmDetail = rmErr instanceof Error ? rmErr.message : String(rmErr);
          throw new DeskmonyError(
            "workspace.cleanupFailed",
            { worktreePath: workspace.worktreePath, retries: REMOVE_RETRY_ATTEMPTS, detail, rmDetail },
            `清理 worktree 失敗(${workspace.worktreePath} 仍存在於磁碟上,已重試 ${REMOVE_RETRY_ATTEMPTS} 次): ` +
              `${detail}; 後續刪除目錄也失敗: ${rmDetail}`,
          );
        }
      }
    }

    if (opts.deleteBranch) {
      try {
        await this.git(["branch", "-D", workspace.branch], workspace.baseDir);
      } catch (err) {
        // 分支刪除失敗(例如已經被使用者手動刪除或改名)不應該阻擋 worktree
        // 本身的清理已經完成 —— 只記錄警告,不拋出。
        console.warn(`[workspace-manager] 刪除分支 ${workspace.branch} 失敗(忽略): ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    await this.db.delete(workspacesTable).where(eq(workspacesTable.id, workspace.id)).run();
    return { hadUncommittedChanges };
  }

  /**
   * mergeWorkspace() 用:偵測主幹分支名稱,不寫死 "master"。
   *   1. 優先讀 `git symbolic-ref refs/remotes/origin/HEAD`(有設定遠端追蹤
   *      時最準確,直接反映遠端預設分支)。
   *   2. 失敗(通常是沒有設定遠端,例如本機自建的 repo)時,依序檢查本機是否
   *      存在名為 `main`、`master` 的分支,存在就使用第一個找到的。
   *   3. 都找不到就丟出明確錯誤,不猜測、不預設任何名字。
   */
  private async detectMainBranch(baseDir: string): Promise<string> {
    try {
      const { stdout } = await this.git(["symbolic-ref", "refs/remotes/origin/HEAD"], baseDir);
      const match = stdout.trim().match(/^refs\/remotes\/origin\/(.+)$/);
      if (match) return match[1];
    } catch {
      // 沒有設定遠端追蹤分支,退回檢查本機分支。
    }

    for (const candidate of ["main", "master"]) {
      try {
        await this.git(["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`], baseDir);
        return candidate;
      } catch {
        // 這個候選分支不存在,試下一個。
      }
    }

    throw new DeskmonyError(
      "workspace.mainBranchNotDetected",
      { baseDir },
      `無法偵測主幹分支名稱(baseDir=${baseDir}):沒有設定 origin 遠端追蹤分支,本機也找不到 main 或 master 分支。`,
    );
  }

  /** baseDir 必須是一個 git repo,否則丟出明確錯誤(不靜默失敗,見 README 說明)。 */
  private async assertIsGitRepo(dir: string): Promise<void> {
    if (!fs.existsSync(dir)) {
      throw new DeskmonyError(
        "workspace.workingDirMissing",
        { dir },
        `team workingDir 不存在,無法建立任務 worktree 隔離: ${dir}`,
      );
    }
    try {
      await this.git(["rev-parse", "--is-inside-work-tree"], dir);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new DeskmonyError(
        "workspace.workingDirNotGitRepo",
        { dir, detail },
        `team workingDir 不是 git repo,無法建立任務 worktree 隔離(需要先在該目錄 \`git init\`): ${dir}(${detail})`,
      );
    }
  }

  /** 統一的 git 子程序呼叫:execFile 陣列參數(不用 shell、不組字串),收集 stderr 供錯誤訊息使用。 */
  private git(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      execFile("git", args, { cwd }, (error, stdout, stderr) => {
        if (error) {
          const detail = (stderr || error.message).trim();
          reject(
            new DeskmonyError(
              "workspace.gitCommandFailed",
              { command: args.join(" "), cwd, detail },
              `git ${args.join(" ")} 失敗(cwd=${cwd}): ${detail}`,
            ),
          );
          return;
        }
        resolve({ stdout, stderr });
      });
    });
  }
}

function rowToWorkspace(row: typeof workspacesTable.$inferSelect): Workspace {
  return {
    id: row.id,
    taskId: row.taskId,
    baseDir: row.baseDir,
    worktreePath: row.worktreePath,
    branch: row.branch,
    createdAt: row.createdAt,
  };
}

function workspaceToRow(workspace: Workspace): typeof workspacesTable.$inferInsert {
  return {
    id: workspace.id,
    taskId: workspace.taskId,
    baseDir: workspace.baseDir,
    worktreePath: workspace.worktreePath,
    branch: workspace.branch,
    createdAt: workspace.createdAt,
  };
}
