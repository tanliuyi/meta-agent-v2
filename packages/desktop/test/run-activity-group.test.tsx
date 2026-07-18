import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RunActivityGroup } from "../src/renderer/src/components/chat/message/assistant-message.tsx";

describe("RunActivityGroup", () => {
  it("run 进行中强制展开并禁用折叠入口", () => {
    const markup = renderToStaticMarkup(
      <RunActivityGroup running>
        <span>step content</span>
      </RunActivityGroup>,
    );

    expect(markup).toContain('data-state="open"');
    expect(markup).toContain('disabled=""');
    expect(markup).toContain("正在处理");
    expect(markup).toContain("aui-run-activity-root");
    expect(markup).toContain("aui-run-activity-trigger");
    expect(markup).toContain("aui-run-activity-content");
    expect(markup).toContain("aui-run-activity-body");
    expect(markup).not.toContain('data-slot="reasoning-fade"');
    expect(markup).toContain("step content");
  });

  it("run 结束后默认折叠并启用折叠入口", () => {
    const markup = renderToStaticMarkup(
      <RunActivityGroup running={false}>
        <span>step content</span>
      </RunActivityGroup>,
    );

    expect(markup).toContain('data-state="closed"');
    expect(markup).not.toContain('disabled=""');
    expect(markup).toContain("已处理");
    expect(markup).not.toContain('data-slot="reasoning-fade"');
    expect(markup).not.toContain("step content");
  });
});
