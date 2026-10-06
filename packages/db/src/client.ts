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
 *
 * 2026-10-02(P2:移除 profile,見 docs/LAYER-4-detail-design/simplify-agents-sessions_detail.md
 * §P2.3):同樣**不 DROP `agent_profiles`、不修改它的任何資料**。全新安裝不再建立這張表;
 * 既有 DB 裡的表原封不動留著,唯一還會讀它的是 `backfillLegacySessionsProvider()`
 * (啟動時一次、冪等、**只 SELECT**),把舊 session 補上自帶的 provider/launch 欄位。
 * `agent_profiles` 的補欄位遷移(`ensureAgentProfiles*Column`)與
 * `migrateAutoAcceptAllPermissionLevel()`(對 profile 的 permission_level 做 UPDATE)
 * 都已移除——沒有程式碼再讀那些欄位,也不該再改動這張變成唯讀歷史資料的表。
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
      title_source TEXT,
      -- 舊欄位(2026-10-02 起不再是 profile id):SQLite 不能直接改 NOT NULL 約束,
      -- 所以保留欄位,新 session 寫入 provider id 當值。見 schema.ts 的 legacyAgentProfileId。
      agent_profile_id TEXT NOT NULL,
      provider_id TEXT,
      launch_command TEXT,
      launch_args TEXT,
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
      origin TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);

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
  ensureMessagesOriginColumn(sqlite);
  ensureSessionsLaunchColumns(sqlite);
  backfillLegacySessionsProvider(sqlite);
  ensureSessionsTitleSourceColumn(sqlite);

  return drizzle(sqlite, { schema });
}

/**
 * 2026-10-06(session 改名/AI 自動命名):對「已存在的舊 DB 檔案」補上 `sessions.title_source` 欄位並回填。
 * 補欄位的作法比照 `ensureSessionsModelColumn()`。
 *
 * 回填規則(只處理 `title_source IS NULL` 的列,所以冪等——回填後一律非 NULL,下次啟動沒有東西可做):
 *   - 標題還是預設的「新對話」→ `default`:第一則人類輸入之後會自動命名(舊 session 早就有訊息了,所以實務上要等
 *     下一則人類輸入才會觸發;使用者也可以按「AI 重新命名」)。
 *   - 其他 → `user`:不知道當年是誰取的(UI 建立時給的、`create_session` 帶的、接手時組的),一律當成使用者取的,
 *     AI 不自動覆蓋。
 */
function ensureSessionsTitleSourceColumn(sqlite: Database.Database): void {
  const columns = sqlite.prepare("PRAGMA table_info(sessions)").all() as { name: string }[];
  if (!columns.some((col) => col.name === "title_source")) {
    try {
      sqlite.exec("ALTER TABLE sessions ADD COLUMN title_source TEXT");
    } catch {
      // 欄位已存在(競態)或其他非預期情況,同上——不讓啟動流程因此中斷。
    }
  }
  try {
    sqlite
      .prepare("UPDATE sessions SET title_source = CASE WHEN title = ? THEN 'default' ELSE 'user' END WHERE title_source IS NULL")
      .run("新對話");
  } catch (err) {
    // 回填失敗不阻擋啟動:rowToSession() 對 NULL 用同一條規則推導,行為一致,下次啟動會再試。
    console.error(`[db] sessions.title_source 回填失敗(啟動流程仍繼續): ${String(err)}`);
  }
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
 * 對已存在的表不會補欄位)。三個欄位一起檢查/補上,理由:同一輪新增、彼此沒有
 * 先後依賴,合併成一次 PRAGMA 查詢即可。
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

/**
 * 2026-10-02(P3:session 網路):對「已存在的舊 DB 檔案」補上 `messages.origin` 欄位——跨 session 訊息的
 * 來源標記(`MessageOrigin` 序列化成的 JSON,見 packages/shared/src/session.ts 的 `MessageOriginSchema`)。
 * 理由與作法完全比照 `ensureMessagesAttachmentsColumn()`:`ALTER TABLE ADD COLUMN` 對既有列填 NULL,
 * 正是「人類輸入/沒有來源」的正確既有語意,不需要回填。
 */
function ensureMessagesOriginColumn(sqlite: Database.Database): void {
  const columns = sqlite.prepare("PRAGMA table_info(messages)").all() as { name: string }[];
  const hasColumn = columns.some((col) => col.name === "origin");
  if (hasColumn) return;
  try {
    sqlite.exec("ALTER TABLE messages ADD COLUMN origin TEXT");
  } catch {
    // 欄位已存在(競態)或其他非預期情況,同上——不讓啟動流程因此中斷。
  }
}

/**
 * 2026-10-02(P2:移除 profile):對「已存在的舊 DB 檔案」補上 `sessions.provider_id` /
 * `launch_command` / `launch_args` 三個欄位——session 自帶啟動資訊,續接時不再讀
 * `agent_profiles`(見 SessionManager.continueSession())。理由與作法比照
 * `ensureSessionsRecoveryColumns()`(三個欄位同一輪新增、沒有先後依賴,一次 PRAGMA 查詢)。
 * 欄位全部 nullable:舊 session 的值由下面的 `backfillLegacySessionsProvider()` 回填。
 */
function ensureSessionsLaunchColumns(sqlite: Database.Database): void {
  const columns = sqlite.prepare("PRAGMA table_info(sessions)").all() as { name: string }[];
  const existing = new Set(columns.map((col) => col.name));
  for (const column of ["provider_id", "launch_command", "launch_args"] as const) {
    if (existing.has(column)) continue;
    try {
      sqlite.exec(`ALTER TABLE sessions ADD COLUMN ${column} TEXT`);
    } catch {
      // 欄位已存在(競態)或其他非預期情況,同上——不讓啟動流程因此中斷。
    }
  }
}

/** `backfillLegacySessionsProvider()` 從 `agent_profiles` 讀到的、有用的那幾欄(其餘一律不碰)。 */
interface LegacyProfileRow {
  software?: string;
  provider_id?: string | null;
  acp_config?: string | null;
  pty_config?: string | null;
  opencode_config?: string | null;
}

/** 從 `acp_config`/`pty_config`/`opencode_config` 的 JSON 取出 command/args;解析失敗或沒有 command 就當沒有。 */
function parseLaunchConfig(raw: string | null | undefined): { command: string; args: string[] | undefined } | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const { command, args } = parsed as { command?: unknown; args?: unknown };
    if (typeof command !== "string" || command.length === 0) return undefined;
    const argList = Array.isArray(args) && args.every((a) => typeof a === "string") ? (args as string[]) : undefined;
    return { command, args: argList };
  } catch {
    return undefined;
  }
}

/**
 * 2026-10-02(P2:移除 profile,見 simplify-agents-sessions_detail.md §P2.3):**舊資料回填遷移**——
 * 對 `provider_id IS NULL` 的 session 列,用 raw SQL 讀 `agent_profiles` 對應列,回填
 * `provider_id` / `launch_command` / `launch_args`,讓這些舊 session 從此自帶啟動資訊、
 * 續接時不必再讀 profile(profile 功能已整個移除)。
 *
 * 回填規則:
 *   - 找得到對應 profile **且 `profile.software === session.adapter_type`**:
 *       providerId = profile.provider_id;沒有的話 software 為 claude-agent-sdk →
 *       `"claude-agent-sdk"`,其餘 → `"legacy-<software>"`。launch 取自對應 software 的
 *       `acp_config`/`pty_config`/`opencode_config` JSON(command → `launch_command`,
 *       args → `launch_args` 的 JSON 字串)。
 *   - 找得到 profile 但 software **對不上** session 的 `adapter_type`(舊設計下用
 *     `agentOverride` 換過 agent 的 session——profile 描述的是 base agent,不是這個
 *     session 實際跑的那個):不採用 profile 的 providerId/launch(那會讓續接換回錯的
 *     agent,正是舊設計的既有 bug),providerId = `"claude-agent-sdk"`(adapter 本身是
 *     claude-agent-sdk)或 `"legacy-<adapter_type>"`,不填 launch。
 *   - 找不到 profile(或 `agent_profiles` 表不存在——全新安裝直接略過 SELECT):
 *       providerId = `"legacy-unknown"`,不填 launch,續接時由 SessionManager 明確報錯
 *       (claude-agent-sdk 的 session 不需要 command,續接仍然可行)。
 *
 * **只讀 `agent_profiles`,絕不刪改它**(表與資料原封不動留著,見檔頭說明)。用
 * `SELECT *` 而不是列舉欄位:很舊的 DB 裡這張表可能缺 `provider_id`/`opencode_config`
 * 等後來才加的欄位(我們已不再替它補欄位),`SELECT *` 只拿得到實際存在的,缺的當作沒有。
 *
 * 冪等:只處理 `provider_id IS NULL` 的列,回填後一律非 NULL,下一次啟動沒有東西可做。
 * 整批包在單一 transaction 裡——中途失敗就整批不生效,下次啟動重來。
 */
function backfillLegacySessionsProvider(sqlite: Database.Database): void {
  const pending = sqlite
    .prepare("SELECT id, agent_profile_id, adapter_type FROM sessions WHERE provider_id IS NULL")
    .all() as { id: string; agent_profile_id: string; adapter_type: string }[];
  if (pending.length === 0) return;

  const hasProfilesTable =
    sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agent_profiles'").get() !== undefined;
  const selectProfile = hasProfilesTable ? sqlite.prepare("SELECT * FROM agent_profiles WHERE id = ?") : undefined;
  const update = sqlite.prepare("UPDATE sessions SET provider_id = ?, launch_command = ?, launch_args = ? WHERE id = ?");

  const run = sqlite.transaction(() => {
    for (const row of pending) {
      const profile = selectProfile?.get(row.agent_profile_id) as LegacyProfileRow | undefined;
      let providerId: string;
      let launch: { command: string; args: string[] | undefined } | undefined;
      if (!profile) {
        providerId = "legacy-unknown";
      } else if (profile.software !== row.adapter_type) {
        providerId = row.adapter_type === "claude-agent-sdk" ? "claude-agent-sdk" : `legacy-${row.adapter_type}`;
      } else {
        providerId =
          profile.provider_id || (profile.software === "claude-agent-sdk" ? "claude-agent-sdk" : `legacy-${profile.software}`);
        launch = parseLaunchConfig(
          profile.software === "acp"
            ? profile.acp_config
            : profile.software === "pty"
              ? profile.pty_config
              : profile.software === "opencode"
                ? profile.opencode_config
                : undefined,
        );
      }
      update.run(providerId, launch?.command ?? null, launch?.args ? JSON.stringify(launch.args) : null, row.id);
    }
  });
  try {
    run();
    console.warn(
      `[db] 舊 session 回填:${pending.length} 個 session 沒有自帶的 provider 資訊(建立於 profile 移除之前),` +
        "已依它們的 agent profile 回填 provider_id/launch_command/launch_args(agent_profiles 表本身未被改動)。",
    );
  } catch (err) {
    console.error(`[db] 舊 session 回填失敗(啟動流程仍繼續;這些 session 的續接可能報錯,下次啟動會再嘗試): ${String(err)}`);
  }
}
