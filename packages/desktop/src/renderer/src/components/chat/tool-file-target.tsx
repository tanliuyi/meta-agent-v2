import { Tooltip } from "@renderer/shared/ui/tooltip";
import { TooltipContent } from "@renderer/shared/ui/tooltip-content";
import { TooltipTrigger } from "@renderer/shared/ui/tooltip-trigger";
import { type MouseEvent, useEffect, useState } from "react";
import { useOpenWorkbenchFileInPanel, useSessionControlSelector, useSessionScope } from "../session-context.tsx";
import { workbenchToolPath } from "./tools/tool-format.ts";

export function ToolFileTarget({ path }: { path: string }) {
  const { record } = useSessionScope();
  const openInApp = useOpenWorkbenchFileInPanel();
  const projectId = record.identity.projectId;
  const cwd = useSessionControlSelector((control) => control?.cwd);
  const [absolutePath, setAbsolutePath] = useState(path);

  useEffect(() => {
    let active = true;
    void window.desktop.files
      .resolvePath(projectId, path)
      .then((resolvedPath) => {
        if (active) setAbsolutePath(resolvedPath);
      })
      .catch((error: unknown) => console.error("Failed to resolve tool file path:", error));
    return () => {
      active = false;
    };
  }, [path, projectId]);

  async function openFile(event: MouseEvent<HTMLButtonElement>): Promise<void> {
    event.stopPropagation();
    const workbenchPath = cwd ? workbenchToolPath(path, cwd) : null;
    // 项目内文件：在应用内 workbench 文件面板打开（对齐文件树单击行为）；
    // 侧边栏未开或未选中资源管理 tab 时自动打开并选中。
    if (workbenchPath !== null && openInApp(workbenchPath)) return;
    try {
      await window.desktop.files.open(projectId, path);
    } catch (error: unknown) {
      console.error("Failed to open tool file:", error);
    }
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" className="tool-target tool-file-target" onClick={openFile}>
          {path}
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-[min(320px,calc(100vw-24px))] break-all" side="top">
        {absolutePath}
      </TooltipContent>
    </Tooltip>
  );
}
