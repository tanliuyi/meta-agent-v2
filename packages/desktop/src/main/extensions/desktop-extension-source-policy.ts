import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type {
  DesktopExtensionDefinition,
  DesktopExtensionDiagnostic,
  ResolvedExtensionEntry,
  ResolvedExtensionSet,
} from "../../shared/desktop-extension-contracts.ts";
import { DESKTOP_EXTENSION_HOST_PROFILE_VERSION } from "../../shared/desktop-extension-contracts.ts";
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
  /** 所有构建成功的插件中心条目（marketplace/development，含项目作用域外），供会话级选择。 */
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

  /** 项目作用域过滤后的扩展集（会话加载的默认全集）。 */
  async resolve(projectId: string): Promise<ResolvedExtensionSet> {
    return (await this.resolveInternal(projectId)).set;
  }

  /** 项目作用域过滤后的扩展集 + 全部可构建的插件中心条目（含作用域外），供会话级选择。 */
  async resolveWithAll(projectId: string): Promise<ResolveResult> {
    return this.resolveInternal(projectId);
  }

  private async resolveInternal(projectId: string): Promise<ResolveResult> {
    if (!projectId) throw new Error("Extension source policy requires a project ID");
    const settings = await this.options.settings.getInternalConfig();
    const diagnostics: DesktopExtensionDiagnostic[] = [];
    const pathEntries: ResolvedExtensionEntry[] = [];
    const allEntries: ResolvedExtensionEntry[] = [];
    const fingerprintParts = [settings.revision, projectId];
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
      const localPluginIds = collectLocalPluginIds(settings.developmentEntries, projectId);
      for (const plugin of marketplace.plugins) {
        if (!plugin.enabled || plugin.state !== "installed") continue;
        const inScope = !(plugin.scope === "project" && !(plugin.projectIds ?? []).includes(projectId));
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
          fingerprintParts.push(
            `${plugin.id}:${plugin.scope}:${(plugin.projectIds ?? []).join(",")}:${plugin.artifactHash}:${configuration?.revision ?? "unconfigured"}`,
          );
          const entry: ResolvedExtensionEntry = {
            id: plugin.id,
            displayName: plugin.displayName,
            source: "marketplace",
            entryPath,
            hostProfileVersion: DESKTOP_EXTENSION_HOST_PROFILE_VERSION,
            capabilities: [...plugin.capabilities],
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
        const inScope = !(entry.scope === "project" && !(entry.projectIds ?? []).includes(projectId));
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
            `${entry.id}:${entry.scope ?? "global"}:${(entry.projectIds ?? []).join(",")}:${entry.pluginId ?? ""}:${entryPath}:${configuration?.revision ?? "unconfigured"}`,
          );
          const resolved: ResolvedExtensionEntry = {
            id: entry.id,
            displayName: entry.displayName,
            source: "development",
            entryPath,
            hostProfileVersion: DESKTOP_EXTENSION_HOST_PROFILE_VERSION,
            capabilities: [...entry.capabilities],
            ...(entry.pluginId ? { pluginId: entry.pluginId } : {}),
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

function collectLocalPluginIds(
  developmentEntries: StoredDevelopmentExtension[],
  projectId: string,
): Map<string, string> {
  const pluginIds = new Map<string, string>();
  for (const entry of developmentEntries) {
    if (!entry.pluginId) continue;
    if (entry.scope === "project" && !(entry.projectIds ?? []).includes(projectId)) continue;
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
