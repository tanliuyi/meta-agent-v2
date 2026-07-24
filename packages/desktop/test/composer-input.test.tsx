import React, { type KeyboardEvent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({
  onKeyDownCapture: undefined as ((event: KeyboardEvent<HTMLDivElement>) => void) | undefined,
}));

vi.mock("@assistant-ui/react", () => ({
  unstable_useTriggerPopoverAriaProps: () => ({}),
  useAui: () => ({
    composer: () => ({ cancel: vi.fn() }),
    thread: () => ({ getState: () => ({ capabilities: { attachments: false } }) }),
  }),
  useAuiState: (
    selector: (state: {
      thread: { isDisabled: boolean };
      composer: { dictation: { inputDisabled: boolean } | undefined };
    }) => unknown,
  ) => selector({ thread: { isDisabled: false }, composer: { dictation: undefined } }),
}));

vi.mock("@assistant-ui/react-lexical", () => ({
  LexicalComposerInput: ({
    onKeyDownCapture,
  }: {
    onKeyDownCapture?: (event: KeyboardEvent<HTMLDivElement>) => void;
  }) => {
    captured.onKeyDownCapture = onKeyDownCapture;
    return null;
  },
}));

vi.mock("../src/renderer/src/components/chat/composer-command-trigger.tsx", () => ({
  ComposerCommandTrigger: () => null,
}));

vi.mock("../src/renderer/src/components/chat/composer-file-trigger.tsx", () => ({
  ComposerFileTrigger: () => null,
}));

import { ComposerInput, syncFocusedComposerInput } from "../src/renderer/src/components/chat/composer-input.tsx";

describe("ComposerInput", () => {
  beforeEach(() => {
    captured.onKeyDownCapture = undefined;
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
        mode="session"
        isRunning={false}
        isCancelable={false}
        materializing={false}
        onSubmit={onSubmit}
        onSubmitRunning={onSubmitRunning}
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
});
