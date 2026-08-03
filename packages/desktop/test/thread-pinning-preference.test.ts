import { describe, expect, it } from "vitest";
import {
  parseStoredPinnedThreads,
  pinnedThreadKey,
  readStoredPinnedThreads,
  writeStoredThreadPinned,
} from "../src/renderer/src/state/thread-pinning-preference.ts";

describe("thread pinning preference", () => {
  it("只读取版本正确且结构有效的置顶会话", () => {
    const value = JSON.stringify({
      version: 1,
      threads: [["project", "thread"], ["project", "thread"], ["other", "thread"], ["invalid"], ["invalid", 1]],
    });

    expect(parseStoredPinnedThreads(value)).toEqual(
      new Set([pinnedThreadKey("project", "thread"), pinnedThreadKey("other", "thread")]),
    );
    expect(parseStoredPinnedThreads(JSON.stringify({ version: 2, threads: [["project", "thread"]] }))).toEqual(
      new Set(),
    );
  });

  it("置顶和取消置顶会保留其他会话，并可从存储恢复", () => {
    let stored: string | null = null;
    const read = () => stored;
    const write = (value: string) => {
      stored = value;
    };

    writeStoredThreadPinned("project", "first", true, read, write);
    writeStoredThreadPinned("project", "second", true, read, write);
    writeStoredThreadPinned("project", "first", false, read, write);

    expect(readStoredPinnedThreads(read)).toEqual(new Set([pinnedThreadKey("project", "second")]));
  });

  it("存储内容损坏时回退为空集合", () => {
    expect(readStoredPinnedThreads(() => "not-json")).toEqual(new Set());
    expect(readStoredPinnedThreads(() => null)).toEqual(new Set());
  });
});
