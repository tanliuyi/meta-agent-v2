import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerIpc } from "../src/main/ipc.ts";
import { CHANNELS } from "../src/shared/channels.ts";

const electron = vi.hoisted(() => ({
  handles: new Map<string, (...args: unknown[]) => unknown>(),
  listeners: new Map<string, (...args: unknown[]) => unknown>(),
  openPath: vi.fn(),
}));

vi.mock("electron", () => ({
  app: { relaunch: vi.fn(), exit: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn(), getAllWindows: vi.fn(() => []) },
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: {
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => electron.handles.set(channel, listener),
    on: (channel: string, listener: (...args: unknown[]) => unknown) => electron.listeners.set(channel, listener),
  },
  shell: { openExternal: vi.fn(), openPath: electron.openPath },
}));

const roots: string[] = [];

afterEach(async () => {
  electron.handles.clear();
  electron.listeners.clear();
  electron.openPath.mockReset();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("links IPC", () => {
  it("opens source links with line suffixes as the underlying project file", async () => {
    const root = await mkdtemp(join(tmpdir(), "meta-agent-links-"));
    roots.push(root);
    const cwd = join(root, "project");
    const filePath = join(cwd, "src", "app.tsx");
    await mkdir(join(cwd, "src"), { recursive: true });
    await writeFile(filePath, "export {}\n");

    registerIpc(
      { getCwd: () => cwd } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {},
    );
    const handler = electron.handles.get(CHANNELS.linksOpen);
    expect(handler).toBeDefined();

    await expect(handler?.({}, "project", `${filePath}:6`)).resolves.toEqual({
      openInApp: true,
      path: "src/app.tsx",
    });
    await expect(handler?.({}, "project", `${pathToFileURL(filePath).href}:6-10`)).resolves.toEqual({
      openInApp: true,
      path: "src/app.tsx",
    });
  });

  it("preserves a real filename that itself contains a colon and number", async () => {
    const root = await mkdtemp(join(tmpdir(), "meta-agent-links-colon-"));
    roots.push(root);
    const cwd = join(root, "project");
    const filePath = join(cwd, "source:6");
    await mkdir(cwd, { recursive: true });
    await writeFile(filePath, "content\n");

    registerIpc(
      { getCwd: () => cwd } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {},
    );
    const handler = electron.handles.get(CHANNELS.linksOpen);
    expect(handler).toBeDefined();

    await expect(handler?.({}, "project", filePath)).resolves.toEqual({
      openInApp: true,
      path: "source:6",
    });
  });
});
