/**
 * 極簡的非同步佇列(pull-based),同時支援:
 *  - 作為 AsyncIterable 被消費(for await...of)
 *  - 從外部 push() 塞入新項目
 *  - close() 結束串流
 *
 * 用途:
 *  1. ClaudeAgentSdkAdapter 把 SDK 事件轉成 AgentEvent 後 push 進來,
 *     再由 AgentAdapter.events() 回傳給呼叫端消費。
 *  2. 作為 Claude Agent SDK `query()` 的 streaming input(AsyncIterable<SDKUserMessage>),
 *     讓 sendPrompt() 可以在同一個 session 內持續推入新的 user 訊息。
 */
/**
 * 2026-09-04(稽核修補):緩衝上限的預設值。
 *
 * 在此之前 `buffer` 完全沒有上限,而上游三個 adapter 的讀取迴圈也都不理會下游
 * 速度(`for await (const m of sdkQuery) this.handleMessage(...)` 是同步 push)。
 * 下游唯一的消費者 `SessionManager.consumeEvents()` 每個事件都要 `await` 一次
 * 同步 SQLite 寫入 —— 生產與消費的速度差會無上限累積在記憶體裡。
 *
 * 一個失控迴圈、一個有 bug 的 MCP 工具、或一次超大的 `tool_result`,就能吃爆
 * 整個 core 的記憶體,而影響範圍是**同一個 process 上的所有 session**,不只是
 * 失控的那一個。對照組:同一個 repo 的 terminal buffer 一直都有 200,000 字元
 * 上限 —— 該設限的地方知道要設,這裡是漏了。
 *
 * 10,000 刻意訂得寬鬆:正常對話一輪的事件數是兩位數,只有真正失控才碰得到。
 */
const DEFAULT_MAX_BUFFERED = 10_000;

export interface AsyncQueueOptions {
  /** 緩衝上限,預設 `DEFAULT_MAX_BUFFERED`。 */
  maxBuffered?: number;
  /**
   * 溢位時呼叫一次(**每個溢位事件一次**,不是每筆丟棄一次 —— 一旦開始溢位
   * 通常會連續發生,逐筆回呼只會製造 log 風暴)。給呼叫端一個「記一筆、
   * 讓人看得見」的機會,而不是靜默丟資料。
   */
  onOverflow?: (droppedTotal: number) => void;
}

export class AsyncQueue<T> implements AsyncIterable<T> {
  private buffer: T[] = [];
  private waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;
  private readonly maxBuffered: number;
  private readonly onOverflow?: (droppedTotal: number) => void;
  /** 累計被丟棄的筆數(供呼叫端診斷/回報)。 */
  private droppedCount = 0;
  /** 是否已針對「這一段溢位」通知過呼叫端,消費端追上後重置。 */
  private overflowNotified = false;

  constructor(options: AsyncQueueOptions = {}) {
    this.maxBuffered = options.maxBuffered ?? DEFAULT_MAX_BUFFERED;
    this.onOverflow = options.onOverflow;
  }

  /** 累計丟棄筆數;0 代表從未溢位。 */
  get dropped(): number {
    return this.droppedCount;
  }

  push(item: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: item, done: false });
      return;
    }

    this.buffer.push(item);

    if (this.buffer.length > this.maxBuffered) {
      /**
       * **丟最舊的,不是最新的。** 這是刻意的方向:對一條事件串流來說,最新的
       * 事件才代表當下狀態(tool-result、completed)。若改成拒收新事件,
       * `completed` 永遠進不來,那條 session 會**永遠卡在 busy** —— 那比丟掉
       * 一段中間歷史糟糕得多。
       */
      const overflow = this.buffer.length - this.maxBuffered;
      this.buffer.splice(0, overflow);
      this.droppedCount += overflow;
      if (!this.overflowNotified) {
        this.overflowNotified = true;
        this.onOverflow?.(this.droppedCount);
      }
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      waiter?.({ value: undefined as unknown as T, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.buffer.length > 0) {
          const value = this.buffer.shift() as T;
          // 消費端追上了(緩衝退回上限以下)—— 允許下一次溢位再通知一次,
          // 這樣「又開始塞車了」不會被前一段的通知永久消音。
          if (this.overflowNotified && this.buffer.length < this.maxBuffered) {
            this.overflowNotified = false;
          }
          return Promise.resolve({ value, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as unknown as T, done: true });
        }
        return new Promise((resolve) => {
          this.waiters.push(resolve);
        });
      },
    };
  }
}
