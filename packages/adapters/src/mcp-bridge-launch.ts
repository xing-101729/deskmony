/**
 * mcp-bridge-launch.ts(2026-10-03):算出「掛載 session 網路 MCP bridge 子行程」需要的啟動資訊並核發 scoped token。
 * 原本是 acp-adapter.ts 的私有方法;OpenCode(HTTP)adapter 也要掛同一個 bridge(寫進 opencode 的
 * `mcp.deskmony` 設定),所以抽成共用模組——兩條路的 token、環境變數、降級行為完全相同。
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import { existsSync } from "node:fs";
import type { McpBridgeTokenGrant, McpBridgeTokenPort, SessionNetworkPort } from "@deskmony/shared";

/** mcp-bridge-server.js 的啟動資訊;`env` 含這個 session 專屬的 scoped token,**不能**放進 args。 */
export interface McpBridgeLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * 算出 `packages/adapters/src/mcp-bridge-server.ts` 編譯後的路徑。
 *
 * **不用** `require.resolve()`(對照 `codex-acp-locator.ts` 的 `resolveCodexAcpBridge()`)——那是給*外部*
 * npm 套件用的解法。`mcp-bridge-server.ts` 是**這個套件自己的檔案**,`tsc`(見 `packages/adapters/tsconfig.json`
 * 的 `outDir: "dist"`)把 `src/` 底下每個檔案原樣編譯成 `dist/` 底下同名的 `.js`,所以
 * `mcp-bridge-server.js` 永遠跟這個檔案編譯後的 `mcp-bridge-launch.js` 在**同一個目錄**——用 `import.meta.url`
 * 算出所在目錄,取同目錄下的檔名即可(原本在 acp-adapter.ts,2026-10-03 抽出來讓兩個 adapter 共用)。
 */
export function resolveMcpBridgeServerEntry(): string {
  const thisFile = fileURLToPath(import.meta.url);
  return path.join(path.dirname(thisFile), "mcp-bridge-server.js");
}

/**
 * 算出這個 session 要不要掛載 mcp-bridge-server.ts,要的話**核發一個綁定這個 session 的 scoped token**並回傳
 * 啟動資訊。回傳 `undefined` = 不掛載(沒有 `sessionNetworkPort`,或缺少 `tokenMinter`/找不到已編譯的 bridge
 * 進入點這兩種**優雅降級**的情況——後兩者理論上不該發生,但寧可略過掛載、印警告,也不要讓整個 session
 * 建立失敗:session 網路工具是加分項,不是這個 session 能不能建立的前提)。
 *
 * 呼叫端**必須**在 session 結束(或 spawn 失敗)時呼叫 `tokenMinter.revokeForSession(sessionId)`。
 *
 * env 一律透過環境變數(不是 CLI args)傳遞,避免 token 出現在行程列表裡(尤其是 Windows 的
 * tasklist/工作管理員預設就會顯示完整命令列),見 mcp-bridge-server.ts 檔頭「環境變數」段落。
 */
export function mintMcpBridgeLaunch(
  deps: { sessionNetworkPort?: SessionNetworkPort; tokenMinter?: McpBridgeTokenPort },
  sessionId: string,
  logLabel: string,
): McpBridgeLaunch | undefined {
  if (!deps.sessionNetworkPort) return undefined;
  if (!deps.tokenMinter) {
    console.warn(`[${logLabel}] session ${sessionId}: sessionNetworkPort 存在但尚未注入 tokenMinter,略過掛載 session 網路 MCP 工具`);
    return undefined;
  }
  const entryPath = resolveMcpBridgeServerEntry();
  if (!existsSync(entryPath)) {
    console.warn(
      `[${logLabel}] session ${sessionId}: 找不到 mcp-bridge-server.js(${entryPath}),` +
        "略過掛載 session 網路 MCP 工具——請確認 packages/adapters 已執行過 pnpm build。",
    );
    return undefined;
  }

  const grant: McpBridgeTokenGrant = deps.tokenMinter.mint({ sessionId, network: true });
  return {
    command: process.execPath,
    args: [entryPath],
    env: {
      DESKMONY_MCP_BRIDGE_TOKEN: grant.token,
      DESKMONY_MCP_BRIDGE_GATEWAY_URL: grant.gatewayUrl,
      DESKMONY_MCP_BRIDGE_SESSION_ID: sessionId,
      DESKMONY_MCP_BRIDGE_NETWORK_ENABLED: "1",
    },
  };
}
