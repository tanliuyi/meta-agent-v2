import GitBranch from "lucide-react/dist/esm/icons/git-branch.mjs";
import type { PiNoticeMessage } from "../../../../../../shared/contracts.ts";
import { NotificationCard } from "../notification-card.tsx";
import { notificationText } from "../notification-data.ts";

export function SubagentResultNotification({ notice }: { notice: PiNoticeMessage }) {
  return (
    <NotificationCard notice={notice} title="子代理运行" icon={<GitBranch />}>
      <p className="builtin-notification-message">{notificationText(notice)}</p>
    </NotificationCard>
  );
}
