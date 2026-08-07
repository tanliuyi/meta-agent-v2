/**
 * browser-host-controller 中快照树的纯函数测试：AX 简化、可交互编号、
 * ignored 提升、可见性过滤、名称截断与节点预算截断。
 */

import { describe, expect, test } from "vitest";
import {
  buildNode,
  type CdpAxNode,
  collapseChildren,
  collectInteractive,
  type InteractiveElement,
} from "../src/main/browser/browser-host-controller.ts";
import type { BrowserSnapshotNode } from "../src/shared/browser-contracts.ts";

const EMPTY_DOM = new Map<string, { tag: string; attrs: BrowserSnapshotNode["attrs"] }>();

function node(id: string, partial: Partial<CdpAxNode> & { role?: string; name?: string }): CdpAxNode {
  return {
    nodeId: id,
    ignored: false,
    ...partial,
    role: { value: partial.role ?? "generic" },
    name: { value: partial.name ?? "" },
  };
}

function childrenOf(nodes: Record<string, CdpAxNode>): Map<string, CdpAxNode> {
  return new Map(Object.entries(nodes));
}

describe("collectInteractive", () => {
  test("只收集可交互且可见（有尺寸）的节点", () => {
    const nodes = [
      node("1", { role: "button", name: "点我", boundingBox: { x: 0, y: 0, width: 10, height: 5 } }),
      node("2", { role: "button", name: "不可见", boundingBox: { x: 0, y: 0, width: 0, height: 0 } }),
      node("3", { role: "heading", name: "标题" }),
      node("4", { role: "link", name: "链接", boundingBox: { x: 1, y: 1, width: 10, height: 5 } }),
      node("5", { role: "button", name: "忽略节点", ignored: true }),
    ];
    const collected = collectInteractive(nodes);
    expect(collected.map((item) => item.nodeId)).toEqual(["1", "4"]);
  });

  test("提供视口时，中心点不在视口内的元素不收集", () => {
    const viewport = { width: 800, height: 600 };
    const nodes = [
      node("1", { role: "button", name: "视口内", boundingBox: { x: 100, y: 100, width: 50, height: 20 } }),
      node("2", { role: "button", name: "下方离屏", boundingBox: { x: 100, y: 1000, width: 50, height: 20 } }),
      node("3", { role: "button", name: "右侧离屏", boundingBox: { x: 2000, y: 100, width: 50, height: 20 } }),
      node("4", { role: "button", name: "上方离屏", boundingBox: { x: 100, y: -50, width: 50, height: 20 } }),
      node("5", {
        role: "button",
        name: "部分在视口内（中心在视口内）",
        boundingBox: { x: 750, y: 580, width: 100, height: 40 },
      }),
      node("6", {
        role: "button",
        name: "部分在视口内（中心在视口外）",
        boundingBox: { x: 790, y: 590, width: 100, height: 40 },
      }),
    ];
    const collected = collectInteractive(nodes, viewport);
    expect(collected.map((item) => item.nodeId)).toEqual(["1", "5"]);
  });

  test("无视口尺寸时退化为仅尺寸检查", () => {
    const viewport = { width: 0, height: 0 };
    const nodes = [
      node("1", { role: "button", name: "任意位置", boundingBox: { x: 9000, y: 9000, width: 10, height: 5 } }),
    ];
    expect(collectInteractive(nodes, viewport).map((item) => item.nodeId)).toEqual(["1"]);
  });
});

describe("buildNode 简化树", () => {
  test("可交互元素按遍历顺序全局编号，中心取 boundingBox 中点", () => {
    const root = node("root", { role: "root" });
    const button1 = node("b1", { role: "button", name: "保存", boundingBox: { x: 10, y: 20, width: 100, height: 30 } });
    const link = node("l1", { role: "link", name: "帮助", boundingBox: { x: 5, y: 5, width: 40, height: 20 } });
    const textbox = node("t1", {
      role: "textbox",
      name: "搜索",
      value: { value: "abc" },
      boundingBox: { x: 0, y: 0, width: 200, height: 25 },
    });
    root.childIds = ["b1", "l1", "t1"];

    const counter = { value: 0 };
    const interactive = new Map<number, InteractiveElement>();
    const built = buildNode(
      root,
      childrenOf({ root, b1: button1, l1: link, t1: textbox }),
      EMPTY_DOM,
      counter,
      interactive,
      {
        value: 200,
      },
    );

    expect(built?.children?.map((child) => child.index)).toEqual([1, 2, 3]);
    expect(interactive.get(1)).toEqual({ index: 1, center: { x: 60, y: 35 } });
    expect(built?.children?.[0]).toMatchObject({ role: "button", name: "保存", center: { x: 60, y: 35 } });
    expect(built?.children?.[2]).toMatchObject({ value: "abc" });
  });

  test("提供视口时，中心点在视口外的可交互元素不编号", () => {
    const root = node("root", { role: "root" });
    const onScreen = node("b1", {
      role: "button",
      name: "可见",
      boundingBox: { x: 10, y: 10, width: 50, height: 20 },
    });
    const offScreen = node("b2", {
      role: "button",
      name: "离屏",
      boundingBox: { x: 10, y: 5000, width: 50, height: 20 },
    });
    root.childIds = ["b1", "b2"];

    const counter = { value: 0 };
    const interactive = new Map<number, InteractiveElement>();
    const built = buildNode(
      root,
      childrenOf({ root, b1: onScreen, b2: offScreen }),
      EMPTY_DOM,
      counter,
      interactive,
      { value: 200 },
      { width: 800, height: 600 },
    );

    expect(built?.children?.map((child) => child.index)).toEqual([1, undefined]);
    expect(built?.children?.[0]).toMatchObject({ role: "button", name: "可见" });
    expect(built?.children?.[1]).toMatchObject({ role: "button", name: "离屏" });
    expect(built?.children?.[1].index).toBeUndefined();
    expect(interactive.size).toBe(1);
  });

  test("交互元素带稳定选择器（来自 DOM 描述），非交互元素不带", () => {
    const root = node("root", { role: "root" });
    const button = node("b1", {
      role: "button",
      name: "保存",
      boundingBox: { x: 0, y: 0, width: 50, height: 20 },
    });
    const heading = node("h1", { role: "heading", name: "标题" });
    root.childIds = ["b1", "h1"];
    const dom = new Map([
      ["b1", { tag: "button", attrs: {}, selector: "#save-btn" }],
      ["h1", { tag: "h1", attrs: {} }],
    ]);

    const counter = { value: 0 };
    const built = buildNode(root, childrenOf({ root, b1: button, h1: heading }), dom, counter, new Map(), {
      value: 200,
    });

    expect(built?.children?.[0]).toMatchObject({ index: 1, selector: "#save-btn" });
    expect(built?.children?.[1]?.selector).toBeUndefined();
  });

  test("ignored 节点自身不输出，单子节点直接提升", () => {
    const ignored = node("ig", { ignored: true });
    const button = node("b1", { role: "button", name: "提升的按钮", boundingBox: { x: 0, y: 0, width: 5, height: 5 } });
    ignored.childIds = ["b1"];

    const counter = { value: 0 };
    const interactive = new Map<number, InteractiveElement>();
    const built = buildNode(ignored, childrenOf({ ig: ignored, b1: button }), EMPTY_DOM, counter, interactive, {
      value: 200,
    });

    expect(built).toMatchObject({ role: "button", index: 1 });
  });

  test("名称与值超过 120 字符时截断", () => {
    const longName = "x".repeat(200);
    const button = node("b1", { role: "button", name: longName, boundingBox: { x: 0, y: 0, width: 5, height: 5 } });

    const counter = { value: 0 };
    const built = buildNode(button, childrenOf({ b1: button }), EMPTY_DOM, counter, new Map(), { value: 200 });

    expect(built?.name.length).toBe(121); // 120 字符 + 省略号
    expect(built?.name.endsWith("…")).toBe(true);
  });

  test("节点预算耗尽后停止输出（maxSnapshotNodes 上限）", () => {
    const root = node("root", { role: "root" });
    const nodes: Record<string, CdpAxNode> = { root };
    root.childIds = [];
    for (let index = 0; index < 10; index += 1) {
      const id = `n${index}`;
      nodes[id] = node(id, { role: "button", name: `按钮${index}`, boundingBox: { x: 0, y: 0, width: 5, height: 5 } });
      root.childIds.push(id);
    }

    const counter = { value: 0 };
    const interactive = new Map<number, InteractiveElement>();
    const built = buildNode(root, childrenOf(nodes), EMPTY_DOM, counter, interactive, { value: 4 });

    // 预算含 root 自身：root(1) + 3 个按钮。
    expect(built?.children?.length).toBe(3);
    expect(counter.value).toBe(3);
    expect(interactive.size).toBe(3);
  });
});

describe("collapseChildren", () => {
  test("无子节点返回 null；单子节点提升；多子节点合并为 generic 容器", () => {
    const ignored = node("ig", { ignored: true });

    const counter = { value: 0 };
    const empty = collapseChildren(ignored, childrenOf({ ig: ignored }), EMPTY_DOM, counter, new Map(), {
      value: 200,
    });
    expect(empty).toBeNull();

    const child = node("c1", { role: "button", name: "唯一子", boundingBox: { x: 0, y: 0, width: 5, height: 5 } });
    ignored.childIds = ["c1"];
    const single = collapseChildren(ignored, childrenOf({ ig: ignored, c1: child }), EMPTY_DOM, counter, new Map(), {
      value: 200,
    });
    expect(single).toMatchObject({ role: "button" });

    const child2 = node("c2", { role: "link", name: "子二" });
    ignored.childIds = ["c1", "c2"];
    const multi = collapseChildren(
      ignored,
      childrenOf({ ig: ignored, c1: child, c2: child2 }),
      EMPTY_DOM,
      counter,
      new Map(),
      {
        value: 200,
      },
    );
    expect(multi).toMatchObject({ role: "generic" });
    expect(multi?.children?.length).toBe(2);
  });
});
