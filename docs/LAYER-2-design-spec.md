# Layer-2:Design Spec 與模組/功能清單

> 上層約束:[`DECISIONS.md`](./DECISIONS.md)(L1 定案)。本層把 L1 的決策拆成**模組清單**與**設計規格清單**,每一條規格 = 一份 L3 HLD。
> 狀態圖例:🟢 已存在（codebase 有）｜🟠 已存在但需改造｜🔴 淨新增（現況沒有）

---

## 1. 模組清單(Module Inventory)

### 1.1 Core（`apps/core/src/`）

| 模組 | 職責 | 現況檔案 | 狀態 |
|---|---|---|---|
| TeamManager | 團隊 / 成員 / 角色 CRUD | `team/team-manager.ts` | 🟢 |
| SessionManager | session 生命週期、狀態機（idle/busy/waiting/error）、跨重啟恢復 | `session/session-manager.ts` | 🟠 需加崩潰對帳(§D) |
| **PolicyEngine** | default-deny 權限政策：allowlist/deny-list、auto 語意、升級 | `permissions/permission-gateway.ts`(57 行空殼) | 🔴 Phase 1(切片先用現況人核可) |
| MessageBus | 訊息路由 + Mailbox + 投遞策略 | `bus/message-bus.ts` | 🟠 需加 context 預算+熔斷+Mailbox 持久化 |
| TaskService | 任務 CRUD、狀態機、worktree 合併 | `tasks/task-service.ts` | 🟠 需加機器驗收閘(A3) |
| **dispose-gate**(Lead 收斂閘) | 攔 Lead agent 的收斂提議(定案拆解/判定 done/批准合併),過人·規則閘才生效 → 轉 TaskService 動作。**Lead 本身是 AgentProfile,非 Core 程式** | — | 🔴 Phase 2 |
| **EnforcementKernel** | 三斷路器共用:升級事件 schema、halt→回報 lead/人類、稽核 log 寫入。**隨 S1 出最小版** | — | 🔴 Phase 1 |
| **Notification** | 升級/熔斷帶外送達人類:系統通知 + webhook;逾時 fail-safe。與 EnforcementKernel 配對 | — | 🔴 Phase 1 |
| **CostGovernor(S3b)** | 任務預算、每日 kill-switch、熔斷(量測半 S3a 見 adapters) | — | 🔴 Phase 1 |
| **RecoveryManager** | 崩潰對帳、復原視圖資料、Mailbox 重放 | — | 🔴 Phase 1 |
| **SandboxManager** | PTY/無閘門 tier 環境圍堵(C7)。**named-deferred**,不進 Phase 1/2 | — | 🔴 Deferred |
| WorkspaceManager | git worktree 建立/合併/清理 | `workspace/workspace-manager.ts` | 🟢 |
| Scheduler | 定時喚醒 / 自動循環 | (index.ts 內) | 🟠 |
| SettingsStore | key/value 設定、enabled models | `settings/settings-store.ts` | 🟢 |
| AgentDetector | 偵測已安裝的 agent CLI | `detect/agent-detector.ts` | 🟢 |
| Gateway(WS) | request/response + 事件推播 + token 認證 + rate limit | `gateway/ws-gateway.ts` | 🟠 需加遠端能力矩陣(F3/F4) |
| StaticServer | 遠端瀏覽器 client 靜態檔 | `http/static-server.ts` | 🟢 |
| ConfigLoader | `~/.deskmony/config.json` 載入/驗證(拒收憑證欄位) | `config/load-config.ts` | 🟢 |

### 1.2 Adapters（`packages/adapters/src/`）

| 模組 | 職責 | 現況 | 狀態 |
|---|---|---|---|
| AgentAdapter 介面 + Capabilities | 統一 spawn/sendPrompt/events/interrupt/dispose + 能力探測 | `types.ts` | 🟠 需加 `usage` 能力/事件(E1) |
| AcpAdapter | Claude Code + **Codex**(ACP 收斂) | `acp-adapter.ts` | 🟠 需接 `usage_update`、從 git 反推 diff |
| ClaudeAgentSdkAdapter | Claude 深整合(hooks/subagent/細權限) | `claude-sdk-adapter.ts` | 🟠 需接 `result.usage` |
| OpenCodeAdapter | OpenCode HTTP + SSE（bespoke） | `opencode-adapter.ts` | 🟠 需接 usage |
| GenericPtyAdapter | 任意 CLI 直通（保底） | `pty-adapter.ts` | 🟠 **沙箱前唯讀**(C7) |
| team-bus MCP | agent 互傳訊息入口(send/broadcast/request_review/report_status) | `team-bus-mcp.ts` | 🟠 需綁 context(A5) |
| AdapterRegistry | 依 software 選 adapter | `registry.ts` | 🟢 |

### 1.3 Shared / DB

| 模組 | 職責 | 現況 | 狀態 |
|---|---|---|---|
| Shared schema(zod) | AgentProfile/Session/AgentEvent/Task/Team/Gateway… 型別 | `packages/shared/src/` | 🟠 加 `usage` 事件、policy 型別 |
| DB schema(Drizzle) | 9 張當前狀態表 + settings | `packages/db/src/schema.ts` | 🟠 加 audit-log 表(D5)、policy 持久化 |

### 1.4 Desktop UI（`apps/desktop/src/`）

| 模組 | 職責 | 現況 | 狀態 |
|---|---|---|---|
| ChatView / SessionView / SessionList | 單 agent 對話串 | ✅ | 🟢 |
| TeamChatView | 團隊群聊(觀察互傳) | ✅ | 🟠 顯示 context/熔斷狀態 |
| TaskBoardView | Kanban + 驗收/復原狀態 | ✅ | 🟠 加驗收閘 + 復原視圖 |
| TerminalView | xterm 終端 | ✅ | 🟢 |
| PermissionModal | 權限升級彈窗 | ✅ | 🟠 **加「這次/永遠允許」+ auto 按鈕 + YOLO 分離**(C4/C6) |
| SettingsDialog / ProfileCreateDialog / TeamManagementDialog | 設定/建 profile/團隊 | ✅ | 🟢 |
| ConnectScreen | 遠端連線 | ✅ | 🟠 能力受限提示(F3) |
| **RecoveryView** | 崩潰後任務分流 | — | 🔴 |
| **CostView** | usage/預算儀表 | — | 🔴 |
| stores(session/task/team) | Zustand 狀態 | ✅ | 🟠 加 cost/policy store |

---

## 2. 建構順序(切片 → Phase 1 → Phase 2)

> L2 grilling(2026-07-24)定案:排序原則**不是**「淨新增落差最大者先做」,而是**先證明脊椎、再逐層加厚**。

```
薄垂直切片(單 agent,有人看)
  └─> Phase 1:無人值守單 agent
        └─> Phase 2:團隊
              └─> Deferred:能力分層 / 遠端安全 / 沙箱
```

**通用原則:量測先於治理。** 很多 spec 有便宜的「量測/記錄半」與貴的「強制半」——把量測半提前,早拿可見性、替強制半除風險。套用於:usage(S3a 量測進切片 / S3b 治理 Phase 1)、稽核 log(記錄可早 / 依它強制晚)、訊息(先顯示 context 計數 / 熔斷 Phase 2)。

**關鍵定性**:Lead 是一個 **AgentProfile(prompt/設定),不是 Core 模組**;Core 淨新增的只是薄的 **dispose-gate**(收斂閘)。三斷路器共用的是一個 **Enforcement 底座**(Notifier / AuditLog / EnforcementEvent schema;S1 grill 精確化,原稱「EnforcementKernel 物件」),**隨 S1 一起出最小版**,避免 S1 先長出自己的升級/稽核再被 S2/S3b 拆掉;`escalate`(雙向)與 `trip`(單向)是建在底座上的兩條流程,不合併成單一介面。

> ⚠️ **S1 grill 揭露的路線圖修正(2026-07-24)**:**S12(沙箱)與 Phase 1 的「無人值守」承諾綁得比本文原先承認的更緊。** coding agent 大量使用 shell,而 shell 指令無法可靠分類 → default-deny 下會頻繁 escalate。故 **Phase 1 的無人值守 = 「無人值守 + 偶爾被 webhook 叫回來核可」**,而非「徹夜放著 shell agent 亂跑」;後者需要 S12。S12 維持 Deferred(Windows 沙箱是大工程,塞進 Phase 1 會讓它出不了貨),但它是 shell-heavy 低打擾無人值守的**前置條件**,不是可有可無的加強。詳見 [S1 HLD §4.1](../LAYER-3-hld/policy-engine_hld.md)。

## 3. 設計規格清單(每條 = 一份 L3 HLD)

| # | Spec(→ L3 HLD 檔名) | 對應模組 | 對應 L1 決策 | 建構階段 |
|---|---|---|---|---|
| **S3a** | `usage-metering_hld.md` | Adapters + AgentEvent + UI | E1 | **切片** |
| **S4** | `acceptance-gate_hld.md` | TaskService(最小可選) | A3 | **切片** |
| S1 | `policy-engine_hld.md` | PolicyEngine + **EnforcementKernel**(最小版) | C2–C6 | Phase 1 |
| S7 | `auto-mode-and-yolo_hld.md` | PermissionModal + PolicyEngine + Gateway | C6, F3–F4 | Phase 1 |
| S3b | `cost-governor_hld.md` | CostGovernor(+ EnforcementKernel) | E2–E3 | Phase 1 |
| S6 | `crash-recovery_hld.md` | RecoveryManager + SessionManager | D1–D4 | Phase 1 |
| S11 | `notification_hld.md` | Notification(+ EnforcementKernel) | 新增(無人值守帶外通知) | Phase 1 |
| S2 | `message-budget_hld.md` | MessageBus(+ EnforcementKernel) | A5 | Phase 2 |
| S8 | `agent-lifecycle_hld.md` | SessionManager | A4 | Phase 2 |
| S5 | `dispose-gate-and-lead_hld.md` | dispose-gate + Lead AgentProfile | A2, A1 | Phase 2 |
| S9 | `adapter-capability-tiering_hld.md` | Adapters | B2–B4 | Deferred |
| S10 | `remote-security_hld.md` | Gateway + StaticServer | F1–F4 | Deferred |
| S12 | `sandbox_hld.md` | SandboxManager | C7 | Deferred(named) |

> **跨切面**:S1/S2/S3b 三斷路器共用 **EnforcementKernel**(DECISIONS §0)。三者 HLD 必須引用 kernel 的統一「熔斷→回報」事件模型;Notification(S11)是該事件的帶外送達端。

---

## 4. 每份 L3 HLD 應回答的問題(模板)

1. **職責邊界**:這個模組負責什麼、不負責什麼。
2. **對外介面**:輸入事件 / 輸出事件 / 對 Core 其他模組的呼叫。
3. **狀態機 / 資料流**:核心狀態轉移圖或序列圖。
4. **失敗模式**:崩潰、逾時、對方不在線、預算耗盡時的行為。
5. **與 L1 決策的對應**:逐條標明實現了哪個 DECISIONS 條目。
6. **開放問題**:留給 L4 detail design 的細節。

---

> **下一步**:對本 L2 跑 `/grill-me` — 重點拷問「模組切分是否有遺漏/重疊」「S1–S10 的優先序與依賴是否正確」「哪些 🟠 改造其實該重寫而非改」。確認後才逐一展開 L3。
