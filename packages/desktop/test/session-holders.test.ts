import { describe, expect, it } from "vitest";
import { SessionHolderRegistry } from "../src/renderer/src/state/session-holders.ts";

describe("SessionHolderRegistry", () => {
  it("retain 累加持有数，release 递减", () => {
    const registry = new SessionHolderRegistry();
    registry.retain("a");
    registry.retain("a");
    expect(registry.isHeld("a")).toBe(true);
    expect(registry.release("a")).toBe(1);
    expect(registry.isHeld("a")).toBe(true);
    expect(registry.release("a")).toBe(0);
    expect(registry.isHeld("a")).toBe(false);
  });

  it("release 无持有者时为无操作并返回 0", () => {
    const registry = new SessionHolderRegistry();
    expect(registry.release("missing")).toBe(0);
    expect(registry.isHeld("missing")).toBe(false);
  });

  it("不同 key 互不影响", () => {
    const registry = new SessionHolderRegistry();
    registry.retain("a");
    registry.retain("b");
    registry.release("a");
    expect(registry.isHeld("a")).toBe(false);
    expect(registry.isHeld("b")).toBe(true);
  });

  it("remove 清空全部持有", () => {
    const registry = new SessionHolderRegistry();
    registry.retain("a");
    registry.retain("a");
    registry.remove("a");
    expect(registry.isHeld("a")).toBe(false);
    expect(registry.release("a")).toBe(0);
  });
});
