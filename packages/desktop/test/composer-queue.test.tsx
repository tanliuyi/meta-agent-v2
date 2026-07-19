import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ComposerQueue } from "../src/renderer/src/components/chat/composer-queue.tsx";
import { piSessionBus } from "../src/renderer/src/runtime/pi-session-bus.ts";
import type { PiQueueItem } from "../src/shared/contracts.ts";
import { PROTOCOL_VERSION } from "../src/shared/contracts.ts";

describe("ComposerQueue", () => {
  beforeEach(() => setQueue([]));

  it("空队列不占用 Composer 上方空间", () => {
    expect(renderToStaticMarkup(<ComposerQueue onClear={vi.fn()} onError={vi.fn()} />)).toBe("");
  });

  it("按 Pi queue 顺序展示引导和排队消息", () => {
    setQueue([
      { id: "steer", mode: "steer", prompt: "立即检查当前实现", source: "desktop" },
      { id: "follow-up", mode: "followUp", prompt: "完成后补充测试", source: "desktop" },
    ]);

    const markup = renderToStaticMarkup(<ComposerQueue onClear={vi.fn()} onError={vi.fn()} />);

    expect(markup).toContain('aria-label="待处理消息"');
    expect(markup).toContain('data-queue-mode="steer"');
    expect(markup).toContain('data-queue-mode="followUp"');
    expect(markup).toContain("引导");
    expect(markup).toContain("排队");
    expect(markup).toContain('class="composer-queue-count">2</span>');
    expect(markup.indexOf("立即检查当前实现")).toBeLessThan(markup.indexOf("完成后补充测试"));
    expect(markup).toContain('aria-label="清空待处理消息"');
  });
});

function setQueue(queue: readonly PiQueueItem[]): void {
  piSessionBus.store.replace({
    protocolVersion: PROTOCOL_VERSION,
    projectId: "project",
    threadId: "thread",
    cursor: 0,
    headId: null,
    nodes: [],
    queue,
    phase: queue.length > 0 ? "running" : "idle",
  });
}
