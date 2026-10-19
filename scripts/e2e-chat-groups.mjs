#!/usr/bin/env node
/**
 * scripts/e2e-chat-groups.mjs
 *
 * 2026-10-16:對話串「連續工具呼叫收成一組」的純函式測試(apps/desktop/src/lib/chat-groups.ts)。
 *
 * 為什麼放在 scripts/ 而且叫 e2e-*:apps/desktop 沒有自己的測試機制(沒有 test script、沒有 vitest),
 * repo 唯一的測試入口是 `scripts/run-e2e.mjs`;前端純函式(例如 GatewayClient 的補載)一向也是用這種
 * 「不啟動 core 的小腳本」掛在那邊,這支沿用同一個慣例。
 *
 * 做法:直接用 Node 載入 .ts(Node >= 22.18 預設就會剝掉型別,CI 用 Node 22)。能這樣做的前提是被測的
 * 兩個檔案(lib/chat-groups.ts、lib/question-tools.ts)**沒有任何執行期 import**——Node 不會把 `./x.js` 解析成
 * `./x.ts`,而且我們不想為了測試把 React / zustand / i18next 牽進來。不需要 `pnpm build`,毫秒級跑完。
 *
 * 涵蓋:連續工具成組、被 user/assistant/system 斷開、提問工具斷開、單一工具不成組、running/failed 狀態彙總、
 * 空 assistant 訊息的處理、組的 key 穩定、memo 比較函式,最後加一輪隨機序列的不變量檢查。
 *
 * 用法:node scripts/e2e-chat-groups.mjs
 */

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.resolve(__dirname, "..", "apps", "desktop", "src", "lib");

// `process.features.typescript` 在 Node 22.10+ 才有;預設啟用要 22.18+。
if (!process.features.typescript) {
  console.error(`需要能直接執行 .ts 的 Node(>= 22.18,或加 --experimental-strip-types);目前是 ${process.version}`);
  process.exit(1);
}

const { groupChatItems, summarizeToolGroup, shortToolName, sameToolItems } = await import(
  pathToFileURL(path.join(LIB, "chat-groups.ts")).href
);
const { isQuestionToolName } = await import(pathToFileURL(path.join(LIB, "question-tools.ts")).href);

let passed = 0;
let total = 0;
function check(cond, label) {
  total++;
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ ${label}`);
  }
}
function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(a === e, a === e ? label : `${label}\n      預期 ${e}\n      實際 ${a}`);
}

// ---- 假資料 ---------------------------------------------------------------

const tool = (id, toolName, extra = {}) => ({
  kind: "tool",
  id,
  toolName,
  isError: false,
  status: "done",
  createdAt: 0,
  ...extra,
});
const running = (id, toolName) => tool(id, toolName, { status: "running" });
const failed = (id, toolName) => tool(id, toolName, { isError: true });
const user = (id) => ({ kind: "user", id, content: "hi", createdAt: 0 });
const asst = (id, content = "text", streaming = false) => ({ kind: "assistant", id, content, createdAt: 0, streaming });
const sys = (id) => ({ kind: "system", id, content: "{}", createdAt: 0 });

/** 把渲染單位縮成一行可讀的形狀,方便斷言:`G[a,b]` 是一組,其餘是單則的 id。 */
const shape = (entries) =>
  entries.map((e) => (e.type === "toolGroup" ? `G[${e.items.map((i) => i.id).join(",")}]` : e.item.id));
const group = (items) => groupChatItems(items, isQuestionToolName);

// ---- 1. 基本分組 ----------------------------------------------------------

console.log("[1] 基本分組");
eq(shape(group([])), [], "空陣列 → 空");
eq(shape(group([tool("t1", "Read")])), ["t1"], "單一工具不成組,原樣輸出");
{
  const entries = group([tool("t1", "Read"), tool("t2", "Bash")]);
  eq(shape(entries), ["G[t1,t2]"], "兩個連續工具成一組");
  eq(entries[0].key, "tool-group:t1", "組的 key 是第一個工具的 id");
}
eq(
  shape(group([user("u1"), tool("t1", "A"), tool("t2", "B"), tool("t3", "C"), asst("a1")])),
  ["u1", "G[t1,t2,t3]", "a1"],
  "user → 三個工具 → assistant:組夾在中間,前後訊息原樣",
);
eq(shape(group([user("u1"), asst("a1"), sys("s1")])), ["u1", "a1", "s1"], "沒有工具:全部原樣");
{
  const items = [tool("t1", "A"), tool("t2", "B")];
  const [entry] = group(items);
  check(entry.items[0] === items[0] && entry.items[1] === items[1], "組內保留原本的 item 引用(不複製)");
}

// ---- 2. 被其他訊息斷開 ----------------------------------------------------

console.log("[2] 被 user / assistant / system 斷開");
eq(
  shape(group([tool("t1", "A"), tool("t2", "B"), user("u1"), tool("t3", "C"), tool("t4", "D")])),
  ["G[t1,t2]", "u1", "G[t3,t4]"],
  "user 斷開 → 兩組",
);
eq(
  shape(group([tool("t1", "A"), asst("a1", "回覆"), tool("t2", "B")])),
  ["t1", "a1", "t2"],
  "有內容的 assistant 斷開 → 兩邊各只剩一個工具,都不成組",
);
eq(
  shape(group([tool("t1", "A"), tool("t2", "B"), sys("s1"), tool("t3", "C")])),
  ["G[t1,t2]", "s1", "t3"],
  "system 斷開 → 一組 + 一個單張",
);
eq(
  shape(group([tool("t1", "A"), tool("t2", "B"), asst("a1", "x"), tool("t3", "C"), tool("t4", "D"), tool("t5", "E")])),
  ["G[t1,t2]", "a1", "G[t3,t4,t5]"],
  "多段各自成組",
);
eq(
  shape(group([asst("a1", "先說一句"), tool("t1", "A"), tool("t2", "B"), asst("a2", "再說一句")])),
  ["a1", "G[t1,t2]", "a2"],
  "前後都有 assistant 回覆,組不吃掉它們",
);

// ---- 3. 提問工具 ----------------------------------------------------------

console.log("[3] 互動式提問工具不進組、並斷開");
check(isQuestionToolName("AskUserQuestion") && isQuestionToolName("question"), "判斷式認得 AskUserQuestion 與 question");
check(!isQuestionToolName("Read") && !isQuestionToolName(""), "一般工具不是提問工具");
eq(
  shape(group([tool("t1", "A"), tool("t2", "B"), tool("q1", "AskUserQuestion"), tool("t3", "C"), tool("t4", "D")])),
  ["G[t1,t2]", "q1", "G[t3,t4]"],
  "AskUserQuestion 獨立顯示並斷開前後兩組",
);
eq(
  shape(group([tool("t1", "A"), tool("q1", "question"), tool("t2", "B")])),
  ["t1", "q1", "t2"],
  "opencode 的 question 同樣斷開;兩邊各一個工具不成組",
);
eq(shape(group([tool("q1", "question"), tool("q2", "AskUserQuestion")])), ["q1", "q2"], "連續的提問工具各自獨立");
{
  const entries = group([tool("t1", "A"), tool("q1", "question"), tool("t2", "B"), tool("t3", "C")]);
  check(
    entries.every((e) => e.type !== "toolGroup" || e.items.every((i) => !isQuestionToolName(i.toolName))),
    "任何組裡都不含提問工具",
  );
}

// ---- 4. TodoWrite / diff 可以在組裡 --------------------------------------

console.log("[4] TodoWrite 與帶 diff 的工具可以在組裡");
eq(
  shape(
    group([
      tool("t1", "TodoWrite", { input: { todos: [] } }),
      tool("t2", "Edit", { structuredResult: { filePath: "a.ts", structuredPatch: [] } }),
      tool("t3", "Read"),
    ]),
  ),
  ["G[t1,t2,t3]"],
  "三種工具混在同一組",
);

// ---- 5. 空的 assistant 訊息 ----------------------------------------------

console.log("[5] 空的 assistant 訊息不會把組切斷");
eq(
  shape(group([tool("t1", "A"), asst("e1", "", true), tool("t2", "B")])),
  ["G[t1,t2]"],
  "夾在兩個工具中間的(串流中)空訊息 → 吸收,組不被切斷",
);
eq(
  shape(group([tool("t1", "A"), asst("e1", "\n  ", false), asst("e2", "", true), tool("t2", "B"), tool("t3", "C")])),
  ["G[t1,t2,t3]"],
  "只有空白的訊息同樣算空;連續多個一起吸收",
);
eq(
  shape(group([tool("t1", "A"), tool("t2", "B"), asst("e1", "", true)])),
  ["G[t1,t2]", "e1"],
  "尾端的空訊息(agent 正要開始回覆的游標)原樣輸出在組之後",
);
eq(
  shape(group([asst("e1", "", true), tool("t1", "A"), tool("t2", "B")])),
  ["e1", "G[t1,t2]"],
  "工具之前的空訊息不在 run 裡,原樣輸出",
);
eq(
  shape(group([tool("t1", "A"), tool("t2", "B"), asst("e1", "", false), user("u1")])),
  ["G[t1,t2]", "e1", "u1"],
  "空訊息後面接 user:組結算後依原順序補出",
);
eq(shape(group([tool("t1", "A"), asst("e1", "", true)])), ["t1", "e1"], "單一工具 + 尾端空訊息:順序不變");
eq(
  shape(group([tool("t1", "A"), asst("e1", ""), asst("a1", "有內容"), tool("t2", "B")])),
  ["t1", "e1", "a1", "t2"],
  "空訊息後面接有內容的 assistant:仍斷開,空訊息依原順序保留",
);
{
  // 串流的先後順序:先看到「工具、空訊息」,之後工具 2 才到——組的 key 不能因此改變。
  const t1 = tool("t1", "A");
  const t2 = tool("t2", "B");
  const before = group([t1, t2, asst("e1", "", true)]);
  const after = group([t1, t2, asst("e1", "", true), tool("t3", "C")]);
  eq(before[0].key, after[0].key, "尾端空訊息之後又來新工具:組的 key 不變");
  eq(shape(after), ["G[t1,t2,t3]"], "…並且空訊息被吸收進去");
}

// ---- 6. 組的 key 穩定 -----------------------------------------------------

console.log("[6] 組的 key 與 memo 比較");
{
  const a = tool("t1", "A");
  const b = tool("t2", "B");
  const c = tool("t3", "C");
  eq(group([a, b])[0].key, group([a, b, c])[0].key, "新工具加進來,組的 key 不變(展開狀態才不會被重置)");
  eq(group([user("u0"), a, b])[0].key, "u0", "user 的 key 是它自己的 id");
  eq(group([user("u0"), a, b])[1].key, "tool-group:t1", "組的 key 不受前面訊息影響");
}
{
  const t1 = tool("t1", "A");
  const t2 = tool("t2", "B");
  const t3 = tool("t3", "C");
  const t4 = tool("t4", "D");
  const history = [t1, t2, user("u1"), t3, t4];
  const first = group(history);
  const second = group([...history]); // 串流中 store 每次都會產生新陣列,但沒變動的 item 引用不變
  check(first[0].items !== second[0].items, "每次重算都會新建組的 items 陣列(預設淺比較會一直判定變了)");
  check(sameToolItems(first[0].items, second[0].items), "sameToolItems:內容引用全同 → 視為相同,可跳過重繪");
  const t4b = { ...t4, status: "running" }; // immutable 更新:只有 t4 換了新物件
  const third = group([t1, t2, user("u1"), t3, t4b]);
  check(sameToolItems(first[0].items, third[0].items), "沒動到的組仍判定相同");
  check(!sameToolItems(first[2].items, third[2].items), "有 item 換了新物件的組判定不同,會重繪");
  check(!sameToolItems([t1, t2], [t1, t2, t3]), "長度不同 → 不同");
  check(!sameToolItems([t1, t2], [t2, t1]), "順序不同 → 不同");
}

// ---- 7. 狀態彙總 ----------------------------------------------------------

console.log("[7] 狀態彙總與摘要");
{
  const s = summarizeToolGroup([tool("t1", "Read"), tool("t2", "Bash")]);
  eq([s.status, s.runningCount, s.failedCount, s.runningName, s.total], ["done", 0, 0, undefined, 2], "全部完成 → done");
}
{
  const s = summarizeToolGroup([tool("t1", "Read"), running("t2", "Bash"), failed("t3", "Edit")]);
  eq(s.status, "running", "有任何一個執行中 → running(即使同時有失敗)");
  eq([s.runningCount, s.failedCount, s.runningName], [1, 1, "Bash"], "執行中數、失敗數、目前執行中的工具名");
}
{
  const s = summarizeToolGroup([failed("t1", "Read"), tool("t2", "Bash"), failed("t3", "Edit")]);
  eq([s.status, s.failedCount], ["failed", 2], "沒有執行中、有失敗 → failed,並帶失敗數");
}
{
  const s = summarizeToolGroup([running("t1", "A"), running("t2", "B")]);
  eq([s.runningCount, s.runningName], [2, "B"], "多個同時執行中:顯示最後(最新)開始的");
}
{
  // ToolCallBubble 只在不是 running 時才看 isError,彙總要一致。
  const s = summarizeToolGroup([tool("t1", "A", { status: "running", isError: true }), tool("t2", "B")]);
  eq([s.status, s.failedCount], ["running", 0], "執行中的項目不計入失敗(與 ToolCallBubble 一致)");
}
{
  const s = summarizeToolGroup([
    tool("t1", "mcp.deskmony.send_to_session"),
    tool("t2", "Guardian Review"),
    tool("t3", "mcp.deskmony.list_sessions"),
    tool("t4", "Guardian Review"),
    tool("t5", "mcp.deskmony.read_session"),
    tool("t6", "Guardian Review"),
    tool("t7", ""),
  ]);
  eq(
    s.names,
    ["send_to_session", "Guardian Review", "list_sessions", "read_session", "tool"],
    "工具名依首次出現順序去重、縮短 mcp 前綴、空名稱顯示為 tool",
  );
  eq(s.total, 7, "total 是未去重的呼叫次數");
}
eq(
  [
    shortToolName("mcp.deskmony.send_to_session"),
    shortToolName("mcp__deskmony__send_to_session"),
    shortToolName("mcp__claude_ai_Gmail__search_threads"),
    shortToolName("Read package.json"),
    shortToolName("Guardian Review"),
    shortToolName("mcp.deskmony"),
    shortToolName("mcp."),
    shortToolName(""),
  ],
  ["send_to_session", "send_to_session", "search_threads", "Read package.json", "Guardian Review", "deskmony", "mcp.", "tool"],
  "shortToolName:只處理 mcp. / mcp__ 開頭,其餘(含句點的自由字串)原樣",
);

// ---- 8. 隨機序列的不變量 --------------------------------------------------

console.log("[8] 隨機序列的不變量(固定種子)");
{
  let seed = 20261016;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const builders = [
    (id) => tool(id, pick(["Read", "Bash", "mcp.deskmony.list_sessions", "Guardian Review", "TodoWrite"])),
    (id) => tool(id, pick(["Read", "Bash"])),
    (id) => tool(id, pick(["Read", "Bash"])),
    (id) => tool(id, pick(["question", "AskUserQuestion"])),
    (id) => asst(id, "", true),
    (id) => asst(id, " \n"),
    (id) => asst(id, "回覆"),
    (id) => user(id),
    (id) => sys(id),
  ];

  const isBlank = (i) => i.kind === "assistant" && i.content.trim() === "";
  const isGroupable = (i) => i.kind === "tool" && !isQuestionToolName(i.toolName);
  let violations = [];
  const RUNS = 2000;
  for (let n = 0; n < RUNS; n++) {
    const len = Math.floor(rand() * 14);
    const items = Array.from({ length: len }, (_, i) => pick(builders)(`i${i}`));
    const entries = group(items);

    const flat = entries.flatMap((e) => (e.type === "toolGroup" ? e.items : [e.item]));
    const flatIds = flat.map((i) => i.id);
    const inputIds = items.map((i) => i.id);

    // (a) 輸出是輸入的子序列(順序不變)
    let cursor = 0;
    for (const id of flatIds) {
      const at = inputIds.indexOf(id, cursor);
      if (at === -1) {
        violations.push(`輸出順序與輸入不符:${inputIds} → ${flatIds}`);
        break;
      }
      cursor = at + 1;
    }
    // (b) 被丟掉的只可能是夾在可入組工具之間的空 assistant;其餘每則恰好出現一次
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const appears = flatIds.filter((id) => id === item.id).length;
      if (appears > 1) violations.push(`${item.id} 出現 ${appears} 次:${inputIds}`);
      // 往前找第一個非空訊息、往後找第一個非空訊息:兩端都是可入組工具的空訊息才是「夾在中間」,必須被吸收
      let l = i - 1;
      while (l >= 0 && isBlank(items[l])) l--;
      let r = i + 1;
      while (r < items.length && isBlank(items[r])) r++;
      const sandwiched = isBlank(item) && l >= 0 && r < items.length && isGroupable(items[l]) && isGroupable(items[r]);
      if (appears === 0 && !sandwiched) violations.push(`${item.id} 不該被丟掉:${items.map((x) => x.id + ":" + x.kind)}`);
      if (appears === 1 && sandwiched) violations.push(`${item.id} 夾在工具之間卻沒被吸收:${items.map((x) => x.id + ":" + x.kind)}`);
    }
    // (c) 組至少 2 個、不含提問工具、不含非工具
    for (const e of entries) {
      if (e.type !== "toolGroup") continue;
      if (e.items.length < 2) violations.push(`組少於 2 個:${e.key}`);
      if (e.items.some((i) => i.kind !== "tool" || isQuestionToolName(i.toolName))) violations.push(`組內有不該有的項目:${e.key}`);
    }
    // (d) 該合併的都合併了:相鄰兩個輸出單位不會都是「可入組的工具」
    //     (組本身也算;空 assistant 若夾在中間則表示它在尾端,不屬於可合併的情況)
    for (let i = 0; i + 1 < entries.length; i++) {
      const toolish = (e) => e.type === "toolGroup" || isGroupable(e.item);
      if (toolish(entries[i]) && toolish(entries[i + 1])) violations.push(`該合併卻沒合併:${shape(entries)}`);
    }
    // (e) key 彼此不重複
    const keys = entries.map((e) => e.key);
    if (new Set(keys).size !== keys.length) violations.push(`key 重複:${keys}`);
  }
  check(violations.length === 0, `${RUNS} 組隨機序列:順序/不遺漏/組大小/不含提問工具/該合併都合併/key 唯一${violations.length ? "\n      " + violations.slice(0, 5).join("\n      ") : ""}`);
}

console.log(`\n總結:${passed}/${total}`);
if (passed !== total) process.exit(1);
