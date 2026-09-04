import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDesktopRuntimeContext,
  resolveDesktopRuntimeDirectories,
} from "../src/main/bootstrap/runtime-context.ts";
import { SidecarLog } from "../src/main/sidecar/sidecar-log.ts";
import { loadSidecarRuntimeManifest } from "../src/main/sidecar/sidecar-runtime-manifest.ts";

const mocks = vi.hoisted(() => ({
  managed: vi.fn(),
  git: vi.fn(),
  installed: vi.fn(),
  write: vi.fn(),
  dispose: vi.fn(),
}));

vi.mock("../src/main/sidecar/managed-shell-locator.ts", () => ({
  locateManagedBash: mocks.managed,
  locateGitForWindowsBash: mocks.git,
}));
vi.mock("../src/main/sidecar/shell-runtime-installer.ts", () => ({
  ShellRuntimeInstaller: vi.fn(function ShellRuntimeInstaller() {
    return { installedBashPath: mocks.installed, onProgress: vi.fn(), install: vi.fn() };
  }),
}));
vi.mock("../src/main/sidecar/sidecar-log.ts", () => ({
  SidecarLog: vi.fn(function SidecarLog() {
    return { path: "C:/data/sidecar.log", write: mocks.write, dispose: mocks.dispose };
  }),
}));
vi.mock("../src/main/sidecar/sidecar-runtime-manifest.ts", () => ({ loadSidecarRuntimeManifest: vi.fn() }));

describe("DesktopRuntimeContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.PI_CODING_AGENT_DIR;
    mocks.managed.mockReturnValue(undefined);
    mocks.installed.mockReturnValue(undefined);
    mocks.git.mockReturnValue(undefined);
    vi.mocked(loadSidecarRuntimeManifest).mockReturnValue({ entries: {}, compatibility: {} } as never);
  });

  it("resolves runtime setup directories without loading the manifest", () => {
    process.env.PI_CODING_AGENT_DIR = "C:/custom-agent";
    const directories = resolveDesktopRuntimeDirectories({ getPath: vi.fn(() => "C:/data") });

    expect(directories).toEqual({ userDataDir: "C:/data", agentDir: "C:/custom-agent" });
    expect(loadSidecarRuntimeManifest).not.toHaveBeenCalled();
  });

  it("constructs a context when the optional shell capability is missing", () => {
    const context = createDesktopRuntimeContext({
      app: { getPath: vi.fn(() => "C:/data"), isPackaged: false },
      appDir: "C:/app/out/main",
      resourcesPath: "C:/resources",
    });

    expect(context.shellPath).toBeUndefined();
    expect(context.sidecarLog).toBeDefined();
    expect(mocks.write).toHaveBeenCalledOnce();
  });

  it("does not create a log when manifest validation fails", () => {
    vi.mocked(loadSidecarRuntimeManifest).mockImplementationOnce(() => {
      throw new Error("invalid manifest");
    });

    expect(() =>
      createDesktopRuntimeContext({
        app: { getPath: vi.fn(() => "C:/data"), isPackaged: true },
        appDir: "C:/app/out/main",
        resourcesPath: "C:/resources",
      }),
    ).toThrow("invalid manifest");

    expect(SidecarLog).not.toHaveBeenCalled();
  });
});
