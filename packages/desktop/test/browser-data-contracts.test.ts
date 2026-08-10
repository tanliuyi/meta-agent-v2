import { afterEach, describe, expect, test, vi } from "vitest";
import {
  normalizeBrowserDataSnapshot,
  normalizeBrowserSitePermission,
  normalizeContactProfile,
  normalizePersistedDownload,
  normalizePersistedHistoryEntry,
  normalizeSavedPassword,
} from "../src/shared/browser-data-contracts.ts";

afterEach(() => {
  vi.useRealTimers();
});

describe("browser data contracts normalize", () => {
  test("历史记录：非法条目丢弃，合法字段保留", () => {
    expect(normalizePersistedHistoryEntry(null)).toBeNull();
    expect(normalizePersistedHistoryEntry("bad")).toBeNull();
    expect(normalizePersistedHistoryEntry({ url: "", title: "x", timestamp: 1 })).toBeNull();
    expect(normalizePersistedHistoryEntry({ url: "https://example.com", title: "Example", timestamp: 123 })).toEqual({
      url: "https://example.com",
      title: "Example",
      timestamp: 123,
    });
    // 标题非字符串：整条丢弃（不回退）
    expect(normalizePersistedHistoryEntry({ url: "https://example.com", title: 42, timestamp: 123 })).toBeNull();
  });

  test("下载记录：非法状态回退 interrupted，而非丢弃", () => {
    expect(
      normalizePersistedDownload({
        id: "d1",
        url: "https://example.com/file.zip",
        filename: "file.zip",
        path: "/tmp/file.zip",
        totalBytes: 100,
        receivedBytes: 100,
        state: "completed",
        startedAt: 1,
        endedAt: 2,
      }),
    ).toMatchObject({ id: "d1", state: "completed", endedAt: 2 });
    expect(
      normalizePersistedDownload({
        id: "d1",
        url: "https://example.com/file.zip",
        filename: "file.zip",
        path: null,
        totalBytes: 0,
        receivedBytes: 0,
        state: "unknown",
        startedAt: 1,
        endedAt: null,
      }),
    ).toMatchObject({ state: "interrupted", endedAt: null });
    expect(
      normalizePersistedDownload({
        id: "d1",
        url: "https://example.com/file.zip",
        filename: "file.zip",
        path: null,
        totalBytes: 0,
        receivedBytes: 0,
        state: "interrupted",
        startedAt: 1,
        endedAt: null,
      }),
    ).toMatchObject({ state: "interrupted", endedAt: null });
    // 缺少 id / filename：丢弃
    expect(normalizePersistedDownload({ id: "", url: "u", filename: "f", state: "completed" })).toBeNull();
    expect(normalizePersistedDownload({ id: "d", url: "u", filename: "", state: "completed" })).toBeNull();
  });

  test("联系信息：缺失字段补空字符串", () => {
    expect(normalizeContactProfile({ id: "c1", fullName: "张三" })).toMatchObject({
      id: "c1",
      fullName: "张三",
      email: "",
      phone: "",
      company: "",
      city: "",
    });
    expect(normalizeContactProfile({ fullName: "张三" })).toBeNull();
  });

  test("密码：缺少 password 字段的条目丢弃", () => {
    expect(
      normalizeSavedPassword({
        id: "p1",
        origin: "https://example.com",
        username: "u",
        password: "pw",
      }),
    ).toMatchObject({ id: "p1", origin: "https://example.com", username: "u", password: "pw" });
    expect(normalizeSavedPassword({ id: "p1", origin: "https://example.com", username: "u" })).toBeNull();
    expect(normalizeSavedPassword({ id: "p1", origin: "", username: "u", password: "pw" })).toBeNull();
    expect(normalizeSavedPassword({ id: "p1", origin: "x", username: "u", password: "pw" })).toMatchObject({
      origin: "x",
      password: "pw",
    });
  });

  test("网站设置：kind 与 value 白名单，非法丢弃", () => {
    expect(
      normalizeBrowserSitePermission({ id: "s1", site: "example.com", kind: "camera", value: "allow", updatedAt: 1 }),
    ).toMatchObject({ site: "example.com", kind: "camera", value: "allow" });
    expect(
      normalizeBrowserSitePermission({ id: "s1", site: "example.com", kind: "gadget", value: "allow", updatedAt: 1 }),
    ).toBeNull();
    expect(
      normalizeBrowserSitePermission({ id: "s1", site: "example.com", kind: "camera", value: "maybe", updatedAt: 1 }),
    ).toBeNull();
  });

  test("全量快照：仅保留合法条目", () => {
    const snapshot = normalizeBrowserDataSnapshot({
      history: [{ url: "https://a.com", title: "A", timestamp: 1 }, { url: 42 }],
      downloads: [{ id: "", url: "u", filename: "f", state: "completed" }],
      contacts: [{ id: "c1", fullName: "李四" }],
      passwords: [{ id: "p1", origin: "https://b.com", username: "u", password: "pw" }],
      sitePermissions: [{ id: "s1", site: "b.com", kind: "notifications", value: "deny", updatedAt: 1 }],
    });
    expect(snapshot).toMatchObject({
      history: [{ url: "https://a.com", title: "A", timestamp: 1 }],
      downloads: [],
      contacts: [{ id: "c1", fullName: "李四" }],
      passwords: [{ id: "p1", origin: "https://b.com", username: "u", password: "pw" }],
      sitePermissions: [{ id: "s1", site: "b.com", kind: "notifications", value: "deny" }],
    });
  });
});
