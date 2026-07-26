import { isAbsolute, resolve, sep } from "node:path";
import type { ResolvedExtensionSet } from "../../shared/desktop-extension-contracts.ts";

export class MarketplaceGenerationReferenceTracker {
  private readonly owners = new Map<string, { generation: string; versionRoots: Set<string> }>();

  retain(ownerId: string, extensionSet: ResolvedExtensionSet): void {
    if (!ownerId) throw new Error("Marketplace generation reference owner is required");
    this.owners.set(ownerId, {
      generation: extensionSet.generation,
      versionRoots: versionRootsFromSet(extensionSet),
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

function versionRootsFromSet(extensionSet: ResolvedExtensionSet): Set<string> {
  const roots = new Set<string>();
  for (const entry of extensionSet.entries) {
    if (entry.source !== "marketplace" || !entry.entryPath || !isAbsolute(entry.entryPath)) continue;
    const segments = resolve(entry.entryPath).split(sep);
    const marker = segments.lastIndexOf(".versions");
    const artifactHash = segments[marker + 1];
    if (marker < 1 || !artifactHash || !/^[a-f0-9]{64}$/.test(artifactHash)) {
      throw new Error(`Marketplace extension entry has no immutable version root: ${entry.id}`);
    }
    roots.add(resolve(segments.slice(0, marker + 2).join(sep)));
  }
  return roots;
}
