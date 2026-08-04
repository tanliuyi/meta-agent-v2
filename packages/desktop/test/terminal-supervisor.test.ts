import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { IDisposable, IPty } from "node-pty";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectStore } from "../src/main/store/project-store.ts";
import type { TerminalEvent } from "../src/shared/contracts.ts";

const ptyMock = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node-pty", () => ({ spawn: ptyMock.spawn }));

import { BASH_INJECTION, isInjectedShell, ZSH_INJECTION } from "../src/main/terminal/shell-integration.ts";
import {
  createTerminalShellResolver,
  expandTilde,
  TerminalSupervisor,
} from "../src/main/terminal/terminal-supervisor.ts";

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

  it("注入的 shell 启动即退（非 0 退出码）时自动降级为无注入重启", async () => {
    const { project, store } = await createStore();
    const injectedPty = new FakePty();
    const fallbackPty = new FakePty();
    ptyMock.spawn.mockReturnValueOnce(injectedPty).mockReturnValueOnce(fallbackPty);
    const events: TerminalEvent[] = [];
    const terminals = new TerminalSupervisor(store, (event) => events.push(event));
    const start = Date.now();
    vi.setSystemTime(start);

    try {
      terminals.open(project.id, "thread", "bottom", 80, 24);
      // bash 注入：第一次 spawn 带 --rcfile
      expect(ptyMock.spawn).toHaveBeenCalledTimes(1);
      const firstArgs = ptyMock.spawn.mock.calls[0]![1] as string[];
      expect(firstArgs).toContain("--rcfile");

      // 启动 1 秒后以退出码 2 退出（模拟注入导致 shell 初始化失败）
      vi.setSystemTime(start + 1_000);
      injectedPty.emitExit(2);

      // 自动回退：第二次 spawn 无注入参数，且发出 reset 事件
      expect(ptyMock.spawn).toHaveBeenCalledTimes(2);
      const secondArgs = ptyMock.spawn.mock.calls[1]![1] as string[];
      expect(secondArgs).not.toContain("--rcfile");
      expect(events).toContainEqual(
        expect.objectContaining({ type: "reset", projectId: project.id, threadId: "thread", terminalId: "bottom" }),
      );
      // 回退后的终端可继续写入
      expect(() => terminals.write(project.id, "thread", "bottom", "echo hi\r")).not.toThrow();
      expect(fallbackPty.write).toHaveBeenCalledWith("echo hi\r");
    } finally {
      vi.useRealTimers();
    }
  });

  it("注入的 shell 正常退出（0 退出码）不触发自动回退", async () => {
    const { project, store } = await createStore();
    const terminal = new FakePty();
    ptyMock.spawn.mockReturnValue(terminal);
    const events: TerminalEvent[] = [];
    const terminals = new TerminalSupervisor(store, (event) => events.push(event));

    terminals.open(project.id, "thread", "bottom", 80, 24);
    terminal.emitExit(0);

    expect(ptyMock.spawn).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual(expect.objectContaining({ type: "exit", exitCode: 0 }));
    expect(events).not.toContainEqual(expect.objectContaining({ type: "reset" }));
  });

  it("PTY 退出后 resize 静默忽略（渲染端 ResizeObserver 会继续发事件）", async () => {
    const { project, store } = await createStore();
    const terminal = new FakePty();
    ptyMock.spawn.mockReturnValue(terminal);
    const terminals = new TerminalSupervisor(store, () => {});

    terminals.open(project.id, "thread", "bottom", 80, 24);
    terminal.emitExit(0);
    expect(() => terminals.resize(project.id, "thread", "bottom", 120, 40)).not.toThrow();
    expect(terminal.cols).toBe(80);
    expect(terminal.rows).toBe(24);
  });

  it("PTY 退出竞态窗口内 open 复用不抛错（agent 已退出但 onExit 未到）", async () => {
    const { project, store } = await createStore();
    const terminal = new FakePty();
    ptyMock.spawn.mockReturnValue(terminal);
    const terminals = new TerminalSupervisor(store, () => {});

    terminals.open(project.id, "thread", "bottom", 80, 24);
    // 模拟 agent 已拒绝 resize 而 onExit 尚未派发的窗口：FakePty.resize 抛错。
    const originalResize = terminal.resize.bind(terminal);
    terminal.resize = () => {
      throw new Error("Cannot resize a pty that has already exited");
    };
    try {
      expect(() => terminals.open(project.id, "thread", "bottom", 100, 30)).not.toThrow();
    } finally {
      terminal.resize = originalResize;
    }
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

    expect(ptyMock.spawn).toHaveBeenCalledWith(
      userShell,
      expect.arrayContaining(["--rcfile", expect.any(String), "-i"]),
      expect.any(Object),
    );
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

    expect(ptyMock.spawn).toHaveBeenCalledWith(
      managedShell,
      expect.arrayContaining(["--rcfile", expect.any(String), "-i"]),
      expect.any(Object),
    );
  });

  it("prefers the desktop shell path over the user and managed shells", async () => {
    const { project, root, store } = await createStore();
    const agentDir = join(root, "agent");
    const desktopShell = join(root, "desktop-shell", process.platform === "win32" ? "bash.exe" : "bash");
    const userShell = join(root, "user-shell", process.platform === "win32" ? "bash.exe" : "bash");
    const managedShell = join(root, "managed-shell", process.platform === "win32" ? "bash.exe" : "bash");
    await Promise.all([
      mkdir(agentDir),
      mkdir(join(root, "desktop-shell")),
      mkdir(join(root, "user-shell")),
      mkdir(join(root, "managed-shell")),
    ]);
    await Promise.all([writeFile(desktopShell, ""), writeFile(userShell, ""), writeFile(managedShell, "")]);
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({ shellPath: userShell }));
    ptyMock.spawn.mockReturnValue(new FakePty());
    const terminals = new TerminalSupervisor(
      store,
      () => undefined,
      createTerminalShellResolver(agentDir, managedShell, () => desktopShell),
    );

    terminals.open(project.id, "thread", "bottom", 80, 24);

    expect(ptyMock.spawn).toHaveBeenCalledWith(
      desktopShell,
      expect.arrayContaining(["--rcfile", expect.any(String), "-i"]),
      expect.any(Object),
    );
  });

  it("expands a tilde prefix in the desktop shell path", async () => {
    expect(expandTilde(undefined)).toBeUndefined();
    expect(expandTilde("~")).toBe(homedir());
    expect(expandTilde("~/bin/zsh")).toBe(join(homedir(), "bin/zsh"));
    expect(expandTilde("/bin/zsh")).toBe("/bin/zsh");
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

describe("shell integration 注入", () => {
  it("bash：spawn args 追加 --rcfile，env 不含 ZDOTDIR，dispose 后清理临时文件", async () => {
    const { project, store } = await createStore();
    ptyMock.spawn.mockReturnValue(new FakePty());
    const bash = process.platform === "win32" ? "bash.exe" : "bash";
    const terminals = new TerminalSupervisor(
      store,
      () => undefined,
      () => ({ file: bash, args: ["--login", "-i"] }),
    );

    terminals.open(project.id, "thread", "bottom", 80, 24);

    const [file, args, options] = ptyMock.spawn.mock.calls[0]!;
    expect(file).toBe(bash);
    const spawnArgs = args as string[];
    // --rcfile 替换原 --login（login 模式不读 rcfile）；-i 必须位于 --rcfile 之后
    expect(spawnArgs.slice(0, 2)).toEqual(["--rcfile", expect.any(String)]);
    expect(spawnArgs[2]).toBe("-i");
    const rcfile = spawnArgs[1]!;
    expect(rcfile).toContain("meta-agent-shell");
    expect((options as { env?: Record<string, string | undefined> }).env).not.toHaveProperty("ZDOTDIR");
    expect(existsSync(rcfile)).toBe(true);

    terminals.dispose();
    expect(existsSync(rcfile)).toBe(false);
  });

  it("zsh：env.ZDOTDIR 指向临时目录，args 不含 --rcfile，dispose 后清理临时目录", async () => {
    const { project, store } = await createStore();
    ptyMock.spawn.mockReturnValue(new FakePty());
    const zsh = process.platform === "win32" ? "zsh.exe" : "zsh";
    const terminals = new TerminalSupervisor(
      store,
      () => undefined,
      () => ({ file: zsh, args: ["--login", "-i"] }),
    );

    terminals.open(project.id, "thread", "bottom", 80, 24);

    const [file, args, options] = ptyMock.spawn.mock.calls[0]!;
    expect(file).toBe(zsh);
    expect(args).toEqual(["--login", "-i"]);
    const env = (options as { env?: Record<string, string | undefined> }).env;
    const zdotdir = env?.ZDOTDIR;
    expect(zdotdir).toBeDefined();
    expect(zdotdir).toContain("meta-agent-shell");
    expect(existsSync(join(zdotdir!, ".zshrc"))).toBe(true);

    terminals.dispose();
    expect(existsSync(zdotdir!)).toBe(false);
  });

  it("非 bash/zsh（powershell）spawn 参数与注入前一致，env 无 ZDOTDIR", async () => {
    const { project, store } = await createStore();
    ptyMock.spawn.mockReturnValue(new FakePty());
    const pwsh = process.platform === "win32" ? "powershell.exe" : "/usr/bin/pwsh";
    const terminals = new TerminalSupervisor(
      store,
      () => undefined,
      () => ({ file: pwsh, args: ["-NoLogo"] }),
    );

    terminals.open(project.id, "thread", "bottom", 80, 24);

    const [file, args, options] = ptyMock.spawn.mock.calls[0]!;
    expect(file).toBe(pwsh);
    expect(args).toEqual(["-NoLogo"]);
    expect((options as { env?: Record<string, string | undefined> }).env).not.toHaveProperty("ZDOTDIR");
    terminals.dispose();
  });

  it("注入模板包含 OSC 633 序列与用户配置保留逻辑", () => {
    expect(BASH_INJECTION).toContain("\\033]633;A;");
    expect(BASH_INJECTION).toContain("\\033]633;1");
    expect(BASH_INJECTION).toContain("\\033]633;2");
    expect(BASH_INJECTION).toContain("$" + "{HOME}/.bashrc");
    expect(ZSH_INJECTION).toContain("\\033]633;A;");
    expect(ZSH_INJECTION).toContain("\\033]633;1");
    expect(ZSH_INJECTION).toContain("\\033]633;2");
    expect(ZSH_INJECTION).toContain("precmd_functions");
    expect(ZSH_INJECTION).toContain("$" + "{HOME}/.zshrc");
  });

  it("isInjectedShell 匹配 bash/zsh 及其 .exe，不匹配其他 shell", () => {
    expect(isInjectedShell("bash")).toBe(true);
    expect(isInjectedShell(join("usr", "bin", "zsh"))).toBe(true);
    expect(isInjectedShell(join("Git", "bin", "bash.exe"))).toBe(true);
    expect(isInjectedShell("zsh.exe")).toBe(true);
    expect(isInjectedShell("powershell.exe")).toBe(false);
    expect(isInjectedShell("fish")).toBe(false);
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
