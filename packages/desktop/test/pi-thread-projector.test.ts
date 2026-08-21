import { describe, expect, it } from "vitest";
import { ProjectionError, projectPersistedBranch } from "../src/main/pi/pi-thread-projector.ts";

describe("projectPersistedBranch", () => {
  it("projects an RPC branch and folds tool results into the owning assistant", () => {
    const entries = [
      messageEntry("u", null, userMessage("问题", 1)),
      messageEntry("a", "u", assistantMessage("toolUse", 2, [toolCall("call-1")])),
      messageEntry("r", "a", toolResult("call-1", false, 3)),
    ];

    const projection = projectPersistedBranch(entries, "r");

    expect(projection.headId).toBe("a");
    expect(projection.nodes).toMatchObject([
      { id: "u", kind: "user" },
      {
        id: "a",
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

  it("rejects malformed entries and unknown entry types", () => {
    expect(() => projectPersistedBranch([{ type: "message" }], null)).toThrow(ProjectionError);
    expect(() =>
      projectPersistedBranch([{ type: "future", id: "future", parentId: null, timestamp: iso(1) }], "future"),
    ).toThrow("Unsupported RPC session entry: future");
  });

  it("keeps provider run time, completion time, status and thinking provenance", () => {
    const entries = [
      { type: "thinking_level_change", id: "level", parentId: null, timestamp: iso(1), thinkingLevel: "high" },
      messageEntry("assistant", "level", assistantMessage("stop", 1_000, [{ type: "text", text: "answer" }]), 13_000),
    ];

    const projection = projectPersistedBranch(entries, "assistant");

    expect(projection.thinkingLevel).toBe("high");
    expect(projection.nodes[0]).toMatchObject({
      kind: "assistant",
      createdAt: 1_000,
      completedAt: 13_000,
      status: { type: "complete", reason: "stop" },
      provenance: { provider: "test", model: "faux", thinkingLevel: "high" },
    });
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
      content: [{ id: "assistant:text:1", type: "text", text: "visible" }],
    });
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
        details: { source: "system-pi" },
        display: true,
      },
    ];

    const projection = projectPersistedBranch(entries, "visible");

    expect(projection.nodes).toMatchObject([
      {
        id: "visible",
        parentId: null,
        kind: "notice",
        content: { type: "custom", customType: "user-extension.notice", details: { source: "system-pi" } },
      },
    ]);
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
