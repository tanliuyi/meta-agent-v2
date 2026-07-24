/**
 * Async execution logic for subagent tool
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../../agents/agents.ts";
import { writeAtomicJson, writePrivateAtomicJson } from "../../shared/atomic-json.ts";
import { applyThinkingSuffix } from "../../shared/model-info.ts";
import { injectOutputPathSystemPrompt, injectSingleOutputInstruction, normalizeSingleOutputOverride, resolveSingleOutputPath, validateFileOnlyOutputMode } from "../shared/single-output.ts";
import { buildChainInstructions, isDynamicParallelStep, isParallelStep, resolveStepBehavior, suppressProgressForReadOnlyTask, writeInitialProgressFile, type ChainStep, type ResolvedStepBehavior, type SequentialStep, type StepOverrides } from "../../shared/settings.ts";
import { isParallelGroup, isDynamicRunnerGroup, type RunnerStep, type RunnerSubagentStep } from "../shared/parallel-utils.ts";
import type { ContextMode } from "../shared/context-mode.ts";
import { buildSkillInjection
, normalizeSkillInput, resolveSkillsWithFallback } from "../../agents/skills.ts";
import { buildAgentMemoryInjection } from "../../agents/agent-memory.ts";
import { resolveChildCwd } from "../../shared/utils.ts";
import { buildModelCandidates, resolveEffectiveSubagentModel, resolveModelCandidate, resolveSubagentModelOverride, type AvailableModelInfo, type ParentModel } from "../shared/model-fallback.ts";
import type { ModelScopeConfig } from "../shared/model-scope.ts";
import { resolveEffectiveThinking } from "../../shared/model-info.ts";
import { resolveExpectedWorktreeAgentCwd } from "../shared/worktree.ts";
import { buildWorkflowGraphSnapshot } from "../shared/workflow-graph.ts";
import { ChainOutputValidationError, validateChainOutputBindings } from "../shared/chain-outputs.ts";
import { createStructuredOutputRuntime } from "../shared/structured-output.ts";
import { resolveEffectiveAcceptance } from "../shared/acceptance.ts";
import {
	type AcceptanceInput,
	type AgentContract,
	type ArtifactConfig,
	type Details,
	type JsonSchemaObject,
	type MaxOutputConfig,
	type NestedRouteInfo,
	type ResolvedControlConfig,
	type ResolvedTurnBudget,
	type ResolvedToolBudget,
	type SubagentRunMode,
	type SteeringRecoveryDescriptor,
	ASYNC_DIR,
	RESULTS_DIR,
	SUBAGENT_ASYNC_STARTED_EVENT,
	SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
	TEMP_ROOT_DIR,
	getAsyncConfigPath,
	resolveChildMaxSubagentDepth,
} from "../../shared/types.ts";
import { nestedResultsPath, resolveInheritedNestedRouteFromEnv, resolveNestedParentAddressFromEnv, writeNestedEvent } from "../shared/nested-events.ts";
import { initialTurnBudgetState } from "../shared/turn-budget.ts";
import { validateToolBudgetConfig } from "../shared/tool-budget.ts";
import type { ImportedAsyncRoot } from "./chain-root-attachment.ts";
import type { SessionLeaseRequest } from "../shared/session-lease.ts";
import { appendJsonl } from "../../shared/artifacts.ts";
import type { SubagentRuntime, SubagentRuntimeRunRequest } from "../../runtime/subagent-runtime.ts";
import type { SubagentExtensionProfile, SubagentRunEvent } from "../../../../../../../shared/subagent-contracts.ts";
import { readStatus, resolveWatchPath } from "../../shared/utils.ts";
import {
	closeSteerInbox,
	consumeInterruptRequest,
	consumeSteerRequests,
	consumeStopRequest,
	type SteerRequest,
	writeSteerAck,
} from "./control-channel.ts";
import { POLL_INTERVAL_MS } from "../../shared/types.ts";
import {
	createSteeringStatus,
	recordSteeringRequest,
	updateSteeringTarget,
} from "./steering.ts";

interface AsyncExecutionContext {
	pi: ExtensionAPI;
	cwd: string;
	currentSessionId: string;
	/** Parent session id used by permission-system ask forwarding. */
	parentSessionId?: string;
	currentModelProvider?: string;
	currentModel?: ParentModel;
	/** Optional model-scope enforcement resolved from subagent settings. */
	modelScope?: ModelScopeConfig;
	/** Whether the parent session has an interactive UI. */
	interactive?: boolean;
}

interface AsyncChainParams {
	chain: ChainStep[];
	task?: string;
	subagentRuntime?: SubagentRuntime;
	/** Raw caller-facing goal used only by the started event. */
	goal?: string;
	attachRoot?: ImportedAsyncRoot & { agent: string; outputName?: string; label?: string };
	resultMode?: Exclude<SubagentRunMode, "single">;
	agents: AgentConfig[];
	ctx: AsyncExecutionContext;
	availableModels?: AvailableModelInfo[];
	cwd?: string;
	maxOutput?: MaxOutputConfig;
	artifactsDir?: string;
	artifactConfig: ArtifactConfig;
	shareEnabled: boolean;
	sessionRoot?: string;
	agentContract?: AgentContract;
	chainSkills?: string[];
	sessionFilesByFlatIndex?: (string | undefined)[];
	thinkingOverridesByFlatIndex?: (AgentConfig["thinking"] | undefined)[];
	contextForAgent?: (agentName: string) => ContextMode;
	progressDir?: string;
	dynamicFanoutMaxItems?: number;
	maxSubagentDepth: number;
	waitToolEnabled?: boolean;
	worktreeSetupHook?: string;
	worktreeSetupHookTimeoutMs?: number;
	worktreeBaseDir?: string;
	controlConfig?: ResolvedControlConfig;
	controlIntercomTarget?: string;
	childIntercomTarget?: (agent: string, index: number) => string | undefined;
	nestedRoute?: NestedRouteInfo;
	acceptance?: AcceptanceInput;
	timeoutMs?: number;
	turnBudget?: ResolvedTurnBudget;
	toolBudget?: ResolvedToolBudget;
	configToolBudget?: ResolvedToolBudget;
	/** Global cap on simultaneously-running subagent tasks within the async run. */
	globalConcurrencyLimit?: number;
}

interface AsyncSingleParams {
	agent: string;
	task?: string;
	subagentRuntime?: SubagentRuntime;
	/** Raw caller-facing goal used only by the started event. */
	goal?: string;
	agentConfig: AgentConfig;
	ctx: AsyncExecutionContext;
	cwd?: string;
	maxOutput?: MaxOutputConfig;
	artifactsDir?: string;
	artifactConfig: ArtifactConfig;
	shareEnabled: boolean;
	sessionRoot?: string;
	sessionDir?: string;
	sessionFile?: string;
	revivalLease?: SessionLeaseRequest;
	context?: ContextMode;
	skills?: string[];
	output?: string | boolean;
	outputMode?: "inline" | "file-only";
	outputBaseDir?: string;
	agentContract?: AgentContract;
	structuredOutputSchema?: JsonSchemaObject;
	modelOverride?: string;
	thinkingOverride?: AgentConfig["thinking"];
	availableModels?: AvailableModelInfo[];
	maxSubagentDepth: number;
	waitToolEnabled?: boolean;
	worktreeSetupHook?: string;
	worktreeSetupHookTimeoutMs?: number;
	worktreeBaseDir?: string;
	controlConfig?: ResolvedControlConfig;
	controlIntercomTarget?: string;
	childIntercomTarget?: (agent: string, index: number) => string | undefined;
	nestedRoute?: NestedRouteInfo;
	acceptance?: AcceptanceInput;
	timeoutMs?: number;
	absoluteDeadlineAt?: number;
	turnBudget?: ResolvedTurnBudget;
	toolBudget?: ResolvedToolBudget;
	configToolBudget?: ResolvedToolBudget;
}

interface AsyncExecutionResult {
	content: Array<{ type: "text"; text: string }>;
	details: Details;
	isError?: boolean;
}

export interface AsyncRunnerStepBuildParams {
	chain: ChainStep[];
	task?: string;
	attachRoot?: ImportedAsyncRoot & { agent: string; outputName?: string; label?: string };
	resultMode?: SubagentRunMode;
	agents: AgentConfig[];
	ctx: AsyncExecutionContext;
	availableModels?: AvailableModelInfo[];
	cwd?: string;
	chainSkills?: string[];
	sessionFilesByFlatIndex?: (string | undefined)[];
	thinkingOverridesByFlatIndex?: (AgentConfig["thinking"] | undefined)[];
	contextForAgent?: (agentName: string) => ContextMode;
	progressDir?: string;
	agentContract?: AgentContract;
	dynamicFanoutMaxItems?: number;
	maxSubagentDepth: number;
	waitToolEnabled?: boolean;
	worktreeBaseDir?: string;
	asyncDir: string;
	outputBaseDir?: string;
	validateOutputBindings?: boolean;
	toolBudget?: ResolvedToolBudget;
	configToolBudget?: ResolvedToolBudget;
}

export type AsyncRunnerStepBuildResult =
	| {
		steps: RunnerStep[];
		runnerCwd: string;
		workflowGraph: ReturnType<typeof buildWorkflowGraphSnapshot>;
		eventChain: ChainStep[];
		originalTask?: string;
	}
	| { error: string };

export function formatAsyncStartedMessage(headline: string, interactive: boolean): string {
	const guidance = interactive
		? [
			"The async run is detached and running in the background.",
			"You are in an interactive session. By default, return control to the user now; Pi will wake you on completion when the run finishes or needs attention. Do NOT call subagent_wait() merely to wait, and do not run sleep/polling loops to wait for it.",
			"Override that default and call subagent_wait() before ending the turn only when the current request is run-to-completion — for example, the user asked you to report results back here before continuing, or a skill must finish in one turn. In that case, call subagent_wait() to block until the run completes so its results are delivered in this turn instead of deferred.",
			"Otherwise, continue any independent work or return control to the user. Use subagent({ action: \"status\", id: \"...\" }) for a one-shot status/result or to inspect a blocked/stale run, never as a wait loop.",
		]
		: [
			"The async run is detached. Do not run sleep timers or polling loops just to wait for it.",
			"This is a non-interactive run: Pi auto-drains current-session background work at agent_end so detached children are not abandoned; call subagent_wait() when this turn must receive the run's results before it ends, otherwise let the headless auto-drain finish the work.",
			"Use subagent({ action: \"status\", id: \"...\" }) when you need a one-shot status/result or to inspect a blocked/stale run. To block until completion, use subagent_wait() — do not poll in a loop.",
		];
	return [headline, "", ...guidance].join("\n");
}

/** Check whether Desktop injected an absolute, existing Node runtime. */
export function isAsyncAvailable(): boolean {
	return false;
}

function formatAsyncStartError(mode: SubagentRunMode, message: string): AsyncExecutionResult {
	return {
		content: [{ type: "text", text: message }],
		isError: true,
		details: { mode, results: [] },
	};
}

const UNAVAILABLE_SUBAGENT_SKILL_ERROR = "Skills not found: pi-subagents";

class UnavailableSubagentSkillError extends Error {}
class AsyncStartValidationError extends Error {}

export function buildAsyncRunnerSteps(id: string, params: AsyncRunnerStepBuildParams): AsyncRunnerStepBuildResult {
	const {
		chain,
		agents,
		ctx,
		cwd,
		sessionFilesByFlatIndex,
		thinkingOverridesByFlatIndex,
		maxSubagentDepth,
		worktreeBaseDir,
		asyncDir,
	} = params;
	const outputBaseDir = params.outputBaseDir;
	const resultMode = params.resultMode ?? "chain";
	const chainSkills = params.chainSkills ?? [];
	const availableModels = params.availableModels;
	const runnerCwd = resolveChildCwd(ctx.cwd, cwd);
	const progressDir = params.progressDir ?? runnerCwd;
	const graphChain: ChainStep[] = params.attachRoot
		? [{
				agent: params.attachRoot.agent,
				task: `Attach async root ${params.attachRoot.runId}`,
				label: params.attachRoot.label ?? `Attached root ${params.attachRoot.runId}`,
				...(params.attachRoot.outputName ? { as: params.attachRoot.outputName } : {}),
			}, ...chain]
		: chain;
	const firstStep = chain[0];
	const originalTask = params.task ?? (firstStep
		? (isParallelStep(firstStep)
			? firstStep.parallel[0]?.task
			: isDynamicParallelStep(firstStep)
				? firstStep.parallel.task
				: (firstStep as SequentialStep).task)
		: undefined);
	try {
		if (params.validateOutputBindings !== false) {
			validateChainOutputBindings(chain, { maxItems: params.dynamicFanoutMaxItems });
		}
	} catch (error) {
		if (error instanceof ChainOutputValidationError) return { error: error.message };
		throw error;
	}
	const workflowGraph = buildWorkflowGraphSnapshot({ runId: id, mode: resultMode, steps: graphChain });

	for (const s of chain) {
		const stepAgents = isParallelStep(s)
			? s.parallel.map((t) => t.agent)
			: isDynamicParallelStep(s)
				? [s.parallel.agent]
				: [(s as SequentialStep).agent];
		for (const agentName of stepAgents) {
			if (!agents.find((x) => x.name === agentName)) {
				return { error: `Unknown agent: ${agentName}` };
			}
		}
	}

	let progressInstructionCreated = false;
	const buildStepOverrides = (s: SequentialStep): StepOverrides => {
		const stepSkillInput = normalizeSkillInput(s.skill);
		return {
			...(s.output !== undefined ? { output: s.output } : {}),
			...(s.outputMode !== undefined ? { outputMode: s.outputMode } : {}),
			...(s.reads !== undefined ? { reads: s.reads } : {}),
			...(s.progress !== undefined ? { progress: s.progress } : {}),
			...(stepSkillInput !== undefined ? { skills: stepSkillInput } : {}),
			...(s.model !== undefined ? { model: s.model } : {}),
		};
	};
	const buildSeqStep = (s: SequentialStep, sessionFile?: string, behaviorCwd?: string, progressPrecreated = false, resolvedBehavior?: ResolvedStepBehavior, flatIndex?: number, parallelOutputNamespace?: { stepIndex: number; taskIndex?: number }) => {
		const a = agents.find((x) => x.name === s.agent)!;
		const toolBudgetInput = s.toolBudget ?? params.toolBudget ?? a.toolBudget ?? params.configToolBudget;
		const resolvedToolBudget = validateToolBudgetConfig(toolBudgetInput, s.toolBudget ? "toolBudget" : a.toolBudget ? "agent.toolBudget" : "config.toolBudget");
		if (resolvedToolBudget.error) throw new AsyncStartValidationError(resolvedToolBudget.error);
		const stepCwd = resolveChildCwd(runnerCwd, s.cwd);
		const instructionCwd = behaviorCwd ?? stepCwd;
		let behavior = suppressProgressForReadOnlyTask(resolvedBehavior ?? resolveStepBehavior(a, buildStepOverrides(s), chainSkills), s.task, originalTask);
		const inheritedRelativeParallelOutput = parallelOutputNamespace && s.output === undefined && typeof behavior.output === "string" && !path.isAbsolute(behavior.output);
		if (inheritedRelativeParallelOutput && parallelOutputNamespace.taskIndex !== undefined) {
			behavior = {
				...behavior,
				output: path.join(
					`parallel-${parallelOutputNamespace.stepIndex}`,
					`${parallelOutputNamespace.taskIndex}-${s.agent}`,
					behavior.output as string,
				),
			};
		}
		const namespaceOutputPath = Boolean(inheritedRelativeParallelOutput && parallelOutputNamespace.taskIndex === undefined);
		const skillNames = behavior.skills === false
			? []
			: typeof behavior.skills === "string"
				? [behavior.skills]
				: behavior.skills;
		const { resolved: resolvedSkills, missing: missingSkills } = resolveSkillsWithFallback(
			skillNames,
			stepCwd,
			ctx.cwd,
			a.skillPath,
			a.filePath ? path.dirname(a.filePath) : stepCwd,
		);
		if (missingSkills.includes("pi-subagents")) throw new UnavailableSubagentSkillError(UNAVAILABLE_SUBAGENT_SKILL_ERROR);

		let systemPrompt = a.systemPrompt?.trim() ?? "";
		if (resolvedSkills.length > 0) {
			const injection = buildSkillInjection(resolvedSkills);
			systemPrompt = systemPrompt ? `${systemPrompt}\n\n${injection}` : injection;
		}
		const memoryInjection = buildAgentMemoryInjection(a, stepCwd);
		if (memoryInjection) {
			systemPrompt = systemPrompt ? `${systemPrompt}\n\n${memoryInjection}` : memoryInjection;
		}

		const readInstructions = buildChainInstructions({ ...behavior, output: false, progress: false }, instructionCwd, false);
		const isFirstProgressAgent = behavior.progress && !progressPrecreated && !progressInstructionCreated;
		if (behavior.progress) progressInstructionCreated = true;
		const progressInstructions = buildChainInstructions({ ...behavior, output: false, reads: false }, progressDir, isFirstProgressAgent);
		const outputPath = resolveSingleOutputPath(behavior.output, ctx.cwd, instructionCwd, outputBaseDir);
		if (!namespaceOutputPath) systemPrompt = injectOutputPathSystemPrompt(systemPrompt, outputPath, a);
		const validationError = validateFileOnlyOutputMode(behavior.outputMode, outputPath, `Async step (${s.agent})`);
		if (validationError) throw new AsyncStartValidationError(validationError);
		let taskTemplate = s.task ?? "{previous}";
		taskTemplate = taskTemplate.replace(/\{task\}/g, originalTask ?? "");
		taskTemplate = taskTemplate.replace(/\{chain_dir\}/g, runnerCwd);
		const taskText = `${readInstructions.prefix}${taskTemplate}${progressInstructions.suffix}`;
		const task = namespaceOutputPath ? taskText : injectSingleOutputInstruction(taskText, outputPath, a);

		const primaryModel = resolveEffectiveSubagentModel(
			s.model,
			a.model,
			ctx.currentModel,
			availableModels,
			ctx.currentModelProvider,
			{ scope: ctx.modelScope },
		);
		const thinkingOverride = flatIndex === undefined ? undefined : thinkingOverridesByFlatIndex?.[flatIndex];
		const effectiveThinking = thinkingOverride ?? a.thinking;
		const model = applyThinkingSuffix(primaryModel, effectiveThinking, thinkingOverride !== undefined);
		const agentContract = s.agentContract ?? params.agentContract;
		return {
			parentSessionId: ctx.parentSessionId ?? ctx.currentSessionId,
			agent: s.agent,
			task,
			...(params.contextForAgent ? { context: params.contextForAgent(s.agent) } : {}),
			...(agentContract ? { agentContract } : {}),
			phase: s.phase,
			label: s.label,
			outputName: s.as,
			structured: Boolean(s.outputSchema),
			cwd: stepCwd,
			model,
			thinking: resolveEffectiveThinking(model, effectiveThinking),
			modelCandidates: buildModelCandidates(primaryModel, a.fallbackModels, availableModels, ctx.currentModelProvider, { scope: ctx.modelScope }).map((candidate) =>
				applyThinkingSuffix(candidate, effectiveThinking, thinkingOverride !== undefined) ?? candidate,
			),
			tools: a.tools,
			extensions: a.extensions,
			subagentOnlyExtensions: a.subagentOnlyExtensions,
			mcpDirectTools: a.mcpDirectTools,
			completionGuard: a.completionGuard,
			systemPrompt,
			systemPromptMode: a.systemPromptMode,
			inheritProjectContext: a.inheritProjectContext,
			inheritSkills: a.inheritSkills,
			skills: resolvedSkills.map((r) => r.name),
			outputPath,
			...(namespaceOutputPath ? { namespaceOutputPath: true } : {}),
			outputMode: behavior.outputMode,
			sessionFile,
			maxSubagentDepth: resolveChildMaxSubagentDepth(maxSubagentDepth, a.maxSubagentDepth),
			waitToolEnabled: params.waitToolEnabled,
			effectiveAcceptance: resolveEffectiveAcceptance({
				explicit: s.acceptance,
				agentName: s.agent,
				acceptanceRole: a.acceptanceRole,
				task,
				mode: resultMode,
				async: true,
				dynamic: false,
				agentContract,
			}),
			acceptanceInput: s.acceptance,
			acceptanceRole: a.acceptanceRole,
			...(s.gateOn ? { gateOn: s.gateOn } : {}),
			...(s.outputSchema ? { structuredOutputSchema: s.outputSchema } : {}),
			...(s.outputSchema ? { structuredOutput: createStructuredOutputRuntime(s.outputSchema, path.join(asyncDir, "structured-output")) } : {}),
			...(resolvedToolBudget.budget ? { toolBudget: resolvedToolBudget.budget } : {}),
		};
	};

	let flatStepIndex = 0;
	const nextFlatStep = (): { index: number; sessionFile?: string; thinkingOverride?: AgentConfig["thinking"] } => {
		const index = flatStepIndex;
		const sessionFile = sessionFilesByFlatIndex?.[flatStepIndex];
		const thinkingOverride = thinkingOverridesByFlatIndex?.[flatStepIndex];
		flatStepIndex++;
		return {
			index,
			...(sessionFile ? { sessionFile } : {}),
			...(thinkingOverride ? { thinkingOverride } : {}),
		};
	};

	try {
		const builtSteps = chain.map((s, stepIndex) => {
			if (isParallelStep(s)) {
				const parallelBehaviors = s.parallel.map((task) => {
					const agent = agents.find((candidate) => candidate.name === task.agent)!;
					return suppressProgressForReadOnlyTask(resolveStepBehavior(agent, buildStepOverrides(task), chainSkills), task.task, originalTask);
				});
				const progressPrecreated = parallelBehaviors.some((behavior) => behavior.progress);
				if (progressPrecreated) {
					if (!s.worktree || params.progressDir) writeInitialProgressFile(progressDir);
					progressInstructionCreated = true;
				}
				return {
					parallel: s.parallel.map((t, taskIndex) => {
						let behaviorCwd: string | undefined;
						if (s.worktree) {
							try {
								behaviorCwd = resolveExpectedWorktreeAgentCwd(runnerCwd, `${id}-s${stepIndex}`, taskIndex, worktreeBaseDir);
							} catch {
								behaviorCwd = undefined;
							}
						}
						const staticStep = nextFlatStep();
						return buildSeqStep({ ...t, agentContract: t.agentContract ?? s.agentContract, gateOn: t.gateOn ?? s.gateOn }, staticStep.sessionFile, behaviorCwd, progressPrecreated, parallelBehaviors[taskIndex], staticStep.index, { stepIndex, taskIndex });
					}),
					concurrency: s.concurrency,
					failFast: s.failFast,
					worktree: s.worktree,
				};
			}
			if (isDynamicParallelStep(s)) {
				const agent = agents.find((candidate) => candidate.name === s.parallel.agent)!;
				const behavior = suppressProgressForReadOnlyTask(resolveStepBehavior(agent, buildStepOverrides(s.parallel), chainSkills), s.parallel.task, originalTask);
				const progressPrecreated = behavior.progress;
				if (progressPrecreated) {
					writeInitialProgressFile(progressDir);
					progressInstructionCreated = true;
				}
				const maxItems = s.expand.maxItems ?? params.dynamicFanoutMaxItems ?? 0;
				const dynamicFlatSteps = Array.from({ length: maxItems }, () => nextFlatStep());
				const parallel = buildSeqStep({ ...(s.parallel as SequentialStep), agentContract: s.parallel.agentContract ?? s.agentContract, gateOn: s.parallel.gateOn ?? s.gateOn }, undefined, undefined, progressPrecreated, behavior, undefined, { stepIndex });
				return {
					expand: s.expand,
					parallel,
					collect: s.collect,
					concurrency: s.concurrency,
					failFast: s.failFast,
					phase: s.phase,
					label: s.label,
					sessionFiles: dynamicFlatSteps.map((step) => step.sessionFile),
					thinkingOverrides: dynamicFlatSteps.map((step) => step.thinkingOverride),
					effectiveAcceptance: resolveEffectiveAcceptance({
						explicit: s.acceptance,
						agentName: s.parallel.agent,
						acceptanceRole: agent.acceptanceRole,
						task: parallel.task,
						mode: resultMode,
						async: true,
						dynamicGroup: true,
						agentContract: s.agentContract ?? params.agentContract,
					}),
					acceptanceInput: s.acceptance,
					acceptanceRole: agent.acceptanceRole,
					...(s.agentContract ?? params.agentContract ? { agentContract: s.agentContract ?? params.agentContract } : {}),
					...(s.gateOn ? { gateOn: s.gateOn } : {}),
				};
			}
			const staticStep = nextFlatStep();
			return buildSeqStep(s as SequentialStep, staticStep.sessionFile, undefined, false, undefined, staticStep.index);
		});
		const steps = (params.attachRoot
			? [{
					agent: params.attachRoot.agent,
					task: "",
					label: params.attachRoot.label ?? `Attached root ${params.attachRoot.runId}`,
					outputName: params.attachRoot.outputName,
					importAsyncRoot: {
						runId: params.attachRoot.runId,
						asyncDir: params.attachRoot.asyncDir,
						resultPath: params.attachRoot.resultPath,
						index: params.attachRoot.index,
					},
					inheritProjectContext: false,
					inheritSkills: false,
				}, ...builtSteps]
			: builtSteps) as RunnerStep[];
		for (const step of steps) {
			if (!("parallel" in step) || !Array.isArray(step.parallel)) continue;
			const seen = new Map<string, { index: number; agent: string }>();
			for (let index = 0; index < step.parallel.length; index++) {
				const task = step.parallel[index]!;
				if (!task.outputPath) continue;
				const previous = seen.get(task.outputPath);
				if (previous) {
					throw new AsyncStartValidationError(`Parallel tasks ${previous.index + 1} (${previous.agent}) and ${index + 1} (${task.agent}) resolve output to the same path: ${task.outputPath}. Use distinct output paths.`);
				}
				seen.set(task.outputPath, { index, agent: task.agent });
			}
		}
		return { steps, runnerCwd, workflowGraph, eventChain: graphChain, ...(originalTask !== undefined ? { originalTask } : {}) };
	} catch (error) {
		if (error instanceof UnavailableSubagentSkillError || error instanceof AsyncStartValidationError) return { error: error.message };
		throw error;
	}
}

/**
 * Execute a chain asynchronously
 */
export function executeAsyncChain(
	id: string,
	params: AsyncChainParams,
): AsyncExecutionResult {
	const {
		chain,
		agents,
		ctx,
		cwd,
		maxOutput,
		artifactsDir,
		artifactConfig,
		shareEnabled,
		sessionRoot,
		sessionFilesByFlatIndex,
		thinkingOverridesByFlatIndex,
		maxSubagentDepth,
		worktreeSetupHook,
		worktreeSetupHookTimeoutMs,
		worktreeBaseDir,
		controlConfig,
		controlIntercomTarget,
		childIntercomTarget,
		nestedRoute,
	} = params;
	const resultMode = params.resultMode ?? "chain";
	const inheritedNestedRoute = resolveInheritedNestedRouteFromEnv();
	const nestedAddress = inheritedNestedRoute ? resolveNestedParentAddressFromEnv() : undefined;
	const asyncDir = inheritedNestedRoute
		? path.join(TEMP_ROOT_DIR, "nested-subagent-runs", inheritedNestedRoute.rootRunId, id)
		: path.join(ASYNC_DIR, id);
	try {
		fs.mkdirSync(asyncDir, { recursive: true });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			content: [{ type: "text", text: `Failed to create async run directory '${asyncDir}': ${message}` }],
			isError: true,
			details: { mode: resultMode, results: [] },
		};
	}

	const built = buildAsyncRunnerSteps(id, {
		chain,
		task: params.task,
		attachRoot: params.attachRoot,
		resultMode,
		agents,
		ctx,
		availableModels: params.availableModels,
		cwd,
		chainSkills: params.chainSkills,
		sessionFilesByFlatIndex,
		thinkingOverridesByFlatIndex,
		contextForAgent: params.contextForAgent,
		progressDir: params.progressDir ?? (artifactsDir ? path.join(artifactsDir, "progress", id) : resultMode === "parallel" ? path.join(asyncDir, "progress") : undefined),
		agentContract: params.agentContract,
		outputBaseDir: artifactsDir ? path.join(artifactsDir, "outputs", id) : undefined,
		dynamicFanoutMaxItems: params.dynamicFanoutMaxItems,
		maxSubagentDepth,
		waitToolEnabled: params.waitToolEnabled,
		worktreeBaseDir,
		asyncDir,
		toolBudget: params.toolBudget,
		configToolBudget: params.configToolBudget,
	});
	if ("error" in built) {
		try {
			fs.rmSync(asyncDir, { recursive: true, force: true });
		} catch {
			// Best-effort cleanup for validation failures before the runner is spawned.
		}
		return formatAsyncStartError(resultMode, built.error);
	}
	const { steps, runnerCwd, workflowGraph, eventChain } = built;
	const deadlineAt = params.timeoutMs !== undefined ? Date.now() + params.timeoutMs : undefined;
	const initialTurnBudget = params.turnBudget ? initialTurnBudgetState(params.turnBudget) : undefined;
	let childTargetIndex = 0;
	const childIntercomTargets = childIntercomTarget ? steps.flatMap((step) => {
		if (!("parallel" in step) && step.importAsyncRoot) {
			childTargetIndex++;
			return [undefined];
		}
		if ("parallel" in step) {
			if (!Array.isArray(step.parallel)) {
				childTargetIndex++;
				return [undefined];
			}
			return step.parallel.map((task) => childIntercomTarget(task.agent, childTargetIndex++));
		}
		return [childIntercomTarget(step.agent, childTargetIndex++)];
	}) : undefined;

	// Programmatic branch: use SubagentRuntime instead of detached CLI runner
	if (params.subagentRuntime) {
		const resultPath = inheritedNestedRoute ? nestedResultsPath(inheritedNestedRoute.rootRunId, id) : path.join(RESULTS_DIR, `${id}.json`);
		const eventsPath = path.join(asyncDir, "events.jsonl");
		const now = Date.now();
		const hasDynamicFanout = steps.some((s) => isDynamicRunnerGroup(s));
		if (hasDynamicFanout) {
			return formatAsyncStartError(resultMode, "Dynamic fanout not yet supported in async programmatic mode.");
		}
		const { agents: flatAgentsProg, parallelGroups: parallelGroupsProg } = flattenProgrammaticSteps(steps);
		writeAtomicJson(path.join(asyncDir, "status.json"), {
			lifecycleArtifactVersion: SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
			runId: id,
			sessionId: ctx.currentSessionId,
			mode: resultMode,
			state: "running",
			startedAt: now,
			lastUpdate: now,
			asyncDir,
			cwd: runnerCwd,
			chainStepCount: eventChain.length,
			currentStep: 0,
			parallelGroups: parallelGroupsProg,
			steps: flatAgentsProg.map((agent, index) => ({ index, agent, status: "pending" as const })),
		});
		// Fire-and-forget consumer
		consumeAsyncChainRun(params.subagentRuntime, id, steps, {
			resultMode,
			asyncDir,
			resultPath,
			eventsPath,
			runnerCwd,
			sessionId: ctx.currentSessionId,
		}).catch((error) => {
			const errMsg = error instanceof Error ? error.message : String(error);
			const latestStatus = readStatus(asyncDir) ?? { runId: id, mode: resultMode, state: "running" as const, startedAt: now, lastUpdate: now };
			latestStatus.state = "failed";
			(latestStatus as unknown as Record<string, unknown>).error = errMsg;
			(latestStatus as unknown as Record<string, unknown>).endedAt = Date.now();
			(latestStatus as unknown as Record<string, unknown>).lastUpdate = Date.now();
			writeAtomicJson(path.join(asyncDir, "status.json"), latestStatus);
			writeAtomicJson(resultPath, {
				lifecycleArtifactVersion: SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
				state: "failed",
				error: errMsg,
				id,
				mode: resultMode,
				success: false,
				asyncDir,
				sessionId: ctx.currentSessionId,
			});
		});
		// Emit started events (same as CLI path but without pid)
		const eventFirstStep = eventChain[0];
		const firstAgents = isParallelStep(eventFirstStep)
			? eventFirstStep.parallel.map((t) => t.agent)
			: isDynamicParallelStep(eventFirstStep)
				? [eventFirstStep.parallel.agent]
				: [(eventFirstStep as SequentialStep).agent];
		const firstTask = isParallelStep(eventFirstStep)
			? eventFirstStep.parallel[0]?.task
			: isDynamicParallelStep(eventFirstStep)
				? eventFirstStep.parallel.task
				: (eventFirstStep as SequentialStep).task;
		const workflowGoal = params.goal ?? (params.task?.trim() || firstTask);
		if (inheritedNestedRoute && nestedAddress) {
			try {
				writeNestedEvent(inheritedNestedRoute, {
					type: "subagent.nested.started",
					ts: now,
					parentRunId: nestedAddress.parentRunId,
					parentStepIndex: nestedAddress.parentStepIndex,
					child: {
						id,
						parentRunId: nestedAddress.parentRunId,
						parentStepIndex: nestedAddress.parentStepIndex,
						depth: nestedAddress.depth,
						path: nestedAddress.path,
						asyncDir,
						ownerIntercomTarget: process.env.PI_SUBAGENT_INTERCOM_SESSION_NAME,
						leafIntercomTarget: childIntercomTargets?.[0],
						intercomTarget: childIntercomTargets?.[0],
						ownerState: "live",
						mode: resultMode,
						state: "running",
						agent: firstAgents[0],
						agents: flatAgentsProg,
						chainStepCount: eventChain.length,
						parallelGroups: parallelGroupsProg,
						...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs, deadlineAt } : {}),
						...(initialTurnBudget ? { turnBudget: initialTurnBudget } : {}),
						startedAt: now,
						lastUpdate: now,
					},
				});
			} catch (error) {
				console.error("Failed to emit nested async start event:", error);
			}
		}
		ctx.pi.events.emit(SUBAGENT_ASYNC_STARTED_EVENT, {
			lifecycleArtifactVersion: SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
			id,
			sessionId: ctx.currentSessionId,
			mode: resultMode,
			agent: firstAgents[0],
			agents: flatAgentsProg,
			task: firstTask?.slice(0, 50),
			goal: workflowGoal?.slice(0, 120),
			chain: eventChain.map((s) =>
				isParallelStep(s) ? `[${s.parallel.map((t) => t.agent).join("+")}]` : isDynamicParallelStep(s) ? `expand:${s.parallel.agent}` : (s as SequentialStep).agent,
			),
			chainStepCount: eventChain.length,
			parallelGroups: parallelGroupsProg,
			workflowGraph,
			cwd: runnerCwd,
			asyncDir,
			...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs, deadlineAt } : {}),
			...(initialTurnBudget ? { turnBudget: initialTurnBudget } : {}),
			nestedRoute,
		});
		const chainDesc = chain
			.map((s) =>
				isParallelStep(s) ? `[${s.parallel.map((t) => t.agent).join("+")}]` : isDynamicParallelStep(s) ? `expand:${s.parallel.agent}` : (s as SequentialStep).agent,
			)
			.join(" -> ");
		return {
			content: [{ type: "text", text: formatAsyncStartedMessage(`Async ${resultMode}: ${chainDesc} [${id}]`, ctx.interactive === true) }],
			details: { mode: resultMode, runId: id, results: [], asyncId: id, asyncDir, workflowGraph, ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs, deadlineAt } : {}), ...(params.turnBudget ? { turnBudget: params.turnBudget } : {}), ...(params.toolBudget ? { toolBudget: params.toolBudget } : {}) },
		};
	}


	const chainDesc = chain
		.map((s) =>
			isParallelStep(s) ? `[${s.parallel.map((t) => t.agent).join("+")}]` : isDynamicParallelStep(s) ? `expand:${s.parallel.agent}` : (s as SequentialStep).agent,
		)
		.join(" -> ");

	return {
		content: [{ type: "text", text: formatAsyncStartedMessage(`Async ${resultMode}: ${chainDesc} [${id}]`, ctx.interactive === true) }],
		details: { mode: resultMode, runId: id, results: [], asyncId: id, asyncDir, workflowGraph, ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs, deadlineAt } : {}), ...(params.turnBudget ? { turnBudget: params.turnBudget } : {}), ...(params.toolBudget ? { toolBudget: params.toolBudget } : {}) },
	};
}

/**
 * Execute a single agent asynchronously
 */
export function executeAsyncSingle(
	id: string,
	params: AsyncSingleParams,
): AsyncExecutionResult {
	const {
		agent,
		agentConfig,
		ctx,
		cwd,
		maxOutput,
		artifactsDir,
		artifactConfig,
		shareEnabled,
		sessionRoot,
		sessionFile,
		maxSubagentDepth,
		worktreeSetupHook,
		worktreeSetupHookTimeoutMs,
		worktreeBaseDir,
		controlConfig,
		controlIntercomTarget,
		childIntercomTarget,
		nestedRoute,
	} = params;
	const task = params.task ?? "";
	const runnerCwd = resolveChildCwd(ctx.cwd, cwd);
	const skillNames = params.skills ?? agentConfig.skills ?? [];
	const availableModels = params.availableModels;
	const { resolved: resolvedSkills, missing: missingSkills } = resolveSkillsWithFallback(
		skillNames,
		runnerCwd,
		ctx.cwd,
		agentConfig.skillPath,
		agentConfig.filePath ? path.dirname(agentConfig.filePath) : runnerCwd,
	);
	if (missingSkills.includes("pi-subagents")) return formatAsyncStartError("single", UNAVAILABLE_SUBAGENT_SKILL_ERROR);
	let systemPrompt = agentConfig.systemPrompt?.trim() ?? "";
	if (resolvedSkills.length > 0) {
		const injection = buildSkillInjection(resolvedSkills);
		systemPrompt = systemPrompt ? `${systemPrompt}\n\n${injection}` : injection;
	}
	const memoryInjection = buildAgentMemoryInjection(agentConfig, runnerCwd);
	if (memoryInjection) {
		systemPrompt = systemPrompt ? `${systemPrompt}\n\n${memoryInjection}` : memoryInjection;
	}

	const inheritedNestedRoute = resolveInheritedNestedRouteFromEnv();
	const nestedAddress = inheritedNestedRoute ? resolveNestedParentAddressFromEnv() : undefined;
	const asyncDir = inheritedNestedRoute
		? path.join(TEMP_ROOT_DIR, "nested-subagent-runs", inheritedNestedRoute.rootRunId, id)
		: path.join(ASYNC_DIR, id);
	try {
		fs.mkdirSync(asyncDir, { recursive: true });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			content: [{ type: "text", text: `Failed to create async run directory '${asyncDir}': ${message}` }],
			isError: true,
			details: { mode: "single" as const, results: [] },
		};
	}

	const effectiveOutput = normalizeSingleOutputOverride(params.output, agentConfig.output);
	const outputPath = resolveSingleOutputPath(effectiveOutput, ctx.cwd, runnerCwd, params.outputBaseDir ?? (artifactsDir ? path.join(artifactsDir, "outputs", id) : undefined));
	systemPrompt = injectOutputPathSystemPrompt(systemPrompt, outputPath, agentConfig);
	const outputMode = params.outputMode ?? "inline";
	const validationError = validateFileOnlyOutputMode(outputMode, outputPath, `Async single run (${agent})`);
	if (validationError) return formatAsyncStartError("single", validationError);
	const taskWithOutputInstruction = injectSingleOutputInstruction(task, outputPath, agentConfig);
	const primaryModel = resolveSubagentModelOverride(
		params.modelOverride ?? agentConfig.model,
		ctx.currentModel,
		availableModels,
		ctx.currentModelProvider,
	);
	const effectiveThinking = params.thinkingOverride ?? agentConfig.thinking;
	const model = applyThinkingSuffix(primaryModel, effectiveThinking, params.thinkingOverride !== undefined);
	const toolBudgetInput = params.toolBudget ?? agentConfig.toolBudget ?? params.configToolBudget;
	const resolvedToolBudget = validateToolBudgetConfig(toolBudgetInput, params.toolBudget ? "toolBudget" : agentConfig.toolBudget ? "agent.toolBudget" : "config.toolBudget");
	if (resolvedToolBudget.error) return formatAsyncStartError("single", resolvedToolBudget.error);
	const deadlineAt = params.absoluteDeadlineAt ?? (params.timeoutMs !== undefined ? Date.now() + params.timeoutMs : undefined);
	const timeoutMs = params.absoluteDeadlineAt !== undefined && deadlineAt !== undefined
		? deadlineAt - Date.now()
		: params.timeoutMs;
	if (timeoutMs !== undefined && timeoutMs <= 0) return formatAsyncStartError("single", "The source run's absolute deadline expired before recovery could launch.");
	const initialTurnBudget = params.turnBudget ? initialTurnBudgetState(params.turnBudget) : undefined;
	const resolvedSessionDir = params.sessionDir ?? (sessionRoot ? path.join(sessionRoot, `async-${id}`) : undefined);
	const structuredOutput = params.structuredOutputSchema
		? createStructuredOutputRuntime(params.structuredOutputSchema, path.join(asyncDir, "structured-output"))
		: undefined;
	const resolvedAcceptance = resolveEffectiveAcceptance({
		explicit: params.acceptance,
		agentName: agent,
		acceptanceRole: agentConfig.acceptanceRole,
		task,
		mode: "single",
		async: true,
		agentContract: params.agentContract,
	});
	const recoveryDescriptor: SteeringRecoveryDescriptor = {
		version: 1,
		sourceRunId: id,
		...(params.agentContract ? { agentContract: params.agentContract } : {}),
		agent,
		...(sessionFile ? { sessionFile } : {}),
		cwd: runnerCwd,
		...(model ? { model } : {}),
		...(agentConfig.fallbackModels ? { fallbackModels: [...agentConfig.fallbackModels] } : {}),
		...(effectiveThinking ? { thinking: resolveEffectiveThinking(model, effectiveThinking) } : {}),
		...(agentConfig.tools ? { tools: [...agentConfig.tools] } : {}),
		...(agentConfig.extensions ? { extensions: [...agentConfig.extensions] } : {}),
		...(agentConfig.subagentOnlyExtensions ? { subagentOnlyExtensions: [...agentConfig.subagentOnlyExtensions] } : {}),
		...(agentConfig.mcpDirectTools ? { mcpDirectTools: [...agentConfig.mcpDirectTools] } : {}),
		...(agentConfig.systemPrompt ? { systemPrompt: agentConfig.systemPrompt } : {}),
		systemPromptMode: agentConfig.systemPromptMode,
		inheritProjectContext: agentConfig.inheritProjectContext,
		inheritSkills: agentConfig.inheritSkills,
		...(resolvedSkills.length ? { skills: resolvedSkills.map((skill) => skill.name) } : {}),
		...(agentConfig.skillPath ? { skillPath: [...agentConfig.skillPath] } : {}),
		...(agentConfig.filePath ? { agentFilePath: agentConfig.filePath } : {}),
		...(agentConfig.completionGuard !== undefined ? { completionGuard: agentConfig.completionGuard } : {}),
		...(agentConfig.memory ? { memory: { ...agentConfig.memory } } : {}),
		...(outputPath ? { outputPath } : {}),
		outputMode,
		...(params.structuredOutputSchema ? { structuredOutputSchema: params.structuredOutputSchema } : {}),
		...(params.acceptance !== undefined ? { acceptance: params.acceptance } : {}),
		...(controlConfig ? { controlConfig } : {}),
		...(deadlineAt !== undefined ? { absoluteDeadlineAt: deadlineAt } : {}),
		...(params.turnBudget ? { initialTurnBudget: params.turnBudget } : {}),
		...(resolvedToolBudget.budget ? { initialToolBudget: resolvedToolBudget.budget } : {}),
		maxSubagentDepth: resolveChildMaxSubagentDepth(maxSubagentDepth, agentConfig.maxSubagentDepth),
		...(maxOutput ? { maxOutput } : {}),
		share: shareEnabled,
		...(resolvedSessionDir ? { sessionDir: resolvedSessionDir } : {}),
		...(artifactsDir ? { artifactsDir } : {}),
		artifactConfig,
	};
	try {
		writePrivateAtomicJson(path.join(asyncDir, "recovery-descriptor.json"), recoveryDescriptor);
	} catch (error) {
		return formatAsyncStartError("single", `Failed to persist async recovery descriptor for '${id}': ${error instanceof Error ? error.message : String(error)}`);
	}

	// Programmatic branch: use SubagentRuntime instead of detached CLI runner
	if (params.subagentRuntime) {
		const resultPath = inheritedNestedRoute ? nestedResultsPath(inheritedNestedRoute.rootRunId, id) : path.join(RESULTS_DIR, `${id}.json`);
		const eventsPath = path.join(asyncDir, "events.jsonl");
		const now = Date.now();
		// Write initial status so async-job-tracker discovers the run
		writeAtomicJson(path.join(asyncDir, "status.json"), {
			lifecycleArtifactVersion: SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
			runId: id,
			sessionId: ctx.currentSessionId,
			mode: "single" as const,
			state: "running" as const,
			startedAt: now,
			lastUpdate: now,
			asyncDir,
			cwd: runnerCwd,
			chainStepCount: 1,
			currentStep: 0,
			steps: [{ index: 0, agent, status: "running" as const, startedAt: now }],
		});
		// Build the programmatic run request
		const request: SubagentRuntimeRunRequest = {
			runId: id,
			rootRunId: id,
			childIndex: 0,
			depth: 1,
			maxDepth: Math.max(1, resolveChildMaxSubagentDepth(maxSubagentDepth, agentConfig.maxSubagentDepth)),
			lineage: [],
			agent,
			task: taskWithOutputInstruction,
			cwd: runnerCwd,
			...(sessionFile ? { sessionFile } : {}),
			...(resolvedSessionDir ? { sessionDir: resolvedSessionDir } : {}),
			persistSession: Boolean(resolvedSessionDir || sessionFile || shareEnabled),
			...(model ? { model } : {}),
			...(ctx.currentModelProvider ? { preferredProvider: ctx.currentModelProvider } : {}),
			...(effectiveThinking ? { thinking: resolveEffectiveThinking(model, effectiveThinking) as SubagentRuntimeRunRequest["thinking"] } : {}),
			...(agentConfig.tools ? { tools: agentConfig.tools } : {}),
			...(systemPrompt ? { systemPrompt } : {}),
			systemPromptMode: agentConfig.systemPromptMode,
			inheritProjectContext: agentConfig.inheritProjectContext,
			inheritSkills: agentConfig.inheritSkills,
			extensionProfile: (agentConfig.extensions?.includes("pi-subagents") ? ["provider" as SubagentExtensionProfile, "runtime" as SubagentExtensionProfile, "fanout" as SubagentExtensionProfile] : ["provider" as SubagentExtensionProfile, "runtime" as SubagentExtensionProfile]),
			...(timeoutMs !== undefined ? { timeoutMs } : {}),
			...(params.turnBudget ? { turnBudget: params.turnBudget } : {}),
			...(resolvedToolBudget.budget ? { toolBudget: resolvedToolBudget.budget } : {}),
		};
		// Fire-and-forget consumer writes events + final result to filesystem
		consumeAsyncSingleRun(params.subagentRuntime, request, {
			asyncDir,
			resultPath,
			eventsPath,
			resultMode: "single",
			runnerCwd,
			sessionId: ctx.currentSessionId,
		}).catch((error) => {
			console.error(`Async single run '${id}' consumer failed:`, error);
			const failedStatus = readStatus(asyncDir) ?? { runId: id, mode: "single" as const, state: "running" as const, startedAt: now, lastUpdate: now };
			failedStatus.state = "failed";
			failedStatus.error = `Background consumer error: ${error instanceof Error ? error.message : String(error)}`;
			failedStatus.endedAt = Date.now();
			failedStatus.lastUpdate = Date.now();
			writeAtomicJson(path.join(asyncDir, "status.json"), failedStatus);
			writeAtomicJson(resultPath, {
				lifecycleArtifactVersion: SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
				state: "failed",
				error: failedStatus.error,
				id,
				agent,
				mode: "single",
				success: false,
				asyncDir,
				sessionId: ctx.currentSessionId,
			});
		});
		// Emit started event immediately
		if (inheritedNestedRoute && nestedAddress) {
			try {
				writeNestedEvent(inheritedNestedRoute, {
					type: "subagent.nested.started",
					ts: now,
					parentRunId: nestedAddress.parentRunId,
					parentStepIndex: nestedAddress.parentStepIndex,
					child: {
						id,
						parentRunId: nestedAddress.parentRunId,
						parentStepIndex: nestedAddress.parentStepIndex,
						depth: nestedAddress.depth,
						path: nestedAddress.path,
						asyncDir,
						ownerIntercomTarget: process.env.PI_SUBAGENT_INTERCOM_SESSION_NAME,
						leafIntercomTarget: childIntercomTarget?.(agent, 0),
						intercomTarget: childIntercomTarget?.(agent, 0),
						ownerState: "live",
						mode: "single",
						state: "running",
						agent,
						agents: [agent],
						chainStepCount: 1,
						...(timeoutMs !== undefined ? { timeoutMs, deadlineAt } : {}),
						...(initialTurnBudget ? { turnBudget: initialTurnBudget } : {}),
						startedAt: now,
						lastUpdate: now,
					},
				});
			} catch (error) {
				console.error("Failed to emit nested async start event:", error);
			}
		}
		ctx.pi.events.emit(SUBAGENT_ASYNC_STARTED_EVENT, {
			lifecycleArtifactVersion: SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
			id,
			sessionId: ctx.currentSessionId,
			mode: "single",
			agent,
			task: task?.slice(0, 50),
			goal: (params.goal ?? task).slice(0, 120),
			cwd: runnerCwd,
			asyncDir,
			...(timeoutMs !== undefined ? { timeoutMs, deadlineAt } : {}),
			...(initialTurnBudget ? { turnBudget: initialTurnBudget } : {}),
			nestedRoute,
		});
		return {
			content: [{ type: "text", text: formatAsyncStartedMessage(`Async: ${agent} [${id}]`, ctx.interactive === true) }],
			details: { mode: "single", runId: id, results: [], asyncId: id, asyncDir, ...(params.context ? { context: params.context } : {}), ...(timeoutMs !== undefined ? { timeoutMs, deadlineAt } : {}), ...(params.turnBudget ? { turnBudget: params.turnBudget } : {}), ...(params.toolBudget ? { toolBudget: params.toolBudget } : {}) },
		};
	}

	return {
		content: [{ type: "text", text: formatAsyncStartedMessage(`Async: ${agent} [${id}]`, ctx.interactive === true) }],
		details: { mode: "single", runId: id, results: [], asyncId: id, asyncDir, ...(params.context ? { context: params.context } : {}), ...(timeoutMs !== undefined ? { timeoutMs, deadlineAt } : {}), ...(params.turnBudget ? { turnBudget: params.turnBudget } : {}), ...(params.toolBudget ? { toolBudget: params.toolBudget } : {}) },
	};
}


async function consumeAsyncSingleRun(
	runtime: SubagentRuntime,
	request: SubagentRuntimeRunRequest,
	options: ConsumeAsyncChainOptions,
): Promise<void> {
	const { asyncDir, resultPath, eventsPath, runnerCwd, sessionId } = options;
	const statusPath = path.join(asyncDir, "status.json");
	const startedAt = Date.now();
	let output = "";
	let sessionFile = request.sessionFile;
	let terminalSeen = false;
	let stopRequested = false;
	let interrupted = false;
	const pollController = new AbortController();
	const cancel = (state: "stopped" | "paused"): void => {
		stopRequested ||= state === "stopped";
		interrupted ||= state === "paused";
		void runtime.cancel(request.runId, request.childIndex);
		pollController.abort();
	};
	const pollPromise = runControlPollLoop(asyncDir, pollController.signal, {
		onSteer: (steerRequest) => routeProgrammaticSteer(runtime, asyncDir, steerRequest, [request]),
		onStop: () => cancel("stopped"),
		onInterrupt: () => cancel("paused"),
	});

	try {
		for await (const event of runtime.run(request)) {
			appendJsonl(eventsPath, JSON.stringify(event));
			const text = assistantOutput(event);
			if (text) output = text;
			if (event.type === "completed") {
				terminalSeen = true;
				sessionFile = event.sessionFile ?? sessionFile;
				break;
			}
			if (event.type === "failed") {
				terminalSeen = true;
				sessionFile = event.sessionFile ?? sessionFile;
				throw new Error(event.error);
			}
		}
		if (!terminalSeen) throw new Error("Subagent event stream ended without a terminal event.");
		const endedAt = Date.now();
		writeProgrammaticStatus(asyncDir, {
			state: "complete",
			endedAt,
			lastUpdate: endedAt,
			currentStep: 1,
			steps: [{ index: 0, agent: request.agent, status: "completed", startedAt, endedAt, sessionFile }],
		});
		writeAtomicJson(resultPath, {
			lifecycleArtifactVersion: SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
			id: request.runId,
			runId: request.runId,
			sessionId,
			agent: request.agent,
			mode: "single",
			success: true,
			state: "complete",
			summary: output || `Async run ${request.runId} completed.`,
			results: [{ agent: request.agent, output, success: true, sessionFile }],
			sessionFile,
			cwd: runnerCwd,
			asyncDir,
			startedAt,
			endedAt,
		});
	} catch (error) {
		const endedAt = Date.now();
		const state = stopRequested ? "stopped" : interrupted ? "paused" : "failed";
		const message = stopRequested
			? "Async run stopped by user."
			: interrupted
				? "Async run interrupted."
				: error instanceof Error
					? error.message
					: String(error);
		writeProgrammaticStatus(asyncDir, {
			state,
			error: message,
			endedAt,
			lastUpdate: endedAt,
			steps: [{ index: 0, agent: request.agent, status: state, startedAt, endedAt, error: message, sessionFile }],
		});
		writeAtomicJson(resultPath, {
			lifecycleArtifactVersion: SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
			id: request.runId,
			runId: request.runId,
			sessionId,
			agent: request.agent,
			mode: "single",
			success: false,
			state,
			error: message,
			summary: output || message,
			results: [{ agent: request.agent, output, success: false, error: message, state, sessionFile }],
			sessionFile,
			cwd: runnerCwd,
			asyncDir,
			startedAt,
			endedAt,
		});
	} finally {
		pollController.abort();
		closeSteerInbox(asyncDir, readStatus(asyncDir)?.state ?? "failed");
		try {
			await pollPromise;
		} catch {
			// Control polling is best effort after the terminal result is durable.
		}
	}
}

interface ConsumeAsyncChainOptions {
	resultMode: string;
	asyncDir: string;
	resultPath: string;
	eventsPath: string;
	runnerCwd: string;
	sessionId: string;
}

interface ProgrammaticLeafResult {
	agent: string;
	index: number;
	output: string;
	success: boolean;
	error?: string;
	cancelled?: boolean;
	sessionFile?: string;
}

function runnerStepToRequest(
	step: RunnerSubagentStep,
	runId: string,
	childIndex: number,
	cwd: string,
): SubagentRuntimeRunRequest {
	return {
		runId,
		rootRunId: runId,
		childIndex,
		depth: 1,
		maxDepth: Math.max(1, step.maxSubagentDepth ?? 1),
		lineage: [],
		agent: step.agent,
		task: step.task,
		cwd: step.cwd ?? cwd,
		...(step.model ? { model: step.model } : {}),
		...(step.thinking ? { thinking: step.thinking as SubagentRuntimeRunRequest["thinking"] } : {}),
		...(step.tools && step.tools.length > 0 ? { tools: step.tools } : {}),
		...(step.systemPrompt ? { systemPrompt: step.systemPrompt } : {}),
		systemPromptMode: step.systemPromptMode ?? "append",
		inheritProjectContext: step.inheritProjectContext,
		inheritSkills: step.inheritSkills,
		...(step.sessionFile ? { sessionFile: step.sessionFile } : {}),
		persistSession: Boolean(step.sessionFile),
		extensionProfile: step.tools?.includes("subagent")
			? ["provider", "runtime", "fanout"]
			: ["provider", "runtime"],
		...(step.toolBudget ? { toolBudget: step.toolBudget } : {}),
	};
}

async function consumeLeafRun(
	runtime: SubagentRuntime,
	request: SubagentRuntimeRunRequest,
	eventsPath: string,
	signal: AbortSignal,
): Promise<ProgrammaticLeafResult> {
	let output = "";
	let sessionFile = request.sessionFile;
	const cancel = (): void => {
		void runtime.cancel(request.runId, request.childIndex);
	};
	if (signal.aborted) {
		return {
			agent: request.agent,
			index: request.childIndex,
			output,
			success: false,
			error: "Run aborted before start.",
			cancelled: true,
		};
	}
	signal.addEventListener("abort", cancel, { once: true });
	try {
		for await (const event of runtime.run(request)) {
			appendJsonl(eventsPath, JSON.stringify(event));
			const text = assistantOutput(event);
			if (text) output = text;
			if (event.type === "failed") {
				sessionFile = event.sessionFile ?? sessionFile;
				return {
					agent: request.agent,
					index: request.childIndex,
					output,
					success: false,
					error: event.error,
					cancelled: signal.aborted,
					sessionFile,
				};
			}
			if (event.type === "completed") {
				sessionFile = event.sessionFile ?? sessionFile;
				return { agent: request.agent, index: request.childIndex, output, success: true, sessionFile };
			}
		}
		return {
			agent: request.agent,
			index: request.childIndex,
			output,
			success: false,
			error: "Subagent event stream ended without a terminal event.",
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			agent: request.agent,
			index: request.childIndex,
			output,
			success: false,
			error: message,
			cancelled: signal.aborted || /abort|cancel|disposed/i.test(message),
			sessionFile,
		};
	} finally {
		signal.removeEventListener("abort", cancel);
	}
}

async function consumeAsyncChainRun(
	runtime: SubagentRuntime,
	id: string,
	steps: RunnerStep[],
	options: ConsumeAsyncChainOptions,
): Promise<void> {
	const { asyncDir, resultPath, eventsPath, runnerCwd, resultMode, sessionId } = options;
	const startedAt = Date.now();
	const results: ProgrammaticLeafResult[] = [];
	const active = new Map<number, SubagentRuntimeRunRequest>();
	const control = new AbortController();
	let stopRequested = false;
	let interrupted = false;
	let previousOutput = "";
	let nextFlatIndex = 0;
	const cancel = (state: "stopped" | "paused"): void => {
		stopRequested ||= state === "stopped";
		interrupted ||= state === "paused";
		control.abort();
	};
	const controlHandlers: ControlPollHandlers = {
		onSteer: (request) => routeProgrammaticSteer(runtime, asyncDir, request, [...active.values()]),
		onStop: () => cancel("stopped"),
		onInterrupt: () => cancel("paused"),
	};
	const pollPromise = runControlPollLoop(asyncDir, control.signal, controlHandlers);

	try {
		for (let logicalIndex = 0; logicalIndex < steps.length; logicalIndex += 1) {
			runControlPollOnce(asyncDir, controlHandlers);
			if (control.signal.aborted) break;
			const step = steps[logicalIndex]!;
			let stepResults: ProgrammaticLeafResult[];
			if (isDynamicRunnerGroup(step)) {
				throw new Error("Dynamic fanout not supported in async programmatic mode.");
			}
			if (isParallelGroup(step)) {
				const baseIndex = nextFlatIndex;
				nextFlatIndex += step.parallel.length;
				const requests = step.parallel.map((task, taskIndex) => {
					const index = baseIndex + taskIndex;
					const request = runnerStepToRequest(
						{ ...task, task: task.task.replace(/\{previous\}/g, previousOutput) },
						`${id}-${logicalIndex}-${taskIndex}`,
						index,
						task.cwd ?? runnerCwd,
					);
					active.set(index, request);
					markProgrammaticStep(asyncDir, index, { status: "running", startedAt: Date.now() });
					return request;
				});
				stepResults = await Promise.all(
					requests.map(async (request) => {
						try {
							return await consumeLeafRun(runtime, request, eventsPath, control.signal);
						} finally {
							active.delete(request.childIndex);
						}
					}),
				);
				previousOutput = aggregateProgrammaticOutputs(stepResults);
			} else {
				const index = nextFlatIndex++;
				const sequential = step as RunnerSubagentStep;
				const request = runnerStepToRequest(
					{ ...sequential, task: sequential.task.replace(/\{previous\}/g, previousOutput) },
					`${id}-${logicalIndex}`,
					index,
					sequential.cwd ?? runnerCwd,
				);
				active.set(index, request);
				markProgrammaticStep(asyncDir, index, { status: "running", startedAt: Date.now() });
				try {
					stepResults = [await consumeLeafRun(runtime, request, eventsPath, control.signal)];
				} finally {
					active.delete(index);
				}
				previousOutput = stepResults[0]?.output ?? "";
			}
			results.push(...stepResults);
			for (const result of stepResults) {
				markProgrammaticStep(asyncDir, result.index, {
					status: result.success ? "completed" : result.cancelled ? (stopRequested ? "stopped" : "paused") : "failed",
					endedAt: Date.now(),
					error: result.error,
					sessionFile: result.sessionFile,
				});
			}
			writeProgrammaticStatus(asyncDir, { currentStep: results.length, lastUpdate: Date.now() });
			if (stepResults.some((result) => !result.success)) break;
		}

		const endedAt = Date.now();
		const allSucceeded = results.length > 0 && results.every((result) => result.success);
		const state = stopRequested ? "stopped" : interrupted ? "paused" : allSucceeded ? "complete" : "failed";
		const error = stopRequested
			? "Async run stopped by user."
			: interrupted
				? "Async run interrupted."
				: results.find((result) => !result.success)?.error;
		writeProgrammaticStatus(asyncDir, { state, error, endedAt, lastUpdate: endedAt });
		writeAtomicJson(resultPath, {
			lifecycleArtifactVersion: SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
			id,
			runId: id,
			sessionId,
			mode: resultMode,
			success: allSucceeded,
			state,
			summary: allSucceeded ? previousOutput || `Async ${resultMode} ${id} completed.` : error,
			error,
			results: results.map((result) => ({
				agent: result.agent,
				output: result.output,
				success: result.success,
				error: result.error,
				sessionFile: result.sessionFile,
				state: result.cancelled ? state : undefined,
			})),
			cwd: runnerCwd,
			asyncDir,
			startedAt,
			endedAt,
		});
	} catch (error) {
		const endedAt = Date.now();
		const message = error instanceof Error ? error.message : String(error);
		writeProgrammaticStatus(asyncDir, { state: "failed", error: message, endedAt, lastUpdate: endedAt });
		writeAtomicJson(resultPath, {
			lifecycleArtifactVersion: SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
			id,
			runId: id,
			sessionId,
			mode: resultMode,
			success: false,
			state: "failed",
			error: message,
			results,
			cwd: runnerCwd,
			asyncDir,
			startedAt,
			endedAt,
		});
	} finally {
		control.abort();
		closeSteerInbox(asyncDir, readStatus(asyncDir)?.state ?? "failed");
		try {
			await pollPromise;
		} catch {
			// Control polling is best effort after the terminal result is durable.
		}
	}
}

function flattenProgrammaticSteps(steps: RunnerStep[]): {
	agents: string[];
	parallelGroups: Array<{ start: number; count: number; stepIndex: number }>;
} {
	const agents: string[] = [];
	const parallelGroups: Array<{ start: number; count: number; stepIndex: number }> = [];
	for (let stepIndex = 0; stepIndex < steps.length; stepIndex += 1) {
		const step = steps[stepIndex]!;
		if (isParallelGroup(step)) {
			parallelGroups.push({ start: agents.length, count: step.parallel.length, stepIndex });
			agents.push(...step.parallel.map((task) => task.agent));
		} else if (isDynamicRunnerGroup(step)) {
			parallelGroups.push({ start: agents.length, count: 1, stepIndex });
			agents.push(step.parallel.agent);
		} else {
			agents.push(step.agent);
		}
	}
	return { agents, parallelGroups };
}

function writeProgrammaticStatus(asyncDir: string, updates: Record<string, unknown>): void {
	const current = readStatus(asyncDir);
	writeAtomicJson(path.join(asyncDir, "status.json"), {
		...(current ? (current as unknown as Record<string, unknown>) : {}),
		...updates,
	});
}

function markProgrammaticStep(asyncDir: string, index: number, updates: Record<string, unknown>): void {
	const current = readStatus(asyncDir);
	if (!current) return;
	const record = current as unknown as Record<string, unknown>;
	const steps = Array.isArray(record.steps)
		? record.steps.map((step) => ({ ...(step as Record<string, unknown>) }))
		: [];
	const step = steps[index];
	if (!step) return;
	steps[index] = { ...step, ...updates };
	writeAtomicJson(path.join(asyncDir, "status.json"), { ...record, steps, lastUpdate: Date.now() });
}

function assistantOutput(event: SubagentRunEvent): string {
	if (event.type !== "message-end" || !event.message || typeof event.message !== "object" || Array.isArray(event.message)) {
		return "";
	}
	const message = event.message as Record<string, unknown>;
	if (message.role !== "assistant" || !Array.isArray(message.content)) return "";
	return message.content
		.flatMap((part) => {
			if (!part || typeof part !== "object" || Array.isArray(part)) return [];
			const value = part as Record<string, unknown>;
			return value.type === "text" && typeof value.text === "string" ? [value.text] : [];
		})
		.join("\n")
		.trim();
}

function aggregateProgrammaticOutputs(results: ProgrammaticLeafResult[]): string {
	return results
		.map((result, index) => {
			const header = `=== Parallel Task ${index + 1} (${result.agent}) ===`;
			const body = result.success ? result.output : `${result.error ?? "Failed"}${result.output ? `\n${result.output}` : ""}`;
			return `${header}\n${body}`;
		})
		.join("\n\n");
}

function routeProgrammaticSteer(
	runtime: SubagentRuntime,
	asyncDir: string,
	steerRequest: SteerRequest,
	activeRequests: SubagentRuntimeRunRequest[],
): void {
	const requestedIndexes = steerRequest.targetIndexes ??
		(steerRequest.targetIndex === undefined ? activeRequests.map(({ childIndex }) => childIndex) : [steerRequest.targetIndex]);
	const status = readStatus(asyncDir);
	if (status) {
		const steering = status.steering ?? createSteeringStatus();
		recordSteeringRequest(steering, {
			id: steerRequest.id,
			requestedAt: steerRequest.ts,
			source: steerRequest.source,
			message: steerRequest.message,
			targets: requestedIndexes.map((index) => ({
				index,
				state: activeRequests.some(({ childIndex }) => childIndex === index) ? "routed" : "failed",
				...(!activeRequests.some(({ childIndex }) => childIndex === index)
					? { reason: "Subagent child is not running." }
					: {}),
			})),
		});
		writeProgrammaticStatus(asyncDir, { steering, lastUpdate: Date.now() });
	}
	for (const index of requestedIndexes) {
		const target = activeRequests.find(({ childIndex }) => childIndex === index);
		if (!target) {
			writeSteerAck(asyncDir, {
				requestId: steerRequest.id,
				index,
				ts: Date.now(),
				state: "failed",
				message: "Subagent child is not running.",
			});
			continue;
		}
		void runtime.steer(target.runId, target.childIndex, steerRequest.message).then(
			() => completeProgrammaticSteer(asyncDir, steerRequest.id, index, "delivered", "Steering request delivered."),
			(error: unknown) =>
				completeProgrammaticSteer(
					asyncDir,
					steerRequest.id,
					index,
					"failed",
					error instanceof Error ? error.message : String(error),
				),
		);
	}
}

function completeProgrammaticSteer(
	asyncDir: string,
	requestId: string,
	index: number,
	state: "delivered" | "failed",
	message: string,
): void {
	const now = Date.now();
	const status = readStatus(asyncDir);
	if (status?.steering) {
		updateSteeringTarget(status.steering, requestId, index, state, now, state === "failed" ? { reason: message } : {});
		writeProgrammaticStatus(asyncDir, { steering: status.steering, lastUpdate: now });
	}
	writeSteerAck(asyncDir, { requestId, index, ts: now, state, message });
}

interface ControlPollHandlers {
	onSteer?: (request: SteerRequest) => void;
	onStop?: () => void;
	onInterrupt?: () => void;
}

function runControlPollOnce(asyncDir: string, handlers: ControlPollHandlers): void {
	try {
		for (const steerReq of consumeSteerRequests(asyncDir)) handlers.onSteer?.(steerReq);
		if (consumeStopRequest(asyncDir)) handlers.onStop?.();
		if (consumeInterruptRequest(asyncDir)) handlers.onInterrupt?.();
	} catch { /* silent */ }
}

async function runControlPollLoop(asyncDir: string, signal: AbortSignal, handlers: ControlPollHandlers): Promise<void> {
	while (!signal.aborted) {
		await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
		if (signal.aborted) break;
		try {
			for (const steerReq of consumeSteerRequests(asyncDir)) handlers.onSteer?.(steerReq);
			if (consumeStopRequest(asyncDir)) { handlers.onStop?.(); break; }
			if (consumeInterruptRequest(asyncDir)) { handlers.onInterrupt?.(); break; }
		} catch { /* silent */ }
	}
}
