import { useAuiState } from "@assistant-ui/react";
import type { ReactNode } from "react";
import { useLayoutEffect, useRef, useState } from "react";
import { ReasoningContent } from "../../assistant-ui/reasoning/reasoning-content.tsx";
import { ReasoningRoot } from "../../assistant-ui/reasoning/reasoning-root.tsx";
import { ReasoningText } from "../../assistant-ui/reasoning/reasoning-text.tsx";
import { ReasoningTrigger } from "../../assistant-ui/reasoning/reasoning-trigger.tsx";
import { summarizeChainOfThought } from "../message-part-grouping.ts";

export function ChainOfThoughtGroup({
  indices,
  running,
  hasFollowingText,
  autoExpandRunning,
  stateKey,
  children,
}: {
  indices: readonly number[];
  running: boolean;
  hasFollowingText: boolean;
  autoExpandRunning: boolean;
  stateKey: string;
  children: ReactNode;
}) {
  const label = useAuiState((state) => summarizeChainOfThought(state.message.parts, indices));
  const [wasRunning, setWasRunning] = useState(running);
  const previousStateKeyRef = useRef(stateKey);
  const effectiveWasRunning = previousStateKeyRef.current === stateKey ? wasRunning : running;

  useLayoutEffect(() => {
    if (previousStateKeyRef.current !== stateKey) {
      previousStateKeyRef.current = stateKey;
      setWasRunning(running);
      return;
    }
    if (running) setWasRunning(true);
  }, [running, stateKey]);

  return (
    <ReasoningRoot
      variant="ghost"
      autoOpen={effectiveWasRunning && !hasFollowingText}
      autoExpand={autoExpandRunning}
      streaming={running}
      stateKey={stateKey}
    >
      <ReasoningTrigger label={label} active={running} />
      <ReasoningContent className="text-foreground" aria-busy={running}>
        <ReasoningText key={stateKey}>{children}</ReasoningText>
      </ReasoningContent>
    </ReasoningRoot>
  );
}
