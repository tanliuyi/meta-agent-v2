import { homedir } from "node:os";
import { join } from "node:path";
import { safeStorage } from "electron";
import { DesktopControlledExtensionRegistry } from "../extensions/desktop-extension-registry.ts";
import { DesktopExtensionSettingsService } from "../extensions/desktop-extension-settings-service.ts";
import { DesktopExtensionSourcePolicy } from "../extensions/desktop-extension-source-policy.ts";
import { resolveCodexExtensionRoot } from "../plugins/codex/codex-extension-root.ts";
import { CodexPluginCatalog } from "../plugins/codex/codex-plugin-catalog.ts";
import { CodexPluginInstaller } from "../plugins/codex/codex-plugin-installer.ts";
import { CodexPluginReconciler } from "../plugins/codex/codex-plugin-reconciler.ts";
import { CodexPluginRegistry } from "../plugins/codex/codex-plugin-registry.ts";
import { discoverCodexPluginSources } from "../plugins/codex/codex-plugin-sources.ts";
import { PluginConfigurationService } from "../plugins/plugin-configuration-service.ts";
import { PluginGenerationReferenceTracker } from "../plugins/plugin-generation-reference-tracker.ts";
import type { DesktopRuntimeContext } from "./runtime-context.ts";

/** 扩展配置、marketplace 和插件解析服务集合。 */
export interface PluginServices {
  readonly builtinExtensions: ReturnType<typeof DesktopControlledExtensionRegistry.getBuiltinDefinitions>;
  readonly curatedExtensions: ReturnType<typeof DesktopControlledExtensionRegistry.getCuratedDefinitions>;
  readonly extensionSettings: DesktopExtensionSettingsService;
  readonly pluginConfigurations: PluginConfigurationService;
  readonly extensionSourcePolicy: DesktopExtensionSourcePolicy;
  readonly codexRegistry: CodexPluginRegistry;
  readonly codexInstaller: CodexPluginInstaller;
  readonly codexCatalog: CodexPluginCatalog;
  readonly generationReferences: PluginGenerationReferenceTracker;
}

/** 插件服务构造所需的桌面版本信息。 */
export interface PluginServicesOptions {
  /** Codex home directory containing `.agents/plugins/marketplace.json`; defaults to the OS home. */
  readonly codexHomeDir?: string;
}

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
  const codexRegistry = new CodexPluginRegistry(context.userDataDir);
  const marketplaceLockDirectory = join(context.userDataDir, "plugins", "locks");
  const pluginConfigurations = new PluginConfigurationService(context.userDataDir, {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (value) => safeStorage.encryptString(value).toString("base64"),
    decrypt: (value) => safeStorage.decryptString(Buffer.from(value, "base64")),
  });
  const generationReferences = new PluginGenerationReferenceTracker();
  const codexDiscovery = await discoverCodexPluginSources(options.codexHomeDir ?? homedir());
  await codexRegistry.reconcile(codexDiscovery.plugins);
  const codexRoot = resolveCodexExtensionRoot(context.userDataDir);
  const codexReconciler = new CodexPluginReconciler(codexRegistry, codexRoot, marketplaceLockDirectory, {
    log: (text) => context.sidecarLog.write("codex", text),
  });
  const codexInstaller = new CodexPluginInstaller(codexRegistry, marketplaceLockDirectory, codexRoot);
  const codexCatalog = new CodexPluginCatalog(codexRegistry, codexInstaller, codexDiscovery.issues);
  await codexReconciler.reconcile();

  const extensionSourcePolicy = new DesktopExtensionSourcePolicy({
    settings: extensionSettings,
    getBuiltinDefinitions: () => builtinExtensions,
    getCuratedDefinitions: () => curatedExtensions,
    getCodexExtensions: () => codexRegistry.getSnapshot(),
    curatedRoot: context.isPackaged ? join(context.resourcesPath, "extensions") : join(context.appDir, "../extensions"),
  });
  return {
    builtinExtensions,
    curatedExtensions,
    extensionSettings,
    pluginConfigurations,
    extensionSourcePolicy,
    codexRegistry,
    codexInstaller,
    codexCatalog,
    generationReferences,
  };
}
