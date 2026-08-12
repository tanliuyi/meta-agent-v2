// @ts-nocheck -- Vendored upstream module; Desktop boundary behavior is covered by focused tests.
/**
 * Async execution logic for subagent tool
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../../agents/agents.ts";
import { writeAtomicJson, writePrivateAtomicJson } from "../../shared/atomic-json.ts";
import {  splitKnownThinkingSuffix } from "../../shared/model-info.ts";
import { agentDefinitionDigest, launchBindingDigest } from "../../shared/launch-contract.ts";
import { injectOutputPathSystemPrompt, injectSingleOutputInstruction, normalizeSingleOutputOverride, resolveSingleOutputPath, validateFileOnlyOutputMode } from "../shared/single-output.ts";
import { buildChainInstructions, isCheckpointStep, isDynamicParallelStep, isParallelStep, resolveStepBehavior, suppressProgressForReadOnlyTask, writeInitialProgressFile, type ChainStep, type ResolvedStepBehavior, type SequentialStep, type StepOverrides } from "../../shared/settings.ts";
import { isParallelGroup, isDynamicRunnerGroup, isCheckpointRunnerStep, mapConcurrent, MAX_PARALLEL_CONCURRENCY, type RunnerStep, type RunnerSubagentStep } from "../shared/parallel-utils.ts";
import type { ContextMode } from "../shared/context-mode.ts";
import { buildSkillInjection
, normalizeSkillInput, resolveSkillsWithFallback } from "../../agents/skills.ts";
import { buildAgentMemoryInjection } from "../../agents/agent-memory.ts";
import { resolveChildCwd, PI_CODING_AGENT_PACKAGE_ROOT_ENV } from "../../shared/utils.ts";
import { buildModelCandidates, formatModelAttemptNote, isRetryableModelFailure, resolveEffectiveSubagentModel, resolveModelCandidate, resolveSubagentModelOverride, type AvailableModelInfo, type ParentModel } from "../shared/model-fallback.ts";
import type { ModelScopeConfig } from "../shared/model-scope.ts";
import { applyThinkingSuffix } from "../shared/pi-args.ts";
import { resolveEffectiveThinking } from "../../shared/model-info.ts";
import { resolveCurrentPath } from "../shared/long-running-guard.ts";
import { resolveExpectedWorktreeAgentCwd } from "../shared/worktree.ts";
import { buildWorkflowGraphSnapshot } from "../shared/workflow-graph.ts";
import { ChainOutputValidationError, outputEntryFromAsyncResult, resolveOutputReferences, validateChainOutputBindings } from "../shared/chain-outputs.ts";
import { createStructuredOutputRuntime } from "../shared/structured-output.ts";
import {
	appendRunnerStepsToStatus,
	consumeChainAppendRequests,
	countPendingChainAppendRequests,
} from "./chain-append.ts";
import { resolveEffectiveAcceptance, evaluateAcceptance, acceptanceFailureMessage, buildSkippedAcceptanceLedger } from "../shared/acceptance.ts";
import { isAgentContractV1 } from "../shared/agent-contract.ts";
import {
	type AcceptanceInput,
	type AcceptanceLedger,
	type AgentContract,
	type ArtifactConfig,
	type ChainOutputMap,
	type Details,
	type JsonSchemaObject,
	type MaxOutputConfig,
	type NestedRouteInfo,
	type ResolvedControlConfig,
	type ResolvedAcceptanceConfig,
	type ResolvedTurnBudget,
	type ResolvedToolBudget,
	type SubagentRunMode,
	type SteeringRecoveryDescriptor,
	DIRS,
	SUBAGENT_ASYNC_STARTED_EVENT,
	SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
	TEMP_ROOT_DIR,
	getAsyncConfigPath,
	resolveChildMaxSubagentDepth,
} from "../../shared/types.ts";
import { resolvePiPackageRoot } from "../shared/pi-spawn.ts";
import { nestedResultsPath, nestedSummaryFromAsyncStatus, resolveInheritedNestedRouteFromEnv, resolveNestedParentAddressFromEnv, writeNestedEvent } from "../shared/nested-events.ts";
import { appendTurnBudgetSystemPrompt, initialTurnBudgetState } from "../shared/turn-budget.ts";
import { validateToolBudgetConfig } from "../shared/tool-budget.ts";
import { waitForImportedAsyncRoot, type ImportedAsyncRoot } from "./chain-root-attachment.ts";
import { finalizeProcessTerminal, readProcessTerminal } from "./process-terminal.ts";
import { SUBAGENT_PROCESS_TERMINAL_EVENT } from "../../shared/types.ts";
import { resolveCurrentSubagentCapabilityCeiling, type ResolvedSubagentCapabilityCeiling, type SubagentCapabilityAudit } from "../shared/capability-ceiling.ts";
import { resolvePermissionRules } from "../shared/permissions.ts";
import { cleanupWorktrees, createWorktrees, diffWorktrees, formatWorktreeDiffSummary, type WorktreeSetup } from "../shared/worktree.ts";
import { formatParallelHandoffError, formatParallelHandoffReference, parallelHandoffPath, writeParallelHandoffGroup } from "../shared/parallel-handoff.ts";
import type { SessionLeaseRequest } from "../shared/session-lease.ts";
import { appendJsonl } from "../../shared/artifacts.ts";
import { materializeDynamicParallelStep, collectDynamicResults, validateDynamicCollection, DynamicFanoutError } from "../shared/dynamic-fanout.ts";
import {
  childExtensionTools,
  resolveChildExtensions,
  type SubagentRuntime,
  type SubagentRuntimeRunRequest,
} from "../../runtime/subagent-runtime.ts";
import {
	SUBAGENT_TIMEOUT_CODE,
	subagentTextDelta,
	type SubagentChildExtension,
	type SubagentExtensionProfile,
	type SubagentRunEvent,
} from "../../../../../../../shared/subagent-contracts.ts";
import { extractToolArgsPreview, readStatus, resolveWatchPath } from "../../shared/utils.ts";
import {
	closeSteerInbox,
	consumeCheckpointDecisionRequest,
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

const require = createRequire(import.meta.url);
const piPackageRoot = resolvePiPackageRoot();

function resolveJitiCliFromPackageJson(packageJsonPath: string): string | undefined {
	if (!fs.existsSync(packageJsonPath)) return undefined;
	const packageRoot = path.dirname(packageJsonPath);
	const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as {
		bin?: string | Record<string, string>;
	};
	const binField = pkg.bin;
	const binPath = typeof binField === "string"
		? binField
		: binField?.jiti ?? Object.values(binField ?? {})[0];
	const candidates = [binPath, "lib/jiti-cli.mjs"].filter((candidate): candidate is string => Boolean(candidate));
	for (const candidate of candidates) {
		const cliPath = path.resolve(packageRoot, candidate);
		if (fs.existsSync(cliPath)) return cliPath;
	}
	return undefined;
}

function resolveJitiCliPath(): string | undefined {
	const candidates: Array<() => string | undefined> = [
		() => require.resolve("jiti/package.json"),
		() => piPackageRoot
			? createRequire(path.join(piPackageRoot, "package.json")).resolve("jiti/package.json")
			: undefined,
		() => {
			if (!process.argv[1]) return undefined;
			const piEntry = fs.realpathSync(process.argv[1]);
			return createRequire(piEntry).resolve("jiti/package.json");
		},
		() => piPackageRoot ? path.join(piPackageRoot, "node_modules", "jiti", "package.json") : undefined,
	];
	for (const candidate of candidates) {
		try {
			const packageJsonPath = candidate();
			if (!packageJsonPath) continue;
			const cliPath = resolveJitiCliFromPackageJson(packageJsonPath);
			if (cliPath) return cliPath;
		} catch {
			// Candidate not available in this install, continue probing.
		}
	}
	return undefined;
}

const jitiCliPath = resolveJitiCliPath();

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
	permissions?: unknown;
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
	toolBudget?: ResolvedToolBudget | ToolBudgetConfig;
	configToolBudget?: ResolvedToolBudget;
	/** Global cap on simultaneously-running subagent tasks within the async run. */
	globalConcurrencyLimit?: number;
	capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
	usageBudget?: UsageBudgetConfig;
	parentWorkflowRunId?: string;
	workflowKey?: string;
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
	turnBudget?: ResolvedTurnBudget | TurnBudgetConfig;
	toolBudget?: ResolvedToolBudget | ToolBudgetConfig;
	configToolBudget?: ResolvedToolBudget;
	capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
	usageBudget?: UsageBudgetConfig;
	parentWorkflowRunId?: string;
	workflowKey?: string;
	allowZeroToolBudget?: boolean;
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
	subagentRuntime?: SubagentRuntime;
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
	toolBudget?: ResolvedToolBudget | ToolBudgetConfig;
	configToolBudget?: ResolvedToolBudget;
	capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
}

function resolveProgrammaticToolPlan(
	requestedTools: string[] | undefined,
	capabilityCeiling: ResolvedSubagentCapabilityCeiling | undefined,
	structuredOutput: boolean,
	additionalTools: readonly string[] = [],
): { tools?: string[]; audit?: SubagentCapabilityAudit } {
	const allowed = capabilityCeiling?.allowedTools ? new Set(capabilityCeiling.allowedTools) : undefined;
	const effectiveAdditionalTools = additionalTools.filter((tool) => !allowed || allowed.has(tool));
	const effectiveRequestedTools = requestedTools?.filter((tool) => !allowed || allowed.has(tool));
	const effectiveTools = requestedTools === undefined
		? (allowed ? [...new Set([...allowed, ...effectiveAdditionalTools])] : undefined)
		: [...new Set([...(effectiveRequestedTools ?? []), ...effectiveAdditionalTools])];
	const internalTools = structuredOutput ? ["structured_output"] : [];
	const auditedTools = [...new Set([...(effectiveTools ?? []), ...effectiveAdditionalTools, ...internalTools])];
	return {
		...(effectiveTools ? { tools: effectiveTools } : {}),
		...(capabilityCeiling ? {
			audit: {
				ceiling: capabilityCeiling,
				...(requestedTools ? { requestedTools } : {}),
				effectiveTools: auditedTools,
				removedTools: requestedTools?.filter((tool) => !effectiveRequestedTools?.includes(tool)) ?? [],
				internalTools,
				extensionsDenied: capabilityCeiling.denyExtensions,
				removedExtensionCount: 0,
				requestedMcpToolCount: 0,
				effectiveMcpTools: [],
			},
		} : {}),
	};
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

/**
 * Check if async execution is available through either the Desktop runtime or
 * the upstream detached runner.
 */
export function isAsyncAvailable(subagentRuntime?: SubagentRuntime): boolean {
	return subagentRuntime !== undefined || jitiCliPath !== undefined;
}

function isNodeExecutableName(execPath: string): boolean {
	const basename = path.basename(execPath).toLowerCase();
	return basename === "node" || basename === "node.exe" || basename === "nodejs" || basename === "nodejs.exe";
}

function canUseCurrentNodeExecutable(execPath: string): boolean {
	try {
		fs.accessSync(execPath, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function resolveAsyncRunnerNodeCommand(): string {
	if (isNodeExecutableName(process.execPath) && canUseCurrentNodeExecutable(process.execPath)) return process.execPath;
	return process.platform === "win32" ? "node.exe" : "node";
}

export function resolveAsyncRunnerLogPaths(cfg: object): { stdoutPath: string; stderrPath: string } | undefined {
	const asyncDir = typeof (cfg as { asyncDir?: unknown }).asyncDir === "string"
		? (cfg as { asyncDir: string }).asyncDir
		: undefined;
	if (!asyncDir) return undefined;
	return {
		stdoutPath: path.join(asyncDir, "runner.stdout.log"),
		stderrPath: path.join(asyncDir, "runner.stderr.log"),
	};
}

function closeFd(fd: number | undefined): void {
	if (fd === undefined) return;
	try {
		fs.closeSync(fd);
	} catch {
		// Best-effort cleanup; the child already owns its duplicated descriptor.
	}
}

const RUNNER_STARTUP_TIMEOUT_MS = 10_000;
const RUNNER_STARTUP_WAIT_BUFFER = typeof SharedArrayBuffer !== "undefined" ? new SharedArrayBuffer(4) : undefined;
const RUNNER_STARTUP_WAIT_VIEW = RUNNER_STARTUP_WAIT_BUFFER ? new Int32Array(RUNNER_STARTUP_WAIT_BUFFER) : undefined;

type RunnerStartupState = "ready" | "acknowledged";

type RunnerStartupWaitResult =
	| { ok: true; token: string }
	| { ok: false; error: string };

function waitForStartupInterval(delayMs = 20): void {
	if (RUNNER_STARTUP_WAIT_VIEW) {
		Atomics.wait(RUNNER_STARTUP_WAIT_VIEW, 0, 0, delayMs);
		return;
	}
	const waitUntil = Date.now() + delayMs;
	while (Date.now() < waitUntil) {
		// Startup handshakes are synchronous so resume rejects before reporting a run as started.
	}
}

function readRunnerStartup(startupPath: string, expectedState: RunnerStartupState, expectedToken?: string): RunnerStartupWaitResult | undefined {
	if (!fs.existsSync(startupPath)) return undefined;
	try {
		const payload = JSON.parse(fs.readFileSync(startupPath, "utf-8")) as { state?: unknown; token?: unknown; error?: unknown };
		if (payload.state === "error" && typeof payload.error === "string") return { ok: false, error: payload.error };
		if (payload.state !== expectedState) return undefined;
		if (typeof payload.token !== "string" || (expectedToken !== undefined && payload.token !== expectedToken)) {
			return { ok: false, error: `Async runner wrote an invalid ${expectedState} startup handshake: ${startupPath}` };
		}
		return { ok: true, token: payload.token };
	} catch (error) {
		return { ok: false, error: `Failed to read async runner startup handshake '${startupPath}': ${error instanceof Error ? error.message : String(error)}` };
	}
}

function waitForRunnerStartup(startupPath: string, expectedState: RunnerStartupState, timeoutMs: number, expectedToken?: string): RunnerStartupWaitResult {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const result = readRunnerStartup(startupPath, expectedState, expectedToken);
		if (result) return result;
		if (Date.now() >= deadline) break;
		waitForStartupInterval(Math.min(20, Math.max(1, deadline - Date.now())));
	}
	const finalResult = readRunnerStartup(startupPath, expectedState, expectedToken);
	if (finalResult) return finalResult;
	return { ok: false, error: `Timed out after ${timeoutMs}ms waiting for the async runner startup state '${expectedState}'.` };
}

function writeRunnerStartupControl(filePath: string, payload: { action: "ack" | "proceed"; token: string }): void {
	writePrivateAtomicJson(filePath, payload);
}

function runnerIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function terminateRunnerBeforeProceed(pid: number): void {
	for (const signal of ["SIGTERM", "SIGKILL"] as const) {
		if (!runnerIsAlive(pid)) return;
		try {
			process.kill(pid, signal);
		} catch {
			if (!runnerIsAlive(pid)) return;
		}
		const deadline = Date.now() + 1000;
		while (runnerIsAlive(pid) && Date.now() < deadline) waitForStartupInterval();
	}
}

function spawnRunner(cfg: object, suffix: string, cwd: string, onProcessTerminal?: (proof: unknown) => void): { pid?: number; error?: string } {
	if (!jitiCliPath) return { error: "upstream jiti for TypeScript execution could not be found; ensure package dependencies are installed" };
	try {
		const cwdStats = fs.statSync(cwd);
		if (!cwdStats.isDirectory()) return { error: `cwd is not a directory: ${cwd}` };
	} catch {
		return { error: `cwd does not exist: ${cwd}` };
	}

	fs.mkdirSync(TEMP_ROOT_DIR, { recursive: true });
	const cfgPath = getAsyncConfigPath(suffix);
	const runnerProcessInstanceId = randomUUID();
	const launchConfig = { ...cfg, runnerProcessInstanceId };
	fs.writeFileSync(cfgPath, JSON.stringify(launchConfig));
	const runner = path.join(path.dirname(fileURLToPath(import.meta.url)), "subagent-runner.ts");
	const nodeCommand = resolveAsyncRunnerNodeCommand();
	const launchForStartup = launchConfig as typeof launchConfig & { asyncDir?: unknown; revivalLease?: unknown };
	const launchAsyncDir = typeof launchForStartup.asyncDir === "string" ? launchForStartup.asyncDir : undefined;
	const startupPath = typeof launchForStartup.revivalLease === "object" && launchAsyncDir
		? path.join(launchAsyncDir, "runner-startup.json")
		: undefined;
	const startupAckPath = startupPath ? path.join(path.dirname(startupPath), "runner-startup-ack.json") : undefined;
	const startupProceedPath = startupPath ? path.join(path.dirname(startupPath), "runner-startup-proceed.json") : undefined;
	if (startupPath) fs.rmSync(startupPath, { force: true });
	if (startupAckPath) fs.rmSync(startupAckPath, { force: true });
	if (startupProceedPath) fs.rmSync(startupProceedPath, { force: true });

	const logPaths = resolveAsyncRunnerLogPaths(launchConfig);
	let stdoutFd: number | undefined;
	let stderrFd: number | undefined;
	try {
		if (logPaths) {
			fs.mkdirSync(path.dirname(logPaths.stdoutPath), { recursive: true });
			stdoutFd = fs.openSync(logPaths.stdoutPath, "a");
			stderrFd = fs.openSync(logPaths.stderrPath, "a");
		}
		const proc = spawn(nodeCommand, [jitiCliPath, runner, cfgPath], {
			cwd,
			detached: true,
			stdio: ["ignore", stdoutFd ?? "ignore", stderrFd ?? "ignore"],
			windowsHide: true,
			env: {
				...process.env,
				...(piPackageRoot ? { [PI_CODING_AGENT_PACKAGE_ROOT_ENV]: piPackageRoot } : {}),
			},
		});
		closeFd(stdoutFd);
		closeFd(stderrFd);
		proc.on("error", (error) => console.error(`[pi-subagents] async spawn failed: ${error.message}`));
		proc.once("close", (exitCode, signal) => {
			const launch = launchConfig as { asyncDir?: unknown; id?: unknown; nestedRoute?: NestedRouteInfo; nestedSelf?: { parentRunId: string; parentStepIndex?: number; depth: number; path?: Array<{ runId: string; stepIndex?: number; agent?: string }> } };
			const asyncDir = launch.asyncDir;
			const runId = launch.id;
			if (typeof asyncDir !== "string" || typeof runId !== "string") return;
			finalizeProcessTerminal(asyncDir, runId, { processInstanceId: runnerProcessInstanceId, closeObservedAt: Date.now(), exitCode, signal });
			const persisted = readProcessTerminal(asyncDir, { runId, runnerProcessInstanceId });
			if (!persisted) return;
			if (launch.nestedRoute && launch.nestedSelf) {
				try {
					let status: import("../../shared/types.ts").AsyncStatus;
					try {
						status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf-8")) as import("../../shared/types.ts").AsyncStatus;
						status.processTerminal = persisted;
					} catch {
						status = { runId, mode: "single", state: persisted.state === "observed" ? "complete" : "failed", startedAt: persisted.observedAt ?? Date.now(), lastUpdate: Date.now(), processTerminal: persisted };
					}
					writeNestedEvent(launch.nestedRoute, {
						type: "subagent.nested.completed",
						ts: Date.now(),
						parentRunId: launch.nestedSelf.parentRunId,
						parentStepIndex: launch.nestedSelf.parentStepIndex,
						child: nestedSummaryFromAsyncStatus(status, asyncDir, { id: runId, parentRunId: launch.nestedSelf.parentRunId, parentStepIndex: launch.nestedSelf.parentStepIndex, depth: launch.nestedSelf.depth, path: launch.nestedSelf.path, mode: status.mode, ts: Date.now() }),
					});
				} catch (error) {
					console.error("Failed to emit final nested process-terminal status:", error);
				}
			}
			onProcessTerminal?.(persisted);
		});
		if (typeof proc.pid !== "number") return { error: `async runner did not produce a pid for cwd: ${cwd}` };
		proc.unref();
		if (startupPath && startupAckPath && startupProceedPath) {
			const ready = waitForRunnerStartup(startupPath, "ready", RUNNER_STARTUP_TIMEOUT_MS);
			if (ready.ok === false) {
				terminateRunnerBeforeProceed(proc.pid);
				return { error: ready.error };
			}
			try {
				writeRunnerStartupControl(startupAckPath, { action: "ack", token: ready.token });
			} catch (error) {
				terminateRunnerBeforeProceed(proc.pid);
				return { error: `Failed to acknowledge async runner startup: ${error instanceof Error ? error.message : String(error)}` };
			}
			const acknowledged = waitForRunnerStartup(startupPath, "acknowledged", RUNNER_STARTUP_TIMEOUT_MS, ready.token);
			if (acknowledged.ok === false) {
				terminateRunnerBeforeProceed(proc.pid);
				return { error: acknowledged.error };
			}
			try {
				writeRunnerStartupControl(startupProceedPath, { action: "proceed", token: ready.token });
			} catch (error) {
				terminateRunnerBeforeProceed(proc.pid);
				return { error: `Failed to authorize async runner startup: ${error instanceof Error ? error.message : String(error)}` };
			}
			try {
				fs.rmSync(startupPath, { force: true });
			} catch {
				// Proceed is the commit point; cleanup cannot turn a running revival into a start error.
			}
		}
		return { pid: proc.pid };
	} catch (error) {
		closeFd(stdoutFd);
		closeFd(stderrFd);
		return { error: error instanceof Error ? error.message : String(error) };
	}
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
				: isCheckpointStep(firstStep)
					? firstStep.message ?? `Checkpoint: ${firstStep.checkpoint}`
					: (firstStep as SequentialStep).task)
		: undefined);
	try {
		if (params.validateOutputBindings !== false) {
			validateChainOutputBindings(graphChain, { maxItems: params.dynamicFanoutMaxItems });
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
				: isCheckpointStep(s)
					? []
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
		taskTemplate = taskTemplate.replace(/\{task\}/g, () => originalTask ?? "");
		taskTemplate = taskTemplate.replace(/\{chain_dir\}/g, () => runnerCwd);
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
		const modelCandidates = buildModelCandidates(primaryModel, a.fallbackModels, availableModels, ctx.currentModelProvider, { scope: ctx.modelScope }).map((candidate) =>
			applyThinkingSuffix(candidate, effectiveThinking, thinkingOverride !== undefined) ?? candidate,
		);
		const childExtensions = resolveChildExtensions(params.subagentRuntime, {
			denyExtensions: params.capabilityCeiling?.denyExtensions,
			allowedTools: params.capabilityCeiling?.allowedTools,
		});
		const childTools = childExtensionTools(childExtensions);
		const toolPlan = resolveProgrammaticToolPlan(
			a.tools,
			params.capabilityCeiling,
			Boolean(s.outputSchema),
			childTools,
		);
		const launchContractDigest = launchBindingDigest({
			definitionDigest: agentDefinitionDigest(a),
			task: s.task ?? originalTask,
			...(model ? { model } : {}),
			modelCandidates,
			...(resolveEffectiveThinking(model, effectiveThinking) ? { thinking: resolveEffectiveThinking(model, effectiveThinking) } : {}),
			systemPrompt: appendTurnBudgetSystemPrompt(systemPrompt, undefined),
			systemPromptMode: a.systemPromptMode,
			inheritProjectContext: a.inheritProjectContext,
			inheritSkills: a.inheritSkills,
			skills: resolvedSkills.map((skill) => skill.name),
			tools: toolPlan.tools,
			extensions: params.capabilityCeiling?.denyExtensions ? [] : a.extensions,
			...(childExtensions.length || a.subagentOnlyExtensions?.length
				? {
					subagentOnlyExtensions: [
						...(params.capabilityCeiling?.denyExtensions ? [] : a.subagentOnlyExtensions ?? []),
						...childExtensions.map((extension) => extension.path),
					],
				}
				: {}),
			mcpDirectTools: params.capabilityCeiling?.denyExtensions ? [] : a.mcpDirectTools,
			...(outputPath ? { outputPath } : {}),
			outputMode: behavior.outputMode,
			...(s.outputSchema ? { structuredOutputSchema: s.outputSchema } : {}),
		});
		const agentContract = s.agentContract ?? params.agentContract;
		return {
			parentSessionId: ctx.parentSessionId ?? ctx.currentSessionId,
			...(params.capabilityCeiling ? { capabilityCeiling: params.capabilityCeiling } : {}),
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
			modelCandidates,
			tools: toolPlan.tools,
			...(toolPlan.audit ? { capabilityAudit: toolPlan.audit } : {}),
			definitionDigest: agentDefinitionDigest(a),
			launchBindingTask: s.task ?? originalTask,
			launchContractDigest,
			extensions: params.capabilityCeiling?.denyExtensions ? [] : a.extensions,
			childExtensions: [...childExtensions],
			...(childExtensions.length || a.subagentOnlyExtensions?.length
				? {
					subagentOnlyExtensions: [
						...(params.capabilityCeiling?.denyExtensions ? [] : a.subagentOnlyExtensions ?? []),
						...childExtensions.map((extension) => extension.path),
					],
				}
				: {}),
			mcpDirectTools: params.capabilityCeiling?.denyExtensions ? [] : a.mcpDirectTools,
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
			if (isCheckpointStep(s)) {
				return { checkpoint: s.checkpoint, ...(s.message ? { message: s.message } : {}), phase: s.phase, label: s.label };
			}
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
	const capabilityCeiling = params.capabilityCeiling ?? resolveCurrentSubagentCapabilityCeiling(ctx.currentSessionId);
	const inheritedNestedRoute = resolveInheritedNestedRouteFromEnv();
	const nestedAddress = inheritedNestedRoute ? resolveNestedParentAddressFromEnv() : undefined;
	const asyncDir = inheritedNestedRoute
		? path.join(TEMP_ROOT_DIR, "nested-subagent-runs", inheritedNestedRoute.rootRunId, id)
		: path.join(DIRS.async, id);
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
		subagentRuntime: params.subagentRuntime,
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
		capabilityCeiling,
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
		const resultPath = inheritedNestedRoute ? nestedResultsPath(inheritedNestedRoute.rootRunId, id) : path.join(DIRS.results, `${id}.json`);
		const eventsPath = path.join(asyncDir, "events.jsonl");
		const now = Date.now();
		const { agents: flatAgentsProg, parallelGroups: parallelGroupsProg } = flattenProgrammaticSteps(steps);
		writeAtomicJson(path.join(asyncDir, "status.json"), {
			lifecycleArtifactVersion: SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
			runId: id,
			sessionId: ctx.currentSessionId,
			mode: resultMode,
			state: "running",
			acceptingAppends: true,
			startedAt: now,
			lastUpdate: now,
			asyncDir,
			cwd: runnerCwd,
			chainStepCount: eventChain.length,
			currentStep: 0,
			parallelGroups: parallelGroupsProg,
			...(capabilityCeiling ? { capabilityCeiling } : {}),
			steps: flattenProgrammaticStepDetails(steps),
		});
		// Fire-and-forget consumer
		consumeAsyncChainRun(params.subagentRuntime, id, steps, {
			resultMode,
			asyncDir,
			resultPath,
			eventsPath,
			runnerCwd,
			sessionId: ctx.currentSessionId,
			globalConcurrencyLimit: params.globalConcurrencyLimit,
			dynamicFanoutMaxItems: params.dynamicFanoutMaxItems,
			deadlineAt,
			turnBudget: params.turnBudget,
			worktreeSetupHook,
			worktreeSetupHookTimeoutMs,
			worktreeBaseDir,
			capabilityCeiling,
		}).catch((error) => {
			const errMsg = error instanceof Error ? error.message : String(error);
			const cancelled = consumeChainAppendRequests(asyncDir);
			const cancelledAt = Date.now();
			for (const request of cancelled) {
				appendJsonl(eventsPath, JSON.stringify({
					type: "subagent.chain.append.cancelled",
					ts: cancelledAt,
					runId: id,
					requestId: request.id,
					stepCount: request.steps.length,
					reason: "The async chain consumer failed before appended steps became eligible.",
					pendingAppends: 0,
				}));
			}
			const latestStatus = readStatus(asyncDir) ?? { runId: id, mode: resultMode, state: "running" as const, startedAt: now, lastUpdate: now };
			latestStatus.state = "failed";
			(latestStatus as unknown as Record<string, unknown>).acceptingAppends = false;
			(latestStatus as unknown as Record<string, unknown>).pendingAppends = 0;
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
				: isCheckpointStep(eventFirstStep)
					? [`checkpoint:${eventFirstStep.checkpoint}`]
					: [(eventFirstStep as SequentialStep).agent];
		const firstTask = isParallelStep(eventFirstStep)
			? eventFirstStep.parallel[0]?.task
			: isDynamicParallelStep(eventFirstStep)
				? eventFirstStep.parallel.task
				: isCheckpointStep(eventFirstStep)
					? eventFirstStep.message ?? `Checkpoint: ${eventFirstStep.checkpoint}`
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
						...(capabilityCeiling ? { capabilityCeiling } : {}),
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
			...(capabilityCeiling ? { capabilityCeiling } : {}),
			nestedRoute,
		});
		const chainDesc = chain
			.map((s) =>
				isParallelStep(s) ? `[${s.parallel.map((t) => t.agent).join("+")}]` : isDynamicParallelStep(s) ? `expand:${s.parallel.agent}` : isCheckpointStep(s) ? `checkpoint:${s.checkpoint}` : (s as SequentialStep).agent,
			)
			.join(" -> ");
		return {
			content: [{ type: "text", text: formatAsyncStartedMessage(`Async ${resultMode}: ${chainDesc} [${id}]`, ctx.interactive === true) }],
			details: { mode: resultMode, runId: id, results: [], asyncId: id, asyncDir, workflowGraph, ...(capabilityCeiling ? { capabilityCeiling } : {}), ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs, deadlineAt } : {}), ...(params.turnBudget ? { turnBudget: params.turnBudget } : {}), ...(params.toolBudget ? { toolBudget: params.toolBudget } : {}) },
		};
	}

	let spawnResult: { pid?: number; error?: string } = {};
	try {
		spawnResult = spawnRunner(
			{
				id,
				steps,
				resultPath: inheritedNestedRoute ? nestedResultsPath(inheritedNestedRoute.rootRunId, id) : path.join(DIRS.results, `${id}.json`),
				cwd: runnerCwd,
				placeholder: "{previous}",
				maxOutput,
				artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
				artifactConfig,
				share: shareEnabled,
				sessionDir: sessionRoot ? path.join(sessionRoot, `async-${id}`) : undefined,
				asyncDir,
				sessionId: ctx.currentSessionId,
				...(capabilityCeiling ? { capabilityCeiling } : {}),
				piPackageRoot,
				piArgv1: process.argv[1],
				worktreeSetupHook,
				worktreeSetupHookTimeoutMs,
				worktreeBaseDir,
				controlConfig,
				turnBudget: params.turnBudget,
				toolBudget: params.toolBudget,
				usageBudget: params.usageBudget,
				controlIntercomTarget,
				childIntercomTargets,
				resultMode,
				dynamicFanoutMaxItems: params.dynamicFanoutMaxItems,
				timeoutMs: params.timeoutMs,
				deadlineAt,
				globalConcurrencyLimit: params.globalConcurrencyLimit,
				workflowGraph,
				...(params.parentWorkflowRunId ? { parentWorkflowRunId: params.parentWorkflowRunId } : {}),
				...(params.workflowKey ? { workflowKey: params.workflowKey } : {}),
				nestedRoute: nestedRoute ?? inheritedNestedRoute,
				nestedSelf: inheritedNestedRoute && nestedAddress ? {
					parentRunId: nestedAddress.parentRunId,
					parentStepIndex: nestedAddress.parentStepIndex,
					depth: nestedAddress.depth,
					path: nestedAddress.path,
				} : undefined,
			},
			id,
			runnerCwd,
			(proof) => ctx.pi.events.emit(SUBAGENT_PROCESS_TERMINAL_EVENT, proof),
		);
	} catch (error) {
		return formatAsyncStartError(resultMode, `Failed to start async ${resultMode} '${id}': ${error instanceof Error ? error.message : String(error)}`);
	}
	if (spawnResult.error) return formatAsyncStartError(resultMode, `Failed to start async ${resultMode} '${id}': ${spawnResult.error}`);

	const eventFirstStep = eventChain[0];
	if (!eventFirstStep) return formatAsyncStartError(resultMode, `Failed to start async ${resultMode} '${id}': event chain has no steps`);
	const firstAgents = isParallelStep(eventFirstStep)
		? eventFirstStep.parallel.map((t) => t.agent)
		: isDynamicParallelStep(eventFirstStep)
			? [eventFirstStep.parallel.agent]
			: isCheckpointStep(eventFirstStep)
				? [`checkpoint:${eventFirstStep.checkpoint}`]
				: [(eventFirstStep as SequentialStep).agent];
	const firstTask = isParallelStep(eventFirstStep)
		? eventFirstStep.parallel[0]?.task
		: isDynamicParallelStep(eventFirstStep)
			? eventFirstStep.parallel.task
			: isCheckpointStep(eventFirstStep)
				? eventFirstStep.message ?? `Checkpoint: ${eventFirstStep.checkpoint}`
				: (eventFirstStep as SequentialStep).task;
	const workflowGoal = params.goal ?? (params.task?.trim() || firstTask);
	const parallelGroups: Array<{ start: number; count: number; stepIndex: number }> = [];
	const flatAgents: string[] = [];
	let flatStepStart = 0;
	for (let stepIndex = 0; stepIndex < eventChain.length; stepIndex++) {
		const step = eventChain[stepIndex]!;
		if (isParallelStep(step)) {
			parallelGroups.push({ start: flatStepStart, count: step.parallel.length, stepIndex });
			flatAgents.push(...step.parallel.map((task) => task.agent));
			flatStepStart += step.parallel.length;
		} else if (isDynamicParallelStep(step)) {
			parallelGroups.push({ start: flatStepStart, count: 1, stepIndex });
			flatAgents.push(step.parallel.agent);
			flatStepStart++;
		} else if (isCheckpointStep(step)) {
			flatAgents.push(`checkpoint:${step.checkpoint}`);
			flatStepStart++;
		} else {
			flatAgents.push((step as SequentialStep).agent);
			flatStepStart++;
		}
	}
	const now = Date.now();
	if (spawnResult.pid && inheritedNestedRoute && nestedAddress) {
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
					pid: spawnResult.pid,
					ownerIntercomTarget: process.env.PI_SUBAGENT_INTERCOM_SESSION_NAME,
					leafIntercomTarget: childIntercomTargets?.[0],
					intercomTarget: childIntercomTargets?.[0],
					ownerState: "live",
					mode: resultMode,
					state: "running",
					agent: firstAgents[0],
					agents: flatAgents,
					chainStepCount: eventChain.length,
					parallelGroups,
					...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs, deadlineAt } : {}),
					...(params.turnBudget ? { turnBudget: params.turnBudget } : {}),
					startedAt: now,
					lastUpdate: now,
					...(capabilityCeiling ? { capabilityCeiling } : {}),
				},
			});
		} catch (error) {
			console.error("Failed to emit nested async start event:", error);
		}
	}
	ctx.pi.events.emit(SUBAGENT_ASYNC_STARTED_EVENT, {
		lifecycleArtifactVersion: SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
		id,
		pid: spawnResult.pid,
		sessionId: ctx.currentSessionId,
		mode: resultMode,
		agent: firstAgents[0],
		agents: flatAgents,
		task: firstTask?.slice(0, 50),
		goal: workflowGoal?.slice(0, 120),
		chain: eventChain.map((step) =>
			isParallelStep(step)
				? `[${step.parallel.map((task) => task.agent).join("+")}]`
				: isDynamicParallelStep(step)
					? `expand:${step.parallel.agent}`
					: isCheckpointStep(step)
						? `checkpoint:${step.checkpoint}`
						: (step as SequentialStep).agent,
		),
		chainStepCount: eventChain.length,
		parallelGroups,
		workflowGraph,
		cwd: runnerCwd,
		asyncDir,
	...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs, deadlineAt } : {}),
		...(params.turnBudget ? { turnBudget: params.turnBudget } : {}),
		...(capabilityCeiling ? { capabilityCeiling } : {}),
		nestedRoute,
	});
	const chainDesc = chain
		.map((step) =>
			isParallelStep(step)
				? `[${step.parallel.map((task) => task.agent).join("+")}]`
				: isDynamicParallelStep(step)
					? `expand:${step.parallel.agent}`
					: isCheckpointStep(step)
						? `checkpoint:${step.checkpoint}`
						: (step as SequentialStep).agent,
		)
		.join(" -> ");
	return {
		content: [{ type: "text", text: formatAsyncStartedMessage(`Async ${resultMode}: ${chainDesc} [${id}]`, ctx.interactive === true) }],
		details: { mode: resultMode, runId: id, results: [], asyncId: id, asyncDir, workflowGraph, ...(capabilityCeiling ? { capabilityCeiling } : {}), ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs, deadlineAt } : {}), ...(params.turnBudget ? { turnBudget: params.turnBudget } : {}), ...(params.toolBudget ? { toolBudget: params.toolBudget } : {}) },
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
	const capabilityCeiling = params.capabilityCeiling ?? resolveCurrentSubagentCapabilityCeiling(ctx.currentSessionId);
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
		: path.join(DIRS.async, id);
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
	systemPrompt = appendTurnBudgetSystemPrompt(systemPrompt, params.turnBudget);
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
	const writerSessionDir = sessionFile ? path.dirname(sessionFile) : resolvedSessionDir;
	const structuredOutput = params.structuredOutputSchema
		? createStructuredOutputRuntime(params.structuredOutputSchema, path.join(asyncDir, "structured-output"))
		: undefined;
	const modelCandidates = buildModelCandidates(primaryModel, agentConfig.fallbackModels, availableModels, ctx.currentModelProvider, { scope: ctx.modelScope }).map((candidate) =>
		applyThinkingSuffix(candidate, effectiveThinking, params.thinkingOverride !== undefined) ?? candidate,
	);
	const childExtensions = resolveChildExtensions(params.subagentRuntime, {
		denyExtensions: capabilityCeiling?.denyExtensions,
		allowedTools: capabilityCeiling?.allowedTools,
	});
	const childTools = childExtensionTools(childExtensions);
	const toolPlan = resolveProgrammaticToolPlan(
		agentConfig.tools,
		capabilityCeiling,
		Boolean(params.structuredOutputSchema),
		childTools,
	);
	const launchContractDigest = launchBindingDigest({
		definitionDigest: agentDefinitionDigest(agentConfig),
		task,
		...(model ? { model } : {}),
		modelCandidates,
		...(resolveEffectiveThinking(model, effectiveThinking) ? { thinking: resolveEffectiveThinking(model, effectiveThinking) } : {}),
		systemPrompt,
		systemPromptMode: agentConfig.systemPromptMode,
		inheritProjectContext: agentConfig.inheritProjectContext,
		inheritSkills: agentConfig.inheritSkills,
		skills: resolvedSkills.map((skill) => skill.name),
		tools: toolPlan.tools,
		extensions: capabilityCeiling?.denyExtensions ? [] : agentConfig.extensions,
		...(childExtensions.length || agentConfig.subagentOnlyExtensions?.length
			? {
				subagentOnlyExtensions: [
					...(capabilityCeiling?.denyExtensions ? [] : agentConfig.subagentOnlyExtensions ?? []),
					...childExtensions.map((extension) => extension.path),
				],
			}
			: {}),
		mcpDirectTools: capabilityCeiling?.denyExtensions ? [] : agentConfig.mcpDirectTools,
		...(outputPath ? { outputPath } : {}),
		outputMode,
		...(params.structuredOutputSchema ? { structuredOutputSchema: params.structuredOutputSchema } : {}),
	});
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
		launchContractDigest,
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
		...(systemPrompt ? { systemPrompt } : {}),
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
		...(writerSessionDir ? { sessionDir: writerSessionDir } : {}),
		...(artifactsDir ? { artifactsDir } : {}),
		artifactConfig,
		...(capabilityCeiling ? { capabilityCeiling } : {}),
	};
	try {
		writePrivateAtomicJson(path.join(asyncDir, "recovery-descriptor.json"), recoveryDescriptor);
	} catch (error) {
		return formatAsyncStartError("single", `Failed to persist async recovery descriptor for '${id}': ${error instanceof Error ? error.message : String(error)}`);
	}

	// Programmatic branch: use SubagentRuntime instead of detached CLI runner
	if (params.subagentRuntime) {
		const resultPath = inheritedNestedRoute ? nestedResultsPath(inheritedNestedRoute.rootRunId, id) : path.join(DIRS.results, `${id}.json`);
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
			launchContractDigest,
			...(capabilityCeiling ? { capabilityCeiling } : {}),
			steps: [{
				index: 0,
				agent,
				status: "running" as const,
				startedAt: now,
				...(model ? { model } : {}),
				...(resolveEffectiveThinking(model, effectiveThinking) ? { thinking: resolveEffectiveThinking(model, effectiveThinking) } : {}),
				attemptedModels: [],
				launchContractDigest,
				...(capabilityCeiling ? { capabilityCeiling } : {}),
				...(toolPlan.audit ? { capabilityAudit: toolPlan.audit } : {}),
			}],
		});
		// Programmatic workers receive thinking separately from the base model ID.
		const programmaticModel = model ? splitKnownThinkingSuffix(model).baseModel : undefined;
		const programmaticThinking = resolveEffectiveThinking(model, effectiveThinking);
		const request: SubagentRuntimeRunRequest = {
			runId: id,
			rootRunId: id,
			childIndex: 0,
			depth: 1,
			maxDepth: Math.max(1, resolveChildMaxSubagentDepth(maxSubagentDepth, agentConfig.maxSubagentDepth)),
			lineage: [],
			...(ctx.parentSessionId ?? ctx.currentSessionId
				? { parentSessionId: ctx.parentSessionId ?? ctx.currentSessionId }
				: {}),
			agent,
			task: taskWithOutputInstruction,
			cwd: runnerCwd,
			...(sessionFile ? { sessionFile } : {}),
			...(writerSessionDir ? { sessionDir: writerSessionDir } : {}),
			persistSession: Boolean(writerSessionDir || sessionFile || shareEnabled),
			...(programmaticModel ? { model: programmaticModel } : {}),
			...(ctx.currentModelProvider ? { preferredProvider: ctx.currentModelProvider } : {}),
			...(programmaticThinking ? { thinking: programmaticThinking as SubagentRuntimeRunRequest["thinking"] } : {}),
			...(toolPlan.tools ? { tools: toolPlan.tools } : {}),
			childExtensions,
			...(systemPrompt ? { systemPrompt } : {}),
			systemPromptMode: agentConfig.systemPromptMode,
			inheritProjectContext: agentConfig.inheritProjectContext,
			inheritSkills: agentConfig.inheritSkills,
			extensionProfile: (toolPlan.tools?.includes("subagent") ? ["provider" as SubagentExtensionProfile, "runtime" as SubagentExtensionProfile, "fanout" as SubagentExtensionProfile] : ["provider" as SubagentExtensionProfile, "runtime" as SubagentExtensionProfile]),
			...(timeoutMs !== undefined ? { timeoutMs } : {}),
			...(params.turnBudget ? { turnBudget: params.turnBudget } : {}),
			...(resolvedToolBudget.budget ? { toolBudget: resolvedToolBudget.budget } : {}),
			...(structuredOutput
				? { structuredOutput: { schema: structuredOutput.schema as never, outputPath: structuredOutput.outputPath } }
				: {}),
		};
		// Fire-and-forget consumer writes events + final result to filesystem
		consumeAsyncSingleRun(params.subagentRuntime, request, {
			asyncDir,
			resultPath,
			eventsPath,
			resultMode: "single",
			runnerCwd,
			sessionId: ctx.currentSessionId,
			modelCandidates,
			thinking: programmaticThinking,
			launchContractDigest,
			capabilityCeiling,
			capabilityAudit: toolPlan.audit,
			effectiveAcceptance: resolvedAcceptance,
			agentContract: params.agentContract,
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
						...(capabilityCeiling ? { capabilityCeiling } : {}),
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
			launchContractDigest,
			...(timeoutMs !== undefined ? { timeoutMs, deadlineAt } : {}),
			...(initialTurnBudget ? { turnBudget: initialTurnBudget } : {}),
			...(capabilityCeiling ? { capabilityCeiling } : {}),
			nestedRoute,
		});
		return {
			content: [{ type: "text", text: formatAsyncStartedMessage(`Async: ${agent} [${id}]`, ctx.interactive === true) }],
			details: { mode: "single", runId: id, results: [], asyncId: id, asyncDir, launchContractDigest, ...(capabilityCeiling ? { capabilityCeiling } : {}), ...(params.context ? { context: params.context } : {}), ...(timeoutMs !== undefined ? { timeoutMs, deadlineAt } : {}), ...(params.turnBudget ? { turnBudget: params.turnBudget } : {}), ...(params.toolBudget ? { toolBudget: params.toolBudget } : {}) },
		};
	}

	const permissionRules = resolvePermissionRules(ctx.permissions, agentConfig.permissions);
	let spawnResult: { pid?: number; error?: string } = {};
	try {
		spawnResult = spawnRunner(
			{
				id,
				steps: [{
					parentSessionId: ctx.parentSessionId ?? ctx.currentSessionId,
					permissionRules,
					...(capabilityCeiling ? { capabilityCeiling } : {}),
					agent,
					task: taskWithOutputInstruction,
					...(agentConfig.runner ? { runner: agentConfig.runner } : {}),
					...(params.context ? { context: params.context } : {}),
					cwd: runnerCwd,
					model,
					thinking: resolveEffectiveThinking(model, effectiveThinking),
					modelCandidates,
					tools: agentConfig.tools,
					extensions: agentConfig.extensions,
					subagentOnlyExtensions: agentConfig.subagentOnlyExtensions,
					mcpDirectTools: agentConfig.mcpDirectTools,
					completionGuard: agentConfig.completionGuard,
					systemPrompt,
					systemPromptMode: agentConfig.systemPromptMode,
					inheritProjectContext: agentConfig.inheritProjectContext,
					inheritSkills: agentConfig.inheritSkills,
					skills: resolvedSkills.map((skill) => skill.name),
					outputPath,
					outputMode,
					...(sessionFile ? { sessionFile } : {}),
					maxSubagentDepth: resolveChildMaxSubagentDepth(maxSubagentDepth, agentConfig.maxSubagentDepth),
					waitToolEnabled: params.waitToolEnabled,
					...(params.agentContract ? { agentContract: params.agentContract } : {}),
					definitionDigest: agentDefinitionDigest(agentConfig),
					launchBindingTask: task,
					launchContractDigest,
					effectiveAcceptance: resolvedAcceptance,
					...(structuredOutput ? { structuredOutput } : {}),
					...(params.structuredOutputSchema ? { structuredOutputSchema: params.structuredOutputSchema } : {}),
					...(resolvedToolBudget.budget ? { toolBudget: resolvedToolBudget.budget } : {}),
				}],
				resultPath: params.parentWorkflowRunId !== undefined && params.revivalLease !== undefined
					? workflowAwaitedAsyncResultPath(asyncDir)
					: inheritedNestedRoute ? nestedResultsPath(inheritedNestedRoute.rootRunId, id) : path.join(DIRS.results, `${id}.json`),
				cwd: runnerCwd,
				placeholder: "{previous}",
				maxOutput,
				artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
				artifactConfig,
				share: shareEnabled,
				sessionDir: resolvedSessionDir,
				asyncDir,
				sessionId: ctx.currentSessionId,
				...(capabilityCeiling ? { capabilityCeiling } : {}),
				piPackageRoot,
				piArgv1: process.argv[1],
				worktreeSetupHook,
				worktreeSetupHookTimeoutMs,
				worktreeBaseDir,
				controlConfig,
				timeoutMs,
				deadlineAt,
				turnBudget: params.turnBudget,
				toolBudget: params.toolBudget,
				usageBudget: params.usageBudget,
				controlIntercomTarget,
				childIntercomTargets: childIntercomTarget ? [childIntercomTarget(agent, 0)] : undefined,
				resultMode: "single",
				launchContractDigest,
				...(params.parentWorkflowRunId ? { parentWorkflowRunId: params.parentWorkflowRunId } : {}),
				...(params.workflowKey ? { workflowKey: params.workflowKey } : {}),
				...(params.revivalLease ? { revivalLease: params.revivalLease } : {}),
				nestedRoute: nestedRoute ?? inheritedNestedRoute,
				nestedSelf: inheritedNestedRoute && nestedAddress ? {
					parentRunId: nestedAddress.parentRunId,
					parentStepIndex: nestedAddress.parentStepIndex,
					depth: nestedAddress.depth,
					path: nestedAddress.path,
				} : undefined,
			},
			id,
			runnerCwd,
			(proof) => ctx.pi.events.emit(SUBAGENT_PROCESS_TERMINAL_EVENT, proof),
		);
	} catch (error) {
		return formatAsyncStartError("single", `Failed to start async run '${id}': ${error instanceof Error ? error.message : String(error)}`);
	}
	if (spawnResult.error) return formatAsyncStartError("single", `Failed to start async run '${id}': ${spawnResult.error}`);
	if (spawnResult.pid && inheritedNestedRoute && nestedAddress) {
		const startedAt = Date.now();
		try {
			writeNestedEvent(inheritedNestedRoute, {
				type: "subagent.nested.started",
				ts: startedAt,
				parentRunId: nestedAddress.parentRunId,
				parentStepIndex: nestedAddress.parentStepIndex,
				child: {
					id,
					parentRunId: nestedAddress.parentRunId,
					parentStepIndex: nestedAddress.parentStepIndex,
					depth: nestedAddress.depth,
					path: nestedAddress.path,
					asyncDir,
					pid: spawnResult.pid,
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
					startedAt,
					lastUpdate: startedAt,
					...(capabilityCeiling ? { capabilityCeiling } : {}),
				},
			});
		} catch (error) {
			console.error("Failed to emit nested async start event:", error);
		}
	}
	ctx.pi.events.emit(SUBAGENT_ASYNC_STARTED_EVENT, {
		lifecycleArtifactVersion: SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
		id,
		pid: spawnResult.pid,
		sessionId: ctx.currentSessionId,
		mode: "single",
		agent,
		task: task?.slice(0, 50),
		goal: (params.goal ?? task).slice(0, 120),
		cwd: runnerCwd,
		asyncDir,
		launchContractDigest,
		...(params.timeoutMs !== undefined ? { timeoutMs, deadlineAt } : {}),
		...(initialTurnBudget ? { turnBudget: initialTurnBudget } : {}),
		...(capabilityCeiling ? { capabilityCeiling } : {}),
		nestedRoute,
	});
	return {
		content: [{ type: "text", text: formatAsyncStartedMessage(`Async: ${agent} [${id}]`, ctx.interactive === true) }],
		details: { mode: "single", runId: id, results: [], asyncId: id, asyncDir, launchContractDigest, ...(capabilityCeiling ? { capabilityCeiling } : {}), ...(params.context ? { context: params.context } : {}), ...(timeoutMs !== undefined ? { timeoutMs, deadlineAt } : {}), ...(params.turnBudget ? { turnBudget: params.turnBudget } : {}), ...(params.toolBudget ? { toolBudget: resolvedToolBudget.budget ?? params.toolBudget } : {}) } as Details,
	};
}


async function consumeAsyncSingleRun(
	runtime: SubagentRuntime,
	request: SubagentRuntimeRunRequest,
	options: ConsumeAsyncChainOptions,
): Promise<void> {
	const { asyncDir, resultPath, eventsPath, runnerCwd, sessionId } = options;
	const startedAt = Date.now();
	const control = new AbortController();
	let stopRequested = false;
	let interrupted = false;
	const cancel = (state: "stopped" | "paused"): void => {
		stopRequested ||= state === "stopped";
		interrupted ||= state === "paused";
		control.abort();
	};
	const pollPromise = runControlPollLoop(asyncDir, control.signal, {
		onSteer: (steerRequest) => routeProgrammaticSteer(runtime, asyncDir, steerRequest, [request]),
		onStop: () => cancel("stopped"),
		onInterrupt: () => cancel("paused"),
	});
	try {
		const result = await consumeLeafRun(runtime, request, asyncDir, eventsPath, control.signal, options);
		const endedAt = Date.now();
		const state = stopRequested ? "stopped" : interrupted ? "paused" : result.success ? "complete" : "failed";
		const error = result.success ? undefined : stopRequested ? "Async run stopped." : interrupted ? "Async run interrupted." : result.error;
		const terminalStepState: "completed" | "failed" | "paused" | "stopped" = result.success
			? "completed"
			: state === "stopped" || state === "paused"
				? state
				: "failed";
		projectProgrammaticStepResult(asyncDir, { ...result, ...(error ? { error } : {}) }, terminalStepState);
		writeProgrammaticStatus(asyncDir, {
			state,
			error,
			...(result.timedOut ? { timedOut: true } : {}),
			endedAt,
			lastUpdate: endedAt,
			...(result.success ? { currentStep: 1 } : {}),
		});
		writeAtomicJson(resultPath, {
			lifecycleArtifactVersion: SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
			id: request.runId,
			runId: request.runId,
			sessionId,
			agent: request.agent,
			mode: "single",
			success: result.success,
			state,
			summary: result.output || error || `Async run ${request.runId} completed.`,
			...(error ? { error } : {}),
			...(result.timedOut ? { timedOut: true } : {}),
			results: [{
				agent: result.agent,
				output: result.output,
				success: result.success,
				...(error ? { error } : {}),
				...(result.timedOut ? { timedOut: true } : {}),
				...(result.structuredOutput !== undefined ? { structuredOutput: result.structuredOutput } : {}),
				...(result.sessionFile ? { sessionFile: result.sessionFile } : {}),
				...(result.model ? { model: result.model } : {}),
				...(result.thinking ? { thinking: result.thinking } : {}),
				...(result.attemptedModels ? { attemptedModels: result.attemptedModels } : {}),
				...(result.acceptance ? { acceptance: result.acceptance } : {}),
				...(result.launchContractDigest ? { launchContractDigest: result.launchContractDigest } : {}),
				...(result.capabilityCeiling ? { capabilityCeiling: result.capabilityCeiling } : {}),
				...(result.capabilityAudit ? { capabilityAudit: result.capabilityAudit } : {}),
			}],
			...(result.structuredOutput !== undefined ? { structuredOutput: result.structuredOutput } : {}),
			...(request.structuredOutput ? { structuredOutputPath: request.structuredOutput.outputPath } : {}),
			...(result.sessionFile ? { sessionFile: result.sessionFile } : {}),
			...(result.model ? { model: result.model } : {}),
			...(result.thinking ? { thinking: result.thinking } : {}),
			...(result.launchContractDigest ? { launchContractDigest: result.launchContractDigest } : {}),
			...(result.capabilityCeiling ? { capabilityCeiling: result.capabilityCeiling } : {}),
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

interface ConsumeAsyncChainOptions {
	resultMode: string;
	asyncDir: string;
	resultPath: string;
	eventsPath: string;
	runnerCwd: string;
	sessionId: string;
	globalConcurrencyLimit?: number;
	dynamicFanoutMaxItems?: number;
	deadlineAt?: number;
	turnBudget?: ResolvedTurnBudget;
	worktreeSetupHook?: string;
	worktreeSetupHookTimeoutMs?: number;
	worktreeBaseDir?: string;
	capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
	modelCandidates?: string[];
	thinking?: string;
	launchContractDigest?: string;
	capabilityAudit?: SubagentCapabilityAudit;
	effectiveAcceptance?: ResolvedAcceptanceConfig;
	agentContract?: AgentContract;
}

const PROGRAMMATIC_TEXT_PROJECTION_INTERVAL_MS = 1_000;
const PROGRAMMATIC_STREAM_PREVIEW_CHARS = 4_000;
const PROGRAMMATIC_RECENT_OUTPUT_LINES = 10;
const PROGRAMMATIC_RECENT_TOOLS = 20;

interface ProgrammaticLeafResult {
	agent: string;
	index: number;
	output: string;
	success: boolean;
	error?: string;
	cancelled?: boolean;
	skipped?: boolean;
	timedOut?: boolean;
	stopped?: boolean;
	structuredOutput?: unknown;
	sessionFile?: string;
	model?: string;
	thinking?: string;
	attemptedModels?: string[];
	acceptance?: AcceptanceLedger;
	launchContractDigest?: string;
	capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
	capabilityAudit?: SubagentCapabilityAudit;
}

function runnerStepToRequest(
	step: RunnerSubagentStep,
	runId: string,
	childIndex: number,
	cwd: string,
	limits: Pick<ConsumeAsyncChainOptions, "deadlineAt" | "turnBudget">,
	childExtensions: readonly SubagentChildExtension[],
): SubagentRuntimeRunRequest {
	const programmaticModel = step.model ? splitKnownThinkingSuffix(step.model).baseModel : undefined;
	const effectiveChildExtensions = step.childExtensions ?? childExtensions;
	const childTools = childExtensionTools(effectiveChildExtensions);
	const tools = step.tools && step.tools.length > 0
		? [...new Set([...step.tools, ...childTools])]
		: undefined;
	const timeoutMs = limits.deadlineAt === undefined ? undefined : Math.max(0, limits.deadlineAt - Date.now());
	return {
		runId,
		rootRunId: runId,
		childIndex,
		depth: 1,
		maxDepth: Math.max(1, step.maxSubagentDepth ?? 1),
		lineage: [],
		...(step.parentSessionId ? { parentSessionId: step.parentSessionId } : {}),
		agent: step.agent,
		task: step.task,
		cwd: step.cwd ?? cwd,
		...(programmaticModel ? { model: programmaticModel } : {}),
		...(step.thinking ? { thinking: step.thinking as SubagentRuntimeRunRequest["thinking"] } : {}),
		...(tools ? { tools } : {}),
		childExtensions: [...effectiveChildExtensions],
		...(step.systemPrompt ? { systemPrompt: step.systemPrompt } : {}),
		systemPromptMode: step.systemPromptMode ?? "append",
		inheritProjectContext: step.inheritProjectContext,
		inheritSkills: step.inheritSkills,
		...(step.sessionFile ? { sessionFile: step.sessionFile, sessionDir: path.dirname(step.sessionFile) } : {}),
		persistSession: Boolean(step.sessionFile),
		...(step.structuredOutput
			? {
				structuredOutput: {
					schema: step.structuredOutput.schema as never,
					outputPath: step.structuredOutput.outputPath,
				},
			}
			: {}),
		extensionProfile: tools?.includes("subagent")
			? ["provider", "runtime", "fanout"]
			: ["provider", "runtime"],
		...(step.toolBudget ? { toolBudget: step.toolBudget } : {}),
		...(timeoutMs !== undefined ? { timeoutMs } : {}),
		...(limits.turnBudget ? { turnBudget: limits.turnBudget } : {}),
	};
}

async function consumeLeafRun(
	runtime: SubagentRuntime,
	request: SubagentRuntimeRunRequest,
	asyncDir: string,
	eventsPath: string,
	signal: AbortSignal,
	metadata: Pick<ConsumeAsyncChainOptions, "modelCandidates" | "thinking" | "effectiveAcceptance" | "agentContract" | "launchContractDigest" | "capabilityCeiling" | "capabilityAudit"> = {},
): Promise<ProgrammaticLeafResult> {
	let output = "";
	let sessionFile = request.sessionFile;
	const attemptedModels: string[] = [];
	const projector = createProgrammaticStepProjector(asyncDir, request.childIndex);
	let activeRequest = request;
	const cancel = (): void => {
		void runtime.cancel(activeRequest.runId, activeRequest.childIndex).catch(() => undefined);
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
		const candidates: Array<string | undefined> = metadata.modelCandidates?.length
			? metadata.modelCandidates
			: [request.model];
		let lastError = "Subagent did not produce a result.";
		let timedOut = false;
		for (let attemptIndex = 0; attemptIndex < candidates.length; attemptIndex += 1) {
			const candidate = candidates[attemptIndex];
			const candidateModel = candidate ? splitKnownThinkingSuffix(candidate).baseModel : request.model;
			const candidateThinking = resolveEffectiveThinking(candidate, metadata.thinking ?? request.thinking);
			activeRequest = {
				...request,
				...(candidateModel ? { model: candidateModel } : {}),
				...(candidateThinking ? { thinking: candidateThinking as SubagentRuntimeRunRequest["thinking"] } : {}),
			};
			const attemptedModel = candidate ?? candidateModel ?? "default";
			attemptedModels.push(attemptedModel);
			markProgrammaticStep(asyncDir, request.childIndex, {
				model: candidate ?? candidateModel,
				thinking: candidateThinking,
				attemptedModels: [...attemptedModels],
			});
			let streamedText = "";
			let attemptOutput = "";
			let terminalSeen = false;
			let attemptError: string | undefined;
			try {
				for await (const event of runtime.run(activeRequest)) {
					appendJsonl(eventsPath, JSON.stringify(event));
					const textDelta = subagentTextDelta(event);
					if (textDelta !== undefined) {
						streamedText = appendProgrammaticStreamText(streamedText, textDelta);
						projector.project(event, streamedText);
					} else {
						projector.project(event);
					}
					const text = assistantOutput(event);
					if (text) {
						attemptOutput = text;
						streamedText = "";
					}
					if (event.type === "failed") {
						terminalSeen = true;
						timedOut = event.code === SUBAGENT_TIMEOUT_CODE;
						sessionFile = event.sessionFile ?? sessionFile;
						attemptError = event.error;
						break;
					}
					if (event.type === "completed") {
						terminalSeen = true;
						sessionFile = event.sessionFile ?? sessionFile;
						break;
					}
				}
			} catch (error) {
				attemptError = error instanceof Error ? error.message : String(error);
			}
			projector.flush();
			output = attemptOutput;
			if (!terminalSeen && !attemptError) attemptError = "Subagent event stream ended without a terminal event.";
			let structuredOutput: unknown;
			if (!attemptError) {
				try {
					structuredOutput = readProgrammaticStructuredOutput(activeRequest);
				} catch (error) {
					attemptError = error instanceof Error ? error.message : String(error);
				}
			}
			if (!attemptError && !output.trim() && structuredOutput === undefined) {
				attemptError = "Subagent produced no output (possible model cold-start or empty response).";
			}
			if (!attemptError) {
				const acceptance = metadata.effectiveAcceptance
					? await evaluateAcceptance({
						acceptance: metadata.effectiveAcceptance,
						output,
						cwd: request.cwd,
						reportOptional: isAgentContractV1(metadata.agentContract),
					})
					: undefined;
				const acceptanceFailure = acceptance ? acceptanceFailureMessage(acceptance) : undefined;
				if (acceptanceFailure && acceptance?.explicit && !isAgentContractV1(metadata.agentContract)) {
					attemptError = acceptanceFailure;
				} else {
					return {
						agent: request.agent,
						index: request.childIndex,
						output,
						success: true,
						...(structuredOutput !== undefined ? { structuredOutput } : {}),
						...(sessionFile ? { sessionFile } : {}),
						...(candidate ?? candidateModel ? { model: candidate ?? candidateModel } : {}),
						...(candidateThinking ? { thinking: candidateThinking } : {}),
						attemptedModels,
						...(acceptance ? { acceptance } : {}),
						...(metadata.launchContractDigest ? { launchContractDigest: metadata.launchContractDigest } : {}),
						...(metadata.capabilityCeiling ? { capabilityCeiling: metadata.capabilityCeiling } : {}),
						...(metadata.capabilityAudit ? { capabilityAudit: metadata.capabilityAudit } : {}),
					};
				}
			}
			lastError = attemptError;
			if (signal.aborted || timedOut || !isRetryableModelFailure(attemptError) || attemptIndex === candidates.length - 1) break;
			const note = formatModelAttemptNote({ model: attemptedModel, success: false, exitCode: 1, error: attemptError }, candidates[attemptIndex + 1]);
			markProgrammaticStep(asyncDir, request.childIndex, { recentOutput: [note] });
		}
		const skippedAcceptance = metadata.effectiveAcceptance
			? buildSkippedAcceptanceLedger(metadata.effectiveAcceptance, {
				id: signal.aborted ? "stopped" : timedOut ? "timeout" : "failed",
				message: signal.aborted
					? "Acceptance was not evaluated because the subagent was cancelled."
					: timedOut
						? "Acceptance was not evaluated because the subagent timed out."
						: "Acceptance was not evaluated because the subagent failed.",
			})
			: undefined;
		return {
			agent: request.agent,
			index: request.childIndex,
			output,
			success: false,
			error: lastError,
			cancelled: signal.aborted,
			...(timedOut ? { timedOut: true } : {}),
			...(sessionFile ? { sessionFile } : {}),
			...(attemptedModels.at(-1) ? { model: attemptedModels.at(-1), attemptedModels } : {}),
			...(metadata.thinking ? { thinking: metadata.thinking } : {}),
			...(skippedAcceptance ? { acceptance: skippedAcceptance } : {}),
			...(metadata.launchContractDigest ? { launchContractDigest: metadata.launchContractDigest } : {}),
			...(metadata.capabilityCeiling ? { capabilityCeiling: metadata.capabilityCeiling } : {}),
			...(metadata.capabilityAudit ? { capabilityAudit: metadata.capabilityAudit } : {}),
		};
	} finally {
		projector.flush();
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
	const childExtensions = resolveChildExtensions(runtime, {
		denyExtensions: options.capabilityCeiling?.denyExtensions,
		allowedTools: options.capabilityCeiling?.allowedTools,
	});
	const startedAt = Date.now();
	const results: ProgrammaticLeafResult[] = [];
	const active = new Map<number, SubagentRuntimeRunRequest>();
	const control = new AbortController();
	let stopRequested = false;
	let interrupted = false;
	let checkpointRejected = false;
	let previousOutput = "";
	let nextFlatIndex = 0;
	const outputs: ChainOutputMap = {};
	const substituteTask = (template: string): string =>
		resolveOutputReferences(template, outputs).replace(/\{previous\}/g, () => previousOutput);
	const cancel = (state: "stopped" | "paused"): void => {
		stopRequested ||= state === "stopped";
		interrupted ||= state === "paused";
		control.abort();
	};
	const projectResult = (result: ProgrammaticLeafResult): ProgrammaticLeafResult => {
		projectProgrammaticStepResult(
			asyncDir,
			result,
			result.success ? "completed" : result.cancelled ? (stopRequested ? "stopped" : "paused") : "failed",
		);
		return result;
	};
	const controlHandlers: ControlPollHandlers = {
		onSteer: (request) => routeProgrammaticSteer(runtime, asyncDir, request, [...active.values()]),
		onStop: () => cancel("stopped"),
		onInterrupt: () => cancel("paused"),
	};
	const pollPromise = runControlPollLoop(asyncDir, control.signal, controlHandlers);
	const consumePendingAppendRequests = (): number => {
		const requests = consumeChainAppendRequests(asyncDir);
		const pendingAppends = countPendingChainAppendRequests(asyncDir);
		if (requests.length === 0) {
			const status = readStatus(asyncDir);
			if (status && (status.pendingAppends ?? 0) !== pendingAppends) {
				writeProgrammaticStatus(asyncDir, { pendingAppends, lastUpdate: Date.now() });
			}
			return 0;
		}
		const appendedSteps = requests.flatMap((request) => request.steps);
		steps.push(...appendedSteps);
		const status = readStatus(asyncDir);
		const now = Date.now();
		if (status) {
			appendRunnerStepsToStatus({ status, steps: appendedSteps, now, pendingAppends });
			writeAtomicJson(path.join(asyncDir, "status.json"), status);
		}
		for (const request of requests) {
			appendJsonl(eventsPath, JSON.stringify({
				type: "subagent.chain.append.accepted",
				ts: now,
				runId: id,
				requestId: request.id,
				stepCount: request.steps.length,
				pendingAppends,
			}));
		}
		return requests.length;
	};
	const closeAppendQueue = (reason: string): void => {
		const now = Date.now();
		writeProgrammaticStatus(asyncDir, { acceptingAppends: false, lastUpdate: now });
		const cancelled = consumeChainAppendRequests(asyncDir);
		writeProgrammaticStatus(asyncDir, { pendingAppends: 0, acceptingAppends: false, lastUpdate: now });
		for (const request of cancelled) {
			appendJsonl(eventsPath, JSON.stringify({
				type: "subagent.chain.append.cancelled",
				ts: now,
				runId: id,
				requestId: request.id,
				stepCount: request.steps.length,
				reason,
				pendingAppends: 0,
			}));
		}
	};

	try {
		let logicalIndex = 0;
		while (true) {
			runControlPollOnce(asyncDir, controlHandlers);
			if (control.signal.aborted) {
				closeAppendQueue(stopRequested ? "Async run stopped." : "Async run interrupted.");
				break;
			}
			consumePendingAppendRequests();
			if (logicalIndex >= steps.length) {
				writeProgrammaticStatus(asyncDir, { acceptingAppends: false, lastUpdate: Date.now() });
				if (consumePendingAppendRequests() === 0) break;
				writeProgrammaticStatus(asyncDir, { acceptingAppends: true, lastUpdate: Date.now() });
				continue;
			}
			const step = steps[logicalIndex]!;
			let stepResults: ProgrammaticLeafResult[];
			if (isCheckpointRunnerStep(step)) {
				const index = nextFlatIndex++;
				const pendingCheckpoint = {
					name: step.checkpoint,
					...(step.message ? { message: step.message } : {}),
					status: "pending" as const,
					stepIndex: logicalIndex,
				};
				const startedAt = Date.now();
				markProgrammaticCheckpoint(asyncDir, index, pendingCheckpoint, { status: "paused", startedAt });
				writeProgrammaticStatus(asyncDir, { state: "paused", currentStep: index, checkpoint: pendingCheckpoint, lastUpdate: startedAt });
				appendJsonl(eventsPath, JSON.stringify({ type: "subagent.checkpoint.paused", ts: startedAt, runId: id, stepIndex: logicalIndex, checkpoint: pendingCheckpoint }));
				let decision: "approved" | "rejected" | undefined;
				while (!control.signal.aborted && !decision) {
					runControlPollOnce(asyncDir, controlHandlers);
					decision = consumeCheckpointDecisionRequest(asyncDir);
					if (!decision && !control.signal.aborted) await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
				}
				if (decision === "approved") {
					const approvedAt = Date.now();
					const approvedCheckpoint = { ...pendingCheckpoint, status: "approved" as const, approvedAt };
					markProgrammaticCheckpoint(asyncDir, index, approvedCheckpoint, { status: "completed", endedAt: approvedAt, durationMs: approvedAt - startedAt, exitCode: 0 });
					writeProgrammaticStatus(asyncDir, { state: "running", checkpoint: approvedCheckpoint, lastUpdate: approvedAt });
					appendJsonl(eventsPath, JSON.stringify({ type: "subagent.checkpoint.approved", ts: approvedAt, runId: id, stepIndex: logicalIndex, checkpoint: approvedCheckpoint }));
					stepResults = [{ agent: `checkpoint:${step.checkpoint}`, index, output: "", success: true }];
				} else if (decision === "rejected") {
					checkpointRejected = true;
					const rejectedAt = Date.now();
					const rejectedCheckpoint = { ...pendingCheckpoint, status: "rejected" as const, rejectedAt };
					const error = `Checkpoint '${step.checkpoint}' rejected.`;
					markProgrammaticCheckpoint(asyncDir, index, rejectedCheckpoint, { status: "rejected", endedAt: rejectedAt, durationMs: rejectedAt - startedAt, exitCode: 1, error });
					writeProgrammaticStatus(asyncDir, { state: "rejected", checkpoint: rejectedCheckpoint, error, lastUpdate: rejectedAt });
					appendJsonl(eventsPath, JSON.stringify({ type: "subagent.checkpoint.rejected", ts: rejectedAt, runId: id, stepIndex: logicalIndex, checkpoint: rejectedCheckpoint }));
					stepResults = [{ agent: `checkpoint:${step.checkpoint}`, index, output: "", success: false, error }];
				} else {
					const cancelled = stopRequested || control.signal.aborted;
					const error = cancelled ? "Async run stopped." : "Async run interrupted.";
					markProgrammaticCheckpoint(asyncDir, index, pendingCheckpoint, { status: cancelled ? "stopped" : "paused", endedAt: Date.now(), error });
					stepResults = [{ agent: `checkpoint:${step.checkpoint}`, index, output: "", success: false, error, cancelled: true, stopped: cancelled }];
				}
			} else if (isDynamicRunnerGroup(step)) {
				const baseIndex = nextFlatIndex;
				let materialized: ReturnType<typeof materializeDynamicParallelStep>;
				try {
					materialized = materializeDynamicParallelStep(step as never, outputs, logicalIndex, { maxItems: options.dynamicFanoutMaxItems, allowRunnerFields: true });
				} catch (error) {
					const message = error instanceof DynamicFanoutError ? error.message : error instanceof Error ? error.message : String(error);
					const failedAt = Date.now();
					markProgrammaticStep(asyncDir, baseIndex, { status: "failed", startedAt: failedAt, endedAt: failedAt, durationMs: 0, exitCode: 1, error: message });
					writeProgrammaticStatus(asyncDir, { state: "failed", currentStep: baseIndex, error: message, lastUpdate: failedAt });
					stepResults = [{ agent: `expand:${step.parallel.agent}`, index: baseIndex, output: message, success: false, error: message }];
					nextFlatIndex += 1;
				}
				if (stepResults === undefined) {
					nextFlatIndex += materialized.parallel.length;
					if (materialized.parallel.length === 0) {
						try {
							const collection: ReturnType<typeof collectDynamicResults> = [];
							await validateDynamicCollection(step.collect.outputSchema, collection);
							writeDynamicCollectionOutput(outputs, step.collect.as, collection, step.parallel.agent, logicalIndex);
							markProgrammaticStep(asyncDir, baseIndex, { status: "completed", startedAt: Date.now(), endedAt: Date.now(), durationMs: 0, exitCode: 0 });
							writeProgrammaticStatus(asyncDir, { outputs, lastUpdate: Date.now() });
							stepResults = [{ agent: step.parallel.agent, index: baseIndex, output: "", success: true, structuredOutput: collection }];
						} catch (error) {
							const message = error instanceof DynamicFanoutError ? error.message : error instanceof Error ? error.message : String(error);
							markProgrammaticStep(asyncDir, baseIndex, { status: "failed", startedAt: Date.now(), endedAt: Date.now(), durationMs: 0, exitCode: 1, error: message });
							stepResults = [{ agent: step.parallel.agent, index: baseIndex, output: message, success: false, error: message }];
						}
					} else {
						expandProgrammaticDynamicStatus(asyncDir, baseIndex, step, materialized);
						const requests = materialized.parallel.map((task, taskIndex) => {
							const dynamicTask = {
								...step.parallel,
								...task,
								task: substituteTask(task.task ?? step.parallel.task ?? "{previous}"),
								...(step.sessionFiles?.[taskIndex] ? { sessionFile: step.sessionFiles[taskIndex] } : {}),
								...(step.thinkingOverrides?.[taskIndex] ? { thinking: step.thinkingOverrides[taskIndex] } : {}),
							};
							return runnerStepToRequest(dynamicTask, `${id}-${logicalIndex}-${taskIndex}`, baseIndex + taskIndex, dynamicTask.cwd ?? runnerCwd, options, childExtensions);
						});
					let groupFailed = false;
					const concurrency = Math.min(step.concurrency ?? MAX_PARALLEL_CONCURRENCY, options.globalConcurrencyLimit ?? Number.POSITIVE_INFINITY);
					stepResults = await mapConcurrent(requests, concurrency, async (request, taskIndex) => {
						if (step.failFast && groupFailed) {
							return projectResult({ agent: request.agent, index: request.childIndex, output: "", success: false, error: "Skipped due to fail-fast.", skipped: true });
						}
						active.set(request.childIndex, request);
						markProgrammaticStep(asyncDir, request.childIndex, { status: "running", startedAt: Date.now() });
						try {
							const result = await consumeLeafRun(runtime, request, asyncDir, eventsPath, control.signal, programmaticMetadataFromStep(materialized.parallel[taskIndex] as RunnerSubagentStep));
							if (!result.success && step.failFast) groupFailed = true;
							return projectResult(result);
						} finally {
							active.delete(request.childIndex);
						}
					});
					const collection = collectDynamicResults(step as never, materialized.items, stepResults.map((result) => ({ ...result, exitCode: result.success ? 0 : 1 })));
					try {
						await validateDynamicCollection(step.collect.outputSchema, collection);
						writeDynamicCollectionOutput(outputs, step.collect.as, collection, step.parallel.agent, logicalIndex);
						writeProgrammaticStatus(asyncDir, { outputs, lastUpdate: Date.now() });
					} catch (error) {
						const message = error instanceof DynamicFanoutError ? error.message : error instanceof Error ? error.message : String(error);
						writeProgrammaticStatus(asyncDir, { state: "failed", error: message, lastUpdate: Date.now() });
						stepResults.push({ agent: step.parallel.agent, index: -1, output: message, success: false, error: message, structuredOutput: collection });
					}
					previousOutput = dynamicOutputSummary(stepResults, materialized.items);
				}
				}
			} else if (isParallelGroup(step)) {
				const baseIndex = nextFlatIndex;
				nextFlatIndex += step.parallel.length;
				const worktreeSetup: WorktreeSetup | undefined = step.worktree
					? createWorktrees(runnerCwd, `${id}-s${logicalIndex}`, step.parallel.length, {
						agents: step.parallel.map((task) => task.agent),
						...(options.worktreeSetupHook ? { setupHook: { hookPath: options.worktreeSetupHook, timeoutMs: options.worktreeSetupHookTimeoutMs } } : {}),
						...(options.worktreeBaseDir ? { baseDir: options.worktreeBaseDir } : {}),
					})
					: undefined;
				const requests = step.parallel.map((task, taskIndex) =>
					runnerStepToRequest(
						{ ...task, task: substituteTask(task.task) },
						`${id}-${logicalIndex}-${taskIndex}`,
						baseIndex + taskIndex,
						worktreeSetup?.worktrees[taskIndex]?.agentCwd ?? task.cwd ?? runnerCwd,
						options,
						childExtensions,
					),
				);
				let groupFailed = false;
				const concurrency = Math.min(
					step.concurrency ?? MAX_PARALLEL_CONCURRENCY,
					options.globalConcurrencyLimit ?? Number.POSITIVE_INFINITY,
				);
				stepResults = await mapConcurrent(requests, concurrency, async (request) => {
					if (step.failFast && groupFailed) {
						return projectResult({
							agent: request.agent,
							index: request.childIndex,
							output: "",
							success: false,
							error: "Skipped due to fail-fast.",
							skipped: true,
						});
					}
					active.set(request.childIndex, request);
					markProgrammaticStep(asyncDir, request.childIndex, { status: "running", startedAt: Date.now() });
					try {
						const result = await consumeLeafRun(runtime, request, asyncDir, eventsPath, control.signal, programmaticMetadataFromStep(step.parallel[request.childIndex - baseIndex]!));
						if (!result.success && step.failFast) groupFailed = true;
						return projectResult(result);
					} finally {
						active.delete(request.childIndex);
					}
				});
				step.parallel.forEach((task, taskIndex) => {
					const leaf = stepResults[taskIndex];
					if (task.outputName && leaf) outputs[task.outputName] = outputEntryFromAsyncResult(leaf, logicalIndex);
				});
				previousOutput = aggregateProgrammaticOutputs(stepResults);
				if (worktreeSetup) {
					const diffs = diffWorktrees(worktreeSetup, step.parallel.map((task) => task.agent), path.join(asyncDir, "worktree-diffs", `step-${logicalIndex}`));
					const diffSummary = formatWorktreeDiffSummary(diffs);
					const cleanup = cleanupWorktrees(worktreeSetup);
					try {
						const parallelHandoff = writeParallelHandoffGroup({
							manifestPath: parallelHandoffPath(asyncDir),
							runId: id,
							mode: resultMode === "parallel" ? "parallel" : "chain",
							source: "async",
							cwd: runnerCwd,
							stepIndex: logicalIndex,
							flatStartIndex: baseIndex,
							setup: worktreeSetup,
							diffs,
							cleanup,
							results: stepResults.map((result) => ({
								agent: result.agent,
								status: result.success ? "completed" : result.cancelled ? (stopRequested ? "stopped" : "paused") : "failed",
								summary: result.output || result.error || "(no output)",
								...(result.structuredOutput !== undefined ? { structuredOutput: result.structuredOutput } : {}),
								...(result.sessionFile ? { sessionPath: result.sessionFile } : {}),
							})),
						});
						writeProgrammaticStatus(asyncDir, { parallelHandoff, lastUpdate: Date.now() });
						previousOutput = [previousOutput, diffSummary, formatParallelHandoffReference(parallelHandoff)].filter(Boolean).join("\n\n");
					} catch (error) {
						previousOutput = [previousOutput, diffSummary, formatParallelHandoffError(error)].filter(Boolean).join("\n\n");
					}
				}
			} else {
				const index = nextFlatIndex++;
				const sequential = step as RunnerSubagentStep;
				if (sequential.importAsyncRoot) {
					markProgrammaticStep(asyncDir, index, { status: "running", startedAt: Date.now() });
					const imported = await waitForImportedAsyncRoot(sequential.importAsyncRoot, {
						shouldAbort: () => control.signal.aborted,
						timeoutMessage: "Attached async root wait aborted.",
						abortState: "cancelled",
					});
					stepResults = [
						projectResult({
							agent: imported.agent,
							index,
							output: imported.output,
							success: imported.success,
							...(imported.error ? { error: imported.error } : {}),
							...(control.signal.aborted ? { cancelled: true } : {}),
							...(imported.timedOut ? { timedOut: true } : {}),
							...(imported.stopped ? { stopped: true } : {}),
							...(imported.structuredOutput !== undefined
								? { structuredOutput: imported.structuredOutput }
								: {}),
							...(imported.sessionFile ? { sessionFile: imported.sessionFile } : {}),
						}),
					];
				} else {
					const request = runnerStepToRequest(
						{ ...sequential, task: substituteTask(sequential.task) },
						`${id}-${logicalIndex}`,
						index,
						sequential.cwd ?? runnerCwd,
						options,
						childExtensions,
					);
					active.set(index, request);
					markProgrammaticStep(asyncDir, index, { status: "running", startedAt: Date.now() });
					try {
						stepResults = [projectResult(await consumeLeafRun(runtime, request, asyncDir, eventsPath, control.signal, programmaticMetadataFromStep(sequential)))];
					} finally {
						active.delete(index);
					}
				}
				const leaf = stepResults[0];
				if (sequential.outputName && leaf) outputs[sequential.outputName] = outputEntryFromAsyncResult(leaf, logicalIndex);
				previousOutput = leaf?.output ?? "";
			}
			results.push(...stepResults);
			logicalIndex += 1;
			writeProgrammaticStatus(asyncDir, { currentStep: results.length, lastUpdate: Date.now() });
			if (stepResults.some((result) => !result.success)) {
				closeAppendQueue("The active chain step failed before appended steps became eligible.");
				break;
			}
		}

		const endedAt = Date.now();
		const allSucceeded = results.length > 0 && results.every((result) => result.success);
		const timedOut = results.some((result) => result.timedOut);
		const state = stopRequested ? "stopped" : checkpointRejected ? "rejected" : interrupted ? "paused" : allSucceeded ? "complete" : "failed";
		const error = stopRequested
			? "Async run stopped."
			: interrupted
				? "Async run interrupted."
				: results.find((result) => !result.success)?.error;
		const parallelHandoff = readStatus(asyncDir)?.parallelHandoff;
		writeProgrammaticStatus(asyncDir, {
			state,
			error,
			...(timedOut ? { timedOut: true } : {}),
			endedAt,
			lastUpdate: endedAt,
		});
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
			...(timedOut ? { timedOut: true } : {}),
			results: results.map((result) => ({
				agent: result.agent,
				output: result.output,
				success: result.success,
				error: result.error,
				skipped: result.skipped,
				timedOut: result.timedOut,
				stopped: result.stopped,
				structuredOutput: result.structuredOutput,
				sessionFile: result.sessionFile,
				model: result.model,
				thinking: result.thinking,
				attemptedModels: result.attemptedModels,
				acceptance: result.acceptance,
				launchContractDigest: result.launchContractDigest,
				capabilityCeiling: result.capabilityCeiling,
				capabilityAudit: result.capabilityAudit,
				state: result.cancelled ? state : undefined,
			})),
			outputs,
			...(parallelHandoff ? { parallelHandoff } : {}),
			...(options.capabilityCeiling ? { capabilityCeiling: options.capabilityCeiling } : {}),
			cwd: runnerCwd,
			asyncDir,
			startedAt,
			endedAt,
		});
	} catch (error) {
		closeAppendQueue("The async chain failed before appended steps became eligible.");
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

function programmaticMetadataFromStep(step: RunnerSubagentStep): Pick<ConsumeAsyncChainOptions, "modelCandidates" | "thinking" | "effectiveAcceptance" | "agentContract" | "launchContractDigest" | "capabilityCeiling" | "capabilityAudit"> {
	return {
		modelCandidates: step.modelCandidates,
		thinking: step.thinking,
		effectiveAcceptance: step.effectiveAcceptance,
		agentContract: step.agentContract,
		launchContractDigest: step.launchContractDigest,
		capabilityCeiling: step.capabilityCeiling,
		capabilityAudit: step.capabilityAudit,
	};
}

function flattenProgrammaticStepDetails(steps: RunnerStep[]): Array<Record<string, unknown>> {
	const details: Array<Record<string, unknown>> = [];
	for (const step of steps) {
		if (isCheckpointRunnerStep(step)) {
			details.push({
				agent: `checkpoint:${step.checkpoint}`,
				label: step.label ?? step.checkpoint,
				status: "pending",
				checkpoint: {
					name: step.checkpoint,
					...(step.message ? { message: step.message } : {}),
					status: "pending",
					stepIndex: details.length,
				},
				recentTools: [],
				recentOutput: [],
			});
			continue;
		}
		if (isDynamicRunnerGroup(step)) {
			details.push({
				agent: `expand:${step.parallel.agent}`,
				phase: step.phase ?? step.parallel.phase,
				label: step.label ?? step.parallel.label ?? `Dynamic fanout (${step.collect.as})`,
				outputName: step.collect.as,
				structured: Boolean(step.collect.outputSchema),
				status: "pending",
				recentTools: [],
				recentOutput: [],
			});
			continue;
		}
		const children = isParallelGroup(step) ? step.parallel : [step];
		for (const child of children) {
			details.push({
				agent: child.agent,
				status: "pending",
				...(child.context ? { context: child.context } : {}),
				...(child.phase ? { phase: child.phase } : {}),
				...(child.label ? { label: child.label } : {}),
				...(child.outputName ? { outputName: child.outputName } : {}),
				...(child.structured ? { structured: true } : {}),
				...(child.model ? { model: child.model } : {}),
				...(child.thinking ? { thinking: child.thinking } : {}),
				attemptedModels: [],
				...(child.launchContractDigest ? { launchContractDigest: child.launchContractDigest } : {}),
				...(child.capabilityCeiling ? { capabilityCeiling: child.capabilityCeiling } : {}),
				...(child.capabilityAudit ? { capabilityAudit: child.capabilityAudit } : {}),
				recentTools: [],
				recentOutput: [],
			});
		}
	}
	return details;
}

function flattenProgrammaticSteps(steps: RunnerStep[]): {
	agents: string[];
	parallelGroups: Array<{ start: number; count: number; stepIndex: number }>;
} {
	const agents: string[] = [];
	const parallelGroups: Array<{ start: number; count: number; stepIndex: number }> = [];
	for (let stepIndex = 0; stepIndex < steps.length; stepIndex += 1) {
		const step = steps[stepIndex]!;
		if (isCheckpointRunnerStep(step)) {
			agents.push(`checkpoint:${step.checkpoint}`);
		} else if (isParallelGroup(step)) {
			parallelGroups.push({ start: agents.length, count: step.parallel.length, stepIndex });
			agents.push(...step.parallel.map((task) => task.agent));
		} else if (isDynamicRunnerGroup(step)) {
			parallelGroups.push({ start: agents.length, count: 1, stepIndex });
			agents.push(`expand:${step.parallel.agent}`);
		} else {
			agents.push(step.agent);
		}
	}
	return { agents, parallelGroups };
}

function expandProgrammaticDynamicStatus(
	asyncDir: string,
	stepIndex: number,
	step: { parallel: { agent: string }; phase?: string; label?: string },
	materialized: { items: Array<{ key: string }>; parallel: Array<Record<string, unknown>> },
): void {
	const status = readStatus(asyncDir);
	if (!status || !Array.isArray(status.steps)) return;
	const children = materialized.parallel.map((task, itemIndex) => ({
		agent: typeof task.agent === "string" ? task.agent : step.parallel.agent,
		...(typeof task.phase === "string" || typeof step.phase === "string" ? { phase: task.phase ?? step.phase } : {}),
		...(typeof task.label === "string" || typeof step.label === "string" ? { label: task.label ?? step.label } : {}),
		status: "pending",
		...(task.structuredOutputSchema !== undefined || task.structured !== undefined ? { structured: Boolean(task.structuredOutputSchema ?? task.structured) } : {}),
		recentTools: [],
		recentOutput: [],
		itemKey: materialized.items[itemIndex]?.key,
	}));
	const delta = children.length - 1;
	status.steps.splice(stepIndex, 1, ...children);
	if (Array.isArray(status.parallelGroups)) {
		for (const group of status.parallelGroups) {
			if (group.start === stepIndex) {
				group.count = children.length;
			} else if (group.start > stepIndex) {
				group.start += delta;
			}
		}
	}
	writeAtomicJson(path.join(asyncDir, "status.json"), {
		...status,
		lastUpdate: Date.now(),
	});
}

function markProgrammaticCheckpoint(
	asyncDir: string,
	index: number,
	checkpoint: Record<string, unknown>,
	updates: Record<string, unknown>,
): void {
	updateProgrammaticStep(asyncDir, index, (step) => {
		Object.assign(step, updates, { checkpoint });
	});
}

function dynamicOutputSummary(results: ProgrammaticLeafResult[], items: Array<{ key: string }>): string {
	return results
		.map((result, index) => {
			const key = items[index]?.key ?? index;
			const body = result.success ? result.output : `${result.error ?? "Failed"}${result.output ? `\\n${result.output}` : ""}`;
			return `=== Dynamic Item ${index + 1} (${result.agent}, key ${key}) ===\\n${body}`;
		})
		.join("\\n\\n");
}

function writeDynamicCollectionOutput(
	outputs: ChainOutputMap,
	name: string,
	collection: unknown,
	agent: string,
	stepIndex: number,
): void {
	outputs[name] = {
		text: JSON.stringify(collection),
		structured: collection,
		agent,
		stepIndex,
	};
}

function writeProgrammaticStatus(asyncDir: string, updates: Record<string, unknown>): void {
	const current = readStatus(asyncDir);
	writeAtomicJson(path.join(asyncDir, "status.json"), {
		...(current ? (current as unknown as Record<string, unknown>) : {}),
		...updates,
	});
}

function updateProgrammaticStep(
	asyncDir: string,
	index: number,
	mutate: (step: Record<string, unknown>, now: number) => void,
	now = Date.now(),
): void {
	const current = readStatus(asyncDir);
	if (!current) return;
	const record = current as unknown as Record<string, unknown>;
	const steps = Array.isArray(record.steps)
		? record.steps.map((step) => ({ ...(step as Record<string, unknown>) }))
		: [];
	const step = steps[index];
	if (!step) return;
	mutate(step, now);
	steps[index] = step;

	const activeTool = steps
		.filter((candidate) => candidate.status === "running" && typeof candidate.currentTool === "string")
		.sort((left, right) => Number(right.currentToolStartedAt ?? 0) - Number(left.currentToolStartedAt ?? 0))[0];
	const turnCount = steps.reduce((total, candidate) => total + Number(candidate.turnCount ?? 0), 0);
	const toolCount = steps.reduce((total, candidate) => total + Number(candidate.toolCount ?? 0), 0);
	const tokenInput = steps.reduce(
		(total, candidate) => total + Number((candidate.tokens as Record<string, unknown> | undefined)?.input ?? 0),
		0,
	);
	const tokenOutput = steps.reduce(
		(total, candidate) => total + Number((candidate.tokens as Record<string, unknown> | undefined)?.output ?? 0),
		0,
	);
	writeAtomicJson(path.join(asyncDir, "status.json"), {
		...record,
		steps,
		currentStep: index,
		lastActivityAt: now,
		currentTool: activeTool?.currentTool,
		currentToolStartedAt: activeTool?.currentToolStartedAt,
		currentPath: activeTool?.currentPath,
		turnCount,
		toolCount,
		...(tokenInput || tokenOutput
			? { totalTokens: { input: tokenInput, output: tokenOutput, total: tokenInput + tokenOutput } }
			: {}),
		lastUpdate: now,
	});
}

function markProgrammaticStep(asyncDir: string, index: number, updates: Record<string, unknown>): void {
	updateProgrammaticStep(asyncDir, index, (step) => Object.assign(step, updates));
}

function appendProgrammaticStreamText(current: string, delta: string): string {
	const next = `${current}${delta}`;
	return next.length > PROGRAMMATIC_STREAM_PREVIEW_CHARS
		? next.slice(-PROGRAMMATIC_STREAM_PREVIEW_CHARS)
		: next;
}

function programmaticRecentOutput(text: string): string[] {
	const lines = text
		.slice(-PROGRAMMATIC_STREAM_PREVIEW_CHARS)
		.split(/\r?\n/)
		.map((line) => line.trimEnd())
		.filter((line) => line.trim().length > 0)
		.slice(-PROGRAMMATIC_RECENT_OUTPUT_LINES);
	return lines.map((line) => (line.length > 1_000 ? line.slice(-1_000) : line));
}

function programmaticMessageUsage(event: SubagentRunEvent): { input: number; output: number } | undefined {
	if (event.type !== "message_end" || !event.message || typeof event.message !== "object" || Array.isArray(event.message)) {
		return undefined;
	}
	const usage = (event.message as Record<string, unknown>).usage;
	if (!usage || typeof usage !== "object" || Array.isArray(usage)) return undefined;
	const record = usage as Record<string, unknown>;
	const input = Number(record.input ?? record.inputTokens ?? 0);
	const output = Number(record.output ?? record.outputTokens ?? 0);
	return Number.isFinite(input) && Number.isFinite(output) ? { input, output } : undefined;
}

interface PendingProgrammaticStepEvent {
	event: SubagentRunEvent;
	streamedText?: string;
}

function projectProgrammaticStepEvents(
	asyncDir: string,
	index: number,
	events: PendingProgrammaticStepEvent[],
	now = Date.now(),
): void {
	if (events.length === 0) return;
	updateProgrammaticStep(asyncDir, index, (step) => {
		for (const pending of events) applyProgrammaticStepEvent(step, pending.event, pending.streamedText, now);
	}, now);
}

interface ProgrammaticStepProjector {
	/** Queue an event for projection; lifecycle events (started/completed/failed) flush immediately. */
	project(event: SubagentRunEvent, streamedText?: string): void;
	/** Project any queued events now and cancel the pending flush timer. */
	flush(): void;
}

/**
 * Throttles status.json projections for one step: events are batched into a
 * single read+rewrite per {@link PROGRAMMATIC_TEXT_PROJECTION_INTERVAL_MS}
 * window, with an immediate flush on lifecycle transitions so terminal state
 * is never delayed.
 */
function createProgrammaticStepProjector(asyncDir: string, index: number): ProgrammaticStepProjector {
	let pendingEvents: PendingProgrammaticStepEvent[] = [];
	let flushTimer: ReturnType<typeof setTimeout> | undefined;
	let lastProjectionAt = 0;
	const flush = (now = Date.now()): void => {
		if (flushTimer !== undefined) {
			clearTimeout(flushTimer);
			flushTimer = undefined;
		}
		if (pendingEvents.length === 0) return;
		const batch = pendingEvents;
		pendingEvents = [];
		projectProgrammaticStepEvents(asyncDir, index, batch, now);
		lastProjectionAt = now;
	};
	const project = (event: SubagentRunEvent, streamedText?: string): void => {
		const last = pendingEvents[pendingEvents.length - 1];
		if (subagentTextDelta(event) !== undefined && last && subagentTextDelta(last.event) !== undefined) {
			// Only the cumulative streamed text matters; coalesce consecutive deltas.
			pendingEvents[pendingEvents.length - 1] = { event, ...(streamedText !== undefined ? { streamedText } : {}) };
		} else {
			pendingEvents.push({ event, ...(streamedText !== undefined ? { streamedText } : {}) });
		}
		const now = Date.now();
		const lifecycle = event.type === "started" || event.type === "completed" || event.type === "failed";
		if (lifecycle || now - lastProjectionAt >= PROGRAMMATIC_TEXT_PROJECTION_INTERVAL_MS) {
			flush(now);
			return;
		}
		if (flushTimer === undefined) {
			flushTimer = setTimeout(() => {
				flushTimer = undefined;
				flush();
			}, Math.max(0, PROGRAMMATIC_TEXT_PROJECTION_INTERVAL_MS - (now - lastProjectionAt)));
			flushTimer.unref?.();
		}
	};
	return { project, flush: () => flush() };
}

function applyProgrammaticStepEvent(
	step: Record<string, unknown>,
	event: SubagentRunEvent,
	streamedText: string | undefined,
	now: number,
): void {
	if (event.type === "started") {
		step.status = "running";
		step.startedAt ??= now;
		if (event.sessionFile) step.sessionFile = event.sessionFile;
	} else if (subagentTextDelta(event) !== undefined) {
		if (streamedText) step.recentOutput = programmaticRecentOutput(streamedText);
	} else if (event.type === "tool_execution_start") {
		const args = event.args && typeof event.args === "object" && !Array.isArray(event.args)
			? event.args as Record<string, unknown>
			: {};
		step.toolCount = Number(step.toolCount ?? 0) + 1;
		step.currentTool = event.toolName;
		step.currentToolArgs = extractToolArgsPreview(args);
		step.currentToolStartedAt = now;
		step.currentPath = resolveCurrentPath(event.toolName, args);
	} else if (event.type === "tool_execution_end") {
		const recentTools = Array.isArray(step.recentTools) ? [...step.recentTools] : [];
		recentTools.push({
			tool: typeof step.currentTool === "string" ? step.currentTool : event.toolName,
			args: typeof step.currentToolArgs === "string" ? step.currentToolArgs : "",
			endMs: now,
		});
		step.recentTools = recentTools.slice(-PROGRAMMATIC_RECENT_TOOLS);
		step.currentTool = undefined;
		step.currentToolArgs = undefined;
		step.currentToolStartedAt = undefined;
		step.currentPath = undefined;
	} else if (event.type === "message_end") {
		const text = assistantOutput(event);
		if (text) step.recentOutput = programmaticRecentOutput(text);
		const message = event.message && typeof event.message === "object" && !Array.isArray(event.message)
			? event.message as Record<string, unknown>
			: undefined;
		if (message?.role === "assistant") {
			step.turnCount = Number(step.turnCount ?? 0) + 1;
			const usage = programmaticMessageUsage(event);
			if (usage) {
				const previous = step.tokens && typeof step.tokens === "object"
					? step.tokens as Record<string, unknown>
					: {};
				const input = Number(previous.input ?? 0) + usage.input;
				const output = Number(previous.output ?? 0) + usage.output;
				step.tokens = { input, output, total: input + output };
			}
		}
	} else if ((event.type === "completed" || event.type === "failed") && event.sessionFile) {
		step.sessionFile = event.sessionFile;
	}
	step.lastActivityAt = now;
}

function projectProgrammaticStepResult(
	asyncDir: string,
	result: ProgrammaticLeafResult,
	status: "completed" | "failed" | "paused" | "stopped",
	now = Date.now(),
): void {
	updateProgrammaticStep(asyncDir, result.index, (step) => {
		step.status = status;
		step.endedAt = now;
		step.durationMs = Math.max(0, now - Number(step.startedAt ?? now));
		step.exitCode = result.success ? 0 : 1;
		step.error = result.error;
		step.timedOut = result.timedOut;
		step.stopped = status === "stopped" || result.stopped ? true : undefined;
		step.currentTool = undefined;
		step.currentToolArgs = undefined;
		step.currentToolStartedAt = undefined;
		step.currentPath = undefined;
		if (result.output) step.recentOutput = programmaticRecentOutput(result.output);
		if (result.sessionFile) step.sessionFile = result.sessionFile;
		if (result.model) step.model = result.model;
		if (result.thinking) step.thinking = result.thinking;
		if (result.attemptedModels) step.attemptedModels = result.attemptedModels;
		if (result.acceptance) step.acceptance = result.acceptance;
		if (result.launchContractDigest) step.launchContractDigest = result.launchContractDigest;
		if (result.capabilityCeiling) step.capabilityCeiling = result.capabilityCeiling;
		if (result.capabilityAudit) step.capabilityAudit = result.capabilityAudit;
		if (result.structuredOutput !== undefined) step.structuredOutput = result.structuredOutput;
	}, now);
}

function assistantOutput(event: SubagentRunEvent): string {
	if (event.type !== "message_end" || !event.message || typeof event.message !== "object" || Array.isArray(event.message)) {
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

function readProgrammaticStructuredOutput(request: SubagentRuntimeRunRequest): unknown {
	const structuredOutput = request.structuredOutput;
	if (!structuredOutput) return undefined;
	try {
		return JSON.parse(fs.readFileSync(structuredOutput.outputPath, "utf8"));
	} catch (error) {
		throw new Error(
			`Structured output was not produced at ${structuredOutput.outputPath}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
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

export const DEFAULT_ASYNC_TIMEOUT_MS = 30 * 60 * 1000;

export function workflowAwaitedAsyncResultPath(asyncDir: string): string {
	return path.join(asyncDir, "workflow-result.json");
}
