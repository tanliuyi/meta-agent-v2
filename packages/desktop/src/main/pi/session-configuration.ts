import {
  createAgentSessionServices,
  findInitialModel,
  type ModelRegistry,
  type ResourceLoader,
  resolveThinkingConfiguration,
  type SessionManager,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { DraftSessionConfig, Readiness, SessionCreateInput, ThinkingLevel } from "../../shared/contracts.ts";
import {
  DESKTOP_EXTENSION_HOST_PROFILE_VERSION,
  type ResolvedExtensionSet,
} from "../../shared/desktop-extension-contracts.ts";
import { DesktopBuiltinProviderRegistry } from "./desktop-builtin-provider.ts";
import {
  controlledResourceLoaderOptions,
  extensionLoadDiagnostics,
  extensionServiceDiagnostics,
} from "./desktop-extension-runtime-policy.ts";
import { getDraftCommands } from "./session-commands.ts";

export interface SessionConfigurationServices {
  models: ModelRegistry;
  settings: SettingsManager;
  resources?: ResourceLoader;
}

/** 不创建 AgentSession，只解析新会话可选模型和默认 thinking。 */
export async function loadDraftSessionConfig(
  cwd: string,
  services?: SessionConfigurationServices,
  agentDir?: string,
  resolvedExtensionSet?: ResolvedExtensionSet,
): Promise<DraftSessionConfig> {
  const extensionSet = resolvedExtensionSet ?? fallbackExtensionSet(cwd);
  let models: ModelRegistry;
  let settings: SettingsManager;
  let resources: ResourceLoader | undefined;
  let serviceDiagnostics: Array<{ type: string; message: string }> = [];
  if (services) {
    ({ models, settings, resources } = services);
  } else {
    const runtimeServices = await createAgentSessionServices({
      cwd,
      agentDir,
      resourceLoaderOptions: controlledResourceLoaderOptions(
        extensionSet,
        DesktopBuiltinProviderRegistry.getExtensionFactories(),
      ),
    });
    models = runtimeServices.modelRegistry;
    settings = runtimeServices.settingsManager;
    resources = runtimeServices.resourceLoader;
    serviceDiagnostics = runtimeServices.diagnostics;
  }
  const initial = await findInitialModel({
    scopedModels: [],
    isContinuing: false,
    defaultProvider: settings.getDefaultProvider(),
    defaultModelId: settings.getDefaultModel(),
    defaultThinkingLevel: settings.getDefaultThinkingLevel(),
    modelRegistry: models,
  });
  const requestedThinking = settings.getDefaultThinkingLevel() ?? initial.thinkingLevel;
  const available = models.getAvailable();
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
    readiness: sessionReadiness(Boolean(initial.model), available.length, models.getAll().length),
    extensions: {
      extensionSetGeneration: extensionSet.generation,
      diagnostics: [
        ...(resources ? extensionLoadDiagnostics(extensionSet, resources.getExtensions()) : extensionSet.diagnostics),
        ...extensionServiceDiagnostics(extensionSet, serviceDiagnostics),
      ],
    },
  };
}

/** 校验 renderer 选择并转换为 createAgentSession 的精确输入。 */
export function resolveSessionCreateSelection(
  input: SessionCreateInput,
  models: ModelRegistry,
): { model: NonNullable<ReturnType<ModelRegistry["find"]>>; thinkingLevel: ThinkingLevel } {
  const model = models.find(input.model.provider, input.model.id);
  if (!model) throw new Error(`模型不存在: ${input.model.provider}/${input.model.id}`);
  if (!models.hasConfiguredAuth(model)) throw new Error(`模型凭据不可用: ${input.model.provider}/${input.model.id}`);
  return { model, thinkingLevel: resolveThinkingConfiguration(model, input.thinkingLevel).thinkingLevel };
}

/** 恢复已有会话时显式带上 session 文件记录的 model/thinking，包括尚无消息的空 thread。 */
export function resolveSessionResumeSelection(
  sessionManager: SessionManager,
  models: ModelRegistry,
): { model: NonNullable<ReturnType<ModelRegistry["find"]>>; thinkingLevel: ThinkingLevel } | undefined {
  const context = sessionManager.buildSessionContext();
  if (!context.model) return undefined;
  const model = models.find(context.model.provider, context.model.modelId);
  if (!model || !models.hasConfiguredAuth(model)) return undefined;
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
  if (allCount === 0) return { state: "missing-model", message: "Pi 没有可用模型配置" };
  if (availableCount === 0) return { state: "missing-credentials", message: "请先在 Pi 中配置模型凭据" };
  return { state: "unavailable-model", message: "当前会话模型不可用，请选择其他模型" };
}
