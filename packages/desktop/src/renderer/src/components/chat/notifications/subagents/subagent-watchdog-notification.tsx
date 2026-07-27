import ShieldAlert from "lucide-react/dist/esm/icons/shield-alert.mjs";
import type { PiNoticeMessage } from "../../../../../../shared/contracts.ts";
import { NotificationCard } from "../notification-card.tsx";
import { asRecord, notificationDetails, stringValue } from "../notification-data.ts";

export function SubagentWatchdogNotification({ notice }: { notice: PiNoticeMessage }) {
  const details = asRecord(notificationDetails(notice));
  const severity = stringValue(details, "severity");
  return (
    <NotificationCard
      notice={notice}
      title="子代理监视器"
      icon={<ShieldAlert />}
      tone={severity === "blocker" ? "error" : "warning"}
    >
      <p className="builtin-notification-message">{stringValue(details, "summary") ?? notice.title}</p>
      {stringValue(details, "evidence") ? (
        <p className="builtin-notification-detail">{stringValue(details, "evidence")}</p>
      ) : null}
      {stringValue(details, "recommendedAction") ? (
        <p className="builtin-notification-action">{stringValue(details, "recommendedAction")}</p>
      ) : null}
    </NotificationCard>
  );
}
