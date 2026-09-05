import { Button } from "@renderer/shared/ui/button";
import { useState } from "react";
import type { HostRequest } from "../../../../shared/contracts.ts";
import { QuestionnaireRequest } from "./composer/questionnaire-request.tsx";
import { HostRequestField } from "./host-request-field.tsx";
import { useHostRequestResponder } from "./host-request-response.ts";

interface HostRequestDialogProps {
  request: HostRequest;
  projectId: string;
  threadId: string;
}

/** 渲染扩展发出的阻塞式请求，并维护该请求独立的输入值。 */
export function HostRequestDialog(props: HostRequestDialogProps) {
  if (props.request.type === "questionnaire") {
    return <QuestionnaireRequest request={props.request} projectId={props.projectId} threadId={props.threadId} />;
  }
  return <StandardHostRequest {...props} request={props.request} />;
}

type StandardHostRequestProps = HostRequestDialogProps;

function StandardHostRequest({ request, projectId, threadId }: StandardHostRequestProps) {
  const [value, setValue] = useState(() => (request.type === "editor" ? (request.message ?? "") : ""));
  const { respond, responding, responseError } = useHostRequestResponder(projectId, threadId, request);

  return (
    <section
      className="composer-surface flex w-full flex-col gap-2 rounded-(--composer-radius) border border-border/60 bg-(--composer-background) p-3 shadow-(--elevation-composer)"
      aria-label="扩展询问"
    >
      <div className="flex min-w-0 items-baseline gap-1 text-[11px] font-medium text-muted-foreground">
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
      <h2 className="whitespace-pre-wrap break-words text-sm font-semibold">{request.title}</h2>
      {request.message ? (
        <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">{request.message}</p>
      ) : null}
      <HostRequestField request={request} value={value} onChange={setValue} />
      <div className="flex justify-end gap-2 pt-0">
        <Button
          autoFocus={request.type === "confirm"}
          disabled={responding}
          variant="ghost"
          onClick={() => void respond({ requestId: request.id, dismissed: true })}
        >
          取消
        </Button>
        {request.type === "confirm" ? (
          <>
            <Button
              disabled={responding}
              variant="outline"
              onClick={() => void respond({ requestId: request.id, confirmed: false })}
            >
              拒绝
            </Button>
            <Button disabled={responding} onClick={() => void respond({ requestId: request.id, confirmed: true })}>
              允许
            </Button>
          </>
        ) : (
          <Button disabled={responding || !value.trim()} onClick={() => void respond({ requestId: request.id, value })}>
            下一项
          </Button>
        )}
      </div>
      {responseError ? (
        <p className="text-xs text-destructive" role="alert">
          {responseError}
        </p>
      ) : null}
    </section>
  );
}
