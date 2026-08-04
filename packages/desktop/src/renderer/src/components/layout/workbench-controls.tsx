import PanelRight from "lucide-react/dist/esm/icons/panel-right.mjs";
import TerminalSquare from "lucide-react/dist/esm/icons/square-terminal.mjs";
import { TooltipIconButton } from "../assistant-ui/tooltip-icon-button.tsx";
import { useSessionScope, useSessionWorkbenchSelector } from "../session-context.tsx";

/**
 * 终端与右侧 Panel 的显示/隐藏切换按钮，供会话 Topbar 与新会话（草稿）Topbar 共用。
 * `disabled` 由调用方决定可用性（会话取决于 workbench store 就绪，草稿取决于已选项目）。
 */
export function WorkbenchControls({ disabled = false }: { disabled?: boolean }) {
  const { updateWorkbench } = useSessionScope();
  const panelOpen = useSessionWorkbenchSelector((workbench) => workbench?.panelOpen ?? false);
  const terminalOpen = useSessionWorkbenchSelector((workbench) => workbench?.terminalOpen ?? false);
  return (
    <>
      <TooltipIconButton
        variant="ghost"
        size="icon"
        aria-label={terminalOpen ? "隐藏底部终端" : "显示底部终端"}
        tooltip="显示/隐藏终端"
        side="bottom"
        className="size-6"
        aria-pressed={terminalOpen}
        disabled={disabled}
        onClick={() => updateWorkbench({ terminalOpen: !terminalOpen })}
      >
        <TerminalSquare className="size-4!" />
      </TooltipIconButton>
      <TooltipIconButton
        variant="ghost"
        size="icon"
        aria-label={panelOpen ? "隐藏右侧 Panel" : "显示右侧 Panel"}
        tooltip="显示/隐藏侧边栏"
        side="bottom"
        className="size-6"
        aria-pressed={panelOpen}
        disabled={disabled}
        onClick={() => {
          if (panelOpen) {
            updateWorkbench({ panelOpen: false });
            return;
          }
          updateWorkbench({ panelOpen: true });
        }}
      >
        <PanelRight className="panel-toggle-icon panel-toggle-icon-right size-4!" data-collapsed={!panelOpen} />
      </TooltipIconButton>
    </>
  );
}
