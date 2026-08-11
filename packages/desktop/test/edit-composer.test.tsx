// @vitest-environment jsdom

import React, { act, type ChangeEventHandler, type CompositionEventHandler, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type InputProps = {
  className?: string;
  value?: string | number | readonly string[];
  onChange?: ChangeEventHandler<HTMLTextAreaElement>;
  onCompositionStart?: CompositionEventHandler<HTMLTextAreaElement>;
  onCompositionEnd?: CompositionEventHandler<HTMLTextAreaElement>;
};

const send = vi.hoisted(() => vi.fn());

vi.mock("@assistant-ui/react", () => ({
  ComposerPrimitive: {
    Root: ({ children }: { children?: ReactNode }) => <form>{children}</form>,
    Input: ({ className, value, onChange, onCompositionStart, onCompositionEnd }: InputProps) => (
      <textarea
        className={className}
        value={value}
        onChange={onChange}
        onCompositionStart={onCompositionStart}
        onCompositionEnd={onCompositionEnd}
      />
    ),
    Cancel: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  },
  MessagePrimitive: {
    Root: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  },
  useAui: () => ({ composer: () => ({ send }) }),
  useAuiState: (selector: (state: unknown) => unknown) =>
    selector({
      composer: { canSend: true, text: "original" },
      thread: { isRunning: false, capabilities: { queue: false } },
    }),
}));

vi.mock("../src/renderer/src/shared/ui/button.tsx", () => ({
  Button: ({ children }: { children?: ReactNode }) => <button type="button">{children}</button>,
}));

import { EditComposer } from "../src/renderer/src/components/chat/message/edit-composer.tsx";

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<EditComposer />);
  });
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  send.mockReset();
});

function input(): HTMLTextAreaElement {
  const element = container.querySelector("textarea");
  if (!element) throw new Error("Expected edit composer textarea");
  return element;
}

async function dispatch(type: "input" | "compositionstart" | "compositionend", value: string): Promise<void> {
  const element = input();
  element.value = value;
  await act(async () => {
    element.dispatchEvent(new Event(type, { bubbles: true }));
  });
}

describe("EditComposer IME input", () => {
  it("组合输入期间保留连续拼音并在选字后保留中文", async () => {
    expect(input().value).toBe("original");

    await dispatch("compositionstart", "original");
    await dispatch("input", "originaln");
    expect(input().value).toBe("originaln");

    await dispatch("input", "originalni");
    expect(input().value).toBe("originalni");

    await dispatch("compositionend", "original你");
    expect(input().value).toBe("original你");
  });

  it("非组合输入仍正常更新受控值", async () => {
    await dispatch("input", "original text");

    expect(input().value).toBe("original text");
  });
});
