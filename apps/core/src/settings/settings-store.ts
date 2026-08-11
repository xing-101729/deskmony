import { eq } from "drizzle-orm";
import type { NexusDb } from "@deskmony/db";
import { settings as settingsTable } from "@deskmony/db";
import type { ProviderPrefs, ProviderPrefsPatchInput } from "@deskmony/shared";

/**
 * settings-store.ts(M5 Round E 新增,這輪擴充為 provider 目錄的 per-provider
 * 偏好儲存,見 packages/shared/src/provider-catalog.ts 頂端註解「Paseo 的
 * provider 設計」)。極簡的 key/value 偏好儲存(見 packages/db/src/schema.ts 的
 * `settings` 表)。`get()`/`set()` 是通用的 key/value 存取,本檔案其餘 export
 * 才是「per-provider 偏好」「啟用哪些 Claude model(舊 API,向下相容)」這些
 * 具體業務邏輯的封裝。
 *
 * ---- 資料模型 ----
 * 整份 per-provider 偏好 map(`{ [providerId]: ProviderPrefs }`)以**單一 JSON
 * blob** 存在 `settings` 表的 `PROVIDER_PREFS_KEY` 這一列——不是每個 provider
 * 各自一列。理由:
 *   1. provider 數量少(個位數),不需要 relational 查詢能力。
 *   2. `settings.setProviderPrefs` 是「對單一 provider 的欄位做 patch」,若
 *      拆成多列,合併邏輯(讀現有 → patch → 寫回)需要額外處理「這個
 *      providerId 是否已有列」的 upsert;用單一 blob,读現有 map → patch
 *      該 key → 整包寫回,邏輯更直接、也更容易保證「整份 map 的一致性快照」
 *      不會被兩個並行寫入交錯出局部損毀(SQLite 單一 UPDATE 本身是原子的)。
 *
 * ---- 安全:env 的處理(review 會嚴查的部分,務必維持)----
 *   (a) **絕不寫進任何 log**:本檔案、apps/core/src/gateway/ws-gateway.ts 兩處
 *       都不對 provider 偏好的內容(尤其是 env)呼叫任何 console.log/error。
 *   (b) **gateway 回傳時遮罩**:`maskProviderPrefsMap()` 把每個 provider 的
 *       `env` 值全部覆寫成字面字串 `"***"`,只保留 key 名稱本身——`
 *       apps/core/src/gateway/ws-gateway.ts` 的 `settings.getProviderPrefs`/
 *       `setProviderPrefs` dispatch **只**回傳這個函式的輸出,永遠不會把
 *       `getProviderPrefsMap()`(未遮罩、內部用)的結果直接送出去。這防止的
 *       攻擊面是:任何連上這個 gateway 的 client(不只是設定這筆 env 的那個
 *       client)呼叫 `settings.getProviderPrefs` 就能讀走其他使用者/其他工作
 *       階段設定的 API key 明文。
 *   (c) **明文落地本機 SQLite**:遮罩只防護「透過 gateway 傳輸」這個管道,
 *       不防護「有本機檔案系統存取權限的人直接開 DB 檔案」——`env` 的值
 *       仍以明文 JSON 字串存在 `%DESKMONY_DATA_DIR%/*.sqlite` 檔案裡。這與
 *       Paseo 把 API key 寫進 `~/.paseo/config.json`(同樣是本機明文設定檔)
 *       是同一類取捨:兩者都假設「本機檔案系統本身的存取控制」已經是
 *       信任邊界,不在應用層額外加密——見 README「provider 偏好與 env 的
 *       安全取捨」章節的完整說明。
 *
 * ---- 舊 API 相容(向下相容遷移,見 migrateLegacyEnabledModelIds())----
 * M5 Round E 原本的 `enabledClaudeModelIds` 這個扁平 key(單一 JSON 字串陣列)
 * 現在改由 `getEnabledClaudeModelIds()`/`setEnabledClaudeModelIds()` 讀寫
 * per-provider 偏好裡 `claude-agent-sdk` 這一項的 `enabledModelIds` 欄位——
 * `apps/core/src/gateway/ws-gateway.ts` 的 `settings.getEnabledModels`/
 * `setEnabledModels` dispatch case **完全沒有改動**(依然呼叫這兩個同名
 * export),舊 client(或 e2e 步驟23 系列)不需要知道底層storage已經換了
 * 一層,行為 100% 相容。
 *
 * ---- 落地驗證(見 scripts/e2e-gateway.mjs 的決定性測試)----
 *   1. `setProviderPrefs()`/`setEnabledClaudeModelIds()` 後,同一個 core 連線
 *      內讀回一致。
 *   2. 重啟一個指向**同一個** DESKMONY_DATA_DIR 的全新 core 子程序後,仍讀回
 *      相同的值——證明真的落地到 SQLite 檔案,不是只存在記憶體。
 *   3. 預先寫入舊格式的 `enabledClaudeModelIds` → 啟動後呼叫
 *      `migrateLegacyEnabledModelIds()` → 正確轉成新結構的
 *      `claude-agent-sdk.enabledModelIds`,設定不遺失,且遷移冪等(重複呼叫
 *      不會覆蓋使用者之後已經修改過的新結構)。
 *   4. `settings.getProviderPrefs` 的回傳值不含任何明文 env 值。
 */
export class SettingsStore {
  constructor(private readonly db: NexusDb) {}

  async get(key: string): Promise<string | undefined> {
    const rows = await this.db.select().from(settingsTable).where(eq(settingsTable.key, key)).all();
    return rows[0]?.value;
  }

  /** upsert:key 不存在就新增,存在就覆寫(SQLite `ON CONFLICT ... DO UPDATE`)。 */
  async set(key: string, value: string): Promise<void> {
    await this.db
      .insert(settingsTable)
      .values({ key, value })
      .onConflictDoUpdate({ target: settingsTable.key, set: { value } })
      .run();
  }
}

/** `settings` 表內「舊版:啟用哪些 Claude model」偏好的 key(向下相容遷移的
 *  讀取來源,見 `migrateLegacyEnabledModelIds()`)。這輪之後不再是任何新資料
 *  的寫入目標——`setEnabledClaudeModelIds()` 改寫進 `PROVIDER_PREFS_KEY`。 */
const ENABLED_CLAUDE_MODELS_KEY = "enabledClaudeModelIds";

/** per-provider 偏好整份 map 的儲存 key(見上方 class 註解「資料模型」)。 */
const PROVIDER_PREFS_KEY = "providerPrefs";

/** 內建 provider 目錄裡,舊版「啟用哪些 Claude model」對應遷移到的 provider id。 */
const CLAUDE_AGENT_SDK_PROVIDER_ID = "claude-agent-sdk";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 讀取整份 per-provider 偏好 map;沒設定過、或解析失敗都回傳空物件(不讓一筆
 *  壞掉的 JSON 拖垮整個設定介面)。 */
export async function getProviderPrefsMap(store: SettingsStore): Promise<Record<string, ProviderPrefs>> {
  const raw = await store.get(PROVIDER_PREFS_KEY);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? (parsed as Record<string, ProviderPrefs>) : {};
  } catch {
    return {};
  }
}

async function setProviderPrefsMap(store: SettingsStore, map: Record<string, ProviderPrefs>): Promise<void> {
  await store.set(PROVIDER_PREFS_KEY, JSON.stringify(map));
}

/**
 * 對單一 provider 的偏好做**部分欄位合併**(不是整包取代,見上方 class 頂端
 * 註解、packages/shared/src/provider-catalog.ts 的 `ProviderPrefsSchema` 完整
 * 語意):
 *   - `enabled`/`order`/`label`:patch 有提供就直接覆寫。
 *   - `env`:patch 有提供時**淺層合併**進既有 env(只覆寫/新增 patch 裡出現
 *     的 key,其餘既有 key 保留)——這是刻意的設計:gateway 回傳給 client 的
 *     env 一律是遮罩過的值(見 `maskProviderPrefsMap()`),client 沒有辦法
 *     安全地把「讀到的偏好」整包重新送回來(那樣會把其他既有 key 的值覆寫成
 *     字面字串 "***"),淺層合併讓 client 只需要送出「這次想新增/修改的
 *     那幾個 key」,不會誤觸其他既有 key。
 *   - `models`/`additionalModels`/`enabledModelIds`:patch 有提供就整批取代
 *     (與 `resolveProviders()` 的「models 取代 / additionalModels 合併」是
 *     兩個不同層次:這裡是「儲存層」的欄位覆寫規則,`resolveProviders()` 才
 *     是「目錄預設 + 這裡存的 models/additionalModels → 最終模型清單」的
 *     合併計算,見 packages/shared/src/resolve-providers.ts)。
 *
 * 回傳 patch 之後的完整 map(未遮罩,只給 apps/core 內部呼叫端——目前是
 * ws-gateway 的 `settings.setProviderPrefs` dispatch,它會在回傳給 client
 * 之前呼叫 `maskProviderPrefsMap()` 遮罩,不會原樣回傳這個函式的結果)。
 */
export async function patchProviderPrefs(
  store: SettingsStore,
  providerId: string,
  patch: ProviderPrefsPatchInput,
): Promise<Record<string, ProviderPrefs>> {
  const map = await getProviderPrefsMap(store);
  const existing = map[providerId] ?? {};
  const merged: ProviderPrefs = { ...existing };
  if (patch.enabled !== undefined) merged.enabled = patch.enabled;
  if (patch.order !== undefined) merged.order = patch.order;
  if (patch.label !== undefined) merged.label = patch.label;
  if (patch.env !== undefined) merged.env = { ...(existing.env ?? {}), ...patch.env };
  if (patch.models !== undefined) merged.models = patch.models;
  if (patch.additionalModels !== undefined) merged.additionalModels = patch.additionalModels;
  if (patch.enabledModelIds !== undefined) merged.enabledModelIds = patch.enabledModelIds;
  map[providerId] = merged;
  await setProviderPrefsMap(store, map);
  return map;
}

/**
 * gateway 回傳給 client 前的遮罩層(見上方 class 頂端註解「安全:env 的處理」
 * (b))——`env` 的每個值一律覆寫成 `"***"`,只保留 key 名稱。`apps/core/src/
 * gateway/ws-gateway.ts` 的 `settings.getProviderPrefs`/`setProviderPrefs`
 * dispatch **必須**透過這個函式才能把偏好送出去,不可以把
 * `getProviderPrefsMap()`/`patchProviderPrefs()` 的回傳值直接回傳給 client。
 */
export function maskProviderPrefsMap(map: Record<string, ProviderPrefs>): Record<string, ProviderPrefs> {
  const masked: Record<string, ProviderPrefs> = {};
  for (const [providerId, prefs] of Object.entries(map)) {
    masked[providerId] = {
      ...prefs,
      env: prefs.env ? Object.fromEntries(Object.keys(prefs.env).map((key) => [key, "***"])) : undefined,
    };
  }
  return masked;
}

/**
 * `SessionManager.createSession()` 用(見 apps/core/src/session/
 * session-manager.ts):取得某個 provider 的**未遮罩**(真正的)env,併入
 * 子程序環境變數。這是 apps/core 內部使用,絕不能把這個函式的回傳值透過
 * gateway 送出去(對照上方 `maskProviderPrefsMap()`)。
 */
export async function getProviderEnv(store: SettingsStore, providerId: string): Promise<Record<string, string>> {
  const map = await getProviderPrefsMap(store);
  return map[providerId]?.env ?? {};
}

/**
 * 讀取目前啟用的 Claude model id 清單(舊 API,向下相容,見 class 頂端註解
 * 「舊 API 相容」)。**空陣列 = 全部啟用**——底層現在讀的是 per-provider 偏好
 * 裡 `claude-agent-sdk` 這一項的 `enabledModelIds`,語意與這輪之前完全相同。
 */
export async function getEnabledClaudeModelIds(store: SettingsStore): Promise<string[]> {
  const map = await getProviderPrefsMap(store);
  return map[CLAUDE_AGENT_SDK_PROVIDER_ID]?.enabledModelIds ?? [];
}

/** 寫入啟用的 Claude model id 清單(舊 API,向下相容)——底層改寫進
 *  per-provider 偏好的 `claude-agent-sdk.enabledModelIds`。 */
export async function setEnabledClaudeModelIds(store: SettingsStore, enabledModelIds: string[]): Promise<void> {
  await patchProviderPrefs(store, CLAUDE_AGENT_SDK_PROVIDER_ID, { enabledModelIds });
}

/**
 * 向下相容遷移(這輪新增,啟動時呼叫一次,見 apps/core/src/index.ts):把舊版
 * 扁平 key `enabledClaudeModelIds` 的內容(若存在)搬進新結構
 * `providerPrefs.claude-agent-sdk.enabledModelIds`。
 *
 * **冪等**:只要 `providerPrefs.claude-agent-sdk.enabledModelIds` 這個欄位
 * 已經**存在**(不論值是不是空陣列),就視為「已經遷移過,或使用者已經透過
 * 新版設定介面明確設定過」,直接跳過——不會用舊值覆蓋使用者之後在新介面做的
 * 修改。重複呼叫這個函式(每次 core 啟動都會呼叫)不會有任何副作用差異。
 *
 * **不遺失設定**:舊 key 本身不刪除(遷移只新增,不破壞既有資料),即使遷移
 * 邏輯本身有 bug,原始資料仍在,可以之後重新遷移或手動修復。
 *
 * **「從未設定過」維持既有預設語意**:舊 key 不存在(全新安裝,或使用者從未
 * 用過「啟用哪些 model」這個功能)時直接 return,`getEnabledClaudeModelIds()`
 * 沿用「查無偏好 → 空陣列 → 全部啟用」的既有 fallback,不會無中生有一筆
 * `enabledModelIds: []` 的紀錄。
 */
export async function migrateLegacyEnabledModelIds(store: SettingsStore): Promise<void> {
  const map = await getProviderPrefsMap(store);
  if (map[CLAUDE_AGENT_SDK_PROVIDER_ID]?.enabledModelIds !== undefined) return;

  const legacyRaw = await store.get(ENABLED_CLAUDE_MODELS_KEY);
  if (!legacyRaw) return;

  let legacyIds: string[] = [];
  try {
    const parsed: unknown = JSON.parse(legacyRaw);
    legacyIds = Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return; // 舊資料本身損毀,無法遷移;不寫入任何東西,不影響既有 fallback 行為。
  }

  await patchProviderPrefs(store, CLAUDE_AGENT_SDK_PROVIDER_ID, { enabledModelIds: legacyIds });
}
