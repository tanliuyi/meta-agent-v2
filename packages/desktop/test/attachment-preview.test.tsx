import { TooltipProvider } from "@renderer/shared/ui/tooltip-provider";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AttachmentPreview } from "../src/renderer/src/components/assistant-ui/attachment/attachment-preview.tsx";

describe("AttachmentPreview", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("使用成熟预览组件包装原图触发元素且不预先渲染 portal", () => {
    vi.stubGlobal("window", { desktop: { platform: "darwin" } });

    const markup = renderToStaticMarkup(
      <TooltipProvider>
        <AttachmentPreview src="data:image/png;base64,AAAA">
          <button type="button">预览图片</button>
        </AttachmentPreview>
      </TooltipProvider>,
    );

    expect(markup).toContain("预览图片");
    expect(markup).toContain("aui-image-preview-trigger");
    expect(markup).toContain('tabindex="-1"');
    expect(markup).not.toContain("rc-image-preview-mask");
  });
});
