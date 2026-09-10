/**
 * SessionPermissionCoordinator —— 從 `SessionManager` 抽出的第一塊。
 *
 * ---- 為什麼抽 ----------------------------------------------------------
 *
 * 2026-09-03 的稽核把 `session-manager.ts`(當時 2,153 行)判定為典型的
 * God object,同時承擔至少 11 種彼此獨立的職責。更關鍵的是那份稽核的觀察:
 * **最嚴重的幾個 bug 全部出現在這個檔案裡,而且不是巧合** —— 當一個類別同時
 * 是「事件迴圈」「狀態機」「政策引擎的協調者」「多個斷路器的掛勾點」時,
 * 任何一處遺漏都很容易淹沒在其他職責的程式碼裡而不被注意到。
 *
 * 這個模組是「權限/政策」那一塊(稽核列的職責 4)。它是最適合先動的一塊:
 *   - 邊界清楚:只擁有 `permissionState` 這一份狀態,幾乎不碰 `runtime`
 *     (只需要問「這個 session 還在跑嗎」這個是非題)。
 *   - 價值高:它是安全罩三條線裡「權限」那一條的狀態機所在。
 *   - 可驗證:`scripts/e2e-policy-engine.mjs`(22 條)與
 *     `scripts/e2e-auto-mode-yolo.mjs`(23 條)幾乎完整覆蓋這裡的行為,
 *     抽出後行為有沒有跑掉,測得出來。
 *
 * ---- 這次刻意「只搬不改」--------------------------------------------------
 *
 * 所有方法的邏輯逐行照搬,連註解都原樣保留 —— 重構與修 bug 混在同一輪,會讓
 * 「測試掛了是因為搬壞了還是因為改壞了」變得無法區分。這一輪只證明「搬得動、
 * 搬完行為不變」。
 *
 * ---- 依賴倒轉的方式 ------------------------------------------------------
 *
 * 不反向持有 `SessionManager`(那只會把單向依賴變成循環)。需要向外要的東西
 * 全部走建構子傳入的 `deps`,而且刻意收斂成**最小的是非題與通知**:
 *   - `isSessionRunning`:原本是 `this.runtime.has(sessionId)`。
 *   - `onSessionStateChanged`:原本是 `void this.getSession(id).then(s => emit(...))`。
 *   - `emitPolicyUpdated`:原本是 `this.emit("policy-updated", push)`。
 * 這三個回呼就是這個模組對 `SessionManager` 的全部需求 —— 介面窄到這個程度,
 * 才算真的拆開,而不是把耦合換個地方藏。
 */

import { randomUUID } from "node:crypto";
import { DeskmonyError, ErrorCodes } from "@deskmony/shared";
import type { PolicyRule, PolicyAddRuleInput, PolicyUpdatedPush, Session, SessionPermissionMode } from "@deskmony/shared";
import type { PolicyEngine, ExecContext } from "../permissions/policy-engine.js";
import type { AuditLog } from "../enforcement/audit-log.js";
import type { Notifier } from "../enforcement/notifier.js";
import { appendPolicyRule, removePolicyRule as removePolicyRuleFile } from "../config/config-file-writer.js";

/**
 * S7(auto-mode-and-yolo)L4 §2:YOLO(`"auto-accept-all"`)的存活時間——過了
 * 這段時間,下一次權限決策前的惰性檢查會自動回落 `"always-ask"`(見
 * `checkAndExpireYolo()`)。**用惰性檢查、不用計時器**(L4 §2「過期檢查時機:
 * 每次 decide() 前惰性檢查」)。
 *
 * 可由 `DESKMONY_YOLO_DURATION_MS` 環境變數覆寫,**純粹是為了 e2e 測試能在
 * 合理時間內驗證「30 分鐘後過期」這條規則**,不是使用者可調整的偏好。
 */
export const DEFAULT_YOLO_DURATION_MS = 30 * 60_000;

/** S7:一個 session 目前的暫態權限模式(auto/YOLO)——只存在記憶體,不落地
 *  DB(見 packages/shared/src/agent-profile.ts 的 `SessionPermissionModeSchema`
 *  註解)。`yoloExpiresAt` 只有 `mode === "auto-accept-all"` 時有值。
 *  `trueUnrestricted`(2026-08-25 新增,見 docs/DECISIONS.md §G)只有
 *  `mode === "auto-accept-all"` 時可能為 `true`——`setMode()` 與
 *  `checkAndExpireYolo()` 都建構全新的 state 物件(不 spread 舊值),
 *  任何脫離 `"auto-accept-all"` 的 mode 變化都會自動、免額外程式碼地把這個
 *  欄位一併清掉;只有 `setTrueUnrestricted()` 刻意 spread 舊 state 只 patch
 *  這一個欄位,見該方法。 */
export interface SessionPermissionState {
  mode: SessionPermissionMode;
  yoloExpiresAt?: number;
  trueUnrestricted?: boolean;
}

/** 這個模組對外界的全部需求。見檔案頂端「依賴倒轉的方式」。 */
export interface SessionPermissionCoordinatorDeps {
  policyEngine: PolicyEngine;
  auditLog: AuditLog;
  notifier: Notifier;
  /** `<DESKMONY_HOME>/config.json` 的絕對路徑,政策規則寫回這裡。 */
  configPath: string;
  /** 見 `DEFAULT_YOLO_DURATION_MS`。 */
  yoloDurationMs: number;
  /** 原 `this.runtime.has(sessionId)` —— 只要一個是非題,不需要整份 runtime。 */
  isSessionRunning: (sessionId: string) => boolean;
  /** 原 `void this.getSession(id).then(s => this.emit("session-updated", s))`。 */
  onSessionStateChanged: (sessionId: string) => void;
  /** 原 `this.emit("policy-updated", push)`。 */
  emitPolicyUpdated: (push: PolicyUpdatedPush) => void;
  /** 環境事實:目前有沒有 client 連線 / 有沒有遠端 client。見 `buildExecContext()`。 */
  hasConnectedClient: () => boolean;
  hasRemoteClient: () => boolean;
}

export class SessionPermissionCoordinator {
  /** S7:每個 session 的暫態權限模式(auto/YOLO)——**刻意不落地 DB**
   *  (HLD §2:崩潰/重啟不復活,回落 `profile.permissionLevel`)。
   *  session 刪除時由 `clear()` 一併清除,避免無限增長。 */
  private readonly permissionState = new Map<string, SessionPermissionState>();

  constructor(private readonly deps: SessionPermissionCoordinatorDeps) {}

  /** session 建立/續接/checkpoint 重啟時,把暫態模式重設為 profile 的預設值。 */
  initialize(sessionId: string, mode: SessionPermissionMode): void {
    this.permissionState.set(sessionId, { mode });
  }

  /** session 刪除時呼叫,避免 Map 隨 session 生命週期無限增長。 */
  clear(sessionId: string): void {
    this.permissionState.delete(sessionId);
  }

  /**
   * ⚠️ 2026-08-25 修訂(見 docs/DECISIONS.md §G):**本機與遠端皆可呼叫**——
   * 已從 gateway 層的 `LOCAL_ONLY_METHODS` 移除(原 F3/C6 限制,使用者明確
   * 翻案)。這裡刻意仍不判斷連線來源(不是這個方法的職責)。
   * `mode === "auto-accept-all"` 時設定 30 分鐘後過期(惰性檢查,不用計時器,
   * 見 `checkAndExpireYolo()`)。
   *
   * 這裡建構的 `state` 物件永遠是全新的(不 spread 舊 state)——這個寫法本身
   * 就是「任何 mode 變化都會清掉 `trueUnrestricted`」的機制,見
   * `SessionPermissionState.trueUnrestricted` 註解。
   */
  setMode(sessionId: string, mode: SessionPermissionMode): SessionPermissionState {
    if (!this.deps.isSessionRunning(sessionId)) {
      throw new DeskmonyError(
        ErrorCodes.SESSION_NOT_RUNNING,
        { sessionId },
        `session 尚未啟動或已結束,無法設定權限模式: ${sessionId}`,
      );
    }
    const state: SessionPermissionState = { mode };
    if (mode === "auto-accept-all") {
      state.yoloExpiresAt = Date.now() + this.deps.yoloDurationMs;
    }
    this.permissionState.set(sessionId, state);
    // 讓所有已連線的 client(含觸發這次呼叫的那個)都能立即更新 UI 顯示的
    // 常駐標記(HLD §2.2 補償防護),不需要等下一次剛好有權限請求才會反映。
    this.deps.onSessionStateChanged(sessionId);
    return state;
  }

  /**
   * 2026-08-25 新增(見 docs/DECISIONS.md §G):在 YOLO 之上疊加/解除「真.無
   * 限制」層——`enabled:true` 時連 hard-deny 四類都會被繞過(見
   * apps/core/src/permissions/policy-engine.ts 的 `decide()` 短路)。**本機與
   * 遠端皆可呼叫**(比照 `setMode()`)。
   *
   * `enabled:true` 時強制檢查目前 `permissionMode` 必須已經是
   * `"auto-accept-all"`——不能讓呼叫端跳過 `setMode()` 直接開最高層級(這是
   * 「疊在 YOLO 之上」這個設計意圖的伺服器端保證,不只是 UI 上「YOLO 開了才
   * 顯示按鈕」的視覺層級)。`enabled:false` 永遠允許,不檢查前置條件——降級
   * 方向不該被擋。
   *
   * 與 `setMode()` 不同,這裡**刻意 spread 現有 state**只 patch
   * `trueUnrestricted` 這一個欄位。
   *
   * `isRemote` 由呼叫端(ws-gateway.ts)依連線本身判定後傳入,只用於稽核/
   * 通知內容,不影響是否放行這次呼叫本身。啟用時觸發稽核 + 桌面推播;
   * 關閉只寫稽核,不推播(回到安全方向不需要打斷使用者)。
   */
  setTrueUnrestricted(sessionId: string, enabled: boolean, isRemote: boolean): SessionPermissionState {
    if (!this.deps.isSessionRunning(sessionId)) {
      throw new DeskmonyError(
        ErrorCodes.SESSION_NOT_RUNNING,
        { sessionId },
        `session 尚未啟動或已結束,無法設定 true-unrestricted: ${sessionId}`,
      );
    }
    const current = this.permissionState.get(sessionId) ?? { mode: "always-ask" as const };
    if (enabled && current.mode !== "auto-accept-all") {
      throw new DeskmonyError(
        ErrorCodes.SESSION_TRUE_UNRESTRICTED_REQUIRES_YOLO,
        { sessionId },
        `session 必須先開啟 YOLO(auto-accept-all)才能啟用 true-unrestricted: ${sessionId}`,
      );
    }
    const state: SessionPermissionState = { ...current, trueUnrestricted: enabled };
    this.permissionState.set(sessionId, state);

    const ts = Date.now();
    this.deps.auditLog.appendTrueUnrestrictedToggle({ sessionId, enabled, isRemote, ts });
    if (enabled) {
      void this.deps.notifier.deliverTrueUnrestrictedEnabled({ sessionId, isRemote, ts }).catch((err) => {
        console.error(`[enforcement] deliverTrueUnrestrictedEnabled 失敗(不影響已生效的模式切換): ${String(err)}`);
      });
    }

    this.deps.onSessionStateChanged(sessionId);
    return state;
  }

  /**
   * 2026-08-25 新增(見 docs/DECISIONS.md §G):新增一條政策允許清單規則。
   * **本機與遠端皆可呼叫**。`id`/`addedBy`/`addedAt` 一律由這裡生成/填入,
   * `addedBy` 固定 `"user"`,與 rememberRule 路徑的 `"ui-remember"` 區分。
   *
   * 寫檔失敗就回滾 in-memory 那份——與 rememberRule 路徑刻意不同(那裡吞掉
   * 寫檔失敗只印警告):這支方法**唯一的目的**就是把規則持久化,吞掉失敗會讓
   * 呼叫端以為規則真的存在,重啟後卻悄悄消失。
   */
  addRule(input: PolicyAddRuleInput, isRemote: boolean): PolicyRule {
    const ruleId = randomUUID();
    const rule: PolicyRule = { ...input, id: ruleId, addedBy: "user", addedAt: Date.now() };
    this.deps.policyEngine.addRule(rule);
    try {
      appendPolicyRule(this.deps.configPath, rule);
    } catch (err) {
      this.deps.policyEngine.removeRule(ruleId);
      throw new DeskmonyError(
        "policy.addRuleWriteFailed",
        { detail: err instanceof Error ? err.message : String(err) },
        `新增政策規則失敗(寫入 config.json 失敗,已回滾): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    this.deps.auditLog.appendPolicyRuleChange({ action: "add", ruleId, rule, isRemote, ts: Date.now() });
    this.deps.emitPolicyUpdated({ action: "add", rule });
    return rule;
  }

  /**
   * 2026-08-25 新增:刪除一條政策允許清單規則(依 id)。id 不存在時回傳
   * `undefined`,不拋例外——呼叫端可能與另一個 client 對同一份清單並行操作,
   * 「已經被別人刪過了」不是錯誤。同樣是「寫檔失敗就回滾 in-memory」。
   */
  removeRule(id: string, isRemote: boolean): PolicyRule | undefined {
    const removed = this.deps.policyEngine.removeRule(id);
    if (!removed) return undefined;
    try {
      removePolicyRuleFile(this.deps.configPath, id);
    } catch (err) {
      this.deps.policyEngine.addRule(removed);
      throw new DeskmonyError(
        "policy.removeRuleWriteFailed",
        { detail: err instanceof Error ? err.message : String(err) },
        `刪除政策規則失敗(寫入 config.json 失敗,已回滾): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    this.deps.auditLog.appendPolicyRuleChange({ action: "remove", ruleId: id, rule: removed, isRemote, ts: Date.now() });
    this.deps.emitPolicyUpdated({ action: "remove", rule: removed });
    return removed;
  }

  /** `policy.listRules` RPC 用。 */
  listRules(): PolicyRule[] {
    return this.deps.policyEngine.getRules();
  }

  /**
   * 把暫態權限狀態貼到從 DB 讀出來的 `Session` 上。
   *
   * 刻意**不**在這裡做 YOLO 過期的惰性檢查——那個檢查只在
   * `checkAndExpireYolo()` 被呼叫的地方(權限決策當下)發生。
   */
  attachTo(session: Session): Session {
    const state = this.permissionState.get(session.id);
    if (!state) return session;
    return {
      ...session,
      permissionMode: state.mode,
      yoloExpiresAt: state.yoloExpiresAt,
      trueUnrestricted: state.trueUnrestricted,
    };
  }

  /**
   * S7 L4 §2.1:組出餵給 `PolicyEngine.decide()` 的 `ExecContext`。
   *
   * **三個欄位來自三個不同的來源,彼此正交**——這是 2026-07-28 修正的設計
   * 錯誤:初版把 `attended` 寫成 `autoMode` 的補數,等於把 2×2 壓成 1×2,
   * 讓「無人值守時掛起等人、不逾時 deny」那條規則變成死碼。
   */
  buildExecContext(state: SessionPermissionState): ExecContext {
    return {
      attended: this.deps.hasConnectedClient(),
      local: !this.deps.hasRemoteClient(),
      autoMode: state.mode !== "always-ask",
      // YOLO 與一般 auto 唯一的差別:是否連 config 的 deny-list 也繞過。
      yolo: state.mode === "auto-accept-all",
      // 2026-08-25 新增:唯一能讓 decide() 跳過 hard-deny 的欄位——
      // `state.trueUnrestricted` 只有在 mode 已經是 "auto-accept-all" 時才可能
      // 為 true(見 setTrueUnrestricted() 的前置條件檢查),這裡原樣傳遞。
      trueUnrestricted: state.trueUnrestricted === true,
    };
  }

  /**
   * S7 L4 §6:YOLO 30 分鐘惰性過期檢查——純粹的「檢查 + 必要時就地降級」,
   * 不做任何 I/O/emit(那些副作用由呼叫端在 `justExpired` 為 true 時自行處理)。
   * 找不到任何暫態記錄(理論上不會發生,`initialize()` 一定會設)時保守視為
   * `"always-ask"`。
   *
   * `downgraded` 是全新建構的物件(不 spread 舊 state)——YOLO 一到期,
   * `trueUnrestricted`(若曾經開啟)也跟著自動清除。
   */
  checkAndExpireYolo(sessionId: string): { state: SessionPermissionState; justExpired: boolean } {
    const state = this.permissionState.get(sessionId) ?? { mode: "always-ask" as const };
    if (state.mode === "auto-accept-all" && state.yoloExpiresAt !== undefined && Date.now() >= state.yoloExpiresAt) {
      const downgraded: SessionPermissionState = { mode: "always-ask" };
      this.permissionState.set(sessionId, downgraded);
      return { state: downgraded, justExpired: true };
    }
    return { state, justExpired: false };
  }
}
