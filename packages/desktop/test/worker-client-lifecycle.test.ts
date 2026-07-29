import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { SidecarRuntimeManifest } from "../src/main/sidecar/sidecar-runtime-manifest.ts";
import {
  createSidecarEnvironment,
  resolveSidecarExecutable,
  SidecarWorkerClient,
} from "../src/main/sidecar/worker-client.ts";

describe("SidecarWorkerClient lifecycle", () => {
  it("removes inherited subagent lineage variables from worker environments", () => {
    const environment = createSidecarEnvironment("runtime", "/agent", {
      PATH: process.env.PATH,
      ProgramFiles: "C:\\Program Files",
      "ProgramFiles(x86)": "C:\\Program Files (x86)",
      PI_SUBAGENT_DEPTH: "4",
      pi_subagent_max_depth: "7",
      ELECTRON_RUN_AS_NODE: "hostile",
      PI_DESKTOP_STALE_RUNTIME: "discarded",
      PI_CUSTOM_PROVIDER_SETTING: "kept",
      ANTHROPIC_API_KEY: "secret",
    });

    expect(environment.ProgramFiles).toBe("C:\\Program Files");
    expect(environment["ProgramFiles(x86)"]).toBe("C:\\Program Files (x86)");
    expect(environment.PI_SUBAGENT_DEPTH).toBeUndefined();
    expect(environment.pi_subagent_max_depth).toBeUndefined();
    expect(environment.PI_CUSTOM_PROVIDER_SETTING).toBe("kept");
    expect(environment.ANTHROPIC_API_KEY).toBe("secret");
    expect(environment.PI_DESKTOP_RUNTIME_COMPATIBILITY_ID).toBe("runtime");
    expect(environment.PI_DESKTOP_STALE_RUNTIME).toBeUndefined();
    expect(environment.ELECTRON_RUN_AS_NODE).toBe("1");
  });

  it("uses the macOS Electron Helper executable for sidecars", () => {
    const executable = "/Applications/Meta Agent.app/Contents/MacOS/Meta Agent";
    const helper =
      "/Applications/Meta Agent.app/Contents/Frameworks/Meta Agent Helper.app/Contents/MacOS/Meta Agent Helper";

    expect(resolveSidecarExecutable(executable, "darwin", (path) => path === helper)).toBe(helper);
    expect(resolveSidecarExecutable(executable, "darwin", () => false)).toBe(executable);
    expect(resolveSidecarExecutable(executable, "linux", () => true)).toBe(executable);
  });

  it("passes Electron Node mode through an inherited nested fork", async () => {
    const client = new SidecarWorkerClient({
      manifest: manifest(resolve(import.meta.dirname, "fixtures/nested-fork-sidecar.mjs")),
      binding: { role: "metadata", value: { agentDir: "/tmp", userDataDir: "/tmp" } },
    });
    try {
      await expect(client.ready()).resolves.toMatchObject({
        result: {
          execPath: process.execPath,
          electronRunAsNode: "1",
          nested: { execPath: process.execPath, electronRunAsNode: "1" },
        },
      });
    } finally {
      await client.shutdown();
    }
  });

  it("consumes a late host-call completion after the IPC channel closes", async () => {
    let resolveHost!: () => void;
    const hostResult = new Promise<void>((resolveHostResult) => {
      resolveHost = resolveHostResult;
    });
    let hostStarted!: () => void;
    const started = new Promise<void>((resolveStarted) => {
      hostStarted = resolveStarted;
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    const client = new SidecarWorkerClient({
      manifest: manifest(resolve(import.meta.dirname, "fixtures/host-call-sidecar.mjs")),
      binding: { role: "metadata", value: { agentDir: "/tmp", userDataDir: "/tmp" } },
      onHostRequest: async () => {
        hostStarted();
        await hostResult;
        return null;
      },
    });
    try {
      await client.ready();
      await started;
      await client.shutdown();
      resolveHost();
      await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      await client.shutdown().catch(() => undefined);
    }
  });

  it("escalates an unresponsive worker from graceful shutdown through SIGKILL", async () => {
    const stderr: string[] = [];
    const client = new SidecarWorkerClient({
      manifest: manifest(),
      binding: { role: "metadata", value: { agentDir: "/tmp", userDataDir: "/tmp" } },
      onStderr: (text) => stderr.push(text),
    });
    await client.ready();
    expect(stderr.join("")).toContain("fixture sidecar stderr");
    const pid = client.pid;
    if (!pid) throw new Error("Stubborn sidecar PID is missing");

    const pendingMutation = client.request({ type: "rename", title: "draft" }, 10_000);
    await client.shutdown(25);
    await expect(pendingMutation).rejects.not.toMatchObject({ code: "SIDECAR_MUTATION_UNKNOWN_OUTCOME" });

    expect(() => process.kill(pid, 0)).toThrow();
  }, 5_000);
});

function manifest(
  metadataEntry = resolve(import.meta.dirname, "fixtures/stubborn-sidecar.mjs"),
): SidecarRuntimeManifest {
  return {
    entries: {
      thread: "",
      metadata: metadataEntry,
      subagent: "",
    },
    compatibility: {
      nodeVersion: process.version,
      modulesAbi: process.versions.modules,
      napi: process.versions.napi ?? "unknown",
      platform: process.platform,
      arch: process.arch,
      osRelease: "test",
      libc: "test",
      toolchain: "test",
      piVersion: "test",
      runtimeCompatibilityId: "test",
    },
    integrity: {
      entries: { thread: "", metadata: "", subagent: "" },
      files: {},
    },
  };
}
