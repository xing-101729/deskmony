/**
 * SubagentPort：讓 packages/adapters 的 `spawn_subagent` MCP 工具能請 core 去
 * spawn 一個子 session,而不需要 import apps/core(依賴方向規則:packages/* 不得
 * import apps/*,比照 `TeamBusPort`)。實例由 apps/core 在啟動時注入
 * (見 apps/core/src/index.ts)。
 */
export interface SubagentPort {
  /** spawn 一個子 session,並立刻送出 prompt。parentSessionId 由 adapter 端以
   *  自己的 handle.id 帶入(agent 不可指定,防止它冒名別的 session 當父)。
   *  agentProfileId 選填:agent 可先呼叫 `list_profiles` 查詢可用選項,自行決定
   *  要用哪個 profile 建立子 agent;省略時沿用父 session 自己的 profile。 */
  spawnChild(input: {
    parentSessionId: string;
    prompt: string;
    title?: string;
    agentProfileId?: string;
  }): Promise<{ childSessionId: string }>;

  /** 給 `list_profiles` MCP 工具用:回傳目前可用的 agent profile 摘要,讓 agent
   *  能自行決定 spawn_subagent 要用哪一個。刻意只回傳決策需要的最小欄位——
   *  不含 env/mcpConfig/systemPrompt 等可能夾帶密鑰或指令的欄位(那些欄位
   *  「本來就是給使用者自己的 UI 讀」的資料,見 agent-profile.ts 對 `env`
   *  欄位的說明,不該進到 agent 的對話 context 裡)。 */
  listProfiles(): Promise<SubagentProfileSummary[]>;
}

export interface SubagentProfileSummary {
  id: string;
  name: string;
  software: string;
  model?: string;
  role: string;
}
