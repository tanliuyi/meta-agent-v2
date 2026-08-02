import { memo } from "react";
import { Streamdown } from "streamdown";
import { preprocessMarkdownImages } from "../../../../../shared/markdown-image-contracts.ts";
import { STREAMDOWN_COMPONENTS } from "./streamdown-code.tsx";
import { LINK_SAFETY, SHIKI_THEMES, STREAMDOWN_PLUGINS } from "./streamdown-config.ts";

export const StreamdownMarkdown = memo(function StreamdownMarkdown({ children }: { children: string }) {
  return (
    <div className="aui-md text-sm/6">
      <Streamdown
        components={STREAMDOWN_COMPONENTS}
        linkSafety={LINK_SAFETY}
        mode="static"
        plugins={STREAMDOWN_PLUGINS}
        shikiTheme={SHIKI_THEMES}
      >
        {preprocessMarkdownImages(children)}
      </Streamdown>
    </div>
  );
});
