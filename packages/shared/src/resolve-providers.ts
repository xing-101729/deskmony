import type { AgentDetectionEntry } from "./detect.js";
import type { ProviderCatalogEntry, ProviderModel, ProviderPrefs, RegisteredAgentSoftware } from "./provider-catalog.js";

/**
 * resolve-providers.ts(這輪新增):`resolveProviders()` 是「內建 provider 目錄
 * + 本機偵測結果 + 使用者偏好」三者合併成「一份可以直接拿來建立 profile 的
 * provider 清單」的**純函式**——不吃任何 I/O(不呼叫 gateway、不讀 DB),方便
 * `scripts/e2e-gateway.mjs` 直接 import 編譯產物、用 fixture 決定性地測試合併
 * 邏輯本身(比照 packages/shared/src/agent-target.ts 既有的
 * `deriveDefaultAgentTarget()` 測法,見 e2e 步驟22 系列)。
 *
 * 呼叫端(apps/desktop 的 ProfileCreateDialog/SettingsDialog)負責準備好三個
 * 輸入:`BUILTIN_PROVIDERS`(靜態常數)、`env.detectAgents` 的偵測結果、
 * `settings.getProviderPrefs` 的偏好(注意:gateway 回傳的是**遮罩過**的
 * `env`,見 provider-catalog.ts 的 `MaskedProviderPrefsSchema`——這個函式本身
 * 對 `env` 完全不關心值是否被遮罩,只是原樣透傳在回傳值上,UI 顯示層面必須
 * 自行避免把遮罩值誤當真正的 env 使用)。
 */

export interface ResolvedProvider {
  id: string;
  label: string;
  description?: string;
  order: number;
  /** 使用者是否啟用這個 provider(預設 true)。停用不代表從清單移除——見
   *  ProfileCreateDialog(只顯示 enabled 的)與 SettingsDialog(顯示全部,
   *  含已停用的,才能重新啟用)兩處對這個欄位不同的處理方式。 */
  enabled: boolean;
  /** 一定是 AdapterRegistry 實際註冊過的四種之一(由
   *  ProviderCatalogEntry.software 保證,見 provider-catalog.ts 的
   *  RegisteredAgentSoftwareSchema),絕不會是 "codex" 這種建不起來的值。 */
  software: RegisteredAgentSoftware;
  /** claude-agent-sdk 不需要;其餘 provider 若偵測到路徑就帶入,
   *  custom-pty(無 detectKey)一律 undefined,需要使用者手動輸入。 */
  command?: string;
  defaultArgs?: string[];
  /** 這個 provider 目前是否「已安裝/可用」——claude-agent-sdk 恆為 true;
   *  有 detectKey 的項目依偵測結果的 installed;無 detectKey(自訂項)恆為
   *  true(代表「一律可選,但需要手動輸入 command」,不是「已偵測到可用」)。 */
  installed: boolean;
  detectedVersion?: string;
  detectKey?: string;
  /** 已套用 models 取代 + additionalModels 合併 + enabledModelIds 過濾後的
   *  最終模型清單。 */
  models: ProviderModel[];
  /** `models` 內第一個 `isDefault` 的項目;沒有標記就取第一個;模型清單為空
   *  則是 undefined。 */
  defaultModelId?: string;
  supportsModelSelection: boolean;
}

/** 以 model id 去重合併,`extra`(使用者的 additionalModels)優先——出現在
 *  `base` 裡的 id 會被 `extra` 同 id 項目就地覆寫(保留原本在陣列中的位置,
 *  不是移到最後),`extra` 裡不存在於 `base` 的新 id 附加在陣列尾端。 */
function mergeModelsById(base: ProviderModel[], extra: ProviderModel[] | undefined): ProviderModel[] {
  if (!extra || extra.length === 0) return base;
  const map = new Map(base.map((m) => [m.id, m] as const));
  for (const model of extra) {
    map.set(model.id, model);
  }
  return [...map.values()];
}

/** 空陣列或省略 = 全部啟用(沿用既有 settings.getEnabledModels 的約定,見
 *  apps/core/src/settings/settings-store.ts)。 */
function filterByEnabledIds(models: ProviderModel[], enabledIds: string[] | undefined): ProviderModel[] {
  if (!enabledIds || enabledIds.length === 0) return models;
  const enabled = new Set(enabledIds);
  return models.filter((m) => enabled.has(m.id));
}

export function resolveProviders(
  builtins: ProviderCatalogEntry[],
  detection: AgentDetectionEntry[],
  prefs: Record<string, ProviderPrefs>,
): ResolvedProvider[] {
  const detectionByKey = new Map(detection.map((d) => [d.key, d] as const));

  const resolved: ResolvedProvider[] = builtins.map((entry) => {
    const pref = prefs[entry.id];
    const detected = entry.detectKey ? detectionByKey.get(entry.detectKey) : undefined;

    // claude-agent-sdk 是內嵌的,永遠已安裝、不需要 command;有 detectKey 的
    // 外部 CLI 依偵測結果;沒有 detectKey 的自訂項(custom-pty)一律視為
    // 「可選,但需要使用者手動輸入 command」,installed 恆為 true(見上方
    // ResolvedProvider.installed 欄位註解)。
    const installed = entry.software === "claude-agent-sdk" ? true : entry.detectKey ? Boolean(detected?.installed) : true;
    const command = entry.software === "claude-agent-sdk" ? undefined : entry.detectKey ? detected?.path : undefined;

    // 這輪新增:偵測階段(apps/core/src/detect/agent-detector.ts)若有回報
    // 結構化的 model 清單(目前只有 opencode 透過 `opencode models` 拿得到,
    // 見該檔案這輪新增的 modelsCommandArgs 機制),併入目錄預設 `entry.models`
    // 當作「基礎」模型清單,用同一個 `mergeModelsById()`(以 id 去重,後面的
    // 來源覆寫同 id 項目)——維持與 additionalModels 合併邏輯完全一致的語意,
    // 不另外發明一套合併規則。刻意只在使用者**沒有**設定 `pref.models` 時
    // 才套用偵測結果:`pref.models` 是「整批取代」語意(見 ProviderPrefsSchema
    // 註解),使用者明確設定過自己的清單時,偵測結果不應該混進去污染這份
    // 使用者已經自訂好的清單——`additionalModels`/`enabledModelIds` 才是
    // 使用者「在目錄/偵測結果之上做增補/篩選」的既有管道。
    const baseModels = pref?.models !== undefined ? pref.models : mergeModelsById(entry.models, detected?.models);
    const mergedModels = mergeModelsById(baseModels, pref?.additionalModels);
    const finalModels = filterByEnabledIds(mergedModels, pref?.enabledModelIds);
    const defaultModel = finalModels.find((m) => m.isDefault) ?? finalModels[0];

    return {
      id: entry.id,
      label: pref?.label ?? entry.label,
      description: entry.description,
      order: pref?.order ?? entry.order,
      enabled: pref?.enabled ?? true,
      software: entry.software,
      command,
      defaultArgs: entry.defaultArgs,
      installed,
      detectedVersion: detected?.version,
      detectKey: entry.detectKey,
      models: finalModels,
      defaultModelId: defaultModel?.id,
      supportsModelSelection: entry.supportsModelSelection,
    };
  });

  // Array.prototype.sort 自 ES2019 起保證 stable——排序值相同的項目維持原本
  // (builtins 陣列宣告的)相對順序,不需要額外的 tie-break 邏輯。
  return resolved.sort((a, b) => a.order - b.order);
}

/** ProfileCreateDialog 用:只顯示「使用者啟用」的 provider(停用的不出現在
 *  建立 profile 的下拉選單裡,但仍會出現在 resolveProviders() 的完整回傳值
 *  中,供 SettingsDialog 顯示/重新啟用)。 */
export function selectSelectableProviders(resolved: ResolvedProvider[]): ResolvedProvider[] {
  return resolved.filter((p) => p.enabled);
}
