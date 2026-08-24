import type {
  CompleteAttachment,
  ExportedMessageRepository,
  ThreadAssistantMessagePart,
  ThreadMessage,
  ThreadUserMessagePart,
} from "@assistant-ui/react";
import type {
  PiAssistantMessage,
  PiAssistantNotificationPart,
  PiAssistantPart,
  PiNoticeMessage,
  PiThreadSnapshot,
  PiTimelineNode,
} from "../../../shared/contracts.ts";
import { getPiThreadNodesChange } from "../../../shared/pi-thread-store.ts";

type RepositoryItem = ExportedMessageRepository["messages"][number];
type PiNoticePart = {
  type: "data";
  name: "pi-notice";
  data: Extract<PiTimelineNode, { kind: "notice" }>;
};

interface ProjectionEntry {
  startIndex: number;
  endIndex: number;
  members: readonly PiTimelineNode[];
  item: RepositoryItem;
}

interface ProjectionCache {
  nodes: readonly PiTimelineNode[];
  entries: readonly ProjectionEntry[];
  displayIds: ReadonlyMap<string, string>;
  messages: ExportedMessageRepository["messages"];
}

interface RepositoryCache {
  headId: string | null;
  messages: ExportedMessageRepository["messages"];
  repository: ExportedMessageRepository;
}

/** 将 Pi timeline 增量投影为 assistant-ui repository，并把 identity 保持到 message part。 */
export class PiMessageRepositoryConverter {
  private readonly messages = new WeakMap<PiTimelineNode, ThreadMessage>();
  private readonly assistantParts = new WeakMap<PiAssistantPart, ThreadAssistantMessagePart | null>();
  private readonly assistantGroups = new WeakMap<
    PiAssistantMessage,
    { members: readonly PiTimelineNode[]; message: ThreadMessage }
  >();
  private projection: ProjectionCache | undefined;
  private repository: RepositoryCache | undefined;

  build(snapshot: PiThreadSnapshot): ExportedMessageRepository {
    const projection = this.project(snapshot.nodes);
    const headId = displayId(projection.displayIds, snapshot.headId);
    if (this.repository?.messages === projection.messages && this.repository.headId === headId) {
      return this.repository.repository;
    }
    const repository = { headId, messages: projection.messages };
    this.repository = { headId, messages: projection.messages, repository };
    return repository;
  }

  /** 复用未变化 projection 前缀；连续 assistant group 从首个受影响成员开始重建。 */
  private project(nodes: readonly PiTimelineNode[]): ProjectionCache {
    const previous = this.projection;
    if (previous?.nodes === nodes) return previous;

    const dirtyFrom = projectionDirtyFrom(previous, nodes);
    if (previous && dirtyFrom === nodes.length && dirtyFrom === previous.nodes.length) {
      const unchanged = { ...previous, nodes };
      this.projection = unchanged;
      return unchanged;
    }

    const rebuildFrom = projectionRebuildStart(previous, nodes, dirtyFrom);
    const prefixCount = previous ? firstEntryEndingAfter(previous.entries, rebuildFrom) : 0;
    const entries = previous ? previous.entries.slice(0, prefixCount) : [];
    const messages = previous ? previous.messages.slice(0, prefixCount) : [];
    const displayIds = new Map(previous?.displayIds);
    if (previous) {
      for (let index = prefixCount; index < previous.entries.length; index += 1) {
        for (const member of previous.entries[index]?.members ?? []) displayIds.delete(member.id);
      }
    }

    let index = rebuildFrom;
    while (index < nodes.length) {
      const startIndex = index;
      const node = nodes[index];
      if (!node) break;
      const members: PiTimelineNode[] = [node];
      index += 1;
      if (node.kind === "assistant") {
        let groupEnd = index;
        while (groupEnd < nodes.length && !isAssistantGroupBoundary(nodes[groupEnd])) groupEnd += 1;
        while (index < groupEnd) {
          const member = nodes[index];
          if (member) members.push(member);
          index += 1;
        }
      }

      const projectedId = resolveProjectedId(previous, nodes, startIndex, node);
      for (const member of members) displayIds.set(member.id, projectedId);
      const item = {
        message: this.convertGroup(members, projectedId),
        parentId: displayId(displayIds, node.parentId),
      };
      entries.push({ startIndex, endIndex: index, members, item });
      messages.push(item);
    }

    const projection = { nodes, entries, displayIds, messages };
    this.projection = projection;
    return projection;
  }

  private convertGroup(nodes: readonly PiTimelineNode[], projectedId: string): ThreadMessage {
    const first = nodes[0];
    if (!first) throw new Error("assistant-ui message group 不能为空");
    if (nodes.length === 1) return this.convert(first, projectedId);
    if (first.kind !== "assistant") throw new Error("assistant-ui message group 必须以 assistant 开始");

    const cached = this.assistantGroups.get(first);
    if (cached && cached.message.id === projectedId && sameMembers(cached.members, nodes)) return cached.message;
    const lastAssistant = nodes.findLast((node): node is PiAssistantMessage => node.kind === "assistant");
    if (!lastAssistant) throw new Error("assistant-ui message group 缺少 assistant");
    const message = this.assistantMessage(
      first,
      nodes.flatMap<PiAssistantPart | PiNoticePart>((member) =>
        member.kind === "assistant"
          ? member.content
          : member.kind === "notice"
            ? [{ type: "data" as const, name: "pi-notice", data: member }]
            : [],
      ),
      lastAssistant,
      projectedId,
    );
    this.assistantGroups.set(first, { members: [...nodes], message });
    return message;
  }

  private convert(node: PiTimelineNode, projectedId: string): ThreadMessage {
    const cached = this.messages.get(node);
    if (cached?.id === projectedId) return cached;
    const message =
      node.kind === "assistant"
        ? this.assistantMessage(node, node.content, node, projectedId)
        : node.kind === "user"
          ? userMessage(node, projectedId)
          : noticeMessage(node, projectedId);
    this.messages.set(node, message);
    return message;
  }

  /** PiThreadStore 只 clone 目标 part；WeakMap 将该引用边界原样传给 assistant-ui。 */
  private assistantPart(part: PiAssistantPart): ThreadAssistantMessagePart | null {
    const cached = this.assistantParts.get(part);
    if (cached !== undefined) return cached;
    let converted: ThreadAssistantMessagePart | null;
    if (part.type === "text" || part.type === "reasoning") {
      converted = part.text.trim() ? { type: part.type, text: part.text } : null;
    } else if (part.type === "notification") {
      converted = { type: "data", name: "pi-notice", data: notificationNotice(part) };
    } else {
      converted = {
        type: "tool-call",
        // assistant-ui indexes tool parts by toolCallId inside the merged message.
        // Pi part IDs identify invocations, while provider tool-call IDs may repeat across turns.
        toolCallId: part.id,
        toolName: part.toolName,
        args: part.args,
        argsText: part.argsText,
        artifact: { execution: part.execution, partialResult: part.partialResult },
        ...(part.result !== undefined ? { result: part.result } : {}),
        ...(part.isError !== undefined ? { isError: part.isError } : {}),
      };
    }
    this.assistantParts.set(part, converted);
    return converted;
  }

  private assistantMessage(
    first: PiAssistantMessage,
    parts: readonly (PiAssistantPart | PiNoticePart)[],
    last: PiAssistantMessage,
    projectedId: string,
  ): ThreadMessage {
    return {
      id: projectedId,
      role: "assistant",
      createdAt: new Date(first.createdAt),
      content: parts.flatMap((part) => {
        if (part.type === "data") return [part];
        const converted = this.assistantPart(part);
        return converted ? [converted] : [];
      }),
      status: last.status,
      metadata: {
        unstable_state: null,
        unstable_annotations: [],
        unstable_data: [],
        steps: [],
        custom: {
          pi: {
            kind: "assistant",
            ...(last.sourceEntryId ? { sourceEntryId: last.sourceEntryId } : {}),
            ...(last.label ? { label: last.label } : {}),
            status: last.status,
            ...(last.completedAt !== undefined ? { completedAt: last.completedAt } : {}),
            provenance: last.provenance,
            usage: last.usage,
            ...(last.diagnostics !== undefined ? { diagnostics: last.diagnostics } : {}),
          },
        },
      },
    };
  }
}

function projectionDirtyFrom(previous: ProjectionCache | undefined, nodes: readonly PiTimelineNode[]): number {
  if (!previous) return 0;
  const change = getPiThreadNodesChange(nodes, previous.nodes);
  if (change) return Math.min(change.dirtyFrom, nodes.length);

  const sharedLength = Math.min(previous.nodes.length, nodes.length);
  let index = 0;
  while (index < sharedLength && previous.nodes[index] === nodes[index]) index += 1;
  return index;
}

/** canonical rekey 只更新 timeline identity；assistant-ui display identity 必须跨该边界稳定。 */
function resolveProjectedId(
  previous: ProjectionCache | undefined,
  nodes: readonly PiTimelineNode[],
  index: number,
  node: PiTimelineNode,
): string {
  if (!previous) return node.id;
  const change = getPiThreadNodesChange(nodes, previous.nodes);
  if (!change) return node.id;
  const previousId = change.rekeyedFrom.get(index);
  if (previousId === undefined) return previous.displayIds.get(node.id) ?? node.id;
  if (node.sourceEntryId !== node.id) return node.id;
  return previous.displayIds.get(previousId) ?? node.id;
}

function projectionRebuildStart(
  previous: ProjectionCache | undefined,
  nodes: readonly PiTimelineNode[],
  dirtyFrom: number,
): number {
  let start = Math.min(dirtyFrom, nodes.length);
  if (previous && dirtyFrom < previous.nodes.length) {
    const affected = entryContaining(previous.entries, dirtyFrom);
    if (affected) start = Math.min(start, affected.startIndex);
  }
  const current = nodes[start];
  if (current && current.kind !== "user") {
    while (start > 0 && !isAssistantGroupBoundary(nodes[start - 1])) start -= 1;
  }
  return start;
}

function isAssistantGroupBoundary(node: PiTimelineNode | undefined): boolean {
  return !node || node.kind === "user";
}

function entryContaining(entries: readonly ProjectionEntry[], nodeIndex: number): ProjectionEntry | undefined {
  let low = 0;
  let high = entries.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const entry = entries[middle];
    if (!entry) return undefined;
    if (nodeIndex < entry.startIndex) high = middle - 1;
    else if (nodeIndex >= entry.endIndex) low = middle + 1;
    else return entry;
  }
  return undefined;
}

function firstEntryEndingAfter(entries: readonly ProjectionEntry[], nodeIndex: number): number {
  let low = 0;
  let high = entries.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((entries[middle]?.endIndex ?? Number.POSITIVE_INFINITY) <= nodeIndex) low = middle + 1;
    else high = middle;
  }
  return low;
}

function displayId(displayIds: ReadonlyMap<string, string>, id: string | null): string | null {
  return id ? (displayIds.get(id) ?? id) : null;
}

function sameMembers(left: readonly PiTimelineNode[], right: readonly PiTimelineNode[]): boolean {
  return left.length === right.length && left.every((node, index) => node === right[index]);
}

function userMessage(node: Extract<PiTimelineNode, { kind: "user" }>, projectedId: string): ThreadMessage {
  const content: ThreadUserMessagePart[] = [];
  const attachments: CompleteAttachment[] = [];
  for (const [partIndex, part] of node.content.entries()) {
    if (part.type === "image") {
      const name = imageName(part.mimeType, partIndex);
      attachments.push({
        id: `${projectedId}:image:${partIndex}`,
        type: "image",
        name,
        contentType: part.mimeType,
        status: { type: "complete" },
        content: [{ type: "image", image: toSessionImageResourceUrl(part), filename: name }],
      });
      continue;
    }

    const parsed = parsePiFileContexts(part.text);
    if (parsed.text || parsed.files.length === 0) content.push({ type: "text", text: parsed.text });
    for (const [fileIndex, file] of parsed.files.entries()) {
      attachments.push({
        id: `${projectedId}:file:${partIndex}:${fileIndex}`,
        type: "file",
        name: file.name,
        contentType: "application/octet-stream",
        status: { type: "complete" },
        content: [
          {
            type: "file",
            data: file.path,
            filename: file.name,
            mimeType: "application/octet-stream",
          },
        ],
      });
    }
  }
  return {
    id: projectedId,
    role: "user",
    createdAt: new Date(node.createdAt),
    content,
    attachments,
    metadata: {
      custom: {
        ...(node.quotes ? { quotes: node.quotes } : node.quote ? { quote: node.quote } : {}),
        pi: {
          kind: "user",
          ...(node.sourceEntryId ? { sourceEntryId: node.sourceEntryId } : {}),
          ...(node.label ? { label: node.label } : {}),
          delivery: node.delivery,
        },
      },
    },
  };
}

function noticeMessage(node: Extract<PiTimelineNode, { kind: "notice" }>, projectedId: string): ThreadMessage {
  return {
    id: projectedId,
    role: "assistant",
    createdAt: new Date(node.createdAt),
    content: [{ type: "data", name: "pi-notice", data: node }],
    status: { type: "complete", reason: "unknown" },
    metadata: {
      unstable_state: null,
      unstable_annotations: [],
      unstable_data: [],
      steps: [],
      custom: {
        pi: {
          kind: "notice",
          ...(node.sourceEntryId ? { sourceEntryId: node.sourceEntryId } : {}),
          ...(node.label ? { label: node.label } : {}),
        },
      },
    },
  };
}

function notificationNotice(part: PiAssistantNotificationPart): PiNoticeMessage {
  return {
    id: part.id,
    parentId: null,
    createdAt: part.createdAt,
    kind: "notice",
    noticeType: "notification",
    notificationType: part.notificationType,
    ...(part.extensionNotification ? { extensionNotification: part.extensionNotification } : {}),
    title: part.text,
    content: { type: "text", text: part.text },
  };
}

function imageName(mimeType: string, index: number): string {
  const extension = mimeType === "image/jpeg" ? "jpg" : mimeType.split("/")[1]?.replace("+xml", "") || "img";
  return `image-${index + 1}.${extension}`;
}
