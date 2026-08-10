import { describe, expect, it } from "vitest";

import { FigmaApi } from "../src/context/FigmaApi";

describe("FigmaApi.parseUrl", () => {
  const api = new FigmaApi();

  it("parses design and file URLs and normalizes URL node IDs for the REST API", () => {
    expect(api.parseUrl("https://www.figma.com/design/abc123/FH-System?node-id=17286-100687")).toEqual({
      fileKey: "abc123",
      nodeId: "17286:100687",
    });
    expect(api.parseUrl("https://www.figma.com/file/def456/FH-System?node-id=10:20")).toEqual({
      fileKey: "def456",
      nodeId: "10:20",
    });
  });

  it("rejects invalid URLs", () => {
    expect(() => api.parseUrl("not a url")).toThrow("node ID is required");
  });

  it("rejects non-Figma hosts", () => {
    expect(() => api.parseUrl("https://example.com/design/abc/FH?node-id=1-2")).toThrow("Not a Figma URL");
  });

  it("rejects Figma URLs without a node-id query parameter", () => {
    expect(() => api.parseUrl("https://www.figma.com/design/abc/FH")).toThrow("node ID is required");
  });
});
