import { useResizableRegion } from "@renderer/shared/hooks/use-resizable-region";
import { type CSSProperties, type ReactNode, useRef } from "react";
import { useSessionScope, useSessionWorkbenchSelector } from "../../session-context.tsx";

const FILE_TREE_DEFAULT_WIDTH = 240;
const FILE_TREE_MIN_WIDTH = 180;
const FILE_PREVIEW_MIN_WIDTH = 260;

interface FileWorkspaceLayoutProps {
  treeContentId: string;
  treeAriaLabel: string;
  resizeAriaLabel: string;
  tree: ReactNode;
  preview: ReactNode;
  className?: string;
  treeClassName?: string;
}

/** Shared Explorer/SCM grid. Width updates remain inside this layout shell. */
export function FileWorkspaceLayout({
  treeContentId,
  treeAriaLabel,
  resizeAriaLabel,
  tree,
  preview,
  className,
  treeClassName,
}: FileWorkspaceLayoutProps) {
  const { updateWorkbench } = useSessionScope();
  const fileTreeWidth = useSessionWorkbenchSelector((workbench) => workbench?.fileTreeWidth ?? FILE_TREE_DEFAULT_WIDTH);
  const workspace = useRef<HTMLDivElement>(null);
  const resize = useResizableRegion<HTMLElement>({
    value: fileTreeWidth,
    min: FILE_TREE_MIN_WIDTH,
    getMaxSize: () => (workspace.current?.clientWidth ?? FILE_PREVIEW_MIN_WIDTH * 2) - FILE_PREVIEW_MIN_WIDTH,
    direction: 1,
    orientation: "vertical",
    constraintRef: workspace,
    onCommit: (nextWidth) => {
      if (nextWidth !== fileTreeWidth) updateWorkbench({ fileTreeWidth: nextWidth });
    },
  });

  return (
    <div ref={workspace} className={className ? `file-workspace ${className}` : "file-workspace"}>
      <aside
        ref={resize.regionRef}
        className={treeClassName ? `file-tree-panel ${treeClassName}` : "file-tree-panel"}
        style={{ "--resizable-region-size": `${resize.initialSize}px` } as CSSProperties}
        aria-label={treeAriaLabel}
      >
        <div
          ref={resize.separatorRef}
          className="resize-handle resize-handle-file-tree"
          role="separator"
          tabIndex={0}
          aria-label={resizeAriaLabel}
          aria-controls={treeContentId}
          aria-orientation="vertical"
          aria-valuemin={FILE_TREE_MIN_WIDTH}
          aria-valuemax={resize.initialMax}
          aria-valuenow={resize.initialSize}
          aria-valuetext={`${resize.initialSize} 像素`}
          onPointerDown={resize.onPointerDown}
          onKeyDown={resize.onKeyDown}
        />
        <div id={treeContentId} className="file-tree-surface">
          {tree}
        </div>
      </aside>
      {preview}
    </div>
  );
}
