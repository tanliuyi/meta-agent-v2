import type { DependencyList } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const hookHarness = vi.hoisted(() => {
  type Slot = {
    deps: DependencyList;
    value: unknown;
  };

  const navigate = vi.fn();
  let nextSlot = 0;
  let slots: Slot[] = [];

  const depsEqual = (left: DependencyList, right: DependencyList) =>
    left.length === right.length && left.every((value, index) => Object.is(value, right[index]));

  const cached = <T>(create: () => T, deps: DependencyList): T => {
    const index = nextSlot++;
    const previous = slots[index];
    if (previous && depsEqual(previous.deps, deps)) {
      return previous.value as T;
    }

    const value = create();
    slots[index] = { deps, value };
    return value;
  };

  return {
    beginRender() {
      nextSlot = 0;
    },
    navigate,
    reset() {
      nextSlot = 0;
      slots = [];
      navigate.mockReset();
    },
    useCallback<T>(callback: T, deps: DependencyList) {
      return cached(() => callback, deps);
    },
    useMemo<T>(factory: () => T, deps: DependencyList) {
      return cached(factory, deps);
    },
  };
});

vi.mock("react", () => ({
  useCallback: hookHarness.useCallback,
  useMemo: hookHarness.useMemo,
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => hookHarness.navigate,
}));

vi.mock("../src/renderer/src/runtime/session-transport-context.tsx", () => ({
  useTransportManager: vi.fn(),
}));

import { useSessionNavigation } from "../src/renderer/src/state/session-navigation.ts";

beforeEach(() => {
  hookHarness.reset();
});

describe("useSessionNavigation", () => {
  it("keeps navigation callbacks stable across ordinary rerenders", () => {
    hookHarness.beginRender();
    const first = useSessionNavigation();
    hookHarness.beginRender();
    const second = useSessionNavigation();

    expect(second).toBe(first);
    expect(second.openSession).toBe(first.openSession);
    expect(second.openDraft).toBe(first.openDraft);
    expect(second.replaceSession).toBe(first.replaceSession);
    expect(second.replaceDraft).toBe(first.replaceDraft);
    expect(second.goToRoot).toBe(first.goToRoot);
  });
});
