import * as ContextMenu from "@radix-ui/react-context-menu";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.mjs";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right.mjs";
import Folder from "lucide-react/dist/esm/icons/folder.mjs";
import FolderOpen from "lucide-react/dist/esm/icons/folder-open.mjs";
import { type CSSProperties, memo, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import type { FileNode } from "../../../../../shared/contracts.ts";
import { PROJECT_FILE_DRAG_MIME } from "../panel-model.ts";
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
  renderTrailingContent?(node: FileNode): ReactNode;
  onKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, index: number): void;
}

export const FileTreeNodeRow = memo(function FileTreeNodeRow({
  row,
  index,
  active,
  tabIndex,
  sticky = false,
  onOpen,
  onPinOpen,
  renderContextMenu,
  renderTrailingContent,
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
      draggable={node.type === "file"}
      tabIndex={tabIndex}
      aria-expanded={node.type === "directory" ? row.open : undefined}
      aria-level={row.depth + 1}
      aria-selected={active === node.path}
      onClick={() => onOpen(node)}
      onDoubleClick={onPinOpen ? () => onPinOpen(node) : undefined}
      onFocus={setFileTreeRovingTabStop}
      onDragStart={(event) => {
        if (node.type !== "file") return;
        event.dataTransfer.effectAllowed = "copy";
        event.dataTransfer.setData(PROJECT_FILE_DRAG_MIME, node.path);
      }}
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
      <span className="file-row-label">
        {(row.compressedNodes ?? [node]).map((item, itemIndex) => (
          <span key={item.path} className="file-row-label-segment">
            {itemIndex > 0 ? <span className="file-row-label-separator">\</span> : null}
            {item.name}
          </span>
        ))}
      </span>
      {renderTrailingContent?.(node)}
    </button>
  );

  if (!renderContextMenu) return rowButton;
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{rowButton}</ContextMenu.Trigger>
      {renderContextMenu(node)}
    </ContextMenu.Root>
  );
});
