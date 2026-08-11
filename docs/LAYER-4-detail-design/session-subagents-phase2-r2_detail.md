# S12 Phase 2 — Round 2：`spawn_subagent` MCP 工具（agent 自主 spawn）

> 上層：[`session-subagents_detail.md`](./session-subagents_detail.md)（S12）+
> [`session-subagents-phase2_detail.md`](./session-subagents-phase2_detail.md)（R1 回注）。
> 階段：跨 package（shared / adapters / core）的加法，非破壞性。
> L4 完成度標準：**另一個工程師照著寫，不用問你。**

---

## 0. 目標與範圍（嚴格遵守）

讓 **Claude Agent SDK session 的 agent 自己**能呼叫一個 MCP 工具 `spawn_subagent`
去 spawn 一個子 agent（用父自己的 profile），子跑完的結果會經由 R1 的機制注入回父。

**⚠️ 沒有 e2e 網**：MCP 工具只有真實 Claude 模型會觸發，這個環境沒有 Claude 憑證，
**測不到工具實際被呼叫**。所以：
- 驗收 = `pnpm build` + `pnpm typecheck` 綠 + 既有 `e2e-session-subagents.mjs` 仍 8/8 PASS（證明沒打壞 S12/R1 的 gateway 路徑）。
- **不要**為了「有綠燈」去捏造假測試、**不要**再發明 `fa:opencode` 之類的假 software 或假 adapter。工具能不能被真的呼叫，由人（Opus review + 之後有憑證時實測）確認。

**範圍**：
- ✅ shared 新增 `SubagentPort` 介面。
- ✅ adapters 新增 `subagent-mcp.ts` + `ClaudeAgentSdkAdapter` 注入 port 並條件掛載。
- ✅ core 實作 port + 在 index.ts 注入。
- ❌ 不動 team-bus 既有 5 個工具、不動 MessageBus / TaskService / 看板。
- ❌ 不做 UI（Round 3）。
- ❌ 不改 R1 已完成的注入邏輯（那是 SessionManager 內部,本輪不碰 `completed` case）。

---

## 1. `packages/shared`：`SubagentPort` 介面

新增檔案 `packages/shared/src/subagent.ts`：
```ts
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
```
在 `packages/shared/src/index.ts` 加一行 `export * from "./subagent.js";`（比照既有
`export * from "./team-bus.js";` 的慣例）。

---

## 2. `packages/adapters`：MCP 工具 + adapter 注入

### 2.1 新增 `packages/adapters/src/subagent-mcp.ts`（照抄 team-bus-mcp.ts 的形狀）

```ts
import { z } from "zod";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { SubagentPort } from "@deskmony/shared";

export const SUBAGENT_MCP_SERVER_NAME = "subagent";
export const SUBAGENT_TOOL_NAMES = [`mcp__${SUBAGENT_MCP_SERVER_NAME}__spawn_subagent`];

/** parentSessionId 由呼叫端(ClaudeAgentSdkAdapter)以自己的 handle.id 帶入,
 *  閉包捕捉,agent 無法覆寫(工具參數只有 prompt/title)。 */
export function createSubagentMcpServer(port: SubagentPort, parentSessionId: string): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: SUBAGENT_MCP_SERVER_NAME,
    version: "1.0.0",
    instructions:
      "spawn_subagent:開一個子 agent(用你自己的設定)去做一段被明確界定的子任務。" +
      "子 agent 跑完後,它的結果會自動出現在你的對話裡,你再據此繼續。" +
      "適合把一個大任務切成可並行/可獨立完成的小塊分出去。",
    tools: [
      tool(
        "spawn_subagent",
        "開一個子 agent 去執行一段子任務。prompt 是給子 agent 的完整任務描述;" +
          "title 選填,只是顯示名稱。回傳子 session id;子完成後結果會自動注入你的對話。",
        {
          prompt: z.string().min(1).describe("給子 agent 的完整任務描述(它看不到你的對話歷史,要寫清楚)"),
          title: z.string().optional().describe("選填:子 agent 的顯示名稱"),
        },
        async (args) => {
          const { childSessionId } = await port.spawnChild({ parentSessionId, prompt: args.prompt, title: args.title });
          return { content: [{ type: "text" as const, text: `已建立子 agent(session ${childSessionId})。它跑完後結果會自動出現在這裡。` }] };
        },
      ),
    ],
  });
}
```

### 2.2 `ClaudeAgentSdkAdapter`（`packages/adapters/src/claude-sdk-adapter.ts`）

- 頂部 import：`import { SUBAGENT_TOOL_NAMES, createSubagentMcpServer } from "./subagent-mcp.js";`
  以及 `import type { SubagentPort } from "@deskmony/shared";`
- 新增欄位 + setter（比照 `SessionManager.setTeamBus()` 的「事後注入、打破建構循環」手法——
  adapter 在 index.ts 建立時 core 的 port 還沒好）：
  ```ts
  private subagentPort?: SubagentPort;
  setSubagentPort(port: SubagentPort): void { this.subagentPort = port; }
  ```
- 改 `spawn()` 裡掛 MCP server 的那段（目前約 line 206–210,**只在 `team` 存在時**掛
  team-bus）。改成累積式,team 與 subagent 各自獨立掛載：
  ```ts
  const mcpServers: Record<string, McpServerConfig> = {};
  const allowedTools: string[] = [];
  if (team) {
    mcpServers[TEAM_BUS_MCP_SERVER_NAME] = createTeamBusMcpServer(team);
    allowedTools.push(...TEAM_BUS_TOOL_NAMES);
  }
  if (this.subagentPort) {
    // handle.id(= 這個 session 的 id)在 spawn() 開頭就已產生(line 101),
    // 這裡閉包捕捉當作 parentSessionId,agent 無法覆寫。
    mcpServers[SUBAGENT_MCP_SERVER_NAME] = createSubagentMcpServer(this.subagentPort, handle.id);
    // ⚠️ 刻意 **不** 把 spawn_subagent 放進 allowedTools —— 見 §4「權限」。
  }
  if (Object.keys(mcpServers).length > 0) {
    options.mcpServers = mcpServers;
    options.allowedTools = allowedTools;
  }
  ```
  > 保持既有行為:只有 team → 只掛 team-bus(allowedTools 同前);只有 subagentPort →
  > 只掛 subagent;兩者都有 → 都掛。都沒有 → 完全不設 mcpServers/allowedTools(與現況一致)。

---

## 3. `apps/core`：實作 port + 注入

### 3.1 `SessionManager` 新增一個給工具用的方法

既有 `spawnChild(input: SpawnChildSessionInput)` 需要 `agentProfileId`;工具只給
`{ parentSessionId, prompt, title }`,**child 一律沿用父 session 的 profile**。新增：
```ts
/** S12 Phase2 R2:給 `spawn_subagent` MCP 工具用——用父 session 自己的 profile
 *  spawn 子 session。找不到父 session 時拋錯(工具端會把錯誤回給 agent)。 */
async spawnChildFromTool(input: { parentSessionId: string; prompt: string; title?: string }): Promise<{ childSessionId: string }> {
  const parent = await this.getSession(input.parentSessionId);
  if (!parent) throw new Error(`找不到父 session: ${input.parentSessionId}`);
  const child = await this.spawnChild({
    parentSessionId: input.parentSessionId,
    agentProfileId: parent.agentProfileId,
    prompt: input.prompt,
    title: input.title,
  });
  return { childSessionId: child.id };
}
```

### 3.2 `apps/core/src/index.ts`：建立 port 物件並注入 claude adapter

- 目前 registry 大概是 `.register("claude-agent-sdk", new ClaudeAgentSdkAdapter())` 這種
  inline。改成**保留實例參考**:
  ```ts
  const claudeAdapter = new ClaudeAgentSdkAdapter();
  const adapters = new AdapterRegistry()
    .register("claude-agent-sdk", claudeAdapter)
    .register("acp", new AcpAdapter())
    .register("pty", new GenericPtyAdapter())
    .register("opencode", new OpenCodeAdapter());
  ```
  （**照現有 index.ts 實際的 registry 內容改**,不要漏掉任何一個既有 adapter；只把
  claude 那個抽出成具名變數。）
- 在 SessionManager 建好之後(它需要 registry,所以順序上 SessionManager 在後),注入
  port（比照既有 `sessionManager.setTeamBus(messageBus)` 那一行附近）：
  ```ts
  claudeAdapter.setSubagentPort({
    spawnChild: (input) => sessionManager.spawnChildFromTool(input),
  });
  ```

---

## 4. 權限（重要,刻意設計）

`spawn_subagent` **刻意不放進 `allowedTools`** —— 開子 agent 會起子程序、燒 token,不是
純訊息傳遞(team-bus 那些才是),不該自動放行。不放進 allowedTools ⇒ SDK 會對它走
`canUseTool` ⇒ `ClaudeAgentSdkAdapter` 照既有路徑發出 `permission-request` 事件 ⇒
`SessionManager` 交給 PolicyEngine（未分類 → default-deny → 升級給人核可,見 S1）。

- 這與安全罩哲學一致（DECISIONS.md C2 default-deny）。
- 無人值守時會 escalate 掛起等人（S1 §6 的既有語意）——本輪接受這個行為。
- TODO（本輪不做,寫進報告）：之後可加一條 policy allowlist（this tool + 合理 arg pattern）
  讓信任的情境自動放行,或做「子 agent 花費歸屬父」的預算歸屬。

> 實作者**不需要**為權限寫任何新程式碼——「不放進 allowedTools」本身就讓它自動走既有
> 權限流程。只要別手滑把它加進 allowedTools 就好。

---

## 5. 驗收（實作者必須跑,不准謊報）

repo 根目錄：
1. `pnpm build` → exit 0
2. `pnpm typecheck` → exit 0（零 TS 錯誤;新 import / 型別每處補齊）
3. `grep -rn "fa:opencode" packages apps scripts` → 零結果
4. `node scripts/e2e-session-subagents.mjs` → 仍 **8 PASS, 0 FAIL**（本輪沒碰 gateway spawnChild / R1 注入路徑,既有行為不得退步）

> ⚠️ **沒有**新的 e2e（MCP 工具需真實 Claude 才觸發,無憑證測不到）。不要捏造測試。
> 回報時明講「工具實際觸發未經 e2e 驗證,靠 build/typecheck + review」。

---

## 6. 回報要求

跑完回報：
- 改/新增了哪些檔案（逐檔一句話）。
- 上面 4 個驗收各自結果（貼 PASS/FAIL 統計 + exit code）。
- `spawn_subagent` **有沒有**被放進 allowedTools（應為「沒有」）。
- 依賴方向有沒有守住（packages/adapters 只 import `@deskmony/shared` 的 `SubagentPort`,
  沒 import apps/core）。
- 任何自行取捨、TODO。

---

> **驗收核心**：①agent 能呼叫 `spawn_subagent`（用父 profile spawn 子,parentSessionId 由
> adapter 以 handle.id 帶入、agent 無法冒名）；②子結果經 R1 機制注入父；③工具走既有權限流程
> （不在 allowedTools）；④依賴方向守住、既有 e2e 不退步。
