import { spawn } from "node:child_process";
import electron from "electron";
import {
  type ParentToSidecarMessage,
  type RuntimeCompatibility,
  SIDECAR_PROTOCOL_VERSION,
  type SidecarCommand,
  type SidecarEvent,
  type SidecarEventBody,
  type SidecarInitialize,
  type SidecarToParentMessage,
} from "../shared/sidecar-contracts.ts";
import {
  assertRuntimeCompatibility,
  assertSidecarProtocolVersion,
  MAX_SIDECAR_MESSAGE_BYTES,
  MAX_SIDECAR_TRANSFER_BYTES,
  prepareSidecarMessage,
  SidecarChunkAssembler,
  serializeSidecarError,
  sidecarEventMessageByteLength,
  toJsonValue,
} from "../shared/sidecar-wire.ts";
import {
  createSidecarCommandScheduler,
  type SidecarService,
  type SidecarServiceContext,
  type SidecarServiceFactory,
} from "./sidecar-host.ts";
import { ThreadWorkerService } from "./thread-worker-service.ts";

const INITIAL_EVENT_CREDIT = 128;
const MAX_BUFFERED_EVENTS = 512;
const MAX_BUFFERED_EVENT_BYTES = 16 * 1024 * 1024;
const MAX_SEND_QUEUE_ITEMS_PER_CHANNEL = 160;
const MAX_SEND_QUEUE_BYTES_PER_CHANNEL = 96 * 1024 * 1024;

export interface QueuedSidecarMessage {
  message: SidecarToParentMessage;
  bytes: number;
}

/** Selects channels round-robin while preserving control-before-event priority within one channel. */
export function dequeueFairChannelMessage(
  controlQueue: QueuedSidecarMessage[],
  eventQueue: QueuedSidecarMessage[],
  previousWorkerInstanceId?: string,
): QueuedSidecarMessage | undefined {
  let firstWorkerInstanceId: string | undefined;
  let nextWorkerInstanceId: string | undefined;
  for (const queue of [controlQueue, eventQueue]) {
    for (const queued of queue) {
      const workerInstanceId = queued.message.workerInstanceId;
      if (firstWorkerInstanceId === undefined || workerInstanceId < firstWorkerInstanceId) {
        firstWorkerInstanceId = workerInstanceId;
      }
      if (
        previousWorkerInstanceId !== undefined &&
        workerInstanceId > previousWorkerInstanceId &&
        (nextWorkerInstanceId === undefined || workerInstanceId < nextWorkerInstanceId)
      ) {
        nextWorkerInstanceId = workerInstanceId;
      }
    }
  }
  const workerInstanceId = nextWorkerInstanceId ?? firstWorkerInstanceId;
  if (workerInstanceId === undefined) return undefined;
  const controlIndex = controlQueue.findIndex((queued) => queued.message.workerInstanceId === workerInstanceId);
  if (controlIndex !== -1) return controlQueue.splice(controlIndex, 1)[0];
  const eventIndex = eventQueue.findIndex((queued) => queued.message.workerInstanceId === workerInstanceId);
  return eventIndex === -1 ? undefined : eventQueue.splice(eventIndex, 1)[0];
}

interface BufferedEvent {
  event: SidecarEventBody;
  bytes: number;
  jsonLength: number;
  creditCost: number;
}

interface ChannelQueueUsage {
  controlItems: number;
  controlBytes: number;
  eventItems: number;
  eventBytes: number;
}

interface ThreadChannel {
  readonly workerInstanceId: string;
  service?: SidecarService;
  readonly schedule: ReturnType<typeof createSidecarCommandScheduler>;
  eventSequence: number;
  eventCredit: number;
  lastAcknowledgedEventSequence: number;
  readonly outstandingEventCredits: Map<number, number>;
  bufferedEventBytes: number;
  readonly bufferedEvents: BufferedEvent[];
  readonly flushWaiters: Set<() => void>;
  resyncPending: boolean;
  closing: boolean;
}

export function runSharedThreadSidecarHost(
  runtime: RuntimeCompatibility,
  createService: SidecarServiceFactory = ThreadWorkerService.create,
): void {
  if (process.platform === "darwin" && process.env.ELECTRON_RUN_AS_NODE) {
    try {
      electron.app?.dock?.hide();
    } catch (error) {
      process.stderr.write(
        `Unable to hide the sidecar Dock icon: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }

  const channels = new Map<string, ThreadChannel>();
  const chunkAssembler = new SidecarChunkAssembler();
  const controlSendQueue: QueuedSidecarMessage[] = [];
  const eventSendQueue: QueuedSidecarMessage[] = [];
  const channelQueueUsage = new Map<string, ChannelQueueUsage>();
  let sendInFlight = false;
  let lastSentWorkerInstanceId: string | undefined;
  let closing = false;

  const isEventLane = (message: SidecarToParentMessage): boolean =>
    (message.kind === "event" && message.event.type !== "resync-required") ||
    (message.kind === "chunk" && message.lane === "event");

  const usageFor = (workerInstanceId: string): ChannelQueueUsage => {
    let usage = channelQueueUsage.get(workerInstanceId);
    if (!usage) {
      usage = { controlItems: 0, controlBytes: 0, eventItems: 0, eventBytes: 0 };
      channelQueueUsage.set(workerInstanceId, usage);
    }
    return usage;
  };

  const removeQueuedMessageUsage = (message: SidecarToParentMessage, bytes: number): void => {
    const usage = channelQueueUsage.get(message.workerInstanceId);
    if (!usage) return;
    if (isEventLane(message)) {
      usage.eventItems = Math.max(0, usage.eventItems - 1);
      usage.eventBytes = Math.max(0, usage.eventBytes - bytes);
    } else {
      usage.controlItems = Math.max(0, usage.controlItems - 1);
      usage.controlBytes = Math.max(0, usage.controlBytes - bytes);
    }
    if (usage.controlItems === 0 && usage.eventItems === 0) channelQueueUsage.delete(message.workerInstanceId);
  };

  const discardQueuedMessages = (workerInstanceId: string): void => {
    for (let index = controlSendQueue.length - 1; index >= 0; index -= 1) {
      const queued = controlSendQueue[index];
      if (queued?.message.workerInstanceId !== workerInstanceId) continue;
      removeQueuedMessageUsage(queued.message, queued.bytes);
      controlSendQueue.splice(index, 1);
    }
    for (let index = eventSendQueue.length - 1; index >= 0; index -= 1) {
      const queued = eventSendQueue[index];
      if (queued?.message.workerInstanceId !== workerInstanceId) continue;
      removeQueuedMessageUsage(queued.message, queued.bytes);
      eventSendQueue.splice(index, 1);
    }
  };

  const pumpSendQueue = (): void => {
    if (sendInFlight || closing || !process.connected || !process.send) return;
    const next = dequeueFairChannelMessage(controlSendQueue, eventSendQueue, lastSentWorkerInstanceId);
    if (!next) return;
    lastSentWorkerInstanceId = next.message.workerInstanceId;
    removeQueuedMessageUsage(next.message, next.bytes);
    sendInFlight = true;
    process.send(next.message, undefined, undefined, (error) => {
      sendInFlight = false;
      if (error && !closing) {
        process.stderr.write(`Shared thread sidecar IPC send failed: ${error.message}\n`);
        void shutdownHost();
      } else {
        pumpSendQueue();
      }
    });
  };

  const enqueueSend = (message: SidecarToParentMessage, preparedBytes?: number): boolean => {
    const bytes = preparedBytes ?? Buffer.byteLength(JSON.stringify(message));
    if (bytes > MAX_SIDECAR_MESSAGE_BYTES) {
      process.stderr.write(`Shared thread sidecar message exceeds ${MAX_SIDECAR_MESSAGE_BYTES} bytes\n`);
      void shutdownHost();
      return false;
    }
    const eventLane = isEventLane(message);
    const queue = eventLane ? eventSendQueue : controlSendQueue;
    const usage = usageFor(message.workerInstanceId);
    const queuedItems = eventLane ? usage.eventItems : usage.controlItems;
    const queuedBytes = eventLane ? usage.eventBytes : usage.controlBytes;
    if (queuedItems >= MAX_SEND_QUEUE_ITEMS_PER_CHANNEL || queuedBytes + bytes > MAX_SEND_QUEUE_BYTES_PER_CHANNEL) {
      const error = new Error(
        `Shared thread sidecar ${eventLane ? "event" : "control"} queue overflow for ${message.workerInstanceId}`,
      );
      discardQueuedMessages(message.workerInstanceId);
      void closeChannel(message.workerInstanceId, error);
      return false;
    }
    queue.push({ message, bytes });
    if (eventLane) {
      usage.eventItems += 1;
      usage.eventBytes += bytes;
    } else {
      usage.controlItems += 1;
      usage.controlBytes += bytes;
    }
    pumpSendQueue();
    return true;
  };

  const send = (message: SidecarToParentMessage, knownByteLength?: number): void => {
    if (!process.connected || !process.send || closing) return;
    if (message.kind !== "chunk") {
      if (knownByteLength !== undefined && knownByteLength <= MAX_SIDECAR_MESSAGE_BYTES) {
        enqueueSend(message, knownByteLength);
        return;
      }
      const prepared = prepareSidecarMessage(
        message,
        message.workerInstanceId,
        message.kind === "event" && message.event.type !== "resync-required" ? "event" : "control",
      );
      if (prepared.chunks) {
        for (const chunk of prepared.chunks) {
          if (!enqueueSend(chunk)) break;
        }
        return;
      }
      enqueueSend(message, prepared.byteLength);
      return;
    }
    enqueueSend(message);
  };

  const resolveFlushWaiters = (channel: ThreadChannel): void => {
    const queuedForChannel = eventSendQueue.some(
      (queued) => queued.message.workerInstanceId === channel.workerInstanceId,
    );
    if (channel.bufferedEvents.length > 0 || queuedForChannel || channel.outstandingEventCredits.size > 0) {
      return;
    }
    for (const resolve of channel.flushWaiters) resolve();
    channel.flushWaiters.clear();
  };

  const flushEvents = (channel: ThreadChannel): Promise<void> => {
    const queuedForChannel = eventSendQueue.some(
      (queued) => queued.message.workerInstanceId === channel.workerInstanceId,
    );
    if (channel.bufferedEvents.length === 0 && !queuedForChannel && channel.outstandingEventCredits.size === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => channel.flushWaiters.add(resolve));
  };

  const sendEvent = (
    channel: ThreadChannel,
    event: SidecarEventBody,
    eventByteLength: number,
    eventJsonLength: number,
    creditCost: number,
    consumeCredit = true,
  ): void => {
    if (consumeCredit) channel.eventCredit -= creditCost;
    channel.eventSequence += 1;
    channel.outstandingEventCredits.set(channel.eventSequence, creditCost);
    const message: SidecarEvent = {
      kind: "event" as const,
      protocolVersion: SIDECAR_PROTOCOL_VERSION,
      workerInstanceId: channel.workerInstanceId,
      sequence: channel.eventSequence,
      creditCost,
      eventJsonLength,
      event,
    };
    send(message, sidecarEventMessageByteLength(message, eventByteLength));
  };

  const drainEvents = (channel: ThreadChannel): void => {
    while (channel.bufferedEvents.length > 0) {
      const next = channel.bufferedEvents[0];
      if (!next || channel.eventCredit < next.creditCost) return;
      channel.bufferedEvents.shift();
      channel.bufferedEventBytes -= next.bytes;
      sendEvent(channel, next.event, next.bytes, next.jsonLength, next.creditCost);
    }
  };

  const emit = (channel: ThreadChannel, event: SidecarEventBody): void => {
    if (channel.closing || channel.resyncPending || closing) return;
    const serialized = JSON.stringify(event);
    const bytes = Buffer.byteLength(serialized);
    const jsonLength = serialized.length;
    const creditCost = Math.max(1, Math.ceil(bytes / (1024 * 1024)));
    if (channel.eventCredit >= creditCost && channel.bufferedEvents.length === 0) {
      sendEvent(channel, event, bytes, jsonLength, creditCost);
      return;
    }
    if (
      channel.bufferedEvents.length >= MAX_BUFFERED_EVENTS ||
      channel.bufferedEventBytes + bytes > MAX_BUFFERED_EVENT_BYTES
    ) {
      const lastSafeSequence = channel.lastAcknowledgedEventSequence;
      channel.bufferedEvents.length = 0;
      channel.bufferedEventBytes = 0;
      for (let index = eventSendQueue.length - 1; index >= 0; index -= 1) {
        const queued = eventSendQueue[index];
        if (queued?.message.workerInstanceId !== channel.workerInstanceId) continue;
        removeQueuedMessageUsage(queued.message, queued.bytes);
        eventSendQueue.splice(index, 1);
      }
      channel.outstandingEventCredits.clear();
      channel.eventCredit = INITIAL_EVENT_CREDIT;
      channel.lastAcknowledgedEventSequence = channel.eventSequence;
      channel.resyncPending = true;
      const resyncRequired = {
        type: "resync-required" as const,
        reason: "event-buffer-overflow",
        lastSafeSequence,
      };
      const serializedResync = JSON.stringify(resyncRequired);
      sendEvent(channel, resyncRequired, Buffer.byteLength(serializedResync), serializedResync.length, 0, false);
      return;
    }
    channel.bufferedEvents.push({ event, bytes, jsonLength, creditCost });
    channel.bufferedEventBytes += bytes;
  };

  const closeChannel = async (workerInstanceId: string, error?: unknown): Promise<void> => {
    const channel = channels.get(workerInstanceId);
    if (!channel || channel.closing) return;
    channel.closing = true;
    channels.delete(workerInstanceId);
    discardQueuedMessages(workerInstanceId);
    try {
      await channel.service?.dispose();
    } catch (disposeError) {
      error ??= disposeError;
    } finally {
      for (const resolve of channel.flushWaiters) resolve();
      channel.flushWaiters.clear();
      send({
        kind: "closed",
        protocolVersion: SIDECAR_PROTOCOL_VERSION,
        workerInstanceId,
        ...(error ? { error: serializeSidecarError(error) } : {}),
      });
    }
  };

  const shutdownHost = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    await Promise.allSettled([...channels.keys()].map((workerInstanceId) => closeChannel(workerInstanceId)));
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/pid", String(process.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
        detached: true,
      });
      killer.once("error", () => undefined);
      killer.unref();
    } else {
      process.disconnect?.();
      process.exitCode = 0;
    }
  };

  const initializeChannel = async (message: SidecarInitialize): Promise<void> => {
    if (channels.has(message.workerInstanceId)) throw new Error("Thread sidecar channel already initialized");
    if (message.binding.role !== "thread") throw new Error(`Unsupported shared sidecar role: ${message.binding.role}`);
    assertRuntimeCompatibility(message.expectedRuntime, runtime);
    const channel: ThreadChannel = {
      workerInstanceId: message.workerInstanceId,
      schedule: createSidecarCommandScheduler(),
      eventSequence: 0,
      eventCredit: INITIAL_EVENT_CREDIT,
      lastAcknowledgedEventSequence: 0,
      outstandingEventCredits: new Map(),
      bufferedEventBytes: 0,
      bufferedEvents: [],
      flushWaiters: new Set(),
      resyncPending: false,
      closing: false,
    };
    channels.set(message.workerInstanceId, channel);
    try {
      const context: SidecarServiceContext = {
        emit: (event) => emit(channel, event),
        flushEvents: () => flushEvents(channel),
      };
      const created = await createService(message.binding, context);
      if (channel.closing || closing) {
        await created.service.dispose();
        return;
      }
      channel.service = created.service;
      send({
        kind: "ready",
        protocolVersion: SIDECAR_PROTOCOL_VERSION,
        workerInstanceId: channel.workerInstanceId,
        role: "thread",
        runtime,
        result:
          created.readyResult === undefined ? undefined : toJsonValue(created.readyResult, MAX_SIDECAR_TRANSFER_BYTES),
      });
    } catch (error) {
      await closeChannel(message.workerInstanceId, error);
    }
  };

  const acknowledge = (channel: ThreadChannel, throughSequence: number, credit: number): void => {
    if (!Number.isSafeInteger(throughSequence) || !Number.isSafeInteger(credit) || credit < 0) {
      throw new Error("Invalid shared sidecar event acknowledgement");
    }
    if (throughSequence <= channel.lastAcknowledgedEventSequence) return;
    if (throughSequence > channel.eventSequence) throw new Error("Invalid shared sidecar event acknowledgement");
    let acknowledgedCredit = 0;
    for (let sequence = channel.lastAcknowledgedEventSequence + 1; sequence <= throughSequence; sequence += 1) {
      const creditCost = channel.outstandingEventCredits.get(sequence);
      if (creditCost === undefined) throw new Error(`Unknown shared sidecar acknowledgement sequence: ${sequence}`);
      acknowledgedCredit += creditCost;
    }
    if (credit !== acknowledgedCredit) throw new Error("Shared sidecar acknowledgement credit mismatch");
    for (let sequence = channel.lastAcknowledgedEventSequence + 1; sequence <= throughSequence; sequence += 1) {
      channel.outstandingEventCredits.delete(sequence);
    }
    channel.lastAcknowledgedEventSequence = throughSequence;
    channel.eventCredit = Math.min(INITIAL_EVENT_CREDIT, channel.eventCredit + acknowledgedCredit);
    drainEvents(channel);
    resolveFlushWaiters(channel);
  };

  const request = async (channel: ThreadChannel, requestId: string, command: SidecarCommand): Promise<void> => {
    await channel.schedule(command.type, async () => {
      try {
        if (!channel.service) throw new Error("Thread sidecar channel is not ready");
        const result = await channel.service.command(command);
        send({
          kind: "response",
          protocolVersion: SIDECAR_PROTOCOL_VERSION,
          workerInstanceId: channel.workerInstanceId,
          requestId,
          ok: true,
          result: result === undefined ? undefined : toJsonValue(result, MAX_SIDECAR_TRANSFER_BYTES),
        });
        if (command.type === "bootstrap") channel.resyncPending = false;
      } catch (error) {
        send({
          kind: "response",
          protocolVersion: SIDECAR_PROTOCOL_VERSION,
          workerInstanceId: channel.workerInstanceId,
          requestId,
          ok: false,
          error: serializeSidecarError(error),
        });
      }
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
      if (raw.kind === "host-shutdown") {
        await shutdownHost();
        return;
      }
      if (raw.kind === "initialize") {
        await initializeChannel(raw);
        return;
      }
      const channel = channels.get(raw.workerInstanceId);
      if (!channel) return;
      if (raw.kind === "shutdown") {
        await closeChannel(raw.workerInstanceId);
        return;
      }
      if (raw.kind === "event-ack") {
        acknowledge(channel, raw.throughSequence, raw.credit);
        return;
      }
      await request(channel, raw.requestId, raw.command);
    })().catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
      if (raw.kind === "initialize" && !channels.has(raw.workerInstanceId)) {
        send({
          kind: "closed",
          protocolVersion: SIDECAR_PROTOCOL_VERSION,
          workerInstanceId: raw.workerInstanceId,
          error: serializeSidecarError(error),
        });
      } else if ("workerInstanceId" in raw) {
        void closeChannel(raw.workerInstanceId, error);
      } else {
        void shutdownHost();
      }
    });
  };

  process.on("message", handleMessage);
  process.once("disconnect", () => void shutdownHost());
  process.once("SIGTERM", () => void shutdownHost());
  process.once("SIGINT", () => void shutdownHost());
}
