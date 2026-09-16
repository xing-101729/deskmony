#!/usr/bin/env node
/**
 * scripts/e2e-hard-deny.mjs
 *
 * 2026-09-04(稽核修補):`checkHardDeny()` 四類判定的回歸測試。
 *
 * ---- 為什麼這支必須存在 ------------------------------------------------
 *
 * hard-deny 是整個安全罩的**地板** —— DECISIONS.md §C5/§C6 說它「即使 auto
 * mode 也一律升級」,是使用者放心按下 auto 的唯一理由。它有四個判定面:
 *
 *   1. worktree-escape          (路徑邊界)
 *   2. secret-path              (~/.ssh、~/.aws、~/.deskmony、.env*、id_rsa*、credentials)
 *   3. dangerous-git            (force-push / --delete / branch -D 的 regex)
 *   4. non-allowlisted-network  (host 允許清單)
 *
 * 2026-09-03 的稽核發現:**只有第 1 類有測試**。`e2e-policy-engine.mjs` 每次
 * 都以 `new PolicyEngine({ rules: [], allowedHosts: [] })` 建構,從來沒有餵過
 * `~/.ssh`、`id_rsa`、`--force`,也沒有測過任何真實 host。也就是說第 2/3/4 類
 * ——那些「有實際字串比對與 regex、真的可能寫錯」的邏輯 —— 完全沒有回歸網。
 *
 * 更尖銳的是:hard-deny 的已知弱點(純 regex,擋不住 `bash -c`/base64)恰好
 * 就落在同樣這幾類。會出錯的邏輯與沒有測試的邏輯是同一批。
 *
 * ---- 這支測的是什麼、不是什麼 ------------------------------------------
 *
 * 這是**單元層級**的測試(直接 import 編譯後的 `checkHardDeny`),不啟動 core、
 * 不需要憑證,毫秒級跑完。`e2e-policy-engine.mjs` 測的是「hard-deny 命中之後
 * PolicyEngine 怎麼處理」(降級 escalate-strong、autoMode 下直接 deny 等控制
 * 流程),兩者互補,不重疊。
 *
 * 每一類都同時測「該擋的有擋」與「不該擋的沒誤擋」——只測前者的話,一個
 * 「永遠回傳 matched:true」的實作也會全綠。
 *
 * 用法:node scripts/e2e-hard-deny.mjs
 * 前置需求:pnpm build 已跑過
 */

import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { requireFreshBuild } from "./lib/require-fresh-build.mjs";

requireFreshBuild();

const { checkHardDeny } = await import(
  pathToFileURL(path.resolve("apps/core/dist/permissions/hard-deny.js")).href
);

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
  if (detail) console.log(`       ${detail}`);
}

/** 這個 session 的 worktree 邊界。用一個真實存在的暫存目錄,讓 realpath 解析
 *  走到與正式環境相同的路徑(不是一個不存在的假路徑)。 */
const WORKTREE = path.join(os.tmpdir(), "deskmony-harddeny-ws");
const HOME = os.homedir();

/** @param {{toolName?:string,input:unknown,allowedHosts?:string[]}} o */
const check = (o) =>
  checkHardDeny({
    toolName: o.toolName ?? "Read file",
    input: o.input,
    workingDir: WORKTREE,
    allowedHosts: o.allowedHosts ?? [],
  });

// ===========================================================================
// 第 2 類:secret-path
// ===========================================================================
console.log("\n=== 第 2 類:secret-path(稽核前零覆蓋)===\n");

{
  const cases = [
    ["~/.ssh 底下的私鑰", path.join(HOME, ".ssh", "id_rsa")],
    ["~/.ssh 底下的任意檔(整個目錄樹)", path.join(HOME, ".ssh", "config")],
    ["~/.aws 憑證", path.join(HOME, ".aws", "credentials")],
    ["~/.deskmony(政策設定檔本身,C3 的雙重保護)", path.join(HOME, ".deskmony", "config.json")],
    ["worktree 內的 .env(任何深度都要擋)", path.join(WORKTREE, "app", ".env")],
    [".env.local 這種變體(前綴比對)", path.join(WORKTREE, ".env.local")],
    ["id_rsa.pub(前綴比對)", path.join(WORKTREE, "keys", "id_rsa.pub")],
    ["名為 credentials 的檔案", path.join(WORKTREE, "config", "credentials")],
  ];
  let allMatched = true;
  const missed = [];
  for (const [label, p] of cases) {
    const r = check({ toolName: "Read file", input: { file_path: p } });
    if (!(r.matched && r.category === "secret-path")) {
      allMatched = false;
      missed.push(label);
    }
  }
  record(
    `2a secret-path:${cases.length} 種秘密路徑全部命中(含 ~/.ssh、~/.aws、~/.deskmony 目錄樹,以及 .env*/id_rsa*/credentials 檔名比對)`,
    allMatched,
    allMatched ? `全部 ${cases.length} 種都回傳 category="secret-path"` : `未命中:${missed.join("、")}`,
  );
}

{
  // 大小寫變體 —— 實作用的是 /^\.env/i,所以 .ENV 應該要擋得住。
  const upper = check({ toolName: "Read file", input: { file_path: path.join(WORKTREE, ".ENV") } });
  const idRsaUpper = check({ toolName: "Read file", input: { file_path: path.join(WORKTREE, "ID_RSA") } });
  record(
    "2b secret-path 對檔名大小寫不敏感(.ENV / ID_RSA 一樣擋)",
    upper.matched && idRsaUpper.matched,
    `.ENV=${upper.matched}, ID_RSA=${idRsaUpper.matched}`,
  );
}

{
  // 不該誤擋的對照組 —— 只測「有擋」的話,一個永遠回 true 的實作也會全綠。
  const benign = [
    ["一般原始碼檔", path.join(WORKTREE, "src", "index.ts")],
    ["檔名只是包含 env 但不是 .env 開頭", path.join(WORKTREE, "environment.ts")],
    ["目錄名含 credentials 但檔名不是", path.join(WORKTREE, "credentials-doc", "readme.md")],
  ];
  const wrongly = benign.filter(([, p]) => check({ toolName: "Read file", input: { file_path: p } }).matched);
  record(
    "2c secret-path 不誤擋:一般檔案、environment.ts、credentials-doc/readme.md 都不命中",
    wrongly.length === 0,
    wrongly.length === 0 ? "三個對照組皆未命中(正確)" : `被誤擋:${wrongly.map(([l]) => l).join("、")}`,
  );
}

// ===========================================================================
// 第 3 類:dangerous-git
// ===========================================================================
console.log("\n=== 第 3 類:dangerous-git(稽核前零覆蓋)===\n");

{
  const cases = [
    ["git push --force", "git push --force origin main"],
    ["git push -f(短旗標)", "git push -f origin main"],
    ["git push --delete(刪遠端分支)", "git push origin --delete feature/x"],
    ["git branch -D(強制刪分支)", "git branch -D feature/x"],
    ["藏在複合指令裡(regex 刻意不錨定)", "cd /tmp && git push --force origin main"],
    ["大小寫變體", "GIT PUSH --FORCE origin main"],
    ["多餘空白", "git   push   --force   origin"],
  ];
  const missed = cases.filter(([, cmd]) => {
    const r = check({ toolName: "Bash", input: { command: cmd } });
    return !(r.matched && r.category === "dangerous-git");
  });
  record(
    `3a dangerous-git:${cases.length} 種寫法全部命中(含複合指令、大小寫、多餘空白)`,
    missed.length === 0,
    missed.length === 0 ? `全部 ${cases.length} 種都回傳 category="dangerous-git"` : `未命中:${missed.map(([l]) => l).join("、")}`,
  );
}

{
  const benign = [
    ["一般 push", "git push origin main"],
    ["一般 branch 列表", "git branch -a"],
    ["小寫 -d(非強制刪除)", "git branch -d merged-branch"],
    ["force 出現在不相干的地方", "echo '--force' > notes.txt"],
  ];
  const wrongly = benign.filter(([, cmd]) => check({ toolName: "Bash", input: { command: cmd } }).matched);
  record(
    "3b dangerous-git 不誤擋:一般 push/branch -a/branch -d(小寫)/字串裡的 --force 都不命中",
    wrongly.length === 0,
    wrongly.length === 0 ? "四個對照組皆未命中(正確)" : `被誤擋:${wrongly.map(([l]) => l).join("、")}`,
  );
}

{
  /**
   * 誠實記錄已知弱點 —— 這條斷言**期待 matched === false**。
   *
   * 這不是在測「功能正常」,是把 DECISIONS.md §C7 明講的限制(「不做 shell 指令
   * 攔截,被 `bash -c`/`$()`/base64 秒破,是 security theater」)釘成一條會執行的
   * 事實。如果哪天有人加了真正的 shell 語意解析讓它擋住了,這條會失敗 ——
   * 那正是提醒:文件與 SECURITY.md 的「已知限制」該一起更新。
   */
  const evasions = [
    ["base64 包裝", "bash -c \"$(echo Z2l0IHB1c2ggLS1mb3JjZQ== | base64 -d)\""],
    ["變數拼接", "F=--force; git push $F origin main"],
  ];
  const stillUnmatched = evasions.every(([, cmd]) => !check({ toolName: "Bash", input: { command: cmd } }).matched);
  record(
    "3c 【已知限制,刻意斷言擋不住】base64 與變數拼接可繞過 dangerous-git regex —— 見 DECISIONS.md §C7:不做 shell 指令攔截是刻意決定。這條若失敗代表行為改變了,文件要一起更新",
    stillUnmatched,
    stillUnmatched ? "兩種繞過皆未被 regex 命中(與文件宣稱一致)" : "有繞過方式被擋住了 —— 行為已改變,請更新 DECISIONS.md §C7 與 SECURITY.md",
  );
}

// ===========================================================================
// 第 4 類:non-allowlisted-network
// ===========================================================================
console.log("\n=== 第 4 類:non-allowlisted-network(稽核前零覆蓋)===\n");

{
  const r1 = check({ toolName: "WebFetch", input: { url: "https://evil.example.com/x" }, allowedHosts: [] });
  const r2 = check({ toolName: "WebFetch", input: { host: "evil.example.com" }, allowedHosts: [] });
  record(
    "4a allowedHosts 為空(預設)時,任何猜得到 host 的外連都擋 —— url 與 host 兩種欄位皆然",
    r1.matched && r1.category === "non-allowlisted-network" && r2.matched && r2.category === "non-allowlisted-network",
    `url 欄位=${r1.category}, host 欄位=${r2.category}`,
  );
}

{
  const allowed = check({ toolName: "WebFetch", input: { url: "https://api.example.com/v1" }, allowedHosts: ["api.example.com"] });
  const allowedCase = check({ toolName: "WebFetch", input: { url: "https://API.EXAMPLE.COM/v1" }, allowedHosts: ["api.example.com"] });
  const notAllowed = check({ toolName: "WebFetch", input: { url: "https://other.example.com" }, allowedHosts: ["api.example.com"] });
  record(
    "4b 白名單內的 host 放行(且大小寫不敏感),清單外的仍擋",
    !allowed.matched && !allowedCase.matched && notAllowed.matched,
    `白名單內=${allowed.matched}, 大小寫變體=${allowedCase.matched}, 清單外=${notAllowed.matched}`,
  );
}

{
  /**
   * 子網域**不**繼承父網域的授權 —— 這是安全相關的邊界,值得釘住:
   * `allowedHosts: ["example.com"]` 不應該連帶放行 `evil.example.com`。
   * 實作是完整字串比對,所以應該要擋。
   */
  const sub = check({ toolName: "WebFetch", input: { url: "https://evil.example.com" }, allowedHosts: ["example.com"] });
  record(
    "4c 子網域不繼承授權:allowedHosts=[example.com] 不放行 evil.example.com",
    sub.matched,
    `matched=${sub.matched}(完整字串比對,不是後綴比對)`,
  );
}

{
  // 猜不到 host 時必須是「不 matched」而不是「放行」—— fail-safe 方向:
  // 落到 PolicyEngine 的 default-deny 兜底,不是靜默通過。
  const unparseable = check({ toolName: "WebFetch", input: { url: "not a url at all" }, allowedHosts: [] });
  const noHostField = check({ toolName: "Read file", input: { file_path: path.join(WORKTREE, "a.txt") }, allowedHosts: [] });
  record(
    "4d 猜不到 host 時回 matched:false(交給 default-deny 兜底),不是當成已核可",
    !unparseable.matched && !noHostField.matched,
    `無法解析的 url=${unparseable.matched}, 完全沒有 host 欄位=${noHostField.matched}`,
  );
}

// ===========================================================================
// 第 1 類:worktree-escape(既有已有覆蓋,這裡補單元層級的邊界案例)
// ===========================================================================
console.log("\n=== 第 1 類:worktree-escape(補邊界案例)===\n");

{
  const escape = check({ toolName: "Write file", input: { file_path: path.join(os.tmpdir(), "outside.txt") } });
  const dotdot = check({ toolName: "Write file", input: { file_path: path.join(WORKTREE, "..", "outside.txt") } });
  const inside = check({ toolName: "Write file", input: { file_path: path.join(WORKTREE, "src", "ok.ts") } });
  record(
    "1a worktree-escape:worktree 外的絕對路徑與 `..` 相對逃逸都擋,worktree 內放行",
    escape.matched && dotdot.matched && !inside.matched,
    `絕對路徑外=${escape.matched}, ..逃逸=${dotdot.matched}, worktree 內=${inside.matched}`,
  );
}

{
  // 非 mutating 工具讀 worktree 外的檔案不算 worktree-escape(第 1 類只管
  // 寫入/刪除)—— 但如果那是秘密路徑,會落到第 2 類。這條釘住兩類的分工。
  const readOutside = check({ toolName: "Read file", input: { file_path: path.join(os.tmpdir(), "harmless.txt") } });
  const readSecret = check({ toolName: "Read file", input: { file_path: path.join(HOME, ".ssh", "id_rsa") } });
  record(
    "1b 第1類只管 mutating 工具:唯讀工具讀 worktree 外的無害檔案不算 escape,但讀秘密路徑仍會被第2類擋下",
    !readOutside.matched && readSecret.matched && readSecret.category === "secret-path",
    `唯讀+worktree外無害檔=${readOutside.matched}, 唯讀+秘密路徑=${readSecret.category}`,
  );
}

// ===========================================================================
// CSWSH:WebSocket 升級的 Origin 同源檢查(2026-09-04 稽核修補)
// ===========================================================================
console.log("\n=== CSWSH 防護:verifySameOrigin()(稽核前完全不存在)===\n");

{
  const { verifySameOrigin } = await import(
    pathToFileURL(path.resolve("apps/core/dist/gateway/ws-gateway.js")).href
  );
  // 第二參數 = 是否啟用 token 認證,只影響不透明來源(null / file://)。
  const call = (origin, host, authEnabled = false) =>
    verifySameOrigin({ origin, req: { headers: { origin, host } } }, authEnabled);

  // 非瀏覽器 client(手機 app、e2e 腳本、任何 ws 函式庫)不送 Origin —— 必須
  // 放行,否則等於把所有正常用法一起擋死。
  const noOrigin = verifySameOrigin({ req: { headers: { host: "127.0.0.1:4321" } } }, false);

  // 由這個 server 自己服務出去的瀏覽器 UI:Origin 必然等於 Host。
  const sameLocal = call("http://127.0.0.1:4321", "127.0.0.1:4321");
  const sameLan = call("http://192.168.1.5:4321", "192.168.1.5:4321");

  // 惡意網站:Origin 是它自己的網域,對不上 Host。
  const evil = call("https://evil.example.com", "127.0.0.1:4321");
  // 同主機但不同 port 也算跨源(另一個本機服務也可能被入侵)。
  const otherPort = call("http://127.0.0.1:9999", "127.0.0.1:4321");
  // 畸形 Origin 不能被當成「沒有 Origin」放行。
  const malformed = call("not-a-url", "127.0.0.1:4321");

  record(
    "CSWSH-1: 沒有 Origin 的非瀏覽器 client 放行;同源的瀏覽器 UI(本機與區網位址)放行",
    noOrigin === true && sameLocal === true && sameLan === true,
    `noOrigin=${noOrigin}, 127.0.0.1 同源=${sameLocal}, 區網同源=${sameLan}`,
  );
  record(
    "CSWSH-2: 【關鍵】惡意網域、不同 port、畸形 Origin 一律在升級階段就拒絕 —— 這是 token 之外的第二層,單機模式(未設 DESKMONY_AUTH_TOKEN)下是唯一擋得住「開個網頁就被接管」的防線",
    evil === false && otherPort === false && malformed === false,
    `evil.example.com=${evil}, 不同port=${otherPort}, 畸形Origin=${malformed}`,
  );

  /**
   * 不透明來源(`file://` / `null`)—— 這條的存在理由很具體:**打包後的桌面殼
   * 就是 `file://`**(main.ts 用 loadFile()),renderer 用瀏覽器原生 WebSocket
   * 會送出這種 Origin。第一版的同源檢查會把 app 自己擋在門外,整個桌面版連不上。
   *
   * 但不能無條件放行:惡意網站用 `<iframe sandbox="allow-scripts">` 也能造出
   * origin 為 `null` 的執行環境。分界點是有沒有啟用 token 認證 —— 打包後的殼
   * 一定有(resolveAuthToken() 保證),sandboxed iframe 拿不到 token。
   */
  const fileWithAuth = call("file://", "127.0.0.1:4321", true);
  const nullWithAuth = call("null", "127.0.0.1:4321", true);
  const fileNoAuth = call("file://", "127.0.0.1:4321", false);
  const nullNoAuth = call("null", "127.0.0.1:4321", false);
  record(
    "CSWSH-3: 【避免把 app 自己擋在門外】打包後桌面殼的 file:// / null origin,在已啟用 token 認證時放行;未啟用認證時(sandboxed iframe 的攻擊情境)拒絕",
    fileWithAuth === true && nullWithAuth === true && fileNoAuth === false && nullNoAuth === false,
    `有token: file://=${fileWithAuth}, null=${nullWithAuth};無token: file://=${fileNoAuth}, null=${nullNoAuth}`,
  );

  // dev 模式:renderer 從 Vite dev server(http://localhost:5173)載入,core 在
  // 另一個 port —— 同樣不同源。這是本 app 的第二種正常來源,不能擋。
  const devWithAuth = call("http://localhost:5173", "127.0.0.1:4321", true);
  const devNoAuth = call("http://localhost:5173", "127.0.0.1:4321", false);
  // 但「本機來源」的放行不能擴大到外部網域,即使有 token 也一樣(縱深防禦)。
  const evilWithAuth = call("https://evil.example.com", "127.0.0.1:4321", true);
  record(
    "CSWSH-4: 【避免把 dev 模式擋在門外】Vite dev server(http://localhost:5173)在有 token 時放行、無 token 時拒絕;外部網域即使有 token 也一律拒絕(縱深防禦)",
    devWithAuth === true && devNoAuth === false && evilWithAuth === false,
    `dev 有token=${devWithAuth}, dev 無token=${devNoAuth}, 外部網域即使有token=${evilWithAuth}`,
  );
}

// ===========================================================================
const failed = results.filter((r) => !r.ok);
console.log(`\n========== 總結:${results.length - failed.length}/${results.length} 通過 ==========`);
if (failed.length > 0) {
  for (const f of failed) console.log(`  FAIL: ${f.name}`);
}
process.exit(failed.length > 0 ? 1 : 0);
