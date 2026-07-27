import type { PiNoticeMessage } from "../../../../../../shared/contracts.ts";
import { SubagentResultNotification } from "./subagent-result-notification.tsx";

export function SubagentSlashResultNotification({ notice }: { notice: PiNoticeMessage }) {
  return <SubagentResultNotification notice={notice} />;
}
