# Layer-4:Detail Design 索引

> 上層約束:[`LAYER-3-hld/`](../LAYER-3-hld/)。L3 定「怎麼運作」,L4 定「精確到可實作」:演算法、資料 schema、邊界條件、並發/交易、錯誤碼。
> 每份 detail design 對應一份 L3 HLD。**草擬後單獨 `/grill-me` 確認,再往 L5 定 API。**

## Detail Design 清單(對齊 L3)

| 對應 HLD | Detail 檔案 | 需精確定義的東西(範例) | 狀態 |
|---|---|---|---|
| **S3a usage-metering** | [`usage-metering_detail.md`](./usage-metering_detail.md) | **✅ 已完成**。⚠️ 查證推翻 HLD schema 假設:ACP 給的是 context 計量表 + optional 累計 $,非 token 明細 → 事件拆成 `usage` / `context-usage` | ✅ |
| **S1 policy-engine** | [`policy-engine_detail.md`](./policy-engine_detail.md) | **✅ 已完成**。規則語法(commandEquals/Matches/pathUnder + realpath 防逃逸)、hard-deny 清單、Enforcement 底座 + `enforcement_audit` 表、逾時情境相依。**可獨立於 S7/S11 先上線** | ✅ |
| **S2 message-budget** | [`message-budget_detail.md`](./message-budget_detail.md) | **✅ 已完成**(Phase 2)。contextId 由 Core 注入(agent 不可指定)、訊息數為唯一主防線、broadcast 展開成 N 筆解決 per-recipient 送達狀態、注入與標記同交易 | ✅ |
| **S11 notification** | [`notification_detail.md`](./notification_detail.md) | **✅ 已完成**。Notifier 介面已就緒只差實作;批次(首次立即、之後彙總)、內容最小化、webhook 非授權通道、url 視同憑證需遮罩 | ✅ |
| **S3b cost-governor** | [`cost-governor_detail.md`](./cost-governor_detail.md) | **✅ 已完成**。⚠️ 實測改變資料來源:Claude Code 經 ACP 無用量 ⇒ **回合硬上限升格為該類後端唯一保護**;三層上限 + T1/T2 掛起處理 | ✅ |
| **S4 acceptance-gate** | [`acceptance-gate_detail.md`](./acceptance-gate_detail.md) | **✅ 已完成**。⚠️ 查證發現與既有「`updateStatus()` 不承擔語意」哲學的張力 → 分離 Runner(切片)與 Gate(Phase 2,收斂到 gateway 入口) | ✅ |
| S5 orchestrator-lead | `orchestrator-lead_detail.md` | lead prompt 契約、拆解輸出 schema、人/規則裁決介面 | ⬜ |
| **S6 crash-recovery** | [`crash-recovery_detail.md`](./crash-recovery_detail.md) | **✅ 已完成**。查證發現既有 shutdown handler 不標記 session ⇒ 正常關閉與崩潰無法區分;新增 `closed`/`interrupted` 狀態、5 秒逾時保護、「繼續 vs 接手」分別命名(各後端支援度**待實作時查證**) | ✅ |
| **S7 auto-mode-yolo** | [`auto-mode-and-yolo_detail.md`](./auto-mode-and-yolo_detail.md) | **✅ 已完成**。schema 收窄+遷移、`strong` 欄位(S1 已產生但傳不到 UI)、`rememberRule` 取代 `remember` 布林、YOLO 30 分過期、`LOCAL_ONLY_METHODS` + 握手 capabilities | ✅ |
| **S8 agent-lifecycle** | [`agent-lifecycle_detail.md`](./agent-lifecycle_detail.md) | **✅ 已完成**(Phase 2)。`lifecycle` 欄位 + 自動 spawn/dispose、**外部記憶檔案層**(`.deskmony/notes/` 進 git)、context 85% checkpoint 重啟(複用 S6「接手」);⚠️ 覆蓋率同成本斷路器 | ✅ |
| **S5 dispose-gate-and-lead** | [`dispose-gate-and-lead_detail.md`](./dispose-gate-and-lead_detail.md) | **✅ 已完成**(Phase 2)。⚠️ 查證發現「批准合併需人類」**既有程式碼已守住**;淨新增只剩①完成判定的機器裁決(S4 強制半)②Lead prompt 契約 | ✅ |
| **S12 session-subagents** | [`session-subagents_detail.md`](./session-subagents_detail.md) | **✅ 已完成**(2026-07-30)。Session 直接 spawn 子 session(`parentSessionId`)+ `session.spawnChild`(spawn 同時帶 prompt)+ 子完成回報父(`child-result` push + 父 session 歷史 system 訊息);**加法式,完全不動 team/看板**。**Phase 2 R1+R2+R3+R4+R5 已完成**(R1 子結果回注父 [`…phase2_detail.md`](./session-subagents-phase2_detail.md);R2 `spawn_subagent` MCP 工具讓 agent 自主 spawn [`…phase2-r2_detail.md`](./session-subagents-phase2-r2_detail.md);R3 UI 從 session 開子 agent + SessionList 巢狀顯示 [`…phase2-r3_detail.md`](./session-subagents-phase2-r3_detail.md);R4 `send_to_subagent` 工具讓父對已存在的子追加訊息 [`…phase2-r4_detail.md`](./session-subagents-phase2-r4_detail.md);R5 `list_subagents` 工具讓父查詢自己名下的子(含使用者手動開的)[`…phase2-r5_detail.md`](./session-subagents-phase2-r5_detail.md))。**2026-08-12 用真實 Claude 憑證補上 smoke test**(見各 detail 文件內附錄/§5-6):R2 工具無論是否明講工具名稱、agent 都能正確發現並呼叫 `spawn_subagent`/`list_profiles`,權限彈窗/子完成回報/注入回父全程正常;R3 UI 手動跑過建 profile → 建 session → 「開子 agent」→ 子完成 → 結果注入父對話全流程,SessionList 巢狀顯示正常;R4 手動跑過父對 idle 子追加訊息(round-trip 正常)+ 授權邊界(對非自己的子送訊息被正確拒絕);**R5 是實測真實 app 時發現的真實 bug 修復**——使用者在畫面上手動開子後問父「子用什麼 model」,父完全不知情、誤用了環境裡另一套不相干的工具,查明後補上 `list_subagents` 讓父能主動查詢,重現同一場景後驗證修好。⚠️ 過程中發現並修復一個**無關 S12 本身、但會擋下所有瀏覽器連線**的既有 bug:`auth` RPC 的 `token` schema 誤寫成 `z.string().min(1)`,导致 ConnectScreen 依畫面指示把 token 留空時,請求在 schema 驗證這關就被拒絕,連「未設定 authToken 時 auth 一律直接成功」的向下相容判斷都碰不到,使用者看到誤導的「認證失敗」——見 `packages/shared/src/gateway.ts` 的 `ClientRequestSchema` | ✅ |
| S9–S10 | (Deferred) | — | ⬜ |

> L4 完成度 = 「另一個工程師照著寫，不用問你」。凡此處還要猜的，退回 L3 補。
