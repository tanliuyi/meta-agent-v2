import React, { type KeyboardEvent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({
  cancel: vi.fn(),
  setText: vi.fn(),
  composerText: "",
  placeholder: undefined as string | undefined,
  onKeyDownCapture: undefined as ((event: KeyboardEvent<HTMLDivElement>) => void) | undefined,
  commandSources: [] as string[],
}));

vi.mock("@assistant-ui/react", () => ({
  unstable_useTriggerPopoverAriaProps: () => ({}),
  unstable_useTriggerPopoverTriggers: () => new Map(),
  useAui: () => ({
    composer: () => ({
      cancel: captured.cancel,
      getState: () => ({ text: captured.composerText }),
      setText: (text: string) => {
        captured.composerText = text;
        captured.setText(text);
      },
    }),
    thread: () => ({ getState: () => ({ capabilities: { attachments: false } }) }),
  }),
  useAuiState: (
    selector: (state: {
      thread: { isDisabled: boolean };
      composer: { dictation: { inputDisabled: boolean } | undefined; text: string };
    }) => unknown,
  ) => selector({ thread: { isDisabled: false }, composer: { dictation: undefined, text: captured.composerText } }),
}));

vi.mock("@assistant-ui/react-lexical", () => ({
  LexicalComposerInput: ({
    onKeyDownCapture,
    placeholder,
  }: {
    onKeyDownCapture?: (event: KeyboardEvent<HTMLDivElement>) => void;
    placeholder?: string;
  }) => {
    captured.onKeyDownCapture = onKeyDownCapture;
    captured.placeholder = placeholder;
    return null;
  },
}));

vi.mock("../src/renderer/src/components/chat/composer/composer-command-trigger.tsx", () => ({
  ComposerCommandTrigger: ({ commands }: { commands: readonly { source: string }[] }) => {
    captured.commandSources = commands.map(({ source }) => source);
    return "command-trigger";
  },
  slashCommandText: (command: { name: string }, args: string) =>
    `/${command.name}${args.trim() ? ` ${args.trim()}` : ""}`,
}));

vi.mock("../src/renderer/src/components/chat/composer/composer-file-trigger.tsx", () => ({
  ComposerFileTrigger: () => null,
}));

import {
  ComposerInput,
  shouldDeferComposerKeyToTrigger,
  syncFocusedComposerInput,
} from "../src/renderer/src/components/chat/composer/composer-input.tsx";

describe("ComposerInput", () => {
  beforeEach(() => {
    captured.cancel.mockClear();
    captured.setText.mockClear();
    captured.composerText = "";
    captured.placeholder = undefined;
    captured.onKeyDownCapture = undefined;
    captured.commandSources = [];
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("按 slash 上下文限制可选择的命令来源", () => {
    const commands = [
      { name: "reload", source: "builtin" as const },
      { name: "review", source: "extension" as const },
      { name: "fix", source: "prompt" as const },
      { name: "skill:frontend", source: "skill" as const },
    ];
    const renderInput = () =>
      renderToStaticMarkup(
        <ComposerInput
          projectId={undefined}
          commands={commands}
          selectedCommand={null}
          mode="session"
          isRunning={false}
          isCancelable={false}
          materializing={false}
          onCommandSelect={() => undefined}
          onCommandClear={() => undefined}
          onSubmit={() => undefined}
          onSubmitRunning={() => undefined}
          onEscapeCancelPendingChange={() => undefined}
        />,
      );

    expect(renderInput()).toContain("command-trigger");
    expect(captured.commandSources).toEqual(["builtin", "extension", "prompt", "skill"]);

    captured.composerText = "/rev";
    expect(renderInput()).toContain("command-trigger");
    expect(captured.commandSources).toEqual(["builtin", "extension", "prompt", "skill"]);

    captured.composerText = "检查代码 /rev";
    expect(renderInput()).toContain("command-trigger");
    expect(captured.commandSources).toEqual(["prompt", "skill"]);

    captured.composerText = "检查代码/rev";
    expect(renderInput()).not.toContain("command-trigger");
  });

  it("命令候选只用 Tab 或 Enter 确认，不截获空格", () => {
    expect(shouldDeferComposerKeyToTrigger("Tab", true)).toBe(true);
    expect(shouldDeferComposerKeyToTrigger("Enter", true)).toBe(true);
    expect(shouldDeferComposerKeyToTrigger(" ", true)).toBe(false);
  });

  it("同步 ARIA 和禁用状态到实际可聚焦的 contenteditable", () => {
    const attributes = new Map<string, string>();
    const element = {
      setAttribute: (name: string, value: string) => attributes.set(name, value),
      removeAttribute: (name: string) => attributes.delete(name),
    } as unknown as HTMLElement;

    syncFocusedComposerInput(element, {
      disabled: true,
      controls: "command-list",
      activeDescendant: "command-help",
      expanded: true,
    });

    expect(Object.fromEntries(attributes)).toMatchObject({
      role: "combobox",
      "aria-label": "消息输入",
      "aria-autocomplete": "list",
      "aria-haspopup": "listbox",
      "aria-expanded": "true",
      "aria-disabled": "true",
      contenteditable: "false",
      "aria-controls": "command-list",
      "aria-activedescendant": "command-help",
    });

    syncFocusedComposerInput(element, { disabled: false, expanded: false });
    expect(attributes.get("contenteditable")).toBe("true");
    expect(attributes.get("aria-expanded")).toBe("false");
    expect(attributes.has("aria-controls")).toBe(false);
    expect(attributes.has("aria-activedescendant")).toBe(false);
  });

  it("提交普通 Enter 时消费原生事件，避免 Lexical 插入换行", () => {
    const onSubmit = vi.fn();
    const onSubmitRunning = vi.fn();
    renderToStaticMarkup(
      <ComposerInput
        projectId={undefined}
        commands={[]}
        selectedCommand={null}
        mode="session"
        isRunning={false}
        isCancelable={false}
        materializing={false}
        onCommandSelect={() => undefined}
        onCommandClear={() => undefined}
        onSubmit={onSubmit}
        onSubmitRunning={onSubmitRunning}
        onEscapeCancelPendingChange={() => undefined}
      />,
    );

    const handler = captured.onKeyDownCapture;
    if (!handler) throw new Error("Composer input key handler was not rendered");
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    const stopImmediatePropagation = vi.fn();
    handler({
      key: "Enter",
      shiftKey: false,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      repeat: false,
      preventDefault,
      stopPropagation,
      nativeEvent: { isComposing: false, stopImmediatePropagation },
    } as unknown as KeyboardEvent<HTMLDivElement>);

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(stopImmediatePropagation).toHaveBeenCalledOnce();
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onSubmitRunning).not.toHaveBeenCalled();
  });

  it("仅在一秒内连续按两次 Escape 时取消运行", () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", globalThis);
    const onEscapeCancelPendingChange = vi.fn();
    renderToStaticMarkup(
      <ComposerInput
        projectId={undefined}
        commands={[]}
        selectedCommand={null}
        mode="session"
        isRunning={true}
        isCancelable={true}
        materializing={false}
        onCommandSelect={() => undefined}
        onCommandClear={() => undefined}
        onSubmit={() => undefined}
        onSubmitRunning={() => undefined}
        onEscapeCancelPendingChange={onEscapeCancelPendingChange}
      />,
    );

    const handler = captured.onKeyDownCapture;
    if (!handler) throw new Error("Composer input key handler was not rendered");
    const pressEscape = () =>
      handler({
        key: "Escape",
        repeat: false,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
        nativeEvent: { isComposing: false },
      } as unknown as KeyboardEvent<HTMLDivElement>);

    pressEscape();
    expect(onEscapeCancelPendingChange).toHaveBeenLastCalledWith(true);
    expect(captured.cancel).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1_000);
    expect(onEscapeCancelPendingChange).toHaveBeenLastCalledWith(false);
    expect(captured.cancel).not.toHaveBeenCalled();

    pressEscape();
    pressEscape();
    expect(onEscapeCancelPendingChange).toHaveBeenLastCalledWith(false);
    expect(captured.cancel).toHaveBeenCalledOnce();
  });

  it("空参数命令通过 Backspace 或第二个空格还原为普通文本", () => {
    const onCommandClear = vi.fn();
    const html = renderToStaticMarkup(
      <ComposerInput
        projectId={undefined}
        commands={[]}
        selectedCommand={{ name: "review", description: "Review the current changes", source: "extension" }}
        mode="session"
        isRunning={false}
        isCancelable={false}
        materializing={false}
        onCommandSelect={() => undefined}
        onCommandClear={onCommandClear}
        onSubmit={() => undefined}
        onSubmitRunning={() => undefined}
        onEscapeCancelPendingChange={() => undefined}
      />,
    );

    expect(html).toContain("/review");
    expect(html).toContain("移除命令 /review");
    expect(captured.placeholder).toBe("Review the current changes");

    const handler = captured.onKeyDownCapture;
    if (!handler) throw new Error("Composer input key handler was not rendered");
    const press = (key: string) => {
      const preventDefault = vi.fn();
      const stopPropagation = vi.fn();
      handler({
        key,
        shiftKey: false,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        preventDefault,
        stopPropagation,
        nativeEvent: { isComposing: false },
      } as unknown as KeyboardEvent<HTMLDivElement>);
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(stopPropagation).toHaveBeenCalledOnce();
    };

    press("Backspace");
    expect(captured.setText).toHaveBeenLastCalledWith("/review");
    expect(onCommandClear).toHaveBeenCalledOnce();

    captured.composerText = "";
    captured.setText.mockClear();
    onCommandClear.mockClear();
    press(" ");
    expect(captured.setText).toHaveBeenLastCalledWith("/review");
    expect(onCommandClear).toHaveBeenCalledOnce();
  });
});
