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
} from "../../../shared/contracts.ts";
import {
  applyPiToolResult,
  createPiMessageNodeId,
  type PiAssistant,
  type PiMessage,
  type PiToolResult,
  projectPiAssistant,
  projectPiMessage,
  toJson,
} from "../../../shared/pi-message-projector.ts";

type Listener = () => void;
interface PiThreadNodesChange {
  previousNodes: readonly PiTimelineNode[];
  dirtyFrom: number;
  rekeyedFrom: ReadonlyMap<number, string>;
}

const nodeChanges = new WeakMap<readonly PiTimelineNode[], PiThreadNodesChange>();

/** 返回 snapshot 节点的结构共享边界，供线性 projection 只重建变化后缀。 */
export function getPiThreadNodesChange(nodes: readonly PiTimelineNode[]): PiThreadNodesChange | undefined {
  return nodeChanges.get(nodes);
}

/** 直接把 Pi RPC 原子事件归约为 renderer 使用的 timeline snapshot。 */
export class PiThreadStore {
  private state: PiThreadSnapshot | string;
  private readonly listeners = new Set<Listener>();

  constructor(initial: PiThreadSnapshot = detachedSnapshot()) {
    validateSnapshot(initial);
    this.state = initial;
  }

  getSnapshot = (): PiThreadSnapshot => this.hydrate();

  hibernate(): boolean {
    if (typeof this.state === "string") return true;
    if (this.listeners.size > 0) return false;
    this.state = JSON.stringify(this.state);
    return true;
  }

  getHibernatedBytes(): number {
    return typeof this.state === "string" ? this.state.length * 2 : 0;
  }

  evictHibernated(): boolean {
    if (typeof this.state !== "string" || this.listeners.size > 0) return false;
    this.state = detachedSnapshot();
    return true;
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  replace(snapshot: PiThreadSnapshot): void {
    validateSnapshot(snapshot);
    const previousNodes = typeof this.state === "string" ? undefined : this.state.nodes;
    this.state = snapshot;
    if (previousNodes) recordNodeChange(previousNodes, snapshot.nodes);
    this.notify();
  }

  apply(sequence: number, event: PiRpcEvent): void {
    const current = this.hydrate();
    if (sequence <= current.cursor) return;
    if (sequence !== current.cursor + 1) {
      throw new PiThreadStoreError(`timeline sequence gap: ${current.cursor} -> ${sequence}`);
    }

    const next = reducePiRpcEvent(current, sequence, event);
    validateSnapshot(next);
    recordNodeChange(current.nodes, next.nodes);
    this.state = next;
    this.notify();
  }

  private hydrate(): PiThreadSnapshot {
    if (typeof this.state !== "string") return this.state;
    const snapshot = JSON.parse(this.state) as PiThreadSnapshot;
    validateSnapshot(snapshot);
    this.state = snapshot;
    return snapshot;
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

export class PiThreadStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PiThreadStoreError";
  }
}

function reducePiRpcEvent(snapshot: PiThreadSnapshot, sequence: number, event: PiRpcEvent): PiThreadSnapshot {
  const next = { ...snapshot, cursor: sequence };
  switch (event.type) {
    case "agent_start":
      return { ...next, phase: "running" };
    case "agent_settled":
      return { ...next, phase: "idle", activeTurnId: undefined };
    case "turn_start":
      return { ...next, phase: "running", activeTurnId: `rpc-turn:${sequence}` };
    case "turn_end":
      return { ...next, activeTurnId: undefined };
    case "message_start":
      return startMessage(next, event.message);
    case "message_update":
      return updateAssistant(next, event);
    case "message_end":
      return finishMessage(next, event.message);
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
        result: toJson(event.result),
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
    case "thinking_level_changed":
      return next;
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

function startMessage(snapshot: PiThreadSnapshot, message: PiMessage): PiThreadSnapshot {
  if (message.role === "toolResult") return snapshot;
  const id = createPiMessageNodeId(message, snapshot.nodes);
  const node = projectPiMessage({ id, parentId: snapshot.headId, message, finished: false });
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
      setStreamingPart(content, update.contentIndex, {
        ...part,
        argsText: part.argsText + update.delta,
        execution: "streaming-args",
      });
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

function finishMessage(snapshot: PiThreadSnapshot, message: PiMessage): PiThreadSnapshot {
  if (message.role === "toolResult") return applyToolResult(snapshot, message);
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

function applyToolResult(snapshot: PiThreadSnapshot, message: PiToolResult): PiThreadSnapshot {
  return updateTool(snapshot, message.toolCallId, (part) => applyPiToolResult(part, message));
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
  return { ...snapshot, headId: node.id, nodes: [...snapshot.nodes, node] };
}

function replaceNode(snapshot: PiThreadSnapshot, index: number, node: PiTimelineNode): PiThreadSnapshot {
  const nodes = [...snapshot.nodes];
  nodes[index] = node;
  return { ...snapshot, headId: snapshot.headId === snapshot.nodes[index]?.id ? node.id : snapshot.headId, nodes };
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

function recordNodeChange(previousNodes: readonly PiTimelineNode[], nextNodes: readonly PiTimelineNode[]): void {
  if (previousNodes === nextNodes) return;
  let dirtyFrom = 0;
  const sharedLength = Math.min(previousNodes.length, nextNodes.length);
  while (dirtyFrom < sharedLength && previousNodes[dirtyFrom] === nextNodes[dirtyFrom]) dirtyFrom += 1;
  nodeChanges.set(nextNodes, { previousNodes, dirtyFrom, rekeyedFrom: new Map() });
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
  };
}

function assertNever(value: never): never {
  throw new PiThreadStoreError(`未知 Pi RPC event: ${String(value)}`);
}
