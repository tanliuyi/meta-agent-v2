import { readCssToken, resolveTerminalTheme, TERMINAL_FONT_TOKEN } from "@renderer/shared/lib/terminal-theme";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { TerminalEvent } from "../../../../shared/contracts.ts";
import { errorMessage } from "../../shared/lib/error-message.ts";
import { useDesktopSelector } from "../../state/desktop-context.tsx";
import { selectActiveProjectId, selectActiveThreadId } from "../../state/desktop-selectors.ts";
import { useTheme } from "../../state/theme.tsx";

export interface TerminalViewHandle {
  restart(): Promise<void>;
}

/** 将当前 session 的 PTY 快照与增量事件渲染到 xterm。 */
export const TerminalView = forwardRef<TerminalViewHandle, { terminalId: string }>(function TerminalView(
  { terminalId },
  ref,
) {
  const projectId = useDesktopSelector(selectActiveProjectId);
  const threadId = useDesktopSelector(selectActiveThreadId);
  const { resolvedTheme } = useTheme();
  const container = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const revision = useRef(0);
  const [status, setStatus] = useState<string | null>(null);

  useImperativeHandle(ref, () => ({
    async restart() {
      const terminal = terminalRef.current;
      if (!projectId || !threadId || !terminal) return;
      const next = await window.desktop.terminals.restart(
        projectId,
        threadId,
        terminalId,
        terminal.cols,
        terminal.rows,
      );
      if (next.revision >= revision.current) {
        terminal.reset();
        terminal.write(next.output);
        revision.current = next.revision;
        setStatus(next.running ? null : "终端进程已退出");
      }
    },
  }));

  useEffect(() => {
    if (!projectId || !threadId || !container.current) return;
    let active = true;
    let opened = false;
    const pending: TerminalEvent[] = [];
    const rootStyle = getComputedStyle(document.documentElement);
    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: readCssToken(rootStyle, TERMINAL_FONT_TOKEN),
      fontSize: 12,
      lineHeight: 1.25,
      letterSpacing: 0,
      scrollback: 5000,
      theme: resolveTerminalTheme(rootStyle),
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container.current);
    terminalRef.current = terminal;
    let resizeFrame: number | undefined;
    let lastGrid: TerminalGrid | undefined;

    const matches = (event: TerminalEvent) =>
      event.projectId === projectId && event.threadId === threadId && event.terminalId === terminalId;
    const apply = (event: TerminalEvent) => {
      if (event.revision <= revision.current) return;
      revision.current = event.revision;
      if (event.type === "data") terminal.write(event.data);
      else if (event.type === "reset") {
        terminal.reset();
        setStatus(null);
      } else setStatus(`终端进程已退出 (${event.exitCode})`);
    };
    const unsubscribe = window.desktop.terminals.onEvent((event) => {
      if (!active || !matches(event)) return;
      if (!opened) pending.push(event);
      else apply(event);
    });
    const input = terminal.onData((data) => {
      void window.desktop.terminals
        .write(projectId, threadId, terminalId, data)
        .catch((value: unknown) => setStatus(errorMessage(value)));
    });
    const syncSize = () => {
      if (resizeFrame !== undefined) return;
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = undefined;
        fit.fit();
        const grid = { columns: terminal.cols, rows: terminal.rows };
        if (!opened || isSameTerminalGrid(lastGrid, grid)) return;
        lastGrid = grid;
        void window.desktop.terminals
          .resize(projectId, threadId, terminalId, grid.columns, grid.rows)
          .catch((value: unknown) => setStatus(errorMessage(value)));
      });
    };
    const resize = new ResizeObserver(syncSize);
    resize.observe(container.current);
    fit.fit();
    lastGrid = { columns: terminal.cols, rows: terminal.rows };

    void window.desktop.terminals
      .open(projectId, threadId, terminalId, terminal.cols, terminal.rows)
      .then((initial) => {
        if (!active) return;
        terminal.write(initial.output);
        revision.current = initial.revision;
        opened = true;
        syncSize();
        for (const event of pending) apply(event);
        setStatus(initial.running ? null : "终端进程已退出");
      })
      .catch((value: unknown) => {
        if (active) setStatus(errorMessage(value));
      });

    return () => {
      active = false;
      terminalRef.current = null;
      resize.disconnect();
      if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame);
      input.dispose();
      unsubscribe();
      fit.dispose();
      terminal.dispose();
    };
  }, [projectId, terminalId, threadId]);

  useEffect(() => {
    if (terminalRef.current) {
      terminalRef.current.options.theme = resolveTerminalTheme(getComputedStyle(document.documentElement));
    }
  }, [resolvedTheme]);

  return (
    <div className="terminal-view">
      <div ref={container} className="terminal-xterm" aria-label="终端" />
      {status ? <div className="terminal-status">{status}</div> : null}
    </div>
  );
});

export interface TerminalGrid {
  columns: number;
  rows: number;
}

export function isSameTerminalGrid(previous: TerminalGrid | undefined, current: TerminalGrid): boolean {
  return previous?.columns === current.columns && previous.rows === current.rows;
}
