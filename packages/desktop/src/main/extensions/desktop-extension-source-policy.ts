import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type {
  DesktopExtensionDefinition,
  DesktopExtensionDiagnostic,
  ResolvedExtensionEntry,
  ResolvedExtensionSet,
} from "../../shared/desktop-extension-contracts.ts";
import { DESKTOP_EXTENSION_HOST_PROFILE_VERSION } from "../../shared/desktop-extension-contracts.ts";
import { loadCodexPluginCompanions } from "../plugins/codex/codex-plugin-companions.ts";
import { loadCodexPluginManifest } from "../plugins/codex/codex-plugin-manifest.ts";
import type { CodexPluginRegistryRecord } from "../plugins/codex/codex-plugin-registry.ts";
import type {
  DesktopExtensionSettingsService,
  StoredDevelopmentExtension,
} from "./desktop-extension-settings-service.ts";

interface DesktopExtensionSourcePolicyOptions {
  settings: DesktopExtensionSettingsService;
  getBuiltinDefinitions(): DesktopExtensionDefinition[];
  getCuratedDefinitions(): DesktopExtensionDefinition[];
  getCodexExtensions?(): Promise<{ revision: string; plugins: CodexPluginRegistryRecord[] }>;
  curatedRoot?: string;
  createGeneration?(): string;
}

interface CachedSet {
  fingerprint: string;
  set: ResolvedExtensionSet;
  /** 所有构建成功的插件中心条目，供 direct-tool 会话级选择；run_code 条目由调用方过滤。 */
  allEntries: ResolvedExtensionEntry[];
}

interface ResolveResult {
  set: ResolvedExtensionSet;
  allEntries: ResolvedExtensionEntry[];
}

/** Main-owned allowlist resolver for every draft and live worker generation. */
export class DesktopExtensionSourcePolicy {
  private readonly options: DesktopExtensionSourcePolicyOptions;
  private readonly cache = new Map<string, CachedSet>();

  constructor(options: DesktopExtensionSourcePolicyOptions) {
    this.options = options;
  }

  /** 插件中心全局启用状态下的扩展集（会话加载的默认全集）。 */
  async resolve(projectId: string): Promise<ResolvedExtensionSet> {
    return (await this.resolveInternal(projectId)).set;
  }

  /** 全局启用的插件中心扩展集 + 全部可构建条目，供 direct-tool 会话级选择。 */
  async resolveWithAll(projectId: string): Promise<ResolveResult> {
    return this.resolveInternal(projectId);
  }

  private async resolveInternal(projectId: string): Promise<ResolveResult> {
    if (!projectId) throw new Error("Extension source policy requires a project ID");
    const settings = await this.options.settings.getInternalConfig();
    const diagnostics: DesktopExtensionDiagnostic[] = [];
    const pathEntries: ResolvedExtensionEntry[] = [];
    const allEntries: ResolvedExtensionEntry[] = [];
    const fingerprintParts = [extensionSettingsFingerprint(settings)];
    const curatedDefinitions = this.options.getCuratedDefinitions();
    for (const definition of curatedDefinitions) {
      assertDefinition(definition, "curated");
      if (!(settings.curatedEnabled[definition.id] ?? true)) continue;
      if (!definition.entryPath) throw new Error(`Curated extension ${definition.id} has no entry path`);
      const entryPath = await validateCuratedEntry(definition.id, definition.entryPath, this.options.curatedRoot);
      fingerprintParts.push(`${definition.id}:${entryPath}`);
      pathEntries.push({ ...definition, entryPath, capabilities: [...definition.capabilities] });
    }
    if (this.options.getCodexExtensions) {
      const codex = await this.options.getCodexExtensions();
      fingerprintParts.push(codex.revision);
      // Discovery is not installation approval. Only managed installed copies load resources.
      const reservedIds = new Set([
        ...pathEntries.map((entry) => entry.id),
        ...curatedDefinitions.map((definition) => definition.id),
        ...this.options.getBuiltinDefinitions().map((definition) => definition.id),
        ...(settings.developerMode ? settings.developmentEntries.map((entry) => entry.id) : []),
      ]);
      for (const record of codex.plugins) {
        // 插件中心状态是全局状态；Codex 插件同样不按项目作用域筛选。
        const inScope = true;
        if (!record.enabled) {
          fingerprintParts.push(`${record.id}:${record.version}:${record.rootPath}:disabled`);
          continue;
        }
        if (reservedIds.has(record.id)) {
          fingerprintParts.push(`${record.id}:${record.version}:${record.rootPath}:conflict`);
          if (inScope) {
            diagnostics.push({
              extensionId: record.id,
              source: "codex",
              phase: "resolve",
              code: "CODEX_EXTENSION_ID_CONFLICT",
              message: `Codex 插件“${record.displayName}”与现有扩展 ID 冲突，本次会话不会加载该插件。`,
            });
          }
          continue;
        }
        try {
          const manifestRoot =
            record.installedRootPath && record.installedHash
              ? join(record.installedRootPath, ".versions", record.installedHash)
              : record.rootPath;
          const loaded = await loadCodexPluginManifest(manifestRoot);
          if (loaded.manifest === undefined) {
            const detail = loaded.issues[0] ? `: ${loaded.issues[0].path}: ${loaded.issues[0].message}` : "";
            throw new Error(`Codex plugin manifest is invalid${detail}`);
          }
          if (loaded.manifest.name !== record.id) throw new Error("Codex plugin identity mismatch");
          fingerprintParts.push(`${record.id}:${record.version}:${record.rootPath}:enabled`);
          if (!record.installedRootPath || !record.installedHash) continue;
          const companions = await loadCodexPluginCompanions(manifestRoot, loaded.manifest);
          fingerprintParts.push(companions.resources.fingerprint);
          diagnostics.push(
            ...companions.diagnostics.map((diagnostic) => ({
              ...diagnostic,
              extensionId: record.id,
              source: "codex" as const,
              phase: "resolve" as const,
            })),
          );
          const entry: ResolvedExtensionEntry = {
            id: record.id,
            displayName: record.displayName,
            source: "codex",
            hostProfileVersion: DESKTOP_EXTENSION_HOST_PROFILE_VERSION,
            capabilities: [],
            skillPaths: companions.resources.skillPaths,
            codexCompanions: companions.resources,
          };
          pathEntries.push(entry);
          allEntries.push(entry);
          reservedIds.add(record.id);
        } catch {
          fingerprintParts.push(`${record.id}:${record.version}:${record.rootPath}:broken`);
          if (inScope) {
            diagnostics.push({
              extensionId: record.id,
              source: "codex",
              phase: "resolve",
              code: "CODEX_EXTENSION_ENTRY_UNAVAILABLE",
              message: `Codex 插件“${record.displayName}”暂不可用，本次会话不会加载该插件。`,
            });
          }
        }
      }
    }
    if (settings.developerMode) {
      for (const entry of settings.developmentEntries) {
        if (!entry.enabled) continue;
        // 插件中心状态是全局状态；插件不再按项目作用域筛选。
        const inScope = true;
        try {
          const info = await lstat(entry.entryPath);
          if (!info.isFile() || info.isSymbolicLink()) throw new Error("entry is not a regular non-symlink file");
          const entryPath = await realpath(entry.entryPath);
          fingerprintParts.push(`${entry.id}:${entryPath}`);
          const resolved: ResolvedExtensionEntry = {
            id: entry.id,
            displayName: entry.displayName,
            source: "development",
            entryPath,
            hostProfileVersion: DESKTOP_EXTENSION_HOST_PROFILE_VERSION,
            capabilities: [],
          };
          allEntries.push(resolved);
          if (inScope) pathEntries.push(resolved);
        } catch {
          fingerprintParts.push(`${entry.id}:missing`);
          if (inScope) {
            diagnostics.push({
              extensionId: entry.id,
              source: "development",
              phase: "resolve",
              code: "DESKTOP_EXTENSION_ENTRY_UNAVAILABLE",
              message: `本地插件“${entry.displayName}”暂不可用，本次会话不会加载该插件。`,
            });
          }
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
    if (current?.fingerprint === fingerprint) {
      return { set: cloneSet(current.set), allEntries: cloneEntries(current.allEntries) };
    }
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
    this.cache.set(projectId, { fingerprint, set, allEntries });
    return { set: cloneSet(set), allEntries: cloneEntries(allEntries) };
  }

  invalidate(projectId?: string): void {
    if (projectId) this.cache.delete(projectId);
    else this.cache.clear();
  }
}

function extensionSettingsFingerprint(settings: {
  developerMode: boolean;
  curatedEnabled: Record<string, boolean>;
  developmentEntries: StoredDevelopmentExtension[];
}): string {
  const developmentEntries = settings.developmentEntries.map((entry) => {
    const scopeIndependentEntry = { ...entry };
    delete scopeIndependentEntry.scope;
    delete scopeIndependentEntry.projectIds;
    return scopeIndependentEntry;
  });
  return JSON.stringify({
    developerMode: settings.developerMode,
    curatedEnabled: settings.curatedEnabled,
    developmentEntries,
  });
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

function assertUniqueIds(entries: ResolvedExtensionEntry[]): void {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.id)) throw new Error(`Duplicate Desktop extension ID: ${entry.id}`);
    ids.add(entry.id);
  }
}

function cloneEntries(entries: ResolvedExtensionEntry[]): ResolvedExtensionEntry[] {
  return entries.map((entry) => ({
    ...entry,
    capabilities: [...entry.capabilities],
    ...(entry.skillPaths ? { skillPaths: [...entry.skillPaths] } : {}),
    ...(entry.codexCompanions ? { codexCompanions: structuredClone(entry.codexCompanions) } : {}),
    ...(entry.runCodeCatalog
      ? {
          runCodeCatalog: JSON.parse(JSON.stringify(entry.runCodeCatalog)) as NonNullable<
            ResolvedExtensionEntry["runCodeCatalog"]
          >,
        }
      : {}),
    ...(entry.configuration ? { configuration: { ...entry.configuration } } : {}),
  }));
}

function cloneSet(set: ResolvedExtensionSet): ResolvedExtensionSet {
  return {
    ...set,
    entries: cloneEntries(set.entries),
    diagnostics: set.diagnostics.map((diagnostic) => ({ ...diagnostic })),
  };
}
