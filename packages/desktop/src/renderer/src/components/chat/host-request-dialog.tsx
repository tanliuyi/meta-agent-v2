import { Button } from "@renderer/shared/ui/button";
import { Dialog } from "@renderer/shared/ui/dialog";
import { DialogContent } from "@renderer/shared/ui/dialog-content";
import { DialogDescription } from "@renderer/shared/ui/dialog-description";
import { DialogFooter } from "@renderer/shared/ui/dialog-footer";
import { DialogTitle } from "@renderer/shared/ui/dialog-title";
import { useState } from "react";
import type { HostRequest } from "../../../../shared/contracts.ts";
import { HostRequestField } from "./host-request-field.tsx";
import { respondToHostRequest } from "./host-request-response.ts";

interface HostRequestDialogProps {
  request: HostRequest;
  projectId: string;
  threadId: string;
}

/** 渲染扩展发出的阻塞式请求，并维护该请求独立的输入值。 */
export function HostRequestDialog({ request, projectId, threadId }: HostRequestDialogProps) {
  const [value, setValue] = useState(() => request.initialValue ?? "");

  return (
    <Dialog open>
      <DialogContent
        className="gap-3 sm:max-w-lg"
        closeButtonClassName="hidden"
        onEscapeKeyDown={(event) => event.preventDefault()}
      >
        <div className="flex min-w-0 items-baseline gap-1 text-xs font-medium text-muted-foreground">
          {request.toolCallId ? (
            <>
              <span className="shrink-0">工具</span>
              <span className="min-w-0 truncate font-mono" title={request.toolCallId}>
                {request.toolCallId}
              </span>
            </>
          ) : (
            "扩展请求"
          )}
        </div>
        <DialogTitle>{request.title}</DialogTitle>
        {request.message ? <DialogDescription>{request.message}</DialogDescription> : null}
        <HostRequestField request={request} value={value} onChange={setValue} />
        <DialogFooter variant="actions">
          <Button
            variant="ghost"
            onClick={() =>
              void respondToHostRequest(projectId, threadId, request, { requestId: request.id, dismissed: true })
            }
          >
            取消
          </Button>
          {request.type === "confirm" ? (
            <>
              <Button
                variant="outline"
                onClick={() =>
                  void respondToHostRequest(projectId, threadId, request, { requestId: request.id, confirmed: false })
                }
              >
                拒绝
              </Button>
              <Button
                onClick={() =>
                  void respondToHostRequest(projectId, threadId, request, { requestId: request.id, confirmed: true })
                }
              >
                允许
              </Button>
            </>
          ) : (
            <Button
              disabled={request.type === "select" && !value}
              onClick={() => void respondToHostRequest(projectId, threadId, request, { requestId: request.id, value })}
            >
              继续
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
