import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { SubagentAgentSection } from "../src/renderer/src/features/settings/subagent-agent-section.tsx";
import type { AgentSummary } from "../src/shared/subagent-contracts.ts";

const agent: AgentSummary = {
  name: "delegate",
  description: "Delegates a focused task",
  source: "builtin",
  filePath: "builtin:delegate",
  systemPrompt: "Delegate the task.",
  systemPromptMode: "replace",
  inheritProjectContext: true,
  inheritSkills: true,
};

describe("subagent settings components", () => {
  test("keeps regular agent sections expanded by default", () => {
    const markup = renderToStaticMarkup(
      <SubagentAgentSection title="包智能体" agents={[agent]} mutating={false} readOnly />,
    );

    expect(markup).not.toContain('data-state="closed"');
    expect(markup).toContain("delegate");
  });

  test("keeps built-in agents collapsed by default when requested", () => {
    const markup = renderToStaticMarkup(
      <SubagentAgentSection title="内置智能体" agents={[agent]} mutating={false} defaultCollapsed readOnly />,
    );

    expect(markup).toContain('data-state="closed"');
    expect(markup).toContain("内置智能体");
    expect(markup).not.toContain("delegate");
    expect(markup).toMatch(/<h3[^>]*><button[^>]*type="button"/);
    expect(markup).not.toMatch(/<button[^>]*><h3/);
  });
});
