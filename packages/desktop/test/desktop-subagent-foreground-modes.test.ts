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
  private release?: () => void;
  private readonly gate: Promise<void>;

  constructor(expectedConcurrent = 1, beforeComplete?: (request: SubagentRuntimeRunRequest) => void) {
    this.expectedConcurrent = expectedConcurrent;
    this.beforeComplete = beforeComplete;
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
        type: "message-end" as const,
        message: {
          role: "assistant",
          content: [{ type: "text", text: `output-${request.childIndex}` }],
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
