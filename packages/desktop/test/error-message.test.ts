import { describe, expect, it } from "vitest";
import { errorMessage } from "../src/renderer/src/shared/lib/error-message.ts";

describe("errorMessage", () => {
  it("extracts errors serialized as plain IPC objects", () => {
    expect(errorMessage({ message: "Sidecar failed" })).toBe("Sidecar failed");
    expect(errorMessage({ error: { message: "Nested failure" } })).toBe("Nested failure");
  });

  it("never renders an opaque object coercion", () => {
    expect(errorMessage({ code: "FAILED" })).toBe('{"code":"FAILED"}');
    expect(errorMessage({})).toBe("未知错误");
  });
});
