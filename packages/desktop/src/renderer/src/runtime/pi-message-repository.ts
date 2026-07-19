import type { ExportedMessageRepository, ThreadAssistantMessagePart, ThreadMessage } from "@assistant-ui/react";
import type {
  PiAssistantMessage,
  PiAssistantNotificationPart,
  PiAssistantPart,
  PiNoticeMessage,
  PiThreadSnapshot,
  PiTimelineNode,
} from "../../../shared/contracts.ts";
import { getPiThreadNodesChange } from "./pi-thread-store.ts";

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

      const projectedId = node.id;
      for (const member of members) displayIds.set(member.id, projectedId);
      const item = {
        message: this.convertGroup(members),
        parentId: displayId(displayIds, node.parentId),
      };
      entries.push({ startIndex, endIndex: index, members, item });
      messages.push(item);
    }

    const projection = { nodes, entries, displayIds, messages };
    this.projection = projection;
    return projection;
  }

  private convertGroup(nodes: readonly PiTimelineNode[]): ThreadMessage {
    const first = nodes[0];
    if (!first) throw new Error("assistant-ui message group 不能为空");
    if (nodes.length === 1) return this.convert(first);
    if (first.kind !== "assistant") throw new Error("assistant-ui message group 必须以 assistant 开始");

    const cached = this.assistantGroups.get(first);
    if (cached && sameMembers(cached.members, nodes)) return cached.message;
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
    );
    this.assistantGroups.set(first, { members: [...nodes], message });
    return message;
  }

  private convert(node: PiTimelineNode): ThreadMessage {
    const cached = this.messages.get(node);
    if (cached) return cached;
    const message =
      node.kind === "assistant"
        ? this.assistantMessage(node, node.content, node)
        : node.kind === "user"
          ? userMessage(node)
          : noticeMessage(node);
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
        toolCallId: part.toolCallId,
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
  ): ThreadMessage {
    return {
      id: first.id,
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
  const change = getPiThreadNodesChange(nodes);
  if (change?.previousNodes === previous.nodes) return Math.min(change.dirtyFrom, nodes.length);

  const sharedLength = Math.min(previous.nodes.length, nodes.length);
  let index = 0;
  while (index < sharedLength && previous.nodes[index] === nodes[index]) index += 1;
  return index;
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
  if (current?.kind === "assistant" || (current?.kind === "notice" && current.noticeType !== "compaction")) {
    while (start > 0 && !isAssistantGroupBoundary(nodes[start - 1])) start -= 1;
  }
  return start;
}

function isAssistantGroupBoundary(node: PiTimelineNode | undefined): boolean {
  return !node || node.kind === "user" || (node.kind === "notice" && node.noticeType === "compaction");
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

function userMessage(node: Extract<PiTimelineNode, { kind: "user" }>): ThreadMessage {
  const images = node.content.flatMap((part, index) => (part.type === "image" ? [{ part, index }] : []));
  return {
    id: node.id,
    role: "user",
    createdAt: new Date(node.createdAt),
    content: node.content.flatMap((part) => (part.type === "text" ? [{ type: "text" as const, text: part.text }] : [])),
    attachments: images.map(({ part, index }) => ({
      id: `${node.id}:image:${index}`,
      type: "image",
      name: imageName(part.mimeType, index),
      contentType: part.mimeType,
      status: { type: "complete" },
      content: [
        {
          type: "image",
          image: `data:${part.mimeType};base64,${part.data}`,
          filename: imageName(part.mimeType, index),
        },
      ],
    })),
    metadata: {
      custom: {
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

function noticeMessage(node: Extract<PiTimelineNode, { kind: "notice" }>): ThreadMessage {
  return {
    id: node.id,
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
    title: part.text,
    content: { type: "text", text: part.text },
  };
}

function imageName(mimeType: string, index: number): string {
  const extension = mimeType === "image/jpeg" ? "jpg" : mimeType.split("/")[1]?.replace("+xml", "") || "img";
  return `image-${index + 1}.${extension}`;
}
