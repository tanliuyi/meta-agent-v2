import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { PiMessageRepositoryConverter } from "../src/renderer/src/runtime/pi-message-repository.ts";
import {
  detachedSnapshot as detachedThreadSnapshot,
  PiThreadStore,
  PiThreadStoreError,
} from "../src/renderer/src/runtime/pi-thread-store.ts";
import {
  type PiAssistantMessage,
  type PiNoticeMessage,
  type PiRpcEvent,
  type PiThreadSnapshot,
  type PiUserMessage,
  PROTOCOL_VERSION,
} from "../src/shared/contracts.ts";

describe("PiThreadStore", () => {
  it("逐个归约 Pi message 原子事件并立即发布流式文本", () => {
    const store = new PiThreadStore(snapshot([], null));
    const listener = vi.fn();
    store.subscribe(listener);
    const started = assistantMessage([], "pending");

    applyRpc(store, 1, { type: "message_start", message: started });
    applyRpc(store, 2, {
      type: "message_update",
      usage: started.usage,
      assistantMessageEvent: { type: "text_start", contentIndex: 0 },
    });
    applyRpc(store, 3, {
      type: "message_update",
      usage: started.usage,
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "你" },
    });

    expect(listener).toHaveBeenCalledTimes(3);
    expect(store.getSnapshot()).toMatchObject({
      cursor: 3,
      headId: "pi-message:assistant:2",
      nodes: [{ kind: "assistant", status: { type: "running" }, content: [{ type: "text", text: "你" }] }],
    });

    applyRpc(store, 4, {
      type: "message_update",
      usage: started.usage,
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "好" },
    });
    expect(listener).toHaveBeenCalledTimes(4);
    expect(store.getSnapshot().nodes[0]).toMatchObject({ content: [{ text: "你好" }] });
  });

  it("将 turn_start 时的 thinking level 固化到流式 assistant provenance", () => {
    const store = new PiThreadStore({ ...snapshot([], null), thinkingLevel: "medium" });
    const started = assistantMessage([], "pending");
    const completed = assistantMessage([{ type: "text", text: "完成" }], "stop");

    applyRpc(store, 1, { type: "turn_start" });
    applyRpc(store, 2, { type: "thinking_level_changed", level: "high" });
    applyRpc(store, 3, { type: "message_start", message: started });
    expect(store.getSnapshot().nodes[0]).toMatchObject({
      kind: "assistant",
      status: { type: "running" },
      provenance: { thinkingLevel: "medium" },
    });

    applyRpc(store, 4, { type: "message_end", message: completed });
    expect(store.getSnapshot().nodes[0]).toMatchObject({
      kind: "assistant",
      status: { type: "complete" },
      provenance: { thinkingLevel: "medium" },
    });

    expect(store.getSnapshot().thinkingLevel).toBe("high");
  });

  it("归约 Pi message_update 的 start、done 与 error wire 事件", () => {
    const store = new PiThreadStore(snapshot([], null));
    const started = assistantMessage([], "pending");
    const completed = assistantMessage([{ type: "text", text: "完成" }], "stop");

    applyRpc(store, 1, { type: "message_start", message: started });
    applyRpc(store, 2, {
      type: "message_update",
      usage: { ...started.usage, output: 2, totalTokens: 3 },
      assistantMessageEvent: { type: "start" },
    });
    expect(store.getSnapshot().nodes[0]).toMatchObject({ usage: { output: 2, totalTokens: 3 }, content: [] });

    applyRpc(store, 3, {
      type: "message_update",
      usage: completed.usage,
      assistantMessageEvent: { type: "done", reason: "stop", message: completed },
    });
    expect(store.getSnapshot().nodes[0]).toMatchObject({ content: [{ type: "text", text: "完成" }] });

    const errored = { ...completed, stopReason: "error" as const, errorMessage: "provider failed" };
    applyRpc(store, 4, {
      type: "message_update",
      usage: errored.usage,
      assistantMessageEvent: { type: "error", reason: "error", error: errored },
    });
    expect(store.getSnapshot().nodes[0]).toMatchObject({ content: [{ type: "text", text: "完成" }] });
  });

  it("将 RPC extension_error 投影为结构化错误通知", () => {
    const store = new PiThreadStore(snapshot([], null));
    applyRpc(store, 1, {
      type: "extension_error",
      extensionPath: "/extensions/broken.ts",
      event: "tool_call",
      error: "extension failed",
    });

    expect(store.getSnapshot().nodes).toEqual([
      expect.objectContaining({
        kind: "notice",
        noticeType: "notification",
        notificationType: "error",
        extensionNotification: {
          customType: "pi.extension_error",
          details: {
            extensionPath: "/extensions/broken.ts",
            event: "tool_call",
            error: "extension failed",
          },
        },
        content: { type: "text", text: "extension failed" },
      }),
    ]);
  });

  it("按 Pi thinking、toolcall 与 tool execution 事件更新同一消息", () => {
    const store = new PiThreadStore(snapshot([], null));
    const started = assistantMessage([], "pending");

    applyRpc(store, 1, { type: "message_start", message: started });
    applyRpc(store, 2, {
      type: "message_update",
      usage: started.usage,
      assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
    });
    applyRpc(store, 3, {
      type: "message_update",
      usage: started.usage,
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "分析" },
    });
    applyRpc(store, 4, {
      type: "message_update",
      usage: started.usage,
      assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "分析" },
    });
    applyRpc(store, 5, {
      type: "message_update",
      usage: started.usage,
      assistantMessageEvent: { type: "toolcall_start", contentIndex: 1 },
    });
    expect(store.getSnapshot().nodes[0]).toMatchObject({
      content: [
        { type: "reasoning", text: "分析" },
        {
          type: "tool-call",
          toolCallId: "pending:pi-message:assistant:2:1",
          toolName: "",
          args: {},
          argsText: "",
        },
      ],
    });

    applyRpc(store, 6, {
      type: "message_update",
      usage: started.usage,
      assistantMessageEvent: {
        type: "toolcall_delta",
        contentIndex: 1,
        delta: '{"path":"READ',
      },
    });
    expect(store.getSnapshot().nodes[0]).toMatchObject({
      content: [
        { type: "reasoning", text: "分析" },
        { type: "tool-call", args: { path: "READ" }, argsText: '{"path":"READ' },
      ],
    });
    const streamingRepository = new PiMessageRepositoryConverter().build(store.getSnapshot());
    const streamingMessage = streamingRepository.messages[0]?.message;
    if (streamingMessage?.role !== "assistant") throw new Error("streaming assistant message missing");
    expect(streamingMessage.content[1]).toMatchObject({
      type: "tool-call",
      toolName: "",
      args: { path: "READ" },
      argsText: '{"path":"READ',
      artifact: { execution: "streaming-args" },
    });

    applyRpc(store, 7, {
      type: "message_update",
      usage: started.usage,
      assistantMessageEvent: {
        type: "toolcall_delta",
        contentIndex: 1,
        delta: 'ME.md"}',
      },
    });
    expect(store.getSnapshot().nodes[0]).toMatchObject({
      content: [
        { type: "reasoning", text: "分析" },
        { type: "tool-call", args: { path: "README.md" }, argsText: '{"path":"README.md"}' },
      ],
    });

    applyRpc(store, 8, {
      type: "message_update",
      usage: started.usage,
      assistantMessageEvent: {
        type: "toolcall_end",
        contentIndex: 1,
        toolCall: { type: "toolCall", id: "tool-1", name: "read", arguments: { path: "README.md" } },
      },
    });
    applyRpc(store, 9, {
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "read",
      args: { path: "README.md" },
    });
    applyRpc(store, 10, {
      type: "tool_execution_update",
      toolCallId: "tool-1",
      toolName: "read",
      args: { path: "README.md" },
      partialResult: { content: [{ type: "text", text: "partial" }] },
    });
    applyRpc(store, 11, {
      type: "tool_execution_end",
      toolCallId: "tool-1",
      toolName: "read",
      result: { content: [{ type: "text", text: "done" }] },
      isError: false,
    });

    expect(store.getSnapshot().nodes[0]).toMatchObject({
      content: [
        { type: "reasoning", text: "分析" },
        {
          type: "tool-call",
          toolCallId: "tool-1",
          args: { path: "README.md" },
          argsText: '{"path":"README.md"}',
          execution: "complete",
          partialResult: { content: [{ text: "partial" }] },
          result: { content: [{ text: "done" }] },
        },
      ],
    });
  });

  it("message_end 结束 live user 与 assistant，不依赖 get_entries 快照", () => {
    const store = new PiThreadStore(snapshot([], null));
    const user = { role: "user" as const, content: "问题", timestamp: 1 };
    const assistant = assistantMessage([{ type: "text", text: "回答" }], "stop");

    applyRpc(store, 1, { type: "message_start", message: user });
    applyRpc(store, 2, { type: "message_end", message: user });
    applyRpc(store, 3, { type: "message_start", message: assistantMessage([], "pending") });
    applyRpc(store, 4, { type: "message_end", message: assistant });

    expect(store.getSnapshot().nodes).toMatchObject([
      { kind: "user", delivery: { state: "persisted" }, content: [{ text: "问题" }] },
      { kind: "assistant", status: { type: "complete", reason: "stop" }, content: [{ text: "回答" }] },
    ]);
  });

  it("将 Pi 0.84 deferred stop reason 映射为完成状态", () => {
    const store = new PiThreadStore(snapshot([], null));
    const started = assistantMessage([], "pending");
    const deferred = assistantMessage([{ type: "text", text: "稍后继续" }], "deferred");

    applyRpc(store, 1, { type: "message_start", message: started });
    applyRpc(store, 2, { type: "message_end", message: deferred });

    expect(store.getSnapshot().nodes[0]).toMatchObject({
      kind: "assistant",
      status: { type: "complete", reason: "unknown" },
      content: [{ type: "text", text: "稍后继续" }],
    });
  });

  it("逐个追加 Pi bash_execution_update 输出", () => {
    const store = new PiThreadStore(snapshot([], null));

    applyRpc(store, 1, { type: "bash_execution_update", id: "bash-1", delta: "第一段" });
    applyRpc(store, 2, { type: "bash_execution_update", id: "bash-1", delta: "\n第二段" });

    expect(store.getSnapshot()).toMatchObject({
      cursor: 2,
      nodes: [
        {
          id: "rpc-bash:bash-1",
          kind: "notice",
          noticeType: "bash",
          content: { type: "command", command: "", output: "第一段\n第二段" },
        },
      ],
    });
  });

  it("直接按 Pi lifecycle 与 queue_update 维护控制投影", () => {
    const store = new PiThreadStore(snapshot([], null));
    applyRpc(store, 1, { type: "agent_start" });
    applyRpc(store, 2, { type: "turn_start" });
    applyRpc(store, 3, { type: "queue_update", steering: ["修正"], followUp: ["继续"] });
    expect(store.getSnapshot()).toMatchObject({
      phase: "running",
      activeTurnId: "rpc-turn:2",
      queue: [
        { mode: "steer", prompt: "修正", source: "pi-observed" },
        { mode: "followUp", prompt: "继续", source: "pi-observed" },
      ],
    });

    applyRpc(store, 4, { type: "turn_end", message: assistantMessage([], "stop"), toolResults: [] });
    applyRpc(store, 5, { type: "agent_settled" });
    expect(store.getSnapshot()).toMatchObject({ phase: "idle", activeTurnId: undefined });
  });

  it("投影 Pi compaction 与 branch-summary summarization retry 生命周期", () => {
    const store = new PiThreadStore(snapshot([], null));

    applyRpc(store, 1, {
      type: "summarization_retry_scheduled",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 2_000,
      errorMessage: "overloaded",
    });
    expect(store.getSnapshot().phase).toBe("retrying");

    applyRpc(store, 2, {
      type: "summarization_retry_attempt_start",
      source: "compaction",
      reason: "threshold",
    });
    expect(store.getSnapshot().phase).toBe("compacting");

    applyRpc(store, 3, { type: "summarization_retry_finished" });
    expect(store.getSnapshot().phase).toBe("idle");

    applyRpc(store, 4, {
      type: "summarization_retry_attempt_start",
      source: "branchSummary",
    });
    expect(store.getSnapshot().phase).toBe("tree-navigation");

    applyRpc(store, 5, { type: "summarization_retry_finished" });
    applyRpc(store, 6, { type: "turn_start" });
    expect(store.getSnapshot()).toMatchObject({ phase: "running", activeTurnId: "rpc-turn:6" });
  });

  it("sequence gap 失败，重复 event 幂等丢弃", () => {
    const store = new PiThreadStore(snapshot([], null));
    expect(() => applyRpc(store, 2, { type: "agent_start" })).toThrow(PiThreadStoreError);
    applyRpc(store, 1, { type: "agent_start" });
    applyRpc(store, 1, { type: "agent_settled" });
    expect(store.getSnapshot()).toMatchObject({ cursor: 1, phase: "running" });
  });

  it("休眠后恢复并继续归约 Pi 事件", () => {
    const initial = snapshot([userNode("u", null)], "u");
    const store = new PiThreadStore(initial);
    expect(store.hibernate()).toBe(true);
    expect(store.getSnapshot()).toEqual(initial);
    applyRpc(store, 1, { type: "agent_start" });
    expect(store.getSnapshot()).toMatchObject({ cursor: 1, phase: "running" });
  });

  it("有订阅者时拒绝休眠，释放后可驱逐", () => {
    const initial = snapshot([assistantNode("a", null)], "a");
    const store = new PiThreadStore(initial);
    const unsubscribe = store.subscribe(() => undefined);
    expect(store.hibernate()).toBe(false);
    unsubscribe();
    expect(store.hibernate()).toBe(true);
    expect(store.getHibernatedBytes()).toBeGreaterThan(0);
    expect(store.evictHibernated()).toBe(true);
    expect(store.getSnapshot()).toEqual(detachedThreadSnapshot());
  });

  it("休眠状态可由 bootstrap snapshot 直接替换", () => {
    const store = new PiThreadStore(snapshot([assistantNode("old", null)], "old"));
    const replacement = snapshot([userNode("new", null)], "new", 2);
    store.hibernate();
    store.replace(replacement);
    expect(store.getSnapshot()).toBe(replacement);
  });
});

describe("PiMessageRepositoryConverter", () => {
  it("保留 parent/head，图片只生成 complete attachment", () => {
    const user = userNode("u", null, true);
    const assistant = assistantNode("a", "u");
    const converter = new PiMessageRepositoryConverter();
    const repository = converter.build(snapshot([user, assistant], "a"));

    expect(repository.headId).toBe("a");
    expect(repository.messages.map(({ parentId }) => parentId)).toEqual([null, "u"]);
    const converted = repository.messages[0]?.message;
    expect(converted?.role).toBe("user");
    if (converted?.role !== "user") throw new Error("user message missing");
    expect(converted.content).toEqual([{ type: "text", text: "question" }]);
    expect(converted.attachments).toEqual([
      expect.objectContaining({
        id: "u:image:1",
        status: { type: "complete" },
        content: [
          {
            type: "image",
            image: "pi-session-image:00000000-0000-4000-8000-000000000001#image%2Fpng",
            filename: "image-2.png",
          },
        ],
      }),
    ]);
  });

  it("将带版本标记的 user file 上下文恢复为 complete attachment", () => {
    const marker = `<pi-file-context-v1>${JSON.stringify({
      files: [{ path: "C:\\A&B\\setup.exe", name: "setup.exe" }],
    })}</pi-file-context-v1>`;
    const user = {
      ...userNode("u", null),
      content: [
        {
          type: "text" as const,
          text: `question\n\n${marker}\n\n<file name="C:\\A&amp;B\\setup.exe">setup.exe</file>`,
        },
      ],
    };
    const repository = new PiMessageRepositoryConverter().build(snapshot([user], "u"));
    const converted = repository.messages[0]?.message;

    expect(converted?.role).toBe("user");
    if (converted?.role !== "user") throw new Error("user message missing");
    expect(converted.content).toEqual([{ type: "text", text: "question" }]);
    expect(converted.attachments).toEqual([
      {
        id: "u:file:0:0",
        type: "file",
        name: "setup.exe",
        contentType: "application/octet-stream",
        status: { type: "complete" },
        content: [
          {
            type: "file",
            data: "C:\\A&B\\setup.exe",
            filename: "setup.exe",
            mimeType: "application/octet-stream",
          },
        ],
      },
    ]);
  });

  it("把无标记的尾部 file 示例保留为正文，不误解读为附件", () => {
    const text = '用户展示的示例\n\n<file name="C:\\A&amp;B\\setup.exe">setup.exe</file>';
    const user = {
      ...userNode("u", null),
      content: [{ type: "text" as const, text }],
    };
    const repository = new PiMessageRepositoryConverter().build(snapshot([user], "u"));
    const converted = repository.messages[0]?.message;

    expect(converted?.role).toBe("user");
    if (converted?.role !== "user") throw new Error("user message missing");
    expect(converted.content).toEqual([{ type: "text", text }]);
    expect(converted.attachments).toEqual([]);
  });

  it("在 metadata 中保留 user quote", () => {
    const user = { ...userNode("u", null), quote: { text: "引用内容", messageId: "assistant" } };
    const repository = new PiMessageRepositoryConverter().build(snapshot([user], "u"));

    expect(repository.messages[0]?.message.metadata.custom).toMatchObject({
      quote: { text: "引用内容", messageId: "assistant" },
    });
  });

  it("在 metadata 中保留 Pi canonical status 与完成时间", () => {
    const assistant = {
      ...assistantNode("a", null),
      completedAt: 12_000,
      status: { type: "running" as const },
    };
    const repository = new PiMessageRepositoryConverter().build(snapshot([assistant], "a"));

    expect(repository.messages[0]?.message.metadata.custom).toMatchObject({
      pi: { status: { type: "running" }, completedAt: 12_000 },
    });
  });

  it("将同一轮连续 assistant 节点合并，使两个 text 之间的 reasoning/tool 保持相邻", () => {
    const user = userNode("u", null);
    const first = {
      ...assistantNode("a-1", "u"),
      createdAt: 1_000,
      content: [
        { id: "a-1:text:0", type: "text", text: "before" },
        { id: "a-1:reasoning:1", type: "reasoning", text: "first reasoning" },
        toolPart("a-1:tool:2", "read-1", "read"),
      ],
    } satisfies PiAssistantMessage;
    const second = {
      ...assistantNode("a-2", "a-1"),
      content: [
        { id: "a-2:reasoning:0", type: "reasoning", text: "second reasoning" },
        toolPart("a-2:tool:1", "bash-1", "bash"),
      ],
    } satisfies PiAssistantMessage;
    const third = {
      ...assistantNode("a-3", "a-2"),
      completedAt: 13_000,
      content: [{ id: "a-3:text:0", type: "text", text: "after" }],
    } satisfies PiAssistantMessage;
    const nextUser = userNode("u-2", "a-3");
    const converter = new PiMessageRepositoryConverter();

    const repository = converter.build(snapshot([user, first, second, third, nextUser], "u-2"));

    expect(repository.messages.map(({ message, parentId }) => [message.id, parentId])).toEqual([
      ["u", null],
      ["a-1", "u"],
      ["u-2", "a-1"],
    ]);
    const merged = repository.messages[1]?.message;
    expect(merged?.role).toBe("assistant");
    if (merged?.role !== "assistant") throw new Error("assistant message missing");
    expect(merged.createdAt.getTime()).toBe(1_000);
    expect(merged.metadata.custom).toMatchObject({ pi: { completedAt: 13_000 } });
    expect(merged.content.map((part) => part.type)).toEqual([
      "text",
      "reasoning",
      "tool-call",
      "reasoning",
      "tool-call",
      "text",
    ]);
    expect(merged.content.flatMap((part) => (part.type === "tool-call" ? [part.toolCallId] : []))).toEqual([
      "a-1:tool:2",
      "a-2:tool:1",
    ]);
  });

  it("连续 assistant 节点复用 provider toolCallId 时使用唯一 part identity", () => {
    const first = {
      ...assistantNode("a-1", null),
      content: [toolPart("a-1:tool:0", "shared-call", "read")],
    } satisfies PiAssistantMessage;
    const second = {
      ...assistantNode("a-2", "a-1"),
      content: [toolPart("a-2:tool:0", "shared-call", "bash")],
    } satisfies PiAssistantMessage;
    const converter = new PiMessageRepositoryConverter();

    const repository = converter.build(snapshot([first, second], "a-2"));
    const converted = repository.messages[0]?.message;
    expect(converted?.role).toBe("assistant");
    if (converted?.role !== "assistant") throw new Error("assistant message missing");
    expect(converted.content).toMatchObject([
      { type: "tool-call", toolCallId: "a-1:tool:0", toolName: "read" },
      { type: "tool-call", toolCallId: "a-2:tool:0", toolName: "bash" },
    ]);
    expect(first.content[0]).toMatchObject({ toolCallId: "shared-call" });
    expect(second.content[0]).toMatchObject({ toolCallId: "shared-call" });
  });

  it("单个 assistant 节点包含重复 provider toolCallId 时仍生成唯一资源 identity", () => {
    const assistant = {
      ...assistantNode("a", null),
      content: [toolPart("a:tool:0", "shared-call", "read"), toolPart("a:tool:1", "shared-call", "write")],
    } satisfies PiAssistantMessage;
    const converter = new PiMessageRepositoryConverter();

    const repository = converter.build(snapshot([assistant], "a"));
    const converted = repository.messages[0]?.message;
    expect(converted?.role).toBe("assistant");
    if (converted?.role !== "assistant") throw new Error("assistant message missing");
    expect(converted.content).toMatchObject([
      { type: "tool-call", toolCallId: "a:tool:0", toolName: "read" },
      { type: "tool-call", toolCallId: "a:tool:1", toolName: "write" },
    ]);
  });

  it("将 active assistant 的 notification part 原位转换为 pi-notice data", () => {
    const assistant = {
      ...assistantNode("a", null),
      content: [
        { id: "a:reasoning:0", type: "reasoning", text: "分析" },
        {
          id: "a:notification:1",
          type: "notification",
          notificationType: "warning",
          text: "需要注意",
          extensionNotification: { customType: "subagents.warning", details: { runId: "run-1" } },
          createdAt: 2,
        },
        { id: "a:text:2", type: "text", text: "最终回复" },
      ],
    } satisfies PiAssistantMessage;
    const converter = new PiMessageRepositoryConverter();

    const repository = converter.build(snapshot([assistant], "a"));
    const converted = repository.messages[0]?.message;
    expect(converted?.role).toBe("assistant");
    if (converted?.role !== "assistant") throw new Error("assistant message missing");
    expect(converted.content).toEqual([
      expect.objectContaining({ type: "reasoning", text: "分析" }),
      expect.objectContaining({
        type: "data",
        name: "pi-notice",
        data: expect.objectContaining({
          noticeType: "notification",
          notificationType: "warning",
          extensionNotification: { customType: "subagents.warning", details: { runId: "run-1" } },
          content: { type: "text", text: "需要注意" },
        }),
      }),
      expect.objectContaining({ type: "text", text: "最终回复" }),
    ]);
  });

  it("跨过 pi-notice 合并同一轮 assistant，并将 notice 保留为 data part", () => {
    const user = userNode("u", null);
    const first = assistantNode("a-1", "u");
    const notice = noticeNode("notice", "a-1", "custom");
    const second = assistantNode("a-2", "notice");
    const nextUser = userNode("u-2", "a-2");
    const converter = new PiMessageRepositoryConverter();

    const repository = converter.build(snapshot([user, first, notice, second, nextUser], "u-2"));

    expect(repository.messages.map(({ message, parentId }) => [message.id, parentId])).toEqual([
      ["u", null],
      ["a-1", "u"],
      ["u-2", "a-1"],
    ]);
    const merged = repository.messages[1]?.message;
    expect(merged?.role).toBe("assistant");
    if (merged?.role !== "assistant") throw new Error("assistant message missing");
    expect(merged.content).toEqual([
      expect.objectContaining({ type: "text", text: "hello" }),
      { type: "data", name: "pi-notice", data: notice },
      expect.objectContaining({ type: "text", text: "hello" }),
    ]);
  });

  it("压缩 notice 也并入 assistant group，不打断前后 assistant 流", () => {
    const first = assistantNode("a-1", null);
    const compaction = noticeNode("compaction", "a-1", "compaction");
    const second = assistantNode("a-2", "compaction");
    const converter = new PiMessageRepositoryConverter();

    const repository = converter.build(snapshot([first, compaction, second], "a-2"));

    expect(repository.messages.map(({ message, parentId }) => [message.id, parentId])).toEqual([["a-1", null]]);
    expect(repository.headId).toBe("a-1");
    expect(repository.messages[0]?.message).toMatchObject({
      id: "a-1",
      role: "assistant",
      content: [
        expect.objectContaining({ type: "text", text: "hello" }),
        { type: "data", name: "pi-notice", data: compaction },
        expect.objectContaining({ type: "text", text: "hello" }),
      ],
    });
  });

  it("普通尾部 notice 立即并入前一 assistant，后续 assistant 不触发消息重组", () => {
    const first = assistantNode("a-1", null);
    const notice = noticeNode("notice", "a-1", "custom");
    const converter = new PiMessageRepositoryConverter();
    const before = converter.build(snapshot([first, notice], "notice"));
    const second = assistantNode("a-2", "notice");
    const after = converter.build(snapshot([first, notice, second], "a-2", 1));

    expect(before.messages.map(({ message }) => message.id)).toEqual(["a-1"]);
    expect(before.headId).toBe("a-1");
    const beforeMessage = before.messages[0]?.message;
    expect(beforeMessage?.role).toBe("assistant");
    if (beforeMessage?.role !== "assistant") throw new Error("assistant message missing");
    expect(beforeMessage.content.map((part) => part.type)).toEqual(["text", "data"]);

    expect(after.messages.map(({ message }) => message.id)).toEqual(["a-1"]);
    expect(after.headId).toBe("a-1");
    const afterMessage = after.messages[0]?.message;
    expect(afterMessage?.role).toBe("assistant");
    if (afterMessage?.role !== "assistant") throw new Error("assistant message missing");
    expect(afterMessage.content.map((part) => part.type)).toEqual(["text", "data", "text"]);
  });

  it("连续 assistant group 未变化时复用 ThreadMessage，成员变化时重建", () => {
    const user = userNode("u", null);
    const firstAssistant = assistantNode("a-1", "u");
    const secondAssistant = assistantNode("a-2", "a-1");
    const converter = new PiMessageRepositoryConverter();
    const first = converter.build(snapshot([user, firstAssistant, secondAssistant], "a-2"));
    const unchanged = converter.build(snapshot([user, firstAssistant, secondAssistant], "a-2", 1));
    const updatedAssistant = {
      ...secondAssistant,
      content: [{ ...secondAssistant.content[0]!, text: "updated" }],
    };
    const updated = converter.build(snapshot([user, firstAssistant, updatedAssistant], "a-2", 2));

    expect(first.headId).toBe("a-1");
    expect(unchanged.messages[1]?.message).toBe(first.messages[1]?.message);
    expect(updated.messages[1]?.message).not.toBe(first.messages[1]?.message);
  });

  it("snapshot wrapper 更新时复用未变化 ThreadMessage", () => {
    const user = userNode("u", null);
    const assistant = assistantNode("a", "u");
    const converter = new PiMessageRepositoryConverter();
    const first = converter.build(snapshot([user, assistant], "a"));
    const updated = { ...assistant, content: [{ ...assistant.content[0]!, text: "updated" }] };
    const second = converter.build(snapshot([user, updated], "a", 1));

    expect(second).not.toBe(first);
    expect(second.messages[0]?.message).toBe(first.messages[0]?.message);
    expect(second.messages[1]?.message).not.toBe(first.messages[1]?.message);
  });

  it("messages/head 未变化时复用 repository wrapper，head 变化时只替换 wrapper", () => {
    const nodes = [userNode("u", null), assistantNode("a", "u")];
    const converter = new PiMessageRepositoryConverter();
    const first = converter.build(snapshot(nodes, "a"));
    const second = converter.build(snapshot(nodes, "a", 1));
    const differentHead = converter.build(snapshot(nodes, "u", 2));

    expect(second).toBe(first);
    expect(second.messages).toBe(first.messages);
    expect(differentHead).not.toBe(first);
    expect(differentHead.messages).toBe(first.messages);
  });

  it("text delta 只替换目标 assistant part，并复用历史 tool artifact", () => {
    const tool = toolPart("a:tool:0", "read-1", "read");
    const text = { id: "a:text:1", type: "text", text: "before" } as const;
    const assistant = { ...assistantNode("a", null), content: [tool, text] };
    const converter = new PiMessageRepositoryConverter();
    const first = converter.build(snapshot([assistant], "a"));
    const updated = { ...assistant, content: [tool, { ...text, text: "after" }] };
    const second = converter.build(snapshot([updated], "a", 1));
    const firstMessage = first.messages[0]?.message;
    const secondMessage = second.messages[0]?.message;
    if (firstMessage?.role !== "assistant" || secondMessage?.role !== "assistant") {
      throw new Error("assistant message missing");
    }

    expect(secondMessage.content[0]).toBe(firstMessage.content[0]);
    expect(secondMessage.content[1]).not.toBe(firstMessage.content[1]);
    expect(secondMessage.content[0]?.type).toBe("tool-call");
    if (secondMessage.content[0]?.type !== "tool-call" || firstMessage.content[0]?.type !== "tool-call") {
      throw new Error("tool part missing");
    }
    expect(secondMessage.content[0].artifact).toBe(firstMessage.content[0].artifact);
  });

  it("Pi tool_execution_update 将 partialResult 投影为新的 repository part", () => {
    const tool = {
      ...toolPart("a:tool:0", "write-1", "write"),
      args: { path: "src/main.ts", content: "const value" },
      argsText: '{"path":"src/main.ts","content":"const value"}',
      execution: "waiting" as const,
    };
    const assistant = { ...assistantNode("a", null), content: [tool] };
    const store = new PiThreadStore(snapshot([assistant], "a"));
    const converter = new PiMessageRepositoryConverter();
    const first = converter.build(store.getSnapshot());

    applyRpc(store, 1, {
      type: "tool_execution_update",
      toolCallId: "write-1",
      toolName: "write",
      args: tool.args,
      partialResult: { content: [{ type: "text", text: "written 8 bytes" }] },
    });
    const second = converter.build(store.getSnapshot());
    const firstMessage = first.messages[0]?.message;
    const secondMessage = second.messages[0]?.message;
    if (firstMessage?.role !== "assistant" || secondMessage?.role !== "assistant") {
      throw new Error("assistant message missing");
    }
    const firstPart = firstMessage.content[0];
    const secondPart = secondMessage.content[0];
    expect(secondPart).not.toBe(firstPart);
    expect(secondPart).toMatchObject({
      type: "tool-call",
      args: { path: "src/main.ts", content: "const value" },
      argsText: '{"path":"src/main.ts","content":"const value"}',
      artifact: {
        execution: "running",
        partialResult: { content: [{ type: "text", text: "written 8 bytes" }] },
      },
    });
  });

  it("1,000 nodes + 1,000 deltas 不重复转换未变化历史 message", () => {
    const users = Array.from({ length: 999 }, (_, index) =>
      userNode(`u-${index}`, index === 0 ? null : `u-${index - 1}`),
    );
    const assistant = {
      ...assistantNode("a", "u-998"),
      status: { type: "running" as const },
    };
    const store = new PiThreadStore(snapshot([...users, assistant], "a"));
    const converter = new PiMessageRepositoryConverter();
    const first = converter.build(store.getSnapshot());
    let latest = first;

    for (let sequence = 1; sequence <= 1_000; sequence += 1) {
      applyRpc(store, sequence, {
        type: "message_update",
        usage: assistant.usage,
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x" },
      });
      latest = converter.build(store.getSnapshot());
    }

    expect(latest.messages[0]?.message).toBe(first.messages[0]?.message);
    expect(latest.messages[998]?.message).toBe(first.messages[998]?.message);
    expect(latest.messages[0]).toBe(first.messages[0]);
    expect(latest.messages[998]).toBe(first.messages[998]);
    const converted = latest.messages[999]?.message;
    expect(converted?.role).toBe("assistant");
    if (converted?.role !== "assistant") throw new Error("assistant message missing");
    expect(converted.content[0]).toMatchObject({ text: `hello${"x".repeat(1_000)}` });
  });
});

function noticeNode(id: string, parentId: string | null, noticeType: PiNoticeMessage["noticeType"]): PiNoticeMessage {
  return {
    id,
    parentId,
    createdAt: 2,
    kind: "notice",
    noticeType,
    title: noticeType === "compaction" ? "上下文压缩" : "通知",
    content: { type: "text", text: "summary" },
  };
}

function snapshot(nodes: PiThreadSnapshot["nodes"], headId: string | null, cursor = 0): PiThreadSnapshot {
  return {
    protocolVersion: PROTOCOL_VERSION,
    projectId: "project",
    threadId: "thread",
    cursor,
    headId,
    nodes,
    queue: [],
    phase: "idle",
    thinkingLevel: "off",
  };
}

function applyRpc(store: PiThreadStore, sequence: number, event: PiRpcEvent): void {
  store.apply(sequence, event);
}

function assistantMessage(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
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
    timestamp: 2,
  };
}

function userNode(id: string, parentId: string | null, image = false): PiUserMessage {
  return {
    id,
    parentId,
    createdAt: 1,
    kind: "user",
    content: [
      { type: "text", text: "question" },
      ...(image
        ? ([
            {
              type: "image",
              resourceId: "00000000-0000-4000-8000-000000000001",
              mimeType: "image/png",
            },
          ] as const)
        : []),
    ],
    delivery: { state: "persisted" },
  };
}

function toolPart(
  id: string,
  toolCallId: string,
  toolName: string,
): Extract<PiAssistantMessage["content"][number], { type: "tool-call" }> {
  return {
    id,
    type: "tool-call",
    toolCallId,
    toolName,
    args: {},
    argsText: "{}",
    execution: "complete",
  };
}

function assistantNode(id: string, parentId: string | null): PiAssistantMessage {
  return {
    id,
    parentId,
    createdAt: 2,
    kind: "assistant",
    content: [{ id: `${id}:text:0`, type: "text", text: "hello" }],
    status: { type: "complete", reason: "stop" },
    provenance: { api: "test", provider: "test", model: "faux" },
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}
