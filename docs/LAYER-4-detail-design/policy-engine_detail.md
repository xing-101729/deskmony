# S1 Detail Design:PolicyEngine + Enforcement 底座

> 上層:[S1 HLD](../LAYER-3-hld/policy-engine_hld.md)｜階段:**Phase 1**(安全罩地基)
> 相關:[S7](../LAYER-3-hld/auto-mode-and-yolo_hld.md)(供 `ExecContext`)、[S11](../LAYER-3-hld/notification_hld.md)(送達端)
> L4 完成度標準:**另一個工程師照著寫,不用問你**。

---

## 0. 現況的確切整合點(已查證)

`apps/core/src/session/session-manager.ts:371–384`:

```ts
case "permission-request": {
  await this.setStatus(sessionId, "waiting");
  this.permissionGateway.register(sessionId, event.requestId, (sid, requestId) => {
    const rt = this.runtime.get(sid);
    if (rt) rt.adapter.resolvePermission(rt.handle, requestId, "deny");   // 逾時 → deny
    void this.setStatus(sid, "busy");
    this.emitPermissionResolved({ sessionId: sid, requestId, decision: "deny", source: "timeout" });
  });
  break;
}
```

**現況 = 無條件 escalate**(一律轉人 + 5 分鐘逾時 deny)。S1 要在 `setStatus("waiting")` **之前**插入 `decide()`:

```ts
case "permission-request": {
  const decision = policyEngine.decide(
    { sessionId, requestId: event.requestId, toolName: event.toolName, input: event.input },
    buildExecContext(sessionId),          // §4
  );
  auditLog.append({ kind: "decision", ... });          // 一律記錄,含自動放行

  if (decision.effect === "allow" || decision.effect === "deny") {
    runtime.adapter.resolvePermission(runtime.handle, event.requestId, decision.effect);
    this.emitPermissionResolved({ ..., source: "policy" });   // 沿用既有 source 欄位慣例
    break;                                              // ← 不進 waiting,agent 不停頓
  }
  // escalate / escalate-strong:維持現況路徑(waiting + register),逾時語意見 §6
  await this.setStatus(sessionId, "waiting");
  this.permissionGateway.register(...);
  break;
}
```

> **關鍵**:自動放行的路徑**完全不經過 `waiting` 狀態**——agent 不停頓,這正是 default-deny 之外「allowlist 換取自主」的價值所在。

---

## 1. 政策 schema(`~/.deskmony/config.json`)

擴充既有 `CoreConfigFileSchema`(`packages/shared/src/core-config.ts`)增加 `policy` 區塊:

```ts
policy: z.object({
  rules: z.array(z.object({
    /** 工具名;"*" 表示任意工具 */
    tool: z.string(),
    /** 選配細化條件,全部滿足才算 match */
    when: z.object({
      /** Bash 類:對指令字串做完整比對(非部分比對,見 §2) */
      commandEquals: z.string().optional(),
      /** Bash 類:正規表達式(需完整匹配,自動包 ^...$) */
      commandMatches: z.string().optional(),
      /** 檔案類:路徑必須位於此前綴之下(正規化後比對) */
      pathUnder: z.string().optional(),
    }).optional(),
    effect: z.enum(["allow", "deny"]),
    /** 可選:限定某個 agent profile / role */
    scope: z.object({ profileId: z.string().optional(), role: z.string().optional() }).optional(),
    /** UI「永遠允許」寫入時記錄來源,供稽核 */
    addedBy: z.enum(["user", "ui-remember"]).optional(),
    addedAt: z.number().optional(),
  })).default([]),
}).default({ rules: [] }),
```

**遠端不可改**:`policy` **不得**加入 `ConfigSetFilePatchSchema` 的安全子集(既有機制,core-config.ts L236–272)——與 `daemon.port`/`bindHost` 同等對待(F3/F4)。

**agent 不可寫**(C3):policy 在家目錄、worktree 外;且 §3 的 hard-deny 會擋掉對 `~/.deskmony/` 的寫入。

---

## 2. `decide()` 演算法

```ts
type PolicyEffect = "allow" | "deny" | "escalate" | "escalate-strong";
interface PolicyDecision { effect: PolicyEffect; reason: string; matchedRule?: number; }

decide(req: PermissionRequest, ctx: ExecContext): PolicyDecision
```

**優先序(HLD §3,不可調換)**:

| # | 判斷 | 結果 |
|---|---|---|
| 1 | 命中 **hard-deny**(§3) | 遠端 或 `autoMode` → `deny`;本機且 `attended` → `escalate-strong` |
| 2 | 命中 config `effect:"deny"` | `deny` |
| 3 | 命中 config `effect:"allow"` | `allow` |
| 4 | `ctx.autoMode`(S7) | `allow`(中間地帶自動放行) |
| 5 | 皆否 | **`escalate`**(default-deny) |

**比對規則(釘死,回答 HLD 開放問題 #1)**:
- `tool`:精確字串比對(或 `"*"`)。
- `commandEquals`:**完整字串相等**,trim 後比對。這是「永遠允許」的預設產物(最窄)。
- `commandMatches`:regex,**自動包 `^...$` 強制完整匹配**——避免 `npm test` 的 pattern 意外放行 `npm test; rm -rf /`。
- `pathUnder`:兩邊都做 `path.resolve()` + **`fs.realpathSync` 解析符號連結**(防 symlink 逃逸),再判斷前綴;必須以路徑分隔符為界(`/a/b` 不得匹配 `/a/bc`)。
- **規則依序比對,第一個 match 即決定**(deny 規則應排在 allow 之前——寫入時 deny 一律 unshift 到陣列前端)。

> **shell 的誠實限制(HLD §4)**:`commandMatches` 對 `bash -c "..."`、`$()`、base64 無能為力。**故 allowlist 只用來放行「你確認過的具體指令」,不用來做安全判斷**;安全來自 hard-deny + worktree 邊界 +(S12)沙箱。

---

## 3. Hard-deny 清單(內建,config 不可關 — F4)

寫死在 `apps/core/src/permissions/hard-deny.ts`:

| 類 | 判定(best-effort) |
|---|---|
| **worktree 外寫入/刪除** | 檔案類工具的目標路徑 realpath 後不在 `workspace.worktreePath` 之下 |
| **讀秘密路徑** | 路徑命中 `~/.ssh`、`~/.aws`、`~/.deskmony`、`**/.env*`、`**/id_rsa*`、`**/credentials` |
| **force-push / 危險 git** | 指令 regex 命中 `git push .*(--force|-f)\b`、`git push .*--delete`、`git branch -D` 於非 worktree 分支 |
| **非白名單外連** | 網路類工具的 host 不在 `policy.allowedHosts`(預設空 = 全擋) |

**判定失敗時的方向**:任何「無法確定是否命中」的情況(路徑解析失敗、指令無法解析)⇒ **不視為 hard-deny,但也不 allow ⇒ 落到 §2 第 5 步 `escalate`**。fail-safe 方向正確(問人),不 fail-open。

---

## 4. ExecContext 的來源

```ts
interface ExecContext { attended: boolean; local: boolean; autoMode: boolean; }
```

**Phase 1 初期(S7 尚未實作時)的取值**:
- `autoMode`:**恆 `false`**(session auto 按鈕是 S7 才有)。
- `attended`:`profile.permissionLevel === "always-ask"`(既有欄位)。
- `local`:**由 Core 依連線判定**,**絕不採信 client 自稱**。Phase 1 初期若尚無遠端 client,恆 `true`。

⇒ **S1 可獨立先上線**,不必等 S7;S7 上線後只是把 `autoMode` 接上真值。

> ✅ **S7 實作後的修正(2026-07-28,已實作)**:三個欄位的**正確**來源見 [S7 L4 §2.1](./auto-mode-and-yolo_detail.md)——三者**正交**:
> - `attended` **不是** `autoMode` 的補數(那會讓下方 §6 的「非 attended 掛起」變成死碼),而是由「**現在是否有 client 連線中**」推導(`WsGateway.hasConnectedClient()`)。
> - `local` 由「**是否無遠端 client 連線**」推導(`!WsGateway.hasRemoteClient()`,保守的整體判定)。
> - `autoMode` 由 session 暫態模式推導,與前兩者無關。
>
> 組裝點:`SessionManager.buildExecContext()`;Gateway 的兩個事實方法透過 `ClientPresencePort` 於 `index.ts` 事後注入(比照 `setTeamBus()`)。上方「Phase 1 初期的取值」段落**僅供歷史對照**,已不是現況。

---

## 5. Enforcement 底座(S1 grill 定案:底座,非單一 kernel)

新增 `apps/core/src/enforcement/`:

```ts
// events.ts —— 共用事件 schema(放 packages/shared/src/enforcement.ts)
type EnforcementEvent =
  | { kind: "decision";   sessionId; requestId; toolName; effect: PolicyEffect; reason; ts }
  | { kind: "escalation"; sessionId; requestId; toolName; strong: boolean; ts }
  | { kind: "trip";       source: "cost" | "message"; reason; targetIds: string[]; ts };

// audit-log.ts
interface AuditLog { append(e: EnforcementEvent): void; }   // append-only,見 §5.1

// notifier.ts —— S11 實作;S1 階段先給一個 no-op + console 版
interface Notifier { deliver(e: EnforcementEvent): Promise<void>; }
```

- **S1 只用 `decision` / `escalation` 兩種事件 + `AuditLog`**;`trip` 的 schema 一次定型供 S3b/S2 複用(**不合併成單一 kernel 物件**——`escalate` 雙向、`trip` 單向,形狀不同)。
- **`Notifier` 在 S1 階段可以是 stub**(只 console.log),S11 才接真通道。這讓 S1 不被 S11 阻塞。

### 5.1 AuditLog 的落地

新增 DB 表 `enforcement_audit`(append-only,D5):

```sql
CREATE TABLE enforcement_audit (
  id TEXT PRIMARY KEY, ts INTEGER NOT NULL, kind TEXT NOT NULL,
  session_id TEXT, request_id TEXT, tool_name TEXT,
  effect TEXT, reason TEXT, payload TEXT   -- 其餘欄位存 JSON
);
```
**只 INSERT,永不 UPDATE/DELETE**。切片的 usage 不落地(S3a),但**權限決策一律落地**——這是安全稽核的最低要求。

---

## 6. 逾時語意:情境相依(S11 §4 反向修正)

現況是無條件「逾時 → deny」。改成:

| 情境 | 行為 |
|---|---|
| `ctx.attended` | 維持現況:5 分鐘逾時 → `deny`(既有 `PermissionGateway` 邏輯不動) |
| **非 attended** | **不 deny**:session 維持 `waiting`,**取消逾時計時器**;等人回應。由 S3b 的 T1/T2 兜底(尚未實作前 = 一直等) |

**實作**:`PermissionGateway.register()` 增加一個 `timeoutMs: number | null` 參數,`null` = 不設計時器。**這是對既有 57 行空殼唯一需要的改動**(其餘邏輯照舊)。

> **這條分支曾一度是死碼**(2026-07-27 ~ 07-28):`attended` 被寫成 `autoMode` 的補數,`attended=false` 必然 `autoMode=true`,未分類請求在第 4 步就被放行,永遠走不到這裡。§4 的修正落地後才真正可達,對應 e2e:`scripts/e2e-policy-engine.mjs` 的 2f。
>
> **`attended` 是決策當下的瞬時快照**:一筆請求註冊時是否設計時器,之後不會因為 client 斷線/連上而回頭改寫(見下方失敗模式)。

---

## 7. 對 HLD 開放問題的回答

| HLD 開放問題 | L4 回答 |
|---|---|
| #1 match 語法精確度 | §2 已釘:`commandEquals`(預設最窄)/ `commandMatches`(強制 `^$`)/ `pathUnder`(realpath 防 symlink 逃逸) |
| #2 per-role 寬鬆度 | §1 的 `scope.role` 已支援;**Phase 1 不做繼承**,只做精確 scope 比對 |
| #3 S7 銜接 | §4 已定:`ExecContext` 三欄位,S7 只接 `autoMode` |
| #4 attended 逾時是否發 trip | **不發**。deny 已經記入 audit;發 trip 會讓 S11 的「trip 必送不節流」被權限逾時洗版 |

---

## 8. 實作檢查清單

- [ ] `packages/shared/src/core-config.ts`:加 `policy` 區塊;**確認不在 `ConfigSetFilePatchSchema` 安全子集內**
- [ ] `packages/shared/src/enforcement.ts`:`EnforcementEvent` schema
- [ ] `packages/db`:`enforcement_audit` 表 + 冪等建表(比照既有 `ensureTasksAcceptanceColumn` 作風)
- [ ] `apps/core/src/enforcement/audit-log.ts`、`notifier.ts`(stub)
- [ ] `apps/core/src/permissions/hard-deny.ts`:§3 清單
- [ ] `apps/core/src/permissions/policy-engine.ts`:`decide()`,§2
- [ ] `apps/core/src/permissions/permission-gateway.ts`:`register()` 加 `timeoutMs: number | null`
- [ ] `apps/core/src/session/session-manager.ts`:§0 的 hook
- [ ] e2e:allow 自動放行(**不進 waiting**)、deny 自動拒絕、hard-deny 即使 autoMode 也 deny、未分類 escalate、非 attended 不逾時、audit 有落地

---

> **下一步**:對本 L4 跑 `/grill-me`(重點 §3 hard-deny 判定的可靠性、§2 規則排序、§5.1 稽核表設計),或直接交實作。
