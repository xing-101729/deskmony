import type { GlobalOptions } from "../args.js";
import { CliExitError } from "../connect.js";

/**
 * `deskmony tui`——全螢幕 TUI 的唯一進入點(docs/LAYER-3-hld/cli-tui_hld.md
 * §5.2、§9)。
 *
 * **這個檔案是整個 repo 裡唯一允許 import `../tui/app.js` 的地方**,而且
 * 必須是 `await import()`(動態),不能是頂層 `import`——理由與
 * `commands/serve.ts` 動態 import `@deskmony/core` 不同(那裡是為了環境
 * 變數的求值順序),這裡純粹是啟動成本:`ink@7.1.1` 會帶進 `react`、
 * `react-reconciler`、`yoga-layout`(WASM)與數十個 transitive 相依
 * (§5.1 誠實記過這筆帳),若在任何頂層 import 裡引到 `tui/` 目錄,
 * `bin.ts` 的 module graph 就會在**每一個**指令啟動時載入這一整包,即使
 * 使用者只是想跑 `deskmony run --help`。動態 import 保證這包東西只在真的
 * 執行 `tui` 這個子指令時才會被解析/執行,`run`/`serve`/`session`/
 * `profile`/`doctor`/`config` 的啟動時間完全不受影響(驗收方式見
 * scripts 底下這輪新增的一次性計時腳本,把結果貼進 PR/交接紀錄,不是
 * 進 CI 的常態斷言)。
 */

/** Ink 7 要求 Node >= 22(§5.2 已驗證的事實,不是猜測);根目錄
 *  `engines.node` 維持 `>=20` 不變,只有這個子指令有更高的門檻。 */
const MIN_NODE_MAJOR = 22;

function parseNodeMajor(versionString: string): number | undefined {
  const major = Number(versionString.split(".")[0]);
  return Number.isFinite(major) ? major : undefined;
}

export async function tuiCommand(options: GlobalOptions): Promise<void> {
  const major = parseNodeMajor(process.versions.node);
  if (major === undefined || major < MIN_NODE_MAJOR) {
    // 退出碼 2、清楚的訊息、**不要**讓它演變成模組頂層的語法/相容性錯誤
    // 才崩潰——這是這個檢查存在的唯一理由。因為 ink/react 是動態 import
    // 的,這個檢查在任何一行 ink 相關程式碼被解析之前就先擋下,Node 20
    // 使用者不會看到一坨看不懂的堆疊,只會看到這則訊息。
    throw new CliExitError(
      2,
      `全螢幕 TUI 需要 Node ${MIN_NODE_MAJOR} 以上,目前是 v${process.versions.node};` + "其餘指令不受影響,可改用 deskmony chat。",
    );
  }

  /**
   * 全螢幕 TUI 的本質就是要接管一個真正的終端機(alternate screen、raw
   * mode)——design 文件的 §3.1(尺寸退化)只處理「終端機太小」,沒有處理
   * 「根本不是終端機」(管線、CI、`> file.txt` 重導向)這個更早的前提。
   * 不擋住這個情況的話,`tui/app.tsx` 呼叫 `process.stdin.setRawMode(true)`
   * 會直接拋出 Node 內建的例外(`Error: setRawMode is not a function` 之類,
   * 見 ink 自己的 `App.js` 對同一件事的處理:它也是先檢查
   * `stdin.isTTY`,不支援就丟出明確訊息而不是任由呼叫失敗)。這裡提早用
   * 同一種退出碼給出可讀訊息,而不是讓使用者看到一段不知所云的堆疊。
   */
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    throw new CliExitError(
      2,
      "deskmony tui 需要在真正的終端機中執行(stdin 與 stdout 都必須是 TTY);" + "目前不是,可改用 deskmony chat 或 deskmony run。",
    );
  }

  const { runTui } = await import("../tui/app.js");
  await runTui(options);
}
