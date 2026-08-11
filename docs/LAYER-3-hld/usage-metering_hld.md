# S3a HLD:Usage 量測(Usage Metering)

> 階段:**切片**｜對應 L1:**E1**｜上層:[L2 §3](../LAYER-2-design-spec.md)、[DECISIONS §E](../DECISIONS.md)
> 定位:安全罩「成本」斷路器的**量測半**。本 HLD **只管把 token 用量攤在陽光下**,**不做**任何預算/熔斷(那是 S3b)。體現「量測先於治理」。

---

## 1. 職責邊界

**負責**:
- 定義統一的 `usage` AgentEvent(token 用量),讓各 adapter 把後端回報的用量正規化後吐出。
- 讓 UI 在切片階段(單 agent、有人看)就能**看到每個 session 燒了多少 token**。
- 提供 S3b 治理所需的**量測資料基礎**(但不含任何門檻邏輯)。

**不負責**(明確劃出去):
- ❌ token → 金額($)換算(需 price table → S3b)。
- ❌ 預算、上限、kill-switch、熔斷(→ S3b)。
- ❌ 每任務精準歸屬(一個 session 可能橫跨多任務 → 開放問題,S3b/S8 處理)。
- ❌ **持久化 / 稽核 log / 權威跨 session 累計**(切片純 ephemeral,reload 歸零 → S3b)。
- ❌ PTY 用量(結構上報不了,見 §4)。

---

## 2. 對外介面

### 2.1 新增 `UsageEvent`(擴充 `packages/shared/src/events.ts`)

> ⚠️ **本節的 schema 已被 L4 查證推翻並修正** —— ACP 的 `usage_update` 實際給的是 `{ used, size, cost? }`(context 計量表 + optional 累計 $),**不是** token 明細。
> **以 [L4 detail design](../LAYER-4-detail-design/usage-metering_detail.md) 為準**:事件拆成 `usage`(累計花費,可 diff)與 `context-usage`(gauge,會浮動)兩個。下方保留原始設計意圖供對照。

在 `AgentEventSchema` discriminated union 增加一個成員:

```ts
export const UsageEventSchema = z.object({
  type: z.literal("usage"),
  /** 累計值(cumulative,每條 adapter 連線內單調遞增);消費端相鄰相減得 delta。見 §3 */
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  /** prompt caching(有回報才填,缺就 undefined,不編零) */
  cacheReadTokens: z.number().optional(),
  cacheCreationTokens: z.number().optional(),
  /** 此用量對應的 model(回合中 setModel 換過時用於消歧;knowable 就填) */
  model: z.string().optional(),
});
```

> `estimated` 欄位**刻意不加**(切片無估算來源,YAGNI;日後要加是非破壞性 optional 變更)。

- 沿用既有的 `SessionEventEnvelope`(`{sessionId, event, timestamp}`)攜帶 → 天然帶到 sessionId 與時間,不需新管線。
- **欄位缺失一律 `undefined`,絕不填 0**——「沒回報」與「用了 0」語意不同,S3b 聚合時必須能分辨。

### 2.2 擴充 `AdapterCapabilities`(`adapter-capabilities.ts`)

新增一個 flag:

```ts
/** 是否會回報 token 用量(usage 事件) */
usageReporting: z.boolean(),
```

UI 依此決定「顯示用量」還是「用量不可得」。

### 2.3 各 adapter 的來源對接

| Adapter | 來源 | 切片? | usageReporting |
|---|---|---|---|
| **AcpAdapter** | ACP `usage_update` 通知(acp-adapter.ts:46 目前 TODO 未接) | ✅ 切片必做 | true |
| ClaudeAgentSdkAdapter | SDK result message 的 `result.usage` | Phase later | true |
| OpenCodeAdapter | OpenCode 的 usage 事件 | Phase later | true |
| GenericPtyAdapter | 無 | — | **false** |

> 切片只需 **AcpAdapter** 接上 `usage_update`;其餘 adapter 的對接可延後,但 `UsageEvent` 與 capability flag 一次定型,避免日後 schema 漂移。

---

## 3. 資料流與量測語意(S3a grill 定案)

```
後端(Claude Code via ACP)
  │  usage_update 通知(回合中多次)
  ▼
AcpAdapter ── 累加、回合末吐一次當前累計 ──> UsageEvent(cumulative)
  │  events() AsyncIterable
  ▼
SessionManager ── 包 SessionEventEnvelope ──> Gateway(WS push)
  ▼
UI(SessionList / CostView 雛形)
  即時 diff 相鄰累計得 delta、顯示本 session 累計 in/out、by model
  ★ 切片純 ephemeral:不進 DB、不寫稽核 log,reload 歸零
```

**量測語意(定案)**:
- **payload = 累計值**(cumulative,每條 adapter 連線內單調遞增),**不是 delta**。選累計的理由:usage best-effort 可遺失,而**累計遺失自癒**(下一個事件帶真總量),對日後餵預算的 S3b,少算比多算危險,必須選安全方向。消費端**相鄰相減**即得 delta(保留時間窗/任務歸屬能力)。
- 只給累計的後端(SDK `result.usage`)→ adapter **直接吐,不需轉 delta**(反而省事)。逐次的 ACP `usage_update` → adapter 累加後吐當前累計。
- **發射時機 = 回合末一次(切片)**:adapter 累加回合中的 usage_update,在 `completed` 前吐一個最終累計。一回合一事件,流量最省。
  - ⚠️ **Phase 1 起改為 mid-turn 高頻發射**([S3b §3.1](./cost-governor_hld.md) 定案):回合末發射會讓成本斷路器的**保護粒度變成「一個回合」**——單一超長回合可燒掉數倍上限而擋不住。S3b 要求 ACP adapter 收到 `usage_update` 即轉發累計事件。**此升級 schema 不變**(這正是選累計 payload 預留的路徑),只是 adapter 多發幾次。
- **切片 = 純 ephemeral**:UI 從累計流即時算、顯示,**不落地**。持久化(稽核 log D5)+ 權威 rollup + 每任務歸屬,全部延到 **S3b**。
- **跨重連重置規則**:消費端見「**新累計 < 上次累計 = 重置**」→ 起新段、**不做負 diff**;是否在事件上加 segment/connection id 更穩健,留 L4。

---

## 4. 失敗模式

| 情境 | 行為 |
|---|---|
| 後端完全不報用量(PTY) | `usageReporting:false`;UI 顯示「用量不可得」,不猜、不估。 |
| 後端只報部分欄位(如只有 output) | 缺的填 `undefined`,不編零。 |
| 回合以 error/interrupt 收場(無乾淨 completed) | adapter **盡力補發最後已知累計**再結束,避免整回合用量憑空消失。 |
| usage_update 中途遺失 | 允許遺失——量測 best-effort、不在關鍵路徑;**累計 payload 自癒**,下一個事件帶真總量,自動修正。**不因量測遺失 block agent**。 |
| 跨重連 session 恢復 | 累計歸零 → 消費端「新<舊 = 重置」規則起新段、不做負 diff(見 §3)。切片 ephemeral,歷史不還原;S3b 才由稽核 log 還原。 |

---

## 5. 對應 L1 決策

- **E1**(做 usage 量測):本 HLD 即 E1 的量測半。
- **L2「量測先於治理」**:S3a 純量測、零門檻;治理(E2/E3)全部推到 S3b。
- **E4**(上限反應式、非精準):量測 best-effort、可遺失、可延遲,呼應「框住損害非精準防超支」——量測本身不保證即時精確,S3b 的上限也因此是反應式的。
- **D5**(稽核 log):**切片不落地**;S3b 才把 UsageEvent 落 append-only 稽核 log,供事後成本歸因。

---

## 6. 開放問題(留給 L4 / S3b)

1. **每任務歸屬**:一個 session 橫跨多任務時,如何把相鄰 diff 出的 delta 切給正確任務?(牽涉 S8 lifecycle;切片單 agent 單任務可先忽略。)
2. **segment/connection id**:跨重連的重置目前靠「新<舊」啟發式偵測;是否在事件或 envelope 上加明確 segment id 更穩健?(L4 定。)
3. **price table 放哪**:token→$ 換算表(S3b 才需要)放 config.json 還是內建 known-models?牽涉 `known-models.ts` 既有結構。
4. **UI 呈現粒度**:切片只需「本 session 累計 + by model」;是否要 per-turn 明細留待 CostView(S3b)。

---

> **S3a grill 已完成(2026-07-24)**,4 項定案:①payload 帶累計非 delta ②切片純 ephemeral、持久化延 S3b ③回合末發一次 + error/interrupt 補發 ④砍 estimated、保留 model+cache。
> **下一步**:進 S4(acceptance-gate)HLD;或進 S3a 的 L4 detail design(釘 segment id、累計錨點、UI store 結構)。
