import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentConfig } from "../src/main/pi/extensions/pi-subagents/src/agents/agents.ts";
import { discoverAgents } from "../src/main/pi/extensions/pi-subagents/src/agents/agents.ts";
import {
  applyIntercomBridgeToAgent,
  resolveIntercomBridge,
} from "../src/main/pi/extensions/pi-subagents/src/intercom/intercom-bridge.ts";
import { runSync } from "../src/main/pi/extensions/pi-subagents/src/runs/foreground/execution.ts";
import { requiresParentIntercomDetach } from "../src/main/pi/extensions/pi-subagents/src/runs/foreground/subagent-executor.ts";
import { canUseProgrammaticSubagentRuntime } from "../src/main/pi/extensions/pi-subagents/src/runs/shared/programmatic-runtime-capabilities.ts";
import { DesktopSubagentRuntime } from "../src/main/pi/subagents/desktop-subagent-runtime.ts";
import type { SubagentRunRequest } from "../src/shared/subagent-contracts.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function bridgeInjectedAgents(): AgentConfig[] {
  const { agents } = discoverAgents(process.cwd(), "both");
  const bridge = resolveIntercomBridge({
    config: { mode: "always" },
    context: undefined,
    orchestratorTarget: "subagent-chat-test",
  });
  expect(bridge.active).toBe(true);
  return agents.map((agent) => applyIntercomBridgeToAgent(agent, bridge));
}

describe("programmatic runtime eligibility (desktop environment)", () => {
  it("keeps builtin delegate eligible for the programmatic runtime", () => {
    const { agents } = discoverAgents(process.cwd(), "both");
    const delegate = agents.find((a) => a.name === "delegate");
    expect(delegate).toBeDefined();
    if (!delegate) throw new Error("builtin delegate agent must be discovered");
    const result = canUseProgrammaticSubagentRuntime(delegate, {
      cwd: process.cwd(),
      permissions: undefined,
      allowIntercomDetach: false,
    });
    expect(result).toBe(true);
  });

  it("keeps builtin worker/oracle/delegate eligible after intercom bridge injection for workflow and async children", () => {
    const injected = bridgeInjectedAgents();
    for (const name of ["worker", "oracle", "delegate"]) {
      const agent = injected.find((a) => a.name === name);
      expect(agent, name).toBeDefined();
      if (!agent) throw new Error(`builtin agent '${name}' must be discovered`);
      // The bridge marker lands in the agent system prompt and the coordination
      // tools land in the allowlist.
      expect(agent.systemPrompt, name).toContain("Intercom orchestration channel:");
      expect(agent.tools, name).toEqual(expect.arrayContaining(["contact_supervisor", "intercom"]));
      // Workflow (background) and async children run with no parent-detach
      // requirement: intercom is served by the programmatic supervisor channel.
      expect(
        canUseProgrammaticSubagentRuntime(agent, {
          cwd: process.cwd(),
          permissions: undefined,
          allowIntercomDetach: false,
        }),
        name,
      ).toBe(true);
    }
  });

  it("keeps the detached CLI fallback when a direct foreground run needs parent detach", () => {
    const injected = bridgeInjectedAgents();
    for (const name of ["worker", "oracle", "delegate"]) {
      const agent = injected.find((a) => a.name === name);
      expect(agent, name).toBeDefined();
      if (!agent) throw new Error(`builtin agent '${name}' must be discovered`);
      // Direct foreground runs block the orchestrating session; the CLI-only
      // parent-detach mechanism is not available on the programmatic runtime.
      expect(
        canUseProgrammaticSubagentRuntime(agent, {
          cwd: process.cwd(),
          permissions: undefined,
          allowIntercomDetach: true,
        }),
        name,
      ).toBe(false);
    }
  });

  it("requests parent detach only for direct foreground runs, not workflow children", () => {
    const injected = bridgeInjectedAgents();
    const worker = injected.find((a) => a.name === "worker");
    expect(worker).toBeDefined();
    // A workflow child runs inside a background workflow while the session stays
    // free to answer supervisor requests through the supervisor channel.
    expect(requiresParentIntercomDetach(worker, true)).toBe(false);
    // A direct foreground run blocks the session until the child settles, so it
    // needs the detached CLI fallback to keep intercom working.
    expect(requiresParentIntercomDetach(worker, false)).toBe(true);
    // Without an injected bridge there is no coordination channel at all.
    const { agents } = discoverAgents(process.cwd(), "both");
    const plainWorker = agents.find((a) => a.name === "worker");
    expect(plainWorker).toBeDefined();
    expect(requiresParentIntercomDetach(plainWorker, false)).toBe(false);
  });

  it("passes supervisor channel metadata into the programmatic worker request", async () => {
    const root = join(tmpdir(), `desktop-subagent-supervisor-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(root, { recursive: true });
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const received: SubagentRunRequest[] = [];
    const runtime = new DesktopSubagentRuntime({
      projectId: "project",
      parentThreadId: "thread",
      requestHost: async (hostRequest, onEvent) => {
        if (hostRequest.type !== "subagent.run") throw new Error(`Unexpected control: ${hostRequest.type}`);
        received.push(hostRequest.request);
        onEvent?.({ type: "started", runId: hostRequest.request.runId, threadId: "child-thread" });
        onEvent?.({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
            stopReason: "stop",
            timestamp: Date.now(),
          },
        });
        onEvent?.({ type: "completed", runId: hostRequest.request.runId });
        return { status: "completed" };
      },
    });
    cleanups.push(() => runtime.dispose());
    const agent: AgentConfig = {
      name: "worker",
      description: "Worker",
      systemPrompt: "Work.",
      systemPromptMode: "append",
      inheritProjectContext: false,
      inheritSkills: false,
      source: "builtin",
      filePath: "worker.md",
      completionGuard: false,
    };

    const result = await runSync(root, [agent], agent.name, "Return the result", {
      subagentRuntime: runtime,
      runId: "run-1",
      parentSessionId: "parent-session",
      orchestratorIntercomTarget: "subagent-chat-parent",
      intercomSessionName: "subagent-worker-run-1",
      acceptance: false,
    });

    expect(result).toMatchObject({ exitCode: 0, finalOutput: "done" });
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      runId: "run-1",
      parentSessionId: "parent-session",
      orchestratorTarget: "subagent-chat-parent",
      intercomSessionName: "subagent-worker-run-1",
    });
  });
});
