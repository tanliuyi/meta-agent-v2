import { Tooltip } from "@renderer/shared/ui/tooltip";
import { TooltipContent } from "@renderer/shared/ui/tooltip-content";
import { TooltipTrigger } from "@renderer/shared/ui/tooltip-trigger";
import { type MouseEvent, useEffect, useState } from "react";

export function ToolFileTarget({ path }: { path: string }) {
  const [absolutePath, setAbsolutePath] = useState(path);

  useEffect(() => {
    let active = true;
    void window.desktop.files
      .resolvePath(path)
      .then((resolvedPath) => {
        if (active) setAbsolutePath(resolvedPath);
      })
      .catch((error: unknown) => console.error("Failed to resolve tool file path:", error));
    return () => {
      active = false;
    };
  }, [path]);

  function openFile(event: MouseEvent<HTMLButtonElement>): void {
    event.stopPropagation();
    void window.desktop.files.open(path).catch((error: unknown) => console.error("Failed to open tool file:", error));
  }

  const segments = path.split(/[\\/]/);
  const fileName = segments.at(-1) || path;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" className="tool-target tool-file-target" onClick={openFile}>
          {fileName}
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-[min(320px,calc(100vw-24px))] break-all" side="top">
        {absolutePath}
      </TooltipContent>
    </Tooltip>
  );
}
