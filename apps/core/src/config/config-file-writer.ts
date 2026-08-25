import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { CORE_CONFIG_VERSION, DeskmonyError, type ConfigSetFilePatchInput, type PolicyRule } from "@deskmony/shared";

/**
 * config-file-writer.ts(M6 Round A 新增):`config.setFile` gateway 方法的
 * 實際落地邏輯——只給已通過 `ConfigSetFilePatchSchema`(安全子集,見
 * packages/shared/src/core-config.ts)驗證過的 patch 呼叫,不做任何額外的
 * 欄位白名單檢查(那一層安全邊界在 zod schema,見 `apps/core/src/gateway/
 * ws-gateway.ts` 的 `config.setFile` dispatch case 註解)。
 *
 * 這輪刻意**不做熱重載**——寫入設定檔後,目前這個 core process 仍沿用啟動時
 * 解析好的 `EffectiveCoreConfig`,呼叫端(`WsGateway`)回報
 * `requiresRestart: true` 提醒使用者需要重啟 core 才會生效(見 README「為何
 * config.setFile 不做熱重載」)。
 */

/** 設定檔不存在時,新建立的檔案裡 `$schema` 指到哪裡——`docs/deskmony.config.v1.json`
 *  是這個 repo 用 zod 產生的 JSON Schema(見 `pnpm generate:config-schema`)。
 *  設定檔實際存放在使用者家目錄(`<DESKMONY_HOME>/config.json`),與 repo 不在
 *  同一個目錄下,這個相對路徑不會被編輯器自動解析——README「JSON schema」
 *  章節說明了如何把產生的 schema 檔複製到設定檔旁邊,或在編輯器裡手動設定
 *  schema 對應規則,取得自動補全。 */
const SCHEMA_REFERENCE = "./deskmony.config.v1.json";

/** 把巢狀 patch 物件攤平成 dot-path 字串陣列(例如
 *  `{ log: { level: "warn" } }` → `["log.level"]`),`config.setFile` 的回應
 *  用這份清單告訴呼叫端「這次實際寫入了哪些欄位」。 */
function flattenPatchPaths(patch: unknown, prefix = ""): string[] {
  const paths: string[] = [];
  if (typeof patch !== "object" || patch === null) return paths;
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    const fullPath = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      paths.push(...flattenPatchPaths(value, fullPath));
    } else {
      paths.push(fullPath);
    }
  }
  return paths;
}

/** 遞迴淺層合併(patch 裡出現的巢狀物件遞迴合併,其餘既有 key 保留)——比照
 *  apps/core/src/settings/settings-store.ts 的 `patchProviderPrefs()` 對
 *  `env` 欄位的既有合併語意,這裡把同一個原則套用到整份設定檔 JSON。 */
function deepMerge(target: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    const existing = result[key];
    if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      typeof existing === "object" &&
      existing !== null &&
      !Array.isArray(existing)
    ) {
      result[key] = deepMerge(existing as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

export interface ApplyConfigFilePatchResult {
  changedFields: string[];
}

/**
 * 讀取現有設定檔(不存在則視為空物件)→ 把 patch 深度合併進去 → 補上
 * `version`/`$schema`(不存在時才補)→ 寫回。**只覆寫 patch 裡出現的欄位**,
 * 使用者手動加在檔案裡的其他既有欄位(含未知欄位)原封不動保留。
 */
export function applyConfigFilePatch(configPath: string, patch: ConfigSetFilePatchInput): ApplyConfigFilePatchResult {
  let existing: Record<string, unknown> = {};
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    existing = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      // 檔案存在但目前解析不出來——理論上 core 啟動時的 readConfigFile() 早就
      // 因為 ConfigLoadError 拒絕啟動了,執行期不該走到這裡;保守起見仍明確
      // 報錯、拒絕寫入,避免用一份可能不完整的資料覆蓋使用者原本的檔案內容。
      throw new DeskmonyError(
        "config.patchWriteFailed",
        { configPath, detail: err instanceof Error ? err.message : String(err) },
        `設定檔(${configPath})目前無法解析,拒絕寫入以避免覆蓋既有內容: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (existing.version === undefined) existing.version = CORE_CONFIG_VERSION;
  if (existing.$schema === undefined) existing.$schema = SCHEMA_REFERENCE;

  const merged = deepMerge(existing, patch as unknown as Record<string, unknown>);

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");

  return { changedFields: flattenPatchPaths(patch) };
}

/**
 * S7(auto-mode-and-yolo)L4 §4:UI「永遠允許…」寫入 config 的實際落地邏輯
 * ——**刻意獨立於 `applyConfigFilePatch()`**,不透過 `ConfigSetFilePatchSchema`
 * 那條「安全子集」通道(那條路徑刻意不含 `policy`,見 core-config.ts 的
 * `ConfigSetFilePatchSchema` 頂端說明,F4:policy 是安全罩本身,不可經由
 * client 任意 patch 覆寫)。這個函式只給
 * `apps/core/src/session/session-manager.ts` 的 `resolvePermission()` 呼叫
 * ——那裡處理的是「使用者對一筆*已經浮現*的權限請求,選擇把這次的窄範圍決定
 * 記住」,不是「client 任意覆寫 policy 設定」,是完全不同的信任模型(且已經
 * 過 escalate-strong 檢查、以及 §5.1 的 local-only 檢查把關,見
 * ws-gateway.ts)。
 *
 * 寫入規則與 `PolicyEngine.addRule()` 對稱(deny unshift 到最前面,allow push
 * 到尾端)——core 重啟後重新讀 config.json 建構的 `PolicyEngine.rules` 順序,
 * 必須與這次 session 內 in-memory 累加的順序一致,否則「重啟後行為變了」。
 */
export function appendPolicyRule(configPath: string, rule: PolicyRule): void {
  let existing: Record<string, unknown> = {};
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    existing = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new DeskmonyError(
        "config.policyRuleWriteFailed",
        { configPath, detail: err instanceof Error ? err.message : String(err) },
        `設定檔(${configPath})目前無法解析,拒絕寫入 rememberRule 以避免覆蓋既有內容: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (existing.version === undefined) existing.version = CORE_CONFIG_VERSION;
  if (existing.$schema === undefined) existing.$schema = SCHEMA_REFERENCE;

  const existingPolicy =
    typeof existing.policy === "object" && existing.policy !== null && !Array.isArray(existing.policy)
      ? (existing.policy as Record<string, unknown>)
      : {};
  const existingRules = Array.isArray(existingPolicy.rules) ? [...(existingPolicy.rules as unknown[])] : [];

  if (rule.effect === "deny") {
    existingRules.unshift(rule);
  } else {
    existingRules.push(rule);
  }

  existing.policy = { ...existingPolicy, rules: existingRules };

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(existing, null, 2)}\n`, "utf8");
}

/**
 * 2026-08-25 新增(見 docs/DECISIONS.md §G):`PolicyRule.id` 這個欄位新增前
 * 就已經寫進 `config.json` 的舊規則沒有 id——啟動時呼叫一次,補上
 * `randomUUID()` 並整批寫回,讓 `policy.removeRule` 之後可以用穩定的 id 定位
 * 任何一條規則(而不是容易因為其他規則新增/刪除而位移的陣列 index)。
 *
 * **冪等**:傳入的 `rules` 若每一條都已經有 `id`(全新安裝、或已經跑過一次
 * 這個函式),直接原樣回傳,完全不碰檔案——比照
 * `apps/core/src/settings/settings-store.ts` 的 `migrateLegacyEnabledModelIds()`
 * 同一種「已經是目標狀態就不做任何 I/O」的早退寫法(那個是 DB row,這個是
 * config.json 檔案,機制不同但精神一致)。
 *
 * 呼叫端(`apps/core/src/index.ts`)必須把這個函式的回傳值(不是原始
 * `config.policy.rules`)拿去建構 `PolicyEngine`,否則記憶體裡的規則會跟剛
 * 寫回檔案的版本不一致(記憶體那份還是缺 id 的舊版)。
 */
export function backfillPolicyRuleIds(configPath: string, rules: PolicyRule[]): PolicyRule[] {
  if (rules.every((rule) => rule.id !== undefined)) return rules;

  const backfilled = rules.map((rule) => (rule.id !== undefined ? rule : { ...rule, id: randomUUID() }));

  let existing: Record<string, unknown> = {};
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    existing = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      // 理論上不該發生(core 啟動時的 readConfigFile() 早就會先因為解析失敗
      // 拒絕啟動)——保守起見仍不覆寫,直接把記憶體版本的 backfill 結果回傳,
      // 讓這次啟動至少行為正確,下次啟動時再重試落地。
      console.error(`[config] id backfill 無法讀取設定檔以寫回(不影響這次啟動的 in-memory 規則): ${String(err)}`);
      return backfilled;
    }
  }

  if (existing.version === undefined) existing.version = CORE_CONFIG_VERSION;
  if (existing.$schema === undefined) existing.$schema = SCHEMA_REFERENCE;
  const existingPolicy =
    typeof existing.policy === "object" && existing.policy !== null && !Array.isArray(existing.policy)
      ? (existing.policy as Record<string, unknown>)
      : {};
  existing.policy = { ...existingPolicy, rules: backfilled };

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(existing, null, 2)}\n`, "utf8");

  return backfilled;
}

/**
 * 2026-08-25 新增:依 `id` 刪除一條政策規則——**整批讀回寫**(與只 append 一條
 * 的 `appendPolicyRule()`不同,刪除必須先找到、拿掉那一條,不能只靠
 * unshift/push)。id 不存在時視為 no-op(不拋例外,呼叫端
 * `SessionManager.removePolicyRule()` 依「陣列長度是否變短」判斷有沒有真的
 * 刪到,見該方法)。
 */
export function removePolicyRule(configPath: string, id: string): PolicyRule[] {
  let existing: Record<string, unknown> = {};
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    existing = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new DeskmonyError(
        "config.policyRuleWriteFailed",
        { configPath, detail: err instanceof Error ? err.message : String(err) },
        `設定檔(${configPath})目前無法解析,拒絕寫入刪除規則的結果以避免覆蓋既有內容: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (existing.version === undefined) existing.version = CORE_CONFIG_VERSION;
  if (existing.$schema === undefined) existing.$schema = SCHEMA_REFERENCE;

  const existingPolicy =
    typeof existing.policy === "object" && existing.policy !== null && !Array.isArray(existing.policy)
      ? (existing.policy as Record<string, unknown>)
      : {};
  const existingRules = Array.isArray(existingPolicy.rules) ? (existingPolicy.rules as PolicyRule[]) : [];
  const remainingRules = existingRules.filter((rule) => rule.id !== id);

  existing.policy = { ...existingPolicy, rules: remainingRules };

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(existing, null, 2)}\n`, "utf8");

  return remainingRules;
}
