import fs from "node:fs";
import path from "node:path";
import { DeskmonyError } from "@deskmony/shared";
import { isPathUnder } from "../permissions/tool-input.js";

/**
 * workspace 唯讀查詢的**路徑安全**(2026-10-20,右側面板 P2,見 docs/LAYER-4-detail-design/side-panel_detail.md §P2.1、
 * docs/DECISIONS.md §L.1)——整個 P2 最重要的一段。
 *
 * 威脅:呼叫端(含遠端 client)能指定 `path`,core 替它讀檔/列資料夾。只要 `path` 能跑出 session 的工作資料夾(root),
 * 這就是任意檔案讀取。所以每個 `path` 都過三道關,**任何一道不過一律 `workspace.pathOutsideRoot`**:
 *
 *  1. **字面檢查**(`parseRelativePath`):必須是相對路徑、以 `/` 分隔;絕對路徑(`/x`、`C:\\x`、`C:x`、`\\\\server\\share`、
 *     `//server/share`)、`..` 片段、NUL、Windows 上的反斜線/磁碟機/資料流冒號/保留裝置名/結尾是點或空白的片段(Win32 會把
 *     `.. `、`...` 這類片段正規化掉)全部拒絕。字面檢查是第一道、不是唯一一道。
 *  2. **realpath**(`resolveExisting`):目標**必須存在**,用 `fs.realpathSync.native` 取真實路徑——它會解開 symlink、
 *     junction、掛載點與 8.3 短檔名(Windows 走 `GetFinalPathNameByHandle`,結果是系統認定的最終路徑)。不存在就是
 *     `workspace.notFound`,**不**像 `tool-input.ts` 的 `resolveRealpathBestEffort()` 那樣往上找祖先:那個是給政策判斷用的
 *     (「這個路徑若建出來會在哪裡」),這裡要的是「這個檔案現在真的在哪裡」。root 本身也取 realpath。
 *  3. **前綴比對**:真實路徑必須在 root 的真實路徑之下,沿用 `tool-input.ts` 的 `isPathUnder()`(以路徑分隔符為界、
 *     Windows 上大小寫不敏感)。
 *
 * 已知限制(誠實記錄):檢查與實際讀取之間有 TOCTOU 視窗——有人在這個視窗內把 root 裡的資料夾換成指向外面的連結。
 * 能這樣做的人已經能直接在 root 裡寫檔(agent 本來就有),而我們讀的是唯讀內容、不跟進最後一段 symlink 以外的東西;
 * 不為此引入 `O_NOFOLLOW` 一路開檔的複雜度。
 */

const WIN = process.platform === "win32";
/** Windows 的保留裝置名(`CON`、`NUL.txt`…)——開了會卡住或讀到裝置,而不是檔案。 */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

function outside(raw: string): DeskmonyError {
  return new DeskmonyError("workspace.pathOutsideRoot", { path: raw }, `路徑不在 session 的工作資料夾內:${raw}`);
}

/** 字面檢查,回傳正規化後的片段(已去掉空片段與 `.`)。違反任何規則 → `workspace.pathOutsideRoot`。 */
export function parseRelativePath(raw: string): string[] {
  if (typeof raw !== "string" || raw.includes("\0")) throw outside(String(raw));
  // 絕對路徑的各種寫法——**不分平台一律拒絕**(POSIX 風格的 `/etc/passwd` 在 Windows 上會被解成目前磁碟機根目錄,反之亦然)。
  if (raw.startsWith("/") || raw.startsWith("\\") || /^[A-Za-z]:/.test(raw)) throw outside(raw);
  if (WIN && raw.includes("\\")) throw outside(raw);
  const segments: string[] = [];
  for (const segment of raw.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") throw outside(raw);
    if (WIN) {
      if (segment.includes(":") || /[. ]$/.test(segment) || WINDOWS_RESERVED.test(segment)) throw outside(raw);
    }
    segments.push(segment);
  }
  return segments;
}

/** `.git` 資料夾(不分大小寫):列表隱藏它,讀取也當它不存在(裡面有 remote URL 等設定,不該經由這條唯讀通道外流)。 */
export function isDotGitSegment(segment: string): boolean {
  return segment.toLowerCase() === ".git";
}

function realpathNative(p: string): string {
  return fs.realpathSync.native(p);
}

function mapFsError(err: unknown, raw: string): DeskmonyError {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP") {
    return new DeskmonyError("workspace.notFound", { path: raw }, `找不到:${raw}`);
  }
  if (code === "EACCES" || code === "EPERM") {
    return new DeskmonyError("workspace.accessDenied", { path: raw }, `沒有權限讀取:${raw}`);
  }
  const detail = err instanceof Error ? err.message : String(err);
  return new DeskmonyError("workspace.ioError", { path: raw, detail }, `讀取失敗:${raw}(${detail})`);
}

/** root 本身的真實路徑;資料夾不存在 → `workspace.rootMissing`。 */
export function resolveRoot(rootDir: string): string {
  try {
    return realpathNative(rootDir);
  } catch {
    throw new DeskmonyError("workspace.rootMissing", { cwd: rootDir }, `session 的工作資料夾不存在:${rootDir}`);
  }
}

export interface ResolvedExisting {
  /** root 的真實路徑。 */
  rootReal: string;
  /** 目標的真實路徑(已確認存在、且在 `rootReal` 之下)。 */
  targetReal: string;
  /** 正規化後的相對片段。 */
  segments: string[];
}

/**
 * `listDir`/`readFile` 用:目標必須存在,真實路徑必須在 root 之下。見檔頭三道關。
 * 最後一段若是指向 root 外的 symlink/junction,`realpath` 會跟進並落在 root 外 → `workspace.pathOutsideRoot`
 * ——**點進**一個指向外面的資料夾會被拒(列表上只標示 `symlink`、不跟進)。
 */
export function resolveExisting(rootDir: string, raw: string): ResolvedExisting {
  const rootReal = resolveRoot(rootDir);
  const segments = parseRelativePath(raw);
  // `.git` 當作不存在:先於 realpath 擋,不洩漏它存在與否以外的資訊。
  if (segments.some(isDotGitSegment)) throw mapFsError({ code: "ENOENT" }, raw);
  let targetReal: string;
  try {
    targetReal = realpathNative(path.join(rootReal, ...segments));
  } catch (err) {
    throw mapFsError(err, raw);
  }
  if (!isPathUnder(targetReal, rootReal)) throw outside(raw);
  return { rootReal, targetReal, segments };
}

export interface ResolvedForGit {
  rootReal: string;
  /** 正規化後、以 `/` 連接的相對路徑(給 git 的 pathspec 用,放在 `--` 之後)。 */
  relPosix: string;
  segments: string[];
}

/**
 * `gitDiff` 用:目標**可以不存在**(已刪除的追蹤檔)、**不跟進最後一段 symlink**(git 自己也不跟進;已追蹤的 symlink
 * 在 diff 裡是連結目標的文字)。所以改檢查**上層資料夾鏈**:從目標的上一層往上找到第一個存在的祖先,取 realpath,
 * 必須在 root 之下——`link/deleted.txt` 的 `link` 若是指向 root 外的 junction,它存在、realpath 在 root 外 → 拒絕。
 * 至少要有一個片段(不能是 root 本身)。
 */
export function resolveForGit(rootDir: string, raw: string): ResolvedForGit {
  const rootReal = resolveRoot(rootDir);
  const segments = parseRelativePath(raw);
  if (segments.length === 0) {
    throw new DeskmonyError("workspace.notAFile", { path: raw }, `需要指定一個檔案:${raw}`);
  }
  let ancestor = path.dirname(path.join(rootReal, ...segments));
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const real = realpathNative(ancestor);
      if (!isPathUnder(real, rootReal)) throw outside(raw);
      break;
    } catch (err) {
      if (err instanceof DeskmonyError) throw err;
      const parent = path.dirname(ancestor);
      // 一路找到 root 之上仍不存在——理論上不會發生(root 本身存在);fail-closed。
      if (parent === ancestor || !isPathUnder(parent, rootReal)) throw outside(raw);
      ancestor = parent;
    }
  }
  return { rootReal, relPosix: segments.join("/"), segments };
}
