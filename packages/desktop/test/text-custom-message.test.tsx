import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PiNoticeView } from "../src/renderer/src/components/chat/pi-notice-view.tsx";

describe("text custom message", () => {
  it("uses Terminal Block without interpreting the custom type", () => {
    const markup = renderToStaticMarkup(
      <PiNoticeView
        data={{
          id: "custom-text-1",
          kind: "notice",
          noticeType: "custom",
          title: "用户扩展消息",
          content: {
            type: "custom",
            customType: "arbitrary-extension-output",
            content: [{ type: "text", text: "Runtime: idle\n\n- Config: ok" }],
          },
        }}
      />,
    );

    expect(markup).toContain('data-slot="terminal-block"');
    expect(markup).toContain("用户扩展消息");
    expect(markup).toContain("Runtime: idle");
    expect(markup).toContain("Config: ok");
    expect(markup).not.toContain("/arbitrary-extension-output");
    expect(markup).not.toContain('data-slot="reasoning-root"');
  });

  it("falls back to the generic custom notice for image content", () => {
    const markup = renderToStaticMarkup(
      <PiNoticeView
        data={{
          id: "custom-image-1",
          kind: "notice",
          noticeType: "custom",
          title: "图片消息",
          content: {
            type: "custom",
            customType: "arbitrary-image-output",
            content: [{ type: "image", data: "abc", mimeType: "image/png" }],
          },
        }}
      />,
    );

    expect(markup).toContain('data-slot="reasoning-root"');
    expect(markup).not.toContain('data-slot="terminal-block"');
  });
});
