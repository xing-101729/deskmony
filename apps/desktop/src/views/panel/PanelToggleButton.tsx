import { useTranslation } from "react-i18next";
import { usePanelStore } from "../../stores/panel-store.js";
import { useSessionStore } from "../../stores/session-store.js";
import { IconButton } from "../../ui/Button.js";
import { MOD_LABEL } from "../../ui/hotkeys.js";
import { useAgentActivity } from "./agent-activity.js";
import { togglePanel } from "./panel-actions.js";

/**
 * 右側面板的開關鈕(ChatView 與 TerminalView 的標頭各放一顆);面板開著時呈現啟用狀態。
 * agent 正在操作目前 session 的瀏覽器(P4b)時,右上角多一個小圓點、提示文字帶上最近的動作——面板關著也看得到 agent 在做事。
 */
export function PanelToggleButton(): JSX.Element {
  const { t } = useTranslation(["sidePanel"]);
  const open = usePanelStore((s) => s.open);
  const currentSessionId = useSessionStore((s) => s.currentSessionId);
  const agent = useAgentActivity(currentSessionId);
  const label = open ? t("sidePanel:hide") : t("sidePanel:show");
  return (
    <span className="relative inline-flex flex-shrink-0">
      <IconButton
        icon="panel-right"
        aria-label={agent ? `${label} — ${agent.text}` : label}
        aria-pressed={open}
        title={`${label} (${MOD_LABEL}+J)${agent ? `\n${agent.text}` : ""}`}
        active={open}
        onClick={togglePanel}
      />
      {agent && (
        <span
          aria-hidden="true"
          className={`pointer-events-none absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-accent ring-1 ring-canvas ${agent.working ? "animate-pulse" : "opacity-60"}`}
        />
      )}
    </span>
  );
}
