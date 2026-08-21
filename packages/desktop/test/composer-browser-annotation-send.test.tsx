import React, { type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComposerProps } from "../src/renderer/src/components/chat/composer/composer-types.ts";
import {
  BrowserAnnotationSubmitTracker,
  subscribeBrowserAnnotationConsumed,
} from "../src/renderer/src/state/browser-composer-bridge.ts";
import type { SlashCommand } from "../src/shared/contracts.ts";

const captured = vi.hoisted(() => ({
  composerState: {
    text: "",
    isEmpty: true,
    quote: undefined as unknown,
    setText: vi.fn(),
    send: vi.fn(),
  },
  events: new Map<string, () => void>(),
  inputOnSubmit: undefined as (() => void) | undefined,
  commandOnSelect: undefined as ((command: SlashCommand) => void) | undefined,
  formOnSubmit: undefined as ((event: { preventDefault: () => void }) => void) | undefined,
}));

vi.mock("@assistant-ui/react", () => ({
  ComposerPrimitive: {
    Root: ({
      children,
      onSubmit,
    }: {
      children?: ReactNode;
      onSubmit?: (event: { preventDefault: () => void }) => void;
    }) => {
      captured.formOnSubmit = onSubmit;
      return <div>{children}</div>;
    },
    AttachmentDropzone: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    Unstable_TriggerPopoverRoot: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  },
  unstable_defaultDirectiveFormatter: { serialize: () => "" },
  useAui: () => ({
    composer: () => ({
      getState: () => ({
        text: captured.composerState.text,
        isEmpty: captured.composerState.isEmpty,
        quote: captured.composerState.quote,
      }),
      setText: captured.composerState.setText,
      send: captured.composerState.send,
      cancel: vi.fn(),
    }),
  }),
  useAuiEvent: (name: string, handler: () => void) => {
    captured.events.set(name, handler);
  },
  useAuiState: () => ({ thread: { isRunning: false } }),
}));

vi.mock("../src/renderer/src/components/session-context.tsx", () => ({
  useSessionScope: () => ({ record: { key: "session:test" } }),
}));

vi.mock("../src/renderer/src/components/chat/composer/composer-input.tsx", () => ({
  ComposerInput: ({
    onSubmit,
    onCommandSelect,
  }: {
    onSubmit: () => void;
    onCommandSelect: (command: SlashCommand) => void;
  }) => {
    captured.inputOnSubmit = onSubmit;
    // ComposerInput 内部把该回调转发给 ComposerCommandTrigger（其自身在
    // composer-input.test.tsx 单独覆盖）；这里模拟转发以测试 handleCommandSelect。
    captured.commandOnSelect = onCommandSelect;
    return null;
  },
}));

vi.mock("../src/renderer/src/components/chat/composer/composer-command-trigger.tsx", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../src/renderer/src/components/chat/composer/composer-command-trigger.tsx")>();
  return original;
});

vi.mock("../src/renderer/src/components/chat/composer/composer-quotes.tsx", () => ({ ComposerQuotes: () => null }));
vi.mock("../src/renderer/src/components/chat/composer/composer-queue.tsx", () => ({ ComposerQueue: () => null }));
vi.mock("../src/renderer/src/components/chat/composer/composer-extension-command.tsx", () => ({
  ComposerExtensionCommand: () => null,
}));
vi.mock("../src/renderer/src/components/chat/composer/composer-feedback.tsx", () => ({ ComposerFeedback: () => null }));
vi.mock("../src/renderer/src/components/chat/composer/composer-widgets.tsx", () => ({ ComposerWidgets: () => null }));
vi.mock("../src/renderer/src/components/chat/composer/composer-context-usage.tsx", () => ({
  ComposerContextUsage: () => null,
}));
vi.mock("../src/renderer/src/components/chat/composer/composer-submit-control.tsx", () => ({
  ComposerSubmitControl: () => null,
}));
vi.mock("../src/renderer/src/components/assistant-ui/attachment/composer-add-attachment.tsx", () => ({
  ComposerAddAttachment: () => null,
}));
vi.mock("../src/renderer/src/components/assistant-ui/attachment/composer-attachments.tsx", () => ({
  ComposerAttachments: () => null,
}));
vi.mock("../src/renderer/src/components/chat/model-select.tsx", () => ({ ModelSelect: () => null }));
vi.mock("../src/renderer/src/components/chat/plugin-select.tsx", () => ({ PluginSelect: () => null }));
vi.mock("../src/renderer/src/components/chat/project-select.tsx", () => ({ ProjectSelect: () => null }));
vi.mock("../src/renderer/src/components/chat/thinking-select.tsx", () => ({ ThinkingSelect: () => null }));

import { Composer } from "../src/renderer/src/components/chat/composer/composer.tsx";

const browserQuote = { text: "把按钮改成蓝色", messageId: "browser-annotation:annotation-1", tags: ["浏览器标注"] };

function draftProps(overrides: Partial<ComposerProps> = {}): ComposerProps {
  return {
    mode: "draft",
    projects: [],
    project: { id: "project", name: "Project", cwd: "C:/workspace", lastOpenedAt: 1, available: true },
    config: {
      models: [{ provider: "openai", id: "gpt", name: "GPT", contextWindow: 128_000, thinking: true }],
      commands: [],
      model: { provider: "openai", id: "gpt", name: "GPT" },
      thinkingLevel: "off",
      thinkingLevels: ["off"],
      readiness: { state: "ready" },
    },
    configLoading: false,
    phase: "editing",
    onProjectChange: vi.fn(),
    onModelChange: vi.fn(),
    onThinkingChange: vi.fn(),
    onSubmit: vi.fn(),
    ...overrides,
  } as ComposerProps;
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("BrowserAnnotationSubmitTracker", () => {
  it("snapshot 只保留浏览器标注前缀引用，onSend 广播消费并清空，重复 onSend 静默", () => {
    const tracker = new BrowserAnnotationSubmitTracker("session:tracker");
    const handler = vi.fn();
    const unsubscribe = subscribeBrowserAnnotationConsumed("session:tracker", handler);

    tracker.snapshot([
      { text: "普通引用", messageId: "assistant-1" },
      { text: "标注一", messageId: "browser-annotation:annotation-1" },
      { text: "标注二", messageId: "browser-annotation:annotation-2" },
    ]);
    tracker.onSend();
    expect(handler).toHaveBeenCalledWith({
      targetKey: "session:tracker",
      messageIds: ["browser-annotation:annotation-1", "browser-annotation:annotation-2"],
    });

    handler.mockClear();
    tracker.onSend();
    expect(handler).not.toHaveBeenCalled();

    unsubscribe();
  });

  it("重复 snapshot 替换上次快照，不累积陈旧引用", () => {
    const tracker = new BrowserAnnotationSubmitTracker("session:tracker");
    const handler = vi.fn();
    const unsubscribe = subscribeBrowserAnnotationConsumed("session:tracker", handler);

    tracker.snapshot([{ text: "旧标注", messageId: "browser-annotation:stale" }]);
    tracker.snapshot([{ text: "新标注", messageId: "browser-annotation:current" }]);
    tracker.onSend();
    expect(handler).toHaveBeenCalledWith({
      targetKey: "session:tracker",
      messageIds: ["browser-annotation:current"],
    });

    unsubscribe();
  });
});

describe("Composer draft 提交快照", () => {
  afterEach(() => {
    captured.composerState.quote = undefined;
    captured.composerState.isEmpty = true;
    captured.composerState.setText.mockClear();
    captured.events.clear();
    captured.inputOnSubmit = undefined;
    captured.commandOnSelect = undefined;
    captured.formOnSubmit = undefined;
  });

  it("draft Enter 提交：readiness 通过后发送前快照标注引用，onSubmit 成功即消费", async () => {
    const onSubmit = vi.fn();
    renderToStaticMarkup(<Composer {...draftProps({ onSubmit })} />);
    captured.composerState.quote = browserQuote;
    captured.composerState.isEmpty = false;

    const consumed = vi.fn();
    const unsubscribe = subscribeBrowserAnnotationConsumed("session:test", consumed);

    // Enter 提交（ComposerInput.onSubmit）→ submitDraft 统一路径。
    const inputSubmit = captured.inputOnSubmit;
    if (!inputSubmit) throw new Error("draft ComposerInput onSubmit 未挂载");
    inputSubmit();
    await flush();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    // 生产上 onSubmit 直接 materializeDraftSession，不触发 composer.send；
    // 成功返回后 submitDraft 直接按快照消费。
    expect(consumed).toHaveBeenCalledWith({
      targetKey: "session:test",
      messageIds: ["browser-annotation:annotation-1"],
    });

    unsubscribe();
  });

  it("draft 命令选择：与 Enter 共用 submitDraft 快照路径", async () => {
    const onSubmit = vi.fn();
    renderToStaticMarkup(<Composer {...draftProps({ onSubmit })} />);
    captured.composerState.quote = browserQuote;
    captured.composerState.isEmpty = false;

    const consumed = vi.fn();
    const unsubscribe = subscribeBrowserAnnotationConsumed("session:test", consumed);

    const commandSelect = captured.commandOnSelect;
    if (!commandSelect) throw new Error("命令选择回调未挂载");
    commandSelect({ name: "review", description: "review", source: "builtin", acceptsArguments: false });
    await flush();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(captured.composerState.setText).toHaveBeenCalledWith("/review");
    expect(consumed).toHaveBeenCalledWith({
      targetKey: "session:test",
      messageIds: ["browser-annotation:annotation-1"],
    });

    unsubscribe();
  });

  it("draft 表单提交（handleSubmit）与 Enter 共用 submitDraft 路径", async () => {
    const onSubmit = vi.fn();
    renderToStaticMarkup(<Composer {...draftProps({ onSubmit })} />);
    captured.composerState.quote = browserQuote;
    captured.composerState.isEmpty = false;

    const consumed = vi.fn();
    const unsubscribe = subscribeBrowserAnnotationConsumed("session:test", consumed);

    const formSubmit = captured.formOnSubmit;
    if (!formSubmit) throw new Error("表单 onSubmit 未挂载");
    const preventDefault = vi.fn();
    formSubmit({ preventDefault });
    await flush();
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(consumed).toHaveBeenCalledWith({
      targetKey: "session:test",
      messageIds: ["browser-annotation:annotation-1"],
    });

    unsubscribe();
  });

  it("draft onSubmit 失败：不消费标注，重试成功时按新快照消费", async () => {
    const onSubmit = vi.fn().mockRejectedValueOnce(new Error("materialize failed"));
    renderToStaticMarkup(<Composer {...draftProps({ onSubmit })} />);
    captured.composerState.quote = browserQuote;
    captured.composerState.isEmpty = false;

    const consumed = vi.fn();
    const unsubscribe = subscribeBrowserAnnotationConsumed("session:test", consumed);

    const inputSubmit = captured.inputOnSubmit;
    if (!inputSubmit) throw new Error("draft ComposerInput onSubmit 未挂载");
    inputSubmit();
    await flush();
    expect(onSubmit).toHaveBeenCalledTimes(1);
    // 失败不消费：标注引用保留（submitDraft 内部捕获 rejection，无未处理拒绝）。
    expect(consumed).not.toHaveBeenCalled();

    // 重试成功：引用仍在 composer，snapshot 替换 pending 后正常消费。
    onSubmit.mockResolvedValueOnce(undefined);
    inputSubmit();
    await flush();
    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(consumed).toHaveBeenCalledWith({
      targetKey: "session:test",
      messageIds: ["browser-annotation:annotation-1"],
    });

    unsubscribe();
  });

  it("readiness 未就绪时 draft 提交被拦截：不发 onSubmit、不产生消费事件", async () => {
    const onSubmit = vi.fn();
    renderToStaticMarkup(
      <Composer
        {...draftProps({
          onSubmit,
          config: {
            ...draftProps().config!,
            readiness: { state: "missing-model", message: "请先配置模型" },
          },
        })}
      />,
    );
    captured.composerState.quote = browserQuote;
    captured.composerState.isEmpty = false;

    const consumed = vi.fn();
    const unsubscribe = subscribeBrowserAnnotationConsumed("session:test", consumed);

    const inputSubmit = captured.inputOnSubmit;
    if (!inputSubmit) throw new Error("draft ComposerInput onSubmit 未挂载");
    inputSubmit();
    await flush();
    expect(onSubmit).not.toHaveBeenCalled();

    const sendEvent = captured.events.get("composer.send");
    if (!sendEvent) throw new Error("composer.send 事件未订阅");
    sendEvent();
    expect(consumed).not.toHaveBeenCalled();

    unsubscribe();
  });
});
