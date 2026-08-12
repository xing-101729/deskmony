import type { AgentOverride, ResolvedProvider } from "@deskmony/shared";

/**
 * 建立/開子 agent 時,把「使用者在 AgentOverrideFields 選的東西」轉成要送給
 * `session.create`/`session.spawnChild` 的 `AgentOverride` payload(見
 * packages/shared/src/session.ts 的 `AgentOverrideSchema` 註解)。純函式,
 * 不吃任何 store/context——兩個建立流程(SessionList 側欄的「進階」區塊、
 * SpawnChildDialog)共用同一份邏輯,不各自重新實作一次。
 *
 * - `overrideProvider` 有值:software 也要換,整批帶入該 provider 的
 *   command/args/providerId(來自 `selectResolvedProviders()`,已經是「已偵測
 *   到、免手動輸入」的已知選項——呼叫端負責只把這類 provider 放進選單)。
 *   claude-cli(pty 直通)比照 ProfileCreateDialog 既有的 resolveTarget()
 *   邏輯:pty 建立後無法事後切換 model,只能在建立當下把 `--model <alias>`
 *   烤進固定的啟動參數。
 * - `overrideProvider` 為 undefined 但 `model` 跟 base profile 原本的
 *   model 不同:只換 model,software 沿用 profile(省略 override.software,
 *   見 core 端 `applyAgentOverride()` 的分流語意)。
 * - 兩者都沒變:回傳 undefined,等同完全不帶 agentOverride(既有行為不變)。
 */
export function buildAgentOverride(
  overrideProvider: ResolvedProvider | undefined,
  model: string,
  baseModel: string | undefined,
): AgentOverride | undefined {
  if (overrideProvider) {
    const modelArgs = overrideProvider.id === "claude-cli" && model ? ["--model", model] : [];
    const combinedArgs = [...(overrideProvider.defaultArgs ?? []), ...modelArgs];
    return {
      software: overrideProvider.software,
      providerId: overrideProvider.id,
      command: overrideProvider.command,
      args: combinedArgs.length > 0 ? combinedArgs : undefined,
      ...(model ? { model } : {}),
    };
  }
  if (model && model !== baseModel) {
    return { model };
  }
  return undefined;
}
