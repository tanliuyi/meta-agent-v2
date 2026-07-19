import { useDesktopSelector } from "../../state/desktop-context.tsx";
import {
  selectActiveLastError,
  selectActiveRetry,
  selectActiveWorkingMessage,
  selectActiveWorkingVisible,
} from "../../state/desktop-selectors.ts";
import { ThreadActivityIndicator } from "./thread-activity-indicator.tsx";

/** 仅让 activity 区域订阅 retry/working/error 叶子状态。 */
export function SessionThreadActivity() {
  const retry = useDesktopSelector(selectActiveRetry);
  const workingVisible = useDesktopSelector(selectActiveWorkingVisible);
  const workingMessage = useDesktopSelector(selectActiveWorkingMessage);
  const lastError = useDesktopSelector(selectActiveLastError);
  return (
    <ThreadActivityIndicator
      retry={retry}
      workingVisible={workingVisible}
      workingMessage={workingMessage}
      lastError={lastError}
    />
  );
}
