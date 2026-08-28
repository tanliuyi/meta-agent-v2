import { describe, expect, it } from "vitest";
import { isMutationCommand } from "../src/main/sidecar/worker-client.ts";

describe("sidecar command classification", () => {
  it("treats image resource reads as read-only", () => {
    expect(isMutationCommand("getImageResource")).toBe(false);
    expect(isMutationCommand("bootstrap")).toBe(false);
    expect(isMutationCommand("prompt")).toBe(true);
  });
});
