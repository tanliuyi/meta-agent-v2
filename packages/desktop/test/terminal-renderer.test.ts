import { describe, expect, it } from "vitest";
import { shouldUseWebglRenderer } from "../src/renderer/src/components/panel/terminal/terminal-renderer.ts";

describe("terminal renderer selection", () => {
  it("仅在有效的整数设备像素比下使用 WebGL", () => {
    expect(shouldUseWebglRenderer(1)).toBe(true);
    expect(shouldUseWebglRenderer(2)).toBe(true);
    expect(shouldUseWebglRenderer(1.0000002)).toBe(true);
    expect(shouldUseWebglRenderer(1.25)).toBe(false);
    expect(shouldUseWebglRenderer(1.5)).toBe(false);
  });

  it("无效设备像素比回退到 DOM renderer", () => {
    expect(shouldUseWebglRenderer(0)).toBe(false);
    expect(shouldUseWebglRenderer(Number.NaN)).toBe(false);
    expect(shouldUseWebglRenderer(Number.POSITIVE_INFINITY)).toBe(false);
  });
});
