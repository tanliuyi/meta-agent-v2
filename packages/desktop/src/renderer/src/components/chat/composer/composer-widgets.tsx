import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";
import type { SessionControlState } from "../../../../../shared/contracts.ts";
import type { DesktopWidgetViewport } from "../../../../../shared/desktop-extension-contracts.ts";
import { readCssToken, resolveTerminalTheme, TERMINAL_FONT_TOKEN } from "../../../shared/lib/terminal-theme.ts";
import { useTheme } from "../../../state/theme.tsx";

type Widget = SessionControlState["extensionHost"]["widgets"][number];
interface ComposerWidgetsProps {
  widgets: Widget[];
  onViewportChange?(viewport: DesktopWidgetViewport): Promise<void>;
}

/** Generic Pi widget presentation. String payloads are text, never inferred as plugin protocols. */
export function ComposerWidgets({ widgets, onViewportChange }: ComposerWidgetsProps) {
  if (widgets.length === 0) return null;
  return (
    <div className="composer-widget-list grid min-w-0 gap-2 px-2 py-2 text-xs">
      {widgets.map((widget) =>
        widget.hostId || widget.lines.some((line) => line.includes("\x1b")) ? (
          <ComposerTerminalWidget
            key={`${widget.key}:${widget.hostId ?? "text"}`}
            widget={widget}
            onViewportChange={onViewportChange}
          />
        ) : (
          <pre
            key={widget.key}
            className="m-0 min-w-0 whitespace-pre-wrap break-words font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]"
          >
            {widget.lines.join("\n")}
          </pre>
        ),
      )}
    </div>
  );
}

function ComposerTerminalWidget({
  widget,
  onViewportChange,
}: {
  widget: Widget;
  onViewportChange?: ComposerWidgetsProps["onViewportChange"];
}) {
  const container = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const latest = useRef({ widget, onViewportChange });
  latest.current = { widget, onViewportChange };
  const { resolvedTheme } = useTheme();
  const [error, setError] = useState<string | null>(null);
  const [rowHeight, setRowHeight] = useState(18);

  useEffect(() => {
    if (!container.current) return;
    const rootStyle = getComputedStyle(document.documentElement);
    const { ansi, ...theme } = resolveTerminalTheme(rootStyle);
    const terminal = new Terminal({
      cols: widget.columns ?? 80,
      rows: Math.max(1, Math.min(40, widget.lines.length)),
      fontFamily: readCssToken(rootStyle, TERMINAL_FONT_TOKEN),
      fontSize: 12,
      lineHeight: 1.5,
      letterSpacing: 0,
      theme: { ...theme, ...ansi, background: "rgba(0, 0, 0, 0)" },
      allowTransparency: true,
      allowProposedApi: true,
      disableStdin: true,
      cursorBlink: false,
      scrollback: 0,
      screenReaderMode: true,
      minimumContrastRatio: 4.5,
      rescaleOverlappingGlyphs: true,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.loadAddon(new Unicode11Addon());
    terminal.unicode.activeVersion = "11";
    terminal.open(container.current);
    const measureRows = () => {
      const row = container.current?.querySelector<HTMLElement>(".xterm-rows > div");
      const measured = row?.getBoundingClientRect().height;
      if (measured && Number.isFinite(measured) && measured > 0) setRowHeight(measured);
    };
    requestAnimationFrame(measureRows);
    terminalRef.current = terminal;
    fitRef.current = fit;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let previous = "";
    const resize = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const dimensions = fit.proposeDimensions();
        if (!dimensions) return;
        const columns = Math.max(1, Math.min(300, dimensions.cols));
        const current = latest.current;
        const signature = `${columns}:${resolvedTheme}`;
        if (signature === previous) return;
        previous = signature;
        terminal.resize(columns, Math.max(1, Math.min(40, current.widget.lines.length)));
        if (current.widget.hostId && current.onViewportChange) {
          void current
            .onViewportChange({ hostId: current.widget.hostId, key: current.widget.key, columns, theme: resolvedTheme })
            .catch((value: unknown) => {
              if (active) setError(value instanceof Error ? value.message : String(value));
            });
        }
      }, 100);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(container.current);
    resize();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      observer.disconnect();
      terminalRef.current = null;
      fitRef.current = null;
      terminal.dispose();
    };
  }, [resolvedTheme, widget.hostId, widget.key]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    const columns = fitRef.current?.proposeDimensions()?.cols ?? widget.columns ?? 80;
    terminal.resize(Math.max(1, Math.min(300, columns)), Math.max(1, Math.min(40, widget.lines.length)));
    // Each snapshot replaces the screen; styles do not bleed between Pi render lines.
    terminal.write(
      `\x1b[0m\x1b[2J\x1b[H\x1b[?25l${widget.lines
        .slice(0, 40)
        .map((line) => `${line}\x1b[0m\x1b]8;;\x07`)
        .join("\r\n")}`,
    );
  }, [widget.lines, widget.columns, resolvedTheme]);

  return (
    <section aria-label={`插件 ${widget.key}`} className="min-w-0">
      <div>
        <div
          ref={container}
          className="composer-terminal-widget"
          style={{ height: rowHeight * Math.max(1, Math.min(40, widget.lines.length)) }}
        />
      </div>
      {widget.truncated || widget.lines.length > 40 ? (
        <p className="m-0 pt-1 text-muted-foreground">插件内容已截断</p>
      ) : null}
      {error ? (
        <p role="alert" className="m-0 pt-1 text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}
