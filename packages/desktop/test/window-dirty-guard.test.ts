import { EventEmitter } from "node:events";
import type { BrowserWindow } from "electron";
import { describe, expect, test, vi } from "vitest";
import { WindowDirtyGuard } from "../src/main/window-dirty-guard.ts";

class FakeWebContents extends EventEmitter {
  readonly id: number;
  reload = vi.fn();

  constructor(id: number) {
    super();
    this.id = id;
  }
}

class FakeWindow extends EventEmitter {
  readonly webContents: FakeWebContents;
  private destroyed = false;
  closeCalls = 0;

  constructor(id: number) {
    super();
    this.webContents = new FakeWebContents(id);
  }

  close(): void {
    this.closeCalls += 1;
    const event = { preventDefault: vi.fn() };
    this.emit("close", event);
    if (!event.preventDefault.mock.calls.length) this.destroyed = true;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }
}

function asBrowserWindow(window: FakeWindow): BrowserWindow {
  return window as unknown as BrowserWindow;
}

describe("WindowDirtyGuard", () => {
  test("allows clean close immediately", async () => {
    const confirm = vi.fn(async () => false);
    const guard = new WindowDirtyGuard({ confirm });
    const window = new FakeWindow(1);
    guard.attach(asBrowserWindow(window));
    await guard.requestClose(asBrowserWindow(window));
    expect(window.closeCalls).toBe(1);
    expect(confirm).not.toHaveBeenCalled();
  });

  test("cancels or confirms a dirty native close with one prompt", async () => {
    const answers = [false, true];
    const confirm = vi.fn(async () => answers.shift() ?? false);
    const guard = new WindowDirtyGuard({ confirm });
    const window = new FakeWindow(2);
    guard.attach(asBrowserWindow(window));
    guard.setDirty(2, true);

    await guard.requestClose(asBrowserWindow(window));
    expect(window.closeCalls).toBe(0);
    await guard.requestClose(asBrowserWindow(window));
    expect(window.closeCalls).toBe(1);
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  test("guards reload and deduplicates a pending prompt", async () => {
    let resolveConfirmation: ((confirmed: boolean) => void) | undefined;
    const confirm = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveConfirmation = resolve;
        }),
    );
    const guard = new WindowDirtyGuard({ confirm });
    const window = new FakeWindow(3);
    guard.setDirty(3, true);

    const first = guard.requestReload(asBrowserWindow(window));
    const second = guard.requestReload(asBrowserWindow(window));
    expect(confirm).toHaveBeenCalledTimes(1);
    resolveConfirmation?.(true);
    await Promise.all([first, second]);
    expect(window.webContents.reload).toHaveBeenCalledTimes(1);
  });

  test("tracks dirty state per webContents and clears it on destroy", () => {
    const guard = new WindowDirtyGuard({ confirm: async () => false });
    const first = new FakeWindow(4);
    const second = new FakeWindow(5);
    guard.attach(asBrowserWindow(first));
    guard.attach(asBrowserWindow(second));
    guard.setDirty(4, true);
    expect(guard.hasDirtyWindows([asBrowserWindow(first), asBrowserWindow(second)])).toBe(true);
    first.webContents.emit("destroyed");
    expect(guard.isDirty(4)).toBe(false);
    expect(guard.hasDirtyWindows([asBrowserWindow(second)])).toBe(false);
  });

  test("confirms application quit once across repeated requests", async () => {
    const confirm = vi.fn(async () => true);
    const guard = new WindowDirtyGuard({ confirm });
    const first = new FakeWindow(6);
    const second = new FakeWindow(7);
    guard.setDirty(6, true);
    guard.setDirty(7, true);
    const windows = [asBrowserWindow(first), asBrowserWindow(second)];
    await expect(guard.confirmApplicationQuit(windows)).resolves.toBe(true);
    await expect(guard.confirmApplicationQuit(windows)).resolves.toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(guard.isApplicationQuitConfirmed()).toBe(true);
  });
});
