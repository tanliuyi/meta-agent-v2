import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentConfig } from "../src/main/pi/extensions/pi-subagents/src/agents/agents.ts";
import { runSync } from "../src/main/pi/extensions/pi-subagents/src/runs/foreground/execution.ts";
import { DesktopSubagentRuntime } from "../src/main/pi/subagents/desktop-subagent-runtime.ts";
import type { SessionBootstrap } from "../src/shared/contracts.ts";
import type { SidecarEventBody } from "../src/shared/sidecar-contracts.ts";
import {
  SUBAGENT_TIMEOUT_CODE,
  type SubagentHostRequest,
  type SubagentRunEvent,
  type SubagentRunRequest,
} from "../src/shared/subagent-contracts.ts";
import { SubagentWorkerService } from "../src/sidecar/subagent-worker-service.ts";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("SubagentWorkerService", () => {
  it("runs a programmatic AgentSession with a faux provider and emits structured events", async () => {
    const root = join(tmpdir(), `desktop-subagent-worker-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(root, { recursive: true });
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const markerPath = join(root, "auto-extension-loaded");
    const autoExtensionDir = join(root, "extensions");
    mkdirSync(autoExtensionDir, { recursive: true });
    writeFileSync(
      join(autoExtensionDir, "auto-extension.js"),
      `import { writeFileSync } from "node:fs"; export default function () { writeFileSync(${JSON.stringify(markerPath)}, "loaded"); }\n`,
    );
    const faux = registerFauxProvider({ models: [{ id: "worker-model", reasoning: false }] });
    faux.setResponses([fauxAssistantMessage("worker complete")]);
    cleanups.push(() => faux.unregister());
    const model = faux.getModel();
    const events: SidecarEventBody[] = [];
    let releaseFlush!: () => void;
    const flushBlocked = new Promise<void>((resolve) => {
      releaseFlush = resolve;
    });
    const binding = {
      role: "subagent" as const,
      value: {
        projectId: "project",
        parentThreadId: "thread",
        runId: "run-1",
        childIndex: 0,
        agentDir: root,
      },
    };
    const providerFactory = (api: ExtensionAPI): void => {
      api.registerProvider(model.provider, {
        baseUrl: model.baseUrl,
        apiKey: "faux-key",
        api: faux.api,
        models: faux.models.map((registeredModel) => ({
          id: registeredModel.id,
          name: registeredModel.name,
          api: registeredModel.api,
          reasoning: registeredModel.reasoning,
          input: registeredModel.input,
          cost: registeredModel.cost,
          contextWindow: registeredModel.contextWindow,
          maxTokens: registeredModel.maxTokens,
        })),
      });
    };
    const created = await SubagentWorkerService.create(
      binding,
      {
        emit: (event) => events.push(event),
        requestHost: async () => undefined,
        flushEvents: () => flushBlocked,
      },
      { extensionFactories: [providerFactory] },
    );
    cleanups.push(() => created.service.dispose());
    const request: SubagentRunRequest = {
      projectId: "project",
      parentThreadId: "thread",
      runId: "run-1",
      rootRunId: "run-1",
      childIndex: 0,
      depth: 1,
      maxDepth: 1,
      lineage: [],
      agent: "worker",
      task: "Return the result",
      cwd: root,
      sessionFile: join(root, "child", "session.jsonl"),
      sessionDir: join(root, "async-run"),
      persistSession: true,
      model: `${model.provider}/${model.id}`,
      inheritProjectContext: false,
      inheritSkills: false,
      extensionProfile: ["memory", "runtime"],
    };

    const run = created.service.command({ type: "subagentRun", request });
    await expect
      .poll(() => events.some((event) => event.type === "subagent-event" && event.event.type === "completed"))
      .toBe(true);
    const liveBootstrap = (await created.service.command({ type: "subagentBootstrap" })) as SessionBootstrap;
    expect(liveBootstrap).toMatchObject({
      projectId: "project",
      control: { interaction: "read-only" },
      timeline: { phase: "idle" },
    });
    expect(JSON.stringify(liveBootstrap)).toContain("worker complete");
    expect(
      events.some(
        (event) =>
          event.type === "session-push" &&
          event.payload.type === "timeline" &&
          event.payload.batch.events.some(
            (item) => item.event.type === "phase-changed" && item.event.phase === "running",
          ),
      ),
    ).toBe(true);
    let settled = false;
    void run.finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseFlush();
    await expect(run).resolves.toEqual({
      status: "completed",
      sessionFile: join(root, "child", "session.jsonl"),
    });
    expect(existsSync(join(root, "child", "session.jsonl"))).toBe(true);

    const subagentEvents = events.flatMap((event) => (event.type === "subagent-event" ? [event.event] : []));
    expect(subagentEvents.map(({ type }) => type)).toEqual(
      expect.arrayContaining(["started", "message_update", "message_end", "completed"]),
    );
    const startedEvents = subagentEvents.filter((event) => event.type === "started");
    const messageEndEvents = subagentEvents.filter((event) => event.type === "message_end");
    const completedEvent = subagentEvents.find((event) => event.type === "completed");
    expect(startedEvents[0]).toEqual(
      expect.objectContaining({
        runId: "run-1",
        threadId: expect.any(String),
      }),
    );
    expect(startedEvents[0]).not.toHaveProperty("sessionFile");
    expect(messageEndEvents.every(({ updatedAt }) => updatedAt === startedEvents[0]?.updatedAt)).toBe(true);
    expect(completedEvent?.updatedAt).toBe(liveBootstrap.control.updatedAt);
    expect(completedEvent?.updatedAt).toBeGreaterThanOrEqual(startedEvents[0]?.updatedAt ?? 0);
    expect(startedEvents.find((event) => event.type === "started" && event.sessionFile)).toMatchObject({
      sessionFile: join(root, "child", "session.jsonl"),
    });
    expect(existsSync(markerPath)).toBe(false);
    expect(
      subagentEvents.some(
        (event) => event.type === "message_end" && JSON.stringify(event.message).includes("worker complete"),
      ),
    ).toBe(true);
  });

  it("loads an explicitly approved child extension and rejects implicit paths", async () => {
    const root = join(tmpdir(), `desktop-child-extension-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(root, { recursive: true });
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const markerPath = join(root, "child-extension-loaded");
    const childExtensionPath = join(root, "child-extension.js");
    writeFileSync(
      childExtensionPath,
      `import { writeFileSync } from "node:fs"; import { Type } from "typebox"; export default function (pi) { writeFileSync(${JSON.stringify(markerPath)}, "loaded"); pi.registerTool({ name: "child_marker", label: "Child marker", description: "test", parameters: Type.Object({}), async execute() { return { content: [{ type: "text", text: "ok" }] }; } }); }\n`,
    );
    const canonicalChildExtensionPath = realpathSync(childExtensionPath);
    const faux = registerFauxProvider({ models: [{ id: "child-model", reasoning: false }] });
    faux.setResponses([fauxAssistantMessage("child complete")]);
    cleanups.push(() => faux.unregister());
    const model = faux.getModel();
    const providerFactory = (api: ExtensionAPI): void => {
      api.registerProvider(model.provider, {
        baseUrl: model.baseUrl,
        apiKey: "faux-key",
        api: faux.api,
        models: faux.models.map((registeredModel) => ({
          id: registeredModel.id,
          name: registeredModel.name,
          api: registeredModel.api,
          reasoning: registeredModel.reasoning,
          input: registeredModel.input,
          cost: registeredModel.cost,
          contextWindow: registeredModel.contextWindow,
          maxTokens: registeredModel.maxTokens,
        })),
      });
    };
    const created = await SubagentWorkerService.create(
      {
        role: "subagent",
        value: {
          projectId: "project",
          parentThreadId: "thread",
          runId: "run-1",
          childIndex: 0,
          agentDir: root,
        },
      },
      {
        emit: () => undefined,
        requestHost: async () => undefined,
        flushEvents: async () => undefined,
      },
      { extensionFactories: [providerFactory] },
    );
    cleanups.push(() => created.service.dispose());

    await expect(
      created.service.command({
        type: "subagentRun",
        request: {
          ...baseRequest(),
          cwd: root,
          model: `${model.provider}/${model.id}`,
          tools: ["read", "child_marker"],
          childExtensions: [{ path: canonicalChildExtensionPath, tools: ["child_marker"] }],
        },
      }),
    ).resolves.toMatchObject({ status: "completed" });
    expect(existsSync(markerPath)).toBe(true);

    const invalid = await SubagentWorkerService.create(
      {
        role: "subagent",
        value: {
          projectId: "project",
          parentThreadId: "thread",
          runId: "run-2",
          childIndex: 0,
          agentDir: root,
        },
      },
      {
        emit: () => undefined,
        requestHost: async () => undefined,
        flushEvents: async () => undefined,
      },
    );
    await expect(
      invalid.service.command({
        type: "subagentRun",
        request: {
          ...baseRequest(),
          runId: "run-2",
          childExtensions: [{ path: "relative-child-extension.ts", tools: ["child_marker"] }],
        },
      }),
    ).rejects.toThrow("absolute");
    await invalid.service.dispose();
  });

  it("keeps structured_output available when the agent declares an explicit tool allowlist", async () => {
    const root = join(tmpdir(), `desktop-subagent-structured-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(root, { recursive: true });
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const outputPath = join(root, "structured-output.json");
    const faux = registerFauxProvider({ models: [{ id: "structured-model", reasoning: false }] });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("structured_output", { value: { ok: true } }), {
        stopReason: "toolUse",
      }),
    ]);
    cleanups.push(() => faux.unregister());
    const model = faux.getModel();
    const events: SidecarEventBody[] = [];
    const created = await SubagentWorkerService.create(
      {
        role: "subagent",
        value: {
          projectId: "project",
          parentThreadId: "thread",
          runId: "run-1",
          childIndex: 0,
          agentDir: root,
        },
      },
      {
        emit: (event) => events.push(event),
        requestHost: async () => undefined,
        flushEvents: async () => undefined,
      },
      {
        extensionFactories: [
          (api) => {
            api.registerProvider(model.provider, {
              baseUrl: model.baseUrl,
              apiKey: "faux-key",
              api: faux.api,
              models: faux.models.map((registeredModel) => ({
                id: registeredModel.id,
                name: registeredModel.name,
                api: registeredModel.api,
                reasoning: registeredModel.reasoning,
                input: registeredModel.input,
                cost: registeredModel.cost,
                contextWindow: registeredModel.contextWindow,
                maxTokens: registeredModel.maxTokens,
              })),
            });
          },
        ],
      },
    );
    cleanups.push(() => created.service.dispose());

    await expect(
      created.service.command({
        type: "subagentRun",
        request: {
          ...baseRequest(),
          cwd: root,
          model: `${model.provider}/${model.id}`,
          tools: ["read"],
          structuredOutput: {
            schema: {
              type: "object",
              $defs: { flag: { type: "boolean", const: true } },
              properties: { ok: { $ref: "#/$defs/flag" } },
              required: ["ok"],
              additionalProperties: false,
            },
            outputPath,
          },
        },
      }),
    ).resolves.toMatchObject({ status: "completed" });

    expect(JSON.parse(readFileSync(outputPath, "utf8"))).toEqual({ ok: true });
    expect(
      events.some(
        (event) =>
          event.type === "subagent-event" &&
          event.event.type === "tool_execution_start" &&
          event.event.toolName === "structured_output",
      ),
    ).toBe(true);
  });

  it("preserves canonical worker events and transcript records through the Desktop runtime boundary", async () => {
    const root = join(tmpdir(), `desktop-subagent-boundary-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "README.md"), "worker boundary input\n");
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));

    const faux = registerFauxProvider({ models: [{ id: "boundary-model", reasoning: false }] });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("read", { path: "README.md" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("worker boundary complete"),
    ]);
    cleanups.push(() => faux.unregister());
    const model = faux.getModel();
    const providerFactory = (api: ExtensionAPI): void => {
      api.registerProvider(model.provider, {
        baseUrl: model.baseUrl,
        apiKey: "faux-key",
        api: faux.api,
        models: faux.models.map((registeredModel) => ({
          id: registeredModel.id,
          name: registeredModel.name,
          api: registeredModel.api,
          reasoning: registeredModel.reasoning,
          input: registeredModel.input,
          cost: registeredModel.cost,
          contextWindow: registeredModel.contextWindow,
          maxTokens: registeredModel.maxTokens,
        })),
      });
    };
    const workerServices: Array<Awaited<ReturnType<typeof SubagentWorkerService.create>>["service"]> = [];
    const workerEvents: SubagentRunEvent[] = [];
    cleanups.push(async () => {
      for (const service of workerServices.reverse()) await service.dispose();
    });

    const runtime = new DesktopSubagentRuntime({
      projectId: "project",
      parentThreadId: "thread",
      requestHost: async (hostRequest, onEvent) => {
        if (hostRequest.type !== "subagent.run") throw new Error(`Unexpected worker control: ${hostRequest.type}`);
        const created = await SubagentWorkerService.create(
          {
            role: "subagent",
            value: {
              projectId: hostRequest.request.projectId,
              parentThreadId: hostRequest.request.parentThreadId,
              runId: hostRequest.request.runId,
              childIndex: hostRequest.request.childIndex,
              agentDir: root,
            },
          },
          {
            emit: (event) => {
              if (event.type !== "subagent-event") return;
              workerEvents.push(event.event);
              onEvent?.(event.event);
            },
            requestHost: async () => undefined,
            flushEvents: async () => undefined,
          },
          { extensionFactories: [providerFactory] },
        );
        workerServices.push(created.service);
        return created.service.command({ type: "subagentRun", request: hostRequest.request });
      },
    });
    cleanups.push(() => runtime.dispose());
    const agent: AgentConfig = {
      name: "worker",
      description: "Worker",
      model: `${model.provider}/${model.id}`,
      tools: ["read"],
      systemPromptMode: "append",
      inheritProjectContext: false,
      inheritSkills: false,
      systemPrompt: "Read the assigned file and report completion.",
      source: "builtin",
      filePath: "worker.md",
      completionGuard: false,
    };

    const result = await runSync(root, [agent], agent.name, "Read README.md", {
      subagentRuntime: runtime,
      runId: "boundary-run",
      acceptance: false,
      artifactsDir: join(root, "artifacts"),
      artifactConfig: { enabled: true },
    });

    expect(result).toMatchObject({ exitCode: 0, finalOutput: "worker boundary complete" });
    expect(workerEvents.map(({ type }) => type)).toEqual(
      expect.arrayContaining([
        "started",
        "message_update",
        "message_end",
        "tool_execution_start",
        "tool_execution_end",
        "completed",
      ]),
    );
    const records = readFileSync(result.transcriptPath!, "utf8")
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            sourceEventType?: string;
            recordType?: string;
            role?: string;
            text?: string;
            toolName?: string;
          },
      );
    expect(records.find(({ sourceEventType }) => sourceEventType === "tool_execution_start")).toMatchObject({
      recordType: "tool_start",
      toolName: "read",
    });
    expect(records.find(({ sourceEventType }) => sourceEventType === "tool_execution_end")).toMatchObject({
      recordType: "tool_end",
      toolName: "read",
    });
    expect(
      records.find(
        ({ sourceEventType, role, text }) =>
          sourceEventType === "message_end" && role === "assistant" && text === "worker boundary complete",
      ),
    ).toMatchObject({ recordType: "message" });
  });

  it("emits a structured timeout code from the worker boundary", async () => {
    const root = join(tmpdir(), `desktop-subagent-timeout-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(root, { recursive: true });
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const faux = registerFauxProvider({
      models: [{ id: "timeout-model", reasoning: false }],
      tokensPerSecond: 1,
    });
    faux.setResponses([fauxAssistantMessage("This response should be interrupted before it completes.")]);
    cleanups.push(() => faux.unregister());
    const model = faux.getModel();
    const events: SidecarEventBody[] = [];
    const providerFactory = (api: ExtensionAPI): void => {
      api.registerProvider(model.provider, {
        baseUrl: model.baseUrl,
        apiKey: "faux-key",
        api: faux.api,
        models: faux.models.map((registeredModel) => ({
          id: registeredModel.id,
          name: registeredModel.name,
          api: registeredModel.api,
          reasoning: registeredModel.reasoning,
          input: registeredModel.input,
          cost: registeredModel.cost,
          contextWindow: registeredModel.contextWindow,
          maxTokens: registeredModel.maxTokens,
        })),
      });
    };
    const created = await SubagentWorkerService.create(
      {
        role: "subagent",
        value: {
          projectId: "project",
          parentThreadId: "thread",
          runId: "run-1",
          childIndex: 0,
          agentDir: root,
        },
      },
      {
        emit: (event) => events.push(event),
        requestHost: async () => undefined,
        flushEvents: async () => undefined,
      },
      { extensionFactories: [providerFactory] },
    );
    cleanups.push(() => created.service.dispose());

    await expect(
      created.service.command({
        type: "subagentRun",
        request: {
          ...baseRequest(),
          cwd: root,
          model: `${model.provider}/${model.id}`,
          timeoutMs: 5,
        },
      }),
    ).rejects.toThrow();

    expect(events.find((event) => event.type === "subagent-event" && event.event.type === "failed")).toMatchObject({
      type: "subagent-event",
      event: { type: "failed", code: SUBAGENT_TIMEOUT_CODE },
    });
  }, 15_000);

  it("routes nested fanout back through a second programmatic worker", async () => {
    const root = join(tmpdir(), `desktop-subagent-nested-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(root, { recursive: true });
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const faux = registerFauxProvider({ models: [{ id: "nested-model", reasoning: false }] });
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("subagent", { agent: "delegate", task: "complete nested work", acceptance: false }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("nested worker result"),
      fauxAssistantMessage("parent received nested result"),
    ]);
    cleanups.push(() => faux.unregister());
    const model = faux.getModel();
    const providerFactory = (api: ExtensionAPI): void => {
      api.registerProvider(model.provider, {
        baseUrl: model.baseUrl,
        apiKey: "faux-key",
        api: faux.api,
        models: faux.models.map((registeredModel) => ({
          id: registeredModel.id,
          name: registeredModel.name,
          api: registeredModel.api,
          reasoning: registeredModel.reasoning,
          input: registeredModel.input,
          cost: registeredModel.cost,
          contextWindow: registeredModel.contextWindow,
          maxTokens: registeredModel.maxTokens,
        })),
      });
    };
    const nestedRequests: SubagentRunRequest[] = [];
    const nestedServices: Array<Awaited<ReturnType<typeof SubagentWorkerService.create>>["service"]> = [];
    const requestHost = async (
      hostRequest: SubagentHostRequest,
      onEvent?: (event: SubagentRunEvent) => void,
    ): Promise<unknown> => {
      if (hostRequest.type !== "subagent.run") throw new Error(`Unexpected nested control: ${hostRequest.type}`);
      nestedRequests.push(hostRequest.request);
      const nested = await SubagentWorkerService.create(
        {
          role: "subagent",
          value: {
            projectId: hostRequest.request.projectId,
            parentThreadId: hostRequest.request.parentThreadId,
            runId: hostRequest.request.runId,
            childIndex: hostRequest.request.childIndex,
            agentDir: root,
          },
        },
        {
          emit: (event) => {
            if (event.type === "subagent-event") onEvent?.(event.event);
          },
          requestHost,
          flushEvents: async () => undefined,
        },
        { extensionFactories: [providerFactory] },
      );
      nestedServices.push(nested.service);
      return nested.service.command({ type: "subagentRun", request: hostRequest.request });
    };
    cleanups.push(async () => {
      for (const service of nestedServices.reverse()) await service.dispose();
    });
    const events: SidecarEventBody[] = [];
    const created = await SubagentWorkerService.create(
      {
        role: "subagent",
        value: {
          projectId: "project",
          parentThreadId: "thread",
          runId: "root-run",
          childIndex: 0,
          agentDir: root,
        },
      },
      {
        emit: (event) => events.push(event),
        requestHost,
        flushEvents: async () => undefined,
      },
      { extensionFactories: [providerFactory] },
    );
    cleanups.push(() => created.service.dispose());
    const request: SubagentRunRequest = {
      ...baseRequest(),
      runId: "root-run",
      rootRunId: "root-run",
      cwd: root,
      model: `${model.provider}/${model.id}`,
      tools: ["subagent"],
      maxDepth: 2,
      extensionProfile: ["runtime", "fanout"],
    };

    await expect(created.service.command({ type: "subagentRun", request })).resolves.toMatchObject({
      status: "completed",
    });
    expect(nestedRequests).toHaveLength(1);
    expect(nestedRequests[0]).toMatchObject({
      projectId: "project",
      parentThreadId: "thread",
      rootRunId: "root-run",
      depth: 2,
      maxDepth: 2,
      lineage: [{ runId: "root-run", childIndex: 0 }],
    });
    expect(
      events.some(
        (event) =>
          event.type === "subagent-event" &&
          event.event.type === "message_end" &&
          JSON.stringify(event.event.message).includes("parent received nested result"),
      ),
    ).toBe(true);
  });

  it("honors cancellation requested while the session is initializing", async () => {
    const created = await SubagentWorkerService.create(
      {
        role: "subagent",
        value: {
          projectId: "project",
          parentThreadId: "thread",
          runId: "run-1",
          childIndex: 0,
          agentDir: process.cwd(),
        },
      },
      {
        emit: () => undefined,
        requestHost: async () => undefined,
        flushEvents: async () => undefined,
      },
    );
    cleanups.push(() => created.service.dispose());

    const run = created.service.command({ type: "subagentRun", request: baseRequest() });
    await created.service.command({ type: "subagentCancel", runId: "run-1" });

    await expect(run).rejects.toThrow("Subagent cancelled");
  });

  it("does not create a late session after disposal during initialization", async () => {
    const created = await SubagentWorkerService.create(
      {
        role: "subagent",
        value: {
          projectId: "project",
          parentThreadId: "thread",
          runId: "run-1",
          childIndex: 0,
          agentDir: process.cwd(),
        },
      },
      {
        emit: () => undefined,
        requestHost: async () => undefined,
        flushEvents: async () => undefined,
      },
    );

    const run = created.service.command({ type: "subagentRun", request: baseRequest() });
    await created.service.dispose();

    await expect(run).rejects.toThrow(/disposed|cancelled/i);
  });

  it("rejects requests whose maximum depth is below the current depth", async () => {
    const created = await SubagentWorkerService.create(
      {
        role: "subagent",
        value: {
          projectId: "project",
          parentThreadId: "thread",
          runId: "run-1",
          childIndex: 0,
          agentDir: process.cwd(),
        },
      },
      {
        emit: () => undefined,
        requestHost: async () => undefined,
        flushEvents: async () => undefined,
      },
    );
    cleanups.push(() => created.service.dispose());

    await expect(
      created.service.command({
        type: "subagentRun",
        request: { ...baseRequest(), depth: 2, maxDepth: 1 },
      }),
    ).rejects.toThrow("invalid depth limits");
  });

  it("rejects request identities that do not match the worker binding", async () => {
    const created = await SubagentWorkerService.create(
      {
        role: "subagent",
        value: {
          projectId: "project",
          parentThreadId: "thread",
          runId: "run-1",
          childIndex: 0,
          agentDir: process.cwd(),
        },
      },
      {
        emit: () => undefined,
        requestHost: async () => undefined,
        flushEvents: async () => undefined,
      },
    );
    await expect(
      created.service.command({ type: "subagentRun", request: { ...baseRequest(), runId: "other" } }),
    ).rejects.toThrow("identity does not match");
    await created.service.dispose();
  });
});

function baseRequest(): SubagentRunRequest {
  return {
    projectId: "project",
    parentThreadId: "thread",
    runId: "run-1",
    rootRunId: "run-1",
    childIndex: 0,
    depth: 1,
    maxDepth: 1,
    lineage: [],
    agent: "worker",
    task: "Inspect",
    cwd: process.cwd(),
    persistSession: false,
    inheritProjectContext: false,
    inheritSkills: false,
    extensionProfile: ["runtime"],
  };
}
