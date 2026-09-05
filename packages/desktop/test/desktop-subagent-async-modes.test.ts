import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { AgentConfig } from "../src/main/pi/extensions/pi-subagents/src/agents/agents.ts";
import {
  buildAsyncRunnerSteps,
  formatAsyncStartedMessage,
  isAsyncAvailable,
} from "../src/main/pi/extensions/pi-subagents/src/runs/background/async-execution.ts";
import {
  requestAsyncInterrupt,
  requestAsyncSteer,
  requestAsyncStop,
} from "../src/main/pi/extensions/pi-subagents/src/runs/background/control-channel.ts";

const agent: AgentConfig = {
  name: "worker",
  description: "Worker",
  systemPromptMode: "append",
  inheritProjectContext: false,
  inheritGlobalContext: false,
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
    currentSessionId: "desktop-test-session",
    currentModelProvider: "faux",
    interactive: true,
  };
}

describe("Desktop async subagent integration", () => {
  it("keeps async execution available and exposes detached guidance", () => {
    expect(isAsyncAvailable()).toBe(true);
    const message = formatAsyncStartedMessage("Async: worker [run-1]", true);
    expect(message).toContain("detached and running in the background");
    expect(message).toContain("run-1");
  });

  it("builds current runner steps without the removed runtime injection API", () => {
    const result = buildAsyncRunnerSteps("desktop-build-steps", {
      chain: [{ agent: "worker", task: "inspect {task}", acceptance: false }],
      task: "the project",
      agents: [agent],
      ctx: context(),
      asyncDir: join(tmpdir(), "desktop-build-steps"),
      maxSubagentDepth: 1,
    });
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]).toMatchObject({ agent: "worker", task: "inspect the project" });
  });

  it("writes portable interrupt, stop, and steer requests for the detached runner", () => {
    const dir = mkdtempSync(join(tmpdir(), "desktop-async-control-"));
    try {
      const interruptPath = requestAsyncInterrupt(dir, { source: "desktop", ts: 1 });
      const stopPath = requestAsyncStop(dir, { targetIndex: 0, ts: 2 });
      const steerPath = requestAsyncSteer(dir, { message: "continue", targetIndex: 0, id: "steer-1", ts: 3 });
      expect(existsSync(interruptPath)).toBe(true);
      expect(existsSync(stopPath)).toBe(true);
      expect(JSON.parse(readFileSync(steerPath, "utf8"))).toMatchObject({
        type: "steer",
        message: "continue",
        targetIndex: 0,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
