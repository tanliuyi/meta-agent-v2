import { type ChildProcess, fork, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { JsonValue } from "../../shared/contracts.ts";
import {
  type ParentToSidecarMessage,
  type RuntimeCompatibility,
  SIDECAR_PROTOCOL_VERSION,
  type SidecarBinding,
  type SidecarCommand,
  type SidecarEvent,
  type SidecarInitialize,
  type SidecarReady,
  type SidecarResponse,
  type SidecarToParentMessage,
} from "../../shared/sidecar-contracts.ts";
import {
  assertRuntimeCompatibility,
  assertSidecarProtocolVersion,
  createSidecarChunks,
  MAX_SIDECAR_MESSAGE_BYTES,
  SidecarChunkAssembler,
  SidecarEventAckTracker,
  serializeSidecarError,
  toJsonValue,
} from "../../shared/sidecar-wire.ts";
import type { SubagentHostRequest, SubagentRunEvent } from "../../shared/subagent-contracts.ts";
import type { NodeRuntimeManifest } from "./node-runtime-locator.ts";

interface PendingRequest {
  resolve(value: JsonValue | undefined): void;
  reject(error: Error): void;
  commandType: SidecarCommand["type"];
  mutation: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

export class SidecarRequestError extends Error {
  readonly code?: string;
  readonly details?: JsonValue;

  constructor(message: string, name: string, code?: string, details?: JsonValue) {
    super(message);
    this.name = name;
    this.code = code;
    this.details = details;
  }
}

export interface WorkerClientOptions {
  manifest: NodeRuntimeManifest;
  binding: SidecarBinding;
  onEvent?(event: SidecarEvent): void;
  onFailure?(error: Error): void;
  onStderr?(text: string): void;
  onHostRequest?(request: SubagentHostRequest, emit: (event: SubagentRunEvent) => void): Promise<unknown>;
  startupTimeoutMs?: number;
}

export class SidecarWorkerClient {
  private readonly child: ChildProcess;
  private readonly workerInstanceId = randomUUID();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly onEvent?: (event: SidecarEvent) => void;
  private readonly expectedRuntime: RuntimeCompatibility;
  private readonly sendQueue: Array<{ message: ParentToSidecarMessage; bytes: number }> = [];
  private readonly chunkAssembler = new SidecarChunkAssembler();
  private queuedSendBytes = 0;
  private sendInFlight = false;
  private readonly onFailure?: (error: Error) => void;
  private readonly onHostRequest?: WorkerClientOptions["onHostRequest"];
  private readonly readyPromise: Promise<SidecarReady>;
  private resolveReady!: (ready: SidecarReady) => void;
  private rejectReady!: (error: Error) => void;
  private startupTimer?: ReturnType<typeof setTimeout>;
  private stderrTail = "";
  private heartbeatTimer?: NodeJS.Timeout;
  private heartbeatInFlight = false;
  private heartbeatFailures = 0;
  private terminationError?: Error;
  private forceKillTimer?: NodeJS.Timeout;
  private terminating = false;
  private closed = false;
  private readyReceived = false;
  private expectedShutdown = false;
  private expectedEventSequence = 1;
  private readonly eventAcks = new SidecarEventAckTracker();

  constructor(options: WorkerClientOptions) {
    this.onEvent = options.onEvent;
    this.expectedRuntime = options.manifest.compatibility;
    this.onFailure = options.onFailure;
    this.onHostRequest = options.onHostRequest;
    const entry = options.manifest.entries[options.binding.role];
    this.readyPromise = new Promise<SidecarReady>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.child = fork(entry, [], {
      execPath: options.manifest.nodePath,
      cwd: options.binding.role === "thread" ? options.binding.value.cwd : undefined,
      env: createSidecarEnvironment(
        options.manifest.compatibility.runtimeCompatibilityId,
        options.binding.value.agentDir,
        options.manifest.nodePath,
      ),
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      serialization: "json",
      detached: process.platform !== "win32",
    });
    this.child.stderr?.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      this.stderrTail = `${this.stderrTail}${text}`.slice(-256 * 1024);
      options.onStderr?.(text);
    });
    this.child.on("message", (message: SidecarToParentMessage) => this.handleMessage(message));
    this.child.once("error", (error) => this.terminate(error));
    const finalizeProcess = (description: string): void => {
      const suffix = this.stderrTail.trim() ? `\n${this.stderrTail.trim()}` : "";
      this.finalizeFailure(this.terminationError ?? new Error(`${description}${suffix}`));
    };
    this.child.once("exit", (code, signal) => finalizeProcess(`Sidecar exited (${code ?? signal ?? "unknown"})`));
    this.child.once("close", (code, signal) => finalizeProcess(`Sidecar closed (${code ?? signal ?? "unknown"})`));
    this.startupTimer = setTimeout(
      () => this.terminate(new Error(`Sidecar startup timed out after ${options.startupTimeoutMs ?? 15_000}ms`)),
      options.startupTimeoutMs ?? 15_000,
    );
    this.child.once("spawn", () => {
      if (this.closed || this.terminating || !this.child.connected) return;
      const initialize: SidecarInitialize = {
        kind: "initialize",
        protocolVersion: SIDECAR_PROTOCOL_VERSION,
        workerInstanceId: this.workerInstanceId,
        expectedRuntime: options.manifest.compatibility,
        binding: options.binding,
      };
      this.send(initialize);
    });
  }

  get instanceId(): string {
    return this.workerInstanceId;
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get available(): boolean {
    return !this.closed && !this.terminating;
  }

  ready(): Promise<SidecarReady> {
    return this.readyPromise;
  }

  async request<T>(command: SidecarCommand, timeoutMs: number | null = 30_000): Promise<T> {
    await this.readyPromise;
    if (this.closed || this.terminating) throw new Error("Sidecar is closed");
    if (this.pending.size >= 64) throw new Error("Sidecar request queue is full");
    const requestId = randomUUID();
    const result = new Promise<JsonValue | undefined>((resolve, reject) => {
      const pending: PendingRequest = {
        resolve,
        reject,
        commandType: command.type,
        mutation: isMutationCommand(command.type),
      };
      if (timeoutMs !== null) {
        pending.timer = setTimeout(() => {
          this.pending.delete(requestId);
          reject(
            pending.mutation
              ? unknownOutcomeError(command.type, `timed out after ${timeoutMs}ms`)
              : new SidecarRequestError(
                  `Sidecar request ${command.type} timed out after ${timeoutMs}ms`,
                  "SidecarRequestTimeoutError",
                  "SIDECAR_REQUEST_TIMEOUT",
                  { commandType: command.type },
                ),
          );
        }, timeoutMs);
      }
      this.pending.set(requestId, pending);
    });
    try {
      this.send({
        kind: "request",
        protocolVersion: SIDECAR_PROTOCOL_VERSION,
        workerInstanceId: this.workerInstanceId,
        requestId,
        command,
      });
    } catch (error) {
      const pending = this.pending.get(requestId);
      this.pending.delete(requestId);
      if (pending?.timer) clearTimeout(pending.timer);
      pending?.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return (await result) as T;
  }

  acknowledge(sequence: number): void {
    if (this.closed || this.terminating) return;
    const acknowledgement = this.eventAcks.acknowledge(sequence);
    if (!acknowledgement) return;
    this.send({
      kind: "event-ack",
      protocolVersion: SIDECAR_PROTOCOL_VERSION,
      workerInstanceId: this.workerInstanceId,
      ...acknowledgement,
    });
  }

  fail(error: Error): void {
    this.terminate(error);
  }

  async shutdown(timeoutMs = 10_000): Promise<void> {
    if (this.closed) return;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.expectedShutdown = true;
    if (!this.readyReceived && !this.terminating) {
      void this.readyPromise.catch(() => undefined);
      this.terminate(new Error("Sidecar shutdown requested during startup"));
    }
    if (this.terminating) {
      await waitForExit(this.child, timeoutMs).catch(async () => {
        killProcessTree(this.child, "SIGKILL");
        await waitForExit(this.child, 2_000);
      });
      return;
    }
    this.send({
      kind: "shutdown",
      protocolVersion: SIDECAR_PROTOCOL_VERSION,
      workerInstanceId: this.workerInstanceId,
    });
    await waitForExit(this.child, timeoutMs).catch(async () => {
      killProcessTree(this.child, "SIGTERM");
      await waitForExit(this.child, 2_000).catch(async () => {
        killProcessTree(this.child, "SIGKILL");
        await waitForExit(this.child, 2_000);
      });
    });
  }

  private handleMessage(message: SidecarToParentMessage): void {
    try {
      assertSidecarProtocolVersion(message.protocolVersion);
      if (message.kind === "chunk") {
        const assembled = this.chunkAssembler.accept(message);
        if (assembled !== undefined) this.handleMessage(assembled as SidecarToParentMessage);
        return;
      }
      if (message.workerInstanceId !== this.workerInstanceId) return;
      if (message.kind === "ready") {
        assertRuntimeCompatibility(this.expectedRuntime, message.runtime);
        this.readyReceived = true;
        if (this.startupTimer) clearTimeout(this.startupTimer);
        this.resolveReady(message);
        this.startHeartbeat();
        return;
      }
      if (message.kind === "response") {
        this.handleResponse(message);
        return;
      }
      if (message.kind === "host-call") {
        this.handleHostCall(message.requestId, message.request, this.onHostRequest);
        return;
      }
      if (message.event.type === "resync-required" && message.sequence >= this.expectedEventSequence) {
        this.eventAcks.resetThrough(message.sequence - 1);
        this.expectedEventSequence = message.sequence;
      }
      if (message.sequence !== this.expectedEventSequence) {
        throw new Error(`Sidecar event sequence gap: expected ${this.expectedEventSequence}, got ${message.sequence}`);
      }
      this.expectedEventSequence += 1;
      if (
        !Number.isSafeInteger(message.creditCost) ||
        message.creditCost < 0 ||
        (message.event.type !== "resync-required" && message.creditCost < 1)
      ) {
        throw new Error(`Invalid sidecar event credit cost: ${message.creditCost}`);
      }
      this.eventAcks.receive(message.sequence, message.creditCost);
      this.onEvent?.(message);
    } catch (error) {
      this.terminate(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private handleHostCall(
    requestId: string,
    request: SubagentHostRequest,
    handler: WorkerClientOptions["onHostRequest"],
  ): void {
    if (!handler) {
      this.send({
        kind: "host-response",
        protocolVersion: SIDECAR_PROTOCOL_VERSION,
        workerInstanceId: this.workerInstanceId,
        requestId,
        ok: false,
        error: serializeSidecarError(new Error(`Unsupported sidecar host request: ${request.type}`)),
      });
      return;
    }
    const emit = (event: SubagentRunEvent): void => {
      this.send({
        kind: "host-event",
        protocolVersion: SIDECAR_PROTOCOL_VERSION,
        workerInstanceId: this.workerInstanceId,
        requestId,
        event,
      });
    };
    void handler(request, emit)
      .then(
        (result) =>
          this.send({
            kind: "host-response",
            protocolVersion: SIDECAR_PROTOCOL_VERSION,
            workerInstanceId: this.workerInstanceId,
            requestId,
            ok: true,
            result: result === undefined ? undefined : toJsonValue(result),
          }),
        (error: unknown) =>
          this.send({
            kind: "host-response",
            protocolVersion: SIDECAR_PROTOCOL_VERSION,
            workerInstanceId: this.workerInstanceId,
            requestId,
            ok: false,
            error: serializeSidecarError(error),
          }),
      )
      .catch((error: unknown) => {
        if (this.closed || this.terminating) return;
        this.terminate(error instanceof Error ? error : new Error(String(error)));
      });
  }

  private handleResponse(message: SidecarResponse): void {
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    this.pending.delete(message.requestId);
    if (pending.timer) clearTimeout(pending.timer);
    if (message.ok) pending.resolve(message.result);
    else {
      pending.reject(
        new SidecarRequestError(message.error.message, message.error.name, message.error.code, message.error.details),
      );
    }
  }

  private send(message: ParentToSidecarMessage): void {
    if (!this.child.connected || this.closed || this.terminating) {
      throw new Error("Sidecar IPC channel is disconnected");
    }
    if (message.kind !== "chunk") {
      const chunks = createSidecarChunks(message, this.workerInstanceId, "control");
      if (chunks) {
        for (const chunk of chunks) this.enqueueSend(chunk);
        return;
      }
    }
    this.enqueueSend(message);
  }

  private enqueueSend(message: ParentToSidecarMessage): void {
    const bytes = Buffer.byteLength(JSON.stringify(message));
    if (bytes > MAX_SIDECAR_MESSAGE_BYTES)
      throw new Error(`Sidecar message exceeds ${MAX_SIDECAR_MESSAGE_BYTES} bytes`);
    if (this.sendQueue.length >= 160 || this.queuedSendBytes + bytes > 96 * 1024 * 1024) {
      const error = new Error("Sidecar control send queue exceeded its bounded capacity");
      this.terminate(error);
      throw error;
    }
    this.sendQueue.push({ message, bytes });
    this.queuedSendBytes += bytes;
    this.pumpSendQueue();
  }

  private pumpSendQueue(): void {
    if (this.sendInFlight || this.closed || this.terminating) return;
    const next = this.sendQueue.shift();
    if (!next) return;
    this.queuedSendBytes -= next.bytes;
    this.sendInFlight = true;
    this.child.send(next.message, undefined, undefined, (error) => {
      this.sendInFlight = false;
      if (error) this.terminate(error);
      else this.pumpSendQueue();
    });
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      if (this.closed || this.heartbeatInFlight) return;
      this.heartbeatInFlight = true;
      void this.request({ type: "ping" }, 5_000)
        .then(
          () => {
            this.heartbeatFailures = 0;
          },
          (error: unknown) => {
            this.heartbeatFailures += 1;
            if (this.heartbeatFailures >= 3) {
              this.terminate(error instanceof Error ? error : new Error(`Sidecar heartbeat failed: ${String(error)}`));
            }
          },
        )
        .finally(() => {
          this.heartbeatInFlight = false;
        });
    }, 15_000);
    this.heartbeatTimer.unref();
  }

  private terminate(error: Error): void {
    if (this.closed || this.terminating) return;
    this.terminating = true;
    this.terminationError = error;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.startupTimer) clearTimeout(this.startupTimer);
    this.rejectPending(error, false, true);
    killProcessTree(this.child, "SIGTERM");
    this.forceKillTimer = setTimeout(() => killProcessTree(this.child, "SIGKILL"), 2_000);
    this.forceKillTimer.unref();
  }

  private finalizeFailure(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.forceKillTimer) clearTimeout(this.forceKillTimer);
    this.rejectPending(error, true, !this.expectedShutdown);
    if (!this.expectedShutdown) this.onFailure?.(error);
  }

  private rejectPending(error: Error, rejectReady: boolean, unknownOutcome: boolean): void {
    if (rejectReady) this.rejectReady(error);
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(
        unknownOutcome && pending.mutation ? unknownOutcomeError(pending.commandType, error.message) : error,
      );
    }
    this.pending.clear();
  }
}

function isMutationCommand(commandType: SidecarCommand["type"]): boolean {
  return ![
    "ping",
    "bootstrap",
    "getSummary",
    "listSessions",
    "resolveSession",
    "getDraftConfig",
    "prepareProjection",
    "garbageCollectProjections",
    "recoverCreationReservation",
    "invalidateProject",
  ].includes(commandType);
}

function unknownOutcomeError(commandType: SidecarCommand["type"], reason: string): SidecarRequestError {
  return new SidecarRequestError(
    `Sidecar mutation ${commandType} has an unknown outcome: ${reason}`,
    "SidecarUnknownOutcomeError",
    "SIDECAR_MUTATION_UNKNOWN_OUTCOME",
    { commandType },
  );
}

function killProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.unref();
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

export function createSidecarEnvironment(
  runtimeCompatibilityId: string,
  agentDir: string,
  nodeExecPath: string,
  sourceEnvironment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const allowed = Object.fromEntries(
    Object.entries(sourceEnvironment).filter(
      ([name]) => isAllowedSidecarEnvironmentVariable(name) && !isReservedDesktopRuntimeVariable(name),
    ),
  );
  return {
    ...allowed,
    PI_CODING_AGENT_DIR: agentDir,
    PI_DESKTOP_RUNTIME_COMPATIBILITY_ID: runtimeCompatibilityId,
    PI_DESKTOP_NODE_EXEC_PATH: nodeExecPath,
  };
}

function isReservedDesktopRuntimeVariable(name: string): boolean {
  const normalized = name.toUpperCase();
  return normalized.startsWith("PI_DESKTOP_") || normalized.startsWith("PI_SUBAGENT_");
}

function isAllowedSidecarEnvironmentVariable(name: string): boolean {
  if (
    [
      "HOME",
      "USERPROFILE",
      "PATH",
      "SystemRoot",
      "TMPDIR",
      "TMP",
      "TEMP",
      "LANG",
      "TZ",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "NO_PROXY",
      "SSL_CERT_FILE",
      "SSL_CERT_DIR",
      "NODE_EXTRA_CA_CERTS",
    ].includes(name)
  ) {
    return true;
  }
  if (name.startsWith("LC_") || name.startsWith("PI_")) return true;
  return (
    name.endsWith("_API_KEY") ||
    name.endsWith("_ACCESS_TOKEN") ||
    name.startsWith("AWS_") ||
    name.startsWith("AZURE_") ||
    name.startsWith("GOOGLE_") ||
    name.startsWith("ANTHROPIC_") ||
    name.startsWith("OPENAI_")
  );
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Sidecar did not exit after ${timeoutMs}ms`));
    }, timeoutMs);
    const onExit = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("close", onExit);
    };
    child.once("exit", onExit);
    child.once("close", onExit);
  });
}
