import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRegistry, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "../../shared/contracts.ts";
import type {
  AgentSummary,
  ChainStepConfig,
  ChainSummary,
  GetSubagentSettingsInput,
  SaveSubagentSettingsInput,
  SaveSubagentSettingsResult,
  SubagentAgentConfigInput,
  SubagentExtensionConfig,
  SubagentModelOption,
  SubagentSettingsMutation,
  SubagentSettingsSnapshot,
} from "../../shared/subagent-contracts.ts";
import { DesktopBuiltinProviderRegistry } from "../pi/desktop-builtin-provider.ts";
import { handleManagementAction } from "../pi/extensions/pi-subagents/src/agents/agent-management.ts";
import {
  type AgentConfig,
  type ChainConfig,
  configureBuiltinAgentsDir,
  discoverAgentsAll,
  mergeBuiltinAgentOverride,
} from "../pi/extensions/pi-subagents/src/agents/agents.ts";
import { discoverAvailableSkills } from "../pi/extensions/pi-subagents/src/agents/skills.ts";
import {
  getConfigPath,
  loadConfigStrict,
  resolveAsyncByDefault,
  saveConfig,
} from "../pi/extensions/pi-subagents/src/extension/config.ts";
import { AUTHORITY_ACTIONS, type AuthorityAction } from "../pi/extensions/pi-subagents/src/policy/authority.ts";
import { resolveWaitToolConfig } from "../pi/extensions/pi-subagents/src/runs/background/wait-config.ts";

// 与上游 authority.ts 的 DEFAULT_AUTHORITY_POLICY 保持一致（该常量未导出）。
const DEFAULT_AUTHORITY_POLICY: Record<AuthorityAction, "auto" | "confirm" | "forbid"> = {
  discardWorktree: "confirm",
  destructiveCleanup: "confirm",
  spawnBudgetGrant: "confirm",
  scheduleCreate: "auto",
  stopRun: "auto",
  steerRun: "auto",
};

import { getSupportedThinkingLevels, toModelInfo } from "../pi/extensions/pi-subagents/src/shared/model-info.ts";
import { DEFAULT_SUBAGENT_MAX_DEPTH, type ExtensionConfig } from "../pi/extensions/pi-subagents/src/shared/types.ts";
import {
  readWatchdogSettingsOverride,
  resolveWatchdogConfig,
  resolveWatchdogInheritedConfig,
  writeWatchdogSettings,
} from "../pi/extensions/pi-subagents/src/watchdog/settings.ts";

interface SubagentSettingsConfigServiceOptions {
  agentDir: string;
  builtinAgentsDir: string;
  modelRuntime: ModelRuntime;
  isDesktopProviderAvailable(providerId: string): Promise<boolean>;
  getProjectCwd(projectId: string): string;
}

interface ResolvedContext {
  projectId?: string;
  cwd: string;
  discoveryScope: "user" | "both" | "system";
  settingsScope: "user" | "project" | "system";
}

type BuiltinOverrideInput = Parameters<typeof mergeBuiltinAgentOverride>[3];

/** Owns Desktop's direct, session-independent subagent settings reads and writes. */
export class SubagentSettingsConfigService {
  private saveTail: Promise<void> = Promise.resolve();
  private readonly requestResults = new Map<string, SaveSubagentSettingsResult>();
  private readonly options: SubagentSettingsConfigServiceOptions;
  private readonly desktopBuiltinModels: ReadonlyMap<string, SubagentModelOption[]>;

  constructor(options: SubagentSettingsConfigServiceOptions) {
    this.options = options;
    this.desktopBuiltinModels = new Map(
      DesktopBuiltinProviderRegistry.getProviderInfos().map((provider) => [
        provider.id,
        provider.models.map((model) => subagentModelOption({ ...model, provider: provider.id })),
      ]),
    );
    configureBuiltinAgentsDir(options.builtinAgentsDir);
  }

  async getSnapshot(input: GetSubagentSettingsInput = {}): Promise<SubagentSettingsSnapshot> {
    const context = this.resolveContext(input);
    return this.buildSnapshot(context);
  }

  saveConfig(input: SaveSubagentSettingsInput): Promise<SaveSubagentSettingsResult> {
    const cached = this.requestResults.get(input.requestId);
    if (cached) return Promise.resolve(cached);
    const operation = this.saveTail.then(() => this.saveConfigLocked(input));
    this.saveTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async saveConfigLocked(input: SaveSubagentSettingsInput): Promise<SaveSubagentSettingsResult> {
    assertSaveInput(input);
    if (input.settingsScope === "system" && input.mutation.type !== "update-extension-config") {
      throw new Error("System subagent settings only allow extension configuration updates");
    }
    const cached = this.requestResults.get(input.requestId);
    if (cached) return cached;
    const context = this.resolveContext(input);
    const current = await this.buildSnapshot(context);
    if (current.revision !== input.expectedSnapshotRevision) {
      const result: SaveSubagentSettingsResult = { status: "conflict", current };
      this.requestResults.set(input.requestId, result);
      return result;
    }

    this.applyMutation(context, input.mutation);
    const result: SaveSubagentSettingsResult = { status: "saved", snapshot: await this.buildSnapshot(context) };
    this.requestResults.set(input.requestId, result);
    return result;
  }

  private resolveContext(input: GetSubagentSettingsInput): ResolvedContext {
    if (input.settingsScope === "system") {
      if (input.projectId !== undefined) throw new Error("System subagent settings do not accept a projectId");
      return { cwd: tmpdir(), discoveryScope: "system", settingsScope: "system" };
    }
    if (input.settingsScope === "project" && !input.projectId) {
      throw new Error("Project subagent settings require a projectId");
    }
    if (input.settingsScope === "user" && input.projectId !== undefined) {
      throw new Error("User subagent settings do not accept a projectId");
    }
    if (input.projectId) {
      return {
        projectId: input.projectId,
        cwd: this.options.getProjectCwd(input.projectId),
        discoveryScope: "both",
        settingsScope: "project",
      };
    }
    return { cwd: tmpdir(), discoveryScope: "user", settingsScope: "user" };
  }

  private async buildSnapshot(context: ResolvedContext): Promise<SubagentSettingsSnapshot> {
    const discovered = discoverAgentsAll(context.cwd, context.discoveryScope);
    await this.options.modelRuntime.refresh({ allowNetwork: false });
    const runtimeModels = (await this.options.modelRuntime.getAvailable()).map((model) =>
      subagentModelOption({
        id: model.id,
        provider: model.provider,
        name: model.name,
        reasoning: model.reasoning,
      }),
    );
    const desktopBuiltinModels = (
      await Promise.all(
        [...this.desktopBuiltinModels].map(async ([providerId, models]) =>
          (await this.options.isDesktopProviderAvailable(providerId)) ? models : [],
        ),
      )
    ).flat();
    const models = [
      ...new Map([...desktopBuiltinModels, ...runtimeModels].map((model) => [model.id, model])).values(),
    ].sort((left, right) => left.id.localeCompare(right.id));
    const watchdogResult = resolveWatchdogConfig(context.cwd);
    const watchdogScope = context.settingsScope === "project" ? "project" : "user";
    let inheritedWatchdog = watchdogResult.config;
    try {
      inheritedWatchdog = resolveWatchdogInheritedConfig(watchdogScope);
    } catch {
      // The source error is already represented in watchdogResult.errors.
    }
    const watchdogOverride =
      watchdogResult.ok && context.settingsScope !== "system"
        ? readWatchdogSettingsOverride(context.settingsScope, context.cwd)
        : { main: {}, children: {} };
    const diagnostics = [
      ...discovered.chainDiagnostics.map((diagnostic) => ({
        extensionId: "pi-subagents",
        source: "builtin" as const,
        projectId: context.projectId,
        phase: "resolve" as const,
        code: "SUBAGENT_CHAIN_INVALID",
        message: `${diagnostic.filePath}: ${diagnostic.error}`,
      })),
      ...watchdogResult.errors.map((error) => ({
        extensionId: "pi-subagents",
        source: "builtin" as const,
        projectId: context.projectId,
        phase: "resolve" as const,
        code: "SUBAGENT_WATCHDOG_CONFIG_INVALID",
        message: error.message,
      })),
    ];
    let extensionConfig: ExtensionConfig = {};
    try {
      const loadedExtensionConfig = loadConfigStrict();
      validateExtensionConfig(loadedExtensionConfig);
      extensionConfig = loadedExtensionConfig;
    } catch (error) {
      diagnostics.push({
        extensionId: "pi-subagents",
        source: "builtin",
        projectId: context.projectId,
        phase: "resolve",
        code: "SUBAGENT_CONFIG_INVALID",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    const revision = revisionFor(discovered, this.options.agentDir);
    const defaultModel = [...discovered.project, ...discovered.user, ...discovered.builtin, ...discovered.package].find(
      (agent) => agent.modelSource,
    )?.modelSource;

    return {
      revision,
      projectId: context.projectId,
      projectScopeAvailable: discovered.projectDir !== null,
      extensionConfig: selectExtensionConfig(extensionConfig),
      watchdog: {
        effective: {
          enabled: watchdogResult.config.enabled,
          main: {
            enabled: watchdogResult.config.main.enabled,
            ...(watchdogResult.config.main.model ? { model: watchdogResult.config.main.model } : {}),
            ...(watchdogResult.config.main.thinking !== undefined
              ? { thinking: watchdogResult.config.main.thinking as ThinkingLevel | false }
              : {}),
          },
          children: {
            enabled: watchdogResult.config.children.enabled,
            ...(watchdogResult.config.children.model ? { model: watchdogResult.config.children.model } : {}),
            ...(watchdogResult.config.children.thinking !== undefined
              ? { thinking: watchdogResult.config.children.thinking as ThinkingLevel | false }
              : {}),
          },
        },
        inherited: {
          enabled: inheritedWatchdog.enabled,
          main: {
            enabled: inheritedWatchdog.main.enabled,
            ...(inheritedWatchdog.main.model ? { model: inheritedWatchdog.main.model } : {}),
            ...(inheritedWatchdog.main.thinking !== undefined
              ? { thinking: inheritedWatchdog.main.thinking as ThinkingLevel | false }
              : {}),
          },
          children: {
            enabled: inheritedWatchdog.children.enabled,
            ...(inheritedWatchdog.children.model ? { model: inheritedWatchdog.children.model } : {}),
            ...(inheritedWatchdog.children.thinking !== undefined
              ? { thinking: inheritedWatchdog.children.thinking as ThinkingLevel | false }
              : {}),
          },
        },
        override: watchdogOverride,
      },
      builtinAgents: discovered.builtin.map(agentSummary).sort(byName),
      packageAgents: discovered.package.map(agentSummary).sort(byName),
      userAgents: discovered.user.map(agentSummary).sort(byName),
      projectAgents: discovered.project.map(agentSummary).sort(byName),
      chains: discovered.chains.map(chainSummary).sort(byName),
      models,
      skills: discoverAvailableSkills(context.cwd),
      ...(defaultModel ? { defaultModel } : {}),
      diagnostics,
    };
  }

  private applyMutation(context: ResolvedContext, mutation: SubagentSettingsMutation): void {
    if (mutation.type === "update-watchdog-config" && context.settingsScope !== mutation.scope) {
      throw new Error(`Watchdog mutation scope '${mutation.scope}' does not match '${context.settingsScope}' settings`);
    }
    assertProjectScopeAvailable(context.cwd, mutation);
    switch (mutation.type) {
      case "create-agent":
        this.runManagement(context.cwd, "create", {
          config: managementAgentConfig(mutation.config, mutation.scope),
        });
        return;
      case "update-agent": {
        const discovered = discoverAgentsAll(context.cwd, context.discoveryScope);
        const custom = (mutation.scope === "user" ? discovered.user : discovered.project).some(
          (agent) => agent.name === mutation.agent,
        );
        if (
          mutation.target === "builtin" ||
          (!custom && discovered.builtin.some((agent) => agent.name === mutation.agent))
        ) {
          const override = builtinOverrideConfig(mutation.config);
          if (Object.keys(override).length === 0) throw new Error("No supported builtin override fields were provided");
          mergeBuiltinAgentOverride(context.cwd, mutation.agent, mutation.scope, override);
          return;
        }
        this.runManagement(context.cwd, "update", {
          agent: mutation.agent,
          agentScope: mutation.scope,
          config: managementAgentConfig(mutation.config),
        });
        return;
      }
      case "delete-agent":
        this.runManagement(context.cwd, "delete", { agent: mutation.agent, agentScope: mutation.scope });
        return;
      case "eject-agent":
        this.runManagement(context.cwd, "eject", { agent: mutation.agent, agentScope: mutation.scope });
        return;
      case "set-agent-enabled":
        this.runManagement(context.cwd, mutation.disabled ? "disable" : "enable", {
          agent: mutation.agent,
          agentScope: mutation.scope ?? "user",
        });
        return;
      case "create-chain":
        this.runManagement(context.cwd, "create", {
          config: { ...mutation.config, scope: mutation.scope },
        });
        return;
      case "update-chain":
        this.runManagement(context.cwd, "update", {
          chainName: mutation.chain,
          agentScope: mutation.scope,
          config: mutation.config,
        });
        return;
      case "delete-chain":
        this.runManagement(context.cwd, "delete", { chainName: mutation.chain, agentScope: mutation.scope });
        return;
      case "update-watchdog-config":
        writeWatchdogSettings({
          scope: mutation.scope,
          cwd: context.cwd,
          config: mutation.config,
        });
        return;
      case "update-extension-config": {
        const current = loadConfigStrict();
        const next: ExtensionConfig = {
          ...current,
          ...mutation.config,
          ...(mutation.config.scheduledRuns
            ? { scheduledRuns: { ...current.scheduledRuns, ...mutation.config.scheduledRuns } }
            : {}),
        };
        validateExtensionConfig(next);
        saveConfig(next);
      }
    }
  }

  private runManagement(
    cwd: string,
    action: "create" | "update" | "delete" | "eject" | "disable" | "enable",
    params: { agent?: string; chainName?: string; agentScope?: string; config?: unknown },
  ): void {
    const result = handleManagementAction(
      action,
      { action, ...params },
      {
        cwd,
        modelRegistry: new ModelRegistry(this.options.modelRuntime),
      },
    );
    if ("isError" in result && result.isError === true) {
      const message = result.content
        .filter((part): part is Extract<(typeof result.content)[number], { type: "text" }> => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      throw new Error(message || `Subagent ${action} failed`);
    }
  }
}

function subagentModelOption(model: {
  id: string;
  provider: string;
  name: string;
  api?: string;
  reasoning?: boolean;
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
}): SubagentModelOption {
  const info = toModelInfo(model);
  return {
    id: info.fullId,
    provider: info.provider,
    name: model.name,
    reasoning: info.reasoning ?? false,
    thinkingLevels: getSupportedThinkingLevels(info),
  };
}

function agentSummary(agent: AgentConfig): AgentSummary {
  return {
    name: agent.name,
    ...(agent.localName ? { localName: agent.localName } : {}),
    ...(agent.packageName ? { packageName: agent.packageName } : {}),
    description: agent.description,
    source: agent.source,
    filePath: agent.filePath,
    ...(agent.model ? { model: agent.model } : {}),
    ...(agent.fallbackModels ? { fallbackModels: [...agent.fallbackModels] } : {}),
    ...(agent.thinking !== undefined ? { thinking: agent.thinking as AgentSummary["thinking"] } : {}),
    systemPrompt: agent.systemPrompt,
    systemPromptMode: agent.systemPromptMode,
    inheritProjectContext: agent.inheritProjectContext,
    inheritSkills: agent.inheritSkills,
    ...(agent.defaultContext ? { defaultContext: agent.defaultContext } : {}),
    ...(agent.disabled !== undefined ? { disabled: agent.disabled } : {}),
    ...(agent.defaultAsync !== undefined ? { defaultAsync: agent.defaultAsync } : {}),
    ...(agent.defaultTimeoutMs !== undefined ? { defaultTimeoutMs: agent.defaultTimeoutMs } : {}),
    ...(agent.tools ? { tools: [...agent.tools] } : {}),
    ...(agent.mcpDirectTools ? { mcpDirectTools: [...agent.mcpDirectTools] } : {}),
    ...(agent.skills ? { skills: [...agent.skills] } : {}),
    ...(agent.defaultTurnBudget ? { turnBudget: { ...agent.defaultTurnBudget } } : {}),
    ...(agent.toolBudget ? { toolBudget: { ...agent.toolBudget } } : {}),
    ...(agent.acceptanceRole ? { acceptanceRole: agent.acceptanceRole } : {}),
    ...(agent.completionGuard !== undefined ? { completionGuard: agent.completionGuard } : {}),
    ...(agent.override
      ? {
          overridden: true,
          overrideScope: agent.override.scope,
          ...(agent.override.base.model ? { baseModel: agent.override.base.model } : {}),
        }
      : {}),
  };
}

function chainSummary(chain: ChainConfig): ChainSummary {
  const editable = chain.steps.length > 0 && chain.steps.every(isEditableChainStep);
  return {
    name: chain.name,
    ...(chain.localName ? { localName: chain.localName } : {}),
    ...(chain.packageName ? { packageName: chain.packageName } : {}),
    description: chain.description,
    source: chain.source === "builtin" ? "package" : chain.source,
    filePath: chain.filePath,
    steps: chain.steps
      .filter((step): step is typeof step & { agent: string } => typeof step.agent === "string")
      .map(
        (step) =>
          ({
            agent: step.agent,
            ...(step.task !== undefined ? { task: step.task } : {}),
            ...(step.phase !== undefined ? { phase: step.phase } : {}),
            ...(step.label !== undefined ? { label: step.label } : {}),
            ...(step.output !== undefined ? { output: step.output } : {}),
            ...(step.outputMode !== undefined ? { outputMode: step.outputMode } : {}),
            ...(step.reads !== undefined ? { reads: step.reads } : {}),
            ...(step.model !== undefined ? { model: step.model } : {}),
            ...(step.skills !== undefined ? { skills: step.skills } : {}),
            ...(step.progress !== undefined ? { progress: step.progress } : {}),
            ...(step.toolBudget !== undefined ? { toolBudget: step.toolBudget } : {}),
          }) satisfies ChainStepConfig,
      ),
    stepCount: chain.steps.length,
    editable,
    ...(!editable ? { editBlockedReason: "此流程包含并行、动态展开或当前编辑器无法无损保存的高级字段。" } : {}),
  };
}

const EDITABLE_CHAIN_STEP_KEYS = new Set([
  "agent",
  "task",
  "phase",
  "label",
  "output",
  "reads",
  "model",
  "skills",
  "progress",
]);

function isEditableChainStep(step: ChainConfig["steps"][number]): boolean {
  return typeof step.agent === "string" && Object.keys(step).every((key) => EDITABLE_CHAIN_STEP_KEYS.has(key));
}

function managementAgentConfig(config: SubagentAgentConfigInput, scope?: "user" | "project"): Record<string, unknown> {
  return {
    ...config,
    ...(scope ? { scope } : {}),
    ...(Array.isArray(config.tools) ? { tools: config.tools.join(", ") } : {}),
    ...(Array.isArray(config.skills) ? { skills: config.skills.join(", ") } : {}),
  };
}

function builtinOverrideConfig(config: SubagentAgentConfigInput): BuiltinOverrideInput {
  const override: BuiltinOverrideInput = {};
  if (config.model !== undefined) override.model = config.model;
  if (config.fallbackModels !== undefined) override.fallbackModels = config.fallbackModels;
  if (config.thinking !== undefined) override.thinking = config.thinking;
  if (config.systemPromptMode !== undefined) override.systemPromptMode = config.systemPromptMode;
  if (config.inheritProjectContext !== undefined) override.inheritProjectContext = config.inheritProjectContext;
  if (config.inheritSkills !== undefined) override.inheritSkills = config.inheritSkills;
  if (config.defaultContext !== undefined) override.defaultContext = config.defaultContext;
  if (config.acceptanceRole !== undefined) override.acceptanceRole = config.acceptanceRole;
  if (config.disabled !== undefined) override.disabled = config.disabled;
  if (config.systemPrompt !== undefined) override.systemPrompt = config.systemPrompt;
  if (config.skills !== undefined) override.skills = config.skills;
  if (config.tools !== undefined) override.tools = config.tools;
  if (config.completionGuard !== undefined) override.completionGuard = config.completionGuard;
  if (config.toolBudget !== undefined) override.toolBudget = config.toolBudget;
  return override;
}

function selectExtensionConfig(config: ExtensionConfig): SubagentExtensionConfig {
  const waitTool = resolveWaitToolConfig(config.waitTool);
  const authorityPolicy: NonNullable<SubagentExtensionConfig["authorityPolicy"]> = {};
  for (const action of AUTHORITY_ACTIONS as readonly AuthorityAction[]) {
    authorityPolicy[action] = config.authorityPolicy?.[action] ?? DEFAULT_AUTHORITY_POLICY[action];
  }
  const proactiveSkillSubagents =
    config.proactiveSkillSubagents === undefined || config.proactiveSkillSubagents === false
      ? { enabled: false }
      : config.proactiveSkillSubagents;
  return {
    // 默认值与上游运行时语义保持一致（resolveAsyncByDefault 缺省 true、
    // DEFAULT_SUBAGENT_MAX_DEPTH=2、scheduledRuns.enabled 缺省 true），
    // 保证 UI 展示与 pi-subagents 实际行为一致。
    asyncByDefault: resolveAsyncByDefault(config),
    asyncWidget: config.asyncWidget ?? true,
    maxSubagentDepth: config.maxSubagentDepth ?? DEFAULT_SUBAGENT_MAX_DEPTH,
    maxSubagentSpawnsPerSession: config.maxSubagentSpawnsPerSession ?? 0,
    globalConcurrencyLimit: config.globalConcurrencyLimit ?? 20,
    toolDescriptionMode: config.toolDescriptionMode ?? "full",
    artifactDir: config.artifactDir ?? "project",
    scheduledRuns: {
      ...config.scheduledRuns,
      enabled: config.scheduledRuns?.enabled ?? true,
    },
    legacyChainControls: config.legacyChainControls ?? false,
    inlineToolDisplay: config.inlineToolDisplay ?? "rich",
    forceTopLevelAsync: config.forceTopLevelAsync ?? false,
    waitTool: { enabled: waitTool.enabled },
    defaultSessionDir: config.defaultSessionDir,
    singleRunOutputBaseDir: config.singleRunOutputBaseDir,
    worktreeSetupHook: config.worktreeSetupHook,
    worktreeSetupHookTimeoutMs: config.worktreeSetupHookTimeoutMs,
    worktreeBaseDir: config.worktreeBaseDir,
    intercomBridge: config.intercomBridge,
    proactiveSkillSubagents,
    missions: { enabled: config.missions?.enabled ?? true },
    authorityPolicy,
    parallel: config.parallel,
    chain: config.chain,
    turnBudget: config.turnBudget,
    toolBudget: config.toolBudget,
    control: config.control,
    completionBatch: config.completionBatch,
    usageBudget: config.usageBudget,
    permissions: config.permissions,
  };
}

function validateExtensionConfig(config: ExtensionConfig): void {
  for (const [name, value, minimum] of [
    ["maxSubagentDepth", config.maxSubagentDepth, 0],
    ["maxSubagentSpawnsPerSession", config.maxSubagentSpawnsPerSession, 0],
    ["globalConcurrencyLimit", config.globalConcurrencyLimit, 1],
    ["worktreeSetupHookTimeoutMs", config.worktreeSetupHookTimeoutMs, 0],
    ["parallel.maxTasks", config.parallel?.maxTasks, 1],
    ["parallel.concurrency", config.parallel?.concurrency, 1],
    ["chain.dynamicFanout.maxItems", config.chain?.dynamicFanout?.maxItems, 1],
    ["scheduledRuns.maxPending", config.scheduledRuns?.maxPending, 1],
  ] as const) {
    if (value !== undefined && (!Number.isInteger(value) || value < minimum)) {
      throw new Error(`${name} must be an integer >= ${minimum}`);
    }
  }
  for (const [name, value] of [
    ["toolDescriptionMode", config.toolDescriptionMode],
    ["inlineToolDisplay", config.inlineToolDisplay],
    ["intercomBridge.mode", config.intercomBridge?.mode],
  ] as const) {
    if (value === undefined) continue;
    const allowed =
      name === "toolDescriptionMode"
        ? ["full", "compact", "custom"]
        : name === "inlineToolDisplay"
          ? ["rich", "summary"]
          : ["off", "fork-only", "always"];
    if (!allowed.includes(value)) {
      throw new Error(`${name} is invalid`);
    }
  }
  if (config.artifactDir && !["project", "session", "temp"].includes(config.artifactDir)) {
    throw new Error("artifactDir is invalid");
  }
  for (const [name, value] of [
    ["legacyChainControls", config.legacyChainControls],
    ["forceTopLevelAsync", config.forceTopLevelAsync],
  ] as const) {
    if (value !== undefined && typeof value !== "boolean") {
      throw new Error(`${name} must be a boolean`);
    }
  }
  for (const [name, value] of [
    ["defaultSessionDir", config.defaultSessionDir],
    ["singleRunOutputBaseDir", config.singleRunOutputBaseDir],
    ["worktreeSetupHook", config.worktreeSetupHook],
    ["worktreeBaseDir", config.worktreeBaseDir],
    ["intercomBridge.instructionFile", config.intercomBridge?.instructionFile],
    ["scheduledRuns.storeRoot", config.scheduledRuns?.storeRoot],
  ] as const) {
    if (value !== undefined && (typeof value !== "string" || !value.trim())) {
      throw new Error(`${name} must be a non-empty string`);
    }
  }
  if (config.worktreeSetupHook && config.worktreeSetupHookTimeoutMs === 0) {
    throw new Error("worktreeSetupHookTimeoutMs must be > 0 when worktreeSetupHook is set");
  }
  for (const [name, value] of [
    ["turnBudget.maxTurns", config.turnBudget?.maxTurns],
    ["turnBudget.graceTurns", config.turnBudget?.graceTurns],
    ["toolBudget.soft", config.toolBudget?.soft],
    ["toolBudget.hard", config.toolBudget?.hard],
    ["control.needsAttentionAfterMs", config.control?.needsAttentionAfterMs],
    ["control.activeNoticeAfterMs", config.control?.activeNoticeAfterMs],
    ["completionBatch.debounceMs", config.completionBatch?.debounceMs],
    ["completionBatch.maxWaitMs", config.completionBatch?.maxWaitMs],
    ["usageBudget.tokens.soft", config.usageBudget?.tokens?.soft],
    ["usageBudget.tokens.hard", config.usageBudget?.tokens?.hard],
    ["usageBudget.costUsd.soft", config.usageBudget?.costUsd?.soft],
    ["usageBudget.costUsd.hard", config.usageBudget?.costUsd?.hard],
  ] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
      throw new Error(`${name} must be a positive number`);
    }
  }
  for (const [name, value] of [
    [
      "waitTool.enabled",
      config.waitTool === undefined
        ? undefined
        : typeof config.waitTool === "boolean"
          ? config.waitTool
          : config.waitTool.enabled,
    ],
    ["intercomBridge.resultDelivery", config.intercomBridge?.resultDelivery],
  ] as const) {
    if (value !== undefined && typeof value !== "boolean") {
      throw new Error(`${name} must be a boolean`);
    }
  }
  if (config.missions !== undefined && typeof config.missions !== "object") {
    throw new Error("missions must be an object");
  }
  if (config.authorityPolicy !== undefined) {
    const allowed = new Set<string>(AUTHORITY_ACTIONS);
    const decisions = new Set<string>(["auto", "confirm", "forbid"]);
    for (const [action, decision] of Object.entries(config.authorityPolicy)) {
      if (!allowed.has(action)) throw new Error(`authorityPolicy.${action} is unknown`);
      if (!decisions.has(decision as string))
        throw new Error(`authorityPolicy.${action} must be auto, confirm, or forbid`);
    }
  }
  if (config.permissions !== undefined && config.permissions.rules !== undefined) {
    if (typeof config.permissions.rules !== "object" || Array.isArray(config.permissions.rules)) {
      throw new Error("permissions.rules must be an object");
    }
    for (const [tool, decision] of Object.entries(config.permissions.rules)) {
      if (!tool.trim()) throw new Error("permissions.rules contains an empty tool name");
      if (!["allow", "ask", "deny"].includes(decision)) {
        throw new Error(`permissions.rules.${tool} must be allow, ask, or deny`);
      }
    }
  }
}

function assertProjectScopeAvailable(cwd: string, mutation: SubagentSettingsMutation): void {
  const scope = "scope" in mutation ? mutation.scope : undefined;
  if (scope === "project" && discoverAgentsAll(cwd).projectDir === null) {
    throw new Error("Project scope is unavailable because no project config root was found");
  }
}

function revisionFor(discovered: ReturnType<typeof discoverAgentsAll>, agentDir: string): string {
  const paths = new Set<string>([
    getConfigPath(),
    discovered.userSettingsPath,
    join(agentDir, "models.json"),
    join(agentDir, "auth.json"),
    discovered.userDir,
    discovered.userChainDir,
    ...[discovered.projectSettingsPath, discovered.projectDir, discovered.projectChainDir].filter(
      (path): path is string => path !== null,
    ),
    ...discovered.builtin.map((agent) => agent.filePath),
    ...discovered.package.map((agent) => agent.filePath),
  ]);
  const hash = createHash("sha256");
  for (const path of [...paths].sort()) hashPath(hash, path);
  return hash.digest("hex");
}

function hashPath(hash: ReturnType<typeof createHash>, path: string): void {
  hash.update(path);
  if (!existsSync(path)) {
    hash.update("missing");
    return;
  }
  const info = lstatSync(path);
  if (info.isSymbolicLink()) {
    hash.update("symlink");
    return;
  }
  if (info.isDirectory()) {
    hash.update("directory");
    for (const entry of readdirSync(path).sort()) hashPath(hash, join(path, entry));
    return;
  }
  if (info.isFile()) {
    hash.update(readFileSync(path));
    return;
  }
  hash.update("other");
}

function assertSaveInput(input: SaveSubagentSettingsInput): void {
  if (
    !input ||
    typeof input !== "object" ||
    typeof input.requestId !== "string" ||
    !input.requestId ||
    typeof input.expectedSnapshotRevision !== "string" ||
    !input.mutation ||
    typeof input.mutation !== "object"
  ) {
    throw new TypeError("Invalid subagent settings save input");
  }
}

function byName(left: { name: string }, right: { name: string }): number {
  return left.name.localeCompare(right.name);
}
