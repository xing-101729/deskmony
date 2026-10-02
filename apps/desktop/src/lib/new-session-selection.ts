import type { EffortLevel, ResolvedProvider } from "@deskmony/shared";

/**
 * 2026-10-02(P2:移除 profile)新增:「新對話」用的 agent/model/effort/資料夾選擇——取代原本的
 * 「選一個 profile」。SessionList 頂部的下拉、`⌘N`、命令面板的「新對話」三個入口共用同一份(由 App.tsx 持有),
 * 上次選的組合存 `localStorage`,下次開 app 還原(⌘N 用上次選的組合)。
 *
 * `localStorage` 的讀寫一律包 try/catch(隱私模式/被封鎖時會直接丟例外),讀不到就用預設值,
 * 寫不進去就算了——這只是便利功能,不影響任何行為。
 */
export interface NewSessionSelection {
  providerId: string;
  /** 空字串 = 不指定(由 agent/CLI 自己決定,或 provider 標記的預設 model)。 */
  model: string;
  /** 只有 claude-agent-sdk 有意義;空字串 = 不指定。 */
  effort: EffortLevel | "";
  /** 空字串 = 用 core 的預設工作資料夾(`workspace.defaultWorkingDir`)。 */
  workingDir: string;
}

export const DEFAULT_PROVIDER_ID = "claude-agent-sdk";

export const DEFAULT_NEW_SESSION_SELECTION: NewSessionSelection = {
  providerId: DEFAULT_PROVIDER_ID,
  model: "",
  effort: "",
  workingDir: "",
};

const STORAGE_KEY = "deskmony:newSessionSelection";
const EFFORT_VALUES: readonly string[] = ["low", "medium", "high", "xhigh", "max"];

export function loadNewSessionSelection(): NewSessionSelection {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
    if (!raw) return DEFAULT_NEW_SESSION_SELECTION;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return DEFAULT_NEW_SESSION_SELECTION;
    const o = parsed as Record<string, unknown>;
    return {
      providerId: typeof o.providerId === "string" && o.providerId ? o.providerId : DEFAULT_PROVIDER_ID,
      model: typeof o.model === "string" ? o.model : "",
      effort: typeof o.effort === "string" && EFFORT_VALUES.includes(o.effort) ? (o.effort as EffortLevel) : "",
      workingDir: typeof o.workingDir === "string" ? o.workingDir : "",
    };
  } catch {
    return DEFAULT_NEW_SESSION_SELECTION;
  }
}

export function saveNewSessionSelection(selection: NewSessionSelection): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(STORAGE_KEY, JSON.stringify(selection));
  } catch {
    // 寫不進去(隱私模式/配額)就算了,只是少了「記住上次選擇」這個便利。
  }
}

/**
 * 把一份(可能過時的)選擇對齊到「現在真的可用」的 provider 清單:
 *   - provider 已不在可用清單(被停用、CLI 被移除、偵測還沒回來)→ 退回清單第一個(沒有就保持原樣,
 *     呼叫端據此顯示「沒有可用 agent」);
 *   - model 不在該 provider 的清單、或該 provider 不支援選 model → 清空(用 agent 預設);
 *   - 不是 claude-agent-sdk → effort 清空(只有它驗證支援思考程度)。
 */
export function reconcileSelection(selection: NewSessionSelection, available: ResolvedProvider[]): NewSessionSelection {
  const provider = available.find((p) => p.id === selection.providerId) ?? available[0];
  if (!provider) return selection;
  const modelOk =
    selection.model === "" || (provider.supportsModelSelection && provider.models.some((m) => m.id === selection.model));
  return {
    providerId: provider.id,
    model: modelOk ? selection.model : "",
    effort: provider.software === "claude-agent-sdk" ? selection.effort : "",
    workingDir: selection.workingDir,
  };
}
