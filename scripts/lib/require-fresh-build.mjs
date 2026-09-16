/**
 * scripts/lib/require-fresh-build.mjs
 *
 * 2026-09-04(稽核修補):e2e 前置檢查——`dist/` 是否比 `src/` 新。
 *
 * ---- 為什麼需要這個 ----------------------------------------------------
 *
 * 每一支 e2e 都是啟動 `apps/core/dist/index.js`(編譯產物)來測,而在此之前
 * 所有前置檢查都只有 `existsSync(CORE_ENTRY)` ——只確認「檔案在不在」,
 * 完全不檢查「是不是這次修改之後編出來的」。
 *
 * 後果是一種比「斷言寫錯」更隱蔽的假通過:斷言本身完全正確,只是驗證的目標物
 * 是上一次 build 的舊程式碼。改了 `policy-engine.ts` 卻忘記先 `pnpm build`,
 * 整套測試會安靜地跑完舊邏輯並全綠。在一個**沒有 CI、build 不會自動發生**的
 * 專案裡,這不是理論風險,而是預設的失敗模式——事實上做這輪修補時就真的踩到
 * 一次(改了 `packages/shared/src/errors.ts` 後 typecheck 直接報「屬性不存在」,
 * 因為 `apps/core` 讀的是 `packages/shared/dist` 的舊 `.d.ts`)。
 *
 * ---- 判斷方式 ----------------------------------------------------------
 *
 * 比對「所有受監看 package 的 src/ 底下最新檔案 mtime」與「對應 dist/ 進入點
 * 的 mtime」。只要有任何一個 src 檔比它的 dist 新,就直接中止並印出該怎麼修。
 *
 * 刻意用 mtime 而不是 hash:hash 要遞迴讀完整棵樹,對每次跑 e2e 都要付這個
 * 成本不划算;mtime 對「忘記 build」這個唯一要防的情境已經足夠精準。已知的
 * 誤判方向只有一種——`git checkout` 會更新 mtime 但內容可能沒變,那會多叫你
 * build 一次,是**保守**的方向,不會放過真正的過期產物。
 *
 * 用法(放在每支 e2e 啟動 core 之前):
 *   import { requireFreshBuild } from "./lib/require-fresh-build.mjs";
 *   requireFreshBuild();
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

/**
 * 受監看的 package:`src` 是來源目錄,`dist` 是編譯輸出目錄,`entry` 是「有沒有
 * 建置過」的存在性哨兵。
 *
 * **比對的是兩個目錄各自最新的檔案 mtime,不是拿 `entry` 當哨兵** —— 這點踩過
 * 一次:`tsc` 不會重寫內容沒變的輸出檔,所以只改了 `errors.ts` 時
 * `dist/index.js`(純 re-export,內容不變)的 mtime 完全不動,拿它當代表會把
 * 剛建好的 package 誤判成過期。
 *
 * 只列 e2e 真正會載入的那幾個(core 與它的三個 workspace 依賴)——`apps/desktop`
 * 不在其中:e2e 從來不啟動 Electron/Vite 產物(唯一的例外 `package-smoke.mjs`
 * 有它自己的完整打包流程),把它加進來只會逼所有人多跑一次不相干的 vite build。
 */
const WATCHED = [
  { name: "@deskmony/shared", root: "packages/shared", entry: "packages/shared/dist/index.js" },
  { name: "@deskmony/db", root: "packages/db", entry: "packages/db/dist/index.js" },
  { name: "@deskmony/adapters", root: "packages/adapters", entry: "packages/adapters/dist/index.js" },
  { name: "@deskmony/core", root: "apps/core", entry: "apps/core/dist/index.js" },
];

/** 遞迴找出目錄底下最新的檔案 mtime(毫秒);目錄不存在回傳 0。 */
function newestMtimeMs(dir) {
  if (!existsSync(dir)) return 0;
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestMtimeMs(full));
    } else {
      newest = Math.max(newest, statSync(full).mtimeMs);
    }
  }
  return newest;
}

/**
 * 這個 package「上次建置」的時間點。
 *
 * 取 `dist/` 最新檔案與 `tsconfig.tsbuildinfo` 兩者的較大值 —— **兩個都要看**:
 *   - 一般情況 `dist/` 會被重寫,它的 mtime 就是答案。
 *   - 但 `tsc` 是增量的、看**內容**不看 mtime:`touch` 過一個 src 檔(或
 *     `git checkout` 造成 mtime 更新但內容相同)時,tsc 會判定無需 emit,
 *     `dist/` 一個位元組都不動。只看 dist 的話,這個 package 會被永久判定成
 *     過期,而且**照著錯誤訊息去跑 `pnpm build` 也清不掉** —— 那不是保守,
 *     是壞掉。`tsconfig.tsbuildinfo` 則是每次 tsc 實際跑完都會更新,正確代表
 *     「編譯器確認過這份 src 了」。
 */
function lastBuiltAtMs(pkgRoot) {
  const distNewest = newestMtimeMs(path.join(REPO_ROOT, pkgRoot, "dist"));
  const tsbuildinfo = path.join(REPO_ROOT, pkgRoot, "tsconfig.tsbuildinfo");
  const tsbuildinfoMtime = existsSync(tsbuildinfo) ? statSync(tsbuildinfo).mtimeMs : 0;
  return Math.max(distNewest, tsbuildinfoMtime);
}

/**
 * 檢查所有受監看 package 的建置產物是否都不比 src 舊。
 *
 * @param {{ exitOnStale?: boolean }} [options]
 *   `exitOnStale` 預設 true(直接 `process.exit(1)`,這是 e2e 想要的行為)。
 *   傳 false 則只回傳結果,給想自己決定怎麼處理的呼叫端(例如測試這支工具本身)。
 * @returns {{ ok: boolean, missing: string[], stale: string[] }}
 */
export function requireFreshBuild(options = {}) {
  const { exitOnStale = true } = options;
  const missing = [];
  const stale = [];

  for (const pkg of WATCHED) {
    const entryPath = path.join(REPO_ROOT, pkg.entry);
    if (!existsSync(entryPath)) {
      missing.push(pkg.name);
      continue;
    }
    const srcNewest = newestMtimeMs(path.join(REPO_ROOT, pkg.root, "src"));
    const builtAt = lastBuiltAtMs(pkg.root);
    if (srcNewest > builtAt) {
      stale.push(`${pkg.name}(src 比上次建置新 ${Math.round((srcNewest - builtAt) / 1000)} 秒)`);
    }
  }

  const ok = missing.length === 0 && stale.length === 0;
  if (!ok && exitOnStale) {
    console.error("\n========================================");
    console.error("  建置產物檢查失敗 —— 測試已中止");
    console.error("========================================");
    if (missing.length > 0) {
      console.error(`\n  尚未建置:${missing.join(", ")}`);
    }
    if (stale.length > 0) {
      console.error(`\n  產物已過期:\n    - ${stale.join("\n    - ")}`);
      console.error(
        "\n  e2e 測的是 dist/ 而不是 src/。若帶著過期產物繼續跑,測試會安靜地\n" +
          "  驗證舊程式碼並全綠 —— 那比直接失敗更糟,所以這裡直接擋下。",
      );
    }
    console.error("\n  請先執行:\n    pnpm build\n");
    process.exit(1);
  }

  return { ok, missing, stale };
}
