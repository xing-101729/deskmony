import { useTranslation } from "react-i18next";
import { useBrowserStore } from "../../stores/browser-store.js";

export interface AgentActivityView {
  /** 還有指令在執行(「正在操作」);假 = 剛剛操作過、指示還在留存期間。 */
  working: boolean;
  /** 給人看的一句話:「agent 正在操作瀏覽器 · 前往 localhost:3000」。 */
  text: string;
}

/**
 * 某個 session 的瀏覽器上「agent 操作中」的指示(2026-10-21,P4b)——Browser 分頁的標題列、分頁標籤的小圓點、面板開關鈕共用同一份文字。
 * 沒有指示(agent 沒在操作、也已過了留存時間)回 `undefined`。
 */
export function useAgentActivity(sessionId: string | null | undefined): AgentActivityView | undefined {
  const { t } = useTranslation(["sidePanel"]);
  const activity = useBrowserStore((s) => (sessionId ? s.agentActivity[sessionId] : undefined));
  if (!activity) return undefined;
  const working = activity.active > 0;
  const action = t(`sidePanel:browser.agent.actions.${activity.action.key}`, activity.action.params);
  return { working, text: t(working ? "sidePanel:browser.agent.working" : "sidePanel:browser.agent.recent", { action }) };
}
