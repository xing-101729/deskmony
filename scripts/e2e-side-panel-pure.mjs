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

console.log(`\n總計: ${passed} PASS, ${total - passed} FAIL`);
process.exit(passed === total ? 0 : 1);
