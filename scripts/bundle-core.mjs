import { execSync } from "node:child_process";
import { existsSync, rmSync, mkdirSync, cpSync, renameSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rebuild } from "@electron/rebuild";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const bundleDir = path.join(root, "apps", "desktop", "core-bundle");
const desktopElectronPkg = path.join(root, "apps", "desktop", "node_modules", "electron", "package.json");

console.log("[bundle-core] building core...");
execSync("pnpm --filter @deskmony/core build", { cwd: root, stdio: "inherit" });

if (existsSync(bundleDir)) rmSync(bundleDir, { recursive: true });

const tmpDir = bundleDir + "-tmp";
if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true });
mkdirSync(tmpDir, { recursive: true });

console.log("[bundle-core] deploying production dependencies...");
execSync(
  `pnpm deploy --filter @deskmony/core --prod --legacy ` +
  `--config.node-linker=hoisted ` +
  `"${tmpDir}"`,
  { cwd: root, stdio: "inherit" }
);

cpSync(tmpDir, bundleDir, { recursive: true });
rmSync(tmpDir, { recursive: true });

/**
 * ABI fix-up (README「已知限制」→「已解決」,見該章節完整說明):`pnpm deploy`
 * 剛部署出來的 `better-sqlite3` 原生模組是用「系統 Node」的 ABI
 * (NODE_MODULE_VERSION,本機 Node 22 為 127)編譯/下載的 —— 這是
 * `pnpm install` 當下的預設行為,與終端使用者機器上會執行 core 子程序的
 * runtime(打包後由 Electron 內建 Node 以 `ELECTRON_RUN_AS_NODE=1` 執行,見
 * `apps/desktop/electron/main.ts` 的 `startCore()`)ABI 不同(Electron
 * 33.4.11 要求 NODE_MODULE_VERSION 130)。這裡用 `@electron/rebuild`
 * 針對已安裝的 Electron 版本重新編譯/下載一份 ABI 相容的 `better-sqlite3`
 * 原生模組 —— **只動這份獨立部署到 `core-bundle/node_modules` 的副本**,
 * 不會碰到 repo 根目錄或任何 workspace 套件自己的 `node_modules`(那些
 * 給 `pnpm dev:core`/e2e 用,必須維持系統 Node ABI,見下方)。
 *
 * 為什麼只有 `better-sqlite3` 需要重編、`node-pty` 不需要(已實測驗證,
 * 不是臆測):`node-pty` 的原生模組(`packages/adapters` 的間接依賴,經
 * `pnpm deploy --filter @deskmony/core --prod` 一併部署進來,已確認
 * `core-bundle/node_modules/node-pty` 確實存在)是用 `node-addon-api`
 * (N-API)建置的(見其 `binding.gyp` 對 `node-addon-api` 的依賴),N-API
 * 是 ABI 穩定介面,同一份 prebuilt 二進位(`node-pty` 自帶
 * `prebuilds/<platform>-<arch>/*.node`)可以同時被系統 Node 與 Electron
 * 內建 Node 載入而不會 ABI 不符 —— 本機已直接用
 * `ELECTRON_RUN_AS_NODE=1` 借用 Electron 內建 Node 對這份未重編的
 * `node-pty` 執行 `pty.spawn()` 並收發資料驗證成功(見改動當輪的驗證記錄)。
 * `better-sqlite3` 則不是 N-API 建置(未使用 `node-addon-api`),沒有這個
 * ABI 穩定保證,因此才需要這道重編步驟。刻意不對 `node-pty` 執行
 * `electron-rebuild`(即使它也在 `onlyModules` 候選範圍內也不會被要求
 * 重編),避免無謂地要求打包機器一定要有可用的原生編譯工具鏈
 * (`node-gyp`/MSVC)—— `better-sqlite3` 這輪能重編成功,是因為它本身支援
 * 下載官方 prebuilt 二進位(`prebuild-install` 機制),不代表本機一定有
 * MSVC 工具鏈可用。
 */
if (!existsSync(desktopElectronPkg)) {
  throw new Error(
    `[bundle-core] 找不到 ${desktopElectronPkg} —— 需要先在 apps/desktop 安裝 electron 才能決定要對 ` +
      `better-sqlite3 重編哪個 ABI 版本。`,
  );
}
const electronVersion = JSON.parse(readFileSync(desktopElectronPkg, "utf8")).version;
console.log(`[bundle-core] rebuilding better-sqlite3 against Electron ${electronVersion} ABI...`);
const rebuilder = rebuild({
  buildPath: bundleDir,
  electronVersion,
  onlyModules: ["better-sqlite3"],
  force: true,
  arch: process.arch,
  platform: process.platform,
});
rebuilder.lifecycle.on("module-found", (name) => console.log(`[bundle-core]   electron-rebuild: found ${name}`));
rebuilder.lifecycle.on("module-done", (name) => console.log(`[bundle-core]   electron-rebuild: done ${name}`));
await rebuilder;
console.log("[bundle-core] electron-rebuild complete");

// rename node_modules -> _modules to dodge electron-builder's filtering
// (必須在 electron-rebuild 之後才 rename —— @electron/rebuild 靠掃描一個字面
// 叫 node_modules 的目錄找出要重編的原生模組,rename 後就掃不到了)
//
// **已實測驗證 electron-builder 真的會過濾字面叫 node_modules 的 extraResources
// 目錄**(這輪重新驗證,不是延續舊註解假設):暫時停用這段 rename、跑一次
// `pnpm package:dir`,`core-bundle/node_modules` 底下有 139 個項目,複製到
// `release/win-unpacked/resources/core/` 之後這個目錄完全不存在(不是部分過濾,
// 是整個目錄消失)。追到根因:`app-builder-lib` 的 `out/util/filter.js`
// `createFilter()` 有一段寫死的邏輯 `if (relative === "node_modules") return
// false`——這是**依名稱字串比對**的過濾,在複製前的來源樹掃描階段就生效,
// 與該路徑底下實際是不是一個「真正的目錄」無關。因此 rename 這一步是必要的,
// 不能移除。
//
// **重要:junction 不能建在這裡(`core-bundle/` 這個來源目錄)**——同樣已實測
// 驗證過:曾嘗試在這裡的 rename 後,額外建立一個名叫 `node_modules` 的
// junction 指向 `_modules`,結果 `pnpm package:dir` 後
// `release/win-unpacked/resources/core/` 底下仍然沒有 `node_modules`——因為
// 上面那段過濾邏輯是純字串比對 `relative === "node_modules"`,不會區分
// 「這是一個真正的目錄」還是「這是一個 junction/symlink」,一樣被過濾掉。
// ESM 模組解析(見下方)真正需要的 `node_modules` junction 因此改成在
// electron-builder **完成複製之後**才建立——見 `apps/desktop/scripts/after-pack.mjs`
// (透過 `apps/desktop/package.json` 的 `build.afterPack` hook 呼叫,在
// `resources/core/` 這個「輸出」目錄底下建立 junction,不是這個「來源」
// bundle 目錄)。
const nm = path.join(bundleDir, "node_modules");
if (existsSync(nm)) {
  renameSync(nm, path.join(bundleDir, "_modules"));
}

// Remove dev-only artifacts
for (const name of ["src", "apps", "tsconfig.json", "tsconfig.tsbuildinfo"]) {
  const p = path.join(bundleDir, name);
  if (existsSync(p)) rmSync(p, { recursive: true });
}

console.log("[bundle-core] done");
