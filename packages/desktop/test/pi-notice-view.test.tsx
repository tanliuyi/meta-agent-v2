import { TooltipProvider } from "@renderer/shared/ui/tooltip-provider";
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

    expect(markup).not.toContain('data-slot="reasoning-root"');
    expect(markup).not.toContain("不应展示的压缩摘要");
  });

  it.each([
    ["info", "status", "polite", false],
    ["warning", "alert", "assertive", true],
    ["error", "alert", "assertive", true],
  ] as const)("notification type=%s 在消息流内使用对应语义", (notificationType, role, live, hasLabel) => {
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
    expect(markup.includes("<strong>")).toBe(hasLabel);
    expect(markup).not.toContain('data-slot="reasoning-root"');
  });

  it("结构化 Hermes Memory 通知使用 Desktop 统计卡片", () => {
    const markup = renderToStaticMarkup(
      <PiNoticeView
        data={{
          id: "memory-sync",
          kind: "notice",
          noticeType: "notification",
          notificationType: "info",
          extensionNotification: {
            customType: "hermes-memory.markdown-sync",
            details: {
              phase: "complete",
              filesScanned: 7,
              entriesScanned: 82,
              imported: 4,
              skipped: 78,
              removed: 0,
              projectCount: 3,
            },
          },
          title: "legacy TUI text",
          content: { type: "text", text: "legacy TUI text" },
        }}
      />,
    );

    expect(markup).toContain('class="builtin-notification-card"');
    expect(markup).toContain("Markdown 记忆同步完成");
    expect(markup).toContain("扫描文件");
    expect(markup).toContain(">7<");
    expect(markup).not.toContain("legacy TUI text");
  });

  it("Hermes Memory 扫描阶段不显示伪造的零统计", () => {
    const markup = renderToStaticMarkup(
      <PiNoticeView
        data={{
          id: "memory-scan",
          kind: "notice",
          noticeType: "notification",
          notificationType: "info",
          extensionNotification: {
            customType: "hermes-memory.session-index",
            details: { phase: "scan", totalFiles: 0, projectCount: 0 },
          },
          title: "Scanning",
          content: { type: "text", text: "Scanning" },
        }}
      />,
    );

    expect(markup).toContain("正在扫描会话目录");
    expect(markup).toContain("正在统计可索引的历史会话");
    expect(markup).not.toContain("会话文件");
  });

  it("结构化统计无效时回退到原始通知文本", () => {
    const markup = renderToStaticMarkup(
      <PiNoticeView
        data={{
          id: "memory-invalid",
          kind: "notice",
          noticeType: "notification",
          notificationType: "info",
          extensionNotification: {
            customType: "hermes-memory.markdown-sync",
            details: { phase: "complete" },
          },
          title: "同步结果不可用",
          content: { type: "text", text: "同步结果不可用" },
        }}
      />,
    );

    expect(markup).toContain("同步结果不可用");
    expect(markup).not.toContain("扫描文件");
  });

  it("watchdog blocker 使用错误卡片和 assertive alert 语义", () => {
    const markup = renderToStaticMarkup(
      <PiNoticeView
        data={{
          id: "watchdog",
          kind: "notice",
          noticeType: "custom",
          title: "subagent_watchdog_warning",
          content: {
            type: "custom",
            customType: "subagent_watchdog_warning",
            content: [{ type: "text", text: "fallback" }],
            details: {
              severity: "blocker",
              summary: "发现阻断问题",
              evidence: "类型检查失败",
              recommendedAction: "修复后重试",
            },
          },
        }}
      />,
    );

    expect(markup).toContain('data-tone="error"');
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('aria-live="assertive"');
    expect(markup).toContain("发现阻断问题");
  });

  it("Subagents 自定义消息使用专用卡片", () => {
    const markup = renderToStaticMarkup(
      <PiNoticeView
        data={{
          id: "subagent-result",
          kind: "notice",
          noticeType: "custom",
          title: "subagent-slash-result",
          content: {
            type: "custom",
            customType: "subagent-slash-result",
            content: [{ type: "text", text: "reviewer completed" }],
            details: { mode: "single" },
          },
        }}
      />,
    );

    expect(markup).toContain('class="builtin-notification-card"');
    expect(markup).toContain("子代理运行");
    expect(markup).toContain("reviewer completed");
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
    expect(markup).not.toContain("<pre");
  });

  it("notice 文本按 markdown 渲染", () => {
    const markup = renderToStaticMarkup(<StreamdownMarkdown>{"**重点**\n\n- 第一项\n- 第二项"}</StreamdownMarkdown>);

    expect(markup).toContain('data-streamdown="strong"');
    expect(markup).toContain('data-streamdown="unordered-list"');
    expect(markup).toContain('data-streamdown="list-item"');
  });

  it("代码围栏使用 Desktop 自定义 block，inline code 保持紧凑", () => {
    const markup = renderToStaticMarkup(
      <TooltipProvider>
        <StreamdownMarkdown>{"正文 `value`\n\n```tsx\nconst value = 1;\nreturn value;\n```"}</StreamdownMarkdown>
      </TooltipProvider>,
    );

    expect(markup).toContain('data-streamdown="code-block-header"');
    expect(markup).toContain('data-streamdown="code-block-actions"');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain("const value = 1;");
    expect(markup).toContain("return value;");
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
