import type { ExtensionUIContext, ExtensionWidgetOptions, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type Terminal, TuiMainScreen, truncateToWidth } from "@earendil-works/pi-tui";
import type { DesktopExtensionHostState, DesktopWidgetViewport } from "../../shared/desktop-extension-contracts.ts";
import { createDesktopWidgetTheme } from "./desktop-widget-theme.ts";

type Widget = DesktopExtensionHostState["widgets"][number];
type WidgetComponent = Component & { dispose?(): void };
type WidgetFactory = Exclude<Parameters<ExtensionUIContext["setWidget"]>[1], undefined>;
interface Entry {
  component: WidgetComponent;
  tui: TuiMainScreen;
  columns: number;
  placement: Widget["placement"];
  snapshot: Widget;
}

/** Runs only read-only widget rendering. No process terminal is started or input forwarded. */
export class DesktopWidgetAdapter {
  private readonly entries = new Map<string, Entry>();
  private timer?: ReturnType<typeof setInterval>;
  private themeMode: "light" | "dark" = "dark";
  private themeInstance = createDesktopWidgetTheme("dark");
  readonly theme: Theme;
  private readonly hostId: string;
  private readonly publish: (widget: Widget) => void;
  private readonly warn: (message: string) => void;

  constructor(hostId: string, publish: (widget: Widget) => void, warn: (message: string) => void) {
    this.hostId = hostId;
    this.publish = publish;
    this.warn = warn;
    this.theme = new Proxy(this.themeInstance, {
      get: (_target, property) => {
        const value = Reflect.get(this.themeInstance, property);
        return typeof value === "function" ? value.bind(this.themeInstance) : value;
      },
    });
  }

  set(key: string, factory: WidgetFactory, options?: ExtensionWidgetOptions): void {
    const columns = this.entries.get(key)?.columns ?? 80;
    this.remove(key);
    if (this.entries.size >= 32) {
      this.warn("Desktop widget limit exceeded (32)");
      return;
    }
    const terminal: Terminal = {
      columns,
      rows: 40,
      kittyProtocolActive: false,
      start: () => undefined,
      stop: () => undefined,
      drainInput: async () => undefined,
      write: () => undefined,
      moveBy: () => undefined,
      hideCursor: () => undefined,
      showCursor: () => undefined,
      clearLine: () => undefined,
      clearFromCursor: () => undefined,
      clearScreen: () => undefined,
      setTitle: () => undefined,
      setProgress: () => undefined,
    };
    const tui = new TuiMainScreen(terminal);
    // The bounded host refresh loop handles requestRender without starting a terminal renderer.
    tui.requestRender = () => undefined;
    let component: WidgetComponent | undefined;
    try {
      component = factory(tui, this.theme);
      if (!component || typeof component.render !== "function" || typeof component.invalidate !== "function") {
        throw new Error("Widget factory must return a Component");
      }
      const placement = options?.placement === "aboveEditor" ? "aboveEditor" : "belowEditor";
      this.entries.set(key, { component, tui, columns, placement, snapshot: { key, lines: [], placement } });
      this.render(key);
      if (this.entries.size > 0 && !this.timer) {
        this.timer = setInterval(() => {
          for (const currentKey of this.entries.keys()) this.render(currentKey);
        }, 250);
        this.timer.unref();
      }
    } catch (error) {
      try {
        component?.dispose?.();
      } catch {
        /* Preserve the original factory error. */
      }
      tui.stop();
      this.warn(`Desktop widget ${key} is unsupported: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  configure(viewport: DesktopWidgetViewport): void {
    if (viewport.hostId !== this.hostId) return;
    if (
      !Number.isSafeInteger(viewport.columns) ||
      viewport.columns < 1 ||
      viewport.columns > 300 ||
      (viewport.theme !== "dark" && viewport.theme !== "light")
    )
      throw new Error("Invalid widget viewport");
    const entry = this.entries.get(viewport.key);
    if (!entry) return;
    const themeChanged = viewport.theme !== this.themeMode;
    if (themeChanged) {
      this.themeMode = viewport.theme;
      this.themeInstance = createDesktopWidgetTheme(viewport.theme);
    }
    const resized = entry.columns !== viewport.columns;
    entry.columns = viewport.columns;
    Object.defineProperty(entry.tui.terminal, "columns", { value: entry.columns, configurable: true });
    for (const [key, current] of this.entries) {
      if (!themeChanged && !(key === viewport.key && resized)) continue;
      try {
        current.component.invalidate();
        this.render(key);
      } catch (error) {
        this.fail(key, error);
      }
    }
  }

  remove(key: string): void {
    const entry = this.entries.get(key);
    this.entries.delete(key);
    if (entry) {
      try {
        entry.component.dispose?.();
      } catch (error) {
        this.warn(`Widget disposal failed: ${String(error)}`);
      }
      entry.tui.stop();
    }
    if (this.entries.size === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  clear(): void {
    for (const key of this.entries.keys()) this.remove(key);
  }

  private render(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    try {
      const output = entry.component.render(entry.columns);
      if (!Array.isArray(output) || !output.every((line) => typeof line === "string"))
        throw new Error("Invalid widget lines");
      const lines = output.slice(0, 40).map((line) => truncateToWidth(line.slice(0, 4096), entry.columns));
      const snapshot: Widget = {
        key,
        placement: entry.placement,
        hostId: this.hostId,
        columns: entry.columns,
        lines,
        truncated: output.length > 40 || output.some((line) => line.length > 4096),
      };
      if (JSON.stringify(snapshot) !== JSON.stringify(entry.snapshot)) {
        entry.snapshot = snapshot;
        this.publish(snapshot);
      }
    } catch (error) {
      this.fail(key, error);
    }
  }

  private fail(key: string, error: unknown): void {
    const entry = this.entries.get(key);
    this.remove(key);
    this.warn(`Desktop widget ${key} render failed: ${error instanceof Error ? error.message : String(error)}`);
    this.publish({ key, placement: entry?.placement ?? "belowEditor", lines: ["插件展示内容暂不可用"] });
  }
}
