import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { SubagentParams } from "../src/main/pi/extensions/pi-subagents/src/extension/schemas.ts";
import {
  COMPACT_SUBAGENT_TOOL_DESCRIPTION,
  FULL_SUBAGENT_TOOL_DESCRIPTION,
} from "../src/main/pi/extensions/pi-subagents/src/extension/tool-description.ts";
import { validateAcceptanceInput } from "../src/main/pi/extensions/pi-subagents/src/runs/shared/acceptance.ts";

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
        agent: "worker",
        task: "Implement and verify",
        acceptance: {
          level: "verified",
          verify: [{ id: "check", command: "npm run check", timeoutMs: 120_000 }],
        },
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

  it("exposes the verify field and explains the unsupported commands alias", () => {
    expect(JSON.stringify(SubagentParams)).toContain('"verify"');
    expect(validateAcceptanceInput({ commands: [{ id: "check", command: "npm run check" }] })).toEqual([
      "acceptance.commands is not supported; use acceptance.verify for runtime verification commands.",
    ]);
  });

  it("tells orchestrators that reviewed acceptance is inferred-only", () => {
    expect(FULL_SUBAGENT_TOOL_DESCRIPTION).toContain("reviewed is inferred-only and must never be passed explicitly");
    expect(COMPACT_SUBAGENT_TOOL_DESCRIPTION).toContain(
      "reviewed is inferred-only and must never be passed explicitly",
    );
  });
});
