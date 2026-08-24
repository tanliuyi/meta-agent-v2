import { EventEmitter } from "node:events";
import type { BrowserWindow, RenderProcessGoneDetails } from "electron";
import { describe, expect, test, vi } from "vitest";
import { attachRendererCrashRecovery } from "../src/main/renderer-crash-recovery.ts";

class FakeWebContents extends EventEmitter {
  destroyed = false;

  isDestroyed(): boolean {
    return this.destroyed;
  }
}

class FakeWindow {
  private readonly contents = new FakeWebContents();
  destroyed = false;

  get webContents(): FakeWebContents {
    if (this.destroyed) throw new Error("Object has been destroyed");
    return this.contents;
  }

  destroy(): void {
    this.contents.destroyed = true;
    this.destroyed = true;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }
}

function asBrowserWindow(window: FakeWindow): BrowserWindow {
  return window as unknown as BrowserWindow;
}

function emitCrash(window: FakeWindow, details: RenderProcessGoneDetails): void {
  window.webContents.emit("render-process-gone", {}, details);
}

const oomDetails: RenderProcessGoneDetails = { reason: "oom", exitCode: 137 };

describe("attachRendererCrashRecovery", () => {
  test("reports an OOM crash and reloads after confirmation", async () => {
    const window = new FakeWindow();
    const reload = vi.fn();
    const report = vi.fn();
    const prompt = vi.fn(async () => "reload" as const);

    attachRendererCrashRecovery(asBrowserWindow(window), {
      isShuttingDown: () => false,
      reload,
      quit: vi.fn(),
      report,
      prompt,
    });
    emitCrash(window, oomDetails);
    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());

    expect(report).toHaveBeenCalledWith("Renderer process gone: reason=oom, exitCode=137");
    expect(prompt).toHaveBeenCalledWith(asBrowserWindow(window), oomDetails);
  });

  test("quits when requested and ignores duplicate crash events while prompting", async () => {
    const window = new FakeWindow();
    const quit = vi.fn();
    let resolvePrompt: ((action: "quit") => void) | undefined;
    const prompt = vi.fn(
      () =>
        new Promise<"quit">((resolve) => {
          resolvePrompt = resolve;
        }),
    );

    attachRendererCrashRecovery(asBrowserWindow(window), {
      isShuttingDown: () => false,
      reload: vi.fn(),
      quit,
      report: vi.fn(),
      prompt,
    });
    emitCrash(window, oomDetails);
    emitCrash(window, { reason: "crashed", exitCode: 1 });
    expect(prompt).toHaveBeenCalledOnce();

    resolvePrompt?.("quit");
    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce());
  });

  test("does not prompt during application shutdown", () => {
    const window = new FakeWindow();
    const prompt = vi.fn(async () => "reload" as const);

    attachRendererCrashRecovery(asBrowserWindow(window), {
      isShuttingDown: () => true,
      reload: vi.fn(),
      quit: vi.fn(),
      report: vi.fn(),
      prompt,
    });
    emitCrash(window, oomDetails);

    expect(prompt).not.toHaveBeenCalled();
  });

  test("detaches safely after the BrowserWindow has been destroyed", () => {
    const window = new FakeWindow();
    const detach = attachRendererCrashRecovery(asBrowserWindow(window), {
      isShuttingDown: () => true,
      reload: vi.fn(),
      quit: vi.fn(),
      report: vi.fn(),
    });

    window.destroy();

    expect(detach).not.toThrow();
  });

  test("reloads when the native crash dialog fails", async () => {
    const window = new FakeWindow();
    const reload = vi.fn();
    const report = vi.fn();

    attachRendererCrashRecovery(asBrowserWindow(window), {
      isShuttingDown: () => false,
      reload,
      quit: vi.fn(),
      report,
      prompt: async () => {
        throw new Error("dialog unavailable");
      },
    });
    emitCrash(window, oomDetails);
    await vi.waitFor(() => expect(reload).toHaveBeenCalledOnce());

    expect(report).toHaveBeenLastCalledWith(
      "Failed to show renderer crash dialog; reloading the window",
      expect.any(Error),
    );
  });
});
