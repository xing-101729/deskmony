/**
 * SubagentPort：讓 packages/adapters 的 `spawn_subagent` MCP 工具能請 core 去
 * spawn 一個子 session,而不需要 import apps/core(依賴方向規則:packages/* 不得
 * import apps/*,比照 `TeamBusPort`)。實例由 apps/core 在啟動時注入
 * (見 apps/core/src/index.ts)。
 */
export interface SubagentPort {
  /** 用「父 session 自己的 profile」spawn 一個子 session,並立刻送出 prompt。
   *  parentSessionId 由 adapter 端以自己的 handle.id 帶入(agent 不可指定,防止
   *  它冒名別的 session 當父)。 */
  spawnChild(input: { parentSessionId: string; prompt: string; title?: string }): Promise<{ childSessionId: string }>;
}
