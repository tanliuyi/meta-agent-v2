import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PluginGenerationReferenceTracker } from "../src/main/plugins/plugin-generation-reference-tracker.ts";
import type { ResolvedExtensionSet } from "../src/shared/desktop-extension-contracts.ts";

const versionRoot = resolve("/tmp/codex/sample/.versions/abc");

describe("PluginGenerationReferenceTracker", () => {
  it("retains Codex payload roots per worker owner until release", () => {
    const tracker = new PluginGenerationReferenceTracker();
    tracker.retain("thread:one", extensionSet("generation-one"));
    tracker.retain("thread:two", extensionSet("generation-one"));
    expect(tracker.isReferenced(versionRoot)).toBe(true);
    tracker.release("thread:one");
    expect(tracker.isReferenced(versionRoot)).toBe(true);
    tracker.release("thread:two");
    expect(tracker.isReferenced(versionRoot)).toBe(false);
  });

  it("replaces an owner's generation atomically", () => {
    const tracker = new PluginGenerationReferenceTracker();
    tracker.retain("metadata:draft", extensionSet("generation-one"));
    tracker.retain("metadata:draft", { ...extensionSet("generation-two"), entries: [] });
    expect(tracker.snapshot()).toEqual([{ ownerId: "metadata:draft", generation: "generation-two", versionRoots: [] }]);
  });
});

function extensionSet(generation: string): ResolvedExtensionSet {
  return {
    generation,
    projectId: "project",
    entries: [
      {
        id: "sample",
        displayName: "Sample",
        source: "codex",
        hostProfileVersion: 1,
        capabilities: [],
        codexCompanions: {
          rootPath: versionRoot,
          fingerprint: "fingerprint",
          skillPaths: [],
          scripts: [],
          mcpServers: {},
        },
      },
    ],
    diagnostics: [],
    resolvedAt: 1,
  };
}
