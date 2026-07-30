import { beforeEach, describe, expect, it, vi } from "vitest";

const reactState = vi.hoisted(() => ({ cleanups: [] as Array<() => void> }));

vi.mock("react", () => ({
  useCallback: <T>(callback: T) => callback,
  useSyncExternalStore: (subscribe: (listener: () => void) => () => void, getSnapshot: () => number) => {
    reactState.cleanups.push(subscribe(() => {}));
    return getSnapshot();
  },
}));

import { useSharedClock } from "../src/renderer/src/shared/hooks/use-shared-clock.ts";

describe("useSharedClock", () => {
  const setIntervalMock = vi.fn(() => 1);
  const clearIntervalMock = vi.fn();

  beforeEach(() => {
    reactState.cleanups = [];
    setIntervalMock.mockClear();
    clearIntervalMock.mockClear();
    vi.stubGlobal("window", {
      setInterval: setIntervalMock,
      clearInterval: clearIntervalMock,
    });
  });

  it("多个消费者共享一个 timer，并在最后一个消费者离开后清理", () => {
    useSharedClock((now) => now);
    useSharedClock((now) => now);

    expect(setIntervalMock).toHaveBeenCalledOnce();
    expect(setIntervalMock).toHaveBeenCalledWith(expect.any(Function), 60_000);
    reactState.cleanups[0]?.();
    expect(clearIntervalMock).not.toHaveBeenCalled();
    reactState.cleanups[1]?.();
    expect(clearIntervalMock).toHaveBeenCalledOnce();
  });
});
