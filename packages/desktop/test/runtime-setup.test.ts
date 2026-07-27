import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withRuntimeLock } from "../src/main/sidecar/runtime-lock.ts";
import { parseRuntimeSetupSelection } from "../src/main/sidecar/runtime-setup.ts";
import { ShellRuntimeInstaller } from "../src/main/sidecar/shell-runtime-installer.ts";

describe("Desktop runtime setup", () => {
  let userDataDir: string;

  beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), "desktop-runtime-setup-"));
  });

  afterEach(() => {
    rmSync(userDataDir, { recursive: true, force: true });
  });

  it("parses and de-duplicates installer runtime selections", () => {
    expect(parseRuntimeSetupSelection(["Meta Agent.exe", "--runtime-setup=node,shell,node"])).toEqual([
      "node",
      "shell",
    ]);
    expect(parseRuntimeSetupSelection(["Meta Agent.exe"])).toBeUndefined();
  });

  it("rejects empty or unsupported installer runtime selections", () => {
    expect(() => parseRuntimeSetupSelection(["--runtime-setup="])).toThrow(
      "Runtime setup requires at least one component",
    );
    expect(() => parseRuntimeSetupSelection(["--runtime-setup=node,git"])).toThrow(
      "Unsupported runtime setup component: git",
    );
  });

  it("serializes concurrent runtime mutations", async () => {
    const runtimeRoot = join(userDataDir, "locked-runtime");
    const order: string[] = [];
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolveStarted) => {
      markFirstStarted = resolveStarted;
    });
    let releaseFirst!: () => void;
    const firstMayFinish = new Promise<void>((resolveFinish) => {
      releaseFirst = resolveFinish;
    });
    const first = withRuntimeLock(runtimeRoot, async () => {
      order.push("first-start");
      markFirstStarted();
      await firstMayFinish;
      order.push("first-end");
    });
    await firstStarted;
    const second = withRuntimeLock(runtimeRoot, async () => {
      order.push("second");
    });
    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
    expect(order).toEqual(["first-start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-start", "first-end", "second"]);
  });

  it("resolves only a complete active managed shell", () => {
    const installer = new ShellRuntimeInstaller(userDataDir, () => undefined, { validate: () => true });
    expect(installer.activeBashPath()).toBeUndefined();

    const root = join(userDataDir, "shell-runtime", "portable-git-test");
    mkdirSync(join(root, "bin"), { recursive: true });
    writeFileSync(join(userDataDir, "shell-runtime", "active.json"), `${JSON.stringify({ root })}\n`);
    expect(installer.activeBashPath()).toBeUndefined();

    const bashPath = join(root, "bin", "bash.exe");
    writeFileSync(bashPath, "");
    expect(installer.activeBashPath()).toBe(bashPath);
    expect(
      new ShellRuntimeInstaller(userDataDir, () => undefined, { validate: () => false }).activeBashPath(),
    ).toBeUndefined();
  });
});
