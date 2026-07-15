import { CircleHelp, FolderPlus, MessageSquarePlus, Search, Settings } from "lucide-react";
import { useState } from "react";
import { useDesktop } from "../../state/desktop-context.tsx";
import { Button } from "../ui/button.tsx";
import { ConfirmDialog } from "../ui/confirm-dialog.tsx";
import { ProjectList } from "./project-list.tsx";

type PendingDelete = { type: "project" | "thread"; id: string; title: string } | null;

/** Codex Desktop 风格的 Project 与 session 主导航。 */
export function Sidebar() {
	const desktop = useDesktop();
	const [pendingDelete, setPendingDelete] = useState<PendingDelete>(null);
	const [renaming, setRenaming] = useState<string | null>(null);
	const [title, setTitle] = useState("");

	const confirmDelete = () => {
		if (!pendingDelete) return;
		const task =
			pendingDelete.type === "project"
				? desktop.removeProject(pendingDelete.id)
				: desktop.removeThread(pendingDelete.id);
		void task.finally(() => setPendingDelete(null));
	};

	return (
		<aside className="sidebar">
			<div className="sidebar-brand">
				<strong>Meta Agent</strong>
				<Button variant="ghost" size="icon" aria-label="搜索">
					<Search size={16} />
				</Button>
			</div>
			<nav className="sidebar-actions" aria-label="主要操作">
				<button type="button" onClick={() => void desktop.createThread()} disabled={!desktop.project}>
					<MessageSquarePlus size={15} />
					新建任务
				</button>
			</nav>

			<div className="sidebar-section-heading">
				<span>项目</span>
				<Button variant="ghost" size="icon" aria-label="添加项目" onClick={() => void desktop.chooseProject()}>
					<FolderPlus size={15} />
				</Button>
			</div>
			<div className="sidebar-projects">
				<ProjectList
					projects={desktop.projects}
					projectId={desktop.project?.id}
					threads={desktop.threads}
					threadId={desktop.threadId}
					renaming={renaming}
					title={title}
					onTitleChange={setTitle}
					onProjectOpen={(id) => void desktop.openProject(id)}
					onProjectDelete={(project) => setPendingDelete({ type: "project", id: project.id, title: project.name })}
					onThreadOpen={(id) => void desktop.openThread(id)}
					onThreadRename={(thread) => {
						setRenaming(thread.id);
						setTitle(thread.title);
					}}
					onRenameCommit={(id) => {
						void desktop.renameThread(id, title).finally(() => setRenaming(null));
					}}
					onThreadArchive={(id, archived) => void desktop.setThreadArchived(id, archived)}
					onThreadDelete={(thread) => setPendingDelete({ type: "thread", id: thread.id, title: thread.title })}
				/>
			</div>
			<div className="sidebar-footer">
				<button type="button">
					<Settings size={15} />
					设置
				</button>
				<Button variant="ghost" size="icon" aria-label="帮助">
					<CircleHelp size={15} />
				</Button>
			</div>
			<ConfirmDialog
				open={pendingDelete !== null}
				title={pendingDelete?.type === "project" ? "移除项目" : "删除会话"}
				description={
					pendingDelete?.type === "project"
						? `仅从 Meta Agent 移除“${pendingDelete.title}”，不会删除工作区文件。`
						: `永久删除 Pi 会话“${pendingDelete?.title ?? ""}”及其本地会话文件。`
				}
				confirmLabel={pendingDelete?.type === "project" ? "移除" : "删除"}
				onOpenChange={(open) => {
					if (!open) setPendingDelete(null);
				}}
				onConfirm={confirmDelete}
			/>
		</aside>
	);
}
