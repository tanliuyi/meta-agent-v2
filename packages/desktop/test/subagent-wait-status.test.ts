import { describe, expect, test } from "vitest";
import type { AsyncRunSummary } from "../src/main/pi/extensions/pi-subagents/src/runs/background/async-status.ts";
import { asyncWaitStatusItems } from "../src/main/pi/extensions/pi-subagents/src/runs/background/subagent-wait.ts";

function makeRun(overrides: Partial<AsyncRunSummary>): AsyncRunSummary {
  return {
    id: "run-1",
    asyncDir: "/tmp/async/run-1",
    state: "running",
    startedAt: 0,
    steps: [],
    ...overrides,
  } as AsyncRunSummary;
}

describe("asyncWaitStatusItems", () => {
  test("活动步骤映射为 agent 状态行", () => {
    const items = asyncWaitStatusItems([
      makeRun({
        steps: [
          {
            index: 0,
            agent: "worker",
            status: "running",
            currentTool: "grep",
            currentPath: "src/main.ts",
          } as AsyncRunSummary["steps"][number],
        ],
      }),
    ]);

    expect(items).toEqual([{ agent: "worker", status: "running", currentTool: "grep", currentPath: "src/main.ts" }]);
  });

  test("无活动步骤时以 run id 为 agent 展示运行中", () => {
    const items = asyncWaitStatusItems([makeRun({ steps: [] })]);

    expect(items).toEqual([{ agent: "run-1", status: "running" }]);
  });

  test("pending 步骤映射为等待中且可缺省工具信息", () => {
    const items = asyncWaitStatusItems([
      makeRun({
        steps: [{ index: 0, agent: "planner", status: "pending" } as AsyncRunSummary["steps"][number]],
      }),
    ]);

    expect(items).toEqual([{ agent: "planner", status: "pending" }]);
  });

  test("终态步骤不进入等待列表", () => {
    const items = asyncWaitStatusItems([
      makeRun({
        steps: [
          { index: 0, agent: "done", status: "completed" } as AsyncRunSummary["steps"][number],
          { index: 1, agent: "worker", status: "running" } as AsyncRunSummary["steps"][number],
        ],
      }),
    ]);

    expect(items).toEqual([{ agent: "worker", status: "running" }]);
  });
});
