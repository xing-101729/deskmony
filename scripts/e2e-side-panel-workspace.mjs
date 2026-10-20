#!/usr/bin/env node
/**
 * scripts/e2e-side-panel-workspace.mjs
 *
 * 2026-10-20(右側面板 P2:Changes + Files 的唯讀 workspace 查詢,見 docs/LAYER-4-detail-design/side-panel_detail.md §P2.3、
 * docs/DECISIONS.md §L.1)端到端測試。**決定性**:隔離的 core(帶 `DESKMONY_AUTH_TOKEN` 啟動)+ fake ACP agent 建 session,
 * session 的工作資料夾是這支腳本在暫存目錄建出來的真 git repo(先 commit 幾個檔案,再改/加/刪/改名)。
 *
 *   WS-1   gitStatus 的每種狀態(M/MM/D/A/R+舊路徑/??)、分支名;工作資料夾是 repo 子資料夾時路徑相對於它。
 *   WS-2   gitDiff:修改檔的 hunk 內容、改名檔(帶 oldPath)只顯示真正的差異、已刪除檔、未追蹤檔(全部新增)、
 *          二進位檔、超過 512 KB 的 diff 被截斷。
 *   WS-3   還沒有任何 commit 的 repo(status 與 diff 對空樹);不是 repo 的資料夾(isRepo:false、gitDiff → workspace.notARepo)。
 *   WS-4   listDir/readFile 正常情況:`.git` 被隱藏、資料夾在前、symlink/junction 只標示、文字截斷(含不從多位元組字元中間截斷)、
 *          binary、圖片、圖片太大、空檔、超過 2000 筆的資料夾被截斷,各種錯誤碼。
 *   WS-5   **路徑逃逸全部被拒**(`workspace.pathOutsideRoot`):每一種寫法對 listDir 與 readFile 各測一次(也對 gitDiff 測
 *          `../`、絕對路徑與 junction)——`../x`、`a/../../x`、`..`、絕對路徑(POSIX/Windows/磁碟機相對/UNC/根目錄相對)、
 *          反斜線穿越、NUL、結尾是點或空白的片段,以及 root 內一個指向 root 外的 **junction**(`fs.symlinkSync(target, link, "junction")`)
 *          ——列出它、讀它底下的檔案、點進它都被拒;指向 root 內的 junction 則放行。
 *   WS-6   scoped bridge token 呼叫這四個方法都被拒(gateway.scopedTokenForbidden)。
 *   WS-7   **git 不會執行 repo 設定裡的任意指令**:repo 的 `.git/config` 埋了 core.fsmonitor、filter clean、textconv、
 *          diff.external 四個會執行指令的鉤子(對照組:直接跑 git 它們會留下標記檔),透過 gitStatus/gitDiff 一個都不能執行。
 *   WS-7b  同上,但 filter 藏在 **worktree 層級**(`.git/config.worktree`,`git config --local` 看不到)與 `include.path` 引進的檔案;
 *          另外確認**使用者全域設定的 filter 被保留**(全域安裝的 LFS 不受影響)。
 *
 * 用法:node scripts/e2e-side-panel-workspace.mjs
 * 前置需求:pnpm build 已跑過(dist 是最新的),本機有 git。
 */

import { spawn, spawnSync, execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  existsSync,
  writeFileSync,
  readdirSync,
  symlinkSync,
  unlinkSync,
  rmdirSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { requireFreshBuild } from "./lib/require-fresh-build.mjs";
import { e2eProvidersEnv, FAKE_ACP } from "./lib/e2e-providers.mjs";
import { REPORT_MCP_SERVERS_PREFIX } from "./fake-acp-agent.mjs";

requireFreshBuild();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const CORE_ENTRY = path.join(REPO_ROOT, "apps", "core", "dist", "index.js");
/** 避開其他 e2e 用過的 port(見 e2e-cli.mjs 檔頭的盤點;4842 沒人用,4870 留給 review)。 */
const PORT = 4842;
const IS_WIN = process.platform === "win32";
const MASTER_TOKEN = `e2e-master-${randomBytes(16).toString("hex")}`;
/** 1x1 透明 PNG(同 e2e-session-network.mjs)。 */
const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const SECRET = `SECRET-OUTSIDE-${randomBytes(6).toString("hex")}`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`\n[${ok ? "PASS" : "FAIL"}] ${name}`);
  if (detail) console.log(`       ${detail}`);
}

async function killProcessTree(proc, label) {
  if (!proc || proc.exitCode !== null || proc.killed) return;
  console.log(`[cleanup] 終止 ${label}(pid=${proc.pid}) ...`);
  try {
    if (IS_WIN) spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
    else proc.kill("SIGKILL");
  } catch (err) {
    console.log(`[cleanup] 終止 ${label} 時發生錯誤(忽略): ${err}`);
  }
  await sleep(700);
}

function startCore({ dataDir, homeDir, workspaceDir, gitHome }) {
  const env = {
    ...process.env,
    // git 的「使用者全域設定」指到這支測試自己的 .gitconfig(WS-7b:全域的 filter 必須保留、不被中和)。
    HOME: gitHome,
    USERPROFILE: gitHome,
    DESKMONY_CORE_PORT: String(PORT),
    DESKMONY_DATA_DIR: dataDir,
    DESKMONY_HOME: homeDir,
    DESKMONY_WORKSPACE: workspaceDir,
    ...e2eProvidersEnv(),
    DESKMONY_AUTH_TOKEN: MASTER_TOKEN,
  };
  const proc = spawn(process.execPath, [CORE_ENTRY], { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  proc.stdout.on("data", (chunk) => process.stdout.write(`[core:${PORT}] ${chunk}`));
  proc.stderr.on("data", (chunk) => process.stderr.write(`[core:${PORT}:err] ${chunk}`));
  return proc;
}

async function waitForPort(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const ws = new WebSocket(url);
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("connect timeout")), 1500);
        ws.addEventListener("open", () => {
          clearTimeout(t);
          resolve();
        });
        ws.addEventListener("error", () => {
          clearTimeout(t);
          reject(new Error("connect error"));
        });
      });
      ws.close();
      return true;
    } catch (err) {
      lastErr = err;
      await sleep(300);
    }
  }
  throw new Error(`等待 gateway 啟動逾時: ${lastErr}`);
}

class GatewayClient {
  constructor(url) {
    this.url = url;
    this.pendingRpc = new Map();
    this.pushes = [];
  }

  async connect(token) {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("WS connect timeout")), 10_000);
      this.ws.addEventListener("open", () => {
        clearTimeout(t);
        resolve();
      });
      this.ws.addEventListener("error", (e) => {
        clearTimeout(t);
        reject(new Error(`WS error: ${e.message ?? e}`));
      });
    });
    this.ws.addEventListener("message", (e) => this._handleMessage(e.data));
    if (token !== undefined) await this.rpc("auth", { token });
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
  }

  _handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : raw.toString());
    } catch {
      return;
    }
    if (msg.kind === "response") {
      const pending = this.pendingRpc.get(msg.id);
      if (pending) {
        this.pendingRpc.delete(msg.id);
        if (msg.ok) pending.resolve(msg.result);
        else {
          const err = new Error(msg.error ?? "unknown gateway error");
          err.errorCode = msg.errorCode;
          pending.reject(err);
        }
      }
      return;
    }
    if (msg.kind === "event") this.pushes.push({ channel: msg.channel, payload: msg.payload });
  }

  rpc(method, params, timeoutMs = 60_000) {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pendingRpc.delete(id);
        reject(new Error(`rpc ${method} 逾時 (${timeoutMs}ms)`));
      }, timeoutMs);
      this.pendingRpc.set(id, {
        resolve: (v) => {
          clearTimeout(t);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(t);
          reject(e);
        },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async drivePrompt(sessionId, text, timeoutMs = 60_000) {
    const start = this.pushes.length;
    await this.rpc("session.sendPrompt", { sessionId, prompt: { text } });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const mine = this.pushes.slice(start).filter((p) => p.channel === "session-event" && p.payload.sessionId === sessionId);
      if (mine.some((p) => p.payload.event.type === "completed" || p.payload.event.type === "error")) {
        return mine
          .filter((p) => p.payload.event.type === "message-delta")
          .map((p) => p.payload.event.delta)
          .join("");
      }
      await sleep(50);
    }
    throw new Error("逾時等待 completed/error 事件");
  }
}

/** 回傳被拒絕的錯誤碼(沒被拒絕回 undefined;成功時把結果放進 `.result`)。 */
async function outcome(promise) {
  try {
    return { ok: true, result: await promise };
  } catch (err) {
    return { ok: false, code: err.errorCode ?? `no-code:${err.message}` };
  }
}

// ---- 暫存 repo 的建法 -----------------------------------------------------------------------------

function git(cwd, ...args) {
  return execFileSync("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@example.com", "-c", "core.autocrlf=false", ...args], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function write(root, rel, content) {
  const full = path.join(root, ...rel.split("/"));
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
}

const lines = (n, prefix = "line") => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join("\n") + "\n";

/** 移除 junction/symlink 本身(不碰它指到的東西)。 */
function removeLink(p) {
  try {
    unlinkSync(p);
  } catch {
    try {
      rmdirSync(p);
    } catch {
      // ignore
    }
  }
}

async function main() {
  if (!existsSync(CORE_ENTRY)) {
    console.error(`找不到 ${CORE_ENTRY},請先執行 pnpm build`);
    process.exit(1);
  }
  try {
    execFileSync("git", ["--version"], { stdio: "ignore", windowsHide: true });
  } catch {
    console.error("找不到 git,這支測試需要本機有 git");
    process.exit(1);
  }
  const startTime = Date.now();
  const tmp = (name) => mkdtempSync(path.join(os.tmpdir(), `deskmony-e2e-ws-${name}-`));
  const dataDir = tmp("data");
  const homeDir = tmp("home");
  const coreWs = tmp("corews");
  const repo = tmp("repo");
  const emptyRepo = tmp("empty");
  const plainDir = tmp("plain");
  const hostile = tmp("hostile");
  const hostile2 = tmp("hostile2");
  const gitHome = tmp("githome");
  const markDir = tmp("marks");
  const outside = tmp("outside");
  const links = [];

  let core;
  let client;
  let scoped;
  try {
    // ---- 主 repo:先 commit,再改/加/刪/改名 ----
    git(repo, "init", "-q", "-b", "main");
    write(repo, "a.txt", "one\ntwo\nthree\n");
    write(repo, "b.txt", "b1\nb2\nb3\n");
    write(repo, "del.txt", "to be deleted\n");
    write(repo, "old.txt", lines(20, "old"));
    write(repo, "sub/d.txt", "d1\nd2\n");
    write(repo, "img.png", Buffer.from(TINY_PNG_B64, "base64"));
    write(repo, "bin.dat", Buffer.from([1, 2, 3, 0, 4, 5, 6, 0, 7]));
    write(repo, "big.txt", Array.from({ length: 3000 }, (_, i) => `row ${i} ${"x".repeat(280)}`).join("\n") + "\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "init");
    // 改:a.txt(只改第 2 行)、b.txt(先暫存一次修改、再改一次 → MM)、刪 del.txt、
    // 改名 old.txt → renamed.txt 並改一行(RM)、新增暫存 staged.txt(A)、未追蹤兩個、bin.dat 內容改變、big.txt 每行都改。
    write(repo, "a.txt", "one\nTWO\nthree\n");
    write(repo, "b.txt", "b1\nB2-staged\nb3\n");
    git(repo, "add", "b.txt");
    write(repo, "b.txt", "b1\nB2-staged\nb3\nb4-worktree\n");
    rmSync(path.join(repo, "del.txt"));
    git(repo, "mv", "old.txt", "renamed.txt");
    write(repo, "renamed.txt", lines(20, "old").replace("old 10", "NEW 10"));
    write(repo, "staged.txt", "staged new\n");
    git(repo, "add", "staged.txt");
    write(repo, "untracked.txt", "u1\nu2\nu3\n");
    write(repo, "sub/untracked2.txt", "only in sub\n");
    write(repo, "sub/d.txt", "d1\nD2\n");
    write(repo, "bin.dat", Buffer.from([9, 9, 9, 0, 8, 8, 8, 0]));
    write(repo, "big.txt", Array.from({ length: 3000 }, (_, i) => `ROW ${i} ${"y".repeat(280)}`).join("\n") + "\n");
    // Files 分頁用的素材(這些、以及 junction/symlink 都列進 .gitignore:status 與 diff 不必處理它們,也不讓 git 去遞迴 junction)
    write(repo, ".gitignore", ["many/", "huge.txt", "multibyte.txt", "toolarge.png", "empty.txt", "link-out", "link-out2", "link-in", "link-file"].join("\n") + "\n");
    write(repo, "huge.txt", "a".repeat(1_500_000));
    write(repo, "multibyte.txt", "中".repeat(400_000)); // 1.2 MB,每個字 3 位元組
    write(repo, "empty.txt", "");
    writeFileSync(path.join(repo, "toolarge.png"), Buffer.alloc(5 * 1024 * 1024 + 1, 1));
    mkdirSync(path.join(repo, "many"));
    for (let i = 0; i < 2100; i++) writeFileSync(path.join(repo, "many", `f${String(i).padStart(4, "0")}`), "");
    // 逃逸用:root 外的資料夾(含祕密檔)、root 內指向它的 junction、指向 root 內的 junction
    writeFileSync(path.join(outside, "secret.txt"), SECRET);
    mkdirSync(path.join(outside, "inner"));
    writeFileSync(path.join(outside, "inner", "deep.txt"), SECRET);
    symlinkSync(outside, path.join(repo, "link-out"), "junction");
    links.push(path.join(repo, "link-out"));
    symlinkSync(outside, path.join(repo, "sub", "link-out2"), "junction");
    links.push(path.join(repo, "sub", "link-out2"));
    symlinkSync(path.join(repo, "sub"), path.join(repo, "link-in"), "junction");
    links.push(path.join(repo, "link-in"));
    let fileSymlinkOk = true;
    try {
      symlinkSync(path.join(outside, "secret.txt"), path.join(repo, "link-file"), "file");
      links.push(path.join(repo, "link-file"));
    } catch {
      fileSymlinkOk = false; // Windows 沒開開發人員模式/沒權限建檔案 symlink:只測 junction
    }

    // ---- 還沒有任何 commit 的 repo ----
    git(emptyRepo, "init", "-q", "-b", "main");
    write(emptyRepo, "x.txt", "x1\nx2\n");
    git(emptyRepo, "add", "x.txt");
    write(emptyRepo, "y.txt", "y1\n");
    write(plainDir, "p.txt", "not a repo\n");

    // ---- 會執行指令的 repo 設定(先 commit,最後才寫進 config,否則 commit 時就先觸發了)----
    const markScript = path.join(markDir, "mark.cjs").replace(/\\/g, "/");
    writeFileSync(
      markScript,
      `const fs = require("fs"); fs.writeFileSync(${JSON.stringify(path.join(markDir, "MARK_").replace(/\\/g, "/"))} + process.argv[2], "x");\n`,
    );
    git(hostile, "init", "-q", "-b", "main");
    write(hostile, "t.txt", "aaa\n");
    git(hostile, "add", "t.txt");
    git(hostile, "commit", "-q", "-m", "init");
    write(hostile, ".gitattributes", "*.txt filter=evil diff=evil\n");
    git(hostile, "config", "core.fsmonitor", `node "${markScript}" fsmonitor`);
    git(hostile, "config", "filter.evil.clean", `node "${markScript}" clean`);
    git(hostile, "config", "diff.evil.textconv", `node "${markScript}" textconv`);
    git(hostile, "config", "diff.external", `node "${markScript}" external`);
    write(hostile, "t.txt", "bbb\n"); // 同樣大小的修改:git 必須讀內容(經過 clean filter)才知道有變

    // ---- WS-7b:filter 藏在 repo 本地 `.git/config` 以外的 scope ----
    //   - worktree 層級:`extensions.worktreeConfig=true` 時 git 另外讀 `.git/config.worktree`(`git config --local` 看不到它);
    //   - include:`.git/config` 的 `include.path` 引進的檔案(scope 沿用引入它的檔案的 scope);
    //   - 使用者的全域設定:**要保留**(全域安裝的 LFS 不能被誤傷)——標記檔應該出現。
    const extraCfg = path.join(markDir, "extra.cfg").replace(/\\/g, "/");
    writeFileSync(extraCfg, `[filter "inc"]\n\tclean = node "${markScript}" incclean\n`);
    writeFileSync(path.join(gitHome, ".gitconfig"), `[filter "gl"]\n\tclean = node "${markScript}" globalclean\n`);
    git(hostile2, "init", "-q", "-b", "main");
    write(hostile2, "t.txt", "aaa\n");
    write(hostile2, "n.md", "aaa\n");
    write(hostile2, "g.dat", "aaa\n");
    git(hostile2, "add", "-A");
    git(hostile2, "commit", "-q", "-m", "init");
    write(hostile2, ".gitattributes", "*.txt filter=wt\n*.md filter=inc\n*.dat filter=gl\n");
    git(hostile2, "config", "extensions.worktreeConfig", "true");
    git(hostile2, "config", "--worktree", "filter.wt.clean", `node "${markScript}" wtclean`);
    git(hostile2, "config", "include.path", extraCfg);
    for (const f of ["t.txt", "n.md", "g.dat"]) write(hostile2, f, "bbb\n");

    console.log(`[setup] repo=${repo}`);
    core = startCore({ dataDir, homeDir, workspaceDir: coreWs, gitHome });
    const url = `ws://127.0.0.1:${PORT}`;
    await waitForPort(url, 20_000);
    client = new GatewayClient(url);
    await client.connect(MASTER_TOKEN);

    const mkSession = async (dir, title) => (await client.rpc("session.create", { providerId: FAKE_ACP, workingDir: dir, title })).session;
    const S = await mkSession(repo, "ws-repo");
    const SSub = await mkSession(path.join(repo, "sub"), "ws-sub");
    const SEmpty = await mkSession(emptyRepo, "ws-empty");
    const SPlain = await mkSession(plainDir, "ws-plain");
    const SHostile = await mkSession(hostile, "ws-hostile");
    const SHostile2 = await mkSession(hostile2, "ws-hostile2");
    const call = (method, params) => client.rpc(method, params);
    const byPath = (files) => Object.fromEntries(files.map((f) => [f.path, f]));

    // ===================================================================================
    // WS-1 gitStatus
    // ===================================================================================
    try {
      const st = await call("workspace.gitStatus", { sessionId: S.id });
      const f = byPath(st.files);
      const stSub = await call("workspace.gitStatus", { sessionId: SSub.id });
      const fSub = byPath(stSub.files);
      record(
        "WS-1 gitStatus:分支 main;修改(' M')、暫存後又改('MM')、刪除(' D')、暫存新增('A ')、改名後又改('RM'、帶舊路徑 old.txt)、未追蹤('??');未追蹤的檔案逐檔列出;工作資料夾是 repo 子資料夾時只含該資料夾、路徑相對於它",
        st.isRepo === true &&
          st.branch === "main" &&
          st.truncated === false &&
          f["a.txt"]?.index + f["a.txt"]?.worktree === " M" &&
          f["b.txt"]?.index + f["b.txt"]?.worktree === "MM" &&
          f["del.txt"]?.index + f["del.txt"]?.worktree === " D" &&
          f["staged.txt"]?.index + f["staged.txt"]?.worktree === "A " &&
          f["renamed.txt"]?.index === "R" &&
          f["renamed.txt"]?.worktree === "M" &&
          f["renamed.txt"]?.oldPath === "old.txt" &&
          f["untracked.txt"]?.index + f["untracked.txt"]?.worktree === "??" &&
          f["sub/untracked2.txt"]?.index + f["sub/untracked2.txt"]?.worktree === "??" &&
          f["old.txt"] === undefined &&
          stSub.isRepo === true &&
          fSub["d.txt"]?.worktree === "M" &&
          fSub["untracked2.txt"]?.worktree === "?" &&
          fSub["a.txt"] === undefined &&
          fSub["sub/d.txt"] === undefined,
        `files=${JSON.stringify(st.files.map((x) => `${x.index}${x.worktree} ${x.path}${x.oldPath ? ` <- ${x.oldPath}` : ""}`))}, sub=${JSON.stringify(stSub.files.map((x) => `${x.index}${x.worktree} ${x.path}`))}`,
      );
    } catch (err) {
      record("WS-1 gitStatus", false, String(err?.stack ?? err));
    }

    // ===================================================================================
    // WS-2 gitDiff
    // ===================================================================================
    try {
      const diffA = await call("workspace.gitDiff", { sessionId: S.id, path: "a.txt" });
      const aLines = diffA.hunks.flatMap((h) => h.lines);
      const diffRenamed = await call("workspace.gitDiff", { sessionId: S.id, path: "renamed.txt", oldPath: "old.txt" });
      const rLines = diffRenamed.hunks.flatMap((h) => h.lines);
      const diffDel = await call("workspace.gitDiff", { sessionId: S.id, path: "del.txt" });
      const diffUntracked = await call("workspace.gitDiff", { sessionId: S.id, path: "untracked.txt" });
      const diffNested = await call("workspace.gitDiff", { sessionId: S.id, path: "sub/untracked2.txt" });
      const diffBin = await call("workspace.gitDiff", { sessionId: S.id, path: "bin.dat" });
      const diffBig = await call("workspace.gitDiff", { sessionId: S.id, path: "big.txt" });
      const diffStaged = await call("workspace.gitDiff", { sessionId: S.id, path: "staged.txt" });
      const h = diffA.hunks[0];
      record(
        "WS-2a gitDiff 的 hunk 格式與內容:a.txt 一個 hunk(oldStart/oldLines/newStart/newLines、' two'→'-two'/'+TWO' 與前後文行);已暫存的新增檔(staged.txt)全部是 '+';已刪除檔全部是 '-'",
        diffA.binary === false &&
          diffA.truncated === false &&
          diffA.hunks.length === 1 &&
          h.oldStart === 1 &&
          h.oldLines === 3 &&
          h.newStart === 1 &&
          h.newLines === 3 &&
          JSON.stringify(h.lines) === JSON.stringify([" one", "-two", "+TWO", " three"]) &&
          diffStaged.hunks.flatMap((x) => x.lines).every((l) => l.startsWith("+")) &&
          diffStaged.hunks.flatMap((x) => x.lines).includes("+staged new") &&
          diffDel.hunks.flatMap((x) => x.lines).join("|") === "-to be deleted" &&
          diffDel.hunks[0].newLines === 0,
        `a.txt=${JSON.stringify(diffA.hunks)}, del=${JSON.stringify(diffDel.hunks)}`,
      );
      record(
        "WS-2b 改名後又改的檔案(帶 oldPath)只顯示真正的差異('-old 10'/'+NEW 10'),不是整個檔案新增",
        diffRenamed.binary === false &&
          rLines.includes("-old 10") &&
          rLines.includes("+NEW 10") &&
          rLines.filter((l) => l.startsWith("+")).length === 1 &&
          rLines.filter((l) => l.startsWith("-")).length === 1,
        `lines=${JSON.stringify(rLines)}`,
      );
      record(
        "WS-2c 未追蹤檔案的 diff:全部是新增的單一 hunk(oldStart 0、newStart 1、newLines = 行數),巢狀路徑同樣可以;二進位檔 binary:true、沒有 hunk",
        diffUntracked.hunks.length === 1 &&
          diffUntracked.hunks[0].oldStart === 0 &&
          diffUntracked.hunks[0].oldLines === 0 &&
          diffUntracked.hunks[0].newStart === 1 &&
          diffUntracked.hunks[0].newLines === 3 &&
          JSON.stringify(diffUntracked.hunks[0].lines) === JSON.stringify(["+u1", "+u2", "+u3"]) &&
          diffNested.hunks[0]?.lines.join("|") === "+only in sub" &&
          diffBin.binary === true &&
          diffBin.hunks.length === 0,
        `untracked=${JSON.stringify(diffUntracked)}, bin=${JSON.stringify(diffBin)}`,
      );
      record(
        "WS-2d 超過 512 KB 的 diff 被截斷(truncated:true),截在 hunk 中間也能解析(仍有 hunk、每個 hunk 的行都以 ' '/'+'/'-' 開頭)",
        diffBig.truncated === true &&
          diffBig.hunks.length >= 1 &&
          diffBig.hunks.every((x) => x.lines.every((l) => /^[ +\-\\]/.test(l))),
        `truncated=${diffBig.truncated}, hunks=${diffBig.hunks.length}, lines=${diffBig.hunks.flatMap((x) => x.lines).length}`,
      );
    } catch (err) {
      record("WS-2 gitDiff", false, String(err?.stack ?? err));
    }

    // ===================================================================================
    // WS-3 沒有 commit 的 repo / 不是 repo
    // ===================================================================================
    try {
      const st = await call("workspace.gitStatus", { sessionId: SEmpty.id });
      const f = byPath(st.files);
      const dx = await call("workspace.gitDiff", { sessionId: SEmpty.id, path: "x.txt" });
      const dy = await call("workspace.gitDiff", { sessionId: SEmpty.id, path: "y.txt" });
      const plain = await call("workspace.gitStatus", { sessionId: SPlain.id });
      const plainDiff = await outcome(call("workspace.gitDiff", { sessionId: SPlain.id, path: "p.txt" }));
      record(
        "WS-3 還沒有任何 commit 的 repo:status 正常(分支 main、'A '/'??')、已暫存檔的 diff 對空樹(全部新增)、未追蹤檔 diff 照常;不是 repo 的資料夾 → isRepo:false(沒有檔案、沒有分支),gitDiff → workspace.notARepo",
        st.isRepo === true &&
          st.branch === "main" &&
          f["x.txt"]?.index === "A" &&
          f["y.txt"]?.index === "?" &&
          dx.hunks.flatMap((x) => x.lines).join("|") === "+x1|+x2" &&
          dy.hunks.flatMap((x) => x.lines).join("|") === "+y1" &&
          plain.isRepo === false &&
          plain.branch === null &&
          plain.files.length === 0 &&
          plainDiff.ok === false &&
          plainDiff.code === "workspace.notARepo",
        `empty=${JSON.stringify(st)}, dx=${JSON.stringify(dx.hunks)}, plain=${JSON.stringify(plain)}, plainDiff=${JSON.stringify(plainDiff)}`,
      );
    } catch (err) {
      record("WS-3 空 repo / 非 repo", false, String(err?.stack ?? err));
    }

    // ===================================================================================
    // WS-4 listDir / readFile 正常情況
    // ===================================================================================
    try {
      const root = await call("workspace.listDir", { sessionId: S.id, path: "" });
      const names = root.entries.map((e) => e.name);
      const types = Object.fromEntries(root.entries.map((e) => [e.name, e.type]));
      const firstFileIdx = root.entries.findIndex((e) => e.type !== "dir");
      const dirsFirst = root.entries.slice(0, firstFileIdx).every((e) => e.type === "dir") && root.entries.slice(firstFileIdx).every((e) => e.type !== "dir");
      const sub = await call("workspace.listDir", { sessionId: S.id, path: "sub" });
      const subWithDot = await call("workspace.listDir", { sessionId: S.id, path: "./sub/" });
      const many = await call("workspace.listDir", { sessionId: S.id, path: "many" });
      const notDir = await outcome(call("workspace.listDir", { sessionId: S.id, path: "a.txt" }));
      const gitDir = await outcome(call("workspace.listDir", { sessionId: S.id, path: ".git" }));
      const gitFile = await outcome(call("workspace.readFile", { sessionId: S.id, path: ".git/config" }));
      const gitFileCase = await outcome(call("workspace.readFile", { sessionId: S.id, path: ".GIT/config" }));
      const linkIn = await outcome(call("workspace.listDir", { sessionId: S.id, path: "link-in" }));
      record(
        "WS-4a listDir:隱藏 .git、資料夾在前(sub、many 等)、型別與大小正確;junction 只標示 symlink(link-out/link-in);指向 root 內的 junction 可以點進去;'./sub/' 與 'sub' 等價;超過 2000 筆的資料夾只回 2000 筆且 truncated:true;對檔案 listDir → workspace.notADirectory;.git(含讀 .git/config、不分大小寫)→ workspace.notFound",
        !names.includes(".git") &&
          dirsFirst &&
          types["sub"] === "dir" &&
          types["many"] === "dir" &&
          types["a.txt"] === "file" &&
          types["link-out"] === "symlink" &&
          types["link-in"] === "symlink" &&
          root.entries.find((e) => e.name === "a.txt")?.size === "one\nTWO\nthree\n".length &&
          root.truncated === false &&
          sub.entries.map((e) => e.name).includes("d.txt") &&
          sub.entries.find((e) => e.name === "link-out2")?.type === "symlink" &&
          JSON.stringify(subWithDot.entries) === JSON.stringify(sub.entries) &&
          many.entries.length === 2000 &&
          many.truncated === true &&
          many.entries[0].name === "f0000" &&
          notDir.code === "workspace.notADirectory" &&
          gitDir.code === "workspace.notFound" &&
          gitFile.code === "workspace.notFound" &&
          gitFileCase.code === "workspace.notFound" &&
          linkIn.ok === true &&
          linkIn.result.entries.map((e) => e.name).includes("d.txt"),
        `root=${JSON.stringify(root.entries.map((e) => `${e.type[0]}:${e.name}`))}, many=${many.entries.length}/${many.truncated}, notDir=${notDir.code}, git=${gitDir.code}/${gitFile.code}/${gitFileCase.code}`,
      );

      const text = await call("workspace.readFile", { sessionId: S.id, path: "a.txt" });
      const huge = await call("workspace.readFile", { sessionId: S.id, path: "huge.txt" });
      const multi = await call("workspace.readFile", { sessionId: S.id, path: "multibyte.txt" });
      const empty = await call("workspace.readFile", { sessionId: S.id, path: "empty.txt" });
      const bin = await call("workspace.readFile", { sessionId: S.id, path: "bin.dat" });
      const img = await call("workspace.readFile", { sessionId: S.id, path: "img.png" });
      const tooLarge = await call("workspace.readFile", { sessionId: S.id, path: "toolarge.png" });
      const missing = await outcome(call("workspace.readFile", { sessionId: S.id, path: "nope.txt" }));
      const asDir = await outcome(call("workspace.readFile", { sessionId: S.id, path: "sub" }));
      const nested = await call("workspace.readFile", { sessionId: S.id, path: "sub/d.txt" });
      const viaLinkIn = await outcome(call("workspace.readFile", { sessionId: S.id, path: "link-in/d.txt" }));
      const noSession = await outcome(call("workspace.readFile", { sessionId: randomUUID(), path: "a.txt" }));
      record(
        "WS-4b readFile:文字原樣(含大小)、1 MB 截斷(truncated:true、size 是完整大小)且不在多位元組字元中間截斷(沒有 U+FFFD)、空檔、前 8 KB 有 NUL → binary、png → image(mime、base64 與檔案一致)、超過 5 MB 的圖片 → tooLarge、不存在 → workspace.notFound、對資料夾 → workspace.notAFile、經過指向 root 內的 junction 的路徑可以讀、不存在的 session → workspace.sessionNotFound",
        text.kind === "text" &&
          text.content === "one\nTWO\nthree\n" &&
          text.size === 14 &&
          text.truncated === false &&
          huge.kind === "text" &&
          huge.truncated === true &&
          huge.size === 1_500_000 &&
          huge.content.length === 1024 * 1024 &&
          multi.kind === "text" &&
          multi.truncated === true &&
          multi.size === 1_200_000 &&
          !multi.content.includes("\uFFFD") &&
          /^中+$/.test(multi.content) &&
          Buffer.byteLength(multi.content, "utf8") <= 1024 * 1024 &&
          empty.kind === "text" &&
          empty.content === "" &&
          empty.size === 0 &&
          bin.kind === "binary" &&
          bin.size === 8 &&
          img.kind === "image" &&
          img.mime === "image/png" &&
          img.dataBase64 === TINY_PNG_B64 &&
          tooLarge.kind === "tooLarge" &&
          tooLarge.size === 5 * 1024 * 1024 + 1 &&
          missing.code === "workspace.notFound" &&
          asDir.code === "workspace.notAFile" &&
          nested.kind === "text" &&
          nested.content === "d1\nD2\n" &&
          viaLinkIn.ok === true &&
          viaLinkIn.result.content === "d1\nD2\n" &&
          noSession.code === "workspace.sessionNotFound",
        `text=${text.kind}/${text.size}, huge=${huge.content?.length}/${huge.truncated}, multi=${multi.content?.length}/${multi.truncated}, bin=${bin.kind}, img=${img.kind}, tooLarge=${tooLarge.kind}, missing=${missing.code}, asDir=${asDir.code}, noSession=${noSession.code}`,
      );
    } catch (err) {
      record("WS-4 listDir/readFile", false, String(err?.stack ?? err));
    }

    // ===================================================================================
    // WS-5 路徑逃逸
    // ===================================================================================
    try {
      const outsideAbs = path.join(outside, "secret.txt");
      const forms = [
        ["../x", "上一層"],
        ["a/../../x", "a/../../x"],
        ["..", "只有 .."],
        ["sub/../../outside.txt", "sub/../../outside.txt"],
        ["sub/..", "sub/..(仍含 .. 片段,字面就拒)"],
        ["/etc/passwd", "POSIX 絕對路徑"],
        ["/", "根目錄"],
        [outsideAbs, "root 外的絕對路徑(本機實際存在的祕密檔)"],
        [outsideAbs.replace(/\\/g, "/"), "同上,正斜線寫法"],
        ["C:\\Windows\\win.ini", "Windows 絕對路徑(反斜線)"],
        ["C:/Windows/win.ini", "Windows 絕對路徑(正斜線)"],
        ["C:win.ini", "磁碟機相對路徑"],
        ["\\\\localhost\\c$\\Windows\\win.ini", "UNC(反斜線)"],
        ["//localhost/c$/Windows/win.ini", "UNC(正斜線)"],
        ["\\Windows\\win.ini", "根目錄相對(反斜線開頭)"],
        ["a\\..\\..\\x", "反斜線穿越"],
        ["sub\\..\\..\\x", "反斜線穿越(sub)"],
        ["a\u0000b", "NUL 字元"],
        ["... /x", "結尾是點與空白的片段"],
        [".. /x", "'.. ' 片段(Win32 會正規化成 ..)"],
        ["sub/CON", "Windows 保留裝置名"],
        ["a.txt:stream", "NTFS 資料流冒號"],
      ];
      // POSIX 上 "a\\..\\..\\x"/".. /x"/"sub/CON"/"a.txt:stream" 只是奇怪的檔名(不存在 → notFound),不是逃逸:只在 Windows 上要求 pathOutsideRoot。
      const winOnly = new Set(["a\\..\\..\\x", "sub\\..\\..\\x", "... /x", ".. /x", "sub/CON", "a.txt:stream"]);
      const failures = [];
      for (const [raw, label] of forms) {
        for (const method of ["workspace.listDir", "workspace.readFile"]) {
          const r = await outcome(call(method, { sessionId: S.id, path: raw }));
          const accepted = r.ok === false && (r.code === "workspace.pathOutsideRoot" || (!IS_WIN && winOnly.has(raw) && r.code === "workspace.notFound"));
          const leaked = r.ok && JSON.stringify(r.result).includes(SECRET);
          if (!accepted || leaked) failures.push(`${method} ${JSON.stringify(raw)}(${label}) → ${r.ok ? "放行了!" : r.code}`);
        }
      }
      record(
        `WS-5a 路徑逃逸(字面寫法):${forms.length} 種寫法 × listDir/readFile 全部被拒(workspace.pathOutsideRoot),沒有任何內容外流`,
        failures.length === 0,
        failures.length ? failures.join("\n       ") : `${forms.length * 2} 次呼叫全數被拒`,
      );

      // gitDiff:`../`、絕對路徑、UNC、junction。
      const gitForms = ["../x", "a/../../x", "..", "/etc/passwd", outsideAbs, "C:\\Windows\\win.ini", "\\\\localhost\\c$\\x", "link-out/secret.txt", "sub/link-out2/secret.txt", "link-out/inner/deep.txt"];
      const gitFailures = [];
      for (const raw of gitForms) {
        const r = await outcome(call("workspace.gitDiff", { sessionId: S.id, path: raw }));
        if (!(r.ok === false && r.code === "workspace.pathOutsideRoot")) gitFailures.push(`gitDiff path=${JSON.stringify(raw)} → ${r.ok ? "放行了!" : r.code}`);
        const old = await outcome(call("workspace.gitDiff", { sessionId: S.id, path: "a.txt", oldPath: raw }));
        if (!(old.ok === false && old.code === "workspace.pathOutsideRoot")) gitFailures.push(`gitDiff oldPath=${JSON.stringify(raw)} → ${old.ok ? "放行了!" : old.code}`);
      }
      record(
        `WS-5b gitDiff 的 path 與 oldPath 同樣過路徑檢查:${gitForms.length} 種(../、絕對路徑、UNC、經 junction)全部被拒(workspace.pathOutsideRoot)`,
        gitFailures.length === 0,
        gitFailures.length ? gitFailures.join("\n       ") : `${gitForms.length * 2} 次呼叫全數被拒`,
      );

      // junction:列出它、點進它、讀它底下的檔案、各種經過它的寫法。
      const junctionCases = [
        ["workspace.listDir", "link-out"],
        ["workspace.listDir", "link-out/"],
        ["workspace.listDir", "link-out/inner"],
        ["workspace.listDir", "sub/link-out2"],
        ["workspace.readFile", "link-out/secret.txt"],
        ["workspace.readFile", "link-out/inner/deep.txt"],
        ["workspace.readFile", "sub/link-out2/secret.txt"],
        ["workspace.readFile", "link-out"],
        ["workspace.readFile", "sub/../link-out/secret.txt"], // 含 .. 字面就拒
      ];
      if (IS_WIN) {
        junctionCases.push(["workspace.listDir", "LINK-OUT"], ["workspace.readFile", "LINK-OUT/SECRET.TXT"]); // 大小寫不同的寫法
      }
      if (fileSymlinkOk) junctionCases.push(["workspace.readFile", "link-file"]);
      const junctionFailures = [];
      for (const [method, p] of junctionCases) {
        const r = await outcome(call(method, { sessionId: S.id, path: p }));
        const leaked = r.ok && JSON.stringify(r.result).includes(SECRET);
        if (!(r.ok === false && r.code === "workspace.pathOutsideRoot") || leaked) junctionFailures.push(`${method} ${JSON.stringify(p)} → ${r.ok ? "放行了!" : r.code}`);
      }
      // 列出 root 時 junction 本身只是被標示(列表不洩漏它裡面的東西)。
      const rootList = await call("workspace.listDir", { sessionId: S.id, path: "" });
      record(
        `WS-5c root 內指向 root 外的 junction${fileSymlinkOk ? "(與檔案 symlink)" : "(這台機器沒權限建檔案 symlink,只測 junction)"}:列出它、點進它、讀它底下的檔案、各種經過它的寫法(${junctionCases.length} 種)全部被拒(workspace.pathOutsideRoot),祕密內容沒有外流;列表只標示 symlink`,
        junctionFailures.length === 0 && rootList.entries.find((e) => e.name === "link-out")?.type === "symlink",
        junctionFailures.length ? junctionFailures.join("\n       ") : `${junctionCases.length} 次呼叫全數被拒`,
      );
    } catch (err) {
      record("WS-5 路徑逃逸", false, String(err?.stack ?? err));
    }

    // ===================================================================================
    // WS-6 scoped bridge token
    // ===================================================================================
    try {
      const text = await client.drivePrompt(S.id, REPORT_MCP_SERVERS_PREFIX, 30_000);
      const marker = "MCP_SERVERS:";
      const mcpServers = JSON.parse(text.slice(text.indexOf(marker) + marker.length));
      const env = Object.fromEntries((mcpServers[0].env ?? []).map((e) => [e.name, e.value]));
      scoped = new GatewayClient(env.DESKMONY_MCP_BRIDGE_GATEWAY_URL);
      await scoped.connect(env.DESKMONY_MCP_BRIDGE_TOKEN);
      const codes = {
        listDir: (await outcome(scoped.rpc("workspace.listDir", { sessionId: S.id, path: "" }))).code,
        readFile: (await outcome(scoped.rpc("workspace.readFile", { sessionId: S.id, path: "a.txt" }))).code,
        gitStatus: (await outcome(scoped.rpc("workspace.gitStatus", { sessionId: S.id }))).code,
        gitDiff: (await outcome(scoped.rpc("workspace.gitDiff", { sessionId: S.id, path: "a.txt" }))).code,
      };
      record(
        "WS-6 scoped bridge token 呼叫 workspace.listDir/readFile/gitStatus/gitDiff 全部被拒(gateway.scopedTokenForbidden)",
        Object.values(codes).every((c) => c === "gateway.scopedTokenForbidden"),
        JSON.stringify(codes),
      );
    } catch (err) {
      record("WS-6 scoped bridge token", false, String(err?.stack ?? err));
    }

    // ===================================================================================
    // WS-7 git 不執行 repo 設定裡的指令
    // ===================================================================================
    try {
      const marks = () => readdirSync(markDir).filter((n) => n.startsWith("MARK_")).sort();
      const clearMarks = () => {
        for (const n of marks()) rmSync(path.join(markDir, n), { force: true });
      };
      // 對照組:直接跑 git(沒有任何防護)——這個 repo 的設定確實會執行指令,證明測試設定有效、不是「根本沒觸發」。
      // (spawnSync:埋的指令不見得讓 git 以 0 結束,對照組只在乎標記檔有沒有出現。)
      for (const args of [["status", "--porcelain=v1"], ["diff", "HEAD"]]) {
        spawnSync("git", args, { cwd: hostile, windowsHide: true, stdio: "ignore" });
      }
      const control = marks();
      clearMarks();
      // 受測:透過 gateway。
      const st = await call("workspace.gitStatus", { sessionId: SHostile.id });
      const d1 = await call("workspace.gitDiff", { sessionId: SHostile.id, path: "t.txt" });
      const d2 = await call("workspace.gitDiff", { sessionId: SHostile.id, path: ".gitattributes" });
      await sleep(500); // 萬一有被執行,標記檔寫入有點時間
      const protectedMarks = marks();
      record(
        "WS-7 repo 設定埋了 core.fsmonitor / filter clean / textconv / diff.external:直接跑 git 會執行它們(對照組留下標記檔),透過 gitStatus/gitDiff 一個都沒執行,且結果仍然正確(t.txt 顯示為已修改、diff 有 '-aaa'/'+bbb')",
        control.length >= 2 &&
          control.includes("MARK_fsmonitor") &&
          control.includes("MARK_clean") &&
          protectedMarks.length === 0 &&
          st.isRepo === true &&
          byPath(st.files)["t.txt"]?.worktree === "M" &&
          d1.hunks.flatMap((x) => x.lines).includes("-aaa") &&
          d1.hunks.flatMap((x) => x.lines).includes("+bbb") &&
          d2.binary === false,
        `對照組標記=${JSON.stringify(control)}, 受測標記=${JSON.stringify(protectedMarks)}, t.txt=${JSON.stringify(byPath(st.files)["t.txt"])}, diff=${JSON.stringify(d1.hunks)}`,
      );
    } catch (err) {
      record("WS-7 git 不執行 repo 設定的指令", false, String(err?.stack ?? err));
    }

    // ===================================================================================
    // WS-7b filter 藏在 worktree 層級 / include 進來的設定:同樣不能執行;使用者全域的 filter 要保留
    // ===================================================================================
    try {
      const marks = () => readdirSync(markDir).filter((n) => n.startsWith("MARK_")).sort();
      const clearMarks = () => {
        for (const n of marks()) rmSync(path.join(markDir, n), { force: true });
      };
      clearMarks();
      // 對照組:直接跑 git(同樣把使用者全域設定指到 gitHome)——三個 filter 都會執行,證明測試設定有效。
      spawnSync("git", ["diff", "HEAD"], {
        cwd: hostile2,
        windowsHide: true,
        stdio: "ignore",
        env: { ...process.env, HOME: gitHome, USERPROFILE: gitHome },
      });
      const control = marks();
      clearMarks();
      // 受測:透過 gateway(status 與每個檔案的 diff)。
      const st = await call("workspace.gitStatus", { sessionId: SHostile2.id });
      const diffs = {};
      for (const f of ["t.txt", "n.md", "g.dat"]) diffs[f] = await call("workspace.gitDiff", { sessionId: SHostile2.id, path: f });
      await sleep(500);
      const viaGateway = marks();
      const changed = byPath(st.files);
      record(
        "WS-7b filter 藏在 worktree 層級(extensions.worktreeConfig + .git/config.worktree)與 include.path 引進的檔案:直接跑 git 會執行它們(對照組),透過 gitStatus/gitDiff 不會(MARK_wtclean/MARK_incclean 不出現);使用者全域設定的 filter 則保留(MARK_globalclean 照常出現,全域安裝的 LFS 不受影響);結果仍然正確",
        control.includes("MARK_wtclean") &&
          control.includes("MARK_incclean") &&
          control.includes("MARK_globalclean") &&
          !viaGateway.includes("MARK_wtclean") &&
          !viaGateway.includes("MARK_incclean") &&
          viaGateway.includes("MARK_globalclean") &&
          st.isRepo === true &&
          ["t.txt", "n.md", "g.dat"].every((f) => changed[f]?.worktree === "M") &&
          // 被中和的兩個:diff 是真實內容。保留的全域 filter(g.dat)標記檔的指令不回傳內容,所以它的 diff 內容不是重點。
          ["t.txt", "n.md"].every((f) => diffs[f].hunks.flatMap((x) => x.lines).join("|") === "-aaa|+bbb"),
        `對照組標記=${JSON.stringify(control)}, 受測標記=${JSON.stringify(viaGateway)}, status=${JSON.stringify(st.files.map((x) => `${x.index}${x.worktree} ${x.path}`))}`,
      );
    } catch (err) {
      record("WS-7b worktree/include 層級的 filter", false, String(err?.stack ?? err));
    }
  } catch (err) {
    console.error(`\n[FATAL] ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    record("e2e 整體設置", false, String(err?.stack ?? err));
  } finally {
    client?.close();
    scoped?.close();
    await killProcessTree(core, "core");
    for (const link of links) removeLink(link); // 先拆 junction/symlink,避免遞迴刪除碰到它們指向的東西
    for (const dir of [dataDir, homeDir, coreWs, repo, emptyRepo, plainDir, hostile, hostile2, gitHome, markDir, outside]) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n${"=".repeat(50)}`);
  console.log(`P2(面板 workspace 查詢) e2e 結果 (${elapsed}s)`);
  console.log(`${"=".repeat(50)}`);
  let pass = 0;
  let fail = 0;
  for (const r of results) {
    console.log(`  ${r.ok ? "PASS" : "FAIL"} ${r.name}`);
    if (!r.ok && r.detail) console.log(`       ${r.detail}`);
    if (r.ok) pass++;
    else fail++;
  }
  console.log(`\n總計: ${pass} PASS, ${fail} FAIL`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
