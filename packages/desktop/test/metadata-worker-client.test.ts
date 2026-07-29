import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MetadataWorkerClient } from "../src/main/sidecar/metadata-worker-client.ts";
import type { SidecarRuntimeManifest } from "../src/main/sidecar/sidecar-runtime-manifest.ts";
import { currentRuntimeCompatibility } from "../src/shared/sidecar-wire.ts";

describe("MetadataWorkerClient", () => {
  let tempDir: string;
  let agentDir: string;
  let cwd: string;
  let userDataDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "metadata-worker-client-"));
    agentDir = join(tempDir, "agent");
    cwd = join(tempDir, "project");
    userDataDir = join(tempDir, "desktop-user-data");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(cwd, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("starts a new generation after the metadata worker crashes", async () => {
    const client = new MetadataWorkerClient(loadManifest(), agentDir, userDataDir);
    try {
      await expect(client.list("project", cwd)).resolves.toEqual([]);
      const firstPid = client.pid;
      const firstGeneration = client.workerInstanceId;
      if (!firstPid || !firstGeneration) throw new Error("Metadata worker identity is missing");
      process.kill(firstPid, "SIGKILL");
      await waitForExit(firstPid);

      await expect(client.list("project", cwd)).resolves.toEqual([]);
      expect(client.pid).not.toBe(firstPid);
      expect(client.workerInstanceId).not.toBe(firstGeneration);
    } finally {
      await client.dispose();
    }
  });

  it("does not restart after disposal", async () => {
    const client = new MetadataWorkerClient(loadManifest(), agentDir, userDataDir);
    await client.dispose();

    await expect(client.list("project", cwd)).rejects.toThrow("Metadata sidecar client is disposed");
    expect(client.pid).toBeUndefined();
  });
});

function loadManifest(): SidecarRuntimeManifest {
  return {
    entries: {
      thread: "",
      metadata: resolve(import.meta.dirname, "../out/sidecar/sidecar/metadata-worker-main.js"),
      subagent: "",
    },
    compatibility: currentRuntimeCompatibility(VERSION, "test"),
    integrity: {
      entries: { thread: "", metadata: "", subagent: "" },
      files: {},
    },
  };
}

async function waitForExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Metadata worker ${pid} did not exit`);
}
