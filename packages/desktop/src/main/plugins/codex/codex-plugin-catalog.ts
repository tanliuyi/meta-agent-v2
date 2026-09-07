import type {
  CodexPluginMutationResult,
  CodexPluginSummary,
  CodexPluginsSnapshot,
  SetCodexPluginEnabledResult,
} from "../../../shared/codex-plugin-contracts.ts";
import type { CodexPluginInstaller, CodexPluginMutationInput } from "./codex-plugin-installer.ts";
import { loadCodexPluginManifest } from "./codex-plugin-manifest.ts";
import type { CodexPluginRegistry, CodexPluginRegistrySnapshot } from "./codex-plugin-registry.ts";

export class CodexPluginCatalog {
  private readonly registry: CodexPluginRegistry;
  private readonly installer: CodexPluginInstaller;

  constructor(registry: CodexPluginRegistry, installer: CodexPluginInstaller) {
    this.registry = registry;
    this.installer = installer;
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
    const plugins = await Promise.all(
      snapshot.plugins.map(async (record): Promise<CodexPluginSummary> => {
        const loaded = await loadCodexPluginManifest(record.rootPath);
        const manifest = loaded.manifest;
        if (!manifest) throw new Error(`Codex plugin manifest is unavailable: ${record.id}`);
        return {
          id: record.id,
          displayName: manifest.interface?.displayName ?? record.displayName,
          description:
            manifest.interface?.longDescription ?? manifest.interface?.shortDescription ?? manifest.description,
          developerName: manifest.interface?.developerName ?? manifest.author.name,
          version: record.version,
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
    return { revision: snapshot.revision, plugins };
  }
}
