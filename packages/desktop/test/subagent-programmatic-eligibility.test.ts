import { describe, expect, it } from "vitest";
import { discoverAgents } from "../src/main/pi/extensions/pi-subagents/src/agents/agents.ts";
import { canUseProgrammaticSubagentRuntime } from "../src/main/pi/extensions/pi-subagents/src/runs/shared/programmatic-runtime-capabilities.ts";

describe("programmatic runtime eligibility (desktop environment)", () => {
  it("delegate should be eligible for the programmatic runtime", () => {
    const { agents } = discoverAgents(process.cwd(), "both");
    const delegate = agents.find((a) => a.name === "delegate");
    expect(delegate).toBeDefined();
    const result = canUseProgrammaticSubagentRuntime(delegate!, {
      cwd: process.cwd(),
      permissions: undefined,
      allowIntercomDetach: false,
    });
    console.log("delegate eligibility:", result);
    expect(result).toBe(true);
  });
});
