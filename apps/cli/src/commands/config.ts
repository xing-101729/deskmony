import type { GlobalOptions } from "../args.js";
import { closeGateway, connectGateway } from "../connect.js";

/**
 * `deskmony config show`——顯示 core 生效設定(`config.getEffective`,HLD
 * §2)。直接印 server 回傳的 `effective` 物件本身(每個欄位是
 * `{value, source}` 的形狀,見 packages/shared/src/core-config.ts 的
 * `effectiveFieldSchema`),不另外寫一個巢狀物件的人性化排版器——Phase 1
 * 用 `JSON.stringify(..., null, 2)` 已經夠讀,值得投入心力做美化排版的
 * 場景不是「顯示設定」這種一次性、低頻的查詢指令。
 *
 * 不需要額外遮罩:`config.getEffective` 在 core 端已經把
 * `DESKMONY_AUTH_TOKEN`(這份設定本來就沒有這個欄位,見 core-config.ts
 * 頂端「安全決定」說明)與 `webhook.url` 這類機敏欄位處理過,CLI 原樣印出
 * 收到的內容即可,不重複做一次可能跟 core 端邏輯漂移的遮罩判斷。
 */
export async function configShowCommand(options: GlobalOptions): Promise<void> {
  const client = await connectGateway({ url: options.url, token: options.token });
  try {
    const { effective } = (await client.call("config.getEffective", {})) as { effective: unknown };
    process.stdout.write(`${JSON.stringify(effective, null, options.json ? 0 : 2)}\n`);
  } finally {
    closeGateway(client);
  }
}
