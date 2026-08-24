import { type ChildProcess, fork, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { JsonValue } from "../../shared/contracts.ts";
import {
  type ParentToSidecarMessage,
  SIDECAR_PROTOCOL_VERSION,
  type SidecarCommand,
  type SidecarInitialize,
  type SidecarReady,
  type SidecarResponse,
  type SidecarToParentMessage,
} from "../../shared/sidecar-contracts.ts";
import {
  assertRuntimeCompatibility,
  assertSidecarProtocolVersion,
  MAX_SIDECAR_MESSAGE_BYTES,
  prepareSidecarMessage,
  SidecarChunkAssembler,
  SidecarEventAckTracker,
} from "../../shared/sidecar-wire.ts";
import type { SidecarRuntimeManifest } from "./sidecar-runtime-manifest.ts";
import {
  createSidecarEnvironment,
  DEFAULT_SIDECAR_STARTUP_TIMEOUT_MS,
  resolveSidecarExecutable,
  SidecarRequestError,
  type WorkerClientOptions,
} from "./worker-client.ts";

interface PendingRequest {
  resolve(value: JsonValue | undefined): void;
  reject(error: Error): void;
  commandType: SidecarCommand["type"];
  mutation: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

interface ChannelSendUsage {
  items: number;
  bytes: number;
}

export interface SharedThreadSidecarProcessOptions {
  manifest: SidecarRuntimeManifest;
  agentDir: string;
  onStderr?(text: string): void;
}

export class SharedThreadSidecarProcess {
  private readonly child: ChildProcess;
  private readonly hostInstanceId = randomUUID();
  private readonly channels = new Map<string, SharedThreadWorkerClient>();
  private readonly sendQueue: Array<{ message: ParentToSidecarMessage; bytes: number }> = [];
  private readonly sendQueueUsage = new Map<string, ChannelSendUsage>();
  private readonly chunkAssemblers = new Map<string, SidecarChunkAssembler>();
  private sendInFlight = false;
  private spawned = false;
  private terminating = false;
  private closed = false;
  private stderrTail = "";
  private forceKillTimer?: NodeJS.Timeout;

  constructor(options: SharedThreadSidecarProcessOptions) {
    this.child = fork(options.manifest.entries.thread, [], {
      execPath: resolveSidecarExecutable(),
      env: createSidecarEnvironment(options.manifest.compatibility.runtimeCompatibilityId, options.agentDir),
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
    this.child.once("error", (error) => this.fail(error));
    const finalize = (description: string): void => {
      const stderr = this.stderrTail.trim();
      this.finalize(new Error(stderr ? `${description}\n${stderr}` : description));
    };
    this.child.once("exit", (code, signal) =>
      finalize(`Shared thread sidecar exited (${code ?? signal ?? "unknown"})`),
    );
    this.child.once("close", (code, signal) =>
      finalize(`Shared thread sidecar closed (${code ?? signal ?? "unknown"})`),
    );
    this.child.once("spawn", () => {
      this.spawned = true;
      for (const channel of this.channels.values()) channel.initialize();
    });
  }

  get available(): boolean {
    return !this.closed && !this.terminating;
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  open(options: WorkerClientOptions): SharedThreadWorkerClient {
    if (!this.available) throw new Error("Shared thread sidecar is unavailable");
    if (options.binding.role !== "thread") throw new Error("Shared thread sidecar only accepts thread bindings");
    const binding = {
      role: "thread" as const,
      value: {
        ...options.binding.value,
        ...(options.browserSessionToken !== undefined ? { browserSessionToken: options.browserSessionToken } : {}),
      },
    };
    const channel = new SharedThreadWorkerClient(this, {
      ...options,
      binding,
    });
    this.channels.set(channel.instanceId, channel);
    if (this.spawned) channel.initialize();
    return channel;
  }

  send(message: ParentToSidecarMessage): void {
    if (!this.child.connected || this.closed || this.terminating) {
      throw new Error("Shared thread sidecar IPC channel is disconnected");
    }
    if (message.kind !== "chunk") {
      const workerInstanceId = "workerInstanceId" in message ? message.workerInstanceId : this.hostInstanceId;
      const prepared = prepareSidecarMessage(message, workerInstanceId, "control");
      if (prepared.chunks) {
        for (const chunk of prepared.chunks) this.enqueue(chunk);
        return;
      }
      this.enqueue(message, prepared.byteLength);
      return;
    }
    this.enqueue(message);
  }

  channelClosed(channel: SharedThreadWorkerClient): void {
    if (this.channels.get(channel.instanceId) !== channel) return;
    this.channels.delete(channel.instanceId);
    this.chunkAssemblers.delete(channel.instanceId);
    this.discardQueuedMessages(channel.instanceId);
    if (this.channels.size === 0) this.shutdownHost();
  }

  failChannel(channel: SharedThreadWorkerClient, error: Error): void {
    if (this.channels.get(channel.instanceId) !== channel) return;
    try {
      this.sendRaw({
        kind: "shutdown",
        protocolVersion: SIDECAR_PROTOCOL_VERSION,
        workerInstanceId: channel.instanceId,
      });
    } catch (sendError) {
      this.fail(sendError instanceof Error ? sendError : new Error(String(sendError)));
      return;
    }
    channel.hostFailed(error);
  }

  fail(error: Error): void {
    if (this.closed || this.terminating) return;
    this.terminating = true;
    for (const channel of this.channels.values()) channel.hostFailed(error);
    this.kill("SIGTERM");
    this.forceKillTimer = setTimeout(() => this.kill("SIGKILL"), 2_000);
    this.forceKillTimer.unref();
  }

  private handleMessage(message: SidecarToParentMessage): void {
    try {
      assertSidecarProtocolVersion(message.protocolVersion);
      if (message.kind === "chunk") {
        const channel = this.channels.get(message.workerInstanceId);
        if (!channel) throw new Error(`Unknown shared thread sidecar channel: ${message.workerInstanceId}`);
        let assembler = this.chunkAssemblers.get(message.workerInstanceId);
        if (!assembler) {
          assembler = new SidecarChunkAssembler();
          this.chunkAssemblers.set(message.workerInstanceId, assembler);
        }
        const assembled = assembler.accept(message);
        if (assembled !== undefined) this.handleMessage(assembled as SidecarToParentMessage);
        return;
      }
      this.channels.get(message.workerInstanceId)?.handleMessage(message);
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      const channel = this.channels.get(message.workerInstanceId);
      if (channel) this.failChannel(channel, normalized);
      else this.fail(normalized);
    }
  }

  private enqueue(message: ParentToSidecarMessage, preparedBytes?: number): void {
    const bytes = preparedBytes ?? Buffer.byteLength(JSON.stringify(message));
    if (bytes > MAX_SIDECAR_MESSAGE_BYTES)
      throw new Error(`Sidecar message exceeds ${MAX_SIDECAR_MESSAGE_BYTES} bytes`);
    const workerInstanceId = "workerInstanceId" in message ? message.workerInstanceId : this.hostInstanceId;
    const usage = this.sendQueueUsage.get(workerInstanceId) ?? { items: 0, bytes: 0 };
    if (usage.items >= 160 || usage.bytes + bytes > 96 * 1024 * 1024) {
      const error = new Error(`Shared thread sidecar send queue exceeded its bounded capacity for ${workerInstanceId}`);
      this.discardQueuedMessages(workerInstanceId);
      const channel = this.channels.get(workerInstanceId);
      if (channel) this.failChannel(channel, error);
      else this.fail(error);
      throw error;
    }
    this.sendQueue.push({ message, bytes });
    usage.items += 1;
    usage.bytes += bytes;
    this.sendQueueUsage.set(workerInstanceId, usage);
    this.pump();
  }

  private discardQueuedMessages(workerInstanceId: string): void {
    for (let index = this.sendQueue.length - 1; index >= 0; index -= 1) {
      const queued = this.sendQueue[index];
      if (!queued || !("workerInstanceId" in queued.message) || queued.message.workerInstanceId !== workerInstanceId) {
        continue;
      }
      this.removeQueuedMessageUsage(queued.message, queued.bytes);
      this.sendQueue.splice(index, 1);
    }
  }

  private removeQueuedMessageUsage(message: ParentToSidecarMessage, bytes: number): void {
    const workerInstanceId = "workerInstanceId" in message ? message.workerInstanceId : this.hostInstanceId;
    const usage = this.sendQueueUsage.get(workerInstanceId);
    if (!usage) return;
    usage.items = Math.max(0, usage.items - 1);
    usage.bytes = Math.max(0, usage.bytes - bytes);
    if (usage.items === 0) this.sendQueueUsage.delete(workerInstanceId);
  }

  private pump(): void {
    if (this.sendInFlight || this.closed || this.terminating) return;
    const next = this.sendQueue.shift();
    if (!next) return;
    this.removeQueuedMessageUsage(next.message, next.bytes);
    this.sendInFlight = true;
    this.child.send(next.message, undefined, undefined, (error) => {
      this.sendInFlight = false;
      if (error) this.fail(error);
      else this.pump();
    });
  }

  private shutdownHost(): void {
    if (this.closed || this.terminating) return;
    this.terminating = true;
    try {
      this.sendRaw({ kind: "host-shutdown", protocolVersion: SIDECAR_PROTOCOL_VERSION });
      this.forceKillTimer = setTimeout(() => this.kill("SIGKILL"), 2_000);
      this.forceKillTimer.unref();
    } catch (error) {
      this.terminating = false;
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private sendRaw(message: ParentToSidecarMessage): void {
    if (!this.child.connected || this.closed) throw new Error("Shared thread sidecar is disconnected");
    this.child.send(message);
  }

  private finalize(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.terminating = true;
    if (this.forceKillTimer) clearTimeout(this.forceKillTimer);
    for (const channel of this.channels.values()) channel.hostFailed(error);
    this.channels.clear();
    this.chunkAssemblers.clear();
    this.sendQueue.length = 0;
    this.sendQueueUsage.clear();
  }

  private kill(signal: NodeJS.Signals): void {
    if (!this.child.pid) return;
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/pid", String(this.child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.once("error", () => undefined);
      killer.unref();
      return;
    }
    try {
      process.kill(-this.child.pid, signal);
    } catch {
      this.child.kill(signal);
    }
  }
}

export class SharedThreadWorkerClient {
  private readonly process: SharedThreadSidecarProcess;
  private readonly options: WorkerClientOptions;
  private readonly workerInstanceId = randomUUID();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly readyPromise: Promise<SidecarReady>;
  private resolveReady!: (ready: SidecarReady) => void;
  private rejectReady!: (error: Error) => void;
  private readonly eventAcks = new SidecarEventAckTracker();
  private expectedEventSequence = 1;
  private startupTimer?: ReturnType<typeof setTimeout>;
  private heartbeatTimer?: NodeJS.Timeout;
  private heartbeatInFlight = false;
  private heartbeatFailures = 0;
  private initialized = false;
  private readyReceived = false;
  private expectedShutdown = false;
  private closed = false;
  private closeResolve!: () => void;
  private closeReject!: (error: Error) => void;
  private readonly closePromise: Promise<void>;

  constructor(process: SharedThreadSidecarProcess, options: WorkerClientOptions) {
    this.process = process;
    this.options = options;
    this.readyPromise = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.closePromise = new Promise((resolve, reject) => {
      this.closeResolve = resolve;
      this.closeReject = reject;
    });
    void this.closePromise.catch(() => undefined);
    const startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_SIDECAR_STARTUP_TIMEOUT_MS;
    this.startupTimer = setTimeout(
      () => this.hostFailed(new Error(`Thread sidecar channel startup timed out after ${startupTimeoutMs}ms`)),
      startupTimeoutMs,
    );
  }

  get instanceId(): string {
    return this.workerInstanceId;
  }

  get pid(): number | undefined {
    return this.process.pid;
  }

  get available(): boolean {
    return !this.closed && this.process.available;
  }

  ready(): Promise<SidecarReady> {
    return this.readyPromise;
  }

  initialize(): void {
    if (this.initialized || this.closed) return;
    this.initialized = true;
    const initialize: SidecarInitialize = {
      kind: "initialize",
      protocolVersion: SIDECAR_PROTOCOL_VERSION,
      workerInstanceId: this.workerInstanceId,
      expectedRuntime: this.options.manifest.compatibility,
      binding: this.options.binding,
    };
    try {
      this.process.send(initialize);
    } catch (error) {
      this.hostFailed(error instanceof Error ? error : new Error(String(error)));
    }
  }

  async request<T>(command: SidecarCommand, timeoutMs: number | null = 30_000): Promise<T> {
    await this.readyPromise;
    if (this.closed) throw new Error("Thread sidecar channel is closed");
    if (this.pending.size >= 64) throw new Error("Thread sidecar request queue is full");
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
      this.process.send({
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
    if (this.closed) return;
    const acknowledgement = this.eventAcks.acknowledge(sequence);
    if (!acknowledgement) return;
    this.process.send({
      kind: "event-ack",
      protocolVersion: SIDECAR_PROTOCOL_VERSION,
      workerInstanceId: this.workerInstanceId,
      ...acknowledgement,
    });
  }

  async shutdown(timeoutMs = 10_000): Promise<void> {
    if (this.closed) return this.closePromise;
    this.expectedShutdown = true;
    if (!this.readyReceived) void this.readyPromise.catch(() => undefined);
    try {
      this.process.send({
        kind: "shutdown",
        protocolVersion: SIDECAR_PROTOCOL_VERSION,
        workerInstanceId: this.workerInstanceId,
      });
    } catch (error) {
      this.hostFailed(error instanceof Error ? error : new Error(String(error)));
    }
    await withTimeout(this.closePromise, timeoutMs, "Thread sidecar channel did not close").catch((error) => {
      this.process.fail(error);
      throw error;
    });
  }

  handleMessage(message: Exclude<SidecarToParentMessage, { kind: "chunk" }>): void {
    try {
      if (message.kind === "ready") {
        assertRuntimeCompatibility(this.options.manifest.compatibility, message.runtime);
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
      if (message.kind === "closed") {
        const error = message.error
          ? new SidecarRequestError(
              message.error.message,
              message.error.name,
              message.error.code,
              message.error.details,
            )
          : undefined;
        this.finish(error);
        return;
      }
      if (message.event.type === "resync-required" && message.sequence >= this.expectedEventSequence) {
        this.eventAcks.resetThrough(message.sequence - 1);
        this.expectedEventSequence = message.sequence;
      }
      if (message.sequence !== this.expectedEventSequence) {
        throw new Error(
          `Thread sidecar event sequence gap: expected ${this.expectedEventSequence}, got ${message.sequence}`,
        );
      }
      this.expectedEventSequence += 1;
      if (
        !Number.isSafeInteger(message.creditCost) ||
        message.creditCost < 0 ||
        (message.event.type !== "resync-required" && message.creditCost < 1)
      ) {
        throw new Error(`Invalid thread sidecar event credit cost: ${message.creditCost}`);
      }
      this.eventAcks.receive(message.sequence, message.creditCost);
      this.options.onEvent?.(message);
    } catch (error) {
      this.process.failChannel(this, error instanceof Error ? error : new Error(String(error)));
    }
  }

  hostFailed(error: Error): void {
    this.finish(error);
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
              this.process.failChannel(this, error instanceof Error ? error : new Error(String(error)));
            }
          },
        )
        .finally(() => {
          this.heartbeatInFlight = false;
        });
    }, 15_000);
    this.heartbeatTimer.unref();
  }

  private finish(error?: Error): void {
    if (this.closed) return;
    this.closed = true;
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (!this.readyReceived) this.rejectReady(error ?? new Error("Thread sidecar channel closed during startup"));
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(
        error && pending.mutation
          ? unknownOutcomeError(pending.commandType, error.message)
          : (error ?? new Error("Thread sidecar channel closed")),
      );
    }
    this.pending.clear();
    if (error) this.closeReject(error);
    else this.closeResolve();
    this.process.channelClosed(this);
    if (error && !this.expectedShutdown) this.options.onFailure?.(error);
  }
}

function isMutationCommand(commandType: SidecarCommand["type"]): boolean {
  return ![
    "ping",
    "bootstrap",
    "getSummary",
    "listSessions",
    "listSessionsWithPaths",
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

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
