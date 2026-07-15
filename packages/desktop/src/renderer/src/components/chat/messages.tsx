import {
	MessagePartPrimitive,
	MessagePrimitive,
	ThreadPrimitive,
} from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import { BrainCircuit, ChevronDown } from "lucide-react";
import { ToolView } from "./tool-view.tsx";

/** assistant-ui 驱动的消息时间线。 */
export function Messages() {
	return (
		<ThreadPrimitive.Messages
			components={{
				UserMessage,
				AssistantMessage,
			}}
		/>
	);
}

function UserMessage() {
	return (
		<MessagePrimitive.Root className="message message-user">
			<div className="user-bubble">
				<MessagePrimitive.Parts />
			</div>
		</MessagePrimitive.Root>
	);
}

function AssistantMessage() {
	return (
		<MessagePrimitive.Root className="message message-assistant">
			<MessagePrimitive.Parts
				components={{
					Text: MarkdownPart,
					Reasoning: ReasoningPart,
					tools: { Fallback: ToolView },
				}}
			/>
		</MessagePrimitive.Root>
	);
}

function MarkdownPart() {
	return <MarkdownTextPrimitive className="aui-md" />;
}

function ReasoningPart() {
	return (
		<details className="reasoning-block">
			<summary>
				<BrainCircuit size={14} />
				<span>思考过程</span>
				<ChevronDown size={13} />
			</summary>
			<div className="reasoning-content">
				<MessagePartPrimitive.Text />
			</div>
		</details>
	);
}
