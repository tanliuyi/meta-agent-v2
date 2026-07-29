import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { SubagentAgentSection } from "../src/renderer/src/features/settings/subagent-agent-section.tsx";
import { builtinSubagentDisplayName } from "../src/renderer/src/shared/lib/builtin-subagent-name.ts";
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
  test.each([
    ["advisor", "顾问"],
    ["context-builder", "上下文构建器"],
    ["delegate", "委派代理"],
    ["oracle", "决策智囊"],
    ["planner", "规划师"],
    ["researcher", "研究员"],
    ["reviewer", "审查员"],
    ["scout", "侦察员"],
    ["worker", "执行者"],
  ])("localizes the built-in %s agent name", (name, expected) => {
    expect(builtinSubagentDisplayName(name)).toBe(expected);
  });

  test("keeps custom agent names unchanged", () => {
    expect(builtinSubagentDisplayName("security-review")).toBe("security-review");
  });

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

  test("shows built-in agent names in Chinese while preserving the runtime id", () => {
    const markup = renderToStaticMarkup(
      <SubagentAgentSection title="内置智能体" agents={[agent]} mutating={false} builtin readOnly />,
    );

    expect(markup).toContain('<strong title="delegate">委派代理</strong>');
    expect(markup).toContain('aria-label="delegate 启用状态"');
  });
});
