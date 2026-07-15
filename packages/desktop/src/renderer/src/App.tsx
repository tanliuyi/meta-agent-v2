import { ChatThread } from "./components/chat/chat-thread.tsx";
import { Sidebar } from "./components/layout/sidebar.tsx";
import { Topbar } from "./components/layout/topbar.tsx";
import { BottomTerminal } from "./components/panel/bottom-terminal.tsx";
import { WorkbenchPanel } from "./components/panel/workbench-panel.tsx";
import { useEffect } from "react";
import { useDesktop } from "./state/desktop-context.tsx";

/** Meta Agent Desktop 主工作台。 */
export function App() {
	const { project, threadId, snapshot, loading, error, clearError } = useDesktop();
	const sessionKey = project && threadId ? `${project.id}:${threadId}` : "empty";
	useEffect(() => {
		document.title = snapshot?.extensionUi.windowTitle ?? snapshot?.title ?? project?.name ?? "Meta Agent";
	}, [project?.name, snapshot?.extensionUi.windowTitle, snapshot?.title]);
	return (
		<div className="app-shell">
			<Sidebar />
			<section className="workspace">
				<Topbar />
				<div className="workspace-row">
					<main className="chat-workspace">{loading ? <div className="app-loading">正在恢复工作区...</div> : <ChatThread />}</main>
					<WorkbenchPanel key={sessionKey} />
				</div>
				<BottomTerminal key={sessionKey} />
			</section>
			{error ? (
				<div className="error-toast" role="alert">
					<span>{error}</span>
					<button type="button" onClick={clearError}>关闭</button>
				</div>
			) : null}
		</div>
	);
}
