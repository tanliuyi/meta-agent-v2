import { useAuiState } from "@assistant-ui/react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { ReasoningContent } from "../../assistant-ui/reasoning/reasoning-content.tsx";
import { ReasoningRoot } from "../../assistant-ui/reasoning/reasoning-root.tsx";
import { ReasoningText } from "../../assistant-ui/reasoning/reasoning-text.tsx";
import { ReasoningTrigger } from "../../assistant-ui/reasoning/reasoning-trigger.tsx";
import { summarizeChainOfThought } from "../message-part-grouping.ts";

export function ChainOfThoughtGroup({
  indices,
  running,
  hasFollowingText,
  children,
}: {
  indices: readonly number[];
  running: boolean;
  hasFollowingText: boolean;
  children: ReactNode;
}) {
  const label = useAuiState((state) => summarizeChainOfThought(state.message.parts, indices));
  const [wasRunning, setWasRunning] = useState(running);

  useEffect(() => {
    if (running) setWasRunning(true);
  }, [running]);

  return (
    <ReasoningRoot variant="ghost" autoOpen={wasRunning && !hasFollowingText} streaming={running}>
      <ReasoningTrigger label={label} active={running} />
      <ReasoningContent className="text-foreground" aria-busy={running}>
        <ReasoningText>{children}</ReasoningText>
      </ReasoningContent>
    </ReasoningRoot>
  );
}
