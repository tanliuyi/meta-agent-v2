import { contextBridge, ipcRenderer } from "electron";
import { CHANNELS } from "../shared/channels.ts";
import type { SessionSnapshot, TerminalEvent } from "../shared/contracts.ts";
import type { DesktopApi } from "../shared/desktop-api.ts";

const desktopApi: DesktopApi = {
	versions: {
		electron: process.versions.electron,
		chrome: process.versions.chrome,
		node: process.versions.node,
	},
	projects: {
		list: () => ipcRenderer.invoke(CHANNELS.projectsList),
		choose: () => ipcRenderer.invoke(CHANNELS.projectsChoose),
		open: (projectId) => ipcRenderer.invoke(CHANNELS.projectsOpen, projectId),
		remove: (projectId) => ipcRenderer.invoke(CHANNELS.projectsRemove, projectId),
		getActive: () => ipcRenderer.invoke(CHANNELS.projectsActive),
	},
	sessions: {
		list: (projectId, includeArchived) => ipcRenderer.invoke(CHANNELS.sessionsList, projectId, includeArchived),
		create: (projectId) => ipcRenderer.invoke(CHANNELS.sessionsCreate, projectId),
		open: (projectId, threadId) => ipcRenderer.invoke(CHANNELS.sessionsOpen, projectId, threadId),
		rename: (projectId, threadId, title) => ipcRenderer.invoke(CHANNELS.sessionsRename, projectId, threadId, title),
		archive: (projectId, threadId, archived) =>
			ipcRenderer.invoke(CHANNELS.sessionsArchive, projectId, threadId, archived),
		remove: (projectId, threadId) => ipcRenderer.invoke(CHANNELS.sessionsRemove, projectId, threadId),
		send: (input) => ipcRenderer.invoke(CHANNELS.sessionsSend, input),
		cancel: (projectId, threadId) => ipcRenderer.invoke(CHANNELS.sessionsCancel, projectId, threadId),
		clearQueue: (projectId, threadId) => ipcRenderer.invoke(CHANNELS.sessionsClearQueue, projectId, threadId),
		compact: (projectId, threadId) => ipcRenderer.invoke(CHANNELS.sessionsCompact, projectId, threadId),
		setModel: (projectId, threadId, provider, modelId) =>
			ipcRenderer.invoke(CHANNELS.sessionsSetModel, projectId, threadId, provider, modelId),
		setThinking: (projectId, threadId, level) =>
			ipcRenderer.invoke(CHANNELS.sessionsSetThinking, projectId, threadId, level),
		respond: (projectId, threadId, response) =>
			ipcRenderer.invoke(CHANNELS.sessionsRespond, projectId, threadId, response),
		onSnapshot(listener) {
			const handler = (_event: Electron.IpcRendererEvent, snapshot: SessionSnapshot) => listener(snapshot);
			ipcRenderer.on(CHANNELS.sessionsSnapshot, handler);
			return () => ipcRenderer.removeListener(CHANNELS.sessionsSnapshot, handler);
		},
	},
	files: {
		list: (projectId, path, query) => ipcRenderer.invoke(CHANNELS.filesList, projectId, path, query),
		read: (projectId, path) => ipcRenderer.invoke(CHANNELS.filesRead, projectId, path),
	},
	terminals: {
		open: (projectId, threadId, terminalId, cols, rows) =>
			ipcRenderer.invoke(CHANNELS.terminalsOpen, projectId, threadId, terminalId, cols, rows),
		write: (projectId, threadId, terminalId, data) =>
			ipcRenderer.invoke(CHANNELS.terminalsWrite, projectId, threadId, terminalId, data),
		resize: (projectId, threadId, terminalId, cols, rows) =>
			ipcRenderer.invoke(CHANNELS.terminalsResize, projectId, threadId, terminalId, cols, rows),
		restart: (projectId, threadId, terminalId, cols, rows) =>
			ipcRenderer.invoke(CHANNELS.terminalsRestart, projectId, threadId, terminalId, cols, rows),
		onEvent(listener) {
			const handler = (_event: Electron.IpcRendererEvent, terminalEvent: TerminalEvent) => listener(terminalEvent);
			ipcRenderer.on(CHANNELS.terminalsEvent, handler);
			return () => ipcRenderer.removeListener(CHANNELS.terminalsEvent, handler);
		},
	},
	workbench: {
		get: (projectId, threadId) => ipcRenderer.invoke(CHANNELS.workbenchGet, projectId, threadId),
		update: (state) => ipcRenderer.invoke(CHANNELS.workbenchUpdate, state),
	},
};

contextBridge.exposeInMainWorld("desktop", desktopApi);
