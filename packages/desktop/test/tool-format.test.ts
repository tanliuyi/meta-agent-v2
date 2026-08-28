import { describe, expect, it } from "vitest";
import { parseToolResult } from "../src/renderer/src/components/chat/tools/tool-format.ts";

describe("parseToolResult image parts", () => {
  it("keeps inline base64 image parts as data", () => {
    const parsed = parseToolResult({
      content: [
        { type: "image", data: "abc", mimeType: "image/png" },
        { type: "text", text: "ok" },
      ],
    });
    expect(parsed?.images).toEqual([{ data: "abc", mimeType: "image/png" }]);
  });

  it("extracts resource references without an image body", () => {
    const parsed = parseToolResult({
      content: [{ type: "image", resourceId: "resource-1", mimeType: "image/png" }],
    });
    expect(parsed?.images).toEqual([{ resourceId: "resource-1", mimeType: "image/png" }]);
    expect(parsed?.text).toBe("");
  });
});
