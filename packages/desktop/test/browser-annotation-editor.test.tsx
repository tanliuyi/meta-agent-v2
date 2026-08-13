import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { BrowserAnnotationMarker } from "../src/renderer/src/components/panel/browser/browser-annotation-marker.tsx";
import {
  browserAnnotationMessageIdsByTab,
  emitBrowserAnnotationConsumed,
  emitBrowserAnnotationToComposer,
  invalidateBrowserAnnotationQuotes,
  subscribeBrowserAnnotationToComposer,
} from "../src/renderer/src/state/browser-composer-bridge.ts";
import type { BrowserAnnotation } from "../src/shared/browser-contracts.ts";

const annotation: BrowserAnnotation = {
  id: "annotation-1",
  tabId: 1,
  selector: "#main",
  tag: "div",
  bounds: { x: 10, y: 20, width: 100, height: 40 },
  text: "把按钮改成蓝色",
};

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

function hasClassName(element: ReactElement, className: string): boolean {
  return ((element.props as { className?: string }).className ?? "").split(" ").includes(className);
}

function elementType(element: ReactElement): string {
  const type = element.type;
  return typeof type === "string" ? type : String(type);
}

function renderMarker(onEdit = vi.fn(), onRemove = vi.fn()): ReactElement {
  return BrowserAnnotationMarker({ annotation, index: 0, onEdit, onRemove });
}

function findButton(tree: ReactNode, ariaLabel: string): ReactElement {
  const button = findElement(tree, (candidate) => {
    return (candidate.props as { "aria-label"?: string })["aria-label"] === ariaLabel;
  });
  if (button === null) throw new Error(`缺少按钮 ${ariaLabel}`);
  return button;
}

describe("BrowserAnnotationMarker", () => {
  it("编辑入口是语义 button（type=button、aria-label），键盘可聚焦；徽标与文本在其内部", () => {
    const tree = renderMarker();
    const edit = findButton(tree, "编辑标注 1");
    expect(elementType(edit)).toBe("button");
    expect((edit.props as { type?: string }).type).toBe("button");
    const badge = findElement(edit, (candidate) => hasClassName(candidate, "browser-annotation-badge"));
    if (badge === null) throw new Error("缺少序号徽标");
    const text = findElement(edit, (candidate) => hasClassName(candidate, "browser-annotation-text"));
    if (text === null) throw new Error("缺少标注文本");
    // 编辑按钮内部不得再嵌套任何按钮（删除入口是同级兄弟）。
    expect(findElement(getChildren(edit), (candidate) => elementType(candidate) === "button")).toBeNull();
  });

  it("删除按钮是 marker 内与编辑按钮同级的按钮，不嵌套在编辑按钮内", () => {
    const tree = renderMarker();
    const deleteButton = findButton(tree, "删除标注 1");
    expect(elementType(deleteButton)).not.toBe("div");
    const marker = findElement(tree, (candidate) => hasClassName(candidate, "browser-annotation-marker"));
    if (marker === null) throw new Error("缺少 marker 容器");
    // marker 容器直接子元素中同时存在编辑 hitbox 与删除 slot，二者是兄弟关系。
    const directChildren = Children.toArray(getChildren(marker));
    const hasEditHitbox = directChildren.some((child) =>
      isValidElement(child) ? hasClassName(child as ReactElement, "browser-annotation-edit-hitbox") : false,
    );
    const hasDeleteSlot = directChildren.some((child) =>
      isValidElement(child) ? hasClassName(child as ReactElement, "browser-annotation-remove-slot") : false,
    );
    expect(hasEditHitbox).toBe(true);
    expect(hasDeleteSlot).toBe(true);
  });

  it("点击编辑按钮触发 onEdit，点击删除按钮触发 onRemove 并阻止冒泡", () => {
    const onEdit = vi.fn();
    const onRemove = vi.fn();
    const tree = renderMarker(onEdit, onRemove);
    const edit = findButton(tree, "编辑标注 1");
    (edit.props as { onClick?: () => void }).onClick?.();
    expect(onEdit).toHaveBeenCalledTimes(1);

    const deleteButton = findButton(tree, "删除标注 1");
    const stopPropagation = vi.fn();
    (deleteButton.props as { onClick?: (event: { stopPropagation: () => void }) => void }).onClick?.({
      stopPropagation,
    });
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(onEdit).toHaveBeenCalledTimes(1);
  });
});

describe("browser annotation quote 登记与 URL 失效契约", () => {
  const targetKey = "session:editor-contract";

  it("保存时登记 messageId -> (tabId, 创建 URL)，composer 已挂载也登记定位", () => {
    const targetKey = "session:contract-direct";
    const handler = vi.fn();
    const unsubscribe = subscribeBrowserAnnotationToComposer(targetKey, handler);

    emitBrowserAnnotationToComposer({
      targetKey,
      tabId: 7,
      text: "标注内容",
      messageId: "browser-annotation:direct-1",
      tags: ["浏览器标注"],
      creationPageUrl: "https://example.com/",
    });

    // 直连分发到订阅者，且定位表同步登记（后续 URL 切换才能找到该引用）。
    expect(handler).toHaveBeenCalledWith({
      type: "add",
      payload: expect.objectContaining({
        messageId: "browser-annotation:direct-1",
        tabId: 7,
        creationPageUrl: "https://example.com/",
      }),
    });
    expect(browserAnnotationMessageIdsByTab(targetKey, 7)).toEqual(["browser-annotation:direct-1"]);
    expect(browserAnnotationMessageIdsByTab(targetKey, 8)).toEqual([]);
    // 创建 URL 已登记：当前 URL 与创建 URL 同规范化相等时不清理。
    handler.mockClear();
    invalidateBrowserAnnotationQuotes(targetKey, 7, "https://example.com");
    expect(handler).not.toHaveBeenCalled();
    expect(browserAnnotationMessageIdsByTab(targetKey, 7)).toEqual(["browser-annotation:direct-1"]);

    unsubscribe();
  });

  it("URL 规范化相等（创建 https://example.com/ 与当前 https://example.com）不误删 composer 引用", () => {
    const targetKey = "session:contract-equal";
    const handler = vi.fn();
    const unsubscribe = subscribeBrowserAnnotationToComposer(targetKey, handler);
    emitBrowserAnnotationToComposer({
      targetKey,
      tabId: 7,
      text: "标注内容",
      messageId: "browser-annotation:url-1",
      tags: ["浏览器标注"],
      creationPageUrl: "https://example.com/",
    });
    handler.mockClear();

    invalidateBrowserAnnotationQuotes(targetKey, 7, "https://example.com");

    expect(browserAnnotationMessageIdsByTab(targetKey, 7)).toEqual(["browser-annotation:url-1"]);
    expect(handler).not.toHaveBeenCalled();

    unsubscribe();
  });

  it("面板重挂（无 previousUrl 快照）时 current URL 不同仍清该 tab 引用，其他 tab 不受影响", () => {
    const targetKey = "session:contract-switch";
    const handler = vi.fn();
    const unsubscribe = subscribeBrowserAnnotationToComposer(targetKey, handler);
    emitBrowserAnnotationToComposer({
      targetKey,
      tabId: 7,
      text: "旧页面标注",
      messageId: "browser-annotation:url-2",
      tags: ["浏览器标注"],
      creationPageUrl: "https://example.com/",
    });
    emitBrowserAnnotationToComposer({
      targetKey,
      tabId: 9,
      text: "另一 tab 标注",
      messageId: "browser-annotation:url-3",
      tags: ["浏览器标注"],
      creationPageUrl: "https://example.com/",
    });
    handler.mockClear();

    // 面板隐藏期间 Agent 后台导航到新页面；重挂后首次 URL 同步即失效。
    invalidateBrowserAnnotationQuotes(targetKey, 7, "https://example.com/other");

    expect(handler.mock.calls.map(([event]) => event)).toEqual([
      { type: "remove", messageId: "browser-annotation:url-2" },
    ]);
    expect(browserAnnotationMessageIdsByTab(targetKey, 7)).toEqual([]);
    expect(browserAnnotationMessageIdsByTab(targetKey, 9)).toEqual(["browser-annotation:url-3"]);

    unsubscribe();
  });

  it("消费（发送成功）后遗忘映射，防止按 tab 定位泄漏", () => {
    const targetKey = "session:contract-consume";
    const unsubscribe = subscribeBrowserAnnotationToComposer(targetKey, vi.fn());
    emitBrowserAnnotationToComposer({
      targetKey,
      tabId: 7,
      text: "已发送标注",
      messageId: "browser-annotation:consumed-1",
      tags: ["浏览器标注"],
      creationPageUrl: "https://example.com/",
    });
    expect(browserAnnotationMessageIdsByTab(targetKey, 7)).toEqual(["browser-annotation:consumed-1"]);

    emitBrowserAnnotationConsumed({ targetKey, messageIds: ["browser-annotation:consumed-1"] });

    expect(browserAnnotationMessageIdsByTab(targetKey, 7)).toEqual([]);

    unsubscribe();
  });
});
