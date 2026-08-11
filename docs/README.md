# Deskmony 文件分層(仿 SONiC / SAI 五層模型)

由上而下逐層具體化,**每層草擬後用 `/grill-me` 逐項確認再往下一層**。上層是下層的約束來源;下層不得與上層衝突,發現衝突要回上層改。

| 層 | 內容 | 對應 SONiC/SAI | 本專案檔案 | 狀態 |
|---|---|---|---|---|
| **L1** | Overall architecture — 總體架構與設計定案 | [SONiC Architecture](https://github.com/sonic-net/SONiC/wiki/Architecture) | [`ARCHITECTURE.md`](./ARCHITECTURE.md) + [`DECISIONS.md`](./DECISIONS.md) | ✅ 已 grill 定案(2026-07-24, 15 題) |
| **L2** | Design spec + 模組/功能清單 | [SONiC Design-Specs](https://github.com/sonic-net/SONiC/wiki/Design-Specs) | [`LAYER-2-design-spec.md`](./LAYER-2-design-spec.md) | 🟡 草擬完，待 grill |
| **L3** | 各模組 High-Level Design(HLD) | [sflow_hld.md](https://github.com/sonic-net/SONiC/blob/master/doc/sflow/sflow_hld.md) | [`LAYER-3-hld/`](./LAYER-3-hld/) | ⬜ 索引待填(逐模組 grill) |
| **L4** | 各模組 Detail Design | [SAI doc](https://github.com/opencomputeproject/SAI/tree/master/doc) | [`LAYER-4-detail-design/`](./LAYER-4-detail-design/) | ⬜ 索引待填 |
| **L5** | 實作 / Detail API definition | [SAI impl](https://github.com/opencomputeproject/SAI/tree/master) | [`LAYER-5-api/`](./LAYER-5-api/) | ⬜ 索引待填 |

## 逐層工作流

```
L1 定案 (✅)
  └─> L2 拆出「模組清單 + 設計規格清單(每條 = 一份 L3 HLD)」→ /grill-me 確認
        └─> 逐模組寫 L3 HLD(介面、狀態機、資料流、失敗模式)→ /grill-me 確認
              └─> 逐模組寫 L4 Detail Design(演算法、schema、邊界條件)→ /grill-me 確認
                    └─> L5 定 API 簽章 / 型別 / 契約 → /grill-me 確認 → 交 Sonnet subagent 實作
```

> 實作分工沿用既有模式:規劃/review 由 Opus 4.8 本體,實作與測試交 Sonnet 5 subagent。
