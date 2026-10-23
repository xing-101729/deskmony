#!/usr/bin/env node
/**
 * scripts/e2e-side-panel-pure.mjs
 *
 * 2026-10-20(右側面板 P1 review 修正):面板兩個純函式的測試——
 *   - apps/desktop/src/lib/panel-layout.ts:`computePanelLayout()`(面板寬度、聊天視圖最小寬度、覆蓋層切換);
 *   - apps/desktop/src/lib/terminal-input.ts:`splitTerminalInput()`(大段貼上分段,切點不落在 surrogate pair 中間)。
 *
 * 做法同 e2e-chat-groups.mjs:用 Node 直接載入 .ts(Node >= 22.18),被測檔案**沒有任何執行期 import**;
 * 不啟動 core、不需要 pnpm build,毫秒級。
 *
 * 用法:node scripts/e2e-side-panel-pure.mjs
 */

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.resolve(__dirname, "..", "apps", "desktop", "src", "lib");

if (!process.features.typescript) {
  console.error(`需要能直接執行 .ts 的 Node(>= 22.18,或加 --experimental-strip-types);目前是 ${process.version}`);
  process.exit(1);
}

const { computePanelLayout, PANEL_MIN_WIDTH, PANEL_CHAT_MIN_REM } = await import(pathToFileURL(path.join(LIB, "panel-layout.ts")).href);
const { splitTerminalInput } = await import(pathToFileURL(path.join(LIB, "terminal-input.ts")).href);

let passed = 0;
let total = 0;
function check(cond, label, detail) {
  total += 1;
  if (cond) {
    passed += 1;
    console.log(`  PASS ${label}`);
  } else {
    console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ""}`);
  }
}

const SIDEBAR_EXPANDED = 256; // 16rem(w-64)
const SIDEBAR_COLLAPSED = 52; // w-13
const layoutFor = (viewportWidth, sidebarWidth, preferredWidth = 480, extra = {}) =>
  computePanelLayout({
    areaWidth: viewportWidth - sidebarWidth,
    viewportWidth,
    rootFontPx: 16,
    smUp: viewportWidth >= 640,
    preferredWidth,
    ...extra,
  });
const chatLeft = (viewportWidth, sidebarWidth, layout) => viewportWidth - sidebarWidth - layout.width;

console.log("\n== panel-layout:聊天視圖最小寬度與覆蓋層切換 ==");
for (const [viewport, sidebar, name] of [
  [1280, SIDEBAR_EXPANDED, "1280 側欄展開"],
  [1280, SIDEBAR_COLLAPSED, "1280 側欄收合"],
  [1024, SIDEBAR_EXPANDED, "1024 側欄展開"],
  [1024, SIDEBAR_COLLAPSED, "1024 側欄收合"],
]) {
  const huge = layoutFor(viewport, sidebar, 5000);
  const chat = chatLeft(viewport, sidebar, huge);
  check(
    huge.mode === "side" && chat >= PANEL_CHAT_MIN_REM * 16 && huge.width >= PANEL_MIN_WIDTH && huge.width <= Math.floor(viewport * 0.7),
    `${name}:偏好寬度拉到極大時,面板在 [320, 視窗 70%] 內且聊天區 ≥ 352 px`,
    `width=${huge.width}, chat=${chat}, max=${huge.maxWidth}`,
  );
}
check(layoutFor(1280, SIDEBAR_EXPANDED, 5000).width === 1280 - 256 - 352, "1280 側欄展開:上限 = 可用寬度 − 352(= 672),不是視窗 70%(896)");
check(layoutFor(1024, SIDEBAR_EXPANDED, 5000).width === 1024 - 256 - 352, "1024 側欄展開:上限 = 可用寬度 − 352(= 416)");
check(layoutFor(1280, SIDEBAR_COLLAPSED, 5000).width === 1280 - 52 - 352, "1280 側欄收合:可用 − 352(= 876)仍比 70%(896)小,以它為上限");
check(layoutFor(2000, SIDEBAR_COLLAPSED, 5000).width === Math.floor(2000 * 0.7), "2000 側欄收合:70%(1400)比 可用 − 352(1596)小時以 70% 為上限");
check(layoutFor(900, SIDEBAR_EXPANDED).mode === "overlay", "900 側欄展開:連 352 + 320 都放不下 → 覆蓋層");
check(layoutFor(900, SIDEBAR_COLLAPSED).mode === "side", "900 側欄收合:放得下 → 並排");
check(
  layoutFor(928, SIDEBAR_EXPANDED).mode === "side" && layoutFor(928, SIDEBAR_EXPANDED).width === 320 && layoutFor(927, SIDEBAR_EXPANDED).mode === "overlay",
  "臨界:可用寬度剛好 = 352 + 320 = 672(視窗 928、側欄展開)→ 並排、面板 320;少 1 px(927)→ 覆蓋層",
);
check(layoutFor(639, SIDEBAR_COLLAPSED).mode === "overlay", "視窗在 sm(640)以下一律是覆蓋層");
check(layoutFor(1280, SIDEBAR_EXPANDED, 100).width === PANEL_MIN_WIDTH, "偏好寬度小於 320 時夾到 320");
check(layoutFor(1280, SIDEBAR_EXPANDED, 500).width === 500, "偏好寬度在範圍內時原樣使用");
check(layoutFor(1280, SIDEBAR_EXPANDED, Number.NaN).width === 480, "偏好寬度不是有限數字時退回預設寬度");
// 偏好恢復:空間變大時偏好寬度生效(偏好沒被縮小的版面改寫——函式是純的,同一個偏好在不同版面各算各的)。
check(
  layoutFor(1024, SIDEBAR_EXPANDED, 600).width === 416 && layoutFor(1024, SIDEBAR_COLLAPSED, 600).width === 600,
  "偏好 600:側欄展開(1024)被限制到 416,收合後空間變大 → 恢復 600",
);
// 字級縮放:22rem 跟著 root font-size 變(20px → 440 px)。
const bigFont = layoutFor(1280, SIDEBAR_EXPANDED, 5000, { rootFontPx: 20 });
check(bigFont.width === 1280 - 256 - 440, "字級 20px:聊天最小寬度 22rem = 440 px,面板上限跟著縮小", `width=${bigFont.width}`);
// 掃描:任何版面下 side 模式都滿足聊天區最小寬度,且 overlay 恰好是「放不下或 < sm」。
let scanOk = true;
let scanDetail = "";
for (let viewport = 300; viewport <= 2000 && scanOk; viewport += 7) {
  for (const sidebar of [SIDEBAR_EXPANDED, SIDEBAR_COLLAPSED]) {
    for (const rootFontPx of [14, 16, 18, 20]) {
      for (const preferred of [320, 480, 700, 5000]) {
        const layout = layoutFor(viewport, sidebar, preferred, { rootFontPx });
        const chat = viewport - sidebar - layout.width;
        const mustOverlay = viewport < 640 || Math.min(Math.floor(viewport * 0.7), Math.floor(viewport - sidebar - PANEL_CHAT_MIN_REM * rootFontPx)) < PANEL_MIN_WIDTH;
        const ok =
          mustOverlay === (layout.mode === "overlay") &&
          (layout.mode === "overlay" || (chat >= PANEL_CHAT_MIN_REM * rootFontPx && layout.width >= PANEL_MIN_WIDTH && layout.width <= layout.maxWidth));
        if (!ok) {
          scanOk = false;
          scanDetail = `viewport=${viewport} sidebar=${sidebar} font=${rootFontPx} preferred=${preferred} → ${JSON.stringify(layout)} chat=${chat}`;
        }
      }
    }
  }
}
check(scanOk, "掃描 300–2000 px 視窗 × 側欄展開/收合 × 字級 14–20 × 多個偏好寬度:side 一律滿足聊天最小寬度,overlay 恰好是放不下或 < sm", scanDetail);

console.log("\n== terminal-input:分段不拆 surrogate pair ==");
const roundTrip = (data, size) => splitTerminalInput(data, size).join("") === data;
const noLoneSurrogate = (chunks) =>
  chunks.every((chunk) => {
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) {
        const next = chunk.charCodeAt(i + 1);
        if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
        i += 1;
      } else if (c >= 0xdc00 && c <= 0xdfff) {
        return false;
      }
    }
    return true;
  });
check(splitTerminalInput("", 10).length === 0, "空字串 → 沒有片段");
check(JSON.stringify(splitTerminalInput("abcdef", 4)) === JSON.stringify(["abcd", "ef"]), "純 ASCII 照長度切");
check(JSON.stringify(splitTerminalInput("abc", 10)) === JSON.stringify(["abc"]), "短於上限不切");
{
  const text = "ab😀cd"; // 😀 = U+1F600,2 個 code unit(索引 2、3)
  const chunks = splitTerminalInput(text, 3); // 切點本來會落在 high(2) 與 low(3) 之間
  check(chunks.join("") === text && noLoneSurrogate(chunks) && chunks[0] === "ab", "切點落在 emoji 中間 → 往前挪一格,整個 emoji 留給下一段", JSON.stringify(chunks));
}
{
  const text = "𠮷".repeat(50) + "x"; // 罕見漢字(U+20BB7),每個 2 個 code unit
  let ok = true;
  for (const size of [2, 3, 4, 5, 7, 9, 10, 11, 101]) {
    const chunks = splitTerminalInput(text, size);
    ok &&= roundTrip(text, size) && noLoneSurrogate(chunks) && chunks.every((c) => c.length <= Math.max(2, size));
  }
  check(ok, "全是 surrogate pair 的內容,各種奇偶上限下:串回原文、沒有孤立 surrogate、片段長度不超過上限(上限 < 2 時以 2 計)");
}
{
  // 隨機混合:ASCII、CJK、emoji,隨機上限。
  let seed = 12345;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const alphabet = ["a", "Z", " ", "\r", "中", "文", "😀", "👨‍👩‍👧", "𠮷", "é"];
  let ok = true;
  let detail = "";
  for (let round = 0; round < 300 && ok; round++) {
    let text = "";
    const length = Math.floor(rand() * 200);
    for (let i = 0; i < length; i++) text += alphabet[Math.floor(rand() * alphabet.length)];
    const size = 2 + Math.floor(rand() * 30);
    const chunks = splitTerminalInput(text, size);
    if (!(roundTrip(text, size) && noLoneSurrogate(chunks) && chunks.every((c) => c.length <= size))) {
      ok = false;
      detail = `size=${size} text=${JSON.stringify(text)} chunks=${JSON.stringify(chunks)}`;
    }
  }
  check(ok, "隨機混合(ASCII/CJK/emoji/ZWJ 序列)300 輪:串回原文、沒有孤立 surrogate、不超過上限", detail);
}
{
  const big = "😀".repeat(70_000); // 140,000 code unit,模擬大段貼上
  const chunks = splitTerminalInput(big, 60_000);
  check(chunks.length === 3 && chunks.every((c) => c.length <= 60_000) && noLoneSurrogate(chunks) && chunks.join("") === big, "14 萬 code unit 的貼上以 60,000 為上限 → 3 段、每段完整", `lengths=${chunks.map((c) => c.length)}`);
}

console.log("\n== file-preview / git-status:Files 預覽與 Changes 徽章的小工具 ==");
{
  const { languageForPath, formatBytes, joinRelPath } = await import(pathToFileURL(path.join(LIB, "file-preview.ts")).href);
  const { gitStatusBadge, gitStatusCode } = await import(pathToFileURL(path.join(LIB, "git-status.ts")).href);
  check(
    languageForPath("src/App.tsx") === "tsx" && languageForPath("a/b/c.TS") === "typescript" && languageForPath("x.json") === "json" && languageForPath("run.sh") === "bash",
    "languageForPath:依副檔名(不分大小寫、含路徑)挑出 CodeBlock 已註冊的語言",
  );
  check(
    languageForPath("Makefile") === "text" && languageForPath(".gitignore") === "text" && languageForPath("a.unknownext") === "text" && languageForPath("dir.d/file") === "text",
    "languageForPath:沒有副檔名、只有開頭的點、不認得的副檔名、副檔名在資料夾名上 → text",
  );
  check(
    formatBytes(0) === "0 B" && formatBytes(1023) === "1023 B" && formatBytes(1536) === "1.5 KB" && formatBytes(5 * 1024 * 1024) === "5.0 MB" && formatBytes(-1) === "?",
    "formatBytes:位元組/KB/MB 與非法值",
  );
  check(joinRelPath("", "a") === "a" && joinRelPath("sub", "d.txt") === "sub/d.txt" && joinRelPath("a/b", "c") === "a/b/c", "joinRelPath:根目錄不加前綴、其餘以 / 連接");
  const badge = (x, y) => gitStatusBadge(x, y).letter;
  check(
    badge(" ", "M") === "M" && badge("M", " ") === "M" && badge("M", "M") === "M" && badge("A", " ") === "A" && badge(" ", "D") === "D" && badge("R", "M") === "M" && badge("R", " ") === "R" && badge("?", "?") === "?",
    "gitStatusBadge:工作樹有變就看工作樹、否則看已暫存的;未追蹤是 ?",
  );
  check(badge("U", "U") === "U" && badge("A", "A") === "U" && badge("D", "D") === "U" && badge(" ", "U") === "U", "gitStatusBadge:任何一種衝突組合 → U");
  check(gitStatusBadge("?", "?").tone === "ok" && gitStatusBadge(" ", "D").tone === "danger" && gitStatusBadge("U", "U").tone === "warn", "gitStatusBadge:語意色(新增/未追蹤 ok、刪除 danger、衝突 warn)");
  check(gitStatusCode(" ", "M") === "·M" && gitStatusCode("M", "M") === "MM", "gitStatusCode:空白以中點呈現");
}

console.log("\n== browser-rules:Browser 分頁的網址/scheme/partition/組合鍵判斷(main 與 renderer 共用同一份)==");
{
  const ELECTRON_DIR = path.resolve(__dirname, "..", "apps", "desktop", "electron");
  const {
    normalizeAddressInput,
    isAllowedWebviewUrl,
    isAllowedNavigationUrl,
    isExternallyOpenableUrl,
    isAllowedBrowserPartition,
    browserPartitionForSession,
    matchAppShortcut,
    popupRedirectUrl,
    enforceWebviewAttachPolicy,
  } = await import(pathToFileURL(path.join(ELECTRON_DIR, "browser-rules.ts")).href);

  const resolve = (input) => normalizeAddressInput(input);
  const urlOf = (input) => {
    const r = resolve(input);
    return r.kind === "url" ? r.url : `<${r.kind}${r.reason ? `:${r.reason}` : ""}>`;
  };
  const cases = [
    // host:port、IP、IPv6、一般網域:補 http/https 的規則
    ["localhost:5173", "http://localhost:5173/"],
    ["localhost", "http://localhost/"],
    ["localhost:5173/app?x=1#top", "http://localhost:5173/app?x=1#top"],
    ["foo.localhost:3000", "http://foo.localhost:3000/"],
    ["127.0.0.1", "http://127.0.0.1/"],
    ["127.0.0.1:3000/a?b=1", "http://127.0.0.1:3000/a?b=1"],
    ["[::1]:3000", "http://[::1]:3000/"],
    ["[::1]", "http://[::1]/"],
    ["example.com", "https://example.com/"],
    ["example.com/path?q=1#h", "https://example.com/path?q=1#h"],
    ["example.com:8080", "http://example.com:8080/"],
    ["my-host:3000/x", "http://my-host:3000/x"],
    ["user@localhost:3000", "http://user@localhost:3000/"],
    ["//example.com/x", "https://example.com/x"],
    ["//localhost:3000", "http://localhost:3000/"],
    // 已有 scheme、大小寫、前後空白
    ["https://example.com", "https://example.com/"],
    ["  https://example.com/a  ", "https://example.com/a"],
    ["HTTPS://EXAMPLE.COM/Path", "https://example.com/Path"],
    ["http://localhost:5173/app", "http://localhost:5173/app"],
    ["about:blank", "about:blank"],
    // 空、不像網址(含空白:第一版沒有搜尋引擎)
    ["", "<empty>"],
    ["   ", "<empty>"],
    ["hello world", "<invalid:notUrl>"],
    ["what is love", "<invalid:notUrl>"],
    ["example.com/a b", "<invalid:notUrl>"],
    ["http://", "<invalid:notUrl>"],
    ["x".repeat(9000), "<invalid:notUrl>"],
    ["java\nscript:alert(1)", "<invalid:notUrl>"],
    // 不支援的 scheme
    ["javascript:alert(1)", "<invalid:unsupportedScheme>"],
    ["JavaScript:alert(1)", "<invalid:unsupportedScheme>"],
    ["file:///etc/passwd", "<invalid:unsupportedScheme>"],
    ["FILE:///C:/Windows/win.ini", "<invalid:unsupportedScheme>"],
    ["chrome://gpu", "<invalid:unsupportedScheme>"],
    ["devtools://devtools/bundled/inspector.html", "<invalid:unsupportedScheme>"],
    ["mailto:a@b.c", "<invalid:unsupportedScheme>"],
    ["data:text/html,<b>x</b>", "<invalid:unsupportedScheme>"],
    ["view-source:http://example.com", "<invalid:unsupportedScheme>"],
    ["ftp://example.com/x", "<invalid:unsupportedScheme>"],
    ["about:config", "<invalid:unsupportedScheme>"],
    ["blob:http://example.com/abc", "<invalid:unsupportedScheme>"],
  ];
  const failures = cases.filter(([input, expected]) => urlOf(input) !== expected).map(([input, expected]) => `${JSON.stringify(input.length > 40 ? input.slice(0, 40) + "…" : input)} → ${urlOf(input)}(預期 ${expected})`);
  check(failures.length === 0, `normalizeAddressInput:${cases.length} 種輸入(host:port/IP/IPv6/網域/已有 scheme/空白/含空格/不支援的 scheme)全部符合預期`, failures.join("\n       "));

  const allowed = [
    "https://example.com",
    "http://localhost:3000/x?y=1#z",
    "HTTP://EXAMPLE.COM",
    "  https://example.com  ",
    "\thttp://127.0.0.1:8080\n",
    "http://[::1]:3000/",
    "https:///example.com", // WHATWG:特殊 scheme 忽略多餘的斜線,Chromium 同樣解成 https://example.com/
    "about:blank",
  ];
  const denied = [
    "file:///etc/passwd",
    "\tFILE:///x",
    "chrome://gpu",
    "devtools://devtools/bundled/inspector.html",
    "javascript:alert(1)",
    " JAVASCRIPT:alert(1) ",
    "java\nscript:alert(1)",
    "\u0001javascript:alert(1)",
    "data:text/html,x",
    "blob:http://example.com/abc",
    "view-source:http://example.com",
    "about:srcdoc",
    "about:blank#x",
    "about:blank?x",
    "ABOUT:BLANK", // 解析後是 about:BLANK,不是剛好 about:blank:保守地拒絕
    "ftp://example.com",
    "ws://example.com",
    "http://",
    "https://",
    "",
    "x".repeat(9000),
    undefined,
    null,
    5,
    {},
  ];
  const allowedWrong = allowed.filter((u) => !isAllowedWebviewUrl(u));
  const deniedWrong = denied.filter((u) => isAllowedWebviewUrl(u));
  check(
    allowedWrong.length === 0 && deniedWrong.length === 0,
    `isAllowedWebviewUrl:${allowed.length} 個允許(含大小寫、前後空白、tab/換行變體)與 ${denied.length} 個拒絕(file/chrome/devtools/javascript/data/blob/view-source/about 其他路徑/ftp/ws/空/超長/非字串,含大小寫與控制字元變體)全部符合`,
    `該放行卻被拒:${JSON.stringify(allowedWrong)};該拒絕卻放行:${JSON.stringify(deniedWrong)}`,
  );
  check(
    isAllowedNavigationUrl("https://example.com/x", true) === true &&
      isAllowedNavigationUrl("about:blank", true) === true &&
      isAllowedNavigationUrl("data:text/html,x", true) === false &&
      isAllowedNavigationUrl("blob:http://example.com/abc", true) === false &&
      isAllowedNavigationUrl("about:srcdoc", true) === false &&
      isAllowedNavigationUrl("data:text/html,x", false) === true &&
      isAllowedNavigationUrl("blob:http://example.com/abc", false) === true &&
      isAllowedNavigationUrl("about:srcdoc", false) === true &&
      ["file:///etc/passwd", "chrome://gpu", "devtools://devtools/x", "javascript:alert(1)", " JAVASCRIPT:alert(1)", "view-source:http://x", "ftp://x", ""].every(
        (u) => isAllowedNavigationUrl(u, true) === false && isAllowedNavigationUrl(u, false) === false,
      ),
    "isAllowedNavigationUrl:主框架嚴格(只有 http(s)/about:blank);子框架另外放行 srcdoc/blob/data;file/chrome/devtools/javascript/view-source/ftp 在任何框架都不放行",
  );
  check(
    isExternallyOpenableUrl("https://example.com") === true &&
      isExternallyOpenableUrl("http://localhost:3000") === true &&
      isExternallyOpenableUrl("about:blank") === false &&
      isExternallyOpenableUrl("file:///x") === false &&
      isExternallyOpenableUrl("javascript:alert(1)") === false &&
      isExternallyOpenableUrl(undefined) === false,
    "isExternallyOpenableUrl:只有 http(s) 能交給外部瀏覽器(about:blank、file、javascript、非字串都不行)",
  );

  const uuid = "6f1c8f0e-2b7d-4c1a-9a1e-0d9a7b2f3c4d";
  const goodPartitions = [`deskmony-browser-${uuid}`, "deskmony-browser-abc_DEF-123", "deskmony-browser-x"];
  const badPartitions = [
    `persist:deskmony-browser-${uuid}`,
    "deskmony-browser-",
    "deskmony-browser-a b",
    "deskmony-browser-../x",
    "deskmony-browser-a/b",
    "deskmony-browser-a\n",
    "Deskmony-browser-x",
    "deskmony-browser",
    "other-partition",
    "",
    `deskmony-browser-${"a".repeat(200)}`,
    undefined,
    null,
    5,
  ];
  check(
    goodPartitions.every(isAllowedBrowserPartition) && badPartitions.every((p) => !isAllowedBrowserPartition(p)),
    "isAllowedBrowserPartition:deskmony-browser-<id>(UUID/底線/連字號)合法;persist: 前綴、空 id、空白、斜線、結尾換行、大小寫不符、超長、非字串全部拒絕",
    `bad 卻通過:${JSON.stringify(badPartitions.filter(isAllowedBrowserPartition))}`,
  );
  check(
    browserPartitionForSession(uuid) === `deskmony-browser-${uuid}` &&
      browserPartitionForSession("a/b") === undefined &&
      browserPartitionForSession("a b") === undefined &&
      browserPartitionForSession("persist:x") === undefined &&
      browserPartitionForSession("") === undefined &&
      browserPartitionForSession(5) === undefined &&
      browserPartitionForSession("a:b") === undefined,
    "browserPartitionForSession:UUID 的 session id 對應合法 partition(不帶 persist:);不合法的 id 回 undefined(不「清理」成別的名稱)",
  );

  const key = (type, k, mods = {}) => ({ type, key: k, control: false, meta: false, shift: false, alt: false, ...mods });
  check(
    matchAppShortcut(key("keyDown", "j", { control: true }), false) === "toggle-panel" &&
      matchAppShortcut(key("keyDown", "J", { control: true }), false) === "toggle-panel" &&
      matchAppShortcut(key("keyDown", "k", { control: true }), false) === "open-palette" &&
      matchAppShortcut(key("keyDown", "`", { control: true }), false) === "open-terminal" &&
      matchAppShortcut(key("keyDown", "j", { meta: true }), true) === "toggle-panel" &&
      matchAppShortcut(key("keyDown", "k", { meta: true }), true) === "open-palette" &&
      matchAppShortcut(key("keyDown", "`", { control: true }), true) === "open-terminal",
    "matchAppShortcut:只認 mod+j(開關面板)、mod+k(命令面板)、ctrl+`(開 Terminal);mod 在 Windows/Linux 是 Ctrl、在 macOS 是 ⌘,ctrl+` 是字面 Ctrl",
  );
  check(
    matchAppShortcut(key("keyUp", "j", { control: true }), false) === undefined &&
      matchAppShortcut(key("keyDown", "j"), false) === undefined &&
      matchAppShortcut(key("keyDown", "j", { control: true, shift: true }), false) === undefined &&
      matchAppShortcut(key("keyDown", "j", { control: true, alt: true }), false) === undefined &&
      matchAppShortcut(key("keyDown", "j", { meta: true }), false) === undefined &&
      matchAppShortcut(key("keyDown", "j", { control: true }), true) === undefined &&
      matchAppShortcut(key("keyDown", "`", { meta: true }), true) === undefined &&
      matchAppShortcut(key("keyDown", "`", { control: true, meta: true }), true) === undefined &&
      matchAppShortcut(key("keyDown", "a", { control: true }), false) === undefined &&
      matchAppShortcut(key("keyDown", "c", { control: true }), false) === undefined &&
      matchAppShortcut(key("keyDown", "Enter"), false) === undefined,
    "matchAppShortcut:keyUp、沒按修飾鍵、多按 shift/alt、平台不對的修飾鍵(Windows 的 ⌘、mac 的 Ctrl+j)、⌘+`、其他鍵(Ctrl+A/C、Enter)一律不攔,照常給網頁",
  );

  // ---- 彈出視窗(window.open / target=_blank):handler 永遠 deny,只有 http(s) 改在同一個 webview 導過去 ----
  check(
    popupRedirectUrl("https://example.com/a?b=1") === "https://example.com/a?b=1" &&
      popupRedirectUrl("http://localhost:3000/popup") === "http://localhost:3000/popup" &&
      popupRedirectUrl("about:blank") === undefined &&
      popupRedirectUrl("file:///C:/Windows/win.ini") === undefined &&
      popupRedirectUrl("javascript:alert(1)") === undefined &&
      popupRedirectUrl("data:text/html,<p>x</p>") === undefined &&
      popupRedirectUrl("blob:http://localhost/abc") === undefined &&
      popupRedirectUrl("chrome://gpu") === undefined &&
      popupRedirectUrl("") === undefined &&
      popupRedirectUrl(undefined) === undefined,
    "popupRedirectUrl:只有 http(s) 會改在同一個 webview 開;about:blank(window.open() 不帶網址)、file、javascript、data、blob、chrome、空字串、非字串都什麼都不做",
  );

  // ---- will-attach-webview 政策:強制 allowpopups、強制最嚴格的 webPreferences、拿掉放寬隔離的屬性、不合法就取消 ----
  const goodParams = () => ({ partition: `deskmony-browser-${uuid}`, src: "about:blank" });
  {
    const prefs = {
      preload: "C:/evil/preload.js",
      preloadURL: "file:///C:/evil/preload.js",
      nodeIntegration: true,
      nodeIntegrationInSubFrames: true,
      nodeIntegrationInWorker: true,
      contextIsolation: false,
      sandbox: false,
      webSecurity: false,
      allowRunningInsecureContent: true,
      webviewTag: true,
      experimentalFeatures: true,
      zoomFactor: 1.5,
    };
    const params = { ...goodParams(), preload: "x", disablewebsecurity: "", nodeintegration: "true", nodeintegrationinsubframes: "true", webpreferences: "sandbox=no", plugins: "true", allowpopups: "false" };
    const ok = enforceWebviewAttachPolicy(prefs, params);
    check(
      ok === true &&
        !("preload" in prefs) &&
        !("preloadURL" in prefs) &&
        prefs.nodeIntegration === false &&
        prefs.nodeIntegrationInSubFrames === false &&
        prefs.nodeIntegrationInWorker === false &&
        prefs.contextIsolation === true &&
        prefs.sandbox === true &&
        prefs.webSecurity === true &&
        prefs.allowRunningInsecureContent === false &&
        prefs.webviewTag === false &&
        prefs.experimentalFeatures === false &&
        prefs.zoomFactor === 1.5,
      "enforceWebviewAttachPolicy:guest 的 webPreferences 一律強制成最嚴格的值(無 preload、無 nodeIntegration、contextIsolation/sandbox/webSecurity 開、不能再嵌 webview),不相干的設定不碰",
      JSON.stringify(prefs),
    );
    check(
      !("preload" in params) &&
        !("disablewebsecurity" in params) &&
        !("nodeintegration" in params) &&
        !("nodeintegrationinsubframes" in params) &&
        !("webpreferences" in params) &&
        !("plugins" in params) &&
        params.partition === `deskmony-browser-${uuid}` &&
        params.src === "about:blank",
      "enforceWebviewAttachPolicy:會放寬隔離的 <webview> 屬性(preload、disablewebsecurity、nodeintegration…、webpreferences、plugins)一律拿掉;partition/src 不動",
      JSON.stringify(params),
    );
    check(params.allowpopups === "true", "enforceWebviewAttachPolicy:renderer 傳 allowpopups=\"false\" 也被強制改成 \"true\"(不信任 renderer)", JSON.stringify(params));
  }
  {
    const params = goodParams();
    enforceWebviewAttachPolicy({}, params);
    check(params.allowpopups === "true", "enforceWebviewAttachPolicy:renderer 完全沒傳 allowpopups 時由政策補上 \"true\"(沒有它,target=_blank 在 guest 端就被吞掉)", JSON.stringify(params));
  }
  {
    const badParamSets = [
      { partition: `persist:deskmony-browser-${uuid}`, src: "about:blank" },
      { partition: "other-partition", src: "about:blank" },
      { partition: undefined, src: "about:blank" },
      { partition: `deskmony-browser-${uuid}`, src: "file:///etc/passwd" },
      { partition: `deskmony-browser-${uuid}`, src: "javascript:alert(1)" },
      { partition: `deskmony-browser-${uuid}`, src: undefined },
      { partition: `deskmony-browser-${uuid}`, src: "data:text/html,x" },
    ];
    const results = badParamSets.map((params) => {
      const prefs = { sandbox: false };
      const result = enforceWebviewAttachPolicy(prefs, params);
      return { result, untouched: prefs.sandbox === false && !("allowpopups" in params) };
    });
    check(
      results.every((r) => r.result === false && r.untouched),
      "enforceWebviewAttachPolicy:partition 不合法(persist:、別的名稱、缺)或 src 不是 http(s)/about:blank(file、javascript、data、缺)→ 回 false 取消 attach,而且不動傳入的物件",
      JSON.stringify(results),
    );
    check(
      enforceWebviewAttachPolicy({}, { partition: `deskmony-browser-${uuid}`, src: "https://example.com/" }) === true &&
        enforceWebviewAttachPolicy({}, { partition: `deskmony-browser-${uuid}`, src: "http://localhost:3000/" }) === true,
      "enforceWebviewAttachPolicy:src 是 http(s) 也放行",
    );
  }
}

console.log("\n== browser-frame-style:webview 外框的可見/停放樣式(P4 對看不到的 session 截圖要靠它)==");
{
  const {
    browserFrameStyle,
    BROWSER_Z_INDEX,
    BROWSER_PARKED_Z_INDEX,
    BROWSER_PARKED_WIDTH,
    BROWSER_PARKED_HEIGHT,
  } = await import(pathToFileURL(path.join(LIB, "browser-frame-style.ts")).href);

  const parked = browserFrameStyle(undefined, false);
  check(
    parked.position === "fixed" &&
      parked.left === 0 &&
      parked.top === 0 &&
      parked.width === 1024 &&
      parked.height === 768 &&
      parked.opacity === 0 &&
      parked.zIndex === -1 &&
      parked.pointerEvents === "none",
    "停放:position fixed、left 0/top 0、1024×768、opacity 0、z-index -1、pointer-events none(P3.3 實驗:這種停法 CDP 截圖可用)",
    JSON.stringify(parked),
  );
  check(
    parked.left >= 0 && parked.top >= 0 && parked.left + parked.width > 0 && parked.top + parked.height > 0,
    "停放的外框留在視口內(left/top 不是負的)——停在畫面外(left:-20000)時 CDP 截圖會逾時",
  );
  check(
    !("visibility" in parked) && !("display" in parked) && browserFrameStyle(undefined, true).pointerEvents === "none" && JSON.stringify(browserFrameStyle(undefined, true)) === JSON.stringify(parked),
    "停放不用 visibility: hidden / display: none(兩者都會讓 webview 不再被繪製);拖拉鎖(pointerLock)不影響停放樣式",
  );
  check(
    BROWSER_PARKED_Z_INDEX === -1 && BROWSER_PARKED_WIDTH === 1024 && BROWSER_PARKED_HEIGHT === 768,
    "停放常數:z-index -1、1024×768",
  );

  const rect = { x: 609, y: 99, width: 415, height: 669 };
  const visible = browserFrameStyle(rect, false);
  check(
    visible.position === "fixed" &&
      visible.left === 609 &&
      visible.top === 99 &&
      visible.width === 415 &&
      visible.height === 669 &&
      visible.zIndex === 45 &&
      visible.opacity === 1 &&
      visible.pointerEvents === "auto",
    "可見:疊在 slot 的位置與大小上、z-index 45、不透明、吃滑鼠",
    JSON.stringify(visible),
  );
  check(BROWSER_Z_INDEX === 45 && BROWSER_Z_INDEX > 40 && BROWSER_Z_INDEX < 50, "可見的 z-index 在面板(z-40)之上、所有對話框(z-50 起)之下");
  check(browserFrameStyle(rect, true).pointerEvents === "none" && browserFrameStyle(rect, true).zIndex === 45, "拖拉面板寬度中(pointerLock):可見的外框暫時不吃滑鼠,位置與 z-index 不變");
}

console.log("\n== browser-exec:agent 瀏覽器指令在桌面端的執行(假 driver;真 Electron 才能驗的只剩 browser-executor.ts 的膠水)==");
{
  const ELECTRON_DIR = path.resolve(__dirname, "..", "apps", "desktop", "electron");
  const exec = await import(pathToFileURL(path.join(ELECTRON_DIR, "browser-exec.ts")).href);
  const {
    KEY_TABLE,
    keyEventsFor,
    fitWithin,
    imageToCss,
    isScreenshotStale,
    executeBrowserOp,
    createGuestState,
    mapExecError,
    BrowserExecError,
    buildReadTextScript,
    buildInteractiveScript,
    buildResolveRefScript,
    buildReadTextResult,
    buildInteractiveResult,
    interpretResolveResult,
    dropTrailingHighSurrogate,
    VIEWPORT_SCRIPT,
    EDITABLE_FOCUS_SCRIPT,
  } = exec;

  // ---- 按鍵對照表 ----
  const EXPECTED_KEYS = ["Enter", "Tab", "Escape", "Backspace", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End", "Space"];
  const EXPECTED_VK = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, PageUp: 33, PageDown: 34, Home: 36, End: 35, Space: 32 };
  check(
    JSON.stringify(Object.keys(KEY_TABLE).sort()) === JSON.stringify([...EXPECTED_KEYS].sort()) &&
      EXPECTED_KEYS.every((name) => {
        const [down, up] = keyEventsFor(name);
        return (
          keyEventsFor(name).length === 2 &&
          down.windowsVirtualKeyCode === EXPECTED_VK[name] &&
          down.nativeVirtualKeyCode === EXPECTED_VK[name] &&
          up.type === "keyUp" &&
          up.windowsVirtualKeyCode === EXPECTED_VK[name] &&
          up.key === down.key &&
          up.code === down.code &&
          up.text === undefined
        );
      }),
    "按鍵對照表:十四個鍵(Enter/Tab/Escape/Backspace/Delete/四個方向鍵/PageUp/PageDown/Home/End/Space),每個都是一次按下 + 一次放開、windowsVirtualKeyCode 正確(Enter=13、Tab=9、Esc=27、方向鍵 37-40…)",
  );
  const enter = keyEventsFor("Enter");
  const space = keyEventsFor("Space");
  const tab = keyEventsFor("Tab");
  check(
    enter[0].type === "keyDown" &&
      enter[0].text === "\r" &&
      enter[0].key === "Enter" &&
      space[0].type === "keyDown" &&
      space[0].text === " " &&
      space[0].key === " " &&
      space[0].code === "Space" &&
      tab[0].type === "rawKeyDown" &&
      tab[0].text === undefined,
    "會產生字元的鍵(Enter、Space)用 keyDown + text(Enter 是 \\r、Space 的 key 是空白、code 是 Space),其餘用 rawKeyDown 不帶 text",
  );
  let badKey;
  try {
    keyEventsFor("Control+C");
  } catch (err) {
    badKey = err;
  }
  check(badKey instanceof BrowserExecError && badKey.code === "browser.hostError", "不認得的鍵名(組合鍵、任意字元)丟 browser.hostError");

  // ---- 截圖縮放與座標換算 ----
  const f1 = fitWithin(2048, 1536, 1568);
  const f2 = fitWithin(830, 1338, 1568);
  const f3 = fitWithin(1568, 100, 1568);
  const f4 = fitWithin(1569, 1, 1568);
  check(
    f1.scaled && f1.width === 1568 && f1.height === 1176 && !f2.scaled && f2.width === 830 && f2.height === 1338 && !f3.scaled && f4.scaled && f4.width === 1568 && f4.height === 1,
    "fitWithin:長邊超過 1568 等比縮小(2048×1536 → 1568×1176;極端比例至少 1px),剛好 1568 與更小的不動",
    JSON.stringify([f1, f2, f3, f4]),
  );
  const rec = { cssWidth: 415, cssHeight: 669, width: 830, height: 1338 };
  const p1 = imageToCss(rec, 100, 200);
  const p2 = imageToCss({ cssWidth: 1024, cssHeight: 768, width: 1568, height: 1176 }, 784, 588);
  const outOfRange = [
    [830, 0],
    [0, 1338],
    [-1, 5],
  ].map(([x, y]) => {
    try {
      imageToCss(rec, x, y);
      return false;
    } catch (err) {
      return err instanceof BrowserExecError && err.code === "browser.hostError" && /超出/.test(err.message);
    }
  });
  check(
    p1.x === 50 && p1.y === 100 && Math.abs(p2.x - 512) < 1e-9 && Math.abs(p2.y - 384) < 1e-9 && outOfRange.every(Boolean),
    "imageToCss:截圖像素座標 → CSS px(DPR 2 的 830×1338 圖 ↔ 415×669 viewport:(100,200) → (50,100);縮到 1568 的圖 ↔ 1024×768:中心對中心);超出圖範圍的座標丟錯",
    JSON.stringify({ p1, p2, outOfRange }),
  );
  check(
    !isScreenshotStale(rec, { cssWidth: 415, cssHeight: 669 }) &&
      !isScreenshotStale(rec, { cssWidth: 416, cssHeight: 668 }) &&
      isScreenshotStale(rec, { cssWidth: 417, cssHeight: 669 }) &&
      isScreenshotStale(rec, { cssWidth: 415, cssHeight: 771 }) &&
      isScreenshotStale(rec, { cssWidth: 1024, cssHeight: 768 }) &&
      isScreenshotStale(rec, { cssWidth: 669, cssHeight: 415 }),
    "isScreenshotStale:viewport 尺寸差 ≤ 1px 不算變(四捨五入);差 2px 以上、停放的 1024×768、寬高對調都算「尺寸變了」",
  );

  // ---- 假 driver ----
  const BASE_VIEWPORT = { cssWidth: 415, cssHeight: 669 };
  function makeDriver(opts = {}) {
    const calls = { cdp: [], eval: [], load: [], history: [], resize: [], waits: [], stops: [], cancelled: 0, sleeps: [] };
    const driver = {
      cdp: async (method, params) => {
        calls.cdp.push([method, params]);
        if (opts.cdp) return opts.cdp(method, params);
        if (method === "Page.captureScreenshot") return { data: "JPEGDATA" };
        return {};
      },
      evalIsolated: async (code) => {
        calls.eval.push(code);
        if (code === VIEWPORT_SCRIPT) return typeof opts.viewport === "function" ? opts.viewport() : (opts.viewport ?? BASE_VIEWPORT);
        if (code === EDITABLE_FOCUS_SCRIPT) return typeof opts.editable === "function" ? opts.editable() : (opts.editable ?? true);
        if (code.startsWith("((ref, focus)")) return typeof opts.resolve === "function" ? opts.resolve(code) : (opts.resolve ?? { x: 120, y: 340, focused: true });
        if (code.includes("const NAME_MAX")) return opts.interactive ?? { url: "http://localhost/", title: "T", elements: [], truncated: false };
        if (code.includes("const max =")) return opts.text ?? { url: "http://localhost/", title: "T", text: "hello", truncated: false };
        throw new Error("未預期的腳本: " + code.slice(0, 40));
      },
      getUrl: () => opts.url ?? "http://localhost/after",
      getTitle: () => opts.title ?? "After",
      isLoading: () => opts.loading ?? false,
      isUrlAllowed: (u) => /^https?:\/\//i.test(u),
      loadUrl: async (u) => {
        calls.load.push(u);
      },
      goHistory: (a) => {
        calls.history.push(a);
        return opts.history !== false;
      },
      waitForLoad: (ms) => {
        calls.waits.push(ms);
        return {
          promise: Promise.resolve(opts.loadOutcome ?? { finished: true }),
          cancel: () => {
            calls.cancelled += 1;
          },
        };
      },
      waitForLoadStop: async (ms) => {
        calls.stops.push(ms);
      },
      jpegSize: () => opts.jpegSize ?? { width: 830, height: 1338 },
      resizeJpeg: (...a) => {
        calls.resize.push(a);
        return "RESIZEDJPEG";
      },
      sleep: async (ms) => {
        calls.sleeps.push(ms);
      },
    };
    return { driver, calls, state: createGuestState() };
  }
  const run = (h, op, args) => executeBrowserOp(h.driver, h.state, op, args);
  const mouseEvents = (calls) => calls.cdp.filter(([m]) => m === "Input.dispatchMouseEvent").map(([, p]) => p);

  // ---- screenshot ----
  {
    const h = makeDriver({ jpegSize: { width: 830, height: 1338 } });
    const out = await run(h, "screenshot", {});
    const capture = h.calls.cdp.find(([m]) => m === "Page.captureScreenshot");
    check(
      out.ok &&
        out.result.mimeType === "image/jpeg" &&
        out.result.data === "JPEGDATA" &&
        out.result.width === 830 &&
        out.result.height === 1338 &&
        out.result.url === "http://localhost/after" &&
        out.result.title === "After" &&
        h.calls.resize.length === 0 &&
        capture[1].format === "jpeg" &&
        capture[1].quality === 65 &&
        JSON.stringify(h.state.screenshot) === JSON.stringify({ cssWidth: 415, cssHeight: 669, width: 830, height: 1338 }),
      "screenshot:JPEG 品質 65;長邊沒超過 1568 時不重新編碼;width/height 是截圖本身的像素;記住截圖當下的 viewport(CSS px)與圖的像素尺寸",
      JSON.stringify(out),
    );
    const big = makeDriver({ jpegSize: { width: 2048, height: 1536 }, viewport: { cssWidth: 1024, cssHeight: 768 } });
    const bigOut = await run(big, "screenshot", {});
    check(
      bigOut.ok &&
        bigOut.result.width === 1568 &&
        bigOut.result.height === 1176 &&
        bigOut.result.data === "RESIZEDJPEG" &&
        big.calls.resize.length === 1 &&
        big.calls.resize[0][1] === 1568 &&
        big.calls.resize[0][2] === 1176 &&
        big.calls.resize[0][3] === 65 &&
        JSON.stringify(big.state.screenshot) === JSON.stringify({ cssWidth: 1024, cssHeight: 768, width: 1568, height: 1176 }),
      "screenshot:長邊超過 1568(DPR 2 的 1024×768 = 2048×1536)→ 縮到 1568×1176 並以品質 65 重新編碼;紀錄的是縮過的圖尺寸",
      JSON.stringify(bigOut.ok ? { w: bigOut.result.width, h: bigOut.result.height } : bigOut),
    );
    const bad = [
      await run(makeDriver({ cdp: async () => ({}) }), "screenshot", {}),
      await run(makeDriver({ jpegSize: { width: 0, height: 0 } }), "screenshot", {}),
      await run(makeDriver({ viewport: { cssWidth: 0, cssHeight: 0 } }), "screenshot", {}),
    ];
    check(bad.every((o) => !o.ok && o.error.code === "browser.hostError"), "screenshot:CDP 沒回影像、影像尺寸是 0、viewport 是 0 → browser.hostError(不回壞的結果)");
  }

  // ---- click:x/y 與 ref ----
  {
    const none = makeDriver();
    const noShot = await run(none, "click", { x: 10, y: 10 });
    check(
      !noShot.ok && noShot.error.code === "browser.noScreenshot" && mouseEvents(none.calls).length === 0,
      "click x/y:還沒截過圖 → browser.noScreenshot,什麼都沒點",
    );

    const h = makeDriver({ jpegSize: { width: 830, height: 1338 } });
    await run(h, "screenshot", {});
    const clicked = await run(h, "click", { x: 100, y: 200 });
    const ev = mouseEvents(h.calls);
    check(
      clicked.ok &&
        clicked.result.url === "http://localhost/after" &&
        clicked.result.title === "After" &&
        ev.length === 3 &&
        ev[0].type === "mouseMoved" &&
        ev[0].x === 50 &&
        ev[0].y === 100 &&
        ev[1].type === "mousePressed" &&
        ev[1].button === "left" &&
        ev[1].buttons === 1 &&
        ev[1].clickCount === 1 &&
        ev[1].x === 50 &&
        ev[2].type === "mouseReleased" &&
        ev[2].buttons === 0 &&
        ev[2].clickCount === 1 &&
        ev[2].y === 100,
      "click x/y:截圖像素 (100,200) 依比例換算成 CSS (50,100),CDP 送 mouseMoved → mousePressed(left, buttons 1, clickCount 1)→ mouseReleased;回傳點擊後的 url/title",
      JSON.stringify(ev),
    );

    // 截圖之後 viewport 尺寸變了(面板開關,停放的 1024×768)→ staleScreenshot,而且沒有點下去
    const stale = makeDriver({ jpegSize: { width: 830, height: 1338 } });
    await run(stale, "screenshot", {});
    const flipped = makeDriver({ viewport: { cssWidth: 1024, cssHeight: 768 } });
    flipped.state.screenshot = stale.state.screenshot; // 同一個 guest 的狀態,只是之後 viewport 換了
    const staleOut = await run(flipped, "click", { x: 100, y: 200 });
    check(
      !staleOut.ok &&
        staleOut.error.code === "browser.staleScreenshot" &&
        /415×669/.test(staleOut.error.message) &&
        /1024×768/.test(staleOut.error.message) &&
        mouseEvents(flipped.calls).length === 0,
      "click x/y:截圖之後 viewport 尺寸變了(415×669 → 停放的 1024×768)→ browser.staleScreenshot,訊息講明前後尺寸,沒有點下去",
      JSON.stringify(staleOut),
    );

    // 超出圖範圍
    const oor = await run(h, "click", { x: 830, y: 5 });
    check(!oor.ok && oor.error.code === "browser.hostError" && mouseEvents(h.calls).length === 3, "click x/y:座標超出截圖範圍 → browser.hostError,沒有多送滑鼠事件");

    // ref
    const r = makeDriver({ resolve: { x: 120.5, y: 340.25 } });
    const byRef = await run(r, "click", { ref: "e3" });
    const rev = mouseEvents(r.calls);
    const resolveScript = r.calls.eval.find((c) => c.startsWith("((ref, focus)"));
    check(
      byRef.ok &&
        rev.length === 3 &&
        rev[0].x === 120.5 &&
        rev[0].y === 340.25 &&
        rev[1].type === "mousePressed" &&
        resolveScript.includes('"e3"') &&
        resolveScript.endsWith(", false)") &&
        r.calls.eval.every((c) => c !== VIEWPORT_SCRIPT), // ref 路徑不需要截圖/viewport
      "click ref:在 isolated world 解析元素(scrollIntoView 後的中心座標)再送三個滑鼠事件;不需要截圖",
      JSON.stringify(rev),
    );
    const staleRef = makeDriver({ resolve: { error: "stale" } });
    const noBox = makeDriver({ resolve: { error: "nobox" } });
    const garbage = makeDriver({ resolve: { whatever: 1 } });
    const o1 = await run(staleRef, "click", { ref: "e9" });
    const o2 = await run(noBox, "click", { ref: "e9" });
    const o3 = await run(garbage, "click", { ref: "e9" });
    check(
      !o1.ok &&
        o1.error.code === "browser.staleRef" &&
        /browser_read_page/.test(o1.error.message) &&
        !o2.ok &&
        o2.error.code === "browser.elementNotFound" &&
        !o3.ok &&
        o3.error.code === "browser.hostError" &&
        [staleRef, noBox, garbage].every((d) => mouseEvents(d.calls).length === 0),
      "click ref:ref 過期 → browser.staleRef(訊息教 agent 重新 read_page)、元素沒有可點擊的位置 → browser.elementNotFound、結果格式不對 → browser.hostError;都沒有點下去",
    );
    const neither = await run(makeDriver(), "click", {});
    check(!neither.ok && neither.error.code === "browser.hostError", "click:ref 與座標都沒給 → browser.hostError");
    // 點擊後頁面開始導覽:等它載完(有上限)再回傳
    const nav = makeDriver({ resolve: { x: 5, y: 5 }, loading: true });
    await run(nav, "click", { ref: "e1" });
    check(nav.calls.sleeps[0] === 250 && nav.calls.stops.length === 1 && nav.calls.stops[0] === 5000, "click:點擊後先等 250ms,頁面開始載入的話最多再等 5 秒載完才回傳 url/title");
    const idle = makeDriver({ resolve: { x: 5, y: 5 }, loading: false });
    await run(idle, "click", { ref: "e1" });
    check(idle.calls.stops.length === 0, "click:點擊後沒有開始導覽就不多等");
  }

  // ---- type / pressKey / scroll ----
  {
    const ok = makeDriver({ resolve: { x: 10, y: 10, focused: true }, editable: true });
    const typed = await run(ok, "type", { text: "hello world", ref: "e2" });
    check(
      typed.ok &&
        Object.keys(typed.result).length === 0 &&
        ok.calls.eval.some((c) => c.startsWith("((ref, focus)") && c.endsWith(", true)")) &&
        ok.calls.cdp.filter(([m]) => m === "Input.insertText").length === 1 &&
        ok.calls.cdp.find(([m]) => m === "Input.insertText")[1].text === "hello world" &&
        mouseEvents(ok.calls).length === 0 &&
        ok.calls.cdp.filter(([m]) => m === "Input.dispatchKeyEvent").length === 0,
      "type ref:先在 isolated world 解析並聚焦該元素,再用 Input.insertText 輸入;沒有 submit 就不送任何按鍵、已聚焦就不多點一下",
    );
    const submit = makeDriver({ editable: true, loading: true });
    const sOut = await run(submit, "type", { text: "q", submit: true });
    const keys = submit.calls.cdp.filter(([m]) => m === "Input.dispatchKeyEvent").map(([, p]) => p);
    check(
      sOut.ok &&
        keys.length === 2 &&
        keys[0].type === "keyDown" &&
        keys[0].key === "Enter" &&
        keys[0].text === "\r" &&
        keys[1].type === "keyUp" &&
        submit.calls.cdp.findIndex(([m]) => m === "Input.insertText") < submit.calls.cdp.findIndex(([m]) => m === "Input.dispatchKeyEvent") &&
        submit.calls.stops.length === 1,
      "type submit:輸入文字之後送 Enter(keyDown 帶 \\r + keyUp),順序是先 insertText 再按鍵;之後等導覽",
    );
    const unfocused = makeDriver({ editable: false });
    const noFocus = await run(unfocused, "type", { text: "x" });
    check(
      !noFocus.ok &&
        noFocus.error.code === "browser.elementNotFound" &&
        unfocused.calls.cdp.every(([m]) => m !== "Input.insertText"),
      "type 沒給 ref 且目前沒有聚焦在可輸入的元素 → browser.elementNotFound(教 agent 用 ref 或先 click 輸入框),什麼都沒輸入",
    );
    // 給 ref 但元素聚焦不了:點它的中心再檢查,仍不行就報錯;點了之後聚焦了就照常輸入
    let editableCalls = 0;
    const clickToFocus = makeDriver({ resolve: { x: 7, y: 8, focused: false }, editable: () => ++editableCalls > 1 });
    const cOut = await run(clickToFocus, "type", { text: "abc", ref: "e4" });
    const stuck = makeDriver({ resolve: { x: 7, y: 8, focused: false }, editable: false });
    const stuckOut = await run(stuck, "type", { text: "abc", ref: "e4" });
    check(
      cOut.ok &&
        mouseEvents(clickToFocus.calls).length === 3 &&
        clickToFocus.calls.cdp.some(([m]) => m === "Input.insertText") &&
        !stuckOut.ok &&
        stuckOut.error.code === "browser.elementNotFound" &&
        mouseEvents(stuck.calls).length === 3 &&
        stuck.calls.cdp.every(([m]) => m !== "Input.insertText"),
      "type ref:元素 focus() 之後仍不是可輸入的 → 點它的中心再檢查一次;點了就聚焦的照常輸入、還是不行 → browser.elementNotFound",
    );
    const staleType = await run(makeDriver({ resolve: { error: "stale" } }), "type", { text: "x", ref: "e1" });
    const emptyText = await run(makeDriver(), "type", { text: "" });
    check(!staleType.ok && staleType.error.code === "browser.staleRef" && !emptyText.ok && emptyText.error.code === "browser.hostError", "type:ref 過期 → browser.staleRef;空字串 → browser.hostError");

    const pk = makeDriver();
    const pkOut = await run(pk, "pressKey", { key: "ArrowDown" });
    const pkEvents = pk.calls.cdp.filter(([m]) => m === "Input.dispatchKeyEvent").map(([, p]) => p);
    const badKey2 = await run(makeDriver(), "pressKey", { key: "F13" });
    check(
      pkOut.ok &&
        pkEvents.length === 2 &&
        pkEvents[0].type === "rawKeyDown" &&
        pkEvents[0].windowsVirtualKeyCode === 40 &&
        pkEvents[0].key === "ArrowDown" &&
        pkEvents[0].code === "ArrowDown" &&
        pkEvents[1].type === "keyUp" &&
        !badKey2.ok &&
        badKey2.error.code === "browser.hostError",
      "pressKey:ArrowDown → rawKeyDown(vk 40)+ keyUp;不在列舉內的鍵 → browser.hostError、不送任何事件",
    );

    const sc = makeDriver({ viewport: { cssWidth: 400, cssHeight: 500 } });
    await run(sc, "scroll", { direction: "down" });
    await run(sc, "scroll", { direction: "up", amount: 2.5 });
    await run(sc, "scroll", { direction: "down", amount: 999 });
    const wheels = mouseEvents(sc.calls);
    const badScroll = await run(makeDriver(), "scroll", { direction: "left" });
    check(
      wheels.length === 3 &&
        wheels.every((w) => w.type === "mouseWheel" && w.x === 200 && w.y === 250 && w.deltaX === 0) &&
        wheels[0].deltaY === 400 &&
        wheels[1].deltaY === -1000 &&
        wheels[2].deltaY === 20 * 400 &&
        !badScroll.ok &&
        badScroll.error.code === "browser.hostError",
      "scroll:CDP mouseWheel 在 viewport 中心;單位是視窗高度的 80%(500px 高 → 預設一單位 400、向上 2.5 單位 -1000)、預設 1、上限 20;direction 不合法 → browser.hostError",
      JSON.stringify(wheels.map((w) => w.deltaY)),
    );

    // 捲動、導覽之後舊截圖的座標沒有意義 → 要重新截圖
    const inval = makeDriver();
    await run(inval, "screenshot", {});
    await run(inval, "scroll", { direction: "down" });
    const afterScroll = await run(inval, "click", { x: 10, y: 10 });
    await run(inval, "screenshot", {});
    await run(inval, "navigate", { url: "http://localhost/next" });
    const afterNav = await run(inval, "click", { x: 10, y: 10 });
    check(
      !afterScroll.ok && afterScroll.error.code === "browser.noScreenshot" && !afterNav.ok && afterNav.error.code === "browser.noScreenshot",
      "捲動、導覽之後舊截圖的紀錄被清掉:再用 x/y 點擊 → browser.noScreenshot(要重新截圖)",
    );
  }

  // ---- navigate ----
  {
    const h = makeDriver({ url: "http://localhost/x", title: "X" });
    const out = await run(h, "navigate", { url: "http://localhost/x" });
    check(
      out.ok &&
        out.result.url === "http://localhost/x" &&
        out.result.title === "X" &&
        out.result.loaded === true &&
        h.calls.load.length === 1 &&
        h.calls.load[0] === "http://localhost/x" &&
        h.calls.waits.length === 1 &&
        h.calls.waits[0] === 25_000 &&
        h.calls.waits[0] < 30_000,
      "navigate url:先開始觀察載入結果再 loadURL;等待上限 25 秒(小於 core 的 30 秒);載完回 {url, title, loaded:true}",
      JSON.stringify(out),
    );
    const slow = makeDriver({ loadOutcome: { finished: false, timedOut: true } });
    const slowOut = await run(slow, "navigate", { url: "http://localhost/slow" });
    check(slowOut.ok && slowOut.result.loaded === false && slowOut.result.url === "http://localhost/after", "navigate:逾時(還在載入)→ 回 loaded:false 與目前的 url/title,不是錯誤");
    const failed = makeDriver({ loadOutcome: { finished: false, failure: { code: -102, description: "ERR_CONNECTION_REFUSED", url: "http://localhost:1/" } } });
    const failOut = await run(failed, "navigate", { url: "http://localhost:1/" });
    check(
      !failOut.ok && failOut.error.code === "browser.navigationFailed" && failOut.error.message.includes("ERR_CONNECTION_REFUSED") && failOut.error.message.includes("http://localhost:1/"),
      "navigate:did-fail-load → browser.navigationFailed,說明含錯誤描述與網址",
    );
    const bad = makeDriver();
    const schemeOut = await run(bad, "navigate", { url: "file:///etc/passwd" });
    const jsOut = await run(bad, "navigate", { url: "javascript:alert(1)" });
    check(
      !schemeOut.ok && !jsOut.ok && schemeOut.error.code === "browser.hostError" && bad.calls.load.length === 0 && bad.calls.waits.length === 0,
      "navigate:再檢查一次 scheme(縱深防禦)——file:/javascript: 即使 core 漏擋,main 也不會 loadURL",
    );
    const back = makeDriver();
    const backOut = await run(back, "navigate", { action: "back" });
    const reload = makeDriver();
    await run(reload, "navigate", { action: "reload" });
    const noHistory = makeDriver({ history: false });
    const noHistOut = await run(noHistory, "navigate", { action: "forward" });
    check(
      backOut.ok &&
        back.calls.history[0] === "back" &&
        back.calls.load.length === 0 &&
        reload.calls.history[0] === "reload" &&
        !noHistOut.ok &&
        noHistOut.error.code === "browser.hostError" &&
        /下一頁/.test(noHistOut.error.message) &&
        noHistory.calls.cancelled === 1,
      "navigate action:back/forward/reload 走導覽歷史(不 loadURL);沒有歷史可走 → browser.hostError 並取消載入觀察",
    );
    const neither = await run(makeDriver(), "navigate", {});
    const unknownOp = await run(makeDriver(), "teleport", {});
    check(!neither.ok && neither.error.code === "browser.hostError" && !unknownOp.ok && unknownOp.error.code === "browser.hostError" && /teleport/.test(unknownOp.error.message), "navigate 沒給 url 也沒給 action、不認得的 op → browser.hostError");
  }

  // ---- 整體上限、錯誤對照 ----
  {
    const hung = makeDriver({ cdp: () => new Promise(() => undefined) });
    // 不真的等 12 秒:把 setTimeout 換成立刻觸發來驗證「整體上限」確實存在且回的是 browser.hostError。
    const realSetTimeout = globalThis.setTimeout;
    let observedMs;
    globalThis.setTimeout = (fn, ms, ...rest) => {
      observedMs = ms;
      return realSetTimeout(fn, 0, ...rest);
    };
    let out;
    try {
      out = await run(hung, "screenshot", {});
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    check(
      !out.ok && out.error.code === "browser.hostError" && /12 秒/.test(out.error.message) && observedMs === 12_000 && observedMs < 15_000,
      "整體上限:一個卡住的非導覽 op 12 秒就以 browser.hostError 收場(小於 core 的 15 秒,不讓 core 先逾時)",
    );
    const mapped = [mapExecError(new BrowserExecError("browser.staleRef", "x")), mapExecError(new Error("CDP 掛了")), mapExecError("字串"), mapExecError(new Error("")), mapExecError(new Error("a".repeat(5000)))];
    check(
      mapped[0].code === "browser.staleRef" &&
        mapped[1].code === "browser.hostError" &&
        mapped[1].message === "CDP 掛了" &&
        mapped[2].message === "字串" &&
        mapped[3].code === "browser.hostError" &&
        mapped[3].message.length > 0 &&
        mapped[4].message.length <= 1800,
      "mapExecError:BrowserExecError 原樣保留 code;其餘一律 browser.hostError(訊息保留、空的給預設、過長截到 host 錯誤上限內)",
    );
  }

  // ---- 結果整形(頁面來的值一律重新檢查)----
  {
    const text = buildReadTextResult({ url: "http://x/", title: "T", text: "a".repeat(50), truncated: false }, 10);
    const hostile = buildReadTextResult({ url: 5, title: { evil: true }, text: ["not", "a", "string"], truncated: "yes" }, 100);
    const surrogate = buildReadTextResult({ text: "ab😀cd" }, 3); // 在 😀 的中間切(高位 surrogate 落在第 3 個位置)
    check(
      text.mode === "text" &&
        text.text.length === 10 &&
        text.truncated === true &&
        hostile.url === "" &&
        hostile.title === "" &&
        hostile.text === "" &&
        hostile.truncated === false &&
        surrogate.text === "ab" &&
        surrogate.truncated === true &&
        dropTrailingHighSurrogate("ab\ud83d") === "ab" &&
        dropTrailingHighSurrogate("ab") === "ab",
      "buildReadTextResult:超過 maxChars 由 host 再截一次並標 truncated;型別不對的欄位(數字網址、物件標題、陣列內文)一律當空;不切在 surrogate pair 中間",
      JSON.stringify({ text: text.text.length, surrogate: surrogate.text }),
    );
    const many = Array.from({ length: 700 }, (_, i) => ({ ref: `e${i + 1}`, role: "link", name: `n${i}` }));
    const inter = buildInteractiveResult({
      url: "http://x/",
      title: "T",
      truncated: false,
      elements: [
        { ref: "e1", role: "link", name: "Docs", href: "https://example.com/docs" },
        { ref: "e2", role: "link", name: "JS", href: "javascript:alert(1)" },
        { ref: "e3", role: "link", name: "Mail", href: "mailto:a@b.c" },
        { ref: "evil", role: "button", name: "bad ref" },
        { ref: "e4; drop()", role: "button", name: "bad ref 2" },
        { ref: "e5", role: 5, name: 7 },
        "not an object",
        null,
        { ref: "e6", role: "x".repeat(100), name: "y".repeat(500), href: `https://example.com/${"p".repeat(5000)}` },
      ],
    });
    const capped = buildInteractiveResult({ elements: many });
    check(
      inter.mode === "interactive" &&
        inter.elements.map((e) => e.ref).join() === "e1,e2,e3,e5,e6" &&
        inter.elements[0].href === "https://example.com/docs" &&
        inter.elements[1].href === undefined &&
        inter.elements[2].href === undefined &&
        inter.elements[3].role === "generic" &&
        inter.elements[3].name === "" &&
        inter.elements[4].role.length === 40 &&
        inter.elements[4].name.length === 120 &&
        inter.elements[4].href.length === 2048 && // 過長的網址截在 2048 字元
        capped.elements.length === 500 &&
        capped.truncated === true,
      "buildInteractiveResult:只收我們自己產生的 e<N> ref(頁面塞的別的字串丟掉)、非 http(s) 的 href 不回(javascript:/mailto:)、名稱/role/href 長度上限、型別不對的欄位用預設、超過 500 個截斷並標 truncated",
      JSON.stringify(inter.elements.map((e) => [e.ref, e.role, e.name.length, e.href?.length])),
    );
    const resolveOk = interpretResolveResult({ x: 1.5, y: 2.5, focused: false });
    check(resolveOk.x === 1.5 && resolveOk.y === 2.5 && resolveOk.focused === false, "interpretResolveResult:正常結果 → 座標與 focused");
  }

  // ---- isolated world 腳本:語法、不改動頁面 DOM、行為(用最小的假 DOM)----
  {
    const scripts = [VIEWPORT_SCRIPT, EDITABLE_FOCUS_SCRIPT, buildReadTextScript(100), buildInteractiveScript(500), buildResolveRefScript("e1", true), buildResolveRefScript("e1", false)];
    const parses = scripts.every((code) => {
      try {
        new Function("window", "document", "location", "getComputedStyle", `return ${code}`);
        return true;
      } catch {
        return false;
      }
    });
    const forbidden = ["setAttribute", "removeAttribute", "dataset", ".style", "appendChild", "insertBefore", "innerHTML", "outerHTML", "classList", "createElement", "addEventListener", "eval(", "Function("];
    const touching = scripts.flatMap((code) => forbidden.filter((token) => code.includes(token)));
    check(
      parses && touching.length === 0,
      "isolated world 腳本:全部能被 JS 解析;不含任何會改動頁面 DOM/注入程式的呼叫(setAttribute/dataset/style/appendChild/innerHTML/addEventListener/eval…)——ref 對照表只存在 isolated world 的全域",
      touching.join(","),
    );

    const rect = (w, h, l = 10, t = 20) => ({ left: l, top: t, width: w, height: h });
    const makeEl = (tag, props = {}) => {
      const attrs = props.attrs ?? {};
      const el = {
        tagName: tag,
        type: props.type,
        value: props.value ?? "",
        href: props.href,
        labels: props.labels ?? [],
        innerText: props.text ?? "",
        textContent: props.text ?? "",
        disabled: props.disabled ?? false,
        readOnly: false,
        isContentEditable: props.editable ?? false,
        isConnected: props.connected ?? true,
        scrolled: [],
        focused: false,
        hidden: props.hidden ?? false,
        getAttribute: (n) => (n in attrs ? attrs[n] : null),
        closest: () => null,
        getBoundingClientRect: () => rect(...(props.box ?? [100, 30])),
        scrollIntoView(opts) {
          el.scrolled.push(opts);
        },
        focus() {
          el.focused = true;
          doc.activeElement = el;
        },
      };
      return el;
    };
    const doc = { title: "Test page", activeElement: null, getElementById: () => null };
    const link = makeEl("A", { href: "https://example.com/docs", text: "  Docs \n page " });
    const button = makeEl("BUTTON", { text: "Save" });
    const dead = makeEl("BUTTON", { text: "Disabled", disabled: true });
    const secret = makeEl("INPUT", { type: "text", value: "SECRET-TYPED-BY-USER", attrs: { placeholder: "Search" } });
    const pass = makeEl("INPUT", { type: "password", value: "hunter2", attrs: { "aria-label": "Password" } });
    const submit = makeEl("INPUT", { type: "submit", value: "Go" });
    const check1 = makeEl("INPUT", { type: "checkbox", labels: [{ textContent: "Remember me" }] });
    const invisible = makeEl("BUTTON", { text: "Hidden" });
    const zero = makeEl("BUTTON", { text: "Zero", box: [0, 0] });
    const jsLink = makeEl("A", { href: "javascript:alert(1)", text: "Bad link" });
    const clickable = makeEl("DIV", { text: "Clickable div", attrs: { onclick: "x()" } });
    doc.querySelectorAll = () => [link, button, dead, secret, pass, submit, check1, invisible, zero, jsLink, clickable];
    const win = { innerWidth: 415, innerHeight: 669 };
    const loc = { href: "http://localhost/page" };
    const gcs = (el) => (el === invisible ? { visibility: "visible", display: "none" } : { visibility: "visible", display: "block" });
    let evilCalled = false;
    const evaluate = (code) => new Function("window", "document", "location", "getComputedStyle", "evil", `return ${code}`)(win, doc, loc, gcs, () => (evilCalled = true));

    const list = evaluate(buildInteractiveScript(500));
    const byRef = Object.fromEntries(list.elements.map((e) => [e.ref, e]));
    check(
      list.url === "http://localhost/page" &&
        list.title === "Test page" &&
        list.truncated === false &&
        list.elements.map((e) => e.ref).join() === "e1,e2,e3,e4,e5,e6,e7,e8" &&
        byRef.e1.role === "link" &&
        byRef.e1.name === "Docs page" &&
        byRef.e1.href === "https://example.com/docs" &&
        byRef.e2.role === "button" &&
        byRef.e2.name === "Save" &&
        byRef.e3.role === "textbox" &&
        byRef.e3.name === "Search" &&
        byRef.e4.role === "textbox" &&
        byRef.e4.name === "Password" &&
        byRef.e5.role === "button" &&
        byRef.e5.name === "Go" &&
        byRef.e6.role === "checkbox" &&
        byRef.e6.name === "Remember me" &&
        byRef.e7.name === "Bad link" &&
        byRef.e7.href === undefined &&
        byRef.e8.role === "generic" &&
        byRef.e8.name === "Clickable div" &&
        !JSON.stringify(list).includes("SECRET-TYPED-BY-USER") &&
        !JSON.stringify(list).includes("hunter2"),
      "互動元素腳本:可見的連結/按鈕/輸入框/checkbox/onclick 元素依文件順序編成 e1…eN;role/name 依 aria/label/placeholder/按鈕 value/文字推得;停用的、display:none 的、零大小的略過;文字與密碼輸入框的 value(可能是使用者輸入的機密)絕不進結果;javascript: 的 href 不回",
      JSON.stringify(list.elements),
    );
    const table = win.__deskmonyRefs?.table;
    check(table?.get("e1") === link && table.get("e2") === button && table.size === 8, "ref 對照表存在 isolated world 的 window.__deskmonyRefs(元素參考,頁面看不到),每次讀取整份重建");

    const resolved = evaluate(buildResolveRefScript("e2", true));
    check(
      resolved.x === 60 &&
        resolved.y === 35 &&
        resolved.focused === true &&
        button.scrolled.length === 1 &&
        button.scrolled[0].behavior === "instant" &&
        button.scrolled[0].block === "center" &&
        button.focused === true,
      "解析 ref 腳本:scrollIntoView(instant、置中)之後回中心座標(left+width/2、top+height/2);focus=true 時聚焦並回報是否真的聚焦",
      JSON.stringify(resolved),
    );
    const noFocus = evaluate(buildResolveRefScript("e1", false));
    check(noFocus.focused === undefined && link.focused === false, "解析 ref 腳本:focus=false 不聚焦");
    link.isConnected = false;
    zero.getBoundingClientRect = () => rect(0, 0);
    const detached = evaluate(buildResolveRefScript("e1", false));
    const unknown = evaluate(buildResolveRefScript("e99", false));
    button.getBoundingClientRect = () => rect(0, 0);
    const nobox = evaluate(buildResolveRefScript("e2", false));
    const injected = evaluate(buildResolveRefScript('e1"); evil(); ("', false));
    delete win.__deskmonyRefs;
    const noTable = evaluate(buildResolveRefScript("e2", false));
    check(
      detached.error === "stale" &&
        unknown.error === "stale" &&
        nobox.error === "nobox" &&
        noTable.error === "stale" &&
        injected.error === "stale" &&
        evilCalled === false,
      "解析 ref 腳本:元素已脫離文件、ref 不在表裡、對照表不在(導覽之後 isolated world 重建)→ stale;元素沒有大小 → nobox;ref 字串被當成資料(JSON.stringify),夾帶程式碼不會被執行",
    );
    const textRead = evaluate(buildReadTextScript(5));
    doc.body = { innerText: "hello world" };
    const textRead2 = evaluate(buildReadTextScript(5));
    check(textRead.text === "" && textRead2.text === "hello" && textRead2.truncated === true && textRead2.url === "http://localhost/page", "讀文字腳本:沒有 body 回空字串;超過 maxChars 截斷並標 truncated");
  }
}

console.log("\n== browser-activity:agent 操作中的指示(最近一個動作、自動開面板的判斷)==");
{
  const { describeBrowserAction, shortUrlForDisplay, shouldAutoOpenPanel, ACTIVITY_LINGER_MS } = await import(
    pathToFileURL(path.join(LIB, "browser-activity.ts")).href
  );
  const d = (op, args) => JSON.stringify(describeBrowserAction(op, args));
  check(
    d("navigate", { url: "https://user:pass@example.com/a/b?token=SECRET#frag" }) === JSON.stringify({ key: "navigate", params: { url: "example.com/a/b" } }) &&
      d("navigate", { url: "http://localhost:3000/" }) === JSON.stringify({ key: "navigate", params: { url: "localhost:3000" } }) &&
      d("navigate", { action: "back" }) === JSON.stringify({ key: "back", params: {} }) &&
      d("navigate", { action: "forward" }) === JSON.stringify({ key: "forward", params: {} }) &&
      d("navigate", { action: "reload" }) === JSON.stringify({ key: "reload", params: {} }),
    "describeBrowserAction(navigate):網址只顯示 host + 路徑(不含帳密、查詢字串、片段);back/forward/reload 各自的 key",
  );
  check(
    d("screenshot", {}) === JSON.stringify({ key: "screenshot", params: {} }) &&
      d("readPage", {}) === JSON.stringify({ key: "readText", params: {} }) &&
      d("readPage", { mode: "interactive" }) === JSON.stringify({ key: "readInteractive", params: {} }) &&
      d("click", { ref: "e3" }) === JSON.stringify({ key: "clickRef", params: { ref: "e3" } }) &&
      d("click", { x: 10.4, y: 20.6 }) === JSON.stringify({ key: "clickPoint", params: { x: 10, y: 21 } }) &&
      d("type", { text: "秘密😀abc" }) === JSON.stringify({ key: "type", params: { count: 6 } }) &&
      d("type", { text: "x", submit: true }) === JSON.stringify({ key: "typeSubmit", params: { count: 1 } }) &&
      d("pressKey", { key: "Enter" }) === JSON.stringify({ key: "pressKey", params: { key: "Enter" } }) &&
      d("scroll", { direction: "up" }) === JSON.stringify({ key: "scrollUp", params: {} }) &&
      d("scroll", { direction: "down" }) === JSON.stringify({ key: "scrollDown", params: {} }) &&
      d("teleport", null) === JSON.stringify({ key: "unknown", params: { op: "teleport" } }),
    "describeBrowserAction:其餘 op 的 key 與參數;輸入的文字只顯示字元數(按 code point 數、不顯示內容);不認得的 op 與 null args 不丟例外",
  );
  check(
    shortUrlForDisplay("https://example.com/" + "p".repeat(200)).length === 60 &&
      shortUrlForDisplay("https://example.com/" + "p".repeat(200)).endsWith("…") &&
      shortUrlForDisplay("not a url") === "not a url" &&
      shortUrlForDisplay(undefined) === "",
    "shortUrlForDisplay:太長以刪節號截到 60 字元;解析不了的原樣;非字串回空字串",
  );
  check(
    shouldAutoOpenPanel({ isCurrentSession: true, panelOpen: false, hasRecentActivity: false }) === true &&
      shouldAutoOpenPanel({ isCurrentSession: false, panelOpen: false, hasRecentActivity: false }) === false &&
      shouldAutoOpenPanel({ isCurrentSession: true, panelOpen: true, hasRecentActivity: false }) === false &&
      shouldAutoOpenPanel({ isCurrentSession: true, panelOpen: false, hasRecentActivity: true }) === false &&
      ACTIVITY_LINGER_MS === 8000,
    "shouldAutoOpenPanel:只有「目前 session + 面板關著 + 一段操作的開頭」才自動打開(面板已開、別的 session、操作進行中使用者又關掉都不會彈出來)",
  );
}

{
  const { browserWebviewTabIndex } = await import(pathToFileURL(path.join(LIB, "browser-frame-style.ts")).href);
  check(
    browserWebviewTabIndex(undefined) === -1 && browserWebviewTabIndex({ x: 1, y: 2, width: 3, height: 4 }) === undefined,
    "browserWebviewTabIndex:停放中的 webview tabindex=-1(使用者按 Tab 進不去看不見的頁面)、可見時不設屬性",
  );

  // 回歸保護(真 app 實測,2026-10-23):停放時加 `inert` 會讓 CDP 的滑鼠點擊完全送不進頁面(其餘輸入/截圖都正常),拿掉才 9/9 通過。
  // 任何讓 webview「無法被聚焦」的做法都有同樣的風險,所以停放的 Tab 防護只能是 tabindex。這裡檢查程式碼(不含註解)沒有再用這些做法。
  const fs = await import("node:fs");
  const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  const hostCode = stripComments(fs.readFileSync(path.resolve(LIB, "..", "views", "panel", "BrowserHost.tsx"), "utf8"));
  const styleCode = stripComments(fs.readFileSync(path.join(LIB, "browser-frame-style.ts"), "utf8"));
  check(
    !/\binert\b/.test(hostCode) && !/\binert\b/.test(styleCode) && !/\bdisabled\b/.test(hostCode) && !/\.blur\(/.test(hostCode) && /tabIndex=\{tabIndex\}/.test(hostCode) && /browserWebviewTabIndex\(rect\)/.test(hostCode),
    "BrowserHost 不用 inert/disabled/blur 擋停放中的 webview(會讓 CDP 點擊送不進去),只用 tabIndex(停放 -1)",
  );
}

console.log("\n== browser-host-flow:收到 browser-command 之後的流程與失敗回報(假 deps)==");
{
  const flow = await import(pathToFileURL(path.join(LIB, "browser-host-flow.ts")).href);
  const { runBrowserCommand, normalizeExecOutcome, commandIdOf, failure, hostFailure, READY_WAIT_MS, AUTO_OPEN_SETTLE_MS } = flow;

  /** 假 deps:記錄呼叫順序,每個行為都能被覆寫。 */
  function makeDeps(over = {}) {
    const log = [];
    const replies = [];
    const deps = {
      parseCommand: (raw) =>
        raw && typeof raw === "object" && typeof raw.commandId === "string" && typeof raw.sessionId === "string" && ["navigate", "screenshot", "readPage", "click", "type", "pressKey", "scroll"].includes(raw.op)
          ? { commandId: raw.commandId, sessionId: raw.sessionId, op: raw.op, args: raw.args ?? {} }
          : undefined,
      sessionExists: (id) => id === "s1",
      hadActivity: () => false,
      beginActivity: (id, op, args) => log.push(["begin", id, op, args]),
      endActivity: (id) => log.push(["end", id]),
      shouldAutoOpen: (id, had) => {
        log.push(["shouldAutoOpen", id, had]);
        return false;
      },
      openPanel: () => log.push(["openPanel"]),
      sleep: async (ms) => {
        log.push(["sleep", ms]);
      },
      ensureGuest: async (id) => {
        log.push(["ensureGuest", id]);
        return 42;
      },
      isCrashed: () => false,
      exec: async (wcId, op, args) => {
        log.push(["exec", wcId, op, args]);
        return { ok: true, result: { url: "http://localhost/", title: "T" } };
      },
      reply: async (commandId, outcome) => {
        log.push(["reply", commandId]);
        replies.push({ commandId, outcome });
      },
      ...over,
    };
    return { deps, log, replies };
  }
  const names = (log) => log.map((e) => e[0]).join(",");
  const cmd = (extra = {}) => ({ commandId: "c1", sessionId: "s1", op: "click", args: { ref: "e3" }, ...extra });

  {
    const h = makeDeps();
    await runBrowserCommand(h.deps, cmd());
    check(
      names(h.log) === "begin,shouldAutoOpen,ensureGuest,exec,end,reply" &&
        h.log[0][1] === "s1" &&
        h.log[0][2] === "click" &&
        h.log[3][1] === 42 &&
        h.log[3][2] === "click" &&
        JSON.stringify(h.log[3][3]) === JSON.stringify({ ref: "e3" }) &&
        h.replies.length === 1 &&
        h.replies[0].commandId === "c1" &&
        h.replies[0].outcome.ok === true &&
        h.replies[0].outcome.result.url === "http://localhost/",
      "正常流程:顯示操作中 → 確保 webview 就緒 → 交給 main 執行 → 結束操作中 → 回報結果(只回一次,commandId 原樣)",
      names(h.log),
    );
  }
  {
    const bad = makeDeps();
    await runBrowserCommand(bad.deps, { commandId: "c9", sessionId: "s1", op: "teleport", args: {} });
    const noId = makeDeps();
    await runBrowserCommand(noId.deps, { sessionId: "s1", op: "click" });
    const garbage = makeDeps();
    await runBrowserCommand(garbage.deps, "oops");
    check(
      bad.replies.length === 1 &&
        bad.replies[0].commandId === "c9" &&
        bad.replies[0].outcome.ok === false &&
        bad.replies[0].outcome.error.code === "browser.hostError" &&
        names(bad.log) === "reply" &&
        noId.replies.length === 0 &&
        garbage.replies.length === 0 &&
        names(garbage.log) === "",
      "不認得的 op / 壞掉的 payload:有 commandId 就回 browser.hostError(不進任何流程、不顯示操作中);連 commandId 都沒有就什麼都不做",
    );
  }
  {
    const gone = makeDeps();
    await runBrowserCommand(gone.deps, cmd({ sessionId: "deleted" }));
    check(
      gone.replies.length === 1 &&
        gone.replies[0].outcome.ok === false &&
        gone.replies[0].outcome.error.code === "browser.hostError" &&
        names(gone.log) === "reply",
      "session 不在清單裡:回 browser.hostError,不顯示操作中、不建立 webview、不執行",
    );
  }
  {
    // 自動開面板:決策輸入是「開始前就有沒有指示」;開了要等一下再繼續
    const open = makeDeps({
      hadActivity: () => true,
      shouldAutoOpen: (id, had) => {
        open.log.push(["shouldAutoOpen", id, had]);
        return true;
      },
    });
    await runBrowserCommand(open.deps, cmd());
    const sawHad = open.log.find((e) => e[0] === "shouldAutoOpen");
    check(
      names(open.log) === "begin,shouldAutoOpen,openPanel,sleep,ensureGuest,exec,end,reply" && sawHad[2] === true && open.log.find((e) => e[0] === "sleep")[1] === AUTO_OPEN_SETTLE_MS,
      "自動打開面板:先 openPanel、等 slot 就位(AUTO_OPEN_SETTLE_MS)才確保 webview 並執行;hadActivity 是 beginActivity 之前的狀態",
      names(open.log),
    );
    const order = makeDeps({ hadActivity: () => (order.log.push(["hadActivity"]), true) });
    await runBrowserCommand(order.deps, cmd());
    check(order.log[0][0] === "hadActivity" && order.log[1][0] === "begin", "hadActivity 在 beginActivity 之前查(之後查一定是真,自動開面板就永遠不會觸發)");
  }
  {
    const ensureFail = makeDeps({
      ensureGuest: async () => {
        throw new Error("瀏覽器頁面在 5 秒內沒有準備好");
      },
    });
    await runBrowserCommand(ensureFail.deps, cmd());
    check(
      names(ensureFail.log) === "begin,shouldAutoOpen,end,reply" &&
        ensureFail.replies[0].outcome.ok === false &&
        ensureFail.replies[0].outcome.error.code === "browser.hostError" &&
        ensureFail.replies[0].outcome.error.message === "瀏覽器頁面在 5 秒內沒有準備好" &&
        READY_WAIT_MS === 5000 &&
        READY_WAIT_MS < 15_000,
      "webview 起不來(逾時/session 被刪):回 browser.hostError 帶原因,操作中指示仍然結束;等 webview 的上限遠小於 core 的 15 秒",
    );
    const crashed = makeDeps({ isCrashed: () => true });
    await runBrowserCommand(crashed.deps, cmd());
    check(
      crashed.replies[0].outcome.ok === false && /當掉/.test(crashed.replies[0].outcome.error.message) && !names(crashed.log).includes("exec") && names(crashed.log).includes("end"),
      "頁面 render 行程當掉:回 browser.hostError(提示重新導覽),不送指令給 main,操作中指示照常結束",
    );
    const noExec = makeDeps({ exec: undefined });
    await runBrowserCommand(noExec.deps, cmd());
    check(noExec.replies[0].outcome.ok === false && /沒有瀏覽器執行端/.test(noExec.replies[0].outcome.error.message) && !names(noExec.log).includes("ensureGuest"), "舊版殼沒有 browserExec:回 browser.hostError,連 webview 都不建立");
    const throwing = makeDeps({
      exec: async () => {
        throw new Error("Error invoking remote method 'deskmony:browserExec': webContentsId 不是這個視窗的 webview");
      },
    });
    await runBrowserCommand(throwing.deps, cmd());
    check(
      throwing.replies[0].outcome.ok === false &&
        /webContentsId/.test(throwing.replies[0].outcome.error.message) &&
        names(throwing.log) === "begin,shouldAutoOpen,ensureGuest,end,reply",
      "IPC 丟例外(main 拒絕、webview 剛好被銷毀):回 browser.hostError 帶訊息,不丟出去",
    );
  }
  {
    const failed = makeDeps({
      exec: async () => ({ ok: false, error: { code: "browser.staleRef", message: "ref 過期" } }),
    });
    await runBrowserCommand(failed.deps, cmd());
    const long = makeDeps({
      exec: async () => ({ ok: false, error: { code: "c".repeat(300), message: "m".repeat(5000) } }),
    });
    await runBrowserCommand(long.deps, cmd());
    check(
      failed.replies[0].outcome.ok === false &&
        failed.replies[0].outcome.error.code === "browser.staleRef" &&
        failed.replies[0].outcome.error.message === "ref 過期" &&
        long.replies[0].outcome.error.code.length === 100 &&
        long.replies[0].outcome.error.message.length === 2000,
      "執行器回報的失敗(code/message)原樣轉給 core;過長的 code/message 截到 schema 上限(100/2000),不會因為驗證失敗讓 core 乾等",
    );
    const weird = [undefined, null, "ok", 5, {}, { ok: "yes" }, { ok: false }, { ok: false, error: "x" }].map(normalizeExecOutcome);
    check(
      weird.every((o) => o.ok === false && o.error.code === "browser.hostError") &&
        normalizeExecOutcome({ ok: true, result: { a: 1 } }).ok === true &&
        normalizeExecOutcome({ ok: true }).result === undefined &&
        normalizeExecOutcome({ ok: false, error: { message: "x" } }).error.code === "browser.hostError" &&
        normalizeExecOutcome({ ok: false, error: { code: "browser.noScreenshot" } }).error.message === "",
      "normalizeExecOutcome:形狀不對的回傳(undefined/字串/缺 error…)一律 browser.hostError;ok:true 保留 result;缺 code 補 browser.hostError",
    );
    check(
      commandIdOf({ commandId: "x" }) === "x" && commandIdOf({ commandId: "" }) === undefined && commandIdOf({ commandId: 5 }) === undefined && commandIdOf(null) === undefined && commandIdOf("x") === undefined,
      "commandIdOf:只認非空字串的 commandId",
    );
    check(failure("a".repeat(150), "b").error.code.length === 100 && hostFailure("x").error.code === "browser.hostError", "failure/hostFailure:code 截到 100、host 錯誤用 browser.hostError");
  }
  {
    // 永遠不丟例外:reply 自己失敗、beginActivity 丟例外都被吞掉/轉成回報
    const replyThrows = makeDeps({
      reply: async () => {
        throw new Error("連線斷了");
      },
    });
    let threw = false;
    try {
      await runBrowserCommand(replyThrows.deps, cmd());
    } catch {
      threw = true;
    }
    const beginThrows = makeDeps({
      beginActivity: () => {
        throw new Error("store 壞了");
      },
    });
    let threw2 = false;
    try {
      await runBrowserCommand(beginThrows.deps, cmd());
    } catch {
      threw2 = true;
    }
    check(
      !threw && !threw2 && beginThrows.replies.length === 1 && beginThrows.replies[0].outcome.ok === false && /store 壞了/.test(beginThrows.replies[0].outcome.error.message),
      "runBrowserCommand 永遠不丟例外:回報失敗被吞掉(沒人可通知);中途意外的例外轉成 browser.hostError 回報",
    );
  }
}

console.log("\n== browser-store:agent 操作指示的留存與 webview 就緒等待(用真的 store、假計時器)==");
{
  // store 的相對 import 都以 .js 結尾(給 tsc/vite 用);Node 直接載 .ts 時要把它們對應到 .ts——只在這個測試用一個 resolve hook 處理。
  const { register } = await import("node:module");
  register(
    "data:text/javascript," +
      encodeURIComponent(`
export async function resolve(specifier, context, nextResolve) {
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && specifier.endsWith(".js")) {
    try { return await nextResolve(specifier.slice(0, -3) + ".ts", context); } catch {}
  }
  return nextResolve(specifier, context);
}`),
    import.meta.url,
  );
  const cleared = [];
  globalThis.window = { deskmony: { browserOpenExternal: () => undefined, browserClearPartition: async (id) => cleared.push(id) } };
  const storeUrl = pathToFileURL(path.resolve(LIB, "..", "stores", "browser-store.ts")).href;
  const { useBrowserStore, waitForBrowserReady } = await import(storeUrl);
  const { ACTIVITY_LINGER_MS } = await import(pathToFileURL(path.join(LIB, "browser-activity.ts")).href);

  /** 假計時器:不真的等,由測試決定什麼時候觸發。 */
  async function withFakeTimers(fn) {
    const realSet = globalThis.setTimeout;
    const realClear = globalThis.clearTimeout;
    const timers = new Map();
    let next = 1;
    globalThis.setTimeout = (callback, ms) => {
      const id = next++;
      timers.set(id, { callback, ms });
      return id;
    };
    globalThis.clearTimeout = (id) => {
      timers.delete(id);
    };
    try {
      await fn({
        timers,
        fireAll: () => {
          for (const [id, timer] of [...timers]) {
            timers.delete(id);
            timer.callback();
          }
        },
      });
    } finally {
      globalThis.setTimeout = realSet;
      globalThis.clearTimeout = realClear;
    }
  }

  const SID = "11111111-1111-4111-8111-111111111111";
  const action = (key) => ({ key, params: {} });
  const store = () => useBrowserStore.getState();

  await withFakeTimers(async ({ timers, fireAll }) => {
    store().ensure(SID);
    store().beginAgentAction(SID, action("navigate"));
    const a1 = store().agentActivity[SID];
    store().beginAgentAction(SID, action("screenshot"));
    const a2 = store().agentActivity[SID];
    store().endAgentAction(SID);
    const a3 = store().agentActivity[SID];
    check(
      a1.active === 1 && a1.action.key === "navigate" && a2.active === 2 && a2.action.key === "screenshot" && a3.active === 1 && timers.size === 0,
      "指示:開始一個指令 active=1、再開始一個 active=2(顯示最新的動作);結束一個還有進行中的 → 不開始倒數",
    );
    store().endAgentAction(SID);
    const a4 = store().agentActivity[SID];
    const lingerTimer = [...timers.values()][0];
    check(
      a4.active === 0 && a4.action.key === "screenshot" && timers.size === 1 && lingerTimer.ms === ACTIVITY_LINGER_MS && ACTIVITY_LINGER_MS === 8000,
      "最後一個指令結束:active=0(剛剛操作過)、保留最近的動作、開始 8 秒倒數",
    );
    fireAll();
    check(store().agentActivity[SID] === undefined, "倒數結束:紀錄清掉,指示消失");

    // 倒數期間又來新指令:取消倒數;舊倒數即使被觸發也不能清掉進行中的紀錄
    store().beginAgentAction(SID, action("click"));
    store().endAgentAction(SID);
    const staleTimer = [...timers.values()][0];
    store().beginAgentAction(SID, action("scrollDown"));
    check(timers.size === 0 && store().agentActivity[SID].active === 1 && store().agentActivity[SID].action.key === "scrollDown", "倒數期間又來新指令:取消倒數、指示回到「正在操作」");
    staleTimer.callback();
    check(store().agentActivity[SID]?.active === 1, "已被取消的舊倒數即使被觸發也不會清掉進行中的紀錄");
    store().endAgentAction(SID);
    fireAll();

    // 沒開始就結束:無害
    store().endAgentAction(SID);
    check(store().agentActivity[SID] === undefined && timers.size === 0, "沒有紀錄時 endAgentAction 什麼都不做");

    // session 刪除:指示與倒數一併清掉
    store().beginAgentAction(SID, action("navigate"));
    store().endAgentAction(SID);
    store().discard(SID);
    check(store().agentActivity[SID] === undefined && timers.size === 0 && !store().created.includes(SID) && cleared.includes(SID), "session 被刪除:指示、倒數、webview 狀態與 partition 一併清掉");
  });

  // ---- waitForBrowserReady ----
  await withFakeTimers(async ({ timers, fireAll }) => {
    store().ensure(SID);
    // 還沒就緒 → 等;之後 dom-ready(patchPage)→ 回傳 webContentsId
    const waiting = waitForBrowserReady(SID, 5000);
    check(timers.size === 1 && [...timers.values()][0].ms === 5000, "waitForBrowserReady:還沒就緒時掛上逾時計時器(5 秒)");
    store().patchPage(SID, { ready: true });
    let settled = false;
    waiting.then(
      () => (settled = true),
      () => (settled = true),
    );
    await Promise.resolve();
    check(!settled, "ready 了但還沒有 webContentsId:繼續等(沒有 id 無法交給 main)");
    store().patchPage(SID, { webContentsId: 77 });
    check((await waiting) === 77 && timers.size === 0, "dom-ready 之後回傳 webContentsId,並清掉計時器");
    check((await waitForBrowserReady(SID, 5000)) === 77 && timers.size === 0, "已經就緒:立刻回傳、不掛計時器");

    // 等待中 session 被刪除 → reject
    store().discard(SID);
    store().ensure(SID);
    const gone = waitForBrowserReady(SID, 5000);
    store().discard(SID);
    let goneErr;
    try {
      await gone;
    } catch (err) {
      goneErr = err;
    }
    check(goneErr instanceof Error && /已被移除/.test(goneErr.message) && timers.size === 0, "等待中 session 被刪除:reject(已被移除),計時器清掉");

    // 逾時 → reject
    store().ensure(SID);
    const slow = waitForBrowserReady(SID, 5000);
    fireAll();
    let slowErr;
    try {
      await slow;
    } catch (err) {
      slowErr = err;
    }
    check(slowErr instanceof Error && /5 秒內沒有準備好/.test(slowErr.message), "逾時:reject(5 秒內沒有準備好)");
    store().discard(SID);

    // 從沒建立過的 session → 立刻 reject
    let neverErr;
    try {
      await waitForBrowserReady("22222222-2222-4222-8222-222222222222", 5000);
    } catch (err) {
      neverErr = err;
    }
    check(neverErr instanceof Error, "沒有建立過 webview 的 session:立刻 reject(不空等)");
  });
  delete globalThis.window;
}

console.log(`\n總計: ${passed} PASS, ${total - passed} FAIL`);
process.exit(passed === total ? 0 : 1);
