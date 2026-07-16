import type { Message } from "@ag-ui/core";
import { describe, expect, it } from "vitest";
import { convertAgUiMessages, messageRepository } from "../src/renderer/src/runtime/ag-ui-messages.ts";

describe("AG-UI bootstrap messages", () => {
  it("使用官方转换器合并同一 user turn 内连续的 assistant messages", () => {
    const messages: Message[] = [
      { id: "user", role: "user", content: "question" },
      { id: "reasoning", role: "reasoning", content: "thinking" },
      {
        id: "assistant",
        role: "assistant",
        content: "answer",
        toolCalls: [
          {
            id: "tool-call",
            type: "function",
            function: { name: "read", arguments: '{"path":"README.md"}' },
          },
        ],
      },
      { id: "tool-result", role: "tool", toolCallId: "tool-call", content: "failed", error: "failed" },
      { id: "reasoning-2", role: "reasoning", content: "thinking again" },
      { id: "assistant-2", role: "assistant", content: "final answer" },
    ];

    const converted = convertAgUiMessages(messages);
    const repository = messageRepository(converted);
    const assistant = converted.find((message) => message.id === "assistant-2");
    const tool = assistant?.content.find((part) => part.type === "tool-call");

    expect(converted.map(({ id }) => id)).toEqual(["user", "assistant-2"]);
    expect(converted[1]?.content[0]).toEqual({ type: "reasoning", text: "thinking" });
    expect(converted[1]?.content.map(({ type }) => type)).toEqual([
      "reasoning",
      "text",
      "tool-call",
      "reasoning",
      "text",
    ]);
    expect(tool).toMatchObject({ toolCallId: "tool-call", result: "failed", isError: true });
    expect(repository.headId).toBe("assistant-2");
    expect(repository.messages.map(({ parentId }) => parentId)).toEqual([null, "user"]);
  });
});
