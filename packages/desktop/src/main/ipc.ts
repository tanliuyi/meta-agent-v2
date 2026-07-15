import { BrowserWindow, dialog, ipcMain } from "electron";
import { CHANNELS } from "../shared/channels.ts";
import type { HostResponse, SendInput, SessionSnapshot, TerminalEvent, WorkbenchState } from "../shared/contracts.ts";
import type { FileService } from "./files/file-service.ts";
import type { SessionSupervisor } from "./pi/session-supervisor.ts";
import type { ProjectStore } from "./store/project-store.ts";
import type { TerminalSupervisor } from "./terminal/terminal-supervisor.ts";

/** 注册 Desktop 的 Project、Pi session、文件和 Workbench IPC。 */
export function registerIpc(
	projects: ProjectStore,
	sessions: SessionSupervisor,
	files: FileService,
	terminals: TerminalSupervisor,
): void {
	ipcMain.handle(CHANNELS.projectsList, () => projects.list());
	ipcMain.handle(CHANNELS.projectsActive, () => projects.getActive());
	ipcMain.handle(CHANNELS.projectsChoose, async (event) => {
		const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
		const result = owner
			? await dialog.showOpenDialog(owner, { properties: ["openDirectory", "createDirectory"] })
			: await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
		return result.canceled || !result.filePaths[0] ? null : projects.add(result.filePaths[0]);
	});
	ipcMain.handle(CHANNELS.projectsOpen, (_event, projectId: string) => projects.open(projectId));
	ipcMain.handle(CHANNELS.projectsRemove, async (_event, projectId: string) => {
		await sessions.removeProject(projectId);
		terminals.disposeProject(projectId);
		await projects.remove(projectId);
	});

	ipcMain.handle(CHANNELS.sessionsList, (_event, projectId: string, includeArchived?: boolean) =>
		sessions.list(projectId, includeArchived),
	);
	ipcMain.handle(CHANNELS.sessionsCreate, (_event, projectId: string) => sessions.create(projectId));
	ipcMain.handle(CHANNELS.sessionsOpen, (_event, projectId: string, threadId: string) =>
		sessions.open(projectId, threadId),
	);
	ipcMain.handle(CHANNELS.sessionsRename, (_event, projectId: string, threadId: string, title: string) =>
		sessions.rename(projectId, threadId, title),
	);
	ipcMain.handle(CHANNELS.sessionsArchive, (_event, projectId: string, threadId: string, archived: boolean) =>
		sessions.archive(projectId, threadId, archived),
	);
	ipcMain.handle(CHANNELS.sessionsRemove, async (_event, projectId: string, threadId: string) => {
		await sessions.remove(projectId, threadId);
		terminals.disposeSession(projectId, threadId);
	});
	ipcMain.handle(CHANNELS.sessionsSend, (_event, input: SendInput) => sessions.send(input));
	ipcMain.handle(CHANNELS.sessionsCancel, (_event, projectId: string, threadId: string) =>
		sessions.cancel(projectId, threadId),
	);
	ipcMain.handle(CHANNELS.sessionsClearQueue, (_event, projectId: string, threadId: string) =>
		sessions.clearQueue(projectId, threadId),
	);
	ipcMain.handle(CHANNELS.sessionsCompact, (_event, projectId: string, threadId: string) =>
		sessions.compact(projectId, threadId),
	);
	ipcMain.handle(
		CHANNELS.sessionsSetModel,
		(_event, projectId: string, threadId: string, provider: string, modelId: string) =>
			sessions.setModel(projectId, threadId, provider, modelId),
	);
	ipcMain.handle(
		CHANNELS.sessionsSetThinking,
		(_event, projectId: string, threadId: string, level: SessionSnapshot["thinkingLevel"]) =>
			sessions.setThinking(projectId, threadId, level),
	);
	ipcMain.handle(CHANNELS.sessionsRespond, (_event, projectId: string, threadId: string, response: HostResponse) =>
		sessions.respond(projectId, threadId, response),
	);

	ipcMain.handle(CHANNELS.filesList, (_event, projectId: string, path?: string, query?: string) =>
		files.list(projectId, path, query),
	);
	ipcMain.handle(CHANNELS.filesRead, (_event, projectId: string, path: string) => files.read(projectId, path));
	ipcMain.handle(
		CHANNELS.terminalsOpen,
		(_event, projectId: string, threadId: string, terminalId: string, cols: number, rows: number) =>
			terminals.open(projectId, threadId, terminalId, cols, rows),
	);
	ipcMain.handle(
		CHANNELS.terminalsWrite,
		(_event, projectId: string, threadId: string, terminalId: string, data: string) =>
			terminals.write(projectId, threadId, terminalId, data),
	);
	ipcMain.handle(
		CHANNELS.terminalsResize,
		(_event, projectId: string, threadId: string, terminalId: string, cols: number, rows: number) =>
			terminals.resize(projectId, threadId, terminalId, cols, rows),
	);
	ipcMain.handle(
		CHANNELS.terminalsRestart,
		(_event, projectId: string, threadId: string, terminalId: string, cols: number, rows: number) =>
			terminals.restart(projectId, threadId, terminalId, cols, rows),
	);
	ipcMain.handle(CHANNELS.workbenchGet, (_event, projectId: string, threadId: string) =>
		projects.getWorkbench(projectId, threadId),
	);
	ipcMain.handle(CHANNELS.workbenchUpdate, (_event, state: WorkbenchState) => projects.setWorkbench(state));
}

/** 向所有 renderer 广播 session 权威快照。 */
export function broadcastSnapshot(snapshot: SessionSnapshot): void {
	for (const window of BrowserWindow.getAllWindows()) {
		if (!window.isDestroyed()) window.webContents.send(CHANNELS.sessionsSnapshot, snapshot);
	}
}

/** 向所有 renderer 广播 PTY 增量事件。 */
export function broadcastTerminalEvent(event: TerminalEvent): void {
	for (const window of BrowserWindow.getAllWindows()) {
		if (!window.isDestroyed()) window.webContents.send(CHANNELS.terminalsEvent, event);
	}
}
