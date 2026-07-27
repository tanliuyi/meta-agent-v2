import { unstable_useTriggerPopoverScopeContext } from "@assistant-ui/react";
import { type RefObject, useLayoutEffect } from "react";
import { scrollSelectedSuggestion } from "./composer-suggestion-model.ts";

interface ComposerCommandScrollSyncProps {
  container: RefObject<HTMLDivElement | null>;
}

/** Keeps the keyboard-highlighted command visible before the browser paints. */
export function ComposerCommandScrollSync({ container }: ComposerCommandScrollSyncProps) {
  const highlightedIndex = unstable_useTriggerPopoverScopeContext().highlightedIndex;
  useLayoutEffect(() => scrollSelectedSuggestion(container.current), [container, highlightedIndex]);
  return null;
}
