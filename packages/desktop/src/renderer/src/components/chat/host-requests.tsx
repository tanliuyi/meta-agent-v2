import type { HostRequest } from "../../../../shared/contracts.ts";
import { HostRequestDialog } from "./host-request-dialog.tsx";

interface HostRequestsProps {
  request: HostRequest;
  projectId: string;
  threadId: string;
}

/** 渲染当前 session 的阻塞式扩展 UI 请求。 */
export function HostRequests({ request, projectId, threadId }: HostRequestsProps) {
  return <HostRequestDialog key={request.id} request={request} projectId={projectId} threadId={threadId} />;
}
