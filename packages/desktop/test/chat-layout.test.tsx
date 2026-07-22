import { Outlet } from "@tanstack/react-router";
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { ChatLayout } from "../src/renderer/src/app/routes/_chat.tsx";

describe("ChatLayout", () => {
  it("在 leaf route outlet 外保留唯一 workspace 容器", () => {
    const workspace = findElement(ChatLayout(), (element) => hasClassName(element, "workspace"));

    expect(workspace?.type).toBe("section");
    expect(findElement(getChildren(workspace), (element) => element.type === Outlet)).not.toBeNull();
  });
});

function findElement(node: ReactNode, predicate: (element: ReactElement) => boolean): ReactElement | null {
  for (const child of Children.toArray(node)) {
    if (!isValidElement(child)) continue;
    if (predicate(child)) return child;
    const match = findElement(getChildren(child), predicate);
    if (match) return match;
  }
  return null;
}

function getChildren(element: ReactElement | null): ReactNode {
  return (element?.props as { children?: ReactNode } | undefined)?.children;
}

function hasClassName(element: ReactElement, className: string): boolean {
  return (element.props as { className?: string }).className === className;
}
