import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IDisposable, IPty } from "node-pty";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectStore } from "../src/main/store/project-store.ts";
import type { TerminalEvent } from "../src/shared/contracts.ts";

const ptyMock = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node-pty", () => ({ spawn: ptyMock.spawn }));

import { TerminalSupervisor } from "../src/main/terminal/terminal-supervisor.ts";

const roots: string[] = [];

afterEach(async () => {
	ptyMock.spawn.mockReset();
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("TerminalSupervisor", () => {
	it("按 session 独立保留输出并复用已打开的 PTY", async () => {
		const { project, store } = await createStore();
		const first = new FakePty();
		const second = new FakePty();
		ptyMock.spawn.mockReturnValueOnce(first).mockReturnValueOnce(second);
		const events: TerminalEvent[] = [];
		const terminals = new TerminalSupervisor(store, (event) => events.push(event));

		terminals.open(project.id, "first", "bottom", 80, 24);
		terminals.open(project.id, "second", "bottom", 100, 30);
		first.emitData("first output");
		second.emitData("second output");

		expect(terminals.open(project.id, "first", "bottom", 90, 28).output).toBe("first output");
		expect(terminals.open(project.id, "second", "bottom", 90, 28).output).toBe("second output");
		expect(ptyMock.spawn).toHaveBeenCalledTimes(2);
		expect(events.filter(({ type }) => type === "data")).toHaveLength(2);
	});

	it("只释放指定 session 的 PTY", async () => {
		const { project, store } = await createStore();
		const first = new FakePty();
		const second = new FakePty();
		ptyMock.spawn.mockReturnValueOnce(first).mockReturnValueOnce(second);
		const terminals = new TerminalSupervisor(store, () => undefined);

		terminals.open(project.id, "first", "bottom", 80, 24);
		terminals.open(project.id, "second", "bottom", 80, 24);
		terminals.disposeSession(project.id, "first");

		expect(first.kill).toHaveBeenCalledOnce();
		expect(second.kill).not.toHaveBeenCalled();
		expect(() => terminals.write(project.id, "first", "bottom", "dir\r")).toThrow("终端尚未打开");
		terminals.write(project.id, "second", "bottom", "dir\r");
		expect(second.write).toHaveBeenCalledWith("dir\r");
	});
});

class FakePty implements IPty {
	readonly pid = 1;
	cols = 80;
	rows = 24;
	readonly process = "shell";
	handleFlowControl = false;
	private dataListener?: (data: string) => void;
	private exitListener?: (event: { exitCode: number; signal?: number }) => void;

	readonly onData = (listener: (data: string) => void): IDisposable => {
		this.dataListener = listener;
		return {
			dispose: () => {
				this.dataListener = undefined;
			},
		};
	};

	readonly onExit = (listener: (event: { exitCode: number; signal?: number }) => void): IDisposable => {
		this.exitListener = listener;
		return {
			dispose: () => {
				this.exitListener = undefined;
			},
		};
	};

	readonly write = vi.fn<(data: string | Buffer) => void>();
	readonly kill = vi.fn<(signal?: string) => void>();
	readonly clear = vi.fn<() => void>();
	readonly pause = vi.fn<() => void>();
	readonly resume = vi.fn<() => void>();

	resize(cols: number, rows: number): void {
		this.cols = cols;
		this.rows = rows;
	}

	emitData(data: string): void {
		this.dataListener?.(data);
	}

	emitExit(exitCode: number): void {
		this.exitListener?.({ exitCode });
	}
}

async function createStore() {
	const root = await mkdtemp(join(tmpdir(), "meta-agent-terminal-"));
	roots.push(root);
	const cwd = join(root, "workspace");
	await mkdir(cwd);
	const store = new ProjectStore(join(root, "state.json"));
	await store.load();
	const project = await store.add(cwd);
	return { project, store };
}
