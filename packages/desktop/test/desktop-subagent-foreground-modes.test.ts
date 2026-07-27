import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentConfig } from "../src/main/pi/extensions/pi-subagents/src/agents/agents.ts";
import { executeChain } from "../src/main/pi/extensions/pi-subagents/src/runs/foreground/chain-execution.ts";
import { runSync } from "../src/main/pi/extensions/pi-subagents/src/runs/foreground/execution.ts";
import type {
  SubagentRuntime,
  SubagentRuntimeRunRequest,
} from "../src/main/pi/extensions/pi-subagents/src/runtime/subagent-runtime.ts";
import { SUBAGENT_TIMEOUT_CODE } from "../src/shared/subagent-contracts.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

class RecordingRuntime implements SubagentRuntime {
  readonly requests: SubagentRuntimeRunRequest[] = [];
  maxActive = 0;
  private active = 0;
  private readonly expectedConcurrent: number;
  private readonly beforeComplete?: (request: SubagentRuntimeRunRequest) => void;
  private readonly outputForRequest?: (request: SubagentRuntimeRunRequest) => string;
  private release?: () => void;
  private readonly gate: Promise<void>;

  constructor(
    expectedConcurrent = 1,
    beforeComplete?: (request: SubagentRuntimeRunRequest) => void,
    outputForRequest?: (request: SubagentRuntimeRunRequest) => string,
  ) {
    this.expectedConcurrent = expectedConcurrent;
    this.beforeComplete = beforeComplete;
    this.outputForRequest = outputForRequest;
    this.gate = new Promise((resolve) => {
      this.release = resolve;
    });
  }

  async *run(request: SubagentRuntimeRunRequest) {
    this.requests.push(request);
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    if (this.active >= this.expectedConcurrent) this.release?.();
    try {
      await this.gate;
      this.beforeComplete?.(request);
      yield {
        type: "message_end" as const,
        message: {
          role: "assistant",
          content: [{ type: "text", text: this.outputForRequest?.(request) ?? `output-${request.childIndex}` }],
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

class TranscriptRuntime implements SubagentRuntime {
  async *run(request: SubagentRuntimeRunRequest) {
    yield { type: "started" as const, runId: request.runId };
    yield {
      type: "tool_execution_start" as const,
      toolCallId: "read-1",
      toolName: "read",
      args: { path: "README.md" },
    };
    yield {
      type: "tool_execution_end" as const,
      toolCallId: "read-1",
      toolName: "read",
      result: { content: [{ type: "text", text: "contents" }] },
      isError: false,
    };
    yield {
      type: "message_end" as const,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "review complete" }],
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
    yield { type: "completed" as const, runId: request.runId };
  }

  async cancel() {}
  async steer() {}
  resume(request: SubagentRuntimeRunRequest) {
    return this.run(request);
  }
  async dispose() {}
}

class InterruptingRuntime implements SubagentRuntime {
  readonly requests: SubagentRuntimeRunRequest[] = [];
  private readonly interrupt: () => void;

  constructor(interrupt: () => void) {
    this.interrupt = interrupt;
  }

  async *run(request: SubagentRuntimeRunRequest) {
    this.requests.push(request);
    this.interrupt();
    yield { type: "failed" as const, runId: request.runId, error: "Subagent cancelled." };
  }

  async cancel() {
    throw new Error("cancel delivery failed");
  }
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

class LargeFailureRuntime implements SubagentRuntime {
  private readonly error: string;

  constructor(error: string) {
    this.error = error;
  }

  async *run(request: SubagentRuntimeRunRequest) {
    yield { type: "failed" as const, runId: request.runId, error: this.error };
  }

  async cancel() {}
  async steer() {}
  resume(request: SubagentRuntimeRunRequest) {
    return this.run(request);
  }
  async dispose() {}
}

const agents: AgentConfig[] = ["first", "second"].map((name) => ({
  name,
  description: name,
  systemPromptMode: "append",
  inheritProjectContext: false,
  inheritSkills: false,
  systemPrompt: `You are ${name}.`,
  source: "builtin",
  filePath: `${name}.md`,
  completionGuard: false,
}));

describe("Desktop foreground programmatic modes", () => {
  it("supports concurrent children under one foreground parallel run identity", async () => {
    const runtime = new RecordingRuntime(2);
    const results = await Promise.all(
      agents.map((agent, childIndex) =>
        runSync(process.cwd(), agents, agent.name, `task-${childIndex}`, {
          subagentRuntime: runtime,
          runId: "parallel-run",
          index: childIndex,
          acceptance: false,
        }),
      ),
    );

    expect(runtime.maxActive).toBe(2);
    expect(runtime.requests.map(({ runId, childIndex }) => ({ runId, childIndex }))).toEqual([
      { runId: "parallel-run", childIndex: 0 },
      { runId: "parallel-run", childIndex: 1 },
    ]);
    expect(results.map(({ exitCode, finalOutput }) => ({ exitCode, finalOutput }))).toEqual([
      { exitCode: 0, finalOutput: "output-0" },
      { exitCode: 0, finalOutput: "output-1" },
    ]);
  });

  it("keeps live progress bounded without truncating the child result", async () => {
    const largeOutput = "x".repeat(2 * 1024 * 1024);
    const updates: string[] = [];

    const result = await runSync(process.cwd(), agents, "first", "produce a large result", {
      subagentRuntime: new RecordingRuntime(1, undefined, () => largeOutput),
      runId: "large-live-progress",
      acceptance: false,
      onUpdate: (update) => updates.push(JSON.stringify(update)),
    });

    expect(result.finalOutput).toBe(largeOutput);
    expect(result).toMatchObject({ provider: "faux", model: "model" });
    expect(updates.length).toBeGreaterThan(0);
    expect(Math.max(...updates.map((update) => update.length))).toBeLessThan(128 * 1024);
    expect(updates.some((update) => update.includes('"provider":"faux"') && update.includes('"model":"model"'))).toBe(
      true,
    );
    expect(updates.every((update) => !update.includes('"undefined"'))).toBe(true);
  });

  it("keeps large live errors bounded without truncating the child error", async () => {
    const largeError = "failure:".concat("x".repeat(2 * 1024 * 1024));
    const updateSizes: number[] = [];

    const result = await runSync(process.cwd(), agents, "first", "fail with a large error", {
      subagentRuntime: new LargeFailureRuntime(largeError),
      runId: "large-live-error",
      acceptance: false,
      onUpdate: (update) => updateSizes.push(JSON.stringify(update).length),
    });

    expect(result.error).toBe(largeError);
    expect(updateSizes.length).toBeGreaterThan(0);
    expect(Math.max(...updateSizes)).toBeLessThan(128 * 1024);
  });

  it("persists canonical programmatic events in the upstream child transcript", async () => {
    const root = mkdtempSync(join(tmpdir(), "desktop-subagent-transcript-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));

    const result = await runSync(root, agents, "first", "review files", {
      subagentRuntime: new TranscriptRuntime(),
      runId: "transcript-run",
      acceptance: false,
      artifactsDir: root,
      artifactConfig: { enabled: true },
    });

    expect(result.exitCode).toBe(0);
    expect(result.transcriptPath).toBeDefined();
    const records = readFileSync(result.transcriptPath!, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { sourceEventType?: string });
    expect(records.map(({ sourceEventType }) => sourceEventType)).toEqual([
      "initial_prompt",
      "tool_execution_start",
      "tool_execution_end",
      "message_end",
    ]);
  });

  it("runs sequential chain leaves through the runtime and passes previous output", async () => {
    const root = mkdtempSync(join(tmpdir(), "desktop-subagent-chain-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const runtime = new RecordingRuntime();

    const result = await executeChain({
      chain: [
        { agent: "first", task: "inspect {task}", acceptance: false },
        { agent: "second", task: "use {previous}", acceptance: false },
      ],
      task: "project",
      agents,
      ctx: extensionContext(root),
      runId: "sequential-chain",
      shareEnabled: false,
      sessionDirForIndex: () => undefined,
      sessionFileForIndex: () => undefined,
      artifactsDir: join(root, "artifacts"),
      artifactConfig: { enabled: false } as never,
      controlConfig: { enabled: false } as never,
      chainDir: join(root, "chains"),
      maxSubagentDepth: 1,
      subagentRuntime: runtime,
    });

    expect(result.isError).not.toBe(true);
    expect(runtime.requests.map(({ childIndex }) => childIndex)).toEqual([0, 1]);
    expect(runtime.requests[1]?.task).toContain("output-0");
    expect(result.details.results).toHaveLength(2);
  });

  it("substitutes previous output literally when it contains replacement tokens", async () => {
    const root = mkdtempSync(join(tmpdir(), "desktop-subagent-chain-literal-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const literalOutput = "price $& $` $'";
    const runtime = new RecordingRuntime(1, undefined, (request) =>
      request.childIndex === 0 ? literalOutput : "done",
    );

    const result = await executeChain({
      chain: [
        { agent: "first", task: "produce", acceptance: false },
        { agent: "second", task: "use {previous}", acceptance: false },
      ],
      agents,
      ctx: extensionContext(root),
      runId: "literal-chain",
      shareEnabled: false,
      sessionDirForIndex: () => undefined,
      sessionFileForIndex: () => undefined,
      artifactsDir: join(root, "artifacts"),
      artifactConfig: { enabled: false } as never,
      controlConfig: { enabled: false } as never,
      chainDir: join(root, "chains"),
      maxSubagentDepth: 1,
      subagentRuntime: runtime,
    });

    expect(result.isError).not.toBe(true);
    expect(runtime.requests[1]?.task).toContain(`use ${literalOutput}`);
  });

  it("keeps chain live progress bounded while passing the full previous output", async () => {
    const root = mkdtempSync(join(tmpdir(), "desktop-subagent-chain-large-output-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const largeOutput = "x".repeat(2 * 1024 * 1024);
    const runtime = new RecordingRuntime(1, undefined, (request) => (request.childIndex === 0 ? largeOutput : "done"));
    const updateSizes: number[] = [];

    const result = await executeChain({
      chain: [
        { agent: "first", task: "produce", acceptance: false },
        { agent: "second", task: "use {previous}", acceptance: false },
      ],
      agents,
      ctx: extensionContext(root),
      runId: "large-output-chain",
      shareEnabled: false,
      sessionDirForIndex: () => undefined,
      sessionFileForIndex: () => undefined,
      artifactsDir: join(root, "artifacts"),
      artifactConfig: { enabled: false } as never,
      controlConfig: { enabled: false } as never,
      chainDir: join(root, "chains"),
      maxSubagentDepth: 1,
      subagentRuntime: runtime,
      onUpdate: (update) => updateSizes.push(JSON.stringify(update).length),
    });

    expect(runtime.requests[1]?.task).toBe(`use ${largeOutput}`);
    expect(result.details.results[0]?.finalOutput).toBe(largeOutput);
    expect(updateSizes.length).toBeGreaterThan(0);
    expect(Math.max(...updateSizes)).toBeLessThan(128 * 1024);
  });

  it("runs parallel chain leaves concurrently through the runtime", async () => {
    const root = mkdtempSync(join(tmpdir(), "desktop-subagent-chain-parallel-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const runtime = new RecordingRuntime(2);

    const result = await executeChain({
      chain: [
        {
          parallel: [
            { agent: "first", task: "inspect A", acceptance: false },
            { agent: "second", task: "inspect B", acceptance: false },
          ],
          concurrency: 2,
        },
      ],
      agents,
      ctx: extensionContext(root),
      runId: "parallel-chain",
      shareEnabled: false,
      sessionDirForIndex: () => undefined,
      sessionFileForIndex: () => undefined,
      artifactsDir: join(root, "artifacts"),
      artifactConfig: { enabled: false } as never,
      controlConfig: { enabled: false } as never,
      chainDir: join(root, "chains"),
      maxSubagentDepth: 1,
      subagentRuntime: runtime,
    });

    expect(result.isError).not.toBe(true);
    expect(runtime.maxActive).toBe(2);
    expect(runtime.requests.map(({ childIndex }) => childIndex)).toEqual([0, 1]);
    expect(result.details.results).toHaveLength(2);
  });

  it("runs dynamic chain leaves through the runtime with stable reserved indexes", async () => {
    const root = mkdtempSync(join(tmpdir(), "desktop-subagent-chain-dynamic-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const runtime = new RecordingRuntime(1, (request) => {
      if (!request.structuredOutput) return;
      mkdirSync(join(request.structuredOutput.outputPath, ".."), { recursive: true });
      writeFileSync(request.structuredOutput.outputPath, JSON.stringify([{ name: "alpha" }, { name: "beta" }]));
    });

    const result = await executeChain({
      chain: [
        {
          agent: "first",
          task: "list items",
          as: "items",
          acceptance: false,
          outputSchema: {
            type: "array",
            items: {
              type: "object",
              properties: { name: { type: "string" } },
              required: ["name"],
              additionalProperties: false,
            },
          },
        },
        {
          expand: { from: { output: "items", path: "" }, item: "entry", key: "/name", maxItems: 2 },
          parallel: { agent: "second", task: "inspect {entry.name}", acceptance: false },
          collect: { as: "inspections" },
          concurrency: 2,
        },
      ],
      agents,
      ctx: extensionContext(root),
      runId: "dynamic-chain",
      shareEnabled: false,
      sessionDirForIndex: () => undefined,
      sessionFileForIndex: () => undefined,
      artifactsDir: join(root, "artifacts"),
      artifactConfig: { enabled: false } as never,
      controlConfig: { enabled: false } as never,
      chainDir: join(root, "chains"),
      maxSubagentDepth: 1,
      subagentRuntime: runtime,
    });

    expect(result.isError).not.toBe(true);
    expect(runtime.requests.map(({ childIndex }) => childIndex)).toEqual([0, 1, 2]);
    expect(runtime.requests[1]?.task).toContain("inspect alpha");
    expect(runtime.requests[2]?.task).toContain("inspect beta");
    expect(result.details.outputs?.inspections?.structured).toHaveLength(2);
  });

  it("does not launch a worker when the run signal is already aborted", async () => {
    const runtime = new RecordingRuntime();
    const controller = new AbortController();
    controller.abort();

    const result = await runSync(process.cwd(), agents, "first", "task", {
      subagentRuntime: runtime,
      runId: "pre-aborted",
      signal: controller.signal,
      acceptance: false,
    });

    expect(runtime.requests).toEqual([]);
    expect(result).toMatchObject({ exitCode: 1, error: "Subagent run aborted before start." });
  });

  it("does not retry another model after an interrupted empty result", async () => {
    const controller = new AbortController();
    const runtime = new InterruptingRuntime(() => controller.abort());
    const retryAgent: AgentConfig = {
      ...agents[0]!,
      model: "faux/first",
      fallbackModels: ["faux/second"],
    };

    const result = await runSync(process.cwd(), [retryAgent], retryAgent.name, "task", {
      subagentRuntime: runtime,
      runId: "interrupted-no-retry",
      interruptSignal: controller.signal,
      acceptance: false,
    });

    expect(runtime.requests).toHaveLength(1);
    expect(result).toMatchObject({ exitCode: 0, interrupted: true });
    expect(result.modelAttempts).toHaveLength(1);
  });

  it("classifies structured worker timeout events without exact message matching", async () => {
    const runtime = new TimeoutRuntime();
    const retryAgent: AgentConfig = {
      ...agents[0]!,
      model: "faux/first",
      fallbackModels: ["faux/second"],
    };

    const result = await runSync(process.cwd(), [retryAgent], retryAgent.name, "task", {
      subagentRuntime: runtime,
      runId: "structured-timeout",
      timeoutMs: 123,
      acceptance: false,
    });

    expect(runtime.requests).toHaveLength(1);
    expect(result).toMatchObject({ exitCode: 1, timedOut: true });
    expect(result.finalOutput).toContain("Subagent timed out after 123ms.");
  });

  it("persists configured single output without an undefined helper failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "desktop-subagent-output-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const outputPath = join(root, "result.md");
    const runtime = new RecordingRuntime();

    const result = await runSync(root, agents, "first", "task", {
      subagentRuntime: runtime,
      runId: "single-output",
      outputPath,
      acceptance: false,
    });

    expect(result.exitCode).toBe(0);
    expect(readFileSync(outputPath, "utf8")).toBe("output-0");
  });

  it("wires the thread runtime into top-level foreground parallel dispatch", () => {
    const source = readFileSync(
      join(process.cwd(), "src/main/pi/extensions/pi-subagents/src/runs/foreground/subagent-executor.ts"),
      "utf8",
    );
    expect(source).toMatch(
      /runSync\(input\.ctx\.cwd, input\.agents, task\.agent, taskText, \{\s*subagentRuntime: input\.subagentRuntime/,
    );
    expect(source).toMatch(/subagentRuntime: deps\.subagentRuntime,\s*\}\);\s*for \(let i = 0; i < results\.length/);
  });
});

function extensionContext(cwd: string): ExtensionContext {
  return {
    cwd,
    mode: "rpc",
    hasUI: false,
    model: undefined,
    modelRegistry: { getAvailable: () => [] },
    sessionManager: {
      getSessionId: () => "parent-session",
    },
  } as unknown as ExtensionContext;
}
