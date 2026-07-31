import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReadOnlySessionStatus } from "../src/renderer/src/components/chat/session-read-only-status.tsx";

describe("ReadOnlySessionStatus", () => {
  it("运行时展示模型、provider、思考级别和只读状态", () => {
    const markup = renderToStaticMarkup(
      createElement(ReadOnlySessionStatus, {
        phase: "running",
        model: { provider: "openai", id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
        thinkingLevel: "high",
      }),
    );

    expect(markup).toContain("子智能体运行中");
    expect(markup).toContain("模型：GPT-5.6 Sol");
    expect(markup).toContain("(openai)");
    expect(markup).toContain("思考：高");
    expect(markup).toContain("此会话暂时只读");
    expect(markup).toContain('title="openai/gpt-5.6-sol"');
  });

  it("同步时隐藏尚未稳定的运行信息", () => {
    const markup = renderToStaticMarkup(
      createElement(ReadOnlySessionStatus, {
        phase: "idle",
        model: undefined,
        thinkingLevel: "off",
      }),
    );

    expect(markup).toContain("正在同步子智能体会话");
    expect(markup).toContain("请稍候");
    expect(markup).not.toContain("模型：");
    expect(markup).not.toContain("思考：");
  });

  it("重试时展示具体阶段且允许模型暂时缺失", () => {
    const markup = renderToStaticMarkup(
      createElement(ReadOnlySessionStatus, {
        phase: "retrying",
        model: undefined,
        thinkingLevel: "xhigh",
      }),
    );

    expect(markup).toContain("子智能体正在重试");
    expect(markup).toContain("思考：极高");
    expect(markup).not.toContain("模型：");
  });

  it("运行时展示停止按钮,同步时隐藏", () => {
    const running = renderToStaticMarkup(
      createElement(ReadOnlySessionStatus, {
        phase: "running",
        model: undefined,
        thinkingLevel: "off",
        onStop: () => undefined,
      }),
    );
    const syncing = renderToStaticMarkup(
      createElement(ReadOnlySessionStatus, {
        phase: "idle",
        model: undefined,
        thinkingLevel: "off",
        onStop: () => undefined,
      }),
    );
    const withoutHandler = renderToStaticMarkup(
      createElement(ReadOnlySessionStatus, {
        phase: "running",
        model: undefined,
        thinkingLevel: "off",
      }),
    );

    expect(running).toContain("停止运行");
    expect(syncing).not.toContain("停止运行");
    expect(withoutHandler).not.toContain("停止运行");
  });

  it("停止请求进行中时禁用停止按钮", () => {
    const markup = renderToStaticMarkup(
      createElement(ReadOnlySessionStatus, {
        phase: "running",
        model: undefined,
        thinkingLevel: "off",
        onStop: () => undefined,
        stopPending: true,
      }),
    );

    expect(markup).toContain("停止运行");
    expect(markup).toContain("disabled");
  });
});
