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
 */
export function createDb(dbFilePath: string): NexusDb {
  const dir = path.dirname(dbFilePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const sqlite = new Database(dbFilePath);
  sqlite.pragma("journal_mode = WAL");

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

    CREATE TABLE IF NOT EXISTS teams (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      working_dir TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS team_members (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL,
      agent_profile_id TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      can_interrupt INTEGER NOT NULL DEFAULT 0,
      lifecycle TEXT NOT NULL DEFAULT 'ephemeral',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_team_members_team_id ON team_members(team_id);

    CREATE TABLE IF NOT EXISTS team_messages (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL,
      from_name TEXT NOT NULL,
      from_role TEXT,
      to_target TEXT NOT NULL,
      content TEXT NOT NULL,
      priority TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      source TEXT NOT NULL,
      note TEXT,
      delivered_at INTEGER,
      context_id TEXT NOT NULL DEFAULT 'legacy'
    );

    CREATE INDEX IF NOT EXISTS idx_team_messages_team_id ON team_messages(team_id);

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'backlog',
      assignee_member_id TEXT,
      workspace_id TEXT,
      blocked_from TEXT,
      acceptance TEXT,
      awaiting_human_review INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_team_id ON tasks(team_id);

    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      base_dir TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      branch TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_workspaces_task_id ON workspaces(task_id);

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
  ensureSessionsRecoveryColumns(sqlite);
  ensureSessionsParentColumn(sqlite);
  ensureAgentProfilesOpencodeConfigColumn(sqlite);
  ensureAgentProfilesProviderColumns(sqlite);
  ensureTasksAcceptanceColumn(sqlite);
  ensureTasksAwaitingHumanReviewColumn(sqlite);
  ensureTeamMessagesBudgetColumns(sqlite);
  ensureTeamMembersLifecycleColumn(sqlite);
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
 * S4(機器驗收閘):對「已存在的舊 DB 檔案」補上 `tasks.acceptance` 欄位
 * ——理由與作法完全比照上面的 `ensureSessionsModelColumn()`。
 */
function ensureTasksAcceptanceColumn(sqlite: Database.Database): void {
  const columns = sqlite.prepare("PRAGMA table_info(tasks)").all() as { name: string }[];
  const hasColumn = columns.some((col) => col.name === "acceptance");
  if (hasColumn) return;
  try {
    sqlite.exec("ALTER TABLE tasks ADD COLUMN acceptance TEXT");
  } catch {
    // 欄位已存在(競態)或其他非預期情況,同上——不讓啟動流程因此中斷。
  }
}

/**
 * S5(dispose-gate):對「已存在的舊 DB 檔案」補上 `tasks.awaiting_human_review`
 * 欄位——理由與作法完全比照上面的 `ensureTasksAcceptanceColumn()`。帶
 * `NOT NULL DEFAULT 0`(SQLite 的 `ALTER TABLE ADD COLUMN` 允許在新增欄位時
 * 一併指定常數預設值),既有 row 一律補成 0(= 沒有在等待人類核可),無破壞性。
 */
function ensureTasksAwaitingHumanReviewColumn(sqlite: Database.Database): void {
  const columns = sqlite.prepare("PRAGMA table_info(tasks)").all() as { name: string }[];
  const hasColumn = columns.some((col) => col.name === "awaiting_human_review");
  if (hasColumn) return;
  try {
    sqlite.exec("ALTER TABLE tasks ADD COLUMN awaiting_human_review INTEGER NOT NULL DEFAULT 0");
  } catch {
    // 欄位已存在(競態)或其他非預期情況,同上——不讓啟動流程因此中斷。
  }
}

/**
 * S2(message-budget)L4 §1/§1.1:對「已存在的舊 DB 檔案」補上
 * `team_messages.delivered_at` / `team_messages.context_id` 兩個欄位,並對
 * **這次遷移當下真的補上欄位** 的既有列做一次性的「一律標記已送達」回填。
 *
 * 兩個欄位的補欄位手法本身比照 `ensureSessionsRecoveryColumns()`,但這裡多了
 * 一步**絕對不能省略、也絕對不能每次啟動都重跑**的資料回填:
 *   - `delivered_at` 沒有 SQL `DEFAULT`(`ALTER TABLE ADD COLUMN` 對已存在的列
 *     一律先填 NULL),新增後**立刻**對這批舊列執行一次
 *     `UPDATE team_messages SET delivered_at = timestamp WHERE delivered_at IS NULL`
 *     ——舊資料一律視為「升級前已經處理完了」,見
 *     docs/LAYER-4-detail-design/message-budget_detail.md §1.1 的完整理由
 *     (預設 NULL = 全部被當成待投遞,升級後會一次全部灌給 agent,是災難)。
 *   - **這個 UPDATE 只能在「這次呼叫真的補上了欄位」這個分支裡執行一次**——
 *     `delivered_at IS NULL` 從此以後是 MessageBus Mailbox 的**權威**待投遞
 *     判斷(§5),若這段 UPDATE 每次 `createDb()`(=每次 core 啟動)都無條件
 *     重跑,會把當時**真正**待投遞、還沒送達的訊息也一併誤標成已送達,直接
 *     摧毀「崩潰重啟後未送達訊息不遺失」這個驗收核心。用「欄位在這次呼叫之前
 *     不存在」這個一次性事實當作執行回填的唯一觸發條件,天然冪等:欄位已存在
 *     時(絕大多數啟動)整個函式直接 return,不會重跑。
 *   - `context_id` 有 SQL `DEFAULT 'legacy'`,`ALTER TABLE ADD COLUMN` 本身就會
 *     幫舊列填好,不需要額外 UPDATE(舊資料的 `context_id = "legacy"` 天生就
 *     符合「不參與預算計算」的要求,見 schema.ts 的 `teamMessages` 註解)。
 */
function ensureTeamMessagesBudgetColumns(sqlite: Database.Database): void {
  const columns = sqlite.prepare("PRAGMA table_info(team_messages)").all() as { name: string }[];
  const hasDeliveredAt = columns.some((col) => col.name === "delivered_at");
  if (hasDeliveredAt) return; // 欄位已存在——不是這次才補上,絕不重跑回填 UPDATE。

  try {
    sqlite.exec("ALTER TABLE team_messages ADD COLUMN delivered_at INTEGER");
  } catch {
    // 欄位已存在(競態)或其他非預期情況,同上——不讓啟動流程因此中斷。
    return;
  }
  try {
    sqlite.exec("ALTER TABLE team_messages ADD COLUMN context_id TEXT NOT NULL DEFAULT 'legacy'");
  } catch {
    // 同上。
  }

  try {
    const result = sqlite.exec("UPDATE team_messages SET delivered_at = timestamp WHERE delivered_at IS NULL");
    void result;
    console.warn(
      "[db] 偵測到既有 team_messages 資料(升級前建立),已依 " +
        "docs/LAYER-4-detail-design/message-budget_detail.md §1.1 一律標記為已送達" +
        "(delivered_at = timestamp)、context_id 標記為 \"legacy\"(不參與訊息預算計算)。",
    );
  } catch (err) {
    console.error(`[db] 回填 team_messages.delivered_at 失敗(啟動流程仍繼續,但這些舊列會被當成待投遞): ${String(err)}`);
  }
}

/**
 * S8(agent-lifecycle):對「已存在的舊 DB 檔案」補上 `team_members.lifecycle`
 * 欄位——理由與作法完全比照 `ensureTasksAcceptanceColumn()`。`ALTER TABLE
 * ADD COLUMN ... DEFAULT 'ephemeral'` 本身就會幫舊列填好預設值,不需要額外
 * UPDATE(既有 member 一律視為 ephemeral,見 agent-lifecycle_detail.md §1
 * 「遷移:既有 member 一律 ephemeral,但不自動 dispose 任何現存 session」)。
 */
function ensureTeamMembersLifecycleColumn(sqlite: Database.Database): void {
  const columns = sqlite.prepare("PRAGMA table_info(team_members)").all() as { name: string }[];
  const hasColumn = columns.some((col) => col.name === "lifecycle");
  if (hasColumn) return;
  try {
    sqlite.exec("ALTER TABLE team_members ADD COLUMN lifecycle TEXT NOT NULL DEFAULT 'ephemeral'");
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
