# 簡化:偵測 agent 直接建 session + 全 session 互傳訊息(2026-10-02)

> 狀態:**規格定案,實作中**。分支 `feat/simplify-agent-sessions`。
> 對應決策:[`DECISIONS.md` §H](../DECISIONS.md)(本輪新增,撤銷 §A 團隊協作模型)。
>
> 使用者 2026-10-02 的需求原文:「我想功能簡單化,可以從電腦找到各種 agent 軟體,然後可以在程式裡面使用,
> 然後不用每個都建立 profile,每個 session 可以知道有哪些 agent 軟體可以使用並建立 session,各種 agent 內的
> session 對話可以傳給其他 session 溝通」。
>
> 追問後的四個定案(使用者親自選的,實作不得偏離):
>
> | # | 問題 | 定案 |
> |---|---|---|
> | Q1 | Profile 怎麼處理 | **完全移除**。舊 profile 資料留在 DB 不刪,舊 session 仍可續接。 |
> | Q2 | Team / 看板 | **連後端一起移除**。 |
> | Q3 | A 傳給 B 後,B 的回覆怎麼回來 | **由 agent 自己決定回給誰**(「畢竟不一定給 A」)——**不做任何自動回送**。 |
> | Q4 | 一個 session 能看到哪些 session | **全部 session**。 |

---

## 0. 三個階段(依序實作,每階段一個 commit,各自要讓 `pnpm test` 全綠)

| 階段 | 內容 | 為什麼這個順序 |
|---|---|---|
| **P1** | 移除 team / task / 看板 / lead / 驗收閘 / message-bus / 任務 worktree(後端 + UI + CLI + e2e) | 先刪,後兩階段改 `session-manager.ts` 時面對的程式碼少一半 |
| **P2** | 移除 profile:session 直接以「偵測到的 agent(providerId)+ model」建立;session 自帶啟動資訊 | P3 的 `create_session` 工具直接建立在 P2 的新 `session.create` 上 |
| **P3** | session 網路:每個 session 都有 `list_agents` / `list_sessions` / `create_session` / `send_to_session` / `read_session` 工具;訊息鏈預算斷路器;UI 轉傳按鈕 | 取代 S12 子 agent 四件套 |

---

## P1. 移除 team / task / 看板

### P1.1 要刪除的東西(整個檔案)

- `apps/core/src/team/team-manager.ts`
- `apps/core/src/tasks/task-service.ts`、`apps/core/src/tasks/acceptance-runner.ts`
- `apps/core/src/bus/message-bus.ts`
- `apps/core/src/workspace/workspace-manager.ts`(**先確認**它只服務任務 worktree;若有非任務用途,保留那部分並在回報中說明)
- `packages/adapters/src/team-bus-mcp.ts`
- `packages/shared/src/team.ts`、`task.ts`、`team-bus.ts`(若其中有 session 仍在用的型別,搬到 `session.ts` 再刪)
- `apps/desktop/src/views/TaskBoardView.tsx`、`TeamChatView.tsx`、`TeamManagementDialog.tsx`
- `apps/desktop/src/stores/team-store.ts`、`task-store.ts`
- CLI 的 team/task 相關指令(若有)
- e2e:`scripts/e2e-lead-gate.mjs`、`scripts/e2e-message-budget.mjs`(P3 會寫新的鏈預算測試取代);`scripts/e2e-gateway.mjs` 的步驟 12、13、14、15、16、30(MessageBus / team-bus / TaskService / Review 合併 / 驗收閘);`scripts/run-e2e.mjs` 對應的登記。

### P1.2 要改的東西

- `apps/core/src/index.ts`:拿掉上述服務的建構與注入。
- `apps/core/src/gateway/ws-gateway.ts`:刪 `team.*`、`task.*`、`message.*`(team 訊息)、`workspace.*`(若只服務任務)gateway 方法與 `team-message` / `task-updated` / `task-deleted` push;`McpBridgeTokenScope` 拿掉 `team`,`computeAllowedMethods()` 拿掉 team 那五個方法;`LOCAL_ONLY_METHODS` 拿掉 `task.setAcceptance`/`task.runAcceptance` 等已不存在的方法。
- `packages/shared/src/gateway.ts`:對應的 request/response/push schema 一併刪除。
- `apps/core/src/session/session-manager.ts`:拿掉 `teamManager`、`teamMemberId`、`TeamSpawnContext`、`memberSessions`/`sessionMembers` 等一切 team 相關欄位與分支。
- `packages/adapters`:`ClaudeAgentSdkAdapter` 的 `setTeamBus()` / team-bus MCP 掛載、`AcpAdapter` 傳給 mcp-bridge 的 `DESKMONY_MCP_BRIDGE_TEAM_ID`/`MEMBER_ID`、`mcp-bridge-server.ts` 的 team-bus 五個工具、`TeamSpawnContext` 型別。
- `apps/core/src/cost/cost-governor.ts`:拿掉**任務預算**(`scope === "task"`、`trippedTasks`、`taskService` 相依);**保留**每 session 用量紀錄、每日/全域 kill-switch(E3)。`core-config.ts` 的 `budget.task` 設定若因此無人使用,一併移除(並跑 `pnpm generate:config-schema` 更新 `docs/deskmony.config.v1.json`)。
- `apps/core/src/recovery/recovery-service.ts`:拿掉任務/髒 worktree 相關(`resolveDirtyWorktree`、任務中斷分流);**保留** session 對帳(interrupted → 繼續/接手/放棄)。`RecoveryView.tsx` 同步拿掉任務區塊。
- `apps/desktop/src/App.tsx` 與 `SessionList.tsx`:拿掉 team/看板的入口、view mode、快捷鍵、`CommandPalette` 項目。i18n `locales/*` 拿掉不再使用的字串鍵。
- `packages/db`:**不 DROP 任何資料表**(使用者資料保留在 SQLite 檔裡)。drizzle schema 中只服務已刪除功能的表定義與 `ensure*` 遷移可以移除;**不得**寫任何刪除資料的遷移。
- `message-budget`(A5)的 config 鍵 `messageBudget.maxMessagesPerContext`/`warnAtPercent` **保留**——P3 的訊息鏈預算要沿用它。

### P1.3 驗收

- `pnpm typecheck`、`pnpm build`、`pnpm test`(含所有剩下的 e2e)全綠。
- `grep -rniE "teamManager|taskService|messageBus|TeamSpawnContext|team-bus" apps packages scripts --include=*.ts --include=*.tsx --include=*.mjs` 只剩註解中「已於 2026-10-02 移除」之類的歷史說明(或零筆)。
- 回報中列出每一個被刪除/修改的檔案,以及任何「原本想刪但發現還有別的用途所以保留」的東西。

---

## P2. 移除 profile

### P2.1 新的 `session.create`

```ts
// packages/shared/src/session.ts
export const CreateSessionInputSchema = z.object({
  /** BUILTIN_PROVIDERS 的 id(例如 "claude-agent-sdk"、"codex"、"opencode")。 */
  providerId: z.string().min(1),
  model: z.string().optional(),
  effort: EffortLevelSchema.optional(),
  workingDir: z.string(),
  title: z.string().optional(),
  parentSessionId: z.string().optional(),
});
```

- 拿掉 `agentProfileId`、`teamMemberId`(P1 已拿)、`agentOverride`。`AgentOverrideSchema` 與 `apps/desktop/src/lib/agent-override.ts` 刪除。
- `SpawnChildSessionInputSchema` 同樣改成 `providerId`/`model`/`effort`(P3 會再重整,這裡先讓它能編譯運作)。

### P2.2 core 端新增 `AgentCatalog`(`apps/core/src/agents/agent-catalog.ts`)

- 持有偵測結果快取:core 啟動時背景跑一次 `detectAllAgents()`(**不得阻塞啟動**);`env.detectAgents` gateway 方法改成「重新偵測 + 更新快取 + 回傳」。
- `resolve(): ResolvedProvider[]` = `resolveProviders(BUILTIN_PROVIDERS, cachedDetection, providerPrefs)`(providerPrefs 從 `SettingsStore` 讀)。
- `listAvailable(): ResolvedProvider[]` = `enabled && installed` 的項目。
- `buildLaunchSpec(providerId, model?, effort?)`:找不到 / 未安裝 / 已停用 → 丟 `DeskmonyError`(新錯誤碼,UI 要能顯示中文訊息)。偵測快取尚未完成時,`await` 那一次偵測(不是回錯)。
- **`custom-pty`(手動輸入 command 的逃生閥)從 `BUILTIN_PROVIDERS` 移除**——新模型的前提是「從電腦找到的 agent」。

### P2.3 session 自帶啟動資訊

- `SessionSchema`:拿掉 `agentProfileId`;新增 `providerId: string`。保留 `adapterType`、`model`、`effort`。
- DB `sessions` 表新增欄位(冪等 `ensure*` 遷移,比照既有 `ensureSessionsParentColumn`):`provider_id TEXT`、`launch_command TEXT`、`launch_args TEXT`(JSON)。
  - 既有 `agent_profile_id` 是 `NOT NULL`,SQLite 不能直接改約束:新 session 寫入 `providerId` 當值,drizzle 欄位改名 `legacyAgentProfileId` 並加註解。
- **續接 / checkpoint 重啟(`continueSession()`、`performContextCheckpointRestart()`)一律從 session 自己的資料重建**:先用 `providerId` 走 `AgentCatalog.buildLaunchSpec(providerId, session.model, session.effort)`;provider 已不存在 / 未安裝時,退回 `adapterType + launch_command + launch_args`。**不得再讀 `agent_profiles` 表。**
  - 這同時修掉一個既有 bug:舊設計下用 `agentOverride` 建的 session,續接時會 `profiles.get()` 讀回 base profile,換回錯的 agent。
- **舊資料遷移(啟動時一次,冪等)**:對 `provider_id IS NULL` 的 session 列,用 raw SQL 讀 `agent_profiles` 對應列 → 回填 `provider_id`(profile 有 `provider_id` 用它;否則 `claude-agent-sdk` → `"claude-agent-sdk"`,其他 → `"legacy-<software>"`)、`launch_command`/`launch_args`(從 `acp_config`/`pty_config`/`opencode_config` JSON 取)。`agent_profiles` 表找不到對應列就回填 `"legacy-unknown"`、不填 launch,續接時明確報錯。`agent_profiles` 表若不存在(全新安裝)直接略過。

### P2.4 profile 原本承擔的東西改去哪

| profile 欄位 | 之後 |
|---|---|
| `software` / `*Config` / `providerId` | `AgentCatalog.buildLaunchSpec()` |
| `model` / `effort` | session 建立參數;沒給就用 provider 的 `defaultModelId` |
| `env` | 既有 provider 層級 env(`getProviderEnv()`,設定介面已有) |
| `permissionLevel` | 一律從 `"always-ask"` 開始;既有 session 級 auto/YOLO 切換不變 |
| `systemPrompt` | 不再有;`withNotesPointer()` 照舊附加指路段落(displayName 改用 session title 或 provider label) |
| `workingDir` | session 建立參數(本來就是) |
| `name` / `role` / `mcpConfig` | 刪除 |

內部 adapter `spawn()` 仍可以吃 `AgentProfile` 形狀的物件當「啟動規格」(避免 adapters 大改),但建議改名 `AgentLaunchSpec` 並拿掉 `id/name/role/createdAt/updatedAt/mcpConfig` 這些已無意義的欄位;若改名牽連過大,保留型別名稱也可以,**但不得再持久化或經 gateway 曝露**。

### P2.5 要刪的東西

- `apps/core/src/profiles.ts`(`ProfileStore`、`createDefaultProfile` seed)
- gateway `profile.list` / `profile.create` / `profile.delete` / `profile.listForSubagent`,`LOCAL_ONLY_METHODS` 對應項
- `apps/desktop/src/views/ProfileCreateDialog.tsx`;`session-store` 的 `profiles`/`createProfile`/`deleteProfile`
- CLI `apps/cli/src/commands/profile.ts`;其他 CLI 指令的 `--profile` 改成 `--agent <providerId>`(預設 `claude-agent-sdk`)+ `--model`

### P2.6 UI

- `SessionList` 頂部:**agent 下拉**(`listAvailable()`,顯示 label + 版本)+ **model 下拉**(該 provider 的 models,`supportsModelSelection` 為 false 時隱藏)+ effort(只有 claude-agent-sdk 顯示)+「新對話」鈕。`⌘N` 用上次選的組合。上次選擇存 `localStorage`(讀寫包 try/catch)。
- 沒偵測到任何可用 agent 時,顯示說明 + 「重新偵測」鈕(呼叫 `env.detectAgents`)。
- 「開子 agent」對話框改用同一組 agent/model 選單。
- `ChatView` 顯示 agent 名稱改看 `session.providerId` → provider label。

### P2.7 驗收

- `pnpm test` 全綠。e2e 改寫所有原本先 `profile.create` 再 `session.create` 的步驟。
- **新增**決定性 e2e(放 `scripts/e2e-gateway.mjs` 新步驟,用 fake ACP agent / fake opencode server,不依賴真實模型):
  1. `session.create({providerId:"claude-agent-sdk"})` 不需任何 profile 就成功,回傳的 session 有 `providerId`。
  2. `session.create({providerId:"不存在的"})` 回明確錯誤碼。
  3. **續接重建**:用 ACP provider 建 session → 停 core → 重啟 → `session.continue`(或對應方法)後 `adapterType` 仍是 `acp`,不是 claude-agent-sdk。
  4. **舊資料遷移**:先用舊 schema 塞一筆 `agent_profiles` + 一筆指向它的 `sessions`(`provider_id` NULL)→ 啟動 core → 該 session 的 `providerId`/`launch_*` 已回填。
  5. gateway 上 `profile.list` 已不存在(回 unknown method)。

---

## P3. Session 網路

### P3.1 工具(取代 S12 的 `spawn_subagent` / `send_to_subagent` / `list_subagents` / `list_profiles`)

MCP server 名稱改為 `deskmony`(工具全名 `mcp__deskmony__<name>`)。

| 工具 | 參數 | 行為 | 權限 |
|---|---|---|---|
| `list_agents` | — | 回 `AgentCatalog.listAvailable()` 的摘要:`{id,label,software,models:[{id,label}],defaultModelId,canUseTools}`。`canUseTools` = software 是 `claude-agent-sdk` 或 `acp`(只有這兩種能掛工具、能主動傳訊息) | 自動放行 |
| `list_sessions` | — | 回**所有** session:`{id,title,providerId,agentLabel,model,status,workingDir,parentSessionId,isYou,canUseTools}`。不含對話內容 | 自動放行 |
| `read_session` | `sessionId`, `limit?`(預設 20,上限 100) | 回目標 session 最近 `limit` 則訊息 `{role,content,createdAt,origin?}`,每則 content 截斷到 4000 字元並標註被截斷 | 自動放行 |
| `create_session` | `agent`(providerId), `prompt`, `model?`, `title?`, `workingDir?`(預設呼叫者的) | 建 session(`parentSessionId` = 呼叫者,只為 UI 巢狀顯示與溯源),並把 `prompt` 以 §P3.2 信封送出。回傳新 session id | **走權限流程**(不進 allowedTools) |
| `send_to_session` | `sessionId`, `message` | 對任一 session(不能是自己)送訊息,以 §P3.2 信封包裝。目標 idle 立刻送;busy/waiting 排進既有 `pendingIdleInjection` 佇列。目標 `closed`/`error`/runtime 不在 → 明確報錯,不得假裝成功 | **走權限流程** |

- 呼叫者身分(`callerSessionId`)一律由 adapter 端以自己的 handle.id 閉包捕捉(in-process)或由 bridge token 綁定(ACP),**不是工具參數**——同 S12 既有的冒名防護。
- 工具描述要明講:「收到別的 session 的訊息時,**要不要回、回給誰由你決定**;要回覆就用 `send_to_session`,系統不會自動把你的回答送回去」。

### P3.2 訊息信封與來源標記

送進目標 session 的 prompt 文字:

```
[來自 session「<呼叫者 title>」(id: <callerId>,agent: <agentLabel>)的訊息]
<message>

—
(系統提示:這則訊息不會自動得到回覆。若你要回應,請用 send_to_session 傳給 <callerId>,或任何其他合適的 session。)
```

- `MessageRecord` 新增選填 `origin`:`{ kind: "session", sessionId, title, chainId } | { kind: "forward", sessionId, title, chainId }`。DB `messages` 表新增 `origin TEXT`(JSON,冪等遷移,比照 `ensureMessagesAttachmentsColumn()`)。
- UI 對有 `origin` 的訊息顯示「來自 <title>」標籤(可點擊跳到該 session),內文顯示 `<message>` 本體(不顯示信封樣板文字——信封只給 agent 看)。所以持久化時 `content` 存原始 `message`,信封只在送給 adapter 那一刻組裝。

### P3.3 拿掉自動回送

- **刪除** S12 R1 的「子 session completed → 把結果注入父 session」機制,以及 `child-result` push 事件、父歷史的 system 訊息。理由:Q3 定案「由 agent 決定回給誰」。`create_session` 建出的 session 從信封就知道是誰建的,要不要回報由它自己決定。
- `pendingIdleInjection` / `deliverPromptWhenIdle()` 保留(`send_to_session` 用),但佇列元素改成帶 `{text, origin, chainId}`。

### P3.4 訊息鏈預算(取代 A5 的 context 預算,第二條斷路器)

- **鏈(chain)**:人類直接輸入的 prompt 開啟一條新鏈。agent 經 `create_session`/`send_to_session` 送出的訊息,沿用「呼叫者**目前這一輪**是被哪條鏈觸發的」那條鏈;呼叫者這一輪是人類觸發的 → 開新鏈。UI 轉傳(§P3.5)也開新鏈。
- 每個 session runtime 記住 `currentChainId`(收到帶 chain 的訊息、開始處理那一輪時設定;人類 prompt 時換成新鏈)。只存記憶體,不落地。
- 每條鏈的訊息數上限 = `config.messageBudget.maxMessagesPerContext`(預設 50;鍵名保留以免破壞使用者既有 config,文件註明現在的意義是「每條鏈」)。達到 `warnAtPercent` 時 audit + 通知;**超過上限時 `create_session`/`send_to_session` 直接回錯誤給 agent**(工具結果明講「這條對話鏈已達訊息上限 N,已熔斷,需要使用者介入」),並走既有 `enforcementTrip()`(audit log + 桌面通知)。
- 熔斷只擋 agent 對 agent 的傳遞;人類照常可以對任何 session 輸入,輸入即開新鏈。
- 遠端不可停用(F4 精神不變):`messageBudget` 維持不在遠端可改的設定子集。

### P3.5 UI

- 每則 assistant 訊息的動作列加「轉傳到…」:選目標 session(所有 session,排除自己)+ 選填附註 → gateway `session.forwardMessage({sourceSessionId, messageId, targetSessionId, note?})`。目標收到的信封標明「使用者從 session X 轉來」。
- 收到的跨 session 訊息依 §P3.2 顯示來源標籤。
- `SessionList` 父子巢狀顯示保留(由 `create_session` 建出的 session 掛在建立者底下)。

### P3.6 ACP(mcp-bridge)

- `McpBridgeTokenScope` 只剩 `{ sessionId, network: true }`;`computeAllowedMethods()` 對應五個新 gateway 方法,呼叫者 session 從 token 取(不收參數):`agent.listForAgent`、`session.listForAgent`、`session.readForAgent`、`session.createFromAgent`、`session.sendFromAgent`。刪除 `session.spawnChildForSubagent` / `session.sendToChild` / `session.listChildren` / `profile.listForSubagent`。
- `mcp-bridge-server.ts` 的工具名稱、參數、描述與 in-process 版本**逐字一致**(檔案頂端既有的「刻意複製文字」原則照舊)。
- OpenCode(HTTP adapter)與 PTY 沒有工具:可以**收**訊息(`send_to_session` 照送),但不能主動傳。`list_agents`/`list_sessions` 的 `canUseTools:false` 讓 agent 知道對方回不了話。

### P3.7 驗收

- `pnpm test` 全綠;`scripts/e2e-session-subagents.mjs` 改寫為 `scripts/e2e-session-network.mjs`(決定性,fake backend),**必須斷言**:
  1. A `list_sessions` 看得到 B(B 不是 A 的子,證明是「全部 session」可見)。
  2. A `send_to_session(B)` → B 收到的 prompt 含信封、B 的持久化訊息有 `origin.sessionId === A`;B 這輪結束後 **A 沒有收到任何自動注入**。
  3. B busy 時 A 送的訊息會排隊,B 回 idle 後才送達。
  4. `send_to_session` 對自己、對不存在的 id、對 closed session → 明確錯誤。
  5. 鏈預算:把 `maxMessagesPerContext` 設成 3,A↔B 互傳到第 4 則被拒、有 audit 紀錄;此時人類對 A 輸入新 prompt,A 再送給 B 成功(新鏈)。
  6. `create_session` 建的 session `parentSessionId` = 呼叫者、第一則訊息有 `origin`。
  7. `read_session` 回最近 N 則、超長內容被截斷。
  8. ACP bridge token 只能呼叫那五個方法;拿 token 呼叫 `session.setPermissionMode` 被拒。
  9. `session.forwardMessage` 轉傳後目標收到 `origin.kind === "forward"`,且開了新鏈。
- 真實憑證 smoke test(本體做,不交給實作 subagent):Claude SDK session 在不提工具名的情況下,被要求「問另一個 session 一個問題」時能自己找到並使用 `send_to_session`。

---

## 不做(記為後續)

- OpenCode HTTP adapter 掛 MCP(讓 opencode 也能主動傳訊息)——目前請改用「OpenCode(ACP)」provider。
- 擴充偵測清單(qwen-code、goose、kimi、copilot 等原生 ACP CLI)——這台機器沒裝,無法依「以實際觀察為準」紀律逐一實測旗標;目錄加一筆就能支援,之後有裝再加。
- 同步「等對方回覆」的 send 語意(Q3 定案不做)。
