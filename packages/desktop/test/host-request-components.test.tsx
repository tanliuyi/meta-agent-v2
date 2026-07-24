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

  it("阻塞式 Dialog 通过共享 prop 隐藏关闭按钮", () => {
    const markup = renderToStaticMarkup(
      <HostRequestDialog request={selectRequest} projectId="project" threadId="thread" />,
    );

    expect(markup).toContain('data-close-button-class-name="hidden"');
    expect(markup).toContain('data-class-name="gap-3 sm:max-w-lg"');
  });
});
