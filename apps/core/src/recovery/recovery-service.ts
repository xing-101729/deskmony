import { DeskmonyError, ErrorCodes, type RecoverySessionInfo, type Session } from "@deskmony/shared";
import type { SessionManager } from "../session/session-manager.js";
import type { AgentCatalog } from "../agents/agent-catalog.js";

/**
 * RecoveryService(S6:崩潰復原,見
 * docs/LAYER-4-detail-design/crash-recovery_detail.md §5)。
 *
 * 職責:組裝復原視圖需要的資料(§5.1)、執行人類選擇的三種分流動作(§3.1/
 * §5.2「繼續 / 接手 / 放棄」)。**這是應用層的組合邏輯**,不擁有任何狀態本身
 * ——實際的 session 操作都委派給既有的 `SessionManager`,這裡只負責串起來。
 *
 * **D3(明令禁止自動續接)在這裡的落實**:四個方法(`list`/`continueSession`/
 * `takeover`/`abandon`)全部要求呼叫端明確指定 `sessionId` 並主動呼叫
 * ——這個類別本身完全沒有任何背景計時器/自動觸發邏輯,**人不點,什麼都不會
 * 發生**。
 *
 * 2026-10-02(P1:移除 team/task/看板,見 docs/DECISIONS.md §H):原本的「重跑」
 * (`rerun`)、看 git 狀態(`gitStatus`)、髒 worktree 處理(`resolveDirtyWorktree`)
 * 與「session ↔ team member ↔ task ↔ workspace」的反查,全部是任務 git worktree
 * 專用——沒有任務就沒有 worktree 可看/重跑——一併移除。復原只剩 session 對帳:
 * interrupted → 繼續 / 接手 / 放棄。
 *
 * 2026-10-02(P2:移除 profile):不再有 `ProfileStore`——「這個 session 是哪個 agent」改看
 * session 自己的 `providerId`(顯示用名稱取自 `AgentCatalog` 的 provider label),「接手」等重新 spawn 的
 * 路徑由 `SessionManager.takeoverWithSummary()` 從 session 自己的資料重建啟動規格。
 */
export class RecoveryService {
  constructor(
    private readonly sessionManager: SessionManager,
    private readonly catalog: AgentCatalog,
  ) {}

  /** §5.1:復原視圖的資料來源。 */
  async list(): Promise<RecoverySessionInfo[]> {
    const sessions = await this.sessionManager.listInterruptedSessions();
    // 顯示名稱只讀一次(只有真的有中斷的 session 才需要);不等偵測結果,見 `AgentCatalog.labelsById()`。
    const labelById = sessions.length > 0 ? await this.catalog.labelsById() : new Map<string, string>();
    const results: RecoverySessionInfo[] = [];
    for (const session of sessions) {
      results.push({
        sessionId: session.id,
        sessionTitle: session.title,
        // provider 已不在目錄裡(舊 session 的 `legacy-*`,或 agent 被移除)時退回 providerId 本身當標籤。
        agentLabel: labelById.get(session.providerId) ?? session.providerId,
        status: "interrupted",
        interruptedAt: session.interruptedAt,
        lastSeenAt: session.lastSeenAt,
        canContinue: computeCanContinue(session),
      });
    }
    return results;
  }

  /** §4:「繼續(保有記憶)」——直接委派給 `SessionManager.continueSession()`,那裡有完整的前置檢查。 */
  async continueSession(sessionId: string): Promise<Session> {
    // 2026-09-04(稽核修補):見 withRecoveryClaim()。
    return this.withRecoveryClaim(sessionId, async () => {
      return this.sessionManager.continueSession(sessionId);
    });
  }

  /**
   * §4.2:「接手(讀摘要重啟)」——組出摘要(只讀 DB,不呼叫 LLM,見
   * `buildTakeoverSummary()`),開一個全新 session 並把摘要當作第一則 prompt
   * 送出,再把舊的中斷 session 收尾成 `closed`(離開復原視圖——它已經被人類
   * 處理過了)。
   */
  async takeover(sessionId: string): Promise<Session> {
    // 2026-09-04(稽核修補):見 withRecoveryClaim()。
    return this.withRecoveryClaim(sessionId, async () => {
      const session = await this.mustGetInterrupted(sessionId);
      const summary = await this.buildTakeoverSummary(session);

      const newSession = await this.sessionManager.takeoverWithSummary(session, `${session.title}(接手)`, summary);
      await this.sessionManager.abandonInterruptedSession(sessionId);
      return newSession;
    });
  }

  /** §5.2:「放棄」——session 標 `closed`;對話紀錄保留(同 S3b T2「回收 ≠ 丟棄」)。 */
  async abandon(sessionId: string): Promise<void> {
    // 2026-09-04(稽核修補):見 withRecoveryClaim()。
    return this.withRecoveryClaim(sessionId, async () => {
      await this.sessionManager.abandonInterruptedSession(sessionId);
    });
  }

  /**
   * 2026-09-04(稽核修補):同一個 interrupted session 上的復原操作互斥。
   *
   * `takeover()`/`continueSession()` 都是「先 `mustGetInterrupted()`
   * 檢查狀態 → 一連串 await(組摘要、開新 session、送 prompt)→ **最後一步**
   * 才把舊 session 標成 closed」。狀態真正改變是在整條流程的尾巴,中間完全
   * 沒有鎖。
   *
   * 後果不只是「多一個錯誤訊息」:使用者對同一筆連按兩次「接手」,兩次呼叫都
   * 會通過檢查、各自 `createSession()` 開一個**全新的 agent**,對著**同一個
   * 工作目錄** 開始工作。先完成的那次成功標記 closed,後完成的那次在最後一步
   * 拋錯 —— 而它建立的第二個 agent 已經真的在跑、已經真的收到 prompt 了。
   * 使用者看到的錯誤訊息完全沒有反映「其實多開了一個 agent 在同一批檔案上」。
   *
   * 用「宣告佔用」而不是提前改 DB 狀態:提前標 closed 的話,流程中途失敗會讓
   * 這筆從復原視圖消失、使用者再也無法重試,那是更糟的失敗模式。
   */
  private readonly inFlight = new Set<string>();

  private async withRecoveryClaim<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    if (this.inFlight.has(sessionId)) {
      throw new DeskmonyError(
        "recovery.alreadyInProgress",
        { sessionId },
        `這個 session 的復原操作正在進行中,請等它完成: ${sessionId}`,
      );
    }
    this.inFlight.add(sessionId);
    try {
      return await fn();
    } finally {
      this.inFlight.delete(sessionId);
    }
  }

  private async mustGetInterrupted(sessionId: string): Promise<Session> {
    const session = await this.sessionManager.getSession(sessionId);
    if (!session) {
      throw new DeskmonyError(ErrorCodes.ENTITY_NOT_FOUND, { entityType: "session", id: sessionId }, `找不到 session: ${sessionId}`);
    }
    if (session.status !== "interrupted") {
      throw new DeskmonyError(
        "recovery.sessionNotInterrupted",
        { sessionId, status: session.status },
        `session ${sessionId} 目前狀態是 "${session.status}",不是 "interrupted"`,
      );
    }
    return session;
  }

  /**
   * §4.2:「接手」注入的摘要內容——**只讀 DB,不呼叫 LLM**(避免復原本身變成
   * 一次昂貴的推論)。上限 4000 字元,超過時從最舊的對話開始截斷(見
   * `buildSummaryText()`)。
   *
   * 2026-10-02:原本在有任務 worktree 時還會附上「已變更檔案」(git status 前
   * 20 行)——那段讀的是任務 worktree,已隨 task 移除;一般 session 本來就沒有
   * 這一行。
   */
  private async buildTakeoverSummary(session: Session): Promise<string> {
    const headerLines: string[] = ["【前次工作中斷】"];
    headerLines.push(`任務:${session.title}`);
    const interruptedAtText = session.interruptedAt ? new Date(session.interruptedAt).toISOString() : "未知";
    headerLines.push(`狀態:中斷於 ${session.status},時間 ${interruptedAtText}`);

    const history = await this.sessionManager.getHistory(session.id);
    const conversational = history.filter((m) => m.role === "user" || m.role === "assistant");
    // 「最多 3 輪」:取最後 6 則 user/assistant 訊息(粗略對應 3 輪一問一答,
    // 不保證嚴格配對——若最後幾則恰好都是同一角色連續出現,仍以「最後 6 則」
    // 為準,不特別偵測配對關係,保持實作單純)。
    const lastMessages = conversational.slice(-6);
    const conversationLines = lastMessages.map((m) => `${m.role === "user" ? "使用者" : "assistant"}: ${m.content}`);

    return buildSummaryText(headerLines.join("\n"), conversationLines);
  }
}

/** §4.1:目前唯一支援「繼續(保有記憶)」的後端——見查證結論。 */
function computeCanContinue(session: Session): boolean {
  return session.adapterType === "claude-agent-sdk" && Boolean(session.backendSessionId);
}

const SUMMARY_CHAR_LIMIT = 4000;

/** 上限 4000 字元,超過從最舊的對話開始截斷(§4.2)。 */
function buildSummaryText(header: string, conversationLines: string[]): string {
  let convo = [...conversationLines];
  const render = (): string => [header, "最後對話(最多 3 輪):", ...(convo.length > 0 ? convo : ["(無)"])].join("\n");
  let text = render();
  while (text.length > SUMMARY_CHAR_LIMIT && convo.length > 0) {
    convo = convo.slice(1);
    text = render();
  }
  if (text.length > SUMMARY_CHAR_LIMIT) {
    text = text.slice(0, SUMMARY_CHAR_LIMIT);
  }
  return text;
}
