/**
 * P3.3 實驗:不在畫面上的 <webview> 還能不能被 CDP 操作(2026-10-20,見 docs/LAYER-4-detail-design/side-panel_detail.md §P3.3)。
 *
 * P4 要讓 agent 操作「使用者現在沒在看」的 session 瀏覽器(面板關著/在別的分頁/切到別的 session),所以要先確認 Electron 44 下,
 * 一個**已掛載但不在畫面上**的 webview 仍然:
 *   1. CDP `Page.captureScreenshot` 回傳非空白的畫面;
 *   2. CDP `Input.dispatchMouseEvent` 的點擊會觸發頁面的 click handler;
 *   3. CDP `Input.insertText` 能輸入到 focus 的 input;
 *   4. `loadURL` 之後 `did-finish-load` 正常觸發;
 *   5. 在「可見位置」與「隱藏位置」之間來回移動不會重新載入(沒有 did-start-loading/did-navigate、頁面狀態與伺服器請求數都不變)。
 * 同一組 5 項檢查對四種「位置」各跑一次(每種一個獨立的視窗與 webview,依序進行,同時只存在一個視窗):
 *   visible    基準:webview 在畫面上(sanity check,這組不過代表實驗本身有問題)
 *   offscreen  webview 外框 `position: fixed; left: -20000px`,保持 1024×768(BrowserHost 目前停放 webview 的方式)
 *   opacity0   webview 在原位但 `opacity: 0`,上面再蓋一塊不透明的面板內容區
 *   clip1x1    外框 1×1 且 `overflow: hidden`,webview 本身仍是 1024×768(被裁切成 1×1 可見)
 * 輸出每一項 PASS/FAIL 與細節,最後給出建議的隱藏方式。
 *
 * ## 執行方式(從 repo 根目錄)
 *   Windows (cmd/PowerShell):  apps\desktop\node_modules\.bin\electron.cmd scripts\spike\webview-offscreen.cjs
 *   macOS/Linux:               apps/desktop/node_modules/.bin/electron scripts/spike/webview-offscreen.cjs
 *   或 pnpm:                   pnpm --filter @deskmony/desktop exec electron ../../scripts/spike/webview-offscreen.cjs
 * 選用參數(接在腳本路徑後):`--out=<檔案>` 把結果另存成 JSON。
 *
 * ## 行為
 *  - 會依序**開 4 個 Electron 視窗**(每種位置一個,測完立刻關閉,同時只有一個;視窗是真的顯示出來的,因為正式 app 的視窗也是顯示的——
 *    用 show:false 會變成另一個實驗)。
 *  - 本機 HTTP 伺服器只綁 127.0.0.1、隨機 port,結束時關閉;userData 用暫存目錄,結束時刪除(刪不掉會在最後一行印出路徑)。
 *  - 全程有逾時(每個 CDP 指令 6 秒、每種位置 60 秒、整體 5 分鐘 watchdog),一定會自己結束:`app.exit(code)`,不留殘餘行程。
 *    預期總時間約 20–40 秒(各項檢查通過時;有逾時的項目會拉長)。
 *  - 結束碼:0 = 實驗跑完且基準(visible)5/5 通過;1 = 基準沒過(實驗結果不可信);2 = 腳本本身出錯或 watchdog 觸發。
 *    「隱藏方式行不行」看輸出的 VERDICT 行,不影響結束碼。
 */
"use strict";

const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { app, BrowserWindow, nativeImage } = require("electron");

const CDP_TIMEOUT_MS = 6000;
const LOAD_TIMEOUT_MS = 10000;
const VARIANT_TIMEOUT_MS = 60000;
const GLOBAL_TIMEOUT_MS = 5 * 60 * 1000;
const SETTLE_MS = 500; // 改了位置之後等合成器反應的時間

/** 四種位置;`pos` 是 host 頁面的 `window.__setPos(name)` 套用的外框與 webview 樣式。 */
const VARIANTS = [
  { name: "visible", desc: "webview 在畫面上(基準)", hidden: false },
  { name: "offscreen", desc: "外框 left:-20000px,保持 1024x768", hidden: true },
  { name: "opacity0", desc: "opacity:0,上面蓋一塊不透明的面板內容區", hidden: true },
  { name: "clip1x1", desc: "外框 1x1 + overflow:hidden,webview 仍是 1024x768", hidden: true },
];

// ---------------------------------------------------------------------------------------------
// 本機 HTTP 伺服器:測試頁(有 click handler、input、可見文字)、第二頁(給 loadURL 檢查)、host 頁(內含 <webview>)
// ---------------------------------------------------------------------------------------------

const MAIN_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>spike-main</title>
<style>
html,body{margin:0;background:#fff;font:16px sans-serif}
#txt{position:absolute;left:40px;top:20px;margin:0}
#btn{position:absolute;left:40px;top:80px;width:200px;height:60px;background:#d22;color:#fff;border:0;font-size:18px}
#inp{position:absolute;left:40px;top:180px;width:300px;height:32px;font-size:16px}
</style></head><body>
<h1 id="txt">SPIKE_VISIBLE_TEXT</h1>
<button id="btn" type="button">Click me</button>
<input id="inp" type="text" autocomplete="off">
<script>
window.__loadId = Math.random().toString(36).slice(2);
window.__clicks = 0;
document.getElementById("btn").addEventListener("click", function () { window.__clicks++; });
</script></body></html>`;

const SECOND_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>spike-second</title></head>
<body style="background:#fff"><h1>SPIKE_SECOND_PAGE</h1></body></html>`;

/** host 頁:一個外框 div 裡放一個 <webview>,以及一塊平常隱藏的「面板內容區」遮罩(opacity0 方案用)。 */
function hostPage(variant, guestUrl) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>spike-host-${variant}</title>
<style>
html,body{margin:0;height:100%;background:#2b2b2b;color:#ddd;font:14px sans-serif;overflow:hidden}
#frame{position:fixed;overflow:hidden;background:#fff}
#cover{position:fixed;left:20px;top:20px;width:600px;height:500px;background:#555;z-index:2;display:none}
</style></head><body>
<div id="cover">panel content (opaque, in front of the webview)</div>
<div id="frame"><webview id="wv" partition="spike-${variant}" src="${guestUrl}" style="display:flex"></webview></div>
<script>
var POS = {
  visible:   { frame: { left: "20px", top: "20px", width: "600px", height: "500px", opacity: "1", zIndex: "1" }, wv: { width: "100%", height: "100%" }, cover: false },
  offscreen: { frame: { left: "-20000px", top: "0px", width: "1024px", height: "768px", opacity: "1", zIndex: "1" }, wv: { width: "100%", height: "100%" }, cover: false },
  opacity0:  { frame: { left: "20px", top: "20px", width: "600px", height: "500px", opacity: "0", zIndex: "1" }, wv: { width: "100%", height: "100%" }, cover: true },
  clip1x1:   { frame: { left: "20px", top: "20px", width: "1px", height: "1px", opacity: "1", zIndex: "1" }, wv: { width: "1024px", height: "768px" }, cover: false }
};
window.__setPos = function (name) {
  var p = POS[name];
  if (!p) throw new Error("unknown position " + name);
  Object.assign(document.getElementById("frame").style, p.frame);
  Object.assign(document.getElementById("wv").style, p.wv);
  document.getElementById("cover").style.display = p.cover ? "block" : "none";
  return name;
};
window.__setPos(${JSON.stringify(variant)});
</script></body></html>`;
}

let hits = {};

function startServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      hits[url.pathname] = (hits[url.pathname] ?? 0) + 1;
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      if (url.pathname === "/") res.end(MAIN_PAGE);
      else if (url.pathname === "/second") res.end(SECOND_PAGE);
      else if (url.pathname === "/host") {
        const variant = url.searchParams.get("variant") ?? "visible";
        const port = server.address().port;
        res.end(hostPage(variant, `http://127.0.0.1:${port}/`));
      } else {
        res.statusCode = 404;
        res.end("not found");
      }
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

// ---------------------------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout ${ms}ms: ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** 等一次事件(逾時就 reject)。 */
function waitEvent(emitter, event, ms) {
  return new Promise((resolve, reject) => {
    const onEvent = (...args) => {
      clearTimeout(timer);
      resolve(args);
    };
    const timer = setTimeout(() => {
      emitter.removeListener(event, onEvent);
      reject(new Error(`timeout ${ms}ms waiting for ${event}`));
    }, ms);
    emitter.once(event, onEvent);
  });
}

/** CDP 指令(有逾時:隱藏的 webview 如果不出畫面,`captureScreenshot` 之類可能永遠不回)。 */
function cdp(wc, method, params) {
  return withTimeout(wc.debugger.sendCommand(method, params ?? {}), CDP_TIMEOUT_MS, `CDP ${method}`);
}

async function evalInGuest(wc, expression) {
  const { result, exceptionDetails } = await cdp(wc, "Runtime.evaluate", { expression, returnByValue: true });
  if (exceptionDetails) throw new Error(`page threw: ${exceptionDetails.text}`);
  return result.value;
}

/** 截圖 → 取像素;判斷是不是空白:要有夠多紅色(測試頁的按鈕)且不只一種顏色。 */
function analyzeScreenshot(base64) {
  const image = nativeImage.createFromBuffer(Buffer.from(base64, "base64"));
  const { width, height } = image.getSize();
  if (!width || !height) return { ok: false, detail: "empty image (0x0)" };
  const bitmap = image.toBitmap(); // BGRA
  let reds = 0;
  const colors = new Set();
  for (let i = 0; i + 3 < bitmap.length; i += 4) {
    const b = bitmap[i];
    const g = bitmap[i + 1];
    const r = bitmap[i + 2];
    if (r > 180 && g < 90 && b < 90) reds++;
    if (colors.size < 64) colors.add((r << 16) | (g << 8) | b);
  }
  const ok = reds >= 500 && colors.size > 2;
  return { ok, detail: `size=${width}x${height} redPixels=${reds} distinctColors>=${colors.size}` };
}

// ---------------------------------------------------------------------------------------------
// 一種位置的 5 項檢查
// ---------------------------------------------------------------------------------------------

async function runVariant(server, variant) {
  const checks = [];
  const record = (id, name, ok, detail) => {
    checks.push({ id, name, ok, detail });
    console.log(`  [${ok ? "PASS" : "FAIL"}] ${id}. ${name} — ${detail}`);
  };
  const attempt = async (id, name, fn) => {
    try {
      const { ok, detail } = await fn();
      record(id, name, ok, detail);
    } catch (error) {
      record(id, name, false, error instanceof Error ? error.message : String(error));
    }
  };

  console.log(`\n== ${variant.name}: ${variant.desc} ==`);
  hits = {};
  const port = server.address().port;
  const win = new BrowserWindow({
    width: 900,
    height: 640,
    show: true,
    backgroundColor: "#2b2b2b",
    webPreferences: { webviewTag: true, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  try {
    // ---- 載入 host 頁、等 <webview> 附掛並載完 ----
    const attached = waitEvent(win.webContents, "did-attach-webview", LOAD_TIMEOUT_MS);
    attached.catch(() => undefined); // host 頁載入失敗時不留下沒人處理的 rejection
    await withTimeout(win.loadURL(`http://127.0.0.1:${port}/host?variant=${variant.name}`), LOAD_TIMEOUT_MS, "host loadURL");
    const [, guest] = await attached;
    if (guest.isLoading() || !guest.getURL()) await waitEvent(guest, "did-finish-load", LOAD_TIMEOUT_MS);
    guest.debugger.attach("1.3");
    await sleep(SETTLE_MS);
    const setPos = (name) => win.webContents.executeJavaScript(`window.__setPos(${JSON.stringify(name)})`);

    // ---- 1. 截圖非空白 ----
    await attempt(1, "CDP Page.captureScreenshot returns a non-blank image", async () => {
      const { data } = await cdp(guest, "Page.captureScreenshot", { format: "png" });
      return analyzeScreenshot(data);
    });

    // ---- 2. 滑鼠點擊觸發 click handler ----
    await attempt(2, "CDP Input.dispatchMouseEvent click fires the page's click handler", async () => {
      const before = await evalInGuest(guest, "window.__clicks");
      const rect = JSON.parse(await evalInGuest(guest, 'JSON.stringify(document.getElementById("btn").getBoundingClientRect())'));
      const x = Math.round(rect.left + rect.width / 2);
      const y = Math.round(rect.top + rect.height / 2);
      await cdp(guest, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      await cdp(guest, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
      await cdp(guest, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
      await sleep(150);
      const after = await evalInGuest(guest, "window.__clicks");
      return { ok: after === before + 1, detail: `clicks ${before} -> ${after} at (${x},${y})` };
    });

    // ---- 3. insertText 輸入到 focus 的 input ----
    await attempt(3, "CDP Input.insertText types into the focused input", async () => {
      const focused = await evalInGuest(guest, 'document.getElementById("inp").focus(), document.activeElement && document.activeElement.id');
      await cdp(guest, "Input.insertText", { text: "hello-spike" });
      await sleep(150);
      const value = await evalInGuest(guest, 'document.getElementById("inp").value');
      const hasFocus = await evalInGuest(guest, "document.hasFocus()");
      return { ok: focused === "inp" && value === "hello-spike", detail: `activeElement=${focused} value=${JSON.stringify(value)} document.hasFocus()=${hasFocus}` };
    });

    // ---- 5(先於 4,因為 4 會導覽離開測試頁)來回移動不重新載入 ----
    await attempt(5, "moving between visible and this position does not reload the page", async () => {
      const snapshot = async () => ({
        loadId: await evalInGuest(guest, "window.__loadId"),
        value: await evalInGuest(guest, 'document.getElementById("inp").value'),
        clicks: await evalInGuest(guest, "window.__clicks"),
        serverHits: hits["/"] ?? 0,
      });
      const before = await snapshot();
      const events = [];
      const watched = ["did-start-loading", "did-navigate", "did-finish-load", "dom-ready", "render-process-gone"];
      const listeners = watched.map((event) => {
        const listener = () => events.push(event);
        guest.on(event, listener);
        return [event, listener];
      });
      try {
        // 可見基準:visible 方案來回移到 offscreen;其餘方案是「visible <-> 該位置」。
        const away = variant.name === "visible" ? "offscreen" : "visible";
        await setPos(away);
        await sleep(SETTLE_MS);
        await setPos(variant.name);
        await sleep(SETTLE_MS);
        await setPos(away);
        await sleep(SETTLE_MS);
        await setPos(variant.name);
        await sleep(SETTLE_MS);
      } finally {
        for (const [event, listener] of listeners) guest.removeListener(event, listener);
      }
      const after = await snapshot();
      const same = before.loadId === after.loadId && before.value === after.value && before.clicks === after.clicks && before.serverHits === after.serverHits;
      return {
        ok: same && events.length === 0,
        detail: `events=[${events.join(",")}] loadId ${before.loadId === after.loadId ? "same" : "CHANGED"} inputValue ${before.value === after.value ? "kept" : "LOST"} serverHits ${before.serverHits}->${after.serverHits}`,
      };
    });

    // ---- 4. loadURL + did-finish-load ----
    await attempt(4, "loadURL then did-finish-load fires", async () => {
      const finished = waitEvent(guest, "did-finish-load", LOAD_TIMEOUT_MS);
      guest.loadURL(`http://127.0.0.1:${port}/second`).catch(() => undefined); // 失敗由 did-finish-load 逾時反映
      await finished;
      const title = await evalInGuest(guest, "document.title");
      return { ok: title === "spike-second", detail: `title=${JSON.stringify(title)} url=${guest.getURL()}` };
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`  [SETUP FAILED] ${message}`);
    for (const id of [1, 2, 3, 4, 5]) if (!checks.some((c) => c.id === id)) record(id, "(not run)", false, `setup failed: ${message}`);
  } finally {
    if (!win.isDestroyed()) win.destroy();
    await sleep(300);
  }
  checks.sort((a, b) => a.id - b.id);
  return { variant: variant.name, hidden: variant.hidden, checks, passed: checks.filter((c) => c.ok).length };
}

// ---------------------------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------------------------

function cleanup(userData) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.rmSync(userData, { recursive: true, force: true });
      return true;
    } catch {
      // Windows 上 Chromium 可能還握著檔案;再試一次
    }
  }
  return !fs.existsSync(userData);
}

async function main() {
  const startedAt = Date.now();
  const outArg = process.argv.find((arg) => arg.startsWith("--out="));
  const outPath = outArg ? outArg.slice("--out=".length) : undefined;
  console.log(`Electron ${process.versions.electron} / Chromium ${process.versions.chrome} / ${process.platform} ${os.release()}`);
  console.log("Opens 4 windows one after another (visible, offscreen, opacity0, clip1x1); each is closed before the next opens.");

  await app.whenReady();
  const server = await startServer();
  const results = [];
  for (const variant of VARIANTS) {
    try {
      results.push(await withTimeout(runVariant(server, variant), VARIANT_TIMEOUT_MS, `variant ${variant.name}`));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`  [VARIANT ABORTED] ${message}`);
      results.push({ variant: variant.name, hidden: variant.hidden, checks: [], passed: 0, aborted: message });
      for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.destroy();
    }
  }
  server.close();

  // ---- 總結 ----
  console.log("\n==== SUMMARY (checks passed / 5) ====");
  for (const r of results) {
    const failed = r.checks.filter((c) => !c.ok).map((c) => c.id);
    console.log(`  ${r.variant.padEnd(10)} ${r.passed}/5${failed.length ? `   FAIL: ${failed.join(",")}` : ""}${r.aborted ? `   ABORTED: ${r.aborted}` : ""}`);
  }
  const baseline = results.find((r) => r.variant === "visible");
  const baselineOk = baseline !== undefined && baseline.passed === 5;
  const workable = results.filter((r) => r.hidden && r.passed === 5).map((r) => r.variant);
  if (!baselineOk) console.log("\nBASELINE (visible) DID NOT PASS 5/5 — the experiment itself is unreliable on this machine; do not draw conclusions.");
  console.log(
    `\nVERDICT: ${workable.length ? `hidden webview works with: ${workable.join(", ")} (prefer them in this order: offscreen, opacity0, clip1x1)` : "NO hiding method passed all 5 checks — P4 must keep the webview visible (e.g. 1x1 is not enough) or auto-open the panel"}`,
  );
  console.log(`Duration: ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);

  if (outPath) {
    try {
      fs.writeFileSync(outPath, JSON.stringify({ electron: process.versions.electron, chrome: process.versions.chrome, platform: process.platform, results, verdict: workable }, null, 2));
      console.log(`Results written to ${outPath}`);
    } catch (error) {
      console.log(`Could not write ${outPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return baselineOk ? 0 : 1;
}

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "deskmony-spike-webview-"));
app.setPath("userData", userData);
// 視窗一個個關掉時 app 預設會 quit——這裡要自己決定何時結束。
app.on("window-all-closed", () => undefined);

const watchdog = setTimeout(() => {
  console.log(`WATCHDOG: the experiment did not finish within ${GLOBAL_TIMEOUT_MS / 1000}s — exiting`);
  cleanup(userData);
  app.exit(2);
}, GLOBAL_TIMEOUT_MS);

main()
  .then((code) => finish(code))
  .catch((error) => {
    console.log(`SCRIPT ERROR: ${error instanceof Error ? error.stack : String(error)}`);
    finish(2);
  });

function finish(code) {
  clearTimeout(watchdog);
  for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.destroy();
  const cleaned = cleanup(userData);
  if (!cleaned) console.log(`NOTE: could not delete the temporary userData directory: ${userData}`);
  app.exit(code);
}
