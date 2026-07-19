import ChevronDown from "lucide-react/dist/esm/icons/chevron-down.mjs";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right.mjs";
import File from "lucide-react/dist/esm/icons/file.mjs";
import Folder from "lucide-react/dist/esm/icons/folder.mjs";
import FolderOpen from "lucide-react/dist/esm/icons/folder-open.mjs";
import type { CSSProperties } from "react";
import type { FileNode } from "../../../../shared/contracts.ts";
import { handleFileTreeKeyDown, setFileTreeRovingTabStop } from "./file-tree-navigation.ts";

interface FileTreeProps {
  nodes: readonly FileNode[];
  children: Readonly<Record<string, readonly FileNode[]>>;
  expanded: ReadonlySet<string>;
  active?: string;
  onOpen(node: FileNode): void;
  depth?: number;
  focusPath?: string;
}

function hasVisiblePath(
  nodes: readonly FileNode[],
  children: Readonly<Record<string, readonly FileNode[]>>,
  expanded: ReadonlySet<string>,
  path: string,
): boolean {
  for (const node of nodes) {
    if (node.path === path) return true;
    if (node.type === "directory" && expanded.has(node.path) && children[node.path]) {
      if (hasVisiblePath(children[node.path], children, expanded, path)) return true;
    }
  }
  return false;
}

/** 递归渲染带 tree/group 层级语义的文件节点。 */
export function FileTree({ nodes, children, expanded, active, onOpen, depth = 0, focusPath }: FileTreeProps) {
  const rovingPath =
    focusPath ?? (active && hasVisiblePath(nodes, children, expanded, active) ? active : nodes[0]?.path);
  return (
    <div role={depth === 0 ? "tree" : "group"} aria-label={depth === 0 ? "项目文件" : undefined}>
      {nodes.map((node) => {
        const open = expanded.has(node.path);
        return (
          <div key={node.path}>
            <button
              type="button"
              role="treeitem"
              className="file-row"
              data-active={active === node.path || undefined}
              style={{ "--file-tree-depth": depth } as CSSProperties}
              tabIndex={rovingPath === node.path ? 0 : -1}
              aria-expanded={node.type === "directory" ? open : undefined}
              aria-level={depth + 1}
              aria-selected={active === node.path}
              onClick={() => onOpen(node)}
              onFocus={setFileTreeRovingTabStop}
              onKeyDown={(event) => handleFileTreeKeyDown(event, node, onOpen)}
            >
              {node.type === "directory" ? (
                open ? (
                  <ChevronDown size={13} aria-hidden="true" />
                ) : (
                  <ChevronRight size={13} aria-hidden="true" />
                )
              ) : (
                <span className="file-spacer" />
              )}
              {node.type === "directory" ? (
                open ? (
                  <FolderOpen size={14} aria-hidden="true" />
                ) : (
                  <Folder size={14} aria-hidden="true" />
                )
              ) : (
                <File size={14} aria-hidden="true" />
              )}
              <span>{node.name}</span>
            </button>
            {node.type === "directory" && open && children[node.path] ? (
              <FileTree
                nodes={children[node.path]}
                children={children}
                expanded={expanded}
                active={active}
                onOpen={onOpen}
                depth={depth + 1}
                focusPath={rovingPath}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
