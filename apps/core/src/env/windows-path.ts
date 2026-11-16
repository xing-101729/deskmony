/**
 * windows-path.ts(2026-11-16):core 啟動時把 PATH 裡沒展開的 `%VAR%` 展開。
 *
 * ---- 為什麼需要 ----
 *
 * 系統層級的 `Path`(HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment)正常是
 * `REG_EXPAND_SZ`,Explorer 建環境區塊時會把 `%SystemRoot%\system32` 這類參照展開。若它被某個安裝程式/工具
 * 寫成 `REG_SZ`,Explorer 就照字面放進 PATH——從開始功能表/工作列啟動的 Deskmony(以及它帶起來的 core)PATH 上
 * **沒有真正的 System32**。實際後果(真機回報):agent 偵測用 `execFile("where", …)` 直接 ENOENT,
 * Claude Code CLI / OpenCode / Gemini / Aider 全部顯示「未偵測到」;同一台機器從終端機啟動卻一切正常
 * (終端機的 PATH 是別的程式組出來的),很難從使用者端看出原因。
 *
 * 所以在 core 任何 spawn 之前修好自己的 `process.env` 的 PATH:之後的偵測(`where`)、agent 子程序
 * (`buildAgentChildEnv()` 從 `process.env` 出發)全部自然繼承修好的值,不需要逐一改呼叫點。
 *
 * ---- 展開規則(比照 Win32 `ExpandEnvironmentStrings`)----
 *
 * - `%NAME%` 且 NAME 有定義(名稱不分大小寫)→ 換成它的值(定義成空字串就換成空字串)。
 * - NAME 沒定義 → 原樣保留 `%NAME%`(Windows 本身也是這樣,不臆測)。
 * - 只展開一層:值裡面若又含 `%X%` 不再遞迴(同 Windows;也避免自我參照無窮展開)。
 * - 名稱不得含 `;`(PATH 分隔字元)或 `=`,避免把跨兩個項目的 `%…%` 誤當成一個參照。
 */

const ENV_REFERENCE = /%([^%;=]+)%/g;

/** 依 Windows 慣例不分大小寫查環境變數(`process.env` 在 Windows 上本身就不分大小寫,一般物件則不然)。 */
function lookupEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const direct = env[name];
  if (direct !== undefined) return direct;
  const lower = name.toLowerCase();
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === lower) return env[key];
  }
  return undefined;
}

/** 把 `value` 裡有定義的 `%NAME%` 換成值,其餘原樣保留(規則見檔案頂端)。 */
export function expandWindowsEnvReferences(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(ENV_REFERENCE, (match, name: string) => lookupEnv(env, name) ?? match);
}

export interface WindowsPathRepair {
  /** 環境物件裡實際的鍵名(Explorer 帶起來的程序通常是 `Path`)。 */
  key: string;
  before: string;
  after: string;
}

/**
 * Windows 上展開 `env` 的 PATH 裡沒展開的 `%VAR%`,**就地**改寫 `env`;有改才回傳改了什麼(供啟動時印一行說明),
 * 非 Windows、沒有 PATH、或沒有可展開的參照時回傳 undefined、完全不動 `env`。
 */
export function repairWindowsPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): WindowsPathRepair | undefined {
  if (platform !== "win32") return undefined;
  const key = Object.keys(env).find((k) => k.toLowerCase() === "path");
  if (key === undefined) return undefined;
  const before = env[key];
  if (!before || !before.includes("%")) return undefined;
  const after = expandWindowsEnvReferences(before, env);
  if (after === before) return undefined;
  env[key] = after;
  return { key, before, after };
}
