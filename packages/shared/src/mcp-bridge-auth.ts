/**
 * Phase 2(ACP 掛載 team-bus/subagent MCP 工具)新增。
 *
 * 背景:`ClaudeAgentSdkAdapter` 用 in-process 的 `createSdkMcpServer()`
 * (packages/adapters/src/team-bus-mcp.ts / subagent-mcp.ts)掛載 team-bus/
 * subagent 工具——工具 handler 直接閉包捕捉 `TeamBusPort`/`SubagentPort` 實例,
 * 同一個 process 內呼叫,不需要任何認證機制。但 `@agentclientprotocol/sdk` 的
 * `McpServer` 型別只接受 stdio/HTTP/SSE 這種「外部行程/端點」形式(見
 * packages/adapters/src/acp-adapter.ts 的查證註解),不支援閉包捕捉——
 * `AcpAdapter` 必須改成告訴被 spawn 的 ACP agent「你自己去 spawn 這個
 * command」(packages/adapters/src/mcp-bridge-server.ts),那個子行程再透過
 * WS 連回 apps/core 的 gateway 呼叫既有的 RPC 方法。
 *
 * **絕不能**把完整存取權的 `DESKMONY_AUTH_TOKEN` 交給這個子行程——它是由外部、
 * LLM 控制的 codex-acp/gemini 行程**間接**（透過 ACP 的
 * `session/new`→`mcpServers`設定）spawn 出來的孫行程,env/args 有被檢視的
 * 可能。這個介面讓 `packages/adapters` 能請求核發一個**限定範圍、有時效、
 * 綁定單一 session(以及選填的 team/member)** 的 scoped token,又不需要
 * import `apps/core`(依賴方向規則:packages/* 不得 import apps/*)——比照
 * `TeamBusPort`/`SubagentPort` 既有的「介面定義在 packages/shared,實例由
 * apps/core 注入」模式。核發/驗證/失效的實際邏輯在
 * apps/core/src/gateway/ws-gateway.ts(`WsGateway.mintMcpBridgeToken()` /
 * `revokeMcpBridgeTokensForSession()`),`apps/core/src/index.ts` 建構完
 * `WsGateway` 後,用一個實作了這個介面的物件呼叫
 * `AcpAdapter.setTokenMinter()`(事後注入,理由同 `setTeamBus()`/
 * `setSubagentPort()`——adapter 建構當下 `WsGateway` 還不存在)。
 */

/**
 * 核發 scoped token 時要綁定的範圍。`sessionId` 是這個 ACP session 自己的
 * `AgentHandle.id`(見 `AcpAdapter.spawn()`)——也是 subagent 系列方法的
 * `parentSessionId`,只有這個 session id 允許被操作。
 *
 * `team`/`subagent` 各自獨立:只提供 `team` 時,核發的 token 只能呼叫
 * team-bus 對應的方法;只提供 `subagent: true` 時,只能呼叫 subagent 對應
 * 的方法;兩者都提供時,白名單是兩者的聯集(比照
 * `ClaudeAgentSdkAdapter.spawn()` 既有的「team 跟 subagent 各自獨立判斷、
 * 兩者皆有時同時掛上」累加模式)。
 */
export interface McpBridgeTokenScope {
  /** 這個 token 綁定的 session id(= `AgentHandle.id`)。 */
  sessionId: string;
  /** 提供時,授權 team-bus 系列方法(send_message/broadcast/list_teammates/
   *  report_status/request_review 對應的 gateway 方法),且只能操作這個
   *  teamId/memberId。 */
  team?: { teamId: string; memberId: string };
  /** true 時,授權 subagent 系列方法(spawn_subagent/send_to_subagent/
   *  list_subagents/list_profiles 對應的 gateway 方法)。 */
  subagent: boolean;
}

/** 核發結果——`gatewayUrl` 是子行程應該連線的 WS 位址(一律是子行程能連得到
 *  的位址,不一定等於 gateway 對外宣告的 bindHost,見
 *  `apps/core/src/index.ts` 的 `resolveMcpBridgeGatewayUrl()`)。 */
export interface McpBridgeTokenGrant {
  token: string;
  gatewayUrl: string;
  /** 絕對過期時間(epoch ms)——即使忘了呼叫 `revokeForSession()`,token 也
   *  不會永久有效,見 `McpBridgeTokenPort` 類別註解。 */
  expiresAt: number;
}

export interface McpBridgeTokenPort {
  /** 核發一個新的 scoped token。每次 `AcpAdapter.spawn()` 需要掛載
   *  team-bus/subagent MCP 工具時呼叫一次。 */
  mint(scope: McpBridgeTokenScope): McpBridgeTokenGrant;
  /** 讓某個 session 核發過的所有 token 立即失效——`AcpAdapter.dispose()`
   *  必須呼叫,避免子行程持有的 token 在 session 結束後變成孤兒憑證。 */
  revokeForSession(sessionId: string): void;
}
