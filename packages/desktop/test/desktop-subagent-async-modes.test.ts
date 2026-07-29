import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentConfig } from "../src/main/pi/extensions/pi-subagents/src/agents/agents.ts";
import {
  buildAsyncRunnerSteps,
  executeAsyncChain,
  executeAsyncSingle,
} from "../src/main/pi/extensions/pi-subagents/src/runs/background/async-execution.ts";
import { enqueueChainAppendRequest } from "../src/main/pi/extensions/pi-subagents/src/runs/background/chain-append.ts";
import {
  consumeSteerAcks,
  requestAsyncInterrupt,
  requestAsyncSteer,
  requestAsyncStop,
} from "../src/main/pi/extensions/pi-subagents/src/runs/background/control-channel.ts";
import { buildCompletionDetails } from "../src/main/pi/extensions/pi-subagents/src/runs/background/notify.ts";
import { inspectSubagentStatus } from "../src/main/pi/extensions/pi-subagents/src/runs/background/run-status.ts";
import type {
  SubagentRuntime,
  SubagentRuntimeRunRequest,
} from "../src/main/pi/extensions/pi-subagents/src/runtime/subagent-runtime.ts";
import { ASYNC_DIR, RESULTS_DIR } from "../src/main/pi/extensions/pi-subagents/src/shared/types.ts";
import { SUBAGENT_TIMEOUT_CODE } from "../src/shared/subagent-contracts.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

class CompletingRuntime implements SubagentRuntime {
  readonly requests: SubagentRuntimeRunRequest[] = [];
  private readonly outputForRequest?: (request: SubagentRuntimeRunRequest) => string;

  constructor(outputForRequest?: (request: SubagentRuntimeRunRequest) => string) {
    this.outputForRequest = outputForRequest;
  }

  async *run(request: SubagentRuntimeRunRequest) {
    this.requests.push(request);
    const text =
      this.outputForRequest?.(request) ?? (request.task.includes("first output") ? "second output" : "first output");
    yield { type: "started" as const, runId: request.runId };
    yield {
      type: "message_end" as const,
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
        provider: "faux",
        model: "model",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      },
    };
    yield { type: "completed" as const, runId: request.runId, sessionFile: `${request.runId}.jsonl` };
  }

  async cancel() {}
  async steer() {}
  resume(request: SubagentRuntimeRunRequest) {
    return this.run(request);
  }
  async dispose() {}
}

class AppendableRuntime implements SubagentRuntime {
  readonly requests: SubagentRuntimeRunRequest[] = [];
  readonly started: Promise<void>;
  private markStarted: () => void;
  private release?: () => void;
  private readonly failFirst: boolean;

  constructor(failFirst = false) {
    this.failFirst = failFirst;
    let markStarted!: () => void;
    this.started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    this.markStarted = markStarted;
  }

  async *run(request: SubagentRuntimeRunRequest) {
    const first = this.requests.length === 0;
    this.requests.push(request);
    if (first) {
      this.markStarted();
      await new Promise<void>((resolve) => {
        this.release = resolve;
      });
      if (this.failFirst) {
        yield { type: "failed" as const, runId: request.runId, error: "first step failed" };
        return;
      }
    }
    yield {
      type: "message_end" as const,
      message: { role: "assistant", content: [{ type: "text", text: `output-${request.childIndex}` }] },
    };
    yield { type: "completed" as const, runId: request.runId };
  }

  finishFirst() {
    this.release?.();
  }
  async cancel() {
    this.release?.();
  }
  async steer() {}
  resume(request: SubagentRuntimeRunRequest) {
    return this.run(request);
  }
  async dispose() {}
}

class NoTerminalRuntime implements SubagentRuntime {
  async *run(request: SubagentRuntimeRunRequest) {
    yield { type: "started" as const, runId: request.runId };
  }
  async cancel() {}
  async steer() {}
  resume(request: SubagentRuntimeRunRequest) {
    return this.run(request);
  }
  async dispose() {}
}

class SteerableRuntime implements SubagentRuntime {
  readonly steering: Array<{ runId: string; childIndex: number; message: string }> = [];
  readonly started: Promise<void>;
  private markStarted: () => void;
  private release?: () => void;

  constructor() {
    let markStarted!: () => void;
    this.started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    this.markStarted = markStarted;
  }

  async *run(request: SubagentRuntimeRunRequest) {
    yield { type: "started" as const, runId: request.runId };
    yield {
      type: "message_update" as const,
      message: { role: "assistant", content: [{ type: "text", text: "waiting for steering" }] },
      assistantMessageEvent: { type: "text_delta", delta: "waiting for steering" },
    };
    this.markStarted();
    await new Promise<void>((resolve) => {
      this.release = resolve;
    });
    yield {
      type: "message_end" as const,
      message: { role: "assistant", content: [{ type: "text", text: "steered output" }] },
    };
    yield { type: "completed" as const, runId: request.runId };
  }

  async cancel() {}
  async steer(runId: string, childIndex: number, message: string) {
    this.steering.push({ runId, childIndex, message });
    this.release?.();
  }
  resume(request: SubagentRuntimeRunRequest) {
    return this.run(request);
  }
  async dispose() {}
}

class CancellableRuntime implements SubagentRuntime {
  readonly requests: SubagentRuntimeRunRequest[] = [];
  readonly cancellations: Array<{ runId: string; childIndex: number }> = [];
  readonly started: Promise<void>;
  private release?: () => void;
  private markStarted: () => void;
  private readonly rejectCancellation: boolean;

  constructor(rejectCancellation = false) {
    this.rejectCancellation = rejectCancellation;
    let markStarted!: () => void;
    this.started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    this.markStarted = markStarted;
  }

  async *run(request: SubagentRuntimeRunRequest) {
    this.requests.push(request);
    this.markStarted();
    await new Promise<void>((resolve) => {
      this.release = resolve;
    });
    yield { type: "failed" as const, runId: request.runId, error: "Subagent cancelled." };
  }

  async cancel(runId: string, childIndex: number) {
    this.cancellations.push({ runId, childIndex });
    this.release?.();
    if (this.rejectCancellation) throw new Error("cancel delivery failed");
  }
  async steer() {}
  resume(request: SubagentRuntimeRunRequest) {
    return this.run(request);
  }
  async dispose() {}
}

class ConcurrencyRuntime implements SubagentRuntime {
  readonly requests: SubagentRuntimeRunRequest[] = [];
  maxActive = 0;
  private active = 0;

  async *run(request: SubagentRuntimeRunRequest) {
    this.requests.push(request);
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      await new Promise((resolve) => setTimeout(resolve, 15));
      yield {
        type: "message_end" as const,
        message: { role: "assistant", content: [{ type: "text", text: `output-${request.childIndex}` }] },
      };
      yield { type: "completed" as const, runId: request.runId };
    } finally {
      this.active -= 1;
    }
  }

  async cancel() {}
  async steer() {}
  resume(request: SubagentRuntimeRunRequest) {
    return this.run(request);
  }
  async dispose() {}
}

class LiveProgressRuntime implements SubagentRuntime {
  readonly requests: SubagentRuntimeRunRequest[] = [];
  readonly started: Promise<void>;
  private markStarted: () => void;
  private release?: () => void;

  constructor() {
    let markStarted!: () => void;
    this.started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    this.markStarted = markStarted;
  }

  async *run(request: SubagentRuntimeRunRequest) {
    this.requests.push(request);
    if (request.childIndex !== 1) {
      yield { type: "failed" as const, runId: request.runId, error: `failed-${request.childIndex}` };
      return;
    }
    yield { type: "started" as const, runId: request.runId };
    yield {
      type: "message_update" as const,
      message: { role: "assistant", content: [{ type: "text", text: "visible streamed progress" }] },
      assistantMessageEvent: { type: "text_delta", delta: "visible streamed progress" },
    };
    yield {
      type: "tool_execution_start" as const,
      toolCallId: "read-1",
      toolName: "read",
      args: { path: "packages/plugin-marketplace-server/src/store.ts" },
    };
    this.markStarted();
    await new Promise<void>((resolve) => {
      this.release = resolve;
    });
    yield {
      type: "tool_execution_end" as const,
      toolCallId: "read-1",
      toolName: "read",
      result: { content: [{ type: "text", text: "done" }] },
      isError: false,
    };
    yield {
      type: "message_end" as const,
      message: { role: "assistant", content: [{ type: "text", text: "final progress result" }] },
    };
    yield { type: "completed" as const, runId: request.runId };
  }

  finish() {
    this.release?.();
  }
  async cancel() {
    this.release?.();
  }
  async steer() {}
  resume(request: SubagentRuntimeRunRequest) {
    return this.run(request);
  }
  async dispose() {}
}

class FailFastRuntime implements SubagentRuntime {
  readonly requests: SubagentRuntimeRunRequest[] = [];

  async *run(request: SubagentRuntimeRunRequest) {
    this.requests.push(request);
    if (request.childIndex === 0) {
      yield { type: "failed" as const, runId: request.runId, error: "first task failed" };
      return;
    }
    yield {
      type: "message_end" as const,
      message: { role: "assistant", content: [{ type: "text", text: "unexpected" }] },
    };
    yield { type: "completed" as const, runId: request.runId };
  }

  async cancel() {}
  async steer() {}
  resume(request: SubagentRuntimeRunRequest) {
    return this.run(request);
  }
  async dispose() {}
}

class TimeoutRuntime implements SubagentRuntime {
  readonly requests: SubagentRuntimeRunRequest[] = [];

  async *run(request: SubagentRuntimeRunRequest) {
    this.requests.push(request);
    yield {
      type: "failed" as const,
      runId: request.runId,
      error: "worker network timeout",
      code: SUBAGENT_TIMEOUT_CODE,
    };
  }

  async cancel() {}
  async steer() {}
  resume(request: SubagentRuntimeRunRequest) {
    return this.run(request);
  }
  async dispose() {}
}

const agent: AgentConfig = {
  name: "worker",
  description: "Worker",
  systemPromptMode: "append",
  inheritProjectContext: false,
  inheritSkills: false,
  systemPrompt: "Do the assigned work.",
  source: "builtin",
  filePath: "worker.md",
  completionGuard: false,
};

function context() {
  return {
    pi: { events: { emit: () => undefined } } as unknown as ExtensionAPI,
    cwd: process.cwd(),
    currentSessionId: "parent-session",
    currentModelProvider: "faux",
    interactive: true,
  };
}

function paths(id: string) {
  const asyncDir = `${ASYNC_DIR}/${id}`;
  const resultPath = `${RESULTS_DIR}/${id}.json`;
  cleanups.push(() => rmSync(asyncDir, { recursive: true, force: true }));
  cleanups.push(() => rmSync(resultPath, { force: true }));
  return { asyncDir, resultPath };
}

async function readResult(resultPath: string): Promise<Record<string, unknown>> {
  await expect.poll(() => existsSync(resultPath)).toBe(true);
  return JSON.parse(readFileSync(resultPath, "utf8")) as Record<string, unknown>;
}

describe("Desktop programmatic async modes", () => {
  it("runs async single with valid root depth and delivers real output", async () => {
    const id = `desktop-async-single-${Date.now()}`;
    const { resultPath } = paths(id);
    const runtime = new CompletingRuntime();
    const sessionFile = join(tmpdir(), `desktop-programmatic-${id}`, "run-0", "session.jsonl");

    const started = executeAsyncSingle(id, {
      agent: agent.name,
      task: "complete work",
      agentConfig: agent,
      ctx: context(),
      subagentRuntime: runtime,
      sessionFile,
      sessionDir: join(tmpdir(), `desktop-programmatic-${id}`, `async-${id}`),
      artifactConfig: { enabled: false } as never,
      shareEnabled: false,
      maxSubagentDepth: 1,
      acceptance: false,
    });

    expect(started.isError).not.toBe(true);
    const result = await readResult(resultPath);
    expect(runtime.requests[0]).toMatchObject({
      depth: 1,
      maxDepth: 1,
      lineage: [],
      sessionFile,
      sessionDir: dirname(sessionFile),
    });
    expect(result).toMatchObject({
      sessionId: "parent-session",
      state: "complete",
      summary: "first output",
      results: [{ agent: "worker", output: "first output", success: true }],
    });
  });

  it("strips thinking suffixes before programmatic worker model resolution", async () => {
    const singleId = `desktop-async-model-single-${Date.now()}`;
    const singlePaths = paths(singleId);
    const chainId = `desktop-async-model-chain-${Date.now()}`;
    const chainPaths = paths(chainId);
    const runtime = new CompletingRuntime();
    const reasoningAgent: AgentConfig = {
      ...agent,
      model: "meta-agent/gpt-5.6-sol",
      thinking: "high",
    };

    executeAsyncSingle(singleId, {
      agent: reasoningAgent.name,
      task: "single",
      agentConfig: reasoningAgent,
      ctx: context(),
      subagentRuntime: runtime,
      artifactConfig: { enabled: false } as never,
      shareEnabled: false,
      maxSubagentDepth: 1,
      acceptance: false,
    });
    executeAsyncChain(chainId, {
      chain: [{ agent: reasoningAgent.name, task: "chain", acceptance: false }],
      agents: [reasoningAgent],
      ctx: context(),
      subagentRuntime: runtime,
      artifactConfig: { enabled: false } as never,
      shareEnabled: false,
      maxSubagentDepth: 1,
    });

    await Promise.all([readResult(singlePaths.resultPath), readResult(chainPaths.resultPath)]);
    expect(runtime.requests).toHaveLength(2);
    expect(runtime.requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ model: "meta-agent/gpt-5.6-sol", thinking: "high" }),
        expect.objectContaining({ model: "meta-agent/gpt-5.6-sol", thinking: "high" }),
      ]),
    );
  });

  it("derives worker thinking from an inline model suffix without agent thinking config", async () => {
    const id = `desktop-async-suffix-thinking-${Date.now()}`;
    const { resultPath } = paths(id);
    const runtime = new CompletingRuntime();
    const suffixAgent: AgentConfig = { ...agent, model: "meta-agent/gpt-5.6-sol:high" };

    executeAsyncSingle(id, {
      agent: suffixAgent.name,
      task: "single",
      agentConfig: suffixAgent,
      ctx: context(),
      subagentRuntime: runtime,
      artifactConfig: { enabled: false } as never,
      shareEnabled: false,
      maxSubagentDepth: 1,
      acceptance: false,
    });

    await readResult(resultPath);
    expect(runtime.requests[0]).toMatchObject({ model: "meta-agent/gpt-5.6-sol", thinking: "high" });
  });

  it("passes previous output through a sequential async chain", async () => {
    const id = `desktop-async-chain-${Date.now()}`;
    const { asyncDir, resultPath } = paths(id);
    const runtime = new CompletingRuntime();

    const started = executeAsyncChain(id, {
      chain: [
        { agent: "worker", task: "first", acceptance: false },
        { agent: "worker", task: "use {previous}", acceptance: false },
      ],
      agents: [agent],
      ctx: context(),
      subagentRuntime: runtime,
      artifactConfig: { enabled: false } as never,
      shareEnabled: false,
      maxSubagentDepth: 1,
    });

    expect(started.isError).not.toBe(true);
    const result = await readResult(resultPath);
    const status = JSON.parse(readFileSync(`${asyncDir}/status.json`, "utf8")) as Record<string, unknown>;
    expect(runtime.requests).toHaveLength(2);
    expect(runtime.requests[1]?.task).toContain("first output");
    expect(runtime.requests.map(({ depth, maxDepth, childIndex }) => ({ depth, maxDepth, childIndex }))).toEqual([
      { depth: 1, maxDepth: 1, childIndex: 0 },
      { depth: 1, maxDepth: 1, childIndex: 1 },
    ]);
    expect(result).toMatchObject({ sessionId: "parent-session", state: "complete", summary: "second output" });
    expect(status).toMatchObject({ state: "complete", currentStep: 2, turnCount: 2 });
    expect(status.steps).toHaveLength(2);
  });

  it("executes a step appended while the final queued chain step is still running", async () => {
    const id = `desktop-async-append-${Date.now()}`;
    const { asyncDir, resultPath } = paths(id);
    const runtime = new AppendableRuntime();

    executeAsyncChain(id, {
      chain: [{ agent: "worker", task: "first", acceptance: false }],
      agents: [agent],
      ctx: context(),
      subagentRuntime: runtime,
      artifactConfig: { enabled: false } as never,
      shareEnabled: false,
      maxSubagentDepth: 1,
    });
    await runtime.started;

    const appended = buildAsyncRunnerSteps(id, {
      chain: [{ agent: "worker", task: "append {previous}", acceptance: false }],
      agents: [agent],
      ctx: context(),
      maxSubagentDepth: 1,
      asyncDir,
      validateOutputBindings: false,
    });
    expect(appended).not.toHaveProperty("error");
    if ("error" in appended) throw new Error(appended.error);
    enqueueChainAppendRequest({ asyncDir, runId: id, steps: appended.steps });
    const statusBeforeConsumption = JSON.parse(readFileSync(`${asyncDir}/status.json`, "utf8")) as Record<
      string,
      unknown
    >;
    expect(statusBeforeConsumption).toMatchObject({ chainStepCount: 1 });
    expect(statusBeforeConsumption).not.toHaveProperty("pendingAppends");
    runtime.finishFirst();

    const result = await readResult(resultPath);
    const status = JSON.parse(readFileSync(`${asyncDir}/status.json`, "utf8")) as Record<string, unknown>;
    expect(runtime.requests).toHaveLength(2);
    expect(runtime.requests[1]?.task).toContain("append output-0");
    expect(result).toMatchObject({ state: "complete", success: true });
    expect(status).toMatchObject({
      state: "complete",
      chainStepCount: 2,
      pendingAppends: 0,
      acceptingAppends: false,
    });
    expect(status.steps).toHaveLength(2);
  });

  it("cancels queued append requests when the active chain step fails", async () => {
    const id = `desktop-async-append-failure-${Date.now()}`;
    const { asyncDir, resultPath } = paths(id);
    const runtime = new AppendableRuntime(true);

    executeAsyncChain(id, {
      chain: [{ agent: "worker", task: "first", acceptance: false }],
      agents: [agent],
      ctx: context(),
      subagentRuntime: runtime,
      artifactConfig: { enabled: false } as never,
      shareEnabled: false,
      maxSubagentDepth: 1,
    });
    await runtime.started;

    const appended = buildAsyncRunnerSteps(id, {
      chain: [{ agent: "worker", task: "must not execute", acceptance: false }],
      agents: [agent],
      ctx: context(),
      maxSubagentDepth: 1,
      asyncDir,
      validateOutputBindings: false,
    });
    if ("error" in appended) throw new Error(appended.error);
    enqueueChainAppendRequest({ asyncDir, runId: id, steps: appended.steps });
    runtime.finishFirst();

    const result = await readResult(resultPath);
    const status = JSON.parse(readFileSync(`${asyncDir}/status.json`, "utf8")) as Record<string, unknown>;
    const events = readFileSync(`${asyncDir}/events.jsonl`, "utf8");
    expect(runtime.requests).toHaveLength(1);
    expect(result).toMatchObject({ state: "failed", success: false, error: "first step failed" });
    expect(status).toMatchObject({ state: "failed", pendingAppends: 0, acceptingAppends: false });
    expect(events).toContain('"type":"subagent.chain.append.cancelled"');
    expect(events).toContain("active chain step failed");
  });

  it("rejects append publication after the runner closes its final drain", () => {
    const id = `desktop-async-append-closing-${Date.now()}`;
    const { asyncDir } = paths(id);
    mkdirSync(asyncDir, { recursive: true });
    writeFileSync(
      `${asyncDir}/status.json`,
      JSON.stringify({
        runId: id,
        mode: "chain",
        state: "running",
        acceptingAppends: false,
        steps: [{ agent: "worker", status: "running" }],
      }),
    );

    expect(() =>
      enqueueChainAppendRequest({
        asyncDir,
        runId: id,
        steps: [],
      }),
    ).toThrow("closing and no longer accepts appended steps");
  });

  it("passes the shared deadline and turn budget to every programmatic chain leaf", async () => {
    const id = `desktop-async-chain-limits-${Date.now()}`;
    const { resultPath } = paths(id);
    const runtime = new CompletingRuntime();

    executeAsyncChain(id, {
      chain: [
        { agent: "worker", task: "first", acceptance: false },
        { agent: "worker", task: "second", acceptance: false },
      ],
      agents: [agent],
      ctx: context(),
      subagentRuntime: runtime,
      artifactConfig: { enabled: false } as never,
      shareEnabled: false,
      maxSubagentDepth: 1,
      timeoutMs: 10_000,
      turnBudget: { maxTurns: 5, graceTurns: 2 },
    });

    await readResult(resultPath);
    expect(runtime.requests).toHaveLength(2);
    expect(runtime.requests[0]?.timeoutMs).toBeGreaterThan(0);
    expect(runtime.requests[0]?.timeoutMs).toBeLessThanOrEqual(10_000);
    expect(runtime.requests[1]?.timeoutMs).toBeGreaterThan(0);
    expect(runtime.requests[1]?.timeoutMs).toBeLessThanOrEqual(runtime.requests[0]?.timeoutMs ?? 0);
    expect(runtime.requests.map(({ turnBudget }) => turnBudget)).toEqual([
      { maxTurns: 5, graceTurns: 2 },
      { maxTurns: 5, graceTurns: 2 },
    ]);
  });

  it("resolves named outputs literally and preserves the chain writer session directory", async () => {
    const id = `desktop-async-named-output-${Date.now()}`;
    const { resultPath } = paths(id);
    const literalOutput = "price $& $` $'";
    const runtime = new CompletingRuntime((request) => (request.childIndex === 0 ? literalOutput : "done"));
    const sessionFile = join(tmpdir(), `desktop-programmatic-${id}`, "run-0", "session.jsonl");

    executeAsyncChain(id, {
      chain: [
        { agent: "worker", task: "produce", as: "spec", acceptance: false },
        { agent: "worker", task: "named={outputs.spec}; previous={previous}", acceptance: false },
      ],
      agents: [agent],
      ctx: context(),
      subagentRuntime: runtime,
      sessionFilesByFlatIndex: [sessionFile, undefined],
      artifactConfig: { enabled: false } as never,
      shareEnabled: false,
      maxSubagentDepth: 1,
    });

    const result = await readResult(resultPath);
    expect(runtime.requests[0]).toMatchObject({ sessionFile, sessionDir: dirname(sessionFile), persistSession: true });
    expect(runtime.requests[1]?.task).toContain(`named=${literalOutput}; previous=${literalOutput}`);
    expect(result).toMatchObject({
      state: "complete",
      outputs: { spec: { text: literalOutput, agent: "worker", stepIndex: 0 } },
    });
  });

  it("keeps literal output-reference text from previous outputs unresolved", async () => {
    const id = `desktop-async-previous-literal-${Date.now()}`;
    const { resultPath } = paths(id);
    const literalOutput = "see {outputs.nonexistent} for details";
    const runtime = new CompletingRuntime((request) => (request.childIndex === 0 ? literalOutput : "done"));

    executeAsyncChain(id, {
      chain: [
        { agent: "worker", task: "produce", acceptance: false },
        { agent: "worker", task: "use {previous}", acceptance: false },
      ],
      agents: [agent],
      ctx: context(),
      subagentRuntime: runtime,
      artifactConfig: { enabled: false } as never,
      shareEnabled: false,
      maxSubagentDepth: 1,
    });

    const result = await readResult(resultPath);
    expect(runtime.requests).toHaveLength(2);
    expect(runtime.requests[1]?.task).toContain(literalOutput);
    expect(result).toMatchObject({ state: "complete", success: true });
  });

  it("imports an attached async root without launching a phantom worker", async () => {
    const id = `desktop-async-import-root-${Date.now()}`;
    const { resultPath } = paths(id);
    const importedDir = mkdtempSync(join(tmpdir(), "desktop-imported-root-"));
    const importedResultPath = join(importedDir, "result.json");
    cleanups.push(() => rmSync(importedDir, { recursive: true, force: true }));
    writeFileSync(
      importedResultPath,
      JSON.stringify({
        state: "complete",
        success: true,
        results: [{ agent: "worker", output: "root output", success: true }],
      }),
    );
    const runtime = new CompletingRuntime(() => "consumer output");

    executeAsyncChain(id, {
      attachRoot: {
        runId: "attached-root",
        asyncDir: importedDir,
        resultPath: importedResultPath,
        index: 0,
        agent: "worker",
        outputName: "root",
      },
      chain: [{ agent: "worker", task: "consume {outputs.root}", acceptance: false }],
      agents: [agent],
      ctx: context(),
      subagentRuntime: runtime,
      artifactConfig: { enabled: false } as never,
      shareEnabled: false,
      maxSubagentDepth: 1,
    });

    const result = await readResult(resultPath);
    expect(runtime.requests).toHaveLength(1);
    expect(runtime.requests[0]).toMatchObject({ childIndex: 1 });
    expect(runtime.requests[0]?.task).toContain("consume root output");
    expect(result).toMatchObject({
      state: "complete",
      results: [
        { agent: "worker", output: "root output", success: true },
        { agent: "worker", output: "consumer output", success: true },
      ],
      outputs: { root: { text: "root output", agent: "worker", stepIndex: 0 } },
    });
  });

  it("reports a stopped attach-root wait as cancelled rather than timed out", async () => {
    const id = `desktop-async-attach-stop-${Date.now()}`;
    const { asyncDir, resultPath } = paths(id);
    const importedDir = mkdtempSync(join(tmpdir(), "desktop-imported-wait-"));
    cleanups.push(() => rmSync(importedDir, { recursive: true, force: true }));
    const runtime = new CompletingRuntime();

    executeAsyncChain(id, {
      attachRoot: {
        runId: "attached-root",
        asyncDir: importedDir,
        resultPath: join(importedDir, "result.json"),
        index: 0,
        agent: "worker",
      },
      chain: [{ agent: "worker", task: "consume {previous}", acceptance: false }],
      agents: [agent],
      ctx: context(),
      subagentRuntime: runtime,
      artifactConfig: { enabled: false } as never,
      shareEnabled: false,
      maxSubagentDepth: 1,
    });
    await expect.poll(() => existsSync(`${asyncDir}/status.json`)).toBe(true);
    requestAsyncStop(asyncDir, { source: "test" });

    await expect.poll(() => existsSync(resultPath), { timeout: 10_000 }).toBe(true);
    const result = JSON.parse(readFileSync(resultPath, "utf8")) as Record<string, unknown>;
    expect(runtime.requests).toHaveLength(0);
    expect(result).toMatchObject({ state: "stopped", success: false });
    expect(result.timedOut).toBeUndefined();
    expect((result.results as Array<Record<string, unknown>>)[0]?.timedOut).toBeUndefined();
  });

  it("projects live parallel progress and sibling terminals for parent status", async () => {
    const id = `desktop-async-live-status-${Date.now()}`;
    const { asyncDir, resultPath } = paths(id);
    const runtime = new LiveProgressRuntime();

    executeAsyncChain(id, {
      chain: [
        {
          parallel: Array.from({ length: 3 }, (_, index) => ({
            agent: "worker",
            task: `task ${index}`,
            acceptance: false,
          })),
          concurrency: 3,
        },
      ],
      agents: [agent],
      ctx: context(),
      subagentRuntime: runtime,
      artifactConfig: { enabled: false } as never,
      shareEnabled: false,
      maxSubagentDepth: 1,
    });

    await runtime.started;
    // Tool/text projections are throttled; allow one full projection window before asserting.
    await expect
      .poll(() => JSON.parse(readFileSync(`${asyncDir}/status.json`, "utf8")) as Record<string, unknown>, {
        timeout: 5_000,
      })
      .toMatchObject({
        state: "running",
        steps: [
          { status: "failed", error: "failed-0" },
          {
            status: "running",
            currentTool: "read",
            currentPath: "packages/plugin-marketplace-server/src/store.ts",
            recentOutput: ["visible streamed progress"],
          },
          { status: "failed", error: "failed-2" },
        ],
      });

    const parentStatus = inspectSubagentStatus({ action: "status", id, includeProgress: true });
    const parentText = parentStatus.content.map((item) => (item.type === "text" ? item.text : "")).join("\n");
    expect(parentText).toContain("1 agent running · 0/3 done · 2 failed");
    expect(parentText).toContain("Current tool: read");
    expect(parentText).toContain("visible streamed progress");

    runtime.finish();
    await expect(readResult(resultPath)).resolves.toMatchObject({ state: "failed" });
  });

  it("honors per-group and global async concurrency limits", async () => {
    const id = `desktop-async-concurrency-${Date.now()}`;
    const { resultPath } = paths(id);
    const runtime = new ConcurrencyRuntime();

    executeAsyncChain(id, {
      chain: [
        {
          parallel: Array.from({ length: 6 }, (_, index) => ({
            agent: "worker",
            task: `task ${index}`,
            acceptance: false,
          })),
          concurrency: 4,
        },
      ],
      agents: [agent],
      ctx: context(),
      subagentRuntime: runtime,
      globalConcurrencyLimit: 2,
      artifactConfig: { enabled: false } as never,
      shareEnabled: false,
      maxSubagentDepth: 1,
    });

    await readResult(resultPath);
    expect(runtime.requests).toHaveLength(6);
    expect(runtime.maxActive).toBe(2);
  });

  it("skips queued parallel leaves after fail-fast triggers", async () => {
    const id = `desktop-async-fail-fast-${Date.now()}`;
    const { resultPath } = paths(id);
    const runtime = new FailFastRuntime();

    executeAsyncChain(id, {
      chain: [
        {
          parallel: Array.from({ length: 3 }, (_, index) => ({
            agent: "worker",
            task: `task ${index}`,
            acceptance: false,
          })),
          concurrency: 1,
          failFast: true,
        },
      ],
      agents: [agent],
      ctx: context(),
      subagentRuntime: runtime,
      artifactConfig: { enabled: false } as never,
      shareEnabled: false,
      maxSubagentDepth: 1,
    });

    const result = await readResult(resultPath);
    expect(runtime.requests).toHaveLength(1);
    expect(result).toMatchObject({
      state: "failed",
      results: [
        { success: false, error: "first task failed" },
        { success: false, error: "Skipped due to fail-fast.", skipped: true },
        { success: false, error: "Skipped due to fail-fast.", skipped: true },
      ],
    });
    expect((result.results as Array<Record<string, unknown>>)[0]?.skipped).toBeUndefined();
  });

  it("returns structured outputs to later named-output consumers", async () => {
    const id = `desktop-async-structured-${Date.now()}`;
    const { resultPath } = paths(id);
    const runtime = new CompletingRuntime((request) => {
      if (request.structuredOutput) {
        mkdirSync(dirname(request.structuredOutput.outputPath), { recursive: true });
        writeFileSync(request.structuredOutput.outputPath, JSON.stringify({ value: "$&" }));
      }
      return request.childIndex === 0 ? "structured complete" : "consumer complete";
    });

    executeAsyncChain(id, {
      chain: [
        {
          agent: "worker",
          task: "produce structured output",
          as: "data",
          outputSchema: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
            additionalProperties: false,
          },
          acceptance: false,
        },
        { agent: "worker", task: "consume {outputs.data}", acceptance: false },
      ],
      agents: [agent],
      ctx: context(),
      subagentRuntime: runtime,
      artifactConfig: { enabled: false } as never,
      shareEnabled: false,
      maxSubagentDepth: 1,
    });

    const result = await readResult(resultPath);
    expect(runtime.requests[1]?.task).toContain('consume {"value":"$&"}');
    expect(result).toMatchObject({
      state: "complete",
      outputs: { data: { text: '{"value":"$&"}', structured: { value: "$&" } } },
    });
  });

  it("builds failed parallel notifications from child results instead of unknown", () => {
    const details = buildCompletionDetails({
      success: false,
      state: "stopped",
      summary: "Async run stopped by user.",
      results: [
        { agent: "reviewer", status: "failed", error: "Unknown model" },
        {
          agent: "analysis.marketplace-transaction-reviewer",
          status: "stopped",
          summary: "Partial review output",
        },
      ],
    });

    expect(details.agent).toBe("reviewer+analysis.marketplace-transaction-reviewer");
    expect(details.resultPreview).toContain("1. reviewer [failed]");
    expect(details.resultPreview).toContain("Unknown model");
    expect(details.resultPreview).toContain("2. analysis.marketplace-transaction-reviewer [stopped]");
    expect(details.resultPreview).toContain("Partial review output");
  });

  it("omits child preview blocks whose text the summary already carries verbatim", () => {
    const details = buildCompletionDetails({
      success: false,
      state: "failed",
      summary: "worker exploded",
      results: [{ agent: "worker", status: "failed", error: "worker exploded" }],
    });

    expect(details.resultPreview).toBe("worker exploded");
  });

  it("caps the assembled child completion preview at the total budget", () => {
    const details = buildCompletionDetails({
      success: false,
      state: "failed",
      summary: "run failed",
      results: Array.from({ length: 5 }, (_, index) => ({
        agent: `worker-${index}`,
        status: "failed" as const,
        error: `error-${index}: ${"x".repeat(5_000)}`,
      })),
    });

    expect(details.resultPreview).toContain("run failed");
    expect(details.resultPreview).toContain("... truncated ...");
    expect(details.resultPreview.length).toBeLessThan(8_500);
  });

  it("flattens parallel children and aggregates their output for the next step", async () => {
    const id = `desktop-async-parallel-${Date.now()}`;
    const { asyncDir, resultPath } = paths(id);
    const runtime = new CompletingRuntime();

    executeAsyncChain(id, {
      chain: [
        {
          parallel: [
            { agent: "worker", task: "parallel A", acceptance: false },
            { agent: "worker", task: "parallel B", acceptance: false },
          ],
        },
        { agent: "worker", task: "combine {previous}", acceptance: false },
      ],
      agents: [agent],
      ctx: context(),
      subagentRuntime: runtime,
      artifactConfig: { enabled: false } as never,
      shareEnabled: false,
      maxSubagentDepth: 1,
    });

    await readResult(resultPath);
    const status = JSON.parse(readFileSync(`${asyncDir}/status.json`, "utf8")) as Record<string, unknown>;
    expect(runtime.requests.map(({ childIndex }) => childIndex)).toEqual([0, 1, 2]);
    expect(runtime.requests[2]?.task).toContain("=== Parallel Task 1 (worker) ===");
    expect(runtime.requests[2]?.task).toContain("=== Parallel Task 2 (worker) ===");
    expect(status.steps).toHaveLength(3);
    expect(status.parallelGroups).toEqual([{ start: 0, count: 2, stepIndex: 0 }]);
  });

  it("fails an async run whose event stream ends without a terminal event", async () => {
    const id = `desktop-async-no-terminal-${Date.now()}`;
    const { resultPath } = paths(id);

    executeAsyncSingle(id, {
      agent: agent.name,
      task: "end early",
      agentConfig: agent,
      ctx: context(),
      subagentRuntime: new NoTerminalRuntime(),
      artifactConfig: { enabled: false } as never,
      shareEnabled: false,
      maxSubagentDepth: 1,
      acceptance: false,
    });

    await expect(readResult(resultPath)).resolves.toMatchObject({
      state: "failed",
      success: false,
      error: "Subagent event stream ended without a terminal event.",
    });
  });

  it("preserves structured timeout state in async single and chain artifacts", async () => {
    const singleId = `desktop-async-timeout-single-${Date.now()}`;
    const singlePaths = paths(singleId);
    const chainId = `desktop-async-timeout-chain-${Date.now()}`;
    const chainPaths = paths(chainId);
    const runtime = new TimeoutRuntime();

    executeAsyncSingle(singleId, {
      agent: agent.name,
      task: "time out",
      agentConfig: agent,
      ctx: context(),
      subagentRuntime: runtime,
      artifactConfig: { enabled: false } as never,
      shareEnabled: false,
      maxSubagentDepth: 1,
      acceptance: false,
    });
    executeAsyncChain(chainId, {
      chain: [{ agent: "worker", task: "time out", acceptance: false }],
      agents: [agent],
      ctx: context(),
      subagentRuntime: runtime,
      artifactConfig: { enabled: false } as never,
      shareEnabled: false,
      maxSubagentDepth: 1,
    });

    const singleResult = await readResult(singlePaths.resultPath);
    const chainResult = await readResult(chainPaths.resultPath);
    const singleStatus = JSON.parse(readFileSync(`${singlePaths.asyncDir}/status.json`, "utf8")) as Record<
      string,
      unknown
    >;
    const chainStatus = JSON.parse(readFileSync(`${chainPaths.asyncDir}/status.json`, "utf8")) as Record<
      string,
      unknown
    >;
    expect(singleResult).toMatchObject({
      state: "failed",
      timedOut: true,
      results: [{ success: false, timedOut: true }],
    });
    expect(chainResult).toMatchObject({
      state: "failed",
      timedOut: true,
      results: [{ success: false, timedOut: true }],
    });
    expect(singleStatus).toMatchObject({ timedOut: true, steps: [{ timedOut: true }] });
    expect(chainStatus).toMatchObject({ timedOut: true, steps: [{ timedOut: true }] });
  });

  it("acknowledges steering delivered to the active programmatic worker", async () => {
    const id = `desktop-async-steer-${Date.now()}`;
    const { asyncDir, resultPath } = paths(id);
    const runtime = new SteerableRuntime();

    executeAsyncSingle(id, {
      agent: agent.name,
      task: "wait for steering",
      agentConfig: agent,
      ctx: context(),
      subagentRuntime: runtime,
      artifactConfig: { enabled: false } as never,
      shareEnabled: false,
      maxSubagentDepth: 1,
      acceptance: false,
    });
    await runtime.started;
    // Streamed-text projections are throttled; allow one full projection window before asserting.
    await expect
      .poll(() => JSON.parse(readFileSync(`${asyncDir}/status.json`, "utf8")) as Record<string, unknown>, {
        timeout: 5_000,
      })
      .toMatchObject({ steps: [{ status: "running", recentOutput: ["waiting for steering"] }] });
    requestAsyncSteer(asyncDir, { id: "steer-1", message: "focus here", targetIndex: 0 });

    await expect.poll(() => runtime.steering).toEqual([{ runId: id, childIndex: 0, message: "focus here" }]);
    await expect
      .poll(() => consumeSteerAcks(asyncDir))
      .toEqual([expect.objectContaining({ requestId: "steer-1", index: 0, state: "delivered" })]);
    await expect
      .poll(() => JSON.parse(readFileSync(`${asyncDir}/status.json`, "utf8")) as Record<string, unknown>)
      .toMatchObject({
        steering: {
          delivered: 1,
          recent: [{ id: "steer-1", targets: [{ index: 0, state: "delivered" }] }],
        },
      });
    await readResult(resultPath);
  });

  it("forwards async stop to the active programmatic worker", async () => {
    const id = `desktop-async-stop-${Date.now()}`;
    const { asyncDir, resultPath } = paths(id);
    const runtime = new CancellableRuntime();

    executeAsyncSingle(id, {
      agent: agent.name,
      task: "wait",
      agentConfig: agent,
      ctx: context(),
      subagentRuntime: runtime,
      artifactConfig: { enabled: false } as never,
      shareEnabled: false,
      maxSubagentDepth: 1,
      acceptance: false,
    });
    await runtime.started;
    requestAsyncStop(asyncDir, { source: "test" });

    const result = await readResult(resultPath);
    expect(runtime.cancellations).toEqual([{ runId: id, childIndex: 0 }]);
    expect(result).toMatchObject({ sessionId: "parent-session", state: "stopped", success: false });
  });

  it("settles an async stop even when cancel delivery rejects", async () => {
    const id = `desktop-async-cancel-rejection-${Date.now()}`;
    const { asyncDir, resultPath } = paths(id);
    const runtime = new CancellableRuntime(true);

    executeAsyncSingle(id, {
      agent: agent.name,
      task: "wait",
      agentConfig: agent,
      ctx: context(),
      subagentRuntime: runtime,
      artifactConfig: { enabled: false } as never,
      shareEnabled: false,
      maxSubagentDepth: 1,
      acceptance: false,
    });
    await runtime.started;
    requestAsyncStop(asyncDir, { source: "test" });

    await expect(readResult(resultPath)).resolves.toMatchObject({ state: "stopped", success: false });
    expect(runtime.cancellations).toEqual([{ runId: id, childIndex: 0 }]);
  });

  it("pauses an active programmatic worker when interrupted", async () => {
    const id = `desktop-async-interrupt-${Date.now()}`;
    const { asyncDir, resultPath } = paths(id);
    const runtime = new CancellableRuntime();

    executeAsyncSingle(id, {
      agent: agent.name,
      task: "wait",
      agentConfig: agent,
      ctx: context(),
      subagentRuntime: runtime,
      artifactConfig: { enabled: false } as never,
      shareEnabled: false,
      maxSubagentDepth: 1,
      acceptance: false,
    });
    await runtime.started;
    requestAsyncInterrupt(asyncDir, { source: "test" });

    const result = await readResult(resultPath);
    expect(runtime.cancellations).toEqual([{ runId: id, childIndex: 0 }]);
    expect(result).toMatchObject({ sessionId: "parent-session", state: "paused", success: false });
  });

  it("cancels the active leaf when an async chain is stopped", async () => {
    const id = `desktop-async-chain-stop-${Date.now()}`;
    const { asyncDir, resultPath } = paths(id);
    const runtime = new CancellableRuntime();

    executeAsyncChain(id, {
      chain: [{ agent: "worker", task: "wait", acceptance: false }],
      agents: [agent],
      ctx: context(),
      subagentRuntime: runtime,
      artifactConfig: { enabled: false } as never,
      shareEnabled: false,
      maxSubagentDepth: 1,
    });
    await runtime.started;
    requestAsyncStop(asyncDir, { source: "test" });

    const result = await readResult(resultPath);
    expect(runtime.cancellations).toEqual([{ runId: `${id}-0`, childIndex: 0 }]);
    expect(result).toMatchObject({ sessionId: "parent-session", state: "stopped", success: false });
  });
});
