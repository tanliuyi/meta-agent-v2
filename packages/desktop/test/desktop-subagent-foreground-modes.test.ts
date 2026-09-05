import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentConfig } from "../src/main/pi/extensions/pi-subagents/src/agents/agents.ts";
import { runSync } from "../src/main/pi/extensions/pi-subagents/src/runs/foreground/execution.ts";
import { createDesktopChildSessionFactory } from "../src/main/pi/subagents/desktop-child-session-factory.ts";
import type { SubagentRuntime } from "../src/main/pi/subagents/subagent-runtime.ts";

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

function scriptedFactory(output: string) {
  const runtime: SubagentRuntime = {
    async *run(request) {
      yield { type: "started", runId: request.runId };
      yield {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: output }],
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
      yield { type: "completed", runId: request.runId };
    },
    async cancel() {},
    async steer() {},
    resume(request) {
      return this.run(request);
    },
    async dispose() {},
  };
  return createDesktopChildSessionFactory(runtime);
}

describe("Desktop foreground subagent integration", () => {
  it("executes a foreground worker through the current child-session contract", async () => {
    const result = await runSync(process.cwd(), [agent], "worker", "summarize the project", {
      childSessionFactory: scriptedFactory("programmatic result"),
      runId: "desktop-foreground-contract",
      sessionFile: join(tmpdir(), "desktop-foreground-contract.jsonl"),
      acceptance: false,
    });
    expect(result).toMatchObject({ exitCode: 0, finalOutput: "programmatic result" });
  }, 30_000);

  it("returns a useful failure when the selected agent is missing", async () => {
    const result = await runSync(process.cwd(), [agent], "missing", "task", {
      childSessionFactory: scriptedFactory("unused"),
      runId: "desktop-foreground-missing-agent",
      acceptance: false,
    });
    expect(result.exitCode).toBe(1);
    expect(result.error ?? result.finalOutput).toMatch(/unknown|missing|agent/i);
  });
});
