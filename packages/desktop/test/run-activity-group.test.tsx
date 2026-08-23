import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReasoningDisclosureStateProvider } from "../src/renderer/src/components/assistant-ui/reasoning/reasoning-disclosure-state.tsx";
import { RunActivityGroup } from "../src/renderer/src/components/chat/message/run-activity-group.tsx";
import { createSessionRecordStores } from "../src/renderer/src/runtime/pi-session-store.ts";

describe("RunActivityGroup", () => {
  it("run 进行中强制展开并禁用折叠入口", () => {
    const now = Date.now();
    const markup = renderToStaticMarkup(
      <RunActivityGroup running startedAt={now - 12_000} hasContent stateKey="run">
        <span>step content</span>
      </RunActivityGroup>,
    );

    expect(markup).toContain('data-state="open"');
    expect(markup).toContain('disabled=""');
    expect(markup).toContain("12s");
    expect(markup).toContain("step content");
  });

  it("run 进行中使用不补零的紧凑时分秒格式", () => {
    const now = Date.now();
    const markup = renderToStaticMarkup(
      <RunActivityGroup running startedAt={now - (3 * 3_600 + 4 * 60 + 5) * 1_000} hasContent stateKey="run">
        <span>step content</span>
      </RunActivityGroup>,
    );

    expect(markup).toContain("3h4m5s");
  });

  it("第 0s 时只渲染 running 标题", () => {
    const markup = renderToStaticMarkup(
      <RunActivityGroup running startedAt={Date.now() + 1_000} hasContent={false} stateKey="run">
        <>{null}</>
      </RunActivityGroup>,
    );

    expect(markup).not.toContain("0s");
  });

  it("隐藏后的历史 activity 不显示空折叠入口", () => {
    const markup = renderToStaticMarkup(
      <RunActivityGroup running={false} startedAt={Date.now()} hasContent={false} stateKey="run">
        <>{null}</>
      </RunActivityGroup>,
    );

    expect(markup).toContain('disabled=""');
  });

  it("resume 后按固定完成时间显示本次 run 耗时", () => {
    const startedAt = Date.now() - 10 * 60_000;
    const markup = renderToStaticMarkup(
      <RunActivityGroup
        running={false}
        startedAt={startedAt}
        completedAt={startedAt + (4 * 60 + 5) * 1_000}
        hasContent
        stateKey="run"
      >
        <span>step content</span>
      </RunActivityGroup>,
    );

    expect(markup).toContain("4m5s");
  });

  it("历史 run 默认折叠并隐藏中间过程，且不使用当前时间伪造处理耗时", () => {
    const now = Date.now();
    const markup = renderToStaticMarkup(
      <RunActivityGroup running={false} startedAt={now - (4 * 60 + 5) * 1_000} hasContent stateKey="run">
        <span>step content</span>
      </RunActivityGroup>,
    );

    expect(markup).toContain('data-state="closed"');
    expect(markup).not.toContain('disabled=""');
    expect(markup).not.toContain("04m 05s");
    expect(markup).not.toContain("step content");
  });

  it("历史 activity 收起时在折叠区外保留 notification", () => {
    const markup = renderToStaticMarkup(
      <RunActivityGroup
        running={false}
        startedAt={Date.now()}
        completedAt={Date.now()}
        hasContent
        stateKey="run"
        persistentContent={<span>TPS status</span>}
      >
        <span>step content</span>
      </RunActivityGroup>,
    );

    expect(markup).toContain('data-state="closed"');
    expect(markup).not.toContain("step content");
    expect(markup).toContain("TPS status");
  });

  it("activity 展开时只显示原位 notification，不渲染持久副本", () => {
    const markup = renderToStaticMarkup(
      <RunActivityGroup
        running={false}
        startedAt={Date.now()}
        completedAt={Date.now()}
        hasContent
        defaultOpenWhenComplete
        stateKey="run"
        persistentContent={<span>persistent TPS</span>}
      >
        <span>inline TPS</span>
      </RunActivityGroup>,
    );

    expect(markup).toContain("inline TPS");
    expect(markup).not.toContain("persistent TPS");
  });

  it("完成后配置为默认展开时保留折叠入口", () => {
    const markup = renderToStaticMarkup(
      <RunActivityGroup running={false} startedAt={Date.now()} hasContent defaultOpenWhenComplete stateKey="run">
        <span>step content</span>
      </RunActivityGroup>,
    );

    expect(markup).toContain('data-state="open"');
    expect(markup).not.toContain('disabled=""');
    expect(markup).toContain('data-slot="reasoning-trigger-chevron"');
    expect(markup).toContain("step content");
  });

  it("完成后默认展开时尊重历史收起状态", () => {
    const disclosure = createSessionRecordStores().disclosure;
    disclosure.set("message:run", false);
    const markup = renderToStaticMarkup(
      <ReasoningDisclosureStateProvider store={disclosure}>
        <RunActivityGroup
          running={false}
          startedAt={Date.now()}
          hasContent
          defaultOpenWhenComplete
          stateKey="message:run"
        >
          <span>step content</span>
        </RunActivityGroup>
      </ReasoningDisclosureStateProvider>,
    );

    expect(markup).toContain('data-state="closed"');
    expect(markup).not.toContain('disabled=""');
    expect(markup).not.toContain("step content");
  });

  it("虚拟行重新挂载时恢复历史 activity 展开状态", () => {
    const disclosure = createSessionRecordStores().disclosure;
    disclosure.set("message:run", true);
    const markup = renderToStaticMarkup(
      <ReasoningDisclosureStateProvider store={disclosure}>
        <RunActivityGroup
          running={false}
          startedAt={Date.now()}
          completedAt={Date.now()}
          hasContent
          stateKey="message:run"
        >
          <span>step content</span>
        </RunActivityGroup>
      </ReasoningDisclosureStateProvider>,
    );

    expect(markup).toContain('data-state="open"');
    expect(markup).toContain("step content");
  });
});
