import type {
  ClearedQueue,
  DraftSessionConfig,
  HostResponse,
  OpenRunCodeArtifactInput,
  SessionAttachInput,
  SessionAttachment,
  SessionBootstrap,
  SessionBranchInput,
  SessionBranchResult,
  SessionCommandResult,
  SessionControlState,
  SessionCreateInput,
  SessionEditInput,
  SessionImageResource,
  SessionMentionCandidate,
  SessionPromptInput,
  SessionPush,
  SessionReloadInput,
  SessionRemovePolicy,
  SessionRemoveResult,
  SessionResourceReloadInput,
  Thread,
} from "../../shared/contracts.ts";
import type {
  ApplyDesktopExtensionSetResult,
  DesktopExtensionDiagnostic,
  DesktopWidgetViewport,
  SessionPluginOptions,
} from "../../shared/desktop-extension-contracts.ts";
import type { MainAgentDraftSelection } from "../../shared/main-agent-contracts.ts";
import type { PiGoalSnapshot, SessionGoalActionInput } from "../../shared/pi-goal-contracts.ts";
import type {
  SessionCheckpointDiffInput,
  SessionCheckpointDiffResult,
  SessionCheckpointRestoreInput,
  SessionCheckpointRestoreResult,
} from "../../shared/pi-rewind-contracts.ts";

export interface SessionExtensionState {
  readonly appliedGeneration?: string;
  readonly desiredGeneration: string;
  readonly reloadRequired: boolean;
  readonly diagnostics: DesktopExtensionDiagnostic[];
}

/** Project state consumed by session orchestration. */
export interface SessionProjectPort {
  getCwd(projectId: string): string;
  resolveSessionCwd(projectId: string, candidate: string): Promise<string>;
  resolveWorktree(projectId: string, candidate: string): Promise<string>;
  isArchived(projectId: string, threadId: string): boolean;
  setArchived(projectId: string, threadId: string, archived: boolean): Promise<void>;
  removeWorkbench(projectId: string, threadId: string): Promise<void>;
}

/** Pi-backed runtime operations required by the Desktop session application service. */
export interface SessionRuntimePort {
  list(projectId: string): Promise<Thread[]>;
  listWithPaths(projectId: string): Promise<SessionMentionCandidate[]>;
  getDraftConfig(projectId: string, cwd: string, selection?: MainAgentDraftSelection): Promise<DraftSessionConfig>;
  getSessionCwd(projectId: string, threadId: string): string | undefined;
  getExtensionState(projectId: string, threadId: string): Promise<SessionExtensionState>;
  extensionSettingsChanged(): Promise<void>;
  prewarm(projectId: string, threadId: string): Promise<void>;
  close(projectId: string, threadId: string): Promise<void>;
  create(input: SessionCreateInput): Promise<SessionBootstrap>;
  attach(projectId: string, threadId: string): Promise<SessionBootstrap>;
  detach(projectId: string, threadId: string): void;
  prompt(input: SessionPromptInput): Promise<SessionCommandResult>;
  edit(input: SessionEditInput): Promise<SessionCommandResult>;
  reload(input: SessionReloadInput): Promise<SessionCommandResult>;
  reloadResources(input: SessionResourceReloadInput): Promise<SessionCommandResult>;
  runGoalAction(input: SessionGoalActionInput): Promise<PiGoalSnapshot>;
  getCheckpointDiff(input: SessionCheckpointDiffInput): Promise<SessionCheckpointDiffResult>;
  restoreCheckpoint(input: SessionCheckpointRestoreInput): Promise<SessionCheckpointRestoreResult>;
  branch(input: SessionBranchInput): Promise<SessionBranchResult>;
  cancel(projectId: string, threadId: string): Promise<ClearedQueue>;
  clearQueue(projectId: string, threadId: string): Promise<ClearedQueue>;
  compact(projectId: string, threadId: string): Promise<void>;
  refreshModels(projectId: string, threadId: string): Promise<void>;
  setModel(projectId: string, threadId: string, provider: string, modelId: string): Promise<void>;
  setThinking(projectId: string, threadId: string, level: SessionControlState["thinkingLevel"]): Promise<void>;
  applyExtensionSet(
    projectId: string,
    threadId: string,
    expectedDesiredGeneration: string,
    abortRunning?: boolean,
  ): Promise<ApplyDesktopExtensionSetResult>;
  getSessionPluginOptions(projectId: string, threadId: string): Promise<SessionPluginOptions>;
  applySessionPluginSelection(
    projectId: string,
    threadId: string,
    enabledPluginIds: string[] | null,
    abortRunning?: boolean,
  ): Promise<ApplyDesktopExtensionSetResult>;
  rename(projectId: string, threadId: string, title: string): Promise<void>;
  promote(projectId: string, threadId: string): Promise<SessionRemoveResult>;
  remove(projectId: string, threadId: string, policy: SessionRemovePolicy): Promise<SessionRemoveResult>;
  removeProject(projectId: string): Promise<void>;
  configureWidget(projectId: string, threadId: string, viewport: DesktopWidgetViewport): Promise<void>;
  respond(projectId: string, threadId: string, response: HostResponse): Promise<void>;
  readImageResource(projectId: string, threadId: string, resourceId: string): Promise<SessionImageResource | undefined>;
  resolveRunCodeArtifact(
    projectId: string,
    threadId: string,
    toolCallId: string,
    artifactId: string,
  ): Promise<string | undefined>;
  acknowledge(workerInstanceId: string, sidecarSequence: number): void;
  dispose(): Promise<void>;
}

/** Stable application boundary consumed by IPC and other main-process capabilities. */
export interface SessionService {
  list(projectId: string, includeArchived?: boolean): Promise<Thread[]>;
  listWithPaths(projectId: string): Promise<SessionMentionCandidate[]>;
  getDraftConfig(
    projectId: string,
    worktreePath?: string,
    mainAgent?: MainAgentDraftSelection,
  ): Promise<DraftSessionConfig>;
  getSessionCwd(projectId: string, threadId: string): string | undefined;
  getExtensionState(projectId: string, threadId: string): Promise<SessionExtensionState>;
  extensionSettingsChanged(): Promise<void>;
  prewarm(projectId: string, threadId: string): Promise<void>;
  close(ownerId: number, projectId: string, threadId: string): Promise<void>;
  create(input: SessionCreateInput): Promise<SessionBootstrap>;
  attach(ownerId: number, input: SessionAttachInput, send: (update: SessionPush) => void): Promise<SessionAttachment>;
  prompt(input: SessionPromptInput): Promise<SessionCommandResult>;
  edit(input: SessionEditInput): Promise<SessionCommandResult>;
  reload(input: SessionReloadInput): Promise<SessionCommandResult>;
  reloadResources(input: SessionResourceReloadInput): Promise<SessionCommandResult>;
  runGoalAction(input: SessionGoalActionInput): Promise<PiGoalSnapshot>;
  getCheckpointDiff(input: SessionCheckpointDiffInput): Promise<SessionCheckpointDiffResult>;
  restoreCheckpoint(input: SessionCheckpointRestoreInput): Promise<SessionCheckpointRestoreResult>;
  branch(input: SessionBranchInput): Promise<SessionBranchResult>;
  cancel(projectId: string, threadId: string): Promise<ClearedQueue>;
  clearQueue(projectId: string, threadId: string): Promise<ClearedQueue>;
  compact(projectId: string, threadId: string): Promise<void>;
  refreshModels(projectId: string, threadId: string): Promise<void>;
  setModel(projectId: string, threadId: string, provider: string, modelId: string): Promise<void>;
  setThinking(projectId: string, threadId: string, level: SessionControlState["thinkingLevel"]): Promise<void>;
  applyExtensionSet(
    projectId: string,
    threadId: string,
    expectedDesiredGeneration: string,
    abortRunning?: boolean,
  ): Promise<ApplyDesktopExtensionSetResult>;
  getSessionPluginOptions(projectId: string, threadId: string): Promise<SessionPluginOptions>;
  applySessionPluginSelection(
    projectId: string,
    threadId: string,
    enabledPluginIds: string[] | null,
    abortRunning?: boolean,
  ): Promise<ApplyDesktopExtensionSetResult>;
  rename(projectId: string, threadId: string, title: string): Promise<void>;
  archive(projectId: string, threadId: string, archived: boolean): Promise<void>;
  promote(projectId: string, threadId: string): Promise<SessionRemoveResult>;
  remove(projectId: string, threadId: string, policy: SessionRemovePolicy): Promise<SessionRemoveResult>;
  removeProject(projectId: string): Promise<void>;
  configureWidget(ownerId: number, projectId: string, threadId: string, viewport: DesktopWidgetViewport): Promise<void>;
  respond(projectId: string, threadId: string, response: HostResponse): Promise<void>;
  readImageResource(
    ownerId: number,
    attachmentId: string,
    resourceId: string,
  ): Promise<SessionImageResource | undefined>;
  resolveRunCodeArtifact(ownerId: number, input: OpenRunCodeArtifactInput): Promise<string>;
  detach(ownerId: number, attachmentId: string): void;
  detachAll(ownerId: number): void;
  acknowledge(ownerId: number, attachmentId: string, workerInstanceId: string, sidecarSequence: number): void;
  dispose(): Promise<void>;
}
