import { useTranslation } from "react-i18next";
import { usePanelStore } from "../../stores/panel-store.js";
import { IconButton } from "../../ui/Button.js";
import { MOD_LABEL } from "../../ui/hotkeys.js";
import { togglePanel } from "./panel-actions.js";

/** 右側面板的開關鈕(ChatView 與 TerminalView 的標頭各放一顆);面板開著時呈現啟用狀態。 */
export function PanelToggleButton(): JSX.Element {
  const { t } = useTranslation(["sidePanel"]);
  const open = usePanelStore((s) => s.open);
  const label = open ? t("sidePanel:hide") : t("sidePanel:show");
  return (
    <IconButton
      icon="panel-right"
      aria-label={label}
      aria-pressed={open}
      title={`${label} (${MOD_LABEL}+J)`}
      active={open}
      onClick={togglePanel}
    />
  );
}
