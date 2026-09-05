import { Text } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopExtensionHost } from "../src/main/pi/desktop-extension-host.ts";

afterEach(() => vi.useRealTimers());

describe("Desktop widget component adapter", () => {
  it("renders arbitrary Pi components with a theme and disposes replaced factories", () => {
    vi.useFakeTimers();
    const host = new DesktopExtensionHost(vi.fn(), () => []);
    const ui = host.createContext();
    const dispose = vi.fn();
    ui.setWidget("third-party-progress", (_tui, theme) => {
      const component = new Text(theme.fg("success", "Tests passed"), 0, 0);
      return { render: (width) => component.render(width), invalidate: () => component.invalidate(), dispose };
    });
    expect(ui.widgetCapabilities).toEqual({ components: true, input: false });
    expect(host.hostState.widgets[0]).toMatchObject({
      key: "third-party-progress",
      columns: 80,
      placement: "belowEditor",
    });
    expect(host.hostState.widgets[0]?.lines.join("\n")).toContain("Tests passed");
    expect(vi.getTimerCount()).toBe(1);
    ui.setWidget("third-party-progress", ["plain replacement"]);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(host.hostState.widgets[0]?.lines).toEqual(["plain replacement"]);
    host.dispose();
  });

  it("invalidates on measured width/theme changes, preserves width on replacement, rejects stale hosts", () => {
    vi.useFakeTimers();
    const host = new DesktopExtensionHost(vi.fn(), () => []);
    const ui = host.createContext();
    const invalidate = vi.fn();
    ui.setWidget(
      "layout",
      (tui, theme) => ({
        render: (width) => [`${width}/${tui.terminal.columns}/${theme.name}`],
        invalidate,
      }),
      { placement: "aboveEditor" },
    );
    const hostId = host.hostState.widgets[0]?.hostId ?? "";
    host.configureWidget({ hostId: "stale", key: "layout", columns: 30, theme: "light" });
    expect(invalidate).not.toHaveBeenCalled();
    host.configureWidget({ hostId, key: "layout", columns: 50, theme: "light" });
    expect(invalidate).toHaveBeenCalledOnce();
    expect(host.hostState.widgets[0]?.lines).toEqual(["50/50/desktop-light"]);
    ui.setWidget("layout", (tui) => ({ render: (width) => [`${width}/${tui.terminal.columns}`], invalidate }));
    expect(host.hostState.widgets[0]?.lines).toEqual(["50/50"]);
    expect(() => host.configureWidget({ hostId, key: "layout", columns: NaN, theme: "light" })).toThrow(
      "Invalid widget viewport",
    );
    host.dispose();
  });

  it("updates mutable output, bounds it, and clears all timers on reset and dispose", () => {
    vi.useFakeTimers();
    const changed = vi.fn();
    const host = new DesktopExtensionHost(changed, () => []);
    const ui = host.createContext();
    let label = "working";
    const dispose = vi.fn();
    const factory = () => ({ render: () => Array.from({ length: 50 }, () => label), invalidate: vi.fn(), dispose });
    ui.setWidget("one", factory);
    expect(host.hostState.widgets[0]?.truncated).toBe(true);
    expect(host.hostState.widgets[0]?.lines).toHaveLength(40);
    changed.mockClear();
    vi.advanceTimersByTime(250);
    expect(changed).not.toHaveBeenCalled();
    label = "complete";
    vi.advanceTimersByTime(250);
    expect(host.hostState.widgets[0]?.lines[0]).toBe("complete");
    host.reset();
    expect(dispose).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    ui.setWidget("two", factory);
    host.dispose();
    expect(dispose).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("isolates render failures without losing other widgets", () => {
    vi.useFakeTimers();
    const warnings = vi.fn();
    const host = new DesktopExtensionHost(vi.fn(), () => [], vi.fn(), warnings);
    const ui = host.createContext();
    ui.setWidget("plain", ["still present"]);
    const dispose = vi.fn();
    ui.setWidget("broken", () => ({
      render: () => {
        throw new Error("bad render");
      },
      invalidate: vi.fn(),
      dispose,
    }));
    expect(host.hostState.widgets[0]?.lines).toEqual(["still present"]);
    expect(host.hostState.widgets[1]?.lines).toEqual(["插件展示内容暂不可用"]);
    expect(dispose).toHaveBeenCalledOnce();
    expect(warnings).toHaveBeenCalledWith(expect.stringContaining("bad render"));
    expect(vi.getTimerCount()).toBe(0);
    host.dispose();
  });
});
