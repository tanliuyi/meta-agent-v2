import { resolve } from "node:path";
import type { ResolvedExtensionSet } from "../../shared/desktop-extension-contracts.ts";

export class PluginGenerationReferenceTracker {
  private readonly owners = new Map<string, { generation: string; versionRoots: Set<string> }>();

  retain(ownerId: string, extensionSet: ResolvedExtensionSet): void {
    if (!ownerId) throw new Error("Plugin generation reference owner is required");
    this.owners.set(ownerId, {
      generation: extensionSet.generation,
      versionRoots: new Set(
        extensionSet.entries
          .filter((entry) => entry.source === "codex" && entry.codexCompanions)
          .map((entry) => resolve(entry.codexCompanions!.rootPath)),
      ),
    });
  }

  release(ownerId: string): void {
    this.owners.delete(ownerId);
  }

  isReferenced(versionRoot: string): boolean {
    const canonical = resolve(versionRoot);
    return [...this.owners.values()].some((owner) => owner.versionRoots.has(canonical));
  }

  snapshot(): Array<{ ownerId: string; generation: string; versionRoots: string[] }> {
    return [...this.owners.entries()].map(([ownerId, owner]) => ({
      ownerId,
      generation: owner.generation,
      versionRoots: [...owner.versionRoots].sort(),
    }));
  }
}
