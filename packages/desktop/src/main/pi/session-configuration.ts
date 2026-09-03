import {
  createAgentSessionServices,
  type ModelRuntime,
  type ResourceLoader,
  type SessionManager,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { DraftSessionConfig, Readiness, SessionCreateInput, ThinkingLevel } from "../../shared/contracts.ts";
import {
  DESKTOP_EXTENSION_HOST_PROFILE_VERSION,
  type ResolvedExtensionEntry,
  type ResolvedExtensionSet,
} from "../../shared/desktop-extension-contracts.ts";
import { DesktopBuiltinProviderRegistry } from "./desktop-builtin-provider.ts";
import {
  controlledResourceLoaderOptions,
  extensionLoadDiagnostics,
  extensionServiceDiagnostics,
} from "./desktop-extension-runtime-policy.ts";
import { resolveThinkingConfiguration, selectInitialModel } from "./model-selection-adapter.ts";
import { DesktopPluginRegistryBuilder } from "./plugin-call/plugin-method-registry.ts";
import { getDraftCommands } from "./session-commands.ts";

export interface SessionConfigurationServices {
  models: ModelRuntime;
  settings: SettingsManager;
  resources?: ResourceLoader;
}

/** 不创建 AgentSession，只解析新会话可选模型和默认 thinking。 */
export async function loadDraftSessionConfig(
  cwd: string,
  services?: SessionConfigurationServices,
  agentDir?: string,
  resolvedExtensionSet?: ResolvedExtensionSet,
  /** 全部可构建的插件中心条目（含项目作用域外），供会话级插件选择；缺省回退到扩展集内条目。 */
  allEntries?: ResolvedExtensionEntry[],
): Promise<DraftSessionConfig> {
  const extensionSet = resolvedExtensionSet ?? fallbackExtensionSet(cwd);
  let models: ModelRuntime;
  let settings: SettingsManager;
  let resources: ResourceLoader | undefined;
  let pluginRegistryBuilder: DesktopPluginRegistryBuilder | undefined;
  let serviceDiagnostics: Array<{ type: string; message: string }> = [];
  if (services) {
    ({ models, settings, resources } = services);
  } else {
    pluginRegistryBuilder = new DesktopPluginRegistryBuilder();
    const runtimeServices = await createAgentSessionServices({
      cwd,
      agentDir,
      resourceLoaderOptions: controlledResourceLoaderOptions(
        extensionSet,
        DesktopBuiltinProviderRegistry.getExtensionFactories(),
        { pluginRegistryBuilder, agentDir },
      ),
    });
    models = runtimeServices.modelRuntime;
    settings = runtimeServices.settingsManager;
    resources = runtimeServices.resourceLoader;
    serviceDiagnostics = runtimeServices.diagnostics;
  }
  const extensionDiagnostics = [
    ...(resources ? extensionLoadDiagnostics(extensionSet, resources.getExtensions()) : extensionSet.diagnostics),
    ...extensionServiceDiagnostics(extensionSet, serviceDiagnostics),
  ];
  if (pluginRegistryBuilder) {
    try {
      pluginRegistryBuilder.finalize();
    } catch (error) {
      pluginRegistryBuilder.discard();
      extensionDiagnostics.push({
        extensionId: "unknown",
        source: "builtin",
        extensionSetGeneration: extensionSet.generation,
        projectId: extensionSet.projectId,
        phase: "register",
        code: "DESKTOP_PLUGIN_ADMISSION_FAILED",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const available = await models.getAvailable();
  const initial = selectInitialModel(models, available, {
    provider: settings.getDefaultProvider(),
    modelId: settings.getDefaultModel(),
    thinkingLevel: settings.getDefaultThinkingLevel(),
  });
  const requestedThinking = settings.getDefaultThinkingLevel() ?? initial.thinkingLevel;
  const thinking = resolveThinkingConfiguration(initial.model, requestedThinking);
  return {
    models: available.map((model) => ({
      provider: model.provider,
      id: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
      thinking: model.reasoning,
      thinkingLevels: resolveThinkingConfiguration(model, requestedThinking).thinkingLevels,
    })),
    commands: resources ? getDraftCommands(resources) : [],
    model: initial.model ? { provider: initial.model.provider, id: initial.model.id, name: initial.model.name } : null,
    thinkingLevel: thinking.thinkingLevel,
    thinkingLevels: thinking.thinkingLevels,
    readiness: sessionReadiness(Boolean(initial.model), available.length, models.getModels().length),
    extensions: {
      extensionSetGeneration: extensionSet.generation,
      diagnostics: extensionDiagnostics,
      plugins: (allEntries ?? extensionSet.entries).flatMap((entry) =>
        entry.source === "marketplace" || entry.source === "development"
          ? entry.capabilities.includes("plugin-methods.provide")
            ? []
            : [
                {
                  id: entry.id,
                  displayName: entry.displayName,
                  source: entry.source,
                  available: extensionSet.entries.some((active) => active.id === entry.id),
                },
              ]
          : [],
      ),
      enabledPluginIds: null,
    },
  };
}

/** 校验 renderer 选择并转换为 createAgentSession 的精确输入。 */
export function resolveSessionCreateSelection(
  input: SessionCreateInput,
  models: ModelRuntime,
): { model: NonNullable<ReturnType<ModelRuntime["getModel"]>>; thinkingLevel: ThinkingLevel } {
  const model = models.getModel(input.model.provider, input.model.id);
  if (!model) throw new Error(`模型不存在: ${input.model.provider}/${input.model.id}`);
  if (!models.hasConfiguredAuth(model.provider))
    throw new Error(`模型凭据不可用: ${input.model.provider}/${input.model.id}`);
  return { model, thinkingLevel: resolveThinkingConfiguration(model, input.thinkingLevel).thinkingLevel };
}

/** 恢复已有会话时显式带上 session 文件记录的 model/thinking，包括尚无消息的空 thread。 */
export function resolveSessionResumeSelection(
  sessionManager: SessionManager,
  models: ModelRuntime,
): { model: NonNullable<ReturnType<ModelRuntime["getModel"]>>; thinkingLevel: ThinkingLevel } | undefined {
  const context = sessionManager.buildSessionContext();
  if (!context.model) return undefined;
  const model = models.getModel(context.model.provider, context.model.modelId);
  if (!model || !models.hasConfiguredAuth(model.provider)) return undefined;
  return {
    model,
    thinkingLevel: resolveThinkingConfiguration(model, context.thinkingLevel as ThinkingLevel).thinkingLevel,
  };
}

function fallbackExtensionSet(projectId: string): ResolvedExtensionSet {
  return {
    generation: "desktop-builtins-only",
    projectId,
    entries: DesktopBuiltinProviderRegistry.getExtensionDefinitions().map((definition) => ({
      ...definition,
      hostProfileVersion: DESKTOP_EXTENSION_HOST_PROFILE_VERSION,
      capabilities: [...definition.capabilities],
    })),
    diagnostics: [],
    resolvedAt: 0,
  };
}

export function sessionReadiness(hasModel: boolean, availableCount: number, allCount: number): Readiness {
  if (hasModel) return { state: "ready" };
  if (allCount === 0) return { state: "missing-model", message: "没有可用模型配置" };
  if (availableCount === 0) return { state: "missing-credentials", message: "请先配置模型凭据" };
  return { state: "unavailable-model", message: "当前会话模型不可用，请选择其他模型" };
}
