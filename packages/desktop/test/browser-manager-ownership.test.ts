import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserManager } from "../src/main/browser/browser-manager.ts";
import type { BrowserSessionIdentity } from "../src/shared/browser-contracts.ts";

vi.mock("electron", () => ({
  BrowserWindow: class {},
  clipboard: {},
  webContents: { fromId: () => null },
  Menu: {},
  nativeImage: {},
  shell: {},
  session: {
    fromPartition: () => ({
      setPermissionCheckHandler: () => undefined,
      setPermissionRequestHandler: () => undefined,
      on: () => undefined,
      off: () => undefined,
    }),
  },
}));

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const identity: BrowserSessionIdentity = { projectId: "project-1", threadId: "thread-1" };

async function createBrowserManager() {
  const userDataDir = await mkdtemp(join(tmpdir(), "browser-ownership-"));
  roots.push(userDataDir);
  return new BrowserManager(userDataDir, { onStateChanged: vi.fn() });
}

describe("BrowserManager renderer session ownership", () => {
  it("keeps the session until every renderer owner and the worker capability are released", async () => {
    const browser = await createBrowserManager();
    const capability = browser.registerSession(identity);
    browser.acquireSession(identity, 100);
    browser.acquireSession(identity, 200);

    browser.retireSession(identity, 100);
    expect(browser.isKnownSession(identity)).toBe(true);

    browser.retireSession(identity, 200);
    expect(browser.isKnownSession(identity)).toBe(true);

    browser.revokeSessionCapability(capability);
    expect(browser.isKnownSession(identity)).toBe(false);
    browser.dispose();
  });

  it("ignores retire from an owner that never acquired the session", async () => {
    const browser = await createBrowserManager();
    const capability = browser.registerSession(identity);
    browser.acquireSession(identity, 100);

    browser.retireSession(identity, 999);
    expect(browser.isKnownSession(identity)).toBe(true);

    browser.retireSession(identity, 100);
    browser.revokeSessionCapability(capability);
    expect(browser.isKnownSession(identity)).toBe(false);
    browser.dispose();
  });

  it("keeps a worker-only session live until its capability is revoked", async () => {
    const browser = await createBrowserManager();
    const capability = browser.registerSession(identity);

    browser.retireSession(identity, 100);
    expect(browser.isKnownSession(identity)).toBe(true);

    browser.revokeSessionCapability(capability);
    expect(browser.isKnownSession(identity)).toBe(false);
    browser.dispose();
  });

  it("re-acquiring after full retirement recreates the session state", async () => {
    const browser = await createBrowserManager();
    const capability = browser.registerSession(identity);
    browser.acquireSession(identity, 100);
    browser.retireSession(identity, 100);
    browser.revokeSessionCapability(capability);
    expect(browser.isKnownSession(identity)).toBe(false);

    browser.acquireSession(identity, 200);
    expect(browser.isKnownSession(identity)).toBe(true);
    browser.retireSession(identity, 200);
    expect(browser.isKnownSession(identity)).toBe(false);
    browser.dispose();
  });

  it("releases every session held by a renderer when that renderer exits", async () => {
    const browser = await createBrowserManager();
    const secondIdentity: BrowserSessionIdentity = { projectId: "project-1", threadId: "thread-2" };
    const firstCapability = browser.registerSession(identity);
    const secondCapability = browser.registerSession(secondIdentity);
    browser.acquireSession(identity, 100);
    browser.acquireSession(secondIdentity, 100);
    browser.acquireSession(identity, 200);

    browser.releaseOwner(100);
    browser.revokeSessionCapability(secondCapability);

    expect(browser.isKnownSession(identity)).toBe(true);
    expect(browser.isKnownSession(secondIdentity)).toBe(false);

    browser.releaseOwner(200);
    expect(browser.isKnownSession(identity)).toBe(true);
    browser.revokeSessionCapability(firstCapability);
    expect(browser.isKnownSession(identity)).toBe(false);
    browser.dispose();
  });

  it("acquire is idempotent for the same renderer", async () => {
    const browser = await createBrowserManager();
    const capability = browser.registerSession(identity);
    browser.acquireSession(identity, 100);
    browser.acquireSession(identity, 100);

    browser.retireSession(identity, 100);
    expect(browser.isKnownSession(identity)).toBe(true);
    browser.revokeSessionCapability(capability);
    expect(browser.isKnownSession(identity)).toBe(false);
    browser.dispose();
  });
});
