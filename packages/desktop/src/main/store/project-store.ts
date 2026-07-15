import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { Project, WorkbenchState } from "../../shared/contracts.ts";

interface StoredProject {
	id: string;
	name: string;
	cwd: string;
	lastOpenedAt: number;
}

interface StoredState {
	version: 1;
	activeProjectId?: string;
	projects: StoredProject[];
	archivedThreads: Record<string, string[]>;
	workbenches: Record<string, WorkbenchState>;
}

const EMPTY_STATE: StoredState = { version: 1, projects: [], archivedThreads: {}, workbenches: {} };

/** 持久化 Project、最近使用项和本地会话归档状态。 */
export class ProjectStore {
	private state: StoredState = EMPTY_STATE;
	private readonly file: string;
	private saveTask: Promise<void> = Promise.resolve();

	constructor(file: string) {
		this.file = file;
	}

	/** 从用户数据目录恢复 Project 状态。 */
	async load(): Promise<void> {
		try {
			const text = await readFile(this.file, "utf8");
			const value: unknown = JSON.parse(text);
			if (!isStoredState(value)) throw new Error("Project 状态文件格式无效");
			this.state = value;
		} catch (error) {
			if (isMissingFile(error)) {
				this.state = { ...EMPTY_STATE, projects: [], archivedThreads: {}, workbenches: {} };
				return;
			}
			throw error;
		}
	}

	/** 返回包含目录有效性检查的 Project 列表。 */
	async list(): Promise<Project[]> {
		return Promise.all(this.state.projects.map((project) => this.toProject(project)));
	}

	/** 返回当前 Project；目录失效时仍返回具体原因。 */
	async getActive(): Promise<Project | null> {
		const project = this.state.projects.find(({ id }) => id === this.state.activeProjectId);
		return project ? this.toProject(project) : null;
	}

	/** 将目录注册为 Project，重复目录会复用已有记录。 */
	async add(folder: string): Promise<Project> {
		const cwd = await normalizeDirectory(folder);
		let project = this.state.projects.find((item) => samePath(item.cwd, cwd));
		if (!project) {
			project = { id: randomUUID(), name: basename(cwd), cwd, lastOpenedAt: Date.now() };
			this.state.projects.push(project);
		}
		project.lastOpenedAt = Date.now();
		this.state.activeProjectId = project.id;
		await this.save();
		return this.toProject(project);
	}

	/** 打开已有 Project 并更新最近使用时间。 */
	async open(projectId: string): Promise<Project> {
		const project = this.requireStored(projectId);
		const result = await this.toProject(project);
		if (!result.available) throw new Error(result.issue ?? "Project 目录不可用");
		project.lastOpenedAt = Date.now();
		this.state.activeProjectId = projectId;
		await this.save();
		return { ...result, lastOpenedAt: project.lastOpenedAt };
	}

	/** 仅从应用列表移除 Project，不删除磁盘目录或 Pi 会话。 */
	async remove(projectId: string): Promise<void> {
		this.requireStored(projectId);
		this.state.projects = this.state.projects.filter(({ id }) => id !== projectId);
		delete this.state.archivedThreads[projectId];
		for (const key of Object.keys(this.state.workbenches)) {
			if (key.startsWith(`${projectId}:`)) delete this.state.workbenches[key];
		}
		if (this.state.activeProjectId === projectId) this.state.activeProjectId = undefined;
		await this.save();
	}

	/** 返回可信的 Project cwd，renderer 无法覆盖该路径。 */
	getCwd(projectId: string): string {
		return this.requireStored(projectId).cwd;
	}

	/** 检查线程是否归档。 */
	isArchived(projectId: string, threadId: string): boolean {
		return this.state.archivedThreads[projectId]?.includes(threadId) ?? false;
	}

	/** 更新线程归档状态。 */
	async setArchived(projectId: string, threadId: string, archived: boolean): Promise<void> {
		this.requireStored(projectId);
		const values = new Set(this.state.archivedThreads[projectId] ?? []);
		if (archived) values.add(threadId);
		else values.delete(threadId);
		this.state.archivedThreads[projectId] = [...values];
		await this.save();
	}

	/** 返回 session 独立的 Workbench 布局。 */
	getWorkbench(projectId: string, threadId: string): WorkbenchState {
		this.requireStored(projectId);
		return (
			this.state.workbenches[workbenchKey(projectId, threadId)] ?? {
				projectId,
				threadId,
				panel: "chat",
				panelOpen: false,
				panelWidth: 360,
				terminalOpen: false,
				terminalHeight: 280,
				openFiles: [],
				expandedPaths: [],
			}
		);
	}

	/** 持久化 session 独立的 Workbench 布局。 */
	async setWorkbench(value: WorkbenchState): Promise<void> {
		this.requireStored(value.projectId);
		this.state.workbenches[workbenchKey(value.projectId, value.threadId)] = value;
		await this.save();
	}

	/** 删除 session 时一并清理其 Workbench 状态。 */
	async removeWorkbench(projectId: string, threadId: string): Promise<void> {
		delete this.state.workbenches[workbenchKey(projectId, threadId)];
		await this.save();
	}

	private requireStored(projectId: string): StoredProject {
		const project = this.state.projects.find(({ id }) => id === projectId);
		if (!project) throw new Error(`Project 不存在: ${projectId}`);
		return project;
	}

	private async toProject(project: StoredProject): Promise<Project> {
		try {
			const info = await stat(project.cwd);
			if (!info.isDirectory()) throw new Error("路径不是目录");
			return { ...project, available: true };
		} catch (error) {
			return { ...project, available: false, issue: errorMessage(error) };
		}
	}

	private async save(): Promise<void> {
		const text = `${JSON.stringify(this.state, null, 2)}\n`;
		const task = this.saveTask
			.catch(() => undefined)
			.then(async () => {
				await mkdir(dirname(this.file), { recursive: true });
				const temp = join(dirname(this.file), `${basename(this.file)}.${randomUUID()}.tmp`);
				try {
					await writeFile(temp, text, "utf8");
					await rename(temp, this.file);
				} finally {
					await rm(temp, { force: true });
				}
			});
		this.saveTask = task;
		await task;
	}
}

/** 将目录解析为真实绝对路径，并拒绝普通文件。 */
async function normalizeDirectory(folder: string): Promise<string> {
	const path = await realpath(resolve(folder));
	const info = await stat(path);
	if (!info.isDirectory()) throw new Error("选择的路径不是目录");
	return path;
}

function samePath(left: string, right: string): boolean {
	return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function isMissingFile(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isStoredState(value: unknown): value is StoredState {
	if (!value || typeof value !== "object") return false;
	const state = value as Record<string, unknown>;
	if (state.version !== 1 || !Array.isArray(state.projects) || typeof state.archivedThreads !== "object") return false;
	if (typeof state.workbenches !== "object" || state.workbenches === null) state.workbenches = {};
	return true;
}

function workbenchKey(projectId: string, threadId: string): string {
	return `${projectId}:${threadId}`;
}
