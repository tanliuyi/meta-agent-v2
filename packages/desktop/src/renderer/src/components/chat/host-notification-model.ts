import type { PiNoticeMessage } from "../../../../shared/contracts.ts";

type NotificationType = PiNoticeMessage["notificationType"];

interface HostNotificationSemantics {
  tone: NonNullable<NotificationType>;
  role: "status" | "alert";
  live: "polite" | "assertive";
}

const HOST_NOTIFICATION_SEMANTICS: Record<NonNullable<NotificationType>, HostNotificationSemantics> = {
  info: { tone: "info", role: "status", live: "polite" },
  warning: { tone: "warning", role: "alert", live: "assertive" },
  error: { tone: "error", role: "alert", live: "assertive" },
};

export function getHostNotificationSemantics(type: NotificationType): HostNotificationSemantics {
  return HOST_NOTIFICATION_SEMANTICS[type ?? "info"];
}
