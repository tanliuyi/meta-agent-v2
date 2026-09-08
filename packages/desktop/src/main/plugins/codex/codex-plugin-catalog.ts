import { join } from "node:path";
import type {
  CodexPluginMutationResult,
  CodexPluginSummary,
  CodexPluginsSnapshot,
  SetCodexPluginEnabledResult,
} from "../../../shared/codex-plugin-contracts.ts";
import type { CodexPluginInstaller, CodexPluginMutationInput } from "./codex-plugin-installer.ts";
import { loadCodexPluginManifest } from "./codex-plugin-manifest.ts";
import type { CodexPluginRegistry, CodexPluginRegistrySnapshot } from "./codex-plugin-registry.ts";
import type { CodexPluginSourceIssue } from "./codex-plugin-sources.ts";

export class CodexPluginCatalog {
  private readonly registry: CodexPluginRegistry;
  private readonly installer: CodexPluginInstaller;
  private readonly discoveryIssues: CodexPluginSourceIssue[];

  constructor(
    registry: CodexPluginRegistry,
    installer: CodexPluginInstaller,
    discoveryIssues: CodexPluginSourceIssue[] = [],
  ) {
    this.registry = registry;
    this.installer = installer;
    this.discoveryIssues = discoveryIssues.map((issue) => ({ ...issue }));
  }

  async list(): Promise<CodexPluginsSnapshot> {
    return this.toSnapshot(await this.registry.getSnapshot());
  }

  async install(input: CodexPluginMutationInput): Promise<CodexPluginMutationResult> {
    return this.mapMutation(await this.installer.install(input));
  }

  async update(input: CodexPluginMutationInput): Promise<CodexPluginMutationResult> {
    return this.mapMutation(await this.installer.update(input));
  }

  async uninstall(input: CodexPluginMutationInput): Promise<CodexPluginMutationResult> {
    return this.mapMutation(await this.installer.uninstall(input));
  }

  async setEnabled(expectedRevision: string, pluginId: string, enabled: boolean): Promise<SetCodexPluginEnabledResult> {
    const result = await this.registry.commitEnabled(expectedRevision, pluginId, enabled);
    if (result.status === "conflict") return { status: "conflict", current: await this.toSnapshot(result.snapshot) };
    return { status: result.status, snapshot: await this.toSnapshot(result.snapshot) };
  }

  private async mapMutation(
    result:
      | Awaited<ReturnType<CodexPluginInstaller["install"]>>
      | Awaited<ReturnType<CodexPluginInstaller["update"]>>
      | Awaited<ReturnType<CodexPluginInstaller["uninstall"]>>,
  ): Promise<CodexPluginMutationResult> {
    if (result.status === "conflict") return { status: "conflict", current: await this.toSnapshot(result.current) };
    return { status: result.status, snapshot: await this.toSnapshot(result.snapshot) };
  }

  private async toSnapshot(snapshot: CodexPluginRegistrySnapshot): Promise<CodexPluginsSnapshot> {
    const runtimeDiagnostics: CodexPluginsSnapshot["diagnostics"] = [];
    const plugins = await Promise.all(
      snapshot.plugins.map(async (record): Promise<CodexPluginSummary> => {
        const sourceVersion = record.sourceVersion ?? record.version;
        const installedRoot =
          record.installedRootPath && record.installedHash
            ? join(record.installedRootPath, ".versions", record.installedHash)
            : undefined;
        const installed = installedRoot ? await loadCodexPluginManifest(installedRoot) : undefined;
        if (installedRoot && !installed?.manifest) {
          runtimeDiagnostics.push({
            code: "installed-payload.invalid",
            pluginId: record.id,
            message: `插件“${record.displayName}”的已安装副本损坏。`,
          });
        }
        const loaded = installed?.manifest ? installed : await loadCodexPluginManifest(record.rootPath);
        const manifest = loaded.manifest;
        if (!manifest) {
          runtimeDiagnostics.push({
            code: "plugin.metadata-unavailable",
            pluginId: record.id,
            message: `插件“${record.displayName}”的元数据不可用。`,
          });
          return {
            id: record.id,
            displayName: record.displayName,
            description: "插件元数据不可用",
            developerName: "未知开发者",
            version: record.version,
            sourceVersion,
            updateAvailable: hasSourceUpdate(record.installedHash, record.version, sourceVersion),
            capabilities: [],
            keywords: [],
            products: [...(record.products ?? [])],
            marketplace: "custom",
            source: "local",
            installed: Boolean(record.installedHash && record.installedRootPath),
            enabled: record.enabled,
          };
        }
        return {
          id: record.id,
          displayName: manifest.interface?.displayName ?? record.displayName,
          description:
            manifest.interface?.longDescription ?? manifest.interface?.shortDescription ?? manifest.description,
          developerName: manifest.interface?.developerName ?? manifest.author.name,
          version: record.version,
          sourceVersion,
          updateAvailable: hasSourceUpdate(record.installedHash, record.version, sourceVersion),
          ...(manifest.interface?.category ? { category: manifest.interface.category } : {}),
          capabilities: [...(manifest.interface?.capabilities ?? [])],
          keywords: [...(manifest.keywords ?? [])],
          ...((manifest.interface?.websiteURL ?? manifest.homepage)
            ? { websiteUrl: manifest.interface?.websiteURL ?? manifest.homepage }
            : {}),
          ...(manifest.repository ? { repositoryUrl: manifest.repository } : {}),
          ...(manifest.license ? { license: manifest.license } : {}),
          ...(record.marketplaceCategory ? { marketplaceCategory: record.marketplaceCategory } : {}),
          ...(record.installationPolicy ? { installationPolicy: record.installationPolicy } : {}),
          ...(record.authenticationPolicy ? { authenticationPolicy: record.authenticationPolicy } : {}),
          products: [...(record.products ?? [])],
          marketplace: record.marketplacePath.replaceAll("\\", "/").endsWith("/.agents/plugins/marketplace.json")
            ? "personal"
            : "custom",
          source: "local" as const,
          installed: Boolean(record.installedHash && record.installedRootPath),
          enabled: record.enabled,
        };
      }),
    );
    return {
      revision: snapshot.revision,
      plugins,
      diagnostics: [
        ...this.discoveryIssues.map((issue) => ({
          code: issue.code,
          ...(issue.pluginName ? { pluginId: issue.pluginName } : {}),
          message: diagnosticMessage(issue),
        })),
        ...runtimeDiagnostics.sort((left, right) =>
          `${left.pluginId}:${left.code}`.localeCompare(`${right.pluginId}:${right.code}`),
        ),
      ],
    };
  }
}

function hasSourceUpdate(installedHash: string | undefined, installedVersion: string, sourceVersion: string): boolean {
  return Boolean(installedHash && installedVersion.split("+")[0] !== sourceVersion.split("+")[0]);
}

function diagnosticMessage(issue: CodexPluginSourceIssue): string {
  const plugin = issue.pluginName ? `插件“${issue.pluginName}”` : "Codex Marketplace";
  switch (issue.code) {
    case "marketplace.read-failed":
      return `${plugin}无法读取。`;
    case "marketplace.invalid":
      return `${plugin}格式无效。`;
    case "source.unsafe":
      return `${plugin}来源路径不安全。`;
    case "source.missing":
      return `${plugin}来源不存在或不可访问。`;
    case "plugin.legacy-layout":
      return `${plugin}仍使用旧 market-manifest.json 布局，请迁移到 .codex-plugin/plugin.json。`;
    case "plugin.invalid":
      return `${plugin} manifest 无效。`;
  }
}
