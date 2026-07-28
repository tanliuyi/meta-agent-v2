import GitBranch from "lucide-react/dist/esm/icons/git-branch.mjs";
import type { PiNoticeMessage } from "../../../../../../shared/contracts.ts";
import { NotificationCard } from "../notification-card.tsx";
import { parseSubagentNotification } from "./subagent-notification-data.ts";
import { SubagentResultItem } from "./subagent-result-item.tsx";

export function SubagentResultNotification({
  notice,
  title = "子代理运行",
}: {
  notice: PiNoticeMessage;
  title?: string;
}) {
  const summary = parseSubagentNotification(notice);
  return (
    <NotificationCard notice={notice} title={title} icon={<GitBranch />} tone={summary.tone} layout="subagent">
      <div className="builtin-subagent-results">
        {summary.items.map((item) => (
          <SubagentResultItem item={item} key={item.key} />
        ))}
      </div>
    </NotificationCard>
  );
}
