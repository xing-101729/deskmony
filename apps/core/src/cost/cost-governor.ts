import { and, eq } from "drizzle-orm";
import type { NexusDb } from "@deskmony/db";
import { usageRollup as usageRollupTable } from "@deskmony/db";
import { resolveModelPricing, type BudgetConfig, type UsageEvent } from "@deskmony/shared";
import type { TaskService } from "../tasks/task-service.js";
import type { AuditLog } from "../enforcement/audit-log.js";
import type { Notifier } from "../enforcement/notifier.js";
import { enforcementTrip, type SessionControlPort } from "../enforcement/trip.js";

/**
 * cost-governor.ts(S3b:CostGovernor,見
 * docs/LAYER-4-detail-design/cost-governor_detail.md §1、§2、§6)。
 *
 * 消費 `UsageEvent`(S3a 的累計 payload),做**權威聚合 + 持久化**(§1),並在
 * 每次累加後檢查任務預算(E2)/每日 kill-switch(E3)兩層上限(§2)。**不**
 * 負責回合硬上限(那是不依賴 usage 的 `TurnLimiter`,見該檔案頂端說明——這是
 * 這一輪優先實作的項目,因為它是「Claude Code 經 ACP」這類完全拿不到 usage
 * 的後端唯一的保護)。
 *
 * ---- halt 粒度(HLD §3.3,與觸發原因的急迫性相稱)----
 *   - **任務預算**(回合邊界才發現,即 usage 事件抵達時)→ **只擋後續
 *     prompt**(`checkSendPromptAllowed()`),**不打斷已結束的回合**——不呼叫
 *     `interrupt()`。即使這次觸發的回合理論上還在跑,也接受這次的些許超支
 *     (HLD §3.1:「上限的作用是框住損害,不是精準防超支;實際花費會略超,這是
 *     設計接受的」)。
 *   - **每日 kill-switch** → **全部 session `interrupt()`**——最高等級訊號,
 *     寧可留半完成也要止血。
 *
 * ---- 已知限制(誠實揭露,見最終報告)----
 * HLD §3.1 定案的「mid-turn 成本熔斷」(回合中途收到 usage 就立即 interrupt,
 * 與「任務預算(回合邊界發現)」用不同的 halt 粒度)這一輪**沒有**做成一條
 * 獨立於「任務預算」的判斷路徑——理由:mid-turn 熔斷的前提是 adapter 會在
 * 回合**進行中**多次送出 usage 事件(HLD §3.1(B)「啟用 ACP 逐次轉發」),但
 * 目前唯一真正會發出 `usage` 事件的 adapter(`ClaudeAgentSdkAdapter`)在
 * `result` 訊息(即回合即將結束前)才發一次(見 usage-metering_detail.md
 * §8.2),ACP 經 Claude Code 完全不發 `usage_update`(§7),其餘 adapter 也
 * 未實作逐次轉發。也就是說,現況下「usage 事件抵達」與「回合已經結束」在
 * 時間上幾乎重合,沒有真正可觀測、可測試的「回合仍在進行中收到 usage」情境
 * 可以驗證,強行分岔一條路徑只是憑空編造行為——因此這一輪把所有經由 usage
 * 事件觸發的任務預算超標一律視為「回合邊界」處理(只擋後續 prompt)。若之後
 * 真的實作了 ACP 逐次轉發,需要另外接一條以 `TurnLimiter` 的 turn-active 狀態
 * 為準的判斷,讓「turn 仍在進行中」的 usage 事件改用 `interrupt: true`。
 */

export interface CostSessionPort extends SessionControlPort {
  /** 這個 sessionId 目前綁定的 team member id(供任務歸屬),沒有綁定回傳
   *  `undefined`。 */
  getMemberIdForSession(sessionId: string): string | undefined;
  /** 目前所有仍在跑的 sessionId(每日 kill-switch 要 interrupt 全部)。 */
  listActiveSessionIds(): string[];
}

export interface RollupSnapshot {
  costAmount: number;
  costCurrency: string | undefined;
  inputTokens: number;
  outputTokens: number;
}

interface SessionCumulative {
  costAmount?: number;
  inputTokens?: number;
  outputTokens?: number;
}

/** "YYYY-MM-DD",**本地時區**(不是 UTC/滾動 24h)——見 §1「日的定義」。 */
export function localDateString(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** S3a §3 的累計 diff 規則:新值 < 舊值 ⇒ 連線重置,delta = 新值(起新段,
 *  不做負 diff)。`undefined` 代表這個事件沒帶這個欄位,不產生 delta。 */
function diffCumulative(newValue: number | undefined, oldValue: number | undefined): number | undefined {
  if (newValue === undefined) return undefined;
  if (oldValue === undefined) return newValue;
  if (newValue < oldValue) return newValue;
  return newValue - oldValue;
}

function isOverBudget(rollup: RollupSnapshot, limits: { maxCostUsd?: number; maxTokens?: number }): boolean {
  // §3.2 雙軌:$ 為主——只有這個 scope 真的有過美金資料(costCurrency 有值)
  // 才用 $ 比對;否則(後端只給 token、且查無定價)退回 token 上限,保證永遠
  // 有一條線。
  if (limits.maxCostUsd !== undefined && rollup.costCurrency !== undefined) {
    return rollup.costAmount >= limits.maxCostUsd;
  }
  if (limits.maxTokens !== undefined) {
    return rollup.inputTokens + rollup.outputTokens >= limits.maxTokens;
  }
  return false;
}

function budgetPercent(rollup: RollupSnapshot, limits: { maxCostUsd?: number; maxTokens?: number }): number | undefined {
  if (limits.maxCostUsd !== undefined && rollup.costCurrency !== undefined) {
    return (rollup.costAmount / limits.maxCostUsd) * 100;
  }
  if (limits.maxTokens !== undefined) {
    return ((rollup.inputTokens + rollup.outputTokens) / limits.maxTokens) * 100;
  }
  return undefined;
}

export class CostGovernor {
  private sessionControl: CostSessionPort | undefined;
  /** sessionId -> 這條連線目前看過的最新累計值(算 delta 用,見 S3a §3)。 */
  private readonly lastCumulative = new Map<string, SessionCumulative>();
  /** `${scope}::${scopeId}` -> 目前的權威累計(記憶體快取,DB 是唯一落地,這
   *  裡只是避免每次門檻檢查都要多一次查詢)。 */
  private readonly rollupCache = new Map<string, RollupSnapshot>();
  /** 序列化所有 rollup 讀寫,避免不同 session 的 usage 事件併發時對同一個
   *  scope(尤其是 "day")做 read-modify-write 互相覆蓋(lost update)。 */
  private rollupLock: Promise<unknown> = Promise.resolve();
  /** 已經觸發任務預算 trip 的 taskId——**已 halt 的不自動恢復**(fail-safe),
   *  只能靠重啟 core(config 本來就 requiresRestart)重新評估。 */
  private readonly trippedTasks = new Set<string>();
  /** 今天(本地日期字串)是否已觸發每日 kill-switch。換日後字串自然不同,
   *  等同「每日重置」(§1「日的定義」),不需要額外的計時器清除。 */
  private trippedDay: string | undefined;
  /** 已經發過軟警告的 scope(`${scope}::${scopeId}`),避免每次超過
   *  warnAtPercent 都重複發送(見 §2 表格「軟警告」)。 */
  private readonly warnedScopes = new Set<string>();

  constructor(
    private readonly db: NexusDb,
    private readonly taskService: TaskService,
    private readonly config: BudgetConfig,
    private readonly auditLog: AuditLog,
    private readonly notifier: Notifier,
  ) {}

  /** apps/core/src/index.ts 在 SessionManager 建好之後回頭注入(打破建構子
   *  循環依賴,比照 `TurnLimiter.setSessionControl()`)。 */
  setSessionControl(port: CostSessionPort): void {
    this.sessionControl = port;
  }

  /**
   * core 啟動時呼叫一次:從 DB 還原 rollup 快取,並重新評估「目前是否已經
   * 超標」——**不能只從空白狀態開始**,否則崩潰重啟後,即使持久化的 rollup
   * 早就超過任務/每日上限,新的 sendPrompt 仍會被誤判為「未超標」而放行,見
   * §6 失敗模式表「崩潰重啟」的完整說明。
   */
  async initialize(): Promise<void> {
    const rows = await this.db.select().from(usageRollupTable).all();
    const today = localDateString(Date.now());
    for (const row of rows) {
      const snapshot: RollupSnapshot = {
        costAmount: row.costAmount,
        costCurrency: row.costCurrency ?? undefined,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
      };
      this.rollupCache.set(`${row.scope}::${row.scopeId}`, snapshot);
      if (row.scope === "task" && isOverBudget(snapshot, this.config.task)) {
        this.trippedTasks.add(row.scopeId);
      }
      if (row.scope === "day" && row.scopeId === today && isOverBudget(snapshot, this.config.daily)) {
        this.trippedDay = today;
      }
    }
  }

  /**
   * 主要入口:`SessionManager` 收到 `usage` AgentEvent 時呼叫。`ts` 是這個
   * 事件抵達 core 的時間戳(`SessionEventEnvelope.timestamp`)——**日的歸屬
   * 用這個值**,不是處理完成的時間,避免處理延遲跨錯日(§6「跨日瞬間」)。
   */
  async recordUsage(sessionId: string, event: UsageEvent, ts: number): Promise<void> {
    const last = this.lastCumulative.get(sessionId) ?? {};
    const deltaCostRaw = diffCumulative(event.costAmount, last.costAmount);
    const deltaInput = diffCumulative(event.inputTokens, last.inputTokens) ?? 0;
    const deltaOutput = diffCumulative(event.outputTokens, last.outputTokens) ?? 0;
    this.lastCumulative.set(sessionId, {
      costAmount: event.costAmount ?? last.costAmount,
      inputTokens: event.inputTokens ?? last.inputTokens,
      outputTokens: event.outputTokens ?? last.outputTokens,
    });

    let costDelta = deltaCostRaw ?? 0;
    let costCurrency: string | undefined = event.costAmount !== undefined ? (event.costCurrency ?? "USD") : undefined;
    if (event.costAmount === undefined && (deltaInput > 0 || deltaOutput > 0)) {
      // §3.2 雙軌:後端這次只給 token,嘗試用 price table 換算成 $(缺價則
      // 完全不編造,costDelta 維持 0、costCurrency 維持 undefined,由 token
      // 上限接手保護)。
      const pricing = resolveModelPricing(this.config.modelPricing, event.model);
      if (pricing) {
        costDelta = (deltaInput / 1_000_000) * pricing.inputPerMTokUsd + (deltaOutput / 1_000_000) * pricing.outputPerMTokUsd;
        costCurrency = "USD";
      }
    }

    const memberId = this.sessionControl?.getMemberIdForSession(sessionId);
    const task = memberId ? await this.taskService.getActiveTaskForMember(memberId) : undefined;
    const day = localDateString(ts);

    await this.withLock(async () => {
      await this.upsert("session", sessionId, costDelta, costCurrency, deltaInput, deltaOutput, ts);
      let taskRollup: RollupSnapshot | undefined;
      if (task) {
        taskRollup = await this.upsert("task", task.id, costDelta, costCurrency, deltaInput, deltaOutput, ts);
      }
      const dayRollup = await this.upsert("day", day, costDelta, costCurrency, deltaInput, deltaOutput, ts);

      if (task && taskRollup) {
        await this.checkTaskThreshold(task.id, task.title, taskRollup, sessionId);
      }
      await this.checkDailyThreshold(day, dayRollup);
    });
  }

  /**
   * `SessionManager.sendPrompt()` 在真的送出 prompt 之前呼叫——任務預算/每日
   * kill-switch 越線後只擋這裡,**不主動 interrupt 已經在跑的回合**(daily
   * kill-switch 是唯一的例外,那個例外的 interrupt 發生在 `checkDailyThreshold()`
   * 觸發當下,不是這裡)。
   */
  async checkSendPromptAllowed(sessionId: string): Promise<{ allowed: boolean; reason?: string }> {
    const today = localDateString(Date.now());
    if (this.trippedDay === today) {
      return {
        allowed: false,
        reason: "今日已觸發成本 kill-switch,所有 session 的新對話已暫停(需調整每日預算上限並重啟 core 才會恢復)",
      };
    }
    const memberId = this.sessionControl?.getMemberIdForSession(sessionId);
    const task = memberId ? await this.taskService.getActiveTaskForMember(memberId) : undefined;
    if (task && this.trippedTasks.has(task.id)) {
      return {
        allowed: false,
        reason: `任務「${task.title}」已達成本/token 上限,後續 prompt 已被擋下(worktree/任務保留,可調整預算上限並重啟 core 後續行)`,
      };
    }
    return { allowed: true };
  }

  /** 供 gateway/UI 查詢目前的累計與門檻狀態(見 §7「UI:CostView」)。 */
  async getSummary(sessionId: string): Promise<{
    session: RollupSnapshot;
    task?: { taskId: string; title: string; rollup: RollupSnapshot; tripped: boolean };
    day: RollupSnapshot;
    dailyTripped: boolean;
  }> {
    const empty: RollupSnapshot = { costAmount: 0, costCurrency: undefined, inputTokens: 0, outputTokens: 0 };
    const session = this.rollupCache.get(`session::${sessionId}`) ?? empty;
    const today = localDateString(Date.now());
    const day = this.rollupCache.get(`day::${today}`) ?? empty;
    const memberId = this.sessionControl?.getMemberIdForSession(sessionId);
    const task = memberId ? await this.taskService.getActiveTaskForMember(memberId) : undefined;
    return {
      session,
      task: task
        ? {
            taskId: task.id,
            title: task.title,
            rollup: this.rollupCache.get(`task::${task.id}`) ?? empty,
            tripped: this.trippedTasks.has(task.id),
          }
        : undefined,
      day,
      dailyTripped: this.trippedDay === today,
    };
  }

  private async checkTaskThreshold(taskId: string, taskTitle: string, rollup: RollupSnapshot, triggeringSessionId: string): Promise<void> {
    if (this.trippedTasks.has(taskId)) return;
    if (isOverBudget(rollup, this.config.task)) {
      this.trippedTasks.add(taskId);
      // HLD §3.3:任務預算(回合邊界才發現)→ 只擋後續 prompt,不打斷已結束
      // 的回合——`interrupt: false`,見檔案頂端「已知限制」說明。
      await enforcementTrip({
        source: "cost",
        reason: "task-budget",
        targetIds: [triggeringSessionId],
        auditLog: this.auditLog,
        notifier: this.notifier,
        interrupt: false,
      });
      return;
    }
    const percent = budgetPercent(rollup, this.config.task);
    if (percent !== undefined && percent >= this.config.warnAtPercent) {
      await this.maybeWarn(`task::${taskId}`, [triggeringSessionId]);
    }
    void taskTitle; // 目前只用在 checkSendPromptAllowed() 的錯誤訊息,這裡保留參數供未來擴充通知內容。
  }

  private async checkDailyThreshold(day: string, rollup: RollupSnapshot): Promise<void> {
    if (this.trippedDay === day) return;
    if (isOverBudget(rollup, this.config.daily)) {
      this.trippedDay = day;
      const targets = this.sessionControl?.listActiveSessionIds() ?? [];
      // HLD §3.3:每日 kill-switch → 全部 session interrupt,最高等級訊號。
      await enforcementTrip({
        source: "cost",
        reason: "daily-limit",
        targetIds: targets,
        auditLog: this.auditLog,
        notifier: this.notifier,
        interrupt: true,
        sessionControl: this.sessionControl,
      });
      return;
    }
    const percent = budgetPercent(rollup, this.config.daily);
    if (percent !== undefined && percent >= this.config.warnAtPercent) {
      await this.maybeWarn(`day::${day}`, this.sessionControl?.listActiveSessionIds() ?? []);
    }
  }

  private async maybeWarn(scopeKey: string, targetIds: string[]): Promise<void> {
    if (this.warnedScopes.has(scopeKey)) return;
    this.warnedScopes.add(scopeKey);
    const event = {
      kind: "reminder" as const,
      source: "cost" as const,
      reason: "budget-warning" as const,
      targetIds,
      ts: Date.now(),
    };
    this.auditLog.append(event);
    await this.notifier.deliver(event).catch((err) => {
      console.error(`[cost-governor] 軟警告通知送出失敗(不影響任何 halt 決策): ${String(err)}`);
    });
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.rollupLock.catch(() => undefined);
    const result = previous.then(fn);
    this.rollupLock = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async upsert(
    scope: "session" | "task" | "day",
    scopeId: string,
    deltaCost: number,
    costCurrency: string | undefined,
    deltaInput: number,
    deltaOutput: number,
    ts: number,
  ): Promise<RollupSnapshot> {
    const key = `${scope}::${scopeId}`;
    const existing = this.rollupCache.get(key);
    const next: RollupSnapshot = {
      costAmount: (existing?.costAmount ?? 0) + deltaCost,
      costCurrency: costCurrency ?? existing?.costCurrency,
      inputTokens: (existing?.inputTokens ?? 0) + deltaInput,
      outputTokens: (existing?.outputTokens ?? 0) + deltaOutput,
    };
    this.rollupCache.set(key, next);

    const rows = await this.db
      .select()
      .from(usageRollupTable)
      .where(and(eq(usageRollupTable.scope, scope), eq(usageRollupTable.scopeId, scopeId)))
      .all();
    if (rows[0]) {
      await this.db
        .update(usageRollupTable)
        .set({
          costAmount: next.costAmount,
          costCurrency: next.costCurrency ?? null,
          inputTokens: next.inputTokens,
          outputTokens: next.outputTokens,
          updatedAt: ts,
        })
        .where(and(eq(usageRollupTable.scope, scope), eq(usageRollupTable.scopeId, scopeId)))
        .run();
    } else {
      await this.db
        .insert(usageRollupTable)
        .values({
          scope,
          scopeId,
          costAmount: next.costAmount,
          costCurrency: next.costCurrency ?? null,
          inputTokens: next.inputTokens,
          outputTokens: next.outputTokens,
          updatedAt: ts,
        })
        .run();
    }
    return next;
  }
}
