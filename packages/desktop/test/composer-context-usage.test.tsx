import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  resolveComposerContextUsage,
  selectLiveContextTokens,
} from "../src/renderer/src/components/chat/composer/composer-context-model.ts";
import { ComposerContextUsage } from "../src/renderer/src/components/chat/composer/composer-context-usage.tsx";
import { type PiAssistantUsage, type PiThreadSnapshot, PROTOCOL_VERSION } from "../src/shared/contracts.ts";

describe("composer context model", () => {
  it("uses live Pi message usage while the thread is running", () => {
    const timeline = runningTimeline({
      input: 120,
      output: 30,
      cacheRead: 850,
      cacheWrite: 0,
      totalTokens: 1_000,
    });

    expect(selectLiveContextTokens(timeline)).toBe(1_000);
    expect(
      resolveComposerContextUsage(
        { tokens: 800, contextWindow: 200_000, percent: 0.4 },
        selectLiveContextTokens(timeline),
      ),
    ).toEqual({ tokens: 1_000, contextWindow: 200_000, percent: 0.5 });
  });

  it("falls back to authoritative stats outside a live run", () => {
    const authoritative = { tokens: null, contextWindow: 200_000, percent: null };
    const timeline = { ...runningTimeline(), phase: "idle" as const };

    expect(selectLiveContextTokens(timeline)).toBeUndefined();
    expect(resolveComposerContextUsage(authoritative, selectLiveContextTokens(timeline))).toBe(authoritative);
  });
});

function runningTimeline(
  usage: Partial<Pick<PiAssistantUsage, "input" | "output" | "cacheRead" | "cacheWrite" | "totalTokens">> = {},
): PiThreadSnapshot {
  const input = usage.input ?? 0;
  const output = usage.output ?? 0;
  const cacheRead = usage.cacheRead ?? 0;
  const cacheWrite = usage.cacheWrite ?? 0;
  return {
    protocolVersion: PROTOCOL_VERSION,
    projectId: "project",
    threadId: "thread",
    cursor: 1,
    headId: "assistant",
    queue: [],
    phase: "running",
    thinkingLevel: "off",
    nodes: [
      {
        id: "assistant",
        parentId: null,
        createdAt: 1,
        kind: "assistant",
        content: [],
        status: { type: "running" },
        provenance: { api: "test", provider: "test", model: "test" },
        usage: {
          input,
          output,
          cacheRead,
          cacheWrite,
          totalTokens: usage.totalTokens ?? input + output + cacheRead + cacheWrite,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      },
    ],
  };
}

describe("ComposerContextUsage", () => {
  it("没有 usage 数据时不渲染", () => {
    const markup = renderToStaticMarkup(createElement(ComposerContextUsage, { usage: undefined }));

    expect(markup).toBe("");
  });

  it("展示已用 tokens 与上下文窗口", () => {
    const markup = renderToStaticMarkup(
      createElement(ComposerContextUsage, {
        usage: { tokens: 42300, contextWindow: 200000, percent: 21.15 },
      }),
    );

    expect(markup).toContain("上下文使用量");
    expect(markup).toContain("21%");
    expect(markup).toContain("42k / 200k");
    expect(markup).not.toContain("text-destructive");
  });

  it("接近限制时红色警告", () => {
    const markup = renderToStaticMarkup(
      createElement(ComposerContextUsage, {
        usage: { tokens: 182000, contextWindow: 200000, percent: 91 },
      }),
    );

    expect(markup).toContain("91%");
    expect(markup).toContain("text-destructive");
  });

  it("压缩后 tokens 未知时显示未知状态", () => {
    const markup = renderToStaticMarkup(
      createElement(ComposerContextUsage, {
        usage: { tokens: null, contextWindow: 200000, percent: null },
      }),
    );

    expect(markup).toContain("?");
    expect(markup).toContain("未知");
    expect(markup).not.toContain("text-destructive");
  });
});
