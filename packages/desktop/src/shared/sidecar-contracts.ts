import type {
  DraftSessionConfig,
  HostResponse,
  JsonValue,
  SessionBootstrap,
  SessionCommandResult,
  SessionControlState,
  SessionCreateInput,
  SessionPromptInput,
  SessionPushPayload,
  SessionRemovePolicy,
  SessionRemoveResult,
  Thread,
} from "./contracts.ts";
export const SIDECAR_PROTOCOL_VERSION = 4;

export type SidecarRole = "thread" | "metadata";

export interface RuntimeCompatibility {
  nodeVersion: string;
  modulesAbi: string;
  napi: string;
  platform: string;
  arch: string;
  osRelease: string;
  libc: string;
  toolchain: string;
  runtimeCompatibilityId: string;
}

export type ThreadWorkerBinding =
  | {
      mode: "create";
      projectId: string;
      cwd: string;
      agentDir: string;
      shellPath?: string;
      sessionId: string;
      createInput: SessionCreateInput;
    }
  | {
      mode: "open";
      projectId: string;
      cwd: string;
      agentDir: string;
      shellPath?: string;
      threadId: string;
      sessionFile: string;
      initialUpdatedAt?: number;
    };

export interface MetadataWorkerBinding {
  agentDir: string;
  userDataDir: string;
}

export type SidecarBinding =
  | { role: "thread"; value: ThreadWorkerBinding }
  | { role: "metadata"; value: MetadataWorkerBinding };

export interface SidecarInitialize {
  kind: "initialize";
  protocolVersion: typeof SIDECAR_PROTOCOL_VERSION;
  workerInstanceId: string;
  expectedRuntime: RuntimeCompatibility;
  binding: SidecarBinding;
}

export interface SidecarReady {
  kind: "ready";
  protocolVersion: typeof SIDECAR_PROTOCOL_VERSION;
  workerInstanceId: string;
  role: SidecarRole;
  runtime: RuntimeCompatibility;
  result?: JsonValue;
}

export interface SerializedSidecarError {
  name: string;
  message: string;
  code?: string;
  retryable: boolean;
  details?: JsonValue;
  stack?: string;
}

export interface SidecarRequest {
  kind: "request";
  protocolVersion: typeof SIDECAR_PROTOCOL_VERSION;
  workerInstanceId: string;
  requestId: string;
  command: SidecarCommand;
}

export type SidecarResponse =
  | {
      kind: "response";
      protocolVersion: typeof SIDECAR_PROTOCOL_VERSION;
      workerInstanceId: string;
      requestId: string;
      ok: true;
      result?: JsonValue;
    }
  | {
      kind: "response";
      protocolVersion: typeof SIDECAR_PROTOCOL_VERSION;
      workerInstanceId: string;
      requestId: string;
      ok: false;
      error: SerializedSidecarError;
    };

export interface SidecarEvent {
  kind: "event";
  protocolVersion: typeof SIDECAR_PROTOCOL_VERSION;
  workerInstanceId: string;
  sequence: number;
  creditCost: number;
  event: SidecarEventBody;
}

export interface SidecarEventAck {
  kind: "event-ack";
  protocolVersion: typeof SIDECAR_PROTOCOL_VERSION;
  workerInstanceId: string;
  throughSequence: number;
  credit: number;
}

export interface SidecarChunk {
  kind: "chunk";
  protocolVersion: typeof SIDECAR_PROTOCOL_VERSION;
  workerInstanceId: string;
  transferId: string;
  lane: "control" | "event";
  index: number;
  total: number;
  payloadBytes: number;
  payloadSha256: string;
  data: string;
}

export interface SidecarShutdown {
  kind: "shutdown";
  protocolVersion: typeof SIDECAR_PROTOCOL_VERSION;
  workerInstanceId: string;
}

export type ParentToSidecarMessage =
  | SidecarInitialize
  | SidecarRequest
  | SidecarEventAck
  | SidecarShutdown
  | SidecarChunk;
export type SidecarToParentMessage = SidecarReady | SidecarResponse | SidecarEvent | SidecarChunk;

export type SidecarEventBody =
  | { type: "session-push"; payload: SessionPushPayload }
  | { type: "summary-changed"; summary: Thread }
  | {
      type: "session-materialized";
      projectId: string;
      sessionId: string;
      sessionFile: string;
    }
  | { type: "runtime-state"; state: "idle" | "busy" | "draining" }
  | { type: "resync-required"; reason: string; lastSafeSequence: number };

export interface ModelConfigurationRevision {
  generation: number;
}

export type ThreadSidecarCommand =
  | { type: "bootstrap" }
  | { type: "prompt"; input: SessionPromptInput }
  | { type: "cancel" }
  | { type: "compact" }
  | { type: "setModel"; provider: string; modelId: string }
  | { type: "setThinking"; level: SessionControlState["thinkingLevel"] }
  | { type: "rename"; title: string }
  | { type: "respondHostUi"; response: HostResponse }
  | { type: "getSummary"; archived: boolean }
  | { type: "ping" };

export interface CreationReservation {
  projectId: string;
  cwd: string;
  sessionId: string;
  createRequestId: string;
  state: "reserved" | "materialized";
  sessionFile?: string;
  workerInstanceId?: string;
  updatedAt: number;
}

export type CreationReservationRecovery =
  | { status: "active"; retryAfterMs: number }
  | { status: "committed" | "orphan" };

export interface ColdOperationLease {
  projectId: string;
  threadId: string;
  operation: "rename" | "remove" | "promote";
  nonce: string;
  expiresAt: number;
}

export type MetadataSidecarCommand =
  | { type: "listSessions"; projectId: string; cwd: string }
  | { type: "listSessionsWithPaths"; projectId: string; cwd: string }
  | {
      type: "getDraftConfig";
      projectId: string;
      cwd: string;
    }
  | { type: "resolveSession"; projectId: string; cwd: string; threadId: string }
  | { type: "upsertSession"; projectId: string; cwd: string; sessionFile: string; thread: Thread }
  | { type: "registerExternalSession"; projectId: string; cwd: string; sessionFile: string; thread: Thread }
  | {
      type: "renameColdSession";
      projectId: string;
      cwd: string;
      threadId: string;
      title: string;
      lease: ColdOperationLease;
    }
  | {
      type: "removeColdSession";
      projectId: string;
      cwd: string;
      threadId: string;
      policy: SessionRemovePolicy;
      lease: ColdOperationLease;
    }
  | {
      type: "promoteColdSession";
      projectId: string;
      cwd: string;
      threadId: string;
      lease: ColdOperationLease;
    }
  | { type: "recoverCreationReservation"; reservation: CreationReservation }
  | { type: "invalidateProject"; projectId: string }
  | { type: "ping" };

export type SidecarCommand = ThreadSidecarCommand | MetadataSidecarCommand;

export type SidecarCommandResult =
  | SessionBootstrap
  | SessionCommandResult
  | DraftSessionConfig
  | Thread
  | Thread[]
  | SessionRemoveResult
  | { path: string; id: string }
  | { pong: true }
  | null;
