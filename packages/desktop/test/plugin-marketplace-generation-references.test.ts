import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MarketplaceGenerationReferenceTracker } from "../src/main/plugins/marketplace-generation-reference-tracker.ts";
import type { ResolvedExtensionSet } from "../src/shared/desktop-extension-contracts.ts";

const artifactHash = "a".repeat(64);
const versionRoot = resolve(join("/tmp", "agent", "extensions", "plugin.one", ".versions", artifactHash));

describe("MarketplaceGenerationReferenceTracker", () => {
  it("retains immutable version roots per worker owner until release", () => {
    const tracker = new MarketplaceGenerationReferenceTracker();
    tracker.retain("thread:one", extensionSet("generation-one"));
    tracker.retain("thread:two", extensionSet("generation-one"));

    expect(tracker.isReferenced(versionRoot)).toBe(true);
    expect(tracker.snapshot()).toEqual([
      { ownerId: "thread:one", generation: "generation-one", versionRoots: [versionRoot] },
      { ownerId: "thread:two", generation: "generation-one", versionRoots: [versionRoot] },
    ]);

    tracker.release("thread:one");
    expect(tracker.isReferenced(versionRoot)).toBe(true);
    tracker.release("thread:two");
    expect(tracker.isReferenced(versionRoot)).toBe(false);
  });

  it("replaces an owner's generation atomically", () => {
    const tracker = new MarketplaceGenerationReferenceTracker();
    tracker.retain("metadata:draft", extensionSet("generation-one"));
    tracker.retain("metadata:draft", { ...extensionSet("generation-two"), entries: [] });

    expect(tracker.isReferenced(versionRoot)).toBe(false);
    expect(tracker.snapshot()).toEqual([{ ownerId: "metadata:draft", generation: "generation-two", versionRoots: [] }]);
  });

  it("rejects marketplace entries without an immutable artifact hash directory", () => {
    const tracker = new MarketplaceGenerationReferenceTracker();
    const set = extensionSet("invalid");
    set.entries[0] = { ...set.entries[0]!, entryPath: "/tmp/agent/extensions/plugin.one/index.ts" };

    expect(() => tracker.retain("thread:invalid", set)).toThrow("no immutable version root");
  });
});

function extensionSet(generation: string): ResolvedExtensionSet {
  return {
    generation,
    projectId: "project",
    entries: [
      {
        id: "plugin.one",
        displayName: "Plugin One",
        source: "marketplace",
        entryPath: join(versionRoot, "payload", "index.ts"),
        hostProfileVersion: 1,
        capabilities: [],
      },
    ],
    diagnostics: [],
    resolvedAt: 1,
  };
}
