export interface PiCheckpointFileDiff {
  path: string;
  additions: number | null;
  deletions: number | null;
}

export interface PiCheckpointNoticeDetails {
  checkpointId: string;
  restoreCheckpointId: string;
  reason: "run" | "recovery";
  description: string;
  fileCount: number;
  additions: number;
  deletions: number;
  truncated: boolean;
  files: PiCheckpointFileDiff[];
}

export interface SessionCheckpointDiffInput {
  projectId: string;
  threadId: string;
  fromCheckpointId: string;
  toCheckpointId: string;
  path: string;
}

export interface SessionCheckpointDiffResult {
  patch: string;
  truncated: boolean;
}

export interface SessionCheckpointRestoreInput {
  projectId: string;
  threadId: string;
  checkpointId: string;
  expectedCheckpointId: string;
}

export interface SessionCheckpointRestoreResult {
  checkpointId: string;
  restoredFiles: number;
}
