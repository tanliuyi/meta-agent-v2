import type { PiNoticeMessage } from "../../../../../../shared/contracts.ts";
import { SubagentStatusNotification } from "./subagent-status-notification.tsx";

export function SubagentsAdminNotification({ notice }: { notice: PiNoticeMessage }) {
  return <SubagentStatusNotification notice={notice} customType="subagents-admin" />;
}
