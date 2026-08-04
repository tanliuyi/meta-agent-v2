import { memo } from "react";
import type { GitResourceGroup } from "../../../../../shared/git-contracts.ts";
import { ChangeRow } from "./change-row.tsx";
import { DirectoryRow } from "./directory-row.tsx";
import { type ScmTreeNode, scmTreeExpansionKey } from "./scm-tree.ts";

/** 目录树节点递归渲染（对齐 VS Code scmViewPane 的 ResourceTree 展示）。 */
export const ChangeTree = memo(function ChangeTree({
  nodes,
  group,
  depth,
  collapsedDirectories,
  selectedKey,
  onToggle,
  onSelect,
  onStage,
  onUnstage,
  onDiscard,
  onOpen,
}: {
  nodes: readonly ScmTreeNode[];
  group: GitResourceGroup["kind"];
  depth: number;
  collapsedDirectories: ReadonlySet<string>;
  selectedKey: string | null;
  onToggle(path: string): void;
  onSelect(path: string): void;
  onStage(changePath: string): void;
  onUnstage(changePath: string): void;
  onDiscard(changePath: string): void;
  onOpen(path: string): void;
}) {
  const isExpanded = (path: string): boolean => !collapsedDirectories.has(scmTreeExpansionKey(group, path));

  return (
    <>
      {nodes.map((node) =>
        node.directory ? (
          <div key={node.path} role="treeitem">
            <DirectoryRow
              node={node}
              depth={depth}
              expanded={isExpanded(node.path)}
              onToggle={() => onToggle(node.path)}
            />
            {isExpanded(node.path) ? (
              <ChangeTree
                nodes={node.children}
                group={group}
                depth={depth + 1}
                collapsedDirectories={collapsedDirectories}
                selectedKey={selectedKey}
                onToggle={onToggle}
                onSelect={onSelect}
                onStage={onStage}
                onUnstage={onUnstage}
                onDiscard={onDiscard}
                onOpen={onOpen}
              />
            ) : null}
          </div>
        ) : (
          <ChangeRow
            key={node.path}
            change={node.change}
            group={group}
            depth={depth}
            selected={selectedKey === scmTreeExpansionKey(group, node.path)}
            onSelect={() => onSelect(node.path)}
            onStage={() => onStage(node.path)}
            onUnstage={() => onUnstage(node.path)}
            onDiscard={() => onDiscard(node.path)}
            onOpen={() => onOpen(node.path)}
          />
        ),
      )}
    </>
  );
});
