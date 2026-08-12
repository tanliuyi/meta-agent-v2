import { describe, expect, test } from "vitest";
import { parseSubagentCall } from "../src/renderer/src/components/chat/tools/subagent-format.ts";

describe("parseSubagentCall workflowScript (0.47.0)", () => {
  test("extracts agent and task from a single runs.run workflowScript", () => {
    const summary = parseSubagentCall("subagent", {
      workflowScript: "return await runs.run('probe', {agent:'worker', task:'Reply with exactly: ok'})",
      async: true,
    });

    expect(summary.mode).toBe("single");
    expect(summary.async).toBe(true);
    expect(summary.taskCount).toBe(1);
    expect(summary.specs[0]?.agent).toBe("worker");
    expect(summary.specs[0]?.task).toBe("Reply with exactly: ok");
  });

  test("falls back to ellipsis when no agent is referenced", () => {
    const summary = parseSubagentCall("subagent", {
      workflowScript: "return 42",
    });

    expect(summary.mode).toBe("single");
    expect(summary.specs[0]?.agent).toBe("…");
  });

  test("keeps legacy agent+task shape working", () => {
    const summary = parseSubagentCall("subagent", {
      agent: "reviewer",
      task: "Check the diff",
    });

    expect(summary.specs[0]?.agent).toBe("reviewer");
    expect(summary.specs[0]?.task).toBe("Check the diff");
  });
});
