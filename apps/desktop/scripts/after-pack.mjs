/**
 * electron-builder `afterPack` hook(見 `apps/desktop/package.json` 的
 * `build.afterPack`)。
 *
 * 背景(完整根因見 `scripts/bundle-core.mjs` 內對 `node_modules` rename 那段
 * 的註解):`scripts/bundle-core.mjs` 把部署好的 core 依賴目錄從
 * `node_modules` 改名成 `_modules`,躲過 electron-builder 內建、依名稱字串比對
 * 的過濾邏輯(`app-builder-lib` 的 `filter.js`:`relative === "node_modules"`
 * 就整個排除,不論是普通目錄還是 junction/symlink 都一樣被排除——已實測驗證
 * 過,見 `bundle-core.mjs` 的註解)。
 *
 * 但 `apps/core/package.json` 是 `"type": "module"`(ESM),`apps/core/dist/index.js`
 * 用 `import "@deskmony/adapters"` 這種 ESM import。Node 的模組解析演算法
 * (不論 CJS `require()` 或 ESM `import`)都是沿著目錄樹往上找一個**字面上
 * 叫做 `node_modules`** 的資料夾;改名成 `_modules` 後,不論哪種模組系統都
 * 解析不到依賴。`apps/desktop/electron/main.ts` 過去用 `env.NODE_PATH` 指向
 * `_modules` 試圖補這個洞,但 `NODE_PATH` 只有 CJS `require()` 會查、ESM
 * resolver 完全不看(Node.js 官方文件明載),對這個 ESM 專案從一開始就沒有
 * 任何效果,是死程式碼(已從 `main.ts` 移除)。
 *
 * 真正的修法:在 electron-builder **已經把 `core-bundle/` 複製成
 * `resources/core/` 之後**(這個 hook 執行的時間點——`afterPack` 保證在
 * `extraResources` 複製完成後才觸發),在這個「輸出」目錄底下另外建立一個
 * 名叫 `node_modules` 的 Windows 目錄 junction 指向同一層的 `_modules`。
 * 這個時間點之後 electron-builder 不會再對 `resources/core/` 底下的內容做
 * 任何名稱過濾,junction 可以安全地留在最終產物裡:
 *   - 執行期 Node 的模組解析器沿著目錄樹往上找,在 `dist/` 的上一層看到一個
 *     叫 `node_modules` 的目錄(對 `fs` 層級的目錄操作,junction 與真正的
 *     目錄完全透明,無法區分),於是能正確解析 `@deskmony/adapters` 等
 *     依賴,不論是 CJS `require()` 還是 ESM `import`。
 *   - Windows 上用 `fs.symlinkSync(target, linkPath, "junction")` 建立目錄
 *     junction **不需要系統管理員權限**(這點與建立一般 symlink 不同——一般
 *     symlink 預設需要系統管理員權限或先開啟「開發人員模式」;junction 是
 *     NTFS 原生機制,任何使用者都能建立,不受這個限制)——已在本機以一般
 *     使用者權限實測建立成功(`pnpm package:dir` 全程沒有任何權限錯誤或
 *     UAC 提示)。
 *
 * 只在 Windows 目標時執行(這個專案目前只支援 Windows 打包,見
 * `scripts/package-smoke.mjs` 檔案頂端說明與 README「已知限制」)。
 *
 * @param {import("electron-builder").AfterPackContext} context
 */
export default async function afterPack(context) {
  if (context.electronPlatformName !== "win32") {
    return;
  }

  const { existsSync, symlinkSync } = await import("node:fs");
  const path = await import("node:path");

  const coreResourcesDir = path.join(context.appOutDir, "resources", "core");
  const modulesDir = path.join(coreResourcesDir, "_modules");
  const junctionPath = path.join(coreResourcesDir, "node_modules");

  if (!existsSync(modulesDir)) {
    throw new Error(
      `[after-pack] 找不到 ${modulesDir} —— extraResources 複製似乎沒有把 _modules 帶過來,` +
        `檢查 apps/desktop/package.json 的 extraResources 設定與 scripts/bundle-core.mjs 的 rename 步驟。`,
    );
  }
  if (existsSync(junctionPath)) {
    // 理論上不該發生(每次 package:dir 都是全新的 win-unpacked),但若重跑時
    // 前一輪殘留了同名項目,保守起見直接報錯而不是靜默覆蓋。
    throw new Error(`[after-pack] ${junctionPath} 已存在,拒絕覆蓋——請先清理 release/ 目錄再重跑。`);
  }

  symlinkSync("_modules", junctionPath, "junction");
  console.log(`[after-pack] created node_modules junction -> _modules at ${junctionPath}`);
}
