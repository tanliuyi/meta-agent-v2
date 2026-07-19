import { Button } from "@renderer/shared/ui/button";
import { Dialog } from "@renderer/shared/ui/dialog";
import { DialogContent } from "@renderer/shared/ui/dialog-content";
import { DialogDescription } from "@renderer/shared/ui/dialog-description";
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
  const [value, setValue] = useState(() => (request.type === "editor" ? (request.message ?? "") : ""));

  return (
    <Dialog open>
      <DialogContent
        className="gap-3 sm:max-w-lg"
        closeButtonClassName="hidden"
        onEscapeKeyDown={(event) => event.preventDefault()}
      >
        <p className="text-xs font-medium text-muted-foreground uppercase">
          {request.toolCallId ? `工具 ${request.toolCallId}` : "Pi 扩展请求"}
        </p>
        <DialogTitle>{request.title}</DialogTitle>
        {request.message ? <DialogDescription>{request.message}</DialogDescription> : null}
        <HostRequestField request={request} value={value} onChange={setValue} />
        <div className="mt-3 flex justify-end gap-2">
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
        </div>
      </DialogContent>
    </Dialog>
  );
}
