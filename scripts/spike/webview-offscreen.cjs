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
 * 同一組 5 項檢查對七種「位置」各跑一次(每種一個獨立的視窗與 webview,依序進行,同時只存在一個視窗):
 *   visible         基準:webview 在畫面上(sanity check,這組不過代表實驗本身有問題)
 *   offscreen       webview 外框 `position: fixed; left: -20000px`,保持 1024×768
 *   opacity0        webview 在原位但 `opacity: 0`,上面再蓋一塊不透明的面板內容區
 *   clip1x1         外框 1×1 且 `overflow: hidden`,webview 本身仍是 1024×768(被裁切成 1×1 可見)
 *   parked          P3 的停放方式(`apps/desktop/src/lib/browser-frame-style.ts`):外框 `position: fixed; left: 0; top: 0;
 *                   width: 1024px; height: 768px; opacity: 0; z-index: -1; pointer-events: none`,上面有一塊不透明的全版面「app 外殼」(在流內、不是 positioned,
 *                   對應 `.app-shell` 的 `bg-canvas`)。不用 visibility:hidden / display:none。
 *   parked-inert    前一版的正式停放方式:同 `parked`,外框再加 `inert`(讓停放中的 webview 不能被 Tab 聚焦)。第一版實驗腳本(真 Electron,2026-10-23)是 5/5、Tab 進不去。
 *                   同一天驗證腳本在真 app 的停放階段 click 失敗,當時歸因於 inert,**事後發現是驗證腳本自己的計數 bug**(見 `verify-browser-host-real.mjs`
 *                   的 `expectOneClick()` 註解),所以 inert 會不會影響 CDP 點擊**沒有結論**。這一組(加上下面的生命週期)就是在補那個對照。
 *   parked-tabindex **BrowserHost 現行的正式停放方式**:同 `parked`,再把 `<webview>` 設 `tabindex="-1"`(可見時移除),只是讓它退出 Tab 順序,
 *                   不阻止它被聚焦(`BrowserHost.tsx`、`browserWebviewTabIndex()`)。要確認的有兩件事:5 項檢查都過(尤其點擊)、Tab 檢查進不去。
 *
 * ## 生命週期(讓實驗更像真 app)
 * 第一版的每個視窗一載入就在目標位置、馬上做檢查;真 app 的 webview 是「出生在停放位置 → 面板打開變可見、agent/使用者操作過 → 使用者切到別的 session
 * 又被停放 → embedder(使用者)的焦點在別處,agent 再叫它點擊」。這是最接近真 app 的做法,也是 inert 若真有問題最可能現形的情境。現在每個位置的視窗都照這個順序:
 *   1. host 頁面載入時 webview 就**出生在該位置**(`inert`/`tabindex`/`aria-hidden` 直接寫在 HTML 裡,和 React 建立元素時一樣);
 *   2. 移到 `visible`,用 CDP 點按鈕、點輸入框、輸入文字(像 agent 在可見狀態下操作),再清空輸入框;
 *   3. 移到目標位置(inert 等在這時才**動態**加上),等 SETTLE_MS;
 *   4. 讓 host 頁面的焦點落在別的元素(`#other`,模擬使用者按了 session 清單);
 *   5. 才開始 5 項檢查;檢查 5 來回移動兩輪之後**再點一次**(再次動態加上屬性之後的點擊)。
 * 另外 host 頁面還對齊 app 的細節:停放時外框有 `aria-hidden="true"`、webview 帶 `allowpopups="true"`。
 *
 * 另外對 visible / parked / parked-inert / parked-tabindex 各做一個鍵盤檢查(不計入 5 項,但納入結論):在 host 頁面按 Tab 三次,記錄每次之後
 * `document.activeElement` 的標籤(WEBVIEW = 焦點進了 webview;其他 = 沒進去)。預期 visible 與 parked 會進去,parked-tabindex 與 parked-inert 不會。
 * 輸出每一項 PASS/FAIL 與細節,最後給出建議的隱藏方式與「Tab 防護」的結論(parked-tabindex 與 parked-inert 各一行:5 項是否全過、Tab 是否進得去);
 * `parked-tabindex` 沒有 5/5 或 Tab 進得去會另外大聲警告(代表目前的正式停放方式有問題)。
 *
 * ## 執行方式(從 repo 根目錄)
 *   Windows (cmd/PowerShell):  apps\desktop\node_modules\.bin\electron.cmd scripts\spike\webview-offscreen.cjs
 *   macOS/Linux:               apps/desktop/node_modules/.bin/electron scripts/spike/webview-offscreen.cjs
 *   或 pnpm:                   pnpm --filter @deskmony/desktop exec electron ../../scripts/spike/webview-offscreen.cjs
 * 選用參數(接在腳本路徑後):`--out=<檔案>` 把結果另存成 JSON。
 *
 * ## 行為
 *  - 會依序**開 7 個 Electron 視窗**(每種位置一個,測完立刻關閉,同時只有一個;視窗是真的顯示出來的,因為正式 app 的視窗也是顯示的——
 *    用 show:false 會變成另一個實驗)。
 *  - 本機 HTTP 伺服器只綁 127.0.0.1、隨機 port,結束時關閉;userData 用暫存目錄,結束時刪除(刪不掉會在最後一行印出路徑)。
 *  - 全程有逾時(每個 CDP 指令 6 秒、每種位置 90 秒、整體 10 分鐘 watchdog),一定會自己結束:`app.exit(code)`,不留殘餘行程。
 *    預期總時間約 45–90 秒(各項檢查通過時;有逾時的項目會拉長——例如 offscreen 的截圖會等滿 6 秒)。
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
const VARIANT_TIMEOUT_MS = 90000;
const GLOBAL_TIMEOUT_MS = 10 * 60 * 1000;
const SETTLE_MS = 500; // 改了位置之後等合成器反應的時間

/** 七種位置;各自的外框與 webview 樣式/屬性在下面的 `POSITIONS` 表,host 頁面由 `window.__setPos(name)` 套用。 */
const VARIANTS = [
  { name: "visible", desc: "webview 在畫面上(基準)", hidden: false },
  { name: "offscreen", desc: "外框 left:-20000px,保持 1024x768", hidden: true },
  { name: "opacity0", desc: "opacity:0,上面蓋一塊不透明的面板內容區", hidden: true },
  { name: "clip1x1", desc: "外框 1x1 + overflow:hidden,webview 仍是 1024x768", hidden: true },
  { name: "parked", desc: "P3 的停放方式:fixed 0,0、1024x768、opacity 0、z-index -1、pointer-events none,上面是不透明的 app 外殼", hidden: true },
  { name: "parked-inert", desc: "前一版的正式停放方式(對照):同 parked,外框再加 inert 屬性", hidden: true },
  { name: "parked-tabindex", desc: "正式停放方式:同 parked,<webview> 設 tabindex=-1(退出 Tab 順序,仍可被聚焦)", hidden: true },
];

/** 會做鍵盤檢查(按 Tab 焦點會不會進 webview)的位置。 */
const TAB_PROBE_VARIANTS = new Set(["visible", "parked", "parked-inert", "parked-tabindex"]);

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

const PARKED_FRAME = { left: "0px", top: "0px", width: "1024px", height: "768px", opacity: "0", zIndex: "-1", pointerEvents: "none" };
const FILL = { width: "100%", height: "100%" };

/**
 * 每個位置:`frame`(外框的行內樣式)、`wv`(webview 的行內樣式)、`cover`/`shell`(遮罩與 app 外殼是否顯示)、
 * `inert`(外框的 inert 屬性)、`ariaHidden`(外框的 aria-hidden,app 停放時有)、`wvTabindex`(webview 的 tabindex,`null` = 不設)。
 * 同一份表既用來產生 host 頁面的**初始 HTML**(webview 出生在該位置、屬性直接寫在標記裡),也嵌進頁面給 `__setPos()` 動態切換用。
 */
const POSITIONS = {
  visible: { frame: { left: "20px", top: "20px", width: "600px", height: "500px", opacity: "1", zIndex: "1", pointerEvents: "auto" }, wv: FILL, cover: false, shell: false, inert: false, ariaHidden: false, wvTabindex: null },
  offscreen: { frame: { left: "-20000px", top: "0px", width: "1024px", height: "768px", opacity: "1", zIndex: "1", pointerEvents: "auto" }, wv: FILL, cover: false, shell: false, inert: false, ariaHidden: false, wvTabindex: null },
  opacity0: { frame: { left: "20px", top: "20px", width: "600px", height: "500px", opacity: "0", zIndex: "1", pointerEvents: "auto" }, wv: FILL, cover: true, shell: false, inert: false, ariaHidden: false, wvTabindex: null },
  clip1x1: { frame: { left: "20px", top: "20px", width: "1px", height: "1px", opacity: "1", zIndex: "1", pointerEvents: "auto" }, wv: { width: "1024px", height: "768px" }, cover: false, shell: false, inert: false, ariaHidden: false, wvTabindex: null },
  parked: { frame: PARKED_FRAME, wv: FILL, cover: false, shell: true, inert: false, ariaHidden: true, wvTabindex: null },
  "parked-inert": { frame: PARKED_FRAME, wv: FILL, cover: false, shell: true, inert: true, ariaHidden: true, wvTabindex: null },
  "parked-tabindex": { frame: PARKED_FRAME, wv: FILL, cover: false, shell: true, inert: false, ariaHidden: true, wvTabindex: "-1" },
};

/**
 * host 頁:一個外框 div 裡放一個 <webview>(帶 `allowpopups`,和 app 一樣),一塊平常隱藏的「面板內容區」遮罩(opacity0 方案用),
 * 以及一個不在 Tab 順序裡、可程式聚焦的 `#other` 按鈕(模擬使用者把焦點放在 app 的別處,例如 session 清單)。
 * webview 出生在 `variant` 的位置:該位置的 inert / aria-hidden / tabindex 直接寫在初始標記裡。
 */
function hostPage(variant, guestUrl) {
  const p = POSITIONS[variant];
  if (!p) throw new Error(`unknown variant ${variant}`);
  const frameAttrs = `${p.inert ? " inert" : ""}${p.ariaHidden ? ' aria-hidden="true"' : ""}`;
  const wvAttrs = p.wvTabindex !== null ? ` tabindex="${p.wvTabindex}"` : "";
  return `<!doctype html><html><head><meta charset="utf-8"><title>spike-host-${variant}</title>
<style>
html,body{margin:0;height:100%;background:#2b2b2b;color:#ddd;font:14px sans-serif;overflow:hidden}
#frame{position:fixed;overflow:hidden;background:#fff}
#cover{position:fixed;left:20px;top:20px;width:600px;height:500px;background:#555;z-index:2;display:none}
#other{position:fixed;right:10px;top:10px;z-index:5}
/* parked 方案:對應 App 的 .app-shell——在流內(不是 positioned、沒有 z-index)、不透明背景、鋪滿視口;fixed 且 z-index:-1 的外框會沉到它底下。 */
#shell{display:none;height:100vh;background:#444}
</style></head><body>
<div id="shell">app shell (opaque, in flow)</div>
<button id="other" type="button" tabindex="-1">other</button>
<div id="cover">panel content (opaque, in front of the webview)</div>
<div id="frame"${frameAttrs}><webview id="wv" partition="spike-${variant}" src="${guestUrl}" allowpopups="true"${wvAttrs} style="display:flex"></webview></div>
<script>
var POS = ${JSON.stringify(POSITIONS)};
window.__setPos = function (name) {
  var p = POS[name];
  if (!p) throw new Error("unknown position " + name);
  var frame = document.getElementById("frame");
  var wv = document.getElementById("wv");
  Object.assign(frame.style, p.frame);
  if (p.inert) frame.setAttribute("inert", ""); else frame.removeAttribute("inert");
  if (p.ariaHidden) frame.setAttribute("aria-hidden", "true"); else frame.removeAttribute("aria-hidden");
  Object.assign(wv.style, p.wv);
  if (p.wvTabindex !== null) wv.setAttribute("tabindex", p.wvTabindex); else wv.removeAttribute("tabindex");
  document.getElementById("cover").style.display = p.cover ? "block" : "none";
  document.getElementById("shell").style.display = p.shell ? "block" : "none";
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
// CDP 點擊與「app 裡一個 webview 的一生」
// ---------------------------------------------------------------------------------------------

/** 用 CDP 在 guest 的 (x, y)(頁面 CSS px)點一下:mouseMoved、mousePressed、mouseReleased(和 app 的執行器送的一樣)。 */
async function cdpClickAt(guest, x, y) {
  await cdp(guest, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await cdp(guest, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
  await cdp(guest, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
}

/** 點 guest 裡某個元素的中心;回傳點擊前後頁面的點擊計數。 */
async function cdpClickElement(guest, id) {
  const before = await evalInGuest(guest, "window.__clicks");
  const rect = JSON.parse(await evalInGuest(guest, `JSON.stringify(document.getElementById(${JSON.stringify(id)}).getBoundingClientRect())`));
  const x = Math.round(rect.left + rect.width / 2);
  const y = Math.round(rect.top + rect.height / 2);
  await cdpClickAt(guest, x, y);
  await sleep(150);
  const after = await evalInGuest(guest, "window.__clicks");
  return { before, after, x, y };
}

/**
 * 讓 webview 走一遍 app 裡的一生(第一版實驗沒有做這件事,所以沒抓到 `inert` 讓停放中的點擊失效——見檔頭的「生命週期」):
 * 出生在目標位置(host 頁面的初始 HTML)→ 移到可見、agent 式的操作(點按鈕、點輸入框、輸入文字,再清空)→ 移回目標位置(屬性在這時動態加上)→
 * host 頁面的焦點落到別的元素(使用者按了 session 清單)。回傳給檢查用的描述字串。失敗不中斷(預熱本身壞了,後面的檢查會自己說明)。
 */
async function simulateAppLifecycle(win, guest, variant, setPos) {
  const notes = [];
  try {
    await setPos("visible");
    await sleep(SETTLE_MS);
    const click = await cdpClickElement(guest, "btn");
    notes.push(`visible click ${click.before}->${click.after}`);
    const inp = JSON.parse(await evalInGuest(guest, 'JSON.stringify(document.getElementById("inp").getBoundingClientRect())'));
    await cdpClickAt(guest, Math.round(inp.left + inp.width / 2), Math.round(inp.top + inp.height / 2));
    await cdp(guest, "Input.insertText", { text: "warm" });
    await sleep(100);
    notes.push(`typed=${JSON.stringify(await evalInGuest(guest, 'document.getElementById("inp").value'))}`);
    await evalInGuest(guest, 'document.getElementById("inp").value = "", 0'); // 清空,讓後面的檢查從乾淨狀態開始
  } catch (error) {
    notes.push(`warm-up failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  await setPos(variant.name);
  await sleep(SETTLE_MS);
  try {
    win.focus();
    await win.webContents.executeJavaScript('document.getElementById("other").focus(), document.activeElement.id');
    await sleep(200);
    notes.push("host focus moved to #other");
  } catch (error) {
    notes.push(`moving host focus failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return notes.join("; ");
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
  let tabFocus; // 資訊性的 Tab 焦點檢查結果(沒做或失敗就是 undefined)
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

    // ---- 0. app 式的生命週期(可見操作 → 停放 → host 焦點移走),之後才開始檢查 ----
    console.log(`  [lifecycle] ${await simulateAppLifecycle(win, guest, variant, setPos)}`);

    // ---- 1. 截圖非空白 ----
    await attempt(1, "CDP Page.captureScreenshot returns a non-blank image", async () => {
      const { data } = await cdp(guest, "Page.captureScreenshot", { format: "png" });
      return analyzeScreenshot(data);
    });

    // ---- 2. 滑鼠點擊觸發 click handler ----
    await attempt(2, "CDP Input.dispatchMouseEvent click fires the page's click handler", async () => {
      const { before, after, x, y } = await cdpClickElement(guest, "btn");
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
    await attempt(5, "moving between visible and this position does not reload the page, and a click still lands afterwards", async () => {
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
      // 來回移動(屬性再次動態加上/移除)之後再點一次:這是 `inert` 讓點擊失效的情境(app 裡切走 session 再回來叫 agent 點擊)。
      let clickAfter;
      try {
        clickAfter = await cdpClickElement(guest, "btn");
      } catch (error) {
        clickAfter = { error: error instanceof Error ? error.message : String(error) };
      }
      const clickOk = clickAfter.error === undefined && clickAfter.after === clickAfter.before + 1;
      return {
        ok: same && events.length === 0 && clickOk,
        detail: `events=[${events.join(",")}] loadId ${before.loadId === after.loadId ? "same" : "CHANGED"} inputValue ${before.value === after.value ? "kept" : "LOST"} serverHits ${before.serverHits}->${after.serverHits}; click after round trip: ${clickAfter.error ?? `clicks ${clickAfter.before} -> ${clickAfter.after}`}`,
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

    // ---- 鍵盤檢查:按 Tab 焦點會不會進 webview(不計入 5 項,但納入結論;失敗不影響 5 項結果)----
    if (TAB_PROBE_VARIANTS.has(variant.name)) {
      try {
        await setPos(variant.name);
        await sleep(SETTLE_MS);
        win.focus();
        win.webContents.focus();
        await win.webContents.executeJavaScript("document.activeElement && document.activeElement.blur && document.activeElement.blur(), 0");
        const seen = [];
        for (let i = 0; i < 3; i++) {
          win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Tab" });
          win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Tab" });
          await sleep(120);
          seen.push(await win.webContents.executeJavaScript("document.activeElement ? document.activeElement.tagName : 'NONE'"));
        }
        // 只要有一次焦點落在 WEBVIEW 就算 Tab 進得去(進去之後焦點在 guest 裡,host 的 activeElement 會一直是 WEBVIEW)。
        tabFocus = seen.includes("WEBVIEW") ? "WEBVIEW" : seen[seen.length - 1];
        console.log(`  [INFO] pressing Tab 3x in the host page: document.activeElement after each = ${seen.join(", ")}  (WEBVIEW = focus went into the webview)`);
      } catch (error) {
        console.log(`  [INFO] Tab-focus probe failed (ignored): ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`  [SETUP FAILED] ${message}`);
    for (const id of [1, 2, 3, 4, 5]) if (!checks.some((c) => c.id === id)) record(id, "(not run)", false, `setup failed: ${message}`);
  } finally {
    if (!win.isDestroyed()) win.destroy();
    await sleep(300);
  }
  checks.sort((a, b) => a.id - b.id);
  return { variant: variant.name, hidden: variant.hidden, checks, passed: checks.filter((c) => c.ok).length, tabFocus };
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
  console.log(
    "Opens 7 windows one after another (visible, offscreen, opacity0, clip1x1, parked, parked-inert, parked-tabindex); each is closed before the next opens.\n" +
      "Each window follows an app-like lifecycle (born in position -> visible + CDP interaction -> back to position -> host focus elsewhere) before the checks.",
  );

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
    console.log(
      `  ${r.variant.padEnd(13)} ${r.passed}/5${failed.length ? `   FAIL: ${failed.join(",")}` : ""}${r.tabFocus ? `   Tab-focus: ${r.tabFocus}` : ""}${r.aborted ? `   ABORTED: ${r.aborted}` : ""}`,
    );
  }
  const baseline = results.find((r) => r.variant === "visible");
  const baselineOk = baseline !== undefined && baseline.passed === 5;
  const workable = results.filter((r) => r.hidden && r.passed === 5).map((r) => r.variant);
  if (!baselineOk) console.log("\nBASELINE (visible) DID NOT PASS 5/5 — the experiment itself is unreliable on this machine; do not draw conclusions.");
  const parkedResult = results.find((r) => r.variant === "parked");
  const inertResult = results.find((r) => r.variant === "parked-inert");
  const tabindexResult = results.find((r) => r.variant === "parked-tabindex");

  // ---- 兩種 Tab 防護的並排結論(inert 會不會影響 CDP 點擊是這次實驗要補的對照;沒有預設立場)----
  const guardLine = (name, r) => {
    if (!r) return `  ${name}: (not run)`;
    const clickFailed = r.checks.filter((c) => (c.id === 2 || c.id === 5) && !c.ok).map((c) => c.id);
    const tab = r.tabFocus === undefined ? "Tab check did not run" : r.tabFocus === "WEBVIEW" ? "Tab STILL reaches the webview" : "Tab blocked";
    return `  ${name}: ${r.passed}/5${clickFailed.length ? ` (click checks failing: ${clickFailed.join(",")})` : ""}; ${tab}`;
  };
  console.log("\nTAB GUARD COMPARISON (a usable guard = 5/5 including the click checks AND Tab blocked):");
  console.log(guardLine("parked-tabindex (current)", tabindexResult));
  console.log(guardLine("parked-inert    (previous)", inertResult));
  console.log(guardLine("parked          (no guard)", parkedResult));
  if (inertResult && inertResult.checks.some((c) => (c.id === 2 || c.id === 5) && !c.ok) && parkedResult && parkedResult.passed === 5) {
    console.log("  -> `inert` breaks CDP clicks here while `parked` passes: this reproduces the problem the real-app run was (wrongly or rightly) blamed on inert.");
  } else if (inertResult && inertResult.passed === 5 && parkedResult && parkedResult.passed === 5) {
    console.log("  -> `inert` does NOT break CDP clicks in this experiment (consistent with the real-app click failure having been a verification-script bug).");
  }

  // ---- 正式停放方式:parked-tabindex ----
  if (tabindexResult) {
    if (tabindexResult.passed !== 5) {
      console.log(
        "\n!!! WARNING: the production parking method (parked-tabindex: fixed 0,0 / 1024x768 / opacity 0 / z-index -1 / <webview tabindex=-1>) did NOT pass 5/5 — BrowserHost parks hidden webviews this way, so P4 screenshots/clicks on unseen sessions are at risk.",
      );
      if (parkedResult && parkedResult.passed === 5) {
        console.log("    `parked` (the same without tabindex) DID pass 5/5, so tabindex is what breaks it: make `browserWebviewTabIndex()` in apps/desktop/src/lib/browser-frame-style.ts return undefined and find another way to keep Tab out of a parked webview (without making it unfocusable).");
      }
    } else if (parkedResult && parkedResult.passed !== 5) {
      console.log("\n!!! WARNING: `parked` (without tabindex) did NOT pass 5/5 although `parked-tabindex` did — unexpected; re-run before drawing conclusions.");
    }
    if (tabindexResult.tabFocus !== undefined) {
      const blocked = tabindexResult.tabFocus !== "WEBVIEW";
      console.log(
        `\nTAB GUARD (parked-tabindex): ${blocked ? "OK — Tab did not move focus into the parked webview" : "NOT EFFECTIVE — Tab still reached the parked webview (tabindex=-1 is not enough)"}${parkedResult && parkedResult.tabFocus !== undefined ? ` (control, parked without tabindex: ${parkedResult.tabFocus})` : ""}`,
      );
    }
  }
  console.log(
    `\nVERDICT: ${workable.length ? `hidden webview works with: ${workable.join(", ")} (prefer them in this order: parked-tabindex, parked-inert, parked, opacity0, clip1x1, offscreen — but a parked method without a working Tab guard still lets Tab into the hidden page; see TAB GUARD COMPARISON)` : "NO hiding method passed all 5 checks — P4 must keep the webview visible (e.g. 1x1 is not enough) or auto-open the panel"}`,
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
