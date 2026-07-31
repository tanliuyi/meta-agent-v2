import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IDisposable, IPty } from "node-pty";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectStore } from "../src/main/store/project-store.ts";
import type { TerminalEvent } from "../src/shared/contracts.ts";

const ptyMock = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node-pty", () => ({ spawn: ptyMock.spawn }));

import { createTerminalShellResolver, TerminalSupervisor } from "../src/main/terminal/terminal-supervisor.ts";

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

  it("合并短时间内的输出，并在退出前按 revision flush", async () => {
    const { project, store } = await createStore();
    const terminal = new FakePty();
    ptyMock.spawn.mockReturnValue(terminal);
    const events: TerminalEvent[] = [];
    const terminals = new TerminalSupervisor(store, (event) => events.push(event));
    vi.useFakeTimers();

    try {
      terminals.open(project.id, "thread", "bottom", 80, 24);
      terminal.emitData("first ");
      terminal.emitData("batch");

      expect(events).toEqual([]);
      await vi.advanceTimersByTimeAsync(16);
      expect(events).toMatchObject([{ type: "data", data: "first batch" }]);

      terminal.emitData("before ");
      terminal.emitData("exit");
      terminal.emitExit(0);

      expect(events).toMatchObject([
        { type: "data", data: "first batch" },
        { type: "data", data: "before exit" },
        { type: "exit", exitCode: 0 },
      ]);
      expect(events.map(({ revision }) => revision)).toEqual([2, 3, 4]);
    } finally {
      terminals.dispose();
      vi.useRealTimers();
    }
  });

  it("按事件上限拆分大 chunk，并在 dispose 后取消待发送数据", async () => {
    const { project, store } = await createStore();
    const terminal = new FakePty();
    ptyMock.spawn.mockReturnValue(terminal);
    const events: TerminalEvent[] = [];
    const terminals = new TerminalSupervisor(store, (event) => events.push(event));
    vi.useFakeTimers();

    try {
      terminals.open(project.id, "thread", "bottom", 80, 24);
      const output = "x".repeat(16 * 1024 + 5);
      terminal.emitData(output);

      expect(events).toMatchObject([{ type: "data", data: "x".repeat(16 * 1024) }]);
      await vi.advanceTimersByTimeAsync(16);
      expect(events).toMatchObject([
        { type: "data", data: "x".repeat(16 * 1024) },
        { type: "data", data: "x".repeat(5) },
      ]);
      expect(terminals.open(project.id, "thread", "bottom", 80, 24).output).toBe(output);

      terminal.emitData("discarded");
      terminals.disposeSession(project.id, "thread");
      await vi.advanceTimersByTimeAsync(16);
      expect(events).toHaveLength(2);
    } finally {
      terminals.dispose();
      vi.useRealTimers();
    }
  });

  it("prefers the user shellPath over the managed fallback and uses interactive bash args", async () => {
    const { project, root, store } = await createStore();
    const agentDir = join(root, "agent");
    const userShell = join(root, "user-shell", process.platform === "win32" ? "bash.exe" : "bash");
    const managedShell = join(root, "managed-shell", process.platform === "win32" ? "bash.exe" : "bash");
    await Promise.all([mkdir(agentDir), mkdir(join(root, "user-shell")), mkdir(join(root, "managed-shell"))]);
    await Promise.all([writeFile(userShell, ""), writeFile(managedShell, "")]);
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ shellPath: userShell }));
    ptyMock.spawn.mockReturnValue(new FakePty());
    const terminals = new TerminalSupervisor(
      store,
      () => undefined,
      createTerminalShellResolver(agentDir, managedShell),
    );

    terminals.open(project.id, "thread", "bottom", 80, 24);

    expect(ptyMock.spawn).toHaveBeenCalledWith(userShell, ["--login", "-i"], expect.any(Object));
  });

  it("uses the managed shell when the user has not configured shellPath", async () => {
    const { project, root, store } = await createStore();
    const agentDir = join(root, "agent");
    const managedShell = join(root, "managed-shell", process.platform === "win32" ? "bash.exe" : "bash");
    await Promise.all([mkdir(agentDir), mkdir(join(root, "managed-shell"))]);
    await writeFile(managedShell, "");
    ptyMock.spawn.mockReturnValue(new FakePty());
    const terminals = new TerminalSupervisor(
      store,
      () => undefined,
      createTerminalShellResolver(agentDir, managedShell),
    );

    terminals.open(project.id, "thread", "bottom", 80, 24);

    expect(ptyMock.spawn).toHaveBeenCalledWith(managedShell, ["--login", "-i"], expect.any(Object));
  });

  it("closes affected terminals and blocks new input during workspace restore", async () => {
    const { project, store } = await createStore();
    const before = new FakePty();
    const after = new FakePty();
    ptyMock.spawn.mockReturnValueOnce(before).mockReturnValueOnce(after);
    const terminals = new TerminalSupervisor(store, () => undefined);

    terminals.open(project.id, "thread", "bottom", 80, 24);
    const restoreBarrier = terminals.beginWorkspaceRestore([project.id]);
    let barrierReady = false;
    void restoreBarrier.then(() => {
      barrierReady = true;
    });

    expect(before.kill).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(barrierReady).toBe(false);
    expect(() => terminals.open(project.id, "thread", "bottom", 80, 24)).toThrow("恢复期间不可用");
    expect(() => terminals.write(project.id, "thread", "bottom", "dir\r")).toThrow("恢复期间不可用");

    before.emitExit(0);
    const release = await restoreBarrier;
    expect(barrierReady).toBe(true);
    release();
    expect(terminals.open(project.id, "thread", "bottom", 80, 24).running).toBe(true);
    expect(ptyMock.spawn).toHaveBeenCalledTimes(2);
    terminals.dispose();
  });

  it("does not block terminals from unrelated projects during restore", async () => {
    const { project, root, store } = await createStore();
    const otherCwd = join(root, "other-workspace");
    await mkdir(otherCwd);
    const otherProject = await store.add(otherCwd);
    const before = new FakePty();
    const unrelated = new FakePty();
    ptyMock.spawn.mockReturnValueOnce(before).mockReturnValueOnce(unrelated);
    const terminals = new TerminalSupervisor(store, () => undefined);

    terminals.open(project.id, "thread", "bottom", 80, 24);
    const restoreBarrier = terminals.beginWorkspaceRestore([project.id]);
    expect(terminals.open(otherProject.id, "thread", "bottom", 80, 24).running).toBe(true);
    terminals.write(otherProject.id, "thread", "bottom", "dir\r");
    expect(unrelated.write).toHaveBeenCalledWith("dir\r");

    before.emitExit(0);
    const release = await restoreBarrier;
    release();
    terminals.dispose();
  });

  it("rejects restore and releases the barrier when a terminal does not exit", async () => {
    const { project, store } = await createStore();
    const terminal = new FakePty();
    ptyMock.spawn.mockReturnValue(terminal);
    const terminals = new TerminalSupervisor(store, () => undefined);
    vi.useFakeTimers();

    try {
      terminals.open(project.id, "thread", "bottom", 80, 24);
      const restoreBarrier = terminals.beginWorkspaceRestore([project.id]);
      const rejection = expect(restoreBarrier).rejects.toThrow("did not exit");
      await vi.advanceTimersByTimeAsync(2_000);
      expect(terminal.kill).toHaveBeenLastCalledWith("SIGKILL");
      await vi.advanceTimersByTimeAsync(3_000);
      await rejection;
      expect(() => terminals.open(project.id, "thread", "bottom", 80, 24)).not.toThrow();
    } finally {
      terminals.dispose();
      vi.useRealTimers();
    }
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
  return { project, root, store };
}
