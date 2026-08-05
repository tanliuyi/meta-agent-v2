import { unstable_useTriggerPopoverScopeContext } from "@assistant-ui/react";
import { type RefObject, useLayoutEffect } from "react";
import { scrollSelectedSuggestion } from "./composer-suggestion-model.ts";

interface ComposerSuggestionScrollSyncProps {
  container: RefObject<HTMLDivElement | null>;
}

/** Keeps the keyboard-highlighted suggestion visible before the browser paints. */
export function ComposerSuggestionScrollSync({ container }: ComposerSuggestionScrollSyncProps) {
  const highlightedIndex = unstable_useTriggerPopoverScopeContext().highlightedIndex;
  useLayoutEffect(() => scrollSelectedSuggestion(container.current), [container, highlightedIndex]);
  return null;
}
