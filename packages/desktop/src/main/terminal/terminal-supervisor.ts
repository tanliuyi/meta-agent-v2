import { basename } from "node:path";
import * as pty from "node-pty";
import type { TerminalEvent, TerminalSnapshot } from "../../shared/contracts.ts";
import type { ProjectStore } from "../store/project-store.ts";

const MAX_OUTPUT = 2 * 1024 * 1024;
const MIN_COLS = 20;
const MAX_COLS = 500;
const MIN_ROWS = 4;
const MAX_ROWS = 200;

interface TerminalProcess {
	pty: pty.IPty;
	data?: pty.IDisposable;
	exit?: pty.IDisposable;
	shell: string;
	output: string;
	revision: number;
	running: boolean;
	disposed: boolean;
}

/** 按 Project、session 和终端槽位管理独立 PTY。 */
export class TerminalSupervisor {
	private readonly terminals = new Map<string, TerminalProcess>();
	private readonly revisions = new Map<string, number>();
	private readonly projects: ProjectStore;
	private readonly changed: (event: TerminalEvent) => void;

	constructor(projects: ProjectStore, changed: (event: TerminalEvent) => void) {
		this.projects = projects;
		this.changed = changed;
	}

	/** 打开已有 PTY，若不存在则在 Project cwd 中创建。 */
	open(projectId: string, threadId: string, terminalId: string, cols: number, rows: number): TerminalSnapshot {
		const key = terminalKey(projectId, threadId, terminalId);
		let terminal = this.terminals.get(key);
		if (!terminal) {
			terminal = this.create(projectId, threadId, terminalId, cols, rows);
			this.terminals.set(key, terminal);
		} else if (terminal.running) {
			terminal.pty.resize(clamp(cols, MIN_COLS, MAX_COLS), clamp(rows, MIN_ROWS, MAX_ROWS));
		}
		return snapshot(projectId, threadId, terminalId, terminal);
	}

	/** 将 renderer 输入写入指定 PTY。 */
	write(projectId: string, threadId: string, terminalId: string, data: string): void {
		const terminal = this.require(projectId, threadId, terminalId);
		if (!terminal.running) throw new Error("终端进程已退出，请重新启动");
		terminal.pty.write(data);
	}

	/** 同步指定 PTY 的字符尺寸。 */
	resize(projectId: string, threadId: string, terminalId: string, cols: number, rows: number): void {
		this.require(projectId, threadId, terminalId).pty.resize(
			clamp(cols, MIN_COLS, MAX_COLS),
			clamp(rows, MIN_ROWS, MAX_ROWS),
		);
	}

	/** 结束旧 PTY 并在相同 session cwd 中重新启动。 */
	restart(projectId: string, threadId: string, terminalId: string, cols: number, rows: number): TerminalSnapshot {
		const key = terminalKey(projectId, threadId, terminalId);
		this.disposeTerminal(key);
		const terminal = this.create(projectId, threadId, terminalId, cols, rows);
		this.terminals.set(key, terminal);
		this.changed({ type: "reset", projectId, threadId, terminalId, revision: terminal.revision });
		return snapshot(projectId, threadId, terminalId, terminal);
	}

	/** 删除 session 时释放其所有 PTY。 */
	disposeSession(projectId: string, threadId: string): void {
		const prefix = `${projectId}:${threadId}:`;
		for (const key of this.terminals.keys()) {
			if (key.startsWith(prefix)) this.disposeTerminal(key);
		}
	}

	/** 移除 Project 时释放其所有 PTY。 */
	disposeProject(projectId: string): void {
		const prefix = `${projectId}:`;
		for (const key of this.terminals.keys()) {
			if (key.startsWith(prefix)) this.disposeTerminal(key);
		}
	}

	/** 应用退出时释放全部 PTY。 */
	dispose(): void {
		for (const key of [...this.terminals.keys()]) this.disposeTerminal(key);
	}

	private create(
		projectId: string,
		threadId: string,
		terminalId: string,
		cols: number,
		rows: number,
	): TerminalProcess {
		const key = terminalKey(projectId, threadId, terminalId);
		const shell = shellCommand();
		const terminalPty = pty.spawn(shell.file, shell.args, {
			name: "xterm-256color",
			cwd: this.projects.getCwd(projectId),
			env: process.env,
			cols: clamp(cols, MIN_COLS, MAX_COLS),
			rows: clamp(rows, MIN_ROWS, MAX_ROWS),
			useConpty: process.platform === "win32",
		});
		const terminal: TerminalProcess = {
			pty: terminalPty,
			shell: shell.file,
			output: "",
			revision: this.nextRevision(key),
			running: true,
			disposed: false,
		};
		terminal.data = terminalPty.onData((data) => {
			if (terminal.disposed) return;
			terminal.output = trimOutput(terminal.output + data);
			terminal.revision = this.nextRevision(key);
			this.changed({ type: "data", projectId, threadId, terminalId, revision: terminal.revision, data });
		});
		terminal.exit = terminalPty.onExit(({ exitCode }) => {
			if (terminal.disposed) return;
			terminal.running = false;
			terminal.revision = this.nextRevision(key);
			this.changed({ type: "exit", projectId, threadId, terminalId, revision: terminal.revision, exitCode });
		});
		return terminal;
	}

	private require(projectId: string, threadId: string, terminalId: string): TerminalProcess {
		const terminal = this.terminals.get(terminalKey(projectId, threadId, terminalId));
		if (!terminal) throw new Error("终端尚未打开");
		return terminal;
	}

	private disposeTerminal(key: string): void {
		const terminal = this.terminals.get(key);
		if (!terminal) return;
		this.terminals.delete(key);
		terminal.disposed = true;
		terminal.data?.dispose();
		terminal.exit?.dispose();
		if (terminal.running) terminal.pty.kill();
	}

	private nextRevision(key: string): number {
		const revision = (this.revisions.get(key) ?? 0) + 1;
		this.revisions.set(key, revision);
		return revision;
	}
}

function terminalKey(projectId: string, threadId: string, terminalId: string): string {
	if (!/^[a-zA-Z0-9_-]{1,64}$/.test(terminalId)) throw new Error("终端 ID 无效");
	return `${projectId}:${threadId}:${terminalId}`;
}

function shellCommand(): { file: string; args: string[] } {
	const file =
		process.env.SHELL ?? process.env.COMSPEC ?? (process.platform === "win32" ? "powershell.exe" : "/bin/sh");
	const name = basename(file).toLowerCase();
	if (name === "powershell.exe" || name === "pwsh.exe" || name === "pwsh") return { file, args: ["-NoLogo"] };
	if (name === "bash" || name === "bash.exe" || name === "zsh" || name === "zsh.exe")
		return { file, args: ["--login", "-i"] };
	return { file, args: [] };
}

function snapshot(
	projectId: string,
	threadId: string,
	terminalId: string,
	terminal: TerminalProcess,
): TerminalSnapshot {
	return {
		projectId,
		threadId,
		terminalId,
		revision: terminal.revision,
		shell: terminal.shell,
		output: terminal.output,
		running: terminal.running,
		cols: terminal.pty.cols,
		rows: terminal.pty.rows,
	};
}

function trimOutput(output: string): string {
	if (output.length <= MAX_OUTPUT) return output;
	const start = output.indexOf("\n", output.length - MAX_OUTPUT);
	return output.slice(start === -1 ? output.length - MAX_OUTPUT : start + 1);
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}
