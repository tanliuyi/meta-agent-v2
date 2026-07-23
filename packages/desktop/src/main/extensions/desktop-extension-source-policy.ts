import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type {
  DesktopExtensionDefinition,
  DesktopExtensionDiagnostic,
  ResolvedExtensionEntry,
  ResolvedExtensionSet,
} from "../../shared/desktop-extension-contracts.ts";
import { DESKTOP_EXTENSION_HOST_PROFILE_VERSION } from "../../shared/desktop-extension-contracts.ts";
import type { DesktopExtensionSettingsService } from "./desktop-extension-settings-service.ts";

interface DesktopExtensionSourcePolicyOptions {
  settings: DesktopExtensionSettingsService;
  getBuiltinDefinitions(): DesktopExtensionDefinition[];
  getCuratedDefinitions(): DesktopExtensionDefinition[];
  curatedRoot?: string;
  createGeneration?(): string;
}

interface CachedSet {
  fingerprint: string;
  set: ResolvedExtensionSet;
}

/** Main-owned allowlist resolver for every draft and live worker generation. */
export class DesktopExtensionSourcePolicy {
  private readonly options: DesktopExtensionSourcePolicyOptions;
  private readonly cache = new Map<string, CachedSet>();

  constructor(options: DesktopExtensionSourcePolicyOptions) {
    this.options = options;
  }

  async resolve(projectId: string): Promise<ResolvedExtensionSet> {
    if (!projectId) throw new Error("Extension source policy requires a project ID");
    const settings = await this.options.settings.getInternalConfig();
    const diagnostics: DesktopExtensionDiagnostic[] = [];
    const pathEntries: ResolvedExtensionEntry[] = [];
    const fingerprintParts = [settings.revision, projectId];
    const curatedDefinitions = this.options.getCuratedDefinitions();
    for (const definition of curatedDefinitions) {
      assertDefinition(definition, "curated");
      if (!(settings.curatedEnabled[definition.id] ?? true)) continue;
      if (!definition.entryPath) throw new Error(`Curated extension ${definition.id} has no entry path`);
      const entryPath = await validateCuratedEntry(definition.id, definition.entryPath, this.options.curatedRoot);
      const contentHash = await hashFile(entryPath);
      fingerprintParts.push(`${definition.id}:${entryPath}:${contentHash}`);
      pathEntries.push({ ...definition, entryPath, contentHash, capabilities: [...definition.capabilities] });
    }
    if (settings.developerMode) {
      for (const entry of settings.developmentEntries) {
        if (!entry.enabled) continue;
        try {
          const info = await lstat(entry.entryPath);
          if (!info.isFile() || info.isSymbolicLink()) throw new Error("entry is not a regular non-symlink file");
          const entryPath = await realpath(entry.entryPath);
          const contentHash = await hashFile(entryPath);
          fingerprintParts.push(`${entry.id}:${entryPath}:${contentHash}`);
          pathEntries.push({
            id: entry.id,
            displayName: entry.displayName,
            source: "development",
            entryPath,
            contentHash,
            hostProfileVersion: DESKTOP_EXTENSION_HOST_PROFILE_VERSION,
            capabilities: [],
          });
        } catch {
          fingerprintParts.push(`${entry.id}:missing`);
          diagnostics.push({
            extensionId: entry.id,
            source: "development",
            phase: "resolve",
            code: "DESKTOP_EXTENSION_ENTRY_UNAVAILABLE",
            message: `Development extension entry is unavailable: ${entry.displayName}`,
          });
        }
      }
    }
    const builtinEntries = this.options.getBuiltinDefinitions().map((definition) => {
      assertDefinition(definition, "builtin");
      fingerprintParts.push(`${definition.id}:builtin`);
      return { ...definition, capabilities: [...definition.capabilities] };
    });
    const entries = [...pathEntries, ...builtinEntries];
    assertUniqueIds(entries);
    const fingerprint = fingerprintParts.join("\0");
    const current = this.cache.get(projectId);
    if (current?.fingerprint === fingerprint) return cloneSet(current.set);
    const generation = this.options.createGeneration?.() ?? randomUUID();
    const set: ResolvedExtensionSet = {
      generation,
      projectId,
      entries,
      ...(curatedDefinitions.length > 0 && this.options.curatedRoot
        ? { curatedRoot: await realpath(this.options.curatedRoot) }
        : {}),
      diagnostics: diagnostics.map((diagnostic) => ({
        ...diagnostic,
        extensionSetGeneration: generation,
        projectId,
      })),
      resolvedAt: Date.now(),
    };
    this.cache.set(projectId, { fingerprint, set });
    return cloneSet(set);
  }

  invalidate(projectId?: string): void {
    if (projectId) this.cache.delete(projectId);
    else this.cache.clear();
  }
}

function assertDefinition(definition: DesktopExtensionDefinition, expectedSource: "builtin" | "curated"): void {
  if (!definition.id || !definition.displayName || definition.source !== expectedSource) {
    throw new Error(`Invalid ${expectedSource} extension definition`);
  }
  if (definition.hostProfileVersion !== DESKTOP_EXTENSION_HOST_PROFILE_VERSION) {
    throw new Error(`Unsupported host profile for ${definition.id}: ${definition.hostProfileVersion}`);
  }
}

async function validateCuratedEntry(id: string, entryPath: string, curatedRoot: string | undefined): Promise<string> {
  if (!curatedRoot) throw new Error(`Curated extension root is unavailable for ${id}`);
  if (!isAbsolute(entryPath)) throw new Error(`Curated extension entry must be absolute: ${id}`);
  const selectedInfo = await lstat(entryPath);
  if (!selectedInfo.isFile() || selectedInfo.isSymbolicLink()) {
    throw new Error(`Curated extension entry is not a regular non-symlink file: ${id}`);
  }
  const canonicalRoot = await realpath(curatedRoot);
  const canonicalEntry = await realpath(entryPath);
  const withinRoot = relative(canonicalRoot, canonicalEntry);
  if (withinRoot.startsWith("..") || isAbsolute(withinRoot)) {
    throw new Error(`Curated extension escapes bundled root: ${id}`);
  }
  return resolve(canonicalEntry);
}

async function hashFile(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

function assertUniqueIds(entries: ResolvedExtensionEntry[]): void {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.id)) throw new Error(`Duplicate Desktop extension ID: ${entry.id}`);
    ids.add(entry.id);
  }
}

function cloneSet(set: ResolvedExtensionSet): ResolvedExtensionSet {
  return {
    ...set,
    entries: set.entries.map((entry) => ({ ...entry, capabilities: [...entry.capabilities] })),
    diagnostics: set.diagnostics.map((diagnostic) => ({ ...diagnostic })),
  };
}
