import { TooltipProvider } from "@renderer/shared/ui/tooltip-provider";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StreamdownMarkdown } from "../src/renderer/src/components/assistant-ui/streamdown/streamdown-markdown.tsx";
import { getRegisteredNotificationRenderer } from "../src/renderer/src/components/chat/notifications/builtin-notification-view.tsx";
import { PiNoticeView } from "../src/renderer/src/components/chat/pi-notice-view.tsx";

describe("PiNoticeView", () => {
  it("仅将已注册的 customType 分发到 Desktop 自定义组件", () => {
    expect(
      getRegisteredNotificationRenderer({
        id: "checkpoint-1",
        kind: "notice",
        noticeType: "custom",
        title: "Checkpoint",
        content: { type: "custom", customType: "pi-rewind.checkpoint", content: [] },
      }),
    ).toBeDefined();
    expect(
      getRegisteredNotificationRenderer({
        id: "subagent-1",
        kind: "notice",
        noticeType: "custom",
        title: "Subagent",
        content: { type: "custom", customType: "subagent-notify", content: [] },
      }),
    ).toBeUndefined();
  });

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
    expect(markup).not.toContain('data-slot="reasoning-root"');
    expect(markup).not.toContain("不应展示的压缩摘要");
  });

  it.each([
    ["info", "status", "polite", false],
    ["warning", "alert", "assertive", true],
    ["error", "alert", "assertive", true],
  ] as const)("notification type=%s 使用对应无障碍语义", (notificationType, role, live, hasLabel) => {
    const markup = renderToStaticMarkup(
      <PiNoticeView
        data={{
          id: `notification-${notificationType}`,
          kind: "notice",
          noticeType: "notification",
          notificationType,
          title: "Pi 扩展通知",
          content: { type: "text", text: "通知内容" },
        }}
      />,
    );

    expect(markup).toContain('data-notice-type="notification"');
    expect(markup).toContain(`data-tone="${notificationType}"`);
    expect(markup).toContain(`role="${role}"`);
    expect(markup).toContain(`aria-live="${live}"`);
    expect(markup.includes("<strong>")).toBe(hasLabel);
    expect(markup).toContain("通知内容");
  });

  it("文本 custom notice 使用统一 TerminalBlock", () => {
    const markup = renderToStaticMarkup(
      <PiNoticeView
        data={{
          id: "custom-1",
          kind: "notice",
          noticeType: "custom",
          title: "用户扩展消息",
          content: {
            type: "custom",
            customType: "user-extension.event",
            content: [{ type: "text", text: "第一行\n\n第二行\r\n" }],
          },
        }}
      />,
    );

    expect(markup).toContain('data-slot="terminal-block"');
    expect(markup).toContain("用户扩展消息");
    expect(markup).toContain("已完成");
    expect(markup).toContain("第一行");
    expect(markup).toContain("第二行");
    expect(markup).toContain(" ");
    expect(markup).not.toContain('data-slot="reasoning-root"');
  });

  it("含图片的 custom notice 回退到通用折叠内容", () => {
    const markup = renderToStaticMarkup(
      <PiNoticeView
        data={{
          id: "custom-image",
          kind: "notice",
          noticeType: "custom",
          title: "图片消息",
          content: {
            type: "custom",
            customType: "user-extension.image",
            content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
          },
        }}
      />,
    );

    expect(markup).toContain('data-slot="reasoning-root"');
    expect(markup).not.toContain('data-slot="terminal-block"');
  });

  it("command notice 保持原有折叠视图", () => {
    const markup = renderToStaticMarkup(
      <PiNoticeView
        data={{
          id: "bash-1",
          kind: "notice",
          noticeType: "bash",
          title: "命令",
          content: {
            type: "command",
            command: "printf ok",
            output: "ok",
            exitCode: 0,
            cancelled: false,
            truncated: false,
          },
        }}
      />,
    );

    expect(markup).toContain('data-slot="reasoning-root"');
    expect(markup).toContain('data-notice-type="bash"');
    expect(markup).toContain("终端命令");
  });

  it("notice 文本按 markdown 渲染", () => {
    const markup = renderToStaticMarkup(<StreamdownMarkdown>{"**重点**\n\n- 第一项\n- 第二项"}</StreamdownMarkdown>);

    expect(markup).toContain('data-streamdown="strong"');
    expect(markup).toContain('data-streamdown="unordered-list"');
  });

  it("代码围栏使用 Desktop 自定义 block", () => {
    const markup = renderToStaticMarkup(
      <TooltipProvider>
        <StreamdownMarkdown>{"正文 `value`\n\n```tsx\nconst value = 1;\n```"}</StreamdownMarkdown>
      </TooltipProvider>,
    );

    expect(markup).toContain('data-streamdown="code-block-header"');
    expect(markup).toContain("const value = 1;");
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
      <PiNoticeView data={{ kind: "notice", noticeType: "custom", content: { type: "custom", content: {} } }} />,
    );

    expect(markup).toBe("");
  });
});
