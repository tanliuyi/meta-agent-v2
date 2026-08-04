import ChevronRight from "lucide-react/dist/esm/icons/chevron-right.mjs";
import Folder from "lucide-react/dist/esm/icons/folder.mjs";
import FolderOpen from "lucide-react/dist/esm/icons/folder-open.mjs";
import type { CSSProperties } from "react";
import type { ScmTreeDirectory } from "./scm-tree.ts";

function countLeaves(node: ScmTreeDirectory): number {
  let count = 0;
  for (const child of node.children) {
    count += child.directory ? countLeaves(child) : 1;
  }
  return count;
}

/** SCM 目录树行：目录层级缩进、展开状态和变更数量。 */
export function DirectoryRow({
  node,
  depth,
  expanded,
  onToggle,
}: {
  node: ScmTreeDirectory;
  depth: number;
  expanded: boolean;
  onToggle(): void;
}) {
  const leafCount = countLeaves(node);
  return (
    <div
      className="scm-tree-directory"
      style={{ "--scm-indent": `${depth * 10}px` } as CSSProperties}
      role="treeitem"
      aria-expanded={expanded}
      onClick={onToggle}
    >
      <ChevronRight className="scm-tree-chevron" data-expanded={expanded || undefined} aria-hidden="true" />
      {expanded ? (
        <FolderOpen className="scm-tree-folder" aria-hidden="true" />
      ) : (
        <Folder className="scm-tree-folder" aria-hidden="true" />
      )}
      <span className="scm-tree-directory-name">{node.name}</span>
      <span className="scm-tree-count">{leafCount}</span>
    </div>
  );
}
