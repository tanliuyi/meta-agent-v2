import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SidecarRuntimeManifest } from "../src/main/sidecar/sidecar-runtime-manifest.ts";
import type { ResolvedExtensionSet } from "../src/shared/desktop-extension-contracts.ts";
import type { MetadataSidecarCommand } from "../src/shared/sidecar-contracts.ts";

const mocks = vi.hoisted(() => ({
  clients: [] as Array<{ shutdownCount: number }>,
  commands: [] as MetadataSidecarCommand[],
}));

vi.mock("../src/main/sidecar/worker-client.ts", () => ({
  SidecarWorkerClient: class {
    readonly instanceId: string;
    readonly pid: number;
    available = true;
    shutdownCount = 0;

    constructor() {
      this.instanceId = `metadata-${mocks.clients.length + 1}`;
      this.pid = mocks.clients.length + 1;
      mocks.clients.push(this);
    }

    async request<T>(command: MetadataSidecarCommand): Promise<T> {
      mocks.commands.push(command);
      return {
        models: [],
        commands: [],
        model: null,
        thinkingLevel: "off",
        thinkingLevels: ["off"],
        readiness: { state: "missing-model" },
        extensions: { extensionSetGeneration: "test", diagnostics: [] },
      } as T;
    }

    async shutdown(): Promise<void> {
      this.available = false;
      this.shutdownCount += 1;
    }
  },
}));

import { MetadataWorkerClient } from "../src/main/sidecar/metadata-worker-client.ts";

describe("MetadataWorkerClient extension generation", () => {
  beforeEach(() => {
    mocks.clients.length = 0;
    mocks.commands.length = 0;
  });

  it("tracks the metadata draft generation until disposal", async () => {
    const retain = vi.fn();
    const release = vi.fn();
    const client = new MetadataWorkerClient(manifest(), "/agent", "/user-data", undefined, { retain, release });
    const first = extensionSet("one");
    const second = extensionSet("two");

    await client.getDraftConfig("project", "/workspace", first);
    await client.getDraftConfig("project", "/workspace", second);

    expect(retain).toHaveBeenLastCalledWith("metadata:draft", second);
    await client.dispose();
    expect(release).toHaveBeenCalledWith("metadata:draft");
  });

  it("reuses one process for an unchanged set and restarts before loading a changed set", async () => {
    const client = new MetadataWorkerClient(manifest(), "/agent", "/user-data");

    await client.getDraftConfig("project", "/workspace", extensionSet("one"));
    await client.getDraftConfig("project", "/workspace", extensionSet("one"));
    expect(mocks.clients).toHaveLength(1);

    await client.getDraftConfig("project", "/workspace", extensionSet("two"));

    expect(mocks.clients).toHaveLength(2);
    expect(mocks.clients[0]?.shutdownCount).toBe(1);
    await client.dispose();
  });

  it("captures nested Codex resources before a draft request enters the queue", async () => {
    const client = new MetadataWorkerClient(manifest(), "/agent", "/user-data");
    const set = extensionSet("codex");
    set.entries.push({
      id: "plugin",
      displayName: "Plugin",
      source: "codex",
      hostProfileVersion: 1,
      capabilities: [],
      skillPaths: ["/plugin/skills"],
      codexCompanions: {
        rootPath: "/plugin",
        fingerprint: "original",
        skillPaths: ["/plugin/skills"],
        scripts: ["scripts/original.mjs"],
        mcpServers: {},
      },
    });
    const pending = client.getDraftConfig("project", "/workspace", set);
    set.entries[0]!.codexCompanions!.scripts.push("scripts/unapproved.mjs");
    set.entries[0]!.skillPaths!.push("/unapproved");
    await pending;
    const command = mocks.commands[0];
    if (command?.type !== "getDraftConfig") throw new Error("Expected draft request");
    expect(command.extensionSet.entries[0]?.codexCompanions?.scripts).toEqual(["scripts/original.mjs"]);
    expect(command.allEntries[0]?.skillPaths).toEqual(["/plugin/skills"]);
    await client.dispose();
  });
});

function extensionSet(generation: string): ResolvedExtensionSet {
  return { generation, projectId: "project", entries: [], diagnostics: [], resolvedAt: 0 };
}

function manifest(): SidecarRuntimeManifest {
  return {
    entries: { thread: "", metadata: "", subagent: "" },
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
