import { describe, expect, it } from "vitest";
import { filePathWithoutLocation } from "../src/shared/file-location.ts";

describe("filePathWithoutLocation", () => {
  it.each([
    ["/workspace/src/app.tsx:6", "/workspace/src/app.tsx"],
    ["/workspace/src/app.tsx:6-10", "/workspace/src/app.tsx"],
    ["/workspace/src/app.tsx:6:4", "/workspace/src/app.tsx"],
    ["C:\\workspace\\src\\app.tsx:6", "C:\\workspace\\src\\app.tsx"],
  ])("removes source location suffix from %s", (value, expected) => {
    expect(filePathWithoutLocation(value)).toBe(expected);
  });

  it.each(["/workspace/src/app.tsx", ":6", ""])("preserves path without a valid location suffix: %s", (value) => {
    expect(filePathWithoutLocation(value)).toBe(value);
  });
});
