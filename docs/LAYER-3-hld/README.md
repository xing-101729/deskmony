# Layer-3:High-Level Design(HLD)索引

> 上層約束:[`LAYER-2-design-spec.md`](../LAYER-2-design-spec.md)。每份 HLD 對應 L2 §2 的一條 spec,回答 L2 §3 的六個問題(職責邊界 / 對外介面 / 狀態機資料流 / 失敗模式 / 對應 L1 決策 / 開放問題)。
> **逐份 HLD 草擬後,單獨用 `/grill-me` 確認,再往 L4 展開。**

## HLD 清單(依 L2 建構階段)

| Spec | HLD 檔案 | 對應模組 | 階段 | 狀態 |
|---|---|---|---|---|
| S3a | `usage-metering_hld.md` | Adapters + AgentEvent + UI(可見性) | **切片** | ✅ grill 定案 |
| S4 | `acceptance-gate_hld.md` | TaskService 機器驗收閘(最小可選) | **切片** | ✅ grill 定案 |
| S1 | `policy-engine_hld.md` | PolicyEngine + **Enforcement 底座**(最小版) | Phase 1 | ✅ grill 定案 |
| S7 | `auto-mode-and-yolo_hld.md` | PermissionModal + PolicyEngine + Gateway | Phase 1 | ✅ grill 定案 |
| S3b | `cost-governor_hld.md` | CostGovernor(+ 底座 trip) | Phase 1 | ✅ grill 定案 |
| S6 | `crash-recovery_hld.md` | RecoveryManager + SessionManager | Phase 1 | ✅ grill 定案 |
| S11 | `notification_hld.md` | Notification(升級帶外送達) | Phase 1 | ✅ grill 定案 |
| S2 | `message-budget_hld.md` | MessageBus context 預算/熔斷(+ 底座)· **含 Mailbox 持久化**(S6 移交,D4) | Phase 2 | ✅ grill 定案 |
| S8 | `agent-lifecycle_hld.md` | SessionManager 角色生命週期 · **含外部記憶(檔案層)** | Phase 2 | ✅ grill 定案 |
| S5 | `dispose-gate-and-lead_hld.md` | dispose-gate + Lead AgentProfile | Phase 2 | ✅ grill 定案 |
| S9 | `adapter-capability-tiering_hld.md` | Adapters 能力分層 | Deferred | ⬜ 待寫 |
| S10 | `remote-security_hld.md` | Gateway 遠端安全 | Deferred | ⬜ 待寫 |
| S12 | `sandbox_hld.md` | SandboxManager(PTY 圍堵) | Deferred | ⬜ 待寫 |

> ## ✅ 切片 + Phase 1 + Phase 2 的 10 份 HLD 全部 grill 定案(2026-07-24)
>
> Deferred 三份(S9/S10/S12)待需要時再寫。**下一步:進 L4 detail design / 交實作**,建議依建構順序從**切片(S3a + S4)**開始。
>
> **建構脊椎先行**:先做切片的 S3a → S4,讓單 agent 端到端能跑且看得到成本。
> 進 Phase 1 後先做 **S1(含 Enforcement 底座最小版)**——三斷路器(S1/S3b/S2)共用底座的「熔斷→回報」事件模型,S1 定型後 S3b/S2 才不返工。
