import { describe, expect, it } from "vitest";
import { projectPersistedBranch } from "../src/main/pi/pi-thread-projector.ts";
import { QUOTE_ATTACHMENT_CUSTOM_TYPE, withQuoteContext } from "../src/main/pi/quote-context.ts";
import type { SessionImageResource } from "../src/shared/contracts.ts";

describe("projectPersistedBranch", () => {
  it("projects an RPC branch and folds tool results into the owning assistant", () => {
    const entries = [
      messageEntry("u", null, userMessage("问题", 1)),
      messageEntry("a", "u", assistantMessage("toolUse", 2, [toolCall("call-1")])),
      messageEntry("r", "a", toolResult("call-1", false, 3)),
    ];

    const projection = projectPersistedBranch(entries, "r");

    expect(projection.headId).toBe("pi-message:assistant:2");
    expect(projection.nodes).toMatchObject([
      { id: "pi-message:user:1", sourceEntryId: "u", kind: "user" },
      {
        id: "pi-message:assistant:2",
        sourceEntryId: "a",
        kind: "assistant",
        content: [{ type: "tool-call", execution: "complete", result: { content: [{ text: "result" }] } }],
      },
    ]);
  });

  it("rejects missing and cyclic RPC branch links", () => {
    expect(() =>
      projectPersistedBranch([{ type: "model_change", id: "leaf", parentId: "missing", timestamp: iso(1) }], "leaf"),
    ).toThrow("RPC session parent does not exist: missing");
    expect(() =>
      projectPersistedBranch(
        [
          { type: "model_change", id: "a", parentId: "b", timestamp: iso(1) },
          { type: "model_change", id: "b", parentId: "a", timestamp: iso(2) },
        ],
        "a",
      ),
    ).toThrow("RPC session branch contains a cycle at a");
  });

  it("keeps provider run time, completion time, status and thinking provenance", () => {
    const entries = [
      { type: "thinking_level_change", id: "level", parentId: null, timestamp: iso(1), thinkingLevel: "max" },
      messageEntry("assistant", "level", assistantMessage("stop", 1_000, [{ type: "text", text: "answer" }]), 13_000),
    ];

    const projection = projectPersistedBranch(entries, "assistant");

    expect(projection.thinkingLevel).toBe("max");
    expect(projection.nodes[0]).toMatchObject({
      kind: "assistant",
      createdAt: 1_000,
      completedAt: 13_000,
      status: { type: "complete", reason: "stop" },
      provenance: { provider: "test", model: "faux", thinkingLevel: "max" },
    });
  });

  it("freezes thinking provenance at each model-call boundary", () => {
    const entries = [
      { type: "thinking_level_change", id: "low", parentId: null, timestamp: iso(1), thinkingLevel: "low" },
      messageEntry("user", "low", userMessage("问题", 2)),
      { type: "thinking_level_change", id: "max", parentId: "user", timestamp: iso(3), thinkingLevel: "max" },
      messageEntry("first", "max", assistantMessage("toolUse", 2, [toolCall("call-1")]), 4),
      messageEntry("result", "first", toolResult("call-1", false, 5)),
      { type: "thinking_level_change", id: "high", parentId: "result", timestamp: iso(5.5), thinkingLevel: "high" },
      messageEntry("second", "high", assistantMessage("stop", 6, [{ type: "text", text: "完成" }])),
    ];

    const projection = projectPersistedBranch(entries, "second");

    expect(projection.thinkingLevel).toBe("high");
    expect(projection.nodes).toMatchObject([
      { kind: "user" },
      { kind: "assistant", provenance: { thinkingLevel: "low" } },
      { kind: "assistant", provenance: { thinkingLevel: "high" } },
    ]);
  });

  it("omits provider-redacted reasoning while preserving visible content", () => {
    const entries = [
      messageEntry(
        "assistant",
        null,
        assistantMessage("stop", 10, [
          { type: "thinking", thinking: "encrypted", redacted: true },
          { type: "text", text: "visible" },
        ]),
      ),
    ];

    const projection = projectPersistedBranch(entries, "assistant");

    expect(projection.nodes[0]).toMatchObject({
      kind: "assistant",
      content: [{ id: "pi-message:assistant:10:text:1", type: "text", text: "visible" }],
    });
  });

  it("keeps Desktop quote attachments and labels around Pi messages", () => {
    const quote = { text: "引用内容", messageId: "assistant-source" };
    const entries = [
      messageEntry("u", null, userMessage(withQuoteContext("实际问题", [quote]), 1)),
      {
        type: "custom",
        id: "quote-entry",
        parentId: "u",
        timestamp: iso(2),
        customType: QUOTE_ATTACHMENT_CUSTOM_TYPE,
        data: { userEntryId: "u", requestId: "request-1", quotes: [quote] },
      },
      { type: "label", id: "label-entry", parentId: "quote-entry", timestamp: iso(3), targetId: "u", label: "重点" },
    ];

    const projection = projectPersistedBranch(entries, "label-entry");

    expect(projection.nodes).toMatchObject([
      {
        kind: "user",
        sourceEntryId: "u",
        content: [{ type: "text", text: "实际问题" }],
        quote,
        label: "重点",
      },
    ]);
  });

  it("projects visible custom messages and ignores hidden ones", () => {
    const entries = [
      {
        type: "custom_message",
        id: "hidden",
        parentId: null,
        timestamp: iso(1),
        customType: "system-data",
        content: [{ type: "text", text: "hidden" }],
        display: false,
      },
      {
        type: "custom_message",
        id: "visible",
        parentId: "hidden",
        timestamp: iso(2),
        customType: "user-extension.notice",
        content: [{ type: "text", text: "visible" }],
        details: { source: "pi" },
        display: true,
      },
    ];

    const projection = projectPersistedBranch(entries, "visible");

    expect(projection.nodes).toMatchObject([
      {
        id: "visible",
        parentId: null,
        kind: "notice",
        content: { type: "custom", customType: "user-extension.notice", details: { source: "pi" } },
      },
    ]);
  });

  it("projects persisted images as lazy resources without embedding base64 payloads", () => {
    const resources = new Map<string, SessionImageResource>();
    const register = (mimeType: string, data: string) => {
      const resource = { resourceId: `resource-${resources.size + 1}`, mimeType, data };
      resources.set(resource.resourceId, resource);
      return { resourceId: resource.resourceId, mimeType };
    };
    const user = {
      role: "user",
      content: [
        { type: "text", text: "查看图片" },
        { type: "image", data: "base64-user-image", mimeType: "image/png" },
      ],
      timestamp: 1,
    };
    const result = {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read",
      content: [{ type: "image", data: "base64-tool-image", mimeType: "image/jpeg" }],
      isError: false,
      timestamp: 3,
    };
    const entries = [
      messageEntry("u", null, user),
      messageEntry("a", "u", assistantMessage("toolUse", 2, [toolCall("call-1")])),
      messageEntry("r", "a", result),
    ];

    const projection = projectPersistedBranch(entries, "r", register);
    const serialized = JSON.stringify(projection);

    expect(serialized).not.toContain("base64-user-image");
    expect(serialized).not.toContain("base64-tool-image");
    expect(projection.nodes).toMatchObject([
      { kind: "user", content: [{ type: "text" }, { type: "image", resourceId: "resource-1" }] },
      {
        kind: "assistant",
        content: [
          {
            type: "tool-call",
            result: { content: [{ type: "image", resourceId: "resource-2", mimeType: "image/jpeg" }] },
          },
        ],
      },
    ]);
    expect(resources.get("resource-1")?.data).toBe("base64-user-image");
    expect(resources.get("resource-2")?.data).toBe("base64-tool-image");
  });
});

function userMessage(text: string, timestamp: number) {
  return { role: "user", content: [{ type: "text", text }], timestamp };
}

function assistantMessage(
  stopReason: "stop" | "toolUse" | "length" | "aborted" | "error",
  timestamp: number,
  content: unknown[],
) {
  return {
    role: "assistant",
    content,
    api: "test",
    provider: "test",
    model: "faux",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp,
  };
}

function toolCall(id: string) {
  return { type: "toolCall", id, name: "read", arguments: { path: "a" } };
}

function toolResult(toolCallId: string, isError: boolean, timestamp: number) {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "read",
    content: [{ type: "text", text: "result" }],
    isError,
    timestamp,
  };
}

function messageEntry(id: string, parentId: string | null, message: unknown, persistedAt?: number) {
  const timestamp = persistedAt ?? Reflect.get(message as object, "timestamp");
  return { type: "message", id, parentId, timestamp: iso(typeof timestamp === "number" ? timestamp : 0), message };
}

function iso(timestamp: number): string {
  return new Date(timestamp).toISOString();
}
