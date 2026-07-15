import { AssistantRuntimeProvider, ThreadPrimitive } from "@assistant-ui/react";
import { MessageSquarePlus } from "lucide-react";
import { useDesktop } from "../../state/desktop-context.tsx";
import { usePiRuntime } from "../../runtime/use-pi-runtime.ts";
import { Button } from "../ui/button.tsx";
import { Composer } from "./composer.tsx";
import { HostRequests } from "./host-requests.tsx";
import { Messages } from "./messages.tsx";
import { SessionStatus } from "./session-status.tsx";

/** 中央聊天工作区。 */
export function ChatThread() {
	const { project, snapshot, createThread } = useDesktop();
	const runtime = usePiRuntime(snapshot);
	if (!project) return <Empty title="打开一个 Project" detail="选择本地工作区后，Pi 会在对应 cwd 中运行。" />;
	if (!snapshot) {
		return (
			<Empty title="创建第一个会话" detail="每个会话独立保存消息、运行状态和右侧 Workbench Panel。">
				<Button onClick={() => void createThread()}>
					<MessageSquarePlus size={15} /> 新建会话
				</Button>
			</Empty>
		);
	}
	return (
		<AssistantRuntimeProvider runtime={runtime}>
			<ThreadPrimitive.Root className="thread-root">
				<ThreadPrimitive.Viewport className="thread-viewport">
					<div className="thread-column">
						<Messages />
					</div>
					<ThreadPrimitive.ViewportFooter className="thread-footer">
						<SessionStatus snapshot={snapshot} />
						<Composer snapshot={snapshot} />
					</ThreadPrimitive.ViewportFooter>
				</ThreadPrimitive.Viewport>
			</ThreadPrimitive.Root>
			<HostRequests snapshot={snapshot} />
		</AssistantRuntimeProvider>
	);
}

function Empty({ title, detail, children }: { title: string; detail: string; children?: React.ReactNode }) {
	return (
		<div className="empty-state">
			<div className="empty-icon">
				<MessageSquarePlus size={22} />
			</div>
			<h2>{title}</h2>
			<p>{detail}</p>
			{children}
		</div>
	);
}
