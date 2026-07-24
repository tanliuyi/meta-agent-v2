import { describe, expect, it } from "vitest";
import type { AgentConfig } from "../src/main/pi/extensions/pi-subagents/src/agents/agents.ts";
import { runSync } from "../src/main/pi/extensions/pi-subagents/src/runs/foreground/execution.ts";
import type {
  SubagentRuntime,
  SubagentRuntimeRunRequest,
} from "../src/main/pi/extensions/pi-subagents/src/runtime/subagent-runtime.ts";
import { DesktopSubagentRuntime } from "../src/main/pi/subagents/desktop-subagent-runtime.ts";
import type {
  SubagentExtensionProfile,
  SubagentHostRequest,
  SubagentRunEvent,
} from "../src/shared/subagent-contracts.ts";

function request() {
  return {
    runId: "run-1",
    rootRunId: "run-1",
    childIndex: 0,
    depth: 1,
    maxDepth: 1,
    lineage: [],
    agent: "worker",
    task: "Inspect the project",
    cwd: process.cwd(),
    persistSession: false,
    inheritProjectContext: false,
    inheritSkills: false,
    extensionProfile: ["provider", "memory", "runtime"] as SubagentExtensionProfile[],
  };
}

describe("DesktopSubagentRuntime", () => {
  it("enriches requests with thread identity and streams typed host events", async () => {
    let captured: SubagentHostRequest | undefined;
    const runtime = new DesktopSubagentRuntime({
      projectId: "project",
      parentThreadId: "thread",
      requestHost: async (hostRequest, emit) => {
        captured = hostRequest;
        emit?.({ type: "started", runId: "run-1" });
        emit?.({ type: "text-delta", text: "ok" });
        emit?.({ type: "completed", runId: "run-1" });
        return { status: "completed" };
      },
    });

    const events: SubagentRunEvent[] = [];
    for await (const event of runtime.run(request())) events.push(event);

    expect(captured).toEqual({
      type: "subagent.run",
      request: expect.objectContaining({
        projectId: "project",
        parentThreadId: "thread",
        runId: "run-1",
        childIndex: 0,
      }),
    });
    expect(events.map(({ type }) => type)).toEqual(["started", "text-delta", "completed"]);
  });

  it("fails duplicate runs and converts host failures into failed events", async () => {
    let rejectHost!: (error: Error) => void;
    const host = new Promise<unknown>((_resolve, reject) => {
      rejectHost = reject;
    });
    const runtime = new DesktopSubagentRuntime({
      projectId: "project",
      parentThreadId: "thread",
      requestHost: () => host,
    });
    const first = runtime.run(request());
    expect(() => runtime.run(request())).toThrow("already active");
    rejectHost(new Error("worker failed"));

    const events: SubagentRunEvent[] = [];
    for await (const event of first) events.push(event);
    expect(events).toEqual([{ type: "failed", runId: "run-1", error: "worker failed" }]);
  });

  it("runs foreground single through typed events without constructing a CLI child", async () => {
    let captured: SubagentRuntimeRunRequest | undefined;
    const fakeRuntime: SubagentRuntime = {
      async *run(input) {
        captured = input;
        yield { type: "started", runId: input.runId };
        yield {
          type: "message-end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "programmatic result" }],
            provider: "faux",
            model: "model",
            usage: {
              input: 4,
              output: 2,
              cacheRead: 0,
              cacheWrite: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
            timestamp: Date.now(),
          },
        };
        yield { type: "completed", runId: input.runId, sessionFile: "child.jsonl" };
      },
      async cancel() {},
      async steer() {},
      resume(input) {
        return this.run(input);
      },
      async dispose() {},
    };
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

    const result = await runSync(process.cwd(), [agent], "worker", "Summarize the project", {
      subagentRuntime: fakeRuntime,
      runId: "run-programmatic",
      sessionFile: "child.jsonl",
      acceptance: false,
    });

    expect(captured).toEqual(
      expect.objectContaining({
        runId: "run-programmatic",
        rootRunId: "run-programmatic",
        depth: 1,
        lineage: [],
        agent: "worker",
        task: "Summarize the project",
        extensionProfile: ["provider", "memory", "runtime"],
      }),
    );
    expect(result).toMatchObject({
      exitCode: 0,
      finalOutput: "programmatic result",
      sessionFile: "child.jsonl",
      usage: { input: 4, output: 2, turns: 1 },
    });
  });

  it("rejects extension paths instead of falling back to the CLI adapter", async () => {
    const runtime: SubagentRuntime = {
      async *run() {
        yield { type: "failed", runId: "unexpected", error: "runtime should not start" };
      },
      async cancel() {},
      async steer() {},
      resume(input) {
        return this.run(input);
      },
      async dispose() {},
    };
    const agent: AgentConfig = {
      name: "custom",
      description: "Custom",
      systemPromptMode: "append",
      inheritProjectContext: false,
      inheritSkills: false,
      systemPrompt: "Work",
      source: "project",
      filePath: "custom.md",
      extensions: ["C:\\extensions\\custom.ts"],
    };
    await expect(
      runSync(process.cwd(), [agent], "custom", "Inspect", {
        subagentRuntime: runtime,
        runId: "no-cli-fallback",
        acceptance: false,
      }),
    ).rejects.toThrow("do not accept extension file paths");
  });

  it("authorizes nested requests from the bound parent worker lineage", async () => {
    let captured: SubagentHostRequest | undefined;
    const runtime = new DesktopSubagentRuntime({
      projectId: "project",
      parentThreadId: "thread",
      parentWorker: {
        runId: "parent",
        rootRunId: "root",
        childIndex: 2,
        depth: 1,
        maxDepth: 3,
        lineage: [],
      },
      requestHost: async (request, emit) => {
        captured = request;
        if (request.type === "subagent.run") {
          emit?.({ type: "completed", runId: request.request.runId });
        }
        return { status: "completed" };
      },
    });

    const events: SubagentRunEvent[] = [];
    for await (const event of runtime.run({
      ...request(),
      runId: "nested",
      rootRunId: "nested",
      maxDepth: 3,
    })) {
      events.push(event);
    }

    expect(captured).toEqual({
      type: "subagent.run",
      request: expect.objectContaining({
        projectId: "project",
        parentThreadId: "thread",
        runId: "nested",
        rootRunId: "root",
        depth: 2,
        maxDepth: 3,
        lineage: [{ runId: "parent", childIndex: 2 }],
      }),
    });
    expect(events.at(-1)).toEqual({ type: "completed", runId: "nested" });
  });

  it("rejects nested requests whose maximum depth is below the child depth", () => {
    const runtime = new DesktopSubagentRuntime({
      projectId: "project",
      parentThreadId: "thread",
      parentWorker: {
        runId: "parent",
        rootRunId: "root",
        childIndex: 0,
        depth: 1,
        maxDepth: 3,
        lineage: [],
      },
      requestHost: async () => ({ status: "completed" }),
    });

    expect(() => runtime.run({ ...request(), runId: "nested", rootRunId: "nested", maxDepth: 1 })).toThrow(
      "Nested subagent call blocked",
    );
  });

  it("routes cancellation through the bound project and thread", async () => {
    const calls: SubagentHostRequest[] = [];
    const runtime = new DesktopSubagentRuntime({
      projectId: "project",
      parentThreadId: "thread",
      requestHost: async (request) => {
        calls.push(request);
        return null;
      },
    });

    await runtime.cancel("run-2", 3);
    expect(calls).toEqual([
      {
        type: "subagent.cancel",
        projectId: "project",
        parentThreadId: "thread",
        runId: "run-2",
        childIndex: 3,
      },
    ]);
  });
});
