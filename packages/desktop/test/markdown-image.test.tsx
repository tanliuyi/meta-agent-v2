import { TooltipProvider } from "@renderer/shared/ui/tooltip-provider";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownImageReferenceProvider } from "../src/renderer/src/components/assistant-ui/streamdown/streamdown-image-reference.tsx";
import { StreamdownMarkdown } from "../src/renderer/src/components/assistant-ui/streamdown/streamdown-markdown.tsx";
import {
  markdownImageFilename,
  markdownImageReference,
  markdownImageSourceToUrl,
} from "../src/shared/markdown-image-contracts.ts";

describe("Markdown images", () => {
  it("通过 Desktop 图片协议加载本地绝对路径", () => {
    const source = "/Users/test/My Images/mecha.png";

    expect(markdownImageSourceToUrl(source)).toBe(
      "meta-agent-markdown-image://local/image?source=%2FUsers%2Ftest%2FMy%20Images%2Fmecha.png",
    );
  });

  it("通过 Desktop 图片协议加载网络图片，保留 data 图片 URL", () => {
    expect(markdownImageSourceToUrl("https://example.com/mecha.png")).toBe(
      "meta-agent-markdown-image://local/image?source=https%3A%2F%2Fexample.com%2Fmecha.png",
    );
    expect(markdownImageSourceToUrl("data:image/png;base64,AAAA")).toBe("data:image/png;base64,AAAA");
  });

  it("生成可发送给 Composer 的图片引用和下载文件名", () => {
    expect(markdownImageReference("/Users/test/My%20Images/mecha.png", "gundam-style-mecha")).toBe(
      "![gundam-style-mecha](</Users/test/My Images/mecha.png>)",
    );
    expect(markdownImageFilename("/Users/test/My%20Images/mecha.png", "gundam-style-mecha")).toBe("mecha.png");
  });

  it("在 Streamdown 中渲染响应式图片和完整操作", () => {
    const markup = renderToStaticMarkup(
      <TooltipProvider>
        <MarkdownImageReferenceProvider onReference={() => undefined}>
          <StreamdownMarkdown>{"![gundam-style-mecha](/Users/test/My Images/mecha.png)"}</StreamdownMarkdown>
        </MarkdownImageReferenceProvider>
      </TooltipProvider>,
    );

    expect(markup).toContain('class="markdown-image"');
    expect(markup).toContain(
      'src="meta-agent-markdown-image://local/image?source=%2FUsers%2Ftest%2FMy%20Images%2Fmecha.png"',
    );
    expect(markup).toContain('alt="gundam-style-mecha"');
    expect(markup).toContain('loading="lazy"');
    expect(markup).toContain('data-streamdown="image-actions"');
    expect(markup).toContain("预览图片");
    expect(markup).toContain("下载图片");
    expect(markup).toContain("引用图片");
  });
});
