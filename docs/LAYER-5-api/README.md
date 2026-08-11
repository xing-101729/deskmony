# Layer-5:實作 / Detail API Definition 索引

> 上層約束:[`LAYER-4-detail-design/`](../LAYER-4-detail-design/)。L5 是可直接落碼的契約:TypeScript 介面/型別、zod schema、事件簽章、Gateway request/response 方法、DB migration。
> **這是交給 Sonnet 5 subagent 實作前的最後一關**;`/grill-me` 確認 API 契約後即可實作。

## API / 契約清單

| 對應模組 | API 檔案 | 內容 | 落地位置 | 狀態 |
|---|---|---|---|---|
| PolicyEngine | `policy-engine_api.md` | `PolicyEngine` 介面、`PolicyDecision` 型別、config.json policy schema | `apps/core/src/permissions/` | ⬜ |
| MessageBus | `message-bus_api.md` | `send/broadcast` 簽章 + context/budget 參數、Mailbox 表 migration | `apps/core/src/bus/`, `packages/db/` | ⬜ |
| CostGovernor | `cost-governor_api.md` | `usage` AgentEvent 型別、`CostGovernor` 介面、預算設定 schema | `packages/shared/`, `apps/core/src/` | ⬜ |
| Adapters | `adapter_api.md` | `AgentAdapter` 介面補 `usage`、capabilities 擴充 | `packages/adapters/src/types.ts` | ⬜ |
| TaskService | `acceptance_api.md` | 驗收條件型別、Task 狀態機 API | `apps/core/src/tasks/` | ⬜ |
| Orchestrator | `orchestrator_api.md` | lead 工具契約、拆解輸出 zod schema | `apps/core/src/`, `packages/adapters/` | ⬜ |
| Recovery | `recovery_api.md` | 復原視圖 Gateway 方法、對帳 API | `apps/core/src/gateway/` | ⬜ |
| Gateway 遠端 | `remote-capability_api.md` | 遠端能力矩陣枚舉、被拒方法清單 | `apps/core/src/gateway/`, `packages/shared/gateway.ts` | ⬜ |

## Migration 追蹤

| Migration | 內容 | 對應 |
|---|---|---|
| `NNNN_add_mailbox_persistence` | Mailbox 未送訊息持久化 | S2/D4 |
| `NNNN_add_audit_log` | append-only 訊息+權限決策稽核 log | D5 |
| `NNNN_add_policy_store` | policy 持久化(若不放純 config.json) | S1 |
| `NNNN_add_usage_columns` | session/task 的 usage 聚合欄位 | S3 |

> API 定稿 → `/grill-me` 過關 → 才交 Sonnet subagent 實作 + 測試(規劃/review 留 Opus 本體)。
