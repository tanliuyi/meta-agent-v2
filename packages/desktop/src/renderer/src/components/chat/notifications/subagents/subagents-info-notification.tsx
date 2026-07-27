import type { PiNoticeMessage } from "../../../../../../shared/contracts.ts";
import { SubagentStatusNotification } from "./subagent-status-notification.tsx";

export function SubagentsInfoNotification({ notice }: { notice: PiNoticeMessage }) {
  return <SubagentStatusNotification notice={notice} customType="subagents.info" />;
}
