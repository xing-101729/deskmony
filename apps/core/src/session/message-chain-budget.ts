import type { EnforcementEvent, MessageBudgetConfig } from "@deskmony/shared";
import type { AuditLog } from "../enforcement/audit-log.js";
import type { Notifier } from "../enforcement/notifier.js";
import { enforcementTrip } from "../enforcement/trip.js";

/**
 * message-chain-budget.ts(2026-10-02,P3「session 網路」新增,見
 * docs/LAYER-4-detail-design/simplify-agents-sessions_detail.md §P3.4;取代 A5 的「每 task context 訊息預算」,
 * 是三條斷路器(權限/訊息/成本)裡的**訊息**那一條)。
 *
 * ---- 「鏈」是什麼 -------------------------------------------------------------------------------
 *
 * 失控的 agent 對 agent 互傳(A 回 B、B 回 A、永遠不停;或一個 agent 不斷開新 session 扇出)有一個共同表徵:
 * 沿著**同一串因果**的訊息越來越多。所以預算的單位不是「每個 session」也不是「每個時間窗」,而是**每條因果鏈**:
 *   - 人類直接輸入的 prompt(gateway `session.sendPrompt`)開啟一條新鏈;
 *   - agent 經 `create_session`/`send_to_session` 送出的訊息,沿用「呼叫者**這一輪**是被哪條鏈觸發的」那條鏈;
 *   - UI 轉傳(`session.forwardMessage`)也開新鏈(轉傳是人類操作,本身不計數、不會被擋)。
 * 每個 session runtime 記住 `currentChainId`(開始處理某一輪時設定),見 SessionManager。
 *
 * ---- 計數與熔斷 ----------------------------------------------------------------------------------
 *
 * 每條鏈的訊息數**只存記憶體**(core 重啟歸零——重啟後所有 session 都要重新 spawn,舊鏈本來就該結束)。
 * 上限 = `config.messageBudget.maxMessagesPerContext`:
 *   - 第 1…max 則 agent→agent 訊息放行;**第 max+1 則起一律被拒**(`admit()` 回 `ok:false`,工具回錯誤給 agent);
 *   - 達 `warnAtPercent` 時發一次軟警告(audit + 通知,**不 halt**);
 *   - 第一次越線時走既有的 `enforcementTrip()`(audit log + 桌面通知,`interrupt:false`——訊息熔斷只擋後續傳遞,
 *     不打斷任何已在進行的回合);同一條鏈之後再被拒不重複通知(避免 agent 反覆重試洗版),但仍照樣被拒。
 * 熔斷只擋 **agent 對 agent** 的傳遞:人類照常可以對任何 session 輸入,輸入即開新鏈。
 * 遠端不可停用(F4 精神不變):`messageBudget` 維持不在遠端可改的設定子集。
 *
 * ---- 避免無限增長 --------------------------------------------------------------------------------
 *
 * 鏈的狀態只有在「還有 session 的 `currentChainId` 或待送佇列指向它」時才有意義。SessionManager 提供
 * `getReferencedChainIds()`:(1) 每次**新建**一條鏈的計數項目前先 prune 一次(不再被引用的全部丟掉);
 * (2) session 被刪除/關閉/回收時由 SessionManager 主動呼叫 `prune()`。另有一個硬上限當最後防線。
 */

/** 最後防線:同時追蹤的鏈數上限(正常情況下被 `prune()` 收斂到「仍被引用的鏈」,遠低於這個數字)。 */
const MAX_TRACKED_CHAINS = 10_000;

interface ChainState {
  count: number;
  warned: boolean;
  tripped: boolean;
}

export type ChainAdmission = { ok: true } | { ok: false; limit: number };

export class MessageChainBudget {
  private readonly chains = new Map<string, ChainState>();

  constructor(
    private readonly config: MessageBudgetConfig,
    private readonly auditLog: AuditLog,
    private readonly notifier: Notifier,
    /** 目前仍有 session 的 `currentChainId` 或待送佇列指向的鏈 id(SessionManager 提供)。 */
    private readonly getReferencedChainIds: () => ReadonlySet<string>,
  ) {}

  /**
   * 一則 agent→agent 訊息要沿用 `chainId` 送出**之前**呼叫:放行就把這條鏈的計數 +1 並回 `{ok:true}`;
   * 已達上限就回 `{ok:false}`(呼叫端據此回錯誤給 agent)。`participants` = 這則訊息牽涉的 session id
   * (送出方與目標),只用於通知/稽核的 `targetIds`。
   *
   * 計數與判斷在第一個 `await` 之前同步完成,不會被併發呼叫穿插。
   */
  async admit(chainId: string, participants: string[]): Promise<ChainAdmission> {
    const targetIds = [...new Set(participants)];
    let state = this.chains.get(chainId);
    if (!state) {
      this.prune(this.getReferencedChainIds());
      if (this.chains.size >= MAX_TRACKED_CHAINS) {
        // 最後防線:丟掉最舊的一條(Map 保持插入順序)。正常情況永遠走不到這裡。
        const oldest = this.chains.keys().next().value;
        if (oldest !== undefined) this.chains.delete(oldest);
      }
      state = { count: 0, warned: false, tripped: false };
      this.chains.set(chainId, state);
    }

    const limit = this.config.maxMessagesPerContext;
    if (state.count >= limit) {
      const firstTrip = !state.tripped;
      state.tripped = true;
      if (firstTrip) {
        try {
          await enforcementTrip({
            source: "message",
            reason: "message-chain-budget",
            targetIds,
            auditLog: this.auditLog,
            notifier: this.notifier,
            interrupt: false,
          });
        } catch (err) {
          console.error(`[message-chain-budget] 熔斷通知/稽核失敗(不影響這則訊息被拒): ${String(err)}`);
        }
      }
      return { ok: false, limit };
    }

    state.count += 1;
    if (!state.warned && state.count >= this.warnThreshold(limit)) {
      state.warned = true;
      const event: EnforcementEvent = {
        kind: "reminder",
        source: "message",
        reason: "message-chain-warning",
        targetIds,
        ts: Date.now(),
      };
      try {
        this.auditLog.append(event);
        await this.notifier.deliver(event);
      } catch (err) {
        console.error(`[message-chain-budget] 軟警告通知/稽核失敗(不影響這則訊息放行): ${String(err)}`);
      }
    }
    return { ok: true };
  }

  /** 丟掉不在 `referenced` 裡的鏈(沒有任何 session 還在這條鏈上,計數已經沒有意義)。 */
  prune(referenced: ReadonlySet<string>): void {
    for (const chainId of this.chains.keys()) {
      if (!referenced.has(chainId)) this.chains.delete(chainId);
    }
  }

  /** 目前追蹤中的鏈數(測試/除錯用)。 */
  get trackedChainCount(): number {
    return this.chains.size;
  }

  /** 達 `warnAtPercent` 的那一則的序號,夾在 [1, limit] 之間(`warnAtPercent` 沒有範圍限制,不能信任)。 */
  private warnThreshold(limit: number): number {
    const raw = Math.ceil((limit * this.config.warnAtPercent) / 100);
    return Math.min(limit, Math.max(1, Number.isFinite(raw) ? raw : limit));
  }
}
