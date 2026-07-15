import { rm } from "node:fs/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { HostResponse, SendInput, SessionSnapshot, Thread } from "../../shared/contracts.ts";
import type { ProjectStore } from "../store/project-store.ts";
import { SessionRuntime } from "./session-runtime.ts";

/** 管理多个 Project 下并行存活的 Pi session。 */
export class SessionSupervisor {
	private readonly runtimes = new Map<string, SessionRuntime>();
	private readonly projects: ProjectStore;
	private readonly changed: (snapshot: SessionSnapshot) => void;

	constructor(projects: ProjectStore, changed: (snapshot: SessionSnapshot) => void) {
		this.projects = projects;
		this.changed = changed;
	}

	/** 列出 Project 的磁盘会话和仍在运行的内存会话。 */
	async list(projectId: string, includeArchived = false): Promise<Thread[]> {
		const cwd = this.projects.getCwd(projectId);
		const stored = await SessionManager.list(cwd);
		const threads = new Map<string, Thread>();
		for (const item of stored) {
			const archived = this.projects.isArchived(projectId, item.id);
			if (archived && !includeArchived) continue;
			threads.set(item.id, {
				id: item.id,
				projectId,
				title: item.name || item.firstMessage || "新会话",
				createdAt: item.created.getTime(),
				updatedAt: item.modified.getTime(),
				messageCount: item.messageCount,
				preview: item.firstMessage,
				archived,
				running: this.runtimes.get(runtimeKey(projectId, item.id))?.session.isStreaming ?? false,
			});
		}
		for (const runtime of this.projectRuntimes(projectId)) {
			const snapshot = runtime.snapshot();
			const archived = this.projects.isArchived(projectId, runtime.id);
			if (archived && !includeArchived) continue;
			const firstText = snapshot.messages[0]?.parts.find(({ type }) => type === "text");
			threads.set(runtime.id, {
				id: runtime.id,
				projectId,
				title: snapshot.title,
				createdAt: snapshot.messages[0]?.timestamp ?? Date.now(),
				updatedAt: snapshot.messages.at(-1)?.timestamp ?? Date.now(),
				messageCount: snapshot.messages.length,
				preview: firstText?.type === "text" ? firstText.text : "",
				archived,
				running: snapshot.running,
			});
		}
		return [...threads.values()].sort((left, right) => right.updatedAt - left.updatedAt);
	}

	/** 创建并保留新的 Pi session。 */
	async create(projectId: string): Promise<SessionSnapshot> {
		const runtime = await SessionRuntime.create({
			projectId,
			cwd: this.projects.getCwd(projectId),
			changed: this.changed,
		});
		this.runtimes.set(runtimeKey(projectId, runtime.id), runtime);
		return runtime.snapshot();
	}

	/** 打开磁盘会话；已运行的 session 会直接复用。 */
	async open(projectId: string, threadId: string): Promise<SessionSnapshot> {
		return (await this.requireRuntime(projectId, threadId)).snapshot();
	}

	/** 发送消息。 */
	async send(input: SendInput): Promise<void> {
		await (await this.requireRuntime(input.projectId, input.threadId)).send(input);
	}

	/** 停止运行。 */
	async cancel(projectId: string, threadId: string): Promise<void> {
		await (await this.requireRuntime(projectId, threadId)).cancel();
	}

	/** 清空 session 队列。 */
	async clearQueue(projectId: string, threadId: string): Promise<string[]> {
		return (await this.requireRuntime(projectId, threadId)).clearQueue();
	}

	/** 手动压缩 session 上下文。 */
	async compact(projectId: string, threadId: string): Promise<void> {
		await (await this.requireRuntime(projectId, threadId)).compact();
	}

	/** 更新 session 模型。 */
	async setModel(projectId: string, threadId: string, provider: string, modelId: string): Promise<void> {
		await (await this.requireRuntime(projectId, threadId)).setModel(provider, modelId);
	}

	/** 更新 session thinking level。 */
	async setThinking(projectId: string, threadId: string, level: SessionSnapshot["thinkingLevel"]): Promise<void> {
		(await this.requireRuntime(projectId, threadId)).setThinking(level);
	}

	/** 重命名磁盘或运行中的 session。 */
	async rename(projectId: string, threadId: string, title: string): Promise<void> {
		const runtime = this.runtimes.get(runtimeKey(projectId, threadId));
		if (runtime) runtime.rename(title);
		else (await this.openManager(projectId, threadId)).appendSessionInfo(title.trim());
	}

	/** 更新本地归档状态，不修改 Pi session 文件。 */
	async archive(projectId: string, threadId: string, archived: boolean): Promise<void> {
		await this.projects.setArchived(projectId, threadId, archived);
	}

	/** 删除 session 文件并释放对应运行实例。 */
	async remove(projectId: string, threadId: string): Promise<void> {
		const key = runtimeKey(projectId, threadId);
		const runtime = this.runtimes.get(key);
		const manager = runtime ? runtime.session.sessionManager : await this.openManager(projectId, threadId);
		const file = manager.getSessionFile();
		if (runtime) {
			await runtime.dispose();
			this.runtimes.delete(key);
		}
		if (file) await rm(file);
		else if (!runtime) throw new Error("Pi session 尚未生成持久化文件");
		await this.projects.removeWorkbench(projectId, threadId);
	}

	/** 移除 Project 前释放其所有内存 session，不删除 Pi session 文件。 */
	async removeProject(projectId: string): Promise<void> {
		const runtimes = this.projectRuntimes(projectId);
		await Promise.all(runtimes.map((runtime) => runtime.dispose()));
		for (const runtime of runtimes) this.runtimes.delete(runtimeKey(projectId, runtime.id));
	}

	/** 响应 session 中的扩展 UI 请求。 */
	async respond(projectId: string, threadId: string, response: HostResponse): Promise<void> {
		(await this.requireRuntime(projectId, threadId)).respond(response);
	}

	/** 应用退出时释放所有运行实例。 */
	async dispose(): Promise<void> {
		await Promise.all([...this.runtimes.values()].map((runtime) => runtime.dispose()));
		this.runtimes.clear();
	}

	private async requireRuntime(projectId: string, threadId: string): Promise<SessionRuntime> {
		const key = runtimeKey(projectId, threadId);
		const current = this.runtimes.get(key);
		if (current) return current;
		const runtime = await SessionRuntime.create({
			projectId,
			cwd: this.projects.getCwd(projectId),
			sessionManager: await this.openManager(projectId, threadId),
			changed: this.changed,
		});
		this.runtimes.set(key, runtime);
		return runtime;
	}

	private async openManager(projectId: string, threadId: string): Promise<SessionManager> {
		const cwd = this.projects.getCwd(projectId);
		const item = (await SessionManager.list(cwd)).find(({ id }) => id === threadId);
		if (!item) throw new Error(`Pi session 不存在: ${threadId}`);
		return SessionManager.open(item.path, undefined, cwd);
	}

	private projectRuntimes(projectId: string): SessionRuntime[] {
		return [...this.runtimes.values()].filter((runtime) => runtime.projectId === projectId);
	}
}

function runtimeKey(projectId: string, threadId: string): string {
	return `${projectId}:${threadId}`;
}
