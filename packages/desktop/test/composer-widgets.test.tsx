// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopExtensionHostState } from "../src/shared/desktop-extension-contracts.ts";

const state = vi.hoisted(() => ({
  theme: "dark",
  columns: 48,
  terminals: [] as Array<{
    write: ReturnType<typeof vi.fn>;
    resize: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  }>,
  observers: [] as Array<{ callback: () => void; disconnect: ReturnType<typeof vi.fn> }>,
}));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    write = vi.fn();
    resize = vi.fn();
    dispose = vi.fn();
    unicode = { activeVersion: "6" };
    constructor() {
      state.terminals.push(this);
    }
    loadAddon() {}
    open() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    proposeDimensions() {
      return { cols: state.columns, rows: 3 };
    }
  },
}));
vi.mock("@xterm/addon-unicode11", () => ({ Unicode11Addon: class {} }));
vi.mock("../src/renderer/src/state/theme.tsx", () => ({ useTheme: () => ({ resolvedTheme: state.theme }) }));
vi.mock("../src/renderer/src/shared/lib/terminal-theme.ts", () => ({
  readCssToken: () => "monospace",
  TERMINAL_FONT_TOKEN: "--terminal-font-family",
  resolveTerminalTheme: () => ({ foreground: "#ffffff", background: "#000000", ansi: { red: "#ff0000" } }),
}));

import { ComposerWidgets } from "../src/renderer/src/components/chat/composer/composer-widgets.tsx";

let container: HTMLDivElement;
let root: Root;
const widget: DesktopExtensionHostState["widgets"][number] = {
  key: "any-plugin",
  hostId: "host-1",
  columns: 80,
  placement: "belowEditor",
  lines: ["\x1b[32mComplete", "Task details"],
};

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  state.theme = "dark";
  state.columns = 48;
  state.terminals.length = 0;
  state.observers.length = 0;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      disconnect = vi.fn();
      constructor(callback: () => void) {
        state.observers.push({ callback, disconnect: this.disconnect });
      }
      observe() {}
    },
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("ComposerWidgets", () => {
  it("preserves arbitrary plain text and unknown JSON without protocol dispatch", async () => {
    const text = 'PI_UNKNOWN_JSON:{"task":"<script>not html</script>"}';
    await act(async () =>
      root.render(<ComposerWidgets widgets={[{ key: "unknown", lines: [text], placement: "belowEditor" }]} />),
    );
    expect(container.textContent).toBe(text);
    expect(container.querySelector("script")).toBeNull();
    expect(state.terminals).toHaveLength(0);
  });

  it("sends measured widths, replaces snapshots, refreshes themes and cleans up resources", async () => {
    const configure = vi.fn().mockResolvedValue(undefined);
    await act(async () => root.render(<ComposerWidgets widgets={[widget]} onViewportChange={configure} />));
    await act(async () => vi.advanceTimersByTime(100));
    expect(configure).toHaveBeenLastCalledWith({ hostId: "host-1", key: "any-plugin", columns: 48, theme: "dark" });
    expect(state.terminals[0]?.write).toHaveBeenCalledWith(expect.stringContaining("Complete\x1b[0m"));
    await act(async () =>
      root.render(<ComposerWidgets widgets={[{ ...widget, lines: ["Next snapshot"] }]} onViewportChange={configure} />),
    );
    expect(state.terminals).toHaveLength(1);
    expect(state.terminals[0]?.write).toHaveBeenLastCalledWith(expect.stringContaining("Next snapshot"));
    state.columns = 30;
    state.observers[0]?.callback();
    await act(async () => vi.advanceTimersByTime(100));
    expect(configure).toHaveBeenLastCalledWith(expect.objectContaining({ columns: 30 }));
    state.theme = "light";
    await act(async () => root.render(<ComposerWidgets widgets={[widget]} onViewportChange={configure} />));
    await act(async () => vi.advanceTimersByTime(100));
    expect(state.terminals[0]?.dispose).toHaveBeenCalledOnce();
    expect(state.observers[0]?.disconnect).toHaveBeenCalledOnce();
    expect(configure).toHaveBeenLastCalledWith(expect.objectContaining({ theme: "light" }));
    await act(async () => root.render(<ComposerWidgets widgets={[]} />));
    expect(state.terminals[1]?.dispose).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not report late viewport errors after unmount", async () => {
    let reject: (error: Error) => void = () => undefined;
    const configure = () =>
      new Promise<void>((_resolve, rejectPromise) => {
        reject = rejectPromise;
      });
    await act(async () => root.render(<ComposerWidgets widgets={[widget]} onViewportChange={configure} />));
    await act(async () => vi.advanceTimersByTime(100));
    await act(async () => root.render(<ComposerWidgets widgets={[]} />));
    await act(async () => reject(new Error("late")));
    expect(container.textContent).toBe("");
    expect(vi.getTimerCount()).toBe(0);
  });
});
