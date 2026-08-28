import { describe, expect, it } from "vitest";
import { asScreenshotSource } from "../src/renderer/src/components/chat/tools/browser-content.tsx";

describe("asScreenshotSource", () => {
  it("reads inline, direct resource, and wrapped dataUrl resource screenshots", () => {
    const resource = { resourceId: "resource-1", mimeType: "image/png" };

    expect(asScreenshotSource("data:image/png;base64,abc")).toBe("data:image/png;base64,abc");
    expect(asScreenshotSource(resource)).toEqual(resource);
    expect(asScreenshotSource({ dataUrl: resource, width: 800 })).toEqual(resource);
  });

  it("preserves unavailable screenshot reasons", () => {
    expect(
      asScreenshotSource({
        resourceId: "00000000-0000-4000-8000-000000000000",
        mimeType: "image/png",
        unavailable: "budget-exceeded",
      }),
    ).toEqual({
      resourceId: "00000000-0000-4000-8000-000000000000",
      mimeType: "image/png",
      unavailable: "budget-exceeded",
    });
  });

  it("rejects malformed screenshot values", () => {
    expect(asScreenshotSource({ dataUrl: { resourceId: "resource-1" } })).toBeUndefined();
    expect(asScreenshotSource(null)).toBeUndefined();
  });
});
