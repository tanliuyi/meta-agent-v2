import {
	Archive,
	ArchiveRestore,
	ChevronDown,
	ChevronRight,
	Folder,
	MoreHorizontal,
	Trash2,
} from "lucide-react";
import { DropdownMenu } from "radix-ui";
import { useState } from "react";
import type { Project, Thread } from "../../../../shared/contracts.ts";
import { Button } from "../ui/button.tsx";

interface ProjectListProps {
	projects: Project[];
	projectId?: string;
	threads: Thread[];
	threadId: string | null;
	renaming: string | null;
	title: string;
	onTitleChange(value: string): void;
	onProjectOpen(projectId: string): void;
	onProjectDelete(project: Project): void;
	onThreadOpen(threadId: string): void;
	onThreadRename(thread: Thread): void;
	onRenameCommit(threadId: string): void;
	onThreadArchive(threadId: string, archived: boolean): void;
	onThreadDelete(thread: Thread): void;
}

/** 渲染 Project 与其活动、归档 session 列表。 */
export function ProjectList(props: ProjectListProps) {
	return props.projects.map((project) => (
		<ProjectItem
			key={project.id}
			{...props}
			project={project}
			active={props.projectId === project.id}
			threads={props.projectId === project.id ? props.threads : []}
		/>
	));
}

interface ProjectItemProps extends Omit<ProjectListProps, "projects" | "projectId"> {
	project: Project;
	active: boolean;
}

function ProjectItem(props: ProjectItemProps) {
	const [archiveOpen, setArchiveOpen] = useState(false);
	const activeThreads = props.threads.filter(({ archived }) => !archived);
	const archivedThreads = props.threads.filter(({ archived }) => archived);
	return (
		<section className="project-group" data-project-id={props.project.id}>
			<div className={props.active ? "project-row is-active" : "project-row"}>
				<button type="button" className="project-main" onClick={() => props.onProjectOpen(props.project.id)}>
					<Folder size={15} />
					<span>{props.project.name}</span>
					{props.project.available ? null : <span className="project-warning">不可用</span>}
				</button>
				<DropdownMenu.Root>
					<DropdownMenu.Trigger asChild>
						<Button variant="ghost" size="icon" className="row-menu" aria-label="项目操作">
							<MoreHorizontal size={15} />
						</Button>
					</DropdownMenu.Trigger>
					<DropdownMenu.Portal>
						<DropdownMenu.Content className="menu-content" sideOffset={4}>
							<DropdownMenu.Item className="menu-item danger" onSelect={() => props.onProjectDelete(props.project)}>
								<Trash2 size={14} /> 移除项目
							</DropdownMenu.Item>
						</DropdownMenu.Content>
					</DropdownMenu.Portal>
				</DropdownMenu.Root>
			</div>
			{props.active ? (
				<div className="thread-list">
					<ThreadRows {...props} threads={activeThreads} />
					{archivedThreads.length > 0 ? (
						<>
							<button type="button" className="archive-toggle" onClick={() => setArchiveOpen((open) => !open)}>
								{archiveOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
								<Archive size={13} />
								<span>已归档</span>
								<small>{archivedThreads.length}</small>
							</button>
							{archiveOpen ? <ThreadRows {...props} threads={archivedThreads} /> : null}
						</>
					) : null}
				</div>
			) : null}
		</section>
	);
}

interface ThreadRowsProps extends Omit<ProjectItemProps, "project" | "active" | "threads"> {
	threads: Thread[];
}

function ThreadRows(props: ThreadRowsProps) {
	return props.threads.map((thread) => (
		<div
			key={thread.id}
			className={props.threadId === thread.id ? "thread-row is-active" : "thread-row"}
			data-thread-id={thread.id}
		>
			{props.renaming === thread.id ? (
				<input
					autoFocus
					value={props.title}
					onChange={(event) => props.onTitleChange(event.target.value)}
					onBlur={() => props.onRenameCommit(thread.id)}
					onKeyDown={(event) => {
						if (event.key === "Enter") props.onRenameCommit(thread.id);
					}}
				/>
			) : (
				<button type="button" className="thread-main" onClick={() => props.onThreadOpen(thread.id)}>
					<span>{thread.title}</span>
					{thread.running ? <span className="running-dot" aria-label="运行中" /> : <ChevronRight size={13} />}
				</button>
			)}
			<DropdownMenu.Root>
				<DropdownMenu.Trigger asChild>
					<Button variant="ghost" size="icon" className="row-menu" aria-label="会话操作">
						<MoreHorizontal size={14} />
					</Button>
				</DropdownMenu.Trigger>
				<DropdownMenu.Portal>
					<DropdownMenu.Content className="menu-content" sideOffset={4}>
						<DropdownMenu.Item className="menu-item" onSelect={() => props.onThreadRename(thread)}>
							重命名
						</DropdownMenu.Item>
						<DropdownMenu.Item className="menu-item" onSelect={() => props.onThreadArchive(thread.id, !thread.archived)}>
							{thread.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
							{thread.archived ? "恢复" : "归档"}
						</DropdownMenu.Item>
						<DropdownMenu.Item className="menu-item danger" onSelect={() => props.onThreadDelete(thread)}>
							<Trash2 size={14} /> 删除
						</DropdownMenu.Item>
					</DropdownMenu.Content>
				</DropdownMenu.Portal>
			</DropdownMenu.Root>
		</div>
	));
}
