import {
  type PiAssistantMessage,
  type PiAssistantPart,
  type PiThreadEvent,
  type PiThreadEventBatch,
  type PiThreadSnapshot,
  type PiTimelineNode,
  PROTOCOL_VERSION,
} from "../../../shared/contracts.ts";

type Listener = () => void;

interface SnapshotIndexes {
  nodeIndexes: Map<string, number>;
  partIndexes: Map<string, Map<string, number>>;
}

interface PiThreadNodesChange {
  previousNodes: readonly PiTimelineNode[];
  dirtyFrom: number;
}

const nodeChanges = new WeakMap<readonly PiTimelineNode[], PiThreadNodesChange>();

/**
 * 返回由 PiThreadStore 记录的结构共享边界，供线性 projection 只重建变化后缀。
 * 非本 store 生成的 snapshot 没有提示，调用方必须退回完整一致性检查。
 */
export function getPiThreadNodesChange(nodes: readonly PiTimelineNode[]): PiThreadNodesChange | undefined {
  return nodeChanges.get(nodes);
}

/** 保持 Pi timeline identity，并以事务方式应用一个 event batch。 */
export class PiThreadStore {
  private state: PiThreadSnapshot;
  private nodeIndexes: Map<string, number>;
  private partIndexes: Map<string, Map<string, number>>;
  private readonly listeners = new Set<Listener>();

  constructor(initial: PiThreadSnapshot = detachedSnapshot()) {
    const indexes = indexSnapshot(initial);
    this.state = initial;
    this.nodeIndexes = indexes.nodeIndexes;
    this.partIndexes = indexes.partIndexes;
  }

  getSnapshot = (): PiThreadSnapshot => this.state;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  replace(snapshot: PiThreadSnapshot): void {
    const indexes = indexSnapshot(snapshot);
    const previousNodes = this.state.nodes;
    this.state = snapshot;
    this.nodeIndexes = indexes.nodeIndexes;
    this.partIndexes = indexes.partIndexes;
    recordNodeChange(previousNodes, snapshot.nodes, 0);
    this.notify();
  }

  apply(batch: PiThreadEventBatch): void {
    validateBatch(batch, this.state);
    if (batch.toSequence <= this.state.cursor) return;

    let firstNewEvent = 0;
    while (
      batch.events[firstNewEvent]?.sequence !== undefined &&
      batch.events[firstNewEvent]!.sequence <= this.state.cursor
    ) {
      firstNewEvent += 1;
    }
    const firstSequence = batch.events[firstNewEvent]?.sequence;
    if (firstSequence !== this.state.cursor + 1)
      throw new PiThreadStoreError(`timeline sequence gap: ${this.state.cursor} -> ${String(firstSequence)}`);

    const mutation = new PiThreadBatchMutation(this.state, this.nodeIndexes, this.partIndexes);
    for (let index = firstNewEvent; index < batch.events.length; index += 1) {
      const envelope = batch.events[index];
      if (envelope) mutation.apply(envelope.event, envelope.sequence);
    }
    const result = mutation.finish();
    recordNodeChange(this.state.nodes, result.snapshot.nodes, result.dirtyFrom);
    this.state = result.snapshot;
    this.nodeIndexes = result.nodeIndexes;
    this.partIndexes = result.partIndexes;
    this.notify();
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

/**
 * batch 内部可以原地修改自己新建的数组；提交前不会暴露这些引用。
 * node/part 索引采用 copy-on-write，任一 event 失败时原 store 与索引均保持不变。
 */
class PiThreadBatchMutation {
  private protocolVersion: PiThreadSnapshot["protocolVersion"];
  private projectId: string;
  private threadId: string;
  private cursor: number;
  private headId: string | null;
  private nodes: readonly PiTimelineNode[];
  private queue: PiThreadSnapshot["queue"];
  private phase: PiThreadSnapshot["phase"];
  private activeTurnId: string | undefined;
  private nodesOwned = false;
  private nodeIndexesOwned = false;
  private partIndexesOwned = false;
  private nodeIndexes: Map<string, number>;
  private partIndexes: Map<string, Map<string, number>>;
  private mutableAssistantIndexes = new Set<number>();
  private mutablePartIndexes = new Set<string>();
  private dirtyFrom = Number.POSITIVE_INFINITY;

  constructor(
    snapshot: PiThreadSnapshot,
    nodeIndexes: Map<string, number>,
    partIndexes: Map<string, Map<string, number>>,
  ) {
    this.protocolVersion = snapshot.protocolVersion;
    this.projectId = snapshot.projectId;
    this.threadId = snapshot.threadId;
    this.cursor = snapshot.cursor;
    this.headId = snapshot.headId;
    this.nodes = snapshot.nodes;
    this.queue = snapshot.queue;
    this.phase = snapshot.phase;
    this.activeTurnId = snapshot.activeTurnId;
    this.nodeIndexes = nodeIndexes;
    this.partIndexes = partIndexes;
  }

  apply(event: PiThreadEvent, sequence: number): void {
    this.cursor = sequence;
    switch (event.type) {
      case "phase-changed":
        this.phase = event.phase;
        this.activeTurnId = event.activeTurnId;
        return;
      case "node-added":
        this.addNode(event.node);
        return;
      case "node-rekeyed":
        this.rekeyNode(event.previousId, event.node);
        return;
      case "node-replaced":
        this.replaceNode(event.node);
        return;
      case "part-added":
        this.addPart(event.messageId, event.part);
        return;
      case "text-delta":
      case "reasoning-delta":
        this.appendPartText(event.messageId, event.partId, event.delta, event.type);
        return;
      case "tool-call-replaced":
        this.replaceToolPart(event.messageId, event.part);
        return;
      case "message-finished":
        this.replaceNode(event.message);
        return;
      case "queue-replaced":
        this.queue = event.items;
        return;
      case "branch-replaced":
        this.replaceBranch(event.snapshot, sequence);
        return;
      default:
        assertNever(event);
    }
  }

  finish(): {
    snapshot: PiThreadSnapshot;
    nodeIndexes: Map<string, number>;
    partIndexes: Map<string, Map<string, number>>;
    dirtyFrom: number;
  } {
    return {
      snapshot: {
        protocolVersion: this.protocolVersion,
        projectId: this.projectId,
        threadId: this.threadId,
        cursor: this.cursor,
        headId: this.headId,
        nodes: this.nodes,
        queue: this.queue,
        phase: this.phase,
        ...(this.activeTurnId !== undefined ? { activeTurnId: this.activeTurnId } : {}),
      },
      nodeIndexes: this.nodeIndexes,
      partIndexes: this.partIndexes,
      dirtyFrom: this.dirtyFrom,
    };
  }

  private addNode(node: PiTimelineNode): void {
    if (this.nodeIndexes.has(node.id)) throw new PiThreadStoreError(`重复 timeline node: ${node.id}`);
    this.assertParent(node.parentId);
    const nodes = this.ensureNodes();
    const index = nodes.length;
    nodes.push(node);
    this.ensureNodeIndexes().set(node.id, index);
    this.replacePartIndex(node);
    this.headId = node.id;
    this.markDirty(index);
  }

  private replaceNode(node: PiTimelineNode): void {
    const index = this.requireNodeIndex(node.id);
    this.assertParent(node.parentId);
    this.ensureNodes()[index] = node;
    this.mutableAssistantIndexes.delete(index);
    this.replacePartIndex(node);
    this.markDirty(index);
  }

  private rekeyNode(previousId: string, node: PiTimelineNode): void {
    const index = this.requireNodeIndex(previousId);
    if (previousId !== node.id && this.nodeIndexes.has(node.id))
      throw new PiThreadStoreError(`rekey 目标已存在: ${node.id}`);
    this.assertParent(node.parentId);

    const nodes = this.ensureNodes();
    for (let currentIndex = 0; currentIndex < nodes.length; currentIndex += 1) {
      const current = nodes[currentIndex];
      if (!current) continue;
      if (currentIndex === index) {
        nodes[currentIndex] = node;
        this.mutableAssistantIndexes.delete(currentIndex);
        this.markDirty(currentIndex);
      } else if (current.parentId === previousId) {
        nodes[currentIndex] = { ...current, parentId: node.id };
        this.markDirty(currentIndex);
      }
    }

    const nodeIndexes = this.ensureNodeIndexes();
    nodeIndexes.delete(previousId);
    nodeIndexes.set(node.id, index);
    const partIndexes = this.ensurePartIndexes();
    partIndexes.delete(previousId);
    this.mutablePartIndexes.delete(previousId);
    if (node.kind === "assistant") {
      partIndexes.set(node.id, indexAssistantParts(node));
      this.mutablePartIndexes.add(node.id);
    }
    if (this.headId === previousId) this.headId = node.id;
  }

  private addPart(messageId: string, part: PiAssistantPart): void {
    const currentPartIndexes = this.partIndexes.get(messageId);
    if (currentPartIndexes?.has(part.id)) throw new PiThreadStoreError(`重复 assistant part: ${part.id}`);
    const message = this.ensureMutableAssistant(messageId);
    message.content.push(part);
    this.ensureMutablePartIndex(messageId).set(part.id, message.content.length - 1);
  }

  private appendPartText(
    messageId: string,
    partId: string,
    delta: string,
    eventType: "text-delta" | "reasoning-delta",
  ): void {
    const partIndex = this.requirePartIndex(messageId, partId);
    const message = this.ensureMutableAssistant(messageId);
    const part = message.content[partIndex];
    if (!part) throw new PiThreadStoreError(`delta part 不存在: ${partId}`);
    if (eventType === "text-delta") {
      if (part.type !== "text") throw new PiThreadStoreError(`text delta part 类型错误: ${partId}`);
    } else if (part.type !== "reasoning") {
      throw new PiThreadStoreError(`reasoning delta part 类型错误: ${partId}`);
    }
    message.content[partIndex] = { ...part, text: part.text + delta };
  }

  private replaceToolPart(messageId: string, part: Extract<PiAssistantPart, { type: "tool-call" }>): void {
    const partIndex = this.requirePartIndex(messageId, part.id);
    const message = this.ensureMutableAssistant(messageId);
    if (message.content[partIndex]?.type !== "tool-call")
      throw new PiThreadStoreError(`tool part 类型错误: ${part.id}`);
    message.content[partIndex] = part;
  }

  private replaceBranch(snapshot: PiThreadSnapshot, sequence: number): void {
    const indexes = indexSnapshot(snapshot);
    if (snapshot.projectId !== this.projectId || snapshot.threadId !== this.threadId)
      throw new PiThreadStoreError("branch snapshot session 不匹配");
    if (snapshot.cursor !== sequence) throw new PiThreadStoreError("branch snapshot cursor 不匹配");
    this.protocolVersion = snapshot.protocolVersion;
    this.cursor = snapshot.cursor;
    this.headId = snapshot.headId;
    this.nodes = snapshot.nodes;
    this.queue = snapshot.queue;
    this.phase = snapshot.phase;
    this.activeTurnId = snapshot.activeTurnId;
    this.nodesOwned = false;
    this.nodeIndexes = indexes.nodeIndexes;
    this.nodeIndexesOwned = true;
    this.partIndexes = indexes.partIndexes;
    this.partIndexesOwned = true;
    this.mutableAssistantIndexes = new Set();
    this.mutablePartIndexes = new Set(indexes.partIndexes.keys());
    this.markDirty(0);
  }

  private ensureMutableAssistant(messageId: string): PiAssistantMessage {
    const index = this.requireNodeIndex(messageId);
    const current = this.nodes[index];
    if (!current || current.kind !== "assistant") throw new PiThreadStoreError(`assistant node 不存在: ${messageId}`);
    if (this.mutableAssistantIndexes.has(index)) return current;
    const message = { ...current, content: [...current.content] };
    this.ensureNodes()[index] = message;
    this.mutableAssistantIndexes.add(index);
    this.markDirty(index);
    return message;
  }

  private ensureMutablePartIndex(messageId: string): Map<string, number> {
    const current = this.partIndexes.get(messageId);
    if (!current) throw new PiThreadStoreError(`assistant node 不存在: ${messageId}`);
    if (this.mutablePartIndexes.has(messageId)) return current;
    const next = new Map(current);
    this.ensurePartIndexes().set(messageId, next);
    this.mutablePartIndexes.add(messageId);
    return next;
  }

  private replacePartIndex(node: PiTimelineNode): void {
    const partIndexes = this.ensurePartIndexes();
    this.mutablePartIndexes.delete(node.id);
    if (node.kind === "assistant") {
      partIndexes.set(node.id, indexAssistantParts(node));
      this.mutablePartIndexes.add(node.id);
    } else {
      partIndexes.delete(node.id);
    }
  }

  private requireNodeIndex(nodeId: string): number {
    const index = this.nodeIndexes.get(nodeId);
    if (index === undefined) throw new PiThreadStoreError(`timeline node 不存在: ${nodeId}`);
    return index;
  }

  private requirePartIndex(messageId: string, partId: string): number {
    if (!this.nodeIndexes.has(messageId)) throw new PiThreadStoreError(`assistant node 不存在: ${messageId}`);
    const index = this.partIndexes.get(messageId)?.get(partId);
    if (index === undefined) throw new PiThreadStoreError(`delta part 不存在: ${partId}`);
    return index;
  }

  private assertParent(parentId: string | null): void {
    if (parentId !== null && !this.nodeIndexes.has(parentId))
      throw new PiThreadStoreError(`timeline parent 不存在: ${parentId}`);
  }

  private ensureNodes(): PiTimelineNode[] {
    if (!this.nodesOwned) {
      this.nodes = [...this.nodes];
      this.nodesOwned = true;
    }
    return this.nodes as PiTimelineNode[];
  }

  private ensureNodeIndexes(): Map<string, number> {
    if (!this.nodeIndexesOwned) {
      this.nodeIndexes = new Map(this.nodeIndexes);
      this.nodeIndexesOwned = true;
    }
    return this.nodeIndexes;
  }

  private ensurePartIndexes(): Map<string, Map<string, number>> {
    if (!this.partIndexesOwned) {
      this.partIndexes = new Map(this.partIndexes);
      this.partIndexesOwned = true;
    }
    return this.partIndexes;
  }

  private markDirty(index: number): void {
    this.dirtyFrom = Math.min(this.dirtyFrom, index);
  }
}

function indexSnapshot(snapshot: PiThreadSnapshot): SnapshotIndexes {
  if (snapshot.protocolVersion !== PROTOCOL_VERSION)
    throw new PiThreadStoreError(`不支持的 timeline protocol: ${snapshot.protocolVersion}`);
  const nodeIndexes = new Map<string, number>();
  const partIndexes = new Map<string, Map<string, number>>();
  for (let index = 0; index < snapshot.nodes.length; index += 1) {
    const node = snapshot.nodes[index];
    if (!node) continue;
    if (nodeIndexes.has(node.id)) throw new PiThreadStoreError(`重复 snapshot node: ${node.id}`);
    if (node.parentId !== null && !nodeIndexes.has(node.parentId))
      throw new PiThreadStoreError(`snapshot parent 顺序无效: ${node.parentId}`);
    nodeIndexes.set(node.id, index);
    if (node.kind === "assistant") partIndexes.set(node.id, indexAssistantParts(node));
  }
  if (snapshot.headId !== null && !nodeIndexes.has(snapshot.headId))
    throw new PiThreadStoreError(`snapshot head 不存在: ${snapshot.headId}`);
  return { nodeIndexes, partIndexes };
}

function indexAssistantParts(message: PiAssistantMessage): Map<string, number> {
  const indexes = new Map<string, number>();
  for (let index = 0; index < message.content.length; index += 1) {
    const part = message.content[index];
    if (!part) continue;
    if (indexes.has(part.id)) throw new PiThreadStoreError(`重复 assistant part: ${part.id}`);
    indexes.set(part.id, index);
  }
  return indexes;
}

function recordNodeChange(
  previousNodes: readonly PiTimelineNode[],
  nextNodes: readonly PiTimelineNode[],
  dirtyFrom: number,
): void {
  if (previousNodes === nextNodes) return;
  nodeChanges.set(nextNodes, {
    previousNodes,
    dirtyFrom: Number.isFinite(dirtyFrom) ? dirtyFrom : 0,
  });
}

function validateBatch(batch: PiThreadEventBatch, state: PiThreadSnapshot): void {
  if (batch.protocolVersion !== PROTOCOL_VERSION) throw new PiThreadStoreError("timeline batch protocol 不匹配");
  if (batch.projectId !== state.projectId || batch.threadId !== state.threadId)
    throw new PiThreadStoreError("timeline batch session 不匹配");
  let expected = batch.fromSequence;
  for (const envelope of batch.events) {
    if (envelope.protocolVersion !== PROTOCOL_VERSION)
      throw new PiThreadStoreError("timeline envelope protocol 不匹配");
    if (envelope.projectId !== batch.projectId || envelope.threadId !== batch.threadId)
      throw new PiThreadStoreError("timeline envelope session 不匹配");
    if (envelope.sequence !== expected) throw new PiThreadStoreError(`batch sequence 不连续: ${expected}`);
    expected += 1;
  }
  if (expected - 1 !== batch.toSequence) throw new PiThreadStoreError("batch toSequence 与 events 不匹配");
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
  throw new PiThreadStoreError(`未知 timeline event: ${String(value)}`);
}
