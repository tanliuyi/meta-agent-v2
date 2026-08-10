import { describe, expect, it } from "vitest";

import {
  buildFigmaContextForMode,
  renderFigmaContext,
} from "../src/context/FigmaContext";
import type { FigmaNode } from "../src/schemas";

const sampleTree: FigmaNode = {
  id: "1:2",
  name: "Open Account Flow",
  type: "FRAME",
  absoluteBoundingBox: { x: 0, y: 0, width: 390, height: 844 },
  children: [
    {
      id: "1:3",
      name: "Header",
      type: "TEXT",
      characters: "Open your account",
      absoluteBoundingBox: { x: 24, y: 40, width: 240, height: 32 },
      style: { fontFamily: "Inter", fontSize: 24, fontWeight: 700 },
    },
    {
      id: "1:4",
      name: "Primary CTA",
      type: "INSTANCE",
      componentId: "button-component",
      componentProperties: { "Label#1": { value: "Continue" } },
      absoluteBoundingBox: { x: 24, y: 760, width: 342, height: 48 },
      children: [
        {
          id: "1:5",
          name: "Button label",
          type: "TEXT",
          characters: "Continue",
        },
      ],
    },
  ],
};

const figmaApi = {
  parseUrl: () => ({ fileKey: "abc123", nodeId: "1:2" }),
  getNodeByUrl: async () => sampleTree,
};

describe("figma context compatibility", () => {
  it("renders screen markdown with component and text context", async () => {
    const output = await buildFigmaContextForMode(
      {
        url: "https://www.figma.com/design/abc123/FH?node-id=1-2",
        mode: "screen",
        format: "markdown",
      },
      { figmaApi: figmaApi as never },
    );

    const markdown = renderFigmaContext(output, "markdown");

    expect(markdown).toContain("# Open Account Flow");
    expect(markdown).toContain("Primary CTA");
    expect(markdown).toContain("Open your account");
  });

  it("renders overview markdown with screen candidates and detected text", async () => {
    const output = await buildFigmaContextForMode(
      {
        url: "https://www.figma.com/design/abc123/FH?node-id=1-2",
        mode: "overview",
        format: "markdown",
      },
      { figmaApi: figmaApi as never },
    );

    const markdown = renderFigmaContext(output, "markdown");

    expect(markdown).toContain("# Figma Overview: Open Account Flow");
    expect(markdown).toContain("Screens found: 1");
    expect(markdown).toContain("Open your account");
  });
});
