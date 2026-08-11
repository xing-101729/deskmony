import fs from "node:fs";
import path from "node:path";
import { CORE_CONFIG_VERSION, type ConfigSetFilePatchInput, type PolicyRule } from "@deskmony/shared";

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
      throw new Error(
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
      throw new Error(
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
