import path from "node:path";
import fs from "node:fs";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

export type NexusDb = BetterSQLite3Database<typeof schema>;

/**
 * 建立(必要時初始化)SQLite 資料庫連線。
 * M1 採「啟動時自我修復 schema」策略(CREATE TABLE IF NOT EXISTS),
 * 尚未導入 drizzle-kit migration 檔案 — 見 README 已知限制。
 *
 * 2026-10-02(P1:移除 team/task/看板,見 docs/DECISIONS.md §H):`teams`/
 * `team_members`/`team_messages`/`tasks`/`workspaces` 五張表的建表語句與
 * `ensure*` 補欄位遷移已移除——**但不 DROP 任何資料表、不寫任何刪資料的遷移**:
 * 既有使用者 DB 裡的這幾張表(與資料)原封不動留在檔案裡,只是沒有程式碼再碰它。
 */
export function createDb(dbFilePath: string): NexusDb {
  const dir = path.dirname(dbFilePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const sqlite = new Database(dbFilePath);
  sqlite.pragma("journal_mode = WAL");
  /**
   * 2026-09-04(稽核修補):`busy_timeout`。
   *
   * better-sqlite3 的預設是**遇到鎖定衝突立即拋出 `SQLITE_BUSY`**,不等待、
   * 不重試。正常情況下只有 core 自己一個 process 開這個檔案,不太會自己跟自己
   * 搶鎖;但只要有第二個東西同時碰到它 —— 使用者用 DB Browser 手動檢視、一個
   * 沒有正確隔離 `DESKMONY_DATA_DIR` 的第二個 core 實例(這在本專案的開發史上
   * 真的發生過)、任何備份腳本 —— 就會拋例外。
   *
   * 而那個例外會一路餵給 `SessionManager.consumeEvents()`。在補上事件迴圈圍籬
   * 之前,那等於整個 core 崩潰;現在雖然只會殺掉一條 session,仍然是「一次巧合
   * 的並行存取就讓一條 agent 對話死掉」——用一行 pragma 換掉這個風險很划算。
   *
   * 5 秒是保守值:WAL 模式下寫鎖通常只持續毫秒等級,會真的等滿 5 秒代表另一端
   * 卡住了,那時候拋錯反而是對的(不該無限等下去把事件迴圈也拖住)。
   */
  sqlite.pragma("busy_timeout = 5000");

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '新對話',
      agent_profile_id TEXT NOT NULL,
      adapter_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'idle',
      working_dir TEXT NOT NULL,
      last_error TEXT,
      model TEXT,
      effort TEXT,
      interrupted_at INTEGER,
      last_seen_at INTEGER,
      backend_session_id TEXT,
      parent_session_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      attachments TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);

    CREATE TABLE IF NOT EXISTS agent_profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'Coder',
      software TEXT NOT NULL,
      provider_id TEXT,
      model TEXT,
      effort TEXT,
      system_prompt TEXT,
      mcp_config TEXT,
      permission_level TEXT NOT NULL DEFAULT 'always-ask',
      working_dir TEXT NOT NULL,
      env TEXT,
      acp_config TEXT,
      pty_config TEXT,
      opencode_config TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS enforcement_audit (
      id TEXT PRIMARY KEY,
      ts INTEGER NOT NULL,
      kind TEXT NOT NULL,
      session_id TEXT,
      request_id TEXT,
      tool_name TEXT,
      effect TEXT,
      reason TEXT,
      payload TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_enforcement_audit_session_id ON enforcement_audit(session_id);

    CREATE TABLE IF NOT EXISTS usage_rollup (
      scope TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      cost_amount REAL NOT NULL DEFAULT 0,
      cost_currency TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (scope, scope_id)
    );
  `);

  ensureSessionsModelColumn(sqlite);
  ensureSessionsEffortColumn(sqlite);
  ensureSessionsRecoveryColumns(sqlite);
  ensureSessionsParentColumn(sqlite);
  ensureMessagesAttachmentsColumn(sqlite);
  ensureAgentProfilesOpencodeConfigColumn(sqlite);
  ensureAgentProfilesProviderColumns(sqlite);
  ensureAgentProfilesEffortColumn(sqlite);
  migrateAutoAcceptAllPermissionLevel(sqlite);

  return drizzle(sqlite, { schema });
}

/**
 * M5 Round C:對「已存在的舊 DB 檔案」補上 `sessions.model` 欄位。
 *
 * 上面的 `CREATE TABLE IF NOT EXISTS` 對新建立的 DB 已經含 `model` 欄位
 * (見 sessions 表定義),但對**已存在**、建立於這個欄位新增之前的 DB 檔案
 * 完全無效(`IF NOT EXISTS` 只判斷表本身是否存在,不會比對欄位差異)——
 * 這裡另外用 `PRAGMA table_info(sessions)` 檢查欄位是否已存在,沒有才
 * `ALTER TABLE ... ADD COLUMN`。
 *
 * 冪等設計:
 *   - 每次 `createDb()` 都會呼叫一次,欄位已存在時直接跳過,不會重複
 *     `ALTER TABLE`(SQLite 對同名欄位重複 `ADD COLUMN` 會丟例外,不是
 *     no-op,所以必須先檢查)。
 *   - 萬一檢查與實際執行之間出現非預期的競態(例如檢查時沒有、執行
 *     `ALTER TABLE` 時卻發現已存在),`try/catch` 吞掉這種「欄位已存在」
 *     的例外,不讓啟動流程因此中斷——這是「加欄位」這種非破壞性遷移可以
 *     接受的保守處理,不同於刪欄位/改型別那種需要嚴格把關的遷移。
 */
function ensureSessionsModelColumn(sqlite: Database.Database): void {
  const columns = sqlite.prepare("PRAGMA table_info(sessions)").all() as { name: string }[];
  const hasModelColumn = columns.some((col) => col.name === "model");
  if (hasModelColumn) return;
  try {
    sqlite.exec("ALTER TABLE sessions ADD COLUMN model TEXT");
  } catch {
    // 欄位已存在(競態)或其他非預期情況——加欄位遷移刻意設計成盡量不讓
    // 啟動流程中斷,見上方函式註解。
  }
}

/**
 * 這輪新增(思考程度):對「已存在的舊 DB 檔案」補上 `sessions.effort` 欄位
 * ——理由與作法完全比照上面的 `ensureSessionsModelColumn()`。
 */
function ensureSessionsEffortColumn(sqlite: Database.Database): void {
  const columns = sqlite.prepare("PRAGMA table_info(sessions)").all() as { name: string }[];
  const hasColumn = columns.some((col) => col.name === "effort");
  if (hasColumn) return;
  try {
    sqlite.exec("ALTER TABLE sessions ADD COLUMN effort TEXT");
  } catch {
    // 欄位已存在(競態)或其他非預期情況,同上——不讓啟動流程因此中斷。
  }
}

/**
 * S6(crash-recovery):對「已存在的舊 DB 檔案」補上 `sessions.interrupted_at` /
 * `sessions.last_seen_at` / `sessions.backend_session_id` 三個欄位——理由與
 * 作法完全比照 `ensureSessionsModelColumn()`(`CREATE TABLE IF NOT EXISTS`
 * 對已存在的表不會補欄位)。三個欄位一起檢查/補上,理由同
 * `ensureAgentProfilesProviderColumns()`:同一輪新增、彼此沒有先後依賴。
 */
function ensureSessionsRecoveryColumns(sqlite: Database.Database): void {
  const columns = sqlite.prepare("PRAGMA table_info(sessions)").all() as { name: string }[];
  const existing = new Set(columns.map((col) => col.name));
  for (const [column, ddlType] of [
    ["interrupted_at", "INTEGER"],
    ["last_seen_at", "INTEGER"],
    ["backend_session_id", "TEXT"],
  ] as const) {
    if (existing.has(column)) continue;
    try {
      sqlite.exec(`ALTER TABLE sessions ADD COLUMN ${column} ${ddlType}`);
    } catch {
      // 欄位已存在(競態)或其他非預期情況,同上——不讓啟動流程因此中斷。
    }
  }
}

/**
 * 這輪新增:對「已存在的舊 DB 檔案」補上 `agent_profiles.opencode_config`
 * 欄位——理由與作法完全比照上面的 `ensureSessionsModelColumn()`(`CREATE
 * TABLE IF NOT EXISTS` 對已存在的表不會補欄位,需要另外用
 * `PRAGMA table_info` 檢查後視情況 `ALTER TABLE`)。
 */
/**
 * S9(session-subagent):對「已存在的舊 DB 檔案」補上 `sessions.parent_session_id`
 * 欄位——理由與作法完全比照 `ensureSessionsModelColumn()`(`CREATE TABLE
 * IF NOT EXISTS` 對已存在的表不會補欄位,需要另外用 `PRAGMA table_info`
 * 檢查後視情況 `ALTER TABLE`)。同一輪新增的單一欄位,不需要特殊回填邏輯。
 */
function ensureSessionsParentColumn(sqlite: Database.Database): void {
  const columns = sqlite.prepare("PRAGMA table_info(sessions)").all() as { name: string }[];
  const hasColumn = columns.some((col) => col.name === "parent_session_id");
  if (hasColumn) return;
  try {
    sqlite.exec("ALTER TABLE sessions ADD COLUMN parent_session_id TEXT");
  } catch {
    // 欄位已存在(競態)或其他非預期情況,同上——不讓啟動流程因此中斷。
  }
}

/**
 * async-scribbling-llama.md Phase 6(使用者傳送圖片):對「已存在的舊 DB
 * 檔案」補上 `messages.attachments` 欄位——理由與作法完全比照
 * `ensureSessionsModelColumn()`(`CREATE TABLE IF NOT EXISTS` 對已存在的表
 * 不會補欄位,需要另外用 `PRAGMA table_info` 檢查後視情況 `ALTER TABLE`)。
 * Nullable、無 SQL DEFAULT,不需要額外回填——既有訊息一律沒有附件,
 * `ALTER TABLE ADD COLUMN` 對既有列天生就會填 NULL,這正是「沒有附件」的
 * 正確既有語意。
 */
function ensureMessagesAttachmentsColumn(sqlite: Database.Database): void {
  const columns = sqlite.prepare("PRAGMA table_info(messages)").all() as { name: string }[];
  const hasColumn = columns.some((col) => col.name === "attachments");
  if (hasColumn) return;
  try {
    sqlite.exec("ALTER TABLE messages ADD COLUMN attachments TEXT");
  } catch {
    // 欄位已存在(競態)或其他非預期情況,同上——不讓啟動流程因此中斷。
  }
}

function ensureAgentProfilesOpencodeConfigColumn(sqlite: Database.Database): void {
  const columns = sqlite.prepare("PRAGMA table_info(agent_profiles)").all() as { name: string }[];
  const hasColumn = columns.some((col) => col.name === "opencode_config");
  if (hasColumn) return;
  try {
    sqlite.exec("ALTER TABLE agent_profiles ADD COLUMN opencode_config TEXT");
  } catch {
    // 欄位已存在(競態)或其他非預期情況,同上——不讓啟動流程因此中斷。
  }
}

/**
 * 這輪新增(provider 目錄重構):對「已存在的舊 DB 檔案」補上
 * `agent_profiles.provider_id`/`agent_profiles.env` 這兩個欄位——理由與作法
 * 完全比照上面的 `ensureAgentProfilesOpencodeConfigColumn()`。兩個欄位一起
 * 檢查/補上(而不是分成兩個函式),因為它們是同一輪新增、沒有先後依賴關係,
 * 合併成一次 PRAGMA 查詢即可。
 */
function ensureAgentProfilesProviderColumns(sqlite: Database.Database): void {
  const columns = sqlite.prepare("PRAGMA table_info(agent_profiles)").all() as { name: string }[];
  const existing = new Set(columns.map((col) => col.name));
  if (!existing.has("provider_id")) {
    try {
      sqlite.exec("ALTER TABLE agent_profiles ADD COLUMN provider_id TEXT");
    } catch {
      // 欄位已存在(競態)或其他非預期情況,同上——不讓啟動流程因此中斷。
    }
  }
  if (!existing.has("env")) {
    try {
      sqlite.exec("ALTER TABLE agent_profiles ADD COLUMN env TEXT");
    } catch {
      // 同上。
    }
  }
}

/**
 * 這輪新增(思考程度):對「已存在的舊 DB 檔案」補上 `agent_profiles.effort`
 * 欄位——理由與作法完全比照上面的 `ensureSessionsModelColumn()`。
 */
function ensureAgentProfilesEffortColumn(sqlite: Database.Database): void {
  const columns = sqlite.prepare("PRAGMA table_info(agent_profiles)").all() as { name: string }[];
  const hasColumn = columns.some((col) => col.name === "effort");
  if (hasColumn) return;
  try {
    sqlite.exec("ALTER TABLE agent_profiles ADD COLUMN effort TEXT");
  } catch {
    // 欄位已存在(競態)或其他非預期情況,同上——不讓啟動流程因此中斷。
  }
}

/**
 * S7(auto-mode-and-yolo)L4 §1.1:**破壞性 schema 收窄**——
 * `PermissionLevelSchema`(packages/shared/src/agent-profile.ts)移除了
 * `"auto-accept-all"`,YOLO 現在只能是 session 暫態,不可持久化到 profile
 * (見該檔案頂端註解)。這裡對「已存在、還存著舊值的 DB 檔案」做一次性降級
 * 遷移(不是加欄位,是改資料值,比照既有 `ensure*Column()` 系列的冪等作風,
 * 但用 `UPDATE` 取代 `ALTER TABLE`):
 *
 *   UPDATE agent_profiles SET permission_level = 'auto-accept-edits'
 *     WHERE permission_level = 'auto-accept-all';
 *
 * **不可靜默**——這是使用者曾經明確設定過的東西,被強制降級卻毫無提示會讓
 * 人以為「怎麼原本設定的全自動突然失效」。執行時逐筆 `console.warn` 列出被
 * 降級的 profile(id + name),讓使用者至少在啟動 log 看得到。
 *
 * 冪等:每次 `createDb()` 都會呼叫,已經沒有 `auto-accept-all` 資料列時
 * `rows.length === 0`,直接 return,不會重複印警告或重複執行 UPDATE。
 */
function migrateAutoAcceptAllPermissionLevel(sqlite: Database.Database): void {
  const rows = sqlite
    .prepare("SELECT id, name FROM agent_profiles WHERE permission_level = 'auto-accept-all'")
    .all() as { id: string; name: string }[];
  if (rows.length === 0) return;

  console.warn(
    `[db] 偵測到 ${rows.length} 個 agent profile 使用已移除的 permissionLevel="auto-accept-all"` +
      `(YOLO 現在只能是 session 暫態、不可持久化,見 docs/LAYER-4-detail-design/auto-mode-and-yolo_detail.md §1.1),` +
      `已自動降級為 "auto-accept-edits":`,
  );
  for (const row of rows) {
    console.warn(`[db]   - profile ${row.id}("${row.name}"): auto-accept-all → auto-accept-edits`);
  }

  try {
    sqlite.exec("UPDATE agent_profiles SET permission_level = 'auto-accept-edits' WHERE permission_level = 'auto-accept-all'");
  } catch (err) {
    console.error(`[db] 降級 permission_level 失敗(啟動流程仍繼續,但這些 profile 仍是無效值): ${String(err)}`);
  }
}
