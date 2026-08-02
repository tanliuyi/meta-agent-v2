import type { AgentSession, SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { PiThreadProjector, ProjectionError } from "../src/main/pi/pi-thread-projector.ts";
import type { PiThreadEventBatch } from "../src/shared/contracts.ts";

describe("PiThreadProjector", () => {
  it("按 SessionEntry identity/parent 投影 branch，并把 toolResult 折叠到 assistant", () => {
    const user = userMessage("问题", 1);
    const assistant = assistantMessage("toolUse", 2, [toolCall("call-1")]);
    const result = toolResult("call-1", false, 3);
    const entries: SessionEntry[] = [
      messageEntry("u", null, user),
      { type: "model_change", id: "model", parentId: "u", timestamp: iso(2), provider: "test", modelId: "faux" },
      messageEntry("a", "model", assistant),
      messageEntry("r", "a", result),
      {
        type: "compaction",
        id: "c",
        parentId: "r",
        timestamp: iso(4),
        summary: "摘要",
        firstKeptEntryId: "u",
        tokensBefore: 10,
      },
    ];
    const { session } = sessionHarness(entries);
    const projector = new PiThreadProjector({ projectId: "project", session, publish: () => {} });

    const snapshot = projector.snapshot();
    expect(snapshot.nodes.map((node) => [node.id, node.parentId, node.kind])).toEqual([
      ["u", null, "user"],
      ["a", "u", "assistant"],
      ["c", "a", "notice"],
    ]);
    const assistantNode = snapshot.nodes[1];
    expect(assistantNode?.kind).toBe("assistant");
    if (assistantNode?.kind !== "assistant") throw new Error("assistant node missing");
    expect(assistantNode.content[0]).toMatchObject({
      type: "tool-call",
      toolCallId: "call-1",
      execution: "complete",
      isError: false,
      result: { content: [{ type: "text", text: "result" }] },
    });
    expect(snapshot.headId).toBe("c");
    expect(assistantNode.usage).toEqual(assistant.usage);
    projector.dispose();
  });

  it("显式忽略 summarization retry 与 bash execution update 事件", () => {
    const { session } = sessionHarness([messageEntry("assistant", null, assistantMessage("stop", 1, []))]);
    const projector = new PiThreadProjector({ projectId: "project", session, publish: () => {} });
    const before = projector.snapshot();

    projector.handle({
      type: "summarization_retry_scheduled",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 100,
      errorMessage: "transient",
    });
    projector.handle({ type: "summarization_retry_attempt_start", source: "branchSummary" });
    projector.handle({ type: "summarization_retry_finished" });
    projector.handle({ type: "bash_execution_update", id: "bash-1", delta: "output" });

    expect(projector.snapshot()).toEqual(before);
    projector.dispose();
  });

  it("将扩展通知按顺序追加为带类型语义的 transient notice", () => {
    const { session } = sessionHarness([messageEntry("assistant", null, assistantMessage("stop", 1, []))]);
    const projector = new PiThreadProjector({ projectId: "project", session, publish: () => {} });

    projector.notify("普通消息", "info");
    projector.notify("需要注意", "warning", {
      customType: "subagents.warning",
      details: { runId: "run-1" },
    });
    projector.notify("执行失败", "error");

    expect(projector.snapshot().nodes).toEqual([
      expect.objectContaining({ id: "assistant", kind: "assistant" }),
      expect.objectContaining({
        parentId: "assistant",
        kind: "notice",
        noticeType: "notification",
        notificationType: "info",
        content: { type: "text", text: "普通消息" },
      }),
      expect.objectContaining({
        kind: "notice",
        noticeType: "notification",
        notificationType: "warning",
        extensionNotification: { customType: "subagents.warning", details: { runId: "run-1" } },
        content: { type: "text", text: "需要注意" },
      }),
      expect.objectContaining({
        kind: "notice",
        noticeType: "notification",
        notificationType: "error",
        content: { type: "text", text: "执行失败" },
      }),
    ]);
    expect(projector.snapshot().headId).toMatch(/:notification:3$/);
    projector.dispose();
  });

  it("active assistant 内按事件顺序插入通知，并在完成与 rekey 后保留最终文本位置", async () => {
    const entries: SessionEntry[] = [];
    const { session } = sessionHarness(entries);
    const projector = new PiThreadProjector({ projectId: "project", session, publish: () => {} });
    const started = assistantMessage("stop", 2, [{ type: "thinking", thinking: "分析", redacted: false }]);
    const finished = assistantMessage("stop", 2, [
      { type: "thinking", thinking: "分析", redacted: false },
      { type: "text", text: "最终回复" },
    ]);

    projector.handle({ type: "agent_start" });
    projector.handle({ type: "turn_start" });
    projector.handle({ type: "message_start", message: started });
    projector.notify("处理中", "info", {
      customType: "hermes-memory.session-index",
      details: { phase: "indexing", totalFiles: 12 },
    });
    projector.handle({ type: "message_end", message: finished });
    projector.handle({ type: "turn_end", message: finished, toolResults: [] });
    entries.push(messageEntry("canonical-assistant", null, finished));
    await Promise.resolve();

    expect(projector.snapshot().nodes).toHaveLength(1);
    expect(projector.snapshot().nodes[0]).toMatchObject({
      id: "canonical-assistant",
      kind: "assistant",
      content: [
        expect.objectContaining({ type: "reasoning", text: "分析" }),
        expect.objectContaining({
          type: "notification",
          notificationType: "info",
          text: "处理中",
          extensionNotification: {
            customType: "hermes-memory.session-index",
            details: { phase: "indexing", totalFiles: 12 },
          },
        }),
        expect.objectContaining({ type: "text", text: "最终回复" }),
      ],
      status: { type: "complete", reason: "stop" },
    });
    projector.dispose();
  });

  it("notification 跨 assistant rekey 时保留工具执行状态和相对顺序", async () => {
    const entries: SessionEntry[] = [];
    const { session } = sessionHarness(entries);
    const projector = new PiThreadProjector({ projectId: "project", session, publish: () => {} });
    const started = assistantMessage("toolUse", 2, [toolCall("call-1")]);
    const finished = assistantMessage("toolUse", 2, [toolCall("call-1"), { type: "text", text: "工具完成" }]);

    projector.handle({ type: "message_start", message: started });
    projector.handle({
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "read",
      result: { content: [{ type: "text", text: "result" }] },
      isError: false,
    });
    projector.notify("工具通知", "warning");
    projector.handle({ type: "message_end", message: finished });
    entries.push(messageEntry("canonical-assistant", null, finished));
    await Promise.resolve();

    expect(projector.snapshot().nodes).toHaveLength(1);
    expect(projector.snapshot().nodes[0]).toMatchObject({
      id: "canonical-assistant",
      kind: "assistant",
      content: [
        expect.objectContaining({
          type: "tool-call",
          toolCallId: "call-1",
          execution: "complete",
          result: { content: [{ type: "text", text: "result" }] },
          isError: false,
        }),
        expect.objectContaining({ type: "notification", notificationType: "warning", text: "工具通知" }),
        expect.objectContaining({ type: "text", text: "工具完成" }),
      ],
    });
    projector.dispose();
  });

  it("message_end 后通过公开 branch checkpoint 将 transient ID rekey 为 SessionEntry.id", async () => {
    const entries: SessionEntry[] = [];
    const batches: PiThreadEventBatch[] = [];
    const { session } = sessionHarness(entries);
    const projector = new PiThreadProjector({ projectId: "project", session, publish: (batch) => batches.push(batch) });
    const user = userMessage("hello", 1);

    projector.handle({ type: "agent_start" });
    projector.handle({ type: "message_start", message: user });
    const liveId = projector.snapshot().headId;
    projector.handle({ type: "message_end", message: user });
    entries.push(messageEntry("canonical-user", null, user));
    await Promise.resolve();

    expect(liveId).toMatch(/^live:/);
    expect(projector.snapshot().nodes).toEqual([
      expect.objectContaining({
        id: "canonical-user",
        sourceEntryId: "canonical-user",
        delivery: { state: "persisted" },
      }),
    ]);
    expect(
      batches
        .flatMap((batch) => batch.events)
        .some(({ event }) => event.type === "node-rekeyed" && event.previousId === liveId),
    ).toBe(true);
    projector.dispose();
  });

  it("将 prompt quote 作为 user node metadata 保留到 canonical rekey 后", async () => {
    const entries: SessionEntry[] = [];
    const { session } = sessionHarness(entries);
    const projector = new PiThreadProjector({ projectId: "project", session, publish: () => {} });
    const user = userMessage("> 第一行\n> 第二行\n\n解释这段话", 1);

    projector.beginPrompt("request", undefined, false, "解释这段话", {
      text: "第一行\n第二行",
      messageId: "assistant",
    });
    projector.markPromptPreflight("request", true);
    projector.handle({ type: "message_start", message: user });
    expect(projector.snapshot().nodes[0]).toMatchObject({
      kind: "user",
      content: [{ type: "text", text: "解释这段话" }],
      quote: { text: "第一行\n第二行", messageId: "assistant" },
    });

    projector.handle({ type: "message_end", message: user });
    entries.push(messageEntry("canonical-user", null, user));
    await Promise.resolve();

    expect(projector.snapshot().nodes[0]).toMatchObject({
      id: "canonical-user",
      content: [{ type: "text", text: "解释这段话" }],
      quote: { text: "第一行\n第二行", messageId: "assistant" },
    });
    projector.dispose();
  });

  it("将多条 prompt quote 作为 user node 数组 metadata 保留", () => {
    const entries: SessionEntry[] = [];
    const { session } = sessionHarness(entries);
    const projector = new PiThreadProjector({ projectId: "project", session, publish: () => {} });
    const quotes = [
      { text: "第一行", messageId: "assistant-1" },
      { text: "第二行", messageId: "assistant-2" },
    ];
    const user = userMessage("> 第一行\n\n> 第二行\n\n比较两段", 1);

    projector.beginPrompt("request", undefined, false, "比较两段", undefined, quotes);
    projector.markPromptPreflight("request", true);
    projector.handle({ type: "message_start", message: user });

    expect(projector.snapshot().nodes[0]).toMatchObject({ kind: "user", quotes });
    projector.dispose();
  });

  it("assistant rekey 时保留 live tool part identity", async () => {
    const entries: SessionEntry[] = [];
    const { session } = sessionHarness(entries);
    const projector = new PiThreadProjector({ projectId: "project", session, publish: () => {} });
    const started = assistantMessage("toolUse", 2, [toolCall("call-1")]);
    const finished = structuredClone(started);

    projector.handle({ type: "message_start", message: started });
    projector.handle({
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "read",
      args: { path: "a" },
    });
    const liveNode = projector.snapshot().nodes[0];
    expect(liveNode?.kind).toBe("assistant");
    if (liveNode?.kind !== "assistant") throw new Error("assistant node missing");
    const liveTool = liveNode.content[0];
    expect(liveTool?.type).toBe("tool-call");
    if (liveTool?.type !== "tool-call") throw new Error("tool part missing");
    const livePartId = liveTool.id;
    expect(livePartId).toMatch(/^live:/);

    projector.handle({ type: "message_end", message: finished });
    const persisted = structuredClone(finished);
    entries.push(messageEntry("canonical-assistant", null, persisted));
    await Promise.resolve();
    projector.handle({
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "read",
      result: { content: [{ type: "text", text: "result" }] },
      isError: false,
    });

    expect(projector.snapshot().nodes).toEqual([
      expect.objectContaining({
        id: "canonical-assistant",
        sourceEntryId: "canonical-assistant",
        content: [
          expect.objectContaining({
            id: livePartId,
            type: "tool-call",
            toolCallId: "call-1",
            execution: "complete",
          }),
        ],
      }),
    ]);
    projector.dispose();
  });

  it("重试后的 assistant 开始响应时恢复 running phase", () => {
    const { session } = sessionHarness([]);
    const projector = new PiThreadProjector({ projectId: "project", session, publish: () => {} });

    projector.handle({
      type: "auto_retry_start",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 1,
      errorMessage: "connection lost",
    });
    expect(projector.snapshot().phase).toBe("retrying");

    projector.handle({ type: "message_start", message: assistantMessage("stop", 2, []) });

    expect(projector.snapshot().phase).toBe("running");
    projector.dispose();
  });

  it("长历史上的连续 delta 复用历史节点并保持旧 snapshot 不变", () => {
    const entries: SessionEntry[] = Array.from({ length: 500 }, (_, index) =>
      messageEntry(`user-${index}`, index === 0 ? null : `user-${index - 1}`, userMessage(`question ${index}`, index)),
    );
    const { session } = sessionHarness(entries);
    const projector = new PiThreadProjector({ projectId: "project", session, publish: () => {} });
    const message = assistantMessage("stop", 1_000, []);
    const partial = assistantMessage("stop", 1_000, [{ type: "text", text: "" }]);

    projector.handle({ type: "message_start", message });
    projector.handle({
      type: "message_update",
      message,
      assistantMessageEvent: { type: "text_start", contentIndex: 0, partial },
    });
    const before = projector.snapshot();
    for (let index = 0; index < 1_000; index += 1) {
      projector.handle({
        type: "message_update",
        message,
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x", partial },
      });
    }
    const after = projector.snapshot();

    expect(after.nodes[0]).toBe(before.nodes[0]);
    expect(before.nodes.at(-1)).toMatchObject({ kind: "assistant", content: [{ type: "text", text: "" }] });
    expect(after.nodes.at(-1)).toMatchObject({
      kind: "assistant",
      content: [{ type: "text", text: "x".repeat(1_000) }],
    });
    projector.dispose();
  });

  it("长历史 rekey 单次更新 canonical id 与 transient 子节点", () => {
    const entries: SessionEntry[] = Array.from({ length: 500 }, (_, index) =>
      messageEntry(`user-${index}`, index === 0 ? null : `user-${index - 1}`, userMessage(`question ${index}`, index)),
    );
    const { session } = sessionHarness(entries);
    const projector = new PiThreadProjector({ projectId: "project", session, publish: () => {} });
    const assistant = assistantMessage("stop", 1_000, [{ type: "text", text: "answer" }]);
    const child = customMessage(1_001);
    projector.handle({ type: "message_start", message: assistant });
    projector.handle({ type: "message_start", message: child });
    const before = projector.snapshot();
    const transientId = before.nodes[500]!.id;

    entries.push(messageEntry("assistant-canonical", "user-499", assistant));
    projector.checkpoint();
    const after = projector.snapshot();

    expect(after.nodes).toHaveLength(502);
    expect(after.nodes[0]).toBe(before.nodes[0]);
    expect(after.nodes[500]).toMatchObject({ id: "assistant-canonical", sourceEntryId: "assistant-canonical" });
    expect(after.nodes[501]).toMatchObject({ parentId: "assistant-canonical", kind: "notice" });
    expect(before.nodes[500]).toMatchObject({ id: transientId });
    expect(before.nodes[501]).toMatchObject({ parentId: transientId });
    projector.dispose();
  });

  it("toolcall delta 直接使用 provider 的结构化参数，并在执行开始时校正", () => {
    const { session } = sessionHarness([]);
    const projector = new PiThreadProjector({ projectId: "project", session, publish: () => {} });
    const message = assistantMessage("toolUse", 2, []);
    const streamedCall = {
      type: "toolCall" as const,
      id: "call-1",
      name: "write",
      arguments: {} as Record<string, unknown>,
    };
    const partial = assistantMessage("toolUse", 2, [streamedCall]);

    projector.handle({ type: "message_start", message });
    projector.handle({
      type: "message_update",
      message,
      assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial },
    });
    streamedCall.arguments = { path: "src/main.ts", content: "const value" };
    projector.handle({
      type: "message_update",
      message,
      assistantMessageEvent: {
        type: "toolcall_delta",
        contentIndex: 0,
        delta: '{"path":"src/main.ts","content":"const value',
        partial,
      },
    });

    let node = projector.snapshot().nodes[0];
    expect(node?.kind).toBe("assistant");
    if (node?.kind !== "assistant") throw new Error("assistant node missing");
    expect(node.content[0]).toMatchObject({
      args: { path: "src/main.ts", content: "const value" },
      argsText: '{"path":"src/main.ts","content":"const value',
      execution: "streaming-args",
    });

    projector.handle({
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "write",
      args: { path: "src/main.ts", content: "const value = 1;" },
    });
    node = projector.snapshot().nodes[0];
    expect(node?.kind).toBe("assistant");
    if (node?.kind !== "assistant") throw new Error("assistant node missing");
    expect(node.content[0]).toMatchObject({
      args: { path: "src/main.ts", content: "const value = 1;" },
      argsText: '{"path":"src/main.ts","content":"const value = 1;"}',
      execution: "running",
    });
    projector.dispose();
  });

  it("tool partial 只进入 partialResult，turn_end 才按 toolUse 完成 assistant", () => {
    const { session } = sessionHarness([]);
    const projector = new PiThreadProjector({ projectId: "project", session, publish: () => {} });
    const assistant = assistantMessage("toolUse", 2, [toolCall("call-1")]);
    const result = toolResult("call-1", false, 3);

    projector.handle({ type: "agent_start" });
    projector.handle({ type: "turn_start" });
    projector.handle({ type: "message_start", message: assistant });
    projector.handle({ type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: { path: "a" } });
    projector.handle({
      type: "tool_execution_update",
      toolCallId: "call-1",
      toolName: "read",
      args: { path: "a" },
      partialResult: { progress: 1 },
    });
    projector.handle({ type: "message_end", message: assistant });
    let node = projector.snapshot().nodes[0];
    expect(node?.kind).toBe("assistant");
    if (node?.kind !== "assistant") throw new Error("assistant node missing");
    expect(node.status).toEqual({ type: "running" });
    expect(node.content[0]).toMatchObject({ partialResult: { progress: 1 } });
    expect(node.content[0]).not.toHaveProperty("result");

    projector.handle({
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "read",
      result: { content: [{ type: "text", text: "result" }] },
      isError: false,
    });
    projector.handle({ type: "message_start", message: result });
    projector.handle({ type: "message_end", message: result });
    projector.handle({ type: "turn_end", message: assistant, toolResults: [result] });
    node = projector.snapshot().nodes[0];
    expect(node?.kind).toBe("assistant");
    if (node?.kind !== "assistant") throw new Error("assistant node missing");
    expect(node.status).toEqual({ type: "complete", reason: "unknown" });
    expect(node.content[0]).toMatchObject({ execution: "complete", isError: false });
    projector.dispose();
  });

  it("duplicate queue text 保持 occurrence identity，消费前不进入 timeline", () => {
    const { session, steering } = sessionHarness([]);
    const projector = new PiThreadProjector({ projectId: "project", session, publish: () => {} });
    steering.push("same", "same");
    projector.handle({ type: "queue_update", steering: [...steering], followUp: [] });
    const ids = projector.snapshot().queue.map((item) => item.id);

    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(projector.snapshot().nodes).toHaveLength(0);
    steering.shift();
    projector.handle({ type: "queue_update", steering: [...steering], followUp: [] });
    projector.handle({ type: "message_start", message: userMessage("same", 3) });

    expect(projector.snapshot().queue).toHaveLength(1);
    expect(projector.snapshot().nodes[0]).toMatchObject({
      kind: "user",
      delivery: { state: "live", queueId: ids[0] },
    });
    projector.dispose();
  });

  it("queue_update 早于 preflight 时仍为多个 prompt 保留各自 request identity", () => {
    const { session } = sessionHarness([]);
    const projector = new PiThreadProjector({ projectId: "project", session, publish: () => {} });
    projector.beginPrompt("request-1", "steer", true);
    projector.handle({ type: "queue_update", steering: ["first"], followUp: [] });
    projector.markPromptPreflight("request-1", true);
    projector.beginPrompt("request-2", "steer", true);
    projector.handle({ type: "queue_update", steering: ["first", "second"], followUp: [] });
    projector.markPromptPreflight("request-2", true);

    expect(projector.snapshot().queue).toEqual([
      expect.objectContaining({ id: "queue:request-1", requestId: "request-1", prompt: "first" }),
      expect.objectContaining({ id: "queue:request-2", requestId: "request-2", prompt: "second" }),
    ]);
    projector.dispose();
  });

  it("queue_update 后 preflight 失败会撤销 Desktop request identity", () => {
    const { session } = sessionHarness([]);
    const projector = new PiThreadProjector({ projectId: "project", session, publish: () => {} });
    projector.beginPrompt("request", "followUp", true);
    projector.handle({ type: "queue_update", steering: [], followUp: ["queued"] });

    expect(projector.hasQueuedRequest("request")).toBe(true);
    expect(projector.snapshot().queue[0]).toMatchObject({ source: "desktop", requestId: "request" });

    projector.markPromptPreflight("request", false);

    expect(projector.hasQueuedRequest("request")).toBe(false);
    expect(projector.snapshot().queue[0]).toMatchObject({ source: "pi-observed", prompt: "queued" });
    expect(projector.snapshot().queue[0]).not.toHaveProperty("requestId");
    projector.dispose();
  });

  it("idle prompt 不会抢占后续 streaming queue 的 request identity", () => {
    const { session } = sessionHarness([]);
    const projector = new PiThreadProjector({ projectId: "project", session, publish: () => {} });
    projector.beginPrompt("idle-request", "followUp", false);
    projector.markPromptPreflight("idle-request", true);
    projector.beginPrompt("queued-request", "followUp", true);
    projector.handle({ type: "queue_update", steering: [], followUp: ["queued"] });
    projector.markPromptPreflight("queued-request", true);

    expect(projector.snapshot().queue).toEqual([
      expect.objectContaining({ id: "queue:queued-request", requestId: "queued-request", prompt: "queued" }),
    ]);
    projector.dispose();
  });

  it("显式 clear 不会把被移除 item 关联到下一条 user message", () => {
    const { session } = sessionHarness([]);
    const projector = new PiThreadProjector({ projectId: "project", session, publish: () => {} });
    projector.handle({ type: "queue_update", steering: ["queued"], followUp: [] });
    projector.beginQueueClear();
    projector.handle({ type: "queue_update", steering: [], followUp: [] });
    projector.endQueueClear();

    projector.handle({ type: "message_start", message: userMessage("new prompt", 4) });

    expect(projector.snapshot().nodes[0]).toMatchObject({ kind: "user", delivery: { state: "live" } });
    expect(projector.snapshot().nodes[0]).not.toMatchObject({ delivery: { queueId: expect.any(String) } });
    projector.dispose();
  });

  it("fatal resync 丢弃未发布 patch，独占发布 branch snapshot 并保留 live overlay", () => {
    const batches: PiThreadEventBatch[] = [];
    const { session } = sessionHarness([]);
    const projector = new PiThreadProjector({ projectId: "project", session, publish: (batch) => batches.push(batch) });
    projector.handle({ type: "message_start", message: userMessage("live", 5) });

    projector.resync();

    expect(batches).toHaveLength(1);
    expect(batches[0]?.events).toHaveLength(1);
    expect(batches[0]?.events[0]?.event).toMatchObject({
      type: "branch-replaced",
      snapshot: { nodes: [expect.objectContaining({ kind: "user", content: [{ type: "text", text: "live" }] })] },
    });
    projector.dispose();
  });

  it("重建 branch 时将隐藏的 slash 最终结果合并到可见初始卡片", () => {
    const entries: SessionEntry[] = [
      slashResultEntry("slash-initial", null, "request-1", "running", true, 1),
      slashResultEntry("slash-final", "slash-initial", "request-1", "completed", false, 2),
    ];
    const { session } = sessionHarness(entries);
    const projector = new PiThreadProjector({ projectId: "project", session, publish: () => {} });

    expect(projector.snapshot().nodes).toEqual([
      expect.objectContaining({
        id: "slash-initial",
        sourceEntryId: "slash-initial",
        content: expect.objectContaining({
          type: "custom",
          content: [{ type: "text", text: "completed" }],
          details: expect.objectContaining({ requestId: "request-1", status: "completed" }),
        }),
      }),
    ]);
    expect(projector.snapshot().headId).toBe("slash-initial");
    projector.dispose();
  });

  it("增量同步时用隐藏的 slash 最终结果替换初始卡片且不新增节点", () => {
    const entries: SessionEntry[] = [slashResultEntry("slash-initial", null, "request-1", "running", true, 1)];
    const batches: PiThreadEventBatch[] = [];
    const { session } = sessionHarness(entries);
    const projector = new PiThreadProjector({ projectId: "project", session, publish: (batch) => batches.push(batch) });

    entries.push(slashResultEntry("slash-final", "slash-initial", "request-1", "failed", false, 2));
    projector.checkpoint();
    projector.flush();

    expect(projector.snapshot().nodes).toHaveLength(1);
    expect(projector.snapshot().nodes[0]).toMatchObject({
      id: "slash-initial",
      content: {
        type: "custom",
        content: [{ type: "text", text: "failed" }],
        details: { requestId: "request-1", status: "failed", result: { details: { rows: [] } } },
      },
    });
    expect(batches.flatMap((batch) => batch.events).map(({ event }) => event.type)).toContain("node-replaced");
    expect(batches.flatMap((batch) => batch.events).map(({ event }) => event.type)).not.toContain("node-added");
    projector.dispose();
  });

  it("non-trigger custom event 绑定唯一 canonical entry，不创建 transient duplicate", () => {
    const custom = customMessage(6);
    const entries: SessionEntry[] = [customEntry("custom", null, custom, 6)];
    const { session } = sessionHarness(entries);
    const projector = new PiThreadProjector({ projectId: "project", session, publish: () => {} });

    projector.handle({ type: "message_start", message: custom });
    projector.handle({ type: "message_end", message: custom });

    expect(projector.snapshot().nodes).toEqual([
      expect.objectContaining({ id: "custom", sourceEntryId: "custom", kind: "notice" }),
    ]);
    projector.dispose();
  });

  it("多个相同 canonical custom 候选 fail fast，不按时间或末项猜 identity", () => {
    const custom = customMessage(7);
    const entries: SessionEntry[] = [
      customEntry("custom-1", null, custom, 7),
      customEntry("custom-2", "custom-1", custom, 8),
    ];
    const { session } = sessionHarness(entries);
    const projector = new PiThreadProjector({ projectId: "project", session, publish: () => {} });

    expect(() => projector.handle({ type: "message_start", message: custom })).toThrow(ProjectionError);
    projector.dispose();
  });

  it.each([
    ["stop", { type: "complete", reason: "stop" }],
    ["toolUse", { type: "complete", reason: "unknown" }],
    ["length", { type: "incomplete", reason: "length" }],
    ["aborted", { type: "incomplete", reason: "cancelled" }],
    ["error", { type: "incomplete", reason: "error", error: "provider failed" }],
  ] as const)("persisted assistant stopReason=%s 精确映射 status", (stopReason, status) => {
    const message = {
      ...assistantMessage(stopReason, 9, [{ type: "text", text: "answer" }]),
      ...(stopReason === "error" ? { errorMessage: "provider failed" } : {}),
    };
    const { session } = sessionHarness([messageEntry("assistant", null, message)]);
    const projector = new PiThreadProjector({ projectId: "project", session, publish: () => {} });

    expect(projector.snapshot().nodes[0]).toMatchObject({ kind: "assistant", status });
    projector.dispose();
  });

  it("persisted assistant 同时保留 run 开始与完成时间", () => {
    const message = assistantMessage("stop", 1_000, [{ type: "text", text: "answer" }]);
    const { session } = sessionHarness([messageEntry("assistant", null, message, 13_000)]);
    const projector = new PiThreadProjector({ projectId: "project", session, publish: () => {} });

    expect(projector.snapshot().nodes[0]).toMatchObject({
      kind: "assistant",
      createdAt: 1_000,
      completedAt: 13_000,
    });
    projector.dispose();
  });

  it("redacted reasoning 不进入 timeline", () => {
    const message = assistantMessage("stop", 10, [
      { type: "thinking", thinking: "encrypted", redacted: true },
      { type: "text", text: "visible" },
    ]);
    const { session } = sessionHarness([messageEntry("assistant", null, message)]);
    const projector = new PiThreadProjector({ projectId: "project", session, publish: () => {} });

    const node = projector.snapshot().nodes[0];
    expect(node?.kind).toBe("assistant");
    if (node?.kind !== "assistant") throw new Error("assistant node missing");
    expect(node.content).toEqual([{ id: "assistant:text:1", type: "text", text: "visible" }]);
    projector.dispose();
  });
});

function sessionHarness(entries: SessionEntry[]) {
  const steering: string[] = [];
  const followUp: string[] = [];
  const byId = () => new Map(entries.map((entry) => [entry.id, entry]));
  const session = {
    sessionId: "thread",
    isStreaming: false,
    getSteeringMessages: () => steering,
    getFollowUpMessages: () => followUp,
    sessionManager: {
      getLeafId: () => entries.at(-1)?.id ?? null,
      getBranch: () => [...entries],
      getEntry: (id: string) => byId().get(id),
      getLabel: () => undefined,
    },
  } as unknown as AgentSession;
  return { session, steering, followUp };
}

function userMessage(text: string, timestamp: number) {
  return { role: "user" as const, content: [{ type: "text" as const, text }], timestamp };
}

function assistantMessage(
  stopReason: "stop" | "toolUse" | "length" | "aborted" | "error",
  timestamp: number,
  content: unknown[],
) {
  return {
    role: "assistant" as const,
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
  } as Extract<AgentSession["messages"][number], { role: "assistant" }>;
}

function toolCall(id: string) {
  return { type: "toolCall" as const, id, name: "read", arguments: { path: "a" } };
}

function toolResult(toolCallId: string, isError: boolean, timestamp: number) {
  return {
    role: "toolResult" as const,
    toolCallId,
    toolName: "read",
    content: [{ type: "text" as const, text: "result" }],
    isError,
    timestamp,
  };
}

function customMessage(timestamp: number) {
  return {
    role: "custom" as const,
    customType: "extension-context",
    content: [{ type: "text" as const, text: "context" }],
    display: true,
    details: { source: "test" },
    timestamp,
  };
}

function slashResultEntry(
  id: string,
  parentId: string | null,
  requestId: string,
  status: string,
  display: boolean,
  timestamp: number,
): SessionEntry {
  return {
    type: "custom_message",
    id,
    parentId,
    timestamp: iso(timestamp),
    customType: "subagent-slash-result",
    content: [{ type: "text", text: status }],
    display,
    details: { requestId, status, result: { details: { rows: [] } } },
  };
}

function customEntry(
  id: string,
  parentId: string | null,
  message: ReturnType<typeof customMessage>,
  timestamp: number,
): SessionEntry {
  return {
    type: "custom_message",
    id,
    parentId,
    timestamp: iso(timestamp),
    customType: message.customType,
    content: message.content,
    display: message.display,
    details: message.details,
  };
}

function messageEntry(
  id: string,
  parentId: string | null,
  message: AgentSession["messages"][number],
  persistedAt = message.timestamp,
): SessionEntry {
  return { type: "message", id, parentId, timestamp: iso(persistedAt), message };
}

function iso(timestamp: number): string {
  return new Date(timestamp).toISOString();
}
