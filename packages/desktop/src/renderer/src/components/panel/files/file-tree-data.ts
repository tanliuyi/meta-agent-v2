import type { FileChangeSet, FileNode } from "../../../../../shared/contracts.ts";

export interface FileTreeData {
  roots: FileNode[];
  children: Record<string, FileNode[]>;
}

export function emptyFileTreeData(): FileTreeData {
  return { roots: [], children: {} };
}

export function replaceFileTreeDirectory(state: FileTreeData, path: string, items: FileNode[]): FileTreeData {
  if (path === "") return { ...state, roots: items };
  return { ...state, children: { ...state.children, [path]: items } };
}

export type ActiveFileChange = "deleted" | "reload" | null;

export function activeFileChange(change: FileChangeSet, activePath: string): ActiveFileChange {
  if (change.deleted.some((path) => activePath === path || activePath.startsWith(`${path}/`))) return "deleted";
  if (change.updated.includes(activePath) || change.added.includes(activePath)) return "reload";
  return null;
}

export function removeLoadedFileTreeDirectory(state: FileTreeData, path: string): FileTreeData {
  if (state.children[path] === undefined) return state;
  const children = { ...state.children };
  delete children[path];
  return { ...state, children };
}
