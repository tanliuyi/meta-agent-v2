import { basename } from "node:path";
import { getShellConfig, SettingsManager } from "@earendil-works/pi-coding-agent";
import * as pty from "node-pty";
import type { TerminalEvent, TerminalSnapshot } from "../../shared/contracts.ts";
import type { ProjectStore } from "../store/project-store.ts";
import { TerminalOutputBuffer } from "./terminal-output-buffer.ts";

const MAX_OUTPUT = 2 * 1024 * 1024;
const MAX_DATA_EVENT_LENGTH = 16 * 1024;
const DATA_FLUSH_DELAY_MS = 16;
const MIN_COLS = 20;
const MAX_COLS = 500;
const MIN_ROWS = 4;
const MAX_ROWS = 200;
const TERMINAL_SHUTDOWN_GRACE_MS = 2_000;
const TERMINAL_SHUTDOWN_TIMEOUT_MS = 5_000;

export interface TerminalShellCommand {
  file: string;
  args: string[];
}

export type TerminalShellResolver = (cwd: string) => TerminalShellCommand;

interface TerminalProcess {
  pty: pty.IPty;
  data?: pty.IDisposable;
  exit?: pty.IDisposable;
  shell: string;
  output: TerminalOutputBuffer;
  pendingData: string[];
  pendingDataLength: number;
  dataFlushTimer?: ReturnType<typeof setTimeout>;
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
  private readonly resolveShell: TerminalShellResolver;
  private readonly restoreBlockedProjects = new Map<string, number>();

  constructor(
    projects: ProjectStore,
    changed: (event: TerminalEvent) => void,
    resolveShell: TerminalShellResolver = () => resolveTerminalShell(),
  ) {
    this.projects = projects;
    this.changed = changed;
    this.resolveShell = resolveShell;
  }

  /** Close affected PTYs, await their exit, and block terminal input for the restore duration. */
  async beginWorkspaceRestore(projectIds: readonly string[]): Promise<() => void> {
    const uniqueProjectIds = [...new Set(projectIds)];
    for (const projectId of uniqueProjectIds) {
      this.restoreBlockedProjects.set(projectId, (this.restoreBlockedProjects.get(projectId) ?? 0) + 1);
    }
    const release = () => {
      for (const projectId of uniqueProjectIds) {
        const remaining = (this.restoreBlockedProjects.get(projectId) ?? 1) - 1;
        if (remaining > 0) this.restoreBlockedProjects.set(projectId, remaining);
        else this.restoreBlockedProjects.delete(projectId);
      }
    };
    try {
      await Promise.all(uniqueProjectIds.map((projectId) => this.disposeProjectAndWait(projectId)));
    } catch (error) {
      release();
      throw error;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      release();
    };
  }

  /** 打开已有 PTY，若不存在则在 Project cwd 中创建。 */
  open(projectId: string, threadId: string, terminalId: string, cols: number, rows: number): TerminalSnapshot {
    this.assertWorkspaceWritable(projectId);
    const key = terminalKey(projectId, threadId, terminalId);
    let terminal = this.terminals.get(key);
    if (!terminal) {
      terminal = this.create(projectId, threadId, terminalId, cols, rows);
      this.terminals.set(key, terminal);
    } else {
      this.flushData(key, projectId, threadId, terminalId, terminal);
      if (terminal.running) {
        terminal.pty.resize(clamp(cols, MIN_COLS, MAX_COLS), clamp(rows, MIN_ROWS, MAX_ROWS));
      }
    }
    return snapshot(projectId, threadId, terminalId, terminal);
  }

  /** 将 renderer 输入写入指定 PTY。 */
  write(projectId: string, threadId: string, terminalId: string, data: string): void {
    this.assertWorkspaceWritable(projectId);
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
    this.assertWorkspaceWritable(projectId);
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
    this.restoreBlockedProjects.clear();
  }

  private assertWorkspaceWritable(projectId: string): void {
    if (this.restoreBlockedProjects.has(projectId)) throw new Error("终端在 checkpoint 恢复期间不可用");
  }

  private create(projectId: string, threadId: string, terminalId: string, cols: number, rows: number): TerminalProcess {
    const key = terminalKey(projectId, threadId, terminalId);
    const cwd = this.projects.getCwd(projectId);
    const shell = this.resolveShell(cwd);
    const terminalPty = pty.spawn(shell.file, shell.args, {
      name: "xterm-256color",
      cwd,
      env: process.env,
      cols: clamp(cols, MIN_COLS, MAX_COLS),
      rows: clamp(rows, MIN_ROWS, MAX_ROWS),
      useConpty: process.platform === "win32",
    });
    const terminal: TerminalProcess = {
      pty: terminalPty,
      shell: shell.file,
      output: new TerminalOutputBuffer(MAX_OUTPUT),
      pendingData: [],
      pendingDataLength: 0,
      revision: this.nextRevision(key),
      running: true,
      disposed: false,
    };
    terminal.data = terminalPty.onData((data) => {
      if (terminal.disposed) return;
      terminal.output.append(data);
      this.queueData(key, projectId, threadId, terminalId, terminal, data);
    });
    terminal.exit = terminalPty.onExit(({ exitCode }) => {
      if (terminal.disposed) return;
      this.flushData(key, projectId, threadId, terminalId, terminal);
      terminal.running = false;
      terminal.revision = this.nextRevision(key);
      this.changed({ type: "exit", projectId, threadId, terminalId, revision: terminal.revision, exitCode });
    });
    return terminal;
  }

  private queueData(
    key: string,
    projectId: string,
    threadId: string,
    terminalId: string,
    terminal: TerminalProcess,
    data: string,
  ): void {
    let offset = 0;
    while (offset < data.length) {
      const available = MAX_DATA_EVENT_LENGTH - terminal.pendingDataLength;
      const end = Math.min(data.length, offset + available);
      terminal.pendingData.push(data.slice(offset, end));
      terminal.pendingDataLength += end - offset;
      offset = end;
      if (terminal.pendingDataLength >= MAX_DATA_EVENT_LENGTH) {
        this.flushData(key, projectId, threadId, terminalId, terminal);
      }
    }
    if (terminal.pendingDataLength === 0) return;
    terminal.dataFlushTimer ??= setTimeout(() => {
      terminal.dataFlushTimer = undefined;
      this.flushData(key, projectId, threadId, terminalId, terminal);
    }, DATA_FLUSH_DELAY_MS);
  }

  private flushData(
    key: string,
    projectId: string,
    threadId: string,
    terminalId: string,
    terminal: TerminalProcess,
  ): void {
    if (terminal.dataFlushTimer) clearTimeout(terminal.dataFlushTimer);
    terminal.dataFlushTimer = undefined;
    if (terminal.pendingDataLength === 0) return;
    const data = terminal.pendingData.length === 1 ? terminal.pendingData[0]! : terminal.pendingData.join("");
    terminal.pendingData = [];
    terminal.pendingDataLength = 0;
    terminal.revision = this.nextRevision(key);
    this.changed({ type: "data", projectId, threadId, terminalId, revision: terminal.revision, data });
  }

  private require(projectId: string, threadId: string, terminalId: string): TerminalProcess {
    const terminal = this.terminals.get(terminalKey(projectId, threadId, terminalId));
    if (!terminal) throw new Error("终端尚未打开");
    return terminal;
  }

  private async disposeProjectAndWait(projectId: string): Promise<void> {
    const prefix = `${projectId}:`;
    const keys = [...this.terminals.keys()].filter((key) => key.startsWith(prefix));
    await Promise.all(keys.map((key) => this.disposeTerminalAndWait(key)));
  }

  private async disposeTerminalAndWait(key: string): Promise<void> {
    const terminal = this.terminals.get(key);
    if (!terminal) return;
    this.detachTerminal(key, terminal);
    if (!terminal.running) return;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let exit: pty.IDisposable | undefined;
      let forceTimer: ReturnType<typeof setTimeout> | undefined;
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (forceTimer) clearTimeout(forceTimer);
        if (timeoutTimer) clearTimeout(timeoutTimer);
        exit?.dispose();
        if (error) reject(error);
        else resolve();
      };
      exit = terminal.pty.onExit(() => finish());
      forceTimer = setTimeout(() => {
        try {
          terminal.pty.kill("SIGKILL");
        } catch {
          // The PTY may have exited between the grace timer and this signal.
        }
      }, TERMINAL_SHUTDOWN_GRACE_MS);
      timeoutTimer = setTimeout(
        () => finish(new Error(`Terminal process ${terminal.pty.pid} did not exit before checkpoint restore`)),
        TERMINAL_SHUTDOWN_TIMEOUT_MS,
      );
      try {
        terminal.pty.kill();
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private detachTerminal(key: string, terminal: TerminalProcess): void {
    this.terminals.delete(key);
    terminal.disposed = true;
    if (terminal.dataFlushTimer) clearTimeout(terminal.dataFlushTimer);
    terminal.dataFlushTimer = undefined;
    terminal.pendingData = [];
    terminal.pendingDataLength = 0;
    terminal.data?.dispose();
    terminal.exit?.dispose();
  }

  private disposeTerminal(key: string): void {
    const terminal = this.terminals.get(key);
    if (!terminal) return;
    this.detachTerminal(key, terminal);
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

export function createTerminalShellResolver(agentDir: string, managedShellPath?: string): TerminalShellResolver {
  return (cwd) => {
    const configuredShellPath = SettingsManager.create(cwd, agentDir).getShellPath();
    return resolveTerminalShell(configuredShellPath, managedShellPath);
  };
}

export function resolveTerminalShell(configuredShellPath?: string, managedShellPath?: string): TerminalShellCommand {
  const candidates = [
    ...new Set([configuredShellPath, managedShellPath].filter((path): path is string => Boolean(path))),
    undefined,
  ];
  for (const candidate of candidates) {
    try {
      return interactiveShellCommand(getShellConfig(candidate).shell);
    } catch {
      // Continue through managed/system discovery before the terminal-only platform fallback.
    }
  }
  const fallback =
    process.env.SHELL ?? process.env.COMSPEC ?? (process.platform === "win32" ? "powershell.exe" : "/bin/sh");
  return interactiveShellCommand(fallback);
}

function interactiveShellCommand(file: string): TerminalShellCommand {
  const name = basename(file).toLowerCase();
  if (name === "powershell.exe" || name === "pwsh.exe" || name === "pwsh") return { file, args: ["-NoLogo"] };
  if (name === "bash" || name === "bash.exe" || name === "zsh" || name === "zsh.exe") {
    return { file, args: ["--login", "-i"] };
  }
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
    output: terminal.output.toString(),
    running: terminal.running,
    cols: terminal.pty.cols,
    rows: terminal.pty.rows,
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}
