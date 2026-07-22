import { Tooltip } from "@renderer/shared/ui/tooltip";
import { TooltipContent } from "@renderer/shared/ui/tooltip-content";
import { TooltipTrigger } from "@renderer/shared/ui/tooltip-trigger";
import { type MouseEvent, useEffect, useState } from "react";
import { useSessionScope } from "../session-context.tsx";

export function ToolFileTarget({ path }: { path: string }) {
  const { record } = useSessionScope();
  const projectId = record.identity.projectId;
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

  function openFile(event: MouseEvent<HTMLButtonElement>): void {
    event.stopPropagation();
    void window.desktop.files
      .open(projectId, path)
      .catch((error: unknown) => console.error("Failed to open tool file:", error));
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
