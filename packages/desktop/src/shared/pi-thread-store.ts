import { parse as parsePartialJson } from "partial-json";
import {
  type JsonValue,
  type PiAssistantMessage,
  type PiAssistantPart,
  type PiNoticeMessage,
  type PiQueueItem,
  type PiRpcEvent,
  type PiRpcMessageUpdateEvent,
  type PiThreadSnapshot,
  type PiTimelineNode,
  type PiToolCallPart,
  PROTOCOL_VERSION,
} from "./contracts.ts";
import {
  applyPiToolResult,
  createPiMessageNodeId,
  type PiAssistant,
  type PiMessage,
  type PiToolResult,
  projectPiAssistant,
  projectPiMessage,
  projectPiToolResult,
  type RegisterImageResource,
  toJson,
} from "./pi-message-projector.ts";

type Listener = () => void;
interface PiThreadNodesChange {
  previousVersion: object;
  dirtyFrom: number;
  rekeyedFrom: ReadonlyMap<number, string>;
}

interface PendingStreamEvent {
  sequence: number;
  event: PiRpcEvent;
  deltas: string[];
}

interface StreamingJsonCheckpoint {
  parsedArgs: PiToolCallPart["args"];
  nextParseLength: number;
  depth: number;
  inString: boolean;
  escaped: boolean;
  started: boolean;
  completed: boolean;
}

interface TailNodeArrayView {
  source: readonly PiTimelineNode[];
  prefixLength: number;
  tail: PiTimelineNode;
}

const nodeVersions = new WeakMap<readonly PiTimelineNode[], object>();
const nodeChanges = new WeakMap<readonly PiTimelineNode[], PiThreadNodesChange>();
const nodeDirtyFrom = new WeakMap<readonly PiTimelineNode[], number>();
const tailNodeArrayViews = new WeakMap<readonly PiTimelineNode[], TailNodeArrayView>();
const streamingJsonCheckpoints = new WeakMap<PiToolCallPart, StreamingJsonCheckpoint>();

/** 返回相邻 snapshot 节点的结构共享边界，供线性 projection 只重建变化后缀。 */
export function getPiThreadNodesChange(
  nodes: readonly PiTimelineNode[],
  previousNodes: readonly PiTimelineNode[],
): PiThreadNodesChange | undefined {
  const change = nodeChanges.get(nodes);
  return change?.previousVersion === nodeVersions.get(previousNodes) ? change : undefined;
}

/** 直接把 Pi RPC 原子事件归约为 renderer 使用的 timeline snapshot。 */
export class PiThreadStore {
  private state: PiThreadSnapshot | string;
  private nodeIds: Set<string> | null;
  private readonly listeners = new Set<Listener>();
  private readonly pendingListeners = new Set<Listener>();
  private notificationScheduled = false;
  private pendingStreamEvent?: PendingStreamEvent;
  private coalescingStreamKey?: string;
  private readonly registerImageResource?: RegisterImageResource;

  constructor(initial: PiThreadSnapshot = detachedSnapshot(), registerImageResource?: RegisterImageResource) {
    validateSnapshot(initial);
    this.state = initial;
    this.nodeIds = new Set(initial.nodes.map((node) => node.id));
    this.registerImageResource = registerImageResource;
  }

  getSnapshot = (): PiThreadSnapshot => {
    this.flushPendingStreamEvent();
    return this.hydrate();
  };

  /** 状态栏只需 phase 等元数据，不应为了每个流式 delta 展平正文。 */
  getStatusSnapshot = (): PiThreadSnapshot => this.hydrate();

  /** 只读取已展开的 snapshot；hover 等轻量视图不得因此恢复休眠会话。 */
  getInMemorySnapshot = (): PiThreadSnapshot | null => (typeof this.state === "string" ? null : this.state);

  hibernate(): boolean {
    this.flushPendingStreamEvent();
    if (typeof this.state === "string") return true;
    if (this.listeners.size > 0) return false;
    this.state = JSON.stringify(this.state);
    this.nodeIds = null;
    return true;
  }

  getHibernatedBytes(): number {
    return typeof this.state === "string" ? this.state.length * 2 : 0;
  }

  evictHibernated(): boolean {
    if (typeof this.state !== "string" || this.listeners.size > 0) return false;
    this.state = detachedSnapshot();
    this.nodeIds = new Set();
    return true;
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      this.pendingListeners.delete(listener);
    };
  };

  replace(snapshot: PiThreadSnapshot): void {
    this.pendingStreamEvent = undefined;
    this.coalescingStreamKey = undefined;
    validateSnapshot(snapshot);
    const previousNodes = typeof this.state === "string" ? undefined : this.state.nodes;
    this.state = snapshot;
    this.nodeIds = new Set(snapshot.nodes.map((node) => node.id));
    if (previousNodes) recordNodeChange(previousNodes, snapshot.nodes);
    this.notify();
  }

  apply(sequence: number, event: PiRpcEvent): void {
    const current = this.hydrate();
    const currentCursor = this.pendingStreamEvent?.sequence ?? current.cursor;
    if (sequence <= currentCursor) return;
    if (sequence !== currentCursor + 1) {
      throw new PiThreadStoreError(`timeline sequence gap: ${currentCursor} -> ${sequence}`);
    }

    const streamKey = streamDeltaKey(event);
    if (streamKey && this.coalescingStreamKey === streamKey) {
      const pending = this.pendingStreamEvent;
      if (pending) {
        pending.sequence = sequence;
        pending.event = event;
        pending.deltas.push(streamDelta(event));
      } else {
        this.pendingStreamEvent = { sequence, event, deltas: [streamDelta(event)] };
      }
      this.notify();
      return;
    }

    this.flushPendingStreamEvent();
    this.applyReduced(sequence, event);
    this.coalescingStreamKey = streamKey;
    this.notify();
  }

  private applyReduced(sequence: number, event: PiRpcEvent): void {
    const current = this.hydrate();
    const next = reducePiRpcEvent(current, sequence, event, this.registerImageResource);
    if (next.protocolVersion !== current.protocolVersion || next.threadId !== current.threadId) {
      throw new PiThreadStoreError("Pi event reducer changed timeline identity");
    }
    if (current.nodes !== next.nodes) {
      const dirtyFrom = nodeDirtyFrom.get(next.nodes);
      if (dirtyFrom === undefined) {
        throw new PiThreadStoreError("Pi event reducer changed nodes without change metadata");
      }
      this.validateNodeMutation(current, next, dirtyFrom);
      recordNodeChange(current.nodes, next.nodes, dirtyFrom);
    } else if (next.headId !== current.headId) {
      throw new PiThreadStoreError("Pi event reducer changed head without changing nodes");
    }
    this.state = next;
  }

  private flushPendingStreamEvent(): void {
    const pending = this.pendingStreamEvent;
    if (!pending) return;
    this.pendingStreamEvent = undefined;
    this.applyReduced(pending.sequence, withStreamDelta(pending.event, pending.deltas.join("")));
  }

  private hydrate(): PiThreadSnapshot {
    if (typeof this.state !== "string") return this.state;
    const snapshot = JSON.parse(this.state) as PiThreadSnapshot;
    validateSnapshot(snapshot);
    this.state = snapshot;
    this.nodeIds = new Set(snapshot.nodes.map((node) => node.id));
    return snapshot;
  }

  private validateNodeMutation(current: PiThreadSnapshot, next: PiThreadSnapshot, dirtyFrom: number): void {
    const nodeIds = this.nodeIds;
    if (!nodeIds) throw new PiThreadStoreError("Pi timeline node index is unavailable");
    if (next.nodes.length === current.nodes.length + 1 && dirtyFrom === current.nodes.length) {
      const appended = next.nodes[dirtyFrom];
      if (!appended || appended.parentId !== current.headId || next.headId !== appended.id) {
        throw new PiThreadStoreError("Pi event reducer appended an invalid timeline node");
      }
      if (nodeIds.has(appended.id)) throw new PiThreadStoreError(`重复 snapshot node: ${appended.id}`);
      nodeIds.add(appended.id);
      return;
    }
    if (next.nodes.length === current.nodes.length && dirtyFrom >= 0 && dirtyFrom < current.nodes.length) {
      const previous = current.nodes[dirtyFrom];
      const replacement = next.nodes[dirtyFrom];
      if (
        !previous ||
        !replacement ||
        replacement.id !== previous.id ||
        replacement.parentId !== previous.parentId ||
        next.headId !== current.headId
      ) {
        throw new PiThreadStoreError("Pi event reducer replaced an invalid timeline node");
      }
      return;
    }
    throw new PiThreadStoreError("Pi event reducer produced an unsupported node mutation");
  }

  private notify(): void {
    for (const listener of this.listeners) this.pendingListeners.add(listener);
    if (this.notificationScheduled || this.pendingListeners.size === 0) return;
    this.notificationScheduled = true;
    schedulePresentationUpdate(() => {
      this.notificationScheduled = false;
      this.flushPendingStreamEvent();
      const listeners = [...this.pendingListeners];
      this.pendingListeners.clear();
      for (const listener of listeners) {
        if (this.listeners.has(listener)) listener();
      }
    });
  }
}

export class PiThreadStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PiThreadStoreError";
  }
}

function streamDeltaKey(event: PiRpcEvent): string | undefined {
  if (event.type === "bash_execution_update") return `bash:${event.id ?? "anonymous"}`;
  if (event.type !== "message_update") return undefined;
  const update = event.assistantMessageEvent;
  return update.type === "text_delta" || update.type === "thinking_delta" || update.type === "toolcall_delta"
    ? `${update.type}:${update.contentIndex}`
    : undefined;
}

function streamDelta(event: PiRpcEvent): string {
  if (event.type === "bash_execution_update") return event.delta;
  if (event.type !== "message_update") throw new PiThreadStoreError("Pi stream event has no delta");
  const update = event.assistantMessageEvent;
  if (update.type !== "text_delta" && update.type !== "thinking_delta" && update.type !== "toolcall_delta") {
    throw new PiThreadStoreError("Pi message event has no stream delta");
  }
  return update.delta;
}

function withStreamDelta(event: PiRpcEvent, delta: string): PiRpcEvent {
  if (event.type === "bash_execution_update") return { ...event, delta };
  if (event.type !== "message_update") throw new PiThreadStoreError("Pi stream event has no delta");
  const update = event.assistantMessageEvent;
  if (update.type !== "text_delta" && update.type !== "thinking_delta" && update.type !== "toolcall_delta") {
    throw new PiThreadStoreError("Pi message event has no stream delta");
  }
  return { ...event, assistantMessageEvent: { ...update, delta } };
}

function parseStreamingJson(partialJson: string): unknown {
  try {
    return JSON.parse(partialJson);
  } catch {
    try {
      return parsePartialJson(partialJson) ?? {};
    } catch {
      return {};
    }
  }
}

function advanceStreamingJsonCheckpoint(
  previous: StreamingJsonCheckpoint | undefined,
  delta: string,
): Omit<StreamingJsonCheckpoint, "parsedArgs" | "nextParseLength" | "completed"> {
  let depth = previous?.depth ?? 0;
  let inString = previous?.inString ?? false;
  let escaped = previous?.escaped ?? false;
  let started = previous?.started ?? false;
  for (const character of delta) {
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      started = true;
    } else if (character === "{" || character === "[") {
      depth += 1;
      started = true;
    } else if (character === "}" || character === "]") {
      depth = Math.max(0, depth - 1);
    } else if (!/\s/.test(character)) {
      started = true;
    }
  }
  return { depth, inString, escaped, started };
}

function updateStreamingToolArgs(part: PiToolCallPart, delta: string): PiToolCallPart {
  const argsText = part.argsText + delta;
  const previous = streamingJsonCheckpoints.get(part);
  const scan = advanceStreamingJsonCheckpoint(previous, delta);
  const complete = scan.started && scan.depth === 0 && !scan.inString;
  const becameComplete = complete && previous?.completed !== true;
  const shouldParse = previous === undefined || argsText.length >= previous.nextParseLength || becameComplete;
  const parsed = shouldParse ? toJson(parseStreamingJson(argsText)) : (previous?.parsedArgs ?? {});
  let nextParseLength = previous?.nextParseLength ?? 1_024;
  if (shouldParse) {
    while (nextParseLength <= argsText.length) nextParseLength *= 2;
  }
  const next: PiToolCallPart = {
    ...part,
    args: isJsonObject(parsed) ? parsed : {},
    argsText,
    execution: "streaming-args",
  };
  streamingJsonCheckpoints.set(next, {
    ...scan,
    parsedArgs: next.args,
    nextParseLength,
    completed: complete,
  });
  return next;
}

function schedulePresentationUpdate(callback: () => void): void {
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => callback());
    return;
  }
  queueMicrotask(callback);
}

export function reducePiRpcEvent(
  snapshot: PiThreadSnapshot,
  sequence: number,
  event: PiRpcEvent,
  registerImageResource?: RegisterImageResource,
): PiThreadSnapshot {
  const next = { ...snapshot, cursor: sequence };
  switch (event.type) {
    case "agent_start":
      return { ...next, phase: "running" };
    case "agent_settled":
      return { ...next, phase: "idle", activeTurnId: undefined, activeTurnThinkingLevel: undefined };
    case "turn_start":
      return {
        ...next,
        phase: "running",
        activeTurnId: `rpc-turn:${sequence}`,
        activeTurnThinkingLevel: snapshot.thinkingLevel,
      };
    case "turn_end":
      return { ...next, activeTurnId: undefined, activeTurnThinkingLevel: undefined };
    case "message_start":
      return startMessage(next, event.message, registerImageResource);
    case "message_update":
      return updateAssistant(next, event);
    case "message_end":
      return finishMessage(next, event.message, registerImageResource);
    case "tool_execution_start":
      return updateTool(next, event.toolCallId, (part) => ({ ...part, execution: "running" }));
    case "tool_execution_update":
      return updateTool(next, event.toolCallId, (part) => ({
        ...part,
        execution: "running",
        partialResult: toJson(event.partialResult),
      }));
    case "tool_execution_end":
      return updateTool(next, event.toolCallId, (part) => ({
        ...part,
        execution: event.isError ? "error" : "complete",
        result: projectPiToolResult(event.result, registerImageResource),
        isError: event.isError,
      }));
    case "queue_update":
      return { ...next, queue: queueItems(sequence, event.steering, event.followUp) };
    case "compaction_start":
      return { ...next, phase: "compacting" };
    case "compaction_end":
      return { ...next, phase: event.reason === "manual" ? "idle" : "running" };
    case "auto_retry_start":
      return { ...next, phase: "retrying" };
    case "auto_retry_end":
      return { ...next, phase: snapshot.phase === "retrying" ? "running" : snapshot.phase };
    case "summarization_retry_scheduled":
      return { ...next, phase: "retrying" };
    case "summarization_retry_attempt_start":
      return { ...next, phase: event.source === "compaction" ? "compacting" : "tree-navigation" };
    case "summarization_retry_finished":
      return { ...next, phase: "idle" };
    case "extension_ui_request":
      return event.method === "notify" ? appendNotification(next, sequence, event.message, event.notifyType) : next;
    case "extension_error":
      return appendExtensionError(next, sequence, event);
    case "bash_execution_update":
      return applyBashDelta(next, sequence, event.id, event.delta);
    case "agent_end":
    case "entry_appended":
    case "session_info_changed":
      return next;
    case "thinking_level_changed":
      return { ...next, thinkingLevel: event.level };
    default:
      return assertNever(event);
  }
}

function applyBashDelta(
  snapshot: PiThreadSnapshot,
  sequence: number,
  executionId: string | undefined,
  delta: string,
): PiThreadSnapshot {
  const id = executionId ? `rpc-bash:${executionId}` : undefined;
  const index = findLastNodeIndex(snapshot.nodes, (node) => {
    if (node.kind !== "notice" || node.noticeType !== "bash") return false;
    return id ? node.id === id : node.id.startsWith("rpc-bash:anonymous:");
  });
  if (index >= 0) {
    const current = snapshot.nodes[index];
    if (!current || current.kind !== "notice" || current.noticeType !== "bash" || current.content.type !== "command") {
      throw new PiThreadStoreError("active Pi bash output is invalid");
    }
    return replaceNode(snapshot, index, {
      ...current,
      content: { ...current.content, output: current.content.output + delta },
    });
  }
  return appendNode(snapshot, {
    id: id ?? `rpc-bash:anonymous:${sequence}`,
    parentId: snapshot.headId,
    createdAt: Date.now(),
    kind: "notice",
    noticeType: "bash",
    title: "Bash 输出",
    content: {
      type: "command",
      command: "",
      output: delta,
      cancelled: false,
      truncated: false,
    },
  });
}

function startMessage(
  snapshot: PiThreadSnapshot,
  message: PiMessage,
  registerImageResource?: RegisterImageResource,
): PiThreadSnapshot {
  if (message.role === "toolResult") return snapshot;
  const id = createPiMessageNodeId(message, snapshot.nodes);
  const thinkingLevel =
    message.role === "assistant"
      ? (snapshot.activeTurnThinkingLevel ?? snapshot.thinkingLevel)
      : snapshot.thinkingLevel;
  const node = projectPiMessage({
    id,
    parentId: snapshot.headId,
    message,
    finished: false,
    thinkingLevel,
    registerImageResource,
  });
  return node ? appendNode(snapshot, node) : snapshot;
}

function updateAssistant(snapshot: PiThreadSnapshot, event: PiRpcMessageUpdateEvent): PiThreadSnapshot {
  const index = findLastNodeIndex(
    snapshot.nodes,
    (node) => node.kind === "assistant" && node.status.type === "running",
  );
  if (index < 0) throw new PiThreadStoreError("Pi message_update has no active assistant message");
  const current = snapshot.nodes[index];
  if (!current || current.kind !== "assistant") throw new PiThreadStoreError("active assistant message is missing");

  const update = event.assistantMessageEvent;
  if (update.type === "done") return replaceStreamingAssistant(snapshot, index, current, update.message);
  if (update.type === "error") return replaceStreamingAssistant(snapshot, index, current, update.error);

  const content = [...current.content];
  switch (update.type) {
    case "start":
      break;
    case "text_start":
      setStreamingPart(content, update.contentIndex, {
        id: `${current.id}:text:${update.contentIndex}`,
        type: "text",
        text: "",
      });
      break;
    case "text_delta": {
      const part = requireStreamingPart(content, update.contentIndex, "text");
      setStreamingPart(content, update.contentIndex, { ...part, text: part.text + update.delta });
      break;
    }
    case "text_end": {
      const part = requireStreamingPart(content, update.contentIndex, "text");
      setStreamingPart(content, update.contentIndex, { ...part, text: update.content });
      break;
    }
    case "thinking_start":
      setStreamingPart(content, update.contentIndex, {
        id: `${current.id}:reasoning:${update.contentIndex}`,
        type: "reasoning",
        text: "",
      });
      break;
    case "thinking_delta": {
      const part = requireStreamingPart(content, update.contentIndex, "reasoning");
      setStreamingPart(content, update.contentIndex, { ...part, text: part.text + update.delta });
      break;
    }
    case "thinking_end": {
      const part = requireStreamingPart(content, update.contentIndex, "reasoning");
      setStreamingPart(content, update.contentIndex, { ...part, text: update.content });
      break;
    }
    case "toolcall_start":
      setStreamingPart(content, update.contentIndex, {
        id: `${current.id}:tool:${update.contentIndex}`,
        type: "tool-call",
        toolCallId: `pending:${current.id}:${update.contentIndex}`,
        toolName: "",
        args: {},
        argsText: "",
        execution: "streaming-args",
      });
      break;
    case "toolcall_delta": {
      const part = requireStreamingPart(content, update.contentIndex, "tool-call");
      setStreamingPart(content, update.contentIndex, updateStreamingToolArgs(part, update.delta));
      break;
    }
    case "toolcall_end": {
      const part = requireStreamingPart(content, update.contentIndex, "tool-call");
      const args = toJson(update.toolCall.arguments);
      setStreamingPart(content, update.contentIndex, {
        ...part,
        toolCallId: update.toolCall.id,
        toolName: update.toolCall.name,
        args: isJsonObject(args) ? args : {},
        argsText: JSON.stringify(args),
        execution: "waiting",
      });
      break;
    }
    default:
      return assertNever(update);
  }

  return replaceNode(snapshot, index, {
    ...current,
    content,
    usage: { ...event.usage, cost: { ...event.usage.cost } },
  });
}

function replaceStreamingAssistant(
  snapshot: PiThreadSnapshot,
  index: number,
  current: PiAssistantMessage,
  message: PiAssistant,
): PiThreadSnapshot {
  const projected = projectPiAssistant({
    id: current.id,
    parentId: current.parentId,
    message,
    finished: false,
    thinkingLevel: current.provenance.thinkingLevel,
  });
  return replaceNode(snapshot, index, {
    ...projected,
    content: projected.content.map((part) => mergeToolExecution(current, part)),
  });
}

function setStreamingPart(content: PiAssistantPart[], contentIndex: number, part: PiAssistantPart): void {
  const existing = content.findIndex((candidate) => partIndex(candidate.id) === contentIndex);
  if (existing >= 0) {
    content[existing] = part;
    return;
  }
  if (contentIndex !== content.length) {
    throw new PiThreadStoreError(`Pi message_update content index gap: ${content.length} -> ${contentIndex}`);
  }
  content.push(part);
}

function requireStreamingPart<Type extends PiAssistantPart["type"]>(
  content: PiAssistantPart[],
  contentIndex: number,
  type: Type,
): Extract<PiAssistantPart, { type: Type }> {
  const part = content.find((candidate) => partIndex(candidate.id) === contentIndex);
  if (!part || part.type !== type) {
    throw new PiThreadStoreError(`Pi message_update ${type} part missing at content index ${contentIndex}`);
  }
  return part as Extract<PiAssistantPart, { type: Type }>;
}

function finishMessage(
  snapshot: PiThreadSnapshot,
  message: PiMessage,
  registerImageResource?: RegisterImageResource,
): PiThreadSnapshot {
  if (message.role === "toolResult") return applyToolResult(snapshot, message, registerImageResource);
  const index = findLastNodeIndex(snapshot.nodes, (node) => {
    if (message.role === "assistant") return node.kind === "assistant" && node.status.type === "running";
    if (message.role === "user") return node.kind === "user" && node.delivery.state === "live";
    return node.kind === "notice" && node.sourceEntryId === undefined;
  });
  if (index < 0) return snapshot;
  const current = snapshot.nodes[index];
  if (!current) return snapshot;
  const projected = projectPiMessage({
    id: current.id,
    parentId: current.parentId,
    message,
    finished: true,
    completedAt: Date.now(),
    ...(current.kind === "assistant" ? { thinkingLevel: current.provenance.thinkingLevel } : {}),
    registerImageResource,
  });
  return projected ? replaceNode(snapshot, index, projected) : snapshot;
}

function mergeToolExecution(current: PiAssistantMessage, projected: PiAssistantPart): PiAssistantPart {
  if (projected.type !== "tool-call") return projected;
  const previous = current.content.find(
    (part): part is PiToolCallPart => part.type === "tool-call" && part.toolCallId === projected.toolCallId,
  );
  return previous?.execution === "running" || previous?.execution === "complete" || previous?.execution === "error"
    ? { ...projected, ...toolExecutionFields(previous) }
    : projected;
}

function toolExecutionFields(
  part: PiToolCallPart,
): Pick<PiToolCallPart, "execution" | "partialResult" | "result" | "isError"> {
  return {
    execution: part.execution,
    ...(part.partialResult !== undefined ? { partialResult: part.partialResult } : {}),
    ...(part.result !== undefined ? { result: part.result } : {}),
    ...(part.isError !== undefined ? { isError: part.isError } : {}),
  };
}

function updateTool(
  snapshot: PiThreadSnapshot,
  toolCallId: string,
  update: (part: PiToolCallPart) => PiToolCallPart,
): PiThreadSnapshot {
  for (let nodeIndex = snapshot.nodes.length - 1; nodeIndex >= 0; nodeIndex -= 1) {
    const node = snapshot.nodes[nodeIndex];
    if (!node || node.kind !== "assistant") continue;
    const partIndex = node.content.findIndex((part) => part.type === "tool-call" && part.toolCallId === toolCallId);
    if (partIndex < 0) continue;
    const part = node.content[partIndex];
    if (!part || part.type !== "tool-call") continue;
    const content = [...node.content];
    content[partIndex] = update(part);
    return replaceNode(snapshot, nodeIndex, { ...node, content });
  }
  throw new PiThreadStoreError(`Pi tool event references unknown tool call: ${toolCallId}`);
}

function applyToolResult(
  snapshot: PiThreadSnapshot,
  message: PiToolResult,
  registerImageResource?: RegisterImageResource,
): PiThreadSnapshot {
  return updateTool(snapshot, message.toolCallId, (part) =>
    applyPiToolResult(part, message, registerImageResource),
  );
}

function appendNotification(
  snapshot: PiThreadSnapshot,
  sequence: number,
  message: string,
  notifyType: "info" | "warning" | "error" | undefined,
): PiThreadSnapshot {
  const node: PiNoticeMessage = {
    id: `rpc-notify:${sequence}`,
    parentId: snapshot.headId,
    createdAt: Date.now(),
    kind: "notice",
    noticeType: "notification",
    notificationType: notifyType ?? "info",
    title: "Pi 扩展通知",
    content: { type: "text", text: message },
  };
  return appendNode(snapshot, node);
}

function appendExtensionError(
  snapshot: PiThreadSnapshot,
  sequence: number,
  event: Extract<PiRpcEvent, { type: "extension_error" }>,
): PiThreadSnapshot {
  return appendNode(snapshot, {
    id: `rpc-extension-error:${sequence}`,
    parentId: snapshot.headId,
    createdAt: Date.now(),
    kind: "notice",
    noticeType: "notification",
    notificationType: "error",
    extensionNotification: {
      customType: "pi.extension_error",
      details: { extensionPath: event.extensionPath, event: event.event, error: event.error },
    },
    title: "Pi 扩展错误",
    content: { type: "text", text: event.error },
  });
}

function isJsonObject(value: JsonValue): value is { [key: string]: JsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function queueItems(sequence: number, steering: readonly string[], followUp: readonly string[]): PiQueueItem[] {
  return [
    ...steering.map(
      (prompt, index): PiQueueItem => ({
        id: `rpc-queue:${sequence}:steer:${index}`,
        mode: "steer",
        prompt,
        source: "pi-observed",
      }),
    ),
    ...followUp.map(
      (prompt, index): PiQueueItem => ({
        id: `rpc-queue:${sequence}:followUp:${index}`,
        mode: "followUp",
        prompt,
        source: "pi-observed",
      }),
    ),
  ];
}

function appendNode(snapshot: PiThreadSnapshot, node: PiTimelineNode): PiThreadSnapshot {
  const source = tailNodeArrayViews.has(snapshot.nodes) ? [...snapshot.nodes] : snapshot.nodes;
  const nodes = createTailNodeArrayView(source, source.length, node);
  nodeDirtyFrom.set(nodes, snapshot.nodes.length);
  return { ...snapshot, headId: node.id, nodes };
}

function replaceNode(snapshot: PiThreadSnapshot, index: number, node: PiTimelineNode): PiThreadSnapshot {
  let nodes: readonly PiTimelineNode[];
  if (index === snapshot.nodes.length - 1) {
    const current = tailNodeArrayViews.get(snapshot.nodes);
    nodes = current
      ? createTailNodeArrayView(current.source, current.prefixLength, node)
      : createTailNodeArrayView(snapshot.nodes, index, node);
  } else {
    const copied = [...snapshot.nodes];
    copied[index] = node;
    nodes = copied;
  }
  nodeDirtyFrom.set(nodes, index);
  return { ...snapshot, headId: snapshot.headId === snapshot.nodes[index]?.id ? node.id : snapshot.headId, nodes };
}

function createTailNodeArrayView(
  source: readonly PiTimelineNode[],
  prefixLength: number,
  tail: PiTimelineNode,
): readonly PiTimelineNode[] {
  const target: PiTimelineNode[] = [];
  const nodeAt = (index: number): PiTimelineNode | undefined =>
    index < prefixLength ? source[index] : index === prefixLength ? tail : undefined;
  const view = new Proxy(target, {
    get(array, property, receiver) {
      if (property === "length") return prefixLength + 1;
      const index = arrayIndex(property);
      return index === undefined ? Reflect.get(array, property, receiver) : nodeAt(index);
    },
    getOwnPropertyDescriptor(array, property) {
      const index = arrayIndex(property);
      if (index === undefined) return Reflect.getOwnPropertyDescriptor(array, property);
      const value = nodeAt(index);
      return value === undefined ? undefined : { configurable: true, enumerable: true, value, writable: false };
    },
    has(array, property) {
      const index = arrayIndex(property);
      return index === undefined ? Reflect.has(array, property) : index <= prefixLength;
    },
    ownKeys() {
      return [...Array.from({ length: prefixLength + 1 }, (_value, index) => String(index)), "length"];
    },
    set: () => false,
    defineProperty: () => false,
    deleteProperty: () => false,
  });
  tailNodeArrayViews.set(view, { source, prefixLength, tail });
  return view;
}

function arrayIndex(property: PropertyKey): number | undefined {
  if (typeof property !== "string" || property.length === 0) return undefined;
  const index = Number(property);
  return Number.isSafeInteger(index) && index >= 0 && String(index) === property ? index : undefined;
}

function findLastNodeIndex(nodes: readonly PiTimelineNode[], predicate: (node: PiTimelineNode) => boolean): number {
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index];
    if (node && predicate(node)) return index;
  }
  return -1;
}

function partIndex(id: string): number {
  const value = Number(id.slice(id.lastIndexOf(":") + 1));
  return Number.isInteger(value) ? value : -1;
}

function validateSnapshot(snapshot: PiThreadSnapshot): void {
  if (snapshot.protocolVersion !== PROTOCOL_VERSION) {
    throw new PiThreadStoreError(`不支持的 timeline protocol: ${snapshot.protocolVersion}`);
  }
  const ids = new Set<string>();
  for (const node of snapshot.nodes) {
    if (ids.has(node.id)) throw new PiThreadStoreError(`重复 snapshot node: ${node.id}`);
    if (node.parentId !== null && !ids.has(node.parentId)) {
      throw new PiThreadStoreError(`snapshot parent 顺序无效: ${node.parentId}`);
    }
    ids.add(node.id);
  }
  if (snapshot.headId !== null && !ids.has(snapshot.headId)) {
    throw new PiThreadStoreError(`snapshot head 不存在: ${snapshot.headId}`);
  }
}

function recordNodeChange(
  previousNodes: readonly PiTimelineNode[],
  nextNodes: readonly PiTimelineNode[],
  knownDirtyFrom?: number,
): void {
  if (previousNodes === nextNodes) return;
  let previousVersion = nodeVersions.get(previousNodes);
  if (!previousVersion) {
    previousVersion = {};
    nodeVersions.set(previousNodes, previousVersion);
  }
  nodeVersions.set(nextNodes, {});
  let dirtyFrom = knownDirtyFrom ?? 0;
  if (knownDirtyFrom === undefined) {
    const sharedLength = Math.min(previousNodes.length, nextNodes.length);
    while (dirtyFrom < sharedLength && previousNodes[dirtyFrom] === nextNodes[dirtyFrom]) dirtyFrom += 1;
  }
  nodeChanges.set(nextNodes, { previousVersion, dirtyFrom, rekeyedFrom: new Map() });
}

export function detachedSnapshot(): PiThreadSnapshot {
  return {
    protocolVersion: PROTOCOL_VERSION,
    projectId: "",
    threadId: "",
    cursor: 0,
    headId: null,
    nodes: [],
    queue: [],
    phase: "idle",
    thinkingLevel: "off",
  };
}

function assertNever(value: never): never {
  throw new PiThreadStoreError(`未知 Pi RPC event: ${String(value)}`);
}
