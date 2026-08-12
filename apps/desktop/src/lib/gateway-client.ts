import type { ClientRequest, ClientRequestMethod, ServerMessage, ServerPush } from "@deskmony/shared";

type ParamsOf<M extends ClientRequestMethod> = Extract<ClientRequest, { method: M }>["params"];

type ConnectionStatus = "connecting" | "open" | "closed";

/**
 * Renderer 端的 Gateway client:對應 ARCHITECTURE.md 3.2 節「UI 與 Core 之間
 * 走 WebSocket:指令用 request/response,agent 輸出用事件推播」。
 *
 * 直接用瀏覽器原生 WebSocket 連到 apps/core 的 Gateway,不透過 Electron IPC
 * —— 呼應「Core 與殼分離、桌面殼只是其中一種 client」的設計。
 *
 * M5 Round A(任務2):可選建構子參數 `authToken`。設定時,WS 連線一開啟就
 * 自動送出 `auth` request 並等待成功後才把連線狀態切成 "open"(在此之前
 * `call()` 呼叫的其他方法都還沒機會送出,因為外部程式碼一般是等 status
 * 變成 "open" 才開始呼叫 —— 見 App.tsx 既有的連線流程,這裡不改變這個假設)。
 * core 未設定 `DESKMONY_AUTH_TOKEN` 時,`auth` request 本身一律直接成功
 * (見 WsGateway 的相容處理),因此這裡即使沒有拿到 `authToken`(理論上
 * 桌面殼一定會由 main process 產生一個)也不會壞掉舊行為。
 *
 * M5 Round B(任務2,瀏覽器 client):Electron 場景下 url/authToken 在 app
 * 啟動當下就從 `window.deskmony` 拿得到,建構子傳入即可;但瀏覽器場景下
 * 使用者要先在連線畫面(見 views/ConnectScreen.tsx)輸入伺服器位址與 token
 * 才知道要連哪裡——因此 `url`/`authToken` 這輪改成可變欄位,新增
 * `configure()` 讓連線畫面在使用者送出表單、且已用 `probeGatewayConnection()`
 * 驗證過連線/認證都成功之後,才真的設定進這個「長駐」的 client 實例
 * (session-store.ts 匯出的模組層級 singleton,team-store/task-store 共用同
 * 一條連線)。`connect()` 在 `url` 為空字串時直接視為關閉狀態、不嘗試建立
 * WebSocket(瀏覽器場景下,使用者送出連線畫面表單前不應該有任何連線嘗試)。
 */
interface QueuedCall {
  method: ClientRequestMethod;
  params: unknown;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

export class GatewayClient {
  private ws: WebSocket | null = null;
  /** WS 是否已開啟且完成認證(未設定 authToken 時只需 WS 開啟)——只有這個
   *  旗標為 true,call() 才會真的送出 request,見 call()/markReady() 註解。 */
  private ready = false;
  /** ready 為 false 期間呼叫 call() 排入的請求,markReady() 時依序送出;連線
   *  斷開時由 close 事件處理器統一 reject(見 rejectQueuedCalls())。 */
  private sendQueue: QueuedCall[] = [];
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private pushListeners = new Set<(push: ServerPush) => void>();
  private statusListeners = new Set<(status: ConnectionStatus) => void>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByUser = false;

  constructor(
    private url: string,
    private authToken?: string,
  ) {}

  /** 見上方類別註解——瀏覽器連線畫面驗證成功後才呼叫,設定真正要連線的目標。 */
  configure(url: string, authToken: string | undefined): void {
    this.url = url;
    this.authToken = authToken;
  }

  connect(): void {
    if (!this.url) {
      // 尚未 configure()(瀏覽器場景,使用者還沒送出連線畫面表單)——不嘗試
      // 建立連線,直接維持/回報關閉狀態,避免 `new WebSocket("")` 丟出例外。
      this.emitStatus("closed");
      return;
    }
    this.closedByUser = false;
    this.ready = false;
    this.emitStatus("connecting");
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.addEventListener("open", () => {
      if (!this.authToken) {
        this.markReady();
        return;
      }
      // 認證成功前不對外回報 "open",避免呼叫端在認證完成前就送出其他 request
      // (core 會拒絕,但沒必要讓 UI 先看到一個之後注定失敗的連線狀態)。這裡
      // 直接用 sendNow()(不經過 call() 的 ready 檢查)——auth 本身就是讓
      // ready 變 true 的那一步,不能被自己擋住。
      this.sendNow("auth", { token: this.authToken }).then(
        () => this.markReady(),
        (err: unknown) => {
          console.error("[gateway] 認證失敗,關閉連線:", err instanceof Error ? err.message : err);
          this.ws?.close();
        },
      );
    });
    ws.addEventListener("close", () => {
      this.ready = false;
      this.emitStatus("closed");
      const err = new Error("與 Deskmony Core 的連線已中斷");
      this.rejectAllPending(err);
      this.rejectQueuedCalls(err);
      if (!this.closedByUser) this.scheduleReconnect();
    });
    ws.addEventListener("error", () => {
      // close 事件會接著觸發,這裡不用重複處理
    });
    ws.addEventListener("message", (ev) => this.handleMessage(String(ev.data)));
  }

  disconnect(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }

  onPush(listener: (push: ServerPush) => void): () => void {
    this.pushListeners.add(listener);
    return () => this.pushListeners.delete(listener);
  }

  onStatus(listener: (status: ConnectionStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  /**
   * `session-store.ts` 的 `connect()` 呼叫 `client.connect()` 後,同一個 tick
   * 內就緊接著呼叫 `refreshProfiles()`/`refreshSessions()` 等——這時
   * `WebSocket` 才剛 `new` 出來,規範保證 `readyState` 還是 `CONNECTING`
   * (`open` 事件一定是之後的 tick 才會觸發)。過去這裡看到還沒 `OPEN` 就直接
   * `reject`,導致這些呼叫每次都在連線真正建立前就失敗,而呼叫端是 `void`
   * fire-and-forget、沒有重試,`profiles`/`sessions` 就此永遠停在初始空陣列
   * ——現在改成:還沒 ready 時把請求排進 `sendQueue`,等 `markReady()`(WS
   * 開啟、且完成認證)才依序真正送出,呼叫端完全不用改。
   */
  call<M extends ClientRequestMethod>(method: M, params: ParamsOf<M>): Promise<unknown> {
    if (!this.ws) {
      return Promise.reject(new Error("尚未連線到 Deskmony Core"));
    }
    if (!this.ready) {
      return new Promise((resolve, reject) => {
        this.sendQueue.push({ method, params, resolve, reject });
      });
    }
    return this.sendNow(method, params);
  }

  private sendNow(method: ClientRequestMethod, params: unknown): Promise<unknown> {
    const id = crypto.randomUUID();
    const request = { id, method, params } as ClientRequest;

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws?.send(JSON.stringify(request));
    });
  }

  private markReady(): void {
    this.ready = true;
    this.emitStatus("open");
    const queue = this.sendQueue;
    this.sendQueue = [];
    for (const { method, params, resolve, reject } of queue) {
      this.sendNow(method, params).then(resolve, reject);
    }
  }

  private handleMessage(raw: string): void {
    let message: ServerMessage;
    try {
      message = JSON.parse(raw) as ServerMessage;
    } catch {
      return;
    }

    if (message.kind === "response") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.ok) {
        pending.resolve(message.result);
      } else {
        pending.reject(new Error(message.error ?? "未知錯誤"));
      }
      return;
    }

    if (message.kind === "event") {
      for (const listener of this.pushListeners) listener(message);
    }
  }

  private emitStatus(status: ConnectionStatus): void {
    for (const listener of this.statusListeners) listener(status);
  }

  /** 連線斷線時,把所有還在等待 response 的 in-flight request 全部 reject,避免永久懸置。 */
  private rejectAllPending(err: Error): void {
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
  }

  /** 連線斷線時,把 sendQueue 裡還沒送出的請求一併 reject(理由同 rejectAllPending())。 */
  private rejectQueuedCalls(err: Error): void {
    const queue = this.sendQueue;
    this.sendQueue = [];
    for (const { reject } of queue) reject(err);
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 2000);
  }
}

/** 連線畫面用來區分「連不上伺服器」的錯誤(見 probeGatewayConnection())。 */
export class GatewayNetworkError extends Error {}
/** 連線畫面用來區分「token 不正確」的錯誤(見 probeGatewayConnection())。 */
export class GatewayAuthError extends Error {}

/**
 * M5 Round B(任務2):瀏覽器連線畫面(views/ConnectScreen.tsx)用來「測試」
 * 一組伺服器位址 + token 是否真的可用的一次性探測——刻意不重用長駐的
 * `GatewayClient`(那個實例有自動重連邏輯,且要等使用者確認過連線真的成功
 * 才應該切換成主要連線目標),這裡開一個獨立、用完即丟的 WebSocket,自己送
 * 一次 `auth` request 並等待明確的成功/失敗回應:
 *   - resolve:對方接受(不論是 core 有設定 token 且驗證通過,或 core 未設定
 *     token 時 auth 一律直接成功,見 WsGateway 的相容處理)。
 *   - reject(GatewayAuthError):WS 連得上,但 `auth` request 回應
 *     `ok:false`(token 不正確)——對應使用者看到「認證失敗」而非「連不上」。
 *   - reject(GatewayNetworkError):在拿到任何 `auth` 回應之前就發生錯誤/
 *     逾時/連線被關閉(伺服器位址錯誤、伺服器沒有在跑、網路不通等)——對應
 *     使用者看到「連線失敗」而非「認證失敗」,兩種錯誤訊息刻意分開,見任務
 *     描述「連線失敗顯示明確錯誤(認證失敗 vs 連不上要能區分)」。
 */
export function probeGatewayConnection(url: string, token: string, timeoutMs = 8_000): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };

    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      reject(new GatewayNetworkError(`無效的伺服器位址:${err instanceof Error ? err.message : String(err)}`));
      return;
    }

    const overallTimer = setTimeout(() => {
      finish(() => {
        try {
          ws.close();
        } catch {
          // ignore
        }
        reject(new GatewayNetworkError("連線逾時,請確認伺服器位址是否正確、伺服器是否正在執行"));
      });
    }, timeoutMs);

    ws.addEventListener("open", () => {
      const id = crypto.randomUUID();
      const onMessage = (ev: MessageEvent): void => {
        let msg: ServerMessage;
        try {
          msg = JSON.parse(String(ev.data)) as ServerMessage;
        } catch {
          return;
        }
        if (msg.kind !== "response" || msg.id !== id) return;
        ws.removeEventListener("message", onMessage);
        finish(() => {
          clearTimeout(overallTimer);
          ws.close();
          if (msg.kind === "response" && msg.ok) {
            resolve();
          } else {
            reject(new GatewayAuthError(msg.kind === "response" ? (msg.error ?? "認證失敗") : "認證失敗"));
          }
        });
      };
      ws.addEventListener("message", onMessage);
      ws.send(JSON.stringify({ id, method: "auth", params: { token } }));
    });

    ws.addEventListener("error", () => {
      finish(() => {
        clearTimeout(overallTimer);
        reject(new GatewayNetworkError("無法連線到伺服器,請確認位址是否正確"));
      });
    });

    ws.addEventListener("close", () => {
      finish(() => {
        clearTimeout(overallTimer);
        reject(new GatewayNetworkError("連線在完成認證前被伺服器關閉"));
      });
    });
  });
}
