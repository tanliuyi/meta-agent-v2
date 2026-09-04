import { join } from "node:path";
import { safeStorage } from "electron";
import { DesktopControlledExtensionRegistry } from "../extensions/desktop-extension-registry.ts";
import { DesktopExtensionSettingsService } from "../extensions/desktop-extension-settings-service.ts";
import { DesktopExtensionSourcePolicy } from "../extensions/desktop-extension-source-policy.ts";
import { DEFAULT_PLUGIN_MARKETPLACE } from "../plugins/default-plugin-marketplace.ts";
import { MarketplaceCatalogService } from "../plugins/marketplace-catalog-service.ts";
import { MarketplaceEndpointSettingsService } from "../plugins/marketplace-endpoint-settings-service.ts";
import { resolveMarketplaceExtensionRoot } from "../plugins/marketplace-extension-root.ts";
import { MarketplaceGenerationReferenceTracker } from "../plugins/marketplace-generation-reference-tracker.ts";
import { MarketplacePluginGarbageCollector } from "../plugins/marketplace-plugin-garbage-collector.ts";
import { handleMarketplacePluginIconRequests } from "../plugins/marketplace-plugin-icon-protocol.ts";
import { MarketplacePluginInstaller } from "../plugins/marketplace-plugin-installer.ts";
import { MarketplacePluginReconciler } from "../plugins/marketplace-plugin-reconciler.ts";
import { MarketplacePluginRegistry } from "../plugins/marketplace-plugin-registry.ts";
import { PluginConfigurationService } from "../plugins/plugin-configuration-service.ts";
import type { DesktopRuntimeContext } from "./runtime-context.ts";

/** 扩展配置、marketplace 和插件解析服务集合。 */
export interface PluginServices {
  readonly builtinExtensions: ReturnType<typeof DesktopControlledExtensionRegistry.getBuiltinDefinitions>;
  readonly curatedExtensions: ReturnType<typeof DesktopControlledExtensionRegistry.getCuratedDefinitions>;
  readonly extensionSettings: DesktopExtensionSettingsService;
  readonly pluginConfigurations: PluginConfigurationService;
  readonly extensionSourcePolicy: DesktopExtensionSourcePolicy;
  readonly marketplaceEndpoints: MarketplaceEndpointSettingsService;
  readonly marketplaceRegistry: MarketplacePluginRegistry;
  readonly marketplaceCatalog: MarketplaceCatalogService;
  readonly marketplaceInstaller: MarketplacePluginInstaller;
  readonly marketplaceGarbageCollector: MarketplacePluginGarbageCollector;
  readonly generationReferences: MarketplaceGenerationReferenceTracker;
}

/** 插件服务构造所需的桌面版本信息。 */
export interface PluginServicesOptions {
  readonly desktopVersion: string;
}

/** 构造并完成 marketplace reconcile，返回可供 session worker 使用的插件服务图。 */
/** 完成 marketplace reconcile 后返回可供 worker 使用的插件服务图。 */
export async function createPluginServices(
  context: DesktopRuntimeContext,
  options: PluginServicesOptions,
): Promise<PluginServices> {
  const builtinExtensions = DesktopControlledExtensionRegistry.getBuiltinDefinitions();
  const curatedExtensions = DesktopControlledExtensionRegistry.getCuratedDefinitions();
  const extensionSettings = new DesktopExtensionSettingsService(context.userDataDir, {
    builtinDefinitions: builtinExtensions,
    curatedDefinitions: curatedExtensions,
  });
  const marketplaceEndpoints = new MarketplaceEndpointSettingsService(context.userDataDir, {
    defaultEndpoint: DEFAULT_PLUGIN_MARKETPLACE,
  });
  const marketplaceRegistry = new MarketplacePluginRegistry(context.userDataDir);
  const marketplaceRoot = resolveMarketplaceExtensionRoot(context.userDataDir);
  const marketplaceLockDirectory = join(context.userDataDir, "plugins", "locks");
  const pluginConfigurations = new PluginConfigurationService(context.userDataDir, marketplaceRegistry, {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (value) => safeStorage.encryptString(value).toString("base64"),
    decrypt: (value) => safeStorage.decryptString(Buffer.from(value, "base64")),
  });
  const generationReferences = new MarketplaceGenerationReferenceTracker();
  const marketplaceReconciler = new MarketplacePluginReconciler(
    marketplaceRegistry,
    marketplaceRoot,
    context.userDataDir,
    {
      legacyRoot: join(context.agentDir, "extensions"),
      log: (text) => context.sidecarLog.write("marketplace", text),
    },
  );
  const marketplaceGarbageCollector = new MarketplacePluginGarbageCollector(
    marketplaceRegistry,
    generationReferences,
    marketplaceRoot,
    marketplaceLockDirectory,
  );
  await marketplaceReconciler.reconcile();
  handleMarketplacePluginIconRequests(marketplaceRegistry);

  const extensionSourcePolicy = new DesktopExtensionSourcePolicy({
    settings: extensionSettings,
    getBuiltinDefinitions: () => builtinExtensions,
    getCuratedDefinitions: () => curatedExtensions,
    getMarketplaceExtensions: () => marketplaceRegistry.getInternalSnapshot(),
    pluginConfigurations,
    marketplaceRoot,
    curatedRoot: context.isPackaged ? join(context.resourcesPath, "extensions") : join(context.appDir, "../extensions"),
  });
  const marketplaceCatalog = new MarketplaceCatalogService(marketplaceEndpoints, {
    desktopVersion: options.desktopVersion,
    runtimeCompatibility: context.manifest.compatibility,
  });
  const marketplaceInstaller = new MarketplacePluginInstaller(
    marketplaceEndpoints,
    marketplaceRegistry,
    marketplaceLockDirectory,
    marketplaceRoot,
    options.desktopVersion,
    context.manifest.compatibility,
    {
      reservedExtensionIds: new Set([
        ...builtinExtensions.map((extension) => extension.id),
        ...curatedExtensions.map((extension) => extension.id),
      ]),
    },
  );

  return {
    builtinExtensions,
    curatedExtensions,
    extensionSettings,
    pluginConfigurations,
    extensionSourcePolicy,
    marketplaceEndpoints,
    marketplaceRegistry,
    marketplaceCatalog,
    marketplaceInstaller,
    marketplaceGarbageCollector,
    generationReferences,
  };
}
