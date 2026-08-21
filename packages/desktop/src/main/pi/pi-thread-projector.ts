import { createHash, randomUUID } from "node:crypto";
import type {
  JsonValue,
  PiAssistantMessage,
  PiAssistantPart,
  PiAssistantStatus,
  PiQuote,
  PiTimelineNode,
  PiToolCallPart,
  PiUserContentPart,
  ThinkingLevel,
} from "../../shared/contracts.ts";
import { parseQuoteAttachmentData, QUOTE_ATTACHMENT_CUSTOM_TYPE, stripQuotePrefix } from "./quote-context.ts";

interface SessionEntryBase {
  id: string;
  parentId: string | null;
  timestamp: string;
}

interface AssistantUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number;
  reasoning?: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

type AssistantContent =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; redacted?: boolean }
  | { type: "toolCall"; id: string; name: string; arguments: unknown };

type AgentMessage =
  | { role: "user"; content: string | readonly unknown[]; timestamp: number }
  | {
      role: "assistant";
      content: AssistantContent[];
      api: string;
      provider: string;
      model: string;
      responseModel?: string;
      responseId?: string;
      usage: AssistantUsage;
      stopReason: "stop" | "toolUse" | "length" | "aborted" | "pending" | "error";
      errorMessage?: string;
      diagnostics?: unknown;
      timestamp: number;
    }
  | {
      role: "toolResult";
      toolCallId: string;
      content: unknown;
      details?: unknown;
      addedToolNames?: string[];
      usage?: unknown;
      isError: boolean;
      timestamp: number;
    }
  | {
      role: "bashExecution";
      command: string;
      output: string;
      exitCode?: number;
      cancelled: boolean;
      truncated: boolean;
      fullOutputPath?: string;
      excludeFromContext?: boolean;
      timestamp: number;
    }
  | {
      role: "custom";
      customType: string;
      content: string | readonly unknown[];
      details?: unknown;
      display: boolean;
      timestamp: number;
    }
  | { role: "compactionSummary"; summary: string; tokensBefore: number; timestamp: number }
  | { role: "branchSummary"; summary: string; fromId: string; timestamp: number };

type SessionEntry = SessionEntryBase &
  (
    | { type: "message"; message: AgentMessage }
    | { type: "thinking_level_change"; thinkingLevel: ThinkingLevel }
    | { type: "model_change" }
    | {
        type: "compaction";
        summary: string;
        firstKeptEntryId: string;
        tokensBefore: number;
        fromHook?: boolean;
        details?: unknown;
      }
    | { type: "branch_summary"; summary: string; fromId: string; fromHook?: boolean; details?: unknown }
    | { type: "custom"; customType: string; data: unknown }
    | {
        type: "custom_message";
        customType: string;
        content: string | readonly unknown[];
        details?: unknown;
        display: boolean;
      }
    | { type: "label"; targetId: string; label?: string }
    | { type: "session_info" }
  );

type AssistantMessage = Extract<AgentMessage, { role: "assistant" }>;
type CustomMessage = Extract<AgentMessage, { role: "custom" }>;

export interface PersistedBranchProjection {
  nodes: PiTimelineNode[];
  headId: string | null;
  thinkingLevel: ThinkingLevel;
}

/** Projects the current persisted RPC branch without requiring an in-process Pi session. */
export function projectPersistedBranch(
  untrustedEntries: readonly unknown[],
  leafId: string | null,
): PersistedBranchProjection {
  const entries = untrustedEntries.map((entry, index) => {
    if (!isSessionEntry(entry)) throw new ProjectionError(`RPC session entry ${index} is malformed`);
    return entry;
  });
  const byEntryId = new Map(entries.map((entry) => [entry.id, entry]));
  if (leafId && !byEntryId.has(leafId)) throw new ProjectionError(`RPC session leaf does not exist: ${leafId}`);
  const branch: SessionEntry[] = [];
  const visited = new Set<string>();
  let entry = leafId ? byEntryId.get(leafId) : undefined;
  while (entry) {
    if (visited.has(entry.id)) throw new ProjectionError(`RPC session branch contains a cycle at ${entry.id}`);
    visited.add(entry.id);
    branch.push(entry);
    if (entry.parentId && !byEntryId.has(entry.parentId)) {
      throw new ProjectionError(`RPC session parent does not exist: ${entry.parentId}`);
    }
    entry = entry.parentId ? byEntryId.get(entry.parentId) : undefined;
  }
  branch.reverse();

  const quoteAttachments = new Map<string, readonly PiQuote[]>();
  const labels = new Map<string, string | undefined>();
  for (const current of branch) {
    if (current.type === "custom" && current.customType === QUOTE_ATTACHMENT_CUSTOM_TYPE) {
      const attachment = parseQuoteAttachmentData(current.data);
      if (attachment) quoteAttachments.set(attachment.userEntryId, attachment.quotes);
    } else if (current.type === "label") {
      labels.set(current.targetId, current.label);
    }
  }

  const nodes: PiTimelineNode[] = [];
  const visibleByEntryId = new Map<string, string | null>();
  const toolOwners = new Map<string, { nodeIndex: number; partIndex: number }>();
  let thinkingLevel: ThinkingLevel = "off";
  for (const current of branch) {
    if (current.type === "thinking_level_change") thinkingLevel = current.thinkingLevel;
    const parentId = current.parentId ? (visibleByEntryId.get(current.parentId) ?? null) : null;
    const node = projectEntry(current, parentId, thinkingLevel, quoteAttachments.get(current.id));
    if (!node) {
      if (current.type === "message" && current.message.role === "toolResult") {
        const owner = toolOwners.get(current.message.toolCallId);
        const ownerNode = owner ? nodes[owner.nodeIndex] : undefined;
        const ownerPart = ownerNode?.kind === "assistant" && owner ? ownerNode.content[owner.partIndex] : undefined;
        if (owner && ownerNode?.kind === "assistant" && ownerPart?.type === "tool-call") {
          const replacement: PiToolCallPart = {
            ...ownerPart,
            execution: current.message.isError ? "error" : "complete",
            result: toJson({
              content: current.message.content,
              ...(current.message.details !== undefined ? { details: current.message.details } : {}),
              ...(current.message.addedToolNames ? { addedToolNames: current.message.addedToolNames } : {}),
              ...(current.message.usage ? { usage: current.message.usage } : {}),
            }),
            isError: current.message.isError,
          };
          nodes[owner.nodeIndex] = {
            ...ownerNode,
            content: ownerNode.content.map((part, index) => (index === owner.partIndex ? replacement : part)),
          };
        }
      }
      visibleByEntryId.set(current.id, parentId);
      continue;
    }

    const nodeIndex = nodes.length;
    nodes.push(node);
    visibleByEntryId.set(current.id, node.id);
    if (node.kind === "assistant") {
      node.content.forEach((part, partIndex) => {
        if (part.type === "tool-call") toolOwners.set(part.toolCallId, { nodeIndex, partIndex });
      });
    }
  }

  return {
    nodes: nodes.map((node) => {
      const label = labels.get(node.sourceEntryId ?? node.id);
      return label ? { ...node, label } : node;
    }),
    headId: nodes.at(-1)?.id ?? null,
    thinkingLevel,
  };
}

export class ProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectionError";
  }
}

function isSessionEntry(value: unknown): value is SessionEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.type === "string" &&
    typeof entry.id === "string" &&
    (entry.parentId === null || typeof entry.parentId === "string") &&
    typeof entry.timestamp === "string"
  );
}

function projectEntry(
  entry: SessionEntry,
  parentId: string | null,
  thinkingLevel: ThinkingLevel,
  registerImageResource: (mimeType: string, data: string) => SessionImageResourceRef,
  quotes?: readonly PiQuote[],
): PiTimelineNode | undefined {
  const createdAt = timestamp(entry.timestamp);
  switch (entry.type) {
    case "message":
      return projectPersistedMessage(
        entry.id,
        parentId,
        createdAt,
        entry.message,
        thinkingLevel,
        registerImageResource,
        quotes,
      );
    case "custom_message":
      return entry.display
        ? {
            id: entry.id,
            sourceEntryId: entry.id,
            parentId,
            createdAt,
            kind: "notice",
            noticeType: "custom",
            title: entry.customType,
            content: {
              type: "custom",
              customType: entry.customType,
              content: userContent(entry.content, registerImageResource),
              ...(entry.details !== undefined ? { details: toJson(entry.details) } : {}),
            },
          }
        : undefined;
    case "compaction":
      return {
        id: entry.id,
        sourceEntryId: entry.id,
        parentId,
        createdAt,
        kind: "notice",
        noticeType: "compaction",
        title: "上下文压缩",
        content: { type: "text", text: entry.summary },
        metadata: toJson({
          firstKeptEntryId: entry.firstKeptEntryId,
          tokensBefore: entry.tokensBefore,
          fromHook: entry.fromHook ?? false,
          ...(entry.details !== undefined ? { details: entry.details } : {}),
        }),
      };
    case "branch_summary":
      return {
        id: entry.id,
        sourceEntryId: entry.id,
        parentId,
        createdAt,
        kind: "notice",
        noticeType: "branch-summary",
        title: "分支摘要",
        content: { type: "text", text: entry.summary },
        metadata: toJson({
          fromId: entry.fromId,
          fromHook: entry.fromHook ?? false,
          ...(entry.details !== undefined ? { details: entry.details } : {}),
        }),
      };
    case "thinking_level_change":
    case "model_change":
    case "custom":
    case "label":
    case "session_info":
      return undefined;
    default:
      throw new ProjectionError(`Unsupported RPC session entry: ${String(Reflect.get(entry, "type"))}`);
  }
}

function projectPersistedMessage(
  id: string,
  parentId: string | null,
  completedAt: number,
  message: AgentMessage,
  thinkingLevel: ThinkingLevel,
  registerImageResource: (mimeType: string, data: string) => SessionImageResourceRef,
  quotes?: readonly PiQuote[],
): PiTimelineNode | undefined {
  switch (message.role) {
    case "user":
      return {
        id,
        sourceEntryId: id,
        parentId,
        createdAt: completedAt,
        kind: "user",
        content: quotes?.length
          ? userContentWithQuoteStrip(message.content, quotes, registerImageResource)
          : userContent(message.content, registerImageResource),
        delivery: { state: "persisted" },
        ...(quotes?.length ? quoteFields(quotes) : {}),
      };
    case "assistant":
      return assistantNode(id, parentId, message, id, completedAt, thinkingLevel);
    case "bashExecution":
      return {
        id,
        sourceEntryId: id,
        parentId,
        createdAt: completedAt,
        kind: "notice",
        noticeType: "bash",
        title: message.command,
        content: {
          type: "command",
          command: message.command,
          output: message.output,
          ...(message.exitCode !== undefined ? { exitCode: message.exitCode } : {}),
          cancelled: message.cancelled,
          truncated: message.truncated,
          ...(message.fullOutputPath ? { fullOutputPath: message.fullOutputPath } : {}),
          ...(message.excludeFromContext !== undefined ? { excludeFromContext: message.excludeFromContext } : {}),
        },
      };
    case "custom":
      return message.display ? customNotice(id, parentId, message, registerImageResource, id, completedAt) : undefined;
    case "compactionSummary":
      return {
        id,
        sourceEntryId: id,
        parentId,
        createdAt: completedAt,
        kind: "notice",
        noticeType: "compaction",
        title: "上下文压缩",
        content: { type: "text", text: message.summary },
        metadata: toJson({ tokensBefore: message.tokensBefore }),
      };
    case "branchSummary":
      return {
        id,
        sourceEntryId: id,
        parentId,
        createdAt: completedAt,
        kind: "notice",
        noticeType: "branch-summary",
        title: "分支摘要",
        content: { type: "text", text: message.summary },
        metadata: toJson({ fromId: message.fromId }),
      };
    case "toolResult":
      return undefined;
    default:
      throw new ProjectionError(`Unsupported RPC message role: ${String(Reflect.get(message, "role"))}`);
  }
}

function assistantNode(
  id: string,
  parentId: string | null,
  message: AssistantMessage,
  sourceEntryId: string,
  completedAt: number,
  thinkingLevel: ThinkingLevel,
): PiAssistantMessage {
  return {
    id,
    sourceEntryId,
    parentId,
    createdAt: message.timestamp,
    completedAt,
    kind: "assistant",
    content: message.content.flatMap((content, index): PiAssistantPart[] => {
      if (content.type === "text") return [{ id: partId(id, "text", index), type: "text", text: content.text }];
      if (content.type === "thinking") {
        return content.redacted
          ? []
          : [{ id: partId(id, "reasoning", index), type: "reasoning", text: content.thinking }];
      }
      return [toolPart(id, index, content, "waiting")];
    }),
    status: assistantStatus(message),
    provenance: {
      api: message.api,
      provider: message.provider,
      model: message.model,
      thinkingLevel,
      ...(message.responseModel ? { responseModel: message.responseModel } : {}),
      ...(message.responseId ? { responseId: message.responseId } : {}),
    },
    usage: {
      input: message.usage.input,
      output: message.usage.output,
      cacheRead: message.usage.cacheRead,
      cacheWrite: message.usage.cacheWrite,
      ...(message.usage.cacheWrite1h !== undefined ? { cacheWrite1h: message.usage.cacheWrite1h } : {}),
      ...(message.usage.reasoning !== undefined ? { reasoning: message.usage.reasoning } : {}),
      totalTokens: message.usage.totalTokens,
      cost: { ...message.usage.cost },
    },
    ...(message.diagnostics ? { diagnostics: toJson(message.diagnostics) } : {}),
  };
}

function customNotice(
  id: string,
  parentId: string | null,
  message: CustomMessage,
  sourceEntryId: string,
  createdAt: number,
): PiTimelineNode {
  return {
    id,
    sourceEntryId,
    parentId,
    createdAt,
    kind: "notice",
    noticeType: "custom",
    title: message.customType,
    content: {
      type: "custom",
      customType: message.customType,
      content: userContent(message.content, registerImageResource),
      ...(message.details !== undefined ? { details: toJson(message.details) } : {}),
    },
  };
}

function toolPart(
  messageId: string,
  index: number,
  content: Extract<AssistantContent, { type: "toolCall" }>,
  execution: PiToolCallPart["execution"],
): PiToolCallPart {
  const args = toJson(content.arguments);
  return {
    id: partId(messageId, "tool", index),
    type: "tool-call",
    toolCallId: content.id,
    toolName: content.name,
    args: isJsonObject(args) ? args : {},
    argsText: execution === "streaming-args" ? "" : JSON.stringify(args),
    execution,
  };
}

function assistantStatus(message: AssistantMessage): PiAssistantStatus {
  switch (message.stopReason) {
    case "stop":
      return { type: "complete", reason: "stop" };
    case "toolUse":
      return { type: "complete", reason: "unknown" };
    case "length":
      return { type: "incomplete", reason: "length" };
    case "aborted":
      return { type: "incomplete", reason: "cancelled" };
    case "pending":
      return { type: "incomplete", reason: "other" };
    case "error":
      return {
        type: "incomplete",
        reason: "error",
        ...(message.errorMessage ? { error: message.errorMessage } : {}),
      };
  }
}

function quoteFields(quotes: readonly PiQuote[]): { quote?: PiQuote; quotes?: PiQuote[] } {
  const first = quotes[0];
  if (!first) return {};
  return quotes.length === 1 ? { quote: first } : { quotes: [...quotes] };
}

function userContentWithQuoteStrip(
  content: string | readonly unknown[],
  quotes: readonly PiQuote[],
  registerImageResource: (mimeType: string, data: string) => SessionImageResourceRef,
): PiUserContentPart[] {
  const parts = userContent(content, registerImageResource);
  const first = parts[0];
  if (!first || first.type !== "text") return parts;
  const stripped = stripQuotePrefix(first.text, quotes);
  if (stripped === first.text) return parts;
  const rest = parts.slice(1);
  return stripped.length === 0 ? rest : [{ type: "text", text: stripped }, ...rest];
}

function userContent(content: string | readonly unknown[]): PiUserContentPart[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return content.flatMap((part): PiUserContentPart[] => {
    if (!part || typeof part !== "object" || !("type" in part)) return [];
    if (part.type === "text" && "text" in part && typeof part.text === "string") {
      return [{ type: "text", text: part.text }];
    }
    if (
      part.type === "image" &&
      "data" in part &&
      typeof part.data === "string" &&
      "mimeType" in part &&
      typeof part.mimeType === "string"
    ) {
      return [{ type: "image", data: part.data, mimeType: part.mimeType }];
    }
    return [];
  });
}

function partId(messageId: string, kind: string, index: number): string {
  return `${messageId}:${kind}:${index}`;
}

function timestamp(value: string): number {
  const result = new Date(value).getTime();
  return Number.isFinite(result) ? result : 0;
}

function isJsonObject(value: JsonValue): value is { [key: string]: JsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 将未知数据收窄为可安全传输的 JSON。 */
export function toJson(value: unknown, seen = new WeakSet<object>()): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint" || typeof value === "symbol" || typeof value === "function" || value === undefined) {
    return String(value);
  }
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => toJson(item, seen));
  const result: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) result[key] = toJson(item, seen);
  return result;
}
