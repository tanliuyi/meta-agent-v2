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

  it("defers reviewed rejection to acceptance validation (schema keeps it deprecated)", () => {
    expect(Value.Check(SubagentParams, { agent: "reviewer", task: "Review", acceptance: "reviewed" })).toBe(true);
    expect(
      Value.Check(SubagentParams, {
        agent: "reviewer",
        task: "Review",
        acceptance: { level: "reviewed" },
      }),
    ).toBe(true);
    expect(validateAcceptanceInput("reviewed", "acceptance")).toEqual([
      "acceptance is an achieved status, not a requestable acceptance level. For a read-only reviewer call, omit acceptance. To require independent review of a writer result, use acceptance.review.required and orchestrate the reviewer separately.",
    ]);
    expect(validateAcceptanceInput({ level: "reviewed" }, "acceptance")).toEqual([
      "acceptance.level is an achieved status, not a requestable acceptance level. For a read-only reviewer call, omit acceptance. To require independent review of a writer result, use acceptance.review.required and orchestrate the reviewer separately.",
    ]);
  });

  it("explains the unsupported commands alias and requires verify arrays for verified", () => {
    expect(validateAcceptanceInput({ level: "verified", verify: [{ id: "check", command: "npm run check" }] })).toEqual(
      [],
    );
    expect(validateAcceptanceInput({ level: "verified" })).toEqual([
      'acceptance.verify must contain at least one runtime command when level is verified. Use level "checked" or provide a non-empty acceptance.verify array.',
    ]);
    expect(validateAcceptanceInput({ commands: [{ id: "check", command: "npm run check" }] })).toEqual([
      "acceptance.commands is not supported.",
    ]);
  });

  it("tells orchestrators how reviewer acceptance works", () => {
    expect(FULL_SUBAGENT_TOOL_DESCRIPTION).toContain("acceptance.review.required requests independent writer review");
    expect(COMPACT_SUBAGENT_TOOL_DESCRIPTION).toContain("Omit acceptance for reviewer/read-only calls");
  });
});
