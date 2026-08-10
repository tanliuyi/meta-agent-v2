import { describe, expect, it } from "vitest";

import figmaExtension from "../extensions/figma";

class FakePi {
  tools: Array<{ name: string; parameters?: unknown; execute: (...args: any[]) => Promise<any> }> = [];

  constructor(private readonly blockedTools = new Set<string>()) {}

  getConfig(): Record<string, unknown> {
    return {};
  }

  registerTool(tool: { name: string; parameters?: unknown; execute: (...args: any[]) => Promise<any> }): void {
    if (this.blockedTools.has(tool.name)) {
      throw new Error(`Tool collision: ${tool.name}`);
    }
    this.tools.push(tool);
  }
}

describe("figma extension registration", () => {
  it("registers the compatibility figma_context tool", () => {
    const pi = new FakePi();

    figmaExtension(pi as never);

    expect(pi.tools.map((tool) => tool.name)).toContain("figma_context");
    expect(JSON.stringify(pi.tools.find((tool) => tool.name === "figma_context")?.parameters)).toContain(
      "overview",
    );
  });

  it("skips duplicate figma_context registration during figma-context migration", () => {
    const pi = new FakePi(new Set(["figma_context"]));

    expect(() => figmaExtension(pi as never)).not.toThrow();
    expect(pi.tools.map((tool) => tool.name)).not.toContain("figma_context");
    expect(pi.tools.map((tool) => tool.name)).toContain("figma_parse_url");
  });
});
