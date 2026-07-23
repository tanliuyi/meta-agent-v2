import { describe, expect, it, vi } from "vitest";
import { DesktopExtensionCompatibilityError, DesktopExtensionHost } from "../src/main/pi/desktop-extension-host.ts";

describe("DesktopExtensionHost", () => {
  it("keeps blocking dialogs until renderer responds", async () => {
    const changed = vi.fn();
    const host = new DesktopExtensionHost(changed, () => ["tool-1"]);
    const answer = host.createContext().select("环境", ["dev", "prod"]);

    expect(host.requests).toMatchObject([
      { type: "select", title: "环境", options: ["dev", "prod"], toolCallId: "tool-1" },
    ]);
    host.respond({ requestId: host.requests[0]?.id ?? "", value: "prod" });

    await expect(answer).resolves.toBe("prod");
    expect(host.requests).toEqual([]);
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("supports declarative status, title, text widgets, and one-way composer commands", () => {
    const host = new DesktopExtensionHost(
      () => undefined,
      () => [],
    );
    const ui = host.createContext();

    ui.setStatus("lint", "ready");
    ui.setTitle("Extension title");
    ui.setWidget("summary", ["A", "B"], { placement: "aboveEditor" });
    ui.setEditorText("draft");
    ui.pasteToEditor(" + more");

    expect(host.hostState).toEqual({
      statuses: { lint: "ready" },
      windowTitle: "Extension title",
      composerCommand: expect.objectContaining({ revision: 2, mode: "append", text: " + more" }),
      widgets: [{ key: "summary", lines: ["A", "B"], placement: "aboveEditor" }],
    });
    ui.setStatus("lint", undefined);
    ui.setWidget("summary", undefined);
    expect(host.hostState).toMatchObject({ statuses: {}, widgets: [] });
  });

  it("uses a fresh composer command identity after host replacement", () => {
    const first = new DesktopExtensionHost(
      () => undefined,
      () => [],
    );
    const second = new DesktopExtensionHost(
      () => undefined,
      () => [],
    );
    first.createContext().setEditorText("first");
    second.createContext().setEditorText("second");

    expect(first.hostState.composerCommand?.revision).toBe(1);
    expect(second.hostState.composerCommand?.revision).toBe(1);
    expect(first.hostState.composerCommand?.hostId).not.toBe(second.hostState.composerCommand?.hostId);
  });

  it("publishes notifications directly to the timeline", () => {
    const publish = vi.fn();
    const host = new DesktopExtensionHost(
      () => undefined,
      () => [],
      publish,
    );
    const ui = host.createContext();

    ui.notify("info");
    ui.notify("warning", "warning");

    expect(publish.mock.calls).toEqual([
      ["info", "info"],
      ["warning", "warning"],
    ]);
    expect(host.requests).toEqual([]);
  });

  it("rejects every unsupported TUI and editor-read surface with a stable error", async () => {
    const host = new DesktopExtensionHost(
      () => undefined,
      () => [],
    );
    const ui = host.createContext();
    const assertions = [
      () => ui.setWorkingMessage("working"),
      () => ui.setWorkingVisible(false),
      () => ui.setHiddenThinkingLabel("hidden"),
      () => ui.getEditorText(),
      () => ui.getToolsExpanded(),
      () => ui.setFooter(undefined),
      () => ui.getAllThemes(),
      () => ui.onTerminalInput(() => undefined),
      () => (ui.setWidget as (key: string, content: unknown) => void)("component", () => undefined),
    ];

    for (const call of assertions) {
      expect(call).toThrow(
        expect.objectContaining({
          name: "DesktopExtensionCompatibilityError",
          code: "DESKTOP_EXTENSION_CAPABILITY_UNAVAILABLE",
        }),
      );
    }
    await expect(ui.custom(() => ({ render: () => [], invalidate: () => undefined }))).rejects.toMatchObject({
      code: "DESKTOP_EXTENSION_CAPABILITY_UNAVAILABLE",
      capability: "ui.tui.custom",
    });
  });

  it("cancels timed-out dialogs and rejects pending work after dispose", async () => {
    vi.useFakeTimers();
    const host = new DesktopExtensionHost(
      () => undefined,
      () => [],
    );
    const ui = host.createContext();
    const timed = ui.input("Name", undefined, { timeout: 10 });
    await vi.advanceTimersByTimeAsync(10);
    await expect(timed).resolves.toBeUndefined();

    const pending = ui.confirm("Confirm", "Continue?");
    host.dispose();
    await expect(pending).rejects.toBeInstanceOf(DesktopExtensionCompatibilityError);
    expect(() => ui.notify("late")).toThrow(expect.objectContaining({ code: "DESKTOP_EXTENSION_HOST_DISPOSED" }));
    vi.useRealTimers();
  });
});
