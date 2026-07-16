import { useAuiState } from "@assistant-ui/react";
import { StreamdownTextPrimitive } from "@assistant-ui/react-streamdown";
import { cjk } from "@streamdown/cjk";
import { code } from "@streamdown/code";
import { math } from "@streamdown/math";
import { memo, useEffect, useMemo, useState } from "react";
import type { DiagramPlugin } from "streamdown";

const MERMAID_FENCE = /^(?:```|~~~)mermaid(?:\s|$)/m;
const SHIKI_THEMES: ["github-light", "github-dark"] = ["github-light", "github-dark"];

export const StreamdownText = memo(function StreamdownText() {
  const text = useAuiState((state) =>
    state.part.type === "text" || state.part.type === "reasoning" ? state.part.text : "",
  );
  const needsMermaid = MERMAID_FENCE.test(text);
  const [mermaid, setMermaid] = useState<DiagramPlugin>();
  useEffect(() => {
    if (!needsMermaid || mermaid) return;
    let active = true;
    void import("@streamdown/mermaid").then((module) => {
      if (active) setMermaid(module.mermaid);
    });
    return () => {
      active = false;
    };
  }, [mermaid, needsMermaid]);
  const plugins = useMemo(() => ({ code, math, cjk, ...(mermaid ? { mermaid } : {}) }), [mermaid]);
  return <StreamdownTextPrimitive containerClassName="aui-md" plugins={plugins} shikiTheme={SHIKI_THEMES} defer />;
});
