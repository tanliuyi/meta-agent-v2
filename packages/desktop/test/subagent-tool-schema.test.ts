import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { SubagentParams } from "../src/main/pi/extensions/pi-subagents/src/extension/schemas.ts";
import {
  COMPACT_SUBAGENT_TOOL_DESCRIPTION,
  FULL_SUBAGENT_TOOL_DESCRIPTION,
} from "../src/main/pi/extensions/pi-subagents/src/extension/tool-description.ts";

describe("subagent tool schema", () => {
  it("accepts supported explicit acceptance forms", () => {
    expect(Value.Check(SubagentParams, { agent: "reviewer", task: "Review", acceptance: "auto" })).toBe(true);
    expect(Value.Check(SubagentParams, { agent: "reviewer", task: "Review", acceptance: false })).toBe(true);
    expect(
      Value.Check(SubagentParams, {
        agent: "reviewer",
        task: "Review",
        acceptance: { level: "none", reason: "Read-only review" },
      }),
    ).toBe(true);
    expect(
      Value.Check(SubagentParams, {
        tasks: [{ agent: "reviewer", task: "Review", acceptance: { level: "checked", criteria: [] } }],
      }),
    ).toBe(true);
  });

  it("rejects inferred-only reviewed acceptance before tool execution", () => {
    expect(Value.Check(SubagentParams, { agent: "reviewer", task: "Review", acceptance: "reviewed" })).toBe(false);
    expect(
      Value.Check(SubagentParams, {
        agent: "reviewer",
        task: "Review",
        acceptance: { level: "reviewed" },
      }),
    ).toBe(false);
    expect(
      Value.Check(SubagentParams, {
        tasks: [{ agent: "reviewer", task: "Review", acceptance: "reviewed" }],
      }),
    ).toBe(false);
    expect(
      Value.Check(SubagentParams, {
        tasks: [{ agent: "reviewer", task: "Review", acceptance: { level: "reviewed" } }],
      }),
    ).toBe(false);
  });

  it("tells orchestrators that reviewed acceptance is inferred-only", () => {
    expect(FULL_SUBAGENT_TOOL_DESCRIPTION).toContain("reviewed is inferred-only and must never be passed explicitly");
    expect(COMPACT_SUBAGENT_TOOL_DESCRIPTION).toContain(
      "reviewed is inferred-only and must never be passed explicitly",
    );
  });
});
