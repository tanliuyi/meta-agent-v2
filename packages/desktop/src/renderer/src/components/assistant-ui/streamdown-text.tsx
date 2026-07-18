import { StreamdownTextPrimitive } from "@assistant-ui/react-streamdown";
// import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { mermaid } from "@streamdown/mermaid";
import { memo } from "react";
import { Streamdown } from "streamdown";

const STREAMDOWN_PLUGINS = { code, math, mermaid } as const;
const SHIKI_THEMES: ["github-light", "github-dark"] = ["github-light", "github-dark"];

export const StreamdownText = memo(function StreamdownText() {
  return <StreamdownTextPrimitive containerClassName="aui-md" plugins={STREAMDOWN_PLUGINS} shikiTheme={SHIKI_THEMES} />;
});

export const StreamdownMarkdown = memo(function StreamdownMarkdown({ children }: { children: string }) {
  return (
    <div className="aui-md">
      <Streamdown mode="static" plugins={STREAMDOWN_PLUGINS} shikiTheme={SHIKI_THEMES}>
        {children}
      </Streamdown>
    </div>
  );
});
