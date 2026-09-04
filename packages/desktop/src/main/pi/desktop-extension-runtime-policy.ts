import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as bundledPiAgentCore from "@earendil-works/pi-agent-core";
import * as bundledPiAi from "@earendil-works/pi-ai";
import * as bundledPiAiCompat from "@earendil-works/pi-ai/compat";
import * as bundledPiAiOauth from "@earendil-works/pi-ai/oauth";
import * as bundledPiAiProviders from "@earendil-works/pi-ai/providers/all";
import * as bundledPiCodingAgent from "@earendil-works/pi-coding-agent";
import {
  type ExtensionAPI,
  type ExtensionFactory,
  type InlineExtension,
  type LoadExtensionsResult,
  loadSkills,
  type ResourceDiagnostic,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import * as bundledPiTui from "@earendil-works/pi-tui";
import { createJiti } from "jiti/static";
import * as bundledTypebox from "typebox";
import * as bundledTypeboxCompile from "typebox/compile";
import * as bundledTypeboxValue from "typebox/value";
import {
  DESKTOP_EXTENSION_HOST_PROFILE_VERSION,
  type DesktopExtensionDiagnostic,
  type ResolvedExtensionSet,
} from "../../shared/desktop-extension-contracts.ts";
import type { DesktopPluginRegistryBuilder } from "./run-code/plugin-method-registry.ts";
import { createRunCodeExtension, type RunCodeRegistryHolder } from "./run-code/run-code-tool.ts";

const NON_BLOCKING_EXTENSION_DIAGNOSTIC_CODES = new Set(["DESKTOP_EXTENSION_SUPERSEDED_BY_DEVELOPMENT"]);

type DesktopExtensionConfiguration = Readonly<Record<string, string | number | boolean>>;
type DesktopInlineExtension = {
  name: string;
  factory: ExtensionFactory;
};
type DesktopExtensionAPI = ExtensionAPI & {
  getConfig<T = DesktopExtensionConfiguration>(): Readonly<T>;
};

function providesPluginTools(entry: ResolvedExtensionSet["entries"][number]): boolean {
  return entry.capabilities.includes("plugin-methods.provide");
}

const DESKTOP_EXTENSION_VIRTUAL_MODULES: Record<string, unknown> = {
  "@earendil-works/pi-agent-core": bundledPiAgentCore,
  "@earendil-works/pi-ai": bundledPiAi,
  "@earendil-works/pi-ai/compat": bundledPiAiCompat,
  "@earendil-works/pi-ai/oauth": bundledPiAiOauth,
  "@earendil-works/pi-ai/providers/all": bundledPiAiProviders,
  "@earendil-works/pi-coding-agent": bundledPiCodingAgent,
  "@earendil-works/pi-tui": bundledPiTui,
  "@mariozechner/pi-agent-core": bundledPiAgentCore,
  "@mariozechner/pi-ai": bundledPiAi,
  "@mariozechner/pi-ai/compat": bundledPiAiCompat,
  "@mariozechner/pi-ai/oauth": bundledPiAiOauth,
  "@mariozechner/pi-ai/providers/all": bundledPiAiProviders,
  "@mariozechner/pi-coding-agent": bundledPiCodingAgent,
  "@mariozechner/pi-tui": bundledPiTui,
  "@sinclair/typebox": bundledTypebox,
  "@sinclair/typebox/compile": bundledTypeboxCompile,
  "@sinclair/typebox/value": bundledTypeboxValue,
  typebox: bundledTypebox,
  "typebox/compile": bundledTypeboxCompile,
  "typebox/value": bundledTypeboxValue,
};

const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  tsconfigPaths: true,
  virtualModules: DESKTOP_EXTENSION_VIRTUAL_MODULES,
});

export function isBlockingExtensionDiagnostic(diagnostic: Pick<DesktopExtensionDiagnostic, "code">): boolean {
  return !NON_BLOCKING_EXTENSION_DIAGNOSTIC_CODES.has(diagnostic.code);
}

export async function validateResolvedExtensionSet(
  projectId: string,
  set: ResolvedExtensionSet,
): Promise<ResolvedExtensionSet> {
  if (!set || set.projectId !== projectId || !set.generation) {
    throw new Error(`Resolved extension set does not match project ${projectId}`);
  }
  const ids = new Set<string>();
  for (const entry of set.entries) {
    if (!entry.id || ids.has(entry.id)) throw new Error(`Duplicate or empty Desktop extension ID: ${entry.id}`);
    ids.add(entry.id);
    if (entry.hostProfileVersion !== DESKTOP_EXTENSION_HOST_PROFILE_VERSION) {
      throw new Error(`Unsupported Desktop extension host profile for ${entry.id}`);
    }
    if (
      entry.configuration &&
      Object.values(entry.configuration).some(
        (value) => typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean",
      )
    ) {
      throw new Error(`Extension ${entry.id} configuration is invalid`);
    }
    if (entry.source === "builtin") {
      if (entry.entryPath) throw new Error(`Built-in extension ${entry.id} must use an inline factory`);
      continue;
    }
    if (!entry.entryPath || !isAbsolute(entry.entryPath)) {
      throw new Error(`Extension ${entry.id} requires an absolute approved entry path`);
    }
    const info = await lstat(entry.entryPath);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`Extension ${entry.id} entry is not a regular non-symlink file`);
    }
    if (entry.source === "curated") {
      if (!set.curatedRoot) throw new Error(`Curated extension root is unavailable for ${entry.id}`);
      const canonicalRoot = await realpath(set.curatedRoot);
      const canonicalEntry = await realpath(entry.entryPath);
      const withinRoot = relative(canonicalRoot, canonicalEntry);
      if (withinRoot.startsWith("..") || isAbsolute(withinRoot)) {
        throw new Error(`Curated extension escapes bundled root: ${entry.id}`);
      }
    }
  }
  return {
    ...set,
    entries: set.entries.map((entry) => ({
      ...entry,
      ...(entry.entryPath ? { entryPath: resolve(entry.entryPath) } : {}),
      capabilities: [...entry.capabilities],
      ...(entry.configuration ? { configuration: { ...entry.configuration } } : {}),
    })),
    diagnostics: set.diagnostics.map((diagnostic) => ({ ...diagnostic })),
  };
}

export function controlledResourceLoaderOptions(
  set: ResolvedExtensionSet,
  extensionFactories: InlineExtension[],
  options: {
    includeBuiltinSkills?: boolean;
    pluginRegistry?: RunCodeRegistryHolder;
    pluginRegistryBuilder?: DesktopPluginRegistryBuilder;
    cwd?: string;
    agentDir?: string;
  } = {},
) {
  const inlineFactories = extensionFactories as DesktopInlineExtension[];

  const controlledInlineFactories = inlineFactories.map((extension) => {
    const extensionName = typeof extension === "function" ? "extension" : extension.name;
    const originalFactory = typeof extension === "function" ? extension : extension.factory;
    const entry = set.entries.find((candidate) => extensionName === `desktop:${candidate.id}`);
    if (!entry) return extension;
    const controlledFactory: ExtensionFactory = async (pi) => {
      let factoryComplete = false;
      const captureTool = (tool: unknown): void => {
        if (!providesPluginTools(entry) || !options.pluginRegistryBuilder) {
          throw new Error(`Direct Pi tool registration is disabled for Desktop extension ${extensionName}`);
        }
        if (factoryComplete) {
          throw new Error(`Plugin ${entry.displayName} registered a tool after its factory completed`);
        }
        options.pluginRegistryBuilder.stageTool(entry, tool);
      };
      const methodOnlyApi = new Proxy(pi, {
        get(target, property, receiver) {
          if (property === "registerTool") {
            return providesPluginTools(entry) ? captureTool : Reflect.get(target, property, receiver);
          }
          return Reflect.get(target, property, receiver);
        },
      }) as ExtensionAPI;
      try {
        await originalFactory(methodOnlyApi);
        factoryComplete = true;
        if (providesPluginTools(entry)) {
          options.pluginRegistryBuilder?.commit(entry.id);
        }
      } catch (error) {
        options.pluginRegistryBuilder?.rollback(entry.id);
        throw error;
      }
    };
    if (typeof extension === "function") return controlledFactory;
    return { ...extension, factory: controlledFactory } satisfies InlineExtension;
  });

  const pathBackedFactories = set.entries.flatMap((entry): InlineExtension[] => {
    if (!entry.entryPath) return [];
    const entryPath = entry.entryPath;
    const configuration = Object.freeze({ ...(entry.configuration ?? {}) });
    return [
      {
        name: entry.id,
        factory: async (pi) => {
          try {
            const namespace = await jiti.import<Record<string, unknown>>(entryPath);
            const factory = namespace.default as ExtensionFactory | undefined;
            let factoryComplete = false;
            const captureTool = (tool: unknown): void => {
              if (!providesPluginTools(entry) || !options.pluginRegistryBuilder) {
                throw new Error(`Direct Pi tool registration is disabled for Desktop extension ${entry.id}`);
              }
              if (factoryComplete) {
                throw new Error(`Plugin ${entry.displayName} registered a tool after its factory completed`);
              }
              options.pluginRegistryBuilder.stageTool(entry, tool);
            };
            if (typeof factory === "function") {
              const desktopApi = new Proxy(pi, {
                get(target, property, receiver) {
                  if (property === "getConfig")
                    return <T = DesktopExtensionConfiguration>() => configuration as Readonly<T>;
                  if (property === "registerTool") {
                    return providesPluginTools(entry) ? captureTool : Reflect.get(target, property, receiver);
                  }
                  return Reflect.get(target, property, receiver);
                },
              }) as DesktopExtensionAPI;
              await factory(desktopApi);
              factoryComplete = true;
            } else {
              throw new Error(`Extension does not export a valid factory function: ${entry.displayName}`);
            }
            if (providesPluginTools(entry)) {
              options.pluginRegistryBuilder?.commit(entry.id);
            }
          } catch (error) {
            options.pluginRegistryBuilder?.rollback(entry.id);
            throw error;
          }
        },
      },
    ];
  });
  return {
    noExtensions: true,
    additionalExtensionPaths: [],
    additionalSkillPaths: [
      ...(options.includeBuiltinSkills === false ? [] : [fileURLToPath(new URL("./skills", import.meta.url))]),
      ...set.entries
        .filter((entry) => entry.source === "builtin" && !entry.runCodeSkill)
        .flatMap((entry) => entry.skillPaths ?? [])
        .filter((path): path is string => typeof path === "string" && path.length > 0),
      ...set.entries
        .filter((entry) => entry.source !== "builtin" && providesPluginTools(entry))
        .flatMap((entry) => entry.skillPaths ?? [])
        .filter((path): path is string => typeof path === "string" && path.length > 0),
    ],
    skillsOverride: (base: { skills: Skill[]; diagnostics: ResourceDiagnostic[] }) => {
      const builtinSkills = set.entries
        .filter((entry) => entry.source === "builtin" && entry.runCodeSkill)
        .flatMap((entry) => entry.skillPaths ?? [])
        .filter((path): path is string => typeof path === "string" && path.length > 0)
        .flatMap(
          (path) =>
            loadSkills({
              cwd: options.cwd ?? process.cwd(),
              agentDir: options.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? process.cwd(),
              skillPaths: [path],
              includeDefaults: false,
            }).skills,
        );
      if (builtinSkills.length === 0) return base;
      const builtinNames = new Set(builtinSkills.map((skill) => skill.name));
      return {
        skills: [...base.skills.filter((skill) => !builtinNames.has(skill.name)), ...builtinSkills],
        diagnostics: base.diagnostics.filter(
          (diagnostic) =>
            !(diagnostic.type === "collision" && diagnostic.collision && builtinNames.has(diagnostic.collision.name)),
        ),
      };
    },
    extensionFactories: [
      ...controlledInlineFactories,
      ...(options.pluginRegistry &&
      options.pluginRegistryBuilder &&
      set.entries.some((entry) => providesPluginTools(entry))
        ? [createRunCodeExtension(options.pluginRegistry, options.cwd ?? process.cwd())]
        : []),
      ...pathBackedFactories,
    ],
    packageManagerOnMissing: async () => "error" as const,
  };
}

export function validatePluginSkills(
  set: ResolvedExtensionSet,
  loaded: { skills: Skill[]; diagnostics: Array<{ type: string; message: string; path?: string }> },
): DesktopExtensionDiagnostic[] {
  const diagnostics: DesktopExtensionDiagnostic[] = [];
  for (const entry of set.entries) {
    if (!entry.capabilities.includes("plugin-methods.provide")) continue;
    const primaryName = entry.runCodeSkill;
    const approvedPaths = new Set(
      (entry.skillPaths ?? [])
        .filter((path): path is string => typeof path === "string" && path.length > 0)
        .map((path) => resolve(path)),
    );
    const primary = loaded.skills.find(
      (skill) => skill.name === primaryName && approvedPaths.has(resolve(skill.filePath)),
    );
    const pathDiagnostic = loaded.diagnostics.find(
      (diagnostic) => diagnostic.path !== undefined && approvedPaths.has(resolve(diagnostic.path)),
    );
    if (!primary || !primary.description.trim() || primary.disableModelInvocation || pathDiagnostic) {
      diagnostics.push({
        extensionId: entry.id,
        source: entry.source,
        extensionSetGeneration: set.generation,
        projectId: set.projectId,
        phase: "load",
        code: "DESKTOP_PLUGIN_SKILL_INVALID",
        message: pathDiagnostic?.message ?? `Plugin ${entry.displayName} primary skill is missing or invalid`,
      });
    }
  }
  return diagnostics;
}

export function extensionServiceDiagnostics(
  set: ResolvedExtensionSet,
  diagnostics: Array<{ type: string; message: string }>,
): DesktopExtensionDiagnostic[] {
  return diagnostics.flatMap((diagnostic) => {
    if (diagnostic.type !== "error" || !diagnostic.message.startsWith('Extension "')) return [];
    const extensionPath = diagnostic.message.match(/^Extension "([^"]+)"/)?.[1];
    const entry = set.entries.find(
      (candidate) =>
        candidate.entryPath === extensionPath ||
        (extensionPath !== undefined &&
          (extensionPath.includes(candidate.id) || extensionPath.includes(candidate.displayName))),
    );
    return [
      {
        extensionId: entry?.id ?? "unknown",
        source: entry?.source ?? "builtin",
        extensionSetGeneration: set.generation,
        projectId: set.projectId,
        phase: "register" as const,
        code: "DESKTOP_EXTENSION_REGISTRATION_FAILED",
        message: sanitizeExtensionMessage(diagnostic.message, extensionPath, entry?.displayName),
      },
    ];
  });
}

export function extensionLoadDiagnostics(
  set: ResolvedExtensionSet,
  result: Pick<LoadExtensionsResult, "errors">,
): DesktopExtensionDiagnostic[] {
  const diagnostics = set.diagnostics.map((diagnostic) => ({
    ...diagnostic,
    extensionSetGeneration: set.generation,
    projectId: set.projectId,
  }));
  for (const error of result.errors ?? []) {
    const normalized = resolve(error.path);
    const inlineId = error.path.match(/^<inline:(.+)>$/)?.[1];
    const entry = set.entries.find(
      (candidate) =>
        candidate.id === inlineId ||
        `desktop:${candidate.id}` === inlineId ||
        (candidate.entryPath !== undefined && resolve(candidate.entryPath) === normalized),
    );
    diagnostics.push({
      extensionId: entry?.id ?? "unknown",
      source: entry?.source ?? "development",
      extensionSetGeneration: set.generation,
      projectId: set.projectId,
      phase: "load",
      code: "DESKTOP_EXTENSION_LOAD_FAILED",
      message: sanitizeExtensionMessage(error.error, error.path, entry?.displayName),
    });
  }
  return diagnostics;
}

export function sanitizeExtensionMessage(
  message: string,
  privatePath: string | undefined,
  displayName: string | undefined,
): string {
  if (!privatePath) return displayName ? `${displayName}: extension operation failed` : "Extension operation failed";
  return message.split(privatePath).join(displayName ?? "approved extension");
}
