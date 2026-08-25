import { unstable_useTriggerPopoverScopeContext } from "@assistant-ui/react";
import { useEffect } from "react";

interface ComposerTriggerStateProps {
  onStateChange(state: ComposerTriggerStateSnapshot): void;
}

export interface ComposerTriggerStateSnapshot {
  open: boolean;
  hasItems: boolean;
}

/** Publishes an official trigger's state to the composer keyboard boundary. */
export function ComposerTriggerState({ onStateChange }: ComposerTriggerStateProps) {
  const { open, items } = unstable_useTriggerPopoverScopeContext();
  const hasItems = items.length > 0;
  useEffect(() => onStateChange({ open, hasItems }), [hasItems, onStateChange, open]);
  return null;
}
