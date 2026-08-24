import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  MessageNavigation,
  sampleMessageNavigationIndexes,
} from "../src/renderer/src/components/chat/message-navigation.tsx";

describe("message navigation sampling", () => {
  it("短会话保留每个 turn", () => {
    expect(sampleMessageNavigationIndexes(5, 10, 3)).toEqual([0, 1, 2, 3, 4]);
  });

  it("长会话限制节点数并保留首尾与当前 turn", () => {
    const indexes = sampleMessageNavigationIndexes(1_000, 80, 537);

    expect(indexes).toHaveLength(80);
    expect(indexes[0]).toBe(0);
    expect(indexes.at(-1)).toBe(999);
    expect(indexes).toContain(537);
    expect(new Set(indexes).size).toBe(indexes.length);
    expect(indexes).toEqual([...indexes].sort((left, right) => left - right));
  });

  it("长会话只渲染视口可容纳的导航节点", () => {
    const html = renderToStaticMarkup(
      createElement(MessageNavigation, {
        scrollerRef: { current: null },
        turnCount: 1_000,
        virtualItems: [{ index: 537, start: 0, end: 200 }] as never,
        getMessageIds: () => [],
        onSelect: () => undefined,
      }),
    );

    expect(html.match(/data-index=/g)).toHaveLength(83);
    expect(html).toContain('data-index="537"');
  });

  it("校正越界 current index", () => {
    expect(sampleMessageNavigationIndexes(100, 8, 1_000)).toContain(99);
    expect(sampleMessageNavigationIndexes(100, 8, -10)).toContain(0);
  });
});
