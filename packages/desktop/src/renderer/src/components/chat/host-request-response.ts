import { useCallback, useRef, useState } from "react";
import type { HostRequest, HostResponse } from "../../../../shared/contracts.ts";

/** 携带当前 worker 身份回复宿主 UI 请求，避免响应落到已替换的 worker。 */
export async function respondToHostRequest(
  projectId: string,
  threadId: string,
  request: HostRequest,
  response: HostResponse,
): Promise<void> {
  await window.desktop.sessions.respond(projectId, threadId, {
    ...response,
    workerInstanceId: request.workerInstanceId,
  });
}

/** Serializes renderer responses and exposes failures without producing unhandled rejections. */
export function useHostRequestResponder(projectId: string, threadId: string, request: HostRequest) {
  const inFlight = useRef(false);
  const [responding, setResponding] = useState(false);
  const [responseError, setResponseError] = useState<string>();
  const respond = useCallback(
    async (response: HostResponse) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setResponding(true);
      setResponseError(undefined);
      try {
        await respondToHostRequest(projectId, threadId, request, response);
      } catch (error) {
        inFlight.current = false;
        setResponding(false);
        setResponseError(error instanceof Error ? error.message : String(error));
      }
    },
    [projectId, request, threadId],
  );
  return { respond, responding, responseError };
}
