/**
 * PermissionGateway(ARCHITECTURE.md 3.3 節):
 *   「各 adapter 的權限請求統一收斂到這裡 → UI 彈窗或依 policy 自動核可」
 *
 * M1 範圍:
 *   - 收斂 SessionManager 轉發過來的 permission-request(來自 adapter)
 *   - 記錄 requestId -> sessionId 對應,等待 UI 透過 Gateway 回覆
 *   - 逾時處理:超過 timeoutMs 未回覆時,自動視為拒絕(deny),避免 agent 卡死
 *
 * S1(PolicyEngine)新增:逾時語意改成情境相依(見
 * docs/LAYER-4-detail-design/policy-engine_detail.md §6)——`register()` 這輪
 * 加一個 `timeoutMs: number | null` 參數,由呼叫端(session-manager.ts)依
 * `ExecContext.attended` 決定:
 *   - attended(有人看):傳入具體毫秒數,維持既有「逾時 → deny」行為不變。
 *   - 非 attended(無人值守):傳入 `null` = **不設計時器**,session 維持
 *     `waiting` 直到有人回應——無人值守的前提就是你不在,把「沒人回應」解讀
 *     成「拒絕」會讓整晚工作白費(逾時止損改由之後的 S3b 成本/時間預算負責)。
 * 這是這輪對既有 57 行空殼**唯一**需要的介面改動,其餘邏輯(pending 追蹤、
 * resolve()、reject 回呼)照舊不動。
 */

const DEFAULT_TIMEOUT_MS = 5 * 60_000; // 5 分鐘

interface PendingPermission {
  sessionId: string;
  /** S7(auto-mode-and-yolo)L4 §4 新增:這筆請求當初是否為 escalate-strong
   *  (hard-deny 命中降級的強確認)——`resolve()` 回傳時一併帶出,供
   *  `SessionManager.resolvePermission()` 做「escalate-strong 不得帶
   *  rememberRule」的強制檢查(C4 紀律③,見 session-manager.ts)。 */
  strong: boolean;
  /** `undefined` = 這筆請求註冊時 `timeoutMs` 傳的是 `null`(非 attended,不設
   *  計時器),見上方檔案頂端說明。 */
  timer?: ReturnType<typeof setTimeout>;
}

/** `resolve()` 的回傳形狀——見上方 `PendingPermission.strong` 註解。 */
export interface ResolvedPendingPermission {
  sessionId: string;
  strong: boolean;
}

export class PermissionGateway {
  private pending = new Map<string, PendingPermission>();

  /** `defaultTimeoutMs` 是公開的(見 core-config.ts 的 `daemon.permissionTimeoutMs`
   *  合併後的值)——session-manager.ts 在 `ctx.attended` 為 true 時,用這個值
   *  當作 `register()` 的 `timeoutMs` 引數,不需要另外把 timeout 設定重複傳一次。 */
  constructor(public readonly defaultTimeoutMs: number = DEFAULT_TIMEOUT_MS) {}

  /**
   * 註冊一筆等待中的權限請求。`timeoutMs` 為 `null` 時**不設計時器**(非
   * attended,見上方檔案頂端說明);否則逾時未回覆時呼叫 onTimeout(以 deny
   * 收場)。`strong` 見 `PendingPermission.strong` 註解。
   */
  register(
    sessionId: string,
    requestId: string,
    strong: boolean,
    timeoutMs: number | null,
    onTimeout: (sessionId: string, requestId: string) => void,
  ): void {
    // 若同一個 requestId 重複註冊(理論上不該發生),先清掉舊的計時器。
    this.clearTimer(requestId);

    if (timeoutMs === null) {
      this.pending.set(requestId, { sessionId, strong });
      return;
    }

    const timer = setTimeout(() => {
      this.pending.delete(requestId);
      onTimeout(sessionId, requestId);
    }, timeoutMs);
    // Node 環境下避免計時器阻擋進程結束。
    timer.unref?.();

    this.pending.set(requestId, { sessionId, strong, timer });
  }

  /**
   * 標記一筆請求已被回覆(不論是 UI 回覆或逾時自動拒絕),回傳其所屬
   * sessionId + 當初是否為 escalate-strong(見 `ResolvedPendingPermission`)。
   */
  resolve(requestId: string): ResolvedPendingPermission | undefined {
    const entry = this.pending.get(requestId);
    if (!entry) return undefined;
    this.clearTimer(requestId);
    this.pending.delete(requestId);
    return { sessionId: entry.sessionId, strong: entry.strong };
  }

  private clearTimer(requestId: string): void {
    const entry = this.pending.get(requestId);
    if (entry?.timer) clearTimeout(entry.timer);
  }
}
