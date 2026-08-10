import { describe, expect, it } from "vitest";

import { parseFigmaReference } from "../src/url";

describe("parseFigmaReference", () => {
  it("parses bare file keys with explicit node IDs", () => {
    expect(parseFigmaReference("abc123", "1-2")).toMatchObject({
      fileKey: "abc123",
      nodeId: "1:2",
      isUrl: false,
    });
  });

  it("normalizes explicit colon node IDs without changing them", () => {
    expect(parseFigmaReference("abc123", "1:2")).toMatchObject({
      fileKey: "abc123",
      nodeId: "1:2",
    });
  });

  it("parses FigJam-style Figma URLs when a file key is present", () => {
    expect(parseFigmaReference("https://www.figma.com/board/abc123/FigJam?node-id=3-4")).toMatchObject({
      fileKey: "abc123",
      nodeId: "3:4",
      isUrl: true,
    });
  });
});
