import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type {
  PiQuote,
  PiThreadSnapshot,
  PiTimelineNode,
  PiUserContentPart,
  ThinkingLevel,
} from "../../shared/contracts.ts";
import {
  applyPiToolResult,
  createPiMessageNodeId,
  piUserContent,
  projectPiMessage,
  type RegisterImageResource,
  toJson,
} from "../../shared/pi-message-projector.ts";
import { isThinkingLevel } from "../../shared/thinking-levels.ts";
import { parseQuoteAttachmentData, QUOTE_ATTACHMENT_CUSTOM_TYPE, stripQuotePrefix } from "./quote-context.ts";

export class ProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectionError";
  }
}

export interface PersistedBranchProjection {
  nodes: PiTimelineNode[];
  headId: string | null;
  thinkingLevel: ThinkingLevel;
}

/** Projects Pi's persisted active branch into Desktop's renderer snapshot. */
export function projectPersistedBranch(
  entries: readonly SessionEntry[],
  leafId: string | null,
  registerImageResource?: RegisterImageResource,
): PersistedBranchProjection {
  const branch = activeBranch(entries, leafId);
  const quoteAttachments = new Map<string, readonly PiQuote[]>();
  const labels = new Map<string, string | undefined>();
  for (const entry of branch) {
    if (entry.type === "custom" && entry.customType === QUOTE_ATTACHMENT_CUSTOM_TYPE) {
      const attachment = parseQuoteAttachmentData(entry.data);
      if (attachment) quoteAttachments.set(attachment.userEntryId, attachment.quotes);
    } else if (entry.type === "label") {
      labels.set(entry.targetId, entry.label);
    }
  }
  const nodes: PiTimelineNode[] = [];
  let headId: string | null = null;
  let thinkingLevel: ThinkingLevel = "off";
  const thinkingHistory: Array<{ level: ThinkingLevel; timestamp: number }> = [];

  for (const entry of branch) {
    switch (entry.type) {
      case "thinking_level_change":
        thinkingLevel = normalizeThinkingLevel(entry.thinkingLevel);
        thinkingHistory.push({ level: thinkingLevel, timestamp: timestampMs(entry.timestamp) });
        break;
      case "model_change":
      case "session_info":
        break;
      case "message": {
        const message = entry.message;
        if (message.role === "toolResult") {
          const assistantIndex = findAssistantByToolCall(nodes, message.toolCallId);
          if (assistantIndex === -1) break;
          const assistant = nodes[assistantIndex];
          if (!assistant || assistant.kind !== "assistant") break;
          const partIndex = assistant.content.findIndex(
            (part) => part.type === "tool-call" && part.toolCallId === message.toolCallId,
          );
          const part = assistant.content[partIndex];
          if (!part || part.type !== "tool-call") break;
          const content = [...assistant.content];
          content[partIndex] = applyPiToolResult(part, message, registerImageResource);
          nodes[assistantIndex] = { ...assistant, content };
          break;
        }

        const messageThinkingLevel =
          message.role === "assistant" ? thinkingLevelAt(message.timestamp, thinkingHistory) : thinkingLevel;
        const id = createPiMessageNodeId(message, nodes);
        const projected = projectPiMessage({
          id,
          sourceEntryId: entry.id,
          parentId: headId,
          message,
          finished: true,
          completedAt: timestampMs(entry.timestamp),
          thinkingLevel: messageThinkingLevel,
          registerImageResource,
        });
        if (!projected) break;
        const quotes = message.role === "user" ? quoteAttachments.get(entry.id) : undefined;
        const node = projected.kind === "user" && quotes?.length ? applyQuotes(projected, quotes) : projected;
        nodes.push(node);
        headId = node.id;
        break;
      }
      case "custom_message": {
        if (!entry.display) break;
        const node: PiTimelineNode = {
          id: entry.id,
          sourceEntryId: entry.id,
          parentId: headId,
          createdAt: timestampMs(entry.timestamp),
          kind: "notice",
          noticeType: "custom",
          title: entry.customType,
          content: {
            type: "custom",
            customType: entry.customType,
            content: piUserContent(entry.content, registerImageResource),
            ...(entry.details !== undefined ? { details: toJson(entry.details) } : {}),
          },
        };
        nodes.push(node);
        headId = node.id;
        break;
      }
      case "compaction": {
        const node: PiTimelineNode = {
          id: entry.id,
          sourceEntryId: entry.id,
          parentId: headId,
          createdAt: timestampMs(entry.timestamp),
          kind: "notice",
          noticeType: "compaction",
          title: "上下文压缩",
          content: { type: "text", text: entry.summary },
          metadata: toJson({
            firstKeptEntryId: entry.firstKeptEntryId,
            tokensBefore: entry.tokensBefore,
            ...(entry.details !== undefined ? { details: entry.details } : {}),
            ...(entry.usage !== undefined ? { usage: entry.usage } : {}),
            ...(entry.fromHook !== undefined ? { fromHook: entry.fromHook } : {}),
          }),
        };
        nodes.push(node);
        headId = node.id;
        break;
      }
      case "branch_summary": {
        const node: PiTimelineNode = {
          id: entry.id,
          sourceEntryId: entry.id,
          parentId: headId,
          createdAt: timestampMs(entry.timestamp),
          kind: "notice",
          noticeType: "branch-summary",
          title: "分支摘要",
          content: { type: "text", text: entry.summary },
          metadata: toJson({
            fromId: entry.fromId,
            ...(entry.details !== undefined ? { details: entry.details } : {}),
            ...(entry.usage !== undefined ? { usage: entry.usage } : {}),
            ...(entry.fromHook !== undefined ? { fromHook: entry.fromHook } : {}),
          }),
        };
        nodes.push(node);
        headId = node.id;
        break;
      }
      case "custom":
      case "label":
        break;
      default:
        assertNever(entry);
    }
  }

  return {
    nodes: nodes.map((node) => {
      const label = labels.get(node.sourceEntryId ?? node.id);
      return label ? { ...node, label } : node;
    }),
    headId,
    thinkingLevel,
  };
}

export function snapshotFromProjection(
  projection: PersistedBranchProjection,
  options: Pick<PiThreadSnapshot, "protocolVersion" | "projectId" | "threadId" | "cursor" | "queue" | "phase">,
): PiThreadSnapshot {
  return {
    ...options,
    headId: projection.headId,
    nodes: projection.nodes,
    thinkingLevel: projection.thinkingLevel,
  };
}

function activeBranch(entries: readonly SessionEntry[], leafId: string | null): SessionEntry[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  if (byId.size !== entries.length) throw new ProjectionError("RPC session contains duplicate entry ids");
  if (leafId === null) return [];
  const reversed: SessionEntry[] = [];
  const seen = new Set<string>();
  let current: string | null = leafId;
  while (current !== null) {
    if (seen.has(current)) throw new ProjectionError(`RPC session branch contains a cycle at ${current}`);
    seen.add(current);
    const entry = byId.get(current);
    if (!entry) throw new ProjectionError(`RPC session parent does not exist: ${current}`);
    reversed.push(entry);
    current = entry.parentId;
  }
  return reversed.reverse();
}

function applyQuotes(
  node: Extract<PiTimelineNode, { kind: "user" }>,
  quotes: readonly PiQuote[],
): Extract<PiTimelineNode, { kind: "user" }> {
  const content = stripQuotedContent(node.content, quotes);
  const first = quotes[0];
  return {
    ...node,
    content,
    ...(quotes.length === 1 && first ? { quote: first } : { quotes: [...quotes] }),
  };
}

function stripQuotedContent(content: readonly PiUserContentPart[], quotes: readonly PiQuote[]): PiUserContentPart[] {
  const first = content[0];
  if (!first || first.type !== "text") return [...content];
  const stripped = stripQuotePrefix(first.text, quotes);
  if (stripped === first.text) return [...content];
  const rest = content.slice(1);
  return stripped.length === 0 ? rest : [{ type: "text", text: stripped }, ...rest];
}

function findAssistantByToolCall(nodes: readonly PiTimelineNode[], toolCallId: string): number {
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index];
    if (
      node?.kind === "assistant" &&
      node.content.some((part) => part.type === "tool-call" && part.toolCallId === toolCallId)
    ) {
      return index;
    }
  }
  return -1;
}

function timestampMs(value: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new ProjectionError(`RPC session timestamp is invalid: ${value}`);
  return timestamp;
}

function normalizeThinkingLevel(value: string): ThinkingLevel {
  return isThinkingLevel(value) ? value : "off";
}

function thinkingLevelAt(
  timestamp: number,
  history: readonly { level: ThinkingLevel; timestamp: number }[],
): ThinkingLevel {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const change = history[index];
    if (change && change.timestamp <= timestamp) return change.level;
  }
  return "off";
}

function assertNever(value: never): never {
  throw new ProjectionError(`Unsupported RPC session entry: ${String(value)}`);
}
