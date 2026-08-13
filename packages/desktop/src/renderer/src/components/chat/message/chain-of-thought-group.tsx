import { useAuiState } from "@assistant-ui/react";
import type { ReactNode } from "react";
import { useLayoutEffect, useRef, useState } from "react";
import { ReasoningContent } from "../../assistant-ui/reasoning/reasoning-content.tsx";
import { ReasoningRoot } from "../../assistant-ui/reasoning/reasoning-root.tsx";
import { ReasoningText } from "../../assistant-ui/reasoning/reasoning-text.tsx";
import { ReasoningTrigger } from "../../assistant-ui/reasoning/reasoning-trigger.tsx";
import { useSessionModalContext } from "../../session-modal-context.ts";
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

  // 会话 modal 内默认不展开（autoOpen/autoExpand 均关闭）；手动展开由 stateKey 记忆，不受影响。
  const inModal = useSessionModalContext();

  return (
    <ReasoningRoot
      variant="ghost"
      autoOpen={inModal ? false : effectiveWasRunning && !hasFollowingText}
      autoExpand={inModal ? false : autoExpandRunning}
      streaming={running}
      stateKey={stateKey}
    >
      <ReasoningTrigger label={label} active={running} />
      <ReasoningContent className="text-foreground/90" aria-busy={running}>
        <ReasoningText key={stateKey}>{children}</ReasoningText>
      </ReasoningContent>
    </ReasoningRoot>
  );
}
