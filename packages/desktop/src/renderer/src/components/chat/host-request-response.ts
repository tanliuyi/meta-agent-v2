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
