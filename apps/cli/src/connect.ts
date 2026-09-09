import WebSocket from "ws";
import { GatewayClient, GatewayAuthError, probeGatewayConnection, type WebSocketLike } from "@deskmony/client";

/**
 * 帶著明確退出碼的例外——bin.ts 是**唯一**呼叫 `process.exit`/設定
 * `process.exitCode` 的地方(HLD 描述 bin.ts「只做 argv 分派與退出碼」),
 * 其餘所有檔案(connect.ts 本身、commands/*.ts)只丟這個型別的例外表達
 * 「這個指令該用哪個退出碼結束」,不各自散落 `process.exit(...)` 呼叫。
 * 好處:退出碼的意義(HLD §2 那張表)只需要在丟出例外的當下決定一次,
 * bin.ts 的 catch 區塊不用重新判斷「這個錯誤代表什麼」。
 */
export class CliExitError extends Error {
  constructor(
    readonly exitCode: number,
    message: string,
  ) {
    super(message);
    this.name = "CliExitError";
  }
}

/** 連線探測(見 connectGateway())與正式連線各自的逾時上限——刻意與 `run`
 *  的 `--timeout`(整個回合的上限,預設 10 分鐘)分開:這裡只管「連得上
 *  gateway 嗎」,在區網/本機情境下應該是毫秒等級的事,5 秒已經很寬鬆。 */
const CONNECT_TIMEOUT_MS = 5_000;

/**
 * §13.2(已對真的 core 查證過,見 docs/LAYER-3-hld/cli_hld.md):`ws` 套件的
 * WebSocket 實例結構上相容於 `@deskmony/client` 的 `WebSocketLike`——
 * `addEventListener`/`removeEventListener`/`send`/`close`/`readyState` 都有,
 * `"message"` 事件的 `ev.data` 是 string,`GatewayClient` 內部的
 * `JSON.parse(ev.data)` 不用改一行。這裡的 `as unknown as` 跟
 * `packages/client/src/gateway-client.ts` 的 `defaultWebSocketFactory`
 * 用的是同一招——`ws` 自己的型別定義用更精確的 event-name 對應多載,
 * 和 `WebSocketLike` 刻意簡化過的介面不會逐字互相賦值相容,但執行期行為
 * (才是真正被驗證過的東西)完全一致。
 */
const nodeWebSocketFactory = (url: string): WebSocketLike => new WebSocket(url) as unknown as WebSocketLike;

export interface ConnectParams {
  url: string;
  token: string | undefined;
}

/**
 * 連線 + 認證的唯一入口,所有指令(除了 `serve`,那個是另一回事——見
 * commands/serve.ts)都經過這裡拿 `GatewayClient`。
 *
 * **為什麼不直接對長駐用的 `GatewayClient` 等 `onStatus()`**:那個 API 只
 * 回報粗粒度的 "connecting"/"open"/"closed" 三態,而「連不上」與「token 錯」
 * 這兩種情況(HLD §2 退出碼表都對應到 3,但錯誤訊息**必須**分開——驗收條款
 * 明講「連不上→訊息要指引 deskmony serve」「token 錯→絕不能把 token 印進
 * 輸出」)在這個 API 上**都**只會走到 "closed"(見
 * packages/client/src/gateway-client.ts 的 `connect()`:認證失敗時,
 * `sendNow("auth",...)` 的 rejection 只是拿去呼叫 `this.ws?.close()`,對外
 * 仍然只是一次 "closed" 狀態轉換,兩種失敗在這層完全無法分辨)。
 *
 * `@deskmony/client` 剛好已經有一個為了同一個原因存在的函式——
 * `probeGatewayConnection()`(桌面殼的 ConnectScreen.tsx 拿來分辨「連不上」
 * vs「認證失敗」用,見該函式的完整說明),丟出型別不同的
 * `GatewayNetworkError`/`GatewayAuthError`。這裡直接重用,而不是自己重新
 * 發明一套連線層錯誤分類(也不必去猜 `ws` 套件的 error/close code 語意,
 * 那些在不同 Node/ws 版本之間不保證穩定)——多付出一次「先探測、成功後才
 * 建立真正要用的長駐連線」的短命 WS 往返,換來與桌面殼完全一致、已經被
 * 驗證過的錯誤分類邏輯。
 */
export async function connectGateway(params: ConnectParams): Promise<GatewayClient> {
  try {
    await probeGatewayConnection(params.url, params.token ?? "", CONNECT_TIMEOUT_MS, nodeWebSocketFactory);
  } catch (err) {
    if (err instanceof GatewayAuthError) {
      throw new CliExitError(3, "認證失敗:token 不正確,或伺服器已啟用認證但未提供 --token。");
    }
    const detail = err instanceof Error ? err.message : String(err);
    throw new CliExitError(
      3,
      `連不上 gateway(${params.url}):${detail}\n` +
        "請確認 core 是否已啟動——可在另一個終端機執行「deskmony serve」,或用 --url 指向正確位址。",
    );
  }

  const client = new GatewayClient(params.url, params.token, nodeWebSocketFactory);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new CliExitError(3, "連線異常:探測(probe)剛成功,但正式連線逾時未完成,請重試。"));
    }, CONNECT_TIMEOUT_MS);
    const unsubscribe = client.onStatus((status) => {
      if (status === "open") {
        clearTimeout(timer);
        unsubscribe();
        resolve();
      }
      // "closed" 理論上不會在這裡發生(探測剛成功過,同一個 url/token)。
      // 真的發生時交給上面的逾時兜底處理,不在這裡搶著 reject——避免
      // "closed" 事件與逾時計時器同時觸發時,兩條路徑都想 settle 同一個
      // promise(onStatus 的 unsubscribe 在 resolve 分支才會被呼叫,重複
      // reject 沒有實際壞處,但沒必要留這個模糊地帶)。
    });
    client.connect();
  });
  return client;
}

/**
 * 一次性指令(run/session/profile/doctor/config)共用的收尾動作。
 *
 * **這一步不可省略**:`GatewayClient` 是為桌面殼「長駐」設計的,斷線後
 * 預設會 `setTimeout(reconnect, 2000)` 自動重連(見
 * packages/client/src/gateway-client.ts 的 `scheduleReconnect()`),那顆
 * 計時器沒有呼叫 `unref()`。一次性 CLI 指令如果只是把業務邏輯跑完、設好
 * `process.exitCode` 就放著不管,Node 事件迴圈仍然會因為這顆計時器不肯
 * 自然結束——行程會卡住不退出,使用者只能 Ctrl+C 強制中止,而這正是這個
 * 專案的安全罩最痛恨的那種「靜默不對勁」。`client.disconnect()` 會設定
 * `closedByUser = true`,close 事件處理器看到這個旗標就不會排下一次重連。
 */
export function closeGateway(client: GatewayClient): void {
  client.disconnect();
}
