import type { TextFile } from "./contracts.ts";

export type ScmChangeKind = "modified" | "added" | "deleted" | "renamed" | "untracked" | "conflicted";

export interface ScmChange {
  path: string;
  originalPath?: string;
  kind: ScmChangeKind;
  staged: boolean;
}

export interface ScmSnapshot {
  projectId: string;
  branch: string | null;
  ahead: number;
  behind: number;
  changes: ScmChange[];
  fetchedAt: number;
}

export interface ScmDiffHunk {
  originalStart: number;
  originalLines: number;
  modifiedStart: number;
  modifiedLines: number;
}

export interface ScmDiff {
  path: string;
  original: TextFile | null;
  modified: TextFile | null;
  hunks: ScmDiffHunk[];
  binary: boolean;
}
