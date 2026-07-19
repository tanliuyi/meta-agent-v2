import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StreamdownMarkdown } from "../src/renderer/src/components/assistant-ui/streamdown/streamdown-markdown.tsx";
import { PiNoticeView } from "../src/renderer/src/components/chat/pi-notice-view.tsx";

describe("PiNoticeView", () => {
  it("压缩完成后仅显示完成提示", () => {
    const markup = renderToStaticMarkup(
      <PiNoticeView
        data={{
          id: "compaction-1",
          kind: "notice",
          noticeType: "compaction",
          title: "上下文压缩",
          content: { type: "text", text: "不应展示的压缩摘要" },
        }}
      />,
    );

    expect(markup).toContain("上下文已压缩");
    expect(markup).toContain('class="pi-compaction-notice"');
    expect(markup).not.toContain('data-slot="reasoning-root"');
    expect(markup).not.toContain("不应展示的压缩摘要");
  });

  it.each([
    ["info", "status", "polite", "普通消息", false],
    ["warning", "status", "polite", "警告：", true],
    ["error", "alert", "assertive", "错误：", true],
  ] as const)("notification type=%s 在消息流内使用对应语义", (notificationType, role, live, text, hasLabel) => {
    const markup = renderToStaticMarkup(
      <PiNoticeView
        data={{
          id: `notification-${notificationType}`,
          kind: "notice",
          noticeType: "notification",
          notificationType,
          title: "普通消息",
          content: { type: "text", text: "普通消息" },
        }}
      />,
    );

    expect(markup).toContain('data-notice-type="notification"');
    expect(markup).toContain(`data-tone="${notificationType}"`);
    expect(markup).toContain(`role="${role}"`);
    expect(markup).toContain(`aria-live="${live}"`);
    expect(markup).toContain(text);
    expect(markup.includes("<strong>")).toBe(hasLabel);
    expect(markup).not.toContain('data-slot="reasoning-root"');
  });

  it("其他 notice 使用默认折叠的 reasoning group", () => {
    const markup = renderToStaticMarkup(
      <PiNoticeView
        data={{
          id: "branch-1",
          kind: "notice",
          noticeType: "branch-summary",
          title: "分支摘要",
          content: { type: "text", text: "**保留的分支摘要**" },
        }}
      />,
    );

    expect(markup).toContain('data-slot="reasoning-root"');
    expect(markup).toContain('data-notice-type="branch-summary"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain("分支摘要");
    expect(markup).not.toContain("<pre");
  });

  it("notice 文本按 markdown 渲染", () => {
    const markup = renderToStaticMarkup(<StreamdownMarkdown>{"**重点**\n\n- 第一项\n- 第二项"}</StreamdownMarkdown>);

    expect(markup).toContain('data-streamdown="strong">重点</span>');
    expect(markup).toContain('data-streamdown="unordered-list"');
    expect(markup).toContain('data-streamdown="list-item">第一项</li>');
  });

  it("忽略缺少通知类型语义的 notification", () => {
    const markup = renderToStaticMarkup(
      <PiNoticeView
        data={{
          id: "notification-invalid",
          kind: "notice",
          noticeType: "notification",
          title: "无类型通知",
          content: { type: "text", text: "无类型通知" },
        }}
      />,
    );

    expect(markup).toBe("");
  });

  it("忽略结构无效的 notice", () => {
    const markup = renderToStaticMarkup(
      <PiNoticeView
        data={{
          kind: "notice",
          noticeType: "custom",
          content: { type: "custom", content: { text: "invalid" } },
        }}
      />,
    );

    expect(markup).toBe("");
  });
});
