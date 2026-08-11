#!/usr/bin/env node
/**
 * scripts/package-smoke.mjs
 *
 * 打包迴歸測試(見 README.md「打包/發版」章節):驗證 `pnpm package:dir` 產出
 * 的 `release/win-unpacked/Deskmony.exe` 在**完全找不到系統 Node.js**的機器上
 * 也能正常啟動 core 子程序、開放 WS Gateway,而不是像修復前那樣因為
 * `better-sqlite3` 原生模組 ABI(NODE_MODULE_VERSION)不相容而
 * `ERR_DLOPEN_FAILED` crash(完整背景見 `apps/desktop/electron/main.ts` 的
 * `startCore()` 註解、`scripts/bundle-core.mjs` 的 electron-rebuild 註解)。
 *
 * 用法:
 *   node scripts/package-smoke.mjs              # 完整跑:先 pnpm package:dir 再驗證
 *   node scripts/package-smoke.mjs --skip-build  # 略過 pnpm package:dir,直接驗證既有的
 *                                                 # release/win-unpacked/(手動重跑加速用)
 *
 * 這支腳本會:
 *   1. (預設)在 repo 根目錄跑一次 `pnpm package:dir`(電子建置 + electron-rebuild +
 *      electron-builder --dir,產出未壓縮的 win-unpacked)。
 *   2. 組一份「過濾掉所有 node.exe 所在目錄」的 PATH,以此環境變數啟動
 *      `release/win-unpacked/Deskmony.exe` —— 模擬終端使用者機器完全沒裝
 *      Node.js 的情境。同時固定 `DESKMONY_AUTH_TOKEN`(讓這支腳本能自己送出
 *      `auth` request 驗證連線,見下方)、指定一個不與本機 dev 環境衝突的
 *      `DESKMONY_CORE_PORT`、以及一個用完即丟的暫存 `DESKMONY_DATA_DIR`(避免
 *      污染使用者真正的 `~/.deskmony`)。
 *   3. 在時限內輪詢該 port 上的 WS 是否開始接受連線,連上後送一次 `auth`
 *      request 驗證能拿到正確回應(這代表 core 子程序真的正常啟動、WsGateway
 *      也正常運作,不是視窗開著但 core 其實已經 crash)。
 *   4. 對同一個 port 的 `GET /` 做一次真的 HTTP 請求,驗證打包後的 core 也能
 *      正確提供瀏覽器 UI 靜態檔案(見 `apps/desktop/package.json` 的
 *      `extraResources`(`dist` -> `resources/desktop-ui`)與
 *      `apps/desktop/electron/main.ts` 的 `startCore()` 如何把
 *      `DESKMONY_STATIC_DIR` 指過去)——斷言狀態碼 200、回應內容是真正的
 *      `index.html`(含 `apps/desktop/dist/index.html` 實際存在的
 *      `<title>Deskmony</title>` 字樣),不是 `static-server.ts` 在找不到
 *      `index.html` 時的 404 fallback 文字。
 *   5. 全程收集 exe 的 stdout/stderr,掃描是否出現任何 ABI 不相容的錯誤字樣
 *      (`ERR_DLOPEN_FAILED`、`NODE_MODULE_VERSION`、`was compiled against a
 *      different Node.js version`)或「找不到瀏覽器 UI 靜態檔案」這則警告——
 *      只要出現任何一種就視為 FAIL,即使 WS port/HTTP 恰好還是正常也一樣
 *      (避免誤判:例如系統剛好有殘留的舊 core process 佔用同個 port)。
 *   6. 結束時關閉整個 process tree(exe 本身 + 它 spawn 的 core 子程序,Windows
 *      上用 `taskkill /T /F` 一次清乾淨)並刪除暫存資料目錄。
 *
 * 注意:這支腳本會讓 Deskmony 的視窗實際彈出一下(這是一個真正的 GUI Electron
 * app,沒有 headless 模式)——這是刻意接受的取捨,腳本驗證的是「core 子程序
 * 能不能正常啟動」而不是 UI 渲染本身,結束時會自動關閉,不需要手動操作。
 */

import { execSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const EXE_PATH = path.join(REPO_ROOT, "apps", "desktop", "release", "win-unpacked", "Deskmony.exe");

const SMOKE_PORT = 4321; // 刻意與 dev 預設的 4317 / e2e-gateway.mjs 的 4319 不同,避免衝突
const SMOKE_AUTH_TOKEN = "package-smoke-test-token-not-a-secret";
const PORT_WAIT_TIMEOUT_MS = 45_000; // 打包後的 exe 冷啟動(含視窗建立)比 dev 慢,放寬一些
const ABI_ERROR_PATTERNS = [
  /ERR_DLOPEN_FAILED/i,
  /NODE_MODULE_VERSION/i,
  /was compiled against a different Node\.js version/i,
];
// 打包後的靜態檔案目錄缺口(見 apps/core/src/index.ts 的警告文字)——修復後
// 這則警告不應再出現,出現就代表 apps/desktop/package.json 的 extraResources
// 或 main.ts 的 DESKMONY_STATIC_DIR 覆寫又壞掉了。
const STATIC_DIR_WARNING_PATTERN = /找不到瀏覽器 UI 靜態檔案/;
// apps/core/src/http/static-server.ts 的 sendIndex() 在真正的 index.html 讀不到
// 時的 404 fallback 文字開頭——HTTP GET 驗證用來確認拿到的不是這段話。
const STATIC_INDEX_NOT_FOUND_TEXT = "找不到 index.html";

const SKIP_BUILD = process.argv.includes("--skip-build");

function log(msg) {
  console.log(`[package-smoke] ${msg}`);
}

/**
 * 組一份「保證找不到 node.exe」的 PATH:掃過目前 PATH 的每個目錄,凡是目錄底下
 * 實際存在 node.exe 就整個目錄剔除。不是只把單一目錄列入黑名單,是因為使用者
 * 機器上 Node.js 可能裝在任何路徑(nvm、手動安裝、Program Files…),唯一可靠的
 * 判斷方式是實際檢查該目錄下有沒有 node.exe 這個檔案。
 */
function buildPathWithoutNode() {
  const dirs = (process.env.PATH ?? process.env.Path ?? "").split(path.delimiter).filter(Boolean);
  const filtered = dirs.filter((dir) => {
    try {
      return !existsSync(path.join(dir, "node.exe"));
    } catch {
      return true;
    }
  });
  const removed = dirs.filter((d) => !filtered.includes(d));
  if (removed.length > 0) {
    log(`PATH 過濾掉 ${removed.length} 個含 node.exe 的目錄: ${removed.join(", ")}`);
  } else {
    log("PATH 掃描完畢,原本就沒有任何目錄含 node.exe(可能本機沒裝系統 Node,或已經不在 PATH 上)");
  }
  return filtered.join(path.delimiter);
}

/** 用過濾後的 PATH 實際跑一次 `where node.exe`,確認真的找不到 —— 不只是理論上過濾對了。 */
function assertNodeUnreachable(filteredPath) {
  const result = spawnSync("where", ["node.exe"], {
    env: { ...process.env, PATH: filteredPath, Path: filteredPath },
    encoding: "utf8",
  });
  if (result.status === 0 && result.stdout.trim()) {
    throw new Error(
      `PATH 過濾失敗:過濾後仍然找得到 node.exe: ${result.stdout.trim()}(可能是同一份 node.exe 也被系統目錄的某個 shim 間接暴露,需要檢查 buildPathWithoutNode() 的過濾邏輯)`,
    );
  }
  log("已驗證:過濾後的 PATH 下 `where node.exe` 確實找不到任何結果");
}

async function waitForWsOpen(url, timeoutMs) {
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
      return ws;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(`等待 WS Gateway 開始監聽逾時(${timeoutMs}ms): ${lastErr}`);
}

function rpcAuth(ws, token, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const id = "package-smoke-auth";
    const t = setTimeout(() => reject(new Error("auth rpc 逾時")), timeoutMs);
    const onMessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(typeof event.data === "string" ? event.data : event.data.toString());
      } catch {
        return;
      }
      if (msg.kind === "response" && msg.id === id) {
        clearTimeout(t);
        ws.removeEventListener("message", onMessage);
        if (msg.ok) resolve(msg.result);
        else reject(new Error(`auth 失敗: ${JSON.stringify(msg.error)}`));
      }
    };
    ws.addEventListener("message", onMessage);
    ws.send(JSON.stringify({ id, method: "auth", params: { token } }));
  });
}

/** Windows 上用 taskkill /T /F 連同整個 process tree(exe 本身 + 它 spawn 的 core 子程序)一起收掉。 */
function killProcessTree(pid) {
  if (pid == null) return;
  const result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { encoding: "utf8" });
  if (result.status !== 0) {
    // exit code 128 = 程序已經不存在,屬正常收尾情況,不當錯誤處理
    log(`taskkill 輸出(PID ${pid}): ${(result.stdout ?? "").trim()} ${(result.stderr ?? "").trim()}`.trim());
  } else {
    log(`已終止 process tree(PID ${pid})`);
  }
}

async function main() {
  if (process.platform !== "win32") {
    throw new Error("package-smoke.mjs 目前只支援 Windows(exe 路徑/taskkill 皆為 Windows 專用邏輯)。");
  }

  if (!SKIP_BUILD) {
    log("執行 `pnpm package:dir`(bundle-core + build + electron-builder --dir)...");
    execSync("pnpm package:dir", { cwd: REPO_ROOT, stdio: "inherit" });
  } else {
    log("--skip-build:略過 `pnpm package:dir`,直接使用既有的 release/win-unpacked/");
  }

  if (!existsSync(EXE_PATH)) {
    throw new Error(`找不到 ${EXE_PATH} —— 確認 pnpm package:dir 是否成功、electron-builder 的 output 目錄設定是否有變。`);
  }
  log(`找到 unpacked exe: ${EXE_PATH}`);

  const filteredPath = buildPathWithoutNode();
  assertNodeUnreachable(filteredPath);

  const tmpDataDir = mkdtempSync(path.join(os.tmpdir(), "deskmony-package-smoke-"));
  log(`暫存 DESKMONY_DATA_DIR: ${tmpDataDir}`);

  const outputLines = [];
  let abiErrorDetected = null;
  let staticDirWarningDetected = null;

  const env = {
    ...process.env,
    PATH: filteredPath,
    Path: filteredPath, // Windows 環境變數大小寫不敏感,但保險起見兩個 key 都設
    DESKMONY_CORE_PORT: String(SMOKE_PORT),
    DESKMONY_AUTH_TOKEN: SMOKE_AUTH_TOKEN,
    DESKMONY_DATA_DIR: tmpDataDir,
  };

  log(`啟動 ${EXE_PATH}(port=${SMOKE_PORT}, PATH 已過濾 node.exe)...`);
  const child = spawn(EXE_PATH, [], { env, stdio: ["ignore", "pipe", "pipe"] });

  const onChunk = (streamName) => (chunk) => {
    const text = chunk.toString();
    outputLines.push(`[${streamName}] ${text}`);
    process.stdout.write(`[exe:${streamName}] ${text}`);
    for (const pattern of ABI_ERROR_PATTERNS) {
      if (pattern.test(text)) {
        abiErrorDetected = `輸出中出現 ABI 不相容錯誤字樣(pattern=${pattern}): ${text.trim()}`;
      }
    }
    if (STATIC_DIR_WARNING_PATTERN.test(text)) {
      staticDirWarningDetected = `輸出中出現「找不到瀏覽器 UI 靜態檔案」警告(代表 resources/desktop-ui 沒有正確就位): ${text.trim()}`;
    }
  };
  child.stdout.on("data", onChunk("stdout"));
  child.stderr.on("data", onChunk("stderr"));

  let exitedEarly = null;
  child.on("exit", (code, signal) => {
    exitedEarly = { code, signal };
  });

  let ws;
  try {
    const deadline = Date.now() + PORT_WAIT_TIMEOUT_MS;
    let lastErr;
    while (Date.now() < deadline) {
      if (abiErrorDetected) throw new Error(abiErrorDetected);
      if (staticDirWarningDetected) throw new Error(staticDirWarningDetected);
      if (exitedEarly) {
        throw new Error(
          `exe process 在 WS port 開放前就結束了(code=${exitedEarly.code}, signal=${exitedEarly.signal})——` +
            `很可能就是 core 子程序啟動失敗(ABI 不相容或其他錯誤),見上方 stdout/stderr。`,
        );
      }
      try {
        ws = await waitForWsOpen(`ws://127.0.0.1:${SMOKE_PORT}`, 1500);
        break;
      } catch (err) {
        lastErr = err;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    if (!ws) {
      throw new Error(`等待 WS Gateway 開始監聽逾時(${PORT_WAIT_TIMEOUT_MS}ms): ${lastErr}`);
    }
    log(`WS port ${SMOKE_PORT} 已開始監聽,送出 auth request...`);

    const authResult = await rpcAuth(ws, SMOKE_AUTH_TOKEN);
    log(`auth 成功: ${JSON.stringify(authResult)}`);

    if (abiErrorDetected) {
      throw new Error(abiErrorDetected);
    }
    if (staticDirWarningDetected) {
      throw new Error(staticDirWarningDetected);
    }

    log(`對 http://127.0.0.1:${SMOKE_PORT}/ 送出 HTTP GET,驗證打包後的 core 也能提供瀏覽器 UI 靜態檔案...`);
    const httpRes = await fetch(`http://127.0.0.1:${SMOKE_PORT}/`);
    if (httpRes.status !== 200) {
      throw new Error(`GET / 回應狀態碼不是 200(實際: ${httpRes.status})`);
    }
    const httpBody = await httpRes.text();
    if (httpBody.includes(STATIC_INDEX_NOT_FOUND_TEXT)) {
      throw new Error(
        `GET / 回應內容是 static-server.ts 的 404 fallback 文字(含「${STATIC_INDEX_NOT_FOUND_TEXT}」)` +
          ",不是真正的 index.html —— resources/desktop-ui 沒有正確就位。",
      );
    }
    if (!httpBody.includes("<html") || !httpBody.includes("<title>Deskmony</title>")) {
      throw new Error(
        `GET / 回應內容不像 apps/desktop/dist/index.html(缺少 <html 或 <title>Deskmony</title> 字樣): ${httpBody.slice(0, 200)}`,
      );
    }
    log(`PASS: GET / 回應 200,內容是真正的 index.html(長度 ${httpBody.length} bytes),不是 404 fallback。`);

    if (abiErrorDetected) {
      throw new Error(abiErrorDetected);
    }
    if (staticDirWarningDetected) {
      throw new Error(staticDirWarningDetected);
    }

    log("PASS: 在過濾掉系統 Node.js 的 PATH 下,打包後的 exe 成功啟動 core 子程序並完成 WS 認證,");
    log("      HTTP GET / 也正確回傳瀏覽器 UI 的 index.html,沒有出現任何 ABI 不相容錯誤字樣或");
    log("      「找不到瀏覽器 UI 靜態檔案」警告 —— 確認 packaged 模式不依賴系統 Node.js,且");
    log("      resources/desktop-ui 已正確就位。");
  } finally {
    try {
      ws?.close();
    } catch {
      // ignore
    }
    killProcessTree(child.pid);
    // 給 taskkill 一點時間真正把 process 收掉,再清暫存目錄(Windows 上檔案
    // handle 可能還沒完全釋放,重試幾次避免偶發的 EBUSY/EPERM)。
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        rmSync(tmpDataDir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  }
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error(`[package-smoke] FAIL: ${err.message ?? err}`);
    process.exit(1);
  });
