import { useSessionControlSelector, useSessionTimelineSelector } from "../session-context.tsx";
import { ThreadActivityIndicator } from "./thread-activity-indicator.tsx";

/** Session activity state belongs to the record control store, not window selection. */
export function SessionThreadActivity() {
  const retry = useSessionControlSelector((control) => control?.retry);
  const lastError = useSessionControlSelector((control) => control?.lastError);
  const phase = useSessionTimelineSelector((timeline) => timeline.phase);
  return <ThreadActivityIndicator phase={phase} retry={retry} lastError={lastError} />;
}
