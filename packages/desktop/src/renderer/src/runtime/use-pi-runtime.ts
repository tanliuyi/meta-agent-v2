import {
	type AppendMessage,
	type ThreadAssistantMessagePart,
	type ThreadMessageLike,
	type ThreadUserMessagePart,
	useExternalStoreRuntime,
} from "@assistant-ui/react";
import { useMemo } from "react";
import type { ChatMessage, JsonValue, MessagePart, SessionSnapshot } from "../../../shared/contracts.ts";

/** 将 Desktop snapshot 连接到 assistant-ui ExternalStoreRuntime。 */
export function usePiRuntime(snapshot: SessionSnapshot | null) {
	const adapter = useMemo(
		() => ({
			messages: snapshot?.messages ?? [],
			isRunning: snapshot?.running ?? false,
			isLoading: snapshot === null,
			isSendDisabled: snapshot?.readiness.state !== "ready",
			onNew: async (message: AppendMessage) => {
				if (!snapshot) throw new Error("没有打开的 Pi session");
				const text = message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
				await window.desktop.sessions.send({
					projectId: snapshot.projectId,
					threadId: snapshot.threadId,
					text,
					mode: message.steer ? "steer" : snapshot.running ? "followUp" : "prompt",
					images: [],
				});
			},
			onCancel: async () => {
				if (snapshot) await window.desktop.sessions.cancel(snapshot.projectId, snapshot.threadId);
			},
			convertMessage: (message: ChatMessage): ThreadMessageLike => convertMessage(message),
		}),
		[snapshot],
	);
	return useExternalStoreRuntime(adapter);
}

function convertMessage(message: ChatMessage): ThreadMessageLike {
	if (message.role === "user") {
		return {
			id: message.id,
			role: "user",
			content: message.parts.flatMap(convertUserPart),
			createdAt: new Date(message.timestamp),
			attachments: [],
			metadata: { custom: {} },
		};
	}
	return {
		id: message.id,
		role: "assistant",
		content: message.parts.flatMap(convertAssistantPart),
		createdAt: new Date(message.timestamp),
		status: messageStatus(message),
		metadata: {
			unstable_state: null,
			unstable_annotations: [],
			unstable_data: [],
			steps: [],
			custom: {},
		},
	};
}

function convertUserPart(part: MessagePart): ThreadUserMessagePart[] {
	if (part.type === "text") return [{ type: "text" as const, text: part.text }];
	if (part.type === "image") {
		return [{ type: "image" as const, image: `data:${part.mimeType};base64,${part.data}` }];
	}
	return [];
}

function convertAssistantPart(part: MessagePart): ThreadAssistantMessagePart[] {
	if (part.type === "text") return [{ type: "text" as const, text: part.text }];
	if (part.type === "reasoning") return [{ type: "reasoning" as const, text: part.text }];
	if (part.type === "image") {
		return [{ type: "image" as const, image: `data:${part.mimeType};base64,${part.data}` }];
	}
	const args = isJsonObject(part.args) ? part.args : { value: part.args };
	return [
		{
			type: "tool-call" as const,
			toolCallId: part.id,
			toolName: part.name,
			args,
			argsText: JSON.stringify(args),
			result: part.result,
			isError: part.status === "error",
		},
	];
}

function messageStatus(message: ChatMessage) {
	if (message.status === "running") return { type: "running" as const };
	if (message.status === "complete") return { type: "complete" as const, reason: "stop" as const };
	return {
		type: "incomplete" as const,
		reason: message.status === "cancelled" ? ("cancelled" as const) : ("error" as const),
		error: message.error,
	};
}

function isJsonObject(value: JsonValue): value is { [key: string]: JsonValue } {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
