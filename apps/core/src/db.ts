import path from "node:path";
import { createDb, type NexusDb } from "@deskmony/db";

/**
 * M1 資料庫檔案位置(M6 Round A 改為由呼叫端傳入 `dataDir`,不再自己讀
 * `process.env.DESKMONY_DATA_DIR`——這輪把所有 env 讀取集中到
 * `apps/core/src/config/load-config.ts`,`apps/core/src/index.ts` 從那裡取得
 * 合併後的 `config.data.dataDir` 再傳進來,沒有設定檔/環境變數時
 * `load-config.ts` 的預設值與這裡原本的 `path.join(os.homedir(), ".deskmony")`
 * 完全相同,行為不變)。
 */
export function resolveDbPath(dataDir: string): string {
  return path.join(dataDir, "deskmony.db");
}

export function initDb(dataDir: string): NexusDb {
  const dbPath = resolveDbPath(dataDir);
  console.log(`[db] using sqlite file at ${dbPath}`);
  return createDb(dbPath);
}
