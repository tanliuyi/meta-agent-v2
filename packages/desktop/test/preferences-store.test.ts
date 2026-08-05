import { describe, expect, it, vi } from "vitest";
import type { PreferencesPersistence } from "../src/renderer/src/state/preferences-store.ts";
import { createPreferencesStore } from "../src/renderer/src/state/preferences-store.ts";

function fakePersistence(values: Record<string, string> = {}): {
  persistence: PreferencesPersistence;
  saved: Array<Record<string, string>>;
  fail: (shouldFail: boolean) => void;
} {
  const saved: Array<Record<string, string>> = [];
  let shouldFail = false;
  return {
    persistence: {
      getInitial: () => ({ path: "preferences.json", exists: true, values }),
      save: (input) => {
        if (shouldFail) return Promise.reject(new Error("save failed"));
        saved.push(input.values);
        return Promise.resolve({ status: "saved" });
      },
    },
    saved,
    fail: (next) => {
      shouldFail = next;
    },
  };
}

describe("createPreferencesStore", () => {
  it("读取走同步快照，未写入的键返回 null", () => {
    const { persistence } = fakePersistence({ theme: "dark" });
    const store = createPreferencesStore({ persistence });

    expect(store.getItem("theme")).toBe("dark");
    expect(store.getItem("missing")).toBeNull();
  });

  it("写入立即生效（内存缓存），并按节流合并落盘", () => {
    vi.useFakeTimers();
    try {
      const { persistence, saved } = fakePersistence();
      const store = createPreferencesStore({ persistence, timer: setTimeout });

      store.setItem("theme", "dark");
      store.setItem("theme", "light");
      store.setItem("sidebar-width", "320");
      expect(saved).toHaveLength(0);

      vi.advanceTimersByTime(300);
      expect(saved).toEqual([{ theme: "light", "sidebar-width": "320" }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("节流窗口内多次写入只落盘一次快照", () => {
    vi.useFakeTimers();
    try {
      const { persistence, saved } = fakePersistence();
      const store = createPreferencesStore({ persistence, timer: setTimeout });

      store.setItem("a", "1");
      vi.advanceTimersByTime(100);
      store.setItem("b", "2");
      vi.advanceTimersByTime(100);
      store.setItem("c", "3");
      vi.advanceTimersByTime(300);
      expect(saved).toHaveLength(1);
      expect(saved[0]).toEqual({ a: "1", b: "2", c: "3" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("落盘失败不阻断当前窗口，后续写入重试并携带完整缓存", () => {
    vi.useFakeTimers();
    try {
      const { persistence, saved, fail } = fakePersistence();
      const store = createPreferencesStore({ persistence, timer: setTimeout });

      fail(true);
      store.setItem("theme", "dark");
      vi.advanceTimersByTime(300);
      expect(saved).toHaveLength(0);

      fail(false);
      store.setItem("theme", "light");
      vi.advanceTimersByTime(300);
      expect(saved).toHaveLength(1);
      expect(saved[0]).toEqual({ theme: "light" });
      expect(store.getItem("theme")).toBe("light");
    } finally {
      vi.useRealTimers();
    }
  });

  it("getInitial 抛错时回退为空缓存", () => {
    const store = createPreferencesStore({
      persistence: {
        getInitial: () => {
          throw new Error("unavailable");
        },
        save: () => Promise.resolve({ status: "saved" }),
      },
    });

    expect(store.getItem("theme")).toBeNull();
    store.setItem("theme", "dark");
    expect(store.getItem("theme")).toBe("dark");
  });
});
