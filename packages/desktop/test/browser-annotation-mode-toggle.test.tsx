import MessageSquareQuote from "lucide-react/dist/esm/icons/message-square-quote.mjs";
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { AnnotationModeToggle } from "../src/renderer/src/components/panel/browser/browser-annotation-mode-toggle.tsx";

/** 在 React 元素树中查找满足条件的元素（源码契约测试；不渲染 DOM）。 */
function findElement(node: ReactNode, predicate: (element: ReactElement) => boolean): ReactElement | null {
  for (const child of Children.toArray(node)) {
    if (!isValidElement(child)) continue;
    if (predicate(child)) return child;
    const found = findElement(getChildren(child), predicate);
    if (found) return found;
  }
  return null;
}

function getChildren(element: ReactElement | null): ReactNode {
  return (element?.props as { children?: ReactNode } | undefined)?.children;
}

/** 元素子树全部文本（拼接字符串子节点）。 */
function elementText(element: ReactElement | null): string {
  return textOf(getChildren(element));
}

function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  return textOf(getChildren(node as ReactElement));
}

function hasClassName(element: ReactElement, className: string): boolean {
  return ((element.props as { className?: string }).className ?? "").split(" ").includes(className);
}

interface ToggleProps {
  size?: "icon" | "sm" | "default" | "lg" | null;
  tooltip?: string;
  "aria-label"?: string;
  "aria-pressed"?: boolean;
  "data-active"?: string;
  onClick?: () => void;
}

function findToggle(tree: ReactElement): { element: ReactElement; props: ToggleProps } {
  const element = findElement(tree, (candidate) => hasClassName(candidate, "browser-annotation-toggle"));
  if (element === null) throw new Error("缺少标注模式切换按钮");
  return { element, props: element.props as ToggleProps };
}

function renderToggle(active: boolean, onToggle: () => void): ReactElement {
  return AnnotationModeToggle({ active, onToggle });
}

describe("AnnotationModeToggle", () => {
  it("关闭态：请求 size=icon（TooltipIconButton 保持 24x24 图标按钮），仅图标、不渲染“正在标注”文本节点（避免 flex gap 残留占位导致图标左偏），aria-pressed=false 且无 data-active", () => {
    const { element, props } = findToggle(renderToggle(false, vi.fn()));
    expect(props.size).toBe("icon");
    expect(hasClassName(element, "h-6")).toBe(false);
    expect(hasClassName(element, "w-auto")).toBe(false);
    expect(hasClassName(element, "px-1.5")).toBe(false);
    expect(props["aria-label"]).toBe("开启标注模式");
    expect(props.tooltip).toBe("开启标注模式");
    expect(props["aria-pressed"]).toBe(false);
    expect(props["data-active"]).toBeUndefined();
    expect(findElement(element, (candidate) => candidate.type === MessageSquareQuote)).not.toBeNull();
    expect(findElement(element, (candidate) => hasClassName(candidate, "browser-annotation-toggle-text"))).toBeNull();
  });

  it("开启态：请求 size=sm 并附加紧凑尺寸 utility（h-6 w-auto gap-1 px-1.5，供 twMerge 消除 sm 自带冲突），图标 + aria-hidden 的“正在标注”文本，aria-pressed=true 且 data-active", () => {
    const { element, props } = findToggle(renderToggle(true, vi.fn()));
    expect(props.size).toBe("sm");
    expect(hasClassName(element, "h-6")).toBe(true);
    expect(hasClassName(element, "w-auto")).toBe(true);
    expect(hasClassName(element, "gap-1")).toBe(true);
    expect(hasClassName(element, "px-1.5")).toBe(true);
    expect(props["aria-label"]).toBe("退出标注模式");
    expect(props.tooltip).toBe("退出标注模式");
    expect(props["aria-pressed"]).toBe(true);
    expect(props["data-active"]).toBe(true);
    expect(findElement(element, (candidate) => candidate.type === MessageSquareQuote)).not.toBeNull();
    const text = findElement(element, (candidate) => hasClassName(candidate, "browser-annotation-toggle-text"));
    if (text === null) throw new Error("缺少“正在标注”文本");
    expect(elementText(text)).toBe("正在标注");
    expect((text.props as { "aria-hidden"?: boolean })["aria-hidden"]).toBe(true);
  });

  it("开启态：请求 size=sm 并附加紧凑尺寸 utility（h-6 w-auto gap-1 px-1.5，供 twMerge 消除 sm 自带冲突），图标 + aria-hidden 的“正在标注”文本，aria-pressed=true 且 data-active", () => {
    const { element, props } = findToggle(renderToggle(true, vi.fn()));
    expect(props.size).toBe("sm");
    expect(hasClassName(element, "h-6")).toBe(true);
    expect(hasClassName(element, "w-auto")).toBe(true);
    expect(hasClassName(element, "gap-1")).toBe(true);
    expect(hasClassName(element, "px-1.5")).toBe(true);
    expect(props["aria-label"]).toBe("退出标注模式");
    expect(props.tooltip).toBe("退出标注模式");
    expect(props["aria-pressed"]).toBe(true);
    expect(props["data-active"]).toBe(true);
    expect(findElement(element, (candidate) => candidate.type === MessageSquareQuote)).not.toBeNull();
    const text = findElement(element, (candidate) => hasClassName(candidate, "browser-annotation-toggle-text"));
    if (text === null) throw new Error("缺少“正在标注”文本");
    expect(elementText(text)).toBe("正在标注");
    expect((text.props as { "aria-hidden"?: boolean })["aria-hidden"]).toBe(true);
  });

  it("点击切换按钮触发 onToggle 回调", () => {
    const onToggle = vi.fn();
    const { props } = findToggle(renderToggle(true, onToggle));
    props.onClick?.();
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
