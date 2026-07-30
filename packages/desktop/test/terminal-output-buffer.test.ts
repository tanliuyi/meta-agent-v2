import { describe, expect, it } from "vitest";
import { TerminalOutputBuffer } from "../src/main/terminal/terminal-output-buffer.ts";

describe("TerminalOutputBuffer", () => {
  it("分块追加不会改变输出内容", () => {
    const output = new TerminalOutputBuffer(64);
    output.append("first ");
    output.append("second");
    expect(output.toString()).toBe("first second");
  });

  it("超过上限时保持原有的换行截断语义", () => {
    const output = new TerminalOutputBuffer(8);
    output.append("12345\n");
    output.append("abc");
    expect(output.toString()).toBe("abc");
  });

  it("没有换行时精确保留最后 maxLength 个字符", () => {
    const output = new TerminalOutputBuffer(8);
    output.append("abcdefghij");
    expect(output.toString()).toBe("cdefghij");
  });

  it("连续小 chunk 与旧字符串算法保持一致", () => {
    const output = new TerminalOutputBuffer(32);
    const chunks = ["alpha", " beta\n", "gamma", "-delta", "\nepsilon", "-zeta", "-eta", "-theta"];
    let expected = "";

    for (const chunk of chunks) {
      expected = appendReference(expected, chunk, 32);
      output.append(chunk);
      expect(output.toString()).toBe(expected);
    }
  });

  it("缓冲已满后连续单字符追加仍保持有界分块与旧语义", () => {
    const output = new TerminalOutputBuffer(65_536);
    let expected = "";

    for (let index = 0; index < 100_000; index += 1) {
      const chunk = index % 10_000 === 9_999 ? "\n" : String(index % 10);
      expected = appendReference(expected, chunk, 65_536);
      output.append(chunk);
    }

    const chunks = (output as unknown as { chunks: string[] }).chunks;
    expect(output.toString()).toBe(expected);
    expect(chunks.length).toBeLessThan(32);
  });
});

function appendReference(current: string, value: string, maxLength: number): string {
  const output = current + value;
  if (output.length <= maxLength) return output;
  const start = output.indexOf("\n", output.length - maxLength);
  return output.slice(start === -1 ? output.length - maxLength : start + 1);
}
