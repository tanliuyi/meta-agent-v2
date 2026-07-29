import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveElectronSidecarExecutable } from "../../../scripts/desktop-sidecar-executable.mjs";
import {
  createGuiSmokeDesktopState,
  createMinimalGuiEnvironment,
  inspectGuiSidecarReadiness,
  locateDesktopExecutable,
  parseArguments,
} from "../../../scripts/smoke-desktop-gui.mjs";

describe("packaged Desktop GUI smoke contract", () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it("parses an artifact path with spaces and explicit lifecycle mode", () => {
    expect(
      parseArguments([
        "--artifact",
        "/tmp/Meta Agent 安装.app",
        "--mode",
        "normal",
        "--timeout",
        "5000",
        "--keep-temp",
      ]),
    ).toEqual({
      artifact: resolve("/tmp/Meta Agent 安装.app"),
      help: false,
      keepTemp: true,
      mode: "normal",
      timeoutMs: 5000,
    });
  });

  it("rejects invalid mode and readiness timeout values", () => {
    expect(() => parseArguments(["--mode", "resume"])).toThrow("--mode must be one of");
    expect(() => parseArguments(["--timeout", "99"])).toThrow("between 1000 and 300000");
  });

  it("locates a macOS app executable without normalizing Unicode bundle paths", () => {
    const root = mkdtempSync(join(tmpdir(), "desktop-gui-smoke-fixture-"));
    temporaryDirectories.push(root);
    const app = join(root, "安装 路径", "Meta Agent.app");
    const executable = join(app, "Contents", "MacOS", "Meta Agent");
    mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
    writeFileSync(
      join(app, "Contents", "Info.plist"),
      '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>Meta Agent</string></dict></plist>',
    );
    writeFileSync(executable, "placeholder");

    expect(locateDesktopExecutable(app, "darwin")).toBe(executable);
  });

  it("locates the hidden macOS Electron Helper executable for sidecars", () => {
    const executable = "/Applications/Meta Agent.app/Contents/MacOS/Meta Agent";
    const helper =
      "/Applications/Meta Agent.app/Contents/Frameworks/Meta Agent Helper.app/Contents/MacOS/Meta Agent Helper";

    expect(
      resolveElectronSidecarExecutable(executable, {
        platform: "darwin",
        fileExists: (path) => path === helper,
      }),
    ).toBe(helper);
    expect(
      resolveElectronSidecarExecutable(executable, {
        platform: "darwin",
        fileExists: () => false,
      }),
    ).toBe(executable);
    expect(() =>
      resolveElectronSidecarExecutable(executable, {
        platform: "darwin",
        fileExists: () => false,
        requireHelper: true,
      }),
    ).toThrow("sidecar Helper is missing");
  });

  it("builds a minimal GUI environment and strips Electron Node mode", () => {
    const environment = createMinimalGuiEnvironment(
      {
        ELECTRON_RUN_AS_NODE: "1",
        HOME: "/tmp/home",
        OPENAI_API_KEY: "must-not-leak",
        PATH: "/untrusted/user/path",
      },
      "/opt/Meta Agent/Meta Agent",
      { agentDir: "/tmp/agent", cwd: "/tmp/cwd", root: "/tmp", userDataDir: "/tmp/user-data" },
    );

    expect(environment).toMatchObject({ HOME: "/tmp/home", PI_CODING_AGENT_DIR: "/tmp/agent" });
    expect(environment.PATH.startsWith("/opt/Meta Agent")).toBe(true);
    expect(environment.PATH).not.toContain("/untrusted/user/path");
    expect(environment.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(environment.OPENAI_API_KEY).toBeUndefined();
  });

  it("seeds an active project so renderer startup triggers the metadata sidecar", () => {
    expect(createGuiSmokeDesktopState("/tmp/working directory", 123)).toEqual({
      version: 1,
      activeProjectId: "desktop-gui-smoke-project",
      projects: [
        {
          id: "desktop-gui-smoke-project",
          name: "Desktop GUI smoke project",
          cwd: "/tmp/working directory",
          lastOpenedAt: 123,
        },
      ],
      archivedThreads: {},
      workbenches: {},
    });
  });

  it("keeps polling after renderer readiness until the metadata sidecar appears", () => {
    const version = { Browser: "Chrome/1" };
    const targets = [{ type: "page", url: "file:///Applications/Meta Agent.app/renderer/index.html" }];
    expect(
      inspectGuiSidecarReadiness(version, targets, [], "/Applications/Meta Agent.app/Contents/MacOS/Meta Agent"),
    ).toEqual({
      status: "pending",
      reason: "GUI became reachable but no Electron metadata sidecar was observed",
    });

    const executable =
      "/Applications/Meta Agent.app/Contents/Frameworks/Meta Agent Helper.app/Contents/MacOS/Meta Agent Helper";
    const processes = [
      {
        pid: 42,
        ppid: 41,
        command: `${executable} /Applications/Meta Agent.app/Contents/Resources/app.asar.unpacked/out/sidecar/metadata-worker-main.js`,
      },
    ];
    expect(inspectGuiSidecarReadiness(version, targets, processes, executable)).toEqual({
      status: "ready",
      result: {
        processes,
        sidecarCommand: processes[0]?.command,
        targetUrl: targets[0]?.url,
      },
    });
  });

  it("rejects metadata workers launched through external Node", () => {
    const version = { Browser: "Chrome/1" };
    const targets = [{ type: "page", url: "file:///Applications/Meta Agent.app/renderer/index.html" }];
    const processes = [
      {
        pid: 42,
        ppid: 41,
        command:
          "/usr/local/bin/node /Applications/Meta Agent.app/Contents/Resources/app.asar.unpacked/out/sidecar/metadata-worker-main.js",
      },
    ];

    expect(() =>
      inspectGuiSidecarReadiness(version, targets, processes, "/Applications/Meta Agent.app/Contents/MacOS/Meta Agent"),
    ).toThrow("external Node runtime");
  });

  it("locates a Linux AppImage artifact", () => {
    const root = mkdtempSync(join(tmpdir(), "desktop-gui-smoke-fixture-"));
    temporaryDirectories.push(root);
    const executable = join(root, "Meta Agent.AppImage");
    writeFileSync(executable, "placeholder");

    expect(locateDesktopExecutable(executable, "linux")).toBe(executable);
  });
});
