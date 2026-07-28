import type { PiNoticeMessage } from "../../../../../../shared/contracts.ts";
import { SubagentResultNotification } from "./subagent-result-notification.tsx";

export function SubagentCompletionNotification({ notice }: { notice: PiNoticeMessage }) {
  return <SubagentResultNotification notice={notice} title="后台子代理完成" />;
}
