import { spawn } from "node:child_process";
import { buildAgentChildEnv } from "@deskmony/adapters";
import {
  DeskmonyError,
  WORKSPACE_GIT_STATUS_MAX_FILES,
  type WorkspaceDiffHunk,
  type WorkspaceGitFile,
} from "@deskmony/shared";

/**
 * 在 session 的工作資料夾裡執行**唯讀**的 git 指令(2026-10-20,右側面板 P2,見 docs/LAYER-4-detail-design/side-panel_detail.md §P2.1)。
 *
 * ## 為什麼要這麼小心
 *
 * 工作資料夾的內容是 **agent 能寫的**(包含 `.git/config` 與 `.gitattributes`),而 Changes 分頁是**使用者**一打開就會跑
 * `git status`/`git diff` 的地方。git 的設定有好幾個會**執行任意指令**的鉤子——agent 只要埋一個,使用者看一眼 Changes 就等於
 * 在**政策引擎之外**以使用者身分執行了它(實測 git 2.38:`core.fsmonitor` 在 `git status` 時執行、`filter.<n>.clean` 在
 * `git diff` 時執行)。所以:
 *  - 一律 `-c core.fsmonitor=false`;diff 加 `--no-ext-diff --no-textconv`(`diff.external`/`diff.<n>.command`/`textconv`);
 *    `--ignore-submodules=all`(子模組的 status 會在子模組裡再起一個 git,吃它自己的設定);
 *  - **`filter.<n>.clean|smudge|process`**:`diff`/`status` 讀工作樹檔案時會經過 clean filter,沒有「全部關掉」的開關,
 *    只能對**出現的每一個** filter 名稱用 `-c filter.<n>.clean=` 覆寫成空(實測不會報錯、不會執行)。
 *    列舉**不限 scope**(`git config --includes --show-scope --name-only --get-regexp`,只讀設定、不執行任何東西):
 *    agent 寫得到的不只 `.git/config`(`local`)——`extensions.worktreeConfig=true` 時 git 還會讀 `.git/config.worktree`
 *    (`worktree`,`--local` 看不到,實測那裡的 clean filter 真的會執行),`include.path` 引進的檔案則沿用引入它的那個檔案的 scope。
 *    所以規則是 **fail-closed**:scope 不是 `system`/`global`(使用者自己的設定)的**一律中和**——`local`、`worktree`、`command`,
 *    以及 git 未來新增的任何 scope。`--show-scope`(git 2.26+)不被支援時退回:**所有 scope 的 filter 全部中和**(寧可多擋)。
 *    名稱若含 `=` 或控制字元(`-c key=value` 會在第一個 `=` 切開,蓋不到真正的 key)就拒絕執行——那一定是惡意設定;
 *    列舉本身失敗(結束碼不是 0/1)同樣拒絕執行,不能在不知道有哪些 filter 的情況下照跑。
 *    代價:repo **本地/worktree 層級**設定的 filter(例如 `git lfs install --local`)在這裡被停用,LFS 檔案可能顯示成「已修改」;
 *    使用者全域/系統層級設定的 filter(全域安裝的 LFS)不受影響。
 *  - 不經 shell(`spawn` + 參數陣列)、`windowsHide: true`、`--literal-pathspecs`(`:(top)`、`:!` 這類 pathspec 魔法不生效)、
 *    `--no-optional-locks`(唯讀:不為了重整 index 而寫 `index.lock`)、逾時、輸出大小上限;環境濾掉 Deskmony 內部憑證
 *    (`buildAgentChildEnv()`)與繼承來的 `GIT_*`(`GIT_DIR`、`GIT_WORK_TREE`…不能讓它們改變 git 看的 repo)。
 */

const GIT_TIMEOUT_MS = 10_000;
const STDERR_MAX_BYTES = 64 * 1024;
/** `-c` 覆寫與全域旗標:所有 git 呼叫共用。 */
const BASE_ARGS = ["--no-optional-locks", "--literal-pathspecs", "-c", "core.quotepath=off", "-c", "core.fsmonitor=false"];

export interface GitRunOptions {
  cwd: string;
  /** stdout 最多保留幾個位元組;超過就終止 git、`truncated: true`。 */
  maxBytes: number;
  timeoutMs?: number;
  /** 寫進 stdin 的內容(`hash-object --stdin` 用)。 */
  input?: string;
  /** 額外的 `-c` 覆寫(filter 中和),放在 `BASE_ARGS` 之後、子指令之前。 */
  configOverrides?: string[];
}

export interface GitResult {
  code: number | null;
  stdout: Buffer;
  stderr: string;
  truncated: boolean;
}

function gitEnv(): NodeJS.ProcessEnv {
  const env = buildAgentChildEnv({ GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C", LANG: "C" });
  for (const name of Object.keys(env)) {
    if (name.toUpperCase().startsWith("GIT_") && !["GIT_TERMINAL_PROMPT", "GIT_OPTIONAL_LOCKS"].includes(name)) delete env[name];
  }
  return env;
}

/** 執行 git。git 不存在 → `workspace.gitUnavailable`;逾時 → `workspace.gitFailed`;其餘(含非零結束碼)原樣回傳給呼叫端判斷。 */
export function runGit(args: string[], options: GitRunOptions): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("git", [...BASE_ARGS, ...(options.configOverrides ?? []), ...args], {
        cwd: options.cwd,
        env: gitEnv(),
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      reject(gitUnavailable(err));
      return;
    }
    const chunks: Buffer[] = [];
    let kept = 0;
    let truncated = false;
    let stderr = "";
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new DeskmonyError("workspace.gitFailed", { detail: "timeout" }, "git 執行逾時")));
    }, options.timeoutMs ?? GIT_TIMEOUT_MS);
    timer.unref?.();

    child.stdout?.on("data", (chunk: Buffer) => {
      if (truncated) return;
      const room = options.maxBytes - kept;
      if (chunk.length > room) {
        if (room > 0) chunks.push(chunk.subarray(0, room));
        kept = options.maxBytes;
        truncated = true;
        child.kill(); // 夠了:不必等 git 把剩下的吐完
        return;
      }
      chunks.push(chunk);
      kept += chunk.length;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < STDERR_MAX_BYTES) stderr += chunk.toString("utf8");
    });
    child.once("error", (err) => finish(() => reject(gitUnavailable(err))));
    child.once("close", (code) => finish(() => resolve({ code, stdout: Buffer.concat(chunks), stderr, truncated })));
    child.stdin?.on("error", () => undefined); // git 提早結束時寫 stdin 會 EPIPE,不是錯誤
    child.stdin?.end(options.input ?? "");
  });
}

function gitUnavailable(err: unknown): DeskmonyError {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT") return new DeskmonyError("workspace.gitUnavailable", undefined, "找不到 git(請確認 git 已安裝且在 PATH 裡)");
  const detail = err instanceof Error ? err.message : String(err);
  return new DeskmonyError("workspace.gitFailed", { detail }, `無法執行 git:${detail}`);
}

/** stderr 的第一行(給錯誤訊息用)。 */
export function firstLine(text: string): string {
  return text.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? "";
}

const FILTER_KEY_REGEXP = "^filter\\..+\\.(clean|smudge|process)$";
/** 使用者自己的設定層級:這些 scope 的 filter 保留(全域安裝的 LFS 要能照常運作);**其餘一律中和**(fail-closed)。 */
const TRUSTED_CONFIG_SCOPES = new Set(["system", "global"]);

function unsafeFilterConfig(): DeskmonyError {
  return new DeskmonyError("workspace.gitFailed", { detail: "unsafe repository config" }, "這個 repo 的 git 設定含有不安全的 filter 名稱,拒絕執行 git");
}

/**
 * 列舉會執行指令的 filter,產生把它們中和的 `-c` 覆寫。**不限 scope**、scope 不是 `system`/`global` 的一律中和,見檔頭。
 * 含 `=`/控制字元的名稱、列舉失敗 → 拒絕(`workspace.gitFailed`)。
 */
export async function neutralizingFilterOverrides(cwd: string): Promise<string[]> {
  const options = { cwd, maxBytes: 64 * 1024 };
  let scoped = true;
  let result = await runGit(["config", "--includes", "--show-scope", "--name-only", "--get-regexp", FILTER_KEY_REGEXP], options);
  // 結束碼 1 = 沒有符合的設定(正常)。其他非 0:最常見是 git 不認得 `--show-scope`(2.26 以前,用法錯誤)——退回「所有 scope 全部中和」。
  if (result.code !== 0 && result.code !== 1) {
    scoped = false;
    result = await runGit(["config", "--includes", "--name-only", "--get-regexp", FILTER_KEY_REGEXP], options);
    if (result.code !== 0 && result.code !== 1) {
      // 連列舉都做不到:不能在不知道有哪些 filter 的情況下照跑(fail-closed)。
      throw new DeskmonyError("workspace.gitFailed", { detail: firstLine(result.stderr) }, `git config 失敗:${firstLine(result.stderr)}`);
    }
  }
  const keys = new Set<string>();
  for (const line of result.stdout.toString("utf8").split(/\r?\n/)) {
    if (!line) continue;
    let key = line;
    if (scoped) {
      // `--show-scope` 的輸出是 `scope<TAB>key`;scope 名稱不含 tab,第一個 tab 就是分隔。
      const tab = line.indexOf("\t");
      if (tab < 0) throw unsafeFilterConfig();
      const scope = line.slice(0, tab);
      key = line.slice(tab + 1);
      if (TRUSTED_CONFIG_SCOPES.has(scope)) continue;
    }
    // eslint-disable-next-line no-control-regex
    if (key.includes("=") || /[\u0000-\u001f]/.test(key)) throw unsafeFilterConfig();
    keys.add(key);
  }
  const overrides: string[] = [];
  for (const key of keys) overrides.push("-c", `${key}=`);
  return overrides;
}

// ---- git status -z 解析 -------------------------------------------------------------------------

export interface ParsedStatus {
  branch: string | null;
  files: WorkspaceGitFile[];
  truncated: boolean;
}

function parseBranchHeader(header: string): string | null {
  // "## main...origin/main [ahead 1]"、"## main"、"## No commits yet on main"、"## Initial commit on main"、"## HEAD (no branch)"
  let rest = header.replace(/^## /, "");
  if (rest.startsWith("HEAD (no branch)")) return null;
  rest = rest.replace(/^No commits yet on /, "").replace(/^Initial commit on /, "");
  const upstream = rest.indexOf("...");
  if (upstream >= 0) rest = rest.slice(0, upstream);
  rest = rest.replace(/ \[.*\]$/, "");
  return rest.length > 0 ? rest : null;
}

/**
 * 解析 `git status --porcelain=v1 -b -z` 的輸出。`-z` 的格式:每筆以 NUL 結尾;第一筆是 `## 分支` 標頭;
 * 一般項目是 `XY 路徑`;**rename/copy**(X 或 Y 是 `R`/`C`)的項目後面**多帶一個欄位**——舊路徑(「新路徑\\0舊路徑\\0」)。
 * `prefix`:工作資料夾是 repo 的子資料夾時,`status` 輸出的路徑是 repo 根目錄相對的,這裡去掉那個前綴(結尾是 `/`)。
 */
export function parseStatusZ(output: string, prefix: string): ParsedStatus {
  const fields = output.split("\0");
  let index = 0;
  let branch: string | null = null;
  if (fields[0]?.startsWith("## ")) {
    branch = parseBranchHeader(fields[0]);
    index = 1;
  }
  const strip = (p: string): string => (prefix && p.startsWith(prefix) ? p.slice(prefix.length) : p);
  const files: WorkspaceGitFile[] = [];
  let truncated = false;
  while (index < fields.length) {
    const entry = fields[index++];
    if (!entry) continue; // 結尾的空欄位
    if (entry.length < 4 || entry[2] !== " ") continue; // 不是 "XY path"(防禦:略過看不懂的)
    const x = entry[0];
    const y = entry[1];
    const file: WorkspaceGitFile = { path: strip(entry.slice(3)), index: x, worktree: y };
    if (x === "R" || x === "C" || y === "R" || y === "C") {
      const old = fields[index++];
      if (old) file.oldPath = strip(old);
    }
    if (files.length >= WORKSPACE_GIT_STATUS_MAX_FILES) {
      truncated = true;
      break;
    }
    files.push(file);
  }
  return { branch, files, truncated };
}

// ---- git diff 解析 -------------------------------------------------------------------------------

export interface ParsedDiff {
  hunks: WorkspaceDiffHunk[];
  binary: boolean;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * 寬鬆地解析 `git diff` 的 unified diff 文字成 structuredPatch 形狀的 hunk(`DiffHunkView` 直接吃)。
 * 不用 `diff` 套件的 `parsePatch`:diff 文字可能被大小上限截斷在 hunk 中間,`parsePatch` 會因為行數對不上而丟例外;
 * 這裡只認 `@@ … @@` 標頭與其後的 ` `/`+`/`-`/`\\` 行,標頭之前(`diff --git`、`index`、`---`/`+++`)略過。
 * 二進位檔:`Binary files … differ` 或 `GIT binary patch`。
 */
export function parseUnifiedDiff(text: string): ParsedDiff {
  const hunks: WorkspaceDiffHunk[] = [];
  let binary = false;
  let current: WorkspaceDiffHunk | undefined;
  const lines = text.split("\n");
  // 文字以換行結尾時最後會多一個空字串。
  if (lines[lines.length - 1] === "") lines.pop();
  for (const line of lines) {
    const header = HUNK_HEADER.exec(line);
    if (header) {
      current = {
        oldStart: Number(header[1]),
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        lines: [],
      };
      hunks.push(current);
      continue;
    }
    if (line.startsWith("diff --git ")) {
      current = undefined;
      continue;
    }
    if (!current) {
      if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) binary = true;
      continue;
    }
    const marker = line.charAt(0);
    if (marker === " " || marker === "+" || marker === "-" || marker === "\\") current.lines.push(line);
    // 其他(例如 "\r" 殘留的空行)略過
  }
  return { hunks, binary };
}
