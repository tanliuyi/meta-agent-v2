// @ts-nocheck -- Vendored upstream module; Desktop boundary behavior is covered by focused tests.
/**
 * Core execution logic for running subagents
 */

import { spawn } from "node:child_process";
import { appendFileSync, existsSync, unlinkSync } from "node:fs";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import type { SubagentRunEvent } from "../../../../../../../shared/subagent-contracts.ts";
import type { AgentConfig } from "../../agents/agents.ts";
import {
	ensureArtifactsDir,
	formatOutputArtifactContent,
	getArtifactPaths,
	writeArtifact,
	writeMetadata,
} from "../../shared/artifacts.ts";
import { createChildTranscriptWriter, type ChildTranscriptWriter } from "../../shared/child-transcript.ts";
import {
	type AgentProgress,
	type ArtifactPaths,
	type ControlEvent,
	type ModelAttempt,
	type RunSyncOptions,
	type SingleResult,
	type Usage,
	DEFAULT_MAX_OUTPUT,
	INTERCOM_DETACH_REQUEST_EVENT,
	INTERCOM_DETACH_RESPONSE_EVENT,
	type AcceptanceLedger,
	type ResolvedAcceptanceConfig,
	truncateOutput,
	getSubagentDepthEnv,
	resolveCurrentMaxSubagentDepth,
} from "../../shared/types.ts";
import {
	DEFAULT_CONTROL_CONFIG,
	buildControlEvent,
	claimControlNotification,
	deriveActivityState,
	shouldNotifyControlEvent,
} from "../shared/subagent-control.ts";
import {
	getFinalOutput,
	findLatestSessionFile,
	detectSubagentError,
	extractToolArgsPreview,
	extractTextFromContent,
} from "../../shared/utils.ts";
import { buildSkillInjection, resolveSkillsWithFallback } from "../../agents/skills.ts";
import { buildAgentMemoryInjection } from "../../agents/agent-memory.ts";
import { evaluateCompletionMutationGuard } from "../shared/completion-guard.ts";
import { readStructuredOutput } from "../shared/structured-output.ts";
import { captureSingleOutputSnapshot, formatSavedOutputReference, injectOutputPathSystemPrompt, resolveSingleOutput, validateFileOnlyOutputMode, type SingleOutputSnapshot } from "../shared/single-output.ts";
import {
	buildModelCandidates,
	formatModelAttemptNote,
	splitThinkingSuffix,
	isRetryableModelFailure,
} from "../shared/model-fallback.ts";
import {
	createMutatingFailureState,
	didMutatingToolFail,
	isMutatingTool,
	nextLongRunningTrigger,
	recordMutatingFailure,
	resetMutatingFailureState,
	resolveCurrentPath,
	shouldEscalateMutatingFailures,
	summarizeRecentMutatingFailures,
} from "../shared/long-running-guard.ts";
import { acceptanceFailureMessage, buildSkippedAcceptanceLedger, evaluateAcceptance, formatAcceptancePrompt, resolveEffectiveAcceptance, stripAcceptanceReport } from "../shared/acceptance.ts";
import { attachContractProjections, isAgentContractV1 } from "../shared/agent-contract.ts";
import { appendTurnBudgetSystemPrompt, formatTurnBudgetOutput, initialTurnBudgetState, turnBudgetDecision, turnBudgetDeferredNote, turnBudgetDeferredState, turnBudgetExceededMessage, turnBudgetSoftNote, turnBudgetState } from "../shared/turn-budget.ts";
import { initialToolBudgetState, toolBudgetState } from "../shared/tool-budget.ts";
import { resolveWatchdogConfig } from "../../watchdog/settings.ts";
import { createBoundedByteTail, createBoundedLineReader, formatProtocolOutputLimit, MAX_CHILD_STDERR_BYTES, projectChildLifecycle, type ChildLifecycleAction, type ProtocolOutputLimit } from "../shared/child-protocol.ts";
import {
	acceptChildWatchdogEvent,
	childWatchdogIsActive,
	isChildWatchdogStatusEvent,
	resolveChildWatchdogConfig,
	type ChildWatchdogStateSnapshot,
} from "../../watchdog/child-status.ts";

const artifactOutputByResult = new WeakMap<SingleResult, string>();
const acceptanceOutputByResult = new WeakMap<SingleResult, string>();

function emptyUsage(): Usage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

function withRunContext<T extends SingleResult>(result: T, context: RunSyncOptions["context"]): T {
	if (!context) return result;
	result.context = context;
	return result;
}

function sumUsage(target: Usage, source: Usage): void {
	target.input += source.input;
	target.output += source.output;
	target.cacheRead += source.cacheRead;
	target.cacheWrite += source.cacheWrite;
	target.cost += source.cost;
	target.turns += source.turns;
}

function formatTimeoutMessage(timeoutMs: number): string {
	return `Subagent timed out after ${timeoutMs}ms.`;
}

function resolveAttemptTimeout(options: RunSyncOptions): { timeoutMs: number; remainingMs: number; message: string } | undefined {
	if (options.timeoutMs === undefined) return undefined;
	const deadlineAt = options.deadlineAt ?? Date.now() + options.timeoutMs;
	return {
		timeoutMs: options.timeoutMs,
		remainingMs: Math.max(0, deadlineAt - Date.now()),
		message: formatTimeoutMessage(options.timeoutMs),
	};
}

function buildPendingAcceptanceLedger(acceptance: ResolvedAcceptanceConfig): AcceptanceLedger {
	return {
		status: "pending",
		explicit: acceptance.explicit,
		effectiveAcceptance: acceptance,
		inferredReason: acceptance.inferredReason,
		criteria: acceptance.criteria,
		runtimeChecks: [],
		verifyRuns: [],
	};
}

function appendRecentOutput(progress: AgentProgress, lines: string[]): void {
	if (lines.length === 0) return;
	progress.recentOutput.push(...lines.filter((line) => line.trim()));
	if (progress.recentOutput.length > 50) {
		progress.recentOutput.splice(0, progress.recentOutput.length - 50);
	}
}

function stripAcceptanceReportsFromMessages(messages: Message[] | undefined): void {
	for (const message of messages ?? []) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const part of message.content) {
			if (part.type === "text" && "text" in part && typeof part.text === "string") {
				part.text = stripAcceptanceReport(part.text);
			}
		}
	}
}

function snapshotProgress(progress: AgentProgress): AgentProgress {
	return {
		...progress,
		skills: progress.skills ? [...progress.skills] : undefined,
		recentTools: progress.recentTools.map((tool) => ({ ...tool })),
		recentOutput: [...progress.recentOutput],
	};
}

function snapshotResult(result: SingleResult, progress: AgentProgress): SingleResult {
	return {
		...result,
		messages: result.outputMode === "file-only" && result.savedOutputPath ? undefined : result.messages ? [...result.messages] : undefined,
		usage: { ...result.usage },
		skills: result.skills ? [...result.skills] : undefined,
		attemptedModels: result.attemptedModels ? [...result.attemptedModels] : undefined,
		modelAttempts: result.modelAttempts
			? result.modelAttempts.map((attempt) => ({
				...attempt,
				usage: attempt.usage ? { ...attempt.usage } : undefined,
			}))
			: undefined,
		controlEvents: result.controlEvents ? result.controlEvents.map((event) => ({ ...event })) : undefined,
		progress,
		progressSummary: result.progressSummary ? { ...result.progressSummary } : undefined,
		artifactPaths: result.artifactPaths ? { ...result.artifactPaths } : undefined,
		truncation: result.truncation ? { ...result.truncation } : undefined,
		outputReference: result.outputReference ? { ...result.outputReference } : undefined,
	};
}

async function runProgrammaticSingleAttempt(
	runtimeCwd: string,
	agent: AgentConfig,
	task: string,
	model: string | undefined,
	options: RunSyncOptions,
	shared: {
		sessionEnabled: boolean;
		systemPrompt: string;
		resolvedSkillNames?: string[];
		skillsWarning?: string;
		jsonlPath?: string;
		artifactPaths?: ArtifactPaths;
		transcriptWriter?: ChildTranscriptWriter;
		attemptNotes: string[];
		outputSnapshot?: SingleOutputSnapshot;
		originalTask?: string;
	},
): Promise<SingleResult> {
	const runtime = options.subagentRuntime;
	if (!runtime) throw new Error("Programmatic subagent runtime is unavailable");
	const toolExtensionPath = agent.tools?.find(
		(tool) => tool.includes("/") || tool.endsWith(".ts") || tool.endsWith(".js"),
	);
	if (agent.extensions?.length || agent.subagentOnlyExtensions?.length || toolExtensionPath) {
		throw new Error("Desktop programmatic subagents do not accept extension file paths");
	}
	if (agent.mcpDirectTools?.length) {
		throw new Error("MCP direct tools have not migrated to the Desktop programmatic runtime yet");
	}
	if (options.allowIntercomDetach) {
		throw new Error("Intercom detach has not migrated to the Desktop programmatic runtime yet");
	}

	const parsedModel = model ? splitThinkingSuffix(model) : undefined;
	const suffixThinking = parsedModel?.thinkingSuffix
		? parsedModel.thinkingSuffix.slice(1) as AgentConfig["thinking"]
		: undefined;
	const effectiveThinking = options.thinkingOverride ?? suffixThinking ?? agent.thinking;
	const toolNames = agent.tools ? [...agent.tools] : undefined;
	if (shared.resolvedSkillNames?.length && toolNames && !toolNames.includes("read")) toolNames.unshift("read");
	const timeout = resolveAttemptTimeout(options);
	const result: SingleResult = withRunContext(
		{
			agent: agent.name,
			task: shared.originalTask ?? task,
			...(options.agentContract ? { agentContract: options.agentContract } : {}),
			exitCode: 0,
			messages: [],
			usage: emptyUsage(),
			model,
			artifactPaths: shared.artifactPaths,
			transcriptPath: shared.transcriptWriter ? shared.artifactPaths?.transcriptPath : undefined,
			skills: shared.resolvedSkillNames,
			skillsWarning: shared.skillsWarning,
			...(options.turnBudget ? { turnBudget: initialTurnBudgetState(options.turnBudget) } : {}),
			...(options.toolBudget ? { toolBudget: initialToolBudgetState(options.toolBudget) } : {}),
		},
		options.context,
	);
	const startedAt = Date.now();
	const progress: AgentProgress = {
		index: options.index ?? 0,
		agent: agent.name,
		status: "running",
		task,
		skills: shared.resolvedSkillNames,
		recentTools: [],
		recentOutput: [...shared.attemptNotes],
		toolCount: 0,
		tokens: 0,
		durationMs: 0,
		lastActivityAt: startedAt,
	};
	result.progress = progress;
	const controlConfig = options.controlConfig ?? DEFAULT_CONTROL_CONFIG;
	const controlEvents: ControlEvent[] = [];
	let longRunningNotified = false;
	const emitControl = (event: ControlEvent): void => {
		controlEvents.push(event);
		options.onControlEvent?.(event);
	};
	const refreshActivity = (): void => {
		if (!controlConfig.enabled) return;
		const now = Date.now();
		const idleState = deriveActivityState({
			config: controlConfig,
			startedAt,
			lastActivityAt: progress.lastActivityAt,
			currentTool: progress.currentTool,
			now,
		});
		if (idleState === "needs_attention" && progress.activityState !== "needs_attention") {
			const previous = progress.activityState;
			progress.activityState = "needs_attention";
			emitControl(buildControlEvent({
				type: "needs_attention",
				from: previous,
				to: "needs_attention",
				runId: options.runId,
				agent: agent.name,
				index: options.index,
				ts: now,
				lastActivityAt: progress.lastActivityAt,
				reason: "idle",
				turns: result.usage.turns,
				tokens: progress.tokens,
				toolCount: progress.toolCount,
				currentTool: progress.currentTool,
				currentPath: progress.currentPath,
			}));
			return;
		}
		const trigger = nextLongRunningTrigger(controlConfig, {
			startedAt,
			now,
			turns: result.usage.turns,
			tokens: progress.tokens,
		});
		if (trigger && !longRunningNotified && progress.activityState !== "needs_attention") {
			longRunningNotified = true;
			const previous = progress.activityState;
			progress.activityState = "active_long_running";
			emitControl(buildControlEvent({
				type: "active_long_running",
				from: previous,
				to: "active_long_running",
				runId: options.runId,
				agent: agent.name,
				index: options.index,
				ts: now,
				reason: trigger,
				turns: result.usage.turns,
				tokens: progress.tokens,
				toolCount: progress.toolCount,
				currentTool: progress.currentTool,
				currentPath: progress.currentPath,
				elapsedMs: now - startedAt,
			}));
		}
	};
	const activityTimer = controlConfig.enabled ? setInterval(refreshActivity, 1_000) : undefined;
	activityTimer?.unref?.();
	let observedMutationAttempt = false;
	let completedSessionFile: string | undefined;
	let interrupted = false;
	const emitUpdate = (): void => {
		if (!options.onUpdate) return;
		progress.durationMs = Date.now() - startedAt;
		const text = getFinalOutput(result.messages) || result.error || "(running...)";
		const progressSnapshot = snapshotProgress(progress);
		options.onUpdate({
			content: [{ type: "text", text }],
			details: { mode: "single", results: [snapshotResult(result, progressSnapshot)], progress: [progressSnapshot] },
		});
	};
	const applyEvent = (event: SubagentRunEvent): void => {
		progress.lastActivityAt = Date.now();
		shared.transcriptWriter?.writeChildEvent(event);
		if (shared.jsonlPath) {
			try {
				appendFileSync(shared.jsonlPath, `${JSON.stringify(event)}\n`);
			} catch {
				// Artifact writes are best effort and must not fail the child run.
			}
		}
		if (event.type === "text-delta") return;
		if (event.type === "message-end") {
			const message = event.message as unknown as Message;
			result.messages?.push(message);
			if (message.role === "assistant") {
				result.usage.turns += 1;
				progress.turnCount = result.usage.turns;
				const usage = message.usage;
				if (usage) {
					result.usage.input += usage.input || 0;
					result.usage.output += usage.output || 0;
					result.usage.cacheRead += usage.cacheRead || 0;
					result.usage.cacheWrite += usage.cacheWrite || 0;
					result.usage.cost += usage.cost?.total || 0;
					progress.tokens = result.usage.input + result.usage.output;
				}
				if (!result.model && message.model) result.model = message.model;
				appendRecentOutput(progress, extractTextFromContent(message.content).split("\n").slice(-10));
			}
			emitUpdate();
			return;
		}
		if (event.type === "tool-start") {
			const args = event.args && typeof event.args === "object" && !Array.isArray(event.args)
				? event.args as Record<string, unknown>
				: {};
			progress.toolCount += 1;
			progress.currentTool = event.toolName;
			progress.currentToolArgs = extractToolArgsPreview(args);
			progress.currentToolStartedAt = Date.now();
			progress.currentPath = resolveCurrentPath(event.toolName, args);
			observedMutationAttempt ||= isMutatingTool(event.toolName, args);
			if (options.toolBudget) result.toolBudget = toolBudgetState(options.toolBudget, progress.toolCount);
			emitUpdate();
			return;
		}
		if (event.type === "tool-end") {
			if (progress.currentTool) {
				progress.recentTools.push({ tool: progress.currentTool, args: progress.currentToolArgs || "", endMs: Date.now() });
			}
			const output = event.result && typeof event.result === "object" && "content" in event.result
				? extractTextFromContent((event.result as { content: unknown }).content as never)
				: "";
			appendRecentOutput(progress, output.split("\n").slice(-10));
			if (options.toolBudget && output.includes("Tool budget hard limit reached")) {
				result.toolBudgetBlocked = true;
				result.toolBudget = toolBudgetState(options.toolBudget, progress.toolCount, event.toolName);
			}
			progress.currentTool = undefined;
			progress.currentToolArgs = undefined;
			progress.currentToolStartedAt = undefined;
			progress.currentPath = undefined;
			emitUpdate();
			return;
		}
		if (event.type === "completed") completedSessionFile = event.sessionFile;
		if (event.type === "failed") result.error = event.error;
	};

	const abort = (): void => {
		void runtime.cancel(options.runId, options.index ?? 0);
	};
	const interrupt = (): void => {
		interrupted = true;
		void runtime.cancel(options.runId, options.index ?? 0);
	};
	if (options.signal?.aborted) abort();
	else options.signal?.addEventListener("abort", abort, { once: true });
	if (options.interruptSignal?.aborted) interrupt();
	else options.interruptSignal?.addEventListener("abort", interrupt, { once: true });
	try {
		for await (const event of runtime.run({
			parentSessionId: options.parentSessionId,
			runId: options.runId,
			rootRunId: options.nestedRoute?.rootRunId ?? options.runId,
			childIndex: options.index ?? 0,
			depth: 1,
			maxDepth: Math.max(1, options.maxSubagentDepth ?? resolveCurrentMaxSubagentDepth()),
			lineage: [],
			agent: agent.name,
			task,
			cwd: options.cwd ?? runtimeCwd,
			sessionFile: options.sessionFile,
			sessionDir: options.sessionDir,
			persistSession: shared.sessionEnabled,
			model: parsedModel?.baseModel,
			preferredProvider: options.preferredModelProvider,
			thinking: effectiveThinking === false ? "off" : effectiveThinking,
			tools: toolNames,
			systemPrompt: appendTurnBudgetSystemPrompt(shared.systemPrompt, options.turnBudget),
			systemPromptMode: agent.systemPromptMode,
			inheritProjectContext: agent.inheritProjectContext,
			inheritSkills: agent.inheritSkills,
			extensionProfile: agent.tools?.includes("subagent")
				? ["provider", "memory", "runtime", "fanout"]
				: ["provider", "memory", "runtime"],
			timeoutMs: timeout?.remainingMs,
			turnBudget: options.turnBudget,
			toolBudget: options.toolBudget,
			structuredOutput: options.structuredOutput
				? { schema: options.structuredOutput.schema as never, outputPath: options.structuredOutput.outputPath }
				: undefined,
		})) applyEvent(event);
	} catch (error) {
		result.error ??= error instanceof Error ? error.message : String(error);
	} finally {
		if (activityTimer) clearInterval(activityTimer);
		options.signal?.removeEventListener("abort", abort);
		options.interruptSignal?.removeEventListener("abort", interrupt);
	}

	if (interrupted) {
		result.interrupted = true;
		result.error = undefined;
		result.finalOutput = "Interrupted. Waiting for explicit next action.";
	}
	if (timeout && (timeout.remainingMs === 0 || result.error === timeout.message)) result.timedOut = true;
	if (options.turnBudget && result.error?.includes("exceeded its turn budget")) {
		result.turnBudgetExceeded = true;
		result.wrapUpRequested = true;
		result.turnBudget = turnBudgetState(options.turnBudget, result.usage.turns, true);
	}
	result.exitCode = result.error ? 1 : 0;
	if (result.exitCode === 0 && !getFinalOutput(result.messages).trim() && !options.structuredOutput) {
		result.exitCode = 1;
		result.error = "Subagent produced no output (possible model cold-start or empty response).";
	}
	if (options.structuredOutput && result.exitCode === 0) {
		const structured = await readStructuredOutput(options.structuredOutput);
		result.structuredOutputSchemaPath = options.structuredOutput.schemaPath;
		result.structuredOutputPath = options.structuredOutput.outputPath;
		if (structured.error) {
			result.exitCode = 1;
			result.error = structured.error;
		} else result.structuredOutput = structured.value;
	}
	progress.status = result.exitCode === 0 ? "completed" : "failed";
	progress.durationMs = Date.now() - startedAt;
	if (result.error) progress.error = result.error;
	result.progressSummary = { toolCount: progress.toolCount, tokens: progress.tokens, durationMs: progress.durationMs };
	let fullOutput = stripAcceptanceReport(getFinalOutput(result.messages));
	if (result.timedOut) {
		const timeoutMessage = formatTimeoutMessage(options.timeoutMs ?? 0);
		fullOutput = fullOutput.trim()
			? `${timeoutMessage}\n\nPartial output before timeout:\n${fullOutput}`
			: timeoutMessage;
	} else if (result.turnBudgetExceeded && result.turnBudget) {
		fullOutput = formatTurnBudgetOutput(
			turnBudgetExceededMessage(result.turnBudget, result.turnBudget.turnCount),
			fullOutput,
		);
	}
	const completionGuardEnabled = isAgentContractV1(options.agentContract) ? agent.completionGuard === true : agent.completionGuard !== false;
	const completionGuard = result.exitCode === 0 && completionGuardEnabled
		? evaluateCompletionMutationGuard({
			agent: agent.name,
			task: shared.originalTask ?? task,
			messages: result.messages,
			tools: agent.tools,
			mcpDirectTools: agent.mcpDirectTools,
		})
		: undefined;
	if (completionGuard) {
		const missingMutation = completionGuard.triggered === true && !observedMutationAttempt;
		result.effects = {
			...(result.effects ?? {}),
			fileMutation: {
				status: completionGuard.expectedMutation
					? missingMutation
						? "missing"
						: "observed"
					: "not-applicable",
				expected: completionGuard.expectedMutation,
				attempted: completionGuard.attemptedMutation || observedMutationAttempt,
				...(missingMutation ? { message: "Subagent completed without making edits for an implementation task." } : {}),
			},
		};
	}
	if (completionGuard?.triggered && !observedMutationAttempt && !isAgentContractV1(options.agentContract)) {
		result.exitCode = 1;
		result.error = "Subagent completed without making edits for an implementation task.";
		progress.status = "failed";
		progress.error = result.error;
	}
	if (options.outputPath && result.exitCode === 0 && !result.interrupted) {
		const resolvedOutput = resolveSingleOutput(options.outputPath, fullOutput, shared.outputSnapshot);
		fullOutput = stripAcceptanceReport(resolvedOutput.fullOutput);
		result.savedOutputPath = resolvedOutput.savedPath;
		result.outputSaveError = resolvedOutput.saveError;
		if (resolvedOutput.savedPath) result.outputReference = formatSavedOutputReference(resolvedOutput.savedPath, fullOutput);
	}
	artifactOutputByResult.set(result, fullOutput);
	acceptanceOutputByResult.set(result, getFinalOutput(result.messages));
	result.outputMode = options.outputMode ?? "inline";
	result.finalOutput = options.outputMode === "file-only" && result.outputReference
		? result.outputReference.message
		: result.interrupted
			? result.finalOutput
			: fullOutput || result.error;
	result.sessionFile = completedSessionFile ?? options.sessionFile;
	result.controlEvents = controlEvents.length > 0 ? controlEvents : undefined;
	emitUpdate();
	return result;
}

async function runSingleAttempt(
	runtimeCwd: string,
	agent: AgentConfig,
	task: string,
	model: string | undefined,
	options: RunSyncOptions,
	shared: {
		sessionEnabled: boolean;
		systemPrompt: string;
		resolvedSkillNames?: string[];
		skillsWarning?: string;
		jsonlPath?: string;
		artifactPaths?: ArtifactPaths;
		transcriptWriter?: ChildTranscriptWriter;
		attemptNotes: string[];
		outputSnapshot?: SingleOutputSnapshot;
		originalTask?: string;
	},
): Promise<SingleResult> {
	if (options.subagentRuntime) {
		return runProgrammaticSingleAttempt(runtimeCwd, agent, task, model, options, shared);
	}
	throw new Error("Programmatic subagent runtime is unavailable");
}
export async function runSync(
	runtimeCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	options: RunSyncOptions,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);
	if (!agent) {
		return withRunContext({
			agent: agentName,
			task,
			exitCode: 1,
			messages: [],
			usage: emptyUsage(),
			error: `Unknown agent: ${agentName}`,
		}, options.context);
	}
	const outputModeValidationError = validateFileOnlyOutputMode(options.outputMode, options.outputPath, `Single run (${agentName})`);
	if (outputModeValidationError) {
		return withRunContext({
			agent: agentName,
			task,
			exitCode: 1,
			messages: [],
			usage: emptyUsage(),
			outputMode: options.outputMode,
			error: outputModeValidationError,
		}, options.context);
	}

	const shareEnabled = options.share === true;
	const effectiveAcceptance = resolveEffectiveAcceptance({
		explicit: options.acceptance,
		agentName,
		acceptanceRole: agent.acceptanceRole,
		task,
		mode: options.acceptanceContext?.mode ?? "single",
		async: options.acceptanceContext?.async,
		dynamic: options.acceptanceContext?.dynamic,
		dynamicGroup: options.acceptanceContext?.dynamicGroup,
		agentContract: options.agentContract,
	});
	const acceptancePrompt = formatAcceptancePrompt(effectiveAcceptance, { reportOptional: isAgentContractV1(options.agentContract) });
	const taskWithAcceptance = acceptancePrompt ? `${task}\n${acceptancePrompt}` : task;
	const sessionEnabled = Boolean(options.sessionFile || options.sessionDir) || shareEnabled;
	const skillNames = options.skills ?? agent.skills ?? [];
	const skillCwd = options.cwd ?? runtimeCwd;
	const { resolved: resolvedSkills, missing: missingSkills } = resolveSkillsWithFallback(
		skillNames,
		skillCwd,
		runtimeCwd,
		agent.skillPath,
		agent.filePath ? path.dirname(agent.filePath) : skillCwd,
	);
	if (skillNames.some((skill) => skill.trim() === "pi-subagents") && missingSkills.includes("pi-subagents")) {
		return withRunContext({
			agent: agentName,
			task,
			exitCode: 1,
			messages: [],
			usage: emptyUsage(),
			error: "Skills not found: pi-subagents",
		}, options.context);
	}
	let systemPrompt = agent.systemPrompt?.trim() || "";
	if (resolvedSkills.length > 0) {
		const skillInjection = buildSkillInjection(resolvedSkills);
		systemPrompt = systemPrompt ? `${systemPrompt}\n\n${skillInjection}` : skillInjection;
	}
	const memoryInjection = buildAgentMemoryInjection(agent, skillCwd);
	if (memoryInjection) {
		systemPrompt = systemPrompt ? `${systemPrompt}\n\n${memoryInjection}` : memoryInjection;
	}
	systemPrompt = injectOutputPathSystemPrompt(systemPrompt, options.outputPath, agent);

	const candidates = buildModelCandidates(
		options.modelOverride ?? agent.model,
		agent.fallbackModels,
		options.availableModels,
		options.preferredModelProvider,
		{ scope: options.modelScope },
	);
	const attemptedModels: string[] = [];
	const modelAttempts: ModelAttempt[] = [];
	const aggregateUsage = emptyUsage();
	const attemptNotes: string[] = [];
	let totalToolCount = 0;
	let totalDurationMs = 0;

	let artifactPathsResult: ArtifactPaths | undefined;
	let jsonlPath: string | undefined;
	let transcriptWriter: ChildTranscriptWriter | undefined;
	if (options.artifactsDir && options.artifactConfig?.enabled !== false) {
		artifactPathsResult = getArtifactPaths(options.artifactsDir, options.runId, agentName, options.index);
		ensureArtifactsDir(options.artifactsDir);
		if (options.artifactConfig?.includeInput !== false) {
				writeArtifact(artifactPathsResult.inputPath, `# Task for ${agentName}\n\n${taskWithAcceptance}`);
		}
		if (options.artifactConfig?.includeJsonl !== false) {
			jsonlPath = artifactPathsResult.jsonlPath;
		}
		if (options.artifactConfig?.includeTranscript !== false) {
			transcriptWriter = createChildTranscriptWriter({
				transcriptPath: artifactPathsResult.transcriptPath,
				source: "foreground",
				runId: options.runId,
				agent: agentName,
				childIndex: options.index,
				cwd: options.cwd ?? runtimeCwd,
			});
			transcriptWriter.writeInitialUserMessage(taskWithAcceptance);
		}
	}

	const persistResultMetadata = (target: SingleResult): void => {
		if (!artifactPathsResult || options.artifactConfig?.enabled === false || options.artifactConfig?.includeMetadata === false) return;
		writeMetadata(artifactPathsResult.metadataPath, {
			runId: options.runId,
			agent: agentName,
			task,
			exitCode: target.exitCode,
			usage: target.usage,
			model: target.model,
			attemptedModels: target.attemptedModels,
			modelAttempts: target.modelAttempts,
			durationMs: target.progressSummary?.durationMs,
			toolCount: target.progressSummary?.toolCount,
			error: target.error,
			agentContract: target.agentContract,
			execution: target.execution,
			acceptance: target.acceptance,
			review: target.review,
			effects: target.effects,
			...(transcriptWriter ? { transcriptPath: artifactPathsResult.transcriptPath } : {}),
			transcriptError: target.transcriptError,
			skills: target.skills,
			skillsWarning: target.skillsWarning,
			timestamp: Date.now(),
		});
	};

	const detachedAwareOptions: RunSyncOptions = options.onDetachedExit
		? {
			...options,
			onDetachedExit: (recoveredResult) => {
				void (async () => {
					const childWrittenOutput = options.outputPath
						? extractChildWrittenOutput(recoveredResult.messages, options.outputPath, options.cwd ?? runtimeCwd)
						: undefined;
					recoveredResult.acceptance = await evaluateAcceptance({
						acceptance: effectiveAcceptance,
						output: acceptanceOutputByResult.get(recoveredResult) ?? recoveredResult.finalOutput ?? "",
						fileOutput: childWrittenOutput !== undefined && options.outputPath
							? { content: childWrittenOutput, path: options.outputPath, authoritative: options.outputMode === "file-only" }
							: undefined,
						cwd: options.cwd ?? runtimeCwd,
						reportOptional: isAgentContractV1(options.agentContract),
					});
					const acceptanceFailure = acceptanceFailureMessage(recoveredResult.acceptance);
					stripAcceptanceReportsFromMessages(recoveredResult.messages);
					if (acceptanceFailure && recoveredResult.acceptance.explicit && recoveredResult.exitCode === 0 && !isAgentContractV1(options.agentContract)) {
						recoveredResult.exitCode = 1;
						recoveredResult.error = recoveredResult.error ? `${recoveredResult.error}\n${acceptanceFailure}` : acceptanceFailure;
						if (recoveredResult.progress) {
							recoveredResult.progress.status = "failed";
							recoveredResult.progress.error = recoveredResult.error;
						}
					}
					if (isAgentContractV1(options.agentContract)) attachContractProjections(recoveredResult);
					persistResultMetadata(recoveredResult);
					options.onDetachedExit?.(recoveredResult);
				})().catch((error) => {
					const message = error instanceof Error ? error.message : String(error);
					recoveredResult.exitCode = 1;
					recoveredResult.error = recoveredResult.error ? `${recoveredResult.error}\nAcceptance evaluation failed: ${message}` : `Acceptance evaluation failed: ${message}`;
					options.onDetachedExit?.(recoveredResult);
				});
			},
		}
		: options;

	let lastResult: SingleResult | undefined;
	const modelsToTry = candidates.length > 0 ? candidates : [undefined];
	for (let i = 0; i < modelsToTry.length; i++) {
		const candidate = modelsToTry[i];
		const outputSnapshot = captureSingleOutputSnapshot(options.outputPath);
		const result = await runSingleAttempt(runtimeCwd, agent, taskWithAcceptance, candidate, detachedAwareOptions, {
			sessionEnabled,
			systemPrompt,
			resolvedSkillNames: resolvedSkills.length > 0 ? resolvedSkills.map((skill) => skill.name) : undefined,
			skillsWarning: missingSkills.length > 0 ? `Skills not found: ${missingSkills.join(", ")}` : undefined,
			jsonlPath,
			artifactPaths: artifactPathsResult,
			transcriptWriter,
			attemptNotes,
			outputSnapshot,
			originalTask: task,
		});
		lastResult = result;
		if (result.model) attemptedModels.push(result.model);
		else if (candidate) attemptedModels.push(candidate);
		sumUsage(aggregateUsage, result.usage);
		totalToolCount += result.progressSummary?.toolCount ?? 0;
		totalDurationMs += result.progressSummary?.durationMs ?? 0;
		const attemptSucceeded = result.exitCode === 0 && !result.error;
		const attempt: ModelAttempt = {
			model: result.model ?? candidate ?? agent.model ?? "default",
			success: attemptSucceeded,
			exitCode: result.exitCode,
			error: result.error,
			usage: { ...result.usage },
		};
		modelAttempts.push(attempt);
		if (result.detached || result.timedOut || result.turnBudgetExceeded) {
			break;
		}
		if (attemptSucceeded) {
			break;
		}
		if (!isRetryableModelFailure(result.error) || i === modelsToTry.length - 1) {
			break;
		}
		attemptNotes.push(formatModelAttemptNote(attempt, modelsToTry[i + 1]));
	}

	const result = withRunContext(lastResult ?? {
		agent: agentName,
		task,
		exitCode: 1,
		messages: [],
		usage: emptyUsage(),
		error: "Subagent did not produce a result.",
	} satisfies SingleResult, options.context);

	result.usage = aggregateUsage;
	result.attemptedModels = attemptedModels.length > 0 ? attemptedModels : undefined;
	result.modelAttempts = modelAttempts.length > 0 ? modelAttempts : undefined;
	result.progressSummary = {
		toolCount: totalToolCount,
		tokens: aggregateUsage.input + aggregateUsage.output,
		durationMs: totalDurationMs,
	};
	if (attemptNotes.length > 0 && result.progress) {
		result.progress.recentOutput = [...attemptNotes, ...result.progress.recentOutput];
		if (result.progress.recentOutput.length > 50) {
			result.progress.recentOutput.splice(50);
		}
	}

	if (transcriptWriter) result.transcriptPath = artifactPathsResult?.transcriptPath;
	if (transcriptWriter?.getError()) result.transcriptError = transcriptWriter.getError();

	if (artifactPathsResult && options.artifactConfig?.enabled !== false) {
		result.artifactPaths = artifactPathsResult;
		if (options.artifactConfig?.includeOutput !== false) {
			writeArtifact(artifactPathsResult.outputPath, formatOutputArtifactContent({
				output: artifactOutputByResult.get(result) ?? result.finalOutput ?? "",
				error: result.error,
				transcriptPath: result.transcriptPath,
				metadataPath: options.artifactConfig?.includeMetadata === false ? undefined : artifactPathsResult.metadataPath,
			}));
		}
		if (options.maxOutput) {
			const config = { ...DEFAULT_MAX_OUTPUT, ...options.maxOutput };
			const truncationResult = truncateOutput(result.finalOutput ?? "", config, artifactPathsResult.outputPath);
			if (truncationResult.truncated) result.truncation = truncationResult;
		}
	} else if (options.maxOutput) {
		const config = { ...DEFAULT_MAX_OUTPUT, ...options.maxOutput };
		const truncationResult = truncateOutput(result.finalOutput ?? "", config);
		if (truncationResult.truncated) result.truncation = truncationResult;
	}

	if (options.sessionFile && (existsSync(options.sessionFile) || result.messages?.length)) {
		result.sessionFile = options.sessionFile;
	} else if (shareEnabled && options.sessionDir) {
		const sessionFile = findLatestSessionFile(options.sessionDir);
		if (sessionFile) result.sessionFile = sessionFile;
	}

	const childWrittenOutput = options.outputPath
		? extractChildWrittenOutput(result.messages, options.outputPath, options.cwd ?? runtimeCwd)
		: undefined;
	if (result.detached) {
		result.acceptance = buildPendingAcceptanceLedger(effectiveAcceptance);
	} else if (result.stopped) {
		result.acceptance = buildSkippedAcceptanceLedger(effectiveAcceptance, { id: "stopped", message: "Acceptance was not evaluated because the subagent was stopped." });
	} else if (result.timedOut) {
		result.acceptance = buildSkippedAcceptanceLedger(effectiveAcceptance, { id: "timeout", message: "Acceptance was not evaluated because the subagent timed out." });
	} else if (result.turnBudgetExceeded) {
		result.acceptance = buildSkippedAcceptanceLedger(effectiveAcceptance, { id: "turn-budget", message: "Acceptance was not evaluated because the subagent exceeded its turn budget." });
	} else {
		result.acceptance = await evaluateAcceptance({
			acceptance: effectiveAcceptance,
			output: acceptanceOutputByResult.get(result) ?? result.finalOutput ?? "",
			fileOutput: childWrittenOutput !== undefined && options.outputPath
				? { content: childWrittenOutput, path: options.outputPath, authoritative: options.outputMode === "file-only" }
				: undefined,
			cwd: options.cwd ?? runtimeCwd,
			reportOptional: isAgentContractV1(options.agentContract),
		});
	}
	const acceptanceFailure = acceptanceFailureMessage(result.acceptance);
	stripAcceptanceReportsFromMessages(result.messages);
	if (acceptanceFailure && result.acceptance.explicit && result.exitCode === 0 && !result.detached && !result.interrupted && !result.timedOut && !isAgentContractV1(options.agentContract)) {
		result.exitCode = 1;
		result.error = result.error ? `${result.error}\n${acceptanceFailure}` : acceptanceFailure;
		if (result.progress) {
			result.progress.status = "failed";
			result.progress.error = result.error;
		}
	}
	if (isAgentContractV1(options.agentContract)) attachContractProjections(result);
	persistResultMetadata(result);

	return result;
}
