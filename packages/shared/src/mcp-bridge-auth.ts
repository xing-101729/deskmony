/**
 * Phase 2(ACP 掛載 MCP 工具)新增。(2026-10-02:原本還有 team-bus 那一組,team 已移除,見
 * docs/DECISIONS.md §H;P3 起工具換成 session 網路的五個工具 `list_agents`/`list_sessions`/
 * `read_session`/`create_session`/`send_to_session`。)
 *
 * 背景:`ClaudeAgentSdkAdapter` 用 in-process 的 `createSdkMcpServer()`
 * (packages/adapters/src/session-network-mcp.ts)掛載 session 網路工具——工具 handler
 * 直接閉包捕捉 `SessionNetworkPort` 實例,
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
 * 綁定單一 session** 的 scoped token,又不需要
 * import `apps/core`(依賴方向規則:packages/* 不得 import apps/*)——比照
 * `SessionNetworkPort` 既有的「介面定義在 packages/shared,實例由
 * apps/core 注入」模式。核發/驗證/失效的實際邏輯在
 * apps/core/src/gateway/ws-gateway.ts(`WsGateway.mintMcpBridgeToken()` /
 * `revokeMcpBridgeTokensForSession()`),`apps/core/src/index.ts` 建構完
 * `WsGateway` 後,用一個實作了這個介面的物件呼叫
 * `AcpAdapter.setTokenMinter()`(事後注入,理由同
 * `setSessionNetworkPort()`——adapter 建構當下 `WsGateway` 還不存在)。
 */

/**
 * 核發 scoped token 時要綁定的範圍。`sessionId` 是這個 ACP session 自己的
 * `AgentHandle.id`(見 `AcpAdapter.spawn()`)——也是 session 網路五個方法的**呼叫者身分**:
 * gateway 從 token 取這個 id,方法參數**不收**任何 caller/parent 欄位(agent 無法冒名別的 session)。
 *
 * `network: true` 時,核發的 token 能呼叫 session 網路對應的五個方法(`agent.listForAgent`/
 * `session.listForAgent`/`session.readForAgent`/`session.createFromAgent`/`session.sendFromAgent`);
 * `false` 時白名單為空(token 什麼都不能做)。
 */
export interface McpBridgeTokenScope {
  /** 這個 token 綁定的 session id(= `AgentHandle.id`)。 */
  sessionId: string;
  /** true 時,授權 session 網路五個工具對應的 gateway 方法。 */
  network: boolean;
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
   *  session 網路 MCP 工具時呼叫一次。 */
  mint(scope: McpBridgeTokenScope): McpBridgeTokenGrant;
  /** 讓某個 session 核發過的所有 token 立即失效——`AcpAdapter.dispose()`
   *  必須呼叫,避免子行程持有的 token 在 session 結束後變成孤兒憑證。 */
  revokeForSession(sessionId: string): void;
}
