import { TooltipProvider } from "@renderer/shared/ui/tooltip-provider";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StreamdownMarkdown } from "../src/renderer/src/components/assistant-ui/streamdown/streamdown-markdown.tsx";
import { parseSubagentNotification } from "../src/renderer/src/components/chat/notifications/subagents/subagent-notification-data.ts";
import { PiNoticeView } from "../src/renderer/src/components/chat/pi-notice-view.tsx";
import type { PiNoticeMessage } from "../src/shared/contracts.ts";

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

  it("后台子代理完成通知将 acceptance JSON 收敛为结构化摘要", () => {
    const markup = renderToStaticMarkup(
      <PiNoticeView
        data={{
          id: "subagent-complete",
          kind: "notice",
          noticeType: "notification",
          notificationType: "info",
          extensionNotification: {
            customType: "subagent-notify",
            details: {
              agent: "code-writer",
              status: "completed",
              durationMs: 12_000,
              resultPreview: [
                "```acceptance-report",
                JSON.stringify({
                  criteriaSatisfied: [
                    { id: "criterion-1", status: "satisfied", evidence: "类型检查通过" },
                    { id: "criterion-2", status: "satisfied", evidence: "回归测试通过" },
                  ],
                  changedFiles: ["src/a.ts", "src/b.ts"],
                  testsAddedOrUpdated: ["test/a.test.ts"],
                  commandsRun: [{ command: "npm run check", result: "passed", summary: "无错误" }],
                  residualRisks: ["需要人工确认视觉效果"],
                }),
                "```",
              ].join("\n"),
            },
          },
          title: "Background task completed",
          content: { type: "text", text: "不应直接显示的回退文本" },
        }}
      />,
    );

    expect(markup).toContain("code-writer");
    expect(markup).toContain("验收通过 · 2 项标准 · 2 个文件 · 1 项验证 · 1 项风险");
    expect(markup).toContain("12s");
    expect(markup).toContain("builtin-subagent-result-row");
    expect(markup).not.toContain("acceptance-report");
    expect(markup).not.toContain("criteriaSatisfied");
    expect(markup).not.toContain("changedFiles");
    expect(markup).not.toContain("不应直接显示的回退文本");
  });

  it("Hermes Memory 概述保留仅存在于通知正文的记忆条目", () => {
    const markup = renderToStaticMarkup(
      <PiNoticeView
        data={{
          id: "memory-insights-body",
          kind: "notice",
          noticeType: "notification",
          notificationType: "info",
          extensionNotification: {
            customType: "hermes-memory.insights",
            details: { memoryCount: 1, userCount: 0, projectCount: 0, projectName: "desktop" },
          },
          title: "Memory Insights",
          content: { type: "text", text: "MEMORY\n1. 保留这条持久记忆" },
        }}
      />,
    );

    expect(markup).toContain("当前持久记忆概览");
    expect(markup).toContain("保留这条持久记忆");
    expect(markup).toContain("builtin-notification-body");
  });

  it("验收报告展示扩展字段并将 not-applicable 呈现为中性状态", () => {
    const notice = {
      id: "acceptance-full",
      kind: "notice",
      noticeType: "notification",
      notificationType: "info",
      extensionNotification: {
        customType: "subagent-notify",
        details: {
          agent: "reviewer",
          status: "completed",
          resultPreview: JSON.stringify({
            criteria_satisfied: [{ id: "visual", status: "not-applicable", evidence: "本次没有视觉改动" }],
            validation_output: ["typecheck passed"],
            no_staged_files: true,
            diff_summary: "只读审查",
            review_findings: ["no blockers"],
            manual_notes: "无需后续操作",
          }),
        },
      },
      title: "complete",
      content: { type: "text", text: "complete" },
    } satisfies PiNoticeMessage;
    const markup = renderToStaticMarkup(<PiNoticeView data={notice} />);
    const report = parseSubagentNotification(notice).items[0]?.report;

    expect(markup).toContain("验收通过 · 1 项标准 · 1 项发现");
    expect(report).toMatchObject({
      satisfied: true,
      criteria: [{ id: "visual", status: "not-applicable", evidence: "本次没有视觉改动" }],
      validationOutput: ["typecheck passed"],
      noStagedFiles: true,
      diffSummary: "只读审查",
      reviewFindings: ["no blockers"],
      manualNotes: "无需后续操作",
    });
  });

  it("普通 JSON 子代理输出不会被当作验收报告收起", () => {
    const notice = {
      id: "subagent-json",
      kind: "notice",
      noticeType: "notification",
      notificationType: "info",
      extensionNotification: {
        customType: "subagent-notify",
        details: {
          agent: "researcher",
          status: "completed",
          resultPreview: '```json\n{"items":["a","b"]}\n```',
        },
      },
      title: "complete",
      content: { type: "text", text: "complete" },
    } satisfies PiNoticeMessage;
    const item = parseSubagentNotification(notice).items[0];

    expect(item?.markdown).toContain('"items"');
    expect(item?.markdown).toContain('"a"');
    expect(item?.summary).not.toBe("结构化结果已收起");
    expect(item?.report).toBeUndefined();
  });

  it("带有验收字段名的普通 JSON 仍保持原始输出", () => {
    const notice = {
      id: "subagent-json-overlap",
      kind: "notice",
      noticeType: "notification",
      notificationType: "info",
      extensionNotification: {
        customType: "subagent-notify",
        details: {
          agent: "researcher",
          status: "completed",
          resultPreview: '```json\n{"changedFiles":["migration.ts"],"notes":"migration notes"}\n```',
        },
      },
      title: "complete",
      content: { type: "text", text: "complete" },
    } satisfies PiNoticeMessage;
    const item = parseSubagentNotification(notice).items[0];

    expect(item?.markdown).toContain("migration.ts");
    expect(item?.markdown).toContain("migration notes");
    expect(item?.report).toBeUndefined();
  });

  it("验收报告兼容 main parser 的单对象、字符串列表和状态别名", () => {
    const notice = {
      id: "subagent-acceptance-aliases",
      kind: "notice",
      noticeType: "notification",
      notificationType: "info",
      extensionNotification: {
        customType: "subagent-notify",
        details: {
          agent: "reviewer",
          status: "completed",
          resultPreview: [
            "```acceptance-report",
            JSON.stringify({
              criteriaSatisfied: { id: "check", status: "passed", evidence: "validated" },
              changedFiles: "src/a.ts",
              commandsRun: { command: "npm run check", result: "ok", summary: "passed" },
            }),
            "```",
          ].join("\n"),
        },
      },
      title: "complete",
      content: { type: "text", text: "complete" },
    } satisfies PiNoticeMessage;
    const report = parseSubagentNotification(notice).items[0]?.report;

    expect(report).toMatchObject({
      satisfied: true,
      criteria: [{ id: "check", status: "satisfied", evidence: "validated" }],
      changedFiles: ["src/a.ts"],
      commands: [{ command: "npm run check", result: "passed", summary: "passed" }],
    });
  });

  it("main 会拒绝的验收结构保持原始 JSON 且不显示通过", () => {
    const notice = {
      id: "subagent-invalid-acceptance",
      kind: "notice",
      noticeType: "notification",
      notificationType: "info",
      extensionNotification: {
        customType: "subagent-notify",
        details: {
          agent: "reviewer",
          status: "completed",
          resultPreview: [
            "```acceptance-report",
            JSON.stringify({
              criteriaSatisfied: [{ id: "check", status: "satisfied" }],
              commandsRun: [{ command: "npm run check", result: "passed" }],
            }),
            "```",
          ].join("\n"),
        },
      },
      title: "complete",
      content: { type: "text", text: "complete" },
    } satisfies PiNoticeMessage;
    const item = parseSubagentNotification(notice).items[0];

    expect(item?.report).toBeUndefined();
    expect(item?.markdown).toContain("criteriaSatisfied");
    expect(item?.summary).not.toContain("验收通过");
  });

  it("规范化后重复的验收 criterion ID 不会被显示为通过", () => {
    const notice = {
      id: "subagent-duplicate-criteria",
      kind: "notice",
      noticeType: "notification",
      notificationType: "info",
      extensionNotification: {
        customType: "subagent-notify",
        details: {
          agent: "reviewer",
          status: "completed",
          resultPreview: [
            "```acceptance-report",
            JSON.stringify({
              criteriaSatisfied: [
                { id: "criterion_1", status: "satisfied", evidence: "first" },
                { id: "criterion 1", status: "satisfied", evidence: "second" },
              ],
              changedFiles: [],
            }),
            "```",
          ].join("\n"),
        },
      },
      title: "complete",
      content: { type: "text", text: "complete" },
    } satisfies PiNoticeMessage;
    const item = parseSubagentNotification(notice).items[0];

    expect(item?.report).toBeUndefined();
    expect(item?.markdown).toContain("criterion_1");
    expect(item?.summary).not.toContain("验收通过");
  });

  it("记忆更新通知将来源收敛为自然语言状态", () => {
    const markup = renderToStaticMarkup(
      <PiNoticeView
        data={{
          id: "memory-updated",
          kind: "notice",
          noticeType: "notification",
          notificationType: "info",
          extensionNotification: {
            customType: "hermes-memory.updated",
            details: { source: "background-review" },
          },
          title: "legacy",
          content: { type: "text", text: "legacy" },
        }}
      />,
    );

    expect(markup).toContain("后台审查已更新持久记忆");
    expect(markup).not.toContain("builtin-notification-stats");
    expect(markup).not.toContain(">来源<");
  });

  it("Hermes Memory 概述按 details schema 展示统计", () => {
    const markup = renderToStaticMarkup(
      <PiNoticeView
        data={{
          id: "memory-insights",
          kind: "notice",
          noticeType: "notification",
          notificationType: "info",
          extensionNotification: {
            customType: "hermes-memory.insights",
            details: { memoryCount: 12, userCount: 3, projectCount: 8, projectName: "desktop" },
          },
          title: "legacy",
          content: { type: "text", text: '{"memoryCount":12}' },
        }}
      />,
    );

    expect(markup).toContain("当前持久记忆概览");
    expect(markup).toContain("个人记忆");
    expect(markup).toContain(">12<");
    expect(markup).toContain("当前项目：desktop");
    expect(markup).not.toContain("memoryCount");
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
