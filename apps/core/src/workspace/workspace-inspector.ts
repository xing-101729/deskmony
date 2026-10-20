import fs from "node:fs";
import path from "node:path";
import {
  DeskmonyError,
  WORKSPACE_BINARY_SNIFF_BYTES,
  WORKSPACE_GIT_DIFF_MAX_BYTES,
  WORKSPACE_LIST_MAX_ENTRIES,
  WORKSPACE_READ_IMAGE_MAX_BYTES,
  WORKSPACE_READ_TEXT_MAX_BYTES,
  type Session,
  type WorkspaceEntry,
  type WorkspaceGitDiffResult,
  type WorkspaceGitStatusResult,
  type WorkspaceListDirResult,
  type WorkspaceReadFileResult,
} from "@deskmony/shared";
import { isPathUnder } from "../permissions/tool-input.js";
import {
  firstLine,
  neutralizingFilterOverrides,
  parseStatusZ,
  parseUnifiedDiff,
  runGit,
} from "./workspace-git.js";
import { isDotGitSegment, resolveExisting, resolveForGit, resolveRoot, type ResolvedExisting } from "./workspace-paths.js";

/**
 * WorkspaceInspector(2026-10-20,右側面板 P2,見 docs/LAYER-4-detail-design/side-panel_detail.md §P2.1、
 * docs/DECISIONS.md §L.1):session 工作資料夾的**唯讀**查詢——列資料夾、讀檔案、git status/diff。
 *
 * 全部唯讀,而且經過兩層防護:
 *  - **路徑**:每個 `path` 都過 `workspace-paths.ts` 的三道關(字面、realpath、前綴),見該檔頭的完整說明;
 *  - **git**:工作資料夾內容是 agent 能寫的(含 `.git/config`/`.gitattributes`),跑 git 不能因此執行到任意指令,
 *    見 `workspace-git.ts` 檔頭。
 *
 * 這個類別不認得 gateway 的連線/scoped token——`workspace.*` 不在任何 token 的方法白名單裡(agent 呼叫不到),
 * 也不列入 `LOCAL_ONLY_METHODS`(遠端已能開 shell,唯讀看檔是更弱的能力,DECISIONS §L.1)。
 */

export interface WorkspaceSessionLookup {
  getSession(sessionId: string): Promise<Session | undefined>;
}

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
const GIT_STATUS_MAX_BYTES = 4 * 1024 * 1024;
const LSTAT_BATCH = 64;

function notADirectory(raw: string): DeskmonyError {
  return new DeskmonyError("workspace.notADirectory", { path: raw }, `不是資料夾:${raw}`);
}

function notAFile(raw: string): DeskmonyError {
  return new DeskmonyError("workspace.notAFile", { path: raw }, `不是一般檔案:${raw}`);
}

/** 截斷在 UTF-8 多位元組字元中間時,把殘缺的尾端丟掉(否則解碼出一個 U+FFFD)。 */
function trimIncompleteUtf8(buffer: Buffer): Buffer {
  let end = buffer.length;
  // 往回找最後一個 lead byte(最多 3 個 continuation byte)。
  for (let back = 1; back <= 4 && end - back >= 0; back++) {
    const byte = buffer[end - back];
    if ((byte & 0xc0) === 0x80) continue; // continuation byte,繼續往前找 lead
    const needed = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return back < needed ? buffer.subarray(0, end - back) : buffer;
  }
  return buffer;
}

export class WorkspaceInspector {
  constructor(private readonly sessions: WorkspaceSessionLookup) {}

  private async workingDirOf(sessionId: string): Promise<string> {
    const session = await this.sessions.getSession(sessionId);
    if (!session) {
      throw new DeskmonyError("workspace.sessionNotFound", { sessionId }, `找不到 session: ${sessionId}`);
    }
    return session.workingDir;
  }

  // ---- listDir ------------------------------------------------------------------------------

  async listDir(sessionId: string, rawPath: string): Promise<WorkspaceListDirResult> {
    const resolved = resolveExisting(await this.workingDirOf(sessionId), rawPath);
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(resolved.targetReal);
    } catch (err) {
      throw ioError(err, rawPath);
    }
    if (!stat.isDirectory()) throw notADirectory(rawPath);

    let names: string[];
    try {
      names = await fs.promises.readdir(resolved.targetReal);
    } catch (err) {
      throw ioError(err, rawPath);
    }
    const visible = names.filter((name) => !isDotGitSegment(name));
    // 先依名稱排好、截到上限,再只對留下來的那些 lstat(`node_modules` 這類超大資料夾不必為幾萬筆各打一次 syscall)。
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
    visible.sort((a, b) => collator.compare(a, b));
    const truncated = visible.length > WORKSPACE_LIST_MAX_ENTRIES;
    const kept = truncated ? visible.slice(0, WORKSPACE_LIST_MAX_ENTRIES) : visible;

    const entries: WorkspaceEntry[] = [];
    for (let offset = 0; offset < kept.length; offset += LSTAT_BATCH) {
      const batch = kept.slice(offset, offset + LSTAT_BATCH);
      const stats = await Promise.all(
        batch.map(async (name): Promise<WorkspaceEntry | undefined> => {
          try {
            // lstat:symlink/junction 只標示(`symlink`)、不跟進——指向 root 外的也只是被列出來,點進去才會被 resolveExisting 拒絕。
            const st = await fs.promises.lstat(path.join(resolved.targetReal, name));
            const type = st.isSymbolicLink() ? "symlink" : st.isDirectory() ? "dir" : "file";
            return { name, type, size: type === "dir" ? 0 : st.size, mtimeMs: st.mtimeMs };
          } catch {
            return undefined; // 列出之後被刪掉了
          }
        }),
      );
      for (const entry of stats) if (entry) entries.push(entry);
    }
    // 資料夾在前(symlink 與檔案同一組,UI 點到時再判斷是不是資料夾),各組內維持名稱排序。
    entries.sort((a, b) => Number(b.type === "dir") - Number(a.type === "dir"));
    return { entries, truncated };
  }

  // ---- readFile -----------------------------------------------------------------------------

  async readFile(sessionId: string, rawPath: string): Promise<WorkspaceReadFileResult> {
    const resolved = resolveExisting(await this.workingDirOf(sessionId), rawPath);
    return this.readResolved(resolved, rawPath);
  }

  private async readResolved(resolved: ResolvedExisting, rawPath: string): Promise<WorkspaceReadFileResult> {
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(resolved.targetReal);
    } catch (err) {
      throw ioError(err, rawPath);
    }
    if (!stat.isFile()) throw notAFile(rawPath);
    const size = stat.size;

    const mime = IMAGE_MIME_BY_EXT[path.extname(resolved.targetReal).toLowerCase()];
    let handle: fs.promises.FileHandle | undefined;
    try {
      handle = await fs.promises.open(resolved.targetReal, "r");
      if (mime) {
        if (size > WORKSPACE_READ_IMAGE_MAX_BYTES) return { kind: "tooLarge", size };
        const data = await handle.readFile();
        return { kind: "image", mime, dataBase64: data.toString("base64"), size };
      }
      const sniff = Buffer.alloc(Math.min(size, WORKSPACE_BINARY_SNIFF_BYTES));
      const { bytesRead: sniffed } = await handle.read(sniff, 0, sniff.length, 0);
      if (sniff.subarray(0, sniffed).includes(0)) return { kind: "binary", size };
      const wanted = Math.min(size, WORKSPACE_READ_TEXT_MAX_BYTES);
      const body = Buffer.alloc(wanted);
      const { bytesRead } = await handle.read(body, 0, wanted, 0);
      const truncated = size > WORKSPACE_READ_TEXT_MAX_BYTES;
      const text = (truncated ? trimIncompleteUtf8(body.subarray(0, bytesRead)) : body.subarray(0, bytesRead)).toString("utf8");
      return { kind: "text", content: text, size, truncated };
    } catch (err) {
      if (err instanceof DeskmonyError) throw err;
      throw ioError(err, rawPath);
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  // ---- git ----------------------------------------------------------------------------------

  /** 這個工作資料夾是不是某個 git repo 的一部分,以及 status 輸出需要去掉的前綴;不是 → `undefined`。 */
  private async repoInfo(rootReal: string): Promise<{ prefix: string } | undefined> {
    const result = await runGit(["rev-parse", "--show-toplevel", "--show-prefix"], { cwd: rootReal, maxBytes: 64 * 1024 });
    if (result.code !== 0) {
      const message = result.stderr.toLowerCase();
      if (message.includes("not a git repository") || message.includes("must be run in a work tree")) return undefined;
      throw new DeskmonyError("workspace.gitFailed", { detail: firstLine(result.stderr) }, `git 執行失敗:${firstLine(result.stderr)}`);
    }
    const [toplevelRaw = "", prefixRaw = ""] = result.stdout.toString("utf8").split(/\r?\n/);
    // `core.worktree` 可以把工作樹指到別處(設定是 agent 能寫的):只認「工作資料夾真的在 toplevel 底下」的 repo。
    let toplevel = path.normalize(toplevelRaw);
    try {
      toplevel = fs.realpathSync.native(toplevel);
    } catch {
      return undefined;
    }
    if (!isPathUnder(rootReal, toplevel)) return undefined;
    return { prefix: prefixRaw };
  }

  async gitStatus(sessionId: string): Promise<WorkspaceGitStatusResult> {
    const rootReal = resolveRoot(await this.workingDirOf(sessionId));
    const repo = await this.repoInfo(rootReal);
    if (!repo) return { isRepo: false, branch: null, files: [], truncated: false };

    const configOverrides = await neutralizingFilterOverrides(rootReal);
    const result = await runGit(
      ["status", "--porcelain=v1", "-b", "-z", "--untracked-files=all", "--ignore-submodules=all", "--", "."],
      { cwd: rootReal, maxBytes: GIT_STATUS_MAX_BYTES, configOverrides },
    );
    if (result.code !== 0 && !result.truncated) {
      throw new DeskmonyError("workspace.gitFailed", { detail: firstLine(result.stderr) }, `git status 失敗:${firstLine(result.stderr)}`);
    }
    const parsed = parseStatusZ(result.stdout.toString("utf8"), repo.prefix);
    return { isRepo: true, branch: parsed.branch, files: parsed.files, truncated: parsed.truncated || result.truncated };
  }

  async gitDiff(sessionId: string, rawPath: string, rawOldPath?: string): Promise<WorkspaceGitDiffResult> {
    const workingDir = await this.workingDirOf(sessionId);
    // 路徑安全檢查在碰 git 之前:兩個路徑都要過(可以不存在——已刪除的追蹤檔)。
    const target = resolveForGit(workingDir, rawPath);
    const oldTarget = rawOldPath ? resolveForGit(workingDir, rawOldPath) : undefined;
    const rootReal = target.rootReal;
    const repo = await this.repoInfo(rootReal);
    if (!repo) throw new DeskmonyError("workspace.notARepo", undefined, "這個工作資料夾不是 git repo");

    const configOverrides = await neutralizingFilterOverrides(rootReal);
    const tracked = await runGit(["ls-files", "--error-unmatch", "-z", "--", target.relPosix], {
      cwd: rootReal,
      maxBytes: 64 * 1024,
      configOverrides,
    });
    if (tracked.code !== 0 && tracked.code !== 1) {
      throw new DeskmonyError("workspace.gitFailed", { detail: firstLine(tracked.stderr) }, `git 執行失敗:${firstLine(tracked.stderr)}`);
    }

    if (tracked.code === 0) {
      // 還沒有任何 commit 的 repo 沒有 HEAD:改對「空樹」比(全部顯示成新增)。空樹的雜湊依 repo 的雜湊演算法不同,問 git。
      const head = await runGit(["rev-parse", "--verify", "--quiet", "HEAD"], { cwd: rootReal, maxBytes: 4096 });
      let base = "HEAD";
      if (head.code !== 0) {
        const empty = await runGit(["hash-object", "-t", "tree", "--stdin"], { cwd: rootReal, maxBytes: 4096, input: "" });
        base = empty.stdout.toString("utf8").trim();
        if (empty.code !== 0 || !base) {
          throw new DeskmonyError("workspace.gitFailed", { detail: firstLine(empty.stderr) }, "git 執行失敗(找不到空樹)");
        }
      }
      const pathspecs = oldTarget && oldTarget.relPosix !== target.relPosix ? [target.relPosix, oldTarget.relPosix] : [target.relPosix];
      const diff = await runGit(
        ["diff", base, "--no-color", "--no-ext-diff", "--no-textconv", "--ignore-submodules=all", "-M", "-U3", "--", ...pathspecs],
        { cwd: rootReal, maxBytes: WORKSPACE_GIT_DIFF_MAX_BYTES, configOverrides },
      );
      if (diff.code !== 0 && !diff.truncated) {
        throw new DeskmonyError("workspace.gitFailed", { detail: firstLine(diff.stderr) }, `git diff 失敗:${firstLine(diff.stderr)}`);
      }
      const parsed = parseUnifiedDiff(diff.stdout.toString("utf8"));
      return { hunks: parsed.hunks, binary: parsed.binary, truncated: diff.truncated };
    }

    // 未追蹤:`git diff` 看不到它。讀出內容(同 readFile 的路徑安全檢查、同樣的大小/二進位判斷),組成全部新增的 hunk。
    const resolved = resolveExisting(workingDir, rawPath);
    const file = await this.readResolved(resolved, rawPath);
    if (file.kind !== "text") return { hunks: [], binary: true, truncated: false };
    const lines = file.content.length === 0 ? [] : file.content.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop(); // 以換行結尾時最後多一個空字串
    return {
      hunks: lines.length === 0 ? [] : [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines: lines.map((line) => `+${line}`) }],
      binary: false,
      truncated: file.truncated,
    };
  }
}

function ioError(err: unknown, raw: string): DeskmonyError {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT" || code === "ENOTDIR") return new DeskmonyError("workspace.notFound", { path: raw }, `找不到:${raw}`);
  if (code === "EACCES" || code === "EPERM") return new DeskmonyError("workspace.accessDenied", { path: raw }, `沒有權限讀取:${raw}`);
  const detail = err instanceof Error ? err.message : String(err);
  return new DeskmonyError("workspace.ioError", { path: raw, detail }, `讀取失敗:${raw}(${detail})`);
}
