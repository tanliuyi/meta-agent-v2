import { TooltipIconButton } from "@renderer/components/assistant-ui/tooltip-icon-button";
import Files from "lucide-react/dist/esm/icons/files.mjs";
import GitBranch from "lucide-react/dist/esm/icons/git-branch.mjs";

export type ExplorerPanelMode = "files" | "source-control";

/** 资源管理左栏模式切换：文件管理与源代码管理共享同一个顶层 Panel。 */
export function ExplorerModeSwitch({
  value,
  onValueChange,
}: {
  value: ExplorerPanelMode;
  onValueChange(value: ExplorerPanelMode): void;
}) {
  return (
    <div className="explorer-mode-switch" role="group" aria-label="资源管理视图">
      <TooltipIconButton
        className="explorer-mode-switch-button"
        tooltip="文件管理"
        aria-label="文件管理"
        aria-pressed={value === "files"}
        data-active={value === "files" || undefined}
        onClick={() => onValueChange("files")}
      >
        <Files aria-hidden="true" />
      </TooltipIconButton>
      <TooltipIconButton
        className="explorer-mode-switch-button"
        tooltip="源代码管理"
        aria-label="源代码管理"
        aria-pressed={value === "source-control"}
        data-active={value === "source-control" || undefined}
        onClick={() => onValueChange("source-control")}
      >
        <GitBranch aria-hidden="true" />
      </TooltipIconButton>
    </div>
  );
}
