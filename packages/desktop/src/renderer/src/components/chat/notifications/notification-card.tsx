import type { ReactNode } from "react";
import type { PiNoticeMessage } from "../../../../../shared/contracts.ts";
import { getHostNotificationSemantics } from "../host-notification-model.ts";

export interface NotificationCardProps {
  notice: PiNoticeMessage;
  title: string;
  icon: ReactNode;
  tone?: "info" | "warning" | "error";
  children?: ReactNode;
}

export function NotificationCard({ notice, title, icon, tone, children }: NotificationCardProps) {
  const semantics = getHostNotificationSemantics(tone ?? notice.notificationType);
  return (
    <section
      className="builtin-notification-card"
      data-tone={semantics.tone}
      role={semantics.role}
      aria-live={semantics.live}
      aria-atomic="true"
    >
      <header className="builtin-notification-header">
        <span className="builtin-notification-icon" aria-hidden="true">
          {icon}
        </span>
        <strong>{title}</strong>
      </header>
      {children ?? <p className="builtin-notification-message">{notice.title}</p>}
    </section>
  );
}
