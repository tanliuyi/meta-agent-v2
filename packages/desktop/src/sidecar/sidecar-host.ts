import { spawn } from "node:child_process";
import {
  type ParentToSidecarMessage,
  type RuntimeCompatibility,
  SIDECAR_PROTOCOL_VERSION,
  type SidecarBinding,
  type SidecarCommand,
  type SidecarEventBody,
  type SidecarInitialize,
  type SidecarToParentMessage,
} from "../shared/sidecar-contracts.ts";
import {
  assertRuntimeCompatibility,
  assertSidecarProtocolVersion,
  createSidecarChunks,
  MAX_SIDECAR_MESSAGE_BYTES,
  MAX_SIDECAR_TRANSFER_BYTES,
  SidecarChunkAssembler,
  serializeSidecarError,
  toJsonValue,
} from "../shared/sidecar-wire.ts";

export interface SidecarService {
  command(command: SidecarCommand): Promise<unknown>;
  dispose(): Promise<void>;
}

export interface SidecarServiceContext {
  emit(event: SidecarEventBody): void;
}

export type SidecarServiceFactory = (
  binding: SidecarBinding,
  context: SidecarServiceContext,
) => Promise<{ service: SidecarService; readyResult?: unknown }>;

const INITIAL_EVENT_CREDIT = 128;
const MAX_BUFFERED_EVENTS = 512;
const MAX_BUFFERED_EVENT_BYTES = 16 * 1024 * 1024;
const REENTRANT_CONTROL_COMMANDS = new Set<SidecarCommand["type"]>([
  "bootstrap",
  "ping",
  "rename",
  "getSummary",
  "cancel",
  "clearQueue",
  "setThinking",
  "respondHostUi",
]);

export function createSidecarCommandScheduler(): (
  commandType: SidecarCommand["type"],
  execute: () => Promise<void>,
) => Promise<void> {
  let commandTail = Promise.resolve();
  let runningPrompts = 0;
  return async (commandType, execute) => {
    if (REENTRANT_CONTROL_COMMANDS.has(commandType)) {
      await execute();
      return;
    }
    if (commandType === "prompt" && runningPrompts > 0) {
      await execute();
      return;
    }
    const scheduled = commandTail.then(async () => {
      if (commandType === "prompt") runningPrompts += 1;
      try {
        await execute();
      } finally {
        if (commandType === "prompt") runningPrompts -= 1;
      }
    });
    commandTail = scheduled.catch(() => undefined);
    await scheduled;
  };
}

export function runSidecarHost(runtime: RuntimeCompatibility, createService: SidecarServiceFactory): void {
  let workerInstanceId: string | undefined;
  let service: SidecarService | undefined;
  let eventSequence = 0;
  let eventCredit = 0;
  let lastAcknowledgedEventSequence = 0;
  const outstandingEventCredits = new Map<number, number>();
  let bufferedEventBytes = 0;
  let resyncPending = false;
  const bufferedEvents: Array<{ event: SidecarEventBody; bytes: number; creditCost: number }> = [];
  const scheduleCommand = createSidecarCommandScheduler();
  const controlSendQueue: Array<{ message: SidecarToParentMessage; bytes: number }> = [];
  const eventSendQueue: Array<{ message: SidecarToParentMessage; bytes: number }> = [];
  const chunkAssembler = new SidecarChunkAssembler();
  let queuedControlBytes = 0;
  let queuedEventBytes = 0;
  let sendInFlight = false;
  let closing = false;
  let initializationStarted = false;

  const pumpSendQueue = (): void => {
    if (sendInFlight || closing || !process.connected || !process.send) return;
    const control = controlSendQueue.shift();
    const next = control ?? eventSendQueue.shift();
    if (!next) return;
    if (control) queuedControlBytes -= next.bytes;
    else queuedEventBytes -= next.bytes;
    sendInFlight = true;
    process.send(next.message, undefined, undefined, (error) => {
      sendInFlight = false;
      if (error && !closing) {
        process.stderr.write(`Sidecar IPC send failed: ${error.message}\n`);
        void shutdown();
      } else {
        pumpSendQueue();
      }
    });
  };

  const send = (message: SidecarToParentMessage): void => {
    if (!process.connected || !process.send || closing) return;
    if (message.kind !== "chunk") {
      const chunks = createSidecarChunks(
        message,
        workerInstanceId ?? message.workerInstanceId,
        message.kind === "event" && message.event.type !== "resync-required" ? "event" : "control",
      );
      if (chunks) {
        for (const chunk of chunks) enqueueSend(chunk);
        return;
      }
    }
    enqueueSend(message);
  };

  const enqueueSend = (message: SidecarToParentMessage): void => {
    const bytes = Buffer.byteLength(JSON.stringify(message));
    if (bytes > MAX_SIDECAR_MESSAGE_BYTES) {
      process.stderr.write(`Sidecar message exceeds ${MAX_SIDECAR_MESSAGE_BYTES} bytes\n`);
      void shutdown();
      return;
    }
    const eventLane =
      (message.kind === "event" && message.event.type !== "resync-required") ||
      (message.kind === "chunk" && message.lane === "event");
    const queue = eventLane ? eventSendQueue : controlSendQueue;
    const queuedBytes = eventLane ? queuedEventBytes : queuedControlBytes;
    const maxItems = eventLane ? 160 : 160;
    if (queue.length >= maxItems || queuedBytes + bytes > 96 * 1024 * 1024) {
      process.stderr.write(`Sidecar ${eventLane ? "event" : "control"} send queue exceeded its bounded capacity\n`);
      void shutdown();
      return;
    }
    queue.push({ message, bytes });
    if (eventLane) queuedEventBytes += bytes;
    else queuedControlBytes += bytes;
    pumpSendQueue();
  };

  const sendEvent = (event: SidecarEventBody, creditCost: number, consumeCredit = true): void => {
    if (!workerInstanceId) return;
    if (consumeCredit) eventCredit -= creditCost;
    eventSequence += 1;
    outstandingEventCredits.set(eventSequence, creditCost);
    send({
      kind: "event",
      protocolVersion: SIDECAR_PROTOCOL_VERSION,
      workerInstanceId,
      sequence: eventSequence,
      creditCost,
      event,
    });
  };

  const drainEvents = (): void => {
    while (bufferedEvents.length > 0) {
      const next = bufferedEvents[0];
      if (!next || eventCredit < next.creditCost) return;
      bufferedEvents.shift();
      bufferedEventBytes -= next.bytes;
      sendEvent(next.event, next.creditCost);
    }
  };

  const emit = (event: SidecarEventBody): void => {
    if (!workerInstanceId || closing || resyncPending) return;
    const bytes = Buffer.byteLength(JSON.stringify(event));
    const creditCost = Math.max(1, Math.ceil(bytes / (1024 * 1024)));
    if (eventCredit >= creditCost && bufferedEvents.length === 0) {
      sendEvent(event, creditCost);
      return;
    }
    if (bufferedEvents.length >= MAX_BUFFERED_EVENTS || bufferedEventBytes + bytes > MAX_BUFFERED_EVENT_BYTES) {
      process.stderr.write(
        `Sidecar event buffer overflow: bufferedEvents=${bufferedEvents.length}, bufferedBytes=${bufferedEventBytes}, outstandingEvents=${outstandingEventCredits.size}, eventCredit=${eventCredit}\n`,
      );
      const lastSafeSequence = lastAcknowledgedEventSequence;
      bufferedEvents.length = 0;
      bufferedEventBytes = 0;
      eventSendQueue.length = 0;
      queuedEventBytes = 0;
      outstandingEventCredits.clear();
      eventCredit = INITIAL_EVENT_CREDIT;
      lastAcknowledgedEventSequence = eventSequence;
      resyncPending = true;
      sendEvent(
        {
          type: "resync-required",
          reason: "event-buffer-overflow",
          lastSafeSequence,
        },
        0,
        false,
      );
      return;
    }
    bufferedEvents.push({ event, bytes, creditCost });
    bufferedEventBytes += bytes;
  };

  const shutdown = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    try {
      await service?.dispose();
    } finally {
      if (process.platform === "win32") {
        const killer = spawn("taskkill", ["/pid", String(process.pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
          detached: true,
        });
        killer.unref();
      } else {
        process.disconnect?.();
        process.exitCode = 0;
      }
    }
  };

  const initialize = async (message: SidecarInitialize): Promise<void> => {
    if (initializationStarted || workerInstanceId) throw new Error("Sidecar already initialized");
    initializationStarted = true;
    if (!isSupportedRole(message.binding.role))
      throw new Error(`Unsupported sidecar role: ${String(message.binding.role)}`);
    assertSidecarProtocolVersion(message.protocolVersion);
    assertRuntimeCompatibility(message.expectedRuntime, runtime);
    workerInstanceId = message.workerInstanceId;
    eventCredit = INITIAL_EVENT_CREDIT;
    const created = await createService(message.binding, { emit });
    service = created.service;
    send({
      kind: "ready",
      protocolVersion: SIDECAR_PROTOCOL_VERSION,
      workerInstanceId,
      role: message.binding.role,
      runtime,
      result:
        created.readyResult === undefined ? undefined : toJsonValue(created.readyResult, MAX_SIDECAR_TRANSFER_BYTES),
    });
  };

  const handleMessage = (raw: ParentToSidecarMessage): void => {
    void (async () => {
      assertSidecarProtocolVersion(raw.protocolVersion);
      if (raw.kind === "chunk") {
        const assembled = chunkAssembler.accept(raw);
        if (assembled !== undefined) handleMessage(assembled as ParentToSidecarMessage);
        return;
      }
      if (raw.kind === "initialize") {
        await initialize(raw);
        return;
      }
      if (!workerInstanceId || raw.workerInstanceId !== workerInstanceId) return;
      if (raw.kind === "event-ack") {
        if (!Number.isSafeInteger(raw.throughSequence) || !Number.isSafeInteger(raw.credit) || raw.credit < 0) {
          throw new Error("Invalid sidecar event acknowledgement");
        }
        if (raw.throughSequence <= lastAcknowledgedEventSequence) return;
        if (raw.throughSequence > eventSequence) throw new Error("Invalid sidecar event acknowledgement");
        let acknowledgedCredit = 0;
        for (let sequence = lastAcknowledgedEventSequence + 1; sequence <= raw.throughSequence; sequence += 1) {
          const creditCost = outstandingEventCredits.get(sequence);
          if (creditCost === undefined) throw new Error(`Unknown sidecar event acknowledgement sequence: ${sequence}`);
          acknowledgedCredit += creditCost;
        }
        if (raw.credit !== acknowledgedCredit) throw new Error("Sidecar event acknowledgement credit mismatch");
        for (let sequence = lastAcknowledgedEventSequence + 1; sequence <= raw.throughSequence; sequence += 1) {
          outstandingEventCredits.delete(sequence);
        }
        lastAcknowledgedEventSequence = raw.throughSequence;
        eventCredit = Math.min(INITIAL_EVENT_CREDIT, eventCredit + acknowledgedCredit);
        drainEvents();
        return;
      }
      if (raw.kind === "shutdown") {
        await shutdown();
        return;
      }
      if (!service) throw new Error("Sidecar is not ready");
      const execute = async (): Promise<void> => {
        try {
          const result = await service!.command(raw.command);
          send({
            kind: "response",
            protocolVersion: SIDECAR_PROTOCOL_VERSION,
            workerInstanceId: workerInstanceId!,
            requestId: raw.requestId,
            ok: true,
            result: result === undefined ? undefined : toJsonValue(result, MAX_SIDECAR_TRANSFER_BYTES),
          });
          if (raw.command.type === "bootstrap") resyncPending = false;
        } catch (error) {
          process.stderr.write(
            `Sidecar command ${raw.command.type} failed:\n${
              error instanceof Error ? (error.stack ?? error.message) : String(error)
            }\n`,
          );
          send({
            kind: "response",
            protocolVersion: SIDECAR_PROTOCOL_VERSION,
            workerInstanceId: workerInstanceId!,
            requestId: raw.requestId,
            ok: false,
            error: serializeSidecarError(error),
          });
        }
      };
      await scheduleCommand(raw.command.type, execute);
    })().catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
      void shutdown();
    });
  };

  process.on("message", handleMessage);
  process.once("disconnect", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
}

function isSupportedRole(role: unknown): role is SidecarBinding["role"] {
  return role === "thread" || role === "metadata";
}
