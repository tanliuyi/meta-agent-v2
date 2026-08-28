import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type {
  JsonValue,
  PiAssistantMessage,
  PiAssistantPart,
  PiAssistantStatus,
  PiTimelineNode,
  PiToolCallPart,
  PiUserContentPart,
  SessionImageResourceRef,
  ThinkingLevel,
} from "./contracts.ts";

export type PiMessage = Extract<AgentSessionEvent, { type: "message_start" }>["message"];
export type PiAssistant = Extract<PiMessage, { role: "assistant" }>;
export type PiToolResult = Extract<PiMessage, { role: "toolResult" }>;

interface PiMessageProjectionOptions {
  id: string;
  parentId: string | null;
  message: PiMessage;
  finished: boolean;
  sourceEntryId?: string;
  completedAt?: number;
  thinkingLevel?: ThinkingLevel;
  registerImageResource?: RegisterImageResource;
}

export type RegisterImageResource = (mimeType: string, data: string) => SessionImageResourceRef;

export function createPiMessageNodeId(message: PiMessage, nodes: readonly PiTimelineNode[]): string {
  const base = `pi-message:${message.role}:${message.timestamp}`;
  let occurrence = 0;
  for (const node of nodes) {
    if (node.id === base || node.id.startsWith(`${base}:`)) occurrence += 1;
  }
  return occurrence === 0 ? base : `${base}:${occurrence}`;
}

export function projectPiMessage(options: PiMessageProjectionOptions): PiTimelineNode | undefined {
  const { id, parentId, message, finished, sourceEntryId, completedAt, thinkingLevel = "off", registerImageResource } =
    options;
  const source = sourceEntryId ? { sourceEntryId } : {};
  switch (message.role) {
    case "user":
      return {
        id,
        ...source,
        parentId,
        createdAt: message.timestamp,
        kind: "user",
        content: piUserContent(message.content, registerImageResource),
        delivery: finished ? { state: "persisted" } : { state: "live" },
      };
    case "assistant":
      return projectPiAssistant({ id, parentId, message, finished, sourceEntryId, completedAt, thinkingLevel });
    case "bashExecution":
      return {
        id,
        ...source,
        parentId,
        createdAt: message.timestamp,
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
      return message.display
        ? {
            id,
            ...source,
            parentId,
            createdAt: message.timestamp,
            kind: "notice",
            noticeType: "custom",
            title: message.customType,
            content: {
              type: "custom",
              customType: message.customType,
              content: piUserContent(message.content, registerImageResource),
              ...(message.details !== undefined ? { details: toJson(message.details) } : {}),
            },
          }
        : undefined;
    case "compactionSummary":
      return {
        id,
        ...source,
        parentId,
        createdAt: message.timestamp,
        kind: "notice",
        noticeType: "compaction",
        title: "上下文压缩",
        content: { type: "text", text: message.summary },
        metadata: toJson({ tokensBefore: message.tokensBefore }),
      };
    case "branchSummary":
      return {
        id,
        ...source,
        parentId,
        createdAt: message.timestamp,
        kind: "notice",
        noticeType: "branch-summary",
        title: "分支摘要",
        content: { type: "text", text: message.summary },
        metadata: toJson({ fromId: message.fromId }),
      };
    case "toolResult":
      return undefined;
    default:
      return assertNever(message);
  }
}

export function projectPiAssistant(options: {
  id: string;
  parentId: string | null;
  message: PiAssistant;
  finished: boolean;
  sourceEntryId?: string;
  completedAt?: number;
  thinkingLevel?: ThinkingLevel;
}): PiAssistantMessage {
  const { id, parentId, message, finished, sourceEntryId, completedAt, thinkingLevel } = options;
  return {
    id,
    ...(sourceEntryId ? { sourceEntryId } : {}),
    parentId,
    createdAt: message.timestamp,
    ...(finished && completedAt !== undefined ? { completedAt } : {}),
    kind: "assistant",
    content: message.content.flatMap((content, index): PiAssistantPart[] => {
      if (content.type === "text") return [{ id: `${id}:text:${index}`, type: "text", text: content.text }];
      if (content.type === "thinking") {
        return content.redacted ? [] : [{ id: `${id}:reasoning:${index}`, type: "reasoning", text: content.thinking }];
      }
      const args = toJson(content.arguments);
      return [
        {
          id: `${id}:tool:${index}`,
          type: "tool-call",
          toolCallId: content.id,
          toolName: content.name,
          args: isJsonObject(args) ? args : {},
          argsText: JSON.stringify(args),
          execution: "waiting",
        },
      ];
    }),
    status: finished ? piAssistantStatus(message) : { type: "running" },
    provenance: {
      api: message.api,
      provider: message.provider,
      model: message.model,
      ...(thinkingLevel ? { thinkingLevel } : {}),
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

export function applyPiToolResult(
  part: PiToolCallPart,
  message: PiToolResult,
  registerImageResource?: RegisterImageResource,
): PiToolCallPart {
  return {
    ...part,
    execution: message.isError ? "error" : "complete",
    result: projectPiToolResult(
      {
        content: message.content,
        ...(message.details !== undefined ? { details: message.details } : {}),
        ...(message.addedToolNames ? { addedToolNames: message.addedToolNames } : {}),
        ...(message.usage ? { usage: message.usage } : {}),
      },
      registerImageResource,
    ),
    isError: message.isError,
  };
}

export function piUserContent(
  content: string | readonly unknown[],
  registerImageResource?: RegisterImageResource,
): PiUserContentPart[] {
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
      return registerImageResource
        ? [{ type: "image", ...registerImageResource(part.mimeType, part.data) }]
        : [];
    }
    return [];
  });
}

export function projectPiToolResult(value: unknown, registerImageResource?: RegisterImageResource): JsonValue {
  if (!registerImageResource || !isPlainRecord(value)) return toJson(value);
  return toJson({
    ...value,
    ...(Array.isArray(value.content)
      ? {
          content: value.content.map((part) => {
            if (!isPlainRecord(part)) return part;
            if (part.type !== "image" || typeof part.data !== "string" || typeof part.mimeType !== "string") {
              return part;
            }
            return { type: "image", ...registerImageResource(part.mimeType, part.data) };
          }),
        }
      : {}),
    ...(isPlainRecord(value.details)
      ? { details: projectPiToolDetails(value.details, registerImageResource) }
      : {}),
  });
}

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

function piAssistantStatus(message: PiAssistant): PiAssistantStatus {
  switch (message.stopReason as string) {
    case "stop":
      return { type: "complete", reason: "stop" };
    case "toolUse":
    case "deferred":
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
    default:
      throw new Error(`Unsupported Pi assistant stop reason: ${String(message.stopReason)}`);
  }
}

function projectPiToolDetails(
  details: Record<string, unknown>,
  registerImageResource: RegisterImageResource,
): Record<string, unknown> {
  const projected = { ...details };
  projected.screenshot = projectScreenshot(details.screenshot, registerImageResource);
  if (isPlainRecord(details.snapshot)) {
    projected.snapshot = {
      ...details.snapshot,
      screenshot: projectScreenshot(details.snapshot.screenshot, registerImageResource),
    };
  }
  return projected;
}

function projectScreenshot(value: unknown, registerImageResource: RegisterImageResource): unknown {
  if (typeof value === "string") return dataUrlToImageResourceRef(value, registerImageResource) ?? value;
  if (!isPlainRecord(value) || typeof value.dataUrl !== "string") return value;
  const ref = dataUrlToImageResourceRef(value.dataUrl, registerImageResource);
  return ref ? { ...value, dataUrl: ref } : value;
}

const DATA_URL_PATTERN = /^data:image\/([A-Za-z0-9.+-]+);base64,(.+)$/s;

function dataUrlToImageResourceRef(
  value: string,
  registerImageResource: RegisterImageResource,
): SessionImageResourceRef | undefined {
  const match = DATA_URL_PATTERN.exec(value);
  return match ? registerImageResource(`image/${match[1]}`, match[2] ?? "") : undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonObject(value: JsonValue): value is { [key: string]: JsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertNever(value: never): never {
  throw new Error(`Unsupported Pi message value: ${String(value)}`);
}
