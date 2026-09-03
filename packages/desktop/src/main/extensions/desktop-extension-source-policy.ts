import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type {
  DesktopExtensionCapability,
  DesktopExtensionDefinition,
  DesktopExtensionDiagnostic,
  ResolvedExtensionEntry,
  ResolvedExtensionSet,
} from "../../shared/desktop-extension-contracts.ts";
import { DESKTOP_EXTENSION_HOST_PROFILE_VERSION } from "../../shared/desktop-extension-contracts.ts";
import { parsePluginApiCatalog } from "../pi/plugin-call/plugin-method-registry.ts";
import { validateInstalledMarketplacePlugin } from "../plugins/marketplace-installed-plugin.ts";
import type { InstalledMarketplacePluginRecord } from "../plugins/marketplace-plugin-registry.ts";
import type { PluginConfigurationService } from "../plugins/plugin-configuration-service.ts";
import type {
  DesktopExtensionSettingsService,
  StoredDevelopmentExtension,
} from "./desktop-extension-settings-service.ts";

interface DesktopExtensionSourcePolicyOptions {
  settings: DesktopExtensionSettingsService;
  getBuiltinDefinitions(): DesktopExtensionDefinition[];
  getCuratedDefinitions(): DesktopExtensionDefinition[];
  getMarketplaceExtensions?(): Promise<{ revision: string; plugins: InstalledMarketplacePluginRecord[] }>;
  pluginConfigurations?: Pick<
    PluginConfigurationService,
    "getRuntimeConfiguration" | "getDevelopmentRuntimeConfiguration"
  >;
  marketplaceRoot?: string;
  curatedRoot?: string;
  createGeneration?(): string;
}

interface CachedSet {
  fingerprint: string;
  set: ResolvedExtensionSet;
  /** 所有构建成功的插件中心条目，供 direct-tool 会话级选择；plugin_call 条目由调用方过滤。 */
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
    if (this.options.getMarketplaceExtensions) {
      const marketplace = await this.options.getMarketplaceExtensions();
      fingerprintParts.push(marketplace.revision);
      const localPluginIds = collectLocalPluginIds(settings.developmentEntries);
      for (const plugin of marketplace.plugins) {
        if (!plugin.enabled || plugin.state !== "installed") continue;
        // 插件中心状态是全局状态；插件不再按项目作用域筛选。
        const inScope = true;
        const localPlugin = localPluginIds.get(plugin.id);
        if (localPlugin) {
          fingerprintParts.push(`${plugin.id}:superseded-by-local`);
          if (inScope) {
            diagnostics.push({
              extensionId: plugin.id,
              source: "marketplace",
              phase: "resolve",
              code: "DESKTOP_EXTENSION_SUPERSEDED_BY_DEVELOPMENT",
              message: `本地插件“${localPlugin}”已覆盖市场插件“${plugin.displayName}”，当前使用本地版本。停用或移除本地插件后，市场版本将自动恢复。`,
            });
          }
          continue;
        }
        try {
          if (!this.options.marketplaceRoot) throw new Error(`Marketplace extension root is unavailable: ${plugin.id}`);
          const entryPath = await validateInstalledMarketplacePlugin(plugin, this.options.marketplaceRoot);
          const configuration =
            plugin.configurationSchema && plugin.capabilities.includes("configuration.read")
              ? await this.options.pluginConfigurations?.getRuntimeConfiguration(plugin.id)
              : undefined;
          fingerprintParts.push(`${plugin.id}:${plugin.artifactHash}:${configuration?.revision ?? "unconfigured"}`);
          const pluginMetadata = await validatePluginMetadata(plugin);
          fingerprintParts.push(await pluginMetadataFingerprint(pluginMetadata));
          const entry: ResolvedExtensionEntry = {
            id: plugin.id,
            displayName: plugin.displayName,
            source: "marketplace",
            entryPath,
            hostProfileVersion: DESKTOP_EXTENSION_HOST_PROFILE_VERSION,
            capabilities: [...plugin.capabilities],
            ...(pluginMetadata.skillPaths ? { skillPaths: pluginMetadata.skillPaths } : {}),
            ...(pluginMetadata.pluginCallSkill ? { pluginCallSkill: pluginMetadata.pluginCallSkill } : {}),
            ...(pluginMetadata.pluginCallCatalogPath
              ? { pluginCallCatalogPath: pluginMetadata.pluginCallCatalogPath }
              : {}),
            ...(pluginMetadata.pluginCallCatalogSha256
              ? { pluginCallCatalogSha256: pluginMetadata.pluginCallCatalogSha256 }
              : {}),
            ...(pluginMetadata.pluginCallCatalog ? { pluginCallCatalog: pluginMetadata.pluginCallCatalog } : {}),
            ...(configuration ? { configuration: { ...configuration.values } } : {}),
          };
          allEntries.push(entry);
          if (inScope) pathEntries.push(entry);
        } catch {
          fingerprintParts.push(`${plugin.id}:broken`);
          if (inScope) {
            diagnostics.push({
              extensionId: plugin.id,
              source: "marketplace",
              phase: "resolve",
              code: "DESKTOP_EXTENSION_ENTRY_UNAVAILABLE",
              message: `市场插件“${plugin.displayName}”暂不可用，本次会话不会加载该插件。`,
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
          const configuration =
            entry.configurationSchema && entry.capabilities.includes("configuration.read")
              ? await this.options.pluginConfigurations?.getDevelopmentRuntimeConfiguration(
                  entry.id,
                  entry.configurationSchema,
                )
              : undefined;
          fingerprintParts.push(
            `${entry.id}:${entry.pluginId ?? ""}:${entryPath}:${configuration?.revision ?? "unconfigured"}`,
          );
          const pluginMetadata = await validatePluginMetadata({ ...entry, source: "development" });
          fingerprintParts.push(await pluginMetadataFingerprint(pluginMetadata));
          const resolved: ResolvedExtensionEntry = {
            id: entry.id,
            displayName: entry.displayName,
            source: "development",
            entryPath,
            hostProfileVersion: DESKTOP_EXTENSION_HOST_PROFILE_VERSION,
            capabilities: [...entry.capabilities],
            ...(entry.pluginId ? { pluginId: entry.pluginId } : {}),
            ...(pluginMetadata.skillPaths ? { skillPaths: pluginMetadata.skillPaths } : {}),
            ...(pluginMetadata.pluginCallSkill ? { pluginCallSkill: pluginMetadata.pluginCallSkill } : {}),
            ...(pluginMetadata.pluginCallCatalogPath
              ? { pluginCallCatalogPath: pluginMetadata.pluginCallCatalogPath }
              : {}),
            ...(pluginMetadata.pluginCallCatalogSha256
              ? { pluginCallCatalogSha256: pluginMetadata.pluginCallCatalogSha256 }
              : {}),
            ...(pluginMetadata.pluginCallCatalog ? { pluginCallCatalog: pluginMetadata.pluginCallCatalog } : {}),
            ...(configuration ? { configuration: { ...configuration.values } } : {}),
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

async function validatePluginMetadata(entry: {
  id: string;
  pluginId?: string;
  source?: string;
  rootPath?: string;
  artifactHash?: string;
  capabilities: DesktopExtensionCapability[];
  skillPaths?: string[];
  pluginCallSkill?: string;
  pluginCallCatalogPath?: string;
  pluginCallCatalogSha256?: string;
}): Promise<
  Pick<
    ResolvedExtensionEntry,
    "skillPaths" | "pluginCallSkill" | "pluginCallCatalogPath" | "pluginCallCatalogSha256" | "pluginCallCatalog"
  >
> {
  const skillPaths = entry.skillPaths ? await Promise.all(entry.skillPaths.map((path) => realpath(path))) : undefined;
  for (const path of skillPaths ?? []) {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Plugin skill is not a regular non-symlink file");
  }
  if (!entry.capabilities.includes("plugin-methods.provide")) return skillPaths ? { skillPaths } : {};
  if (!skillPaths?.length || !entry.pluginCallSkill || !entry.pluginCallCatalogPath || !entry.pluginCallCatalogSha256) {
    throw new Error("Plugin method metadata is incomplete");
  }
  const pluginCallCatalogPath = await realpath(entry.pluginCallCatalogPath);
  const catalogInfo = await lstat(pluginCallCatalogPath);
  if (!catalogInfo.isFile() || catalogInfo.isSymbolicLink()) throw new Error("Plugin catalog is not a regular file");
  if (entry.rootPath && entry.artifactHash) {
    const versionRoot = await realpath(resolve(entry.rootPath, ".versions", entry.artifactHash));
    for (const path of [...skillPaths, pluginCallCatalogPath]) {
      const withinRoot = relative(versionRoot, path);
      if (!withinRoot || withinRoot.startsWith("..") || isAbsolute(withinRoot)) {
        throw new Error("Plugin metadata escapes its immutable version root");
      }
    }
  }
  const bytes = await readFile(pluginCallCatalogPath);
  if (bytes.byteLength > 256 * 1024) throw new Error("Plugin catalog exceeds 256 KiB");
  if (createHash("sha256").update(bytes).digest("hex") !== entry.pluginCallCatalogSha256) {
    throw new Error("Plugin catalog digest mismatch");
  }
  const pluginCallCatalog = parsePluginApiCatalog(
    JSON.parse(bytes.toString("utf8")),
  ) as unknown as ResolvedExtensionEntry["pluginCallCatalog"];
  if (!pluginCallCatalog) throw new Error("Plugin catalog is missing");
  const canonicalPluginId = entry.source === "development" ? entry.pluginId : entry.id;
  if (!canonicalPluginId || pluginCallCatalog.pluginId !== canonicalPluginId) {
    throw new Error("Plugin catalog identity mismatch");
  }
  return {
    skillPaths,
    pluginCallSkill: entry.pluginCallSkill,
    pluginCallCatalogPath,
    pluginCallCatalogSha256: entry.pluginCallCatalogSha256,
    pluginCallCatalog,
  };
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

async function pluginMetadataFingerprint(
  metadata: Pick<ResolvedExtensionEntry, "skillPaths" | "pluginCallCatalogSha256">,
): Promise<string> {
  const skillHashes = await Promise.all(
    (metadata.skillPaths ?? []).map(async (path) =>
      createHash("sha256")
        .update(await readFile(path))
        .digest("hex"),
    ),
  );
  return `plugin-metadata:${metadata.pluginCallCatalogSha256 ?? "none"}:${skillHashes.join(",")}`;
}

function collectLocalPluginIds(developmentEntries: StoredDevelopmentExtension[]): Map<string, string> {
  const pluginIds = new Map<string, string>();
  for (const entry of developmentEntries) {
    if (!entry.pluginId) continue;
    pluginIds.set(entry.pluginId, entry.displayName);
  }
  return pluginIds;
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
    ...(entry.pluginCallCatalog
      ? {
          pluginCallCatalog: JSON.parse(JSON.stringify(entry.pluginCallCatalog)) as NonNullable<
            ResolvedExtensionEntry["pluginCallCatalog"]
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
