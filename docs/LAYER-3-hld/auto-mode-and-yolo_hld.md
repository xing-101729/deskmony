# S7 HLD:Auto Mode / YOLO / 遠端能力矩陣

> 階段:**Phase 1**｜對應 L1:**C4、C6、F3–F4**｜上層:[L2 §3](../LAYER-2-design-spec.md)、[DECISIONS §C/§F](../DECISIONS.md)
> 定位:S1 擁有**政策規則**;S7 擁有**「此刻是什麼情境」與人機互動**——供給 `ExecContext`、實作三種確認 UX、以及遠端能力矩陣。
> 前置:[S1 HLD](./policy-engine_hld.md)(`decide(request, ctx)` 與 `escalate-strong` 由此定義)。

---

## 0. 現況掛點(已查證)

| 既有物 | 現況 | S7 用途 |
|---|---|---|
| `AgentProfile.permissionLevel`(`always-ask`/`auto-accept-edits`/`auto-accept-all`) | **死欄位**——schema/DB/CRUD 都有,但**無任何決策端讀取** | 成為 session auto 狀態的**預設值來源**。⚠️ **`auto-accept-all` 將被移出可持久值**(§2.1) |
| `PermissionDecision.remember`(events.ts:115) | 已定義,**無消費端** | 成為 C4「永遠允許」→ 寫 allowlist 的入口 |
| `PermissionModal.tsx` | 只有 allow/deny 兩鈕 | 擴充成三種確認 UX(§3) |

> 換句話說:**三態的資料模型早就在,只差引擎與 UI**。S7 不是憑空新增概念,是把死欄位接活。

---

## 1. 職責邊界

**負責**:
- **session auto 暫態**:每 session 一個 auto 開關(按鈕),**ephemeral、不寫 config**(C6)。
- 組出 `ExecContext { attended, local, autoMode }` 餵給 S1 的 `decide()`。
- **三種確認 UX**:一般 escalate / `escalate-strong`(hard-deny 覆寫)/ YOLO 啟用確認。
- **「永遠允許」**:把 `remember` 決策寫回 config allowlist(C4 三紀律)。
- **遠端能力矩陣**:哪些操作遠端不可為(F3/F4)。

**不負責**:
- ❌ 政策規則本身、hard-deny 清單、決策優先序(→ S1)。
- ❌ 通知送達(→ S11)。

---

## 2. 三個層級與 ExecContext

```
profile.permissionLevel(持久,預設值)
        │  session 建立時作為初值
        ▼
session auto 狀態(暫態,按鈕可切;不寫 config)  ──┐
                                                  ├─> ExecContext ─> S1.decide()
連線來源(本機 console / 遠端 client)         ──┘
```

| 層級 | 語意(對應 C6) | 持久性 |
|---|---|---|
| `always-ask` | 未分類 → escalate(default-deny) | profile 預設 / session 可切 |
| **auto**(`auto-accept-edits`) | **只把「未分類中間地帶」轉 allow**;**hard-deny 類仍走 S1 步驟 1** | profile 預設 / session 暫態 |
| **YOLO**(`auto-accept-all`) | 繞過一切(僅本機、強確認、遠端禁用) | **僅 session 暫態,不可持久化**(§2.1),且**會過期**(§2.2) |

- `attended` = `permissionLevel === "always-ask"` 且非 auto/YOLO。
- `local` = **由 Core 依連線本身判定**(見 §5),絕不採信 client 自稱。
- **auto/YOLO 皆 session 暫態**:session 結束即消失,**不寫 config.json**;唯一會寫持久政策的是「永遠允許」(§4)。

### 2.1 `auto-accept-all` 不可持久化(S7 grill 定案)

**問題**:`permissionLevel` 是存 DB 的持久欄位。只要 `auto-accept-all` 能存進 profile,使用者就能建一個**每次 spawn 都自動 YOLO 的 agent**——完全繞過 C6 的「永不預設 / 更難按到 / session 暫態」全部防護,而且**跨重啟存活**,比 session 暫態危險一個量級;崩潰重啟後會**自動復活成最危險狀態**,與安全罩 fail-safe 方向相反。

**定案**:**profile 層只接受 `always-ask` / `auto-accept-edits`**;`auto-accept-all` 僅存在於 session 暫態,**不進 DB**。

- 理由:C6 的紀律本質是「**YOLO 必須是刻意的、當下的動作**」——持久化它,在定義上就摧毀了這個紀律。
- `auto-accept-edits` 當持久預設**已足夠**涵蓋「我信任這個 agent」的正當需求(自動放行中間地帶、hard-deny 仍守),且不會裸奔。
- **破壞性 schema 收窄**:`PermissionLevelSchema` 的可持久值需收窄。**遷移**:既有 profile 若已存 `auto-accept-all`,遷移時**降級為 `auto-accept-edits`** 並告知使用者。(L4/L5 處理。)

### 2.2 過期規則:與風險等級相稱(S7 grill 定案)

堵住持久化後仍有側門:**開了忘了關**。定案採「**只有 YOLO 過期,auto 不過期**」:

| | 過期? | 理由 |
|---|---|---|
| **YOLO** | ✅ **必須過期**(時限留 L4,建議 30–60 分或「本回合結束即關」) | 正當用途本就是「我現在盯著,讓它衝一段」;**不存在「YOLO 開一整天」的合理場景**。過期 = 把「刻意的當下動作」語意在時間軸上也守住。到期回落 `always-ask` 並通知。 |
| **auto** | ❌ 不強制過期 | 它正是設計來支撐長時間自動運行的(Phase 1 無人值守主力模式)。強制過期會打斷正當用途,反而逼人去開 YOLO 或狂點,**適得其反**。 |

**補償防護**:auto 開啟狀態**必須在 UI 持續可見**(session 標頭常駐標記),讓「忘了關」至少是**可見的**,而不是隱形的。

---

## 3. 三種確認 UX(視覺與行為必須可區分)

| 種類 | 觸發 | 選項 | 可 remember? |
|---|---|---|---|
| **一般 escalate** | 未分類長尾(default-deny) | 這次允許 / **永遠允許** / 拒絕 | ✅ 寫 allowlist |
| **escalate-strong** | hard-deny 類 + 本機 + attended(S1 §3) | 這次允許(**需更強確認**)/ 拒絕 | ❌ **永不提供**(C4 紀律③) |
| **YOLO 啟用確認** | 使用者要開 YOLO | 啟用 / 取消 | — |

**設計要求**:
- `escalate-strong` **必須與一般核可視覺明顯區隔**(不同色、警示語、說明「這是硬性禁止項」),且**不可**一鍵誤觸——避免疲勞點擊把 hard-deny 點掉。
- YOLO 按鈕**不與 auto 按鈕相鄰**、需獨立更強確認(C6:「更難按到」)。
- **auto 按鈕是 session 內的**(如 ChatView 標頭),不是全域設定——避免「一次開全部」。

---

## 4. 「永遠允許」→ allowlist(C4 三紀律落地)

```
使用者按「永遠允許」
  → S7 提議**最窄**規則,在確認框顯示「你將永遠允許:<規則>」
  → 使用者確認 / 改選更寬的候選          ★ 半自動,見下
  → PermissionDecision { decision:"allow", remember:true, rule }
  → 寫入 ~/.deskmony/config.json 的 policy.rules(紀律②:同一份人類可讀檔)
  → 之後同類請求由 S1 直接 allow
```

**窄規則推導 = 半自動,預設最窄(S7 grill 定案)**:

| 做法 | 判定 |
|---|---|
| 全自動記整條字串 | ❌ 幾乎學不到東西(參數差一字就再問),使用者被磨到去**手改 config 放寬**——把有意識的小決定變成不受控的大決定 |
| 全自動猜參數化 | ❌ 系統**靜默替使用者擴大授權**,而使用者以為只允許了剛才那條——正是 C4 要防的 |
| **半自動:提議 + 使用者確認範圍** | ✅ **採用** |

- 確認框顯示提議規則(**預設精確匹配**),旁附 1–2 個更寬候選(如「所有 `pnpm test *`」),使用者可當場選。
- **紀律①的真正精神不是「機械式地窄」,而是「擴大授權必須是有意識的」**——預設窄,不做選擇的人自動得到最安全的結果;要更寬則需明確點選,授權範圍在眼前。
- 選定規則的原文寫進 config,人類可讀、可事後稽核砍掉(紀律②)。
- **紀律②(單一來源)**:UI 寫的與手改的落在**同一份** `config.json`,可稽核、可砍。UI 不是另一套隱藏狀態。
- **紀律③(hard-deny 不可學習)**:`escalate-strong` 不提供「永遠允許」。

---

## 5. 遠端能力矩陣(F3/F4)

| 操作 | 本機 | 遠端 |
|---|---|---|
| 觀察、送 prompt | ✅ | ✅ |
| 逐一核可/拒絕一般 escalate | ✅ | ✅ |
| **hard-deny 覆寫(escalate-strong)** | ✅ | ❌ **直接 deny,不呈現** |
| **切換 session auto mode** | ✅ | ❌ |
| **啟用 YOLO** | ✅ | ❌ |
| 改 allowlist / 政策、建改 agent profile | ✅ | ❌ |
| 改預算上限、改綁介面 | ✅ | ❌ |

**執行點(S7 grill 定案:握手能力集 + Gateway 硬拒)**:

1. **Gateway 每次 method 檢查**是唯一的安全保證——遠端送來被禁 method 一律拒絕 + 記稽核。UI 隱藏只是體驗,**不構成保證**(token 外洩者會直接打 WS API,完全不經過你的 UI)。
2. **認證成功後,Gateway 主動回傳能力集**:`capabilities: { canOverrideHardDeny, canToggleAuto, canEnableYolo, canEditPolicy, ... }`,UI **純依此渲染**。這只多一個握手欄位,卻消掉一整類 bug:**UI 與 Gateway 對「什麼能做」的認知漂移**。
3. **`local` 判定寫死規則**:**只能由 Core 依連線本身判定**(loopback / 隧道來源),**絕不採信 client 自稱**——否則整個矩陣可被一個欄位偽造繞過。

**原則**:遠端能在安全罩內幹活,但不能改動安全罩本身(F4)。

---

## 6. 失敗模式

| 情境 | 行為 |
|---|---|
| session 崩潰/重啟 | auto/YOLO 暫態**消失**,回落 profile 預設(fail-safe:不會「復活成 auto/YOLO」;§2.1 已確保 profile 不可能是 YOLO)。 |
| 同一 session 同時有本機與遠端 client | 以**該決策回應來源**判定 `local`;被禁操作即使 UI 顯示也在 Gateway 被拒。 |
| 遠端送出被禁 method | Gateway 拒絕 + 記稽核(可能是 token 外洩訊號)。 |
| auto 開著但撞到 hard-deny | 走 S1 步驟 1 → **deny**(auto 下 hard-deny 是硬地板,不降級為 escalate-strong)。 |
| YOLO 到期 | 回落 `always-ask` + 通知(§2.2)。 |
| 遷移:既有 profile 存有 `auto-accept-all` | **降級為 `auto-accept-edits`** 並告知使用者(§2.1)。 |

---

## 7. 開放問題(留給 L4)

1. **YOLO 時限的具體值**:30 分?60 分?或「本回合結束即關」?(§2.2 已定「必須過期」,只差數值。)
2. **窄規則的候選生成**:確認框要提議哪 1–2 個「更寬候選」?如何從一次 Bash 請求生成合理的參數化候選?(與 S1 §8.1 match 語法同一議題。)
3. **能力集 schema**:握手回傳的 `capabilities` 具體欄位集與版本相容策略。
4. **auto 常駐可見標記的 UI 位置**:session 標頭?全域列出所有開著 auto 的 session?

---

> **S7 grill 已完成(2026-07-24)**,4 項定案:
> ① **`auto-accept-all` 不可持久化**——profile 只接受 `always-ask`/`auto-accept-edits`,YOLO 僅 session 暫態(破壞性 schema 收窄 + 既有資料降級遷移)。
> ② **只有 YOLO 過期,auto 不過期**——過期規則與風險等級相稱;auto 以「UI 常駐可見」補償。
> ③ **握手能力集 + Gateway 硬拒**——UI 依 Gateway 回傳的 capabilities 渲染;`local` 只由 Core 依連線判定,絕不採信 client 自稱。
> ④ **窄規則半自動**——系統提議最窄、使用者確認範圍;精神是「擴大授權必須有意識」,而非機械式地窄。
> **下一步**:S11(Notification,底座送達端)或 S3b(成本治理);或 S1/S7 一起進 L4。
