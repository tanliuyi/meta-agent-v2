import React, { type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { UserMessageAttachments } from "../src/renderer/src/components/assistant-ui/attachment/user-message-attachments.tsx";

vi.mock("@assistant-ui/react", () => ({
  MessagePrimitive: {
    Attachments: ({ children }: { children: () => ReactNode }) => <>{children()}</>,
  },
}));

vi.mock("../src/renderer/src/components/assistant-ui/attachment/attachment-ui.tsx", () => ({
  AttachmentUI: () => <span>attachment</span>,
}));

describe("UserMessageAttachments", () => {
  it("头像模式下左对齐、保留身份栏间距并允许换行", () => {
    const html = renderToStaticMarkup(<UserMessageAttachments align="start" />);

    expect(html).toContain("justify-start");
    expect(html).toContain("mt-2");
    expect(html).toContain("flex-wrap");
    expect(html).not.toContain("justify-end");
  });

  it("非头像模式下保持右对齐", () => {
    const html = renderToStaticMarkup(<UserMessageAttachments align="end" />);

    expect(html).toContain("justify-end");
    expect(html).not.toContain("justify-start");
    expect(html).not.toContain("mt-2");
  });
});
