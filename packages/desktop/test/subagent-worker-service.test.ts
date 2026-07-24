import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import type { SidecarEventBody } from "../src/shared/sidecar-contracts.ts";
import type { SubagentHostRequest, SubagentRunEvent, SubagentRunRequest } from "../src/shared/subagent-contracts.ts";
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
      expect.arrayContaining(["started", "text-delta", "message-end", "completed"]),
    );
    expect(existsSync(markerPath)).toBe(false);
    expect(
      subagentEvents.some(
        (event) => event.type === "message-end" && JSON.stringify(event.message).includes("worker complete"),
      ),
    ).toBe(true);
  });

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
          event.event.type === "message-end" &&
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
