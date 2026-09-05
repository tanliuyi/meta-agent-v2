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

  it("validates questionnaire responses and supports empty multi-select answers", async () => {
    const host = new DesktopExtensionHost(
      () => undefined,
      () => ["tool-1"],
    );
    const pending = host.createContext().questionnaire({
      questions: [
        {
          question: "Select any",
          header: "Options",
          multiSelect: true,
          options: [
            { label: "A", description: "First" },
            { label: "B", description: "Second" },
          ],
        },
      ],
    });
    const request = host.requests[0];

    expect(request).toMatchObject({ type: "questionnaire", toolCallId: "tool-1" });
    host.respond({
      requestId: request?.id ?? "",
      questionnaire: {
        cancelled: false,
        answers: [{ questionIndex: 0, question: "ignored", kind: "multi", answer: null, selected: [] }],
      },
    });

    await expect(pending).resolves.toEqual({
      cancelled: false,
      answers: [{ questionIndex: 0, question: "Select any", kind: "multi", answer: null, selected: [] }],
    });
  });

  it("rejects invalid questionnaire responses without consuming the pending request", async () => {
    const host = new DesktopExtensionHost(
      () => undefined,
      () => [],
    );
    const pending = host.createContext().questionnaire({
      questions: [
        {
          question: "Choose",
          header: "Choice",
          options: [
            { label: "A", description: "First" },
            { label: "B", description: "Second" },
          ],
        },
      ],
    });
    const requestId = host.requests[0]?.id ?? "";

    expect(() =>
      host.respond({
        requestId,
        questionnaire: {
          cancelled: false,
          answers: [{ questionIndex: 0, question: "Choose", kind: "option", answer: "C" }],
        },
      }),
    ).toThrow("Questionnaire answer does not match offered options");
    expect(host.requests).toHaveLength(1);
    host.respond({ requestId, dismissed: true });
    await expect(pending).resolves.toEqual({ answers: [], cancelled: true });
  });

  it("cancels questionnaire requests on abort", async () => {
    const host = new DesktopExtensionHost(
      () => undefined,
      () => [],
    );
    const controller = new AbortController();
    const pending = host.createContext().questionnaire(
      {
        questions: [
          {
            question: "Choose",
            header: "Choice",
            options: [
              { label: "A", description: "First" },
              { label: "B", description: "Second" },
            ],
          },
        ],
      },
      { signal: controller.signal },
    );

    controller.abort();

    await expect(pending).resolves.toEqual({ answers: [], cancelled: true });
    expect(host.requests).toEqual([]);
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
    ui.notify("structured", "info", {
      customType: "hermes-memory.markdown-sync",
      details: { phase: "complete", imported: 3 },
    });

    expect(publish.mock.calls).toEqual([
      ["info", "info"],
      ["warning", "warning"],
      [
        "structured",
        "info",
        { customType: "hermes-memory.markdown-sync", details: { phase: "complete", imported: 3 } },
      ],
    ]);
    expect(host.requests).toEqual([]);
  });

  it("supports the working message and visibility state", () => {
    const host = new DesktopExtensionHost(
      () => undefined,
      () => [],
    );
    const ui = host.createContext();

    ui.setWorkingMessage("analyzing workspace");
    expect(host.hostState.working).toEqual({ message: "analyzing workspace", visible: true });
    ui.setWorkingVisible(false);
    expect(host.hostState.working).toEqual({ message: "analyzing workspace", visible: false });
    ui.setWorkingMessage(undefined);
    expect(host.hostState.working).toMatchObject({ message: undefined, visible: false });
  });

  it("degrades unsupported TUI and editor-read surfaces with a warning instead of throwing", async () => {
    const warnings: string[] = [];
    const host = new DesktopExtensionHost(
      () => undefined,
      () => [],
      () => undefined,
      (message) => warnings.push(message),
    );
    const ui = host.createContext();

    ui.setWorkingIndicator({ frames: ["*"] });
    ui.setHiddenThinkingLabel("hidden");
    ui.getToolsExpanded();
    ui.setFooter(undefined);
    ui.setHeader(undefined);
    ui.getAllThemes();
    ui.getTheme();
    ui.onTerminalInput(() => undefined);
    (ui.setWidget as (key: string, content: unknown) => void)("component", () => undefined);
    ui.getEditorText();
    await expect(ui.custom(() => ({ render: () => [], invalidate: () => undefined }))).resolves.toBeUndefined();

    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.every((message) => message.includes("unsupported"))).toBe(true);
    expect(host.hostState.widgets).toEqual([]);
  });

  it("rejects pending host requests and clears state on reset", async () => {
    const host = new DesktopExtensionHost(
      () => undefined,
      () => [],
    );
    const ui = host.createContext();
    ui.setStatus("reload", "pending");
    const pending = ui.confirm("Confirm", "Continue?");

    host.reset();

    await expect(pending).rejects.toThrow("became stale after reload");
    expect(host.requests).toEqual([]);
    expect(host.hostState).toEqual({ statuses: {}, widgets: [] });
    expect(() => ui.notify("current runtime remains usable")).not.toThrow();
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
