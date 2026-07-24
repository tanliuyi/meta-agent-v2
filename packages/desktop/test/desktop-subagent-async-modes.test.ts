import { existsSync, readFileSync, rmSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentConfig } from "../src/main/pi/extensions/pi-subagents/src/agents/agents.ts";
import {
  executeAsyncChain,
  executeAsyncSingle,
} from "../src/main/pi/extensions/pi-subagents/src/runs/background/async-execution.ts";
import {
  consumeSteerAcks,
  requestAsyncInterrupt,
  requestAsyncSteer,
  requestAsyncStop,
} from "../src/main/pi/extensions/pi-subagents/src/runs/background/control-channel.ts";
import type {
  SubagentRuntime,
  SubagentRuntimeRunRequest,
} from "../src/main/pi/extensions/pi-subagents/src/runtime/subagent-runtime.ts";
import { ASYNC_DIR, RESULTS_DIR } from "../src/main/pi/extensions/pi-subagents/src/shared/types.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

class CompletingRuntime implements SubagentRuntime {
  readonly requests: SubagentRuntimeRunRequest[] = [];

  async *run(request: SubagentRuntimeRunRequest) {
    this.requests.push(request);
    const text = request.task.includes("first output") ? "second output" : "first output";
    yield { type: "started" as const, runId: request.runId };
    yield {
      type: "message-end" as const,
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
    this.markStarted();
    await new Promise<void>((resolve) => {
      this.release = resolve;
    });
    yield {
      type: "message-end" as const,
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

  constructor() {
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
  }
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

    const started = executeAsyncSingle(id, {
      agent: agent.name,
      task: "complete work",
      agentConfig: agent,
      ctx: context(),
      subagentRuntime: runtime,
      artifactConfig: { enabled: false } as never,
      shareEnabled: false,
      maxSubagentDepth: 1,
      acceptance: false,
    });

    expect(started.isError).not.toBe(true);
    const result = await readResult(resultPath);
    expect(runtime.requests[0]).toMatchObject({ depth: 1, maxDepth: 1, lineage: [] });
    expect(result).toMatchObject({
      sessionId: "parent-session",
      state: "complete",
      summary: "first output",
      results: [{ agent: "worker", output: "first output", success: true }],
    });
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
    expect(status).toMatchObject({ state: "complete", currentStep: 2 });
    expect(status.steps).toHaveLength(2);
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
