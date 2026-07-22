import { useSessionControl } from "../session-context.tsx";
import { ThreadActivityIndicator } from "./thread-activity-indicator.tsx";

/** Session activity state belongs to the record control store, not window selection. */
export function SessionThreadActivity() {
  const control = useSessionControl();
  return (
    <ThreadActivityIndicator
      retry={control?.retry}
      workingVisible={control?.extensionUi.workingVisible ?? false}
      workingMessage={control?.extensionUi.workingMessage}
      lastError={control?.lastError}
    />
  );
}
