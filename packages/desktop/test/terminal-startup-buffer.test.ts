import { describe, expect, it } from "vitest";
import { TerminalStartupBuffer } from "../src/renderer/src/components/panel/terminal/terminal-startup-buffer.ts";
import type { TerminalEvent } from "../src/shared/contracts.ts";

const baseEvent = {
  projectId: "project",
  threadId: "thread",
  terminalId: "terminal",
};

function data(revision: number, value: string): TerminalEvent {
  return { ...baseEvent, type: "data", revision, data: value };
}

describe("TerminalStartupBuffer", () => {
  it("超过容量时丢弃完整事件并要求重新同步权威快照", () => {
    const buffer = new TerminalStartupBuffer(8);
    buffer.append(data(1, "123456"));
    buffer.append(data(2, "abcdef"));

    expect(buffer.drain()).toEqual({ events: [data(2, "abcdef")], truncated: true });
    expect(buffer.drain()).toEqual({ events: [], truncated: false });
  });

  it("大量小分片按事件数截断且不会无限保留对象", () => {
    const buffer = new TerminalStartupBuffer(1_000_000, 32);
    for (let revision = 1; revision <= 10_000; revision += 1) {
      buffer.append(data(revision, String(revision % 10)));
    }

    const drained = buffer.drain();
    expect(drained.truncated).toBe(true);
    expect(drained.events).toHaveLength(32);
    expect(drained.events[0]?.revision).toBe(9_969);
    expect(drained.events.at(-1)?.revision).toBe(10_000);
  });

  it("reset 丢弃之前的输出并保留后续事件顺序", () => {
    const buffer = new TerminalStartupBuffer(8);
    buffer.append(data(1, "stale"));
    buffer.append({ ...baseEvent, type: "reset", revision: 2 });
    buffer.append(data(3, "fresh"));
    buffer.append({ ...baseEvent, type: "exit", revision: 4, exitCode: 0 });

    expect(buffer.drain()).toEqual({
      truncated: false,
      events: [
        { ...baseEvent, type: "reset", revision: 2 },
        data(3, "fresh"),
        { ...baseEvent, type: "exit", revision: 4, exitCode: 0 },
      ],
    });
  });

  it("不会从 surrogate pair 或 ANSI 控制序列中间裁切", () => {
    const unicode = new TerminalStartupBuffer(2);
    unicode.append(data(1, "A😀B"));
    expect(unicode.drain()).toEqual({ events: [], truncated: true });

    const ansi = new TerminalStartupBuffer(3);
    ansi.append(data(1, "\u001b[31m"));
    expect(ansi.drain()).toEqual({ events: [], truncated: true });
  });

  it("clear 释放所有挂起事件和截断状态", () => {
    const buffer = new TerminalStartupBuffer(2);
    buffer.append(data(1, "pending"));
    buffer.clear();
    expect(buffer.drain()).toEqual({ events: [], truncated: false });
  });
});
