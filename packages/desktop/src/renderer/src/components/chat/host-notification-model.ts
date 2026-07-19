import type { HostRequest } from "../../../../shared/contracts.ts";

type HostNotificationSemantics = {
  tone: NonNullable<HostRequest["notifyType"]>;
  role: "alert" | "status";
  live: "assertive" | "polite";
};

const HOST_NOTIFICATION_SEMANTICS: Readonly<Record<HostNotificationSemantics["tone"], HostNotificationSemantics>> = {
  info: { tone: "info", role: "status", live: "polite" },
  warning: { tone: "warning", role: "status", live: "polite" },
  error: { tone: "error", role: "alert", live: "assertive" },
};

/** 将宿主通知级别映射为稳定的视觉 tone 与无障碍播报语义。 */
export function getHostNotificationSemantics(notifyType: HostRequest["notifyType"]): HostNotificationSemantics {
  return HOST_NOTIFICATION_SEMANTICS[notifyType ?? "info"];
}
