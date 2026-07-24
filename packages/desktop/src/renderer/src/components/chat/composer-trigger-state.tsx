import { unstable_useTriggerPopoverScopeContext } from "@assistant-ui/react";
import { useEffect } from "react";

interface ComposerTriggerStateProps {
  onOpenChange(open: boolean): void;
}

/** Publishes an official trigger's state to the composer keyboard boundary. */
export function ComposerTriggerState({ onOpenChange }: ComposerTriggerStateProps) {
  const { open } = unstable_useTriggerPopoverScopeContext();
  useEffect(() => onOpenChange(open), [onOpenChange, open]);
  return null;
}
