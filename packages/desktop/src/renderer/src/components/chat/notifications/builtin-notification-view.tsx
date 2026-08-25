import type { ComponentType } from "react";
import type { PiNoticeMessage } from "../../../../../shared/contracts.ts";
import { CheckpointNotification } from "./pi-rewind/checkpoint-notification.tsx";

type NotificationRenderer = ComponentType<{ notice: PiNoticeMessage }>;

const REGISTERED_NOTIFICATION_RENDERERS: Readonly<Record<string, NotificationRenderer>> = {
  "pi-rewind.checkpoint": CheckpointNotification,
};

export function getRegisteredNotificationRenderer(notice: PiNoticeMessage): NotificationRenderer | undefined {
  const customType =
    notice.noticeType === "notification"
      ? notice.extensionNotification?.customType
      : notice.content.type === "custom"
        ? notice.content.customType
        : undefined;
  return customType === undefined ? undefined : REGISTERED_NOTIFICATION_RENDERERS[customType];
}
