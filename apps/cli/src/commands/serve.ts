import type { GlobalOptions } from "../args.js";
import { CliExitError } from "../connect.js";

/**
 * `deskmony serve`——在前景跑 headless core(HLD §2/§4.2)。
 *
 * §13.1(動手前先用一次性腳本對真的 core 查證過,不是紙上推論,見
 * docs/LAYER-3-hld/cli_hld.md):**必須用動態 `import()`**,不能在檔案頂端
 * 靜態 `import "@deskmony/core"`。原因:`apps/core/src/index.ts` 是「這個
 * 模組被 import 的當下就執行 `main()`」的寫法(檔案最底部
 * `main().catch(...)`,沒有包在任何 export 的函式裡讓呼叫端決定何時
 * 執行)。ESM 的靜態 import 一律在模組本體最上面、於任何其他程式碼之前
 * 求值完成,若這裡用靜態 import,下面「把旗標翻成
 * `process.env.DESKMONY_*`」的程式碼會排在 core 的 `main()` 已經讀完
 * `process.env` 之後才執行——等於白設。動態 `import()` 是一般函式呼叫,
 * 保證按照原始碼順序,先設完環境變數才觸發 core 開始執行。
 */
export async function serveCommand(options: GlobalOptions): Promise<void> {
  // 只有使用者真的給了 --url(或 DESKMONY_URL)才覆寫 core 的綁定位址——
  // `options.url` 沒被明講時就是 CLI 自己寫死的預設值(args.ts 的
  // DEFAULT_URL),不代表使用者要求 core 綁在那個位址。沒給的話什麼都不
  // 設,交給 core 自己的 loadConfig()(defaults → config.json → 環境變數
  // 分層合併,見 apps/core/src/config/load-config.ts)決定——這正是 HLD
  // §2「優先序一律旗標 > 環境變數 > 預設」的意思:CLI 這一層完全沒有意見
  // 時,不該生出一個「意見」出來蓋過使用者已經在 config.json 設定好的值。
  if (options.urlExplicit) {
    let parsed: URL;
    try {
      parsed = new URL(options.url);
    } catch {
      throw new CliExitError(2, `--url 不是合法的網址:${options.url}`);
    }
    process.env.DESKMONY_BIND_HOST = parsed.hostname;
    if (parsed.port) process.env.DESKMONY_CORE_PORT = parsed.port;
  }
  // --token 天生就是「沒給就是 undefined」(不像 --url 有預設值),不需要
  // 額外的 explicit 旗標就能分辨。
  if (options.token !== undefined) {
    process.env.DESKMONY_AUTH_TOKEN = options.token;
  }

  process.stdout.write("[deskmony] 啟動 core(同一行程內)...Ctrl+C/SIGTERM 交給 core 既有的關閉流程處理。\n");

  // 不用 try/catch 包這一行——core 自己的 `main().catch()` 已經會在啟動
  // 失敗時印出錯誤並 `process.exit(1)`(見 apps/core/src/index.ts 最底部),
  // 這裡重複 catch 只會製造第二層、語意重複的錯誤訊息。真的丟出例外時
  // (理論上不該發生,core 自己已經兜底)就讓它原樣往上傳給 bin.ts 的
  // catch-all,以退出碼 1 結束並印出堆疊——比在這裡吞掉再包一層更誠實。
  await import("@deskmony/core");

  // `core` 的 `main()` 執行到 `gateway.listen()` 之後就不會再自然結束——
  // 唯一會讓這個 Node 行程退出的路徑是 core 自己的 SIGINT/SIGTERM handler
  // 呼叫 `process.exit(0)`(見 index.ts 的 `shutdown()`)。這個函式 await
  // 完 `import()` 之後就直接返回,**刻意不在這裡另外註冊任何 SIGINT/
  // SIGTERM handler、也不設 process.exitCode**——HLD §7 明講「serve 只把
  // SIGINT/SIGTERM 交給 core 既有的關閉流程」,bin.ts 對 `serve` 也刻意不
  // 裝那個給其餘一次性指令用的「Ctrl+C 直接離開、退出碼 130」(見 bin.ts
  // 的說明)。這正是 HLD §1「CLI 不是第二個 orchestrator」在 `serve` 這個
  // 指令上最直接的體現:一旦 `import()` 完成,行程的生死完全交給 core 自
  // 己既有、已經被充分驗證過的生命週期管理,CLI 不插手、也不重新發明。
}
