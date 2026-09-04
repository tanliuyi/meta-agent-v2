import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { AuthConfigService } from "../auth/auth-config-service.ts";
import { FileService } from "../files/file-service.ts";
import { FileCredentialStore } from "../models/credential-store.ts";
import { ModelsConfigService } from "../models/models-config-service.ts";
import { DesktopBuiltinProviderRegistry } from "../pi/desktop-builtin-provider.ts";
import { PreferencesConfigService } from "../preferences/preferences-config-service.ts";
import { ProvidersConfigService } from "../providers/providers-config-service.ts";
import { AutoTitleSettingsService } from "../settings/auto-title-settings-service.ts";
import { MemorySettingsService } from "../settings/memory-settings-service.ts";
import { SettingsConfigService } from "../settings/settings-config-service.ts";
import { ProjectStore } from "../store/project-store.ts";
import type { DesktopRuntimeContext } from "./runtime-context.ts";

/** 核心配置、项目和模型运行时服务集合。 */
export interface CoreServices {
  readonly projects: ProjectStore;
  readonly files: FileService;
  readonly models: ModelsConfigService;
  readonly credentials: FileCredentialStore;
  readonly modelRuntime: ModelRuntime;
  readonly auth: AuthConfigService;
  readonly providers: ProvidersConfigService;
  readonly settings: SettingsConfigService;
  readonly preferences: PreferencesConfigService;
  readonly memorySettings: MemorySettingsService;
  readonly autoTitleSettings: AutoTitleSettingsService;
  readonly isDesktopProviderAvailable: (providerId: string) => Promise<boolean>;
}

/** 构造主进程共享的核心服务，并等待项目和模型 runtime 完成初始化。 */
/** 并行完成项目加载和模型 runtime 创建后组装核心服务。 */
export async function createCoreServices(context: DesktopRuntimeContext): Promise<CoreServices> {
  const models = new ModelsConfigService(context.agentDir, {
    log: (text) => context.sidecarLog.write("models", text),
  });
  const credentials = new FileCredentialStore(join(context.agentDir, "auth.json"));
  const projects = new ProjectStore(
    join(context.userDataDir, "desktop-state.json"),
    join(context.agentDir, "projects.json"),
    join(context.userDataDir, "workspaces", "general"),
  );
  const files = new FileService(projects);
  const settings = new SettingsConfigService(context.userDataDir);
  const preferences = new PreferencesConfigService(context.userDataDir);
  const memorySettings = new MemorySettingsService(context.agentDir, {
    listProjects: () => projects.list(),
    getProjectCwd: (projectId) => projects.getCwd(projectId),
  });

  const [modelRuntime] = await Promise.all([
    ModelRuntime.create({
      credentials,
      modelsPath: join(context.agentDir, "models.json"),
      allowModelNetwork: false,
    }),
    projects.load(),
  ]);
  const auth = new AuthConfigService(context.agentDir, {
    log: (text) => context.sidecarLog.write("auth", text),
    modelRuntime,
  });
  const providers = new ProvidersConfigService(models, auth, modelRuntime);
  const desktopProviderEnvKeys = new Map(
    DesktopBuiltinProviderRegistry.getKnownProviderInfos().map((provider) => [provider.id, provider.envKeys]),
  );
  const isDesktopProviderAvailable = async (providerId: string): Promise<boolean> => {
    const credential = await credentials.read(providerId);
    if (credential?.type === "oauth" || (credential?.type === "api_key" && Boolean(credential.key))) return true;
    return desktopProviderEnvKeys.get(providerId)?.some((envKey) => Boolean(process.env[envKey])) ?? false;
  };
  const autoTitleSettings = new AutoTitleSettingsService(context.agentDir, {
    modelRuntime,
    isDesktopProviderAvailable,
  });

  return {
    projects,
    files,
    models,
    credentials,
    modelRuntime,
    auth,
    providers,
    settings,
    preferences,
    memorySettings,
    autoTitleSettings,
    isDesktopProviderAvailable,
  };
}
