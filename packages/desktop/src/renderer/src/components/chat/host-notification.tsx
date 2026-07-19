import { Button } from "@renderer/shared/ui/button";
import type { HostRequest } from "../../../../shared/contracts.ts";
import { getHostNotificationSemantics } from "./host-notification-model.ts";
import { respondToHostRequest } from "./host-request-response.ts";

interface HostNotificationProps {
  request: HostRequest;
  projectId: string;
  threadId: string;
}

/** 渲染扩展发出的非阻塞通知，并按严重级别播报通知文本。 */
export function HostNotification({ request, projectId, threadId }: HostNotificationProps) {
  const semantics = getHostNotificationSemantics(request.notifyType);

  return (
    <div className={`notice notice-${semantics.tone}`} data-tone={semantics.tone}>
      <span role={semantics.role} aria-live={semantics.live} aria-atomic="true">
        {request.title}
      </span>
      <Button
        variant="ghost"
        size="sm"
        onClick={() =>
          void respondToHostRequest(projectId, threadId, request, { requestId: request.id, dismissed: true })
        }
      >
        关闭
      </Button>
    </div>
  );
}
