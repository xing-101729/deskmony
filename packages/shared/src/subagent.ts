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

  /** S12 Phase2 R4:給 `send_to_subagent` MCP 工具用——對一個「已經是這個
   *  parentSessionId 的子 session」送出後續訊息(追加指示,不是開新的子任務)。
   *  parentSessionId 同 spawnChild():由 adapter 端以自己的 handle.id 帶入,
   *  agent 不可指定;childSessionId 由 agent 自己記得(spawnChild 回傳過)。
   *  core 端會驗證 childSessionId 確實是這個 parentSessionId 的子,拒絕對
   *  任意 sessionId 下指令。子 agent 處理完後,結果一樣經由既有的
   *  completed → child-result 機制自動回報給父,這裡不用回傳值。 */
  sendToChild(input: { parentSessionId: string; childSessionId: string; message: string }): Promise<void>;

  /** S12 Phase2 R5:給 `list_subagents` MCP 工具用——回傳這個 parentSessionId
   *  自己名下的子 session 列表(不論是 agent 自己用 spawn_subagent 開的,還是
   *  使用者透過畫面「開子 agent」手動開的——父對後者原本完全不知情,這個
   *  查詢補上這條可見度)。純查詢,不含對話內容本身,只回答「有哪些子、
   *  現在什麼狀態、用什麼 software/model」這類 agent 常被使用者追問、但自己
   *  對話歷史裡查不到的問題(尤其是使用者手動開的子——agent 從未呼叫過
   *  spawn_subagent,對話裡不會有任何 tool-result 提到它)。 */
  listChildren(input: { parentSessionId: string }): Promise<SubagentChildSummary[]>;

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

export interface SubagentChildSummary {
  id: string;
  title: string;
  status: string;
  software: string;
  model?: string;
}
