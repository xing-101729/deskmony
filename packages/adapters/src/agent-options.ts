import type * as acp from "@agentclientprotocol/sdk";
import { DeskmonyError, type SessionOption, type SessionOptionChoice, type SessionOptions } from "@deskmony/shared";

/**
 * agent-options.ts(2026-10-06:各 agent 選 model 與思考程度)。
 *
 * 「這個 session 能選哪些 model / 思考程度」由 agent 本身回報(見 packages/shared/src/session-options.ts)。
 * 這裡放各 adapter 共用的兩件事:
 *   1. 不支援 / 值不合法時的**明確錯誤**(不可靜默忽略成功,見 types.ts 的 setModel/setEffort 介面註解)。
 *   2. ACP `configOptions` ↔ Deskmony `SessionOptions` 的轉換。
 */

export type AgentOptionKind = "model" | "effort";

/** agent 沒有提供這一項選擇(ACP 沒宣告、OpenCode 目前 model 沒有 variants……)。 */
export function optionNotOfferedError(kind: AgentOptionKind, agent: string): DeskmonyError {
  return kind === "model"
    ? new DeskmonyError("agent.modelNotOffered", { agent }, `${agent} 沒有提供 model 選擇`)
    : new DeskmonyError("agent.effortNotOffered", { agent }, `${agent} 目前不能選思考程度`);
}

/** 值不在 agent 回報的清單裡。`allowed` 最多列 20 個,避免錯誤訊息被 70 個 model 塞爆。 */
export function invalidOptionError(kind: AgentOptionKind, agent: string, value: string, allowed: string[]): DeskmonyError {
  const shown = allowed.length > 20 ? [...allowed.slice(0, 20), `…(共 ${allowed.length} 個)`] : allowed;
  const list = shown.join(", ");
  return kind === "model"
    ? new DeskmonyError("agent.invalidModel", { agent, value, allowed: list }, `「${value}」不是 ${agent} 可選的 model(可選:${list})`)
    : new DeskmonyError("agent.invalidEffort", { agent, value, allowed: list }, `「${value}」不是 ${agent} 可選的思考程度(可選:${list})`);
}

// ---- ACP configOptions ----------------------------------------------------------------------

/**
 * ACP 的 option 以 `category` 區分用途(`model` / `thought_level`),**id 各家不同**——實測 opencode 1.18.7 是
 * `model`/`effort`,codex-acp 1.4.0 是 `model`/`reasoning_effort`。ACP 規格說 category 只是 UX 提示、client
 * 不得依賴它的存在,所以沒有 category 的 select 再以常見 id 認一次。
 */
const ACP_CATEGORY: Record<AgentOptionKind, string> = { model: "model", effort: "thought_level" };
const ACP_FALLBACK_IDS: Record<AgentOptionKind, readonly string[]> = {
  model: ["model"],
  effort: ["thought_level", "effort", "reasoning_effort"],
};

type AcpSelectOption = Extract<acp.SessionConfigOption, { type: "select" }>;

export function findAcpConfigOption(options: readonly acp.SessionConfigOption[], kind: AgentOptionKind): AcpSelectOption | undefined {
  const selects = options.filter((o): o is AcpSelectOption => o.type === "select");
  return (
    selects.find((o) => o.category === ACP_CATEGORY[kind]) ??
    selects.find((o) => !o.category && ACP_FALLBACK_IDS[kind].includes(o.id))
  );
}

/** 把 ACP 的選項(可能分組)攤平成一份清單;分組的項目標籤前面加組名。 */
export function acpOptionChoices(option: AcpSelectOption): SessionOptionChoice[] {
  const choices: SessionOptionChoice[] = [];
  for (const entry of option.options) {
    if ("group" in entry) {
      for (const o of entry.options) choices.push(toChoice(o, entry.name));
    } else {
      choices.push(toChoice(entry));
    }
  }
  return choices;
}

function toChoice(o: acp.SessionConfigSelectOption, groupName?: string): SessionOptionChoice {
  const name = o.name || o.value;
  return {
    value: o.value,
    label: groupName ? `${groupName} / ${name}` : name,
    ...(o.description ? { description: o.description } : {}),
  };
}

function acpSessionOption(options: readonly acp.SessionConfigOption[], kind: AgentOptionKind): SessionOption | undefined {
  const option = findAcpConfigOption(options, kind);
  if (!option) return undefined;
  const choices = acpOptionChoices(option);
  if (choices.length === 0) return undefined;
  return { current: option.currentValue || undefined, choices };
}

/** ACP `configOptions` → `SessionOptions`(只取 model 與思考程度;`mode` 等其他選項不在這個功能範圍)。 */
export function acpSessionOptions(options: readonly acp.SessionConfigOption[]): SessionOptions {
  const model = acpSessionOption(options, "model");
  const effort = acpSessionOption(options, "effort");
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
}
