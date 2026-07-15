import type { Project, SessionSnapshot, Thread, WorkbenchState } from "../../../shared/contracts.ts";

export interface DesktopContextValue {
	projects: Project[];
	project: Project | null;
	threads: Thread[];
	threadId: string | null;
	snapshot: SessionSnapshot | null;
	workbench: WorkbenchState | null;
	loading: boolean;
	error: string | null;
	chooseProject(): Promise<void>;
	openProject(projectId: string): Promise<void>;
	removeProject(projectId: string): Promise<void>;
	createThread(): Promise<void>;
	openThread(threadId: string): Promise<void>;
	renameThread(threadId: string, title: string): Promise<void>;
	setThreadArchived(threadId: string, archived: boolean): Promise<void>;
	removeThread(threadId: string): Promise<void>;
	updateWorkbench(value: Partial<WorkbenchState>): void;
	clearError(): void;
}

export interface DesktopState {
	projects: Project[];
	project: Project | null;
	threads: Thread[];
	threadId: string | null;
	snapshots: Record<string, SessionSnapshot>;
	workbenches: Record<string, WorkbenchState>;
	loading: boolean;
	error: string | null;
}

export const INITIAL_STATE: DesktopState = {
	projects: [],
	project: null,
	threads: [],
	threadId: null,
	snapshots: {},
	workbenches: {},
	loading: true,
	error: null,
};

export type DesktopAction =
	| { type: "projects-loaded"; projects: Project[] }
	| { type: "project-upserted"; project: Project }
	| { type: "project-loaded"; project: Project; threads: Thread[] }
	| { type: "project-removed"; projectId: string }
	| { type: "thread-loaded"; snapshot: SessionSnapshot; workbench: WorkbenchState }
	| { type: "thread-created"; thread: Thread; snapshot: SessionSnapshot; workbench: WorkbenchState }
	| { type: "thread-renamed"; threadId: string; title: string }
	| { type: "thread-archived"; threadId: string; archived: boolean }
	| { type: "thread-removed"; threadId: string }
	| { type: "thread-cleared" }
	| { type: "snapshot"; snapshot: SessionSnapshot }
	| { type: "workbench"; workbench: WorkbenchState }
	| { type: "loading"; loading: boolean }
	| { type: "error"; error: string | null };

/** 对 Desktop renderer 状态执行无副作用更新。 */
export function desktopReducer(state: DesktopState, action: DesktopAction): DesktopState {
	if (action.type === "projects-loaded") return { ...state, projects: sortProjects(action.projects) };
	if (action.type === "project-upserted") {
		return {
			...state,
			projects: sortProjects([...state.projects.filter(({ id }) => id !== action.project.id), action.project]),
		};
	}
	if (action.type === "project-loaded") {
		return { ...state, project: action.project, threads: action.threads, threadId: null };
	}
	if (action.type === "project-removed") {
		const current = state.project?.id === action.projectId;
		return {
			...state,
			projects: state.projects.filter(({ id }) => id !== action.projectId),
			project: current ? null : state.project,
			threads: current ? [] : state.threads,
			threadId: current ? null : state.threadId,
		};
	}
	if (action.type === "thread-loaded") {
		const key = sessionKey(action.snapshot.projectId, action.snapshot.threadId);
		return {
			...state,
			threadId: action.snapshot.threadId,
			snapshots: { ...state.snapshots, [key]: action.snapshot },
			workbenches: { ...state.workbenches, [key]: action.workbench },
		};
	}
	if (action.type === "thread-created") {
		const key = sessionKey(action.snapshot.projectId, action.snapshot.threadId);
		return {
			...state,
			threads: [action.thread, ...state.threads],
			threadId: action.thread.id,
			snapshots: { ...state.snapshots, [key]: action.snapshot },
			workbenches: { ...state.workbenches, [key]: action.workbench },
		};
	}
	if (action.type === "thread-renamed") {
		return {
			...state,
			threads: state.threads.map((thread) =>
				thread.id === action.threadId ? { ...thread, title: action.title } : thread,
			),
		};
	}
	if (action.type === "thread-archived") {
		return {
			...state,
			threads: state.threads.map((thread) =>
				thread.id === action.threadId ? { ...thread, archived: action.archived } : thread,
			),
		};
	}
	if (action.type === "thread-removed") {
		return { ...state, threads: state.threads.filter(({ id }) => id !== action.threadId) };
	}
	if (action.type === "thread-cleared") return { ...state, threadId: null };
	if (action.type === "snapshot") return applySnapshot(state, action.snapshot);
	if (action.type === "workbench") {
		const key = sessionKey(action.workbench.projectId, action.workbench.threadId);
		return { ...state, workbenches: { ...state.workbenches, [key]: action.workbench } };
	}
	if (action.type === "loading") return { ...state, loading: action.loading };
	return { ...state, error: action.error };
}

function applySnapshot(state: DesktopState, snapshot: SessionSnapshot): DesktopState {
	const key = sessionKey(snapshot.projectId, snapshot.threadId);
	const previous = state.snapshots[key];
	if (previous && previous.revision >= snapshot.revision) return state;
	return {
		...state,
		snapshots: { ...state.snapshots, [key]: snapshot },
		threads: state.threads.map((thread) =>
			thread.id === snapshot.threadId && thread.projectId === snapshot.projectId
				? {
						...thread,
						title: snapshot.title,
						running: snapshot.running,
						updatedAt: snapshot.messages.at(-1)?.timestamp ?? thread.updatedAt,
						messageCount: snapshot.messages.length,
					}
				: thread,
		),
	};
}

export function sessionKey(projectId: string, threadId: string): string {
	return `${projectId}:${threadId}`;
}

export function threadFromSnapshot(snapshot: SessionSnapshot): Thread {
	return {
		id: snapshot.threadId,
		projectId: snapshot.projectId,
		title: snapshot.title,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		messageCount: snapshot.messages.length,
		preview: "",
		archived: false,
		running: snapshot.running,
	};
}

function sortProjects(projects: Project[]): Project[] {
	return projects.toSorted((left, right) => right.lastOpenedAt - left.lastOpenedAt);
}
