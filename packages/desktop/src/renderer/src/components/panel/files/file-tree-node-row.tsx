import * as ContextMenu from "@radix-ui/react-context-menu";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.mjs";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right.mjs";
import Folder from "lucide-react/dist/esm/icons/folder.mjs";
import FolderOpen from "lucide-react/dist/esm/icons/folder-open.mjs";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import type { FileNode } from "../../../../../shared/contracts.ts";
import { type FileTreeRow, setFileTreeRovingTabStop } from "./file-tree-navigation.ts";
import { FileTypeIcon } from "./file-type-icon.tsx";

interface FileTreeNodeRowProps {
  row: FileTreeRow;
  index: number;
  active?: string;
  tabIndex: number;
  sticky?: boolean;
  onOpen(node: FileNode): void;
  onPinOpen?(node: FileNode): void;
  renderContextMenu?(node: FileNode): ReactNode;
  onKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, index: number): void;
}

export function FileTreeNodeRow({
  row,
  index,
  active,
  tabIndex,
  sticky = false,
  onOpen,
  onPinOpen,
  renderContextMenu,
  onKeyDown,
}: FileTreeNodeRowProps) {
  const node = row.node;
  if (!node) return null;

  const rowButton = (
    <button
      type="button"
      role="treeitem"
      className="file-row"
      data-row-index={sticky ? undefined : index}
      data-node-type={node.type}
      data-active={active === node.path || undefined}
      data-sticky={sticky || undefined}
      tabIndex={tabIndex}
      aria-expanded={node.type === "directory" ? row.open : undefined}
      aria-level={row.depth + 1}
      aria-selected={active === node.path}
      onClick={() => onOpen(node)}
      onDoubleClick={onPinOpen ? () => onPinOpen(node) : undefined}
      onFocus={setFileTreeRovingTabStop}
      onKeyDown={(event) => onKeyDown(event, index)}
    >
      <span className="file-tree-indent-guides" aria-hidden="true">
        {Array.from({ length: row.depth }, (_, guideDepth) => (
          <span
            key={guideDepth}
            className="file-tree-indent-guide"
            style={{ "--file-tree-guide-depth": guideDepth } as CSSProperties}
          />
        ))}
      </span>
      {node.type === "directory" ? (
        row.open ? (
          <ChevronDown size={13} aria-hidden="true" />
        ) : (
          <ChevronRight size={13} aria-hidden="true" />
        )
      ) : null}
      {node.type === "directory" ? (
        row.open ? (
          <FolderOpen size={14} aria-hidden="true" />
        ) : (
          <Folder size={14} aria-hidden="true" />
        )
      ) : (
        <FileTypeIcon name={node.name} />
      )}
      <span>{node.name}</span>
    </button>
  );

  if (!renderContextMenu) return rowButton;
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{rowButton}</ContextMenu.Trigger>
      {renderContextMenu(node)}
    </ContextMenu.Root>
  );
}
