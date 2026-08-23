import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ComposerWidgets } from "../src/renderer/src/components/chat/composer/composer-widgets.tsx";

const PREFIX = "PI_SUBAGENT_ASYNC_JSON:";
const CAPS = {
  maxRuns: 20,
  maxChildrenPerNode: 8,
  maxDepth: 3,
  maxStringLength: 160,
  maxSerializedBytes: 32 * 1024,
};

describe("ComposerWidgets", () => {
  it("按公开版本化 schema 投影到通用 structured widget", () => {
    const payload = {
      kind: "pi-subagents.async-status-snapshot",
      version: 1,
      generatedAt: 110_000,
      caps: CAPS,
      omitted: { runs: 0, children: 0, byteLimitExceeded: false },
      runs: [
        {
          id: "workflow-1",
          kind: "workflow",
          label: "reviewer, reviewer, reviewer",
          state: "running",
          startedAt: 0,
          activity: { lastActivityAt: 110_000, toolCount: 0 },
          children: [child("step-1", 30, 5), child("step-2", 32, 6), child("step-3", 32, 5)],
        },
      ],
    };

    const markup = renderWidgetPayload(payload);

    expect(markup).toContain('class="composer-structured-widget"');
    expect(markup).toContain("composer-structured-widget-heading");
    expect(markup).toContain("composer-structured-widget-identity");
    expect(markup).toContain("composer-structured-widget-state");
    expect(markup).toContain("lucide-loader-circle");
    expect(markup).toContain("animate-spin");
    expect(markup).toContain("composer-structured-widget-metadata");
    expect(markup).toContain("Async agents");
    expect(markup).toContain("1 agent running");
    expect(markup).toContain("reviewer ×3");
    expect(markup).toContain("steps 3");
    expect(markup).toContain("94 tools");
    expect(markup).toContain("1m50s");
    expect(markup).toContain("active now");
    expect(markup).toContain("16 turns");
    expect(markup.match(/94 tools/g)).toHaveLength(1);
    expect(markup).not.toContain("composer-async-widget");
    expect(markup).not.toContain(PREFIX);
  });

  it("未知或畸形 schema 回退为通用文本 widget", () => {
    const line = `${PREFIX}{"kind":"pi-subagents.async-status-snapshot","version":2}`;
    const markup = renderToStaticMarkup(
      <ComposerWidgets widgets={[{ key: "future", lines: [line], placement: "belowEditor" }]} />,
    );

    expect(markup).toContain('class="composer-widget-content"');
    expect(markup).toContain('data-widget-key="future"');
    expect(markup).toContain(PREFIX);
    expect(markup).not.toContain("composer-structured-widget");
  });

  it("拒绝超出声明数量、深度、字符串和字节 caps 的 structured payload", () => {
    const baseNode = {
      id: "run",
      kind: "subagent",
      label: "reviewer",
      state: "running",
    };
    const payloads = [
      snapshot({ maxRuns: 1 }, [baseNode, { ...baseNode, id: "run-2" }]),
      snapshot({ maxChildrenPerNode: 1 }, [{ ...baseNode, children: [child("one", 1, 1), child("two", 1, 1)] }]),
      snapshot({ maxDepth: 1 }, [
        {
          ...baseNode,
          children: [{ ...child("one", 1, 1), children: [child("two", 1, 1)] }],
        },
      ]),
      snapshot({ maxStringLength: 3 }, [baseNode]),
      snapshot({ maxSerializedBytes: 256 }, [{ ...baseNode, label: "x".repeat(160) }]),
    ];

    for (const payload of payloads) expectStructuredFallback(payload);
  });

  it("拒绝高于 Desktop 支持上限的 caps", () => {
    expectStructuredFallback(snapshot({ maxRuns: CAPS.maxRuns + 1 }, []));
    expectStructuredFallback(snapshot({ maxSerializedBytes: CAPS.maxSerializedBytes + 1 }, []));
  });

  it("保留普通 setWidget 的多行文本语义", () => {
    const markup = renderToStaticMarkup(
      <ComposerWidgets
        widgets={[
          {
            key: "plain",
            lines: ["第一行", "  第二行", "第三行"],
            placement: "aboveEditor",
          },
        ]}
      />,
    );

    expect(markup).toContain('data-layout="embedded"');
    expect(markup).toContain("第一行\n  第二行\n第三行</pre>");
  });

  it("独立渲染多个插件的普通 widget", () => {
    const markup = renderToStaticMarkup(
      <ComposerWidgets
        widgets={[
          { key: "one", lines: ["one"], placement: "aboveEditor" },
          { key: "two", lines: ["two"], placement: "aboveEditor" },
        ]}
      />,
    );

    expect(markup.match(/class="composer-widget-content"/g)).toHaveLength(2);
    expect(markup).toContain('data-widget-key="one"');
    expect(markup).toContain('data-widget-key="two"');
  });

  it("为 Composer 外部的 widget 标记独立布局", () => {
    const markup = renderToStaticMarkup(
      <ComposerWidgets layout="external" widgets={[{ key: "above", lines: ["状态"], placement: "aboveEditor" }]} />,
    );

    expect(markup).toContain('class="composer-widgets"');
    expect(markup).toContain('data-layout="external"');
  });

  it("没有 widget 时不渲染容器", () => {
    expect(renderToStaticMarkup(<ComposerWidgets widgets={[]} />)).toBe("");
  });

  it("通用运行状态复用现有圆形 loading 动画", () => {
    const markup = renderWidgetPayload(snapshot({}, [child("reviewer", 1, 1)]));

    expect(markup).toContain("lucide-loader-circle");
    expect(markup).toContain("animate-spin");
    expect(markup.indexOf("reviewer")).toBeLessThan(markup.lastIndexOf("lucide-loader-circle"));
    expect(markup.lastIndexOf("lucide-loader-circle")).toBeLessThan(markup.lastIndexOf("running"));
  });
});

function renderWidgetPayload(payload: object): string {
  return renderToStaticMarkup(
    <ComposerWidgets
      widgets={[
        {
          key: "structured",
          lines: [`${PREFIX}${JSON.stringify(payload)}`],
          placement: "aboveEditor",
        },
      ]}
    />,
  );
}

function expectStructuredFallback(payload: object): void {
  const markup = renderWidgetPayload(payload);
  expect(markup).toContain('class="composer-widget-content"');
  expect(markup).not.toContain('class="composer-structured-widget"');
}

function snapshot(caps: Partial<typeof CAPS>, runs: object[]) {
  return {
    kind: "pi-subagents.async-status-snapshot",
    version: 1,
    generatedAt: 110_000,
    caps: { ...CAPS, ...caps },
    omitted: { runs: 0, children: 0, byteLimitExceeded: false },
    runs,
  };
}

function child(id: string, toolCount: number, turnCount: number) {
  return {
    id,
    kind: "step",
    label: id,
    state: "running",
    activity: { lastActivityAt: 110_000, toolCount, turnCount },
  };
}
