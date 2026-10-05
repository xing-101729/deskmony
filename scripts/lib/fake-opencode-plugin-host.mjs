/**
 * scripts/lib/fake-opencode-plugin-host.mjs
 *
 * 2026-10-05(安全):fake opencode(HTTP 的 fake-opencode-server.mjs、ACP 的 fake-acp-agent.mjs 扮演 `opencode acp` 時)用的
 * 「opencode 外掛宿主」模擬——讓 e2e 能**決定性地**驗證 Deskmony 自帶的 opencode 外掛(packages/adapters/src/opencode-shell-env-plugin.ts)
 * 真的會被 `OPENCODE_CONFIG_CONTENT` 的 `plugin` 陣列載入、而且它的 `shell.env` hook 真的把伺服器密碼與設定內容從 shell 環境移除。
 *
 * 模擬的是 2026-10-05 對真實 opencode 1.18.7 **實測**出來的行為(不是讀文件猜的;真實 opencode 的整合另外用 `opencode/big-pickle`
 * 實測過,見提交說明與 docs/DECISIONS.md §J):
 *   - `plugin` 陣列的元素是字串(spec)或 `[spec, options]` 元組;`file://` URL 直接 `import()`。(使用者的 npm 外掛 `user-plugin` 之類
 *     這裡不載入——fake 沒有 npm。)
 *   - 模組裡**每一個**函式匯出都被當成外掛工廠呼叫:`factory(ctx, options)`,回傳 hooks 物件。(實測:多匯出的 helper 函式也被呼叫了。)
 *   - `shell.env` hook:`hook({ cwd, sessionID?, callID? }, output)`,`output = { env: {} }`;子 shell 的環境是 `{ ...process.env, ...output.env }`,
 *     值為 `undefined` 的鍵在 Node 的 spawn 裡被略過(= 真的移除)。
 *
 * 這支只被 fake 後端(當成獨立程序跑的 isMainModule 情境)使用,不會被 e2e 腳本本身 import。
 */

/**
 * 載入 `rawConfig`(`OPENCODE_CONFIG_CONTENT` 的原始字串)裡所有 `file://` 外掛。回傳
 * `{ hooks: object[], loaded: string[], errors: string[] }`:`loaded` 是被呼叫的函式匯出名稱(`<檔名>#<匯出名>`)。
 */
export async function loadConfigPlugins(rawConfig, directory) {
  const hooks = [];
  const loaded = [];
  const errors = [];
  let config;
  try {
    config = JSON.parse(rawConfig ?? "{}");
  } catch {
    return { hooks, loaded, errors: ["OPENCODE_CONFIG_CONTENT 不是合法 JSON"] };
  }
  const entries = Array.isArray(config?.plugin) ? config.plugin : [];
  for (const entry of entries) {
    const [spec, options] = Array.isArray(entry) ? entry : [entry, undefined];
    if (typeof spec !== "string" || !spec.startsWith("file://")) continue;
    try {
      const mod = await import(spec);
      for (const [exportName, exported] of Object.entries(mod)) {
        if (typeof exported !== "function") continue;
        const result = await exported({ directory, worktree: directory, project: {}, client: {}, serverUrl: new URL("http://127.0.0.1"), $: undefined }, options);
        loaded.push(`${spec.split("/").pop()}#${exportName}`);
        if (result && typeof result === "object") hooks.push(result);
      }
    } catch (err) {
      errors.push(`${spec}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { hooks, loaded, errors };
}

/** 模擬 opencode 啟動一個 shell 時算出的環境:`{ ...process.env, ...hooks 設的 }`,再丟掉值為 undefined 的鍵(Node spawn 的行為)。 */
export async function simulateShellEnv(hooks, cwd) {
  const output = { env: {} };
  for (const hook of hooks) {
    if (typeof hook["shell.env"] === "function") await hook["shell.env"]({ cwd, sessionID: "ses_fake", callID: "call_fake" }, output);
  }
  const merged = { ...process.env, ...output.env };
  return Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== undefined));
}

/** 回報 `names` 各自有沒有出現在 `env`(不分大小寫;只回「有沒有」,絕不回顯值)。 */
export function presenceIn(env, namesCsv) {
  const upperKeys = new Set(Object.keys(env).map((k) => k.toUpperCase()));
  return Object.fromEntries(
    namesCsv
      .split(",")
      .map((n) => n.trim())
      .filter(Boolean)
      .map((name) => [name, upperKeys.has(name.toUpperCase())]),
  );
}
