import type { ReactNode } from "react";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { HostRequest } from "../src/shared/contracts.ts";

vi.mock("@renderer/shared/ui/dialog", () => ({
  Dialog: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));

vi.mock("@renderer/shared/ui/dialog-content", () => ({
  DialogContent: ({
    children,
    className,
    closeButtonClassName,
  }: {
    children?: ReactNode;
    className?: string;
    closeButtonClassName?: string;
  }) => (
    <div data-class-name={className} data-close-button-class-name={closeButtonClassName}>
      {children}
    </div>
  ),
}));

vi.mock("@renderer/shared/ui/dialog-description", () => ({
  DialogDescription: ({ children }: { children?: ReactNode }) => <p>{children}</p>,
}));

vi.mock("@renderer/shared/ui/dialog-title", () => ({
  DialogTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
}));

import { HostRequestDialog } from "../src/renderer/src/components/chat/host-request-dialog.tsx";
import { HostRequestField } from "../src/renderer/src/components/chat/host-request-field.tsx";

const selectRequest: HostRequest = {
  id: "select-environment",
  type: "select",
  title: "选择环境",
  options: ["dev", "prod"],
  createdAt: 1,
};

describe("Host request components", () => {
  it("questionnaire shows only one Type something input without note fields", () => {
    const markup = renderToStaticMarkup(
      <HostRequestDialog
        request={{
          id: "questionnaire",
          type: "questionnaire",
          title: "需求",
          createdAt: 1,
          questionnaire: {
            questions: [
              {
                header: "需求",
                question: "请选择需求",
                options: [
                  { label: "技术任务", description: "实现功能" },
                  { label: "界面需求", description: "调整界面" },
                ],
              },
            ],
          },
        }}
        projectId="project"
        threadId="thread"
      />,
    );

    expect(markup.match(/<input\b/g)).toHaveLength(1);
    expect(markup).toContain('placeholder="Type something."');
    expect(markup).not.toContain("<textarea");
    expect(markup).not.toContain("备注");
  });
  it("select 请求使用带方向键契约和受控选中态的垂直 RadioGroup", () => {
    const markup = renderToStaticMarkup(
      <HostRequestField request={selectRequest} value="prod" onChange={() => undefined} />,
    );

    expect(markup).toContain('role="radiogroup"');
    expect(markup).toContain('aria-orientation="vertical"');
    expect(markup.match(/role="radio"/g)).toHaveLength(2);
    expect(markup.match(/aria-checked="true"/g)).toHaveLength(1);
    expect(markup).toContain('data-state="checked"');
    expect(markup.match(/data-radix-collection-item=""/g)).toHaveLength(2);
  });

  it("阻塞请求作为 Composer surface 内联渲染", () => {
    const markup = renderToStaticMarkup(
      <HostRequestDialog request={selectRequest} projectId="project" threadId="thread" />,
    );

    expect(markup).toContain('aria-label="扩展询问"');
    expect(markup).toContain("composer-surface");
    expect(markup).not.toContain("data-close-button-class-name");
  });

  it("长工具调用 ID 在标题行内截断并保留完整值供悬停查看", () => {
    const toolCallId = "CALL_808PXWHYBYCYWIO2S2MMS7X7IFC_079BFC02BEF2F8FA016A758E4CFA0C819B84EA";
    const markup = renderToStaticMarkup(
      <HostRequestDialog
        request={{ ...selectRequest, type: "confirm", title: "访问站点", toolCallId }}
        projectId="project"
        threadId="thread"
      />,
    );

    expect(markup).toContain('class="flex min-w-0 items-baseline gap-1 text-[11px] font-medium text-muted-foreground"');
    expect(markup).toContain('class="min-w-0 truncate font-mono"');
    expect(markup).toContain(`title="${toolCallId}"`);
  });
});
