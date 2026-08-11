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
export class AsyncQueue<T> implements AsyncIterable<T> {
  private buffer: T[] = [];
  private waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value: item, done: false });
    } else {
      this.buffer.push(item);
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
