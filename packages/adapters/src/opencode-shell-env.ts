/**
 * opencode-shell-env.ts(2026-10-05,安全):掛載 Deskmony 自帶的 opencode 外掛(opencode-shell-env-plugin.ts)所需的啟動資訊,
 * 以及「這個外掛有沒有真的被 opencode 載入」的偵測。兩種 opencode 對接(`OpenCodeAdapter` 的 HTTP、`AcpAdapter` 的 `opencode acp`)共用。
 *
 * 為什麼需要這個外掛、機制與實測依據,見 opencode-shell-env-plugin.ts 檔頭。
 */

import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";

/** `OPENCODE_CONFIG_CONTENT` 的 `plugin` 陣列裡的一個元素:`[file:// URL, 選項]` 元組(實測 1.18.7 支援,選項會傳給外掛工廠)。 */
export type OpencodePluginEntry = readonly [string, { readonly loadedMarkerFile: string }];

export interface OpencodeShellEnvPluginLaunch {
  /** 要放進設定 `plugin` 陣列的元素。 */
  entry: OpencodePluginEntry;
  /** 外掛載入時會寫的標記檔(給 `watchOpencodeShellEnvPluginLoaded()` 偵測)。 */
  markerFile: string;
}

/**
 * 算出 `opencode-shell-env-plugin.ts` 編譯後的路徑——與 `resolveMcpBridgeServerEntry()` 同一套做法(見 mcp-bridge-launch.ts):
 * `tsc` 把 `src/` 底下每個檔案原樣編譯成 `dist/` 底下同名的 `.js`,所以外掛永遠跟這個檔案編譯後的 `opencode-shell-env.js` 在**同一個目錄**
 * ——開發(`packages/adapters/dist`)、`pnpm deploy` 出來的 core-bundle(`_modules/@deskmony/adapters/dist`)、打包後的
 * `resources/core/node_modules/@deskmony/adapters/dist` 都成立。這是真實檔案(不在 asar 裡):opencode 是另一個行程,要自己從磁碟讀它。
 */
export function resolveOpencodeShellEnvPluginEntry(): string {
  const thisFile = fileURLToPath(import.meta.url);
  return path.join(path.dirname(thisFile), "opencode-shell-env-plugin.js");
}

/**
 * 算出這個 opencode 子行程要載入的外掛。回傳 `undefined` = 不掛載(找不到編譯後的外掛檔,理論上不該發生;**優雅降級**:印警告、
 * session 照常啟動——只是 agent 的 bash 環境不會被濾,與這個外掛出現之前的行為相同,不能因此讓 session 起不來)。
 *
 * 路徑一律用 `pathToFileURL()` 轉成 `file://` URL(含空白、中文的路徑會被百分比編碼,實測 opencode 1.18.7 正確解開)。
 * 標記檔放在系統暫存目錄,名稱帶隨機值(不可預測、不同 session 不互撞);只是一個「我被載入了」的旗標,不含任何秘密。
 */
export function prepareOpencodeShellEnvPlugin(logLabel: string, sessionId: string): OpencodeShellEnvPluginLaunch | undefined {
  const pluginPath = resolveOpencodeShellEnvPluginEntry();
  if (!existsSync(pluginPath)) {
    console.warn(
      `[${logLabel}] session ${sessionId}: 找不到 opencode-shell-env-plugin.js(${pluginPath}),略過掛載 opencode 外掛——` +
        "agent 的 bash 工具環境不會被濾掉 opencode 伺服器密碼與設定內容。請確認 packages/adapters 已執行過 pnpm build。",
    );
    return undefined;
  }
  const markerFile = path.join(tmpdir(), `deskmony-opencode-shell-env-${randomBytes(12).toString("hex")}.loaded`);
  return { entry: [pathToFileURL(pluginPath).href, { loadedMarkerFile: markerFile }], markerFile };
}

/**
 * 等外掛的載入標記檔出現。出現 = `shell.env` hook 已掛上(回傳 `true`,並把標記檔刪掉);等到逾時都沒出現 = 外掛沒被載入
 * (opencode 版本太舊不認、載入時丟例外、設定被後面的來源蓋掉……),`console.warn` 並回傳 `false`——**永遠不丟錯**,
 * session 不受影響(外掛是加固,不是 session 能不能建立的前提)。呼叫端用 `void` 在背景跑,不要 await 它擋住 session 建立。
 *
 * opencode 對一個資料夾的 instance(含外掛初始化)是在第一個請求(HTTP:`GET /command`、`POST /session`;ACP:`session/new`)進來時才建立,
 * 所以要在那之後呼叫;預設最多等 10 秒(實測正常情況下是即時的)。
 */
export async function watchOpencodeShellEnvPluginLoaded(
  launch: OpencodeShellEnvPluginLaunch,
  logLabel: string,
  sessionId: string,
  { timeoutMs = 10_000, pollMs = 100, isCancelled }: { timeoutMs?: number; pollMs?: number; isCancelled?: () => boolean } = {},
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isCancelled?.()) {
      removeMarker(launch.markerFile);
      return false;
    }
    if (existsSync(launch.markerFile)) {
      removeMarker(launch.markerFile);
      return true;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, pollMs).unref?.());
  }
  removeMarker(launch.markerFile);
  console.warn(
    `[${logLabel}] session ${sessionId}: opencode 沒有載入 Deskmony 的外掛(等了 ${timeoutMs}ms 都沒看到載入標記)——` +
      "agent 的 bash 工具環境可能仍拿得到 opencode 伺服器密碼與設定內容(OPENCODE_SERVER_PASSWORD/OPENCODE_CONFIG_CONTENT)。" +
      "session 照常運作;請確認 opencode 版本支援 `shell.env` 外掛 hook(Deskmony 以 1.18.7 驗證過)。",
  );
  return false;
}

/** session 建立失敗等「不會再去看標記檔」的情況:把標記檔清掉(外掛若已載入過它可能存在)。 */
export function discardOpencodeShellEnvPluginMarker(launch: OpencodeShellEnvPluginLaunch | undefined): void {
  if (launch) removeMarker(launch.markerFile);
}

function removeMarker(markerFile: string): void {
  try {
    rmSync(markerFile, { force: true });
  } catch {
    // ignore
  }
}
