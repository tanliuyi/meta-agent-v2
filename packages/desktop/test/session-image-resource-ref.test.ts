import { describe, expect, it } from "vitest";
import {
  parseSessionImageResourceUrl,
  toSessionImageResourceUrl,
} from "../src/renderer/src/runtime/session-image-resource-ref.ts";

describe("session image resource URL", () => {
  it("round-trips the resource id and MIME type without embedding image data", () => {
    const resource = {
      resourceId: "00000000-0000-4000-8000-000000000001",
      mimeType: "image/png",
    };
    const url = toSessionImageResourceUrl(resource);

    expect(url).toBe("pi-session-image:00000000-0000-4000-8000-000000000001#image%2Fpng");
    expect(parseSessionImageResourceUrl(url)).toEqual(resource);
    expect(url).not.toContain("base64");
  });

  it("ignores ordinary and malformed image URLs", () => {
    expect(parseSessionImageResourceUrl("data:image/png;base64,abc")).toBeUndefined();
    expect(parseSessionImageResourceUrl("pi-session-image:resource-without-mime")).toBeUndefined();
    expect(parseSessionImageResourceUrl(undefined)).toBeUndefined();
  });
});
