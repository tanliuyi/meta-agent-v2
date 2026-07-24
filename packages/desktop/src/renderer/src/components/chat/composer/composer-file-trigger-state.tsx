import { unstable_useTriggerPopoverScopeContext } from "@assistant-ui/react";
import { useEffect } from "react";

interface ComposerFileTriggerStateProps {
  onOpenChange(open: boolean): void;
}

/** Publishes the official @ trigger state to the composer keyboard boundary. */
export function ComposerFileTriggerState({ onOpenChange }: ComposerFileTriggerStateProps) {
  const { open } = unstable_useTriggerPopoverScopeContext();
  useEffect(() => onOpenChange(open), [onOpenChange, open]);
  return null;
}
