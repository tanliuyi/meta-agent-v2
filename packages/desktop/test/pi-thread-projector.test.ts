import { describe, expect, it } from "vitest";
import { projectPersistedBranch } from "../src/main/pi/pi-thread-projector.ts";
import { QUOTE_ATTACHMENT_CUSTOM_TYPE, withQuoteContext } from "../src/main/pi/quote-context.ts";

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

describe("PiThreadProjector timeline image resources", () => {
  const TOOL_IMAGE_DATA = "base64-tool-image-body";
  const SCREENSHOT_DATA = "base64-screenshot-body";
  const SNAPSHOT_SHOT_DATA = "base64-snapshot-shot-body";

  it("将历史用户消息图片替换为资源引用，且可原样读回", () => {
    const user = {
      role: "user",
      content: [
        { type: "text", text: "查看图片" },
        { type: "image", data: "base64-user-image-body", mimeType: "image/png" },
      ],
      timestamp: 1,
    } as AgentSession["messages"][number];
    const { session } = sessionHarness([messageEntry("u", null, user)]);
    const projector = new PiThreadProjector({ projectId: "project", session, publish: () => {} });

    const node = projector.snapshot().nodes[0];
    if (node?.kind !== "user") throw new Error("user node missing");
    expect(node.content[0]).toEqual({ type: "text", text: "查看图片" });
    const image = node.content[1];
    if (image?.type !== "image") throw new Error("user image missing");
    expect(image).toMatchObject({ type: "image", mimeType: "image/png" });
    expect(JSON.stringify(projector.snapshot())).not.toContain("base64-user-image-body");
    expect(projector.readImageResource(image.resourceId)?.data).toBe("base64-user-image-body");
    projector.dispose();
  });

  it("将历史 toolResult 图像主体替换为资源引用，且可原样读回", () => {
    const content = [
      { type: "image" as const, data: TOOL_IMAGE_DATA, mimeType: "image/png" },
      { type: "text" as const, text: "ok" },
    ];
    const details = {
      screenshot: `data:image/png;base64,${SCREENSHOT_DATA}`,
      snapshot: {
        url: "https://example.com",
        tree: [] as unknown[],
        screenshot: `data:image/png;base64,${SNAPSHOT_SHOT_DATA}`,
      },
      other: "data:text/plain;base64,keep-me-as-text",
      plain: "hello",
    };
    const entries: SessionEntry[] = [
      messageEntry("u", null, userMessage("图片测试", 1)),
      messageEntry("a", "u", assistantMessage("toolUse", 2, [toolCall("call-1")])),
      messageEntry("r", "a", {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        content,
        details,
        isError: false,
        timestamp: 3,
      } as AgentSession["messages"][number]),
    ];
    const { session } = sessionHarness(entries);
    const projector = new PiThreadProjector({ projectId: "project", session, publish: () => {} });
    const snapshot = projector.snapshot();
    const assistantNode = snapshot.nodes[1];
    expect(assistantNode?.kind).toBe("assistant");
    if (assistantNode?.kind !== "assistant") throw new Error("assistant node missing");
    const part = assistantNode.content[0];
    expect(part.type).toBe("tool-call");
    if (part.type !== "tool-call") throw new Error("tool part missing");

    const projectedContent = (part.result as Record<string, unknown>).content as unknown[];
    expect(projectedContent).toEqual([
      { type: "image", resourceId: expect.any(String), mimeType: "image/png" },
      { type: "text", text: "ok" },
    ]);
    expect(JSON.stringify(snapshot)).not.toContain(TOOL_IMAGE_DATA);
    expect(JSON.stringify(snapshot)).not.toContain(SCREENSHOT_DATA);
    expect(JSON.stringify(snapshot)).not.toContain(SNAPSHOT_SHOT_DATA);

    const imageRef = projectedContent[0] as { resourceId: string; mimeType: string };
    expect(projector.readImageResource(imageRef.resourceId)).toEqual({
      resourceId: imageRef.resourceId,
      mimeType: "image/png",
      data: TOOL_IMAGE_DATA,
    });

    const detailsOut = (part.result as Record<string, unknown>).details as Record<string, unknown>;
    const screenshot = detailsOut.screenshot as { resourceId: string; mimeType: string };
    expect(screenshot).toMatchObject({ mimeType: "image/png" });
    expect(projector.readImageResource(screenshot.resourceId)?.data).toBe(SCREENSHOT_DATA);
    const snapshotOut = detailsOut.snapshot as { screenshot: { resourceId: string; mimeType: string } };
    expect(projector.readImageResource(snapshotOut.screenshot.resourceId)?.data).toBe(SNAPSHOT_SHOT_DATA);
    expect(detailsOut.other).toBe("data:text/plain;base64,keep-me-as-text");
    expect(detailsOut.plain).toBe("hello");
    expect(projector.readImageResource("unknown-resource")).toBeUndefined();

    projector.beginTreeNavigation();
    projector.endTreeNavigation();
    const rebuiltAssistant = projector.snapshot().nodes[1];
    if (rebuiltAssistant?.kind !== "assistant") throw new Error("rebuilt assistant node missing");
    const rebuiltTool = rebuiltAssistant.content[0];
    if (rebuiltTool?.type !== "tool-call") throw new Error("rebuilt tool part missing");
    const rebuiltContent = (rebuiltTool.result as Record<string, unknown>).content as unknown[];
    expect(rebuiltContent[0]).toEqual(imageRef);
    const rebuiltDetails = (rebuiltTool.result as Record<string, unknown>).details as Record<string, unknown>;
    expect(rebuiltDetails.screenshot).toEqual(screenshot);
    expect(projector.readImageResource(imageRef.resourceId)?.data).toBe(TOOL_IMAGE_DATA);
    projector.dispose();
  });

  it("超大单图仍投影为可按需读取的资源引用", () => {
    const oversized = "x".repeat(8 * 1024 * 1024 + 1);
    const entries: SessionEntry[] = [
      messageEntry("u", null, userMessage("超大图片", 1)),
      messageEntry("a", "u", assistantMessage("toolUse", 2, [toolCall("call-large")])),
      messageEntry("r", "a", {
        role: "toolResult",
        toolCallId: "call-large",
        toolName: "read",
        content: [{ type: "image", data: oversized, mimeType: "image/png" }],
        isError: false,
        timestamp: 3,
      } as AgentSession["messages"][number]),
    ];
    const { session } = sessionHarness(entries);
    const projector = new PiThreadProjector({ projectId: "project", session, publish: () => {} });
    const node = projector.snapshot().nodes[1];
    if (node?.kind !== "assistant") throw new Error("assistant node missing");
    const part = node.content[0];
    if (part?.type !== "tool-call") throw new Error("tool part missing");
    const projectedContent = (part.result as Record<string, unknown>).content as unknown[];
    const projectedImage = projectedContent[0] as { type: string; resourceId: string; mimeType: string };
    expect(projectedImage).toMatchObject({ type: "image", mimeType: "image/png" });
    expect(projectedImage.resourceId).not.toBe("");
    expect(JSON.stringify(projector.snapshot())).not.toContain(oversized);
    expect(projector.readImageResource(projectedImage.resourceId)?.data).toBe(oversized);
    projector.dispose();
  });

  it("live tool_execution_end 结果同样图像资源化", () => {
    const { session } = sessionHarness([]);
    const projector = new PiThreadProjector({ projectId: "project", session, publish: () => {} });
    const assistant = assistantMessage("toolUse", 2, [toolCall("call-live")]);
    projector.handle({ type: "message_start", message: assistant });
    projector.handle({
      type: "tool_execution_end",
      toolCallId: "call-live",
      toolName: "read",
      result: {
        content: [{ type: "image", data: "base64-live-body", mimeType: "image/png" }],
        details: { screenshot: "data:image/png;base64,base64-live-shot" },
      },
      isError: false,
    });

    const compact = JSON.stringify(projector.snapshot());
    expect(compact).not.toContain("base64-live-body");
    expect(compact).not.toContain("base64-live-shot");
    const node = projector.snapshot().nodes[0];
    expect(node?.kind).toBe("assistant");
    if (node?.kind !== "assistant") throw new Error("assistant node missing");
    const part = node.content[0];
    expect(part.type).toBe("tool-call");
    if (part.type !== "tool-call") throw new Error("tool part missing");
    const content = (part.result as Record<string, unknown>).content as unknown[];
    const ref = content[0] as { resourceId: string; mimeType: string };
    expect(projector.readImageResource(ref.resourceId)?.data).toBe("base64-live-body");
    const details = (part.result as Record<string, unknown>).details as Record<string, unknown>;
    const screenshot = details.screenshot as { resourceId: string };
    expect(projector.readImageResource(screenshot.resourceId)?.data).toBe("base64-live-shot");
    projector.dispose();
  });
});
