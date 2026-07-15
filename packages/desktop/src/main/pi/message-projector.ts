import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ChatMessage, JsonValue, MessagePart, ToolPart } from "../../shared/contracts.ts";

/** 运行中的工具状态，用于补齐尚未落盘的流式工具结果。 */
export interface ToolState {
	id: string;
	name: string;
	args: JsonValue;
	result?: string;
	status: ToolPart["status"];
}

/** 将 Pi 消息投影为稳定、可通过 IPC 传输的 renderer 消息。 */
export function projectMessages(session: AgentSession, tools: ReadonlyMap<string, ToolState>): ChatMessage[] {
	const results = new Map<string, { text: string; error: boolean }>();
	for (const message of session.messages) {
		if (message.role !== "toolResult") continue;
		results.set(message.toolCallId, { text: contentText(message.content), error: message.isError });
	}

	const projected: ChatMessage[] = [];
	for (const [index, message] of session.messages.entries()) {
		if (message.role === "toolResult") continue;
		if (message.role === "user") {
			projected.push({
				id: messageId(session.sessionId, message.timestamp, index),
				role: "user",
				parts: projectUserContent(message.content),
				timestamp: message.timestamp,
				status: "complete",
			});
			continue;
		}
		if (message.role !== "assistant") continue;
		const parts: MessagePart[] = message.content.map((part) => {
			if (part.type === "text") return { type: "text", text: part.text };
			if (part.type === "thinking") {
				return { type: "reasoning", text: part.thinking, redacted: part.redacted };
			}
			const live = tools.get(part.id);
			const saved = results.get(part.id);
			return {
				type: "tool",
				id: part.id,
				name: part.name,
				args: live?.args ?? toJson(part.arguments),
				result: live?.result ?? saved?.text,
				status: live?.status ?? (saved ? (saved.error ? "error" : "complete") : "running"),
			};
		});
		projected.push({
			id: messageId(session.sessionId, message.timestamp, index),
			role: "assistant",
			parts,
			timestamp: message.timestamp,
			status: assistantStatus(message.stopReason, session.isStreaming && index === session.messages.length - 1),
			error: message.errorMessage,
		});
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

function projectUserContent(
	content: string | Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
): MessagePart[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	return content.flatMap((part): MessagePart[] => {
		if (part.type === "text") return [{ type: "text", text: part.text ?? "" }];
		if (part.type === "image" && part.data && part.mimeType) {
			return [{ type: "image", data: part.data, mimeType: part.mimeType }];
		}
		return [];
	});
}

function contentText(content: unknown[]): string {
	return content
		.flatMap((part) => {
			if (!part || typeof part !== "object") return [];
			if ("type" in part && part.type === "text" && "text" in part && typeof part.text === "string")
				return [part.text];
			return [];
		})
		.join("\n");
}

function messageId(sessionId: string, timestamp: number, index: number): string {
	return `${sessionId}:${timestamp}:${index}`;
}

function assistantStatus(stopReason: string, running: boolean): ChatMessage["status"] {
	if (running) return "running";
	if (stopReason === "aborted") return "cancelled";
	if (stopReason === "error") return "error";
	return "complete";
}
