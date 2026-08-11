import type { AgentSoftware } from "@deskmony/shared";
import type { AgentAdapter } from "./types.js";

/**
 * AdapterRegistry(M2 Round A):以 `AgentProfile.software` 為 key 查找對應的
 * `AgentAdapter` 實例。取代 M1 時 `apps/core` 固定 `new ClaudeAgentSdkAdapter()`
 * 並把它單獨傳給 `SessionManager` 的作法(ARCHITECTURE.md 3.4 節「多 agent 軟體
 * 支援」需要 SessionManager 能依 profile 選擇不同 adapter)。
 *
 * 一個 software 對應一個「長駐」的 adapter 實例(adapter 本身內部用
 * `Map<handleId, ...>` 管理多個 session,不是每個 session 各自 new 一個
 * adapter)。這裡只做註冊/查找,不擁有 adapter 的生命週期。
 */
export class AdapterRegistry {
  private readonly adapters = new Map<AgentSoftware, AgentAdapter>();

  register(software: AgentSoftware, adapter: AgentAdapter): this {
    this.adapters.set(software, adapter);
    return this;
  }

  has(software: AgentSoftware): boolean {
    return this.adapters.has(software);
  }

  /** 查找失敗時直接丟錯(呼叫端通常是 SessionManager.createSession,找不到 adapter 就無法建立 session)。 */
  get(software: AgentSoftware): AgentAdapter {
    const adapter = this.adapters.get(software);
    if (!adapter) {
      throw new Error(`找不到 software="${software}" 對應的 AgentAdapter,尚未在 AdapterRegistry 註冊`);
    }
    return adapter;
  }

  list(): AgentSoftware[] {
    return [...this.adapters.keys()];
  }
}
