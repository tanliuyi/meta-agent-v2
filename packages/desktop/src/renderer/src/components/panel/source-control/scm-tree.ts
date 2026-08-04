import type { GitChange, GitResourceGroup } from "../../../../../shared/git-contracts.ts";

/** 目录节点：change 为 null，children 非空。 */
export interface ScmTreeDirectory {
  path: string;
  name: string;
  directory: true;
  change: null;
  children: ScmTreeNode[];
}

/** 文件叶子：change 为对应变更，无 children。 */
export interface ScmTreeLeaf {
  path: string;
  name: string;
  directory: false;
  change: GitChange;
  children: [];
}

/** 分组内变更的目录树节点（对应 VS Code ResourceTree 的 IResourceNode）。 */
export type ScmTreeNode = ScmTreeDirectory | ScmTreeLeaf;

/** 以分组和路径共同标识展开状态，避免不同资源组相互串联。 */
export function scmTreeExpansionKey(group: GitResourceGroup["kind"], path: string): string {
  return `${group}\0${path}`;
}

/**
 * 将平铺的变更列表按路径分段构建为目录树（对齐 VS Code scmViewPane 的
 * ResourceTree：目录节点在前、按名称排序，文件节点保持相对路径层级）。
 */
export function buildChangeTree(changes: readonly GitChange[]): ScmTreeNode[] {
  const roots: ScmTreeNode[] = [];
  const directoryIndex = new Map<string, ScmTreeDirectory>();

  const getDirectory = (path: string): ScmTreeDirectory | null => {
    const existing = directoryIndex.get(path);
    if (existing) return existing;
    const slash = path.lastIndexOf("/");
    const parent = slash === -1 ? null : getDirectory(path.slice(0, slash));
    if (parent === null && slash !== -1) return null;
    const node: ScmTreeDirectory = {
      path,
      name: slash === -1 ? path : path.slice(slash + 1),
      directory: true,
      change: null,
      children: [],
    };
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
    directoryIndex.set(path, node);
    return node;
  };

  for (const change of changes) {
    const slash = change.path.lastIndexOf("/");
    const directory = slash === -1 ? null : getDirectory(change.path.slice(0, slash));
    const leaf: ScmTreeLeaf = {
      path: change.path,
      name: slash === -1 ? change.path : change.path.slice(slash + 1),
      directory: false,
      change,
      children: [],
    };
    if (directory) {
      directory.children.push(leaf);
    } else {
      roots.push(leaf);
    }
  }

  const sortNodes = (nodes: ScmTreeNode[]): void => {
    nodes.sort(
      (left, right) =>
        Number(right.directory) - Number(left.directory) ||
        left.name.localeCompare(right.name) ||
        left.path.localeCompare(right.path),
    );
    for (const node of nodes) {
      if (node.directory) sortNodes(node.children);
    }
  };
  sortNodes(roots);
  return roots;
}

/** 树中所有叶子变更。 */
export function collectTreeChanges(nodes: readonly ScmTreeNode[]): GitChange[] {
  const changes: GitChange[] = [];
  const visit = (node: ScmTreeNode): void => {
    if (!node.directory) changes.push(node.change);
    for (const child of node.children) visit(child);
  };
  for (const node of nodes) visit(node);
  return changes;
}
