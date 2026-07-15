import { useCallback, useEffect, useMemo, useReducer } from "react";
import type { Project, WorkbenchState } from "../../../shared/contracts.ts";
import {
	type DesktopContextValue,
	desktopReducer,
	INITIAL_STATE,
	sessionKey,
	threadFromSnapshot,
} from "./desktop-model.ts";

/** 组合 Desktop IPC、权威快照和本地 Workbench cache。 */
export function useDesktopController(): DesktopContextValue {
	const [state, dispatch] = useReducer(desktopReducer, INITIAL_STATE);

	const report = useCallback((value: unknown) => {
		dispatch({ type: "error", error: value instanceof Error ? value.message : String(value) });
	}, []);

	const loadThread = useCallback(
		async (project: Project, threadId: string) => {
			try {
				const [snapshot, workbench] = await Promise.all([
					window.desktop.sessions.open(project.id, threadId),
					window.desktop.workbench.get(project.id, threadId),
				]);
				dispatch({ type: "thread-loaded", snapshot, workbench });
			} catch (value) {
				report(value);
			}
		},
		[report],
	);

	const loadProject = useCallback(
		async (project: Project) => {
			const threads = await window.desktop.sessions.list(project.id, true);
			dispatch({ type: "project-loaded", project, threads });
			const first = threads.find(({ archived }) => !archived);
			if (first) await loadThread(project, first.id);
		},
		[loadThread],
	);

	useEffect(() => {
		let active = true;
		void Promise.all([window.desktop.projects.list(), window.desktop.projects.getActive()])
			.then(async ([projects, current]) => {
				if (!active) return;
				dispatch({ type: "projects-loaded", projects });
				if (current?.available) await loadProject(current);
			})
			.catch(report)
			.finally(() => {
				if (active) dispatch({ type: "loading", loading: false });
			});
		return () => {
			active = false;
		};
	}, [loadProject, report]);

	useEffect(() => window.desktop.sessions.onSnapshot((snapshot) => dispatch({ type: "snapshot", snapshot })), []);

	const chooseProject = useCallback(async () => {
		try {
			const project = await window.desktop.projects.choose();
			if (!project) return;
			dispatch({ type: "project-upserted", project });
			await loadProject(project);
		} catch (value) {
			report(value);
		}
	}, [loadProject, report]);

	const openProject = useCallback(
		async (projectId: string) => {
			try {
				await loadProject(await window.desktop.projects.open(projectId));
			} catch (value) {
				report(value);
			}
		},
		[loadProject, report],
	);

	const removeProject = useCallback(
		async (projectId: string) => {
			try {
				await window.desktop.projects.remove(projectId);
				dispatch({ type: "project-removed", projectId });
			} catch (value) {
				report(value);
			}
		},
		[report],
	);

	const createThread = useCallback(async () => {
		if (!state.project) return;
		try {
			const snapshot = await window.desktop.sessions.create(state.project.id);
			const workbench = await window.desktop.workbench.get(state.project.id, snapshot.threadId);
			dispatch({ type: "thread-created", thread: threadFromSnapshot(snapshot), snapshot, workbench });
		} catch (value) {
			report(value);
		}
	}, [report, state.project]);

	const openThread = useCallback(
		async (threadId: string) => {
			if (state.project) await loadThread(state.project, threadId);
		},
		[loadThread, state.project],
	);

	const renameThread = useCallback(
		async (threadId: string, title: string) => {
			if (!state.project) return;
			try {
				await window.desktop.sessions.rename(state.project.id, threadId, title);
				dispatch({ type: "thread-renamed", threadId, title });
			} catch (value) {
				report(value);
			}
		},
		[report, state.project],
	);

	const setThreadArchived = useCallback(
		async (threadId: string, archived: boolean) => {
			if (!state.project) return;
			try {
				await window.desktop.sessions.archive(state.project.id, threadId, archived);
				dispatch({ type: "thread-archived", threadId, archived });
				if (archived && state.threadId === threadId) {
					const next = state.threads.find((thread) => thread.id !== threadId && !thread.archived);
					if (next) await loadThread(state.project, next.id);
					else dispatch({ type: "thread-cleared" });
				}
			} catch (value) {
				report(value);
			}
		},
		[loadThread, report, state.project, state.threadId, state.threads],
	);

	const removeThread = useCallback(
		async (threadId: string) => {
			if (!state.project) return;
			try {
				await window.desktop.sessions.remove(state.project.id, threadId);
				dispatch({ type: "thread-removed", threadId });
				if (state.threadId === threadId) {
					const next = state.threads.find((thread) => thread.id !== threadId && !thread.archived);
					if (next) await loadThread(state.project, next.id);
					else dispatch({ type: "thread-cleared" });
				}
			} catch (value) {
				report(value);
			}
		},
		[loadThread, report, state.project, state.threadId, state.threads],
	);

	const updateWorkbench = useCallback(
		(value: Partial<WorkbenchState>) => {
			if (!state.project || !state.threadId) return;
			const key = sessionKey(state.project.id, state.threadId);
			const previous = state.workbenches[key];
			if (!previous) return;
			const workbench = { ...previous, ...value };
			dispatch({ type: "workbench", workbench });
			void window.desktop.workbench.update(workbench).catch(report);
		},
		[report, state.project, state.threadId, state.workbenches],
	);

	const key = state.project && state.threadId ? sessionKey(state.project.id, state.threadId) : "";
	return useMemo(
		() => ({
			projects: state.projects,
			project: state.project,
			threads: state.threads,
			threadId: state.threadId,
			snapshot: state.snapshots[key] ?? null,
			workbench: state.workbenches[key] ?? null,
			loading: state.loading,
			error: state.error,
			chooseProject,
			openProject,
			removeProject,
			createThread,
			openThread,
			renameThread,
			setThreadArchived,
			removeThread,
			updateWorkbench,
			clearError: () => dispatch({ type: "error", error: null }),
		}),
		[
			state,
			key,
			chooseProject,
			openProject,
			removeProject,
			createThread,
			openThread,
			renameThread,
			setThreadArchived,
			removeThread,
			updateWorkbench,
		],
	);
}
