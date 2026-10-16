import type { AgentDetectionEntry } from "./detect.js";
import type { AgentFamily, ProviderCatalogEntry, ProviderModel, ProviderPrefs, RegisteredAgentSoftware } from "./provider-catalog.js";
import type { SessionOptions } from "./session-options.js";

/**
 * resolve-providers.ts(這輪新增):`resolveProviders()` 是「內建 provider 目錄
 * + 本機偵測結果 + 使用者偏好」三者合併成「一份可以直接拿來建立 session 的
 * provider 清單」的**純函式**——不吃任何 I/O(不呼叫 gateway、不讀 DB),方便
 * `scripts/e2e-gateway.mjs` 直接 import 編譯產物、用 fixture 決定性地測試合併
 * 邏輯本身(比照 packages/shared/src/agent-target.ts 既有的
 * `deriveDefaultAgentTarget()` 測法,見 e2e 步驟22 系列)。
 *
 * 呼叫端(core 的 `AgentCatalog`、apps/desktop 的 SessionList/SettingsDialog)負責準備好三個
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
   *  `AgentCatalog.listAvailable()`/SessionList(只顯示 enabled 且已安裝的)與
   *  SettingsDialog(顯示全部,含已停用的,才能重新啟用)兩處對這個欄位不同的處理方式。 */
  enabled: boolean;
  /** 一定是 AdapterRegistry 實際註冊過的四種之一(由
   *  ProviderCatalogEntry.software 保證,見 provider-catalog.ts 的
   *  RegisteredAgentSoftwareSchema),絕不會是 "codex" 這種建不起來的值。 */
  software: RegisteredAgentSoftware;
  /** 見 `AgentFamilySchema`(provider-catalog.ts):有需要 Deskmony 在啟動時介入的預設權限策略的 agent 家族。 */
  family?: AgentFamily;
  /** claude-agent-sdk 不需要;其餘 provider 若偵測到路徑就帶入;沒有 detectKey 的項目
   *  (只有 e2e 注入的測試 provider,見 AgentCatalog)一律 undefined。 */
  command?: string;
  defaultArgs?: string[];
  /** 這個 provider 目前是否「已安裝/可用」——claude-agent-sdk 恆為 true;
   *  有 detectKey 的項目依偵測結果的 installed;無 detectKey 的項目恆為 true
   *  (e2e 注入的測試 provider 自帶 command,視為已安裝)。 */
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
  /** 2026-10-06:見 `ProviderCatalogEntry.supportsEffortSelection`(省略 = false)。 */
  supportsEffortSelection: boolean;
  /** 2026-10-06:見 `ProviderCatalogEntry.efforts`(與 model 無關的固定思考程度清單)。 */
  efforts?: string[];
  /** 2026-10-06:見 `ProviderCatalogEntry.optionsAfterStart`(省略 = false)。 */
  optionsAfterStart: boolean;
}

/**
 * 2026-10-06:建立 session 之前就知道的「這個 provider(選了這個 model 時)可選的思考程度」。
 *   - provider 不支援選思考程度 → `undefined`。
 *   - 選了 model、而且那個 model 有自己的清單(OpenCode 的 variants)→ 那份清單(可能是空陣列 = 這個 model 沒得選)。
 *   - 否則 → provider 的固定清單(Claude 的 low…max);沒有固定清單(例如 OpenCode 沒選 model、ACP agent)→ `undefined`
 *     = 建立前不知道。
 * core 的 `AgentCatalog.buildLaunch()` 用它驗證建立參數,桌面端的建立選單用它決定要不要顯示思考程度。
 */
export function providerEffortChoices(
  provider: Pick<ResolvedProvider, "supportsEffortSelection" | "efforts" | "models">,
  modelId: string | undefined,
): string[] | undefined {
  if (!provider.supportsEffortSelection) return undefined;
  if (modelId) {
    const model = provider.models.find((m) => m.id === modelId);
    if (model?.efforts) return model.efforts;
  }
  return provider.efforts;
}

/**
 * 2026-10-16:建立選單(AgentPicker)的思考程度控制項該呈現什麼——在 `providerEffortChoices()` 之上多分辨
 * 「為什麼沒有選項」,讓 UI 不必在「不支援」與「現在還不能選」之間整個消失(使用者回報「opencode 沒辦法選思考程度」:
 * 預設 model `opencode/big-pickle` 本身沒有 variants,選單上完全看不到思考程度,不知道要換 model 才有)。
 *   - `none`:provider 不支援選思考程度,或建立前根本不知道(ACP agent 要等對話開起來才回報,見 `optionsAfterStart`)→ 不顯示。
 *   - `choices`:有可選項目。
 *   - `pickModelFirst`:provider 的思考程度隨 model 而定(model 清單帶 `efforts`,例如 OpenCode 偵測到的 variants)、
 *     也有 model 下拉可選,但使用者還沒選 model → 顯示 disabled 控制項,提示先選 model。
 *   - `modelHasNone`:選了 model,但那個 model 沒有可選的思考程度(`efforts: []`)→ 顯示 disabled 控制項,提示這個 model 不支援。
 */
export type EffortSelectionState =
  | { kind: "none" }
  | { kind: "choices"; choices: string[] }
  | { kind: "pickModelFirst" }
  | { kind: "modelHasNone" };

export function providerEffortSelectionState(
  provider: Pick<ResolvedProvider, "supportsEffortSelection" | "supportsModelSelection" | "efforts" | "models">,
  modelId: string | undefined,
): EffortSelectionState {
  const choices = providerEffortChoices(provider, modelId);
  if (choices) return choices.length > 0 ? { kind: "choices", choices } : { kind: "modelHasNone" };
  // `providerEffortChoices()` 回 undefined = provider 不支援,或建立前不知道。只有「清單確實隨 model 變、而且使用者看得到
  // model 下拉卻還沒選」才算 pickModelFirst;codex/gemini 這類沒有 model 清單的 ACP agent 維持 none
  // (它們的說明走 `optionsAfterStart` 那行字,不能叫使用者去選一個不存在的下拉)。
  if (
    provider.supportsEffortSelection &&
    !modelId &&
    provider.supportsModelSelection &&
    provider.models.some((m) => m.efforts !== undefined)
  ) {
    return { kind: "pickModelFirst" };
  }
  return { kind: "none" };
}

/**
 * 2026-10-16:對話標題列的思考程度控制項——「provider 本來就能選思考程度,但 agent 回報這個 session 目前(目前的
 * model)沒有可選項目」時,UI 要顯示 disabled 的控制項說明原因,不能整個消失。
 *
 * 判斷依據是 agent **真的回報過選項**(`session.options` 有值,見 session-options.ts):
 *   - 沒回報過(session 剛啟動 ACP 還沒送選項、PTY 這類永遠不回報、session 已結束)→ 不能斷言「沒有」,不顯示——
 *     否則 ACP session 一開起來會閃一下「不支援」再變成真的下拉,PTY(`claude-cli` 也標了 supportsEffortSelection,
 *     但中途不能換)會顯示一個永遠 disabled 的假控制項。
 *   - 回報了、但沒有 `effort`(或選項是空的)→ 目前這個 model 沒有思考程度。
 */
export function effortUnavailableInSession(
  provider: Pick<ResolvedProvider, "supportsEffortSelection"> | undefined,
  options: SessionOptions | undefined,
): boolean {
  if (!provider?.supportsEffortSelection || !options) return false;
  return (options.effort?.choices.length ?? 0) === 0;
}

/** 以 model id 去重合併,`extra`(使用者的 additionalModels)優先——出現在
 *  `base` 裡的 id 會被 `extra` 同 id 項目就地覆寫(保留原本在陣列中的位置,
 *  不是移到最後),`extra` 裡不存在於 `base` 的新 id 附加在陣列尾端。 */
export function mergeModelsById(base: ProviderModel[], extra: ProviderModel[] | undefined): ProviderModel[] {
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
    // 外部 CLI 依偵測結果;沒有 detectKey 的項目(目前只有 e2e 注入的測試
    // provider)installed 恆為 true(見上方 ResolvedProvider.installed 欄位註解)。
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
      family: entry.family,
      command,
      // 這輪(Codex ACP 橋接):偵測階段的 `args`(見 detect.ts 的
      // AgentDetectionEntrySchema.args 註解)優先於目錄靜態的 defaultArgs——
      // codex-acp 的進入點路徑要看橋接套件實際裝到哪裡才知道,目錄寫不出來。
      // 其餘 provider 的偵測結果沒有 `args` 欄位(`detected?.args` 為
      // undefined),`??` 落回 entry.defaultArgs,行為 100% 不變。
      defaultArgs: detected?.args ?? entry.defaultArgs,
      installed,
      detectedVersion: detected?.version,
      detectKey: entry.detectKey,
      models: finalModels,
      defaultModelId: defaultModel?.id,
      supportsModelSelection: entry.supportsModelSelection,
      supportsEffortSelection: entry.supportsEffortSelection ?? false,
      efforts: entry.efforts,
      optionsAfterStart: entry.optionsAfterStart ?? false,
    };
  });

  // Array.prototype.sort 自 ES2019 起保證 stable——排序值相同的項目維持原本
  // (builtins 陣列宣告的)相對順序,不需要額外的 tie-break 邏輯。
  return resolved.sort((a, b) => a.order - b.order);
}

/** 只顯示「使用者啟用」的 provider(停用的不出現在建立 session 的下拉選單裡,
 *  但仍會出現在 resolveProviders() 的完整回傳值中,供 SettingsDialog 顯示/重新啟用)。 */
export function selectSelectableProviders(resolved: ResolvedProvider[]): ResolvedProvider[] {
  return resolved.filter((p) => p.enabled);
}
