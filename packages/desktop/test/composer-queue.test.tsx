import {
  type AssistantRuntime,
  AssistantRuntimeProvider,
  type ExportedMessageRepository,
  type ExternalThreadQueueAdapter,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ComposerQueue } from "../src/renderer/src/components/chat/composer-queue.tsx";
import type { PiQueueItem } from "../src/shared/contracts.ts";

describe("ComposerQueue", () => {
  it("空队列不占用 Composer 上方空间", () => {
    expect(renderQueue()).toBe("");
  });

  it("按 Pi queue 顺序展示引导和排队消息", () => {
    const markup = renderQueue([
      { id: "steer", mode: "steer", prompt: "立即检查当前实现", source: "desktop" },
      { id: "follow-up", mode: "followUp", prompt: "完成后补充测试", source: "desktop" },
    ]);

    expect(markup).toContain('aria-label="待处理消息"');
    expect(markup).toContain('data-queue-mode="steer"');
    expect(markup).toContain('data-queue-mode="followUp"');
    expect(markup).toContain("引导");
    expect(markup).toContain("排队");
    expect(markup).toContain('class="composer-queue-count">2</span>');
    expect(markup.indexOf("立即检查当前实现")).toBeLessThan(markup.indexOf("完成后补充测试"));
    expect(markup).toContain('aria-label="清空待处理消息"');
    expect(markup).toContain("text-[11px]");
    expect(markup).toContain("size-[11px]");
    expect(markup).not.toContain("text-sm");
    expect(markup).not.toContain("size-3.5");
  });
});

function renderQueue(queue: readonly PiQueueItem[] = []): string {
  const adapter: ExternalThreadQueueAdapter = {
    items: queue.map(({ id, prompt }) => ({ id, prompt })),
    enqueue: vi.fn(),
    steer: vi.fn(),
    remove: vi.fn(),
    clear: vi.fn(),
  };
  let runtime: AssistantRuntime | undefined;
  function RuntimeProbe() {
    runtime = useExternalStoreRuntime({
      messageRepository: emptyRepository(),
      isRunning: queue.length > 0,
      onNew: async () => undefined,
      queue: adapter,
    });
    return runtime ? (
      <AssistantRuntimeProvider runtime={runtime}>
        <ComposerQueue items={queue} disabled={false} onClear={vi.fn()} onError={vi.fn()} />
      </AssistantRuntimeProvider>
    ) : null;
  }
  return renderToStaticMarkup(<RuntimeProbe />);
}

function emptyRepository(): ExportedMessageRepository {
  return { headId: null, messages: [] };
}
