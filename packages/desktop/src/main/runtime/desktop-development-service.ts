import { isAbsolute } from "node:path";
import { BrowserWindow, dialog } from "electron";
import type { BrowserSessionIdentity } from "../../shared/browser-contracts.ts";
import { type DesktopReloadStatus, mainAgentConfigurationSchema } from "../../shared/desktop-development-contracts.ts";
import type { MainAgentMutationInput, MainAgentProfile } from "../../shared/main-agent-contracts.ts";
import type { PluginConfigurationValue } from "../../shared/plugin-configuration-contracts.ts";
import type { DesktopExtensionSettingsService } from "../extensions/desktop-extension-settings-service.ts";
import type { DesktopExtensionSourcePolicy } from "../extensions/desktop-extension-source-policy.ts";
import type { PluginConfigurationService } from "../plugins/plugin-configuration-service.ts";
import type { MainAgentConfigService } from "../settings/main-agent-config-service.ts";

export interface DesktopDevelopmentRuntimePort {
  getExtensionState(projectId: string, threadId: string): Promise<unknown>;
  getPluginRuntime(projectId: string, threadId: string, pluginId?: string): Promise<unknown>;
  schedulePluginReload(
    projectId: string,
    threadId: string,
    requestId: string,
    continuation?: string,
  ): DesktopReloadStatus;
  getPluginReloadStatus(projectId: string, threadId: string, requestId: string): DesktopReloadStatus;
  extensionSettingsChanged(): Promise<void>;
}

export interface DesktopDevelopmentPluginPort {
  extensionSettings: Pick<
    DesktopExtensionSettingsService,
    "getConfig" | "saveConfig" | "approveDevelopmentEntry" | "getDevelopmentConfigurationSchema"
  >;
  pluginConfigurations: Pick<
    PluginConfigurationService,
    "getDevelopmentConfig" | "getConfig" | "saveDevelopmentConfig" | "saveConfig"
  >;
  extensionSourcePolicy: Pick<DesktopExtensionSourcePolicy, "invalidate">;
}

export class DesktopDevelopmentService {
  private readonly mainAgents: MainAgentConfigService;
  private readonly plugins: DesktopDevelopmentPluginPort;
  private readonly workers: DesktopDevelopmentRuntimePort;
  constructor(
    mainAgents: MainAgentConfigService,
    plugins: DesktopDevelopmentPluginPort,
    workers: DesktopDevelopmentRuntimePort,
  ) {
    this.mainAgents = mainAgents;
    this.plugins = plugins;
    this.workers = workers;
  }
  async call(
    method: string,
    params: Record<string, unknown>,
    identity: BrowserSessionIdentity,
    signal: AbortSignal,
  ): Promise<unknown> {
    signal.throwIfAborted();
    switch (method) {
      case "main_agents": {
        const snapshot = await this.mainAgents.getSnapshot();
        const offset = (params.offset as number | undefined) ?? 0;
        const limit = (params.limit as number | undefined) ?? 20;
        const profiles = [];
        let nextOffset = offset;
        let bytes = 0;
        for (const profile of snapshot.profiles.slice(offset, offset + limit)) {
          const summary = {
            id: profile.id,
            revision: profile.revision,
            builtin: profile.builtin,
            name: profile.name,
            description: profile.description,
          };
          const size = Buffer.byteLength(JSON.stringify(summary));
          if (bytes + size > 32 * 1024) break;
          profiles.push(summary);
          bytes += size;
          nextOffset++;
        }
        return {
          snapshot: { revision: snapshot.revision, defaultAgentId: snapshot.defaultAgentId, profiles },
          total: snapshot.profiles.length,
          nextOffset: nextOffset < snapshot.profiles.length ? nextOffset : null,
          catalog: this.mainAgents.getCatalog(),
          configurationSchema: mainAgentConfigurationSchema,
          appliesTo: "new-sessions",
        };
      }
      case "get_main_agent": {
        const snapshot = await this.mainAgents.getSnapshot();
        if (params.expectedRevision !== undefined && params.expectedRevision !== snapshot.revision)
          return { status: "conflict", revision: snapshot.revision };
        const profile = snapshot.profiles.find((candidate) => candidate.id === params.id);
        if (!profile) throw new Error("Main agent profile not found");
        const source = JSON.stringify(profile);
        if (params.offset === undefined && Buffer.byteLength(source) <= 32 * 1024)
          return { status: "read", revision: snapshot.revision, profile };
        const offset = (params.offset as number | undefined) ?? 0;
        if (offset > source.length) throw new Error("Profile offset exceeds serialized profile length");
        let length = Math.min(16384, source.length - offset);
        while (Buffer.byteLength(JSON.stringify(source.slice(offset, offset + length))) > 24 * 1024)
          length = Math.floor(length / 2);
        const nextOffset = offset + length;
        return {
          status: "read",
          revision: snapshot.revision,
          profileId: profile.id,
          profileRevision: profile.revision,
          encoding: "json",
          offset,
          chunk: source.slice(offset, nextOffset),
          nextOffset: nextOffset < source.length ? nextOffset : null,
          totalLength: source.length,
        };
      }
      case "validate_main_agent": {
        const profile = this.mainAgents.validateProfile(
          params.profile as Omit<MainAgentProfile, "id" | "revision" | "builtin">,
        );
        return { valid: true, name: profile.name };
      }
      case "save_main_agent": {
        const mutation = params.mutation as MainAgentMutationInput;
        const result = await this.mainAgents.mutate(mutation);
        if (result.status === "conflict") return { status: "conflict", revision: result.current.revision };
        const affected =
          mutation.action === "create"
            ? result.snapshot.profiles.at(-1)
            : mutation.action === "update"
              ? result.snapshot.profiles.find((profile) => profile.id === mutation.profile.id)
              : mutation.action === "set-default"
                ? result.snapshot.profiles.find((profile) => profile.id === mutation.id)
                : undefined;
        return {
          status: "saved",
          revision: result.snapshot.revision,
          profile: affected
            ? { id: affected.id, revision: affected.revision, name: affected.name, builtin: affected.builtin }
            : null,
        };
      }
      case "plugins":
        return {
          persisted: await this.plugins.extensionSettings.getConfig(),
          runtime: await this.workers.getExtensionState(identity.projectId, identity.threadId),
        };
      case "set_developer_mode": {
        const result = await this.plugins.extensionSettings.saveConfig({
          requestId: params.requestId as string,
          expectedRevision: params.expectedRevision as string,
          mutation: { type: "set-developer-mode", enabled: params.enabled as boolean },
        });
        if (result.status === "saved") await this.changed();
        return result;
      }
      case "load_local_plugin": {
        if (!isAbsolute(params.path as string)) throw new Error("Local plugin path must be absolute");
        if (!(await this.plugins.extensionSettings.getConfig()).developerMode)
          throw new Error("Enable Developer Mode before approving a local plugin");
        signal.throwIfAborted();
        const owner = BrowserWindow.getFocusedWindow();
        const options: Electron.OpenDialogOptions = {
          title: "Approve local Desktop plugin (trusted Node.js code)",
          defaultPath: params.path as string,
          properties: ["openFile", "openDirectory"],
          filters: [{ name: "Pi extension", extensions: ["ts", "js", "mjs", "cjs"] }],
        };
        const selected = await (owner ? dialog.showOpenDialog(owner, options) : dialog.showOpenDialog(options));
        signal.throwIfAborted();
        if (owner?.isDestroyed()) throw new Error("Approval window was destroyed");
        const result = await this.plugins.extensionSettings.approveDevelopmentEntry(
          { requestId: params.requestId as string, expectedRevision: params.expectedRevision as string },
          selected.canceled ? undefined : selected.filePaths[0],
        );
        if (result.status === "saved") await this.changed();
        return result;
      }
      case "plugin_configuration": {
        const id = params.pluginId as string;
        const schema = await this.plugins.extensionSettings.getDevelopmentConfigurationSchema(id);
        return schema
          ? this.plugins.pluginConfigurations.getDevelopmentConfig(id, schema)
          : this.plugins.pluginConfigurations.getConfig(id);
      }
      case "save_plugin_configuration": {
        const values: unknown = JSON.parse(params.valuesJson as string);
        if (
          !values ||
          typeof values !== "object" ||
          Array.isArray(values) ||
          Object.values(values).some((value) => !["string", "number", "boolean"].includes(typeof value))
        )
          throw new Error("valuesJson must be a scalar configuration object");
        const id = params.pluginId as string;
        const schema = await this.plugins.extensionSettings.getDevelopmentConfigurationSchema(id);
        const secrets: unknown = JSON.parse((params.secretValuesJson as string | undefined) ?? "{}");
        if (
          !secrets ||
          typeof secrets !== "object" ||
          Array.isArray(secrets) ||
          Object.values(secrets).some((value) => typeof value !== "string")
        )
          throw new Error("secretValuesJson must contain string values");
        const input = {
          requestId: params.requestId as string,
          expectedRevision: params.expectedRevision as string,
          pluginId: id,
          values: values as Record<string, PluginConfigurationValue>,
          secretValues: secrets as Record<string, string>,
          ...(params.clearSecrets ? { clearSecrets: params.clearSecrets as string[] } : {}),
        };
        signal.throwIfAborted();
        const result = schema
          ? await this.plugins.pluginConfigurations.saveDevelopmentConfig(input, schema)
          : await this.plugins.pluginConfigurations.saveConfig(input);
        if (result.status === "saved") await this.changed();
        return result;
      }
      case "plugin_runtime":
        return this.workers.getPluginRuntime(
          identity.projectId,
          identity.threadId,
          params.pluginId as string | undefined,
        );
      case "reload_plugins":
        return this.workers.schedulePluginReload(
          identity.projectId,
          identity.threadId,
          params.requestId as string,
          params.continuation as string | undefined,
        );
      case "reload_status":
        return this.workers.getPluginReloadStatus(identity.projectId, identity.threadId, params.requestId as string);
      default:
        throw new Error("Unknown Desktop development method");
    }
  }
  private async changed(): Promise<void> {
    this.plugins.extensionSourcePolicy.invalidate();
    await this.workers.extensionSettingsChanged();
  }
}
