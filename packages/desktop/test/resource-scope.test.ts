import { describe, expect, it, vi } from "vitest";
import { ResourceScope } from "../src/main/bootstrap/resource-scope.ts";

describe("ResourceScope", () => {
  it("disposes dependency phases in order and is idempotent", async () => {
    const calls: string[] = [];
    const scope = new ResourceScope();
    scope.add("session", "session", { dispose: () => calls.push("session") });
    scope.add("background", "background", { dispose: () => calls.push("background") });
    scope.add("browser", "browser", { dispose: async () => calls.push("browser") });

    await Promise.all([scope.dispose(), scope.dispose()]);

    expect(calls).toEqual(["background", "browser", "session"]);
  });

  it("continues after failures and aggregates named errors", async () => {
    const later = vi.fn();
    const scope = new ResourceScope();
    scope.add("broken", "background", { dispose: () => Promise.reject(new Error("boom")) });
    scope.add("later", "session", { dispose: later });

    await expect(scope.dispose()).rejects.toThrow("Failed to dispose application resources");
    expect(later).toHaveBeenCalledOnce();
  });
});
