import React, { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MessageWidthControl } from "../src/renderer/src/features/settings/message-width-control.tsx";

interface CapturedRootProps {
  value: string | undefined;
  onValueChange(value: string): void;
}

const viewState = vi.hoisted(() => ({
  messageWidth: 810 as number | null,
  canUpdateMessageSettings: true,
  setMessageWidth: vi.fn(),
}));

const radioGroup = vi.hoisted(() => ({
  roots: [] as CapturedRootProps[],
  items: [] as Array<{ value: string | undefined; disabled: boolean }>,
}));

vi.mock("../src/renderer/src/state/thinking-visibility.tsx", () => ({
  useThinkingVisibility: () => viewState,
}));

vi.mock("@radix-ui/react-radio-group", () => ({
  Root: ({
    children,
    value,
    onValueChange,
  }: {
    children?: ReactNode;
    value?: string;
    onValueChange?(value: string): void;
  }) => {
    radioGroup.roots.push({ value, onValueChange: onValueChange ?? (() => {}) });
    return <>{children}</>;
  },
  Item: ({ children, value, disabled }: { children?: ReactNode; value?: string; disabled?: boolean }) => {
    radioGroup.items.push({ value, disabled: disabled === true });
    return <>{children}</>;
  },
}));

describe("MessageWidthControl", () => {
  beforeEach(() => {
    viewState.messageWidth = 810;
    viewState.canUpdateMessageSettings = true;
    viewState.setMessageWidth.mockClear();
    radioGroup.roots = [];
    radioGroup.items = [];
  });

  it("宽度匹配预设时选中对应档位", () => {
    viewState.messageWidth = 640;
    renderToStaticMarkup(createElement(MessageWidthControl));
    expect(radioGroup.roots.at(-1)?.value).toBe("small");

    viewState.messageWidth = 810;
    renderToStaticMarkup(createElement(MessageWidthControl));
    expect(radioGroup.roots.at(-1)?.value).toBe("medium");

    viewState.messageWidth = 980;
    renderToStaticMarkup(createElement(MessageWidthControl));
    expect(radioGroup.roots.at(-1)?.value).toBe("large");
  });

  it("满屏宽度选中满屏档位", () => {
    viewState.messageWidth = null;

    const html = renderToStaticMarkup(createElement(MessageWidthControl));

    expect(radioGroup.roots.at(-1)?.value).toBe("full");
    expect(html).not.toContain('type="number"');
  });

  it("未知宽度不选中任何档位", () => {
    viewState.messageWidth = 700;

    renderToStaticMarkup(createElement(MessageWidthControl));

    expect(radioGroup.roots.at(-1)?.value).toBe("");
  });

  it("点击档位写入对应宽度", () => {
    renderToStaticMarkup(createElement(MessageWidthControl));

    radioGroup.roots.at(-1)?.onValueChange("small");
    expect(viewState.setMessageWidth).toHaveBeenLastCalledWith(640);
    radioGroup.roots.at(-1)?.onValueChange("large");
    expect(viewState.setMessageWidth).toHaveBeenLastCalledWith(980);
    radioGroup.roots.at(-1)?.onValueChange("full");
    expect(viewState.setMessageWidth).toHaveBeenLastCalledWith(null);
  });

  it("点击未知档位不写入宽度", () => {
    renderToStaticMarkup(createElement(MessageWidthControl));

    radioGroup.roots.at(-1)?.onValueChange("unknown");

    expect(viewState.setMessageWidth).not.toHaveBeenCalled();
  });

  it("配置不可更新时禁用全部档位", () => {
    viewState.canUpdateMessageSettings = false;

    renderToStaticMarkup(createElement(MessageWidthControl));

    expect(radioGroup.items).toHaveLength(4);
    expect(radioGroup.items.every((item) => item.disabled)).toBe(true);
  });
});
