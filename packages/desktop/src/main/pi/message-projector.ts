import type { InputContent, Message } from "@ag-ui/core";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { JsonValue } from "../../shared/contracts.ts";

/** 运行中的工具状态，用于补齐尚未落盘的流式工具结果。 */
/** 将 Pi 历史投影为 AG-UI 的标准消息快照。 */
export function projectMessages(session: AgentSession): Message[] {
  const projected: Message[] = [];
  for (const [index, message] of session.messages.entries()) {
    if (message.role === "user") {
      projected.push(projectUserMessage(session, message, index));
      continue;
    }
    if (message.role === "assistant") {
      const id = messageId(session.sessionId, message.timestamp, index);
      for (const [contentIndex, part] of message.content.entries()) {
        if (part.type !== "thinking" || part.redacted || !part.thinking) continue;
        projected.push({ id: `${id}:reasoning:${contentIndex}`, role: "reasoning", content: part.thinking });
      }
      const text = message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
      const displayText = text || (message.stopReason === "error" ? (message.errorMessage ?? "Pi run failed") : "");
      const toolCalls = message.content.flatMap((part) =>
        part.type === "toolCall"
          ? [
              {
                id: part.id,
                type: "function" as const,
                function: { name: part.name, arguments: JSON.stringify(toJson(part.arguments)) },
              },
            ]
          : [],
      );
      if (displayText || toolCalls.length > 0) {
        projected.push({
          id,
          role: "assistant",
          content: displayText,
          ...(toolCalls.length > 0 ? { toolCalls } : {}),
        });
      }
      continue;
    }
    if (message.role === "toolResult") {
      projected.push({
        id: `${message.toolCallId}:tool`,
        role: "tool",
        toolCallId: message.toolCallId,
        content: contentText(message.content),
        ...(message.isError ? { error: contentText(message.content) } : {}),
      });
    }
  }
  return projected;
}

/** 将未知工具数据收窄为 JSON，无法表示的值会显式转为说明字符串。 */
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

/** 从工具结果中提取适合工作台展示的文本。 */
export function resultText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "content" in value && Array.isArray(value.content)) {
    return contentText(value.content);
  }
  return JSON.stringify(toJson(value), null, 2);
}

/** 投影已持久化或刚开始消费、尚未写入 session history 的 user message。 */
export function projectUserMessage(
  session: AgentSession,
  message: Extract<AgentSession["messages"][number], { role: "user" }>,
  knownIndex?: number,
): Extract<Message, { role: "user" }> {
  const index = knownIndex ?? messageIndex(session, message);
  return {
    id: messageId(session.sessionId, message.timestamp, index),
    role: "user",
    content: projectUserContent(message.content),
  };
}

function projectUserContent(
  content: Extract<AgentSession["messages"][number], { role: "user" }>["content"],
): Extract<Message, { role: "user" }>["content"] {
  if (typeof content === "string") return content;
  return content.flatMap((part): InputContent[] => {
    if (!part || typeof part !== "object" || !("type" in part)) return [];
    if (part.type === "text" && "text" in part && typeof part.text === "string") {
      return [{ type: "text" as const, text: part.text }];
    }
    if (
      part.type === "image" &&
      "data" in part &&
      typeof part.data === "string" &&
      "mimeType" in part &&
      typeof part.mimeType === "string"
    ) {
      return [{ type: "image" as const, source: { type: "data" as const, value: part.data, mimeType: part.mimeType } }];
    }
    return [];
  });
}

function contentText(content: unknown[]): string {
  return content
    .flatMap((part) => {
      if (!part || typeof part !== "object") return [];
      if ("type" in part && part.type === "text" && "text" in part && typeof part.text === "string") return [part.text];
      return [];
    })
    .join("\n");
}

function messageId(sessionId: string, timestamp: number, index: number): string {
  return `${sessionId}:${timestamp}:${index}`;
}

/** live 与历史投影共用的稳定 Pi 消息 ID。 */
export function piMessageId(session: AgentSession, message: AgentSession["messages"][number]): string {
  const index = messageIndex(session, message);
  return messageId(session.sessionId, message.timestamp, index);
}

function messageIndex(session: AgentSession, message: AgentSession["messages"][number]): number {
  const directIndex = session.messages.indexOf(message);
  if (directIndex >= 0) return directIndex;
  const matchingIndex = session.messages.findLastIndex(
    (item) => item.timestamp === message.timestamp && item.role === message.role,
  );
  return matchingIndex >= 0 ? matchingIndex : session.messages.length;
}
