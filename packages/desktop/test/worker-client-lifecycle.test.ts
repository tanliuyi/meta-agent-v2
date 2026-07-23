import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { NodeRuntimeManifest } from "../src/main/sidecar/node-runtime-locator.ts";
import { SidecarWorkerClient } from "../src/main/sidecar/worker-client.ts";

describe("SidecarWorkerClient lifecycle", () => {
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

function manifest(): NodeRuntimeManifest {
  return {
    nodePath: process.execPath,
    npmCliPath: process.execPath,
    entries: {
      thread: "",
      metadata: resolve(import.meta.dirname, "fixtures/stubborn-sidecar.mjs"),
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
      nodePath: "",
      npmCliPath: "",
      entries: { thread: "", metadata: "" },
      files: {},
    },
  };
}
