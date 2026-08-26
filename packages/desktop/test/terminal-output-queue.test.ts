import { describe, expect, it } from "vitest";
import {
  TerminalOutputQueue,
  type TerminalOutputTarget,
} from "../src/renderer/src/components/panel/terminal/terminal-output-queue.ts";

class DelayedTerminal implements TerminalOutputTarget {
  screen = "";
  writes = 0;
  private readonly pending: Array<() => void> = [];

  reset(): void {
    this.screen = "";
  }

  write(data: string | Uint8Array, callback?: () => void): void {
    this.writes += 1;
    const text = typeof data === "string" ? data : new TextDecoder().decode(data);
    this.pending.push(() => {
      this.screen += text;
      callback?.();
    });
  }

  flush(): void {
    this.pending.shift()?.();
  }
}

describe("TerminalOutputQueue", () => {
  it("等待旧 write 完成后才 reset 并写入新快照", async () => {
    const terminal = new DelayedTerminal();
    const output = new TerminalOutputQueue(terminal);

    expect(output.write("STALE")).toBe(true);
    const fresh = output.replace("FRESH");
    terminal.flush();
    await Promise.resolve();
    expect(terminal.screen).toBe("");

    terminal.flush();
    await fresh;
    expect(terminal.screen).toBe("FRESH");
  });

  it("合并相邻增量写并拒绝超过容量的积压", async () => {
    const terminal = new DelayedTerminal();
    const output = new TerminalOutputQueue(terminal, 4);

    expect(output.write("A")).toBe(true);
    expect(output.write("BC")).toBe(true);
    expect(output.write("D")).toBe(true);
    expect(output.write("EF")).toBe(false);

    terminal.flush();
    await Promise.resolve();
    terminal.flush();
    await Promise.resolve();

    expect(terminal.screen).toBe("ABCD");
    expect(terminal.writes).toBe(2);
  });

  it("dispose 释放当前写与待处理屏障", async () => {
    const terminal = new DelayedTerminal();
    const output = new TerminalOutputQueue(terminal);

    expect(output.write("STALE")).toBe(true);
    const replacement = output.replace("FRESH");
    output.dispose();

    await replacement;
    expect(output.write("IGNORED")).toBe(false);
  });
});
