import { memo } from "react";
import { type LinkSafetyConfig, Streamdown } from "streamdown";
import { preprocessMarkdownImages } from "../../../../../shared/markdown-image-contracts.ts";
import { STREAMDOWN_COMPONENTS } from "./streamdown-code.tsx";
import { LINK_SAFETY, SHIKI_THEMES, STREAMDOWN_PLUGINS } from "./streamdown-config.ts";

interface StreamdownMarkdownProps {
  children: string;
  linkSafety?: LinkSafetyConfig;
}

export const StreamdownMarkdown = memo(function StreamdownMarkdown({
  children,
  linkSafety = LINK_SAFETY,
}: StreamdownMarkdownProps) {
  return (
    <div className="aui-md text-sm/6">
      <Streamdown
        components={STREAMDOWN_COMPONENTS}
        linkSafety={linkSafety}
        mode="static"
        plugins={STREAMDOWN_PLUGINS}
        shikiTheme={SHIKI_THEMES}
      >
        {preprocessMarkdownImages(children)}
      </Streamdown>
    </div>
  );
});
