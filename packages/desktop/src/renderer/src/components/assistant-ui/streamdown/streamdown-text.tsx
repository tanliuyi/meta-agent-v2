import { StreamdownTextPrimitive } from "@assistant-ui/react-streamdown";
import { memo } from "react";
import { STREAMDOWN_COMPONENTS } from "./streamdown-code.tsx";
import { LINK_SAFETY, SHIKI_THEMES, STREAMDOWN_PLUGINS } from "./streamdown-config.ts";

export const StreamdownText = memo(function StreamdownText() {
  return (
    <StreamdownTextPrimitive
      components={STREAMDOWN_COMPONENTS}
      containerClassName="aui-md"
      linkSafety={LINK_SAFETY}
      plugins={STREAMDOWN_PLUGINS}
      shikiTheme={SHIKI_THEMES}
    />
  );
});
