import type { CheckpointData } from "./core.ts";

export interface RewindState {
  gitAvailable: boolean;
  repoRoot: string | null;
  sessionId: string | null;
  checkpoints: Map<string, CheckpointData>;
  lastCheckpoint: CheckpointData | null;
  pending: Promise<void> | null;
  currentTurnIndex: number;
  currentPrompt: string;
  runActive: boolean;
  pendingToolInfo: Map<string, string>;
  runToolDescriptions: string[];
  runHadMutations: boolean;
}

export function createInitialState(): RewindState {
  return {
    gitAvailable: false,
    repoRoot: null,
    sessionId: null,
    checkpoints: new Map(),
    lastCheckpoint: null,
    pending: null,
    currentTurnIndex: 0,
    currentPrompt: "",
    runActive: false,
    pendingToolInfo: new Map(),
    runToolDescriptions: [],
    runHadMutations: false,
  };
}

export function resetState(state: RewindState): void {
  state.gitAvailable = false;
  state.repoRoot = null;
  state.sessionId = null;
  state.checkpoints.clear();
  state.lastCheckpoint = null;
  state.pending = null;
  state.currentTurnIndex = 0;
  state.currentPrompt = "";
  state.runActive = false;
  state.pendingToolInfo.clear();
  state.runToolDescriptions = [];
  state.runHadMutations = false;
}
