import { describe, expect, it } from "vitest";
import { asScreenshotSource } from "../src/renderer/src/components/chat/tools/browser-content.tsx";

describe("asScreenshotSource", () => {
  it("reads inline, direct resource, and wrapped dataUrl resource screenshots", () => {
    const resource = { resourceId: "resource-1", mimeType: "image/png" };

    expect(asScreenshotSource("data:image/png;base64,abc")).toBe("data:image/png;base64,abc");
    expect(asScreenshotSource(resource)).toEqual(resource);
    expect(asScreenshotSource({ dataUrl: resource, width: 800 })).toEqual(resource);
  });

  it("rejects malformed screenshot values", () => {
    expect(asScreenshotSource({ dataUrl: { resourceId: "resource-1" } })).toBeUndefined();
    expect(asScreenshotSource(null)).toBeUndefined();
    expect(asScreenshotSource("not-an-image")).toBeUndefined();
    expect(asScreenshotSource("data:image/png;base64,")).toBeUndefined();
    expect(asScreenshotSource({ dataUrl: "data:text/plain;base64,abc" })).toBeUndefined();
  });
});
