import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withRuntimeLock } from "../src/main/sidecar/runtime-lock.ts";
import { findConfiguredShellRuntime, parseRuntimeSetupSelection } from "../src/main/sidecar/runtime-setup.ts";
import { ShellRuntimeInstaller } from "../src/main/sidecar/shell-runtime-installer.ts";

describe("Desktop runtime setup", () => {
  let userDataDir: string;

  beforeEach(() => {
    userDataDir = mkdtempSync(join(tmpdir(), "desktop-runtime-setup-"));
  });

  afterEach(() => {
    rmSync(userDataDir, { recursive: true, force: true });
  });

  it("parses and de-duplicates shell setup selections", () => {
    expect(parseRuntimeSetupSelection(["Meta Agent.exe", "--runtime-setup=shell,shell"])).toEqual(["shell"]);
    expect(parseRuntimeSetupSelection(["Meta Agent.exe"])).toBeUndefined();
  });

  it("rejects empty or unsupported installer runtime selections", () => {
    expect(() => parseRuntimeSetupSelection(["--runtime-setup="])).toThrow(
      "Runtime setup requires at least one component",
    );
    expect(() => parseRuntimeSetupSelection(["--runtime-setup=node"])).toThrow(
      "Unsupported runtime setup component: node",
    );
    expect(() => parseRuntimeSetupSelection(["--runtime-setup=shell,git"])).toThrow(
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

  it("preserves a configured shell that passes runtime validation", async () => {
    const agentDir = join(userDataDir, "agent");
    const shellPath = join(userDataDir, "custom", "bash.exe");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ shellPath }));
    const validate = vi.fn(async (path: string) => ({ path, version: "5.2.37" }));

    await expect(findConfiguredShellRuntime(userDataDir, agentDir, validate)).resolves.toEqual({
      path: shellPath,
      version: "5.2.37",
    });
    expect(validate).toHaveBeenCalledWith(shellPath);
  });

  it("resolves only a complete installed managed shell without an active-state file", () => {
    const installer = new ShellRuntimeInstaller(userDataDir, () => undefined, { validate: () => true });
    expect(installer.installedBashPath()).toBeUndefined();

    const root = join(userDataDir, "shell-runtime", `portable-git-2.53.0.3-${process.platform}-${process.arch}`);
    mkdirSync(join(root, "bin"), { recursive: true });
    expect(installer.installedBashPath()).toBeUndefined();

    const bashPath = join(root, "bin", "bash.exe");
    writeFileSync(bashPath, "");
    expect(installer.installedBashPath()).toBe(bashPath);
    expect(
      new ShellRuntimeInstaller(userDataDir, () => undefined, { validate: () => false }).installedBashPath(),
    ).toBeUndefined();
  });
});
